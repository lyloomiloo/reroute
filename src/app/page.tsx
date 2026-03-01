"use client";

import { useState, useEffect, useRef, Suspense, Fragment } from "react";
import Image from "next/image";
import PhoneFrame from "@/components/PhoneFrame";
import MapView from "@/components/MapView";
import {
  getRoute,
  getRouteWithDuration,
  getRouteWithDestination,
  type RoutesResponse,
  type RouteHighlight,
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

/** Distance in meters between two points (Haversine). */
function getDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
  const [placeOptionsHeading, setPlaceOptionsHeading] = useState<string>("CHOOSE A PLACE");
  const [placeOptionsFallbackMessage, setPlaceOptionsFallbackMessage] = useState<string | null>(null);
  const [placeOptionsSortLabel, setPlaceOptionsSortLabel] = useState<string | null>(null);
  const [placeOptionsVerificationSummary, setPlaceOptionsVerificationSummary] = useState<string | null>(null);
  const [placeOptionsQualifierSearched, setPlaceOptionsQualifierSearched] = useState<string | null>(null);
  const [placeOptionsShownCount, setPlaceOptionsShownCount] = useState(5);
  const [placeOptionsIntent, setPlaceOptionsIntent] = useState<Intent | null>(null);
  const [placeOptionsFocusedIndex, setPlaceOptionsFocusedIndex] = useState(0);
  const [lastPlaceQuery, setLastPlaceQuery] = useState<{ origin: [number, number]; moodText: string } | null>(null);
  const [loadingMorePlaces, setLoadingMorePlaces] = useState(false);
  const [loadingDots, setLoadingDots] = useState(1);
  const [loadingPhase, setLoadingPhase] = useState(0);
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
  const [showDestinationDetail, setShowDestinationDetail] = useState(false);
  /** Last mood text used to fetch current route; used by "Try another" for mood_and_area and mood_only. */
  const [lastRouteMoodText, setLastRouteMoodText] = useState<string>("");
  /** Last duration (minutes) used for mood_only route; used by "Try another" to re-request with same duration. */
  const [lastRouteDurationMinutes, setLastRouteDurationMinutes] = useState<number | null>(null);
  /** Destination POI from place selection (GO); used for pin popup. Cleared when route is dismissed or new search. */
  const [destinationPhoto, setDestinationPhoto] = useState<string | null>(null);
  const [destinationDescription, setDestinationDescription] = useState<string | null>(null);
  const [destinationRating, setDestinationRating] = useState<number | null>(null);
  const [time, setTime] = useState(new Date());
  const [colonVisible, setColonVisible] = useState(true);
  const [isNavigating, setIsNavigating] = useState(false);
  const [remainingDistance, setRemainingDistance] = useState<string>("—");
  const [remainingTime, setRemainingTime] = useState<string>("—");
  const [hasArrived, setHasArrived] = useState(false);
  /** Dev/QA: force night mode for testing (Raval avoid, safe corridors) without changing time. */
  const [nightModeOverride, setNightModeOverride] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userPositionRef = useRef<{ lat: number; lng: number } | null>(null);
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

  useEffect(() => {
    if (!isLoading) {
      setLoadingDots(1);
      setLoadingPhase(0);
      return;
    }
    const dotInterval = setInterval(() => {
      setLoadingDots((prev) => (prev >= 3 ? 1 : prev + 1));
    }, 500);
    const phase1 = setTimeout(() => setLoadingPhase(1), 3000);
    const phase2 = setTimeout(() => setLoadingPhase(2), 6000);
    return () => {
      clearInterval(dotInterval);
      clearTimeout(phase1);
      clearTimeout(phase2);
    };
  }, [isLoading]);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
    };
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
    setPlaceOptionsHeading("CHOOSE A PLACE");
    setPlaceOptionsFallbackMessage(null);
    setPlaceOptionsSortLabel(null);
    setPlaceOptionsVerificationSummary(null);
    setPlaceOptionsQualifierSearched(null);
    setPlaceOptionsShownCount(5);
    setLastPlaceQuery(null);
    setEdgeCaseMessage(null);
    setEdgeCaseSuggestion(null);
    setEdgeCaseTheme(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
    try {
      const result = await getRoute(origin, text, { signal: controller.signal, forceNightMode: nightModeOverride });
      console.log("[frontend] API response keys:", Object.keys(result));
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
          const routeResult = await getRouteWithDuration(origin, text, duration, { signal: controller.signal, forceNightMode: nightModeOverride });
          clearTimeout(timeout);
          setRoutes(routeResult as RoutesResponse);
          setDestinationPhoto((routeResult as RoutesResponse).destination_photo ?? null);
          setLastRouteMoodText(text);
          setLastRouteDurationMinutes(duration);
          setShowQuick(false);
        } else {
          clearTimeout(timeout);
          const options = Array.isArray(durationResult.options) && durationResult.options.length > 0
            ? durationResult.options
            : [
                { label: "5 – 15 min", value: 10 },
                { label: "15 – 45 min", value: 30 },
                { label: "30 min – 1.5 hrs", value: 60 },
                { label: "Surprise me", value: 0 },
              ];
          setDurationPrompt({
            intent: durationResult.intent ?? "calm",
            message: durationResult.message ?? "How long do you want to walk?",
            options,
          });
          setRoutes(null);
          clearDestinationInfo();
        }
      } else if (isPlaceOptionsResponse(result)) {
        clearTimeout(timeout);
        console.log("[frontend] Route response:", result.sort_label, result.fallback_message);
        setPlaceOptions(result.place_options);
        setPlaceOptionsHeading(result.place_selection_heading ?? "CHOOSE A PLACE");
        setPlaceOptionsFallbackMessage(result.fallback_message ?? null);
        setPlaceOptionsSortLabel(result.sort_label ?? null);
        setPlaceOptionsVerificationSummary(result.verification_summary ?? null);
        setPlaceOptionsQualifierSearched((result as { detected_qualifier?: string | null }).detected_qualifier ?? result.qualifier_searched ?? null);
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
        setDestinationPhoto((result as RoutesResponse).destination_photo ?? null);
        setLastRouteMoodText(text);
        setLastRouteDurationMinutes(null);
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
    setPlaceOptionsHeading("CHOOSE A PLACE");
    setPlaceOptionsFallbackMessage(null);
    setPlaceOptionsSortLabel(null);
    setPlaceOptionsVerificationSummary(null);
    setPlaceOptionsQualifierSearched(null);
    setPlaceOptionsShownCount(5);
    setPlaceOptionsIntent(null);
    setPlaceOptionsFocusedIndex(0);
    setLastPlaceQuery(null);
  };

  const handleLoadMore = async () => {
    if (!lastPlaceQuery || loadingMorePlaces) return;
    const moodText = (lastPlaceQuery as { moodText?: string }).moodText ?? "";
    const excludeIds = placeOptions?.map((p) => (p as { place_id?: string | null }).place_id ?? p.name).filter(Boolean) ?? [];
    console.log("[frontend] Refresh / Load more clicked, re-sending:", moodText, "offset:", placeOptions?.length ?? 0, "exclude_place_ids:", excludeIds.length);
    setLoadingMorePlaces(true);
    setLoadingDots(1);
    setLoadingPhase(0);
    setIsLoading(true);
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...lastPlaceQuery,
          search_offset: placeOptions?.length ?? 0,
          exclude_place_ids: excludeIds,
        }),
      });
      const data = await res.json();
      if (Array.isArray(data.place_options) && data.place_options.length > 0) {
        setPlaceOptions((prev) => [...(prev ?? []), ...data.place_options]);
      }
      if (data.sort_label != null && String(data.sort_label).trim() !== "") setPlaceOptionsSortLabel(data.sort_label);
      if (data.fallback_message != null) setPlaceOptionsFallbackMessage(data.fallback_message);
      if (data.verification_summary != null) setPlaceOptionsVerificationSummary(data.verification_summary);
      if (data.detected_qualifier != null || data.qualifier_searched != null) {
        setPlaceOptionsQualifierSearched(data.detected_qualifier ?? data.qualifier_searched ?? null);
      }
    } catch (e) {
      console.error("Load more places error:", e);
    } finally {
      setLoadingMorePlaces(false);
      setIsLoading(false);
    }
  };

  const handleTryAnotherRoute = async () => {
    if (!lastRouteMoodText.trim() || !routes) return;
    if (routes.pattern !== "mood_and_area" && routes.pattern !== "mood_only") return;
    setIsLoading(true);
    setRouteError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
    try {
      if (routes.pattern === "mood_only") {
        const duration = lastRouteDurationMinutes ?? 30;
        const routeResult = await getRouteWithDuration(origin, lastRouteMoodText, duration, {
          signal: controller.signal,
          forceNightMode: nightModeOverride,
          retryCount: 1,
        });
        clearTimeout(timeout);
        setRoutes(routeResult);
        setDestinationPhoto(routeResult.destination_photo ?? null);
      } else {
        const result = await getRoute(origin, lastRouteMoodText, { signal: controller.signal, forceNightMode: nightModeOverride });
        clearTimeout(timeout);
        if (isEdgeCaseResponse(result) || isDurationPrompt(result) || isPlaceOptionsResponse(result)) return;
        setRoutes(result as RoutesResponse);
        setDestinationPhoto((result as RoutesResponse).destination_photo ?? null);
      }
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
      const result = await getRouteWithDuration(origin, moodInput, minutes, { signal: controller.signal, forceNightMode: nightModeOverride });
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
      setDestinationPhoto((result as RoutesResponse).destination_photo ?? null);
      setLastRouteMoodText(moodInput);
      setLastRouteDurationMinutes(minutes);
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
    setPlaceOptionsHeading("CHOOSE A PLACE");
    setPlaceOptionsFallbackMessage(null);
    setPlaceOptionsSortLabel(null);
    setPlaceOptionsVerificationSummary(null);
    setPlaceOptionsQualifierSearched(null);
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
    setPlaceOptionsHeading("CHOOSE A PLACE");
    setPlaceOptionsFallbackMessage(null);
    setPlaceOptionsSortLabel(null);
    setPlaceOptionsVerificationSummary(null);
    setPlaceOptionsQualifierSearched(null);
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
        forceNightMode: nightModeOverride,
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
      setDestinationPhoto(place.photo_url ?? null);
      setRoutes({
        ...result,
        destination_name: place.name,
        destination_address: place.description ?? null,
        destination_photo: place.photo_url ?? null,
      });
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
  const destinationAddress = routes?.destination_address ?? null;

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
      {/* Dev/QA: night mode toggle — remove or hide behind feature flag for production */}
      <button
        type="button"
        onClick={() => setNightModeOverride((v) => !v)}
        className="fixed top-2 right-2 z-50 bg-black/80 text-white text-[10px] px-2 py-1 rounded font-mono"
        aria-label={nightModeOverride ? "Switch to day mode" : "Switch to night mode"}
      >
        {nightModeOverride ? "🌙 NIGHT" : "☀️ DAY"}
      </button>
      {toastMessage && (
        <div
          className="fixed bottom-24 left-4 right-4 z-[60] bg-black text-white font-mono text-sm text-center py-3 px-4 rounded-lg shadow-lg"
          role="alert"
          aria-live="polite"
        >
          {toastMessage}
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
          {/* Map fills remaining space; nav bar above map when navigating */}
          <div className="flex-1 relative overflow-hidden flex flex-col min-h-0 bg-[#f0f0f0]">
            {isNavigating && routes && (
              <div className="flex-shrink-0 bg-white px-4 py-2 border-b border-gray-100 flex justify-between items-start z-[1000]">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-gray-400">FROM: {customStart?.name ?? "Current Location"}</p>
                  <p className="font-mono font-bold text-base truncate">{destinationName ?? routes.destination_name ?? "Walk"}</p>
                  <p className="font-mono text-sm text-gray-400">
                    ~{remainingTime} left · {remainingDistance}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsNavigating(false)}
                  className="font-mono text-lg mt-1 flex-shrink-0"
                  aria-label="Exit navigation"
                >
                  ✕
                </button>
              </div>
            )}
            <div className="flex-1 relative min-h-0">
            {isLoading && (
              <div className="absolute inset-0 bg-white/80 z-[50] flex flex-col items-center justify-center">
                <pre className="loading-walker text-[10px] leading-[1.2] text-black font-mono whitespace-pre text-center" aria-hidden>
{`  *
 /|\\
 / \\
`}
                </pre>
                <p className="mt-2 font-mono text-xs text-gray-400 lowercase tracking-wide">
                  {loadingPhase === 0
                    ? "searching reviews..."
                    : loadingPhase === 1
                      ? "searching the web..."
                      : "almost there..."}
                </p>
              </div>
            )}
              <MapView
                center={customStart?.coords ?? mapCenter ?? BARCELONA_CENTER}
                zoom={DEFAULT_ZOOM}
                flyToCenter={customStart?.coords ?? null}
                customStartCoords={customStart?.coords ?? null}
              routeCoordinates={
                routes
                  ? showQuick && routes.quick
                    ? routes.quick.coordinates
                    : routes.recommended.coordinates
                  : undefined
              }
              alternativeRouteCoordinates={
                (() => {
                  const alt = routes?.quick;
                  const main = routes?.recommended;
                  const showAlternative =
                    alt &&
                    main &&
                    routes.pattern !== "mood_and_area" &&
                    Math.abs(alt.duration - main.duration) > 120 &&
                    Math.abs(alt.distance - main.distance) > 200;
                  return showAlternative
                    ? showQuick
                      ? main.coordinates
                      : alt.coordinates
                    : null;
                })()
              }
              highlights={routes ? (showQuick && routes.quick ? routes.quick.highlights : routes.recommended.highlights) : undefined}
              previewPois={
                routes && !isNavigating
                  ? (() => {
                      const active = showQuick && routes.quick ? routes.quick : routes.recommended;
                      return active?.pois?.length ? active.pois : null;
                    })()
                  : null
              }
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
              isNavigating={isNavigating}
              onExitNavigation={() => setIsNavigating(false)}
              initialNavCenter={routes ? origin : undefined}
              onRemainingUpdate={({ distance, time }) => {
                setRemainingDistance(distance);
                setRemainingTime(time);
              }}
              onArrived={() => setHasArrived(true)}
              isLoopRoute={routes?.isLoop ?? false}
              onUserPositionChange={(lat, lng) => {
                userPositionRef.current = { lat, lng };
              }}
            />
            {hasArrived && (
              <div className="absolute inset-0 z-[2000] bg-white flex flex-col items-center justify-center px-6 text-center">
                <pre className="font-mono text-lg leading-tight mb-6 text-center" style={{ letterSpacing: "2px" }}>
{`
 \\o/
  |
 / \\
`}
                </pre>
                <p className="font-mono font-bold text-3xl uppercase leading-none tracking-tighter mb-3">
                  YOU MADE IT!
                </p>
                <p className="font-mono text-sm text-gray-500 mb-1">
                  {destinationName ?? "Destination"}
                </p>
                <p className="font-mono text-xs text-gray-400 mb-8">
                  {routes ? formatDistance(showQuick && routes.quick ? routes.quick.distance : routes.recommended.distance) : "1.2 km"} walked · {routes?.intent ? [routes.intent].join(", ") : ""}
                </p>
                <div className="w-full border-t border-gray-100 pt-6 space-y-3">
                  <button
                    type="button"
                    onClick={() => {
                      setHasArrived(false);
                      setIsNavigating(false);
                    }}
                    className="w-full bg-black text-white font-mono font-bold text-sm py-4 rounded-lg uppercase tracking-wide"
                  >
                    DONE
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHasArrived(false);
                      setIsNavigating(false);
                      handleClearRoute();
                    }}
                    className="w-full bg-white text-black border border-gray-200 font-mono text-sm py-4 rounded-lg uppercase tracking-wide"
                  >
                    NEW WALK
                  </button>
                </div>
              </div>
            )}
            </div>
            {routes && !isNavigating && (
              <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-[0_-4px_20px_rgba(0,0,0,0.08)] px-4 pt-4 pb-6 z-[100] relative">
                <button
                  type="button"
                  onClick={handleClearRoute}
                  className="absolute top-4 right-4 text-gray-400 text-lg p-1 z-10 hover:text-black"
                  aria-label="Clear route"
                >
                  ×
                </button>
                <div className="max-w-md mx-auto">
                  {(() => {
                    const active = routes.quick && showQuick ? routes.quick : routes.recommended;
                    return (
                      <>
                        <p className="font-mono font-bold text-lg leading-tight uppercase pr-8">{(active.summary ?? "").replace(/^['"]|['"]$/g, "")}</p>
                        {routes.destination_name && (
                          routes.pattern === "mood_and_area" ? (
                            <p className="font-mono text-sm text-gray-500 mt-2">
                              WALK IN {routes.destination_name}
                            </p>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setShowDestinationDetail(true)}
                              className="flex items-center gap-1 group mt-2 text-left"
                            >
                              <span className="font-mono text-sm text-gray-500 reroute-uppercase">→</span>
                              <span className="font-mono text-sm text-gray-700 reroute-uppercase underline decoration-dashed decoration-gray-400 underline-offset-4 group-active:text-black">
                                {routes.destination_name}
                              </span>
                            </button>
                          )
                        )}
                        <p className="font-mono text-xs text-gray-400">
                          {formatDuration(active.duration)} · {formatDistance(active.distance)}
                        </p>
                        <p className="font-mono text-[9px] text-[#4A90D9] mt-2">
                          (RE)ROUTE IS IN BETA AND MAY MAKE SOME MISTAKES.
                        </p>
                        <div className="mt-4">
                            {routes.quick &&
                              (() => {
                                const alt = routes.quick;
                                const main = routes.recommended;
                                const showAlternative =
                                  main &&
                                  routes.pattern !== "mood_and_area" &&
                                  Math.abs(alt.duration - main.duration) > 120 &&
                                  Math.abs(alt.distance - main.distance) > 200;
                                return showAlternative ? (
                                  <div className="mb-2">
                                    {showQuick ? (
                                      <button
                                        type="button"
                                        onClick={() => setShowQuick(false)}
                                        className="text-base text-gray-600 underline reroute-uppercase"
                                      >
                                        {routes.default_is_fastest ? "Use fastest route" : getUseRouteLabel(routes.intent)}
                                      </button>
                                    ) : (
                                      <p className="text-base text-gray-500 reroute-uppercase">
                                        {routes.default_is_fastest
                                          ? `${getIntentRouteLabel(routes.intent)}: ${formatDuration(alt.duration)} — `
                                          : `Fastest route: ${formatDuration(alt.duration)} — `}
                                        <button
                                          type="button"
                                          onClick={() => setShowQuick(true)}
                                          className="text-foreground underline"
                                        >
                                          Switch
                                        </button>
                                      </p>
                                    )}
                                  </div>
                                ) : null;
                              })()}
                            <div className="flex gap-2">
                              {(routes.pattern === "mood_and_area" || routes.pattern === "mood_only") && lastRouteMoodText.trim() && (
                            <button
                              type="button"
                              onClick={handleTryAnotherRoute}
                              disabled={isLoading}
                              className="flex-1 py-3 border border-gray-300 text-gray-700 text-sm reroute-uppercase font-medium rounded-none hover:bg-gray-50 disabled:opacity-50"
                            >
                              ↻ Try another
                              </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                            const active = showQuick && routes?.quick ? routes.quick : routes?.recommended;
                            if (!active) return;
                            const routeCoords = active.coordinates;
                            if (customStart && routeCoords?.length > 0) {
                              const up = userPositionRef.current;
                              if (up) {
                                const routeStart = routeCoords[0] as [number, number];
                                const routeStartLat = routeStart[1];
                                const routeStartLng = routeStart[0];
                                const distanceToStart = getDistanceMeters(up.lat, up.lng, routeStartLat, routeStartLng);
                                if (distanceToStart > 500) {
                                  setToastMessage("You're too far from the start point. Get closer to start navigating.");
                                  if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
                                  toastTimeoutRef.current = setTimeout(() => {
                                    setToastMessage(null);
                                    toastTimeoutRef.current = null;
                                  }, 4000);
                                  return;
                                }
                              }
                            }
                            setRemainingDistance(formatDistance(active.distance));
                            setRemainingTime(formatDuration(active.duration));
                            setHasArrived(false);
                            setIsNavigating(true);
                                }}
                                className="flex-1 py-3 bg-black text-white text-base reroute-uppercase font-medium rounded-none"
                              >
                                Let&apos;s go
                              </button>
                            </div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
            {showDestinationDetail && (
              <div
                className="fixed inset-0 z-[200] flex items-end justify-center bg-black/30"
                onClick={() => setShowDestinationDetail(false)}
                role="dialog"
                aria-modal="true"
                aria-label="Destination details"
              >
                <div
                  className="w-full max-w-md bg-white rounded-t-2xl p-5"
                  onClick={(e) => e.stopPropagation()}
                >
                  {destinationPhotoResolved && (
                    <img
                      src={destinationPhotoResolved}
                      alt=""
                      className="w-full h-32 object-cover rounded-lg mb-3"
                    />
                  )}
                  <p className="font-mono font-bold text-lg">{destinationName ?? "Destination"}</p>
                  {destinationAddress && (
                    <p className="font-mono text-sm text-gray-500 mt-1">{destinationAddress}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setShowDestinationDetail(false);
                      handleClearRoute();
                      moodInputRef.current?.focus();
                    }}
                    className="w-full mt-4 py-3 border border-black rounded-lg font-mono text-sm reroute-uppercase text-center"
                  >
                    Change destination
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* BOTTOM: Input section — hidden during navigation; fixed for iOS keyboard */}
          {!isNavigating && (
          <div className="fixed bottom-0 left-0 right-0 z-10 bg-white px-3 pt-3 border-t border-gray-100 ios-search-bar" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
            {/* Headline: hidden when section is fixed at top (any input focused) */}
            <div
              className={`overflow-hidden transition-all duration-200 ${
                headlineVisible && !inputFocused && !startInputFocused ? "opacity-100 mb-1" : "opacity-0 h-0 mb-0 pointer-events-none"
              }`}
            >
              <h1 className="font-mono font-bold text-[1.443rem] leading-none uppercase tracking-tighter whitespace-nowrap" style={{ wordSpacing: "-0.12em" }}>
                WHAT ARE YOU IN THE MOOD FOR?
              </h1>
            </div>
            <div className="flex gap-2 items-center">
              <div className="flex-1 min-w-0 relative">
                <input
                  ref={moodInputRef}
                  type="text"
                  placeholder="Type your vibe..."
                  className="w-full bg-transparent border-0 border-b border-gray-300 py-2 pr-8 font-mono text-sm font-normal text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-black transition-colors"
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
                      setPlaceOptionsHeading("CHOOSE A PLACE");
                      setPlaceOptionsFallbackMessage(null);
                      setPlaceOptionsSortLabel(null);
                      setPlaceOptionsVerificationSummary(null);
                      setPlaceOptionsQualifierSearched(null);
                      setPlaceOptionsShownCount(5);
                    }
                    setTimeout(() => {
                      e.target.scrollIntoView({ behavior: "smooth", block: "center" });
                    }, 300);
                  }}
                  onBlur={() => {
                    window.scrollTo(0, 0);
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
            <p className="mt-1 font-mono text-[9.2px] font-normal text-gray-400 max-w-full break-words" style={{ letterSpacing: "-0.02em" }} aria-hidden>
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
                    setPlaceOptionsHeading("CHOOSE A PLACE");
                    setPlaceOptionsFallbackMessage(null);
                    setPlaceOptionsSortLabel(null);
                    setPlaceOptionsVerificationSummary(null);
                    setPlaceOptionsQualifierSearched(null);
                    setPlaceOptionsShownCount(5);
                  }}
                  className="group inline-flex items-center gap-1.5 py-0.5 font-mono text-xs font-normal tracking-wide text-[#4A90D9]/70 hover:text-[#4A90D9] reroute-uppercase whitespace-nowrap"
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
                      className="shrink-0 text-[#4A90D9]/70 hover:text-[#4A90D9]"
                      aria-label="Clear starting point"
                    >
                      ×
                    </span>
                  ) : (
                    <svg className="shrink-0 w-3 h-3 text-[#4A90D9]/70 stroke-[1.5] group-hover:stroke-2 transition-[stroke]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  )}
                </button>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 flex-wrap font-mono text-xs font-normal tracking-wide text-[#4A90D9]/70">
                    <span className="reroute-uppercase shrink-0">From:</span>
            <input
                      type="text"
                      placeholder="e.g. Plaça Catalunya"
                      className="flex-1 min-w-[120px] bg-transparent border-0 border-b border-[#4A90D9]/80 py-1 pr-1 text-xs text-[#4A90D9]/80 placeholder:text-[#4A90D9]/70 focus:outline-none focus:border-[#4A90D9] font-mono"
                      value={startPointInput}
                      onChange={(e) => setStartPointInput(e.target.value)}
                      onFocus={() => setStartInputFocused(true)}
                      onBlur={() => {
                        window.scrollTo(0, 0);
                        setTimeout(() => setStartInputFocused(false), 200);
                      }}
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
                      className="shrink-0 font-mono text-xs hover:text-[#4A90D9] disabled:opacity-40 reroute-uppercase"
                    >
                      {startPointGeocoding ? "…" : "Set"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setStartPointExpanded(false)}
                      className="shrink-0 font-mono text-xs hover:text-[#4A90D9] leading-none p-0.5"
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
                          className="mt-1.5 text-left text-[11.2px] text-green-700 reroute-uppercase hover:text-green-800 hover:underline cursor-pointer py-3 px-4"
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
                              className={`text-left text-[11.2px] py-3 px-4 rounded border reroute-uppercase transition-colors ${
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
                    {/* Headline — either generated summary or default */}
                    <h2 className="font-mono font-bold text-lg tracking-tight uppercase">
                      {placeOptionsSortLabel ?? placeOptionsHeading ?? "CHOOSE A PLACE"}
                    </h2>
                    <button
                      type="button"
                      onClick={dismissPlaceOptions}
                      className="text-gray-400 hover:text-black"
                      aria-label="Close place selection"
                    >
                      ✕
                    </button>
                  </div>
                  {/* Subtitle — fallback message or beta disclaimer (count headline removed) */}
                  {placeOptionsFallbackMessage ? (
                    <p className="font-mono text-xs text-blue-400 uppercase tracking-wide">
                      {placeOptionsFallbackMessage}
                    </p>
                  ) : (
                    <p className="font-mono text-xs text-blue-400 uppercase tracking-wide">
                      BETA · RESULTS MAY NOT BE PERFECT · CHECK REVIEWS
                    </p>
                  )}

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
                      const showAlsoNearbyDivider =
                        !place.qualifierVerified && i > 0 && placeOptions[i - 1]?.qualifierVerified === true;
                      return (
                        <Fragment key={i}>
                          {showAlsoNearbyDivider && (
                            <div className="flex items-center w-full px-2 my-2 flex-shrink-0 snap-start">
                              <div className="flex-1 h-px bg-gray-200" />
                              <span className="font-mono text-[10px] text-gray-400 px-2 uppercase">also nearby</span>
                              <div className="flex-1 h-px bg-gray-200" />
                            </div>
                          )}
                          <div
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
                            <div className="font-mono font-bold text-sm truncate">
                              {place.name}
                            </div>
                            {place.qualifierVerified && (place.qualifierReason || placeOptionsQualifierSearched) && (
                              <span className="font-mono text-[10px] text-green-600 uppercase">
                                ✓ {place.qualifierReason ?? `${placeOptionsQualifierSearched} mentioned in ${place.qualifierSource === "web" ? "web results" : "reviews"}`}
                              </span>
                            )}
                            {!place.qualifierVerified && placeOptionsQualifierSearched && (
                              <span className="font-mono text-[10px] text-gray-400 uppercase">
                                {place.qualifierReason ?? `nearby · not confirmed for ${placeOptionsQualifierSearched}`}
                              </span>
                            )}
                            <div className="flex items-end gap-2 mt-1 flex-1">
                              <div className="flex-1 min-w-0">
                                <div className="font-mono text-[10px] text-gray-400">
                                  {place.rating != null && (
                                    <span>{place.rating.toFixed(1)} ★ · </span>
                                  )}
                                </div>
                                <div className="font-mono text-[10px] text-gray-500 line-clamp-3">
                                  {place.description ? place.description.replace(/\.$/, "") : null}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleRouteToPlace(place)}
                                className="bg-black text-white font-mono font-normal text-sm px-4 py-2 rounded flex-shrink-0 hover:opacity-90"
                              >
                                GO
                              </button>
                            </div>
                          </div>
                        </div>
                        </Fragment>
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
          )}
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
