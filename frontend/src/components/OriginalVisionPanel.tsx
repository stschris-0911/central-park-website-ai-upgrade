import { useEffect, useRef, useState } from "react";
import {
  fetchOriginalVisionStatus,
  runOriginalVisionVideo,
  type OriginalVisionMode,
  type OriginalVisionStatus,
  type OriginalVisionVideoResult
} from "../lib/api";

const MAX_FRAMES = 120;
const LIVE_MAX_FRAMES = 36;
const LIVE_CHUNK_MS = 2400;

function supportedVideoMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "video/mp4;codecs=h264",
    "video/mp4",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function extensionForMime(type: string): string {
  return type.includes("mp4") ? "mp4" : "webm";
}

export default function OriginalVisionPanel() {
  const [mode, setMode] = useState<OriginalVisionMode>("crosswalk");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<OriginalVisionStatus | null>(null);
  const [result, setResult] = useState<OriginalVisionVideoResult | null>(null);
  const [running, setRunning] = useState(false);
  const [cameraRunning, setCameraRunning] = useState(false);
  const [cameraMessage, setCameraMessage] = useState("");
  const [expanded, setExpanded] = useState(false);

  const previewRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const cameraRunningRef = useRef(false);
  const uploadBusyRef = useRef(false);
  const modeRef = useRef(mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    fetchOriginalVisionStatus()
      .then(setStatus)
      .catch(() => {
        setStatus(null);
      });

    return () => {
      stopCamera();
    };
  }, []);

  async function handleRun() {
    if (!file || running) return;
    setRunning(true);
    setResult(null);
    try {
      const next = await runOriginalVisionVideo(file, mode, MAX_FRAMES);
      setResult(next);
      if (next.status) setStatus(next.status);
    } catch (error) {
      setResult({
        ok: false,
        mode,
        message: error instanceof Error ? error.message : "Original vision failed."
      });
    } finally {
      setRunning(false);
    }
  }

  function attachPreview(stream: MediaStream) {
    const video = previewRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    void video.play().catch(() => undefined);
  }

  async function uploadCameraChunk(blob: Blob) {
    if (!cameraRunningRef.current || uploadBusyRef.current || blob.size < 2048) return;
    uploadBusyRef.current = true;
    setRunning(true);
    setCameraMessage("Processing camera frame");

    try {
      const extension = extensionForMime(blob.type || "video/mp4");
      const chunk = new File([blob], `camera-${Date.now()}.${extension}`, {
        type: blob.type || "video/mp4"
      });
      const next = await runOriginalVisionVideo(chunk, modeRef.current, LIVE_MAX_FRAMES);
      setResult(next);
      if (next.status) setStatus(next.status);
      setCameraMessage(next.ok ? "Camera vision running" : next.message);
    } catch (error) {
      setResult({
        ok: false,
        mode: modeRef.current,
        message: error instanceof Error ? error.message : "Camera vision failed."
      });
      setCameraMessage("Camera vision failed");
    } finally {
      uploadBusyRef.current = false;
      setRunning(false);
    }
  }

  function startRecorder(stream: MediaStream) {
    const mimeType = supportedVideoMimeType();
    if (typeof MediaRecorder === "undefined" || !mimeType) {
      setCameraMessage("Camera recording is unavailable on this iPhone browser.");
      stopCamera();
      return;
    }

    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        void uploadCameraChunk(event.data);
      }
    };
    recorder.onerror = () => {
      setCameraMessage("Camera recorder failed.");
      stopCamera();
    };
    recorder.start(LIVE_CHUNK_MS);
  }

  async function startCamera() {
    if (cameraRunningRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraMessage("Camera is unavailable.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      streamRef.current = stream;
      cameraRunningRef.current = true;
      setCameraRunning(true);
      setCameraMessage("Camera vision running");
      attachPreview(stream);
      startRecorder(stream);
    } catch (error) {
      setCameraRunning(false);
      cameraRunningRef.current = false;
      setCameraMessage(error instanceof Error ? error.message : "Camera permission denied.");
    }
  }

  function stopCamera() {
    cameraRunningRef.current = false;
    setCameraRunning(false);
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (previewRef.current) {
      previewRef.current.srcObject = null;
    }
    setCameraMessage("");
  }

  const missingModules = status
    ? Object.entries(status.modules)
        .filter(([, ready]) => !ready)
        .map(([name]) => name)
    : [];
  const ready = Boolean(status?.available);
  const title = cameraMessage || (running ? "Running original script" : result?.message || status?.message || "Original vision runtime");

  return (
    <section className={`original-vision-card ${expanded ? "original-vision-card--expanded" : ""}`} aria-label="Original vision runtime">
      <div className="original-vision-card__header">
        <div>
          <h3>Original Vision</h3>
          <p>{title}</p>
        </div>
        <button type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Hide" : "Show"}
        </button>
      </div>

      {expanded ? (
        <>
          <div className="original-vision-card__mode" aria-label="Original vision mode">
            <button type="button" aria-pressed={mode === "crosswalk"} onClick={() => setMode("crosswalk")}>
              crosswalk.py
            </button>
            <button type="button" aria-pressed={mode === "open_path"} onClick={() => setMode("open_path")}>
              open_path.py
            </button>
          </div>

          <div className="original-vision-card__camera">
            <video ref={previewRef} className="original-vision-card__preview" autoPlay muted playsInline />
            <button type="button" className="original-vision-card__run" onClick={cameraRunning ? stopCamera : startCamera}>
              {cameraRunning ? "Stop Camera" : "Start Camera"}
            </button>
          </div>

          <label className="original-vision-card__file">
            <span>{file ? file.name : "Choose video"}</span>
            <input
              type="file"
              accept="video/*"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setResult(null);
              }}
            />
          </label>

          <button type="button" className="original-vision-card__run" disabled={!file || running} onClick={handleRun}>
            {running ? "Processing" : "Run Original Vision"}
          </button>

          {!ready && missingModules.length > 0 ? (
            <p className="original-vision-card__warning">
              Missing Python: {missingModules.join(", ")}
            </p>
          ) : null}

          {result?.output_url ? (
            <video
              key={result.output_url}
              className="original-vision-card__video"
              src={result.output_url}
              controls
              autoPlay={cameraRunning}
              muted={cameraRunning}
              playsInline
            />
          ) : null}

          {result ? (
            <div className="original-vision-card__meta">
              <span>{result.ok ? "OK" : "Failed"}</span>
              {result.runtime?.script ? <span>{result.runtime.script}</span> : null}
              {typeof result.runtime?.frames === "number" ? <span>{result.runtime.frames} frames</span> : null}
              {result.output_bytes ? <span>{Math.round(result.output_bytes / 1024)} KB</span> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
