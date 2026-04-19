# OSA Data Architecture

> Status: **Target architecture, not yet implemented.**
> Current state: Silver-only (one table per source). Phase 1 of MDM migration planned.

## Motivation

OSA started with two primary data sources (FAA registry, ADS-B feed) and a handful of derived tables. That shape is already strained: today's attempt to sync 313 scraped ARGUS/Wyvern operator ratings into `faa_operators` returned **1 match out of 313** because each rating system uses its own internal ID (Wyvern `PRIA248H` ≠ FAA `1OCA082A`), and we had conflated source-specific IDs with a canonical operator identity. The code wasn't wrong; the data model was.

OSA's trajectory is more sources, not fewer — IS-BAO, Aviapages, NTSB cross-matches, for-sale-listings, client CRM, and the Loud Hawk editorial layer all land on the same operator/aircraft/route universe. Every new source brings different IDs, different name conventions, and different record granularity. Without a canonical layer that resolves "same real-world operator across five systems" once at ingest, every downstream feature (Sourcing agent ranking, ghost positioning, fleet intelligence) pays a compounding join tax and ships with quiet data gaps.

The second forcing function is AI agents. Dumont's Sourcing, Quote, and Scenario capabilities need to answer questions like "what do we know about NetJets?" with one table lookup, not a four-table JOIN the LLM has to author correctly every time. Per Zach Wilson's [AI-native modeling](https://blog.dataexpert.io/p/how-to-data-model-for-your-ai-context), "AI thrives at mapping question → appropriate dataset." Dimensional correctness at the base, question-shaped aggregations on top, is the right split.

## The Four-Layer Lakehouse Model

### Layer 1 — Bronze (raw ingestion)

**What**: untouched source data, preserved for auditability and reproducibility. If a Silver transform turns out to be wrong two quarters from now, Bronze is how we recompute without re-scraping.

**Where OSA is**: partial. ADS-B daily tars live in S3 Glacier (`osa-dumont-backup`, 2023-present). Daily FAA zips + monthly airmen zips also archive to S3. Scraper outputs (ARGUS / Wyvern markdown) are not archived today — that's a gap.

**Naming**: `raw_{source}_{entity}` (for in-DB Bronze) or `s3://osa-dumont-backup/raw/{source}/{date}/...` (for object-storage Bronze).

**Examples**: `raw_faa_master`, `raw_adsb_traces`, `raw_argus_scrape`.

### Layer 2 — Silver (cleaned + typed, per-source)

**What**: structured, typed, validated data with source attribution intact. One Silver table per (source, entity) pair. Silver is the authoritative record of what each source told us, not what we concluded.

**Where OSA is**: mostly complete. `faa_operators`, `adsb_completed_legs`, `ntsb_accidents`, `aircraft_listings`, and today's new `safety_ratings` are all Silver tables. This is the layer that already works.

**Naming**: `{source}_{entity}` — e.g., `faa_operators`, `adsb_completed_legs`, `argus_ratings` (future, renamed from today's combined `safety_ratings`).

**Purpose**: authoritative source-of-record for per-source facts, source-specific analytics, and the input to the canonical layer.

### Layer 3 — Gold (canonical entities + identity resolution)

**What**: the MDM layer. One row per real-world entity regardless of how many sources describe it. This is where "NetJets Aviation" (FAA), "NetJets" (ARGUS), and "NetJets Aviation Inc." (Wyvern) converge to one `operator_id`.

**Where OSA is**: missing. Phase 1 builds this.

**Naming**: `{entity}` (the canonical row) + `{entity}_identities` (per-source links) + `{entity}_aliases` (known name variants).

**Core tables to build** (operators as the first entity):

```
operators
  - id                   UUID (stable forever — never reused)
  - canonical_name       TEXT NOT NULL
  - canonical_type       TEXT CHECK (... IN ('charter', 'fractional', 'corporate'))
  - headquarters_icao    TEXT
  - first_seen_at        TIMESTAMPTZ NOT NULL
  - last_updated_at      TIMESTAMPTZ NOT NULL
  - schema_version       INTEGER NOT NULL DEFAULT 1

operator_identities
  - operator_id          UUID REFERENCES operators(id)
  - source               TEXT CHECK (... IN ('faa','argus','wyvern','isbao','adsb','manual'))
  - source_id            TEXT NOT NULL          -- their ID in their system
  - name_as_provided     TEXT NOT NULL          -- how they wrote the name
  - match_confidence     TEXT CHECK (... IN ('exact','high','medium','low','manual'))
  - match_method         TEXT                   -- 'cert_number','name_fuzzy','manual',...
  - match_evidence       JSONB                  -- weighted-signal breakdown
  - first_seen_at        TIMESTAMPTZ NOT NULL
  - last_verified_at     TIMESTAMPTZ NOT NULL
  - UNIQUE (source, source_id)

operator_aliases
  - operator_id          UUID REFERENCES operators(id)
  - alias                TEXT NOT NULL
  - alias_normalized     TEXT NOT NULL
  - alias_type           TEXT CHECK (... IN ('legal','dba','marketing','historical'))
  - source               TEXT
  - UNIQUE (operator_id, alias_normalized)
```

**Same pattern, applied to other entities over time** (in priority order):

- `aircraft` + `aircraft_identities` — links FAA tail number ↔ ADS-B ICAO hex ↔ type-rating records.
- `airports` + `airport_identities` — reconcile ICAO / IATA / FAA-ident / NTSB-short.
- `pilots` + `pilot_identities` — airmen record ↔ observed-in-ADS-B links.
- `clients` + `client_identities` — future, as CRM data enters the system.

### Layer 4 — Platinum (AI-facing question-shaped views)

**What**: denormalized, OBT-style (One Big Table) materialized views, one per question class. This is the layer Dumont and the MCP tools read. No agent is expected to JOIN canonical + identity + Silver facts at query time.

**Where OSA is**: missing. Phase 2+ builds these.

**Refresh model**: materialized views, rebuilt after each relevant ingestion run (nightly pipeline, monthly safety refresh, etc.). Stale-by-up-to-24-hours is acceptable for everything except `ghost_positioning_live` (which must be near-realtime).

**Initial Platinum views planned**:

- **`operator_profile`** — one row per operator, all attributes flat (canonical name, all aliases, home base, fleet size, Part 135 status, all safety ratings from all sources, reliability score).
  Answers: *"Tell me everything about operator X."*
  Consumed by: Sourcing agent, MCP `operator_analysis` tool.

- **`operator_safety_summary`** — one row per operator, best-known rating from each source flattened to a single safety tier.
  Answers: *"Which operators meet our safety threshold?"*
  Consumed by: Sourcing agent for ranking.

- **`fleet_intelligence`** (Phase 3) — one row per aircraft: FAA registration + type + current operator + last known position + recent leg history + ghost-candidate flag.
  Answers: *"What is N123AB doing? Who operates it?"*
  Consumed by: Ghost positioning logic, MCP `lookup_aircraft` + `find_ghosts` tools.

- **`route_intelligence`** (Phase 3) — one row per origin-destination-month: volume, avg price, seasonal pattern, top operators.
  Answers: *"KORD → KTEB demand trends?"*
  Consumed by: Quote agent, route pages on orangesunshineaviation.com.

- **`ghost_positioning_live`** (Phase 3) — current repositioning opportunities, updated on each ADS-B tick.
  Answers: *"Any charter aircraft empty near KTEB today?"*
  Consumed by: Sourcing agent real-time.

## Entity Resolution Strategy

Matching new records to canonical operators happens **at ingestion time, not query time**. Query-time matching means every agent call pays the cost and gets subtly different answers depending on fuzzy-match thresholds.

### Tier 1 — Deterministic (`match_confidence = 'exact'`)

Shared IDs across sources. If FAA cert `1OCA082A` appears in both the FAA registry and a prior ARGUS scrape with the same cert number, it's the same entity. Bindings are one-shot and never re-evaluated unless the source record changes.

### Tier 2 — Probabilistic (`match_confidence` ∈ `'high' | 'medium' | 'low'`)

Weighted scoring on multiple signals:

- Normalized name similarity (Jaro-Winkler + trigram).
- Home base ICAO match.
- Address match (street + city + state).
- Fleet overlap (if known tails are shared across sources).
- Phone number match.

**Thresholds** (indicative — to be calibrated in Phase 1 against a labeled sample):

- `score ≥ 0.90` → `'high'` → auto-match.
- `0.75 ≤ score < 0.90` → `'medium'` → auto-match with flag for monthly review.
- `0.60 ≤ score < 0.75` → `'low'` → manual review queue. Never auto-matched.
- `score < 0.60` → treat as a new operator; create a new canonical row.

### Tier 3 — Manual review

Ambiguous cases — multiple medium matches, conflicting signals (name matches but home base contradicts), cross-national collisions — go to a manual review queue. A human confirms the match and `match_confidence` is set to `'manual'`. This prevents auto-merges from contaminating canonical data during the initial backfill when heuristic thresholds haven't been calibrated yet.

## Naming Conventions

### Tables

| Layer | Pattern | Example |
|---|---|---|
| Bronze | `raw_{source}_{entity}` | `raw_faa_master`, `raw_argus_scrape` |
| Silver | `{source}_{entity}` | `faa_operators`, `argus_ratings` |
| Gold canonical | `{entity}` | `operators`, `aircraft` |
| Gold identity | `{entity}_identities` | `operator_identities` |
| Gold aliases | `{entity}_aliases` | `operator_aliases` |
| Platinum | `{entity}_{question_noun}` | `operator_profile`, `fleet_intelligence` |

### Columns

- `id` — primary keys. **UUID** for Gold (stable across rebuilds); **SERIAL** for Silver (source-specific, rebuildable).
- `{entity}_id` — foreign keys to the canonical Gold row.
- `source_id` — the external system's ID (FAA cert number, ARGUS ID, Wyvern AOC, etc.).
- `schema_version` — on every table, forward-compat for migrations.
- `first_seen_at`, `last_verified_at` — on Gold rows, so we can answer "when did we first see this operator" and "when was this still present in the source".
- `seen_at` — on fact tables (ADS-B positions, rating observations) for time-series use.

## Source Attribution

Every Gold / Platinum record traces back to at least one Silver record, which traces back to a Bronze event.

For any data point in OSA, we must be able to answer:

1. **Where did this come from?** — which source(s).
2. **When was it scraped/ingested?** — timestamp(s).
3. **How confident are we?** — `match_confidence` on the identity link, plus any probabilistic score on the underlying fact.
4. **What's the raw version?** — a Bronze reference or S3 URI.

This is mandatory. No "just trust the data" shortcuts. Every Platinum view must carry (or be joinable to) source attribution and freshness timestamps — silent staleness is worse than no data.

## Migration Path (current → target)

### Phase 0 — Decisions (this commit)

- Document target architecture (this file).
- Lock lessons in `.claude/lessons.md` so future sessions inherit context.
- **Freeze new scrape sources** until Phase 1 is complete. Adding IS-BAO or Aviapages to today's Silver-only shape would compound the problem we're trying to solve.

### Phase 1 — Operators canonical layer (3–5 days)

- Build `operators` + `operator_identities` + `operator_aliases`.
- Build the entity resolution matching algorithm (tiered, weighted, calibrated on a labeled sample).
- Build the manual review queue (could be a simple admin page + `operator_identities.match_confidence = 'pending'` state).
- Migration: re-interpret today's `faa_operators` + `safety_ratings` through the canonical layer. Keep Silver tables as the source-of-truth for per-source facts — they don't go away.
- Split `src/memory/schema-pg.sql` into the `src/memory/schema/` directory per Schema Evolution Rule 1.
- Adopt migration naming per Schema Evolution Rule 2 (`YYYY-MM-DD-NNN-<kebab-name>.sql`).
- Add the `platinum_refresh_log` table for Schema Evolution Rule 4 (even though the first Platinum view arrives in Phase 2 — get the plumbing in now).

### Phase 2 — Safety ratings on new structure + first Platinum view (2–3 days)

- Rename today's unified `safety_ratings` into per-source Silver shape: `argus_ratings`, `wyvern_ratings`. Source-specific fields (ARGUS home base, Wyvern country) belong on each source's table, not on a merged row.
- Build `operator_profile` Platinum materialized view.
- Build `operator_safety_summary` Platinum view.
- Update Sourcing agent to read Platinum, not Silver.
- Deprecate the denormalized `faa_operators.argus_rating / wyvern_rating / is_bao_stage` columns once Sourcing has cut over.

### Phase 3 — Aircraft canonical (3–5 days)

- `aircraft` + `aircraft_identities` (links FAA tail ↔ ADS-B ICAO hex ↔ future NTSB).
- `fleet_intelligence` Platinum view.
- `ghost_positioning_live` Platinum view.

### Phase 4+ — Other entities as needed

Routes, deals, clients, airports, pilots. Same four-layer pattern, repeated.

## Schema Evolution Principles

These rules govern how the schema evolves as Phase 1-4+ land. They prevent a well-intentioned architecture from degrading into the exact mess it was designed to prevent.

### Rule 1 — Schema is split by layer

Starting in Phase 1, `src/memory/schema-pg.sql` is split:

```
src/memory/schema/
  ├── silver/
  │   ├── faa.sql              (faa_operators, faa_aircraft, ...)
  │   ├── adsb.sql             (adsb_completed_legs, ...)
  │   ├── safety-sources.sql   (argus_ratings_facts, wyvern_ratings_facts)
  │   ├── market.sql
  │   └── ...
  ├── gold/
  │   ├── operators.sql        (operators + identities + aliases)
  │   ├── aircraft.sql         (Phase 3)
  │   └── ...
  ├── platinum/
  │   ├── operator-views.sql
  │   ├── fleet-views.sql      (Phase 3)
  │   └── ...
  └── migrations/
      └── YYYY-MM-DD-NNN-<name>.sql
```

Each migration is a separate file. A `migrations.sql` orchestrator includes them in order.

### Rule 2 — Migration naming

Format: `YYYY-MM-DD-NNN-<kebab-case-name>.sql`

```
2026-04-28-001-operators-canonical.sql
2026-04-28-002-operator-identities.sql
2026-05-05-001-argus-ratings-facts.sql
```

- Numbers disambiguate multiple migrations on the same day.
- Kebab-case names explain what the migration does at a glance.
- **Never use just a number.** "Migration 38" tells nobody anything.

### Rule 3 — Deprecation has a lifecycle

A table cannot be "soft deprecated" and left to rot. Every deprecation requires:

1. **Header comment** at the top of the table definition:
   ```sql
   -- DEPRECATED YYYY-MM-DD
   -- Replaced by: <new table or view>
   -- Readers migrate to: <new query target>
   -- Scheduled removal: YYYY-MM-DD (minimum 6 weeks after deprecation)
   ```
2. **Code assertion**: ingestion that previously wrote to the table now throws or `log.error("attempted write to deprecated X, use Y instead")`.
3. **Monitoring**: query logs flag any writes or reads from deprecated tables.
4. **Actual removal**: on the scheduled removal date, `DROP` the table in a dedicated commit. Do not leave indefinitely.

### Rule 4 — Platinum views expose freshness

Every materialized view must include:

```sql
view_last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Every refresh operation logs to:

```sql
platinum_refresh_log (
  view_name, refreshed_at, row_count, duration_ms, status, error
)
```

Agents querying a Platinum view can check freshness:

```sql
SELECT MAX(view_last_refreshed_at) FROM operator_profile;
```

Stale views (>24h old for most, >1h for real-time) trigger alerts.

### Rule 5 — Additive-first, destructive-last

Phase order within any migration:

1. Create new tables/views.
2. Dual-write: writers populate **both** old and new tables.
3. Migrate readers one-by-one to new tables.
4. Verify: no reads from old table for 1 week.
5. Mark old table `DEPRECATED` (Rule 3 lifecycle begins).
6. 6 weeks later: `DROP` old table.

**Never do 1 → 6 in a single migration.** The cost of dual-writing for 1-2 weeks is vastly lower than the cost of a broken reader you didn't know about.

### Rule 6 — Platinum views are the ONLY agent interface

Non-negotiable:

- Agent code (`src/capabilities/`, `src/orchestrator/`) **never** reads Silver or Gold tables directly.
- All agent reads → Platinum materialized views.
- **CI grep check**: if an agent file imports a Silver or Gold table name, fail the build.

Why: agent queries are the hardest to refactor. Lock them to the stable Platinum interface from day one. If a Platinum view is missing for a query class, build the view — don't shortcut by reading Silver.

### Rule 7 — Source attribution is mandatory

Every row in **Gold** must have:

- `first_seen_at`
- `last_verified_at`
- `source_of_creation` (which identity source first created this record)

Every row in **Silver** must have:

- `scraped_at` or `ingested_at` (event time)
- `source` (explicit, even when the table name implies it)
- `scrape_run_id` or `ingest_run_id` (FK to a runs table for audit)

Every row in **Bronze** must have:

- `ingested_at`
- `source_url` or `source_file`
- `raw_sha256` (hash of the raw content)

No shortcuts. If a source doesn't provide enough attribution, don't ingest until it does.

## References

- Zach Wilson, *"How do One Big Table and AI fit together"* — https://blog.dataexpert.io/p/how-to-data-model-for-your-ai-context
- Kimball dimensional modeling (background reading).
- Databricks Lakehouse whitepapers (Bronze / Silver / Gold origin of the pattern).
- Airbnb "Unified Metadata" blog post (practical MDM experience report).

## Related files

- [`.claude/lessons.md`](../.claude/lessons.md) — 2026-04-18 entries explain the forcing incident (1-of-313 FAA match).
- [`docs/schema.md`](./schema.md) — current Silver-only schema, to be expanded as Gold/Platinum land.
- [`src/memory/schema-pg.sql`](../src/memory/schema-pg.sql) — SSOT for current tables.
