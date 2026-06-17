from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.services.data_loader import PARK_DATA_DIRS, normalize_park_id  # noqa: E402
from app.services.routing import build_route_runtime_cache  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Precompute persistent route runtime caches.")
    parser.add_argument(
        "parks",
        nargs="*",
        help="Park ids to precompute. Defaults to all configured parks.",
    )
    args = parser.parse_args()

    park_ids = args.parks or list(PARK_DATA_DIRS.keys())
    for raw_park_id in park_ids:
        park_id = normalize_park_id(raw_park_id)
        payload = build_route_runtime_cache(park_id, write=True)
        cache_path = PARK_DATA_DIRS[park_id] / "route_runtime_cache.pkl"
        size_mb = cache_path.stat().st_size / (1024 * 1024)
        print(
            f"{park_id}: {payload['node_count']} nodes, "
            f"{payload['edge_count']} edges, "
            f"{len(payload['snap_records'])} snap records, "
            f"{size_mb:.2f} MB"
        )


if __name__ == "__main__":
    main()
