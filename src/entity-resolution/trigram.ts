/**
 * Trigram Jaccard similarity (pg_trgm-style, TypeScript implementation).
 *
 * Strings are lowercased and padded with a leading double-space + trailing
 * double-space so short strings still produce multiple trigrams. Similarity
 * is |intersection| / |union| of the trigram sets.
 *
 * Used alongside Jaro-Winkler in match-scoring.computeNameSim — the two
 * metrics catch different edge cases (JW rewards prefix overlap; trigram
 * is robust to reordering).
 */

function pad(s: string): string {
  return `  ${s.toLowerCase()}  `;
}

export function trigrams(s: string): Set<string> {
  const padded = pad(s);
  const out = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i++) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  // Empty-empty is not a match (missing data can't confirm identity).
  // Check before the equality shortcut.
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let intersect = 0;
  for (const g of ta) if (tb.has(g)) intersect++;
  const union = ta.size + tb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}
