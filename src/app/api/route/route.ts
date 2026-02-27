import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/** Allow API route to run up to 60s (e.g. ORS + LLM + reranking). */
export const maxDuration = 60;

// =============================================================
// TYPES
// =============================================================
type Intent = "calm" | "discover" | "nature" | "scenic" | "lively" | "exercise" | "cafe" | "quick";

interface StreetFeature {
  geometry: { type: string; coordinates: number[][] | number[][][] };
  properties: {
    noise_score: number;
    green_score: number;
    clean_score: number;
    cultural_score: number;
    name?: string;
  };
}

interface ScoredRoute {
  coordinates: [number, number][];
  duration: number;
  distance: number;
  score: number;
  breakdown: {
    noise: number;
    green: number;
    clean: number;
    cultural: number;
  };
  summary: string;
  highlights?: { lat: number; lng: number; label: string; type: string; name?: string; description?: string }[];
}

interface PoiFeature {
  type: string;
  properties: Record<string, string>;
  geometry: { type: string; coordinates: [number, number] };
}

// =============================================================
// WEIGHT PROFILES — This is the core of mood routing
// =============================================================
const WEIGHT_PROFILES: Record<string, { noise: number; green: number; clean: number; cultural: number }> = {
  calm:     { noise: 0.45, green: 0.30, clean: 0.15, cultural: 0.10 },
  nature:   { noise: 0.20, green: 0.55, clean: 0.15, cultural: 0.10 },
  discover: { noise: 0.05, green: 0.10, clean: 0.10, cultural: 0.75 },
  scenic:   { noise: 0.15, green: 0.40, clean: 0.10, cultural: 0.35 },
  lively:   { noise: 0.00, green: 0.05, clean: 0.15, cultural: 0.80 },
  exercise: { noise: 0.10, green: 0.30, clean: 0.10, cultural: 0.10 },
  cafe:     { noise: 0.10, green: 0.10, clean: 0.20, cultural: 0.60 },
  quick:    { noise: 0.10, green: 0.10, clean: 0.10, cultural: 0.10 },
};

const SIMULATE_NIGHT = false; // Bypass night logic for testing; set true to repro ORS profile error and check server log for "[route] ORS body"

if (!process.env.STREET_DATA_URL) {
  console.warn("[route] STREET_DATA_URL not set — will use local file only");
}

// ORS native weightings to nudge route generation (0-2 scale)
const ORS_WEIGHTINGS: Record<string, { green?: number; quiet?: number }> = {
  calm:     { quiet: 1, green: 0.5 },
  nature:   { green: 1, quiet: 0.5 },
  discover: {},
  scenic:   { green: 0.8 },
  lively:   {},
  exercise: { green: 0.5 },
  cafe:     {},
  quick:    {},
};

/** Check if it's currently after dark in Barcelona */
function isAfterDarkInBarcelona(): boolean {
  const barcelonaHour = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Madrid" })
  ).getHours();
  return SIMULATE_NIGHT || barcelonaHour >= 21 || barcelonaHour < 6;
}

// =============================================================
// NIGHT SAFE CORRIDORS — reroute through well-lit busy streets
// =============================================================
interface SafeCorridor {
  zone: string;
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  waypoints: [number, number][];
}

const NIGHT_SAFE_CORRIDORS: SafeCorridor[] = [
  {
    zone: "Raval",
    bbox: { minLat: 41.375, maxLat: 41.385, minLng: 2.165, maxLng: 2.175 },
    waypoints: [
      [41.3810, 2.1734],  // Top of La Rambla (Plaça Catalunya end)
      [41.3757, 2.1700],  // Mid La Rambla (Liceu area)
    ],
  },
];

/** Check if a route between origin and destination would pass near an unsafe zone */
function routePassesNearZone(
  origin: [number, number],
  destination: [number, number],
  bbox: SafeCorridor["bbox"]
): boolean {
  const midLat = (origin[0] + destination[0]) / 2;
  const midLng = (origin[1] + destination[1]) / 2;
  const pad = 0.003;
  return (
    midLat >= bbox.minLat - pad && midLat <= bbox.maxLat + pad &&
    midLng >= bbox.minLng - pad && midLng <= bbox.maxLng + pad
  );
}

/** Pick the safe waypoint closest to the midpoint of the route */
function pickSafeWaypoint(
  origin: [number, number],
  destination: [number, number],
  waypoints: [number, number][]
): [number, number] {
  const midLat = (origin[0] + destination[0]) / 2;
  const midLng = (origin[1] + destination[1]) / 2;
  let best = waypoints[0];
  let bestDist = Infinity;
  for (const wp of waypoints) {
    const d = Math.abs(wp[0] - midLat) + Math.abs(wp[1] - midLng);
    if (d < bestDist) { bestDist = d; best = wp; }
  }
  return best;
}

// =============================================================
// LOAD STREET QUALITY DATA (cached in memory after first request)
// =============================================================
let streetFeatures: StreetFeature[] | null = null;
let streetIndex: Map<string, StreetFeature[]> | null = null;

function getGridKey(lng: number, lat: number): string {
  // Grid cells of ~100m for fast spatial lookup
  return `${Math.round(lng * 1000)},${Math.round(lat * 1000)}`;
}

async function loadStreetData(): Promise<{ features: StreetFeature[]; index: Map<string, StreetFeature[]> }> {
  if (streetFeatures && streetIndex) {
    return { features: streetFeatures, index: streetIndex };
  }

  console.log("[route] Loading street quality data...");
  const dataPath = path.join(process.cwd(), "src", "data", "barcelona_street_scores.geojson");

  let raw: { features?: StreetFeature[] };
  const exists = fs.existsSync(dataPath);
  let content: string;
  if (exists) {
    content = fs.readFileSync(dataPath, "utf-8");
    // LFS pointer: first line is "version https://git-lfs.github.com/spec/v1"
    if (content.startsWith("version https://")) {
      if (!process.env.STREET_DATA_URL) {
        throw new Error(
          "Local file is LFS pointer. Set STREET_DATA_URL (e.g. Supabase storage URL) to fetch street data, or run score_streets.py and copy the real GeoJSON to src/data/"
        );
      }
      const res = await fetch(process.env.STREET_DATA_URL);
      if (!res.ok) throw new Error(`Failed to fetch street data from STREET_DATA_URL: ${res.status}`);
      raw = (await res.json()) as { features?: StreetFeature[] };
    } else {
      raw = JSON.parse(content);
    }
  } else {
    if (!process.env.STREET_DATA_URL) {
      throw new Error(
        `Street quality data not found at ${dataPath}. Run score_streets.py and copy barcelona_street_scores.geojson to src/data/, or set STREET_DATA_URL to fetch from URL.`
      );
    }
    const res = await fetch(process.env.STREET_DATA_URL);
    if (!res.ok) throw new Error(`Failed to fetch street data from STREET_DATA_URL: ${res.status}`);
    raw = (await res.json()) as { features?: StreetFeature[] };
  }

  streetFeatures = (raw.features ?? []) as StreetFeature[];

  // Build spatial grid index for fast lookups
  streetIndex = new Map();
  for (const feat of streetFeatures) {
    const coords = feat.geometry.type === "MultiLineString"
      ? feat.geometry.coordinates.flat()
      : feat.geometry.coordinates;

    for (const coord of coords as number[][]) {
      const key = getGridKey(coord[0], coord[1]);
      if (!streetIndex.has(key)) streetIndex.set(key, []);
      streetIndex.get(key)!.push(feat);
    }
  }

  console.log(`[route] Loaded ${streetFeatures.length} street segments, index size: ${streetIndex.size} cells`);
  return { features: streetFeatures, index: streetIndex };
}

// =============================================================
// LOAD POI DATA (cached, Barcelona bbox only — uses BCN_BBOX below)
// =============================================================
let poiFeatures: PoiFeature[] | null = null;

function loadPoiData(): PoiFeature[] {
  if (poiFeatures) return poiFeatures;
  const dataPath = path.join(process.cwd(), "data", "POI.geojson");
  if (!fs.existsSync(dataPath)) {
    console.warn("[route] POI.geojson not found, highlights will skip POI data");
    poiFeatures = [];
    return poiFeatures;
  }
  const raw = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  const all = (raw.features || []) as PoiFeature[];
  poiFeatures = all.filter((f) => {
    const c = f.geometry?.coordinates;
    if (!c || c.length < 2) return false;
    const [lng, lat] = c;
    return lng >= BCN_BBOX.minLng && lng <= BCN_BBOX.maxLng && lat >= BCN_BBOX.minLat && lat <= BCN_BBOX.maxLat;
  });
  console.log(`[route] Loaded ${poiFeatures.length} POIs in Barcelona bbox`);
  return poiFeatures;
}

type RouteHighlightOut = { lat: number; lng: number; label: string; type: string; name?: string; description?: string; score?: number; photo_url?: string | null; photo_urls?: string[]; photoRefs?: string[] };

/** Approximate meters between two [lng, lat] points. */
function distMeters(a: [number, number], b: [number, number]): number {
  const [lngA, latA] = a;
  const [lngB, latB] = b;
  const dy = (latB - latA) * 111000;
  const dx = (lngB - lngA) * 85000;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Scale POI count by route distance (ORS distance in meters). When poi_focus is true, caller uses 5–8. */
function maxPoisFromRouteDistance(distanceM: number): number {
  if (distanceM < 1000) return 2;   // Under 1km: 1–2 POIs
  if (distanceM < 2000) return 3;   // 1–2km: 2–3 POIs
  if (distanceM < 4000) return 4;   // 2–4km: 3–4 POIs
  return 6;                          // Over 4km: 4–6 POIs
}

/** Get midpoint coordinates for N equal-length segments along the route. */
function getSegmentMidpoints(routeCoords: [number, number][], nSegments: number): { lng: number; lat: number }[] {
  if (routeCoords.length < 2 || nSegments < 1) return [];
  const n = Math.min(nSegments, routeCoords.length - 1);
  const cumulative: number[] = [0];
  for (let i = 1; i < routeCoords.length; i++) {
    cumulative[i] = cumulative[i - 1] + distMeters(routeCoords[i - 1], routeCoords[i]);
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= 0) return [{ lng: routeCoords[0][0], lat: routeCoords[0][1] }];
  const out: { lng: number; lat: number }[] = [];
  for (let seg = 0; seg < n; seg++) {
    const targetDist = (seg + 0.5) * (total / n);
    let i = 0;
    while (i < cumulative.length - 1 && cumulative[i + 1] < targetDist) i++;
    if (i >= cumulative.length - 1) {
      out.push({ lng: routeCoords[routeCoords.length - 1][0], lat: routeCoords[routeCoords.length - 1][1] });
      continue;
    }
    const t = (targetDist - cumulative[i]) / (cumulative[i + 1] - cumulative[i]);
    const lng = routeCoords[i][0] + t * (routeCoords[i + 1][0] - routeCoords[i][0]);
    const lat = routeCoords[i][1] + t * (routeCoords[i + 1][1] - routeCoords[i][1]);
    out.push({ lng, lat });
  }
  return out;
}

/** POI highlights from Google Places text search along the route (for poi_focus walks). Distributes search terms across route segments. */
async function findRouteHighlightsFromPlaces(
  routeCoords: [number, number][],
  searchTerms: string[],
  maxPois: number
): Promise<RouteHighlightOut[]> {
  if (routeCoords.length < 2 || searchTerms.length === 0 || maxPois < 1) return [];
  const midpoints = getSegmentMidpoints(routeCoords, maxPois);
  if (midpoints.length === 0) return [];
  const distM2 = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const dy = (a.lat - b.lat) * 111000;
    const dx = (a.lng - b.lng) * 85000;
    return dx * dx + dy * dy;
  };
  const out: RouteHighlightOut[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < maxPois; i++) {
    const { lat, lng } = midpoints[i % midpoints.length];
    const term = searchTerms[i % searchTerms.length];
    const query = `${term.trim()} Barcelona`;
    try {
      const places = await searchPlace(query, lat, lng, 2, 800);
      for (const p of places) {
        const key = (p.name || "").trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        // Skip business/service POIs from highlights
        if (p.primary_type && HIGHLIGHT_EXCLUDE_TYPES.some((t) => p.primary_type!.toLowerCase().includes(t))) continue;
        seen.add(key);
        out.push({
          lat: p.lat,
          lng: p.lng,
          label: `📍 ${p.name}`,
          type: "cultural",
          name: p.name,
          description: p.description ?? `${p.name} · place`,
        });
        if (out.length >= maxPois) break;
      }
    } catch {
      // skip this segment
    }
    if (out.length >= maxPois) break;
  }
  return out.slice(0, maxPois);
}

// TODO: For high-density POI walks, consider rerouting through 1-2 relevant POIs slightly off-route (within 300m) if it adds <5 min. Not implemented yet.

function findRouteHighlights(
  routeCoords: [number, number][],
  intent: Intent,
  streetIdx: Map<string, StreetFeature[]>,
  poiPoints: PoiFeature[],
  excludeHighlightTypes?: string[],
  maxPois: number = 3
): RouteHighlightOut[] {
  const out: RouteHighlightOut[] = [];
  if (routeCoords.length < 3) return out;
  if (intent === "quick") return out;

  const step = Math.max(1, Math.floor(routeCoords.length / 20));
  const sampled = routeCoords.filter((_, i) => i % step === 0);
  const distM2 = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const dy = (a.lat - b.lat) * 111000;
    const dx = (a.lng - b.lng) * 85000;
    return dx * dx + dy * dy;
  };
  const dist = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const nearbyPois = (lng: number, lat: number, radiusM: number) => {
    const deg = radiusM / 111000;
    return poiPoints.filter((f) => {
      const [plng, plat] = f.geometry.coordinates;
      return (plng - lng) ** 2 + (plat - lat) ** 2 <= deg * deg;
    });
  };
  const POI_SEARCH_RADIUS_M = 200;
  const exclude = excludeHighlightTypes ?? [];

  const addComplementaryCultural = () => {
    const culturalTypes = ["museum", "attraction", "viewpoint", "historic", "artwork", "gallery"];
    const used = new Set<string>();
    const midpoints = getSegmentMidpoints(routeCoords, maxPois);
    for (const { lng, lat } of midpoints) {
      const pois = nearbyPois(lng, lat, POI_SEARCH_RADIUS_M).filter((f) => {
        const t = (f.properties.tourism || f.properties.historic || f.properties.amenity || f.properties.leisure || "").toLowerCase();
        const name = (f.properties.name || "").trim();
        if (!name || used.has(name)) return false;
        const isCultural = culturalTypes.some((ct) => t.includes(ct)) || t === "yes";
        const isPark = f.properties.leisure === "park" || f.properties.landuse === "grass" || (f.properties.name && /park|jard|plaza|plaça/i.test(f.properties.name));
        return isCultural || isPark;
      });
      if (pois.length === 0) continue;
      const byDist = [...pois].sort((a, b) => {
        const da = dist([a.geometry.coordinates[0], a.geometry.coordinates[1]], [lng, lat]);
        const db = dist([b.geometry.coordinates[0], b.geometry.coordinates[1]], [lng, lat]);
        return da - db;
      });
      const p = byDist[0];
      const name = (p.properties.name || "Point of interest").trim();
      used.add(name);
      const [plng, plat] = p.geometry.coordinates;
      const emoji = p.properties.tourism === "museum" ? "🎨" : p.properties.historic ? "🏛" : p.properties.leisure === "park" ? "🌿" : "📍";
      const placeType = p.properties.tourism === "viewpoint" ? "viewpoint" : p.properties.historic ? "landmark" : p.properties.leisure === "park" ? "park" : "attraction";
      out.push({ lat: plat, lng: plng, label: `${emoji} ${name}`, type: "cultural", name, description: `${name} · ${placeType}` });
    }
  };

  if (intent === "calm" || intent === "nature") {
    if (!exclude.includes("nature")) {
      const withGreen: { green: number; lng: number; lat: number }[] = [];
      sampled.forEach(([lng, lat]) => {
        let green = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const cell = streetIdx.get(`${Math.round(lng * 1000) + dx},${Math.round(lat * 1000) + dy}`);
            if (cell) green += cell.reduce((s, f) => s + f.properties.green_score, 0) / cell.length;
          }
        }
        withGreen.push({ green, lng, lat });
      });
      withGreen.sort((a, b) => b.green - a.green);
      const best = withGreen[0];
      if (best) out.push({ lat: best.lat, lng: best.lng, label: "🌳 Tree-lined stretch", type: "nature", name: "Tree-lined stretch", description: "Tree-lined stretch · green stretch", score: best.green });
    }
  }

  if (intent === "discover" || intent === "scenic") {
    if (!exclude.includes("cultural")) {
      const culturalTypes = ["museum", "attraction", "viewpoint", "historic", "artwork", "gallery"];
      const used = new Set<string>();
      const midpoints = getSegmentMidpoints(routeCoords, maxPois);
      for (const { lng, lat } of midpoints) {
        const pois = nearbyPois(lng, lat, POI_SEARCH_RADIUS_M).filter((f) => {
          const t = (f.properties.tourism || f.properties.historic || f.properties.amenity || "").toLowerCase();
          const name = (f.properties.name || "").trim();
          if (!name || used.has(name)) return false;
          return culturalTypes.some((ct) => t.includes(ct)) || t === "yes";
        });
        if (pois.length === 0) continue;
        const byDist = [...pois].sort((a, b) => {
          const da = dist([a.geometry.coordinates[0], a.geometry.coordinates[1]], [lng, lat]);
          const db = dist([b.geometry.coordinates[0], b.geometry.coordinates[1]], [lng, lat]);
          return da - db;
        });
        const p = byDist[0];
        const name = (p.properties.name || "Point of interest").trim();
        used.add(name);
        const [plng, plat] = p.geometry.coordinates;
        const emoji = p.properties.tourism === "museum" ? "🎨" : p.properties.historic ? "🏛" : "📍";
        const placeType = p.properties.tourism === "viewpoint" ? "viewpoint" : p.properties.historic ? "landmark" : "attraction";
        out.push({ lat: plat, lng: plng, label: `${emoji} ${name}`, type: "cultural", name, description: `${name} · ${placeType}` });
      }
    }
  }

  if (intent === "cafe") {
    if (exclude.includes("cafe")) {
      addComplementaryCultural();
    } else {
      const used = new Set<string>();
      const midpoints = getSegmentMidpoints(routeCoords, maxPois);
      for (const { lng, lat } of midpoints) {
        const pois = nearbyPois(lng, lat, POI_SEARCH_RADIUS_M).filter(
          (f) => (f.properties.amenity === "cafe" || f.properties.amenity === "restaurant") && f.properties.name && !used.has((f.properties.name || "").trim())
        );
        if (pois.length === 0) continue;
        const byDist = [...pois].sort((a, b) => {
          const da = dist([a.geometry.coordinates[0], a.geometry.coordinates[1]], [lng, lat]);
          const db = dist([b.geometry.coordinates[0], b.geometry.coordinates[1]], [lng, lat]);
          return da - db;
        });
        const p = byDist[0];
        const name = (p.properties.name || "").trim();
        used.add(name);
        const [plng, plat] = p.geometry.coordinates;
        out.push({ lat: plat, lng: plng, label: `☕ ${name}`, type: "cafe", name, description: `${name} · café` });
      }
    }
  }

  if (intent === "lively" && !exclude.includes("lively")) {
    const midpoints = getSegmentMidpoints(routeCoords, 2);
    for (const { lng, lat } of midpoints) {
      let cultural = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = streetIdx.get(`${Math.round(lng * 1000) + dx},${Math.round(lat * 1000) + dy}`);
          if (cell) cultural += cell.reduce((s, f) => s + f.properties.cultural_score, 0) / cell.length;
        }
      }
      if (cultural > 0) {
        out.push({ lat, lng, label: "✨ Lively area", type: "lively", name: "Lively area", description: "Lively area · lively area" });
      }
    }
  }

  if (intent === "exercise" && !exclude.includes("nature")) {
    const midpoints = getSegmentMidpoints(routeCoords, 1);
    if (midpoints.length > 0) {
      const { lng, lat } = midpoints[0];
      const pois = nearbyPois(lng, lat, POI_SEARCH_RADIUS_M).filter(
        (f) => f.properties.leisure === "park" || f.properties.landuse === "grass" || (f.properties.name && /park|jard|verd/i.test(f.properties.name))
      );
      if (pois.length > 0) {
        const byDist = [...pois].sort((a, b) => {
          const da = dist([a.geometry.coordinates[0], a.geometry.coordinates[1]], [lng, lat]);
          const db = dist([b.geometry.coordinates[0], b.geometry.coordinates[1]], [lng, lat]);
          return da - db;
        });
        const p = byDist[0];
        const name = (p.properties.name || "Park").trim();
        const [plng, plat] = p.geometry.coordinates;
        out.push({ lat: plat, lng: plng, label: `🌿 ${name}`, type: "nature", name, description: `${name} · park` });
      }
    }
  }

  if (out.length === 0 && exclude.length > 0) {
    addComplementaryCultural();
  }

  const DEDUPE_M = 50;
  const deduped: RouteHighlightOut[] = [];
  for (const h of out) {
    const tooClose = deduped.some((d) => distM2(h, d) < DEDUPE_M * DEDUPE_M);
    if (!tooClose) deduped.push(h);
  }
  return deduped.slice(0, Math.max(1, maxPois)).map(({ lat, lng, label, type, name, description, photo_url, photo_urls, photoRefs }) => ({
    lat,
    lng,
    label,
    type,
    ...(name && { name }),
    ...(description && { description }),
    ...(photo_url != null && photo_url !== "" && { photo_url }),
    ...(photo_urls != null && photo_urls.length > 0 && { photo_urls }),
    ...(photoRefs != null && photoRefs.length > 0 && { photoRefs }),
  }));
}

