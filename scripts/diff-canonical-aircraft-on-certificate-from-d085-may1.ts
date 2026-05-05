/**
 * Phase 2 Script 2 — diff canonical.aircraft_on_certificate against May 1 D085.
 *
 * Path A diff-and-apply per /Users/phelipehonesto/.claude/plans/peppy-roaming-babbage.md.
 *
 * Reads the May 1 D085 xlsx, classifies each (cert × tail) pair against the
 * current canonical.aircraft_on_certificate state, and writes one of:
 *
 *   Case 1 (no-op): pair already has an open window in canonical → skip
 *   Case 2 (close): existing open window's pair is NOT in May 1 → UPDATE valid_to
 *   Case 3 (insert): pair in May 1 but no open window → INSERT new open window
 *   sidecar:        pair in May 1 with cert OR aircraft missing → INSERT into aocp
 *
 * valid_to=2026-05-01 reflects the snapshot date at which the relationship was
 * observed absent, not the actual termination date which is unknown within the
 * [2026-02-16, 2026-05-01] gap. The relationship may have ended any time in
 * that 10-week window. corroborated_by evidence captures that we observed
 * absence on May 1, not when the change actually happened.
 *
 * Source slug: 'faa_d085_2026_05_01' for new INSERTs (date-precise per snapshot;
 * sets pattern for future weekly cadence). Existing rows under 'faa_d085' or
 * 'faa_d085_seed' are NOT migrated; only valid_to and corroborated_by are
 * mutated on Case 2 closes (per docs/temporal-link-pattern.md Rule 1: temporal
 * tables are append-only except for valid_to).
 *
 * EXCLUDE-collision check: Case 3 INSERTs are by-construction outside any
 * existing open window (the case is defined as "no open window for this pair").
 * Closed prior windows sit before 2026-05-01 and don't overlap with new
 * [2026-05-01, NULL) windows. Safe.
 *
 * Pre-execution surfaced numbers (after Script 1 added 29 new certs):
 *   - May 1 (cert × tail) pairs: 11,393
 *   - Existing open aoc rows (all sources): ~11,129
 *   - Expected Case 1 (no-op): ~9,911
 *   - Expected Case 2 (close): ~1,218
 *   - Expected Case 3 (insert): ~1,326 (= 1,286 prior + 42 newly resolvable from Script 1)
 *   - Expected sidecar (aocp): ~56 (was 98 before Script 1; cert-missing → 0)
 *
 * Usage:
 *   tsx scripts/diff-canonical-aircraft-on-certificate-from-d085-may1.ts                       # dry-run
 *   tsx scripts/diff-canonical-aircraft-on-certificate-from-d085-may1.ts --write               # commit
 *   tsx scripts/diff-canonical-aircraft-on-certificate-from-d085-may1.ts --local-xlsx=/tmp/may1-d085.xlsx
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

// ── Constants ─────────────────────────────────────────────────────────────

const SOURCE_NEW = "faa_d085_2026_05_01";
const MATCH_METHOD = "d085_tail_exact";
const CONFIDENCE = 0.85;
const MAY1_DATE = "2026-05-01";
const MAY1_SOURCE_TIMESTAMP = "2026-05-01T17:20:56Z";
const MAY1_XLSX_S3_KEY =
  "raw/faa/d085/xlsx/20260501172056__Part_135_Operators_and_Aircraft_List.xlsx";
const CHECKPOINT = "phase2_script2_may1_aoc_diff";

const TAIL_REGEX = /^N[0-9]+[A-Z]*$/;

// ── Types ─────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
  localXlsx: string | null;
}

interface May1Pair {
  cert_designator: string;
  tail: string;
  cert_id: string | null;
  aircraft_id: string | null;
}

interface OpenAocRow {
  id: string;
  cert_id: string;
  aircraft_id: string;
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

function pairKey(cert_id: string, aircraft_id: string): string {
  return `${cert_id}\x1f${aircraft_id}`;
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

  console.log(`[may1-aoc-diff] run_id=${runId}`);
  console.log(`[may1-aoc-diff] mode=${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`[may1-aoc-diff] source_new=${SOURCE_NEW}`);

  // ── Step 1: load May 1 xlsx (read-only) ────────────────────────────────
  let buf: Buffer;
  if (args.localXlsx) {
    console.log(`[may1-aoc-diff] reading local xlsx: ${args.localXlsx}`);
    buf = fs.readFileSync(args.localXlsx);
  } else {
    console.log(`[may1-aoc-diff] fetching s3://${S3_BUCKET}/${MAY1_XLSX_S3_KEY}`);
    buf = await fetchS3Buffer(s3, MAY1_XLSX_S3_KEY);
  }
  const rows: D085Row[] = parseD085Xlsx(buf, MAY1_XLSX_S3_KEY);
  console.log(`[may1-aoc-diff] parsed ${rows.length} rows`);

  // Distinct (cert_designator × tail_normalized) pairs
  const may1Raw = new Map<string, { cert_designator: string; tail: string }>();
  let skippedCertFmt = 0;
  let skippedNoTail = 0;
  let skippedTailFmt = 0;
  for (const r of rows) {
    if (!r.cert_number) continue;
    const certUpper = r.cert_number.toUpperCase();
    if (!CERT_REGEX_FAA_DESIGNATOR.test(certUpper)) {
      skippedCertFmt++;
      continue;
    }
    if (!r.tail_number) {
      skippedNoTail++;
      continue;
    }
    const tailUpper = r.tail_number.trim().toUpperCase();
    if (!TAIL_REGEX.test(tailUpper)) {
      skippedTailFmt++;
      continue;
    }
    const k = `${certUpper}\x1f${tailUpper}`;
    if (!may1Raw.has(k)) may1Raw.set(k, { cert_designator: certUpper, tail: tailUpper });
  }
  console.log(`[may1-aoc-diff] distinct (cert × tail) pairs: ${may1Raw.size}`);
  console.log(`[may1-aoc-diff] skips: cert_fmt=${skippedCertFmt}, no_tail=${skippedNoTail}, tail_fmt=${skippedTailFmt}`);

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '300s'`);

    // ── Step 2: resolve cert_designator → cert_id, tail → aircraft_id ───
    console.log(`[may1-aoc-diff] resolving cert_id and aircraft_id...`);
    const certRes = await client.query<{ cert_id: string; faa_cert_number: string }>(
      `SELECT cert_id, faa_cert_number FROM canonical.certificates
        WHERE cert_authority='faa' AND faa_cert_number IS NOT NULL`,
    );
    const certByDesignator = new Map<string, string>();
    for (const r of certRes.rows) certByDesignator.set(r.faa_cert_number.toUpperCase(), r.cert_id);
    console.log(`[may1-aoc-diff]   certs loaded: ${certByDesignator.size}`);

    const acRes = await client.query<{ aircraft_id: string; current_tail_number: string }>(
      `SELECT aircraft_id, current_tail_number FROM canonical.aircraft
        WHERE current_tail_number IS NOT NULL`,
    );
    const aircraftByTail = new Map<string, string>();
    for (const r of acRes.rows) {
      const t = r.current_tail_number.toUpperCase();
      if (!aircraftByTail.has(t)) aircraftByTail.set(t, r.aircraft_id);
    }
    console.log(`[may1-aoc-diff]   aircraft loaded: ${aircraftByTail.size}`);

    const may1Pairs: May1Pair[] = [];
    for (const v of may1Raw.values()) {
      may1Pairs.push({
        cert_designator: v.cert_designator,
        tail: v.tail,
        cert_id: certByDesignator.get(v.cert_designator) ?? null,
        aircraft_id: aircraftByTail.get(v.tail) ?? null,
      });
    }

    let resolvedBoth = 0, certMissing = 0, aircraftMissing = 0;
    for (const p of may1Pairs) {
      if (p.cert_id && p.aircraft_id) resolvedBoth++;
      else if (!p.cert_id) certMissing++;
      else if (!p.aircraft_id) aircraftMissing++;
    }
    console.log(`[may1-aoc-diff] May 1 pair resolution:`);
    console.log(`  both resolved:    ${resolvedBoth}`);
    console.log(`  cert missing:     ${certMissing}`);
    console.log(`  aircraft missing: ${aircraftMissing}`);

    // ── Step 3: load all open aoc rows (any source) ─────────────────────
    console.log(`[may1-aoc-diff] loading existing open aoc rows...`);
    const openRes = await client.query<OpenAocRow>(
      `SELECT id::text AS id, cert_id::text AS cert_id, aircraft_id::text AS aircraft_id,
              source, valid_from::text AS valid_from
         FROM canonical.aircraft_on_certificate
        WHERE valid_to IS NULL`,
    );
    const openByPair = new Map<string, OpenAocRow>();
    const sourceCounts = new Map<string, number>();
    for (const r of openRes.rows) {
      openByPair.set(pairKey(r.cert_id, r.aircraft_id), r);
      sourceCounts.set(r.source, (sourceCounts.get(r.source) ?? 0) + 1);
    }
    console.log(`[may1-aoc-diff]   open aoc rows total: ${openRes.rows.length}`);
    for (const [src, n] of sourceCounts) console.log(`[may1-aoc-diff]     source='${src}': ${n}`);

    // ── Step 4: classify ────────────────────────────────────────────────
    const may1ResolvedSet = new Set<string>();
    const case1NoOp: May1Pair[] = [];
    const case3Insert: May1Pair[] = [];
    const sidecarPending: May1Pair[] = []; // missing cert or aircraft

    for (const p of may1Pairs) {
      if (!p.cert_id || !p.aircraft_id) {
        sidecarPending.push(p);
        continue;
      }
      const k = pairKey(p.cert_id, p.aircraft_id);
      may1ResolvedSet.add(k);
      if (openByPair.has(k)) case1NoOp.push(p);
      else case3Insert.push(p);
    }

    const case2Close: OpenAocRow[] = [];
    for (const [k, row] of openByPair) {
      if (!may1ResolvedSet.has(k)) case2Close.push(row);
    }

    console.log(`\n[may1-aoc-diff] case classification:`);
    console.log(`  Case 1 (no-op, open window matches May 1):    ${case1NoOp.length}`);
    console.log(`  Case 2 (close, open window pair NOT in May 1): ${case2Close.length}`);
    console.log(`  Case 3 (insert, May 1 pair, no open window):   ${case3Insert.length}`);
    console.log(`  sidecar (aocp, cert or aircraft missing):       ${sidecarPending.length}`);
    console.log(`  total May 1 pairs: ${may1Pairs.length} = ${case1NoOp.length} + ${case3Insert.length} + ${sidecarPending.length}`);

    // Sample 3 from each non-trivial bucket
    console.log(`\n[may1-aoc-diff] sample 3 Case 2 (close):`);
    for (const r of case2Close.slice(0, 3)) {
      console.log(`  - cert_id=${r.cert_id.slice(0, 8)}…, aircraft_id=${r.aircraft_id.slice(0, 8)}…, source=${r.source}, valid_from=${r.valid_from}`);
    }
    console.log(`\n[may1-aoc-diff] sample 3 Case 3 (insert):`);
    for (const p of case3Insert.slice(0, 3)) {
      console.log(`  - ${p.cert_designator} × ${p.tail}`);
    }
    console.log(`\n[may1-aoc-diff] sample 3 sidecar:`);
    for (const p of sidecarPending.slice(0, 3)) {
      const why = !p.cert_id ? "cert_not_in_canonical_certificates" : "tail_not_in_canonical_aircraft";
      console.log(`  - ${p.cert_designator} × ${p.tail} [${why}]`);
    }

    // ── Step 5: write transaction ───────────────────────────────────────
    await client.query("BEGIN");
    const startWrite = Date.now();

    let case2Updated = 0, case3Inserted = 0, sidecarInserted = 0;

    // Case 2: close existing open windows (UPDATE valid_to + corroborated_by).
    // Per docs/temporal-link-pattern.md Rule 1, only valid_to/last_updated_at/
    // corroborated_by/contradicted_by may be UPDATEd.
    for (const r of case2Close) {
      const cbEntry = {
        source: SOURCE_NEW,
        source_url: `s3://${S3_BUCKET}/${MAY1_XLSX_S3_KEY}`,
        source_timestamp: MAY1_SOURCE_TIMESTAMP,
        ingestion_date: new Date().toISOString(),
        evidence: "observed_absent_on_may_1_after_10_week_gap",
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      const upd = await client.query(
        `UPDATE canonical.aircraft_on_certificate
            SET valid_to = $2::date,
                last_updated_at = NOW(),
                corroborated_by = COALESCE(corroborated_by, '[]'::jsonb) || jsonb_build_array($3::jsonb)
          WHERE id = $1
            AND valid_to IS NULL`,
        [r.id, MAY1_DATE, JSON.stringify(cbEntry)],
      );
      if (upd.rowCount === 1) case2Updated++;
    }

    // Case 3: INSERT new open windows.
    for (const p of case3Insert) {
      const evidence = {
        xlsx_s3_key: MAY1_XLSX_S3_KEY,
        cert_designator: p.cert_designator,
        tail_as_provided: p.tail,
        snapshot_date: MAY1_DATE,
        ambiguous_valid_from_note: "first observed 2026-05-01 after 10-week gap; actual relationship start may be earlier",
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      await client.query(
        `INSERT INTO canonical.aircraft_on_certificate
           (aircraft_id, cert_id, valid_from, valid_to,
            source, source_url, source_timestamp, confidence, match_method, evidence)
         VALUES ($1, $2, $3::date, NULL,
                 $4, $5, $6::timestamptz, $7, $8, $9::jsonb)`,
        [
          p.aircraft_id,
          p.cert_id,
          MAY1_DATE,
          SOURCE_NEW,
          `s3://${S3_BUCKET}/${MAY1_XLSX_S3_KEY}`,
          MAY1_SOURCE_TIMESTAMP,
          CONFIDENCE,
          MATCH_METHOD,
          JSON.stringify(evidence),
        ],
      );
      case3Inserted++;
    }

    // Sidecar: INSERT into aircraft_on_certificate_pending with appropriate reason.
    for (const p of sidecarPending) {
      const reason = !p.cert_id ? "cert_not_in_canonical_certificates" : "tail_not_in_canonical_aircraft";
      const evidence = {
        xlsx_s3_key: MAY1_XLSX_S3_KEY,
        cert_designator: p.cert_designator,
        tail_as_provided: p.tail,
        snapshot_date: MAY1_DATE,
        cert_resolved: p.cert_id !== null,
        aircraft_resolved: p.aircraft_id !== null,
        ingest_run_id: runId,
        checkpoint: CHECKPOINT,
      };
      // aocp REQUIRES cert_id NOT NULL. If cert is missing, we can't write a row.
      // Skip cert-missing rows (Script 1 already added 29 new certs, so cert-missing
      // should now be 0). Tail-missing rows write fine.
      if (!p.cert_id) {
        // Should not happen post-Script-1; defensive log.
        console.warn(`[may1-aoc-diff]   skipped sidecar (cert_id null): ${p.cert_designator} × ${p.tail}`);
        continue;
      }
      await client.query(
        `INSERT INTO canonical.aircraft_on_certificate_pending
           (cert_id, tail_number_as_provided, tail_number_normalized,
            valid_from, valid_to, source, source_url, source_timestamp,
            evidence, reason)
         VALUES ($1, $2, $3, $4::date, NULL, $5, $6, $7::timestamptz, $8::jsonb, $9)`,
        [
          p.cert_id,
          p.tail,
          p.tail,
          MAY1_DATE,
          SOURCE_NEW,
          `s3://${S3_BUCKET}/${MAY1_XLSX_S3_KEY}`,
          MAY1_SOURCE_TIMESTAMP,
          JSON.stringify(evidence),
          reason,
        ],
      );
      sidecarInserted++;
    }

    const writeMs = Date.now() - startWrite;
    console.log(
      `\n[may1-aoc-diff] writes: case2_closed=${case2Updated}, case3_inserted=${case3Inserted}, sidecar=${sidecarInserted}, ` +
        `wall=${(writeMs / 1000).toFixed(1)}s`,
    );

    // ── Step 6: in-transaction verification ─────────────────────────────
    const verify = await client.query<{ k: string; n: string }>(
      `SELECT 'aoc_open_total' AS k, COUNT(*)::bigint AS n FROM canonical.aircraft_on_certificate WHERE valid_to IS NULL
       UNION ALL
       SELECT 'aoc_new_source', COUNT(*) FROM canonical.aircraft_on_certificate WHERE source = $1
       UNION ALL
       SELECT 'aoc_closed_today', COUNT(*) FROM canonical.aircraft_on_certificate
         WHERE valid_to = $2::date AND last_updated_at::date = CURRENT_DATE
       UNION ALL
       SELECT 'aocp_new_source', COUNT(*) FROM canonical.aircraft_on_certificate_pending WHERE source = $1`,
      [SOURCE_NEW, MAY1_DATE],
    );
    console.log(`[may1-aoc-diff] in-tx verification:`);
    for (const r of verify.rows) console.log(`  ${r.k}: ${r.n}`);

    if (args.write) {
      await client.query("COMMIT");
      console.log(`\n[may1-aoc-diff] COMMIT. run_id=${runId}`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n[may1-aoc-diff] DRY-RUN: rolled back. Re-run with --write to apply.`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    console.error("[may1-aoc-diff] FATAL:", err instanceof Error ? err.message : err);
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
