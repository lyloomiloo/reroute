"""
(re)Route — Barcelona Street Quality Scoring Script
====================================================
Processes 5 data sources into a single GeoJSON where every street segment
has 4 quality scores (0-1): noise, greenery, cleanliness, cultural POI density.

Run this on your local machine (not in the app — this is a one-time data prep step).

SETUP (run these commands in your terminal first):
    pip install geopandas osmnx shapely pyproj scipy

USAGE:
    1. Put all 5 data files in a folder called 'data/' next to this script
    2. Run: python score_streets.py
    3. Output: barcelona_street_scores.geojson (drop this into your Next.js public/ folder)

DATA FILES EXPECTED IN data/:
    - _Noise__2017_tramer_mapa_estrategic_soroll_bcn.csv
    - [Trees on Streets] OD_Arbrat_Viari_BCN.csv  (unzipped)
    - _Trees_in_Parks__OD_Arbrat_Parcs_BCN.csv
    - _Cleaning__5_-dadesoddesembre.csv
    - POI.geojson
"""

import os
import csv
import json
import warnings
import numpy as np
import geopandas as gpd
import osmnx as ox
from shapely.geometry import Point, LineString, MultiLineString
from shapely.ops import transform
from shapely import wkt
from pyproj import Transformer
from scipy.spatial import cKDTree

warnings.filterwarnings("ignore")

# ============================================================
# CONFIG
# ============================================================
DATA_DIR = "data"
OUTPUT_FILE = "barcelona_street_scores.geojson"
BUFFER_METERS = 25  # How close a tree/POI/cleaning spot must be to "count" for a street

# File names (update these if yours differ)
NOISE_CSV = "[Noise] 2017_tramer_mapa_estrategic_soroll_bcn.csv"
STREET_TREES_CSV = "[Trees on Streets] OD_Arbrat_Viari_BCN.csv"
PARK_TREES_CSV = "[Trees in Parks] OD_Arbrat_Parcs_BCN.csv"
CLEANING_CSV = "[Cleaning] 5.-dadesoddesembre.csv"
POI_GEOJSON = "POI.geojson"


# ============================================================
# STEP 1: Download Barcelona street network from OSM
# ============================================================
def get_street_network():
    """Download Barcelona's walkable street network using osmnx."""
    print("📍 Step 1: Downloading Barcelona street network from OSM...")
    print("   (This may take 1-2 minutes on first run. It gets cached after that.)")

    # Get walkable streets in Barcelona
    G = ox.graph_from_place("Barcelona, Spain", network_type="walk")

    # Convert to GeoDataFrame of edges (street segments)
    edges = ox.graph_to_gdfs(G, nodes=False, edges=True)
    edges = edges.to_crs(epsg=4326)  # Ensure WGS84 lat/lng

    print(f"   ✅ Got {len(edges)} street segments")
    return edges


# ============================================================
# STEP 2: Load and process noise data
# ============================================================
def parse_db_range(db_string):
    """Convert '70 - 75 dB(A)' to midpoint float (72.5). '< 40 dB(A)' becomes 37.5."""
    db_string = db_string.strip()
    if db_string.startswith("<"):
        return 37.5  # Midpoint of assumed 35-40 range
    parts = db_string.replace("dB(A)", "").strip().split("-")
    low = float(parts[0].strip())
    high = float(parts[1].strip())
    return (low + high) / 2.0


