from __future__ import annotations

import json
import pickle
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.config import DATA_DIR

DEFAULT_PARK_ID = "central_park"
PARK_DATA_DIRS = {
    "central_park": DATA_DIR,
    "prospect_park": DATA_DIR.parent / "prospect_park_app_data",
}
PARK_NAMES = {
    "central_park": "Central Park",
    "prospect_park": "Prospect Park",
}


def normalize_park_id(park_id: str | None = None) -> str:
    text = (park_id or DEFAULT_PARK_ID).strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "central": "central_park",
        "centralpark": "central_park",
        "central_park": "central_park",
        "prospect": "prospect_park",
        "prospectpark": "prospect_park",
        "prospect_park": "prospect_park",
    }
    normalized = aliases.get(text, text)
    if normalized not in PARK_DATA_DIRS:
        raise ValueError(f"Unsupported park_id '{park_id}'.")
    return normalized


def get_park_data_dir(park_id: str | None = None) -> Path:
    return PARK_DATA_DIRS[normalize_park_id(park_id)]


def get_park_name(park_id: str | None = None) -> str:
    return PARK_NAMES.get(normalize_park_id(park_id), "NYC Park")


def list_parks() -> list[dict[str, Any]]:
    rows = []
    for park_id, data_dir in PARK_DATA_DIRS.items():
        manifest = load_manifest(park_id)
        rows.append(
            {
                "park_id": park_id,
                "name": str(manifest.get("park") or PARK_NAMES.get(park_id) or park_id),
                "available": data_dir.exists() and any(data_dir.glob("*.geojson")),
                "data_dir": str(data_dir),
                "center": manifest.get("center"),
                "bounds": manifest.get("bounds"),
            }
        )
    return rows


def _nodes_candidates(park_id: str | None = None) -> list[Path]:
    data_dir = get_park_data_dir(park_id)
    return [
        data_dir / "final_candidate_nodes_gridcoded.geojson",
        data_dir / "final_candidate_nodes.geojson",
    ]


def _edges_candidates(park_id: str | None = None) -> list[Path]:
    data_dir = get_park_data_dir(park_id)
    return [
        data_dir / "augmented_graph_edges.geojson",
        data_dir / "graph_edges.geojson",
    ]


def _graph_path(park_id: str | None = None) -> Path:
    return get_park_data_dir(park_id) / "park_graph.pkl"


def _manifest_path(park_id: str | None = None) -> Path:
    return get_park_data_dir(park_id) / "app_manifest.json"


def _load_first_json(paths: list[Path]) -> dict[str, Any]:
    for path in paths:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    return {"type": "FeatureCollection", "features": []}


@lru_cache(maxsize=8)
def load_nodes_geojson(park_id: str | None = None) -> dict[str, Any]:
    return _load_first_json(_nodes_candidates(park_id))


@lru_cache(maxsize=8)
def load_edges_geojson(park_id: str | None = None) -> dict[str, Any]:
    return _load_first_json(_edges_candidates(park_id))


@lru_cache(maxsize=8)
def load_manifest(park_id: str | None = None) -> dict[str, Any]:
    manifest_path = _manifest_path(park_id)
    if manifest_path.exists():
        try:
            return json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


@lru_cache(maxsize=8)
def load_graph(park_id: str | None = None):
    graph_path = _graph_path(park_id)
    if not graph_path.exists():
        return None
    try:
        with open(graph_path, "rb") as f:
            return pickle.load(f)
    except Exception:
        return None


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_category(raw: Any) -> str:
    text = _safe_str(raw).lower()
    if "restroom" in text or "toilet" in text or "bathroom" in text:
        return "restroom"
    if "water" in text or "drink" in text:
        return "water"
    if "food" in text or "cafe" in text or "restaurant" in text:
        return "food"
    if "info" in text or "visitor" in text or "landmark" in text or "tourism" in text:
        return "info"
    if "first" in text or "aid" in text or "emergency" in text:
        return "first_aid"
    if "shelter" in text:
        return "shelter"
    if "picnic" in text:
        return "picnic"
    if "recreation" in text or "playground" in text or "sports" in text or "leisure" in text:
        return "recreation"
    if "entrance" in text or "gate" in text or "exit" in text:
        return "entrance"
    if "other" in text:
        return "other"
    return "core"


def build_search_text(properties: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in [
        "display_name",
        "infra_name",
        "name",
        "amenity",
        "leisure",
        "barrier",
        "entrance",
        "tourism",
        "operator",
        "brand",
        "description",
        "notes",
        "node_type",
        "node_subtype",
        "infra_type",
        "infra_class",
    ]:
        value = _safe_str(properties.get(key))
        if value:
            parts.append(value.lower())
    return " | ".join(parts)


def feature_to_candidate(feature: dict[str, Any]) -> dict[str, Any]:
    props = feature.get("properties", {})
    lon, lat = feature.get("geometry", {}).get("coordinates", [None, None])[:2]
    category = normalize_category(
        props.get("infra_class")
        or props.get("infra_type")
        or props.get("node_subtype")
        or props.get("node_type")
        or props.get("display_group")
        or props.get("amenity")
        or props.get("leisure")
        or props.get("tourism")
        or props.get("barrier")
        or props.get("entrance")
    )
    label = (
        _safe_str(props.get("display_name"))
        or _safe_str(props.get("infra_name"))
        or _safe_str(props.get("name"))
        or _safe_str(props.get("grid_node_code"))
        or _safe_str(props.get("node_id"))
        or "Node"
    )
    description = (
        _safe_str(props.get("notes"))
        or _safe_str(props.get("description"))
        or _safe_str(props.get("infra_type"))
        or _safe_str(props.get("node_type"))
        or ""
    )
    return {
        "node_id": _safe_str(props.get("node_id") or props.get("grid_node_code") or label),
        "label": label,
        "code": _safe_str(props.get("grid_node_code")) or None,
        "category": category,
        "description": description or None,
        "lat": float(lat) if lat is not None else None,
        "lon": float(lon) if lon is not None else None,
        "search_text": build_search_text(props),
    }


@lru_cache(maxsize=8)
def load_poi_candidates(park_id: str | None = None) -> list[dict[str, Any]]:
    normalized_park_id = normalize_park_id(park_id)
    results: list[dict[str, Any]] = []
    for feature in load_nodes_geojson(normalized_park_id).get("features", []):
        try:
            candidate = feature_to_candidate(feature)
            if candidate["lat"] is not None and candidate["lon"] is not None:
                candidate["park_id"] = normalized_park_id
                results.append(candidate)
        except Exception:
            continue
    return results


def find_node_by_id(node_id: str, park_id: str | None = None) -> dict[str, Any] | None:
    if not node_id:
        return None
    target = str(node_id)
    for feature in load_nodes_geojson(park_id).get("features", []):
        props = feature.get("properties", {})
        if str(props.get("node_id", "")) == target:
            return feature
        if str(props.get("grid_node_code", "")) == target:
            return feature
    return None


def get_node_index(park_id: str | None = None) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for feature in load_nodes_geojson(park_id).get("features", []):
        props = feature.get("properties", {})
        for key in [props.get("node_id"), props.get("grid_node_code")]:
            if key is not None:
                out[str(key)] = feature
    return out