// =============================================================
// SCORE A ROUTE against street quality data
// =============================================================
function scoreRoute(
  routeCoords: [number, number][],
  intent: Intent,
  streetIdx: Map<string, StreetFeature[]>
): { score: number; breakdown: { noise: number; green: number; clean: number; cultural: number }; tags: string[] } {
  const baseWeights = WEIGHT_PROFILES[intent];
  const weights = isAfterDarkInBarcelona()
    ? { ...baseWeights, noise: Math.max(baseWeights.noise, 0.35) }
    : baseWeights;

  let totalNoise = 0, totalGreen = 0, totalClean = 0, totalCultural = 0;
  let matchedPoints = 0;

  // Sample every ~3rd coordinate to keep scoring fast
  const step = Math.max(1, Math.floor(routeCoords.length / 100));

  for (let i = 0; i < routeCoords.length; i += step) {
    const [lng, lat] = routeCoords[i];
    const key = getGridKey(lng, lat);

    // Check this cell and adjacent cells
    const nearby: StreetFeature[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighborKey = `${Math.round(lng * 1000) + dx},${Math.round(lat * 1000) + dy}`;
        const cell = streetIdx.get(neighborKey);
        if (cell) nearby.push(...cell);
      }
    }

    if (nearby.length === 0) continue;

    // Find closest street segment (by centroid distance — good enough)
    let bestDist = Infinity;
    let bestFeat: StreetFeature | null = null;
    for (const feat of nearby) {
      const coords = feat.geometry.type === "MultiLineString"
        ? feat.geometry.coordinates.flat()
        : feat.geometry.coordinates;
      for (const c of coords as number[][]) {
        const d = (c[0] - lng) ** 2 + (c[1] - lat) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestFeat = feat;
        }
      }
    }

    if (bestFeat) {
      totalNoise += bestFeat.properties.noise_score;
      totalGreen += bestFeat.properties.green_score;
      totalClean += bestFeat.properties.clean_score;
      totalCultural += bestFeat.properties.cultural_score;
      matchedPoints++;
    }
  }

  if (matchedPoints === 0) {
    return { score: 0, breakdown: { noise: 0, green: 0, clean: 0, cultural: 0 }, tags: [] };
  }

  // Average scores along the route
  const avgNoise = totalNoise / matchedPoints;
  const avgGreen = totalGreen / matchedPoints;
  const avgClean = totalClean / matchedPoints;
  const avgCultural = totalCultural / matchedPoints;

  // Weighted composite score
  const score = (
    weights.noise * avgNoise +
    weights.green * avgGreen +
    weights.clean * avgClean +
    weights.cultural * avgCultural
  );

  // Generate human-readable tags for the summary
  const tags: string[] = [];
  if (avgNoise > 0.6) tags.push("quiet streets");
  if (avgGreen > 0.4) tags.push("tree-lined");
  if (avgCultural > 0.3) tags.push("culturally rich");
  if (avgClean > 0.9) tags.push("clean route");
  if (avgNoise < 0.3) tags.push("some busy streets");

  return {
    score,
    breakdown: {
      noise: Math.round(avgNoise * 100) / 100,
      green: Math.round(avgGreen * 100) / 100,
      clean: Math.round(avgClean * 100) / 100,
      cultural: Math.round(avgCultural * 100) / 100,
    },
    tags,
  };
}

// =============================================================
// BUILD ROUTE SUMMARY
// =============================================================
function buildSummary(duration: number, distance: number, tags: string[], intent: Intent, nightMode?: boolean): string {
  if (intent === "quick" && !nightMode) {
    return "direct route";
  }
  if (nightMode && intent === "quick") {
    return "well-lit route";
  }
  if (tags.length > 0) {
    return tags.slice(0, 3).join(" · ");
  }
  if (nightMode) {
    return "well-lit route";
  }
  return "pleasant route";
}

