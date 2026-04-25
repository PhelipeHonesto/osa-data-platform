/**
 * Track 6 Step 2b — backfill canonical.aircraft_on_certificate from FAA D085.
 *
 * Reads the same 12 deduplicated FAA OpSpec D085 xlsx snapshots Step 2a
 * processed (s3://osa-dumont-backup/raw/faa/d085/, indexed at _index.json),
 * but extracts per-aircraft authorization rows. For each unique (cert × tail)
 * pair, builds bitemporal windows by walking the chronologically-ordered
 * snapshot indices the pair appeared in. Writes:
 *   - canonical.aircraft_on_certificate                 (matched pairs, one row per window)
 *   - canonical.aircraft_on_certificate_pending         (sidecar for unmatched tails)
 *
 * Window construction (close-then-insert per docs/temporal-link-pattern.md):
 *   For pair P appearing in sorted snapshot-index list S = [s1, s2, ..., sk]:
 *     valid_from = dates[S[0]] for the first window
 *     For each gap (s_{i+1} != s_i + 1): close at dates[s_i + 1], open at dates[s_{i+1}]
 *     Final window: valid_to = NULL if s_k is the latest snapshot, else dates[s_k + 1]
 *
 * Cert resolution: by faa_cert_number (4-5 char designator). Step 2a populated
 * canonical.certificates from the same xlsx files, so cert-misses should be 0
 * unless a designator slipped through 2a's regex filter.
 *
 * Tail resolution: by canonical.aircraft.current_tail_number exactly (uppercase
 * on both sides; D085 publishes 'N123AB' format consistently). No historical-
 * tail mechanism exists yet — canonical.aircraft_aliases is empty per its
 * SCAFFOLD designation. Tails that don't match land in
 * aircraft_on_certificate_pending; Step 2e (DEREG ingestion) re-resolves them.
 *
 * Confidence: flat 0.85 (single Tier-1 source, not yet corroborated). Same as 2a.
 * Source: 'faa_d085'. Match method: 'd085_tail_exact'.
 *
 * Idempotency: refused-if-populated guardrail. If either destination table
 * already has source='faa_d085' rows, exit cleanly. Manual rollback required
 * for re-runs (schema/rollback/2026-04-26-001-... drops the pending sidecar).
 *
 * Tolerance: if >15% of (cert × tail) pairs fail to match canonical.aircraft,
 * abort the live run before any inserts. No override flag — fix the data,
 * not the threshold. Use --max-snapshots=N for cheap isolation when investigating.
 *
 * Usage:
 *   tsx scripts/backfill-canonical-aircraft-on-certificate-from-d085.ts                   # dry-run
 *   tsx scripts/backfill-canonical-aircraft-on-certificate-from-d085.ts --write           # commit
 *   tsx scripts/backfill-canonical-aircraft-on-certificate-from-d085.ts --max-snapshots=1 # smoke test
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

// ── Constants ─────────────────────────────────────────────────────────────

const SOURCE = "faa_d085";
const MATCH_METHOD = "d085_tail_exact";
const CONFIDENCE = 0.85;
const TOLERANCE_THRESHOLD = 0.15;
const CHECKPOINT = "track6_step2b_d085";

/** US tail-number canonical form: N + digits + optional letters. */
const TAIL_REGEX = /^N[0-9]+[A-Z]*$/;

// ── Types ─────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
  maxSnapshots: number | null;
}

interface SnapshotMeta {
  index: number; // 1-based
  cdxTs: string; // 14-digit
  date: string;  // 'YYYY-MM-DD'
  xlsxS3Key: string;
}

interface Window {
  valid_from: string;
  valid_to: string | null;
  snapshot_indices: number[];
  snapshot_dates: string[];
  xlsx_s3_keys: string[];
}

interface MatchedPair {
  cert_id: string;
  aircraft_id: string;
  cert_designator: string;
  tail_as_provided: string;
  tail_normalized: string;
  snapshot_indices: Set<number>;
}

