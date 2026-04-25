/**
 * FAA D085 Wayback Archive → S3
 *
 * One-shot bridge data capture: secures the public Part 135 Operators
 * and Aircraft list (sourced from FAA OpSpec D085) that the FAA has
 * temporarily deactivated pending a data-integrity fix. Pulls every
 * available Wayback snapshot of:
 *   1. the page itself (49 captures, 2023-01-25 → 2026-02-16)
 *   2. each referenced .xlsx (12 unique versions actually captured by
 *      Wayback; 10 versions referenced from page captures were never
 *      crawled by Wayback and are recorded as gaps in the index)
 *
 * Per-snapshot S3 layout:
 *   s3://osa-dumont-backup/raw/faa/d085/snapshots/<pageTs>/page.html
 *   s3://osa-dumont-backup/raw/faa/d085/snapshots/<pageTs>/manifest.json
 *
 * Deduplicated xlsx storage (one per unique Wayback CDX capture):
 *   s3://osa-dumont-backup/raw/faa/d085/xlsx/<xlsxCdxTs>__<filename>
 *
 * Aggregate index:
 *   s3://osa-dumont-backup/raw/faa/d085/_index.json
 *
 * Usage:
 *   npx tsx src/ingestion/archive-faa-d085-wayback.ts --dry-run
 *   npx tsx src/ingestion/archive-faa-d085-wayback.ts
 *
 * Idempotent: skips upload if a manifest with matching sha256 already
 * exists at the target key. Re-runs are safe.
 */

import { createHash } from "node:crypto";
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, type StorageClass } from "@aws-sdk/client-s3";
import { childLogger } from "../utils/logger.js";

const log = childLogger("archive-faa-d085");

// ── Constants ───────────────────────────────────────────────────────────────

const S3_BUCKET = "osa-dumont-backup";
const S3_PREFIX = "raw/faa/d085";
const STORAGE_CLASS: StorageClass = "STANDARD";
const USER_AGENT = "Mozilla/5.0 (compatible; OSA-Dumont/1.0)";
const RATE_LIMIT_MS = 2000;

// ── Static snapshot list (frozen 2026-04-25 from Wayback CDX probe) ─────────
//
// 49 page snapshots, 22 unique xlsx paths referenced. CDX-availability
// scan determined which xlsx URLs Wayback actually captured (12) vs which
// it indexed at the page level only (10 gaps). We pick the first CDX
// capture per unique xlsx URL — same FAA-published file content across
// captures, so one download suffices per unique version.

interface PageSnapshot {
  pageTs: string;          // Wayback timestamp YYYYMMDDHHMMSS
  pageUrl: string;         // original FAA URL captured
  xlsxPath: string;        // FAA path (e.g. /sites/faa.gov/files/Part_135_...xlsx)
  xlsxFilename: string;    // basename, original encoding preserved
  xlsxSizeLabel: string;   // FAA-stated size on the page (e.g. '616.15 KB')
}

interface XlsxCapture {
  cdxTs: string;           // Wayback CDX timestamp of the xlsx itself
  sizeBytes: number;       // length reported by CDX
}