// =============================================================
// CALL ORS FOR ALTERNATIVE ROUTES
// =============================================================
async function fetchOrsRoutes(
  origin: [number, number],
  destination: [number, number],
  intent: Intent,
  forceAvoidZones?: boolean
): Promise<Array<{ coordinates: [number, number][]; duration: number; distance: number }>> {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) throw new Error("ORS_API_KEY not set in environment");

  const baseWeighting = ORS_WEIGHTINGS[intent] ?? {};
  const isNight = isAfterDarkInBarcelona() || forceAvoidZones === true;
  const effectiveWeighting = isNight ? { quiet: 0.6, green: 0.3 } : { ...baseWeighting };
  if (isNight) {
    effectiveWeighting.quiet = Math.max(effectiveWeighting.quiet ?? 0, 0.8);
    effectiveWeighting.green = Math.max(effectiveWeighting.green ?? 0, 0.3);
    console.log("[route] Night mode: boosting quiet/green weights");
  }

  // Night safe corridor rerouting
  if (isNight) {
    for (const corridor of NIGHT_SAFE_CORRIDORS) {
      if (routePassesNearZone(origin, destination, corridor.bbox)) {
        const safeWp = pickSafeWaypoint(origin, destination, corridor.waypoints);
        console.log(`[route] Night mode: rerouting via safe corridor (${corridor.zone})`);
        const safeRoute = await fetchOrsWaypointRoute(origin, [safeWp, destination], intent, true);
        return [{
          coordinates: safeRoute.coordinates,
          duration: safeRoute.duration,
          distance: safeRoute.distance,
        }];
      }
    }
  }

  const orsCoords = [
    [origin[1], origin[0]] as [number, number],
    [destination[1], destination[0]] as [number, number],
  ];
  console.log("[route] ORS coordinates (lng, lat):", { from: orsCoords[0], to: orsCoords[1] });
  const body: Record<string, unknown> = {
    coordinates: orsCoords,
    alternative_routes: {
      target_count: 3,
      share_factor: 0.6,
      weight_factor: 1.6,
    },
  };

  console.log("[route] ORS body:", JSON.stringify(body, null, 2));

  const res = await fetch(
    "https://api.openrouteservice.org/v2/directions/foot-walking/geojson",
    {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  console.log("[route] ORS response status:", res.status);
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`ORS API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();

  if (!data.features || data.features.length === 0) {
    throw new Error("No routes returned from ORS");
  }

  return data.features.map((feature: {
    geometry: { coordinates: [number, number][] };
    properties: { summary: { duration: number; distance: number } };
  }) => ({
    coordinates: feature.geometry.coordinates as [number, number][],
    duration: feature.properties?.summary?.duration ?? 0,
    distance: feature.properties?.summary?.distance ?? 0,
  }));
}

// =============================================================
// ISOCHRONE & LOOP ROUTE
// =============================================================
async function fetchIsochrone(
  originLat: number,
  originLng: number,
  rangeSeconds: number
): Promise<[number, number][]> {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) throw new Error("ORS_API_KEY not set");

  const res = await fetch("https://api.openrouteservice.org/v2/isochrones/foot-walking", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [[originLng, originLat]],
      range: [rangeSeconds],
      range_type: "time",
    }),
  });
  if (!res.ok) throw new Error(`ORS isochrone error: ${res.status}`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature?.geometry?.coordinates?.[0]) throw new Error("No isochrone polygon");
  const ring = feature.geometry.coordinates[0] as [number, number][];
  return ring;
}

function pickWaypointFromBoundary(
  intent: Intent,
  boundary: [number, number][],
  originLat: number,
  originLng: number,
  streetIdx: Map<string, StreetFeature[]>,
  maxDistanceM: number = MAX_WAYPOINT_DISTANCE_M,
  areaBbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null = null
): [number, number] {
  const sampleStep = Math.max(1, Math.floor(boundary.length / 50));
  const maxDistDeg = maxDistanceM / 111000;
  let candidates = boundary
    .filter((_, i) => i % sampleStep === 0)
    .filter((c) => {
      const lng = c[0], lat = c[1];
      if (!isOnLand(lat, lng)) return false;
      if (areaBbox) {
        if (lat < areaBbox.minLat || lat > areaBbox.maxLat || lng < areaBbox.minLng || lng > areaBbox.maxLng) return false;
      }
      return (lat - originLat) ** 2 + (lng - originLng) ** 2 <= maxDistDeg * maxDistDeg;
    });
  if (candidates.length === 0 && areaBbox) {
    candidates = boundary.filter((c) => {
      const lng = c[0], lat = c[1];
      return isOnLand(lat, lng) && lat >= areaBbox.minLat && lat <= areaBbox.maxLat && lng >= areaBbox.minLng && lng <= areaBbox.maxLng;
    });
  }
  if (candidates.length === 0) {
    candidates = boundary.filter((c) => isOnLand(c[1], c[0]));
  }
  if (candidates.length === 0) {
    const fallback = boundary[Math.floor(boundary.length / 2)];
    const lat = fallback[1], lng = fallback[0];
    if (isOnLand(lat, lng)) return [lat, lng];
    const onLand = boundary.find((c) => isOnLand(c[1], c[0]));
    if (onLand) return [onLand[1], onLand[0]];
    return [lat, lng];
  }

  const scorePoint = (lng: number, lat: number) => {
    const key = getGridKey(lng, lat);
    const cell = streetIdx.get(key);
    if (!cell?.length) return { green: 0, cultural: 0 };
    const avg = cell.reduce(
      (a, f) => ({
        green: a.green + f.properties.green_score,
        cultural: a.cultural + f.properties.cultural_score,
      }),
      { green: 0, cultural: 0 }
    );
    return { green: avg.green / cell.length, cultural: avg.cultural / cell.length };
  };

  const dist = (lng: number, lat: number) =>
    (lng - originLng) ** 2 + (lat - originLat) ** 2;

  if (intent === "exercise") {
    const furthest = candidates.reduce((a, b) =>
      dist(a[0], a[1]) > dist(b[0], b[1]) ? a : b
    );
    return [furthest[1], furthest[0]];
  }
  if (intent === "calm" || intent === "nature") {
    const best = candidates.reduce((a, b) => {
      const sa = scorePoint(a[0], a[1]);
      const sb = scorePoint(b[0], b[1]);
      return sa.green >= sb.green ? a : b;
    });
    return [best[1], best[0]];
  }
  if (intent === "discover") {
    const best = candidates.reduce((a, b) => {
      const sa = scorePoint(a[0], a[1]);
      const sb = scorePoint(b[0], b[1]);
      return sa.cultural >= sb.cultural ? a : b;
    });
    return [best[1], best[0]];
  }
  if (intent === "scenic") {
    const best = candidates.reduce((a, b) => {
      const sa = scorePoint(a[0], a[1]);
      const sb = scorePoint(b[0], b[1]);
      const combinedA = sa.green + sa.cultural;
      const combinedB = sb.green + sb.cultural;
      return combinedA >= combinedB ? a : b;
    });
    return [best[1], best[0]];
  }
  const random = candidates[Math.floor(Math.random() * candidates.length)];
  return [random[1], random[0]];
}

async function fetchOrsWaypointRoute(
  origin: [number, number],
  waypoints: [number, number][],
  intent: Intent,
  forceAvoidZones?: boolean,
  useHikingProfile?: boolean
): Promise<{ coordinates: [number, number][]; duration: number; distance: number }> {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) throw new Error("ORS_API_KEY not set");
  const baseWeighting = ORS_WEIGHTINGS[intent] ?? {};
  const isNight = isAfterDarkInBarcelona() || forceAvoidZones === true;
  const effectiveWeighting = isNight ? { quiet: 0.6, green: 0.3 } : { ...baseWeighting };
  if (isNight) {
    effectiveWeighting.quiet = Math.max(effectiveWeighting.quiet ?? 0, 0.8);
    effectiveWeighting.green = Math.max(effectiveWeighting.green ?? 0, 0.3);
    console.log("[route] Night mode: boosting quiet/green weights");
  }

  const coords = [
    [origin[1], origin[0]] as [number, number],
    ...waypoints.map(([lat, lng]) => [lng, lat] as [number, number]),
  ];
  const body: Record<string, unknown> = { coordinates: coords };

  const res = await fetch(
    `https://api.openrouteservice.org/v2/directions/${useHikingProfile ? "foot-hiking" : "foot-walking"}/geojson`,
    {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`ORS waypoint route error: ${res.status}`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature?.geometry?.coordinates) throw new Error("No waypoint route");
  const routeCoords = feature.geometry.coordinates as [number, number][];
  const duration = feature.properties?.summary?.duration ?? 0;
  const distance = feature.properties?.summary?.distance ?? 0;
  return { coordinates: routeCoords, duration, distance };
}

// =============================================================
// PATTERN & PARSING TYPES
// =============================================================
const INTENTS: Intent[] = ["calm", "discover", "nature", "scenic", "lively", "exercise", "cafe", "quick"];
const PATTERNS = [
  "mood_and_destination",
  "mood_and_area",
  "mood_and_poi",
  "mood_only",
  "destination_only",
  "themed_walk",
] as const;
export type RequestPattern = (typeof PATTERNS)[number];

export interface ParsedMoodRequest {
  intent: Intent;
  pattern: RequestPattern;
  destination: string | null;
  area: string | null;
  poi_type: string | null;
  poi_query: string | null;
  suggested_duration: number | null;
  max_duration_minutes: number | null;
  target_distance_km: number | null;
  theme_name: string | null;
  /** true when the walk is primarily about finding/seeing specific things (art, shopping, cafes to try). */
  poi_focus?: boolean;
  /** Google Places search terms matching the user's interest; used when poi_focus is true. */
  poi_search_terms?: string[];
  /** true when user said "surprise me" — skip duration picker and auto-pick duration on server. */
  skip_duration?: boolean;
  /** true when user explicitly asked for a loop (e.g. "30 min loop", "round walk"). When true + duration specified, we still show duration picker. */
  is_loop?: boolean;
}

async function parseMoodRequest(userInput: string): Promise<ParsedMoodRequest> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 150,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You parse walking requests in Barcelona, Spain. Analyze the user's input and extract structured information. Respond in JSON only.

Format:
{
  "intent": "calm|discover|nature|scenic|lively|exercise|cafe|quick",
  "pattern": "mood_and_destination|mood_and_area|mood_and_poi|mood_only|destination_only|themed_walk",
  "destination": "specific place name or null",
  "area": "neighborhood or area name or null",
  "poi_type": "cafe|restaurant|bar|bookshop|park|museum|gallery|market|bakery or null",
  "poi_query": "search query for Google Places or null",
  "suggested_duration": number or null,
  "max_duration_minutes": number or null,
  "target_distance_km": number or null,
  "theme_name": "short human-readable theme for the route or null",
  "poi_focus": true or false,
  "poi_search_terms": ["array", "of", "search", "terms"] or [],
  "skip_duration": true or false,
  "is_loop": true or false
}

skip_duration: Set to true when the user says "surprise me" or equivalent (random walk, surprise me, pick for me). When true, the app will skip the duration picker and auto-select a duration. Set to false otherwise.

is_loop: Set to true when the user explicitly asks for a loop/round walk (e.g. "30 min loop", "hour long loop", "round walk", "circular route"). When is_loop is true and they specify a duration, the app will still show the duration picker so they can confirm. When false or not a loop, and they specify a duration (e.g. "20min walk to Park Güell"), do not ask for duration and use that duration for the route.

poi_focus: true when the user's query is primarily about finding/seeing specific things (e.g. "art", "architecture", "street art", "shopping", "gift shopping", "souvenirs", "bookshops", "cafes to try", "markets"). false when the query is about the walk itself (e.g. "calm walk", "stressed need to walk", "nature", "exercise").

poi_search_terms: When poi_focus is true, provide 2-4 Google Places search terms that match the user's interest. Examples:
- "art" → ["art gallery", "street art", "mural", "museum"]
- "buy a gift" → ["gift shop", "souvenir shop", "boutique", "artisan shop"]
- "bookshops" → ["bookshop", "library", "book cafe"]
- "gaudi" or "gaudi tour" → ["Gaudí building", "modernisme architecture"]
- "street art" → ["street art", "mural", "graffiti"]
When poi_focus is false, set poi_search_terms to [].

Pattern decision rules:

IMPORTANT CLASSIFICATION RULES:
- If the user describes a VIBE or ACTIVITY without naming a specific place or type of business, classify as mood_only. Examples: 'calm walk', 'I want nature', 'show me something new', 'energetic walk' → mood_only. Exception: "something active outdoors", "hike", "trail", "workout walk" → mood_and_poi (see outdoor-activity rule).
- Only classify as mood_and_poi if the user names a SPECIFIC type of place to go TO: 'coffee shop', 'asian food', 'bookstore', 'museum' → mood_and_poi
- 'restaurant' IS a place type. "Something active outdoors", "hike", "trail", "workout walk" get mood_and_poi with outdoor poi_query so the user gets a destination first (not duration picker).
- 'show me something I've never seen' is mood_only, not mood_and_poi.
- 'surprise me' is mood_only.

- KEY: Does the user name a SPECIFIC PLACE (e.g. Sagrada Familia, Gràcia, Barceloneta) or just a VIBE/THEME (e.g. "architecture", "scenic", "calm by the beach")? If it's a vibe or theme with NO named place → mood_only (we will ask for duration). If they name a specific place or area → has destination (mood_and_destination or mood_and_area).
- Open-ended vibe/theme with no specific destination → mood_only: "scenic walk", "peaceful stroll", "pretty route" = mood_only (no POI, no destination; we ask duration). Exception: "architecture hunt", "architecture walk", "see cool buildings" → themed_walk (see architecture rule below).
- ARCHITECTURE: "architecture hunt", "architecture walk", "see cool buildings" → themed_walk with poi_query "notable architecture landmark building Barcelona", theme_name "architecture hunt". Do NOT use "architecture" alone — it returns offices/firms. For Barcelona, target Modernisme buildings, churches, notable facades. "architecture hunt in [area]" → themed_walk with poi_query "notable architecture landmark building [area] Barcelona", area: "[area]", theme_name "architecture hunt".
- Specific place or area → has destination: "walk to Sagrada Familia", "cafe near Gràcia", "route to Park Güell", "get me to Barceloneta" = mood_and_destination or mood_and_area (do not ask duration).
- If the user wants to GO TO a specific named place → mood_and_destination
- If the user wants to GO TO a type of place (one cafe, one gym) → mood_and_poi
- If the user wants to WALK PAST multiple places of a theme → themed_walk
- If the user wants to wander with no destination → mood_only
- 'discover Gaudi' = themed_walk (walk past Gaudi buildings, not go to one)
- 'find a cafe' = mood_and_poi (go to one specific cafe)
- 'cafe hopping' = themed_walk (walk past multiple cafes)
- 'food hunt' = themed_walk
- 'architecture trail' = themed_walk
- 'surprise me' = mood_only with discover intent. Also set skip_duration: true so the duration picker is skipped.

Destination vs walk feeling: If the user describes an ACTIVITY or PLACE TYPE they want to visit (e.g., "something active indoors", "a cozy bookshop", "live music"), classify as mood_and_poi and generate a poi_query for Google Places. The intent should describe the WALK to get there (e.g., scenic, calm, quick), not the activity itself. "I want a calm walk" = mood_only with intent calm (no POI). "Something active indoors" = mood_and_poi with poi_query like "indoor activities Barcelona" or "climbing gym Barcelona", intent e.g. quick or calm for the walk.
- NAMED HIKING AREA TAKES PRIORITY: When the user names a known hiking/nature area (Montjuïc, Tibidabo, Collserola, El Carmel, Carmel) plus "hike", "walk", or "trail" (e.g. "Montjuïc hike", "monjuic hike", "Tibidabo walk", "Collserola trail"), ALWAYS use mood_and_area with that area and intent nature — NOT mood_and_poi. The app uses curated waypoints for these areas; do not return place_options.
- "something active outdoors", "active outdoors", "outdoor exercise", "hike", "trail" (without a named area above) → mood_and_poi with intent exercise and poi_query "Montjuïc park hiking trail viewpoint Barcelona". This finds actual outdoor activity spots, not tour companies. Do NOT classify as mood_only.
- "go for a run", "running route", "jog", "get my steps in" → mood_only with intent exercise (these are duration-based loop routes, not destination-based).

- GENERIC vs SPECIFIC place requests: If the user asks for A SPECIFIC named place ("Hospital Clínic", "ELISAVA", "Sagrada Familia") → mood_and_destination with that name. If the user asks for a GENERIC type of place ("a hospital", "a pharmacy", "a cafe", "somewhere to eat") → mood_and_poi with a poi_query to search nearby. "walk to Hospital Clínic" = mood_and_destination, destination "Hospital Clínic". "walk to a hospital" = mood_and_poi, poi_query "hospital Barcelona". "find me a pharmacy" = mood_and_poi, poi_query "pharmacy Barcelona". The article "a/an" or phrasing like "find me", "nearest", "closest" signals a GENERIC search, not a specific destination.
- NEAR [PLACE] pattern: When the user says "near X", "close to X", "around X", or "by X" where X is a specific named place (not an area/neighborhood), this means SEARCH NEAR that place, not FROM that place. Set pattern to mood_and_poi, and set the "area" field to the named place so the search is centered there. Examples: "bar for groups near ELISAVA" → mood_and_poi, poi_query "bar for groups Barcelona", area "ELISAVA". "coffee near Sagrada Familia" → mood_and_poi, poi_query "coffee shop Barcelona", area "Sagrada Familia". "restaurant near the beach" → mood_and_poi, poi_query "restaurant Barcelona", area "Barceloneta". This is DIFFERENT from "in [neighborhood]" which means explore within an area. "near ELISAVA" = search centered on ELISAVA. "in Gràcia" = explore Gràcia.
- ON THE WAY / STOP pattern: When the user says "pick up X on the way to Y", "stop at X on the way to Y", "grab X before going to Y", or similar multi-stop requests, classify as themed_walk with destination: Y (final destination), poi_query: search query for X (the stop), theme_name: short label like "matcha stop → beach". Examples: "pick up matcha on the way to the beach" → themed_walk, destination "Barceloneta", poi_query "matcha cafe Barcelona", theme_name "matcha stop → beach". "grab coffee then go to ELISAVA" → themed_walk, destination "ELISAVA", poi_query "coffee shop Barcelona", theme_name "coffee → ELISAVA".
- When the user wants to visit MULTIPLE places of the same type in a browsing/crawl style, classify as themed_walk. "bookshop to browse" → themed_walk, poi_query "independent bookshop Barcelona", theme_name "bookshop crawl". "gallery hopping" → themed_walk, poi_query "art gallery Barcelona", theme_name "gallery trail". "vintage shopping" → themed_walk, poi_query "vintage shop second hand Barcelona", theme_name "vintage shopping trail". "market tour" → themed_walk, poi_query "market Barcelona", theme_name "market tour". Single visit ("find a bookshop", "take me to a bookshop") → mood_and_poi. Browsing/multiple ("bookshop crawl", "bookshops to browse", "browse bookshops") → themed_walk.

Duration and distance parsing:
- When the user specifies a duration in their query ("30 min walk", "1 hour loop", "45 minute stroll"), ALWAYS set suggested_duration to that number in minutes. Do NOT leave it null when a duration is explicitly stated.
- When user specifies time for a point-to-point: "20min walk to Park Güell", "30 min walk to the beach" → max_duration_minutes: 20 or 30 (route should match that duration; do not ask for duration).
- "within 30 mins" or "30 min walk" (as a constraint, not loop length) → max_duration_minutes: 30
- DURATION + INDIFFERENCE: When the user specifies both a duration AND indifference about where to go (e.g. "20 minute dont care where", "30 min surprise me", "15 min anywhere", "20 min don't care", "25 min whatever"), set pattern mood_only, suggested_duration to the stated minutes (as a number), skip_duration true, intent discover. Do NOT ask for duration — the route will be randomised but fit within the specified time. Example: "20 minute dont care where" → pattern mood_only, suggested_duration 20, skip_duration true, intent discover. When the user specifies a duration AND indicates indifference about destination, ALWAYS set skip_duration true AND suggested_duration to the stated time. Do NOT ask for duration again.
- "don't care where", "anywhere", "no preference", "whatever", "just walk", "20 min walk" (time but no destination/mood) → mood_only, intent discover, skip_duration true, suggested_duration: extracted time or 20 if not specified. "20 minutes, don't care where" → mood_only, intent discover, suggested_duration 20, skip_duration true.
- "10k run" or "10km route" → target_distance_km: 10
- "5k walk" → target_distance_km: 5
- "hour long walk" (loop length, no destination) → suggested_duration: 60, is_loop: false unless they say "loop"
- "30 min loop", "round walk", "circular route" → mood_only, intent based on mood (calm if unspecified), is_loop: true, suggested_duration from stated time or 30, skip_duration: true (do not show duration picker).
- "1 hour walk" → mood_only, intent: calm, suggested_duration: 60, skip_duration: true
- "hour long loop" → suggested_duration: 60, is_loop: true, skip_duration: true
- max_duration_minutes = hard cap on route duration for point-to-point. suggested_duration = desired loop length when no destination.

Step count conversion (approx 2000 steps per km for walking):
- "5000 steps" or "5k steps" → target_distance_km: 2.5
- "10000 steps" or "10k steps" → target_distance_km: 5
- "15000 steps" → target_distance_km: 7.5
- "get my steps in" without a number → use suggested_duration or leave target_distance_km null

Intent mapping rules:
- calm/peaceful: "clear my mind", "quiet stroll", "destress", "peaceful"
- discover/explore: "show me something new", "surprise me", "explore", "hidden gems"
- scenic/beautiful: "pretty walk", "nice route", "beautiful streets", "scenic". romantic, date night, evening stroll → intent: scenic (quiet, beautiful streets — not busy/loud)
- nature/green: "parks", "trees", "fresh air", "garden", "beach"
- lively/buzzy: "energy", "vibrant", "bustling", "lively neighborhood"
- exercise/steps: "long walk", "hilly", "workout walk". "something active outdoors", "active outdoors", "outdoor exercise", "hike", "trail" (when no named hiking area) → mood_and_poi with intent exercise, poi_query "Montjuïc park hiking trail viewpoint Barcelona". "Montjuïc hike", "Tibidabo walk", "Collserola trail" etc. → mood_and_area (see NAMED HIKING AREA rule). "go for a run", "running route", "jog", "get my steps in" → mood_only with intent exercise (duration-based loop).
- cafe/food: "cafe", "coffee", "matcha", "food", "restaurant", "tapas", "brunch"
- quick: "fast", "direct", "hurry", "late", "shortest", "efficient", "rush", "in a rush", "rushing", "urgent", "emergency", "asap", "quickly", "running late", "need to be there", "don't want to be late", "appointment"
- URGENCY OVERRIDE: If the user expresses urgency, time pressure, or uses words like "rush", "hurry", "late", "emergency", "urgent", "asap", or mentions a time constraint like "I need to be there by 3", ALWAYS set intent to "quick" regardless of other mood words. Urgency beats mood. "I'm in a rush to the hospital" = intent quick, NOT calm or scenic.
- COMPOUND "quick but nice/pretty/scenic": When the user wants both speed AND pleasantness (e.g. "quick but nice walk to X", "fastest pretty route", "get there fast but make it nice"), set intent to "scenic" (so the recommended route is pleasant). The app will show the pleasant route as recommended and the fastest route prominently via the existing Switch option. Classify intent as "scenic" for these.
- TIME-AWARE QUERIES: When the user mentions time of day or night, adjust intent accordingly. "late night walk" → intent calm (quiet, well-lit streets preferred). "late night walk, feeling unsafe" → intent calm, theme_name "night_safety". "evening stroll" → intent scenic. "morning walk" → intent nature. "sunrise walk" → intent nature. The app applies after-dark safety weighting automatically based on actual time — the LLM just sets the right mood intent. If the user explicitly mentions feeling unsafe at night, set theme_name to "night_safety" so the app can add extra reassurance.

Examples:
- "walk to hospital clinic, I'm in a rush" → intent: quick, pattern: mood_and_destination, destination: "Hospital Clínic"
- "get me to ELISAVA fast" → intent: quick, pattern: mood_and_destination
- "quick but nice walk to ELISAVA" → intent: scenic, pattern: mood_and_destination
- "I'm late for class at ELISAVA" → intent: quick, pattern: mood_and_destination
- "need to be at Sagrada Familia by 3" → intent: quick, pattern: mood_and_destination

EMOTIONAL SENSITIVITY: When the user expresses distress, sadness, or vulnerability, respond with care. "I want to cry somewhere private", "need to be alone", "somewhere private to sit" → mood_and_poi, intent calm, poi_query "quiet courtyard garden hidden plaza bench Barcelona", theme_name "emotional_support". "I need to clear my head" → mood_only, intent calm. "feeling overwhelmed" → mood_only, intent calm, theme_name "emotional_support". "I just need to breathe" → mood_only, intent nature. For emotional_support, poi_query must target NEARBY, QUIET, NON-TOURISTY places. NEVER suggest: major tourist attractions (Park Güell, Sagrada Familia, La Rambla), parks that are far away or require long walks, busy plazas or commercial areas. Good: small neighbourhood plazas, church courtyards, quiet garden corners, university cloisters, hidden patios. Example poi_queries: "quiet courtyard cloister hidden garden Barcelona", "peaceful plaza bench quiet park Barcelona". NOT "park Barcelona" (returns Park Güell). When theme_name is "emotional_support", the app will use a gentler tone and avoid unsafe zones regardless of time.

Themed_walk: User wants a route that passes by multiple places of a theme. Set poi_type and intent from theme. Set poi_query to search for multiple POIs, e.g. "Gaudi buildings Barcelona", "street art murals Barcelona", "independent bookshops Barcelona". Set theme_name to a short label like "Gaudí architecture trail" or "Food hunt".

For place-finding (mood_and_poi), generate specific Google Places search queries; include 'Barcelona' in every poi_query.
- HIDDEN/LOCAL/AUTHENTIC QUERIES: When the user asks for "hidden gem", "local spot", "authentic", "off the beaten path", "non-touristy", "where locals go", "undiscovered", or similar language expressing desire for less mainstream places:
  - ALWAYS add neighborhood specificity to poi_query: "independent cafe El Born" NOT "cafe Barcelona"
  - Use adjectives that filter for local character: "traditional", "independent", "family-run", "neighborhood", "local"
  - AVOID generic terms that return chains: "best cafe", "top restaurant", "popular bar"
  - For food/drink: "traditional tapas bar Gràcia", "neighborhood wine bar El Born", "family-run bakery Eixample"
  - For culture: "independent gallery Raval", "neighborhood bookshop Gràcia", "local artisan shop Born"
  - For general discovery: "hidden courtyard Gothic Quarter", "local market Sants", "traditional workshop Poble-sec"
  - Set intent to "discover" if not already set
  - If user specifies an area, use that area. If not, pick a characterful neighborhood: El Born, Gràcia, Poble-sec, Sant Antoni, Poblenou — NOT Eixample or La Rambla
- When the user's query implies a PLACE or LANDMARK (not a business to visit), generate poi_query terms that find places, not businesses. "walk to Barceloneta but make it pretty" → the destination is Barceloneta (an area), not a business. Set pattern mood_and_area, area "Barceloneta", intent scenic. Do NOT set poi_query — the area routing handles this. "walk past interesting buildings" → themed_walk with poi_query about architecture/buildings, not businesses.
- Activity-based place finding: When the user describes an ACTIVITY they want to DO at a destination (read, sketch, journal, sit, picnic, sunbathe, meditate, work outside), classify as mood_and_poi with a poi_query that finds appropriate PLACES for that activity. "somewhere to read outside" → mood_and_poi, poi_query "quiet park bench garden plaza Barcelona", intent calm. "place to sketch" → mood_and_poi, poi_query "scenic plaza garden viewpoint Barcelona", intent scenic. "somewhere to sit and have lunch" → mood_and_poi, poi_query "park plaza bench garden Barcelona", intent calm. "place to work outside" → mood_and_poi, poi_query "cafe with terrace outdoor seating Barcelona", intent calm.

For Barcelona-specific inference:
- 'the beach' or 'beach' = area 'Barceloneta'
- 'by the beach', 'along the beach', 'near the beach', 'beach walk', 'by the sea', 'seaside' = mood_and_area, area 'Barceloneta'
- 'along the waterfront', 'by the waterfront', 'waterfront walk', 'by the water', 'near water', 'near the water' = mood_and_area, area 'waterfront'
- 'along the coast', 'coastal walk' = mood_and_area, area 'Barceloneta'
- IMPORTANT: If the user mentions a LOCATION like beach, waterfront, a neighborhood, or a landmark as part of their walk description, this is a SPATIAL CONSTRAINT — classify as mood_and_area (not mood_only), even if the overall request is vibe-based. "Calm walk by the beach" = mood_and_area with area 'Barceloneta' and intent 'calm'. "Explore near the waterfront" = mood_and_area with area 'waterfront' and intent 'discover'.
- Directional requests toward the coast: "towards the sea", "to the sea", "to the beach", "towards the water", "head to the coast", "oceanside" → mood_and_area with area "Barceloneta" or area "waterfront", intent based on mood. These are directional requests — the user wants to walk TOWARD the coast, not to a specific destination. Do NOT classify as mood_only; mood_only's random waypoint picker will miss the directional intent.
- "go towards the sea for 1 hour" → mood_and_area, area "waterfront", intent calm, suggested_duration 60
- 'the port' or 'harbor' = area 'Port Vell'
- 'old town' or 'old city' = area 'Barri Gotic'
- 'the mountain' = area 'Montjuic' or 'Tibidabo'
- "the mountains", "walk to the mountains", "hike to the mountains" → if no specific mountain/park named, classify as mood_and_area with area "Collserola" or "Tibidabo" (closest mountain area). If distance exceeds walking range, the existing max distance check will catch it.
- "Tibidabo walk", "Montjuïc hike", "monjuic hike", "Montjuic walk", "[nature area] trail" (e.g. "Collserola trail") → mood_and_area, area "[place]" (use the area name: Montjuïc, Tibidabo, Collserola, El Carmel), intent nature. Treat "monjuic" as Montjuïc. Area exploration uses curated waypoints; do not return place_options.
- 'in Eixample', 'explore Eixample', 'discovery in Eixample', 'walk in Eixample' = pattern mood_and_area, area 'Eixample'
- Any named neighborhood (Eixample, Gràcia, Raval, Barceloneta, etc.) as the focus of the walk = mood_and_area with that area name
- When pattern is mood_and_area with a theme (e.g. "architecture hunt in Born"), set poi_query to a relevant Google Places search query for that theme (e.g. "notable architecture buildings Born Barcelona", "Gothic architecture Born Barcelona"). This helps find theme-relevant POIs within the area.
- "Gaudí-inspired" or "Gaudí style" or "like Gaudí" or "Modernisme" or "Art Nouveau Barcelona" → themed_walk with poi_query "Modernisme Art Nouveau architecture buildings Barcelona" (NOT just Gaudí — include Domènech i Montaner, Puig i Cadafalch, and other Modernista architects). theme_name "Modernisme trail".
- "Gaudí tour" or "Gaudí buildings" or "see Gaudí" → themed_walk with poi_query "Gaudí architecture buildings Barcelona", theme_name "Gaudí trail".
- These are DIFFERENT: "Gaudí-inspired" = broader Modernisme movement. "Gaudí tour" = specifically Gaudí's works.
- KID-FRIENDLY: "kid-friendly", "with kids", "family walk", "child-friendly", "toddler-friendly", "stroller-friendly" → mood_and_poi or themed_walk with poi_query targeting FAMILY-APPROPRIATE places only: "playground park garden family activity Barcelona". Do NOT use "kid-friendly" as a raw Google Places search — it returns irrelevant results. Map to concrete family places: parks, playgrounds, gardens, family museums, ice cream shops. "kid-friendly exploration walk" → themed_walk, intent discover, poi_query "playground park garden family museum Barcelona", theme_name "family exploration". NEVER suggest adult-oriented venues (bars, nightlife, centres for adults) for kid-friendly requests.
- MEDICAL/EMERGENCY places: When the user asks for a hospital, clinic, pharmacy, or medical facility (especially with urgency language), set poi_query to specifically search for MEDICAL facilities, not architectural landmarks. "rush to hospital" = mood_and_poi, poi_query "hospital emergency room Barcelona", intent quick. "find a pharmacy" = mood_and_poi, poi_query "pharmacy farmacia Barcelona", intent quick. Do NOT return famous hospital buildings like Hospital de Sant Pau (which is a museum/monument). Use terms like "medical center", "hospital urgencias", "clinic medical" to find actual medical facilities.

EDGE CASE HANDLING — for unusual or unsupported inputs, still return valid JSON but use these special patterns:
- TOO VAGUE (e.g. "walk", "go", "idk", just a single word with no context): Return mood_only with intent "discover", skip_duration false, and set theme_name to "need_nudge". The app will show a playful prompt asking for more detail.
- "take me home" or "go home" or "walk home": Return mood_only with intent "quick" and theme_name "needs_home_address". The app will ask the user to set a home address.
- "somewhere safe", "safe route", "I don't feel safe", "safety" — ONLY when the ENTIRE request is about safety with no destination or area specified → theme_name "safety_baseline". If the user mentions a specific place AND safety/night concerns, still route them there — do NOT return safety_baseline. "el raval at 12am" = mood_and_area, area "El Raval", intent calm. "late night walk in Gothic Quarter" = mood_and_area, area "Barri Gotic", intent calm. The safety scoring handles the rest automatically. Time mentions like "at 12am", "at night", "late night" should NOT trigger safety_baseline; they should just set intent to calm (which prioritizes quieter, safer streets).
- "I don't know what I want", "no idea", "help me decide", "suggest something": Return mood_only with intent "discover", skip_duration true, and theme_name "surprise_me". Treat exactly like "surprise me".
- "not [place]", "avoid [place]", "anywhere but [place]" (avoidance-only, no positive intent): Return mood_only with intent "discover", skip_duration true, and theme_name "avoidance_only". Set destination to null. The app will handle the avoidance.
- Out of Barcelona: "walk to Madrid", "route to Paris", "walk to [city outside BCN]": Return destination_only with destination set to the city name and theme_name "out_of_range".
- "wheelchair accessible", "accessible route", "step-free": Return mood_only with intent "calm" and theme_name "accessibility_request".

These theme_name values are signals for the app to show specific UI messages instead of generating routes.

If no mood is detectable, default intent to 'calm' for wandering or 'quick' for specific destinations.`,
        },
        { role: "user", content: userInput },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  let parsed: Partial<ParsedMoodRequest>;
  try {
    parsed = JSON.parse(raw) as Partial<ParsedMoodRequest>;
  } catch {
    return {
      intent: "calm",
      pattern: "mood_only",
      destination: null,
      area: null,
      poi_type: null,
      poi_query: null,
      suggested_duration: null,
      max_duration_minutes: null,
      target_distance_km: null,
      theme_name: null,
      poi_focus: false,
      poi_search_terms: [],
      skip_duration: false,
      is_loop: false,
    };
  }
  const rawSuggested =
    typeof parsed.suggested_duration === "number"
      ? parsed.suggested_duration
      : typeof parsed.suggested_duration === "string"
        ? Number(parsed.suggested_duration)
        : null;
  const suggestedDuration =
    rawSuggested != null && Number.isFinite(rawSuggested) && rawSuggested > 0
      ? Math.min(120, Math.round(rawSuggested))
      : null;
  const rawMax =
    typeof parsed.max_duration_minutes === "number"
      ? parsed.max_duration_minutes
      : typeof parsed.max_duration_minutes === "string"
        ? Number(parsed.max_duration_minutes)
        : null;
  const maxDurationMinutes =
    rawMax != null && Number.isFinite(rawMax) && rawMax > 0
      ? Math.min(120, Math.round(rawMax))
      : null;
  const targetDistanceKm =
    typeof parsed.target_distance_km === "number" &&
    Number.isFinite(parsed.target_distance_km) &&
    parsed.target_distance_km > 0
      ? Math.min(50, Math.round(parsed.target_distance_km * 10) / 10)
      : null;
  const themeName =
    parsed.theme_name != null && String(parsed.theme_name).trim() !== ""
      ? String(parsed.theme_name).trim()
      : null;

  const poi_search_terms = Array.isArray(parsed.poi_search_terms)
    ? (parsed.poi_search_terms as string[]).filter((t) => typeof t === "string" && t.trim() !== "")
    : [];
  const isLoop = parsed.is_loop === true;

  return {
    intent: INTENTS.includes(parsed.intent as Intent) ? (parsed.intent as Intent) : "calm",
    pattern: PATTERNS.includes(parsed.pattern as RequestPattern) ? (parsed.pattern as RequestPattern) : "mood_only",
    destination: parsed.destination != null && String(parsed.destination).trim() !== "" ? String(parsed.destination).trim() : null,
    area: parsed.area != null && String(parsed.area).trim() !== "" ? String(parsed.area).trim() : null,
    poi_type: parsed.poi_type != null && String(parsed.poi_type).trim() !== "" ? String(parsed.poi_type).trim() : null,
    poi_query: parsed.poi_query != null && String(parsed.poi_query).trim() !== "" ? String(parsed.poi_query).trim() : null,
    suggested_duration: suggestedDuration,
    max_duration_minutes: maxDurationMinutes,
    target_distance_km: targetDistanceKm,
    theme_name: themeName,
    poi_focus: parsed.poi_focus === true,
    poi_search_terms: poi_search_terms,
    skip_duration: parsed.skip_duration === true,
    is_loop: isLoop,
  };
}

async function geocodePlace(placeName: string): Promise<{ lat: number; lng: number } | null> {
  const query = `${placeName} Barcelona Spain`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "reRoute-prototype/1.0" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { lat?: string; lon?: string }[];
  const first = data?.[0];
  if (!first?.lat || !first?.lon) return null;
  const lat = parseFloat(first.lat);
  const lng = parseFloat(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export interface PlaceOptionResult {
  name: string;
  /** Short descriptor for the card (replaces address). */
  description: string | null;
  lat: number;
  lng: number;
  rating: number | null;
  summary: string | null;
  photo_url: string | null;
  /** Google Places primaryType (e.g. restaurant, cafe) — used to default to fastest route for establishments. */
  primary_type?: string | null;
  review_snippet?: string | null;
}

// Re-rank places: prefer hidden gems (high rating, fewer reviews) over mainstream
const CHAIN_NAMES = [
  "starbucks", "mcdonalds", "burger king", "subway", "costa coffee",
  "dunkin", "dominos", "pizza hut", "kfc", "papa johns",
  "hard rock", "fridays", "wagamama", "five guys", "pans company",
  "tim hortons", "pret a manger", "eat", "nandos",
];

function isObjectiveBasedSearch(poiQuery: string | null, moodText: string | null): boolean {
  if (!poiQuery && !moodText) return false;
  const text = `${poiQuery || ""} ${moodText || ""}`.toLowerCase();
  const objectiveKeywords = [
    "laptop", "wifi", "work", "coworking", "co-working", "study", "studying",
    "meeting", "group", "large group", "party", "birthday", "event",
    "reservation", "book", "private room", "private dining",
    "parking", "accessible", "wheelchair",
    "kids", "children", "playground", "family",
    "pet friendly", "dog friendly",
    "late night", "open late", "24 hour",
    "delivery", "takeaway", "takeout",
  ];
  return objectiveKeywords.some((kw) => text.includes(kw));
}

function rerankPlacesForLocalCharacter(places: PlaceOptionResult[]): PlaceOptionResult[] {
  const scoredPlaces = places.map((place) => {
    let localScore = 0;
    const nameLower = (place.name || "").toLowerCase();
    if (CHAIN_NAMES.some((chain) => nameLower.includes(chain))) {
      localScore -= 50;
    }
    const rating = place.rating || 0;
    const reviewCount = (place as { userRatingCount?: number; user_ratings_total?: number }).userRatingCount
      ?? (place as { userRatingCount?: number; user_ratings_total?: number }).user_ratings_total ?? 0;
    if (rating >= 4.3 && reviewCount < 500) localScore += 20;
    if (rating >= 4.3 && reviewCount < 200) localScore += 15;
    if (reviewCount > 2000) localScore -= 10;
    const hasNonAscii = /[àáèéìíòóùúñçü]/i.test(place.name || "");
    if (hasNonAscii) localScore += 5;
    return { ...place, _localScore: localScore };
  });
  scoredPlaces.sort((a, b) => {
    if (b._localScore !== a._localScore) return b._localScore - a._localScore;
    return (b.rating || 0) - (a.rating || 0);
  });
  return scoredPlaces.map(({ _localScore, ...rest }) => rest as PlaceOptionResult);
}

/** Truncate string to at most maxWords words. */
function truncateToWords(s: string, maxWords: number): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  const words = trimmed.split(/\s+/).slice(0, maxWords);
  return words.join(" ");
}

/** Strip trailing commas, semicolons, colons, periods, and whitespace from POI descriptions. */
function trimTrailingPunctuation(s: string | undefined | null): string {
  if (!s) return "";
  return s.replace(/[\s,;:.!]+$/, "").trim();
}

/** Map Places API primaryType to a short human-readable label (fallback only). */
function placeTypeToLabel(primaryType: string | undefined): string {
  if (!primaryType) return "place";
  const t = primaryType.toLowerCase();
  if (t.includes("restaurant") || t.includes("meal")) return "restaurant";
  if (t.includes("cafe") || t.includes("coffee")) return "café";
  if (t.includes("bar")) return "bar";
  if (t.includes("museum")) return "museum";
  if (t.includes("park")) return "park";
  if (t.includes("tourist")) return "attraction";
  if (t.includes("market")) return "market";
  if (t.includes("store") || t.includes("shop")) return "shop";
  if (t.includes("bakery")) return "bakery";
  if (t.includes("food")) return "food";
  return primaryType.replace(/_/g, " ");
}

/** Build a broader place query for fallback when the first search returns few results. */
function simplifyPoiQueryForFallback(poiQuery: string): string | null {
  const q = poiQuery.trim().toLowerCase();
  if (!q) return null;
  // Strip leading adjectives and filler so "cool underground bar for drinks" → "underground bar for drinks" or "bar drinks"
  const stripped = q
    .replace(/\b(cool|nice|best|good|great|chill|relaxed|hidden|secret|cozy|trendy|hip)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return null;
  // Prefer a short query that keeps the place type: take last 2 words or "bar"/"cafe" etc. + Barcelona
  const hasBar = /\bbar\b/.test(q);
  const hasCafe = /\bcafe\b|\bcoffee\b|\bcafé\b/.test(q);
  const hasRestaurant = /\brestaurant\b|\bfood\b|\beat\b/.test(q);
  const typePart = hasBar ? "bar" : hasCafe ? "cafe" : hasRestaurant ? "restaurant" : null;
  const fallback = typePart ? `${typePart} Barcelona` : `${words.slice(-2).join(" ")} Barcelona`;
  return fallback.trim() !== q ? fallback : null;
}

async function rerankByObjectiveFit(
  places: PlaceOptionResult[],
  userQuery: string
): Promise<PlaceOptionResult[]> {
  if (places.length === 0) return places;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return places;

  const placeList = places
    .map((p, i) => {
      let line = `${i + 1}. ${p.name}`;
      if (p.description) line += ` (${p.description})`;
      if (p.rating) line += ` - ${p.rating}★`;
      if ((p as { review_snippet?: string | null }).review_snippet) line += ` | Reviews: ${(p as { review_snippet: string }).review_snippet.substring(0, 150)}`;
      return line;
    })
    .join("\n");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 400,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `You are evaluating places in Barcelona for a SPECIFIC functional need. The user wants: "${userQuery}".

For each place, return a JSON array of objects with:
- index (1-based, matching the input order)
- fit_score (0-10, how well this place meets the SPECIFIC need)
- reason (3-5 words explaining the fit)

Use your knowledge of Barcelona places. Score based on:
- Review data (if provided): Look for SPECIFIC KEYWORDS that match the user's need. "wifi" or "laptop" in reviews = strong signal for coworking. "spacious" or "big tables" = good for groups. Quote the relevant keyword in your reason if found.
- 8-10: You are confident this place meets the need (name contains the keyword, or you specifically know this place offers it)
- 5-7: Plausible but uncertain (large cafe that might have wifi, brunch spot that could accommodate laptops)
- 1-4: Unlikely to fit (small specialty coffee bar for laptop work, tiny tapas bar for large groups, bakery for coworking)

IMPORTANT:
- "Laptop friendly" means: big tables, wifi, power sockets, tolerates long stays. Small specialty coffee bars and bakeries score LOW (1-3).
- "Group" or "large group" means: can seat 8+, has reservations. Tiny cafes score LOW.
- "Kid friendly" means: space for strollers, high chairs, kid menu. Cocktail bars score LOW.
- "Late night" means: open past 11pm. Brunch spots score LOW.
- Do NOT give a 5 just because you're unsure — if the place type fundamentally conflicts with the need, give 1-3.
- A brunch/cocktail spot is NOT laptop friendly unless you specifically know it is.
- A specialty coffee roaster with 10 seats is NOT laptop friendly.

Reply with ONLY a valid JSON array, nothing else.`,
          },
          { role: "user", content: `Places:\n${placeList}` },
        ],
      }),
    });

    if (!res.ok) return places;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    const cleanText = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleanText) as Array<{ index: number; fit_score: number; reason: string }>;

    // Apply scores and re-sort
    const scored = places.map((place, i) => {
      const match = parsed.find((p) => p.index === i + 1);
      return {
        ...place,
        _fitScore: match?.fit_score ?? 5,
        description:
          match?.reason && match.fit_score >= 6
            ? trimTrailingPunctuation(truncateToWords(match.reason, 8))
            : place.description,
      };
    });

    // Sort by fit score descending, then rating as tiebreaker
    scored.sort((a, b) => {
      if (b._fitScore !== a._fitScore) return b._fitScore - a._fitScore;
      return (b.rating || 0) - (a.rating || 0);
    });

    // Filter out clearly bad fits (score <= 3) if we have enough good ones
    const goodFits = scored.filter((s) => s._fitScore > 3);
    const results = goodFits.length >= 2 ? goodFits : scored;

    console.log("[rerank] Objective fit scores:", scored.map((s) => ({ name: s.name, fit: s._fitScore, desc: s.description })));

    return results.map(({ _fitScore, ...rest }) => rest as PlaceOptionResult);
  } catch (err) {
    console.error("[rerank] rerankByObjectiveFit failed:", err);
    return places;
  }
}

async function searchPlace(
  query: string,
  nearLat: number,
  nearLng: number,
  maxResults: number = 3,
  radiusMeters: number = 3000
): Promise<PlaceOptionResult[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY not set");
  const radiusBarcelona = Math.min(radiusMeters, 4000);

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.location,places.photos,places.rating,places.editorialSummary,places.primaryType,places.reviewSummary,places.reviews",
    },
    body: JSON.stringify({
      textQuery: query,
      locationBias: {
        circle: {
          center: { latitude: nearLat, longitude: nearLng },
          radius: Math.max(500, Math.min(50000, radiusBarcelona)),
        },
      },
      maxResultCount: Math.min(10, Math.max(1, maxResults)),
    }),
  });

  if (!res.ok) return [];
  const data = (await res.json()) as {
    places?: Array<{
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
      rating?: number | null;
      editorialSummary?: { text?: string } | null;
      photos?: Array<{ name?: string }>;
      primaryType?: string;
      reviewSummary?: { text?: string } | null;
    }>;
  };
  const places = data.places ?? [];
  const out: PlaceOptionResult[] = [];
  const needLlmDescription: { name: string; primaryType?: string; index: number }[] = [];
  for (let idx = 0; idx < places.length; idx++) {
    const place = places[idx];
    if (place.location?.latitude == null || place.location?.longitude == null) continue;
    const lat = Number(place.location.latitude);
    const lng = Number(place.location.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!isInBarcelonaForValidation(lat, lng)) continue;
    const name = place.displayName?.text ?? "";
    const rating = typeof place.rating === "number" && Number.isFinite(place.rating) ? place.rating : null;
    const editorialText = place.editorialSummary?.text?.trim() ?? null;
    const reviewText = place.reviewSummary?.text?.trim() ?? null;
    console.log("[places] Place:", place.displayName?.text, "| editorial:", editorialText?.substring(0, 50), "| review:", reviewText?.substring(0, 50), "| type:", place.primaryType);
    // Extract keywords from individual reviews for objective-fit evaluation
    const reviews = (place as { reviews?: Array<{ text?: { text?: string } }> }).reviews;
    const reviewKeywords = reviews
      ?.slice(0, 5)
      .map((r) => r.text?.text ?? "")
      .join(" ")
      .substring(0, 300) ?? null;
    const primaryType = place.primaryType;
    let description: string | null = null;
    if (editorialText && !/experience|discover|explore|authentic|hidden gem/i.test(editorialText)) {
      description = truncateToWords(editorialText, 8);
    }
    if (!description && reviewText) {
      const firstSentence = reviewText.split(/[.!?]/)[0]?.trim() ?? reviewText;
      description = truncateToWords(firstSentence, 8);
    }
    if (!description) {
      description = placeTypeToLabel(primaryType);
      needLlmDescription.push({ name, primaryType, index: out.length });
    }
    let photo_url: string | null = null;
    const photoName = place.photos?.[0]?.name;
    if (photoName) {
      photo_url = `/api/place-photo?name=${encodeURIComponent(photoName)}`;
    }
    out.push({
      name,
      description,
      lat,
      lng,
      rating,
      summary: editorialText ?? reviewText,
      photo_url,
      primary_type: primaryType ?? null,
      review_snippet: reviewText || reviewKeywords || null,
    });
  }
  if (needLlmDescription.length > 0) {
    try {
      const llmDescriptions = await generatePlaceDescriptions(
        needLlmDescription.map((p) => ({ name: p.name, primaryType: p.primaryType })),
        query
      );
      for (let i = 0; i < needLlmDescription.length; i++) {
        const d = needLlmDescription[i];
        const text = llmDescriptions[i];
        if (text && out[d.index]) {
          out[d.index].description = trimTrailingPunctuation(truncateToWords(text, 8));
        }
      }
    } catch {
      // keep type-based fallback
    }
  }
  return out;
}

/** Queries to find a meaningful walk destination for mood_only (parks, viewpoints, plazas, etc.). */
const MOOD_ONLY_DESTINATION_QUERIES: Record<Intent, string[]> = {
  calm: ["park Barcelona", "garden Barcelona", "quiet plaza Barcelona", "waterfront promenade Barcelona"],
  nature: ["park Barcelona", "garden Barcelona", "beach Barcelona", "green space Barcelona"],
  exercise: ["Montjuïc Barcelona", "Carretera de les Aigües", "Bunkers del Carmel", "viewpoint Barcelona", "hill walk Barcelona"],
  discover: ["cultural quarter Barcelona", "historic square Barcelona", "Barri Gòtic Barcelona", "interesting neighborhood Barcelona"],
  lively: ["plaza Barcelona", "market Barcelona", "pedestrian street Barcelona", "Rambla Barcelona"],
  scenic: ["viewpoint Barcelona", "mirador Barcelona", "waterfront Barcelona", "beach Barcelona"],
  cafe: ["plaza Barcelona", "pedestrian street Barcelona", "cafe square Barcelona"],
  quick: ["park Barcelona", "plaza Barcelona", "nearby square Barcelona"],
};

/** Find a named destination (park, plaza, viewpoint, etc.) for mood_only routes. Returns null if none found.
 * Uses full stated duration as walk time to destination: e.g. 20 min → target ~1.3km (67 m/min). */
async function findMoodOnlyDestination(
  originLat: number,
  originLng: number,
  intent: Intent,
  durationMinutes: number
): Promise<{ lat: number; lng: number; name: string; description: string | null } | null> {
  const targetDistanceM = durationMinutes * WALK_SPEED_M_PER_MIN;
  const radiusM = Math.min(Math.max(600, Math.ceil(targetDistanceM * 1.3)), 3500);
  const minDistM = Math.max(350, Math.floor(targetDistanceM * 0.4));
  const queries = MOOD_ONLY_DESTINATION_QUERIES[intent] ?? MOOD_ONLY_DESTINATION_QUERIES.calm;
  const distM2 = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const dy = (a.lat - b.lat) * 111000;
    const dx = (a.lng - b.lng) * 85000;
    return dx * dx + dy * dy;
  };
  const origin = { lat: originLat, lng: originLng };
  let best: PlaceOptionResult | null = null;
  let bestScore = -1;
  for (const query of queries) {
    try {
      const places = await searchPlace(query, originLat, originLng, 5, radiusM);
      for (const p of places) {
        const d2 = distM2(origin, p);
        const dM = Math.sqrt(d2);
        if (dM < minDistM || dM > radiusM) continue;
        const rating = p.rating ?? 3.5;
        const deviationFromTarget = Math.abs(dM - targetDistanceM);
        const distanceScore = 1 - deviationFromTarget / radiusM;
        const score = rating * 0.6 + distanceScore * 0.4;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
    } catch {
      continue;
    }
    if (best) break;
  }
  if (!best) return null;
  return {
    lat: best.lat,
    lng: best.lng,
    name: best.name,
    description: best.description,
  };
}

/** Fetch up to 3 photo refs + URLs via Places Text Search. More forgiving for OSM-sourced POIs (e.g. Gaudí buildings). */
async function getPhotoRefsAndUrlsFromTextSearch(
  name: string
): Promise<{ refs: string[]; urls: string[] }> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const empty = { refs: [] as string[], urls: [] as string[] };
  if (!apiKey) return empty;
  try {
    const query = `${name.trim()} Barcelona`;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return empty;
    const data = (await res.json()) as {
      results?: Array<{ photos?: Array<{ photo_reference?: string }> }>;
    };
    const photos = data.results?.[0]?.photos ?? [];
    console.log(
      "[enrichPhotos]",
      name,
      "Google response:",
      JSON.stringify(data.results?.[0]?.photos?.length ?? "no photos")
    );
    const refs: string[] = [];
    const urls: string[] = [];
    for (let i = 0; i < Math.min(3, photos.length); i++) {
      const ref = photos[i]?.photo_reference;
      if (ref) {
        refs.push(ref);
        urls.push(`/api/place-photo?ref=${encodeURIComponent(ref)}`);
      }
    }
    return { refs, urls };
  } catch {
    return empty;
  }
}

/** Fetch up to 3 photo URLs (and refs when from Text Search) for a single POI highlight. */
async function getPhotoUrlsForHighlight(
  name: string,
  lat: number,
  lng: number
): Promise<{ urls: string[]; refs?: string[] }> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const empty = { urls: [] as string[], refs: undefined as string[] | undefined };
  if (!apiKey) return empty;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.photos",
      },
      body: JSON.stringify({
        textQuery: name,
        locationBias: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: 300,
          },
        },
        maxResultCount: 1,
      }),
    });
    if (!res.ok) {
      console.log("[photos] Places API failed for", name, "status:", res.status, await res.text());
      return empty;
    }
    const data = (await res.json()) as { places?: Array<{ photos?: Array<{ name?: string }> }> };
    console.log("[photos] Places API response for", name, ":", JSON.stringify(data).substring(0, 300));
    const photos = data.places?.[0]?.photos ?? [];
    const urls: string[] = [];
    for (let i = 0; i < Math.min(3, photos.length); i++) {
      const photoName = photos[i]?.name;
      if (photoName) urls.push(`/api/place-photo?name=${encodeURIComponent(photoName)}`);
    }
    console.log("[photos] Built URLs for", name, ":", urls);
    if (urls.length > 0) return { urls };
    const { refs, urls: textSearchUrls } = await getPhotoRefsAndUrlsFromTextSearch(name);
    return { urls: textSearchUrls, refs: refs.length > 0 ? refs : undefined };
  } catch {
    const { refs, urls: textSearchUrls } = await getPhotoRefsAndUrlsFromTextSearch(name);
    return { urls: textSearchUrls, refs: refs.length > 0 ? refs : undefined };
  }
}

/** Add photo_urls and photoRefs (up to 3) to each highlight that has a name, using Google Places. */
async function enrichHighlightsWithPhotos(
  highlights: RouteHighlightOut[]
): Promise<RouteHighlightOut[]> {
  console.log(
    "[enrichPhotos] Called with",
    highlights.map((h) => ({ name: h.name, hasRefs: !!(h as { photoRefs?: string[] }).photoRefs?.length }))
  );
  const results = await Promise.all(
    highlights.map(async (h) => {
      if (!h.name?.trim()) return h;
      // Skip photo search for generic street-quality highlights — they return irrelevant images
      const genericNames = [
        "tree-lined",
        "lively area",
        "quiet stretch",
        "green corridor",
        "scenic path",
        "historic lane",
        "shaded path",
        "peaceful",
        "leafy street",
        "vibrant plaza",
        "calm area",
        "lively stretch",
      ];
      const isGeneric =
        genericNames.some((g) => h.name!.toLowerCase().includes(g)) || !h.name!.match(/[A-Z]/);
      if (isGeneric) return h;
      const { urls: photo_urls, refs: photoRefs } = await getPhotoUrlsForHighlight(h.name, h.lat, h.lng);
      console.log("[enrichPhotos] Result for", h.name, "→ urls:", photo_urls.length, "refs:", photoRefs?.length, "firstRef:", photoRefs?.[0]?.substring(0, 30));
      const photo_url = photo_urls[0] ?? null;
      return {
        ...h,
        ...(photo_url && { photo_url }),
        ...(photo_urls.length > 0 && { photo_urls }),
        ...(photoRefs && photoRefs.length > 0 && { photoRefs }),
      };
    })
  );
  return results;
}

function softenSummaryForEmotionalSupport(summary: string | null | undefined): string {
  if (!summary) return "A quiet, peaceful walk";
  const softened = summary
    .replace(/discover|adventure|explore|exciting|vibrant|lively|buzzing/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return softened || "A quiet, peaceful walk";
}

async function generateDescription(
  intent: string,
  breakdown: { noise: number; green: number; clean: number; cultural: number },
  duration: number,
  distance: number,
  destinationName?: string | null,
  nightMode?: boolean
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  let userMessage = `Intent: ${intent}. Breakdown: noise=${breakdown.noise}, green=${breakdown.green}, clean=${breakdown.clean}, cultural=${breakdown.cultural}. Duration seconds: ${duration}. Distance meters: ${distance}.`;
  if (destinationName) userMessage += ` Destination: ${destinationName}.`;
  if (nightMode) userMessage += " Night mode: true — route uses well-lit, busy streets.";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 60,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `You generate short route tags for walking routes in Barcelona. Return 3-4 descriptive tags separated by ' · '. Each tag is 1-3 words max. Be specific and sensory. Never mention numbers or scores.

Use the intent and score breakdown to pick relevant tags:
- High noise_score (quiet): 'quiet streets', 'peaceful', 'low traffic'
- High green_score (green): 'tree-lined', 'leafy streets', 'garden paths'
- High cultural_score (cultural): 'historic lanes', 'gallery district', 'Gothic arches'
- High clean_score with others low: don't mention clean, pick something else
- For discover intent: 'hidden corners', 'local favorites', 'off the beaten path'
- For nature intent: 'shaded paths', 'park views', 'green canopy'

Examples:
'quiet streets · tree-lined · shaded paths'
'Gothic arches · hidden corners · vibrant plazas'
'leafy Eixample · low traffic · garden paths'
'direct route · through Raval · busy but fast'

If nightMode is true, include one safety-aware tag:
- 'well-lit streets' or 'main roads' or 'busy corridors'
Do NOT mention danger or safety concerns — frame positively.

Night examples:
'well-lit streets · main roads · quick route'
'busy corridors · tree-lined · low traffic'

Respond with ONLY the tags, nothing else.`,
        },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  const tags = raw ? raw.split(" · ").map((t) => t.trim()).filter(Boolean).slice(0, 3) : [];
  return tags.join(" · ") || "";
}

/** One batch LLM call to generate 3-5 word descriptions for places that only have a generic type. Optional searchQuery tailors descriptions to what the user is looking for (e.g. "laptop-friendly cafes" → focus on wifi/power outlets). */
async function generatePlaceDescriptions(
  places: { name: string; primaryType?: string }[],
  searchQuery?: string | null
): Promise<string[]> {
  if (places.length === 0) return [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return places.map(() => "");
  const list = places.map((p, i) => `${i + 1}. ${p.name}${p.primaryType ? ` (${p.primaryType})` : ""}`).join("\n");
  const contextInstruction = searchQuery?.trim()
    ? `The user searched for: "${searchQuery.trim()}". For each place, write a 3-5 word description relevant to what they're looking for. You may infer likely features ONLY from the place NAME and TYPE — for example, a place called "Nomad Coffee Lab" is likely specialty coffee; a place with "coworking" in the name likely has wifi. But NEVER invent specific amenities (wifi, power sockets, terrace, outdoor seating) unless the name strongly implies them. When unsure, describe what type of place it is. Keep 3-5 words.`
    : `For each place, write a 3-5 word description based ONLY on its name and type. Describe what kind of place it is in a warm, specific way. NEVER invent amenities or features (wifi, seating, terrace, decor) — if you don't know, describe the type and vibe the name suggests. Examples: "Bodega La Palma" → "Traditional bodega, wine and tapas". "Cafè del Born" → "Neighborhood café in El Born". Keep 3-5 words.`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 200,
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content: `${contextInstruction}

Examples (when no search context): 'hearty laksa and roti canai', 'third-wave roastery with courtyard', 'natural wines and small plates'. With context "laptop-friendly cafes": 'plugs at every table, fast wifi', 'quiet back room, good for working'.

Never use: experience, discover, explore, authentic, hidden gem. Never invent: wifi, power sockets, outdoor seating, terrace, cozy atmosphere, spacious, artistic decor — unless the place name explicitly contains these words.

Reply with one line per place, in the same order, numbered 1., 2., etc. Nothing else.`,
        },
        { role: "user", content: `Places in Barcelona:\n${list}` },
      ],
    }),
  });
  if (!res.ok) return places.map(() => "");
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  const lines = text.split(/\n/).map((s) => s.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
  return places.map((_, i) => lines[i] ?? "");
}

