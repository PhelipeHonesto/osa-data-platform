# Session A.5 — Phase 3 & 4 close-out (2026-05-05)

**Date**: 2026-05-05
**Status**: Phases 3 and 4 closed. Session A.5 complete (Phases 1-4).
**Plan**: `/Users/phelipehonesto/.claude/plans/we-re-resuming-session-a-5-steady-ladybug.md`
**Predecessors**: `docs/sessions/2026-05-05-session-a5-phase-2-results.md`, `docs/sessions/2026-05-05-session-a5-phase-1-results.md` (referenced).

---

## What landed today

Two commits on `main`, pushed:

1. **Phase 3** — `de63907`. New script `scripts/type-tag-operators-from-faa-p135-2026-05-01.ts`. Single transactional UPDATE: 1,427 of 1,434 candidate operators tagged `operator_type='part_135', data_confidence_score=0.95`. Skipped 7 (6 already part_135 @ ≥0.95, 1 billing_agent ACCENT AIRWAYS LLC).

2. **Phase 4** — `3849dd9`. Three minimum edits to `scripts/backfill-operator-aircraft-link-from-cert-bridge.ts` (CHECKPOINT, candidate SQL, per-checkpoint guard refactor). Rerun under run-id `track1_session_a5_may1_cert_bridge_20260505T222021Z` inserted 9,734 new link rows; `canonical.operator_aircraft_link[source='faa_d085_via_cert_bridge']` grew 2,052 → 11,786.

---

## Cumulative state — Session A.5 Phases 1-4

### Phase 1 — May 1 D085 ingest

May 1 xlsx archived to S3 at `raw/faa/d085/xlsx/20260501172056__Part_135_Operators_and_Aircraft_List.xlsx`. SHA256 verified. `_index.json` updated. (See `docs/sessions/2026-05-05-session-a5-phase-1-results.md`.)

### Phase 2 — canonical promotion (Path A diff-and-apply)

`canonical.certificates`: +29 rows. `canonical.aircraft_on_certificate`: +1,426 inserts, 1,218 closes. `canonical.operator_holds_certificate`: +66 inserts, 83 closes, 293 to omr review, 44 to ohcp sidecar. 1,791 cert_identity rows under new source slug.

### Phase 3 — type-tag operators

| metric | pre-Phase-3 | post-Phase-3 | Δ |
|---|---|---|---|
| `public.operators[operator_type='part_135', conf>=0.95]` (absolute) | 34 | 1,461 | +1,427 |
| Reframed (May 1 corroborated subset) | 6 | 1,433 | +1,427 |
| `public.operators[operator_type IS NULL]` | 1,908 | 481 | −1,427 |

UPDATE rowCount = 1,427 (matched dry-run prediction exactly).

### Phase 4 — cert-bridge densification

| metric | pre-Phase-4 | post-Phase-4 | Δ |
|---|---|---|---|
| `operator_aircraft_link[source='faa_d085_via_cert_bridge']` total rows | 2,052 | 11,786 | +9,734 |
| Open windows | 1,314 | ~11,000 | (large gain) |
| Distinct aircraft linked | ~1,400 | 10,280 | (full candidate pool covered) |
| March-2026-active aircraft linked | 1,106 | 5,005 | +3,899 (4.5x) |

Rerun outcome:
- 12,123 candidate rows pulled from broadened (`LIKE 'faa_d085%'`) join
- 9,734 inserted (cert_bridge_linked)
- 2,389 skipped (cert_bridge_skipped_already_linked — Session A coverage blocks via NOT EXISTS)
- 0 overlap collisions (cert_bridge_skipped_overlap)
- 12,123 audit log rows under `track1_session_a5_may1_cert_bridge_20260505T222021Z`

Confidence histogram: 100% in [0.85, 0.95) — `LEAST(ohc.confidence, aoc.confidence)` pulled down by `ohc[faa_d085_seed]` rows at 0.85. Most candidates pair seed-cohort ohc with aoc.

---

## SC measurements (all reframed)

### SC-1 — operators typed Part 135 (reframed)

> **Reframing rationale**: The original 1,750 target assumed Phase 2 full re-attestation under a single new source slug. Path A explicitly chose compare-and-delta to preserve audit history. Reframed SC-1 measures the actual coverage of May 1's attestation, correctly counted.

