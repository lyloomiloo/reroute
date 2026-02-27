export interface Pin {
  id: string;
  image_url: string;
  latitude: number;
  longitude: number;
  street_name: string | null;
  word_date: string;
}

export interface DailyWord {
  word_en: string;
  word_es: string;
  active_date: string;
}

export const BARCELONA_CENTER: [number, number] = [41.3874, 2.1686];