/** One batch LLM call: returns 3-5 word descriptions for each POI. If it fails, return empty so we show name only. */
async function generatePoiLabels(
  highlights: { name?: string; type: string }[]
): Promise<string[]> {
  if (highlights.length === 0) return [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const placesJson = JSON.stringify(
    highlights.map((h) => ({ name: h.name ?? "POI", type: h.type }))
  );
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 300,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `You will receive a list of place names and their Google Maps type. For each, return a JSON array of 3-5 word descriptions. Be specific and factual. No generic words like 'experience', 'discover', 'explore', 'authentic', 'hidden gem', 'must-visit'. Keep each description under 60 characters. Every description must be a complete phrase — never cut off mid-sentence. If you can't fit the full thought in 60 characters, write a shorter one instead. Examples: "Gaudí's mosaic apartment", "outdoor market, fresh produce", "Gothic cloister", "third-wave coffee". Reply with ONLY a valid JSON array of strings, one string per place, in the same order.`,
        },
        {
          role: "user",
          content: `Places: ${placesJson}`,
        },
      ],
    }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  try {
    const parsed = JSON.parse(text) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [];
    return highlights.map((_, i) =>
      typeof arr[i] === "string" ? (arr[i] as string).replace(/[,;:.\s]+$/, "").trim() : ""
    );
  } catch {
    return [];
  }
}

