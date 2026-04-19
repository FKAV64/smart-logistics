# Smart Logistics — Database

PostgreSQL 15 with the PostGIS extension. The entire schema is defined in a single file (`init.sql`) that Docker mounts and executes automatically on first container start.

---

## Initialization

Docker Compose mounts `init.sql` into the container at:

```
/docker-entrypoint-initdb.d/init.sql
```

The `postgis/postgis:15-3.3` image runs every `.sql` file in that directory on first startup (when the data volume is empty). Subsequent restarts skip it, so existing data is never overwritten.

**Connection defaults (from `docker-compose.yml`):**

| Setting | Value |
|---|---|
| Host (internal) | `postgres:5432` |
| Host (external) | `localhost:5433` |
| Database | `smart_logistics` |
| User | `postgres` |
| Password | `password` |

---

## Schema Overview

The schema is organized into five domains:

```
Domain 1: Operational Entities   — couriers, clients
Domain 2: Logistics Assignment   — client_commande_detail, daily_manifest, manifest_stops
Domain 3: Spatial Data           — segments (PostGIS)
Domain 4: Telemetry & AI         — segment_telemetry, environmental_snapshots, traffic_snapshots
Domain 5: Gateway Views          — active_courier_stops
```

---

## Table Reference

### `couriers`
Courier profiles used for authentication.

| Column | Type | Notes |
|---|---|---|
| `courier_id` | `VARCHAR(50)` | PK — e.g. `DRV-884` |
| `first_name` | `VARCHAR(100)` | |
| `last_name` | `VARCHAR(100)` | |
| `email` | `VARCHAR(255)` | UNIQUE — used for login |
| `password` | `VARCHAR(255)` | bcrypt hash (rounds=10) |
| `phone` | `VARCHAR(50)` | |
| `register_date` | `DATE` | Defaults to today |
| `vehicle_type` | `VARCHAR(50)` | `Van`, `Truck`, `Motorcycle`, `Car` |

**Written by:** Manual seed in `init.sql`.  
**Read by:** Gateway `POST /login` endpoint.

---

### `clients`
Delivery recipients.

| Column | Type | Notes |
|---|---|---|
| `client_id` | `VARCHAR(50)` | PK — e.g. `CLI-001` |
| `first_name` | `VARCHAR(100)` | |
| `last_name` | `VARCHAR(100)` | |
| `email` | `VARCHAR(255)` | UNIQUE |
| `phone` | `VARCHAR(50)` | Shown in courier's delivery card |

**Written by:** Seed in `init.sql`.  
**Read by:** Gateway `GET_DAILY_MANIFEST` JOIN query.

---

### `client_commande_detail`
Package/order details for each delivery stop.

| Column | Type | Notes |
|---|---|---|
| `commande_id` | `SERIAL` | PK |
| `client_id` | `VARCHAR(50)` | FK → `clients` |
| `weight_kg` | `DECIMAL(10,2)` | Package weight — ML feature |
| `window_start` | `TIMESTAMP` | Earliest allowed delivery time |
| `window_end` | `TIMESTAMP` | Latest allowed delivery time |
| `lat` | `FLOAT` | Delivery destination latitude |
| `lon` | `FLOAT` | Delivery destination longitude |

**Written by:** Seed in `init.sql`.  
**Read by:** Gateway `GET_DAILY_MANIFEST` and `active_courier_stops` view.

---

### `daily_manifest`
One record per courier per day — the day's delivery plan.

| Column | Type | Notes |
|---|---|---|
| `manifest_id` | `VARCHAR(50)` | PK — e.g. `MANIFEST-TODAY` |
| `courier_id` | `VARCHAR(50)` | FK → `couriers` |
| `date` | `DATE` | |
| `status` | `VARCHAR(50)` | `PLANNED` → `IN_TRANSIT` → `COMPLETED` / `DELAYED` |
| `ai_recommendation` | `JSONB` | Stores approval metadata after `APPROVE_ROUTE` |

**Written by:** Seed in `init.sql`; gateway `APPROVE_ROUTE` handler updates `status` and `ai_recommendation`.  
**Read by:** Gateway `GET_DAILY_MANIFEST`, `active_courier_stops` view.

---

### `manifest_stops`
Pivot table linking a manifest to its individual delivery stops.

| Column | Type | Notes |
|---|---|---|
| `stop_id` | `SERIAL` | PK |
| `manifest_id` | `VARCHAR(50)` | FK → `daily_manifest` |
| `commande_id` | `INT` | FK → `client_commande_detail` |
| `delivery_order` | `INT` | Courier's current stop sequence (1-based) — rewritten by `APPROVE_ROUTE` |
| `delivery_status` | `VARCHAR(50)` | `PENDING` → `DELIVERED` / `FAILED` / `SKIPPED` |
| `actual_delivery_time` | `TIMESTAMP` | Set when stop is marked delivered |

**Written by:** Seed in `init.sql`; gateway `STOP_REACHED` updates `delivery_status`; gateway `APPROVE_ROUTE` rewrites `delivery_order`.  
**Read by:** Gateway `GET_DAILY_MANIFEST` (filters `delivery_status = 'PENDING'`), `active_courier_stops` view.

---

### `segments`
Drivable road segments for Sivas, Turkey — the city topology used for Brain pathfinding.

