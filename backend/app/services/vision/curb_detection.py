from __future__ import annotations

import base64
import importlib.util
import math
import os
from pathlib import Path
from typing import Any

from app.config import VISION_MODEL_DIR
from app.services.vision.models import (
    CROSSWALK_CLASSES,
    OPEN_PATH_CLASSES,
    CurbWarning,
    OpenPathResult,
    SidewalkResult,
    VisionDetection,
)
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


class VisionDependencyError(RuntimeError):
    pass


class VisionModelError(RuntimeError):
    pass


def dependency_status() -> dict[str, bool]:
    return {
        "numpy": importlib.util.find_spec("numpy") is not None,
        "opencv": importlib.util.find_spec("cv2") is not None,
        "ultralytics": importlib.util.find_spec("ultralytics") is not None,
        "torch": importlib.util.find_spec("torch") is not None,
    }


def ensure_frame_dependencies() -> None:
    if cv2 is None or np is None:
        missing = []
        if cv2 is None:
            missing.append("opencv-python-headless")
        if np is None:
            missing.append("numpy")
        raise VisionDependencyError(f"Missing vision dependency: {', '.join(missing)}")


def decode_image_bytes(image_bytes: bytes):
    ensure_frame_dependencies()
    array = np.frombuffer(image_bytes, dtype=np.uint8)
    frame = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if frame is None:
        raise VisionModelError("Unable to decode image frame.")
    return frame


def decode_base64_image(value: str) -> bytes:
    if "," in value and value.strip().lower().startswith("data:"):
        value = value.split(",", 1)[1]
    try:
        return base64.b64decode(value, validate=True)
    except Exception as exc:
        raise VisionModelError("Invalid base64 image payload.") from exc


class YOLOSegmenter:
    def __init__(self, model_path: Path, class_names: list[str]):
        self.model_path = model_path
        self.class_names = class_names
        self._model = None
        self._device = os.getenv("VISION_DEVICE", "").strip() or None

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def load(self):
        if self._model is not None:
            return self._model
        if not self.model_path.exists():
            raise VisionModelError(f"Vision model not found: {self.model_path}")
        if importlib.util.find_spec("ultralytics") is None:
            raise VisionDependencyError("Missing vision dependency: ultralytics")

        _ensure_writable_ml_cache_dirs()
        from ultralytics import YOLO

        model = YOLO(str(self.model_path))
        device = self._device or self._default_device()
        if device:
            model = model.to(device)
        self._model = model
        return model

    def _default_device(self) -> str:
        if importlib.util.find_spec("torch") is None:
            return "cpu"
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    def predict(self, frame, confidence: float):
        model = self.load()
        return model(frame, stream=False, verbose=False, conf=confidence)


def _ensure_writable_ml_cache_dirs() -> None:
    for env_name, default_path in {
        "YOLO_CONFIG_DIR": "/tmp/ultralytics",
        "MPLCONFIGDIR": "/tmp/matplotlib",
    }.items():
        target = os.getenv(env_name, default_path)
        os.environ.setdefault(env_name, target)
        try:
            Path(target).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass


class SidewalkAnalyzer:
    """Analyze left/center/right sidewalk continuity from a segmentation mask."""

    def __init__(self, frame_width: int, frame_height: int):
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.analysis_start_y = int(frame_height * 0.4)
        self.analysis_end_y = frame_height
        self.left_x = 0
        self.left_center_x = int(frame_width * 0.33)
        self.right_center_x = int(frame_width * 0.67)
        self.right_x = frame_width

    def analyze(self, sidewalk_mask) -> SidewalkResult:
        ensure_frame_dependencies()
        if sidewalk_mask is None or float(np.sum(sidewalk_mask)) == 0:
            return SidewalkResult(None, 0.0, 0.0, 0.0, self.analysis_start_y)

        mask_resized = cv2.resize(
            sidewalk_mask.astype(np.uint8),
            (self.frame_width, self.frame_height),
            interpolation=cv2.INTER_NEAREST,
        )

        sidewalk_pixels = np.where(mask_resized > 0)
        if len(sidewalk_pixels[0]) > 0:
            sidewalk_top_y = int(np.min(sidewalk_pixels[0]))
            sidewalk_top_y = max(int(self.frame_height * 0.2), sidewalk_top_y)
        else:
            sidewalk_top_y = self.analysis_start_y

        analysis_region = mask_resized[sidewalk_top_y:self.analysis_end_y, :]
        region_height = self.analysis_end_y - sidewalk_top_y

        left_total = region_height * max(1, self.left_center_x - self.left_x)
        center_total = region_height * max(1, self.right_center_x - self.left_center_x)
        right_total = region_height * max(1, self.right_x - self.right_center_x)

        left_density = float(np.sum(analysis_region[:, self.left_x:self.left_center_x] > 0) / left_total)
        center_density = float(np.sum(analysis_region[:, self.left_center_x:self.right_center_x] > 0) / center_total)
        right_density = float(np.sum(analysis_region[:, self.right_center_x:self.right_x] > 0) / right_total)

        densities = {
            "left": left_density,
            "center": center_density,
            "right": right_density,
        }
        best_direction = max(densities, key=densities.get)
        return SidewalkResult(best_direction, left_density, center_density, right_density, sidewalk_top_y)