/** Curated walkable viewpoints in Barcelona. */
const CURATED_VIEWPOINTS: PlaceOptionResult[] = [
  { name: "Bunkers del Carmel", description: "360° panoramic views over Barcelona", lat: 41.4193, lng: 2.1617, rating: 4.7, summary: null, photo_url: null, primary_type: "viewpoint" },
  { name: "Mirador de Miramar", description: "Montjuïc viewpoint overlooking the port", lat: 41.3712, lng: 2.1721, rating: 4.5, summary: null, photo_url: null, primary_type: "viewpoint" },
  { name: "Park Güell", description: "Gaudí's hilltop park with city views", lat: 41.4139, lng: 2.1526, rating: 4.6, summary: null, photo_url: null, primary_type: "viewpoint" },
  { name: "Turó del Carmel", description: "Quiet hilltop with panoramic views", lat: 41.4184, lng: 2.1533, rating: 4.5, summary: null, photo_url: null, primary_type: "viewpoint" },
  { name: "Mirador del Migdia", description: "South-facing Montjuïc viewpoint", lat: 41.3585, lng: 2.1593, rating: 4.4, summary: null, photo_url: null, primary_type: "viewpoint" },
  { name: "Mirador del Sagrat Cor (Tibidabo)", description: "Highest viewpoint in Barcelona", lat: 41.4218, lng: 2.1190, rating: 4.6, summary: null, photo_url: null, primary_type: "viewpoint" },
  { name: "Mirador Torre Glòries", description: "Modern tower observation deck", lat: 41.4035, lng: 2.1895, rating: 4.3, summary: null, photo_url: null, primary_type: "viewpoint" },
  { name: "Mirador del Port Vell", description: "Waterfront viewpoint over the harbour", lat: 41.3790, lng: 2.1837, rating: 4.2, summary: null, photo_url: null, primary_type: "viewpoint" },
  { name: "Creueta del Coll", description: "Hidden neighbourhood viewpoint", lat: 41.4199, lng: 2.1468, rating: 4.3, summary: null, photo_url: null, primary_type: "viewpoint" },
  { name: "Mirador de Sarrià", description: "Views from the Sarrià hills", lat: 41.4059, lng: 2.1102, rating: 4.2, summary: null, photo_url: null, primary_type: "viewpoint" },
];

/** Promenade waypoints along Barcelona's waterfront, from W Hotel to Fòrum/Diagonal Mar. */
const WATERFRONT_WAYPOINTS: [number, number][] = [
  [41.3685, 2.1785],   // W Hotel / tip of Barceloneta
  [41.3733, 2.1808],   // Sant Sebastià beach
  [41.3770, 2.1870],   // Barceloneta mid beach
  [41.3802, 2.1925],   // Barceloneta / Passeig Marítim
  [41.3855, 2.1960],   // Somorrostro / Frank Gehry fish
  [41.3891, 2.1988],   // Nova Icària beach
  [41.3920, 2.2030],   // Bogatell beach south
  [41.3950, 2.2080],   // Bogatell beach north
  [41.3975, 2.2128],   // Mar Bella beach
  [41.4005, 2.2175],   // Nova Mar Bella
  [41.4040, 2.2210],   // Llevant beach
  [41.4080, 2.2250],   // Fòrum / Diagonal Mar
];

/** Curated hiking waypoints for nature areas. bbox: [minLat, minLng, maxLat, maxLng]. */
const HIKING_AREAS: Record<
  string,
  { name: string; bbox: [number, number, number, number]; waypoints: { name: string; lat: number; lng: number }[] }
> = {
  tibidabo: {
    name: "Tibidabo",
    bbox: [41.41, 2.1, 41.43, 2.13],
    waypoints: [
      { name: "Jardins de la Tamarita", lat: 41.3985, lng: 2.137 },
      { name: "Carretera de les Aigües", lat: 41.412, lng: 2.128 },
      { name: "Mirador de l'Arrabassada", lat: 41.417, lng: 2.123 },
      { name: "Font de la Budellera", lat: 41.421, lng: 2.115 },
      { name: "Temple del Sagrat Cor", lat: 41.4217, lng: 2.1188 },
      { name: "Parc d'Atraccions Tibidabo", lat: 41.4225, lng: 2.12 },
      { name: "Mirador de Tibidabo", lat: 41.423, lng: 2.1195 },
      { name: "Torre de Collserola", lat: 41.4178, lng: 2.1148 },
    ],
  },
  montjuic: {
    name: "Montjuïc",
    bbox: [41.355, 2.148, 41.375, 2.175],
    waypoints: [
      { name: "Jardins de Mossèn Costa i Llobera", lat: 41.3592, lng: 2.168 },
      { name: "Fundació Joan Miró", lat: 41.3685, lng: 2.16 },
      { name: "Jardins de Laribal", lat: 41.367, lng: 2.1555 },
      { name: "Castell de Montjuïc", lat: 41.3633, lng: 2.1665 },
      { name: "Jardins del Mirador", lat: 41.361, lng: 2.169 },
      { name: "MNAC", lat: 41.3685, lng: 2.1535 },
      { name: "Font Màgica", lat: 41.3714, lng: 2.1518 },
      { name: "Jardí Botànic", lat: 41.3635, lng: 2.1565 },
    ],
  },
  collserola: {
    name: "Collserola",
    bbox: [41.41, 2.06, 41.47, 2.15],
    waypoints: [
      { name: "Font de la Budellera", lat: 41.421, lng: 2.115 },
      { name: "Torre de Collserola", lat: 41.4178, lng: 2.1148 },
      { name: "Pantà de Vallvidrera", lat: 41.427, lng: 2.098 },
      { name: "Mirador dels Xiprers", lat: 41.43, lng: 2.092 },
      { name: "Santa Creu d'Olorda", lat: 41.435, lng: 2.07 },
      { name: "Vil·la Joana", lat: 41.424, lng: 2.11 },
    ],
  },
  carmel: {
    name: "El Carmel",
    bbox: [41.415, 2.148, 41.425, 2.158],
    waypoints: [
      { name: "Bunkers del Carmel", lat: 41.4188, lng: 2.1566 },
      { name: "Parc del Guinardó", lat: 41.4198, lng: 2.161 },
      { name: "Mirador del Turó de la Rovira", lat: 41.4192, lng: 2.157 },
      { name: "Park Güell", lat: 41.4145, lng: 2.1527 },
    ],
  },
};

function getViewpointPoisFromGeoJson(): PlaceOptionResult[] {
  return CURATED_VIEWPOINTS;
}

/** Place types that are establishments/businesses → default to fastest route when selected as destination. */
const ESTABLISHMENT_TYPES = [
  "restaurant",
  "cafe",
  "bar",
  "bakery",
  "food",
  "store",
  "shop",
  "supermarket",
  "pharmacy",
  "gym",
  "hair_care",
  "clothing_store",
  "book_store",
  "bank",
  "hospital",
  "doctor",
  "dentist",
  "laundry",
  "gas_station",
];

