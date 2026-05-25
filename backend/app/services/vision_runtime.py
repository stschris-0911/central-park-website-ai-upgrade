from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from fastapi import UploadFile


VisionMode = Literal["open_path", "crosswalk"]

ORIGINAL_FILES = ("best.pt", "crosswalk.pt", "open_path.py", "crosswalk.py")
SCRIPT_BY_MODE: dict[VisionMode, str] = {
    "open_path": "open_path.py",
    "crosswalk": "crosswalk.py",
}
REQUIRED_MODULES = ("ultralytics", "cv2", "torch", "numpy", "scipy", "pandas")


@dataclass(frozen=True)
class VisionRuntimePaths:
    repo_root: Path
    original_dir: Path
    runner: Path
    jobs_dir: Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _candidate_original_dirs(root: Path) -> list[Path]:
    configured = os.getenv("VISION_ORIGINAL_DIR")
    candidates = []
    if configured:
        candidates.append(Path(configured))
    candidates.extend(
        [
            root / "frontend" / "public" / "vision_original",
            root / "frontend" / "dist" / "vision_original",
            Path("/app/frontend/dist/vision_original"),
        ]
    )
    return candidates


def get_paths() -> VisionRuntimePaths:
    root = _repo_root()
    original_dir = next(
        (candidate for candidate in _candidate_original_dirs(root) if candidate.exists()),
        root / "frontend" / "public" / "vision_original",
    )
    jobs_dir = Path(os.getenv("VISION_JOBS_DIR", "/tmp/centralpark_vision_jobs"))
    return VisionRuntimePaths(
        repo_root=root,
        original_dir=original_dir,
        runner=root / "backend" / "app" / "vision_runtime" / "original_runner.py",
        jobs_dir=jobs_dir,
    )


def _sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _python_candidates() -> list[Path]:
    configured = os.getenv("VISION_PYTHON_BIN")
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured))
    candidates.extend([Path("/opt/anaconda3/bin/python3"), Path(sys.executable)])
    seen: set[Path] = set()
    unique: list[Path] = []
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if candidate.exists():
            unique.append(candidate)
    return unique


def _check_modules(python_bin: Path) -> dict[str, bool]:
    code = (
        "import importlib.util, json; "
        f"mods={list(REQUIRED_MODULES)!r}; "
        "print(json.dumps({m: importlib.util.find_spec(m) is not None for m in mods}))"
    )
    try:
        result = subprocess.run(
            [str(python_bin), "-c", code],
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
        )
        if result.returncode != 0:
            return {module: False for module in REQUIRED_MODULES}
        data = json.loads(result.stdout.strip() or "{}")
        return {module: bool(data.get(module)) for module in REQUIRED_MODULES}
    except Exception:
        return {module: False for module in REQUIRED_MODULES}


def choose_python() -> tuple[Path, dict[str, bool]]:
    fallback = Path(sys.executable)
    fallback_modules = _check_modules(fallback)
    for candidate in _python_candidates():
        modules = _check_modules(candidate)
        if all(modules.values()):
            return candidate, modules
        if candidate == fallback:
            fallback_modules = modules
    return fallback, fallback_modules


def status_payload() -> dict[str, Any]:
    paths = get_paths()
    python_bin, modules = choose_python()
    files = {
        name: {
            "exists": (paths.original_dir / name).exists(),
            "sha256": _sha256(paths.original_dir / name),
            "bytes": (paths.original_dir / name).stat().st_size if (paths.original_dir / name).exists() else 0,
        }
        for name in ORIGINAL_FILES
    }
    return {
        "available": all(file_info["exists"] for file_info in files.values()) and all(modules.values()),
        "python": str(python_bin),
        "original_dir": str(paths.original_dir),
        "runner": str(paths.runner),
        "files": files,
        "modules": modules,
        "modes": sorted(SCRIPT_BY_MODE.keys()),
        "message": "Original vision runtime ready."
        if all(file_info["exists"] for file_info in files.values()) and all(modules.values())
        else "Original files or Python vision dependencies are missing.",
    }


def normalize_mode(mode: str) -> VisionMode:
    normalized = mode.strip().replace("-", "_")
    if normalized in {"openPath", "openpath", "open_path"}:
        return "open_path"
    if normalized == "crosswalk":
        return "crosswalk"
    raise ValueError("mode must be open_path or crosswalk")


def _tail(text: str, limit: int = 6000) -> str:
    return text[-limit:] if len(text) > limit else text


async def save_upload(upload: UploadFile, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    await upload.close()


async def run_video(
    *,
    upload: UploadFile,
    mode: str,
    max_frames: int = 120,
    timeout_seconds: int = 90,
) -> dict[str, Any]:
    selected_mode = normalize_mode(mode)
    paths = get_paths()
    python_bin, modules = choose_python()
    missing_modules = [name for name, ok in modules.items() if not ok]
    missing_files = [name for name in ORIGINAL_FILES if not (paths.original_dir / name).exists()]
    if missing_files:
        return {
            "ok": False,
            "mode": selected_mode,
            "message": f"Missing original vision files: {', '.join(missing_files)}",
            "status": status_payload(),
        }
    if missing_modules:
        return {
            "ok": False,
            "mode": selected_mode,
            "message": f"Missing Python vision dependencies: {', '.join(missing_modules)}",
            "status": status_payload(),
        }

    job_id = uuid.uuid4().hex
    job_dir = paths.jobs_dir / job_id
    suffix = Path(upload.filename or "input.mp4").suffix or ".mp4"
    input_path = job_dir / f"input{suffix}"
    output_path = job_dir / "overlay.mp4"
    await save_upload(upload, input_path)

    command = [
        str(python_bin),
        str(paths.runner),
        "--script",
        SCRIPT_BY_MODE[selected_mode],
        "--video",
        str(input_path),
        "--output",
        str(output_path),
        "--max-frames",
        str(max(1, min(max_frames, 1200))),
        "--timeout-seconds",
        str(max(5, min(timeout_seconds, 600))),
    ]
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")

    try:
        result = subprocess.run(
            command,
            cwd=paths.original_dir,
            capture_output=True,
            text=True,
            timeout=max(10, min(timeout_seconds + 15, 660)),
            check=False,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "job_id": job_id,
            "mode": selected_mode,
            "message": "Original vision script timed out.",
            "stdout": _tail(exc.stdout or ""),
            "stderr": _tail(exc.stderr or ""),
        }

    runtime_result = None
    for line in result.stdout.splitlines():
        if line.startswith("VISION_RUNTIME_RESULT="):
            try:
                runtime_result = json.loads(line.split("=", 1)[1])
            except json.JSONDecodeError:
                runtime_result = None

    ok = result.returncode == 0 and output_path.exists() and output_path.stat().st_size > 0
    return {
        "ok": ok,
        "job_id": job_id,
        "mode": selected_mode,
        "message": "Original vision script completed." if ok else "Original vision script failed.",
        "returncode": result.returncode,
        "output_url": f"/api/vision/jobs/{job_id}/overlay" if output_path.exists() else None,
        "output_bytes": output_path.stat().st_size if output_path.exists() else 0,
        "runtime": runtime_result,
        "stdout": _tail(result.stdout),
        "stderr": _tail(result.stderr),
    }


def job_output_path(job_id: str) -> Path:
    safe_id = "".join(char for char in job_id if char.isalnum())
    return get_paths().jobs_dir / safe_id / "overlay.mp4"


def clear_job(job_id: str) -> bool:
    safe_id = "".join(char for char in job_id if char.isalnum())
    path = get_paths().jobs_dir / safe_id
    if not path.exists():
        return False
    shutil.rmtree(path)
    return True
