-- 2026-04-25-002: Track 6 Step 2c.5 Phase 2 — operator_llm_er_checkpoint.
--
-- Persistent state for the LLM-augmented entity-resolution pass that
-- closes the 351 medium-tier review queue from Step 2c plus Phase 1's
-- collision residual. One row per (input_review_id, input_step) tracks
-- the lifecycle from queued → in_progress → completed → ready_for_review
-- (or failed) → committed.
--
-- Driver: scripts/llm-er-pass-firecrawl.ts (built in same Phase 2
-- scaffolding commit). Auto-approve criteria for --commit are encoded
-- in the driver, not in CHECK constraints — keeping decision logic in
-- TypeScript so adjustments don't require a schema migration.
--
-- Per the CLAUDE.md three-step migration verification rule, this file
-- is verified via:
--   1. Local Docker Postgres rollback test (up → migrate → verify →
--      rollback → verify-gone → re-migrate)
--   2. npm run db:migrate-pg against Supabase production
--   3. Production object verification via psql \d+ public.operator_llm_er_checkpoint
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout. Re-applying is safe.

CREATE TABLE IF NOT EXISTS public.operator_llm_er_checkpoint (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link back to the input record. Conceptually FKs into
  -- public.operator_match_review(id), but kept loose because the
  -- match_review table can be cleaned/replaced without forcing a
  -- cascade rebuild of the checkpoint history.
  input_review_id INTEGER NOT NULL,
  input_step TEXT NOT NULL,

  -- Lifecycle. queued → in_progress → completed (LLM ran cleanly) → either
  -- ready_for_review (auto-approve filter held it) or committed (writes
  -- landed in canonical). failed = unrecoverable error after retry budget.
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',
      'in_progress',
      'completed',
      'failed',
      'ready_for_review',
      'committed'
    )),

  -- Per-record retry counter. Driver sets a hard cap (default 3) before
  -- escalating to status='failed'.
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,

  -- LLM decision payload. NULL while queued/in_progress.
  llm_decision TEXT
    CHECK (
      llm_decision IS NULL
      OR llm_decision IN ('match', 'new_entity', 'ambiguous', 'error')
    ),
  llm_decision_subtype TEXT
    CHECK (
      llm_decision_subtype IS NULL
      OR llm_decision_subtype IN (
        'exact_alias',
        'subsidiary_of_canonical',
        'rebrand_to_canonical',
        'distinct_legal_entity',
        'distinct_brand'
      )
    ),
  -- Chosen operator_id when decision='match'. Loose UUID (not FK) because
  -- a future merge could replace the target before the row commits — we
  -- want the audit trail to survive the merge.
  llm_decision_target UUID,
  llm_confidence NUMERIC(3, 2)
    CHECK (
      llm_confidence IS NULL
      OR (llm_confidence >= 0.0 AND llm_confidence <= 1.0)
    ),

  -- Firecrawl scrape audit. Each entry: {url, fetched_at, content_hash, content_length}.
  firecrawl_pages JSONB,

  -- LLM evidence — verbatim_quotes + reasoning + model + scraped_at.
  llm_evidence JSONB,

  -- Validation gate result. true if every cited URL appears in
  -- firecrawl_pages AND every quote is a verbatim substring of its page.
  citation_validated BOOLEAN,

  -- Cost tracking for the budget cap. Driver totals API + Firecrawl spend.
  cost_estimate_usd NUMERIC(8, 4),

  -- Failure-mode storage. Filled when status='failed'.
  error_message TEXT,

  -- Run grouping. --auto-approve-all bypass writes a distinct run_id so the
  -- override is auditable in evidence.
  run_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One checkpoint row per (input_review_id, input_step) combo. The driver
  -- claims work via SELECT ... FOR UPDATE SKIP LOCKED on this UNIQUE.
  UNIQUE (input_review_id, input_step)
);

CREATE INDEX IF NOT EXISTS idx_operator_llm_er_checkpoint_status
  ON public.operator_llm_er_checkpoint(status);

CREATE INDEX IF NOT EXISTS idx_operator_llm_er_checkpoint_step
  ON public.operator_llm_er_checkpoint(input_step);

CREATE INDEX IF NOT EXISTS idx_operator_llm_er_checkpoint_run
  ON public.operator_llm_er_checkpoint(run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operator_llm_er_checkpoint_resumable
  ON public.operator_llm_er_checkpoint(status, last_attempt_at)
  WHERE status IN ('queued', 'failed', 'in_progress');

COMMENT ON TABLE public.operator_llm_er_checkpoint IS
  'Track 6 Step 2c.5 Phase 2 checkpoint state. One row per (input_review_id, input_step). Lifecycle: queued → in_progress → completed → (ready_for_review | committed) | failed. Driver: scripts/llm-er-pass-firecrawl.ts.';
