import os
import pandas as pd
import joblib

# The path where your model will eventually live
MODEL_PATH = "trained_models/xgboost_delay_model.pkl"

def predict_route_delay(historical_time: int, weather_condition: str, traffic_severity: str) -> int:
    """
    Predicts the expected delay (in minutes) for a route.
    Uses the trained XGBoost model if available, otherwise falls back to heuristics.
    """
    
    # STEP 1: The Failsafe (For Local Testing / Hackathon MVP)
    if not os.path.exists(MODEL_PATH):
        print("⚠️ Warning: No trained ML model found. Using Failsafe Heuristics.")
        
        # Simple heuristic fallback for testing
        base_delay = 5
        if traffic_severity == "HIGH":
            base_delay += 15
        if weather_condition == "RAIN":
            base_delay += 10
            
        return base_delay

    # STEP 2: The Actual Machine Learning Inference
    try:
        # Load the trained model from disk
        model = joblib.load(MODEL_PATH)
        
        # In scikit-learn/XGBoost, we usually need to convert categorical strings to numbers.
        # Assuming your training pipeline handles encoding, we build a quick DataFrame:
        features = {
            "historical_time_mins": [historical_time],
            # For a real model, 'RAIN' might be 1, 'CLEAR' might be 0
            "weather_encoded": [1 if weather_condition == "RAIN" else 0],
            "traffic_encoded": [2 if traffic_severity == "HIGH" else 1]
        }
        
        df = pd.DataFrame(features)
        
        # Make the prediction
        prediction = model.predict(df)
        
        # Return the expected delay as an integer
        expected_delay_minutes = int(prediction[0])
        print(f"🧠 ML Engine Predicted Delay: {expected_delay_minutes} minutes.")
        
        return expected_delay_minutes

    except Exception as e:
        print(f"❌ ML Engine Error: {e}")
        # Ultimate Failsafe if scikit-learn crashes during presentation
        return 20