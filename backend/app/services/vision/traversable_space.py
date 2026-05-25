from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

try:
    import cv2
except Exception:  # pragma: no cover - dependency may be intentionally absent
    cv2 = None  # type: ignore[assignment]

try:
    import numpy as np
except Exception:  # pragma: no cover - dependency may be intentionally absent
    np = None  # type: ignore[assignment]


PATH_LIKE_LABELS = ("sidewalk", "path", "walkway", "trail", "crosswalk")
ROAD_FALLBACK_LABELS = ("road",)
CURB_LABELS = ("curb_down", "curb_up")


@dataclass
class ScanBand:
    top_y: int
    bottom_y: int
    height: int
    grid_rows: int
    grid_cols: int
    estimated_path_top_y: int | None
    source: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def guidance_for_traversable(direction: str | None) -> str:
    if direction == "stop":
        return "No clear path detected. Stop and rescan."
    if direction in {"left", "slight_left"}:
        return "Path is clearer on the left."
    if direction in {"right", "slight_right"}:
        return "Path is clearer on the right."
    if direction == "center":
        return "Open path ahead. Continue forward."
    return "Open path ahead. Continue forward."


def legacy_open_path_from_traversable(result: dict[str, Any]) -> dict[str, Any]:
    direction = result.get("best_direction")
    if direction == "stop":
        intensity = "strong"
    else:
        best_score = float(result.get("best_score") or 0.0)
        intensity = "strong" if best_score >= 0.7 else "weak" if best_score >= 0.25 else "none"

    scan_band = result.get("scan_band") or {}
    return {
        "direction": direction,
        "best_column": result.get("best_column"),
        "vibration_intensity": intensity,
        "sidewalk_top_y": scan_band.get("estimated_path_top_y") or scan_band.get("top_y"),
        "raw_scores": result.get("raw_scores"),
        "adjusted_scores": result.get("adjusted_scores"),
        "traversable_source": result.get("traversable_source"),
    }


