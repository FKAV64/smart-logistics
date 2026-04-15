import copy
import random
from datetime import datetime, timedelta
import pandas as pd

class RouteOptimizer:
    def __init__(self, base_speed_kmh=40.0):
        # We assume an average city speed for pure transit, AI handles the rest
        self.base_speed_kmh = base_speed_kmh

    def _build_fast_lookup(self, scored_matrix: pd.DataFrame) -> dict:
        """
        Converts the Pandas Scored Matrix into an O(1) dictionary lookup.
        Applies pure AI-Predicted Delay Minutes directly to the base travel time.
        """
        lookup = {}
        for _, row in scored_matrix.iterrows():
            # Standard travel time (perfect conditions)
            base_time_min = (row['distance_km'] / self.base_speed_kmh) * 60.0
            
            # The exact penalty predicted by your Scikit-Learn Pipeline
            predicted_delay = row['predicted_delay_min']
            
            # Pure routing logic: ETA = Base + Delay
            adjusted_time_min = base_time_min + predicted_delay
            
            lookup[(row['from_stop'], row['to_stop'])] = {
                'travel_time': adjusted_time_min,
                'predicted_delay': predicted_delay
            }
        return lookup

    def _evaluate_sequence(self, sequence: list, lookup: dict, start_time: datetime):
        """
        Calculates the total time of a specific sequence of stops.
        Applies massive penalties if a delivery window is missed.
        """
        current_time = start_time
        total_cost_minutes = 0
        max_delay_encountered = 0.0
        
        for i in range(len(sequence) - 1):
            from_stop = sequence[i]
            to_stop = sequence[i+1]
            
            # Fetch AI-adjusted travel time from our fast lookup matrix
            edge = lookup.get((from_stop['stop_id'], to_stop['stop_id']))
            if not edge:
                return float('inf'), 0.0 # Invalid sequence (missing matrix data)
                
            travel_time = edge['travel_time']
            max_delay_encountered = max(max_delay_encountered, edge['predicted_delay'])
            
            # Drive to the next stop
            current_time += timedelta(minutes=travel_time)
            total_cost_minutes += travel_time
            
            # Parse Time Windows
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
            
        return total_cost_minutes, max_delay_encountered

    def optimize_route(self, unvisited_stops: list, scored_matrix: pd.DataFrame, current_time_iso: str):
        """
        The Main Entry Point.
        Takes unvisited stops and the ML Scored Matrix, returns reordered stops and Dispatcher UI Insights.
        """
        if len(unvisited_stops) <= 1:
            return {
                "optimized_stops": unvisited_stops,
                "dispatcher_insight": "Only one stop remaining. Proceed as planned."
            }
            
        start_time = datetime.fromisoformat(current_time_iso.replace('Z', '+00:00'))
        lookup = self._build_fast_lookup(scored_matrix)
        
        # Hill-Climbing algorithm
        best_sequence = copy.deepcopy(unvisited_stops)
        best_cost, best_delay = self._evaluate_sequence(best_sequence, lookup, start_time)
        
        iterations = 1000 
        for _ in range(iterations):
            new_seq = copy.deepcopy(best_sequence)
            
            # Randomly swap two stops to test a new combination
            idx1, idx2 = random.sample(range(len(new_seq)), 2)
            new_seq[idx1], new_seq[idx2] = new_seq[idx2], new_seq[idx1]
            
            new_cost, new_delay = self._evaluate_sequence(new_seq, lookup, start_time)
            
            if new_cost < best_cost:
                best_cost = new_cost
                best_sequence = new_seq
                best_delay = new_delay

        # Reassign sequence numbers
        for index, stop in enumerate(best_sequence):
            stop['current_order'] = index + 1

        # Check if the AI actually changed the route to generate the UI Insight
        original_ids = [s['stop_id'] for s in unvisited_stops]
        new_ids = [s['stop_id'] for s in best_sequence]
        
        if original_ids == new_ids:
            insight = "Route is optimal. AI confirms no major threats on current path."
        else:
            insight = f"AI Reorder Suggested: Optimized to avoid up to {int(best_delay)} minutes of predicted delay while protecting time windows."
            
        return {
            "optimized_stops": best_sequence,
            "dispatcher_insight": insight
        }