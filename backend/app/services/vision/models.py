from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


OPEN_PATH_CLASSES = ["curb_down", "curb_up", "road", "sidewalk"]
CROSSWALK_CLASSES = ["crosswalk", "curb_down", "curb_up", "road", "sidewalk"]


@dataclass
class VisionDetection:
    label: str
    class_id: int
    confidence: float
    bbox: list[float]
    area_ratio: float = 0.0
    mask_shape: list[int] | None = None
    contour: list[list[int]] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class OpenPathResult:
    direction: str | None
    best_column: int | None
    vibration_intensity: str
    sidewalk_top_y: int | None
    raw_scores: list[list[float]] | None = None
    adjusted_scores: list[list[float]] | None = None
    traversable_source: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SidewalkResult:
    direction: str | None
    left_density: float
    center_density: float
    right_density: float
    sidewalk_top_y: int | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CurbWarning:
    active: bool
    curb_type: str | None = None
    fan_position: str | None = None
    fan_zone: int | None = None
    severity: str = "none"
    angle_degrees: float | None = None
    distance_score: float | None = None
    avoidance_direction: str | None = None
    guidance: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CrosswalkResult:
    activated: bool = False
    offset_ratio: float = 0.0
    direction: str | None = None
    intensity: str = "none"
    crosswalk_center_x: float | None = None
    valid_row_count: int = 0
    row_centers: list[dict[str, float]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

