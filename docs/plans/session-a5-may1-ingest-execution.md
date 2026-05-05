# Session A.5 — May 1 ingest execution

**Date**: 2026-05-05
**Status**: in execution
**Predecessors**: `session-a5-operators-rebuild.md` (33b623d), `session-a5-operators-rebuild-delta-001.md` (c50b494)
**Estimate**: 7–12 focused engineering hours
**No new migrations, no new schemas, no new tables.**

The original 35-page plan was scoped wrong against actual repo state (`docs/data-architecture.md`, `schema/silver/faa.sql`, existing `scripts/backfill-canonical-*-from-d085.ts`). This 1-page doc captures the right-sized work: one new ingester, three constant edits, one new UPDATE script, one cert-bridge re-run.

## Source-slug decision

`faa_d085_2026_05` for all new canonical writes from this run. Rationale:
- Preserves Session A's 115/6/2052 rows for audit comparison.
- Distinguishable provenance for downstream queries.
- Easy rollback: `DELETE WHERE source='faa_d085_2026_05'`.

If the May 1 run surfaces issues with Session A's existing rows (e.g., the lookalike-misresolution false positives bleeding into March hours), separate audit work follows — out of scope for this plan.

## Phases

### Phase 1 — fetch + archive (3–5 hrs)

1. New ingester `src/ingestion/faa-p135-list-fetch.ts`. HEAD-conditional-GET against `https://www.faa.gov/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_List.xlsx`. On change: write xlsx + manifest.json to `s3://osa-dumont-backup/raw/faa/d085/snapshots/<pageTs>/`; update `_index.json`. Mirrors `archive-faa-d085-wayback.ts` patterns. STANDARD storage class (~519 KB, < 100 MB threshold per `s3-storage-strategy.md`).
2. Folds in existing uncommitted parser updates (`src/utils/d085-parser.ts`) + tests (`tests/d085-parser.test.ts`).
3. **First production run is two-step**:
   - **(a) Dry-run mode** prints intended S3 writes (key, sha256, manifest contents, `_index.json` entry) and exits without writing. Phelipe reviews the dry-run output.
   - **(b) On approval, live run executes.** If anything goes wrong mid-write, document the partial S3 state in `docs/sessions/2026-05-05-may1-ingest-results.md` and clean up manually before retrying.
4. Verify: `_index.json` has new entry; `aws s3 ls` shows xlsx + manifest at expected key; sha256 in manifest matches recon (`b4989eddbbc90c2689c7696b7c61f9161d0050c8eb6f1bc0caea999298fa9633`).

### Phase 2 — canonical promotion (1–2 hrs)

Edit constants in three scripts to differentiate via source slug:

- `backfill-canonical-certificates-from-d085.ts`: bump `SOURCE` to `'faa_d085_2026_05'` (or equivalent if its current value differs).
- `backfill-canonical-aircraft-on-certificate-from-d085.ts`: same.
- `backfill-canonical-operator-holds-certificate-from-d085.ts`: bump `SOURCE='faa_d085'` → `'faa_d085_2026_05'`, `STEP_TAG='step2c'` → `'step2c_2026_05'`.

Re-run all three in `--write` mode. Session A's 115/6/2052 rows preserved.

### Phase 3 — type-tag operators (2–3 hrs)

New script `scripts/type-tag-operators-from-faa-p135-2026-05.ts`:

```sql
UPDATE public.operators
SET operator_type='part_135', data_confidence_score=0.95, last_updated_at=NOW()
WHERE id IN (
  SELECT operator_id FROM canonical.operator_holds_certificate
  WHERE source='faa_d085_2026_05' AND confidence>=0.95
)
  AND operator_type IS NULL AND data_confidence_score=0.70;
```

`--dry-run` (default) prints the count. `--write` commits inside a transaction with audit log row.

Expected match-rate band (recorded for verification):
- Floor: ≥146 INSERTs minimum (May 1 names not in current operators)
- Ceiling: ≤1,789 UPDATEs (every May 1 name resolves to existing)
- Realistic median: 1,500–1,700 UPDATEs + 100–300 INSERTs

