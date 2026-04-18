/**
 * Safety Ratings — ARGUS + Wyvern scrapers via self-hosted Firecrawl.
 *
 * INTERNAL USE ONLY. Data is used internally by Dumont's Sourcing agent
 * for operator ranking. NEVER display publicly, NEVER expose via public
 * API, NEVER redistribute. Refresh at most monthly — the 25-day guard
 * lives in scripts/refresh-safety-ratings.ts.
 *
 * Three sources:
 *   1. ARGUS Operator Registry  — argus.aero/operatorregistry (public page
 *      renders the list directly; no Quickbase hop needed).
 *   2. Wyvern Wingman Directory — app.wyvern.systems/public/directory/wingman
 *   3. Wyvern Registered        — app.wyvern.systems/public/directory/registered
 *
 * Each scraper returns partial per-source rows. Merging across sources into
 * the safety_ratings table + sync into faa_operators happens in the refresh
 * CLI, not here. This module is pure "fetch + parse → structured rows".
 *
 * Parser notes (from live Firecrawl responses, 2026-04):
 *   ARGUS row:  "# Operator Name\n---\n\nRating text"
 *               rating text ∈ {Gold, Gold Plus, Platinum, Platinum Elite}.
 *               aircraft_count + home_base_icao are NOT on the summary page;
 *               those fields stay null on first pass.
 *   Wyvern row: display name (plain line)
 *               \n city, state/country
 *               \n [optional Wingman/Flight-Leader badge images]
 *               \n **CERT_NUMBER  \n LEGAL_NAME**
 *               Wingman page = all rows wyvern_status='wingman'.
 *               Registered page = all rows wyvern_status='registered'.
 *               Both 'wingman_tall' and 'wingman_pro' badges normalize to
 *               'wingman' (schema CHECK doesn't split the pro tier).
 */

import { childLogger } from "../utils/logger.js";

const log = childLogger("safety-ratings-scrape");

const FIRECRAWL_URL = process.env["FIRECRAWL_URL"] ?? "http://localhost:3002";

const ARGUS_URL = "https://www.argus.aero/operatorregistry";
const WYVERN_WINGMAN_URL = "https://app.wyvern.systems/public/directory/wingman";
const WYVERN_REGISTERED_URL = "https://app.wyvern.systems/public/directory/registered";

// ── Types ────────────────────────────────────────────────────────────────

export type ArgusRating = "gold" | "gold_plus" | "platinum" | "platinum_elite";
export type WyvernStatus = "registered" | "wingman";

export interface ArgusRow {
  operator_name: string;
  argus_rating: ArgusRating;
  source_url: string;
}

export interface WyvernRow {
  operator_name: string;
  certificate_number: string | null;
  wyvern_status: WyvernStatus;
  wyvern_country: string | null;
  source_url: string;
}

// ── Firecrawl client ─────────────────────────────────────────────────────

interface FirecrawlResponse {
  success: boolean;
  data?: { markdown?: string };
  error?: string;
}

export async function scrapeFirecrawl(url: string, waitForMs = 4000): Promise<string> {
  const endpoint = `${FIRECRAWL_URL}/v1/scrape`;
  const body = JSON.stringify({ url, formats: ["markdown"], waitFor: waitForMs });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Firecrawl ${res.status} for ${url}: ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as FirecrawlResponse;
  if (!json.success || !json.data?.markdown) {
    throw new Error(`Firecrawl returned no markdown for ${url}: ${json.error ?? "unknown"}`);
  }
  return json.data.markdown;
}

// ── ARGUS parser ─────────────────────────────────────────────────────────

const ARGUS_RATING_MAP: Record<string, ArgusRating> = {
  "platinum elite": "platinum_elite",
  "platinum": "platinum",
  "gold plus": "gold_plus",
  "gold": "gold",
};

export function parseArgusMarkdown(md: string, sourceUrl = ARGUS_URL): ArgusRow[] {
  const rows: ArgusRow[] = [];
  const lines = md.split("\n");

  // Walk pairs: an H2 (Setext style: name\n---) followed a few lines later
  // by the rating text. The page opens with a header "Operator Registry"
  // (H1 with '=') so restrict to H2 ('-' underline) to avoid false positives.
  for (let i = 0; i < lines.length - 1; i++) {
    const name = lines[i]?.trim();
    const underline = lines[i + 1]?.trim();
    if (!name || !underline) continue;
    if (!/^-{3,}$/.test(underline)) continue;
    if (!name || name.length < 2) continue;
    // Skip the H1 promotional block.
    if (/^Operator Registry$/i.test(name)) continue;
    if (/^ARGUS Charter Operator Ratings/i.test(name)) continue;

    // Look ahead up to 6 non-empty lines for the rating text.
    let rating: ArgusRating | null = null;
    for (let j = i + 2; j < Math.min(i + 10, lines.length); j++) {
      const t = lines[j]?.trim();
      if (!t) continue;
      if (t.startsWith("![") || t.startsWith("[")) continue;
      const key = t.toLowerCase();
      if (key in ARGUS_RATING_MAP) {
        rating = ARGUS_RATING_MAP[key] ?? null;
        break;
      }
    }
    if (rating) {
      rows.push({ operator_name: name, argus_rating: rating, source_url: sourceUrl });
    }
  }
  return rows;
}

