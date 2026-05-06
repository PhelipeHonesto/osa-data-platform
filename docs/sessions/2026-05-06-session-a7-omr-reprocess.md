# Session A.7 — omr review queue reprocess (2026-05-06)

**Date**: 2026-05-06
**Status**: Phases 1, 2, and 2.5 closed. Session A.7 complete.
**Plan**: `/Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md` (Path A — Stage 2 close-out before LLM ER)
**Predecessor**: `docs/sessions/2026-05-06-session-a6-operators-dedup.md`

---

## What landed

Two commits on `main`:

1. **Phase 1** — `0633bc1`. New script `scripts/decompose-omr-queue-2026-05-06.ts`.
   Read-only analysis, buckets all 1054 pending `operator_match_review` rows by
   stored `_resolver_reason` and counts two mechanical auto-resolve classes
   (dedup-unblocked, normalize-match) per row.

2. **Phase 2 + Phase 2.5** — `3a1de16`. New script
   `scripts/reprocess-omr-mechanical-2026-05-06.ts`. Per-row transactional
   INSERT operator_identities + UPDATE operator_match_review for 20 mechanical
   rows; UPDATE reviewer_notes only for 3 deferred rows.

---

## Phase 1 findings

### Bucket breakdown (1054 pending)

| stored `_resolver_reason` | n | dedup-unblocked | normalize-match | either |
|---|--:|--:|--:|--:|
| NULL | 980 | 13 | 6 | 17 |
| low_tier | 42 | 2 | 2 | 4 |
| medium_name_only | 29 | 0 | 2 | 2 |
| ambiguous_runner_up | 3 | 0 | 0 | 0 |
| **TOTAL** | **1054** | **15** | **10** | **23** |

### Three findings worth carrying forward

1. **`_resolver_reason` is NULL for 980 of 1054 rows.** Older code paths
   (likely `expand-public-operators-from-d085-pending.ts` /
   `backfill-operators-canonical-faa.ts`) write to operator_match_review
   without going through the resolver's `writeReview` function (the only
   path that sets `_resolver_reason`). The Phase 1 classifier ignores
   stored_reason and uses `candidate_matches` structure (count ≥ 2 + score
   similarity within AMBIGUITY_EPSILON + exactly one of top/RU deduped),
   which catches the 5 expected omr ids correctly even with NULL reason.

2. **The "9 gate_downgrade" reference in the A.6 doc isn't backed by data.**
   The resolver's reason enum has only three values
   (`ambiguous_runner_up` | `low_tier` | `medium_name_only`). The A.6
   narrative was a colloquial summary that didn't reflect a stored value.
   Bucket totals account for the full 1054 with the three real values
   (980 NULL + 42 low_tier + 29 medium_name_only + 3 ambiguous_runner_up).

3. **15 dedup-unblocked rows total, not 5.** The 5 expected from A.6
   (1955/1982/2001/2017/2195) confirmed. Phase 1 surfaced 10 additional
   dedup-unblocked rows with identical mechanical pattern (same scraped_name
   appearing in two pending rows scoring identically against two canonical
   operators that A.6 then merged). Of those 10:
   - 8 are FAA-source big-brand cases (Flexjet, JetRight, Wheels Up,
     NetJets, Tradewind) with score ≥ 0.85 — went to Phase 2.5.
   - 2 are weaker matches (omr#121 AB Jets at 0.6425, omr#157 ATI Jet
     at 0.6187) — known/likely-wrong attachments, deferred to LLM ER.

---

## Phase 2 results (14 unique rows)

### Dedup-unblocked (5)

| omr | scraped_name | source | → surviving canonical_name |
|--:|---|---|---|
| 1955 | JetRight Aerospace Holdings, LLC | faa | JetRight |
| 1982 | Flexjet, LLC | faa | Flexjet |
| 2001 | Tradewind Aviation, LLC | faa | Tradewind Aviation |
| 2017 | NetJets Aviation, Inc. | faa | NetJets Aviation |
| 2195 | THRIVE AVIATION | faa | Thrive Aviation |

`match_method='auto_resolved_post_dedup'`, `match_confidence='high'`.

### Normalize-match (9, omr#2195 already in dedup-unblocked)

