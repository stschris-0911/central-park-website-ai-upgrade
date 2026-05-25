import { useEffect, useRef, useState } from "react";
import {
  VISION_API_BASE,
  VISION_RAW_API_BASE,
  VisionApiError,
  analyzeVisionBlob,
  visionRequestInfo,
  type VisionAnalysisResponse,
  type VisionDetection,
  type VisionMode,
  type VisionRequestInfo
} from "../lib/visionApi";
import { createVisionFeedbackController, type VisionFeedbackController } from "../lib/visionFeedback";
import { canSpeak, speakText, stopSpeaking } from "../lib/speech";

type Props = {
  open: boolean;
  onClose: () => void;
};

type FrameSize = {
  width: number;
  height: number;
};

type StageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type VisionErrorDetails = {
  message: string;
  method: string;
  url: string;
  status: string;
  responseText: string;
  exception: string;
};

const FRAME_INTERVAL_MS = 1000;
const DEFAULT_FRAME: FrameSize = { width: 640, height: 480 };
const DEFAULT_STAGE: FrameSize = { width: 360, height: 540 };
const STOP_SMOOTHING_FRAMES = 3;
const SPEECH_COOLDOWN_MS = 4000;

function pct(value: number | undefined): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round((value ?? 0) * 100)}%`;
}

function scoreText(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

function directionLabel(result: VisionAnalysisResponse | null): string {
  const direction = result?.traversable?.best_direction || result?.direction;
  if (!direction) return "WAITING";
  if (direction === "uncertain") return "UNCERTAIN";
  if (direction === "continue") return "CENTER";
  if (direction === "slight_left") return "SLIGHT LEFT";
  if (direction === "slight_right") return "SLIGHT RIGHT";
  return direction.toUpperCase();
}

function directionClass(result: VisionAnalysisResponse | null): string {
  const direction = result?.traversable?.best_direction || result?.direction;
  if (direction === "stop") return "is-stop";
  if (direction === "uncertain") return "is-uncertain";
  if (result?.curb_warning?.active) return "is-warning";
  if (direction === "left" || direction === "slight_left" || direction === "right" || direction === "slight_right") {
    return "is-turn";
  }
  return "is-center";
}

function traversableSummary(result: VisionAnalysisResponse | null): string {
  const traversable = result?.traversable;
  if (!traversable) return "None";
  const column = traversable.best_column === null ? "none" : String(traversable.best_column);
  const score = typeof traversable.best_score === "number" ? traversable.best_score.toFixed(2) : "0.00";
  return `${traversable.best_direction} · col ${column} · score ${score}`;
}

function scanBandSummary(result: VisionAnalysisResponse | null): string {
  const band = result?.traversable?.scan_band;
  if (!band) return "None";
  return `y ${band.top_y}-${band.bottom_y} · ${band.grid_rows}x${band.grid_cols} · ${band.source ?? "none"}`;
}

function crosswalkSummary(result: VisionAnalysisResponse | null): string {
  const crosswalk = result?.crosswalk;
  if (!crosswalk) return "Not active";
  if (!crosswalk.activated) return `Not active (${crosswalk.valid_row_count} scan lines)`;
  return `${crosswalk.direction ?? "unknown"} · offset ${crosswalk.offset_ratio.toFixed(2)} · ${crosswalk.intensity}`;
}

function curbSummary(result: VisionAnalysisResponse | null): string {
  const warning = result?.curb_warning;
  if (!warning?.active) return "None";
  return `${warning.curb_type ?? "curb"} · ${warning.fan_position ?? "nearby"} · ${warning.severity ?? "warning"}`;
}

function detectionColor(detection: VisionDetection): { fill: string; stroke: string } {
  if (detection.label.includes("curb")) return { fill: "rgba(239, 68, 68, 0.18)", stroke: "#ef4444" };
  if (detection.label === "road") return { fill: "rgba(14, 165, 233, 0.12)", stroke: "#38bdf8" };
  if (detection.label === "crosswalk") return { fill: "rgba(34, 197, 94, 0.18)", stroke: "#22c55e" };
  return { fill: "rgba(217, 70, 239, 0.22)", stroke: "#d946ef" };
}

function polarPoint(cx: number, cy: number, radius: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
}

function arcPath(cx: number, cy: number, radius: number, startDegrees: number, endDegrees: number): string {
  const [startX, startY] = polarPoint(cx, cy, radius, startDegrees);
  const [endX, endY] = polarPoint(cx, cy, radius, endDegrees);
  return `M ${startX} ${startY} A ${radius} ${radius} 0 0 1 ${endX} ${endY}`;
}

function sectorPath(
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  startDegrees: number,
  endDegrees: number
): string {
  const [outerStartX, outerStartY] = polarPoint(cx, cy, outerRadius, startDegrees);
  const [outerEndX, outerEndY] = polarPoint(cx, cy, outerRadius, endDegrees);
  const [innerEndX, innerEndY] = polarPoint(cx, cy, innerRadius, endDegrees);
  const [innerStartX, innerStartY] = polarPoint(cx, cy, innerRadius, startDegrees);
  return [
    `M ${outerStartX} ${outerStartY}`,
    `A ${outerRadius} ${outerRadius} 0 0 1 ${outerEndX} ${outerEndY}`,
    `L ${innerEndX} ${innerEndY}`,
    `A ${innerRadius} ${innerRadius} 0 0 0 ${innerStartX} ${innerStartY}`,
    "Z"
  ].join(" ");
}

function warningSectorAngles(position?: string | null): [number, number] | null {
  if (position === "left") return [220, 250];
  if (position === "front") return [250, 290];
  if (position === "right") return [290, 320];
  return null;
}

function cellFill(score: number, selected: boolean): string {
  if (selected) return "rgba(34, 197, 94, 0.22)";
  if (score < 0.18) return "rgba(239, 68, 68, 0.16)";
  if (score < 0.45) return "rgba(245, 158, 11, 0.13)";
  return "rgba(168, 85, 247, 0.12)";
}

function containedRect(stage: FrameSize, frame: FrameSize): StageRect {
  const stageWidth = Math.max(1, stage.width);
  const stageHeight = Math.max(1, stage.height);
  const frameWidth = Math.max(1, frame.width);
  const frameHeight = Math.max(1, frame.height);
  const scale = Math.min(stageWidth / frameWidth, stageHeight / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return {
    x: (stageWidth - width) / 2,
    y: (stageHeight - height) / 2,
    width,
    height
  };
}

function mapX(value: number, frame: FrameSize, rect: StageRect): number {
  return rect.x + (value / Math.max(1, frame.width)) * rect.width;
}

function mapY(value: number, frame: FrameSize, rect: StageRect): number {
  return rect.y + (value / Math.max(1, frame.height)) * rect.height;
}

function isNearHighCurb(result: VisionAnalysisResponse): boolean {
  const warning = result.curb_warning;
  if (!warning?.active) return false;
  const nearZone = typeof warning.fan_zone === "number" && warning.fan_zone >= 0 && warning.fan_zone <= 2;
  return warning.severity === "high" || nearZone || warning.avoidance_direction === "stop";
}

function isStopResult(result: VisionAnalysisResponse): boolean {
  return result.direction === "stop" || result.traversable?.best_direction === "stop";
}

function smoothStopResult(
  raw: VisionAnalysisResponse,
  previousStopCount: number
): { result: VisionAnalysisResponse; stopCount: number; uncertain: boolean } {
  if (!isStopResult(raw) || isNearHighCurb(raw)) {
    return { result: raw, stopCount: isStopResult(raw) ? STOP_SMOOTHING_FRAMES : 0, uncertain: false };
  }

  const stopCount = previousStopCount + 1;
  if (stopCount >= STOP_SMOOTHING_FRAMES) {
    return { result: raw, stopCount, uncertain: false };
  }

  return {
    result: {
      ...raw,
      direction: "uncertain",
      guidance_text: "Path uncertain. Continue slowly and rescan.",
      traversable: raw.traversable
        ? {
            ...raw.traversable,
            best_direction: "uncertain"
          }
        : raw.traversable
    },
    stopCount,
    uncertain: true
  };
}

function speechPhraseForResult(result: VisionAnalysisResponse, uncertain: boolean): string | null {
  if (uncertain || result.direction === "uncertain" || result.traversable?.best_direction === "uncertain") {
    return "Path uncertain. Continue slowly and rescan.";
  }
  if (result.curb_warning?.active) {
    if (result.curb_warning.fan_position === "right") return "Curb on the right, shift left.";
    if (result.curb_warning.fan_position === "left") return "Curb on the left, shift right.";
    if (result.curb_warning.fan_position === "front") return "Stop and rescan.";
    return "Curb warning.";
  }

  const direction = result.traversable?.best_direction || result.direction;
  if (direction === "stop") return "Stop and rescan.";
  if (direction === "left" || direction === "slight_left") return "Turn left.";
  if (direction === "right" || direction === "slight_right") return "Turn right.";
  if (direction === "center" || direction === "continue") return "Continue forward.";
  return null;
}

function VisionOverlay({ result, frame, stage }: { result: VisionAnalysisResponse | null; frame: FrameSize; stage: FrameSize }) {
  const stageWidth = Math.max(1, stage.width);
  const stageHeight = Math.max(1, stage.height);
  const sourceFrame = {
    width: Math.max(1, result?.image?.width ?? frame.width),
    height: Math.max(1, result?.image?.height ?? frame.height)
  };
  const videoRect = containedRect(stage, sourceFrame);
  const traversable = result?.traversable;
  const band = traversable?.scan_band;
  const scores = traversable?.adjusted_scores || traversable?.raw_scores || [];
  const rows = band?.grid_rows || scores.length || 3;
  const cols = band?.grid_cols || scores[0]?.length || 7;
  const topY = band?.top_y ?? Math.round(sourceFrame.height * 0.45);
  const bottomY = band?.bottom_y ?? sourceFrame.height;
  const stageTopY = mapY(topY, sourceFrame, videoRect);
  const stageBottomY = mapY(bottomY, sourceFrame, videoRect);
  const bandHeight = Math.max(1, stageBottomY - stageTopY);
  const cellWidth = videoRect.width / cols;
  const cellHeight = bandHeight / rows;
  const bestColumn = traversable?.best_column ?? null;
  const bestStart = traversable?.best_region?.start_column ?? bestColumn;
  const bestEnd = traversable?.best_region?.end_column ?? bestColumn;
  const noClearPath = traversable?.best_direction === "stop" || result?.direction === "stop";
  const fanCx = videoRect.x + videoRect.width / 2;
  const fanCy = videoRect.y + videoRect.height * 1.12;
  const nearRadius = videoRect.height * 0.28;
  const midRadius = videoRect.height * 0.43;
  const farRadius = videoRect.height * 0.58;
  const warningAngles = warningSectorAngles(result?.curb_warning?.fan_position);
  const labelX = bestColumn === null ? videoRect.x + videoRect.width / 2 : videoRect.x + (bestColumn + 0.5) * cellWidth;
  const labelY = Math.max(videoRect.y + 28, stageTopY - 18);
  const labelWidth = 172;
  const labelHeight = 36;

  return (
    <svg
      className="vision-camera-overlay"
      viewBox={`0 0 ${stageWidth} ${stageHeight}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="vision-corridor" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(34, 197, 94, 0.10)" />
          <stop offset="100%" stopColor="rgba(34, 197, 94, 0.50)" />
        </linearGradient>
      </defs>

      {result?.detections.map((detection, index) => {
        if (!detection.bbox || detection.bbox.length < 4) return null;
        const [x1, y1, x2, y2] = detection.bbox;
        const color = detectionColor(detection);
        const isCurb = detection.label.includes("curb");
        const rectX = mapX(x1, sourceFrame, videoRect);
        const rectY = mapY(y1, sourceFrame, videoRect);
        const rectW = Math.max(1, mapX(x2, sourceFrame, videoRect) - rectX);
        const rectH = Math.max(1, mapY(y2, sourceFrame, videoRect) - rectY);
        return (
          <g key={`${detection.label}-${index}`}>
            <rect
              x={rectX}
              y={rectY}
              width={rectW}
              height={rectH}
              fill={color.fill}
              stroke={color.stroke}
              strokeWidth={isCurb ? 2.4 : 1.3}
              strokeDasharray={isCurb ? undefined : "8 7"}
            />
            {isCurb && (
              <line
                x1={rectX}
                y1={rectY + rectH}
                x2={rectX + rectW}
                y2={rectY + rectH}
                stroke={color.stroke}
                strokeWidth={4}
                strokeLinecap="round"
              />
            )}
          </g>
        );
      })}

      {scores.map((row, rowIndex) =>
        row.map((score, columnIndex) => {
          const x = columnIndex * cellWidth;
          const y = stageTopY + rowIndex * cellHeight;
          const selected = bestColumn === columnIndex;
          return (
            <g key={`${rowIndex}-${columnIndex}`}>
              <rect
                x={videoRect.x + x}
                y={y}
                width={cellWidth}
                height={cellHeight}
                fill={cellFill(score, selected)}
                stroke={selected ? "rgba(134, 239, 172, 0.9)" : "rgba(255, 255, 255, 0.58)"}
                strokeWidth={selected ? 1.8 : 0.85}
              />
            </g>
          );
        })
      )}

      {bestStart !== null && bestEnd !== null && !noClearPath && (
        <rect
          x={videoRect.x + bestStart * cellWidth}
          y={stageTopY}
          width={(bestEnd - bestStart + 1) * cellWidth}
          height={bandHeight}
          fill="url(#vision-corridor)"
          stroke="#22c55e"
          strokeWidth={3.2}
        />
      )}

      {noClearPath && <rect x={videoRect.x} y={stageTopY} width={videoRect.width} height={bandHeight} fill="rgba(220, 38, 38, 0.20)" />}

      {[220, 250, 290, 320].map((degrees) => {
        const [x, y] = polarPoint(fanCx, fanCy, farRadius, degrees);
        return (
          <line
            key={degrees}
            x1={fanCx}
            y1={fanCy}
            x2={x}
            y2={y}
            stroke="rgba(255, 255, 255, 0.64)"
            strokeWidth={1.4}
          />
        );
      })}

      {warningAngles && (
        <path
          d={sectorPath(fanCx, fanCy, nearRadius * 0.2, farRadius, warningAngles[0], warningAngles[1])}
          fill={result?.curb_warning?.severity === "high" ? "rgba(239, 68, 68, 0.22)" : "rgba(245, 158, 11, 0.20)"}
        />
      )}

      <path d={arcPath(fanCx, fanCy, farRadius, 220, 320)} fill="none" stroke="#22c55e" strokeWidth={3.2} />
      <path d={arcPath(fanCx, fanCy, midRadius, 220, 320)} fill="none" stroke="#facc15" strokeWidth={3.2} />
      <path d={arcPath(fanCx, fanCy, nearRadius, 220, 320)} fill="none" stroke="#ef4444" strokeWidth={3.6} />

      <g className={`vision-overlay__direction ${directionClass(result)}`}>
        <rect
          x={Math.max(videoRect.x + 6, Math.min(videoRect.x + videoRect.width - labelWidth - 6, labelX - labelWidth / 2))}
          y={labelY - labelHeight / 2}
          width={labelWidth}
          height={labelHeight}
          rx={8}
        />
        <text x={Math.max(videoRect.x + 92, Math.min(videoRect.x + videoRect.width - 92, labelX))} y={labelY + 5} textAnchor="middle">
          {directionLabel(result)}
        </text>
      </g>

      {result?.curb_warning?.active && (
        <text x={videoRect.x + videoRect.width / 2} y={videoRect.y + videoRect.height - 86} className="vision-overlay__warning" textAnchor="middle">
          CURB {result.curb_warning.fan_position?.toUpperCase() || "WARNING"}
        </text>
      )}
    </svg>
  );
}

