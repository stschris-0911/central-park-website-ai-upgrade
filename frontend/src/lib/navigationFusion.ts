import type { BeaconFeedbackMode } from "./audio";
import type { VisionAnalysisResponse, VisionDetection } from "./visionApi";

export type AudioBeaconFusionSnapshot = {
  beaconEnabled: boolean;
  navigationRunning: boolean;
  locationAvailable: boolean;
  headingAvailable: boolean;
  currentWaypoint: number;
  totalWaypoints: number;
  distanceMeters: number | null;
  bearing: number | null;
  heading: number | null;
  angleDiff: number | null;
  mode: BeaconFeedbackMode | "waiting" | "arrived";
};

export type NavigationFusionContext = {
  hasRoute: boolean;
  isNavigating: boolean;
  navigationPrompt: string;
  audioBeacon: AudioBeaconFusionSnapshot;
  fusionStatus: string;
  routeRecovery: {
    active: boolean;
    nearestRouteDistanceMeters: number | null;
    isRerouting: boolean;
  };
};

export type VisionFusionPayload = {
  result: VisionAnalysisResponse;
  uncertain: boolean;
  speechEnabled: boolean;
  feedbackEnabled: boolean;
  timestamp: number;
};

export type FusionPriority = "low" | "vision" | "urgent";

export type FusionDecision = {
  key: string;
  display: string;
  speech: string | null;
  priority: FusionPriority;
  cooldownMs: number;
  suppressBeaconMs: number;
};

const TRAVERSABLE_LABELS = new Set([
  "road",
  "path",
  "sidewalk",
  "pavement",
  "trail",
  "walkway",
  "crosswalk",
  "curb",
  "open_path"
]);

const HIGH_RISK_LABELS = new Set([
  "person",
  "bicycle",
  "bike",
  "car",
  "bus",
  "truck",
  "motorcycle",
  "scooter",
  "bench",
  "pole",
  "stairs",
  "step",
  "curb"
]);

function cleanLabel(label: string): string {
  return label.replace(/[_-]+/g, " ").trim().toLowerCase();
}

function directionText(direction: string | null | undefined): string {
  if (!direction) return "ahead";
  if (direction === "continue" || direction === "center") return "center";
  if (direction === "slight_left") return "slight left";
  if (direction === "slight_right") return "slight right";
  return direction.replace(/_/g, " ");
}

function horizontalPosition(detection: VisionDetection, imageWidth?: number): "left" | "center" | "right" | "ahead" {
  const [x1, , x2] = detection.bbox;
  if (!Number.isFinite(x1) || !Number.isFinite(x2)) return "ahead";

  const centerX = (x1 + x2) / 2;
  const maxX = Math.max(x1, x2);
  const normalized =
    imageWidth && imageWidth > 1 && maxX > 1 ? centerX / imageWidth : maxX <= 1 ? centerX : null;

  if (normalized === null || !Number.isFinite(normalized)) return "ahead";
  if (normalized < 0.38) return "left";
  if (normalized > 0.62) return "right";
  return "center";
}

function strongestObstacle(result: VisionAnalysisResponse): {
  label: string;
  position: "left" | "center" | "right" | "ahead";
  highRisk: boolean;
} | null {
  const imageWidth = result.image?.width;
  const candidates = result.detections
    .map((detection) => ({ detection, label: cleanLabel(detection.label) }))
    .filter(({ label }) => label && !TRAVERSABLE_LABELS.has(label))
    .sort((a, b) => {
      const scoreA = a.detection.confidence * Math.max(0.01, a.detection.area_ratio || 0.01);
      const scoreB = b.detection.confidence * Math.max(0.01, b.detection.area_ratio || 0.01);
      return scoreB - scoreA;
    });

  const top = candidates[0];
  if (!top) return null;

  const position = horizontalPosition(top.detection, imageWidth);
  const highRisk =
    HIGH_RISK_LABELS.has(top.label) ||
    top.detection.area_ratio >= 0.08 ||
    top.detection.confidence >= 0.72;

  return {
    label: top.label,
    position,
    highRisk
  };
}

function routeSuffix(context: NavigationFusionContext): string {
  if (!context.isNavigating) return "";
  const waypoint =
    context.audioBeacon.currentWaypoint > 0 && context.audioBeacon.totalWaypoints > 0
      ? `Waypoint ${context.audioBeacon.currentWaypoint}/${context.audioBeacon.totalWaypoints}`
      : "";
  const distance =
    context.audioBeacon.distanceMeters !== null
      ? `${Math.round(context.audioBeacon.distanceMeters)} m`
      : "";
  return [waypoint, distance].filter(Boolean).join(" · ");
}

function recoveryDistanceText(context: NavigationFusionContext): string {
  const distance = context.routeRecovery.nearestRouteDistanceMeters;
  if (typeof distance !== "number" || !Number.isFinite(distance)) return "off walkable path";
  return `${Math.round(distance)} m from walkable path`;
}

