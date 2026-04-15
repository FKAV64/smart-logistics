require('dotenv').config();
const Redis = require('ioredis');
const db = require('./db');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);

const STREAM_KEY = 'telemetry_stream';
const GROUP_NAME = 'db_writers';
const CONSUMER_NAME = `worker-${process.pid}`;

async function setupStream() {
  try {
    // Create the stream and consumer group if they don't exist
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '0', 'MKSTREAM');
    console.log(`Created consumer group ${GROUP_NAME} for stream ${STREAM_KEY}`);
  } catch (err) {
    if (err.message.includes('BUSYGROUP')) {
      console.log(`Consumer group ${GROUP_NAME} already exists.`);
    } else {
      console.error('Error creating consumer group:', err);
      process.exit(1);
    }
  }
}

async function processMessage(message) {
  const [messageId, fields] = message;
  
  // Cleanly parse fields array ['key1', 'val1', 'key2', 'val2'] into object
  const data = {};
  for (let i = 0; i < fields.length; i += 2) {
    data[fields[i]] = fields[i + 1];
  }

  console.log(`[Worker] Processing Telemetry ID: ${messageId} | Courier: ${data.courier_id} | Speed: ${data.average_speed}`);

  try {
    await db.query(
      `INSERT INTO segment_telemetry (segment_id, courier_id, entry_time, exit_time, average_speed)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        parseInt(data.segment_id, 10),
        data.courier_id,
        data.entry_time,
        data.exit_time,
        parseFloat(data.average_speed)
      ]
    );

    // Acknowledge the message so it's removed from pending list
    await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
  } catch (err) {
    console.error(`[Worker] Error inserting telemetry to DB (ID: ${messageId}):`, err.message);
    // Did not ack, so we can retry or handle in a dead-letter queue later
  }
}

async function listenForMessages() {
  console.log(`[Worker] Listening for messages on ${STREAM_KEY}...`);
  while (true) {
    try {
      // Listen for new messages, block for 5 seconds if none
      const results = await redis.xreadgroup(
        'GROUP', GROUP_NAME, CONSUMER_NAME,
        'COUNT', 10,
        'BLOCK', 5000,
        'STREAMS', STREAM_KEY,
        '>' // Read only new messages never delivered to other consumers
      );

      if (results) {
        const streamData = results[0]; // [streamName, messagesArray]
        const messages = streamData[1];

        for (const message of messages) {
          await processMessage(message);
        }
      }
    } catch (err) {
      console.error('[Worker] Stream Read Error:', err);
      await new Promise(resolve => setTimeout(resolve, 1000)); // sleep before retry
    }
  }
}

async function start() {
  await setupStream();
  listenForMessages();
}

start();
