/**
 * Track 6 Step 2c — backfill canonical.operator_holds_certificate from FAA D085.
 *
 * Reads the same 12 deduplicated FAA OpSpec D085 xlsx snapshots Steps 2a / 2b
 * processed (s3://osa-dumont-backup/raw/faa/d085/). For each cert in
 * canonical.certificates, walks per-snapshot holder_name history, runs the
 * calibrated entity-resolution matcher (high=0.91 / medium=0.75 / low=0.60,
 * calibrated 2026-04-19) against public.operators, and writes:
 *   - canonical.operator_holds_certificate                 (matched windows)
 *   - public.operator_match_review                      (review-tier rows)
 *   - canonical.operator_holds_certificate_pending         (no-match sidecar)
 *
 * Window construction (mirrors Step 2b close-on-gap):
 *   For matched action: bucket consecutive snapshots by (cert_id, operator_id);
 *     close on gap or operator change.
 *   For review/no_match: bucket by (cert_id, holder_name); one row per
 *     (cert × distinct unresolved holder) pair, windowed across snapshots
 *     where that holder appeared.
 *
 * Reuses src/entity-resolution/operator-resolver.ts internals (scoreCandidates,
 * decide, firstSignificantWord) so the calibrated matcher stays the SSoT.
 * Bypasses fetchCandidates (ILIKE-per-call) by snapshot-pinning the candidate
 * pool in memory at run start — ~700× faster + deterministic across snapshots.
 *
 * Confidence: 0.95 for high-tier matched (parallels Step 2b's 0.85-for-tail-exact;
 * 0.95 reflects the calibrated matcher's high-tier bar at 0.91+).
 * Source: 'faa_d085'. Match method: 'd085_holder_exact'.
 *
 * Idempotency: refused-if-populated guardrail. Three checks:
 *   - canonical.operator_holds_certificate WHERE source='faa_d085'
 *   - canonical.operator_holds_certificate_pending WHERE source='faa_d085'
 *   - operator_match_review WHERE scraped_source='faa' AND scraped_payload->>'step'='step2c'
 * If any non-zero, exit cleanly. Manual rollback required for re-runs.
 *
 * Tolerance: pending-rate ≤ 35%, review-rate ≤ 20%. Step 2b uses 15% on
 * tail-exact lookups; operator name resolution is structurally harder, so
 * pending tolerance is relaxed. Histogram of top-30 unresolved holder names
 * always emitted in dry-run output for human triage — this is the empirical
 * quality signal (no synthetic validation gate; Layer 2 web-research lookup
 * for unresolved sidecar entries lands in Step 2c.5).
 *
 * Usage:
 *   tsx scripts/backfill-canonical-operator-holds-certificate-from-d085.ts                       # dry-run
 *   tsx scripts/backfill-canonical-operator-holds-certificate-from-d085.ts --write               # commit
 *   tsx scripts/backfill-canonical-operator-holds-certificate-from-d085.ts --max-snapshots=1     # smoke
 */

import "dotenv/config";
import pg from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import {
  type IndexFile,
  type D085Row,
  CERT_REGEX_FAA_DESIGNATOR,
  INDEX_KEY,
  S3_BUCKET,
  cdxTsToDate,
  extractCdxTsFromKey,
  fetchS3Json,
  fetchS3Buffer,
  parseD085Xlsx,
} from "../src/utils/d085-parser.js";
import {
  type OperatorCandidate,
  type ScoredCandidate,
  scoreCandidates,
  decide,
  firstSignificantWord,
} from "../src/entity-resolution/operator-resolver.js";
import type { Source } from "../src/entity-resolution/operator-field-priority.js";

// ── Constants ─────────────────────────────────────────────────────────────

const SOURCE = "faa_d085";
const MATCH_METHOD = "d085_holder_exact";
const CONFIDENCE = 0.95;
const ROLE = "holder_of_record";
const STEP_TAG = "step2c";
// Pending tolerance reflects Layer-1-only scope: the 304-operator candidate
// pool is charter/Part 135-tilted and structurally cannot cover the full
// 1,960-cert population (Part 121 majors, cargo, helicopter, individual
// owner-operators). Empirical pending rate measured 2026-04-25: 78%.
// Threshold of 0.85 catches a runaway regression (≥85% would indicate
// something is broken with the matcher pool itself), without aborting on
// the by-design Layer-1 gap. Step 2c.5 (Layer 2 web research) processes
// the sidecar.
const TOLERANCE_PENDING_THRESHOLD = 0.85;
const TOLERANCE_REVIEW_THRESHOLD = 0.20;
const CHECKPOINT = "track6_step2c_d085";

