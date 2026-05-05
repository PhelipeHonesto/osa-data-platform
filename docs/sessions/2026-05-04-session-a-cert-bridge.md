# Session — Session A: cert-bridge derivation (Track 6 Step 2d)

**Date**: 2026-05-04
**Owner**: Phelipe Honesto
**Driver**: claude-opus-4-7 (1M context)
**Plan**: `/Users/phelipehonesto/.claude/plans/proud-enchanting-sutherland.md`
**Scope**: Pre-work P.1 + P.2 (ER-Evaluation library baseline + ground_truth_outcome column). Session A: A.0 false-positive spot-check → A.0.5 full audit → A.0.6 quarantine → A.1 cert-bridge derivation → A.2 validation.

## What shipped

### Migrations (3, all 3-step verified per CLAUDE.md §4)

- **`schema/migrations/2026-05-04-001-operator-llm-er-checkpoint-ground-truth.sql`** (P.2) — adds NULLable `ground_truth_outcome` column with 6-value CHECK enum (3 confirmation values + 3 reviewer-override values). Substrate for post-Session-B calibration.
- **`schema/migrations/2026-05-04-002-operator-holds-certificate-pending-reason-extend.sql`** (A.0.6) — extends pending sidecar `reason` CHECK to allow `'lookalike_misresolution'` alongside the original `'no_canonical_operator_candidate'`.
- **`schema/migrations/2026-05-04-003-operator-aircraft-resolution-log-cert-bridge-actions.sql`** (A.1) — extends resolver_action enum on `canonical.operator_aircraft_resolution_log` with `cert_bridge_linked`, `cert_bridge_skipped_overlap`, `cert_bridge_skipped_already_linked`. Keeps one canonical audit log per Invariant 9 (no sibling cert-bridge log).

All three migrations verified end-to-end: local Docker rollback test → `npm run db:migrate-pg` exit 0 → `psql \d+` prod confirmation. Rollback files in `schema/rollback/` for each, with warnings where rollback would FAIL on extant rows of the new enum values.

### Scripts

- **`scripts/eval/baseline-19case.py`** + **`requirements.txt`** + **`.venv/`** (P.1) — establishes the project's first Python toolchain at `scripts/eval/`. Uses `cleanzr/er-evaluation` 2.3.0 (Binette + Steorts cluster-block-sampling estimators). Reads `.work/llm-er-pass/eval-20260425T235403Z/results.jsonl`, computes per-decision-mode accuracy + clustering metrics + bias-corrected estimators with normal-approx 95% CIs.
- **`scripts/quarantine-step2c-lookalike-falseps.ts`** (A.0.6) — hardcoded 6 ohc_ids, per-row tx INSERT pending → DELETE canonical, refused-if-already-quarantined and refused-if-row-shape-doesn't-match-audit-expectations.
- **`scripts/backfill-operator-aircraft-link-from-cert-bridge.ts`** (A.1) — JOIN aoc × ohc on cert_id, derive valid_from=GREATEST / valid_to=LEAST / confidence=LEAST, NOT EXISTS pre-filter, per-row tx with EXCLUDE-violation try/catch logging skipped_overlap. Audit-row backfill_run_id encodes per-attempt uniqueness via `<base>_<ohc_id[0:8]>_<aoc_id[0:8]>` because the resolution_log has UNIQUE (aircraft_id, backfill_run_id).

### Reference docs

- **`docs/codebase-map.md`** — repo orientation: layout, schemas + constraint types, scripts inventory, Stage 2c pipeline pattern, Phase 2 LLM ER wiring, S3 layout, planner footnotes (gotchas).
- **`docs/invariants-2026-05-04.md`** — 17 cross-cutting invariants with verbatim source quotes from `docs/temporal-link-pattern.md`, `docs/data-sources.md`, `docs/er-architecture-plan.md`, `docs/er/aircraft.md`, `CLAUDE.md`.
- **`.work/llm-er-pass/a0-step2c-lookalike-audit-2026-05-04.md`** — full A.0 + A.0.5 audit doc; quarantine evidence JSONB references this path.
- **`.work/llm-er-pass/er-evaluation-baseline-2026-05-04.md`** — P.1 ER-Evaluation library baseline metrics report.
- **`docs/phase1-followups.md`** — appended new section "Track 6 Step 2c.6: lookalike-misresolution remediation" with three items + re-run sequence.

## Pre-work outcomes

### P.1 — ER-Evaluation library baseline ✓

Library installs cleanly on Python 3.14.4 / Mac arm64. All 5 baseline metrics reproduce `docs/phase-2-eval-summary.md` exactly within rounding:
- Hidden-mode `new_entity` rate: 8/9 = 88.9%
- Hidden-mode false-match rate: 0/9 = 0.0%
- Visible genuine accuracy: 6/6 = 100%
- Citation validated overall: 16/19 = 84.2%
- Cost per record: $0.0468 (vs reported $0.04)

