"use client";

import dynamic from "next/dynamic";
import type { LatLngExpression } from "leaflet";
import type { RouteHighlight, PlaceOption } from "@/lib/routing";

const MapViewClient = dynamic(() => import("./MapViewClient"), { ssr: false });

interface MapViewProps {
  center: LatLngExpression;
  zoom: number;
  routeCoordinates?: [number, number][];
  /** Alternative route (e.g. quick) shown as lighter dashed line when not navigating. */
  alternativeRouteCoordinates?: [number, number][] | null;
  highlights?: RouteHighlight[];
  endPoint?: [number, number];
  /** Destination POI info for the end-point marker popup. */
  destinationName?: string | null;
  destinationDescription?: string | null;
  destinationRating?: number | null;
  destinationPhoto?: string | null;
  /** Route intent for polyline color (e.g. calm, nature, scenic). */
  routeIntent?: string;
  /** Place options to show on map when user is choosing a destination; map recenters as they scroll. */
  placeOptions?: PlaceOption[] | null;
  placeOptionsFocusedIndex?: number;
  origin?: [number, number];
  /** When false, hide the blue GPS dot (e.g. when user has set a custom start). */
  showUserLocation?: boolean;
  /** When user taps a place-option pin on the map, call this (same as "GO" on the card). */
  onPlaceSelect?: (place: PlaceOption) => void;
  /** When true, map is in navigation mode: arrow marker, neighbourhood zoom 15, no auto-follow. */
  isNavigating?: boolean;
  /** Called when user exits navigation (e.g. X button). */
  onExitNavigation?: () => void;
  /** [lat, lng] to fly to immediately when entering nav (e.g. origin at Let's go click). */
  initialNavCenter?: [number, number];
  /** Called when remaining distance/time along the route is updated during navigation. */
  onRemainingUpdate?: (data: { distance: string; time: string }) => void;
  /** Called when user is within 30m of the route end (arrival). */
  onArrived?: () => void;
  /** When true (loop routes), arrival is only triggered after traveling at least 70% of the route. */
  isLoopRoute?: boolean;
  /** Called when the user's GPS position updates (for proximity checks). */
  onUserPositionChange?: (lat: number, lng: number) => void;
  /** When set (e.g. custom FROM location), map flies to this [lat, lng] at zoom 15. When cleared, flies to center (GPS). */
  flyToCenter?: [number, number] | null;
  /** When set, show a marker at the custom start location (hidden when route exists or navigating). */
  customStartCoords?: [number, number] | null;
}

export default function MapView({
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
}: MapViewProps) {
  return (
    <div className="absolute inset-0" style={{ zIndex: 1 }}>
      <MapViewClient
        center={center}
        zoom={zoom}
        routeCoordinates={routeCoordinates}
        alternativeRouteCoordinates={alternativeRouteCoordinates}
        highlights={highlights}
        endPoint={endPoint}
        destinationName={destinationName}
        destinationDescription={destinationDescription}
        destinationRating={destinationRating}
        destinationPhoto={destinationPhoto}
        routeIntent={routeIntent}
        placeOptions={placeOptions ?? undefined}
        placeOptionsFocusedIndex={placeOptionsFocusedIndex}
        origin={origin}
        showUserLocation={showUserLocation}
        onPlaceSelect={onPlaceSelect}
        isNavigating={isNavigating}
        onExitNavigation={onExitNavigation}
        initialNavCenter={initialNavCenter}
        onRemainingUpdate={onRemainingUpdate}
        onArrived={onArrived}
        isLoopRoute={isLoopRoute}
        onUserPositionChange={onUserPositionChange}
        flyToCenter={flyToCenter}
        customStartCoords={customStartCoords}
      />
    </div>
  );
}
