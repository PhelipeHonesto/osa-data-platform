/**
 * 2023 ADS-B backfill driver.
 *
 * Reads /tmp/adsb-2023-probe.json (built by probe-2023-releases.ts), then
 * invokes the existing archiveDay() function from src/ingestion/archive-adsb-raw.ts
 * for each day in scope. Days with no upstream release are recorded as no_release.
 *
 * Pre-flight (run on the Lightsail host before --execute):
 *   1. ssh lightsail
 *   2. pm2 stop all                         # prevents SQLITE_BUSY
 *   3. crontab -e                           # comment out nightly archive cron
 *   4. df -h ~                              # confirm >20 GB free
 *   5. cd ~/dumont-agent && git pull
 *   6. tmux new -s backfill-2023
 *   7. GITHUB_TOKEN=$(gh auth token) npx tsx scripts/backfill-2023.ts --execute
 *   8. Ctrl+b d to detach
 *   9. tmux attach -t backfill-2023 to resume
 *  10. After completion: pm2 start all, then re-enable cron
 *
 * Usage:
 *   npx tsx scripts/backfill-2023.ts                              # dry-run (default)
 *   npx tsx scripts/backfill-2023.ts --dry-run
 *   npx tsx scripts/backfill-2023.ts --execute
 *   npx tsx scripts/backfill-2023.ts --execute --start 2023-01-01 --end 2023-03-31
 *   npx tsx scripts/backfill-2023.ts --execute --limit 5         # smoke test
 */

import { readFileSync, appendFileSync, mkdirSync, statfsSync } from "node:fs";
import { S3Client, HeadBucketCommand, type StorageClass } from "@aws-sdk/client-s3";
import { archiveDay } from "../src/ingestion/archive-adsb-raw.js";
import { getDb, closeDb } from "../src/memory/database.js";

const PROBE_FILE = "/tmp/adsb-2023-probe.json";
const S3_BUCKET = "osa-dumont-backup";
const MIN_FREE_GB = 20;
const HEARTBEAT_EVERY = 10;

interface Probe {
  generated_at: string;
  backfill_dates: string[];
  no_release_dates: string[];
  partial_source_dates: string[];
  days: { date: string; total_bytes: number; format: string }[];
}

interface Args {
  dryRun: boolean;
  execute: boolean;
  start?: string;
  end?: string;
  limit?: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const value = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };
  const limitStr = value("--limit");
  return {
    dryRun: flag("--dry-run") || !flag("--execute"),
    execute: flag("--execute"),
    start: value("--start"),
    end: value("--end"),
    limit: limitStr ? parseInt(limitStr, 10) : undefined,
  };
}

// ── Pre-flight checks ─────────────────────────────────────────────────────

interface Preflight { ok: boolean; problems: string[]; }

async function preflight(): Promise<Preflight> {
  const problems: string[] = [];

  // Disk
  try {
    const fs = statfsSync(process.cwd());
    const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
    if (freeGb < MIN_FREE_GB) {
      problems.push(`disk: only ${freeGb.toFixed(1)} GB free (need ${MIN_FREE_GB})`);
    }
  } catch (err) {
    problems.push(`disk check failed: ${err instanceof Error ? err.message : err}`);
  }

  // DB
  try {
    const db = getDb();
    db.prepare("SELECT COUNT(*) AS n FROM archive_progress").get();
  } catch (err) {
    problems.push(`db: ${err instanceof Error ? err.message : err}`);
  }

  // S3
  try {
    const s3 = new S3Client({});
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  } catch (err) {
    problems.push(`s3: ${err instanceof Error ? err.message : err}`);
  }

  // Token (warning only)
  if (!process.env["GITHUB_TOKEN"]) {
    problems.push("GITHUB_TOKEN not set — anonymous rate limit (60/hr) will throttle the backfill");
  }

  return { ok: problems.length === 0, problems };
}

// ── Backfill loop ─────────────────────────────────────────────────────────

function inRange(date: string, args: Args): boolean {
  if (args.start && date < args.start) return false;
  if (args.end && date > args.end) return false;
  return true;
}

