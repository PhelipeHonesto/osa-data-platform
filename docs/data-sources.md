# Data sources

**Status**: v0 — 2026-04-24
**Parent**: `docs/er-architecture-plan.md`
**Purpose**: Catalog of data sources feeding OSA's five-entity ER graph. Scope limited to sources that are ingested today, partial (some data present, backfill incomplete), or actively planned for the next 1–2 stages. Sources we could use but haven't prioritized get a one-line deferred note at the bottom.

---

## Excluded sources (permanent)

### LinkedIn

**Reason**: The LinkedIn User Agreement explicitly prohibits automated access, scraping, and machine-readable ingestion. Confirmed in `hiQ Labs v. LinkedIn` (remanded 2022) — LinkedIn won the ToS-breach claim against hiQ even where the data was publicly visible. LinkedIn's position has hardened since; using it would create a documented contract-breach claim against OSA.

**Non-negotiable.** Do not reopen this decision without written authorization from Phelipe. If a future session is tempted to add LinkedIn for people-entity resolution (founders, chief pilots, DOs), the answer is to use public records (SEC filings, FAA airmen, state SOS officer lists, NTSB narratives, press release quotes) instead.

**Coverage loss is real**: for Person entities, this means role history has gaps we can't close via LinkedIn's aggregated employment records. Accept the gap.

---

## Definitions

**Tier** (independence + authority, higher = more trustworthy):
- **1** — Public authoritative (government, regulator, court records)
- **2** — Commercial reference / open data (paid or free, independent of subjects)
- **3** — Cross-industry independent (observation data, trade press, associations)
- **4** — Deep/specialized (international registries, specialized databases)

**Role**:
- **canonical** — primary source of truth for an entity or relationship
- **enrichment** — adds fields but doesn't establish identity
- **verification** — used only to corroborate claims from other sources

**Ingestion method**: bulk CSV / API / Firecrawl (for Tier B + C HTML) / manual

**Trust tier** (per `docs/er-architecture-plan.md` §"Data source tiers"):
- **A** — public authoritative
- **B** — operator self-published (websites, press releases)
- **C** — cross-industry independent (ADS-B, aviation press, NBAA/NATA)
- **D** — paid but trustworthy (OpenSanctions, Open Ownership, GLEIF, ch-aviation)
- **E** — suspect (paid audits, LLM aggregators, broker-published "market analysis")

**Status**:
- **ingested** — backfill complete, live updates running
- **partial** — some data landed, backfill or identity resolution incomplete
- **planned** — slotted for a named stage in the next 1–2 quarters
- **deferred** — known useful, not prioritized; short note only

---

## Tier 1 — Public authoritative

| Source | Entities | Role | Method | Cadence | Trust | Status |
|---|---|---|---|---|---|---|
| **FAA Aircraft Registry** (`faa_aircraft`) | aircraft, operator (via `certificate_holder`) | canonical | bulk CSV | daily diff + weekly full | A | ingested (314,813 rows) |
| **FAA Daily Diff** (`faa_registry_changes`) | aircraft, operator | canonical | bulk CSV | daily | A | ingested |
| **FAA Doc Index** | aircraft (liens, financier role) | enrichment | bulk CSV | quarterly | A | ingested |
| **FAA Airmen Registry** | person | canonical | bulk CSV | monthly | A | ingested |
| **NTSB Accidents** | aircraft, operator (temporal attribution on incident date), person | canonical | API | weekly | A | ingested |
| **FAA GENOT notices** | operator (rebrand, cert transfer events) | canonical (Two-Source Rule input) | Firecrawl | on publish | A | planned (Track 1 Stage 3) |
| **SEC EDGAR** | operator, holding, person (officers) | canonical (Two-Source Rule input) | API (EDGAR JSON) | daily | A | planned (Track 1 Stage 3) |
| **DOT Part 295** (broker filings) | operator (broker role), FUNNELS_TO edge | canonical | bulk CSV + Firecrawl | quarterly | A | planned (Track 1 Stage 6) |
| **State SOS** (DE, TX, CA, FL) | operator, holding, person (officers) | canonical (corporate structure) | Firecrawl | on-demand | A | planned (Track 1 Stage 5) |
| **FAA Enforcement** | operator (safety events) | enrichment | Firecrawl | monthly | A | planned |
| **FAA Part 135 OpSpec D085** | operator (Part 135 verification) | verification | FOIA / Firecrawl | irregular | A | deferred (post-Feb-2026 availability uncertain — see `docs/er-architecture-plan.md` line 18 footnote) |

---

## Tier 2 — Commercial reference / open data

