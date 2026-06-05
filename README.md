# Central Park Navigation Website

This is a complete full-stack website package for your Central Park navigation project.

It includes:
- **frontend**: React + Vite + Leaflet
- **backend**: FastAPI
- **deployment-ready setup**: proxy config, Dockerfile, and a Render-style blueprint
- **data folder** for your exported notebook outputs
- **notebooks** with your uploaded/fixed workflow notebooks

## What changed

This version is designed as a **real deployable website**, not just a notebook or a browser-opened local prototype.

Main features:
- map + right-side chat layout
- floating legend
- walkable-network edges shown on map
- click a **node** or any **walkable route segment** to choose start and destination
- backend snapping to the graph for route computation
- path description with node metadata
- frontend uses **relative `/api` calls**, so it works in production on the same domain
- backend can serve the built frontend in production
- static-frame computer vision API for curb, sidewalk, road, and crosswalk guidance

## Required data files

Put your exported notebook files into:

```
data/app_data/
```

Recommended files:
- `final_candidate_nodes_gridcoded.geojson`
- `final_candidate_nodes_gridcoded.csv`
- `infrastructure_nodes_gridcoded.geojson`
- `infrastructure_nodes_gridcoded.csv`
- `gate_nodes_gridcoded.geojson`
- `gate_nodes_gridcoded.csv`
- `augmented_graph_edges.geojson`
- `park_graph.pkl`
- `app_manifest.json`

## Local development

### Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The vision endpoints use YOLO segmentation and require the heavier CV packages in
`backend/requirements.txt` (`ultralytics`, `torch`, `opencv-python-headless`, and
`numpy`). The backend imports this module lazily, so Jetson camera, MQTT haptic,
and custom audio-player modules are not required for the web server to start.

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open:
- frontend: `http://localhost:5173`
- backend health: `http://127.0.0.1:8000/api/health`

For local browser development, the frontend can use relative `/api` requests
through the Vite proxy/configuration already in the project. For Capacitor or
another device on your network, build with an explicit API base URL:

```bash
VITE_API_BASE_URL=http://192.168.x.x:8000 npm run build
```

Use your Mac's LAN IP address for `192.168.x.x` when testing on a real iPhone.

## Production / website deployment

This package is set up so that:
- the frontend can be built into `frontend/dist`
- the backend can serve that built frontend
- API requests use `/api`, so one domain is enough

Typical production flow:
```bash
cd frontend
npm install
npm run build

cd ../backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then deploy the repository as one service.

## Vision module

The old main app did not expose a reusable backend vision API. This version adds
a new local perception module under:

```
backend/app/services/vision/
backend/app/routers/vision.py
backend/app/models/vision/best.pt
backend/app/models/vision/crosswalk.pt
```

The module refactors the virtual-whisker prototype into backend services:
- YOLO segmentation for `curb_down`, `curb_up`, `road`, `sidewalk`, and `crosswalk`
- traversable-space scoring from sidewalk/path-like masks using a 3x7 grid,
  neighborhood-weighted cell scores, center-preferred tie breaking, and curb
  penalties
- fan-zone curb warning for left/front/right curb hazards
- crosswalk centering based on weighted lower-frame scan lines
- JSON guidance output for static image frames

The hardware-specific pieces from the prototype, such as Jetson/GStreamer camera
capture, MQTT haptics, FluidSynth beeps, and custom prerecorded audio players,
are intentionally not required by the server. Live camera streaming and mobile
navigation fusion are future work.

### Vision API

Health:

```bash
curl http://127.0.0.1:8000/api/vision/health
```

Analyze a curb/open-path frame:

```bash
curl -X POST http://127.0.0.1:8000/api/vision/analyze-frame \
  -F "file=@sample-frame.jpg" \
  -F "confidence=0.4"
```

Analyze a crosswalk frame:

```bash
curl -X POST http://127.0.0.1:8000/api/vision/analyze-crosswalk \
  -F "file=@sample-frame.jpg" \
  -F "confidence=0.4"
