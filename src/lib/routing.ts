export type Intent = "calm" | "discover" | "nature" | "scenic" | "lively" | "exercise" | "cafe" | "quick";

export interface RouteHighlight {
  lat: number;
  lng: number;
  label: string;
  type: string;
  name?: string;
  description?: string;
  /** Legacy single photo URL (optional). */
  photo_url?: string | null;
  /** Up to 3 photo URLs for POI card gallery (from /api/place-photo). */
  photo_urls?: string[];
  /** Up to 3 photo_reference strings (old Places API) for gallery when from Text Search. */
  photoRefs?: string[];
  /** Google Place ID for fetching photos (e.g. ChIJ...). */
  placeId?: string;
  /** Single photo reference (optional). */
  photoRef?: string | null;
}

/** POI for preview (discovery/themed_walk) — shown on map before navigation. */
export interface RoutePreviewPoi {
  name: string;
  lat: number;
  lng: number;
  type: string;
  photo_url?: string | null;
  description?: string | null;
}

export interface RouteResult {
  coordinates: [number, number][];
  duration: number;
  distance: number;
  summary: string;
  score: number;
  breakdown: {
    noise: number;
    green: number;
    clean: number;
    cultural: number;
  };
  highlights?: RouteHighlight[];
  /** Up to 5 POIs for discovery/themed_walk preview (show on map before LET'S GO). */
  pois?: RoutePreviewPoi[];
}

export interface PlaceOption {
  name: string;
  /** Short descriptor for the card (replaces address). */
  description: string | null;
  lat: number;
  lng: number;
  rating: number | null;
  summary: string | null;
  photo_url: string | null;
  /** Optional gallery of photo URLs for place card (falls back to photo_url if absent). */
  photo_urls?: string[];
  /** Google Places primaryType (e.g. restaurant, cafe) — used to default to fastest route for establishments. */
  primary_type?: string | null;
  /** Set when place was verified for a qualifier search (e.g. laptop-friendly). */
  qualifierVerified?: boolean;
  /** "editorial" | "review" | "web" when qualifierVerified is true. */
  qualifierSource?: string | null;
  /** Short reason for verification or unverified (e.g. "CONFIRMED IN REVIEWS", "no mention in reviews"). */
  qualifierReason?: string | null;
}

export interface RoutesResponse {
  recommended: RouteResult;
  quick: RouteResult | null;
  destination_name: string | null;
  destination_address: string | null;
  destination_photo?: string | null;
  pattern: string;
  /** Route intent for map polyline color (calm, nature, scenic, discover, lively, exercise, cafe, quick, themed_walk). */
  intent?: string;
  isLoop?: boolean;
  place_options?: PlaceOption[];
  end_point?: [number, number];
  /** When true, recommended is the fastest route and the UI should show "Pleasant route" as the switch option. */
  default_is_fastest?: boolean;
  /** When true, recommended and quick are within ~1 min; client should hide the Switch. */
  routes_are_similar?: boolean;
}

export interface DurationPromptResponse {
  needs_duration: true;
  intent: string;
  message: string;
  options: { label: string; value: number }[];
  /** When true, client should skip the duration picker and use auto_duration. */
  skip_duration?: boolean;
  /** When skip_duration is true, use this duration (minutes) and call getRouteWithDuration immediately. */
  auto_duration?: number;
}

export interface PlaceOptionsResponse {
  place_options: PlaceOption[];
  intent: Intent;
  /** e.g. "WHICH ONE?" for destination disambiguation; default "CHOOSE A PLACE" */
  place_selection_heading?: string;
  /** When we broadened the search (e.g. matcha → cafe), short explanation for the user */
  fallback_message?: string | null;
  /** "places_data" | "web_search" | "unverified" for qualifier verification */
  verification_method?: string;
  /** The qualifier we searched for (e.g. "laptop-friendly") when verification ran */
  qualifier_searched?: string | null;
  /** Subjective sort rationale (e.g. "sorted by highest rated") when a subjective qualifier was detected */
  sort_label?: string | null;
  /** When qualifier verification found results (e.g. "1 CONFIRMED IN REVIEWS · 2 CONFIRMED VIA WEB") */
  verification_summary?: string | null;
  /** True when Tier C web search (SerpAPI) was run for verification */
  used_web_search?: boolean;
}

export interface RouteTypePromptResponse {
  needs_route_type: true;
  intent: string;
  duration: number;
  message: string;
  options: { value: string; label: string }[];
}

export interface EdgeCaseResponse {
  edge_case: true;
  message: string;
  suggestion?: string;
  intent: string;
  theme_name?: string;
}

