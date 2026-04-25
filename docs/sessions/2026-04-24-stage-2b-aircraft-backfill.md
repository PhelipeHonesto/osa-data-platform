# Session — Stage 2b aircraft backfill

**Date**: 2026-04-24 (afternoon)
**Owner**: Phelipe Honesto
**Scope**: Populate the empty `canonical.*` tables shipped in Stage 2a. FAA bulk aircraft identity, ADS-B hex merge, `operator_aircraft_link` from `certificate_holder` resolution.

## What shipped

Three commits on `main`, pushed (`8ace867`, `cb340c6`, `2134d4c`):

- **Checkpoint 1** — FAA bulk into `canonical.aircraft`. 314,813 rows + 314,813 `aircraft_identities` (source=`faa`). 106s wall-clock, idempotent. 12 duplicate-hex losers correctly get `icao_hex=NULL`; winners keep the hex.
- **Checkpoint 2** — ADS-B identity merge. 121,512 `aircraft_identities` (source=`adsb`), 121,511 Case A (hex → existing canonical row) + 1 Case B (orphan `a4b209`). 450s wall-clock.
- **Checkpoint 3 partial** — `operator_aircraft_link` backfill via FAA certificate_holder. 35,000 aircraft processed across two run_ids (killed 10-batch timing smoke + partial full run), 10 link rows written, stopped early once the structural-ceiling finding locked in and marginal audit value dropped sharply.
- `resolveOperatorMatchOnly()` + 4 tests (CP1 commit)
- `pre-filters.ts` (5 buckets: null / placeholder / individual / trustee / manufacturer) + 29 tests
- `canonical.operator_aircraft_resolution_log` — **permanent** audit table
- `REVIEW_GATE` config in `match-thresholds.ts` + `canEnterReview()` + 5 tests — review queue now requires tier ≥ medium AND at least one corroborating signal (state/city/icao/phone); applied only in the match-only path, not the Phase 1 write path

## What did NOT ship

- **Checkpoint 4 deferred entirely** (not narrow, not wider). CP4 value scales with CP3 completeness and operator coverage; both are partial. Same CP4 code run after Track 1 Stage 3 produces richer output. The nullable-operator_id schema change is a real design decision, probably resolved by a separate `canonical.aircraft_ownership_events` table rather than relaxing `operator_aircraft_link.operator_id NOT NULL` — that's a scoping conversation, not a quick extension.
- CP3 full run — 279,813 aircraft remain. Script is idempotent via `NOT EXISTS` on `resolution_log`; resume with `npx tsx scripts/backfill-operator-aircraft-link.ts --write` any time.
- Aircraft resolver (Stage 2c) — not started. Stage 2b CP3's resolution_log is its primary input.

## Key decisions locked

- **Structural ceiling finding**: `certificate_holder` as operator proxy caps walk rate at ~0.05% of resolver-eligible aircraft. Trustees hold fleets for major charter operators by design (NetJets, Flexjet, Vista, Wheels — 3,700+ airframes correctly skipped). Major Part 121 airlines correctly absent from our charter-focused canonical. Individuals pre-filtered. Meaningful fleet attribution requires Track 1 Stage 3 + Stage 2c trustee-unmask. **1–3% walk is the honest ceiling, not 15–30%.**
- **Pre-filter taxonomy** (in `pre-filters.ts`): null cert → `skipped_null`; `-` / `REGISTRATION PENDING` / `SALE REPORTED` → `skipped_placeholder`; `registrant_type='1'` → `skipped_individual`; trustee suffix + explicit trustee names → `skipped_trustee`; `BOARD OF TRUSTEES OF <university>` is an exception (passes through); manufacturer names → `skipped_manufacturer`.
- **Resolution log is permanent**, not staging. One row per `(aircraft_id, backfill_run_id)`. FKs to aircraft, operators, link, review with appropriate ON DELETE behavior. Re-runs append (different run_id), never overwrite.
- **REVIEW_GATE** — review queue requires tier ≥ medium AND corroborating signal. Applied in `resolveOperatorMatchOnly` only; `resolveOperator` (Phase 1 path) keeps its looser behavior. This is the best-shipped artifact of the session; every future backfill inherits it.
- **CP3 stop-early** — primary deliverable is the audit log, not the link rows. Log stabilized in first 30K rows; continuing would have spent 3 more hours for ~200 more matches and ~6K more review items of diminishing value.

