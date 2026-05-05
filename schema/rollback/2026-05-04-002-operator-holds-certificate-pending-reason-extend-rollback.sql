-- Rollback for migration 2026-05-04-002 — restore the original
-- single-value CHECK on canonical.operator_holds_certificate_pending.reason.
--
-- WARNING: this rollback will FAIL if any rows currently have
-- reason='lookalike_misresolution'. To unblock the rollback, first move
-- those rows out (or update their reason; but lookalike_misresolution is
-- the only honest label so the better path is to delete them or move to
-- a different table).
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.

ALTER TABLE canonical.operator_holds_certificate_pending
  DROP CONSTRAINT IF EXISTS operator_holds_certificate_pending_reason_check;

ALTER TABLE canonical.operator_holds_certificate_pending
  ADD CONSTRAINT operator_holds_certificate_pending_reason_check
  CHECK (reason = 'no_canonical_operator_candidate');
