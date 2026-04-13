import redis
import json
from app.services.ml_engine import predict_route_delay
from app.services.routing import optimize_route

redis_client = redis.Redis(host='localhost', port=6379, db=0, decode_responses=True)

def process_traffic_event(payload_json: str):
    """
    Processes the event JSON payload from Node.js via Redis. 
    Implements the Debouncer pattern and Event Filtering.
    """
    try:
        # 1. Parse the JSON package
        payload = json.loads(payload_json)
        route_id = payload.get("route_id")
        event_type = payload.get("event_type")
        
        if not route_id or not event_type:
            print("❌ Invalid payload: Missing route_id or event_type")
            return

        # 2. EVENT FILTERING (The Gatekeeper)
        if event_type == "PING":
            print(f"📡 [PING] Heartbeat received for {route_id}. System healthy. Skipping math.")
            return
            
        if event_type not in ["TRAFFIC_ALERT", "ROUTINE_CHECK"]:
            print(f"❓ Ignored unknown event type: {event_type}")
            return

        # 3. THE DEBOUNCER (Atomic Lock)
        lock_key = f"lock:event:{route_id}"
        acquired_lock = redis_client.set(lock_key, "locked", nx=True, ex=60)
        
        if not acquired_lock:
            print(f"🛑 Event Storm Blocked! Route {route_id} is already optimizing.")
            return

        # 4. Lock Acquired! Proceed to heavy math.
        print(f"✅ Lock acquired for {route_id} ({event_type}). Starting ML Prediction...")
        print(f"📦 Extracting state: Shift ends at {payload.get('shift_end')}")
        
        # A. Run the ML Engine using REAL data from the payload
        delay_minutes = predict_route_delay(
            historical_time=payload.get("historical_time_mins", 20),
            weather_condition=payload.get("weather_condition", "CLEAR"),
            traffic_severity=payload.get("traffic_severity", "LOW")
        )
        
        # B. Run the 2-opt Routing Engine
        current_location = payload.get("current_location", {})
        unvisited_stops = payload.get("unvisited_stops", [])
        action_plan = optimize_route(current_location, unvisited_stops)
        
        # C. Format the final output
        final_response = {
            "route_id": route_id,
            "status": "OPTIMIZED",
            "ai_recommendation": action_plan
        }
        
        print(f"🚀 FINAL OUTPUT READY FOR NODE.JS:\n{json.dumps(final_response, indent=2)}")
        
    except json.JSONDecodeError:
        print("❌ Failed to parse Redis message as JSON.")
    except Exception as e:
        print(f"❌ Redis Worker Error: {e}")

def start_redis_listener():
    pubsub = redis_client.pubsub()
    pubsub.subscribe("traffic_alerts_channel")
    
    print("🎧 Python Brain is now listening to Redis channel: 'traffic_alerts_channel'")
    
    for message in pubsub.listen():
        if message["type"] == "message":
            print("\n🔔 New Event Detected in Redis!")
            # Call the newly renamed function
            process_traffic_event(message["data"])