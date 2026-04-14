import math
from typing import List, Dict
from datetime import datetime, timedelta
from app.services.ml_engine import predict_segment_delay

def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Euclidean distance fallback."""
    return math.sqrt((lat2 - lat1)**2 + (lon2 - lon1)**2)

def build_time_matrix(all_nodes: List[Dict], vehicle_type: str, env_horizon: dict) -> List[List[float]]:
    """
    Builds an ephemeral (dynamic) matrix of travel times between all nodes.
    Base Time + ML Expected Delay = Total Segment Time.
    """
    n = len(all_nodes)
    time_matrix = [[0.0] * n for _ in range(n)]
    
    for i in range(n):
        for j in range(n):
            if i != j:
                # 1. Calculate physical distance
                distance = calculate_distance(
                    all_nodes[i]["lat"], all_nodes[i]["lon"],
                    all_nodes[j]["lat"], all_nodes[j]["lon"]
                )
                
                # Baseline travel time heuristic (1 degree ~ 200 mins)
                base_time_mins = distance * 200 
                
                # 2. Get the road type for the destination node
                # (Node 0 is the current location, which has no incoming road type)
                road_type = all_nodes[j].get("road_type", "urban") if j != 0 else "urban"
                
                # 3. Ask the ML Engine for the expected delay on this specific segment
                ml_prediction = predict_segment_delay(road_type, vehicle_type, env_horizon)
                expected_delay = ml_prediction["expected_delay_mins"]
                
                # 4. Total Expected Time for this segment
                time_matrix[i][j] = base_time_mins + expected_delay
                
    return time_matrix

def calculate_route_cost(route_indices: List[int], time_matrix: List[List[float]], all_nodes: List[Dict], start_time: datetime) -> float:
    """Calculates cost based purely on Time Matrix + Time Window Penalties."""
    total_cost_mins = 0.0
    current_time = start_time

    for i in range(len(route_indices) - 1):
        from_idx = route_indices[i]
        to_idx = route_indices[i+1]
        
        # 1. Add the ML-Adjusted Travel Time
        travel_minutes = time_matrix[from_idx][to_idx]
        total_cost_mins += travel_minutes
        current_time += timedelta(minutes=travel_minutes)
        
        target_node = all_nodes[to_idx]
        
        # 2. Time Window Logic
        if to_idx != 0 and "window_start" in target_node:
            window_start = datetime.fromisoformat(target_node["window_start"].replace('Z', '+00:00'))
            window_end = datetime.fromisoformat(target_node["window_end"].replace('Z', '+00:00'))
            
            if current_time < window_start:
                # Wait for window to open
                current_time = window_start
            elif current_time > window_end:
                # Severe Penalty: 10x multiplier for every minute late
                late_minutes = (current_time - window_end).total_seconds() / 60.0
                total_cost_mins += (late_minutes * 10.0) 
                
        # 3. Add 5 minutes for package drop-off
        current_time += timedelta(minutes=5)
        
    return total_cost_mins

def two_opt_with_windows(initial_route: List[int], time_matrix: List[List[float]], all_nodes: List[Dict], start_time: datetime) -> List[int]:
    """2-opt local search utilizing the ML Time Matrix."""
    best_route = initial_route[:]
    best_cost = calculate_route_cost(best_route, time_matrix, all_nodes, start_time)
    improvement = True
    
    while improvement:
        improvement = False
        for i in range(1, len(best_route) - 1):
            for j in range(i + 1, len(best_route)):
                new_route = best_route[:i] + best_route[i:j+1][::-1] + best_route[j+1:]
                new_cost = calculate_route_cost(new_route, time_matrix, all_nodes, start_time)
                
                if new_cost < best_cost:
                    best_cost = new_cost
                    best_route = new_route
                    improvement = True
                    
    return best_route

def optimize_route(current_location: dict, unvisited_stops: List[dict], vehicle_type: str, env_horizon: dict) -> dict:
    """
    Entry point for the Nav Engine.
    Builds the ML Time Matrix and runs the time-aware 2-opt.
    """
    print(f"🗺️ Nav Engine: Generating Spatio-Temporal Matrix for {len(unvisited_stops)} segments...")
    
    if not unvisited_stops:
        return {"new_sequence": [], "time_saved_minutes": 0, "total_route_time": 0}

    all_nodes = [current_location] + unvisited_stops
    n = len(all_nodes)
    
    # 1. Build the ML-Adjusted Time Matrix (Dynamic Horizon)
    time_matrix = build_time_matrix(all_nodes, vehicle_type, env_horizon)
    
    # 2. Establish "Now"
    start_time = datetime.fromisoformat(current_location["timestamp"].replace('Z', '+00:00'))
    
    # 3. Run the Algorithm
    initial_route = list(range(n))
    best_route_indices = two_opt_with_windows(initial_route, time_matrix, all_nodes, start_time)
    
    optimized_sequence = [all_nodes[idx]["stop_id"] for idx in best_route_indices[1:]]
    
    # Get final simulated cost of the new route to pass back to the dispatcher logic
    final_cost = calculate_route_cost(best_route_indices, time_matrix, all_nodes, start_time)
    
    return {
        "new_sequence": optimized_sequence,
        "impact": {
            "time_saved_minutes": 0, # Will be calculated by the Dispatcher delta logic
            "route_health": "STABLE"
        },
        "_debug_final_cost": final_cost # Useful for internal worker logic
    }