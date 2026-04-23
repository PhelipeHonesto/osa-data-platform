# Known Issues — Phase 7 Rebuild Closeout

## Data Coverage

### Permanent S3 gaps (17 days, not recoverable)

adsb.lol did not publish ADS-B data for these dates. No amount of reprocessing will recover them.

- 2023-12-31
- 2024-12-31
- 2025-05-28 through 2025-06-10 (14 consecutive days — adsb.lol outage)
- 2025-12-31

**Pattern:** adsb.lol consistently misses December 31st annually (likely scheduled maintenance). Future daily ingestion pipelines should not alert on Dec 31 failures.

### Failed ingestion days (7 days, recoverable in osa-data-platform)

| Date       | Duration | Root cause                                    |
|------------|----------|-----------------------------------------------|
| 2025-10-15 | 159s     | Tar reassembly truncation (S3 bytes intact)   |
| 2026-03-02 | 218s     | OOM (pre-4GB heap fix)                        |
| 2026-03-10 | 243s     | OOM (pre-4GB heap fix)                        |
| 2026-03-26 | 285s     | ON CONFLICT batch dedup bug                   |
| 2026-03-27 | 262s     | ON CONFLICT batch dedup bug                   |
| 2026-04-06 | 241s     | ON CONFLICT batch dedup bug                   |
| 2026-04-13 | 733s     | ON CONFLICT batch dedup bug                   |

Retry path: fix the ON CONFLICT bug in osa-data-platform, then reingest these 7 days from S3.

## Deleted Data

### 103 impossibly-long legs (flight_time_min > 1440)

Deleted 2026-04-23. All 103 had flight_time_min between 1441 and 2842 minutes (24h to 47h), which exceeds physical limits for any civilian aircraft.

Analysis of remaining long flights (1000-1440 min range) showed these are legitimate operations:
- UPS cargo 747s/MD-11s (Alaska-Asia routes, 18-22h)
- Delta Air Lines cargo
- Mike Smith Aviation (ferry operations)
- Helicopter / Cessna ferry operators

The 103 deleted legs were near-certainly data artifacts from leg-stitching errors at ADS-B coverage gaps. None were military aircraft (charter-eligible FAA filter excludes military).

**Rationale:** Chose data integrity (enforce physical plausibility cap at 24h) over preservation of ambiguous artifacts.

## Deferred Work

### Full reingestion (not blocking Phase 3)

**Trigger condition:** When leg-stitching algorithm improvements land in osa-data-platform AND Glacier restore window is refreshed.

**Scope:** ~2-3% of legs (12-24h bucket) may contain stitching artifacts from ADS-B coverage gaps. Difficult to distinguish from legitimate ultra-long-haul.

**Cost:** ~6 days of continuous reingestion of all 812 complete days.

**Prerequisite steps:**
1. Phase 3 split complete (ingestion code in osa-data-platform)
2. ON CONFLICT batch dedup bug fixed
3. Leg-stitching algorithm improvements implemented
4. Fresh Glacier bulk restore covering full date range
5. TEXT → timestamptz schema migration complete

**Tracking:** Add to osa-data-platform backlog immediately after repo creation. Do not lose this.

### Schema debt (defer to osa-data-platform)

1. **`departure_time` and `arrival_time` stored as TEXT** — should be `timestamptz`. Blocks native date indexing, causes statement timeouts on large aggregates.

2. **No batch deduplication before upsert** — causes ON CONFLICT errors on dense days. Fix: `DISTINCT ON (conflict_key)` pre-upsert.

3. **No `operators_canonical` table** — `operator_name` is free text, unqueryable for exact operator matching. Fix: entity resolution pipeline in osa-data-platform.

4. **No `aircraft_canonical` table** — aircraft type strings vary. Fix: canonicalization in osa-data-platform.

## Architecture Principles (for osa-data-platform)

### Medallion (Bronze / Silver / Gold)

Every external data source follows this pattern:

1. **Bronze (raw, immutable):** S3 Glacier, dated path structure, source of truth
2. **Silver (operational):** Supabase Postgres, normalized, deduplicated, typed
3. **Gold (analytical):** S3 Standard Parquet, partitioned by year/month, DuckDB-queryable

**Non-negotiable:** No external data enters Silver without Bronze archive first. Bronze paths include snapshot date even for "current state" data.

### Knowledge graph + vector search

Both live in Supabase alongside relational data:
- `entity_edges` table for graph relationships (operator → aircraft → owner)
- pgvector extension for semantic similarity (deal matching, ER fuzzy matching)

Dedicated graph DB not needed at OSA's current scale.

### Query-time filtering for consumers

The data platform stores global, unfiltered data. Consumers (Dumont, Charter Index, Loud Hawk) apply their own filters at query time via views and operator canonical IDs. Never filter at ingestion beyond minimal ICAO-hex charter-eligibility.

## Rebuild Session Lessons

1. **Disk monitoring non-optional.** Silent disk-fill on Aug 2025 triggered the rebuild; Lightsail needs a threshold alarm.
2. **Node heap default is too small for JSON-heavy workloads.** Always set `NODE_OPTIONS='--max-old-space-size=4096'` for ingestion scripts.
3. **Large-file `cat` operations can be interrupted silently.** Use `nohup ... &` for reassembly of multi-GB files.
4. **Empirical thresholds only work at scale you've tested.** Express quality checks as ratios or conditions, not absolute counts.
5. **Permanent data gaps are real.** Design for them; do not treat as failure.
