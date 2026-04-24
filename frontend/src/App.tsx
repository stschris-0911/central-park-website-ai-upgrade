import { useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import Legend from "./components/Legend";
import MapView from "./components/MapView";
import RoutePanel from "./components/RoutePanel";
import TopBar from "./components/TopBar";
import { fetchEdges, fetchNodes, fetchRoute, sendChat } from "./lib/api";
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
import { endpointLabel, formatRoute, getNodeDescription, getNodeId, getNodeLabel } from "./lib/utils";

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

function makePointSelection(lat: number, lon: number): RouteSelection {
  return {
    kind: "point",
    label: `Walkable point (${lat.toFixed(5)}, ${lon.toFixed(5)})`,
    description: "Selected on the walkable route network.",
    point: [lat, lon],
    payload: { point: { lon, lat } }
  };
}

export default function App() {
  const [nodes, setNodes] = useState<GeoJSONFeatureCollection | null>(null);
  const [edges, setEdges] = useState<GeoJSONFeatureCollection | null>(null);
  const [search, setSearch] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "Hi! This website now supports AI destination resolution and multi-stop trip planning." },
    {
      role: "assistant",
      text: "Click a start point first, then try: 'nearest restroom, then Bethesda Terrace, then nearest gate'. You can also say 'show plan' or 'clear plan'."
    }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [startSelection, setStartSelection] = useState<RouteSelection | null>(null);
  const [endSelection, setEndSelection] = useState<RouteSelection | null>(null);
  const [routeCoords, setRouteCoords] = useState<[number, number][] | null>(null);
  const [routeSummary, setRouteSummary] = useState("");
  const [routeDescription, setRouteDescription] = useState("");
  const [pathNodes, setPathNodes] = useState<RoutePathNode[]>([]);
  const [routeStartInfo, setRouteStartInfo] = useState<RouteEndpointInfo | null>(null);
  const [routeEndInfo, setRouteEndInfo] = useState<RouteEndpointInfo | null>(null);
  const [planStops, setPlanStops] = useState<PlanStop[]>([]);
  const [legSummaries, setLegSummaries] = useState<LegSummary[]>([]);

  const startSelectionRef = useRef<RouteSelection | null>(null);
  const endSelectionRef = useRef<RouteSelection | null>(null);

  useEffect(() => {
    startSelectionRef.current = startSelection;
  }, [startSelection]);

  useEffect(() => {
    endSelectionRef.current = endSelection;
  }, [endSelection]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [nodeData, edgeData] = await Promise.all([fetchNodes(), fetchEdges()]);
      if (!cancelled) {
        setNodes(nodeData);
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

  function applyRoute(route: RouteResponse) {
    const coords = route.route_geojson.geometry.coordinates.map(([lon, lat]: [number, number]) => [lat, lon] as [number, number]);
    setRouteCoords(coords);
    setRouteSummary(formatRoute(route.summary.distance_m, route.summary.estimated_minutes));
    setRouteDescription(route.summary.description ?? "");
    setPathNodes(route.path_nodes ?? []);
    setRouteStartInfo(route.start ?? null);
    setRouteEndInfo(route.end ?? null);
    setPlanStops(route.stop_sequence ?? []);
    setLegSummaries(route.leg_summaries ?? []);
  }

  async function finalizeRoute(start: RouteSelection, end: RouteSelection) {
    const payload = selectionToRouteRequest(start, end);
    const route: RouteResponse = await fetchRoute(payload);
    applyRoute(route);
    setPlanStops(route.stop_sequence ?? []);
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        text: `Route ready: ${endpointLabel(route.start) || start.label} → ${endpointLabel(route.end) || end.label} · ${formatRoute(route.summary.distance_m, route.summary.estimated_minutes)}`
      }
    ]);
  }

  async function handleSelection(selection: RouteSelection) {
    const currentStart = startSelectionRef.current;
    const currentEnd = endSelectionRef.current;

    if (!currentStart || currentEnd) {
      startSelectionRef.current = selection;
      endSelectionRef.current = null;

      setStartSelection(selection);
      setEndSelection(null);
      setRouteCoords(null);
      setRouteSummary("");
      setRouteDescription("");
      setPathNodes([]);
      setRouteStartInfo(null);
      setRouteEndInfo(null);
      setPlanStops([]);
      setLegSummaries([]);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Start selected: ${selection.label}. Now click a node or grey walkable line for the destination, or ask me for a multi-stop trip.`
        }
      ]);
      return;
    }

    endSelectionRef.current = selection;
    setEndSelection(selection);

    try {
      await finalizeRoute(currentStart, selection);
    } catch (error) {
      console.error(error);
      setMessages((prev) => [...prev, { role: "assistant", text: `Failed to compute route: ${error instanceof Error ? error.message : "Unknown error"}` }]);
    }
  }

  function handleNodeClick(feature: GeoJSONFeature) {
    handleSelection(makeNodeSelection(feature));
  }

  function handleEdgeClick(lat: number, lon: number) {
    handleSelection(makePointSelection(lat, lon));
  }

  function resetRoute() {
    startSelectionRef.current = null;
    endSelectionRef.current = null;
    setStartSelection(null);
    setEndSelection(null);
    setRouteCoords(null);
    setRouteSummary("");
    setRouteDescription("");
    setPathNodes([]);
    setRouteStartInfo(null);
    setRouteEndInfo(null);
    setPlanStops([]);
    setLegSummaries([]);
  }

  function currentPointForChat() {
    if (startSelection?.kind === "point") return startSelection.payload.point;
    if (startSelection?.kind === "node") return { lon: startSelection.point[1], lat: startSelection.point[0] };
    if (routeStartInfo?.point) return { lon: routeStartInfo.point[0], lat: routeStartInfo.point[1] };
    return null;
  }

  async function handleSend() {
    const text = chatInput.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    setChatInput("");
    try {
      const response: ChatResponse = await sendChat(text, currentPointForChat(), planStops);
      setMessages((prev) => [...prev, { role: "assistant", text: response.reply }]);

      if (response.plan_stops) {
        setPlanStops(response.plan_stops);
      }

      if (response.route) {
        applyRoute(response.route);
      }

      if (response.route?.end) {
        setEndSelection(null);
      }

      if (response.destination && !response.route) {
        const hint = response.destination.category ? ` (${response.destination.category})` : "";
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: `Matched destination: ${response.destination?.label}${hint}.` }
        ]);
      }

      if (response.ambiguous && response.candidates && response.candidates.length > 0) {
        const labels = response.candidates.slice(0, 4).map((item) => item.label).join("; ");
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: `Top candidates: ${labels}` }
        ]);
      }
    } catch (error: any) {
      console.error(error);
      const message = error?.message ? String(error.message) : "Chat request failed.";
      setMessages((prev) => [...prev, { role: "assistant", text: message }]);
    }
  }

  const startDisplayLabel = routeStartInfo?.label || startSelection?.label || "";
  const endDisplayLabel = routeEndInfo?.label || endSelection?.label || "";
  const startDisplayPoint =
    startSelection?.point || (routeStartInfo?.point ? ([routeStartInfo.point[1], routeStartInfo.point[0]] as [number, number]) : null);
  const endDisplayPoint =
    endSelection?.point || (routeEndInfo?.point ? ([routeEndInfo.point[1], routeEndInfo.point[0]] as [number, number]) : null);

  return (
    <div className="app-shell">
      <main className="map-shell">
        <TopBar search={search} setSearch={setSearch} />
        <MapView
          edges={edges}
          filteredFeatures={filteredFeatures}
          routeCoords={routeCoords}
          startPoint={startDisplayPoint}
          endPoint={endDisplayPoint}
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
          onReset={resetRoute}
        />
      </main>

      <ChatPanel
        messages={messages}
        input={chatInput}
        setInput={setChatInput}
        onSend={handleSend}
      />
    </div>
  );
}
