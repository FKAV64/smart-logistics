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

    def _haversine_distance(self, lat1, lon1, lat2, lon2):
        R = 6371.0
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat / 2)**2 + 
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c

    def _build_adjacency_matrix(self, unvisited_stops: list) -> pd.DataFrame:
        matrix_data = []
        for stop_from, stop_to in itertools.permutations(unvisited_stops, 2):
            dist = self._haversine_distance(
                stop_from['lat'], stop_from['lon'],
                stop_to['lat'], stop_to['lon']
            )
            matrix_data.append({
                'from_stop': stop_from['stop_id'],
                'to_stop': stop_to['stop_id'],
                'road_type': stop_to.get('road_type', 'highway'),
                # The ML Model expects this specific column name
                'distance_from_prev_km': round(dist, 2),
                
                # Stop-level features expected by the model (with safe defaults)
                'stop_sequence': stop_to.get('current_order', 1),
                'package_weight_kg': stop_to.get('package_weight_kg', 5.0),
                'planned_travel_min': stop_to.get('planned_travel_min', 15.0)
            })
        return pd.DataFrame(matrix_data)

    def _fetch_world_state(self, df: pd.DataFrame) -> pd.DataFrame:
        unique_road_types = df['road_type'].unique()
        redis_keys = [f"env_state:{rt}" for rt in unique_road_types]
        raw_states = self.redis.mget(redis_keys)
        
        state_map = {}
        for rt, state_json in zip(unique_road_types, raw_states):
            if state_json:
                state_map[rt] = json.loads(state_json)
            else:
                state_map[rt] = {'weather_condition': 'clear', 'traffic_level': 'low', 'time_bucket': 'midday'}

        df['weather_condition'] = df['road_type'].map(lambda x: state_map[x]['weather_condition'])
        df['traffic_level'] = df['road_type'].map(lambda x: state_map[x]['traffic_level'])
        df['time_bucket'] = df['road_type'].map(lambda x: state_map[x]['time_bucket'])
        return df

    def predict_segment_delays(self, payload: dict) -> pd.DataFrame:
        unvisited_stops = payload.get('unvisited_stops', [])
        if len(unvisited_stops) < 2:
            return pd.DataFrame()
            
        # 1. Build spatial connections with stop-level features
        df = self._build_adjacency_matrix(unvisited_stops)
        
        # 2. Inject live environmental variables
        df = self._fetch_world_state(df)
        
        # 3. Inject global payload features expected by the model
        df['temperature_c'] = payload.get('temperature_c', 15.0)
        df['road_incident'] = payload.get('road_incident', 0)
        df['vehicle_type'] = payload.get('vehicle_type', 'van')
        
        # 4. Filter strictly to the features the Pipeline requires, in the order it likely expects them
        expected_features = [
            'road_type', 'weather_condition', 'traffic_level', 'time_bucket', 
            'distance_from_prev_km', 'stop_sequence', 'package_weight_kg', 
            'temperature_c', 'planned_travel_min', 'road_incident', 'vehicle_type'
        ]
        
        features = df[expected_features]
        
        # predict() directly outputs the delay in minutes
        df['predicted_delay_min'] = self.model.predict(features)
        
        # We also pass distance_from_prev_km to the optimizer
        df['distance_km'] = df['distance_from_prev_km'] 
        
        return df[['from_stop', 'to_stop', 'distance_km', 'predicted_delay_min']]