| omr | scraped_name | source | → surviving canonical_name |
|--:|---|---|---|
| 132 | Executive Jet Management | wyvern | Executive Jet Management |
| 159 | Aviation Charters, Inc. | wyvern | AVIATION CHARTERS, INC. |
| 171 | Flight Level Services LLC | wyvern | FLIGHT LEVEL SERVICES LLC |
| 188 | Scott Richard Aviation Services, Inc. | wyvern | SCOTT RICHARD AVIATION SERVICES, INC. |
| 301 | PORT TOWNSEND AIR LLC | faa | Port Townsend Air LLC |
| 1417 | Flight Program Operations | faa | FLIGHT PROGRAM OPERATIONS |
| 1578 | Thrive Aviation | faa | Thrive Aviation |
| 1607 | Wings Air Charter, LLC | faa | WINGS AIR CHARTER, LLC |
| 1620 | Let's Jett Inc. | faa | Let's Jett Inc. |

`match_method='auto_resolved_post_normalize_match'`, `match_confidence='exact'`.

---

## Phase 2.5 results (6 high-score FAA dedup-unblocked, score ≥ 0.85 gate)

| omr | scraped_name | score | → surviving canonical_name |
|--:|---|--:|---|
| 1414 | Flexjet, LLC | 0.9167 | Flexjet |
| 1480 | JetRight Aerospace Holdings, LLC | 0.85 | JetRight |
| 1504 | Wheels Up Partners LLC | 0.8818 | Wheels Up |
| 1506 | NetJets Aviation, Inc. | 0.9454 | NetJets Aviation |
| 1579 | Tradewind Aviation, LLC | 0.9565 | Tradewind Aviation |
| 1602 | Wheels Up Private Jets LLC | 0.8692 | Wheels Up |

`match_method='auto_resolved_post_dedup'`, `match_confidence='high'`,
`match_evidence.gate_pass='score >= 0.85'`.

