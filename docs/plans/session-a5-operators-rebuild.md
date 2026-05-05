# Session A.5 — operators-canonical rebuild from FAA Part 135 (May 1, 2026)

**Status**: draft v0 — 2026-05-05
**Owner**: Phelipe Honesto
**Driver**: claude-opus-4-7 (1M context)
**Predecessor**: `docs/sessions/2026-05-04-session-a-cert-bridge.md` (cert-bridge derivation, 2.57% coverage)
**Triggered by**: FAA restoration of the Part 135 Operators and Aircraft list on 2026-05-01 (HEAD-verified 2026-05-05)
**Read alongside**: `docs/invariants-2026-05-04.md`, `docs/temporal-link-pattern.md`, `docs/data-sources.md`, `docs/phase1-followups.md` §1, `CLAUDE.md`

---

## 1. Strategic frame

### Why rebuild

`public.operators` is structurally unsound for entity resolution. Of 3,898 rows, only ~50 are real Part 135 operators (`docs/phase1-followups.md` §1, `docs/invariants-2026-05-04.md` §17). The other 3,848 are aircraft-owner legal-entity strings (LLCs, trusts, individuals) that `scripts/faa-operators-full.ts` promoted from `faa_aircraft.certificate_holder` without an operator filter. The pollution propagates downstream: Step 2c's resolver had nothing better to match against, which is why the A.0.5 audit caught 5 confirmed false positives at the top-tier confidence band — `Corporate Flight Management → Corporate Aircraft Management`, `Triton Air → Triton Airways`, etc. The right canonical entity simply did not exist for the resolver to find.

Session A's cert-bridge derivation inherited the ceiling. 2.57% coverage on March 2026 active aircraft, versus a 25–30% projection. Top-10 operators look real; trustees correctly absent; but Wheels Up / Flexjet / VistaJet / Executive Jet Management did not rank because their certs were not in `canonical.operator_holds_certificate` at high tier. The work was right; the upstream pool is wrong.

The May 1 restoration changes the calculus. The FAA Part 135 Operators and Aircraft list is back at a stable URL with a clean filename, weekly cadence, and verified holder names for **1,791 unique cert designators / 1,789 unique operator names** (recon 2026-05-05). Major fleets surface directly: NetJets `DXTA` (726 aircraft rows), Flexjet `J7SA` (323), Executive Jet Management `CWQA` (153), Air Methods `QMLA` (370), Sunset Aviation `7SSA` (143), Ameriflight `JIKA` (110). The rebuild is the unblocker — for Step 2c re-run, for Session B's LLM ER pass, for cert-bridge re-derivation, and for every downstream entity (FBO, airport, person) that depends on operator coverage being dense first per six-entity discipline.

### Done state

When this plan completes:

- `public.operators` (or its successor schema) holds approximately **1,789 real Part 135 operators** with verified holder names from `faa_d085_2026_05_01`, plus the dual-authority `121/135` operators captured as a first-class signal. Final operator count depends on multi-cert dedup decisions made in §3; SC-1 floor of ≥1,750 accommodates the range.
- After this rebuild, queries against `public.operators WHERE operator_type='part_135'` return only verified Part 135 operators. The 3,848 polluted rows are either moved to a separate `aircraft_owners` table or excluded from operator-side joins via a deprecation flag — specific mechanism decided in §3 (Schema and migration sequence).
- `canonical.operator_holds_certificate` covers ≥90% of the 1,791-cert universe at `confidence ≥ 0.85`, with the resolver gate-tightening from `docs/phase1-followups.md` Step 2c.6 Item 2 in place.
- 4 of 6 quarantined `operator_holds_certificate_pending` rows (FJTA, TCHA ×2, 70TA, OW6A) recover automatically. 1 cert (GQ9C) closes with `valid_to` set to the last historical snapshot date and `lifecycle_status='defunct'`.
- Cert-bridge re-derives from the densified ohc population. Coverage on March 2026 active aircraft moves substantially above 2.57%.
- A second canonical-population path (Step B, AVinfo.gov) lands DBA names and additional operator detail, joined into the same operator entity by cert designator.
- Six-entity discipline preserved: no new entity types added; certificate, operator, and aircraft entities densified in step.

### Success criteria (measurable)

The plan is complete when all six are demonstrably true. Each is verifiable against the database, not against vibes.

- **SC-1: pool density.** `public.operators WHERE operator_type='part_135' AND last_seen_source LIKE 'faa_d085%'` returns ≥1,750 rows. The exact figure depends on de-duplication of multi-cert single-parent operators (1,791 DSGNs vs 1,789 names indicates ≥2 such cases already in the data); the SC-1 floor accommodates that.
- **SC-2: ohc coverage.** `canonical.operator_holds_certificate WHERE source='faa_d085' AND confidence ≥ 0.85` covers ≥1,610 unique cert_ids (≥90% of 1,791). Pre-rebuild this metric was 112 unique certs (~6%).
- **SC-3: quarantined recovery.** Of the 6 rows in `operator_holds_certificate_pending` from audit_run_id `A.0-2026-05-04`: FJTA, TCHA, 70TA, OW6A are reactivated to `operator_holds_certificate` with the correct operator_id; GQ9C closed with `valid_to` set from the per-cert presence map computed in §2.3 (the date GQ9C was last present in any historical archive — derived from the archive at execution time, not hardcoded), and resolved_at populated. The 1 remaining TCHA row resolves to the same Executive Flight Management operator_id.
- **SC-4: cert-bridge coverage.** Re-derived `operator_aircraft_link role='operator' source='faa_d085_via_cert_bridge'` covers ≥10,500 unique aircraft (≥20% of the 52,693 March-2026 active hex codes). Pre-rebuild was 1,924 unique aircraft (2.57%).
- **SC-5: lookalike-misresolution gate.** Re-run of the A.0.5 normalization audit against the new `confidence ≥ 0.85` ohc population surfaces 0 confirmed false positives. The resolver decide() function carries the `top - runner_up ≥ 0.15` AND load-bearing-noun gate from `docs/phase1-followups.md` Step 2c.6 Item 2. Verdict is determined by methodology following the A.0.5 normalization audit shape — SQL produces the candidate set; human review produces the verdict. Same gate shape as Session A's A.0/A.0.5 false-positive gate.
- **SC-6: AVinfo.gov DBA layer.** `SELECT count(DISTINCT operator_id) FROM <dba_table> WHERE source LIKE 'avinfo%' AND operator_id IN (top-50-by-fleet subquery) returns ≥45.` Table name `<dba_table>` is finalized in §3. Threshold of 45 (not 50) accommodates DBA-absent operators in the long tail of the top-50 — not every operator publishes a DBA, and AVinfo.gov reflects that.

### Non-goals (explicit)

The plan stays scoped. The following are out:

- **Phase 12 dbt migration.** `src/analytics/wingx-engine.ts` stays frozen. No dbt marts written here. (`CLAUDE.md` §2)
- **New entity types.** FBO, airport, person not started — six-entity discipline forbids opening them until operator + cert + aircraft are dense (`CLAUDE.md` §3, `docs/invariants-2026-05-04.md` §4).
- **Trust-score gating.** Surfaced, never used to filter. (`docs/invariants-2026-05-04.md` §14)
- **LinkedIn or any ToS-prohibited source.** Non-negotiable. (`docs/data-sources.md` §"Excluded sources")
- **Aircraft-owner Phase 3 design.** Owners get a dedicated table or flag in this plan only insofar as needed to segregate them out of `public.operators`. The full owners-canonical entity is a separate later track.
- **Session B's 351-case LLM ER pass.** Session B runs against the post-rebuild pool. This plan is the prerequisite — running Session B against the current polluted pool would burn ~$14 of Sonnet against the wrong canonical surface.
- **Schema move `public.operators` → `canonical.operators`.** Documented as a one-line `ALTER TABLE ... SET SCHEMA` (`docs/phase1-followups.md` §"Future migration"). Not in this plan; do it after the data layer settles.
- **Operator-state DB split.** Per `docs/phase1-followups.md` §"Future: DB split." Pre-production-traffic concern.

### Why now

Three signals converged. (1) The May 1 restoration removes the "no Tier-1 authoritative source" excuse — the Part 135 file is back at 519 KB, weekly cadence, with verified holder names for 1,791 certs. (2) Session A's cert-bridge work surfaced the upstream pool as the binding constraint, with measured coverage gap quantified (2.57% vs 25–30%). (3) Session B was queued against the pre-restoration pool; running it now would resolve to wrong or absent canonical entities and waste budget. The optimal sequencing is rebuild-then-rerun-then-Session-B, not Session-B-then-rebuild.

There is also a less-tangible reason: the Part 135 list was deactivated for ~10 weeks (2026-02-16 last archive → 2026-05-01 restoration). The first ingestion against the restored file is also OSA's first chance to lock in a forward-running snapshot pipeline before another deactivation. The plan includes weekly archive cadence into S3 from Step 1 onward — captured even if downstream promotion lags — so that the next deactivation, if it comes, finds OSA holding the most recent state.

There is a third reason, surfaced by the recon. GQ9C demonstrated a category of state change we cannot detect without weekly cadence — operators that surrender or transfer certificates between FAA file publications. With monthly or irregular cadence, the gap between "last visible" and "is gone" could be 30–90 days; with weekly cadence plus snapshot diffing, the same gap closes to ≤7 days. That makes `canonical.operator_events` and `canonical.certificate_events` population (mergers, surrenders, cert transfers) genuinely tractable as a side effect of weekly ingest, rather than requiring a separate research workstream. Weekly cadence isn't just freshness — it's the foundation for lifecycle data capture, and the ~10-week opaque window between 2026-02-16 and 2026-05-01 is exactly the gap this argument names.

### What this is not

This is not a methodology document. It is an execution plan. The general OSA approach to entity resolution lives in `docs/er-architecture-plan.md`, `docs/temporal-link-pattern.md`, and `docs/er/certificate.md`. This plan inherits those rules and applies them to one concrete rebuild against one concrete file. Where the plan deviates from existing convention, it says so and explains why.

The plan also is not a Session B replacement. Session B's `--claim-next` / `--submit-response` loop on the LLM ER orchestrator stays as designed (`docs/phase-2-eval-summary.md`, `docs/codebase-map.md` §6). The post-rebuild queue will be smaller (much of the 351-case sidecar resolves automatically when the right canonical entity exists), but the orchestrator path is unchanged.

---

## 2. Data sources

Three sources feed the rebuild. All three are Tier 1 / Trust A per `docs/data-sources.md`. Two are live-fetched (Part 135 file, AVinfo.gov); one is historical (S3 archive of past D085 captures, frozen). All three are FAA-published — the rebuild is structurally a single-publisher pull, with multi-source corroboration from non-FAA Tier 1 sources (DOT Part 295, SEC EDGAR, state SOS) deferred to later tracks per `docs/data-sources.md` and `docs/er-architecture-plan.md` Stage 3+.

The Two-Source Rule (`docs/temporal-link-pattern.md` Rule 3, `docs/invariants-2026-05-04.md` §3) does not gate this plan's writes against a non-FAA second source, because the rule applies specifically to **identity-changing events** (rebrands, cert transfers, mergers). Initial canonical population from a Tier 1 single source is allowed at high confidence — the rule kicks in when subsequent claims modify identity. This plan stays inside that boundary.

### 2.1 FAA Part 135 Operators and Aircraft List (primary)

**Identity**: the file restored by the FAA on 2026-05-01 at the URL HEAD-verified during recon. Replaces the deprecated OpSpec D085 ingest path. The existing archive script `src/ingestion/archive-faa-d085-wayback.ts` becomes a one-shot Wayback-only bridge after this lands; forward-running ingestion targets the live URL.

**Endpoints**:
- Page (HTML): `https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders` — HTTP 200, Drupal 10 origin.
- File (xlsx): `https://www.faa.gov/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_List.xlsx` — HTTP 200, Content-Type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- Old D085 URL `…/avs/part-135-aircraft-listing-opspec-d085` returns HTTP 301 to the new canonical URL. The archive script's hard-coded URLs still resolve via redirect; do not change them in this plan.

**Cadence**: weekly per FAA page text ("Updated weekly"). Starting cadence: **Monday at 11:00 ET**, to be observed and adjusted. The first 4 weekly fetches observe FAA's actual publish pattern via Last-Modified header diffs; polling time then adjusts to land 1–2 hours after the observed publish window. Historical Last-Modified timestamps in the archive cluster Monday/Tuesday, suggesting an FAA publish window early in the work week — the 11:00 ET starting cadence reflects that. Weekly fetch is HEAD-then-conditional-GET: compare ETag and Last-Modified against the most recent S3 manifest; download only on mismatch.

**Schema fingerprint** (recon 2026-05-05, sha256 `b4989eddbbc90c2689c7696b7c61f9161d0050c8eb6f1bc0caea999298fa9633`):

| Field | Value |
|---|---|
| Sheet name | `Part 135` |
| Header row | row 0, no banner |
| Headers | `CFR \| CHDO \| DSGN \| Name \| Aircraft M/M/S \| Registration No. \| Serial No.` |
| Total data rows | 11,465 |
| Unique DSGN (cert designators) | 1,791 (all 4-character, all match `^[0-9A-Z]{3,5}$`) |
| Unique operator names | 1,789 (suggests ≥2 multi-cert single-parent cases) |
| CFR distribution | `135` (98.9%) / `121/135` (1.1%, 129 rows) |
| File size | 531,484 bytes (~519 KB) |
| Last-Modified (May 1) | `Fri, 01 May 2026 17:20:56 GMT` |
| ETag | `"1777996361-gzip"` |
| DBA / HQ / address columns | absent — AVinfo.gov path |

**Integrity checks** (every weekly fetch, before promotion to Silver):

1. **Sheet exists**: workbook contains a sheet named `Part 135`, OR the first sheet has the expected header row at row 0. Bail if neither.
2. **Header match**: row 0 contains exactly the 7 expected headers, in the expected order. Header rename or column add bails and surfaces for human review — schema drift is structural, not row-level.
3. **DSGN format**: ≥99.5% of non-empty DSGN values match `^[0-9A-Z]{3,5}$`. Below threshold bails with deltas surfaced.
4. **Row count drift**: total data rows within ±10% of the previous snapshot's count. ±10% catches partial publications and major outages; the 11,465-row baseline accommodates the file's natural growth and seasonal certs.
5. **Cert count drift**: unique DSGN count within ±5% of the previous snapshot's count. Tighter than row count — operator entity births and deaths are slower than fleet-on-cert churn. Cert count is the more meaningful gate; row count alone could let through real anomalies (e.g., a 15% fleet expansion across stable certs would pass a row-count gate set at ±20%).
6. **CFR domain**: every CFR value in `{135, 121/135}`. Any new value (e.g., `121`, `91K` — anticipatory) bails for review.
7. **Provenance**: file sha256, content-length, Last-Modified, ETag, and source URL recorded in the per-snapshot manifest in S3.

If any check fails: the snapshot lands in S3 (Bronze) but **does not promote** to Silver. A `pipeline_runs` row records `status='ingest_quality_gate_failed'` with the failure reason. Manual review unblocks via re-run with `--override-gate=<gate-name>`.

**What happens when the source is unavailable**:
- HEAD/GET returns 4xx or 5xx: log a `pipeline_runs` row with `status='source_unavailable'`. No Silver/canonical change. Retry next Monday.
- Page redirect chain breaks (301 chain extends or returns to a 4xx): bail, surface for manual review.
- File HTTP 200 but Content-Type wrong (HTML, not XLSX): treat as outage. The FAA's prior deactivation pattern was page-up-with-no-file, not page-down. Detect via Content-Type, not via HTTP status.
- Three consecutive Mondays of unavailability: write a `pipeline_runs` row with `status='source_unavailable_3w'` and trigger a notification. Mechanism is TBD but a script that emails Phelipe is sufficient — `canonical.operator_events` scaffolding is empty per `docs/codebase-map.md` §3.1 and populating it is out of scope for this plan. Triggers a manual decision on whether to fall back to weekly Wayback fetches against the most recent FAA-side capture.

### 2.2 AVinfo.gov Air Operator Search (DBA + extra detail supplement)

**Identity**: the FAA's "AVinfo.gov – Air Operator Search," referenced from the Part 135 page text as: *"to search by operator name or operator's doing business as (DBA) name to verify charter authorization and find additional operator information. Updated daily."* This is the FAA's authoritative DBA source for charter operators. The Part 135 page explicitly notes "We're currently working on merging these two resources together," but until that merger ships, AVinfo.gov is the only Tier 1 path to DBA names.

**Recon status**: not yet performed. Step B.0 (in §4 step sequence) does a read-only recon pass before any ingester is built. Until that recon completes, the rest of this subsection is **provisional** — endpoint shape, query interface, fields available, cadence semantics — and may be revised after Step B.0 lands. The provisional content is the working assumption for plan timing and risk-register entries; it is not load-bearing for any code.

**Anticipated endpoint** (to verify in Step B.0): `https://av-info.faa.gov/` with an Air Operator Search interface. Query mechanism unknown — could be GET-with-query-string (cacheable, ingester-friendly), POST-with-form (non-cacheable, slower), or JS-rendered (Firecrawl-required, slowest). Recon decides the ingester architecture.

**Anticipated cadence**: daily per FAA page text. Polling cadence will mirror — daily Monday-Friday morning fetch. If the site lacks bulk export and supports per-operator search only, ingest is cert-keyed: iterate the 1,789 canonical operators from §2.1, look up each by DSGN or holder name, store the response.

