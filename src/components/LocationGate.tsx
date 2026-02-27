"use client";

import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY_ALLOWED = "daily-quest-location-allowed";
const STORAGE_KEY_SKIPPED = "daily-quest-location-skipped";

type GateStatus = "checking" | "prompt" | "denied" | "allowed";

interface LocationGateProps {
  onReady?: () => void;
  children: React.ReactNode;
}

export default function LocationGate({ onReady, children }: LocationGateProps) {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<GateStatus>("checking");
  const [requesting, setRequesting] = useState(false);

  const markReady = useCallback(() => {
    setReady(true);
    onReady?.();
  }, [onReady]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(STORAGE_KEY_ALLOWED) === "1") {
      markReady();
      return;
    }
    if (window.localStorage.getItem(STORAGE_KEY_SKIPPED) === "1") {
      markReady();
      return;
    }
    if (!window.navigator?.geolocation) {
      setStatus("prompt");
      return;
    }
    window.navigator.geolocation.getCurrentPosition(
      () => {
        window.localStorage.setItem(STORAGE_KEY_ALLOWED, "1");
        markReady();
      },
      () => setStatus("prompt"),
      { maximumAge: 60000, timeout: 2000 }
    );
  }, [markReady]);

  const handleAllow = () => {
    if (typeof window === "undefined" || !window.navigator?.geolocation) return;
    setRequesting(true);
    window.navigator.geolocation.getCurrentPosition(
      () => {
        window.localStorage.setItem(STORAGE_KEY_ALLOWED, "1");
        setRequesting(false);
        markReady();
      },
      () => {
        setStatus("denied");
        setRequesting(false);
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
    );
  };

  const handleContinueWithout = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY_SKIPPED, "1");
    }
    markReady();
  };

  if (ready) {
    return <>{children}</>;
  }

  if (status === "checking") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background p-6">
        <p className="font-mono text-sm text-muted">Checking location…</p>
      </div>
    );
  }

  if (status === "prompt" || status === "denied") {
    return (
      <div
        className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6 py-8"
        style={{ minHeight: "100dvh" }}
      >
        <div className="mb-6 h-14 w-14 rounded-full bg-[#4285F4]/20 flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#4285F4"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
        </div>
        <h2 className="mb-2 text-center font-mono text-lg font-semibold uppercase tracking-wider text-foreground">
          Location needed
        </h2>
        <p className="mb-8 max-w-[280px] text-center font-mono text-sm text-muted">
          Allow location access to see yourself on the map and drop your snaps in the right place.
        </p>
        <button
          type="button"
          onClick={handleAllow}
          disabled={requesting}
          className="mb-4 w-full max-w-[280px] py-4 font-mono text-sm uppercase tracking-wider text-white bg-[#4285F4] disabled:opacity-70"
        >
          {requesting ? "Requesting…" : "Allow location"}
        </button>
        {status === "denied" && (
          <p className="mb-2 text-center font-mono text-xs text-muted">
            Location was denied. You can still use the app without your position on the map.
          </p>
        )}
        <button
          type="button"
          onClick={handleContinueWithout}
          className="font-mono text-sm uppercase tracking-wider text-muted underline underline-offset-2"
        >
          Continue without location
        </button>
      </div>
    );
  }

  return null;
}
