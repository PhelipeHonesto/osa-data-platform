# Certificate entity — ER spec

**Status**: v0 — 2026-04-25 (architectural decision; schema next session)
**Parent**: `docs/er-architecture-plan.md`
**Schema**: `canonical.certificates`, `canonical.certificate_identities`, `canonical.certificate_aliases`, `canonical.aircraft_on_certificate`, `canonical.operator_holds_certificate`, `canonical.certificate_events` (TBD — Step 1)
**Migration**: TBD — Step 1

---

## Why certificate is a first-class entity

The FAA regulates certificates, not operators. The operator is the commercial brand a customer pays. The certificate is the legal entity authorized to fly under Part 135 / Part 121 / Part 91K. The two are paired but distinct, and conflating them — modeling cert as an attribute of operator — is a documented mistake that surfaced repeatedly during Stage 1–2 work:

- **Vista America consolidation** — one cert subsumed Jet Select + XOJET + Red Wing across multiple brand transitions. The cert is more stable than any of the brands attached to it.
- **West Coast Aviation Services cert pair** — one operator group holds WCW + WCC simultaneously. The relationship is one-to-many, not one-to-one.
- **CP3 structural ceiling** (Stage 2b, 2026-04-24) — `certificate_holder` resolution to canonical operators capped at 0.05% walk because the certificate field doesn't name the operator brand for any major US charter fleet by design.
- **FedEx / Corporate Flight Services** (Stage 2c, commit `d1408e7`) — the seven-role aircraft model works because legal_owner and operator are distinct roles. The same parallel-layer logic applies one level up: operator brand and cert-holder of record are distinct facts about the same flight authorization.

The certificate-promotion decision was logged 2026-04-25 (Step 0). Schema work is the next session.

## What a Certificate IS

A certificate is a legal authorization issued by a civil aviation authority (primarily the FAA, with foreign equivalents in scope for Stage 9) that permits a named legal entity to operate aircraft for compensation under a specific operating part. Each certificate carries:

- An FAA cert number (e.g., `DCUA716B`, `GSPA467E`)
- A type / operating part: Part 135 (on-demand charter), Part 121 (scheduled), Part 91K (fractional), foreign AOC equivalents
- A holder of record at time T (the legal entity named on the cert at that date)
- A status: active / surrendered / revoked / consolidated-into / pending
- Issued date / surrendered date / revoked date (where applicable)

Certificates persist across operator brand changes. Certificates can be transferred between legal entities. Certificates can be voluntarily surrendered or revoked by the FAA. None of these states are accurately representable as a column on the operator table.

## Identity model

Certificates have three identity anchors, priority-ordered:

1. **`faa_cert_number`** — the canonical anchor for US-issued certificates. Stable across legal-entity name changes (Marquis Jet Partners → NetJets Marquis Inc keeps the same cert number).
2. **`dot_number`** — secondary identifier for entities that also hold DOT economic authority (Part 295 brokers, Part 121 carriers). Useful for cross-walking to DOT filings.
3. **OpSpec D085 `cert_id`** — tertiary identifier internal to FAA OpSpec data. Used to join into FAA-published OpSpec fleet authorization data. Not externally meaningful.

### Certificate number reuse

FAA cert numbers can be reissued after a cert is surrendered or revoked, on a timeline similar to N-number reuse. Cert-number lookups always carry a temporal filter — the same cert number at two different dates may name two different legal entities and two different fleets. The same discipline that applies to `current_tail_number` on aircraft applies here.

### Foreign certificates

Foreign Air Operator Certificates (Cayman CAACI, San Marino, Isle of Man, EASA) are in scope for Stage 9. Their identifiers are not `faa_cert_number` but a foreign-authority equivalent. The canonical column shape carries `cert_authority` (`faa`, `caaci`, `easa`, etc.) so identity uniqueness is enforced per-authority.

## Roles / states

Certificates carry a status enum, not a role enum (operators have roles; certificates have lifecycle states):

| State | Meaning |
|---|---|
| `active_operating` | Cert is issued, current, and authorizes flight today |
| `surrendered` | Holder voluntarily gave up the cert (often pre-merger or pre-dissolution) |
| `revoked` | FAA revoked the cert (adversarial; subject to GENOT bulletin) |
| `consolidated_into` | Cert was rolled into another cert via M&A; carries a pointer to the surviving cert |
| `pending` | Application filed, not yet issued |

Status transitions are recorded in `certificate_events` (see below), not by mutating a status column directly. The state column on `canonical.certificates` reflects current state and is derived from the events log.

## Events

`canonical.certificate_events` follows the event-edge variant of the temporal link pattern (`docs/temporal-link-pattern.md` §"Event-edge variant"). One row per discrete state-change moment.

Event types:

- **`issued`** — cert first granted by the issuing authority. `event_date` populated, `cert_authority` populated.
- **`transferred`** — cert moves between legal entities (M&A; cert preserved across the transfer). `predecessor_holder_id` and `successor_holder_id` both populated.
- **`surrendered`** — cert voluntarily given up.
- **`revoked`** — FAA-initiated. Distinct from surrender; adversarial.
- **`consolidated`** — cert is rolled into a surviving cert (Vista America pattern). `consolidated_into_cert_id` populated.
- **`fleet_added`** — airframe added to OpSpec D085 fleet authorization. Joins to `canonical.aircraft`.
- **`fleet_removed`** — airframe removed from D085. Joins to `canonical.aircraft`.

