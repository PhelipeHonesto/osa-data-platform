# Temporal link pattern

**Status**: v0 — 2026-04-24
**Parent**: `docs/er-architecture-plan.md`
**First use**: `canonical.operator_aircraft_link` (Stage 2a, this plan)
**Migration**: `schema/canonical/operator_aircraft_link.sql`

---

## Why

The OSA ER graph has five canonical entities and many cross-entity relationships: operator ↔ aircraft, FBO ↔ operator, operator ↔ holding, person ↔ operator, aircraft ↔ airport. Each of these relationships **changes over time**. An aircraft changes operators. A management company changes the FBO it contracts with. A chief pilot leaves one Part 135 certificate and joins another. A Signature FBO gets sold from Blackstone to another PE firm.

Every one of these is a state change with a before and an after. If we model relationships as mutable columns or as plain link tables without temporal validity, we lose every historical attribution. NTSB reports reference operators at the incident date, not the current operator. DOT Part 295 filings reference the broker at the filing date. Every retrospective query — "who flew this hex in Q3 2024?", "which operator held this cert on the incident date?", "who owned this FBO when the runway incursion happened?" — requires the relationship as it was, not as it is.

The temporal link pattern is the answer. One shape, used everywhere.

## Canonical column shape

Every temporal link table in the `canonical` schema has these columns, in this order:

```sql
-- Identity
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

-- The two entities being linked. Column names reflect the entities.
<entity_a>_id UUID NOT NULL REFERENCES <schema>.<entity_a>(<pk>),
<entity_b>_id UUID NOT NULL REFERENCES <schema>.<entity_b>(<pk>),

-- Relationship discriminator. For tables that only express one kind of
-- link (e.g., fbo_operator_link), this can be omitted; for multi-role
-- tables (operator_aircraft_link with 7 roles), it's required.
role TEXT NOT NULL CHECK (role IN (<role-enum>)),

-- Temporal window
valid_from DATE NOT NULL,
valid_to DATE,                    -- NULL means "still current"

-- Provenance (same shape everywhere)
source TEXT NOT NULL,             -- 'faa', 'sec_edgar', 'state_sos_de', 'manual', etc.
source_url TEXT,                  -- permalink where available
source_timestamp TIMESTAMPTZ,     -- when the source generated the claim
ingestion_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
confidence NUMERIC(3,2) NOT NULL DEFAULT 1.0
  CHECK (confidence >= 0.0 AND confidence <= 1.0),
match_method TEXT,                -- 'faa_registry_exact', 'fuzzy_name+serial', 'manual', etc.
evidence JSONB,                   -- source-specific payload pinning the claim

-- Cross-source agreement tracking (Two-Source Rule audit trail)
corroborated_by JSONB,            -- array of {source, source_url, source_timestamp, ingestion_date}
contradicted_by JSONB,            -- array of {source, source_url, source_timestamp, ingestion_date, conflict}

-- Schema lifecycle
first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
schema_version INTEGER NOT NULL DEFAULT 1
```

### Data types — hard rules

- **`valid_from` / `valid_to` are DATE, not TIMESTAMPTZ.** Relationships change on business days, not at sub-second precision. Using DATE avoids timezone ambiguity in "when did this operator take over." If a link genuinely needs sub-day precision (rare — aircraft crash-to-incident-response window), the `event_date` variant below uses TIMESTAMPTZ.
- **`valid_to = NULL` means "still current."** Not `9999-12-31`, not `'infinity'::date`. Queries for "current" use `WHERE valid_to IS NULL`.
- **`confidence` is NUMERIC(3,2)** to match `public.operators.data_confidence_score`. Range enforced 0.0–1.0.
- **`evidence`, `corroborated_by`, `contradicted_by` are JSONB**, not TEXT. They get indexed and queried.

### Index strategy — mandatory

Every temporal link table gets these indexes:

```sql
-- Per-entity history lookup
CREATE INDEX idx_<table>_<entity_a>_valid_from
  ON canonical.<table>(<entity_a>_id, valid_from);
CREATE INDEX idx_<table>_<entity_b>_valid_from
  ON canonical.<table>(<entity_b>_id, valid_from);

-- "Current state" query is the hot path — partial index makes it fast
CREATE INDEX idx_<table>_current
  ON canonical.<table>(<entity_a>_id, <entity_b>_id)
  WHERE valid_to IS NULL;

-- When role is present, include it in the current-state index
CREATE INDEX idx_<table>_current_by_role
  ON canonical.<table>(<entity_a>_id, role)
  WHERE valid_to IS NULL;
```

