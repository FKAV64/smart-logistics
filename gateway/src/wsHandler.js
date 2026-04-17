const turf = require('@turf/turf');
const db = require('./db');
const { pubClient, aiEvents } = require('./redisClient');

// In-memory state for tracking couriers' distance accumulation
// In a highly scaled system this might be kept in Redis to survive pod restarts,
// but for the Gateway instance, memory is fine for the hackathon MVP.
const courierState = {}; 

function setupWebSocket(wss) {
  // Broadcast AI suggestions to all connected dispatchers
  aiEvents.on('optimization_received', (data) => {
    wss.clients.forEach((client) => {
      // Assuming clients have a property 'role' set during connection
      if (client.readyState === 1 && client.role === 'DISPATCHER') {
        client.send(JSON.stringify({
          type: 'AI_ROUTE_RECOMMENDATION',
          payload: data
        }));
      }
    });
  });

  wss.on('connection', (ws, req) => {
    // Quick and dirty role assignment based on query param ?role=DISPATCHER or ?role=COURIER&id=DRV-884
    const url = new URL(req.url, `http://${req.headers.host}`);
    const role = url.searchParams.get('role');
    const courierId = url.searchParams.get('id');

    Object.assign(ws, { role, courierId });

    if (role === 'COURIER' && courierId) {
      if (!courierState[courierId]) {
        courierState[courierId] = {
          lastPoint: null,
          accumulatedDistanceKM: 0,
          segmentStartTime: Date.now()
        };
      }
    }

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        // -------------------------------------------------------------
        // COURIER LOGIC (Distance Accumulation & Traffic Alerts)
        // -------------------------------------------------------------
        if (ws.role === 'COURIER' && data.type === 'GPS_PING') {
          const state = courierState[ws.courierId];
          const currentPoint = turf.point([data.lon, data.lat]);

          if (state.lastPoint) {
            // Calculate distance in kilometers since last ping
            const distanceKM = turf.distance(state.lastPoint, currentPoint, { units: 'kilometers' });
            state.accumulatedDistanceKM += distanceKM;
            state.lastPoint = currentPoint;

            // Send raw ping to Redis stream for generic tracking (optional)
            // But we primarily care about the 1km barrier.

            if (state.accumulatedDistanceKM >= 1.0) { // 1 km threshold
              const timeS = (Date.now() - state.segmentStartTime) / 1000;
              const hours = timeS / 3600;
              let avgSpeed = state.accumulatedDistanceKM / hours; // km/h

              // Assuming the courier sends an approximate segment_id they are on
              const segmentId = data.segment_id || 1; 

              // Override for test script speed injection
              if (data.test_spoof_speed !== undefined && data.test_spoof_speed !== null) {
                avgSpeed = data.test_spoof_speed;
              }

              // Trigger Writer Behind Worker
              await pubClient.xadd(
                'telemetry_stream', 
                '*', 
                'courier_id', ws.courierId,
                'segment_id', segmentId,
                'entry_time', new Date(state.segmentStartTime).toISOString(),
                'exit_time', new Date().toISOString(),
                'average_speed', avgSpeed.toFixed(2),
                'distance_km', state.accumulatedDistanceKM.toFixed(2)
              );

              // Check if we need to trigger AI Optimization Alert
              // If speed is extremely low compared to limit
              if (avgSpeed < 10) { // Traffic jam threshold
                await pubClient.publish('traffic_alerts_channel', JSON.stringify({
                  event: 'TRAFFIC_JAM_DETECTED',
                  courier_id: ws.courierId,
                  lat: data.lat,
                  lon: data.lon,
                  avg_speed: avgSpeed,
                  segment_id: segmentId,
                  timestamp: new Date().toISOString()
                }));
              }

              // Reset accumulator for next segment
              state.accumulatedDistanceKM = 0;
              state.segmentStartTime = Date.now();
            }
          } else {
            // First point
            state.lastPoint = currentPoint;
            state.segmentStartTime = Date.now();
          }
        }

        // -------------------------------------------------------------
        // DISPATCHER LOGIC (Direct DB Connection for Route Approval)
        // -------------------------------------------------------------
        if (ws.role === 'DISPATCHER' && data.type === 'APPROVE_ROUTE') {
          const { routeId, recommendedStopsOrder } = data.payload;
          
          await db.query('BEGIN');
          try {
            // Update the delivery_order for the modified route stops
            for (const stop of recommendedStopsOrder) {
              await db.query(
                'UPDATE manifest_stops SET delivery_order = $1 WHERE stop_id = $2 AND manifest_id = $3',
                [stop.stop_order, stop.stop_id, routeId]
              );
            }
            await db.query(
              'UPDATE daily_manifest SET status = $1, ai_recommendation = $2 WHERE manifest_id = $3',
              ['IN_TRANSIT', JSON.stringify({ approvedAt: new Date().toISOString() }), routeId]
            );
            await db.query('COMMIT');

            ws.send(JSON.stringify({ type: 'APPROVAL_SUCCESS', routeId }));
          } catch (error) {
            await db.query('ROLLBACK');
            console.error('Error approving route', error);
            ws.send(JSON.stringify({ type: 'APPROVAL_ERROR', error: error.message }));
          }
        }

      } catch (err) {
        console.error('Error handling WebSocket message', err);
      }
    });

    ws.on('close', () => {
      // Optional: Cleanup state if disconnected for a long time
    });
  });
}

module.exports = { setupWebSocket };
