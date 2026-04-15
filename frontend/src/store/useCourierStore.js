import { create } from 'zustand';

export const useCourierStore = create((set) => ({
  vehicles: [], // Array of objects (id, lat, lng, speed, lastPingTimestamp)
  activeRoutes: [], // Array of GeoJSON objects representing the current path for each vehicle
  pendingRecommendations: [], // Array of actionable alerts sent by the AI
  hoveredRecommendationId: null, // Track hovered alert to show proposed route
  isOnBreak: false, 
  user: null, // { id: 'admin', role: 'admin', name: 'Admin User', profileImage: null }
  isAuthenticated: false,
  deliveries: [
    { id: 'D001', time: '14:30', destination: 'Sivas Main Blvd, No: 42', clientNumber: '+90 555 001 1122', urgency: 1 },
    { id: 'D002', time: '15:15', destination: 'Emniyet Cd., Sivas Central', clientNumber: '+90 555 002 2233', urgency: 2 },
    { id: 'D003', time: '16:00', destination: 'Cumhuriyet Sq, Market Street', clientNumber: '+90 555 003 3344', urgency: 3 },
    { id: 'D004', time: '16:45', destination: 'Atatürk Blvd, High School Area', clientNumber: '+90 555 004 4455', urgency: 1 },
    { id: 'D005', time: '17:30', destination: 'İnönü Cd., Hospital District', clientNumber: '+90 555 005 5566', urgency: 2 },
    { id: 'D006', time: '18:15', destination: 'Fevzi Çakmak Cd., Sivas Mall', clientNumber: '+90 555 006 6677', urgency: 3 },
  ],
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
      return {
        pendingRecommendations: [...filtered, suggestionPayload],
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
  login: (username, password) => {
    // Simple mock authentication logic
    if (username === 'admin' && password === 'admin123') {
      set({ user: { id: 'admin', role: 'admin', name: 'System Admin', profileImage: null }, isAuthenticated: true });
      return { success: true, role: 'admin' };
    } else if (username === 'courier' && password === 'password') {
      set({ user: { id: 'D01', role: 'courier', name: 'John Sivas', profileImage: null }, isAuthenticated: true });
      return { success: true, role: 'courier' };
    }
    return { success: false, message: 'Invalid credentials' };
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

  logout: () => set({ user: null, isAuthenticated: false }),
}));
