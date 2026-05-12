import json
import urllib.parse
import urllib.request
from pathlib import Path


OVERPASS_URL = "https://overpass-api.de/api/interpreter"

QUERY = """
[out:json][timeout:60];
(
  way["name"="Central Park Zoo"]["tourism"="zoo"];
  relation["name"="Central Park Zoo"]["tourism"="zoo"];
  way["name"="Central Park Zoo"];
  relation["name"="Central Park Zoo"];
);
out body;
>;
out skel qt;
"""


def fetch_overpass(query: str) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(
        OVERPASS_URL,
        data=data,
        headers={"User-Agent": "central-park-navigation-app/1.0"},
    )

    with urllib.request.urlopen(req, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def build_node_lookup(elements):
    nodes = {}
    for element in elements:
        if element.get("type") == "node":
            nodes[element["id"]] = [element["lon"], element["lat"]]
    return nodes


def way_to_ring(way, node_lookup):
    coords = []
    for node_id in way.get("nodes", []):
        if node_id in node_lookup:
            coords.append(node_lookup[node_id])

    if len(coords) < 4:
        return None

    if coords[0] != coords[-1]:
        coords.append(coords[0])

    return coords


def main():
    raw = fetch_overpass(QUERY)
    elements = raw.get("elements", [])
    node_lookup = build_node_lookup(elements)

    features = []

    for element in elements:
        if element.get("type") != "way":
            continue

        tags = element.get("tags", {}) or {}
        name = tags.get("name", "")

        if "central park zoo" not in name.lower():
            continue

        ring = way_to_ring(element, node_lookup)
        if not ring:
            continue

        features.append({
            "type": "Feature",
            "properties": {
                "name": name,
                "osm_type": "way",
                "osm_id": element.get("id"),
                "tourism": tags.get("tourism"),
                "access": tags.get("access"),
                "source": "OpenStreetMap Overpass API"
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [ring]
            }
        })

    out = {
        "type": "FeatureCollection",
        "features": features
    }

    out_path = Path("data/app_data/restricted_areas/central_park_zoo.geojson")
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")

    print(f"Saved {len(features)} polygon feature(s) to {out_path}")

    if len(features) == 0:
        print("No Central Park Zoo polygon was found. We may need relation parsing.")


if __name__ == "__main__":
    main()
