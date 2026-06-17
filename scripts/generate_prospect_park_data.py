#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import pickle
from pathlib import Path
from typing import Any

import networkx as nx
import requests
from shapely.geometry import LineString, Point


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = PROJECT_ROOT / "data" / "prospect_park_app_data"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
PROSPECT_BBOX = (40.6400, -73.9855, 40.6765, -73.9550)

WALKABLE_HIGHWAYS = {
    "footway",
    "path",
    "pedestrian",
    "steps",
    "cycleway",
    "service",
    "track",
    "living_street",
    "residential",
}

POI_TAGS = {
    "amenity",
    "tourism",
    "leisure",
    "entrance",
    "barrier",
    "shop",
    "historic",
    "natural",
}

SEED_NODES: list[tuple[str, str, float, float, str]] = [
    ("PP_SEED_001", "Grand Army Plaza entrance", -73.9690, 40.6743, "entrance"),
    ("PP_SEED_002", "Endale Arch", -73.9706, 40.6722, "info"),
    ("PP_SEED_003", "Long Meadow north", -73.9718, 40.6700, "recreation"),
    ("PP_SEED_004", "Long Meadow center", -73.9730, 40.6669, "recreation"),
    ("PP_SEED_005", "Picnic House", -73.9738, 40.6651, "picnic"),
    ("PP_SEED_006", "Bandshell", -73.9708, 40.6633, "info"),
    ("PP_SEED_007", "Nethermead", -73.9718, 40.6606, "recreation"),
    ("PP_SEED_008", "Prospect Park Boathouse", -73.9658, 40.6608, "info"),
    ("PP_SEED_009", "Prospect Park Zoo", -73.9654, 40.6650, "recreation"),
    ("PP_SEED_010", "East Drive north", -73.9642, 40.6685, "junction"),
    ("PP_SEED_011", "East Drive center", -73.9630, 40.6635, "junction"),
    ("PP_SEED_012", "Lincoln Road entrance", -73.9618, 40.6614, "entrance"),
    ("PP_SEED_013", "Ocean Avenue entrance", -73.9616, 40.6575, "entrance"),
    ("PP_SEED_014", "Prospect Park Lake north", -73.9681, 40.6574, "info"),
    ("PP_SEED_015", "Prospect Park Lake west", -73.9737, 40.6552, "info"),
    ("PP_SEED_016", "Parkside Avenue entrance", -73.9776, 40.6539, "entrance"),
    ("PP_SEED_017", "Southwest path", -73.9801, 40.6572, "junction"),
    ("PP_SEED_018", "Vanderbilt Street entrance", -73.9796, 40.6606, "entrance"),
    ("PP_SEED_019", "West Drive center", -73.9768, 40.6645, "junction"),
    ("PP_SEED_020", "Third Street entrance", -73.9741, 40.6707, "entrance"),
]

SEED_EDGES: list[tuple[str, str]] = [
    ("PP_SEED_001", "PP_SEED_002"),
    ("PP_SEED_002", "PP_SEED_003"),
    ("PP_SEED_003", "PP_SEED_004"),
    ("PP_SEED_004", "PP_SEED_005"),
    ("PP_SEED_005", "PP_SEED_006"),
    ("PP_SEED_006", "PP_SEED_007"),
    ("PP_SEED_007", "PP_SEED_008"),
    ("PP_SEED_008", "PP_SEED_009"),
    ("PP_SEED_009", "PP_SEED_010"),
    ("PP_SEED_010", "PP_SEED_001"),
    ("PP_SEED_010", "PP_SEED_011"),
    ("PP_SEED_011", "PP_SEED_012"),
    ("PP_SEED_012", "PP_SEED_013"),
    ("PP_SEED_013", "PP_SEED_014"),
    ("PP_SEED_014", "PP_SEED_008"),
    ("PP_SEED_014", "PP_SEED_015"),
    ("PP_SEED_015", "PP_SEED_016"),
    ("PP_SEED_016", "PP_SEED_017"),
    ("PP_SEED_017", "PP_SEED_018"),
    ("PP_SEED_018", "PP_SEED_019"),
    ("PP_SEED_019", "PP_SEED_005"),
    ("PP_SEED_019", "PP_SEED_020"),
    ("PP_SEED_020", "PP_SEED_003"),
    ("PP_SEED_007", "PP_SEED_014"),
    ("PP_SEED_006", "PP_SEED_011"),
]

