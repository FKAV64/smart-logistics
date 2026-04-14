import redis
import json
from datetime import datetime
from app.services.routing import optimize_route, build_time_matrix, calculate_route_cost

redis_client = redis.Redis(host='localhost', port=6379, db=0, decode_responses=True)

def process_traffic_event(payload_json: str):
    try:
        # 1. Parse Payload
        payload = json.loads(payload_json)
        route_id = payload.get("route_id")
        event_type = payload.get("event_type")
        
        if not route_id or not event_type:
            return

        # 2. Gatekeeper
        if event_type == "PING":
            print(f"📡 [PING] Heartbeat for {route_id}. System healthy.")
            return
            
        if event_type not in ["TRAFFIC_ALERT", "ROUTINE_CHECK"]:
            return

        # 3. Debouncer Lock
        lock_key = f"lock:event:{route_id}"
        if not redis_client.set(lock_key, "locked", nx=True, ex=60):
            print(f"🛑 Event Storm Blocked for {route_id}.")
            return

        print(f"\n✅ Lock acquired for {route_id} ({event_type}). Processing Spatio-Temporal Matrix...")

        # 4. Extract Real-World Variables
        courier_status = payload.get("courier_status", "EN_ROUTE")
        vehicle_type = payload.get("vehicle_type", "van")
        env_horizon = payload.get("environment_horizon", {})
        current_location = payload.get("current_location", {})
        unvisited_stops = payload.get("unvisited_stops", [])
        
        original_sequence = [stop["stop_id"] for stop in sorted(unvisited_stops, key=lambda x: x.get("current_order", 0))]
        
        # 5. Run the ML-Adjusted 2-opt Optimizer
        action_plan_raw = optimize_route(current_location, unvisited_stops, vehicle_type, env_horizon)
        new_sequence = action_plan_raw["new_sequence"]
        new_cost_mins = action_plan_raw.get("_debug_final_cost", 0)

        # 6. Calculate the ORIGINAL cost to find time saved
        all_nodes = [current_location] + unvisited_stops
        time_matrix = build_time_matrix(all_nodes, vehicle_type, env_horizon)
        start_time = datetime.fromisoformat(current_location["timestamp"].replace('Z', '+00:00'))
        
        # Map original stop IDs back to matrix indices (Node 0 is the current location)
        original_indices = [0]
        for stop_id in original_sequence:
            for idx, node in enumerate(all_nodes):
                if node.get("stop_id") == stop_id:
                    original_indices.append(idx)
                    break
                    
        old_cost_mins = calculate_route_cost(original_indices, time_matrix, all_nodes, start_time)
        time_saved = max(0, int(old_cost_mins - new_cost_mins))

        # 7. THE DISPATCHER DELTA LOGIC (4 Core Actions)
        is_hazardous = env_horizon.get("traffic_severity") in ["high", "congested"] or env_horizon.get("incident_reported") is True
        
        action_type = "CONTINUE"
        reason = "Current sequence is mathematically optimal."
        severity = "low"
        
        if new_sequence == original_sequence:
            if is_hazardous:
                if courier_status == "AT_STOP":
                    action_type = "DELAY_DEPARTURE"
                    severity = "medium"
                    reason = "Hazardous conditions ahead. Sequence optimal, advising 15-minute departure hold."
                else:
                    action_type = "REQUEST_ALTERNATE_PATH"
                    severity = "high"
                    reason = "Hazardous conditions on current path. Sequence optimal, requesting TomTom physical detour."
        else:
            action_type = "RE-ROUTE"
            severity = "high"
            reason = f"Re-ordered stops to avoid delays and time-window penalties. Saving {time_saved} minutes."

        # 8. Build Final Output Contract
        final_response = {
            "route_id": route_id,
            "status": "OPTIMIZED" if action_type in ["RE-ROUTE", "REQUEST_ALTERNATE_PATH"] else "MONITORING",
            "ai_recommendation": {
                "action_type": action_type,
                "severity": severity,
                "reason": reason,
                "new_sequence": new_sequence,
                "impact": {
                    "time_saved_minutes": time_saved if action_type == "RE-ROUTE" else 0,
                    "route_health": "AT_RISK" if is_hazardous else "STABLE"
                }
            }
        }
        
        print(f"🚀 FINAL OUTPUT FOR NODE.JS:\n{json.dumps(final_response, indent=2)}")
        
    except Exception as e:
        print(f"❌ Redis Worker Error: {e}")

def start_redis_listener():
    pubsub = redis_client.pubsub()
    pubsub.subscribe("traffic_alerts_channel")
    print("🎧 Python Brain listening to Redis: 'traffic_alerts_channel'")
    
    for message in pubsub.listen():
        if message["type"] == "message":
            process_traffic_event(message["data"])