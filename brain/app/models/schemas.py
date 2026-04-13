from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime, time

# ==========================================
# INPUT SCHEMAS (Node.js -> Python)
# ==========================================

class Location(BaseModel):
    lat: float
    lon: float
    timestamp: datetime

class Stop(BaseModel):
    stop_id: str
    lat: float
    lon: float
    window_start: datetime
    window_end: datetime
    current_order: int

class EventPayload(BaseModel):
    """The exact JSON structure Node.js must send to Redis."""
    event_type: str = Field(..., example="TRAFFIC_ALERT") # PING, ROUTINE_CHECK, or TRAFFIC_ALERT
    route_id: str
    courier_id: str
    shift_end: time
    current_location: Location
    unvisited_stops: List[Stop]
    weather_condition: str = Field(default="CLEAR")
    traffic_severity: str = Field(default="LOW")
    historical_time_mins: int = Field(default=20)

# ==========================================
# OUTPUT SCHEMAS (Python -> Node.js)
# ==========================================

class ImpactMetrics(BaseModel):
    time_saved_minutes: int
    route_health: str = Field(..., description="STABLE or FRAGILE")

class AIRecommendation(BaseModel):
    action_type: str
    severity: str = Field(..., description="critical, medium, or low")
    reason: str
    new_sequence: List[str]  # List of stop_ids in the new order
    impact: ImpactMetrics

class OptimizationResponse(BaseModel):
    """The exact JSON structure Python returns to Node.js/UI."""
    route_id: str
    status: str
    ai_recommendation: AIRecommendation