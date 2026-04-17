-- Enable PostGIS for geospatial queries
CREATE EXTENSION IF NOT EXISTS postgis;

-- ==========================================
-- DOMAIN 1: OPERATIONAL ENTITIES
-- ==========================================

CREATE TABLE admins (
    admin_id SERIAL PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL
);

CREATE TABLE couriers (
    courier_id VARCHAR(50) PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(50),
    register_date DATE NOT NULL DEFAULT CURRENT_DATE,
    vehicle_type VARCHAR(50)
);

CREATE TABLE clients (
    client_id VARCHAR(50) PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(50)
);

-- ==========================================
-- DOMAIN 2: LOGISTICS ASSIGNMENT (PIVOT ARCHITECTURE)
-- ==========================================

CREATE TABLE client_commande_detail (
    commande_id SERIAL PRIMARY KEY,
    client_id VARCHAR(50) REFERENCES clients(client_id) ON DELETE CASCADE,
    weight_kg DECIMAL(10,2),
    window_start TIMESTAMP,
    window_end TIMESTAMP,
    lat FLOAT NOT NULL,
    lon FLOAT NOT NULL
);

CREATE TABLE daily_manifest (
    manifest_id VARCHAR(50) PRIMARY KEY,
    courier_id VARCHAR(50) REFERENCES couriers(courier_id) ON DELETE CASCADE,
    date DATE NOT NULL,
    status VARCHAR(50) DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_TRANSIT', 'COMPLETED', 'DELAYED')),
    ai_recommendation JSONB DEFAULT NULL
);

CREATE TABLE manifest_stops (
    stop_id SERIAL PRIMARY KEY,
    manifest_id VARCHAR(50) REFERENCES daily_manifest(manifest_id) ON DELETE CASCADE,
    commande_id INT REFERENCES client_commande_detail(commande_id) ON DELETE CASCADE,
    delivery_order INT NOT NULL,
    delivery_status VARCHAR(50) DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED')),
    actual_delivery_time TIMESTAMP DEFAULT NULL
);

-- ==========================================
-- DOMAIN 3: SPATIAL DATA (CITY TOPOLOGY)
-- ==========================================

CREATE TABLE segments (
    segment_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255),
    start_lat FLOAT NOT NULL,
    start_lon FLOAT NOT NULL,
    end_lat FLOAT NOT NULL,
    end_lon FLOAT NOT NULL,
    geom GEOMETRY(LineString, 4326)
);

CREATE INDEX segments_geom_idx ON segments USING GIST (geom);

-- ==========================================
-- DOMAIN 4: TELEMETRY & AI (REDIS-WORKER FED)
-- ==========================================

CREATE TABLE segment_telemetry (
    telemetry_id SERIAL PRIMARY KEY,
    segment_id VARCHAR(50) REFERENCES segments(segment_id) ON DELETE CASCADE,
    courier_id VARCHAR(50) REFERENCES couriers(courier_id) ON DELETE CASCADE,
    entry_time TIMESTAMP NOT NULL,
    exit_time TIMESTAMP NOT NULL,
    average_speed FLOAT NOT NULL
);

CREATE TABLE environmental_snapshots (
    snapshot_id SERIAL PRIMARY KEY,
    segment_id VARCHAR(50) REFERENCES segments(segment_id) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    temperature_c INT,
    weather_condition VARCHAR(100)
);

CREATE TABLE traffic_snapshots (
    traffic_snapshot_id SERIAL PRIMARY KEY,
    segment_id VARCHAR(50) REFERENCES segments(segment_id) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    traffic_level VARCHAR(50),      -- e.g., 'LIGHT', 'MODERATE', 'HEAVY', 'GRIDLOCK'
    incident_reported BOOLEAN DEFAULT FALSE
);

