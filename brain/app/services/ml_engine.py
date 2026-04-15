import math
import itertools
import json
import pandas as pd
import joblib
import redis

class MLEngine:
    def __init__(self, redis_client=None):
        # Load your trained XGBoost model into memory on startup
        self.model = joblib.load('trained_models/xgboost_delay_model.pkl')
        
        # Initialize Redis connection (Fallback to localhost if not provided by main.py)
        self.redis = redis_client or redis.Redis(host='localhost', port=6379, decode_responses=True)

    def _haversine_distance(self, lat1, lon1, lat2, lon2):
        """Calculates spatial distance between two GPS coordinates in kilometers."""
        R = 6371.0 # Earth radius in kilometers
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat / 2)**2 + 
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c

    def _build_adjacency_matrix(self, unvisited_stops: list) -> pd.DataFrame:
        """Generates all N x (N-1) connections between remaining stops."""
        matrix_data = []
        
        for stop_from, stop_to in itertools.permutations(unvisited_stops, 2):
            dist = self._haversine_distance(
                stop_from['lat'], stop_from['lon'],
                stop_to['lat'], stop_to['lon']
            )
            matrix_data.append({
                'from_stop': stop_from['stop_id'],
                'to_stop': stop_to['stop_id'],
                'road_type': stop_to.get('road_type', 'highway'), # Default to highway if missing
                'distance_km': round(dist, 2)
            })
            
        return pd.DataFrame(matrix_data)

    def _fetch_world_state(self, df: pd.DataFrame) -> pd.DataFrame:
        """Fetches live weather and traffic from Redis memory with zero database lag."""
        unique_road_types = df['road_type'].unique()
        
        # Build keys based on the structure Node.js pushes to Redis
        redis_keys = [f"env_state:{rt}" for rt in unique_road_types]
        
        # MGET is atomic and fetches all keys in a single network trip
        raw_states = self.redis.mget(redis_keys)
        
        state_map = {}
        for rt, state_json in zip(unique_road_types, raw_states):
            if state_json:
                state_map[rt] = json.loads(state_json)
            else:
                # Fallback safeguard if Node.js hasn't populated Redis yet
                state_map[rt] = {
                    'weather_condition': 'clear', 
                    'traffic_level': 'low', 
                    'time_bucket': 'midday'
                }

        # Map the live Redis data back into our Pandas DataFrame
        df['weather_condition'] = df['road_type'].map(lambda x: state_map[x]['weather_condition'])
        df['traffic_level'] = df['road_type'].map(lambda x: state_map[x]['traffic_level'])
        df['time_bucket'] = df['road_type'].map(lambda x: state_map[x]['time_bucket'])
        
        return df

    def predict_segment_delays(self, unvisited_stops: list) -> pd.DataFrame:
        """The main entry point. Returns a scored matrix of delay probabilities."""
        if len(unvisited_stops) < 2:
            return pd.DataFrame() # No routing optimization needed for 1 stop
            
        # 1. Build spatial connections
        df = self._build_adjacency_matrix(unvisited_stops)
        
        # 2. Inject live environmental variables
        df = self._fetch_world_state(df)
        
        # 3. Prepare feature matrix for XGBoost
        # Note: XGBoost requires one-hot encoding for categorical string variables.
        features = pd.get_dummies(df[['road_type', 'weather_condition', 'traffic_level', 'time_bucket', 'distance_km']])
        
        # Critical Safety Step: Ensure the DataFrame columns exactly match what the model trained on
        # Missing categories (e.g., if there's no 'snow' right now) are filled with 0s
        if hasattr(self.model, 'feature_names_in_'):
            expected_cols = self.model.feature_names_in_
            features = features.reindex(columns=expected_cols, fill_value=0)

        # 4. Execute the batch prediction
        # predict_proba returns [Probability_of_0, Probability_of_1]. We want index 1 (Delay).
        df['delay_probability'] = self.model.predict_proba(features)[:, 1]
        
        # Return cleanly formatted Scored Matrix for the routing optimizer
        return df[['from_stop', 'to_stop', 'distance_km', 'delay_probability']]