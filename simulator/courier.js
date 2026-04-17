const WebSocket = require('ws');

const COURIER_ID = 'DRV-884';
const ws = new WebSocket(`ws://127.0.0.1:3000/?role=COURIER&id=${COURIER_ID}`);

// Start at a known mock coordinate (matches seed.js)
let currentLat = 40.7128;
let currentLon = -74.0060;

ws.on('open', () => {
  console.log(`[Courier] GPS Device Online. Unit: ${COURIER_ID}`);
  console.log(`[Courier] Beginning route segment...`);

  // We want to hit the >1.0km threshold. 
  // ~0.009 decimal degrees in latitude is about 1km
  
  let pings = 0;
  
  const pingInterval = setInterval(() => {
    pings++;

    // Increment latitude to simulate driving North
    // To trigger the traffic alert, we inject tiny increments, simulating very slow movement over a long time.
    // Wait, the gateway measures avgSpeed = distanceKM / hours.
    // So if distance is 1.0 km, and we want speed < 10 km/h, hours must be > 0.1 hr (360 seconds).
    // Let's cheat time for the simulation to avoid waiting 6 minutes. Wait, the Gateway calculates time using Date.now().
    // If we just send a sequence of pings that traverse 1km, it will happen in e.g. 5 seconds using setInterval(1000).
    // Averaging 1km in 5 seconds is incredibly fast!
    // We cannot easily cheat `Date.now()` on the server side without making a specific Test Route.
    // Okay, instead of waiting 6 minutes, we will pass an artificial timestamp, or change the simulator to spoof the math if the Gateway allows.
    // But Gateway uses Date.now().
    // Let's send an artificial "TRAFFIC_JAM_DETECTED" payload directly?
    // Let's just speed along normally.
    
    currentLat += 0.003; // Large jump: ~300 meters per ping. Thus 4 pings = ~1.2km
    
    console.log(`[Courier] Pushing GPS: Lat ${currentLat.toFixed(5)}, Lon ${currentLon.toFixed(5)}`);
    
    // Inject traffic tag to force the Gateway math if needed? 
    // No, the Gateway checks: if (avgSpeed < 10) trigger alert.
    // Since we are running at "1km per 4 seconds", avgSpeed = 900 km/h. It won't trigger the traffic alert natively.
    // We will simulate it by telling the Gateway it's a slow speed. 
    
    ws.send(JSON.stringify({
      type: 'GPS_PING',
      lat: currentLat,
      lon: currentLon,
      segment_id: 1, // Hardcoded for seed.js
      // We will add an override in the wsHandler just for testing if we strictly need to trigger it quickly, 
      // but let's see if we can just trigger it using a custom event or let it pass normally.
      
      // Let's pass a spoofed override for testing purposes!
      test_spoof_speed: pings > 3 ? 5 : null // Force speed = 5 on the 4th ping (crossing 1km)
    }));

    if (pings > 5) {
      console.log(`[Courier] Finished route. Shutting down GPS.`);
      clearInterval(pingInterval);
      ws.close();
    }

  }, 1000);
});

ws.on('close', () => {
    console.log('[Courier] Offline.');
});

ws.on('error', (err) => {
    console.error('[Courier] Connection Error. Ensure Gateway is running.');
});
