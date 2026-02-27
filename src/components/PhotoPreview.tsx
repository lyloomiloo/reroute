"use client";

import { useCallback, useState, useMemo, useEffect } from "react";
import Image from "next/image";
import type { Pin } from "@/lib/data";
import { downloadImage } from "@/lib/download";
import { uploadPhotoAndCreatePin } from "@/lib/upload";

interface PhotoPreviewProps {
  blob: Blob;
  wordDate: string; // YYYY-MM-DD for today's word
  onRetake: () => void;
  onDropIt: (pin: Pin) => void;
  onBack: () => void;
}

// Barcelona bounds for random placement when user has no GPS
const BARCELONA_LAT_MIN = 41.35;
const BARCELONA_LAT_MAX = 41.45;
const BARCELONA_LNG_MIN = 2.1;
const BARCELONA_LNG_MAX = 2.23;

function randomBarcelonaCoords(): { lat: number; lng: number } {
  const lat = BARCELONA_LAT_MIN + Math.random() * (BARCELONA_LAT_MAX - BARCELONA_LAT_MIN);
  const lng = BARCELONA_LNG_MIN + Math.random() * (BARCELONA_LNG_MAX - BARCELONA_LNG_MIN);
  return { lat, lng };
}

export default function PhotoPreview({
  blob,
  wordDate,
  onRetake,
  onDropIt,
  onBack,
}: PhotoPreviewProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewUrl = useMemo(() => URL.createObjectURL(blob), [blob]);

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleSave = useCallback(() => {
    downloadImage(previewUrl, `daily-quest-${wordDate}.jpg`);
  }, [previewUrl, wordDate]);

  const handleDropIt = async () => {
    console.log("Starting upload...");
    console.log("File (blob):", blob?.size, "bytes, type:", blob?.type);
    setUploading(true);
    setError(null);
    try {
      const { lat: fallbackLat, lng: fallbackLng } = randomBarcelonaCoords();
      let lat = fallbackLat;
      let lng = fallbackLng;
      let streetName: string | null = null;

      if (navigator.geolocation) {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 0,
          });
        }).catch(() => null);
        if (pos) {
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
          try {
            const res = await fetch(
              `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
              { headers: { "Accept-Language": "en" } }
            );
            const data = await res.json();
            streetName =
              data.address?.road ||
              data.address?.pedestrian ||
              data.address?.footway ||
              data.address?.street ||
              null;
          } catch {
            streetName = null;
          }
        }
      }
      console.log("Location:", { lat, lng, streetName });

      const uploadedPin = await uploadPhotoAndCreatePin({
        blob,
        latitude: lat,
        longitude: lng,
        streetName,
        wordDate,
      });

      console.log("Upload result:", uploadedPin ? "success" : "null/failed");

      if (uploadedPin) {
        onDropIt(uploadedPin);
        return;
      }

      if (typeof window !== "undefined" && window.alert) {
        window.alert("Upload to server failed. Photo will appear on map locally.");
      }

      // Fallback when Supabase is not configured or upload failed: use blob URL (pin only in local state)
      console.log("Using fallback: pin with local blob URL");
      const pin: Pin = {
        id: `pin-${Date.now()}`,
        image_url: previewUrl,
        latitude: lat,
        longitude: lng,
        street_name: streetName,
        word_date: wordDate,
      };
      onDropIt(pin);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Upload failed";
      console.error("Upload error:", e);
      setError(message);
      if (typeof window !== "undefined" && window.alert) {
        window.alert("Upload failed: " + message);
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black flex flex-col" style={{ zIndex: 200 }}>
      <div className="p-4 shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="w-10 h-10 flex items-center justify-center text-white"
          aria-label="Back to camera"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-4">
        <Image
          src={previewUrl}
          alt="Preview"
          width={400}
          height={300}
          className="max-w-full max-h-full object-contain"
          unoptimized
        />
        <div className="w-full flex justify-end mt-2">
          <button
            type="button"
            onClick={handleSave}
            className="font-mono text-sm uppercase tracking-wider text-white opacity-90 hover:opacity-100 flex items-center gap-2"
            aria-label="Save to device"
          >
            <span>Save to device</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </button>
        </div>
      </div>

      {error && (
        <p className="px-4 py-2 text-red-400 text-sm font-mono">{error}</p>
      )}
      <div className="p-4 flex gap-4 shrink-0">
        <button
          type="button"
          onClick={onRetake}
          className="flex-1 py-4 border-2 border-white text-white font-mono text-sm uppercase tracking-wider flex items-center justify-center gap-2"
          aria-label="Retake photo"
        >
          <span className="text-lg leading-none" aria-hidden>↻</span>
          Retake
        </button>
        <button
          type="button"
          onClick={handleDropIt}
          disabled={uploading}
          className="flex-1 py-4 bg-white text-black font-mono text-sm uppercase tracking-wider disabled:opacity-50 flex items-center justify-center gap-2"
          aria-label="Drop it"
        >
          <span className="text-lg leading-none" aria-hidden>↓</span>
          {uploading ? "..." : "Drop it"}
        </button>
      </div>
    </div>
  );
}
