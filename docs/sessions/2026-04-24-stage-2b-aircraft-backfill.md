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
