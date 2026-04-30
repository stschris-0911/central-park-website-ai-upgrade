import { CircleMarker, GeoJSON, MapContainer, Marker, Polyline, Popup, TileLayer } from "react-leaflet";
import L from "leaflet";
import type { GeoJSONFeature, GeoJSONFeatureCollection, RoutePathNode } from "../lib/types";
import { colorForCategory, getNodeCode, getNodeDescription, getNodeLabel, normalizeCategory } from "../lib/utils";

type Props = {
  edges: GeoJSONFeatureCollection | null;
  filteredFeatures: GeoJSONFeature[];
  routeCoords: [number, number][] | null;
  pathNodes?: RoutePathNode[];
  startPoint: [number, number] | null;
  endPoint: [number, number] | null;
  onNodeClick: (feature: GeoJSONFeature) => void;
  onEdgeClick: (lat: number, lon: number) => void;
};

function createDotIcon(color: string) {
  return L.divIcon({
    className: "custom-node-icon",
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
}

function createTriangleIcon() {
  return L.divIcon({
    className: "route-waypoint-triangle-icon",
    html: `<div style="
      width:0;
      height:0;
      border-left:8px solid transparent;
      border-right:8px solid transparent;
      border-bottom:16px solid #dc2626;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.45));
    "></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
}

function metersBetween(a: [number, number], b: [number, number]) {
  const r = 6371000;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function distSq(a: [number, number], b: [number, number]) {
  const dy = a[0] - b[0];
  const dx = a[1] - b[1];
  return dx * dx + dy * dy;
}

function nearestIndex(coords: [number, number][], target: [number, number]) {
  let bestIdx = 0;
  let best = Number.POSITIVE_INFINITY;

  coords.forEach((pt, i) => {
    const d = distSq(pt, target);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  });

  return bestIdx;
}

function dedupeCoords(coords: [number, number][]) {
  const out: [number, number][] = [];

  for (const pt of coords) {
    const last = out[out.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) {
      out.push(pt);
    }
  }

  return out;
}

function trimRouteCoords(
  coords: [number, number][] | null,
  startPoint: [number, number] | null,
  endPoint: [number, number] | null
): [number, number][] | null {
  if (!coords || coords.length < 2) return coords;

  let clean = dedupeCoords(coords);

  if (startPoint && clean.length > 1) {
    const iStart = nearestIndex(clean, startPoint);
    clean = clean.slice(iStart);
  }

  return clean.length > 1 ? clean : coords;
}

function closestPointOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): [number, number] {
  const px = p[1];
  const py = p[0];
  const ax = a[1];
  const ay = a[0];
  const bx = b[1];
  const by = b[0];

  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;

  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return a;

  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));

  return [ay + t * aby, ax + t * abx];
}

function bestAccessPointOnRoute(
  coords: [number, number][],
  endPoint: [number, number]
): { index: number; point: [number, number]; distance: number } {
  let bestIndex = 0;
  let bestPoint = coords[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < coords.length - 1; i++) {
    const projected = closestPointOnSegment(endPoint, coords[i], coords[i + 1]);
    const d = metersBetween(projected, endPoint);

    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
      bestPoint = projected;
    }
  }

  return { index: bestIndex, point: bestPoint, distance: bestDistance };
}

function appendEndPointIfNeeded(
  coords: [number, number][] | null,
  _endPoint: [number, number] | null
): [number, number][] | null {
  // Safety rule:
  // The blue route must stay strictly on the walkable path network.
  // Do not draw any direct connector from the walkable graph to a POI,
  // because that connector may cross non-walkable space.
  return coords;
}

function angleAt(a: [number, number], b: [number, number], c: [number, number]) {
  const v1x = b[1] - a[1];
  const v1y = b[0] - a[0];
  const v2x = c[1] - b[1];
  const v2y = c[0] - b[0];

  const n1 = Math.sqrt(v1x * v1x + v1y * v1y);
  const n2 = Math.sqrt(v2x * v2x + v2y * v2y);

  if (n1 === 0 || n2 === 0) return 0;

  let cosv = (v1x * v2x + v1y * v2y) / (n1 * n2);
  cosv = Math.max(-1, Math.min(1, cosv));

  return (Math.acos(cosv) * 180) / Math.PI;
}

function makeRouteTrianglePoints(coords: [number, number][] | null) {
  if (!coords || coords.length < 3) return [];

  const points: { point: [number, number]; label: string; reason: string }[] = [];
  let running = 0;

  for (let i = 1; i < coords.length - 1; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const next = coords[i + 1];

    running += metersBetween(prev, curr);
    const turn = angleAt(prev, curr, next);

    const longEnough = running >= 45;
    const curvedEnough = turn >= 15;

    if (longEnough || curvedEnough) {
      points.push({
        point: curr,
        label: `Route waypoint ${points.length + 1}`,
        reason: curvedEnough ? "curved segment" : "long segment"
      });
      running = 0;
    }
  }

  return points;
}

function isRouteWaypoint(node: RoutePathNode) {
  return (
    node.category === "route_waypoint" ||
    node.category === "waypoint" ||
    (typeof node.node_id === "string" && node.node_id.startsWith("route_waypoint:"))
  );
}

export default function MapView({
  edges,
  filteredFeatures,
  routeCoords,
  pathNodes = [],
  startPoint,
  endPoint,
  onNodeClick,
  onEdgeClick
}: Props) {
  const trimmedCoords = trimRouteCoords(routeCoords, startPoint, endPoint);
  const displayRouteCoords = appendEndPointIfNeeded(trimmedCoords, endPoint);
  const backendWaypointNodes = pathNodes.filter(isRouteWaypoint);
  const frontendWaypointNodes: { point: [number, number]; label: string; reason: string }[] = [];

  return (
    <MapContainer center={[40.7736, -73.9718]} zoom={15} className="map-root" preferCanvas>
      <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

      {edges && (
        <GeoJSON
          data={edges as any}
          style={() => ({ color: "#64748b", weight: 3, opacity: 0.55 })}
          onEachFeature={(_feature, layer) => {
            layer.on({
              click: (event: any) => {
                const lat = Number(event?.latlng?.lat);
                const lon = Number(event?.latlng?.lng);
                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                  onEdgeClick(lat, lon);
                }
              }
            });
          }}
        />
      )}

      {filteredFeatures.map((feature) => {
        const [lon, lat] = feature.geometry.coordinates as [number, number];
        const category = normalizeCategory(feature);

        return (
          <Marker
            key={String(feature.properties.node_id ?? feature.properties.grid_node_code ?? `${lat}-${lon}`)}
            position={[lat, lon]}
            icon={createDotIcon(colorForCategory(category))}
            eventHandlers={{ click: () => onNodeClick(feature) }}
          >
            <Popup>
              <div>
                <div><strong>{getNodeLabel(feature)}</strong></div>
                <div>Code: {getNodeCode(feature)}</div>
                <div>Category: {category}</div>
                <div>Description: {getNodeDescription(feature)}</div>
              </div>
            </Popup>
          </Marker>
        );
      })}

      {backendWaypointNodes.map((node, idx) => {
        if (!node.point || node.point.length < 2) return null;

        const lon = Number(node.point[0]);
        const lat = Number(node.point[1]);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        return (
          <Marker
            key={`backend-route-waypoint-${node.node_id ?? idx}-${lat}-${lon}`}
            position={[lat, lon]}
            icon={createTriangleIcon()}
          >
            <Popup>
              <div>
                <div><strong>{node.label ?? `Route waypoint ${idx + 1}`}</strong></div>
                <div>Category: {node.category ?? "route_waypoint"}</div>
                <div>{node.description ?? "Temporary waypoint added after route generation."}</div>
              </div>
            </Popup>
          </Marker>
        );
      })}

      {frontendWaypointNodes.map((item, idx) => (
        <Marker
          key={`frontend-route-waypoint-${idx}-${item.point[0]}-${item.point[1]}`}
          position={item.point}
          icon={createTriangleIcon()}
        >
          <Popup>
            <div>
              <div><strong>{item.label}</strong></div>
              <div>Category: route_waypoint</div>
              <div>Temporary waypoint added on a {item.reason}.</div>
            </div>
          </Popup>
        </Marker>
      ))}

      {startPoint && (
        <CircleMarker
          key={`start-${startPoint[0]}-${startPoint[1]}`}
          center={startPoint}
          radius={7}
          pathOptions={{ color: "#1d4ed8", fillColor: "#3b82f6", fillOpacity: 1, weight: 3 }}
        >
          <Popup>Selected start point</Popup>
        </CircleMarker>
      )}

      {endPoint && (
        <CircleMarker
          key={`end-${endPoint[0]}-${endPoint[1]}`}
          center={endPoint}
          radius={7}
          pathOptions={{ color: "#065f46", fillColor: "#10b981", fillOpacity: 1, weight: 3 }}
        >
          <Popup>Selected destination point</Popup>
        </CircleMarker>
      )}

      {displayRouteCoords && displayRouteCoords.length > 1 && (
        <Polyline
          key={displayRouteCoords.map(([lat, lon]) => `${lat},${lon}`).join("|")}
          positions={displayRouteCoords}
          pathOptions={{ color: "#1d4ed8", weight: 6, opacity: 0.9 }}
        />
      )}
    </MapContainer>
  );
}