interface PendingPair {
  cert_id: string;
  cert_designator: string;
  tail_as_provided: string;
  tail_normalized: string;
  reason: "tail_not_in_canonical_aircraft" | "malformed_tail";
  snapshot_indices: Set<number>;
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

function normalizeTail(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Build windows from a sorted list of snapshot indices.
 *
 * Algorithm (close-then-insert; bitemporal):
 *   - Group consecutive indices into windows.
 *   - When a gap is found, close the prior window with valid_to = dates[lastIdx + 1]
 *     (the date the pair was first observed *missing*).
 *   - Final window: valid_to = NULL if the last index is the latest snapshot
 *     (meaning we have no evidence of de-authorization yet), else
 *     dates[lastIdx + 1].
 */
function constructWindows(indices: number[], snapshots: SnapshotMeta[]): Window[] {
  if (indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const numSnapshots = snapshots.length;
  const meta = (idx: number) => snapshots[idx - 1]!; // 1-based → 0-based

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
      // Gap → close at dates[prev + 1] (which exists because curr > prev + 1 ≤ numSnapshots).
      flush(prev + 1);
      groupStart = curr;
      groupIdxs = [curr];
    }
  }
  flush(null);

  return windows;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const runId = formatRunId();
  const connectionString = process.env["SUPABASE_DATABASE_URL"];
  if (!connectionString) {
    console.error("SUPABASE_DATABASE_URL not set. Add it to .env.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  const s3 = new S3Client({});

  console.log(`[d085-aoc] run_id=${runId}`);
  console.log(`[d085-aoc] mode=${args.write ? "WRITE" : "DRY-RUN"}`);

  // ── Step 1: read S3 _index.json + assign snapshot indices ─────────────────
  console.log(`[d085-aoc] reading s3://${S3_BUCKET}/${INDEX_KEY}`);
  const index = await fetchS3Json<IndexFile>(s3, INDEX_KEY);
  console.log(
    `[d085-aoc] index: ${index.snapshot_count} page snapshots, ` +
      `${index.xlsx_unique_versions} unique xlsx, ${index.xlsx_gap_count} gaps, ` +
      `range ${index.date_range}`,
  );

  const xlsxKeySet = new Set<string>();
  for (const snap of index.snapshots) {
    if (snap.xlsx_archived && snap.xlsx_s3_key) xlsxKeySet.add(snap.xlsx_s3_key);
  }
  let uniqueXlsxKeys = Array.from(xlsxKeySet).sort();

  if (args.maxSnapshots !== null) {
    uniqueXlsxKeys = uniqueXlsxKeys.slice(0, args.maxSnapshots);
    console.log(`[d085-aoc] capped to first ${args.maxSnapshots} xlsx via --max-snapshots`);
  }

  // Sort by CDX timestamp ASC, assign 1-based indices.
  const snapshots: SnapshotMeta[] = uniqueXlsxKeys
    .map((key) => ({
      index: 0,
      cdxTs: extractCdxTsFromKey(key),
      date: cdxTsToDate(extractCdxTsFromKey(key)),
      xlsxS3Key: key,
    }))
    .sort((a, b) => a.cdxTs.localeCompare(b.cdxTs))
    .map((s, i) => ({ ...s, index: i + 1 }));

  console.log(`[d085-aoc] ${snapshots.length} snapshots, indexed:`);
  for (const s of snapshots) {
    console.log(`  [${s.index}] ${s.date} (cdx=${s.cdxTs}) ${s.xlsxS3Key.split("/").pop()}`);
  }

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '600s'`);

    // ── Step 2: refused-if-populated guardrail ─────────────────────────────
    const aocExisting = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft_on_certificate WHERE source = $1`,
      [SOURCE],
    );
    const aocExistingCount = Number.parseInt(aocExisting.rows[0]!.n, 10);
    const aocpExisting = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft_on_certificate_pending WHERE source = $1`,
      [SOURCE],
    );
    const aocpExistingCount = Number.parseInt(aocpExisting.rows[0]!.n, 10);
    if (aocExistingCount > 0 || aocpExistingCount > 0) {
      console.log(
        `[d085-aoc] destination tables already populated (` +
          `aircraft_on_certificate=${aocExistingCount}, ` +
          `aircraft_on_certificate_pending=${aocpExistingCount} ` +
          `with source='${SOURCE}'). Refusing to re-run. Exiting cleanly.`,
      );
      return;
    }

    // ── Step 3: load lookup maps (outside tx) ──────────────────────────────
    console.log(`[d085-aoc] loading certByDesignator from canonical.certificates...`);
    const certRes = await client.query<{ cert_id: string; faa_cert_number: string }>(
      `SELECT cert_id, faa_cert_number FROM canonical.certificates
        WHERE cert_authority='faa' AND faa_cert_number IS NOT NULL`,
    );
    const certByDesignator = new Map<string, string>();
    for (const r of certRes.rows) certByDesignator.set(r.faa_cert_number.toUpperCase(), r.cert_id);
    console.log(`[d085-aoc]   ${certByDesignator.size} certs loaded`);

    console.log(`[d085-aoc] loading aircraftByTail from canonical.aircraft...`);
    const acRes = await client.query<{ aircraft_id: string; current_tail_number: string }>(
      `SELECT aircraft_id, current_tail_number FROM canonical.aircraft
        WHERE current_tail_number IS NOT NULL`,
    );
    const aircraftByTail = new Map<string, string>();
    for (const r of acRes.rows) {
      const t = r.current_tail_number.toUpperCase();
      // First-match wins. canonical.aircraft has 0 dups on current_tail_number
      // (verified during planning); the conditional is defensive.
      if (!aircraftByTail.has(t)) aircraftByTail.set(t, r.aircraft_id);
    }
    console.log(`[d085-aoc]   ${aircraftByTail.size} aircraft loaded`);

    // ── Step 4: fetch + parse all xlsx ─────────────────────────────────────
    console.log(`[d085-aoc] fetching + parsing ${snapshots.length} xlsx files...`);
    const allRows: D085Row[] = [];
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i]!;
      const t0 = Date.now();
      const buf = await fetchS3Buffer(s3, s.xlsxS3Key);
      const rows = parseD085Xlsx(buf, s.xlsxS3Key);
      const ms = Date.now() - t0;
      const withTail = rows.filter((r) => r.tail_number).length;
      console.log(
        `[d085-aoc]   [${s.index}/${snapshots.length}] ${s.date}: ${rows.length} rows, ` +
          `${withTail} with tail, ${ms}ms`,
      );
      allRows.push(...rows);
    }
    console.log(`[d085-aoc] parsed total: ${allRows.length} rows`);

    // ── Step 5: group by (cert, tail), classify each pair ──────────────────
    const xlsxKeyToIndex = new Map<string, number>();
    for (const s of snapshots) xlsxKeyToIndex.set(s.xlsxS3Key, s.index);

    // Composite key: cert_designator + "\x1f" + tail_normalized (or +reason for pending).
    const matched = new Map<string, MatchedPair>();
    const pending = new Map<string, PendingPair>();

    let skippedNoCert = 0;
    let skippedNoTail = 0;
    let skippedCertNotFound = 0;

    for (const r of allRows) {
      if (!r.cert_number || !r.tail_number) {
        if (!r.cert_number) skippedNoCert++;
        if (!r.tail_number) skippedNoTail++;
        continue;
      }
      const certUpper = r.cert_number.toUpperCase();
      if (!CERT_REGEX_FAA_DESIGNATOR.test(certUpper)) {
        // Mirrors 2a's filter — these never landed in canonical.certificates.
        skippedCertNotFound++;
        continue;
      }
      const certId = certByDesignator.get(certUpper);
      if (!certId) {
        // Should be 0 since 2a populated certs from same source. Log if it
        // happens — would indicate a 2a/2b regex divergence.
        skippedCertNotFound++;
        continue;
      }
      const snapIdx = xlsxKeyToIndex.get(r.xlsx_s3_key)!;
      const tailNorm = normalizeTail(r.tail_number);

      if (!TAIL_REGEX.test(tailNorm)) {
        const k = `${certUpper}\x1f${tailNorm}\x1fmalformed`;
        let p = pending.get(k);
        if (!p) {
          p = {
            cert_id: certId,
            cert_designator: certUpper,
            tail_as_provided: r.tail_number,
            tail_normalized: tailNorm,
            reason: "malformed_tail",
            snapshot_indices: new Set(),
          };
          pending.set(k, p);
        }
        p.snapshot_indices.add(snapIdx);
        continue;
      }

      const aircraftId = aircraftByTail.get(tailNorm);
      if (!aircraftId) {
        const k = `${certUpper}\x1f${tailNorm}\x1fnoaircraft`;
        let p = pending.get(k);
        if (!p) {
          p = {
            cert_id: certId,
            cert_designator: certUpper,
            tail_as_provided: r.tail_number,
            tail_normalized: tailNorm,
            reason: "tail_not_in_canonical_aircraft",
            snapshot_indices: new Set(),
          };
          pending.set(k, p);
        }
        p.snapshot_indices.add(snapIdx);
        continue;
      }

      const k = `${certId}\x1f${aircraftId}`;
      let m = matched.get(k);
      if (!m) {
        m = {
          cert_id: certId,
          aircraft_id: aircraftId,
          cert_designator: certUpper,
          tail_as_provided: r.tail_number,
          tail_normalized: tailNorm,
          snapshot_indices: new Set(),
        };
        matched.set(k, m);
      }
      m.snapshot_indices.add(snapIdx);
    }

    // ── Step 6: tolerance check ────────────────────────────────────────────
    const totalPairs = matched.size + pending.size;
    const unmatchedRate = totalPairs === 0 ? 0 : pending.size / totalPairs;

    console.log(`\n[d085-aoc] classification:`);
    console.log(`  matched pairs (cert × aircraft): ${matched.size}`);
    console.log(`  pending pairs (cert × tail):     ${pending.size}`);
    console.log(`    breakdown by reason:`);
    const pendingByReason: Record<string, number> = {};
    for (const p of pending.values()) {
      pendingByReason[p.reason] = (pendingByReason[p.reason] ?? 0) + 1;
    }
    for (const [reason, n] of Object.entries(pendingByReason)) {
      console.log(`      ${reason}: ${n}`);
    }
    console.log(`  unmatched-rate: ${(unmatchedRate * 100).toFixed(2)}%  (threshold: ${(TOLERANCE_THRESHOLD * 100).toFixed(0)}%)`);
    console.log(`  parser skips: no_cert=${skippedNoCert}, no_tail=${skippedNoTail}, cert_format_or_lookup_miss=${skippedCertNotFound}`);

    if (args.write && unmatchedRate > TOLERANCE_THRESHOLD) {
      console.error(
        `\n[d085-aoc] FATAL: unmatched-rate ${(unmatchedRate * 100).toFixed(2)}% exceeds threshold ` +
          `${(TOLERANCE_THRESHOLD * 100).toFixed(0)}%. Refusing to write. Investigate the pending ` +
          `breakdown via dry-run + --max-snapshots=N before retrying.`,
      );
      process.exit(1);
    }

    // ── Step 7: window construction ────────────────────────────────────────
    interface AocInsert {
      cert_id: string;
      aircraft_id: string;
      cert_designator: string;
      tail_as_provided: string;
      window: Window;
    }
    interface AocpInsert {
      cert_id: string;
      cert_designator: string;
      tail_as_provided: string;
      tail_normalized: string;
      reason: PendingPair["reason"];
      window: Window;
    }

    const aocInserts: AocInsert[] = [];
    for (const m of matched.values()) {
      const indices = Array.from(m.snapshot_indices);
      const windows = constructWindows(indices, snapshots);
      for (const w of windows) {
        aocInserts.push({
          cert_id: m.cert_id,
          aircraft_id: m.aircraft_id,
          cert_designator: m.cert_designator,
          tail_as_provided: m.tail_as_provided,
          window: w,
        });
      }
    }

    const aocpInserts: AocpInsert[] = [];
    for (const p of pending.values()) {
      const indices = Array.from(p.snapshot_indices);
      const windows = constructWindows(indices, snapshots);
      for (const w of windows) {
        aocpInserts.push({
          cert_id: p.cert_id,
          cert_designator: p.cert_designator,
          tail_as_provided: p.tail_as_provided,
          tail_normalized: p.tail_normalized,
          reason: p.reason,
          window: w,
        });
      }
    }

    console.log(`\n[d085-aoc] window construction:`);
    console.log(`  aircraft_on_certificate rows to insert:         ${aocInserts.length}`);
    console.log(`  aircraft_on_certificate_pending rows to insert: ${aocpInserts.length}`);
    console.log(`  windows per matched pair (avg): ${(aocInserts.length / Math.max(1, matched.size)).toFixed(2)}`);

    // Sample windows for sanity-check
    if (aocInserts.length > 0) {
      const sample = aocInserts.slice(0, 3);
      console.log(`  sample windows (first 3):`);
      for (const s of sample) {
        console.log(
          `    cert=${s.cert_designator} tail=${s.tail_as_provided} ` +
            `[${s.window.valid_from}, ${s.window.valid_to ?? "OPEN"}) ` +
            `snapshots=${s.window.snapshot_indices.join(",")}`,
        );
      }
    }

    // ── Step 8: insert into canonical (single outer transaction) ───────────
    await client.query("BEGIN");
    const startWrite = Date.now();

    let aocInserted = 0;
    let aocpInserted = 0;

    for (const ins of aocInserts) {
      const evidence = {
        xlsx_s3_keys_in_window: ins.window.xlsx_s3_keys,
        snapshot_dates_in_window: ins.window.snapshot_dates,
        snapshot_indices_in_window: ins.window.snapshot_indices,
        snapshot_count_in_window: ins.window.snapshot_indices.length,
        tail_as_provided: ins.tail_as_provided,
        cert_designator: ins.cert_designator,
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      await client.query(
        `INSERT INTO canonical.aircraft_on_certificate
           (aircraft_id, cert_id, valid_from, valid_to,
            source, source_url, source_timestamp, confidence, match_method, evidence)
         VALUES ($1, $2, $3::date, $4::date, $5, NULL, NULL, $6, $7, $8::jsonb)`,
        [
          ins.aircraft_id,
          ins.cert_id,
          ins.window.valid_from,
          ins.window.valid_to,
          SOURCE,
          CONFIDENCE,
          MATCH_METHOD,
          JSON.stringify(evidence),
        ],
      );
      aocInserted++;
    }

    for (const ins of aocpInserts) {
      const evidence = {
        xlsx_s3_keys_in_window: ins.window.xlsx_s3_keys,
        snapshot_dates_in_window: ins.window.snapshot_dates,
        snapshot_indices_in_window: ins.window.snapshot_indices,
        snapshot_count_in_window: ins.window.snapshot_indices.length,
        cert_designator: ins.cert_designator,
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      await client.query(
        `INSERT INTO canonical.aircraft_on_certificate_pending
           (cert_id, tail_number_as_provided, tail_number_normalized,
            valid_from, valid_to, source, source_url, source_timestamp,
            evidence, reason)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, NULL, NULL, $7::jsonb, $8)`,
        [
          ins.cert_id,
          ins.tail_as_provided,
          ins.tail_normalized,
          ins.window.valid_from,
          ins.window.valid_to,
          SOURCE,
          JSON.stringify(evidence),
          ins.reason,
        ],
      );
      aocpInserted++;
    }

    const writeMs = Date.now() - startWrite;
    console.log(
      `\n[d085-aoc] inserts: aoc=${aocInserted}, aocp=${aocpInserted}, wall=${(writeMs / 1000).toFixed(1)}s`,
    );

    // ── Step 9: in-transaction verification ────────────────────────────────
    const openClosed = await client.query<{ open: string; closed: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE valid_to IS NULL)::bigint AS open,
         COUNT(*) FILTER (WHERE valid_to IS NOT NULL)::bigint AS closed
       FROM canonical.aircraft_on_certificate WHERE source = $1`,
      [SOURCE],
    );
    console.log(`[d085-aoc] aoc window distribution (in-tx):`);
    console.log(`  open (valid_to IS NULL):     ${openClosed.rows[0]!.open}`);
    console.log(`  closed (valid_to IS NOT NULL): ${openClosed.rows[0]!.closed}`);