def load_noise_data():
    """Load noise CSV with street segment geometries. Returns GeoDataFrame in EPSG:4326."""
    print("🔊 Step 2: Loading noise data...")

    filepath = os.path.join(DATA_DIR, NOISE_CSV)
    rows = []

    # UTM Zone 31N (Barcelona) -> WGS84
    transformer = Transformer.from_crs("EPSG:25831", "EPSG:4326", always_xy=True)

    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                db_value = parse_db_range(row["TOTAL_DEN"])
                geom_utm = wkt.loads(row["GEOM_WKT"])

                # Reproject UTM -> lat/lng
                geom_wgs84 = transform(transformer.transform, geom_utm)

                rows.append({
                    "tram_id": row["TRAM"],
                    "noise_db": db_value,
                    "geometry": geom_wgs84
                })
            except Exception:
                continue

    noise_gdf = gpd.GeoDataFrame(rows, crs="EPSG:4326")
    print(f"   ✅ Loaded {len(noise_gdf)} noise segments (dB range: {noise_gdf['noise_db'].min()}-{noise_gdf['noise_db'].max()})")
    return noise_gdf


# ============================================================
# STEP 3: Load point data (trees, cleaning, POIs)
# ============================================================
def load_trees():
    """Load street trees + park trees. Returns numpy array of [lng, lat] points."""
    print("🌳 Step 3a: Loading tree data...")

    points = []

    # Street trees
    filepath = os.path.join(DATA_DIR, STREET_TREES_CSV)
    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                lat = float(row["latitud"])
                lng = float(row["longitud"])
                if 41.0 < lat < 42.0 and 1.5 < lng < 2.5:  # Basic Barcelona bounds check
                    points.append([lng, lat])
            except (ValueError, KeyError):
                continue

    street_count = len(points)

    # Park trees
    filepath = os.path.join(DATA_DIR, PARK_TREES_CSV)
    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                lat = float(row["latitud"])
                lng = float(row["longitud"])
                if 41.0 < lat < 42.0 and 1.5 < lng < 2.5:
                    points.append([lng, lat])
            except (ValueError, KeyError):
                continue

    print(f"   ✅ Loaded {street_count} street trees + {len(points) - street_count} park trees = {len(points)} total")
    return np.array(points)


def load_cleaning_spots():
    """Load cleaning problem spots. Returns numpy array of [lng, lat] points."""
    print("🧹 Step 3b: Loading cleaning spots...")

    points = []
    filepath = os.path.join(DATA_DIR, CLEANING_CSV)

    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                lat = float(row["Latitud"])
                lng = float(row["Longitud"])
                if 41.0 < lat < 42.0 and 1.5 < lng < 2.5:
                    points.append([lng, lat])
            except (ValueError, KeyError):
                continue

    print(f"   ✅ Loaded {len(points)} cleaning spots")
    return np.array(points)


def load_pois():
    """Load cultural/historic POIs from GeoJSON. Returns numpy array of [lng, lat] points."""
    print("🏛️  Step 3c: Loading cultural POIs...")

    filepath = os.path.join(DATA_DIR, POI_GEOJSON)
    with open(filepath, "r") as f:
        data = json.load(f)

    points = []
    for feature in data["features"]:
        try:
            geom = feature["geometry"]
            if geom["type"] == "Point":
                lng, lat = geom["coordinates"]
                if 41.0 < lat < 42.0 and 1.5 < lng < 2.5:
                    points.append([lng, lat])
        except (KeyError, TypeError):
            continue

    print(f"   ✅ Loaded {len(points)} cultural POIs")
    return np.array(points)


# ============================================================
# STEP 4: Score each street segment
# ============================================================
def count_points_near_line(line_geom, kdtree, points_array, buffer_deg):
    """Count how many points from the KDTree fall within buffer_deg of the line.

    We sample points along the line and query the KDTree for nearby points.
    This is much faster than true geometric buffering for large datasets.
    """
    # Sample points along the line at ~10m intervals
    if line_geom.is_empty:
        return 0

    # Get coords from the line
    if isinstance(line_geom, MultiLineString):
        coords = []
        for line in line_geom.geoms:
            coords.extend(list(line.coords))
    else:
        coords = list(line_geom.coords)

    if len(coords) == 0:
        return 0

    # Query KDTree: find all points within buffer_deg of any vertex on the line
    nearby = set()
    for coord in coords:
        indices = kdtree.query_ball_point(coord, buffer_deg)
        nearby.update(indices)

    return len(nearby)


