const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: 'postgresql://postgres:password@localhost:5433/smart_logistics'
});

async function runSeed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Seeding Couriers...');
    await client.query(`
      INSERT INTO couriers (courier_id, first_name, last_name, phone, vehicle_type, hire_date)
      VALUES 
        ('DRV-884', 'John', 'Doe', '+15551234567', 'Box Truck', '2023-01-15'),
        ('DRV-992', 'Jane', 'Smith', '+15559876543', 'Bicycle', '2023-05-20')
      ON CONFLICT DO NOTHING;
    `);

    console.log('Seeding Routes...');
    await client.query(`
      INSERT INTO routes (route_id, courier_id, date, shift_start, shift_end, status)
      VALUES 
        (1, 'DRV-884', CURRENT_DATE, CURRENT_DATE + interval '8 hours', CURRENT_DATE + interval '16 hours', 'IN_TRANSIT'),
        (2, 'DRV-992', CURRENT_DATE, CURRENT_DATE + interval '9 hours', CURRENT_DATE + interval '17 hours', 'PLANNED')
      ON CONFLICT DO NOTHING;
    `);

    console.log('Seeding Stops...');
    await client.query(`
      INSERT INTO stops (stop_id, route_id, client_customer_id, lat, lon, window_start, window_end, stop_order)
      VALUES 
        (1, 1, 'CUST-A123', 40.7128, -74.0060, CURRENT_DATE + interval '9 hours', CURRENT_DATE + interval '10 hours', 1),
        (2, 1, 'CUST-B456', 40.7138, -74.0070, CURRENT_DATE + interval '10 hours', CURRENT_DATE + interval '11 hours', 2),
        (3, 1, 'CUST-C789', 40.7148, -74.0080, CURRENT_DATE + interval '11 hours', CURRENT_DATE + interval '12 hours', 3)
      ON CONFLICT DO NOTHING;
    `);

    console.log('Seeding Segments...');
    // A simple straight line from (40.7128, -74.0060) to (40.7138, -74.0060)
    await client.query(`
      INSERT INTO segments (segment_id, name, start_lat, start_lon, end_lat, end_lon, geom)
      VALUES 
        (1, 'Broadway - Segment 1', 40.7128, -74.0060, 40.7138, -74.0060, ST_GeomFromText('LINESTRING(-74.0060 40.7128, -74.0060 40.7138)', 4326)),
        (2, 'Broadway - Segment 2', 40.7138, -74.0060, 40.7148, -74.0060, ST_GeomFromText('LINESTRING(-74.0060 40.7138, -74.0060 40.7148)', 4326))
      ON CONFLICT DO NOTHING;
    `);

    console.log('Seeding Completed Succesfully!');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error seeding data:', err);
  } finally {
    client.release();
    pool.end();
  }
}

runSeed();
