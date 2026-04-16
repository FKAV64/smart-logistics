# 🧠 Smart Logistics — The Brain

The **Brain** is the Python-powered AI engine at the heart of the Smart Logistics platform. It is a real-time route optimization and delay prediction service that lives **entirely inside the backend**. It is never exposed directly to the internet — all communication passes through the Node.js API Gateway via **Redis Pub/Sub channels**.

---

## Table of Contents
1. [How It Works — System Overview](#how-it-works--system-overview)
2. [Event Types](#event-types)
3. [Decision Outcomes](#decision-outcomes)
4. [ML Feature Contract](#ml-feature-contract)
5. [Data Flow (Step by Step)](#data-flow-step-by-step)
6. [Folder Structure](#folder-structure)
7. [File Reference](#file-reference)
8. [Running Locally](#running-locally)
9. [Environment Variables](#environment-variables)

---

## How It Works — System Overview

```
┌────────────────────────────────────────────────────┐
│                  NODE.JS GATEWAY                   │
│  Receives GPS pings from truck, gets TomTom alerts │
└───────────────────────┬────────────────────────────┘
                        │  JSON Payload
                        ▼
              [Redis: traffic_alerts_channel]
                        │
                        ▼
┌────────────────────────────────────────────────────┐
│                 PYTHON BRAIN (This Service)        │
│                                                    │
│  1. Pydantic validates the incoming payload        │
│  2. MLEngine builds GPS-based adjacency matrix     │
│  3. XGBoost predicts delay for every stop pair     │
│  4. RouteOptimizer Hill-Climbs to find best order  │
│  5. Decision engine selects one of 5 actions       │
└───────────────────────┬────────────────────────────┘
                        │  JSON Response
                        ▼
          [Redis: route_optimizations_channel]
                        │
                        ▼
┌────────────────────────────────────────────────────┐
│                  NODE.JS GATEWAY                   │
│  Dispatches action to driver's mobile app          │
└────────────────────────────────────────────────────┘
```

The Brain runs as a **FastAPI** web server. On startup, it spawns a background daemon thread that permanently listens to the Redis `traffic_alerts_channel`. Every incoming message triggers the full AI pipeline and the result is published back to Node.js on the `route_optimizations_channel`.

---

## Event Types

Node.js sends one of two defined `event_type` values inside every payload:

| Event Type | Trigger | Frequency |
|---|---|---|
| `ROUTINE_HEALTH_CHECK` | Scheduled cron job | Every 15 minutes |
| `TRAFFIC_ALERT` | TomTom notifies Node.js of a live jam ahead of the truck | As they occur |

The event type is the first variable the Decision Engine reads to determine the severity and physical nature of the recommended action.

---

## Decision Outcomes

After the AI runs its full optimization pipeline, it selects exactly **one** of five possible actions to return to Node.js:

| Action | Condition | Meaning |
|---|---|---|
| `CONTINUE` | Sequence is optimal, no traffic alert | Driver is on track. No changes needed. |
| `RE-ROUTE` | A different stop order would save meaningful time | AI outputs a new stop sequence array for the driver's app. |
| `DELAY_DEPARTURE` | `event_type = TRAFFIC_ALERT` AND `courier_status = AT_STOP` | Jam is ahead. Tell the driver to hold at the current stop for 15 mins rather than merge into gridlock. |
| `REQUEST_ALTERNATE_PATH` | `event_type = TRAFFIC_ALERT` AND `courier_status = EN_ROUTE` | Stop sequence is fine. The literal road is blocked. Tell Node.js to call TomTom for an alternate physical GPS path. |
| `NOTIFY_DISPATCH_LATE` | Even the best mathematical reordering guarantees a missed SLA window | Escalate to dispatch center with the exact number of minutes the driver will be late. |

### Response Payload (sent to Node.js)
```json
{
  "route_id": "RT-001",
  "status": "OPTIMIZED",
  "ai_recommendation": {
    "action_type": "REQUEST_ALTERNATE_PATH",
    "severity": "medium",
    "reason": "Sequence remains optimal but physical path blocked. Requesting Node.js to fetch alternate TomTom vector.",
    "new_sequence": ["STP-A", "STP-C", "STP-B"],
    "impact": {
      "time_saved_minutes": 12,
      "route_health": "AT_RISK"
    }
  }
}
```

The `route_health` field describes the overall health of the optimal route found:
- `OPTIMAL` — All delivery windows are achievable.
- `AT_RISK` — Predicted delays exceed 15 minutes but windows are still reachable.
- `FAILED` — Mathematically impossible to satisfy all time windows. Triggers `NOTIFY_DISPATCH_LATE`.

---

## ML Feature Contract

The XGBoost model was trained on historical route data and requires **11 features** to produce a delay prediction for each stop-pair segment.

| Feature | Source | Type | Description |
|---|---|---|---|
| `road_type` | Node.js (per stop) | categorical | `highway`, `urban`, `rural`, `mountain` |
| `vehicle_type` | Node.js (payload root) | categorical | `van`, `truck`, `motorcycle`, `car` |
| `weather_condition` | Node.js (`environment_horizon`) | categorical | `clear`, `cloudy`, `rain`, `snow`, `fog`, `wind` |
| `traffic_level` | Node.js (`environment_horizon`) | categorical | `low`, `moderate`, `high`, `congested` |
| `time_bucket` | Node.js (`environment_horizon`) | categorical | `morning`, `midday`, `evening`, `night` |
| `temperature_c` | Node.js (`environment_horizon`) | numeric | Current temperature in Celsius |
| `road_incident` | Node.js (`environment_horizon.incident_reported`) | binary | `0` or `1` — auto-converted from boolean |
| `distance_from_prev_km` | **Computed internally** | numeric | Haversine distance between GPS coordinates |
| `planned_travel_min` | **Computed internally** | numeric | `distance / vehicle_speed_profile * 60` |
| `stop_sequence` | Node.js (per stop `current_order`) | numeric | Position of the stop in the route |
| `package_weight_kg` | Node.js (per stop) | numeric | Weight of packages at this stop |

> **Note:** `distance_from_prev_km` and `planned_travel_min` are the only two features that Node.js does **not** need to provide. They are physics-computed inside `ml_engine.py` using GPS coordinates and the vehicle-type speed profile.

### Vehicle Speed Profiles
The Brain uses these baseline speeds to compute `planned_travel_min`:
| Vehicle | Base Speed |
|---|---|
| Motorcycle | 52.2 km/h |
| Car | 40.0 km/h |
| Truck | 22.8 km/h |
| Van | 22.5 km/h |

---

## Data Flow (Step by Step)

```
1. Node.js publishes JSON → [traffic_alerts_channel]

2. redis_worker.py receives the message
   └── Validates it against TrafficAlertPayload (Pydantic schema)
   └── Acquires a 10-second de-bounce lock for this route_id

3. ml_engine.py → predict_segment_delays()
   └── Reads vehicle_type → looks up speed profile
   └── Builds adjacency matrix (all permutations of stop pairs)
   └── For each pair: computes haversine distance + planned_travel_min
   └── Broadcasts weather/traffic/time_bucket from environment_horizon
   └── Runs XGBoost pipeline → outputs predicted_delay_min per segment

4. routing.py → optimize_route()
   └── Builds O(1) lookup dict from the scored matrix
   └── Evaluates original stop sequence (time + penalties)
   └── Runs 1000-iteration Hill-Climbing swap optimization
   └── Applies hard penalties (+10,000 min) for SLA window violations
   └── Returns: best sequence, time_saved, max_delay, minutes_late, health

5. redis_worker.py → Decision Engine
   └── FAILED health?             → NOTIFY_DISPATCH_LATE
   └── Sequence changed?          → RE-ROUTE
   └── TRAFFIC_ALERT + AT_STOP?  → DELAY_DEPARTURE
   └── TRAFFIC_ALERT + EN_ROUTE? → REQUEST_ALTERNATE_PATH
   └── Otherwise?                 → CONTINUE

6. Publishes JSON response → [route_optimizations_channel]
   └── Node.js picks it up and dispatches to driver app
```

---

## Folder Structure

```
brain/
├── app/
│   ├── api/
│   │   ├── __init__.py
│   │   └── routes.py           # FastAPI health check endpoint
│   ├── models/
│   │   ├── __init__.py
│   │   └── schemas.py          # Pydantic schema — the ML payload contract
│   ├── services/
│   │   ├── ml_engine.py        # XGBoost prediction pipeline
│   │   ├── redis_worker.py     # Redis listener, validator, decision engine
│   │   └── routing.py          # Hill-climbing route optimizer
│   ├── __init__.py
│   └── main.py                 # FastAPI app entry point + background thread
│
├── notebooks/
│   ├── 01_data_exploration.ipynb   # EDA on the training dataset
│   └── 02_train_xgboost.ipynb      # Original XGBoost training notebook
│
├── scripts/
│   ├── retrain_model.py        # Standalone retraining script (mirrors notebook)
│   └── test_event.py           # End-to-end Redis integration test
│
├── trained_models/
│   ├── xgboost_delay_model.pkl # The trained XGBoost Pipeline (preprocessor + model)
│   └── model_metadata.json     # Feature manifest for the model
│
├── data/                       # Training CSVs (not committed to git)
│   ├── routes.csv
│   └── route_stops.csv
│
├── .env                        # Local environment variables (Redis host/port)
├── docker-compose.yml          # Spins up Redis 7.2 locally for development
├── requirements.txt            # All Python dependencies
└── README.md                   # This file
```

---

## File Reference

### `app/main.py`
The FastAPI application entry point. On startup it:
1. Initializes the FastAPI app.
2. Registers the `/api/health` REST route.
3. Spawns a **background daemon thread** running `start_redis_listener()`, which keeps the AI pipeline permanently alive without blocking the web server.

### `app/api/routes.py`
A minimal FastAPI router with a single `GET /api/health` endpoint. Used by Docker/AWS load balancers to confirm the service is alive and responsive.

### `app/models/schemas.py`
Pydantic data models that represent the **strict contract** between Node.js and the Python Brain. Every incoming Redis message is validated against `TrafficAlertPayload` before any ML computation begins. If a required field is missing or malformed, the payload is silently dropped and the error is logged.

**Key models:**
- `TrafficAlertPayload` — The root payload received from Node.js.
- `EnvironmentHorizon` — Real-world conditions; all fields feed directly into ML.
- `Stop` — A single delivery destination.
- `CurrentLocation` — The truck's live GPS position.

### `app/services/ml_engine.py`
The core AI physics engine. Responsibilities:
- Loads the trained XGBoost pipeline from disk on startup (`joblib`).
- Computes **Haversine distances** between all stop pairs using GPS coordinates.
- Calculates `planned_travel_min` using vehicle-specific speed profiles.
- Builds a full **pairwise adjacency DataFrame** of every possible stop-to-stop segment.
- Broadcasts environment variables (`weather_condition`, `traffic_level`, `time_bucket`, `temperature_c`, `road_incident`) across all rows.
- Runs the XGBoost pipeline to predict `delay_at_stop_min` for every possible segment.

### `app/services/routing.py`
The combinatorial route optimizer. Responsibilities:
- Converts the scored matrix into an **O(1) dictionary lookup** for fast sequence evaluation.
- Evaluates any given stop sequence by simulating arrival times, checking time windows, and accruing penalties.
- Runs a **1,000-iteration randomized Hill-Climbing algorithm** to find the optimal stop sequence.
- Returns the best sequence, time saved vs. original, maximum delay encountered, minutes late (if any), and overall route health.

### `app/services/redis_worker.py`
The central coordinator. Responsibilities:
- Maintains a persistent connection to Redis.
- Listens indefinitely on `traffic_alerts_channel`.
- **Acquires an atomic 10-second lock** (de-bouncer) per `route_id` to prevent duplicate processing if Node.js sends rapid repeat events.
- Validates payloads with Pydantic before any processing.
- Orchestrates `ml_engine → routing → decision engine`.
- Publishes the final JSON action to `route_optimizations_channel`.

### `scripts/retrain_model.py`
A standalone Python script that replicates the Jupyter training pipeline without needing a running notebook server. Run this whenever the training data changes. It overwrites:
- `trained_models/xgboost_delay_model.pkl`
- `trained_models/model_metadata.json`

### `scripts/test_event.py`
An end-to-end integration test script. It:
1. Seeds Redis with a live environment state.
2. Publishes a realistic `TRAFFIC_ALERT` payload to `traffic_alerts_channel`.
3. Listens on `route_optimizations_channel` and prints the Brain's JSON response.

Requires a running Uvicorn server and Redis instance.

### `trained_models/xgboost_delay_model.pkl`
The serialized Scikit-Learn `Pipeline` object containing:
1. A `ColumnTransformer` preprocessor (OneHotEncodes categoricals, passes numerics/binaries through).
2. An `XGBRegressor` model (150 estimators, depth 5, learning rate 0.1).

### `trained_models/model_metadata.json`
A JSON manifest documenting the expected feature order, feature types, and target variable. Used as a reference document for the Node.js team to understand what the model needs.

---

## Running Locally

### Prerequisites
- Python 3.10+
- Docker Desktop (for Redis)

### 1. Start Redis
```bash
docker-compose up -d
```

### 2. Create and activate virtual environment
```bash
python -m venv venv

# Windows (PowerShell)
.\venv\Scripts\Activate.ps1

# macOS/Linux
source venv/bin/activate
```

### 3. Install dependencies
```bash
pip install -r requirements.txt
```

### 4. Configure environment
The `.env` file is pre-configured for local development:
```
REDIS_HOST=localhost
REDIS_PORT=6379
```

### 5. Start the Brain
```bash
uvicorn app.main:app
```

You should see:
```
Initializing Gatekeeper and connecting to Redis...
Loading ML Pipeline and Routing Engine...
✅ Python Brain Worker is Ready and Armed.
🎧 Listening for events on 'traffic_alerts_channel'...
```

### 6. Run the integration test
In a second terminal (with venv activated):
```bash
python scripts/test_event.py
```

### 7. Retrain the model (when data changes)
```bash
python scripts/retrain_model.py
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_HOST` | `localhost` | Redis server hostname. Use `redis` when running inside Docker Compose. |
| `REDIS_PORT` | `6379` | Redis server port. |

---

## Redis Channels

| Channel | Direction | Description |
|---|---|---|
| `traffic_alerts_channel` | Node.js → Brain | Incoming courier events (health checks and traffic alerts) |
| `route_optimizations_channel` | Brain → Node.js | Outgoing AI recommendations |
