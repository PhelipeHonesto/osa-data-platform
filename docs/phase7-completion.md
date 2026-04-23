# Phase 7 Rebuild — Completion Record

**Closed:** 2026-04-23

## Final dataset state

- **21,003,038 legs** in `adsb_completed_legs`
- **812 complete days** (out of 836 in range 2023-12-30 → 2026-04-13)
- **17 permanent S3 gaps** (adsb.lol didn't publish; not recoverable)
- **7 failed ingestion days** (documented bugs, recoverable in osa-data-platform)
- **1,083,257 charter-relevant legs** (filtered by FAA charter-eligible ICAO hex list)

## What was rebuilt

The original `adsb_completed_legs` table was contaminated by a bug in `adsblol-ingest.ts` (timestamp handling). Phase 7 rebuilt the entire table from S3 archives of adsb.lol tars, using the fixed ingestion path in `history-backfill.ts --s3-only`.

Source data was bulk-restored from S3 Glacier for the duration of the rebuild. Restore window: 2026-04-15 through 2026-04-25.

## What was preserved

- Bronze layer intact: all 1.3TB of tar archives remain in S3 Glacier
- Source of truth unchanged: any future reingestion pulls from the same S3 paths
- Full day-level provenance: `backfill_progress` table tracks status per day with error context

## What's deferred to osa-data-platform

See [known-issues.md](./known-issues.md) for the full list. Highlights:

- Leg-stitching algorithm refinement (fixes ~2-3% edge cases)
- ON CONFLICT batch dedup bug (unblocks retry of 4 failed days)
- TEXT → timestamptz schema migration
- Entity resolution (operators_canonical, aircraft_canonical)
- Full reingestion after bug fixes land

## Verification

Phase 7 verify (`scripts/phase7-verify.ts`) passes 7/7 checks with thresholds calibrated for global-scale data. See `data_quality_runs` table for historical run records.

## What this unblocks

Phase 3 repo split (dumont-agent ↔ osa-data-platform) is no longer blocked. The data platform can now be extracted as a separate repo with its own concerns: ingestion, entity resolution, medallion architecture, daily pipelines, analytical layer.
