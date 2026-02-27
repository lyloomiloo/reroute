import { NextRequest, NextResponse } from "next/server";

/**
 * Proxies Google Places photos so the client can show images without CORS or exposing the API key.
 * Supports:
 * - ref=photo_reference (old Places API: maps.googleapis.com/maps/api/place/photo)
 * - name=resource name (new Places API v1: places/ChIJ.../photos/xxx)
 */
export async function GET(req: NextRequest) {
  const ref = req.nextUrl.searchParams.get("ref");
  const name = req.nextUrl.searchParams.get("name");
  const maxwidth = req.nextUrl.searchParams.get("maxwidth") ?? "200";

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  try {
    if (ref) {
      const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photo_reference=${encodeURIComponent(ref)}&key=${apiKey}`;
      const response = await fetch(url);
      if (!response.ok) {
        return NextResponse.json({ error: "Photo fetch failed" }, { status: response.status === 404 ? 404 : 502 });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "image/jpeg",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    if (name && typeof name === "string" && name.startsWith("places/")) {
      const mediaPath = name.endsWith("/media") ? name : `${name}/media`;
      const url = `https://places.googleapis.com/v1/${mediaPath}?maxHeightPx=400&maxWidthPx=400&key=${apiKey}`;
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        return NextResponse.json({ error: "Photo fetch failed" }, { status: res.status === 404 ? 404 : 502 });
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const json = (await res.json()) as { photoUri?: string };
        const photoUri = json?.photoUri;
        if (!photoUri || typeof photoUri !== "string") {
          return NextResponse.json({ error: "No photo URI in response" }, { status: 502 });
        }
        const imageRes = await fetch(photoUri);
        if (!imageRes.ok) {
          return NextResponse.json({ error: "Photo redirect fetch failed" }, { status: 502 });
        }
        const buffer = Buffer.from(await imageRes.arrayBuffer());
        return new NextResponse(buffer, {
          headers: {
            "Content-Type": imageRes.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": contentType || "image/jpeg",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    return NextResponse.json({ error: "Missing ref or name" }, { status: 400 });
  } catch (e) {
    console.warn("[place-photo] fetch error:", e);
    return NextResponse.json({ error: "Photo fetch error" }, { status: 502 });
  }
}
