from __future__ import annotations

import math
import pickle
from functools import lru_cache
from typing import Any

import networkx as nx
from shapely.geometry import LineString, Point
from pyproj import Transformer
from shapely.ops import transform as shapely_transform

from app.models import LegSummary, PlanStop, RouteEndpointInfo, RoutePathNode, RoutePoint, RouteResponse, RouteSummary
from app.services.data_loader import (
    find_node_by_id,
    get_node_index,
    get_park_data_dir,
    load_graph,
    load_manifest,
    normalize_park_id,
)

ROUTE_RUNTIME_CACHE_FILE = "route_runtime_cache.pkl"
ROUTE_RUNTIME_CACHE_VERSION = 1


def _is_lonlat_pair(x: float, y: float) -> bool:
    return -180 <= x <= 180 and -90 <= y <= 90


def _meters_from_lonlat(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(x), math.sqrt(1 - x))


def _estimate_minutes(distance_m: float) -> int:
    return max(1, round(distance_m / 80.0))


def _graph_crs(graph, park_id: str | None = None) -> str | None:
    graph_crs = None
    try:
        graph_crs = graph.graph.get("crs")
    except Exception:
        graph_crs = None
    if graph_crs:
        return str(graph_crs)
    manifest = load_manifest(park_id)
    if manifest.get("graph_crs"):
        return str(manifest["graph_crs"])
    return None


def _make_transformer(source_crs: str | None):
    if not source_crs:
        return None
    text = str(source_crs)
    if text.upper() in {"EPSG:4326", "4326", "WGS84"}:
        return None
    try:
        return Transformer.from_crs(text, "EPSG:4326", always_xy=True)
    except Exception:
        return None


def _to_lonlat_xy(x: float, y: float, transformer=None) -> tuple[float, float]:
    if _is_lonlat_pair(x, y):
        return float(x), float(y)
    if transformer is not None:
        xx, yy = transformer.transform(float(x), float(y))
        return float(xx), float(yy)
    return float(x), float(y)


def _feature_lonlat(feature: dict[str, Any]) -> tuple[float, float]:
    coords = feature.get("geometry", {}).get("coordinates", [])
    return float(coords[0]), float(coords[1])


def _props(feature: dict[str, Any]) -> dict[str, Any]:
    return feature.get("properties", {})


def _normalize_category(raw: Any) -> str:
    text = str(raw or "core").lower()
    if "restroom" in text or "toilet" in text:
        return "restroom"
    if "water" in text or "drink" in text:
        return "water"
    if "food" in text or "cafe" in text or "restaurant" in text:
        return "food"
    if "info" in text or "visitor" in text or "landmark" in text:
        return "info"
    if "first" in text or "aid" in text or "emergency" in text:
        return "first_aid"
    if "shelter" in text:
        return "shelter"
    if "picnic" in text:
        return "picnic"
    if "recreation" in text or "playground" in text or "sports" in text:
        return "recreation"
    if "entrance" in text or "gate" in text:
        return "entrance"
    if "other" in text:
        return "other"
    if "junction" in text:
        return "junction"
    return "core"


def _feature_to_endpoint(feature: dict[str, Any]) -> RouteEndpointInfo:
    props = _props(feature)
    lon, lat = _feature_lonlat(feature)
    label = str(props.get("display_name") or props.get("infra_name") or props.get("name") or props.get("grid_node_code") or props.get("node_id") or "Node")
    return RouteEndpointInfo(
        kind="node",
        label=label,
        code=str(props.get("grid_node_code")) if props.get("grid_node_code") is not None else None,
        category=_normalize_category(props.get("infra_class") or props.get("infra_type") or props.get("node_subtype") or props.get("node_type") or props.get("display_group")),
        description=str(props.get("notes") or props.get("description") or props.get("infra_type") or props.get("node_type") or "") or None,
        point=[lon, lat],
        node_id=str(props.get("node_id")) if props.get("node_id") is not None else None,
    )


def _endpoint_to_stop(info: RouteEndpointInfo, source_query: str | None = None) -> PlanStop:
    return PlanStop(
        node_id=info.node_id,
        label=info.label,
        code=info.code,
        category=info.category,
        description=info.description,
        point=info.point,
        source_query=source_query,
    )


def _point_to_endpoint(point: RoutePoint, label_prefix: str) -> RouteEndpointInfo:
    return RouteEndpointInfo(
        kind="point",
        label=label_prefix,
        description="Selected on the walkable route network.",
        point=[point.lon, point.lat],
        node_id=None,
    )


def _graph_node_lonlat(node_attrs: dict[str, Any], transformer=None) -> tuple[float, float] | None:
    geom = node_attrs.get("geometry")
    if geom is not None:
        try:
            x, y = list(geom.coords)[0]
            return _to_lonlat_xy(x, y, transformer)
        except Exception:
            pass
    for x_key, y_key in [("lon", "lat"), ("x", "y")]:
        if x_key in node_attrs and y_key in node_attrs:
            try:
                return _to_lonlat_xy(float(node_attrs[x_key]), float(node_attrs[y_key]), transformer)
            except Exception:
                pass
    return None


