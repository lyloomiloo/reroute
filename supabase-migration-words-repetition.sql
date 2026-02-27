-- Smart word repetition: run in Supabase SQL Editor if you already have the words table.
-- Adds times_used and last_used_date; makes active_date nullable for unassigned words.

-- Allow active_date to be NULL (unassigned words)
ALTER TABLE words ALTER COLUMN active_date DROP NOT NULL;

-- Drop UNIQUE on active_date so the same word can be assigned again on different days
-- (We enforce "one word per day" in app by selecting exactly one row with active_date = today)
ALTER TABLE words DROP CONSTRAINT IF EXISTS words_active_date_key;

-- Add columns for repetition rules
ALTER TABLE words ADD COLUMN IF NOT EXISTS times_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE words ADD COLUMN IF NOT EXISTS last_used_date DATE;

-- Optional: backfill last_used_date from active_date for existing rows
UPDATE words SET last_used_date = active_date WHERE active_date IS NOT NULL AND last_used_date IS NULL;
UPDATE words SET times_used = 1 WHERE active_date IS NOT NULL AND times_used = 0;
