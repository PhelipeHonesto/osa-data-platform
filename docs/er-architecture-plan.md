# OSA Entity Resolution Architecture Plan

**Status**: v0 — 2026-04-19
**Owner**: Phelipe Honesto
**Scope**: Principles and core shapes for OSA's operator intelligence graph. Detail lives in linked specs and implementation files — this document defines the WHY and WHAT, not the HOW.
**Related**: `docs/data-architecture.md`, `docs/semantic/operators.yaml`, `docs/phase1-followups.md`

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

## Ontology shape

The graph is typed nodes connected by typed edges, all carrying provenance and temporal validity.

**Nodes**: Aircraft, Certificate, Operator, Brand, Holding, BeneficialOwner, Person, Accident, Audit, Address.

**Critical discriminator**: Every Operator node carries an `operator_type` enum — `part_135`, `part_121`, `part_91k`, `foreign_aoc`, `broker`, `billing_agent`, `financier`, `holding_co`, `defunct`, `trust_holder`. This solves the real problem surfaced in calibration where 5+ rows in our current operators canonical are not operators at all.

**Edges**: HOLDS_CERT, OPERATES, BRANDED_AS, OWNED_BY, CONTROLLED_BY, FUNNELS_TO, REBRANDED_TO, ACQUIRED, CERT_TRANSFERRED_TO, CRASHED, AUDITED_BY, and others. The critical ones for OSA's moat are:

- **FUNNELS_TO** (Broker → Operator, computed) — exposes the broker-as-front pattern
- **REBRANDED_TO / ACQUIRED** (event edges requiring Two-Source Rule)
- **CRASHED** with temporal operator-at-time attribution

**Provenance on every edge**: `source`, `source_url`, `source_timestamp`, `ingestion_date`, `confidence`, `contradicted_by`, `corroborated_by`. The graph never deletes claims. Contradictions are preserved and surfaced.

**Temporal model**: State edges (OPERATES, OWNED_BY, AUDITED_BY) have `valid_from` / `valid_to`. Event edges (REBRANDED_TO, CRASHED) have `event_date`. This matters because aircraft get re-registered mid-year and safety record attribution requires knowing who held the cert on the incident date.

Full schema → `docs/semantic/operators.yaml` and later-stage additions.

## Data source tiers

Ranked by trust and independence. Higher tiers outweigh lower tiers on disputed claims.

- **Tier A — Public authoritative (free)**: FAA Registry, FAA GENOT notices, FAA Part 135 OpSpec D085, FAA Enforcement, NTSB, DOT Part 295 filings, state business registries, UCC filings, SEC EDGAR, ICAO ADREP.
- **Tier B — Operator self-published**: company websites, corporate newswire press releases. Self-interested but timestamped and first-party.
- **Tier C — Cross-industry independent**: ADS-B position history (physics doesn't lie, uniquely unfakeable), aviation press (AIN, BJT, Corporate Jet Investor), trade associations (NBAA, NATA), Wikipedia with source review, academic research.
- **Tier D — Paid but trustworthy**: OpenSanctions (free), Open Ownership BODS (free), GLEIF LEI (free), ch-aviation (paid), Corporate Jet Investor Intelligence (paid).
- **Tier E — Suspect**: JETNET, AMSTAT, ARGUS/Wyvern marketing copy, broker "market analysis," LLM AI-overview aggregators. Enter the graph only as claims to verify, never as sole sources.

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

Ordering, not scheduling.

1. **Foundation** — Gold canonical schema, entity resolution, FAA + ARGUS + Wyvern backfill, calibration, trust scoring v0, manual review CLI. ✓ *Complete as of 2026-04-19.*
2. **Operator type discrimination** — Add `operator_type` enum, audit 271 existing rows, reclassify non-operators.
3. **Authoritative rebrand tracking** — FAA GENOT + SEC EDGAR ingestion, `operator_events` table, Two-Source Rule implementation.
4. **Temporal operator attribution** — `aircraft_operator_history` with valid_from/valid_to, proper NTSB attribution across rebrand events.
5. **Corporate structure** — Holding + BeneficialOwner nodes, state registries, OpenSanctions, Open Ownership BODS, GLEIF. brand_group concept for multi-jurisdiction operators.
6. **Broker funnel detection** — DOT Part 295 + IATA SIS ingestion, FUNNELS_TO edges, funnel_ratio computation, Dumont surfacing.
7. **Safety record integration** — NTSB + international accident boards, CRASHED edges with temporal attribution, refined accident_history scoring.
8. **Graph query layer** — Evaluate Postgres + Apache AGE vs dedicated graph DB (Kùzu, Neo4j). Default: stay in Postgres with AGE until query patterns force migration. Expose as MCP tools.
9. **International expansion** — Transport Canada, EASA, Cayman CAACI, UK CAA, San Marino, Isle of Man.

## Integration constraints

- **`src/memory/` is a leaf module**, enforced by `scripts/check-agent-layer-isolation.ts`.
- **Gold agent-facing views** (Stage 2+) hide Silver and Gold-canonical tables from agent code. Dumont reads through MCP tools backed by views.
- **Provenance required for every Gold edge.** No "just trust me" edges.
- **Multi-model verification** for high-stakes decisions (Gold merges, trust score changes, funnel accusations) — route through multiple frontier models, consensus determines auto-apply vs human review.

## Loud Hawk as editorial arm

The graph powers Loud Hawk's investigative reporting. When the funnel detector or Two-Source Rule surfaces something publishable, Loud Hawk is the zero-CAC publication channel. Editorial independence is structurally protected because OSA's revenue does not depend on the graph's subjects staying happy.

## References

- `docs/data-architecture.md` — Overall data flow (medallion architecture)
- `docs/semantic/operators.yaml` — Canonical schema definitions
- `docs/phase1-followups.md` — Operational debt from Phase 1
- `src/memory/canonical/trust-score.ts` — Data confidence scoring implementation
- `src/memory/canonical/operator-trust-score.ts` — Operator trust scoring implementation
- `scripts/check-agent-layer-isolation.ts` — Architecture enforcement
- `data/calibration/matches-sample.json` — 50-pair labeled operator matching sample (April 2026)
