/**
 * Safety Ratings — fuzzy operator-name matching.
 *
 * INTERNAL USE ONLY. Used by Dumont's safety-ratings ingestion (both the
 * legacy JSON-seed path in safety-ratings.ts and the new scrape-based path
 * in safety-ratings-scrape.ts / scripts/refresh-safety-ratings.ts) to match
 * scraped operator names against faa_operators.name. Not for public display.
 *
 * Extracted from safety-ratings.ts to share one matcher across ingestion
 * paths — behavior must stay byte-identical with the original.
 */

/** Normalize operator name for fuzzy matching. */
export function normalize(name: string): string {
  return name
    .toUpperCase()
    .replace(/[,.'"\-]/g, " ")
    .replace(/\b(LLC|INC|CORP|CORPORATION|CO|LTD|LP|GROUP|PARTNERS|HOLDINGS|AVIATION|AIR|SERVICES|MANAGEMENT)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Check if normalized names are a fuzzy match. */
export function fuzzyMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;

  // Skip joint-ownership entries (commas in original name = multiple entities).
  if (b.includes(",") && b.split(",").length > 2) return false;

  // One contains the other, with a 50% length floor so "JET" doesn't match everything.
  if (na.length >= 4 && nb.length >= 4) {
    if (na === nb) return true;
    const shorter = na.length <= nb.length ? na : nb;
    const longer = na.length > nb.length ? na : nb;
    if (longer.includes(shorter) && shorter.length / longer.length >= 0.5) return true;
  }

  // All words of the shorter appear in the longer (exact word match).
  const wordsA = na.split(" ").filter((w) => w.length >= 3);
  const wordsB = nb.split(" ").filter((w) => w.length >= 3);
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  const [shorterWords, longerWords] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  if (shorterWords.length >= 2 && longerWords.length <= shorterWords.length + 1
    && shorterWords.every((w) => longerWords.includes(w))) {
    return true;
  }
  return false;
}
