# Session A.5 — Phase 2 results (2026-05-05)

**Date**: 2026-05-05
**Time**: started ~14:00 Chicago, Phase 2 closed early evening (~3 focused hours after pre-flight)
**Status**: Phase 2 closed at the four commits below. Phases 3–4 unblocked, deferred to next session.
**Plan**: `/Users/phelipehonesto/.claude/plans/peppy-roaming-babbage.md` (Path A diff-and-apply — supersedes the original §Phase 2 "bump SOURCE constant" framing in `docs/plans/session-a5-may1-ingest-execution.md`).

---

## What landed today

Four commits on `main`, all pushed to origin:

1. **Script 1** — `scripts/promote-canonical-certificates-from-d085-may1.ts`. Read May 1 xlsx, INSERT 29 new cert designators under `source='faa_d085_2026_05_01'`. Existing 1,960 canonical.certificates rows untouched. 1,791 new identity rows record May 1 attestation under the new source slug.
2. **Script 2** — `scripts/diff-canonical-aircraft-on-certificate-from-d085-may1.ts`. Path A close-then-insert against 11,129 existing open windows: 9,911 no-op, 1,218 closed, 1,426 inserted under new source, 56 to aocp sidecar.
3. **Script 3** — `scripts/diff-canonical-operator-holds-certificate-from-d085-may1.ts`. Two-tier matching (Tier 1 deterministic, Tier 2 resolver+gates from Step 2c.6 Item 2, Tier 3 sidecar). Against 1,454 open ohc rows (108 `faa_d085` + 1,346 `faa_d085_seed`): 1,371 no-op, 33+50 closed, 66 inserted, 293 to omr review, 44 to ohcp sidecar.
4. **Close-out doc** — this file.

## Path A vs the original plan

The original `docs/plans/session-a5-may1-ingest-execution.md` §Phase 2 prescribed "edit the SOURCE constant in three existing backfill scripts to `faa_d085_2026_05`, re-run." Schema audit at the top of this session showed that strategy was blocked by:

1. UNIQUE on `canonical.certificates(faa_cert_number)` — `INSERT INTO canonical.certificates` in the existing script has no `ON CONFLICT`, would throw on the 1,960 existing certs.
2. EXCLUDE on `canonical.aircraft_on_certificate (aircraft_id, cert_id, daterange)` — source is NOT in the EXCLUDE.
3. EXCLUDE on `canonical.operator_holds_certificate (operator_id, cert_id, role, daterange)` — same.

Path A (compare-and-delta, close-then-insert per `docs/temporal-link-pattern.md` Rule 2) replaced the constant-bump approach. Three new scripts, narrower in scope (single-snapshot diff vs. full 13-snapshot aggregation rebuild), source slug `faa_d085_2026_05_01` becomes meaningful provenance for the May-1-driven changes rather than a parallel audit trail.

## Cumulative state

| Table | Before | After | Δ |
|---|---|---|---|
| `canonical.certificates` (cert_authority=faa) | 1,960 | 1,989 | +29 (Script 1) |
| `canonical.certificate_identities[faa_d085_2026_05_01]` | 0 | 1,791 | new audit trail |
| `canonical.certificate_identities[faa_d085]` | 1,960 | 1,960 | unchanged |
| `aoc` total rows | 14,924 | 16,350 | +1,426 inserts |
| `aoc` open windows | 11,129 | 11,337 | +1,426 − 1,218 = +208 net |
| `aoc[faa_d085]` open | 11,129 | 9,911 | −1,218 (Case 2) |
| `aoc[faa_d085_2026_05_01]` open | 0 | 1,426 | +1,426 (Case 3) |
| `aocp[faa_d085_2026_05_01]` | 0 | 56 | tail_not_in_canonical_aircraft |
| `ohc` open total | 1,454 | 1,437 | −17 net |
| `ohc[faa_d085]` open | 108 | 96 | −12 closed |
| `ohc[faa_d085_seed]` open | 1,346 | 1,275 | −71 closed |
| `ohc[faa_d085_2026_05_01]` open | 0 | 66 | +66 (Case 3) |
| `ohcp[faa_d085_2026_05_01]` | 0 | 44 | Tier 3 sidecar |
| `omr[step2c_2026_05_01]` | 0 | 293 | review-tier triage queue |

## EXCLUDE sanity — clean

Post-Phase 2 verification queries returned:
- 0 dupe-open pairs in `canonical.aircraft_on_certificate WHERE valid_to IS NULL`
- 0 dupe-open triples in `canonical.operator_holds_certificate WHERE valid_to IS NULL`

The EXCLUDE constraints (`aircraft_on_certificate_no_overlap`, `operator_holds_certificate_no_overlap`) held throughout — both scripts' Case 3 INSERTs were by-construction outside any existing open window for the same `(aircraft, cert)` or `(operator, cert, role)`, and Case 2 closes preceded any new INSERTs.

## Tier-1 hit rate (ohc deterministic match)

1,393 / 1,791 = **77.8%** of May 1 (cert × holder) pairs matched at Tier 1 (deterministic exact, normalized via `UPPER(REGEXP_REPLACE(TRIM(name), '\s+', ' '))`). The remaining 22.2% routed through:
- Tier 2 high (post-gates): 44 (2.5%) — small typo / suffix differences ("ELEVATE AVIATION LLC" → "ELEVATED AVIATION LLC", "Textron Aviation Inc." → "Textron Aviation")
- Tier 2 review: 310 (17.3%) — gate-tightening downgrades (`gap < 0.15` or load-bearing-noun mismatch)
- Tier 3 no_match: 44 (2.5%)