Two-Source Rule applies to identity-changing events (`transferred`, `consolidated`) per `docs/er-architecture-plan.md` §"Two-Source Rule." Single-source claims land with `confidence < 0.70` and source-prefix `pending_claim_*` until corroborated.

`canonical.operator_events.event_type='cert_transfer'` is **deprecated** when `certificate_events` ships. Existing rows (zero today; the operator_events table is empty) migrate to `certificate_events`. The deprecation note belongs in the `operator_events` schema header at the time of the migration; until then, no `cert_transfer` rows should be written.

## Links

Three temporal link tables, all following the canonical column shape in `docs/temporal-link-pattern.md`:

- **`canonical.operator_holds_certificate(operator_id, cert_id, role, valid_from, valid_to, ...)`** — current and historical cert holder by operator brand. `role` discriminator reserved for future expansion (e.g., `holder_of_record` vs `dba_authorized`). The append-only / close-then-insert discipline applies.
- **`canonical.aircraft_on_certificate(aircraft_id, cert_id, valid_from, valid_to, ...)`** — fleet authorization. Sourced primarily from the FAA Part 135 Operators and Aircraft list (the public OpSpec D085 spreadsheet on faa.gov, Tier 1) and from operator self-disclosure (Tier 2). Independent of `canonical.operator_aircraft_link role='operator'`, which records who flies the plane via callsign / ADS-B evidence. Two link tables, two distinct facts, both queryable.
- **`canonical.fbo_authorized_on_certificate`** (future, Stage 6c+) — which FBOs are authorized to service this cert holder. Out of scope for Step 1.

## Sources of truth (priority order)

1. **FAA Part 135 Operators and Aircraft list** (Tier 1, public, monthly cadence when active). Sourced from OpSpec D085 and published by the FAA as an Excel spreadsheet at https://www.faa.gov/about/officeorg/headquartersoffices/avs/part-135-aircraft-listing-opspec-d085 — both operator and individual tail-number authorizations. Primary source for fleet-on-certificate. The page is currently temporarily deactivated by the FAA pending a data-integrity fix (last update 2026-04-01; the FAA states they are actively working on a solution); archived copies serve as bridge data, and OSA's reconciled version becomes a public good once Step 3+ ships.
2. **FAA Air Carrier Certificate database** (Tier 1, public). Seeds `canonical.certificates` and the initial `operator_holds_certificate` population.
3. **FAA Public Dockets** (Tier 1, public). OpSpec amendments and cert-holder transitions for `certificate_events`.
4. **Operator-published OpSpec data** (Tier 2, partial coverage). Majors only (NetJets, Vista, Wheels Up sometimes publish fleet authorizations on company sites). Subject to Two-Source Rule corroboration.
5. **FOIA D085** (Tier 1, fallback). Used when the FAA Part 135 list stays offline or when historical amendments at a specific date are needed. Not the primary path.
6. **ADS-B confirmation** (Tier 1 for the position fact, Tier 3 as a cert-holder source). Corroboration only.

LinkedIn and any source whose ToS forbids machine access are excluded, per `docs/data-sources.md` (non-negotiable).

## Why certs are not "just an attribute of operator"

Three scenarios that the operator-as-cert-holder model cannot represent without lying about the data:

- **Scenario B — cert sold to new shell.** A Part 135 operator dissolves; the cert is sold to a newly formed LLC that operates as a different brand. Two operator entities, two brand identities, one cert number that crosses between them on a known date. The operator-attribute model forces a fabricated "rebrand" event because there is no first-class place to record the cert as the persistent thing.
- **Scenario C — operator surrenders + new cert issued.** Same legal entity reorganizes, surrenders cert A, applies for and receives cert B. One operator, two cert numbers, no acquisition event. The operator-attribute model has no shape for "operator's cert changed" without fabricating a cert_transfer that didn't happen.
- **Scenario D — M&A consolidation (Vista America).** Three cert numbers folded into one surviving cert across multiple brand transitions. The operator-attribute model forces three separate cert-transfer events on three operator rows, each pointing at the surviving cert by free-text reference. With certificate as a first-class entity, the same history is one `consolidated` event per absorbed cert plus three `operator_holds_certificate` window closes — fully temporal, fully auditable, no free-text references.

## What this doc explicitly does NOT ship

- No schema. Schema is Step 1 (next session).
- No migrations.
- No backfill.
- No resolver.
- No trust score.
- No view layer.

This is the architectural decision, written down so future sessions reference it as canonical.

## References

- `docs/er-architecture-plan.md` — parent ER plan, six-entity model, certificate appendix
- `docs/er/aircraft.md` — sibling entity spec; this doc mirrors its shape
- `docs/temporal-link-pattern.md` — canonical shape for every cross-entity link, including the event-edge variant used by `certificate_events`
- `docs/data-sources.md` — Tier 1–4 source map + LinkedIn exclusion (pinned, non-negotiable)
- `docs/sessions/2026-04-24-stage-2b-aircraft-backfill.md` — case-study session that surfaced the cert-as-attribute breakage (Vista America, FedEx/CFS, CP3 structural ceiling)
- `CLAUDE.md` §3 — six-entity discipline rule
