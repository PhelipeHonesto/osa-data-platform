# Rollback SQL

Down-migrations for the forward migrations in `schema/` and `schema/migrations/`.

**Not loaded by `src/db/migrate-pg.ts`.** `migrate-pg` only reads directories listed in its `LOAD_ORDER`. This directory is intentionally excluded so rollback files never apply during a normal migration run.

## Apply manually when you need to revert

```
psql "$OSA_MCP_WRITE_URL" -f schema/rollback/YYYY-MM-DD-NNN-<name>-rollback.sql
```

Each file is idempotent (`DROP ... IF EXISTS`). Re-applying is safe.

## Contents

- `2026-04-24-001-canonical-aircraft-rollback.sql` — drops `canonical.aircraft`, `canonical.aircraft_identities`, `canonical.aircraft_aliases`. Drops `canonical` schema only if empty.
- `2026-04-24-002-canonical-operator-aircraft-link-rollback.sql` — drops `canonical.operator_aircraft_link`. Apply **before** the 001 rollback if rolling back both (the link table FKs into `canonical.aircraft`).
- `2026-05-04-001-operator-llm-er-checkpoint-ground-truth-rollback.sql` — drops the `ground_truth_outcome` column (and its CHECK constraint) from `public.operator_llm_er_checkpoint`. Safe to apply standalone — column is NULLable and unreferenced by FKs.
- `2026-05-04-002-operator-holds-certificate-pending-reason-extend-rollback.sql` — restores the original single-value `reason` CHECK on `canonical.operator_holds_certificate_pending`. **WILL FAIL if any rows have `reason='lookalike_misresolution'`** — move those rows out (or delete) before applying.
- `2026-05-04-003-operator-aircraft-resolution-log-cert-bridge-actions-rollback.sql` — restores the original 10-value `resolver_action` CHECK on `canonical.operator_aircraft_resolution_log`. **WILL FAIL if any rows have `resolver_action IN ('cert_bridge_linked','cert_bridge_skipped_overlap','cert_bridge_skipped_already_linked')`** — DELETE those rows before applying.
