import { useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import Legend from "./components/Legend";
import MapView from "./components/MapView";
import RoutePanel from "./components/RoutePanel";
import TopBar from "./components/TopBar";
import { fetchEdges, fetchNodes, fetchRoute, sendChat } from "./lib/api";
import { AudioBeaconEngine } from "./lib/audio";
import {
  bearingDegrees as beaconBearingDegrees,
  buildBeaconPlan,
  cumulativePolylineMeters,
  distanceMeters as beaconDistanceMeters,
  projectPointOntoPolylineMeters,
  type BeaconPlan,
  type LatLon
} from "./lib/beacon";
import { startNavigationSensors, type HeadingFix, type PositionFix } from "./lib/sensors";
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
  const payload: RouteRequest = {};
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
const AUDIO_BEACON_DRIFT_METERS = 2.5;
const AUDIO_BEACON_STEP_METERS = 6;
const AUDIO_MIN_ARRIVAL_METERS = 8;
const AUDIO_MAX_ARRIVAL_METERS = 20;
const AUDIO_OFF_ROUTE_METERS = 24;
const AUDIO_OFF_ROUTE_FIXES = 3;
const HAPTIC_BEACON_MS = 18;
const HAPTIC_ARRIVAL_PATTERN = [28];
const HAPTIC_FINAL_PATTERN = [28, 36, 28];

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
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<[number, number] | null>(null);
  const [navigationPrompt, setNavigationPrompt] = useState("");
  const [appStatus, setAppStatus] = useState("Search a place, tap the map for start, or ask for the nearest restroom.");

  const startSelectionRef = useRef<RouteSelection | null>(null);
  const endSelectionRef = useRef<RouteSelection | null>(null);
  const routeSpeechRef = useRef("");
  const routeCoordsRef = useRef<[number, number][] | null>(null);
  const routeBeaconPlanRef = useRef<BeaconPlan | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const sensorStopRef = useRef<(() => void) | null>(null);
  const audioEngineRef = useRef<AudioBeaconEngine | null>(null);
  const beaconPlanRef = useRef<BeaconPlan | null>(null);
  const audioBeaconIndexRef = useRef(0);
  const routeCumulativeMetersRef = useRef<number[]>([]);
  const currentPositionRef = useRef<LatLon | null>(null);
  const currentAccuracyRef = useRef<number | null>(null);
  const headingRef = useRef<number | null>(null);
  const offRouteFixesRef = useRef(0);
  const lastGpsErrorRef = useRef("");
  const navigationCuesRef = useRef<NavigationCue[]>([]);
  const nextCueIndexRef = useRef(0);
  const lastSpokenNavigationRef = useRef("");

  useEffect(() => {
    startSelectionRef.current = startSelection;
  }, [startSelection]);

  useEffect(() => {
    endSelectionRef.current = endSelection;
  }, [endSelection]);

  useEffect(() => {
    routeCoordsRef.current = routeCoords;
  }, [routeCoords]);

  useEffect(() => {
    routeBeaconPlanRef.current = routeBeaconPlan;
  }, [routeBeaconPlan]);

  useEffect(() => {
    return () => {
      stopSpeaking();
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      sensorStopRef.current?.();
      audioEngineRef.current?.close();
    };
  }, []);

  function speak(message: string, force = false) {
    if (!force && !voiceEnabled) return;
    if (!canSpeak()) {
      setAppStatus("Speech is not available in this browser.");
      return;
    }

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
    speak(text);
  }

  function stopNavigation(silent = false) {
    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    sensorStopRef.current?.();
    sensorStopRef.current = null;
    audioEngineRef.current?.close();
    audioEngineRef.current = null;
    beaconPlanRef.current = null;
    audioBeaconIndexRef.current = 0;
    routeCumulativeMetersRef.current = [];
    currentPositionRef.current = null;
    currentAccuracyRef.current = null;
    headingRef.current = null;
    offRouteFixesRef.current = 0;

    setIsNavigating(false);
    if (!silent) {
      setNavigationPrompt("Navigation stopped");
      setAppStatus("Navigation stopped");
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
    if (!navigator.geolocation) {
      handleGpsUnavailable("Location is not available on this device.");
      return false;
    }

    try {
      sensorStopRef.current = await startNavigationSensors({
        onPosition: processNavigationPosition,
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

  function updateAudioBeacon(point: LatLon, accuracyMeters: number | null): string {
    const plan = beaconPlanRef.current;
    if (!plan || plan.beacons.length === 0) return "";

    const index = Math.min(audioBeaconIndexRef.current, plan.beacons.length - 1);
    const target = plan.beacons[index];
    const coords = routeCoordsRef.current;
    const cumulative = routeCumulativeMetersRef.current;
    const projection =
      coords && cumulative.length === coords.length
        ? projectPointOntoPolylineMeters(point, coords, cumulative)
        : null;
    const navigationPoint = projection ? projection.foot : point;

    if (projection && projection.offRouteMeters > AUDIO_OFF_ROUTE_METERS) {
      offRouteFixesRef.current += 1;
    } else {
      offRouteFixesRef.current = 0;
    }

    const heading = headingRef.current ?? beaconBearingDegrees(navigationPoint, target);
    audioEngineRef.current?.setUserPose(navigationPoint, target, heading, accuracyMeters);

    if (offRouteFixesRef.current >= AUDIO_OFF_ROUTE_FIXES) {
      speakNavigation("Return to route");
      return "Return to route";
    }

    const arrivalRadius = Math.max(
      AUDIO_MIN_ARRIVAL_METERS,
      Math.min(AUDIO_MAX_ARRIVAL_METERS, (accuracyMeters ?? 0) * 1.5)
    );
    const beaconDistance = beaconDistanceMeters(navigationPoint, target);

    if (beaconDistance <= arrivalRadius) {
      if (index >= plan.beacons.length - 1) {
        audioEngineRef.current?.playFinal();
        vibrateBrief(HAPTIC_FINAL_PATTERN);
        speakNavigation("Arrived");
        stopNavigation(true);
        return "Arrived";
      }

      audioBeaconIndexRef.current = index + 1;
      audioEngineRef.current?.playArrival();
      vibrateBrief(HAPTIC_ARRIVAL_PATTERN);
      const nextText = `Beacon ${audioBeaconIndexRef.current + 1} of ${plan.beacons.length}`;
      speakNavigation(nextText);
      return nextText;
    }

    if (audioEngineRef.current?.pulseBeacon()) {
      vibrateBrief(HAPTIC_BEACON_MS);
    }

    return `Beacon ${index + 1}/${plan.beacons.length} · ${Math.round(beaconDistance)} m`;
  }

  function processNavigationHeading(fix: HeadingFix) {
    headingRef.current = fix.headingDegrees;

    const point = currentPositionRef.current;
    const plan = beaconPlanRef.current;
    if (!point || !plan || plan.beacons.length === 0) return;

    const index = Math.min(audioBeaconIndexRef.current, plan.beacons.length - 1);
    const target = plan.beacons[index];
    const coords = routeCoordsRef.current;
    const cumulative = routeCumulativeMetersRef.current;
    const projection =
      coords && cumulative.length === coords.length
        ? projectPointOntoPolylineMeters(point, coords, cumulative)
        : null;
    audioEngineRef.current?.setUserPose(
      projection ? projection.foot : point,
      target,
      fix.headingDegrees,
      currentAccuracyRef.current
    );
  }

  function processNavigationPosition(fix: PositionFix) {
    const coords = routeCoordsRef.current;
    if (!coords || coords.length < 2) return;

    const point = fix.point;
    currentPositionRef.current = point;
    currentAccuracyRef.current = fix.accuracyMeters;
    if (fix.courseDegrees !== null && fix.speedMetersPerSecond !== null && fix.speedMetersPerSecond >= 1) {
      headingRef.current = fix.courseDegrees;
    }
    setCurrentLocation(point);

    const beaconPrompt = updateAudioBeacon(point, fix.accuracyMeters);
    if (beaconPrompt === "Arrived") return;

    const nearestIndex = nearestRouteIndex(point, coords);
    const nearestDistance = distanceMeters(point, coords[nearestIndex]);
    const destinationDistance = distanceMeters(point, coords[coords.length - 1]);

    if (destinationDistance <= NAV_ARRIVAL_METERS) {
      speakNavigation("Arrived");
      stopNavigation(true);
      return;
    }

    if (nearestDistance > 60) {
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

    const cueDistance = distanceMeters(point, coords[nextCue.index]);
    if (cueDistance <= NAV_CUE_METERS) {
      speakNavigation(nextCue.text);
      nextCueIndexRef.current += 1;
      return;
    }

    const cuePrompt = `${nextCue.text} in ${Math.round(cueDistance)} m`;
    setNavigationPrompt(beaconPrompt ? `${beaconPrompt} · ${cuePrompt}` : cuePrompt);
  }

  function initialNavigationPoint(coords: [number, number][]): LatLon {
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
    if (previous && beaconDistanceMeters(previous, point) > 1) {
      headingRef.current = beaconBearingDegrees(previous, point);
    }

    processNavigationPosition({
      point,
      accuracyMeters: null,
      speedMetersPerSecond: null,
      courseDegrees: null
    });
    setAppStatus("Position updated.");
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

  function applyRoute(route: RouteResponse) {
    const routeCoordinates = route.route_geojson.geometry.coordinates as [number, number][];
    const coords = cleanRouteCoords(routeCoordinates.map(([lon, lat]) => [lat, lon] as [number, number]));
    const temporaryBeaconPlan = buildBeaconPlan(coords, AUDIO_BEACON_DRIFT_METERS, AUDIO_BEACON_STEP_METERS);
    setRouteCoords(coords);
    setRouteBeaconPlan(temporaryBeaconPlan);
    routeBeaconPlanRef.current = temporaryBeaconPlan;
    setRouteSummary(formatRoute(route.summary.distance_m, route.summary.estimated_minutes));
    setRouteDescription(route.summary.description ?? "");
    setPathNodes(route.path_nodes ?? []);
    setRouteStartInfo(route.start ?? null);
    setRouteEndInfo(route.end ?? null);
    setPlanStops(route.stop_sequence ?? []);
    setLegSummaries(route.leg_summaries ?? []);
    routeSpeechRef.current = routeSpeech(route);
    setNavigationPrompt("");
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
      setRouteBeaconPlan(null);
      routeBeaconPlanRef.current = null;
      setRouteSummary("");
      setRouteDescription("");
      setPathNodes([]);
      setRouteStartInfo(null);
      setRouteEndInfo(null);
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
    setRouteBeaconPlan(null);
    routeBeaconPlanRef.current = null;
    setRouteSummary("");
    setRouteDescription("");
    setPathNodes([]);
    setRouteStartInfo(null);
    setRouteEndInfo(null);
    setPlanStops([]);
    setLegSummaries([]);
    setCurrentLocation(null);
    setNavigationPrompt("");
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

  function handleUseCurrentLocation() {
    if (!gpsEnabled) {
      setGpsEnabled(true);
      setAppStatus("GPS on. Tap Locate to use current location.");
      return;
    }

    if (!navigator.geolocation) {
      handleGpsUnavailable("Location is not available on this device.");
      return;
    }

    setAppStatus("Getting current location.");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const selection = makePointSelection(latitude, longitude, "Current location");
        setCurrentLocation([latitude, longitude]);

        startSelectionRef.current = selection;
        endSelectionRef.current = null;
        setStartSelection(selection);
        setEndSelection(null);
        setRouteCoords(null);
        setRouteBeaconPlan(null);
        routeBeaconPlanRef.current = null;
        setRouteSummary("");
        setRouteDescription("");
        setPathNodes([]);
        setRouteStartInfo(null);
        setRouteEndInfo(null);
        setPlanStops([]);
        setLegSummaries([]);
        routeSpeechRef.current = "";
        lastGpsErrorRef.current = "";

        addAssistantMessage("Current location set as start. Search or ask for a destination.");
      },
      (error) => {
        handleGpsUnavailable(error.message || "Location permission was denied.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
  }

  async function handleStartNavigation() {
    const coords = routeCoordsRef.current;
    if (!coords || coords.length < 2) {
      addAssistantMessage("No route yet.");
      return;
    }

    stopNavigation(true);
    const beaconPlan =
      routeBeaconPlanRef.current ?? buildBeaconPlan(coords, AUDIO_BEACON_DRIFT_METERS, AUDIO_BEACON_STEP_METERS);
    const startPoint = initialNavigationPoint(coords);
    beaconPlanRef.current = beaconPlan;
    audioBeaconIndexRef.current = 0;
    routeCumulativeMetersRef.current = cumulativePolylineMeters(coords);
    currentPositionRef.current = startPoint;
    currentAccuracyRef.current = null;
    offRouteFixesRef.current = 0;
    headingRef.current = beaconBearingDegrees(startPoint, beaconPlan.beacons[1] ?? coords[1]);
    navigationCuesRef.current = buildNavigationCues(coords);
    nextCueIndexRef.current = 1;
    lastSpokenNavigationRef.current = "";
    lastGpsErrorRef.current = "";
    setCurrentLocation(startPoint);
    setIsNavigating(true);
    setNavigationPrompt(`Beacon 1/${beaconPlan.beacons.length}`);

    try {
      const engine = new AudioBeaconEngine();
      await engine.init();
      engine.start();
      audioEngineRef.current = engine;
      const startText = "Navigation started.";
      setAppStatus(startText);
      speak(startText);
    } catch (error) {
      console.error(error);
      addAssistantMessage("Spatial audio is unavailable. Spoken navigation is still on.", false);
    }

    if (gpsEnabled) {
      await startGpsTrackingForNavigation();
    }

    const firstCue = navigationCuesRef.current[0]?.text || "Head forward";
    const beaconPrompt = updateAudioBeacon(startPoint, null);
    const modeHint = gpsEnabled ? "" : " · Tap route to move";
    setNavigationPrompt(`${beaconPrompt || `Beacon 1/${beaconPlan.beacons.length}`} · ${firstCue}${modeHint}`);
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

  async function handleToggleGps() {
    if (gpsEnabled) {
      stopGpsTracking();
      setGpsEnabled(false);
      const message = isNavigating ? "GPS off. Tap route to move." : "GPS off. Tap map for start.";
      setAppStatus(message);
      if (isNavigating) {
        speakNavigation("GPS off");
      }
      return;
    }

    setGpsEnabled(true);
    lastGpsErrorRef.current = "";
    setAppStatus(isNavigating ? "GPS on." : "GPS on. Location is opt-in.");
    if (isNavigating) {
      const started = await startGpsTrackingForNavigation();
      if (started) {
        speakNavigation("GPS on");
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
        />
        <MapView
          edges={edges}
          filteredFeatures={mapFeatures}
          routeCoords={routeCoords}
          routeBeacons={routeBeaconPlan?.beacons ?? []}
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
          navigationPrompt={navigationPrompt}
          onStartNavigation={handleStartNavigation}
          onStopNavigation={() => stopNavigation()}
          onSpeakRoute={handleSpeakRoute}
          onStopSpeaking={handleStopSpeaking}
          onReset={resetRoute}
        />
      </main>

      <ChatPanel
        messages={messages}
        input={chatInput}
        setInput={setChatInput}
        onSend={handleSend}
        onQuickCommand={handleQuickCommand}
      />
    </div>
  );
}
