/**
 * FAA Part 135 Operators and Aircraft List — live URL fetch + S3 archive.
 *
 * The FAA restored the Part 135 list at a stable URL on 2026-05-01 after a
 * ~10-week deactivation. This ingester captures the live file (no Wayback
 * intermediary), writing to the same S3 layout that
 * `archive-faa-d085-wayback.ts` established for historical captures. Both
 * sources extend the same `_index.json` and share the same `snapshots/`
 * + `xlsx/` prefix.
 *
 * Per-snapshot S3 layout (mirrors the wayback ingester):
 *   s3://osa-dumont-backup/raw/faa/d085/snapshots/<pageTs>/page.html
 *   s3://osa-dumont-backup/raw/faa/d085/snapshots/<pageTs>/manifest.json
 *
 * Single xlsx storage (one per unique Last-Modified):
 *   s3://osa-dumont-backup/raw/faa/d085/xlsx/<pageTs>__<filename>
 *
 * Aggregate index extended in place:
 *   s3://osa-dumont-backup/raw/faa/d085/_index.json
 *
 * The `<pageTs>` is the xlsx's HTTP Last-Modified parsed to UTC
 * YYYYMMDDHHMMSS. Same Last-Modified → same keys → idempotent.
 *
 * Usage:
 *   npx tsx src/ingestion/faa-p135-list-fetch.ts --dry-run
 *   npx tsx src/ingestion/faa-p135-list-fetch.ts
 *   npx tsx src/ingestion/faa-p135-list-fetch.ts --force
 */

import { createHash } from "node:crypto";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type StorageClass,
} from "@aws-sdk/client-s3";
import { childLogger } from "../utils/logger.js";

const log = childLogger("faa-p135-list-fetch");

// ── Constants ───────────────────────────────────────────────────────────────

const S3_BUCKET = "osa-dumont-backup";
const S3_PREFIX = "raw/faa/d085";
const STORAGE_CLASS: StorageClass = "STANDARD";
const USER_AGENT = "Mozilla/5.0 (compatible; OSA-Dumont/1.0)";

const FAA_PAGE_URL =
  "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders";
const FAA_XLSX_URL =
  "https://www.faa.gov/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_List.xlsx";
const XLSX_FILENAME = "Part_135_Operators_and_Aircraft_List.xlsx";
const XLSX_CONTENT_TYPE_PREFIX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean;
  force: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * Parse an HTTP Last-Modified header (RFC 7231 IMF-fixdate) into a UTC
 * 14-digit YYYYMMDDHHMMSS string. Matches the cdxTs convention used by
 * `archive-faa-d085-wayback.ts` so live + historical entries share the
 * same key shape.
 */
function lastModifiedToTs(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`unparseable Last-Modified header: "${value}"`);
  }
  const iso = d.toISOString(); // 2026-05-01T17:20:56.000Z
  return iso.replace(/[-:T]/g, "").slice(0, 14);
}

function snapshotPrefix(pageTs: string): string {
  return `${S3_PREFIX}/snapshots/${pageTs}`;
}

const indexKey = `${S3_PREFIX}/_index.json`;

async function s3HeadOk(s3: S3Client, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === "NotFound" || code === "NoSuchKey") return false;
    throw err;
  }
}

async function s3GetText(s3: S3Client, key: string): Promise<string | null> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return await resp.Body!.transformToString();
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === "NotFound" || code === "NoSuchKey") return null;
    throw err;
  }
}

async function s3Put(
  s3: S3Client,
  key: string,
  body: Buffer | string,
  contentType: string,
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    StorageClass: STORAGE_CLASS,
  }));
}

interface HeadResult {
  etag: string | null;
  lastModified: string; // raw header value, must be present
  contentLength: number;
  contentType: string;
}

