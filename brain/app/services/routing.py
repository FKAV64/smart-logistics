import copy
import random
from datetime import datetime, timedelta
import networkx as nx

class RouteOptimizer:
    def __init__(self, map_engine):
        self.map_engine = map_engine

    def _evaluate_sequence(self, sequence: list, scored_graph: nx.DiGraph, start_time: datetime):
        """
        Calculates the total routing cost of a sequence by solving Dijkstra's 
        Algorithm for every sub-leg between stops across the AI-weighted map.
        """
        current_time = start_time
        total_cost_minutes = 0
        max_delay_encountered = 0.0
        max_minutes_late = 0.0
        route_wkt_segments = []
        
        for i in range(len(sequence) - 1):
            from_stop = sequence[i]
            to_stop = sequence[i+1]
            
            # 1. Snap courier/stop GPS to the physical street network
            start_node = self.map_engine.get_nearest_node(from_stop['lon'], from_stop['lat'])
            end_node = self.map_engine.get_nearest_node(to_stop['lon'], to_stop['lat'])
            
            if start_node == end_node:
                continue
                
            try:
                # 2. PHYSICAL PATHFINDING - Calculate shortest path using AI Weights
                path_nodes = nx.shortest_path(scored_graph, source=start_node, target=end_node, weight='weight')
                
                travel_time = 0
                for j in range(len(path_nodes)-1):
                    # Extract the selected street's details
                    u, v = path_nodes[j], path_nodes[j+1]
                    edge = scored_graph[u][v]
                    
                    travel_time += edge['weight']
                    max_delay_encountered = max(max_delay_encountered, edge['predicted_delay_min'])
                    route_wkt_segments.append(edge['geom_wkt'])
                    
            except nx.NetworkXNoPath:
                # Sub-network disconnected or bad snap
                travel_time = 9999
                total_cost_minutes += 9999
            
            # Drive to the next stop
            current_time += timedelta(minutes=travel_time)
            total_cost_minutes += travel_time
            
            # Time Windows
            window_start = datetime.fromisoformat(to_stop['window_start'].replace('Z', '+00:00'))
            window_end = datetime.fromisoformat(to_stop['window_end'].replace('Z', '+00:00'))
            
            if current_time > window_end:
                late_by = (current_time - window_end).total_seconds() / 60.0
                max_minutes_late = max(max_minutes_late, late_by)
                total_cost_minutes += 10000
                
            if current_time < window_start:
                wait_time = (window_start - current_time).total_seconds() / 60.0
                current_time = window_start
                total_cost_minutes += wait_time
            # 13 min average service time derived from route_stops.csv dataset
            service_min = 13.0
            current_time += timedelta(minutes=service_min)
            
        return total_cost_minutes, max_delay_encountered, max_minutes_late, route_wkt_segments

    def _build_geojson(self, wkt_segments):
        """Converts raw WKT Linestrings from the path into a proper GeoJSON object for the frontend"""
        from shapely.wkt import loads as load_wkt
        from shapely.geometry import mapping, MultiLineString
        
        if not wkt_segments:
            return None
            
        try:
            lines = [load_wkt(w) for w in wkt_segments]
            multiline = MultiLineString(lines)
            return {
                "type": "Feature",
                "properties": {"stroke": "#3b82f6", "stroke-width": 4},
                "geometry": mapping(multiline)
            }
        except Exception:
            return None

    def optimize_route(self, unvisited_stops: list, scored_graph: nx.DiGraph, current_time_iso: str):
        if len(unvisited_stops) <= 1:
            return {
                "is_reordered":    False,
                "new_sequence_ids": [s['stop_id'] for s in unvisited_stops],
                "time_saved": 0,
                "max_delay": 0,
                "minutes_late": 0,
                "health": "OPTIMAL",
                "route_geojson": None
            }
            
        start_time = datetime.fromisoformat(current_time_iso.replace('Z', '+00:00'))
        
        # Original sequence evaluation
        original_sequence = copy.deepcopy(unvisited_stops)
        orig_cost, orig_delay, orig_late, _ = self._evaluate_sequence(original_sequence, scored_graph, start_time)
        
        # TSP Hill-Climbing Optimization
        best_sequence = copy.deepcopy(original_sequence)
        best_cost = orig_cost
        best_delay = orig_delay
        best_late = orig_late
        best_wkt_segments = []
        
        for _ in range(50): # Reduced iterations for graph computation speed
            new_seq = copy.deepcopy(best_sequence)
            idx1, idx2 = random.sample(range(len(new_seq)), 2)
            new_seq[idx1], new_seq[idx2] = new_seq[idx2], new_seq[idx1]
            
            new_cost, new_delay, new_late, wkt_segs = self._evaluate_sequence(new_seq, scored_graph, start_time)
            
            if new_cost < best_cost:
                best_cost = new_cost
                best_sequence = new_seq
                best_delay = new_delay
                best_late = new_late
                best_wkt_segments = wkt_segs

        # Fallback to get WKT if original was best
        if not best_wkt_segments:
            _, _, _, best_wkt_segments = self._evaluate_sequence(best_sequence, scored_graph, start_time)

        time_saved = max(0, orig_cost - best_cost)
        is_reordered = [s['stop_id'] for s in original_sequence] != [s['stop_id'] for s in best_sequence]
        
        health = "OPTIMAL"
        if best_cost >= 10000: health = "FAILED"
        elif best_delay > 15: health = "AT_RISK"

        return {
            "is_reordered": is_reordered,
            "new_sequence_ids": [s['stop_id'] for s in best_sequence],
            "time_saved": int(time_saved),
            "max_delay": int(best_delay),
            "minutes_late": int(best_late),
            "health": health,
            "route_geojson": self._build_geojson(best_wkt_segments)
        }