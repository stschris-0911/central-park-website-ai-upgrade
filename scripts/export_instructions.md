Copy your notebook export outputs into `data/app_data/`.

Recommended export targets:
- final_candidate_nodes_gridcoded.geojson
- final_candidate_nodes_gridcoded.csv
- infrastructure_nodes_gridcoded.geojson
- infrastructure_nodes_gridcoded.csv
- gate_nodes_gridcoded.geojson
- gate_nodes_gridcoded.csv
- augmented_graph_edges.geojson
- park_graph.pkl
- app_manifest.json

If your graph pickle is not already in EPSG:4326, this backend will try to transform graph geometry to WGS84 automatically when possible.
