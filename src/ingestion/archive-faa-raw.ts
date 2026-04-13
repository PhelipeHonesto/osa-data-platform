/**
 * FAA Raw Archive → S3
 *
 * Archives raw FAA data zips to S3 before the pipeline processes them.
 * Registry zip changes nightly — if we don't archive, yesterday is gone forever.
 *
 *   s3://osa-dumont-backup/raw/faa/registry/YYYY-MM-DD.zip   (GLACIER)
 *   s3://osa-dumont-backup/raw/faa/airmen/YYYY-MM.zip        (STANDARD)
 *   manifest.json alongside each zip
 *
 * Usage:
 *   npm run archive:faa                         # today's date
 *   npm run archive:faa -- --date 2026-04-13
 *   npm run archive:faa -- --skip-airmen
 *
 * Nightly cron order:
 *   1 AM: archive:faa  (preserve raw zip)
 *   2 AM: S3 database backup
 *   3 AM: pipeline      (diff + classify + graph + safety)
 */

import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { S3Client, HeadObjectCommand, PutObjectCommand, type StorageClass } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

// ── Constants ───────────────────────────────────────────────────────────────

const S3_BUCKET = "osa-dumont-backup";
const FAA_REGISTRY_URL = "https://registry.faa.gov/database/ReleasableAircraft.zip";
const FAA_AIRMEN_URL = "https://registry.faa.gov/database/ardata.zip";
const USER_AGENT = "Mozilla/5.0 (compatible; OSA-Dumont/1.0)";

// ── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  date: string;
  skipAirmen: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let date = new Date().toISOString().slice(0, 10);
  let skipAirmen = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) { date = args[i + 1]!; i++; }
    else if (args[i] === "--skip-airmen") skipAirmen = true;
  }

  return { date, skipAirmen };
}

// ── S3 helpers ──────────────────────────────────────────────────────────────

function s3Client(): S3Client {
  return new S3Client({});
}

async function s3ManifestExists(s3: S3Client, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === "NotFound" || code === "NoSuchKey") return false;
    throw err;
  }
}

interface UploadResult {
  size: number;
  sha256: string;
}

async function streamUrlToS3(
  s3: S3Client,
  s3Key: string,
  sourceUrl: string,
  storageClass: StorageClass,
): Promise<UploadResult> {
  const resp = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(300_000),
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`Download failed: ${sourceUrl} → HTTP ${resp.status} ${resp.statusText}`);
  }

  const hash = createHash("sha256");
  let totalBytes = 0;

  const nodeStream = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream);
  const passthrough = new PassThrough();

  nodeStream.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    totalBytes += chunk.length;
  });

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: passthrough,
      StorageClass: storageClass,
    },
    queueSize: 4,
    partSize: 50 * 1024 * 1024, // 50MB parts (registry zip is ~70MB)
  });

  const pipePromise = pipeline(nodeStream, passthrough);
  const uploadPromise = upload.done();
  await Promise.all([pipePromise, uploadPromise]);

  return { size: totalBytes, sha256: hash.digest("hex") };
}

async function writeManifest(
  s3: S3Client,
  manifestKey: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: manifestKey,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
    StorageClass: "STANDARD",
  }));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

// ── Archive registry ────────────────────────────────────────────────────────

async function archiveRegistry(s3: S3Client, date: string): Promise<boolean> {
  const prefix = `raw/faa/registry`;
  const zipKey = `${prefix}/${date}.zip`;
  const manifestKey = `${prefix}/${date}-manifest.json`;

  // Check if already archived
  if (await s3ManifestExists(s3, manifestKey)) {
    console.log(`[archive-faa] Registry ${date}: already archived — skipping`);
    return true;
  }

  console.log(`[archive-faa] Registry ${date}: streaming ${FAA_REGISTRY_URL} → s3://${S3_BUCKET}/${zipKey}`);
  const t0 = Date.now();

  try {
    const result = await streamUrlToS3(s3, zipKey, FAA_REGISTRY_URL, "GLACIER" as StorageClass);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const speed = (result.size / ((Date.now() - t0) / 1000) / 1024 / 1024).toFixed(1);

    console.log(`[archive-faa] Registry ${date}: uploaded ${formatBytes(result.size)} in ${elapsed}s (${speed} MB/s)`);
    console.log(`[archive-faa] SHA-256: ${result.sha256.slice(0, 16)}...`);

    // Write manifest
    await writeManifest(s3, manifestKey, {
      type: "faa_registry",
      date,
      source_url: FAA_REGISTRY_URL,
      s3_key: zipKey,
      size: result.size,
      sha256: result.sha256,
      storage_class: "GLACIER",
      archived_at: new Date().toISOString(),
    });

    return true;
  } catch (err) {
    console.error(`[archive-faa] Registry ${date}: FAILED —`, err instanceof Error ? err.message : err);
    return false;
  }
}

// ── Archive airmen ──────────────────────────────────────────────────────────

async function archiveAirmen(s3: S3Client, date: string): Promise<boolean> {
  const month = date.slice(0, 7); // YYYY-MM
  const prefix = `raw/faa/airmen`;
  const zipKey = `${prefix}/${month}.zip`;
  const manifestKey = `${prefix}/${month}-manifest.json`;

  // Check if this month already archived
  if (await s3ManifestExists(s3, manifestKey)) {
    console.log(`[archive-faa] Airmen ${month}: already archived this month — skipping`);
    return true;
  }

  console.log(`[archive-faa] Airmen ${month}: streaming ${FAA_AIRMEN_URL} → s3://${S3_BUCKET}/${zipKey}`);
  const t0 = Date.now();

  try {
    const result = await streamUrlToS3(s3, zipKey, FAA_AIRMEN_URL, "STANDARD" as StorageClass);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const speed = (result.size / ((Date.now() - t0) / 1000) / 1024 / 1024).toFixed(1);

    console.log(`[archive-faa] Airmen ${month}: uploaded ${formatBytes(result.size)} in ${elapsed}s (${speed} MB/s)`);

    await writeManifest(s3, manifestKey, {
      type: "faa_airmen",
      month,
      source_url: FAA_AIRMEN_URL,
      s3_key: zipKey,
      size: result.size,
      sha256: result.sha256,
      storage_class: "STANDARD",
      archived_at: new Date().toISOString(),
    });

    return true;
  } catch (err) {
    console.error(`[archive-faa] Airmen ${month}: FAILED —`, err instanceof Error ? err.message : err);
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const s3 = s3Client();

  console.log(`[archive-faa] FAA raw archive to S3`);
  console.log(`[archive-faa] Date: ${args.date}`);
  console.log(`[archive-faa] Bucket: s3://${S3_BUCKET}/raw/faa/`);
  console.log();

  const registryOk = await archiveRegistry(s3, args.date);

  let airmenOk = true;
  if (!args.skipAirmen) {
    airmenOk = await archiveAirmen(s3, args.date);
  } else {
    console.log(`[archive-faa] Airmen: skipped (--skip-airmen)`);
  }

  console.log();
  console.log(`[archive-faa] Done — registry: ${registryOk ? "ok" : "FAILED"}, airmen: ${airmenOk ? "ok" : "FAILED"}`);

  if (!registryOk || !airmenOk) process.exit(1);
}

main().catch((err) => {
  console.error("[archive-faa] Fatal:", err);
  process.exit(1);
});
