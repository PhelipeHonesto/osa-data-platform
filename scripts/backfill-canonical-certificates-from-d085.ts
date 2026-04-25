/**
 * Track 6 Step 2a — backfill canonical.certificates from FAA D085 archive.
 *
 * Reads 12 deduplicated FAA OpSpec D085 xlsx snapshots from
 *   s3://osa-dumont-backup/raw/faa/d085/
 * (per src/ingestion/archive-faa-d085-wayback.ts; index lives at _index.json),
 * parses each via src/utils/d085-parser.ts, aggregates by FAA cert designator
 * across all snapshots, and writes:
 *   - canonical.certificates                 (one row per unique cert designator)
 *   - canonical.certificate_identities       (1:1, source='faa_d085')
 *   - canonical.certificate_aliases          (former_legal_name across snapshots;
 *                                             D085 has no DBA column)
 *
 * Identifier note: D085 publishes the 4-char "Certificate Designator"
 * (e.g. PRIA = Priester, 9JLA = Jet Linx, EJA = NetJets) — NOT the 8-char
 * cert number (e.g. 1OCA082A) found in the FAA Air Carrier Certificate
 * database (av-info.faa.gov, currently blocked). The two are distinct
 * FAA-internal forms of the same identity and must be reconciled later
 * when the av-info source comes online; for now the 4-char designator is
 * the canonical Tier-1 anchor stored in faa_cert_number.
 *
 * Mirrors scripts/backfill-canonical-aircraft-from-faa.ts pattern:
 *   - default dry-run, --write to commit
 *   - single outer transaction; ROLLBACK on dry-run, COMMIT on write
 *   - refused-if-populated guardrail on (source='faa_d085')
 *   - structured run_id stamped in match_evidence JSONB
 *
 * Status: every cert observed in any D085 snapshot → status='active_operating'.
 * Schema-defined 'pending' means "applied for but not issued" and does not
 * apply to historical snapshots. Lifecycle transitions (surrendered / revoked /
 * consolidated) require cross-snapshot diff + corroboration; that work belongs
 * to canonical.certificate_events (Step 2d), not Step 2a.
 *
 * Confidence: flat 0.85. Single Tier-1 source, not yet corroborated.
 * Step 5 corroboration with DOT Part 295/298 raises it.
 *
 * Spot-checks (parser-correctness gate): PRIA → Priester Aviation,
 * 9JLA → Jet Linx Aviation. If absent post-write, parser is wrong —
 * investigate column-map or designator-format regex.
 *
 * Usage:
 *   tsx scripts/backfill-canonical-certificates-from-d085.ts                      # dry-run (default)
 *   tsx scripts/backfill-canonical-certificates-from-d085.ts --write              # actually mutate
 *   tsx scripts/backfill-canonical-certificates-from-d085.ts --max-snapshots=1    # smoke-test single xlsx
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
  fetchS3Json,
  fetchS3Buffer,
  parseD085Xlsx,
} from "../src/utils/d085-parser.js";

// ── Constants ─────────────────────────────────────────────────────────────

const SOURCE = "faa_d085";

// ── Types (2a-specific aggregation) ───────────────────────────────────────

interface CertObservation {
  xlsx_s3_key: string;
  xlsx_cdx_ts: string;
  holder_name: string;
  dba_name: string | null;
}

interface AggregatedCert {
  cert_number: string;
  /** Sorted by xlsx_cdx_ts ASC; last element is most recent. */
  observations: CertObservation[];
}

