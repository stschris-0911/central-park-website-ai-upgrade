from __future__ import annotations

import argparse
import json
from pathlib import Path

import requests


def main() -> None:
    parser = argparse.ArgumentParser(description="Test the static-frame vision API.")
    parser.add_argument("image", nargs="?", help="Path to an image frame to analyze.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000", help="Backend base URL.")
    parser.add_argument("--mode", choices=["open-path", "crosswalk"], default="crosswalk")
    parser.add_argument("--confidence", type=float, default=0.4)
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")

    if not args.image:
        response = requests.get(f"{base_url}/api/vision/health", timeout=10)
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))
        return

    image_path = Path(args.image)
    if not image_path.exists():
        raise SystemExit(f"Image not found: {image_path}")

    endpoint = "analyze-crosswalk" if args.mode == "crosswalk" else "analyze-frame"
    with image_path.open("rb") as image_file:
        response = requests.post(
            f"{base_url}/api/vision/{endpoint}",
            files={"file": (image_path.name, image_file)},
            data={"confidence": str(args.confidence)},
            timeout=120,
        )
    response.raise_for_status()
    print(json.dumps(response.json(), indent=2))


if __name__ == "__main__":
    main()