def _get_edge_attrs(data: Any) -> dict[str, Any] | None:
    if data is None:
        return None
    if isinstance(data, dict):
        if "geometry" in data or "length_m" in data or "length" in data:
            return data
        for value in data.values():
            if isinstance(value, dict) and ("geometry" in value or "length_m" in value or "length" in value):
                return value
    return None


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def _edge_can_cross_restricted_area(edge_attrs: dict[str, Any]) -> bool:
    return _truthy(edge_attrs.get("bridge")) or _truthy(edge_attrs.get("tunnel"))


def _edge_length_m(edge_attrs: dict[str, Any], coords: list[tuple[float, float]] | None = None) -> float:
    for key in ("length_m", "length"):
        value = edge_attrs.get(key)
        try:
            length = float(value)
            if length > 0:
                return length
        except Exception:
            pass

    line = coords or []
    if len(line) >= 2:
        return sum(_meters_from_lonlat(a, b) for a, b in zip(line[:-1], line[1:]))

    return 1.0


def _accessibility_weight(_u: Any, _v: Any, edge_attrs: dict[str, Any]) -> float:
    """Prefer safer walkable paths over purely shortest paths."""
    length_m = _edge_length_m(edge_attrs)
    multiplier = 1.0
    penalty_m = 0.0

    if _truthy(edge_attrs.get("has_stairs")):
        multiplier += 4.0
        penalty_m += 80.0

    near_crossing = _truthy(edge_attrs.get("near_road_crossing"))
    signalized = _truthy(edge_attrs.get("has_signalized_crossing"))
    if near_crossing and signalized:
        multiplier += 0.2
        penalty_m += 8.0
    elif near_crossing:
        multiplier += 0.8
        penalty_m += 28.0

    surface = str(edge_attrs.get("surface") or "").strip().lower()
    if surface in {"gravel", "unpaved", "dirt", "grass", "ground", "earth", "sand"}:
        multiplier += 0.55
    elif surface in {"unknown", ""}:
        multiplier += 0.08

    try:
        curvature = float(edge_attrs.get("curvature") or 0.0)
        multiplier += min(0.25, max(0.0, curvature) * 0.08)
    except Exception:
        pass

    try:
        sinuosity = float(edge_attrs.get("sinuosity") or 1.0)
        if sinuosity > 1:
            multiplier += min(0.2, (sinuosity - 1.0) * 0.12)
    except Exception:
        pass

    return max(0.1, length_m * multiplier + penalty_m)


def _edge_coords_lonlat(edge_attrs: dict[str, Any], transformer=None) -> list[tuple[float, float]]:
    geom = edge_attrs.get("geometry")
    if geom is None:
        return []
    try:
        if transformer is not None:
            geom = shapely_transform(transformer.transform, geom)
        coords = [(float(x), float(y)) for x, y in geom.coords]
        if coords and all(_is_lonlat_pair(x, y) for x, y in coords):
            return coords
        return []
    except Exception:
        return []


def _aligned_edge_coords_lonlat(graph, u, v, edge_attrs: dict[str, Any], transformer=None) -> list[tuple[float, float]]:
    u_coord = _graph_node_lonlat(graph.nodes[u], transformer) if u in graph.nodes else None
    v_coord = _graph_node_lonlat(graph.nodes[v], transformer) if v in graph.nodes else None
    coords = _edge_coords_lonlat(edge_attrs, transformer)

    if not coords and u_coord and v_coord:
        return [u_coord, v_coord]

    if not coords:
        return []

    if u_coord and v_coord:
        forward = _meters_from_lonlat(coords[0], u_coord) + _meters_from_lonlat(coords[-1], v_coord)
        reverse = _meters_from_lonlat(coords[0], v_coord) + _meters_from_lonlat(coords[-1], u_coord)
        if reverse < forward:
            coords = list(reversed(coords))
    elif u_coord:
        if _meters_from_lonlat(coords[-1], u_coord) < _meters_from_lonlat(coords[0], u_coord):
            coords = list(reversed(coords))
    elif v_coord:
        if _meters_from_lonlat(coords[0], v_coord) < _meters_from_lonlat(coords[-1], v_coord):
            coords = list(reversed(coords))

    return coords


def _edge_topology_penalty_m(graph, u, v, edge_attrs: dict[str, Any], transformer=None) -> float:
    u_coord = _graph_node_lonlat(graph.nodes[u], transformer) if u in graph.nodes else None
    v_coord = _graph_node_lonlat(graph.nodes[v], transformer) if v in graph.nodes else None
    if not u_coord or not v_coord:
        return 0.0

    node_distance = _meters_from_lonlat(u_coord, v_coord)
    edge_length = _edge_length_m(edge_attrs)
    penalty = 0.0

    if edge_length > 0 and node_distance > max(35.0, edge_length * 2.5 + 10.0):
        penalty += 10000.0 + node_distance * 20.0

    coords = _edge_coords_lonlat(edge_attrs, transformer)
    if coords:
        u_gap = min(_meters_from_lonlat(u_coord, coords[0]), _meters_from_lonlat(u_coord, coords[-1]))
        v_gap = min(_meters_from_lonlat(v_coord, coords[0]), _meters_from_lonlat(v_coord, coords[-1]))
        if max(u_gap, v_gap) > 12.0 and node_distance > 20.0:
            penalty += 10000.0 + max(u_gap, v_gap) * 20.0

    return penalty