Caveat surfaced: clustering metrics (pairwise / B-cubed / ARI) on this 19-record corpus are partially degenerate because the eval pairs each holdout case across two sub-modes (visible + hidden) that intentionally produce contradictory decisions for the same `truth_operator_id`. By construction every visible/hidden pair is a missed merge. Bias-corrected B-cubed recall: 0.5278 ± 0.0651, 95% CI [0.4001, 0.6555]. Pairwise estimators return NaN on this specific corpus (insufficient non-singleton predicted clusters). Session B's 351-record single-decision corpus will not have this property.

### P.2 — `ground_truth_outcome` column ✓

Three-step verification clean. Column accepts NULL, accepts the 6 enum values, rejects everything else.

## A.0 + A.0.5 audit findings

### Methodology

- **A.0**: 30 rows from `canonical.operator_holds_certificate WHERE source='faa_d085' AND confidence=0.95`, stratified-sampled toward false-positive risk: 7 rows with runner_up≥0.8 (all of bucket), 13 with runner_up∈[0.5,0.8) (all of bucket), 10 random from runner_up<0.5 OR NULL (101 rows in pool).
- **A.0.5**: full 121-row population. Aggressive normalization (lowercase → strip punctuation → strip corporate suffixes [LLC, Inc, Corp, Co, Ltd, LP, Service/Services] → collapse whitespace). 111/121 normalized to identical strings (CLEAN). 10 surfaced as REVIEW. Manual classification of REVIEW set; cross-checked `public.operators` to verify whether the FAA holder exists as its own canonical entry.

### 5 confirmed false positives (6 polluted rows due to TCHA temporal split)

| Cert | Canonical match (wrong) | FAA holder (truth) | top | runner_up | Pattern |
|---|---|---|---:|---:|---|
| **FJTA** | Corporate **Aircraft** Management Inc. | Corporate **Flight** Management, Inc. | 0.927 | 0.871 | Different operating-noun |
| **GQ9C** | **ENG** Aviation Inc. | **GQ** Aviation, Inc. | 0.922 | 0.772 | Cert designator literally encodes "GQ" |
| **TCHA** ×2 | Executive **Jet** Management | Executive **Flight** Management | 0.928 | 0.681 | Phase-2-eval case 4 verbatim |
| **70TA** | Triton **Airways**, LLC | Triton **Air** LLC | 0.947 | NULL | Airways ≠ Air |
| **OW6A** | **Arrow** Aviation | **Arrow West** Aviation | 0.912 | NULL | "West" is load-bearing |

False-positive rate: **5/121 = 4.1%**. By risk bucket:

| Bucket | Count | False positives | FP rate |
|---|---:|---:|---:|
| `runner_up ≥ 0.8` | 7 | 1 (FJTA) | 14% |
| `runner_up ∈ [0.5, 0.8)` | 13 | 3 (GQ9C, TCHA × 2) | 23% |
| `runner_up < 0.5 OR NULL` | 101 | 2 (70TA, OW6A) | 2% |

The medium-runner-up bucket carries the highest FP density. NULL-runner-up FPs require a lexical near-twin in canonical while the true entity is missing.

### Root cause

Verified via `SELECT FROM public.operators` — none of the 5 FAA-side holders exist as their own canonical rows. The resolver matched lexically because there was no better candidate. Traces to canonical pool sparsity (`docs/phase1-followups.md` §1: only ~50 of 3,898 `faa_operators` are real Part 135).

## A.0.6 quarantine

6 polluted rows moved from `canonical.operator_holds_certificate` to `canonical.operator_holds_certificate_pending` with `reason='lookalike_misresolution'`. All 6 transactions committed cleanly.

- **`audit_run_id`**: `A.0-2026-05-04`
- **Audit doc reference (in evidence JSONB)**: `.work/llm-er-pass/a0-step2c-lookalike-audit-2026-05-04.md`
- **Reviewer**: `claude-opus-4-7`
- **Provenance**: each pending row's evidence JSONB carries `original_ohc_id`, `original_canonical_match` (operator_id + canonical_name), full `original_evidence` (top_score, runner_up_score, snapshot dates, S3 keys), `cert_designator`, `quarantined_at`, per-case `notes`, and the audit doc path.

Post-write counts:
- `canonical.operator_holds_certificate WHERE source='faa_d085' AND confidence=0.95`: 121 → **115** (down 6)
- `canonical.operator_holds_certificate_pending WHERE evidence->>'audit_run_id' = 'A.0-2026-05-04'`: 0 → **6**
- 6 ohc_ids absent from canonical: confirmed

