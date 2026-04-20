# Smart Logistics

A real-time AI-powered delivery management platform. Couriers receive live route optimizations on their dashboard as a Python AI engine continuously monitors traffic, scores road segments with XGBoost, and re-sequences deliveries using combinatorial optimization — all while the courier is driving.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Services](#services)
4. [Data Flow](#data-flow)
5. [Quick Start](#quick-start)
6. [Service Endpoints](#service-endpoints)
7. [Login Credentials](#login-credentials)
8. [Testing the AI Pipeline](#testing-the-ai-pipeline)
9. [Redis Channels](#redis-channels)
10. [Project Structure](#project-structure)

---

## System Overview

Smart Logistics connects three real-time systems:

- A **courier simulator** that drives through a city broadcasting GPS pings every 3 seconds
- A **Node.js gateway** that detects traffic 5 km ahead and forwards events to the AI brain
- A **Python AI brain** that scores every road segment with XGBoost, runs a TSP optimizer, and publishes route recommendations back to the courier's dashboard

The frontend renders the live vehicle position, pending deliveries with time windows, and interactive AI recommendation cards that the courier can approve or refuse in one tap.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         SMART LOGISTICS STACK                            │
└──────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────┐       ┌──────────────────────┐
  │  COURIER SIMULATOR   │       │  TOMTOM MOCK API     │
  │  (Node.js)           │       │  (Node.js / Express) │
  │  GPS_PING every 3s   │       │  Traffic + Weather   │
  └──────────┬───────────┘       └──────────┬───────────┘
             │ WebSocket                     │ HTTP (cron)
             ▼                               ▼
  ┌──────────────────────────────────────────────────────┐
  │                   GATEWAY  (Node.js)                 │
  │                                                      │
  │  • WebSocket server — couriers + frontend            │
  │  • POST /login — JWT auth                            │
  │  • 5 km look-ahead traffic detection (Turf.js)       │
  │  • Cron: 15-min traffic sync, hourly weather sync    │
  │  • PostgreSQL: query manifests, write telemetry      │
  └───────┬──────────────────────────┬───────────────────┘
          │ Redis Pub                │ PostgreSQL
          │ traffic_alerts_channel   │ (read/write)
          ▼                          ▼
  ┌────────────────────────┐  ┌─────────────────────────┐
  │   BRAIN  (Python)      │  │  DATABASE               │
  │                        │  │  PostgreSQL 15 + PostGIS│
  │  1. Pydantic validate  │  │                         │
  │  2. XGBoost edge score │  │  couriers               │
  │  3. XGBoost stop probs │  │  daily_manifest         │
  │  4. TSP hill-climbing  │  │  manifest_stops         │
  │  5. Decision engine    │  │  segments (road network)│
  │  6. GeoJSON builder    │  │  segment_telemetry      │
  └───────┬────────────────┘  │  traffic_snapshots      │
          │ Redis Pub          │  environmental_snapshots│
          │ route_optimizations│                         │
          ▼                   └─────────────────────────┘
  ┌──────────────────────────────────────────────────────┐
  │                  FRONTEND  (React 19)                │
  │                                                      │
  │  • Leaflet map — live vehicle + route polylines      │
  │  • Delivery sidebar — time windows, urgency badges   │
  │  • ActionCard — Approve / Refuse AI recommendations  │
  │  • Zustand store — all shared state                  │
  └──────────────────────────────────────────────────────┘
```

---

## Services

| Service | Language / Framework | Purpose | External Port |
|---|---|---|---|
| **gateway** | Node.js 18 / Express + ws | WebSocket hub, REST auth, cron syncs, DB persistence | `3000` |
| **brain** | Python 3.10 / FastAPI + XGBoost | AI route optimization engine | `8001` |
| **frontend** | React 19 / Vite + Leaflet | Courier dashboard | `8000` |
| **postgres** | PostgreSQL 15 + PostGIS 3.3 | Persistent storage + spatial queries | `5433` |
| **redis** | Redis (alpine) | Pub/Sub message broker | `6379` |
| **tomtom-mock** | Node.js / Express | Mock TomTom traffic + weather API | `7777` |
| **worker** | Node.js (gateway image) | Background Redis Stream → DB telemetry writer | — |
| **courier-simulator** | Node.js | Simulated delivery driver GPS broadcasts | — |

---

## Data Flow

### Routine health check (on courier login)

```
Frontend  ──GET_DAILY_MANIFEST──▶  Gateway  ──ROUTINE_HEALTH_CHECK──▶  Redis
                                                                           │
Brain ◀────────────────────────────────────────────────────────────────────┘
Brain runs AI pipeline → publishes recommendation
Gateway ──AI_ROUTE_RECOMMENDATION──▶  Frontend WebSocket
```

### Live traffic alert (while driving)

```
Courier GPS_PING ──▶ Gateway
  │
  ├─ Broadcasts VEHICLE_TELEMETRY ──▶ Frontend
  │
  └─ Detects HEAVY/GRIDLOCK 5 km ahead (TomTom mock)
       │
       └─ Publishes TRAFFIC_ALERT ──▶ Redis ──▶ Brain
                                                  │
            Brain re-scores graph + re-optimizes  │
                                                  │
       Frontend ◀── AI_ROUTE_RECOMMENDATION ◀─────┘
       Frontend ◀── ACTIVE_ROUTE_UPDATE (GeoJSON polyline)
```

### AI Decision Engine

| Condition | Action | Severity |
|---|---|---|
| Route health FAILED — SLA windows impossible to meet | `NOTIFY_DISPATCH_LATE` | CRITICAL |
| A different stop order saves meaningful time | `RE-ROUTE` | high |
| Traffic alert received, courier is `AT_STOP` | `DELAY_DEPARTURE` | medium |
| Traffic alert received, courier is `EN_ROUTE` | `REQUEST_ALTERNATE_PATH` | medium |
| All stops on schedule, no intervention needed | `CONTINUE` | low |

---

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running

### Start all services

```bash
git clone <repo-url>
cd smart-logistics
docker compose up --build
```

On **first startup** the Brain downloads and seeds the full Sivas, Turkey road network from OpenStreetMap (~2–3 minutes). Subsequent restarts are instant.

### Verify everything is running

```bash
docker compose ps
```

All 8 containers should show `running` (or `exited 0` for `courier-simulator` if it finishes its route loop).

### Stop

```bash
docker compose down
```

To also wipe the database volume:

```bash
docker compose down -v
```

---

## Service Endpoints

| Service | URL | Description |
|---|---|---|
| Frontend Dashboard | http://localhost:8000 | Courier UI |
| Gateway HTTP | http://localhost:3000 | REST API |
| Gateway WebSocket | ws://localhost:3000 | Real-time channel |
| Brain REST | http://localhost:8001/api/optimize | Direct AI endpoint (Postman/testing) |
| Brain Health | http://localhost:8001/api/health | Liveness probe |
| TomTom Mock | http://localhost:7777 | Mock traffic/weather API |
| PostgreSQL | localhost:5433 | DB (user: `postgres`, pass: `password`, db: `smart_logistics`) |
| Redis | localhost:6379 | Pub/Sub broker |

---

## Login Credentials

Seeded by `database/init.sql` — ready to use immediately after `docker compose up`.

| Field | Value |
|---|---|
| Email | `johndoe@smartlogistics.com` |
| Password | `password123` |
| Courier ID | `DRV-884` |
| Vehicle | Van |

---

## Testing the AI Pipeline

### Automated end-to-end test

`brain/scripts/test_event.py` fires mock payloads directly to Redis and prints the Brain's responses to the terminal. It covers all four action types in sequence.

**Requirements:** Docker stack running (`docker compose up -d`), Python 3.x, and the `redis` package:

```bash
pip install redis
python brain/scripts/test_event.py
```

**What each scenario triggers:**

| # | Scenario | Expected action |
|---|---|---|
| 1 | `ROUTINE_HEALTH_CHECK`, clear weather, low traffic, single stop with wide window | `CONTINUE` |
| 2 | Two stops where stop 2 is geographically closer but listed second — TSP reorders them | `RE-ROUTE` |
| 3 | `TRAFFIC_ALERT` + `courier_status: EN_ROUTE`, single stop (cannot be reordered) | `REQUEST_ALTERNATE_PATH` |
| 4 | `TRAFFIC_ALERT` + `courier_status: AT_STOP`, single stop | `DELAY_DEPARTURE` |

### Manual REST test (Postman / curl)

```bash
curl -X POST http://localhost:8001/api/optimize \
  -H "Content-Type: application/json" \
  -d @brain/scripts/sample_payload.json
```

See [brain/app/models/schemas.py](brain/app/models/schemas.py) for the full request schema.

---

## Redis Channels

| Channel | Direction | Content |
|---|---|---|
| `traffic_alerts_channel` | Gateway → Brain | `ROUTINE_HEALTH_CHECK` and `TRAFFIC_ALERT` events with courier position, environment, and pending stops |
| `route_optimizations_channel` | Brain → Gateway | AI recommendation: action type, severity, reason, new stop sequence, GeoJSON route |
| `traffic_updates` | Gateway cron → internal | Per-segment traffic level snapshots (every 15 min) |
| `environmental_updates` | Gateway cron → internal | Area-wide weather snapshots (every hour) |
| `telemetry_stream` | Gateway → Worker | Redis Stream entries written per km of courier travel |

---

## Project Structure

```
smart-logistics/
├── brain/                  # Python AI engine (FastAPI + XGBoost + NetworkX)
│   ├── app/
│   │   ├── api/            # REST endpoints
│   │   ├── models/         # Pydantic schemas
│   │   └── services/       # ML engine, routing optimizer, Redis worker, map engine
│   ├── scripts/
│   │   └── test_event.py   # End-to-end test — fires all 4 action types
│   ├── trained_models/     # XGBoost regressor + classifier (pre-trained)
│   ├── notebooks/          # EDA + training notebooks
│   ├── data/               # Synthetic training CSVs (Sivas historical deliveries)
│   └── README.md
│
├── gateway/                # Node.js hub (Express + WebSocket + Redis + PostgreSQL)
│   ├── src/
│   │   ├── server.js       # HTTP server, auth, cron jobs
│   │   ├── wsHandler.js    # WebSocket message router, courier state machine
│   │   ├── redisClient.js  # Pub/Sub bridge
│   │   ├── worker.js       # Telemetry stream consumer
│   │   └── db.js           # PostgreSQL connection pool
│   └── README.md
│
├── frontend/               # React 19 courier dashboard (Vite + Leaflet + Zustand)
│   ├── src/
│   │   ├── pages/          # LoginPage, CourierDashboard
│   │   ├── components/     # MapLayer, ActionCard, DeliveryList, DeliveryItem, ProfileHeader
│   │   ├── hooks/          # useTelemetry (WebSocket lifecycle)
│   │   └── store/          # useCourierStore (Zustand)
│   └── README.md
│
├── database/               # PostgreSQL schema + seed data
│   ├── init.sql            # Full schema + PostGIS setup + Sivas test data
│   └── README.md
│
├── simulator/              # Development mock services
│   ├── courier.js          # GPS courier simulator (WebSocket client)
│   └── tomtom-mock.js      # TomTom traffic + weather mock API (Express)
│
└── docker-compose.yml      # Orchestrates all 8 services
```

---

## Individual Service Documentation

| Service | README |
|---|---|
| Brain (AI engine) | [brain/README.md](brain/README.md) |
| Gateway | [gateway/README.md](gateway/README.md) |
| Frontend | [frontend/README.md](frontend/README.md) |
| Database | [database/README.md](database/README.md) |