Resolver pass for 1,791 candidates against 1,947 operators completed in 0.3s (in-memory pre-filter, no DB roundtrips per call).

## Followups surfaced (not blocking Phase 2 close)

- **Wheels Up subsidiaries unresolved**. Both `WHEELS UP PRIVATE JETS LLC` and `WHEELS UP PARTNERS LLC` landed in Tier 3 sidecar (ohcp). Neither has a canonical operator under those exact names. Worth a curation pass when Step 5 corroboration adds the parent/subsidiary mapping; for now they're surfaced via `canonical.operator_holds_certificate_pending WHERE source='faa_d085_2026_05_01'`.

- **17 review rows skipped by Script 3**. Tier 2 review-tier rows are routed to `public.operator_match_review` only when the cert isn't already covered by an open ohc (avoids duplicating Case 1 context). 17 of the 310 review-tier rows had a cert already covered by `faa_d085_seed` and were silently skipped. Consider an `corroborated_by` annotation pattern on the existing seed rows in future runs so the May 1 review evidence isn't lost — not blocking, but worth queueing.

- **MIL2ATP, INC. (HBCA cert)** flagged in Script 1 dry-run as an unusual operator name; ended up in Tier 3 sidecar (ohcp). May be a flight-training provider recently certified for Part 135. Worth a sanity check during omr triage to confirm whether the cert→operator mapping should be added to canonical.

- **Sample 7SSA × N575AG behavior post-Phase-2**: aoc untouched (Case 1 from `faa_d085`), ohc closed (Case 2 — May 1's "Sunset Aviation LLC" went to Tier 2 review due to gap-downgrade against "Sunset Aviation"). The existing `faa_d085` ohc was closed without a Case 3 replacement; the omr row holds it for human triage. This is the gate-tightening doing its job — the false-positive prevention catches legitimate matches with similar siblings, which is the documented tradeoff. Acceptable cost; review queue triage is a separate workstream.

## Phase 3/4 status

**Phase 3 (type-tag operators)**: unblocked. The new ohc rows under `source='faa_d085_2026_05_01'` (66 high-confidence matches) plus the existing `faa_d085_seed` cohort give the type-tag UPDATE script (`scripts/type-tag-operators-from-faa-p135-2026-05.ts` — to be written) a clean source filter. Expected SC-1 floor reachable per exec doc §Phase 3 (≥1,750 operators typed `part_135` at confidence ≥0.95). Defer to next session.

**Phase 4 (cert-bridge re-run + SC-1/2/3/4 measurement)**: unblocked. `scripts/backfill-operator-aircraft-link-from-cert-bridge.ts` should be re-run with run-id `track1_session_a5_may1_cert_bridge_<UTC-timestamp>` per the exec doc. NOT EXISTS pre-filter and EXCLUDE-violation try/catch are pre-existing from Session A's 2,052-row run. Defer to next session.

## Reflection

Pre-flight discipline paid for itself again. The original "bump SOURCE constant and re-run" framing in the exec doc would have failed at three independent schema-level constraints — UNIQUE on certs, EXCLUDE on aoc, EXCLUDE on ohc. Catching all three before any `--write` ran (via `pg_constraint` introspection + EXPLAIN tests) prevented a botched run that would have either thrown immediately on the first INSERT or silently introduced duplicate-overlap state.

Path A is more script work (~700 lines new code across three scripts) than the original "edit constants, re-run existing" plan, but it's the correct architecture per `docs/temporal-link-pattern.md` Rule 2 — temporal tables are append-only, relationship changes are close-then-insert, source is provenance not partitioning. The new scripts are also cleaner-scoped: they read one xlsx and diff against current canonical, vs. the existing scripts' full 13-snapshot aggregation rebuild. Future weekly D085 runs can re-use these three scripts unchanged with just a date constant update.

The two-tier ER architecture in Script 3 (deterministic Tier 1 → resolver+gates Tier 2 → sidecar Tier 3) is reusable for any future single-snapshot ingest. 77.8% Tier-1 hit rate confirms most cert-to-operator mappings are byte-stable across the FAA's snapshots; the resolver only fires on the 22.2% that exhibit genuine variation (typo, suffix change, ambiguous candidate set).

## Resumption protocol for next session

Per `docs/plans/session-a5-operators-rebuild.md` §8.10 (resumption from a stop gate):

1. Read this file (`docs/sessions/2026-05-05-session-a5-phase-2-results.md`).
2. Phases 3–4 are unstarted; Phase 2 closed at the close-out commit on top of the three Phase 2 script commits.
3. Light pre-flight before Phase 3:
   - `git status` expects clean modulo `.work/`.
   - `git log --oneline -10` expects four Phase 2 commits + Phase 1 close-out commit + Phase 1 ingest commit on top.
   - psql verify Phase 2's canonical state intact:
     - `canonical.aircraft_on_certificate WHERE source='faa_d085_2026_05_01' AND valid_to IS NULL` → 1,426 rows.
     - `canonical.operator_holds_certificate WHERE source='faa_d085_2026_05_01' AND valid_to IS NULL` → 66 rows.
     - `canonical.operator_holds_certificate_pending WHERE source='faa_d085_2026_05_01'` → 44 rows.
     - `public.operator_match_review WHERE scraped_payload->>'step'='step2c_2026_05_01'` → 293 rows.
4. Propose Phase 3 plan (UPDATE-driven type-tag of the 1,908 NULL-typed operators against May 1 `faa_d085_2026_05_01` ohc matches, preserving Session A's `faa_d085_seed` baseline) and stop for approval.

End of day.