## A.1 cert-bridge derivation

Joins `canonical.aircraft_on_certificate × canonical.operator_holds_certificate ON cert_id` with daterange overlap, derives `valid_from = GREATEST`, `valid_to = LEAST` (NULL if both NULL), `confidence = LEAST(ohc.confidence, aoc.confidence)`, role='operator', source='faa_d085_via_cert_bridge'. Per-row tx with NOT EXISTS pre-filter and EXCLUDE-violation try/catch.

### Two bugs caught and fixed mid-run

1. **Audit-log UNIQUE collision** — `canonical.operator_aircraft_resolution_log` has UNIQUE index `ux_oarl_aircraft_run` on `(aircraft_id, backfill_run_id)`. Designed for Step 2c's "one decision per aircraft per run" model. Cert-bridge generates multiple (ohc, aoc) attempts per aircraft (temporal windows, multi-cert assignments). First `--write` attempt failed at the third row's audit insert (UNIQUE violation). Fix: per-attempt `backfill_run_id` = `<base>_<ohc_id[0:8]>_<aoc_id[0:8]>`. Base run id remains queryable via prefix LIKE.
2. **Double `client.release()`** — catch handler called `client.release()` AND `finally` did too, producing "Release called on client which has already been released" once any non-EXCLUDE error fired. Fix: introduced `txStarted` guard, removed catch-side release/end, single release in finally.

The 2 partial rows from the first failed run were cleaned up before the second run.

### Final results

```
Mode: WRITE
Run id: track6_step2d_cert_bridge_20260505T020642Z

Candidates: 2087 (1957 unique aircraft × 111 unique operators × 112 unique certs)

Outcomes:
  cert_bridge_linked:                   2052
  cert_bridge_skipped_already_linked:     35
  cert_bridge_skipped_overlap:             0

Confidence histogram:
  [0.85, 0.95): 2087  (LEAST(ohc=0.95, aoc=0.85) = 0.85 always)
```

The 1-row delta from dry-run (2053 / 34) to write (2052 / 35) is the expected dry-run-vs-write state-tracking effect: under `--write`, when one cert-bridge row commits, a subsequent attempt for the same aircraft (different temporal window) now hits the NOT EXISTS pre-filter that the read-only dry-run missed. Total audit row count unchanged (2087).

Quarantine prevented 6 polluted rows from entering cert-bridge: the post-quarantine ohc population (115 rows, 112 unique certs) drove the JOIN; FJTA / GQ9C / TCHA / 70TA / OW6A polluted rows excluded.

## A.2 validation

### Coverage: 2.57% on March 2026 active aircraft

| Metric | Value |
|---|---:|
| `adsb_completed_legs` distinct icao_hex (Mar 2026) | 52,693 |
| Of those, with a canonical operator-link | 1,355 |
| **Coverage** | **2.57%** |

**~10x below the plan's 25–30% projection. The projection was wrong, not the work.** canonical.aircraft is well-populated (99.6% has icao_hex) and a superset of all 52,693 March-active hex codes — no sparsity at the aircraft layer. The bottleneck is upstream: `canonical.operator_holds_certificate` only has 115 high-tier rows (post-quarantine), covering 112 of the ~1,960 FAA Part 135 certs (~6%). Step 2c writes only `confidence=0.95` matches; lower-tier ones go to the 351-row review queue waiting for Session B.

The 25–30% target requires Session B to expand `operator_holds_certificate` via LLM ER on the 351 queued cases, then re-derive cert-bridge. Or pool densification (faa-operators-full rewrite, deferred).

### Top operators by hours March 2026 — trustees absent ✓

| # | Operator | Type | Callsign | Hours | Aircraft |
|--:|---|---|---|--:|--:|
| 1 | Executive Jet Management | part_135 | EJM | 2,364.7 | 116 |
| 2 | Sunset Aviation | | | 1,119.8 | 106 |
| 3 | Jet Linx Aviation | | LJY | 1,042.8 | 58 |
| 4 | BERING AIR INC | part_135 | BRG | 836.3 | 24 |
| 5 | Advanced Air LLC | | | 718.8 | 14 |
| 6 | Northern Jet Management | | NJM | 614.5 | 20 |
| 7 | Summit Aviation | | | 587.9 | 21 |
| 8 | Clay Lacy Aviation | | | 510.3 | 34 |
| 9 | Tri State Charter LLC | | | 414.9 | 10 |
| 10 | Corporate Air | part_135 | CPT | 411.6 | 22 |
| 11–20 | Regency Air, Nicholas Services, Prime Jet, Latitude 33, Pegasus Elite, Boutique Air, Kalitta Charters, Sterling Aviation, Hera Flight, FlyUSA | | | 235–306 | 4–21 |

