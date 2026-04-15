import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { useCourierStore } from '../store/useCourierStore';

// We can pass a specific URL using environment variables, but for now we default to a standard local Node.js port.
const SOCKET_URL = import.meta.env.VITE_WEBSOCKET_URL || 'http://localhost:3000';

// Export the socket instance so other components (like ActionCard) can manually emit events
export const socket = io(SOCKET_URL, {
  transports: ['websocket'],
  autoConnect: false,
});

export const useTelemetry = () => {
  const {
    updateVehicleTelemetry,
    addRecommendation,
    confirmRecommendationSync,
    setDeliveries,
    markDeliveryCompleted,
    setActiveDelivery,
    updateUser,
  } = useCourierStore();

  useEffect(() => {
    // Establish the persistent WebSocket connection when the hook mounts
    socket.connect();

    const onConnect = () => console.log('Connected to SMART LOGISTICS Courier Gateway');
    const onDisconnect = () => console.log('Disconnected from SMART LOGISTICS Courier Gateway');
    
    // On telemetry_update: Update the vehicles state with new coordinates
    const onTelemetryUpdate = (data) => updateVehicleTelemetry(data);
    
    // On new_route_suggestion: Push the payload to pendingRecommendations
    const onNewRouteSuggestion = (payload) => addRecommendation(payload);
    
    // On sync_confirmation: Update the specific recommendation's status to "Applied"
    const onSyncConfirmation = (data) => {
      if (data && data.id) {
        confirmRecommendationSync(data.id, data.status);
      }
    };

    const onDailyDeliveries = (data) => {
      if (Array.isArray(data)) {
        setDeliveries(data);
        // Set the first delivery as active if none is active
        const sorted = [...data].sort((a, b) => {
           const timeA = a.time.split(':').map(Number);
           const timeB = b.time.split(':').map(Number);
           return (timeA[0] * 60 + timeA[1]) - (timeB[0] * 60 + timeB[1]);
        });
        if (sorted.length > 0) setActiveDelivery(sorted[0].id);
      }
    };

    const onDeliveryCompleted = (data) => {
      if (data && data.id) {
        markDeliveryCompleted(data.id);
      }
    };

    const onNextDelivery = (data) => {
      if (data && data.id) {
        setActiveDelivery(data.id);
      }
    }

    const onUserProfile = (data) => {
      if (data) {
        updateUser(data);
      }
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('telemetry_update', onTelemetryUpdate);
    socket.on('new_route_suggestion', onNewRouteSuggestion);
    socket.on('sync_confirmation', onSyncConfirmation);
    socket.on('daily_deliveries', onDailyDeliveries);
    socket.on('delivery_completed', onDeliveryCompleted);
    socket.on('next_delivery', onNextDelivery);
    socket.on('user_profile', onUserProfile);

    // Cleanup listeners on unmount so we don't duplicate them
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('telemetry_update', onTelemetryUpdate);
      socket.off('new_route_suggestion', onNewRouteSuggestion);
      socket.off('sync_confirmation', onSyncConfirmation);
      socket.off('daily_deliveries', onDailyDeliveries);
      socket.off('delivery_completed', onDeliveryCompleted);
      socket.off('next_delivery', onNextDelivery);
      socket.off('user_profile', onUserProfile);
    };
  }, [updateVehicleTelemetry, addRecommendation, confirmRecommendationSync, setDeliveries, markDeliveryCompleted, setActiveDelivery, updateUser]);
};