SEED_POIS: list[tuple[str, str, float, float, str]] = [
    ("PP_POI_RESTROOM_001", "Restroom near Picnic House", -73.9735, 40.6650, "restroom"),
    ("PP_POI_WATER_001", "Water fountain near Bandshell", -73.9706, 40.6635, "water"),
    ("PP_POI_INFO_001", "Boathouse landmark", -73.9658, 40.6608, "info"),
    ("PP_POI_RECREATION_001", "Zoo area", -73.9654, 40.6650, "recreation"),
]


def meters_from_lonlat(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    radius = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.atan2(math.sqrt(h), math.sqrt(1 - h))


def normalize_category(tags: dict[str, Any]) -> str:
    text = " ".join(str(tags.get(k, "")) for k in POI_TAGS).lower()
    if "toilet" in text or "restroom" in text or "bathroom" in text:
        return "restroom"
    if "drinking_water" in text or "water" in text:
        return "water"
    if "cafe" in text or "restaurant" in text or "fast_food" in text or "food" in text:
        return "food"
    if "information" in text or "attraction" in text or "viewpoint" in text or "museum" in text:
        return "info"
    if "first_aid" in text:
        return "first_aid"
    if "shelter" in text:
        return "shelter"
    if "picnic" in text:
        return "picnic"
    if "playground" in text or "sports" in text or "pitch" in text:
        return "recreation"
    if "entrance" in text or "gate" in text:
        return "entrance"
    if any(tags.get(k) for k in POI_TAGS):
        return "other"
    return "core"


def display_name(element_id: int, tags: dict[str, Any], fallback: str) -> str:
    for key in ("name", "official_name", "description"):
        value = tags.get(key)
        if value:
            return str(value)
    for key in ("amenity", "tourism", "leisure", "entrance", "barrier", "highway"):
        value = tags.get(key)
        if value:
            return str(value).replace("_", " ").title()
    return fallback or f"Prospect Park node {element_id}"


def overpass_query() -> str:
    south, west, north, east = PROSPECT_BBOX
    highway_regex = "|".join(sorted(WALKABLE_HIGHWAYS))
    return f"""
[out:json][timeout:120];
rel["name"="Prospect Park"]["leisure"="park"]({south},{west},{north},{east});
map_to_area -> .park;
(
  way(area.park)["highway"~"^({highway_regex})$"];
  node(area.park)["amenity"];
  node(area.park)["tourism"];
  node(area.park)["leisure"];
  node(area.park)["entrance"];
  node(area.park)["barrier"];
  node(area.park)["shop"];
  node(area.park)["historic"];
  node(area.park)["natural"];
);
out body geom;
""".strip()


def fetch_overpass() -> dict[str, Any]:
    response = requests.post(OVERPASS_URL, data={"data": overpass_query()}, timeout=180)
    response.raise_for_status()
    return response.json()


def build_seed_graph() -> nx.Graph:
    graph = nx.Graph()
    node_lookup = {node_id: (name, lon, lat, category) for node_id, name, lon, lat, category in SEED_NODES}

    for node_id, name, lon, lat, category in SEED_NODES:
        graph.add_node(
            node_id,
            geometry=Point((lon, lat)),
            node_type="junction" if category == "junction" else "path",
            node_subtype=category,
            name=name,
            notes="Prospect Park offline seed graph node.",
            lon=lon,
            lat=lat,
        )

    for index, (u, v) in enumerate(SEED_EDGES, start=1):
        _, lon_u, lat_u, _ = node_lookup[u]
        _, lon_v, lat_v, _ = node_lookup[v]
        coords = [(lon_u, lat_u), (lon_v, lat_v)]
        graph.add_edge(
            u,
            v,
            edge_id=f"PP_SEED_EDGE_{index:03d}",
            parent_edge_id="seed",
            geometry=LineString(coords),
            length_m=meters_from_lonlat(coords[0], coords[1]),
            sinuosity=1.0,
            cum_turn_deg=0.0,
            curvature=0.0,
            near_road_crossing=False,
            has_stairs=False,
            has_signalized_crossing=False,
            surface="unknown",
            highway="path",
            name="Prospect Park seed path",
        )

    graph.graph["crs"] = "EPSG:4326"
    graph.graph["park_id"] = "prospect_park"
    graph.graph["park_name"] = "Prospect Park"
    graph.graph["source"] = "offline_seed"
    return graph


def seed_poi_features() -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = []
    for node_id, name, lon, lat, category in SEED_POIS:
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "node_id": node_id,
                    "grid_node_code": node_id,
                    "display_name": name,
                    "node_type": "poi",
                    "node_subtype": category,
                    "display_group": category,
                    "description": "Prospect Park offline seed point of interest.",
                    "infra_type": category,
                    "infra_class": category,
                    "park_id": "prospect_park",
                },
            }
        )
    return features


