import { create } from 'zustand';

export const useCourierStore = create((set) => ({
  vehicles: [], // Array of objects (id, lat, lng, speed, lastPingTimestamp)
  activeRoutes: [], // Array of GeoJSON objects representing the current path for each vehicle
  pendingRecommendations: [], // Array of actionable alerts sent by the AI
  hoveredRecommendationId: null, // Track hovered alert to show proposed route
  isOnBreak: false,
  user: null, // { id: 'admin', role: 'admin', name: 'Admin User', profileImage: null }
  isAuthenticated: false,
  deliveries: [], // Populated via DAILY_MANIFEST_LOADED WebSocket event on login
  activeDeliveryId: null,
  completedDeliveryIds: [],

  // Admin Data
  couriers: [
    { id: 'D01', name: 'John Sivas', phone: '+90 555 123 4567', vehicleId: 'vehicle-1' },
    { id: 'D02', name: 'Ayşe Kaya', phone: '+90 555 987 6543', vehicleId: 'vehicle-2' },
    { id: 'D03', name: 'Mehmet Demir', phone: '+90 555 456 7890', vehicleId: 'vehicle-3' }
  ],
  stats: {
    totalActiveVehicles: 15,
    solvedAlertsToday: 42,
    systemPerformance: '98.5%'
  },


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

  // Courier Management Actions
  addCourier: (newCourier) =>
    set((state) => ({
      couriers: [newCourier, ...state.couriers],
      stats: {
        ...state.stats,
        totalActiveVehicles: state.stats.totalActiveVehicles + 1
      }
    })),

  deleteCourier: (id) =>
    set((state) => ({
      couriers: state.couriers.filter(d => d.id !== id),
      stats: {
        ...state.stats,
        totalActiveVehicles: Math.max(0, state.stats.totalActiveVehicles - 1)
      }
    })),

  setActiveRoutes: (routes) => set({ activeRoutes: routes }),

  setHoveredRecommendation: (recommendationId) =>
    set({ hoveredRecommendationId: recommendationId }),

  toggleBreak: () => set((state) => ({ isOnBreak: !state.isOnBreak })),

  // Auth Actions
  login: async (email, password) => {
    if (email === 'admin' && password === 'admin123') {
      set({ user: { id: 'admin', role: 'admin', name: 'System Admin', profileImage: null }, isAuthenticated: true });
      return { success: true, role: 'admin' };
    }

    try {
      const res = await fetch('http://localhost:3000/login', {
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

      // Default to 'courier' since roles are no longer in the DB
      const assignedRole = data.role || (data.user && data.user.role) || 'courier';
      const completeUser = { ...data.user, role: assignedRole };

      set({ user: completeUser, isAuthenticated: true });
      return { success: true, role: assignedRole };

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