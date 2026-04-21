const turf = require('@turf/turf');
const jwt  = require('jsonwebtoken');
const db   = require('./db');
const { pubClient, aiEvents } = require('./redisClient');

const JWT_SECRET  = process.env.JWT_SECRET      || 'supersecretkey_hackathon_only';
const TOMTOM_URL  = process.env.TOMTOM_MOCK_URL || 'http://tomtom-mock:7777';

const courierState = {};

function getTimeBucket() {
  const h = new Date().getHours();
  if (h >= 7  && h < 10) return 'morning_rush';
  if (h >= 10 && h < 17) return 'midday';
  if (h >= 17 && h < 20) return 'evening_rush';
  if (h >= 20 || h < 5)  return 'night';
  return 'early_morning';
}

const TRAFFIC_MAP = { LIGHT: 'low', MODERATE: 'moderate', HEAVY: 'high', GRIDLOCK: 'congested' };
const WEATHER_MAP = {
  clear: 'clear', partly_cloudy: 'cloudy', cloudy: 'cloudy',
  rainy: 'rain', foggy: 'fog', snowy: 'snow', icy: 'snow',
};

async function fetchEnvironment(lat, lon) {
  try {
    const [tRes, wRes] = await Promise.all([
      fetch(`${TOMTOM_URL}/traffic/services/4/flowSegmentData/absolute/10/json?point=${lat},${lon}`),
      fetch(`${TOMTOM_URL}/weather/1/currentConditions/json?q=${lat},${lon}`),
    ]);
    const { flowSegmentData: f } = await tRes.json();
    const { currentConditions:  c } = await wRes.json();
    return {
      weather_condition: WEATHER_MAP[c.weather_condition] || 'clear',
      traffic_level:     TRAFFIC_MAP[f.trafficLevel]       || 'moderate',
      time_bucket:       getTimeBucket(),
      temperature_c:     c.temperature_c,
      incident_reported: f.roadClosure,
      road_type:         f.road_type || 'urban',
    };
  } catch {
    return {
      weather_condition: 'clear',
      traffic_level:     'moderate',
      time_bucket:       getTimeBucket(),
      temperature_c:     15.0,
      incident_reported: false,
      road_type:         'urban',
    };
  }
}

function buildStops(rows, roadType = 'urban') {
  return rows.map((s, i) => ({
    stop_id:           s.stop_id,
    lat:               parseFloat(s.latitude),
    lon:               parseFloat(s.longitude),
    window_start:      s.time_window_open,
    window_end:        s.time_window_close,
    current_order:     s.delivery_order ?? (i + 1),
    road_type:         roadType,
    package_weight_kg: parseFloat(s.package_weight_kg) || 5.0
  }));
}

