-- Rollback for migration 2026-05-04-003 — restore the original resolver_action
-- enum on canonical.operator_aircraft_resolution_log (drop the three
-- cert_bridge_* values).
--
-- WARNING: this rollback will FAIL if any rows currently have
-- resolver_action IN ('cert_bridge_linked','cert_bridge_skipped_overlap',
-- 'cert_bridge_skipped_already_linked'). Either DELETE those rows, or update
-- their resolver_action — but those are the only honest labels for cert-bridge
-- attempts, so the better path is to delete them or move to a different table.
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.

ALTER TABLE canonical.operator_aircraft_resolution_log
  DROP CONSTRAINT IF EXISTS operator_aircraft_resolution_log_resolver_action_check;

ALTER TABLE canonical.operator_aircraft_resolution_log
  ADD CONSTRAINT operator_aircraft_resolution_log_resolver_action_check
  CHECK (resolver_action IN (
    'matched',
    'matched_blocked_operator_type',
    'review',
    'no_match',
    'exact',
    'skipped_null',
    'skipped_placeholder',
    'skipped_individual',
    'skipped_trustee',
    'skipped_manufacturer'
  ));
