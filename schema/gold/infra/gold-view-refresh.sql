-- Gold agent-facing views refresh log. Rule 4 plumbing: every view refresh
-- writes one row, agents can check freshness via
-- `SELECT MAX(refreshed_at) FROM gold_view_refresh_log WHERE view_name = ...`.
-- First producer is the refreshGoldView(name) helper; first consumers arrive
-- with the Phase 2 materialized views.

CREATE TABLE IF NOT EXISTS gold_view_refresh_log (
  id SERIAL PRIMARY KEY,
  view_name TEXT NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_count INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('ok','failed')),
  error TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
-- Descending refreshed_at for fast "latest refresh per view" lookups.
CREATE INDEX IF NOT EXISTS idx_gvrl_view_time
  ON gold_view_refresh_log(view_name, refreshed_at DESC);
CREATE INDEX IF NOT EXISTS idx_gvrl_status
  ON gold_view_refresh_log(status);
