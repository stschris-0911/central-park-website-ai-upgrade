from __future__ import annotations

from typing import Any

from app.config import VISION_MODEL_DIR
from app.services.vision.curb_detection import CrosswalkCapableCurbService, ensure_frame_dependencies, guidance_for_curb, mask_area_ratio
from app.services.vision.models import CrosswalkResult
from app.services.vision.traversable_space import (
    TraversableSpaceAnalyzer,
    guidance_for_traversable,
    legacy_open_path_from_traversable,
)

try:
    import cv2
except Exception:  # pragma: no cover - dependency may be intentionally absent
    cv2 = None  # type: ignore[assignment]

try:
    import numpy as np
except Exception:  # pragma: no cover - dependency may be intentionally absent
    np = None  # type: ignore[assignment]


class CrosswalkCenteringAnalyzer:
    CENTER_THRESHOLD = 0.10
    SLIGHT_THRESHOLD = 0.25
    MIN_AREA_RATIO = 0.03
    MIN_VALID_ROWS = 3
    NUM_SCAN_LINES = 8
    ANALYSIS_Y_START_RATIO = 0.50

    def __init__(self, frame_width: int, frame_height: int):
        ensure_frame_dependencies()
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.user_center_x = frame_width / 2
        self.half_width = frame_width / 2
        self.analysis_y_start = int(frame_height * self.ANALYSIS_Y_START_RATIO)
        self.analysis_y_end = frame_height
        self.scan_ys = np.linspace(
            self.analysis_y_start,
            self.analysis_y_end - 1,
            self.NUM_SCAN_LINES,
        ).astype(int)

    def analyze(self, crosswalk_mask, crosswalk_area_ratio: float) -> CrosswalkResult:
        if crosswalk_mask is None or crosswalk_area_ratio < self.MIN_AREA_RATIO:
            return CrosswalkResult()

        mask_resized = cv2.resize(
            crosswalk_mask.astype(np.uint8),
            (self.frame_width, self.frame_height),
            interpolation=cv2.INTER_NEAREST,
        )
        mask_binary = (mask_resized > 0).astype(np.uint8)

        row_centers = []
        weights = []
        for y in self.scan_ys:
            row = mask_binary[y, :]
            xs = np.where(row > 0)[0]
            if len(xs) < 5:
                continue
            left_x = int(xs.min())
            right_x = int(xs.max())
            width = right_x - left_x
            center_x = (left_x + right_x) / 2.0
            y_norm = (y - self.analysis_y_start) / max(1, self.analysis_y_end - self.analysis_y_start - 1)
            weight = y_norm + 0.5
            row_centers.append({"y": float(y), "center_x": float(center_x), "width": float(width)})
            weights.append(weight)

        if len(row_centers) < self.MIN_VALID_ROWS:
            return CrosswalkResult(row_centers=row_centers, valid_row_count=len(row_centers))

        centers_arr = np.array([row["center_x"] for row in row_centers])
        weights_arr = np.array(weights)
        crosswalk_center_x = float(np.sum(centers_arr * weights_arr) / np.sum(weights_arr))
        offset_ratio = float((crosswalk_center_x - self.user_center_x) / self.half_width)
        offset_ratio = max(-1.0, min(1.0, offset_ratio))

        abs_ratio = abs(offset_ratio)
        if abs_ratio < self.CENTER_THRESHOLD:
            direction = "center"
            intensity = "weak"
        elif abs_ratio < self.SLIGHT_THRESHOLD:
            direction = "right" if offset_ratio > 0 else "left"
            intensity = "weak"
        else:
            direction = "right" if offset_ratio > 0 else "left"
            intensity = "strong"

        return CrosswalkResult(
            activated=True,
            offset_ratio=offset_ratio,
            direction=direction,
            intensity=intensity,
            crosswalk_center_x=crosswalk_center_x,
            valid_row_count=len(row_centers),
            row_centers=row_centers,
        )