| Source | Entities | Role | Method | Cadence | Trust | Status |
|---|---|---|---|---|---|---|
| **ARGUS** (paid safety audit) | operator (safety rating) | enrichment | Firecrawl-derived scrape | quarterly | E (subject-paid) | **partial** (22 rows in `operator_identities`; name-fuzzy backfill, not exhaustive) |
| **Wyvern** (paid safety audit) | operator (safety rating) | enrichment | Firecrawl-derived scrape | quarterly | E (subject-paid) | **partial** (223 rows in `operator_identities`) |
| **OpenSanctions** (free) | operator, holding, person | verification (sanctions/PEP flags) | API | daily | D | planned (Track 1 Stage 5) |
| **Open Ownership BODS** (free) | holding, person (beneficial owners) | canonical (beneficial ownership) | bulk JSON | monthly | D | planned (Track 1 Stage 5) |
| **GLEIF LEI** (free) | operator, holding | enrichment (legal entity identifier) | API | weekly | D | planned (Track 1 Stage 5) |

Rationale for Trust=E on ARGUS/Wyvern: the subjects pay the auditors. The data is useful as a reference claim but must not be treated as independent verification. See `docs/er-architecture-plan.md` §"Data source tiers."

---

## Tier 3 — Cross-industry independent

| Source | Entities | Role | Method | Cadence | Trust | Status |
|---|---|---|---|---|---|---|
| **adsb.lol tarballs** (historical) | aircraft (via icao_hex) | canonical (observation) | bulk tar | Phase 7 backfill + nightly | C | ingested (21M legs) |
| **adsb.lol live** (`adsb:live` worker) | aircraft | canonical (live observation) | API poll | continuous | C | ingested |
| **adsbexchange / adsb.fi** | aircraft | canonical (second independent network — cross-source agreement signal) | API | continuous | C | planned (Stage 2b enrichment) |
| **OpenSky Network** | aircraft | verification (third ADS-B network) | API | continuous | C | planned (best-effort, optional) |
| **Corporate Jet Investor** | operator, aircraft (transactions) | enrichment | Firecrawl | weekly | C | planned (Track 1 Stage 3 corroboration) |
| **Aviation press** (AIN, BJT) | operator (rebrand / acquisition signals) | enrichment (Two-Source Rule input) | Firecrawl | on publish | C | planned (Track 1 Stage 3 via Firecrawl) |
| **Company websites** (operator self-publishing) | operator (self-disclosed fleet, ops area) | enrichment | Firecrawl | quarterly | B | planned (Stage 2b aircraft enrichment) |

---

## Tier 4 — International registries

Deferred as a group until Stage 9 (international expansion). Summary:

- Transport Canada aircraft registry, EASA, UK CAA, CAACI (Cayman), San Marino CAD, Malta CAD, Isle of Man Aircraft Registry. Ingestion-ready formats vary — some bulk CSV, others require Firecrawl-style scraping.
- Seven-role model applies identically (foreign AOC operators are `operator_type='foreign_aoc'`).
- Non-unique serial-number constraint on `canonical.aircraft` exists specifically to accommodate international serial collisions — see `docs/er/aircraft.md` TODO.

---

## Deferred sources (known-useful, not prioritized)

One line each. Revisit when the named blocking condition lifts.

- **FAA 5010 airport data** — revisit when Track 4 (Airports) activates.
- **OurAirports.com CSV** — revisit when Track 4 activates.
- **ICAO ADREP** (international accident data) — revisit with Stage 9 international expansion.
- **UCC filings** — revisit when financier-role resolution becomes priority.
- **OpenCorporates** — paid tier, revisit when state-SOS coverage proves insufficient.
- **CourtListener** — revisit when NTSB + press coverage has gaps on operator-level litigation.
- **Sayari** — paid corporate-intelligence, revisit only if ownership chains aren't resolvable via Open Ownership + state SOS.
- **NBAA / NATA directories** — revisit when Track 3 (FBOs) activates.
- **AC-U-KWIK / AirNav** (FBO data) — revisit with Track 3.
- **IATA SIS** — revisit with Track 1 Stage 6 (broker funnel detection) if DOT Part 295 has gaps.
- **IS-BAO** — certification data, revisit when operator-safety enrichment is a priority.
- **airplanes.live** — revisit only if adsb.lol + adsbexchange have coverage gaps.

---

## References

- `docs/er-architecture-plan.md` — Five-entity ER plan, Two-Source Rule, funnel detection
- `docs/temporal-link-pattern.md` — How source data feeds temporal link tables
- `docs/er/aircraft.md` — Aircraft source enum in `canonical.aircraft_identities`
- `docs/decisions/` — Accepted ADRs that pin source-related decisions
