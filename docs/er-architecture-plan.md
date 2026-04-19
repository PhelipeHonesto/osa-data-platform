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
