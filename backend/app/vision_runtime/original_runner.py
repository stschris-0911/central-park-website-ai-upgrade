from __future__ import annotations

import argparse
import contextlib
import json
import os
import runpy
import sys
import threading
import time
import types
from pathlib import Path
from typing import Any


class _NoopFluidSynth:
    def setting(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def start(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def sfload(self, *_args: Any, **_kwargs: Any) -> int:
        return 0

    def program_select(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def cc(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def noteon(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def noteoff(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def delete(self) -> None:
        return None


class _NoopAudioThread(threading.Thread):
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        super().__init__(daemon=True)
        self.ready_event = threading.Event()
        self._running = True

    def run(self) -> None:
        self.ready_event.set()
        while self._running:
            time.sleep(0.05)

    def enqueue_phrase(self, phrase: str, priority: bool = False) -> None:
        print(json.dumps({"event": "tts", "phrase": phrase, "priority": priority}), flush=True)

    def stop(self) -> None:
        self._running = False
        self.ready_event.set()


class _NoopHapticController(threading.Thread):
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        super().__init__(daemon=True)
        self.ready_event = threading.Event()
        self.connected = False
        self._running = True

    def connect(self) -> bool:
        self.connected = False
        self.ready_event.set()
        return False

    def run(self) -> None:
        self.ready_event.set()
        while self._running:
            time.sleep(0.05)

    def stop(self) -> None:
        self._running = False
        self.ready_event.set()

    def set_column_vibration(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def clear_all(self) -> None:
        return None


class _NoopTracker:
    def print_report(self) -> None:
        print(json.dumps({"event": "profile_report", "status": "disabled"}), flush=True)


@contextlib.contextmanager
def _profile_code_block(_name: str):
    yield


def _generate_guidance_text(angle: float, direction: str, curb_type: str) -> str:
    rounded = int(round(angle))
    return f"{curb_type}_{direction}_{rounded}"


def install_runtime_stubs() -> None:
    fluidsynth = types.ModuleType("fluidsynth")
    fluidsynth.Synth = _NoopFluidSynth
    sys.modules["fluidsynth"] = fluidsynth

    audio = types.ModuleType("complete_audio_player")
    audio.CompletePrerecordedAudio = _NoopAudioThread
    audio.generate_guidance_text = _generate_guidance_text
    sys.modules["complete_audio_player"] = audio

    profiler = types.ModuleType("simple_profiler_decorator")
    profiler.profile_code_block = _profile_code_block
    profiler.tracker = _NoopTracker()
    sys.modules["simple_profiler_decorator"] = profiler

    haptic = types.ModuleType("haptic_mqtt_controller")
    haptic.HapticMQTTController = _NoopHapticController
    sys.modules["haptic_mqtt_controller"] = haptic


def install_cv2_capture(output_path: Path, max_frames: int, timeout_seconds: int) -> dict[str, Any]:
    import cv2

    state: dict[str, Any] = {
        "frames": 0,
        "started_at": time.monotonic(),
        "writer": None,
        "output_path": str(output_path),
    }

    def ensure_writer(frame: Any) -> Any:
        if state["writer"] is not None:
            return state["writer"]

        height, width = frame.shape[:2]
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(output_path), fourcc, 24.0, (width, height))
        state["writer"] = writer
        state["size"] = [width, height]
        return writer

    def imshow(_window_name: str, frame: Any) -> None:
        if frame is None:
            return
        writer = ensure_writer(frame)
        writer.write(frame)
        state["frames"] += 1

    def wait_key(_delay: int = 1) -> int:
        elapsed = time.monotonic() - state["started_at"]
        if max_frames > 0 and state["frames"] >= max_frames:
            return ord("q")
        if timeout_seconds > 0 and elapsed >= timeout_seconds:
            return ord("q")
        return -1

    def destroy_all_windows() -> None:
        writer = state.get("writer")
        if writer is not None:
            writer.release()
            state["writer"] = None

    cv2.namedWindow = lambda *_args, **_kwargs: None
    cv2.imshow = imshow
    cv2.waitKey = wait_key
    cv2.destroyAllWindows = destroy_all_windows
    return state


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the original Central Park vision script headlessly.")
    parser.add_argument("--script", required=True, choices=["open_path.py", "crosswalk.py"])
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-frames", type=int, default=120)
    parser.add_argument("--timeout-seconds", type=int, default=90)
    args = parser.parse_args()

    script_path = Path(args.script).resolve()
    if not script_path.exists():
        raise FileNotFoundError(f"Original script not found: {script_path}")

    video_path = Path(args.video).resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"Input video not found: {video_path}")

    output_path = Path(args.output).resolve()
    install_runtime_stubs()
    capture_state = install_cv2_capture(output_path, args.max_frames, args.timeout_seconds)

    previous_argv = sys.argv[:]
    previous_cwd = Path.cwd()
    started_at = time.monotonic()

    try:
        os.chdir(script_path.parent)
        sys.argv = [str(script_path), "--video", str(video_path)]
        runpy.run_path(str(script_path), run_name="__main__")
    finally:
        sys.argv = previous_argv
        os.chdir(previous_cwd)
        writer = capture_state.get("writer")
        if writer is not None:
            writer.release()
            capture_state["writer"] = None

    result = {
        "ok": True,
        "script": script_path.name,
        "video": str(video_path),
        "output": str(output_path),
        "frames": capture_state["frames"],
        "size": capture_state.get("size"),
        "elapsed_seconds": round(time.monotonic() - started_at, 3),
    }
    print("VISION_RUNTIME_RESULT=" + json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
