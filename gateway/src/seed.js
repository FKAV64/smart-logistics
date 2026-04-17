const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:password@localhost:5433/smart_logistics'
});

async function runSeed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Seeding Clients...');
    await client.query(`
      INSERT INTO clients (client_id, first_name, last_name, email, phone)
      VALUES 
        ('CUST-A123', 'Alice', 'Anderson', 'alice@example.com', '+123456789'),
        ('CUST-B456', 'Bob', 'Brown', 'bob@example.com', '+987654321'),
        ('CUST-C789', 'Charlie', 'Chaplin', 'charlie@example.com', '+111222333')
      ON CONFLICT DO NOTHING;
    `);

    console.log('Seeding Couriers...');
    await client.query(`
      INSERT INTO couriers (courier_id, first_name, last_name, email, phone, vehicle_type, register_date)
      VALUES 
        ('DRV-884', 'John', 'Doe', 'john@example.com', '+15551234567', 'Box Truck', '2023-01-15'),
        ('DRV-992', 'Jane', 'Smith', 'jane@example.com', '+15559876543', 'Bicycle', '2023-05-20')
      ON CONFLICT DO NOTHING;
    `);

    console.log('Seeding Daily Manifests...');
    await client.query(`
      INSERT INTO daily_manifest (manifest_id, courier_id, date, status)
      VALUES 
        ('MAN-1', 'DRV-884', CURRENT_DATE, 'IN_TRANSIT'),
        ('MAN-2', 'DRV-992', CURRENT_DATE, 'PLANNED')
      ON CONFLICT DO NOTHING;
    `);

    console.log('Seeding Commande Details (Packages)...');
    await client.query(`
      INSERT INTO client_commande_detail (commande_id, client_id, weight_kg, window_start, window_end, lat, lon)
      VALUES 
        (1, 'CUST-A123', 5.5, CURRENT_DATE + interval '9 hours', CURRENT_DATE + interval '10 hours', 40.7128, -74.0060),
        (2, 'CUST-B456', 2.0, CURRENT_DATE + interval '10 hours', CURRENT_DATE + interval '11 hours', 40.7138, -74.0070),
        (3, 'CUST-C789', 15.0, CURRENT_DATE + interval '11 hours', CURRENT_DATE + interval '12 hours', 40.7148, -74.0080)
      ON CONFLICT DO NOTHING;
    `);

    console.log('Seeding Manifest Stops (Pivot Table)...');
    await client.query(`
      INSERT INTO manifest_stops (stop_id, manifest_id, commande_id, delivery_order, delivery_status)
      VALUES 
        (1, 'MAN-1', 1, 1, 'PENDING'),
        (2, 'MAN-1', 2, 2, 'PENDING'),
        (3, 'MAN-1', 3, 3, 'PENDING')
      ON CONFLICT DO NOTHING;
    `);

    console.log('Seeding Segments...');
    // A simple straight line from (40.7128, -74.0060) to (40.7138, -74.0060)
    await client.query(`
      INSERT INTO segments (segment_id, name, start_lat, start_lon, end_lat, end_lon, geom)
      VALUES 
        ('SEG-1', 'Broadway - Segment 1', 40.7128, -74.0060, 40.7138, -74.0060, ST_GeomFromText('LINESTRING(-74.0060 40.7128, -74.0060 40.7138)', 4326)),
        ('SEG-2', 'Broadway - Segment 2', 40.7138, -74.0060, 40.7148, -74.0060, ST_GeomFromText('LINESTRING(-74.0060 40.7138, -74.0060 40.7148)', 4326))
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
