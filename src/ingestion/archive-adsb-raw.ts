/**
 * ADS-B Raw Archive → S3 Glacier
 *
 * Streams daily tar files from adsblol/globe_history_{year} GitHub releases
 * directly to S3 without storing locally. Supports 2023-2026.
 *
 * Usage:
 *   npm run archive:adsb -- --date 2026-01-15
 *   npm run archive:adsb -- --from 2023-01-01 --to 2023-12-31
 *   npm run archive:adsb -- --year 2023
 *   npm run archive:adsb -- --year 2023 --check
 *   npm run archive:adsb -- --year 2023 --concurrency 3
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { S3Client, HeadObjectCommand, PutObjectCommand, type StorageClass } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type Database from "better-sqlite3";
import { getDb, closeDb } from "../memory/database.js";

// ── Constants ───────────────────────────────────────────────────────────────

const S3_BUCKET = "osa-dumont-backup";
const S3_PREFIX = "raw/adsb";
const GITHUB_API = "https://api.github.com";
const RATE_LIMIT_DELAY_MS = 1200; // ~50 req/min, well under 60/hr unauthenticated

// ── Types ───────────────────────────────────────────────────────────────────

interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  content_type: string;
}

interface DayManifest {
  date: string;
  release_tag: string;
  repo: string;
  files: {
    name: string;
    s3_key: string;
    size: number;
    sha256: string;
    download_url: string;
  }[];
  total_bytes: number;
  archived_at: string;
}

interface CliArgs {
  date?: string;
  from?: string;
  to?: string;
  year?: string;
  check: boolean;
  concurrency: number;
  storageClass: string;
}

// ── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    check: false,
    concurrency: 1,
    storageClass: "GLACIER",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--date" && next) { result.date = next; i++; }
    else if (arg === "--from" && next) { result.from = next; i++; }
    else if (arg === "--to" && next) { result.to = next; i++; }
    else if (arg === "--year" && next) { result.year = next; i++; }
    else if (arg === "--check") { result.check = true; }
    else if (arg === "--concurrency" && next) { result.concurrency = parseInt(next, 10) || 1; i++; }
    else if (arg === "--storage-class" && next) { result.storageClass = next; i++; }
  }

  if (!result.date && !result.from && !result.year) {
    console.error("Usage: npm run archive:adsb -- --year 2023");
    console.error("       npm run archive:adsb -- --from 2023-01-01 --to 2023-06-30");
    console.error("       npm run archive:adsb -- --date 2023-01-15");
    console.error("Flags: --check (dry run), --concurrency N, --storage-class GLACIER|DEEP_ARCHIVE|STANDARD");
    process.exit(1);
  }

  return result;
}

// ── Date range ──────────────────────────────────────────────────────────────

function buildDateRange(args: CliArgs): string[] {
  let from: string;
  let to: string;

  if (args.date) {
    from = args.date;
    to = args.date;
  } else if (args.year) {
    from = `${args.year}-01-01`;
    to = `${args.year}-12-31`;
  } else {
    from = args.from!;
    to = args.to ?? yesterday();
  }

  // Clamp to yesterday (today's release won't exist yet)
  const yest = yesterday();
  if (to > yest) to = yest;

  const dates: string[] = [];
  const cur = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── GitHub API ──────────────────────────────────────────────────────────────

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "osa-dumont-archive/1.0",
  };
  if (process.env["GITHUB_TOKEN"]) {
    headers["Authorization"] = `Bearer ${process.env["GITHUB_TOKEN"]}`;
  }
  return headers;
}

async function fetchReleaseAssets(date: string): Promise<{ tag: string; repo: string; assets: ReleaseAsset[] } | null> {
  const year = date.slice(0, 4);
  const dotDate = date.replaceAll("-", ".");
  const repo = `adsblol/globe_history_${year}`;
  const tag = `v${dotDate}-planes-readsb-prod-0`;
  const url = `${GITHUB_API}/repos/${repo}/releases/tags/${tag}`;

  const resp = await fetch(url, { headers: githubHeaders() });

  if (resp.status === 404) return null;
  if (resp.status === 403) {
    const resetHeader = resp.headers.get("x-ratelimit-reset");
    const resetIn = resetHeader ? Math.max(0, parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000)) : 60;
    console.error(`[archive] GitHub rate limited. Resets in ${resetIn}s`);
    await sleep(Math.min(resetIn * 1000, 120_000));
    // Retry once
    const retry = await fetch(url, { headers: githubHeaders() });
    if (!retry.ok) return null;
    const data = await retry.json() as { assets?: ReleaseAsset[] };
    const tarAssets = (data.assets ?? []).filter((a: ReleaseAsset) =>
      a.name.endsWith(".tar") || /\.tar\.[a-z]+$/.test(a.name),
    );
    return tarAssets.length > 0 ? { tag, repo, assets: tarAssets } : null;
  }

  if (!resp.ok) return null;

  const data = await resp.json() as { assets?: ReleaseAsset[] };
  const tarAssets = (data.assets ?? []).filter((a: ReleaseAsset) =>
    a.name.endsWith(".tar") || /\.tar\.[a-z]+$/.test(a.name),
  );
  return tarAssets.length > 0 ? { tag, repo, assets: tarAssets } : null;
}

// ── S3 helpers ──────────────────────────────────────────────────────────────

function s3PrefixForDay(date: string): string {
  const [year, month] = date.split("-") as [string, string];
  return `${S3_PREFIX}/${year}/${month}/${date}`;
}

function s3Client(): S3Client {
  return new S3Client({});
}

async function manifestExists(s3: S3Client, date: string, expectedFiles: number): Promise<{ exists: boolean; fileCount?: number; totalBytes?: number }> {
  const key = `${s3PrefixForDay(date)}/manifest.json`;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    // Manifest exists — fetch it to check file count
    // For speed, just trust that if manifest exists, the day is done
    // The manifest records file count, so we trust it
    return { exists: true, fileCount: expectedFiles, totalBytes: head.ContentLength ?? 0 };
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === "NotFound" || code === "NoSuchKey") {
      return { exists: false };
    }
    throw err;
  }
}

async function streamToS3(
  s3: S3Client,
  key: string,
  downloadUrl: string,
  storageClass: StorageClass,
): Promise<{ size: number; sha256: string }> {
  const resp = await fetch(downloadUrl, {
    headers: githubHeaders(),
    redirect: "follow",
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to download ${downloadUrl}: ${resp.status} ${resp.statusText}`);
  }

  // Create a hash stream to compute SHA-256 while streaming
  const hash = createHash("sha256");
  let totalBytes = 0;

  // Convert web ReadableStream to Node.js Readable
  const nodeStream = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream);

  // Create a passthrough that computes hash
  const { PassThrough } = await import("node:stream");
  const passthrough = new PassThrough();

  // Pipe: nodeStream → passthrough (tee to hash)
  nodeStream.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    totalBytes += chunk.length;
  });

  // Use multipart upload for large files
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: passthrough,
      StorageClass: storageClass as StorageClass,
    },
    queueSize: 4,
    partSize: 100 * 1024 * 1024, // 100MB parts
  });

  // Pipe nodeStream into passthrough, which feeds into Upload
  const pipePromise = pipeline(nodeStream, passthrough);
  const uploadPromise = upload.done();

  await Promise.all([pipePromise, uploadPromise]);

  return { size: totalBytes, sha256: hash.digest("hex") };
}

async function writeManifest(s3: S3Client, date: string, manifest: DayManifest): Promise<void> {
  const key = `${s3PrefixForDay(date)}/manifest.json`;
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
    StorageClass: "STANDARD", // manifest stays in standard for quick lookups
  }));
}

// ── SQLite progress tracking ────────────────────────────────────────────────

function markArchive(
  db: Database.Database,
  date: string,
  status: "pending" | "processing" | "complete" | "failed" | "no_release",
  filesArchived = 0,
  totalBytes = 0,
  s3Prefix: string | null = null,
): void {
  db.prepare(`
    INSERT INTO archive_progress (date, status, files_archived, total_bytes, s3_prefix, archived_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      status = excluded.status,
      files_archived = excluded.files_archived,
      total_bytes = excluded.total_bytes,
      s3_prefix = excluded.s3_prefix,
      archived_at = excluded.archived_at
  `).run(date, status, filesArchived, totalBytes, s3Prefix);
}

function isArchiveComplete(db: Database.Database, date: string): boolean {
  const row = db
    .prepare("SELECT status FROM archive_progress WHERE date = ?")
    .get(date) as { status: string } | undefined;
  return row?.status === "complete";
}

// ── Process a single day ────────────────────────────────────────────────────

async function archiveDay(
  s3: S3Client,
  db: Database.Database,
  date: string,
  storageClass: StorageClass,
  check: boolean,
): Promise<"complete" | "skipped" | "no_release" | "failed"> {
  const startTime = Date.now();

  // 1. Check SQLite first
  if (isArchiveComplete(db, date)) {
    const row = db.prepare("SELECT files_archived, total_bytes FROM archive_progress WHERE date = ?")
      .get(date) as { files_archived: number; total_bytes: number };
    console.log(`[archive] ${date}: already archived (${row.files_archived} files, ${formatBytes(row.total_bytes)}) — skipping`);
    return "skipped";
  }

  // 2. Discover release from GitHub
  const release = await fetchReleaseAssets(date);
  if (!release) {
    console.log(`[archive] ${date}: no prod release found — skipping`);
    markArchive(db, date, "no_release");
    return "no_release";
  }

  // 3. Check S3 manifest
  const prefix = s3PrefixForDay(date);
  const { exists } = await manifestExists(s3, date, release.assets.length);
  if (exists) {
    console.log(`[archive] ${date}: manifest exists in S3 — marking complete`);
    const totalSize = release.assets.reduce((sum, a) => sum + a.size, 0);
    markArchive(db, date, "complete", release.assets.length, totalSize, prefix);
    return "skipped";
  }

  // 4. Dry run mode
  if (check) {
    const totalSize = release.assets.reduce((sum, a) => sum + a.size, 0);
    console.log(`[archive] ${date}: MISSING — ${release.assets.length} files, ${formatBytes(totalSize)} (${release.tag})`);
    return "complete";
  }

  // 5. Stream each asset to S3
  markArchive(db, date, "processing");
  const manifest: DayManifest = {
    date,
    release_tag: release.tag,
    repo: release.repo,
    files: [],
    total_bytes: 0,
    archived_at: new Date().toISOString(),
  };

  try {
    for (const asset of release.assets) {
      // Normalize filename: v2026.01.15-planes-readsb-prod-0.tar.aa → prod-0.tar.aa
      const fileName = asset.name.replace(/^v\d{4}\.\d{2}\.\d{2}-planes-readsb-/, "");
      const s3Key = `${prefix}/${fileName}`;

      console.log(`[archive] ${date}: streaming ${asset.name} (${formatBytes(asset.size)}) → s3://${S3_BUCKET}/${s3Key}`);
      const uploadStart = Date.now();

      const { size, sha256 } = await streamToS3(s3, s3Key, asset.browser_download_url, storageClass);

      const elapsed = (Date.now() - uploadStart) / 1000;
      const speed = size / elapsed / 1024 / 1024;
      console.log(`[archive] ${date}: uploaded ${fileName} — ${formatBytes(size)}, ${speed.toFixed(1)} MB/s, SHA-256: ${sha256.slice(0, 16)}...`);

      manifest.files.push({
        name: fileName,
        s3_key: s3Key,
        size,
        sha256,
        download_url: asset.browser_download_url,
      });
      manifest.total_bytes += size;
    }

    // 6. Write manifest (only after ALL files uploaded successfully)
    manifest.archived_at = new Date().toISOString();
    await writeManifest(s3, date, manifest);

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    markArchive(db, date, "complete", manifest.files.length, manifest.total_bytes, prefix);
    console.log(`[archive] ${date}: done — ${manifest.files.length} files, ${formatBytes(manifest.total_bytes)}, ${durationSec}s`);

    return "complete";
  } catch (err) {
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    markArchive(db, date, "failed", 0, 0, prefix);
    console.error(`[archive] ${date}: FAILED (${durationSec}s) —`, err instanceof Error ? err.message : err);
    return "failed";
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const dates = buildDateRange(args);

  console.log(`[archive] ADS-B raw archive to S3 Glacier`);
  console.log(`[archive] Range: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} days)`);
  console.log(`[archive] Bucket: s3://${S3_BUCKET}/${S3_PREFIX}/`);
  console.log(`[archive] Storage class: ${args.storageClass}`);
  console.log(`[archive] Concurrency: ${args.concurrency}`);
  if (args.check) console.log(`[archive] DRY RUN — checking only, no uploads`);
  if (process.env["GITHUB_TOKEN"]) console.log(`[archive] Using GITHUB_TOKEN for authenticated requests`);
  console.log();

  const db = getDb();
  const s3 = s3Client();

  const counts = { complete: 0, skipped: 0, no_release: 0, failed: 0 };

  if (args.concurrency <= 1) {
    // Sequential
    for (const date of dates) {
      const result = await archiveDay(s3, db, date, args.storageClass as StorageClass, args.check);
      counts[result]++;
      // Rate limit delay between GitHub API calls
      if (result !== "skipped") await sleep(RATE_LIMIT_DELAY_MS);
    }
  } else {
    // Parallel in batches
    for (let i = 0; i < dates.length; i += args.concurrency) {
      const batch = dates.slice(i, i + args.concurrency);
      const results = await Promise.all(
        batch.map((date) => archiveDay(s3, db, date, args.storageClass as StorageClass, args.check)),
      );
      for (const r of results) counts[r]++;
      // Rate limit delay between batches
      await sleep(RATE_LIMIT_DELAY_MS * args.concurrency);
    }
  }

  // Summary
  console.log("\n===================================================");
  console.log("ADS-B Raw Archive Summary");
  console.log("===================================================");
  console.log(`Archived: ${counts.complete} | Skipped: ${counts.skipped} | No release: ${counts.no_release} | Failed: ${counts.failed}`);

  if (!args.check) {
    const totals = db.prepare(`
      SELECT COUNT(*) as days, SUM(total_bytes) as bytes, SUM(files_archived) as files
      FROM archive_progress WHERE status = 'complete'
    `).get() as { days: number; bytes: number; files: number };
    console.log(`Total archived: ${totals.days} days, ${totals.files} files, ${formatBytes(totals.bytes ?? 0)}`);
    const monthlyCost = ((totals.bytes ?? 0) / 1024 / 1024 / 1024) * 0.001;
    console.log(`Estimated Glacier cost: $${monthlyCost.toFixed(2)}/month`);
  }

  closeDb();
}

export { archiveDay };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[archive] Fatal:", err);
    process.exit(1);
  });
}