| Column | Type | Notes |
|---|---|---|
| `segment_id` | `VARCHAR(50)` | PK |
| `name` | `VARCHAR(255)` | Human-readable road name |
| `start_lat` | `FLOAT` | |
| `start_lon` | `FLOAT` | |
| `end_lat` | `FLOAT` | |
| `end_lon` | `FLOAT` | |
| `geom` | `GEOMETRY(LineString, 4326)` | PostGIS geometry for spatial queries |

**Spatial index:** `GIST` index on `geom` — enables fast KNN nearest-neighbour queries.

**Written by:** Brain `map_seeder.py` on first startup (downloads from OpenStreetMap via OSMnx and bulk-inserts). Also used by the gateway cron jobs for traffic/weather snapshots.  
**Read by:**
- Gateway `GET_DAILY_MANIFEST` — uses KNN operator `<->` to resolve nearest road name per stop:
  ```sql
  LEFT JOIN LATERAL (
    SELECT name FROM segments
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint(lon, lat), 4326)
    LIMIT 1
  ) nearest ON true
  ```
- Brain `map_engine.py` — loads all segments into a NetworkX DiGraph for Dijkstra pathfinding.
- Gateway cron jobs — iterate segments to write traffic/weather snapshots.

---

### `segment_telemetry`
Per-km speed records written by the Redis Stream worker from live GPS pings.

| Column | Type | Notes |
|---|---|---|
| `telemetry_id` | `SERIAL` | PK |
| `segment_id` | `VARCHAR(50)` | FK → `segments` |
| `courier_id` | `VARCHAR(50)` | FK → `couriers` |
| `entry_time` | `TIMESTAMP` | When courier entered this 1-km segment |
| `exit_time` | `TIMESTAMP` | When courier exited |
| `average_speed` | `FLOAT` | km/h over the segment |

**Written by:** Gateway worker (`src/worker.js`) consuming `telemetry_stream` Redis Stream.  
**Read by:** Analytics / future dashboards.

---

### `environmental_snapshots`
Hourly weather records per road segment.

| Column | Type | Notes |
|---|---|---|
| `snapshot_id` | `SERIAL` | PK |
| `segment_id` | `VARCHAR(50)` | FK → `segments` |
| `timestamp` | `TIMESTAMP` | |
| `temperature_c` | `INT` | |
| `weather_condition` | `VARCHAR(100)` | `clear`, `partly_cloudy`, `cloudy`, `rainy`, `foggy`, `snowy`, `icy` |

**Written by:** Gateway `server.js` hourly cron job (queries TomTom mock weather endpoint).  
**Read by:** Analytics / future dashboards.

---

### `traffic_snapshots`
15-minute traffic level records per road segment.

| Column | Type | Notes |
|---|---|---|
| `traffic_snapshot_id` | `SERIAL` | PK |
| `segment_id` | `VARCHAR(50)` | FK → `segments` |
| `timestamp` | `TIMESTAMP` | |
| `traffic_level` | `VARCHAR(50)` | `LIGHT`, `MODERATE`, `HEAVY`, `GRIDLOCK` |
| `incident_reported` | `BOOLEAN` | Road closure flag from TomTom mock |

**Written by:** Gateway `server.js` 15-minute cron job (queries TomTom mock traffic endpoint per segment centroid).  
**Read by:** Analytics / future dashboards.

---

## View: `active_courier_stops`

A read-only view that denormalises the three logistics tables into a flat shape consumed by the Gateway's traffic alert handler.

```sql
SELECT
    ms.stop_id::text AS stop_id,
    ccd.lat          AS latitude,
    ccd.lon          AS longitude,
    ms.delivery_order,
    ccd.window_start AS time_window_open,
    ccd.window_end   AS time_window_close,
    ccd.weight_kg    AS package_weight_kg,
    dm.manifest_id,
    dm.courier_id,
    ms.delivery_status AS status
FROM manifest_stops ms
JOIN daily_manifest         dm  ON ms.manifest_id = dm.manifest_id
JOIN client_commande_detail ccd ON ms.commande_id  = ccd.commande_id;
```

**Read by:** Gateway `GPS_PING` handler — queries `WHERE courier_id = $1 AND status = 'PENDING'` to build the `unvisited_stops` array for Brain traffic alerts.

---

## Seeded Test Data

All coordinates are in **Sivas, Turkey** (39.75°N, 37.01°E).

| Entity | ID | Details |
|---|---|---|
| Courier | `DRV-884` | John Doe · `johndoe@smartlogistics.com` · password: `password123` · Van |
| Client 1 | `CLI-001` | Ali Yilmaz · Stop at `39.750, 37.015` · window 09:00–11:00 · 5.5 kg |
| Client 2 | `CLI-002` | Ayse Demir · Stop at `39.755, 37.020` · window 11:30–13:00 · 2.0 kg |
| Client 3 | `CLI-003` | Mehmet Kaya · Stop at `39.760, 37.010` · window 14:00–16:00 · 15.0 kg |
| Manifest | `MANIFEST-TODAY` | Assigned to DRV-884 · `CURRENT_DATE` · status `PLANNED` |

---

## PostGIS Usage

| Feature | Usage |
|---|---|
| `GEOMETRY(LineString, 4326)` | Stores road segment geometries in WGS84 |
| `GIST` index on `segments.geom` | Enables fast spatial lookups |
| `<->` KNN operator | Gateway nearest-road-name lookup per delivery stop |
| `ST_SetSRID(ST_MakePoint(lon, lat), 4326)` | Converts a lat/lon pair to a PostGIS point for KNN |
| `ST_Y(ST_Centroid(geom))` / `ST_X(...)` | Extracts centroid coordinates for cron segment iteration |
