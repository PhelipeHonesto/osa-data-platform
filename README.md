# osa-data-platform

OSA aviation data platform: ingestion pipelines (ADS-B, FAA, NTSB, safety ratings), entity resolution (canonical operators + aircraft), and analytics compute (WINGX engine, data quality, embeddings). Writes to the shared Supabase cluster; consumed by `dumont-agent` over SQL — no HTTP API between the two repos.

See `WORKFLOW.md` for the dev workflow and `CLAUDE.md` for scope and conventions.