function setupWebSocket(wss) {
  // Route Brain AI responses to the correct frontend clients
  aiEvents.on('optimization_received', (data) => {
    const rec = data.ai_recommendation || {};

    // Cache the active GeoJSON sequence dynamically for 5km ahead calculations
    if (rec.route_geojson && data.courier_id) {
      if (!courierState[data.courier_id]) courierState[data.courier_id] = { lastPoint: null, lastPosition: null, accumulatedDistanceKM: 0, segmentStartTime: Date.now() };
      courierState[data.courier_id].activeGeoJSON = rec.route_geojson;
    }

    // Push route geometry immediately for all actions except RE-ROUTE (which waits for user approval)
    if (rec.route_geojson && rec.action_type !== 'RE-ROUTE') {
      wss.clients.forEach((client) => {
        if (client.readyState !== 1) return;
        if (client.role === 'courier' && client.courierId === data.courier_id) {
          client.send(JSON.stringify({ type: 'ACTIVE_ROUTE_UPDATE', payload: rec.route_geojson }));
        }
      });
    }

    // For RE-ROUTE: hold the proposed route until the user approves
    if (rec.action_type === 'RE-ROUTE' && data.courier_id) {
      if (!courierState[data.courier_id]) courierState[data.courier_id] = { lastPoint: null, lastPosition: null, accumulatedDistanceKM: 0, segmentStartTime: Date.now() };
      courierState[data.courier_id].pendingRouteGeoJSON = rec.route_geojson || null;
    }

    // CONTINUE means all clear — no recommendation card needed
    if (rec.action_type === 'CONTINUE') return;

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
      route_health:             rec.impact?.route_health || null,
      time_saved_minutes:       rec.impact?.time_saved_minutes || 0,
      route_geojson:            rec.route_geojson,
    };

    wss.clients.forEach((client) => {
      if (client.readyState !== 1) return;
      if (client.role === 'courier' && client.courierId === data.courier_id) {
        client.send(JSON.stringify({ type: 'AI_ROUTE_RECOMMENDATION', payload: frontendPayload }));
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

    // Normalize role to lowercase so simulator (?role=courier) and JWT (role:'courier') match
    role = (role || '').toLowerCase();
    Object.assign(ws, { role, courierId, vehicleType });

    if (role === 'courier' && courierId) {
      if (!courierState[courierId]) {
        courierState[courierId] = {
          lastPoint:             null,
          lastPosition:          null,
          accumulatedDistanceKM: 0,
          segmentStartTime:      Date.now()
        };
      } else if (token && courierState[courierId].lastPosition) {
        // New frontend tab connected — replay the last known position so the dot appears immediately
        ws.send(JSON.stringify({ type: 'VEHICLE_TELEMETRY', payload: courierState[courierId].lastPosition }));
      }
    }

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        // ------------------------------------------------------------------
        // ROUTINE HEALTH CHECK — fetch manifest and trigger Brain optimization
        // ------------------------------------------------------------------
        if (ws.role === 'courier' && data.type === 'GET_DAILY_MANIFEST') {
          console.log(`[HEALTH CHECK] Initializing routine loop for: ${ws.courierId}`);
          
          const executeHealthCheck = async (isInitial = false) => {
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
                 c.phone                   AS client_phone,
                 nearest.name              AS street_name
               FROM manifest_stops ms
               JOIN daily_manifest         dm   ON ms.manifest_id  = dm.manifest_id
               JOIN client_commande_detail ccd  ON ms.commande_id  = ccd.commande_id
               JOIN clients               c    ON ccd.client_id   = c.client_id
               LEFT JOIN LATERAL (
                 SELECT name FROM segments
                 ORDER BY geom <-> ST_SetSRID(ST_MakePoint(ccd.lon, ccd.lat), 4326)
                 LIMIT 1
               ) nearest ON true
               WHERE dm.courier_id = $1 AND ms.delivery_status = 'PENDING'
               ORDER BY ms.delivery_order ASC`,
              [ws.courierId]
            );

              if (isInitial) {
                ws.send(JSON.stringify({
                  type:    'DAILY_MANIFEST_LOADED',
                  payload: { stops: result.rows }
                }));
                console.log(`[HEALTH CHECK] Sent ${result.rows.length} stops to courier frontend`);
              }

              if (result.rows.length === 0) {
                if (courierState[ws.courierId]?.healthCheckInterval) {
                  clearInterval(courierState[ws.courierId].healthCheckInterval);
                  courierState[ws.courierId].healthCheckInterval = null;
                }
                return;
              }

              // Fetch real environment from TomTom for the courier's current position
              const lastPos = courierState[ws.courierId]?.lastPoint?.geometry?.coordinates;
              const hcLat   = lastPos ? lastPos[1] : parseFloat(process.env.START_LAT || '39.7200');
              const hcLon   = lastPos ? lastPos[0] : parseFloat(process.env.START_LON || '37.0100');
              const env     = await fetchEnvironment(hcLat, hcLon);

              await pubClient.publish('traffic_alerts_channel', JSON.stringify({
                event_type:     'ROUTINE_HEALTH_CHECK',
                manifest_id:    result.rows[0].manifest_id,
                courier_id:     ws.courierId,
                courier_status: 'AT_STOP',
                vehicle_type:   (ws.vehicleType || 'van').toLowerCase(),
                current_location: {
                  lat:       hcLat,
                  lon:       hcLon,
                  timestamp: new Date().toISOString()
                },
                environment_horizon:  env,
                unvisited_stops:      buildStops(result.rows, env.road_type)
              }));
              if (isInitial) console.log(`[HEALTH CHECK] Pushed initial check to Brain for ${ws.courierId}`);
            } catch (dbErr) {
              console.error('Error in executeHealthCheck:', dbErr);
            }
          };

          await executeHealthCheck(true);

          if (!courierState[ws.courierId].healthCheckInterval) {
            courierState[ws.courierId].healthCheckInterval = setInterval(() => {
              executeHealthCheck(false);
            }, 60000);
          }
        }

        // ------------------------------------------------------------------
        // GPS PING — broadcast position, detect traffic 5 km ahead
        // ------------------------------------------------------------------
        if (ws.role === 'courier' && data.type === 'GPS_PING') {
          const state        = courierState[ws.courierId];
          const currentPoint = turf.point([data.lon, data.lat]);
          const speed        = data.currentSpeed ?? 0;

          // 1. Cache position and broadcast to all connected frontend tabs for this courier
          const telemetryPayload = { id: ws.courierId, lat: data.lat, lng: data.lon, speed, routeStatus: 'on-time' };
          courierState[ws.courierId].lastPosition = telemetryPayload;
          wss.clients.forEach((client) => {
            if (client.readyState !== 1) return;
            if (client.role === 'courier' && client.courierId === ws.courierId) {
              client.send(JSON.stringify({ type: 'VEHICLE_TELEMETRY', payload: telemetryPayload }));
            }
          });

          if (state.lastPoint) {
            const distanceKM = turf.distance(state.lastPoint, currentPoint, { units: 'kilometers' });
            state.accumulatedDistanceKM += distanceKM;

            // 2. Predictive traffic check: Map accurately 5km down the specific scheduled route
            let aheadLat = currentPoint.geometry.coordinates[1];
            let aheadLon = currentPoint.geometry.coordinates[0];

            if (state.activeGeoJSON && state.activeGeoJSON.coordinates?.length) {
              try {
                const routeLine = turf.lineString(state.activeGeoJSON.coordinates);
                const snappedPoint = turf.nearestPointOnLine(routeLine, currentPoint);
                const travelledSlice = turf.lineSlice(routeLine.geometry.coordinates[0], snappedPoint, routeLine);
                const distanceTravelled = turf.length(travelledSlice, { units: 'kilometers' });
                
                const targetDistance = distanceTravelled + 5.0; // 5km ahead purely on road layout
                
                // If route remaining is less than 5km, turf.along caps exactly at the destination end point
                const aheadPoint = turf.along(routeLine, targetDistance, { units: 'kilometers' });
                aheadLat = aheadPoint.geometry.coordinates[1];
                aheadLon = aheadPoint.geometry.coordinates[0];
              } catch (e) {
                console.error("Error spanning 5km ahead on explicit route trace, falling back to radial span:", e);
                const heading    = turf.bearing(state.lastPoint, currentPoint);
                const aheadPoint = turf.destination(currentPoint, 5, heading, { units: 'kilometers' });
                aheadLat   = aheadPoint.geometry.coordinates[1];
                aheadLon   = aheadPoint.geometry.coordinates[0];
              }
            } else {
              const heading    = turf.bearing(state.lastPoint, currentPoint);
              const aheadPoint = turf.destination(currentPoint, 5, heading, { units: 'kilometers' });
              aheadLat   = aheadPoint.geometry.coordinates[1];
              aheadLon   = aheadPoint.geometry.coordinates[0];
            }

            const env = await fetchEnvironment(aheadLat, aheadLon);

            if (['high', 'congested'].includes(env.traffic_level)) {
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
                    event_type:          'TRAFFIC_ALERT',
                    manifest_id:         stopsResult.rows[0].manifest_id,
                    courier_id:          ws.courierId,
                    courier_status:      'EN_ROUTE',
                    vehicle_type:        (ws.vehicleType || 'van').toLowerCase(),
                    current_location:    { lat: data.lat, lon: data.lon, timestamp: new Date().toISOString() },
                    environment_horizon: { ...env, incident_reported: true },
                    unvisited_stops:     buildStops(stopsResult.rows, env.road_type),
                  }));
                  console.log(`[TRAFFIC ALERT] 5km-ahead congestion for ${ws.courierId} (${env.traffic_level})`);
                }
              } catch (alertErr) { console.error('Ahead-traffic alert error:', alertErr); }
            }

            // 3. Telemetry stream log every 1 km (for analytics)
            if (state.accumulatedDistanceKM >= 1.0) {
              const timeS  = (Date.now() - state.segmentStartTime) / 1000;
              let avgSpeed = state.accumulatedDistanceKM / (timeS / 3600);
              if (data.currentSpeed !== undefined && data.currentSpeed !== null) {
                avgSpeed = data.currentSpeed;
              }

              await pubClient.xadd(
                'telemetry_stream', '*',
                'courier_id',    ws.courierId,
                'segment_id',    data.segment_id || 1,
                'entry_time',    new Date(state.segmentStartTime).toISOString(),
                'exit_time',     new Date().toISOString(),
                'average_speed', avgSpeed.toFixed(2),
                'distance_km',   state.accumulatedDistanceKM.toFixed(2)
              );

              state.accumulatedDistanceKM = 0;
              state.segmentStartTime      = Date.now();
            }
          } else {
            state.segmentStartTime = Date.now();
          }

          state.lastPoint = currentPoint;
        }

        // ------------------------------------------------------------------
        // STOP REACHED — mark delivery complete in DB and notify frontend
        // ------------------------------------------------------------------
        if (ws.role === 'courier' && data.type === 'STOP_REACHED') {
          const stopId = data.stop_id;
          try {
            await db.query(
              'UPDATE manifest_stops SET delivery_status = $1 WHERE stop_id = $2',
              ['DELIVERED', stopId]
            );
            wss.clients.forEach((client) => {
              if (client.readyState !== 1) return;
              if (client.role === 'courier' && client.courierId === ws.courierId) {
                client.send(JSON.stringify({
                  type:    'DELIVERY_COMPLETED',
                  payload: { deliveryId: `STOP-${stopId}` },
                }));
              }
            });
            console.log(`[DELIVERY] Stop ${stopId} marked DELIVERED for ${ws.courierId}`);

            // Check if all stops are now delivered
            const remaining = await db.query(
              `SELECT COUNT(*) FROM manifest_stops ms
               JOIN daily_manifest dm ON ms.manifest_id = dm.manifest_id
               WHERE dm.courier_id = $1 AND ms.delivery_status = 'PENDING'`,
              [ws.courierId]
            );
            if (parseInt(remaining.rows[0].count, 10) === 0) {
              await db.query(
                `UPDATE daily_manifest SET status = 'COMPLETED' WHERE courier_id = $1`,
                [ws.courierId]
              );
              if (courierState[ws.courierId]?.healthCheckInterval) {
                clearInterval(courierState[ws.courierId].healthCheckInterval);
                courierState[ws.courierId].healthCheckInterval = null;
              }
              wss.clients.forEach((client) => {
                if (client.readyState !== 1) return;
                if (client.role === 'courier' && client.courierId === ws.courierId) {
                  client.send(JSON.stringify({ type: 'MANIFEST_COMPLETED' }));
                }
              });
              console.log(`[MANIFEST] All stops delivered for ${ws.courierId}. Demo complete.`);
            }
          } catch (err) { console.error('Error marking stop delivered:', err); }
        }

        // ------------------------------------------------------------------
        // ROUTE APPROVAL — courier approves AI recommendation
        // ------------------------------------------------------------------
        if (data.type === 'APPROVE_ROUTE') {
          const { routeId, recId, recommendedStopsOrder } = data.payload || {};

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
            ws.send(JSON.stringify({ type: 'ROUTE_SYNC_CONFIRMED', payload: { id: recId, status: 'Applied' } }));
            
            wss.clients.forEach((client) => {
              if (client.readyState === 1 && client.role === 'courier' && client.courierId === ws.courierId) {
                client.send(JSON.stringify({ type: 'SIMULATOR_RESEQUENCE', payload: recommendedStopsOrder }));
              }
            });

            // Apply the deferred route update now that the user has approved
            const pendingGeoJSON = courierState[ws.courierId]?.pendingRouteGeoJSON;
            if (pendingGeoJSON) {
              wss.clients.forEach((client) => {
                if (client.readyState === 1 && client.role === 'courier' && client.courierId === ws.courierId) {
                  client.send(JSON.stringify({ type: 'ACTIVE_ROUTE_UPDATE', payload: pendingGeoJSON }));
                }
              });
              courierState[ws.courierId].pendingRouteGeoJSON = null;
            }
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
          if (courierState[ws.courierId]) {
            courierState[ws.courierId].pendingRouteGeoJSON = null;
          }
          ws.send(JSON.stringify({ type: 'ROUTE_SYNC_CONFIRMED', payload: { id: data.payload?.id, status: 'removed' } }));
        }

      } catch (err) {
        console.error('Error handling WebSocket message', err);
      }
    });

    ws.on('close', () => {
      if (ws.role === 'courier' && ws.courierId && courierState[ws.courierId]?.healthCheckInterval) {
        clearInterval(courierState[ws.courierId].healthCheckInterval);
        courierState[ws.courierId].healthCheckInterval = null;
      }
    });
  });
}

function resetCourierState(courierId) {
  if (courierState[courierId]?.healthCheckInterval) {
    clearInterval(courierState[courierId].healthCheckInterval);
  }
  courierState[courierId] = {
    lastPoint: null,
    lastPosition: null,
    accumulatedDistanceKM: 0,
    segmentStartTime: Date.now(),
    activeGeoJSON: null,
    healthCheckInterval: null,
    pendingRouteGeoJSON: null,
  };
}

module.exports = { setupWebSocket, resetCourierState };
