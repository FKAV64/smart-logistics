import os
import pandas as pd
import joblib

MODEL_PATH = "trained_models/xgboost_delay_model.pkl"

def predict_segment_delay(
    road_type: str, 
    vehicle_type: str, 
    env: dict
) -> dict:
    """
    Predicts the probability and magnitude of delay for a single road segment.
    Returns: { probability_pct, estimated_delay_mins, expected_delay_mins }
    """
    
    # Extract environmental variables
    weather = env.get("weather_condition", "clear")
    surface = env.get("road_surface_condition", "dry")
    traffic = env.get("traffic_severity", "low")
    incident = env.get("incident_reported", False)

    # STEP 1: The Failsafe (For Local Testing / Hackathon MVP)
    if not os.path.exists(MODEL_PATH):
        # Baseline: 5% chance of a 2-minute delay
        base_prob = 0.05
        base_delay = 2.0

        # Heuristic adjustments based on Hackathon CSV insights
        if traffic in ["high", "congested"]:
            base_prob += 0.40
            base_delay += 10.0
        if weather in ["rain", "snow"]:
            base_prob += 0.25
            base_delay += 8.0
        if surface in ["icy", "snow_covered"]:
            base_prob += 0.20
            base_delay += 12.0
        if incident:
            base_prob += 0.50
            base_delay += 25.0
        
        # Heavy vehicles suffer more on bad mountain roads
        if road_type == "mountain" and vehicle_type in ["truck", "van"]:
            if weather != "clear" or surface != "dry":
                base_prob += 0.30
                base_delay += 15.0

        # Cap probability at 99%
        final_prob = min(0.99, base_prob)
        # E = P * D
        expected_delay = final_prob * base_delay

        return {
            "probability_pct": round(final_prob * 100, 1),
            "estimated_delay_mins": round(base_delay, 1),
            "expected_delay_mins": round(expected_delay, 1)
        }

    # STEP 2: The Actual Machine Learning Inference
    try:
        model = joblib.load(MODEL_PATH)
        
        # (TODO: Map these text values to the integer encodings your pipeline uses)
        features = pd.DataFrame([{
            "road_type": road_type,
            "vehicle_type": vehicle_type,
            "weather": weather,
            "traffic": traffic,
            "incident": int(incident)
        }])
        
        # In a real scikit-learn pipeline, you'd use predict_proba() for probability
        # and predict() for the magnitude. We will mock the extraction here:
        delay_magnitude = model.predict(features)[0]
        delay_probability = 0.85 # Mocked probability until model supports predict_proba
        
        expected_delay = delay_probability * delay_magnitude

        return {
            "probability_pct": round(delay_probability * 100, 1),
            "estimated_delay_mins": round(delay_magnitude, 1),
            "expected_delay_mins": round(expected_delay, 1)
        }

    except Exception as e:
        print(f"❌ ML Engine Error on Segment: {e}")
        return {"probability_pct": 100.0, "estimated_delay_mins": 20.0, "expected_delay_mins": 20.0}