async function httpHead(url: string): Promise<HeadResult> {
  const resp = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP HEAD ${resp.status} ${resp.statusText} for ${url}`);
  }
  const lm = resp.headers.get("last-modified");
  if (!lm) {
    throw new Error(`missing Last-Modified on HEAD ${url}; cannot derive snapshot timestamp`);
  }
  const cl = resp.headers.get("content-length");
  return {
    etag: resp.headers.get("etag"),
    lastModified: lm,
    contentLength: cl ? Number.parseInt(cl, 10) : -1,
    contentType: resp.headers.get("content-type") ?? "",
  };
}

async function httpGetBytes(url: string): Promise<Buffer> {
  const resp = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`HTTP GET ${resp.status} ${resp.statusText} for ${url}`);
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

// ── Manifest (extends wayback shape with `*_live` + HTTP fields) ────────────

interface SnapshotManifest {
  snapshot_timestamp: string;
  page_url_original: string;
  page_url_wayback: string | null;
  page_url_live: string | null;
  page_archived_at: string | null;
  page_sha256: string | null;
  page_size_bytes: number | null;
  page_s3_key: string | null;
  page_http_last_modified: string | null;
  xlsx_referenced_filename: string;
  xlsx_referenced_size_label: string | null;
  xlsx_archived: boolean;
  xlsx_url_original: string;
  xlsx_url_wayback: string | null;
  xlsx_url_live: string | null;
  xlsx_archived_at: string;
  xlsx_sha256: string;
  xlsx_size_bytes: number;
  xlsx_s3_key: string;
  xlsx_cdx_timestamp: string | null;
  xlsx_http_etag: string | null;
  xlsx_http_last_modified: string;
  notes: string;
}

interface IndexSnapshotEntry {
  snapshot_timestamp: string;
  page_s3_key: string | null;
  page_sha256: string | null;
  xlsx_archived: boolean;
  xlsx_referenced_filename: string;
  xlsx_s3_key: string | null;
  xlsx_sha256: string | null;
  xlsx_size_bytes: number | null;
}

interface IndexFile {
  snapshot_count: number;
  xlsx_archived_count: number;
  xlsx_unique_versions: number;
  xlsx_gap_count: number;
  date_range: string;
  total_page_bytes: number;
  total_xlsx_bytes_deduplicated: number;
  last_indexed_at: string;
  gaps: Array<{ snapshot_timestamp: string; xlsx_referenced_filename: string }>;
  snapshots: IndexSnapshotEntry[];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const s3 = new S3Client({});

  console.log(`[faa-p135-list-fetch] FAA Part 135 list live URL → S3`);
  console.log(`[faa-p135-list-fetch] Bucket: s3://${S3_BUCKET}/${S3_PREFIX}/`);
  console.log(`[faa-p135-list-fetch] Storage class: ${STORAGE_CLASS}`);
  console.log(`[faa-p135-list-fetch] Mode: ${args.dryRun ? "DRY-RUN (no S3 writes)" : "LIVE"}${args.force ? " --force" : ""}`);

  // 1. HEAD xlsx — derive snapshot ts from Last-Modified.
  console.log(`[faa-p135-list-fetch] HEAD ${FAA_XLSX_URL}`);
  const xlsxHead = await httpHead(FAA_XLSX_URL);
  if (!xlsxHead.contentType.startsWith(XLSX_CONTENT_TYPE_PREFIX)) {
    throw new Error(
      `xlsx URL returned non-xlsx Content-Type "${xlsxHead.contentType}". ` +
        `This may indicate a "page-up-no-file" FAA outage.`,
    );
  }
  const pageTs = lastModifiedToTs(xlsxHead.lastModified);
  console.log(`[faa-p135-list-fetch] xlsx Last-Modified: ${xlsxHead.lastModified}`);
  console.log(`[faa-p135-list-fetch] derived snapshot ts: ${pageTs}`);
  console.log(`[faa-p135-list-fetch] xlsx ETag: ${xlsxHead.etag ?? "(none)"}, Content-Length: ${xlsxHead.contentLength}`);

  // 2. Compute target keys.
  const pageS3Key = `${snapshotPrefix(pageTs)}/page.html`;
  const manifestS3Key = `${snapshotPrefix(pageTs)}/manifest.json`;
  const xlsxS3Key = `${S3_PREFIX}/xlsx/${pageTs}__${XLSX_FILENAME}`;

  // 3. Idempotency check — manifest already in S3 means we've captured this
  // Last-Modified. Skip unless --force.
  if (!args.dryRun && !args.force && (await s3HeadOk(s3, manifestS3Key))) {
    console.log(
      `[faa-p135-list-fetch] manifest already in S3 at ${manifestS3Key} — Last-Modified unchanged. Exiting cleanly.`,
    );
    return;
  }

  // 4. Dry-run preview — fetch + hash to surface real sha256, but skip all
  // S3 writes. Faithful preview of the live run minus side effects.
  if (args.dryRun) {
    console.log();
    console.log(`[faa-p135-list-fetch] === DRY-RUN PROJECTION ===`);
    console.log(`[faa-p135-list-fetch] Fetching content (no S3 writes) to compute real sha256...`);
    const dryPageHead = await httpHead(FAA_PAGE_URL);
    const dryPageBuf = await httpGetBytes(FAA_PAGE_URL);
    const dryPageSha = sha256Hex(dryPageBuf);
    const dryXlsxBuf = await httpGetBytes(FAA_XLSX_URL);
    const dryXlsxSha = sha256Hex(dryXlsxBuf);
    console.log();
    console.log(`[faa-p135-list-fetch] Would write to S3:`);
    console.log(`  ${pageS3Key}`);
    console.log(`    size: ${formatBytes(dryPageBuf.byteLength)}, sha256: ${dryPageSha}`);
    console.log(`  ${xlsxS3Key}`);
    console.log(`    size: ${formatBytes(dryXlsxBuf.byteLength)}, sha256: ${dryXlsxSha}`);
    console.log(`  ${manifestS3Key}`);
    console.log(`    (manifest.json, ~1KB — contents below)`);
    console.log(`  ${indexKey}`);
    console.log(`    (rewritten with new snapshot entry — projection below)`);
    console.log();
    console.log(`[faa-p135-list-fetch] Manifest contents would be:`);
    const previewManifest: SnapshotManifest = {
      snapshot_timestamp: pageTs,
      page_url_original: FAA_PAGE_URL,
      page_url_wayback: null,
      page_url_live: FAA_PAGE_URL,
      page_archived_at: "(dry-run; would be NOW)",
      page_sha256: dryPageSha,
      page_size_bytes: dryPageBuf.byteLength,
      page_s3_key: pageS3Key,
      page_http_last_modified: dryPageHead.lastModified,
      xlsx_referenced_filename: XLSX_FILENAME,
      xlsx_referenced_size_label: null,
      xlsx_archived: true,
      xlsx_url_original: FAA_XLSX_URL,
      xlsx_url_wayback: null,
      xlsx_url_live: FAA_XLSX_URL,
      xlsx_archived_at: "(dry-run; would be NOW)",
      xlsx_sha256: dryXlsxSha,
      xlsx_size_bytes: dryXlsxBuf.byteLength,
      xlsx_s3_key: xlsxS3Key,
      xlsx_cdx_timestamp: null,
      xlsx_http_etag: xlsxHead.etag,
      xlsx_http_last_modified: xlsxHead.lastModified,
      notes: "Live fetch from FAA URL post-2026-05-01 restoration (no Wayback intermediary).",
    };
    console.log(JSON.stringify(previewManifest, null, 2).split("\n").map((l) => `  ${l}`).join("\n"));
    console.log();
    console.log(`[faa-p135-list-fetch] Index entry to append to snapshots[]:`);
    const previewIndexEntry: IndexSnapshotEntry = {
      snapshot_timestamp: pageTs,
      page_s3_key: pageS3Key,
      page_sha256: dryPageSha,
      xlsx_archived: true,
      xlsx_referenced_filename: XLSX_FILENAME,
      xlsx_s3_key: xlsxS3Key,
      xlsx_sha256: dryXlsxSha,
      xlsx_size_bytes: dryXlsxBuf.byteLength,
    };
    console.log(JSON.stringify(previewIndexEntry, null, 2).split("\n").map((l) => `  ${l}`).join("\n"));
    console.log();
    console.log(`[faa-p135-list-fetch] Dry-run complete. Re-run without --dry-run to perform writes.`);
    return;
  }

  // 5. Live fetch — page first, then xlsx.
  console.log(`[faa-p135-list-fetch] GET ${FAA_PAGE_URL}`);
  const pageHead = await httpHead(FAA_PAGE_URL);
  const pageBuf = await httpGetBytes(FAA_PAGE_URL);
  const pageSha = sha256Hex(pageBuf);
  const pageArchivedAt = new Date().toISOString();
  console.log(
    `[faa-p135-list-fetch] page: ${formatBytes(pageBuf.byteLength)}, sha256=${pageSha.slice(0, 16)}…`,
  );

  console.log(`[faa-p135-list-fetch] GET ${FAA_XLSX_URL}`);
  const xlsxBuf = await httpGetBytes(FAA_XLSX_URL);
  const xlsxSha = sha256Hex(xlsxBuf);
  const xlsxArchivedAt = new Date().toISOString();
  console.log(
    `[faa-p135-list-fetch] xlsx: ${formatBytes(xlsxBuf.byteLength)}, sha256=${xlsxSha.slice(0, 16)}…`,
  );

  if (xlsxHead.contentLength > 0 && xlsxBuf.byteLength !== xlsxHead.contentLength) {
    log.warn(
      { headLength: xlsxHead.contentLength, getLength: xlsxBuf.byteLength },
      "xlsx Content-Length disagreement",
    );
  }

  // 6. PUT to S3 — xlsx first, then page, then manifest. Order chosen so that
  // a partial-write failure leaves the most-recoverable state (xlsx in S3,
  // missing manifest = re-run will re-archive cleanly).
  console.log(`[faa-p135-list-fetch] PUT ${xlsxS3Key}`);
  await s3Put(s3, xlsxS3Key, xlsxBuf, XLSX_CONTENT_TYPE_PREFIX);

  console.log(`[faa-p135-list-fetch] PUT ${pageS3Key}`);
  await s3Put(s3, pageS3Key, pageBuf, "text/html; charset=utf-8");

  // 7. Build manifest.
  const manifest: SnapshotManifest = {
    snapshot_timestamp: pageTs,
    page_url_original: FAA_PAGE_URL,
    page_url_wayback: null,
    page_url_live: FAA_PAGE_URL,
    page_archived_at: pageArchivedAt,
    page_sha256: pageSha,
    page_size_bytes: pageBuf.byteLength,
    page_s3_key: pageS3Key,
    page_http_last_modified: pageHead.lastModified,
    xlsx_referenced_filename: XLSX_FILENAME,
    xlsx_referenced_size_label: null,
    xlsx_archived: true,
    xlsx_url_original: FAA_XLSX_URL,
    xlsx_url_wayback: null,
    xlsx_url_live: FAA_XLSX_URL,
    xlsx_archived_at: xlsxArchivedAt,
    xlsx_sha256: xlsxSha,
    xlsx_size_bytes: xlsxBuf.byteLength,
    xlsx_s3_key: xlsxS3Key,
    xlsx_cdx_timestamp: null,
    xlsx_http_etag: xlsxHead.etag,
    xlsx_http_last_modified: xlsxHead.lastModified,
    notes: "Live fetch from FAA URL post-2026-05-01 restoration (no Wayback intermediary).",
  };

  console.log(`[faa-p135-list-fetch] PUT ${manifestS3Key}`);
  await s3Put(s3, manifestS3Key, JSON.stringify(manifest, null, 2), "application/json");

  // 8. Update _index.json — read, append, sort, write back.
  console.log(`[faa-p135-list-fetch] reading existing _index.json`);
  const existingText = await s3GetText(s3, indexKey);
  if (!existingText) {
    throw new Error(`_index.json missing at s3://${S3_BUCKET}/${indexKey}; refusing to write a fresh index`);
  }
  const index = JSON.parse(existingText) as IndexFile;
  const alreadyIndexed = index.snapshots.some((s) => s.snapshot_timestamp === pageTs);
  if (alreadyIndexed && !args.force) {
    console.log(`[faa-p135-list-fetch] snapshot ${pageTs} already in _index.json — skipping index update`);
  } else {
    const newEntry: IndexSnapshotEntry = {
      snapshot_timestamp: pageTs,
      page_s3_key: pageS3Key,
      page_sha256: pageSha,
      xlsx_archived: true,
      xlsx_referenced_filename: XLSX_FILENAME,
      xlsx_s3_key: xlsxS3Key,
      xlsx_sha256: xlsxSha,
      xlsx_size_bytes: xlsxBuf.byteLength,
    };
    if (alreadyIndexed) {
      const idx = index.snapshots.findIndex((s) => s.snapshot_timestamp === pageTs);
      index.snapshots[idx] = newEntry;
    } else {
      index.snapshots.push(newEntry);
    }
    index.snapshots.sort((a, b) => a.snapshot_timestamp.localeCompare(b.snapshot_timestamp));

    // Recompute aggregates.
    const archived = index.snapshots.filter((s) => s.xlsx_archived);
    const uniqueXlsxKeys = new Set(archived.map((s) => s.xlsx_s3_key).filter((k): k is string => k !== null));
    index.snapshot_count = index.snapshots.length;
    index.xlsx_archived_count = archived.length;
    index.xlsx_unique_versions = uniqueXlsxKeys.size;
    index.xlsx_gap_count = index.snapshots.length - archived.length;
    index.last_indexed_at = new Date().toISOString();
    if (index.snapshots.length > 0) {
      const firstTs = index.snapshots[0]!.snapshot_timestamp;
      const lastTs = index.snapshots[index.snapshots.length - 1]!.snapshot_timestamp;
      const fmt = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
      index.date_range = `${fmt(firstTs)} to ${fmt(lastTs)}`;
    }
    index.total_xlsx_bytes_deduplicated =
      Array.from(uniqueXlsxKeys).reduce((sum, key) => {
        const entry = archived.find((s) => s.xlsx_s3_key === key);
        return sum + (entry?.xlsx_size_bytes ?? 0);
      }, 0);

    console.log(`[faa-p135-list-fetch] PUT ${indexKey}`);
    await s3Put(s3, indexKey, JSON.stringify(index, null, 2), "application/json");
  }

  console.log();
  console.log(`[faa-p135-list-fetch] === SUMMARY ===`);
  console.log(`  snapshot_timestamp: ${pageTs}`);
  console.log(`  xlsx_s3_key:        ${xlsxS3Key}`);
  console.log(`  xlsx_sha256:        ${xlsxSha}`);
  console.log(`  xlsx_size_bytes:    ${xlsxBuf.byteLength}`);
  console.log(`  manifest_s3_key:    ${manifestS3Key}`);
  console.log(`  index now has:      ${index.snapshot_count} snapshots`);
  console.log();
  console.log(`[faa-p135-list-fetch] Done.`);
}

main().catch((err) => {
  log.fatal({ err }, "faa-p135-list-fetch fatal error");
  console.error(err);
  process.exit(1);
});
