# Codebase Map — osa-data-platform

Generated: 2026-05-04. Scope: orientation reference for future planning sessions. Read alongside `docs/invariants-2026-05-04.md` (the 17 cross-cutting invariants) and `CLAUDE.md` (load-bearing conventions).

This is a snapshot. It will drift. When in doubt, trust the code.

---

## 1. Repository overview

`osa-data-platform` is the data layer of OSA. Sibling repo: `dumont-agent` (charter brokerage orchestrator). This repo owns:

- Ingestion (FAA, ADS-B, NTSB, safety ratings).
- Entity resolution (canonical operator + canonical aircraft + canonical certificate ER).
- Analytics compute (WINGX engine — frozen pending Phase 12 dbt migration).
- Schema SSOT (`schema/` is the source of truth; migrations under `schema/migrations/`).

Out of scope: agent capabilities, MCP server, HTTP API, Vapi webhooks. All in `dumont-agent`.

Hosts: Mac dev at `~/osa/osa-data-platform`. Lightsail prod at `~/osa-data-platform` (NOT `~/osa/...`).

---

## 2. Repository layout

```
.
├── CLAUDE.md                    # load-bearing conventions (read first)
├── package.json                 # TypeScript / tsx / npm scripts
├── schema/                      # SQL SSOT, run by src/db/migrate-pg.ts
│   ├── _extensions.sql          # btree_gist, uuid-ossp, etc.
│   ├── _schemas.sql             # CREATE SCHEMA canonical
│   ├── transactional/           # public-schema operational tables
│   ├── silver/                  # cleaned ingestion outputs
│   ├── gold/canonical/          # gold-layer canonical mart definitions
│   ├── canonical/               # NEW ER tables (operator, aircraft, cert)
│   ├── analytics/               # WINGX-style aggregation tables
│   ├── gold/infra/              # gold-layer infra (DQ, lineage, etc.)
│   ├── gold/views/              # MCP views (agent-facing read surface)
│   ├── migrations/              # dated forward migrations
│   └── rollback/                # manual down migrations (NOT loaded by migrate-pg)
├── src/
│   ├── ingestion/               # FAA registry, daily diff, ADS-B workers, NTSB, etc.
│   ├── entity-resolution/       # Jaro-Winkler, trigram, field priority, trust
│   ├── analytics/               # wingx-engine.ts (FROZEN), data-quality, embeddings
│   ├── db/                      # database.ts, pg-database.ts, migrate-pg.ts, migrate-data.ts
│   ├── utils/                   # logger, sentry, haversine, errors (duplicated from dumont-agent)
│   └── schemas/                 # Zod schemas (Aircraft, Operator, AirportCode, ADS-B raw)
├── scripts/                     # one-off backfills, calibration, dedup, verification, S3 restore
│   └── fixtures/                # eval fixtures (JSON)
├── docs/                        # architecture, ER plans, decisions, followups
├── .work/                       # untracked scratch (eval runs, smoke tests)
└── data/                        # raw extracts, parquet, etc. (gitignored where large)
```

### Migration runner load order

`src/db/migrate-pg.ts` runs SQL in this order:

1. `schema/_extensions.sql`
2. `schema/_schemas.sql`
3. `schema/transactional/`
4. `schema/silver/`
5. `schema/analytics/`
6. `schema/gold/canonical/`
7. `schema/canonical/`
8. `schema/gold/infra/`
9. `schema/gold/views/`
10. `schema/migrations/`

All statements are idempotent (`CREATE ... IF NOT EXISTS`). The runner does NOT write to a `_migrations` table — it verifies via `pg_tables` comparison after applying. This is why CLAUDE.md §4 step 3 (explicit prod verification) is load-bearing: a clean exit code only proves the runner ran, not that the DDL took effect on Supabase.

---

## 3. Schemas with constraint types

Naming convention: `<schema>.<table>` always. Three schemas matter:

- **`public`** — legacy operational tables. Pre-canonical-split. Holds `operators`, `faa_aircraft`, `adsb_completed_legs`, `operator_identities`, `operator_aliases`, `operator_match_review`, `operator_llm_er_checkpoint`, `pipeline_runs`. **Do not add new tables here.** Migration path for `operators` → `canonical.operators` is a single `ALTER TABLE ... SET SCHEMA` (deferred until ER work is settled).
- **`canonical`** — new ER home. Six entities: operator (still in public for now), certificate (live), aircraft (live), FBO (not started), airport (not started), person (not started). All cross-entity links land here.
- **`gold`** — agent-facing read surface (`gold/views/`). Agents read here only. This repo does not ship new agent views.