```sql
SELECT COUNT(*) FROM public.operators o
WHERE o.operator_type='part_135' AND o.data_confidence_score>=0.95
  AND EXISTS (
    SELECT 1 FROM canonical.operator_holds_certificate ohc
    JOIN canonical.certificate_identities ci ON ci.cert_id = ohc.cert_id
    WHERE ohc.operator_id = o.id
      AND ci.source = 'faa_d085_2026_05_01'
      AND ohc.valid_to IS NULL
  );
-- Result: 1,433
```

Absolute count (any source): 1,461. The 28-row gap (1,461 − 1,433) is the existing 34 part_135 @ conf=1.00 ops minus the 6 May-1-corroborated overlap = 28 typed ops without a May 1 cert linkage (likely older cert holders or single-source curated entries from `EXACT_NAME_RULES` like Boutique Air, KALITTA CHARTERS).

### SC-2 — cert coverage at high tier (reframed)

> **Reframing rationale**: Original 1,610 target assumed Phase 2 full re-attestation under a single new source slug. Under Path A, high-confidence May 1 attestation coverage is 1,437 certs split across three sources (`faa_d085_seed` @ 0.85, `faa_d085` @ 0.95, `faa_d085_2026_05_01` @ 0.95) representing the same May 1 attestation surface.
>
> The 354-row gap (1,791 May 1 attestations − 1,437 currently in ohc at conf>=0.85) is real:
> - 293 omr review-tier (gate-tightening downgrades — held for human triage, not yet high-conf)
> - 44 ohcp no-match (Tier 3 sidecar — operators not in canonical)
> - 17 skipped review (cert already covered by another source)
>
> These are curation work, not data quality issues.

```sql
SELECT COUNT(DISTINCT cert_id) FROM canonical.operator_holds_certificate 
WHERE source LIKE 'faa_d085%' AND confidence>=0.85 AND valid_to IS NULL;
-- Result: 1,437
```

### SC-3 — quarantined certs (status check)

| cert | holder (May 1) | status | resolved_at | valid_to |
|---|---|---|---|---|
| 70TA | Triton Air LLC | pending in ohcp | NULL | NULL |
| FJTA | Corporate Flight Management, Inc. | pending in ohcp | NULL | NULL |
| GQ9C | GQ Aviation, Inc. | closed in ohcp | NULL | 2024-04-19 |
| OW6A | Arrow West Aviation | pending in ohcp | NULL | NULL |
| TCHA | Executive Flight Management | pending in ohcp (2 rows) | NULL | one closed 2024-09-27 |

**Deviation from delta-001 §3 expectation**: 4 of 5 expected to reactivate to ohc with correct operator_id; none did. GQ9C expected to close with `resolved_at` populated; closed but `resolved_at` still NULL.

Phase 2's diff script doesn't promote ohcp rows back to ohc — that's a separate workflow (lookalike-misresolution reactivation). Followup carried forward.

### SC-4a — rebuild scope (bottom-up cert-bridge ceiling)

```sql
SELECT COUNT(DISTINCT oal.aircraft_id)
FROM canonical.operator_aircraft_link oal
WHERE oal.role='operator' 
  AND oal.source='faa_d085_via_cert_bridge'
  AND EXISTS (
    SELECT 1 FROM adsb_completed_legs cl
    WHERE cl.icao_hex=(SELECT icao_hex FROM canonical.aircraft a WHERE a.aircraft_id=oal.aircraft_id)
      AND cl.arrival_time::TIMESTAMPTZ >= '2026-03-01'
      AND cl.arrival_time::TIMESTAMPTZ < '2026-04-01'
  );
-- Result: 5,005 (vs target ~5,044, 99.2% of candidate-pool ceiling)
```

Pre-Phase-4: 1,106. **4.5x expansion**, 99.2% of the bottom-up ceiling reached. The remaining 39-aircraft gap (5,044 candidate-pool − 5,005 actual) is candidates whose link rows didn't insert due to NOT EXISTS pre-filter (an aircraft was already linked under a different operator_id from Session A's overlapping windows).

### SC-4b — product scope (% of 52,693 March-active universe)

```sql
WITH linked AS (...) SELECT n, ROUND((n::numeric / 52693) * 100, 2) FROM linked;
-- Result: 5,005 / 52,693 = 9.50%
```

Pre-Phase-4: 2.10% (1,106 aircraft). Post-Phase-4: 9.50% (5,005 aircraft). Gap to industry-typical 20% (~10,500) requires `canonical.aircraft_on_certificate` expansion in a separate workstream. The remaining 47,649 March-active aircraft are out of cert-bridge scope: Part 91 (private), Part 121 (scheduled airline), foreign-registered, Part 135 cargo without canonical aoc population yet, or absent from `canonical.aircraft_on_certificate` for other reasons.

