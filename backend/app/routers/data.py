from fastapi import APIRouter

from app.services.data_loader import list_parks, load_edges_geojson, load_nodes_geojson

router = APIRouter(prefix="/api", tags=["data"])

@router.get("/parks")
def parks():
    return {"parks": list_parks()}

@router.get("/nodes")
def nodes(park_id: str | None = None):
    return load_nodes_geojson(park_id)

@router.get("/edges")
def edges(park_id: str | None = None):
    return load_edges_geojson(park_id)
