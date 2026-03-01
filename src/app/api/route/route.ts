import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { supabase } from "@/lib/supabase";

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
// NIGHT MODE — Raval avoid polygon + safe corridor rerouting
// =============================================================

/** GeoJSON Polygon to avoid El Raval interior (coordinates [lng, lat]). */
const RAVAL_AVOID_POLYGON = {
  type: "Polygon" as const,
  coordinates: [[
    [2.1665, 41.3780],  // NW corner (near MACBA)
    [2.1745, 41.3800],  // NE corner (near La Rambla top)
    [2.1760, 41.3730],  // SE corner (near Drassanes)
    [2.1680, 41.3720],  // SW corner (near Paral·lel)
    [2.1665, 41.3780],  // close the polygon
  ]],
};

/** Bounds for fast point-in-Raval check (lat/lng). */
const RAVAL_BOUNDS = {
  north: 41.3810,
  south: 41.3715,
  west: 2.1660,
  east: 2.1765,
};

function isInsideRaval(lat: number, lng: number): boolean {
  return (
    lat >= RAVAL_BOUNDS.south &&
    lat <= RAVAL_BOUNDS.north &&
    lng >= RAVAL_BOUNDS.west &&
    lng <= RAVAL_BOUNDS.east
  );
}

/** Safe exit/entry points on main streets (La Rambla, Paral·lel). */
const NIGHT_SAFE_CORRIDOR_POINTS = [
  { name: "La Rambla (top)", lat: 41.3800, lng: 2.1735 },
  { name: "La Rambla (mid)", lat: 41.3770, lng: 2.1740 },
  { name: "La Rambla (bottom)", lat: 41.3740, lng: 2.1750 },
  { name: "Paral·lel (west)", lat: 41.3735, lng: 2.1685 },
  { name: "Paral·lel (east)", lat: 41.3730, lng: 2.1720 },
];

