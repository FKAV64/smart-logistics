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

        Returns:
            total_cost_minutes    – optimizer score (includes large penalty constants, for comparison only)
            actual_travel_minutes – real road time with no penalties (for user-facing reporting)
            max_delay_encountered – worst edge delay seen
            max_minutes_late      – worst real lateness at any stop
            route_wkt_segments    – geometry WKT list
        """
        current_time = start_time
        total_cost_minutes = 0        # optimizer score — may include 9999/10000 penalties
        actual_travel_minutes = 0.0   # real road travel time only — NO penalties
        max_delay_encountered = 0.0
        max_minutes_late = 0.0
        route_wkt_segments = []

        for i in range(len(sequence) - 1):
            from_stop = sequence[i]
            to_stop = sequence[i + 1]

            # 1. Snap courier/stop GPS to the physical street network
            start_node = self.map_engine.get_nearest_node(from_stop['lon'], from_stop['lat'])
            end_node = self.map_engine.get_nearest_node(to_stop['lon'], to_stop['lat'])

            if start_node == end_node:
                continue

            try:
                # 2. PHYSICAL PATHFINDING — shortest path via AI-weighted graph
                path_nodes = nx.shortest_path(scored_graph, source=start_node, target=end_node, weight='weight')

                travel_time = 0
                for j in range(len(path_nodes) - 1):
                    u, v = path_nodes[j], path_nodes[j + 1]
                    edge = scored_graph[u][v]
                    travel_time += edge['weight']
                    max_delay_encountered = max(max_delay_encountered, edge['predicted_delay_min'])
                    route_wkt_segments.append(edge['geom_wkt'])

            except nx.NetworkXNoPath:
                # Sub-network disconnected — penalise optimizer score only, not actual travel time
                total_cost_minutes += 9999
                travel_time = 0

            # Drive to next stop
            current_time += timedelta(minutes=travel_time)
            total_cost_minutes += travel_time
            actual_travel_minutes += travel_time

            # Time windows
            window_start = datetime.fromisoformat(to_stop['window_start'].replace('Z', '+00:00'))
            window_end = datetime.fromisoformat(to_stop['window_end'].replace('Z', '+00:00'))

            if current_time > window_end:
                late_by = (current_time - window_end).total_seconds() / 60.0
                max_minutes_late = max(max_minutes_late, late_by)
                total_cost_minutes += 10000   # heavy optimizer penalty — NOT added to actual_travel

            if current_time < window_start:
                wait_time = (window_start - current_time).total_seconds() / 60.0
                current_time = window_start
                total_cost_minutes += wait_time
                actual_travel_minutes += wait_time

            # 13 min average service time derived from route_stops.csv dataset
            service_min = 13.0
            current_time += timedelta(minutes=service_min)
            actual_travel_minutes += service_min

        return total_cost_minutes, actual_travel_minutes, max_delay_encountered, max_minutes_late, route_wkt_segments

    def _build_geojson(self, wkt_segments):
        """Converts raw WKT LineStrings from the path into a GeoJSON Feature for the frontend."""
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
                "is_reordered": False,
                "new_sequence_ids": [s['stop_id'] for s in unvisited_stops],
                "time_saved": 0,
                "max_delay": 0,
                "minutes_late": 0,
                "health": "OPTIMAL",
                "route_geojson": None
            }

        start_time = datetime.fromisoformat(current_time_iso.replace('Z', '+00:00'))

        # Evaluate original sequence
        original_sequence = copy.deepcopy(unvisited_stops)
        orig_cost, orig_actual, orig_delay, orig_late, orig_wkt_segments = self._evaluate_sequence(
            original_sequence, scored_graph, start_time
        )

        # TSP Hill-Climbing optimiser
        best_sequence = copy.deepcopy(original_sequence)
        best_cost = orig_cost
        best_actual = orig_actual
        best_delay = orig_delay
        best_late = orig_late
        best_wkt_segments = []

        for _ in range(50):
            new_seq = copy.deepcopy(best_sequence)
            start_idx = 1 if len(new_seq) > 0 and new_seq[0].get('stop_id') == 'COURIER_START' else 0
            if len(new_seq) - start_idx < 2:
                break
            idx1, idx2 = random.sample(range(start_idx, len(new_seq)), 2)
            new_seq[idx1], new_seq[idx2] = new_seq[idx2], new_seq[idx1]

            new_cost, new_actual, new_delay, new_late, wkt_segs = self._evaluate_sequence(
                new_seq, scored_graph, start_time
            )

            if new_cost < best_cost:
                best_cost = new_cost
                best_actual = new_actual
                best_sequence = new_seq
                best_delay = new_delay
                best_late = new_late
                best_wkt_segments = wkt_segs

        # Fallback: get WKT geometry if original sequence was already best
        if not best_wkt_segments:
            _, _, _, _, best_wkt_segments = self._evaluate_sequence(best_sequence, scored_graph, start_time)

        # time_saved = difference in REAL travel time — no penalty bleed-through
        time_saved = max(0, int(orig_actual - best_actual))
        is_reordered = [s['stop_id'] for s in original_sequence] != [s['stop_id'] for s in best_sequence]

        # Stability gate: if the hill-climb improvement rounds to zero minutes, treat
        # the original sequence as the "best" one. Prevents silent map oscillation
        # between symmetric orderings on CONTINUE actions.
        if time_saved <= 0:
            best_sequence = original_sequence
            best_wkt_segments = orig_wkt_segments
            best_delay = orig_delay
            best_late = orig_late
            is_reordered = False

        health = "OPTIMAL"
        if best_cost >= 10000:
            health = "FAILED"
        elif best_delay > 15:
            health = "AT_RISK"

        return {
            "is_reordered": is_reordered,
            "new_sequence_ids": [s['stop_id'] for s in best_sequence if s['stop_id'] != 'COURIER_START'],
            "time_saved": time_saved,
            "max_delay": int(best_delay),
            "minutes_late": int(best_late),
            "health": health,
            "route_geojson": self._build_geojson(best_wkt_segments)
        }