def _route_weight_for_graph(graph, transformer=None):
    def weight(u, v, attrs):
        edge_attrs = _get_edge_attrs(attrs) or attrs
        try:
            cached_weight = float(edge_attrs.get("_route_weight_m"))
            if cached_weight > 0:
                return cached_weight
        except Exception:
            pass
        return _accessibility_weight(u, v, edge_attrs) + _edge_topology_penalty_m(
            graph, u, v, edge_attrs, transformer
        )

    return weight


def _precompute_route_weights(graph, transformer=None):
    for u, v, attrs in graph.edges(data=True):
        edge_attrs = _get_edge_attrs(attrs) or attrs
        edge_attrs["_route_weight_m"] = _accessibility_weight(u, v, edge_attrs) + _edge_topology_penalty_m(
            graph, u, v, edge_attrs, transformer
        )
    return graph


def _drop_inconsistent_edges(graph, transformer=None):
    bad_edges = []
    for u, v, attrs in graph.edges(data=True):
        edge_attrs = _get_edge_attrs(attrs) or attrs
        if _edge_topology_penalty_m(graph, u, v, edge_attrs, transformer) > 0:
            bad_edges.append((u, v))

    if not bad_edges:
        return graph

    filtered = graph.copy()
    filtered.remove_edges_from(bad_edges)
    return filtered


def _append_coord(out: list[tuple[float, float]], point: tuple[float, float]) -> None:
    if not out or _meters_from_lonlat(out[-1], point) > 0.05:
        out.append(point)


def _extend_coords_with_segment(out: list[tuple[float, float]], segment: list[tuple[float, float]]) -> None:
    if not segment:
        return

    oriented = list(segment)
    if out:
        forward_gap = _meters_from_lonlat(out[-1], oriented[0])
        reverse_gap = _meters_from_lonlat(out[-1], oriented[-1])
        if reverse_gap < forward_gap:
            oriented.reverse()

    start_index = 0
    if out and _meters_from_lonlat(out[-1], oriented[0]) <= 2.0:
        start_index = 1

    for point in oriented[start_index:]:
        _append_coord(out, point)


def _project_point_to_segment_lonlat(
    point: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
) -> tuple[tuple[float, float], float, float]:
    lat0 = math.radians((a[1] + b[1] + point[1]) / 3.0)
    sx = 111320.0 * math.cos(lat0)
    sy = 110540.0
    ax, ay = a[0] * sx, a[1] * sy
    bx, by = b[0] * sx, b[1] * sy
    px, py = point[0] * sx, point[1] * sy
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    if denom <= 0:
        return a, _meters_from_lonlat(point, a), 0.0
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
    foot = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    return foot, _meters_from_lonlat(point, foot), t


def _route_runtime_cache_path(park_id: str):
    return get_park_data_dir(park_id) / ROUTE_RUNTIME_CACHE_FILE


@lru_cache(maxsize=8)
def _load_route_runtime_cache(park_id: str):
    cache_path = _route_runtime_cache_path(park_id)
    if not cache_path.exists():
        return None

    try:
        with cache_path.open("rb") as f:
            payload = pickle.load(f)
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None
    if payload.get("version") != ROUTE_RUNTIME_CACHE_VERSION:
        return None
    if payload.get("park_id") != park_id:
        return None
    graph = payload.get("graph")
    snap_records = payload.get("snap_records")
    if graph is None or snap_records is None:
        return None

    return payload


def _compute_route_runtime_cache(park_id: str):
    graph = load_graph(park_id)
    if graph is None or len(graph.nodes) == 0:
        return None

    transformer = _make_transformer(_graph_crs(graph, park_id))
    graph = _restricted_area_filtered_graph(graph, transformer, park_id)
    if graph is None or len(graph.nodes) == 0:
        return None

    graph = _drop_inconsistent_edges(graph, transformer)
    _precompute_route_weights(graph, transformer)

    records = []
    for u, v, attrs in graph.edges(data=True):
        edge_attrs = _get_edge_attrs(attrs) or attrs
        coords = _aligned_edge_coords_lonlat(graph, u, v, edge_attrs, transformer)
        if len(coords) >= 2:
            records.append((u, v, edge_attrs, coords))

    return {
        "version": ROUTE_RUNTIME_CACHE_VERSION,
        "park_id": park_id,
        "graph_crs": _graph_crs(graph, park_id),
        "node_count": len(graph.nodes),
        "edge_count": len(graph.edges),
        "graph": graph,
        "snap_records": tuple(records),
    }


@lru_cache(maxsize=8)
def _route_runtime_cache(park_id: str):
    return _load_route_runtime_cache(park_id) or _compute_route_runtime_cache(park_id)


def build_route_runtime_cache(park_id: str | None = None, write: bool = True):
    normalized_park_id = normalize_park_id(park_id)
    payload = _compute_route_runtime_cache(normalized_park_id)
    if payload is None:
        raise ValueError(f"Could not build route runtime cache for {normalized_park_id}.")

    if write:
        cache_path = _route_runtime_cache_path(normalized_park_id)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with cache_path.open("wb") as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)

        _load_route_runtime_cache.cache_clear()
        _route_runtime_cache.cache_clear()
        _prepared_route_graph.cache_clear()
        _route_snap_records.cache_clear()

    return payload


