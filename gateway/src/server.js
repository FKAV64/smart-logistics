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
const { setupWebSocket } = require('./wsHandler');

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
// CRON JOBS (Environmental & Traffic Syncing)
// -------------------------------------------------------------

// Traffic Snapshots: Run every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  console.log('[CRON] Running Traffic Snapshots Sync...');
  try {
    // In a real scenario, this would fetch from a Map API (Google Maps, Mapbox, etc.)
    // We mock fetching "macro_traffic_speed" for segment_id=1
    const mockMacroSpeed = Math.random() * (60 - 10) + 10; // Between 10 and 60 km/h

    await db.query(
      `INSERT INTO traffic_snapshots (segment_id, timestamp, macro_traffic_speed)
       VALUES ($1, $2, $3)`,
      [1, new Date().toISOString(), mockMacroSpeed]
    );

    // CRITICAL AI DEPENDENCY: update Redis
    await pubClient.publish('traffic_updates', JSON.stringify({
      segment_id: 1,
      timestamp: new Date().toISOString(),
      macro_traffic_speed: mockMacroSpeed
    }));
  } catch (err) {
    console.error('[CRON] Error syncing traffic:', err);
  }
});

// Environmental Snapshots: Run every 60 minutes
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Running Environmental Snapshots Sync...');
  try {
    // Mock weather fetch
    const temp = Math.random() * (35 + 5) - 5; // -5 to 35 C
    const conditions = ['NORMAL', 'WET', 'FLOODED', 'ICE', 'CONSTRUCTION', 'CLOSED'];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];

    await db.query(
      `INSERT INTO environmental_snapshots (segment_id, timestamp, temperature, precipitation, wind, road_condition)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [1, new Date().toISOString(), temp, 0, 10, condition]
    );

    // CRITICAL AI DEPENDENCY: update Redis
    await pubClient.publish('environmental_updates', JSON.stringify({
      segment_id: 1,
      timestamp: new Date().toISOString(),
      temperature: temp,
      road_condition: condition
    }));
  } catch (err) {
    console.error('[CRON] Error syncing environmental data:', err);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Gateway Edge Node running on port ${PORT}`);
});
