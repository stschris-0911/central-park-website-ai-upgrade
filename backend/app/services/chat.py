from __future__ import annotations

from app.models import ChatResponse, PlanStop, RoutePoint
from app.services.navigation_ai import handle_chat


def reply_to_chat(message: str, current_point: RoutePoint | None = None, current_plan: list[PlanStop] | None = None) -> ChatResponse:
    return handle_chat(message, current_point=current_point, current_plan=current_plan)
