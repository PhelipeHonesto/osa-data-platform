# Phase 7 Rebuild Runbook

Replaces the contaminated `adsb_completed_legs` (see `docs/known-issues.md`)
with clean legs detected by the fixed `adsblol-ingest.ts` (commit
8a09e23). Reads tars from S3 (restored out of Glacier per
`docs/archive/2026-04/phase7-restore-log.md`) rather than re-downloading from GitHub.

## When to run

- Glacier restore is complete. Verify with:
  ```
  npx tsx scripts/s3-bulk-restore.ts --check
  ```
  100% of the 1,811 requested objects should show `ongoing-request="false"`.
  Expect this 5-12h after `--execute` was issued.
- 3-5 hours of wall-clock time available. S3-first throughput is
  ~100-150 MB/s same-region, so the ~2.4 TB of tars process much faster
  than the original ~33-hour GitHub pull, but per-day extract +
  leg-detect work is unchanged.
- Sentry operational (so failures page automatically).
- `docs/archive/2026-04/phase7-schema-apply.md` ALTER statements applied to Supabase
  (one-time, per-check verify columns).

## Pre-flight

```
set -a && source .env && set +a
npx tsx scripts/phase7-preflight.ts
```

Seven checks with ✓/✗:
1. `SUPABASE_DATABASE_URL` set
2. Postgres reachable (`SELECT 1`)
3. Glacier restore complete (reads `scripts/s3-restore-state.json`)
4. Current `adsb_completed_legs` row count (informational — will be deleted)
5. `backfill_progress` status breakdown
6. `/tmp` has ≥ 5 GB free
7. S3 `ListObjects` on `raw/adsb/` works

All green → the script prints the exact rebuild command and exits 0.
Any red → fix the suggested item and re-run.

## The rebuild

### 1. Nuke contaminated legs (Supabase SQL Editor)

```sql
-- 5.9M rows — expect ~1-2 minute delete
DELETE FROM adsb_completed_legs;

-- Reset backfill_progress so every day re-runs
UPDATE backfill_progress
SET status = 'pending',
    legs_found = 0,
    charter_legs = 0,
    duration_seconds = 0;
```

Verify:
```sql
SELECT COUNT(*) FROM adsb_completed_legs;                     -- 0
SELECT status, COUNT(*) FROM backfill_progress GROUP BY status; -- all pending
```

### 2. Run S3-first backfill

