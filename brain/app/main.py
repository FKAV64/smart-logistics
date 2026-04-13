import threading
from fastapi import FastAPI
from app.api.routes import router as api_router
from app.services.redis_worker import start_redis_listener

# 1. Initialize the FastAPI app (Protected behind Node.js API Gateway)
app = FastAPI(
    title="SMART LOGISTICS: The Brain",
    description="Real-time route optimization and ML delay prediction engine.",
    version="1.0.0"
)

# 2. Register the API Routes (Health checks only)
app.include_router(api_router, prefix="/api")

@app.on_event("startup")
async def startup_event():
    print("🚀 The Brain is powering up...")
    
    # 3. Start the Redis Listener on a separate background thread
    # daemon=True means this thread will automatically die when the main server shuts down
    listener_thread = threading.Thread(target=start_redis_listener, daemon=True)
    listener_thread.start()
    
    print("✅ Background Redis listener thread initialized.")