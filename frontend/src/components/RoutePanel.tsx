import type { LegSummary, PlanStop, RoutePathNode } from "../lib/types";

type Props = {
  startLabel: string;
  endLabel: string;
  routeSummary: string;
  routeDescription: string;
  pathNodes: RoutePathNode[];
  stopSequence: PlanStop[];
  legSummaries: LegSummary[];
  onReset: () => void;
};

export default function RoutePanel({ startLabel, endLabel, routeSummary, routeDescription, pathNodes, stopSequence, legSummaries, onReset }: Props) {
  return (
    <section className="route-card">
      <div className="route-card__header">
        <h3>Route panel</h3>
        <button onClick={onReset}>Reset</button>
      </div>

      <div className="route-meta">
        <div><strong>Start:</strong> {startLabel || "Not selected"}</div>
        <div><strong>Destination:</strong> {endLabel || "Not selected"}</div>
        <div><strong>Route:</strong> {routeSummary || "Select a start and destination"}</div>
      </div>

      {routeDescription && <p className="route-description">{routeDescription}</p>}

      {stopSequence.length > 0 && (
        <div className="path-node-list">
          <h4>Trip stops</h4>
          {stopSequence.map((stop, idx) => (
            <div className="path-node-item" key={`${stop.label}-${idx}`}>
              <div className="path-node-item__title">{idx + 1}. {stop.label}</div>
              <div className="path-node-item__meta">
                {stop.code ? `Code: ${stop.code}` : "Code: N/A"}
                {stop.category ? ` · Category: ${stop.category}` : ""}
              </div>
              <div className="path-node-item__desc">{stop.description || stop.source_query || "No description available."}</div>
            </div>
          ))}
        </div>
      )}

      {legSummaries.length > 0 && (
        <div className="path-node-list" style={{ marginTop: 12 }}>
          <h4>Trip legs</h4>
          {legSummaries.map((leg) => (
            <div className="path-node-item" key={leg.order}>
              <div className="path-node-item__title">Leg {leg.order}: {leg.start_label} → {leg.end_label}</div>
              <div className="path-node-item__meta">{(leg.distance_m / 1000).toFixed(2)} km · {leg.estimated_minutes} min walk</div>
            </div>
          ))}
        </div>
      )}

      {pathNodes.length > 0 && (
        <div className="path-node-list" style={{ marginTop: 12 }}>
          <h4>Key nodes on route</h4>
          {pathNodes.map((node, idx) => (
            <div className="path-node-item" key={`${node.node_id}-${idx}`}>
              <div className="path-node-item__title">
                {idx + 1}. {node.label}
              </div>
              <div className="path-node-item__meta">
                {node.code ? `Code: ${node.code}` : "Code: N/A"}
                {node.category ? ` · Category: ${node.category}` : ""}
              </div>
              <div className="path-node-item__desc">{node.description || "No description available."}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
