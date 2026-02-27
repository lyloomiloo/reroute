"use client";

import { useRef, useCallback, useEffect } from "react";

interface CameraViewProps {
  wordEn: string;
  onCapture: (blob: Blob) => void;
  onBack: () => void;
}

const CANCEL_CHECK_DELAY_MS = 300;

export default function CameraView({
  wordEn,
  onCapture,
  onBack,
}: CameraViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const didCaptureRef = useRef(false);
  const cancelCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        didCaptureRef.current = true;
        onCapture(file);
      }
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    },
    [onCapture]
  );

  // Open native camera on mount; when focus returns without a file, user cancelled → go back to map
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const handleFocus = () => {
      window.removeEventListener("focus", handleFocus);
      cancelCheckTimeoutRef.current = setTimeout(() => {
        cancelCheckTimeoutRef.current = null;
        if (didCaptureRef.current) return;
        const hasFile = input.files && input.files.length > 0;
        if (!hasFile) {
          onBack();
        }
      }, CANCEL_CHECK_DELAY_MS);
    };

    window.addEventListener("focus", handleFocus);
    input.click();

    return () => {
      window.removeEventListener("focus", handleFocus);
      if (cancelCheckTimeoutRef.current !== null) {
        clearTimeout(cancelCheckTimeoutRef.current);
        cancelCheckTimeoutRef.current = null;
      }
    };
  }, [onBack]);

  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      capture="environment"
      onChange={handleFile}
      style={{ display: "none" }}
      aria-label="Camera capture"
    />
  );
}
