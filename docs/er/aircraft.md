# Aircraft entity — ER spec

**Status**: v0 — 2026-04-24
**Parent**: `docs/er-architecture-plan.md`
**Schema**: `canonical.aircraft`, `canonical.aircraft_identities`, `canonical.aircraft_aliases`
**Migration**: `schema/migrations/2026-04-24-001-canonical-aircraft.sql`

---

## Why aircraft ER comes before every other structural fix

The WINGX-style analytics engine (`src/analytics/wingx-engine.ts`) anchors every aggregate — operator market share, aircraft utilization, route trends, airport activity — on `adsb_completed_legs.operator_name`. That column is free text populated by the ADS-B ingest. In March 2026, 52,693 distinct ICAO hex addresses flew in the US, and only 28 of them walk to a canonical operator today. 89,360 distinct free-text operator names exist across 21M legs. Every aggregate computed off that column is wrong in ways nobody can audit.

Aircraft resolution is the missing hop. Once each hex has a canonical aircraft, and each aircraft has an operator history, the walk is:

```
adsb_completed_legs.icao_hex
  → canonical.aircraft (via icao_hex)
  → canonical.operator_aircraft_link (valid at leg date, role = 'operator')
  → public.operators (canonical operator)
```

No more free-text join. That is the fix.

## Identity model

Aircraft have three identity anchors, priority-ordered:

1. **`icao_hex`** — the 24-bit ICAO address burned into the transponder. Immutable for the life of the airframe unless the transponder is physically replaced (rare). Preferred canonical anchor.
2. **`serial_number`** + manufacturer — the airframe's construction serial. Stable across re-registrations, international transfers, and ownership changes. Survives tail changes. Not enforced unique because independent registries occasionally collide on serials.
3. **`current_tail_number`** — the current registration (e.g., N123AB). Mutable. Reused. The FAA reassigns cancelled tail numbers. Never the canonical anchor — only a lookup aid for the current state.

### N-number reuse hazard

A cancelled tail number becomes available ~90 days after cancellation. The FAA reassigns it freely. N123AB as flown in 2022 may be a different airframe than N123AB as flown in 2026. Any resolution pipeline that joins on tail number without a temporal window is wrong.

Rule: tail-number lookups always carry a temporal filter. The `canonical.aircraft.current_tail_number` column represents **current state only**. Historical tails are preserved in `aircraft_aliases` (when populated) with temporal windows.

### Hex code is the anchor, not the hash

Some sources emit hex as `A12345`, some as `a12345`, some as decimal (`10568645`). The canonical representation is uppercase hex without padding. Aliases table reserved for hex variants if source normalization fails.

## The seven-role model

Aircraft participate in relationships, not attributes. An aircraft doesn't have one "operator" — it has a history of entities playing seven distinct roles, each with its own temporal window:

| Role | Meaning | Typical source |
|---|---|---|
| `legal_owner` | Name on the FAA registration (title holder) | FAA registry |
| `beneficial_owner` | Entity with actual economic interest — often trusts, LLCs, holding companies | State SOS, OpenCorporates, Open Ownership BODS |
| `operator` | Holds operational control (Part 135 cert or equivalent). Flies the plane under their AOC. | FAA OpSpec D085, ADS-B-derived, operator self-disclosure |
| `manager` | Runs day-to-day operations for the owner. Distinct from operator when owner is a corporate flight department outsourcing to a management company. | Management company disclosures, Part 91K roster |
| `financier` | Holds the lien / lease / finance interest. | FAA doc index (recorded liens), UCC filings |
| `insurer` | Hull and liability insurance carrier. Rarely public but appears in incident records. | NTSB incident reports, court records |
| `broker` | Charters the aircraft through a branded front operated by someone else. Relevant for funnel detection. | DOT Part 295 filings, IATA SIS, broker-operator disclosures |

**Manufacturer is not a role.** It's a fact of the airframe, stored as a column on `canonical.aircraft` (`manufacturer`, `model`, `common_name`, `year_manufactured`). Manufacturer doesn't change and isn't a relationship that has a window.

Each role maps to a `role` value in `canonical.operator_aircraft_link` (the first temporal link table — spec in `docs/temporal-link-pattern.md`).

### AOC shopping pattern

An aircraft can change operators (AOC holders) without changing owners. This is "AOC shopping" — the owner chases lower insurance rates, better dispatch reliability, or tax treatment by moving their aircraft between management companies. The legal owner stays the same; the operator role window closes on Operator A and opens on Operator B.

The temporal-link-pattern enforces this: changing the operator is never an UPDATE. It's a close-the-window (set `valid_to` on the current row) + insert a new row with new `valid_from`. Audit trail intact, historical attribution correct, Two-Source Rule still applies for the change event.

## Schema shape

### `canonical.aircraft`