/** Types to exclude from route highlights — services and activity businesses that aren't interesting walking landmarks. */
const HIGHLIGHT_EXCLUDE_TYPES = [
  ...ESTABLISHMENT_TYPES,
  "travel_agency",
  "tour_operator",
  "sporting_goods_store",
  "adventure_sports_center",
  "amusement_center",
  "water_sports",
  "boat_rental",
  "rental",
  "insurance_agency",
  "real_estate_agency",
  "car_rental",
  "car_dealer",
  "moving_company",
  "storage",
  "lodging",
  "hotel",
  "hostel",
];

function isEstablishmentType(primaryType: string | null | undefined): boolean {
  if (!primaryType || typeof primaryType !== "string") return false;
  const t = primaryType.toLowerCase().trim();
  return ESTABLISHMENT_TYPES.some((e) => t === e || t.includes(e));
}

/** Types that map to "cafe" highlight category (exclude from POI highlights when destination is a food establishment). */
const ESTABLISHMENT_TYPES_FOOD = [
  "restaurant",
  "cafe",
  "bar",
  "bakery",
  "food",
  "meal_delivery",
  "meal_takeaway",
];

/** Types that map to "shop" highlight category (exclude when destination is a shop). */
const SHOP_TYPES = [
  "store",
  "shop",
  "clothing_store",
  "book_store",
  "supermarket",
];

/** Returns highlight types to exclude when destination is an establishment (so route POIs complement, not compete). */
function getExcludeHighlightTypes(destinationPlaceType: string | null | undefined): string[] {
  if (!destinationPlaceType || typeof destinationPlaceType !== "string") return [];
  const t = destinationPlaceType.toLowerCase().trim();
  const out: string[] = [];
  if (ESTABLISHMENT_TYPES_FOOD.some((e) => t === e || t.includes(e))) out.push("cafe");
  if (SHOP_TYPES.some((e) => t === e || t.includes(e))) out.push("shop");
  return out;
}

// =============================================================
// API HANDLER
// =============================================================

const WALK_SPEED_M_PER_MIN = 67;
const BCN_BBOX = { minLat: 41.32, maxLat: 41.47, minLng: 2.05, maxLng: 2.23 };

/** Hardcoded coords for destinations that geocode poorly (sea, wrong bbox) or have language variants. Check before geocodePlace. */
const KNOWN_DESTINATION_FALLBACKS: Record<string, [number, number]> = {
  beach: [41.3784, 2.1925],
  "the beach": [41.3784, 2.1925],
  "barceloneta beach": [41.3784, 2.1925],
  barceloneta: [41.3784, 2.1925],
  platja: [41.3784, 2.1925],
  seaside: [41.3802, 2.1893],
  waterfront: [41.3802, 2.1893],
  port: [41.3752, 2.1768],
  mar: [41.3784, 2.1925],
  "plaça catalunya": [41.387, 2.17],
  "plaza cataluña": [41.387, 2.17],
  "plaça de catalunya": [41.387, 2.17],
  "plaza de cataluña": [41.387, 2.17],
};

function getFallbackCoordsForDestination(name: string): [number, number] | null {
  const lower = name.toLowerCase().trim();
  if (!lower) return null;
  const keys = Object.keys(KNOWN_DESTINATION_FALLBACKS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key)) return KNOWN_DESTINATION_FALLBACKS[key];
  }
  return null;
}
/** Expanded bbox for destination validation only — viewpoints at city edges (Bunkers, Montjuïc, Tibidabo approach, etc.) may fall just outside strict BCN_BBOX. */
const BCN_BBOX_VALIDATION = { minLat: 41.30, maxLat: 41.50, minLng: 2.03, maxLng: 2.25 };
const MAX_ROUTE_DURATION_MIN = 360;
const MAX_ROUTE_DISTANCE_M = 20000;
const MAX_WAYPOINT_DISTANCE_M = 3000;

/** Port Vell / water area — waypoints here are over the sea. Exclude from boundary selection. */
const PORT_WATER_BBOX = { minLat: 41.365, maxLat: 41.378, minLng: 2.168, maxLng: 2.195 };

/** Area name → rough bbox for constraining routes (e.g. "discovery in Eixample"). */
const AREA_BBOXES: Record<string, { minLat: number; maxLat: number; minLng: number; maxLng: number }> = {
  eixample: { minLat: 41.385, maxLat: 41.405, minLng: 2.155, maxLng: 2.175 },
  gràcia: { minLat: 41.403, maxLat: 41.425, minLng: 2.145, maxLng: 2.165 },
  gracia: { minLat: 41.403, maxLat: 41.425, minLng: 2.145, maxLng: 2.165 },
  barceloneta: { minLat: 41.375, maxLat: 41.388, minLng: 2.185, maxLng: 2.205 },
  waterfront: { minLat: 41.375, maxLat: 41.397, minLng: 2.185, maxLng: 2.215 },
  "barri gotic": { minLat: 41.380, maxLat: 41.386, minLng: 2.170, maxLng: 2.182 },
  gothic: { minLat: 41.380, maxLat: 41.386, minLng: 2.170, maxLng: 2.182 },
  raval: { minLat: 41.378, maxLat: 41.388, minLng: 2.165, maxLng: 2.178 },
  montjuic: { minLat: 41.363, maxLat: 41.372, minLng: 2.158, maxLng: 2.178 },
  montjuïc: { minLat: 41.363, maxLat: 41.372, minLng: 2.158, maxLng: 2.178 },
  tibidabo: { minLat: 41.418, maxLat: 41.426, minLng: 2.115, maxLng: 2.125 },
  collserola: { minLat: 41.41, maxLat: 41.44, minLng: 2.08, maxLng: 2.16 },
};

function isInBarcelona(lat: number, lng: number): boolean {
  return lat >= BCN_BBOX.minLat && lat <= BCN_BBOX.maxLat && lng >= BCN_BBOX.minLng && lng <= BCN_BBOX.maxLng;
}

function isInBarcelonaForValidation(lat: number, lng: number): boolean {
  return (
    lat >= BCN_BBOX_VALIDATION.minLat &&
    lat <= BCN_BBOX_VALIDATION.maxLat &&
    lng >= BCN_BBOX_VALIDATION.minLng &&
    lng <= BCN_BBOX_VALIDATION.maxLng
  );
}

function isOnLand(lat: number, lng: number): boolean {
  if (lat >= PORT_WATER_BBOX.minLat && lat <= PORT_WATER_BBOX.maxLat && lng >= PORT_WATER_BBOX.minLng && lng <= PORT_WATER_BBOX.maxLng) return false;
  return true;
}

