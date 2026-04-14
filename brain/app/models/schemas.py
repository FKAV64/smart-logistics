from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime

class CurrentLocation(BaseModel):
    lat: float = Field(..., description="Current latitude of the truck")
    lon: float = Field(..., description="Current longitude of the truck")
    timestamp: datetime = Field(..., description="ISO 8601 timestamp of the GPS ping")

class EnvironmentHorizon(BaseModel):
    weather_condition: str = Field(..., description="clear, cloudy, rain, snow, fog, wind")
    road_surface_condition: str = Field(..., description="dry, wet, icy, snow_covered")
    traffic_severity: str = Field(..., description="low, moderate, high, congested")
    time_bucket: str = Field(..., description="morning_rush, midday, evening_rush, night, early_morning")
    incident_reported: bool = Field(..., description="True if a crash/roadblock is reported ahead")
    
    # NEW STRICT REQUIREMENT
    temperature_c: float = Field(..., description="Current temperature in Celsius. CRITICAL for predicting ice/snow delays.")

class Stop(BaseModel):
    stop_id: str = Field(..., description="Unique ID for the delivery stop")
    lat: float = Field(..., description="Latitude of the destination")
    lon: float = Field(..., description="Longitude of the destination")
    window_start: datetime = Field(..., description="Earliest allowed arrival time")
    window_end: datetime = Field(..., description="Latest allowed arrival time")
    current_order: int = Field(..., description="The sequence number of this stop in the route (stop_sequence)")
    road_type: str = Field(..., description="highway, rural, urban, mountain")
    
    # NEW STRICT REQUIREMENTS
    distance_from_prev_km: float = Field(..., description="Physical distance from the previous stop/current location in km")
    planned_travel_min: float = Field(..., description="TomTom/Google Maps baseline ETA in minutes without traffic")
    package_weight_kg: float = Field(..., description="Total weight of packages to be dropped off at this stop")

class TrafficAlertPayload(BaseModel):
    event_type: str = Field(..., description="Type of event, e.g., TRAFFIC_ALERT")
    route_id: str = Field(..., description="Unique ID of the route")
    courier_id: str = Field(..., description="Unique ID of the driver")
    shift_end: str = Field(..., description="Time the driver's shift ends (HH:MM:SS)")
    courier_status: str = Field(..., description="EN_ROUTE, AT_STOP, etc.")
    vehicle_type: str = Field(..., description="van, truck, motorcycle, car")
    
    current_location: CurrentLocation
    environment_horizon: EnvironmentHorizon
    unvisited_stops: List[Stop] = Field(..., min_length=1, description="List of remaining stops. Cannot be empty.")