const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URI || 'postgresql://postgres:password@localhost:5433/smart_logistics',
  max: 20, // Keep direct DB connections sparse
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
