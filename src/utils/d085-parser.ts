/**
 * Shared parser for FAA OpSpec D085 (Part 135 Operators and Aircraft) xlsx
 * archives in s3://osa-dumont-backup/raw/faa/d085/.
 *
 * Used by:
 *   - scripts/backfill-canonical-certificates-from-d085.ts (Track 6 Step 2a)
 *   - scripts/backfill-canonical-aircraft-on-certificate-from-d085.ts (Step 2b)
 *
 * Returns one D085Row per data row in each xlsx — { cert, holder, dba, tail }.
 * 2a aggregates by cert designator and discards tail_number; 2b aggregates
 * by (cert × tail) for fleet-on-certificate window construction.
 *
 * Column-detection is defensive: each logical field has a list of candidate
 * header names (case-insensitive, whitespace-trim). First match wins. If a
 * REQUIRED column isn't found within HEADER_SCAN_ROWS rows, parseD085Xlsx
 * dumps observed headers and bails with a message identifying which entry
 * to update.
 *
 * Observed D085 schemas:
 *   Pre-2026-05 (12 archived xlsx, 2023-01-25 → 2026-02-16):
 *     "Part 135 Certificate Holder Name" | "Certificate Designator" |
 *     "FAA Certificate Holding District Office" | "Registration Number" |
 *     "Serial Number" | "Aircraft Make/Model/Series"
 *   Post-2026-05 (FAA restoration 2026-05-01, weekly cadence):
 *     "CFR" | "CHDO" | "DSGN" | "Name" | "Aircraft M/M/S" |
 *     "Registration No." | "Serial No."
 * The 2023-only "CFR" column was dropped in 2024–2026-02 headers, then
 * returned as the leading column in the 2026-05 dialect with values
 * '135' (~98.9%) and '121/135' (~1.1%).
 * No DBA column exists in either dialect; aliases of type 'dba' are
 * sourced from av-info.faa.gov in Step B (parallel track).
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import * as XLSX from "xlsx";

// ── Constants ─────────────────────────────────────────────────────────────

export const S3_BUCKET = "osa-dumont-backup";
export const S3_PREFIX = "raw/faa/d085";
export const INDEX_KEY = `${S3_PREFIX}/_index.json`;

/**
 * FAA Part 135 Certificate Designator format: 3-5 alphanumeric characters.
 * Examples: PRIA (Priester), 9JLA (Jet Linx), EJA (NetJets), 1C6A (24/7 Jet),
 * P0TA (Prescott Support), 26NA (26 North Aviation).
 *
 * Distinct from the 8-char FAA Air Carrier DB form (e.g. 1OCA082A) which is
 * the same identity in another representation. Reconcile in Step 5 when the
 * av-info.faa.gov source comes online.
 */
export const CERT_REGEX_FAA_DESIGNATOR = /^[0-9A-Z]{3,5}$/;

/**
 * Scan up to HEADER_SCAN_ROWS rows for the first row that contains BOTH a
 * cert_number candidate AND an operator_name candidate. FAA D085 spreadsheets
 * lead with a multi-row banner (Title 14 CFR Part 135..., UPDATED: M/D/YYYY),
 * sometimes followed by blank rows, before the actual column headers.
 */
export const HEADER_SCAN_ROWS = 30;

/**
 * Column-name candidates per logical field. Ordering matters: first match
 * wins. Prefer the most-explicit candidate. Update this map if a future xlsx
 * version uses a name not listed here — the parser will tell you which entry
 * to add.
 */
export const COLUMNS = {
  cert_number: {
    required: true,
    candidates: [
      "Certificate Designator",
      "Certificate Number",
      "FAA Certificate Number",
      "DSGN",
    ],
  },
  operator_name: {
    required: true,
    candidates: [
      "Part 135 Certificate Holder Name",
      "Certificate Holder Name",
      "Operator Name",
      "Holder Name",
      "Name",
    ],
  },
  dba_name: {
    required: false,
    candidates: ["DBA", "DBA Name", "Doing Business As", "Trade Name", "D/B/A"],
  },
  tail_number: {
    required: false,
    candidates: [
      "Registration Number",
      "Registration No.",
      "N-Number",
      "N Number",
      "Tail Number",
      "Tail",
      "Aircraft Registration",
    ],
  },
  operating_part: {
    required: false,
    candidates: ["CFR"],
  },
  fsdo: {
    required: false,
    candidates: ["CHDO", "FAA Certificate Holding District Office"],
  },
  make_model_series: {
    required: false,
    candidates: ["Aircraft M/M/S", "Aircraft Make/Model/Series"],
  },
} as const;

// ── Types ─────────────────────────────────────────────────────────────────

export interface IndexFile {
  snapshot_count: number;
  xlsx_archived_count: number;
  xlsx_unique_versions: number;
  xlsx_gap_count: number;
  date_range: string;
  snapshots: Array<{
    snapshot_timestamp: string;
    page_s3_key: string;
    xlsx_archived: boolean;
    xlsx_referenced_filename: string;
    xlsx_s3_key: string | null;
    xlsx_sha256: string | null;
    xlsx_size_bytes: number | null;
  }>;
}

export interface D085Row {
  cert_number: string;
  holder_name: string;
  dba_name: string | null;
  tail_number: string | null;
  operating_part: string | null;
  fsdo: string | null;
  make_model_series: string | null;
  xlsx_s3_key: string;
  xlsx_cdx_ts: string;
}