### 3.1 Canonical ER tables

| Table | Purpose | Identity | Key constraint |
|---|---|---|---|
| `canonical.aircraft` | Physical airframe | `aircraft_id UUID PK` (anchor: `hex_code`) | `current_tail_number` lookup with temporal filter |
| `canonical.aircraft_identities` | All FAA / ADS-B id rows for one airframe | `(aircraft_id, source, source_id)` | append-only |
| `canonical.certificates` | FAA / international certs | `cert_id UUID PK`, `faa_cert_number` UNIQUE where present | `cert_authority IN ('faa','caaci','easa','dgca','anac','other')` |
| `canonical.aircraft_on_certificate` | Which aircraft are *authorized on* a cert | `(aircraft_id, cert_id, daterange)` | EXCLUDE on `(aircraft_id=, cert_id=, daterange &&)` |
| `canonical.operator_holds_certificate` | Which operator *holds* a cert | `(operator_id, cert_id, role, daterange)` | EXCLUDE on `(operator_id=, cert_id=, role=, daterange &&)` |
| `canonical.operator_aircraft_link` | Operator ↔ aircraft, by role × time | `(aircraft_id, role, daterange)` | EXCLUDE on `(aircraft_id=, role=, daterange &&)` |
| `canonical.operator_aircraft_resolution_log` | Audit log for resolution attempts | `id UUID PK` | resolver_action enum + tier enum + reason enum |
| `canonical.operator_events` | Operator entity-level changes (rebrand, merger, etc.) | `id UUID PK` | event_type enum (cert_transfer DEPRECATED — moved to `certificate_events`) |

### 3.2 Constraint pattern (canonical temporal links)

Every cross-entity link follows the same shape:

```sql
CREATE TABLE canonical.<link_table> (
  id UUID PK DEFAULT gen_random_uuid(),
  <entity_a>_id UUID NOT NULL REFERENCES ...,
  <entity_b>_id UUID NOT NULL REFERENCES ...,
  role TEXT,                                -- where applicable
  valid_from DATE NOT NULL,
  valid_to DATE,                            -- NULL = current
    CHECK (valid_to IS NULL OR valid_to > valid_from),
  source TEXT NOT NULL,
  source_url TEXT,
  source_timestamp TIMESTAMPTZ,
  ingestion_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence NUMERIC(3,2) NOT NULL DEFAULT 1.0
    CHECK (confidence BETWEEN 0.0 AND 1.0),
  match_method TEXT,
  evidence JSONB,
  corroborated_by JSONB,
  contradicted_by JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,

  EXCLUDE USING gist (
    <entity_a>_id WITH =,
    role          WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);
```

Key facts:
- `DATE`, not `TIMESTAMPTZ`. `valid_to` NULL means "current."
- EXCLUDE constraint, not UNIQUE. Insert with `NOT EXISTS` pre-filter or refused-if-populated guardrail. **No `ON CONFLICT` triggers.** A dupe is a code-correctness failure to fix, not a runtime to swallow.
- Append-only, with three exceptions: `valid_to`, `last_updated_at`, `corroborated_by`, `contradicted_by` may be UPDATEd. Everything else is immutable after insert.
- Close-then-insert pattern for relationship changes (single tx).

### 3.3 Seven-role aircraft model

`canonical.operator_aircraft_link.role` enum:
```
legal_owner | beneficial_owner | operator | manager | financier | insurer | broker
```
A given aircraft may have all seven concurrent rows, with overlapping daterange windows enforced separately per role. Cert-bridge (Session A in current plan) populates `role='operator'` only.

### 3.4 `public.operator_llm_er_checkpoint`

Resumable checkpoint for the LLM ER orchestrator.

