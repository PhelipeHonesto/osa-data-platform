# Session A.5 — Phase 1 results (2026-05-05)

**Date**: 2026-05-05
**Time**: started ~11:00 Chicago, Phase 1 closed mid-afternoon (~5 focused hours)
**Status**: Phase 1 closed at commit `63e7be8`. Phases 2–4 deferred to next session.
**Plans**: `docs/plans/session-a5-operators-rebuild.md` (33b623d, original 35-page) → `docs/plans/session-a5-operators-rebuild-delta-001.md` (c50b494, premise correction) → `docs/plans/session-a5-may1-ingest-execution.md` (63e7be8, 1-page exec doc — supersedes both for execution).

---

## What landed today

Three commits on `main`, all pushed to origin:

1. **`007871b` Session A: false-positive audit, cert-bridge derivation, supporting docs** — caught at §8.1 pre-flight as uncommitted Session A work that had been applied to Supabase prod but not landed in main. 16 files: 3 migrations + 3 rollbacks (`2026-05-04-001/002/003`), 2 backfill scripts (`backfill-operator-aircraft-link-from-cert-bridge.ts`, `quarantine-step2c-lookalike-falseps.ts`), Session A session doc, `docs/codebase-map.md`, `docs/invariants-2026-05-04.md`, plus updates to `phase1-followups.md` / `.gitignore` / `schema/rollback/README.md`. Reproduces Session A's prod state on main.

2. **`c50b494` Plan delta 001: pre-flight findings — polluted-rows premise removed** — pre-flight categorization of the 1,908 NULL-typed operators showed all 1,908 were deliberately-staged D085-attested candidates from Stage 2c.5 Phase 1 (commit `c2c0464`, 2026-04-25), not aircraft-owner pollution. Original plan §3.6/§4.4 polluted-rows migration was solving a problem that doesn't exist. Delta amends §1 (done state, SC-1), §3.4.2 (Phase B becomes UPDATE-driven), §3.6 (REMOVED), §4.4 (REMOVED no-op), §3.8 (5 migrations not 6), §6.1 (CP timing 49–77 hrs). §2/§5/§7/§8 unchanged.

3. **`63e7be8` Phase 1: FAA Part 135 list live URL ingester + parser May 1 dialect** — `src/ingestion/faa-p135-list-fetch.ts` (477 lines), parser updates for both header dialects (`src/utils/d085-parser.ts`), parser tests (`tests/d085-parser.test.ts` — 489/489 green), and the 1-page exec doc (`docs/plans/session-a5-may1-ingest-execution.md`).

S3 now holds the May 1 snapshot:

- `s3://osa-dumont-backup/raw/faa/d085/snapshots/20260501172056/page.html` (110,745 bytes)
- `s3://osa-dumont-backup/raw/faa/d085/snapshots/20260501172056/manifest.json`
- `s3://osa-dumont-backup/raw/faa/d085/xlsx/20260501172056__Part_135_Operators_and_Aircraft_List.xlsx` (531,484 bytes, sha256 `b4989eddbbc90c2689c7696b7c61f9161d0050c8eb6f1bc0caea999298fa9633`)
- `s3://osa-dumont-backup/raw/faa/d085/_index.json` extended: 49→50 snapshots, 12→13 unique xlsx versions, `date_range` 2023-01-25 → 2026-05-01.

Idempotency verified: a second live run detects the manifest in S3 and exits without re-downloading or rewriting.

## What didn't land

- **Phase 2** — canonical promotion (re-run `backfill-canonical-{certificates,aircraft-on-certificate,operator-holds-certificate}-from-d085.ts` under bumped source slug `faa_d085_2026_05`). Not started.
- **Phase 3** — UPDATE-driven type-tagging of the 1,908 NULL-typed operators based on May 1 holder name match (`scripts/type-tag-operators-from-faa-p135-2026-05.ts` to be written). Not started.
- **Phase 4** — cert-bridge re-run with run-id `track1_session_a5_may1_cert_bridge_<UTC-timestamp>`, plus SC-1/2/3/4 measurement and results doc. Not started.

## Open questions deferred