@lru_cache(maxsize=8)
def _prepared_route_graph(park_id: str):
    payload = _route_runtime_cache(park_id)
    if payload is None:
        return None, None

    graph = payload["graph"]
    transformer = _make_transformer(_graph_crs(graph, park_id))
    return graph, transformer


@lru_cache(maxsize=8)
def _route_snap_records(park_id: str):
    payload = _route_runtime_cache(park_id)
    if payload is None:
        return tuple()
    return tuple(payload["snap_records"])


def _nearest_graph_edge_location(graph, lon: float, lat: float, transformer=None, park_id: str | None = None):
    point = (lon, lat)
    best: dict[str, Any] | None = None

    if park_id:
        edge_records = _route_snap_records(normalize_park_id(park_id))
    else:
        edge_records = tuple(
            (u, v, _get_edge_attrs(attrs) or attrs, _aligned_edge_coords_lonlat(graph, u, v, _get_edge_attrs(attrs) or attrs, transformer))
            for u, v, attrs in graph.edges(data=True)
        )

    for u, v, edge_attrs, coords in edge_records:
        if len(coords) < 2:
            continue

        distance_from_u = 0.0
        for segment_index, (a, b) in enumerate(zip(coords[:-1], coords[1:])):
            segment_length = _meters_from_lonlat(a, b)
            foot, off_m, t = _project_point_to_segment_lonlat(point, a, b)
            along_m = distance_from_u + segment_length * t

            if best is None or off_m < best["distance_m"]:
                best = {
                    "u": u,
                    "v": v,
                    "attrs": edge_attrs,
                    "coords": coords,
                    "foot": foot,
                    "distance_m": off_m,
                    "segment_index": segment_index,
                    "along_m": along_m,
                }

            distance_from_u += segment_length

    return best


def _split_coords_at_foot(
    coords: list[tuple[float, float]],
    segment_index: int,
    foot: tuple[float, float],
) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    to_u: list[tuple[float, float]] = []
    for point in coords[: segment_index + 1]:
        _append_coord(to_u, point)
    _append_coord(to_u, foot)

    to_v: list[tuple[float, float]] = [foot]
    for point in coords[segment_index + 1 :]:
        _append_coord(to_v, point)

    return to_u, to_v


def _line_string_from_coords(coords: list[tuple[float, float]]) -> LineString:
    if len(coords) >= 2:
        return LineString(coords)
    if len(coords) == 1:
        return LineString([coords[0], coords[0]])
    return LineString([(0.0, 0.0), (0.0, 0.0)])


def _add_virtual_snap_node(
    graph,
    lonlat: tuple[float, float],
    label: str,
    transformer=None,
    park_id: str | None = None,
    max_snap_meters: float = 80.0,
):
    nearest = _nearest_graph_edge_location(graph, lonlat[0], lonlat[1], transformer, park_id)
    if nearest is None or nearest["distance_m"] > max_snap_meters:
        return None, None, float("inf")

    virtual_id = f"virtual:{label}"
    foot = nearest["foot"]
    graph.add_node(
        virtual_id,
        lon=foot[0],
        lat=foot[1],
        geometry=Point(foot),
        node_type="snap",
        node_subtype="walkable_edge_projection",
        name="Walkable path projection",
    )

    u = nearest["u"]
    v = nearest["v"]
    attrs = {key: value for key, value in dict(nearest["attrs"]).items() if key != "_route_weight_m"}
    to_u, to_v = _split_coords_at_foot(nearest["coords"], nearest["segment_index"], foot)
    length_to_u = sum(_meters_from_lonlat(a, b) for a, b in zip(to_u[:-1], to_u[1:]))
    length_to_v = sum(_meters_from_lonlat(a, b) for a, b in zip(to_v[:-1], to_v[1:]))

    attrs_to_u = {
        **attrs,
        "edge_id": f"virtual:{label}:to:{u}",
        "length_m": max(0.1, length_to_u),
        "geometry": _line_string_from_coords(to_u),
    }
    attrs_to_v = {
        **attrs,
        "edge_id": f"virtual:{label}:to:{v}",
        "length_m": max(0.1, length_to_v),
        "geometry": _line_string_from_coords(to_v),
    }

    graph.add_edge(virtual_id, u, **attrs_to_u)
    graph.add_edge(virtual_id, v, **attrs_to_v)

    return virtual_id, foot, float(nearest["distance_m"])


def _nearest_graph_node(graph, lon: float, lat: float, transformer=None):
    best_id = None
    best_dist = float("inf")
    best_point = None
    for node_id, attrs in graph.nodes(data=True):
        coord = _graph_node_lonlat(attrs, transformer)
        if coord is None:
            continue
        dist = _meters_from_lonlat((lon, lat), coord)
        if dist < best_dist:
            best_dist = dist
            best_id = node_id
            best_point = coord
    return best_id, best_point, best_dist


def warm_route_cache(park_id: str | None = None) -> None:
    normalized_park_id = normalize_park_id(park_id)
    _prepared_route_graph(normalized_park_id)
    _route_snap_records(normalized_park_id)


