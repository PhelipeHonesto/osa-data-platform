-- Route similarity embeddings, used by src/analytics/embeddings.ts for
-- nearest-neighbour route lookups in pgvector. Created live post-migration
-- during embeddings work; codified here 2026-04-18 during schema split
-- audit so fresh DBs mirror production.

CREATE TABLE IF NOT EXISTS route_vectors (
  origin_icao TEXT NOT NULL,
  destination_icao TEXT NOT NULL,
  embedding vector(9),
  metadata JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (origin_icao, destination_icao)
);

-- IVFFlat ANN index on the embedding column (pgvector). Matches production.
CREATE INDEX IF NOT EXISTS idx_rv_embedding
  ON route_vectors USING ivfflat (embedding) WITH (lists = 100);