    // Top 5 certs by current open-window fleet size — sanity for largest fleets.
    const topFleets = await client.query<{
      faa_cert_number: string;
      canonical_holder_name: string | null;
      n: string;
    }>(
      `SELECT c.faa_cert_number, c.canonical_holder_name, COUNT(*)::bigint AS n
         FROM canonical.aircraft_on_certificate aoc
         JOIN canonical.certificates c ON c.cert_id = aoc.cert_id
        WHERE aoc.source = $1 AND aoc.valid_to IS NULL
        GROUP BY c.faa_cert_number, c.canonical_holder_name
        ORDER BY n DESC LIMIT 5`,
      [SOURCE],
    );
    console.log(`[d085-aoc] top 5 certs by current open-window fleet size:`);
    for (const r of topFleets.rows) {
      console.log(`  - ${r.faa_cert_number} (${r.canonical_holder_name}): ${r.n} aircraft`);
    }

    // Pending breakdown
    const pendingDist = await client.query<{ reason: string; n: string }>(
      `SELECT reason, COUNT(*)::bigint AS n
         FROM canonical.aircraft_on_certificate_pending WHERE source = $1
        GROUP BY reason ORDER BY reason`,
      [SOURCE],
    );
    console.log(`[d085-aoc] aocp breakdown by reason:`);
    for (const r of pendingDist.rows) console.log(`  - ${r.reason}: ${r.n}`);

    if (args.write) {
      await client.query("COMMIT");
      console.log(`\n[d085-aoc] COMMIT. run_id=${runId}`);

      // Post-COMMIT verification
      const postAoc = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft_on_certificate WHERE source = $1`,
        [SOURCE],
      );
      const postAocp = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft_on_certificate_pending WHERE source = $1`,
        [SOURCE],
      );
      console.log(
        `[d085-aoc] verify post-commit: aoc[faa_d085]=${postAoc.rows[0]!.n}, ` +
          `aocp[faa_d085]=${postAocp.rows[0]!.n}`,
      );
    } else {
      await client.query("ROLLBACK");
      console.log(`\n[d085-aoc] DRY-RUN: rolled back. Re-run with --write to apply.`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    console.error("[d085-aoc] FATAL:", err instanceof Error ? err.message : err);
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