def guidance_for_crosswalk(result: CrosswalkResult) -> str | None:
    if not result.activated:
        return None
    if result.direction == "center":
        return "Crosswalk centered. Continue forward."
    if result.direction == "left":
        prefix = "Move left" if result.intensity == "strong" else "Slight left"
        return f"{prefix} to center on the crosswalk."
    if result.direction == "right":
        prefix = "Move right" if result.intensity == "strong" else "Slight right"
        return f"{prefix} to center on the crosswalk."
    return "Crosswalk detected. Stay centered."


class CrosswalkDetectionService(CrosswalkCapableCurbService):
    def __init__(self, model_path=None):
        super().__init__(model_path or (VISION_MODEL_DIR / "crosswalk.pt"))

    def analyze_crosswalk(
        self,
        frame,
        confidence: float = 0.4,
        include_masks: bool = False,
    ) -> dict[str, Any]:
        ensure_frame_dependencies()
        height, width = frame.shape[:2]
        results = self.segmenter.predict(frame, confidence)
        detections, union_masks = self._collect_detections(results, width, height, confidence, include_masks)

        crosswalk_mask = union_masks.get("crosswalk")
        crosswalk_area = mask_area_ratio(crosswalk_mask, width, height)
        crosswalk_result = CrosswalkCenteringAnalyzer(width, height).analyze(crosswalk_mask, crosswalk_area)

        sidewalk_mask = union_masks.get("sidewalk")
        road_mask = union_masks.get("road")
        sidewalk_area = mask_area_ratio(sidewalk_mask, width, height)
        road_area = mask_area_ratio(road_mask, width, height)
        sidewalk_result = self._sidewalk_summary(sidewalk_mask, width, height)
        curb_warning = self._curb_warning(union_masks, detections, width, height)
        traversable_result = TraversableSpaceAnalyzer(width, height).analyze(union_masks, curb_warning)
        open_path_result = legacy_open_path_from_traversable(traversable_result)

        crosswalk_guidance = guidance_for_crosswalk(crosswalk_result)
        traversable_direction = traversable_result.get("best_direction")
        if traversable_direction == "stop":
            guidance = guidance_for_traversable("stop")
        elif curb_warning.active:
            guidance = curb_warning.guidance or guidance_for_curb(curb_warning) or "Curb nearby. Proceed carefully."
        elif crosswalk_guidance:
            guidance = crosswalk_guidance
        else:
            guidance = guidance_for_traversable(traversable_direction)

        direction = None
        if traversable_direction == "stop":
            direction = "stop"
        elif curb_warning.active:
            direction = curb_warning.avoidance_direction
        elif crosswalk_result.direction == "center":
            direction = "continue"
        elif crosswalk_result.direction is not None:
            direction = crosswalk_result.direction
        elif traversable_direction == "center":
            direction = "continue"
        else:
            direction = traversable_direction

        return {
            "mode": "crosswalk",
            "image": {"width": width, "height": height},
            "detected_classes": sorted({d.label for d in detections}),
            "detections": [d.to_dict() for d in detections],
            "areas": {
                "crosswalk": crosswalk_area,
                "sidewalk": sidewalk_area,
                "road": road_area,
                "curb_down": mask_area_ratio(union_masks.get("curb_down"), width, height),
                "curb_up": mask_area_ratio(union_masks.get("curb_up"), width, height),
            },
            "sidewalk": sidewalk_result,
            "open_path": open_path_result,
            "traversable": traversable_result,
            "curb_warning": curb_warning.to_dict(),
            "crosswalk": crosswalk_result.to_dict(),
            "direction": direction or "unknown",
            "confidence": max((d.confidence for d in detections), default=0.0),
            "guidance_text": guidance,
            "diagnostics": {
                "model_path": str(self.model_path),
                "model_loaded": self.segmenter.is_loaded,
                "confidence_threshold": confidence,
                "crosswalk_priority_active": crosswalk_result.activated,
                "traversable_scoring": "neighborhood_grid_v1",
            },
        }

    def _sidewalk_summary(self, sidewalk_mask, width: int, height: int) -> dict[str, Any]:
        from app.services.vision.curb_detection import SidewalkAnalyzer

        return SidewalkAnalyzer(width, height).analyze(sidewalk_mask).to_dict()
