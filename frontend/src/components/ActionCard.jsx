import { useEffect, useState } from 'react';
import { useCourierStore } from '../store/useCourierStore';
import { useTelemetry } from '../hooks/useTelemetry';
import { Clock, AlertTriangle, Route as RouteIcon, CheckCircle, RotateCw, Phone, Mail } from 'lucide-react';
import './ActionCard.css';

const ActionCard = ({ recommendation }) => {
  const { 
    id, 
    vehicleId, 
    severity, 
    reason, 
    impact, 
    action_type, 
    status, 
    estimatedViolationTime 
  } = recommendation;

  const { sendMessage } = useTelemetry();

  const { setHoveredRecommendation, setRecommendationSyncing, removeRecommendation, vehicles } = useCourierStore();
  
  const vehicle = vehicles.find(v => v.id === vehicleId);
  const routeStatus = vehicle?.routeStatus || 'on-time';
  
  const [slackTimeStr, setSlackTimeStr] = useState('');

  useEffect(() => {
    if (!estimatedViolationTime) return;
    const interval = setInterval(() => {
      const remainingMs = estimatedViolationTime - Date.now();
      if (remainingMs <= 0) {
        setSlackTimeStr('00:00 (VIOLATED)');
      } else {
        const mins = Math.floor(remainingMs / 60000);
        const secs = Math.floor((remainingMs % 60000) / 1000);
        setSlackTimeStr(`${mins}:${secs.toString().padStart(2, '0')}`);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [estimatedViolationTime]);

  const handleHoverEnter = () => setHoveredRecommendation(id);
  const handleHoverLeave = () => setHoveredRecommendation(null);

  // Auto-remove applied cards after delay
  useEffect(() => {
    if (status === 'Applied') {
      const timer = setTimeout(() => {
        removeRecommendation(id);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [status, id, removeRecommendation]);

  const handleApprove = () => {
    if (status) return; 
    setRecommendationSyncing(id);
    sendMessage({ type: 'APPROVE_ROUTE', payload: { id } });
  };

  const handleRefuse = () => {
    if (status) return; 
    setRecommendationSyncing(id); 
    sendMessage({ type: 'REFUSE_ROUTE', payload: { id } });
  };

  const getStatusClass = () => {
    switch (routeStatus) {
      case 'on-time': return 'status-on-time';
      case 'reroute': return 'status-reroute';
      case 'critical': return 'status-critical';
      case 'info': return 'status-info';
      default: return 'status-on-time';
    }
  };

  const getLabel = () => {
    switch (routeStatus) {
      case 'on-time': return 'NORMAL';
      case 'reroute': return 'REROUTE';
      case 'critical': return 'CRITICAL';
      case 'info': return 'INFO';
      default: return 'NORMAL';
    }
  };

  return (
    <div 
      className={`action-card ${getStatusClass()} ${routeStatus === 'reroute' ? 'card-expanded' : ''}`}
      onMouseEnter={handleHoverEnter}
      onMouseLeave={handleHoverLeave}
    >
      <div className="card-header">
        <h3 className="vehicle-id">System Update</h3>
        <span className="severity-badge">{getLabel()}</span>
      </div>

      <div className="card-body">
        {/* Context comes directly from Node.js (reason field) */}
        <p className="reason-text"><strong>Context:</strong> {reason}</p>
        
        {impact && (
          <div className="impact-grid">
            <div className="impact-item">
              <RouteIcon size={16} />
              <span>Health: {impact.route_health}</span>
            </div>
            <div className="impact-item">
              <Clock size={16} />
              <span>Saves {impact.time_saved_minutes} mins</span>
            </div>
          </div>
        )}

        {routeStatus === 'critical' && (
          <div className="constraint-box">
            <AlertTriangle size={16} />
            <span className="slack-time">DELAY INEVITABLE</span>
          </div>
        )}
      </div>

      <div className="card-footer">
        {routeStatus === 'critical' ? (
          <button 
            className={`btn ${status === 'Sent' ? 'btn-success' : status === 'Syncing...' ? 'btn-warning' : 'btn-danger'}`} 
            onClick={() => {
              if (status) return;
              setRecommendationSyncing(id);
              sendMessage({ type: 'SEND_EMAIL', payload: { id, vehicleId } });
            }}
            disabled={!!status}
          >
            {status === 'Sent' ? (
               <><CheckCircle size={16} /> SENT!</>
            ) : status === 'Syncing...' ? (
               <><RotateCw size={16} className="spin" /> SENDING...</>
            ) : (
               <><Mail size={16} /> SEND EMAIL</>
            )}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
            <button 
              className={`btn ${status === 'Applied' ? 'btn-success' : status === 'Syncing...' ? 'btn-warning' : 'btn-primary'}`}
              style={{ flex: 1 }}
              onClick={handleApprove}
              disabled={!!status}
            >
              {status === 'Applied' ? (
                <><CheckCircle size={16} /> Applied</>
              ) : status === 'Syncing...' ? (
                <><RotateCw size={16} className="spin" /> Syncing</>
              ) : (
                'Approve Swap'
              )}
            </button>
            <button 
              className="btn btn-danger"
              style={{ flex: 1, display: status ? 'none' : 'flex' }}
              onClick={handleRefuse}
              disabled={!!status}
            >
              Refuse
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ActionCard;
