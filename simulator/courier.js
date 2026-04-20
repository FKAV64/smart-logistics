const WebSocket = require('ws');

const COURIER_ID = process.env.COURIER_ID || 'DRV-884';
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:3000';

// Delivery stop coordinates from init.sql, in delivery order
const WAYPOINTS = [
  { lat: 39.7500, lon: 37.0150, name: 'Ali', stop_id: 1 },
  { lat: 39.7550, lon: 37.0200, name: 'Ayse', stop_id: 2 },
  { lat: 39.7600, lon: 37.0100, name: 'Mehmet', stop_id: 3 },
];

const VAN_SPEED_KMPH = 60;     // demo speed: fast but stops are still reachable
const PING_INTERVAL_MS = 3_000;
const DIST_PER_PING_KM = VAN_SPEED_KMPH * (PING_INTERVAL_MS / 1000 / 3600); // ≈ 0.1875 km

// Depot: ~3.4 km south of delivery area — clearly visible starting position on the Sivas map
let currentLat = parseFloat(process.env.START_LAT || '39.7200');
let currentLon = parseFloat(process.env.START_LON || '37.0100');
let waypointIdx = 0;
let pingCount = 0;

let activeRouteCoords = null;
let activeRouteIndex = 0;
let isDone = false;

// Move from current position toward target by up to distKm; returns new position + whether target was reached
function stepToward(fromLat, fromLon, toLat, toLon, distKm) {
  // Haversine distance
  const R = 6371; // Earth radius in km
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLon = (toLon - fromLon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceRemaining = R * c;

  if (distanceRemaining <= distKm || distanceRemaining < 0.0001) {
    return { lat: toLat, lon: toLon, reached: true };
  }

  // Calculate bearing
  const y = Math.sin(dLon) * Math.cos(toLat * Math.PI / 180);
  const x = Math.cos(fromLat * Math.PI / 180) * Math.sin(toLat * Math.PI / 180) -
    Math.sin(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) * Math.cos(dLon);
  const bearing = Math.atan2(y, x);

  // Calculate destination point
  const angularDist = distKm / R;
  const lat1 = fromLat * Math.PI / 180;
  const lon1 = fromLon * Math.PI / 180;

  let newLat = Math.asin(
    Math.sin(lat1) * Math.cos(angularDist) +
    Math.cos(lat1) * Math.sin(angularDist) * Math.cos(bearing)
  );

  let newLon = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDist) * Math.cos(lat1),
    Math.cos(angularDist) - Math.sin(lat1) * Math.sin(newLat)
  );

  return {
    lat: newLat * 180 / Math.PI,
    lon: newLon * 180 / Math.PI,
    reached: false
  };
}

const ws = new WebSocket(`${GATEWAY_URL}/?role=courier&id=${COURIER_ID}`);

ws.on('open', () => {
  console.log(`[Courier Simulator] Unit ${COURIER_ID} online. Depot: ${currentLat}, ${currentLon}`);

  // T=0 — broadcast initial depot position immediately so the courier dot appears on the map
  ws.send(JSON.stringify({
    type: 'GPS_PING',
    lat: currentLat,
    lon: currentLon,
    segment_id: 'SEG-0',
    currentSpeed: 0,
  }));

  setInterval(() => {
    if (isDone) return;
    pingCount++;
    const target = WAYPOINTS[waypointIdx];
    const speed = VAN_SPEED_KMPH + (Math.random() - 0.5) * 4;

    let targetLat = target.lat;
    let targetLon = target.lon;

    if (activeRouteCoords && activeRouteIndex < activeRouteCoords.length) {
      targetLon = activeRouteCoords[activeRouteIndex][0];
      targetLat = activeRouteCoords[activeRouteIndex][1];
    }

    const step = stepToward(currentLat, currentLon, targetLat, targetLon, DIST_PER_PING_KM);
    currentLat = step.lat;
    currentLon = step.lon;

    if (step.reached && activeRouteCoords && activeRouteIndex < activeRouteCoords.length) {
      activeRouteIndex++;
    }

    // Proximity check to stop
    const distToStop = stepToward(currentLat, currentLon, target.lat, target.lon, 0.05);
    if (distToStop.reached) {
      console.log(`[Courier] Arrived at ${target.name} (stop_id: ${target.stop_id}).`);
      ws.send(JSON.stringify({ type: 'STOP_REACHED', stop_id: String(target.stop_id) }));
      waypointIdx++;
      if (waypointIdx >= WAYPOINTS.length) {
        isDone = true;
        console.log('[Courier] All deliveries completed. Simulator halted.');
        return;
      }
    }

    currentLat = step.lat;
    currentLon = step.lon;

    console.log(`[Courier] Ping ${pingCount}: ${currentLat.toFixed(5)}, ${currentLon.toFixed(5)} | ${speed.toFixed(1)} km/h → ${target.name}`);
    ws.send(JSON.stringify({
      type: 'GPS_PING',
      lat: currentLat,
      lon: currentLon,
      segment_id: `SEG-${waypointIdx}`,
      currentSpeed: parseFloat(speed.toFixed(1)),
    }));
  }, PING_INTERVAL_MS);
});

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw);
    if (msg.type !== 'VEHICLE_TELEMETRY') console.log(`[Courier] ← ${msg.type}`);

    if (msg.type === 'SIMULATOR_RESTART') {
      console.log('[Courier] Received SIMULATOR_RESTART. Rebooting trace coordinates...');
      currentLat = parseFloat(process.env.START_LAT || '39.7200');
      currentLon = parseFloat(process.env.START_LON || '37.0100');
      waypointIdx = 0;
      pingCount = 0;
      activeRouteCoords = null;
      activeRouteIndex = 0;
      isDone = false;
      return;
    }

    if (msg.type === 'SIMULATOR_RESEQUENCE' && Array.isArray(msg.payload)) {
      const orderMap = {};
      msg.payload.forEach(s => orderMap[s.stop_id] = s.stop_order);
      WAYPOINTS.sort((a, b) => orderMap[a.stop_id] - orderMap[b.stop_id]);
      console.log(`[Courier] Resequenced WAYPOINTS vector. Next physically targeted stop is: STOP-${WAYPOINTS[waypointIdx]?.stop_id || 'UNKNOWN'}`);
    }

    if (msg.type === 'ACTIVE_ROUTE_UPDATE' && msg.payload?.geometry?.coordinates) {
      let coords = msg.payload.geometry.coordinates;
      if (msg.payload.geometry.type === 'MultiLineString') {
        coords = coords.flat(1);
      }
      activeRouteCoords = coords;

      // Calculate the closest point in the newly generated geometry to prevent reversing direction
      let minDistance = Infinity;
      let closestIdx = 0;
      for (let i = 0; i < coords.length; i++) {
        const dx = coords[i][0] - currentLon;
        const dy = coords[i][1] - currentLat;
        const d2 = dx * dx + dy * dy;
        if (d2 < minDistance) {
          minDistance = d2;
          closestIdx = i;
        }
      }

      // Aim for the node immediately proceeding our physical position
      activeRouteIndex = Math.min(closestIdx + 1, coords.length - 1);
      console.log(`[Courier] Snapping to received routing infrastructure (${coords.length} points). Starting trace at index ${activeRouteIndex}.`);
    }
  } catch { }
});

ws.on('close', () => console.log('[Courier] Offline.'));
ws.on('error', () => console.error('[Courier] Connection error — is the gateway running?'));
