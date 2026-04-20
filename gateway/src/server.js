require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { pubClient } = require('./redisClient');
const { setupWebSocket, resetCourierState } = require('./wsHandler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey_hackathon_only';

// Basic healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'OK', role: 'Gateway' });
});

// Authentication Endpoint
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

  try {
    const { rows } = await db.query('SELECT courier_id, first_name, last_name, email, password, vehicle_type FROM couriers WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const token = jwt.sign(
      { 
        courierId: user.courier_id, 
        role: 'courier', 
        vehicleType: user.vehicle_type 
      }, 
      JWT_SECRET, 
      { expiresIn: '12h' }
    );

    // Reset manifest for a clean demo restart
    await db.query(`
      UPDATE manifest_stops
      SET delivery_status = 'PENDING',
          actual_delivery_time = NULL,
          delivery_order = sub.rn
      FROM (
        SELECT ms.stop_id,
               ROW_NUMBER() OVER (ORDER BY ms.stop_id) AS rn
        FROM manifest_stops ms
        JOIN daily_manifest dm ON ms.manifest_id = dm.manifest_id
        WHERE dm.courier_id = $1
      ) sub
      WHERE manifest_stops.stop_id = sub.stop_id
    `, [user.courier_id]);

    await db.query(
      `UPDATE daily_manifest SET status = 'PLANNED', ai_recommendation = NULL WHERE courier_id = $1`,
      [user.courier_id]
    );

    // Clear in-memory gateway state for this courier
    resetCourierState(user.courier_id);

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'SIMULATOR_RESTART' }));
      }
    });

    res.json({
      success: true, 
      token, 
      role: 'courier',
      user: {
        id: user.courier_id,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        vehicleType: user.vehicle_type
      }
    });
  } catch (err) {
    console.error('Login error', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Attach WebSockets
setupWebSocket(wss);

// -------------------------------------------------------------
// CRON JOBS (Environmental & Traffic Syncing via TomTom Mock)
// -------------------------------------------------------------

const TOMTOM_URL = process.env.TOMTOM_MOCK_URL || 'http://localhost:7777';

/** Fetch all road segments with their centroid coordinates */
async function fetchSegments() {
  const { rows } = await db.query(`
    SELECT segment_id,
           ST_Y(ST_Centroid(geom)) AS lat,
           ST_X(ST_Centroid(geom)) AS lon
    FROM segments
  `);
  return rows;
}

// Traffic Snapshots: every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  console.log('[CRON] Traffic Snapshots Sync via TomTom Mock...');
  try {
    const segments = await fetchSegments();
    const ts = new Date().toISOString();

    for (const seg of segments) {
      const res  = await fetch(
        `${TOMTOM_URL}/traffic/services/4/flowSegmentData/absolute/10/json?point=${seg.lat},${seg.lon}&key=mock`
      );
      const data = await res.json();
      const { currentSpeed, roadClosure } = data.flowSegmentData;

      const traffic_level =
        currentSpeed > 50 ? 'LIGHT'    :
        currentSpeed >= 30 ? 'MODERATE' :
        currentSpeed >= 10 ? 'HEAVY'    : 'GRIDLOCK';

      await db.query(
        `INSERT INTO traffic_snapshots (segment_id, timestamp, traffic_level, incident_reported)
         VALUES ($1, $2, $3, $4)`,
        [seg.segment_id, ts, traffic_level, roadClosure]
      );

      await pubClient.publish('traffic_updates', JSON.stringify({
        segment_id:        seg.segment_id,
        timestamp:         ts,
        traffic_level,
        incident_reported: roadClosure,
        current_speed_kmh: currentSpeed,
      }));
    }

    console.log(`[CRON] Traffic snapshots written for ${segments.length} segment(s)`);
  } catch (err) {
    console.error('[CRON] Traffic sync error:', err.message);
  }
});

// Environmental Snapshots: every hour
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Environmental Snapshots Sync via TomTom Mock...');
  try {
    const segments = await fetchSegments();
    if (segments.length === 0) return;

    // Weather is area-wide — one API call using the first segment's coords
    const { lat, lon } = segments[0];
    const res  = await fetch(
      `${TOMTOM_URL}/weather/1/currentConditions/json?q=${lat},${lon}&key=mock`
    );
    const { currentConditions } = await res.json();
    const { temperature_c, weather_condition } = currentConditions;
    const ts = new Date().toISOString();

    for (const seg of segments) {
      await db.query(
        `INSERT INTO environmental_snapshots (segment_id, timestamp, temperature_c, weather_condition)
         VALUES ($1, $2, $3, $4)`,
        [seg.segment_id, ts, temperature_c, weather_condition]
      );
    }

    await pubClient.publish('environmental_updates', JSON.stringify({
      timestamp: ts,
      temperature_c,
      weather_condition,
    }));

    console.log(`[CRON] Environmental snapshots written for ${segments.length} segment(s) — ${weather_condition} ${temperature_c}°C`);
  } catch (err) {
    console.error('[CRON] Environmental sync error:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Gateway Edge Node running on port ${PORT}`);
});
