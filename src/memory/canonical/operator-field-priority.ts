/**
 * Source-priority rules for canonical operator fields.
 *
 * When multiple sources supply a value for the same field, these pickers
 * resolve the conflict per Q4 of the Phase 1 plan:
 *   - canonical_name:  longest non-truncated value; tiebreak by source priority
 *   - type_tags:       union across sources (multi-valued — not a conflict)
 *   - headquarters_icao: strict source priority (FAA > ARGUS > ...)
 *
 * Phase 2+ fields (fleet_size, reliability_score, ...) add their own pickers.
 *
 * Pure functions, no side effects.
 */

export type Source = "faa" | "argus" | "wyvern" | "isbao" | "adsb" | "manual";

/** Lower number = higher priority. Matches the authority hierarchy. */
export const SOURCE_PRIORITY: Readonly<Record<Source, number>> = {
  faa: 1,
  argus: 2,
  wyvern: 3,
  isbao: 4,
  adsb: 5,
  manual: 6,
};

export interface CandidateValue<T> {
  value: T;
  source: Source;
}

function bySourcePriority(a: { source: Source }, b: { source: Source }): number {
  return SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
}

/**
 * Canonical name picker. Prefers longer values (avoids picking a truncated
 * ARGUS display name over the full FAA legal name), tiebreaks on source
 * priority so deterministic-authority sources win equal-length ties.
 * Heuristically rejects candidates ending in "..." or "…" as truncated.
 */
export function pickCanonicalName(
  candidates: Array<CandidateValue<string>>,
): string | null {
  if (candidates.length === 0) return null;
  const notTruncated = candidates.filter(
    (c) => !c.value.endsWith("...") && !c.value.endsWith("…"),
  );
  const pool = notTruncated.length > 0 ? notTruncated : candidates;
  const sorted = [...pool].sort((a, b) => {
    if (b.value.length !== a.value.length) return b.value.length - a.value.length;
    return bySourcePriority(a, b);
  });
  return sorted[0]?.value ?? null;
}

/** Headquarters ICAO picker — strict source priority, no length tiebreak. */
export function pickHeadquartersIcao(
  candidates: Array<CandidateValue<string>>,
): string | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort(bySourcePriority);
  return sorted[0]?.value ?? null;
}

/**
 * Union of type_tags across sources, deduped, order-stable by source priority
 * (FAA-supplied tags appear first). Preserves input order within a single
 * source. Output is a fresh array — safe to mutate.
 */
export function mergeTypeTags(
  candidates: Array<CandidateValue<string[]>>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const sorted = [...candidates].sort(bySourcePriority);
  for (const c of sorted) {
    for (const tag of c.value) {
      if (!seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
    }
  }
  return out;
}
