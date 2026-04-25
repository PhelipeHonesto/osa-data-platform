-- 2026-04-25-001: Deprecate cert_transfer event_type on canonical.operator_events.
--
-- Certificate is now first-class (architectural decision logged 2026-04-25
-- in commit 3b37d7f). Cert lineage moves to canonical.certificate_events
-- (event-edge variant). This migration tightens the live CHECK constraint
-- to refuse new cert_transfer rows.
--
-- The SSOT file schema/canonical/operator_events.sql was updated in the
-- same commit. This migration handles the live table — CREATE TABLE IF
-- NOT EXISTS in the SSOT skips the existing table entirely, leaving the
-- old auto-named CHECK in place. Runs idempotent on re-apply (drops
-- whatever CHECK on event_type exists, re-adds the explicit-named one).

DO $$
DECLARE
  cname TEXT;
  row_count BIGINT;
BEGIN
  EXECUTE 'SELECT COUNT(*) FROM canonical.operator_events WHERE event_type = ''cert_transfer'''
    INTO row_count;
  IF row_count > 0 THEN
    RAISE EXCEPTION
      'canonical.operator_events has % cert_transfer rows — '
      'migrate them to canonical.certificate_events first.',
      row_count;
  END IF;

  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'canonical.operator_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%event_type%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE canonical.operator_events DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE canonical.operator_events
  ADD CONSTRAINT operator_events_event_type_check
  CHECK (event_type IN (
    'rebrand',
    'legal_rename',
    'acquisition',
    'merger',
    'spinoff',
    'cert_surrender',
    'cert_revocation',
    'dissolution',
    'formation',
    'aoc_change'
  ));
