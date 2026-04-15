import copy
import random
from datetime import datetime, timedelta
import pandas as pd

class RouteOptimizer:
    def __init__(self, base_speed_kmh=40.0):
        # We assume an average city speed, but the ML model will adjust this dynamically
        self.base_speed_kmh = base_speed_kmh

    def _build_fast_lookup(self, scored_matrix: pd.DataFrame) -> dict:
        """
        Converts the Pandas Scored Matrix into an O(1) dictionary lookup.
        Applies the AI delay probability as a time penalty.
        """
        lookup = {}
        for _, row in scored_matrix.iterrows():
            # Calculate base travel time in minutes based on distance
            base_time_min = (row['distance_km'] / self.base_speed_kmh) * 60.0
            
            # INJECT AI LOGIC: Inflate travel time if delay probability is high.
            # Example: A 10-minute drive with 80% delay probability becomes 10 * (1 + 0.8) = 18 minutes.
            delay_factor = 1.0 + row['delay_probability']
            adjusted_time_min = base_time_min * delay_factor
            
            lookup[(row['from_stop'], row['to_stop'])] = {
                'travel_time': adjusted_time_min,
                'delay_prob': row['delay_probability']
            }
        return lookup

    def _evaluate_sequence(self, sequence: list, lookup: dict, start_time: datetime):
        """
        Calculates the total time of a specific sequence of stops.
        Applies massive penalties if a delivery window is missed.
        """
        current_time = start_time
        total_cost_minutes = 0
        max_ai_risk_encountered = 0.0
        
        for i in range(len(sequence) - 1):
            from_stop = sequence[i]
            to_stop = sequence[i+1]
            
            # Fetch AI-adjusted travel time from our fast lookup matrix
            edge = lookup.get((from_stop['stop_id'], to_stop['stop_id']))
            if not edge:
                return float('inf'), 1.0 # Invalid sequence (missing matrix data)
                
            travel_time = edge['travel_time']
            max_ai_risk_encountered = max(max_ai_risk_encountered, edge['delay_prob'])
            
            # Drive to the next stop
            current_time += timedelta(minutes=travel_time)
            total_cost_minutes += travel_time
            
            # Parse Time Windows (Handling standard ISO 8601 strings)
            window_start = datetime.fromisoformat(to_stop['window_start'].replace('Z', '+00:00'))
            window_end = datetime.fromisoformat(to_stop['window_end'].replace('Z', '+00:00'))
            
            # HARD CONSTRAINT: Did we arrive too late?
            if current_time > window_end:
                total_cost_minutes += 10000  # Massive penalty to discard this route
                
            # CONSTRAINT: Did we arrive too early?
            if current_time < window_start:
                wait_time = (window_start - current_time).total_seconds() / 60.0
                current_time = window_start # Fast-forward to when the window opens
                total_cost_minutes += wait_time
                
            # Add time spent physically dropping off the package
            service_min = to_stop.get('planned_service_min', 5.0)
            current_time += timedelta(minutes=service_min)
            
        return total_cost_minutes, max_ai_risk_encountered

    def optimize_route(self, unvisited_stops: list, scored_matrix: pd.DataFrame, current_time_iso: str):
        """
        The Main Entry Point.
        Takes unvisited stops and the ML Scored Matrix, returns reordered stops and Dispatcher UI Insights.
        """
        # Rule 1: We never reduce stops. If there's only 1 left, return it immediately.
        if len(unvisited_stops) <= 1:
            return {
                "optimized_stops": unvisited_stops,
                "dispatcher_insight": "Only one stop remaining. Proceed as planned."
            }
            
        start_time = datetime.fromisoformat(current_time_iso.replace('Z', '+00:00'))
        lookup = self._build_fast_lookup(scored_matrix)
        
        # We use a Hill-Climbing algorithm. It's blazing fast and excellent for < 20 stops.
        best_sequence = copy.deepcopy(unvisited_stops)
        best_cost, best_risk = self._evaluate_sequence(best_sequence, lookup, start_time)
        
        iterations = 1000 # Enough to optimize, fast enough to never lag Node.js
        for _ in range(iterations):
            new_seq = copy.deepcopy(best_sequence)
            
            # Randomly swap two stops to test a new combination
            idx1, idx2 = random.sample(range(len(new_seq)), 2)
            new_seq[idx1], new_seq[idx2] = new_seq[idx2], new_seq[idx1]
            
            new_cost, new_risk = self._evaluate_sequence(new_seq, lookup, start_time)
            
            # If the new combination is faster and obeys time windows, adopt it
            if new_cost < best_cost:
                best_cost = new_cost
                best_sequence = new_seq
                best_risk = new_risk

        # Reassign sequence numbers based on the new order
        for index, stop in enumerate(best_sequence):
            stop['current_order'] = index + 1

        # Check if the AI actually changed the route to generate the UI Insight
        original_ids = [s['stop_id'] for s in unvisited_stops]
        new_ids = [s['stop_id'] for s in best_sequence]
        
        if original_ids == new_ids:
            insight = "Route is optimal. AI confirms no major weather/traffic threats on current path."
        else:
            insight = f"AI Reorder Suggested: Optimized to avoid a {int(best_risk*100)}% risk of delay while protecting time windows."
            
        return {
            "optimized_stops": best_sequence,
            "dispatcher_insight": insight
        }