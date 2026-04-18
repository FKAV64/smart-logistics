import os
import json
import redis
import traceback
from datetime import datetime

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
    high_risk = [(sid, p) for sid, p in stop_probs.items() if p >= 0.5]
    high_risk.sort(key=lambda x: x[1], reverse=True)
    if not high_risk:
        return base_reason
    top = high_risk[:2]
    prob_str = ', '.join(f'Stop #{sid} ({int(p * 100)}%)' for sid, p in top)
    return base_reason + f' High delay risk: {prob_str}.'


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
            courier_status   = message_data.get('courier_status', 'EN_ROUTE')
            current_time_iso = message_data.get(
                'current_time_iso',
                datetime.utcnow().isoformat() + "Z"
            )

            # Compute per-stop delay probabilities
            stop_probs = self.ml_engine.predict_stop_probabilities(
                unvisited_stops, message_data
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
            reason   = "Current sequence is mathematically optimal."
            severity = "low"

            if res.get("health") == "FAILED":
                late_time = res.get('minutes_late', 0)
                action    = "NOTIFY_DISPATCH_LATE"
                reason    = (f"Mathematical impossibility: Route will miss delivery windows "
                             f"by at least {late_time} minutes. Alerting Dispatch.")
                severity  = "CRITICAL"
            elif res["is_reordered"]:
                action   = "RE-ROUTE"
                reason   = f"Re-ordering stops saves {res['time_saved']} minutes and protects time windows."
                severity = "high"
            elif message_data.get("event_type") == "TRAFFIC_ALERT" or res["max_delay"] > 15:
                severity = "medium"
                if courier_status == "AT_STOP":
                    action = "DELAY_DEPARTURE"
                    reason = ("Heavy localized traffic. Hold at current stop for 15 minutes "
                              "to avoid idling fuel burn.")
                else:
                    action = "REQUEST_ALTERNATE_PATH"
                    reason = ("Sequence remains optimal but physical path blocked. "
                              "Requesting alternate route.")

            response_payload = {
                "manifest_id": manifest_id,
                "courier_id":  validated_payload.courier_id,
                "status":      "OPTIMIZED",
                "ai_recommendation": {
                    "action_type":             action,
                    "severity":                severity,
                    "reason":                  _build_reason(reason, stop_probs),
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
