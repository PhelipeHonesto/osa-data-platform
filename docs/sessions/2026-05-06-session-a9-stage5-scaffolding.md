# Session A.9 — Stage 5 schema scaffolding (Phase 5 + 6) (2026-05-06)

**Date**: 2026-05-06 (same-day continuation after A.8)
**Status**: Phases 5 + 6 closed. Session A.9 complete.
**Plan**: `/Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md` (Path A — Stage 2 close-out before LLM ER)
**Predecessor**: `docs/sessions/2026-05-06-session-a8-close-out.md`

---

## What landed

Two commits on `main`:

1. **Phase 5 — schema scaffolding** — `53d4321`. Four files / 526 lines:
   - NEW `schema/canonical/brand_groups.sql` bundling 3 tables
     (`canonical.brand_groups` + `canonical.operator_brand_membership` +
     `canonical.brand_membership_pending`)
   - EDIT `schema/canonical/operator_events.sql` appending
     `canonical.operator_event_pending` (bundling pattern from
     `certificates.sql` to keep the FK to `operator_events` ahead of
     pending in alphabetical-load order)
   - NEW `schema/rollback/2026-05-06-001-canonical-brand-groups-rollback.sql`
   - NEW `schema/rollback/2026-05-06-002-canonical-operator-event-pending-rollback.sql`

2. **Phase 6 — verification** — this session doc. No code/schema changes
   in this commit; the Phase 6 work was applying the Phase 5 schema via
   `npm run db:migrate-pg` and verifying via `psql` + negative INSERT tests
   per CLAUDE.md §4 three-step rule.

---

## Phase 5 design notes

### One spec deviation: bundling instead of separate file

The parent plan said create `schema/canonical/operator_event_pending.sql`
as a separate file. Alphabetical sort would put
`operator_event_pending.sql` BEFORE `operator_events.sql`, breaking the
FK to `operator_events.event_id` at load time. The `certificates.sql`
precedent solved exactly this problem by bundling 8 tables in dependency
order. I followed that precedent: appended `operator_event_pending` into
`operator_events.sql`. Approved at gate.

### CHECK constraint shape on `brand_membership_pending`

User's gate spec asked for the bilateral-AND-OR shape:
```sql
CHECK (
  (operator_id IS NOT NULL OR operator_name_normalized IS NOT NULL)
  AND
  (brand_group_id IS NOT NULL OR brand_name_normalized IS NOT NULL)
)
```

I wrote it as TWO separate table-level CHECKs:
```sql
CHECK (operator_id IS NOT NULL OR operator_name_normalized IS NOT NULL),
CHECK (brand_group_id IS NOT NULL OR brand_name_normalized IS NOT NULL),
```

Functionally identical (PG implicitly ANDs multiple CHECK constraints),
with cleaner error diagnostics — the constraint that fails (check1 vs
check2) tells you which side was empty without parsing the message.
Approved at gate.

### Extra hot-path index

Added a fourth index on `operator_brand_membership` beyond the three the
spec listed:
```sql
CREATE INDEX idx_operator_brand_membership_role_current
  ON canonical.operator_brand_membership (brand_group_id, role)
  WHERE valid_to IS NULL;
```

Hot path for "subsidiaries of brand X today" queries (charter brokerage
use case). Index maintenance cost negligible at LLM-ER write frequency.
Approved at gate.

---

## Phase 6 verification (CLAUDE.md §4 three-step rule)

### Step 1: Local Docker Postgres up → down → up

Spun up `postgres:16` container on port 55432. Created prereqs
(`btree_gist` extension, `canonical` schema, `public.operators` stub).
Then:

1. Apply `schema/canonical/operator_events.sql` (with bundled
   `operator_event_pending`) — 11 CREATE statements.
2. Apply `schema/canonical/brand_groups.sql` — 17 CREATE statements
   including the EXCLUDE constraint.
