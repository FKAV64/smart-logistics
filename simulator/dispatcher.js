const WebSocket = require('ws');

// Connect to the Gateway WebSockets on port 3000
const ws = new WebSocket('ws://127.0.0.1:3000/?role=DISPATCHER');

ws.on('open', () => {
  console.log('[Dispatcher] Connected to Gateway securely.');
  console.log('[Dispatcher] Waiting for AI Route Recommendations...');
});

ws.on('message', (message) => {
  try {
    const data = JSON.parse(message);
    
    if (data.type === 'AI_ROUTE_RECOMMENDATION') {
      console.log('\n=============================================');
      console.log('🚨 [Dispatcher] AI ALERT RECEIVED 🚨');
      console.log('Reason:', data.payload.reason);
      console.log('Route ID:', data.payload.routeId);
      console.log('Recommended Order:', JSON.stringify(data.payload.recommendedStopsOrder));
      console.log('=============================================\n');
      
      console.log('[Dispatcher] Approving route automatically for test...');
      
      // Fire back exact structure expected by the Gateway
      ws.send(JSON.stringify({
        type: 'APPROVE_ROUTE',
        payload: {
          routeId: data.payload.routeId,
          recommendedStopsOrder: data.payload.recommendedStopsOrder
        }
      }));
    } else if (data.type === 'APPROVAL_SUCCESS') {
      console.log(`✅ [Dispatcher] Gateway confirmed route ${data.routeId} successfully updated in PostgreSQL!`);
    } else if (data.type === 'APPROVAL_ERROR') {
      console.error(`❌ [Dispatcher] Gateway failed to update route in Postgres:`, data.error);
    }
  } catch (err) {
    console.error('[Dispatcher] Error parsing message:', err);
  }
});

ws.on('close', () => {
  console.log('[Dispatcher] Disconnected from Gateway.');
});

ws.on('error', (err) => {
  console.error('[Dispatcher] Exact Error Details:', err.message);
  console.error('[Dispatcher] Connection Error. Is the Gateway running on port 3000?');
});
