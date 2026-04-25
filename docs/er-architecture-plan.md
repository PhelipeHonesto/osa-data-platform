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

- **Done**: Track 1 Stages 1, 2. Track 2 Stage 2a (schema) + partial Stage 2b (FAA bulk CP1, ADS-B merge CP2, operator_aircraft_link CP3 — see structural ceiling finding below).
- **This plan**: Track 2 Stage 2b finished at partial, Track 1 Stage 3 is now the critical path.
- **Deferred**: Track 1 Stage 8 (AGE), Tracks 4 & 5 in full.

## Structural ceiling of direct-registry operator resolution

**Finding (Stage 2b Checkpoint 3, 2026-04-24)**: resolving `faa_aircraft.certificate_holder` against the 270-row operators canonical produces a walk rate of **~0.05% of resolver-eligible aircraft**. On 35K processed rows, only 10 `canonical.operator_aircraft_link` rows were written. This is the real ceiling of the current data model — not a bug in the resolver, not a calibration miss, not a missing operator in the canonical table.

**Why**: the certificate_holder field in the FAA registry does not name the operator for any of the major aircraft populations in the US charter world.

1. **Trustees hold airframes for the big charter fleets by design.** `BANK OF UTAH TRUSTEE` (1,547 aircraft), `TVPX AIRCRAFT SOLUTIONS INC TRUSTEE` (1,204), `WILMINGTON TRUST CO TRUSTEE` (601), `UMB BANK NA TRUSTEE` (460), `SOUTHERN AIRCRAFT CONSULTANCY INC TRUSTEE` (449) collectively hold the NetJets, Flexjet, Wheels Up, VistaJet fleets. Our pre-filter correctly routes these to `skipped_trustee` because matching "BANK OF UTAH TRUSTEE" to "NetJets Aviation" would require auxiliary data (OpSpec D085, operator self-disclosure, ADS-B behavioral signatures) that `certificate_holder` alone cannot provide. This is precisely the "who actually flies the plane" funnel pattern documented at the top of this plan.
2. **Major Part 121 scheduled airlines are registered directly in their own name** (`UNITED AIRLINES INC`, `DELTA AIR LINES INC`, `AMERICAN AIRLINES INC`, `SOUTHWEST AIRLINES CO`, `FEDERAL EXPRESS CORP`), but these are deliberately absent from our operators canonical — they are scheduled carriers, not charter, and outside the brokerage scope.
3. **Individual-owner GA aircraft** (`registrant_type = 1`, ~118K airframes) are filtered before the resolver sees them — they are owner-flown, not operator-flown. `skipped_individual` is the correct bucket.
4. **The resolver-run residue** is LLC/Corp-registered aircraft (~137K airframes) whose certificate_holder is either the operator's own name (rare — directly-registered small Part-135 operators, ~10–100 aircraft at most) or an intermediate holding LLC that no source names as an operator (most of the residue).

**Implication — direct registry resolution is a minority pathway.** The CP3 `operator_aircraft_link` population is correct but small, and will remain small under the current data model. Meaningful fleet-level operator attribution requires:

- **Track 1 Stage 3** (FAA GENOT + SEC EDGAR + DOT Part 295 + state SOS) to expand operator coverage and ingest rebrand / cert-transfer events from authoritative sources. Stages 5–7 expand further into holding structures and funnel detection.
- **Stage 2c aircraft resolver with trustee-unmask** — second resolution pathway that uses ADS-B behavioral signatures (fleet co-location, consistent HQ departure patterns), operator self-disclosure (company websites, "fleet" pages — Firecrawl pathway), and FAA OpSpec D085 ingestion to attribute trustee-held airframes to their real operators.

**Stage 2b ships the audit log, not the walk.** The primary deliverable of Checkpoint 3 is `canonical.operator_aircraft_resolution_log` — a permanent audit trail that tells us exactly which certificate_holders cannot be resolved today and why. That log is Track 1 Stage 3's input for deciding which sources to prioritize (top 50 no_match strings by aircraft count name the specific expansion targets).