### Phase 4 — cert-bridge + measurement (1–2 hrs)

1. Re-run `scripts/backfill-operator-aircraft-link-from-cert-bridge.ts --write`. Run-id encoded as `track1_session_a5_may1_cert_bridge_<UTC-timestamp>` so the audit log distinguishes this pass from Session A's `track6_step2d_cert_bridge_*` rows. NOT EXISTS pre-filter prevents duplicate `(operator_id, aircraft_id, role)` rows; EXCLUDE-violation try/catch handles overlapping temporal windows. Both patterns pre-existing from Session A's run.
2. Measure SC-1, SC-2, SC-3, SC-4 (queries below).
3. Write `docs/sessions/2026-05-05-may1-ingest-results.md` with measurements + top-20-operators-by-March-hours sanity check.

## Verification queries

**SC-1** (operators typed Part 135):
```sql
SELECT COUNT(*) FROM public.operators
WHERE operator_type='part_135' AND data_confidence_score>=0.95;
-- Target: ≥ 1,750
```

**SC-2** (cert coverage in ohc at high tier):
```sql
SELECT COUNT(DISTINCT cert_id) FROM canonical.operator_holds_certificate
WHERE source LIKE 'faa_d085%' AND confidence>=0.85;
-- Target: ≥ 1,610 (≥90% of 1,791)
```

**SC-3** (quarantined recovery — 5 specific certs):
```sql
SELECT cert_designator, evidence->>'audit_run_id' AS audit_run_id, valid_to, resolved_at
FROM canonical.operator_holds_certificate_pending
WHERE cert_designator IN ('FJTA','TCHA','70TA','OW6A','GQ9C');
-- FJTA/TCHA/70TA/OW6A: now reactivated to ohc with correct operator_id
-- GQ9C: closed with valid_to set, resolved_at populated
```

**SC-4** (cert-bridge coverage on March-active aircraft):
```sql
SELECT COUNT(DISTINCT oal.aircraft_id)
FROM canonical.operator_aircraft_link oal
WHERE oal.role='operator' AND oal.source='faa_d085_via_cert_bridge'
  AND EXISTS (
    SELECT 1 FROM adsb_completed_legs cl
    WHERE cl.icao_hex=(SELECT icao_hex FROM canonical.aircraft a WHERE a.aircraft_id=oal.aircraft_id)
      AND cl.completed_at::TIMESTAMPTZ >= '2026-03-01'
      AND cl.completed_at::TIMESTAMPTZ < '2026-04-01'
  );
-- Target: ≥ 10,500
```

**Top-20 sanity check** (per delta-001 §1):
NetJets, Flexjet, Executive Jet Management, Wheels Up, VistaJet should rank in top-10 by March 2026 hours.

## Stop conditions

- Phase 1 closes when first production run lands the May 1 xlsx in S3 and `_index.json` updates cleanly.
- Phase 2 closes when each promotion script reports its insert count + zero refused-if-populated abort.
- Phase 3 closes when SC-1 measurement query returns ≥1,750.
- Phase 4 closes when SC-4 measurement query returns ≥10,500 AND top-20 sanity check passes (NetJets et al. ranked in top-10).

Each phase has a stop gate before the next begins.

### Deferred follow-ups (not Phase 1 blocking)

- **pipeline_runs integration**: `src/ingestion/faa-p135-list-fetch.ts` currently logs to stdout only. Weekly cron job should write `pipeline_runs` rows for run history (status='no_change', 'source_unavailable', 'completed'). Defer to a small follow-up task; not blocking Phase 1.

- **Sha256-first idempotency check**: current idempotency uses `manifest.json` existence as the marker. If manifest were ever deleted but xlsx remained, the script would re-PUT unnecessarily. A `HeadObject` + sha256 comparison on the xlsx before refetching from FAA would optimize this. Not blocking; manifests don't typically disappear.

- **No-op exit message**: when re-running on unchanged file, surface a clearer "File unchanged since [Last-Modified]; no action taken" message in cron logs. Cosmetic.