```sql
id UUID PK
input_review_id INTEGER NOT NULL
input_step TEXT NOT NULL
status TEXT NOT NULL DEFAULT 'queued'
  CHECK (status IN ('queued','in_progress','completed','failed','ready_for_review','committed'))
attempt_count INTEGER NOT NULL DEFAULT 0
last_attempt_at TIMESTAMPTZ
llm_decision TEXT
  CHECK (llm_decision IN ('match','new_entity','ambiguous','error') OR NULL)
llm_decision_subtype TEXT
  CHECK (llm_decision_subtype IN ('exact_alias','subsidiary_of_canonical','rebrand_to_canonical',
                                  'distinct_legal_entity','distinct_brand') OR NULL)
llm_decision_target UUID
llm_confidence NUMERIC(3,2)  CHECK (BETWEEN 0 AND 1)
firecrawl_pages JSONB
llm_evidence JSONB
citation_validated BOOLEAN
cost_estimate_usd NUMERIC(8,4)
error_message TEXT
run_id TEXT
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE (input_review_id, input_step)
```

P.2 of the current plan adds NULLable `ground_truth_outcome` for post-review human verdicts.

### 3.5 Migration file naming convention

`schema/migrations/YYYY-MM-DD-NNN-description.sql`

Most recent (chronological):
- `2026-04-25-002-operator-llm-er-checkpoint.sql`
- `2026-04-25-001-operator-events-deprecate-cert-transfer.sql`
- `2026-04-24-001-operators-icao-callsign.sql`
- `2026-04-19-003-operators-operator-type.sql`
- `2026-04-19-002-pipeline-runs-generic.sql`
- `2026-04-19-001-operators-split-trust-score.sql`
- `2026-04-18-001-data-quality-phase7-cols.sql`

Rollbacks under `schema/rollback/` follow `YYYY-MM-DD-NNN-description-rollback.sql` and are NOT loaded automatically — manual application.

---

## 4. Scripts inventory (grouped by purpose)

`scripts/` is where ingestion-time / one-off / orchestration code lives. ~30 scripts. tsx runtime.

### 4.1 Ingestion + canonicalization (Track 6 + Phase 1 backfills)

| Script | Purpose |
|---|---|
| `backfill-operators-canonical-faa.ts` | Phase 1 cp6 — initial canonical operators from FAA |
| `backfill-operators-canonical-safety.ts` | Phase 1 cp7 — ARGUS/Wyvern enrichment |
| `backfill-operators-canonical-faa-realfleet.ts` | Stage 2b — real-fleet subset filter |
| `backfill-canonical-aircraft-from-faa.ts` | CP1 — aircraft + identities from FAA |
| `backfill-canonical-aircraft-from-adsb.ts` | CP2 — ADS-B merge into canonical.aircraft |
| `backfill-operator-aircraft-link.ts` | CP3 — initial link from `faa_aircraft.certificate_holder` |
| `backfill-operator-aircraft-link-from-callsign.ts` | Stage 2c — ADS-B callsign trustee unmask |
| `backfill-canonical-certificates-from-d085.ts` | Track 6 Step 2a — cert table |
| `backfill-canonical-aircraft-on-certificate-from-d085.ts` | Track 6 Step 2b — aircraft↔cert link |
| `backfill-canonical-operator-holds-certificate-from-d085.ts` | Track 6 Step 2c — operator↔cert link |
| `expand-public-operators-from-d085-pending.ts` | Track 6 Step 2c.5 Phase 1 — expand operator pool |

### 4.2 Entity resolution + calibration

| Script | Purpose |
|---|---|
| `calibrate-match-thresholds.ts` | Phase 1 cp8a — stratified sampling + threshold calibration |
| `llm-er-pass-firecrawl.ts` | Track 6 Step 2c.5 Phase 2 — LLM ER orchestrator (claim/submit/commit) |

### 4.3 Operator backfill + dedup

| Script | Purpose |
|---|---|
| `backfill-operator-types.ts` | Phase 1.5 — operator_type classification |
| `backfill-operators-icao-callsign.ts` | Backfill ICAO callsign from FAA DBA |
| `dedup-operator-rows.ts` | Phase 1 — merge duplicate canonical operators |
| `fix-canonical-name.ts` | One-off canonical name corrections |

### 4.4 Review + verification

| Script | Purpose |
|---|---|
| `operators-review.ts` | Phase 1 cp9 — manual operator_match_review walkthrough |
| `dq-check.ts` | Data-quality gate (post-ingestion) |
| `check-agent-layer-isolation.ts` | Architecture compliance check (this repo never grows agent dirs) |
| `compute-operator-trust-scores.ts` | Batch trust score computation |
| `phase7-preflight.ts` | Phase 7 readiness checks (7 assertions) |
| `phase7-verify.ts` | Phase 7 DQ verification (7 checks vs thresholds) |

