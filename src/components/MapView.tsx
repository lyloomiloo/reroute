"use client";

import dynamic from "next/dynamic";
import type { LatLngExpression } from "leaflet";
import type { RouteHighlight, PlaceOption } from "@/lib/routing";

const MapViewClient = dynamic(() => import("./MapViewClient"), { ssr: false });

interface MapViewProps {
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
  /** When true, map is in navigation mode: arrow marker, follow user, zoom 17. */
  isNavigating?: boolean;
  /** Called when user exits navigation (e.g. X button). */
  onExitNavigation?: () => void;
  /** [lat, lng] to fly to immediately when entering nav (e.g. origin at Let's go click). */
  initialNavCenter?: [number, number];
  /** Called when remaining distance/time along the route is updated during navigation. */
  onRemainingUpdate?: (data: { distance: string; time: string }) => void;
  /** Called when user is within 30m of the route end (arrival). */
  onArrived?: () => void;
}

export default function MapView({
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
  isNavigating = false,
  onExitNavigation,
  initialNavCenter,
  onRemainingUpdate,
  onArrived,
}: MapViewProps) {
  return (
    <div className="absolute inset-0" style={{ zIndex: 1 }}>
      <MapViewClient
        center={center}
        zoom={zoom}
        routeCoordinates={routeCoordinates}
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
      />
    </div>
  );
}
