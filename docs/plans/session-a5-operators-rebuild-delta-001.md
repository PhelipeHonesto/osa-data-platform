# Plan delta 001 — pre-flight findings

**Date**: 2026-05-05
**Original plan**: `docs/plans/session-a5-operators-rebuild.md` (commit `33b623d`)
**Trigger**: §8 pre-flight checklist surfaced state-vs-plan drift before Step 0 started.

---

## Summary

The original plan's premise of "3,848 polluted aircraft-owner rows in `public.operators`" doesn't match current database state. Pre-flight categorization revealed that the 1,908 NULL-typed rows are deliberately-staged D085-attested operator candidates from Stage 2c.5 Phase 1 (commit `c2c0464`, 2026-04-25), with `match_method='self_creation_d085_seed'` and `data_confidence_score=0.70` — explicitly awaiting Two-Source Rule corroboration.

The May 1 FAA Part 135 file ingestion **is** that corroboration. The plan's structural shape (8 steps, gates, SC-1 ≥1,750 target) holds, but the execution mechanics shift from INSERT-and-migrate to UPDATE-on-match.

---

## State as found at pre-flight (2026-05-05 17:47 UTC)

### `public.operators` total

- **1,947 rows total** (not the plan's "~3,898")
- **34** typed as `part_135`
- **1,908** with `operator_type IS NULL`
- 1 each: `defunct`, `billing_agent`, `foreign_aoc`, `financier`, `broker`

### `public.operators` schema

- Column `certificate_number` referenced by plan §4.4 SC SQL **does not exist**.
- Columns present: `id, canonical_name, type_tags, headquarters_icao, data_confidence_score, first_seen_at, last_updated_at, schema_version, operator_trust_score, operator_type, icao_callsign`.
- Columns to add per plan migration 003 (`last_seen_source`, `last_seen_at`) are not yet present — migration 003 still applies as written.

### Provenance of the 1,908 NULL-typed rows

`first_seen_at::date` distribution on the full 1,947 operators:

| Day | Count | Source / commit |
|---|---:|---|
| 2026-04-10 | 50 | Phase 1 calibration follow-ups |
| 2026-04-13 | 34 | Curated mid-tier merge (`bf7abf2`) |
| 2026-04-19 | 220 | (mixed Phase 1 work) |
| **2026-04-25** | **1,643** | **Stage 2c.5 Phase 1 D085 expansion (`c2c0464`)** |

The `c2c0464` commit body confirms: *"public.operators: 304 → 1,947 (+1,643 new)"*. The 1,643 cohort came from `canonical.operator_holds_certificate_pending` (rows where `resolved_at IS NULL` and `source='faa_d085'`), grouped by `holder_name_normalized`. Each became one operator + identity + OHC row. Identity `match_method='self_creation_d085_seed'`, confidence 0.70 — explicitly "single-source D085-derived, awaiting Phase 2 Two-Source Rule corroboration."

DB confirmation: `SELECT COUNT(*) FROM public.operator_identities WHERE source='faa' AND match_method='self_creation_d085_seed'` returns **1,643**.

### Bucket categorization of the 1,908 NULL-typed rows

Per the bucket definitions established at pre-flight (see §8.2 of original plan):

- **Real** (has identity AND name not `^N[0-9]+[A-Z]{0,2}$`): **1,908** (100%)
- **Polluted (tail-shaped)** (name matches registration pattern OR equals known canonical.aircraft tail): **0**
- **Ambiguous** (no identity OR not registration-shaped): **0**
- **Edge case** (has identity AND tail-shaped): **0**

Suffix breakdown of the 1,908: 808 LLC, 742 Inc, 277 no-suffix, 45 Corp, 18 Ltd, 15 Co, 2 LLP, 1 LP. Pseudo-tail-as-LLC pattern (`^[A-Z0-9]{4,8}( LLC| INC| TRUST| LP| CORP)$`): 26 names. Of those 26, only **1 (`429LD LLC`)** has tail-correlation evidence (token `429LD` → tail `N429LD` exists in `canonical.aircraft`); the other 25 are real-charter-brand-shaped names (`LUXAIR LLC`, `JETEX LLC`, `VERIJET INC`, etc.).

Identity sources for the 1,908:

| Sources | Count |
|---|---:|
| faa | 1,674 |
| wyvern | 197 |
| faa, wyvern | 16 |
| argus | 16 |
| argus, wyvern | 5 |

89% have FAA-attested identity; 11% (218) come from Wyvern/Argus subject-paid audits (Tier E per `docs/data-sources.md` — enrichment-only).

Aircraft attribution: 107 of 1,908 (5.6%) have rows in `canonical.operator_aircraft_link`; 1,801 (94.4%) have none.

### Other Session A artifacts (unchanged from plan)

- `canonical.operator_holds_certificate WHERE source='faa_d085' AND confidence=0.95`: 115 rows ✓
- `canonical.operator_holds_certificate_pending WHERE evidence->>'audit_run_id'='A.0-2026-05-04'`: 6 rows ✓
- `canonical.operator_aircraft_link WHERE role='operator' AND source='faa_d085_via_cert_bridge'`: 2,052 rows ✓
- `public.operator_llm_er_checkpoint` status: 351 queued + 1 completed
- Total `operator_identities`: 1,976 (1,731 faa + 223 wyvern + 22 argus)

---

## Sections amended

### §1 Done state — amended

**Original**: "1,789 real Part 135 operators, polluted rows segregated to `aircraft_owners` table."

**Amended**: 1,789 holder names from May 1 file resolve against the existing 1,908 D085-staged candidates. Match → UPDATE `operator_type='part_135'`, raise `data_confidence_score` from 0.70 → 0.95. No-match → INSERT new row. Existing rows that don't appear on May 1 stay NULL-typed (likely Part 91K, Part 121, or defunct — addressed by future ingesters per six-entity discipline).

### §1 SC-1 — amended

**Original**: "≥1,750 rows where `operator_type='part_135'` AND `last_seen_source LIKE 'faa_d085%'`"

**Amended**: same target, but measurement query changes:

```sql
SELECT COUNT(*) FROM public.operators
WHERE operator_type='part_135'
  AND data_confidence_score >= 0.95
  AND last_seen_source LIKE 'faa_d085%';
```

The `data_confidence_score >= 0.95` filter ensures the count reflects rows that received the May 1 corroboration uplift (from 0.70 → 0.95), not rows that were already typed before. Rows that came in pre-typed at 1.00 (e.g., the 26 realfleet operators from `f211b5a`) also qualify.

### §3.4.2 Phase B — amended

**Original**: "INSERT one row per unique `operator_name_normalized` not already present."

**Amended** — two-pass logic:

**Pass 1 (UPDATE)**: For each May 1 holder name, find matching existing operator by normalized name. UPDATE: `operator_type='part_135'`, `last_seen_source='faa_d085_2026_05_01'`, `last_seen_at=NOW()`, `data_confidence_score=0.95` (was 0.70).

```sql
UPDATE public.operators o
SET operator_type='part_135',
    last_seen_source='faa_d085_2026_05_01',
    last_seen_at=NOW(),
    data_confidence_score=0.95,
    last_updated_at=NOW()
FROM silver.faa_p135_oa_list_normalized s
WHERE s.snapshot_id=:latest_snapshot_id
  AND UPPER(REGEXP_REPLACE(o.canonical_name, '[[:space:]]+', ' ', 'g'))
      = s.operator_name_normalized
  AND (o.operator_type IS NULL OR o.operator_type = 'part_135');
```

**Pass 2 (INSERT)**: For May 1 holder names with no match in `public.operators`, INSERT new row + `operator_identities` row with `match_method='faa_p135_list_2026_05_direct'`, `source='faa'`, confidence 0.95.

```sql
INSERT INTO public.operators (canonical_name, operator_type, data_confidence_score,
                              last_seen_source, last_seen_at)
SELECT DISTINCT s.operator_name, 'part_135', 0.95,
       'faa_d085_2026_05_01', NOW()
FROM silver.faa_p135_oa_list_normalized s
WHERE s.snapshot_id=:latest_snapshot_id
  AND s.operator_name_normalized NOT IN (
    SELECT UPPER(REGEXP_REPLACE(canonical_name, '[[:space:]]+', ' ', 'g'))
    FROM public.operators
  );
```

**Expected match rate**: ≥85% UPDATE, ≤15% INSERT. The 1,643 D085-seed cohort plus ~218 earlier-cohort rows give strong overlap with the 1,789 May 1 holder names — both populations originated from FAA cert-holder data. Any May 1 name that doesn't match is genuinely new (cert issued or operator renamed since the Apr 25 D085 snapshot).

### §3.6 Polluted rows decision — REMOVED

The polluted-rows premise doesn't hold. No block of 3,848 polluted rows exists in `public.operators`. Migration 004 (`public.aircraft_owners`) is removed from the migration sequence. May be re-introduced later as future infrastructure if pollution surfaces, but is not gating this rebuild.

### §4.4 Step 4 — REMOVED (no-op)

Step 4 (polluted-rows migration with FK pre-flight audit) is removed. To preserve cross-references throughout the plan (Step 5 references "after Step 4 approved" gates, etc.), Step 4 stays as a numbered position marked **"no-op, deferred to future plan if needed"**. The remaining critical path is Steps 0, 1, 2, 3, (4 no-op), 5, 6, 7. Subsequent steps' gates reference "after Step 3 approved" instead of "after Step 4 approved" — gate text adjusts accordingly when execution reaches each step.

### §3.8 Migrations — amended

Migration 004 (`aircraft_owners`) removed from the sequence.

**Final migration list**:
- 001 (bronze schema + bronze.faa_p135_oa_list_* tables)
- 002 (silver.faa_p135_oa_list_normalized)
- 003 (operators last_seen_source / last_seen_at columns)
- 005 (operator_match_review review_type column)
- 006 (canonical.operator_avinfo_snapshot)

**Total: 5 migrations, not 6.**

Migration 004 number is intentionally left as a gap (not renumbered) so the original plan's migration sequence stays cross-referenceable. The gap itself is the artifact of this delta.

### §6.1 Step time estimates — amended

Step 4 removed: −4 to −15 hours from CP total.

| Step | Estimate (hrs) |
|---|---:|
| 0 | 3–5 |
| 1 | 8–12 |
| 2 | 5–7 |
| 3 | 14–22 |
| ~~4~~ | **0** (no-op) |
| 5 | 6–9 |
| 6 | 3–4 |
| 7 | 10–18 |
| **CP total** | **49–77** (was 53–94) |

**New realistic median calendar**: 9–13 weeks (was 11–15).

### §7 Unlocks — unchanged

The downstream unlocks don't depend on the polluted-rows mechanism. Section 7 stands as written.

---

## Sections unchanged

- **§2 Data sources** — the FAA Part 135 file, AVinfo.gov, S3 historical archives are all still the right inputs.
- **§5 Risk register** — R3 (multi-cert auto-merge) risk profile slightly reduced since the UPDATE path has different FP shape (UPDATE with byte-identical normalized name on existing rows is structurally lower-risk than INSERT-then-dedup), but R3 keeps. Other risks unchanged.
- **§8 Pre-flight checklist** — this delta is the artifact produced by running it. The checklist itself is unchanged; future plans inherit the pattern.

---

## Provenance

This delta exists because §8 pre-flight categorization caught the state-vs-plan drift before Step 0 started. The pattern is generalizable: plans drafted against memory or summary context can drift from current database state in ways that aren't visible until execution. Pre-flight queries against actual state are the inspection mechanism that catches this.

Specifically:

- Plan §1's "3,898 rows" figure likely came from a stale read of either (a) the upstream `faa_operators` raw table (which does have aircraft-owner pollution by design — that's the source surface where the cert-shape regex ran), or (b) a pre-Phase-1-hygiene snapshot of `public.operators`. Neither matches current state.
- The Stage 2c.5 Phase 1 commit (`c2c0464`, Apr 25) was the most recent operator-table mutation. It deliberately staged 1,643 D085-attested candidates with low confidence pending corroboration. The plan was drafted ~10 days later but didn't internalize this prior work's effect.
- Pre-flight §8.2 captured the state; bucket categorization (this conversation, 2026-05-05 PM) interpreted it; this delta is the correction.

The mechanism worked. The plan would have hit the missing `certificate_number` column at Step 4 execution and discovered the pollution-shape drift then — but pre-flight surfaced it earlier, when the cost of revision is cheap (one delta doc) instead of expensive (mid-execution pivot, partial migration state).
