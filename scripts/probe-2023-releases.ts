/**
 * 2023 ADS-B backfill pre-flight probe.
 *
 * Probes adsblol/globe_history_2023 release tags for every day of 2023
 * (prod-0) and the first day of each month for staging-0 fallback. Records
 * format, sizes, and produces a backfill plan in /tmp/adsb-2023-probe.json.
 *
 * Read-only. No downloads. Authenticated runtime ~30s.
 *
 * Usage:
 *   GITHUB_TOKEN=$(gh auth token) npx tsx scripts/probe-2023-releases.ts
 */

import { writeFileSync } from "node:fs";

const GITHUB_API = "https://api.github.com";
const REPO = "adsblol/globe_history_2023";
const REAL_DATA_BYTES = 500 * 1024 ** 2; // 500 MB — adsb.lol guidance: "ignore if significantly smaller"
const GLACIER_USD_PER_GB_MONTH = 0.001;
const ASSUMED_PIPE_MBPS = 10;

interface Asset { name: string; size: number; }

interface DayProbe {
  date: string;
  exists: boolean;
  asset_count: number;
  total_bytes: number;
  asset_names: string[];
  format: "single_tar" | "split_tar" | "other" | "none";
  has_real_data: boolean;
}

interface StagingSample {
  date: string;
  exists: boolean;
  total_bytes: number;
}

interface Report {
  generated_at: string;
  repo: string;
  summary: {
    days_with_release: number;
    days_with_real_data: number;
    days_with_partial_source: number;
    days_no_release: number;
    format_single_tar: number;
    format_split_tar: number;
    format_other: number;
    total_backfill_bytes: number;
  };
  estimated: {
    total_gb: string;
    runtime_hours_at_assumed_pipe: string;
    s3_glacier_monthly_usd: string;
    pipe_assumption_mbps: number;
  };
  backfill_dates: string[];
  no_release_dates: string[];
  partial_source_dates: string[];
  staging_samples: StagingSample[];
  days: DayProbe[];
}

// ── helpers ────────────────────────────────────────────────────────────────

const authed = Boolean(process.env["GITHUB_TOKEN"]);
const BASE_DELAY_MS = authed ? 0 : 1200;

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "osa-dumont-2023-probe/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let rateLimitRemaining = authed ? 5000 : 60;

