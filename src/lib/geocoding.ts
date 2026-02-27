export type GeocodeResult = { lat: number; lng: number; displayName: string };

/** Barcelona bounding box — use for restricting start location and validation. */
export const BCN_BOUNDS = {
  south: 41.32,
  west: 2.05,
  north: 41.47,
  east: 2.23,
};

/** Barcelona bounding box (lat/lng) — same as route API. Nominatim viewbox is left,top,right,bottom = minLng,maxLat,maxLng,minLat. */
const BCN_VIEWBOX = "2.05,41.47,2.23,41.32";

export function isInBarcelona(lat: number, lng: number): boolean {
  return lat >= BCN_BOUNDS.south && lat <= BCN_BOUNDS.north && lng >= BCN_BOUNDS.west && lng <= BCN_BOUNDS.east;
}

/** Normalize string for typo-tolerant retry: strip accents, collapse spaces, lowercase for matching. */
function normalizeForTypo(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Try a typo-friendlier query: without accents, or first token + Barcelona. */
function typoFallbackQuery(placeName: string): string | null {
  const trimmed = placeName.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (normalized === trimmed) return null;
  return `${normalized} Barcelona`;
}

/**
 * Geocode a place name in Barcelona using Nominatim (same as route API).
 * Returns coords and display name, or null if not found.
 */
export async function geocodeBarcelona(placeName: string): Promise<GeocodeResult | null> {
  const results = await geocodeBarcelonaOptions(placeName, 1);
  return results[0] ?? null;
}

/**
 * Geocode a place name in Barcelona and return up to `limit` results (for autocomplete/confirmation).
 * Restricts to Barcelona via viewbox+bounded. Filters results to bbox. Retries with accent-normalized query if 0 results (typo tolerance).
 */
export async function geocodeBarcelonaOptions(
  placeName: string,
  limit: number = 3
): Promise<GeocodeResult[]> {
  const run = async (query: string): Promise<GeocodeResult[]> => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=${Math.min(limit, 5)}&viewbox=${BCN_VIEWBOX}&bounded=1`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "reRoute-prototype/1.0" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { lat?: string; lon?: string; display_name?: string }[];
    const out: GeocodeResult[] = [];
    for (const item of data ?? []) {
      if (!item?.lat || !item?.lon) continue;
      const lat = parseFloat(item.lat);
      const lng = parseFloat(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (!isInBarcelona(lat, lng)) continue;
      const displayName =
        item.display_name?.split(",").slice(0, 2).join(", ").trim() || placeName.trim();
      out.push({ lat, lng, displayName });
      if (out.length >= limit) break;
    }
    return out;
  };

  const query = `${placeName.trim()} Barcelona`;
  let results = await run(query);
  if (results.length === 0) {
    const fallback = typoFallbackQuery(placeName);
    if (fallback) results = await run(fallback);
  }
  return results;
}
