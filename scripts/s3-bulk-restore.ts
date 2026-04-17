/**
 * Bulk-restore all Glacier tars under s3://osa-dumont-backup/raw/adsb/**
 * so they're readable for the Phase 7 adsb_completed_legs rebuild.
 *
 * Scope: only raw/adsb/ — does NOT touch raw/adsb-osa/ (our own packaged tars).
 *
 * Usage:
 *   npx tsx scripts/s3-bulk-restore.ts --dry-run
 *   npx tsx scripts/s3-bulk-restore.ts --execute
 *   npx tsx scripts/s3-bulk-restore.ts --check
 *
 * Tier: Bulk (cheapest, 5-12 hr). Retention: 7 days in restored standard copy.
 *
 * State persisted to scripts/s3-restore-state.json for resume + status tracking.
 */
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  RestoreObjectCommand,
} from "@aws-sdk/client-s3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const S3_BUCKET = "osa-dumont-backup";
const S3_PREFIX = "raw/adsb/"; // trailing slash: excludes raw/adsb-osa/
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), "s3-restore-state.json");

const RETENTION_DAYS = 7;
const TIER = "Bulk" as const;

const HEAD_CONCURRENCY = 40;
const RESTORE_CONCURRENCY = 50; // keeps us well under AWS's 1000/sec cap
const STATE_FLUSH_EVERY = 100;

const PRICE_BULK_PER_GB = 0.0025; // S3 Glacier Flexible Retrieval — Bulk tier
const PRICE_STANDARD_PER_GB_MONTH = 0.023;
const COST_WARN_THRESHOLD_USD = 20;
const ABORT_WINDOW_SEC = 10;

type Category =
  | "already_standard"
  | "glacier_restored"
  | "glacier_restore_pending"
  | "glacier_cold";

interface ObjectState {
  size_bytes: number;
  storage_class: string;
  restore_requested_at: string | null;
  restore_completed_at: string | null;
}

interface RestoreState {
  initiated_at: string;
  tier: typeof TIER;
  retention_days: number;
  objects: Record<string, ObjectState>;
}

interface ObjectInfo {
  key: string;
  size: number;
  storageClass: string;
  restoreHeader: string | null;
  category: Category;
}

function parseArgs(): { mode: "dry-run" | "execute" | "check" } {
  const a = process.argv.slice(2);
  if (a.includes("--dry-run")) return { mode: "dry-run" };
  if (a.includes("--execute")) return { mode: "execute" };
  if (a.includes("--check")) return { mode: "check" };
  console.error("Usage: npx tsx scripts/s3-bulk-restore.ts --dry-run | --execute | --check");
  process.exit(1);
}

function categorize(storageClass: string, restoreHeader: string | null): Category {
  if (storageClass === "STANDARD" || storageClass === "INTELLIGENT_TIERING") {
    return "already_standard";
  }
  if (!restoreHeader) return "glacier_cold";
  // Restore header format: ongoing-request="true" OR ongoing-request="false", expiry-date="..."
  if (/ongoing-request="true"/i.test(restoreHeader)) return "glacier_restore_pending";
  if (/ongoing-request="false"/i.test(restoreHeader)) return "glacier_restored";
  return "glacier_cold";
}

async function listAllObjects(s3: S3Client): Promise<{ key: string; size: number; listedClass: string }[]> {
  const out: { key: string; size: number; listedClass: string }[] = [];
  let token: string | undefined = undefined;
  let pages = 0;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: S3_PREFIX,
      ContinuationToken: token,
    }));
    for (const o of resp.Contents ?? []) {
      if (!o.Key) continue;
      out.push({
        key: o.Key,
        size: o.Size ?? 0,
        listedClass: o.StorageClass ?? "STANDARD",
      });
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    pages++;
    if (pages % 5 === 0) console.log(`[restore] list: ${out.length} objects so far (${pages} pages)`);
  } while (token);
  return out;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
      done++;
      if (onProgress && done % 100 === 0) onProgress(done, items.length);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  if (onProgress) onProgress(done, items.length);
  return results;
}

async function headObject(s3: S3Client, key: string): Promise<{ storageClass: string; restoreHeader: string | null; size: number }> {
  const r = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  return {
    storageClass: r.StorageClass ?? "STANDARD",
    restoreHeader: r.Restore ?? null,
    size: r.ContentLength ?? 0,
  };
}

