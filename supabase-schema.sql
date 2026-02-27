-- Daily Quest: Supabase schema
-- Run this in Supabase SQL Editor to create tables.

-- Enable UUID extension if not already
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Daily words (active_date nullable = unassigned; run supabase-migration-words-repetition.sql for existing DBs)
CREATE TABLE words (
  id SERIAL PRIMARY KEY,
  word_en TEXT NOT NULL,
  word_es TEXT NOT NULL,
  active_date DATE,
  times_used INTEGER NOT NULL DEFAULT 0,
  last_used_date DATE
);

-- Photo pins
CREATE TABLE pins (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  image_url TEXT NOT NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  street_name TEXT,
  word_date DATE NOT NULL
);

-- Enable RLS (Row Level Security) - adjust policies as needed
ALTER TABLE words ENABLE ROW LEVEL SECURITY;
ALTER TABLE pins ENABLE ROW LEVEL SECURITY;

-- Example: allow public read on words and pins
CREATE POLICY "Allow public read on words" ON words FOR SELECT USING (true);
CREATE POLICY "Allow public update on words" ON words FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow public read on pins" ON pins FOR SELECT USING (true);
CREATE POLICY "Allow public insert on pins" ON pins FOR INSERT WITH CHECK (true);

-- Storage bucket "photos" for uploaded images:
-- 1. In Supabase Dashboard > Storage, create a bucket named "photos".
-- 2. Set bucket to Public (or add a policy that allows public read).
-- 3. In Storage > Policies for "photos", add:
--    - "Allow public read": FOR SELECT USING (true)
--    - "Allow anon insert": FOR INSERT WITH CHECK (true)
--    so the app can upload with the anon key and images are viewable by everyone.
