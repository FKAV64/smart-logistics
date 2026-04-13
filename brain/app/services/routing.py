import math
from typing import List, Dict
from datetime import datetime, timedelta

def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Euclidean distance fallback."""
    return math.sqrt((lat2 - lat1)**2 + (lon2 - lon1)**2)

def calculate_route_cost(route_indices: List[int], dist_matrix: List[List[float]], all_nodes: List[Dict], start_time: datetime) -> float:
    """
    Calculates the 'cost' of a route. Cost = Physical Distance + Time Penalties.
    If a route makes the truck late for a time window, it gets a massive penalty.
    """
    total_cost = 0.0
    current_time = start_time

    for i in range(len(route_indices) - 1):
        from_idx = route_indices[i]
        to_idx = route_indices[i+1]
        
        # 1. Add physical distance
        distance = dist_matrix[from_idx][to_idx]
        total_cost += distance
        
        # 2. Simulate travel time (Hackathon heuristic: 1 degree distance ~ 200 mins driving)
        travel_minutes = distance * 200 
        current_time += timedelta(minutes=travel_minutes)
        
        target_node = all_nodes[to_idx]
        
        # 3. Time Window Logic (Skip Node 0, as it is the current location without windows)
        if to_idx != 0 and "window_start" in target_node:
            # Parse ISO strings to Python datetimes (handling Z timezone safely)
            window_start = datetime.fromisoformat(target_node["window_start"].replace('Z', '+00:00'))
            window_end = datetime.fromisoformat(target_node["window_end"].replace('Z', '+00:00'))
            
            if current_time < window_start:
                # The truck arrived too early. It must wait.
                current_time = window_start
            elif current_time > window_end:
                # The truck is LATE. Apply a massive mathematical penalty!
                late_minutes = (current_time - window_end).total_seconds() / 60.0
                total_cost += (late_minutes * 10.0) # Severe penalty weight
                
        # 4. Add 5 minutes for the driver to drop off the package
        current_time += timedelta(minutes=5)
        
    return total_cost

def two_opt_with_windows(initial_route: List[int], dist_matrix: List[List[float]], all_nodes: List[Dict], start_time: datetime) -> List[int]:
    """2-opt algorithm that evaluates time windows."""
    best_route = initial_route[:]
    best_cost = calculate_route_cost(best_route, dist_matrix, all_nodes, start_time)
    improvement = True
    
    while improvement:
        improvement = False
        for i in range(1, len(best_route) - 1):
            for j in range(i + 1, len(best_route)):
                # Try the swap
                new_route = best_route[:i] + best_route[i:j+1][::-1] + best_route[j+1:]
                new_cost = calculate_route_cost(new_route, dist_matrix, all_nodes, start_time)
                
                # If this sequence has fewer late penalties and/or distance, keep it!
                if new_cost < best_cost:
                    best_cost = new_cost
                    best_route = new_route
                    improvement = True
                    
    return best_route

def optimize_route(current_location: dict, unvisited_stops: List[dict]) -> dict:
    print(f"🗺️ Nav Engine: 2-opt (Time-Aware) optimizing sequence for {len(unvisited_stops)} stops...")
    
    if not unvisited_stops:
        return {"new_sequence": [], "time_saved_minutes": 0}

    all_nodes = [current_location] + unvisited_stops
    n = len(all_nodes)
    
    # Pre-compute distance matrix
    dist_matrix = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                dist_matrix[i][j] = calculate_distance(
                    all_nodes[i]["lat"], all_nodes[i]["lon"],
                    all_nodes[j]["lat"], all_nodes[j]["lon"]
                )
    
    # Establish "Now"
    start_time = datetime.fromisoformat(current_location["timestamp"].replace('Z', '+00:00'))
    
    initial_route = list(range(n))
    
    # Run the Time-Aware 2-opt
    best_route_indices = two_opt_with_windows(initial_route, dist_matrix, all_nodes, start_time)
    
    optimized_sequence = [all_nodes[idx]["stop_id"] for idx in best_route_indices[1:]]
    
    return {
        "action_type": "RE-ROUTE",
        "severity": "high",
        "reason": "Optimized to protect critical time window deadlines.",
        "new_sequence": optimized_sequence,
        "impact": {
            "time_saved_minutes": 15, # Hardcoded baseline for MVP
            "route_health": "STABLE"
        }
    }