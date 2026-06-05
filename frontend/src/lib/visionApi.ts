import { API_BASE_URL, RAW_API_BASE_URL, displayRequestUrl } from "./apiBase";
import {
  analyzeVisionBlobLocally,
  getVisionEnginePreference,
  isNativeLocalVisionCandidate,
  type VisionEnginePreference
} from "./localVision";

export const VISION_API_BASE = API_BASE_URL;
export const VISION_RAW_API_BASE = RAW_API_BASE_URL;
export const VISION_API_BASE_STORAGE_KEY = "centralpark.visionApiBaseUrl";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeVisionApiBase(value: string): string {
  let trimmed = value.trim();
  if (!trimmed) return API_BASE_URL;
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/i.test(trimmed) && !trimmed.startsWith("/")) {
    trimmed = `http://${trimmed}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/api";
    }
    return stripTrailingSlash(url.toString());
  }

  return stripTrailingSlash(trimmed) || API_BASE_URL;
}

function readStoredVisionApiBase(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(VISION_API_BASE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getVisionRawApiBase(): string {
  const stored = readStoredVisionApiBase();
  return stored && stored.trim() ? stored : RAW_API_BASE_URL;
}

export function getVisionApiBase(): string {
  return normalizeVisionApiBase(getVisionRawApiBase());
}

export function saveVisionApiBase(value: string): string {
  const normalized = normalizeVisionApiBase(value);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(VISION_API_BASE_STORAGE_KEY, normalized);
    } catch {
      // Ignore storage failures; the caller can still use the default configured URL.
    }
  }
  return normalized;
}

export function resetVisionApiBase(): string {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(VISION_API_BASE_STORAGE_KEY);
    } catch {
      // Ignore storage failures and fall back to the built-in URL.
    }
  }
  return getVisionApiBase();
}

function visionApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getVisionApiBase()}${normalizedPath}`;
}

export type VisionMode = "open_path" | "crosswalk";

export type VisionRequestInfo = {
  method: "GET" | "POST";
  url: string;
  displayUrl: string;
};

export class VisionApiError extends Error {
  method: string;
  url: string;
  displayUrl: string;
  status?: number;
  responseText?: string;
  causeMessage?: string;

  constructor(
    message: string,
    info: VisionRequestInfo,
    details: { status?: number; responseText?: string; causeMessage?: string } = {}
  ) {
    super(message);
    this.name = "VisionApiError";
    this.method = info.method;
    this.url = info.url;
    this.displayUrl = info.displayUrl;
    this.status = details.status;
    this.responseText = details.responseText;
    this.causeMessage = details.causeMessage;
  }
}

export type VisionHealth = {
  status: string;
  dependencies: Record<string, boolean>;
  models: Record<string, { path: string; exists: boolean; classes: string[]; loaded: boolean }>;
  supports: Record<string, boolean>;
};

export function visionRequestInfo(mode: VisionMode): VisionRequestInfo {
  const endpoint = mode === "crosswalk" ? "analyze-crosswalk" : "analyze-frame";
  const url = visionApiUrl(`/vision/${endpoint}`);
  return {
    method: "POST",
    url,
    displayUrl: displayRequestUrl(url)
  };
}

function visionHealthRequestInfo(): VisionRequestInfo {
  const url = visionApiUrl("/vision/health");
  return {
    method: "GET",
    url,
    displayUrl: displayRequestUrl(url)
  };
}

async function parseJsonResponse<T>(
  response: Response,
  info: VisionRequestInfo,
  fallbackMessage: string
): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let detail = fallbackMessage;
    try {
      const payload = JSON.parse(text);
      detail = payload?.detail || detail;
    } catch {
      // Keep the raw response text below for diagnostics.
    }
    throw new VisionApiError(detail, info, {
      status: response.status,
      responseText: text
    });
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new VisionApiError("Vision response was not valid JSON.", info, {
      status: response.status,
      responseText: text,
      causeMessage: err instanceof Error ? err.message : String(err)
    });
  }
}

