from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.services.vision_runtime import clear_job, job_output_path, run_video, status_payload

router = APIRouter(prefix="/api/vision", tags=["vision"])


@router.get("/status")
def vision_status():
    return status_payload()


@router.post("/video")
async def vision_video(
    file: UploadFile = File(...),
    mode: str = Form("crosswalk"),
    max_frames: int = Form(120),
    timeout_seconds: int = Form(90),
):
    return await run_video(
        upload=file,
        mode=mode,
        max_frames=max_frames,
        timeout_seconds=timeout_seconds,
    )


@router.get("/jobs/{job_id}/overlay")
def vision_job_overlay(job_id: str):
    path = job_output_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Vision output not found")
    return FileResponse(path, media_type="video/mp4", filename=f"{job_id}-overlay.mp4")


@router.delete("/jobs/{job_id}")
def delete_vision_job(job_id: str):
    return {"deleted": clear_job(job_id)}