function days2023(): string[] {
  const dates: string[] = [];
  const cur = new Date("2023-01-01T00:00:00Z");
  const end = new Date("2023-12-31T00:00:00Z");
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function detectFormat(names: string[]): DayProbe["format"] {
  if (names.length === 0) return "none";
  const hasAa = names.some((n) => /\.tar\.aa$/.test(n));
  const hasAb = names.some((n) => /\.tar\.ab$/.test(n));
  if (hasAa && hasAb) return "split_tar";
  const hasSingleTar = names.some((n) => /\.tar$/.test(n));
  if (hasSingleTar) return "single_tar";
  return "other";
}

async function probeTag(date: string, source: "prod-0" | "staging-0"): Promise<{ exists: boolean; assets: Asset[] }> {
  const dotDate = date.replaceAll("-", ".");
  const tag = `v${dotDate}-planes-readsb-${source}`;
  const url = `${GITHUB_API}/repos/${REPO}/releases/tags/${tag}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, { headers: headers() });
    const remaining = resp.headers.get("x-ratelimit-remaining");
    if (remaining) rateLimitRemaining = parseInt(remaining, 10);

    if (resp.status === 404) return { exists: false, assets: [] };

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
      console.error(`[probe] ${tag}: HTTP ${resp.status}`);
      return { exists: false, assets: [] };
    }

    const data = await resp.json() as { assets?: { name: string; size: number }[] };
    const tarAssets = (data.assets ?? []).filter((a) =>
      a.name.endsWith(".tar") || /\.tar\.[a-z]+$/.test(a.name),
    );
    return { exists: tarAssets.length > 0, assets: tarAssets };
  }

  return { exists: false, assets: [] };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dates = days2023();
  console.log(`[probe] ${dates.length} days to probe (${authed ? "authed" : "anon"})`);

  const days: DayProbe[] = [];
  const startMs = Date.now();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i] as string;
    const { exists, assets } = await probeTag(date, "prod-0");
    const totalBytes = assets.reduce((s, a) => s + a.size, 0);
    const names = assets.map((a) => a.name);
    const format = detectFormat(names);

    days.push({
      date,
      exists,
      asset_count: assets.length,
      total_bytes: totalBytes,
      asset_names: names,
      format,
      has_real_data: exists && totalBytes >= REAL_DATA_BYTES,
    });

    if ((i + 1) % 30 === 0 || i === dates.length - 1) {
      console.log(`[probe] ${i + 1}/${dates.length}  rl:${rateLimitRemaining}`);
    }

    if (BASE_DELAY_MS > 0) await sleep(BASE_DELAY_MS);
  }

  // First-of-month staging samples (12 extra requests)
  const monthFirsts = dates.filter((d) => d.endsWith("-01"));
  const stagingSamples: StagingSample[] = [];
  for (const date of monthFirsts) {
    const { exists, assets } = await probeTag(date, "staging-0");
    stagingSamples.push({
      date,
      exists,
      total_bytes: assets.reduce((s, a) => s + a.size, 0),
    });
    if (BASE_DELAY_MS > 0) await sleep(BASE_DELAY_MS);
  }

  // Aggregate
  const summary = {
    days_with_release: 0,
    days_with_real_data: 0,
    days_with_partial_source: 0,
    days_no_release: 0,
    format_single_tar: 0,
    format_split_tar: 0,
    format_other: 0,
    total_backfill_bytes: 0,
  };
  const backfillDates: string[] = [];
  const noReleaseDates: string[] = [];
  const partialSourceDates: string[] = [];

  for (const d of days) {
    if (d.exists) {
      summary.days_with_release++;
      if (d.has_real_data) {
        summary.days_with_real_data++;
        summary.total_backfill_bytes += d.total_bytes;
        backfillDates.push(d.date);
      } else {
        summary.days_with_partial_source++;
        partialSourceDates.push(d.date);
      }
    } else {
      summary.days_no_release++;
      noReleaseDates.push(d.date);
    }

    if (d.format === "single_tar") summary.format_single_tar++;
    else if (d.format === "split_tar") summary.format_split_tar++;
    else if (d.format === "other") summary.format_other++;
  }

  const totalGb = summary.total_backfill_bytes / 1024 ** 3;
  const runtimeH = totalGb > 0 ? (totalGb * 1024) / (ASSUMED_PIPE_MBPS * 3600) : 0;
  const monthlyUsd = totalGb * GLACIER_USD_PER_GB_MONTH;

  const report: Report = {
    generated_at: new Date().toISOString(),
    repo: REPO,
    summary,
    estimated: {
      total_gb: totalGb.toFixed(2),
      runtime_hours_at_assumed_pipe: runtimeH.toFixed(1),
      s3_glacier_monthly_usd: monthlyUsd.toFixed(2),
      pipe_assumption_mbps: ASSUMED_PIPE_MBPS,
    },
    backfill_dates: backfillDates,
    no_release_dates: noReleaseDates,
    partial_source_dates: partialSourceDates,
    staging_samples: stagingSamples,
    days,
  };

  const outPath = "/tmp/adsb-2023-probe.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  2023 backfill pre-flight — adsblol/globe_history_2023");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  days probed:                ${days.length}`);
  console.log(`  days with prod-0 release:   ${summary.days_with_release}`);
  const thresholdMb = REAL_DATA_BYTES / 1024 ** 2;
  console.log(`    >=${thresholdMb}MB (real data):      ${summary.days_with_real_data}`);
  console.log(`    <${thresholdMb}MB (partial source):  ${summary.days_with_partial_source}`);
  console.log(`  days with no release:       ${summary.days_no_release}`);
  console.log();
  console.log(`  format distribution:`);
  console.log(`    single .tar:              ${summary.format_single_tar}`);
  console.log(`    split .tar.aa+.tar.ab:    ${summary.format_split_tar}`);
  console.log(`    other:                    ${summary.format_other}`);
  console.log();
  console.log(`  backfill estimates (real-data days only):`);
  console.log(`    total bytes:              ${totalGb.toFixed(2)} GB`);
  console.log(`    runtime @ ${ASSUMED_PIPE_MBPS} MB/s:        ${runtimeH.toFixed(1)} h`);
  console.log(`    glacier cost:             $${monthlyUsd.toFixed(2)}/mo`);
  console.log();
  const stagingHits = stagingSamples.filter((s) => s.exists).length;
  console.log(`  staging-0 sample (first-of-month, 12 dates):`);
  console.log(`    exists on:                ${stagingHits}/${stagingSamples.length} sampled days`);
  console.log();
  console.log(`  rate limit remaining:       ${rateLimitRemaining}`);
  console.log(`  elapsed:                    ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
  console.log(`  report:                     ${outPath}`);
  console.log();
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
