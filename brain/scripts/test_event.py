import redis
import json
import time
from datetime import datetime, timedelta, timezone

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
    # Fixed DeprecationWarning by using timezone.utc
    now = datetime.now(timezone.utc)
    
    payload = {
        "event_type": "TRAFFIC_ALERT",
        "route_id": "RT-WINTER-TEST",
        "courier_id": "DRV-884",
        "shift_end": "18:00:00",
        "courier_status": "EN_ROUTE",
        "vehicle_type": "truck",
        "current_time_iso": now.isoformat().replace("+00:00", "Z"),
        "current_location": {
            "lat": 39.7740,
            "lon": 37.0016,
            "timestamp": now.isoformat().replace("+00:00", "Z")
        },
        "environment_horizon": {
            "weather_condition": "snow",
            "traffic_level": "congested",
            "time_bucket": "morning",
            "temperature_c": 2.5,
            "incident_reported": False
        },
        "unvisited_stops": [
            {
                "stop_id": "STP-A",
                "lat": 39.7743, # Mountain coordinates
                "lon": 37.0019,
                "road_type": "mountain",
                # Window closes in 60 minutes (Plenty of time)
                "window_start": (now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
                "window_end": (now + timedelta(minutes=60)).isoformat().replace("+00:00", "Z"),
                "planned_service_min": 5.0
            },
            {
                "stop_id": "STP-B",
                "lat": 39.8021, # Highway coordinates
                "lon": 37.1554,
                "road_type": "highway",
                # URGENT: Window closes in exactly 15 minutes!
                "window_start": now.isoformat().replace("+00:00", "Z"),
                "window_end": (now + timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
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