**Revised walk-rate target**: 1–3% raw, not 15–30%. The earlier target implicitly assumed operator coverage would match the flying population — it does not, and cannot until the above pathways are built. Reporting any higher number as a success metric would be dishonest.

### Pathway 2: ICAO callsign unmask — blocked, needs ingest change

Mechanism: trustee-held aircraft (BANK OF UTAH, TVPX, etc.) squawk their operator's ICAO callsign during flight (NetJets aircraft squawk EJA1234, Flexjet aircraft squawk LXJ2345, etc.). Joining the squawked callsign back to `operators.icao_callsign` recovers operator attribution.

Data dependency: ADS-B Mode S flight identifier (the callsign), broadcast by every transponder, currently NOT persisted in `adsb_completed_legs`. Verified 2026-04-24: `operator_name` in legs is a propagated copy of FAA `certificate_holder`, not the squawked callsign. The end-of-day Stage 2c probe (probe 4 across 2,024,897 trustee legs) found 0 bare callsign matches and 461 prefix-with-digit matches — 0.023%, below the noise floor.

To unblock:

1. Modify `src/ingestion/adsb-leg-aggregator.ts` (or equivalent leg builder) to persist callsign per leg.
2. Add `callsign TEXT` column to `adsb_completed_legs` schema (and likely `adsb_aircraft_state` for live state).
3. Index on `(callsign)` for the JOIN query pattern. Likely also a partial index `WHERE callsign IS NOT NULL` for the hot path.
4. Forward-only: historical 21M legs have no callsign data. S3 raw-archive reprocess is multi-week scope, deferred.

Estimated unblock: 1 session for ingest change + schema migration. Then 30–60 days of natural ingest volume to accumulate enough callsign coverage. Then Stage 2c backfill becomes a clean SQL job: `JOIN operators ON operators.icao_callsign = SUBSTRING(callsign FROM '^([A-Z]{3})')`.

This pathway, when unblocked, is expected to recover operator attribution for the ~7,000 trustee-held aircraft that account for ~2M legs in the existing data — the bulk of the structural ceiling that CP3 surfaced. The `icao_callsign` column on `public.operators` (shipped 2026-04-24) is the lookup target; the 26 callsigns mapped today (EJA, LXJ, WUP, PCH, VJA, FFL, XSR, JTL, EJM, ...) are exactly what the future ingest-side `flight_id` will JOIN against.

## Resolution-log table (permanent)

`canonical.operator_aircraft_resolution_log` is a **permanent** canonical-schema table, not temp/staging. Every resolution decision — matched / exact / review / no_match / skipped_* — lands here with the backfill_run_id, the scoring signals, and the full provenance. Properties:

- One row per `(aircraft_id, backfill_run_id)` via a UNIQUE index — re-runs append, never overwrite
- Foreign keys into `canonical.aircraft` (ON DELETE CASCADE), `public.operators` (SET NULL), `canonical.operator_aircraft_link` (SET NULL), `public.operator_match_review` (SET NULL)
- Idempotency: backfill scripts check `NOT EXISTS` on `(aircraft_id)` for new-rows-only semantics by default
- Rollback: `schema/rollback/2026-04-24-checkpoint-3-rollback.sql` filters by `backfill_run_id` to unwind a specific run

Use cases beyond CP3:
- Track 1 Stage 3 (new operator coverage) re-runs the backfill and compares new resolution_log vs old — which previously-no_match aircraft now resolve?
- Threshold recalibration re-runs and compares decision shifts
- Review-queue tuning reads `tier`, `score`, `second_best_score`, `reason` distributions

## canonical.operator_events — historical ER primitive

Schema: `schema/canonical/operator_events.sql`. Empty on arrival (2026-04-24); population is Stage 3+ work.

