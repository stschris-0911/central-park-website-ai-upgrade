import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NativeLocationFix = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  speedMetersPerSecond: number | null;
  courseDegrees: number | null;
  timestampMs: number;
  source: "ios-corelocation";
  precise: boolean;
  authorizationStatus: string;
};

type NativeLocationStatus = {
  status: string;
  precise: boolean;
  desiredAccuracy: string;
  distanceFilterMeters: number;
};

type NativeLocationError = {
  message?: string;
};

type HighAccuracyLocationPlugin = {
  start(options?: { distanceFilterMeters?: number }): Promise<NativeLocationStatus>;
  stop(): Promise<{ stopped: boolean }>;
  getCurrentPosition(options?: { timeoutMs?: number }): Promise<NativeLocationFix>;
  addListener(
    eventName: "location",
    listenerFunc: (fix: NativeLocationFix) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "locationError",
    listenerFunc: (error: NativeLocationError) => void
  ): Promise<PluginListenerHandle>;
};

const HighAccuracyLocation = registerPlugin<HighAccuracyLocationPlugin>("HighAccuracyLocation");

export function canUseNativeHighAccuracyLocation(): boolean {
  return Capacitor.getPlatform() === "ios";
}

export async function startNativeHighAccuracyLocation(
  onLocation: (fix: NativeLocationFix) => void,
  onError: (message: string) => void
): Promise<() => void> {
  if (!canUseNativeHighAccuracyLocation()) {
    throw new Error("Native iPhone location is not available on this platform.");
  }

  const locationHandle = await HighAccuracyLocation.addListener("location", onLocation);
  const errorHandle = await HighAccuracyLocation.addListener("locationError", (error) => {
    onError(error.message || "iPhone location failed.");
  });

  let active = true;
  try {
    await HighAccuracyLocation.start({ distanceFilterMeters: 1 });
  } catch (error) {
    await locationHandle.remove();
    await errorHandle.remove();
    throw error;
  }

  return () => {
    if (!active) return;
    active = false;
    void locationHandle.remove();
    void errorHandle.remove();
    void HighAccuracyLocation.stop();
  };
}

export async function getNativeCurrentPosition(timeoutMs = 10000): Promise<NativeLocationFix> {
  if (!canUseNativeHighAccuracyLocation()) {
    throw new Error("Native iPhone location is not available on this platform.");
  }
  return HighAccuracyLocation.getCurrentPosition({ timeoutMs });
}
