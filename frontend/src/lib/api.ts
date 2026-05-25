import type {
  ChatResponse,
  GeoJSONFeatureCollection,
  PlanStop,
  RoutePoint,
  RouteRequest,
  RouteResponse
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

function resolveApiResourceUrl(path: string | null | undefined): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (/^https?:\/\//i.test(API_BASE)) {
    return `${new URL(API_BASE).origin}${path.startsWith("/") ? path : `/${path}`}`;
  }
  return path;
}

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

export type OriginalVisionMode = "crosswalk" | "open_path";

export type OriginalVisionStatus = {
  available: boolean;
  python: string;
  original_dir: string;
  runner: string;
  files: Record<string, { exists: boolean; sha256: string | null; bytes: number }>;
  modules: Record<string, boolean>;
  modes: OriginalVisionMode[];
  message: string;
};

export type OriginalVisionVideoResult = {
  ok: boolean;
  job_id?: string;
  mode: OriginalVisionMode;
  message: string;
  returncode?: number;
  output_url?: string | null;
  output_bytes?: number;
  runtime?: {
    ok?: boolean;
    script?: string;
    frames?: number;
    size?: number[];
    elapsed_seconds?: number;
  } | null;
  stdout?: string;
  stderr?: string;
  status?: OriginalVisionStatus;
};

export async function fetchOriginalVisionStatus(): Promise<OriginalVisionStatus> {
  return asJson<OriginalVisionStatus>(
    await fetch(`${API_BASE}/vision/status`),
    "Failed to fetch original vision status"
  );
}

export async function runOriginalVisionVideo(
  file: File,
  mode: OriginalVisionMode,
  maxFrames = 120
): Promise<OriginalVisionVideoResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("mode", mode);
  form.append("max_frames", String(maxFrames));
  form.append("timeout_seconds", "120");

  const result = await asJson<OriginalVisionVideoResult>(
    await fetch(`${API_BASE}/vision/video`, {
      method: "POST",
      body: form
    }),
    "Failed to run original vision video"
  );

  return {
    ...result,
    output_url: resolveApiResourceUrl(result.output_url)
  };
}