async function gatherObjectInfo(s3: S3Client): Promise<ObjectInfo[]> {
  console.log(`[restore] listing s3://${S3_BUCKET}/${S3_PREFIX}...`);
  const listed = await listAllObjects(s3);
  console.log(`[restore] ${listed.length} total objects`);

  // Objects reported as STANDARD by List can skip HEAD.
  const needsHead = listed.filter((o) => o.listedClass !== "STANDARD" && o.listedClass !== "INTELLIGENT_TIERING");
  const skipHead = listed.filter((o) => o.listedClass === "STANDARD" || o.listedClass === "INTELLIGENT_TIERING");
  console.log(`[restore] HEAD required for ${needsHead.length} objects (${skipHead.length} standard objects skip HEAD)`);

  const infos: ObjectInfo[] = [];
  for (const o of skipHead) {
    infos.push({
      key: o.key,
      size: o.size,
      storageClass: o.listedClass,
      restoreHeader: null,
      category: "already_standard",
    });
  }

  const headResults = await runWithConcurrency(
    needsHead,
    HEAD_CONCURRENCY,
    async (o) => {
      try {
        const h = await headObject(s3, o.key);
        return { key: o.key, size: h.size || o.size, storageClass: h.storageClass, restoreHeader: h.restoreHeader };
      } catch (err) {
        console.warn(`[restore] HEAD failed for ${o.key}: ${(err as Error).message}`);
        return { key: o.key, size: o.size, storageClass: o.listedClass, restoreHeader: null };
      }
    },
    (done, total) => console.log(`[restore] HEAD progress: ${done}/${total}`),
  );

  for (const r of headResults) {
    infos.push({
      key: r.key,
      size: r.size,
      storageClass: r.storageClass,
      restoreHeader: r.restoreHeader,
      category: categorize(r.storageClass, r.restoreHeader),
    });
  }
  return infos;
}

function summarize(infos: ObjectInfo[]): Record<Category, { count: number; bytes: number }> {
  const empty = { count: 0, bytes: 0 };
  const out: Record<Category, { count: number; bytes: number }> = {
    already_standard: { ...empty },
    glacier_restored: { ...empty },
    glacier_restore_pending: { ...empty },
    glacier_cold: { ...empty },
  };
  for (const i of infos) {
    out[i.category].count += 1;
    out[i.category].bytes += i.size;
  }
  return out;
}

function gib(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GiB";
}

function usd(n: number): string {
  return "$" + n.toFixed(2);
}

function estimateCost(coldBytes: number): { retrieval: number; retention: number; total: number } {
  const gb = coldBytes / 1024 / 1024 / 1024;
  const retrieval = gb * PRICE_BULK_PER_GB;
  const retention = gb * PRICE_STANDARD_PER_GB_MONTH * (RETENTION_DAYS / 30);
  return { retrieval, retention, total: retrieval + retention };
}

function printSummary(infos: ObjectInfo[]): void {
  const s = summarize(infos);
  console.log(`\n===== Restore plan =====`);
  console.log(`Total objects listed:         ${infos.length}`);
  console.log(`  already_standard:            ${s.already_standard.count.toString().padStart(6)}  ${gib(s.already_standard.bytes)}`);
  console.log(`  glacier_restored:            ${s.glacier_restored.count.toString().padStart(6)}  ${gib(s.glacier_restored.bytes)}`);
  console.log(`  glacier_restore_pending:     ${s.glacier_restore_pending.count.toString().padStart(6)}  ${gib(s.glacier_restore_pending.bytes)}`);
  console.log(`  glacier_cold (to restore):   ${s.glacier_cold.count.toString().padStart(6)}  ${gib(s.glacier_cold.bytes)}`);
  const cost = estimateCost(s.glacier_cold.bytes);
  console.log(`\nEstimated cost for glacier_cold:`);
  console.log(`  Bulk retrieval:              ${usd(cost.retrieval)}  (${PRICE_BULK_PER_GB.toFixed(4)}/GB × ${gib(s.glacier_cold.bytes)})`);
  console.log(`  Retained ${RETENTION_DAYS}d standard copy:  ${usd(cost.retention)}  (${PRICE_STANDARD_PER_GB_MONTH.toFixed(3)}/GB/mo × ${RETENTION_DAYS}/30)`);
  console.log(`  ── Total estimated:          ${usd(cost.total)}`);
  console.log(`\nTier: ${TIER} — expected completion window: 5-12 hours from initiation.`);
}

function loadState(): RestoreState | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as RestoreState;
}

