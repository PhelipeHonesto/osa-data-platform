# Schema layout

SSOT for the Dumont Postgres schema, split by layer per Schema Evolution Rule 1 (`docs/data-architecture.md`).

## Layout

```
src/memory/schema/
  _extensions.sql       — CREATE EXTENSION statements; loaded first
  silver/               — ingested data (FAA, ADS-B, NTSB, scrapers)
  gold/
    canonical/          — entity-resolved master data (Phase 1+)
    views/              — agent-facing materialized views (Phase 2+)
  transactional/        — app-born data (deals, messages, calls, ops state)
  analytics/            — derived aggregates (knowledge_graph, WINGX-like)
  migrations/           — forward migrations, YYYY-MM-DD-NNN-<kebab-name>.sql
```

Medallion applies to ingested data (Bronze/Silver/Gold). Transactional and analytics sit alongside — they're born in the app or derived from it, not ingested.

## How it's loaded

`src/memory/migrate-pg.ts` concatenates the files in deterministic order (extensions → transactional → silver → analytics → gold → migrations) and executes against Supabase. Every statement is `CREATE ... IF NOT EXISTS`, so re-applying is idempotent.

## Adding a new table

- **Ingested from a new source**: add to `silver/<source>.sql` (or create a new file if it's its own domain).
- **Canonical entity**: add to `gold/canonical/<entity>.sql`.
- **Agent-facing view**: add to `gold/views/<entity>-views.sql`.
- **Schema change to an existing table**: add a migration in `migrations/YYYY-MM-DD-NNN-<kebab-name>.sql` — don't mutate the original file's `CREATE TABLE`.
