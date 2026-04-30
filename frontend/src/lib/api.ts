import type {
  ChatResponse,
  GeoJSONFeatureCollection,
  PlanStop,
  RoutePoint,
  RouteRequest,
  RouteResponse
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

async function asJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (!response.ok) {
    let detail = fallbackMessage;
    try {
      const payload = await response.json();
      detail = payload?.detail || detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return response.json();
}

export async function fetchNodes(): Promise<GeoJSONFeatureCollection> {
  return asJson<GeoJSONFeatureCollection>(
    await fetch(`${API_BASE}/nodes`),
    "Failed to fetch nodes"
  );
}

export async function fetchEdges(): Promise<GeoJSONFeatureCollection> {
  return asJson<GeoJSONFeatureCollection>(
    await fetch(`${API_BASE}/edges`),
    "Failed to fetch edges"
  );
}

export async function fetchRoute(payload: RouteRequest): Promise<RouteResponse> {
  return asJson<RouteResponse>(
    await fetch(`${API_BASE}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
    "Failed to compute route"
  );
}

export async function sendChat(
  message: string,
  currentPoint?: RoutePoint | null,
  currentPlan?: PlanStop[]
): Promise<ChatResponse> {
  return asJson<ChatResponse>(
    await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        current_point: currentPoint ?? null,
        current_plan: currentPlan ?? []
      })
    }),
    "Failed to send chat"
  );
}