3. Verify 5 canonical tables present (4 new + existing operator_events).
4. Apply rollback `2026-05-06-001` — 3 DROPs (brand_membership_pending →
   operator_brand_membership → brand_groups).
5. Apply rollback `2026-05-06-002` — 1 DROP (operator_event_pending).
6. Verify 1 canonical table remains (operator_events untouched).
7. Re-apply both schema files — all CREATEs succeed (idempotent).
8. Verify 5 canonical tables present again.
9. Re-apply schema files A SECOND TIME — all "relation already exists"
   notices, no errors.

Up → down → up cycle clean. Tear down with `docker stop pg-stage5-test`.

### Step 2: `npm run db:migrate-pg` against Supabase

Exit 0. `[migrate-pg] All 71 declared tables verified.` (was 67
pre-Phase-6, +4 new tables.)

All 4 new tables visible in the verified-tables list:
- `canonical.brand_groups`
- `canonical.brand_membership_pending`
- `canonical.operator_brand_membership`
- `canonical.operator_event_pending`

### Step 3: Production verification via `psql \d+`

`describe-schema` MCP tool doesn't see the canonical schema, so direct
psql for each new table. All four pass full structural verification —
column shapes, indexes (including partial indexes and the EXCLUDE
constraint), CHECK constraints, FK directions all match the schema files
verbatim.

Spot-checks:

- `canonical.brand_groups`:
  - `UNIQUE (brand_name_normalized)` ✓
  - `idx_brand_groups_current` partial WHERE valid_to IS NULL ✓
  - FK `primary_operator_id → public.operators(id)` ✓
  - 18 columns total

- `canonical.operator_brand_membership`:
  - **`operator_brand_membership_no_overlap`** EXCLUDE USING gist
    (operator_id WITH =, brand_group_id WITH =, role WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&) ✓
  - 5 indexes (4 standard + role_current partial) ✓
  - role enum: parent / subsidiary / sister / divested / dba_only ✓

- `canonical.brand_membership_pending`:
  - 6 CHECK constraints (timestamps, bilateral identifier presence ×2,
    paired resolved fields, reason enum, role enum) ✓
  - Both bilateral-AND-OR CHECKs distinct (check1, check2) ✓

- `canonical.operator_event_pending`:
  - Column-for-column copy of operator_events ✓ (28 columns)
  - 4 FKs to operators(id) for predecessor/successor/primary/other_party ✓
  - 1 FK to canonical.operator_events(event_id) for resolved_to_event_id ✓
  - 11 indexes (mirroring operator_events plus pending-specific) ✓

### Step 4: Negative INSERT tests (production, transactionally rolled back)

5 tests run via `BEGIN; INSERT ...; ROLLBACK;`. All 5 rejected with the
expected constraint error:

| test | rejection |
|------|-----------|
| brand_membership_pending both sides NULL | check1 (operator side) |
| operator_event_pending resolved_at without resolved_to_event_id | check1 (paired NULL/NOT-NULL) |
| operator_event_pending invalid event_type='bogus' | event_type_check |
| brand_groups invalid valid_to ≤ valid_from | brand_groups_check |
| brand_membership_pending reason='invalid_reason_value' | reason_check |

Local Docker also tested:
- operator_brand_membership overlapping windows on same (op, brand,
  'subsidiary') → EXCLUDE rejects ✓
- operator_brand_membership different role for same op+brand at
  overlapping time → ACCEPTS (correct — EXCLUDE keys role) ✓
- brand_groups duplicate brand_name_normalized → UNIQUE rejects ✓

### Step 5: Confirm 0 rows in all 4 new tables

```
 brand_groups | operator_brand_membership | brand_membership_pending | operator_event_pending
--------------+---------------------------+--------------------------+------------------------
            0 |                         0 |                        0 |                      0
```

Clean scaffolding, no test data leaked from Docker → production.

---

## Cumulative state diff (post-A.9)

