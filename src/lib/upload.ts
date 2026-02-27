import { supabase } from "./supabase";
import type { Pin } from "./data";

const BUCKET = "photos";

export interface CreatePinInput {
  blob: Blob;
  latitude: number;
  longitude: number;
  streetName: string | null;
  wordDate: string; // YYYY-MM-DD
}

/**
 * Upload photo to Supabase Storage and insert pin into pins table.
 * Returns the created pin with id from the database, or null if Supabase is not configured or upload fails.
 */
export async function uploadPhotoAndCreatePin(
  input: CreatePinInput
): Promise<Pin | null> {
  const client = supabase;
  if (!client) return null;

  const { blob, latitude, longitude, streetName, wordDate } = input;

  const path = `${wordDate}/${crypto.randomUUID()}.jpg`;

  const { error: uploadError } = await client.storage
    .from(BUCKET)
    .upload(path, blob, {
      contentType: "image/jpeg",
      upsert: false,
    });

  if (uploadError) {
    console.error("Supabase storage upload failed:", uploadError);
    return null;
  }

  const {
    data: { publicUrl },
  } = client.storage.from(BUCKET).getPublicUrl(path);

  const { data: row, error: insertError } = await client
    .from("pins")
    .insert({
      image_url: publicUrl,
      latitude,
      longitude,
      street_name: streetName,
      word_date: wordDate,
    })
    .select("id, image_url, latitude, longitude, street_name, word_date")
    .single();

  if (insertError) {
    console.error("Supabase pins insert failed:", insertError);
    return null;
  }

  return {
    id: row.id,
    image_url: row.image_url,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    street_name: row.street_name,
    word_date: row.word_date,
  };
}
