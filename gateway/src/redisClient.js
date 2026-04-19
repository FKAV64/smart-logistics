const Redis = require('ioredis');
const EventEmitter = require('events');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// One connection for publishing, one for subscribing
const pubClient = new Redis(redisUrl);
const subClient = new Redis(redisUrl);

const aiEvents = new EventEmitter();

subClient.subscribe('route_optimizations_channel', (err, count) => {
  if (err) {
    console.error('Failed to subscribe: %s', err.message);
  } else {
    console.log(`Subscribed successfully! Currently subscribed to ${count} channels.`);
  }
});

subClient.on('message', (channel, message) => {
  if (channel === 'route_optimizations_channel') {
    try {
      const data = JSON.parse(message);
      // Emit event for gateway to forward to courier
      aiEvents.emit('optimization_received', data);
    } catch (e) {
      console.error('Error parsing route optimization message from AI', e);
    }
  }
});

module.exports = {
  pubClient,
  aiEvents
};
