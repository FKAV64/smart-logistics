const turf = require('@turf/turf');
const db = require('./db');
const { pubClient, aiEvents } = require('./redisClient');

const courierState = {};

function setupWebSocket(wss) {
  // Catch AI/Python calculations and route them to the correct frontend
  aiEvents.on('optimization_received', (data) => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        // 1. Dispatchers still get the generic AI alert dashboard update
        if (client.role === 'DISPATCHER') {
          client.send(JSON.stringify({
            type: 'AI_ROUTE_RECOMMENDATION',
            payload: data
          }));
        }

        // 2. COURIER ONLY gets their SPECIFIC GeoJSON update
        if (client.role === 'COURIER' && client.courierId === data.courier_id) {
          console.log(`Routing updated GeoJSON to Courier: ${client.courierId}`);
          client.send(JSON.stringify({
            type: 'ACTIVE_ROUTE_UPDATE',
            payload: data.geojson // Assuming Python packages the map data here
          }));
        }
      }
    });
  });

  wss.on('connection', (ws, req) => {
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
        // NEW: ROUTINE HEALTH CHECK (Triggered on Frontend Mount/Reconnect)
        // -------------------------------------------------------------
        if (ws.role === 'COURIER' && data.type === 'GET_DAILY_MANIFEST') {
          console.log(`[HEALTH CHECK] Fetching unvisited stops for: ${ws.courierId}`);

          try {
            // Fetch unvisited stops. (Adjust table names to your exact schema if needed)
            const result = await db.query(
              `SELECT stop_id, latitude, longitude, delivery_order, time_window_open, time_window_close 
               FROM manifest_stops 
               WHERE courier_id = $1 AND status = 'PENDING'
               ORDER BY delivery_order ASC`,
              [ws.courierId]
            );

            // Format the payload for the Python Brain
            const trafficAlertPayload = {
              event: 'ROUTINE_HEALTH_CHECK',
              courier_id: ws.courierId,
              timestamp: new Date().toISOString(),
              unvisited_stops: result.rows
            };

            // Publish to Redis for Python to pick up and calculate the GeoJSON
            await pubClient.publish('route_optimization_channel', JSON.stringify(trafficAlertPayload));
            console.log(`[HEALTH CHECK] Data pushed to Python Brain for ${ws.courierId}`);

          } catch (dbErr) {
            console.error('Error fetching manifest for health check:', dbErr);
          }
        }

        // -------------------------------------------------------------
        // EXISTING: COURIER LOGIC (Distance Accumulation & Traffic Alerts)
        // -------------------------------------------------------------
        if (ws.role === 'COURIER' && data.type === 'GPS_PING') {
          const state = courierState[ws.courierId];
          const currentPoint = turf.point([data.lon, data.lat]);

          if (state.lastPoint) {
            const distanceKM = turf.distance(state.lastPoint, currentPoint, { units: 'kilometers' });
            state.accumulatedDistanceKM += distanceKM;
            state.lastPoint = currentPoint;

            if (state.accumulatedDistanceKM >= 1.0) {
              const timeS = (Date.now() - state.segmentStartTime) / 1000;
              const hours = timeS / 3600;
              let avgSpeed = state.accumulatedDistanceKM / hours;

              const segmentId = data.segment_id || 1;

              if (data.test_spoof_speed !== undefined && data.test_spoof_speed !== null) {
                avgSpeed = data.test_spoof_speed;
              }

              await pubClient.xadd(
                'telemetry_stream', '*',
                'courier_id', ws.courierId,
                'segment_id', segmentId,
                'entry_time', new Date(state.segmentStartTime).toISOString(),
                'exit_time', new Date().toISOString(),
                'average_speed', avgSpeed.toFixed(2),
                'distance_km', state.accumulatedDistanceKM.toFixed(2)
              );

              if (avgSpeed < 10) {
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

              state.accumulatedDistanceKM = 0;
              state.segmentStartTime = Date.now();
            }
          } else {
            state.lastPoint = currentPoint;
            state.segmentStartTime = Date.now();
          }
        }

        // -------------------------------------------------------------
        // EXISTING: DISPATCHER LOGIC (Route Approval)
        // -------------------------------------------------------------
        if (ws.role === 'DISPATCHER' && data.type === 'APPROVE_ROUTE') {
          const { routeId, recommendedStopsOrder } = data.payload;

          await db.query('BEGIN');
          try {
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
  });
}

module.exports = { setupWebSocket };