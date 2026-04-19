# Smart Logistics — Gateway

The Gateway is the central nervous system of the Smart Logistics platform. It handles all real-time communication between couriers, the AI Brain, and the frontend — via WebSocket connections, REST endpoints, Redis pub/sub channels, and PostgreSQL persistence.

---

## Folder Structure

```
gateway/
├── src/
│   ├── server.js        # Express HTTP server, JWT auth endpoint, cron jobs, WebSocket bootstrap
│   ├── wsHandler.js     # All WebSocket message routing and courier state machine
│   ├── redisClient.js   # Redis pub/sub wiring: publishes to Brain, receives AI route results
│   ├── worker.js        # Background consumer: reads telemetry_stream and writes to PostgreSQL
│   └── db.js            # PostgreSQL connection pool (shared across all modules)
├── Dockerfile           # node:18-alpine image; default CMD starts the HTTP server
├── .dockerignore
├── package.json
└── package-lock.json
```

---

## File Responsibilities

### `src/server.js` — HTTP Server + Cron Jobs

Entry point when running `npm start`.

**Responsibilities:**
- Starts an Express server with CORS and JSON body parsing on `PORT` (default `3000`)
- Exposes `GET /health` — liveness probe for Docker / load balancers
- Exposes `POST /login` — courier authentication: validates bcrypt password hash, issues a 12-hour JWT containing `courierId`, `role`, and `vehicleType`
- Bootstraps the WebSocket server (`ws` library) and delegates all WS logic to `wsHandler.js`
- Runs two cron jobs that keep the database in sync with TomTom mock environmental data:
  - **Every 15 minutes** — fetches traffic flow per road segment, writes `traffic_snapshots`, publishes to `traffic_updates` Redis channel
  - **Every hour** — fetches weather for the delivery area, writes `environmental_snapshots`, publishes to `environmental_updates` Redis channel

**Key environment variables used:**
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `JWT_SECRET` | `supersecretkey_hackathon_only` | Token signing key |
| `POSTGRES_URI` | `postgresql://postgres:password@localhost:5433/smart_logistics` | DB connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection (via redisClient) |
| `TOMTOM_MOCK_URL` | `http://localhost:7777` | TomTom mock service URL |

---

### `src/wsHandler.js` — WebSocket Message Router

The core real-time engine. Handles every inbound WebSocket message and manages all courier state.

**Connection setup:**
- Accepts connections from both the courier simulator (`?role=courier&id=DRV-xxx`) and authenticated frontend tabs (`?token=<JWT>`)
- Decodes JWT on connection to extract `courierId`, `role`, `vehicleType`
- Normalizes role to lowercase so simulator and JWT claims always match
- Maintains a per-courier in-memory state object (`courierState`) tracking last GPS point, accumulated distance, and segment timing

**Inbound message handlers:**

| `data.type` | Sender | Action |
|---|---|---|
| `GET_DAILY_MANIFEST` | Frontend | Queries pending stops from DB (with PostGIS street name lookup), sends `DAILY_MANIFEST_LOADED` back to frontend, fires `ROUTINE_HEALTH_CHECK` to Brain via Redis |
| `GPS_PING` | Courier simulator | Broadcasts `VEHICLE_TELEMETRY` to all matching frontend clients; computes 5 km-ahead heading and queries TomTom — if HEAVY/GRIDLOCK traffic is detected ahead, fires `TRAFFIC_ALERT` to Brain via Redis; logs per-km segment telemetry to `telemetry_stream` |
| `STOP_REACHED` | Courier simulator | Marks `manifest_stops.delivery_status = 'DELIVERED'` in DB, sends `DELIVERY_COMPLETED` to frontend |
| `APPROVE_ROUTE` | Frontend | Runs a DB transaction to reorder `manifest_stops.delivery_order` per AI recommendation and sets manifest `status = 'IN_TRANSIT'` |
| `REFUSE_ROUTE` | Frontend | Acknowledges with `REFUSE_ROUTE_ACK` — no DB change |

**Outbound messages pushed to frontend:**

| Message type | Trigger |
|---|---|
| `DAILY_MANIFEST_LOADED` | Response to `GET_DAILY_MANIFEST` |
| `VEHICLE_TELEMETRY` | Every `GPS_PING` from the courier |
| `DELIVERY_COMPLETED` | When `STOP_REACHED` is processed |
| `AI_ROUTE_RECOMMENDATION` | When Brain publishes to `route_optimizations_channel` |
| `ACTIVE_ROUTE_UPDATE` | When Brain's recommendation includes a `route_geojson` |
| `APPROVAL_SUCCESS` / `APPROVAL_ERROR` | Response to `APPROVE_ROUTE` |
| `REFUSE_ROUTE_ACK` | Response to `REFUSE_ROUTE` |

