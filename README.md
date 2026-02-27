# Daily Quest

A mobile web app — a location-based photo discovery game where users photograph things matching a daily word prompt.

## Tech Stack

- **Next.js 14** (App Router)
- **React** + **Tailwind CSS**
- **Leaflet** + **React-Leaflet** (OpenStreetMap / CartoDB Positron tiles)
- **Supabase** (database + image storage, optional)

## Setup

1. **Install dependencies**

   ```bash
   cd daily-quest && npm install
   ```

2. **Run development server**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000). On desktop the app is shown in a centered phone frame (390×844); on mobile it fills the screen.

3. **Supabase (optional)**

   - Create a project at [supabase.com](https://supabase.com).
   - Run `supabase-schema.sql` in the SQL Editor.
   - Create a Storage bucket named `photos` and set policies (e.g. public read, insert for anon).
   - Copy `.env.example` to `.env.local` and add your `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

   Without Supabase, the app uses sample pins and in-memory state; new photos appear on the map until refresh.

## Design

- **Typography:** Daily word (bold, black, uppercase), translation (monospace, gray), date/countdown (monospace, uppercase).
- **Colors:** White background, black text, gray secondary (#888), black buttons.
- **Map:** Grayscale CartoDB Positron tiles, Barcelona center, zoom 13.
- **Pins:** 48×48 photo thumbnails with white border and shadow; click opens lightbox (photo + street name).
- **Screens:** Map view → Capture (camera) → Preview (Retake / Drop it) → “Dropped!” → back to map.

## PWA

- `public/manifest.json` is linked from the layout.
- Add `public/icon-192.png` and `public/icon-512.png` (e.g. black square with “Q”) for installability.
- Optional: add a service worker for offline support (e.g. with `next-pwa` or Workbox).

## Scripts

- `npm run dev` — start dev server
- `npm run build` — production build
- `npm run start` — start production server
- `npm run lint` — run ESLint