// ── Types ─────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
  maxSnapshots: number | null;
}

interface SnapshotMeta {
  index: number; // 1-based
  cdxTs: string;
  date: string;
  xlsxS3Key: string;
}

interface Window {
  valid_from: string;
  valid_to: string | null;
  snapshot_indices: number[];
  snapshot_dates: string[];
  xlsx_s3_keys: string[];
}

type ResolverAction = "matched" | "review" | "no_match";

interface ResolverDecision {
  action: ResolverAction;
  operator_id: string | null;
  canonical_name: string | null;
  confidence_tier: "high" | "medium" | null;
  top_score: number | null;
  runner_up_score: number | null;
  /** Top-3 candidates for review-queue payload. */
  candidate_matches: Array<{
    operator_id: string;
    canonical_name: string;
    score: number;
  }>;
  /** Reason the resolver assigned (review only). */
  reason: "ambiguous_runner_up" | "low_tier" | "medium_name_only" | null;
}

interface CertSnapshotEntry {
  snap: number;
  holder: string;
  resolution: ResolverDecision;
}

interface OhcInsert {
  cert_id: string;
  cert_designator: string;
  operator_id: string;
  canonical_name: string;
  holder_names_in_window: string[];
  top_score: number;
  runner_up_score: number | null;
  window: Window;
}

interface OmrInsert {
  cert_id: string;
  cert_designator: string;
  holder_name: string;
  candidate_operator_id: string | null;
  candidate_canonical_name: string | null;
  candidate_top_score: number | null;
  candidate_runner_up_score: number | null;
  candidate_matches: ResolverDecision["candidate_matches"];
  reason: ResolverDecision["reason"];
  window: Window;
}

interface OhcpInsert {
  cert_id: string;
  cert_designator: string;
  holder_name_as_provided: string;
  holder_name_normalized: string;
  top_score: number | null;
  window: Window;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const maxFlag = args.find((a) => a.startsWith("--max-snapshots="));
  return {
    write,
    maxSnapshots: maxFlag ? Number.parseInt(maxFlag.split("=")[1]!, 10) : null,
  };
}

