import threading
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from app.api.routes import router as api_router
from app.services.redis_worker import start_redis_listener
from app.services.map_seeder import seed_map_if_empty
from app.services.map_engine import MapEngine
from app.services.ml_engine import MLEngine
from app.services.routing import RouteOptimizer

app = FastAPI(
    title="SMART LOGISTICS: The Brain",
    description="Real-time route optimization and ML delay prediction engine.",
    version="1.0.0"
)

app.include_router(api_router)

@app.on_event("startup")
async def startup_event():
    print("The Brain is powering up...")

    seed_map_if_empty()
    app.state.map_engine      = MapEngine()
    app.state.ml_engine       = MLEngine()
    app.state.route_optimizer = RouteOptimizer(app.state.map_engine)

    listener_thread = threading.Thread(target=start_redis_listener, daemon=True)
    listener_thread.start()

    print("Background Redis listener thread initialized.")
