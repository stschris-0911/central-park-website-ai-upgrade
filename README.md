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

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open:
- frontend: `http://localhost:5173`
- backend health: `http://127.0.0.1:8000/api/health`

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
