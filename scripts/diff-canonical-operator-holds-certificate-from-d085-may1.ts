/**
 * Phase 2 Script 3 — diff canonical.operator_holds_certificate against May 1 D085.
 *
 * Path A diff-and-apply per /Users/phelipehonesto/.claude/plans/peppy-roaming-babbage.md.
 *
 * Reads the May 1 D085 xlsx, resolves each (cert × holder_name) pair to an
 * operator_id via two-tier matching, classifies against the current
 * canonical.operator_holds_certificate state, and writes:
 *
 *   Case 1 (no-op):   May 1 resolved-operator matches existing open ohc → skip
 *   Case 2 (close):   existing open ohc cert IS in May 1 BUT May 1 resolves
 *                     a DIFFERENT operator (rebrand), or cert NOT in May 1
 *                     (cert gone) → UPDATE valid_to
 *   Case 3 (insert):  May 1 cert resolves to operator with no existing open ohc
 *                     for that (cert, operator) → INSERT new open window
 *   sidecar (review): Tier 2 review-tier or downgraded by gates → INSERT into
 *                     public.operator_match_review (only when cert isn't already
 *                     covered by an open ohc — to avoid duplicating with Case 1)
 *   sidecar (no_match): Tier 3 (no Tier 1 or Tier 2 high/medium match) → INSERT
 *                       into canonical.operator_holds_certificate_pending
 *
 * Two-tier matching (Tier 1 deterministic, Tier 2 resolver+gates, Tier 3 sidecar):
 *
 *   Tier 1 — deterministic exact:
 *     Normalize: UPPER(REGEXP_REPLACE(TRIM(name), '\s+', ' ')).
 *     If exactly one operator normalizes to the same string → match, confidence=0.95.
 *     If multiple operators collide on normalized string → ambiguous, fall through.
 *
 *   Tier 2 — resolver with gate-tightening (only for Tier 1 misses):
 *     Invokes scoreCandidates + decide from src/entity-resolution/operator-resolver.ts.
 *     Applies docs/phase1-followups.md Step 2c.6 Item 2 gates:
 *       1. top_score - runner_up_score >= 0.15 (when runner_up exists);
 *          NULL runner_up keeps existing top-score check.
 *       2. Load-bearing-noun gate: tokenize both names. If both contain a
 *          non-Aviation load-bearing noun and the sets don't intersect, downgrade
 *          to review tier. Aviation is excluded as a singleton gate (overlaps
 *          with most other markers — e.g. "Aviation" vs "Aviation Services"
 *          should NOT fire).
 *     Emits: matched-high (≥0.91, gates pass), matched-medium (≥0.75), review,
 *     no_match.
 *
 *   Tier 3 — sidecar (Tier 2 also no high/medium match):
 *     INSERT into ohcp with reason='no_canonical_operator_candidate' (existing
 *     CHECK value — no schema migration). Tier info goes in evidence JSONB.
 *
 * valid_to=2026-05-01 reflects the snapshot date at which the relationship was
 * observed absent, not the actual termination date which is unknown within the
 * [2026-02-16, 2026-05-01] gap.
 *
 * Resolver work runs read-only BEFORE the write transaction — never holds a
 * write tx during the 1,791-candidate Jaro-Winkler pass.
 *
 * Source slug: 'faa_d085_2026_05_01' for new INSERTs.
 *
 * EXCLUDE-collision check: Case 1 detection no-ops the seed-source overlap (when
 * an existing open ohc — e.g. from 'faa_d085_seed' — covers the same
 * (cert_id, operator_id, role)). Case 3 INSERTs are by-construction outside
 * any existing open window for that triple.
 *
 * Pre-execution surfaced numbers:
 *   - May 1 (cert × holder) pairs: 1,791 (1:1 cert→holder)
 *   - Existing open ohc rows (any source): 1,454 (108 faa_d085 + 1,346 faa_d085_seed)
 *   - Tier counts: TBD (resolver pass surfaces these in dry-run)
 *
 * Usage:
 *   tsx scripts/diff-canonical-operator-holds-certificate-from-d085-may1.ts                   # dry-run
 *   tsx scripts/diff-canonical-operator-holds-certificate-from-d085-may1.ts --write           # commit
 *   tsx scripts/diff-canonical-operator-holds-certificate-from-d085-may1.ts --local-xlsx=...  # local file
 */