Wrap in `tmux` (so the run survives closing the terminal) and `caffeinate`
(so macOS doesn't sleep mid-run):

```
tmux new -s phase7
cd ~/osa/dumont-agent
set -a && source .env && set +a

caffeinate -dims \
  env DATABASE_TYPE=postgres \
  npx tsx src/ingestion/history-backfill.ts \
    --from 2023-12-30 --to 2026-04-13 --s3-only 2>&1 \
    | tee ~/phase7-rebuild.log
```

`caffeinate -dims` flags: display (d), idle (i), disk (m), system (s) —
keeps the machine awake through the full 3-5 hour run.

`DATABASE_TYPE` is an **env var**, not a CLI flag — `history-backfill.ts`
reads `process.env.DATABASE_TYPE` and throws if it isn't `postgres`.

Detach tmux: `Ctrl+b` then `d`. Reattach: `tmux attach -t phase7`.

Why `--s3-only`: fails fast if any day isn't in S3 rather than silently
falling back to the 40 MB/s GitHub path. All 1,114 expected days are in
the archive, so nothing should skip.

Expected runtime: ~3-4 hours. Progress is visible in the tail of the log
and in `backfill_progress` (one row per day, status transitions
`pending → processing → complete`).

### 3. Verify (now automatic)

```
npx tsx scripts/phase7-verify.ts
```

Runs 7 quality checks against the rebuilt table, persists each result
to `data_quality_runs` (grouped by `run_id`), and alerts via Sentry on
any failure.

On PASS:
```
REBUILD PASSES: 7/7 checks
```
Exit 0. Ready for Phase 8 (analytics rebuild on the clean legs).

On FAIL:
```
REBUILD NEEDS REVIEW: N/7 checks failed
Details in data_quality_runs (run_id=...) and Sentry (if SENTRY_DSN set)
```
Exit 1. Each failing check has a Sentry issue tagged
`component=phase7-verify` with the threshold, actual value, and full
context in extras.

## Rollback

- Kill with `Ctrl-C`. `backfill_progress` tracks per-day status, so
  any day mid-processing gets left at `processing` or `failed`.
- **Do NOT naively re-run.** `bulkInsertLegs` is a plain INSERT — partial
  legs from a half-done day are already committed. Re-running that day
  would duplicate them. See "Recovery from crash mid-rebuild" below for
  the correct procedure.
- If the whole run goes sideways, the step-1 `DELETE` + `UPDATE` can be
  re-applied to start clean.

## Recovery from crash mid-rebuild

If the rebuild crashes, you Ctrl-C, or the Mac sleeps mid-day, some days
will be left in `processing` status with partial legs inserted for them.
Re-running without cleanup causes duplicate legs (each chunk of 500
trace files commits its legs independently, and `id` is SERIAL so
there's no natural key to dedupe on).

### Step 1 — Find half-done days

In Supabase SQL editor:

```sql
SELECT date, status
FROM backfill_progress
WHERE status IN ('processing', 'failed');
```

Note the dates returned.

### Step 2 — Delete their partial legs

```sql
DELETE FROM adsb_completed_legs
WHERE departure_time::date = ANY(
  ARRAY['2024-06-15', '2024-06-16']::date[]  -- your actual dates
);
```

### Step 3 — Reset those days to pending

```sql
UPDATE backfill_progress
SET status = 'pending',
    legs_found = 0,
    charter_legs = 0,
    duration_seconds = 0
WHERE status IN ('processing', 'failed');
```

### Step 4 — Re-run the same backfill command

Already-complete days are skipped (`isDayComplete` only returns true for
`status = 'complete'`). Only the reset days get reprocessed.

## Monitoring mid-run

The rebuild doesn't print a global progress bar. Two ways to check:

**From tmux** — the date being processed appears in every log line:
```
tmux attach -t phase7    # see current day; detach with Ctrl+b d
```

**From a second shell via Supabase**:
```sql
SELECT status, COUNT(*) AS days, MAX(date) AS latest_date
FROM backfill_progress
GROUP BY status
ORDER BY status;
```

Expected progression: `complete` rows grow, `pending` shrinks, and
`latest_date` advances from `2023-12-30` toward `2026-04-13`.

Expected final state: **836 rows total**, all `complete`, 0 `pending`,
0 `failed`, 0 `processing`.

If the final total is fewer than 836, some days silently skipped — most
likely a transient S3 list error. See the `--s3-only` behavior note in
`history-backfill.ts:processDay` and rerun those dates directly.

## Success criteria

All 7 checks pass in `scripts/phase7-verify.ts`:

| # | Check | Threshold |
|---|-------|-----------|
| 1 | `phase7_leg_count` | 5M ≤ count ≤ 10M |
| 2 | `phase7_no_impossibly_long_flights` | count(`flight_time_min > 720`) < 100 |
| 3 | `phase7_no_midnight_cluster` | count(`departure_time` at 00:00:00-00:00:10 UTC) < 1000 |
| 4 | `phase7_hour_distribution_spread` | no single hour > 3× median of 24 hour counts |
| 5 | `phase7_flight_time_distribution` | avg ∈ [60,180] min, max ∈ [400,900] min |
| 6 | `phase7_days_covered` | distinct departure dates ≥ 700 |
| 7 | `phase7_backfill_progress_complete` | `complete` ≥ 700, `pending` == 0, `failed` == 0 |

When all pass:
- Update `docs/known-issues.md` to remove the contamination flag.
- Proceed to Phase 8 (analytics rebuild).
- `data_quality_runs` now has a permanent PASS record with `run_id`,
  queryable as the baseline for future weekly quality runs.

## Related docs

- `docs/known-issues.md` — what contamination looks like
- `docs/archive/2026-04/phase7-timestamp-bugfix.md` — the underlying fix
- `docs/archive/2026-04/phase7-restore-log.md` — Glacier bulk restore
- `docs/archive/2026-04/phase7-schema-apply.md` — one-time Supabase ALTER for verify columns
- S3-first ingestion path: see the header comments in
  `src/ingestion/history-backfill.ts` (no separate doc).
