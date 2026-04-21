import React from 'react';
import DeliveryItem from './DeliveryItem';
import { useCourierStore } from '../store/useCourierStore';
import './DeliveryList.css';

const DeliveryList = ({ deliveries }) => {
  const { activeDeliveryId, completedDeliveryIds } = useCourierStore();

  // Helper to parse "HH:MM" into minutes from midnight for sorting
  const timeToMinutes = (timeStr) => {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  };

  // Sort by time: Most urgent (earliest) first
  const sortedDeliveries = [...deliveries].sort((a, b) => {
    return timeToMinutes(a.time) - timeToMinutes(b.time);
  });

  console.info('Sorted Deliveries:', sortedDeliveries.map(d => `${d.id} (${d.time})`));

  return (
    <div className="delivery-list-container">
      <div className="list-header">
        <h3>Today's Deliveries</h3>
        <span className="count-badge">{deliveries.length} Total</span>
      </div>
      <div className="scrollable-list">
        {sortedDeliveries.map((delivery) => {
          const isActive = delivery.id === activeDeliveryId;
          const isCompleted = completedDeliveryIds.includes(delivery.id);
          
          return (
            <DeliveryItem 
              key={delivery.id} 
              delivery={delivery} 
              isActive={isActive}
              isCompleted={isCompleted}
            />
          );
        })}
      </div>
    </div>
  );
};

export default DeliveryList;