class TraversableSpaceAnalyzer:
    """Grid-based local walkability scoring over segmentation masks.

    Future Junchi/Yunchi adapters only need to provide a dict of semantic masks
    keyed by label, resized or resizable to the input frame. The analyzer does
    not depend on YOLO-specific objects.
    """

    def __init__(
        self,
        frame_width: int,
        frame_height: int,
        grid_rows: int = 3,
        grid_cols: int = 7,
        min_path_area_ratio: float = 0.015,
    ):
        if cv2 is None or np is None:
            raise RuntimeError("Traversable-space analysis requires opencv-python-headless and numpy.")
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.grid_rows = grid_rows
        self.grid_cols = grid_cols
        self.min_path_area_ratio = min_path_area_ratio
        self.center_col = grid_cols // 2

    def analyze(self, masks: dict[str, Any], curb_warning: Any | None = None) -> dict[str, Any]:
        traversable_mask, source, source_ratios = self._select_traversable_mask(masks)
        curb_area_ratio = self._combined_area_ratio(masks, CURB_LABELS)

        if traversable_mask is None:
            scan_band = self._scan_band(None, None)
            return self._empty_result(
                scan_band,
                source_ratios,
                curb_area_ratio,
                "no_traversable_mask",
            )

        resized = self._resize(traversable_mask)
        estimated_top_y = self._mask_top_y(resized)
        scan_band = self._scan_band(estimated_top_y, source)
        raw_scores = self._raw_grid_scores(resized, scan_band)
        adjusted_scores = self._neighborhood_scores(raw_scores)
        column_scores = self._column_scores(adjusted_scores)
        penalties = self._curb_penalties(curb_warning)
        penalized_scores = np.maximum(0.0, column_scores - penalties)

        best_column = self._choose_center_preferred_column(penalized_scores)
        best_score = float(penalized_scores[best_column])
        best_region = self._best_region(penalized_scores, best_column)
        traversable_ratio = float(np.sum(resized > 0) / max(1, self.frame_width * self.frame_height))

        if best_score < 0.18 or traversable_ratio < self.min_path_area_ratio:
            best_direction = "stop"
            stop_reason = "low_traversable_score"
        else:
            best_direction = self._direction_for_region(best_region)
            stop_reason = None

        return {
            "best_direction": best_direction,
            "best_column": int(best_column),
            "best_score": round(best_score, 4),
            "best_region": best_region,
            "raw_scores": self._rounded_matrix(raw_scores),
            "adjusted_scores": self._rounded_matrix(adjusted_scores),
            "column_scores": self._rounded_list(column_scores),
            "penalized_scores": self._rounded_list(penalized_scores),
            "curb_penalties": self._rounded_list(penalties),
            "center_preference_applied": True,
            "scan_band": scan_band.to_dict(),
            "traversable_area_ratio": round(traversable_ratio, 4),
            "non_traversable_area_ratio": round(max(0.0, 1.0 - traversable_ratio), 4),
            "source_area_ratios": source_ratios,
            "curb_area_ratio": round(curb_area_ratio, 4),
            "traversable_source": source,
            "stop_reason": stop_reason,
        }

    def _select_traversable_mask(self, masks: dict[str, Any]) -> tuple[Any | None, str | None, dict[str, float]]:
        source_ratios = {
            label: round(self._area_ratio(masks.get(label)), 4)
            for label in (*PATH_LIKE_LABELS, *ROAD_FALLBACK_LABELS)
            if label in masks
        }

        path_masks = [masks.get(label) for label in PATH_LIKE_LABELS if self._area_ratio(masks.get(label)) >= self.min_path_area_ratio]
        if path_masks:
            return self._combine(path_masks), "+".join(label for label in PATH_LIKE_LABELS if self._area_ratio(masks.get(label)) >= self.min_path_area_ratio), source_ratios

        road_masks = [masks.get(label) for label in ROAD_FALLBACK_LABELS if self._area_ratio(masks.get(label)) >= self.min_path_area_ratio]
        if road_masks:
            return self._combine(road_masks), "road", source_ratios

        return None, None, source_ratios

    def _scan_band(self, estimated_path_top_y: int | None, source: str | None) -> ScanBand:
        if estimated_path_top_y is None:
            top_y = int(self.frame_height * 0.55)
        else:
            min_top = int(self.frame_height * 0.25)
            max_top = int(self.frame_height * 0.68)
            top_y = max(min_top, min(max_top, estimated_path_top_y))
        bottom_y = self.frame_height
        return ScanBand(
            top_y=top_y,
            bottom_y=bottom_y,
            height=max(1, bottom_y - top_y),
            grid_rows=self.grid_rows,
            grid_cols=self.grid_cols,
            estimated_path_top_y=estimated_path_top_y,
            source=source,
        )

    def _raw_grid_scores(self, mask, scan_band: ScanBand):
        scores = np.zeros((self.grid_rows, self.grid_cols), dtype=float)
        cell_height = max(1, scan_band.height // self.grid_rows)
        cell_width = max(1, self.frame_width // self.grid_cols)

        for row in range(self.grid_rows):
            for col in range(self.grid_cols):
                y_start = scan_band.top_y + row * cell_height
                y_end = scan_band.bottom_y if row == self.grid_rows - 1 else min(scan_band.top_y + (row + 1) * cell_height, scan_band.bottom_y)
                x_start = col * cell_width
                x_end = self.frame_width if col == self.grid_cols - 1 else min((col + 1) * cell_width, self.frame_width)
                cell = mask[y_start:y_end, x_start:x_end]
                scores[row, col] = float(np.sum(cell > 0) / cell.size) if cell.size else 0.0
        return scores

    def _neighborhood_scores(self, raw_scores):
        kernel = np.array(
            [
                [0.04, 0.08, 0.04],
                [0.10, 0.48, 0.10],
                [0.05, 0.08, 0.05],
            ],
            dtype=float,
        )
        adjusted = np.zeros_like(raw_scores, dtype=float)
        rows, cols = raw_scores.shape
        for row in range(rows):
            for col in range(cols):
                weighted = 0.0
                weight_sum = 0.0
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        src_row = row + dy
                        src_col = col + dx
                        if 0 <= src_row < rows and 0 <= src_col < cols:
                            weight = kernel[dy + 1, dx + 1]
                            weighted += raw_scores[src_row, src_col] * weight
                            weight_sum += weight
                adjusted[row, col] = weighted / max(weight_sum, 1e-6)
        return adjusted

    def _column_scores(self, adjusted_scores):
        row_weights = np.array([0.22, 0.33, 0.45], dtype=float)
        if adjusted_scores.shape[0] != len(row_weights):
            row_weights = np.ones((adjusted_scores.shape[0],), dtype=float) / adjusted_scores.shape[0]
        core_scores = np.sum(adjusted_scores * row_weights[:, None], axis=0)
        scores = np.zeros((self.grid_cols,), dtype=float)
        for col in range(self.grid_cols):
            left = max(0, col - 1)
            right = min(self.grid_cols, col + 2)
            width_score = float(np.mean(core_scores[left:right]))
            bottom_score = float(adjusted_scores[-1, col])
            distance_from_center = abs(col - self.center_col) / max(1, self.center_col)
            center_bonus = 0.045 * (1.0 - distance_from_center)
            scores[col] = 0.68 * core_scores[col] + 0.20 * width_score + 0.12 * bottom_score + center_bonus
        return np.clip(scores, 0.0, 1.0)

    def _curb_penalties(self, curb_warning: Any | None):
        penalties = np.zeros((self.grid_cols,), dtype=float)
        if curb_warning is None or not getattr(curb_warning, "active", False):
            return penalties

        severity_scale = 1.0 if getattr(curb_warning, "severity", "") == "high" else 0.65
        position = getattr(curb_warning, "fan_position", None)
        if position == "left":
            penalties = np.array([0.30, 0.22, 0.12, 0.04, 0.00, 0.00, 0.00], dtype=float)
        elif position == "right":
            penalties = np.array([0.00, 0.00, 0.00, 0.04, 0.12, 0.22, 0.30], dtype=float)
        elif position == "front":
            penalties = np.array([0.00, 0.06, 0.18, 0.30, 0.18, 0.06, 0.00], dtype=float)
        return penalties * severity_scale

    def _choose_center_preferred_column(self, scores) -> int:
        best_score = float(np.max(scores))
        candidates = np.where(scores >= best_score - 0.05)[0]
        if candidates.size == 0:
            return int(np.argmax(scores))
        return int(min(candidates, key=lambda col: (abs(int(col) - self.center_col), -float(scores[int(col)]))))

    def _best_region(self, scores, best_column: int) -> dict[str, Any]:
        threshold = max(0.25, float(scores[best_column]) * 0.72)
        start = best_column
        end = best_column
        while start > 0 and scores[start - 1] >= threshold:
            start -= 1
        while end < self.grid_cols - 1 and scores[end + 1] >= threshold:
            end += 1
        region_scores = scores[start : end + 1]
        return {
            "start_column": int(start),
            "end_column": int(end),
            "center_column": round((start + end) / 2.0, 2),
            "width_columns": int(end - start + 1),
            "score": round(float(np.mean(region_scores)), 4),
        }

    def _direction_for_region(self, region: dict[str, Any]) -> str:
        start = int(region["start_column"])
        end = int(region["end_column"])
        center = float(region["center_column"])
        if start <= self.center_col <= end:
            return "center"
        if center <= 1.5:
            return "left"
        if center < self.center_col:
            return "slight_left"
        if center >= 4.5:
            return "right"
        return "slight_right"

    def _empty_result(
        self,
        scan_band: ScanBand,
        source_ratios: dict[str, float],
        curb_area_ratio: float,
        reason: str,
    ) -> dict[str, Any]:
        zero_matrix = [[0.0 for _ in range(self.grid_cols)] for _ in range(self.grid_rows)]
        zero_columns = [0.0 for _ in range(self.grid_cols)]
        return {
            "best_direction": "stop",
            "best_column": None,
            "best_score": 0.0,
            "best_region": None,
            "raw_scores": zero_matrix,
            "adjusted_scores": zero_matrix,
            "column_scores": zero_columns,
            "penalized_scores": zero_columns,
            "curb_penalties": zero_columns,
            "center_preference_applied": True,
            "scan_band": scan_band.to_dict(),
            "traversable_area_ratio": 0.0,
            "non_traversable_area_ratio": 1.0,
            "source_area_ratios": source_ratios,
            "curb_area_ratio": round(curb_area_ratio, 4),
            "traversable_source": None,
            "stop_reason": reason,
        }

    def _resize(self, mask):
        return cv2.resize(mask.astype(np.uint8), (self.frame_width, self.frame_height), interpolation=cv2.INTER_NEAREST)

    def _combine(self, masks: list[Any]):
        resized = [self._resize(mask) for mask in masks if mask is not None]
        if not resized:
            return None
        combined = resized[0].copy()
        for mask in resized[1:]:
            combined = np.maximum(combined, mask)
        return combined

    def _area_ratio(self, mask) -> float:
        if mask is None:
            return 0.0
        resized = self._resize(mask)
        return float(np.sum(resized > 0) / max(1, self.frame_width * self.frame_height))

    def _combined_area_ratio(self, masks: dict[str, Any], labels: tuple[str, ...]) -> float:
        combined = self._combine([masks.get(label) for label in labels if masks.get(label) is not None])
        if combined is None:
            return 0.0
        return float(np.sum(combined > 0) / max(1, self.frame_width * self.frame_height))

    def _mask_top_y(self, mask) -> int | None:
        y_values = np.where(mask > 0)[0]
        if y_values.size == 0:
            return None
        return int(y_values.min())

    def _rounded_matrix(self, matrix) -> list[list[float]]:
        return [[round(float(value), 4) for value in row] for row in matrix.tolist()]

    def _rounded_list(self, values) -> list[float]:
        return [round(float(value), 4) for value in values.tolist()]
