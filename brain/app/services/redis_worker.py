import redis
import json

# Connect to Redis (We will point this to our Docker container later)
# decode_responses=True automatically converts byte data to normal Python strings
redis_client = redis.Redis(host='localhost', port=6379, db=0, decode_responses=True)

def process_traffic_webhook(payload_json: str):
    """
    Processes the webhook JSON payload from Node.js. 
    Implements the Debouncer pattern to prevent Webhook Storms.
    """
    try:
        # 1. Parse the JSON package
        payload = json.loads(payload_json)
        route_id = payload.get("route_id")
        
        if not route_id:
            print("❌ Invalid payload: Missing route_id")
            return

        # The unique lock name for this specific truck
        lock_key = f"lock:webhook:{route_id}"
        
        # 2. THE DEBOUNCER (Atomic Lock)
        # nx=True: Only set if it doesn't exist.
        # ex=60: Expire and unlock after 60 seconds.
        acquired_lock = redis_client.set(lock_key, "locked", nx=True, ex=60)
        
        if not acquired_lock:
            # If acquired_lock is False, it means the key already exists!
            print(f"🛑 Webhook Storm Blocked! Route {route_id} is already optimizing.")
            return

        # 3. Lock Acquired! Proceed to heavy math.
        print(f"✅ Lock acquired for Route {route_id}. Starting ML Prediction...")
        
        # (TODO: Call ml_engine.py and routing.py here later)
        print(f"📦 Extracting state: Shift ends at {payload.get('shift_end')}")
        
    except json.JSONDecodeError:
        print("❌ Failed to parse Redis message as JSON.")
    except Exception as e:
        print(f"❌ Redis Worker Error: {e}")

def start_redis_listener():
    """
    Continuously listens to a Redis Pub/Sub channel for new webhooks.
    """
    pubsub = redis_client.pubsub()
    
    # Subscribe to the exact channel Node.js will broadcast on
    pubsub.subscribe("traffic_alerts_channel")
    
    print("🎧 Python Brain is now listening to Redis channel: 'traffic_alerts_channel'")
    
    # This loop runs endlessly in the background
    for message in pubsub.listen():
        # Type 'message' means actual data (ignoring connect/disconnect pings)
        if message["type"] == "message":
            print("\n🔔 New Webhook Detected in Redis!")
            process_traffic_webhook(message["data"])