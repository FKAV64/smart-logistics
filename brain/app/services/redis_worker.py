import os
import json
import redis
import traceback
from datetime import datetime
 
# Import the core Brain components
from app.services.ml_engine import MLEngine
from app.services.routing import RouteOptimizer
 
 
class RedisWorker:
    def __init__(self, host='redis', port=6379):
        """Initializes the connection to Redis and loads the AI models into memory."""
        print("Initializing Gatekeeper and connecting to Redis...")
        self.redis = redis.Redis(host=host, port=port, decode_responses=True)
        self.pubsub = self.redis.pubsub()
 
        self.listen_channel  = 'traffic_alerts_channel'
        self.publish_channel = 'route_optimizations_channel'
 
        print("Loading ML Pipeline and Routing Engine...")
        self.ml_engine       = MLEngine(redis_client=self.redis)
        self.route_optimizer = RouteOptimizer()
        print("✅ Python Brain Worker is Ready and Armed.")
 
    def _acquire_lock(self, route_id: str) -> bool:
        """
        Atomic Lock (Debouncer).
        Ensures if Node.js sends 5 quick webhooks for the same truck,
        we only optimize it once. Lock expires in 10 seconds automatically.
        """
        lock_key = f"lock:optimize:{route_id}"
        return self.redis.set(lock_key, "locked", nx=True, ex=10)
 
    def process_message(self, message_data: dict):
        # Ignore heartbeat pings from Node.js
        if message_data.get('type') == 'PING':
            return
 
        route_id = message_data.get('route_id')
        if not route_id or not self._acquire_lock(route_id):
            return
 
        try:
            unvisited_stops  = message_data.get('unvisited_stops', [])
            courier_status   = message_data.get('courier_status', 'EN_ROUTE')
            current_time_iso = message_data.get(
                'current_time_iso',
                datetime.utcnow().isoformat() + "Z"
            )
 
            # Hand the full payload to the ML engine.
            # ml_engine.py knows how to unpack environment_horizon correctly.
            scored_matrix = self.ml_engine.predict_segment_delays(message_data)
            if scored_matrix.empty:
                return
 
            # Run the hill-climbing route optimizer
            res = self.route_optimizer.optimize_route(
                unvisited_stops, scored_matrix, current_time_iso
            )
 
            # Determine the action type and severity
            action   = "CONTINUE"
            reason   = "Current sequence is mathematically optimal."
            severity = "low"
 
            if res["is_reordered"]:
                action   = "RE-ROUTE"
                reason   = f"Re-ordering stops saves {res['time_saved']} minutes and protects time windows."
                severity = "high"
            elif res["max_delay"] > 15:
                severity = "medium"
                if courier_status == "AT_STOP":
                    action = "DELAY_DEPARTURE"
                    reason = "Current order optimal, but heavy traffic imminent. Suggest waiting 15 mins."
                else:
                    action = "REQUEST_ALTERNATE_PATH"
                    reason = f"{res['max_delay']}m delay predicted on current path. Requesting physical detour."
 
            # Construct the response payload for Node.js
            response_payload = {
                "route_id": route_id,
                "status":   "OPTIMIZED",
                "ai_recommendation": {
                    "action_type": action,
                    "severity":    severity,
                    "reason":      reason,
                    "new_sequence": res["new_sequence_ids"],
                    "impact": {
                        "time_saved_minutes": res["time_saved"],
                        "route_health":       res["health"]
                    }
                }
            }
 
            self.redis.publish(self.publish_channel, json.dumps(response_payload))
            print(f"✅ Published {action} for {route_id}")
 
        except Exception as e:
            print(f"❌ Error processing route {route_id}: {str(e)}")
            traceback.print_exc()
 
    def listen(self):
        """Blocking loop that listens indefinitely to the Pub/Sub channel."""
        self.pubsub.subscribe(self.listen_channel)
        print(f"🎧 Listening for events on '{self.listen_channel}'...")
 
        for message in self.pubsub.listen():
            if message['type'] == 'message':
                try:
                    data = json.loads(message['data'])
                    self.process_message(data)
                except json.JSONDecodeError:
                    print("❌ Received invalid JSON payload from Node.js.")
                except Exception as e:
                    print(f"❌ Worker critical exception: {str(e)}")
 
 
# --- Helper for main.py background tasking ---
 
def start_redis_listener():
    """
    Helper function spawned as a background daemon thread by main.py.
 
    FIX: Uses REDIS_HOST environment variable so the same code works in
    both local development (localhost) and Docker (service name 'redis').
 
    Set in your .env:
        REDIS_HOST=localhost   ← for local dev
        REDIS_HOST=redis       ← for Docker Compose
    """
    print("Background Task: Spinning up Redis Gatekeeper...")
    try:
        # --- FIX: Read host from environment, default to 'redis' for Docker ---
        redis_host = os.getenv('REDIS_HOST', 'redis')
        redis_port = int(os.getenv('REDIS_PORT', 6379))
        worker = RedisWorker(host=redis_host, port=redis_port)
        worker.listen()
    except Exception as e:
        print(f"❌ Failed to start background Redis worker: {e}")
 
 
if __name__ == "__main__":
    # Local execution entry point: python -m app.services.redis_worker
    redis_host = os.getenv('REDIS_HOST', 'localhost')
    redis_port = int(os.getenv('REDIS_PORT', 6379))
    worker = RedisWorker(host=redis_host, port=redis_port)
    worker.listen()