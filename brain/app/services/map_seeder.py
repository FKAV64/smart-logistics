import os
import uuid
import psycopg2
import osmnx as ox

def seed_map_if_empty():
    """
    Checks the PostgreSQL database. If the 'segments' table is empty,
    it downloads the physical road network of Sivas using OpenStreetMap
    and saves the edges directly into PostGIS.
    """
    db_host = os.getenv('DB_HOST', 'postgres')
    db_port = os.getenv('DB_PORT', '5432')
    db_user = os.getenv('DB_USER', 'postgres')
    db_pass = os.getenv('DB_PASS', 'password')
    db_name = os.getenv('DB_NAME', 'smart_logistics')
    
    try:
        conn = psycopg2.connect(
            host=db_host,
            port=db_port,
            user=db_user,
            password=db_pass,
            dbname=db_name
        )
        cur = conn.cursor()
        
        cur.execute("SELECT COUNT(*) FROM segments;")
        count = cur.fetchone()[0]
        
        if count > 0:
            print(f"🌍 Map already seeded with {count} segments.")
            cur.close()
            conn.close()
            return
            
        # Download the drivable network for all of Sivas, Turkey (including remote towns/mountains).
        # This will query OSM and can take a few minutes to process locally.
        G = ox.graph_from_place('Sivas, Turkey', network_type='drive')
        
        # Convert the structural graph into usable GeoDataFrames
        nodes, edges = ox.graph_to_gdfs(G)
        
        print(f"🗺️ Pre-processing {len(edges)} street segments...")
        
        # Prepare the bulk insert query
        insert_query = """
            INSERT INTO segments (segment_id, name, start_lat, start_lon, end_lat, end_lon, geom)
            VALUES (%s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromText(%s), 4326))
        """
        
        data_to_insert = []
        for index, row in edges.iterrows():
            # Sometimes OSM streets have no explicit name
            name = row.get('name', 'Unnamed Street')
            if isinstance(name, list):
                name = name[0]
            if not isinstance(name, str):
                name = 'Unnamed Street'
                
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
                
            # Grab start and end points of the LineString
            coords = list(geom.coords)
            start_lon, start_lat = coords[0]
            end_lon,   end_lat   = coords[-1]
            
            wkt_geom = geom.wkt
            
            data_to_insert.append((
                str(uuid.uuid4()),
                name[:250],
                start_lat,
                start_lon,
                end_lat,
                end_lon,
                wkt_geom
            ))
            
        print("💾 Saving routes into PostgreSQL (PostGIS)...")
        # Execute batch insert
        cur.executemany(insert_query, data_to_insert)
        conn.commit()
        
        print(f"✅ Successfully seeded {len(data_to_insert)} physical street segments.")
        
    except Exception as e:
        print(f"❌ Map seeding failed: {e}")
    finally:
        if 'cur' in locals(): cur.close()
        if 'conn' in locals(): conn.close()

if __name__ == "__main__":
    seed_map_if_empty()
