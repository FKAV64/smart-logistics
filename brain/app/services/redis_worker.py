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
        
        self.listen_channel = 'traffic_alerts_channel'
        self.publish_channel = 'route_optimizations_channel'
        
        print("Loading ML Pipeline and Routing Engine...")
        self.ml_engine = MLEngine(redis_client=self.redis)
        self.route_optimizer = RouteOptimizer(base_speed_kmh=40.0)
        print("✅ Python Brain Worker is Ready and Armed.")

    def _acquire_lock(self, route_id: str) -> bool:
        """
        Atomic Lock (Debouncer). 
        Ensures if Node.js sends 5 quick webhooks for the same truck, we only optimize it once.
        """
        lock_key = f"lock:optimize:{route_id}"
        # SETNX sets the key only if it does not exist. Expires in 10 seconds.
        return self.redis.set(lock_key, "locked", nx=True, ex=10)

    # brain/app/services/redis_worker.py

    def process_message(self, message_data: dict):
        if message_data.get('type') == 'PING': return # [cite: 14]
        
        route_id = message_data.get('route_id')
        if not route_id or not self._acquire_lock(route_id): return # [cite: 15]

        try:
            unvisited_stops = message_data.get('unvisited_stops', [])
            courier_status = message_data.get('courier_status', 'EN_ROUTE') # [cite: 45]
            current_time_iso = message_data.get('current_time_iso', datetime.utcnow().isoformat() + "Z")

            scored_matrix = self.ml_engine.predict_segment_delays(message_data)
            if scored_matrix.empty: return

            # Get optimization results
            res = self.route_optimizer.optimize_route(unvisited_stops, scored_matrix, current_time_iso)

            # Logic to determine action_type [cite: 27-34]
            action = "CONTINUE"
            reason = "Current sequence is mathematically optimal."
            severity = "low"

            if res["is_reordered"]: # [cite: 33]
                action = "RE-ROUTE"
                reason = f"Re-ordering stops saves {res['time_saved']} minutes and protects time windows."
                severity = "high"
            elif res["max_delay"] > 15:
                severity = "medium"
                if courier_status == "AT_STOP": # [cite: 29]
                    action = "DELAY_DEPARTURE"
                    reason = f"Current order optimal, but heavy traffic imminent. Suggest waiting 15 mins."
                else: # [cite: 31]
                    action = "REQUEST_ALTERNATE_PATH"
                    reason = f"{res['max_delay']}m delay predicted on current path. Requesting physical detour."

            # Construct final structure exactly as per Documentation [cite: 89-102]
            response_payload = {
                "route_id": route_id,
                "status": "OPTIMIZED", # [cite: 91]
                "ai_recommendation": {
                    "action_type": action, # [cite: 93]
                    "severity": severity, # [cite: 94]
                    "reason": reason, # [cite: 95]
                    "new_sequence": res["new_sequence_ids"], # [cite: 96]
                    "impact": { # [cite: 97]
                        "time_saved_minutes": res["time_saved"], # [cite: 98]
                        "route_health": res["health"] # [cite: 99]
                    }
                }
            }
            
            self.redis.publish(self.publish_channel, json.dumps(response_payload))
            print(f"✅ Published {action} for {route_id}")

        except Exception as e:
            print(f"❌ Error: {str(e)}")
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
    """Helper function to allow main.py to spawn the worker as a background task."""
    print("Background Task: Spinning up Redis Gatekeeper...")
    try:
        # Use localhost for local dev. If inside Docker, this might need to be 'redis'
        worker = RedisWorker(host='localhost', port=6379) 
        worker.listen()
    except Exception as e:
        print(f"❌ Failed to start background Redis worker: {e}")

if __name__ == "__main__":
    # Local execution entry point
    worker = RedisWorker(host='localhost', port=6379)
    worker.listen()