import "dotenv/config";
import fs from "node:fs";
import pg from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import {
  type D085Row,
  CERT_REGEX_FAA_DESIGNATOR,
  S3_BUCKET,
  fetchS3Buffer,
  parseD085Xlsx,
} from "../src/utils/d085-parser.js";
import {
  type OperatorCandidate,
  scoreCandidates,
  decide,
  firstSignificantWord,
} from "../src/entity-resolution/operator-resolver.js";
import type { Source } from "../src/entity-resolution/operator-field-priority.js";

// ── Constants ─────────────────────────────────────────────────────────────

const SOURCE_NEW = "faa_d085_2026_05_01";
const STEP_TAG = "step2c_2026_05_01";
const ROLE = "holder_of_record";
const MAY1_DATE = "2026-05-01";
const MAY1_SOURCE_TIMESTAMP = "2026-05-01T17:20:56Z";
const MAY1_XLSX_S3_KEY =
  "raw/faa/d085/xlsx/20260501172056__Part_135_Operators_and_Aircraft_List.xlsx";
const CHECKPOINT = "phase2_script3_may1_ohc_diff";

// Gate-tightening thresholds per docs/phase1-followups.md §Step 2c.6 Item 2.
const GAP_REQUIRED = 0.15;
const LOAD_BEARING_NOUNS = new Set([
  "AIRCRAFT",
  "FLIGHT",
  "AIR",
  "AIRWAYS",
  "JET",
  "JETS",
  "CHARTER",
  "CHARTERS",
  "SERVICE",
  "SERVICES",
  "AIRLINES",
]);
// "AVIATION" is intentionally NOT in LOAD_BEARING_NOUNS — overlaps with most
// other markers; gate should not fire on Aviation alone (e.g. "Aviation" vs
// "Aviation Services" must remain a match per docs/phase1-followups.md).

// ── Types ─────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
  localXlsx: string | null;
}

type Tier = "tier_1" | "tier_2_high" | "tier_2_medium" | "tier_2_review" | "tier_3";

interface MatchOutcome {
  cert_designator: string;
  cert_id: string;
  holder_name: string;
  holder_normalized: string;
  tier: Tier;
  operator_id: string | null;
  canonical_name: string | null;
  match_method: string;
  confidence: number;
  top_score: number | null;
  runner_up_score: number | null;
  reason: string | null;
  candidate_matches: Array<{ operator_id: string; canonical_name: string; score: number }>;
  gate_failures: string[];
}

interface OpenOhcRow {
  id: string;
  cert_id: string;
  operator_id: string;
  role: string;
  source: string;
  valid_from: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const localFlag = args.find((a) => a.startsWith("--local-xlsx="));
  return {
    write,
    localXlsx: localFlag ? localFlag.split("=")[1]! : null,
  };
}

function formatRunId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Normalize for Tier-1 deterministic match. */
function normalizeHolder(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

/** Tokenize and return upper-case alphabetic-only tokens. */
function tokenize(name: string): string[] {
  return name
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, "").toUpperCase())
    .filter((w) => w.length > 0);
}