export type RouteApiResponse = RoutesResponse | DurationPromptResponse | PlaceOptionsResponse | RouteTypePromptResponse | EdgeCaseResponse;

export function isDurationPrompt(
  data: RouteApiResponse
): data is DurationPromptResponse {
  if (data == null || typeof data !== "object") return false;
  const needsDuration = (data as unknown as Record<string, unknown>).needs_duration;
  return needsDuration === true || needsDuration === "true";
}

export function isPlaceOptionsResponse(
  data: RouteApiResponse
): data is PlaceOptionsResponse {
  const r = data as unknown as Record<string, unknown>;
  return "place_options" in data && Array.isArray(r.place_options) && (r.place_options as unknown[]).length > 0 && !("recommended" in data);
}

export function isRouteTypePrompt(
  data: RouteApiResponse
): data is RouteTypePromptResponse {
  return "needs_route_type" in data && (data as unknown as Record<string, unknown>).needs_route_type === true;
}

export function isEdgeCaseResponse(
  data: RouteApiResponse
): data is EdgeCaseResponse {
  return "edge_case" in data && (data as unknown as Record<string, unknown>).edge_case === true;
}

const ROUTE_NOT_FOUND_MSG = "Couldn't find a walkable route — try a closer destination.";

export type PreflightResponse = {
  actionType: "place_search" | "route" | "loop_route";
  pattern: string;
  intent: string;
};

export async function getRoute(
  origin: [number, number],
  moodText: string,
  options?: { signal?: AbortSignal; forceNightMode?: boolean; preflight?: boolean }
): Promise<RouteApiResponse | PreflightResponse> {
  const body: Record<string, unknown> = {
    origin,
    moodText: moodText.trim(),
  };
  if (options?.forceNightMode === true) body.forceNightMode = true;
  if (options?.preflight === true) body.preflight = true;
  const res = await fetch("/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    const message = res.status === 400 && err?.error ? err.error : res.status === 400 ? ROUTE_NOT_FOUND_MSG : err.error || `Route API error: ${res.status}`;
    throw new Error(message);
  }

  const data = await res.json();

  // Preflight: only parse result for loading message
  if (data && data.actionType != null && (data.actionType === "place_search" || data.actionType === "route" || data.actionType === "loop_route")) {
    return {
      actionType: data.actionType,
      pattern: data.pattern ?? "mood_only",
      intent: data.intent ?? "calm",
    } as PreflightResponse;
  }

  // Check edge case first (no route, special UI message)
  if (data && data.edge_case === true) {
    return {
      edge_case: true,
      message: data.message ?? "",
      suggestion: data.suggestion,
      intent: data.intent ?? "calm",
      theme_name: data.theme_name,
    } as EdgeCaseResponse;
  }

  // Duration prompt: API asks for duration before generating route. Must be checked BEFORE recommended — this response has no route.
  const needsDuration = data && ((data as Record<string, unknown>).needs_duration === true || (data as Record<string, unknown>).needs_duration === "true");
  if (needsDuration) {
    const defaultOptions = [
      { label: "5 – 15 min", value: 10 },
      { label: "15 – 45 min", value: 30 },
      { label: "30 min – 1.5 hrs", value: 60 },
      { label: "Surprise me", value: 0 },
    ];
    return {
      needs_duration: true,
      intent: data.intent ?? "calm",
      message: data.message ?? "How long do you want to walk?",
      options: Array.isArray(data.options) ? data.options : defaultOptions,
      skip_duration: data.skip_duration === true,
      auto_duration: typeof data.auto_duration === "number" && Number.isFinite(data.auto_duration) ? data.auto_duration : undefined,
    };
  }

  // Place selection (multiple destinations)
  if (data.needs_place_selection === true && Array.isArray(data.place_options) && data.place_options.length > 0) {
    const ext = data as {
      place_selection_heading?: string;
      fallback_message?: string | null;
      verification_method?: string;
      qualifier_searched?: string | null;
      sort_label?: string | null;
      verification_summary?: string | null;
    };
    console.log("[routing] Place options response - sort_label:", ext.sort_label, "fallback_message:", ext.fallback_message, "verification_summary:", ext.verification_summary);
    return {
      place_options: data.place_options,
      intent: (data.intent as Intent) ?? "calm",
      place_selection_heading: ext.place_selection_heading,
      fallback_message: ext.fallback_message ?? null,
      verification_method: ext.verification_method,
      qualifier_searched: ext.qualifier_searched ?? null,
      sort_label: ext.sort_label ?? null,
      verification_summary: ext.verification_summary ?? null,
    } as PlaceOptionsResponse;
  }

  // Full route response must have recommended coordinates; otherwise treat as error (only after ruling out duration/place prompts)
  if (!data.recommended?.coordinates?.length) {
    throw new Error(ROUTE_NOT_FOUND_MSG);
  }
  return {
    recommended: data.recommended,
    quick: data.quick,
    destination_name: data.destination_name ?? null,
    destination_address: data.destination_address ?? null,
    destination_photo: data.destination_photo ?? null,
    pattern: data.pattern ?? "mood_only",
    intent: data.intent ?? undefined,
    isLoop: data.is_loop === true || data.isLoop === true,
    place_options: Array.isArray(data.place_options) ? data.place_options : undefined,
  };
}

