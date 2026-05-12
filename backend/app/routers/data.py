from fastapi import APIRouter

from app.services.data_loader import load_edges_geojson, load_nodes_geojson

router = APIRouter(prefix="/api", tags=["data"])

@router.get("/nodes")
def nodes():
    return load_nodes_geojson()

@router.get("/edges")
def edges():
    return load_edges_geojson()
