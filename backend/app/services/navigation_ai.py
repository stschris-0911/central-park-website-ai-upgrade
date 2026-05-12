from __future__ import annotations

import json
import re
from typing import Any

import requests
from rapidfuzz import fuzz

from app.config import OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_URL
from app.models import ChatResponse, DestinationCandidate, PlanStop, RoutePoint
from app.services.data_loader import load_poi_candidates
from app.services.routing import compute_multi_stop_route, compute_route


TRIP_SPLIT_RE = re.compile(
    r"(?:\bthen\b|\band then\b|\bafter that\b|\bafterwards\b|\bnext\b|\bfinally\b|->|→|,|;|之后|然后|接着|最后|再去|再到|完了之后)",
    re.IGNORECASE,
)


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).lower().strip()
    text = re.sub(r"[^a-z0-9一-鿿\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def normalize_user_query(query: str) -> str:
    q = normalize_text(query)
    alias_map = {
        "restroom": "toilets",
        "bathroom": "toilets",
        "wc": "toilets",
        "washroom": "toilets",
        "drinking water": "water",
        "water fountain": "water",
        "gate": "gate",
        "entrance": "gate",
        "exit": "gate",
        "leave the park": "gate",
        "play area": "playground",
        "kids area": "playground",
        "plaza": "square",
        "广场": "square",
    }
    return alias_map.get(q, q)


def _strip_filler(segment: str) -> str:
    text = segment.strip()
    patterns = [
        r"^(please\s+)?(take me to|route to|go to|navigate to|bring me to|i want to go to|i need to go to|i want to visit|visit)\s+",
        r"^(然后|之后|接着|最后)\s*",
        r"^(go|visit)\s+",
    ]
    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE).strip()
    return text


def split_trip_request(message: str) -> list[str]:
    raw = message.strip()
    if not raw:
        return []
    parts = [_strip_filler(part) for part in TRIP_SPLIT_RE.split(raw)]
    return [part for part in parts if normalize_text(part)]


def resolve_query_to_category(query: str) -> dict[str, Any]:
    q = normalize_user_query(query)
    if any(x in q for x in ["bathroom", "restroom", "toilet", "washroom", "toilets", "厕所"]):
        return {"status": "selected", "category": "restroom"}
    if any(x in q for x in ["water", "drink", "水"]):
        return {"status": "selected", "category": "water"}
    if any(x in q for x in ["playground", "play area", "kids", "children", "recreation"]):
        return {"status": "selected", "category": "recreation"}
    if any(x in q for x in ["exit", "entrance", "gate", "leave the park", "离开", "出口", "入口"]):
        return {"status": "selected", "category": "entrance"}
    if any(x in q for x in ["food", "cafe", "coffee", "restaurant"]):
        return {"status": "selected", "category": "food"}
    if any(x in q for x in ["landmark", "info", "visitor", "view", "viewpoint", "scenic", "lookout", "square", "plaza", "广场"]):
        return {"status": "selected", "category": "info"}
    return {"status": "unclear", "category": None}


def fuzzy_match_score(query: str, text: str) -> float:
    query_n = normalize_text(query)
    text_n = normalize_text(text)
    if not query_n or not text_n:
        return 0.0
    score_1 = fuzz.partial_ratio(query_n, text_n)
    score_2 = fuzz.token_sort_ratio(query_n, text_n)
    score_3 = fuzz.token_set_ratio(query_n, text_n)
    return float(max(score_1, score_2, score_3))


def search_destination_fuzzy(query: str, top_k: int = 8, min_score: float = 40.0) -> list[dict[str, Any]]:
    rows = []
    for row in load_poi_candidates():
        score = fuzzy_match_score(
            query,
            f"{row.get('label','')} | {row.get('search_text','')} | {row.get('description','')}",
        )
        if score >= min_score:
            rows.append({**row, "match_score": float(score)})
    rows.sort(key=lambda item: (-float(item.get("match_score", 0)), item.get("label", "")))
    return rows[:top_k]


def build_candidate_model(row: dict[str, Any]) -> DestinationCandidate:
    return DestinationCandidate(
        node_id=str(row.get("node_id", "")),
        label=str(row.get("label", "Destination")),
        code=row.get("code"),
        category=row.get("category"),
        description=row.get("description"),
        point=[float(row["lon"]), float(row["lat"])] if row.get("lon") is not None and row.get("lat") is not None else None,
        match_score=float(row["match_score"]) if row.get("match_score") is not None else None,
    )


def _row_to_stop(row: dict[str, Any], source_query: str | None = None) -> PlanStop:
    return PlanStop(
        node_id=str(row.get("node_id", "")) or None,
        label=str(row.get("label", "Destination")),
        code=row.get("code"),
        category=row.get("category"),
        description=row.get("description"),
        point=[float(row["lon"]), float(row["lat"])] if row.get("lon") is not None and row.get("lat") is not None else None,
        source_query=source_query,
    )


