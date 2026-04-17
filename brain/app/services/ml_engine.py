import math
import itertools
import pandas as pd
import joblib
import networkx as nx
 
 
class MLEngine:
    def __init__(self):
        self.model = joblib.load('trained_models/xgboost_delay_model.pkl')
 
        # The exact feature order the trained XGBoost Pipeline expects.
        # This must match model_metadata.json and the training notebook exactly.
        self.EXPECTED_FEATURES = [
            'road_type',             # categorical
            'vehicle_type',          # categorical
            'weather_condition',     # categorical
            'traffic_level',         # categorical
            'time_bucket',           # categorical
            'temperature_c',         # numeric
            'distance_from_prev_km', # numeric
            'planned_travel_min',    # numeric
            'stop_sequence',         # numeric
            'package_weight_kg',     # numeric
            'road_incident',         # binary (0 or 1)
        ]
 
        self.VALID_CATEGORIES = {
            "road_type": {"highway", "urban", "rural", "mountain"},
            "vehicle_type": {"van", "truck", "motorcycle", "car"},
            "weather_condition": {"clear", "cloudy", "rain", "snow", "fog", "wind"},
            "traffic_level": {"low", "moderate", "high", "congested"},
            "time_bucket": {"morning", "midday", "evening", "night"}
        }
 
        self.DEFAULTS = {
            "road_type": "highway",
            "vehicle_type": "van",
            "weather_condition": "clear",
            "traffic_level": "low",
            "time_bucket": "midday"
        }
        
        self.SPEED_PROFILES = {
            "motorcycle": 52.2,
            "car":        40.0,
            "truck":      22.8,
            "van":        22.5
        }

    def _haversine_distance(self, lat1, lon1, lat2, lon2):
        R = 6371.0
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat / 2)**2 +
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c
 
    def predict_segment_delays(self, payload: dict, map_graph) -> nx.DiGraph:
        """
        Instead of predicting delays between stops (straight lines),
        this predicts delays on actual physical street segments and outputs
        a dynamically scored NetworkX Graph ready for true physical routing.
        """
        # We create a fresh copy of the bare street layout so we can mutate weights
        scored_graph = map_graph.copy()
        edges = scored_graph.edges(data=True)
        
        if not edges:
            return scored_graph

        # Extract environment features from payload
        env = payload.get('environment_horizon', {})
        temperature_c = env.get('temperature_c', 15.0)
        road_incident = 1 if env.get('incident_reported', False) else 0

        def safe_get(value, category):
            return value if value in self.VALID_CATEGORIES[category] else self.DEFAULTS[category]

        weather_condition = safe_get(env.get('weather_condition'), 'weather_condition')
        traffic_level     = safe_get(env.get('traffic_level'),     'traffic_level')
        time_bucket       = safe_get(env.get('time_bucket'),       'time_bucket')
        
        vehicle_type = payload.get('vehicle_type', 'van')
        if vehicle_type not in self.VALID_CATEGORIES['vehicle_type']:
            vehicle_type = self.DEFAULTS['vehicle_type']
            
        base_speed_kmh = self.SPEED_PROFILES.get(vehicle_type, 40.0)

        # Build feature matrix mapping to physically true edges
        edge_data = []
        edge_keys = []
        
        for u, v, data in edges:
            dist_km = data.get('distance_km', 0.1)
            planned_min = (dist_km / base_speed_kmh) * 60.0 if base_speed_kmh > 0 else 1.0
            
            # Using basic default heuristics for street type if not derived natively
            road_type = 'urban' if dist_km < 1.0 else 'highway'
            
            edge_data.append({
                'road_type': road_type,
                'distance_from_prev_km': round(dist_km, 2),
                'stop_sequence': 1, # Not strictly applicable per segment
                'package_weight_kg': 5.0, # Defaulting for edge inference
                'planned_travel_min': round(planned_min, 2),
                'temperature_c': temperature_c,
                'road_incident': road_incident,
                'vehicle_type': vehicle_type,
                'weather_condition': weather_condition,
                'traffic_level': traffic_level,
                'time_bucket': time_bucket
            })
            edge_keys.append((u, v))

        df = pd.DataFrame(edge_data)
        features = df[self.EXPECTED_FEATURES]

        # Bulk inference using the pretrained pipeline! Super fast even on 10,000 rows.
        predicted_delays = self.model.predict(features)
        
        # Apply the AI outputs directly back onto the NetworkX geographic properties (Weights)
        for idx, (u, v) in enumerate(edge_keys):
            base_time = edge_data[idx]['planned_travel_min']
            ml_delay = float(predicted_delays[idx])
            
            # Overall AI-powered Routing Cost
            absolute_cost_minutes = base_time + max(0.0, ml_delay)
            
            # Embed into the edge
            scored_graph[u][v]['weight'] = absolute_cost_minutes
            scored_graph[u][v]['planned_travel_min'] = base_time
            scored_graph[u][v]['predicted_delay_min'] = ml_delay

        return scored_graph