## Surprises / learnings

- **Individuals overlap with NULL cert**: 73,060 of 118,075 registrant_type=1 rows have NULL certificate_holder. The pre-filter's null check runs first, so those land in `skipped_null`, not `skipped_individual`. Same outcome functionally. Minor refactor (flip order) tracked in phase1-followups.
- **Top no_match strings are major airlines** (UAL 135, AAL 121, DAL 107, SWA 65, SkyWest 63, FDX 53, JBU 27) — none of these will ever match and none should; they're scheduled Part 121, not charter.
- **FAA registry duplicate-hex rows** are real and rare (~12 pairs in 314K). Partial-unique index + updated_at-winner rule handles them cleanly.
- **pg concurrent-query deprecation** surfaced and was fixed (serialized three verification queries in CP1).
- **Resolver fuzzy matches on "AIR" token** produce "AIR METHODS LLC" ↔ "ACCENT AIRWAYS LLC" style false positives. REVIEW_GATE is the answer.

## Next session starting point

**Track 1 Stage 3** (operator coverage expansion) — the top 50 no_match list from CP3 is the input prioritization. Directly-resolvable charter adjacencies that should be in `public.operators` but aren't: CHRISTIANSEN AVIATION LLC (32), WINGS OVER TEXAS HOLDINGS LLC (17), CARGO AIRCRAFT MANAGEMENT INC (16), PHI HEALTH LLC (16), GUARDIAN FLIGHT LLC, METRO AVIATION INC, REACH AIR MEDICAL SERVICES LLC, ALPINE AVIATION INC.

Several no_match entries are actually **alias misses** (`FLEXJET LLC` / `NETJETS SALES INC` / `WHEELS UP PARTNERS LLC` vs canonical `Flexjet` / `NetJets Aviation` / `Wheels Up`). Flagged in phase1-followups; fixed via broader `operator_aliases` audit.

## CP4 — deferred, open design question

Open question for when we revisit: the right shape for `aircraft_ownership_events`.

Current `operator_aircraft_link.operator_id` is `NOT NULL`. To record an ownership transition where the new holder doesn't resolve to a canonical operator (most of 75K `faa_registry_changes.ownership_change` rows), either:
- Relax operator_id to nullable — changes the link table's semantics ("a link row may represent an unresolved transition") — not favored
- Introduce `canonical.aircraft_ownership_events` as a separate event table keyed on aircraft_id + detected_at, holding scraped `new_value` in a text column until a later session resolves — favored; preserves link-table discipline and matches the ER plan's event-edge variant in `docs/temporal-link-pattern.md`

CP4 decision deferred until the post-Stage-3 session picks this up.

## Rule to add to CLAUDE.md next session

(Carried from Stage 2a notes, still pending.) **Migration verification rule**: every migration commit must end with (a) local up-down-up rollback, (b) `npm run db:migrate-pg` against Supabase, (c) `describe-schema` verification. All three, not any two.

Additional Stage 2b finding worth a rule: **long-running background scripts must not pipe stdout through `| tail -N`** — the pipe buffers until process exit and blocks real-time monitoring. Use `> file` redirect + `Monitor` with `tail -F` instead.

## Probe findings (late afternoon, before next session restart)

Two pathways probed for operator-aircraft link expansion beyond cert_holder:

1. **target_companies** (12,887 rows, 15,938 tails): ~11% gross match rate vs top-100 faa_operators by aircraft_count, ~6-8% net after REVIEW_GATE would filter first-word false positives. Modest pathway, real but not game-changing. Defer to session after operator coverage expands (match set grows as canonical grows).

2. **adsb_completed_legs.operator_name**: NOT a distinct pathway — it's a propagated copy of faa_aircraft.certificate_holder during the ADS-B ingest join. Top-30 distribution matches CP3 cert_holder top exactly (airlines, trustees, flight schools). Same structural ceiling as CP3. Do not pursue.

Conclusion: next session does Step A only — faa_operators merge to expand canonical.operators by ~100-200 rows. target_companies stays on the followups list for post-coverage-expansion.

---

## Late afternoon — operator coverage + historical ER schema

