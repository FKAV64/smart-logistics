const turf = require('@turf/turf');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { pubClient, aiEvents } = require('./redisClient');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey_hackathon_only';

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
        if (client.role === 'courier' && client.courierId === data.courier_id) {
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
    const token = url.searchParams.get('token');
    let role = url.searchParams.get('role'); // Fallback for Dispatcher if wanted
    let courierId = url.searchParams.get('id');
    let vehicleType = null;

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        role = decoded.role;
        courierId = decoded.courierId;
        vehicleType = decoded.vehicleType;
      } catch (err) {
        console.error('Invalid WebSocket JWT Token');
        return ws.close();
      }
    }

    Object.assign(ws, { role, courierId, vehicleType });

    if (role === 'courier' && courierId) {
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
        if (ws.role === 'courier' && data.type === 'GET_DAILY_MANIFEST') {
          console.log(`[HEALTH CHECK] Fetching unvisited stops for: ${ws.courierId}`);

          try {
            const result = await db.query(
              `SELECT stop_id, latitude, longitude, delivery_order, time_window_open, time_window_close 
               FROM active_courier_stops 
               WHERE courier_id = $1 AND status = 'PENDING'
               ORDER BY delivery_order ASC`,
              [ws.courierId]
            );

            // 1. Send stops DIRECTLY back to frontend immediately
            ws.send(JSON.stringify({
              type: 'DAILY_MANIFEST_LOADED',
              payload: { stops: result.rows }
            }));
            console.log(`[HEALTH CHECK] Manifest sent to courier frontend (${result.rows.length} stops)`);

            // 2. Also forward to Python Brain via Redis for route optimisation
            const trafficAlertPayload = {
              event: 'ROUTINE_HEALTH_CHECK',
              courier_id: ws.courierId,
              vehicle_type: ws.vehicleType,
              timestamp: new Date().toISOString(),
              unvisited_stops: result.rows
            };

            await pubClient.publish('route_optimization_channel', JSON.stringify(trafficAlertPayload));
            console.log(`[HEALTH CHECK] Data pushed to Python Brain for ${ws.courierId}`);

          } catch (dbErr) {
            console.error('Error fetching manifest for health check:', dbErr);
          }
        }

        // -------------------------------------------------------------
        // EXISTING: COURIER LOGIC (Distance Accumulation & Traffic Alerts)
        // -------------------------------------------------------------
        if (ws.role === 'courier' && data.type === 'GPS_PING') {
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
                  vehicle_type: ws.vehicleType,
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