```

You can also use the helper script:

```bash
python scripts/test_vision_api.py --mode crosswalk sample-frame.jpg
python scripts/test_vision_api.py
```

Responses include detected labels, bounding boxes, optional contours, area
ratios, traversable-space grid scores, open-path direction, curb warning,
crosswalk centering, confidence, and human-readable guidance text. The
`traversable` field is the CurbDetector-style local navigation layer. It treats
areas outside the selected traversable mask as unavailable space, so it does not
need object-specific obstacle classes such as people, chairs, or strollers.

Important response fields:
- `traversable.best_direction`: `left`, `slight_left`, `center`,
  `slight_right`, `right`, or `stop`
- `traversable.raw_scores`: per-cell traversable pixel ratio for the scan grid
- `traversable.adjusted_scores`: neighborhood-weighted scores
- `traversable.scan_band`: the dynamic horizontal analysis band used for the
  current frame
- `curb_warning`: fan-zone curb warning, if a curb is close enough to matter
- `guidance_text`: simple demo prompt such as `Open path ahead. Continue
  forward.` or `No clear path detected. Stop and rescan.`

The current implementation uses `sidewalk`, `path`, `walkway`, `trail`, and
`crosswalk` masks as path-like traversable space. `road` is used only as a
fallback when no path-like area is available, matching the existing prototype
behavior.

### iPhone offline Core ML vision

The iOS app now includes an experimental local Core ML vision path. The YOLO
segmentation weights were exported from:

```
backend/app/models/vision/best.pt
backend/app/models/vision/crosswalk.pt
```

into:

```
frontend/public/vision_coreml/best.mlpackage
frontend/public/vision_coreml/crosswalk.mlpackage
```

`npx cap sync ios` copies those model packages into the iOS bundle under:

```
frontend/ios/App/App/public/vision_coreml/
```

The local bridge lives in:

```
frontend/ios/App/CapApp-SPM/Sources/CapApp-SPM/LocalVisionPlugin.swift
frontend/ios/App/App/MainViewController.swift
frontend/src/lib/localVision.ts
```

The app's Vision Test panel has an engine selector:

- `Auto`: use iPhone Core ML on iOS and fall back to the backend if local
  inference fails
- `Local Core ML`: force offline iPhone inference only
- `Backend`: use the FastAPI backend

The local Core ML path runs the YOLO segmentation model on the iPhone, performs
NMS and mask reconstruction in Swift, then applies the same style of
traversable-space grid scoring, curb fan-zone warning, and crosswalk centering
used by the backend prototype. It does not require Render, a Mac backend, or
network access for the Vision Test camera analysis.

To regenerate the Core ML files after replacing the `.pt` weights:

```bash
/opt/anaconda3/bin/yolo export model=backend/app/models/vision/best.pt format=coreml imgsz=640 nms=False exist_ok=True
/opt/anaconda3/bin/yolo export model=backend/app/models/vision/crosswalk.pt format=coreml imgsz=640 nms=False exist_ok=True
cp -R backend/app/models/vision/best.mlpackage frontend/public/vision_coreml/
cp -R backend/app/models/vision/crosswalk.mlpackage frontend/public/vision_coreml/
cd frontend
npm run build
npx cap sync ios
```

For cross-platform work, ONNX Runtime can be evaluated later as a shared
iOS/Android inference layer. This iOS implementation uses Core ML first because
it is Apple's native offline inference path and integrates directly with Xcode.
See `MOBILE_VISION_DEPLOYMENT.md` for the meeting-aligned deployment notes,
including Core ML, ONNX Runtime, quantization, and future pedestrian signal
model integration.

### Vision Test in the app

The frontend includes a minimal development panel for periodic live camera frame
analysis. Open the app, tap **More**, then tap **Vision Test**. The panel is not
shown by default and is separate from map routing, chat, GPS navigation, and the
audio beacon.

The panel:
- asks for camera permission with `navigator.mediaDevices.getUserMedia`
- prefers the rear camera with `facingMode: environment`
- captures one JPEG frame every 1000 ms
- skips capture while a previous request is still pending
- calls `/api/vision/analyze-frame` in Open path mode
- calls `/api/vision/analyze-crosswalk` in Crosswalk mode
- uses a camera-first CurbDetector-style view with a transparent SVG overlay:
  path/traversable grid tinting, 3x7 scan grid, green selected corridor,
  LEFT/CENTER/RIGHT/STOP label, detection bounding boxes, curb warning marker,
  and parking-assist fan zones
- moves labels, API URLs, raw/adjusted grid scores, request status, response
  time, and JSON summary into a collapsed **Debug details** section
- includes an optional **Feedback Off/On** control for a frontend-only
  direction-aware audio/haptic prototype

It also includes the on-screen warning:

```text
Prototype only. Not for real navigation or safety-critical use.
```

The Vision Test feedback prototype is isolated from the route audio beacon. It
uses Web Audio API tones with simple stereo panning when available and
`navigator.vibrate` for important changes. Curb/no-path warnings repeat like
parking-assist beeps: high severity or near-zone warnings beep faster, medium
warnings beep more slowly, and left/right open-path guidance uses short panned
directional cues. It is off by default so it does not interfere with map
navigation or the existing Soundscape/audio beacon. External haptic hardware and
MQTT are not supported. Speech is intentionally disabled in Vision Test for now
so it does not interfere with the existing navigation audio beacon.

### Future Junchi/Yunchi model adapter

Keep new model files under:

```
backend/app/models/vision/
```

The current YOLO wrapper produces a dictionary of union masks keyed by semantic
label. The traversable-space analyzer is model-agnostic and expects the same
shape:

```python
{
    "sidewalk": sidewalk_mask,
    "crosswalk": crosswalk_mask,
    "road": road_mask,
    "curb_down": curb_down_mask,
    "curb_up": curb_up_mask,
}
```

Each mask can be any binary or confidence-like array that OpenCV can resize to
the input frame size. To plug in a future Junchi/Yunchi model, add a new mask
provider service beside `curb_detection.py`, convert its segmentation output to
that label-keyed mask dictionary, and reuse
`backend/app/services/vision/traversable_space.py` for scoring. The existing API
response can stay stable while the model provider changes underneath.

#### Real iPhone testing

1. Start the backend on your Mac:
   ```bash
   cd backend
   source .venv/bin/activate
   uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```
2. Confirm from the Mac:
   ```bash
   curl http://127.0.0.1:8000/api/vision/health
   ```
3. Find your Mac LAN IP, then build the iOS web bundle with that API base:
   ```bash
   cd frontend
   VITE_API_BASE_URL=http://192.168.x.x:8000 npm run build
   npx cap sync ios
   npx cap open ios
   ```
   The frontend normalizes this backend origin to the app's `/api` routes.
   Vision Test also has a **Backend URL** field that can override the build-time
   API base at runtime, store it in `localStorage`, and test `/api/vision/health`.
4. In Xcode, run on a real iPhone on the same Wi-Fi network.
5. In the app, tap **More** → **Vision Test** → **Start CV**.

#### Real iPhone testing away from the Mac Wi-Fi

If the backend should stay on your Mac but the iPhone is not on the same local
network, expose the Mac backend through a temporary HTTPS tunnel.

1. Start the backend locally:
   ```bash
   ./scripts/start_home_vision_backend.sh
   ```
2. In a second terminal, start Cloudflare Tunnel:
   ```bash
   cloudflared tunnel --url http://127.0.0.1:8000
   ```
3. Copy the generated `https://...trycloudflare.com` URL.
4. In the app, open **More** → **Vision Test**, paste the tunnel URL into
   **Backend URL**, tap **Save**, then tap **Test**. If health returns `ready`,
   **Start CV** will use the Mac backend through the tunnel.

