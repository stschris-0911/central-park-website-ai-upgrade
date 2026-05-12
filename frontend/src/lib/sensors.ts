import type { LatLon } from "./beacon";

export type PositionFix = {
  point: LatLon;
  accuracyMeters: number | null;
  speedMetersPerSecond: number | null;
  courseDegrees: number | null;
};

export type HeadingFix = {
  headingDegrees: number;
  source: "compass" | "gps-course";
};

type SensorCallbacks = {
  onPosition: (fix: PositionFix) => void;
  onHeading: (fix: HeadingFix) => void;
  onError: (message: string) => void;
};

export async function requestOrientationPermission(): Promise<boolean> {
  const eventCtor = (window as unknown as {
    DeviceOrientationEvent?: typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
  }).DeviceOrientationEvent;

  if (!eventCtor) return false;
  if (typeof eventCtor.requestPermission === "function") {
    try {
      return (await eventCtor.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }

  return true;
}

function headingFromOrientation(event: DeviceOrientationEvent): number | null {
  const iosHeading = (event as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
  if (typeof iosHeading === "number" && Number.isFinite(iosHeading)) {
    return iosHeading;
  }

  if (typeof event.alpha === "number" && Number.isFinite(event.alpha)) {
    return (360 - event.alpha) % 360;
  }

  return null;
}

export async function startNavigationSensors(callbacks: SensorCallbacks): Promise<() => void> {
  const canUseOrientation = await requestOrientationPermission();

  const orientationListener = (event: DeviceOrientationEvent) => {
    const headingDegrees = headingFromOrientation(event);
    if (headingDegrees !== null) {
      callbacks.onHeading({ headingDegrees, source: "compass" });
    }
  };

  if (canUseOrientation) {
    window.addEventListener(
      "deviceorientationabsolute" as keyof WindowEventMap,
      orientationListener as EventListener
    );
    window.addEventListener("deviceorientation", orientationListener);
  }

  let watchId: number | null = null;
  if (!navigator.geolocation) {
    callbacks.onError("Location is not available on this device.");
  } else {
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const point: LatLon = [position.coords.latitude, position.coords.longitude];
        const courseDegrees =
          typeof position.coords.heading === "number" && Number.isFinite(position.coords.heading)
            ? position.coords.heading
            : null;
        const speedMetersPerSecond =
          typeof position.coords.speed === "number" && Number.isFinite(position.coords.speed)
            ? position.coords.speed
            : null;

        callbacks.onPosition({
          point,
          accuracyMeters:
            typeof position.coords.accuracy === "number" && Number.isFinite(position.coords.accuracy)
              ? position.coords.accuracy
              : null,
          speedMetersPerSecond,
          courseDegrees
        });

        if (courseDegrees !== null && speedMetersPerSecond !== null && speedMetersPerSecond >= 1) {
          callbacks.onHeading({ headingDegrees: courseDegrees, source: "gps-course" });
        }
      },
      (error) => callbacks.onError(error.message || "Location permission was denied."),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 1000 }
    );
  }

  return () => {
    window.removeEventListener(
      "deviceorientationabsolute" as keyof WindowEventMap,
      orientationListener as EventListener
    );
    window.removeEventListener("deviceorientation", orientationListener);
    if (watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
  };
}
