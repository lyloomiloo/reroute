"use client";

import { ReactNode } from "react";

const FRAME_WIDTH = 390;
const FRAME_HEIGHT = 844;

export default function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh md:min-h-screen flex items-center justify-center p-0 md:p-6 bg-frame">
      <div
        className="w-full flex flex-col bg-background text-foreground overflow-hidden md:rounded-none shadow-2xl"
        style={{
          maxWidth: FRAME_WIDTH,
          minHeight: "100dvh",
          height: "100dvh",
          maxHeight: "100dvh",
        }}
      >
        {children}
      </div>
    </div>
  );
}