Picking up from the morning probe conclusion ("next session does Step A only"), this segment shipped two milestones: the realfleet operator merge that closed the CP3 coverage gap, and the operator_events historical-ER table that unblocks Stage 3 lineage work.

### Milestone 1 — realfleet operator merge

Commit `f211b5a` — `feat(canonical): merge faa_operators realfleet (26 operators, aircraft_count >= 20) into public.operators`.

The morning probe had diagnosed CP3's 0.05% walk rate as a structural ceiling caused by canonical.operators only holding 270 rows — missing every major Part 135 fleet that doesn't have a synthetic NETJ001-style cert. The Stage-2b-followup script `backfill-operators-canonical-faa-realfleet.ts` filtered `faa_operators` by `aircraft_count >= 20 AND TRIM(UPPER(certificate_number)) != TRIM(UPPER(name))` and merged the result. 26 operators inserted with `operator_type='part_135'` and `data_confidence_score=1.0`. Run id `7286b260-6c9d-4cfc-ad70-f77e7a200931`.

All 9 named target brands now in canonical: NetJets Aviation (EJA, 304 aircraft), Executive Jet Management (EJM, 176), Flexjet (LXJ, 148), JetSuite/JSX (JTL, 75), PlaneSense (PCH, 69), Wheels Up (WUP, 62), FlyExclusive (FFL, 48), VistaJet (VJA, 43), XO/JetSmarter (XSR, 35). Plus 17 more (Textron, Gulfstream, Directional Aviation Capital, JetRight, Biggin Hill, Embraer Executive Jets, Comlux, Tradewind, Contour, Thrive, Sun Country, Honeywell, JetAviation, Boutique Air, Corporate Air, Freestream, Lakeland Aero).

Decisions baked into the script:
- Three structural pushbacks against the original /plan caught before write: `canonical.operators` corrected to `public.operators` (operators table still in public, schema-move is a deferred ALTER), `type_tags=['part_135']` rejected because the CHECK constraint forbids it (used `operator_type='part_135'` instead, `type_tags=[]`), and the `dba_name` ICAO callsigns (EJA, LXJ, WUP, etc.) handled as identifiers, not aliases — they don't fit `operator_aliases.alias_type` semantics. Logged 26 callsigns to stdout for the future `icao_callsign` column on `public.operators` (followup added to phase1-followups.md).
- Pre-filter `cert != name` removed the co-holder LLC duplicates (FLEXJET LLC, NETJETS SALES INC, WHEELS UP PARTNERS LLC, FEDERAL EXPRESS CORPORATION) that would otherwise pollute canonical with second identities for the same real entity.
- Idempotency via `NOT EXISTS operator_identities WHERE source='faa' AND source_id=cert` plus `UNIQUE (source, source_id)`. Re-runs are no-ops.
- Rollback by `match_evidence->>'backfill_run_id'` via `schema/rollback/2026-04-24-operators-realfleet-rollback.sql` — cascade-deletes identities + aliases via FK ON DELETE CASCADE on the operators row.

Process diagnostic worth flagging: the dry-run process appeared hung for 18+ minutes during initial execution. Investigation found no DB-side residue (no locks, no idle txns, no zombie backends) — the actual issue was pino's async log destination keeping the Node event loop warm post-completion. Cosmetic, not a correctness issue. Captured in commit `94193a0` (`docs: pino logger dry-run event-loop follow-up`).

