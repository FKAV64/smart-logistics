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

    def process_message(self, message_data: dict):
        """The main orchestration pipeline for incoming Node.js payloads."""
        
        # 1. Filter out PING events to save compute
        if message_data.get('type') == 'PING':
            return
        
        route_id = message_data.get('route_id')
        if not route_id:
            return

        # 2. Check Atomic Lock
        if not self._acquire_lock(route_id):
            print(f"⚠️  Skipping duplicate request for Route {route_id} (Debounced)")
            return

        print(f"🚀 Optimizing Route: {route_id}...")
        
        try:
            unvisited_stops = message_data.get('unvisited_stops', [])
            # Fallback to current UTC time if Node.js forgets to send it
            current_time_iso = message_data.get('current_time_iso', datetime.utcnow().isoformat() + "Z")

            # STEP 1: AI Segment Prediction (MODIFIED: Pass full message_data for pipeline features)
            scored_matrix = self.ml_engine.predict_segment_delays(message_data)
            
            if scored_matrix.empty:
                print(f"✅ Route {route_id} has < 2 stops. No optimization needed.")
                return

            # STEP 2: Algorithmic Reordering (Time Windows + EV Cost)
            result = self.route_optimizer.optimize_route(
                unvisited_stops=unvisited_stops,
                scored_matrix=scored_matrix,
                current_time_iso=current_time_iso
            )

            # STEP 3: Package result and fire it back to Node.js
            response_payload = {
                "route_id": route_id,
                "courier_id": message_data.get("courier_id"),
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "optimized_stops": result["optimized_stops"],
                "dispatcher_insight": result["dispatcher_insight"]
            }
            
            self.redis.publish(self.publish_channel, json.dumps(response_payload))
            print(f"✅ Successfully published optimized route back to Node.js for {route_id}")

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