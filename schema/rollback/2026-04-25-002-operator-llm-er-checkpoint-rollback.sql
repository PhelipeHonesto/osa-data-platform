-- Rollback for migration 2026-04-25-002 — drops public.operator_llm_er_checkpoint.
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
--
-- Idempotent: DROP TABLE IF EXISTS, indexes are dropped automatically with
-- the table. Re-applying is safe.

DROP TABLE IF EXISTS public.operator_llm_er_checkpoint CASCADE;