**Predictive traffic logic (5 km ahead):**
On each GPS ping, if a previous point exists, the handler computes a bearing using `turf.bearing`, projects 5 km forward with `turf.destination`, and queries TomTom for that ahead-point. If the result is `HEAVY` or `GRIDLOCK`, it immediately publishes a `TRAFFIC_ALERT` to the Brain — before the courier reaches the congestion zone.

**PostGIS street name lookup:**
The `GET_DAILY_MANIFEST` SQL uses a `LEFT JOIN LATERAL` with the KNN operator `<->` to find the nearest road segment name for each delivery stop. Falls back gracefully if the `segments` table is empty.

**`fetchEnvironment(lat, lon)` return fields:**

| Field | Source | Description |
|---|---|---|
| `weather_condition` | TomTom weather API | Mapped to Brain categories: `clear`, `cloudy`, `rain`, `fog`, `snow` |
| `traffic_level` | TomTom traffic API | Mapped to Brain categories: `low`, `moderate`, `high`, `congested` |
| `time_bucket` | Server clock | `morning_rush`, `midday`, `evening_rush`, `night`, `early_morning` |
| `temperature_c` | TomTom weather API | Degrees Celsius |
| `incident_reported` | TomTom `roadClosure` | Boolean |
| `road_type` | TomTom `frc` field via `FRC_ROAD_TYPES` map | `highway`, `urban`, `rural`, `mountain` |

**`buildStops(rows, roadType)` output per stop:**

| Field | Source |
|---|---|
| `stop_id`, `lat`, `lon`, `window_start`, `window_end`, `current_order`, `package_weight_kg` | Database |
| `road_type` | `fetchEnvironment().road_type` — TomTom FRC mapping, not hardcoded |

---

### `src/redisClient.js` — Redis Pub/Sub Bridge

Creates two dedicated Redis connections (required by `ioredis` when both pub and sub are needed on the same instance).

| Export | Type | Purpose |
|---|---|---|
| `pubClient` | `ioredis.Redis` | Used by `server.js` and `wsHandler.js` to publish to `traffic_alerts_channel`, `traffic_updates`, `environmental_updates`, and `telemetry_stream` |
| `aiEvents` | `EventEmitter` | Emits `optimization_received` whenever the Brain publishes a route recommendation to `route_optimizations_channel`; consumed by `wsHandler.js` to forward results to the correct frontend client |

**Channels:**

| Channel | Direction | Content |
|---|---|---|
| `traffic_alerts_channel` | Gateway → Brain | `ROUTINE_HEALTH_CHECK` and `TRAFFIC_ALERT` events with courier position, environment, and pending stops |
| `route_optimizations_channel` | Brain → Gateway | AI route recommendation with new stop sequence, severity, reason, and optional `route_geojson` |
| `traffic_updates` | Gateway → (internal) | Per-segment traffic level snapshots (from 15-min cron) |
| `environmental_updates` | Gateway → (internal) | Area-wide weather snapshots (from hourly cron) |
| `telemetry_stream` | Gateway → Worker | Redis Stream entries written per km of courier travel |

---

### `src/worker.js` — Telemetry Stream Consumer

A long-running background process started with `npm run worker`. Separate from the HTTP server so stream processing never blocks request handling.

**What it does:**
1. Creates a Redis consumer group `db_writers` on the `telemetry_stream` stream (idempotent — handles `BUSYGROUP` gracefully)
2. Blocks for up to 5 seconds waiting for new stream entries; processes up to 10 at a time
3. Parses each entry and inserts a row into `segment_telemetry` with `segment_id`, `courier_id`, `entry_time`, `exit_time`, `average_speed`
4. ACKs messages on successful insert (unACKed messages remain in the pending list for retry)
5. On DB error, skips ACK and retries on next poll cycle

The worker runs as its own Docker container in `docker-compose.yml` using the same image as the gateway but with `command: npm run worker`.

---

### `src/db.js` — PostgreSQL Connection Pool

Exports a single `query(text, params)` function backed by a `pg.Pool` with:
- Max 20 connections
- 30-second idle timeout
- 2-second connection timeout
- Exits the process on unexpected idle-client errors (prevents silent connection leaks in production)

Connection string is read from `POSTGRES_URI` environment variable.

---

## REST API

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Returns `{ status: 'OK', role: 'Gateway' }` |
| `POST` | `/login` | None | Body: `{ email, password }` → returns `{ success, token, role, user }` |

---

## Running Locally

```bash
# Start the HTTP server
npm start

# Start the telemetry stream worker (separate terminal)
npm run worker

# Development with auto-reload
npm run dev
npm run worker:dev
```

**Required services:** PostgreSQL on `5433`, Redis on `6379`, TomTom mock on `7777`.

---

## Docker

The single `Dockerfile` builds both the gateway and worker images (they share the same codebase). `docker-compose.yml` overrides the `CMD` for the worker service:

```yaml
gateway:
  command: npm start      # default

worker:
  command: npm run worker # override
```

Build and run everything together:

```bash
docker compose up --build
```
