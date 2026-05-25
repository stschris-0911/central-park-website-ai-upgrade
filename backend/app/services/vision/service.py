from __future__ import annotations

from pathlib import Path
from typing import Any

from app.config import VISION_MODEL_DIR
from app.services.vision.curb_detection import (
    CurbDetectionService,
    VisionDependencyError,
    VisionModelError,
    decode_base64_image,
    decode_image_bytes,
    dependency_status,
)
from app.services.vision.crosswalk_detection import CrosswalkDetectionService
from app.services.vision.models import CROSSWALK_CLASSES, OPEN_PATH_CLASSES


class VisionService:
    def __init__(self, model_dir: Path = VISION_MODEL_DIR):
        self.model_dir = model_dir
        self._curb_service: CurbDetectionService | None = None
        self._crosswalk_service: CrosswalkDetectionService | None = None

    def health(self) -> dict[str, Any]:
        open_path_model = self.model_dir / "best.pt"
        crosswalk_model = self.model_dir / "crosswalk.pt"
        deps = dependency_status()
        model_files = {
            "open_path": {
                "path": str(open_path_model),
                "exists": open_path_model.exists(),
                "classes": OPEN_PATH_CLASSES,
                "loaded": bool(self._curb_service and self._curb_service.segmenter.is_loaded),
            },
            "crosswalk": {
                "path": str(crosswalk_model),
                "exists": crosswalk_model.exists(),
                "classes": CROSSWALK_CLASSES,
                "loaded": bool(self._crosswalk_service and self._crosswalk_service.segmenter.is_loaded),
            },
        }
        if not all(deps.values()):
            status = "missing_dependencies"
        elif not all(model["exists"] for model in model_files.values()):
            status = "missing_models"
        else:
            status = "ready"
        return {
            "status": status,
            "dependencies": deps,
            "models": model_files,
            "supports": {
                "static_image_upload": True,
                "base64_image": True,
                "live_camera_streaming": False,
                "hardware_haptics": False,
            },
        }

    def analyze_frame_bytes(
        self,
        image_bytes: bytes,
        confidence: float = 0.4,
        include_masks: bool = False,
    ) -> dict[str, Any]:
        frame = decode_image_bytes(image_bytes)
        return self.curb_service.analyze_frame(frame, confidence=confidence, include_masks=include_masks)

    def analyze_frame_base64(
        self,
        image_base64: str,
        confidence: float = 0.4,
        include_masks: bool = False,
    ) -> dict[str, Any]:
        return self.analyze_frame_bytes(decode_base64_image(image_base64), confidence, include_masks)

    def analyze_crosswalk_bytes(
        self,
        image_bytes: bytes,
        confidence: float = 0.4,
        include_masks: bool = False,
    ) -> dict[str, Any]:
        frame = decode_image_bytes(image_bytes)
        return self.crosswalk_service.analyze_crosswalk(frame, confidence=confidence, include_masks=include_masks)

    def analyze_crosswalk_base64(
        self,
        image_base64: str,
        confidence: float = 0.4,
        include_masks: bool = False,
    ) -> dict[str, Any]:
        return self.analyze_crosswalk_bytes(decode_base64_image(image_base64), confidence, include_masks)

    @property
    def curb_service(self) -> CurbDetectionService:
        if self._curb_service is None:
            self._curb_service = CurbDetectionService(self.model_dir / "best.pt")
        return self._curb_service

    @property
    def crosswalk_service(self) -> CrosswalkDetectionService:
        if self._crosswalk_service is None:
            self._crosswalk_service = CrosswalkDetectionService(self.model_dir / "crosswalk.pt")
        return self._crosswalk_service


vision_service = VisionService()
