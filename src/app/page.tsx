"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import Image from "next/image";
import PhoneFrame from "@/components/PhoneFrame";
import MapView from "@/components/MapView";
import {
  getRoute,
  getRouteWithDuration,
  getRouteWithDestination,
  type RoutesResponse,
  type PlaceOption,
  type Intent,
  type DurationPromptResponse,
  isDurationPrompt,
  isPlaceOptionsResponse,
  isEdgeCaseResponse,
} from "@/lib/routing";
import { isInBarcelona, type GeocodeResult } from "@/lib/geocoding";

const BARCELONA_CENTER: [number, number] = [41.3874, 2.1686];
const DEFAULT_ZOOM = 15;

/** Human-readable route label for the switch (e.g. "EXPLORER ROUTE"). Used when the alternative is mood-weighted. */
const INTENT_ROUTE_LABELS: Record<string, string> = {
  calm: "CALMER ROUTE",
  discover: "EXPLORER ROUTE",
  nature: "NATURE ROUTE",
  scenic: "SCENIC ROUTE",
  lively: "LIVELY ROUTE",
  exercise: "ACTIVE ROUTE",
  cafe: "COFFEE-STOP ROUTE",
  themed_walk: "EXPLORER ROUTE",
  // quick / no mood: generic pleasant alternative
  quick: "SCENIC ROUTE",
};

function getIntentRouteLabel(intent: string | undefined): string {
  if (!intent) return "SCENIC ROUTE";
  return INTENT_ROUTE_LABELS[intent] ?? "SCENIC ROUTE";
}

/** "Use [x] route" for the back button when viewing the fastest alternative (e.g. "Use calmer route"). */
function getUseRouteLabel(intent: string | undefined): string {
  const label = getIntentRouteLabel(intent).replace(/\s*ROUTE\s*$/i, "").toLowerCase();
  return label ? `Use ${label} route` : "Use recommended route";
}

/** Shorten start-location address for the FROM line: prefer place name (before first comma), cap length. */
function shortStartLabel(name: string): string {
  const key = name.split(",")[0]?.trim() || name.trim();
  const max = 28;
  if (key.length <= max) return key;
  return key.slice(0, max - 1).trim() + "…";
}

/** Format duration in seconds: show "X min" or "Xh Ym" when > 59 min. */
function formatDuration(seconds: number): string {
  const totalMins = Math.round(seconds / 60);
  if (totalMins <= 59) return `${totalMins} min`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m} min`;
}

/** Format distance in meters: show "X m" or "X.X km" when > 999 m. */
function formatDistance(meters: number): string {
  if (meters <= 999) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km % 1 === 0 ? km : km.toFixed(1)} km`;
}