**Anticipated fields** (to verify):
- DBA / trade names (the primary purpose of integrating this source)
- Headquarters address (city, state, ZIP, possibly street)
- Operator phone / fax
- Charter authorization status — wider than Part 135; AVinfo.gov also covers Part 121 / Part 91K per the page text
- Possibly: officer / chief pilot names (would route to `canonical.person` in a later track, not this plan)
- Cert designator (the join key back to §2.1)

**Integrity checks** (provisional, finalize after Step B.0):

1. Endpoint reachable with appropriate User-Agent.
2. Per-operator response includes the cert designator (used as the join key back to §2.1's DSGN).
3. DBA field populated for at least 30% of the 1,789 operators sampled. Empirical floor, not a schema CHECK — below threshold means recon misread the field semantics.
4. Cross-source cert designator match: AVinfo's cert designator equals the §2.1 DSGN for the same operator name. Mismatches surface as data-quality alerts (likely indicates a name-matching ambiguity, not a designator error).
5. Daily fetch quota: detect rate limiting early (HTTP 429 or response degradation patterns) and back off.

**What happens when the source is unavailable**:
- AVinfo.gov is **supplementary, not gating**. The rebuild proceeds without DBAs if AVinfo is down. SC-6's threshold is `≥45 of top-50` (not `=50`) precisely so a partial-down state still allows plan completion.
- Long-term down (≥30 days): record in `pipeline_runs`, document in `docs/data-sources.md` as "AVinfo.gov unavailable since YYYY-MM-DD." For the subset of operators that are also Part 295 brokers, DOT broker filings provide partial DBA coverage; this is a narrow corroborator, not a substitute (Part 295 covers brokers, not Part 135 operators generally — `docs/er-architecture-plan.md` Stage 6 framing). The primary fallback is operating without DBAs for the affected operators — SC-6's ≥45-of-50 threshold accommodates that partial-down state.
- Schema drift on AVinfo.gov: same posture as §2.1 — bail, surface, no Silver promotion.

### 2.3 Historical D085 archives (S3, Tier A historical)

**Identity**: 12 unique xlsx versions captured by Wayback between 2023-01-25 and 2026-02-16, archived to `s3://osa-dumont-backup/raw/faa/d085/` by `src/ingestion/archive-faa-d085-wayback.ts`. Index file at `s3://osa-dumont-backup/raw/faa/d085/_index.json` (per `src/utils/d085-parser.ts:34`). Per-snapshot manifest stored alongside; xlsx deduplicated by sha256 across captures.

**Role in this plan**: defunct-detection cross-reference. Without these archives, GQ9C and any future cert that disappears between snapshots cannot be marked defunct with a defensible `valid_to` date — the only signal would be "absent from May 1 file," which doesn't tell us when the cert left. The 12 archived snapshots span 39 months and bracket GQ9C's last appearance precisely enough to set `valid_to = '2026-02-16'` (the Wayback last-snapshot date pre-restoration).

**Cadence**: static. The 12 captures are frozen; the archive script does not run continuously. Forward-running snapshots from 2026-05-01 onward come from §2.1's weekly ingest — those land in `s3://osa-dumont-backup/raw/faa/d085/snapshots/` with the same key shape, organically extending the historical dataset over time.

**Schema fingerprint** (per `d085-parser.ts:19–24`, recon-confirmed against the documented column list):

| Field | Value |
|---|---|
| Date range | 2023-01-25 → 2026-02-16 |
| Unique xlsx versions captured | 12 |
| Header dialect | `Part 135 Certificate Holder Name`, `Certificate Designator`, `FAA Certificate Holding District Office`, `Registration Number`, `Serial Number`, `Aircraft Make/Model/Series` |
| 2023-only column | `CFR` (always `135`, dropped 2024+) |
| Banner rows | 0–N preceding headers (variable per capture; HEADER_SCAN_ROWS=30 absorbs) |
| DBA / HQ columns | absent (same as live file) |

This is the **old schema**. The May 1 file uses short codes (`Name`, `DSGN`, `CHDO`, `Registration No.`, `Aircraft M/M/S`). The historical archive parser keeps the old candidate list; the new ingester carries the updated list (Step 0 parser update lands both). Two parsers, one file format conceptually, two header dialects in practice. Captured in §5 (risk register).

**Integrity checks** (one-shot, run during defunct-detection cross-reference; not on every ingest):

1. `_index.json` reachable on S3 and deserializes to the schema in `d085-parser.ts:99–114`.
2. Each `xlsx_s3_key` in the index resolves to an S3 object whose sha256 matches the index entry (catches in-transit corruption).
3. Per-cert presence map computable: for any DSGN, walk all 12 snapshots and emit `(date_first_seen, date_last_seen, present_in_most_recent_capture)`. Used by Step 3 (canonical population) to set `valid_to` on closing windows.
4. Header dialect detection: each archive xlsx parses with the OLD candidate list; if any archive xlsx parses ONLY with the new short-code dialect, that's a data-quality flag (would suggest the FAA reuploaded an archive with the new schema, which would invalidate historical timestamps). **Run once at Step 3 ingest, not on every weekly fetch** — the historical archive is frozen, so per-fetch re-validation is wasteful.

**What happens when the source is unavailable**:
- S3 has 11-9s durability (per AWS) and the archive bucket is `STANDARD` storage class (per `docs/s3-storage-strategy.md:58–59`). True unavailability is implausible.
- If the index file is corrupted or missing: defunct-detection falls back to "absent from May 1 file → `valid_to = previous-known-snapshot-date` if any historical record exists for the cert in our local data, else `valid_to = NULL` with a `defunct_inferred=true` flag." Lossy but not blocking.
- Index/manifest schema drift: the archive script is frozen — its output schema does not evolve. If a future session changes it, this plan's Step 3 reader needs an explicit version check. Not applicable today.

### 2.4 Sources NOT used in the rebuild

Explicit exclusions to keep scope tight:

- **DOT Part 295 / Part 298 broker filings**: planned for Track 1 Stage 6 (`docs/er-architecture-plan.md`). Not a primary operator-pool source; broker entities live in a different `operator_type` bucket. Will be a corroboration source for cert-holder identity post-rebuild.
- **SEC EDGAR**: planned for Track 1 Stage 3 (rebrand corroboration via 8-K filings). Not an operator-pool source; an identity-change corroborator.
- **State SOS records**: planned for Track 1 Stage 5 (corporate structure: officers, registered agents, EIN). Not an operator-pool source.
- **ARGUS / Wyvern**: Tier E per `docs/data-sources.md`. Subject-paid audits — enrichment-only, never authoritative. The 22 + 223 existing identity rows in `public.operator_identities` stay; they do not gate the rebuild and they do not earn write-priority.
- **LinkedIn**: excluded permanently (`docs/data-sources.md` §"Excluded sources", Invariant 5b). Non-negotiable. Do not reopen this in this plan or any session derived from it.
- **OpSpec D085 via FOIA**: deferred. The Tier 1 public file is back, so FOIA — which had been the fallback when the public file was down — is no longer the active path. Revisit only if the public file goes down and stays down >90 days.
- **JETNET / AMSTAT**: Tier E per `docs/er-architecture-plan.md` line 20. Paid by the subjects they report on. Not used.
- **LLM aggregators (rebrand/acquisition claims)**: ~25% false-positive rate per `docs/er-architecture-plan.md` line 21 (April 2026 OSA calibration). Used inside the LLM ER orchestrator with the 5-layer validator (Session B path), but never as an authoritative pool source.

---

## 3. Schema and migration sequence

### 3.1 Layered architecture

The rebuild flows through three layers, each with a clear contract:

```
S3 raw xlsx (Bronze-zero)
   ↓ ingester reads file, validates against integrity checks (§2.1)
bronze.faa_p135_oa_list_rows               (one row per file row, append-only, no normalization)
   ↓ promote-bronze-to-silver script (per snapshot)
silver.faa_p135_oa_list_normalized          (UPPER + trim + collapse, /-to-, transform on operating_part, CHECK constraints)
   ↓ promote-silver-to-canonical script (first-time bootstrap, then incremental)
canonical.certificates                       (one row per DSGN, operating_part populated)
public.operators                             (one row per unique operator, multi-cert dedup applied)
canonical.operator_holds_certificate         (one row per operator × cert × role × daterange window)
canonical.aircraft_on_certificate            (one row per aircraft × cert × daterange window — Stage 2b shape, refreshed)
```

Bronze captures raw fidelity. Silver captures schema validity. Canonical captures entity identity. Each layer is queryable; demotion (canonical → silver, silver → bronze) is forbidden — fixes go forward as new ingests, never as in-place mutation, per `docs/temporal-link-pattern.md` Rule 1 (append-only).

`canonical.operator_aircraft_link role='operator'` is **not** repopulated in this plan's promotion. That layer derives from the cert-bridge pathway, re-run as Step 6 of §4. The promotion logic stops at `aircraft_on_certificate` and `operator_holds_certificate`; cert-bridge JOINs the two and writes the operator-aircraft link.

### 3.2 Bronze layer — `bronze.faa_p135_oa_list_rows`

A new schema. `_schemas.sql` adds `CREATE SCHEMA IF NOT EXISTS bronze`. The migration runner (`src/db/migrate-pg.ts:45–56`) loads `_schemas.sql` at position 2 (creates the `bronze` namespace) and `migrations/` at position 10 (where bronze tables will be defined). The runner detects schemas dynamically via `extractTableNames` (lines 90–105) — **no `LOAD_ORDER` change needed, no `schema/bronze/` folder needed**. Verified 2026-05-05 by reading the loader. Bronze tables ship in dated migrations under `schema/migrations/`, mirroring how new canonical tables have shipped during Track 6.

Two tables:

```sql
-- Per-snapshot metadata. One row per weekly fetch where the file changed.
CREATE TABLE bronze.faa_p135_oa_list_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,                  -- FAA file's Last-Modified date
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_url TEXT NOT NULL,                     -- canonical xlsx URL
  s3_key TEXT NOT NULL,                         -- raw/faa/d085/snapshots/<pageTs>/<filename>
  sha256 TEXT NOT NULL,
  content_length BIGINT NOT NULL,
  http_etag TEXT,
  http_last_modified TIMESTAMPTZ,
  total_data_rows INTEGER NOT NULL,
  unique_dsgn_count INTEGER NOT NULL,
  ingest_run_id TEXT NOT NULL,                  -- correlation id with pipeline_runs
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (snapshot_date, sha256)                -- same content fetched twice in a day = idempotent
);

-- One row per file data row per snapshot. Verbatim values, no normalization.
CREATE TABLE bronze.faa_p135_oa_list_rows (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id UUID NOT NULL REFERENCES bronze.faa_p135_oa_list_snapshots(id) ON DELETE RESTRICT,
  raw_row_index INTEGER NOT NULL,               -- 1-based row index within the file (excluding header)
  cfr TEXT,
  chdo TEXT,
  dsgn TEXT,
  name TEXT,
  aircraft_mms TEXT,
  registration_no TEXT,
  serial_no TEXT,
  ingestion_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_id, raw_row_index)
);

CREATE INDEX idx_bronze_p135_dsgn ON bronze.faa_p135_oa_list_rows(dsgn);
CREATE INDEX idx_bronze_p135_snapshot ON bronze.faa_p135_oa_list_rows(snapshot_id);
CREATE INDEX idx_bronze_p135_registration ON bronze.faa_p135_oa_list_rows(registration_no) WHERE registration_no IS NOT NULL;
```

Contract: ingester writes. Append-only. No UPDATEs ever. No CHECK constraints — the bronze layer accepts whatever the file provides. Schema-level invariants are enforced in Silver, not here.

Storage shape: 11,465 rows × ~52 weekly snapshots ≈ 600K rows/year. Index footprint ~30 MB/year. Negligible in Supabase.

### 3.3 Silver layer — `silver.faa_p135_oa_list_normalized`

```sql
CREATE TABLE silver.faa_p135_oa_list_normalized (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id UUID NOT NULL REFERENCES bronze.faa_p135_oa_list_snapshots(id) ON DELETE RESTRICT,
  bronze_row_id BIGINT NOT NULL REFERENCES bronze.faa_p135_oa_list_rows(id) ON DELETE RESTRICT,

  cert_designator TEXT NOT NULL,                 -- = bronze.dsgn (UPPER + TRIM)
  operator_name TEXT NOT NULL,                   -- = bronze.name (TRIM + collapse-whitespace; case preserved)
  operator_name_normalized TEXT NOT NULL,        -- UPPER + collapse + strip-corp-suffixes (LLC, Inc, Corp, ...)
  fsdo TEXT,                                     -- = bronze.chdo (UPPER + TRIM)
  operating_part TEXT NOT NULL,                  -- = bronze.cfr with '/' → ',' transform
  aircraft_make_model_series TEXT,               -- = bronze.aircraft_mms
  registration_number TEXT,                      -- = bronze.registration_no (UPPER + TRIM, leading 'N' preserved)
  serial_number TEXT,                            -- = bronze.serial_no (TRIM)

  CHECK (cert_designator ~ '^[0-9A-Z]{3,5}$'),
  CHECK (operating_part ~ '^[0-9]+[A-Z]?(,[0-9]+[A-Z]?)*$'),

  promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (snapshot_id, cert_designator, registration_number, serial_number)
);

CREATE INDEX idx_silver_p135_dsgn ON silver.faa_p135_oa_list_normalized(cert_designator);
CREATE INDEX idx_silver_p135_op_name_normalized ON silver.faa_p135_oa_list_normalized(operator_name_normalized);
CREATE INDEX idx_silver_p135_snapshot ON silver.faa_p135_oa_list_normalized(snapshot_id);
```

Contract: promotion script reads bronze rows for a specific snapshot, derives normalized values, writes to silver in a single transaction per snapshot. Idempotent re-runs use `ON CONFLICT DO NOTHING` against the UNIQUE constraint.

The two CHECK constraints are the structural guarantees that made it through normalization. If a bronze row's values can't satisfy them, promotion drops the row and writes a `pipeline_runs` row with `status='silver_promotion_dropped_row'` and the bronze_row_id in the payload. Drops are rare but expected (occasionally the FAA file has a malformed cell — e.g., a stray space in a designator).

### 3.4 Canonical promotion logic

Three canonical destinations. Each has its own promotion path; all three run from the same silver source per snapshot.

#### 3.4.1 `canonical.certificates`

One canonical row per unique `cert_designator`. The schema already exists (`schema/canonical/certificates.sql`).

Promotion:

```sql
-- For each new DSGN observed in silver:
INSERT INTO canonical.certificates (
  cert_authority,
  faa_cert_number,
  canonical_holder_name,
  operating_part,
  status,
  data_confidence_score
)
SELECT
  'faa',
  s.cert_designator,
  s.operator_name,                              -- holder name as currently provided; canonical_name lives on public.operators
  s.operating_part,                             -- already comma-form via Silver transform
  'active_operating',
  0.95                                          -- Tier 1 source, single-publisher, high but not 1.0 (no second-source corroboration yet)
FROM silver.faa_p135_oa_list_normalized s
WHERE s.snapshot_id = :latest_snapshot_id
  AND s.cert_designator NOT IN (SELECT faa_cert_number FROM canonical.certificates WHERE faa_cert_number IS NOT NULL)
GROUP BY s.cert_designator, s.operator_name, s.operating_part;
```

Edge case: same DSGN in silver with two different `operating_part` values across snapshots (cert authority changed). The first promotion wins; subsequent runs detect via the existing UNIQUE INDEX `ux_certificates_faa_cert_number`. Authority transitions are recorded as `canonical.certificate_events` rows with `event_type='transferred'` (out of scope for this plan; covered in §4 Step 4).

#### 3.4.2 `public.operators`

One canonical row per unique normalized operator name. **This is where multi-cert single-parent dedup happens** (see §3.5).

Promotion:

```sql
-- For each unique operator_name_normalized in the latest snapshot, insert one operators row:
INSERT INTO public.operators (
  canonical_name,
  operator_type,
  data_confidence_score,
  last_seen_source,
  last_seen_at
)
SELECT DISTINCT
  s.operator_name,                              -- preserves original case
  CASE
    WHEN s.operating_part = '135' THEN 'part_135'
    WHEN s.operating_part = '121,135' THEN 'part_135'  -- dual-cert: Part 135 is the relevant role here
    ELSE 'part_135'
  END,
  0.95,                                          -- single-source Tier 1
  'faa_d085_2026_05_01',
  NOW()
FROM silver.faa_p135_oa_list_normalized s
WHERE s.snapshot_id = :latest_snapshot_id
  AND s.operator_name_normalized NOT IN (
    SELECT UPPER(REGEXP_REPLACE(canonical_name, '[[:space:]]+', ' ', 'g'))
    FROM public.operators
  );
```

Two new columns on `public.operators` (added in migration 003):
- `last_seen_source TEXT` — most recent source identifier that confirmed this operator (e.g., `faa_d085_2026_05_01`, `faa_d085_2026_05_08`, …). Used in SC-1.
- `last_seen_at TIMESTAMPTZ` — most recent ingest that observed this operator. Updated on every weekly ingest where the operator appears.

When the same operator appears in subsequent weekly snapshots, promotion does an UPDATE-only path: `UPDATE public.operators SET last_seen_source = :run_source, last_seen_at = NOW() WHERE id = :existing_id`. No new row is created.

#### 3.4.3 `canonical.operator_holds_certificate`

One row per (operator_id, cert_id, role, daterange) per the existing schema. `valid_from` is the snapshot_date of the first observation; `valid_to` is NULL while the operator-cert pair appears in subsequent snapshots; closes when a snapshot stops including the pair (Step 6 closing logic, post-rebuild).

Promotion (first-time bootstrap):

```sql
INSERT INTO canonical.operator_holds_certificate (
  operator_id, cert_id, role, valid_from, valid_to,
  source, source_url, source_timestamp, confidence, match_method, evidence
)
SELECT DISTINCT
  o.id,
  c.cert_id,
  'holder_of_record',
  :first_snapshot_date,
  NULL,
  'faa_d085',
  :source_url,
  :snapshot_timestamp,
  0.95,
  'faa_p135_list_2026_05_direct',                 -- new match_method value, no resolver involved
  jsonb_build_object(
    'snapshot_id', :snapshot_id,
    'snapshot_date', :first_snapshot_date,
    'cert_designator', s.cert_designator,
    'operating_part', s.operating_part,
    'operator_name_at_snapshot', s.operator_name,
    'fsdo', s.fsdo
  )
FROM silver.faa_p135_oa_list_normalized s
JOIN public.operators o ON o.canonical_name = s.operator_name
JOIN canonical.certificates c ON c.faa_cert_number = s.cert_designator
WHERE s.snapshot_id = :latest_snapshot_id;
```

This bypasses the entity-resolution matcher entirely. The Part 135 file is authoritative — DSGN is the cert, Name is the operator, no fuzzy matching needed. `confidence=0.95` reflects single-source Tier 1 with no second-source corroboration. (When a non-FAA Tier 1 corroborator lands later — DOT 295, SEC EDGAR — the row's `corroborated_by` JSONB gets appended and downstream views may treat the ohc row as `confidence=1.00`.)

The 0.95 figure matches Session A's existing high-tier confidence and SC-2's `≥ 0.85` threshold. Crossings of the existing EXCLUDE constraint are impossible by construction here (one row per (operator, cert, role) for a single bootstrap snapshot).

**Confidence semantics**: both Session A's high-tier resolver path and this plan's direct-ingest path legitimately earn `0.95` (Tier 1 source-confident in both cases). The discriminator is `match_method`. Session A's Step 2c populated `match_method='d085_holder_exact'` (per `scripts/backfill-canonical-operator-holds-certificate-from-d085.ts:75`). This plan populates `match_method='faa_p135_list_2026_05_direct'`. Future queries that need to distinguish populations must filter on `match_method`, not on `confidence`.

#### 3.4.4 `canonical.aircraft_on_certificate`

Reuses Stage 2b's window-construction logic against the new silver source. Per `schema/canonical/certificates.sql:159–207`, the table EXCLUDES on `(aircraft_id, cert_id, daterange &&)` — same airframe authorized on the same cert twice in overlapping windows is forbidden, but same airframe on two different certs simultaneously (Part 91K + Part 135 fractional) is allowed.

The aircraft side requires JOIN to `canonical.aircraft` via `registration_number`. Stage 2b's existing approach (`backfill-canonical-aircraft-on-certificate-from-d085.ts`) handles unresolved tails via `canonical.aircraft_on_certificate_pending`. The same script extends to read silver instead of S3 xlsx directly — that's a code change, no schema change.

### 3.5 Multi-cert single-parent — canonical representation

The May 1 file shows 1,791 unique DSGNs against 1,789 unique operator names. At least 2 operators hold multiple certs in this snapshot. The canonical shape handles this without new schema:

- **One row in `public.operators` per parent operator** (deduped by normalized name).
- **Multiple rows in `canonical.operator_holds_certificate`**, one per cert held, all with the same `operator_id` but different `cert_id`.

Constraint check — does the existing EXCLUDE block this?

```sql
-- existing EXCLUDE on canonical.operator_holds_certificate (per schema):
EXCLUDE USING gist (
  operator_id WITH =,
  cert_id     WITH =,
  role        WITH =,
  daterange(valid_from, valid_to, '[)') WITH &&
)
```

The triple `(operator_id, cert_id, role)` is the partition key; the daterange must be non-overlapping within a partition. Two rows with **same operator, different cert** satisfy this — they're in different partitions. Two rows with **same operator, same cert, same role** must be temporally non-overlapping — that's the one-window-per-cert guarantee.

The schema is correct as-is. No migration needed for multi-cert single-parent. The bug-class to watch is over-merging (two genuinely-different operators with similar names getting deduped to a single row), not under-merging.

**Detection during Silver promotion**: group silver rows by `operator_name_normalized`; for each group, collect the set of distinct DSGNs. Groups with `|distinct DSGNs| > 1` are multi-cert single-parent candidates. Two cases:

1. **Auto-merge OK**: if all rows in the group share an exact-match `operator_name_normalized` AND the operator names (case-folded) are byte-identical, auto-promote as one operator with N ohc rows. The 1,789 vs 1,791 gap likely lives here — same name, different cert numbers, well-known fractional or sister-entity patterns.
2. **Manual review**: if names differ in case, punctuation, or trailing tokens (`"Acme Aviation"` vs `"Acme Aviation Inc"`), surface the candidate group to a manual-review queue. The reviewer either confirms merge (one operator, N ohc rows) or splits (N operators, N ohc rows). Default during initial bootstrap: surface to review for any non-byte-identical group.

Uniqueness consideration on `public.operators`: the table does not currently enforce a UNIQUE on `canonical_name` (per `docs/codebase-map.md` §3 — only `operator_identities (source, source_id)` is unique). That's intentional: name collisions exist (e.g., two unrelated "Aviation Services LLC" entities). Silver-to-canonical promotion adds a new pre-check: before INSERT, verify no existing row has the same `operator_name_normalized` AND the same `operator_type`. If so, reuse the existing operator_id and add another `operator_identities` row instead of inserting a duplicate operator.

**Manual review target**: candidates that fail byte-identical normalized name match surface to `public.operator_match_review` with `review_type='multi_cert_single_parent_dedup'`. The `review_type` column is added in migration 005 (§3.8); existing rows default to `review_type='er_match'`. The `scraped_payload` JSONB carries the candidate group's DSGNs, the verbatim operator names from each silver row, the operating_part values, and the snapshot_id. The reviewer either confirms merge (one operator + N ohc rows) or splits (N operators + N ohc rows). The 1,789 vs 1,791 gap means a minimum of 2 review entries from the May 1 snapshot; lookalike-near-miss cases (e.g., `"Acme Aviation"` vs `"Acme Aviation Inc"`) raise that count.

### 3.6 Polluted rows decision — separate `aircraft_owners` table

**Decision**: Option A — move the 3,848 polluted rows out of `public.operators` into a new `public.aircraft_owners` table.

**Reasoning**:

1. `docs/phase1-followups.md` §1 explicitly recommends this: *"Aircraft-owner records land in a dedicated `aircraft_owners` table … Trust/bank/individual-owner EXCLUDE_PATTERNS are applied at the cert-generation step."* The pollution was a category mistake, not a data-quality drift; the fix is to separate categories.
2. Six-entity discipline (`docs/invariants-2026-05-04.md` §4): operator and aircraft are distinct entities. Aircraft-owner names belong to the aircraft entity (or its owner sub-role), not the operator entity. Conflating them creates ambiguity downstream every query has to filter around.
3. SC-1's promise — "queries against `public.operators WHERE operator_type='part_135'` return only verified Part 135 operators" — is structurally enforced by removing the polluted rows, not by adding a filter clause that's easy to forget. A flag-based deprecation approach gets ignored when a future query forgets the filter.
4. Reversibility: the migration preserves UUIDs (the new `aircraft_owners.id` equals the old `public.operators.id`), so any FK that reaches into the polluted ID space can be re-pointed at `aircraft_owners` rather than dropped.

**Operational risk**: existing FK references. Tables that point at `public.operators(id)`:
- `canonical.operator_aircraft_link.operator_id` — Session A's source distribution shows 13 rows from the legacy CP3 path, possibly polluted.
- `canonical.operator_holds_certificate.operator_id` — post-Session-A this contains 115 rows, all real operators per the audit.
- `canonical.operator_holds_certificate_pending.resolved_to_operator_id` — likely all NULL.
- `public.operator_identities.operator_id` — likely 1+ rows per polluted operator.
- `public.operator_aliases.operator_id` — dead infra, likely 1 row total.

The migration script's pre-flight (Step 4 of §4) audits these tables for any FK that points at a polluted ID. Findings:
- **Zero references**: pure migration — move rows, drop nothing.
- **Identity-table only**: move identities along with the row (re-target to `aircraft_owners.id`). New FK `operator_identities.aircraft_owner_id` (nullable) added in same migration.
- **Cross-table references** (e.g., `operator_aircraft_link` to a polluted ID): bail. Surface for manual triage. Possible resolutions: (a) keep the polluted row in `public.operators` with a deprecation flag, (b) update the FK to point at a real operator if mis-resolved, (c) delete the FK row if it's a stale CP3 artifact. Each manual decision is logged.

The migration is one-shot, reversible. Rollback re-creates the rows in `public.operators` from `public.aircraft_owners` (same UUID), drops `public.aircraft_owners` table.

**Audit findings reviewed before migration 004 runs**: if the pre-flight FK audit surfaces cross-table references (operator_aircraft_link, operator_holds_certificate, etc., pointing at any of the 3,848 polluted IDs), the migration is **paused for case-by-case decisions before proceeding**. The decision log lives in `docs/sessions/session-a5-fk-audit-decisions.md` and traces each resolved FK back to its rationale (which polluted ID, which referencing table, which resolution chosen, why). After the log is finalized and signed off, the migration script runs in `--write` mode against the post-decision plan. Skipping this step risks orphaning real data behind silently dropped FKs — exactly the failure pattern Session A's audit-then-quarantine workflow was designed to prevent at a smaller scale.

### 3.7 AVinfo.gov schema decision — `<dba_table>` resolved

The SC-6 placeholder `<dba_table>` resolves to **`public.operator_aliases`**, with `alias_type='dba'` and `source='avinfo_gov'`.

Reasoning:

1. The table already exists. Reusing it avoids a new schema concept ("aliases" already exists, "DBA" is one type of alias).
2. Reviving dead infra is healthier than creating a parallel table. `phase1-followups.md` calls out `public.operator_aliases` as having only 1 row after Stage 1 "complete." The DBA backfill from AVinfo turns the table into a populated, useful entity.
3. Multi-DBA per operator is supported — one alias per row; same operator can have multiple DBAs.
4. **`alias_type` CHECK already includes `'dba'`** — verified 2026-05-05 against `schema/gold/canonical/operators.sql:96`, where the constraint is `CHECK (alias_type IN ('legal','dba','marketing','historical'))`. No CHECK migration needed. The `phase1-followups.md` note about `'icao_callsign'` not being in the CHECK is a separate concern (different alias_type, not relevant to this plan).

For AVinfo's **rich fields** (HQ city/state/ZIP, phone, charter authority confirmation), DBA-as-alias doesn't fit. A separate snapshot table:

```sql
CREATE TABLE canonical.operator_avinfo_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  cert_designator TEXT NOT NULL,                  -- join key from §2.1
  fetch_date DATE NOT NULL,                       -- the AVinfo fetch date

  -- Fields (provisional pending Step B.0 recon — finalize then)
  hq_city TEXT,
  hq_state TEXT,
  hq_zip TEXT,
  hq_street TEXT,
  phone TEXT,
  charter_authority TEXT,                         -- comma-separated parts (e.g. '135', '121,135', '91K')
  raw_response_jsonb JSONB,                       -- full AVinfo response for forward-compat

  source TEXT NOT NULL DEFAULT 'avinfo_gov',
  source_url TEXT,
  ingestion_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (operator_id, fetch_date)
);

CREATE INDEX idx_op_avinfo_op_fetch ON canonical.operator_avinfo_snapshot(operator_id, fetch_date DESC);
CREATE INDEX idx_op_avinfo_dsgn ON canonical.operator_avinfo_snapshot(cert_designator);
```

Daily AVinfo fetches append to this table. `(operator_id, fetch_date)` UNIQUE makes re-fetches on the same day idempotent. DBAs from the same response also get written to `public.operator_aliases` (dual-write pattern; the snapshot table holds the structured rich fields, the aliases table holds the names that downstream queries actually JOIN against).

**Orphan handling**: when AVinfo's response covers a cert designator that is not in `canonical.certificates` (e.g., a Part 91K or Part 121 operator outside the Part 135 file's scope, or a defunct operator the file no longer carries), the response is **discarded for canonical write purposes**. A `pipeline_runs` row records `status='avinfo_orphan_response'` with the orphan DSGN and the full AVinfo response payload in the run payload. AVinfo is supplementary, not authoritative for entity creation — orphans are not bootstrapped into `public.operators` (that would violate the pool's "Part 135 only, sourced from the FAA Part 135 file" provenance guarantee). Later workstreams (Part 91K ingester, Part 121 ingester, both deferred per six-entity discipline) can revisit the orphan log when those tracks open. The orphan log is the audit surface for "AVinfo knows about an operator we don't" — useful but not gating.

### 3.8 Migrations sequence

All migrations follow the three-step verification per `CLAUDE.md` §4: (1) local Docker rollback test, (2) `npm run db:migrate-pg` exits 0, (3) explicit prod verification (`psql \d+`).

| # | File | Contents | Rollback |
|---|---|---|---|
| 001 | `2026-05-05-001-bronze-schema-and-faa-p135-tables.sql` | `CREATE SCHEMA IF NOT EXISTS bronze;` + `bronze.faa_p135_oa_list_snapshots` + `bronze.faa_p135_oa_list_rows` + 3 indexes | `2026-05-05-001-bronze-schema-and-faa-p135-tables-rollback.sql` (drops both tables; drops `bronze` schema if empty) |
| 002 | `2026-05-05-002-faa-p135-oa-list-silver.sql` | `silver.faa_p135_oa_list_normalized` + 3 indexes + 2 CHECKs | `2026-05-05-002-faa-p135-oa-list-silver-rollback.sql` (drops table) |
| 003 | `2026-05-05-003-operators-last-seen-source.sql` | `ALTER TABLE public.operators ADD COLUMN last_seen_source TEXT, ADD COLUMN last_seen_at TIMESTAMPTZ;` + supporting index. Both columns NULLable. Existing ~50 verified Part 135 rows remain NULL until the first weekly ingest populates them via the operator-match-and-update path (§3.4.2). The 3,848 polluted rows that move to `aircraft_owners` in migration 004 never need these columns. | `2026-05-05-003-operators-last-seen-source-rollback.sql` (drops columns; warns if non-NULL data lost) |
| 004 | `2026-05-05-004-aircraft-owners.sql` | `public.aircraft_owners` + indexes + nullable `public.operator_identities.aircraft_owner_id` FK | `2026-05-05-004-aircraft-owners-rollback.sql` (drops table; drops added FK; warns about identity rows that must move first) |
| 005 | `2026-05-05-005-operator-match-review-add-review-type.sql` | `ALTER TABLE public.operator_match_review ADD COLUMN review_type TEXT NOT NULL DEFAULT 'er_match' CHECK (review_type IN ('er_match', 'multi_cert_single_parent_dedup'));` Existing rows default to `'er_match'`. Note: `public.operator_aliases.alias_type` CHECK was independently verified to already include `'dba'` (see §3.7); no separate migration for that. | `2026-05-05-005-operator-match-review-add-review-type-rollback.sql` (drops `review_type` column; warns if non-default values exist on rollback) |
| 006 | `2026-05-05-006-canonical-operator-avinfo-snapshot.sql` | `canonical.operator_avinfo_snapshot` + 2 indexes + UNIQUE `(operator_id, fetch_date)` | `2026-05-05-006-canonical-operator-avinfo-snapshot-rollback.sql` (drops table) |

Total: 6 migrations + 6 rollback files. All idempotent via `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (Postgres 15+). Each rollback warns explicitly when it would destroy data (per the existing pattern in `schema/rollback/`).

### 3.9 Data-migration scripts (not schema migrations)

These scripts move data, not schema. They live in `scripts/` and run after the schema migrations land.

| Script | Purpose | Reversible? |
|---|---|---|
| `scripts/migrate-aircraft-owners-from-operators.ts` | Move 3,848 polluted rows from `public.operators` → `public.aircraft_owners`. Pre-flight FK audit, per-row tx, audit log. UUIDs preserved. | Yes. Re-running with `--reverse` re-creates rows in `public.operators` and drops them from `aircraft_owners`. |
| `scripts/promote-faa-p135-bronze-to-silver.ts` | Promote a snapshot's bronze rows to silver. Idempotent via UNIQUE constraint. | Forward-only. To "undo" a promotion, manual DELETE FROM silver WHERE snapshot_id=…. |
| `scripts/promote-silver-to-canonical-operators.ts` | Bootstrap: from latest silver snapshot, populate `canonical.certificates`, `public.operators`, `canonical.operator_holds_certificate`. | Forward-only. Reset by manual DELETE per source filter. |
| `scripts/refresh-canonical-aircraft-on-certificate-from-silver.ts` | Stage-2b-equivalent against silver source (replaces XLSX-from-S3 path). | Forward-only. |

Each script: `--write` flag (default: dry-run), refused-if-populated guardrail (3 checks, per Stage 2c convention), audit log row in `canonical.operator_aircraft_resolution_log` for canonical writes, run id encoded as `track1_session_a5_<step>_<UTC-timestamp>`.

### 3.10 What this section does NOT decide

To keep §3 focused on schema and forward-data flow, the following are explicitly deferred:

- **Resolver gate-tightening** (`docs/phase1-followups.md` Step 2c.6 Item 2 — `top - runner_up ≥ 0.15` AND load-bearing-noun gate). Code change in `src/entity-resolution/operator-resolver.ts`, lands as part of Step 5 in §4 before the Step 2c re-run. Not a schema migration.
- **Parser update** (`d085-parser.ts` COLUMNS map adds DSGN, Registration No., CFR/CHDO/Aircraft M/M/S). Code change. Lands as Step 0 in §4.
- **The actual ingester implementation** (Monday HEAD-conditional-GET, manifest generation, integrity checks). Code, in `src/ingestion/`. Step 1 in §4.
- **AVinfo.gov ingester** (Step B in §4). Step B.0 recon must happen first; design lives in §4.
- **Cert-bridge re-derivation** (Step 6 in §4). The schema is unchanged from Session A; only the input ohc population is denser.

---

## 4. Step sequence with gates

The plan executes as eight serial steps (0 through 7) on the Part 135 track and four parallel sub-steps (B.0 through B.3) on the AVinfo track. Each step has a stop gate before the next begins; nothing proceeds without explicit Phelipe approval at the gate. The gates are not bureaucracy — they're the inspection points where the rebuild's invariants get re-checked against actual data, exactly as Session A's gate structure caught the false-positive pollution before cert-bridge propagated it.

The Part 135 track is the critical path. Step B can run in parallel with any of Steps 1–6 (B.0 recon depends only on internet access; B.1–B.3 depend on Step 3 having populated `public.operators` so AVinfo's response can be joined). The two tracks converge at Step 7 for SC-6 measurement.

### 4.0 Step 0 — Parser update

**Gate**:
- Phase 1 recon approved (Section 1 of this plan signed off).
- Local dev environment available with `tsx` runner.
- Read access to S3 (one historical xlsx fetched as a test fixture).

**Action**:

1. Update `src/utils/d085-parser.ts` `COLUMNS` map:
   - `cert_number.candidates`: append `"DSGN"` (preserve existing `"Certificate Designator"`, `"Certificate Number"`, `"FAA Certificate Number"` for historical archives).
   - `tail_number.candidates`: append `"Registration No."` (preserve existing entries).
   - `operator_name.candidates`: no change (existing `"Name"` already matches the May 1 dialect).
2. Add three new optional fields to `D085Row` interface and the parser output:
   - `operating_part: string | null` — sourced from `CFR` column.
   - `fsdo: string | null` — sourced from `CHDO` column.
   - `make_model_series: string | null` — sourced from `Aircraft M/M/S` column.
3. Update `COLUMNS` constant with new candidate lists for the three new fields:
   - `operating_part.candidates: ["CFR"]`
   - `fsdo.candidates: ["CHDO", "FAA Certificate Holding District Office"]`
   - `make_model_series.candidates: ["Aircraft M/M/S", "Aircraft Make/Model/Series"]`
4. Update the file's doc-comment block (lines 19–25) to record both header dialects observed: pre-2026-05 (`Part 135 Certificate Holder Name`, `Certificate Designator`, etc.) and post-2026-05 (`Name`, `DSGN`, `CHDO`, etc.).
5. Add tsx-runnable parser tests under `tests/d085-parser.test.ts`:
   - **Test A**: parse the May 1 file (downloaded ad-hoc to `/tmp/`, deleted after test). Assert: 11,465 rows extracted; cert_designator format `^[0-9A-Z]{3,5}$` for ≥99.5% of rows; CFR distribution `135` (~98.9%) + `121/135` (~1.1%); operator_name non-empty for 100% of rows.
   - **Test B**: parse one historical archive xlsx (e.g., `Part_135_Operators_and_Aircraft_4.xlsx` from S3 capture `20250207081625` — represents the old dialect). Assert: ≥1,500 rows extracted (historical files were smaller); cert_designator and operator_name populated.
   - Test fixtures NOT committed; tests pull from S3 at runtime via existing `fetchS3Buffer` helper. **Tests fail with a clear error message if S3 access is unavailable, not silently skip** — makes the dependency visible to future contributors.
6. Land migration 001 (`2026-05-05-001-bronze-schema-and-faa-p135-tables.sql`) per §3.8:
   - Add `CREATE SCHEMA IF NOT EXISTS bronze;` to `schema/_schemas.sql`.
   - Create `schema/migrations/2026-05-05-001-bronze-schema-and-faa-p135-tables.sql` with both bronze tables.
   - Create matching `schema/rollback/2026-05-05-001-bronze-schema-and-faa-p135-tables-rollback.sql`.
7. Three-step verification on migration 001 per `CLAUDE.md` §4: local Docker rollback test → `npm run db:migrate-pg` exit 0 → `psql \d+ bronze.faa_p135_oa_list_rows` returns expected shape against Supabase.

**Success criteria**:

- **Code**: `npm test` green, including new parser test cases A and B.
- **Schema**: `bronze.faa_p135_oa_list_snapshots` and `bronze.faa_p135_oa_list_rows` exist in Supabase with correct columns and indexes (verified via `psql \d+`).
- **Three-step verification**: all three steps documented in commit message per Session A's commit style.

**Surface for review before Step 1**:

- Parser test output (number of rows extracted from each fixture, CFR distribution from May 1 file, drop count if any).
- Migration 001 verification output (`psql \d+` for both bronze tables).
- Diff of `d085-parser.ts` `COLUMNS` map.
- Decision to proceed: yes/no/needs-fix.

---

### 4.1 Step 1 — Bronze ingester implementation

**Gate**:
- Step 0 approved.
- Bronze schema + tables verified in Supabase.
- Parser tests A and B green on parser updates.
- AWS S3 write access confirmed for `s3://osa-dumont-backup/raw/faa/d085/snapshots/`.

**Action**:

1. Create `src/ingestion/faa-p135-list-weekly.ts`:
   - HEAD-conditional-GET against the May 1 file URL (`https://www.faa.gov/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_List.xlsx`).
   - Compare ETag and Last-Modified against the most recent `bronze.faa_p135_oa_list_snapshots` row's `http_etag` / `http_last_modified`. If unchanged, exit cleanly with `pipeline_runs.status='no_change'`.
   - On change: GET, write xlsx to `s3://osa-dumont-backup/raw/faa/d085/snapshots/<pageTs>/Part_135_Operators_and_Aircraft_List.xlsx`, write manifest.json alongside.
2. Run integrity checks (per §2.1, items 1–7) before bronze write:
   - Sheet exists (`Part 135` or first-sheet-with-header-at-row-0).
   - Header match: 7 expected columns in the expected order.
   - DSGN format: ≥99.5% match.
   - Row count drift: ±10% vs prior snapshot (skip on first-ever ingest).
   - Cert count drift: ±5% vs prior snapshot (skip on first-ever ingest).
   - CFR domain: every value in `{135, 121/135}`.
   - Provenance recorded in manifest.
3. On any integrity-check failure: `pipeline_runs.status='ingest_quality_gate_failed'` + reason; xlsx stays in S3, no bronze write.
4. On all checks pass: bronze write in single transaction.
   - Insert one row into `bronze.faa_p135_oa_list_snapshots`.
   - Batch INSERT all data rows into `bronze.faa_p135_oa_list_rows` (parameterized; ~11K rows in batches of 1K).
   - Refused-if-populated guardrail on snapshot UNIQUE.
5. Add CLI flags: `--dry-run` (default-on for development), `--force` (skip cache check), `--max-retries=N`.
6. Schedule the weekly run on the host (Lightsail or local Mac dev). Cron entry `0 11 * * 1` ET starting cadence per §2.1.
7. **First production run**: fetch and ingest the May 1 snapshot. This is the bootstrap row in bronze.

**Success criteria**:

- `bronze.faa_p135_oa_list_snapshots` count: ≥1 row with `snapshot_date='2026-05-01'`, sha256 matching recon (`b4989eddbbc90c2689c7696b7c61f9161d0050c8eb6f1bc0caea999298fa9633`).
- `bronze.faa_p135_oa_list_rows` count for that snapshot: ≥11,400 (file has 11,465; ≥99.5% extraction floor).
- All 7 integrity checks pass on the May 1 file (recorded in pipeline_runs payload).
- S3 has the xlsx + manifest.json at the expected key.

**Surface for review before Step 2**:

- pipeline_runs payload from the first run (full integrity-check breakdown).
- Bronze count summary: snapshot row + data row count vs expected 11,465.
- S3 keys + sha256 confirmation.
- Decision to proceed.

---

### 4.2 Step 2 — Silver promotion

**Gate**:
- Step 1 approved.
- Bronze populated for the May 1 snapshot.
- Migration 002 (`silver.faa_p135_oa_list_normalized`) applied + three-step verified.

**Action**:

1. Land migration 002 per §3.8.
2. Create `scripts/promote-faa-p135-bronze-to-silver.ts`:
   - Reads `bronze.faa_p135_oa_list_rows WHERE snapshot_id = :target_snapshot_id`.
   - Per-row normalization: UPPER + TRIM + collapse-whitespace on text fields; `/`-to-`,` transform on operating_part; corp-suffix-strip on operator_name_normalized (matches the silver CHECK regex requirement).
   - Single tx INSERT into `silver.faa_p135_oa_list_normalized` with `ON CONFLICT (snapshot_id, cert_designator, registration_number, serial_number) DO NOTHING`.
   - Drops on CHECK violation: log to `pipeline_runs` with `status='silver_promotion_dropped_row'` + bronze_row_id + reason. Continue, don't bail.
3. CLI: `--write` (default dry-run), `--snapshot-id=<uuid>` to target a specific snapshot, `--latest` to target the most recent unprocessed snapshot.
4. Refused-if-populated guardrail: if silver already has rows for the target snapshot, exit cleanly. Re-runs require manual `DELETE FROM silver WHERE snapshot_id = :id` + re-run.
5. **First production run**: promote the May 1 snapshot to silver.

**Success criteria**:

- `silver.faa_p135_oa_list_normalized WHERE snapshot_id = :may_1_snapshot_id`: ≥11,400 rows.
- All rows pass both CHECK constraints (DSGN regex, operating_part regex).
- Drop count ≤5 (recon showed no malformed cells; near-zero expected).
- Operating_part values: `135` and `121,135` (post-`/`-to-`,` transform); no `121/135`.
- Operator_name_normalized populated for 100% of rows.

**Surface for review before Step 3**:

- Drop count + reasons per pipeline_runs (expected 0–5).
- Silver row count vs bronze row count (expected ≥99.95% match).
- Sample of `operator_name_normalized` values for visual sanity check.
- Distribution of operating_part values.
- Decision to proceed.

---

### 4.3 Step 3 — Canonical bootstrap

**Gate**:
- Step 2 approved.
- Silver populated for the May 1 snapshot.
- Migrations 003 (`public.operators` add columns) AND 005 (`operator_match_review.review_type`) applied + three-step verified.
- Existing `canonical.operator_holds_certificate WHERE source='faa_d085'` (115 rows from Session A) — **leave untouched**. The bootstrap writes new rows; no UPDATE or DELETE on existing rows.

**Action**:

1. Land migrations 003 and 005 per §3.8.
2. Create `scripts/promote-silver-to-canonical-operators.ts`:
   - **Phase A**: populate `canonical.certificates`. INSERT one row per unique `(cert_designator, operating_part)` from silver. Confidence 0.95. Status `'active_operating'`. Skip rows whose `cert_designator` already exists in canonical (Session A's 112 unique certs are part of these).
   - **Phase B**: populate `public.operators`. INSERT one row per unique `operator_name_normalized` not already present. Operator_type derives from operating_part per §3.4.2. Set `last_seen_source='faa_d085_2026_05_01'`, `last_seen_at=NOW()`.
   - **Phase B.1**: multi-cert single-parent dedup — group silver rows by `operator_name_normalized`; for groups with `|distinct DSGNs| > 1`, auto-merge if names are byte-identical, otherwise INSERT to `public.operator_match_review` with `review_type='multi_cert_single_parent_dedup'`. Surface to a manual review log. **Multi-cert review queue items can be resolved in parallel with Steps 4–6**. Step 7's SC-1 measurement runs against current state at measurement time; pending dedup items count as separate operators, which keeps SC-1 above its floor. After dedup decisions land, SC-1 may slightly decrease as N operators merge to fewer operators — that's fine, the floor accommodates the range (1,750 ≤ count ≤ 1,789).
   - **Phase C**: populate `canonical.operator_holds_certificate`. INSERT one row per (operator_id, cert_id, role='holder_of_record'). `valid_from = '2026-05-01'`, `valid_to = NULL`. `match_method = 'faa_p135_list_2026_05_direct'`. Confidence 0.95. Single tx per cert.
   - **Phase D**: refresh `canonical.aircraft_on_certificate`. Reuses Stage 2b's window-construction logic but reads silver instead of S3 xlsx. New `match_method = 'faa_p135_list_2026_05_silver'` to distinguish from Session A's existing rows.
3. **One-shot**: header dialect detection on historical archive (per §2.3). Run once at this step. Confirms historical xlsx still parses with old candidate list; flags any anomaly.

**Success criteria** (each is a SQL query):

- `SELECT COUNT(*) FROM canonical.certificates WHERE faa_cert_number IN (SELECT cert_designator FROM silver.faa_p135_oa_list_normalized WHERE snapshot_id = :may_1_snapshot_id)` returns ≥1,791.
- `SELECT COUNT(*) FROM public.operators WHERE operator_type='part_135' AND last_seen_source='faa_d085_2026_05_01'` returns ≥1,750 (≤1,789, accounting for multi-cert dedup). **This is SC-1's measurement**.
- `SELECT COUNT(DISTINCT cert_id) FROM canonical.operator_holds_certificate WHERE match_method='faa_p135_list_2026_05_direct'` returns ≥1,791. **This satisfies SC-2's structural requirement** (further measurement after Step 6).
- Multi-cert review queue: `SELECT COUNT(*) FROM public.operator_match_review WHERE review_type='multi_cert_single_parent_dedup'` returns ≥2 (the 1,791 vs 1,789 gap minimum).
- Header dialect detection: report shows all 12 historical xlsx files parsed successfully with old candidate list.

**Surface for review before Step 4**:

- SC-1 query result.
- Top-20 operators in the new `public.operators` rows by aircraft count (sanity check: NetJets, Flexjet, Executive Jet Management, Air Methods, Sunset, Ameriflight should appear).
- Multi-cert review queue contents — Phelipe walks the queue manually and decides merge/split for each.
- Header dialect detection output.
- Decision to proceed.

---

### 4.4 Step 4 — Polluted-rows migration

**Gate**:
- Step 3 approved.
- Migration 004 (`public.aircraft_owners`) applied + three-step verified.
- Pre-flight FK audit script ready (TS, dry-run-only — does not move rows).

**Action**:

1. Land migration 004 per §3.8.
2. Create `scripts/migrate-aircraft-owners-from-operators.ts` with two modes:
   - `--audit`: scan FK-targeting tables (`canonical.operator_aircraft_link`, `canonical.operator_holds_certificate`, `canonical.operator_holds_certificate_pending`, `public.operator_identities`, `public.operator_aliases`) for any reference to the 3,848 polluted IDs. Report counts + sample rows. **This mode does NOT write.**
   - `--write`: actual migration. Per-row tx. Move row from `public.operators` → `public.aircraft_owners` (preserving UUID). Re-target `operator_identities.operator_id` → `operator_identities.aircraft_owner_id`. Audit log row in `canonical.operator_aircraft_resolution_log`.
3. **Pre-flight run**: `--audit` mode. Output goes to stdout + a structured report file under `.work/`.
4. **Decision log**: if cross-table FK references exist, write `docs/sessions/session-a5-fk-audit-decisions.md`. Each finding gets:
   - polluted operator_id
   - referencing table + row id
   - proposed resolution (move-and-re-target, keep-with-deprecation-flag, or delete-stale-row)
   - rationale
   - Phelipe sign-off

   **Fast-path for the zero-reference case**: if `--audit` reports zero FK references to polluted IDs, the decision log is unnecessary. Proceed directly to `--write` with a one-line note in `docs/sessions/session-a5-fk-audit-decisions.md`: *"audit found 0 FK references; no decisions needed; migration ran clean."* Keeps the audit trail intact without busywork in the common case.

5. **Migration**: only after decision log is finalized (zero-reference fast-path or signed-off case-by-case), run `--write`. Per-row tx ensures partial failures are recoverable.
6. Refused-if-populated guardrail: if `public.aircraft_owners` already has rows, exit cleanly.

**Success criteria**:

- `SELECT COUNT(*) FROM public.aircraft_owners` returns 3,848 (or 3,848 minus any rows deferred per FK decision log).
- `SELECT COUNT(*) FROM public.operators WHERE certificate_number = name AND operator_type IS DISTINCT FROM 'part_135'` returns 0 (the polluted-rows pattern is gone).
- `SELECT COUNT(*) FROM public.operators` returns approximately `(initial count) - 3,848 + (Step 3 new count)`. With initial ~3,898 + Step 3's ~1,789 = ~5,687 → after migration ~1,839.
- All FK references resolved per the decision log.

**Surface for review before Step 5**:

- Pre-migration counts.
- Audit findings (FK references count, decisions made).
- Post-migration counts.
- The full decision log file content.
- Decision to proceed.

---

### 4.5 Step 5 — Resolver gate-tightening

**Gate**:
- Step 4 approved.
- The 5 known false positives from Session A available as test fixtures (FJTA / Corporate Flight Management; GQ9C / GQ Aviation; TCHA / Executive Flight Management; 70TA / Triton Air; OW6A / Arrow West Aviation).

**Action**:

1. Update `src/entity-resolution/operator-resolver.ts` `decide()` function per `docs/phase1-followups.md` Step 2c.6 Item 2:
   - When `runner_up_score` is non-NULL: require `top_score - runner_up_score ≥ 0.15` for high-tier (0.95) acceptance. Below threshold → demote to medium-tier review.
   - Tokenize both names. Identify load-bearing-noun set: `{Aircraft, Flight, Air, Airways, Jet, Jets, Charter, Charters, Service, Services, Aviation, Airlines}`. If both names contain a load-bearing noun AND they're not the same noun, refuse the high-tier match (route to review).
   - Aviation overlaps with most other markers — apply the rule only when diverging tokens are mutually exclusive (e.g., `Aircraft` vs `Flight` is gated; `Aviation` vs `Aviation Services` is not).
2. Add unit tests under `tests/entity-resolution/operator-resolver.test.ts`:
   - **Test for FJTA**: candidate set with `Corporate Flight Management` (true) + `Corporate Aircraft Management` (lookalike). Expected: `decide()` returns `review`, not `match`.
   - **Test for GQ9C**: candidate set with `GQ Aviation` (true) + `ENG Aviation` (lookalike). Expected: `review`. Note: GQ9C will be defunct in the actual data, but the test exercises the gate logic.
   - **Test for TCHA**: candidate set with `Executive Flight Management` (true) + `Executive Jet Management` (lookalike — these are genuinely different operators per `docs/phase-2-eval-summary.md` case 4). Expected: `review`.
   - **Test for 70TA**: candidate set with `Triton Air LLC` (true) + `Triton Airways LLC` (lookalike). Expected: `review`.
   - **Test for OW6A**: candidate set with `Arrow West Aviation` (true) + `Arrow Aviation` (lookalike). Expected: `review`. (Substring difference, not noun-mismatch — exercises the gap gate, not the noun gate.)
3. Run `npm test` — all 5 new tests pass; existing 375+ tests still pass.

**Success criteria**:

- All 5 regression tests green.
- Existing test suite at 375+ tests stays green (no regressions).
- Code review confirms: gate logic mirrors the spec in `phase1-followups.md` exactly.

**Surface for review before Step 6**:

- Diff of `operator-resolver.ts` `decide()` function.
- Test output (5 new + existing).
- Decision to proceed.

Note: this step does NOT trigger a Step 2c re-run. The bootstrap in Step 3 used direct ingest, bypassing the resolver entirely. The resolver code change lands here so it's available for future ER work (e.g., when corroborating sources land and resolver matching becomes relevant again, including any AVinfo-side name-fuzzy joins).

---

### 4.6 Step 6 — Cert-bridge re-derivation

**Gate**:
- Step 5 approved.
- `canonical.operator_holds_certificate` populated with ≥1,791 rows from Step 3.
- `canonical.aircraft_on_certificate` refreshed in Step 3 Phase D.

**Action**:

1. Run existing `scripts/backfill-operator-aircraft-link-from-cert-bridge.ts` (Session A's script) in `--write` mode against the densified ohc population.
2. The script's logic is unchanged from Session A — JOIN aoc × ohc on cert_id, derive `valid_from = GREATEST(aoc.valid_from, ohc.valid_from)`, `valid_to = LEAST(aoc.valid_to, ohc.valid_to)` (NULL if both NULL), `confidence = LEAST(aoc.confidence, ohc.confidence)`, role='operator', source='faa_d085_via_cert_bridge'. Per-row tx with NOT EXISTS pre-filter and EXCLUDE-violation try/catch.
3. Source distinction: existing 2,052 rows from Session A's run (run id `track6_step2d_cert_bridge_20260505T020642Z`) stay. New rows get a different run id (`track1_session_a5_cert_bridge_<UTC-timestamp>`) so the audit log distinguishes the two passes.
4. **Coverage measurement** (SC-4):
   ```sql
   SELECT COUNT(DISTINCT oal.aircraft_id)
   FROM canonical.operator_aircraft_link oal
   WHERE oal.role = 'operator'
     AND oal.source = 'faa_d085_via_cert_bridge'
     AND EXISTS (
       SELECT 1 FROM adsb_completed_legs cl
       WHERE cl.icao_hex = (SELECT icao_hex FROM canonical.aircraft a WHERE a.aircraft_id = oal.aircraft_id)
         AND cl.completed_at::TIMESTAMPTZ >= '2026-03-01'
         AND cl.completed_at::TIMESTAMPTZ < '2026-04-01'
     );
   ```
   Per `docs/decisions/2026-04-24-adsb-text-timestamps.md`, the per-row TIMESTAMPTZ cast is the supported pattern until Phase 12 dbt.
   Expected ≥10,500 (SC-4 threshold).

**Success criteria**:

- Cert-bridge run reports cert_bridge_linked count substantially above Session A's 2,052.
- SC-4 SQL returns ≥10,500 unique aircraft.
- Confidence histogram still anchored at 0.85 (LEAST(aoc=0.85, ohc=0.95) = 0.85).
- No EXCLUDE constraint violations beyond expected `cert_bridge_skipped_overlap` and `cert_bridge_skipped_already_linked`.

**Surface for review before Step 7**:

- Cert-bridge run summary (linked / skipped breakdowns).
- SC-4 measurement result.
- Top operators by hours March 2026 (re-run Session A's top-10 query against the new link rows; expect Wheels Up / Flexjet / VistaJet / Executive Jet Management to appear directly now).
- Decision to proceed.

---

### 4.7 Step 7 — Audit + SC measurement

**Gate**:
- Step 6 approved.
- All Step B sub-steps must be at least at B.3 (first daily fetch) for SC-6 to be measurable. Step 7 measurement on SC-6 happens AFTER Step B.3 lands; if Step B is delayed, Step 7 measures SC-1 through SC-5 first and SC-6 is measured separately when B.3 completes.

**Action**:

1. Re-run an A.0.5-style normalization audit against `canonical.operator_holds_certificate WHERE confidence ≥ 0.85`. Same shape as Session A:
   - Aggressive normalization (UPPER, strip punctuation, strip corporate suffixes, collapse whitespace).
   - Group by normalized cert_designator + holder_name pair.
   - Flag pairs where canonical operator name and FAA holder name diverge non-trivially.
   - Manual review of all flagged cases. Verdict = false positive / true positive / ambiguous.
   - SC-5 expects 0 confirmed false positives (because direct-ingest doesn't have a fuzzy-match phase that could mis-resolve).
2. Measure SC-1 through SC-6 explicitly via the SQL queries documented in §1:
   - SC-1: `SELECT COUNT(*) FROM public.operators WHERE operator_type='part_135' AND last_seen_source LIKE 'faa_d085%'`
   - SC-2: `SELECT COUNT(DISTINCT cert_id) FROM canonical.operator_holds_certificate WHERE source='faa_d085' AND confidence >= 0.85`
   - SC-3: per-cert recovery query (FJTA, TCHA, 70TA, OW6A in active ohc; GQ9C in pending with `valid_to` set + resolved_at populated)
   - SC-4: cert-bridge coverage query from Step 6
   - SC-5: 0 confirmed false positives from audit
   - SC-6: `SELECT count(DISTINCT operator_id) FROM public.operator_aliases WHERE alias_type='dba' AND source='avinfo_gov' AND operator_id IN (top-50-by-fleet-March-2026 subquery)` returns ≥45
3. Document results in `docs/sessions/session-a5-results.md`:
   - All SC measurements (target / actual / pass-fail).
   - The audit's flagged-case list with verdicts.
   - Top-20 operators by March 2026 hours, before vs after rebuild.
   - Quarantined-row recovery table (5 rows, where each ended up).
   - Operational notes (what surprised, what didn't, what's deferred).
   - **Run-id convention**: this plan's writes use `track1_session_a5_<step>_<UTC-timestamp>`, distinguishable from Session A's `track6_step2d_*` rows. Future audits filter on the run-id prefix to scope analyses to one plan.

**Success criteria**:

- SC-1 through SC-6 all PASS per their thresholds.
- Results doc is committed.
- Plan is marked complete.

**Measurement-deferred state**: if Step 7 measures SC-1 through SC-5 as PASS but SC-6 is pending Step B.3 completion, the plan enters a "measurement-deferred" state. Code is shipped, canonical state is final, but the plan is **not "complete"** until SC-6 measures and the results doc is updated. The session log captures the gap — Phelipe re-runs Step 7's SC-6 query the day after B.3 lands and updates the results doc with the final measurement.

**Surface for review before plan close-out**:

- The full results doc.
- Any SC failures with explanation + remediation plan.
- Decision: plan complete, plan in measurement-deferred state, or remediation needed.

---

### 4.B Step B (parallel track) — AVinfo.gov DBA layer

Step B runs in parallel with Steps 1–6. The dependency from Step B back to the Part 135 track is at B.3, which writes to `public.operators` and `canonical.operator_avinfo_snapshot` — both of which require Step 3 to have populated `public.operators` first. B.0, B.1, and B.2 can run concurrently with anything from Step 1 onward (they don't write to canonical).

#### 4.B.0 Step B.0 — AVinfo recon

**Gate**: Step 0 approved (parser update done, tooling ready).

**Action**:

1. Read-only recon of AVinfo.gov's Air Operator Search interface.
2. Sample 5–10 operator searches (NetJets, Flexjet, a small Part 135 operator, a Part 91K operator if one is known, a defunct operator) — verify what fields the response carries.
3. Determine query mechanism: GET / POST / JS-rendered. Determine cacheability.
4. Document endpoint + field shape in `docs/sessions/session-a5-avinfo-recon.md`.
5. **Do NOT build the ingester yet.** Recon is read-only.

**Success criteria**:

- Recon doc committed.
- Endpoint shape documented.
- Field availability documented (which of DBA, HQ, phone, charter authority, officer names are present).
- Cadence semantics confirmed (daily updates, what does the page itself say).

**Surface for review before B.1**:

- Full recon doc.
- Decision to proceed to B.1 (design).

#### 4.B.1 Step B.1 — Design

**Gate**: B.0 approved.

**Action**:

1. Finalize §2.2 in this plan based on B.0 findings (replace "provisional" notes with concrete values).
2. Finalize §3.7's `canonical.operator_avinfo_snapshot` table schema based on actual AVinfo fields.
3. Update migration 006 SQL accordingly.
4. Document AVinfo ingester architecture in `docs/sessions/session-a5-avinfo-design.md`:
   - Polling cadence (daily M-F morning, by default).
   - Per-operator vs bulk fetch strategy.
   - Rate limiting + back-off.
   - Idempotency model.

**Success criteria**:

- Design doc committed.
- §2.2 and §3.7 of this plan updated (in-place edits).
- Migration 006 SQL finalized.

**Surface for review before B.2**:

- Design doc + this plan's updates.
- Decision to proceed to B.2 (implementation).

#### 4.B.2 Step B.2 — Implementation

**Gate**: B.1 approved + Step 3 approved (`public.operators` populated, AVinfo can join against it).

**Action**:

1. Land migration 006 (`canonical.operator_avinfo_snapshot`) per §3.8 + three-step verified.
2. Create `src/ingestion/avinfo-daily.ts`.
3. Implement per-operator fetch loop or bulk fetch (whichever B.1 decided).
4. Dual-write: DBAs to `public.operator_aliases` (alias_type='dba', source='avinfo_gov'); rich fields to `canonical.operator_avinfo_snapshot`.
5. Orphan handling per §3.7.
6. Schedule daily run.

**Success criteria**:

- Code in place.
- Schedule active.
- First end-to-end smoke test green (one operator fetched, parsed, written).

**Surface for review before B.3**:

- Code diff.
- Smoke test output.
- Decision to proceed to B.3 (first production run).

#### 4.B.3 Step B.3 — First daily fetch + canonical promotion

**Gate**: B.2 approved + Step 3 approved.

**Action**:

1. Run the AVinfo ingester against the full 1,789-operator pool. Expected duration depends on B.1's per-operator vs bulk decision.
2. Verify operator_aliases gains DBA rows; canonical.operator_avinfo_snapshot gains one row per operator per fetch_date.
3. Orphan log: capture cert designators that AVinfo knows about but `canonical.certificates` doesn't. Document in pipeline_runs payload.

**Success criteria**:

- ≥45 of top-50-by-fleet operators have a DBA in `public.operator_aliases` with `source='avinfo_gov'` (this is SC-6).
- `canonical.operator_avinfo_snapshot` has ≥1,700 rows for the first fetch_date (some operators may not return — provisional, finalize after B.0/B.1).
- Orphan log populated for any DSGN AVinfo returned that isn't in `canonical.certificates`.

**Surface for review (back to Step 7 SC-6 measurement)**:

- AVinfo fetch summary.
- DBA layer coverage by top-50.
- Orphan log size + sample contents.
- Decision: SC-6 measurement is now possible at Step 7 (or already passes).

---

## 5. Risk register

Twelve risks tracked. Each risk is described with likelihood × impact, a detection mechanism, a mitigation, and an owner. Owners default to Phelipe for go/no-go decisions; Claude implements the mitigation under direction.

### Summary table

| # | Risk | Likelihood | Impact | Detected at |
|---|---|---|---|---|
| R1 | FAA file format changes (parser breaks) | M | H | Step 1 weekly fetch |
| R2 | Drift thresholds tuned wrong | M | M | Step 1, weeks 2–6 |
| R3 | Multi-cert auto-merge produces wrong merges | L | H | Step 7 audit |
| R4 | Polluted-rows FK audit misses a reference | L | H | Step 4 migration commit |
| R5 | AVinfo endpoint changes during recon-to-impl gap | L–M | M | Step B.2 smoke test |
| R6 | Resolver gate-tightening regresses true positives | L–M | M | Step 5 regression run |
| R7 | Cert-bridge EXCLUDE violations exceed expected | L (see body) | L | Step 6 audit log |
| R8 | ADS-B feed restoration during rebuild | L | L | Continuous |
| R9 | Bronze schema introduction breaks downstream | L | L | Step 0 verification |
| R10 | Step 7 audit surfaces unexpected FP patterns | L | M | Step 7 |
| R11 | Calendar slip on any single step | M | L–M | Section 6 estimates |
| R12 | FAA AVinfo + Part 135 list merger ships during rebuild | L | H | Step 1 or B.0 |
| R13 | Bronze table volume growth (Year 5+) | L | L | Quarterly storage check |

---

### R1 — FAA file format changes during weekly ingest cycle

**Risk description**: The May 1 file uses short-code headers (`DSGN`, `CHDO`, `CFR`, etc.) — the parser was just updated for both old and new dialects. But future weekly publications could change header names again, add new columns, drop columns, or change the cert designator format. The FAA's stated "merging two resources together" project on the Part 135 page is a known structural-change vector.

**Likelihood**: Medium. The FAA already changed format once (during the 10-week deactivation). Another change during the rebuild's lifetime is plausible.

**Impact**: High. Parser break = bronze ingest stops = silver/canonical can't refresh = SC-1, SC-2, SC-4, SC-6 all drift away from passing.

**Detection mechanism**: §2.1 integrity check #2 (header match) bails on schema drift, surfaces via `pipeline_runs.status='ingest_quality_gate_failed'`. Within hours of the next Monday fetch.

**Mitigation**: Parser is already defensive (HEADER_SCAN_ROWS=30, multi-candidate column matching). Schema drift falls into manual-review mode; existing canonical stays at last-known-good snapshot. Update parser COLUMNS map to add new candidate names (same shape as Step 0). Re-run weekly ingest. If headers change in ways the multi-candidate map can't absorb (new columns, renamed required columns), Step 0's three-step verification cycle re-runs.

**Owner**: Phelipe decides on parser update; Claude implements.

---

### R2 — Drift thresholds tuned wrong

**Risk description**: §2.1 sets row count drift at ±10% and cert count drift at ±5% of the previous snapshot. These are baseline guesses without empirical data on the FAA file's natural week-over-week variance. Too tight = legitimate fleet expansions (e.g., a major operator growing 20% in a month) trigger false-positive bails. Too loose = real anomalies (FAA published a partial file, half the operators went missing) sneak through.

**Likelihood**: Medium. We don't have empirical data on natural weekly variance.

**Impact**: Medium. False-positive bail = pipeline_runs surfaces, manual override unblocks (acceptable cost, low frequency). False-negative miss = bad data lands in bronze; silver/canonical may inherit; SC measurements end up wrong (the worse mode).

**Detection mechanism**: pipeline_runs trends across the first 4–6 weeks. Compare actual variance against gate thresholds. If gate fires often on apparently-legitimate snapshots, threshold is too tight; if no gate fires across known-noisy weeks, threshold is too loose.

**Mitigation**: Tune thresholds based on observed week-over-week variance after 4–6 weeks of weekly ingests. Cert count (±5%) is the more meaningful gate — operator entity counts move slower than fleet rosters, so a 5% spike is genuinely surprising. Document the chosen final thresholds in `docs/data-sources.md`.

**Owner**: Phelipe decides on threshold updates after observation; Claude proposes thresholds based on observed data.

---

### R3 — Multi-cert single-parent dedup auto-merge produces wrong merges

**Risk description**: Auto-merge fires when `operator_name_normalized` is byte-identical across DSGNs. Two genuinely-different operators could share an identical normalized name (e.g., two unrelated "Aviation Services LLC" entities under different ownership in different states). Auto-merge would create one canonical operator pointing at two unrelated certs; downstream queries would aggregate fleet from both certs as one operator's fleet.

**Likelihood**: Low. The May 1 snapshot has 1,789 vs 1,791 = 2 multi-cert cases. Both are likely the same entity (the gap is small and consistent with sister-entity patterns). For genuinely-collision cases to exist, two unrelated operators each with the same legal name AND the same operating part would need to coexist in the Part 135 universe.

**Impact**: High if it happens. Wrong canonical merge = wrong fleet attribution = wrong analytics in every downstream query keyed on operator_id.

**Detection mechanism**: Step 7's A.0.5-equivalent normalization audit. Wrong merges show up as canonical entities holding two cert designators with non-overlapping geographic footprint (CHDO mismatch) or non-overlapping fleet patterns.

**Mitigation**: Tighten the auto-merge rule before Step 3 if R3 risk profile rises: require not just byte-identical normalized name, but also CHDO match AND operator_type match. Cases that fail strictness route to manual review, same as the current non-byte-identical path. The 1,789 vs 1,791 gap in the May 1 snapshot is small enough that even all-manual-review for those 2 cases is tractable — auto-merge is an optimization, not a requirement.

**Owner**: Phelipe decides merge/split per case; Claude surfaces evidence (CHDO, fleet size, fleet hex code overlap).

---

### R4 — Polluted-rows migration FK audit misses a reference

**Risk description**: Step 4's pre-flight audit scans known FK-targeting tables. If a table is missed (or new tables get added between plan-drafting and Step 4 execution), the migration could orphan FK references silently — referencing rows continue to point at IDs that no longer exist in `public.operators`.

**Likelihood**: Low. The list of FK targets is small and well-documented (codebase-map.md §3 enumerates them). New tables added by this plan itself (`aircraft_owners`, `operator_avinfo_snapshot`) are part of the audit by construction.

**Impact**: High. Data orphaning = JOINs returning NULL where they shouldn't = analytics break in subtle, late-detected ways. The worst kind of data bug.

**Detection mechanism**: Postgres enforces FK constraints. If the audit is incomplete and the migration drops rows that still have FK references, Postgres raises a constraint violation and the migration's per-row tx rolls back. Postgres is the safety net that catches incomplete audits.

**Mitigation**: Step 4's audit script does not hard-code FK target names. It queries `pg_constraint` to discover ALL foreign keys pointing at `public.operators`, then iterates each. The migration script's pre-flight runs before any write — audit failure (unrecognized FK target = bail). The migration is per-row tx, so an FK violation rolls back one row, leaving the rest valid.

**Owner**: Phelipe signs off on migration go-ahead; Claude implements the `pg_constraint` query.

---

### R5 — AVinfo.gov endpoint changes during recon-to-implementation gap

**Risk description**: B.0 recon establishes endpoint shape. Time gap between B.0 and B.2 implementation could span weeks. AVinfo.gov could change query interface, field names, response format, or the FAA's "merging" project could ship.

**Likelihood**: Low–medium. AVinfo.gov is a long-standing FAA tool; changes are likely small over weeks. But the FAA's stated merger project is a known change vector.

**Impact**: Medium. AVinfo is supplementary, not gating. SC-6 has the ≥45-of-50 floor that accommodates partial degradation. Complete endpoint change = ingester rewrite.

**Detection mechanism**: B.2's smoke test against the live endpoint. If live response differs from recon documentation, smoke test fails before any production fetch runs.

**Mitigation**: B.2 smoke test runs before any full-pool fetch. Discrepancies trigger a B.0-redo. Keep the gap short — B.0 and B.2 ideally within 2 weeks. If the merger ships, redesign as one merged ingester (R12 territory).

**Owner**: Phelipe decides re-recon trigger; Claude implements.

---

### R6 — Resolver gate-tightening produces regressions on real Step 2c matches we haven't tested

**Risk description**: Step 5 ships the resolver gate (`top - runner_up ≥ 0.15` AND load-bearing-noun) with regression tests on the 5 known false positives. Session A's audit identified 5 FPs out of 121 confidence=0.95 ohc rows — meaning 116 of those rows were true positives. The new gate could falsely demote some of the 116 true positives to review tier.

**Likelihood**: Low–medium. The gap gate is conservative (≥0.15). If true-positive matches had small gaps in the 0.91–0.94 band, the gate would now reject them.

**Impact**: Medium. Demotion to review tier increases manual review burden. Does NOT break canonical data (the existing 115 ohc rows from Session A stay; this gate applies to future resolver runs, not retroactively to existing canonical).

**Detection mechanism**: Run the new resolver against the existing 115 ohc rows' source D085 holder names (a regression sweep). Count how many now route to review.

**Mitigation**: Regression sweep before Step 5 ships. If >5 of the 116 true positives demote to review, adjust the gap threshold downward (e.g., 0.10 instead of 0.15). Document the chosen threshold and the regression-sweep result. Treat this as a calibration exercise, same shape as `phase1-followups.md` Item 2's calibrated 0.91 high-tier threshold.

**Owner**: Phelipe decides final threshold; Claude runs regression sweep.

---

### R7 — Cert-bridge re-derivation EXCLUDE constraint violations exceed expected

**Risk description**: Session A wrote 2,052 cert-bridge rows with run id `track6_step2d_cert_bridge_*`. Step 6 re-runs against the densified ohc population. New windows derive from `valid_from = GREATEST` / `valid_to = LEAST` logic; some new windows could overlap with Session A's existing rows, triggering EXCLUDE violations.

**Likelihood**: High in count (overlap is mathematically expected). Low in impact (script handles overlaps gracefully).

**Impact**: Low. Session A's logic skipped overlap via try/catch + `cert_bridge_skipped_overlap` audit row. Same logic in Step 6. Existing rows preserved. Risk surface is confusing logs at high volume.

**Detection mechanism**: Cert-bridge script's audit log captures every `skipped_overlap`. Easy to count and verify post-run.

**Mitigation**: Same as Session A — try/catch on EXCLUDE, log skipped_overlap, continue. Plan post-cert-bridge analysis at Step 6: count `skipped_overlap` rows, verify they're expected (e.g., aircraft × cert pairs that Session A already linked). Document the count in Step 6's surface-for-review output.

**Owner**: Phelipe reviews logs.

---

### R8 — ADS-B feed restoration during rebuild

**Risk description**: ADS-B live worker may resume during this rebuild (separate track, scheduling outside this plan). New positions feed `canonical.aircraft`. SC-4 measurement is against `adsb_completed_legs` for March 2026, a fixed historical period — new data shouldn't directly affect SC-4 measurement value. But if newer aircraft enter `canonical.aircraft` during the rebuild, cert-bridge results could change between Step 6 and Step 7.

**Likelihood**: Unknown. Depends on ADS-B track scheduling, outside this plan's control.

**Impact**: Low. SC-4's measurement period is fixed (March 2026, 52,693 hex codes). New aircraft post-rebuild are out of measurement scope. The plan's success doesn't depend on ADS-B currency.

**Detection mechanism**: Monitor `canonical.aircraft` row count over time; observe ADS-B feed status.

**Mitigation**: Run SC-4 measurement at the latest possible moment (Step 7) to maximize ADS-B coverage. If ADS-B is restored mid-plan, optionally re-run SC-4 to capture additional coverage — document both measurements as before/after.

**Owner**: Phelipe decides if re-measurement is worth it.

---

### R9 — Bronze schema introduction breaks downstream

**Risk description**: New `bronze` schema added. Phase 12 dbt is frozen, but other code might inspect `pg_namespace` or `information_schema.schemata` and not expect `bronze`. Or migrate-pg.ts's schema-detection regex could mis-fire.

**Likelihood**: Low. The schema is purely additive. No existing code references `bronze`. migrate-pg.ts's regex captures `[schema.]table` patterns dynamically, which works for any schema name.

**Impact**: Low. Even if downstream breaks, rollback is straightforward (drop schema after dropping tables — schema/rollback/2026-05-05-001-* covers this).

**Detection mechanism**: Step 0's three-step verification (Docker rollback test → migrate-pg → psql verify). If migrate-pg fails, immediate signal. The pre-existing 375-test test suite catches regressions in non-bronze code paths.

**Mitigation**: Step 0's verification gates the entire rebuild. Failure = stop, fix, retry. No downstream code change required for `bronze`.

**Owner**: Phelipe.

---

### R10 — Step 7 audit surfaces unexpected FP patterns

**Risk description**: A.0.5-equivalent audit could surface new FP patterns we haven't seen. Direct-ingest reduces FP risk vs fuzzy match, but doesn't drive it to zero. Silver normalization could over-merge ("Acme LLC" and "Acme Inc" both losing punctuation/suffix and colliding to `ACME`), or AVinfo cross-source disagreement could surface mid-rebuild.

**Likelihood**: Low. Direct-ingest from the FAA file gives high name fidelity — the resolver isn't involved at all in canonical bootstrap.

**Impact**: Medium. Quarantine path exists (`operator_holds_certificate_pending` + `audit_run_id`), same shape as Session A's A.0.6 sweep. Worst case: 5–10 rows quarantined, FK pre-flight repeated, plan extended by one cycle.

**Detection mechanism**: Step 7's A.0.5 audit, same shape as Session A.

**Mitigation**: Reuse the audit-then-quarantine workflow from Session A — A.0.5 audit produces a candidate set, manual review produces the verdict, quarantine script with hardcoded ohc_ids per audit findings runs per-row tx. The specific quarantine script depends on the FP pattern type surfaced: lookalike misresolution = Session A's existing `scripts/quarantine-step2c-lookalike-falseps.ts`; over-merging from normalization = new script for that pattern; AVinfo cross-source disagreement = different new script for that pattern. Resolution via Session B post-rebuild.

**Owner**: Phelipe reviews audit findings.

---

### R11 — Calendar slip on any single step

**Risk description**: Each step has an estimated time (Section 6). Slip risk is real for any solo part-time engineering effort against a non-trivial scope.

**Likelihood**: Medium (it always happens to some step).

**Impact**: Low–medium. The plan is sequential; slip extends total calendar time but doesn't cascade in the multiplicative sense — Step 4 doesn't take longer because Step 3 ran late. Session B is held until plan completion regardless of when that lands.

**Detection mechanism**: Section 6's per-step time estimates with explicit "yellow flag at 2x estimate" check. Each step's stop gate is a natural pause where slip becomes visible.

**Mitigation**: Identify root cause of slip (technical complexity? blocked on external dependency? interruption?). Re-estimate remaining steps. If multiple steps slip, consider parking the plan and revisiting in a fewer-distractions session window — sunk-cost fallacy is the failure mode to avoid.

**Owner**: Phelipe.

---

### R12 — FAA AVinfo + Part 135 list merger ships during rebuild

**Risk description**: FAA stated on the Part 135 page: *"We're currently working on merging these two resources together."* A merger could ship during this rebuild's execution, changing both endpoints simultaneously — Part 135 file shape AND AVinfo.gov interface.

**Likelihood**: Low. FAA timelines for cross-system mergers are typically slow. "Currently working on" doesn't mean "next month."

**Impact**: High if it ships during execution. Both Step 1's Part 135 ingester and Step B.2's AVinfo ingester potentially break.

**Detection mechanism**: Weekly Part 135 fetch shows schema change; AVinfo recon (B.0) returns differently than expected.

**Mitigation**: Pause both ingesters; redo recon; redesign as one merged ingester if appropriate. The single-source merger would actually simplify SC-6's verification path (one source, one schema).

**Owner**: Phelipe.

---

### R13 — Bronze table volume growth at 5+ years

**Risk description**: Bronze growth is mechanical: 11,465 rows × 52 weeks/year = ~600K rows/year for the Part 135 file alone. Compounding ~10%/year for natural fleet growth + Part 91K and Part 121 ingesters of similar volume when those tracks land = ~15M bronze rows by Year 5. Supabase Pro's 500 MB storage limit becomes a real constraint at that scale; ~$50/mo additional storage cost on the higher tier.

**Likelihood**: Low (slow growth, predictable trajectory).

**Impact**: Low (manageable cost; S3 archive remains the source of truth, bronze in Postgres is a fast-query layer for recent snapshots).

**Detection mechanism**: Quarterly storage check via Supabase dashboard. Trend line is linear, easy to extrapolate.

**Mitigation**: Implement a periodic bronze archival policy when storage approaches limits — not preemptively. After 26 weeks (6 months), move bronze rows older than the threshold to S3 cold storage (xlsx files are already in S3 at Step 1; bronze rows are derivable from them) and DELETE from Postgres. The xlsx files are the source of truth; bronze in Postgres exists for fast querying of recent snapshots, not permanent storage. Implement archival as a dated migration when storage approaches limits.

**Owner**: Phelipe.

---

### Risks NOT in scope (explicitly)

To bound the register:

- **Supabase outage**: handled by Supabase SLO; not a project-level risk.
- **AWS S3 outage**: 11-9s durability, low project-level risk; covered in §2.3 fallback.
- **Local dev environment instability**: out of scope.
- **Phelipe unavailable for review for >1 week**: organizational, not technical. Plan's stop gates accommodate any pace.
- **Session B's LLM ER pass results**: out of scope; this plan precedes Session B.
- **Phase 12 dbt timeline shifts**: orthogonal.

---

## 6. Estimated timing

Estimates are **ranges, not commitments**. The goal is to give a realistic expectation window — when the rebuild is likely to land if work proceeds at Phelipe's sustainable part-time pace, with stop-the-bleeding flags if a step exceeds 2× its high estimate.

The pace constraint is real and shapes the whole schedule. Phelipe flies a SkyWest First Officer line — schedule varies week to week (longer trips with off-days clustered, shorter trips with reserve days, recurrent training cycles, holiday surges). Sustainable focused engineering time is **4–8 hours per week** averaged over a month, with high-variance weeks: surge weeks (training off, week off) can deliver 12–16 hours; constraint weeks (heavy line, reserve) drop closer to 2 hours.

### 6.1 Per-step estimates

All times are focused engineering hours (heads-down, not calendar). Ranges reflect normal variation within the step's scope; risks from §5 firing extend beyond the high end (covered in §6.4).

| Step | Description | Estimate (hrs) | Yellow flag at |
|---|---|---:|---:|
| 0 | Parser update + migration 001 + verification | 3–5 | 10 |
| 1 | Bronze ingester implementation + first prod run | 8–12 | 24 |
| 2 | Silver promotion script + migration 002 + first prod run | 5–7 | 14 |
| 3 | Canonical bootstrap (4 phases) + migrations 003, 005 + dialect-detection one-shot | 14–22 | 44 |
| 4 | Polluted-rows migration + FK pre-flight + migration 004 | 4–15 | 30 |
| 5 | Resolver gate + 5 regression tests + R6 sweep against 116 TPs | 6–9 | 18 |
| 6 | Cert-bridge re-derivation + SC-4 measurement | 3–4 | 8 |
| 7 | A.0.5-equivalent audit + SC measurement + results doc | 10–18 | 36 |
| **CP total** | **Critical path (Steps 0–7)** | **53–94** | — |
|  |  |  |  |
| B.0 | AVinfo recon + recon doc | 3–5 | 10 |
| B.1 | Design + in-place §2.2/§3.7 updates + design doc | 2–4 | 8 |
| B.2 | Migration 006 + ingester implementation + smoke test | 8–15 | 30 |
| B.3 | First daily fetch + canonical promotion verification | 2–3 | 6 |
| **B total** | **AVinfo parallel track (B.0–B.3)** | **15–27** | — |

Step-specific notes on the variance:

- **Step 1** has the widest single-step variance because the bronze ingester is novel code: HTTP HEAD/conditional-GET, 7 integrity checks, S3 manifest write, batch INSERT, refused-if-populated guardrail, cron entry. Most of the rebuild's "new code" volume lands here. If integrity-check tuning needs more iteration than expected, this step extends fastest.
- **Step 3** is the longest single step. Four phases (certificates, operators with multi-cert dedup surfacing, ohc, aircraft_on_certificate refresh), each with its own SQL + tx + audit logging. The header dialect detection one-shot adds another sub-step. Realistic median: 14–16 hours.
- **Step 4** has the largest range floor-to-ceiling (4 vs 15 hours) because it's pivot-on-FK-audit-findings. Zero references = fast-path = ~4 hours total. 5–10 references = decision log + per-case manual triage + migration = 12–15 hours.
- **Step 6** is the shortest step. The cert-bridge script exists from Session A and runs unchanged; the work is "run, measure SC-4, sanity-check top-operators-by-hours."
- **Step B.2** is wide because it depends entirely on what B.0 recon found. GET-with-query-string AVinfo = 8–10 hours. JS-rendered AVinfo requiring Firecrawl = 12–15 hours.
- **Manual-review time in Steps 3 and 7 is the primary driver of the wider ranges.** Multi-cert review (Step 3 Phase B.1) and A.0.5-equivalent audit (Step 7) both require subject-matter judgment per flagged case — Phelipe deciding "are these two operators with similar names actually the same entity?" or "is this match a true positive or a normalization artifact?" Neither is mechanical. The high end of each range assumes more flagged cases than the recon's 1,789 vs 1,791 gap suggests; if cases stay close to the floor (2–3 multi-cert candidates, 0–5 audit flags), the median lands closer to the low end.

### 6.2 Total range

- **Critical path (Steps 0–7)**: 53–94 focused engineering hours.
- **Step B (parallel, doesn't extend critical path if interleaved)**: 15–27 hours.
- **Combined effort if both tracks run**: 68–121 hours, with at most 94 hours on the critical path.

### 6.3 Calendar time

At sustainable pace (4–8 hrs/week averaged over a month), the critical path lands in:

- **53 hours / 8 hrs/week = ~7 weeks** (best case: low-variance estimates, Phelipe has surge weeks aligned with the bigger steps)
- **94 hours / 4 hrs/week = ~24 weeks** (worst case: high-variance estimates, Phelipe constrained pace throughout)
- **Realistic median: 11–15 weeks** (mid-range estimates, mid-range pace, occasional surge week)

Step B running in parallel: at the same pace, B.0 → B.3 takes 2–7 calendar weeks. Two realistic paths:

- **Interleaved**: Phelipe alternates between CP and B work within a week. Context-switching cost is real but manageable for short focused sessions. Total calendar time stays within the 7–24 week band.
- **Sequential**: Phelipe finishes CP first (Steps 0–7), then runs B as a separate workstream. Adds 2–7 calendar weeks to total close-out. SC-6 measurement is deferred until B.3 lands; the plan enters the "measurement-deferred" state from §4.7 in the meantime.

Either is acceptable. Sequential is the simpler default; interleaved is faster if working rhythm supports it.

This is **not a commitment to a specific delivery date**. It's a band: the rebuild lands somewhere between 7 weeks (aggressive, optimistic) and 24 weeks (defensive, pessimistic), most likely in the middle.

### 6.4 Worst-case paths if §5 risks fire

The plan is sequential, so a single risk firing extends the affected step rather than cascading. Multi-step impact happens only when a risk fires across multiple steps (e.g., R12 — FAA merger — would hit both Step 1 and Step B.2).

| Risk | Steps affected | Slip | Detection-to-resolution path |
|---|---|---:|---|
| R1 — FAA file format change | Step 1 (re-run weekly fetch) | +3–5 hrs | Parser COLUMNS update cycle, Step 0-shape |
| R2 — Drift thresholds tuned wrong | Step 1 (manual override + threshold tune) | +2–4 hrs/incident | Observe, adjust, re-run |
| R3 — Wrong multi-cert merge | Step 7 → mini Step 3 → Step 6 → Step 7 re-measure | +8–12 hrs (floor) | Quarantine + re-promote affected operators |
| R4 — FK audit miss | Step 4 (Postgres rolls back; debug) | +4–6 hrs | Add missed FK target, re-audit |
| R5 — AVinfo endpoint change | Step B.2 (re-recon) | +5–8 hrs | B.0 redo, B.1 update, B.2 re-impl |
| R6 — Resolver gate regresses TPs | Step 5 (calibrate threshold) | +3–5 hrs | Sweep + threshold tune |
| R7 — Cert-bridge EXCLUDE volume | Step 6 (analysis) | +1–2 hrs | Audit log review |
| R8 — ADS-B restoration | Step 7 (re-measure) | +1 hr | Optional re-measurement |
| R9 — Bronze breaks downstream | Step 0 (rare) | +2–4 hrs | Identify + fix |
| R10 — New FP patterns | Step 7 → quarantine cycle | +5–10 hrs | Custom quarantine script + re-cycle |
| R11 — Calendar slip itself | Any | extends step's range | Re-plan |
| R12 — FAA merger ships | Step 1 + Step B.2 | +10–20 hrs | Pause, redo recon, redesign |
| R13 — Bronze volume growth | Year 5+ (out of plan window) | n/a | Out of this plan's calendar |

**R3 multi-step impact (clarification)**: detection happens at Step 7 (audit surfaces the wrong merge). Resolution path: quarantine + re-promote affected operators (a mini Step 3, scoped to those operators only) → Step 6 cert-bridge re-derives for those operators → Step 7 re-measurement. The +8–12 hr slip in the table is the **floor case** (1 wrong merge, 1 cycle). It could extend to **+16–20 hours if multiple operators are affected** and require multiple re-cycles. The cycling is bounded by Step 6's automatic re-derive — you don't redo every step from scratch.

**Most likely worst case**: one risk fires (typically R3 or R5), adding ~8–12 hours = +1–3 calendar weeks. Plan still lands within the high end of the 7–24 week range.

**Catastrophic worst case**: R12 (FAA merger) ships during execution + one other risk. ~25–35 hours of additional work + redesign. Plan extends 4–8 calendar weeks beyond the worst-case estimate. This is the trigger for parking the plan and re-scoping rather than pushing through.

### 6.5 Yellow flag thresholds

Each step has a yellow flag at **2× the high estimate** (column in §6.1). When focused-hours-on-step exceeds the yellow flag without the step landing:

1. **Stop**. Do not push through.
2. **Diagnose**. What's making the step take longer than expected? Technical complexity not anticipated in §3? Blocked on external dependency (S3, Supabase, AVinfo)? Interruptions? Sunk-cost behavior?
3. **Re-estimate**. Update the per-step range based on what's been learned. If the new estimate breaks the total-range floor, surface it and decide whether to continue, park, or re-scope.
4. **Document**. Append a "yellow flag fired at Step X" section to `docs/sessions/session-a5-results.md`. The pattern of which steps yellow-flag is data for future plans.

Most yellow flags will fire on Step 1 (novel code volume), Step 3 (multi-phase logic), or Step 7 (manual-review-bound). Step 6 yellow-flagging would be unusual — if cert-bridge takes >8 hours, something is wrong upstream.

The yellow flag is not a kill-switch. It's a forced pause-and-think point. Most yellow flags resolve with "continue, +X hours," not with "abandon the step."

### 6.6 Pace assumptions explicitly listed

To make the calendar math reproducible:

- 1 focused engineering hour = uninterrupted time at the keyboard with the codebase open and clear next steps. Not 1 clock hour; clock-hours-with-context-switching translate to ~30–45 min of focused engineering.
- Sustainable pace = what Phelipe can hold across a month without burnout, on top of SkyWest line + OSA brand work + life.
- Surge weeks happen 1–2× per month and deliver 12–16 hours of focused engineering.
- Constraint weeks happen 1–2× per month and deliver 0–4 hours.
- The critical-path work IS interruptible at any step's stop gate. Plan resumption from any gate is a documented entry-point — see §8 (Pre-flight checklist).

If Phelipe's actual pace turns out higher than 8 hrs/week sustained, the plan lands faster. Lower than 4, slower. The 7–24 week band absorbs reasonable pace variation without re-planning.

**Pace-estimate caveat**: the 4–8 hrs/week sustainable pace is an estimate, not yet validated against this repo's session-doc history. The first 2–3 weeks of execution will calibrate it. If actual pace is meaningfully different (consistently below 4 or above 8), §6.3's calendar band needs to shift accordingly. Document the calibration finding in `docs/sessions/session-a5-results.md` after the first 3 weeks — even if it confirms the estimate, the empirical anchor is useful for future plans.

---

## 7. What this unlocks

This section is **structural, not prescriptive**. It describes what becomes feasible once the rebuild lands. It does not commit OSA to pursuing any specific unlock. Phelipe decides priorities at the time the rebuild lands, based on the business state of OSA Connect, Loud Hawk, and the aircraft / capital tracks.

The unlocks fall into five clusters:
- **A. Immediate post-rebuild ER unlocks** — the work this plan was designed to enable.
- **B. Six-entity track unlocks** — the next-entity tracks that the six-entity discipline holds back.
- **C. Aircraft and type intelligence** — orthogonal to operators but benefits from cleaner attribution.
- **D. Product / analytics unlocks** — Loud Hawk, Dumont, OSA Aircraft consumers of canonical state.
- **E. Documentation / methodology** — the methodology artifact the rebuild's discipline produces as a side effect.

Each unlock has: **what** becomes feasible, **how** the rebuild enables it, **when** it can be started, **effort** to execute (order of magnitude only).

---

### A. Immediate post-rebuild ER unlocks

#### A.1 Step 2c re-run with denser pool

- **What unlocks**: Re-running the existing Step 2c backfill (`scripts/backfill-canonical-operator-holds-certificate-from-d085.ts`) against the densified `public.operators` pool. Many of the 351 cases queued in `public.operator_llm_er_checkpoint` resolve directly because the right canonical entity now exists.
- **How**: Step 3 populates `public.operators` with ~1,789 verified Part 135 operators. Step 5 ships the resolver gate-tightening (`top - runner_up ≥ 0.15` + load-bearing-noun gate). Together, Step 2c can re-run safely against historical D085 archives. The previously-no_match rows promote to matched at high tier without invoking LLM ER.
- **When**: Immediately post-Step 5. Sequence: rebuild lands → Step 2c re-run → Session B against the residual.
- **Effort**: ~2–4 hours focused engineering. The script exists; the work is running it against the new canonical state, validating output, and demoting any new edge cases that surface.

#### A.2 Session B with smaller queue against denser pool

- **What unlocks**: The 351-case Phase 2 LLM ER pass was queued against the pre-restoration pool. Post-rebuild + post-Step-2c-re-run, many cases auto-resolve (right canonical now exists). Session B runs against the residual cases that genuinely need LLM-mediated reasoning — the cases where holder name maps to a real entity that the deterministic resolver still can't pin (rebrands, sister-entity disambiguation, cross-jurisdictional cases).
- **How**: Pool sparsity was the root cause behind 78% pending rate at high tier. Densifying the pool collapses the sparsity-driven pending population.
- **When**: After Step 2c re-run lands. Estimated 1–2 calendar weeks post plan completion.
- **Effort**: Session B itself is ~10–14 hours supervised time. Cost estimate against the residual: ~$5–8 of Sonnet (down from ~$14 against the full 351 — pool-sparsity reduction shrinks the queue by an estimated 40–70%, leaving ~100–200 LLM-resolvable cases).

#### A.3 Cert-bridge expansion path

- **What unlocks**: Cert-bridge wrote 2,052 rows in Session A. With the densified ohc population and Two-Source corroboration as it lands (DOT Part 295, SEC EDGAR), cert-bridge expands at higher confidence (`confidence=1.00` corroborated rows) and broader aircraft coverage.
- **How**: Step 6 re-derives cert-bridge against the new ohc population. Each future corroborator triggers a re-derive that appends to existing rows' `corroborated_by` JSONB rather than creating duplicates.
- **When**: Step 6 is in this plan (immediate). Corroborator integration is a separate workstream per source.
- **Effort**: Step 6 is the rebuild's own work (3–4 hours). Each corroborator track (DOT 295, SEC EDGAR, state SOS) is ~1 quarter of focused engineering — ingestion + parser + corroboration logic + canonical writes.

#### A.4 Operator events / lifecycle table population

- **What unlocks**: `canonical.operator_events` and `canonical.certificate_events` are scaffolded but empty (`docs/codebase-map.md` §3.1). With weekly Part 135 ingest providing snapshot-to-snapshot diffs, lifecycle events become detectable as side effects of normal ingest — not as a separate research workstream.
- **How**: §1's "Why now" reasoning anchors this. Weekly cadence + snapshot diffing detects (a) cert appeared in week N+1 but not week N (`event_type='issued'`), (b) cert in week N but not N+1 (`'surrendered'` or `'revoked'`), (c) operator name on cert changed week-over-week (`'rebranded'` or `'consolidated'`). Each diff emits an event row.
- **When**: Begins immediately post-Step 1. First diff possible Week 2 of weekly ingest. Population builds over time; meaningful coverage takes ~3 months (12 snapshots).
- **Effort**: Diff-and-emit-events script: ~1–2 weeks focused engineering. Not in this plan; downstream of it.
- **Two-Source Rule applicability** (event-category distinction): authoritative single-source events (cert issued, cert surrendered) land directly because the FAA is the authoritative publisher of cert state — no Two-Source Rule gating needed for existence claims. Identity-interpretation events (cert holder name changed week-over-week — could be rebrand, cert transfer, or clerical correction) trigger Two-Source Rule gating: the event lands as `pending_corroboration` until a non-FAA source agrees on the interpretation. SEC EDGAR 8-K filings, state SOS records, and trade press are the typical corroborators.

---

### B. Six-entity track unlocks

The six-entity discipline (`docs/invariants-2026-05-04.md` §4, `CLAUDE.md` §3) holds entity tracks back until prior entities are dense. The rebuild satisfies the operator-density precondition.

#### B.1 FBO ER (Track 3)

- **What unlocks**: Fixed-Base Operator entity resolution. Per-airport FBO presence, parent-rollup chains (Signature, Atlantic, Million Air consolidations), service offerings.
- **How**: Operator + aircraft + cert are dense post-rebuild. FBO ER's downstream consumers (Dumont's ground-handling logic, Loud Hawk's market commentary on FBO consolidation) need real operator entities to associate with FBO services.
- **When**: Immediately post-rebuild. Aircraft side is also dense (Stage 2a/b/c shipped 2026-04-24). FBO is the natural next track.
- **Effort**: ~1 quarter focused engineering. Schema design + ingestion (NBAA / NATA directories, AC-U-KWIK / AirNav, state SOS, Open Ownership for parent-rollup) + ER + canonical promotion. Comparable to operator entity work but smaller scope (~5K FBOs vs ~1,800 operators).

#### B.2 Airport ER (Track 4)

- **What unlocks**: Airport entity resolution. ICAO / IATA / FAA codes consolidation, runway data, geographic centroid, regional categorization.
- **How**: No operator dependency — Airport ER doesn't need this rebuild to ship. Was deferred under "lightest load — deferred until needed" (`docs/er-architecture-plan.md`).
- **When**: Available immediately. Independent of this rebuild.
- **Effort**: ~1–2 weeks. Sources are well-known and stable: FAA 5010, OurAirports.com CSV. Data volume is small (~20K US airports, ~50K global). The schema work is the bulk of effort.

#### B.3 Person ER (Track 5)

- **What unlocks**: Pilot, owner, executive, broker entity resolution. FAA airmen registry already ingested; resolution against operator (chief pilot, DO) + aircraft (PIC at leg time) + FBO (line crew) + cert (responsible party).
- **How**: Person ER's value compounds with operator + FBO density. People link to multiple other entities; sparse target tables produce sparse Person resolution. The rebuild plus FBO ER are both prerequisites for high-yield Person work.
- **When**: After FBO and Airport tracks land (sequencing benefits from cleaner geography + employer canonicalization).
- **Effort**: ~1–2 quarters. Larger entity (~1M+ US airmen with active certificates), harder ER (role disambiguation: CFI, ATP, mechanic), and the LinkedIn exclusion (`docs/data-sources.md` §"Excluded sources") forces public-records-only resolution. SEC filings, FAA airmen, state SOS officer lists, NTSB narratives, press release quotes are the sources.

#### B.4 MRO ER (would-be 7th entity)

- **What unlocks**: Maintenance, Repair, and Overhaul shop entities. Service-center networks (Gulfstream Service Centers, Textron Service Centers, independent shops). Useful for fleet attribution to home-base maintenance, regulatory compliance, parts-tracking.
- **How**: MRO is **not** in the six-entity model (`docs/invariants-2026-05-04.md` §4). Adding it would require re-litigating the discipline rule. The discipline exists for a reason — opening a 7th entity before the six are dense produces a half-built ontology.
- **When**: After all six entities have resolution pipelines (operator, cert, aircraft, FBO, airport, person). Not before. Likely 12+ months out from plan landing.
- **Effort**: ~1 quarter once unblocked. Sources: FAA Repair Station list (Tier 1), manufacturer service-center directories (Tier 3), trade press for consolidation events. Smaller scope than FBO (~3K FAA-certified repair stations).

---

### C. Aircraft and type intelligence

#### C.1 Aircraft type intelligence layer (TCDS, manufacturer brochures)

- **What unlocks**: Type Certificate Data Sheets (FAA-published authoritative aircraft-type data), manufacturer brochures, performance datasets attached to aircraft *type* (model, MTOW, range, fuel burn, cabin configuration). Distinct from `canonical.aircraft` which is per-airframe.
- **How**: The aircraft entity is already dense (Stage 2a/b/c). Type intelligence is orthogonal — attaches data to types, not to airframes. The rebuild benefits this indirectly: cleaner operator attribution makes type-by-operator analytics tractable (e.g., "what types does NetJets actually fly vs publish?").
- **When**: Available immediately. Independent of this rebuild but benefits from cleaner operator attribution downstream.
- **Effort**: ~1 quarter. TCDS ingest is non-trivial (FAA publishes as PDFs; ~3K type certificates), manufacturer brochures are heterogeneous (PDFs, web pages, vendor PDFs). Charter Index and Dumont's pricing engine are downstream consumers.

---

### D. Product / analytics unlocks

#### D.1 Charter Index per-route data (Loud Hawk content)

- **What unlocks**: Per-route market data — typical operators on the route, average time aloft, repositioning ratios, fleet sizes at endpoints. Editorial content product for Loud Hawk.
- **How**: Cert-bridge expansion (Unlock A.3) gives operator attribution per ADS-B leg. Per-route aggregation joins `adsb_completed_legs × operator_aircraft_link × airport`.
- **When**: After cert-bridge has ≥20% coverage on March 2026 active aircraft (SC-4 threshold). Available immediately post-Step 6.
- **Effort**: ~1–2 weeks for the aggregation + data product. Editorial / Loud Hawk publishing workflow is brand-side, separate scope.

#### D.2 Ghost Positioning live signal

- **What unlocks**: Real-time detection of repositioning flights (empty legs). Relies on operator attribution at leg level + pattern detection over short time windows.
- **How**: Same operator-attribution dependency as Charter Index. Pattern detection identifies repositioning via (operator's last paid leg endpoint) → (next leg origin) mismatch.
- **When**: Post-cert-bridge expansion + ADS-B live worker restoration (the live worker is on the deferred list, separate from this plan).
- **Effort**: ~1 month for the detection logic, ~1–2 weeks for productization. Loud Hawk and OSA Connect both consume this signal.

#### D.3 Dumont pricing engine substrate

- **What unlocks**: Defensible operator-identity layer for Dumont's pricing logic. Removes "wrong operator → wrong fleet → wrong pricing" failure mode that the polluted pool created.
- **How**: Pre-rebuild, a quote could resolve to the wrong operator entity (the ~50 real Part 135 plus 3,848 polluted = ambiguous matches). Post-rebuild, pricing reads against verified operator entities with temporal validity windows — pricing reflects actual fleet at quote time.
- **When**: Available immediately post-rebuild for the data side. Pricing logic itself lives in `dumont-agent`, separate repo, separate scope.
- **Effort**: Pricing engine work is `dumont-agent` scope (out of this plan). The rebuild only removes the data substrate's failure modes — the work that was previously "guess the right operator" becomes "look up the operator." Pre-rebuild, every Dumont pricing iteration would have to manually filter polluted operators from the substrate. Post-rebuild, that filter is structurally enforced upstream — pricing engine work in `dumont-agent` stops being blocked on data-quality remediation.

#### D.4 OSA Aircraft transactions (comparable sales)

- **What unlocks**: Aircraft transactions canonical layer for OSA Aircraft brand. Comparable sales analytics: "this 2018 Gulfstream G280 sold for $X to operator Y in 2024, here are the priced-equivalent options."
- **How**: Aircraft entity (dense) + operator entity (densified by this rebuild) + transaction events (new entity, future track) = comparable-sales database.
- **When**: Aircraft + operator are ready. Transactions ingestion is a separate later track. Sources: Corporate Jet Investor, AINOnline, vendor announcements, FAA registry diff (ownership change events).
- **Effort**: ~1 quarter for transactions ingestion + canonical promotion. Editorial / OSA Aircraft publishing is brand-side.

#### D.5 Loud Hawk content workflow (per-operator profiles, market analyses)

- **What unlocks**: Per-operator editorial profiles drawing on canonical operator + cert + aircraft + DBA data. Market analyses of operator concentrations, brand-vs-cert relationships, consolidation trends. Newsletter content backed by verifiable data.
- **How**: Real operator entities (with AVinfo DBA, FAA-verified holder names, cert designators) replace the polluted/synthesizer layer that previously couldn't support published content without manual cleanup. The Two-Source Rule means published claims have provenance trails.
- **When**: Available immediately post-rebuild + Step B.3. DBA layer is the unlock for "VistaJet — DBA of Vista America LLC" framing without manual research per article.
- **Effort**: Loud Hawk editorial workflow is brand-side; the data substrate is ready post-rebuild. Per-article data-pull effort drops from "~2 hours of research" to "~10 minutes of canonical query."

---

### E. Documentation / methodology

#### E.1 Academic-grade methodology document

- **What unlocks**: A methodology document describing OSA's ER architecture — six-entity discipline, temporal link pattern, Two-Source Rule, audit-then-quarantine workflow, three-step migration verification, gate-driven execution. Publishable as a preprint, an industry trade-journal article, or an internal-but-shareable artifact for partners.
- **How**: The rebuild's audit-then-quarantine cycle, the gate-driven execution model, and the §1–§9 structure of this plan accumulate into a documented methodology. Most of it already exists in `docs/`; the document is a synthesis, not new research.
- **When**: After plan completion. Methodology doc is downstream of execution + reflection. The Step 7 results doc is the seed.
- **Effort**: ~1–2 weeks of writing + review. Two natural audiences: (a) aviation-industry trade publications (NBAA, AIN), where the methodology demonstrates technical seriousness; (b) academic ER community (where the audit-then-quarantine + temporal-link pattern + Two-Source Rule combination is publishable).

---

### What this rebuild does NOT unlock

To bound expectations, the rebuild does not enable:

- **Beneficial ownership disclosure**: FinCEN Corporate Transparency Act data is paid/restricted. Out of scope until access strategy decided.
- **Operator financial state**: profitability, debt, EBITDA. JETNET territory; no public-source equivalent.
- **Customer / passenger data**: who flies which charters. Not publicly available; never will be.
- **Pilot rosters by operator**: FAA airmen registry does not link airmen to employers. Inferred via NTSB narratives + manual research, both partial.

These remain "known unknowns" — useful to track explicitly so a future session doesn't assume the rebuild made them tractable.

---

### Notes on prioritization

The 15 unlocks above are unranked by intent. Phelipe decides ordering at plan-landing time based on:

- **Business-side priorities**: which unlock supports OSA Connect / Loud Hawk / OSA Aircraft / OSA Capital revenue or attention generation?
- **Technical sequencing**: Step 2c re-run + Session B (A.1, A.2) are zero-additional-recon work and probably first. FBO ER (B.1) is the most value-per-quarter for the data platform but requires its own sprint sequence.
- **External constraints**: SkyWest schedule, OSA brand work cycles, Loud Hawk publication cadence.
- **Risk profile**: cert-bridge expansion (A.3) and operator events (A.4) are continuous-trickle work that benefits from being on automatic. FBO / Airport / Person tracks are sprint-shaped.

A reasonable default sequence after rebuild: A.1 → A.2 → A.4 (concurrent with B.2 Airport, since Airport has no operator dependency) → B.1 FBO → re-evaluate.

---

## 8. Pre-flight checklist

State that must be true before Step 0 starts. Eight categories. Each item is a concrete check, a verification mechanism, a remediation if the check fails, and a status field updated at execution time.

The checklist is not just defensive bureaucracy — it's the inspection point where assumptions about the starting state get tested against reality. Plans fail when execution starts on a wrong premise (stale main, drifted canonical, missing migration). The checklist surfaces those before any code change.

### 8.1 Repo state

| ID | Check | Verification | If fails | Status |
|---|---|---|---|---|
| 8.1.1 | Working tree clean (no uncommitted changes from planning) | `git status` returns "nothing to commit, working tree clean" | Review uncommitted changes; commit, stash, or discard with explicit decision per file | pending |
| 8.1.2 | Local `main` up to date with `origin/main` | `git fetch && git status` reports "up to date" | `git pull --ff-only` (no merges, no rebases against main) | pending |
| 8.1.3 | Session A's commits all in `main` (3 migrations + rollbacks + scripts + session doc) | `git log --oneline | grep -E "session-a|cert-bridge|2026-05-04"` shows expected commits | Cherry-pick or commit missing changes; do not start Step 0 with partial Session A state | pending |
| 8.1.4 | This plan committed to `main` | `git log --oneline -- docs/plans/session-a5-operators-rebuild.md` returns ≥1 commit | Commit the plan with descriptive message; do not start execution from a draft-in-working-tree | pending |
| 8.1.5 | No untracked sensitive files (`.env`, credentials, large binaries) at risk of accidental commit | `git status --untracked-files=all` reviewed | Add to `.gitignore`; verify none staged | pending |

### 8.2 Database state

| ID | Check | Verification | If fails | Status |
|---|---|---|---|---|
| 8.2.1 | Session A's `canonical.operator_holds_certificate` intact: 115 rows where `source='faa_d085' AND confidence=0.95` | `SELECT COUNT(*) FROM canonical.operator_holds_certificate WHERE source='faa_d085' AND confidence=0.95` returns 115 | Investigate drift; canonical changes between Session A and Step 0 indicate either a missed change or unexpected mutation. Do not start Step 0 until reconciled | pending |
| 8.2.2 | A.0.6 quarantine intact: 6 rows in `canonical.operator_holds_certificate_pending` with `evidence->>'audit_run_id' = 'A.0-2026-05-04'` | `SELECT COUNT(*) FROM canonical.operator_holds_certificate_pending WHERE evidence->>'audit_run_id' = 'A.0-2026-05-04'` returns 6 | Same as 8.2.1 — investigate before starting | pending |
| 8.2.3 | Cert-bridge state from Session A: 2,052 rows in `operator_aircraft_link` with `source='faa_d085_via_cert_bridge'` | `SELECT COUNT(*) FROM canonical.operator_aircraft_link WHERE role='operator' AND source='faa_d085_via_cert_bridge'` returns 2,052 | Same as 8.2.1 | pending |
| 8.2.4 | LLM ER queue baseline: full status breakdown recorded | `SELECT status, COUNT(*) FROM public.operator_llm_er_checkpoint GROUP BY status` — record results. Session A's 351 was the initial queued count; status drift over time is expected. The baseline captures current state regardless of status | If baseline doc is missing the breakdown, capture before starting Step 0 — the diff matters for SC measurement | pending |
| 8.2.5 | Pre-rebuild `public.operators` baseline: count + breakdown documented | `SELECT operator_type, COUNT(*) FROM public.operators GROUP BY operator_type` results captured | Capture baseline; the diff vs post-rebuild is part of SC-1 measurement | pending |
| 8.2.6 | Baseline doc written | `docs/sessions/session-a5-baseline.md` exists with all the above counts and a snapshot timestamp | Write the doc before starting Step 0; this is the diff anchor | pending |

The baseline doc is the reference point for measuring SC-1 through SC-6. Without it, "≥1,750 rows" has no anchor for "increased from how many?"

### 8.3 Environment state

| ID | Check | Verification | If fails | Status |
|---|---|---|---|---|
| 8.3.1 | Supabase reachable | `psql "$SUPABASE_DATABASE_URL" -c "SELECT NOW()"` returns a timestamp | Check `.env`, network, Supabase status page. Project status (paused?) is the most common cause | pending |
| 8.3.2 | S3 reachable with the credentials this plan needs | `aws s3 ls s3://osa-dumont-backup/raw/faa/d085/ | head -5` returns objects | Check AWS creds in `~/.aws/credentials` or `.env`; verify the right profile is active | pending |
| 8.3.3 | Docker available for local migration testing | `docker version` returns server + client versions; `docker run --rm hello-world` succeeds | Install Docker Desktop or `colima start` if using Colima. Three-step migration verification requires it | pending |
| 8.3.4 | Node + npm + tsx environment green | `npm install` clean; `npx tsx --version` returns ≥4.x; Node ≥20 | `nvm use 20` (or repo-specified version); `npm install` from clean | pending |
| 8.3.5 | Pgvector + btree_gist extensions enabled in Supabase (used by canonical schema) | `psql ... -c "SELECT extname FROM pg_extension WHERE extname IN ('vector','btree_gist')"` returns both | Enable via Supabase dashboard SQL editor. Required for canonical EXCLUDE constraints to work | pending |
| 8.3.6 | (Step B only) Firecrawl Mac-local stack healthy | `cd ~/firecrawl && docker compose ps` shows `api` and `playwright-service` as `healthy` | `docker compose up -d`; if wedged, `docker compose restart api playwright-service` | pending (B-track only) |

8.3.6 only blocks Step B sub-steps. Steps 0–7 do not depend on Firecrawl.

### 8.4 Documentation state

| ID | Check | Verification | If fails | Status |
|---|---|---|---|---|
| 8.4.1 | Sections 1–7 reviewed and approved | Review-log entries in conversation context; each section had explicit Phelipe sign-off | Continue review of any unsigned section before Step 0 | pending |
| 8.4.2 | Section 8 (this) drafted and approved | This section exists; Phelipe has read it | Complete review | pending |
| 8.4.3 | Plan's most recent commit landed in `main` | `git log -1 -- docs/plans/session-a5-operators-rebuild.md` shows the latest version | (Same as 8.1.4) | pending |
| 8.4.4 | Cross-referenced docs current: `docs/invariants-2026-05-04.md`, `docs/codebase-map.md`, `docs/data-sources.md`, `docs/temporal-link-pattern.md`, `docs/phase1-followups.md` | Reading list from §1's "Read alongside" header — confirm none have changed substantively since plan drafting | If a referenced doc has changed, re-validate the section that depends on it | pending |
| 8.4.5 | Session A doc reachable: `docs/sessions/2026-05-04-session-a-cert-bridge.md` | File exists; content matches plan's references | Restore from git history if missing | pending |

### 8.5 Test suite state

| ID | Check | Verification | If fails | Status |
|---|---|---|---|---|
| 8.5.1 | Full test suite green on `main` | Run `npm test` once at pre-flight. Record actual pass/skip/fail count in baseline doc. The 375+ figure is approximate; the diff measurement that matters is "pre-flight count" vs "post-Step-7 count" — both should match unless Step 5's regression tests added new ones (which is expected and accounted for) | Investigate failures before starting. Step 5's regression sweep depends on a green baseline | pending |
| 8.5.2 | TypeScript clean | `npx tsc --noEmit` returns exit 0 | Fix type errors before starting; Step 0 parser update will surface compile errors otherwise | pending |
| 8.5.3 | Layer-isolation check green | `npm run lint:layers` returns exit 0 (per `CLAUDE.md` "Verify before shipping") | Fix layer-boundary violations; this repo should never grow agent-layer dirs | pending |
| 8.5.4 | Vitest gated tests state recorded | The 4 `SUPABASE_DATABASE_URL`-gated tests' last-run state documented | Run via `set -a; source .env; set +a; npm test` once pre-flight; record pass/fail in baseline doc | pending |

### 8.6 Calendar state

| ID | Check | Verification | If fails | Status |
|---|---|---|---|---|
| 8.6.1 | Next 1–2 surge weeks identified for Step 0–1 | SkyWest schedule consulted; surge candidates noted in baseline doc | Defer plan start until surge windows visible. Step 0 alone (3–5 hrs) fits in a single surge afternoon; Step 1 (8–12 hrs) needs multi-day continuity | pending |
| 8.6.2 | Step 0–1 fits in identified windows | Hours estimate (11–17 combined) compared against window capacity | Re-schedule plan start; do not start Step 0 if Step 1 has no window for ≥4 weeks | pending |
| 8.6.3 | No conflicting OSA brand work or Loud Hawk publication cycles | Calendar reviewed | If conflict, defer or re-sequence the conflicting work. Plan resumption from any stop gate is supported | pending |
| 8.6.4 | Pace calibration window planned (per §6.6 caveat) | First 3 weeks scheduled to capture pace data; commitment to update results doc with actual pace | If skipped, calendar estimates remain unvalidated; future plans inherit the same uncertainty | pending |

### 8.7 Tools state

| ID | Check | Verification | If fails | Status |
|---|---|---|---|---|
| 8.7.1 | Claude Code session opened with project access | Project files readable via Claude Code Read tool; current working directory is the repo root | Re-init Claude Code session pointing at `~/osa/osa-data-platform` | pending |
| 8.7.2 | This plan readable to the session | Claude can Read `docs/plans/session-a5-operators-rebuild.md` and the cross-referenced docs | Path issue or permission issue — fix before starting | pending |
| 8.7.3 | Gate-by-gate execution discipline understood | Phelipe and Claude both agree: each step's stop gate is a hard pause for review, not a suggestion | Re-read §4; align on the discipline. Skipping gates defeats the plan's design | pending |
| 8.7.4 | Memory system contains a pointer to this plan | `~/.claude/projects/-Users-phelipehonesto-osa-osa-data-platform/memory/MEMORY.md` references the plan path | Add a project-type memory entry pointing at the plan file | pending |
| 8.7.5 | OSA brand-voice and humanizer skills loaded if any documentation will be published downstream | The skills exist at `~/osa/skills/` per `~/osa/CLAUDE.md` | (Not blocking for code work; only matters for Loud Hawk / Connect copy that comes out of Step 7's results doc) | pending |

### 8.8 Open questions state

| ID | Check | Verification | If fails | Status |
|---|---|---|---|---|
| 8.8.1 | All §1–§7 self-flagged items resolved or explicitly deferred with reasoning | Conversation log review: every "self-flagged for review" bullet from each section has either a "fix applied" or "deferred to X" disposition | Resolve outstanding items before Step 0; ambiguity at execution time is more expensive than it looks | pending |
| 8.8.2 | Step B.0 recon timing decided | Two options: B.0 runs alongside Step 1 (interleaved) or after Step 7 (sequential). Decision documented in baseline doc | Default to sequential if undecided. Re-decide at Step 0 close-out if needed | pending |
| 8.8.3 | FK audit decision-log preparedness: who signs off on cross-table FK resolutions | Phelipe is the default; document if a different reviewer is needed | Default Phelipe; flag if delegation needed | pending |
| 8.8.4 | Threshold-tuning ownership for §2.1 drift gates documented | After 4 weekly fetches, who tunes the row count and cert count thresholds? Phelipe directs; Claude proposes from observed data | Default Phelipe + Claude collaborative; document if different | pending |

### 8.9 The "go" signal

When all 8.1–8.8 items are `verified` (or explicitly `deferred-with-reasoning`), the plan's pre-flight is complete. Step 0 can begin.

The "go" signal is **not automatic**. Phelipe explicitly confirms: *"pre-flight clean, starting Step 0."* Logged in `docs/sessions/session-a5-execution-log.md` with date and the items' final states.

If any item is `blocked` and not deferrable, the plan does not start. Park, resolve the blocker, restart pre-flight.

### 8.10 Resumption from a stop gate

The plan is interruption-safe at every stop gate (§4). If Phelipe pauses execution after Step 3, resumption requires re-running 8.1–8.5 (state checks) but not 8.6–8.8 (already-decided items unless changed). The execution log captures the last-completed step + state notes; resumption reads it as the entry point.

This matters because Phelipe's part-time pace means weeks may pass between sessions. The plan's gate-driven design plus this checklist's resumption mode are what make multi-month sessions work without "where was I?" overhead at each restart.

---

*End of plan.*