def _node_path_metadata(path: list[Any], graph, transformer=None, park_id: str | None = None) -> list[RoutePathNode]:
    node_index = get_node_index(park_id)
    results: list[RoutePathNode] = []
    for node_id in path:
        attrs = dict(graph.nodes.get(node_id, {}))
        feature = node_index.get(str(node_id))
        if feature is not None:
            props = _props(feature)
            lon, lat = _feature_lonlat(feature)
            results.append(RoutePathNode(
                node_id=str(node_id),
                label=str(props.get("display_name") or props.get("infra_name") or props.get("name") or props.get("grid_node_code") or node_id),
                code=str(props.get("grid_node_code")) if props.get("grid_node_code") is not None else None,
                category=_normalize_category(props.get("infra_class") or props.get("infra_type") or props.get("node_subtype") or props.get("node_type") or props.get("display_group")),
                description=str(props.get("notes") or props.get("description") or props.get("infra_type") or props.get("node_type") or "") or None,
                point=[lon, lat],
            ))
        else:
            coord = _graph_node_lonlat(attrs, transformer)
            results.append(RoutePathNode(
                node_id=str(node_id),
                label=str(attrs.get("display_name") or attrs.get("name") or attrs.get("grid_node_code") or node_id),
                code=str(attrs.get("grid_node_code")) if attrs.get("grid_node_code") is not None else None,
                category=_normalize_category(attrs.get("infra_class") or attrs.get("infra_type") or attrs.get("node_type") or attrs.get("display_group")),
                description=str(attrs.get("description") or attrs.get("notes") or "") or None,
                point=[coord[0], coord[1]] if coord is not None else None,
            ))
    return _compress_path_nodes(results)


def _compress_path_nodes(nodes: list[RoutePathNode]) -> list[RoutePathNode]:
    if not nodes:
        return []
    selected: list[RoutePathNode] = [nodes[0]]
    for node in nodes[1:-1]:
        if str(node.node_id).startswith("virtual:"):
            continue
        if node.code or node.description or (node.category and node.category not in {"core"}):
            selected.append(node)
    if len(nodes) > 1:
        selected.append(nodes[-1])
    out: list[RoutePathNode] = []
    seen: set[str] = set()
    for node in selected:
        key = f"{node.node_id}|{node.label}"
        if key in seen:
            continue
        seen.add(key)
        if not node.description:
            node.description = "No description available."
        out.append(node)
    return out



from pathlib import Path as _Path
import json as _json


_RESTRICTED_AREA_CACHE = {}


def _load_restricted_areas(park_id: str | None = None):
    normalized_park_id = normalize_park_id(park_id)

    if normalized_park_id in _RESTRICTED_AREA_CACHE:
        return _RESTRICTED_AREA_CACHE[normalized_park_id]

    candidates = []
    data_restricted_dir = get_park_data_dir(normalized_park_id) / "restricted_areas"
    if data_restricted_dir.exists():
        candidates.extend(sorted(data_restricted_dir.glob("*.geojson")))

    if normalized_park_id == "central_park":
        candidates.append(
            _Path(__file__).resolve().parents[3] / "frontend" / "public" / "restricted_areas" / "central_park_zoo.geojson"
        )

    for p in candidates:
        if p.exists():
            try:
                data = _json.loads(p.read_text(encoding="utf-8"))
                features = data.get("features", [])
                _RESTRICTED_AREA_CACHE[normalized_park_id] = features
                return features
            except Exception:
                pass

    _RESTRICTED_AREA_CACHE[normalized_park_id] = []
    return _RESTRICTED_AREA_CACHE[normalized_park_id]


def _point_in_ring_lonlat(point, ring):
    x, y = point
    inside = False

    for i in range(len(ring)):
        j = i - 1
        xi, yi = ring[i]
        xj, yj = ring[j]

        intersects = (yi > y) != (yj > y) and x < ((xj - xi) * (y - yi)) / ((yj - yi) or 1e-12) + xi

        if intersects:
            inside = not inside

    return inside


def _point_in_restricted_area_lonlat(lonlat, park_id: str | None = None):
    lon, lat = lonlat

    for feature in _load_restricted_areas(park_id):
        geom = feature.get("geometry", {})
        gtype = geom.get("type")

        if gtype == "Polygon":
            rings = geom.get("coordinates", [])
            if rings and _point_in_ring_lonlat([lon, lat], rings[0]):
                return True

        if gtype == "MultiPolygon":
            for polygon in geom.get("coordinates", []):
                if polygon and _point_in_ring_lonlat([lon, lat], polygon[0]):
                    return True

    return False


def _segments_intersect(a, b, c, d):
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    def on_segment(p, q, r):
        return (
            min(p[0], r[0]) <= q[0] <= max(p[0], r[0])
            and min(p[1], r[1]) <= q[1] <= max(p[1], r[1])
        )

    o1 = orient(a, b, c)
    o2 = orient(a, b, d)
    o3 = orient(c, d, a)
    o4 = orient(c, d, b)

    if o1 == 0 and on_segment(a, c, b):
        return True
    if o2 == 0 and on_segment(a, d, b):
        return True
    if o3 == 0 and on_segment(c, a, d):
        return True
    if o4 == 0 and on_segment(c, b, d):
        return True

    return (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0)


