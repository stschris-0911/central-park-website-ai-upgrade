import { Capacitor, registerPlugin } from "@capacitor/core";
import type { VisionAnalysisResponse, VisionMode } from "./visionApi";

export type VisionEnginePreference = "auto" | "local" | "backend";

export type LocalVisionHealth = {
  status: string;
  engine: "coreml";
  available: boolean;
  models: Record<string, { path: string; exists: boolean; classes: string[]; loaded: boolean }>;
};

type LocalVisionPlugin = {
  health(): Promise<LocalVisionHealth>;
  analyzeFrame(options: {
    imageBase64: string;
    mode: VisionMode;
    confidence?: number;
  }): Promise<VisionAnalysisResponse>;
};

export const VISION_ENGINE_STORAGE_KEY = "centralpark.visionEngine";

const LocalVision = registerPlugin<LocalVisionPlugin>("LocalVision");

export function isNativeLocalVisionCandidate(): boolean {
  return Capacitor.getPlatform() === "ios";
}

export function getVisionEnginePreference(): VisionEnginePreference {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = window.localStorage.getItem(VISION_ENGINE_STORAGE_KEY);
    if (stored === "auto" || stored === "local" || stored === "backend") {
      return stored;
    }
  } catch {
    // Keep the default auto mode when localStorage is unavailable.
  }
  return "auto";
}

export function saveVisionEnginePreference(value: VisionEnginePreference): VisionEnginePreference {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(VISION_ENGINE_STORAGE_KEY, value);
    } catch {
      // The in-memory selection still applies for this interaction.
    }
  }
  return value;
}

export async function fetchLocalVisionHealth(): Promise<LocalVisionHealth> {
  return LocalVision.health();
}

export async function analyzeVisionBlobLocally(
  image: Blob,
  mode: VisionMode,
  confidence = 0.4
): Promise<VisionAnalysisResponse> {
  const imageBase64 = await blobToBase64(image);
  return LocalVision.analyzeFrame({ imageBase64, mode, confidence });
}

export async function canUseLocalVision(): Promise<boolean> {
  if (!isNativeLocalVisionCandidate()) return false;
  try {
    const health = await fetchLocalVisionHealth();
    return health.available !== false;
  } catch {
    return false;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read camera frame for local vision."));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string") {
        reject(new Error("Camera frame did not produce a base64 payload."));
        return;
      }
      const comma = value.indexOf(",");
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(blob);
  });
}
