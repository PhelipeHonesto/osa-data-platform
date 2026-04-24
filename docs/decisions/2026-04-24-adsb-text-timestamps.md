# ADR — `adsb_completed_legs` TEXT timestamps

**Status**: Accepted — 2026-04-24
**Owner**: Phelipe Honesto
**Scope**: Defer the TEXT→TIMESTAMP fix on `public.adsb_completed_legs.departure_time` / `arrival_time` to Phase 12 (dbt migration). Do not add a functional index in Stage 2.

---

## Context

`public.adsb_completed_legs` has 21,003,038 rows as of 2026-04-24. `departure_time` and `arrival_time` are stored as `TEXT` (ISO-8601 strings), not `TIMESTAMPTZ`. Every temporal filter today casts on read:

```sql
WHERE departure_time >= '2026-03-01' AND departure_time < '2026-04-01'
```

This works because ISO-8601 strings sort lexically in the same order as their timestamp equivalents, but it's fragile (any source that emits a different format breaks it) and it burns I/O on string comparison at scale.

The operator_aircraft_link temporal join — the reason aircraft ER exists — needs to filter legs by a date window to find the operator valid at leg time:

```sql
SELECT l.icao_hex, oal.operator_id
FROM adsb_completed_legs l
JOIN canonical.aircraft a ON a.icao_hex = l.icao_hex
JOIN canonical.operator_aircraft_link oal
  ON oal.aircraft_id = a.aircraft_id
 AND oal.role = 'operator'
 AND (l.departure_time::timestamp >= oal.valid_from)
 AND (oal.valid_to IS NULL OR l.departure_time::timestamp < oal.valid_to)
```

That cast on every row is not free at 21M scale.

## Options considered

### (a) Functional index on the cast

```sql
CREATE INDEX CONCURRENTLY idx_adsb_completed_legs_departure_ts
  ON adsb_completed_legs ((departure_time::timestamp));
```

- Build cost: rough estimate 2–4 GB index size, 15–45 minutes build time on Supabase at 21M rows, competing with live writes from `adsb:live` worker.
- Query cost: eliminates per-row cast during index scan, same cost on sequential scans.
- Maintenance cost: every INSERT/UPDATE to `departure_time` recomputes the functional expression. Live ingest pays the tax forever.
- Reversibility: easy (DROP INDEX), but the build is expensive enough that "oops undo" isn't cheap in wall-clock.

### (b) Defer to Phase 12 dbt migration

- Phase 12 (per `docs/data-platform-plan.md`) migrates wingx-engine off of `adsb_completed_legs` and onto dbt staging models. A `stg_adsb_completed_legs` model will CAST TEXT → TIMESTAMPTZ once during materialization, landing a properly-typed silver table that all downstream queries (wingx marts, temporal joins) read from.
- No cost today. Cost deferred to Phase 12 (a one-time materialize of 21M rows, not an index that stays hot).
- Risk: every query between now and Phase 12 keeps casting. Acceptable because those queries are batch-analytical, not hot-path.

### (c) Alter the column in place

`ALTER TABLE adsb_completed_legs ALTER COLUMN departure_time TYPE TIMESTAMPTZ USING departure_time::timestamptz` — rewrites every row, takes an ACCESS EXCLUSIVE lock, blocks all reads and writes for the duration. On 21M rows that's 30+ minutes of downtime. Not acceptable.

## Decision

**(b) — defer to Phase 12.**

Reasons:

1. No hot-path query today uses the cast. The operator_aircraft_link join is not being run against legs in Stage 2a — that's Stage 2b (backfill) at the earliest, and even then it's a one-time batch job, not a live query.
2. `wingx-engine` runs monthly in batch. A cast per row on a sequential scan of one month's worth of legs (~1.8M rows) is ~15 seconds of CPU — acceptable for a batch job.
3. Phase 12 will re-land `adsb_completed_legs` as a dbt source with a properly-typed `stg_adsb_completed_legs` materialization. Spending index-build time now on a column we plan to stop reading directly within the same quarter is wasted effort.
4. The functional-index approach leaves the TEXT column in place, which means a second migration is still required later to actually fix the type. We'd pay the cost twice.

## Consequences

- Any new query that filters by `departure_time` in Stage 2a / 2b must tolerate the implicit lexical-sort dependency. Safe today because every writer emits ISO-8601 from `toISOString()`; flagged in `docs/known-issues.md`.
- Aircraft ER backfill (Stage 2b) will do the cast in Python/TS batch code, not in SQL, if performance warrants. This is a TODO for the Stage 2b plan.
- Phase 12 (dbt migration) becomes load-bearing for the operator_aircraft_link → legs join. Not blocking Stage 2a, but the agent-facing views that read through the temporal link must not be built until dbt-staged legs exist.

## Revisit criteria

If any of these become true, reopen this decision:

- A hot-path (user-facing) query starts filtering `adsb_completed_legs.departure_time` with a per-row cast
- Phase 12 slips past Q3 2026
- The ADS-B live worker changes timestamp format such that lexical sort diverges from temporal sort

## References

- `docs/data-platform-plan.md` — Phase 12 dbt migration plan
- `docs/er/aircraft.md` — aircraft ER spec (Stage 2a)
- `docs/temporal-link-pattern.md` — operator_aircraft_link shape
- `src/analytics/wingx-engine.ts` — current consumer of the TEXT timestamps