def _line_touches_ring(line, ring):
    if not line or len(line) < 2:
        return False

    for pt in line:
        if _point_in_ring_lonlat(pt, ring):
            return True

    for a, b in zip(line[:-1], line[1:]):
        for c, d in zip(ring[:-1], ring[1:]):
            if _segments_intersect(a, b, c, d):
                return True

    return False


def _line_touches_restricted_area_lonlat(line, park_id: str | None = None):
    for feature in _load_restricted_areas(park_id):
        geom = feature.get("geometry", {})
        gtype = geom.get("type")

        if gtype == "Polygon":
            rings = geom.get("coordinates", [])
            if rings and _line_touches_ring(line, rings[0]):
                return True

        if gtype == "MultiPolygon":
            for polygon in geom.get("coordinates", []):
                if polygon and _line_touches_ring(line, polygon[0]):
                    return True

    return False


def _restricted_area_filtered_graph(graph, transformer, park_id: str | None = None):
    filtered = graph.copy()

    nodes_to_remove = []

    for node_id, attrs in list(filtered.nodes(data=True)):
        coord = _graph_node_lonlat(attrs, transformer)

        if coord and _point_in_restricted_area_lonlat(coord, park_id):
            nodes_to_remove.append(node_id)

    filtered.remove_nodes_from(nodes_to_remove)

    edges_to_remove = []

    for u, v, attrs in list(filtered.edges(data=True)):
        u_coord = _graph_node_lonlat(filtered.nodes[u], transformer) if u in filtered.nodes else None
        v_coord = _graph_node_lonlat(filtered.nodes[v], transformer) if v in filtered.nodes else None

        if not u_coord or not v_coord:
            continue

        edge_attrs = _get_edge_attrs(attrs) or attrs
        if _edge_can_cross_restricted_area(edge_attrs):
            continue
        segment = _edge_coords_lonlat(edge_attrs, transformer) or [u_coord, v_coord]

        if _line_touches_restricted_area_lonlat(segment, park_id):
            edges_to_remove.append((u, v))

    filtered.remove_edges_from(edges_to_remove)

    return filtered



def _route_from_graph(start_lonlat: tuple[float, float], end_lonlat: tuple[float, float], start_info: RouteEndpointInfo, end_info: RouteEndpointInfo, park_id: str) -> RouteResponse | None:
    base_graph, transformer = _prepared_route_graph(normalize_park_id(park_id))
    if base_graph is None or len(base_graph.nodes) == 0:
        return None

    needs_virtual_snap = not start_info.node_id or not end_info.node_id
    graph = base_graph.copy() if needs_virtual_snap else base_graph

    # If the user selected an explicit graph node, do not silently snap it to
    # another node after Zoo/restricted-area filtering. Otherwise the route panel
    # may show N1417 while the blue line actually starts somewhere else.
    if start_info.node_id:
        if start_info.node_id not in graph.nodes:
            return None
        start_node = start_info.node_id
        start_snap = start_lonlat
        start_snap_dist = 0.0
    else:
        start_node, start_snap, start_snap_dist = _add_virtual_snap_node(
            graph, start_lonlat, "start", transformer, park_id
        )

    if end_info.node_id:
        if end_info.node_id not in graph.nodes:
            return None
        end_node = end_info.node_id
        end_snap = end_lonlat
        end_snap_dist = 0.0
    else:
        end_node, end_snap, end_snap_dist = _add_virtual_snap_node(
            graph, end_lonlat, "end", transformer, park_id
        )

    if start_node is None or end_node is None:
        return None

    try:
        path = nx.shortest_path(graph, source=start_node, target=end_node, weight=_route_weight_for_graph(graph, transformer))
    except Exception:
        try:
            path = nx.shortest_path(graph, source=start_node, target=end_node, weight="length_m")
        except Exception:
            return None

    coords: list[tuple[float, float]] = []
    total_m = 0.0
    for u, v in zip(path[:-1], path[1:]):
        edge = _get_edge_attrs(graph.get_edge_data(u, v))
        if edge:
            segment = _aligned_edge_coords_lonlat(graph, u, v, edge, transformer)
            if segment:
                _extend_coords_with_segment(coords, segment)
            total_m += _edge_length_m(edge, segment)
        if not coords:
            u_coord = _graph_node_lonlat(graph.nodes[u], transformer)
            v_coord = _graph_node_lonlat(graph.nodes[v], transformer)
            if u_coord and v_coord:
                if not coords:
                    coords.append(u_coord)
                coords.append(v_coord)

    if len(coords) < 2:
        fallback_coords = []
        for node_id in path:
            coord = _graph_node_lonlat(graph.nodes[node_id], transformer)
            if coord is not None:
                fallback_coords.append(coord)
        coords = fallback_coords

    if len(coords) < 2:
        return None

    if total_m <= 0:
        total_m = sum(_meters_from_lonlat(a, b) for a, b in zip(coords[:-1], coords[1:]))

    if start_info.kind == "point" and start_snap is not None:
        start_info = RouteEndpointInfo(
            kind="snapped_point",
            label=start_info.label,
            description=f"Selected point snapped to nearest walkable path ({start_snap_dist:.0f} m).",
            point=[start_snap[0], start_snap[1]],
            node_id=None,
        )
    if end_info.kind == "point" and end_snap is not None:
        end_info = RouteEndpointInfo(
            kind="snapped_point",
            label=end_info.label,
            description=f"Selected point snapped to nearest walkable path ({end_snap_dist:.0f} m).",
            point=[end_snap[0], end_snap[1]],
            node_id=None,
        )

    if len(coords) < 2:
        return None

    total_m = 0.0
    for a, b in zip(coords[:-1], coords[1:]):
        total_m += _meters_from_lonlat(a, b)

    description = f"Route follows the accessibility-weighted walkable graph from {start_info.label} to {end_info.label}."

    return RouteResponse(
        park_id=park_id,
        mode="graph",
        route_geojson={
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[x, y] for x, y in coords]},
            "properties": {"distance_m": total_m},
        },
        summary=RouteSummary(distance_m=round(total_m, 2), estimated_minutes=_estimate_minutes(total_m), description=description),
        start=start_info,
        end=end_info,
        path_nodes=_node_path_metadata(path, graph, transformer, park_id),
        stop_sequence=[_endpoint_to_stop(start_info), _endpoint_to_stop(end_info)],
        leg_summaries=[LegSummary(order=1, start_label=start_info.label, end_label=end_info.label, distance_m=round(total_m, 2), estimated_minutes=_estimate_minutes(total_m))],
    )