### Non-overlapping-windows constraint

Temporal tables enforce at most one open window per (entity, role) combination. Use a GiST exclusion constraint on the tstzrange composed from (valid_from, valid_to):

```sql
ALTER TABLE canonical.<table>
  ADD CONSTRAINT <table>_no_overlap
  EXCLUDE USING gist (
    <entity_a>_id WITH =,
    role          WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  );
```

Requires `btree_gist`. The extension is created in `schema/_extensions.sql`.

The exclusion constraint is non-negotiable. Without it, a bad backfill or a duplicate ingest can produce two simultaneous "operator" windows for the same aircraft, and every downstream query returns ambiguous results. Enforce at the DB, not in code.

## Write rules

### Rule 1 — temporal tables are append-only except for `valid_to`

Once a row exists, only `valid_to`, `last_updated_at`, `corroborated_by`, and `contradicted_by` may be UPDATEd. Everything else is immutable. Changing a relationship means a new row, not a mutation.

### Rule 2 — relationship changes are close-then-insert

```sql
BEGIN;

-- Close the current window
UPDATE canonical.operator_aircraft_link
   SET valid_to = '2026-04-15',
       last_updated_at = NOW()
 WHERE aircraft_id = :aircraft_id
   AND role = 'operator'
   AND valid_to IS NULL;

-- Open a new window
INSERT INTO canonical.operator_aircraft_link
  (operator_id, aircraft_id, role, valid_from, valid_to,
   source, source_url, source_timestamp, confidence, match_method, evidence)
VALUES
  (:new_operator_id, :aircraft_id, 'operator', '2026-04-16', NULL,
   'faa_registry_diff', :url, :ts, 0.95, 'hex_anchor_operator_change',
   :evidence_jsonb);

COMMIT;
```

Never `UPDATE ... SET operator_id = :new_op`. That erases history.

### Rule 3 — Two-Source Rule for entity-change events

Any INSERT that closes one window and opens another within the same aircraft+role requires evidence from at least two independent sources. Single-source claims land with `confidence < 0.70` and `source IN ('pending_claim_*')`; they stay in the table (not deleted) but agent-facing views filter them out until a second independent source corroborates.

The `corroborated_by` JSONB array is how that corroboration is recorded — append-only list of `{source, source_url, source_timestamp, ingestion_date}` entries.

Independence test: same publisher is one source. LLM aggregators collectively count as one source. See `docs/er-architecture-plan.md` §"Two-Source Rule."

### Rule 4 — contradictions never delete claims

If source A says "operator = X from 2024-01-01" and source B says "operator = Y from 2024-01-01," both claims stay. The lower-confidence row is not deleted. Both rows link to each other via `contradicted_by`, and the downstream view routes the contradiction to manual review.

### Rule 5 — `valid_from` is always the best available date, not ingestion date

The `valid_from` column holds the date the relationship became true, not when OSA learned about it. If the FAA registry diff shows a cert transfer recorded on 2026-03-15, `valid_from = '2026-03-15'`, not the ingest-run date. Use `ingestion_date` when you need "when did OSA know."

## Worked example — aircraft N123AB moves from Operator A to Operator B

### Initial state (2024-01-01)

```sql
INSERT INTO canonical.operator_aircraft_link
  (operator_id, aircraft_id, role, valid_from, valid_to,
   source, source_url, source_timestamp, confidence, match_method, evidence)
VALUES
  ('<operator_a_uuid>', '<aircraft_uuid_for_N123AB>', 'operator',
   '2024-01-01', NULL,
   'faa_registry', 'https://registry.faa.gov/aircraftinquiry/...',
   '2024-01-01T00:00:00Z', 1.00, 'faa_registry_exact',
   '{"certificate_number":"1OCA082A","registration_record":"..."}'::jsonb);
```

One row. One open window. `valid_to IS NULL`. Current operator = Operator A.

### Aircraft moves operators (2026-04-15 effective, discovered 2026-04-20 via two independent sources)