def element_tags(element: dict[str, Any]) -> dict[str, Any]:
    tags = element.get("tags")
    return tags if isinstance(tags, dict) else {}


def is_walkable_way(element: dict[str, Any]) -> bool:
    tags = element_tags(element)
    return str(tags.get("highway", "")).lower() in WALKABLE_HIGHWAYS


def way_geometry(element: dict[str, Any]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for point in element.get("geometry", []) or []:
        try:
            out.append((float(point["lon"]), float(point["lat"])))
        except Exception:
            continue
    return out


def add_way_to_graph(graph: nx.Graph, way: dict[str, Any]) -> None:
    coords = way_geometry(way)
    if len(coords) < 2:
        return
    node_ids = way.get("nodes") or []
    if len(node_ids) != len(coords):
        node_ids = [f"{way['id']}:{index}" for index in range(len(coords))]

    tags = element_tags(way)
    has_stairs = str(tags.get("highway", "")).lower() == "steps"
    surface = str(tags.get("surface") or "unknown").lower()
    near_crossing = str(tags.get("crossing") or tags.get("footway") or "").lower() in {
        "crossing",
        "marked",
        "uncontrolled",
        "traffic_signals",
    }
    signalized = str(tags.get("crossing") or "").lower() == "traffic_signals"

    for raw_id, coord in zip(node_ids, coords):
        node_id = f"PP{raw_id}"
        graph.add_node(
            node_id,
            geometry=Point(coord),
            node_type="path",
            node_subtype=str(tags.get("highway") or "walkable"),
            name=display_name(int(way["id"]), tags, node_id),
            notes=str(tags.get("surface") or tags.get("footway") or ""),
            lon=coord[0],
            lat=coord[1],
        )

    for index, (raw_u, raw_v) in enumerate(zip(node_ids[:-1], node_ids[1:])):
        u, v = f"PP{raw_u}", f"PP{raw_v}"
        a, b = coords[index], coords[index + 1]
        length_m = meters_from_lonlat(a, b)
        if length_m <= 0.05:
            continue
        graph.add_edge(
            u,
            v,
            edge_id=f"PPW{way['id']}:{index}",
            parent_edge_id=f"way:{way['id']}",
            geometry=LineString([a, b]),
            length_m=length_m,
            sinuosity=1.0,
            cum_turn_deg=0.0,
            curvature=0.0,
            near_road_crossing=near_crossing,
            has_stairs=has_stairs,
            has_signalized_crossing=signalized,
            surface=surface,
            highway=str(tags.get("highway") or ""),
            name=str(tags.get("name") or ""),
        )


def graph_node_features(graph: nx.Graph) -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = []
    for index, (node_id, attrs) in enumerate(graph.nodes(data=True), start=1):
        degree = graph.degree[node_id]
        node_type = "junction" if degree >= 3 else attrs.get("node_type", "path")
        code = f"PP{index:05d}"
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [attrs["lon"], attrs["lat"]]},
                "properties": {
                    "node_id": node_id,
                    "grid_node_code": code,
                    "display_name": attrs.get("name") or code,
                    "node_type": node_type,
                    "node_subtype": attrs.get("node_subtype") or "walkable",
                    "display_group": node_type,
                    "description": attrs.get("notes") or "Prospect Park walkable path node.",
                    "infra_type": node_type,
                    "infra_class": "junction" if degree >= 3 else "core",
                    "park_id": "prospect_park",
                },
            }
        )
    return features


