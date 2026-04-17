# Known Issues

## adsb_completed_legs data contamination (2026-04-16)

**Status:** Known bad data, rebuild deferred

**Details:**
The leg detection code had a timestamp bug (fixed in commit 8a09e23 on
2026-04-16) that affected ALL legs detected before that fix. The table
contains ~5.9M legs covering Dec 2023 → April 2026, of which:
- ~200K are obviously broken (departure clustered at 00:00:00 UTC)
- ~10-20% are subtly broken (midnight-crossers with wrong origin/time)
- ~75-85% are probably clean

**Impact:**
- Do NOT use adsb_completed_legs for production queries
- Aggregate counts roughly correct
- Route-specific queries unsafe
- Historical replay features will show artifacts

**Resolution plan:**
When building features that need clean legs:
1. Bulk restore tars from Glacier (~$8, 5-12hr wait)
2. DELETE FROM adsb_completed_legs + reset backfill_progress
3. Re-run history-backfill with --s3-only flag (code ready)

**What's safe to use in the meantime:**
- adsb_aircraft_state (computed by live feed, not affected)
- adsb_positions (hot tier, fresh data only)
- faa_aircraft, faa_operators (not affected)
- knowledge_graph (rebuilt nightly by update-graph.ts)