// ── Wyvern parser (shared between wingman + registered) ──────────────────

const BOLD_CERT_RE = /\*\*([^\n*]{2,40})\s*\n\s*([^*\n]{2,120})\*\*/g;

export function parseWyvernMarkdown(
  md: string,
  status: WyvernStatus,
  sourceUrl: string,
): WyvernRow[] {
  const rows: WyvernRow[] = [];

  // Each operator block ends with a **CERT  \n LEGAL_NAME** bold block.
  // Walk matches; for each, look backward (within the preceding ~10 lines)
  // for the most recent non-image, non-header, non-link plain line as the
  // operator display name, plus a line that looks like a location.
  const matches = [...md.matchAll(BOLD_CERT_RE)];
  for (const m of matches) {
    const cert = (m[1] ?? "").trim();
    const legalName = (m[2] ?? "").trim();
    if (!cert || !legalName) continue;

    const matchIdx = m.index ?? 0;
    const preceding = md.slice(Math.max(0, matchIdx - 600), matchIdx);
    const precedingLines = preceding.split("\n").map((l) => l.trim()).filter(Boolean);

    // Walk backward to find: (a) a country/city line, (b) the display name.
    let country: string | null = null;
    let displayName: string | null = null;
    for (let k = precedingLines.length - 1; k >= 0; k--) {
      const line = precedingLines[k];
      if (!line) continue;
      if (line.startsWith("![")) continue;
      if (line.startsWith("[") && line.endsWith(")")) continue;
      if (line.startsWith("**")) continue;
      if (/^-{3,}$/.test(line)) continue;
      if (/^=+$/.test(line)) continue;
      if (/^#+\s/.test(line)) continue;
      if (line === "Name") continue;
      if (/^A global list/i.test(line)) continue;
      if (/^Hundreds of operators/i.test(line)) continue;
      if (/^WYVERN/i.test(line)) continue;
      if (/^Back to WYVERN/i.test(line)) continue;

      if (!country && /,\s+[A-Za-z]/.test(line) && line.length < 120) {
        country = extractCountry(line);
        continue;
      }
      if (country && !displayName) {
        displayName = line;
        break;
      }
      if (!country && !displayName) {
        // No location line seen — accept this as the display name.
        displayName = line;
        break;
      }
    }

    if (!displayName) continue;
    rows.push({
      operator_name: displayName,
      certificate_number: cert || null,
      wyvern_status: status,
      wyvern_country: country,
      source_url: sourceUrl,
    });
  }
  return rows;
}

/** Extract the country from a "City, ST Country" or "City, Country" line. */
function extractCountry(locationLine: string): string | null {
  const parts = locationLine.split(",").map((s) => s.trim());
  const last = parts[parts.length - 1];
  if (!last) return null;
  // "CA United States" → "United States"; "United Kingdom" → "United Kingdom".
  const tokens = last.split(/\s+/);
  if (tokens.length >= 2 && /^[A-Z]{2}$/.test(tokens[0] ?? "")) {
    return tokens.slice(1).join(" ") || null;
  }
  return last || null;
}

// ── Public scraper functions ─────────────────────────────────────────────

export async function scrapeArgusOperators(): Promise<ArgusRow[]> {
  log.info({ url: ARGUS_URL }, "scraping ARGUS operator registry");
  const md = await scrapeFirecrawl(ARGUS_URL, 5000);
  const rows = parseArgusMarkdown(md, ARGUS_URL);
  log.info({ rows: rows.length }, "ARGUS parse complete");
  return rows;
}

export async function scrapeWyvernWingman(): Promise<WyvernRow[]> {
  log.info({ url: WYVERN_WINGMAN_URL }, "scraping Wyvern Wingman directory");
  const md = await scrapeFirecrawl(WYVERN_WINGMAN_URL, 4000);
  const rows = parseWyvernMarkdown(md, "wingman", WYVERN_WINGMAN_URL);
  log.info({ rows: rows.length }, "Wyvern Wingman parse complete");
  return rows;
}

export async function scrapeWyvernRegistered(): Promise<WyvernRow[]> {
  log.info({ url: WYVERN_REGISTERED_URL }, "scraping Wyvern Registered directory");
  const md = await scrapeFirecrawl(WYVERN_REGISTERED_URL, 4000);
  const rows = parseWyvernMarkdown(md, "registered", WYVERN_REGISTERED_URL);
  log.info({ rows: rows.length }, "Wyvern Registered parse complete");
  return rows;
}

export const URLS = {
  argus: ARGUS_URL,
  wyvern_wingman: WYVERN_WINGMAN_URL,
  wyvern_registered: WYVERN_REGISTERED_URL,
} as const;
