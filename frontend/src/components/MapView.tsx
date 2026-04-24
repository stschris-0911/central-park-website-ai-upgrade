import { CircleMarker, GeoJSON, MapContainer, Marker, Polyline, Popup, TileLayer } from "react-leaflet";
import L from "leaflet";
import type { GeoJSONFeature, GeoJSONFeatureCollection } from "../lib/types";
import { colorForCategory, getNodeCode, getNodeDescription, getNodeLabel, normalizeCategory } from "../lib/utils";

type Props = {
  edges: GeoJSONFeatureCollection | null;
  filteredFeatures: GeoJSONFeature[];
  routeCoords: [number, number][] | null;
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

export default function MapView({
  edges,
  filteredFeatures,
  routeCoords,
  startPoint,
  endPoint,
  onNodeClick,
  onEdgeClick
}: Props) {
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

      {startPoint && (
        <CircleMarker center={startPoint} radius={7} pathOptions={{ color: "#1d4ed8", fillColor: "#3b82f6", fillOpacity: 1, weight: 3 }}>
          <Popup>Selected start point</Popup>
        </CircleMarker>
      )}

      {endPoint && (
        <CircleMarker center={endPoint} radius={7} pathOptions={{ color: "#065f46", fillColor: "#10b981", fillOpacity: 1, weight: 3 }}>
          <Popup>Selected destination point</Popup>
        </CircleMarker>
      )}

      {routeCoords && routeCoords.length > 1 && (
        <Polyline positions={routeCoords} pathOptions={{ color: "#1d4ed8", weight: 6, opacity: 0.9 }} />
      )}
    </MapContainer>
  );
}