```sql
BEGIN;

-- Close Operator A's window
UPDATE canonical.operator_aircraft_link
   SET valid_to = '2026-04-15',
       last_updated_at = NOW(),
       corroborated_by = COALESCE(corroborated_by, '[]'::jsonb) || jsonb_build_array(
         jsonb_build_object(
           'source','sec_edgar',
           'source_url','https://www.sec.gov/cgi-bin/browse-edgar?...',
           'source_timestamp','2026-04-18T00:00:00Z',
           'ingestion_date', NOW()
         )
       )
 WHERE operator_id = '<operator_a_uuid>'
   AND aircraft_id = '<aircraft_uuid_for_N123AB>'
   AND role = 'operator'
   AND valid_to IS NULL;

-- Open Operator B's window
INSERT INTO canonical.operator_aircraft_link
  (operator_id, aircraft_id, role, valid_from, valid_to,
   source, source_url, source_timestamp, confidence, match_method, evidence,
   corroborated_by)
VALUES
  ('<operator_b_uuid>', '<aircraft_uuid_for_N123AB>', 'operator',
   '2026-04-16', NULL,
   'faa_registry_diff',
   'https://registry.faa.gov/aircraftinquiry/...',
   '2026-04-20T00:00:00Z',
   0.95, 'faa_daily_diff+sec_edgar_8K',
   '{"registration_event":"operator_transfer","prior_operator_id":"<operator_a_uuid>","prior_cert":"1OCA082A","new_cert":"7OCA297N"}'::jsonb,
   '[{"source":"sec_edgar","source_url":"https://www.sec.gov/...","source_timestamp":"2026-04-18T00:00:00Z","ingestion_date":"2026-04-20T00:00:00Z"}]'::jsonb);

COMMIT;
```

Two rows now. One closed window (Operator A, 2024-01-01 to 2026-04-15), one open window (Operator B, 2026-04-16 to NULL). The Two-Source Rule is satisfied — FAA daily diff + SEC EDGAR 8-K are independent publishers. `corroborated_by` records both.

### Retrospective query — who flew this aircraft on 2025-06-01?

```sql
SELECT o.canonical_name, oal.confidence
FROM canonical.operator_aircraft_link oal
JOIN public.operators o ON o.id = oal.operator_id
WHERE oal.aircraft_id = '<aircraft_uuid_for_N123AB>'
  AND oal.role = 'operator'
  AND oal.valid_from <= '2025-06-01'
  AND (oal.valid_to IS NULL OR oal.valid_to > '2025-06-01');
```

Returns Operator A. If the migration had been an `UPDATE ... SET operator_id = ...`, this query would have been impossible to answer correctly.

### Current operator query — who flies it today?

```sql
SELECT o.canonical_name
FROM canonical.operator_aircraft_link oal
JOIN public.operators o ON o.id = oal.operator_id
WHERE oal.aircraft_id = '<aircraft_uuid_for_N123AB>'
  AND oal.role = 'operator'
  AND oal.valid_to IS NULL;
```

Uses the partial `idx_<table>_current` index. Fast at any scale.

## Event-edge variant

For relationships that are one-off events rather than ongoing states (REBRANDED_TO, ACQUIRED, CERT_TRANSFERRED_TO, CRASHED), swap the temporal window columns:

```sql
-- Replace:
valid_from DATE NOT NULL,
valid_to DATE,

-- With:
event_date TIMESTAMPTZ NOT NULL,         -- exact moment, if known
event_date_precision TEXT NOT NULL       -- 'exact', 'day', 'month', 'year'
  CHECK (event_date_precision IN ('exact','day','month','year')),
```

Everything else — provenance columns, indexes (on event_date instead of valid_from), Two-Source Rule, append-only discipline — is identical.

Event tables do **not** use the non-overlapping-windows exclusion constraint (events can collide; two separate rebrands can happen on the same day). They get a unique constraint on `(entity_id, event_type, event_date)` instead, where that makes sense.

## Agent-facing views (future)

No agent code (dumont-agent) reads temporal link tables directly. Agent-facing views in `schema/gold/views/` expose the "current state" filtered through a `valid_to IS NULL` predicate and apply trust-score filtering. Examples:

- `v_aircraft_current_operator` — one row per aircraft, current operator only, confidence ≥ threshold
- `v_aircraft_operator_at_date(date)` — parameterized view for retrospective queries (e.g., NTSB incident date)

These views are Stage 2c+ work, not this plan.

## References

- `docs/er-architecture-plan.md` — Five-entity ER plan
- `docs/er/aircraft.md` — Aircraft entity spec, seven-role model
- `schema/canonical/operator_aircraft_link.sql` — First implementation of this pattern
- `schema/rollback/2026-04-24-002-canonical-operator-aircraft-link-rollback.sql` — Rollback for the first implementation
