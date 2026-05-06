# Session A.6 — Operator canonical_name deduplication

**Date**: 2026-05-05 (file dated 2026-05-06 per session naming agreed up front).
**Branch**: `main`. Two commits landed: `17f17f4` (script extension) and
`cca34da` (defensive UNIQUE index migration).

## Context

End-of-A.5 top-20 sanity check showed NetJets Aviation, Flexjet, and Wheels
Up missing from the leaderboard despite their cert-bridge attribution being
in place. Cause: 10 duplicate `canonical_name` rows in `public.operators` —
each pair was the part_135 / `data_confidence_score=1.00` row from the
2026-04-13 `faa_operators_realfleet_merge` alongside an earlier conf
0.71-0.83 / `operator_type=NULL` row created on 2026-04-10 / 04-19 by
`faa_cert_direct` / `self_creation` / `name_fuzzy`. The cert-bridge backfill
attached `operator_aircraft_link` rows to whichever id was canonical at write
time, so the resolver saw the holder name mapping to two ids, fell through
to Tier 2, and gate-tightening downgraded both to review (the candidates
scored identically because they were the same string).

Fix: collapse each pair into the part_135 winner, repoint references, lock
the door against recurrence with a defensive UNIQUE index.

## What landed

### Script extension (commit `17f17f4`)

`scripts/dedup-operator-rows.ts` already had the right shape for public-schema
dedup but didn't touch the canonical schema. Three UPDATE statements added to
`dedupTransaction`, before the operators DELETE:

- `canonical.operator_holds_certificate` (FK ON DELETE RESTRICT)
- `canonical.operator_aircraft_link` (FK ON DELETE RESTRICT)
- `canonical.operator_aircraft_resolution_log` (FK ON DELETE SET NULL)

Without these, the operators DELETE would FK-violate (RESTRICT) or null-out
the resolution_log row's link to the merged-out operator. The dry-run preview
was extended to show the three new counts; the integration test now seeds
canonical-schema rows on merge and asserts they end up on keep with no
orphans at the merge id. Test suite green: 489 / 489.

Five additional FK columns documented as a known gap (all 0 rows in prod
today, would block the operators DELETE if a future merge target hits them):
- `canonical.operator_holds_certificate_pending.resolved_to_operator_id`
- `canonical.operator_events.{predecessor_id, successor_id, primary_operator_id, other_party_id}`

### 10 dedupes — impact-ordered

| #  | canonical_name      | winner.oal | identities moved | resolution_log moved |
|----|---------------------|-----------:|-----------------:|---------------------:|
| 1  | NetJets Aviation    |        109 |                1 |                    0 |
| 2  | Flexjet             |         54 |                1 |                    1 |
| 3  | Wheels Up           |          4 |                1 |                    1 |
| 4  | JetRight            |          7 |                1 |                    0 |
| 5  | Contour Aviation    |          5 |                1 |                    0 |
| 6  | FlyExclusive        |          1 |                2 |                    0 |
| 7  | Freestream Aircraft |          0 |                1 |                    0 |
| 8  | PlaneSense          |          0 |                1 |                    0 |
| 9  | Thrive Aviation     |          0 |                1 |                    0 |
| 10 | Tradewind Aviation  |          0 |                2 |                    0 |

FlyExclusive and Tradewind moved 2 identities each because the merge side had
both `faa` and `wyvern` rows; the survivors gained a wyvern source.

Two of three "missing" brands were restored to top-20 immediately after #3:

- **#2 NetJets Aviation** — 5,874.8 hrs, 105 fleet
- **#7 Flexjet** — 2,710.9 hrs, 54 fleet
- **Wheels Up** — still not in top-20. Only 4 `operator_aircraft_link` rows
  point at the surviving Wheels Up id; the brand's actual fleet sits under
  subsidiary canonical names (DELUX PUBLIC CHARTER is #4 with 3,557.8 hrs).
  Wheels Up subsidiary curation is on the A.5 followup list and does NOT
  belong to A.6.

### Defensive UNIQUE index (commit `cca34da`)

`schema/migrations/2026-05-05-001-operators-canonical-name-unique-idx.sql`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS operators_canonical_name_normalized_uidx
  ON public.operators (
    LOWER(TRIM(REGEXP_REPLACE(canonical_name, '\s+', ' ', 'g')))
  );
```

`LOWER` kills case differences. `TRIM` strips leading/trailing whitespace.
`REGEXP_REPLACE` collapses internal whitespace runs. Together: a future
writer cannot insert "NetJets Aviation" alongside "netjets aviation" or
" Wheels  Up " alongside "Wheels Up".

CLAUDE.md §4 three-step rule:

1. ✅ Validation via `BEGIN; CREATE UNIQUE INDEX ...; ROLLBACK;` against
   prod. Proved DDL syntax is valid AND no current data violates the
   constraint (1,937 rows, 0 conflicts).
2. ✅ `npm run db:migrate-pg` — exit 0, all 67 declared tables verified.
3. ✅ Prod verification:
   - `pg_indexes` shows the index with the correct expression
   - `\d+ public.operators` shows it as UNIQUE on the table
   - Negative test: `INSERT 'netjets aviation'` fails with
     `duplicate key value violates unique constraint
     "operators_canonical_name_normalized_uidx"`

## Cumulative state diff

| Metric                                       | Pre-A.6 | Post-A.6 | Δ   |
|----------------------------------------------|--------:|---------:|----:|
| `public.operators` total                     |   1,947 |    1,937 | -10 |
| `public.operators` `operator_type=part_135`  |   1,461 |    1,461 |   0 |
| `public.operators` `operator_type IS NULL`   |     481 |      471 | -10 |
| Duplicate `canonical_name` pairs             |      10 |        0 | -10 |
| `omr` queue total / pending                  |    1054 |     1054 |   0 |

Operator counts move as expected: every dedup removed exactly one NULL-typed
loser; every part_135 winner survived. The trust-scores recompute (which
runs after each `--commit`) shifted the 10 winners' `data_confidence_score`
from a hand-set 1.00 down to a calculated value (typically ~0.76) reflecting
single-source `cross_source_agreement`. This is existing
`compute-operator-trust-scores.ts` behavior, not a regression introduced by
A.6.

## Top-20 leaderboard (March 2026 hours)

```
                 canonical_name                  | fleet | hours_march 
-------------------------------------------------+-------+-------------
 METRO AVIATION, INC                             |   134 |      6089.3
 NetJets Aviation                                |   105 |      5874.8   ← restored
 Med-Trans Corporation                           |   107 |      4899.1
 DELUX PUBLIC CHARTER LLC                        |    53 |      3557.8
 REACH Air Medical Services, LLC.                |    52 |      3111.6
 Executive Jet Management                        |   141 |      2726.3
 Flexjet                                         |    54 |      2710.9   ← restored
 PHI Health,LLC                                  |    78 |      2678.4
 Guardian Flight, LLC.                           |    51 |      2277.0
 Hyannis Air Service Inc.                        |    53 |      2212.8
 Cobalt Air, LLC                                 |    60 |      1978.0
 EXCLUSIVE JETS LLC                              |    57 |      1852.7
 CENTER FOR EMERGENCY MEDICINE OF WESTERN PA INC |    22 |      1736.0
 Bristow LLC                                     |    45 |      1695.7
 PHI Aviation, LLC                               |    36 |      1644.3
 LIFE FLIGHT NETWORK LLC                         |    39 |      1602.5
 Ameriflight, LLC                                |    50 |      1253.6
 MAVERICK AIRSTAR LLC                            |    17 |      1161.2
 ALASKA CENTRAL EXPRESS INC                      |    15 |      1147.8
 Advanced Air LLC                                |    17 |      1131.6
```

## omr review queue — auto-resolvable post-dedup

10 of the 1,054 pending review rows have a `scraped_name` that exactly
matches a current canonical_name under the new normalization (LOWER + TRIM
+ collapse internal whitespace). These should auto-resolve cleanly on the
next resolver run. Not auto-resolved this session — surface for visibility.

The 293 step2c_2026_05_01 rows from the A.5 close-out break down as
129 `medium_name_only` + 84 `low_tier` + 71 `ambiguous_runner_up` + 9
`gate_downgrade`. Of those, **5** would auto-resolve cleanly post-dedup —
all 5 are `ambiguous_runner_up` cases where the runner-up was a deduped
loser (omr ids 1955 JetRight, 1982 Flexjet, 2001 Tradewind, 2017 NetJets,
2195 Thrive — each had two candidates with identical scores, one of which
no longer exists). The remaining 288 are genuine entity resolution work
that need LLM ER or human triage, not a resolver re-run.

## Operational notes

### Mid-session connectivity break

Between dedupes #8 (PlaneSense, committed) and #9 (Thrive Aviation, dry-run
attempt), the Supabase project's direct-connect hostname
`db.lirsgmgckyshgtkdpdpa.supabase.co` started returning NXDOMAIN at every
resolver tested. Project had migrated to a pooler URL
(`aws-1-us-east-1.pooler.supabase.com`); `.env` was updated mid-session and
work resumed cleanly. Ground-truth check confirmed the 8 pre-break dedupes
landed and only Thrive + Tradewind remained.

### Secret leak in transcript

A diagnostic command run during the connectivity debug exposed the old
direct-connect database password in plaintext via `od -c` and `cut -c1-80`.
That URL host no longer resolves, but the password should be rotated when
convenient. Future debug commands should redact post-`@` portions before
showing byte-level dumps.

## Followups (carried forward)

- **471 NULL-typed operators remaining** — typing pass via cert /
  cross-source attestation. Session A.7 candidate.
- **omr review reprocess** — ~5 of the 293 step2c_2026_05_01 rows would
  auto-resolve post-dedup (5 `ambiguous_runner_up` cases where the
  runner-up was a deduped loser). The remaining 288 are genuine entity
  resolution work — 129 `medium_name_only` + 84 `low_tier` + 66 genuinely
  ambiguous + 9 `gate_downgrade` — and need LLM ER or human triage, not
  a resolver re-run.
- **Wheels Up subsidiary curation** — fleet attribution sits under DELUX
  PUBLIC CHARTER and other subsidiary canonical_names. Not on A.6 path.
- **Source pipeline fix** — the loader on 2026-04-10 / 04-19 inserted
  operator rows with `match_method` ∈ {`faa_cert_direct`, `self_creation`,
  `name_fuzzy`} without normalize-and-match against existing canonical
  names. Source likely lives in `src/entity-resolution/` or
  `src/ingestion/operators/`. The new UNIQUE index blocks the symptom; a
  code fix prevents the work-around (entire-string different
  source_id but same normalized canonical_name should hit the existing
  operator, not insert a new one).
  **Resolved 2026-05-06 (Session A.7, commit `fe9fc17`)**: two unsafe
  paths confirmed (`operator-resolver.ts` writeNew using
  `match_method='self_creation'`, and `backfill-operators-canonical-faa.ts`
  bulkInsertBatch using `match_method='faa_cert_direct'`); both now run a
  pre-INSERT SELECT against the same `LOWER(TRIM(REGEXP_REPLACE(...)))`
  expression as the UNIQUE index and attach an `operator_identities` row
  to the existing operator on hit. New `match_method` values
  `'name_normalized_match'` and `'faa_cert_normalized_match'` distinguish
  the merge path. Defensive only — no scheduled cron invokes either
  loader today; the change keeps the next manual re-run from 23505-ing.
- **Extend dedup script to the 5 additional FK columns** — only a problem
  the next time we dedup an operator that has rows in
  `operator_holds_certificate_pending`, `operator_events.predecessor_id`,
  `operator_events.successor_id`, `operator_events.primary_operator_id`,
  or `operator_events.other_party_id`. The DELETE will surface the gap
  loudly (FK RESTRICT violation) when it matters.
