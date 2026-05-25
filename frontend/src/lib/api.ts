import type {
  ChatResponse,
  GeoJSONFeatureCollection,
  PlanStop,
  RoutePoint,
  RouteRequest,
  RouteResponse
} from "./types";
import { apiUrl } from "./apiBase";

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
    await fetch(apiUrl("/nodes")),
    "Failed to fetch nodes"
  );
}

export async function fetchEdges(): Promise<GeoJSONFeatureCollection> {
  return asJson<GeoJSONFeatureCollection>(
    await fetch(apiUrl("/edges")),
    "Failed to fetch edges"
  );
}

export async function fetchRoute(payload: RouteRequest): Promise<RouteResponse> {
  return asJson<RouteResponse>(
    await fetch(apiUrl("/route"), {
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
    await fetch(apiUrl("/chat"), {
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