- **Broken-FAA-era contamination of `public.faa_operators`**. Silver table last updated 2026-04-13, populated by `faa-operators-full.ts` mining `faa_aircraft.certificate_holder` (the field contaminated during the 2026-02-16 → 2026-05-01 broken-FAA-file window). Likely contains the Louisiana-seaplane mis-attribution noted in the architecture-correction discussion. Not addressed in Phase 1; not directly required for Phases 2–4 (the canonical path uses S3 xlsx directly, bypassing `faa_operators`). Worth a separate small audit when Phase 4 measurement surfaces obvious bad-attribution rows.
- **26 pseudo-tail-as-LLC entries** (`429LD LLC`, `5KTA152N LLC`, `JETEX LLC`, `LUXAIR LLC`, `VERIJET INC`, …). Of those 26, only `429LD LLC` had a tail-pattern match (`N429LD` exists in `canonical.aircraft`). The other 25 read as real charter brands with short alphanumeric names. Surfaced during pre-flight categorization, no further investigation done; carried as a low-priority watchlist for Phase 4 sanity check.
- **AVinfo / FAA daily DBA-searchable resource ingestion timing**. The FAA's daily-updated DBA resource (referenced in original plan §2.2) is new infrastructure. Recommendation surfaced earlier today: ingest after Phase 2 cert-bridge validation lands. Decision deferred until Phases 2–4 close — DBA layer doesn't gate cert-bridge derivation.
- **Pipeline-runner stall**: `pipeline_runs` shows only `faa_nightly` ran in the last 60 days (last 2026-04-12). ADS-B workers, NTSB, safety scrapes, D085 wayback — all silent. Cron / orchestration health is a separate workstream; tracked but not blocking the May 1 ingest path.

## Reflection

Pre-flight caught two distinct drifts before any execution started.

**Drift 1 — strategic frame**. The original 35-page plan asserted "3,898 polluted aircraft-owner rows in `public.operators`." Categorization queries against actual state showed 1,947 operators total, 1,908 NULL-typed but all backed by `operator_identities` rows from the deliberate Stage 2c.5 Phase 1 D085-seed expansion. The plan had conflated `public.faa_operators` (silver, 3,898 rows) with `public.operators` (canonical, 1,947 rows). Surfaced via §8.2 bucket categorization → produced `delta-001`.

**Drift 2 — architecture**. Mid-session, a framing emerged that "Bronze = S3 Glacier; Silver = DuckDB on Parquet; Gold = Supabase" — leading to a migration that built `bronze.faa_p135_oa_list_*` tables in Postgres. Reading `docs/data-architecture.md` directly showed: Bronze can live in either S3 OR Postgres (`raw_*` prefix), Silver lives in Postgres for small/medium sources, DuckDB+Parquet is reserved for ADS-B-scale time-series. Existing implementation already had a working pattern: D085 promotion reads S3 xlsx directly into canonical, no silver table involved. The bronze migration was rolled back, the `bronze.*` tables dropped from prod, and the work right-sized to a 1-page exec doc. Net change to the data layer from Phase 1: zero new tables, zero new schemas, zero new migrations.

The day's actual code was small once correctly scoped: one new ingester (~477 lines), four parser candidate-list additions, two new test cases, three doc updates. The 35-page plan had over-engineered against its own misreading of state. Pre-flight discipline — categorization queries, schema reads, implementation tracing — paid for itself many times over against the cost of executing a plan written against a wrong premise.

The §8 pre-flight checklist from the original plan worked exactly as designed. Including it in future plans is non-negotiable.

## Resumption protocol for next session

Per `docs/plans/session-a5-operators-rebuild.md` §8.10 (resumption from a stop gate):

1. Read `docs/plans/session-a5-may1-ingest-execution.md` (1-page exec doc).
2. Phases 2–4 are unstarted; Phase 1 closed at commit `63e7be8`.
3. Light pre-flight before Phase 2:
   - `git status` expects clean modulo `.work/`.
   - `git log --oneline -5` expects `63e7be8` on top.
   - psql verify Session A's canonical state intact:
     - `canonical.operator_holds_certificate WHERE source='faa_d085' AND confidence=0.95` → 115 rows.
     - `canonical.operator_holds_certificate_pending WHERE evidence->>'audit_run_id'='A.0-2026-05-04'` → 6 rows.
     - `canonical.operator_aircraft_link WHERE source='faa_d085_via_cert_bridge'` → 2,052 rows.
   - `aws s3 ls s3://osa-dumont-backup/raw/faa/d085/snapshots/20260501172056/` confirms May 1 capture still present.
4. Propose Phase 2 plan (edit SOURCE constants in 3 backfill scripts to `faa_d085_2026_05`, re-run, verify counts) and stop for approval.

End of day.