def poi_features(elements: list[dict[str, Any]], graph: nx.Graph) -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = []
    seen_points = {(round(float(attrs["lon"]), 7), round(float(attrs["lat"]), 7)) for _, attrs in graph.nodes(data=True)}
    for element in elements:
        if element.get("type") != "node":
            continue
        tags = element_tags(element)
        if not any(key in tags for key in POI_TAGS):
            continue
        try:
            lon = float(element["lon"])
            lat = float(element["lat"])
        except Exception:
            continue
        key = (round(lon, 7), round(lat, 7))
        if key in seen_points and "name" not in tags:
            continue
        node_id = f"PPPOI{element['id']}"
        category = normalize_category(tags)
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "node_id": node_id,
                    "grid_node_code": node_id,
                    "display_name": display_name(int(element["id"]), tags, node_id),
                    "node_type": "poi",
                    "node_subtype": category,
                    "display_group": category,
                    "description": json.dumps(tags, ensure_ascii=False),
                    "infra_type": category,
                    "infra_class": category,
                    "park_id": "prospect_park",
                    **{f"osm_{key}": value for key, value in tags.items()},
                },
            }
        )
    return features


def edge_features(graph: nx.Graph) -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = []
    for u, v, attrs in graph.edges(data=True):
        coords = [[float(x), float(y)] for x, y in attrs["geometry"].coords]
        props = {key: value for key, value in attrs.items() if key != "geometry"}
        props.update({"source": u, "target": v, "park_id": "prospect_park"})
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": props,
            }
        )
    return features


def write_geojson(path: Path, features: list[dict[str, Any]]) -> None:
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    elements: list[dict[str, Any]] = []
    source = "OpenStreetMap Overpass API"
    graph = nx.Graph()

    try:
        raw = fetch_overpass()
        elements = raw.get("elements", [])
        for element in elements:
            if element.get("type") == "way" and is_walkable_way(element):
                add_way_to_graph(graph, element)

        graph.graph["crs"] = "EPSG:4326"
        graph.graph["park_id"] = "prospect_park"
        graph.graph["park_name"] = "Prospect Park"
    except Exception as exc:
        print(f"Overpass fetch failed, writing offline seed graph instead: {exc}")
        source = "offline_seed"
        graph = build_seed_graph()

    if len(graph.nodes) == 0 or len(graph.edges) == 0:
        print("No Overpass graph was generated, writing offline seed graph instead.")
        source = "offline_seed"
        graph = build_seed_graph()

    nodes = graph_node_features(graph)
    nodes += seed_poi_features() if source == "offline_seed" else poi_features(elements, graph)
    edges = edge_features(graph)
    lons = [float(attrs["lon"]) for _, attrs in graph.nodes(data=True)]
    lats = [float(attrs["lat"]) for _, attrs in graph.nodes(data=True)]

    write_geojson(OUT_DIR / "final_candidate_nodes_gridcoded.geojson", nodes)
    write_geojson(OUT_DIR / "infrastructure_nodes_gridcoded.geojson", [f for f in nodes if f["properties"]["node_type"] == "poi"])
    write_geojson(OUT_DIR / "gate_nodes_gridcoded.geojson", [f for f in nodes if f["properties"].get("infra_class") == "entrance"])
    write_geojson(OUT_DIR / "augmented_graph_edges.geojson", edges)

    with open(OUT_DIR / "park_graph.pkl", "wb") as f:
        pickle.dump(graph, f)

    manifest = {
        "park": "Prospect Park",
        "park_id": "prospect_park",
        "nodes_geojson": "final_candidate_nodes_gridcoded.geojson",
        "infra_geojson": "infrastructure_nodes_gridcoded.geojson",
        "gate_geojson": "gate_nodes_gridcoded.geojson",
        "edges_geojson": "augmented_graph_edges.geojson",
        "graph_pickle": "park_graph.pkl",
        "graph_crs": "EPSG:4326",
        "center": [sum(lats) / len(lats), sum(lons) / len(lons)],
        "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
        "source": source,
        "notes": "Generated with the same walkable-graph contract used by the NYC Park navigation backend. Replace offline_seed output with Overpass output before real navigation testing.",
        "counts": {"nodes": len(graph.nodes), "edges": len(graph.edges), "features": len(nodes)},
    }
    (OUT_DIR / "app_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote Prospect Park data to {OUT_DIR}")
    print(json.dumps(manifest["counts"], indent=2))


if __name__ == "__main__":
    main()