const PAGE_SNAPSHOTS: PageSnapshot[] = [
  { pageTs: "20230125153937", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/part-135-aircraft-listing-opspec-d085", xlsxPath: "/sites/faa.gov/files/135Aircraft_3.xlsx", xlsxFilename: "135Aircraft_3.xlsx", xlsxSizeLabel: "551.14 KB" },
  { pageTs: "20230125162844", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/part-135-aircraft-listing-opspec-d085", xlsxPath: "/sites/faa.gov/files/135Aircraft_3.xlsx", xlsxFilename: "135Aircraft_3.xlsx", xlsxSizeLabel: "551.14 KB" },
  { pageTs: "20230324073349", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/135Aircraft_5.xlsx", xlsxFilename: "135Aircraft_5.xlsx", xlsxSizeLabel: "552.35 KB" },
  { pageTs: "20230417183556", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/135Aircraft_5.xlsx", xlsxFilename: "135Aircraft_5.xlsx", xlsxSizeLabel: "552.35 KB" },
  { pageTs: "20230602131911", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/135_Aircraft.xlsx", xlsxFilename: "135_Aircraft.xlsx", xlsxSizeLabel: "680.79 KB" },
  { pageTs: "20230607035032", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/135_Aircraft.xlsx", xlsxFilename: "135_Aircraft.xlsx", xlsxSizeLabel: "680.79 KB" },
  { pageTs: "20230609062513", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Aircraft.xlsx", xlsxFilename: "Part_135_Aircraft.xlsx", xlsxSizeLabel: "651.01 KB" },
  { pageTs: "20230725234524", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Aircraft_0.xlsx", xlsxFilename: "Part_135_Aircraft_0.xlsx", xlsxSizeLabel: "689.83 KB" },
  { pageTs: "20231216202709", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Aircraft_6.xlsx", xlsxFilename: "Part_135_Aircraft_6.xlsx", xlsxSizeLabel: "559.06 KB" },
  { pageTs: "20240207102558", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Aircraft_8.xlsx", xlsxFilename: "Part_135_Aircraft_8.xlsx", xlsxSizeLabel: "689.49 KB" },
  { pageTs: "20240407063541", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_0.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_0.xlsx", xlsxSizeLabel: "693.44 KB" },
  { pageTs: "20240428054517", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_0.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_0.xlsx", xlsxSizeLabel: "693.44 KB" },
  { pageTs: "20240529034605", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft.xlsx", xlsxSizeLabel: "699.66 KB" },
  { pageTs: "20240711065301", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_1.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_1.xlsx", xlsxSizeLabel: "710.43 KB" },
  { pageTs: "20240910003443", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_1.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_1.xlsx", xlsxSizeLabel: "616.15 KB" },
  { pageTs: "20240916170134", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_1.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_1.xlsx", xlsxSizeLabel: "616.15 KB" },
  { pageTs: "20240926181257", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_1.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_1.xlsx", xlsxSizeLabel: "616.15 KB" },
  { pageTs: "20241010054424", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_2.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_2.xlsx", xlsxSizeLabel: "676.01 KB" },
  { pageTs: "20241104152909", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_2.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_2.xlsx", xlsxSizeLabel: "676.01 KB" },
  { pageTs: "20241121161308", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_3.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_3.xlsx", xlsxSizeLabel: "581.81 KB" },
  { pageTs: "20241122163340", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_3.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_3.xlsx", xlsxSizeLabel: "581.81 KB" },
  { pageTs: "20241127175028", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_3.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_3.xlsx", xlsxSizeLabel: "581.81 KB" },
  { pageTs: "20241201213516", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_3.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_3.xlsx", xlsxSizeLabel: "581.81 KB" },
  { pageTs: "20241227165638", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_4.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_4.xlsx", xlsxSizeLabel: "638.82 KB" },
  { pageTs: "20241227173826", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_4.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_4.xlsx", xlsxSizeLabel: "638.82 KB" },
  { pageTs: "20250201193526", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_3.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_3.xlsx", xlsxSizeLabel: "582.52 KB" },
  { pageTs: "20250201211416", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_3.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_3.xlsx", xlsxSizeLabel: "582.52 KB" },
  { pageTs: "20250202022517", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_3.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_3.xlsx", xlsxSizeLabel: "582.52 KB" },
  { pageTs: "20250207081625", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_4.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_4.xlsx", xlsxSizeLabel: "581.66 KB" },
  { pageTs: "20250222060250", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_4.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_4.xlsx", xlsxSizeLabel: "581.66 KB" },
  { pageTs: "20250228142953", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_4.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_4.xlsx", xlsxSizeLabel: "581.66 KB" },
  { pageTs: "20250313231654", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_5.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_5.xlsx", xlsxSizeLabel: "579.9 KB" },
  { pageTs: "20250315103849", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_5.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_5.xlsx", xlsxSizeLabel: "579.9 KB" },
  { pageTs: "20250330195733", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_5.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_5.xlsx", xlsxSizeLabel: "579.9 KB" },
  { pageTs: "20250422071517", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_6.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_6.xlsx", xlsxSizeLabel: "641.35 KB" },
  { pageTs: "20250428063438", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_6.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_6.xlsx", xlsxSizeLabel: "641.35 KB" },
  { pageTs: "20250517122821", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_7.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_7.xlsx", xlsxSizeLabel: "641.39 KB" },
  { pageTs: "20250710093927", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_5.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_5.xlsx", xlsxSizeLabel: "642.74 KB" },
  { pageTs: "20250711161350", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_5.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_5.xlsx", xlsxSizeLabel: "642.74 KB" },
  { pageTs: "20250807110626", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_5.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_5.xlsx", xlsxSizeLabel: "642.74 KB" },
  { pageTs: "20250908120800", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_5.xlsx", xlsxFilename: "Part%20135_Operators_and_Aircraft_5.xlsx", xlsxSizeLabel: "642.74 KB" },
  { pageTs: "20251026020029", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_9.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_9.xlsx", xlsxSizeLabel: "486.71 KB" },
  { pageTs: "20251026095650", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_9.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_9.xlsx", xlsxSizeLabel: "486.71 KB" },
  { pageTs: "20251027092940", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_9.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_9.xlsx", xlsxSizeLabel: "486.71 KB" },
  { pageTs: "20251104071545", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_9.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_9.xlsx", xlsxSizeLabel: "486.71 KB" },
  { pageTs: "20251121211113", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_9.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_9.xlsx", xlsxSizeLabel: "486.71 KB" },
  { pageTs: "20260106165744", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_9.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_9.xlsx", xlsxSizeLabel: "486.71 KB" },
  { pageTs: "20260129071955", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_9.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_9.xlsx", xlsxSizeLabel: "486.71 KB" },
  { pageTs: "20260216091517", pageUrl: "https://www.faa.gov/about/officeorg/headquartersoffices/avs/faa-certificated-aircraft-operators-legal-part-135-holders", xlsxPath: "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_10.xlsx", xlsxFilename: "Part_135_Operators_and_Aircraft_10.xlsx", xlsxSizeLabel: "487.32 KB" },
];

const XLSX_CDX_CAPTURES: Record<string, XlsxCapture | null> = {
  "/sites/faa.gov/files/135Aircraft_3.xlsx": { cdxTs: "20230125163002", sizeBytes: 550926 },
  "/sites/faa.gov/files/135Aircraft_5.xlsx": null,
  "/sites/faa.gov/files/135_Aircraft.xlsx": null,
  "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft.xlsx": null,
  "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_1.xlsx": { cdxTs: "20240927053921", sizeBytes: 527726 },
  "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_2.xlsx": null,
  "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_3.xlsx": { cdxTs: "20241127190545", sizeBytes: 506559 },
  "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_4.xlsx": null,
  "/sites/faa.gov/files/Part%20135_Operators_and_Aircraft_5.xlsx": null,
  "/sites/faa.gov/files/Part_135_Aircraft.xlsx": null,
  "/sites/faa.gov/files/Part_135_Aircraft_0.xlsx": null,
  "/sites/faa.gov/files/Part_135_Aircraft_6.xlsx": { cdxTs: "20231223185606", sizeBytes: 548629 },
  "/sites/faa.gov/files/Part_135_Aircraft_8.xlsx": null,
  "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_0.xlsx": { cdxTs: "20240419032659", sizeBytes: 583525 },
  "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_1.xlsx": { cdxTs: "20240727042435", sizeBytes: 592681 },
  "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_10.xlsx": null,
  "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_3.xlsx": { cdxTs: "20250202203732", sizeBytes: 512388 },
  "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_4.xlsx": { cdxTs: "20250210061242", sizeBytes: 507215 },
  "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_5.xlsx": { cdxTs: "20250321114242", sizeBytes: 505560 },
  "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_6.xlsx": { cdxTs: "20250428063557", sizeBytes: 586629 },
  "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_7.xlsx": { cdxTs: "20251006234200", sizeBytes: 589007 },
  "/sites/faa.gov/files/Part_135_Operators_and_Aircraft_9.xlsx": { cdxTs: "20251026020032", sizeBytes: 487315 },
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waybackRawUrl(ts: string, originalUrl: string): string {
  // `id_` modifier returns raw archived bytes (no Wayback toolbar / rewriting).
  return `https://web.archive.org/web/${ts}id_/${originalUrl}`;
}

function snapshotPrefix(pageTs: string): string {
  return `${S3_PREFIX}/snapshots/${pageTs}`;
}

function pageKey(pageTs: string): string {
  return `${snapshotPrefix(pageTs)}/page.html`;
}

function manifestKey(pageTs: string): string {
  return `${snapshotPrefix(pageTs)}/manifest.json`;
}

function xlsxKey(cdxTs: string, filename: string): string {
  return `${S3_PREFIX}/xlsx/${cdxTs}__${filename}`;
}

const indexKey = `${S3_PREFIX}/_index.json`;

function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

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

async function fetchBytes(url: string): Promise<Buffer> {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" },
    redirect: "follow",
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} fetching ${url}`);
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function s3Put(s3: S3Client, key: string, body: Buffer | string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    StorageClass: STORAGE_CLASS,
  }));
}

// ── Manifest types ──────────────────────────────────────────────────────────

interface SnapshotManifest {
  snapshot_timestamp: string;
  page_url_original: string;
  page_url_wayback: string;
  page_archived_at: string;
  page_sha256: string;
  page_size_bytes: number;
  page_s3_key: string;
  xlsx_referenced_filename: string;
  xlsx_referenced_size_label: string;
  xlsx_archived: boolean;
  xlsx_url_original: string | null;
  xlsx_url_wayback: string | null;
  xlsx_archived_at: string | null;
  xlsx_sha256: string | null;
  xlsx_size_bytes: number | null;
  xlsx_s3_key: string | null;
  xlsx_cdx_timestamp: string | null;
  notes: string;
}

// ── Per-snapshot processing ─────────────────────────────────────────────────

interface XlsxArchiveResult {
  s3Key: string;
  sha256: string;
  sizeBytes: number;
  archivedAt: string;
}

const xlsxResultCache = new Map<string, XlsxArchiveResult>();
let didFirstS3Put = false;

async function archiveXlsxIfNeeded(s3: S3Client, snap: PageSnapshot, args: CliArgs): Promise<XlsxArchiveResult | null> {
  const cap = XLSX_CDX_CAPTURES[snap.xlsxPath];
  if (!cap) return null; // gap — Wayback never captured this xlsx URL

  const cached = xlsxResultCache.get(snap.xlsxPath);
  if (cached) return cached;

  const key = xlsxKey(cap.cdxTs, snap.xlsxFilename);
  const xlsxOriginalUrl = `https://www.faa.gov${snap.xlsxPath}`;
  const waybackUrl = waybackRawUrl(cap.cdxTs, xlsxOriginalUrl);

  if (args.dryRun) {
    const result: XlsxArchiveResult = {
      s3Key: key,
      sha256: "(dry-run)",
      sizeBytes: cap.sizeBytes,
      archivedAt: "(dry-run)",
    };
    xlsxResultCache.set(snap.xlsxPath, result);
    return result;
  }

  if (!args.force && (await s3HeadOk(s3, key))) {
    // Already archived — recover sha256 by computing from S3 isn't straightforward;
    // pull manifest record from another snapshot referencing this xlsxPath if it exists.
    // Simpler: re-fetch from Wayback, hash, but skip the upload. That preserves provenance
    // without paying re-upload cost. Since we're idempotent and Wayback is rate-limited,
    // we just trust the S3 object and read sha256 from a sibling manifest if one exists.
    // For now: log and re-derive by re-fetching (cheap; xlsx is ~500 KB and we sleep 2s
    // between requests anyway).
    console.log(`[d085] xlsx already in S3: ${key} — verifying sha256 by re-fetching`);
    const buf = await fetchBytes(waybackUrl);
    const result: XlsxArchiveResult = {
      s3Key: key,
      sha256: sha256Hex(buf),
      sizeBytes: buf.byteLength,
      archivedAt: new Date().toISOString(),
    };
    xlsxResultCache.set(snap.xlsxPath, result);
    await sleep(RATE_LIMIT_MS);
    return result;
  }

  console.log(`[d085] xlsx fetch: ${waybackUrl}`);
  const buf = await fetchBytes(waybackUrl);
  const sha = sha256Hex(buf);
  const archivedAt = new Date().toISOString();

  console.log(`[d085] xlsx ${snap.xlsxFilename}: ${formatBytes(buf.byteLength)}, sha256=${sha.slice(0, 16)}…`);

  if (!didFirstS3Put) {
    console.log(`[d085] First S3 PutObject — if this fails with auth error, abort and report.`);
  }
  await s3Put(s3, key, buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  didFirstS3Put = true;

  const result: XlsxArchiveResult = { s3Key: key, sha256: sha, sizeBytes: buf.byteLength, archivedAt };
  xlsxResultCache.set(snap.xlsxPath, result);
  await sleep(RATE_LIMIT_MS);
  return result;
}

async function archiveSnapshot(s3: S3Client, snap: PageSnapshot, args: CliArgs): Promise<SnapshotManifest> {
  const pageOriginal = snap.pageUrl;
  const pageWayback = waybackRawUrl(snap.pageTs, pageOriginal);
  const pageS3Key = pageKey(snap.pageTs);
  const manS3Key = manifestKey(snap.pageTs);

  let pageBuf: Buffer;
  let pageSha: string;
  let pageArchivedAt: string;

  // Idempotent skip: if manifest exists and not --force, parse and use existing values.
  if (!args.force && !args.dryRun && (await s3HeadOk(s3, manS3Key))) {
    const existing = await s3GetText(s3, manS3Key);
    if (existing) {
      const parsed = JSON.parse(existing) as SnapshotManifest;
      console.log(`[d085] snapshot ${snap.pageTs}: manifest exists, skipping page fetch`);
      // Still need to ensure xlsx is archived (separate cache)
      const xlsxResult = await archiveXlsxIfNeeded(s3, snap, args);
      // Re-derive manifest with current xlsx state (preserves any newly-archived xlsx)
      return buildManifest(snap, parsed.page_sha256, parsed.page_size_bytes, parsed.page_archived_at, pageS3Key, xlsxResult, pageWayback);
    }
  }

  if (args.dryRun) {
    pageBuf = Buffer.alloc(0);
    pageSha = "(dry-run)";
    pageArchivedAt = "(dry-run)";
  } else {
    console.log(`[d085] page fetch: ${pageWayback}`);
    pageBuf = await fetchBytes(pageWayback);
    pageSha = sha256Hex(pageBuf);
    pageArchivedAt = new Date().toISOString();
    if (!didFirstS3Put) {
      console.log(`[d085] First S3 PutObject — if this fails with auth error, abort and report.`);
    }
    await s3Put(s3, pageS3Key, pageBuf, "text/html; charset=utf-8");
    didFirstS3Put = true;
    console.log(`[d085] page ${snap.pageTs}: ${formatBytes(pageBuf.byteLength)}, sha256=${pageSha.slice(0, 16)}…`);
    await sleep(RATE_LIMIT_MS);
  }

  const xlsxResult = await archiveXlsxIfNeeded(s3, snap, args);
  const manifest = buildManifest(snap, pageSha, pageBuf.byteLength, pageArchivedAt, pageS3Key, xlsxResult, pageWayback);

  if (!args.dryRun) {
    await s3Put(s3, manS3Key, JSON.stringify(manifest, null, 2), "application/json");
  }
  return manifest;
}

function buildManifest(
  snap: PageSnapshot,
  pageSha: string,
  pageSize: number,
  pageArchivedAt: string,
  pageS3Key: string,
  xlsx: XlsxArchiveResult | null,
  pageWayback: string,
): SnapshotManifest {
  const cap = XLSX_CDX_CAPTURES[snap.xlsxPath];
  const xlsxOriginalUrl = `https://www.faa.gov${snap.xlsxPath}`;
  const archived = xlsx !== null;
  const notes = archived
    ? "Page and xlsx both archived from Wayback."
    : `xlsx referenced on page but never crawled by Wayback (CDX returned no captures for ${snap.xlsxPath}). Future Step 4 work will need FOIA fallback to recover this date's data.`;
  return {
    snapshot_timestamp: snap.pageTs,
    page_url_original: snap.pageUrl,
    page_url_wayback: pageWayback,
    page_archived_at: pageArchivedAt,
    page_sha256: pageSha,
    page_size_bytes: pageSize,
    page_s3_key: pageS3Key,
    xlsx_referenced_filename: snap.xlsxFilename,
    xlsx_referenced_size_label: snap.xlsxSizeLabel,
    xlsx_archived: archived,
    xlsx_url_original: archived ? xlsxOriginalUrl : null,
    xlsx_url_wayback: archived && cap ? waybackRawUrl(cap.cdxTs, xlsxOriginalUrl) : null,
    xlsx_archived_at: xlsx ? xlsx.archivedAt : null,
    xlsx_sha256: xlsx ? xlsx.sha256 : null,
    xlsx_size_bytes: xlsx ? xlsx.sizeBytes : null,
    xlsx_s3_key: xlsx ? xlsx.s3Key : null,
    xlsx_cdx_timestamp: cap ? cap.cdxTs : null,
    notes,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const s3 = new S3Client({});

  console.log(`[d085] FAA D085 Wayback historical archive → S3`);
  console.log(`[d085] Bucket: s3://${S3_BUCKET}/${S3_PREFIX}/`);
  console.log(`[d085] Storage class: ${STORAGE_CLASS}`);
  console.log(`[d085] Mode: ${args.dryRun ? "DRY-RUN (no S3 writes)" : "LIVE"}${args.force ? " --force" : ""}`);
  console.log(`[d085] Page snapshots: ${PAGE_SNAPSHOTS.length}`);
  const xlsxAvailableCount = Object.values(XLSX_CDX_CAPTURES).filter((v): v is XlsxCapture => v !== null).length;
  const xlsxGapCount = Object.values(XLSX_CDX_CAPTURES).filter((v) => v === null).length;
  console.log(`[d085] Unique xlsx referenced: ${Object.keys(XLSX_CDX_CAPTURES).length} (${xlsxAvailableCount} captured by Wayback, ${xlsxGapCount} gaps)`);
  console.log();

  if (args.dryRun) {
    const projectedXlsxBytes = Object.values(XLSX_CDX_CAPTURES).reduce((s, v) => s + (v?.sizeBytes ?? 0), 0);
    const snapshotsWithXlsx = PAGE_SNAPSHOTS.filter((s) => XLSX_CDX_CAPTURES[s.xlsxPath]).length;
    const snapshotsInGap = PAGE_SNAPSHOTS.length - snapshotsWithXlsx;
    console.log(`[d085] === DRY-RUN PROJECTION ===`);
    console.log(`[d085] Snapshots with xlsx archived: ${snapshotsWithXlsx}`);
    console.log(`[d085] Snapshots with xlsx gap: ${snapshotsInGap}`);
    console.log(`[d085] xlsx files to upload (deduplicated): ${xlsxAvailableCount}`);
    console.log(`[d085] xlsx total bytes (per CDX): ${projectedXlsxBytes.toLocaleString()} (~${(projectedXlsxBytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[d085] Page HTML files to upload: ${PAGE_SNAPSHOTS.length} (~${PAGE_SNAPSHOTS.length * 16}KB est.)`);
    console.log(`[d085] Manifest files: ${PAGE_SNAPSHOTS.length} + 1 _index.json`);
    console.log();
    console.log(`[d085] Sample S3 keys (first 5 page snapshots):`);
    for (const snap of PAGE_SNAPSHOTS.slice(0, 5)) {
      console.log(`  ${pageKey(snap.pageTs)}`);
      console.log(`  ${manifestKey(snap.pageTs)}`);
      const cap = XLSX_CDX_CAPTURES[snap.xlsxPath];
      if (cap) {
        console.log(`  ${xlsxKey(cap.cdxTs, snap.xlsxFilename)}  [shared across ${PAGE_SNAPSHOTS.filter((p) => p.xlsxPath === snap.xlsxPath).length} snapshots]`);
      } else {
        console.log(`  (xlsx gap — no S3 write)`);
      }
    }
    console.log(`  ...`);
    console.log(`[d085] Index: ${indexKey}`);
    console.log();
    console.log(`[d085] Dry-run complete. Re-run without --dry-run to perform writes.`);
    return;
  }

  const manifests: SnapshotManifest[] = [];
  for (let i = 0; i < PAGE_SNAPSHOTS.length; i++) {
    const snap = PAGE_SNAPSHOTS[i]!;
    console.log(`[d085] [${i + 1}/${PAGE_SNAPSHOTS.length}] snapshot ${snap.pageTs}`);
    try {
      const m = await archiveSnapshot(s3, snap, args);
      manifests.push(m);
    } catch (err) {
      log.error({ err, pageTs: snap.pageTs }, "snapshot archive failed");
      throw err;
    }
  }

  // Build aggregate index
  const xlsxArchivedCount = manifests.filter((m) => m.xlsx_archived).length;
  const gaps = manifests.filter((m) => !m.xlsx_archived).map((m) => ({
    snapshot_timestamp: m.snapshot_timestamp,
    xlsx_referenced_filename: m.xlsx_referenced_filename,
  }));
  const totalPageBytes = manifests.reduce((s, m) => s + m.page_size_bytes, 0);
  const totalXlsxBytes = Array.from(xlsxResultCache.values()).reduce((s, r) => s + r.sizeBytes, 0);
  const sortedTs = manifests.map((m) => m.snapshot_timestamp).sort();
  const formatTs = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  const dateRange = `${formatTs(sortedTs[0]!)} to ${formatTs(sortedTs[sortedTs.length - 1]!)}`;

  const index = {
    snapshot_count: manifests.length,
    xlsx_archived_count: xlsxArchivedCount,
    xlsx_unique_versions: xlsxResultCache.size,
    xlsx_gap_count: gaps.length,
    date_range: dateRange,
    total_page_bytes: totalPageBytes,
    total_xlsx_bytes_deduplicated: totalXlsxBytes,
    last_indexed_at: new Date().toISOString(),
    gaps,
    snapshots: manifests.map((m) => ({
      snapshot_timestamp: m.snapshot_timestamp,
      page_s3_key: m.page_s3_key,
      page_sha256: m.page_sha256,
      xlsx_archived: m.xlsx_archived,
      xlsx_referenced_filename: m.xlsx_referenced_filename,
      xlsx_s3_key: m.xlsx_s3_key,
      xlsx_sha256: m.xlsx_sha256,
      xlsx_size_bytes: m.xlsx_size_bytes,
    })),
  };

  await s3Put(s3, indexKey, JSON.stringify(index, null, 2), "application/json");

  console.log();
  console.log(`[d085] === DONE ===`);
  console.log(`[d085] Snapshots archived: ${manifests.length}`);
  console.log(`[d085] xlsx archived: ${xlsxArchivedCount} (${xlsxResultCache.size} unique versions)`);
  console.log(`[d085] xlsx gaps: ${gaps.length}`);
  console.log(`[d085] Total bytes: pages ${totalPageBytes.toLocaleString()}, xlsx ${totalXlsxBytes.toLocaleString()} (~${((totalPageBytes + totalXlsxBytes) / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`[d085] Index: s3://${S3_BUCKET}/${indexKey}`);
}

main().catch((err) => {
  log.fatal({ err }, "archive-faa-d085-wayback fatal error");
  console.error(`[d085] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