export function buildVisionFusionDecision(
  payload: VisionFusionPayload,
  context: NavigationFusionContext
): FusionDecision {
  const { result, uncertain } = payload;
  const route = routeSuffix(context);

  if (result.curb_warning?.active) {
    const position = directionText(result.curb_warning.fan_position);
    const avoidance = directionText(result.curb_warning.avoidance_direction);
    const severity = result.curb_warning.severity ?? "warning";
    const speech =
      result.curb_warning.guidance ||
      (avoidance && avoidance !== "ahead"
        ? `Curb ${position}. Move ${avoidance}.`
        : `Curb ${position}. Stop.`);
    return {
      key: `curb:${position}:${avoidance}:${severity}:${result.curb_warning.fan_zone ?? "zone"}`,
      display: route ? `${speech} · ${route}` : speech,
      speech,
      priority: "urgent",
      cooldownMs: 1050,
      suppressBeaconMs: 1800
    };
  }

  const direction = result.traversable?.best_direction || result.direction;
  if (direction === "stop") {
    const speech = "Stop. Path blocked.";
    return {
      key: "vision:stop",
      display: route ? `${speech} · ${route}` : speech,
      speech,
      priority: "urgent",
      cooldownMs: 900,
      suppressBeaconMs: 2000
    };
  }

  const obstacle = strongestObstacle(result);
  if (obstacle && (obstacle.highRisk || obstacle.position === "center")) {
    const position = obstacle.position === "center" ? "ahead" : obstacle.position;
    const speech = `Obstacle ${position}: ${obstacle.label}.`;
    return {
      key: `obstacle:${obstacle.position}:${obstacle.label}`,
      display: route ? `${speech} · ${route}` : speech,
      speech,
      priority: obstacle.position === "center" || obstacle.highRisk ? "vision" : "low",
      cooldownMs: 1800,
      suppressBeaconMs: obstacle.position === "center" ? 1100 : 650
    };
  }

  if (context.routeRecovery.active) {
    const recoveryDistance = recoveryDistanceText(context);
    if (direction === "left" || direction === "right" || direction === "slight_left" || direction === "slight_right") {
      const pathDirection = directionText(direction);
      const speech = `Walkable path ${pathDirection}.`;
      return {
        key: `recovery:path:${direction}:${Math.round(context.routeRecovery.nearestRouteDistanceMeters ?? 0)}`,
        display: route ? `${recoveryDistance}. ${speech} · ${route}` : `${recoveryDistance}. ${speech}`,
        speech: uncertain ? null : speech,
        priority: "vision",
        cooldownMs: 1350,
        suppressBeaconMs: 750
      };
    }

    if (direction === "continue" || direction === "center") {
      const speech = "Walkable path ahead.";
      return {
        key: `recovery:path:ahead:${Math.round(context.routeRecovery.nearestRouteDistanceMeters ?? 0)}`,
        display: route ? `${recoveryDistance}. ${speech} · ${route}` : `${recoveryDistance}. ${speech}`,
        speech: uncertain ? null : speech,
        priority: "vision",
        cooldownMs: 1500,
        suppressBeaconMs: 650
      };
    }

    return {
      key: `recovery:scan:${Math.round(context.routeRecovery.nearestRouteDistanceMeters ?? 0)}`,
      display: route ? `${recoveryDistance}. Scan for walkable path. · ${route}` : `${recoveryDistance}. Scan for walkable path.`,
      speech: uncertain ? null : "Scan for walkable path.",
      priority: "vision",
      cooldownMs: 2200,
      suppressBeaconMs: 900
    };
  }

  if (result.crosswalk?.activated) {
    const crosswalkDirection = directionText(result.crosswalk.direction);
    const speech = crosswalkDirection === "center" ? "Crosswalk ahead." : `Crosswalk ${crosswalkDirection}.`;
    return {
      key: `crosswalk:${crosswalkDirection}:${result.crosswalk.intensity}`,
      display: route ? `${speech} · ${route}` : speech,
      speech,
      priority: "vision",
      cooldownMs: 2600,
      suppressBeaconMs: 450
    };
  }

  if (direction === "left" || direction === "right" || direction === "slight_left" || direction === "slight_right") {
    const phrase = `Path ${directionText(direction)}.`;
    return {
      key: `path:${direction}`,
      display: route ? `${phrase} · ${route}` : phrase,
      speech: uncertain ? null : phrase,
      priority: "vision",
      cooldownMs: 2100,
      suppressBeaconMs: 500
    };
  }

  if (uncertain) {
    const speech = context.isNavigating ? null : "Vision uncertain.";
    return {
      key: "vision:uncertain",
      display: route ? `Vision uncertain. · ${route}` : "Vision uncertain.",
      speech,
      priority: "low",
      cooldownMs: 4200,
      suppressBeaconMs: 0
    };
  }

  const clear = context.isNavigating ? "Path clear. Navigation active." : "Path clear.";
  return {
    key: "vision:clear",
    display: route ? `${clear} · ${route}` : clear,
    speech: context.isNavigating ? null : "Path clear.",
    priority: "low",
    cooldownMs: 5200,
    suppressBeaconMs: 0
  };
}
