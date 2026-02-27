/**
 * Cron cleanup: deletes pins (and their storage images) where word_date < today (Madrid).
 * Invoked by Vercel Cron at 00:05 UTC daily. For 00:05 Madrid (CET) use schedule "5 23 * * *" in vercel.json.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "photos";

/** Today's date as YYYY-MM-DD in Europe/Madrid. */
function getTodayMadrid(): string {
  const d = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Madrid" })
  );
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Extract storage path from public URL (e.g. .../photos/2025-02-03/uuid.jpg -> 2025-02-03/uuid.jpg). */
function imageUrlToStoragePath(imageUrl: string): string | null {
  try {
    const match = imageUrl.match(/\/photos\/(.+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: "Missing Supabase config (SUPABASE_SERVICE_ROLE_KEY)" },
      { status: 500 }
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const today = getTodayMadrid();

  try {
    const { data: deletedPins, error: deleteError } = await admin
      .from("pins")
      .delete()
      .lt("word_date", today)
      .select("image_url");

    if (deleteError) {
      console.error("Cleanup pins delete failed:", deleteError);
      return NextResponse.json(
        { error: "Failed to delete pins", details: deleteError.message },
        { status: 500 }
      );
    }

    const paths = (deletedPins ?? [])
      .map((p) => imageUrlToStoragePath(p.image_url))
      .filter((p): p is string => p != null);

    if (paths.length > 0) {
      const { error: storageError } = await admin.storage
        .from(BUCKET)
        .remove(paths);
      if (storageError) {
        console.error("Cleanup storage remove failed:", storageError);
        return NextResponse.json(
          {
            error: "Pins deleted but some storage cleanup failed",
            details: storageError.message,
            deletedPins: deletedPins?.length ?? 0,
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      today: today,
      deletedPins: deletedPins?.length ?? 0,
      deletedStorageObjects: paths.length,
    });
  } catch (e) {
    console.error("Cleanup error:", e);
    return NextResponse.json(
      { error: "Cleanup failed", details: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
