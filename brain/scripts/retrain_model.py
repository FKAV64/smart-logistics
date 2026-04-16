import pandas as pd
import os
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder
from xgboost import XGBRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
import joblib
import json

DATA_DIR = "../data"

# 1. Load Data
df_routes = pd.read_csv(os.path.join(DATA_DIR, "routes.csv"))
df_stops = pd.read_csv(os.path.join(DATA_DIR, "route_stops.csv"))

# 2. Generate time_bucket from timestamps
df_stops['planned_arrival'] = pd.to_datetime(df_stops['planned_arrival'])
df_stops['hour'] = df_stops['planned_arrival'].dt.hour

def get_time_bucket(hour):
    if 6 <= hour < 12:
        return 'morning'
    elif 12 <= hour < 17:
        return 'midday'
    elif 17 <= hour < 21:
        return 'evening'
    else:
        return 'night'

df_stops['time_bucket'] = df_stops['hour'].apply(get_time_bucket)

# 3. Master Merge
df_master = pd.merge(
    df_stops, 
    df_routes[['route_id', 'vehicle_type', 'weather_condition', 'traffic_level', 'road_incident', 'temperature_c']], 
    on='route_id', 
    how='left'
)

# 3. Target Variable
df_clean = df_master[df_master['delay_at_stop_min'] <= 360].copy()

print(f"✅ Data Ready for ML! Training on {len(df_clean)} segments.")

# 1. Group our features (Adding time_bucket)
categorical_features = ['road_type', 'vehicle_type', 'weather_condition', 'traffic_level', 'time_bucket']
numeric_features = ['temperature_c', 'distance_from_prev_km', 'planned_travel_min', 'stop_sequence', 'package_weight_kg']
binary_features = ['road_incident'] 

# Combine numeric and binary since both just pass directly through
passthrough_features = numeric_features + binary_features
features = categorical_features + passthrough_features

X = df_clean[features]
y = df_clean['delay_at_stop_min']

# 2. Split into Training (80%) and Testing (20%)
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# 3. Lean Preprocessor (Translates text, leaves numbers alone)
preprocessor = ColumnTransformer(
    transformers=[
        ('cat', OneHotEncoder(handle_unknown='ignore'), categorical_features),
        ('pass', 'passthrough', passthrough_features)
    ]
)

# 4. Master Pipeline
ml_pipeline = Pipeline(steps=[
    ('preprocessor', preprocessor),
    ('model', XGBRegressor(
        n_estimators=150,      
        learning_rate=0.1,     
        max_depth=5,           
        random_state=42
    ))
])

print("🧠 Training XGBoost AI... (This will be fast)")

ml_pipeline.fit(X_train, y_train)
predictions = ml_pipeline.predict(X_test)

# Calculate the metrics
mae = mean_absolute_error(y_test, predictions)
rmse = np.sqrt(mean_squared_error(y_test, predictions))
r2 = r2_score(y_test, predictions)

print(f"✅ Training Complete!")
print(f"📊 Mean Absolute Error (MAE): {mae:.2f} minutes")
print(f"📊 Root Mean Squared Error (RMSE): {rmse:.2f} minutes")
print(f"📊 R² Score: {r2:.3f}")

# 5. Overwrite production files
MODEL_DIR = "../trained_models"
os.makedirs(MODEL_DIR, exist_ok=True)

MODEL_PATH = os.path.join(MODEL_DIR, "xgboost_delay_model.pkl")
joblib.dump(ml_pipeline, MODEL_PATH)
print(f"🚀 SUCCESS! Model safely overwritten directly in: {MODEL_PATH}")

metadata = {
    "target": "delay_at_stop_min",
    "expected_features": features,
    "feature_types": {
        "categorical": categorical_features,
        "numeric": numeric_features,
        "binary": passthrough_features
    }
}

META_PATH = os.path.join(MODEL_DIR, "model_metadata.json")
with open(META_PATH, "w") as f:
    json.dump(metadata, f, indent=4)
    
print(f"✅ API Metadata cleanly overwritten in: {META_PATH}")
