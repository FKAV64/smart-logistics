import math
import itertools
import pandas as pd
import joblib
 
 
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
 
    def _build_adjacency_matrix(self, unvisited_stops: list, base_speed_kmh: float) -> pd.DataFrame:
        """
        Builds a pairwise matrix of all stop combinations.
        Each row represents one possible segment (from_stop → to_stop)
        with the stop-level features the model needs.
        """
        matrix_data = []
        for stop_from, stop_to in itertools.permutations(unvisited_stops, 2):
            dist = self._haversine_distance(
                stop_from['lat'], stop_from['lon'],
                stop_to['lat'], stop_to['lon']
            )
            road_type = stop_to.get('road_type', 'highway')
            if road_type not in self.VALID_CATEGORIES['road_type']:
                road_type = self.DEFAULTS['road_type']

            dynamic_planned_travel_min = (dist / base_speed_kmh) * 60.0 if base_speed_kmh > 0 else 15.0

            matrix_data.append({
                'from_stop':             stop_from['stop_id'],
                'to_stop':               stop_to['stop_id'],
                'road_type':             road_type,
                'distance_from_prev_km': round(dist, 2),
                'stop_sequence':         stop_to.get('current_order', 1),
                'package_weight_kg':     stop_to.get('package_weight_kg', 5.0),
                'planned_travel_min':    round(dynamic_planned_travel_min, 2),
            })
        return pd.DataFrame(matrix_data)
 

    def predict_segment_delays(self, payload: dict) -> pd.DataFrame:
        """
        Main entry point called by redis_worker.py.
 
        Expects the full TrafficAlertPayload dict with this structure:
        {
            "route_id": "...",
            "vehicle_type": "van | truck | motorcycle | car",
            "environment_horizon": {
                "weather_condition": "clear | cloudy | rain | snow | fog | wind",
                "traffic_level": "low | moderate | high | congested",
                "time_bucket": "morning | midday | evening | night",
                "temperature_c": 12.5,
                "incident_reported": true
            },
            "unvisited_stops": [ { ...stop fields... } ]
        }
        """
        unvisited_stops = payload.get('unvisited_stops', [])
        if len(unvisited_stops) < 2:
            return pd.DataFrame()
 
        # Extract all ML features from environment_horizon (sent directly by Node.js)
        env = payload.get('environment_horizon', {})
        temperature_c = env.get('temperature_c', 15.0)
        road_incident = 1 if env.get('incident_reported', False) else 0

        def safe_get(value, category):
            return value if value in self.VALID_CATEGORIES[category] else self.DEFAULTS[category]

        weather_condition = safe_get(env.get('weather_condition'), 'weather_condition')
        traffic_level     = safe_get(env.get('traffic_level'),     'traffic_level')
        time_bucket       = safe_get(env.get('time_bucket'),       'time_bucket')
 
        # vehicle_type IS at the top level of the payload
        vehicle_type = payload.get('vehicle_type', 'van')
        if vehicle_type not in self.VALID_CATEGORIES['vehicle_type']:
            vehicle_type = self.DEFAULTS['vehicle_type']
            
        base_speed_kmh = self.SPEED_PROFILES.get(vehicle_type, 40.0)
 
        # 1. Build spatial connections with stop-level features using GPS + speed profiles
        df = self._build_adjacency_matrix(unvisited_stops, base_speed_kmh)

        # 2. Broadcast all global payload-level ML features onto every row
        df['temperature_c']    = temperature_c
        df['road_incident']    = road_incident
        df['vehicle_type']     = vehicle_type
        df['weather_condition'] = weather_condition
        df['traffic_level']    = traffic_level
        df['time_bucket']      = time_bucket
 
        # Use ONLY the features the trained Pipeline knows about
        # Order is strictly maintained by self.EXPECTED_FEATURES
        features = df[self.EXPECTED_FEATURES]
 
        # Run the XGBoost Pipeline (preprocessor + model in one call)
        df['predicted_delay_min'] = self.model.predict(features)
 
        # Pass distance through to the RouteOptimizer
        df['distance_km'] = df['distance_from_prev_km']
 
        return df[['from_stop', 'to_stop', 'distance_km', 'planned_travel_min', 'predicted_delay_min']]