interface Args {
  write: boolean;
  maxSnapshots: number | null;
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

function aggregateRows(allRows: D085Row[]): Map<string, AggregatedCert> {
  // Sort by xlsx_cdx_ts ASC so observations[] is earliest-first; observations
  // for the same cert within the same xlsx collapse to one entry (D085 lists
  // one row per aircraft, so a cert with N tails appears N times in one xlsx).
  allRows.sort((a, b) => a.xlsx_cdx_ts.localeCompare(b.xlsx_cdx_ts));
  const m = new Map<string, AggregatedCert>();
  for (const r of allRows) {
    const certKey = r.cert_number.toUpperCase();
    let agg = m.get(certKey);
    if (!agg) {
      agg = { cert_number: certKey, observations: [] };
      m.set(certKey, agg);
    }
    const existingForXlsx = agg.observations.find((o) => o.xlsx_s3_key === r.xlsx_s3_key);
    if (existingForXlsx) {
      // Within one xlsx, prefer non-null DBA over null (one cert can have
      // multiple aircraft rows; DBA may be filled on some, blank on others).
      if (!existingForXlsx.dba_name && r.dba_name) {
        existingForXlsx.dba_name = r.dba_name;
      }
      // Keep the holder_name from the first row of this xlsx for stability.
    } else {
      agg.observations.push({
        xlsx_s3_key: r.xlsx_s3_key,
        xlsx_cdx_ts: r.xlsx_cdx_ts,
        holder_name: r.holder_name,
        dba_name: r.dba_name,
      });
    }
  }
  return m;
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

  console.log(`[d085-backfill] run_id=${runId}`);
  console.log(`[d085-backfill] mode=${args.write ? "WRITE" : "DRY-RUN"}`);

  // ── Step 1: read S3 _index.json, identify available xlsx files ─────────
  console.log(`[d085-backfill] reading s3://${S3_BUCKET}/${INDEX_KEY}`);
  const index = await fetchS3Json<IndexFile>(s3, INDEX_KEY);
  console.log(
    `[d085-backfill] index: ${index.snapshot_count} page snapshots, ` +
      `${index.xlsx_unique_versions} unique xlsx, ${index.xlsx_gap_count} gaps, ` +
      `range ${index.date_range}`,
  );

  // Dedupe xlsx_s3_key: multiple page snapshots reference the same xlsx.
  const xlsxKeySet = new Set<string>();
  for (const snap of index.snapshots) {
    if (snap.xlsx_archived && snap.xlsx_s3_key) xlsxKeySet.add(snap.xlsx_s3_key);
  }
  const uniqueXlsxKeys = Array.from(xlsxKeySet).sort();
  console.log(`[d085-backfill] unique xlsx s3 keys to process: ${uniqueXlsxKeys.length}`);

  if (args.maxSnapshots !== null) {
    uniqueXlsxKeys.splice(args.maxSnapshots);
    console.log(`[d085-backfill] capped to first ${args.maxSnapshots} xlsx via --max-snapshots`);
  }

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '300s'`);

    // ── Step 2: refused-if-populated guardrail ─────────────────────────────
    const existing = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM canonical.certificate_identities WHERE source = $1`,
      [SOURCE],
    );
    const existingCount = Number.parseInt(existing.rows[0]!.n, 10);
    if (existingCount > 0) {
      console.log(
        `[d085-backfill] canonical.certificate_identities already has ${existingCount} rows ` +
          `with source='${SOURCE}'. Refusing to re-run. Exiting cleanly.`,
      );
      return;
    }

    // ── Step 3: fetch + parse all xlsx ─────────────────────────────────────
    const allRows: D085Row[] = [];
    const perXlsxStats: Array<{ key: string; rowCount: number; uniqueCertCount: number; ms: number }> = [];

    for (let i = 0; i < uniqueXlsxKeys.length; i++) {
      const key = uniqueXlsxKeys[i]!;
      const startMs = Date.now();
      console.log(`[d085-backfill] [${i + 1}/${uniqueXlsxKeys.length}] fetching ${key}`);
      const buf = await fetchS3Buffer(s3, key);
      const rows = parseD085Xlsx(buf, key);
      const ms = Date.now() - startMs;
      const uniqueCerts = new Set(rows.map((r) => r.cert_number.toUpperCase())).size;
      console.log(`[d085-backfill]   ${rows.length} rows, ${uniqueCerts} distinct cert_numbers, ${ms}ms`);
      perXlsxStats.push({ key, rowCount: rows.length, uniqueCertCount: uniqueCerts, ms });
      allRows.push(...rows);
    }

