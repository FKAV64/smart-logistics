import { useEffect, useState } from 'react';
import { useCourierStore } from '../store/useCourierStore';
import { Clock, AlertTriangle, Route as RouteIcon, CheckCircle, RotateCw, Mail } from 'lucide-react';
import './ActionCard.css';

const ActionCard = ({ recommendation, sendMessage }) => {
  const {
    id,
    vehicleId,
    severity,
    reason,
    impact,
    action_type,
    status,
    estimatedViolationTime,
  } = recommendation;

  const { setHoveredRecommendation, setRecommendationSyncing, confirmRecommendationSync, removeRecommendation } = useCourierStore();

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

  useEffect(() => {
    if (status === 'Applied') {
      const timer = setTimeout(() => removeRecommendation(id), 3000);
      return () => clearTimeout(timer);
    }
  }, [status, id, removeRecommendation]);

  const sevLower = (severity || '').toLowerCase().replace(/-/g, '');
  const isCritical = sevLower === 'critical';
  const isReroute  = action_type && action_type.toLowerCase() === 're-route'; // Fix: based on action_type, not severity

  const getStatusClass = () => {
    if (isCritical) return 'status-critical';
    if (isReroute) return 'status-reroute';
    if (sevLower === 'medium') return 'status-reroute';
    return 'status-on-time';
  };

  const getLabel = () => (severity || 'NORMAL').toUpperCase().replace(/-/g, '');

  const handleApprove = () => {
    if (status) return;
    setRecommendationSyncing(id);
    sendMessage({
      type: 'APPROVE_ROUTE',
      payload: {
        routeId: recommendation.manifest_id,
        recId:   id,
        recommendedStopsOrder: (recommendation.new_sequence || []).map((stopId, idx) => ({
          stop_id:    String(stopId),
          stop_order: idx + 1,
        })),
      },
    });
  };

  const handleRefuse = () => {
    if (status) return;
    removeRecommendation(id);
    sendMessage({ type: 'REFUSE_ROUTE', payload: { id } });
  };

  return (
    <div
      className={`action-card ${getStatusClass()} ${(isReroute || isCritical) ? 'card-expanded' : ''}`}
      onMouseEnter={handleHoverEnter}
      onMouseLeave={handleHoverLeave}
    >
      <div className="card-header">
        <h3 className="vehicle-id">System Update</h3>
        <span className="severity-badge">{action_type ? action_type.replace(/_/g, ' ') : getLabel()}</span>
      </div>

      <div className="card-body">
        <p className="reason-text"><strong>Context:</strong> {reason}</p>

        {recommendation.route_health && (
          <div className="impact-grid">
            <div className="impact-item">
              <RouteIcon size={16} />
              <span>Health: {recommendation.route_health === 'OPTIMAL' ? 'Optimal' : recommendation.route_health}</span>
            </div>
            <div className="impact-item">
              <Clock size={16} />
              <span>Saves {recommendation.time_saved_minutes || 0} mins</span>
            </div>
          </div>
        )}

        {isCritical && (
          <div className="constraint-box">
            <AlertTriangle size={16} />
            <span className="slack-time">
              {slackTimeStr ? slackTimeStr : 'DELAY INEVITABLE'}
            </span>
          </div>
        )}
      </div>

      <div className="card-footer">
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
              action_type === 'RE-ROUTE' ? 'Approve Swap' : 'Approve'
            )}
          </button>
          <button
            className="btn btn-danger"
            style={{ flex: 1, display: status ? 'none' : 'flex' }}
            onClick={handleRefuse}
          >
            Refuse
          </button>
        </div>
      </div>
    </div>
  );
};

export default ActionCard;
