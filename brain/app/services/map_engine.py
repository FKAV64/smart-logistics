import os
import psycopg2
import networkx as nx
import math

class MapEngine:
    def __init__(self):
        self.graph = nx.DiGraph()
        self._load_network()
        
    def _load_network(self):
        print("🗺️ MapEngine: Initializing local routing graph from PostGIS...")
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
            
            # Use ST_AsText so we easily get raw WKT coordinates for GeoJSON conversion later
            cur.execute("SELECT segment_id, name, start_lat, start_lon, end_lat, end_lon, ST_AsText(geom) FROM segments;")
            rows = cur.fetchall()
            
            edges_added = 0
            for row in rows:
                seg_id, name, start_lat, start_lon, end_lat, end_lon, geom_wkt = row
                
                # NetworkX node representation via GPS tuple
                # We round slightly to ensure intersection snapping works efficiently
                start_node = (round(start_lon, 5), round(start_lat, 5))
                end_node   = (round(end_lon, 5), round(end_lat, 5))
                
                # Base Geographic Distance Proxy
                R = 6371.0
                dlat = math.radians(end_lat - start_lat)
                dlon = math.radians(end_lon - start_lon)
                a = (math.sin(dlat / 2)**2 + math.cos(math.radians(start_lat)) * math.cos(math.radians(end_lat)) * math.sin(dlon / 2)**2)
                c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                dist_km = R * c
                
                self.graph.add_edge(
                    start_node, 
                    end_node, 
                    segment_id=seg_id,
                    name=name,
                    geom_wkt=geom_wkt,
                    distance_km=dist_km
                )
                edges_added += 1
                
            print(f"✅ MapEngine: NetworkX graph built securely with {edges_added} road segments.")
            
        except Exception as e:
            print(f"❌ MapEngine Error: Failed to load from database. (Did the map seeder run?) Error: {e}")
        finally:
            if 'cur' in locals(): cur.close()
            if 'conn' in locals(): conn.close()
            
    def get_graph(self):
        return self.graph

    def get_nearest_node(self, lon, lat):
        """
        Utility for snapping arbitrary GPS coordinates (like Courier location or Stop Destination) 
        to the closest known intersection on the graph.
        """
        if len(self.graph.nodes) == 0:
            return (lon, lat)
            
        closest_node = None
        min_dist = float('inf')
        for node in self.graph.nodes():
            dist = (node[0] - lon)**2 + (node[1] - lat)**2
            if dist < min_dist:
                min_dist = dist
                closest_node = node
        return closest_node