def _meters_from_lonlat(a: tuple[float, float], b: tuple[float, float]) -> float:
    from math import atan2, cos, radians, sin, sqrt

    lon1, lat1 = a
    lon2, lat2 = b
    r = 6371000.0
    p1, p2 = radians(lat1), radians(lat2)
    dp = radians(lat2 - lat1)
    dl = radians(lon2 - lon1)
    x = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * r * atan2(sqrt(x), sqrt(1 - x))


def _request_prefers_routing(text: str) -> bool:
    t = normalize_text(text)
    return any(
        phrase in t
        for phrase in [
            "route to",
            "go to",
            "take me to",
            "navigate to",
            "directions to",
            "nearest",
            "how do i get to",
            "bring me to",
            "然后",
            "之后",
        ]
    )


def _call_openrouter_json(messages: list[dict[str, str]]) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-OpenRouter-Title": "Central Park AI Navigation",
    }
    payload = {
        "model": OPENROUTER_MODEL,
        "messages": messages,
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    response = requests.post(OPENROUTER_URL, headers=headers, json=payload, timeout=60)
    response.raise_for_status()
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    return json.loads(content)


def _resolve_destination_with_ai(user_query: str, candidates: list[dict[str, Any]]) -> dict[str, Any]:
    if not OPENROUTER_API_KEY:
        return {"decision": "clarify", "clarification_question": "Which destination did you mean?"}

    condensed = [
        {
            "candidate_id": str(idx),
            "label": row.get("label"),
            "category": row.get("category"),
            "description": row.get("description"),
            "match_score": row.get("match_score"),
        }
        for idx, row in enumerate(candidates)
    ]
    system_prompt = """
You help choose a destination for a park navigation app.

Return JSON only:
{
  "decision": "select" | "clarify" | "reject",
  "selected_candidate_id": "",
  "clarification_question": "",
  "reason": ""
}

Use "select" only when one option clearly matches. Use "clarify" when multiple are plausible.
"""
    user_prompt = f"""User query: {user_query}

Candidates:
{json.dumps(condensed, ensure_ascii=False, indent=2)}"""
    return _call_openrouter_json(
        [
            {"role": "system", "content": system_prompt.strip()},
            {"role": "user", "content": user_prompt},
        ]
    )


def resolve_destination_query_hybrid(user_query: str, top_k: int = 5, direct_threshold: float = 95.0) -> dict[str, Any]:
    candidates = search_destination_fuzzy(user_query, top_k=top_k)
    if not candidates:
        return {"status": "reject", "message": "No destination match found."}

    top_score = float(candidates[0].get("match_score", 0.0))
    if top_score >= direct_threshold:
        return {"status": "selected", "selected_row": candidates[0], "method": "fuzzy_direct", "candidates": candidates}

    if len(candidates) == 1:
        return {"status": "selected", "selected_row": candidates[0], "method": "fuzzy_single", "candidates": candidates}

    gap = top_score - float(candidates[1].get("match_score", 0.0))
    if gap >= 8:
        return {"status": "selected", "selected_row": candidates[0], "method": "fuzzy_gap", "candidates": candidates}

    ai_result = _resolve_destination_with_ai(user_query, candidates)
    decision = str(ai_result.get("decision", "")).strip().lower()

    if decision == "select":
        try:
            idx = int(ai_result.get("selected_candidate_id", "0"))
            return {"status": "selected", "selected_row": candidates[idx], "method": "ai_select", "candidates": candidates}
        except Exception:
            return {"status": "clarify", "question": "Which destination did you mean?", "candidates": candidates}

    if decision == "clarify":
        return {
            "status": "clarify",
            "question": ai_result.get("clarification_question") or "Which destination did you mean?",
            "candidates": candidates,
        }

    return {"status": "reject", "message": ai_result.get("reason", "Unsupported destination query."), "candidates": candidates}


def _format_candidate_list(candidates: list[DestinationCandidate]) -> str:
    if not candidates:
        return ""
    return "; ".join(
        f"{idx + 1}. {candidate.label}{f' ({candidate.category})' if candidate.category else ''}"
        for idx, candidate in enumerate(candidates[:4])
    )


def _format_plan(plan_stops: list[PlanStop]) -> str:
    if not plan_stops:
        return "No stops planned yet."
    return " → ".join(f"{idx + 1}. {stop.label}" for idx, stop in enumerate(plan_stops))


def _needs_append(message: str) -> bool:
    text = normalize_text(message)
    return any(token in text for token in ["then", "next", "after", "finally", "然后", "之后", "接着", "最后", "add"])


# -------------------------
# Reachability-aware helpers
# -------------------------

def _pick_nearest_reachable_by_rows(
    cursor_point: RoutePoint,
    rows: list[dict[str, Any]],
    top_k: int = 8,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    candidates = []
    for row in rows:
        if row.get("lat") is None or row.get("lon") is None:
            continue
        dist = _meters_from_lonlat(
            (cursor_point.lon, cursor_point.lat),
            (float(row["lon"]), float(row["lat"])),
        )
        candidates.append({**row, "approx_distance_m": dist})

    candidates.sort(key=lambda item: float(item.get("approx_distance_m", 1e18)))
    preview = candidates[: min(len(candidates), max(top_k, 5))]

    best_row = None
    best_route_dist = float("inf")

    for row in candidates[:top_k]:
        try:
            route = compute_route(
                start_point=cursor_point,
                end_point=RoutePoint(lon=float(row["lon"]), lat=float(row["lat"])),
                strict_walkable=True,
            )
            route_dist = float(route.summary.distance_m)
            row["match_score"] = max(0.0, 100000.0 - route_dist) / 1000.0
            if route_dist < best_route_dist:
                best_route_dist = route_dist
                best_row = row
        except Exception:
            continue

    return best_row, preview


def _find_nearest_by_category(
    current_point: RoutePoint,
    category: str,
    limit: int = 8,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    rows = []
    for row in load_poi_candidates():
        if row.get("category") == category and row.get("lat") is not None and row.get("lon") is not None:
            rows.append(row)
    return _pick_nearest_reachable_by_rows(current_point, rows, top_k=limit)


def _pick_reachable_fuzzy_match(
    current_point: RoutePoint | None,
    query: str,
    rows: list[dict[str, Any]],
    top_k: int = 6,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    if current_point is None:
        return (rows[0] if rows else None), rows[:top_k]

    ranked = []
    for row in rows[:top_k]:
        if row.get("lat") is None or row.get("lon") is None:
            continue
        try:
            route = compute_route(
                start_point=current_point,
                end_point=RoutePoint(lon=float(row["lon"]), lat=float(row["lat"])),
                strict_walkable=True,
            )
            route_dist = float(route.summary.distance_m)
            score = float(row.get("match_score", 0.0))
            combined = score - (route_dist / 100.0)
            ranked.append(({**row, "route_distance_m": route_dist}, combined))
        except Exception:
            continue

    ranked.sort(key=lambda item: item[1], reverse=True)
    if not ranked:
        return None, rows[:top_k]

    chosen = ranked[0][0]
    preview = [item[0] for item in ranked[:top_k]]
    return chosen, preview


def _resolve_single_stop(segment: str, cursor_point: RoutePoint | None) -> dict[str, Any]:
    category_hint = resolve_query_to_category(segment)
    lower = normalize_text(segment)
    wants_nearest = "nearest" in lower or any(token in lower for token in ["最近", "closest"]) or category_hint["status"] == "selected"

    if category_hint["status"] == "selected" and wants_nearest:
        if cursor_point is None:
            return {"status": "need_start", "message": f"I need a start point before I can find the nearest {category_hint['category']}."}
        best, preview_rows = _find_nearest_by_category(cursor_point, category_hint["category"])
        if best is None:
            return {
                "status": "reject",
                "message": f"I couldn't find any reachable {category_hint['category']} destinations from the current start.",
            }
        return {
            "status": "selected",
            "selected_row": best,
            "candidates": preview_rows,
            "method": "nearest_reachable_category",
        }

    resolved = resolve_destination_query_hybrid(segment)
    if resolved["status"] != "selected":
        return resolved

    chosen, preview_rows = _pick_reachable_fuzzy_match(
        cursor_point,
        segment,
        resolved.get("candidates", []),
        top_k=6,
    )
    if chosen is None:
        return {
            "status": "reject",
            "message": f"I found destination matches for '{segment}', but none are reachable on the current walkable network from your start.",
            "candidates": resolved.get("candidates", []),
        }

    return {
        "status": "selected",
        "selected_row": chosen,
        "candidates": preview_rows,
        "method": "reachable_fuzzy",
    }


def _append_plan(existing: list[PlanStop], new_stops: list[PlanStop], replace: bool) -> list[PlanStop]:
    if replace:
        return list(new_stops)
    merged = list(existing)
    for stop in new_stops:
        merged.append(stop)
    return merged


def handle_chat(message: str, current_point: RoutePoint | None = None, current_plan: list[PlanStop] | None = None) -> ChatResponse:
    text = (message or "").strip()
    lower = normalize_text(text)
    plan = list(current_plan or [])

    if not text:
        return ChatResponse(reply="Please type a question.", plan_stops=plan)

    if any(cmd in lower for cmd in ["clear trip", "clear plan", "reset trip", "清空路线", "清空计划"]):
        return ChatResponse(reply="I cleared the trip plan.", intent="clear_plan", plan_action="cleared", plan_stops=[])

    if any(cmd in lower for cmd in ["show trip", "show plan", "my plan", "what is my plan", "查看路线", "查看计划"]):
        if not plan:
            return ChatResponse(reply="You do not have any planned stops yet.", intent="show_plan", plan_stops=[])
        route = None
        if current_point is not None:
            try:
                route = compute_multi_stop_route(start_point=current_point, plan_stops=plan)
            except Exception:
                route = None
        return ChatResponse(reply=f"Current trip: {_format_plan(plan)}", intent="show_plan", plan_stops=plan, route=route)

    if any(word in lower for word in ["legend", "category", "categories"]):
        return ChatResponse(
            reply="The legend includes core, restroom, water, food, info, first aid, shelter, picnic, recreation, entrance, and other. You can also click any grey walkable edge as a route start or destination.",
            intent="explain_legend",
            plan_stops=plan,
        )

    if any(phrase in lower for phrase in ["how do i route", "how to route", "how to navigate", "how does routing work"]):
        return ChatResponse(
            reply="Click a node or any grey walkable route segment to set your start. Then ask for a destination such as 'nearest restroom', or describe several stops like 'nearest restroom, then Bethesda Terrace, then nearest gate'.",
            intent="explain_routing",
            plan_stops=plan,
        )

    segments = split_trip_request(text)
    if not segments:
        segments = [text]

    replace_plan = not plan or not _needs_append(text)
    new_stops: list[PlanStop] = []
    preview_candidates: list[DestinationCandidate] = []
    cursor_point = None
    if plan and plan[-1].point:
        cursor_point = RoutePoint(lon=float(plan[-1].point[0]), lat=float(plan[-1].point[1]))
    elif current_point is not None:
        cursor_point = current_point

    for segment in segments:
        resolved = _resolve_single_stop(segment, cursor_point)

        if resolved["status"] == "need_start":
            planned = _append_plan(plan, new_stops, replace_plan)
            return ChatResponse(
                reply=resolved["message"],
                intent="need_start_point",
                normalized_query=normalize_user_query(segment),
                plan_stops=planned,
            )

        if resolved["status"] == "clarify":
            candidates = [build_candidate_model(row) for row in resolved.get("candidates", [])]
            question = resolved.get("question", "Which destination did you mean?")
            extra = _format_candidate_list(candidates)
            reply = question if not extra else f"For '{segment}', {question} Top matches: {extra}."
            planned = _append_plan(plan, new_stops, replace_plan)
            return ChatResponse(
                reply=reply,
                intent="clarify_destination",
                normalized_query=normalize_user_query(segment),
                ambiguous=True,
                clarification_question=question,
                candidates=candidates,
                plan_stops=planned,
            )

        if resolved["status"] == "reject":
            planned = _append_plan(plan, new_stops, replace_plan)
            return ChatResponse(
                reply=resolved.get("message", f"I couldn't resolve '{segment}' from the current data."),
                intent="reject_destination",
                normalized_query=normalize_user_query(segment),
                candidates=[build_candidate_model(row) for row in resolved.get("candidates", [])[:5]],
                plan_stops=planned,
            )

        selected = resolved["selected_row"]
        stop = _row_to_stop(selected, source_query=segment)
        new_stops.append(stop)
        preview_candidates.extend(build_candidate_model(row) for row in resolved.get("candidates", [])[:3])

        if stop.point:
            cursor_point = RoutePoint(lon=float(stop.point[0]), lat=float(stop.point[1]))

    final_plan = _append_plan(plan, new_stops, replace_plan)

    if current_point is None:
        return ChatResponse(
            reply=f"I built a trip plan with {len(final_plan)} stop(s): {_format_plan(final_plan)}. Select a start point on the map and ask again to draw the full walkable route.",
            intent="plan_without_start",
            normalized_query=normalize_user_query(text),
            plan_stops=final_plan,
            candidates=preview_candidates[:5],
            plan_action="replaced" if replace_plan else "appended",
        )

    route = compute_multi_stop_route(start_point=current_point, plan_stops=final_plan)
    return ChatResponse(
        reply=f"I planned {len(final_plan)} stop(s) and prepared one continuous walkable route: {_format_plan(final_plan)}.",
        intent="multi_stop_route",
        normalized_query=normalize_user_query(text),
        destination=preview_candidates[0] if preview_candidates else None,
        candidates=preview_candidates[:5],
        route=route,
        plan_stops=final_plan,
        plan_action="replaced" if replace_plan else "appended",
    )
