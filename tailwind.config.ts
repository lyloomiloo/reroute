import type { Config } from "tailwindcss";

const config: Config = {
  safelist: ["user-location-dot"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "monospace"],
      },
      colors: {
        background: "#FFFFFF",
        foreground: "#000000",
        muted: "#888888",
        frame: "#1a1a1a",
      },
    },
  },
  plugins: [],
};
export default config;
