from pathlib import Path
import os

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parents[0]
DATA_DIR = PROJECT_ROOT / "data" / "app_data"
FRONTEND_DIST_DIR = PROJECT_ROOT / "frontend" / "dist"
VISION_MODEL_DIR = BACKEND_DIR / "app" / "models" / "vision"

APP_TITLE = "Central Park Navigation API"
DEFAULT_ALLOW_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost",
    "http://127.0.0.1",
    "capacitor://localhost",
    "ionic://localhost",
    "http://10.0.0.79:8000",
]
ALLOW_ORIGINS = (
    [origin.strip() for origin in os.getenv("ALLOW_ORIGINS", "").split(",") if origin.strip()]
    if os.getenv("ALLOW_ORIGINS")
    else DEFAULT_ALLOW_ORIGINS
)

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-4.1-mini")
OPENROUTER_URL = os.getenv("OPENROUTER_URL", "https://openrouter.ai/api/v1/chat/completions")
