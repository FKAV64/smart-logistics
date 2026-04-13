from fastapi import FastAPI
from app.api.routes import router as api_router

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
    print("📡 Ready to receive telemetry via Redis.")