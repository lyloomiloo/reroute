"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { MapContainer, TileLayer, Marker, Polyline, Popup, Tooltip, useMap } from "react-leaflet";
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
}: {
  center: LatLngExpression;
  zoom: number;
  skipWhenPlaceOptions?: boolean;
}) {
  const map = useMap();
  const setViewCountRef = useRef(0);
  useEffect(() => {
    if (skipWhenPlaceOptions) return;
    if (setViewCountRef.current < 2) {
      const [lat, lng] = Array.isArray(center) ? center : [center.lat, center.lng];
      const viewLat = lat + CENTER_OFFSET_LAT;
      map.setView([viewLat, lng], zoom, { animate: false });
      setViewCountRef.current += 1;
    }
  }, [map, center, zoom, skipWhenPlaceOptions]);
  return null;
}

function FitRouteBounds({
  routeCoordinates,
}: {
  routeCoordinates?: [number, number][];
}) {
  const map = useMap();
  useEffect(() => {
    if (!routeCoordinates?.length) return;
    const positions: L.LatLngExpression[] = routeCoordinates.map(
      ([lng, lat]) => [lat, lng] as [number, number]
    );
    const bounds = L.latLngBounds(positions);
    map.fitBounds(bounds, {
      paddingTopLeft: [40, 40],
      paddingBottomRight: [40, 180],
    });
  }, [map, routeCoordinates]);
  return null;
}

function FitPlaceOptionsBounds({
  placeOptions,
  origin,
}: {
  placeOptions?: Array<{ lat: number; lng: number }>;
  origin?: [number, number];
}) {
  const map = useMap();
  useEffect(() => {
    if (!placeOptions?.length) return;
    const points: L.LatLngExpression[] = placeOptions.map((p) => [p.lat, p.lng] as [number, number]);
    if (origin?.length === 2) points.push([origin[0], origin[1]]);
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, {
      paddingTopLeft: [40, 40],
      paddingBottomRight: [40, 180],
      maxZoom: 15,
    });
  }, [map, placeOptions, origin]);
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
  html: `<div class="user-location-dot" style="width:11px;height:11px;border-radius:50%;background:#4285F4;box-shadow:0 0 0 3px rgba(66,133,244,0.4);animation:user-location-pulse 2s ease-in-out infinite;"></div>`,
  className: "custom-pin-no-default",
  iconSize: [11, 11],
  iconAnchor: [5.5, 5.5],
});

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

interface MapViewClientProps {
  center: LatLngExpression;
  zoom: number;
  routeCoordinates?: [number, number][];
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
}

export default function MapViewClient({
  center,
  zoom,
  routeCoordinates,
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
}: MapViewClientProps) {
  const [userPosition, setUserPosition] = useState<{ lat: number; lng: number } | null>(null);
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

  useEffect(() => {
    if (typeof window === "undefined" || !window.navigator?.geolocation) return;
    let watchId: number | undefined;
    const timeoutId = window.setTimeout(() => {
      const geo = window.navigator.geolocation;
      const onSuccess = (pos: GeolocationPosition) => {
        setLocationError(null);
        const { latitude, longitude } = pos.coords;
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          setUserPosition({ lat: latitude, lng: longitude });
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
      <MapContainer
        center={center}
        zoom={zoom}
        className="h-full w-full"
        style={{ zIndex: 1 }}
        zoomControl={false}
      >
        <MapCenterUpdater center={center} zoom={zoom} skipWhenPlaceOptions={!!placeOptions?.length} />
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
        <MapZoomControls />
        <FitRouteBounds routeCoordinates={routeCoordinates} />
        <FitPlaceOptionsBounds placeOptions={placeOptions} origin={origin} />
        <PanToFocusedPlace placeOptions={placeOptions} focusedIndex={placeOptionsFocusedIndex} />
        {routeCoordinates?.length ? (
          <Polyline
            positions={routeCoordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
            pathOptions={{
              ...(ROUTE_INTENT_COLORS[routeIntent ?? ""] ?? DEFAULT_ROUTE_COLOR),
              weight: 4,
            }}
          />
        ) : null}
        {highlights?.map((h, i) => (
          <Marker
            key={i}
            position={[h.lat, h.lng]}
            icon={h.type === "destination" ? END_POINT_ICON : POI_DOT_ICON}
            eventHandlers={{
              click: (e) => {
                L.DomEvent.stopPropagation(e);
                setSelectedHighlight(h);
              },
            }}
          />
        ))}
        {showUserLocation && userPosition && (
          <Marker
            position={[userPosition.lat, userPosition.lng]}
            icon={USER_LOCATION_ICON}
            zIndexOffset={-100}
          />
        )}
        {routeCoordinates?.length && (
          <Marker
            position={[routeCoordinates[0][1], routeCoordinates[0][0]]}
            icon={START_POINT_ICON}
            zIndexOffset={50}
          >
            <Popup>Start of walk</Popup>
          </Marker>
        )}
        {endPoint && endPoint.length >= 2 && (
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
              <p className="mt-2 font-mono text-xs text-gray-600 whitespace-normal">
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
