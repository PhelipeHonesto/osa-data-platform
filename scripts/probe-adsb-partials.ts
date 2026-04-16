/**
 * ADS-B partial-day source probe — GitHub Releases metadata only.
 *
 * For each partial day in the inventory report, probe three release tags:
 *   v{YYYY.MM.DD}-planes-readsb-prod-0
 *   v{YYYY.MM.DD}-planes-readsb-prod-1
 *   v{YYYY.MM.DD}-planes-readsb-staging-0
 *
 * Records which tags exist and their tar byte totals. Picks best_source by
 * largest total bytes (>1GB threshold). No downloads — HEAD of release metadata only.
 *
 * Usage:
 *   GITHUB_TOKEN=$(gh auth token) npx tsx scripts/probe-adsb-partials.ts
 *   npx tsx scripts/probe-adsb-partials.ts --inventory /tmp/adsb-inventory-2026-04-16.json
 */

import { readFileSync, writeFileSync } from "node:fs";

const GITHUB_API = "https://api.github.com";
const MIN_VALID_BYTES = 1024 ** 3; // 1 GB
const SOURCES = ["prod-0", "prod-1", "staging-0"] as const;
type Source = typeof SOURCES[number];

interface InventoryReport {
  partial_days: Record<string, string[]>;
}

interface TagProbe {
  exists: boolean;
  total_bytes: number;
  asset_count: number;
  tag: string;
}

interface DayProbe {
  date: string;
  sources: Record<Source, TagProbe>;
  best_source: Source | null;
  best_bytes: number;
  recoverable: boolean;
}

interface ProbeReport {
  generated_at: string;
  inventory_file: string;
  total_days: number;
  rate_limit_remaining_final: number;
  summary: {
    recoverable_via_prod_0: number;
    recoverable_via_prod_1: number;
    recoverable_via_staging_0: number;
    unrecoverable: number;
  };
  days: DayProbe[];
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(): { inventory: string } {
  const idx = process.argv.indexOf("--inventory");
  const inventory = idx !== -1 && process.argv[idx + 1]
    ? process.argv[idx + 1] as string
    : "/tmp/adsb-inventory-2026-04-16.json";
  return { inventory };
}

// ── GitHub ─────────────────────────────────────────────────────────────────

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "osa-dumont-probe/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

const authed = Boolean(process.env["GITHUB_TOKEN"]);
const BASE_DELAY_MS = authed ? 0 : 1200; // anon 60/hr → 1.2s between calls

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let rateLimitRemaining = authed ? 5000 : 60;

async function probeTag(date: string, source: Source): Promise<TagProbe> {
  const year = date.slice(0, 4);
  const dotDate = date.replaceAll("-", ".");
  const repo = `adsblol/globe_history_${year}`;
  const tag = `v${dotDate}-planes-readsb-${source}`;
  const url = `${GITHUB_API}/repos/${repo}/releases/tags/${tag}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, { headers: githubHeaders() });

    const remaining = resp.headers.get("x-ratelimit-remaining");
    if (remaining) rateLimitRemaining = parseInt(remaining, 10);

    if (resp.status === 404) {
      return { exists: false, total_bytes: 0, asset_count: 0, tag };
    }

    if (resp.status === 403 || resp.status === 429) {
      const reset = resp.headers.get("x-ratelimit-reset");
      const waitSec = reset
        ? Math.max(0, parseInt(reset, 10) - Math.floor(Date.now() / 1000)) + 5
        : 60;
      console.error(`[probe] rate limited, waiting ${waitSec}s`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (!resp.ok) {
      console.error(`[probe] ${tag}: HTTP ${resp.status} ${resp.statusText}`);
      return { exists: false, total_bytes: 0, asset_count: 0, tag };
    }

    const data = await resp.json() as { assets?: { name: string; size: number }[] };
    const tarAssets = (data.assets ?? []).filter((a) =>
      a.name.endsWith(".tar") || /\.tar\.[a-z]+$/.test(a.name),
    );
    const totalBytes = tarAssets.reduce((s, a) => s + a.size, 0);

    return {
      exists: tarAssets.length > 0,
      total_bytes: totalBytes,
      asset_count: tarAssets.length,
      tag,
    };
  }

  return { exists: false, total_bytes: 0, asset_count: 0, tag };
}

// ── Main ───────────────────────────────────────────────────────────────────

function pickBest(sources: Record<Source, TagProbe>): { best: Source | null; bytes: number } {
  let best: Source | null = null;
  let bestBytes = 0;
  for (const s of SOURCES) {
    const probe = sources[s];
    if (probe.exists && probe.total_bytes >= MIN_VALID_BYTES && probe.total_bytes > bestBytes) {
      best = s;
      bestBytes = probe.total_bytes;
    }
  }
  return { best, bytes: bestBytes };
}

function formatBytes(b: number): string {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)}KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)}MB`;
  return `${(b / 1024 ** 3).toFixed(2)}GB`;
}

async function main(): Promise<void> {
  const { inventory } = parseArgs();

  console.log(`[probe] reading inventory: ${inventory}`);
  const report = JSON.parse(readFileSync(inventory, "utf-8")) as InventoryReport;
  const dates = Object.keys(report.partial_days).sort();
  console.log(`[probe] ${dates.length} partial days to probe`);
  console.log(`[probe] auth: ${authed ? "token" : "anonymous"} | delay between calls: ${BASE_DELAY_MS}ms`);
  console.log();

  const days: DayProbe[] = [];
  const counts = { recoverable_via_prod_0: 0, recoverable_via_prod_1: 0, recoverable_via_staging_0: 0, unrecoverable: 0 };
  const startMs = Date.now();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i] as string;
    const sources = {} as Record<Source, TagProbe>;