function getAreaBbox(areaName: string): { minLat: number; maxLat: number; minLng: number; maxLng: number } | null {
  const key = areaName.toLowerCase().trim().replace(/\s+/g, " ");
  return AREA_BBOXES[key] ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      origin,
      moodText,
      duration: durationMinutes,
      destination: bodyDestination,
      intent: bodyIntent,
      routeType: bodyRouteType,
      destination_name: bodyDestinationName,
      destination_address: bodyDestinationAddress,
      destination_place_type: bodyDestinationPlaceType,
      search_offset: searchOffset,
    } = body;

    if (!origin || !Array.isArray(origin) || origin.length < 2) {
      return NextResponse.json({ error: "origin required (lat, lng)" }, { status: 400 });
    }

    const originCoords: [number, number] = [Number(origin[0]), Number(origin[1])];
    const isNight = SIMULATE_NIGHT || (() => {
      const h = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Europe/Madrid" })
      ).getHours();
      return h >= 21 || h < 6;
    })();

    let intent: Intent = "calm";
    let destCoords: [number, number] | null = null;
    let destination_name: string | null = null;
    let destination_address: string | null = null;
    let pattern: RequestPattern = "mood_only";
    let suggestedDuration: number | null = null;
    let maxDurationMinutes: number | null = null;
    let targetDistanceKm: number | null = null;
    let themeName: string | null = null;
    let poi_focus = false;
    let poi_search_terms: string[] = [];
    let skipDuration = false;
    let isLoop = false;
    let parsedArea: string | null = null;
    let parsedPoiQuery: string | null = null;
    let parsedThemeName: string | null = null;

    const hasDestinationOverride =
      Array.isArray(bodyDestination) &&
      bodyDestination.length >= 2 &&
      Number.isFinite(Number(bodyDestination[0])) &&
      Number.isFinite(Number(bodyDestination[1]));

    const hasIntentOverride =
      bodyIntent != null && ["calm", "discover", "nature", "scenic", "lively", "exercise", "cafe", "quick"].includes(String(bodyIntent));
    const skipParsing = hasDestinationOverride && (hasIntentOverride || moodText == null || String(moodText).trim() === "");

    // When client sends destination (e.g. "Route here" from a place card), use it as the sole route end. Coords are [lat, lng]; do not overwrite destCoords elsewhere.
    const destination_place_type: string | null =
      typeof bodyDestinationPlaceType === "string" ? bodyDestinationPlaceType : null;

    if (skipParsing) {
      const destLat = Number(bodyDestination[0]);
      const destLng = Number(bodyDestination[1]);
      destCoords = [destLat, destLng];
      pattern = "mood_and_destination";
      destination_name = typeof bodyDestinationName === "string" ? bodyDestinationName : null;
      destination_address = typeof bodyDestinationAddress === "string" ? bodyDestinationAddress : null;
      console.log("[route] destination received (lat, lng):", destCoords, "name:", destination_name || "(none)", "place_type:", destination_place_type || "(none)");
      intent = hasIntentOverride ? (bodyIntent as Intent) : "calm";
    } else if (moodText == null || String(moodText).trim() === "") {
      return NextResponse.json({ error: "moodText required when not passing destination+intent" }, { status: 400 });
    }

    if (!skipParsing) {
      try {
        const parsed = await parseMoodRequest(String(moodText).trim());
        intent = parsed.intent;
        pattern = parsed.pattern;
        suggestedDuration = parsed.suggested_duration;
        maxDurationMinutes = parsed.max_duration_minutes;
        targetDistanceKm = parsed.target_distance_km;
        themeName = parsed.theme_name;
        poi_focus = parsed.poi_focus === true;
        poi_search_terms = parsed.poi_search_terms ?? [];
        skipDuration = parsed.skip_duration === true;
        isLoop = parsed.is_loop === true;
        parsedArea = parsed.area ?? null;
        parsedPoiQuery = parsed.poi_query ?? null;
        parsedThemeName = parsed.theme_name ?? null;
        console.log(`[route] Parsed: pattern=${pattern}, intent=${intent}, poi_focus=${poi_focus}, skip_duration=${skipDuration}, is_loop=${isLoop}, poi_search_terms=${JSON.stringify(poi_search_terms)}, suggested_duration=${suggestedDuration}, target_km=${targetDistanceKm}, max_mins=${maxDurationMinutes}`);

        switch (pattern) {
          case "mood_and_destination":
          case "destination_only": {
            const name = parsed.destination?.trim() ?? "";
            const isViewpointLike = /viewpoint|mirador|vista|lookout/i.test(name) || name === "a viewpoint";
            if (isViewpointLike && pattern === "mood_and_destination") {
              pattern = "mood_and_poi";
              const geoViewpoints = getViewpointPoisFromGeoJson();
              const fromPlaces = await searchPlace("viewpoint Barcelona", originCoords[0], originCoords[1], 5, 4000);
              const seen = new Set(geoViewpoints.map((p) => p.name));
              const combined = [...geoViewpoints, ...fromPlaces.filter((p) => !seen.has(p.name))];
              const dist2 = (p: { lat: number; lng: number }) =>
                (p.lat - originCoords[0]) ** 2 + (p.lng - originCoords[1]) ** 2;
              const places = combined.sort((a, b) => dist2(a) - dist2(b)).slice(0, 5);
              if (places.length >= 2) {
                let finalPlaces: PlaceOptionResult[];
                if (isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null)) {
                  finalPlaces = await rerankByObjectiveFit(places, (typeof moodText === "string" ? moodText : "").trim());
                } else {
                  finalPlaces = rerankPlacesForLocalCharacter(places);
                }
                console.log("[rerank] About to return, first 3 places:", finalPlaces?.slice(0, 3).map((p) => p.name) ?? "no places var found");
                console.log("[places] Returning place_options, objective?", isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null), "query:", parsedPoiQuery, "moodText:", typeof moodText === "string" ? moodText.substring(0, 50) : null);
                return NextResponse.json({ place_options: finalPlaces, needs_place_selection: true, intent });
              }
              if (places.length === 1) {
                destCoords = [places[0].lat, places[0].lng];
                destination_name = places[0].name;
                destination_address = places[0].description ?? null;
              }
              break;
            }
            if (pattern === "destination_only") intent = "quick";
            if (name) {
              const fallback = getFallbackCoordsForDestination(name);
              if (fallback) {
                destCoords = fallback;
                destination_name = name;
              } else {
                const geo = await geocodePlace(name);
                if (geo) {
                  destCoords = [geo.lat, geo.lng];
                  destination_name = name;
                }
              }
            }
            break;
          }
          case "mood_and_area": {
            if (parsed.area) {
              // Check fallback coords first (handles "beach", "waterfront", etc.)
              const areaFallback = getFallbackCoordsForDestination(parsed.area);
              const areaBbox = getAreaBbox(parsed.area);

              if (areaFallback) {
                destCoords = areaFallback;
                destination_name = parsed.area;
              } else if (areaBbox) {
                destCoords = [
                  (areaBbox.minLat + areaBbox.maxLat) / 2,
                  (areaBbox.minLng + areaBbox.maxLng) / 2,
                ];
                destination_name = parsed.area;
              } else {
                const geo = await geocodePlace(parsed.area);
                if (geo) {
                  destCoords = [geo.lat, geo.lng];
                  destination_name = parsed.area;
                }
              }
            }
            break;
          }
          case "mood_and_poi": {
            if (parsed.poi_query) {
              const q = parsed.poi_query.toLowerCase();
              const isViewpointQuery = /viewpoint|mirador|vista|lookout/i.test(q);
              
              // Determine search center — use "area" or "destination" as anchor if set (e.g. "near ELISAVA")
              let searchCenter: [number, number] = [originCoords[0], originCoords[1]];
              const poiAnchor = parsed.area || parsed.destination;
              if (poiAnchor) {
                const anchorFallback = getFallbackCoordsForDestination(poiAnchor);
                if (anchorFallback) {
                  searchCenter = anchorFallback;
                } else {
                  const anchorBbox = getAreaBbox(poiAnchor);
                  if (anchorBbox) {
                    searchCenter = [
                      (anchorBbox.minLat + anchorBbox.maxLat) / 2,
                      (anchorBbox.minLng + anchorBbox.maxLng) / 2,
                    ];
                  } else {
                    const geo = await geocodePlace(poiAnchor);
                    if (geo) {
                      searchCenter = [geo.lat, geo.lng];
                    }
                  }
                }
                console.log(`[route] Search centered on "${poiAnchor}":`, searchCenter);
              }

              const searchOffsetNum = typeof searchOffset === "number" && Number.isFinite(searchOffset) && searchOffset > 0 ? searchOffset : 0;
              if (searchOffsetNum > 0) {
                const radiusBase = maxDurationMinutes != null ? maxDurationMinutes * WALK_SPEED_M_PER_MIN : 5000;
                const radiusM = Math.min(radiusBase, 6000);
                const largerRadius = Math.min(radiusM * 2, 8000);
                const morePlaces = await searchPlace(parsed.poi_query, searchCenter[0], searchCenter[1], 10, largerRadius);
                let finalPlaces: PlaceOptionResult[];
                if (isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null)) {
                  finalPlaces = await rerankByObjectiveFit(morePlaces, (typeof moodText === "string" ? moodText : "").trim());
                } else {
                  finalPlaces = rerankPlacesForLocalCharacter(morePlaces);
                }
                console.log("[rerank] About to return, first 3 places:", finalPlaces?.slice(0, 3).map((p) => p.name) ?? "no places var found");
                console.log("[places] Returning place_options, objective?", isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null), "query:", parsedPoiQuery, "moodText:", typeof moodText === "string" ? moodText.substring(0, 50) : null);
                return NextResponse.json({
                  place_options: finalPlaces,
                  needs_place_selection: true,
                  intent,
                });
              }
              
              let places: PlaceOptionResult[] = [];
              if (isViewpointQuery) {
                const geoViewpoints = getViewpointPoisFromGeoJson();
                const fromPlaces = await searchPlace(parsed.poi_query, searchCenter[0], searchCenter[1], 10, 4000);
                const seen = new Set(geoViewpoints.map((p) => p.name));
                const combined = [...geoViewpoints, ...fromPlaces.filter((p) => !seen.has(p.name))];
                const dist2 = (p: { lat: number; lng: number }) =>
                  (p.lat - searchCenter[0]) ** 2 + (p.lng - searchCenter[1]) ** 2;
                places = combined.sort((a, b) => dist2(a) - dist2(b)).slice(0, 10);
              } else {
                const radius = maxDurationMinutes != null ? maxDurationMinutes * WALK_SPEED_M_PER_MIN : 5000;
                const radiusM = Math.min(radius, 6000);
                places = await searchPlace(parsed.poi_query, searchCenter[0], searchCenter[1], 10, radiusM);
                // If we got few results, try a broader query to fill up to 5 options
                if (places.length < 5) {
                  const simplified = simplifyPoiQueryForFallback(parsed.poi_query);
                  if (simplified && simplified !== parsed.poi_query.trim().toLowerCase()) {
                    const extra = await searchPlace(simplified, searchCenter[0], searchCenter[1], 10, Math.min(radiusM * 2, 10000));
                    const seen = new Set(places.map((p) => p.name.toLowerCase()));
                    const added = extra.filter((p) => !seen.has(p.name.toLowerCase()));
                    const dist2 = (p: { lat: number; lng: number }) =>
                      (p.lat - searchCenter[0]) ** 2 + (p.lng - searchCenter[1]) ** 2;
                    places = [...places, ...added].sort((a, b) => dist2(a) - dist2(b)).slice(0, 10);
                  }
                }
              }
              if (places.length >= 2) {
                let finalPlaces: PlaceOptionResult[];
                if (isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null)) {
                  finalPlaces = await rerankByObjectiveFit(places, (typeof moodText === "string" ? moodText : "").trim());
                } else {
                  finalPlaces = rerankPlacesForLocalCharacter(places);
                }
                console.log("[rerank] About to return, first 3 places:", finalPlaces?.slice(0, 3).map((p) => p.name) ?? "no places var found");
                console.log("[places] Returning place_options, objective?", isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null), "query:", parsedPoiQuery, "moodText:", typeof moodText === "string" ? moodText.substring(0, 50) : null);
                return NextResponse.json({
                  place_options: finalPlaces,
                  needs_place_selection: true,
                  intent,
                });
              }
              if (places.length === 1) {
                destCoords = [places[0].lat, places[0].lng];
                destination_name = places[0].name;
                destination_address = places[0].description ?? null;
              }
            }
            break;
          }
          case "themed_walk": {
            // Just store the query — route generation happens after duration is confirmed
            break;
          }
          case "mood_only": {
            break;
          }
        }
      } catch (err) {
        console.warn("[route] parseMoodRequest failed:", err);
        intent = "calm";
        pattern = "mood_only";
      }
    }

    // Fallback: "20 minute dont care where" etc. — if mood_only with no destination and no duration set, detect duration + indifference in raw text
    if (
      pattern === "mood_only" &&
      destCoords === null &&
      (suggestedDuration == null || !skipDuration)
    ) {
      const raw = String(moodText).trim();
      const durationMatch = raw.match(/(\d+)\s*(?:min|minute|mins?)(?:\s|$)/i);
      const indifference = /dont care|don't care|surprise me|anywhere|whatever|don't care where|doesn't matter/i.test(raw);
      if (durationMatch && indifference) {
        const mins = Math.min(120, Math.round(Number(durationMatch[1])) || 20);
        suggestedDuration = mins;
        skipDuration = true;
        if (intent !== "discover") intent = "discover";
        console.log("[route] Fallback: duration+indifference detected, suggestedDuration=", suggestedDuration);
      }
    }

    const validIntents = ["calm", "discover", "nature", "scenic", "lively", "exercise", "cafe", "quick"];
    if (!validIntents.includes(intent)) {
      return NextResponse.json({ error: `intent must be one of: ${validIntents.join(", ")}` }, { status: 400 });
    }

    // Handle edge-case theme_names with appropriate UI messages
    if (themeName) {
      const edgeCaseMessages: Record<string, { message: string; suggestion?: string }> = {
        need_nudge: {
          message: "Give me a little more to work with! What are you in the mood for?",
          suggestion: "Try: 'calm walk by the beach', 'surprise me', or 'coffee shop in Gràcia'",
        },
        needs_home_address: {
          message: "I don't know where home is yet!",
          suggestion: "Set a custom start point or try: 'walk to [your street or landmark]'",
        },
        safety_baseline: {
          message: "Every route factors in street lighting and activity. After 9pm, routes shift to well-lit, busier streets.",
          suggestion: "Tell me where you'd like to go.",
        },
        avoidance_only: {
          message: "Got it — but where DO you want to go?",
          suggestion: "Try: 'surprise me' or tell me a vibe like 'somewhere calm' or 'lively area'",
        },
        out_of_range: {
          message: "That's a bit far for a walk! (re)Route covers Barcelona for now.",
          suggestion: "Try somewhere within the city — there's plenty to explore.",
        },
        accessibility_request: {
          message: "Accessibility routing isn't available yet :,(",
          suggestion: "For now, try a calm or nature walk — these tend to use wider, flatter streets.",
        },
        surprise_me: {
          message: "If you don't know, we'll just have to roll the dice on this one.",
        },
        night_safety: {
          message: "Every route already factors in street lighting and busy streets after 9PM. You're in good hands.",
          suggestion: "Tell me where you're headed and I'll find you a safe, well-lit route.",
        },
      };

      const edgeCase = edgeCaseMessages[themeName];
      if (edgeCase) {
        return NextResponse.json({
          edge_case: true,
          message: edgeCase.message,
          suggestion: edgeCase.suggestion,
          intent,
          theme_name: themeName,
        });
      }
    }

    const isEmotionalSupport = themeName === "emotional_support";
    /** Avoid unsafe zones for night mode AND emotional_support (vulnerable walks). */
    const forceAvoidZones = isNight || isEmotionalSupport;

    const isSurpriseMe = typeof durationMinutes === "number" && durationMinutes === 0;
    const durationFromBody =
      typeof durationMinutes === "number" && durationMinutes > 0 ? Math.round(durationMinutes) : null;
    const durationFromDistance =
      pattern === "mood_only" && targetDistanceKm != null && targetDistanceKm > 0
        ? (targetDistanceKm * 1000) / WALK_SPEED_M_PER_MIN
        : null;
    let effectiveDuration =
      isSurpriseMe ? 15 + Math.floor(Math.random() * 166) : durationFromBody ?? suggestedDuration ?? durationFromDistance;
    // Use LLM-parsed duration if provided (e.g. "20 minutes, don't care where")
    if (suggestedDuration != null && effectiveDuration == null) {
      effectiveDuration = suggestedDuration;
    }
    // Area exploration generates its own duration from POI count and spacing — skip duration picker
    if (pattern === "mood_and_area" && effectiveDuration == null) {
      effectiveDuration = 45;
    }

    // When no destination (or mood_only): ask for duration unless we have one. If LLM already set suggested_duration (e.g. "30 min loop"), use it and skip picker. mood_and_area is excluded — it uses a default above.
    const isLoopWithDurationSpecified = pattern === "mood_only" && isLoop && (suggestedDuration != null || maxDurationMinutes != null);
    const isAreaExploration = pattern === "mood_and_area";
    const isThemedWalk = pattern === "themed_walk";
    let mustAskDuration =
      (destCoords === null || pattern === "mood_only" || isThemedWalk) &&
      (effectiveDuration == null || (isLoopWithDurationSpecified && suggestedDuration == null));

    console.log("[route] effectiveDuration:", effectiveDuration, "suggested_duration:", suggestedDuration, "mustAskDuration:", mustAskDuration);

    // At night, skip duration picker for mood_only — default to a shorter, safer walk (20 min) to minimize time outside
    if (isNight && mustAskDuration && effectiveDuration == null) {
      effectiveDuration = 20;
      mustAskDuration = false;
    }

    if (mustAskDuration) {
      const durationOptions = [
        { label: "5-15 min", value: 10 },
        { label: "15-30 min", value: 22 },
        { label: "30 min - 1 hr", value: 45 },
        { label: "Surprise me", value: 0 },
      ];
      if (skipDuration) {
        const autoDurations = [10, 20, 40, 60, 90, 120, 180];
        const auto_duration = autoDurations[Math.floor(Math.random() * autoDurations.length)];
        return NextResponse.json({
          needs_duration: true,
          skip_duration: true,
          auto_duration,
          intent,
          message: "How long do you want to walk?",
          options: durationOptions,
        });
      }
      return NextResponse.json({
        needs_duration: true,
        intent,
        message: "How long do you want to walk?",
        options: durationOptions,
      });
    }

    // AREA EXPLORATION ROUTES (after duration is confirmed)
    if (pattern === "mood_and_area" && destCoords && effectiveDuration != null) {
      const areaCenter: [number, number] = [destCoords[0], destCoords[1]];
      const walkDuration = effectiveDuration ?? 30;

      // If area is far from user (>2km), start the walk from the area center so we get a walk within the area
      const areaCenterLat = areaCenter[0];
      const areaCenterLng = areaCenter[1];
      const distToArea =
        Math.sqrt(
          (originCoords[0] - areaCenterLat) ** 2 + (originCoords[1] - areaCenterLng) ** 2
        ) * 111000; // rough meters per degree
      let routeOrigin: [number, number] = [...originCoords];
      if (distToArea > 2000) {
        routeOrigin = [areaCenterLat, areaCenterLng];
        console.log("[route] Area far from user, starting walk from area center");
      }

      // Special handling for waterfront/beach — use promenade waypoints
      const isWaterfrontArea = /beach|waterfront|barceloneta|seaside|coast|platja|mar\b/i.test(parsedArea || "");

      if (isWaterfrontArea) {
        try {
          // Use duration to control route length (~8 min between waypoints)
          const maxWaypoints = Math.max(2, Math.min(Math.ceil(walkDuration / 8), 8));

          const userDist = (wp: [number, number]) =>
            (wp[0] - routeOrigin[0]) ** 2 + (wp[1] - routeOrigin[1]) ** 2;
          const sortedByUserDist = [...WATERFRONT_WAYPOINTS].sort((a, b) => userDist(a) - userDist(b));
          const nearestIdx = WATERFRONT_WAYPOINTS.indexOf(sortedByUserDist[0]);

          const startIdx = Math.max(0, nearestIdx);
          const promenadeSlice = WATERFRONT_WAYPOINTS.slice(startIdx, startIdx + maxWaypoints);

          const waterfrontRoute = await fetchOrsWaypointRoute(routeOrigin, promenadeSlice, intent, forceAvoidZones);

          if (waterfrontRoute.duration <= 5400) {
            const { index } = await loadStreetData();
            const { score, breakdown, tags } = scoreRoute(waterfrontRoute.coordinates, intent, index);
            const poiPoints = loadPoiData();
            const excludeHighlightTypes = getExcludeHighlightTypes(null);
            let highlights = findRouteHighlights(
              waterfrontRoute.coordinates,
              intent,
              index,
              poiPoints,
              excludeHighlightTypes,
              maxPoisFromRouteDistance(waterfrontRoute.distance)
            );

            if (highlights.length > 0) {
              try {
                const labels = await generatePoiLabels(highlights);
                highlights = highlights.map((h, i) => ({
                  ...h,
                  description: trimTrailingPunctuation(labels[i]) || undefined,
                }));
              } catch {
                /* keep existing */
              }
              try {
                highlights = await enrichHighlightsWithPhotos(highlights);
              } catch {
                /* skip */
              }
            }

            let summary = buildSummary(waterfrontRoute.duration, waterfrontRoute.distance, tags, intent, isNight);
            try {
              const desc = await generateDescription(intent, breakdown, waterfrontRoute.duration, waterfrontRoute.distance, parsedArea, isNight);
              if (desc) summary = desc;
            } catch {
              /* keep template */
            }
            if (isEmotionalSupport && summary) summary = softenSummaryForEmotionalSupport(summary);

            const result = {
              coordinates: waterfrontRoute.coordinates,
              duration: waterfrontRoute.duration,
              distance: waterfrontRoute.distance,
              score,
              breakdown,
              summary,
              highlights,
            };

            return NextResponse.json({
              recommended: result,
              quick: result,
              alternatives_count: 1,
              destination_name: parsedArea,
              destination_address: null,
              pattern: "mood_and_area",
              intent,
              end_point: promenadeSlice[promenadeSlice.length - 1],
              night_mode: isNight,
            });
          }
        } catch (e) {
          console.warn("[route] Waterfront promenade route failed, falling back:", e);
        }
      }

      // Check if this is a known hiking area (curated waypoints)
      const hikingKey = Object.keys(HIKING_AREAS).find((key) => {
        const area = HIKING_AREAS[key];
        const lower = parsedArea?.toLowerCase() ?? "";
        return lower.includes(key) || lower.includes(area.name.toLowerCase());
      });

      if (hikingKey) {
        const hiking = HIKING_AREAS[hikingKey];
        const shuffled = [...hiking.waypoints].sort(() => Math.random() - 0.5);
        const numStops = walkDuration
          ? Math.min(Math.max(2, Math.floor(walkDuration / 12)), shuffled.length)
          : Math.min(4, shuffled.length);
        const selected = shuffled.slice(0, numStops);
        const startIdx = Math.floor(Math.random() * selected.length);
        const start = selected.splice(startIdx, 1)[0];
        const ordered = [start];
        const remaining = [...selected];
        while (remaining.length > 0) {
          const current = ordered[ordered.length - 1];
          let nearestIdx = 0;
          let nearestDist = Infinity;
          for (let i = 0; i < remaining.length; i++) {
            const d = (remaining[i].lat - current.lat) ** 2 + (remaining[i].lng - current.lng) ** 2;
            if (d < nearestDist) {
              nearestDist = d;
              nearestIdx = i;
            }
          }
          ordered.push(remaining.splice(nearestIdx, 1)[0]);
        }
        try {
          const explorationRoute = await fetchOrsWaypointRoute(
            [ordered[0].lat, ordered[0].lng],
            ordered.slice(1).map((p) => [p.lat, p.lng] as [number, number]),
            intent,
            forceAvoidZones,
            true
          );
          if (explorationRoute.duration <= 5400) {
            const { index } = await loadStreetData();
            const { score, breakdown, tags } = scoreRoute(explorationRoute.coordinates, intent, index);
            let highlights: RouteHighlightOut[] = ordered.map((p) => ({
              lat: p.lat,
              lng: p.lng,
              label: `📍 ${p.name}`,
              name: p.name,
              type: "poi" as const,
              description: undefined,
            }));
            try {
              const labels = await generatePoiLabels(highlights);
              highlights = highlights.map((h, i) => ({
                ...h,
                description: trimTrailingPunctuation(labels[i]) || undefined,
              }));
            } catch {
              /* keep existing */
            }
            try {
              highlights = await enrichHighlightsWithPhotos(highlights);
            } catch {
              /* skip */
            }
            let summary = buildSummary(explorationRoute.duration, explorationRoute.distance, tags, intent, isNight);
            try {
              const desc = await generateDescription(
                intent,
                breakdown,
                explorationRoute.duration,
                explorationRoute.distance,
                parsedArea,
                isNight
              );
              if (desc) summary = desc;
            } catch {
              /* keep template */
            }
            if (isEmotionalSupport && summary) summary = softenSummaryForEmotionalSupport(summary);
            const trailDestinationName =
              ordered.length > 1 ? `${ordered[0].name} → ${ordered[ordered.length - 1].name}` : ordered[0].name;
            const lastPoi = ordered[ordered.length - 1];
            return NextResponse.json({
              recommended: {
                coordinates: explorationRoute.coordinates,
                duration: explorationRoute.duration,
                distance: explorationRoute.distance,
                score,
                breakdown,
                summary,
                highlights,
              },
              quick: {
                coordinates: explorationRoute.coordinates,
                duration: explorationRoute.duration,
                distance: explorationRoute.distance,
                score,
                breakdown,
                summary,
                highlights,
              },
              alternatives_count: 1,
              destination_name: trailDestinationName,
              destination_address: null,
              pattern: "mood_and_area",
              intent,
              end_point: [lastPoi.lat, lastPoi.lng],
              night_mode: isNight,
            });
          }
        } catch (e) {
          console.warn("[route] Hiking area route failed, falling back to POI search:", e);
        }
      }

      // Generic area POI exploration
      let searchQuery: string;
      if (parsedPoiQuery) {
        searchQuery = parsedPoiQuery.includes("Barcelona")
          ? parsedPoiQuery
          : `${parsedPoiQuery} ${parsedArea || ""} Barcelona`.trim();
      } else if (parsedThemeName) {
        searchQuery = `${parsedThemeName} ${parsedArea || ""} Barcelona`.trim();
      } else {
        const areaPoiQueries: Record<string, string> = {
          calm: "park garden quiet plaza",
          nature: "park garden green space",
          discover: "historic buildings landmark architecture",
          scenic: "viewpoint architecture landmark",
          lively: "market plaza bar",
          exercise: "park hill trail",
          cafe: "cafe coffee shop",
          quick: "plaza landmark",
        };
        searchQuery = `${areaPoiQueries[intent] || "landmark plaza"} ${parsedArea || ""} Barcelona`.trim();
      }
      const areaPois = await searchPlace(searchQuery, areaCenter[0], areaCenter[1], 5, 1500);

      if (areaPois.length >= 2) {
        const maxAreaPois = walkDuration <= 15 ? 2 : walkDuration <= 30 ? 3 : 4;
        // Nearest-neighbor order from routeOrigin so we have a sensible start → end trail
        const ordered: typeof areaPois = [];
        let remaining = areaPois.slice();
        let currentLat = routeOrigin[0];
        let currentLng = routeOrigin[1];
        while (ordered.length < maxAreaPois && remaining.length > 0) {
          let nearestIdx = 0;
          let nearestDist = (remaining[0].lat - currentLat) ** 2 + (remaining[0].lng - currentLng) ** 2;
          for (let i = 1; i < remaining.length; i++) {
            const d = (remaining[i].lat - currentLat) ** 2 + (remaining[i].lng - currentLng) ** 2;
            if (d < nearestDist) {
              nearestDist = d;
              nearestIdx = i;
            }
          }
          const next = remaining.splice(nearestIdx, 1)[0];
          ordered.push(next);
          currentLat = next.lat;
          currentLng = next.lng;
        }
        // Use first POI as start, route through the rest (meaningful start/end points)
        const startPoi = ordered[0];
        const restPois = ordered.slice(1);
        const restCoords = restPois.map((p) => [p.lat, p.lng] as [number, number]);

        try {
          const explorationRoute = await fetchOrsWaypointRoute(
            [startPoi.lat, startPoi.lng],
            restCoords,
            intent,
            forceAvoidZones
          );

          if (explorationRoute.duration <= 5400) {
            const { index } = await loadStreetData();
            const { score, breakdown, tags } = scoreRoute(explorationRoute.coordinates, intent, index);
            const poiPoints = loadPoiData();
            const excludeHighlightTypes = getExcludeHighlightTypes(null);
            let highlights = findRouteHighlights(
              explorationRoute.coordinates,
              intent,
              index,
              poiPoints,
              excludeHighlightTypes,
              maxPoisFromRouteDistance(explorationRoute.distance)
            );

            for (const wp of ordered) {
              if (!highlights.some((h) => h.name === wp.name)) {
                highlights.push({
                  lat: wp.lat,
                  lng: wp.lng,
                  label: `📍 ${wp.name}`,
                  name: wp.name,
                  type: "poi",
                  description: wp.description ?? undefined,
                  photo_url: wp.photo_url,
                });
              }
            }

            if (highlights.length > 0) {
              try {
                const labels = await generatePoiLabels(highlights);
                highlights = highlights.map((h, i) => ({
                  ...h,
                  description: trimTrailingPunctuation(labels[i]) || undefined,
                }));
              } catch {
                /* keep existing descriptions */
              }
              try {
                highlights = await enrichHighlightsWithPhotos(highlights);
              } catch {
                /* skip photos */
              }
            }

            let summary = buildSummary(explorationRoute.duration, explorationRoute.distance, tags, intent, isNight);
            try {
              const desc = await generateDescription(intent, breakdown, explorationRoute.duration, explorationRoute.distance, parsedArea, isNight);
              if (desc) summary = desc;
            } catch {
              /* keep template */
            }
            if (isEmotionalSupport && summary) summary = softenSummaryForEmotionalSupport(summary);

            const result = {
              coordinates: explorationRoute.coordinates,
              duration: explorationRoute.duration,
              distance: explorationRoute.distance,
              score,
              breakdown,
              summary,
              highlights,
            };

            const lastPoi = ordered[ordered.length - 1];
            const trailDestinationName =
              ordered.length > 1 ? `${ordered[0].name} → ${lastPoi.name}` : ordered[0].name;
            return NextResponse.json({
              recommended: result,
              quick: result,
              alternatives_count: 1,
              destination_name: trailDestinationName,
              destination_address: null,
              pattern: "mood_and_area",
              intent,
              end_point: [lastPoi.lat, lastPoi.lng],
              night_mode: isNight,
            });
          }
        } catch (e) {
          console.warn("[route] Area exploration route failed, falling back to direct:", e);
        }
      }
    }

    // THEMED WALK ROUTES (after duration is confirmed)
    if (pattern === "themed_walk" && parsedPoiQuery && effectiveDuration != null) {
      const walkDuration = effectiveDuration ?? 30;
      const maxStops = walkDuration <= 15 ? 2 : walkDuration <= 30 ? 3 : walkDuration <= 60 ? 5 : 7;
      const searchRadius = Math.min(walkDuration * 80, 5000);
      const maxSearchResults = maxStops + 3;

      const places = await searchPlace(parsedPoiQuery, originCoords[0], originCoords[1], maxSearchResults, searchRadius);

      if (places.length >= 2) {
        // Nearest-neighbor greedy ordering to minimize backtracking
        const remaining = [...places];
        const ordered: typeof places = [];
        let currentPos: [number, number] = [originCoords[0], originCoords[1]];

        while (ordered.length < maxStops && remaining.length > 0) {
          // Find nearest unvisited POI to current position
          let nearestIdx = 0;
          let nearestDist = Infinity;
          for (let i = 0; i < remaining.length; i++) {
            const d = (remaining[i].lat - currentPos[0]) ** 2 + (remaining[i].lng - currentPos[1]) ** 2;
            if (d < nearestDist) {
              nearestDist = d;
              nearestIdx = i;
            }
          }
          const next = remaining.splice(nearestIdx, 1)[0];
          ordered.push(next);
          currentPos = [next.lat, next.lng];
        }

        let selected = ordered;
        const { index } = await loadStreetData();

        let themedRoute = await fetchOrsWaypointRoute(
          originCoords,
          selected.map((p) => [p.lat, p.lng] as [number, number]),
          intent,
          forceAvoidZones
        );

        const maxDurationSec = walkDuration * 60 * 1.5;
        while (themedRoute.duration > maxDurationSec && selected.length > 2) {
          selected = selected.slice(0, selected.length - 1);
          themedRoute = await fetchOrsWaypointRoute(
            originCoords,
            selected.map((p) => [p.lat, p.lng] as [number, number]),
            intent,
            forceAvoidZones
          );
        }

        const { score, breakdown, tags } = scoreRoute(themedRoute.coordinates, intent, index);
        let highlights: RouteHighlightOut[] = selected.map((p) => ({
          lat: p.lat,
          lng: p.lng,
          label: `📍 ${p.name}`,
          type: "cultural",
          name: p.name,
          description: p.description || "Stop on your trail",
          photo_url: p.photo_url,
        }));

        if (highlights.length > 0) {
          try {
            const labels = await generatePoiLabels(highlights);
            highlights = highlights.map((h, i) => ({
              ...h,
              description: trimTrailingPunctuation(labels[i]) || undefined,
            }));
          } catch {
            /* keep existing */
          }
          try {
            highlights = await enrichHighlightsWithPhotos(highlights);
          } catch {
            /* skip */
          }
        }

        let summary = buildSummary(themedRoute.duration, themedRoute.distance, tags, intent, isNight);
        try {
          const desc = await generateDescription(
            intent,
            breakdown,
            themedRoute.duration,
            themedRoute.distance,
            parsedThemeName || parsedPoiQuery,
            isNight
          );
          if (desc) summary = desc;
        } catch {
          /* keep template */
        }
        if (isEmotionalSupport && summary) summary = softenSummaryForEmotionalSupport(summary);

        const result = {
          coordinates: themedRoute.coordinates,
          duration: themedRoute.duration,
          distance: themedRoute.distance,
          score,
          breakdown,
          summary,
          highlights,
        };

        return NextResponse.json({
          recommended: result,
          quick: result,
          alternatives_count: 1,
          destination_name: parsedThemeName || parsedPoiQuery,
          destination_address: null,
          pattern: "themed_walk",
          intent,
          night_mode: isNight,
        });
      }

      pattern = "mood_only";
    }

    if (destCoords !== null) {
      if (pattern === "mood_and_poi") {
        destCoords = [destCoords[0], destCoords[1]];
        if (destCoords[0] >= 2 && destCoords[0] <= 3 && destCoords[1] >= 41 && destCoords[1] <= 42) {
          destCoords = [destCoords[1], destCoords[0]];
        }
        console.log("Destination validation (mood_and_poi, trusted):", destCoords);
      } else {
        let lat = destCoords[0];
        let lng = destCoords[1];
        if (lat >= 2 && lat <= 3 && lng >= 41 && lng <= 42) {
          [lat, lng] = [lng, lat];
          destCoords = [lat, lng];
        }
        const valid = isInBarcelonaForValidation(lat, lng);
        console.log("Destination validation:", { pattern, destCoords, lat, lng, valid });
        if (!valid) {
          return NextResponse.json(
            { error: "Destination is outside Barcelona — try somewhere closer." },
            { status: 400 }
          );
        }
      }
    }

    if (pattern === "mood_only") {
      const { index } = await loadStreetData();
      // When loop + area (e.g. "Tibidabo walk"), start the loop from the area center so the route stays in that area
      let loopOrigin: [number, number] = [...originCoords];
      if (isLoop && parsedArea) {
        const areaBbox = getAreaBbox(parsedArea);
        if (areaBbox) {
          loopOrigin = [
            (areaBbox.minLat + areaBbox.maxLat) / 2,
            (areaBbox.minLng + areaBbox.maxLng) / 2,
          ];
        } else {
          const geo = await geocodePlace(parsedArea);
          if (geo) loopOrigin = [geo.lat, geo.lng];
        }
        console.log("[route] Loop in area, shifted origin to:", parsedArea);
      }
      // For a loop, total duration is effectiveDuration so one-way = half (e.g. 20 min total → 10 min out → ~800m). For one-way, use full duration.
      const totalDurationSeconds = effectiveDuration! * 60;
      const fullDurationSeconds = isLoop
        ? Math.min(totalDurationSeconds / 2, (MAX_ROUTE_DURATION_MIN * 60) / 2)
        : Math.min(totalDurationSeconds, MAX_ROUTE_DURATION_MIN * 60);
      let waypoint: [number, number];
      let destination_name: string | null = null;
      let destination_address: string | null = null;
      const namedDest = await findMoodOnlyDestination(
        loopOrigin[0],
        loopOrigin[1],
        intent as Intent,
        effectiveDuration!
      );
      if (namedDest) {
        waypoint = [namedDest.lat, namedDest.lng];
        destination_name = namedDest.name;
        destination_address = namedDest.description;
      } else {
        const boundary = await fetchIsochrone(loopOrigin[0], loopOrigin[1], fullDurationSeconds);
        waypoint = pickWaypointFromBoundary(
          intent,
          boundary,
          loopOrigin[0],
          loopOrigin[1],
          index,
          MAX_ROUTE_DISTANCE_M,
          null
        );
      }
      const orsRoutes = await fetchOrsRoutes(loopOrigin, waypoint, intent, forceAvoidZones);
      let oneWayRoute = orsRoutes[0];
      if (!oneWayRoute) throw new Error("No one-way route from ORS");
      if (isLoop) {
        const returnRoutes = await fetchOrsRoutes(waypoint, loopOrigin, intent, forceAvoidZones);
        if (returnRoutes[0]) {
          const outCoords = oneWayRoute.coordinates;
          const backCoords = returnRoutes[0].coordinates;
          const loopCoords = [...outCoords, ...backCoords.slice(1)];
          oneWayRoute = {
            coordinates: loopCoords,
            duration: oneWayRoute.duration + returnRoutes[0].duration,
            distance: oneWayRoute.distance + returnRoutes[0].distance,
          };
        }
      }
      const { score, breakdown, tags } = scoreRoute(oneWayRoute.coordinates, intent, index);
      const poiPoints = loadPoiData();
      const excludeHighlightTypes = getExcludeHighlightTypes(null);
      const moodOnlyMaxPois = poi_focus ? 6 : maxPoisFromRouteDistance(oneWayRoute.distance);
      let highlights: RouteHighlightOut[];
      if (poi_focus && poi_search_terms.length > 0) {
        highlights = await findRouteHighlightsFromPlaces(oneWayRoute.coordinates, poi_search_terms, moodOnlyMaxPois);
      } else {
        highlights = findRouteHighlights(oneWayRoute.coordinates, intent, index, poiPoints, excludeHighlightTypes, moodOnlyMaxPois);
      }
      if (destination_name) {
        highlights = [
          ...highlights,
          {
            lat: waypoint[0],
            lng: waypoint[1],
            label: `📍 ${destination_name}`,
            name: destination_name,
            type: "destination",
            description: undefined,
          },
        ];
      }
      if (highlights.length > 0) {
        try {
          const labels = await generatePoiLabels(highlights);
          highlights = highlights.map((h, i) => ({
            ...h,
            description: trimTrailingPunctuation(labels[i]) || undefined,
          }));
          console.log("[desc] After trim:", JSON.stringify(highlights.map((h) => h.description)));
        } catch {
          highlights = highlights.map((h) => ({ ...h, description: undefined }));
        }
        try {
          highlights = await enrichHighlightsWithPhotos(highlights);
        } catch (e) {
          console.warn("[route] enrichHighlightsWithPhotos (mood_only) failed:", e);
        }
      }
      let summary = buildSummary(oneWayRoute.duration, oneWayRoute.distance, tags, intent, isNight);
      try {
        const destLabel = destination_name ?? null;
        const desc = await generateDescription(intent, breakdown, oneWayRoute.duration, oneWayRoute.distance, destLabel, isNight);
        if (desc) summary = desc;
      } catch {
        // keep template
      }
      if (isEmotionalSupport && summary) summary = softenSummaryForEmotionalSupport(summary);
      const oneWayResult = {
        coordinates: oneWayRoute.coordinates,
        duration: oneWayRoute.duration,
        distance: oneWayRoute.distance,
        score,
        breakdown,
        summary,
        highlights,
      };
      return NextResponse.json({
        recommended: oneWayResult,
        quick: oneWayResult,
        alternatives_count: 1,
        destination_name,
        destination_address,
        pattern: "mood_only",
        intent,
        end_point: isLoop ? [loopOrigin[0], loopOrigin[1]] : [waypoint[0], waypoint[1]],
        night_mode: isNight,
      });
    }

    const needsDestination = pattern === "mood_and_destination" || pattern === "mood_and_area" || pattern === "mood_and_poi";
    if (needsDestination && destCoords === null) {
      return NextResponse.json(
        { error: "Couldn't find that destination — try being more specific." },
        { status: 400 }
      );
    }

    if (destCoords === null) {
      return NextResponse.json(
        { error: "Couldn't find that destination — try being more specific." },
        { status: 400 }
      );
    }

    const { index } = await loadStreetData();

    // For quick intent: get pleasant routes for "fast but pleasant" recommended, and raw fastest for Switch
    const routeIntent = intent === "quick" ? "calm" : intent;
    const orsRoutes = await fetchOrsRoutes(originCoords, destCoords, routeIntent, forceAvoidZones);
    console.log(`[route] Got ${orsRoutes.length} routes from ORS for intent="${routeIntent}"`);

    // Score each route (use routeIntent so quick intent gets calm scoring/tags for recommended)
    const scored: ScoredRoute[] = orsRoutes.map((route) => {
      const { score, breakdown, tags } = scoreRoute(route.coordinates, routeIntent as Intent, index);
      return {
        coordinates: route.coordinates,
        duration: route.duration,
        distance: route.distance,
        score,
        breakdown,
        summary: buildSummary(route.duration, route.distance, tags, intent as Intent, isNight),
      };
    });

    const maxDurationSec = maxDurationMinutes != null ? maxDurationMinutes * 60 : null;
    const withinMaxDuration =
      maxDurationSec != null ? scored.filter((r) => r.duration <= maxDurationSec) : scored;
    const candidates = withinMaxDuration.length > 0 ? withinMaxDuration : scored;

    const allExceedLimits = scored.every(
      (r) => r.duration > MAX_ROUTE_DURATION_MIN * 60 || r.distance > MAX_ROUTE_DISTANCE_M
    );

    // Recommended: when user specified max_duration (e.g. "20min walk to X"), prefer routes within that duration; then quick → shortest, exercise → longest distance, others → highest score.
    let recommended: ScoredRoute;
    if (allExceedLimits) {
      recommended = scored.reduce((a, b) => (a.duration < b.duration ? a : b));
    } else if (intent === "quick") {
      recommended = candidates.reduce((a, b) => (a.duration < b.duration ? a : b));
    } else if (intent === "exercise") {
      recommended = candidates.reduce((a, b) => (a.distance > b.distance ? a : b));
    } else {
      recommended = candidates.reduce((a, b) => (a.score > b.score ? a : b));
    }

    // Quick: shortest-duration alternative (true fastest when intent is quick, else from candidates)
    let quickRaw: { coordinates: [number, number][]; duration: number; distance: number };
    if (intent === "quick") {
      const rawRoutes = await fetchOrsRoutes(originCoords, destCoords, "quick", forceAvoidZones);
      quickRaw = rawRoutes.reduce((a, b) => (a.duration < b.duration ? a : b));
    } else {
      quickRaw = candidates.reduce((a, b) => (a.duration < b.duration ? a : b));
    }
    const { score: quickScore, breakdown: quickBreakdown, tags: quickTags } = scoreRoute(
      quickRaw.coordinates,
      "quick",
      index
    );
    const quick: ScoredRoute = {
      coordinates: quickRaw.coordinates,
      duration: quickRaw.duration,
      distance: quickRaw.distance,
      score: quickScore,
      breakdown: quickBreakdown,
      summary: buildSummary(quickRaw.duration, quickRaw.distance, quickTags, "quick", isNight),
    };

    const poiPoints = loadPoiData();
    const excludeHighlightTypes = getExcludeHighlightTypes(destination_place_type);
    const maxPois =
      destination_place_type && isEstablishmentType(destination_place_type)
        ? 2
        : poi_focus
          ? 6
          : maxPoisFromRouteDistance(recommended.distance);
    let recommendedRouteHighlights: RouteHighlightOut[];
    if (poi_focus && poi_search_terms.length > 0) {
      recommendedRouteHighlights = await findRouteHighlightsFromPlaces(
        recommended.coordinates,
        poi_search_terms,
        maxPois
      );
    } else {
      recommendedRouteHighlights = findRouteHighlights(
        recommended.coordinates,
        intent as Intent,
        index,
        poiPoints,
        excludeHighlightTypes,
        maxPois
      );
    }
    const quickMaxPois =
      destination_place_type && isEstablishmentType(destination_place_type)
        ? 2
        : maxPoisFromRouteDistance(quick.distance);
    let quickRouteHighlights = findRouteHighlights(quick.coordinates, "quick", index, poiPoints, undefined, quickMaxPois);
    if (recommendedRouteHighlights.length > 0) {
      try {
        const labels = await generatePoiLabels(recommendedRouteHighlights);
        recommendedRouteHighlights = recommendedRouteHighlights.map((h, i) => ({
          ...h,
          description: trimTrailingPunctuation(labels[i]) || undefined,
        }));
        console.log("[desc] After trim:", JSON.stringify(recommendedRouteHighlights.map((h) => h.description)));
      } catch {
        recommendedRouteHighlights = recommendedRouteHighlights.map((h) => ({ ...h, description: undefined }));
      }
      try {
        recommendedRouteHighlights = await enrichHighlightsWithPhotos(recommendedRouteHighlights);
      } catch (e) {
        console.warn("[route] enrichHighlightsWithPhotos (recommended) failed:", e);
      }
    }
    try {
      quickRouteHighlights = await enrichHighlightsWithPhotos(quickRouteHighlights);
    } catch (e) {
      console.warn("[route] enrichHighlightsWithPhotos (quick) failed:", e);
    }
    const destinationHighlight =
      destination_name && destCoords
        ? {
            lat: destCoords[0],
            lng: destCoords[1],
            label: `📍 ${destination_name}`,
            type: "destination" as const,
            name: destination_name,
            description: trimTrailingPunctuation(destination_address || "Your destination") || "Your destination",
          }
        : null;
    const maxHighlightsAfterDest = maxPois >= 6 ? 8 : 4;
    const recommendedHighlights = destinationHighlight
      ? [destinationHighlight, ...recommendedRouteHighlights.slice(0, maxHighlightsAfterDest)]
      : recommendedRouteHighlights;
    const quickHighlights = destinationHighlight
      ? [destinationHighlight, ...quickRouteHighlights.slice(0, maxHighlightsAfterDest)]
      : quickRouteHighlights;

    console.log(
      "POI highlights:",
      JSON.stringify(
        recommendedHighlights.map((h) => ({
          name: h.name,
          photoRef: (h as { photo_url?: string }).photo_url ?? (h as { photoReference?: string }).photoReference ?? (h as { photo_reference?: string }).photo_reference ?? null,
        }))
      )
    );

    let recDuration = Math.min(recommended.duration, MAX_ROUTE_DURATION_MIN * 60);
    let recDistance = Math.min(recommended.distance, MAX_ROUTE_DISTANCE_M);
    let qDuration = Math.min(quick.duration, MAX_ROUTE_DURATION_MIN * 60);
    let qDistance = Math.min(quick.distance, MAX_ROUTE_DISTANCE_M);

    // Replace template summaries with LLM-generated descriptions (fallback to template on failure).
    // When isNight, always try LLM so night-aware tags can override buildSummary's "direct route" (e.g. destination_only).
    let recommendedSummary = recommended.summary;
    let quickSummary = quick.summary;
    if (intent !== "quick" || isNight) {
      try {
        const recDesc = await generateDescription(intent, recommended.breakdown, recDuration, recDistance, destination_name, isNight);
        if (recDesc) recommendedSummary = recDesc;
      } catch {
        /* keep template */
      }
    }
    try {
      const qDesc = await generateDescription("quick", quick.breakdown, qDuration, qDistance, destination_name, isNight);
      if (qDesc) quickSummary = qDesc;
    } catch (err) {
      console.warn("[route] generateDescription failed for quick summary:", err);
    }
    if (isEmotionalSupport) {
      if (recommendedSummary) recommendedSummary = softenSummaryForEmotionalSupport(recommendedSummary);
      if (quickSummary) quickSummary = softenSummaryForEmotionalSupport(quickSummary);
    }
    if (allExceedLimits) {
      recommendedSummary = `${recommendedSummary} (Route exceeds 3 hr/20 km; showing shortest option.)`;
    }

    console.log(`[route] Recommended: score=${recommended.score.toFixed(3)}, ${recommendedSummary}`);
    console.log(`[route] Quick: ${quickSummary}`);

    const defaultToFastest =
      (pattern === "mood_and_destination" || pattern === "destination_only") &&
      destCoords != null &&
      isEstablishmentType(destination_place_type);

    console.log(
      "[response] highlights:",
      recommendedHighlights.map((h) => ({
        name: h.name,
        photoRefs: (h as { photoRefs?: string[] }).photoRefs?.length,
      }))
    );
    console.log(
      "[response] recommended highlights photoRefs:",
      JSON.stringify(
        recommendedRouteHighlights.map((h) => ({
          name: h.name,
          photoRefs: (h as { photoRefs?: string[] }).photoRefs?.length,
          photo_urls: (h as { photo_urls?: string[] }).photo_urls?.length,
        }))
      )
    );

    const recommendedPayload = {
      coordinates: recommended.coordinates,
      duration: recDuration,
      distance: recDistance,
      summary: recommendedSummary,
      score: recommended.score,
      breakdown: recommended.breakdown,
      highlights: recommendedHighlights,
    };
    const quickPayload = {
      coordinates: quick.coordinates,
      duration: qDuration,
      distance: qDistance,
      summary: quickSummary,
      score: quick.score,
      breakdown: quick.breakdown,
      highlights: quickHighlights,
    };

    const routesAreSimilar = Math.abs(recommended.duration - quick.duration) < 60;

    return NextResponse.json({
      recommended: defaultToFastest ? quickPayload : recommendedPayload,
      quick: routesAreSimilar ? null : (defaultToFastest ? recommendedPayload : quickPayload),
      default_is_fastest: defaultToFastest ?? false,
      routes_are_similar: routesAreSimilar,
      alternatives_count: scored.length,
      destination_name,
      destination_address,
      pattern,
      intent,
      night_mode: isNight,
    });
  } catch (error) {
    console.error("[route] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 }
    );
  }
}