```sql
CREATE TABLE IF NOT EXISTS canonical.aircraft (
  aircraft_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity anchors (priority: icao_hex > serial > current tail)
  icao_hex TEXT,                 -- ICAO 24-bit address. Preferred anchor (immutable for airframe life).
  serial_number TEXT,            -- Manufacturer serial. History anchor across re-registrations.
  current_tail_number TEXT,      -- Current registration. Mutable. Not unique across time.

  -- Airframe attributes (facts of the airframe, not relationships)
  manufacturer TEXT,
  model TEXT,
  common_name TEXT,
  aircraft_class TEXT,
  year_manufactured INTEGER,

  -- Lifecycle
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
```

Identity uniqueness is enforced via partial unique index on `icao_hex` (not a column constraint, because canonical rows can exist before ADS-B observation). Serial is indexed for lookup but **not** enforced unique. Tail is indexed but never unique.

**TODO (Stage 2b backfill)**: the backfill script must log `(manufacturer, serial_number)` collisions as soft warnings routed to a manual-review queue. Do not enforce uniqueness at the DB level. International registries (Cayman, San Marino, Isle of Man) occasionally assign the same serial to different airframes — enforcement would require dropping the constraint at Stage 9 (international expansion). Soft warnings get us audit visibility without schema churn.

### `canonical.aircraft_identities`

Per-source link table. Every `(source, source_id)` tuple maps to exactly one aircraft. Mirrors the `operator_identities` shape.

Sources: `faa` (source_id = tail_number or serial), `adsb` (adsb.lol, source_id = icao_hex), `adsb_exchange` (adsbexchange-derived, source_id = icao_hex), `opensky` (source_id = icao_hex), `argus`, `wyvern`, `jetnet_claim`, `manual`.

Three distinct ADS-B sources (`adsb`, `adsb_exchange`, `opensky`) because the raw feeds disagree on hex formatting, flight-identity stitching across track gaps, and out-of-coverage handling. Keeping them separate preserves cross-source agreement as a meaningful signal — two independent ADS-B networks agreeing on the same (hex, tail, operator_name) tuple is stronger than one feed alone.

`match_confidence` values: `exact` / `high` / `medium` / `low` / `manual`. Ambiguous matches queue in a review table (future — not shipped in Stage 2a).

### `canonical.aircraft_aliases` — scaffold only

Reserved for alternate names: hex_code variants, historical tail numbers, callsigns used in flight plans. **Not populated in Stage 2a.** Populate only when a specific resolution strategy requires alias lookup; current ER plan resolves via identities + anchor fields.

## Why aliases is a scaffold (not a full mirror of operator_aliases)

`public.operator_aliases` has exactly 1 row after "Stage 1 complete." That's suspicious. Either:

- The operator resolver writes are broken and aliases are being dropped, or
- The alias table is redundant with `operator_identities.name_as_provided`, which already preserves every source's name variant

Until that's resolved (separate session — see `docs/er-architecture-plan.md` TODO), do not replicate the pattern wholesale in aircraft. Ship the scaffold with the column shape, no inserts, no resolver integration. When aircraft ER resolution actually needs alias lookup, turn it on deliberately.

## What Stage 2a ships

1. `canonical` schema
2. `canonical.aircraft` + indexes
3. `canonical.aircraft_identities` + indexes
4. `canonical.aircraft_aliases` (empty scaffold)
5. Rollback SQL, tested against local Docker Postgres

Stage 2a ships the tables empty. Backfill from `faa_aircraft` (314,813 rows) and from `adsb_completed_legs` distinct hex is Stage 2b, a separate data session.

## What Stage 2a explicitly does NOT ship

- No backfill
- No resolver (aircraft matching algorithm) — Stage 2c
- No trust score — Stage 2d
- No link to adsb_completed_legs (that requires backfill first)
- No change to `public.faa_aircraft` or `public.adsb_completed_legs`
- No FBO, airport, or people tables (separate entity, separate session)

## Downstream dependency

`canonical.operator_aircraft_link` (Stage 2a continued) is the first temporal link table. It FKs into `canonical.aircraft(aircraft_id)` and `public.operators(id)`. Spec in `docs/temporal-link-pattern.md`. Ships in the same session once the aircraft shape is reviewed.

## References

- `docs/er-architecture-plan.md` — parent ER plan, five-entity model
- `docs/temporal-link-pattern.md` — canonical shape for every cross-entity link
- `docs/decisions/2026-04-24-adsb-text-timestamps.md` — why we don't index `adsb_completed_legs.departure_time` cast in this session
- `schema/gold/canonical/operators.sql` — the operator overlay pattern this mirrors
- `src/analytics/wingx-engine.ts` — the 26 free-text `operator_name` references that aircraft ER unblocks (Phase 12 dbt migration)
