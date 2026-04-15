require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const db = require('./db');
const { pubClient } = require('./redisClient');
const { setupWebSocket } = require('./wsHandler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// Basic healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'OK', role: 'Gateway' });
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
server.listen(PORT, () => {
  console.log(`Gateway Edge Node running on port ${PORT}`);
});
