from pydantic import BaseModel, Field
from typing import List
from datetime import time

class Location(BaseModel):
    lat: float
    lon: float
    timestamp: str

class Stop(BaseModel):
    stop_id: str
    lat: float
    lon: float
    window_start: str
    window_end: str
    current_order: int
    # Specific to the segment leading to this stop
    road_type: str = Field(default="urban") 

class EnvironmentHorizon(BaseModel):
    """The 45-minute forecast provided by Node.js"""
    weather_condition: str = Field(default="clear")
    road_surface_condition: str = Field(default="dry")
    traffic_severity: str = Field(default="low")
    time_bucket: str = Field(default="midday")
    incident_reported: bool = Field(default=False)

class EventPayload(BaseModel):
    """The exact JSON structure Node.js must send to Redis."""
    event_type: str = Field(..., example="TRAFFIC_ALERT")
    route_id: str
    courier_id: str
    shift_end: time
    courier_status: str = Field(..., example="EN_ROUTE") # EN_ROUTE or AT_STOP
    vehicle_type: str = Field(..., example="van")        # van, truck, motorcycle, car
    current_location: Location
    environment_horizon: EnvironmentHorizon
    unvisited_stops: List[Stop]

# --- OUTPUT SCHEMAS ---
class Impact(BaseModel):
    time_saved_minutes: int
    route_health: str

class ActionPlan(BaseModel):
    action_type: str # CONTINUE, DELAY_DEPARTURE, RE-ROUTE, REQUEST_ALTERNATE_PATH
    severity: str
    reason: str
    new_sequence: List[str]
    impact: Impact

class FinalResponse(BaseModel):
    route_id: str
    status: str
    ai_recommendation: ActionPlan