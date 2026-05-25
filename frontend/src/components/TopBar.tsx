import { useState } from "react";
import type { GeoJSONFeature } from "../lib/types";
import { getNodeCode, getNodeLabel, normalizeCategory } from "../lib/utils";

type Props = {
  search: string;
  setSearch: (value: string) => void;
  results: GeoJSONFeature[];
  voiceEnabled: boolean;
  gpsEnabled: boolean;
  hasRoute: boolean;
  isSpeaking: boolean;
  isNavigating: boolean;
  startLabel: string;
  onResultSelect: (feature: GeoJSONFeature) => void;
  onUseCurrentLocation: () => void;
  onSpeakRoute: () => void;
  onStopSpeaking: () => void;
  onStartNavigation: () => void;
  onStopNavigation: () => void;
  onToggleVoice: () => void;
  onToggleGps: () => void;
  onOpenVisionTest: () => void;
};

export default function TopBar({
  search,
  setSearch,
  results,
  voiceEnabled,
  gpsEnabled,
  hasRoute,
  isSpeaking,
  isNavigating,
  startLabel,
  onResultSelect,
  onUseCurrentLocation,
  onSpeakRoute,
  onStopSpeaking,
  onStartNavigation,
  onStopNavigation,
  onToggleVoice,
  onToggleGps,
  onOpenVisionTest
}: Props) {
  const [controlsOpen, setControlsOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const visibleResults = resultsOpen ? results : results.slice(0, 3);

  return (
    <header
      className={`topbar ${controlsOpen ? "topbar--controls-open" : "topbar--compact"}`}
      aria-label="Central Park navigation controls"
    >
      <div className="topbar__search-row" role="search">
        <label className="sr-only" htmlFor="park-search">
          Search Central Park destinations
        </label>
        <input
          id="park-search"
          className="topbar__search"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          placeholder={startLabel ? "Search destination" : "Search"}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className="topbar__menu"
          onClick={() => setControlsOpen((value) => !value)}
          aria-expanded={controlsOpen}
          aria-label={controlsOpen ? "Hide controls" : "Show controls"}
        >
          {controlsOpen ? "Less" : "More"}
        </button>
      </div>

      {controlsOpen && (
        <div className="topbar__status">
          {startLabel ? `Start: ${startLabel}` : "Choose a start point"} · {gpsEnabled ? "GPS on" : "GPS off"}
        </div>
      )}

      {controlsOpen && <div className="topbar__actions" aria-label="Navigation shortcuts">
        <button
          type="button"
          className="topbar__gps-toggle"
          onClick={onToggleGps}
          aria-pressed={gpsEnabled}
        >
          {gpsEnabled ? "GPS on" : "GPS off"}
        </button>
        {gpsEnabled && (
          <button type="button" onClick={onUseCurrentLocation}>
            Locate
          </button>
        )}
        <button type="button" onClick={onToggleVoice} aria-pressed={voiceEnabled}>
          {voiceEnabled ? "Voice on" : "Voice off"}
        </button>
        {hasRoute && (
          <button type="button" onClick={isNavigating ? onStopNavigation : onStartNavigation}>
            {isNavigating ? "Stop nav" : "Start"}
          </button>
        )}
        {hasRoute && controlsOpen && (
          <button type="button" onClick={isSpeaking ? onStopSpeaking : onSpeakRoute}>
            {isSpeaking ? "Mute" : "Repeat"}
          </button>
        )}
        <button type="button" onClick={onOpenVisionTest}>
          Vision Test
        </button>
      </div>}

      {results.length > 0 && (
        <div className="search-results" role="listbox" aria-label="Search results">
          {visibleResults.map((feature) => {
            const key = String(
              feature.properties.node_id ??
                feature.properties.grid_node_code ??
                getNodeLabel(feature)
            );
            const category = normalizeCategory(feature);
            return (
              <button
                type="button"
                className="search-result"
                key={key}
                role="option"
                onClick={() => onResultSelect(feature)}
              >
                <span className="search-result__label">{getNodeLabel(feature)}</span>
                <span className="search-result__meta">
                  {category} · {getNodeCode(feature)}
                </span>
              </button>
            );
          })}
          {results.length > 3 && (
            <button
              type="button"
              className="search-results__toggle"
              onClick={() => setResultsOpen((value) => !value)}
              aria-expanded={resultsOpen}
            >
              {resultsOpen ? "Fewer" : `${results.length - 3} more`}
            </button>
          )}
        </div>
      )}
    </header>
  );
}
