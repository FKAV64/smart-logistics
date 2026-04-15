import math
import itertools
import json
import pandas as pd
import joblib
import redis

class MLEngine:
    def __init__(self, redis_client=None):
        # Load your trained XGBoost Pipeline into memory
        self.model = joblib.load('trained_models/xgboost_delay_model.pkl')
        self.redis = redis_client or redis.Redis(host='localhost', port=6379, decode_responses=True)

    def _haversine_distance(self, lat1, lon1, lat2, lon2):
        """Calculates spatial distance between two GPS coordinates in kilometers."""
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
                'distance_km': round(dist, 2)
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

    def predict_segment_delays(self, unvisited_stops: list) -> pd.DataFrame:
        if len(unvisited_stops) < 2:
            return pd.DataFrame()
            
        df = self._build_adjacency_matrix(unvisited_stops)
        df = self._fetch_world_state(df)
        
        # The Pipeline expects the exact columns it was trained on.
        # We pass the raw text data; the Pipeline handles the encoding natively.
        features = df[['road_type', 'weather_condition', 'traffic_level', 'time_bucket', 'distance_km']]
        
        # model.predict() directly outputs the delay in minutes
        df['predicted_delay_min'] = self.model.predict(features)
        
        return df[['from_stop', 'to_stop', 'distance_km', 'predicted_delay_min']]