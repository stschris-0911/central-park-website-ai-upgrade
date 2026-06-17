import { memo, useMemo } from "react";
import { CircleMarker, GeoJSON, MapContainer, Marker, Polyline, Popup, TileLayer, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { GeoJSONFeature, GeoJSONFeatureCollection } from "../lib/types";
import { colorForCategory, getNodeCode, getNodeDescription, getNodeLabel, normalizeCategory } from "../lib/utils";

type Props = {
  center: [number, number];
  edges: GeoJSONFeatureCollection | null;
  filteredFeatures: GeoJSONFeature[];
  routeCoords: [number, number][] | null;
  routeBeacons: [number, number][];
  startPoint: [number, number] | null;
  endPoint: [number, number] | null;
  currentPoint: [number, number] | null;
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

  if (startPoint && endPoint) {
    const iStart = nearestIndex(clean, startPoint);
    const iEnd = nearestIndex(clean, endPoint);

    if (iStart <= iEnd) {
      clean = clean.slice(iStart, iEnd + 1);
    } else {
      clean = clean.slice(iEnd, iStart + 1).reverse();
    }
  } else if (startPoint) {
    const iStart = nearestIndex(clean, startPoint);
    clean = clean.slice(iStart);
  } else if (endPoint) {
    const iEnd = nearestIndex(clean, endPoint);
    clean = clean.slice(0, iEnd + 1);
  }

  return clean.length > 1 ? clean : coords;
}

function MapTapHandler({ onMapClick }: { onMapClick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(event) {
      const lat = Number(event.latlng.lat);
      const lon = Number(event.latlng.lng);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        onMapClick(lat, lon);
      }
    }
  });

  return null;
}

function MapView({
  center,
  edges,
  filteredFeatures,
  routeCoords,
  routeBeacons,
  startPoint,
  endPoint,
  currentPoint,
  onNodeClick,
  onEdgeClick
}: Props) {
  const displayRouteCoords = useMemo(
    () => trimRouteCoords(routeCoords, startPoint, endPoint),
    [endPoint, routeCoords, startPoint]
  );

  return (
    <div className="map-accessibility-layer" aria-hidden="true">
      <MapContainer
        center={center}
        key={`${center[0]}-${center[1]}`}
        zoom={15}
        className="map-root"
        preferCanvas
        touchZoom="center"
        dragging={true}
        scrollWheelZoom={false}
        doubleClickZoom={true}
        zoomControl={false}
      >
      <MapTapHandler onMapClick={onEdgeClick} />
      <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

      {edges && displayRouteCoords && displayRouteCoords.length > 1 && (
        <GeoJSON
          data={edges as any}
          style={() => ({ color: "#64748b", weight: 2, opacity: 0.16 })}
          onEachFeature={(_feature, layer) => {
            layer.on({
              click: (event: any) => {
                if (event?.originalEvent) {
                  L.DomEvent.stopPropagation(event.originalEvent);
                }
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

      {displayRouteCoords && displayRouteCoords.length > 1 && (
        <Polyline
          key={displayRouteCoords.map(([lat, lon]) => `${lat},${lon}`).join("|")}
          positions={displayRouteCoords}
          pathOptions={{ color: "#1d4ed8", weight: 6, opacity: 0.9 }}
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
            keyboard={false}
            eventHandlers={{
              click: (event) => {
                if (event.originalEvent) {
                  L.DomEvent.stopPropagation(event.originalEvent);
                }
                onNodeClick(feature);
              }
            }}
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

      {routeBeacons.map((beacon, index) => (
        <CircleMarker
          key={`temporary-beacon-${index}-${beacon[0]}-${beacon[1]}`}
          center={beacon}
          radius={5}
          pathOptions={{
            color: "#92400e",
            fillColor: "#facc15",
            fillOpacity: 0.95,
            opacity: 1,
            weight: 2
          }}
        >
          <Popup>Audio waypoint {index + 1}</Popup>
        </CircleMarker>
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

      {currentPoint && (
        <CircleMarker
          key={`current-${currentPoint[0]}-${currentPoint[1]}`}
          center={currentPoint}
          radius={8}
          pathOptions={{ color: "#ffffff", fillColor: "#2563eb", fillOpacity: 1, weight: 4 }}
        >
          <Popup>Current location</Popup>
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
      </MapContainer>
    </div>
  );
}

export default memo(MapView);
