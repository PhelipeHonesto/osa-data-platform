/**
 * Jaro + Jaro-Winkler string similarity. Pure functions, no deps.
 *
 * Jaro distance measures character-level similarity within a sliding window
 * and counts half-transpositions. Jaro-Winkler adds a boost for strings
 * sharing a common prefix (max 4 chars), which lines up with how operator
 * names read ("NetJets Aviation" vs "NetJets Sales").
 *
 * Scores are 0.0–1.0; identical strings → 1.0, disjoint → 0.0.
 * Used by match-scoring.ts as one of two name-similarity signals (the other
 * is trigram overlap; the matcher takes max(jw, trigram)).
 */

export function jaro(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  // Empty-empty is not a match for entity resolution: missing data can't
  // confirm identity. Check this before the equality shortcut.
  if (la === 0 || lb === 0) return 0;
  if (a === b) return 1;

  const matchWindow = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatched = new Array<boolean>(la).fill(false);
  const bMatched = new Array<boolean>(lb).fill(false);

  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(lb, i + matchWindow + 1);
    for (let j = start; j < end; j++) {
      if (bMatched[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const m = matches;
  return (m / la + m / lb + (m - transpositions / 2) / m) / 3;
}

/**
 * Jaro-Winkler similarity. `p` is the prefix scale (standard = 0.1); boost
 * only applies when the base Jaro score is ≥ 0.7 to avoid rewarding
 * coincidental prefix matches on otherwise-dissimilar strings.
 */
export function jaroWinkler(a: string, b: string, p = 0.1): number {
  const j = jaro(a, b);
  if (j < 0.7) return j;
  const max = Math.min(4, Math.min(a.length, b.length));
  let l = 0;
  while (l < max && a[l] === b[l]) l++;
  return j + l * p * (1 - j);
}