The score ≥ 0.85 gate is intentional and validated against the
**Tradewind Charter LLC case** (omr#1580, score 0.8476). That row is a
confirmed rebrand event per April 2026 labeling — Tradewind Charter LLC
was the 2001 original legal entity name, rebranded to the unified
Tradewind Aviation brand. Below the gate is correct: low resolver score
reflects real complexity (rebrand event, not name dissimilarity), which
deserves Stage 5 `operator_events` structural treatment rather than a
flat alias attach.

This becomes a documented rule for Phase 7's LLM ER design doc:
**at score < 0.85, mechanical auto-resolve doesn't fire even when dedup
unblocks.** The threshold preserves structural events for the Stage 5
landing zone.

---

## Reviewer-note-only (3 rows kept in 'pending' for LLM ER)

| omr | reason for deferral |
|--:|---|
| 121 | Score 0.6425 < 0.85 mechanical gate. AB Jets has no canonical row — likely needs `new_operator` resolution. |
| 157 | Score 0.6187 < 0.85 mechanical gate. Verified should match ATI JET INC (id `3373eb66-ee16-48f4-8b6c-3c55d4f850e4`), not Tavaero Jet Charter Corporation. |
| 1580 | Score 0.8476 < 0.85 mechanical gate. Confirmed rebrand event per April 2026 labeling — Tradewind Charter LLC was 2001 original legal entity name, rebranded to Tradewind Aviation brand. Reserved for Phase 7 LLM ER pass + Stage 5 `operator_events` structural treatment. |

Each row's full reasoning lives in `operator_match_review.reviewer_notes`
verbatim, so LLM ER can read the audit trail and skip these from
"pending" if it sees the note pattern.

---

## Cumulative state diff

| metric | pre-A.7 | post-A.7 | Δ |
|---|--:|--:|--:|
| `operator_match_review[status='pending']` | 1054 | 1034 | −20 |
| `operator_match_review[status='matched']` (with our match_methods) | 0 | 20 | +20 |
| `operator_identities` rows with `match_evidence.method='phase_2_omr_reprocess_2026_05_06'` | 0 | 20 | +20 |
| `operator_match_review[status='pending']` rows with reviewer_notes set | unchanged + 3 | unchanged + 3 | (3 note-only deltas) |

20 INSERT + UPDATE pairs landed under per-row transactions (one
BEGIN/COMMIT per row). No conflicts on the (source, source_id) UNIQUE
index. No regression in `npm test` (486 pass / 8 skipped, identical to
pre-A.7).

The 351 LLM ER queue (`operator_llm_er_checkpoint`) is unchanged — Phase
2/2.5 only touched the omr review queue, not the LLM ER queue.

---

## Followups (carried forward)

### Open from this session

- **Phase 3 — Triage 471 NULL-typed operators.** Next session (A.8 candidate).
  ~3 hr. Read-only decomposition by source mix + cert relationship + name
  pattern. No tagging until gate review.
- **Phase 4 — Mechanical type tagging** of buckets approved in Phase 3 gate.
  ~2 hr.
- **Phase 5-6 — Stage 5 schema scaffolding** (brand_groups +
  operator_brand_membership + brand_membership_pending +
  operator_event_pending; existing `canonical.operator_events` reused
  as-is). Apply via `npm run db:migrate-pg`. ~2-2.5 hr combined.
- **Phase 7 — LLM ER design doc**. ~2 hr. Document the score < 0.85
  mechanical gate rule. Decide whether prompt produces `billing_reroute` /
  `shell_mask` event types (would propose ALTER on
  `canonical.operator_events` CHECK as session pre-flight).

### Carried over from A.6 (still open)

- **Old direct-connect Supabase password rotation** — exposed in mid-A.6
  diagnostic. URL host no longer resolves but the password should still
  be rotated when convenient.
- **Extend dedup script to 5 additional FK columns** —
  `canonical.operator_holds_certificate_pending.resolved_to_operator_id`
  and `canonical.operator_events.{predecessor_id, successor_id,
  primary_operator_id, other_party_id}`. Once Phase 5 lands, also add
  `canonical.operator_event_pending.{predecessor_id, successor_id,
  primary_operator_id, other_party_id, resolved_to_event_id}` to the
  list. Surfaces loudly via FK RESTRICT violation when next dedup runs.

### Surfaced this session

- **Older omr writers don't set `_resolver_reason`.** 980 / 1054 rows
  have NULL stored reason. This isn't urgent — the Phase 1 classifier
  works without it — but a future cleanup could either (a) backfill
  reason from candidate_matches structure, or (b) update the older
  writers to set `_resolver_reason`. Not on Path A's critical path.
- **omr#157 should match ATI JET INC, not Tavaero.** The current
  resolver scoring picks Tavaero as the top candidate (0.6187) for
  scraped_name "ATI Jet Executive Charter". This is the same class of
  bug A.6 addressed for big-brand operators — the resolver's pre-filter
  + scoring isn't differentiating well at low tiers. LLM ER will
  resolve omr#157 specifically; the underlying scoring weakness is
  Stage 9+ work.

---

## Operational notes

### Score gate 0.85 — design rationale

The 0.85 threshold for Phase 2.5 mechanical auto-resolve isn't arbitrary.
Three independent validations:

- The 5 Phase 2 dedup-unblocked rows from A.6 doc all sit at score 0.85
  or higher (lowest is 1955 JetRight at 0.85). The gate keeps them in.
- The 6 Phase 2.5 high-confidence rows surfaced by Phase 1 sit at score
  0.85+ — distribution is 0.85 / 0.8692 / 0.8818 / 0.9167 / 0.9454 /
  0.9565. All are big-brand FAA-source matches with low ambiguity.
- The 3 below-gate cases each have a clear non-mechanical reason for
  the low score: omr#121 has no canonical row (needs new_operator),
  omr#157 has a known wrong attachment, omr#1580 is a confirmed rebrand
  event needing structural treatment. Their low scores are signal,
  not noise.

The Phase 7 design doc encodes this rule formally: "score < 0.85 means
the resolver was uncertain, and dedup didn't add new information — it
just removed the runner-up. Mechanically committing to the remaining
match would ratify uncertainty as truth." Validated against the
Tradewind Charter LLC case as a real example of "below the gate" being
the correct threshold.

### No connectivity issues

Unlike A.6, the Supabase pooler URL stayed up throughout A.7. All work
landed under the post-A.6 pooler hostname.