Post-merge probe of the `aircraft_count BETWEEN 10 AND 19` band returned 34 candidate rows — 32% real charter, 35% pure noise (trustees, leasing LLCs, tail-number LLCs), 12% cargo (3 FedEx duplicates + Royal Air Freight), 15% uncertain. Below the 60% signal floor; recommended stop at threshold=20 and defer mid-tier merge to a curated cert-list session (not a threshold ratchet — the 12 noise rows expose a name-side filter gap that threshold-walking can't fix).

### Milestone 2 — canonical.operator_events historical ER schema

Commit `2e26696` — `feat(canonical): operator_events schema for historical ER`.

New canonical table for the lineage layer of the operator entity. Captures discrete events that change operator identity, structure, or certificate: rebrands, M&A, cert transfers, formations, dissolutions, foreign AOC changes. Empty on arrival; population is Stage 3+ work.

Design notes (full spec in `docs/er-architecture-plan.md` §"canonical.operator_events"):
- 26 columns, 11-value `event_type` CHECK enum
- Four nullable UUID FKs into `public.operators` (ON DELETE RESTRICT) with three text-name fallbacks for events whose parties aren't in canonical yet
- `aoc_before` / `aoc_after` for cert state changes (NULL for rebrands by definition — cert preserved)
- Free-text `source` matching the canonical convention (closed enum rejected — every new source would need a migration)
- `corroborated_by` / `contradicted_by` JSONB for Two-Source Rule audit trail, same shape as `canonical.operator_aircraft_link`
- `confidence NUMERIC(3,2)` (not TEXT enum) consistent with the rest of canonical
- `valid_from` / `valid_to` for claim-level corrections (not bitemporal)
- `natural_key TEXT UNIQUE` for ingestion-script idempotency
- 10 indexes total: PK + natural_key UNIQUE + 8 query indexes (3 partial party indexes, 2 partial aoc indexes, 1 partial current-state, 2 time-anchored)

Migration verification was the first session to satisfy the new three-step rule (commit `e178733` codifies it as CLAUDE.md §4): local Docker postgres:16 up→down→up cycle clean, `npm run db:migrate-pg` exit 0, then `psql \d+ canonical.operator_events` against Supabase confirmed the live shape. canonical schema went from 5 tables to 6.

The rollback script (`schema/rollback/2026-04-24-operator-events-rollback.sql`) carries a refused-if-rows safety probe — future rollback against a populated table halts loudly rather than silently dropping data. Pattern to repeat in every future canonical rollback script.

### Milestone 3 — process discipline codified

Commit `e178733` — `docs(claude): migration-verification rule + db:test followup`.

CLAUDE.md §4 now mandates the three-step migration-verification rule (local Docker cycle + migrate-pg exit 0 + explicit production object check). Triggered by Stage 2a's morning incident: three commits shipped with passing local tests, but the Supabase migrate-pg step was silently dropped between rollback test and push, missing tables only caught ~6 hours later during Stage 2b pre-flight.

phase1-followups.md gained a "npm run db:test helper" entry to track wrapping the ad-hoc Docker ritual into a single npm script. Quality-of-life only, not blocking.

### Session totals (full day)

- **Commits**: 11 total on `main`
  - Morning (Stage 2a + 2b CP1/CP2/CP3 + probe addendum): 7
    - Stage 2a (canonical aircraft + temporal-link pattern): 3 commits
    - Stage 2b CP1 (FAA bulk → canonical.aircraft, 314K rows): 1
    - Stage 2b CP2 (ADS-B identity merge): 1
    - Stage 2b CP3 (operator_aircraft_link, 0.05% walk rate, structural-ceiling diagnosis): 1
    - Probe-findings addendum + session-notes restart: 1
  - Late afternoon (this segment): 4 — `f211b5a`, `94193a0`, `2e26696`, `e178733`
- **Schema objects added today**:
  - `canonical.aircraft`, `canonical.aircraft_identities`, `canonical.aircraft_aliases` (Stage 2a)
  - `canonical.operator_aircraft_link`, `canonical.operator_aircraft_resolution_log` (Stage 2a)
  - `canonical.operator_events` (this segment)
  - 6 new tables, all in canonical schema. Total canonical tables now 6 (was 0 at start of day).
- **Data shipped**:
  - `canonical.aircraft`: 314K rows from FAA bulk + ADS-B identity merge
  - `canonical.operator_aircraft_link`: 17 rows (CP3 walk rate ceiling)
  - `public.operators`: 270 → 296 (+26 from realfleet merge)
  - `public.operator_identities` (source='faa'): 50 → 76 (+26)
- **Test count**: 440 passing, 8 skipped (was 421 at start of day; +19 from realfleet test file)
- **TypeScript**: `npx tsc --noEmit` clean throughout

### Canonical state at session close

| Table | Rows | Notes |
|-------|------|-------|
| `canonical.aircraft` | 314K | FAA bulk + ADS-B merged |
| `canonical.aircraft_identities` | ~314K + ADS-B identities | Multi-source linkage |
| `canonical.aircraft_aliases` | small | Alternate tail / model variants |
| `canonical.operator_aircraft_link` | 17 | CP3 walk; structural ceiling at ~0.05% |
| `canonical.operator_aircraft_resolution_log` | full CP3 audit trail | Permanent log |
| `canonical.operator_events` | 0 | New today; empty on arrival |
| `public.operators` | 296 | +26 realfleet today |
| `public.operator_identities` | 76 (source='faa') | +26 realfleet today |
| `public.operator_aliases` | unchanged | Skipped — ICAO callsigns aren't aliases |

### Natural next session entry point

**Stage 2c — agent-facing views over the canonical aircraft layer**, specifically:

1. `v_aircraft_current_operator` — per-aircraft current operator from `operator_aircraft_link WHERE valid_to IS NULL`. The agent-side surface that lets Dumont answer "who flies N123AB" without joining four tables.
2. `v_aircraft_history` — per-aircraft historical operators with date ranges. Time-aware lookup for sourcing context.
3. Re-run CP3 with the expanded operator coverage (270 → 296 operators, +9 named brands). The walk rate should jump meaningfully — NetJets, Flexjet, PlaneSense, etc. were the main absent-from-canonical contributors. Compare new resolution_log vs prior to quantify the lift.

Operator_events stays empty until Stage 3 (FAA GENOT + SEC EDGAR integrations). Stage 3 is gated on Firecrawl wiring — without web scraping, ~70% of source pathways are unreachable.

Followups outstanding (all in `docs/phase1-followups.md`):
- icao_callsign column on `public.operators` (before Stage 2c trustee-unmask)
- pino logger event-loop fix for dry-run scripts (cosmetic)
- npm run db:test helper for migration sessions (quality-of-life)
- Pre-existing followups from morning: alias-table audit, manufacturer-NULL slip, target_companies pathway, and the deeper faa-operators-full ingestion rewrite that would solve the noise problem at source.

---

## Appendix — realfleet merge ICAO callsigns (preserves data until icao_callsign column ships)

The Stage-2b-followup realfleet merge (commit `f211b5a`) skipped 26 alias inserts because every `dba_name` in the candidate set was a 3-letter ICAO airline designator, not a "doing business as" name. Those callsigns are recorded here in raw form so they survive until the `icao_callsign TEXT` column on `public.operators` ships (followup tracked in `docs/phase1-followups.md` §"Add icao_callsign column to public.operators").

Format: `(certificate_number, canonical_name, icao_callsign)`. The cert and the callsign are the same value in this dataset — `dba_name` and `certificate_number` both carry the ICAO designator for these operators. The canonical_name is the human-readable carrier name.

```
(EJA, NetJets Aviation,           EJA)
(EJM, Executive Jet Management,   EJM)
(LXJ, Flexjet,                    LXJ)
(TWY, Textron Aviation,           TWY)
(GLF, Gulfstream Aerospace,       GLF)
(DCM, Directional Aviation Capital, DCM)
(JTL, JetSuite / JSX,             JTL)
(PCH, PlaneSense,                 PCH)
(WUP, Wheels Up,                  WUP)
(JRE, JetRight,                   JRE)
(FFL, FlyExclusive,               FFL)
(VJA, VistaJet,                   VJA)
(BBA, Biggin Hill Executive Aviation, BBA)
(EMB, Embraer Executive Jets,     EMB)
(CDR, Comlux Aviation,            CDR)
(CYC, Tradewind Aviation,         CYC)
(XSR, XO (formerly JetSmarter),   XSR)
(CNS, Contour Aviation,           CNS)
(TMB, Thrive Aviation,            TMB)
(FDY, Sun Country Airlines,       FDY)
(HON, Honeywell Flight Operations, HON)
(JAS, JetAviation,                JAS)
(BTQ, Boutique Air,               BTQ)
(CPT, Corporate Air,              CPT)
(FTH, Freestream Aircraft,        FTH)
(LAK, Lakeland Aero,              LAK)
```

Backfill source: `public.faa_operators` rows where `aircraft_count >= 20 AND TRIM(UPPER(certificate_number)) != TRIM(UPPER(name))`, queried 2026-04-24. The certificate_number column in faa_operators carries the ICAO callsign for these specific entries (a quirk of the FAA-operators-full ingestor's ICAO_OPERATOR_MAP, see `docs/phase1-followups.md` §"faa-operators-full.ts ingests aircraft owners as operators").

When the `icao_callsign` column lands on `public.operators`, this appendix can be replayed as a SQL backfill keyed by the canonical_name match.
