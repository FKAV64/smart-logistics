import React, { useEffect } from 'react';
import MapLayer from '../components/MapLayer';
import ProfileHeader from '../components/ProfileHeader';
import DeliveryList from '../components/DeliveryList';
import ActionCard from '../components/ActionCard';
import { useTelemetry } from '../hooks/useTelemetry';
import { useCourierStore } from '../store/useCourierStore';
import { Power, PowerOff, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import './CourierDashboard.css';

const CourierDashboard = () => {
  // Extract our new JSON-based sender method and the connection state
  const { sendMessage, isConnected } = useTelemetry();
  const {
    deliveries,
    pendingRecommendations,
    isOnBreak,
    toggleBreak,
    logout,
    user
  } = useCourierStore();
  const navigate = useNavigate();

  // ROUTINE HEALTH CHECK: Fetch manifest when socket securely opens
  useEffect(() => {
    // Only fire if the socket has explicitly triggered ws.onopen
    if (isConnected) {
      const courierId = user?.id || 'DRV-884'; // Fallback for MVP testing
      console.log(`Connection established. Requesting manifest for: ${courierId}`);

      sendMessage({
        type: 'GET_DAILY_MANIFEST',
        courierId: courierId
      });
    }
  }, [isConnected, user, sendMessage]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="courier-page">
      {/* Background Map */}
      <div className="map-view-container">
        <MapLayer />
      </div>

      {/* Left-Side Message Box Overlay */}
      {!isOnBreak && pendingRecommendations.length > 0 && (
        <div className="left-alerts-panel">
          <div className="alerts-stack">
            {pendingRecommendations.map(rec => (
              <ActionCard key={rec.id} recommendation={rec} />
            ))}
          </div>
        </div>
      )}

      {/* Glassmorphic Sidebar (Right) */}
      <aside className={`courier-sidebar ${isOnBreak ? 'sidebar-muted' : ''}`}>
        <div className="sidebar-inner">
          <ProfileHeader />

          <div className="sidebar-actions">
            <button
              className={`action-pill ${isOnBreak ? 'break-active' : ''}`}
              onClick={() => {
                const newBreakState = !isOnBreak;
                toggleBreak();
                // Updated to pure JSON messaging format
                sendMessage({
                  type: 'TOGGLE_BREAK',
                  payload: { isOnBreak: newBreakState }
                });
              }}
            >
              {isOnBreak ? <PowerOff size={16} /> : <Power size={16} />}
              <span>{isOnBreak ? 'END BREAK' : 'TAKE BREAK'}</span>
            </button>

            <button className="action-pill logout-pill" onClick={handleLogout} title="Logout">
              <LogOut size={16} />
              <span>LOGOUT</span>
            </button>
          </div>

          <div className="sidebar-content">
            {isOnBreak ? (
              <div className="break-overlay">
                <div className="break-icon">☕</div>
                <h2>On Break</h2>
                <p>Telemetry is paused.</p>
              </div>
            ) : (
              <div className="main-list-area">
                <DeliveryList deliveries={deliveries} />
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
};

export default CourierDashboard;