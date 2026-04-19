# Semantic metadata

Machine-readable semantic contracts for OSA's Gold tables. One YAML file per canonical table and (starting Phase 2) one per agent-facing view.

Purpose: per [Semantic Layer](../data-architecture.md) in the architecture doc, agents are 70–90% more accurate when they read a semantic layer instead of raw columns. These files are that layer. Phase 2 MCP tools reference them directly; Phase 2 dbt migrates them into the `schema.yml` format.

## File → table mapping

| File | Table | Layer |
|---|---|---|
| `operators.yaml` | `operators` | `gold.canonical` |
| `operator_identities.yaml` | `operator_identities` | `gold.canonical` |
| `operator_aliases.yaml` | `operator_aliases` | `gold.canonical` |

## Required fields

Every file must have:

- **`table`** — the live table name.
- **`layer`** — `silver.<domain>`, `gold.canonical`, `gold.views`, etc.
- **`business_purpose`** — one-to-three sentences, plain English.
- **`grain`** — what one row represents.
- **`owner`** — who maintains this. Identifier, not narrative. Current convention: `solo:phelipe` (solo founder; promotes to a team label when OSA grows).
- **`refresh_cadence`** — how and when the data updates.
- **`key_metrics`** — list of `name / description / source_column` for the numbers agents will ask for.
- **`key_dimensions`** — list of `name / description / values` for the categorical slices.
- **`source_attribution`** — where each row's data originates.
- **`related_tables`** — adjacent tables by name + relationship.

Canonical tables (`operators`, `aircraft`, …) also include:

- **`trust_score_inputs`** — list of `(component, weight, description)`.

## Template for new files

```yaml
table: <name>
layer: <silver.|gold.>
business_purpose: >
  One-to-three plain English sentences on what this table means.
grain: one row per <thing>
owner: solo:phelipe
refresh_cadence: <when and how>
key_metrics:
  - name: <metric>
    description: <what it measures>
    source_column: <column or derived>
key_dimensions:
  - name: <dimension>
    description: <what it slices>
    values: [<enum>, <enum>]   # omit if continuous
source_attribution: <where data originates>
related_tables:
  - <table>: <relationship>
```

## Rules

- **Keep files under ~50 lines** (up to ~60 for canonical tables with `trust_score_inputs` — that section structurally adds ~12 lines). Compass, not encyclopedia (per Meta's April 2026 engineering blog on context engineering).
- **Use exact column names** from the SQL SSOT (`src/memory/schema/`). No aliases, no reformatting.
- **Update alongside schema changes.** A column rename in SQL without a paired YAML update is a regression.
- **No cross-file references.** Each file must be readable on its own.
