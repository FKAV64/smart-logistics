import pandas as pd
import os
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder
from sklearn.metrics import (mean_absolute_error, mean_squared_error, r2_score,
                             roc_auc_score, classification_report)
from xgboost import XGBRegressor, XGBClassifier
import joblib
import json

DATA_DIR = "../data"
MODEL_DIR = "../trained_models"
DELAY_THRESHOLD_MIN = 10

# 1. Load Data
df_routes = pd.read_csv(os.path.join(DATA_DIR, "routes.csv"))
df_stops  = pd.read_csv(os.path.join(DATA_DIR, "route_stops.csv"))

# 2. Generate time_bucket (5 buckets aligned with Sivas logistics peaks)
df_stops['planned_arrival'] = pd.to_datetime(df_stops['planned_arrival'])
df_stops['hour'] = df_stops['planned_arrival'].dt.hour

def assign_time_bucket(hour):
    if 7 <= hour < 10:           return 'morning_rush'
    if 10 <= hour < 17:          return 'midday'
    if 17 <= hour < 20:          return 'evening_rush'
    if hour >= 20 or hour < 5:   return 'night'
    return 'early_morning'

df_stops['time_bucket'] = df_stops['hour'].apply(assign_time_bucket)

# 3. Master Merge
df_master = pd.merge(
    df_stops,
    df_routes[['route_id', 'vehicle_type', 'weather_condition', 'traffic_level',
               'road_incident', 'temperature_c']],
    on='route_id',
    how='left'
)

# 4. Clean + add binary delay target
df_clean = df_master[df_master['delay_at_stop_min'] <= 360].copy()
df_clean['delay_binary'] = (df_clean['delay_at_stop_min'] > DELAY_THRESHOLD_MIN).astype(int)

print(f"[OK] Data ready: {len(df_clean)} segments | "
      f"delay rate: {df_clean['delay_binary'].mean():.1%}")

# 5. Feature groups (unchanged from original)
categorical_features  = ['road_type', 'vehicle_type', 'weather_condition', 'traffic_level', 'time_bucket']
numeric_features      = ['temperature_c', 'distance_from_prev_km', 'planned_travel_min', 'stop_sequence', 'package_weight_kg']
binary_features       = ['road_incident']
passthrough_features  = numeric_features + binary_features
features              = categorical_features + passthrough_features

X = df_clean[features]
y_reg = df_clean['delay_at_stop_min']
y_clf = df_clean['delay_binary']

X_train, X_test, y_reg_train, y_reg_test, y_clf_train, y_clf_test = train_test_split(
    X, y_reg, y_clf, test_size=0.2, random_state=42
)

# 6. Shared preprocessor
preprocessor = ColumnTransformer(transformers=[
    ('cat',  OneHotEncoder(handle_unknown='ignore'), categorical_features),
    ('pass', 'passthrough',                          passthrough_features)
])

# -- Regressor --
reg_pipeline = Pipeline(steps=[
    ('preprocessor', preprocessor),
    ('model', XGBRegressor(n_estimators=150, learning_rate=0.1, max_depth=5,
                           objective='reg:squarederror', random_state=42))
])

print("Training XGBoost Regressor (delay minutes)...")
reg_pipeline.fit(X_train, y_reg_train)
reg_preds = reg_pipeline.predict(X_test)

mae  = mean_absolute_error(y_reg_test, reg_preds)
rmse = np.sqrt(mean_squared_error(y_reg_test, reg_preds))
r2   = r2_score(y_reg_test, reg_preds)
print(f"   MAE: {mae:.2f} min | RMSE: {rmse:.2f} min | R2: {r2:.3f}")

# -- Classifier --
clf_pipeline = Pipeline(steps=[
    ('preprocessor', preprocessor),
    ('model', XGBClassifier(n_estimators=150, learning_rate=0.1, max_depth=5,
                            objective='binary:logistic', eval_metric='logloss',
                            random_state=42))
])

print("Training XGBoost Classifier (delay probability)...")
clf_pipeline.fit(X_train, y_clf_train)
clf_probs = clf_pipeline.predict_proba(X_test)[:, 1]
clf_preds = (clf_probs >= 0.5).astype(int)

auc = roc_auc_score(y_clf_test, clf_probs)
print(f"   AUC-ROC: {auc:.3f}")
print(classification_report(y_clf_test, clf_preds, target_names=['on_time', 'delayed']))

# 7. Save both models
os.makedirs(MODEL_DIR, exist_ok=True)

REG_PATH = os.path.join(MODEL_DIR, "xgboost_delay_model.pkl")
CLF_PATH = os.path.join(MODEL_DIR, "xgboost_prob_model.pkl")

joblib.dump(reg_pipeline, REG_PATH)
print(f"[OK] Regressor saved -> {REG_PATH}")

joblib.dump(clf_pipeline, CLF_PATH)
print(f"[OK] Classifier saved -> {CLF_PATH}")

# 8. Update metadata
metadata = {
    "delay_threshold_min": DELAY_THRESHOLD_MIN,
    "time_buckets": ["early_morning", "morning_rush", "midday", "evening_rush", "night"],
    "target_regressor": "delay_at_stop_min",
    "target_classifier": "delay_binary (1 if delay > threshold)",
    "expected_features": features,
    "feature_types": {
        "categorical": categorical_features,
        "numeric": numeric_features,
        "binary": binary_features
    },
    "metrics": {
        "regressor": {"MAE": round(mae, 3), "RMSE": round(rmse, 3), "R2": round(r2, 3)},
        "classifier": {"AUC_ROC": round(auc, 3)}
    }
}

META_PATH = os.path.join(MODEL_DIR, "model_metadata.json")
with open(META_PATH, "w") as f:
    json.dump(metadata, f, indent=4)

print(f"[OK] Metadata updated -> {META_PATH}")
print("[DONE] Both models ready for deployment.")
