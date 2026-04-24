from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class LonLatPoint(BaseModel):
    lon: float
    lat: float


class RoutePoint(LonLatPoint):
    pass


class PlanStop(BaseModel):
    node_id: str | None = None
    label: str
    code: str | None = None
    category: str | None = None
    description: str | None = None
    point: list[float] | None = None  # [lon, lat]
    source_query: str | None = None


class LegSummary(BaseModel):
    order: int
    start_label: str
    end_label: str
    distance_m: float
    estimated_minutes: int


class RouteRequest(BaseModel):
    start_node_id: str | None = None
    end_node_id: str | None = None
    start_point: LonLatPoint | None = None
    end_point: LonLatPoint | None = None
    strict_walkable: bool = False


class RouteSummary(BaseModel):
    distance_m: float
    estimated_minutes: int
    description: str | None = None


class RouteEndpointInfo(BaseModel):
    kind: Literal["node", "point", "snapped_point"]
    label: str
    description: str | None = None
    point: list[float] | None = None  # [lon, lat]
    node_id: str | None = None
    category: str | None = None
    code: str | None = None


class RoutePathNode(BaseModel):
    node_id: str | None = None
    label: str
    point: list[float] | None = None
    category: str | None = None
    code: str | None = None
    description: str | None = None


class RouteGeoJSONGeometry(BaseModel):
    type: Literal["LineString"] = "LineString"
    coordinates: list[list[float]]


class RouteGeoJSONFeature(BaseModel):
    type: Literal["Feature"] = "Feature"
    geometry: RouteGeoJSONGeometry
    properties: dict[str, Any] = Field(default_factory=dict)


class RouteResponse(BaseModel):
    mode: str
    route_geojson: RouteGeoJSONFeature
    summary: RouteSummary
    start: RouteEndpointInfo | None = None
    end: RouteEndpointInfo | None = None
    path_nodes: list[RoutePathNode] = Field(default_factory=list)
    stop_sequence: list[PlanStop] = Field(default_factory=list)
    leg_summaries: list[LegSummary] = Field(default_factory=list)


class DestinationCandidate(BaseModel):
    label: str
    point: list[float] | None = None
    node_id: str | None = None
    category: str | None = None
    code: str | None = None
    description: str | None = None
    score: float | None = None


class ChatRequest(BaseModel):
    message: str
    current_point: RoutePoint | None = None
    current_plan: list[PlanStop] = Field(default_factory=list)


class ChatResponse(BaseModel):
    reply: str
    destination: DestinationCandidate | None = None
    candidates: list[DestinationCandidate] = Field(default_factory=list)
    ambiguous: bool = False
    route: RouteResponse | None = None
    stop_sequence: list[PlanStop] = Field(default_factory=list)
    leg_summaries: list[LegSummary] = Field(default_factory=list)
