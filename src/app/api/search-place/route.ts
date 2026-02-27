import { NextResponse } from "next/server";

const BCN_BOUNDS = { south: 41.32, west: 2.05, north: 41.47, east: 2.23 };

function isInBarcelona(lat: number, lng: number): boolean {
  return (
    lat >= BCN_BOUNDS.south &&
    lat <= BCN_BOUNDS.north &&
    lng >= BCN_BOUNDS.west &&
    lng <= BCN_BOUNDS.east
  );
}

/** POST body: { query: string, limit?: number }. Returns places in Barcelona for start-location autocomplete (Google Places fuzzy match). */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 5) : 1;
    if (!query) {
      return NextResponse.json({ places: [] });
    }
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ places: [] });
    }
    const textQuery = query.includes("Barcelona") ? query : `${query} Barcelona`;
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.displayName,places.location",
      },
      body: JSON.stringify({
        textQuery,
        locationBias: {
          circle: {
            center: { latitude: 41.39, longitude: 2.17 },
            radius: 10000,
          },
        },
        maxResultCount: limit,
      }),
    });
    if (!res.ok) return NextResponse.json({ places: [] });
    const data = (await res.json()) as {
      places?: Array<{
        displayName?: { text?: string };
        location?: { latitude?: number; longitude?: number };
      }>;
    };
    const places: { lat: number; lng: number; name: string }[] = [];
    for (const place of data.places ?? []) {
      const lat = Number(place.location?.latitude);
      const lng = Number(place.location?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isInBarcelona(lat, lng)) continue;
      const name = place.displayName?.text?.trim() ?? "";
      if (name) places.push({ lat, lng, name });
      if (places.length >= limit) break;
    }
    return NextResponse.json({ places });
  } catch {
    return NextResponse.json({ places: [] });
  }
}
