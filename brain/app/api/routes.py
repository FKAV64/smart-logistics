from fastapi import APIRouter

# Create the router (The Receptionist)
router = APIRouter()

@router.get("/health")
async def health_check():
    """A simple endpoint for AWS/Docker to test if the Brain is awake."""
    return {
        "status": "online", 
        "service": "SMART LOGISTICS: The Brain",
        "redis_listener": "active"
    }