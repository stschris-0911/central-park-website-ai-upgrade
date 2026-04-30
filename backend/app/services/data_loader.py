from __future__ import annotations

import json
import pickle
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.config import DATA_DIR

NODES_CANDIDATES = [
    DATA_DIR / "final_candidate_nodes_gridcoded.geojson",
    DATA_DIR / "final_candidate_nodes.geojson",
]
EDGES_CANDIDATES = [
    DATA_DIR / "augmented_graph_edges.geojson",
    DATA_DIR / "graph_edges.geojson",
]
GRAPH_PATH = DATA_DIR / "park_graph.pkl"
MANIFEST_PATH = DATA_DIR / "app_manifest.json"


def _load_first_json(paths: list[Path]) -> dict[str, Any]:
    for path in paths:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    return {"type": "FeatureCollection", "features": []}


@lru_cache(maxsize=1)
def load_nodes_geojson() -> dict[str, Any]:
    return _load_first_json(NODES_CANDIDATES)


@lru_cache(maxsize=1)
def load_edges_geojson() -> dict[str, Any]:
    return _load_first_json(EDGES_CANDIDATES)


@lru_cache(maxsize=1)
def load_manifest() -> dict[str, Any]:
    if MANIFEST_PATH.exists():
        try:
            return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


@lru_cache(maxsize=1)
def load_graph():
    if not GRAPH_PATH.exists():
        return None
    try:
        with open(GRAPH_PATH, "rb") as f:
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


@lru_cache(maxsize=1)
def load_poi_candidates() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for feature in load_nodes_geojson().get("features", []):
        try:
            candidate = feature_to_candidate(feature)
            if candidate["lat"] is not None and candidate["lon"] is not None:
                results.append(candidate)
        except Exception:
            continue
    return results


def find_node_by_id(node_id: str) -> dict[str, Any] | None:
    if not node_id:
        return None
    target = str(node_id)
    for feature in load_nodes_geojson().get("features", []):
        props = feature.get("properties", {})
        if str(props.get("node_id", "")) == target:
            return feature
        if str(props.get("grid_node_code", "")) == target:
            return feature
    return None


def get_node_index() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for feature in load_nodes_geojson().get("features", []):
        props = feature.get("properties", {})
        for key in [props.get("node_id"), props.get("grid_node_code")]:
            if key is not None:
                out[str(key)] = feature
    return out
