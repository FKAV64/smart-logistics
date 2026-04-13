import redis
import json
import time
from datetime import datetime, timezone, timedelta

r = redis.Redis(host='localhost', port=6379, db=0)
now = datetime.now(timezone.utc).isoformat()
later = (datetime.now(timezone.utc) + timedelta(hours=4)).isoformat()

def create_payload(event_type):
    return {
        "event_type": event_type,
        "route_id": "ROUTE_8849",
        "courier_id": "COURIER_12",
        "shift_end": "18:00:00",
        "weather_condition": "RAIN",     # Real data mapping to schemas.py
        "traffic_severity": "HIGH",      # Real data mapping to schemas.py
        "historical_time_mins": 35,
        "current_location": {"lat": 38.501, "lon": 43.412, "timestamp": now},
        "unvisited_stops": [
            {"stop_id": "STOP_A", "lat": 38.510, "lon": 43.420, "window_start": now, "window_end": later, "current_order": 1},
            {"stop_id": "STOP_B", "lat": 38.490, "lon": 43.400, "window_start": now, "window_end": later, "current_order": 2},
            {"stop_id": "STOP_C", "lat": 38.520, "lon": 43.430, "window_start": now, "window_end": later, "current_order": 3}
        ]
    }

print("Firing Event 1: The PING (Should be ignored by math engine)")
r.publish("traffic_alerts_channel", json.dumps(create_payload("PING")))
time.sleep(1)

print("\nFiring Event 2: The TRAFFIC ALERT (Should trigger full optimization)")
r.publish("traffic_alerts_channel", json.dumps(create_payload("TRAFFIC_ALERT")))
time.sleep(1)

print("\nFiring Event 3: Duplicate TRAFFIC ALERT (Should be blocked by Debouncer)")
r.publish("traffic_alerts_channel", json.dumps(create_payload("TRAFFIC_ALERT")))