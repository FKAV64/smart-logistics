import redis
import json
import time
from datetime import datetime, timedelta, timezone

REDIS_HOST = 'localhost'
REDIS_PORT = 6379
TIMEOUT_SEC = 15.0

# ── helpers ────────────────────────────────────────────────────────────────────

def connect():
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    r.ping()
    return r

def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")

def seed_world_state(r):
    r.set("env_state:mountain", json.dumps({"weather_condition": "snow",  "traffic_level": "congested", "time_bucket": "midday"}))
    r.set("env_state:highway",  json.dumps({"weather_condition": "clear", "traffic_level": "low",       "time_bucket": "midday"}))
    r.set("env_state:urban",    json.dumps({"weather_condition": "rain",  "traffic_level": "high",      "time_bucket": "morning"}))

def fire_and_wait(r, label, payload):
    pubsub = r.pubsub()
    pubsub.subscribe('route_optimizations_channel')
    time.sleep(0.1)                           # let subscribe flush

    print(f"\n{'='*60}")
    print(f"  SCENARIO: {label}")
    print(f"  manifest_id : {payload['manifest_id']}")
    print(f"  event_type  : {payload['event_type']}")
    print(f"  courier_status: {payload['courier_status']}")
    print(f"{'='*60}")
    print("  Firing payload ...")

    r.publish('traffic_alerts_channel', json.dumps(payload))

    deadline = time.time() + TIMEOUT_SEC
    while time.time() < deadline:
        msg = pubsub.get_message(ignore_subscribe_messages=True)
        if msg and msg['type'] == 'message':
            data = json.loads(msg['data'])
            # only print the response that belongs to this manifest
            if data.get('manifest_id') == payload['manifest_id']:
                rec = data.get('ai_recommendation', {})
                print(f"\n  >>> ACTION  : {rec.get('action_type')}")
                print(f"  >>> SEVERITY: {rec.get('severity')}")
                print(f"  >>> REASON  : {rec.get('reason')}")
                print(f"\n  Full response:\n{json.dumps(data, indent=4)}")
                pubsub.unsubscribe()
                return
        time.sleep(0.1)

    print(f"  [TIMEOUT] No response after {TIMEOUT_SEC}s — is the brain worker running?")
    pubsub.unsubscribe()


# ── scenario builders ──────────────────────────────────────────────────────────

def make_continue(now):
    """
    CONTINUE — ROUTINE_HEALTH_CHECK, perfect conditions, single stop in a wide
    window.  There is nothing to reorder and no traffic alert, so max_delay will
    stay low and the brain returns CONTINUE.
    """
    return {
        "event_type":       "ROUTINE_HEALTH_CHECK",
        "manifest_id":      "TEST-CONTINUE-001",
        "courier_id":       "DRV-001",
        "shift_end":        "22:00:00",
        "courier_status":   "EN_ROUTE",
        "vehicle_type":     "van",
        "current_time_iso": iso(now),
        "current_location": {"lat": 39.7740, "lon": 37.0016, "timestamp": iso(now)},
        "environment_horizon": {
            "weather_condition": "clear",
            "traffic_level":     "low",
            "time_bucket":       "midday",
            "temperature_c":     20.0,
            "incident_reported": False,
            "road_type":         "highway"
        },
        "unvisited_stops": [
            {
                "stop_id":          "STP-1",
                "lat":              39.7800, "lon": 37.0100,
                "road_type":        "highway",
                # 3-hour window — very comfortable, no delay expected
                "window_start":     iso(now + timedelta(minutes=10)),
                "window_end":       iso(now + timedelta(hours=3)),
                "current_order":    1,
                "package_weight_kg": 1.0
            }
        ]
    }


def make_reroute(now):
    """
    RE-ROUTE — two stops placed so that stop 2 is geographically *closer* to the
    courier than stop 1.  The hill-climbing TSP optimizer swaps them, setting
    is_reordered=True which is the first branch in the decision tree.
    """
    return {
        "event_type":       "ROUTINE_HEALTH_CHECK",
        "manifest_id":      "TEST-REROUTE-002",
        "courier_id":       "DRV-002",
        "shift_end":        "22:00:00",
        "courier_status":   "EN_ROUTE",
        "vehicle_type":     "car",
        "current_time_iso": iso(now),
        # Courier is near 39.7740, 37.0016
        "current_location": {"lat": 39.7740, "lon": 37.0016, "timestamp": iso(now)},
        "environment_horizon": {
            "weather_condition": "clear",
            "traffic_level":     "low",
            "time_bucket":       "midday",
            "temperature_c":     18.0,
            "incident_reported": False,
            "road_type":         "urban"
        },
        "unvisited_stops": [
            {
                # Stop A — assigned first (current_order=1) but FAR from courier
                "stop_id":          "STP-A",
                "lat":              39.8200, "lon": 37.2000,   # ~18 km away
                "road_type":        "highway",
                "window_start":     iso(now + timedelta(minutes=5)),
                "window_end":       iso(now + timedelta(hours=4)),
                "current_order":    1,
                "package_weight_kg": 2.0
            },
            {
                # Stop B — assigned second (current_order=2) but CLOSE to courier
                "stop_id":          "STP-B",
                "lat":              39.7745, "lon": 37.0025,   # ~0.05 km away
                "road_type":        "urban",
                "window_start":     iso(now + timedelta(minutes=5)),
                "window_end":       iso(now + timedelta(hours=4)),
                "current_order":    2,
                "package_weight_kg": 1.5
            }
        ]
    }