def _straight_line_route(start_lonlat: tuple[float, float], end_lonlat: tuple[float, float], start_info: RouteEndpointInfo, end_info: RouteEndpointInfo, park_id: str) -> RouteResponse:
    distance_m = _meters_from_lonlat(start_lonlat, end_lonlat)
    description = f"Fallback straight-line preview from {start_info.label} to {end_info.label}. Add a valid graph to follow the walkable network."
    return RouteResponse(
        park_id=park_id,
        mode="straight_line",
        route_geojson={
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[start_lonlat[0], start_lonlat[1]], [end_lonlat[0], end_lonlat[1]]]},
            "properties": {"distance_m": distance_m},
        },
        summary=RouteSummary(distance_m=round(distance_m, 2), estimated_minutes=_estimate_minutes(distance_m), description=description),
        start=start_info,
        end=end_info,
        path_nodes=[],
        stop_sequence=[_endpoint_to_stop(start_info), _endpoint_to_stop(end_info)],
        leg_summaries=[LegSummary(order=1, start_label=start_info.label, end_label=end_info.label, distance_m=round(distance_m, 2), estimated_minutes=_estimate_minutes(distance_m))],
    )


def _merge_coords(existing: list[list[float]], new_coords: list[list[float]]) -> list[list[float]]:
    if not existing:
        return list(new_coords)
    if not new_coords:
        return existing
    if existing[-1] == new_coords[0]:
        return existing + new_coords[1:]
    return existing + new_coords


def _merge_path_nodes(existing: list[RoutePathNode], new_nodes: list[RoutePathNode]) -> list[RoutePathNode]:
    out = list(existing)
    seen = {f"{n.node_id}|{n.label}" for n in existing}
    for node in new_nodes:
        key = f"{node.node_id}|{node.label}"
        if key not in seen:
            out.append(node)
            seen.add(key)
    return out




def _extract_route_coordinates(route: RouteResponse) -> list[list[float]]:
    rg = route.route_geojson

    # Pydantic model style: route.route_geojson.geometry.coordinates
    if hasattr(rg, "geometry") and hasattr(rg.geometry, "coordinates"):
        return list(rg.geometry.coordinates or [])

    # Dict style: route.route_geojson["geometry"]["coordinates"]
    if isinstance(rg, dict):
        return list((rg.get("geometry", {}) or {}).get("coordinates", []) or [])

    return []

def _point_from_any(value: Any) -> RoutePoint | None:
    """
    Normalize supported point payloads into a RoutePoint.
    Supports:
      - RoutePoint / Pydantic objects with .lon / .lat
      - dicts like {"lon": ..., "lat": ...}
      - [lon, lat] or (lon, lat)
    """
    if value is None:
        return None

    if isinstance(value, RoutePoint):
        return value

    if hasattr(value, "lon") and hasattr(value, "lat"):
        try:
            return RoutePoint(lon=float(value.lon), lat=float(value.lat))
        except Exception:
            pass

    if isinstance(value, dict):
        lon = value.get("lon")
        lat = value.get("lat")
        if lon is None or lat is None:
            return None
        try:
            return RoutePoint(lon=float(lon), lat=float(lat))
        except Exception:
            return None

    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            return RoutePoint(lon=float(value[0]), lat=float(value[1]))
        except Exception:
            return None

    return None


