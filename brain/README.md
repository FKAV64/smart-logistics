# Smart Logistics — The Brain

The **Brain** is the Python-powered AI engine at the heart of the Smart Logistics platform. It is a real-time route optimization and delay prediction service that operates entirely within the backend — never exposed directly to clients. All communication passes through the Node.js API Gateway via **Redis Pub/Sub channels**.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [AI Pipeline (Step by Step)](#ai-pipeline-step-by-step)
3. [Event Types](#event-types)
4. [Decision Outcomes](#decision-outcomes)
5. [ML Models](#ml-models)
6. [Design Assumptions](#design-assumptions)
7. [City Road Network](#city-road-network)
8. [Folder Structure](#folder-structure)
9. [File Reference](#file-reference)
10. [Environment Variables](#environment-variables)
11. [Redis Channels](#redis-channels)
12. [Running Locally](#running-locally)

---

## System Architecture

```
┌───────────────────────────────────────────────────────┐
│                   NODE.JS GATEWAY                     │
│  Receives GPS pings from couriers, runs health checks │
└──────────────────────────┬────────────────────────────┘
                           │ JSON Payload
                           ▼
             [Redis: traffic_alerts_channel]
                           │
                           ▼
┌───────────────────────────────────────────────────────┐
│              PYTHON BRAIN  (This Service)             │
│                                                       │
│  1. Pydantic validates the incoming payload           │
│  2. MapEngine provides the city road graph            │
│  3. MLEngine scores every street edge (XGBoost)       │
│  4. MLEngine predicts per-stop delay probabilities    │
│  5. RouteOptimizer runs TSP hill-climbing (Dijkstra)  │
│  6. Decision engine selects one of 5 actions          │
└──────────────────────────┬────────────────────────────┘
                           │ JSON Response
                           ▼
         [Redis: route_optimizations_channel]
                           │
                           ▼
┌───────────────────────────────────────────────────────┐
│                   NODE.JS GATEWAY                     │
│  Forwards GeoJSON route + recommendation to courier   │
└───────────────────────────────────────────────────────┘
```

The Brain runs as a **FastAPI** web server. On startup it:

1. Seeds the PostGIS `segments` table with the full Sivas city road network (OSMnx) if empty.
2. Loads the road graph into an in-memory NetworkX `DiGraph`.
3. Loads both XGBoost models from disk.
4. Spawns a **background daemon thread** that permanently listens on `traffic_alerts_channel`.

Every incoming Redis message triggers the full AI pipeline and publishes a response to `route_optimizations_channel`.

---

## AI Pipeline (Step by Step)

```
1. Node.js publishes JSON → [traffic_alerts_channel]

2. redis_worker.py receives the message
   ├── Validates against TrafficAlertPayload (Pydantic)
   └── Acquires a 10-second atomic de-bounce lock per manifest_id
       (prevents duplicate processing on rapid-fire events)

3. ml_engine.py → predict_stop_probabilities(stops, payload, map_graph)
   ├── For each consecutive stop pair, computes ROAD NETWORK distance
   │   by snapping coordinates to the nearest graph node and running
   │   Dijkstra on physical edge distances (distance_km weights)
   ├── Falls back to haversine only if the graph is empty or disconnected
   ├── Derives planned_travel_min from road distance ÷ vehicle speed profile
   └── XGBoost binary classifier → {stop_id: delay_probability (0–1)}

4. ml_engine.py → predict_segment_delays(payload, map_graph)
   ├── Iterates over every street edge in the NetworkX graph
   ├── Computes base travel time from physical edge distance_km
   └── XGBoost regressor → predicted_delay_min per edge
       (edge 'weight' = planned_travel_min + predicted_delay_min)

5. routing.py → optimize_route(stops, scored_graph, current_time_iso)
   ├── Snaps each stop to its nearest road network node
   ├── Evaluates original sequence via Dijkstra (AI-weighted edges)
   ├── Runs 50-iteration randomized Hill-Climbing (swap two stops)
   ├── Hard penalty +10,000 min for missed time windows
   ├── Soft wait if courier arrives before window_start
   ├── 13-minute service time added at each stop
   └── Returns: best sequence, time_saved, max_delay, minutes_late,
               route_health, route_geojson (MultiLineString GeoJSON Feature)

6. redis_worker.py → Decision Engine
   ├── health == "FAILED"          → NOTIFY_DISPATCH_LATE  (CRITICAL)
   ├── is_reordered                → RE-ROUTE              (high)
   ├── TRAFFIC_ALERT + AT_STOP     → DELAY_DEPARTURE        (medium)
   ├── TRAFFIC_ALERT + EN_ROUTE    → REQUEST_ALTERNATE_PATH (medium)
   └── Otherwise                   → CONTINUE               (low)

7. Publishes JSON response → [route_optimizations_channel]
   └── Gateway forwards AI_ROUTE_RECOMMENDATION + ACTIVE_ROUTE_UPDATE
       (GeoJSON polyline) to the courier's WebSocket
```

---

## Event Types

| Event Type | Trigger |
|---|---|
| `ROUTINE_HEALTH_CHECK` | Fired by the gateway immediately when a courier connects and requests their daily manifest |
| `TRAFFIC_ALERT` | Fired when a courier's GPS speed drops below 10 km/h (gateway detects gridlock) |

---

## Decision Outcomes

| Action | Condition | Severity |
|---|---|---|
| `CONTINUE` | Sequence is mathematically optimal, no delays | `low` |
| `RE-ROUTE` | A different stop order saves meaningful time | `high` |
| `DELAY_DEPARTURE` | Traffic alert, courier is currently `AT_STOP` | `medium` |
| `REQUEST_ALTERNATE_PATH` | Traffic alert, courier is `EN_ROUTE` | `medium` |
| `NOTIFY_DISPATCH_LATE` | Mathematically impossible to meet all SLA windows | `CRITICAL` |

### Response Payload (published to Node.js)

```json
{
  "manifest_id": "MANIFEST-TODAY",
  "courier_id": "DRV-884",
  "status": "OPTIMIZED",
  "ai_recommendation": {
    "action_type": "RE-ROUTE",
    "severity": "high",
    "reason": "Re-ordering stops saves 14 minutes and protects time windows. High delay risk: Stop #2 (73%), Stop #3 (61%).",
    "new_sequence": ["3", "1", "2"],
    "stop_delay_probabilities": { "1": 0.312, "2": 0.731, "3": 0.614 },
    "impact": {
      "time_saved_minutes": 14,
      "route_health": "AT_RISK"
    },
    "route_geojson": {
      "type": "Feature",
      "geometry": { "type": "MultiLineString", "coordinates": [ [...] ] },
      "properties": { "stroke": "#3b82f6", "stroke-width": 4 }
    }
  }
}
```

`route_health` values:
- `OPTIMAL` — All delivery windows are achievable.
- `AT_RISK` — Predicted delay exceeds 15 minutes but windows are still reachable.
- `FAILED` — Mathematically impossible to meet all time windows.

---

## ML Models

Two separate XGBoost models are trained and served. Both share the same 11-feature input contract.

### Feature Contract

| Feature | Source | Type | Description |
|---|---|---|---|
| `road_type` | Per-stop payload | categorical | `highway`, `urban`, `rural`, `mountain` |
| `vehicle_type` | Payload root | categorical | `van`, `truck`, `motorcycle`, `car` |
| `weather_condition` | `environment_horizon` | categorical | `clear`, `cloudy`, `rain`, `snow`, `fog`, `wind` |
| `traffic_level` | `environment_horizon` | categorical | `low`, `moderate`, `high`, `congested` |
| `time_bucket` | `environment_horizon` | categorical | `early_morning`, `morning_rush`, `midday`, `evening_rush`, `night` |
| `temperature_c` | `environment_horizon` | numeric | Current temperature in Celsius |
| `road_incident` | `environment_horizon.incident_reported` | binary | `0` or `1` — auto-converted from boolean |
| `distance_from_prev_km` | **Computed internally** | numeric | Actual road network distance (Dijkstra on OSMnx graph) |
| `planned_travel_min` | **Computed internally** | numeric | `road_distance_km ÷ vehicle_speed_kmh × 60` |
| `stop_sequence` | Per-stop `current_order` | numeric | Position of this stop in the route |
| `package_weight_kg` | Per-stop payload | numeric | Weight of packages at this stop |

`distance_from_prev_km` and `planned_travel_min` are the only two features not provided by the gateway — they are computed inside `ml_engine.py` using road network distances and vehicle speed profiles.

### Model 1 — XGBoost Regressor (`xgboost_delay_model.pkl`)

Predicts `delay_at_stop_min` (continuous, in minutes) for each street edge. Used to assign AI-weighted costs to every road segment before Dijkstra runs.

**Architecture:** Scikit-Learn `Pipeline` → `ColumnTransformer` (OneHotEncoder for categoricals, passthrough for numerics/binary) → `XGBRegressor`

**Hyperparameters:** `n_estimators=150`, `max_depth=5`, `learning_rate=0.1`

**Training data:** 1,451 segments from `route_stops.csv` (Sivas historical delivery data, 80/20 train-test split)

| Metric | Value |
|---|---|
| MAE | **3.49 minutes** |
| RMSE | **6.85 minutes** |
| R² | **0.962** |

### Model 2 — XGBoost Binary Classifier (`xgboost_prob_model.pkl`)

Predicts the **probability that a stop will experience a delay greater than 10 minutes**. Output is a `{stop_id: float(0–1)}` dictionary used to annotate the AI recommendation reason shown to the courier.

**Threshold:** 10 minutes (derived from dataset distribution)

| Metric | Value |
|---|---|
| AUC-ROC | **0.998** |

---

## Design Assumptions

The following constants were derived by averaging values from the training dataset (`route_stops.csv`, `routes.csv`). They are fixed at runtime and do not adapt dynamically.

### Vehicle Speed Profiles

Used to compute `planned_travel_min` from road distance. Averages from Sivas historical delivery telemetry.

| Vehicle Type | Base Speed |
|---|---|
| Motorcycle | 52.2 km/h |
| Car | 40.0 km/h |
| Truck | 22.8 km/h |
| Van | 22.5 km/h |

### Service Time Per Stop

```
planned_service_min = 13 minutes
```

Fixed 13-minute dwell time is added at every stop after arrival. This is the average time-at-stop observed across all deliveries in `route_stops.csv`, covering package handoff, signature, and door-to-door walking time.

### Time Window Penalty

Arriving after `window_end` incurs a **+10,000-minute** cost penalty in the TSP optimizer — effectively making it mathematically preferable to take any route that avoids the violation.

### Road Type Derivation

For **segment scoring** (street edges), `road_type` is inferred from physical edge length:
- `urban` if `distance_km < 1.0`
- `highway` otherwise

For **stop probability scoring**, `road_type` is taken directly from the stop's `road_type` field (passed in from the gateway payload), defaulting to `urban`.

---

## City Road Network

The Brain downloads and persists the full drivable road network for **Sivas, Turkey** from OpenStreetMap using OSMnx on first startup. The network is stored in PostGIS and loaded into a NetworkX `DiGraph` at runtime.

- **Scope:** Full Sivas city administrative boundary (`graph_from_place("Sivas, Turkey")`) — covers all urban districts and peripheral roads, matching the geographic coverage of the training dataset.
- **Node representation:** GPS tuples `(lon, lat)` rounded to 5 decimal places for intersection snapping.
- **Edge attributes:** `segment_id`, `name`, `distance_km`, `geom_wkt` (WKT LineString for GeoJSON export).
- **Seeding:** Runs once on Brain startup. Subsequent restarts skip seeding if the `segments` table is non-empty.

Inter-stop distances are computed by snapping delivery coordinates to the nearest graph node and running Dijkstra weighted by physical `distance_km`. This replaces straight-line haversine and produces accurate road distances that match the training geography.

---

## Folder Structure

```
brain/
├── app/
│   ├── api/
│   │   ├── __init__.py
│   │   └── routes.py           # FastAPI routes: GET /api/health, POST /api/optimize
│   ├── models/
│   │   ├── __init__.py
│   │   └── schemas.py          # Pydantic contracts: TrafficAlertPayload, Stop, etc.
│   ├── services/
│   │   ├── map_engine.py       # Loads PostGIS segments → NetworkX DiGraph
│   │   ├── map_seeder.py       # Downloads Sivas OSMnx network → seeds PostGIS
│   │   ├── ml_engine.py        # XGBoost inference: segment scoring + stop probabilities
│   │   ├── redis_worker.py     # Redis listener, payload validator, decision engine
│   │   └── routing.py          # Hill-climbing TSP optimizer + GeoJSON builder
│   ├── __init__.py
│   └── main.py                 # FastAPI app entry point + background thread
│
├── notebooks/
│   ├── 01_data_exploration.ipynb   # EDA on the training dataset
│   └── 02_train_xgboost.ipynb      # XGBoost training pipeline (regressor + classifier)
│
├── trained_models/
│   ├── xgboost_delay_model.pkl     # XGBoost regressor (delay minutes per segment)
│   ├── xgboost_prob_model.pkl      # XGBoost classifier (P(delay > 10 min) per stop)
│   └── model_metadata.json         # Feature manifest, types, and evaluation metrics
│
├── data/                       # Training CSVs 
│
├── Dockerfile
├── requirements.txt
└── README.md
```

---

## File Reference

### `app/main.py`
FastAPI application entry point. On startup: seeds the map if empty, loads all engines into `app.state`, and spawns the background Redis listener daemon thread.

### `app/api/routes.py`
Two endpoints:
- `GET /api/health` — liveness probe for Docker/load balancers.
- `POST /api/optimize` — direct REST endpoint for Postman testing and integration demos. Accepts a full `TrafficAlertPayload` and runs the complete AI pipeline synchronously.

### `app/models/schemas.py`
Pydantic v1 data models forming the strict contract between the Node.js gateway and the Brain. Every Redis message is validated before any ML computation begins. Invalid payloads are dropped and logged.

Models: `TrafficAlertPayload`, `EnvironmentHorizon`, `Stop`, `CurrentLocation`.

### `app/services/map_seeder.py`
Runs once on Brain startup. Downloads the full Sivas, Turkey drivable road network from OpenStreetMap via OSMnx and bulk-inserts road segments into the PostGIS `segments` table. Skips if the table is already populated.

### `app/services/map_engine.py`
Reads the `segments` table from PostGIS and builds an in-memory NetworkX `DiGraph`. Each edge carries `distance_km`, `geom_wkt`, `segment_id`, and `name`. Exposes `get_graph()` and `get_nearest_node(lon, lat)` for use by the ML and routing engines.

### `app/services/ml_engine.py`
Core AI inference engine. Responsibilities:
- `predict_segment_delays(payload, map_graph)` — scores every road edge with XGBoost delay weights. Returns a weighted graph ready for Dijkstra.
- `predict_stop_probabilities(stops, payload, map_graph)` — computes road-network distance between consecutive stops via Dijkstra (falls back to haversine if graph is empty), then runs the binary classifier to output delay probabilities per stop.
- `_road_distance_km(graph, lat1, lon1, lat2, lon2)` — snaps GPS coordinates to nearest graph nodes and sums Dijkstra path edge distances.

### `app/services/routing.py`
Combinatorial route optimizer. Responsibilities:
- `_evaluate_sequence(sequence, scored_graph, start_time)` — simulates courier arrival times along a given stop order using Dijkstra on the AI-weighted graph. Tracks time window violations, wait times, and accumulated service times.
- `optimize_route(stops, scored_graph, current_time_iso)` — runs 50-iteration randomized Hill-Climbing (random swap of two stops, keep if cost improves). Returns the best sequence, time saved vs. original, health status, and a `route_geojson` MultiLineString built from the WKT road geometries.
- `_build_geojson(wkt_segments)` — converts raw WKT LineStrings from the Dijkstra path into a GeoJSON Feature for the frontend map layer.

### `app/services/redis_worker.py`
Central coordinator. Maintains a persistent Redis subscription on `traffic_alerts_channel`. For each valid message:
1. Acquires an atomic 10-second lock per `manifest_id` (prevents duplicate processing).
2. Validates the payload with Pydantic.
3. Runs `ml_engine → routing → decision engine` in sequence.
4. Publishes the result JSON to `route_optimizations_channel`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_HOST` | `redis` | Redis hostname (`localhost` for local dev) |
| `REDIS_PORT` | `6379` | Redis port |
| `DB_HOST` | `postgres` | PostgreSQL hostname |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | PostgreSQL user |
| `DB_PASS` | `password` | PostgreSQL password |
| `DB_NAME` | `smart_logistics` | PostgreSQL database name |

---

## Redis Channels

| Channel | Direction | Description |
|---|---|---|
| `traffic_alerts_channel` | Gateway → Brain | Incoming courier events (health checks and traffic alerts) |
| `route_optimizations_channel` | Brain → Gateway | Outgoing AI recommendations with GeoJSON route |

---

## Running Locally

### Prerequisites
- Python 3.10+
- Docker Desktop (for PostgreSQL + PostGIS + Redis)

### 1. Start infrastructure
```bash
docker compose up postgres redis -d
```

### 2. Create and activate virtual environment
```bash
python -m venv venv

# Windows
.\venv\Scripts\Activate.ps1

# macOS / Linux
source venv/bin/activate
```

### 3. Install dependencies
```bash
pip install -r requirements.txt
```

### 4. Configure environment
```bash
# .env (pre-configured for local dev)
REDIS_HOST=localhost
REDIS_PORT=6379
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASS=password
DB_NAME=smart_logistics
```

### 5. Start the Brain
```bash
uvicorn app.main:app --reload
```

On first run you will see the OSMnx map download and seeding:
```
The Brain is powering up...
🗺️ Seeding Sivas road network from OpenStreetMap...
💾 Saving routes into PostgreSQL (PostGIS)...
✅ Successfully seeded N physical street segments.
✅ MapEngine: NetworkX graph built with N road segments.
Background Redis listener thread initialized.
```

### 6. Test the REST endpoint (Postman / curl)
```
POST http://localhost:8000/api/optimize
Content-Type: application/json
```
See `app/models/schemas.py` for the full request body schema.
