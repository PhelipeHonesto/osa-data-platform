/**
 * Phase 2 Script 1 — promote canonical.certificates from the May 1 D085 snapshot.
 *
 * Path A diff-and-apply (per docs/plans/session-a5-may1-ingest-execution.md
 * + plan delta in /Users/phelipehonesto/.claude/plans/peppy-roaming-babbage.md):
 *
 *   Read the May 1 D085 xlsx, identify cert designators not yet in
 *   canonical.certificates, INSERT the deltas under
 *   source='faa_d085_2026_05_01'. Existing canonical.certificates rows are
 *   NEVER modified by this script. Identity rows are append-only per the
 *   May 1 attestation; the existing 1,960 identity rows from source='faa_d085'
 *   are left intact.
 *
 * Why ON CONFLICT DO NOTHING is safe / verified:
 *   canonical.certificates has the partial UNIQUE index
 *     ux_certificates_faa_cert_number ON (faa_cert_number)
 *     WHERE faa_cert_number IS NOT NULL AND cert_authority='faa'.
 *   EXPLAIN-tested with the matching ON CONFLICT predicate
 *     ON CONFLICT (faa_cert_number) WHERE ... DO NOTHING
 *   correctly resolves to the partial index as the conflict arbiter.
 *
 * Why this script does NOT modify the 211 certs in canonical-but-not-May-1:
 *   211 certs are in canonical but not in May 1. Status transitions
 *   (active → surrendered/expired) are handled by the certificate_events
 *   workstream separately. This script only INSERTs new certs from May 1;
 *   it does not modify existing canonical.certificates rows. aoc/ohc rows
 *   for those 211 certs WILL be closed by Scripts 2 and 3 (Case 2: cert gone),
 *   which is correct — the relationships are observed-absent regardless of
 *   cert status.
 *
 * Pre-execution surfaced numbers (from /Users/phelipehonesto/.claude/plans/peppy-roaming-babbage.md):
 *   - May 1 distinct cert designators: 1,791
 *   - Already in canonical.certificates: 1,749
 *   - Missing from canonical (this script's INSERT scope): ~42
 *   - canonical.certificates total before run: 1,960
 *   - Expected after run: 1,960 + 42 = 2,002
 *
 * Idempotency: ON CONFLICT DO NOTHING on the parent. Identity rows are UNIQUE
 * on (source, source_id); same ON CONFLICT (source, source_id) DO NOTHING.
 *
 * Usage:
 *   tsx scripts/promote-canonical-certificates-from-d085-may1.ts                       # dry-run (default)
 *   tsx scripts/promote-canonical-certificates-from-d085-may1.ts --write               # commit
 *   tsx scripts/promote-canonical-certificates-from-d085-may1.ts --local-xlsx=/tmp/may1-d085.xlsx  # use local file (testing)
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
const MAY1_XLSX_S3_KEY =
  "raw/faa/d085/xlsx/20260501172056__Part_135_Operators_and_Aircraft_List.xlsx";
const MAY1_SOURCE_TIMESTAMP = "2026-05-01T17:20:56Z"; // CDX TS for May 1 snapshot

// ── Types ─────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
  localXlsx: string | null;
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

  console.log(`[may1-cert-promote] run_id=${runId}`);
  console.log(`[may1-cert-promote] mode=${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`[may1-cert-promote] source_new=${SOURCE_NEW}`);

  // ── Step 1: load May 1 xlsx ────────────────────────────────────────────
  let buf: Buffer;
  if (args.localXlsx) {
    console.log(`[may1-cert-promote] reading local xlsx: ${args.localXlsx}`);
    buf = fs.readFileSync(args.localXlsx);
  } else {
    console.log(`[may1-cert-promote] fetching s3://${S3_BUCKET}/${MAY1_XLSX_S3_KEY}`);
    buf = await fetchS3Buffer(s3, MAY1_XLSX_S3_KEY);
  }
  const rows: D085Row[] = parseD085Xlsx(buf, MAY1_XLSX_S3_KEY);
  console.log(`[may1-cert-promote] parsed ${rows.length} rows from May 1 xlsx`);

  // ── Step 2: aggregate distinct (cert_designator, holder_name) ──────────
  const certHolders = new Map<string, string>(); // CERT -> first holder name seen
  let skippedCertFormat = 0;
  for (const r of rows) {
    if (!r.cert_number) continue;
    const certUpper = r.cert_number.toUpperCase();
    if (!CERT_REGEX_FAA_DESIGNATOR.test(certUpper)) {
      skippedCertFormat++;
      continue;
    }
    if (!certHolders.has(certUpper) && r.holder_name) {
      certHolders.set(certUpper, r.holder_name.trim());
    }
  }
  console.log(`[may1-cert-promote] distinct cert designators in May 1: ${certHolders.size}`);
  console.log(`[may1-cert-promote] cert_format skips: ${skippedCertFormat}`);

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '120s'`);

    // ── Step 3: identify new certs ──────────────────────────────────────
    console.log(`[may1-cert-promote] loading existing canonical.certificates designators...`);
    const existingRes = await client.query<{ faa_cert_number: string }>(
      `SELECT faa_cert_number FROM canonical.certificates
        WHERE cert_authority='faa' AND faa_cert_number IS NOT NULL`,
    );
    const existingCerts = new Set(existingRes.rows.map((r) => r.faa_cert_number.toUpperCase()));
    console.log(`[may1-cert-promote]   ${existingCerts.size} existing certs in canonical`);

    const newCerts: Array<{ cert_designator: string; holder_name: string }> = [];
    for (const [cert, holder] of certHolders) {
      if (!existingCerts.has(cert)) {
        newCerts.push({ cert_designator: cert, holder_name: holder });
      }
    }
    console.log(`[may1-cert-promote] new certs to INSERT: ${newCerts.length}`);

    // Sample first 10 new certs for review
    if (newCerts.length > 0) {
      console.log(`[may1-cert-promote] sample (first 10 new certs):`);
      for (const c of newCerts.slice(0, 10)) {
        console.log(`  - ${c.cert_designator}: ${c.holder_name}`);
      }
    }

    // ── Step 4: write transaction ───────────────────────────────────────
    await client.query("BEGIN");
    const startWrite = Date.now();

    let certsInserted = 0;
    let identitiesInserted = 0;

    // Insert new certs (ON CONFLICT-safe). Capture cert_id whether inserted or pre-existing.
    for (const c of newCerts) {
      // INSERT ON CONFLICT DO NOTHING — RETURNING returns nothing on conflict.
      // For new certs (not in existingCerts) we expect the INSERT to succeed.
      const ins = await client.query<{ cert_id: string }>(
        `INSERT INTO canonical.certificates
           (cert_authority, faa_cert_number, canonical_holder_name, operating_part,
            status, data_confidence_score)
         VALUES ('faa', $1, $2, '135', 'active_operating', 0.85)
         ON CONFLICT (faa_cert_number) WHERE faa_cert_number IS NOT NULL AND cert_authority='faa'
         DO NOTHING
         RETURNING cert_id`,
        [c.cert_designator, c.holder_name],
      );
      if (ins.rowCount === 1) certsInserted++;
    }

    // Bulk lookup all May 1 cert_designators → cert_id (covers both new + existing).
    const designators = Array.from(certHolders.keys());
    const idLookup = await client.query<{ faa_cert_number: string; cert_id: string }>(
      `SELECT faa_cert_number, cert_id FROM canonical.certificates
        WHERE cert_authority='faa' AND faa_cert_number = ANY($1::text[])`,
      [designators],
    );
    const certIdMap = new Map<string, string>();
    for (const r of idLookup.rows) certIdMap.set(r.faa_cert_number.toUpperCase(), r.cert_id);

    // Insert identity row per May 1 cert under SOURCE_NEW. Append-only audit.
    for (const [certDesignator, holderName] of certHolders) {
      const certId = certIdMap.get(certDesignator);
      if (!certId) {
        console.error(`[may1-cert-promote] FATAL: cert_id missing for ${certDesignator} after parent INSERT`);
        throw new Error(`cert_id missing for ${certDesignator}`);
      }
      const evidence = {
        xlsx_s3_key: MAY1_XLSX_S3_KEY,
        snapshot_date: "2026-05-01",
        source_timestamp: MAY1_SOURCE_TIMESTAMP,
        ingest_run_id: runId,
        checkpoint: "phase2_script1_may1_cert_promote",
      };
      const r = await client.query(
        `INSERT INTO canonical.certificate_identities
           (cert_id, source, source_id, holder_name_as_provided,
            match_confidence, match_method, match_evidence)
         VALUES ($1, $2, $3, $4, 'exact', 'direct_ingest_from_d085', $5::jsonb)
         ON CONFLICT (source, source_id) DO NOTHING`,
        [certId, SOURCE_NEW, certDesignator, holderName, JSON.stringify(evidence)],
      );
      if (r.rowCount === 1) identitiesInserted++;
    }

    const writeMs = Date.now() - startWrite;
    console.log(
      `[may1-cert-promote] inserts: certs=${certsInserted}, identities=${identitiesInserted}, ` +
        `wall=${(writeMs / 1000).toFixed(1)}s`,
    );

    // ── Step 5: in-transaction verification ─────────────────────────────
    const totals = await client.query<{ total: string; idents_new: string; idents_d085: string }>(
      `SELECT
         (SELECT COUNT(*)::bigint FROM canonical.certificates WHERE cert_authority='faa') AS total,
         (SELECT COUNT(*)::bigint FROM canonical.certificate_identities WHERE source=$1) AS idents_new,
         (SELECT COUNT(*)::bigint FROM canonical.certificate_identities WHERE source='faa_d085') AS idents_d085`,
      [SOURCE_NEW],
    );
    const t = totals.rows[0]!;
    console.log(`[may1-cert-promote] in-tx verification:`);
    console.log(`  canonical.certificates [cert_authority=faa]:        ${t.total}`);
    console.log(`  canonical.certificate_identities [${SOURCE_NEW}]:   ${t.idents_new}`);
    console.log(`  canonical.certificate_identities [faa_d085]:        ${t.idents_d085}`);

    // Sample verification: pick 3 new certs and confirm they're queryable.
    if (newCerts.length > 0) {
      const sampleCerts = newCerts.slice(0, 3).map((c) => c.cert_designator);
      const spotcheck = await client.query<{
        faa_cert_number: string;
        canonical_holder_name: string;
        ident_source: string;
      }>(
        `SELECT c.faa_cert_number, c.canonical_holder_name, ci.source AS ident_source
           FROM canonical.certificates c
           JOIN canonical.certificate_identities ci ON ci.cert_id = c.cert_id
          WHERE c.faa_cert_number = ANY($1::text[]) AND ci.source = $2
          ORDER BY c.faa_cert_number`,
        [sampleCerts, SOURCE_NEW],
      );
      console.log(`[may1-cert-promote] spot-check (3 new certs from this run):`);
      for (const r of spotcheck.rows) {
        console.log(`  - ${r.faa_cert_number}: ${r.canonical_holder_name} (ident_source=${r.ident_source})`);
      }
    }

    if (args.write) {
      await client.query("COMMIT");
      console.log(`[may1-cert-promote] COMMIT. run_id=${runId}`);
    } else {
      await client.query("ROLLBACK");
      console.log(`[may1-cert-promote] DRY-RUN: rolled back. Re-run with --write to apply.`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    console.error("[may1-cert-promote] FATAL:", err instanceof Error ? err.message : err);
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