def compute_route(start_node_id: str | None = None, end_node_id: str | None = None, start_point: RoutePoint | None = None, end_point: RoutePoint | None = None, strict_walkable: bool = False, park_id: str | None = None) -> RouteResponse:
    normalized_park_id = normalize_park_id(park_id)
    start_point = _point_from_any(start_point)
    end_point = _point_from_any(end_point)

    if not ((start_node_id or start_point) and (end_node_id or end_point)):
        raise ValueError("Provide either node ids or lon/lat points for both route endpoints.")

    if start_node_id:
        start_feature = find_node_by_id(start_node_id, normalized_park_id)
        if start_feature is None:
            raise ValueError(f"Start node '{start_node_id}' was not found.")
        start_lonlat = _feature_lonlat(start_feature)
        start_info = _feature_to_endpoint(start_feature)
    else:
        assert start_point is not None
        start_lonlat = (float(start_point.lon), float(start_point.lat))
        start_info = _point_to_endpoint(start_point, "Start point")

    if end_node_id:
        end_feature = find_node_by_id(end_node_id, normalized_park_id)
        if end_feature is None:
            raise ValueError(f"End node '{end_node_id}' was not found.")
        end_lonlat = _feature_lonlat(end_feature)
        end_info = _feature_to_endpoint(end_feature)
    else:
        assert end_point is not None
        end_lonlat = (float(end_point.lon), float(end_point.lat))
        end_info = _point_to_endpoint(end_point, "Destination point")

    graph_result = _route_from_graph(start_lonlat, end_lonlat, start_info, end_info, normalized_park_id)
    if graph_result is not None:
        return graph_result

    if strict_walkable:
        raise ValueError(
            f"Could not compute a strict walkable segment from {start_info.label} to {end_info.label}."
        )

    return _straight_line_route(start_lonlat, end_lonlat, start_info, end_info, normalized_park_id)


def compute_multi_stop_route(start_node_id: str | None = None, start_point: RoutePoint | None = None, plan_stops: list[PlanStop] | None = None, park_id: str | None = None) -> RouteResponse:
    normalized_park_id = normalize_park_id(park_id)
    stops = plan_stops or []
    if not stops:
        raise ValueError("No planned stops were provided.")

    current_node_id = start_node_id
    current_point = _point_from_any(start_point)
    if not (current_node_id or current_point):
        raise ValueError("Multi-stop routing requires a valid current/start point.")

    all_coords: list[list[float]] = []
    all_path_nodes: list[RoutePathNode] = []
    leg_summaries: list[LegSummary] = []
    stop_sequence: list[PlanStop] = []
    total_distance = 0.0
    total_minutes = 0
    overall_start: RouteEndpointInfo | None = None
    overall_end: RouteEndpointInfo | None = None

    for idx, stop in enumerate(stops, start=1):
        stop_point = _point_from_any(stop.point)
        if not stop.node_id and not stop_point:
            raise ValueError(f"Stop '{stop.label}' does not have a valid point or node id.")

        try:
            if stop.node_id:
                segment = compute_route(
                    start_node_id=current_node_id,
                    start_point=current_point,
                    end_node_id=stop.node_id,
                    strict_walkable=True,
                    park_id=normalized_park_id,
                )
            else:
                segment = compute_route(
                    start_node_id=current_node_id,
                    start_point=current_point,
                    end_point=stop_point,
                    strict_walkable=True,
                    park_id=normalized_park_id,
                )
        except Exception as exc:
            start_label = None
            if current_node_id:
                f = find_node_by_id(current_node_id, normalized_park_id)
                if f is not None:
                    start_label = _feature_to_endpoint(f).label
            if start_label is None and current_point is not None:
                start_label = "Selected start point"
            if start_label is None:
                start_label = f"Leg {idx} start"

            raise ValueError(
                f"Walkable routing failed for leg {idx}: {start_label} → {stop.label}. Reason: {exc}"
            ) from exc

        coords = _extract_route_coordinates(segment)
        all_coords = _merge_coords(all_coords, coords)
        all_path_nodes = _merge_path_nodes(all_path_nodes, segment.path_nodes)
        total_distance += float(segment.summary.distance_m)
        total_minutes += int(segment.summary.estimated_minutes)
        leg_summaries.append(
            LegSummary(
                order=idx,
                start_label=segment.start.label if segment.start else f"Leg {idx} start",
                end_label=segment.end.label if segment.end else stop.label,
                distance_m=float(segment.summary.distance_m),
                estimated_minutes=int(segment.summary.estimated_minutes),
            )
        )

        if overall_start is None:
            overall_start = segment.start
            if segment.start is not None:
                stop_sequence.append(_endpoint_to_stop(segment.start))
        overall_end = segment.end
        if segment.end is not None:
            stop_sequence.append(_endpoint_to_stop(segment.end, source_query=stop.source_query))

        current_node_id = stop.node_id
        if stop_point is not None and not stop.node_id:
            current_point = stop_point
        elif segment.end is not None and segment.end.point:
            current_point = _point_from_any(segment.end.point)
        else:
            current_point = None

    if not all_coords:
        raise ValueError("Could not compute any route segments for the planned stops.")

    description = " → ".join(stop.label for stop in stop_sequence) if stop_sequence else "Multi-stop route"

    return RouteResponse(
        park_id=normalized_park_id,
        mode="multi_stop_walkable",
        route_geojson={
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": all_coords},
            "properties": {"distance_m": round(total_distance, 2)},
        },
        summary=RouteSummary(distance_m=round(total_distance, 2), estimated_minutes=total_minutes, description=description),
        start=overall_start,
        end=overall_end,
        path_nodes=all_path_nodes,
        stop_sequence=stop_sequence,
        leg_summaries=leg_summaries,
    )