def make_request_alternate_path(now):
    """
    REQUEST_ALTERNATE_PATH — TRAFFIC_ALERT + courier EN_ROUTE + single stop so
    reordering is impossible.  Decision tree falls to the TRAFFIC_ALERT branch
    and picks REQUEST_ALTERNATE_PATH because status is EN_ROUTE.
    """
    return {
        "event_type":       "TRAFFIC_ALERT",
        "manifest_id":      "TEST-ALTERNATE-003",
        "courier_id":       "DRV-003",
        "shift_end":        "22:00:00",
        "courier_status":   "EN_ROUTE",          # <-- key discriminator
        "vehicle_type":     "motorcycle",
        "current_time_iso": iso(now),
        "current_location": {"lat": 39.7740, "lon": 37.0016, "timestamp": iso(now)},
        "environment_horizon": {
            "weather_condition": "rain",
            "traffic_level":     "congested",
            "time_bucket":       "morning",
            "temperature_c":     14.0,
            "incident_reported": True,
            "road_type":         "urban"
        },
        "unvisited_stops": [
            {
                "stop_id":          "STP-X",
                "lat":              39.7800, "lon": 37.0100,
                "road_type":        "urban",
                "window_start":     iso(now + timedelta(minutes=5)),
                "window_end":       iso(now + timedelta(hours=3)),
                "current_order":    1,
                "package_weight_kg": 1.2
            }
        ]
    }


def make_delay_departure(now):
    """
    DELAY_DEPARTURE — same conditions as REQUEST_ALTERNATE_PATH but with
    courier_status=AT_STOP.  The brain recommends holding at the current stop
    instead of routing around congestion.
    """
    return {
        "event_type":       "TRAFFIC_ALERT",
        "manifest_id":      "TEST-DELAY-004",
        "courier_id":       "DRV-004",
        "shift_end":        "22:00:00",
        "courier_status":   "AT_STOP",           # <-- key discriminator
        "vehicle_type":     "truck",
        "current_time_iso": iso(now),
        "current_location": {"lat": 39.7740, "lon": 37.0016, "timestamp": iso(now)},
        "environment_horizon": {
            "weather_condition": "snow",
            "traffic_level":     "congested",
            "time_bucket":       "morning",
            "temperature_c":     1.0,
            "incident_reported": True,
            "road_type":         "mountain"
        },
        "unvisited_stops": [
            {
                "stop_id":          "STP-Y",
                "lat":              39.7800, "lon": 37.0100,
                "road_type":        "mountain",
                "window_start":     iso(now + timedelta(minutes=5)),
                "window_end":       iso(now + timedelta(hours=3)),
                "current_order":    1,
                "package_weight_kg": 5.0
            }
        ]
    }


# ── main ───────────────────────────────────────────────────────────────────────

def main():
    print("Connecting to Redis on localhost:6379 ...")
    try:
        r = connect()
    except redis.ConnectionError:
        print("ERROR: Cannot reach Redis. Make sure Docker is running (`docker compose up`).")
        return

    print("Seeding world-state into Redis ...")
    seed_world_state(r)

    now = datetime.now(timezone.utc)

    scenarios = [
        ("CONTINUE",                make_continue(now)),
        ("RE-ROUTE",                make_reroute(now)),
        ("REQUEST_ALTERNATE_PATH",  make_request_alternate_path(now)),
        ("DELAY_DEPARTURE",         make_delay_departure(now)),
    ]

    for label, payload in scenarios:
        fire_and_wait(r, label, payload)
        # brief pause so the brain worker releases its de-bounce lock (10 s TTL)
        # before the next scenario touches a *different* manifest_id anyway,
        # but the pause also avoids flooding the worker.
        time.sleep(2)

    print(f"\n{'='*60}")
    print("  All scenarios fired.")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
