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
