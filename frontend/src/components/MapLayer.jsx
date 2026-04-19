import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, GeoJSON, Popup, FeatureGroup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCourierStore } from '../store/useCourierStore';
import './MapLayer.css';

const getVehicleStatusColor = (routeStatus) => {
  return routeStatus || 'on-time';
};

const createVehicleIcon = (status) => {
  const colorMap = {
    'on-time': '#10b981', // green (Emerald)
    'reroute': '#f59e0b', // yellow (Amber)
    'critical': '#ef4444', // red (Rose)
    'info': '#ec4899',    // pink
    'offline': '#6b7280'   // grey
  };
  
  const color = colorMap[status] || colorMap['offline'];
  const opacity = status === 'offline' ? 0.5 : 1;

  // Returning a local SVG icon using divIcon
  return L.divIcon({
    className: 'vehicle-marker-icon', // Handled in CSS
    html: `<div style="background-color: ${color}; opacity: ${opacity}; width: 24px; height: 24px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 10px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center;"><div style="background: white; border-radius: 50%; width: 6px; height: 6px;"></div></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
};

const createStopIcon = () => {
  return L.divIcon({
    className: 'stop-marker-icon',
    html: `
      <div style="filter: drop-shadow(0 4px 6px rgba(239, 68, 68, 0.5));">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="#ef4444" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
          <circle cx="12" cy="10" r="3" fill="white" stroke="none"></circle>
        </svg>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -34],
  });
};

const createCompletedStopIcon = () => L.divIcon({
  className: 'stop-marker-icon',
  html: `<div style="filter: drop-shadow(0 2px 4px rgba(107,114,128,0.4)); opacity: 0.45;">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="#6b7280" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
      <circle cx="12" cy="10" r="3" fill="white" stroke="none"></circle>
    </svg>
  </div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -34],
});

const MapLayer = () => {
  const { deliveries, vehicles, activeRoutes, pendingRecommendations, hoveredRecommendationId, completedDeliveryIds } = useCourierStore();
  
  // Timer to force re-render for ghosting logic (every 10s)
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(interval);
  }, []);

  // Find the hovered recommendation to extract its proposed route
  const hoveredRec = pendingRecommendations.find(r => r.id === hoveredRecommendationId);
  const proposedRouteCoords = hoveredRec?.proposedRouteRoutePoints || [];

  return (
    <MapContainer center={[39.7505, 37.0150]} zoom={12} className="map-container">
      {/* Dark modern map tile layer */}
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
      />

      {/* Render Delivery Stops — grey when completed */}
      {deliveries.map((stop) => {
        const isCompleted = completedDeliveryIds.includes(stop.id);
        return stop.lat && stop.lng && (
          <Marker
            key={stop.id}
            position={[stop.lat, stop.lng]}
            icon={isCompleted ? createCompletedStopIcon() : createStopIcon()}
          >
            <Popup>
              <strong>{stop.destination}</strong>
              {isCompleted && <span style={{ color: '#6b7280' }}> ✓ Delivered</span>}<br/>
              {stop.address && <span style={{ fontSize: '0.85em', opacity: 0.8 }}>{stop.address}</span>}<br/>
              {stop.clientNumber && <span>{stop.clientNumber}</span>}
            </Popup>
          </Marker>
        );
      })}

      {/* Render Active Routes */}
      {activeRoutes.map((routeData, index) => (
        <GeoJSON 
          key={`active-route-${Math.random()}`} // Force remount when data changes
          data={routeData} 
          style={{ color: '#3b82f6', weight: 4, opacity: 0.7 }} 
        />
      ))}

      {/* Render Proposed Route (Overlay, dashed) */}
      {hoveredRec?.route_geojson && (
        <GeoJSON 
          key={`proposed-route-${Math.random()}`}
          data={hoveredRec.route_geojson} 
          style={{ color: '#ef4444', weight: 4, dashArray: '10, 10' }} 
        />
      )}

      {/* Render Vehicles with Route Status Logic */}
      {vehicles.map((vehicle) => {
        const status = getVehicleStatusColor(vehicle.routeStatus);
        
        // Define color mapping inline for the line
        const colorMap = {
          'on-time': '#10b981',
          'reroute': '#f59e0b',
          'critical': '#ef4444',
          'info': '#ec4899',
          'offline': '#6b7280'
        };

        return (
          <FeatureGroup key={vehicle.id}>
            {/* Draw the road the vehicle is taking! */}
            {vehicle.currentRoute && (
              <Polyline 
                positions={vehicle.currentRoute}
                pathOptions={{ color: colorMap[status] || '#6b7280', weight: 5, opacity: 0.8 }}
              />
            )}
            <Marker 
              position={[vehicle.lat, vehicle.lng]} 
              icon={createVehicleIcon(status)}
            >
              <Popup>
                <strong>Vehicle ID:</strong> {vehicle.id}<br/>
                <strong>Status:</strong> {status.toUpperCase()}<br/>
                <strong>Speed:</strong> {vehicle.speed} km/h
              </Popup>
            </Marker>
          </FeatureGroup>
        );
      })}
    </MapContainer>
  );
};

export default MapLayer;
