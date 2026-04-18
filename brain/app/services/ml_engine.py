import math
import pandas as pd
import joblib
import networkx as nx


class MLEngine:
    def __init__(self):
        self.model      = joblib.load('trained_models/xgboost_delay_model.pkl')
        self.prob_model = joblib.load('trained_models/xgboost_prob_model.pkl')

        self.EXPECTED_FEATURES = [
            'road_type',
            'vehicle_type',
            'weather_condition',
            'traffic_level',
            'time_bucket',
            'temperature_c',
            'distance_from_prev_km',
            'planned_travel_min',
            'stop_sequence',
            'package_weight_kg',
            'road_incident',
        ]

        self.VALID_CATEGORIES = {
            "road_type":         {"highway", "urban", "rural", "mountain"},
            "vehicle_type":      {"van", "truck", "motorcycle", "car"},
            "weather_condition": {"clear", "cloudy", "rain", "snow", "fog", "wind"},
            "traffic_level":     {"low", "moderate", "high", "congested"},
            "time_bucket":       {"early_morning", "morning_rush", "midday", "evening_rush", "night"},
        }

        self.DEFAULTS = {
            "road_type":         "highway",
            "vehicle_type":      "van",
            "weather_condition": "clear",
            "traffic_level":     "low",
            "time_bucket":       "midday",
        }

        self.SPEED_PROFILES = {
            "motorcycle": 52.2,
            "car":        40.0,
            "truck":      22.8,
            "van":        22.5,
        }

    def _haversine_distance(self, lat1, lon1, lat2, lon2) -> float:
        R = 6371.0
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat / 2) ** 2 +
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
             math.sin(dlon / 2) ** 2)
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    def _safe_get(self, value, category: str) -> str:
        return value if value in self.VALID_CATEGORIES[category] else self.DEFAULTS[category]

    def _extract_env(self, payload: dict) -> dict:
        env = payload.get('environment_horizon', {})
        return {
            'temperature_c':     env.get('temperature_c', 15.0),
            'road_incident':     1 if env.get('incident_reported', False) else 0,
            'weather_condition': self._safe_get(env.get('weather_condition'), 'weather_condition'),
            'traffic_level':     self._safe_get(env.get('traffic_level'),     'traffic_level'),
            'time_bucket':       self._safe_get(env.get('time_bucket'),       'time_bucket'),
        }

    def predict_segment_delays(self, payload: dict, map_graph) -> nx.DiGraph:
        """
        Scores every physical street edge in the NetworkX graph with
        AI-predicted routing cost (planned_time + delay).
        Returns a weighted copy of the graph ready for Dijkstra pathfinding.
        """
        scored_graph = map_graph.copy()
        edges = list(scored_graph.edges(data=True))
        if not edges:
            return scored_graph

        env = self._extract_env(payload)
        vehicle_type   = self._safe_get(payload.get('vehicle_type', 'van'), 'vehicle_type')
        base_speed_kmh = self.SPEED_PROFILES.get(vehicle_type, 40.0)

        edge_data = []
        edge_keys = []

        for u, v, data in edges:
            dist_km     = data.get('distance_km', 0.1)
            planned_min = (dist_km / base_speed_kmh) * 60.0 if base_speed_kmh > 0 else 1.0
            road_type   = 'urban' if dist_km < 1.0 else 'highway'

            edge_data.append({
                'road_type':             road_type,
                'vehicle_type':          vehicle_type,
                'weather_condition':     env['weather_condition'],
                'traffic_level':         env['traffic_level'],
                'time_bucket':           env['time_bucket'],
                'temperature_c':         env['temperature_c'],
                'distance_from_prev_km': round(dist_km, 2),
                'planned_travel_min':    round(planned_min, 2),
                'stop_sequence':         1,
                'package_weight_kg':     5.0,
                'road_incident':         env['road_incident'],
            })
            edge_keys.append((u, v))

        df              = pd.DataFrame(edge_data)
        predicted_delays = self.model.predict(df[self.EXPECTED_FEATURES])

        for idx, (u, v) in enumerate(edge_keys):
            base_time = edge_data[idx]['planned_travel_min']
            ml_delay  = float(predicted_delays[idx])
            scored_graph[u][v]['weight']               = base_time + max(0.0, ml_delay)
            scored_graph[u][v]['planned_travel_min']   = base_time
            scored_graph[u][v]['predicted_delay_min']  = ml_delay

        return scored_graph

    def predict_stop_probabilities(self, stops: list, payload: dict) -> dict:
        """
        Returns {stop_id: delay_probability (0-1)} for each unvisited stop.
        Uses the binary XGBoost classifier trained with threshold = 10 min.
        """
        if not stops:
            return {}

        env            = self._extract_env(payload)
        vehicle_type   = self._safe_get(payload.get('vehicle_type', 'van'), 'vehicle_type')
        base_speed_kmh = self.SPEED_PROFILES.get(vehicle_type, 40.0)

        rows = []
        for i, stop in enumerate(stops):
            prev      = stops[i - 1] if i > 0 else stop
            dist_km   = self._haversine_distance(
                float(prev.get('lat', stop['lat'])), float(prev.get('lon', stop['lon'])),
                float(stop['lat']),                  float(stop['lon'])
            )
            planned_min = (dist_km / base_speed_kmh) * 60.0 if base_speed_kmh > 0 else 1.0
            road_type   = self._safe_get(stop.get('road_type', 'urban'), 'road_type')

            rows.append({
                'road_type':             road_type,
                'vehicle_type':          vehicle_type,
                'weather_condition':     env['weather_condition'],
                'traffic_level':         env['traffic_level'],
                'time_bucket':           env['time_bucket'],
                'temperature_c':         env['temperature_c'],
                'distance_from_prev_km': round(dist_km, 3),
                'planned_travel_min':    round(planned_min, 2),
                'stop_sequence':         stop.get('current_order', i + 1),
                'package_weight_kg':     float(stop.get('package_weight_kg', 5.0)),
                'road_incident':         env['road_incident'],
            })

        df    = pd.DataFrame(rows)
        probs = self.prob_model.predict_proba(df[self.EXPECTED_FEATURES])[:, 1]

        return {str(stops[i].get('stop_id', i)): round(float(probs[i]), 3)
                for i in range(len(stops))}
