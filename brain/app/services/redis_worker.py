import os
import json
import redis
import traceback
from datetime import datetime, timedelta

from app.services.ml_engine import MLEngine
from app.services.routing import RouteOptimizer
from app.models.schemas import TrafficAlertPayload
from pydantic import ValidationError
from app.services.map_seeder import seed_map_if_empty
from app.services.map_engine import MapEngine


def _build_reason(base_reason: str, stop_probs: dict) -> str:
    """Appends per-stop delay probability context to the base reason string."""
    if not stop_probs:
        return base_reason
    high_risk = [(sid, p) for sid, p in stop_probs.items() if p >= 0.3 and sid != 'COURIER_START']
    high_risk.sort(key=lambda x: x[1], reverse=True)
    if not high_risk:
        return base_reason
    top = high_risk[:2]
    prob_str = ', '.join(f'Stop #{sid} ({int(p * 100)}% delay risk)' for sid, p in top)
    return base_reason + f' Flagged stops: {prob_str}.'


def _dynamic_reason(action: str, res: dict, message_data: dict, stop_probs: dict, courier_status: str) -> str:
    """Generates a rich, context-aware reason string using real payload data."""
    env         = message_data.get('environment_horizon', {})
    traffic     = env.get('traffic_level', 'moderate').upper()
    weather     = env.get('weather_condition', 'clear').lower()
    road_type   = env.get('road_type', 'urban').lower()
    incident    = env.get('incident_reported', False)
    time_bucket = env.get('time_bucket', 'midday').replace('_', ' ')
    stops       = [s for s in message_data.get('unvisited_stops', []) if s.get('stop_id') != 'COURIER_START']
    n_stops     = len(stops)
    time_saved  = res.get('time_saved', 0)
    late_min    = res.get('minutes_late', 0)
    max_delay   = res.get('max_delay', 0)

    # Per-stop high risk context
    high_risk = [(sid, p) for sid, p in stop_probs.items() if p >= 0.3 and sid != 'COURIER_START']
    high_risk.sort(key=lambda x: x[1], reverse=True)
    risk_suffix = ''
    if high_risk:
        risk_suffix = ' Elevated delay probability on: ' + ', '.join(f'Stop #{sid} ({int(p*100)}%)' for sid, p in high_risk[:2]) + '.'

    weather_note = '' if weather in ('clear', 'cloudy') else f' Weather: {weather}.'
    incident_note = ' Road incident reported on ahead segment.' if incident else ''

    if action == 'NOTIFY_DISPATCH_LATE':
        return (
            f"Route health FAILED — {n_stops} pending stop(s) cannot be reached within their time windows. "
            f"Predicted overshoot: {late_min} min. Traffic on {road_type} roads is {traffic} "
            f"during {time_bucket}.{weather_note}{incident_note}{risk_suffix}"
        )
    elif action == 'RE-ROUTE':
        new_seq = [s['stop_id'] for s in res.get('best_sequence', stops) if s.get('stop_id') != 'COURIER_START']
        seq_str = ' → '.join(f'#{sid}' for sid in new_seq) if new_seq else 'optimized order'
        return (
            f"AI resequenced {n_stops} stop(s) to avoid {traffic.lower()} congestion on {road_type} roads. "
            f"New order: {seq_str}. Estimated saving: {time_saved} min.{weather_note}{risk_suffix}"
        )
    elif action == 'DELAY_DEPARTURE':
        return (
            f"Heavy congestion ({traffic}) detected {road_type} ahead during {time_bucket}. "
            f"Holding at current stop for ~15 min is predicted to reduce total journey time by up to {max(time_saved, 12)} min.{weather_note}{incident_note}"
        )
    elif action == 'REQUEST_ALTERNATE_PATH':
        return (
            f"Stop sequence is optimal, but {traffic.lower()} traffic{'and an incident ' if incident else ' '}detected on the current segment. "
            f"Re-routing via alternate {road_type} path.{weather_note} Max segment delay: {max_delay} min.{risk_suffix}"
        )
    else:  # CONTINUE
        return (
            f"All {n_stops} stop(s) on schedule. Traffic: {traffic}, conditions: {weather}, "
            f"road type: {road_type}. No intervention required.{risk_suffix}"
        )