For "Mac at home, iPhone anywhere" testing, keep the Mac awake and leave both
the backend and tunnel terminals running. Quick tunnel URLs can change after a
restart; use a named Cloudflare Tunnel or another reserved HTTPS domain when a
stable phone setting is needed.

The iOS Simulator should build and show the panel, but camera behavior may be
limited depending on the simulator/device setup.

For local development, `frontend/ios/App/App/Info.plist` allows local HTTP
requests from the Capacitor WebView so a real iPhone can call the backend on
your Mac LAN IP. Keep that App Transport Security setting as development-only
unless the backend is moved to HTTPS.

Current limitations:
- periodic frame analysis only, not high-FPS video streaming
- prototype testing only, not production safety guidance
- no WebSocket video streaming
- no Jetson/GStreamer capture
- no MQTT or external haptic hardware
- speech output from the CV panel is future work

## Docker

A `Dockerfile` is included. It builds the frontend and runs the backend in one container.

## Important note

Your website still depends on the exported data in `data/app_data/`.
Without those files, the structure loads but the map data will be empty.

## AI upgrade

This package includes an AI-ready chat resolver in `backend/app/services/navigation_ai.py`.

### What it adds

- natural language destination matching
- nearest-category queries such as `nearest restroom`
- optional OpenRouter-based clarification when fuzzy matching is ambiguous
- route generation directly from chat when a start point is already selected

### Environment variables

Set these in production if you want LLM-backed clarification:

```bash
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=openai/gpt-4.1-mini
```

Without an API key, the app still works with rule-based and fuzzy matching.

### Typical flow

1. Generate `data/app_data` from the notebook.
2. Start the backend.
3. Start the frontend.
4. Click a start point on the map.
5. Ask something like `nearest restroom` or `route to bethesda terrace`.
