import { useEffect, useRef, useState } from 'react'; // Added useState
import { useCourierStore } from '../store/useCourierStore';

const HTTP_URL = import.meta.env.VITE_WEBSOCKET_URL || 'http://localhost:3000';
const SOCKET_URL = HTTP_URL.replace(/^http/, 'ws');

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
    user
  } = useCourierStore();

  const wsRef = useRef(null);

  useEffect(() => {
    let reconnectTimeout;
    let isComponentMounted = true;

    const connectWebSocket = () => {
      const courierId = user?.id || 'DRV-884';
      const ws = new WebSocket(`${SOCKET_URL}?role=COURIER&id=${courierId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Connected to SMART LOGISTICS Courier Gateway (Native WS)');
        setIsConnected(true); // TRIGGER: Socket is physically open
      };

      ws.onmessage = (event) => {
        // ... (Keep all your existing switch/case logic here)
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
  }, [updateVehicleTelemetry, addRecommendation, confirmRecommendationSync, setDeliveries, markDeliveryCompleted, setActiveDelivery, updateUser, user]);

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