def score_streets(edges, noise_gdf, tree_points, cleaning_points, poi_points):
    """Assign quality scores to every street segment."""
    print("⚡ Step 4: Scoring street segments...")

    # --- Approximate degree buffer ---
    # At Barcelona's latitude (~41.4°N), 1 degree lat ≈ 111km, 1 degree lng ≈ 83km
    # 25 meters ≈ 0.000225 degrees lat, 0.000301 degrees lng
    # Use average: ~0.000263 degrees
    buffer_deg = BUFFER_METERS / 111000.0  # Rough conversion, good enough

    # --- Build KD-trees for fast spatial queries ---
    print("   Building spatial indices...")
    tree_kdtree = cKDTree(tree_points) if len(tree_points) > 0 else None
    cleaning_kdtree = cKDTree(cleaning_points) if len(cleaning_points) > 0 else None
    poi_kdtree = cKDTree(poi_points) if len(poi_points) > 0 else None

    # --- Build noise spatial index ---
    # For each noise segment, compute its centroid for fast matching
    print("   Matching noise data to street segments...")
    noise_centroids = np.array([[g.centroid.x, g.centroid.y] for g in noise_gdf.geometry])
    noise_kdtree = cKDTree(noise_centroids)
    noise_values = noise_gdf["noise_db"].values

    # --- Score each edge ---
    n_edges = len(edges)
    noise_scores = np.full(n_edges, 0.5)  # Default: medium noise if no data
    green_scores = np.zeros(n_edges)
    clean_scores = np.ones(n_edges)  # Default: clean (no spots nearby)
    cultural_scores = np.zeros(n_edges)

    # Raw counts for normalization
    tree_counts = np.zeros(n_edges)
    cleaning_counts = np.zeros(n_edges)
    poi_counts = np.zeros(n_edges)

    for i, (idx, edge) in enumerate(edges.iterrows()):
        if i % 5000 == 0:
            print(f"   Processing segment {i}/{n_edges}...")

        geom = edge.geometry
        if geom is None or geom.is_empty:
            continue

        centroid = geom.centroid

        # --- Noise score ---
        # Find nearest noise segment and use its dB value
        dist, nearest_idx = noise_kdtree.query([centroid.x, centroid.y])
        if dist < 0.001:  # Within ~100m — close enough to assign
            db = noise_values[nearest_idx]
            # Map 37.5-77.5 dB → 1.0-0.0 (quiet=good, loud=bad)
            noise_scores[i] = max(0.0, min(1.0, 1.0 - (db - 37.5) / 40.0))

        # --- Tree count ---
        if tree_kdtree is not None:
            tree_counts[i] = count_points_near_line(geom, tree_kdtree, tree_points, buffer_deg)

        # --- Cleaning spots count ---
        if cleaning_kdtree is not None:
            cleaning_counts[i] = count_points_near_line(geom, cleaning_kdtree, cleaning_points, buffer_deg)

        # --- POI count ---
        if poi_kdtree is not None:
            poi_counts[i] = count_points_near_line(geom, poi_kdtree, poi_points, buffer_deg)

    # --- Normalize to 0-1 ---
    print("   Normalizing scores...")

    # Green score: normalize tree count (use 90th percentile as max to avoid outlier skew)
    if tree_counts.max() > 0:
        cap = max(np.percentile(tree_counts[tree_counts > 0], 90), 1)
        green_scores = np.minimum(tree_counts / cap, 1.0)

    # Clean score: inverse of cleaning spots (0 spots = 1.0, any spots = penalized)
    # Since there are only ~257 spots, most streets will score 1.0
    clean_scores = np.where(cleaning_counts == 0, 1.0,
                            np.maximum(0.0, 1.0 - cleaning_counts * 0.3))

    # Cultural score: normalize POI count
    if poi_counts.max() > 0:
        cap = max(np.percentile(poi_counts[poi_counts > 0], 90), 1)
        cultural_scores = np.minimum(poi_counts / cap, 1.0)

    # --- Assign to edges ---
    edges = edges.copy()
    edges["noise_score"] = np.round(noise_scores, 3)
    edges["green_score"] = np.round(green_scores, 3)
    edges["clean_score"] = np.round(clean_scores, 3)
    edges["cultural_score"] = np.round(cultural_scores, 3)

    # --- Stats ---
    print(f"\n   📊 Score distributions:")
    for col in ["noise_score", "green_score", "clean_score", "cultural_score"]:
        vals = edges[col]
        print(f"      {col}: min={vals.min():.2f}, median={vals.median():.2f}, max={vals.max():.2f}")

    return edges


