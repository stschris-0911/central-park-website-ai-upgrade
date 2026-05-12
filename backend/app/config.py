from pathlib import Path
import os

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parents[0]
DATA_DIR = PROJECT_ROOT / "data" / "app_data"
FRONTEND_DIST_DIR = PROJECT_ROOT / "frontend" / "dist"

APP_TITLE = "Central Park Navigation API"
ALLOW_ORIGINS = os.getenv("ALLOW_ORIGINS", "*").split(",") if os.getenv("ALLOW_ORIGINS") else ["*"]

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-4.1-mini")
OPENROUTER_URL = os.getenv("OPENROUTER_URL", "https://openrouter.ai/api/v1/chat/completions")
