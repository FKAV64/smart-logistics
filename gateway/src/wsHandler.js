const turf = require('@turf/turf');
const jwt  = require('jsonwebtoken');
const db   = require('./db');
const { pubClient, aiEvents } = require('./redisClient');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey_hackathon_only';

const courierState = {};

function getTimeBucket() {
  const h = new Date().getHours();
  if (h >= 7  && h < 10) return 'morning_rush';  // 07:00–09:59
  if (h >= 10 && h < 17) return 'midday';         // 10:00–16:59
  if (h >= 17 && h < 20) return 'evening_rush';   // 17:00–19:59
  if (h >= 20 || h < 5)  return 'night';          // 20:00–04:59
  return 'early_morning';                          // 05:00–06:59
}

function buildStops(rows) {
  return rows.map((s, i) => ({
    stop_id:           s.stop_id,
    lat:               parseFloat(s.latitude),
    lon:               parseFloat(s.longitude),
    window_start:      s.time_window_open,
    window_end:        s.time_window_close,
    current_order:     s.delivery_order ?? (i + 1),
    road_type:         'urban',
    package_weight_kg: parseFloat(s.package_weight_kg) || 5.0
  }));
}

function setupWebSocket(wss) {
  // Route Brain AI responses to the correct frontend clients
  aiEvents.on('optimization_received', (data) => {
    const rec = data.ai_recommendation || {};
    const frontendPayload = {
      id:                       `${data.manifest_id}-${Date.now()}`,
      manifest_id:              data.manifest_id,
      vehicleId:                data.courier_id,
      severity:                 rec.severity,
      reason:                   rec.reason,
      action_type:              rec.action_type,
      new_sequence:             rec.new_sequence,
      stop_delay_probabilities: rec.stop_delay_probabilities,
      impact:                   rec.impact,
      route_geojson:            rec.route_geojson,
      status:                   'pending'
    };

    wss.clients.forEach((client) => {
      if (client.readyState !== 1) return;

      if (client.role === 'courier' && client.courierId === data.courier_id) {
        client.send(JSON.stringify({ type: 'AI_ROUTE_RECOMMENDATION', payload: frontendPayload }));
        if (rec.route_geojson) {
          client.send(JSON.stringify({ type: 'ACTIVE_ROUTE_UPDATE', payload: rec.route_geojson }));
        }
      }
    });
  });

  wss.on('connection', (ws, req) => {
    const url       = new URL(req.url, `http://${req.headers.host}`);
    const token     = url.searchParams.get('token');
    let role        = url.searchParams.get('role');
    let courierId   = url.searchParams.get('id');
    let vehicleType = null;

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        role        = decoded.role;
        courierId   = decoded.courierId;
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
          lastPoint:            null,
          accumulatedDistanceKM: 0,
          segmentStartTime:     Date.now()
        };
      }
    }

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        // ------------------------------------------------------------------
        // ROUTINE HEALTH CHECK — fetch manifest and trigger Brain optimization
        // ------------------------------------------------------------------
        if (ws.role === 'courier' && data.type === 'GET_DAILY_MANIFEST') {
          console.log(`[HEALTH CHECK] Fetching stops for: ${ws.courierId}`);
          try {
            const result = await db.query(
              `SELECT
                 ms.stop_id::text          AS stop_id,
                 ccd.lat                   AS latitude,
                 ccd.lon                   AS longitude,
                 ms.delivery_order,
                 ccd.window_start          AS time_window_open,
                 ccd.window_end            AS time_window_close,
                 ccd.weight_kg             AS package_weight_kg,
                 dm.manifest_id,
                 ms.delivery_status        AS status,
                 c.first_name              AS client_first_name,
                 c.phone                   AS client_phone
               FROM manifest_stops ms
               JOIN daily_manifest         dm  ON ms.manifest_id = dm.manifest_id
               JOIN client_commande_detail ccd ON ms.commande_id  = ccd.commande_id
               JOIN clients               c   ON ccd.client_id   = c.client_id
               WHERE dm.courier_id = $1 AND ms.delivery_status = 'PENDING'
               ORDER BY ms.delivery_order ASC`,
              [ws.courierId]
            );

            // Send manifest directly to courier frontend
            ws.send(JSON.stringify({
              type:    'DAILY_MANIFEST_LOADED',
              payload: { stops: result.rows }
            }));
            console.log(`[HEALTH CHECK] Sent ${result.rows.length} stops to courier frontend`);

            if (result.rows.length === 0) return;

            // Forward to Brain via Redis with correct TrafficAlertPayload format
            const lastPos = courierState[ws.courierId]?.lastPoint?.geometry?.coordinates;
            await pubClient.publish('traffic_alerts_channel', JSON.stringify({
              event_type:     'ROUTINE_HEALTH_CHECK',
              manifest_id:    result.rows[0].manifest_id,
              courier_id:     ws.courierId,
              courier_status: 'AT_STOP',
              vehicle_type:   (ws.vehicleType || 'van').toLowerCase(),
              current_location: {
                lat:       lastPos ? lastPos[1] : 39.7505,
                lon:       lastPos ? lastPos[0] : 37.0150,
                timestamp: new Date().toISOString()
              },
              environment_horizon: {
                weather_condition: 'clear',
                traffic_level:     'moderate',
                time_bucket:       getTimeBucket(),
                temperature_c:     15.0,
                incident_reported: false
              },
              unvisited_stops: buildStops(result.rows)
            }));
            console.log(`[HEALTH CHECK] Pushed to Brain for ${ws.courierId}`);

          } catch (dbErr) {
            console.error('Error in GET_DAILY_MANIFEST:', dbErr);
          }
        }

        // ------------------------------------------------------------------
        // GPS PING — accumulate distance, detect slow traffic
        // ------------------------------------------------------------------
        if (ws.role === 'courier' && data.type === 'GPS_PING') {
          const state        = courierState[ws.courierId];
          const currentPoint = turf.point([data.lon, data.lat]);

          if (state.lastPoint) {
            const distanceKM = turf.distance(state.lastPoint, currentPoint, { units: 'kilometers' });
            state.accumulatedDistanceKM += distanceKM;
            state.lastPoint = currentPoint;

            if (state.accumulatedDistanceKM >= 1.0) {
              const timeS  = (Date.now() - state.segmentStartTime) / 1000;
              const hours  = timeS / 3600;
              let avgSpeed = state.accumulatedDistanceKM / hours;

              const segmentId = data.segment_id || 1;

              if (data.test_spoof_speed !== undefined && data.test_spoof_speed !== null) {
                avgSpeed = data.test_spoof_speed;
              }

              await pubClient.xadd(
                'telemetry_stream', '*',
                'courier_id',    ws.courierId,
                'segment_id',    segmentId,
                'entry_time',    new Date(state.segmentStartTime).toISOString(),
                'exit_time',     new Date().toISOString(),
                'average_speed', avgSpeed.toFixed(2),
                'distance_km',   state.accumulatedDistanceKM.toFixed(2)
              );

              if (avgSpeed < 10) {
                try {
                  const stopsResult = await db.query(
                    `SELECT stop_id, latitude, longitude, delivery_order,
                            time_window_open, time_window_close, package_weight_kg, manifest_id
                     FROM active_courier_stops
                     WHERE courier_id = $1 AND status = 'PENDING'
                     ORDER BY delivery_order ASC`,
                    [ws.courierId]
                  );

                  if (stopsResult.rows.length > 0) {
                    await pubClient.publish('traffic_alerts_channel', JSON.stringify({
                      event_type:     'TRAFFIC_ALERT',
                      manifest_id:    stopsResult.rows[0].manifest_id,
                      courier_id:     ws.courierId,
                      courier_status: 'EN_ROUTE',
                      vehicle_type:   (ws.vehicleType || 'van').toLowerCase(),
                      current_location: {
                        lat:       data.lat,
                        lon:       data.lon,
                        timestamp: new Date().toISOString()
                      },
                      environment_horizon: {
                        weather_condition: 'clear',
                        traffic_level:     'congested',
                        time_bucket:       getTimeBucket(),
                        temperature_c:     15.0,
                        incident_reported: true
                      },
                      unvisited_stops: buildStops(stopsResult.rows)
                    }));
                    console.log(`[TRAFFIC ALERT] Published for ${ws.courierId} (avg speed: ${avgSpeed.toFixed(1)} km/h)`);
                  }
                } catch (alertErr) {
                  console.error('Error publishing traffic alert:', alertErr);
                }
              }

              state.accumulatedDistanceKM = 0;
              state.segmentStartTime      = Date.now();
            }
          } else {
            state.lastPoint       = currentPoint;
            state.segmentStartTime = Date.now();
          }
        }

        // ------------------------------------------------------------------
        // ROUTE APPROVAL — courier approves AI recommendation
        // ------------------------------------------------------------------
        if (data.type === 'APPROVE_ROUTE') {
          const { routeId, recommendedStopsOrder } = data.payload || {};

          if (!routeId || !Array.isArray(recommendedStopsOrder)) {
            ws.send(JSON.stringify({ type: 'APPROVAL_ERROR', error: 'Invalid payload' }));
            return;
          }

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

        // ------------------------------------------------------------------
        // ROUTE REFUSAL — no DB change, just acknowledge
        // ------------------------------------------------------------------
        if (data.type === 'REFUSE_ROUTE') {
          ws.send(JSON.stringify({ type: 'REFUSE_ROUTE_ACK', id: data.payload?.id }));
        }

      } catch (err) {
        console.error('Error handling WebSocket message', err);
      }
    });
  });
}

module.exports = { setupWebSocket };
