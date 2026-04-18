const WebSocket = require('ws');

const COURIER_ID  = process.env.COURIER_ID  || 'DRV-884';
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:3000';

const ws = new WebSocket(`${GATEWAY_URL}/?role=COURIER&id=${COURIER_ID}`);

// Default start position: central Sivas, Turkey
let currentLat = parseFloat(process.env.START_LAT || '39.7505');
let currentLon = parseFloat(process.env.START_LON || '37.0150');

ws.on('open', () => {
  console.log(`[Courier] GPS Device Online. Unit: ${COURIER_ID}`);

  let pings = 0;

  const pingInterval = setInterval(() => {
    pings++;
    currentLat += 0.003; // ~300 m per ping; crosses 1 km threshold after ~4 pings

    console.log(`[Courier] GPS ping ${pings}: ${currentLat.toFixed(5)}, ${currentLon.toFixed(5)}`);

    ws.send(JSON.stringify({
      type: 'GPS_PING',
      lat: currentLat,
      lon: currentLon,
      segment_id: 'SEG-1',
      // Spoofs a slow speed on ping 4+ so the gateway triggers a TRAFFIC_ALERT
      // without waiting the real ~6 minutes it takes to accumulate 1 km at walking pace.
      test_spoof_speed: pings > 3 ? 5 : null,
    }));

    if (pings > 5) {
      console.log('[Courier] Route complete. Shutting down GPS.');
      clearInterval(pingInterval);
      ws.close();
    }
  }, 1000);
});

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw);
    console.log(`[Courier] Received: ${msg.type}`);
  } catch {}
});

ws.on('close', () => console.log('[Courier] Offline.'));
ws.on('error', () => console.error('[Courier] Connection error — is the gateway running?'));