| metric                                 | post-A.8 | post-A.9 |  Δ |
|----------------------------------------|---------:|---------:|---:|
| Production tables (migrate-pg verified)|       67 |       71 | +4 |
| canonical.* tables                     |       12 |       16 | +4 |
| operators total / tagged / NULL        | 1937 / 1615 / 317 | 1937 / 1615 / 317 | 0 |
| omr pending                            |    1,034 |    1,034 |  0 |
| Tests                                  | 486 ✓    | 486 ✓    |  0 |

Phase 5+6 added schema only — no data writes, no test changes, no app
code changes. The 4 new tables are empty on arrival, ready for Phase 7
LLM ER design + Session B's actual LLM ER pass.

---

## Followups (carried forward)

### Surfaced in A.9

1. **Extend `scripts/dedup-operator-rows.ts` FK list.** Per the gate
   followup: when an operator is dedup'd, the script must update FK
   columns in the new tables before DELETE. Add to the list:
   - `canonical.operator_event_pending.predecessor_id`
   - `canonical.operator_event_pending.successor_id`
   - `canonical.operator_event_pending.primary_operator_id`
   - `canonical.operator_event_pending.other_party_id`
   - `canonical.operator_event_pending.resolved_to_event_id`
     (when the merge target's resolved row is the loser)
   - `canonical.operator_brand_membership.operator_id`
   - `canonical.brand_membership_pending.operator_id`
   - `canonical.brand_membership_pending.brand_group_id`
     (when merging brand_groups, future)
   - `canonical.brand_groups.primary_operator_id`
   - `canonical.brand_membership_pending.resolved_to_brand_group_id`

   The dedup script's FK list was 5 columns post-A.8; now should be
   ~13–15. The script will FK RESTRICT loudly when it matters; this is
   defensive cleanup, not a blocker.

### Carried over from A.8 (still open)

- Silver Air + Solairus missing canonical certs (defer to LLM ER pass).
- Pre-2026-05-01 ohc close-date clusters (recurring ingestion bug).
- Wisconsin Aviation 2-ohc edge case.
- 980 NULL-reason omr rows backfill (A.7 followup).
- Resolver scoring weakness at low tiers (omr#157 ATI Jet — Stage 9+).

### Carried over from A.6 (still open)

- Old direct-connect Supabase password rotation.
- Wheels Up subsidiary curation.

---

## Path A status after A.9

| phase | description | session | status |
|------:|-------------|---------|--------|
| 1 | Decompose omr | A.7 | ✓ done |
| 2 + 2.5 | Auto-resolve 20 mechanical | A.7 | ✓ done |
| 3 + follow-ups | Triage 471 NULL-typed | A.8 | ✓ done |
| 4a | Re-open + tag (154 mechanical) | A.8 | ✓ done |
| 4b | LLM ER queue routing for 317 | (in Phase 7 + Session B) | pending |
| 5 | Stage 5 schema scaffolding | A.9 | ✓ done |
| 6 | Apply schema | A.9 | ✓ done |
| 7 | LLM ER design doc | A.10 | pending |

After A.10's LLM ER design doc lands, **Session B** runs the actual LLM
ER pass against the 351 LLM ER queue + the 317 NULL-typed deferrals from
A.8. The landing zone is ready.

---

## What this session did NOT do

- Did NOT populate any of the 4 new tables (empty on arrival; population
  is Phase 7 + Session B).
- Did NOT modify any app code (TS, tests).
- Did NOT touch `canonical.operator_events` table data — only appended
  the new pending sidecar to its DDL file.
- Did NOT extend the dedup script (followup logged for next session).
- Did NOT propose ALTER on `canonical.operator_events` CHECK enum
  (deferred to Phase 7's design doc — depends on whether the LLM ER
  prompt naturally produces `billing_reroute` / `shell_mask` events).
- Did NOT touch the omr review queue, the LLM ER queue, or any
  operator_type writes.