function saveState(state: RestoreState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDryRun(s3: S3Client): Promise<void> {
  const infos = await gatherObjectInfo(s3);
  printSummary(infos);
  console.log(`\nNo restores issued (--dry-run).`);
}

async function runExecute(s3: S3Client): Promise<void> {
  const infos = await gatherObjectInfo(s3);
  printSummary(infos);

  const cold = infos.filter((i) => i.category === "glacier_cold");
  if (cold.length === 0) {
    console.log(`\nNothing to restore.`);
    return;
  }

  const cost = estimateCost(cold.reduce((s, i) => s + i.size, 0));
  if (cost.total > COST_WARN_THRESHOLD_USD) {
    console.log(`\n${"!".repeat(60)}`);
    console.log(`WARNING: estimated total cost ${usd(cost.total)} exceeds ${usd(COST_WARN_THRESHOLD_USD)}.`);
    console.log(`Aborting in ${ABORT_WINDOW_SEC}s — press Ctrl+C to cancel.`);
    console.log(`${"!".repeat(60)}`);
    await sleep(ABORT_WINDOW_SEC * 1000);
  }

  // Merge with existing state so we resume cleanly if the script crashed mid-run.
  const existing = loadState();
  const state: RestoreState = existing ?? {
    initiated_at: new Date().toISOString(),
    tier: TIER,
    retention_days: RETENTION_DAYS,
    objects: {},
  };
  for (const i of infos) {
    const prior = state.objects[i.key];
    state.objects[i.key] = {
      size_bytes: i.size,
      storage_class: i.storageClass,
      restore_requested_at: prior?.restore_requested_at ?? null,
      restore_completed_at: prior?.restore_completed_at ?? (i.category === "glacier_restored" ? new Date().toISOString() : null),
    };
  }
  saveState(state);

  const toRestore = cold.filter((i) => !state.objects[i.key]?.restore_requested_at);
  console.log(`\nIssuing RestoreObject for ${toRestore.length} objects (skipping ${cold.length - toRestore.length} with prior request)...`);

  let ok = 0;
  let fail = 0;
  await runWithConcurrency(
    toRestore,
    RESTORE_CONCURRENCY,
    async (item) => {
      try {
        await s3.send(new RestoreObjectCommand({
          Bucket: S3_BUCKET,
          Key: item.key,
          RestoreRequest: {
            Days: RETENTION_DAYS,
            GlacierJobParameters: { Tier: TIER },
          },
        }));
        state.objects[item.key]!.restore_requested_at = new Date().toISOString();
        ok++;
      } catch (err) {
        const code = (err as { name?: string }).name;
        // RestoreAlreadyInProgress is fine — another run initiated it.
        if (code === "RestoreAlreadyInProgress") {
          state.objects[item.key]!.restore_requested_at = new Date().toISOString();
          ok++;
        } else {
          console.warn(`[restore] ${item.key}: ${(err as Error).message}`);
          fail++;
        }
      }
      if ((ok + fail) % STATE_FLUSH_EVERY === 0) {
        saveState(state);
        console.log(`[restore] progress: ${ok + fail}/${toRestore.length} (ok=${ok} fail=${fail})`);
      }
    },
  );
  saveState(state);

  console.log(`\n===== Restore initiated =====`);
  console.log(`Requests issued:  ${ok}`);
  console.log(`Failed:           ${fail}`);
  console.log(`State file:       ${STATE_FILE}`);
  console.log(`\nExpected completion: 5-12 hours. Check status with:`);
  console.log(`  npx tsx scripts/s3-bulk-restore.ts --check`);
}

async function runCheck(s3: S3Client): Promise<void> {
  const state = loadState();
  if (!state) {
    console.error(`No state file at ${STATE_FILE}. Run --execute first.`);
    process.exit(1);
  }
  const pending = Object.entries(state.objects).filter(([, v]) => v.restore_requested_at && !v.restore_completed_at);
  console.log(`[restore] checking ${pending.length} pending objects...`);

  let completed = 0;
  await runWithConcurrency(
    pending,
    HEAD_CONCURRENCY,
    async ([key]) => {
      try {
        const h = await headObject(s3, key);
        const c = categorize(h.storageClass, h.restoreHeader);
        if (c === "glacier_restored" || c === "already_standard") {
          state.objects[key]!.restore_completed_at = new Date().toISOString();
          completed++;
        }
      } catch (err) {
        console.warn(`[restore] HEAD failed for ${key}: ${(err as Error).message}`);
      }
    },
    (done, total) => console.log(`[restore] check progress: ${done}/${total}`),
  );
  saveState(state);

  const total = Object.values(state.objects).filter((v) => v.restore_requested_at).length;
  const allDone = Object.values(state.objects).filter((v) => v.restore_completed_at).length;
  const pct = total === 0 ? 100 : (allDone / total) * 100;

  const earliest = state.initiated_at;
  const ageHr = (Date.now() - new Date(earliest).getTime()) / 1000 / 3600;
  const etaHr = pct > 0 && pct < 100 ? (ageHr / (pct / 100)) - ageHr : 0;

  console.log(`\n===== Check summary =====`);
  console.log(`Completed since last check: ${completed}`);
  console.log(`Overall:                    ${allDone}/${total}  (${pct.toFixed(1)}% complete)`);
  console.log(`Initiated:                  ${earliest}`);
  console.log(`Elapsed:                    ${ageHr.toFixed(1)} hr`);
  if (etaHr > 0) console.log(`Estimated time remaining:   ${etaHr.toFixed(1)} hr (rough extrapolation)`);
}

async function main(): Promise<void> {
  const { mode } = parseArgs();
  const s3 = new S3Client({});
  if (mode === "dry-run") await runDryRun(s3);
  else if (mode === "execute") await runExecute(s3);
  else await runCheck(s3);
}

main().catch((err) => {
  console.error("[restore] FATAL:", err);
  process.exit(1);
});
