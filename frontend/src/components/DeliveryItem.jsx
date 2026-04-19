import React from 'react';
import { Clock, MapPin, Phone, ShieldCheck, CheckCircle2, Navigation } from 'lucide-react';
import './DeliveryItem.css';

const DeliveryItem = ({ delivery, isActive, isCompleted }) => {
  const { time, timeEnd, destination, clientNumber, urgency, address } = delivery;

  const getUrgencyClass = () => {
    if (isCompleted) return 'status-completed';
    if (isActive) return 'status-active';
    
    switch (urgency) {
      case 1: return 'urgency-critical';
      case 2: return 'urgency-warning';
      default: return 'urgency-normal';
    }
  };

  const getStatusLabel = () => {
    if (isCompleted) return 'COMPLETED';
    if (isActive) return 'EN ROUTE';
    
    switch (urgency) {
      case 1: return 'CRITICAL';
      case 2: return 'WARNING';
      default: return 'NORMAL';
    }
  };

  return (
    <div className={`delivery-item ${getUrgencyClass()} ${isActive ? 'active-glow' : ''}`}>
      <div className="delivery-card-header">
        <div className="delivery-time-badge">
          {isCompleted ? <CheckCircle2 size={14} /> : isActive ? <Navigation size={14} className="spin-once" /> : <Clock size={14} />}
          <span>{time}{timeEnd ? ` – ${timeEnd}` : ''}</span>
        </div>
        <span className="urgency-label">{getStatusLabel()}</span>
      </div>

      <div className="delivery-card-body">
        <div className="delivery-detail">
          <MapPin size={16} className={isCompleted ? 'icon-dim' : 'icon-blue'} />
          <span className={`destination-text ${isCompleted ? 'text-dim' : ''}`}>{destination}</span>
        </div>
        {address && (
          <div className="delivery-detail">
            <Navigation size={16} className="icon-dim" />
            <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>{address}</span>
          </div>
        )}
        {!isCompleted && (
          <div className="delivery-detail">
            <Phone size={16} className="icon-green" />
            <a href={`tel:${clientNumber}`} className="phone-link">{clientNumber}</a>
          </div>
        )}
      </div>

      <div className="delivery-card-footer">
        <div className="ai-route-badge">
          <ShieldCheck size={14} />
          <span>{isCompleted ? 'Route Finished' : 'Optimal Route Calculated by AI'}</span>
        </div>
      </div>
    </div>
  );
};

export default DeliveryItem;
