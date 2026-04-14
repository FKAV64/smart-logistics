import redis
import json
import time
from datetime import datetime, timezone, timedelta

r = redis.Redis(host='localhost', port=6379, db=0)

now = datetime.now(timezone.utc)
plenty_of_time = (now + timedelta(hours=4)).isoformat()
urgent_time = (now + timedelta(minutes=15)).isoformat()
now_iso = now.isoformat()

def create_payload(route_id, status, weather, traffic, incident, stops):
    return {
        "event_type": "TRAFFIC_ALERT",
        "route_id": route_id,
        "courier_id": f"DR-{route_id}",
        "shift_end": "18:00:00",
        "courier_status": status,
        "vehicle_type": "van",
        "current_location": {"lat": 39.620, "lon": 37.051, "timestamp": now_iso},
        "environment_horizon": {
            "weather_condition": weather,
            "road_surface_condition": "wet" if weather == "rain" else ("icy" if weather == "snow" else "dry"),
            "traffic_severity": traffic,
            "time_bucket": "midday",
            "incident_reported": incident
        },
        "unvisited_stops": stops
    }

# --- SCENARIO 1: CONTINUE ---
# Clear weather, low traffic. Sequence is fine.
stops_standard = [
    {"stop_id": "STP-A", "lat": 39.625, "lon": 37.055, "window_start": now_iso, "window_end": plenty_of_time, "current_order": 1, "road_type": "urban"},
    {"stop_id": "STP-B", "lat": 39.630, "lon": 37.060, "window_start": now_iso, "window_end": plenty_of_time, "current_order": 2, "road_type": "urban"}
]
print("\n🟢 SCENARIO 1: Perfect Conditions")
r.publish("traffic_alerts_channel", json.dumps(create_payload("TRK-1-CONT", "EN_ROUTE", "clear", "low", False, stops_standard)))
time.sleep(1)

# --- SCENARIO 2: DELAY_DEPARTURE ---
# Extreme danger, but the driver is still parked at the depot (AT_STOP).
print("\n🟡 SCENARIO 2: Blizzard, Driver at Depot")
r.publish("traffic_alerts_channel", json.dumps(create_payload("TRK-2-HOLD", "AT_STOP", "snow", "high", True, stops_standard)))
time.sleep(1)

# --- SCENARIO 3: REQUEST_ALTERNATE_PATH ---
# Extreme danger, but the driver is already driving on the highway (EN_ROUTE).
print("\n🟠 SCENARIO 3: Blizzard, Driver already on the road")
r.publish("traffic_alerts_channel", json.dumps(create_payload("TRK-3-ALT", "EN_ROUTE", "snow", "high", True, stops_standard)))
time.sleep(1)

# --- SCENARIO 4: RE-ROUTE ---
# Stop B is far away but closes in 15 minutes! Stop A is close but closes in 4 hours. 
# The engine must swap them to save the time window penalty.
stops_urgent = [
    {"stop_id": "STP-A", "lat": 39.625, "lon": 37.055, "window_start": now_iso, "window_end": plenty_of_time, "current_order": 1, "road_type": "urban"},
    {"stop_id": "STP-B", "lat": 39.640, "lon": 37.080, "window_start": now_iso, "window_end": urgent_time, "current_order": 2, "road_type": "urban"}
]
print("\n🔴 SCENARIO 4: Time Window Emergency")
r.publish("traffic_alerts_channel", json.dumps(create_payload("TRK-4-REROUTE", "EN_ROUTE", "clear", "low", False, stops_urgent)))