function findNearestSafeCorridor(lat: number, lng: number): [number, number] {
  let best = NIGHT_SAFE_CORRIDOR_POINTS[0];
  let bestDist = Infinity;
  for (const p of NIGHT_SAFE_CORRIDOR_POINTS) {
    const d = (p.lat - lat) ** 2 + (p.lng - lng) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return [best.lat, best.lng];
}

/** Bounds for "route likely crosses Raval" check (slightly larger). */
const RAVAL_CROSS_BOUNDS = {
  north: 41.3835,
  south: 41.3720,
  west: 2.1650,
  east: 2.1745,
};

function isInRavalForCrossCheck(lat: number, lng: number): boolean {
  return (
    lat >= RAVAL_CROSS_BOUNDS.south &&
    lat <= RAVAL_CROSS_BOUNDS.north &&
    lng >= RAVAL_CROSS_BOUNDS.west &&
    lng <= RAVAL_CROSS_BOUNDS.east
  );
}

/** La Rambla waypoints for forcing night routes around Raval (well-lit corridor). */
const RAMBLA_WAYPOINTS = [
  { lat: 41.3810, lng: 2.1734, name: "Plaça Catalunya end" },
  { lat: 41.3790, lng: 2.1740, name: "La Rambla upper" },
  { lat: 41.3760, lng: 2.1748, name: "La Rambla middle" },
  { lat: 41.3735, lng: 2.1755, name: "La Rambla lower" },
];

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

/** Bearing in degrees from point A to B (0 = N, 90 = E). Coords are [lng, lat]. */
function bearingDeg(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Count significant direction changes (turns) in route. Coords are [lng, lat]. */
function countSignificantTurns(routeCoords: [number, number][], thresholdDeg: number): number {
  if (routeCoords.length < 3) return 0;
  let count = 0;
  for (let i = 1; i < routeCoords.length - 1; i++) {
    const b1 = bearingDeg(routeCoords[i - 1], routeCoords[i]);
    const b2 = bearingDeg(routeCoords[i], routeCoords[i + 1]);
    let turn = b2 - b1;
    if (turn > 180) turn -= 360;
    if (turn < -180) turn += 360;
    if (Math.abs(turn) > thresholdDeg) count++;
  }
  return count;
}

/** Perpendicular distance from point to line segment (in degree units). */
function perpendicularDistance(
  point: [number, number],
  lineStart: [number, number],
  lineEnd: [number, number]
): number {
  const [px, py] = point;
  const [ax, ay] = lineStart;
  const [bx, by] = lineEnd;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  return Math.abs(dx * (ay - py) - (ax - px) * dy) / len;
}

/** Douglas–Peucker simplification for display; keeps original for distance/time. Tolerance in degrees (~0.00008 ≈ 8m). */
function simplifyRoute(coords: [number, number][], tolerance: number = 0.00008): [number, number][] {
  if (coords.length < 3) return coords;
  let maxDist = 0;
  let maxIndex = 0;
  const start = coords[0];
  const end = coords[coords.length - 1];
  for (let i = 1; i < coords.length - 1; i++) {
    const dist = perpendicularDistance(coords[i], start, end);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }
  if (maxDist > tolerance) {
    const left = simplifyRoute(coords.slice(0, maxIndex + 1), tolerance);
    const right = simplifyRoute(coords.slice(maxIndex), tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
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
  let score = (
    weights.noise * avgNoise +
    weights.green * avgGreen +
    weights.clean * avgClean +
    weights.cultural * avgCultural
  );

  // Calm and nature routes: penalize many turns (prefer straighter, gentler paths)
  if (intent === "calm" || intent === "nature") {
    const turnCount = countSignificantTurns(routeCoords, 45);
    const turnPenalty = turnCount * 0.02;
    score -= turnPenalty;
  }

  // Data-driven tags: prefer tags that match intent, never show tags that contradict mood
  const INTENT_PREFERRED: Record<Intent, string[]> = {
    calm: ["quiet streets", "away from crowds", "leafy trees", "tree-lined streets", "green paths", "low traffic", "peaceful blocks", "pedestrian walkways", "pleasant streets"],
    nature: ["quiet streets", "away from crowds", "leafy trees", "tree-lined streets", "green paths", "park paths", "garden walkways", "low traffic", "pedestrian walkways"],
    discover: ["historic buildings", "interesting facades", "car-free streets", "waterfront views", "pedestrian walkways"],
    scenic: ["historic buildings", "interesting facades", "car-free streets", "waterfront views", "pedestrian walkways"],
    lively: ["pedestrian walkways", "car-free streets", "interesting facades", "historic buildings"],
    cafe: ["pedestrian walkways", "car-free streets", "interesting facades", "historic buildings"],
    exercise: ["park paths", "tree-lined streets", "pedestrian walkways", "green paths", "leafy trees"],
    quick: ["direct route", "main streets", "low traffic", "pleasant streets"],
  };
  const INTENT_FORBIDDEN: Record<Intent, string[]> = {
    calm: ["busy corridors", "well-lit streets"],
    nature: ["busy corridors", "well-lit streets"],
    discover: [],
    scenic: [],
    lively: ["quiet streets", "peaceful blocks"],
    cafe: ["quiet streets", "peaceful blocks"],
    exercise: [],
    quick: [],
  };

  /** Mood-adapted tag wording: same score, intent-specific label (e.g. calm → "tree-lined paths" not "tree-lined streets"). */
  const INTENT_TAG_OVERRIDE: Partial<Record<Intent, Record<string, string>>> = {
    calm: {
      "tree-lined streets": "tree-lined paths",
      "peaceful blocks": "peaceful neighborhoods",
      "green paths": "tree-lined paths",
      "quiet streets": "quiet streets",
      "low traffic": "low traffic",
      "pleasant streets": "pleasant streets",
    },
    nature: {
      "green paths": "green corridors",
      "tree-lined streets": "park paths",
      "leafy trees": "tree-lined streets",
      "quiet streets": "quiet streets",
      "low traffic": "low traffic",
    },
    scenic: {
      "historic buildings": "beautiful architecture",
      "interesting facades": "charming streets",
      "pleasant streets": "charming streets",
    },
    lively: {
      "interesting facades": "buzzing streets",
      "historic buildings": "lively neighborhoods",
    },
  };

  const candidates: { score: number; tag: string }[] = [];
  if (avgNoise > 0.5) candidates.push({ score: avgNoise, tag: "quiet streets" });
  if (avgNoise > 0.6) candidates.push({ score: avgNoise, tag: "peaceful blocks" });
  if (avgNoise > 0.5) candidates.push({ score: avgNoise, tag: "low traffic" });
  if (avgGreen > 0.35) candidates.push({ score: avgGreen, tag: "leafy trees" });
  if (avgGreen > 0.4) candidates.push({ score: avgGreen, tag: "tree-lined streets" });
  if (avgGreen > 0.45) candidates.push({ score: avgGreen, tag: "green paths" });
  if (avgClean > 0.85) candidates.push({ score: avgClean, tag: "pleasant streets" });
  if (avgCultural > 0.3) candidates.push({ score: avgCultural, tag: "historic buildings" });
  if (avgCultural > 0.35) candidates.push({ score: avgCultural, tag: "interesting facades" });
  if ((intent === "calm" || intent === "nature") && avgNoise > 0.55) {
    candidates.push({ score: avgNoise, tag: "away from crowds" });
  }

  const forbidden = new Set(INTENT_FORBIDDEN[intent]);
  const preferred = INTENT_PREFERRED[intent];
  const filtered = candidates.filter((c) => !forbidden.has(c.tag));
  // Sort: preferred tags first (by order in list), then by score descending
  filtered.sort((a, b) => {
    const ia = preferred.indexOf(a.tag);
    const ib = preferred.indexOf(b.tag);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return b.score - a.score;
  });
  const overrides = INTENT_TAG_OVERRIDE[intent];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const { tag } of filtered) {
    if (tags.length >= 3) break;
    const displayTag = overrides?.[tag] ?? tag;
    if (!seen.has(displayTag)) {
      seen.add(displayTag);
      tags.push(displayTag);
    }
  }

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
  // Night-only safety tags: only when night mode is on and intent is not calm/nature (they never get these)
  const allowNightSafetyTags = Boolean(nightMode) && intent !== "calm" && intent !== "nature";
  if (allowNightSafetyTags && intent === "quick") {
    return "well-lit streets · busy corridors";
  }
  if (tags.length > 0) {
    if (allowNightSafetyTags) {
      const nightTags = ["well-lit streets", "busy corridors", ...tags];
      return nightTags.slice(0, 3).join(" · ");
    }
    return tags.slice(0, 3).join(" · ");
  }
  if (allowNightSafetyTags) {
    return "well-lit streets · busy corridors";
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

  // Build ORS request: origin → destination. Night mode may add avoid_polygons or fallback to 4 waypoints.
  const originLng = origin[1];
  const originLat = origin[0];
  const destLng = destination[1];
  const destLat = destination[0];

  let orsCoords: [number, number][] = [
    [originLng, originLat],
    [destLng, destLat],
  ];

  const body: Record<string, unknown> = {
    coordinates: orsCoords,
    alternative_routes: {
      target_count: 3,
      share_factor: 0.6,
      weight_factor: 1.6,
    },
  };

  if (isNight) {
    const avoidRaval = {
      type: "Polygon" as const,
      coordinates: [[
        [2.167, 41.383],   // NW - near Universitat/MACBA
        [2.173, 41.383],   // NE - just west of La Rambla (leaves Rambla open)
        [2.173, 41.3725],  // SE - just west of La Rambla at south end
        [2.167, 41.3725],  // SW - just north of Paral·lel (leaves Paral·lel open)
        [2.167, 41.383],   // close polygon
      ]],
    };
    if (!body.options) body.options = {};
    (body.options as Record<string, unknown>).avoid_polygons = avoidRaval;
    console.log("[route] NIGHT MODE: avoid_polygons added for Raval");
  }

  console.log("ORS REQUEST BODY:", JSON.stringify(body, null, 2));

  let res = await fetch(
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

  if (!res.ok && res.status === 400 && isNight) {
    const errorText = await res.text();
    console.log("[route] ORS 400 with avoid_polygons, full response:", errorText);
    console.log("[route] NIGHT MODE: falling back to 4-waypoint route around Raval");
    delete (body.options as Record<string, unknown>)?.avoid_polygons;
    orsCoords = [
      [originLng, originLat],
      [2.174, 41.38],   // Plaça Catalunya / top of La Rambla
      [2.175, 41.374],  // Bottom of La Rambla / Drassanes
      [2.169, 41.373],  // Paral·lel near Sala Apolo
      [destLng, destLat],
    ];
    body.coordinates = orsCoords;
    res = await fetch(
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
  }

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

/** Waypoint at distanceM from origin in direction bearingDeg (0 = north, 90 = east). */
function waypointFromBearing(
  originLat: number,
  originLng: number,
  distanceM: number,
  bearingDeg: number
): [number, number] {
  const latDegPerM = 1 / 111320;
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const originLatRad = (originLat * Math.PI) / 180;
  const lngDegPerM = 1 / (111320 * Math.cos(originLatRad));
  const waypointLat = originLat + distanceM * latDegPerM * Math.cos(bearingRad);
  const waypointLng = originLng + distanceM * lngDegPerM * Math.sin(bearingRad);
  return [waypointLat, waypointLng];
}

/** Clamp [lat, lng] to BCN_BBOX_RANDOM so random waypoints stay within Barcelona. */
function clampWaypointToBarcelona(wp: [number, number]): [number, number] {
  return [
    Math.max(BCN_BBOX_RANDOM.minLat, Math.min(BCN_BBOX_RANDOM.maxLat, wp[0])),
    Math.max(BCN_BBOX_RANDOM.minLng, Math.min(BCN_BBOX_RANDOM.maxLng, wp[1])),
  ];
}

/** Options for offsetPerpendicular. */
interface OffsetPerpendicularOpts {
  /** 1 = left, -1 = right (relative to from→to). */
  sign?: number;
  /** Fraction along segment (0=from, 0.5=midpoint, 1=to). Default 0.5. */
  along?: number;
  /** If true, offset in a 45° diagonal direction (between perp and back-to-origin). */
  diagonal?: boolean;
}

/** Point ~offsetM meters perpendicular to the line from (fromLat,fromLng) to (toLat,toLng). Used so the return leg takes different streets. */
function offsetPerpendicular(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  offsetM: number = 200,
  opts?: OffsetPerpendicularOpts
): [number, number] {
  const sign = opts?.sign ?? 1;
  const along = opts?.along ?? 0.5;
  const diagonal = opts?.diagonal ?? false;
  const baseLat = fromLat + along * (toLat - fromLat);
  const baseLng = fromLng + along * (toLng - fromLng);
  const dirLng = toLng - fromLng;
  const dirLat = toLat - fromLat;
  let pLat = -dirLng;
  let pLng = dirLat;
  if (diagonal) {
    const perpNorm = Math.sqrt(pLat * pLat + pLng * pLng) || 1;
    const backLat = -dirLat;
    const backLng = -dirLng;
    const backNorm = Math.sqrt(backLat * backLat + backLng * backLng) || 1;
    pLat = pLat / perpNorm + backLat / backNorm;
    pLng = pLng / perpNorm + backLng / backNorm;
  }
  const norm = Math.sqrt(pLat * pLat + pLng * pLng) || 1;
  pLat = pLat / norm;
  pLng = pLng / norm;
  const latDegPerM = 1 / 111320;
  const baseLatRad = (baseLat * Math.PI) / 180;
  const lngDegPerM = 1 / (111320 * Math.cos(baseLatRad));
  const effectiveOffset = offsetM * sign;
  const offsetLat = baseLat + (effectiveOffset * pLat) * latDegPerM;
  const offsetLng = baseLng + (effectiveOffset * pLng) * lngDegPerM;
  return [offsetLat, offsetLng];
}

/** Fraction of return coords that are within thresholdM of any outbound coord. Coords are [lng, lat] (ORS order). */
function fractionReturnNearOutbound(
  outboundCoords: [number, number][],
  returnCoords: [number, number][],
  thresholdM: number
): number {
  if (returnCoords.length === 0) return 0;
  let near = 0;
  for (const r of returnCoords) {
    const rLat = r[1];
    const rLng = r[0];
    for (const o of outboundCoords) {
      if (distMeters([o[1], o[0]], [rLat, rLng]) <= thresholdM) {
        near += 1;
        break;
      }
    }
  }
  return near / returnCoords.length;
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
  /** true when user wants to "get lost", "wander", "no plan" — pick a completely random direction/destination. */
  is_surprise?: boolean;
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
  "is_loop": true or false,
  "is_surprise": true or false
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
- IMPORTANT: When the user asks for a TYPE of place with specific requirements (e.g. 'laptop-friendly cafes', 'cafes with wifi', 'bars with outdoor seating', 'restaurants with a view'), this is ALWAYS mood_and_poi — NOT mood_only. The user wants to FIND a specific place, not go for a mood walk. Set pattern to mood_and_poi and generate a poi_query.
- 'laptop-friendly cafes' → mood_and_poi, poi_query 'laptop friendly cafe wifi Barcelona', intent calm
- 'work-friendly', 'study spot', 'place to work', 'coworking cafe' → same as laptop-friendly: mood_and_poi, poi_query 'laptop friendly cafe wifi Barcelona' (or 'coworking cafe Barcelona'), intent calm
- 'cafes with wifi' → mood_and_poi, poi_query 'cafe wifi laptop Barcelona', intent calm
- 'quiet bar for groups' → mood_and_poi, poi_query 'bar for groups Barcelona', intent calm
- 'restaurant with a terrace' → mood_and_poi, poi_query 'restaurant terrace outdoor seating Barcelona', intent calm
The keyword here is that the user is describing a PLACE they want to go to, not a WALK they want to take.
- 'restaurant' IS a place type. "Something active outdoors", "hike", "trail", "workout walk" get mood_and_poi with outdoor poi_query so the user gets a destination first (not duration picker).
- 'show me something I've never seen' is mood_only, not mood_and_poi.
- RANDOM / SURPRISE: "surprise me", "get lost", "I want to get lost", "get lost for a bit", "lose myself", "wander", "no plan", "just walk" → pattern mood_only, intent discover, is_surprise: true, skip_duration: true. You MUST set both is_surprise and skip_duration so the app treats these as random-direction routes (no duration picker, server picks ~25 min). Never use a different pattern for these phrases.
- 'surprise me' is mood_only with is_surprise: true, skip_duration: true.

- KEY: Does the user name a SPECIFIC PLACE (e.g. Sagrada Familia, Gràcia, Barceloneta) or just a VIBE/THEME (e.g. "architecture", "scenic", "calm by the beach")? If it's a vibe or theme with NO named place → mood_only (we will ask for duration). If they name a specific place or area → has destination (mood_and_destination or mood_and_area).
- Open-ended vibe/theme with no specific destination → mood_only: "scenic walk", "peaceful stroll", "pretty route" = mood_only (no POI, no destination; we ask duration). Exception: "architecture hunt", "architecture walk", "see cool buildings" → themed_walk (see architecture rule below).
- ARCHITECTURE: "architecture hunt", "architecture walk", "see cool buildings" → themed_walk with poi_query "notable architecture landmark building Barcelona", theme_name "architecture hunt". Do NOT use "architecture" alone — it returns offices/firms. For Barcelona, target Modernisme buildings, churches, notable facades. "architecture hunt in [area]" → themed_walk with poi_query "notable architecture landmark building [area] Barcelona", area: "[area]", theme_name "architecture hunt".
- Specific place or area → has destination: "walk to Sagrada Familia", "cafe near Gràcia", "route to Park Güell", "get me to Barceloneta" = mood_and_destination or mood_and_area (do not ask duration).
- "[adjective] way/route/path/walk to [place]" is ALWAYS mood_and_destination (or mood_and_area if place is an area like "the beach"). The words "way", "route", "path", "walk" before "to [destination]" mean the user wants to GO somewhere with a mood — use mood_and_destination (or mood_and_area for areas), NOT mood_only. Examples: "fun way to ELISAVA" → intent lively, pattern mood_and_destination, destination "ELISAVA". "nice way to the beach" → intent scenic, pattern mood_and_area, area "Barceloneta". "quick way to Park Güell" → intent quick, pattern mood_and_destination, destination "Park Güell". "pretty way to Gràcia" → intent scenic, pattern mood_and_destination or mood_and_area. "safe way to the station" → intent calm, pattern mood_and_destination. "interesting way to the museum" → intent discover, pattern mood_and_destination.
- If the user wants to GO TO a specific named place → mood_and_destination
- If the user wants to GO TO a type of place (one cafe, one gym) → mood_and_poi
- If the user wants to WALK PAST multiple places of a theme → themed_walk
- If the user wants to wander with no destination → mood_only
- 'discover Gaudi' = themed_walk (walk past Gaudi buildings, not go to one)
- 'find a cafe' = mood_and_poi (go to one specific cafe)
- 'cafe hopping' = themed_walk (walk past multiple cafes)
- 'food hunt' = themed_walk
- 'architecture trail' = themed_walk
- 'surprise me' = mood_only with discover intent, is_surprise: true. Also set skip_duration: true so the duration picker is skipped.

Destination vs walk feeling: If the user describes an ACTIVITY or PLACE TYPE they want to visit (e.g., "something active indoors", "a cozy bookshop", "live music"), classify as mood_and_poi and generate a poi_query for Google Places. The intent should describe the WALK to get there (e.g., scenic, calm, quick), not the activity itself. "I want a calm walk" = mood_only with intent calm (no POI). "Something active indoors" = mood_and_poi with poi_query like "indoor activities Barcelona" or "climbing gym Barcelona", intent e.g. quick or calm for the walk.
- NAMED HIKING AREA TAKES PRIORITY: When the user names a known hiking/nature area (Montjuïc, Tibidabo, Collserola, El Carmel, Carmel) plus "hike", "walk", or "trail" (e.g. "Montjuïc hike", "monjuic hike", "Tibidabo walk", "Collserola trail"), ALWAYS use mood_and_area with that area and intent nature — NOT mood_and_poi. The app uses curated waypoints for these areas; do not return place_options.
- "something active outdoors", "active outdoors", "outdoor exercise", "hike", "trail" (without a named area above) → mood_and_poi with intent exercise and poi_query "Montjuïc park hiking trail viewpoint Barcelona". This finds actual outdoor activity spots, not tour companies. Do NOT classify as mood_only.
- "go for a run", "running route", "jog", "get my steps in" → mood_only with intent exercise (these are duration-based loop routes, not destination-based).

- SPECIFIC BUSINESS / PLACE NAMES: If the user's input looks like a specific business name, brand, or place name that you don't recognize as a general mood or intent, classify it as pattern "destination_only" with the full input as the destination. Do NOT try to interpret unfamiliar names as moods or intents. Examples: "vivagym bruc" → destination_only, destination "vivagym bruc". "day day go" → destination_only, destination "day day go". "café centric" → destination_only, destination "café centric". When in doubt between a mood and a specific place name, prefer destination_only.
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
- lively/buzzy: "energy", "vibrant", "bustling", "lively neighborhood", "good vibes", "vibes". "energetic walk with good vibes" → intent lively (social/vibe) or exercise (physical); prefer exercise if "workout"/"steps" present, else lively.
- exercise/steps: "long walk", "hilly", "workout walk", "energetic", "energetic walk". "something active outdoors", "active outdoors", "outdoor exercise", "hike", "trail" (when no named hiking area) → mood_and_poi with intent exercise, poi_query "Montjuïc park hiking trail viewpoint Barcelona". "Montjuïc hike", "Tibidabo walk", "Collserola trail" etc. → mood_and_area (see NAMED HIKING AREA rule). "go for a run", "running route", "jog", "get my steps in" → mood_only with intent exercise (duration-based loop).
- cafe/food: "cafe", "coffee", "matcha", "food", "restaurant", "tapas", "brunch"
- quick: "fast", "direct", "hurry", "late", "shortest", "efficient", "rush", "in a rush", "rushing", "urgent", "emergency", "asap", "quickly", "running late", "need to be there", "don't want to be late", "appointment"
- URGENCY OVERRIDE: If the user expresses urgency, time pressure, or uses words like "rush", "hurry", "late", "emergency", "urgent", "asap", or mentions a time constraint like "I need to be there by 3", ALWAYS set intent to "quick" regardless of other mood words. Urgency beats mood. "I'm in a rush to the hospital" = intent quick, NOT calm or scenic.
- COMPOUND "quick but nice/pretty/scenic": When the user wants both speed AND pleasantness (e.g. "quick but nice walk to X", "fastest pretty route", "get there fast but make it nice"), set intent to "scenic" (so the recommended route is pleasant). The app will show the pleasant route as recommended and the fastest route prominently via the existing Switch option. Classify intent as "scenic" for these.
- TIME-AWARE QUERIES: When the user mentions time of day or night, adjust intent accordingly. "late night walk" → intent calm (quiet, well-lit streets preferred). "late night walk, feeling unsafe" → intent calm, theme_name "night_safety". "evening stroll" → intent scenic. "morning walk" → intent nature. "sunrise walk" → intent nature. The app applies after-dark safety weighting automatically based on actual time — the LLM just sets the right mood intent. If the user explicitly mentions feeling unsafe at night, set theme_name to "night_safety" so the app can add extra reassurance.

Examples:
- "energetic walk with good vibes" → mood_only, intent: lively or exercise (no destination; user wants vibe/energy).
- "walk to hospital clinic, I'm in a rush" → intent: quick, pattern: mood_and_destination, destination: "Hospital Clínic"
- "get me to ELISAVA fast" → intent: quick, pattern: mood_and_destination
- "quick but nice walk to ELISAVA" → intent: scenic, pattern: mood_and_destination
- "I'm late for class at ELISAVA" → intent: quick, pattern: mood_and_destination
- "need to be at Sagrada Familia by 3" → intent: quick, pattern: mood_and_destination
- "fun way to ELISAVA" → intent: lively, pattern: mood_and_destination, destination: "ELISAVA"
- "nice way to the beach" → intent: scenic, pattern: mood_and_area, area: "Barceloneta"
- "quick way to Park Güell" → intent: quick, pattern: mood_and_destination, destination: "Park Güell"
- "pretty way to Gràcia" → intent: scenic, pattern: mood_and_destination or mood_and_area, destination/area: "Gràcia"
- "safe way to the station" → intent: calm, pattern: mood_and_destination
- "interesting way to the museum" → intent: discover, pattern: mood_and_destination

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
      is_surprise: false,
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
  const is_surprise = parsed.is_surprise === true;

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
    is_surprise: is_surprise,
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
  /** Google Places ID for dedup (e.g. when merging original + broadened results). */
  place_id?: string | null;
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
  /** Formatted address from Google Places (for destination display). */
  address?: string | null;
  /** Raw editorial text for qualifier verification (Tier B). */
  editorial?: string | null;
  /** Raw reviews for qualifier verification (Tier B). */
  reviews?: Array<{ text?: { text?: string } }>;
  /** Set by qualifier verification when place matches the searched qualifier. */
  qualifierVerified?: boolean;
  /** "editorial" | "review" | "web" | "ai_review" when qualifierVerified is true. */
  qualifierSource?: string | null;
  /** Short reason from LLM verification (e.g. "reviews mention dogs and pet-friendly vibe"). */
  qualifierReason?: string | null;
  /** For subjective sort (e.g. "sorted by most reviewed"). */
  userRatingCount?: number | null;
  /** For subjective sort (price_asc / price_desc). */
  priceLevel?: number | null;
  /** Weighted keyword mention count (name x5, editorial x2, reviews x1) for final relevance sort. */
  relevanceScore?: number;
}

/** Map Google price level string to number for sorting (1=cheapest, 4=most expensive). */
const PRICE_LEVEL_TO_NUMBER: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
};

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
    "laptop", "wifi", "work", "coworking", "co-working", "study", "studying", "work-friendly", "study spot", "place to work",
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

const PROXIMITY_PATTERN = /near me|nearby|close to|around here|walking distance|closest|nearest/;
const SPECIFIC_STOP_WORDS = ["best", "top", "popular", "famous", "good", "great", "nice", "cheap", "budget", "fancy", "the", "in", "for", "and", "with", "a", "my", "me", "near", "nearby", "barcelona", "bcn", "underrated", "authentic", "local", "trendy", "affordable", "upscale", "hidden", "gem"];
const SUBJECTIVE_QUALIFIER_WORDS = ["best", "top", "popular", "famous", "hidden gem", "underrated", "cheap", "affordable", "fancy", "upscale", "new", "budget", "budget-friendly", "cheap eats", "high-end", "trendy", "authentic", "local"];

/** True when the user searched for something specific (product/cuisine or subjective qualifier) and did NOT emphasize proximity. Relevance should outweigh distance. */
function isSpecificSearch(poiQuery: string | null, moodText: string | null): boolean {
  if (!poiQuery && !moodText) return false;
  const text = `${poiQuery || ""} ${moodText || ""}`.toLowerCase();
  if (PROXIMITY_PATTERN.test(text)) return false;
  const contentKeywords = text.split(/\s+/).filter((w) => w.length > 2 && !SPECIFIC_STOP_WORDS.includes(w));
  const hasSubjective = SUBJECTIVE_QUALIFIER_WORDS.some((q) => new RegExp(`\\b${q.replace(/-/g, "\\-")}\\b`, "i").test(text));
  const genericOnly = contentKeywords.length === 0 || contentKeywords.every((w) => ["cafe", "cafes", "restaurant", "bar", "barcelona", "bcn", "place", "places"].includes(w));
  return hasSubjective || !genericOnly;
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

/** Final relevance sort — places matching original query keywords first, then by rating. Use as last step before returning place_options. */
function applyFinalRelevanceSort(places: PlaceOptionResult[], moodText: string | null): PlaceOptionResult[] {
  if (!places.length || moodText == null || typeof moodText !== "string") return places;
  const originalWords = String(moodText)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["best", "good", "nice", "great", "the", "for", "and", "with"].includes(w));
  if (originalWords.length === 0) return places;
  const sorted = [...places];
  sorted.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aMatch = originalWords.some((w) => aName.includes(w)) ? 1 : 0;
    const bMatch = originalWords.some((w) => bName.includes(w)) ? 1 : 0;
    if (bMatch !== aMatch) return bMatch - aMatch; // keyword matches first
    return (b.rating ?? 0) - (a.rating ?? 0); // then by rating
  });
  return sorted;
}

const CONTENT_KEYWORD_STOP_WORDS = ["best", "top", "popular", "famous", "good", "great", "nice", "cheap", "budget", "fancy", "the", "in", "for", "and", "with", "a", "my", "me", "near", "nearby", "barcelona", "bcn", "underrated", "authentic", "local", "trendy", "affordable", "upscale", "hidden", "gem"];

/** Escape string for use in RegExp (literal match). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Score places by keyword frequency (name x5, editorial x2, reviews x1) and sort. Final sort before place_options. */
function applyKeywordRelevanceSort(places: PlaceOptionResult[], moodText: string | null): PlaceOptionResult[] {
  if (!places.length || moodText == null || typeof moodText !== "string") return places;
  const text = String(moodText).toLowerCase();
  const contentKeywords = text
    .split(/\s+/)
    .filter((w) => w.length > 2 && !CONTENT_KEYWORD_STOP_WORDS.includes(w));
  if (contentKeywords.length === 0) return places;

  for (const place of places) {
    let mentionCount = 0;
    const nameL = (place.name ?? "").toLowerCase();
    const editorialL = (place.editorial ?? "").toLowerCase();
    const reviewTexts = (place.reviews ?? [])
      .map((r: { text?: { text?: string } }) => (r.text?.text ?? "").toLowerCase())
      .join(" ");

    for (const kw of contentKeywords) {
      const re = new RegExp(escapeRegex(kw), "g");
      const nameMatches = (nameL.match(re) ?? []).length;
      mentionCount += nameMatches * 5;
      const editorialMatches = (editorialL.match(re) ?? []).length;
      mentionCount += editorialMatches * 2;
      const reviewMatches = (reviewTexts.match(re) ?? []).length;
      mentionCount += reviewMatches;
    }

    place.relevanceScore = mentionCount;
    console.log(`[relevance] ${place.name}: ${mentionCount} weighted mentions`);
  }

  places.sort((a, b) => {
    if ((b.relevanceScore ?? 0) !== (a.relevanceScore ?? 0)) {
      return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
    }
    return (b.rating ?? 0) - (a.rating ?? 0);
  });

  console.log("[relevance] Final order:", places.slice(0, 5).map((p) => `${p.name} (${p.relevanceScore})`));
  return places;
}

const PLACE_TYPE_KEYWORDS = ["cafe", "cafes", "restaurant", "bar", "bakery", "bookshop", "gym", "pharmacy", "museum", "gallery", "library", "food", "eats"];

/** Feature qualifiers are verified via reviews/web, not used for subjective sort. */
const FEATURE_QUALIFIERS = ["laptop-friendly", "work-friendly", "pet-friendly", "dog-friendly", "kid-friendly", "wheelchair", "wifi", "vegan", "gluten-free", "halal"];

const subjectiveQualifiers: Record<string, { sortBy: string; label: string }> = {
  "best": { sortBy: "rating_weighted", label: "sorted by highest rated" },
  "top": { sortBy: "review_count", label: "sorted by most reviewed" },
  "popular": { sortBy: "review_count", label: "sorted by most reviewed" },
  "famous": { sortBy: "review_count", label: "sorted by most reviewed" },
  "hidden gem": { sortBy: "hidden_gem", label: "lesser-known spots with great ratings" },
  "underrated": { sortBy: "hidden_gem", label: "lesser-known spots with great ratings" },
  "cheap": { sortBy: "price_asc", label: "sorted by lowest price" },
  "affordable": { sortBy: "price_asc", label: "sorted by lowest price" },
  "fancy": { sortBy: "price_desc", label: "sorted by highest price and rating" },
  "upscale": { sortBy: "price_desc", label: "sorted by highest price and rating" },
  "new": { sortBy: "newest", label: "we can't always verify how new these are" },
  "budget": { sortBy: "price_asc", label: "sorted by lowest price" },
  "budget-friendly": { sortBy: "price_asc", label: "sorted by lowest price" },
  "cheap eats": { sortBy: "price_asc", label: "sorted by lowest price" },
  "high-end": { sortBy: "price_desc", label: "sorted by highest price and rating" },
  "trendy": { sortBy: "review_count", label: "sorted by most reviewed" },
  "authentic": { sortBy: "rating_weighted", label: "sorted by highest rated" },
  "local": { sortBy: "hidden_gem", label: "lesser-known spots with great ratings" },
};

/** Generate a short human-readable headline for search results (for sort_label). Explains WHY/HOW results were chosen, not what the user searched. Returns uppercase or null. */
async function generateSearchSummary(context: {
  moodText: string;
  places: PlaceOptionResult[];
  detectedQualifier: string | null;
  detectedSubjective: string | null;
  didBroaden: boolean;
  poiSearchRadius: number;
  contentKeywords: string[];
}): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const { moodText, places, contentKeywords, detectedQualifier, detectedSubjective } = context;
  const totalFound = places.length;
  const matchingContent =
    contentKeywords.length > 0
      ? places.filter((p) => contentKeywords.some((kw) => (p.name ?? "").toLowerCase().includes(kw)))
      : places;
  const matchingCount = matchingContent.length;
  const userSaidBest = /\bbest\b/i.test(moodText);
  try {
    const userHint =
      contentKeywords.length > 0 && matchingCount > 0
        ? `User searched: "${moodText}". We found ${totalFound} places; ${matchingCount} match the theme (e.g. ${contentKeywords.slice(0, 2).join(", ")}).`
        : `User searched: "${moodText}". We found ${totalFound} places.`;
    const sortContext: string[] = [];
    if (detectedQualifier) sortContext.push(`Results are verified for: ${detectedQualifier}`);
    if (detectedSubjective) sortContext.push(`Subjective sort: ${detectedSubjective}`);
    if (matchingCount > 0 && contentKeywords.length > 0) sortContext.push("Results ranked by relevance to the search theme");
    const contextLine = sortContext.length > 0 ? `\nContext: ${sortContext.join(". ")}` : "";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content: `You generate a short headline (4-8 words, UPPERCASE) that explains WHY these places were chosen or HOW they're ranked. Do NOT repeat the user's search query or category. Describe the quality signal or sorting criteria instead.

Rules:
- Do NOT include the city name (Barcelona, BCN, etc.) — the user already knows where they are.
- Do NOT use the word "best" if the user's query already contained "best".
- Tell the user something NEW: the quality signal, not the category.

Examples by situation:
- Sorted by rating: TOP RATED BY LOCALS
- Hidden gems (high rating, fewer reviews): HIDDEN GEMS WORTH DISCOVERING
- Relevance to a specific product (e.g. matcha): HIGHLY RATED FOR MATCHA
- Verified by reviews: CONFIRMED IN RECENT REVIEWS
- Sorted by price (value): BEST VALUE PICKS
- Feature qualifier (e.g. pet-friendly): VERIFIED PET-FRIENDLY SPOTS
- Laptop-friendly: VERIFIED LAPTOP-FRIENDLY SPOTS

Reply with ONLY the headline in UPPERCASE, no quotes, no period.`,
          },
          {
            role: "user",
            content: `${userHint}${contextLine}\n\nGenerate one headline (4-8 words, UPPERCASE). Do not repeat the search query.${userSaidBest ? " Do not use the word BEST." : ""}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    let summary = data.choices?.[0]?.message?.content?.trim() ?? null;
    if (summary) {
      summary = summary.toUpperCase();
      if (userSaidBest && /\bBEST\b/.test(summary)) {
        summary = summary.replace(/\bBEST\b/g, "TOP").trim();
      }
      if (/BARCELONA|BCN\b/.test(summary)) {
        summary = summary.replace(/\s*(BARCELONA|BCN)\s*/gi, " ").replace(/\s+/g, " ").trim();
      }
      console.log("[sort] Generated summary:", summary);
    }
    return summary;
  } catch (e) {
    console.log("[sort] generateSearchSummary failed:", e);
    return null;
  }
}

/** Apply subjective qualifier sort and return contextual sort_label. Two-tier: relevance to query first, then subjective (rating/price etc). Mutates places in place. */
function applySubjectiveSortAndLabel(places: PlaceOptionResult[], moodText: string | null): string | null {
  if (!places.length || moodText == null || typeof moodText !== "string") return null;
  const text = String(moodText).toLowerCase();
  const isFeatureOnly = FEATURE_QUALIFIERS.some((fq) => text.includes(fq));
  const detectedSubjective = isFeatureOnly
    ? null
    : Object.keys(subjectiveQualifiers)
        .sort((a, b) => b.length - a.length)
        .find((q) => {
          const regex = new RegExp(`\\b${q.replace(/-/g, "\\-")}\\b`, "i");
          return regex.test(text);
        }) ?? null;
  if (!detectedSubjective) return null;
  const { sortBy, label } = subjectiveQualifiers[detectedSubjective];

  const stopWords = ["best", "top", "popular", "famous", "good", "great", "nice", "cheap", "budget", "fancy", "the", "in", "for", "and", "with", "a", "my", "me", "near", "nearby", "barcelona", "bcn", "underrated", "authentic", "local", "trendy", "affordable", "upscale", "hidden", "gem"];
  const contentKeywords = text.split(/\s+/).filter((w) => w.length > 2 && !stopWords.includes(w));

  places.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aRelevance = contentKeywords.some((kw) => aName.includes(kw)) ? 1000 : 0;
    const bRelevance = contentKeywords.some((kw) => bName.includes(kw)) ? 1000 : 0;

    let aSort = 0;
    let bSort = 0;
    switch (sortBy) {
      case "rating_weighted":
        aSort = (a.rating ?? 0) * Math.log10(Math.max(a.userRatingCount ?? 1, 1));
        bSort = (b.rating ?? 0) * Math.log10(Math.max(b.userRatingCount ?? 1, 1));
        break;
      case "review_count":
        aSort = a.userRatingCount ?? 0;
        bSort = b.userRatingCount ?? 0;
        break;
      case "hidden_gem":
        aSort = (a.rating ?? 0) / Math.log10(Math.max(a.userRatingCount ?? 10, 10));
        bSort = (b.rating ?? 0) / Math.log10(Math.max(b.userRatingCount ?? 10, 10));
        break;
      case "price_asc":
        aSort = -(a.priceLevel ?? 2);
        bSort = -(b.priceLevel ?? 2);
        break;
      case "price_desc":
        aSort = a.priceLevel ?? 2;
        bSort = b.priceLevel ?? 2;
        break;
      default:
        break;
    }

    return bRelevance + bSort - (aRelevance + aSort);
  });

  console.log(`[sort] Two-tier sort applied. Top 3:`, places.slice(0, 3).map((p) => p.name));

  const contentWord = contentKeywords[0] ?? "";
  const sortLabel = contentWord
    ? `BEST ${contentWord.toUpperCase()} · ${label.toUpperCase()}`
    : `PLACES · ${label.toUpperCase()}`;
  return sortLabel;
}

const QUALIFIER_PATTERNS =
  /laptop|wifi|wi-fi|quiet|pet.?friendly|dog.?friendly|vegan|gluten.?free|halal|outdoor|terrace|rooftop|cozy|cosy|open late|late.?night|with a view|kid.?friendly|wheelchair|workspace|working|study|work.?friendly|study spot|place to work|coworking/i;

/** Normalize synonym qualifiers to the canonical form used in verification (e.g. work-friendly → laptop-friendly). */
function normalizeQualifier(qualifier: string | null): string | null {
  if (!qualifier) return null;
  const q = qualifier.toLowerCase().replace(/\s+/g, " ");
  if (/work.?friendly|study spot|place to work|coworking/.test(q)) return "laptop-friendly";
  return qualifier;
}

/** True only when the verification reason shows negative language DIRECTLY tied to the qualifier (e.g. "no laptops", "pets not allowed"). Generic reasons or no-evidence → false so the place stays as unverified. */
function isNegativeEvidenceForQualifier(reason: string | null | undefined, qualifier: string | null): boolean {
  if (!reason || typeof reason !== "string" || !qualifier) return false;
  const r = reason.trim();
  if (!r) return false;
  if (/no\s+mention|not\s+mentioned|insufficient|no\s+evidence|no\s+reviews|couldn't\s+verify|unknown|no\s+data/i.test(r)) return false;
  const base = qualifier.toLowerCase().replace(/-friendly$/i, "").replace(/-/g, " ").trim();
  const words = base.split(/\s+/).filter(Boolean);
  const terms = words.flatMap((w) => [w, w + "s"]);
  const qualifierTerms = Array.from(new Set(terms)).map((t) => escapeRegex(t)).join("|");
  if (!qualifierTerms) return false;
  const negativePattern = new RegExp(
    `\\b(no|not|don'?t|forbid|restrict|ban|prohibit)\\w*\\s+(\\w+\\s+){0,2}(${qualifierTerms})\\b|\\b(${qualifierTerms})\\s+(\\w+\\s+){0,2}(forbidden|restricted|banned|prohibited|not\\s+allowed)\\b`,
    "i"
  );
  return negativePattern.test(r);
}

/** Extract a short descriptive label from web snippets for verification (e.g. "KNOWN FOR MATCHA LATTES"). Returns null if too vague. */
async function extractWebVerificationLabel(placeName: string, qualifier: string, snippets: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 40,
        messages: [
          {
            role: "system",
            content:
              "You extract one short descriptive finding from web search snippets. Return ONLY 3-8 words in UPPERCASE, no period. Examples: KNOWN FOR MATCHA LATTES, LISTED AS PET-FRIENDLY CAFE, HAS OUTDOOR SEATING, MENTIONED FOR WIFI AND PLUGS. If the snippets do not support a specific claim, return the single word: VAGUE",
          },
          {
            role: "user",
            content: `Place: ${placeName}. User searched for: ${qualifier}. Web snippets:\n${snippets.slice(0, 800)}\n\nOne short descriptive finding in UPPERCASE (or VAGUE if nothing specific).`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim()?.toUpperCase() ?? "";
    if (!text || text === "VAGUE" || text.length < 3) return null;
    return text.slice(0, 60);
  } catch {
    return null;
  }
}

/** SerpAPI response shape we use and cache. */
type SerpApiOrganicResult = { title?: string; snippet?: string };
type SerpApiCachedShape = { organic_results?: SerpApiOrganicResult[] };

/** Call SerpAPI for a single query. Used when cache misses. */
async function fetchSerpApiResults(query: string): Promise<SerpApiCachedShape> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return { organic_results: [] };
  const serpUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${apiKey}&num=3&gl=es&hl=en`;
  const res = await fetch(serpUrl);
  const data = (await res.json()) as SerpApiCachedShape;
  return { organic_results: data.organic_results ?? [] };
}

const WEB_SEARCH_CACHE_TTL_DAYS = 7;
const WEB_SEARCH_CACHE_TTL_MS = WEB_SEARCH_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Fetch web search results with Supabase cache. Cache key: placeName::query. TTL 7 days. */
async function cachedWebSearch(query: string, placeName: string): Promise<SerpApiCachedShape> {
  const queryKey = `${(placeName ?? "").toLowerCase().trim()}::${(query ?? "").toLowerCase().trim()}`;

  if (supabase) {
    const { data: cached } = await supabase
      .from("web_search_cache")
      .select("results, created_at")
      .eq("query_key", queryKey)
      .maybeSingle();

    if (cached?.results != null) {
      const createdAt = cached.created_at ? new Date(cached.created_at).getTime() : 0;
      if (Date.now() - createdAt < WEB_SEARCH_CACHE_TTL_MS) {
        console.log(`[web-cache] HIT: ${queryKey}`);
        return cached.results as SerpApiCachedShape;
      }
      await supabase.from("web_search_cache").delete().eq("query_key", queryKey);
    }
  }

  console.log(`[web-cache] MISS: ${queryKey}`);
  const results = await fetchSerpApiResults(query);

  if (supabase) {
    supabase
      .from("web_search_cache")
      .upsert(
        { query_key: queryKey, results, created_at: new Date().toISOString() },
        { onConflict: "query_key" }
      )
      .then(() => console.log(`[web-cache] STORED: ${queryKey}`))
      .catch((err) => console.error("[web-cache] Store error:", err));
  }

  return results;
}

type VerificationMethod = "places_data" | "web_search" | "unverified";

/** For laptop/work/study qualifier searches, exclude venue types that are not sit-down establishments. */
const LAPTOP_INCOMPATIBLE_TYPES = [
  "news_stand",
  "kiosk",
  "food_stand",
  "ice_cream_shop",
  "fast_food_restaurant",
  "convenience_store",
  "grocery_store",
];

function isLaptopWorkStudyQualifier(qualifier: string | null): boolean {
  if (!qualifier) return false;
  const q = qualifier.toLowerCase();
  return q === "laptop-friendly" || /work|study|laptop/.test(q);
}

/** True if place should be excluded from laptop/work/study results (not a sit-down venue). */
function isLaptopIncompatiblePlace(place: PlaceOptionResult): boolean {
  const typeL = (place.primary_type ?? "").toLowerCase();
  const nameL = (place.name ?? "").toLowerCase();
  if (/stand|kiosk|quiosc/.test(nameL)) return true;
  if (LAPTOP_INCOMPATIBLE_TYPES.some((t) => typeL.includes(t))) return true;
  if (typeL.includes("bakery") && !nameL.includes("cafe")) return true;
  return false;
}

/** For specific qualifier searches: only include unverified place in "also nearby" if it has some relevance (name/type/keyword). */
function hasRelevanceSignal(place: PlaceOptionResult, qualifierSearched: string | null, moodText: string | null): boolean {
  if (!qualifierSearched) return true;
  const q = qualifierSearched.toLowerCase().replace(/-/g, " ");
  const nameL = (place.name ?? "").toLowerCase();
  const typeL = (place.primary_type ?? "").toLowerCase();
  const descL = ((place.description ?? "") + " " + (place.editorial ?? "")).toLowerCase();
  const contentKeywords = (moodText ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SPECIFIC_STOP_WORDS.includes(w));
  if (nameL.includes(q) || q.split(/\s+/).some((w) => w.length > 2 && nameL.includes(w))) return true;
  if (["cafe", "restaurant", "bar", "bakery", "bookshop"].some((t) => typeL.includes(t) && q.includes(t))) return true;
  if (descL.includes(q) || contentKeywords.some((kw) => descL.includes(kw))) return true;
  return false;
}

async function runQualifierVerification(
  places: PlaceOptionResult[],
  moodText: string | null
): Promise<{
  places: PlaceOptionResult[];
  verification_method: VerificationMethod;
  fallbackMessage: string | null;
  qualifierSearched: string | null;
  verificationSummary: string | null;
  usedTierCWebSearch: boolean;
}> {
  let tierCWebSearchRan = false;
  const rawQualifier = moodText != null && typeof moodText === "string"
    ? String(moodText).toLowerCase().match(QUALIFIER_PATTERNS)?.[0] ?? null
    : null;
  const detectedQualifier = normalizeQualifier(rawQualifier);

  if (!detectedQualifier || !places.length) {
    return {
      places,
      verification_method: "places_data",
      fallbackMessage: null,
      qualifierSearched: null,
      verificationSummary: null,
      usedTierCWebSearch: false,
    };
  }

  if (isLaptopWorkStudyQualifier(detectedQualifier)) {
    const filtered = places.filter((p) => !isLaptopIncompatiblePlace(p));
    if (filtered.length < places.length) {
      console.log(`[verify] Filtered ${places.length - filtered.length} laptop-incompatible venues (stands, kiosks, etc.)`);
      places.length = 0;
      places.push(...filtered);
    }
  }

  // Tier B: LLM-based semantic verification (replaces keyword matching — catches "dog lover" → pet-friendly etc.)
  const apiKey = process.env.OPENAI_API_KEY;
  if (detectedQualifier && places.length > 0 && apiKey) {
    const placeTexts = places.slice(0, 10).map((p) => {
      const reviewTexts = (p.reviews ?? [])
        .map((r: { text?: { text?: string } }) => r.text?.text ?? "")
        .filter(Boolean)
        .join(" | ");
      return {
        name: p.name,
        editorial: (p.editorial ?? "").substring(0, 300),
        reviews: reviewTexts.substring(0, 500),
        types: p.primary_type ?? "",
      };
    });
    const prompt = `The user wants "${detectedQualifier}" places. For each place below, assess if it likely matches based on the editorial summary, review text, and place type. Consider semantic meaning — e.g. "dog lover" or "bring your dog" means pet-friendly, "spacious tables" or "wifi" suggests laptop-friendly, "terrace" or "outdoor seating" suggests outdoor-friendly.

LAPTOP/WORK-FRIENDLY — PHYSICAL SUITABILITY: For laptop-friendly or work-friendly searches, even if a source lists this place, verify it is a sit-down establishment with tables and seating. News stands, kiosks, food stands, and takeaway-only spots should be marked matches: false with reason: "NOT A SIT-DOWN VENUE". A place needs tables and indoor or covered seating to qualify as laptop-friendly.

NEGATIVE EVIDENCE — BE SPECIFIC: Only flag as negative (matches: false) when the qualifier keyword appears DIRECTLY next to restrictive language. Look ONLY for phrases where the qualifier is tied to the restriction. Examples of negative patterns to catch:
- "no [qualifier]" (no laptops, no pets, no dogs)
- "[qualifier] not allowed/permitted"
- "forbid [qualifier]" / "[qualifier] forbidden"
- "restrict [qualifier]" / "[qualifier] restricted"
- "ban [qualifier]" / "[qualifier] banned"
- "prohibit [qualifier]" / "[qualifier] prohibited"
- "don't allow [qualifier]"
A review that says "the service was not great" is NOT negative evidence for "pet-friendly". Only flag as negative if the restriction words are directly about the searched feature. When you set matches: false due to such negative evidence, set reason to a short uppercase phrase like "RESTRICTS LAPTOPS" or "NO PETS ALLOWED". If there is no evidence either way, set matches: false and reason to e.g. "no mention in reviews".

Places:
${placeTexts.map((p, i) => `${i}. ${p.name} | Type: ${p.types} | Editorial: ${p.editorial} | Reviews: ${p.reviews}`).join("\n\n")}

Return JSON only: {"results": [{"index": 0, "matches": true, "reason": "short reason in 3-8 words, uppercase"}, ...]} Use index 0-based.`;

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 500,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You assess whether places match a user's requirement based on available data. Return JSON only. For laptop-friendly or work-friendly: only verify places that are sit-down establishments with tables and seating; mark news stands, kiosks, food stands, takeaway-only as matches: false, reason: NOT A SIT-DOWN VENUE. Only flag as negative when the qualifier keyword appears directly next to restrictive language (e.g. no laptops, no pets allowed). Do not treat general negative sentiment as negative evidence for the qualifier.",
            },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content ?? "{}";
        const verification = JSON.parse(content) as { results?: Array<{ index: number; matches: boolean; reason?: string }> };
        for (const result of verification.results ?? []) {
          if (result.index >= 0 && result.index < places.length) {
            const p = places[result.index];
            p.qualifierVerified = result.matches;
            p.qualifierReason = result.reason ?? null;
            p.qualifierSource = result.matches ? "ai_review" : null;
          }
        }
        const beforeExclude = places.length;
        const kept = places.filter((p) => p.qualifierVerified || !isNegativeEvidenceForQualifier(p.qualifierReason, detectedQualifier));
        if (kept.length < beforeExclude) {
          console.log("[verify] Excluded", beforeExclude - kept.length, "places due to negative evidence (restricts/forbids qualifier)");
          places.length = 0;
          places.push(...kept);
        }
        console.log(
          "[verify] LLM verification:",
          (verification.results ?? []).map((r: { index: number; matches: boolean; reason?: string }) => `${r.index}: ${r.matches} (${r.reason})`)
        );
      } else {
        console.log("[verify] LLM verification request failed:", res.status);
      }
    } catch (e) {
      console.log("[verify] LLM verification failed:", e);
    }
  }
  if (detectedQualifier) {
    places.sort((a, b) => {
      if (a.qualifierVerified && !b.qualifierVerified) return -1;
      if (!a.qualifierVerified && b.qualifierVerified) return 1;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
  }
  let verifiedCount = places.filter((p) => p.qualifierVerified).length;
  console.log(`[verify] Tier B: ${verifiedCount}/${places.length} verified for "${detectedQualifier}"`);

  if (verifiedCount >= 2) {
    const editorialVerified = places.filter((p) => p.qualifierSource === "editorial").length;
    const reviewVerified = places.filter((p) => p.qualifierSource === "review").length;
    const webVerified = places.filter((p) => p.qualifierSource === "web").length;
    const aiVerified = places.filter((p) => p.qualifierSource === "ai_review").length;
    const parts: string[] = [];
    if (editorialVerified > 0) parts.push(`${editorialVerified} confirmed in editorial`);
    if (reviewVerified > 0) parts.push(`${reviewVerified} confirmed in reviews`);
    if (webVerified > 0) parts.push(`${webVerified} confirmed via web`);
    if (aiVerified > 0) parts.push(`${aiVerified} confirmed from reviews (AI)`);
    const verificationSummary = parts.length > 0 ? parts.join(" · ").toUpperCase() : null;
    return {
      places,
      verification_method: "places_data",
      fallbackMessage: null,
      qualifierSearched: detectedQualifier,
      verificationSummary,
      usedTierCWebSearch: false,
    };
  }

  // Tier C: Web search for unverified places (up to 5) — SerpAPI
  if (detectedQualifier && verifiedCount < 2) {
    console.log(`[verify] Tier C — SerpAPI web search for "${detectedQualifier}"`);

    if (process.env.SERPAPI_KEY) {
      tierCWebSearchRan = true;
      const unverifiedPlaces = places.filter((p) => !p.qualifierVerified).slice(0, 5);

      for (const place of unverifiedPlaces) {
        try {
          const searchQuery = `${place.name} Barcelona ${detectedQualifier}`;
          const serpData = await cachedWebSearch(searchQuery, place.name ?? "");

          const snippets = (serpData.organic_results ?? [])
            .map((r) => `${r.title ?? ""} ${r.snippet ?? ""}`.toLowerCase())
            .join(" ");

          if (
            snippets.includes(detectedQualifier) ||
            snippets.includes(detectedQualifier.replace(/-/g, " "))
          ) {
            place.qualifierVerified = true;
            place.qualifierSource = "web";
            const descriptiveReason = await extractWebVerificationLabel(place.name, detectedQualifier, snippets);
            place.qualifierReason = descriptiveReason || "MENTIONED IN WEB RESULTS";
            console.log(`[verify] Tier C: "${place.name}" verified via SerpAPI — ${place.qualifierReason}`);
          }
        } catch (err) {
          console.log(`[verify] Tier C failed for "${place.name}":`, err);
        }
      }

      // Re-sort verified first
      places.sort((a, b) => (b.qualifierVerified ? 1 : 0) - (a.qualifierVerified ? 1 : 0));
      verifiedCount = places.filter((p) => p.qualifierVerified).length;
    } else {
      console.log("[verify] Tier C skipped — SERPAPI_KEY not set");
    }
  }

  // Tier A: Honest fallback message only when ZERO places were verified (avoid contradicting card badges)
  let fallbackMessage: string | null = null;
  if (verifiedCount === 0) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            max_tokens: 40,
            messages: [
              {
                role: "system",
                content: "You write short, honest one-sentence messages for a walking navigation app. Never use emojis. Be warm but direct.",
              },
              {
                role: "user",
                content: `User searched for "${moodText}". We found ${places.length} places nearby but couldn't verify "${detectedQualifier}" from reviews or web results. Write one short sentence explaining this (under 15 words).`,
              },
            ],
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          fallbackMessage = data.choices?.[0]?.message?.content?.trim() ?? null;
        }
      } catch {
        // keep null
      }
    }
    if (!fallbackMessage) {
      fallbackMessage = `We found places nearby but couldn't confirm they're ${detectedQualifier}.`;
    }
  }

  const verification_method: VerificationMethod =
    verifiedCount >= 2
      ? places.some((p) => p.qualifierSource === "web")
        ? "web_search"
        : "places_data"
      : "unverified";

  if (detectedQualifier) {
    places.sort((a, b) => {
      if (a.qualifierVerified && !b.qualifierVerified) return -1;
      if (!a.qualifierVerified && b.qualifierVerified) return 1;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
  }

  let verificationSummary: string | null = null;
  if (detectedQualifier && verifiedCount > 0) {
    const editorialVerified = places.filter((p) => p.qualifierSource === "editorial").length;
    const reviewVerified = places.filter((p) => p.qualifierSource === "review").length;
    const webVerified = places.filter((p) => p.qualifierSource === "web").length;
    const aiVerified = places.filter((p) => p.qualifierSource === "ai_review").length;
    const parts: string[] = [];
    if (editorialVerified > 0) parts.push(`${editorialVerified} confirmed in editorial`);
    if (reviewVerified > 0) parts.push(`${reviewVerified} confirmed in reviews`);
    if (webVerified > 0) parts.push(`${webVerified} confirmed via web`);
    if (aiVerified > 0) parts.push(`${aiVerified} confirmed from reviews (AI)`);
    verificationSummary = parts.length > 0 ? parts.join(" · ").toUpperCase() : null;
  }

  return {
    places,
    verification_method,
    fallbackMessage,
    qualifierSearched: detectedQualifier,
    verificationSummary,
    usedTierCWebSearch: !!tierCWebSearchRan,
  };
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

/** Build alternative Google Places queries for refresh/load-more so we don't re-run the same query. Uses poi_search_terms (synonyms) and avoids repeating the initial query. */
function buildRefreshQueries(poi_search_terms: string[], initialPoiQuery: string | null): string[] {
  const initial = (initialPoiQuery ?? "").toLowerCase().trim();
  const terms = Array.from(new Set((poi_search_terms ?? []).filter((t) => typeof t === "string" && t.trim().length > 1).map((t) => t.trim().toLowerCase())));
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (q: string) => {
    const key = q.toLowerCase().trim();
    if (key && key !== initial && !seen.has(key)) {
      seen.add(key);
      queries.push(`${q} Barcelona`);
    }
  };
  for (const term of terms) {
    add(term);
    add(`specialty ${term}`);
    add(`${term} shop`);
    add(`${term} cafe`);
    add(`${term} dessert`);
  }
  if (terms.length > 0) {
    const first = terms[0];
    if (/matcha|tea|green tea/i.test(first)) {
      add("Japanese tea");
      add("green tea latte");
    }
    if (/ramen|noodle/i.test(first)) add("Japanese noodle");
    if (/sourdough|bakery|bread/i.test(first)) add("artisan bakery");
  }
  return queries.slice(0, 8);
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
- reason (6-10 words explaining the fit)

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

  let res: Response;
  try {
    const fieldMask =
      "places.id,places.displayName,places.formattedAddress,places.location,places.photos,places.rating,places.editorialSummary,places.primaryType,places.reviewSummary,places.reviews,places.userRatingCount,places.priceLevel";
    console.log("[places] Requesting fields:", fieldMask);
    res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
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
  } catch (e) {
    console.error("[searchPlace] fetch failed:", query, e);
    return [];
  }

  if (!res.ok) {
    const errBody = await res.text();
    console.log("[places] searchText FAILED:", res.status, errBody);
    return [];
  }
  const data = (await res.json()) as {
    places?: Array<{
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
      rating?: number | null;
      editorialSummary?: { text?: string } | null;
      photos?: Array<{ name?: string }>;
      primaryType?: string;
      reviewSummary?: { text?: string } | null;
      userRatingCount?: number | null;
      priceLevel?: number | null;
    }>;
  };
  console.log("[places] searchText query:", query, "found:", (data.places ?? []).length, "results");
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
    const reviews = (place as { reviews?: Array<{ text?: { text?: string }; originalText?: { text?: string } }> }).reviews;
    const firstReviewText = reviews?.[0]?.text?.text ?? reviews?.[0]?.originalText?.text ?? null;
    console.log("[places] Place:", place.displayName?.text, "| editorial:", editorialText?.substring(0, 50), "| review:", reviewText?.substring(0, 50), "| type:", place.primaryType);
    console.log("[places] Review data for", place.displayName?.text ?? "", ":", {
      editorial: editorialText?.substring(0, 50),
      reviewCount: reviews?.length ?? 0,
      firstReview: firstReviewText?.substring(0, 80),
    });
    // Extract keywords from individual reviews for objective-fit evaluation
    const reviewKeywords = reviews
      ?.slice(0, 5)
      .map((r) => r.text?.text ?? (r as { originalText?: { text?: string } }).originalText?.text ?? "")
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
    const rawReviews = reviews?.map((r) => ({ text: { text: r.text?.text ?? (r as { originalText?: { text?: string } }).originalText?.text ?? "" } }));
    const rawUserRatingCount = (place as { userRatingCount?: number }).userRatingCount;
    const userRatingCount = typeof rawUserRatingCount === "number" && Number.isFinite(rawUserRatingCount) ? rawUserRatingCount : null;
    const rawPriceLevel = (place as { priceLevel?: string | number }).priceLevel;
    const priceLevel = typeof rawPriceLevel === "number" && Number.isFinite(rawPriceLevel) ? rawPriceLevel : typeof rawPriceLevel === "string" ? (PRICE_LEVEL_TO_NUMBER[rawPriceLevel] ?? null) : null;
    out.push({
      name,
      place_id: (place as { id?: string }).id ?? null,
      description,
      lat,
      lng,
      rating,
      summary: editorialText ?? reviewText,
      photo_url,
      primary_type: primaryType ?? null,
      review_snippet: reviewText || reviewKeywords || null,
      address: place.formattedAddress?.trim() ?? null,
      editorial: editorialText ?? null,
      reviews: rawReviews ?? undefined,
      userRatingCount: userRatingCount ?? null,
      priceLevel: priceLevel ?? null,
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

/** Legacy Places Text Search — more forgiving of typos and partial names. Used as fallback for destination resolution. */
async function textSearchPlaceLegacy(
  query: string,
  nearLat: number,
  nearLng: number,
  maxResults: number = 5
): Promise<PlaceOptionResult[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return [];
  const radius = 15000;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=${nearLat},${nearLng}&radius=${radius}&key=${apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      status: string;
      results?: Array<{
        name?: string;
        formatted_address?: string;
        geometry?: { location?: { lat?: number; lng?: number } };
        rating?: number;
        photos?: Array<{ photo_reference?: string }>;
        types?: string[];
      }>;
    };
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return [];
    const results = data.results ?? [];
    const out: PlaceOptionResult[] = [];
    for (const r of results.slice(0, maxResults)) {
      const lat = r.geometry?.location?.lat;
      const lng = r.geometry?.location?.lng;
      if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) continue;
      const latN = Number(lat);
      const lngN = Number(lng);
      if (!isInBarcelonaForValidation(latN, lngN)) continue;
      const name = r.name?.trim() ?? "";
      if (!name) continue;
      const primaryType = r.types?.[0] ?? null;
      // Legacy API photo would require server-side proxy to avoid exposing key; omit for now
      out.push({
        name,
        description: r.formatted_address?.trim() ?? placeTypeToLabel(primaryType ?? undefined),
        lat: latN,
        lng: lngN,
        rating: typeof r.rating === "number" && Number.isFinite(r.rating) ? r.rating : null,
        summary: null,
        photo_url: null,
        primary_type: primaryType ?? null,
        address: r.formatted_address?.trim() ?? null,
      });
    }
    return out;
  } catch (e) {
    console.warn("[places] Legacy text search failed:", e);
    return [];
  }
}

/** Resolve destination for mood_and_destination / destination_only: try exact, then +barcelona, then legacy text search. */
async function resolveDestination(
  query: string,
  originLat: number,
  originLng: number
): Promise<PlaceOptionResult[]> {
  let results = await searchPlace(query, originLat, originLng, 5, 5000);
  if (results.length > 0) return results;
  results = await searchPlace(`${query} barcelona`, originLat, originLng, 5, 8000);
  if (results.length > 0) return results;
  results = await textSearchPlaceLegacy(`${query} barcelona`, originLat, originLng, 5);
  return results;
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

/** One batch LLM call to generate 8-12 word descriptions for place cards. Length is tuned to fill exactly 2 lines at mobile width. Optional searchQuery tailors descriptions to what the user is looking for. */
async function generatePlaceDescriptions(
  places: { name: string; primaryType?: string }[],
  searchQuery?: string | null
): Promise<string[]> {
  if (places.length === 0) return [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return places.map(() => "");
  const list = places.map((p, i) => `${i + 1}. ${p.name}${p.primaryType ? ` (${p.primaryType})` : ""}`).join("\n");
  const contextInstruction = searchQuery?.trim()
    ? `The user searched for: "${searchQuery.trim()}". For each place, write a description that is exactly 8-12 words long, relevant to what they're looking for. You may infer likely features ONLY from the place NAME and TYPE. NEVER invent specific amenities unless the name strongly implies them. If the natural description is too short, add a relevant detail (neighborhood, specialty, atmosphere).`
    : `Generate a description that is exactly 8-12 words long. Always fill 2 full lines of text at mobile width. If the natural description is too short, add a relevant detail (neighborhood, specialty, atmosphere). Base descriptions ONLY on the place name and type. Never invent amenities or features.`;
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

Examples:
- "Matcha-focused coffee shop with a minimalist Japanese-inspired vibe"
- "Cozy tea house specializing in ceremonial-grade matcha and desserts"
- "Specialty coffee and matcha bar in the heart of Eixample"

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

/** One batch LLM call: returns 6-10 word descriptions for each POI. If it fails, return empty so we show name only. */
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
          content: `You will receive a list of place names and their Google Maps type. For each, return a JSON array of 6-10 word descriptions. Be specific and factual. No generic words like 'experience', 'discover', 'explore', 'authentic', 'hidden gem', 'must-visit'. Keep each description under 60 characters. Every description must be a complete phrase — never cut off mid-sentence. If you can't fit the full thought in 60 characters, write a shorter one instead. Examples: "Gaudí's mosaic apartment", "outdoor market, fresh produce", "Gothic cloister", "third-wave coffee". Reply with ONLY a valid JSON array of strings, one string per place, in the same order.`,
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

/** Generate route description tags that reflect the user's intent and original request. Returns 3 tags or empty on failure. */
async function generateRouteDescriptionTags(
  intent: Intent,
  moodText: string,
  fallbackTags: string[]
): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallbackTags;

  const systemPrompt = `You return exactly 3 short route description tags (2-4 words each) for a walking route in Barcelona. Return ONLY a JSON array of 3 strings, no other text.

The user's intent is: ${intent}
Their original request was: "${(moodText || "").trim().slice(0, 200)}"

Use mood-adapted language — pick phrases that match the intent:
- calm: prefer "quiet streets", "tree-lined paths", "low traffic", "peaceful neighborhoods", "away from crowds"
- nature: prefer "green corridors", "park paths", "tree-lined streets", "near water"
- scenic: prefer "beautiful architecture", "charming streets", "historic quarters"
- lively: prefer "buzzing streets", "lively neighborhoods", "busy cafes and shops"
- discover: use curiosity words — "hidden corners", "unexpected finds", "local secrets"
- exercise: use active words — "uphill climb", "wide boulevards", "brisk pace"
- cafe: use inviting words — "cozy cafés", "terrace stops", "neighborhood spots"
- quick: use efficiency words — "direct path", "main streets", "fast route"

Reply with ONLY a valid JSON array of exactly 3 strings, e.g. ["quiet streets", "tree-lined paths", "away from crowds"].`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 120,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Return 3 route tags as a JSON array of strings." },
        ],
      }),
    });
    if (!res.ok) return fallbackTags;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(text) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [];
    const tags = arr.filter((t): t is string => typeof t === "string").slice(0, 3);
    return tags.length >= 3 ? tags : fallbackTags;
  } catch {
    return fallbackTags;
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
/** Walking speed for duration→distance (loop/surprise): 80 m/min → 25 min ≈ 2 km round trip. */
const ROUTE_DISTANCE_M_PER_MIN = 80;
/** For mood_only loop: target distance in km (0.75 shrink for street routing vs straight line). */
const WALK_SPEED_KM_PER_MIN = ROUTE_DISTANCE_M_PER_MIN / 1000;
const BCN_BBOX = { minLat: 41.32, maxLat: 41.47, minLng: 2.05, maxLng: 2.23 };
/** Bounds for random waypoint (surprise/get lost): keep within central Barcelona. */
const BCN_BBOX_RANDOM = { minLat: 41.35, maxLat: 41.45, minLng: 2.1, maxLng: 2.23 };

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
/** Routes over these limits are never returned to the frontend. */
const FRONTEND_MAX_DURATION_MIN = 120;
const FRONTEND_MAX_DISTANCE_M = 15000;
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

/** Bearing in degrees 0–360 from (lat1,lng1) to (lat2,lng2). */
function getBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  let bearing = (Math.atan2(y, x) * 180) / Math.PI;
  if (bearing < 0) bearing += 360;
  return bearing;
}

