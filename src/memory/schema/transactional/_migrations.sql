-- Migration tracking table.
-- Reserved for a future migration runner; migrate-pg.ts today re-applies the
-- full schema idempotently via CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
