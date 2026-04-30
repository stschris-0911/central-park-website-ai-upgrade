import type { GeoJSONFeature, RouteEndpointInfo } from "./types";

export function normalizeCategory(feature: GeoJSONFeature): string {
  const raw = String(
    feature.properties.infra_class ??
      feature.properties.infra_type ??
      feature.properties.node_subtype ??
      feature.properties.node_type ??
      feature.properties.display_group ??
      "core"
  ).toLowerCase();

  if (raw.includes("restroom") || raw.includes("toilet")) return "restroom";
  if (raw.includes("water") || raw.includes("drink")) return "water";
  if (raw.includes("food") || raw.includes("cafe") || raw.includes("restaurant")) return "food";
  if (raw.includes("info") || raw.includes("landmark") || raw.includes("visitor")) return "info";
  if (raw.includes("first") || raw.includes("aid") || raw.includes("emergency")) return "first_aid";
  if (raw.includes("shelter")) return "shelter";
  if (raw.includes("picnic")) return "picnic";
  if (raw.includes("recreation") || raw.includes("playground") || raw.includes("sports")) return "recreation";
  if (raw.includes("entrance") || raw.includes("gate")) return "entrance";
  if (raw.includes("other")) return "other";
  return "core";
}

export function colorForCategory(category: string): string {
  if (category === "restroom") return "#2563eb";
  if (category === "water") return "#06b6d4";
  if (category === "food") return "#f59e0b";
  if (category === "info") return "#8b5cf6";
  if (category === "first_aid") return "#dc2626";
  if (category === "shelter") return "#8b5e52";
  if (category === "picnic") return "#22c55e";
  if (category === "recreation") return "#ec4899";
  if (category === "entrance") return "#9ca3af";
  if (category === "other") return "#c0b31a";
  return "#ef4444";
}

export function getNodeId(feature: GeoJSONFeature): string {
  return String(feature.properties.node_id ?? feature.properties.grid_node_code ?? "");
}

export function getNodeCode(feature: GeoJSONFeature): string {
  return String(feature.properties.grid_node_code ?? feature.properties.node_id ?? "N/A");
}

export function getNodeLabel(feature: GeoJSONFeature): string {
  return String(
    feature.properties.display_name ??
      feature.properties.infra_name ??
      feature.properties.name ??
      feature.properties.grid_node_code ??
      feature.properties.node_id ??
      "Node"
  );
}

export function getNodeDescription(feature: GeoJSONFeature): string {
  return String(
    feature.properties.notes ??
      feature.properties.description ??
      feature.properties.infra_type ??
      feature.properties.node_type ??
      "No description available."
  );
}

export function formatRoute(distanceM: number, minutes: number): string {
  return `${(distanceM / 1000).toFixed(2)} km · ${minutes} min walk`;
}

export function endpointLabel(endpoint?: RouteEndpointInfo | null): string {
  return endpoint?.label ?? "";
}
