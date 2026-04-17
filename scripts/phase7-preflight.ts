/**
 * Phase 7 rebuild pre-flight. Seven readiness checks printed with ✓/✗.
 * Exits 0 if everything is ready, 1 otherwise.
 *
 * Usage: npx tsx scripts/phase7-preflight.ts
 */
import pg from "pg";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const S3_BUCKET = "osa-dumont-backup";
const S3_PREFIX = "raw/adsb/";
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), "s3-restore-state.json");

interface StateObject {
  restore_requested_at: string | null;
  restore_completed_at: string | null;
}
interface RestoreState {
  initiated_at: string;
  objects: Record<string, StateObject>;
}

let failures = 0;
function pass(label: string, detail?: string): void {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, fix: string): void {
  console.log(`✗ ${label}`);
  console.log(`    fix: ${fix}`);
  failures++;
}

async function main(): Promise<void> {
  console.log(`\n=== Phase 7 pre-flight ===\n`);

  // 1. SUPABASE_DATABASE_URL
  const pgUrl = process.env["SUPABASE_DATABASE_URL"];
  if (!pgUrl) {
    fail("SUPABASE_DATABASE_URL set", "export SUPABASE_DATABASE_URL=... (or source .env)");
  } else {
    pass("SUPABASE_DATABASE_URL set");
  }

  // 2. Postgres reachable
  let client: pg.Client | null = null;
  if (pgUrl) {
    try {
      client = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
      await client.connect();
      await client.query("SELECT 1");
      pass("Postgres reachable");
    } catch (err) {
      fail(
        "Postgres reachable",
        `connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      client = null;
    }
  }

  // 3. Glacier restore state
  if (!existsSync(STATE_FILE)) {
    fail(
      "Glacier restore initiated",
      "run: npx tsx scripts/s3-bulk-restore.ts --execute",
    );
  } else {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as RestoreState;
    const objs = Object.values(state.objects);
    const requested = objs.filter((o) => o.restore_requested_at).length;
    const completed = objs.filter((o) => o.restore_completed_at).length;
    const pct = requested === 0 ? 0 : (completed / requested) * 100;
    if (requested === 0) {
      fail("Glacier restore requested", "state file exists but nothing was requested");
    } else if (pct < 100) {
      fail(
        "Glacier restore complete",
        `${completed}/${requested} (${pct.toFixed(1)}%) — wait, or run: npx tsx scripts/s3-bulk-restore.ts --check`,
      );
    } else {
      pass("Glacier restore complete", `${completed}/${requested} objects restored`);
    }
  }

  // 4. Current adsb_completed_legs row count
  if (client) {
    try {
      const r = await client.query<{ n: string }>(
        "SELECT COUNT(*)::bigint AS n FROM adsb_completed_legs",
      );
      const n = Number(r.rows[0]!.n);
      pass("adsb_completed_legs row count (will be deleted)", n.toLocaleString());
    } catch (err) {
      fail(
        "adsb_completed_legs row count",
        `query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5. backfill_progress status breakdown
  if (client) {
    try {
      const r = await client.query<{ status: string; c: string }>(
        "SELECT status, COUNT(*)::bigint AS c FROM backfill_progress GROUP BY status ORDER BY status",
      );
      if (r.rows.length === 0) {
        pass("backfill_progress breakdown", "empty (fresh rebuild)");
      } else {
        const summary = r.rows.map((row) => `${row.status}=${row.c}`).join(", ");
        pass("backfill_progress breakdown", summary);
      }
    } catch (err) {
      fail(
        "backfill_progress breakdown",
        `query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 6. Disk space in /tmp (need 5 GB)
  try {
    const st = statfsSync("/tmp");
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const freeGiB = freeBytes / 1024 / 1024 / 1024;
    if (freeGiB >= 5) {
      pass("/tmp has >= 5 GB free", `${freeGiB.toFixed(1)} GiB`);
    } else {
      fail(
        "/tmp disk space",
        `only ${freeGiB.toFixed(1)} GiB free; free up space or set backfill tmp to another dir`,
      );
    }
  } catch (err) {
    fail(
      "/tmp disk space check",
      `statfs failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 7. S3 list works on raw/adsb/
  try {
    const s3 = new S3Client({});
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: S3_PREFIX, MaxKeys: 1 }),
    );
    if (!r.Contents || r.Contents.length === 0) {
      fail("S3 list raw/adsb/", "bucket/prefix returned no objects");
    } else {
      pass("S3 list raw/adsb/", `bucket reachable, at least one object present`);
    }
  } catch (err) {
    fail(
      "S3 list raw/adsb/",
      `list failed: ${err instanceof Error ? err.message : String(err)} — check AWS credentials`,
    );
  }

  if (client) await client.end().catch(() => {});

  console.log("");
  if (failures === 0) {
    console.log(`READY. Run:`);
    console.log(``);
    console.log(`  set -a && source .env && set +a`);
    console.log(`  DATABASE_TYPE=postgres npx tsx src/ingestion/history-backfill.ts \\`);
    console.log(`    --from 2023-12-30 --to 2026-04-13 --s3-only 2>&1 | tee ~/phase7-rebuild.log`);
    console.log(``);
    console.log(`Then: npx tsx scripts/phase7-verify.ts`);
    process.exit(0);
  } else {
    console.log(`${failures} check${failures === 1 ? "" : "s"} failed — fix above before running the rebuild.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("preflight crashed:", err);
  process.exit(1);
});