# ============================================================
# STEP 5: Export
# ============================================================
def export_geojson(edges):
    """Export scored streets as a lean GeoJSON for the frontend."""
    print(f"\n💾 Step 5: Exporting to {OUTPUT_FILE}...")

    # --- Filter to central Barcelona ---
    # Covers: Ciutat Vella, Eixample, Gràcia, Sants-Montjuïc, Sant Martí, Sarrià
    BBOX = {
        "min_lng": 2.13,
        "max_lng": 2.21,
        "min_lat": 41.37,
        "max_lat": 41.42
    }

    centroids = edges.geometry.centroid
    mask = (
        (centroids.x >= BBOX["min_lng"]) & (centroids.x <= BBOX["max_lng"]) &
        (centroids.y >= BBOX["min_lat"]) & (centroids.y <= BBOX["max_lat"])
    )
    output = edges[mask].copy()
    print(f"   Filtered to central Barcelona: {len(output)} segments (was {len(edges)})")

    # Keep only the columns we need (keeps file size manageable)
    keep_cols = ["geometry", "noise_score", "green_score", "clean_score", "cultural_score"]

    # Also keep street name if available
    if "name" in output.columns:
        keep_cols.insert(1, "name")

    output = output[keep_cols]

    # Drop segments with no geometry
    output = output[~output.geometry.is_empty]

    # Reduce coordinate precision to 6 decimal places (~0.1m accuracy, plenty for walking)
    output.geometry = output.geometry.apply(
        lambda g: wkt.loads(wkt.dumps(g, rounding_precision=6))
    )

    output.to_file(OUTPUT_FILE, driver="GeoJSON")

    file_size_mb = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
    print(f"   ✅ Done! {len(output)} segments, {file_size_mb:.1f} MB")
    print(f"\n   Next: copy {OUTPUT_FILE} into your Next.js public/ folder")
    print(f"   Then load it in Leaflet with: fetch('/{OUTPUT_FILE}').then(r => r.json())")


# ============================================================
# MAIN
# ============================================================
def main():
    print("=" * 60)
    print("(re)Route — Barcelona Street Quality Scoring")
    print("=" * 60)
    print()

    # Check data files exist
    required = [NOISE_CSV, STREET_TREES_CSV, PARK_TREES_CSV, CLEANING_CSV, POI_GEOJSON]
    missing = [f for f in required if not os.path.exists(os.path.join(DATA_DIR, f))]
    if missing:
        print("❌ Missing data files in data/ folder:")
        for f in missing:
            print(f"   - {f}")
        print("\nMake sure all 5 files are in a 'data/' folder next to this script.")
        return

    # Run pipeline
    edges = get_street_network()
    noise_gdf = load_noise_data()
    tree_points = load_trees()
    cleaning_points = load_cleaning_spots()
    poi_points = load_pois()

    scored = score_streets(edges, noise_gdf, tree_points, cleaning_points, poi_points)
    export_geojson(scored)

    print("\n🎉 All done! Your street quality data is ready.")


if __name__ == "__main__":
    main()
