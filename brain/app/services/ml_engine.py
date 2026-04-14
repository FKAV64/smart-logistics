import joblib
import os
import pandas as pd

# ==========================================
# 1. LOAD THE BRAIN (ON STARTUP)
# ==========================================
# Loaded OUTSIDE the function so it only hits the hard drive once when the server boots.
MODEL_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../trained_models/xgboost_delay_model.pkl"))

try:
    ml_pipeline = joblib.load(MODEL_PATH)
    print(f"🧠 SUCCESS: Elite XGBoost Model loaded from {MODEL_PATH}")
except Exception as e:
    print(f"⚠️ CRITICAL: Could not load ML model. Did you run the Jupyter Notebook? Error: {e}")
    ml_pipeline = None

# ==========================================
# 2. THE PREDICTION ENGINE
# ==========================================
def predict_segment_delay(stop, payload) -> float:
    """
    Takes the STRICTLY VALIDATED Pydantic objects from FastAPI, 
    maps them to the exact column names the AI expects, and predicts the delay.
    """
    if ml_pipeline is None:
        return 0.0  # Safe fallback if AI file is missing
    
    # 1. Extract the exact 10 features the Elite Model requires
    # Notice there is ZERO fallback math here. We trust the Pydantic schema completely.
    model_input = {
        'road_type': stop.road_type,
        'vehicle_type': payload.vehicle_type,
        'weather_condition': payload.environment_horizon.weather_condition,
        'traffic_level': payload.environment_horizon.traffic_severity,
        'road_incident': 1 if payload.environment_horizon.incident_reported else 0,
        
        # The Critical Numeric Features
        'temperature_c': payload.environment_horizon.temperature_c,
        'distance_from_prev_km': stop.distance_from_prev_km,
        'planned_travel_min': stop.planned_travel_min,
        'stop_sequence': stop.current_order,
        'package_weight_kg': stop.package_weight_kg
    }
    
    # 2. Convert to a Pandas DataFrame (which XGBoost requires)
    df_features = pd.DataFrame([model_input])
    
    # 3. Ask the AI to do the math
    try:
        delay_prediction = ml_pipeline.predict(df_features)[0]
        
        # The AI might predict a negative number (early arrival). 
        # For our lateness penalty calculations, we floor it at 0.
        return max(0.0, float(delay_prediction))
        
    except Exception as e:
        print(f"❌ AI Prediction Failed: {e}")
        return 0.0