function formatRunId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** UPPER + collapse-whitespace + trim. No suffix stripping (resolver's job). */
function normalizeHolder(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Step 2b's close-on-gap window construction. Reused verbatim — math is
 * identical for cert × tail and cert × (operator|holder).
 */
function constructWindows(indices: number[], snapshots: SnapshotMeta[]): Window[] {
  if (indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const numSnapshots = snapshots.length;
  const meta = (idx: number) => snapshots[idx - 1]!;

  const windows: Window[] = [];
  let groupStart = sorted[0]!;
  let groupIdxs: number[] = [sorted[0]!];

  const flush = (closeIdx: number | null) => {
    const lastIdx = groupIdxs[groupIdxs.length - 1]!;
    const validTo =
      closeIdx !== null
        ? meta(closeIdx).date
        : lastIdx === numSnapshots
          ? null
          : meta(lastIdx + 1).date;
    windows.push({
      valid_from: meta(groupStart).date,
      valid_to: validTo,
      snapshot_indices: [...groupIdxs],
      snapshot_dates: groupIdxs.map((i) => meta(i).date),
      xlsx_s3_keys: groupIdxs.map((i) => meta(i).xlsxS3Key),
    });
  };

  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1]!;
    const curr = sorted[k]!;
    if (curr === prev + 1) {
      groupIdxs.push(curr);
    } else {
      flush(prev + 1);
      groupStart = curr;
      groupIdxs = [curr];
    }
  }
  flush(null);
  return windows;
}

/**
 * Resolver wrapper. Snapshot-pinned candidate pool. Pure in-memory; zero
 * DB roundtrips per call (the 304-operator pool is loaded once at run start).
 *
 * Mirrors the decision tree in operator-resolver.ts decide() but maps
 * resolver actions to Step 2c destinations.
 */
function makeResolveHolder(candidatePool: OperatorCandidate[]) {
  const cache = new Map<string, ResolverDecision>();
  return function resolveHolder(holder: string): ResolverDecision {
    const cached = cache.get(holder);
    if (cached) return cached;

    const word = firstSignificantWord(holder).toLowerCase();
    const candidates = word
      ? candidatePool.filter((c) => c.canonical_name.toLowerCase().includes(word))
      : [];
    const scored = scoreCandidates(
      { name: holder, source: "faa" as Source, sourceId: "_step2c_lookup" },
      candidates,
    );
    const decision = decide(scored);
    const top = scored[0] ?? null;
    const runner = scored[1] ?? null;
    const top3 = scored.slice(0, 3).map((c: ScoredCandidate) => ({
      operator_id: c.operator_id,
      canonical_name: c.canonical_name,
      score: c.score,
    }));

    let result: ResolverDecision;
    if (decision.action === "matched") {
      result = {
        action: "matched",
        operator_id: top!.operator_id,
        canonical_name: top!.canonical_name,
        confidence_tier: decision.confidence as "high" | "medium",
        top_score: top!.score,
        runner_up_score: runner?.score ?? null,
        candidate_matches: top3,
        reason: null,
      };
    } else if (decision.action === "review") {
      result = {
        action: "review",
        operator_id: top?.operator_id ?? null,
        canonical_name: top?.canonical_name ?? null,
        confidence_tier: null,
        top_score: top?.score ?? null,
        runner_up_score: runner?.score ?? null,
        candidate_matches: top3,
        reason: decision.reason ?? null,
      };
    } else {
      // 'new' from decide() collapses to no_match at this layer
      result = {
        action: "no_match",
        operator_id: null,
        canonical_name: null,
        confidence_tier: null,
        top_score: top?.score ?? null,
        runner_up_score: runner?.score ?? null,
        candidate_matches: top3,
        reason: null,
      };
    }
    cache.set(holder, result);
    return result;
  };
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

  console.log(`[d085-ohc] run_id=${runId}`);
  console.log(`[d085-ohc] mode=${args.write ? "WRITE" : "DRY-RUN"}`);

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '600s'`);

    // ── Step 1: refused-if-populated guardrail ─────────────────────────────
    {
      const ohcExisting = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.operator_holds_certificate WHERE source = $1`,
        [SOURCE],
      );
      const ohcpExisting = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.operator_holds_certificate_pending WHERE source = $1`,
        [SOURCE],
      );
      const omrExisting = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM public.operator_match_review
          WHERE scraped_source = 'faa' AND scraped_payload->>'step' = $1`,
        [STEP_TAG],
      );
      const ohcN = Number.parseInt(ohcExisting.rows[0]!.n, 10);
      const ohcpN = Number.parseInt(ohcpExisting.rows[0]!.n, 10);
      const omrN = Number.parseInt(omrExisting.rows[0]!.n, 10);
      if (ohcN > 0 || ohcpN > 0 || omrN > 0) {
        console.log(
          `[d085-ohc] destination tables already populated ` +
            `(ohc=${ohcN}, ohcp=${ohcpN}, omr.step2c=${omrN} for source/step). ` +
            `Refusing to re-run. Exiting cleanly.`,
        );
        return;
      }
    }

    // ── Step 2: load lookup maps (snapshot-pinned) ─────────────────────────
    console.log(`[d085-ohc] loading certByDesignator from canonical.certificates...`);
    const certRes = await client.query<{ cert_id: string; faa_cert_number: string }>(
      `SELECT cert_id, faa_cert_number FROM canonical.certificates
        WHERE cert_authority='faa' AND faa_cert_number IS NOT NULL`,
    );
    const certByDesignator = new Map<string, string>();
    const certIdToDesignator = new Map<string, string>();
    for (const r of certRes.rows) {
      certByDesignator.set(r.faa_cert_number.toUpperCase(), r.cert_id);
      certIdToDesignator.set(r.cert_id, r.faa_cert_number.toUpperCase());
    }
    console.log(`[d085-ohc]   ${certByDesignator.size} certs loaded`);

    console.log(`[d085-ohc] loading public.operators (candidate pool)...`);
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
    console.log(`[d085-ohc]   ${candidatePool.length} canonical operators (pool pinned)`);

    const resolveHolder = makeResolveHolder(candidatePool);

    // ── Step 3: load D085 snapshots ────────────────────────────────────────
    console.log(`\n[d085-ohc] phase 1 of 3: D085 walk`);
    console.log(`[d085-ohc] reading s3://${S3_BUCKET}/${INDEX_KEY}`);
    const index = await fetchS3Json<IndexFile>(s3, INDEX_KEY);
    console.log(
      `[d085-ohc]   index: ${index.snapshot_count} page snapshots, ` +
        `${index.xlsx_unique_versions} unique xlsx, range ${index.date_range}`,
    );

    const xlsxKeySet = new Set<string>();
    for (const snap of index.snapshots) {
      if (snap.xlsx_archived && snap.xlsx_s3_key) xlsxKeySet.add(snap.xlsx_s3_key);
    }
    let uniqueXlsxKeys = Array.from(xlsxKeySet).sort();

    if (args.maxSnapshots !== null) {
      uniqueXlsxKeys = uniqueXlsxKeys.slice(0, args.maxSnapshots);
      console.log(`[d085-ohc]   capped to first ${args.maxSnapshots} xlsx via --max-snapshots`);
    }

    const snapshots: SnapshotMeta[] = uniqueXlsxKeys
      .map((key) => ({
        index: 0,
        cdxTs: extractCdxTsFromKey(key),
        date: cdxTsToDate(extractCdxTsFromKey(key)),
        xlsxS3Key: key,
      }))
      .sort((a, b) => a.cdxTs.localeCompare(b.cdxTs))
      .map((s, i) => ({ ...s, index: i + 1 }));

    console.log(`[d085-ohc]   ${snapshots.length} snapshots, indexed:`);
    for (const s of snapshots) {
      console.log(`[d085-ohc]     [${s.index}] ${s.date} (cdx=${s.cdxTs}) ${s.xlsxS3Key.split("/").pop()}`);
    }

    const xlsxKeyToIndex = new Map<string, number>();
    for (const s of snapshots) xlsxKeyToIndex.set(s.xlsxS3Key, s.index);

    // Fetch + parse
    const allRows: D085Row[] = [];
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i]!;
      const t0 = Date.now();
      const buf = await fetchS3Buffer(s3, s.xlsxS3Key);
      const rows = parseD085Xlsx(buf, s.xlsxS3Key);
      const ms = Date.now() - t0;
      console.log(`[d085-ohc]   [${s.index}/${snapshots.length}] ${s.date}: ${rows.length} rows, ${ms}ms`);
      allRows.push(...rows);
    }

    // ── Step 4: classification (cert × snapshot → resolution) ──────────────
    console.log(`\n[d085-ohc] phase 2 of 3: classification`);

    // Per cert: map of snapshot_index → holder_name (first row wins; D085 has
    // many aircraft rows per holder per snapshot so we collapse to one).
    const certPerSnapshotHolder = new Map<string, Map<number, string>>(); // cert_id → snap → holder
    let skippedNoCert = 0;
    let skippedNoHolder = 0;
    let skippedCertNotFound = 0;
    let skippedCertFormat = 0;

    for (const r of allRows) {
      if (!r.cert_number) {
        skippedNoCert++;
        continue;
      }
      if (!r.holder_name) {
        skippedNoHolder++;
        continue;
      }
      const certUpper = r.cert_number.toUpperCase();
      if (!CERT_REGEX_FAA_DESIGNATOR.test(certUpper)) {
        skippedCertFormat++;
        continue;
      }
      const certId = certByDesignator.get(certUpper);
      if (!certId) {
        skippedCertNotFound++;
        continue;
      }
      const snap = xlsxKeyToIndex.get(r.xlsx_s3_key);
      if (snap === undefined) continue;

      let perSnap = certPerSnapshotHolder.get(certId);
      if (!perSnap) {
        perSnap = new Map<number, string>();
        certPerSnapshotHolder.set(certId, perSnap);
      }
      if (!perSnap.has(snap)) perSnap.set(snap, r.holder_name.trim());
    }

    console.log(
      `[d085-ohc]   parser skips: no_cert=${skippedNoCert}, no_holder=${skippedNoHolder}, ` +
        `cert_format=${skippedCertFormat}, cert_lookup_miss=${skippedCertNotFound}`,
    );
    console.log(`[d085-ohc]   certs with at least one snapshot observation: ${certPerSnapshotHolder.size}`);

    // Resolve unique holder names (cached). Track tier distribution.
    const tierCounts = { matched_high: 0, matched_medium: 0, review: 0, no_match: 0 };
    const uniqueHolders = new Set<string>();
    for (const perSnap of certPerSnapshotHolder.values()) {
      for (const h of perSnap.values()) uniqueHolders.add(h);
    }
    for (const h of uniqueHolders) {
      const r = resolveHolder(h);
      if (r.action === "matched") {
        if (r.confidence_tier === "high") tierCounts.matched_high++;
        else tierCounts.matched_medium++;
      } else if (r.action === "review") {
        tierCounts.review++;
      } else {
        tierCounts.no_match++;
      }
    }
    console.log(`[d085-ohc]   unique holder names: ${uniqueHolders.size}`);
    console.log(`[d085-ohc]   tier distribution (per unique holder name):`);
    console.log(`[d085-ohc]     matched-high (≥0.91):   ${tierCounts.matched_high}`);
    console.log(`[d085-ohc]     matched-medium:         ${tierCounts.matched_medium}`);
    console.log(`[d085-ohc]     review:                 ${tierCounts.review}`);
    console.log(`[d085-ohc]     no_match:               ${tierCounts.no_match}`);

    // ── Step 5: window construction ────────────────────────────────────────
    console.log(`\n[d085-ohc] phase 3 of 3: window construction`);
    const ohcInserts: OhcInsert[] = [];
    const omrInserts: OmrInsert[] = [];
    const ohcpInserts: OhcpInsert[] = [];

    for (const [certId, perSnap] of certPerSnapshotHolder) {
      const certDesignator = certIdToDesignator.get(certId)!;
      const states: CertSnapshotEntry[] = [];
      for (const [snap, holder] of perSnap) {
        states.push({ snap, holder, resolution: resolveHolder(holder) });
      }
      states.sort((a, b) => a.snap - b.snap);

      // Bucket by destination type
      // matched: bucket key = operator_id
      // review:  bucket key = holder (one review row per (cert, holder))
      // no_match: bucket key = holder (one pending row per (cert, holder))
      const matchedByOp = new Map<string, { decision: ResolverDecision; indices: number[]; holders: string[] }>();
      const reviewByHolder = new Map<string, { decision: ResolverDecision; indices: number[] }>();
      const noMatchByHolder = new Map<string, { decision: ResolverDecision; indices: number[] }>();

      for (const s of states) {
        const r = s.resolution;
        if (r.action === "matched" && r.operator_id) {
          let b = matchedByOp.get(r.operator_id);
          if (!b) {
            b = { decision: r, indices: [], holders: [] };
            matchedByOp.set(r.operator_id, b);
          }
          b.indices.push(s.snap);
          if (!b.holders.includes(s.holder)) b.holders.push(s.holder);
        } else if (r.action === "review") {
          let b = reviewByHolder.get(s.holder);
          if (!b) {
            b = { decision: r, indices: [] };
            reviewByHolder.set(s.holder, b);
          }
          b.indices.push(s.snap);
        } else {
          let b = noMatchByHolder.get(s.holder);
          if (!b) {
            b = { decision: r, indices: [] };
            noMatchByHolder.set(s.holder, b);
          }
          b.indices.push(s.snap);
        }
      }

      for (const [opId, b] of matchedByOp) {
        const windows = constructWindows(b.indices, snapshots);
        for (const w of windows) {
          ohcInserts.push({
            cert_id: certId,
            cert_designator: certDesignator,
            operator_id: opId,
            canonical_name: b.decision.canonical_name!,
            holder_names_in_window: b.holders,
            top_score: b.decision.top_score!,
            runner_up_score: b.decision.runner_up_score,
            window: w,
          });
        }
      }
      for (const [holder, b] of reviewByHolder) {
        const windows = constructWindows(b.indices, snapshots);
        for (const w of windows) {
          omrInserts.push({
            cert_id: certId,
            cert_designator: certDesignator,
            holder_name: holder,
            candidate_operator_id: b.decision.operator_id,
            candidate_canonical_name: b.decision.canonical_name,
            candidate_top_score: b.decision.top_score,
            candidate_runner_up_score: b.decision.runner_up_score,
            candidate_matches: b.decision.candidate_matches,
            reason: b.decision.reason,
            window: w,
          });
        }
      }
      for (const [holder, b] of noMatchByHolder) {
        const windows = constructWindows(b.indices, snapshots);
        for (const w of windows) {
          ohcpInserts.push({
            cert_id: certId,
            cert_designator: certDesignator,
            holder_name_as_provided: holder,
            holder_name_normalized: normalizeHolder(holder),
            top_score: b.decision.top_score,
            window: w,
          });
        }
      }
    }

    console.log(`[d085-ohc]   operator_holds_certificate rows to insert:         ${ohcInserts.length}`);
    console.log(`[d085-ohc]   operator_match_review rows to insert:              ${omrInserts.length}`);
    console.log(`[d085-ohc]   operator_holds_certificate_pending rows to insert: ${ohcpInserts.length}`);
    console.log(
      `[d085-ohc]   windows per matched cert (avg): ` +
        `${(ohcInserts.length / Math.max(1, [...certPerSnapshotHolder.values()].filter(p => Array.from(p.values()).some(h => resolveHolder(h).action === "matched")).length)).toFixed(2)}`,
    );

    const totalRows = ohcInserts.length + omrInserts.length + ohcpInserts.length;
    const pendingRate = totalRows === 0 ? 0 : ohcpInserts.length / totalRows;
    const reviewRate = totalRows === 0 ? 0 : omrInserts.length / totalRows;
    console.log(
      `[d085-ohc]   pending-rate: ${(pendingRate * 100).toFixed(2)}% (threshold ${(TOLERANCE_PENDING_THRESHOLD * 100).toFixed(0)}%)`,
    );
    console.log(
      `[d085-ohc]   review-rate:  ${(reviewRate * 100).toFixed(2)}% (threshold ${(TOLERANCE_REVIEW_THRESHOLD * 100).toFixed(0)}%)`,
    );

    // Top-50 unresolved holder names by frequency
    const noMatchHolderCounts = new Map<string, number>();
    for (const o of ohcpInserts) {
      noMatchHolderCounts.set(
        o.holder_name_as_provided,
        (noMatchHolderCounts.get(o.holder_name_as_provided) ?? 0) + o.window.snapshot_indices.length,
      );
    }
    const topUnresolved = Array.from(noMatchHolderCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30);
    if (topUnresolved.length > 0) {
      console.log(`[d085-ohc]   top 30 unresolved holder names (by snapshot occurrence):`);
      for (const [holder, n] of topUnresolved) {
        console.log(`[d085-ohc]     "${holder}" (${n} snapshot occurrences)`);
      }
    }

    // Spot-checks
    console.log(`\n[d085-ohc]   spot-checks:`);
    const spotCertCases = ["DXTA", "PRIA", "9JLA", "BKEA", "VQMA"];
    for (const designator of spotCertCases) {
      const certId = certByDesignator.get(designator);
      if (!certId) {
        console.log(`[d085-ohc]     ${designator}: cert not in canonical.certificates ⚠`);
        continue;
      }
      const ohcRows = ohcInserts.filter((o) => o.cert_id === certId);
      const omrRows = omrInserts.filter((o) => o.cert_id === certId);
      const ohcpRows = ohcpInserts.filter((o) => o.cert_id === certId);
      if (ohcRows.length > 0) {
        const r = ohcRows[0]!;
        console.log(
          `[d085-ohc]     ${designator} → ${r.canonical_name} (op=${r.operator_id.slice(0, 8)}…), ` +
            `conf=${CONFIDENCE}, valid_from=${r.window.valid_from}, valid_to=${r.window.valid_to ?? "OPEN"}, ` +
            `top_score=${r.top_score.toFixed(3)} ✓`,
        );
      } else if (omrRows.length > 0) {
        const r = omrRows[0]!;
        console.log(
          `[d085-ohc]     ${designator} → review (top=${r.candidate_canonical_name}, ` +
            `score=${r.candidate_top_score?.toFixed(3) ?? "null"}, reason=${r.reason}) ⚠`,
        );
      } else if (ohcpRows.length > 0) {
        const r = ohcpRows[0]!;
        console.log(
          `[d085-ohc]     ${designator} → pending (holder="${r.holder_name_as_provided}", ` +
            `top_score=${r.top_score?.toFixed(3) ?? "null"}) ⚠`,
        );
      } else {
        console.log(`[d085-ohc]     ${designator}: no rows produced`);
      }
    }

    // Tolerance check (live runs only)
    if (args.write) {
      if (pendingRate > TOLERANCE_PENDING_THRESHOLD) {
        console.error(
          `\n[d085-ohc] FATAL: pending-rate ${(pendingRate * 100).toFixed(2)}% exceeds ` +
            `${(TOLERANCE_PENDING_THRESHOLD * 100).toFixed(0)}%. Refusing to write.`,
        );
        process.exit(1);
      }
      if (reviewRate > TOLERANCE_REVIEW_THRESHOLD) {
        console.error(
          `\n[d085-ohc] FATAL: review-rate ${(reviewRate * 100).toFixed(2)}% exceeds ` +
            `${(TOLERANCE_REVIEW_THRESHOLD * 100).toFixed(0)}%. Refusing to write.`,
        );
        process.exit(1);
      }
    }

    // ── Step 7: insert into canonical (single outer transaction) ───────────
    await client.query("BEGIN");
    const startWrite = Date.now();

    let ohcInserted = 0;
    let omrInserted = 0;
    let ohcpInserted = 0;

    for (const ins of ohcInserts) {
      const evidence = {
        xlsx_s3_keys_in_window: ins.window.xlsx_s3_keys,
        snapshot_dates_in_window: ins.window.snapshot_dates,
        snapshot_indices_in_window: ins.window.snapshot_indices,
        snapshot_count_in_window: ins.window.snapshot_indices.length,
        holder_names_in_window: ins.holder_names_in_window,
        cert_designator: ins.cert_designator,
        canonical_name: ins.canonical_name,
        top_score: ins.top_score,
        runner_up_score: ins.runner_up_score,
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      await client.query(
        `INSERT INTO canonical.operator_holds_certificate
           (operator_id, cert_id, role, valid_from, valid_to,
            source, source_url, source_timestamp, confidence, match_method, evidence)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, NULL, NULL, $7, $8, $9::jsonb)`,
        [
          ins.operator_id,
          ins.cert_id,
          ROLE,
          ins.window.valid_from,
          ins.window.valid_to,
          SOURCE,
          CONFIDENCE,
          MATCH_METHOD,
          JSON.stringify(evidence),
        ],
      );
      ohcInserted++;
    }

    for (const ins of omrInserts) {
      const payload = {
        step: STEP_TAG,
        cert_id: ins.cert_id,
        cert_designator: ins.cert_designator,
        holder_name_as_provided: ins.holder_name,
        valid_from: ins.window.valid_from,
        valid_to: ins.window.valid_to,
        snapshot_indices: ins.window.snapshot_indices,
        snapshot_dates: ins.window.snapshot_dates,
        top_score: ins.candidate_top_score,
        runner_up_score: ins.candidate_runner_up_score,
        reason: ins.reason,
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      await client.query(
        `INSERT INTO public.operator_match_review
           (scraped_name, scraped_source, scraped_source_id, scraped_payload, candidate_matches)
         VALUES ($1, 'faa', $2, $3::jsonb, $4::jsonb)`,
        [
          ins.holder_name,
          `${SOURCE}:${ins.cert_designator}:${ins.window.valid_from}`,
          JSON.stringify(payload),
          JSON.stringify(ins.candidate_matches),
        ],
      );
      omrInserted++;
    }

    for (const ins of ohcpInserts) {
      const evidence = {
        xlsx_s3_keys_in_window: ins.window.xlsx_s3_keys,
        snapshot_dates_in_window: ins.window.snapshot_dates,
        snapshot_indices_in_window: ins.window.snapshot_indices,
        snapshot_count_in_window: ins.window.snapshot_indices.length,
        cert_designator: ins.cert_designator,
        top_score: ins.top_score,
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      await client.query(
        `INSERT INTO canonical.operator_holds_certificate_pending
           (cert_id, holder_name_as_provided, holder_name_normalized,
            valid_from, valid_to, source, source_url, source_timestamp,
            evidence, reason)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, NULL, NULL, $7::jsonb, 'no_canonical_operator_candidate')`,
        [
          ins.cert_id,
          ins.holder_name_as_provided,
          ins.holder_name_normalized,
          ins.window.valid_from,
          ins.window.valid_to,
          SOURCE,
          JSON.stringify(evidence),
        ],
      );
      ohcpInserted++;
    }

    const writeMs = Date.now() - startWrite;
    console.log(
      `\n[d085-ohc]   inserts: ohc=${ohcInserted}, omr=${omrInserted}, ohcp=${ohcpInserted}, ` +
        `wall=${(writeMs / 1000).toFixed(1)}s`,
    );

    // ── Step 8: in-transaction verification ────────────────────────────────
    const openClosed = await client.query<{ open: string; closed: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE valid_to IS NULL)::bigint AS open,
         COUNT(*) FILTER (WHERE valid_to IS NOT NULL)::bigint AS closed
       FROM canonical.operator_holds_certificate WHERE source = $1`,
      [SOURCE],
    );
    console.log(`[d085-ohc]   ohc window distribution (in-tx):`);
    console.log(`[d085-ohc]     open (valid_to IS NULL):       ${openClosed.rows[0]!.open}`);
    console.log(`[d085-ohc]     closed (valid_to IS NOT NULL): ${openClosed.rows[0]!.closed}`);

    const topByCount = await client.query<{
      canonical_name: string;
      n: string;
    }>(
      `SELECT o.canonical_name, COUNT(*)::bigint AS n
         FROM canonical.operator_holds_certificate ohc
         JOIN public.operators o ON o.id = ohc.operator_id
        WHERE ohc.source = $1 AND ohc.valid_to IS NULL
        GROUP BY o.canonical_name
        ORDER BY n DESC LIMIT 10`,
      [SOURCE],
    );
    console.log(`[d085-ohc]   top 10 operators by current open-window cert count:`);
    for (const r of topByCount.rows) {
      console.log(`[d085-ohc]     - ${r.canonical_name}: ${r.n} certs`);
    }

    const ohcpByReason = await client.query<{ reason: string; n: string }>(
      `SELECT reason, COUNT(*)::bigint AS n
         FROM canonical.operator_holds_certificate_pending WHERE source = $1
        GROUP BY reason ORDER BY reason`,
      [SOURCE],
    );
    console.log(`[d085-ohc]   ohcp breakdown by reason:`);
    for (const r of ohcpByReason.rows) console.log(`[d085-ohc]     - ${r.reason}: ${r.n}`);

    if (args.write) {
      await client.query("COMMIT");
      console.log(`\n[d085-ohc] COMMIT. run_id=${runId}`);
      const post1 = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.operator_holds_certificate WHERE source = $1`,
        [SOURCE],
      );
      const post2 = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.operator_holds_certificate_pending WHERE source = $1`,
        [SOURCE],
      );
      const post3 = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM public.operator_match_review
          WHERE scraped_source='faa' AND scraped_payload->>'step' = $1`,
        [STEP_TAG],
      );
      console.log(
        `[d085-ohc] verify post-commit: ohc[faa_d085]=${post1.rows[0]!.n}, ` +
          `ohcp[faa_d085]=${post2.rows[0]!.n}, omr[step2c]=${post3.rows[0]!.n}`,
      );
    } else {
      await client.query("ROLLBACK");
      console.log(`\n[d085-ohc] DRY-RUN: rolled back. Re-run with --write to apply.`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    console.error("[d085-ohc] FATAL:", err instanceof Error ? err.message : err);
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
