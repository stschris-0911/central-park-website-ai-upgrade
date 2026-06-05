import { useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import Legend from "./components/Legend";
import MapView from "./components/MapView";
import RoutePanel from "./components/RoutePanel";
import TopBar from "./components/TopBar";
import VisionPanel from "./components/VisionPanel";
import { fetchEdges, fetchNodes, fetchRoute, sendChat } from "./lib/api";
import { AudioBeaconEngine, type BeaconFeedbackMode } from "./lib/audio";
import {
  bearingDegrees as beaconBearingDegrees,
  buildBeaconPlan,
  cumulativePolylineMeters,
  distanceMeters as beaconDistanceMeters,
  projectPointOntoPolylineMeters,
  type BeaconPlan,
  type LatLon
} from "./lib/beacon";
import {
  buildVisionFusionDecision,
  type FusionPriority,
  type NavigationFusionContext,
  type VisionFusionPayload
} from "./lib/navigationFusion";
import { getCurrentPositionFix, startNavigationSensors, type HeadingFix, type PositionFix } from "./lib/sensors";
import { canSpeak, speakText, stopSpeaking } from "./lib/speech";
import type {
  ChatResponse,
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  LegSummary,
  PlanStop,
  RouteEndpointInfo,
  RoutePathNode,
  RouteRequest,
  RouteResponse
} from "./lib/types";
import { cleanCoordinateLabel, endpointLabel, formatRoute, getNodeDescription, getNodeId, getNodeLabel } from "./lib/utils";

type Message = {
  role: "user" | "assistant";
  text: string;
};

type RouteSelection =
  | {
      kind: "node";
      label: string;
      description: string;
      point: [number, number];
      payload: { node_id: string };
    }
  | {
      kind: "point";
      label: string;
      description: string;
      point: [number, number];
      payload: { point: { lon: number; lat: number } };
    };

function selectionToRouteRequest(start: RouteSelection, end: RouteSelection): RouteRequest {
  const payload: RouteRequest = { strict_walkable: true };
  if (start.kind === "node") payload.start_node_id = start.payload.node_id;
  if (start.kind === "point") payload.start_point = start.payload.point;
  if (end.kind === "node") payload.end_node_id = end.payload.node_id;
  if (end.kind === "point") payload.end_point = end.payload.point;
  return payload;
}

function makeNodeSelection(feature: GeoJSONFeature): RouteSelection {
  const [lon, lat] = feature.geometry.coordinates as [number, number];
  return {
    kind: "node",
    label: getNodeLabel(feature),
    description: getNodeDescription(feature),
    point: [lat, lon],
    payload: { node_id: getNodeId(feature) }
  };
}

function makePointSelection(lat: number, lon: number, label = "Selected map point"): RouteSelection {
  return {
    kind: "point",
    label,
    description: "Selected on the walkable route network.",
    point: [lat, lon],
    payload: { point: { lon, lat } }
  };
}


function sameCoord(a: [number, number], b: [number, number], eps = 1e-9): boolean {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function cleanRouteCoords(coords: [number, number][]): [number, number][] {
  const out: [number, number][] = [];

  for (const pt of coords) {
    if (out.length > 0 && sameCoord(out[out.length - 1], pt)) {
      continue;
    }

    out.push(pt);

    // Remove immediate backtracking pattern A -> B -> A
    while (out.length >= 3 && sameCoord(out[out.length - 1], out[out.length - 3])) {
      out.splice(out.length - 2, 1);
    }
  }

  return out;
}

function routeSpeech(route: RouteResponse): string {
  const end = endpointLabel(route.end) || "the selected destination";
  return `Route ready to ${end}. Tap Start.`;
}

type NavigationCue = {
  index: number;
  text: string;
};

const NAV_ARRIVAL_METERS = 18;
const NAV_CUE_METERS = 35;
const AUTO_REROUTE_OFF_ROUTE_METERS = 45;
const AUTO_REROUTE_MANUAL_MOVE_METERS = 8;
const AUTO_REROUTE_MIN_INTERVAL_MS = 8000;
const AUTO_REROUTE_MIN_MOVE_METERS = 12;
const AUDIO_WAYPOINT_ARRIVAL_METERS = 5;
const AUDIO_WAYPOINT_MAX_ARRIVAL_METERS = 15;
const AUDIO_OFF_ROUTE_METERS = 24;
const AUDIO_OFF_ROUTE_FIXES = 3;
const LOCATION_ROUTE_LOCK_METERS = 24;
const LOCATION_MAX_ACCEPTED_ACCURACY_METERS = 50;
const LOCATION_REROUTE_MAX_ACCURACY_METERS = 28;
const LOCATION_MAX_FIX_AGE_MS = 15000;
const LOCATION_JUMP_BASE_METERS = 14;
const LOCATION_MAX_REASONABLE_SPEED_MPS = 5.8;
const AUDIO_BEACON_STATUS_INTERVAL_MS = 600;
const HAPTIC_BEACON_MS = 18;
const HAPTIC_ARRIVAL_PATTERN = [28];
const HAPTIC_FINAL_PATTERN = [28, 36, 28];
const FORCED_DECISION_BEACON_SNAP_METERS = 18;

function toRad(value: number): number {
  return (value * Math.PI) / 180;
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const radius = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingDegrees(a: [number, number], b: [number, number]): number {
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLon = toRad(b[1] - a[1]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function angleDeltaDegrees(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function cardinalDirection(degrees: number): string {
  const normalized = (degrees + 360) % 360;
  const names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return names[Math.round(normalized / 45) % 8];
}

function cueTextForTurn(delta: number): string {
  const abs = Math.abs(delta);
  if (abs < 35) return "";
  if (abs < 70) return delta > 0 ? "Slight right" : "Slight left";
  return delta > 0 ? "Turn right" : "Turn left";
}

function nearestRouteIndex(point: [number, number], coords: [number, number][]): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  coords.forEach((coord, index) => {
    const distance = distanceMeters(point, coord);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function isFiniteAccuracy(accuracy: number | null): accuracy is number {
  return typeof accuracy === "number" && Number.isFinite(accuracy);
}

function gpsAccuracyText(accuracyMeters: number | null): string {
  return isFiniteAccuracy(accuracyMeters) ? `${Math.round(accuracyMeters)} m` : "unknown";
}

function buildNavigationCues(coords: [number, number][]): NavigationCue[] {
  if (coords.length < 2) return [];

  const cues: NavigationCue[] = [
    {
      index: 0,
      text: `Head ${cardinalDirection(bearingDegrees(coords[0], coords[1]))}`
    }
  ];

  let lastCueIndex = 0;
  for (let index = 2; index < coords.length - 2; index += 1) {
    const before = bearingDegrees(coords[index - 2], coords[index - 1]);
    const after = bearingDegrees(coords[index], coords[index + 1]);
    const turnText = cueTextForTurn(angleDeltaDegrees(before, after));
    const farEnough = distanceMeters(coords[lastCueIndex], coords[index]) > 28;

    if (turnText && farEnough) {
      cues.push({ index, text: turnText });
      lastCueIndex = index;
    }
  }

  cues.push({ index: coords.length - 1, text: "Arrived" });
  return cues;
}

function waypointArrivalRadiusMeters(accuracyMeters: number | null): number {
  if (!isFiniteAccuracy(accuracyMeters)) return AUDIO_WAYPOINT_ARRIVAL_METERS;
  return Math.max(
    AUDIO_WAYPOINT_ARRIVAL_METERS,
    Math.min(AUDIO_WAYPOINT_MAX_ARRIVAL_METERS, accuracyMeters * 1.5)
  );
}

function autoRerouteThresholdMeters(accuracyMeters: number | null): number {
  if (!isFiniteAccuracy(accuracyMeters)) return AUTO_REROUTE_OFF_ROUTE_METERS;
  return Math.max(25, Math.min(65, accuracyMeters * 2));
}

function forcedBeaconPointsFromPathNodes(pathNodes: readonly RoutePathNode[]): LatLon[] {
  const points: LatLon[] = [];
  for (const node of pathNodes) {
    if (!node.point || node.point.length < 2) continue;
    const [lon, lat] = node.point;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push([lat, lon]);
  }
  return points;
}

function addForcedDecisionBeacons(
  plan: BeaconPlan,
  forcedPoints: readonly LatLon[],
  startCoord: LatLon,
  finalCoord: LatLon
): BeaconPlan {
  if (forcedPoints.length === 0 || plan.samples.length === 0) return plan;

  const indices = new Set(plan.indices);
  for (const point of forcedPoints) {
    if (beaconDistanceMeters(point, startCoord) < 3 || beaconDistanceMeters(point, finalCoord) < 3) {
      continue;
    }

    const nearestSampleIndex = nearestRouteIndex(point, plan.samples);
    if (beaconDistanceMeters(point, plan.samples[nearestSampleIndex]) <= FORCED_DECISION_BEACON_SNAP_METERS) {
      indices.add(nearestSampleIndex);
    }
  }

  const sortedIndices = Array.from(indices).sort((a, b) => a - b);
  return {
    ...plan,
    indices: sortedIndices,
    beacons: sortedIndices.map((index) => [plan.samples[index][0], plan.samples[index][1]] as LatLon)
  };
}

function buildRouteWaypointPlan(coords: readonly LatLon[], forcedPoints: readonly LatLon[] = []): BeaconPlan {
  const finalCoord = coords[coords.length - 1];
  const pharosPlan = addForcedDecisionBeacons(buildBeaconPlan(coords), forcedPoints, coords[0], finalCoord);
  const routeTargets = pharosPlan.beacons
    .map((coord, index) => ({ coord, index }))
    .filter(({ coord, index }) => index > 0 || beaconDistanceMeters(coord, coords[0]) > 0.5);
  const beacons =
    routeTargets.length > 0
      ? routeTargets.map(({ coord }) => [coord[0], coord[1]] as LatLon)
      : [[finalCoord[0], finalCoord[1]] as LatLon];
  const indices =
    routeTargets.length > 0
      ? routeTargets.map(({ index }) => pharosPlan.indices[index])
      : [pharosPlan.samples.length - 1];
  const lastBeacon = beacons[beacons.length - 1];

  if (beaconDistanceMeters(lastBeacon, finalCoord) > 0.5) {
    beacons.push([finalCoord[0], finalCoord[1]]);
    indices.push(pharosPlan.samples.length - 1);
  }

  return {
    ...pharosPlan,
    beacons,
    indices
  };
}

type AudioBeaconDebugMode = BeaconFeedbackMode | "waiting" | "arrived";
type AssistSpeechPriority = "route" | FusionPriority;
type RouteRecoveryStatus = {
  active: boolean;
  nearestRouteDistanceMeters: number | null;
  isRerouting: boolean;
};

type RerouteReason = "off-route" | "manual";

type PendingRerouteRequest = {
  point: LatLon;
  reason: RerouteReason;
  distanceFromRouteMeters: number;
  force: boolean;
};

export type AudioBeaconDebugInfo = {
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
  mode: AudioBeaconDebugMode;
};

type AudioBeaconUpdateOptions = {
  allowWaypointArrival?: boolean;
};

function emptyAudioBeaconDebug(): AudioBeaconDebugInfo {
  return {
    beaconEnabled: false,
    navigationRunning: false,
    locationAvailable: false,
    headingAvailable: false,
    currentWaypoint: 0,
    totalWaypoints: 0,
    distanceMeters: null,
    bearing: null,
    heading: null,
    angleDiff: null,
    mode: "waiting"
  };
}

function emptyRouteRecoveryStatus(): RouteRecoveryStatus {
  return {
    active: false,
    nearestRouteDistanceMeters: null,
    isRerouting: false
  };
}

function speechPriorityRank(priority: AssistSpeechPriority): number {
  if (priority === "urgent") return 3;
  if (priority === "vision") return 2;
  return 1;
}

function speechHoldMs(priority: AssistSpeechPriority): number {
  if (priority === "urgent") return 1900;
  if (priority === "vision") return 950;
  return 650;
}

type RestrictedAreaFeature = {
  type: "Feature";
  properties?: Record<string, unknown>;
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
};

async function loadCentralParkZooBoundary(): Promise<RestrictedAreaFeature[]> {
  try {
    const response = await fetch("/restricted_areas/central_park_zoo.geojson");
    if (!response.ok) {
      console.error("Failed to load Central Park Zoo boundary:", response.status);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data.features) ? data.features : [];
  } catch (error) {
    console.error("Failed to load Central Park Zoo boundary:", error);
    return [];
  }
}

function pointInRingLonLat(point: [number, number], ring: number[][]): boolean {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

function pointInRestrictedAreaLonLat(
  point: [number, number],
  areas: RestrictedAreaFeature[]
): boolean {
  for (const area of areas) {
    const geometry = area.geometry;
    if (!geometry) continue;

    if (geometry.type === "Polygon") {
      const rings = geometry.coordinates as number[][][];
      const outerRing = rings[0];

      if (outerRing && pointInRingLonLat(point, outerRing)) {
        return true;
      }
    }

    if (geometry.type === "MultiPolygon") {
      const polygons = geometry.coordinates as number[][][][];

      for (const polygon of polygons) {
        const outerRing = polygon[0];

        if (outerRing && pointInRingLonLat(point, outerRing)) {
          return true;
        }
      }
    }
  }

  return false;
}

function featureInsideCentralParkZoo(
  feature: GeoJSONFeature,
  zooAreas: RestrictedAreaFeature[]
): boolean {
  const coords = feature.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return false;

  const lon = Number(coords[0]);
  const lat = Number(coords[1]);

  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;

  return pointInRestrictedAreaLonLat([lon, lat], zooAreas);
}

function removeCentralParkZooNodes(
  collection: GeoJSONFeatureCollection,
  zooAreas: RestrictedAreaFeature[]
): GeoJSONFeatureCollection {
  if (!zooAreas.length) return collection;

  return {
    ...collection,
    features: collection.features.filter(
      (feature) => !featureInsideCentralParkZoo(feature, zooAreas)
    )
  };
}

export default function App() {
  const [nodes, setNodes] = useState<GeoJSONFeatureCollection | null>(null);
  const [edges, setEdges] = useState<GeoJSONFeatureCollection | null>(null);
  const [search, setSearch] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "Search a place, tap the map for start, or ask for the nearest restroom." }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [startSelection, setStartSelection] = useState<RouteSelection | null>(null);
  const [endSelection, setEndSelection] = useState<RouteSelection | null>(null);
  const [routeCoords, setRouteCoords] = useState<[number, number][] | null>(null);
  const [routeBeaconPlan, setRouteBeaconPlan] = useState<BeaconPlan | null>(null);
  const [routeSummary, setRouteSummary] = useState("");
  const [routeDescription, setRouteDescription] = useState("");
  const [pathNodes, setPathNodes] = useState<RoutePathNode[]>([]);
  const [routeStartInfo, setRouteStartInfo] = useState<RouteEndpointInfo | null>(null);
  const [routeEndInfo, setRouteEndInfo] = useState<RouteEndpointInfo | null>(null);
  const [planStops, setPlanStops] = useState<PlanStop[]>([]);
  const [legSummaries, setLegSummaries] = useState<LegSummary[]>([]);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const [audioBeaconEnabled, setAudioBeaconEnabled] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<[number, number] | null>(null);
  const [navigationPrompt, setNavigationPrompt] = useState("");
  const [audioBeaconDebug, setAudioBeaconDebug] = useState<AudioBeaconDebugInfo>(
    emptyAudioBeaconDebug
  );
  const [appStatus, setAppStatus] = useState("Search a place, tap the map for start, or ask for the nearest restroom.");
  const [visionTestOpen, setVisionTestOpen] = useState(false);
  const [fusionStatus, setFusionStatus] = useState("Vision is off. Map navigation is ready.");
  const [routeRecoveryStatus, setRouteRecoveryStatus] = useState<RouteRecoveryStatus>(
    emptyRouteRecoveryStatus
  );

  const startSelectionRef = useRef<RouteSelection | null>(null);
  const endSelectionRef = useRef<RouteSelection | null>(null);
  const routeEndInfoRef = useRef<RouteEndpointInfo | null>(null);
  const routeSpeechRef = useRef("");
  const routeCoordsRef = useRef<[number, number][] | null>(null);
  const routeBeaconPlanRef = useRef<BeaconPlan | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const sensorStopRef = useRef<(() => void) | null>(null);
  const audioEngineRef = useRef<AudioBeaconEngine | null>(null);
  const audioBeaconTimerRef = useRef<number | null>(null);
  const lastAutoBeaconPulseAtRef = useRef(0);
  const lastAutoBeaconModeRef = useRef<AudioBeaconDebugMode>("waiting");
  const lastAutoBeaconAngleRef = useRef<number | null>(null);
  const beaconPlanRef = useRef<BeaconPlan | null>(null);
  const audioBeaconIndexRef = useRef(0);
  const routeCumulativeMetersRef = useRef<number[]>([]);
  const currentPositionRef = useRef<LatLon | null>(null);
  const currentAccuracyRef = useRef<number | null>(null);
  const currentPositionTimestampRef = useRef<number | null>(null);
  const isNavigatingRef = useRef(false);
  const gpsEnabledRef = useRef(false);
  const audioBeaconEnabledRef = useRef(false);
  const audioBeaconDebugRef = useRef<AudioBeaconDebugInfo>(emptyAudioBeaconDebug());
  const routeRecoveryStatusRef = useRef<RouteRecoveryStatus>(emptyRouteRecoveryStatus());
  const beaconSuppressedUntilRef = useRef(0);
  const offRouteFixesRef = useRef(0);
  const lastGpsErrorRef = useRef("");
  const lastLocationQualityMessageRef = useRef("");
  const navigationCuesRef = useRef<NavigationCue[]>([]);
  const nextCueIndexRef = useRef(0);
  const lastSpokenNavigationRef = useRef("");
  const rerouteInFlightRef = useRef(false);
  const pendingRerouteRef = useRef<PendingRerouteRequest | null>(null);
  const rerouteRequestSeqRef = useRef(0);
  const lastRerouteAtRef = useRef(0);
  const lastReroutePointRef = useRef<LatLon | null>(null);
  const voiceEnabledRef = useRef(voiceEnabled);
  const activeAssistSpeechRef = useRef<{ priority: AssistSpeechPriority; until: number }>({
    priority: "route",
    until: 0
  });
  const lastAssistSpeechRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  useEffect(() => {
    startSelectionRef.current = startSelection;
  }, [startSelection]);

  useEffect(() => {
    endSelectionRef.current = endSelection;
  }, [endSelection]);

  useEffect(() => {
    routeEndInfoRef.current = routeEndInfo;
  }, [routeEndInfo]);

  useEffect(() => {
    routeCoordsRef.current = routeCoords;
  }, [routeCoords]);

  useEffect(() => {
    routeBeaconPlanRef.current = routeBeaconPlan;
  }, [routeBeaconPlan]);

  useEffect(() => {
    audioBeaconEnabledRef.current = audioBeaconEnabled;
    setAudioBeaconDebug((prev) => ({ ...prev, beaconEnabled: audioBeaconEnabled }));
  }, [audioBeaconEnabled]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  useEffect(() => {
    audioBeaconDebugRef.current = audioBeaconDebug;
  }, [audioBeaconDebug]);

  useEffect(() => {
    routeRecoveryStatusRef.current = routeRecoveryStatus;
  }, [routeRecoveryStatus]);

  useEffect(() => {
    isNavigatingRef.current = isNavigating;
    setAudioBeaconDebug((prev) => ({ ...prev, navigationRunning: isNavigating }));
  }, [isNavigating]);

  useEffect(() => {
    gpsEnabledRef.current = gpsEnabled;
  }, [gpsEnabled]);

  useEffect(() => {
    return () => {
      stopSpeaking();
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      if (audioBeaconTimerRef.current !== null) {
        window.clearInterval(audioBeaconTimerRef.current);
      }
      sensorStopRef.current?.();
      audioEngineRef.current?.close();
    };
  }, []);

  function speak(
    message: string,
    force = false,
    priority: AssistSpeechPriority = "route",
    key = `speech:${message}`,
    cooldownMs = 900
  ) {
    if (!force && !voiceEnabledRef.current) return;
    if (!canSpeak()) {
      setAppStatus("Speech is not available in this browser.");
      return;
    }

    const now = performance.now();
    const active = activeAssistSpeechRef.current;
    if (!force && now < active.until && speechPriorityRank(priority) < speechPriorityRank(active.priority)) {
      return;
    }

    const last = lastAssistSpeechRef.current;
    if (!force && last.key === key && now - last.at < cooldownMs) {
      return;
    }

    activeAssistSpeechRef.current = {
      priority,
      until: now + speechHoldMs(priority)
    };
    lastAssistSpeechRef.current = { key, at: now };

    speakText(message, {
      onStart: () => setIsSpeaking(true),
      onEnd: () => setIsSpeaking(false),
      onError: () => setIsSpeaking(false)
    });
  }

  function addAssistantMessage(text: string, speakMessage = true) {
    setMessages((prev) => [...prev, { role: "assistant", text }]);
    setAppStatus(text);
    if (speakMessage) speak(text);
  }

  function speakNavigation(text: string) {
    if (lastSpokenNavigationRef.current === text) return;
    lastSpokenNavigationRef.current = text;
    setNavigationPrompt(text);
    setAppStatus(text);
    speak(text, false, "route", `nav:${text}`, 1400);
  }

  function stopNavigation(silent = false, keepAudioMs = 0) {
    clearAudioBeaconTimer();
    if (!gpsEnabledRef.current) {
      stopGpsTracking();
    }
    const engine = audioEngineRef.current;
    if (keepAudioMs > 0 && engine) {
      window.setTimeout(() => engine.close(), keepAudioMs);
    } else {
      engine?.close();
    }
    audioEngineRef.current = null;
    beaconPlanRef.current = null;
    audioBeaconIndexRef.current = 0;
    lastAutoBeaconPulseAtRef.current = 0;
    lastAutoBeaconModeRef.current = "waiting";
    lastAutoBeaconAngleRef.current = null;
    routeCumulativeMetersRef.current = [];
    if (!gpsEnabledRef.current) {
      currentPositionRef.current = null;
      currentAccuracyRef.current = null;
      currentPositionTimestampRef.current = null;
    }
    offRouteFixesRef.current = 0;
    rerouteInFlightRef.current = false;
    pendingRerouteRef.current = null;
    rerouteRequestSeqRef.current += 1;
    lastRerouteAtRef.current = 0;
    lastReroutePointRef.current = null;
    updateRouteRecoveryStatus(emptyRouteRecoveryStatus());

    setIsNavigating(false);
    const debugUpdate: Partial<AudioBeaconDebugInfo> = {
      navigationRunning: false,
      locationAvailable: gpsEnabledRef.current && currentPositionRef.current !== null,
      headingAvailable: false,
      heading: null,
      angleDiff: null
    };
    if (!silent) debugUpdate.mode = "waiting";
    updateAudioBeaconDebug(debugUpdate);
    if (!silent) {
      setNavigationPrompt("Navigation stopped");
      setAppStatus("Navigation stopped");
      setFusionStatus("Map navigation stopped. Vision can still run as camera guidance.");
    }
  }

  function stopGpsTracking() {
    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    sensorStopRef.current?.();
    sensorStopRef.current = null;
  }

  function gpsUnavailableMessage(message?: string): string {
    const normalized = (message || "").toLowerCase();
    if (normalized.includes("denied") || normalized.includes("permission")) {
      return "GPS permission denied. Using tapped start point.";
    }
    return "GPS unavailable. Using tapped start point.";
  }

  function handleGpsUnavailable(message?: string) {
    stopGpsTracking();
    gpsEnabledRef.current = false;
    setGpsEnabled(false);
    const friendly = gpsUnavailableMessage(message);
    setAppStatus(friendly);
    if (lastGpsErrorRef.current !== friendly) {
      lastGpsErrorRef.current = friendly;
      addAssistantMessage(friendly, false);
    }
  }

  async function startGpsTrackingForNavigation(): Promise<boolean> {
    if (sensorStopRef.current) return true;

    try {
      sensorStopRef.current = await startNavigationSensors({
        onPosition: processLivePositionFix,
        onHeading: processNavigationHeading,
        onError: handleGpsUnavailable
      });
      return true;
    } catch (error) {
      console.error(error);
      handleGpsUnavailable(error instanceof Error ? error.message : "Location permission was denied.");
      return false;
    }
  }

  function vibrateBrief(pattern: number | number[]) {
    if (!("vibrate" in navigator)) return;
    navigator.vibrate(pattern);
  }

  function pulseIntervalForDistance(distanceMeters: number): number {
    if (distanceMeters > 25) return 1800;
    if (distanceMeters >= 10) return 1200;
    return 700;
  }

  function updateAudioBeaconDebug(update: Partial<AudioBeaconDebugInfo>) {
    const plan = beaconPlanRef.current ?? routeBeaconPlanRef.current;
    setAudioBeaconDebug((prev) => {
      const next = {
        ...prev,
        beaconEnabled: audioBeaconEnabledRef.current,
        navigationRunning: isNavigatingRef.current,
        totalWaypoints: plan?.beacons.length ?? prev.totalWaypoints,
        ...update
      };
      audioBeaconDebugRef.current = next;
      return next;
    });
  }

  function destinationFieldsForReroute(): Pick<RouteRequest, "end_node_id" | "end_point"> | null {
    const selectedEnd = endSelectionRef.current;
    if (selectedEnd?.kind === "node") {
      return { end_node_id: selectedEnd.payload.node_id };
    }
    if (selectedEnd?.kind === "point") {
      return { end_point: selectedEnd.payload.point };
    }

    const routeEnd = routeEndInfoRef.current;
    if (routeEnd?.node_id) {
      return { end_node_id: routeEnd.node_id };
    }
    if (routeEnd?.point) {
      return { end_point: { lon: routeEnd.point[0], lat: routeEnd.point[1] } };
    }

    return null;
  }

  function resetNavigationForRoute(coords: [number, number][], waypointPlan: BeaconPlan, point: LatLon | null) {
    beaconPlanRef.current = waypointPlan;
    audioBeaconIndexRef.current = 0;
    lastAutoBeaconPulseAtRef.current = 0;
    lastAutoBeaconModeRef.current = "waiting";
    lastAutoBeaconAngleRef.current = null;
    routeCumulativeMetersRef.current = cumulativePolylineMeters(coords);
    navigationCuesRef.current = buildNavigationCues(coords);
    nextCueIndexRef.current = 1;
    offRouteFixesRef.current = 0;

    const navigationPoint = point ?? currentPositionRef.current ?? coords[0];
    currentPositionRef.current = navigationPoint;
    setCurrentLocation(navigationPoint);

    const firstCue = navigationCuesRef.current[0]?.text || "Head forward";
    const beaconPrompt = updateAudioBeacon(navigationPoint, currentAccuracyRef.current);
    setNavigationPrompt(
      beaconPrompt
        ? `${beaconPrompt} · ${firstCue}`
        : `Waypoint 1/${waypointPlan.beacons.length} · ${firstCue}`
    );

    if (audioBeaconEnabledRef.current) {
      startAudioBeaconTimer();
    }
  }

  function updateRouteRecoveryStatus(update: Partial<RouteRecoveryStatus>) {
    setRouteRecoveryStatus((prev) => {
      const next = { ...prev, ...update };
      routeRecoveryStatusRef.current = next;
      return next;
    });
  }

  function setLocationQualityStatus(message: string) {
    if (lastLocationQualityMessageRef.current === message) return;
    lastLocationQualityMessageRef.current = message;
    setAppStatus(message);
  }

  function shouldUsePositionFix(fix: PositionFix, previous: LatLon | null): boolean {
    if (fix.source === "manual") return true;

    const now = Date.now();
    if (fix.timestampMs && now - fix.timestampMs > LOCATION_MAX_FIX_AGE_MS) {
      setLocationQualityStatus("Waiting for fresh iPhone location.");
      return false;
    }

    if (
      isFiniteAccuracy(fix.accuracyMeters) &&
      fix.accuracyMeters > LOCATION_MAX_ACCEPTED_ACCURACY_METERS
    ) {
      setLocationQualityStatus(`GPS accuracy low (${gpsAccuracyText(fix.accuracyMeters)}). Move into open sky or use Vision.`);
      return false;
    }

    const previousTimestamp = currentPositionTimestampRef.current;
    if (previous && previousTimestamp && fix.timestampMs) {
      const elapsedSeconds = Math.max(0.4, (fix.timestampMs - previousTimestamp) / 1000);
      const movedMeters = beaconDistanceMeters(previous, fix.point);
      const accuracyAllowance =
        (isFiniteAccuracy(fix.accuracyMeters) ? fix.accuracyMeters : 8) * 0.35 +
        (isFiniteAccuracy(currentAccuracyRef.current) ? currentAccuracyRef.current : 8) * 0.35;
      const plausibleMeters =
        LOCATION_JUMP_BASE_METERS + elapsedSeconds * LOCATION_MAX_REASONABLE_SPEED_MPS + accuracyAllowance;

      if (movedMeters > plausibleMeters) {
        setLocationQualityStatus("GPS jump ignored. Waiting for stable iPhone location.");
        return false;
      }
    }

    if (fix.precise === false) {
      setLocationQualityStatus("Precise Location is off. Turn it on in iOS Settings for better guidance.");
    } else {
      lastLocationQualityMessageRef.current = "";
    }

    return true;
  }

  function routeMatchPosition(point: LatLon, coords: [number, number][]) {
    const cumulative = routeCumulativeMetersRef.current;
    const projection =
      cumulative.length === coords.length
        ? projectPointOntoPolylineMeters(point, coords, cumulative)
        : null;
    const navigationPoint =
      projection && projection.offRouteMeters <= LOCATION_ROUTE_LOCK_METERS ? projection.foot : point;
    const nearestIndex = projection
      ? nearestRouteIndex(navigationPoint, coords)
      : nearestRouteIndex(point, coords);
    const nearestDistance = projection
      ? projection.offRouteMeters
      : distanceMeters(point, coords[nearestIndex]);
    const destinationDistance = distanceMeters(navigationPoint, coords[coords.length - 1]);

    return {
      navigationPoint,
      nearestIndex,
      nearestDistance,
      destinationDistance,
      lockedToRoute: Boolean(projection && projection.offRouteMeters <= LOCATION_ROUTE_LOCK_METERS)
    };
  }

  function storePositionFix(fix: PositionFix, _previous: LatLon | null) {
    const point = fix.point;
    currentPositionRef.current = point;
    currentAccuracyRef.current = fix.accuracyMeters;
    currentPositionTimestampRef.current = fix.timestampMs || Date.now();

    setCurrentLocation(point);
  }

  function maybeUseLiveLocationAsStart(point: LatLon) {
    if (!gpsEnabledRef.current) return;
    if (isNavigatingRef.current || routeCoordsRef.current?.length || startSelectionRef.current) return;

    const selection = makePointSelection(point[0], point[1], "Current location");
    startSelectionRef.current = selection;
    setStartSelection(selection);
    setAppStatus("GPS tracking. Current location set as start.");
  }

  function processLivePositionFix(fix: PositionFix) {
    const previous = currentPositionRef.current;
    if (!shouldUsePositionFix(fix, previous)) return;

    storePositionFix(fix, previous);
    maybeUseLiveLocationAsStart(fix.point);

    const coords = routeCoordsRef.current;
    if (isNavigatingRef.current && coords && coords.length >= 2) {
      processNavigationPosition(fix, true);
    }
  }

  function clearAudioBeaconTimer() {
    if (audioBeaconTimerRef.current !== null) {
      window.clearInterval(audioBeaconTimerRef.current);
      audioBeaconTimerRef.current = null;
    }
  }

  function startAudioBeaconTimer() {
    if (audioBeaconTimerRef.current !== null) return;
    audioBeaconTimerRef.current = window.setInterval(() => {
      if (!isNavigatingRef.current || !audioBeaconEnabledRef.current) {
        clearAudioBeaconTimer();
        return;
      }

      const point = currentPositionRef.current;
      if (!point) {
        updateAudioBeaconDebug({
          locationAvailable: false,
          headingAvailable: false,
          heading: null,
          angleDiff: null,
          mode: "waiting"
        });
        return;
      }

      updateAudioBeacon(point, currentAccuracyRef.current, { allowWaypointArrival: false });
    }, AUDIO_BEACON_STATUS_INTERVAL_MS);
  }

  function playAutomaticBeaconPulse(
    mode: BeaconFeedbackMode,
    distanceMeters: number,
    angleDiff: number
  ) {
    const now = performance.now();
    if (now < beaconSuppressedUntilRef.current) return;

    const intervalMs = pulseIntervalForDistance(distanceMeters);
    const modeChanged = lastAutoBeaconModeRef.current !== mode;
    const previousAngle = lastAutoBeaconAngleRef.current;
    const angleChanged = previousAngle === null || Math.abs(angleDiff - previousAngle) >= 8;
    const intervalElapsed = now - lastAutoBeaconPulseAtRef.current >= intervalMs;

    if (!modeChanged && !angleChanged && !intervalElapsed) return;

    lastAutoBeaconPulseAtRef.current = now;
    lastAutoBeaconModeRef.current = mode;
    lastAutoBeaconAngleRef.current = angleDiff;
    console.log("auto beacon pulse", mode, distanceMeters, angleDiff);

    const engine = audioEngineRef.current;
    if (!engine) {
      console.warn("auto beacon pulse skipped: audio engine not ready");
      return;
    }

    const play =
      mode === "calm"
        ? engine.playTestCalm()
        : mode === "drum-left"
          ? engine.playTestDrumLeft()
          : engine.playTestDrumRight();

    play
      .then(() => {
        vibrateBrief(HAPTIC_BEACON_MS);
      })
      .catch((error) => {
        console.error("auto beacon pulse failed", error);
      });
  }

  function updateAudioBeacon(
    point: LatLon,
    accuracyMeters: number | null,
    options: AudioBeaconUpdateOptions = {}
  ): string {
    const allowWaypointArrival = options.allowWaypointArrival ?? true;
    const plan = beaconPlanRef.current;
    if (!plan || plan.beacons.length === 0) {
      updateAudioBeaconDebug({
        locationAvailable: Boolean(point),
        headingAvailable: false,
        currentWaypoint: 0,
        totalWaypoints: 0,
        distanceMeters: null,
        bearing: null,
        heading: null,
        angleDiff: null,
        mode: "waiting"
      });
      return "";
    }

    const index = Math.min(audioBeaconIndexRef.current, plan.beacons.length - 1);
    const target = plan.beacons[index];
    const coords = routeCoordsRef.current;
    const cumulative = routeCumulativeMetersRef.current;
    const projection =
      coords && cumulative.length === coords.length
        ? projectPointOntoPolylineMeters(point, coords, cumulative)
        : null;
    const navigationPoint = projection ? projection.foot : point;

    const accurateEnoughForOffRoute =
      !isFiniteAccuracy(accuracyMeters) || accuracyMeters <= LOCATION_REROUTE_MAX_ACCURACY_METERS;
    if (projection && projection.offRouteMeters > AUDIO_OFF_ROUTE_METERS && accurateEnoughForOffRoute) {
      offRouteFixesRef.current += 1;
    } else {
      offRouteFixesRef.current = 0;
    }

    const beaconDistance = beaconDistanceMeters(navigationPoint, target);
    const bearing = beaconBearingDegrees(navigationPoint, target);
    const mode: AudioBeaconDebugMode =
      audioBeaconEnabledRef.current && isNavigatingRef.current ? "calm" : "waiting";

    updateAudioBeaconDebug({
      locationAvailable: true,
      headingAvailable: false,
      currentWaypoint: index + 1,
      totalWaypoints: plan.beacons.length,
      distanceMeters: beaconDistance,
      bearing,
      heading: null,
      angleDiff: null,
      mode
    });

    if (allowWaypointArrival && beaconDistance <= waypointArrivalRadiusMeters(accuracyMeters)) {
      if (index >= plan.beacons.length - 1) {
        if (audioBeaconEnabledRef.current) {
          audioEngineRef.current?.playFinal();
        }
        vibrateBrief(HAPTIC_FINAL_PATTERN);
        speakNavigation("Arrived");
        updateAudioBeaconDebug({
          currentWaypoint: plan.beacons.length,
          totalWaypoints: plan.beacons.length,
          distanceMeters: beaconDistance,
          bearing,
          heading: null,
          angleDiff: null,
          mode: "arrived"
        });
        stopNavigation(true, 360);
        return "Arrived";
      }

      audioBeaconIndexRef.current = index + 1;
      if (audioBeaconEnabledRef.current) {
        audioEngineRef.current?.playArrival();
      }
      vibrateBrief(HAPTIC_ARRIVAL_PATTERN);
      const nextText = `Waypoint ${audioBeaconIndexRef.current + 1} of ${plan.beacons.length}`;
      speakNavigation(nextText);
      updateAudioBeacon(point, accuracyMeters, { allowWaypointArrival });
      return nextText;
    }

    if (
      audioBeaconEnabledRef.current &&
      isNavigatingRef.current &&
      audioEngineRef.current
    ) {
      audioEngineRef.current.setUserPose(navigationPoint, target, bearing, accuracyMeters);
      audioEngineRef.current.updateBeaconFeedback({
        angleDiff: 0,
        distanceMeters: beaconDistance,
        bearing,
        heading: bearing
      });
    }

    if (
      audioBeaconEnabledRef.current &&
      isNavigatingRef.current
    ) {
      void playAutomaticBeaconPulse("calm", beaconDistance, 0);
    }

    if (offRouteFixesRef.current >= AUDIO_OFF_ROUTE_FIXES) {
      speakNavigation("Return to route");
      return "Return to route";
    }

    return `Waypoint ${index + 1}/${plan.beacons.length} · ${Math.round(beaconDistance)} m`;
  }

  function processNavigationHeading(_fix: HeadingFix) {
    updateAudioBeaconDebug({
      headingAvailable: false,
      heading: null,
      angleDiff: null
    });

    if (audioBeaconEnabledRef.current) {
      startAudioBeaconTimer();
    }
  }

  function processNavigationPosition(fix: PositionFix, alreadyAccepted = false) {
    const coords = routeCoordsRef.current;
    if (!coords || coords.length < 2) return;

    const point = fix.point;
    const previous = currentPositionRef.current;
    if (!alreadyAccepted) {
      if (!shouldUsePositionFix(fix, previous)) return;
      storePositionFix(fix, previous);
    }

    const beaconPrompt = updateAudioBeacon(point, fix.accuracyMeters);
    if (beaconPrompt === "Arrived") return;

    const { navigationPoint, nearestIndex, nearestDistance, destinationDistance } =
      routeMatchPosition(point, coords);
    const recoveryActive = nearestDistance > AUDIO_OFF_ROUTE_METERS;
    const rerouteThresholdMeters = autoRerouteThresholdMeters(fix.accuracyMeters);
    const accurateEnoughForReroute =
      !isFiniteAccuracy(fix.accuracyMeters) || fix.accuracyMeters <= LOCATION_REROUTE_MAX_ACCURACY_METERS;

    updateRouteRecoveryStatus({
      active: recoveryActive,
      nearestRouteDistanceMeters: nearestDistance,
      isRerouting: rerouteInFlightRef.current
    });

    if (!audioBeaconEnabledRef.current && destinationDistance <= NAV_ARRIVAL_METERS) {
      updateRouteRecoveryStatus({ active: false, nearestRouteDistanceMeters: 0, isRerouting: false });
      speakNavigation("Arrived");
      stopNavigation(true);
      return;
    }

    if (recoveryActive && nearestDistance <= rerouteThresholdMeters) {
      setFusionStatus(
        `Off walkable path by ${Math.round(nearestDistance)} m. Open Vision to follow the visible path back.`
      );
    }

    if (nearestDistance > rerouteThresholdMeters) {
      if (!accurateEnoughForReroute) {
        setNavigationPrompt("GPS accuracy low");
        setFusionStatus(
          `GPS accuracy ${gpsAccuracyText(fix.accuracyMeters)}. Use Vision to confirm the walkable path before rerouting.`
        );
        return;
      }

      const rerouteStarted = requestAutoReroute(point, "off-route", nearestDistance);
      if (rerouteStarted) {
        setNavigationPrompt("Updating route");
        return;
      }

      setNavigationPrompt("Return to route");
      speakNavigation("Return to route");
      return;
    }

    const cues = navigationCuesRef.current;
    while (
      nextCueIndexRef.current < cues.length &&
      cues[nextCueIndexRef.current].index <= nearestIndex
    ) {
      nextCueIndexRef.current += 1;
    }

    const nextCue = cues[nextCueIndexRef.current];
    if (!nextCue) {
      setNavigationPrompt(beaconPrompt || `${Math.round(destinationDistance)} m`);
      return;
    }

    const cueDistance = distanceMeters(navigationPoint, coords[nextCue.index]);
    if (cueDistance <= NAV_CUE_METERS) {
      speakNavigation(nextCue.text);
      nextCueIndexRef.current += 1;
      return;
    }

    const cuePrompt = `${nextCue.text} in ${Math.round(cueDistance)} m`;
    setNavigationPrompt(beaconPrompt ? `${beaconPrompt} · ${cuePrompt}` : cuePrompt);
  }

  function initialNavigationPoint(coords: [number, number][]): LatLon {
    if (gpsEnabledRef.current && currentPositionRef.current) {
      return currentPositionRef.current;
    }
    if (startSelectionRef.current?.point) {
      return startSelectionRef.current.point;
    }
    if (routeStartInfo?.point) {
      return [routeStartInfo.point[1], routeStartInfo.point[0]];
    }
    return coords[0];
  }

  function updateManualNavigationPoint(point: LatLon) {
    const previous = currentPositionRef.current;
    const movedMeters = previous ? beaconDistanceMeters(previous, point) : Infinity;

    processNavigationPosition({
      point,
      accuracyMeters: null,
      speedMetersPerSecond: null,
      courseDegrees: null,
      timestampMs: Date.now(),
      source: "manual"
    });

    const rerouteStarted =
      movedMeters >= AUTO_REROUTE_MANUAL_MOVE_METERS &&
      requestAutoReroute(point, "manual", movedMeters, true);
    if (!rerouteStarted) {
      setAppStatus("Position updated.");
    }
  }

  function requestAutoReroute(
    point: LatLon,
    reason: RerouteReason,
    distanceFromRouteMeters: number,
    force = false
  ): boolean {
    if (!isNavigatingRef.current) return false;
    if (rerouteInFlightRef.current) {
      pendingRerouteRef.current = {
        point,
        reason,
        distanceFromRouteMeters,
        force
      };
      setNavigationPrompt("Updating route");
      return true;
    }
    if (!destinationFieldsForReroute()) return false;

    const now = performance.now();
    const lastPoint = lastReroutePointRef.current;
    const movedSinceLast = lastPoint ? beaconDistanceMeters(lastPoint, point) : Infinity;
    const intervalElapsed = now - lastRerouteAtRef.current >= AUTO_REROUTE_MIN_INTERVAL_MS;

    if (!force && (!intervalElapsed || movedSinceLast < AUTO_REROUTE_MIN_MOVE_METERS)) {
      return false;
    }

    beginAutoReroute(point, reason, distanceFromRouteMeters);
    return true;
  }

  function beginAutoReroute(
    point: LatLon,
    reason: RerouteReason,
    distanceFromRouteMeters: number
  ) {
    lastRerouteAtRef.current = performance.now();
    lastReroutePointRef.current = point;
    rerouteInFlightRef.current = true;
    pendingRerouteRef.current = null;
    const requestSeq = rerouteRequestSeqRef.current + 1;
    rerouteRequestSeqRef.current = requestSeq;
    updateRouteRecoveryStatus({
      active: true,
      nearestRouteDistanceMeters: distanceFromRouteMeters,
      isRerouting: true
    });
    setFusionStatus("Updating route from current position. Map navigation continues.");
    setNavigationPrompt("Updating route");
    speak("Rerouting", false, "route", "nav:rerouting", 5000);

    void autoRerouteFromPoint(requestSeq, point, reason, distanceFromRouteMeters);
  }

  async function autoRerouteFromPoint(
    requestSeq: number,
    point: LatLon,
    reason: RerouteReason,
    distanceFromRouteMeters: number
  ) {
    try {
      const destinationFields = destinationFieldsForReroute();
      if (!destinationFields) {
        setFusionStatus("Cannot update route because the destination is missing.");
        return;
      }

      const route = await fetchRoute({
        start_point: { lon: point[1], lat: point[0] },
        strict_walkable: true,
        ...destinationFields
      });

      if (requestSeq !== rerouteRequestSeqRef.current || !isNavigatingRef.current) {
        return;
      }

      const currentStart = makePointSelection(point[0], point[1], "Current position");
      startSelectionRef.current = currentStart;
      setStartSelection(currentStart);

      applyRoute(route, {
        preserveNavigation: true,
        reroutePoint: point,
        status:
          reason === "manual"
            ? "Route updated from selected position. Map navigation continues."
            : `Route updated after ${Math.round(distanceFromRouteMeters)} m off route.`
      });

      updateRouteRecoveryStatus({
        active: distanceFromRouteMeters > AUDIO_OFF_ROUTE_METERS,
        nearestRouteDistanceMeters: distanceFromRouteMeters,
        isRerouting: false
      });

      speak("Route updated", false, "route", "nav:route-updated", 4000);
    } catch (error) {
      if (requestSeq !== rerouteRequestSeqRef.current || !isNavigatingRef.current) {
        return;
      }
      console.error(error);
      setFusionStatus("Route update failed. Continue toward the last route if safe.");
      setNavigationPrompt("Route update failed");
      speakNavigation("Route update failed");
    } finally {
      if (requestSeq !== rerouteRequestSeqRef.current) {
        return;
      }
      rerouteInFlightRef.current = false;
      updateRouteRecoveryStatus({ isRerouting: false });

      const pending = pendingRerouteRef.current;
      pendingRerouteRef.current = null;
      if (pending && isNavigatingRef.current) {
        const lastPoint = lastReroutePointRef.current;
        const movedSinceLast = lastPoint ? beaconDistanceMeters(lastPoint, pending.point) : Infinity;
        if (pending.force || movedSinceLast >= AUTO_REROUTE_MIN_MOVE_METERS) {
          beginAutoReroute(
            pending.point,
            pending.reason,
            pending.distanceFromRouteMeters
          );
        }
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [nodeData, edgeData, zooAreas] = await Promise.all([
        fetchNodes(),
        fetchEdges(),
        loadCentralParkZooBoundary()
      ]);

      if (!cancelled) {
        setNodes(removeCentralParkZooNodes(nodeData, zooAreas));
        setEdges(edgeData);
      }
    }
    load().catch((error) => {
      console.error(error);
      if (!cancelled) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: "Failed to load backend data. Make sure backend is running and app_data exists." }
        ]);
        setAppStatus("Failed to load backend data.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredFeatures = useMemo(() => {
    if (!nodes) return [];
    const q = search.trim().toLowerCase();
    return nodes.features.filter((feature) => {
      if (!q) return true;
      const haystack = JSON.stringify(feature.properties).toLowerCase();
      return haystack.includes(q);
    });
  }, [nodes, search]);

  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    return filteredFeatures.slice(0, 5);
  }, [filteredFeatures, search]);

  const mapFeatures = useMemo(() => {
    if (!search.trim()) return [];
    return filteredFeatures.slice(0, 40);
  }, [filteredFeatures, search]);

  function applyRoute(
    route: RouteResponse,
    options: { preserveNavigation?: boolean; reroutePoint?: LatLon | null; status?: string } = {}
  ) {
    const routeCoordinates = route.route_geojson.geometry.coordinates as [number, number][];
    const coords = cleanRouteCoords(routeCoordinates.map(([lon, lat]) => [lat, lon] as [number, number]));
    const routePathNodes = route.path_nodes ?? [];
    const waypointPlan = buildRouteWaypointPlan(coords, forcedBeaconPointsFromPathNodes(routePathNodes));
    setRouteCoords(coords);
    routeCoordsRef.current = coords;
    setRouteBeaconPlan(waypointPlan);
    routeBeaconPlanRef.current = waypointPlan;
    setAudioBeaconDebug({
      ...emptyAudioBeaconDebug(),
      beaconEnabled: audioBeaconEnabledRef.current,
      navigationRunning: isNavigatingRef.current,
      totalWaypoints: waypointPlan.beacons.length
    });
    setRouteSummary(formatRoute(route.summary.distance_m, route.summary.estimated_minutes));
    setRouteDescription(route.summary.description ?? "");
    setPathNodes(routePathNodes);
    setRouteStartInfo(route.start ?? null);
    setRouteEndInfo(route.end ?? null);
    routeEndInfoRef.current = route.end ?? null;
    setPlanStops(route.stop_sequence ?? []);
    setLegSummaries(route.leg_summaries ?? []);
    routeSpeechRef.current = routeSpeech(route);

    if (options.preserveNavigation && isNavigatingRef.current) {
      resetNavigationForRoute(coords, waypointPlan, options.reroutePoint ?? null);
      setFusionStatus(options.status ?? "Route updated from your current position. Map navigation continues.");
      setAppStatus("Route updated.");
    } else {
      setNavigationPrompt("");
      setFusionStatus(options.status ?? "Route ready. Start navigation, then open Vision for camera guidance.");
    }
  }

  async function finalizeRoute(start: RouteSelection, end: RouteSelection) {
    const payload = selectionToRouteRequest(start, end);
    const route: RouteResponse = await fetchRoute(payload);
    applyRoute(route);
    setPlanStops(route.stop_sequence ?? []);
    addAssistantMessage(
      `Route ready: ${endpointLabel(route.start) || start.label} to ${endpointLabel(route.end) || end.label}. ${formatRoute(route.summary.distance_m, route.summary.estimated_minutes)}`,
      false
    );
    speak(routeSpeechRef.current);
  }

  async function handleSelection(selection: RouteSelection) {
    if (isNavigating) {
      if (!gpsEnabled) {
        updateManualNavigationPoint(selection.point);
      } else {
        setAppStatus("GPS navigation is active.");
      }
      return;
    }

    const currentStart = startSelectionRef.current;
    const currentEnd = endSelectionRef.current;

    if (!currentStart || currentEnd) {
      startSelectionRef.current = selection;
      endSelectionRef.current = null;

      setStartSelection(selection);
      setEndSelection(null);
      setRouteCoords(null);
      routeCoordsRef.current = null;
      setRouteBeaconPlan(null);
      routeBeaconPlanRef.current = null;
      beaconPlanRef.current = null;
      setAudioBeaconDebug({
        ...emptyAudioBeaconDebug(),
        beaconEnabled: audioBeaconEnabledRef.current,
        navigationRunning: isNavigatingRef.current
      });
      setRouteSummary("");
      setRouteDescription("");
      setPathNodes([]);
      setRouteStartInfo(null);
      setRouteEndInfo(null);
      routeEndInfoRef.current = null;
      setPlanStops([]);
      setLegSummaries([]);
      setSearch("");

      addAssistantMessage(`Start selected: ${selection.label}. Search or choose a destination.`);
      return;
    }

    endSelectionRef.current = selection;
    setEndSelection(selection);
    setSearch("");

    try {
      await finalizeRoute(currentStart, selection);
    } catch (error) {
      console.error(error);
      addAssistantMessage(`Failed to compute route: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  function handleNodeClick(feature: GeoJSONFeature) {
    handleSelection(makeNodeSelection(feature));
  }

  function handleEdgeClick(lat: number, lon: number) {
    handleSelection(makePointSelection(lat, lon));
  }

  function resetRoute() {
    stopNavigation(true);
    startSelectionRef.current = null;
    endSelectionRef.current = null;
    setStartSelection(null);
    setEndSelection(null);
    setRouteCoords(null);
    routeCoordsRef.current = null;
    setRouteBeaconPlan(null);
    routeBeaconPlanRef.current = null;
    beaconPlanRef.current = null;
    setAudioBeaconDebug({
      ...emptyAudioBeaconDebug(),
      beaconEnabled: audioBeaconEnabledRef.current,
      navigationRunning: false
    });
    setRouteSummary("");
    setRouteDescription("");
    setPathNodes([]);
    setRouteStartInfo(null);
    setRouteEndInfo(null);
    routeEndInfoRef.current = null;
    setPlanStops([]);
    setLegSummaries([]);
    setCurrentLocation(null);
    setNavigationPrompt("");
    updateRouteRecoveryStatus(emptyRouteRecoveryStatus());
    setFusionStatus("Vision is off. Map navigation is ready.");
    routeSpeechRef.current = "";
    addAssistantMessage("Route cleared. Search a place or tap the map for start.", false);
  }

  function currentPointForChat() {
    if (currentLocation) return { lon: currentLocation[1], lat: currentLocation[0] };
    if (startSelection?.kind === "point") return startSelection.payload.point;
    if (startSelection?.kind === "node") return { lon: startSelection.point[1], lat: startSelection.point[0] };
    if (routeStartInfo?.point) return { lon: routeStartInfo.point[0], lat: routeStartInfo.point[1] };
    return null;
  }

  async function handleUseCurrentLocation() {
    if (!gpsEnabledRef.current) {
      gpsEnabledRef.current = true;
      setGpsEnabled(true);
      void startGpsTrackingForNavigation();
    }

    setAppStatus("Recalibrating current location.");
    try {
      const fix = await getCurrentPositionFix(12000);
      if (
        isFiniteAccuracy(fix.accuracyMeters) &&
        fix.accuracyMeters > LOCATION_MAX_ACCEPTED_ACCURACY_METERS
      ) {
        setAppStatus(`GPS accuracy low (${gpsAccuracyText(fix.accuracyMeters)}). Try again in open sky.`);
        return;
      }

      const [latitude, longitude] = fix.point;
      const selection = makePointSelection(latitude, longitude, "Current location");
      currentPositionRef.current = fix.point;
      currentAccuracyRef.current = fix.accuracyMeters;
      currentPositionTimestampRef.current = fix.timestampMs || Date.now();
      setCurrentLocation([latitude, longitude]);

      if (isNavigatingRef.current && routeCoordsRef.current?.length) {
        processNavigationPosition(fix, true);
      } else if (!routeCoordsRef.current?.length) {
        startSelectionRef.current = selection;
        setStartSelection(selection);
      }

      lastGpsErrorRef.current = "";
      setAppStatus("Location recalibrated.");
    } catch (error) {
      handleGpsUnavailable(error instanceof Error ? error.message : "Location permission was denied.");
    }
  }

  async function ensureAudioEngine() {
    let engine = audioEngineRef.current;
  
    if (!engine) {
      engine = new AudioBeaconEngine();
      await engine.init();
      engine.start();
      audioEngineRef.current = engine;
    }
  
    return engine;
  }
  
  async function handleTestCalm() {
    const engine = await ensureAudioEngine();
    await engine.playTestCalm();
  }
  
  async function handleTestDrumLeft() {
    const engine = await ensureAudioEngine();
    await engine.playTestDrumLeft();
  }
  
  async function handleTestDrumRight() {
    const engine = await ensureAudioEngine();
    await engine.playTestDrumRight();
  }
  async function handleStartNavigation() {
    const coords = routeCoordsRef.current;
    if (!coords || coords.length < 2) {
      addAssistantMessage("No route yet.");
      return;
    }

    stopNavigation(true);
    const beaconPlan =
      routeBeaconPlanRef.current ?? buildRouteWaypointPlan(coords);
    const startPoint = initialNavigationPoint(coords);
    beaconPlanRef.current = beaconPlan;
    audioBeaconIndexRef.current = 0;
    lastAutoBeaconPulseAtRef.current = 0;
    lastAutoBeaconModeRef.current = "waiting";
    lastAutoBeaconAngleRef.current = null;
    routeCumulativeMetersRef.current = cumulativePolylineMeters(coords);
    currentPositionRef.current = startPoint;
    currentAccuracyRef.current = null;
    offRouteFixesRef.current = 0;
    const initialBearing = beaconBearingDegrees(startPoint, beaconPlan.beacons[0] ?? coords[1]);
    navigationCuesRef.current = buildNavigationCues(coords);
    nextCueIndexRef.current = 1;
    lastSpokenNavigationRef.current = "";
    lastGpsErrorRef.current = "";
    setCurrentLocation(startPoint);
    isNavigatingRef.current = true;
    setIsNavigating(true);
    setNavigationPrompt(`Waypoint 1/${beaconPlan.beacons.length}`);
    updateAudioBeaconDebug({
      navigationRunning: true,
      locationAvailable: true,
      headingAvailable: false,
      currentWaypoint: 1,
      totalWaypoints: beaconPlan.beacons.length,
      distanceMeters: beaconDistanceMeters(startPoint, beaconPlan.beacons[0]),
      bearing: initialBearing,
      heading: null,
      angleDiff: null,
      mode: "waiting"
    });

    if (gpsEnabled || audioBeaconEnabledRef.current) {
      void startGpsTrackingForNavigation();
    }

    if (audioBeaconEnabledRef.current) {
      try {
        const engine = new AudioBeaconEngine();
        await engine.init();
        engine.start();
        audioEngineRef.current = engine;
        startAudioBeaconTimer();
      } catch (error) {
        console.error(error);
        addAssistantMessage("Audio Beacon is unavailable. Spoken navigation is still on.", false);
      }
    }

    const startText = audioBeaconEnabledRef.current ? "Navigation started. Audio Beacon on." : "Navigation started.";
    setAppStatus(startText);
    speak(startText);
    setFusionStatus("Map navigation active. Vision can add front-camera safety cues.");

    const firstCue = navigationCuesRef.current[0]?.text || "Head forward";
    const beaconPrompt = updateAudioBeacon(startPoint, null);
    const modeHint = gpsEnabled ? "" : " · Tap route to move";
    setNavigationPrompt(`${beaconPrompt || `Waypoint 1/${beaconPlan.beacons.length}`} · ${firstCue}${modeHint}`);
  }

  async function handleToggleAudioBeacon() {
    const next = !audioBeaconEnabledRef.current;
    audioBeaconEnabledRef.current = next;
    setAudioBeaconEnabled(next);

    if (!next) {
      clearAudioBeaconTimer();
      lastAutoBeaconPulseAtRef.current = 0;
      lastAutoBeaconModeRef.current = "waiting";
      lastAutoBeaconAngleRef.current = null;
      audioEngineRef.current?.close();
      audioEngineRef.current = null;
      updateAudioBeaconDebug({ mode: "waiting" });
      setAppStatus("Audio Beacon off.");
      return;
    }

    if (!isNavigating) {
      setAppStatus("Audio Beacon on. Start navigation to hear waypoints.");
      return;
    }

    try {
      void startGpsTrackingForNavigation();

      const engine = new AudioBeaconEngine();
      await engine.init();
      engine.start();
      audioEngineRef.current = engine;

      const point = currentPositionRef.current;
      const plan = beaconPlanRef.current;
      if (point && plan?.beacons.length) {
        updateAudioBeacon(point, currentAccuracyRef.current, { allowWaypointArrival: false });
      }
      startAudioBeaconTimer();
      setAppStatus("Audio Beacon on.");
    } catch (error) {
      console.error(error);
      setAudioBeaconEnabled(false);
      audioBeaconEnabledRef.current = false;
      addAssistantMessage("Audio Beacon is unavailable on this device.", false);
    }
  }

  function navigationFusionContext(): NavigationFusionContext {
    return {
      hasRoute: Boolean(routeCoordsRef.current?.length),
      isNavigating: isNavigatingRef.current,
      navigationPrompt,
      audioBeacon: audioBeaconDebugRef.current,
      fusionStatus,
      routeRecovery: routeRecoveryStatusRef.current
    };
  }

  function handleVisionFusionAnalysis(payload: VisionFusionPayload) {
    const context = navigationFusionContext();
    const decision = buildVisionFusionDecision(payload, context);
    const now = performance.now();

    setFusionStatus(decision.display);

    if (decision.suppressBeaconMs > 0) {
      beaconSuppressedUntilRef.current = Math.max(
        beaconSuppressedUntilRef.current,
        now + decision.suppressBeaconMs
      );
    }

    if (decision.priority === "urgent") {
      setAppStatus(decision.display);
    }

    if (!payload.speechEnabled || !decision.speech) return;

    speak(
      decision.speech,
      false,
      decision.priority,
      `vision:${decision.key}`,
      decision.cooldownMs
    );
  }

  function handleSpeakRoute() {
    if (!routeSpeechRef.current) {
      addAssistantMessage("No route is ready yet.");
      return;
    }
    speak(routeSpeechRef.current, true);
  }

  function handleStopSpeaking() {
    stopSpeaking();
    setIsSpeaking(false);
    setAppStatus("Voice stopped.");
  }

  function handleToggleVoice() {
    setVoiceEnabled((value) => {
      const next = !value;
      if (!next) {
        stopSpeaking();
        setIsSpeaking(false);
        setAppStatus("Voice guidance off.");
      } else {
        setAppStatus("Voice guidance on.");
        speakText("Voice guidance on.", {
          onStart: () => setIsSpeaking(true),
          onEnd: () => setIsSpeaking(false),
          onError: () => setIsSpeaking(false)
        });
      }
      return next;
    });
  }

  function openVisionPanel() {
    setFusionStatus(
      isNavigatingRef.current
        ? "Opening Vision. Map navigation keeps running."
        : "Opening Vision. Create or start a route for fused guidance."
    );
    setVisionTestOpen(true);
  }

  function closeVisionPanel() {
    setVisionTestOpen(false);
    setFusionStatus(
      isNavigatingRef.current
        ? "Vision closed. Map navigation continues."
        : "Vision closed. Map navigation is ready."
    );
  }

  async function handleToggleGps() {
    if (gpsEnabled) {
      stopGpsTracking();
      gpsEnabledRef.current = false;
      setGpsEnabled(false);
      const message = isNavigating ? "GPS off. Tap route to move." : "GPS off. Tap map for start.";
      setAppStatus(message);
      if (isNavigating) {
        speakNavigation("GPS off");
      }
      return;
    }

    gpsEnabledRef.current = true;
    setGpsEnabled(true);
    lastGpsErrorRef.current = "";
    setAppStatus("GPS on. Locating in real time.");
    const started = await startGpsTrackingForNavigation();
    if (started) {
      if (isNavigatingRef.current) {
        speakNavigation("GPS on");
      } else {
        setAppStatus("GPS on. Real-time location tracking started.");
      }
    }
  }

  async function handleSend(textOverride?: string) {
    const text = (textOverride ?? chatInput).trim();
    if (!text) return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    setAppStatus(`Request sent: ${text}`);
    setChatInput("");
    try {
      const response: ChatResponse = await sendChat(text, currentPointForChat(), planStops);
      addAssistantMessage(response.reply);

      if (response.plan_stops) {
        setPlanStops(response.plan_stops);
      }

      if (response.route) {
        applyRoute(response.route);
        speak(routeSpeechRef.current);
      }

      if (response.route?.end) {
        setEndSelection(null);
      }

      if (response.destination && !response.route) {
        const hint = response.destination.category ? ` (${response.destination.category})` : "";
        addAssistantMessage(`Matched destination: ${response.destination?.label}${hint}.`);
      }

      if (response.ambiguous && response.candidates && response.candidates.length > 0) {
        const labels = response.candidates.slice(0, 4).map((item) => item.label).join("; ");
        addAssistantMessage(`Top candidates: ${labels}`);
      }
    } catch (error: any) {
      console.error(error);
      const message = error?.message ? String(error.message) : "Chat request failed.";
      addAssistantMessage(message);
    }
  }

  function handleQuickCommand(value: string) {
    setChatInput(value);
    handleSend(value);
  }

  const startDisplayLabel = cleanCoordinateLabel(routeStartInfo?.label || startSelection?.label || "");
  const endDisplayLabel = cleanCoordinateLabel(routeEndInfo?.label || endSelection?.label || "");
  const startDisplayPoint =
    startSelection?.point || (routeStartInfo?.point ? ([routeStartInfo.point[1], routeStartInfo.point[0]] as [number, number]) : null);
  const endDisplayPoint =
    endSelection?.point || (routeEndInfo?.point ? ([routeEndInfo.point[1], routeEndInfo.point[0]] as [number, number]) : null);
  const displayRouteCumulativeMeters = useMemo(
    () => (routeCoords && routeCoords.length >= 2 ? cumulativePolylineMeters(routeCoords) : []),
    [routeCoords]
  );
  const displayRouteCoords = useMemo(() => {
    if (!isNavigating || !currentLocation || !routeCoords || routeCoords.length < 2) {
      return routeCoords;
    }

    const projection = projectPointOntoPolylineMeters(currentLocation, routeCoords, displayRouteCumulativeMeters);
    const nextIndex = Math.min(routeCoords.length - 1, projection.segmentIndex + 1);
    const remaining: [number, number][] = [projection.foot, ...routeCoords.slice(nextIndex)];
    return remaining.length > 1 ? cleanRouteCoords(remaining) : routeCoords.slice(-2);
  }, [currentLocation, displayRouteCumulativeMeters, isNavigating, routeCoords]);
  const displayRouteBeacons = useMemo(() => {
    const beacons = routeBeaconPlan?.beacons ?? [];
    if (!isNavigating) return beacons;
    const nextBeaconIndex = Math.max(0, audioBeaconDebug.currentWaypoint - 1);
    return beacons.slice(nextBeaconIndex);
  }, [audioBeaconDebug.currentWaypoint, isNavigating, routeBeaconPlan]);

  return (
    <div className="app-shell">
      <div className="sr-only" role="status" aria-live="assertive">
        {appStatus}
      </div>

      <main className="map-shell" aria-label="Central Park map">
        <TopBar
          search={search}
          setSearch={setSearch}
          results={searchResults}
          voiceEnabled={voiceEnabled}
          gpsEnabled={gpsEnabled}
          hasRoute={Boolean(routeSummary)}
          isSpeaking={isSpeaking}
          isNavigating={isNavigating}
          startLabel={startDisplayLabel}
          onResultSelect={handleNodeClick}
          onUseCurrentLocation={handleUseCurrentLocation}
          onSpeakRoute={handleSpeakRoute}
          onStopSpeaking={handleStopSpeaking}
          onStartNavigation={handleStartNavigation}
          onStopNavigation={() => stopNavigation()}
          onToggleVoice={handleToggleVoice}
          onToggleGps={handleToggleGps}
          onOpenVisionTest={openVisionPanel}
        />
        <MapView
          edges={edges}
          filteredFeatures={mapFeatures}
          routeCoords={displayRouteCoords}
          routeBeacons={displayRouteBeacons}
          startPoint={startDisplayPoint}
          endPoint={endDisplayPoint}
          currentPoint={currentLocation}
          onNodeClick={handleNodeClick}
          onEdgeClick={handleEdgeClick}
        />
        <Legend />
        <RoutePanel
          startLabel={startDisplayLabel}
          endLabel={endDisplayLabel}
          routeSummary={routeSummary}
          routeDescription={routeDescription}
          pathNodes={pathNodes}
          stopSequence={planStops}
          legSummaries={legSummaries}
          isSpeaking={isSpeaking}
          isNavigating={isNavigating}
          audioBeaconEnabled={audioBeaconEnabled}
          audioBeaconDebug={audioBeaconDebug}
          navigationPrompt={navigationPrompt}
          onStartNavigation={handleStartNavigation}
          onStopNavigation={() => stopNavigation()}
          onToggleAudioBeacon={handleToggleAudioBeacon}
          onSpeakRoute={handleSpeakRoute}
          onStopSpeaking={handleStopSpeaking}
          onReset={resetRoute}
          onTestCalm={() => void handleTestCalm()}
          onTestDrumLeft={() => void handleTestDrumLeft()}
          onTestDrumRight={() => void handleTestDrumRight()}
        />
      </main>

      <ChatPanel
        messages={messages}
        input={chatInput}
        setInput={setChatInput}
        onSend={handleSend}
        onQuickCommand={handleQuickCommand}
      />
      {visionTestOpen && (
        <VisionPanel
          open={visionTestOpen}
          onClose={closeVisionPanel}
          navigationContext={navigationFusionContext()}
          onVisionAnalysis={handleVisionFusionAnalysis}
        />
      )}
    </div>
  );
}
