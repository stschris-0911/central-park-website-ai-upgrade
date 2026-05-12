from fastapi import APIRouter, HTTPException

from app.models import RouteRequest, RouteResponse
from app.services.routing import compute_route

router = APIRouter(prefix="/api", tags=["route"])

@router.post("/route", response_model=RouteResponse)
def route(request: RouteRequest):
    try:
        return compute_route(
            start_node_id=request.start_node_id,
            end_node_id=request.end_node_id,
            start_point=request.start_point,
            end_point=request.end_point,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Route computation failed: {exc}") from exc
