from fastapi import APIRouter, Request
from datetime import datetime

from app.models.schemas import TrafficAlertPayload

router = APIRouter()


@router.get("/api/health")
async def health_check():
    return {
        "status":         "online",
        "service":        "SMART LOGISTICS: The Brain",
        "redis_listener": "active"
    }


@router.post("/api/optimize")
async def optimize_route(payload: TrafficAlertPayload, request: Request):
    """
    Direct REST endpoint for hackathon demos and Postman testing.
    Accepts a TrafficAlertPayload JSON, runs the full AI pipeline, and returns
    the optimized stop sequence plus per-stop delay probabilities.
    """
    ml_engine      = request.app.state.ml_engine
    route_optimizer = request.app.state.route_optimizer
    map_engine     = request.app.state.map_engine

    stops      = [s.dict() for s in payload.unvisited_stops]
    payload_dict = payload.dict()

    stop_probs   = ml_engine.predict_stop_probabilities(stops, payload_dict, map_engine.get_graph())
    scored_graph = ml_engine.predict_segment_delays(payload_dict, map_engine.get_graph())
    result       = route_optimizer.optimize_route(
        stops,
        scored_graph,
        datetime.utcnow().isoformat() + "Z"
    )

    return {
        "manifest_id":              payload.manifest_id,
        "courier_id":               payload.courier_id,
        "stop_delay_probabilities": stop_probs,
        "result":                   result
    }
