"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { MapContainer, TileLayer, Marker, Polyline, Popup, Tooltip, CircleMarker, useMap } from "react-leaflet";
import L from "leaflet";
import type { LatLngExpression } from "leaflet";
import type { RouteHighlight, PlaceOption } from "@/lib/routing";
import {
  GEOLOCATION_OPTIONS,
  handleGeolocationError,
} from "@/lib/geolocation";

/** 10px purple dot for POI highlights; photos shown in card on tap. */
const POI_DOT_ICON = L.divIcon({
  html: `<div style="width:10px;height:10px;border-radius:50%;background:#8B7FE8;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.2);cursor:pointer;"></div>`,
  className: "custom-pin-no-default",
  iconSize: [10, 10],
  iconAnchor: [5, 5],
});

/** Semi-transparent polyline color per route intent. themed_walk uses discover (purple). */
const ROUTE_INTENT_COLORS: Record<string, { color: string; opacity: number }> = {
  calm: { color: "rgb(134, 169, 134)", opacity: 0.6 },
  nature: { color: "rgb(76, 135, 76)", opacity: 0.6 },
  scenic: { color: "rgb(210, 130, 110)", opacity: 0.6 },
  discover: { color: "rgb(140, 110, 180)", opacity: 0.6 },
  lively: { color: "rgb(220, 170, 70)", opacity: 0.6 },
  exercise: { color: "rgb(70, 160, 160)", opacity: 0.6 },
  cafe: { color: "rgb(170, 130, 100)", opacity: 0.6 },
  quick: { color: "rgb(100, 100, 100)", opacity: 0.6 },
  themed_walk: { color: "rgb(140, 110, 180)", opacity: 0.6 },
};
const DEFAULT_ROUTE_COLOR = { color: "rgb(74, 124, 89)", opacity: 0.8 };

/**
 * At zoom 15, ~0.0025° lat ≈ 280m. Setting view center north of user so the blue dot
 * appears in the visual center of the map (above the bottom input panel ~30–35% of screen).
 */
const CENTER_OFFSET_LAT = 0.0025;

function MapCenterUpdater({
  center,
  zoom,
  skipWhenPlaceOptions,
  skipWhenNavigating,
}: {
  center: LatLngExpression;
  zoom: number;
  skipWhenPlaceOptions?: boolean;
  skipWhenNavigating?: boolean;
}) {
  const map = useMap();
  const setViewCountRef = useRef(0);
  useEffect(() => {
    if (skipWhenPlaceOptions || skipWhenNavigating) return;
    if (setViewCountRef.current < 2) {
      const [lat, lng] = Array.isArray(center) ? center : [center.lat, center.lng];
      const viewLat = lat + CENTER_OFFSET_LAT;
      map.setView([viewLat, lng], zoom, { animate: false });
      setViewCountRef.current += 1;
    }
  }, [map, center, zoom, skipWhenPlaceOptions, skipWhenNavigating]);
  return null;
}

/** When flyToCenter is set (custom FROM), fly to it at zoom 15. When cleared, fly to center (GPS). */
function FlyToCenterOnChange({
  center,
  flyToCenter,
  skipWhenPlaceOptions,
  skipWhenNavigating,
}: {
  center: LatLngExpression;
  flyToCenter?: [number, number] | null;
  skipWhenPlaceOptions?: boolean;
  skipWhenNavigating?: boolean;
}) {
  const map = useMap();
  const prevFlyToCenterRef = useRef<[number, number] | null | undefined>(undefined);
  useEffect(() => {
    if (skipWhenPlaceOptions || skipWhenNavigating) return;
    if (flyToCenter != null) {
      map.flyTo([flyToCenter[0], flyToCenter[1]], 15, { duration: 0.8 });
      prevFlyToCenterRef.current = flyToCenter;
    } else if (prevFlyToCenterRef.current != null) {
      const [lat, lng] = Array.isArray(center) ? center : [center.lat, center.lng];
      map.flyTo([lat, lng], 15, { duration: 0.8 });
      prevFlyToCenterRef.current = null;
    }
  }, [map, center, flyToCenter, skipWhenPlaceOptions, skipWhenNavigating]);
  return null;
}

