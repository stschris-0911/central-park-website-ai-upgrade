import { useSheetDrag } from "../lib/useSheetDrag";
import { cleanCoordinateLabel } from "../lib/utils";
import type { LegSummary, PlanStop, RoutePathNode } from "../lib/types";

type RoutePanelProps = {
  startLabel: string;
  endLabel: string;
  routeSummary: string;
  routeDescription: string;
  pathNodes: RoutePathNode[];
  stopSequence: PlanStop[];
  legSummaries: LegSummary[];
  isSpeaking: boolean;
  isNavigating: boolean;
  navigationPrompt: string;
  onStartNavigation: () => void;
  onStopNavigation: () => void;
  onSpeakRoute: () => void;
  onStopSpeaking: () => void;
  onReset: () => void;
};

export default function RoutePanel({
  startLabel,
  endLabel,
  routeSummary,
  routeDescription,
  pathNodes,
  stopSequence,
  legSummaries,
  isSpeaking,
  isNavigating,
  navigationPrompt,
  onStartNavigation,
  onStopNavigation,
  onSpeakRoute,
  onStopSpeaking,
  onReset
}: RoutePanelProps) {
  const sheet = useSheetDrag("Route", "peek");
  const hasRoute = Boolean(routeSummary);
  const showDetails = !sheet.isPeek;
  const showFullDetails = sheet.isFull;

  return (
    <section
      className={`route-card route-card--${sheet.level}`}
      {...sheet.sheetProps}
      aria-label="Route summary"
    >
      <button type="button" className="route-card__handle sheet-handle" {...sheet.handleProps}>
        <span aria-hidden="true" />
      </button>

      <div className="route-card__header">
        <div>
          <h3>{hasRoute ? "Route" : "Route panel"}</h3>
          <div className="route-card__summary-line">
            {isNavigating && navigationPrompt ? navigationPrompt : hasRoute ? routeSummary : "Select a start and destination"}
          </div>
        </div>

        <div className="route-card__actions">
          {hasRoute && (
            <button
              type="button"
              className={isNavigating ? "route-card__stop-nav" : "route-card__start-nav"}
              onClick={isNavigating ? onStopNavigation : onStartNavigation}
            >
              {isNavigating ? "Stop" : "Start"}
            </button>
          )}
          {hasRoute && (
            <button
              type="button"
              className="route-card__speak"
              onClick={isSpeaking ? onStopSpeaking : onSpeakRoute}
            >
              {isSpeaking ? "Stop" : "Speak"}
            </button>
          )}
          {showDetails && <button type="button" onClick={onReset}>
            Reset
          </button>}
        </div>
      </div>

      {showDetails && (
        <div className="route-card__details">
          <div className="route-meta">
            <div>
              <strong>Start:</strong> {startLabel || "Not selected"}
            </div>
            <div>
              <strong>Destination:</strong> {endLabel || "Not selected"}
            </div>
            <div>
              <strong>Route:</strong> {routeSummary || "Select a start and destination"}
            </div>
          </div>

          {routeDescription && showFullDetails && <p className="route-description">{routeDescription}</p>}

          {showFullDetails && stopSequence.length > 0 && (
            <div className="path-node-list">
              <h4>Trip stops</h4>
              {stopSequence.map((stop, index) => (
                <div className="path-node-item" key={`${stop.label}-${index}`}>
                  <div className="path-node-item__title">
                    {index + 1}. {cleanCoordinateLabel(stop.label)}
                  </div>
                  <div className="path-node-item__meta">
                    {stop.code ? `Code: ${stop.code}` : "Code: N/A"}
                    {stop.category ? ` · Category: ${stop.category}` : ""}
                  </div>
                  <div className="path-node-item__desc">
                    {stop.description || stop.source_query || "No description available."}
                  </div>
                </div>
              ))}
            </div>
          )}

          {showFullDetails && legSummaries.length > 0 && (
            <div className="path-node-list" style={{ marginTop: 12 }}>
              <h4>Trip legs</h4>
              {legSummaries.map((leg) => (
                <div className="path-node-item" key={leg.order}>
                  <div className="path-node-item__title">
                    Leg {leg.order}: {cleanCoordinateLabel(leg.start_label)} → {cleanCoordinateLabel(leg.end_label)}
                  </div>
                  <div className="path-node-item__meta">
                    {(leg.distance_m / 1000).toFixed(2)} km · {leg.estimated_minutes} min walk
                  </div>
                </div>
              ))}
            </div>
          )}

          {showFullDetails && pathNodes.length > 0 && (
            <div className="path-node-list" style={{ marginTop: 12 }}>
              <h4>Key nodes on route</h4>
              {pathNodes.map((node, index) => (
                <div className="path-node-item" key={`${node.node_id}-${index}`}>
                  <div className="path-node-item__title">
                    {index + 1}. {node.label}
                  </div>
                  <div className="path-node-item__meta">
                    {node.code ? `Code: ${node.code}` : "Code: N/A"}
                    {node.category ? ` · Category: ${node.category}` : ""}
                  </div>
                  <div className="path-node-item__desc">
                    {node.description || "No description available."}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
