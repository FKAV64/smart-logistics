from pydantic import BaseModel, Field
from typing import List
from datetime import datetime

class CurrentLocation(BaseModel):
    lat: float = Field(..., description="Current latitude of the truck")
    lon: float = Field(..., description="Current longitude of the truck")
    timestamp: datetime = Field(..., description="ISO 8601 timestamp of the GPS ping")

class EnvironmentHorizon(BaseModel):
    """
    Real-world conditions surrounding the route at the time of the event.
    Everything here feeds directly into the XGBoost delay prediction model.
    """
    weather_condition: str = Field(..., description="ML Feature: clear, cloudy, rain, snow, fog, wind")
    traffic_level: str     = Field(..., description="ML Feature: low, moderate, high, congested")
    time_bucket: str       = Field(..., description="ML Feature: morning, midday, evening, night")
    temperature_c: float   = Field(..., description="ML Feature: Current temperature in Celsius")
    incident_reported: bool = Field(..., description="ML Feature: True if a crash/roadblock is reported ahead (maps to road_incident=1)")
    road_type: str          = Field(default='urban', description="ML Feature: Area road classification — highway, urban, rural, mountain. Sourced from TomTom FRC.")

class Stop(BaseModel):
    """
    A single delivery stop.
    Note: distance_from_prev_km and planned_travel_min are NOT required from Node.js.
    They are computed internally by the ML engine using GPS coordinates and vehicle speed profiles.
    """
    stop_id: str          = Field(..., description="Unique ID for the delivery stop")
    lat: float            = Field(..., description="Latitude of the destination")
    lon: float            = Field(..., description="Longitude of the destination")
    window_start: datetime = Field(..., description="Earliest allowed arrival time (ISO 8601)")
    window_end: datetime  = Field(..., description="Latest allowed arrival time (ISO 8601)")
    current_order: int    = Field(..., description="ML Feature: stop_sequence — position of this stop in the route")
    road_type: str        = Field(..., description="ML Feature: highway, rural, urban, mountain")
    package_weight_kg: float = Field(..., description="ML Feature: Total weight of packages at this stop")

class TrafficAlertPayload(BaseModel):
    """
    The full incoming payload contract from Node.js.
    This is validated by the Redis Worker before any ML computation begins.
    """
    event_type: str      = Field(..., description="ROUTINE_HEALTH_CHECK or TRAFFIC_ALERT")
    manifest_id: str     = Field(..., description="Unique ID of the manifest being optimized")
    courier_id: str      = Field(..., description="Unique ID of the driver")
    courier_status: str  = Field(..., description="Driver's current status: EN_ROUTE or AT_STOP")
    vehicle_type: str    = Field(..., description="ML Feature: van, truck, motorcycle, car")

    current_location: CurrentLocation
    environment_horizon: EnvironmentHorizon
    unvisited_stops: List[Stop] = Field(..., min_length=1, description="List of remaining stops. Cannot be empty.")