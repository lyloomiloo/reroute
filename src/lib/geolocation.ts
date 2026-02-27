/**
 * Geolocation options for mobile: high accuracy (GPS on iPhone), reasonable timeout to avoid hang.
 */
export const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 20000,
  maximumAge: 10000,
};

/** Shorter timeout for quick checks (e.g. gate). */
export const GEOLOCATION_OPTIONS_QUICK: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 5000,
  maximumAge: 60000,
};

const PERMISSION_DENIED_MSG =
  "Please enable location in your Browser/System settings.";

/**
 * Handle geolocation error callback. Use in getCurrentPosition/watchPosition onError.
 */
export function handleGeolocationError(error: GeolocationPositionError): void {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      console.warn("[Geolocation] Permission denied.", PERMISSION_DENIED_MSG);
      break;
    case error.POSITION_UNAVAILABLE:
      console.warn(
        "[Geolocation] Position unavailable (e.g. weak or no GPS signal)."
      );
      break;
    case error.TIMEOUT:
      console.warn("[Geolocation] Request timed out. Try again or check signal.");
      break;
    default:
      console.warn("[Geolocation] Unknown error:", error.message);
  }
}