interface HeaderHit {
  rowIndex: number;
  headers: string[];
  certIdx: number;
  nameIdx: number;
  dbaIdx: number;
  tailIdx: number;
  operatingPartIdx: number;
  fsdoIdx: number;
  mmsIdx: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function extractCdxTsFromKey(key: string): string {
  // xlsx_s3_key shape: "raw/faa/d085/xlsx/<14-digit-cdxTs>__<filename>"
  const m = key.match(/\/xlsx\/(\d{14})__/);
  if (!m) throw new Error(`unable to extract CDX timestamp from xlsx S3 key: ${key}`);
  return m[1]!;
}

export function cdxTsToDate(cdxTs: string): string {
  // '20230125163002' → '2023-01-25' (ISO date, UTC)
  if (!/^\d{14}$/.test(cdxTs)) {
    throw new Error(`invalid CDX timestamp (expected 14 digits): "${cdxTs}"`);
  }
  return `${cdxTs.slice(0, 4)}-${cdxTs.slice(4, 6)}-${cdxTs.slice(6, 8)}`;
}

export async function fetchS3Json<T>(s3: S3Client, key: string): Promise<T> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const text = await resp.Body!.transformToString();
  return JSON.parse(text) as T;
}

export async function fetchS3Buffer(s3: S3Client, key: string): Promise<Buffer> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const ab = await resp.Body!.transformToByteArray();
  return Buffer.from(ab);
}

function normalizeHeader(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

function findColumnIndex(headers: string[], candidates: readonly string[]): number {
  const normHeaders = headers.map(normalizeHeader);
  for (const cand of candidates) {
    const norm = normalizeHeader(cand);
    const idx = normHeaders.indexOf(norm);
    if (idx >= 0) return idx;
  }
  return -1;
}

function findHeaderRow(rows: unknown[][]): HeaderHit | null {
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const hs = row.map((h) => String(h ?? ""));
    const certIdx = findColumnIndex(hs, COLUMNS.cert_number.candidates);
    const nameIdx = findColumnIndex(hs, COLUMNS.operator_name.candidates);
    if (certIdx >= 0 && nameIdx >= 0) {
      const dbaIdx = findColumnIndex(hs, COLUMNS.dba_name.candidates);
      const tailIdx = findColumnIndex(hs, COLUMNS.tail_number.candidates);
      const operatingPartIdx = findColumnIndex(hs, COLUMNS.operating_part.candidates);
      const fsdoIdx = findColumnIndex(hs, COLUMNS.fsdo.candidates);
      const mmsIdx = findColumnIndex(hs, COLUMNS.make_model_series.candidates);
      return { rowIndex: r, headers: hs, certIdx, nameIdx, dbaIdx, tailIdx, operatingPartIdx, fsdoIdx, mmsIdx };
    }
  }
  return null;
}

export function parseD085Xlsx(buf: Buffer, xlsxS3Key: string): D085Row[] {
  const cdxTs = extractCdxTsFromKey(xlsxS3Key);
  const wb = XLSX.read(buf, { type: "buffer" });
  if (wb.SheetNames.length === 0) {
    throw new Error(`no sheets in xlsx: ${xlsxS3Key}`);
  }
  // Walk sheets first → last; pick the first sheet that has a header row
  // with both required columns within the first HEADER_SCAN_ROWS rows.
  let chosenSheetName: string | null = null;
  let dataRows: unknown[][] = [];
  let hit: HeaderHit | null = null;
  const sheetReports: string[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    if (rows.length < 2) {
      sheetReports.push(`  - ${sheetName}: empty or 1 row`);
      continue;
    }
    const found = findHeaderRow(rows);
    if (found) {
      chosenSheetName = sheetName;
      hit = found;
      dataRows = rows.slice(found.rowIndex + 1) as unknown[][];
      break;
    }
    const firstRow = (rows[0] as unknown[]).map((h) => String(h ?? ""));
    sheetReports.push(`  - ${sheetName} (row 0): [${firstRow.slice(0, 12).join(" | ")}]`);
  }

  if (!chosenSheetName || !hit) {
    throw new Error(
      `xlsx column-map mismatch in ${xlsxS3Key}. ` +
      `No sheet had both a cert_number column (candidates: ${COLUMNS.cert_number.candidates.join(", ")}) ` +
      `and an operator_name column (candidates: ${COLUMNS.operator_name.candidates.join(", ")}) ` +
      `within the first ${HEADER_SCAN_ROWS} rows.\n` +
      `Sheets inspected:\n${sheetReports.join("\n")}\n` +
      `Update the COLUMNS constant in src/utils/d085-parser.ts to match.`,
    );
  }

  const out: D085Row[] = [];
  for (const row of dataRows) {
    const cert = String(row[hit.certIdx] ?? "").trim();
    const name = String(row[hit.nameIdx] ?? "").trim();
    const dba = hit.dbaIdx >= 0 ? String(row[hit.dbaIdx] ?? "").trim() : "";
    const tail = hit.tailIdx >= 0 ? String(row[hit.tailIdx] ?? "").trim() : "";
    const operatingPart = hit.operatingPartIdx >= 0 ? String(row[hit.operatingPartIdx] ?? "").trim() : "";
    const fsdo = hit.fsdoIdx >= 0 ? String(row[hit.fsdoIdx] ?? "").trim() : "";
    const mms = hit.mmsIdx >= 0 ? String(row[hit.mmsIdx] ?? "").trim() : "";
    if (!cert || !name) continue;
    out.push({
      cert_number: cert,
      holder_name: name,
      dba_name: dba || null,
      tail_number: tail || null,
      operating_part: operatingPart || null,
      fsdo: fsdo || null,
      make_model_series: mms || null,
      xlsx_s3_key: xlsxS3Key,
      xlsx_cdx_ts: cdxTs,
    });
  }
  return out;
}