function FitRouteBounds({
  routeCoordinates,
  isNavigating,
}: {
  routeCoordinates?: [number, number][];
  isNavigating?: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    if (isNavigating || !routeCoordinates?.length) return;
    const positions: L.LatLngExpression[] = routeCoordinates.map(
      ([lng, lat]) => [lat, lng] as [number, number]
    );
    const bounds = L.latLngBounds(positions);
    if (!isNavigating) {
      map.fitBounds(bounds, {
        paddingTopLeft: [40, 40],
        paddingBottomRight: [40, 180],
      });
    }
  }, [map, routeCoordinates, isNavigating]);
  return null;
}

function FitPlaceOptionsBounds({
  placeOptions,
  origin,
  isNavigating,
}: {
  placeOptions?: Array<{ lat: number; lng: number }>;
  origin?: [number, number];
  isNavigating?: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    if (isNavigating || !placeOptions?.length) return;
    const points: L.LatLngExpression[] = placeOptions.map((p) => [p.lat, p.lng] as [number, number]);
    if (origin?.length === 2) points.push([origin[0], origin[1]]);
    const bounds = L.latLngBounds(points);
    if (!isNavigating) {
      map.fitBounds(bounds, {
        paddingTopLeft: [40, 40],
        paddingBottomRight: [40, 180],
        maxZoom: 15,
      });
    }
  }, [map, placeOptions, origin, isNavigating]);
  return null;
}

function PanToFocusedPlace({
  placeOptions,
  focusedIndex,
}: {
  placeOptions?: Array<{ lat: number; lng: number }>;
  focusedIndex?: number;
}) {
  const map = useMap();
  const prevIndexRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!placeOptions?.length || focusedIndex == null || focusedIndex < 0 || focusedIndex >= placeOptions.length)
      return;
    if (prevIndexRef.current === undefined) {
      prevIndexRef.current = focusedIndex;
      return;
    }
    if (prevIndexRef.current === focusedIndex) return;
    prevIndexRef.current = focusedIndex;
    const p = placeOptions[focusedIndex];
    if (p) map.setView([p.lat, p.lng], map.getZoom(), { animate: true, duration: 0.3 });
  }, [map, placeOptions, focusedIndex]);
  return null;
}

function NavigationMapController({
  isNavigating,
  userPosition,
  initialNavCenter,
  routeCoordinates,
  center,
  zoom,
}: {
  isNavigating: boolean;
  userPosition: { lat: number; lng: number } | null;
  initialNavCenter?: [number, number];
  routeCoordinates?: [number, number][];
  center: LatLngExpression;
  zoom: number;
}) {
  const map = useMap();
  const prevNavigatingRef = useRef(false);
  useEffect(() => {
    if (!isNavigating) {
      if (prevNavigatingRef.current) {
        prevNavigatingRef.current = false;
        if (!isNavigating && routeCoordinates?.length) {
          const positions: L.LatLngExpression[] = routeCoordinates.map(
            ([lng, lat]) => [lat, lng] as [number, number]
          );
          map.fitBounds(L.latLngBounds(positions), {
            paddingTopLeft: [40, 40],
            paddingBottomRight: [40, 180],
          });
        } else if (!isNavigating) {
          const [lat, lng] = Array.isArray(center) ? center : [center.lat, center.lng];
          map.setView([lat, lng], zoom, { animate: true });
        }
      }
      return;
    }
    prevNavigatingRef.current = true;
    const latLng = userPosition
      ? [userPosition.lat, userPosition.lng]
      : initialNavCenter;
    if (!latLng) return;
    const [lat, lng] = latLng;
    const t = setTimeout(() => {
      map.flyTo([lat, lng], 15, {
        duration: 1.0,
        easeLinearity: 0.25,
      });
    }, 100);
    return () => clearTimeout(t);
  }, [isNavigating, map, userPosition, initialNavCenter]);
  return null;
}

