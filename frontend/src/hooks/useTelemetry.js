import { useEffect, useRef, useState } from 'react';
import { useCourierStore } from '../store/useCourierStore';

//const API_BASE_URL = 'https://team-005.hackaton.sivas.edu.tr:3000';
//const SOCKET_URL = API_BASE_URL.replace(/^https/, 'wss');
// A blank string tells the browser to use the current host (the Vite server)
const API_BASE_URL = '';

// We point the socket to the /api proxy we just created
const SOCKET_URL = `wss://${window.location.host}/api`;

export const useTelemetry = () => {
  // NEW: State to track actual socket connection
  const [isConnected, setIsConnected] = useState(false);

  const {
    updateVehicleTelemetry,
    addRecommendation,
    confirmRecommendationSync,
    setDeliveries,
    markDeliveryCompleted,
    setActiveDelivery,
    updateUser,
    setActiveRoutes,
    user
  } = useCourierStore();

  const userId = user?.id;
  const wsRef = useRef(null);

  useEffect(() => {
    let reconnectTimeout;
    let isComponentMounted = true;

    const connectWebSocket = () => {
      const token = localStorage.getItem('token');

      const wsUrl = token
        ? `${SOCKET_URL}?token=${encodeURIComponent(token)}`
        : `${SOCKET_URL}?id=${userId}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Connected to SMART LOGISTICS Gateway (JWT Auth)');
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          switch (data.type) {
            case 'DAILY_MANIFEST_LOADED': {
              const fmt = (ts) =>
                ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
              const deliveries = data.payload.stops.map((stop) => ({
                id: `STOP-${stop.stop_id}`,
                lat: stop.latitude,
                lng: stop.longitude,
                time: fmt(stop.time_window_open),
                timeEnd: fmt(stop.time_window_close),
                destination: stop.client_first_name,
                clientNumber: stop.client_phone || '',
                address: stop.street_name || `${Number(stop.latitude).toFixed(4)}, ${Number(stop.longitude).toFixed(4)}`,
                urgency: stop.delivery_order,
              }));
              setDeliveries(deliveries);
              break;
            }
            case 'VEHICLE_TELEMETRY':
              updateVehicleTelemetry(data.payload);
              break;
            case 'AI_ROUTE_RECOMMENDATION':
              if (data.payload.action_type === 'CONTINUE') {
                // Brain says all clear — dismiss any stale alert card for this vehicle
                useCourierStore.getState().resolveRecommendationForVehicle(data.payload.vehicleId);
              } else {
                addRecommendation(data.payload);
              }
              break;
            case 'ROUTE_SYNC_CONFIRMED':
              confirmRecommendationSync(data.payload.id, data.payload.status);
              break;
            case 'DELIVERY_COMPLETED':
              markDeliveryCompleted(data.payload.deliveryId);
              break;
            case 'ACTIVE_ROUTE_UPDATE':
              console.log('[WS] Received ACTIVE_ROUTE_UPDATE:', data.payload);
              setActiveRoutes([data.payload]);
              break;
            default:
              console.log('[WS] Unhandled message type:', data.type);
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      ws.onclose = () => {
        console.log('Disconnected from Gateway.');
        setIsConnected(false); // TRIGGER: Socket closed
        if (isComponentMounted) {
          console.log('Attempting to reconnect in 3 seconds...');
          reconnectTimeout = setTimeout(connectWebSocket, 3000);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket Error:', error);
        ws.close();
      };
    };

    connectWebSocket();

    return () => {
      isComponentMounted = false;
      clearTimeout(reconnectTimeout);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [userId, updateVehicleTelemetry, addRecommendation, confirmRecommendationSync, setDeliveries, markDeliveryCompleted, setActiveDelivery, updateUser]);

  const sendMessage = (messageObj) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(messageObj));
    } else {
      console.warn('WebSocket is not open. Cannot send message:', messageObj);
    }
  };

  // Return the new boolean
  return { sendMessage, isConnected };
};