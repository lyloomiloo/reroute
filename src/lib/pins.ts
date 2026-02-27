import { supabase } from "./supabase";
import type { Pin } from "./data";

/**
 * Fetch pins from Supabase for a given word_date (YYYY-MM-DD, typically today in Madrid).
 * Only returns pins where word_date = wordDate; old pins stay in DB but never display.
 * Returns pins in app Pin shape; empty array if Supabase is not configured or query fails.
 */
export async function fetchPinsForDate(wordDate: string): Promise<Pin[]> {
  const client = supabase;
  if (!client) return [];

  const { data: rows, error } = await client
    .from("pins")
    .select("id, image_url, latitude, longitude, street_name, word_date")
    .eq("word_date", wordDate)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase pins fetch failed:", error);
    return [];
  }

  if (!rows?.length) return [];

  return rows.map((row) => ({
    id: String(row.id),
    image_url: row.image_url,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    street_name: row.street_name,
    word_date: row.word_date,
  }));
}