class RedisWorker:
    def __init__(self, host='redis', port=6379):
        print("Initializing Gatekeeper and connecting to Redis...")
        self.redis   = redis.Redis(host=host, port=port, decode_responses=True)
        self.pubsub  = self.redis.pubsub()

        self.listen_channel  = 'traffic_alerts_channel'
        self.publish_channel = 'route_optimizations_channel'

        print("Loading ML Pipeline and Routing Engine...")
        seed_map_if_empty()
        self.map_engine      = MapEngine()
        self.ml_engine       = MLEngine()
        self.route_optimizer = RouteOptimizer(self.map_engine)
        print("Python Brain Worker is Ready.")

    def _acquire_lock(self, manifest_id: str) -> bool:
        lock_key = f"lock:optimize:{manifest_id}"
        return self.redis.set(lock_key, "locked", nx=True, ex=10)

    def process_message(self, message_data: dict):
        if message_data.get('type') == 'PING':
            return

        try:
            validated_payload = TrafficAlertPayload(**message_data)
        except ValidationError as e:
            print(f"Schema Validation Failed: {e}")
            return

        manifest_id = message_data.get('manifest_id')
        if not manifest_id or not self._acquire_lock(manifest_id):
            return

        try:
            unvisited_stops  = message_data.get('unvisited_stops', [])
            current_loc      = message_data.get('current_location', {})
            courier_status   = message_data.get('courier_status', 'EN_ROUTE')
            current_time_iso = message_data.get(
                'current_time_iso',
                datetime.utcnow().isoformat() + "Z"
            )

            # Inject Courier Start Position to generate contiguous route from vehicle to Stop 1
            if current_loc and current_loc.get('lat') and current_loc.get('lon'):
                # Check if it's already there to avoid duplicates
                if not unvisited_stops or unvisited_stops[0].get('stop_id') != 'COURIER_START':
                    stop_0 = {
                        'stop_id': 'COURIER_START',
                        'lat': current_loc['lat'],
                        'lon': current_loc['lon'],
                        'window_start': current_time_iso,
                        'window_end': (datetime.utcnow() + timedelta(hours=24)).isoformat() + "Z"
                    }
                    unvisited_stops.insert(0, stop_0)

            # Compute per-stop delay probabilities
            stop_probs = self.ml_engine.predict_stop_probabilities(
                unvisited_stops, message_data, self.map_engine.get_graph()
            )

            # Score the street graph with XGBoost delay weights
            scored_matrix = self.ml_engine.predict_segment_delays(message_data, self.map_engine.get_graph())
            if not scored_matrix.edges:
                return

            # Run hill-climbing route optimizer
            res = self.route_optimizer.optimize_route(
                unvisited_stops, scored_matrix, current_time_iso
            )

            # Determine action type and severity
            action   = "CONTINUE"
            severity = "low"

            if res.get("health") == "FAILED":
                action   = "NOTIFY_DISPATCH_LATE"
                severity = "CRITICAL"
            elif res["is_reordered"]:
                action   = "RE-ROUTE"
                severity = "high"
            elif message_data.get("event_type") == "TRAFFIC_ALERT" or res["max_delay"] > 15:
                severity = "medium"
                if courier_status == "AT_STOP":
                    action = "DELAY_DEPARTURE"
                else:
                    action = "REQUEST_ALTERNATE_PATH"

            # Generate a rich, dynamic reason using real payload context
            reason = _dynamic_reason(action, res, message_data, stop_probs, courier_status)

            response_payload = {
                "manifest_id": manifest_id,
                "courier_id":  validated_payload.courier_id,
                "status":      "OPTIMIZED",
                "ai_recommendation": {
                    "action_type":             action,
                    "severity":                severity,
                    "reason":                  reason,
                    "new_sequence":            res["new_sequence_ids"],
                    "stop_delay_probabilities": stop_probs,
                    "impact": {
                        "time_saved_minutes": res["time_saved"],
                        "route_health":       res["health"]
                    },
                    "route_geojson": res.get("route_geojson")
                }
            }

            self.redis.publish(self.publish_channel, json.dumps(response_payload))
            print(f"Published {action} for {manifest_id} | probs: {stop_probs}")

        except Exception as e:
            print(f"Error processing manifest {manifest_id}: {str(e)}")
            traceback.print_exc()

    def listen(self):
        self.pubsub.subscribe(self.listen_channel)
        print(f"Listening on '{self.listen_channel}'...")

        for message in self.pubsub.listen():
            if message['type'] == 'message':
                try:
                    data = json.loads(message['data'])
                    self.process_message(data)
                except json.JSONDecodeError:
                    print("Received invalid JSON payload from Node.js.")
                except Exception as e:
                    print(f"Worker critical exception: {str(e)}")


def start_redis_listener():
    print("Background Task: Spinning up Redis Gatekeeper...")
    try:
        redis_host = os.getenv('REDIS_HOST', 'redis')
        redis_port = int(os.getenv('REDIS_PORT', 6379))
        worker = RedisWorker(host=redis_host, port=redis_port)
        worker.listen()
    except Exception as e:
        print(f"Failed to start background Redis worker: {e}")


if __name__ == "__main__":
    redis_host = os.getenv('REDIS_HOST', 'localhost')
    redis_port = int(os.getenv('REDIS_PORT', 6379))
    worker = RedisWorker(host=redis_host, port=redis_port)
    worker.listen()
