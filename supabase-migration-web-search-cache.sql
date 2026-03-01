-- Web search cache for SerpAPI Tier C verification (run in Supabase SQL Editor)
-- Cache key: placeName::searchQuery (e.g. "Citizen Cafe::Citizen Cafe Barcelona pet-friendly")
-- TTL: 7 days (enforced in app; this table has no TTL column so app checks created_at)

CREATE TABLE IF NOT EXISTS web_search_cache (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  query_key text UNIQUE NOT NULL,
  results jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_search_cache_query ON web_search_cache(query_key);
CREATE INDEX IF NOT EXISTS idx_web_search_cache_created ON web_search_cache(created_at);

-- Optional: RLS so anon key can read/write (adjust policy as needed for your project)
-- ALTER TABLE web_search_cache ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Allow anon read and insert" ON web_search_cache FOR ALL USING (true) WITH CHECK (true);
