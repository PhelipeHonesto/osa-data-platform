-- Rollback for migration 2026-04-25-001 — restores cert_transfer to the
-- CHECK list on canonical.operator_events.event_type.
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.

DO $$
DECLARE
  cname TEXT;
BEGIN
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
    'cert_transfer',
    'cert_surrender',
    'cert_revocation',
    'dissolution',
    'formation',
    'aoc_change'
  ));