    console.log(
      `[d085-backfill] parsed total: ${allRows.length} rows across ${uniqueXlsxKeys.length} xlsx`,
    );

    // ── Step 4: aggregate across snapshots ─────────────────────────────────
    const aggregated = aggregateRows(allRows);
    console.log(`[d085-backfill] aggregated: ${aggregated.size} unique cert_numbers`);

    // ── Step 5: filter via designator regex ────────────────────────────────
    const valid: AggregatedCert[] = [];
    const invalid: AggregatedCert[] = [];
    for (const cert of aggregated.values()) {
      if (CERT_REGEX_FAA_DESIGNATOR.test(cert.cert_number)) valid.push(cert);
      else invalid.push(cert);
    }
    console.log(`[d085-backfill] designator format: ${valid.length} pass regex, ${invalid.length} skipped`);
    if (invalid.length > 0) {
      console.log(`[d085-backfill] sample skipped (first 10):`);
      for (const c of invalid.slice(0, 10)) {
        const latest = c.observations[c.observations.length - 1]!;
        console.log(`  - "${c.cert_number}" (holder: "${latest.holder_name}")`);
      }
    }

    // ── Step 6: insert into canonical (single outer transaction) ───────────
    await client.query("BEGIN");
    const startWrite = Date.now();

    let certsInserted = 0;
    let identitiesInserted = 0;
    let dbaAliases = 0;
    let formerNameAliases = 0;

    for (const cert of valid) {
      const observations = cert.observations; // earliest → latest
      const latest = observations[observations.length - 1]!;
      const earliest = observations[0]!;
      const canonicalHolderName = latest.holder_name;

      // Distinct prior holder names (former_legal_name aliases): every name
      // seen in earlier snapshots that differs from the most-recent name.
      const priorNames = Array.from(new Set(
        observations.slice(0, -1).map((o) => o.holder_name),
      )).filter((n) => n && n !== canonicalHolderName);

      // Distinct DBA names across all observations (excluding any that
      // accidentally equals the holder name).
      const distinctDbas = Array.from(new Set(
        observations.map((o) => o.dba_name).filter((d): d is string => !!d),
      )).filter((dba) => dba !== canonicalHolderName);

      const evidence = {
        xlsx_s3_keys_seen: observations.map((o) => o.xlsx_s3_key),
        xlsx_count: observations.length,
        first_seen_xlsx_cdx_ts: earliest.xlsx_cdx_ts,
        last_seen_xlsx_cdx_ts: latest.xlsx_cdx_ts,
        ingest_run_id: runId,
        checkpoint: "track6_step2a_d085",
      };

      const certRes = await client.query<{ cert_id: string }>(
        `INSERT INTO canonical.certificates
           (cert_authority, faa_cert_number, canonical_holder_name, operating_part,
            status, data_confidence_score)
         VALUES ('faa', $1, $2, '135', 'active_operating', 0.85)
         RETURNING cert_id`,
        [cert.cert_number, canonicalHolderName],
      );
      const certId = certRes.rows[0]!.cert_id;
      certsInserted++;

      await client.query(
        `INSERT INTO canonical.certificate_identities
           (cert_id, source, source_id, holder_name_as_provided,
            match_confidence, match_method, match_evidence)
         VALUES ($1, $2, $3, $4, 'exact', 'direct_ingest_from_d085', $5::jsonb)`,
        [certId, SOURCE, cert.cert_number, canonicalHolderName, JSON.stringify(evidence)],
      );
      identitiesInserted++;

      for (const dba of distinctDbas) {
        const r = await client.query(
          `INSERT INTO canonical.certificate_aliases
             (cert_id, alias, alias_normalized, alias_type, source)
           VALUES ($1, $2, LOWER(TRIM($2)), 'dba', $3)
           ON CONFLICT (cert_id, alias_normalized, alias_type) DO NOTHING`,
          [certId, dba, SOURCE],
        );
        if (r.rowCount === 1) dbaAliases++;
      }

      for (const prior of priorNames) {
        const r = await client.query(
          `INSERT INTO canonical.certificate_aliases
             (cert_id, alias, alias_normalized, alias_type, source)
           VALUES ($1, $2, LOWER(TRIM($2)), 'former_legal_name', $3)
           ON CONFLICT (cert_id, alias_normalized, alias_type) DO NOTHING`,
          [certId, prior, SOURCE],
        );
        if (r.rowCount === 1) formerNameAliases++;
      }
    }

