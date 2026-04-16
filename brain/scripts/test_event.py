import redis
import json
import time
from datetime import datetime, timedelta

def run_test():
    print("🔌 Connecting to Redis...")
    # Use localhost if running outside Docker, or 'redis' if running inside the network
    try:
        r = redis.Redis(host='localhost', port=6379, decode_responses=True)
        r.ping()
    except redis.ConnectionError:
        print("❌ Cannot connect to Redis on localhost:6379. Is Docker running?")
        return

    # ==========================================
    # 1. SEED THE WORLD STATE (Mocking Node.js)
    # ==========================================
    print("🌍 Seeding Live Weather and Traffic into Redis...")
    
    mountain_state = {
        "weather_condition": "snow", 
        "traffic_level": "congested", 
        "time_bucket": "midday"
    }
    highway_state = {
        "weather_condition": "clear", 
        "traffic_level": "low", 
        "time_bucket": "midday"
    }
    
    r.set("env_state:mountain", json.dumps(mountain_state))
    r.set("env_state:highway", json.dumps(highway_state))

    # ==========================================
    # 2. BUILD THE COURIER PAYLOAD
    # ==========================================
    now = datetime.utcnow()
    
    payload = {
        "type": "COURIER_EVENT",
        "route_id": "RT-WINTER-TEST",
        "courier_id": "DRV-884",
        "current_time_iso": now.isoformat() + "Z",
        "vehicle_type": "truck",
        "environment_horizon": {
            "temperature_c": 2.5,
            "incident_reported": False
        },
        "unvisited_stops": [
            {
                "stop_id": "STP-A",
                "lat": 39.7743, # Mountain coordinates
                "lon": 37.0019,
                "road_type": "mountain",
                # Window closes in 60 minutes
                "window_start": (now + timedelta(minutes=10)).isoformat() + "Z",
                "window_end": (now + timedelta(minutes=60)).isoformat() + "Z",
                "planned_service_min": 5.0
            },
            {
                "stop_id": "STP-B",
                "lat": 39.8021, # Highway coordinates
                "lon": 37.1554,
                "road_type": "highway",
                # Window closes in 45 minutes (Tighter window!)
                "window_start": (now + timedelta(minutes=15)).isoformat() + "Z",
                "window_end": (now + timedelta(minutes=45)).isoformat() + "Z",
                "planned_service_min": 5.0
            }
        ]
    }

    # ==========================================
    # 3. SET UP THE LISTENER AND FIRE
    # ==========================================
    pubsub = r.pubsub()
    pubsub.subscribe('route_optimizations_channel')
    
    print("🚀 Firing payload to traffic_alerts_channel...")
    r.publish('traffic_alerts_channel', json.dumps(payload))
    
    print("🎧 Listening for AI Brain response...\n")
    
    # Wait for the response
    timeout = time.time() + 5.0 # 5 second timeout
    while time.time() < timeout:
        message = pubsub.get_message(ignore_subscribe_messages=True)
        if message and message['type'] == 'message':
            print("==========================================")
            print("🧠 AI OPTIMIZER RESPONSE RECEIVED:")
            print("==========================================")
            response_data = json.loads(message['data'])
            print(json.dumps(response_data, indent=2))
            return
        time.sleep(0.1)
        
    print("❌ Timed out waiting for response. Is redis_worker.py running?")

if __name__ == "__main__":
    run_test()