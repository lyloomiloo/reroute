"use client";

import type { Pin } from "@/lib/data";

interface UploadConfirmationProps {
  newPin: Pin | null;
}

export default function UploadConfirmation({ newPin }: UploadConfirmationProps) {
  return (
    <div
      className="fixed inset-0 bg-black/90 flex flex-col items-center justify-center gap-6 p-4"
      style={{ zIndex: 9999 }}
    >
      <p className="font-mono text-white text-lg uppercase tracking-wider">
        Dropped!
      </p>
    </div>
  );
}