export async function getRouteWithDuration(
  origin: [number, number],
  moodText: string,
  durationMinutes: number,
  options?: { signal?: AbortSignal; forceNightMode?: boolean; retryCount?: number }
): Promise<RoutesResponse> {
  const body: Record<string, unknown> = {
    origin,
    moodText: moodText.trim(),
    duration: durationMinutes,
  };
  if (options?.forceNightMode === true) body.forceNightMode = true;
  if (typeof options?.retryCount === "number") body.retry_count = options.retryCount;

  const res = await fetch("/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    const message = res.status === 400 && err?.error ? err.error : res.status === 400 ? ROUTE_NOT_FOUND_MSG : err.error || `Route API error: ${res.status}`;
    throw new Error(message);
  }

  const data = await res.json();
  if (data.needs_duration === true) {
    throw new Error("Expected route response, got duration prompt");
  }
  if (!data.recommended?.coordinates?.length) throw new Error(ROUTE_NOT_FOUND_MSG);
  return {
    recommended: data.recommended,
    quick: data.quick,
    destination_name: data.destination_name ?? null,
    destination_address: data.destination_address ?? null,
    destination_photo: data.destination_photo ?? null,
    pattern: data.pattern ?? "mood_only",
    intent: data.intent ?? undefined,
    isLoop: data.is_loop === true || data.isLoop === true,
    place_options: Array.isArray(data.place_options) ? data.place_options : undefined,
    end_point: Array.isArray(data.end_point) && data.end_point.length >= 2 ? [Number(data.end_point[0]), Number(data.end_point[1])] : undefined,
  };
}

export async function getRouteWithDestination(
  origin: [number, number],
  destination: [number, number],
  intent: Intent,
  options?: { destination_name?: string; destination_address?: string; destination_place_type?: string | null; signal?: AbortSignal; forceNightMode?: boolean }
): Promise<RoutesResponse> {
  const body: Record<string, unknown> = {
    origin,
    destination,
    intent,
    moodText: null,
    destination_name: options?.destination_name ?? null,
    destination_address: options?.destination_address ?? null,
    destination_place_type: options?.destination_place_type ?? null,
  };
  if (options?.forceNightMode === true) body.forceNightMode = true;
  const res = await fetch("/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!res.ok) {
    if (res.status === 400) throw new Error(ROUTE_NOT_FOUND_MSG);
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || `Route API error: ${res.status}`);
  }

  const data = await res.json();
  if (data.needs_duration === true) {
    throw new Error("Expected route response, got duration prompt");
  }
  if (!data.recommended?.coordinates?.length) throw new Error(ROUTE_NOT_FOUND_MSG);
  return {
    recommended: data.recommended,
    quick: data.quick,
    destination_name: data.destination_name ?? null,
    destination_address: data.destination_address ?? null,
    destination_photo: data.destination_photo ?? null,
    pattern: data.pattern ?? "mood_only",
    intent: data.intent ?? undefined,
    isLoop: data.is_loop === true || data.isLoop === true,
    place_options: Array.isArray(data.place_options) ? data.place_options : undefined,
    default_is_fastest: data.default_is_fastest === true,
  };
}

/** Initial bearing in degrees (0–360) from start toward a point ~200m into the route. Coords are [lng, lat] (GeoJSON). */
export function getInitialBearing(coords: [number, number][]): number {
  if (!coords?.length || coords.length < 2) return 0;
  const start = coords[0];
  const lookAhead = coords[Math.min(10, coords.length - 1)];
  const startLng = start[0];
  const startLat = start[1];
  const endLng = lookAhead[0];
  const endLat = lookAhead[1];
  const dLng = ((endLng - startLng) * Math.PI) / 180;
  const lat1 = (startLat * Math.PI) / 180;
  const lat2 = (endLat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/** Map bearing (0–360) to a short direction label. */
export function bearingToDirection(bearing: number): string {
  const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return dirs[Math.round(bearing / 45) % 8];
}