### Role in the five-entity model

Operator entities, like every entity in the canonical layer, have a *current state* and a *history*. `public.operators` + `public.operator_identities` + `public.operator_aliases` capture the current state — who exists right now, what sources confirm them, what name variants they answer to. `canonical.operator_events` captures the history — discrete moments when identity, structure, or certificate changed.

The split matters because state and history have different read shapes. State queries are point lookups: "what is operator X today." History queries are temporal walks: "what was operator X five years ago," "who held this Part 135 cert before 2022," "trace the lineage from Avantair forward through every successor entity." Mixing them in one table forces every query to filter `WHERE valid_to IS NULL` and forces every state mutation to be append-with-close. Splitting them keeps the state table simple and the history table append-only.

### Event taxonomy

11 event types. The full expected-field-by-event-type matrix lives in the schema file header; this section walks the aviation-specific intuition behind each.

- **`rebrand`** — Same legal entity, new marketing name. JetSmarter → XO (2018). XOJET → Jet Select (2018, before XO acquired). Cert preserved by definition; `aoc_before` and `aoc_after` are NULL.
- **`legal_rename`** — New legal entity name, same operations and same cert. Marquis Jet Partners filed for a name change to NetJets Marquis Inc. Both fields populated, often equal.
- **`acquisition`** — A acquires B. `primary_operator_id` = acquirer, `other_party_id` = acquired. Wheels Up acquiring Delta Private Jets (2020). Vista Global acquiring XOJET (2018). The acquired entity may continue operating as a subsidiary or be dissolved by a follow-up `dissolution` event.
- **`merger`** — A and B combine into C. All three populated: predecessor, successor, other_party. America West + US Airways → US Airways (2005, the new combined entity).
- **`spinoff`** — B separates from A. JetSuite spinning off JSX as a separate scheduled-charter brand (2019). `predecessor_id` is the parent, `successor_id` is the spun-off entity.
- **`cert_transfer`** — Part 135 cert moves between legal entities. Common during M&A: cert held by the acquired entity transfers to a holding company. Both `aoc_before` and `aoc_after` populated, usually equal (the cert number itself doesn't change, the holder does).
- **`cert_surrender`** — Cert voluntarily given up. Often pre-merger (consolidate to one cert) or pre-dissolution. `aoc_before` populated, `aoc_after` NULL.
- **`cert_revocation`** — FAA revoked the cert. Distinct from surrender — adversarial. Subject to public bulletin via FAA GENOT.
- **`dissolution`** — Legal entity wound up. TAG Aviation USA dissolved (2018) followed by TAG San Marino formation as the inheriting EU operation. The two events are independent rows; the lineage is reconstructed by the lineage view.
- **`formation`** — Legal entity first appears. Not every operator has a `formation` event in the table — only when the formation date is independently verified by a Tier 1 source. Day-zero canonical creation does not generate a `formation` event.
- **`aoc_change`** — Foreign Air Operator Certificate change for non-US operators. Reserved for entities like VistaJet Malta or Comlux Aruba that operate under foreign AOCs.

### Two-Source Rule application

Same shape as every other canonical temporal table: `corroborated_by` and `contradicted_by` JSONB arrays of `{source, source_url, source_timestamp, ingestion_date}`. An event with one source has `corroborated_by = NULL` (or empty array), and Two-Source Rule status is computed: `jsonb_array_length(corroborated_by) >= 1` means the row has independent corroboration, satisfying the rule.

Ingestion flow: first source inserts a new event row with `corroborated_by = NULL`. Second independent source matches the natural_key (or `event_type + event_date + party UUIDs` tuple) and instead of inserting a duplicate, appends its provenance to the first row's `corroborated_by` array. A third+ source repeats. Conflicting sources (same event_type + parties but different event_date, or different aoc_after) append to `contradicted_by` with a `conflict` field describing the disagreement.

Single-source claims stay in the table — they are the input pipeline, not noise — but the agent-facing views filter them out by default. Confidence scoring composes: a Tier-1 single-source claim outranks a Tier-3 corroborated-twice claim only via explicit confidence override at the source level.

### Source pathways

- **`faa_genot`** — FAA General Notice bulletins. Authoritative for cert transfers, surrenders, revocations. Tier 1.
- **`sec_edgar_8k`** / **`sec_edgar_s1`** — SEC filings for public-company M&A and formations. Authoritative when applicable. Tier 1.
- **`court_filing_<jurisdiction>`** — Bankruptcy and dissolution filings. Tier 1 for the events they cover; not all operators end up in court.
- **`state_sos_<state>`** — Secretary of State entity registries. Authoritative for `formation` and `dissolution` of legal entities, less so for what operations were attached. Tier 1 for the legal-entity layer.
- **`company_press_release`** — Operator press releases. Tier 2 — useful for rebrands and acquisitions but written for marketing, not record. Population requires Firecrawl scraping of operator websites.
- **`loud_hawk_<article-slug>`** — Loud Hawk editorial pieces. Tier 2 for the underlying claim (cite the primary source in the article), Tier 1 for "this analysis was published" as a meta-event. The editorial pipeline becomes a structured input when an article corroborates a Tier-1 claim independently.
- **`news_article`** — Trade press (AIN Online, Corporate Jet Investor, FlightGlobal). Tier 2 — quality varies by outlet and reporter.
- **`manual`** — Human-curated entries. Required when no scrape-able source exists (private rebrand announcements, off-the-record acquisitions confirmed by industry contacts). Confidence floor is medium absent corroboration.

### Query patterns

- **"Who was this operator five years ago?"** Walk `successor_id ← predecessor_id` recursively from the current operator UUID, filtered to events where `event_date <= TARGET_DATE`. The recursion terminates at the earliest predecessor (or at an unresolved `predecessor_name` text-only row).
- **"What cert did this operator hold before 2022?"** Filter `aoc_before` and `aoc_after` rows where any of the four party UUIDs match the operator and `event_date < '2022-01-01'`, ordered by `event_date DESC`. The most recent `aoc_after` before the date is the answer.
- **"What did this cert pass through?"** Filter on `aoc_before = '<cert>'` OR `aoc_after = '<cert>'`, ordered by `event_date`. Returns the chain of holders.
- **"What happened in the Part 135 industry in Q3 2024?"** Filter `event_date BETWEEN '2024-07-01' AND '2024-09-30'`, group by `event_type`. Useful for editorial trend pieces.
- **"Has anyone disputed this rebrand?"** Inspect `contradicted_by` on the row.

### Dependency on Firecrawl for population

FAA GENOT and SEC EDGAR have structured public APIs and account for the bulk of high-confidence ingestion. Everything else — operator press releases, trade press, court filings, state SOS records — needs web scraping. Firecrawl is the planned scraping layer for Stage 3+. Until Firecrawl is wired in, `operator_events` only ingests the structured-source subset. Manual curation fills the gap for events that matter for current Loud Hawk pieces.

### Future agent-facing views (out of scope this session)

When `operator_events` is meaningfully populated (Stage 3+), two views expose it to Dumont and other agents:

- **`v_operator_lineage_current`** — Given an `operator_id`, return the full lineage chain (all rebrands, mergers, acquisitions back to earliest predecessor). Walks `predecessor_id`/`successor_id` recursively.
- **`v_operator_history`** — Given an `operator_id` and a date, return what this operator was called, what cert they held, and what predecessor entities they contained, as of that date.

These views are the public API for historical ER queries. The table itself is internal infrastructure — agents never query `operator_events` directly.

View design is deferred to a session after `operator_events` has meaningful population; query patterns from real event data drive the view shape, and there is no value in speculative views over an empty table.

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