function PageContent() {
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);
  const [moodInput, setMoodInput] = useState("");
  const [routes, setRoutes] = useState<RoutesResponse | null>(null);
  const [showQuick, setShowQuick] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [durationPrompt, setDurationPrompt] = useState<{
    intent: string;
    message: string;
    options: { label: string; value: number }[];
  } | null>(null);
  const [placeOptions, setPlaceOptions] = useState<PlaceOption[] | null>(null);
  const [placeOptionsShownCount, setPlaceOptionsShownCount] = useState(5);
  const [placeOptionsIntent, setPlaceOptionsIntent] = useState<Intent | null>(null);
  const [placeOptionsFocusedIndex, setPlaceOptionsFocusedIndex] = useState(0);
  const [lastPlaceQuery, setLastPlaceQuery] = useState<{ origin: [number, number]; moodText: string } | null>(null);
  const [loadingMorePlaces, setLoadingMorePlaces] = useState(false);
  const placeOptionsScrollRef = useRef<HTMLDivElement>(null);
  const [customStart, setCustomStart] = useState<{ coords: [number, number]; name: string } | null>(null);
  const [startPointExpanded, setStartPointExpanded] = useState(false);
  const [startPointInput, setStartPointInput] = useState("");
  const [startPointGeocoding, setStartPointGeocoding] = useState(false);
  const [startPointResults, setStartPointResults] = useState<GeocodeResult[] | null>(null);
  const [startPointSelectedIndex, setStartPointSelectedIndex] = useState(0);
  const [startPointSearchDone, setStartPointSearchDone] = useState(false);
  const [startPointError, setStartPointError] = useState<string | null>(null);
  const [startInputFocused, setStartInputFocused] = useState(false);
  const [moodInputFocused, setMoodInputFocused] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const moodInputClickedRef = useRef(false);
  const [edgeCaseMessage, setEdgeCaseMessage] = useState<string | null>(null);
  const [edgeCaseSuggestion, setEdgeCaseSuggestion] = useState<string | null>(null);
  const [edgeCaseTheme, setEdgeCaseTheme] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  /** Last mood text used to fetch current route; used by "Try another route" for mood_and_area. */
  const [lastRouteMoodText, setLastRouteMoodText] = useState<string>("");
  /** Destination POI from place selection (GO); used for pin popup. Cleared when route is dismissed or new search. */
  const [destinationPhoto, setDestinationPhoto] = useState<string | null>(null);
  const [destinationDescription, setDestinationDescription] = useState<string | null>(null);
  const [destinationRating, setDestinationRating] = useState<number | null>(null);
  const [time, setTime] = useState(new Date());
  const [colonVisible, setColonVisible] = useState(true);
  const moodInputRef = useRef<HTMLInputElement | null>(null);

  const ROUTE_TIMEOUT_MS = 30000;
  const ROUTE_NOT_FOUND_MSG = "Couldn't find a walkable route — try a closer destination.";
  const ROUTE_TIMEOUT_MSG = "Route took too long — try a closer destination.";

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const blink = setInterval(() => setColonVisible((v) => !v), 500);
    return () => clearInterval(blink);
  }, []);

  /** Theme names for which we show "SURPRISE ME" in the edge-case popup. */
  const EDGE_CASE_SURPRISE_THEMES = ["need_nudge", "avoidance_only", "surprise_me"];
  const showSurpriseMeButton = edgeCaseTheme != null && EDGE_CASE_SURPRISE_THEMES.includes(edgeCaseTheme);

  useEffect(() => {
    if (typeof window === "undefined" || !window.navigator?.geolocation) return;
    window.navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          setMapCenter([latitude, longitude]);
        }
      },
      () => setMapCenter(BARCELONA_CENTER),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, []);

  // Debounced Google Places search for start (fuzzy match, e.g. "placa cat" → Plaça Catalunya)
  useEffect(() => {
    if (!startPointExpanded) return;
    const q = startPointInput.trim();
    if (!q) {
      setStartPointResults(null);
      setStartPointSearchDone(false);
      setStartPointError(null);
      return;
    }
    const t = setTimeout(async () => {
      setStartPointGeocoding(true);
      setStartPointSearchDone(false);
      setStartPointError(null);
      try {
        const res = await fetch("/api/search-place", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, limit: 3 }),
        });
        const data = (await res.json()) as { places?: { lat: number; lng: number; name: string }[] };
        const places = data.places ?? [];
        const results: GeocodeResult[] = places.map((p) => ({ lat: p.lat, lng: p.lng, displayName: p.name }));
        setStartPointResults(results);
        setStartPointSelectedIndex(0);
        setStartPointSearchDone(true);
      } catch {
        setStartPointResults([]);
        setStartPointSearchDone(true);
      } finally {
        setStartPointGeocoding(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [startPointExpanded, startPointInput]);

  const origin = customStart?.coords ?? mapCenter ?? BARCELONA_CENTER;

  const handleMoodSubmit = async (overrideMoodText?: string) => {
    const text = overrideMoodText ?? moodInput;
    setInputFocused(false);
    setIsLoading(true);
    setRouteError(null);
    setDurationPrompt(null);
    setPlaceOptions(null);
    setPlaceOptionsShownCount(5);
    setLastPlaceQuery(null);
    setEdgeCaseMessage(null);
    setEdgeCaseSuggestion(null);
    setEdgeCaseTheme(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
    try {
      const result = await getRoute(origin, text, { signal: controller.signal });
      if (isEdgeCaseResponse(result)) {
        clearTimeout(timeout);
        setEdgeCaseMessage(result.message);
        setEdgeCaseSuggestion(result.suggestion ?? null);
        setEdgeCaseTheme(result.theme_name ?? null);
        return;
      }
      if (isDurationPrompt(result)) {
        const durationResult = result as DurationPromptResponse;
        if (durationResult.skip_duration) {
          const duration =
            durationResult.auto_duration ?? [10, 20, 40][Math.floor(Math.random() * 3)];
          const routeResult = await getRouteWithDuration(origin, text, duration, { signal: controller.signal });
          clearTimeout(timeout);
          setRoutes(routeResult as RoutesResponse);
          setLastRouteMoodText(text);
          setShowQuick(false);
        } else {
          clearTimeout(timeout);
          setDurationPrompt({
            intent: result.intent,
            message: result.message,
            options: result.options,
          });
          setRoutes(null);
          clearDestinationInfo();
        }
      } else if (isPlaceOptionsResponse(result)) {
        clearTimeout(timeout);
        setPlaceOptions(result.place_options);
        setPlaceOptionsShownCount(Math.min(5, result.place_options.length));
        setPlaceOptionsIntent(result.intent);
        setPlaceOptionsFocusedIndex(0);
        setLastPlaceQuery({ origin, moodText: text });
        setRoutes(null);
        clearDestinationInfo();
      } else {
        clearTimeout(timeout);
        console.log(
          "[frontend] highlights received:",
          JSON.stringify(
            (result as RoutesResponse).recommended?.highlights?.map((h) => ({
              name: h.name,
              photoRefs: (h as { photoRefs?: string[] }).photoRefs?.length,
              photo_urls: (h as { photo_urls?: string[] }).photo_urls?.length,
            }))
          )
        );
        setRoutes(result as RoutesResponse);
        setLastRouteMoodText(text);
        setShowQuick(false);
      }
    } catch (err) {
      console.error("Route error:", err);
      const e = err as Error & { name?: string };
      setRouteError(e?.name === "AbortError" ? ROUTE_TIMEOUT_MSG : (e?.message || ROUTE_NOT_FOUND_MSG));
    } finally {
      clearTimeout(timeout);
      setIsLoading(false);
    }
  };

  const dismissPlaceOptions = () => {
    setPlaceOptions(null);
    setPlaceOptionsShownCount(5);
    setPlaceOptionsIntent(null);
    setPlaceOptionsFocusedIndex(0);
    setLastPlaceQuery(null);
  };

  const handleLoadMore = async () => {
    if (!lastPlaceQuery || loadingMorePlaces) return;
    setLoadingMorePlaces(true);
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...lastPlaceQuery,
          search_offset: placeOptions?.length ?? 0,
        }),
      });
      const data = await res.json();
      if (Array.isArray(data.place_options) && data.place_options.length > 0) {
        setPlaceOptions((prev) => [...(prev ?? []), ...data.place_options]);
      }
    } catch (e) {
      console.error("Load more places error:", e);
    } finally {
      setLoadingMorePlaces(false);
    }
  };

  const handleTryAnotherRoute = async () => {
    if (!lastRouteMoodText.trim() || !routes || routes.pattern !== "mood_and_area") return;
    setIsLoading(true);
    setRouteError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
    try {
      const result = await getRoute(origin, lastRouteMoodText, { signal: controller.signal });
      clearTimeout(timeout);
      if (isEdgeCaseResponse(result) || isDurationPrompt(result) || isPlaceOptionsResponse(result)) return;
      setRoutes(result as RoutesResponse);
    } catch (err) {
      clearTimeout(timeout);
      const e = err as Error & { name?: string };
      setRouteError(e?.name === "AbortError" ? ROUTE_TIMEOUT_MSG : (e?.message || ROUTE_NOT_FOUND_MSG));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDurationPick = async (minutes: number) => {
    if (!durationPrompt) return;
    setIsLoading(true);
    setDurationPrompt(null);
    setRouteError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
    try {
      const result = await getRouteWithDuration(origin, moodInput, minutes, { signal: controller.signal });
      console.log(
        "[frontend] highlights received:",
        JSON.stringify(
          result.recommended?.highlights?.map((h) => ({
            name: h.name,
            photoRefs: (h as { photoRefs?: string[] }).photoRefs?.length,
            photo_urls: (h as { photo_urls?: string[] }).photo_urls?.length,
          }))
        )
      );
      setRoutes(result as RoutesResponse);
      setLastRouteMoodText(moodInput);
      setShowQuick(false);
    } catch (err) {
      console.error("Route error:", err);
      const e = err as Error & { name?: string };
      setRouteError(e?.name === "AbortError" ? ROUTE_TIMEOUT_MSG : (e?.message || ROUTE_NOT_FOUND_MSG));
    } finally {
      clearTimeout(timeout);
      setIsLoading(false);
    }
  };

  const clearDestinationInfo = () => {
    setDestinationPhoto(null);
    setDestinationDescription(null);
    setDestinationRating(null);
  };

  const handleClearRoute = () => {
    setRoutes(null);
    setPlaceOptions(null);
    setPlaceOptionsShownCount(5);
    setMoodInput("");
    setLastRouteMoodText("");
    clearDestinationInfo();
    setDurationPrompt(null);
    setEdgeCaseMessage(null);
    setEdgeCaseSuggestion(null);
    setEdgeCaseTheme(null);
    setRouteError(null);
  };

  const handleDismissEdgeCase = () => {
    setEdgeCaseMessage(null);
    setEdgeCaseSuggestion(null);
    setEdgeCaseTheme(null);
    moodInputRef.current?.focus();
  };

  const handleSurpriseMeFromEdgeCase = () => {
    handleDismissEdgeCase();
    void handleMoodSubmit("surprise me");
  };

  const handleSetStartPoint = async () => {
    const q = startPointInput.trim();
    if (!q) {
      setStartPointExpanded(false);
      setStartPointError(null);
      return;
    }
    const useCached =
      startPointResults &&
      startPointResults.length > 0 &&
      startPointSelectedIndex >= 0 &&
      startPointSelectedIndex < startPointResults.length;
    if (useCached) {
      const r = startPointResults[startPointSelectedIndex];
      if (!isInBarcelona(r.lat, r.lng)) {
        setStartPointError("Start point must be within Barcelona.");
        return;
      }
      setStartPointError(null);
      setCustomStart({ coords: [r.lat, r.lng], name: r.displayName });
      setStartPointInput("");
      setStartPointResults(null);
      setStartPointExpanded(false);
      return;
    }
    setStartPointGeocoding(true);
    setStartPointError(null);
    try {
      const res = await fetch("/api/search-place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q + " Barcelona", limit: 1 }),
      });
      const data = (await res.json()) as { places?: { lat: number; lng: number; name: string }[] };
      const places = data.places ?? [];
      if (places.length > 0) {
        const p = places[0];
        if (!isInBarcelona(p.lat, p.lng)) {
          setStartPointError("Start point must be within Barcelona.");
          return;
        }
        setCustomStart({ coords: [p.lat, p.lng], name: p.name });
        setStartPointInput("");
        setStartPointExpanded(false);
      } else {
        setStartPointError("Start point must be within Barcelona.");
      }
    } finally {
      setStartPointGeocoding(false);
    }
  };

  const applyStartPointResult = (r: GeocodeResult) => {
    if (!isInBarcelona(r.lat, r.lng)) {
      setStartPointError("Start point must be within Barcelona.");
      return;
    }
    setStartPointError(null);
    setCustomStart({ coords: [r.lat, r.lng], name: r.displayName });
    setStartPointInput("");
    setStartPointResults(null);
    setStartPointExpanded(false);
  };

  const clearCustomStart = () => {
    setCustomStart(null);
    setStartPointInput("");
    setStartPointExpanded(false);
    setStartPointResults(null);
    setStartPointError(null);
  };

  const handleRouteToPlace = async (place: PlaceOption) => {
    if (!placeOptionsIntent) return;
    const destination: [number, number] = [place.lat, place.lng];
    setDestinationPhoto(place.photo_url ?? null);
    setDestinationDescription(place.description ?? null);
    setDestinationRating(place.rating ?? null);
    console.log("[Route here] selected place coordinates:", { lat: place.lat, lng: place.lng, name: place.name });
    setIsLoading(true);
    setPlaceOptions(null);
    setPlaceOptionsShownCount(5);
    setRouteError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
    try {
      const result = await getRouteWithDestination(origin, destination, placeOptionsIntent, {
        destination_name: place.name,
        destination_address: place.description ?? undefined,
        destination_place_type: place.primary_type ?? undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const destHighlight = result.recommended?.highlights?.find((h) => h.type === "destination");
      const highlightPhoto = destHighlight?.photo_url ?? destHighlight?.photo_urls?.[0];
      if (!place.photo_url && highlightPhoto) setDestinationPhoto(highlightPhoto);
      console.log(
        "[frontend] highlights received:",
        JSON.stringify(
          result.recommended?.highlights?.map((h) => ({
            name: h.name,
            photoRefs: (h as { photoRefs?: string[] }).photoRefs?.length,
            photo_urls: (h as { photo_urls?: string[] }).photo_urls?.length,
          }))
        )
      );
      setRoutes({ ...result, destination_name: place.name, destination_address: place.description ?? null });
      setShowQuick(false);
    } catch (err) {
      console.error("Route error:", err);
      const e = err as Error & { name?: string };
      setRouteError(e?.name === "AbortError" ? ROUTE_TIMEOUT_MSG : (e?.message || ROUTE_NOT_FOUND_MSG));
    } finally {
      clearTimeout(timeout);
      setIsLoading(false);
    }
  };

  const headlineVisible = !moodInputFocused && moodInput.length === 0;

  const activeHighlights = routes ? (showQuick && routes.quick ? routes.quick.highlights : routes.recommended.highlights) : undefined;
  const destinationHighlight = activeHighlights?.find((h) => h.type === "destination");
  const destinationName = routes?.destination_name ?? destinationHighlight?.name ?? destinationHighlight?.label;
  const destinationPhotoResolved = destinationPhoto ?? destinationHighlight?.photo_url ?? destinationHighlight?.photo_urls?.[0];

  const appContent = (
      <PhoneFrame>
      {!startInputFocused && (
        <div className="fixed top-2 left-2 z-40 bg-white/40 border border-gray-300 px-0.5 pt-0 pb-0.5">
          <span className="font-mono text-[10px] text-gray-600 tracking-wider" aria-live="polite">
            {time.toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Europe/Madrid",
            }).replace(":", colonVisible ? ":" : " ")}
          </span>
        </div>
      )}
      <div className="h-[100dvh] flex flex-col bg-[#f0f0f0]">
        <>
          {/* Edge-case centered modal */}
          {edgeCaseMessage && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50" aria-modal="true" role="dialog" aria-labelledby="edge-case-title">
              <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full px-5 py-5 font-mono border border-gray-200">
                <p id="edge-case-title" className="text-sm text-foreground reroute-uppercase font-medium leading-snug">
                  {edgeCaseMessage}
                </p>
                <div className="mt-4 flex gap-3">
                  <button
                    type="button"
                    onClick={handleDismissEdgeCase}
                    className="flex-1 py-2.5 text-xs font-medium reroute-uppercase border border-gray-300 text-gray-800 hover:bg-gray-50 rounded-none"
                  >
                    Back
                  </button>
                  {showSurpriseMeButton && (
                    <button
                      type="button"
                      onClick={handleSurpriseMeFromEdgeCase}
                      className="flex-1 py-2.5 text-xs font-medium reroute-uppercase bg-black text-white hover:opacity-90 rounded-none"
                    >
                      Surprise me
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {/* Map fills remaining space; route results overlay at bottom */}
          <div className="flex-1 relative overflow-hidden flex flex-col min-h-0 bg-[#f0f0f0]">
            {isLoading && (
              <div className="absolute inset-0 bg-white/80 z-[50] flex flex-col items-center justify-center">
                <pre className="loading-walker text-[10px] leading-[1.2] text-black font-mono whitespace-pre text-center" aria-hidden>
{`  *
 /|\\
 / \\
`}
                </pre>
                <p className="mt-2 text-sm text-gray-600 font-mono">loading walk</p>
        </div>
            )}
              <MapView
                center={mapCenter ?? BARCELONA_CENTER}
                zoom={DEFAULT_ZOOM}
              routeCoordinates={
                routes
                  ? showQuick && routes.quick
                    ? routes.quick.coordinates
                    : routes.recommended.coordinates
                  : undefined
              }
              highlights={routes ? (showQuick && routes.quick ? routes.quick.highlights : routes.recommended.highlights) : undefined}
              endPoint={routes?.end_point}
              destinationName={destinationName}
              destinationDescription={destinationDescription}
              destinationRating={destinationRating}
              destinationPhoto={destinationPhotoResolved}
              routeIntent={routes?.intent}
              placeOptions={placeOptions}
              placeOptionsFocusedIndex={placeOptions?.length ? placeOptionsFocusedIndex : undefined}
              origin={origin}
              showUserLocation={!customStart}
              onPlaceSelect={placeOptions?.length ? handleRouteToPlace : undefined}
            />
            {routes && (
              <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-[0_-4px_20px_rgba(0,0,0,0.08)] px-4 pt-4 pb-6 z-[100]">
                <div className="max-w-md mx-auto relative">
                  <button
                    type="button"
                    onClick={handleClearRoute}
                    className="absolute top-3 right-0 w-8 h-8 flex items-center justify-center text-gray-500 hover:text-black font-mono text-xl leading-none"
                    style={{ top: 12, right: 16 }}
                    aria-label="Clear route"
                  >
                    ×
                  </button>
                  {(() => {
                    const active = routes.quick && showQuick ? routes.quick : routes.recommended;
                    return (
                      <>
                        <p className="text-sm text-foreground reroute-uppercase font-medium pr-10">{active.summary}</p>
                        {routes.destination_name && (
                          <p className="text-xs text-gray-600 mt-1 reroute-uppercase">
                            {routes.pattern === "mood_and_area"
                              ? `WALK IN ${routes.destination_name}`
                              : `→ ${routes.destination_name}`}
                          </p>
                        )}
                        <p className="text-xs text-gray-500 mt-1 reroute-uppercase">
                          {formatDuration(active.duration)} · {formatDistance(active.distance)}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-1 font-mono tracking-wide">
                          BETA · ROUTES ARE AI-GENERATED AND MAY HAVE ERRORS
                        </p>
                        <div className="mt-3 pt-3 border-t border-gray-100">
                            {routes.quick && !routes.routes_are_similar && routes.pattern !== "mood_and_area" && (
                              showQuick ? (
                                <button
                                  type="button"
                                  onClick={() => setShowQuick(false)}
                                  className="text-xs text-gray-600 underline reroute-uppercase"
                                >
                                  {routes.default_is_fastest ? "Use fastest route" : getUseRouteLabel(routes.intent)}
                                </button>
                              ) : (
                                <p className="text-xs text-gray-500 reroute-uppercase">
                                  {routes.default_is_fastest
                                    ? `${getIntentRouteLabel(routes.intent)}: ${formatDuration(routes.quick.duration)} — `
                                    : `Fastest route: ${formatDuration(routes.quick.duration)} — `}
                                  <button
                                    type="button"
                                    onClick={() => setShowQuick(true)}
                                    className="text-foreground underline"
                                  >
                                    Switch
                                  </button>
                                </p>
                              )
                            )}
                        </div>
                        <div className="mt-4 flex gap-2">
                          {routes.pattern === "mood_and_area" && lastRouteMoodText.trim() && (
                            <button
                              type="button"
                              onClick={handleTryAnotherRoute}
                              disabled={isLoading}
                              className="flex-1 py-3 border border-gray-300 text-gray-700 text-xs reroute-uppercase font-medium rounded-none hover:bg-gray-50 disabled:opacity-50"
                            >
                              ↻ Try another route
                            </button>
                          )}
                          <button
                            type="button"
                            className="flex-1 py-3 bg-black text-white text-sm reroute-uppercase font-medium rounded-none"
                          >
                            Let&apos;s go
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>

          {/* BOTTOM: Input section — flex-shrink-0 so keyboard shrinks map, not this */}
          <div className="flex-shrink-0 z-10 bg-white px-4 pt-3 pb-[env(safe-area-inset-bottom)] border-t border-gray-100">
            {/* Headline: hidden when section is fixed at top (any input focused) */}
            <div
              className={`overflow-hidden transition-all duration-200 ${
                headlineVisible && !inputFocused && !startInputFocused ? "opacity-100 mb-1" : "opacity-0 h-0 mb-0 pointer-events-none"
              }`}
            >
              <h1
                className="font-mono font-bold text-lg text-black reroute-uppercase leading-tight line-clamp-2"
                style={{ fontSize: "clamp(22px, 5.5vw, 36px)", letterSpacing: "-0.05em", wordSpacing: "-0.2em", lineHeight: 0.95 }}
              >
                What are you in the mood for?
              </h1>
            </div>
            <div className="flex gap-2 items-center">
              <div className="flex-1 min-w-0 relative">
                <input
                  ref={moodInputRef}
                  type="text"
                  placeholder="Type your vibe..."
                  className="w-full bg-transparent border-0 border-b border-gray-300 py-2 pr-8 text-sm font-normal text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-black transition-colors"
                  value={moodInput}
                  onChange={(e) => setMoodInput(e.target.value)}
                  onPointerDown={() => {
                    moodInputClickedRef.current = true;
                  }}
                  onFocus={(e) => {
                    setInputFocused(true);
                    setMoodInputFocused(true);
                    if (moodInputClickedRef.current) {
                      moodInputClickedRef.current = false;
                      setRoutes(null);
                      clearDestinationInfo();
                      setDurationPrompt(null);
                      setPlaceOptions(null);
                      setPlaceOptionsShownCount(5);
                    }
                    setTimeout(() => {
                      e.target.scrollIntoView({ behavior: "smooth", block: "center" });
                    }, 300);
                  }}
                  onBlur={() => {
                    setMoodInputFocused(false);
                    setTimeout(() => setInputFocused(false), 200);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleMoodSubmit();
                    }
                  }}
                />
                {moodInput.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setMoodInput("")}
                    className="absolute right-0 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-600 rounded-full"
                    aria-label="Clear input"
                  >
                    ×
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleMoodSubmit()}
                className="shrink-0 w-10 h-10 bg-black text-white flex items-center justify-center text-lg hover:opacity-90 rounded-none"
                aria-label="Go"
              >
                →
              </button>
            </div>
            <p className="mt-1 text-[10px] text-gray-400 whitespace-nowrap overflow-hidden text-ellipsis" style={{ letterSpacing: "-0.02em" }} aria-hidden>
              e.g. calm walk by the beach, architecture hunt in Eixample.
            </p>
            {routeError && (
              <p className="mt-1.5 text-[10px] text-red-600 reroute-uppercase" role="alert">
                {routeError}
              </p>
            )}
            {/* Current location: secondary, footnote-style — same indent as above */}
            <div className="mt-1.5">
              {!startPointExpanded ? (
                <button
                  type="button"
                  onClick={() => {
                    if (customStart) return;
                    setStartPointExpanded(true);
                    setStartPointError(null);
                    setRoutes(null);
                    clearDestinationInfo();
                    setDurationPrompt(null);
                    setPlaceOptions(null);
                    setPlaceOptionsShownCount(5);
                  }}
                  className="group inline-flex items-center gap-1.5 py-0.5 text-[10px] text-blue-600/70 hover:text-blue-500 hover:font-bold reroute-uppercase tracking-wider whitespace-nowrap"
                  aria-expanded={false}
                  aria-label={customStart ? "Starting point" : "Change starting point"}
                >
                  <span className="min-w-0 truncate" title={customStart?.name}>
                    {customStart ? `FROM: ${shortStartLabel(customStart.name)}` : "FROM: CURRENT LOCATION"}
                  </span>
                  {customStart ? (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        clearCustomStart();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          clearCustomStart();
                        }
                      }}
                      className="shrink-0 text-blue-600/70 hover:text-blue-500"
                      aria-label="Clear starting point"
                    >
                      ×
                    </span>
                  ) : (
                    <svg className="shrink-0 w-3 h-3 text-blue-600/70 stroke-[1.5] group-hover:stroke-2 transition-[stroke]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  )}
                </button>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 flex-wrap text-blue-600/70 text-[10px]">
                    <span className="reroute-uppercase tracking-wider shrink-0">From:</span>
            <input
                      type="text"
                      placeholder="e.g. Plaça Catalunya"
                      className="flex-1 min-w-[120px] bg-transparent border-0 border-b border-blue-300/80 py-1 pr-1 text-[10px] text-blue-600/80 placeholder:text-blue-600/70 focus:outline-none focus:border-blue-500 font-mono"
                      value={startPointInput}
                      onChange={(e) => setStartPointInput(e.target.value)}
                      onFocus={() => setStartInputFocused(true)}
                      onBlur={() => setTimeout(() => setStartInputFocused(false), 200)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSetStartPoint();
                        if (e.key === "Escape") setStartPointExpanded(false);
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handleSetStartPoint}
                      disabled={startPointGeocoding || !startPointInput.trim()}
                      className="shrink-0 text-[10px] hover:text-blue-500 disabled:opacity-40 reroute-uppercase"
                    >
                      {startPointGeocoding ? "…" : "Set"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setStartPointExpanded(false)}
                      className="shrink-0 hover:text-blue-500 text-[10px] leading-none p-0.5"
                      aria-label="Cancel"
                    >
                      ×
                    </button>
                  </div>
                  {/* Address confirmation / autocomplete below input */}
                  {startPointGeocoding && (
                    <p className="mt-1.5 text-[10px] text-gray-500 reroute-uppercase">Searching…</p>
                  )}
                  {startPointError && (
                    <p className="mt-1.5 text-[10px] text-red-600 reroute-uppercase">{startPointError}</p>
                  )}
                  {!startPointGeocoding && startPointSearchDone && startPointResults !== null && !startPointError && (
                    <>
                      {startPointResults.length === 0 ? (
                        <p className="mt-1.5 text-[10px] text-red-600 reroute-uppercase">
                          Start point must be within Barcelona.
                        </p>
                      ) : startPointResults.length === 1 ? (
                        <button
                          type="button"
                          onClick={() => applyStartPointResult(startPointResults[0])}
                          className="mt-1.5 text-left text-[10px] text-green-700 reroute-uppercase hover:text-green-800 hover:underline cursor-pointer"
                        >
                          ✓ {startPointResults[0].displayName}
                        </button>
                      ) : (
                        <div className="mt-1.5 flex flex-col gap-0.5">
                          <p className="text-[10px] text-gray-500 reroute-uppercase">Pick an address:</p>
                          {startPointResults.map((r, i) => (
                            <button
                              key={`${r.lat}-${r.lng}`}
                              type="button"
                              onClick={() => applyStartPointResult(r)}
                              className={`text-left text-[10px] py-1 px-1.5 rounded border reroute-uppercase transition-colors ${
                                startPointSelectedIndex === i
                                  ? "border-green-600 bg-green-50 text-green-800"
                                  : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                              }`}
                            >
                              ✓ {r.displayName}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
            {durationPrompt && (
                <div className="mt-4">
                  <p className="text-sm text-gray-600 mb-2 reroute-uppercase">{durationPrompt.message}</p>
                  <div className="flex flex-wrap gap-2">
                    {durationPrompt.options.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handleDurationPick(opt.value)}
                        className={`px-4 py-2 rounded-none text-sm transition-colors reroute-uppercase ${
                          opt.value === 0
                            ? "bg-black text-white hover:opacity-90"
                            : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
          </div>
        )}
              {placeOptions && placeOptions.length > 0 && (
                <div className="px-4 py-3">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-mono text-xs font-bold tracking-wider uppercase">
                      Choose a place
                    </span>
                    <button
                      type="button"
                      onClick={dismissPlaceOptions}
                      className="text-gray-400 hover:text-black"
                      aria-label="Close place selection"
                    >
                      ✕
                    </button>
                  </div>
                  <p className="text-[10px] text-blue-400 mt-0.5 mb-2 font-mono tracking-wide">
                    BETA · RESULTS MAY NOT BE PERFECT · CHECK REVIEWS
                  </p>

                  <div
                    ref={placeOptionsScrollRef}
                    className="flex overflow-x-auto gap-3 pb-2 scrollbar-hide snap-x snap-mandatory px-4"
                  >
                    {placeOptions.map((place, i) => {
                      const photoUrls = place.photo_urls?.length
                        ? place.photo_urls
                        : place.photo_url
                          ? [place.photo_url]
                          : [];
                      return (
                        <div
                          key={i}
                          className="w-[240px] flex-shrink-0 snap-start flex flex-col rounded-lg border border-gray-200 bg-white overflow-hidden"
                        >
                          {photoUrls.length > 0 && (
                            <div className="relative w-full h-32 overflow-hidden rounded-t-lg flex-shrink-0">
                              <div className="flex overflow-x-auto h-32 scrollbar-hide snap-x snap-mandatory w-full">
                                {photoUrls.map((url, j) => (
                                  <Image
                                    key={j}
                                    src={url}
                                    alt=""
                                    width={400}
                                    height={300}
                                    className="w-full h-32 flex-shrink-0 object-cover rounded-t-lg snap-start"
                                    unoptimized
                                  />
                                ))}
                              </div>
                              {photoUrls.length > 1 && (
                                <>
                                  <div
                                    className="absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center bg-gradient-to-r from-black/30 to-transparent pointer-events-none"
                                    aria-hidden
                                  >
                                    <span className="text-white text-sm">‹</span>
                                  </div>
                                  <div
                                    className="absolute right-0 top-0 bottom-0 w-6 flex items-center justify-center bg-gradient-to-l from-black/30 to-transparent pointer-events-none"
                                    aria-hidden
                                  >
                                    <span className="text-white text-sm">›</span>
                                  </div>
                                </>
                              )}
                            </div>
                          )}

                          <div className="flex flex-col flex-1 p-3">
                            <div className="font-bold text-sm truncate">
                              {place.name}
                            </div>
                            <div className="flex items-end gap-2 mt-1 flex-1">
                              <div className="flex-1 min-w-0">
                                <div className="text-xs text-gray-400">
                                  {place.rating != null && (
                                    <span>{place.rating.toFixed(1)} ★ · </span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500 line-clamp-2">
                                  {place.description ? place.description.replace(/\.$/, "") : null}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleRouteToPlace(place)}
                                className="bg-black text-white text-xs font-bold px-4 py-2 rounded flex-shrink-0 hover:opacity-90"
                              >
                                GO
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    <div className="flex-shrink-0 w-20 snap-start flex items-center justify-center">
                      <button
                        type="button"
                        onClick={handleLoadMore}
                        disabled={loadingMorePlaces || !lastPlaceQuery}
                        className="font-mono text-xs text-gray-400 hover:text-black disabled:opacity-50"
                        aria-label="Load more places"
                      >
                        {loadingMorePlaces ? "…" : "↻"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
      </div>
    </PhoneFrame>
    );

  return appContent;
}

export default function Home() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PageContent />
    </Suspense>
  );
}