async function fetchJson<T>(
  info: VisionRequestInfo,
  fallbackMessage: string,
  init?: RequestInit
): Promise<T> {
  try {
    const response = await fetch(info.url, init);
    return parseJsonResponse<T>(response, info, fallbackMessage);
  } catch (err) {
    if (err instanceof VisionApiError) throw err;
    throw new VisionApiError("Fetch failed.", info, {
      causeMessage: err instanceof Error ? err.message : String(err)
    });
  }
}

export type VisionDetection = {
  label: string;
  class_id: number;
  confidence: number;
  bbox: number[];
  area_ratio: number;
  mask_shape?: number[] | null;
  contour?: number[][] | null;
};

export type VisionTraversable = {
  best_direction: string;
  best_column: number | null;
  best_score?: number;
  best_region?: {
    start_column: number;
    end_column: number;
    center_column: number;
    width_columns: number;
    score: number;
  } | null;
  raw_scores?: number[][] | null;
  adjusted_scores?: number[][] | null;
  column_scores?: number[] | null;
  penalized_scores?: number[] | null;
  curb_penalties?: number[] | null;
  center_preference_applied?: boolean;
  scan_band?: {
    top_y: number;
    bottom_y: number;
    height: number;
    grid_rows: number;
    grid_cols: number;
    estimated_path_top_y?: number | null;
    source?: string | null;
  } | null;
  traversable_area_ratio?: number;
  non_traversable_area_ratio?: number;
  source_area_ratios?: Record<string, number>;
  curb_area_ratio?: number;
  traversable_source?: string | null;
  stop_reason?: string | null;
};

export type VisionAnalysisResponse = {
  engine?: "coreml" | "backend";
  mode: "open_path" | "crosswalk";
  image?: {
    width: number;
    height: number;
  };
  detected_classes: string[];
  detections: VisionDetection[];
  areas: Record<string, number>;
  open_path?: {
    direction: string | null;
    best_column: number | null;
    vibration_intensity: string;
    traversable_source?: string | null;
    raw_scores?: number[][] | null;
    adjusted_scores?: number[][] | null;
  } | null;
  traversable?: VisionTraversable | null;
  curb_warning?: {
    active: boolean;
    curb_type?: string | null;
    fan_position?: string | null;
    fan_zone?: number | null;
    severity?: string;
    distance_score?: number | null;
    avoidance_direction?: string | null;
    guidance?: string | null;
  } | null;
  crosswalk?: {
    activated: boolean;
    offset_ratio: number;
    direction?: string | null;
    intensity: string;
    valid_row_count: number;
  } | null;
  direction: string;
  confidence: number;
  guidance_text: string;
};

export async function fetchVisionHealth(): Promise<VisionHealth> {
  return fetchJson<VisionHealth>(visionHealthRequestInfo(), "Failed to fetch vision health");
}

export async function analyzeVisionFrame(
  file: File,
  mode: VisionMode,
  confidence = 0.4
): Promise<VisionAnalysisResponse> {
  return analyzeVisionBlob(file, mode, confidence, file.name || "frame.jpg");
}

export async function analyzeVisionBlob(
  image: Blob,
  mode: VisionMode,
  confidence = 0.4,
  filename = "frame.jpg"
): Promise<VisionAnalysisResponse> {
  const engine = getVisionEnginePreference();
  if (shouldTryLocalVision(engine)) {
    try {
      const localResult = await analyzeVisionBlobLocally(image, mode, confidence);
      return { ...localResult, engine: localResult.engine ?? "coreml" };
    } catch (err) {
      if (engine === "local") {
        throw err;
      }
      console.warn("Local Core ML vision failed; falling back to backend.", err);
    }
  }

  return analyzeVisionBlobWithBackend(image, mode, confidence, filename);
}

function shouldTryLocalVision(engine: VisionEnginePreference): boolean {
  return engine !== "backend" && isNativeLocalVisionCandidate();
}

async function analyzeVisionBlobWithBackend(
  image: Blob,
  mode: VisionMode,
  confidence = 0.4,
  filename = "frame.jpg"
): Promise<VisionAnalysisResponse> {
  const form = new FormData();
  form.append("file", image, filename);
  form.append("confidence", String(confidence));

  const result = await fetchJson<VisionAnalysisResponse>(
    visionRequestInfo(mode),
    "Vision analysis failed",
    {
      method: "POST",
      body: form
    }
  );
  return { ...result, engine: result.engine ?? "backend" };
}