/** Load-bearing nouns present in the name (excluding Aviation). */
function loadBearingNounsIn(name: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(name)) {
    if (LOAD_BEARING_NOUNS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Gate: returns true if both names contain non-Aviation load-bearing nouns
 * AND those sets do not intersect (mismatch). Aviation excluded entirely.
 */
function loadBearingNounMismatch(holderName: string, canonicalName: string): boolean {
  const h = loadBearingNounsIn(holderName);
  const c = loadBearingNounsIn(canonicalName);
  if (h.size === 0 || c.size === 0) return false;
  for (const n of h) if (c.has(n)) return false;
  return true;
}

function pairKeyOhc(cert_id: string, operator_id: string, role: string): string {
  return `${cert_id}\x1f${operator_id}\x1f${role}`;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const runId = formatRunId();
  const cs = process.env["SUPABASE_DATABASE_URL"];
  if (!cs) {
    console.error("SUPABASE_DATABASE_URL not set. Add it to .env.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const s3 = new S3Client({});

  console.log(`[may1-ohc-diff] run_id=${runId}`);
  console.log(`[may1-ohc-diff] mode=${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`[may1-ohc-diff] source_new=${SOURCE_NEW}`);

  // ────────────────────────────────────────────────────────────────────────
  // PHASE A: read-only — parse, resolve, classify (no transaction)
  // ────────────────────────────────────────────────────────────────────────

  // Step 1: load May 1 xlsx
  let buf: Buffer;
  if (args.localXlsx) {
    console.log(`[may1-ohc-diff] reading local xlsx: ${args.localXlsx}`);
    buf = fs.readFileSync(args.localXlsx);
  } else {
    console.log(`[may1-ohc-diff] fetching s3://${S3_BUCKET}/${MAY1_XLSX_S3_KEY}`);
    buf = await fetchS3Buffer(s3, MAY1_XLSX_S3_KEY);
  }
  const rows: D085Row[] = parseD085Xlsx(buf, MAY1_XLSX_S3_KEY);
  console.log(`[may1-ohc-diff] parsed ${rows.length} rows`);

  // Step 2: extract distinct (cert, holder) pairs
  const certHolders = new Map<string, string>();
  let skippedCertFmt = 0;
  let skippedNoHolder = 0;
  for (const r of rows) {
    if (!r.cert_number) continue;
    const certUpper = r.cert_number.toUpperCase();
    if (!CERT_REGEX_FAA_DESIGNATOR.test(certUpper)) {
      skippedCertFmt++;
      continue;
    }
    if (!r.holder_name) {
      skippedNoHolder++;
      continue;
    }
    if (!certHolders.has(certUpper)) certHolders.set(certUpper, r.holder_name.trim());
  }
  console.log(`[may1-ohc-diff] distinct (cert × holder) pairs: ${certHolders.size}`);
  console.log(`[may1-ohc-diff] skips: cert_fmt=${skippedCertFmt}, no_holder=${skippedNoHolder}`);

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '600s'`);

    // Step 3: resolve cert_designator → cert_id
    const certRes = await client.query<{ cert_id: string; faa_cert_number: string }>(
      `SELECT cert_id, faa_cert_number FROM canonical.certificates
        WHERE cert_authority='faa' AND faa_cert_number IS NOT NULL`,
    );
    const certByDesignator = new Map<string, string>();
    for (const r of certRes.rows) certByDesignator.set(r.faa_cert_number.toUpperCase(), r.cert_id);
    console.log(`[may1-ohc-diff] certs loaded: ${certByDesignator.size}`);

    // Step 4: load operators with normalized canonical_name pre-computed
    const opsRes = await client.query<{
      operator_id: string;
      canonical_name: string;
      headquarters_icao: string | null;
    }>(
      `SELECT id AS operator_id, canonical_name, headquarters_icao FROM operators`,
    );
    const candidatePool: OperatorCandidate[] = opsRes.rows.map((r) => ({
      operator_id: r.operator_id,
      canonical_name: r.canonical_name,
      headquarters_icao: r.headquarters_icao,
      state: null,
      city: null,
    }));
    console.log(`[may1-ohc-diff] operators loaded: ${candidatePool.length}`);

    // Tier 1 lookup: normalized → operator_id (handle collisions by recording all)
    const tier1Index = new Map<string, string[]>();
    for (const c of candidatePool) {
      const k = normalizeHolder(c.canonical_name);
      if (!tier1Index.has(k)) tier1Index.set(k, []);
      tier1Index.get(k)!.push(c.operator_id);
    }
    console.log(`[may1-ohc-diff] tier-1 distinct normalized canonical names: ${tier1Index.size}`);

    // Step 5: per-cert resolution (Tier 1 → Tier 2 → Tier 3)
    console.log(`\n[may1-ohc-diff] resolving ${certHolders.size} (cert × holder) pairs...`);
    const tStart = Date.now();
    const outcomes: MatchOutcome[] = [];
    let tierCount = { tier_1: 0, tier_2_high: 0, tier_2_medium: 0, tier_2_review: 0, tier_3: 0 };

    for (const [certDesignator, holderName] of certHolders) {
      const certId = certByDesignator.get(certDesignator);
      if (!certId) {
        // Should never happen (Script 1 added all May 1 certs).
        console.warn(`[may1-ohc-diff]   skipped: cert ${certDesignator} not in canonical (post-Script-1 anomaly)`);
        continue;
      }
      const holderNorm = normalizeHolder(holderName);

      // Tier 1
      const t1Hits = tier1Index.get(holderNorm) ?? [];
      if (t1Hits.length === 1) {
        const operator_id = t1Hits[0]!;
        const canonical = candidatePool.find((c) => c.operator_id === operator_id)!;
        outcomes.push({
          cert_designator: certDesignator,
          cert_id: certId,
          holder_name: holderName,
          holder_normalized: holderNorm,
          tier: "tier_1",
          operator_id,
          canonical_name: canonical.canonical_name,
          match_method: "d085_holder_exact_normalized",
          confidence: 0.95,
          top_score: 1.0,
          runner_up_score: null,
          reason: null,
          candidate_matches: [{ operator_id, canonical_name: canonical.canonical_name, score: 1.0 }],
          gate_failures: [],
        });
        tierCount.tier_1++;
        continue;
      }

      // Tier 2 — resolver + gates (in-memory pre-filter on candidate pool)
      const word = firstSignificantWord(holderName).toLowerCase();
      const filtered = word
        ? candidatePool.filter((c) => c.canonical_name.toLowerCase().includes(word))
        : [];
      const scored = scoreCandidates(
        { name: holderName, source: "faa" as Source, sourceId: "_phase2_script3_lookup" },
        filtered,
      );
      const decision = decide(scored);
      const top = scored[0] ?? null;
      const runner = scored[1] ?? null;
      const top3 = scored.slice(0, 3).map((c) => ({
        operator_id: c.operator_id,
        canonical_name: c.canonical_name,
        score: c.score,
      }));

      const gateFailures: string[] = [];
      let finalAction = decision.action;
      let finalConfidence: "high" | "medium" | "low" = decision.confidence;

      if (finalAction === "matched" && finalConfidence === "high" && top) {
        // Gate 1: gap >= 0.15 when runner exists
        if (runner && top.score - runner.score < GAP_REQUIRED) {
          gateFailures.push("gap_below_0.15");
          finalAction = "review";
        }
        // Gate 2: load-bearing-noun mismatch
        if (loadBearingNounMismatch(holderName, top.canonical_name)) {
          gateFailures.push("load_bearing_noun_mismatch");
          finalAction = "review";
        }
      }

      if (finalAction === "matched") {
        if (finalConfidence === "high") {
          outcomes.push({
            cert_designator: certDesignator,
            cert_id: certId,
            holder_name: holderName,
            holder_normalized: holderNorm,
            tier: "tier_2_high",
            operator_id: top!.operator_id,
            canonical_name: top!.canonical_name,
            match_method: "d085_holder_resolver_tier_2",
            confidence: 0.95,
            top_score: top!.score,
            runner_up_score: runner?.score ?? null,
            reason: null,
            candidate_matches: top3,
            gate_failures: [],
          });
          tierCount.tier_2_high++;
        } else {
          // medium
          outcomes.push({
            cert_designator: certDesignator,
            cert_id: certId,
            holder_name: holderName,
            holder_normalized: holderNorm,
            tier: "tier_2_medium",
            operator_id: top!.operator_id,
            canonical_name: top!.canonical_name,
            match_method: "d085_holder_resolver_tier_2",
            confidence: 0.85,
            top_score: top!.score,
            runner_up_score: runner?.score ?? null,
            reason: null,
            candidate_matches: top3,
            gate_failures: [],
          });
          tierCount.tier_2_medium++;
        }
      } else if (finalAction === "review") {
        outcomes.push({
          cert_designator: certDesignator,
          cert_id: certId,
          holder_name: holderName,
          holder_normalized: holderNorm,
          tier: "tier_2_review",
          operator_id: null,
          canonical_name: top?.canonical_name ?? null,
          match_method: "d085_holder_resolver_tier_2",
          confidence: 0.0,
          top_score: top?.score ?? null,
          runner_up_score: runner?.score ?? null,
          reason: decision.reason ?? (gateFailures.length > 0 ? "gate_downgrade" : null),
          candidate_matches: top3,
          gate_failures: gateFailures,
        });
        tierCount.tier_2_review++;
      } else {
        // 'new' from decide → tier 3 sidecar
        outcomes.push({
          cert_designator: certDesignator,
          cert_id: certId,
          holder_name: holderName,
          holder_normalized: holderNorm,
          tier: "tier_3",
          operator_id: null,
          canonical_name: null,
          match_method: "tier_3_sidecar",
          confidence: 0.0,
          top_score: top?.score ?? null,
          runner_up_score: runner?.score ?? null,
          reason: null,
          candidate_matches: top3,
          gate_failures: gateFailures,
        });
        tierCount.tier_3++;
      }
    }

    const resolveMs = Date.now() - tStart;
    console.log(`[may1-ohc-diff] resolution wall: ${(resolveMs / 1000).toFixed(1)}s`);
    console.log(`[may1-ohc-diff] tier distribution:`);
    console.log(`  tier_1 (deterministic exact):  ${tierCount.tier_1}`);
    console.log(`  tier_2 high:                   ${tierCount.tier_2_high}`);
    console.log(`  tier_2 medium:                 ${tierCount.tier_2_medium}`);
    console.log(`  tier_2 review (gate downgrade or decide=review): ${tierCount.tier_2_review}`);
    console.log(`  tier_3 (sidecar / no_match):   ${tierCount.tier_3}`);

    // Sample 5 from each tier
    const sampleByTier = (tier: Tier, n = 5) => outcomes.filter((o) => o.tier === tier).slice(0, n);
    for (const tier of ["tier_1", "tier_2_high", "tier_2_medium", "tier_2_review", "tier_3"] as Tier[]) {
      const s = sampleByTier(tier);
      if (s.length === 0) continue;
      console.log(`\n[may1-ohc-diff] sample ${s.length} from ${tier}:`);
      for (const o of s) {
        const top = o.top_score?.toFixed(3) ?? "null";
        const ru = o.runner_up_score?.toFixed(3) ?? "null";
        const gates = o.gate_failures.length > 0 ? ` [gates: ${o.gate_failures.join(",")}]` : "";
        console.log(
          `  - ${o.cert_designator} | "${o.holder_name}" → ` +
            (o.canonical_name ? `"${o.canonical_name}"` : "(no match)") +
            ` (top=${top}, ru=${ru})${gates}`,
        );
      }
    }

    // Step 6: load all open ohc rows (any source)
    console.log(`\n[may1-ohc-diff] loading existing open ohc rows...`);
    const ohcRes = await client.query<OpenOhcRow>(
      `SELECT id::text AS id, cert_id::text AS cert_id, operator_id::text AS operator_id,
              role, source, valid_from::text AS valid_from
         FROM canonical.operator_holds_certificate
        WHERE valid_to IS NULL`,
    );
    const openOhcByPair = new Map<string, OpenOhcRow>();
    const openOhcByCert = new Map<string, OpenOhcRow[]>();
    const openSourceCounts = new Map<string, number>();
    for (const r of ohcRes.rows) {
      openOhcByPair.set(pairKeyOhc(r.cert_id, r.operator_id, r.role), r);
      if (!openOhcByCert.has(r.cert_id)) openOhcByCert.set(r.cert_id, []);
      openOhcByCert.get(r.cert_id)!.push(r);
      openSourceCounts.set(r.source, (openSourceCounts.get(r.source) ?? 0) + 1);
    }
    console.log(`[may1-ohc-diff]   open ohc total: ${ohcRes.rows.length}`);
    for (const [src, n] of openSourceCounts) console.log(`[may1-ohc-diff]     source='${src}': ${n}`);

    // Step 7: classify cases (against all-source open ohc)
    const may1ResolvedTriples = new Set<string>(); // (cert_id, operator_id, role)
    const may1CertSet = new Set<string>();
    const case1NoOp: MatchOutcome[] = [];
    const case3Insert: MatchOutcome[] = [];
    const sidecarReview: MatchOutcome[] = [];
    const sidecarNoMatch: MatchOutcome[] = [];

    for (const o of outcomes) {
      may1CertSet.add(o.cert_id);
      if (o.tier === "tier_3") {
        sidecarNoMatch.push(o);
        continue;
      }
      if (o.tier === "tier_2_review") {
        sidecarReview.push(o);
        continue;
      }
      // matched (tier_1, tier_2_high, tier_2_medium)
      const k = pairKeyOhc(o.cert_id, o.operator_id!, ROLE);
      may1ResolvedTriples.add(k);
      if (openOhcByPair.has(k)) {
        case1NoOp.push(o);
      } else {
        case3Insert.push(o);
      }
    }

    const case2CloseRebrand: OpenOhcRow[] = [];
    const case2CloseCertGone: OpenOhcRow[] = [];
    for (const [k, row] of openOhcByPair) {
      if (may1ResolvedTriples.has(k)) continue; // Case 1
      if (may1CertSet.has(row.cert_id)) {
        case2CloseRebrand.push(row); // cert in May 1 but resolved to different operator (or sidecar)
      } else {
        case2CloseCertGone.push(row); // cert not in May 1 (surrendered/expired)
      }
    }

    console.log(`\n[may1-ohc-diff] case classification (against all-source open ohc):`);
    console.log(`  Case 1 (no-op):                    ${case1NoOp.length}`);
    console.log(`  Case 2 (close, rebrand/diff op):    ${case2CloseRebrand.length}`);
    console.log(`  Case 2 (close, cert gone):          ${case2CloseCertGone.length}`);
    console.log(`  Case 3 (insert):                    ${case3Insert.length}`);
    console.log(`  sidecar review (omr):               ${sidecarReview.length}`);
    console.log(`  sidecar no_match (ohcp):            ${sidecarNoMatch.length}`);

    // Top-20 unresolved holder names
    const t3HolderCount = new Map<string, number>();
    for (const o of sidecarNoMatch) {
      t3HolderCount.set(o.holder_name, (t3HolderCount.get(o.holder_name) ?? 0) + 1);
    }
    const top20 = Array.from(t3HolderCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    if (top20.length > 0) {
      console.log(`\n[may1-ohc-diff] top 20 unresolved (tier_3) holder names:`);
      for (const [h, n] of top20) console.log(`  ${n.toString().padStart(3)} × "${h}"`);
    }

    // ────────────────────────────────────────────────────────────────────────
    // PHASE B: write transaction (tight)
    // ────────────────────────────────────────────────────────────────────────

    await client.query("BEGIN");
    const startWrite = Date.now();

    let case2RebrandUpdated = 0, case2CertGoneUpdated = 0;
    let case3Inserted = 0, reviewInserted = 0, noMatchInserted = 0;

    // Case 2: close existing open ohc rows
    for (const r of [...case2CloseRebrand, ...case2CloseCertGone]) {
      const isRebrand = case2CloseRebrand.includes(r);
      const cbEntry = {
        source: SOURCE_NEW,
        source_url: `s3://${S3_BUCKET}/${MAY1_XLSX_S3_KEY}`,
        source_timestamp: MAY1_SOURCE_TIMESTAMP,
        ingestion_date: new Date().toISOString(),
        evidence: isRebrand
          ? "may_1_resolved_to_different_operator_or_unresolvable"
          : "cert_observed_absent_on_may_1",
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      const upd = await client.query(
        `UPDATE canonical.operator_holds_certificate
            SET valid_to = $2::date,
                last_updated_at = NOW(),
                corroborated_by = COALESCE(corroborated_by, '[]'::jsonb) || jsonb_build_array($3::jsonb)
          WHERE id = $1
            AND valid_to IS NULL`,
        [r.id, MAY1_DATE, JSON.stringify(cbEntry)],
      );
      if (upd.rowCount === 1) {
        if (isRebrand) case2RebrandUpdated++;
        else case2CertGoneUpdated++;
      }
    }

    // Case 3: INSERT new open ohc rows
    for (const o of case3Insert) {
      const evidence = {
        xlsx_s3_key: MAY1_XLSX_S3_KEY,
        cert_designator: o.cert_designator,
        holder_name_as_provided: o.holder_name,
        holder_name_normalized: o.holder_normalized,
        canonical_name: o.canonical_name,
        tier: o.tier,
        match_method: o.match_method,
        top_score: o.top_score,
        runner_up_score: o.runner_up_score,
        snapshot_date: MAY1_DATE,
        ambiguous_valid_from_note: "first observed 2026-05-01 after 10-week gap; actual relationship start may be earlier",
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      await client.query(
        `INSERT INTO canonical.operator_holds_certificate
           (operator_id, cert_id, role, valid_from, valid_to,
            source, source_url, source_timestamp, confidence, match_method, evidence)
         VALUES ($1, $2, $3, $4::date, NULL,
                 $5, $6, $7::timestamptz, $8, $9, $10::jsonb)`,
        [
          o.operator_id,
          o.cert_id,
          ROLE,
          MAY1_DATE,
          SOURCE_NEW,
          `s3://${S3_BUCKET}/${MAY1_XLSX_S3_KEY}`,
          MAY1_SOURCE_TIMESTAMP,
          o.confidence,
          o.match_method,
          JSON.stringify(evidence),
        ],
      );
      case3Inserted++;
    }

    // Sidecar review: route to public.operator_match_review (only if cert isn't covered by an open ohc — to avoid duplicating Case 1)
    for (const o of sidecarReview) {
      const certHasOpen = openOhcByCert.has(o.cert_id);
      if (certHasOpen) {
        // The cert already has an open ohc (likely from a prior source like faa_d085_seed).
        // Recording this as a review row would duplicate the existing assignment context.
        // Instead, append a note to corroborated_by on the existing rows? For Phase 2 simplicity, skip.
        continue;
      }
      const payload = {
        step: STEP_TAG,
        cert_id: o.cert_id,
        cert_designator: o.cert_designator,
        holder_name_as_provided: o.holder_name,
        valid_from: MAY1_DATE,
        snapshot_date: MAY1_DATE,
        top_score: o.top_score,
        runner_up_score: o.runner_up_score,
        reason: o.reason,
        gate_failures: o.gate_failures,
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      await client.query(
        `INSERT INTO public.operator_match_review
           (scraped_name, scraped_source, scraped_source_id, scraped_payload, candidate_matches)
         VALUES ($1, 'faa', $2, $3::jsonb, $4::jsonb)`,
        [
          o.holder_name,
          `${SOURCE_NEW}:${o.cert_designator}:${MAY1_DATE}`,
          JSON.stringify(payload),
          JSON.stringify(o.candidate_matches),
        ],
      );
      reviewInserted++;
    }

    // Sidecar no_match: route to canonical.operator_holds_certificate_pending
    // Re-uses existing CHECK value 'no_canonical_operator_candidate'. Tier info
    // captured in evidence JSONB. Future architecture work could split reason
    // into a more granular CHECK list, but not gating Phase 2.
    for (const o of sidecarNoMatch) {
      const evidence = {
        tier_attempted: "tier_1_then_tier_2",
        tier_1_result: "no_exact_match",
        tier_2_result: "no_high_or_medium_match",
        top_score: o.top_score,
        runner_up_score: o.runner_up_score,
        gate_failures: o.gate_failures,
        candidate_matches: o.candidate_matches,
        cert_designator: o.cert_designator,
        holder_name_as_provided: o.holder_name,
        snapshot_date: MAY1_DATE,
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      await client.query(
        `INSERT INTO canonical.operator_holds_certificate_pending
           (cert_id, holder_name_as_provided, holder_name_normalized,
            valid_from, valid_to, source, source_url, source_timestamp,
            evidence, reason)
         VALUES ($1, $2, $3, $4::date, NULL, $5, $6, $7::timestamptz, $8::jsonb, 'no_canonical_operator_candidate')`,
        [
          o.cert_id,
          o.holder_name,
          o.holder_normalized,
          MAY1_DATE,
          SOURCE_NEW,
          `s3://${S3_BUCKET}/${MAY1_XLSX_S3_KEY}`,
          MAY1_SOURCE_TIMESTAMP,
          JSON.stringify(evidence),
        ],
      );
      noMatchInserted++;
    }

    const writeMs = Date.now() - startWrite;
    console.log(
      `\n[may1-ohc-diff] writes: case2_rebrand=${case2RebrandUpdated}, case2_cert_gone=${case2CertGoneUpdated}, ` +
        `case3_inserted=${case3Inserted}, review=${reviewInserted}, no_match=${noMatchInserted}, ` +
        `wall=${(writeMs / 1000).toFixed(1)}s`,
    );

    // Step 8: in-transaction verification
    const verify = await client.query<{ k: string; n: string }>(
      `SELECT 'ohc_open_total' AS k, COUNT(*)::bigint AS n FROM canonical.operator_holds_certificate WHERE valid_to IS NULL
       UNION ALL
       SELECT 'ohc_new_source', COUNT(*) FROM canonical.operator_holds_certificate WHERE source = $1
       UNION ALL
       SELECT 'ohc_closed_2026_05_01', COUNT(*) FROM canonical.operator_holds_certificate WHERE valid_to = $2::date AND last_updated_at::date = CURRENT_DATE
       UNION ALL
       SELECT 'ohcp_new_source', COUNT(*) FROM canonical.operator_holds_certificate_pending WHERE source = $1
       UNION ALL
       SELECT 'omr_new_step', COUNT(*) FROM public.operator_match_review WHERE scraped_source='faa' AND scraped_payload->>'step' = $3`,
      [SOURCE_NEW, MAY1_DATE, STEP_TAG],
    );
    console.log(`[may1-ohc-diff] in-tx verification:`);
    for (const r of verify.rows) console.log(`  ${r.k}: ${r.n}`);

    if (args.write) {
      await client.query("COMMIT");
      console.log(`\n[may1-ohc-diff] COMMIT. run_id=${runId}`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n[may1-ohc-diff] DRY-RUN: rolled back. Re-run with --write to apply.`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    console.error("[may1-ohc-diff] FATAL:", err instanceof Error ? err.message : err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
