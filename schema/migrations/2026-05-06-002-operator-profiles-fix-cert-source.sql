-- 2026-05-06-002: Fix operator_profiles cert source (followup to 001).
--
-- 2026-05-06-001 added a FK from operator_profiles.faa_cert_number to
-- public.faa_operators(certificate_number). Bench-verification surfaced
-- that public.faa_operators is the WRONG source: it uses synthetic 7-char
-- IDs (KSMR001, WHEE001, WUP) ingested from a different upstream, with
-- 0-row overlap to canonical.certificates.faa_cert_number which uses the
-- actual 4-char FAA designators (W6JA, B8MA, VQMA) and is the source of
-- truth for the platform's cohort of 1,989 active Part 135 certs.
--
-- This migration:
--   1. Drops the FK to public.faa_operators(certificate_number).
--   2. Leaves faa_cert_number as TEXT PRIMARY KEY without a FK.
--      (canonical.certificates.faa_cert_number has no UNIQUE constraint
--      yet, so we can't FK to it cleanly. Validation happens at the
--      profile-builder script layer.)
--
-- Forward note: a future migration could add UNIQUE on
-- canonical.certificates(faa_cert_number) WHERE faa_cert_number IS NOT NULL
-- and re-add the FK. Out of scope for V1.
--
-- Per CLAUDE.md three-step verification rule, this is verified via:
--   1. (skipped — local Docker; isolated DDL change)
--   2. npm run db:migrate-pg against Supabase
--   3. psql verification that the FK constraint is gone

ALTER TABLE public.operator_profiles
  DROP CONSTRAINT IF EXISTS operator_profiles_faa_cert_number_fkey;
