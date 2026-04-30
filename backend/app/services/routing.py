from __future__ import annotations

import math
from typing import Any

import networkx as nx
from pyproj import Transformer
from shapely.ops import transform as shapely_transform

from app.models import LegSummary, PlanStop, RouteEndpointInfo, RoutePathNode, RoutePoint, RouteResponse, RouteSummary
from app.services.data_loader import find_node_by_id, get_node_index, load_graph, load_manifest


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


def _graph_crs(graph) -> str | None:
    graph_crs = None
    try:
        graph_crs = graph.graph.get("crs")
    except Exception:
        graph_crs = None
    if graph_crs:
        return str(graph_crs)
    manifest = load_manifest()
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
        label=f"{label_prefix} ({point.lat:.5f}, {point.lon:.5f})",
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


def _node_path_metadata(path: list[Any], graph, transformer=None) -> list[RoutePathNode]:
    node_index = get_node_index()
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


def _route_from_graph(start_lonlat: tuple[float, float], end_lonlat: tuple[float, float], start_info: RouteEndpointInfo, end_info: RouteEndpointInfo) -> RouteResponse | None:
    graph = load_graph()
    if graph is None or len(graph.nodes) == 0:
        return None

    transformer = _make_transformer(_graph_crs(graph))
    start_node, start_snap, start_snap_dist = _nearest_graph_node(graph, start_lonlat[0], start_lonlat[1], transformer)
    end_node, end_snap, end_snap_dist = _nearest_graph_node(graph, end_lonlat[0], end_lonlat[1], transformer)

    if start_node is None or end_node is None:
        return None

    try:
        path = nx.shortest_path(graph, source=start_node, target=end_node, weight="length_m")
    except Exception:
        try:
            path = nx.shortest_path(graph, source=start_node, target=end_node, weight="length")
        except Exception:
            return None

    coords: list[tuple[float, float]] = []
    total_m = 0.0
    for u, v in zip(path[:-1], path[1:]):
        edge = _get_edge_attrs(graph.get_edge_data(u, v))
        if edge:
            segment = _edge_coords_lonlat(edge, transformer)
            if segment:
                if coords and coords[-1] == segment[0]:
                    coords.extend(segment[1:])
                else:
                    coords.extend(segment)
            total_m += float(edge.get("length_m") or edge.get("length") or 0.0)
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
            description=f"Selected point snapped to nearest walkable graph node ({start_snap_dist:.0f} m).",
            point=[start_snap[0], start_snap[1]],
            node_id=None,
        )
    if end_info.kind == "point" and end_snap is not None:
        end_info = RouteEndpointInfo(
            kind="snapped_point",
            label=end_info.label,
            description=f"Selected point snapped to nearest walkable graph node ({end_snap_dist:.0f} m).",
            point=[end_snap[0], end_snap[1]],
            node_id=None,
        )

    description = f"Route follows the walkable graph from {start_info.label} to {end_info.label}."

    return RouteResponse(
        mode="graph",
        route_geojson={
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[x, y] for x, y in coords]},
            "properties": {"distance_m": total_m},
        },
        summary=RouteSummary(distance_m=round(total_m, 2), estimated_minutes=_estimate_minutes(total_m), description=description),
        start=start_info,
        end=end_info,
        path_nodes=_node_path_metadata(path, graph, transformer),
        stop_sequence=[_endpoint_to_stop(start_info), _endpoint_to_stop(end_info)],
        leg_summaries=[LegSummary(order=1, start_label=start_info.label, end_label=end_info.label, distance_m=round(total_m, 2), estimated_minutes=_estimate_minutes(total_m))],
    )


def _straight_line_route(start_lonlat: tuple[float, float], end_lonlat: tuple[float, float], start_info: RouteEndpointInfo, end_info: RouteEndpointInfo) -> RouteResponse:
    distance_m = _meters_from_lonlat(start_lonlat, end_lonlat)
    description = f"Fallback straight-line preview from {start_info.label} to {end_info.label}. Add a valid graph to follow the walkable network."
    return RouteResponse(
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


def compute_route(start_node_id: str | None = None, end_node_id: str | None = None, start_point: RoutePoint | None = None, end_point: RoutePoint | None = None, strict_walkable: bool = False) -> RouteResponse:
    start_point = _point_from_any(start_point)
    end_point = _point_from_any(end_point)

    if not ((start_node_id or start_point) and (end_node_id or end_point)):
        raise ValueError("Provide either node ids or lon/lat points for both route endpoints.")

    if start_node_id:
        start_feature = find_node_by_id(start_node_id)
        if start_feature is None:
            raise ValueError(f"Start node '{start_node_id}' was not found.")
        start_lonlat = _feature_lonlat(start_feature)
        start_info = _feature_to_endpoint(start_feature)
    else:
        assert start_point is not None
        start_lonlat = (float(start_point.lon), float(start_point.lat))
        start_info = _point_to_endpoint(start_point, "Start point")

    if end_node_id:
        end_feature = find_node_by_id(end_node_id)
        if end_feature is None:
            raise ValueError(f"End node '{end_node_id}' was not found.")
        end_lonlat = _feature_lonlat(end_feature)
        end_info = _feature_to_endpoint(end_feature)
    else:
        assert end_point is not None
        end_lonlat = (float(end_point.lon), float(end_point.lat))
        end_info = _point_to_endpoint(end_point, "Destination point")

    graph_result = _route_from_graph(start_lonlat, end_lonlat, start_info, end_info)
    if graph_result is not None:
        return graph_result

    if strict_walkable:
        raise ValueError(
            f"Could not compute a strict walkable segment from {start_info.label} to {end_info.label}."
        )

    return _straight_line_route(start_lonlat, end_lonlat, start_info, end_info)


def compute_multi_stop_route(start_node_id: str | None = None, start_point: RoutePoint | None = None, plan_stops: list[PlanStop] | None = None) -> RouteResponse:
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
                )
            else:
                segment = compute_route(
                    start_node_id=current_node_id,
                    start_point=current_point,
                    end_point=stop_point,
                    strict_walkable=True,
                )
        except Exception as exc:
            start_label = None
            if current_node_id:
                f = find_node_by_id(current_node_id)
                if f is not None:
                    start_label = _feature_to_endpoint(f).label
            if start_label is None and current_point is not None:
                start_label = f"({current_point.lat:.5f}, {current_point.lon:.5f})"
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
