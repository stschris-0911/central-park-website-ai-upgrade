import type { LatLon } from "./beacon";
import {
  canUseNativeHighAccuracyLocation,
  getNativeCurrentPosition,
  startNativeHighAccuracyLocation,
  type NativeLocationFix
} from "./highAccuracyLocation";

export type PositionFix = {
  point: LatLon;
  accuracyMeters: number | null;
  speedMetersPerSecond: number | null;
  courseDegrees: number | null;
  timestampMs: number;
  source: "ios-corelocation" | "web-geolocation" | "manual";
  precise?: boolean;
};

export type HeadingFix = {
  headingDegrees: number;
  source: "gps-course";
};

type SensorCallbacks = {
  onPosition: (fix: PositionFix) => void;
  onHeading: (fix: HeadingFix) => void;
  onError: (message: string) => void;
};

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positionFixFromNative(fix: NativeLocationFix): PositionFix {
  return {
    point: [fix.latitude, fix.longitude],
    accuracyMeters: finiteOrNull(fix.accuracyMeters),
    speedMetersPerSecond: finiteOrNull(fix.speedMetersPerSecond),
    courseDegrees: finiteOrNull(fix.courseDegrees),
    timestampMs: finiteOrNull(fix.timestampMs) ?? Date.now(),
    source: "ios-corelocation",
    precise: fix.precise
  };
}

function positionFixFromWeb(position: GeolocationPosition): PositionFix {
  return {
    point: [position.coords.latitude, position.coords.longitude],
    accuracyMeters: finiteOrNull(position.coords.accuracy),
    speedMetersPerSecond: finiteOrNull(position.coords.speed),
    courseDegrees: finiteOrNull(position.coords.heading),
    timestampMs: position.timestamp || Date.now(),
    source: "web-geolocation"
  };
}

function reportGpsCourse(callbacks: SensorCallbacks, fix: PositionFix) {
  if (
    fix.courseDegrees !== null &&
    fix.speedMetersPerSecond !== null &&
    fix.speedMetersPerSecond >= 0.7
  ) {
    callbacks.onHeading({ headingDegrees: fix.courseDegrees, source: "gps-course" });
  }
}

export async function startNavigationSensors(callbacks: SensorCallbacks): Promise<() => void> {
  let nativeStop: (() => void) | null = null;
  let watchId: number | null = null;

  if (canUseNativeHighAccuracyLocation()) {
    try {
      nativeStop = await startNativeHighAccuracyLocation(
        (nativeFix) => {
          const fix = positionFixFromNative(nativeFix);
          callbacks.onPosition(fix);
          reportGpsCourse(callbacks, fix);
        },
        callbacks.onError
      );
    } catch (error) {
      throw error;
    }
  } else if (!navigator.geolocation) {
    callbacks.onError("Location is not available on this device.");
  } else {
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const fix = positionFixFromWeb(position);
        callbacks.onPosition(fix);
        reportGpsCourse(callbacks, fix);
      },
      (error) => callbacks.onError(error.message || "Location permission was denied."),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 500 }
    );
  }

  return () => {
    nativeStop?.();
    if (watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
  };
}

export async function getCurrentPositionFix(timeoutMs = 10000): Promise<PositionFix> {
  if (canUseNativeHighAccuracyLocation()) {
    return positionFixFromNative(await getNativeCurrentPosition(timeoutMs));
  }

  if (!navigator.geolocation) {
    throw new Error("Location is not available on this device.");
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(positionFixFromWeb(position)),
      (error) => reject(new Error(error.message || "Location permission was denied.")),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 500 }
    );
  });
}