    for (const source of SOURCES) {
      sources[source] = await probeTag(date, source);
      if (BASE_DELAY_MS > 0) await sleep(BASE_DELAY_MS);
    }

    const { best, bytes } = pickBest(sources);
    const recoverable = best !== null;

    if (best === "prod-0") counts.recoverable_via_prod_0++;
    else if (best === "prod-1") counts.recoverable_via_prod_1++;
    else if (best === "staging-0") counts.recoverable_via_staging_0++;
    else counts.unrecoverable++;

    const dayProbe: DayProbe = {
      date,
      sources,
      best_source: best,
      best_bytes: bytes,
      recoverable,
    };
    days.push(dayProbe);

    const tag = best ?? "none";
    const existsStr = SOURCES.map((s) => sources[s].exists ? `${s}✓${formatBytes(sources[s].total_bytes)}` : `${s}✗`).join(" ");
    console.log(`[probe] ${i + 1}/${dates.length} ${date}  best:${tag.padEnd(10)}  ${existsStr}  [rl:${rateLimitRemaining}]`);
  }

  const out: ProbeReport = {
    generated_at: new Date().toISOString(),
    inventory_file: inventory,
    total_days: dates.length,
    rate_limit_remaining_final: rateLimitRemaining,
    summary: counts,
    days,
  };

  const today = new Date().toISOString().slice(0, 10);
  const outPath = `/tmp/adsb-partials-probe-${today}.json`;
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Partial-day source probe — summary");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  recoverable via prod-0:     ${counts.recoverable_via_prod_0}`);
  console.log(`  recoverable via prod-1:     ${counts.recoverable_via_prod_1}`);
  console.log(`  recoverable via staging-0:  ${counts.recoverable_via_staging_0}`);
  console.log(`  unrecoverable:              ${counts.unrecoverable}`);
  console.log(`  ────────────────────────────────────`);
  console.log(`  total probed:               ${dates.length}`);
  console.log();
  console.log(`  rate-limit remaining:       ${rateLimitRemaining}`);
  console.log(`  elapsed:                    ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
  console.log(`  report:                     ${outPath}`);
  console.log();
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
