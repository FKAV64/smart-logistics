import { create } from 'zustand';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export const useCourierStore = create((set) => ({
  vehicles: [], // Array of objects (id, lat, lng, speed, lastPingTimestamp)
  activeRoutes: [], // Array of GeoJSON objects representing the current path for each vehicle
  pendingRecommendations: [], // Array of actionable alerts sent by the AI
  hoveredRecommendationId: null, // Track hovered alert to show proposed route
  isOnBreak: false,
  user: null, // { id: 'D01', name: 'John Doe', profileImage: null }
  isAuthenticated: false,
  deliveries: [], // Populated via DAILY_MANIFEST_LOADED WebSocket event on login
  activeDeliveryId: null,
  completedDeliveryIds: [],




  // Actions
  updateVehicleTelemetry: (telemetryData) =>
    set((state) => {
      const existingVehicleIndex = state.vehicles.findIndex((v) => v.id === telemetryData.id);
      if (existingVehicleIndex >= 0) {
        const updatedVehicles = [...state.vehicles];
        updatedVehicles[existingVehicleIndex] = {
          ...updatedVehicles[existingVehicleIndex],
          ...telemetryData,
          lastPingTimestamp: Date.now(),
        };
        return { vehicles: updatedVehicles };
      } else {
        return {
          vehicles: [...state.vehicles, { ...telemetryData, lastPingTimestamp: Date.now() }],
        };
      }
    }),

  addRecommendation: (suggestionPayload) =>
    set((state) => {
      // Rule of Uniqueness: replace old card for the same vehicle
      const filtered = state.pendingRecommendations.filter(
        (rec) => rec.vehicleId !== suggestionPayload.vehicleId
      );

      // Reorder the delivery list if Brain provided an optimized sequence
      let deliveries = state.deliveries;
      if (suggestionPayload.new_sequence?.length > 0) {
        const orderMap = {};
        suggestionPayload.new_sequence.forEach((stopId, idx) => {
          orderMap[String(stopId)] = idx;
        });
        deliveries = [...state.deliveries].sort((a, b) =>
          (orderMap[String(a.id)] ?? 999) - (orderMap[String(b.id)] ?? 999)
        );
      }

      return {
        deliveries,
        pendingRecommendations: [...filtered, { ...suggestionPayload, status: 'pending' }],
      };
    }),

  setRecommendationSyncing: (recommendationId) =>
    set((state) => ({
      pendingRecommendations: state.pendingRecommendations.map((rec) =>
        rec.id === recommendationId ? { ...rec, status: 'Syncing...' } : rec
      ),
    })),

  confirmRecommendationSync: (recommendationId, status) =>
    set((state) => {
      if (status === 'removed') {
        return {
          pendingRecommendations: state.pendingRecommendations.filter(
            (rec) => rec.id !== recommendationId
          ),
        };
      }
      return {
        pendingRecommendations: state.pendingRecommendations.map((rec) =>
          rec.id === recommendationId ? { ...rec, status: status === 'Sent' ? 'Sent' : 'Applied' } : rec
        ),
      };
    }),

  removeRecommendation: (id) =>
    set((state) => ({
      pendingRecommendations: state.pendingRecommendations.filter((rec) => rec.id !== id),
    })),



  setActiveRoutes: (routes) => set({ activeRoutes: routes }),

  setHoveredRecommendation: (recommendationId) =>
    set({ hoveredRecommendationId: recommendationId }),

  toggleBreak: () => set((state) => ({ isOnBreak: !state.isOnBreak })),

  // Auth Actions
  login: async (email, password) => {


      const res = await fetch(`${API_BASE_URL}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();

      if (!res.ok) {
        return { success: false, message: data.message || 'Login failed' };
      }

      localStorage.setItem('token', data.token);

      set({ user: data.user, isAuthenticated: true });
      return { success: true };

    } catch (err) {
      return { success: false, message: 'Network Error' };
    }
  },

  updateProfileImage: (imageData) =>
    set((state) => ({
      user: state.user ? { ...state.user, profileImage: imageData } : null
    })),

  setDeliveries: (deliveries) => set({ deliveries }),

  setActiveDelivery: (id) => set({ activeDeliveryId: id }),

  markDeliveryCompleted: (id) =>
    set((state) => ({
      completedDeliveryIds: [...new Set([...state.completedDeliveryIds, id])],
      activeDeliveryId: state.activeDeliveryId === id ? null : state.activeDeliveryId,
    })),

  updateUser: (userData) =>
    set((state) => ({
      user: state.user ? { ...state.user, ...userData } : userData
    })),

  logout: () => {
    localStorage.removeItem('token');
    set({ user: null, isAuthenticated: false });
  },
}));