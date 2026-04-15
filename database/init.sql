-- Enable PostGIS extension for spatial mapping
CREATE EXTENSION IF NOT EXISTS postgis;

-- ==========================================
-- DOMAIN 1: OPERATIONAL DATA (Core Logic)
-- ==========================================

CREATE TABLE couriers (
    courier_id VARCHAR(50) PRIMARY KEY, -- ex. "DRV-884"
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL, -- E.164
    vehicle_type VARCHAR(50) NOT NULL, -- Box Truck, Bicycle, etc.
    hire_date DATE NOT NULL
);

CREATE TABLE routes (
    route_id SERIAL PRIMARY KEY,
    courier_id VARCHAR(50) NOT NULL REFERENCES couriers(courier_id) ON DELETE CASCADE,
    date DATE NOT NULL,
    shift_start TIMESTAMP NOT NULL, -- Contracted boundaries
    shift_end TIMESTAMP NOT NULL,
    status VARCHAR(50) DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_TRANSIT', 'AT_RISK', 'REORDER_SUGGESTED', 'COMPLETED')),
    ai_recommendation JSONB DEFAULT NULL -- flexible JSON payload explaining delay
);

CREATE TABLE stops (
    stop_id SERIAL PRIMARY KEY,
    route_id INT NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
    client_customer_id VARCHAR(255) NOT NULL, -- Blind pass-through string
    lat NUMERIC(10, 7) NOT NULL,
    lon NUMERIC(10, 7) NOT NULL,
    window_start TIMESTAMP NOT NULL, -- SLA start
    window_end TIMESTAMP NOT NULL, -- SLA end
    stop_order INT NOT NULL -- Current sequence
);

CREATE TABLE segments (
    segment_id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    start_lat NUMERIC(10, 7) NOT NULL,
    start_lon NUMERIC(10, 7) NOT NULL,
    end_lat NUMERIC(10, 7) NOT NULL,
    end_lon NUMERIC(10, 7) NOT NULL,
    geom geometry(LINESTRING, 4326) NOT NULL -- PostGIS Spatial Rule (WGS 84)
);

-- Spatial index for quick GIS queries
CREATE INDEX idx_segments_geom ON segments USING GIST (geom);


-- ==========================================
-- DOMAIN 2: TELEMETRY DATA (Real-Time Fleet)
-- ==========================================

CREATE TABLE segment_telemetry (
    telemetry_id SERIAL PRIMARY KEY,
    segment_id INT NOT NULL REFERENCES segments(segment_id) ON DELETE RESTRICT,
    courier_id VARCHAR(50) NOT NULL REFERENCES couriers(courier_id) ON DELETE CASCADE,
    entry_time TIMESTAMP NOT NULL,
    exit_time TIMESTAMP NOT NULL, -- Only inserted after completing the 1km segment
    average_speed NUMERIC(5, 2) NOT NULL -- km/h
);


-- ==========================================
-- DOMAIN 3: CONTEXT & AI (ML Training Ground)
-- ==========================================

CREATE TABLE environmental_snapshots (
    snapshot_id SERIAL PRIMARY KEY,
    segment_id INT NOT NULL REFERENCES segments(segment_id) ON DELETE RESTRICT,
    timestamp TIMESTAMP NOT NULL, -- Written every 1 hour via Node cron
    temperature NUMERIC(5, 2),
    precipitation NUMERIC(5, 2),
    wind NUMERIC(5, 2),
    road_condition VARCHAR(50) CHECK (road_condition IN ('NORMAL', 'WET', 'FLOODED', 'ICE', 'CONSTRUCTION', 'CLOSED'))
);

CREATE TABLE traffic_snapshots (
    snapshot_id SERIAL PRIMARY KEY,
    segment_id INT NOT NULL REFERENCES segments(segment_id) ON DELETE RESTRICT,
    timestamp TIMESTAMP NOT NULL, -- Written every 15 min via Node cron
    macro_traffic_speed NUMERIC(5, 2) NOT NULL -- City's reported average speed
);

CREATE TABLE aggregated_delays (
    segment_id INT NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
    time_block VARCHAR(50) NOT NULL, -- e.g., "16:00-17:00"
    weather_type VARCHAR(50) NOT NULL, -- e.g., "RAIN"
    avg_historical_delay_minutes NUMERIC(5, 2) NOT NULL, -- Extracted AI memory
    PRIMARY KEY (segment_id, time_block, weather_type)
);