function formatBytes(b: number): string {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const probe = JSON.parse(readFileSync(PROBE_FILE, "utf-8")) as Probe;
  const probeAge = Math.round((Date.now() - new Date(probe.generated_at).getTime()) / 1000 / 60 / 60);

  const allTargets = probe.backfill_dates.filter((d) => inRange(d, args));
  const targets = args.limit ? allTargets.slice(0, args.limit) : allTargets;
  const noReleaseTargets = probe.no_release_dates.filter((d) => inRange(d, args));

  const totalBytesPlanned = probe.days
    .filter((d) => targets.includes(d.date))
    .reduce((s, d) => s + d.total_bytes, 0);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  ADS-B 2023 backfill driver");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  probe file:        ${PROBE_FILE}  (age: ${probeAge}h)`);
  console.log(`  range:             ${args.start ?? "start of probe"} → ${args.end ?? "end of probe"}`);
  console.log(`  limit:             ${args.limit ?? "(none)"}`);
  console.log(`  backfill targets:  ${targets.length} days, ${formatBytes(totalBytesPlanned)}`);
  console.log(`  no_release marks:  ${noReleaseTargets.length} days`);
  console.log(`  partial sources:   ${probe.partial_source_dates.length} days (excluded from this run)`);
  console.log(`  mode:              ${args.dryRun ? "DRY-RUN" : "EXECUTE"}`);
  console.log();

  // Pre-flight
  const pf = await preflight();
  console.log(`Pre-flight checks: ${pf.ok ? "OK" : `FAIL (${pf.problems.length})`}`);
  for (const p of pf.problems) console.log(`  ✗ ${p}`);
  console.log();

  if (args.dryRun) {
    console.log("[dry-run] sample of first 5 targets:");
    for (const date of targets.slice(0, 5)) {
      const day = probe.days.find((d) => d.date === date);
      console.log(`  ${date}  ${day?.format.padEnd(12)}  ${formatBytes(day?.total_bytes ?? 0)}`);
    }
    if (targets.length > 5) console.log(`  ... and ${targets.length - 5} more`);
    console.log();
    console.log("[dry-run] no_release sample of first 5:");
    for (const date of noReleaseTargets.slice(0, 5)) console.log(`  ${date}`);
    if (noReleaseTargets.length > 5) console.log(`  ... and ${noReleaseTargets.length - 5} more`);
    console.log();
    console.log("Re-run with --execute to apply.");
    return;
  }

  if (!pf.ok) {
    const blocking = pf.problems.filter((p) => !p.startsWith("GITHUB_TOKEN"));
    if (blocking.length > 0) {
      console.error("Aborting: pre-flight failed.");
      process.exit(1);
    }
  }

  // Set up logging
  mkdirSync("logs", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = `logs/backfill-2023-${stamp}.log`;
  const log = (msg: string): void => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    appendFileSync(logPath, line + "\n");
  };

  log(`backfill starting — ${targets.length} days, log: ${logPath}`);

  // Signal handling for graceful shutdown
  let stopRequested = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} received — finishing current day, then stopping`);
      stopRequested = true;
    });
  }

  const s3 = new S3Client({});
  const db = getDb();
  const startMs = Date.now();
  const counts: Record<string, number> = { complete: 0, skipped: 0, no_release: 0, failed: 0 };
  let bytesUploaded = 0;

  for (let i = 0; i < targets.length; i++) {
    if (stopRequested) {
      log(`stopping early at ${i}/${targets.length}`);
      break;
    }
    const date = targets[i] as string;
    const planned = probe.days.find((d) => d.date === date)?.total_bytes ?? 0;
    try {
      const result = await archiveDay(s3, db, date, "GLACIER" as StorageClass, false);
      counts[result] = (counts[result] ?? 0) + 1;
      if (result === "complete") bytesUploaded += planned;
      log(`${date}: ${result}  (${formatBytes(planned)})`);
    } catch (err) {
      counts["failed"] = (counts["failed"] ?? 0) + 1;
      log(`${date}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }

    if ((i + 1) % HEARTBEAT_EVERY === 0 || i === targets.length - 1) {
      const elapsedH = (Date.now() - startMs) / 3600_000;
      const frac = (i + 1) / targets.length;
      const etaH = frac > 0 ? (elapsedH / frac) * (1 - frac) : 0;
      log(`heartbeat ${i + 1}/${targets.length} (${(frac * 100).toFixed(1)}%) elapsed:${elapsedH.toFixed(1)}h eta:${etaH.toFixed(1)}h uploaded:${formatBytes(bytesUploaded)}`);
    }
  }

  // Mark no_release days (only if we weren't stopped)
  if (!stopRequested && noReleaseTargets.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO archive_progress (date, status, files_archived, total_bytes, s3_prefix, archived_at)
      VALUES (?, 'no_release', 0, 0, NULL, datetime('now'))
      ON CONFLICT(date) DO UPDATE SET status='no_release', archived_at=datetime('now')
    `);
    let marked = 0;
    for (const date of noReleaseTargets) {
      try {
        stmt.run(date);
        marked++;
      } catch (err) {
        log(`no_release mark failed for ${date}: ${err instanceof Error ? err.message : err}`);
      }
    }
    log(`marked ${marked}/${noReleaseTargets.length} days as no_release`);
  }

  const elapsedH = ((Date.now() - startMs) / 3600_000).toFixed(1);
  log(`final: complete=${counts["complete"]} skipped=${counts["skipped"]} failed=${counts["failed"]} no_release_marks=${counts["no_release"] ?? 0}`);
  log(`bytes uploaded: ${formatBytes(bytesUploaded)}`);
  log(`runtime: ${elapsedH}h`);

  closeDb();
  process.exit(stopRequested || (counts["failed"] ?? 0) > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