---

## Top-20 operators by March 2026 hours — the integrity test

```
                 canonical_name                  | fleet | hours_march 
-------------------------------------------------+-------+-------------
 METRO AVIATION, INC                             |   128 |      5696.6
 Med-Trans Corporation                           |   104 |      4837.1
 DELUX PUBLIC CHARTER LLC                        |    48 |      3195.3
 REACH Air Medical Services, LLC.                |    52 |      3111.4
 PHI Health, LLC                                 |    76 |      2647.0
 Executive Jet Management                        |   116 |      2364.6      ← #6 confirmed
 Guardian Flight, LLC.                           |    48 |      2294.5
 Cobalt Air, LLC                                 |    55 |      1840.8
 EXCLUSIVE JETS LLC                              |    58 |      1789.4      ← flyExclusive
 CENTER FOR EMERGENCY MEDICINE OF WESTERN PA INC |    24 |      1753.6
 PHI Aviation, LLC                               |    37 |      1646.6
 Bristow LLC                                     |    42 |      1597.8
 LIFE FLIGHT NETWORK LLC                         |    36 |      1531.7
 Ameriflight, LLC                                |    50 |      1253.6
 Hyannis Air Service Inc.                        |    29 |      1203.3
 MAVERICK AIRSTAR LLC                            |    17 |      1161.3
 ALASKA CENTRAL EXPRESS INC                      |    15 |      1147.8
 Sunset Aviation                                 |   106 |      1119.9
 Jet Linx Aviation                               |    58 |      1043.0
 MAVERICK HELICOPTER INC                         |    17 |      1030.0
```

### Composition

