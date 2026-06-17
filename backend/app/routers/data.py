from fastapi import APIRouter, BackgroundTasks

from app.services.data_loader import list_parks, load_edges_geojson, load_nodes_geojson
from app.services.routing import warm_route_cache

router = APIRouter(prefix="/api", tags=["data"])

@router.get("/parks")
def parks():
    return {"parks": list_parks()}

@router.get("/nodes")
def nodes(background_tasks: BackgroundTasks, park_id: str | None = None):
    background_tasks.add_task(warm_route_cache, park_id)
    return load_nodes_geojson(park_id)

@router.get("/edges")
def edges(background_tasks: BackgroundTasks, park_id: str | None = None):
    background_tasks.add_task(warm_route_cache, park_id)
    return load_edges_geojson(park_id)
