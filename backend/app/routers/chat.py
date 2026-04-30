from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.models import ChatRequest, ChatResponse
from app.services.chat import reply_to_chat

router = APIRouter(prefix="/api", tags=["chat"])


@router.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    try:
        return reply_to_chat(
            request.message,
            current_point=request.current_point,
            current_plan=request.current_plan,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Chat failed: {exc}") from exc
