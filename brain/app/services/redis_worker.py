import os
import json
import redis
import traceback
from datetime import datetime
 
# Import the core Brain components
from app.services.ml_engine import MLEngine
from app.services.routing import RouteOptimizer
from app.models.schemas import TrafficAlertPayload
from pydantic import ValidationError
from app.services.map_seeder import seed_map_if_empty
from app.services.map_engine import MapEngine
 
 
class RedisWorker:
    def __init__(self, host='redis', port=6379):
        """Initializes the connection to Redis and loads the AI models into memory."""
        print("Initializing Gatekeeper and connecting to Redis...")
        self.redis = redis.Redis(host=host, port=port, decode_responses=True)
        self.pubsub = self.redis.pubsub()
 
        self.listen_channel  = 'traffic_alerts_channel'
        self.publish_channel = 'route_optimizations_channel'
 
        print("Loading ML Pipeline and Routing Engine...")
        
        # Ensure database map is populated
        seed_map_if_empty()
        
        self.map_engine      = MapEngine()
        self.ml_engine       = MLEngine()
        self.route_optimizer = RouteOptimizer(self.map_engine)
        print("✅ Python Brain Worker is Ready and Armed.")
 
    def _acquire_lock(self, manifest_id: str) -> bool:
        """
        Atomic Lock (Debouncer).
        Ensures if Node.js sends 5 quick webhooks for the same truck,
        we only optimize it once. Lock expires in 10 seconds automatically.
        """
        lock_key = f"lock:optimize:{manifest_id}"
        return self.redis.set(lock_key, "locked", nx=True, ex=10)
 
    def process_message(self, message_data: dict):
        # Ignore heartbeat pings from Node.js
        if message_data.get('type') == 'PING':
            return
 
        try:
            # Enforce strict Schema Validation
            validated_payload = TrafficAlertPayload(**message_data)
        except ValidationError as e:
            print(f"❌ Schema Validation Failed: {e}")
            return

        manifest_id = message_data.get('manifest_id')
        if not manifest_id or not self._acquire_lock(manifest_id):
            return
 
        try:
            unvisited_stops  = message_data.get('unvisited_stops', [])
            courier_status   = message_data.get('courier_status', 'EN_ROUTE')
            current_time_iso = message_data.get(
                'current_time_iso',
                datetime.utcnow().isoformat() + "Z"
            )
 
            # Hand the full payload to the ML engine along with the geographic graph
            scored_matrix = self.ml_engine.predict_segment_delays(message_data, self.map_engine.get_graph())
            if not scored_matrix.edges:
                return
 
            # Run the hill-climbing route optimizer
            res = self.route_optimizer.optimize_route(
                unvisited_stops, scored_matrix, current_time_iso
            )
 
            # Determine the action type and severity
            action   = "CONTINUE"
            reason   = "Current sequence is mathematically optimal."
            severity = "low"
 
            if res.get("health") == "FAILED":
                late_time = res.get('minutes_late', 0)
                action   = "NOTIFY_DISPATCH_LATE"
                reason   = f"Mathematical impossibility: Route will miss delivery windows by at least {late_time} minutes. Alerting Dispatch."
                severity = "CRITICAL"
            elif res["is_reordered"]:
                action   = "RE-ROUTE"
                reason   = f"Re-ordering stops saves {res['time_saved']} minutes and protects time windows."
                severity = "high"
            elif message_data.get("event_type") == "TRAFFIC_ALERT" or res["max_delay"] > 15:
                severity = "medium"
                if courier_status == "AT_STOP":
                    action = "DELAY_DEPARTURE"
                    reason = "Heavy localized sequence traffic. Mathematical guidance: Hold at current stop for 15 minutes to avoid idling fuel burn."
                else:
                    action = "REQUEST_ALTERNATE_PATH"
                    reason = "Sequence remains optimal but physical path blocked. Requesting Node.js to fetch alternate TomTom vector."
 
            # Construct the response payload for Node.js
            response_payload = {
                "manifest_id": manifest_id,
                "status":   "OPTIMIZED",
                "ai_recommendation": {
                    "action_type": action,
                    "severity":    severity,
                    "reason":      reason,
                    "new_sequence": res["new_sequence_ids"],
                    "impact": {
                        "time_saved_minutes": res["time_saved"],
                        "route_health":       res["health"]
                    },
                    "route_geojson": res.get("route_geojson")
                }
            }
 
            self.redis.publish(self.publish_channel, json.dumps(response_payload))
            print(f"✅ Published {action} for {manifest_id}")
 
        except Exception as e:
            print(f"❌ Error processing manifest {manifest_id}: {str(e)}")
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