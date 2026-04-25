# S3 storage tier strategy

**Status**: v1 — 2026-04-25
**Scope**: Storage class choice for raw archive data in `s3://osa-dumont-backup/raw/...`. Does not cover canonical / silver / gold tables — those live in Supabase Postgres and follow database tier strategy, not S3 strategy.
**Bucket**: `osa-dumont-backup`

---

## Why this doc

The convention was previously implicit across four ingestion scripts. Every new archive script forced the question to be re-litigated in plan review. This doc codifies the rule so it's grep-able for future sessions and the question stops surfacing.

## Three-tier rule

### GLACIER — large rebuild-only raw blobs

For files where lifetime size dominates the cost equation and access is strictly rebuild-only.

- **Threshold**: > ~1 GB lifetime size **and** read only when rebuilding canonical / silver from scratch
- **Latency tradeoff accepted**: minutes to hours of retrieval delay is fine for rebuild work; not fine for daily iteration
- **Cost-saving justification**: at multi-GB scale the Glacier discount (~84% off STANDARD) outweighs retrieval fees and the 90-day minimum-duration penalty

### STANDARD (interactive read path)

For files in an interactive or routine read path — anything that gets touched by ingest cycles, resolver runs, or DuckDB queries against parquet shards.

- **Threshold**: read on every ingest run, every backfill cycle, or every analytical query
- **Latency tradeoff accepted**: none — sub-second retrieval is required
- **Cost**: trivial relative to compute / data engineering time saved

### STANDARD (small structured archives)

For periodic-ingest archive sources where retrieval friction outweighs the ~$0/year cost saving Glacier would provide.

- **Threshold**: lifetime size < ~100 MB
- **Why STANDARD wins at this scale**: at <100 MB lifetime, Glacier saves single-digit dollars per year. A single rebuild that has to retrieve all objects from Glacier Flexible Retrieval costs more than 10+ years of STANDARD storage at this size, plus introduces minutes-to-hours of restore latency on a path that's already CPU-bound during canonical rebuilds.
- **Cost math** (us-east-1, 2026): STANDARD = $0.023/GB-month → 100 MB = $0.028/year; Glacier Flexible = $0.0036/GB-month + retrieval fees + 90-day minimum duration → savings under a dollar a year, retrieval cost exceeds savings on the first restore.

## Decision rubric

When adding a new archive script, walk this rubric:

1. **Estimated lifetime size > ~1 GB AND access is rebuild-only?** → **GLACIER**
2. **Otherwise** → **STANDARD**
3. **When in doubt, default STANDARD.** Tier promotion later is a `CopyObject` loop. Tier demotion mid-iteration during a Glacier restore wait is the failure mode worth avoiding.

## Worked examples

Current scripts and their tier choices, all consistent with the rule above:

| Script | Files | Tier | Why |
|---|---|---|---|
| `src/ingestion/archive-adsb-raw.ts` | Daily ADS-B tars (~GB/day, multi-TB lifetime) | **GLACIER** | Rebuild-only; lifetime size dominates |
| `src/ingestion/archive-adsb-raw.ts` | Per-day manifests (KB each) | **STANDARD** | Read every backfill cycle to know what's been archived |
| `src/ingestion/archive-faa-raw.ts` | FAA registry nightly zip (~70 MB compressed, GB+ lifetime) | **GLACIER** | Rebuild-only; lifetime size dominates after months of dailies |
| `src/ingestion/archive-faa-raw.ts` | FAA airmen monthly zip (smaller, periodic) | **STANDARD** | Small structured archive; retrieval friction > cost saving |
| `src/ingestion/package-positions.ts` | Parquet shards | **STANDARD** | DuckDB read path; analytical queries |
| `src/ingestion/archive-faa-d085-wayback.ts` | Page HTML, manifests, `_index.json` | **STANDARD** | Read every canonical rebuild + provenance audit path |
| `src/ingestion/archive-faa-d085-wayback.ts` | xlsx files (12 unique, ~6.5 MB total) | **STANDARD** | Small structured archive; same precedent as airmen zip |

## Out of scope

- **Canonical / silver / gold tables** live in Supabase Postgres. Their tiering follows database strategy (`docs/data-architecture.md`), not S3 strategy.
- **Bronze rows in Postgres** (e.g. `raw_*` tables, when present) follow database strategy.
- **Backups of Postgres itself** to S3 — separate decision, not covered here.

## References

- `docs/data-architecture.md` — overall medallion architecture, Postgres + DuckDB hybrid
- `src/ingestion/archive-adsb-raw.ts` — Glacier + Standard split, worked example
- `src/ingestion/archive-faa-raw.ts` — registry vs airmen tier split, worked example
- `src/ingestion/archive-faa-d085-wayback.ts` — D085 archive (this rule's most recent application)
