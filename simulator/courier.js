const WebSocket = require('ws');
const turf = require('@turf/turf');

const COURIER_ID  = process.env.COURIER_ID  || 'DRV-884';
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:3000';

// Delivery stop coordinates from init.sql, in delivery order
const WAYPOINTS = [
  { lat: 39.7500, lon: 37.0150, name: 'Ali',    stop_id: 1 },
  { lat: 39.7550, lon: 37.0200, name: 'Ayse',   stop_id: 2 },
  { lat: 39.7600, lon: 37.0100, name: 'Mehmet', stop_id: 3 },
];

const VAN_SPEED_KMPH   = 22.5;   // from brain SPEED_PROFILES
const PING_INTERVAL_MS = 30_000;
const DIST_PER_PING_KM = VAN_SPEED_KMPH * (PING_INTERVAL_MS / 1000 / 3600); // ≈ 0.1875 km

// Depot: ~3.4 km south of delivery area — clearly visible starting position on the Sivas map
let currentLat  = parseFloat(process.env.START_LAT || '39.7200');
let currentLon  = parseFloat(process.env.START_LON || '37.0100');
let waypointIdx = 0;
let pingCount   = 0;

// Move from current position toward target by up to distKm; returns new position + whether target was reached
function stepToward(fromLat, fromLon, toLat, toLon, distKm) {
  const from = turf.point([fromLon, fromLat]);
  const to   = turf.point([toLon, toLat]);
  if (turf.distance(from, to, { units: 'kilometers' }) <= distKm) {
    return { lat: toLat, lon: toLon, reached: true };
  }
  const dest = turf.destination(from, distKm, turf.bearing(from, to), { units: 'kilometers' });
  return { lat: dest.geometry.coordinates[1], lon: dest.geometry.coordinates[0], reached: false };
}

const ws = new WebSocket(`${GATEWAY_URL}/?role=courier&id=${COURIER_ID}`);

ws.on('open', () => {
  console.log(`[Courier Simulator] Unit ${COURIER_ID} online. Depot: ${currentLat}, ${currentLon}`);

  // T=0 — broadcast initial depot position immediately so the courier dot appears on the map
  ws.send(JSON.stringify({
    type:         'GPS_PING',
    lat:          currentLat,
    lon:          currentLon,
    segment_id:   'SEG-0',
    currentSpeed: 0,
  }));

  setInterval(() => {
    pingCount++;
    const target = WAYPOINTS[waypointIdx];
    const speed  = VAN_SPEED_KMPH + (Math.random() - 0.5) * 4; // ±2 km/h natural variance
    const step   = stepToward(currentLat, currentLon, target.lat, target.lon, DIST_PER_PING_KM);

    if (step.reached) {
      console.log(`[Courier] Arrived at ${target.name} (stop_id: ${target.stop_id}).`);
      ws.send(JSON.stringify({ type: 'STOP_REACHED', stop_id: String(target.stop_id) }));
      waypointIdx = (waypointIdx + 1) % WAYPOINTS.length;
    }

    currentLat = step.lat;
    currentLon = step.lon;

    console.log(`[Courier] Ping ${pingCount}: ${currentLat.toFixed(5)}, ${currentLon.toFixed(5)} | ${speed.toFixed(1)} km/h → ${target.name}`);
    ws.send(JSON.stringify({
      type:         'GPS_PING',
      lat:          currentLat,
      lon:          currentLon,
      segment_id:   `SEG-${waypointIdx}`,
      currentSpeed: parseFloat(speed.toFixed(1)),
    }));
  }, PING_INTERVAL_MS);
});

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw);
    if (msg.type !== 'VEHICLE_TELEMETRY') console.log(`[Courier] ← ${msg.type}`);
  } catch {}
});

ws.on('close', () => console.log('[Courier] Offline.'));
ws.on('error', ()  => console.error('[Courier] Connection error — is the gateway running?'));
