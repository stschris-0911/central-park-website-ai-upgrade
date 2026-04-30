export type Geometry = {
  type: string;
  coordinates: any;
};

export type GeoJSONFeature = {
  type: "Feature";
  geometry: Geometry;
  properties: Record<string, any>;
};

export type GeoJSONFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
};

export type RoutePoint = {
  lon: number;
  lat: number;
};

export type RouteRequest = {
  start_node_id?: string;
  end_node_id?: string;
  start_point?: RoutePoint;
  end_point?: RoutePoint;
};

export type RouteEndpointInfo = {
  kind: "node" | "point" | "snapped_point";
  label: string;
  code?: string | null;
  category?: string | null;
  description?: string | null;
  point?: [number, number] | null; // [lon, lat]
  node_id?: string | null;
};

export type RoutePathNode = {
  node_id: string;
  label: string;
  code?: string | null;
  category?: string | null;
  description?: string | null;
  point?: [number, number] | null;
};

export type PlanStop = {
  node_id?: string | null;
  label: string;
  code?: string | null;
  category?: string | null;
  description?: string | null;
  point?: [number, number] | null;
  source_query?: string | null;
};

export type LegSummary = {
  order: number;
  start_label: string;
  end_label: string;
  distance_m: number;
  estimated_minutes: number;
};

export type RouteResponse = {
  mode: string;
  route_geojson: GeoJSONFeature;
  summary: {
    distance_m: number;
    estimated_minutes: number;
    description?: string | null;
  };
  start?: RouteEndpointInfo | null;
  end?: RouteEndpointInfo | null;
  path_nodes?: RoutePathNode[];
  stop_sequence?: PlanStop[];
  leg_summaries?: LegSummary[];
};

export type DestinationCandidate = {
  node_id: string;
  label: string;
  code?: string | null;
  category?: string | null;
  description?: string | null;
  point?: [number, number] | null;
  match_score?: number | null;
};

export type ChatResponse = {
  reply: string;
  intent?: string | null;
  normalized_query?: string | null;
  ambiguous?: boolean;
  clarification_question?: string | null;
  destination?: DestinationCandidate | null;
  candidates?: DestinationCandidate[];
  route?: RouteResponse | null;
  plan_stops?: PlanStop[];
  plan_action?: string | null;
};