### 4.5 ADS-B archive + restore

| Script | Purpose |
|---|---|
| `backfill-2023.ts` | 2023 ADS-B backfill (consumes probe output) |
| `probe-2023-releases.ts` | Probe adsb.lol release tags (2023 days + staging fallback) |
| `probe-adsb-partials.ts` | Probe partial-day releases via GitHub Releases metadata |
| `inventory-adsb-archive.ts` | S3 gap analysis + SQLite cross-check |
| `s3-bulk-restore.ts` | Bulk-restore Glacier tars (raw/adsb/* only) |

### 4.6 Safety ratings + one-offs

| Script | Purpose |
|---|---|
| `refresh-safety-ratings.ts` | Scrape ARGUS/Wyvern, upsert, sync to faa_operators |

### 4.7 Fixtures

`scripts/fixtures/llm-eval-holdout-30.json` — 30-case eval fixture for Phase 2 LLM ER. 19 cases ran in `eval-20260425T235403Z`. Each case has: `holdout_id`, `truth_operator_id`, `truth_canonical_name`, `truth_operator_type`, `cert_id`, `cert_designator`, `holder_name_as_provided`, `holder_name_normalized`, `holder_name_variants`, `valid_from`, `valid_to`.

---

## 5. Stage 2c pipeline pattern (canonical write recipe)

Reference implementation: `scripts/backfill-canonical-operator-holds-certificate-from-d085.ts` (883 lines). Every new canonical-table backfill mirrors this shape. The pattern:

### 5.1 Refused-if-populated guardrail

Top of `main()`. Three checks against the destination table(s):
- Canonical destination has rows for this `source` → exit cleanly.
- Sidecar pending table has rows for this `source` → exit cleanly.
- Audit log has rows for this `step` → exit cleanly.

If any non-zero, the script does nothing. Manual rollback is required to re-run. This is intentional — we do not silently re-do work.

### 5.2 Window construction

For temporal links: source rows get aggregated into close-on-gap windows via `constructWindows(indices, snapshots)` (verbatim shared math with Step 2b). Defines `valid_from` (earliest in run) and `valid_to` (snapshot after the last present, or NULL if still current).

### 5.3 Resolution logic

Per row:
1. Normalize `holder_name` / `cert_id` / etc. to canonical form.
2. Score against candidate set (Jaro-Winkler + trigram + field priority).
3. Decision branches: `matched` (high tier, single dominant) | `review` (ambiguous runner-up or medium-name-only) | `no_match` (low tier).

### 5.4 Write phase

Single outer `BEGIN ... COMMIT` (Step 2c) wrapping all per-row INSERTs. Step 2c uses a single tx for the whole snapshot run; the cert-bridge (Session A) will use per-row tx because the EXCLUDE-violation handling needs row-level rollback semantics.

INSERTs target the canonical destination + a `_pending` sidecar for unresolved cases.

### 5.5 Audit log

Every attempt writes one row to `canonical.operator_aircraft_resolution_log` (or `public.operator_match_review` for the older Step 2c lineage). The log is permanent canonical, not staging — never delete, only append. Resolver action enum currently allows: `matched`, `matched_blocked_operator_type`, `review`, `no_match`, `exact`, `skipped_null`, `skipped_placeholder`, `skipped_individual`, `skipped_trustee`, `skipped_manufacturer`. Cert-bridge (current plan) extends with `cert_bridge_linked`, `cert_bridge_skipped_overlap`, `cert_bridge_skipped_already_linked`.

### 5.6 Constants block

```typescript
const SOURCE = "...";          // exact source identifier (e.g., "faa_d085")
const MATCH_METHOD = "...";    // resolution method (e.g., "d085_holder_exact")
const CONFIDENCE = 0.95;       // tier-driven confidence
const ROLE = "...";            // for role-bearing tables
const STEP_TAG = "step2c";
const TOLERANCE_PENDING_THRESHOLD = 0.85;
const TOLERANCE_REVIEW_THRESHOLD = 0.20;
const CHECKPOINT = "track6_step2c_d085";
```

Each new backfill defines its own constants block at top. Do not parameterize — these are run-defining, not runtime config.

### 5.7 CLI shape

```
tsx scripts/<script>.ts [--write] [--max-snapshots=N]
```
- Default: dry-run (logs counts, no writes).
- `--write`: commits.
- `--max-snapshots=N`: smoke-test scope.

---

## 6. Phase 2 LLM ER wiring

Reference: `scripts/llm-er-pass-firecrawl.ts` (1698 lines). Three CLI primitives:

### 6.1 `--claim-next`

Atomically claims the next claimable row from `public.operator_llm_er_checkpoint` (queued | failed<3 | stale-in-progress>60min). Sets `status='in_progress'`, bumps `attempt_count`, sets `last_attempt_at=NOW()` and `run_id`. Emits a JSON request to stdout describing the input record and candidate set.

### 6.2 `--submit-response <id>`

Reads `SubagentResponse` JSON from stdin. Runs the 5-layer validator. On pass: writes `status='completed'` with `llm_decision`, `llm_confidence` (capped at 0.85), `citation_validated`, `llm_evidence`, `firecrawl_pages`. On fail: `status='failed'` with `error_message`.

### 6.3 `--commit [--auto-approve-all]`

Reads `status='completed'` rows. For each, applies the auto-approve gate (5 conditions, ALL must pass):
1. `llm_decision` ∉ `{ambiguous, error}`
2. `llm_decision_subtype` ≠ `rebrand_to_canonical` (rebrands always surface)
3. `llm_confidence ≥ 0.75`
4. `citation_validated = true`
5. `llm_decision_target` ∉ top-20-by-fleet (high-blast-radius merges always surface)

Pass → `commitToCanonical()` → `status='committed'`. Fail any → `status='ready_for_review'` with surface_reasons logged.

### 6.4 5-layer validator (`validateLLMResponse`, lines 567–653)

1. **Citation**: every cited URL must be in `firecrawl_urls_fetched`.
2. **Per-URL quote**: each quote must be byte-exact substring of `firecrawl_pages[url].content`. `String.includes`. No fuzziness.
3. **Two-source rule**: ≥2 distinct hostnames in `verbatim_quotes`.
4. **Per-hostname-quote**: ≥1 quote from EACH cited hostname.
5. **Decision target**: if `decision='match'`, `decision_target_operator_id` must be a valid UUID present in candidates.

### 6.5 Prompt builder (`renderSelectingPrompt`, lines 657–785)

Six-section prompt: INPUT → TOP-K candidates → TASK → OUTPUT FORMAT → ANTI-HALLUCINATION RULES → JSON ENCODING. Four post-eval prompt fixes are baked in:
1. Synthetic-truth signal removal in visible-mode candidates.
2. Byte-exact-substring rule in anti-hallucination section.
3. Per-hostname-quote rule in Two-Source check.
4. JSON encoding rule (`JSON.stringify` semantics — `\"` not literal).

### 6.6 Constants

```typescript
const CONFIDENCE_POST_CAP = 0.85;        // line 95
const RETRY_HARD_CAP = 3;
const STALE_IN_PROGRESS_MINUTES = 60;    // line 98
const AUTO_APPROVE_MIN_CONFIDENCE = 0.75;
```

### 6.7 Firecrawl integration

The orchestrator's web-fetch backend is Firecrawl. The script invokes Firecrawl via Claude Code MCP (`mcp__firecrawl__firecrawl_scrape`). The MCP connects to a Firecrawl docker stack the user runs locally on the Mac (cloned from the upstream Firecrawl repo, brought up via `docker compose up`). When the local stack is wedged, `docker compose restart api playwright-service` clears it. No graceful no-web mode (Invariant 15).

---

## 7. S3 layout (best-effort)

Inferred from `scripts/s3-bulk-restore.ts` and `scripts/inventory-adsb-archive.ts`:

- Bucket: ADS-B archive (name not in scope of this snapshot).
- Prefix: `raw/adsb/*` — Glacier-class daily tarballs.
- Cross-check: SQLite inventory (path TBD by reading `inventory-adsb-archive.ts` directly).

For a definitive S3 layout, read the two scripts above. This snapshot does not have direct visibility into bucket contents.

---

## 8. Planner footnotes (gotchas, traps)

### 8.1 `wingx-engine.ts` is frozen

`src/analytics/wingx-engine.ts` anchors 26 aggregations on `adsb_completed_legs.operator_name` (free text). **Do not edit it in place** to read from canonical tables. Phase 12 dbt will re-express these as marts on properly-staged silver tables. Patching now creates a hybrid that has to be unwound.

### 8.2 `adsb_completed_legs` timestamps are TEXT

ADR `docs/decisions/2026-04-24-adsb-text-timestamps.md`. Casting with `::TIMESTAMPTZ` on read is the supported pattern until Phase 12 dbt. Validation queries do per-row casts. Agent-facing views deferred.

### 8.3 `faa_operators` is mostly synthesizer pollution

`docs/phase1-followups.md` §1: 3,898 rows in `faa_operators`, but only ~50 are real Part 135 operators. The remaining 3,848 have `certificate_number = name` — legal entity names from `faa_aircraft.certificate_holder` pulled in by `faa-operators-full.ts` without a proper operator filter. Fix is deferred (pre-Phase-2 priority); blocks cleanly expanding the operator canonical layer when new sources land.

### 8.4 `public.operator_aliases` is dead infra

1 row after Stage 1 "complete." Either resolver writes are broken and aliases are being dropped, or the alias table is redundant with `operator_identities.name_as_provided`. Investigation deferred.

### 8.5 `pipeline_runs` has 2 rows

Operational logging is sparse. The pipeline orchestration didn't get wired up in earnest after the migration. Restore is on the deferred list (Lightsail PM2; manual SSH; decoupled from ER work).

### 8.6 Stage 2c v2 cross-pathway corroboration is documented but not implemented

Per Invariant 10 and `docs/temporal-link-pattern.md`. New writers SKIP overlap (try/catch on EXCLUDE violation, log skipped, do not corroborate). When two sources independently propose the same `(aircraft_id, role, daterange)`, we currently keep only the first writer's row. v2 design lives in temporal-link-pattern.md but the writer side is unimplemented.

### 8.7 ARGUS / Wyvern are Tier E

`docs/data-sources.md`: paid audits, suspect tier. Enrichment-only. Never authoritative. Never gating.

### 8.8 LinkedIn is excluded — non-negotiable

`docs/data-sources.md` line 9–17. ToS breach claim risk. Confirmed in `hiQ Labs v. LinkedIn` (remanded 2022). For people-entity resolution use SEC filings, FAA airmen, state SOS officer lists, NTSB narratives, press release quotes.

### 8.9 Three-step migration verification

Local Docker rollback test → `npm run db:migrate-pg` exits 0 → explicit prod verification (`psql \d+ <schema>.<table>` for canonical, `describe-schema` MCP for public). All three. Not any two. CLAUDE.md §4. The reason is in §2 above (migrate-pg verifies via `pg_tables`, not via DDL success).

### 8.10 Six-entity discipline

Operator, Certificate, Aircraft, FBO, Airport, Person. No new entities until each has a resolution pipeline. Current state: operator + aircraft + certificate are live. FBO/Airport/Person are not started.

### 8.11 Trust scores surface, never gate

Phase 7 trust scoring is for ranking/UX, not authorization. Do not filter `WHERE trust_score > X` anywhere in the canonical layer. Filter at the agent view layer if needed.

### 8.12 Agent-isolation

Agents read only through `schema/gold/views/`. This repo does not ship new agent views except via dbt marts (Phase 12). If you find yourself writing a `gold/views/*.sql` here, stop and ask whether it should be a dbt mart instead.

---

## 9. Cross-references

- 17 cross-cutting invariants: `docs/invariants-2026-05-04.md`
- Architecture build sequence: `docs/er-architecture-plan.md` §"Build sequence"
- Aircraft entity spec: `docs/er/aircraft.md`
- Certificate entity spec: `docs/er/certificate.md`
- Temporal link pattern: `docs/temporal-link-pattern.md`
- Data sources tier hierarchy: `docs/data-sources.md`
- Phase 2 LLM ER eval baseline: `docs/phase-2-eval-summary.md`
- Phase 1 operational debt: `docs/phase1-followups.md`
- Decisions: `docs/decisions/`

When you find a new gotcha that future planners will hit, add it to §8 above (this is the right venue for "things you have to know but cannot derive from the code").