**Validation**:
- ✅ Real charter operators in top 10 (EJM = NetJets-via-management-cert, Jet Linx, BERING, Northern Jet, Clay Lacy, Corporate Air…)
- ✅ Trustees absent from top 20 (no Bank of Utah Trustee, Wells Fargo Bank Northwest Trustee, etc.)
- **Pending**: Wheels Up, Flexjet, VistaJet not yet ranked. Their certs are not yet in `canonical.operator_holds_certificate` at high tier. Session B's LLM ER pass on the 351-row queue is the most likely path to surface them.

### Source distribution in operator_aircraft_link role='operator'

| source | rows | unique aircraft |
|---|---:|---:|
| `faa_d085_via_cert_bridge` (today) | 2,052 | 1,924 |
| `adsb_callsign` (Stage 2c earlier) | 257 | 257 |
| `faa_registry` (CP3) | 13 | 13 |

Cert-bridge contributed 88% of all `role='operator'` link rows.

## Step 2c.6 backlog (captured in `docs/phase1-followups.md`)

Three items appended under "Track 6 Step 2c.6: lookalike-misresolution remediation":

1. **Lower-tier audit** — re-run A.0.5 normalization pass against `confidence=0.85` and `confidence=0.75` populations. Priority: Medium.
2. **Resolver gate tightening** — extend `decide()` in `src/entity-resolution/operator-resolver.ts`: require `top_score - runner_up_score ≥ 0.15` AND token-level mismatch refusal on load-bearing nouns (Aircraft / Flight / Air / Airways / Jet / Charter / Service). Unit tests using the 5 known false positives as regression cases. Priority: **High before any Step 2c re-run**.
3. **Canonical pool densification** — blocked on `faa-operators-full.ts` rewrite (`docs/phase1-followups.md` §1). Priority: Blocked.

Re-run sequence documented: §1 rewrite → re-ingest pool → land Item 2 → re-run Step 2c → re-audit → cert-bridge re-derives.

## Surprises / learnings

- **The 25–30% coverage projection in the plan was unrealistic for cert-bridge alone.** Cert-bridge is bounded by the upstream `operator_holds_certificate` population, not by the cert-bridge logic. Session B (LLM ER on the 351 queue) is on the critical path to the plan's coverage target.
- **The visible/hidden eval design breaks clustering metrics.** Pairwise / ARI / B-cubed are partially degenerate on the 19-record P.1 corpus by construction (same truth, contradictory predictions). Session B's 351 single-decision rows will give clean clustering metrics.
- **`canonical.operator_aircraft_resolution_log` UNIQUE on (aircraft_id, backfill_run_id)** is a Step-2c-era assumption that doesn't fit cert-bridge's multi-attempt-per-aircraft model. Worked around with a per-attempt run_id suffix; the underlying schema assumption may need revisiting if more multi-attempt resolvers ship.
- **Step 2b/2c don't capture source URLs** for D085 sources (XLSX-in-S3 has no public URL). The cert-bridge evidence JSONB exposes both `ohc_source_url` and `aoc_source_url` slots — both NULL for current data, but the structure is in place for sources that do have URLs.
- **Test-driven verification of the false-positive gate worked exactly as designed.** A.0's "stop if ≥2 clear false positives" gate caught the pollution before cert-bridge propagated it to 5 wrong fleet attributions × 6+ rows. Quarantine path is reusable for future audits.

## Next session starting point

**Session B — Phase 2 LLM ER reason-only pass** on 351 queued records in `public.operator_llm_er_checkpoint`. Requires:

- Firecrawl Mac-local docker stack up (`docker compose ps` from `~/firecrawl` shows api, playwright-service healthy).
- Confirm post-fix `renderSelectingPrompt` (4 prompt fixes baked in per `docs/phase-2-eval-summary.md`).
- Confirm 5-layer validator wired and `CONFIDENCE_POST_CAP = 0.85` enforced.
- ~14 hours of supervision capacity. Cost target: ~$14 Sonnet (351 × $0.04/record).

Use existing primitives only: `--claim-next` and `--submit-response`. NO `--commit` during Session B (reason-only). All verdicts land in `operator_llm_er_checkpoint`. Resumption is automatic for queued + failed (<3 attempts) + stale `in_progress` (>60 min).

After Session B → Session C (validation + calibration data capture). Per the original plan.

## Operational note

**No more canonical writes between Session A and Session B.** Pre-work, Session A complete and verified. Cert-bridge rows are stable; quarantine is stable; lower-tier audit and resolver gate tightening are deferred to post-Session-C work.
