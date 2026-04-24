# OSA Entity Resolution Architecture Plan

**Status**: v1 — 2026-04-24 (five-entity expansion)
**Owner**: Phelipe Honesto
**Scope**: Principles and core shapes for OSA's aviation intelligence graph. Five canonical entities — operators, aircraft, FBOs, airports, people — connected by temporal link tables. This document defines the WHY and WHAT; entity-specific detail lives in `docs/er/*.md` appendices; temporal relationship shape lives in `docs/temporal-link-pattern.md`.
**Related**: `docs/data-architecture.md`, `docs/data-platform-plan.md`, `docs/semantic/operators.yaml`, `docs/phase1-followups.md`, `docs/er/aircraft.md`, `docs/temporal-link-pattern.md`, `docs/data-sources.md`

---

## The problem

Private aviation has a structural trust vacuum around one question: *who actually flies the plane?*

That question has layered answers — legal entity, brand, holding, beneficial owner, broker, financier — that rarely align. A customer booking "VistaJet" gets handed off through at least four entity layers before an aircraft lifts. Nobody credible integrates those layers.

The existing trust sources are structurally compromised:

- **FAA** can't maintain accurate data (dropped the Part 135 list Feb 2026)
- **ARGUS / Wyvern** are paid by the operators they audit
- **JETNET / AMSTAT** are paid by the subjects they report on
- **LLM aggregators** have a 25% false-positive rate on rebrand/acquisition claims (verified in OSA's April 2026 calibration)

Nobody credible owns "who is this operator, really." That's the opening.

## The thesis

**Aviation's dirty secret is that "who flies the plane" is the hardest question to answer. OSA is the only platform that makes it answerable.**

1. **Truth is the product.** Every Dumont recommendation comes with attribution. Every alternative is a real alternative. Every broker relationship is visible.
2. **Funneling is pervasive and undisclosed.** Broker-branded fronts route a large share of trips to their own holding's internal operators. OSA's graph surfaces this automatically.
3. **Independence is structural.** OSA is paid by nobody in the graph. This creates the freedom to publish uncomfortable truths that paid aggregators cannot.

## Non-goals

- **OSA does not gate access.** Trust scores and funnel flags are information, never filters. We route business to all legally-operating carriers, including consolidating holdings (Vista Global, Wheels Up, Flexjet, NetJets). Scoring informs HOW we describe and rank options — not WHETHER a customer can book them.
- **OSA does not publish accusations it can't defend.** Multi-source corroboration required for any claim Dumont presents as fact. Single-source rebrand/acquisition claims are never good enough.
- **OSA does not scrape sources that forbid it.** LinkedIn, gated databases, anything whose ToS prohibits machine access. We work with the open web and official feeds, not against terms of service.

## The five entities

The graph has exactly five canonical entity types. No sixth entity is added until all five have resolution pipelines in place. This is a discipline decision — expanding the node set before the existing set is fully resolved produces a half-built ontology that nobody can reason about.

| Entity | Canonical table | Appendix | Identity anchors | Stage |
|---|---|---|---|---|
| **Operator** | `public.operators` | `docs/er/operators.md` (TBD — content currently inlined in this doc) | `canonical_name` + `operator_type` + `operator_identities.(source, source_id)` | Stage 1 ✓ |
| **Aircraft** | `canonical.aircraft` | `docs/er/aircraft.md` | `icao_hex` (preferred, immutable) / `serial_number` (history) / `current_tail_number` (mutable) | Stage 2a (this plan) |
| **FBO** | `canonical.fbo` (TBD) | `docs/er/fbos.md` (TBD) | `icao_airport + fbo_name` + parent rollup | Stage 3a |
| **Airport** | `canonical.airport` (TBD) | `docs/er/airports.md` (TBD) | `icao_id` / `iata_id` / `faa_id` | Stage 4a (lightest load — deferred until needed) |
| **Person** | `canonical.person` (TBD) | `docs/er/people.md` (TBD) | `full_name + role_history`; public records only | Stage 5a |

Each entity follows the same **overlay pattern**: one canonical table + an `{entity}_identities` table (per-source links) + an optional `{entity}_aliases` table (alternate names). Source data is never physically merged — claims from each source live in `{entity}_identities` with their provenance intact, and the canonical row aggregates them.

## Entity sketches

### Operator — Stage 1 complete

Shape detail: `schema/gold/canonical/operators.sql`, `docs/semantic/operators.yaml`.

Canonical discriminator: `operator_type` enum (`part_135`, `part_121`, `part_91k`, `foreign_aoc`, `broker`, `billing_agent`, `financier`, `holding_co`, `defunct`, `trust_holder`). Solves the real problem surfaced in Phase 1 calibration where 5+ rows in the canonical were not operators at all.

**TODO (separate session)**: `public.operator_aliases` has 1 row after Stage 1 "complete." Either the resolver writes are broken and aliases are being dropped, or the alias table is redundant with `operator_identities.name_as_provided`. Audit which is true before new entities replicate the pattern.

### Aircraft — Stage 2a (this plan)

Shape detail: `docs/er/aircraft.md`. Summary:

- Identity anchors in priority order: `icao_hex` (immutable, preferred) > `serial_number + manufacturer` (history) > `current_tail_number` (mutable, reused)
- **N-number reuse hazard**: cancelled tails become available ~90 days after cancellation; tail-based lookups require a temporal filter
- Seven-role model for operator_aircraft_link: `legal_owner`, `beneficial_owner`, `operator`, `manager`, `financier`, `insurer`, `broker`. Manufacturer is an attribute of the airframe, not a role.
- **AOC shopping**: aircraft change operators without changing owners. The temporal-link-pattern (close-current-window + insert-new-row) handles this without UPDATEs.

Stage 2a ships empty tables. Backfill from `faa_aircraft` (314,813 rows) is Stage 2b.

### FBO — Stage 3a (not this plan)

FBOs are fixed-base operators — ground handling, fuel, hangar, crew lounge. Appendix TBD. Key considerations to address when that appendix is written:

- **PE rollup volatility**: Signature (Blackstone), Atlantic (KKR), Modern Aviation. Ownership changes frequently via fund-to-fund transfers. `fbo_identities` must track ownership history distinct from brand identity.
- **Real estate vs operator**: the entity that owns the FBO real estate is often distinct from the entity that operates the FBO service. Both are relationships, not attributes.
- **Asset sale without company sale** (M&N Aviation case, Puerto Rico, 2024): the operating company was not sold; specific FBO leases/facilities were transferred to another operator. The selling entity continued to exist. Schema must represent "FBO X changed operator" without implying "Company Y was acquired."

### Airport — Stage 4a (deferred)

Lightest ER load of the five. Identity resolution is mostly deterministic via ICAO/IATA/FAA_id triples. Appendix TBD. Schema can reuse an off-the-shelf airport dataset (e.g., OurAirports CSV, FAA 5010) with a thin canonical row.

### Person — Stage 5a (not this plan)

Role history for founders, CEOs, chief pilots, directors of operations. Public-records-only — no LinkedIn, permanently excluded. Sources: SEC EDGAR filings, FAA airmen registry, NTSB incident narratives, state SOS officer filings, press release named quotes. Appendix TBD.

**Rule**: Person entities are created only when linked to an Operator, Aircraft, or FBO via a documented role. No people rows without an edge.

## Edges

Every cross-entity relationship is a temporal link table with the canonical shape defined in `docs/temporal-link-pattern.md`. Examples (this plan ships #1; others are future):

1. `canonical.operator_aircraft_link` — seven roles, Stage 2a (this plan)
2. `canonical.fbo_operator_link` — who operates the FBO (vs. who owns the real estate) — Stage 3a
3. `canonical.aircraft_airport_presence` — aircraft-at-airport observations from ADS-B — Stage 4b
4. `canonical.person_operator_role_link` — Person plays role X at Operator Y from valid_from to valid_to — Stage 5a
5. `canonical.operator_holding_link` — corporate structure, parent-subsidiary — Stage 6a

Event edges (REBRANDED_TO, ACQUIRED, CERT_TRANSFERRED_TO, CRASHED) use the `event_date` variant of the temporal pattern — see `docs/temporal-link-pattern.md` §Event-edge variant.

**Provenance on every link row**: `source`, `source_url`, `source_timestamp`, `ingestion_date`, `confidence`, `match_method`, `evidence JSONB`, `contradicted_by`, `corroborated_by`. Claims are never deleted. Contradictions are preserved and surfaced.

**Temporal model**: State links (operator_aircraft_link role='operator', fbo_operator_link, operator_holding_link) have `valid_from` / `valid_to`. Event links (rebrand, acquisition, crash, cert transfer) have `event_date`. Aircraft get re-registered mid-year, operators rebrand, safety record attribution requires knowing who held the cert on the incident date.

Full schema → `docs/temporal-link-pattern.md`, `docs/semantic/*.yaml`, and per-entity appendices.

## Data source tiers

Ranked by trust and independence. Higher tiers outweigh lower tiers on disputed claims.

- **Tier A — Public authoritative (free)**: FAA Registry, FAA GENOT notices, FAA Part 135 OpSpec D085 <!-- TODO 2026-04-19: verify OpSpec D085 is separately obtainable post-Feb-2026 Part-135-list-drop (cf. line 18). If only the aggregate list was retired, D085 filings per-operator may still be FOIA-able or available via RAO; if D085 is also gone, demote this entry. -->, FAA Enforcement, NTSB, DOT Part 295 filings, state business registries, UCC filings, SEC EDGAR, ICAO ADREP.
- **Tier B — Operator self-published**: company websites, corporate newswire press releases. Self-interested but timestamped and first-party.
- **Tier C — Cross-industry independent**: ADS-B position history (physics doesn't lie, uniquely unfakeable), aviation press (AIN, BJT, Corporate Jet Investor), trade associations (NBAA, NATA), Wikipedia with source review, academic research.
- **Tier D — Paid but trustworthy**: OpenSanctions (free), Open Ownership BODS (free), GLEIF LEI (free), ch-aviation (paid), Corporate Jet Investor Intelligence (paid).
- **Tier E — Suspect**: JETNET, AMSTAT, ARGUS/Wyvern marketing copy, broker "market analysis," LLM AI-overview aggregators. Enter the graph only as claims to verify, never as sole sources.

Note: an earlier draft of this section listed ARGUS/Wyvern under Tier D. They belong in Tier E because the subjects of the ratings pay the auditors — that is the defining Tier E marker, not whether the data is paid or free. `docs/data-sources.md` is authoritative on tier assignments going forward; reconcile against it if any downstream doc or script disagrees.

**Excluded**: LinkedIn and any source whose ToS prohibits scraping. Non-negotiable.

**Firecrawl role**: Handles Tier B + C fetch/extraction via self-hosted Docker. Does not replace direct feeds for Tier A government sources (those have official APIs or bulk CSVs).

## Core algorithms

### Two-Source Rule

Any edge representing an entity-change event (REBRANDED_TO, ACQUIRED, SPLIT_INTO, CERT_TRANSFERRED_TO) requires at least two independent sources before committing to Gold canonical. Single-source claims store as `pending_claim` and go to review queue.

Independence test: same publisher is one source; LLM aggregators collectively count as one source.

Calibration data (April 2026): single-source rebrand claims had 25% false-positive rate. Multi-source threshold is the minimum viable bar.

### Funnel detection

For any Operator with `operator_type = broker`:

funnel_ratio = (trips routed to same-holding operators) / (total trips arranged)

- `< 0.20` → independent broker
- `0.20 – 0.60` → mixed
- `> 0.60` → functional funnel

Surfaced in Dumont responses when recommending through a funnel broker, with disclosure of the routing pattern. Never gates recommendations (see trust-score usage rule).

### Trust scoring

Two orthogonal scores per operator (both stored, neither ever used as a hard filter):

- **`data_confidence_score`** — "How confident are we in this record?" (source reliability + freshness + cross-source agreement + completeness)
- **`operator_trust_score`** — "How trustworthy is this operator?" (safety rating + accident history + source count + identity stability)

Math defined in `src/memory/canonical/trust-score.ts` and `src/memory/canonical/operator-trust-score.ts`. Semantics documented in `docs/semantic/operators.yaml`.

**Scores are information, never gates.** OSA is a brokerage; we move airplanes, we don't gatekeep them.

## Build sequence

Three parallel tracks for the five entities. Ordering within a track is strict; tracks can advance independently where dependencies allow. This is ordering, not scheduling.

### Track 1 — Operator (Stages 1–9)

1. **Foundation** — Gold canonical schema, entity resolution, FAA + ARGUS + Wyvern backfill, calibration, trust scoring v0, manual review CLI. ✓ *Complete as of 2026-04-19.*
2. **Operator type discrimination** — Add `operator_type` enum, audit existing rows, reclassify non-operators. ✓ *Complete as of 2026-04-19.*
3. **Authoritative rebrand tracking** — FAA GENOT + SEC EDGAR ingestion, `operator_events` table, Two-Source Rule implementation.
4. **Temporal operator attribution** — Replaced by `canonical.operator_aircraft_link` in Track 2. This Track 1 stage collapses into Track 2 Stage 2a.
5. **Corporate structure** — Holding + BeneficialOwner nodes, state registries, OpenSanctions, Open Ownership BODS, GLEIF. `brand_group` concept for multi-jurisdiction operators.
6. **Broker funnel detection** — DOT Part 295 + IATA SIS ingestion, `FUNNELS_TO` edges, funnel_ratio computation, Dumont surfacing.
7. **Safety record integration** — NTSB + international accident boards, `CRASHED` edges with temporal attribution (via `canonical.operator_aircraft_link` at incident date), refined accident_history scoring.
8. **Graph query layer** — Apache AGE on Postgres. Deferred until query patterns force it; not this plan.
9. **International expansion** — Transport Canada, EASA, Cayman CAACI, UK CAA, San Marino, Isle of Man.

### Track 2 — Aircraft (Stages 2a–2d)

2a. **Canonical aircraft schema + first temporal link** — `canonical` schema, `canonical.aircraft`, `canonical.aircraft_identities`, `canonical.aircraft_aliases` scaffold, `canonical.operator_aircraft_link` as first temporal link table. **← This plan.** Tables empty.

2b. **Aircraft backfill** — Resolve `faa_aircraft` (314,813 rows) and `adsb_completed_legs` distinct hex (121,512 in flight history, 52,693 in March 2026) into `canonical.aircraft`. Populate `operator_aircraft_link` from FAA registry history (`faa_registry_changes`). Separate data session.

2c. **Aircraft resolver** — Matching algorithm for new ADS-B hex / FAA registrations (Jaro-Winkler on tail + serial fuzzy + hex exact). Manual review queue. Follows the operator resolver pattern.

2d. **Aircraft trust + data_confidence** — Scoring module parallel to `compute-operator-trust-scores.ts`. Inputs: source count, identity stability, registry freshness, cross-source agreement.

### Track 3 — FBO (Stages 3a–3d)

3a. **Canonical FBO schema** — `canonical.fbo`, `canonical.fbo_identities`, `canonical.fbo_operator_link` temporal table (operator role distinct from real-estate role).

3b. **FBO backfill** — NBAA directory, NATA directory, AC-U-KWIK, AirNav. Seed with ~2,500 US FBOs.

3c. **FBO resolver** — Airport+name fuzzy match; parent-rollup via `fbo_operator_link`.

3d. **FBO ownership event tracking** — Signature/BX, Atlantic/KKR rollups. Two-Source Rule applies.

### Track 4 — Airport (Stage 4a, deferred until needed)

Lightest load. Identity resolution deterministic via ICAO/IATA/FAA_id. Reuse OurAirports or FAA 5010.

### Track 5 — Person (Stage 5a, not this plan)

Public records only. Never LinkedIn. Rule: persons exist only linked to an Operator, Aircraft, or FBO via a documented role.

### Current status (2026-04-24)

- **Done**: Track 1 Stages 1, 2.
- **This plan**: Track 2 Stage 2a. Track 1 Stage 4 collapses into Track 2 Stage 2a (operator_aircraft_link is the single source of truth for "who flew what when").
- **Next sessions**: Track 2 Stage 2b (backfill), Track 1 Stage 3 (FAA GENOT + rebrand tracking), Track 3 Stage 3a (FBO schema).
- **Deferred**: Track 1 Stage 8 (AGE), Tracks 4 & 5 in full.

## Integration constraints

- **`src/memory/` is a leaf module**, enforced by `scripts/check-agent-layer-isolation.ts`.
- **Gold agent-facing views** (Stage 2+) hide Silver and Gold-canonical tables from agent code. Dumont reads through MCP tools backed by views.
- **Provenance required for every Gold edge.** No "just trust me" edges.
- **Multi-model verification** for high-stakes decisions (Gold merges, trust score changes, funnel accusations) — route through multiple frontier models, consensus determines auto-apply vs human review.

## Loud Hawk as editorial arm

The graph powers Loud Hawk's investigative reporting. When the funnel detector or Two-Source Rule surfaces something publishable, Loud Hawk is the zero-CAC publication channel. Editorial independence is structurally protected because OSA's revenue does not depend on the graph's subjects staying happy.

## References

- `docs/data-architecture.md` — Overall data flow (medallion architecture)
- `docs/data-platform-plan.md` — Transformation / orchestration / tooling
- `docs/temporal-link-pattern.md` — Canonical shape for every cross-entity link
- `docs/data-sources.md` — Tier 1–4 source map + exclusions
- `docs/decisions/` — Accepted architecture decisions (ADRs)
- `docs/er/aircraft.md` — Aircraft entity spec (Stage 2a)
- `docs/semantic/operators.yaml` — Operator canonical schema definitions
- `docs/phase1-followups.md` — Operational debt from Phase 1
- `src/memory/canonical/trust-score.ts` — Data confidence scoring implementation
- `src/memory/canonical/operator-trust-score.ts` — Operator trust scoring implementation
- `scripts/check-agent-layer-isolation.ts` — Architecture enforcement
- `data/calibration/matches-sample.json` — 50-pair labeled operator matching sample (April 2026)
