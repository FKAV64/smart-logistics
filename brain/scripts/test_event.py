import redis
import json
import time
from datetime import datetime, timezone, timedelta

r = redis.Redis(host='localhost', port=6379, db=0)

now = datetime.now(timezone.utc)

# STAGGERED TIME WINDOWS
# Stop A has plenty of time (4 hours from now)
window_end_a = (now + timedelta(hours=4)).isoformat()
# Stop B is due in 1 hour
window_end_b = (now + timedelta(hours=1)).isoformat()
# Stop C is URGENT (due in 10 minutes!)
window_end_c = (now + timedelta(minutes=10)).isoformat()

def create_payload(event_type):
    return {
        "event_type": event_type,
        "route_id": "ROUTE_8849",
        "courier_id": "COURIER_12",
        "shift_end": "18:00:00",
        "weather_condition": "RAIN",
        "traffic_severity": "HIGH",
        "historical_time_mins": 35,
        "current_location": {"lat": 38.501, "lon": 43.412, "timestamp": now.isoformat()},
        "unvisited_stops": [
            {"stop_id": "STOP_A", "lat": 38.505, "lon": 43.415, "window_start": now.isoformat(), "window_end": window_end_a, "current_order": 1},
            {"stop_id": "STOP_B", "lat": 38.490, "lon": 43.400, "window_start": now.isoformat(), "window_end": window_end_b, "current_order": 2},
            {"stop_id": "STOP_C", "lat": 38.520, "lon": 43.430, "window_start": now.isoformat(), "window_end": window_end_c, "current_order": 3}
        ]
    }

# Fire just one Traffic Alert to test the new logic
print("Firing Event: TRAFFIC ALERT (Testing Time Window Constraints)")
r.publish("traffic_alerts_channel", json.dumps(create_payload("TRAFFIC_ALERT")))