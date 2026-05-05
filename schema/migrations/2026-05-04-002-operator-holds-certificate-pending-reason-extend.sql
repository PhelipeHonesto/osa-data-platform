-- 2026-05-04-002: Track 6 Step 2c.5 Phase 2 P.2 → A.0.6 — extend the
-- `reason` CHECK on canonical.operator_holds_certificate_pending to allow
-- `lookalike_misresolution` in addition to the existing
-- `no_canonical_operator_candidate`.
--
-- Context: A.0.5 audit (.work/llm-er-pass/a0-step2c-lookalike-audit-2026-05-04.md)
-- identified 5 distinct false-positive lookalike misresolutions in the
-- Step 2c high-tier output (Executive Flight vs Executive Jet, Corporate
-- Aircraft vs Corporate Flight, etc.). A.0.6 quarantines those 6 polluted
-- rows by moving them to the pending sidecar with the new reason value.
--
-- Original Step 2c was designed to write to pending only when no canonical
-- operator candidate was found ('no_canonical_operator_candidate'). That
-- single-value CHECK was correct for that use case. Extending the enum is
-- preferred over creating a sibling table — the pending sidecar is the
-- canonical "needs-human-review" overflow for cert ↔ operator assignments,
-- and lookalike misresolutions belong to that same review queue.
--
-- Per the CLAUDE.md §4 three-step migration verification rule:
--   1. Local Docker Postgres rollback test.
--   2. npm run db:migrate-pg against Supabase.
--   3. Production verification via psql \d+ canonical.operator_holds_certificate_pending.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT. Re-applying re-creates
-- the same constraint shape.

ALTER TABLE canonical.operator_holds_certificate_pending
  DROP CONSTRAINT IF EXISTS operator_holds_certificate_pending_reason_check;

ALTER TABLE canonical.operator_holds_certificate_pending
  ADD CONSTRAINT operator_holds_certificate_pending_reason_check
  CHECK (reason IN (
    'no_canonical_operator_candidate',
    'lookalike_misresolution'
  ));
