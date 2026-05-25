from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.datastructures import UploadFile as StarletteUploadFile

from app.services.vision.curb_detection import VisionDependencyError, VisionModelError, decode_base64_image
from app.services.vision.service import vision_service

router = APIRouter(prefix="/api/vision", tags=["vision"])
logger = logging.getLogger(__name__)


@router.get("/health")
def vision_health():
    return vision_service.health()


@router.options("/analyze-frame", include_in_schema=False)
@router.options("/analyze-crosswalk", include_in_schema=False)
def vision_preflight_fallback():
    return Response(status_code=204)


@router.post("/analyze-frame")
async def analyze_frame(request: Request):
    image_bytes, confidence, include_masks = await _read_image_payload(request)
    logger.info("vision analyze-frame received %s bytes confidence=%s", len(image_bytes), confidence)
    try:
        return vision_service.analyze_frame_bytes(
            image_bytes,
            confidence=confidence,
            include_masks=include_masks,
        )
    except (VisionDependencyError, VisionModelError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/analyze-crosswalk")
async def analyze_crosswalk(request: Request):
    image_bytes, confidence, include_masks = await _read_image_payload(request)
    logger.info("vision analyze-crosswalk received %s bytes confidence=%s", len(image_bytes), confidence)
    try:
        return vision_service.analyze_crosswalk_bytes(
            image_bytes,
            confidence=confidence,
            include_masks=include_masks,
        )
    except (VisionDependencyError, VisionModelError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


async def _read_image_payload(request: Request) -> tuple[bytes, float, bool]:
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        file_value = form.get("file") or form.get("image")
        if not isinstance(file_value, StarletteUploadFile):
            raise HTTPException(status_code=400, detail="Multipart payload must include a file or image field.")
        image_bytes = await file_value.read()
        confidence = _as_float(form.get("confidence"), 0.4)
        include_masks = _as_bool(form.get("include_masks"), False)
        if not image_bytes:
            raise HTTPException(status_code=400, detail="Uploaded image is empty.")
        return image_bytes, confidence, include_masks

    try:
        payload: dict[str, Any] = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="Send multipart/form-data with a file field or JSON with image_base64.",
        ) from exc

    image_base64 = payload.get("image_base64") or payload.get("image")
    if not isinstance(image_base64, str) or not image_base64.strip():
        raise HTTPException(status_code=400, detail="JSON payload must include image_base64.")

    try:
        image_bytes = decode_base64_image(image_base64)
    except VisionModelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    confidence = _as_float(payload.get("confidence"), 0.4)
    include_masks = _as_bool(payload.get("include_masks"), False)
    return image_bytes, confidence, include_masks


def _as_float(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, number))


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}
