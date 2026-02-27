"use client";

import Image from "next/image";
import type { Pin } from "@/lib/data";

interface LightboxProps {
  pin: Pin | null;
  onClose: () => void;
}

export default function Lightbox({ pin, onClose }: LightboxProps) {
  if (!pin) return null;

  return (
    <div
      className="fixed inset-0 bg-black/90 flex flex-col items-center justify-center p-4"
      style={{ zIndex: 9999 }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Photo lightbox"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center text-white text-2xl font-light hover:bg-white/10"
        aria-label="Close"
      >
        ×
      </button>
      <div
        className="flex flex-col items-center max-w-[90vw] max-h-[60vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <Image
          src={pin.image_url}
          alt=""
          width={400}
          height={300}
          className="max-w-full max-h-[55vh] object-contain"
          unoptimized
        />
        <p className="text-white text-center mt-3 font-mono text-sm">
          {pin.street_name || "Unknown street"}
        </p>
      </div>
    </div>
  );
}
