-- 2026-05-04-003: Track 6 Step 2d (Session A.1) — extend the resolver_action
-- enum on canonical.operator_aircraft_resolution_log to record cert-bridge
-- derivation outcomes.
--
-- The current enum captures the original Step 2c operator-name resolution
-- semantics (matched / review / no_match / exact / skipped_*). Cert-bridge
-- (faa_d085_via_cert_bridge) operates on a different mechanism — it joins
-- canonical.aircraft_on_certificate × canonical.operator_holds_certificate
-- on cert_id, projecting cert authorization through to operator-of-record
-- attribution. The outcomes are different:
--
--   cert_bridge_linked:                   row inserted to operator_aircraft_link.
--   cert_bridge_skipped_overlap:          EXCLUDE-constraint violation — another
--                                         writer already owns the (aircraft, role,
--                                         daterange). Stage 2c v2 cross-pathway
--                                         corroboration is documented but not
--                                         implemented; we skip and log.
--   cert_bridge_skipped_already_linked:   NOT EXISTS pre-filter rejected before
--                                         attempting INSERT (a row with the same
--                                         shape already exists from cert-bridge
--                                         re-run, or from a prior writer with the
--                                         same source).
--
-- Per CLAUDE.md §3 (Invariant 9): operator_aircraft_resolution_log is
-- permanent canonical, never staging. One audit log per resolution pathway
-- is the right shape — extending the enum is preferred over creating a
-- sibling cert-bridge-only log.
--
-- Per CLAUDE.md §4 three-step verification:
--   1. Local Docker Postgres rollback test.
--   2. npm run db:migrate-pg against Supabase.
--   3. Production verification via psql \d+ canonical.operator_aircraft_resolution_log.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT. Re-applying
-- re-creates the same shape.

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
    'skipped_manufacturer',
    'cert_bridge_linked',
    'cert_bridge_skipped_overlap',
    'cert_bridge_skipped_already_linked'
  ));