    const writeMs = Date.now() - startWrite;
    console.log(
      `[d085-backfill] inserts: certs=${certsInserted}, identities=${identitiesInserted}, ` +
        `aliases.dba=${dbaAliases}, aliases.former_legal_name=${formerNameAliases}, ` +
        `wall=${(writeMs / 1000).toFixed(1)}s`,
    );

    // ── Step 7: in-transaction verification ────────────────────────────────
    const spotcheck = await client.query<{
      faa_cert_number: string;
      canonical_holder_name: string | null;
      status: string;
      xlsx_count: string | null;
    }>(
      `SELECT c.faa_cert_number, c.canonical_holder_name, c.status,
              ci.match_evidence->>'xlsx_count' AS xlsx_count
         FROM canonical.certificates c
         JOIN canonical.certificate_identities ci
           ON ci.cert_id = c.cert_id AND ci.source = $1
        WHERE c.faa_cert_number IN ('PRIA', '9JLA')
        ORDER BY c.faa_cert_number`,
      [SOURCE],
    );
    console.log(`[d085-backfill] spot-checks (PRIA=Priester, 9JLA=Jet Linx):`);
    if (spotcheck.rowCount === 0) {
      console.log(`  (none found — parser may be wrong; inspect xlsx column-map and cert regex)`);
    } else {
      for (const row of spotcheck.rows) {
        console.log(
          `  - ${row.faa_cert_number}: ${row.canonical_holder_name} ` +
            `(status=${row.status}, xlsx_count=${row.xlsx_count})`,
        );
      }
    }

    const verifyAliases = await client.query<{ alias_type: string; n: string }>(
      `SELECT alias_type, COUNT(*)::bigint AS n
         FROM canonical.certificate_aliases WHERE source = $1
        GROUP BY alias_type ORDER BY alias_type`,
      [SOURCE],
    );
    console.log(`[d085-backfill] aliases by type (in-tx):`);
    for (const r of verifyAliases.rows) console.log(`  - ${r.alias_type}: ${r.n}`);

    const verifyStatus = await client.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::bigint AS n
         FROM canonical.certificates WHERE cert_authority='faa'
        GROUP BY status ORDER BY status`,
    );
    console.log(`[d085-backfill] cert status distribution (in-tx):`);
    for (const r of verifyStatus.rows) console.log(`  - ${r.status}: ${r.n}`);

    if (args.write) {
      await client.query("COMMIT");
      console.log(`[d085-backfill] COMMIT. run_id=${runId}`);

      // Post-COMMIT verification.
      const certCount = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.certificates WHERE cert_authority='faa'`,
      );
      const idCount = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.certificate_identities WHERE source = $1`,
        [SOURCE],
      );
      console.log(
        `[d085-backfill] verify post-commit: certificates[faa]=${certCount.rows[0]!.n}, ` +
          `identities[faa_d085]=${idCount.rows[0]!.n}`,
      );
    } else {
      await client.query("ROLLBACK");
      console.log(`[d085-backfill] DRY-RUN: rolled back. Re-run with --write to apply.`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    console.error("[d085-backfill] FATAL:", err instanceof Error ? err.message : err);
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
