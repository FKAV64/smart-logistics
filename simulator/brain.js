const Redis = require('ioredis');

// Direct Redis connection, bypassing HTTP/WS gateway
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const pubClient = new Redis(redisUrl);
const subClient = new Redis(redisUrl);

console.log('[Brain] Starting AI Engine (Python Mock)...');

subClient.subscribe('traffic_alerts_channel', (err, count) => {
  if (err) {
    console.error('[Brain] Failed to subscribe to traffic alerts', err);
  } else {
    console.log('[Brain] Listening on traffic_alerts_channel...');
  }
});

subClient.on('message', async (channel, message) => {
  if (channel === 'traffic_alerts_channel') {
    const alert = JSON.parse(message);
    console.log(`\n🧠 [Brain] Incoming Telemetry Alert: Courier ${alert.courier_id} is stuck! (Speed: ${alert.avg_speed.toFixed(2)} km/h)`);
    
    console.log(`🧠 [Brain] Crunching optimization models based on Segment ${alert.segment_id} historical delays...`);
    
    // Simulate "thinking" time for ML model inference
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`🧠 [Brain] Solved! Pushing new route down to the Edge Gateway...`);

    // We assume this courier is on Route 1, and we want to change stop order 1->2->3 to e.g., 3->1->2
    const recommendation = {
      event: 'OPTIMIZATION_READY',
      routeId: 'MAN-1', // Hardcoded to match Seed data
      reason: `Traffic gridlock on Segment ${alert.segment_id}. Bypass via Side Streets recommended.`,
      recommendedStopsOrder: [
        { stop_id: 3, stop_order: 1 },
        { stop_id: 1, stop_order: 2 },
        { stop_id: 2, stop_order: 3 }
      ]
    };

    await pubClient.publish('route_optimizations_channel', JSON.stringify(recommendation));
  }
});
