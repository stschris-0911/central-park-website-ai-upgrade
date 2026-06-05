#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_DIR="$ROOT_DIR/backend/app/models/vision"
PUBLIC_MODEL_DIR="$ROOT_DIR/frontend/public/vision_coreml"
YOLO_BIN="${YOLO_BIN:-yolo}"
IMG_SIZE="${IMG_SIZE:-640}"

if ! command -v "$YOLO_BIN" >/dev/null 2>&1; then
  echo "Unable to find '$YOLO_BIN'. Install ultralytics or set YOLO_BIN=/path/to/yolo." >&2
  exit 1
fi

mkdir -p "$PUBLIC_MODEL_DIR"

export_model() {
  local name="$1"
  local source_pt="$MODEL_DIR/$name.pt"

  if [[ ! -f "$source_pt" ]]; then
    echo "Missing model: $source_pt" >&2
    exit 1
  fi

  echo "Exporting $name.pt to Core ML..."
  "$YOLO_BIN" export model="$source_pt" format=coreml imgsz="$IMG_SIZE" nms=False exist_ok=True

  echo "Exporting $name.pt to ONNX..."
  "$YOLO_BIN" export model="$source_pt" format=onnx imgsz="$IMG_SIZE" nms=False simplify=True exist_ok=True

  echo "Copying $name.mlpackage into frontend public assets..."
  rm -rf "$PUBLIC_MODEL_DIR/$name.mlpackage"
  cp -R "$MODEL_DIR/$name.mlpackage" "$PUBLIC_MODEL_DIR/$name.mlpackage"
}

export_model best
export_model crosswalk

cat <<EOF

Done.

Next steps:
  cd "$ROOT_DIR/frontend"
  npm run build
  npx cap sync ios
  open ios/App/App.xcodeproj

For iPhone offline testing, open Vision Test and select "Local Core ML".
EOF