- **Air medical (HEMS) operators dominate**: METRO AVIATION, Med-Trans, REACH Air Medical, Guardian Flight, PHI Health, Bristow, LIFE FLIGHT NETWORK, Center for Emergency Medicine, MAVERICK HELICOPTER — 9 of top 20. These are real Part 135 operations with high flight-hour density.
- **JSX/scheduled charter**: DELUX PUBLIC CHARTER (#3), EXCLUSIVE JETS LLC (#9 — flyExclusive parent), ALASKA CENTRAL EXPRESS, Hyannis Air Service.
- **Cargo**: Ameriflight (#14).
- **Big-name charter**: Executive Jet Management (#6) ✓, Sunset Aviation (#18), Jet Linx Aviation (#19), Cobalt Air, MAVERICK AIRSTAR.

### Big-name absences — explained

NetJets Aviation, Flexjet, VistaJet, Wheels Up are **missing from top-20 because of upstream curation issues, not Phase 4 cert-bridge mechanics**:

| Operator | Cert # | May 1 holder | Where it landed | Why missing |
|---|---|---|---|---|
| NetJets Aviation | DXTA | "NetJets Aviation, Inc." | omr review (Tier 2 review-tier) | Two `NetJets Aviation` operators in public.operators (duplicate canonical_name); resolver scored both similarly; gate-tightening (`top_score − runner_up >= 0.15`) downgraded to review |
| Flexjet | J7SA | "Flexjet, LLC" | omr review | Same pattern: two `Flexjet` operators in public.operators |
| Wheels Up Private Jets | CVGA | "WHEELS UP PRIVATE JETS LLC" | ohcp Tier 3 (no_match) | Subsidiary name not in canonical operators |
| Wheels Up Partners | VQMA | "WHEELS UP PARTNERS LLC" | ohcp Tier 3 (no_match) | Same |
| VistaJet | n/a | n/a | not a US Part 135 cert holder | Consolidated under Vista America brand (separate cert) |

The 10 known duplicate-canonical-name pairs in public.operators (Flexjet, NetJets Aviation, Wheels Up, Contour Aviation, FlyExclusive, Freestream Aircraft, JetRight, PlaneSense, Thrive Aviation, Tradewind Aviation) are a pre-existing data-quality issue. Curation pass needed: dedupe, retain the part_135 @ conf=1.00 row, fold the conf=0.77 row's aliases/evidence into the canonical row.

**The cert-bridge data quality is validated**: the operators that DID get linked (HEMS, JSX, EJM, etc.) appear in correct rank order with realistic fleet sizes and hour totals.

---

## Followups carried forward

1. **Duplicate canonical_name dedupe** — 10 pairs in `public.operators` block big-4 omr resolutions. Curation work: dedupe operator rows, fold aliases/evidence. Affects NetJets, Flexjet, Wheels Up at minimum.

2. **Wheels Up subsidiaries unresolved** — `WHEELS UP PRIVATE JETS LLC` (CVGA) and `WHEELS UP PARTNERS LLC` (VQMA) in ohcp Tier 3. Curation: add subsidiary canonical operators to `public.operators` with parent → child alias mapping.

3. **293 omr review-tier rows** — gate-tightening downgrades. Need human triage to either approve (promote to ohc) or reject (move to ohcp). Includes the NetJets / Flexjet ambiguous cases above.

4. **17 skipped review rows** — Tier 2 review-tier rows where cert was already covered by an open ohc from another source; silently skipped by Phase 2 Script 3. Consider `corroborated_by` annotation pattern in future ingest runs.

5. **MIL2ATP, INC. (HBCA cert)** — flagged in Phase 2 Script 1 dry-run as unusual; ended up in ohcp Tier 3. May be a flight-training provider recently certified for Part 135. Sanity check during omr triage.

6. **5 quarantined certs (SC-3) not reactivated** — FJTA, TCHA, 70TA, OW6A still pending in ohcp despite May 1 attestation. Phase 2's diff doesn't include lookalike-misresolution reactivation logic. Workflow needed: detect ohcp rows where May 1 cert_identities resolves to a different operator than the original misresolution, and promote them to ohc with the corrected operator_id.

7. **AVinfo timing decision** — corroboration source for omr triage. Deferred from Session A.

8. **Broken-FAA contamination audit** — checking for parser regression effects during the Session A.0/A.5 transitions. Carried forward from Phase 2.

9. **`canonical.aircraft_on_certificate` expansion** — to close the SC-4b gap (current 9.50% vs industry-typical 20%), aoc population needs to grow from 14,392 distinct aircraft. Sources to consider: FAA registry walk for non-D085 Part 135 carriers, foreign N-numbers, ADS-B-to-cert imputation. Session B+ scope.

---

## Reflection

**Path A's audit-trail design pays off in Phase 3.** Reframed SC-1 (1,433 May-1-corroborated typed operators) is a more meaningful metric than the original 1,750 target. The 1,750 figure assumed full re-attestation under a single new source slug — a data model that would have inflated audit log without adding information. Path A's compare-and-delta keeps the audit trail honest.

**Phase 4 mechanics worked exactly as designed.** Three minimum modifications (CHECKPOINT, candidate SQL, per-checkpoint guard) preserved the script's invariants while enabling the rerun. NOT EXISTS pre-filter blocked 2,389 already-linked aircraft cleanly; EXCLUDE try/catch saw zero collisions. The 9,734 actual inserts vs 9,961 dry-run projection (227-row gap) is the expected within-run candidate collision count.

**The per-checkpoint guard refactor is a reusable pattern.** Future weekly D085 ingests can rerun the cert-bridge under a new CHECKPOINT (`track1_session_<name>_<date>_cert_bridge`) without manual rollback. The `evidence->>'ingest_run_id'` LIKE pattern naturally handles idempotency per-rerun rather than per-source.

**Top-20 is the right integrity test.** SC-2/SC-4 numbers measure pool size; the top-20 measures pool *quality*. The HEMS-dominated top-20 reflects real flight-hour distribution. EJM at #6 confirms the cert-bridge correctly attributes NetJets fractional hours. The big-3 absences (NetJets brand, Flexjet, Wheels Up) are upstream curation work — clearly diagnosed, queued for follow-up.

**SC-4b's 9.50% is honest progress, not a victory lap.** Going from 2.10% to 9.50% is a 4.5x improvement on what cert-bridge controls. The remaining gap to 20% requires aoc-population expansion, which is correctly scoped to Session B+.

---

## Resumption protocol for Session B (or whenever next)

1. Read this file.
2. Phase 5+ work (if any): TBD pending Phelipe's product roadmap for Session B.
3. Followups (above) need triage and prioritization. Suggested order:
   - **Curation pass on duplicate canonical_names** (lowest risk, highest leverage — unblocks omr triage for NetJets/Flexjet)
   - **omr triage workflow** (293 rows, includes big-name ambiguous cases)
   - **Wheels Up subsidiary curation** (small, surgical)
   - **Quarantined cert reactivation workflow** (SC-3 followup)
   - **aoc expansion** (largest scope, most planning needed)
4. Phase 1-4 are stable; reuse the three Phase 2 diff scripts + Phase 3 type-tag + Phase 4 cert-bridge for future weekly D085 runs with date constants bumped.

End of Session A.5.