function bearingToCompass(bearingDeg: number): string {
  const sectors = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  const idx = Math.round(((bearingDeg % 360) / 45)) % 8;
  return sectors[idx] ?? "north";
}

/** Rough neighborhood name for a point in Barcelona (for vibe descriptions). */
function getNeighborhoodForCoords(lat: number, lng: number): string {
  const displayNames: Record<string, string> = {
    eixample: "Eixample",
    gràcia: "Gràcia",
    gracia: "Gràcia",
    barceloneta: "Barceloneta",
    waterfront: "waterfront",
    "barri gotic": "Barri Gòtic",
    gothic: "Barri Gòtic",
    raval: "El Raval",
    montjuic: "Montjuïc",
    montjuïc: "Montjuïc",
    tibidabo: "Tibidabo",
    collserola: "Collserola",
  };
  for (const [key, bbox] of Object.entries(AREA_BBOXES)) {
    if (lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng) {
      return displayNames[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
    }
  }
  return "Barcelona";
}

/** Bounding boxes for route-based neighborhood lookup (description grounding). Order: more specific areas first. */
const ROUTE_NEIGHBORHOOD_BBOXES: { name: string; minLat: number; maxLat: number; minLng: number; maxLng: number }[] = [
  { name: "Ciutadella", minLat: 41.385, maxLat: 41.392, minLng: 2.183, maxLng: 2.192 },
  { name: "Sagrada Família", minLat: 41.4, maxLat: 41.408, minLng: 2.168, maxLng: 2.178 },
  { name: "Sant Pere", minLat: 41.385, maxLat: 41.39, minLng: 2.174, maxLng: 2.182 },
  { name: "Gothic Quarter", minLat: 41.379, maxLat: 41.385, minLng: 2.173, maxLng: 2.18 },
  { name: "El Born", minLat: 41.383, maxLat: 41.388, minLng: 2.18, maxLng: 2.186 },
  { name: "Raval", minLat: 41.375, maxLat: 41.385, minLng: 2.165, maxLng: 2.173 },
  { name: "Barceloneta", minLat: 41.375, maxLat: 41.382, minLng: 2.186, maxLng: 2.198 },
  { name: "Poble Sec", minLat: 41.37, maxLat: 41.378, minLng: 2.155, maxLng: 2.172 },
  { name: "Poblenou", minLat: 41.39, maxLat: 41.405, minLng: 2.192, maxLng: 2.21 },
  { name: "Gràcia", minLat: 41.4, maxLat: 41.41, minLng: 2.148, maxLng: 2.17 },
  { name: "Eixample", minLat: 41.385, maxLat: 41.4, minLng: 2.148, maxLng: 2.18 },
  { name: "Montjuïc", minLat: 41.358, maxLat: 41.375, minLng: 2.148, maxLng: 2.17 },
];

/** Which neighborhood a single point (lat, lng) falls in for route descriptions. Returns "central Barcelona" if no bbox matches. */
function getNeighborhoodAtPoint(lat: number, lng: number): string {
  for (const b of ROUTE_NEIGHBORHOOD_BBOXES) {
    if (lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng) return b.name;
  }
  return "central Barcelona";
}

/** Sample start, midpoint, end of route and return deduped neighborhood names. Coords are [lng, lat][] (GeoJSON). */
function getRouteNeighborhoods(coords: [number, number][]): string[] {
  if (!coords?.length) return [];
  const len = coords.length;
  const start = coords[0];
  const mid = coords[Math.floor(len / 2)];
  const end = coords[len - 1];
  const n1 = getNeighborhoodAtPoint(start[1], start[0]);
  const n2 = getNeighborhoodAtPoint(mid[1], mid[0]);
  const n3 = getNeighborhoodAtPoint(end[1], end[0]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [n1, n2, n3]) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Compass direction of the route (start→end or start→mid for loops). Coords are [lng, lat][]. */
function getRouteCompassDirection(coords: [number, number][]): string | undefined {
  if (!coords?.length || coords.length < 2) return undefined;
  const a = coords[0];
  const b = coords[coords.length - 1];
  const latA = a[1];
  const lngA = a[0];
  let latB = b[1];
  let lngB = b[0];
  if (Math.abs(latA - latB) < 1e-5 && Math.abs(lngA - lngB) < 1e-5) {
    const mid = coords[Math.floor(coords.length / 2)];
    latB = mid[1];
    lngB = mid[0];
  }
  return bearingToCompass(getBearing(latA, lngA, latB, lngB));
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
      exclude_place_ids: bodyExcludePlaceIds,
      forceNightMode: bodyForceNightMode,
      retry_count: retryCount,
    } = body;

    if (!origin || !Array.isArray(origin) || origin.length < 2) {
      return NextResponse.json({ error: "origin required (lat, lng)" }, { status: 400 });
    }

    const originCoords: [number, number] = [Number(origin[0]), Number(origin[1])];
    const isNight =
      bodyForceNightMode === true
        ? true
        : bodyForceNightMode === false
          ? false
          : SIMULATE_NIGHT ||
            (() => {
              const h = new Date(
                new Date().toLocaleString("en-US", { timeZone: "Europe/Madrid" })
              ).getHours();
              return h >= 21 || h < 6;
            })();

    let intent: Intent = "calm";
    let destCoords: [number, number] | null = null;
    let destination_name: string | null = null;
    let destination_address: string | null = null;
    let destination_photo: string | null = null;
    let pattern: RequestPattern = "mood_only";
    let suggestedDuration: number | null = null;
    let maxDurationMinutes: number | null = null;
    let targetDistanceKm: number | null = null;
    let themeName: string | null = null;
    let poi_focus = false;
    let poi_search_terms: string[] = [];
    let skipDuration = false;
    let isLoop = false;
    let isSurprise = false;
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
        isSurprise = parsed.is_surprise === true;
        parsedArea = parsed.area ?? null;
        parsedPoiQuery = parsed.poi_query ?? null;
        parsedThemeName = parsed.theme_name ?? null;

        // ── Post-parse overrides ──────────────────────────────────

        // OVERRIDE A: Place-type keywords → force mood_and_poi
        if (pattern === "mood_only" && moodText) {
          const text = String(moodText).toLowerCase();
          const placeTypeKeywords = [
            "cafe", "cafes", "café", "cafés", "coffee", "coffee shop",
            "restaurant", "restaurants", "bar", "bars", "pub", "pubs",
            "bakery", "bakeries", "bookshop", "bookshops", "bookstore",
            "gym", "pharmacy", "shop", "store", "museum", "gallery",
            "hotel", "hostel", "coworking", "library", "hospital", "clinic",
          ];
          const hasPlaceType = placeTypeKeywords.some(kw => text.includes(kw));
          const hasFunctionalModifier = /laptop|wifi|wi-fi|outdoor|terrace|rooftop|pet.?friendly|dog.?friendly|vegan|gluten|halal|open late|with a view/.test(text);

          if (hasPlaceType || hasFunctionalModifier) {
            console.log(`[route] Post-parse override A: "${text}" → mood_and_poi`);
            pattern = "mood_and_poi" as RequestPattern;
            if (!parsedPoiQuery) {
              const typeMatch = placeTypeKeywords.find(kw => text.includes(kw));
              parsedPoiQuery = typeMatch ? `${typeMatch} Barcelona` : `${text.replace(/['"]/g, '')} Barcelona`;
            }
          }
        }

        // OVERRIDE B: "X near Y" → mood_and_poi near Y
        if (moodText) {
          const text = String(moodText).toLowerCase();
          const nearMatch = text.match(/(\w+(?:\s+\w+)?)\s+near\s+(.+)/i);
          if (nearMatch) {
            const placeTypes = ["cafe", "coffee", "restaurant", "bar", "pharmacy", "bookshop", "gym", "bakery", "shop", "store"];
            const isPlaceType = placeTypes.some(pt => nearMatch[1].toLowerCase().includes(pt));
            if (isPlaceType && pattern !== "mood_and_poi") {
              console.log(`[route] Post-parse override B: "${text}" → mood_and_poi near ${nearMatch[2]}`);
              pattern = "mood_and_poi" as RequestPattern;
              parsedPoiQuery = `${nearMatch[1]} ${nearMatch[2]} Barcelona`;
            }
          }
        }

        // OVERRIDE C: Quick intent without destination → calm
        if (intent === "quick" && !destCoords && pattern === "mood_only") {
          console.log("[route] Post-parse override C: quick without destination → calm");
          intent = "calm";
        }

        // OVERRIDE D: Destination without urgency → scenic (not quick)
        if (pattern === "mood_and_destination" && intent === "quick") {
          const text = String(moodText).toLowerCase();
          const isUrgent = /rush|hurry|late|urgent|fast|emergency|asap|quick/.test(text);
          if (!isUrgent) {
            console.log("[route] Post-parse override D: destination without urgency → scenic");
            intent = "scenic";
          }
        }

        // OVERRIDE F: "fun" maps to lively, not calm
        if (moodText && /\bfun\b/i.test(String(moodText)) && intent === "calm") {
          console.log("[route] Post-parse override F: fun → lively");
          intent = "lively";
        }

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
              let places: PlaceOptionResult[];
              if (isSpecificSearch(parsed.poi_query, typeof moodText === "string" ? moodText : null)) {
                applyKeywordRelevanceSort(combined, typeof moodText === "string" ? moodText : null);
                places = combined.slice(0, 5);
              } else {
                places = combined.sort((a, b) => dist2(a) - dist2(b)).slice(0, 5);
              }
              if (places.length >= 2) {
                const sortLabelViewpoint = applySubjectiveSortAndLabel(places, typeof moodText === "string" ? moodText : null);
                let finalPlaces: PlaceOptionResult[];
                if (sortLabelViewpoint) {
                  console.log("[rerank] Skipped — subjective qualifier sort already applied");
                  finalPlaces = places;
                } else {
                  if (isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null)) {
                    finalPlaces = await rerankByObjectiveFit(places, (typeof moodText === "string" ? moodText : "").trim());
                  } else {
                    finalPlaces = rerankPlacesForLocalCharacter(places);
                  }
                  finalPlaces = applyFinalRelevanceSort(finalPlaces, typeof moodText === "string" ? moodText : null);
                }
                const verification = await runQualifierVerification(finalPlaces, typeof moodText === "string" ? moodText : null);
                let placeOptionsViewpoint = applyKeywordRelevanceSort(verification.places, typeof moodText === "string" ? moodText : null);
                let verificationSummaryViewpoint = verification.verificationSummary;
                const detectedSubjectiveViewpointForFilter = Object.keys(subjectiveQualifiers).find((q) => new RegExp(`\\b${q.replace(/-/g, "\\-")}\\b`, "i").test(String(moodText ?? "").toLowerCase())) ?? null;
                const qualifierIsPrimaryViewpoint = verification.qualifierSearched && !detectedSubjectiveViewpointForFilter;
                if (qualifierIsPrimaryViewpoint) {
                  const verifiedViewpoint = placeOptionsViewpoint.filter((p) => p.qualifierVerified);
                  const unverifiedViewpoint = placeOptionsViewpoint.filter((p) => !p.qualifierVerified);
                  const unverifiedWithSignal = unverifiedViewpoint.filter((p) =>
                    hasRelevanceSignal(p, verification.qualifierSearched ?? null, typeof moodText === "string" ? moodText : null)
                  );
                  if (verifiedViewpoint.length >= 1) {
                    placeOptionsViewpoint = [...verifiedViewpoint, ...unverifiedWithSignal.slice(0, 2)];
                    console.log("[filter] Showing", verifiedViewpoint.length, "verified +", Math.min(unverifiedWithSignal.length, 2), "alternatives (with relevance signal)");
                  }
                }
                const fallbackMessage = null;
                const moodLowerViewpoint = String(moodText ?? "").toLowerCase();
                const contentKeywordsViewpoint = moodLowerViewpoint.split(/\s+/).filter((w) => w.length > 2 && !CONTENT_KEYWORD_STOP_WORDS.includes(w));
                const detectedSubjectiveViewpoint = detectedSubjectiveViewpointForFilter;
                const matchingPlacesViewpoint = contentKeywordsViewpoint.length > 0
                  ? placeOptionsViewpoint.filter((p) => contentKeywordsViewpoint.some((kw) => (p.name ?? "").toLowerCase().includes(kw)))
                  : placeOptionsViewpoint;
                console.log("[summary] Keyword-relevant places in final array (viewpoint):", matchingPlacesViewpoint.map((p) => p.name));
                const summaryViewpoint = await generateSearchSummary({
                  moodText: typeof moodText === "string" ? moodText : "",
                  places: placeOptionsViewpoint,
                  detectedQualifier: verification.qualifierSearched ?? null,
                  detectedSubjective: detectedSubjectiveViewpoint,
                  didBroaden: false,
                  poiSearchRadius: 8000,
                  contentKeywords: contentKeywordsViewpoint,
                });
                const sortLabelViewpointFinal = summaryViewpoint ?? sortLabelViewpoint;
                console.log("[sort] Final sortLabel:", sortLabelViewpointFinal);
                console.log("[route] Response includes sort_label:", sortLabelViewpointFinal, "fallback_message:", fallbackMessage);
                console.log("[response] Building place_options from (same array as map pins):", placeOptionsViewpoint.slice(0, 5).map((p) => p.name));
                console.log("[places] Returning place_options, objective?", isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null), "query:", parsedPoiQuery, "moodText:", typeof moodText === "string" ? moodText.substring(0, 50) : null);
                return NextResponse.json({
                  place_options: placeOptionsViewpoint,
                  needs_place_selection: true,
                  intent,
                  verification_method: verification.verification_method,
                  qualifier_searched: verification.qualifierSearched,
                  detected_qualifier: verification.qualifierSearched ?? null,
                  sort_label: sortLabelViewpointFinal ?? null,
                  fallback_message: fallbackMessage ?? null,
                  verification_summary: verificationSummaryViewpoint ?? null,
                  used_web_search: verification.usedTierCWebSearch,
                });
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
                let places = await resolveDestination(name, originCoords[0], originCoords[1]);
                if (places.length === 0) {
                  const geo = await geocodePlace(name);
                  if (geo) {
                    destCoords = [geo.lat, geo.lng];
                    destination_name = name;
                  } else {
                    return NextResponse.json(
                      { error: "Couldn't find that place — check the spelling or try a more specific name." },
                      { status: 400 }
                    );
                  }
                } else if (places.length === 1) {
                  destCoords = [places[0].lat, places[0].lng];
                  destination_name = places[0].name;
                  destination_address = places[0].address ?? places[0].description ?? null;
                  destination_photo = places[0].photo_url ?? null;
                } else {
                  const optionsForSelection = places.slice(0, 3).map((p) => ({
                    ...p,
                    description: p.address ?? p.description,
                  }));
                  return NextResponse.json({
                    place_options: optionsForSelection,
                    needs_place_selection: true,
                    intent,
                    place_selection_heading: "WHICH ONE?",
                  });
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
              // When user has an area (e.g. "wine bar in Born") but searchCenter is still origin, geocode area and use as center
              if (parsedArea && searchCenter[0] === originCoords[0] && searchCenter[1] === originCoords[1]) {
                const areaFallback = getFallbackCoordsForDestination(parsedArea);
                if (areaFallback) {
                  searchCenter = areaFallback;
                } else {
                  const areaBbox = getAreaBbox(parsedArea);
                  if (areaBbox) {
                    searchCenter = [
                      (areaBbox.minLat + areaBbox.maxLat) / 2,
                      (areaBbox.minLng + areaBbox.maxLng) / 2,
                    ];
                  } else {
                    const geo = await geocodePlace(parsedArea);
                    if (geo) searchCenter = [geo.lat, geo.lng];
                  }
                  console.log(`[route] POI search center shifted to area "${parsedArea}":`, searchCenter);
                }
              }
              // Dynamic search radius: nearby vs qualifier (citywide) vs area vs general
              const text = String(moodText ?? "").toLowerCase();
              const isNearby = /near me|nearby|close|around here|walking distance|closest|nearest/.test(text);
              const detectedQualifier = text.match(QUALIFIER_PATTERNS)?.[0] ?? null;
              let poiSearchRadius: number;
              if (isNearby) {
                poiSearchRadius = 1000; // 1km — explicit "near me"
              } else if (detectedQualifier) {
                poiSearchRadius = 15000; // qualifier search — accuracy over proximity, search all BCN
              } else if (parsedArea) {
                poiSearchRadius = 2000; // 2km — around the named area
              } else {
                poiSearchRadius = 8000; // 8km — general search
              }
              console.log(`[route] POI search radius: ${poiSearchRadius}m (nearby=${isNearby}, qualifier=${!!detectedQualifier}, area=${!!parsedArea})`);

              // For citywide qualifier searches, use Barcelona center so results aren't clustered near user
              const searchLat = detectedQualifier && !isNearby && !parsedArea ? 41.3874 : searchCenter[0];
              const searchLng = detectedQualifier && !isNearby && !parsedArea ? 2.1686 : searchCenter[1];
              if (detectedQualifier && !isNearby && !parsedArea) {
                console.log("[route] Qualifier search: using Barcelona center", searchLat, searchLng);
              }

              // Subjective qualifier detection (run before searchPlace, use moodText). Whole-word match only; exclude feature qualifiers.
              const moodLower = String(moodText ?? "").toLowerCase();
              const isFeatureOnly = FEATURE_QUALIFIERS.some((fq) => moodLower.includes(fq));
              const detectedSubjective = isFeatureOnly
                ? null
                : Object.keys(subjectiveQualifiers)
                    .sort((a, b) => b.length - a.length)
                    .find((q) => {
                      const regex = new RegExp(`\\b${q.replace(/-/g, "\\-")}\\b`, "i");
                      return regex.test(moodLower);
                    }) ?? null;
              let sortLabel: string | null = null;
              console.log("[sort] Checking moodText for subjective qualifier:", moodLower, "detected:", detectedSubjective);

              const hasFeatureQualifier = !!detectedQualifier;
              let poiSearchQuery = parsed.poi_query;
              let maxSearchResults = 10;
              let qualifierBaseType: string | null = null;
              if (hasFeatureQualifier) {
                qualifierBaseType = parsed.poi_query ? PLACE_TYPE_KEYWORDS.find((kw) => parsed.poi_query!.toLowerCase().includes(kw)) ?? null : null;
                if (qualifierBaseType) {
                  poiSearchQuery = `${qualifierBaseType} Barcelona`; // fallback query if full query returns few results
                  console.log("[route] Feature qualifier search: will try full query first, fallback:", poiSearchQuery);
                }
                maxSearchResults = 15;
              }

              console.log("[route] search_offset received:", body.search_offset);
              const searchOffsetNum = typeof searchOffset === "number" && Number.isFinite(searchOffset) && searchOffset > 0 ? searchOffset : 0;
              const excludePlaceIds = Array.isArray(bodyExcludePlaceIds)
                ? new Set((bodyExcludePlaceIds as string[]).filter((id): id is string => typeof id === "string"))
                : new Set<string>();
              if (excludePlaceIds.size > 0) {
                console.log("[route] exclude_place_ids:", excludePlaceIds.size, "IDs (will filter from load-more results)");
              }
              if (searchOffsetNum > 0) {
                const largerRadius = Math.min(poiSearchRadius * 2, 8000);
                const refreshQueries = buildRefreshQueries(poi_search_terms, parsed.poi_query ?? null);
                const existingIds = new Set(excludePlaceIds);
                let morePlaces: PlaceOptionResult[] = [];
                for (const query of refreshQueries.length > 0 ? refreshQueries : [poiSearchQuery]) {
                  const batch = await searchPlace(query, searchLat, searchLng, Math.min(5, maxSearchResults), largerRadius);
                  for (const p of batch) {
                    const id = p.place_id ?? p.name;
                    if (!existingIds.has(id)) {
                      existingIds.add(id);
                      morePlaces.push(p);
                    }
                  }
                }
                console.log("[route] Refresh: alternative queries tried:", refreshQueries.length || 1, "new places:", morePlaces.length);
                if (morePlaces.length === 0) {
                  console.log("[route] Refresh: no new results, returning fallback message");
                  return NextResponse.json({
                    place_options: [],
                    needs_place_selection: true,
                    intent,
                    verification_method: "places_data",
                    qualifier_searched: null,
                    detected_qualifier: null,
                    sort_label: null,
                    fallback_message: "No more results found",
                    verification_summary: null,
                    used_web_search: false,
                  });
                }
                sortLabel = applySubjectiveSortAndLabel(morePlaces, typeof moodText === "string" ? moodText : null);
                if (sortLabel == null && hasFeatureQualifier) {
                  const base = parsed.poi_query ? PLACE_TYPE_KEYWORDS.find((kw) => parsed.poi_query!.toLowerCase().includes(kw)) : undefined;
                  sortLabel = base ? base.toUpperCase() : null;
                }
                let finalPlaces: PlaceOptionResult[];
                if (detectedSubjective) {
                  console.log("[rerank] Skipped — subjective qualifier sort already applied");
                  finalPlaces = morePlaces;
                } else {
                  if (isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null)) {
                    finalPlaces = await rerankByObjectiveFit(morePlaces, (typeof moodText === "string" ? moodText : "").trim());
                  } else {
                    finalPlaces = rerankPlacesForLocalCharacter(morePlaces);
                  }
                  finalPlaces = applyFinalRelevanceSort(finalPlaces, typeof moodText === "string" ? moodText : null);
                }
                const verificationOffset = await runQualifierVerification(finalPlaces, typeof moodText === "string" ? moodText : null);
                let placeOptionsOffset = applyKeywordRelevanceSort(verificationOffset.places, typeof moodText === "string" ? moodText : null);
                const qualifierIsPrimaryOffset = verificationOffset.qualifierSearched && !detectedSubjective;
                if (qualifierIsPrimaryOffset) {
                  const verifiedOffset = placeOptionsOffset.filter((p) => p.qualifierVerified);
                  const unverifiedOffset = placeOptionsOffset.filter((p) => !p.qualifierVerified);
                  const unverifiedWithSignalOffset = unverifiedOffset.filter((p) =>
                    hasRelevanceSignal(p, verificationOffset.qualifierSearched ?? null, typeof moodText === "string" ? moodText : null)
                  );
                  if (verifiedOffset.length >= 1) {
                    placeOptionsOffset = [...verifiedOffset, ...unverifiedWithSignalOffset.slice(0, 2)];
                    console.log("[filter] Showing", verifiedOffset.length, "verified +", Math.min(unverifiedWithSignalOffset.length, 2), "alternatives (with relevance signal)");
                  }
                }
                const fallbackMessage = null;
                return NextResponse.json({
                  place_options: placeOptionsOffset,
                  needs_place_selection: true,
                  intent,
                  verification_method: verificationOffset.verification_method,
                  qualifier_searched: verificationOffset.qualifierSearched,
                  detected_qualifier: verificationOffset.qualifierSearched ?? null,
                  sort_label: null,
                  fallback_message: fallbackMessage ?? null,
                  verification_summary: verificationOffset.verificationSummary ?? null,
                  used_web_search: verificationOffset.usedTierCWebSearch,
                });
              }

              let places: PlaceOptionResult[] = [];
              if (isViewpointQuery) {
                const geoViewpoints = getViewpointPoisFromGeoJson();
                const fromPlaces = await searchPlace(poiSearchQuery, searchLat, searchLng, maxSearchResults, poiSearchRadius);
                console.log("[DEBUG-MERGE] Viewpoint search:", fromPlaces.map((p) => p.name));
                const seen = new Set(geoViewpoints.map((p) => p.name));
                const combined = [...geoViewpoints, ...fromPlaces.filter((p) => !seen.has(p.name))];
                const dist2 = (p: { lat: number; lng: number }) =>
                  (p.lat - searchLat) ** 2 + (p.lng - searchLng) ** 2;
                if (isSpecificSearch(parsed.poi_query, typeof moodText === "string" ? moodText : null)) {
                  applyKeywordRelevanceSort(combined, typeof moodText === "string" ? moodText : null);
                  places = combined.slice(0, maxSearchResults);
                } else {
                  places = combined.sort((a, b) => dist2(a) - dist2(b)).slice(0, maxSearchResults);
                }
              } else if (hasFeatureQualifier && qualifierBaseType && detectedQualifier) {
                // First search: include qualifier so Google can return e.g. pet-friendly places
                const fullQuery = `${detectedQualifier} ${qualifierBaseType} Barcelona`;
                places = await searchPlace(fullQuery, searchLat, searchLng, maxSearchResults, poiSearchRadius);
                console.log("[DEBUG-MERGE] Qualifier full search:", places.map((p) => p.name));
                if (places.length < 3) {
                  const fallbackQuery = `${qualifierBaseType} Barcelona`;
                  const morePlaces = await searchPlace(fallbackQuery, searchLat, searchLng, maxSearchResults, poiSearchRadius);
                  console.log("[DEBUG-MERGE] Qualifier fallback search:", morePlaces.map((p) => p.name));
                  const existingIds = new Set(places.map((p) => p.place_id ?? p.name));
                  const beforeMerge = places.length;
                  places = [...places, ...morePlaces.filter((p) => !existingIds.has(p.place_id ?? p.name))];
                  console.log("[route] Qualifier full query returned", beforeMerge, "; after fallback merge:", places.length);
                } else {
                  console.log("[route] Qualifier full query returned", places.length, "results");
                }
              } else {
                // First search (specific query, e.g. "matcha cafe Barcelona")
                let allPlaces = await searchPlace(poiSearchQuery, searchLat, searchLng, maxSearchResults, poiSearchRadius);
                console.log("[DEBUG-MERGE] Specific search:", allPlaces.map((p) => p.name));

                // Content keywords from mood (e.g. "matcha" from "best matcha in bcn") — for variation queries
                const contentKeywords = moodLower
                  .split(/\s+/)
                  .filter((w) => w.length > 2 && !CONTENT_KEYWORD_STOP_WORDS.includes(w));

                // If specific search found few keyword-matching results, try query variations before generic broadening
                if (contentKeywords.length > 0) {
                  const keywordMatchCount = allPlaces.filter((p) =>
                    contentKeywords.some((kw) => (p.name ?? "").toLowerCase().includes(kw))
                  ).length;
                  if (keywordMatchCount < 5) {
                    const mainKeyword = contentKeywords[0];
                    const variations = [
                      `${mainKeyword} Barcelona`,
                      `${mainKeyword} shop Barcelona`,
                      `${mainKeyword} cafe Barcelona`,
                      `best ${mainKeyword} Barcelona`,
                    ];
                    const existingIds = new Set(allPlaces.map((p) => p.place_id ?? p.name));
                    for (const query of variations) {
                      const moreResults = await searchPlace(query, searchLat, searchLng, 5, 15000);
                      for (const p of moreResults) {
                        const id = p.place_id ?? p.name;
                        if (!existingIds.has(id)) {
                          existingIds.add(id);
                          allPlaces.push(p);
                        }
                      }
                    }
                    console.log(
                      "[places] After variation searches:",
                      allPlaces.filter((p) => contentKeywords.some((kw) => (p.name ?? "").toLowerCase().includes(kw))).map((p) => p.name)
                    );
                  }
                }

                // If still few results, try simplified/generic query (e.g. "cafe Barcelona") — merge with specific first
                if (allPlaces.length < 5) {
                  const simplified = simplifyPoiQueryForFallback(parsed.poi_query);
                  if (simplified && simplified !== parsed.poi_query.trim().toLowerCase()) {
                    const broaderResults = await searchPlace(simplified, searchLat, searchLng, maxSearchResults, Math.min(poiSearchRadius * 2, 10000));
                    console.log("[DEBUG-MERGE] Broader search (simplified):", broaderResults.map((p) => p.name));
                    const existingIds = new Set(allPlaces.map((p) => p.place_id ?? p.name));
                    const newResults = broaderResults.filter((p) => !existingIds.has(p.place_id ?? p.name));
                    allPlaces = [...allPlaces, ...newResults];
                    console.log("[DEBUG-MERGE] Merged (specific first):", allPlaces.map((p) => p.name));
                  }
                }
                if (isSpecificSearch(parsed.poi_query, typeof moodText === "string" ? moodText : null)) {
                  applyKeywordRelevanceSort(allPlaces, typeof moodText === "string" ? moodText : null);
                }
                places = allPlaces.slice(0, maxSearchResults);
              }
              let fallbackMessage: string | null = null;
              let didBroaden = false;
              // Save results from first/specific search so we can prepend them after any broadening
              let originalPlaces: PlaceOptionResult[] = places.length > 0 ? [...places] : [];
              if (places.length < 2 && parsedPoiQuery) {
                const originalQuery = parsedPoiQuery;
                console.log("[places] Original specific results (before retry):", places.map((p) => p.name));
                // Try 1: Same query, wider radius (15km) — sometimes Google Places just needs more space
                console.log(`[route] POI retry with wider radius: "${originalQuery}"`);
                const retryPlaces = await searchPlace(originalQuery, searchLat, searchLng, maxSearchResults, 15000);
                console.log("[DEBUG-MERGE] Retry (wider radius):", retryPlaces.map((p) => p.name));

                if (retryPlaces.length < 2) {
                  // Try 2: Broaden to base type — merge: originals first, then broader (deduped)
                  const placeTypeKeywords = ["cafe", "cafes", "restaurant", "bar", "bakery", "bookshop", "gym", "pharmacy", "museum", "gallery", "library"];
                  const baseType = placeTypeKeywords.find((kw) => originalQuery.toLowerCase().includes(kw));
                  if (baseType) {
                    const broaderQuery = `${baseType} Barcelona`;
                    console.log(`[route] POI broadening: "${originalQuery}" → "${broaderQuery}"`);
                    const broaderResults = await searchPlace(broaderQuery, searchLat, searchLng, maxSearchResults, poiSearchRadius);
                    console.log("[DEBUG-MERGE] Broader search:", broaderResults.map((p) => p.name));
                    const existingIds = new Set(originalPlaces.map((p) => p.place_id ?? p.name));
                    const newFromBroader = broaderResults.filter((p) => !existingIds.has(p.place_id ?? p.name));
                    places = [...originalPlaces, ...newFromBroader];
                    console.log("[DEBUG-MERGE] Merged total (originals first):", places.map((p) => p.name));
                    didBroaden = true;
                    if (places.length > 0) {
                      const apiKey = process.env.OPENAI_API_KEY;
                      if (apiKey) {
                        try {
                          const res = await fetch("https://api.openai.com/v1/chat/completions", {
                            method: "POST",
                            headers: {
                              Authorization: `Bearer ${apiKey}`,
                              "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                              model: "gpt-4o-mini",
                              max_tokens: 60,
                              messages: [
                                {
                                  role: "system",
                                  content: "You write short, friendly one-sentence messages for a walking app. Be honest and helpful. Never use emojis.",
                                },
                                {
                                  role: "user",
                                  content: `The user searched for "${typeof moodText === "string" ? moodText : originalQuery}". We couldn't find results matching that specifically, so we broadened to nearby ${baseType}s. Write a short explanation (1 sentence, under 15 words).`,
                                },
                              ],
                            }),
                          });
                          if (res.ok) {
                            const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
                            fallbackMessage = data.choices?.[0]?.message?.content?.trim() ?? null;
                          }
                        } catch {
                          // keep fallbackMessage null
                        }
                      }
                    }
                  }
                } else {
                  // Retry returned enough results — use them
                  places = retryPlaces;
                }
              }
              // When we broadened, keep original specific results at the front; dedup by place_id (or name)
              if (didBroaden && originalPlaces.length > 0) {
                const originalIds = new Set(originalPlaces.map((p) => p.place_id ?? p.name));
                const newFromBroadened = places.filter((p) => !originalIds.has(p.place_id ?? p.name));
                places = [...originalPlaces, ...newFromBroadened];
                console.log("[places] Prepended originals:", originalPlaces.map((p) => p.name), "total:", places.length);
              } else if (didBroaden && parsedPoiQuery) {
                // No original results to prepend; prioritize by keyword match
                const keywords = parsedPoiQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
                const desc = (p: PlaceOptionResult) => (p.description ?? "").toLowerCase();
                places.sort((a, b) => {
                  const aMatch = keywords.some((kw) => a.name.toLowerCase().includes(kw) || desc(a).includes(kw)) ? 1 : 0;
                  const bMatch = keywords.some((kw) => b.name.toLowerCase().includes(kw) || desc(b).includes(kw)) ? 1 : 0;
                  return bMatch - aMatch; // matches first
                });
              }
              sortLabel = applySubjectiveSortAndLabel(places, typeof moodText === "string" ? moodText : null);
              if (sortLabel == null && hasFeatureQualifier) {
                const base = parsed.poi_query ? PLACE_TYPE_KEYWORDS.find((kw) => parsed.poi_query!.toLowerCase().includes(kw)) : undefined;
                sortLabel = base ? base.toUpperCase() : null;
              }
              if (places.length >= 2) {
                let finalPlaces: PlaceOptionResult[];
                if (detectedSubjective) {
                  console.log("[rerank] Skipped — subjective qualifier sort already applied");
                  finalPlaces = places;
                } else {
                  if (isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null)) {
                    finalPlaces = await rerankByObjectiveFit(places, (typeof moodText === "string" ? moodText : "").trim());
                  } else {
                    finalPlaces = rerankPlacesForLocalCharacter(places);
                  }
                  finalPlaces = applyFinalRelevanceSort(finalPlaces, typeof moodText === "string" ? moodText : null);
                }
                const verificationMain = await runQualifierVerification(finalPlaces, typeof moodText === "string" ? moodText : null);
                let placeOptionsMain = applyKeywordRelevanceSort(verificationMain.places, typeof moodText === "string" ? moodText : null);
                let verificationSummaryMain = verificationMain.verificationSummary;
                const qualifierIsPrimaryMain = verificationMain.qualifierSearched && !detectedSubjective;
                if (qualifierIsPrimaryMain) {
                  const verifiedMain = placeOptionsMain.filter((p) => p.qualifierVerified);
                  const unverifiedMain = placeOptionsMain.filter((p) => !p.qualifierVerified);
                  const unverifiedWithSignalMain = unverifiedMain.filter((p) =>
                    hasRelevanceSignal(p, verificationMain.qualifierSearched ?? null, typeof moodText === "string" ? moodText : null)
                  );
                  if (verifiedMain.length >= 1) {
                    placeOptionsMain = [...verifiedMain, ...unverifiedWithSignalMain.slice(0, 2)];
                    console.log("[filter] Showing", verifiedMain.length, "verified +", Math.min(unverifiedWithSignalMain.length, 2), "alternatives (with relevance signal)");
                  }
                }
                const mergedFallback = fallbackMessage ?? verificationMain.fallbackMessage;
                const contentKeywordsMain = moodLower.split(/\s+/).filter((w) => w.length > 2 && !CONTENT_KEYWORD_STOP_WORDS.includes(w));
                const matchingPlacesMain = contentKeywordsMain.length > 0
                  ? placeOptionsMain.filter((p) => contentKeywordsMain.some((kw) => (p.name ?? "").toLowerCase().includes(kw)))
                  : placeOptionsMain;
                console.log("[summary] Keyword-relevant places in final array (main):", matchingPlacesMain.map((p) => p.name));
                const summaryMain = await generateSearchSummary({
                  moodText: typeof moodText === "string" ? moodText : "",
                  places: placeOptionsMain,
                  detectedQualifier: verificationMain.qualifierSearched ?? null,
                  detectedSubjective,
                  didBroaden,
                  poiSearchRadius,
                  contentKeywords: contentKeywordsMain,
                });
                const sortLabelMainFinal = summaryMain ?? sortLabel;
                console.log("[sort] Final sortLabel:", sortLabelMainFinal);
                console.log("[route] Response includes sort_label:", sortLabelMainFinal, "fallback_message:", mergedFallback);
                console.log("[response] Building place_options from (same array as map pins):", placeOptionsMain.slice(0, 5).map((p) => p.name));
                console.log("[places] Returning place_options, objective?", isObjectiveBasedSearch(parsedPoiQuery, typeof moodText === "string" ? moodText : null), "query:", parsedPoiQuery, "moodText:", typeof moodText === "string" ? moodText.substring(0, 50) : null);
                return NextResponse.json({
                  place_options: placeOptionsMain,
                  needs_place_selection: true,
                  intent,
                  fallback_message: mergedFallback ?? null,
                  verification_method: verificationMain.verification_method,
                  qualifier_searched: verificationMain.qualifierSearched,
                  detected_qualifier: verificationMain.qualifierSearched ?? null,
                  sort_label: sortLabelMainFinal ?? null,
                  verification_summary: verificationSummaryMain ?? null,
                  used_web_search: verificationMain.usedTierCWebSearch,
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

    const DEFAULT_MOOD_ONLY_DURATION = 25;
    const isSurpriseMe = typeof durationMinutes === "number" && durationMinutes === 0;
    const durationFromBody =
      typeof durationMinutes === "number" && durationMinutes > 0 ? Math.round(durationMinutes) : null;
    const durationFromDistance =
      pattern === "mood_only" && targetDistanceKm != null && targetDistanceKm > 0
        ? (targetDistanceKm * 1000) / WALK_SPEED_M_PER_MIN
        : null;
    // Only use LLM suggested_duration when the user's text explicitly mentions a duration (e.g. "30 min", "1 hour") — otherwise show the picker for "calm walk", "I need fresh air", etc.
    const userTextHasExplicitDuration = /\d+\s*(?:min|minute|mins?|hr|hour|h\b)/i.test(String(moodText ?? "").trim());
    const effectiveSuggestedDuration = userTextHasExplicitDuration ? suggestedDuration : null;
    let effectiveDuration =
      isSurpriseMe
        ? 25 + Math.floor(Math.random() * 21)
        : durationFromBody ?? effectiveSuggestedDuration ?? durationFromDistance;
    if (effectiveSuggestedDuration != null && effectiveDuration == null) {
      effectiveDuration = effectiveSuggestedDuration;
    }

    // When no destination / mood_only / mood_and_area / themed_walk: ask for duration unless we already have one (from body, LLM suggested_duration, or distance). Do NOT default effectiveDuration here — that would skip the picker.
    const isLoopWithDurationSpecified = pattern === "mood_only" && isLoop && (suggestedDuration != null || maxDurationMinutes != null);
    const isThemedWalk = pattern === "themed_walk";
    let mustAskDuration =
      pattern !== "mood_and_poi" &&
      (destCoords === null || pattern === "mood_only" || pattern === "mood_and_area" || isThemedWalk) &&
      (effectiveDuration == null || (isLoopWithDurationSpecified && suggestedDuration == null));

    console.log("[route] effectiveDuration:", effectiveDuration, "suggested_duration:", suggestedDuration, "mustAskDuration:", mustAskDuration);

    // Exception: night mode mood_only — skip picker and default to 20 min (only case we skip the picker besides user-stated duration)
    if (isNight && pattern === "mood_only" && mustAskDuration && effectiveDuration == null && (skipDuration || isSurprise)) {
      effectiveDuration = 20;
      mustAskDuration = false;
    }

    if (mustAskDuration) {
      const durationOptions = [
        { label: "5 – 15 min", value: 10 },
        { label: "15 – 45 min", value: 30 },
        { label: "30 min – 1.5 hrs", value: 60 },
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

    // Fallback defaults when we proceeded without asking (e.g. night mood_only already set to 20)
    if (pattern === "mood_only" && effectiveDuration == null) {
      effectiveDuration = intent === "quick" ? 15 : DEFAULT_MOOD_ONLY_DURATION;
    }
    if (pattern === "mood_and_area" && effectiveDuration == null) {
      effectiveDuration = 45;
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
      const LOOP_INTENTS: Intent[] = ["nature", "calm", "exercise"];
      isLoop = isSurprise
        ? false
        : LOOP_INTENTS.includes(intent as Intent)
          ? true
          : intent === "discover" && skipDuration
            ? Math.random() < 0.5
            : false;
      const duration = effectiveDuration ?? 25;
      const targetKm = duration * WALK_SPEED_KM_PER_MIN * 0.75;
      console.log("[route] MOOD_ONLY:", { intent, duration, isLoop });
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
      // For a loop, one-way distance = targetKm * 1000 / 2 (0.75 shrink for street routing vs straight line). For one-way, use full duration.
      const loopOutboundM = (targetKm * 1000) / 2;
      const totalDurationSeconds = effectiveDuration! * 60;
      const fullDurationSeconds = isLoop
        ? Math.min(totalDurationSeconds / 2, (MAX_ROUTE_DURATION_MIN * 60) / 2)
        : Math.min(totalDurationSeconds, MAX_ROUTE_DURATION_MIN * 60);
      let waypoint: [number, number];
      let destination_name: string | null = null;
      let destination_address: string | null = null;
      type RouteSegment = { coordinates: [number, number][]; duration: number; distance: number };
      let oneWayRoute: RouteSegment | null = null;
      const namedDest =
        !isLoop && !isSurprise
          ? await findMoodOnlyDestination(
              loopOrigin[0],
              loopOrigin[1],
              intent as Intent,
              effectiveDuration!
            )
          : null;
      if (namedDest) {
        waypoint = [namedDest.lat, namedDest.lng];
        destination_name = namedDest.name;
        destination_address = namedDest.description;
      } else if (isSurprise) {
        const outboundM = Math.min(effectiveDuration! * ROUTE_DISTANCE_M_PER_MIN, 2500);
        const bearingOffset = typeof retryCount === "number" ? retryCount * 111 : 0;
        waypoint = clampWaypointToBarcelona(
          waypointFromBearing(loopOrigin[0], loopOrigin[1], outboundM, (Math.random() * 360 + bearingOffset) % 360)
        );
      } else if (isLoop) {
        const outboundM = loopOutboundM;
        const bearingOffset = typeof retryCount === "number" ? retryCount * 111 : 0;
        let best: { route: RouteSegment; wp: [number, number]; score: number } | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const sign = attempt === 0 ? 1 : attempt === 1 ? -1 : 1;
          const diagonal = attempt === 2;
          const bearing = (Math.random() * 360 + bearingOffset) % 360;
          const wp = clampWaypointToBarcelona(waypointFromBearing(loopOrigin[0], loopOrigin[1], outboundM, bearing));
          try {
            const outRoutes = await fetchOrsRoutes(loopOrigin, wp, intent, forceAvoidZones);
            if (!outRoutes[0]) continue;
            const outboundCoords = outRoutes[0].coordinates;
            const outMidIdx = Math.floor(outboundCoords.length * 0.4);
            const outMidCoord = outboundCoords[outMidIdx];
            let returnWp = offsetPerpendicular(outMidCoord[1], outMidCoord[0], loopOrigin[0], loopOrigin[1], 500, { sign: 1 });
            let returnRoute = await fetchOrsWaypointRoute(wp, [returnWp, loopOrigin], intent, forceAvoidZones);
            let overlap = fractionReturnNearOutbound(outboundCoords, returnRoute.coordinates.slice(1), 30);
            if (overlap > 0.4) {
              const returnWp2 = offsetPerpendicular(outMidCoord[1], outMidCoord[0], loopOrigin[0], loopOrigin[1], 500, { sign: -1 });
              const returnRoute2 = await fetchOrsWaypointRoute(wp, [returnWp2, loopOrigin], intent, forceAvoidZones);
              const overlap2 = fractionReturnNearOutbound(outboundCoords, returnRoute2.coordinates.slice(1), 30);
              if (overlap2 < overlap) {
                returnRoute = returnRoute2;
                overlap = overlap2;
              }
            }
            const returnCoords = returnRoute.coordinates.slice(1);
            if (overlap > 0.4) continue;
            const loopCoords = [...outboundCoords, ...returnCoords] as [number, number][];
            const combined: RouteSegment = {
              coordinates: loopCoords,
              duration: outRoutes[0].duration + returnRoute.duration,
              distance: outRoutes[0].distance + returnRoute.distance,
            };
            const { score } = scoreRoute(combined.coordinates, intent, index);
            if (!best || score > best.score) best = { route: combined, wp, score };
          } catch {
            continue;
          }
        }
        if (best) {
          oneWayRoute = best.route;
          waypoint = best.wp;
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
      } else {
        if (intent === "discover" && !namedDest) {
          const outboundM = Math.min(effectiveDuration! * ROUTE_DISTANCE_M_PER_MIN, 2500);
          const bearingOffset = typeof retryCount === "number" ? retryCount * 111 : 0;
          waypoint = clampWaypointToBarcelona(
            waypointFromBearing(loopOrigin[0], loopOrigin[1], outboundM, (Math.random() * 360 + bearingOffset) % 360)
          );
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
      }
      let builtAsLoopInFallback = false;
      if (!oneWayRoute) {
        let orsRoutes = await fetchOrsRoutes(loopOrigin, waypoint, intent, forceAvoidZones);
        oneWayRoute = orsRoutes[0] ?? null;
        if (!oneWayRoute) {
          // Retry once with a different waypoint before failing
          let retryWaypoint: [number, number] | null = null;
          if (isLoop) {
            const outboundM = loopOutboundM;
            retryWaypoint = clampWaypointToBarcelona(
              waypointFromBearing(loopOrigin[0], loopOrigin[1], outboundM, (Math.random() * 360 + 200) % 360)
            );
          } else {
            try {
              const boundary = await fetchIsochrone(loopOrigin[0], loopOrigin[1], fullDurationSeconds);
              retryWaypoint = pickWaypointFromBoundary(
                intent as Intent,
                boundary,
                loopOrigin[0],
                loopOrigin[1],
                index,
                MAX_ROUTE_DISTANCE_M,
                null
              );
            } catch {
              retryWaypoint = null;
            }
          }
          if (retryWaypoint) {
            orsRoutes = await fetchOrsRoutes(loopOrigin, retryWaypoint, intent, forceAvoidZones);
            oneWayRoute = orsRoutes[0] ?? null;
            if (oneWayRoute) waypoint = retryWaypoint;
          }
        }
        if (!oneWayRoute) {
          // mood_only: never fail — fall back to loop route (no duration error)
          console.log("[route] One-way mood_only failed, falling back to loop route");
          isLoop = true;
          const outboundM = loopOutboundM;
          const bearingOffset = typeof retryCount === "number" ? retryCount * 111 : 0;
          let loopBest: { route: RouteSegment; wp: [number, number]; score: number } | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const sign = attempt === 0 ? 1 : attempt === 1 ? -1 : 1;
            const diagonal = attempt === 2;
            const bearing = (Math.random() * 360 + bearingOffset) % 360;
            const wp = clampWaypointToBarcelona(waypointFromBearing(loopOrigin[0], loopOrigin[1], outboundM, bearing));
            try {
              const outRoutes = await fetchOrsRoutes(loopOrigin, wp, intent, forceAvoidZones);
              if (!outRoutes[0]) continue;
              const outboundCoords = outRoutes[0].coordinates;
              const outMidIdx = Math.floor(outboundCoords.length * 0.4);
              const outMidCoord = outboundCoords[outMidIdx];
              let returnWp = offsetPerpendicular(outMidCoord[1], outMidCoord[0], loopOrigin[0], loopOrigin[1], 500, { sign: 1 });
              let returnRoute = await fetchOrsWaypointRoute(wp, [returnWp, loopOrigin], intent, forceAvoidZones);
              let overlap = fractionReturnNearOutbound(outboundCoords, returnRoute.coordinates.slice(1), 30);
              if (overlap > 0.4) {
                const returnWp2 = offsetPerpendicular(outMidCoord[1], outMidCoord[0], loopOrigin[0], loopOrigin[1], 500, { sign: -1 });
                const returnRoute2 = await fetchOrsWaypointRoute(wp, [returnWp2, loopOrigin], intent, forceAvoidZones);
                const overlap2 = fractionReturnNearOutbound(outboundCoords, returnRoute2.coordinates.slice(1), 30);
                if (overlap2 < overlap) {
                  returnRoute = returnRoute2;
                  overlap = overlap2;
                }
              }
              const returnCoords = returnRoute.coordinates.slice(1);
              if (overlap > 0.4) continue;
              const loopCoords = [...outboundCoords, ...returnCoords] as [number, number][];
              const combined: RouteSegment = {
                coordinates: loopCoords,
                duration: outRoutes[0].duration + returnRoute.duration,
                distance: outRoutes[0].distance + returnRoute.distance,
              };
              const { score } = scoreRoute(combined.coordinates, intent, index);
              if (!loopBest || score > loopBest.score) loopBest = { route: combined, wp, score };
            } catch {
              continue;
            }
          }
          if (loopBest) {
            oneWayRoute = loopBest.route;
            waypoint = loopBest.wp;
            builtAsLoopInFallback = true;
          } else {
            const boundary = await fetchIsochrone(loopOrigin[0], loopOrigin[1], fullDurationSeconds);
            waypoint = pickWaypointFromBoundary(
              intent as Intent,
              boundary,
              loopOrigin[0],
              loopOrigin[1],
              index,
              MAX_ROUTE_DISTANCE_M,
              null
            );
            const orsRoutes = await fetchOrsRoutes(loopOrigin, waypoint, intent, forceAvoidZones);
            oneWayRoute = orsRoutes[0] ?? null;
            if (oneWayRoute) {
              const returnOffset1 = offsetPerpendicular(waypoint[0], waypoint[1], loopOrigin[0], loopOrigin[1], 400);
              const returnOffset2 = offsetPerpendicular(waypoint[0], waypoint[1], loopOrigin[0], loopOrigin[1], 200, { along: 1 / 3, sign: -1 });
              const returnRoute = await fetchOrsWaypointRoute(waypoint, [returnOffset1, returnOffset2, loopOrigin], intent, forceAvoidZones);
              oneWayRoute = {
                coordinates: [...oneWayRoute.coordinates, ...returnRoute.coordinates.slice(1)] as [number, number][],
                duration: oneWayRoute.duration + returnRoute.duration,
                distance: oneWayRoute.distance + returnRoute.distance,
              };
              builtAsLoopInFallback = true;
            }
          }
        }
        if (!oneWayRoute) {
          // Simple random direction: short distance, clamped to Barcelona — never show error
          console.log("[route] Loop fallback failed, trying simple random direction");
          for (const distM of [500, 400, 300, 200]) {
            const wp = clampWaypointToBarcelona(
              waypointFromBearing(loopOrigin[0], loopOrigin[1], distM, Math.random() * 360)
            );
            try {
              const orsRoutes = await fetchOrsRoutes(loopOrigin, wp, intent, forceAvoidZones);
              if (orsRoutes[0]) {
                oneWayRoute = orsRoutes[0];
                waypoint = wp;
                break;
              }
            } catch {
              continue;
            }
          }
        }
        if (!oneWayRoute) {
          // Last resort: fixed short leg so we always return a route
          const wp = clampWaypointToBarcelona(
            waypointFromBearing(loopOrigin[0], loopOrigin[1], 250, 0)
          );
          const orsRoutes = await fetchOrsRoutes(loopOrigin, wp, intent, forceAvoidZones);
          if (orsRoutes[0]) {
            oneWayRoute = orsRoutes[0];
            waypoint = wp;
          }
        }
        if (isLoop && !builtAsLoopInFallback && oneWayRoute) {
          const outCoords = oneWayRoute.coordinates;
          const outMidIdx = Math.floor(outCoords.length * 0.4);
          const outMidCoord = outCoords[outMidIdx];
          let returnWp = offsetPerpendicular(outMidCoord[1], outMidCoord[0], loopOrigin[0], loopOrigin[1], 500, { sign: 1 });
          let returnRoute = await fetchOrsWaypointRoute(waypoint, [returnWp, loopOrigin], intent, forceAvoidZones);
          let overlap = fractionReturnNearOutbound(outCoords, returnRoute.coordinates.slice(1), 30);
          if (overlap > 0.4) {
            const returnWp2 = offsetPerpendicular(outMidCoord[1], outMidCoord[0], loopOrigin[0], loopOrigin[1], 500, { sign: -1 });
            const returnRoute2 = await fetchOrsWaypointRoute(waypoint, [returnWp2, loopOrigin], intent, forceAvoidZones);
            const overlap2 = fractionReturnNearOutbound(outCoords, returnRoute2.coordinates.slice(1), 30);
            if (overlap2 < overlap) returnRoute = returnRoute2;
          }
          const loopCoords = [...outCoords, ...returnRoute.coordinates.slice(1)];
          oneWayRoute = {
            coordinates: loopCoords,
            duration: oneWayRoute.duration + returnRoute.duration,
            distance: oneWayRoute.distance + returnRoute.distance,
          };
        }
        if (!oneWayRoute) {
          console.warn("[route] mood_only: all fallbacks failed, using minimal route so we never return an error");
          const wp = clampWaypointToBarcelona(waypointFromBearing(loopOrigin[0], loopOrigin[1], 200, 0));
          oneWayRoute = { coordinates: [[loopOrigin[1], loopOrigin[0]], [wp[1], wp[0]]] as [number, number][], duration: 180, distance: 200 };
          waypoint = wp;
        }
      }
      const requestedMinutes = effectiveDuration ?? 30;
      const isDiscoverOrSurprise = intent === "discover" || isSurprise;
      const maxAcceptableMinutes = isDiscoverOrSurprise ? requestedMinutes * 2 : requestedMinutes * 1.5;
      let routeMinutes = oneWayRoute.duration / 60;
      if (routeMinutes > requestedMinutes * 1.5 && (isSurprise || (intent === "discover" && !namedDest))) {
        const closerOutboundM = Math.min(
          (requestedMinutes * ROUTE_DISTANCE_M_PER_MIN) * 0.5,
          (effectiveDuration ?? 25) * ROUTE_DISTANCE_M_PER_MIN * 0.6
        );
        const wpCloser = clampWaypointToBarcelona(
          waypointFromBearing(loopOrigin[0], loopOrigin[1], closerOutboundM, Math.random() * 360)
        );
        try {
          const orsRoutesCloser = await fetchOrsRoutes(loopOrigin, wpCloser, intent, forceAvoidZones);
          if (orsRoutesCloser[0] && orsRoutesCloser[0].duration < oneWayRoute.duration) {
            oneWayRoute = orsRoutesCloser[0];
            waypoint = wpCloser;
            routeMinutes = oneWayRoute.duration / 60;
          }
        } catch {
          /* keep current route */
        }
      }
      if (routeMinutes > maxAcceptableMinutes && !isSurprise) {
        // Try once more with a much closer waypoint before giving up
        const closerM = (effectiveDuration! * ROUTE_DISTANCE_M_PER_MIN) * 0.3;
        const closerWp = clampWaypointToBarcelona(
          waypointFromBearing(loopOrigin[0], loopOrigin[1], closerM, Math.random() * 360)
        );
        try {
          let retryRoute: { coordinates: [number, number][]; duration: number; distance: number } | null = null;
          if (isLoop) {
            const outRoutes = await fetchOrsRoutes(loopOrigin, closerWp, intent, forceAvoidZones);
            if (outRoutes[0]) {
              const outboundCoords = outRoutes[0].coordinates;
              const outMidIdx = Math.floor(outboundCoords.length * 0.4);
              const outMidCoord = outboundCoords[outMidIdx];
              let returnWp = offsetPerpendicular(outMidCoord[1], outMidCoord[0], loopOrigin[0], loopOrigin[1], 500, { sign: 1 });
              let returnRoute = await fetchOrsWaypointRoute(closerWp, [returnWp, loopOrigin], intent, forceAvoidZones);
              let overlap = fractionReturnNearOutbound(outboundCoords, returnRoute.coordinates.slice(1), 30);
              if (overlap > 0.4) {
                const returnWp2 = offsetPerpendicular(outMidCoord[1], outMidCoord[0], loopOrigin[0], loopOrigin[1], 500, { sign: -1 });
                const returnRoute2 = await fetchOrsWaypointRoute(closerWp, [returnWp2, loopOrigin], intent, forceAvoidZones);
                const overlap2 = fractionReturnNearOutbound(outboundCoords, returnRoute2.coordinates.slice(1), 30);
                if (overlap2 < overlap) returnRoute = returnRoute2;
              }
              retryRoute = {
                coordinates: [...outboundCoords, ...returnRoute.coordinates.slice(1)] as [number, number][],
                duration: outRoutes[0].duration + returnRoute.duration,
                distance: outRoutes[0].distance + returnRoute.distance,
              };
            }
          } else {
            const outRoutes = await fetchOrsRoutes(loopOrigin, closerWp, intent, forceAvoidZones);
            retryRoute = outRoutes[0] ?? null;
          }
          if (retryRoute && retryRoute.duration / 60 <= maxAcceptableMinutes) {
            oneWayRoute = retryRoute;
            waypoint = closerWp;
            routeMinutes = retryRoute.duration / 60;
          }
        } catch (e) {
          console.warn("[route] mood_only duration retry failed, returning route anyway:", e);
        }

        // If still too long, just return it anyway with a note — never error on mood_only
        if (oneWayRoute) {
          routeMinutes = oneWayRoute.duration / 60;
        }
      }
      if (
        (oneWayRoute.duration > FRONTEND_MAX_DURATION_MIN * 60 ||
          oneWayRoute.distance > FRONTEND_MAX_DISTANCE_M) &&
        !isSurprise
      ) {
        console.warn(
          "[route] mood_only route exceeds frontend limits, returning anyway:",
          { durationMin: oneWayRoute.duration / 60, distanceM: oneWayRoute.distance }
        );
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
      const nonDestHighlights = highlights.filter((h) => h.type !== "destination");
      const isDiscoveryOneWay = !isLoop && (intent === "discover" || intent === "scenic" || intent === "lively");
      if (isEmotionalSupport && summary) summary = softenSummaryForEmotionalSupport(summary);
      const poisForPreview =
        isDiscoveryOneWay && nonDestHighlights.length > 0
          ? nonDestHighlights.slice(0, 5).map((h) => ({
              name: h.name ?? h.label,
              lat: h.lat,
              lng: h.lng,
              type: h.type,
              photo_url: h.photo_url ?? null,
              description: h.description ?? null,
            }))
          : undefined;
      const oneWayResult = {
        coordinates: simplifyRoute(oneWayRoute.coordinates, 0.00008),
        duration: oneWayRoute.duration,
        distance: oneWayRoute.distance,
        score,
        breakdown,
        summary,
        highlights,
        ...(poisForPreview && { pois: poisForPreview }),
      };
      return NextResponse.json({
        recommended: oneWayResult,
        quick: oneWayResult,
        alternatives_count: 1,
        destination_name,
        destination_address,
        pattern: "mood_only",
        intent,
        is_loop: isLoop,
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

    // Replace template summaries with intent-aware tags when we have mood text (fallback to template on failure).
    const fallbackTags = recommended.summary ? recommended.summary.split(" · ").filter(Boolean).slice(0, 3) : [];
    let recommendedSummary = recommended.summary;
    let quickSummary = quick.summary;
    const moodTextStr = typeof moodText === "string" ? moodText.trim() : "";
    if (moodTextStr) {
      try {
        const intentTags = await generateRouteDescriptionTags(intent as Intent, moodTextStr, fallbackTags);
        if (intentTags.length >= 3) {
          recommendedSummary = buildSummary(recDuration, recDistance, intentTags, intent as Intent, isNight);
          quickSummary = buildSummary(qDuration, qDistance, intentTags, intent as Intent, isNight);
        }
      } catch {
        // keep template summaries
      }
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

    // POIs for route preview dots: any route with non-destination highlights gets up to 5 for the map (discover, scenic, lively, themed_walk, etc.)
    const recommendedPois =
      recommendedHighlights.length > 0
        ? recommendedHighlights
            .filter((h) => h.type !== "destination" && (h.name ?? h.label ?? "").trim() !== "")
            .slice(0, 5)
            .map((h) => ({
              name: (h.name ?? h.label ?? "").trim(),
              lat: h.lat,
              lng: h.lng,
              type: h.type,
              photo_url: (h as { photo_url?: string | null }).photo_url ?? null,
              description: (h as { description?: string | null }).description ?? null,
            }))
        : undefined;
    const quickPois =
      quickHighlights.length > 0
        ? quickHighlights
            .filter((h) => h.type !== "destination" && (h.name ?? h.label ?? "").trim() !== "")
            .slice(0, 5)
            .map((h) => ({
              name: (h.name ?? h.label ?? "").trim(),
              lat: h.lat,
              lng: h.lng,
              type: h.type,
              photo_url: (h as { photo_url?: string | null }).photo_url ?? null,
              description: (h as { description?: string | null }).description ?? null,
            }))
        : undefined;
    const recommendedPayload = {
      coordinates: simplifyRoute(recommended.coordinates, 0.00008),
      duration: recDuration,
      distance: recDistance,
      summary: recommendedSummary,
      score: recommended.score,
      breakdown: recommended.breakdown,
      highlights: recommendedHighlights,
      ...(recommendedPois && recommendedPois.length > 0 && { pois: recommendedPois }),
    };
    const quickPayload = {
      coordinates: simplifyRoute(quick.coordinates, 0.00008),
      duration: qDuration,
      distance: qDistance,
      summary: quickSummary,
      score: quick.score,
      breakdown: quick.breakdown,
      highlights: quickHighlights,
      ...(quickPois && quickPois.length > 0 && { pois: quickPois }),
    };

    const routesAreSimilar = Math.abs(recommended.duration - quick.duration) < 30;

    return NextResponse.json({
      recommended: defaultToFastest ? quickPayload : recommendedPayload,
      quick: routesAreSimilar ? null : (defaultToFastest ? recommendedPayload : quickPayload),
      default_is_fastest: defaultToFastest ?? false,
      routes_are_similar: routesAreSimilar,
      alternatives_count: scored.length,
      destination_name,
      destination_address,
      destination_photo: destination_photo ?? undefined,
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