/** During navigation, detect when user position leaves the visible map bounds and report so the recenter button can show. */
function NavigationOffScreenDetector({
  isNavigating,
  userPosition,
  onOffScreenChange,
}: {
  isNavigating: boolean;
  userPosition: { lat: number; lng: number } | null;
  onOffScreenChange: (offScreen: boolean) => void;
}) {
  const map = useMap();
  useEffect(() => {
    if (!isNavigating || !userPosition) {
      onOffScreenChange(false);
      return;
    }
    const check = () => {
      const bounds = map.getBounds();
      const visible = bounds.contains([userPosition.lat, userPosition.lng]);
      onOffScreenChange(!visible);
    };
    check();
    map.on("moveend", check);
    return () => {
      map.off("moveend", check);
    };
  }, [isNavigating, userPosition?.lat, userPosition?.lng, map, onOffScreenChange]);
  return null;
}

/** Recenter button: only visible during navigation when user is off-screen. Flies to user at zoom 15. */
function NavigationRecenterButton({
  isNavigating,
  showRecenter,
  userPosition,
  onRecenter,
}: {
  isNavigating: boolean;
  showRecenter: boolean;
  userPosition: { lat: number; lng: number } | null;
  onRecenter: () => void;
}) {
  const map = useMap();
  if (!isNavigating || !showRecenter || !userPosition) return null;
  return (
    <button
      type="button"
      onClick={() => {
        map.flyTo([userPosition.lat, userPosition.lng], 15, { duration: 0.5 });
        onRecenter();
      }}
      className="fixed bottom-32 right-4 z-[450] bg-black text-white w-10 h-10 rounded-full flex items-center justify-center shadow-lg text-lg font-mono"
      aria-label="Recenter on my position"
    >
      ◎
    </button>
  );
}

function MapZoomControls() {
  const map = useMap();
  return (
    <div
      className="absolute top-3 right-3 flex flex-col border-2 border-black bg-white z-[400]"
      style={{ borderRadius: 0 }}
    >
      <button
        type="button"
        onClick={() => map.zoomIn()}
        className="w-9 h-9 flex items-center justify-center text-black font-mono text-lg border-b border-black"
        style={{ borderRadius: 0 }}
        aria-label="Zoom in"
      >
        +
      </button>
      <button
        type="button"
        onClick={() => map.zoomOut()}
        className="w-9 h-9 flex items-center justify-center text-black font-mono text-lg"
        style={{ borderRadius: 0 }}
        aria-label="Zoom out"
      >
        −
      </button>
    </div>
  );
}

const TILE_URL =
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

// Remove default Leaflet marker styles so our divIcon shows correctly
L.Icon.Default.mergeOptions({
  iconUrl: "",
  iconRetinaUrl: "",
  shadowUrl: "",
  iconSize: [0, 0],
  iconAnchor: [0, 0],
});

const USER_LOCATION_ICON = L.divIcon({
  html: `<div class="user-location-dot" style="width:11px;height:11px;border-radius:50%;background:#4A90D9;box-shadow:0 0 0 3px rgba(74,144,217,0.4);animation:user-location-pulse 2s ease-in-out infinite;"></div>`,
  className: "custom-pin-no-default",
  iconSize: [11, 11],
  iconAnchor: [5.5, 5.5],
});

function getNavigationArrowIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<svg width="28" height="36" viewBox="0 0 28 36" style="transform:rotate(${heading}deg)">
    <polygon points="14,0 3,36 14,28 25,36" fill="white" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/>
  </svg>`,
    iconSize: [28, 36],
    iconAnchor: [14, 18],
  });
}

const END_POINT_ICON = L.divIcon({
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#4A7C59;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>`,
  className: "custom-pin-no-default",
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

