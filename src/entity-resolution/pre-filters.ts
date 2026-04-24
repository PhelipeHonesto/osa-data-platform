/**
 * Pre-filter module for Stage 2b Checkpoint 3 (operator_aircraft_link backfill).
 *
 * Short-circuits input certificate_holder strings into specific "skip" buckets
 * BEFORE the operator resolver runs. The resolver is calibrated on ARGUS /
 * Wyvern operator names and trips up on individual-owner names, trustee LLCs,
 * and FAA placeholder sentinels — all of which should never reach it.
 *
 * Every skip is audit-logged to `canonical.operator_aircraft_resolution_log`
 * (see schema/canonical/operator_aircraft_resolution_log.sql) so new patterns
 * can be added to the config additions below as they surface — code change
 * is NOT required as long as the pattern is a trustee-suffix, explicit name,
 * or manufacturer.
 */

export type PreFilterBucket =
  | "skipped_null"
  | "skipped_placeholder"
  | "skipped_individual"
  | "skipped_trustee"
  | "skipped_manufacturer";

export interface PreFilterInput {
  certificateHolder: string | null;
  /**
   * FAA registrant_type code. '1' = Individual. Individual-owned aircraft
   * never reach the operator resolver — they are GA / owner-flown.
   */
  registrantType: string | null;
}

// FAA sentinels that occupy certificate_holder when the real value is
// missing, pending, or administratively frozen.
const PLACEHOLDER_VALUES = new Set([
  "-",
  "REGISTRATION PENDING",
  "SALE REPORTED",
]);

// Explicit trustee names. Checked via substring (uppercase) on the
// certificate_holder. Add entries here, not in code, when new trustee
// patterns surface in the resolution log.
const TRUSTEE_NAMES: readonly string[] = [
  "BANK OF UTAH",
  "TVPX AIRCRAFT SOLUTIONS",
  "TVPX ARS",
  "WILMINGTON TRUST",
  "UMB BANK NA",
  "WELLS FARGO TRUST",
  "WELLS FARGO BANK NORTHWEST",
  "U S BANK NA",
  "CSC DELAWARE TRUST",
  "AIRCRAFT GUARANTY CORP",
  "SOUTHERN AIRCRAFT CONSULTANCY",
  "INTERNATIONAL AIR SERVICES",
  "AEROSPACE TRUST MANAGEMENT",
  "AVIATION TRUST COMPANY",
  "AIRCRAFT TRUST",
  "REGIONS BANK TRUSTEE",
  "DEUTSCHE BANK TRUST COMPANY",
] as const;

// Manufacturers that hold aircraft registrations pre-delivery or for
// demonstration fleets. These are not operators.
const MANUFACTURER_NAMES: readonly string[] = [
  "CIRRUS DESIGN CORP",
  "TEXTRON AVIATION INC",
  "BOEING COMPANY",
  "AIRBUS HELICOPTERS",
  "BOMBARDIER INC",
  "GULFSTREAM AEROSPACE CORP",
  "EMBRAER EXECUTIVE AIRCRAFT",
] as const;

// "BOARD OF TRUSTEES OF <UNIVERSITY>" is university governance, not an
// aircraft trustee. Explicit exception so the TRUSTEE regex doesn't catch it.
const TRUSTEE_EXCEPTION_PREFIXES: readonly string[] = [
  "BOARD OF TRUSTEES OF",
] as const;

/**
 * Classify a certificate_holder into a skip bucket, or return null to
 * indicate "resolver should run on this row."
 *
 * Priority order (each step short-circuits):
 *   1. null certificate_holder                    → skipped_null
 *   2. placeholder values ('-', 'REGISTRATION PENDING', 'SALE REPORTED')
 *                                                 → skipped_placeholder
 *   3. registrant_type = '1' (individual)         → skipped_individual
 *   4. trustee suffix or explicit name            → skipped_trustee
 *   5. manufacturer name                          → skipped_manufacturer
 *   6. (pass through — resolver runs)             → null
 */
export function preFilter(input: PreFilterInput): PreFilterBucket | null {
  const ch = input.certificateHolder;
  if (ch === null) return "skipped_null";

  const trimmed = ch.trim();
  if (trimmed === "" || PLACEHOLDER_VALUES.has(trimmed)) return "skipped_placeholder";

  if (input.registrantType === "1") return "skipped_individual";

  const upper = trimmed.toUpperCase();

  // Exception: BOARD OF TRUSTEES OF <university> is not a trustee.
  const isTrusteeException = TRUSTEE_EXCEPTION_PREFIXES.some((p) => upper.startsWith(p));

  if (!isTrusteeException) {
    // Trustee suffix (most common pattern — 9.6K+ rows).
    if (/\bTRUSTEE\s*$/.test(upper)) return "skipped_trustee";
    // Explicit trustee names (some don't end in TRUSTEE).
    for (const name of TRUSTEE_NAMES) {
      if (upper.includes(name)) return "skipped_trustee";
    }
  }

  if (MANUFACTURER_NAMES.includes(upper)) return "skipped_manufacturer";

  return null;
}

// Exported for tests.
export const _TRUSTEE_NAMES = TRUSTEE_NAMES;
export const _MANUFACTURER_NAMES = MANUFACTURER_NAMES;
export const _PLACEHOLDER_VALUES = PLACEHOLDER_VALUES;