class OpenPathAnalyzer:
    """3x7-grid open-path scoring adapted from the virtual whisker prototype."""

    def __init__(self, frame_width: int, frame_height: int):
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.grid_rows = 3
        self.grid_cols = 7
        self.decision_rows = 2
        self.decision_cols = 5
        self.cell_width = max(1, frame_width // self.grid_cols)
        self.decision_start_row = 1
        self.decision_start_col = 1

    def analyze(self, traversable_mask, source: str | None = None) -> OpenPathResult:
        ensure_frame_dependencies()
        if traversable_mask is None or float(np.sum(traversable_mask)) == 0:
            return OpenPathResult(None, None, "none", None, traversable_source=source)

        mask_resized = cv2.resize(
            traversable_mask.astype(np.uint8),
            (self.frame_width, self.frame_height),
            interpolation=cv2.INTER_NEAREST,
        )
        traversable_pixels = np.where(mask_resized > 0)
        if len(traversable_pixels[0]) > 0:
            top_y = int(np.min(traversable_pixels[0]))
            top_y = max(int(self.frame_height * 0.1), top_y)
            top_y = min(int(self.frame_height * 0.5), top_y)
        else:
            top_y = 0

        dynamic_height = max(1, self.frame_height - top_y)
        dynamic_cell_height = max(1, dynamic_height // self.grid_rows)
        raw_scores = np.zeros((self.grid_rows, self.grid_cols), dtype=float)

        for row in range(self.grid_rows):
            for col in range(self.grid_cols):
                y_start = top_y + row * dynamic_cell_height
                y_end = min(top_y + (row + 1) * dynamic_cell_height, self.frame_height)
                x_start = col * self.cell_width
                x_end = self.frame_width if col == self.grid_cols - 1 else min((col + 1) * self.cell_width, self.frame_width)
                cell_mask = mask_resized[y_start:y_end, x_start:x_end]
                total_pixels = cell_mask.size
                raw_scores[row, col] = float(np.sum(cell_mask > 0) / total_pixels) if total_pixels else 0.0

        adjusted_scores = np.zeros((self.decision_rows, self.decision_cols), dtype=float)
        for row in range(self.decision_rows):
            for col in range(self.decision_cols):
                i = row + self.decision_start_row
                j = col + self.decision_start_col
                current = raw_scores[i, j]
                top = raw_scores[i - 1, j]
                left = raw_scores[i, j - 1]
                right = raw_scores[i, j + 1]
                top_right = raw_scores[i - 1, j + 1]
                top_left = raw_scores[i - 1, j - 1]
                adjusted_scores[row, col] = 0.4 * current + 0.2 * top + 0.1 * (left + right + top_right + top_left)

        center_col = 2
        adjusted_scores[:, center_col] += 0.05
        adjusted_scores[adjusted_scores > 0.95] += 0.05

        if bool(np.all(adjusted_scores >= 0.99)):
            return OpenPathResult(
                "center",
                center_col,
                "strong",
                top_y,
                raw_scores.round(4).tolist(),
                adjusted_scores.round(4).tolist(),
                source,
            )

        column_sums = np.sum(adjusted_scores, axis=0)
        best_column = int(np.argmax(column_sums))
        best_sum = float(column_sums[best_column])

        if best_column <= 1:
            best_direction = "left"
        elif best_column >= 3:
            best_direction = "right"
        else:
            best_direction = "center"

        if best_sum < 0.8:
            vibration_intensity = "none"
        elif adjusted_scores[0, best_column] >= 0.9:
            vibration_intensity = "strong"
        else:
            vibration_intensity = "weak"

        return OpenPathResult(
            best_direction,
            best_column,
            vibration_intensity,
            top_y,
            raw_scores.round(4).tolist(),
            adjusted_scores.round(4).tolist(),
            source,
        )


class FanZoneConfig:
    def __init__(self, frame_width: int, frame_height: int):
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.center_x = frame_width // 2
        self.center_y = frame_height + int(frame_height * 0.3)
        self.center = (self.center_x, self.center_y)
        self.start_circle = int(frame_height * 0.83)
        self.circle_distance = int(frame_height * 0.19)
        self.axes_lengths = [
            (
                self.start_circle - int(frame_height * 0.31),
                self.start_circle + int(frame_height * 0.02),
            ),
            (
                self.start_circle + self.circle_distance - int(frame_height * 0.27),
                self.start_circle + self.circle_distance,
            ),
        ]
        self.start_angle = -130
        self.end_angle = -50
        self.mid_left_angle = -110
        self.mid_right_angle = -70


class FanZoneDetector:
    def __init__(self, config: FanZoneConfig):
        ensure_frame_dependencies()
        self.center = np.array(config.center, dtype=float)
        self.axes_lengths = config.axes_lengths
        self.start_angle = config.start_angle
        self.end_angle = config.end_angle
        self.mid_left_angle = config.mid_left_angle
        self.mid_right_angle = config.mid_right_angle
        self.frame_height = config.frame_height

    def classify_points(self, points):
        if points is None or len(points) == 0:
            return np.array([]), None, None, None, False
        points_array = np.asarray(points, dtype=float)
        displacement = points_array - self.center
        distances = np.linalg.norm(displacement, axis=1)
        normalized_distances = distances * (480.0 / self.frame_height)
        angles = np.degrees(np.arctan2(displacement[:, 1], displacement[:, 0]))
        angles = (angles + 360) % 360 - 360
        classifications = np.full((points_array.shape[0],), -1, dtype=int)
        valid_points = None

        for index, (x_radius, y_radius) in enumerate(reversed(self.axes_lengths)):
            within_ellipse = ((displacement[:, 0] ** 2) / (x_radius ** 2) + (displacement[:, 1] ** 2) / (y_radius ** 2)) <= 1
            within_angle = (angles >= self.start_angle) & (angles <= self.end_angle)
            if index == 0:
                valid_points = within_ellipse & within_angle

            mid_left = (angles >= self.start_angle) & (angles < self.mid_left_angle)
            mid_right = (angles > self.mid_right_angle) & (angles <= self.end_angle)
            mid = (angles < self.mid_right_angle) & (angles > self.mid_left_angle)
            classifications[within_ellipse & mid_left] = 3 - 3 * index
            classifications[within_ellipse & mid] = 4 - 3 * index
            classifications[within_ellipse & mid_right] = 5 - 3 * index

        has_points = bool(valid_points is not None and np.any(valid_points))
        if not has_points:
            return classifications, None, None, None, False

        valid_distances = normalized_distances[valid_points]
        valid_indices = np.where(valid_points)[0]
        relative_min_index = int(np.argmin(valid_distances))
        min_index = int(valid_indices[relative_min_index])
        return (
            classifications,
            float(valid_distances[relative_min_index]),
            int(classifications[min_index]),
            float(points_array[min_index, 0]),
            True,
        )


POSITION_DIRECTION = {
    0: "left",
    1: "front",
    2: "right",
    3: "left",
    4: "front",
    5: "right",
}


def fan_position(zone: int | None) -> str | None:
    return POSITION_DIRECTION.get(zone)


def mask_area_ratio(mask, frame_width: int, frame_height: int) -> float:
    if mask is None:
        return 0.0
    resized = resize_mask(mask, frame_width, frame_height)
    return float(np.sum(resized > 0) / max(1, frame_width * frame_height))


def resize_mask(mask, frame_width: int, frame_height: int):
    ensure_frame_dependencies()
    return cv2.resize(mask.astype(np.uint8), (frame_width, frame_height), interpolation=cv2.INTER_NEAREST)


def combine_masks(*masks):
    valid_masks = [mask for mask in masks if mask is not None]
    if not valid_masks:
        return None
    combined = valid_masks[0].copy()
    for mask in valid_masks[1:]:
        combined = np.maximum(combined, mask)
    return combined


def extract_curb_points(mask, frame_width: int, frame_height: int):
    if mask is None:
        return None
    mask_resized = resize_mask(mask, frame_width, frame_height)
    y_vals, x_vals = np.where(mask_resized > 0)
    if y_vals.size == 0:
        return None
    max_y_by_x = np.full(frame_width, -1, dtype=int)
    np.maximum.at(max_y_by_x, x_vals, y_vals)
    xs = np.where(max_y_by_x >= 0)[0]
    if xs.size == 0:
        return None
    return np.column_stack((xs, max_y_by_x[xs]))


def curb_angle(points) -> float | None:
    if points is None or len(points) < 3:
        return None
    x_vals = points[:, 0].astype(float)
    y_vals = points[:, 1].astype(float)
    if len(np.unique(x_vals)) < 3:
        return None
    gradients = np.gradient(y_vals, x_vals)
    average_gradient = float(np.mean(gradients))
    return float(-math.degrees(math.atan(average_gradient)))


def contour_points(mask, frame_width: int, frame_height: int, max_points: int = 80) -> list[list[int]] | None:
    if mask is None or cv2 is None or np is None:
        return None
    mask_resized = resize_mask(mask, frame_width, frame_height)
    contours, _ = cv2.findContours((mask_resized > 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    epsilon = 0.01 * cv2.arcLength(largest, True)
    approx = cv2.approxPolyDP(largest, epsilon, True).reshape(-1, 2)
    if len(approx) > max_points:
        step = max(1, len(approx) // max_points)
        approx = approx[::step][:max_points]
    return [[int(x), int(y)] for x, y in approx]


def guidance_for_open_path(direction: str | None) -> str:
    if direction == "left":
        return "Open path is to the left."
    if direction == "right":
        return "Open path is to the right."
    if direction == "center":
        return "Open path ahead. Continue forward."
    return "No clear open path detected."


def guidance_for_curb(warning: CurbWarning) -> str | None:
    if not warning.active:
        return None
    if warning.fan_position == "front":
        return "Curb ahead. Stop and scan before continuing."
    if warning.fan_position == "left":
        return "Curb on the left. Shift right."
    if warning.fan_position == "right":
        return "Curb on the right. Shift left."
    return "Curb nearby. Proceed carefully."


class CurbDetectionService:
    def __init__(
        self,
        model_path: Path | None = None,
        class_names: list[str] | None = None,
    ):
        self.class_names = class_names or OPEN_PATH_CLASSES
        self.model_path = model_path or (VISION_MODEL_DIR / "best.pt")
        self.segmenter = YOLOSegmenter(self.model_path, self.class_names)

    def analyze_frame(
        self,
        frame,
        confidence: float = 0.4,
        include_masks: bool = False,
        enable_open_path: bool = True,
    ) -> dict[str, Any]:
        ensure_frame_dependencies()
        height, width = frame.shape[:2]
        results = self.segmenter.predict(frame, confidence)
        detections, union_masks = self._collect_detections(results, width, height, confidence, include_masks)

        sidewalk_mask = union_masks.get("sidewalk")
        road_mask = union_masks.get("road")
        sidewalk_area = mask_area_ratio(sidewalk_mask, width, height)
        road_area = mask_area_ratio(road_mask, width, height)
        total_confidence = max((d.confidence for d in detections), default=0.0)

        sidewalk_result = SidewalkAnalyzer(width, height).analyze(sidewalk_mask).to_dict()
        curb_warning = self._curb_warning(union_masks, detections, width, height)
        traversable_result = (
            TraversableSpaceAnalyzer(width, height).analyze(union_masks, curb_warning)
            if enable_open_path
            else TraversableSpaceAnalyzer(width, height).analyze({}, curb_warning)
        )
        open_path_result = legacy_open_path_from_traversable(traversable_result)
        traversable_direction = traversable_result.get("best_direction")

        if traversable_direction == "stop":
            guidance = guidance_for_traversable("stop")
        elif curb_warning.active:
            guidance = curb_warning.guidance or guidance_for_curb(curb_warning) or "Curb nearby. Proceed carefully."
        else:
            guidance = guidance_for_traversable(traversable_direction)

        return {
            "mode": "open_path",
            "image": {"width": width, "height": height},
            "detected_classes": sorted({d.label for d in detections}),
            "detections": [d.to_dict() for d in detections],
            "areas": {
                "sidewalk": sidewalk_area,
                "road": road_area,
                "curb_down": mask_area_ratio(union_masks.get("curb_down"), width, height),
                "curb_up": mask_area_ratio(union_masks.get("curb_up"), width, height),
            },
            "sidewalk": sidewalk_result,
            "open_path": open_path_result,
            "traversable": traversable_result,
            "curb_warning": curb_warning.to_dict(),
            "crosswalk": None,
            "direction": self._direction_from_guidance(curb_warning, traversable_direction),
            "confidence": total_confidence,
            "guidance_text": guidance,
            "diagnostics": {
                "model_path": str(self.model_path),
                "model_loaded": self.segmenter.is_loaded,
                "confidence_threshold": confidence,
                "traversable_scoring": "neighborhood_grid_v1",
            },
        }

    def _collect_detections(self, results, width: int, height: int, confidence: float, include_masks: bool):
        detections: list[VisionDetection] = []
        union_masks: dict[str, Any] = {}
        for result in results:
            boxes = getattr(result, "boxes", None)
            masks = getattr(result, "masks", None)
            if boxes is None:
                continue

            xyxy = boxes.xyxy.cpu().numpy() if getattr(boxes, "xyxy", None) is not None else []
            confidences = boxes.conf.cpu().numpy() if getattr(boxes, "conf", None) is not None else []
            classes = boxes.cls.cpu().numpy() if getattr(boxes, "cls", None) is not None else []
            mask_data = masks.data.cpu().numpy() if masks is not None and getattr(masks, "data", None) is not None else None

            for index, (box, cls, conf) in enumerate(zip(xyxy, classes, confidences)):
                if float(conf) < confidence:
                    continue
                class_id = int(cls)
                if class_id < 0 or class_id >= len(self.class_names):
                    continue
                label = self.class_names[class_id]
                mask = mask_data[index] if mask_data is not None and index < len(mask_data) else None
                if mask is not None:
                    resized = resize_mask(mask, width, height)
                    union_masks[label] = resized if label not in union_masks else np.maximum(union_masks[label], resized)
                detections.append(
                    VisionDetection(
                        label=label,
                        class_id=class_id,
                        confidence=float(conf),
                        bbox=[float(v) for v in box],
                        area_ratio=mask_area_ratio(mask, width, height) if mask is not None else 0.0,
                        mask_shape=list(mask.shape) if mask is not None else None,
                        contour=contour_points(mask, width, height) if include_masks and mask is not None else None,
                    )
                )
        return detections, union_masks

    def _curb_warning(self, union_masks: dict[str, Any], detections: list[VisionDetection], width: int, height: int) -> CurbWarning:
        config = FanZoneConfig(width, height)
        detector = FanZoneDetector(config)
        candidates: list[CurbWarning] = []

        for label in ("curb_down", "curb_up"):
            points = extract_curb_points(union_masks.get(label), width, height)
            if points is None:
                continue
            _, distance, zone, _, has_points = detector.classify_points(points)
            angle = curb_angle(points)
            if not has_points:
                continue

            position = fan_position(zone)
            severity = "high" if zone in (0, 1, 2) else "medium"
            avoidance = None
            if position == "left":
                avoidance = "right"
            elif position == "right":
                avoidance = "left"
            elif position == "front":
                avoidance = "stop"

            warning = CurbWarning(
                active=True,
                curb_type=label,
                fan_position=position,
                fan_zone=zone,
                severity=severity,
                angle_degrees=angle,
                distance_score=distance,
                avoidance_direction=avoidance,
            )
            warning.guidance = guidance_for_curb(warning)
            candidates.append(warning)

        if not candidates:
            return CurbWarning(active=False)
        return sorted(candidates, key=lambda item: (item.distance_score is None, item.distance_score or 9999))[0]

    def _direction_from_guidance(self, warning: CurbWarning, open_path_direction: str | None) -> str:
        if open_path_direction == "stop":
            return "stop"
        if warning.active:
            return warning.avoidance_direction or "stop"
        if open_path_direction == "center":
            return "continue"
        return open_path_direction or "unknown"


class CrosswalkCapableCurbService(CurbDetectionService):
    def __init__(self, model_path: Path | None = None):
        super().__init__(model_path or (VISION_MODEL_DIR / "crosswalk.pt"), CROSSWALK_CLASSES)