/** Start of route: same size as end point, route purple/lilac. */
const START_POINT_ICON = L.divIcon({
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#8B7FE8;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>`,
  className: "custom-pin-no-default",
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

/** Place option (e.g. "choose a place to route to") — orange dot. */
const PLACE_OPTION_ICON = L.divIcon({
  html: `<div style="width:12px;height:12px;border-radius:50%;background:#e07c39;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.25);"></div>`,
  className: "custom-pin-no-default",
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

/** Navigation mode: POI along route (unseen) — orange dot. */
const NAV_POI_ICON = L.divIcon({
  html: `<div style="width:12px;height:12px;border-radius:50%;background:#ea580c;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.25);"></div>`,
  className: "custom-pin-no-default",
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

/** Navigation mode: end marker — white square with dark outline. */
const NAV_END_SQUARE_ICON = L.divIcon({
  className: "",
  html: `<div style="width:16px;height:16px;background:#ffffff;border:2.5px solid #1a1a1a;"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

/** Navigation mode: POI passed (seen) — green check. */
const NAV_POI_SEEN_ICON = L.divIcon({
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#16a34a;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;color:white;font-size:8px;line-height:1;">✓</div>`,
  className: "custom-pin-no-default",
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

function getDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function poiKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/** Total distance in meters along route. Coords are [lng, lat]. */
function calculateRouteDistance(coords: [number, number][]): number {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    total += getDistance(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
  }
  return total;
}

interface MapViewClientProps {
  center: LatLngExpression;
  zoom: number;
  routeCoordinates?: [number, number][];
  /** Alternative route (e.g. quick) drawn as lighter dashed line when not navigating. */
  alternativeRouteCoordinates?: [number, number][] | null;
  highlights?: RouteHighlight[];
  endPoint?: [number, number];
  /** Destination POI info for the end-point marker popup. */
  destinationName?: string | null;
  destinationDescription?: string | null;
  destinationRating?: number | null;
  destinationPhoto?: string | null;
  /** Route intent for polyline color (calm, nature, scenic, discover, lively, exercise, cafe, quick, themed_walk). */
  routeIntent?: string;
  /** When set, show these as markers and fit/recenter map as user browses. */
  placeOptions?: PlaceOption[];
  /** Index of the place option currently in view (scroll position); map pans to this. */
  placeOptionsFocusedIndex?: number;
  /** Origin [lat, lng] for fitting bounds when showing place options. */
  origin?: [number, number];
  /** When false, hide the blue GPS dot (e.g. when user has set a custom start). Default true. */
  showUserLocation?: boolean;
  /** When user taps a place-option pin, call this (same as "GO" on the card). */
  onPlaceSelect?: (place: PlaceOption) => void;
  /** When true, map is in navigation mode: arrow marker, neighbourhood zoom 15, no auto-follow. */
  isNavigating?: boolean;
  /** Called when user exits navigation. */
  onExitNavigation?: () => void;
  /** [lat, lng] to fly to immediately when entering nav (e.g. origin at Let's go click). */
  initialNavCenter?: [number, number];
  /** Called when remaining distance/time along the route is updated during navigation. */
  onRemainingUpdate?: (data: { distance: string; time: string }) => void;
  /** Called when user is within 30m of the route end (arrival). */
  onArrived?: () => void;
  /** When true (loop routes), arrival is only triggered after traveling at least 70% of the route. */
  isLoopRoute?: boolean;
  /** Called when the user's GPS position updates (for proximity checks, e.g. before starting navigation). */
  onUserPositionChange?: (lat: number, lng: number) => void;
  /** When set (e.g. custom FROM location), map flies to this [lat, lng] at zoom 15. When cleared, map flies to center (GPS). */
  flyToCenter?: [number, number] | null;
  /** When set, show a marker at the custom start location (hidden when route exists or navigating). */
  customStartCoords?: [number, number] | null;
}

export default function MapViewClient({
  center,
  zoom,
  routeCoordinates,
  alternativeRouteCoordinates,
  highlights,
  endPoint,
  destinationName,
  destinationDescription,
  destinationRating,
  destinationPhoto,
  routeIntent,
  placeOptions,
  placeOptionsFocusedIndex,
  origin,
  showUserLocation = true,
  onPlaceSelect,
  isNavigating = false,
  onExitNavigation,
  initialNavCenter,
  onRemainingUpdate,
  onArrived,
  isLoopRoute = false,
  onUserPositionChange,
  flyToCenter,
  customStartCoords,
}: MapViewClientProps) {
  const [userPosition, setUserPosition] = useState<{ lat: number; lng: number; heading?: number } | null>(null);
  const [showRecenter, setShowRecenter] = useState(false);
  const [seenPoiKeys, setSeenPoiKeys] = useState<Set<string>>(() => new Set());
  const [toastPoi, setToastPoi] = useState<{ name: string; description?: string; placeId?: string; photoRef?: string | null; type?: string } | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [selectedHighlight, setSelectedHighlight] = useState<RouteHighlight | null>(null);
  const placeOptionMarkerRefs = useRef<(L.Marker | null)[]>([]);

  useEffect(() => {
    if (!placeOptions?.length || placeOptionsFocusedIndex == null) return;
    placeOptionMarkerRefs.current.forEach((m, i) => {
      if (m) {
        if (i === placeOptionsFocusedIndex) m.openTooltip();
        else m.closeTooltip();
      }
    });
  }, [placeOptions, placeOptionsFocusedIndex]);

  // Reset POI seen state when entering navigation
  useEffect(() => {
    if (isNavigating) {
      setSeenPoiKeys(new Set());
      setToastPoi(null);
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
    }
  }, [isNavigating]);

  // During navigation: compute remaining route from closest point and report distance/time
  useEffect(() => {
    if (!isNavigating || !userPosition || !routeCoordinates?.length || !onRemainingUpdate) return;
    const coords = routeCoordinates;
    let closestIdx = 0;
    let minD = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = getDistance(userPosition.lat, userPosition.lng, coords[i][1], coords[i][0]);
      if (d < minD) {
        minD = d;
        closestIdx = i;
      }
    }
    const remainingCoords = coords.slice(closestIdx);
    const remainingMeters = calculateRouteDistance(remainingCoords);
    const remainingKm = (remainingMeters / 1000).toFixed(1);
    const remainingMins = Math.ceil(remainingMeters / 80);
    onRemainingUpdate({
      distance: remainingKm + " km",
      time: remainingMins + " min",
    });
    const lastCoord = coords[coords.length - 1];
    const distToEnd = getDistance(userPosition.lat, userPosition.lng, lastCoord[1], lastCoord[0]);
    const totalRouteMeters = calculateRouteDistance(coords);
    const distanceTraveled = totalRouteMeters > 0 ? totalRouteMeters - remainingMeters : 0;
    const progressPercent = totalRouteMeters > 0 ? distanceTraveled / totalRouteMeters : 0;
    const canArrive = isLoopRoute ? progressPercent >= 0.7 : true;
    if (canArrive && distToEnd < 30 && onArrived) {
      onArrived();
    }
  }, [isNavigating, userPosition?.lat, userPosition?.lng, routeCoordinates, onRemainingUpdate, onArrived, isLoopRoute]);

  // Proximity check: when user is within 50m of an unseen POI, show toast and mark seen
  useEffect(() => {
    if (!isNavigating || !userPosition || !highlights?.length) return;
    for (const h of highlights) {
      const key = poiKey(h.lat, h.lng);
      if (seenPoiKeys.has(key)) continue;
      const d = getDistance(userPosition.lat, userPosition.lng, h.lat, h.lng);
      if (d < 50) {
        setSeenPoiKeys((prev) => new Set(prev).add(key));
        setToastPoi({
          name: h.name ?? h.label,
          description: h.description,
          placeId: (h as RouteHighlight).placeId,
          photoRef: (h as RouteHighlight).photoRef,
          type: h.type,
        });
        break;
      }
    }
  }, [isNavigating, userPosition?.lat, userPosition?.lng, highlights, seenPoiKeys]);

  // Auto-dismiss toast after 8s
  useEffect(() => {
    if (!toastPoi) return;
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => {
      setToastPoi(null);
      toastTimeoutRef.current = null;
    }, 8000);
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
    };
  }, [toastPoi]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.navigator?.geolocation) return;
    let watchId: number | undefined;
    const timeoutId = window.setTimeout(() => {
      const geo = window.navigator.geolocation;
      const onSuccess = (pos: GeolocationPosition) => {
        setLocationError(null);
        const { latitude, longitude, heading } = pos.coords;
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          setUserPosition({
            lat: latitude,
            lng: longitude,
            heading: typeof heading === "number" && Number.isFinite(heading) ? heading : undefined,
          });
          onUserPositionChange?.(latitude, longitude);
        }
      };
      const onError = (error: GeolocationPositionError) => {
        handleGeolocationError(error);
        if (error.code === error.PERMISSION_DENIED) {
          setLocationError("Please enable location in your Browser/System settings.");
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          setLocationError("Location unavailable. Check GPS or try again.");
        } else if (error.code === error.TIMEOUT) {
          setLocationError("Location request timed out. Try again.");
        }
      };
      geo.getCurrentPosition(onSuccess, onError, GEOLOCATION_OPTIONS);
      watchId = geo.watchPosition(onSuccess, onError, GEOLOCATION_OPTIONS);
    }, 100);
    return () => {
      window.clearTimeout(timeoutId);
      if (watchId != null && window.navigator?.geolocation) {
        window.navigator.geolocation.clearWatch(watchId);
      }
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      {locationError && (
        <div
          className="absolute bottom-2 left-2 right-2 z-[200] bg-black/80 text-white font-mono text-xs px-3 py-2 text-center"
          role="alert"
        >
          {locationError}
        </div>
      )}
      {isNavigating && toastPoi && (
        <div
          className="fixed bottom-4 left-4 right-4 bg-white rounded-lg shadow-lg overflow-hidden animate-slide-up z-[250]"
          style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.15)" }}
          role="status"
          aria-live="polite"
        >
          {toastPoi.placeId ? (
            <img
              src={`/api/place-photo?name=places/${encodeURIComponent(toastPoi.placeId)}/photos/default`}
              alt={toastPoi.name}
              className="w-full h-28 object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="w-full h-28 bg-gray-100 flex items-center justify-center">
              <span className="font-mono text-xs text-gray-400">📍 {toastPoi.type ?? "POI"}</span>
            </div>
          )}
          <div className="p-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-mono font-bold text-sm truncate text-gray-900">{toastPoi.name}</p>
              {toastPoi.description ? (
                <p className="font-mono text-sm text-gray-500 line-clamp-2 mt-0.5">{toastPoi.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                setToastPoi(null);
                if (toastTimeoutRef.current) {
                  clearTimeout(toastTimeoutRef.current);
                  toastTimeoutRef.current = null;
                }
              }}
              className="font-mono text-gray-400 hover:text-gray-600 text-sm flex-shrink-0"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      <MapContainer
        center={center}
        zoom={zoom}
        className="h-full w-full"
        style={{ zIndex: 1 }}
        zoomControl={false}
      >
        <MapCenterUpdater center={center} zoom={zoom} skipWhenPlaceOptions={!!placeOptions?.length} skipWhenNavigating={isNavigating} />
        <FlyToCenterOnChange center={center} flyToCenter={flyToCenter} skipWhenPlaceOptions={!!placeOptions?.length} skipWhenNavigating={isNavigating} />
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
        <MapZoomControls />
        {!isNavigating && <FitRouteBounds routeCoordinates={routeCoordinates} isNavigating={isNavigating} />}
        <FitPlaceOptionsBounds placeOptions={placeOptions} origin={origin} isNavigating={isNavigating} />
        <PanToFocusedPlace placeOptions={placeOptions} focusedIndex={placeOptionsFocusedIndex} />
        <NavigationMapController
          isNavigating={isNavigating}
          userPosition={userPosition}
          initialNavCenter={initialNavCenter}
          routeCoordinates={routeCoordinates}
          center={center}
          zoom={zoom}
        />
        <NavigationOffScreenDetector
          isNavigating={isNavigating}
          userPosition={userPosition}
          onOffScreenChange={setShowRecenter}
        />
        <NavigationRecenterButton
          isNavigating={isNavigating}
          showRecenter={showRecenter}
          userPosition={userPosition}
          onRecenter={() => setShowRecenter(false)}
        />
        {routeCoordinates?.length ? (
          <>
            {isNavigating && (
              <Polyline
                positions={routeCoordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
                pathOptions={{
                  color: "#e0e0e0",
                  weight: 8,
                  opacity: 0.25,
                }}
              />
            )}
            {!isNavigating && alternativeRouteCoordinates?.length ? (
              <Polyline
                positions={alternativeRouteCoordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
                pathOptions={{
                  color: "#999",
                  weight: 3,
                  dashArray: "5,10",
                  opacity: 0.7,
                }}
              />
            ) : null}
            <Polyline
              positions={routeCoordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
              pathOptions={{
                ...(ROUTE_INTENT_COLORS[routeIntent ?? ""] ?? DEFAULT_ROUTE_COLOR),
                weight: isNavigating ? 5 : 4,
              }}
            />
          </>
        ) : null}
        {routeCoordinates && routeCoordinates.length >= 2 && (
          <>
            {!isNavigating && (
              <CircleMarker
                center={[routeCoordinates[0][1], routeCoordinates[0][0]]}
                radius={5}
                pathOptions={{
                  fillColor: "#ffffff",
                  color: "#1a1a1a",
                  weight: 2,
                  fillOpacity: 1,
                }}
              >
                <Tooltip permanent direction="top" className="font-mono text-[10px]">
                  START
                </Tooltip>
              </CircleMarker>
            )}
            <Marker
              position={[routeCoordinates[routeCoordinates.length - 1][1], routeCoordinates[routeCoordinates.length - 1][0]]}
              icon={NAV_END_SQUARE_ICON}
              zIndexOffset={60}
            >
              {!isNavigating && (
                <Tooltip permanent direction="top" className="font-mono text-[10px]">
                  END
                </Tooltip>
              )}
            </Marker>
          </>
        )}
        {highlights?.map((h, i) => (
          <Marker
            key={i}
            position={[h.lat, h.lng]}
            icon={
              isNavigating
                ? seenPoiKeys.has(poiKey(h.lat, h.lng))
                  ? NAV_POI_SEEN_ICON
                  : NAV_POI_ICON
                : h.type === "destination"
                  ? END_POINT_ICON
                  : POI_DOT_ICON
            }
            eventHandlers={
              isNavigating
                ? {
                    click: (e) => {
                      L.DomEvent.stopPropagation(e);
                      setToastPoi({
                        name: h.name ?? h.label ?? "",
                        description: h.description,
                        placeId: (h as RouteHighlight).placeId,
                        photoRef: (h as RouteHighlight).photoRef,
                        type: h.type,
                      });
                    },
                  }
                : {
                    click: (e) => {
                      L.DomEvent.stopPropagation(e);
                      setSelectedHighlight(h);
                    },
                  }
            }
          />
        ))}
        {customStartCoords && !isNavigating && !routeCoordinates?.length && (
          <Marker
            position={[customStartCoords[0], customStartCoords[1]]}
            icon={L.divIcon({
              className: "",
              html: '<div class="start-pulse"></div>',
              iconSize: [10, 10],
              iconAnchor: [5, 5],
            })}
          />
        )}
        {showUserLocation && userPosition && (
          <Marker
            position={[userPosition.lat, userPosition.lng]}
            icon={isNavigating ? getNavigationArrowIcon(userPosition.heading ?? 0) : USER_LOCATION_ICON}
            zIndexOffset={-100}
          />
        )}
        {routeCoordinates?.length && !isNavigating && (
          <Marker
            position={[routeCoordinates[0][1], routeCoordinates[0][0]]}
            icon={START_POINT_ICON}
            zIndexOffset={50}
          >
            <Popup>Start of walk</Popup>
          </Marker>
        )}
        {endPoint && endPoint.length >= 2 && !isNavigating && (
          <Marker
            position={[endPoint[0], endPoint[1]]}
            icon={END_POINT_ICON}
            zIndexOffset={50}
          >
            <Popup>
              <div className="font-mono text-xs w-48">
                {destinationPhoto && (
                  <Image src={destinationPhoto} width={400} height={300} className="w-full h-24 object-cover mb-1 rounded" alt={destinationName ?? "Destination"} unoptimized />
                )}
                <strong>{destinationName ?? "End of walk"}</strong>
                {destinationRating != null && (
                  <span className="ml-1">{destinationRating.toFixed(1)} ★</span>
                )}
                {destinationDescription && (
                  <p className="text-gray-500 mt-0.5">{destinationDescription}</p>
                )}
              </div>
            </Popup>
          </Marker>
        )}
        {placeOptions?.map((p, i) => (
          <Marker
            key={`${p.lat}-${p.lng}-${i}`}
            position={[p.lat, p.lng]}
            icon={PLACE_OPTION_ICON}
            zIndexOffset={40}
            ref={(el) => {
              placeOptionMarkerRefs.current[i] = el as L.Marker | null;
            }}
            eventHandlers={{
              click: () => {
                onPlaceSelect?.(p);
              },
            }}
          >
            <Tooltip
              permanent
              direction="top"
              offset={[0, -10]}
              opacity={1}
              interactive
              className="font-mono text-[10px] bg-white px-1 py-0.5 border border-gray-300 shadow-sm"
            >
              <span
                role="button"
                tabIndex={0}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onPlaceSelect?.(p);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPlaceSelect?.(p);
                  }
                }}
              >
                {p.name}
              </span>
            </Tooltip>
            <Popup>
              <div className="font-mono text-xs">
                <strong>{p.name}</strong>
                {p.rating != null && <span> · {p.rating.toFixed(1)} ★</span>}
                <br />
                <button
                  type="button"
                  onClick={() => onPlaceSelect?.(p)}
                  className="mt-1 bg-black text-white px-2 py-0.5 text-xs hover:opacity-90"
                >
                  GO
                </button>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      {selectedHighlight && (
        <>
          <button
            type="button"
            className="absolute inset-0 z-[300] bg-black/30"
            aria-label="Close POI card"
            onClick={() => setSelectedHighlight(null)}
          />
          <div
            className="absolute left-1/2 top-5 z-[310] w-[85%] max-w-sm -translate-x-1/2 max-h-[50vh] overflow-y-auto rounded-lg bg-white p-4 shadow-lg"
          >
            <button
              type="button"
              className="absolute right-3 top-3 w-8 h-8 flex items-center justify-center text-gray-500 hover:text-black font-mono text-xl leading-none"
              aria-label="Close"
              onClick={() => setSelectedHighlight(null)}
            >
              ×
            </button>
            <p className="font-mono font-bold text-sm text-gray-900 pr-8">
              {selectedHighlight.name ?? selectedHighlight.label}
            </p>
            {selectedHighlight.description && (
              <p className="mt-2 font-mono text-sm text-gray-600 whitespace-normal">
                {selectedHighlight.description}
              </p>
            )}
            {(() => {
              const photoRefs = (selectedHighlight as { photoRefs?: string[] }).photoRefs ?? [];
              const photoUrls = selectedHighlight.photo_urls ?? [];
              const photoSources = photoRefs.length > 0
                ? photoRefs.map((ref) => `/api/place-photo?ref=${encodeURIComponent(ref)}`)
                : photoUrls;
              console.log("[card] Photo sources for", selectedHighlight.name, ":", {
                photoRefs: (selectedHighlight as any).photoRefs,
                photo_urls: selectedHighlight.photo_urls,
                photoSources,
              });
              if (photoSources.length === 0) return null;
              return (
                <div
                  className="mt-3 poi-gallery"
                  style={{
                    display: "flex",
                    flexDirection: "row",
                    overflowX: "auto",
                    gap: "8px",
                    WebkitOverflowScrolling: "touch",
                    scrollbarWidth: "none",
                    msOverflowStyle: "none",
                  }}
                >
                  {photoSources.map((src, i) => (
                    <Image
                      key={i}
                      src={src}
                      alt=""
                      width={400}
                      height={300}
                      unoptimized
                      style={{
                        height: "160px",
                        minWidth: "200px",
                        flexShrink: 0,
                        objectFit: "cover",
                        borderRadius: "4px",
                      }}
                    />
                  ))}
                </div>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