function ScoreGrid({ title, scores, bestColumn }: { title: string; scores?: number[][] | null; bestColumn?: number | null }) {
  if (!scores || scores.length === 0) return null;
  return (
    <div className="vision-score-grid-block">
      <span>{title}</span>
      <div className="vision-score-grid" role="img" aria-label={`${title} traversable score grid`}>
        {scores.flatMap((row, rowIndex) =>
          row.map((value, columnIndex) => {
            const alpha = Math.max(0.08, Math.min(0.78, 0.08 + value * 0.7));
            const selected = bestColumn === columnIndex;
            return (
              <span
                key={`${rowIndex}-${columnIndex}`}
                className={selected ? "vision-score-cell vision-score-cell--selected" : "vision-score-cell"}
                style={{
                  backgroundColor: `rgba(29, 78, 216, ${alpha})`,
                  color: value > 0.55 ? "#ffffff" : "#111827"
                }}
                title={`row ${rowIndex + 1}, column ${columnIndex + 1}: ${scoreText(value)}`}
              >
                {scoreText(value)}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}

async function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.72): Promise<Blob> {
  if (canvas.toBlob) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob) return blob;
  }

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const response = await fetch(dataUrl);
  return response.blob();
}

function getVisionErrorDetails(err: unknown, requestInfo: VisionRequestInfo): VisionErrorDetails {
  if (err instanceof VisionApiError) {
    const exception = err.causeMessage ?? "";
    const message = exception ? `${err.message} ${exception}` : err.message;
    return {
      message,
      method: err.method,
      url: err.displayUrl || err.url,
      status: err.status ? String(err.status) : "No response",
      responseText: err.responseText ?? "None",
      exception: exception || "None"
    };
  }

  const exception = err instanceof Error ? err.message : String(err);
  return {
    message: exception || "Vision request failed.",
    method: requestInfo.method,
    url: requestInfo.displayUrl,
    status: "No response",
    responseText: "None",
    exception: exception || "None"
  };
}

function debugJsonSummary(
  result: VisionAnalysisResponse | null,
  stopSmoothingCount: number,
  pathUncertain: boolean,
  feedbackEnabled: boolean,
  speechEnabled: boolean
): string {
  if (!result) return "None";
  return JSON.stringify(
    {
      mode: result.mode,
      direction: result.direction,
      guidance_text: result.guidance_text,
      client_state: {
        stop_smoothing_count: stopSmoothingCount,
        stop_smoothing_threshold: STOP_SMOOTHING_FRAMES,
        path_uncertain: pathUncertain,
        feedback_enabled: feedbackEnabled,
        speech_enabled: speechEnabled
      },
      traversable: result.traversable
        ? {
            best_direction: result.traversable.best_direction,
            best_column: result.traversable.best_column,
            best_score: result.traversable.best_score,
            scan_band: result.traversable.scan_band,
            column_scores: result.traversable.column_scores,
            penalized_scores: result.traversable.penalized_scores
          }
        : null,
      curb_warning: result.curb_warning,
      crosswalk: result.crosswalk
    },
    null,
    2
  );
}

export default function VisionPanel({ open, onClose }: Props) {
  const [mode, setMode] = useState<VisionMode>("crosswalk");
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState("");
  const [errorDetails, setErrorDetails] = useState<VisionErrorDetails | null>(null);
  const [result, setResult] = useState<VisionAnalysisResponse | null>(null);
  const [lastResponseMs, setLastResponseMs] = useState<number | null>(null);
  const [lastResponseAt, setLastResponseAt] = useState<string>("");
  const [requestInfo, setRequestInfo] = useState<VisionRequestInfo>(() => visionRequestInfo("crosswalk"));
  const [feedbackEnabled, setFeedbackEnabled] = useState(false);
  const [speechEnabled, setSpeechEnabled] = useState(false);
  const [previewFrame, setPreviewFrame] = useState<FrameSize>(DEFAULT_FRAME);
  const [stageSize, setStageSize] = useState<FrameSize>(DEFAULT_STAGE);
  const [stopSmoothingCount, setStopSmoothingCount] = useState(0);
  const [pathUncertain, setPathUncertain] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const modeRef = useRef<VisionMode>(mode);
  const stopSmoothingRef = useRef(0);
  const speechEnabledRef = useRef(false);
  const lastSpeechKeyRef = useRef("");
  const lastSpeechAtRef = useRef(0);
  const feedbackRef = useRef<VisionFeedbackController | null>(null);
  if (!feedbackRef.current) {
    feedbackRef.current = createVisionFeedbackController();
  }

  const overlayFrame = result?.image ?? previewFrame;

  useEffect(() => {
    modeRef.current = mode;
    setRequestInfo(visionRequestInfo(mode));
    stopSmoothingRef.current = 0;
    setStopSmoothingCount(0);
    setPathUncertain(false);
  }, [mode]);

  useEffect(() => {
    speechEnabledRef.current = speechEnabled;
  }, [speechEnabled]);

  useEffect(() => {
    if (!open) stopCv();
    return () => stopCv(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setStageSize({ width, height });
      }
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      stopSpeaking();
      void feedbackRef.current?.close();
    };
  }, []);

  function updatePreviewFrame() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    setPreviewFrame({ width: video.videoWidth, height: video.videoHeight });
  }

  async function toggleFeedback() {
    const nextEnabled = !feedbackEnabled;
    setFeedbackEnabled(nextEnabled);
    await feedbackRef.current?.setEnabled(nextEnabled);
  }

  function toggleSpeech() {
    const nextEnabled = !speechEnabled;
    if (nextEnabled && !canSpeak()) {
      setError("Speech synthesis is not available in this browser.");
      return;
    }
    setSpeechEnabled(nextEnabled);
    if (!nextEnabled) {
      stopSpeaking();
      lastSpeechKeyRef.current = "";
      lastSpeechAtRef.current = 0;
    }
  }

  function maybeSpeak(resultToSpeak: VisionAnalysisResponse, uncertain: boolean) {
    if (!speechEnabledRef.current) return;
    const phrase = speechPhraseForResult(resultToSpeak, uncertain);
    if (!phrase) return;

    const now = performance.now();
    const key = `${phrase}:${resultToSpeak.curb_warning?.fan_zone ?? ""}`;
    if (key === lastSpeechKeyRef.current && now - lastSpeechAtRef.current < SPEECH_COOLDOWN_MS) return;

    lastSpeechKeyRef.current = key;
    lastSpeechAtRef.current = now;
    speakText(phrase, { onError: () => setError("Speech prompt failed.") });
  }

  async function startCv() {
    setError("");
    setErrorDetails(null);
    setStatus("Requesting camera");
    if (feedbackEnabled) {
      void feedbackRef.current?.setEnabled(true);
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera access is not available in this browser.");
      setStatus("Camera unavailable");
      return;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        updatePreviewFrame();
      }

      setIsRunning(true);
      setStatus("Running");
      timerRef.current = window.setInterval(captureAndAnalyze, FRAME_INTERVAL_MS);
      window.setTimeout(captureAndAnalyze, 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Camera permission failed.");
      setStatus("Camera error");
      stopCv();
    }
  }

  function stopCv(updateState = true) {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    pendingRef.current = false;
    feedbackRef.current?.reset();
    stopSpeaking();
    lastSpeechKeyRef.current = "";
    lastSpeechAtRef.current = 0;
    stopSmoothingRef.current = 0;
    setStopSmoothingCount(0);
    setPathUncertain(false);
    if (updateState) {
      setIsRunning(false);
      setStatus("Stopped");
    }
  }

  async function captureAndAnalyze() {
    if (pendingRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2 || video.videoWidth === 0) return;

    pendingRef.current = true;
    setStatus("Analyzing frame");
    updatePreviewFrame();
    const activeRequestInfo = visionRequestInfo(modeRef.current);
    setRequestInfo(activeRequestInfo);

    try {
      const maxWidth = 640;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Unable to capture camera frame.");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await canvasToJpegBlob(canvas);
      const started = performance.now();
      const response = await analyzeVisionBlob(blob, modeRef.current, 0.4, "camera-frame.jpg");
      const elapsed = Math.round(performance.now() - started);
      const smoothed = smoothStopResult(response, stopSmoothingRef.current);
      stopSmoothingRef.current = smoothed.stopCount;

      setResult(smoothed.result);
      setLastResponseMs(elapsed);
      setLastResponseAt(new Date().toLocaleTimeString());
      setStopSmoothingCount(smoothed.stopCount);
      setPathUncertain(smoothed.uncertain);
      setStatus("Running");
      setError("");
      setErrorDetails(null);
      feedbackRef.current?.notify(smoothed.result);
      maybeSpeak(smoothed.result, smoothed.uncertain);
    } catch (err) {
      const details = getVisionErrorDetails(err, activeRequestInfo);
      setError(details.message);
      setErrorDetails(details);
      setStatus("Request failed");
    } finally {
      pendingRef.current = false;
    }
  }

  return (
    <div className="vision-overlay" role="dialog" aria-modal="true" aria-label="Vision Test">
      <section className="vision-card vision-card--camera-first">
        <div className="vision-card__header">
          <div>
            <h3>Vision Test</h3>
            <p>Prototype only. Not for real navigation or safety-critical use.</p>
          </div>
          <button type="button" className="vision-card__close" onClick={() => { stopCv(); onClose(); }}>
            Close
          </button>
        </div>

        <div className="vision-camera-stage" ref={stageRef}>
          <video
            className="vision-card__video"
            ref={videoRef}
            muted
            playsInline
            autoPlay
            onLoadedMetadata={updatePreviewFrame}
          />
          <VisionOverlay result={result} frame={overlayFrame} stage={stageSize} />
          <div className={`vision-guidance vision-guidance--${directionClass(result)}`}>
            <strong>{directionLabel(result)}</strong>
            <span>{result?.guidance_text || "Start CV to analyze the live camera view."}</span>
          </div>
          <div className="vision-status-pill">{status}</div>
        </div>
        <canvas ref={canvasRef} hidden />

        <div className="vision-card__modes" role="group" aria-label="Vision mode">
          <button type="button" aria-pressed={mode === "crosswalk"} onClick={() => setMode("crosswalk")}>
            Crosswalk
          </button>
          <button type="button" aria-pressed={mode === "open_path"} onClick={() => setMode("open_path")}>
            Open path
          </button>
        </div>

        <div className="vision-card__actions">
          <button type="button" className="vision-card__analyze" onClick={startCv} disabled={isRunning}>
            Start CV
          </button>
          <button type="button" className="vision-card__stop" onClick={() => stopCv()} disabled={!isRunning}>
            Stop CV
          </button>
          <button
            type="button"
            className="vision-card__feedback"
            aria-pressed={feedbackEnabled}
            onClick={toggleFeedback}
          >
            {feedbackEnabled ? "Feedback On" : "Feedback Off"}
          </button>
          <button
            type="button"
            className="vision-card__speech"
            aria-pressed={speechEnabled}
            onClick={toggleSpeech}
          >
            {speechEnabled ? "Speech On" : "Speech Off"}
          </button>
        </div>

        {error && <p className="vision-card__error">{error}</p>}

        <details className="vision-card__details">
          <summary>Debug details</summary>
          <div className="vision-card__result" aria-live="polite">
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{status}</dd>
              </div>
              <div>
                <dt>Response</dt>
                <dd>{lastResponseMs !== null ? `${lastResponseMs} ms · ${lastResponseAt}` : "None"}</dd>
              </div>
              <div>
                <dt>API Base</dt>
                <dd className="vision-card__url" title={VISION_API_BASE}>{VISION_API_BASE}</dd>
              </div>
              <div>
                <dt>Configured</dt>
                <dd className="vision-card__url" title={VISION_RAW_API_BASE}>{VISION_RAW_API_BASE}</dd>
              </div>
              <div>
                <dt>Request</dt>
                <dd className="vision-card__url" title={`${requestInfo.method} ${requestInfo.displayUrl}`}>
                  {requestInfo.method} {requestInfo.displayUrl}
                </dd>
              </div>
              <div>
                <dt>Direction</dt>
                <dd>{result?.direction || "Unknown"}</dd>
              </div>
              <div>
                <dt>Smoothing</dt>
                <dd>{pathUncertain ? `uncertain ${stopSmoothingCount}/${STOP_SMOOTHING_FRAMES}` : `${stopSmoothingCount}/${STOP_SMOOTHING_FRAMES}`}</dd>
              </div>
              <div>
                <dt>Feedback</dt>
                <dd>{feedbackEnabled ? "On" : "Off"} · Speech {speechEnabled ? "On" : "Off"}</dd>
              </div>
              <div>
                <dt>Best path</dt>
                <dd>{traversableSummary(result)}</dd>
              </div>
              <div>
                <dt>Scan band</dt>
                <dd className="vision-card__url">{scanBandSummary(result)}</dd>
              </div>
              <div>
                <dt>Labels</dt>
                <dd>{result?.detected_classes.join(", ") || "None"}</dd>
              </div>
              <div>
                <dt>Curb</dt>
                <dd>{curbSummary(result)}</dd>
              </div>
              <div>
                <dt>Crosswalk</dt>
                <dd>{crosswalkSummary(result)}</dd>
              </div>
              <div>
                <dt>Sidewalk</dt>
                <dd>{pct(result?.areas.sidewalk)}</dd>
              </div>
            </dl>
            {result?.traversable && (
              <div className="vision-card__scores">
                <strong>Traversable-space grid</strong>
                <ScoreGrid title="Raw" scores={result.traversable.raw_scores} bestColumn={result.traversable.best_column} />
                <ScoreGrid title="Adjusted" scores={result.traversable.adjusted_scores} bestColumn={result.traversable.best_column} />
              </div>
            )}
            <pre className="vision-card__json">{debugJsonSummary(result, stopSmoothingCount, pathUncertain, feedbackEnabled, speechEnabled)}</pre>
            {errorDetails && (
              <div className="vision-card__debug" role="alert">
                <strong>Last request error</strong>
                <dl>
                  <div>
                    <dt>Method</dt>
                    <dd>{errorDetails.method}</dd>
                  </div>
                  <div>
                    <dt>URL</dt>
                    <dd className="vision-card__url">{errorDetails.url}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{errorDetails.status}</dd>
                  </div>
                  <div>
                    <dt>Exception</dt>
                    <dd className="vision-card__url">{errorDetails.exception}</dd>
                  </div>
                  <div>
                    <dt>Body</dt>
                    <dd className="vision-card__url">{errorDetails.responseText}</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        </details>
      </section>
    </div>
  );
}
