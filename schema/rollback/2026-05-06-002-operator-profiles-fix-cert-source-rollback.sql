-- Rollback for migration 2026-05-06-002 — re-add the FK to faa_operators.
-- (This restores 001's state, which is itself wrong; rolling further back
-- means running the 001 rollback file too.)
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
-- Idempotent.

ALTER TABLE public.operator_profiles
  ADD CONSTRAINT operator_profiles_faa_cert_number_fkey
    FOREIGN KEY (faa_cert_number) REFERENCES public.faa_operators(certificate_number) ON DELETE CASCADE;
