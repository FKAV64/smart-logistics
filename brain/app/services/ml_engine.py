import math
import itertools
import json
import pandas as pd
import joblib
import redis
 
 
class MLEngine:
    def __init__(self, redis_client=None):
        self.model = joblib.load('trained_models/xgboost_delay_model.pkl')
        self.redis = redis_client or redis.Redis(host='localhost', port=6379, decode_responses=True)
 
        # The exact feature order the trained XGBoost Pipeline expects.
        # This must match model_metadata.json and the training notebook exactly.
        self.EXPECTED_FEATURES = [
            'road_type',             # categorical
            'vehicle_type',          # categorical
            'weather_condition',     # categorical
            'traffic_level',         # categorical
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
            "traffic_level": {"low", "moderate", "high", "congested"}
        }
 
        self.DEFAULTS = {
            "road_type": "highway",
            "vehicle_type": "van",
            "weather_condition": "clear",
            "traffic_level": "low"
        }

    def _haversine_distance(self, lat1, lon1, lat2, lon2):
        R = 6371.0
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat / 2)**2 +
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c
 
    def _build_adjacency_matrix(self, unvisited_stops: list) -> pd.DataFrame:
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

            matrix_data.append({
                'from_stop':             stop_from['stop_id'],
                'to_stop':               stop_to['stop_id'],
                'road_type':             road_type,
                'distance_from_prev_km': round(dist, 2),
                'stop_sequence':         stop_to.get('current_order', 1),
                'package_weight_kg':     stop_to.get('package_weight_kg', 5.0),
                'planned_travel_min':    stop_to.get('planned_travel_min', 15.0),
            })
        return pd.DataFrame(matrix_data)
 
    def _fetch_world_state(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Pulls live weather_condition and traffic_level from Redis,
        keyed by road_type. Falls back to safe defaults if Redis has no data yet.
        Note: time_bucket is NOT a model feature and is intentionally excluded.
        """
        unique_road_types = df['road_type'].unique()
        redis_keys = [f"env_state:{rt}" for rt in unique_road_types]
        raw_states = self.redis.mget(redis_keys)
 
        state_map = {}
        for rt, state_json in zip(unique_road_types, raw_states):
            if state_json:
                state_map[rt] = json.loads(state_json)
            else:
                # Safe defaults when Redis has no cached state for this road type
                state_map[rt] = {
                    'weather_condition': 'clear',
                    'traffic_level':     'low',
                }
 
        def safe_get(value, category):
            return value if value in self.VALID_CATEGORIES[category] else self.DEFAULTS[category]

        df['weather_condition'] = df['road_type'].map(lambda x: safe_get(state_map[x].get('weather_condition'), 'weather_condition'))
        df['traffic_level']     = df['road_type'].map(lambda x: safe_get(state_map[x].get('traffic_level'), 'traffic_level'))
        return df
 
    def predict_segment_delays(self, payload: dict) -> pd.DataFrame:
        """
        Main entry point called by redis_worker.py.
 
        Expects the full TrafficAlertPayload dict with this structure:
        {
            "route_id": "...",
            "vehicle_type": "van | truck | motorcycle | car",
            "environment_horizon": {
                "weather_condition": "...",
                "traffic_level": "...",
                "temperature_c": 12.5,        ← lives HERE, not at top level
                "incident_reported": true      ← lives HERE, not at top level
            },
            "unvisited_stops": [ { ...stop fields... } ]
        }
        """
        unvisited_stops = payload.get('unvisited_stops', [])
        if len(unvisited_stops) < 2:
            return pd.DataFrame()
 
        # --- FIX 1: Extract environment_horizon as its own dict ---
        # temperature_c and incident_reported are nested inside environment_horizon,
        # NOT at the top level of the payload. Extracting them correctly here.
        env = payload.get('environment_horizon', {})
        temperature_c = env.get('temperature_c', 15.0)
        # incident_reported is a boolean in the schema; convert to int (0/1) for the model
        road_incident = 1 if env.get('incident_reported', False) else 0
 
        # vehicle_type IS at the top level of the payload
        vehicle_type = payload.get('vehicle_type', 'van')
        if vehicle_type not in self.VALID_CATEGORIES['vehicle_type']:
            vehicle_type = self.DEFAULTS['vehicle_type']
 
        # 1. Build spatial connections with stop-level features
        df = self._build_adjacency_matrix(unvisited_stops)
 
        # 2. Inject live environmental variables from Redis
        #    (weather_condition and traffic_level per road_type)
        df = self._fetch_world_state(df)
 
        # 3. Inject global payload-level features as broadcast columns
        df['temperature_c'] = temperature_c
        df['road_incident']  = road_incident
        df['vehicle_type']   = vehicle_type
 
        # --- FIX 2: Use ONLY the features the trained Pipeline knows about ---
        # The original code included 'time_bucket' which was never a training feature.
        # This would cause a column error at predict() time.
        features = df[self.EXPECTED_FEATURES]
 
        # Run the XGBoost Pipeline (preprocessor + model in one call)
        df['predicted_delay_min'] = self.model.predict(features)
 
        # Pass distance through to the RouteOptimizer
        df['distance_km'] = df['distance_from_prev_km']
 
        return df[['from_stop', 'to_stop', 'distance_km', 'predicted_delay_min']]