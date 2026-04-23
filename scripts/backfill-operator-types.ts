/**
 * Backfill operators.operator_type for well-known classifications.
 *
 * Phase 1.5 / ER plan build step 2. Starts from the Phase 1 calibration
 * finding that ~5 rows in the operators canonical are not operating
 * carriers. Applies exact-name rules for the four confirmed cases and a
 * conservative set of non-US corporate-form patterns for foreign_aoc.
 * Everything else stays NULL and awaits later audit.
 *
 * Never overwrites a non-NULL operator_type — if a row already carries a
 * value different from the rule's proposal, the script logs a warning and
 * skips. Operator_type was intended to be rare-editable.
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:backfill-types              # dry run
 *   DATABASE_TYPE=postgres npm run operators:backfill-types -- --commit
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getPool, closePg } from "../src/db/pg-database.js";
import { initSentry, flushSentry, installProcessHandlers } from "../src/utils/sentry.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("backfill-operator-types");

// ── Types ────────────────────────────────────────────────────────────────

export type OperatorType =
  | "part_135"
  | "part_121"
  | "part_91k"
  | "foreign_aoc"
  | "broker"
  | "billing_agent"
  | "financier"
  | "holding_co"
  | "defunct"
  | "trust_holder";

export interface Classification {
  type: OperatorType;
  reason: string;
}

export interface ExactNameRule {
  canonicalName: string;
  type: OperatorType;
  reason: string;
}

// ── Rules (testable) ─────────────────────────────────────────────────────

// Exact-name matches from Phase 1 calibration (docs/phase1-followups.md §1
// items 1 + 10). Conservative: one entry per known non-carrier; add more
// as future audit passes identify them. IATA-SIS and Apollo-style scans
// land when those sources are ingested — for now, manual entries only.
export const EXACT_NAME_RULES: ExactNameRule[] = [
  {
    canonicalName: "Accent Airways LLC",
    type: "billing_agent",
    reason: "IATA SIS billing agent, not an operating carrier",
  },
  {
    canonicalName: "Global Jet Capital",
    type: "financier",
    reason: "Aircraft finance company; holds title, does not operate",
  },
  {
    canonicalName: "VistaJet US",
    type: "broker",
    reason: "DOT Part 295 broker; VistaJet-branded front for internal operators",
  },
  {
    canonicalName: "TAG Aviation USA",
    type: "defunct",
    reason: "US Part 135 cert sold in 2007; brand now DOT Part 295 broker only",
  },
];

// Conservative non-US corporate-form markers. Each regex must identify a
// jurisdiction whose form is rarely (ideally never) reused as a US entity:
//   GmbH / GesmbH  — German, Austrian, Swiss
//   SEZC           — Cayman Islands Special Economic Zone Company
//   s.r.l.         — Italian limited-liability
//   Ltda           — Brazilian / Portuguese limited company
// "Ltd" and "S.A." are deliberately excluded — both occur on US corporate
// filings too often for confident classification.
export const FOREIGN_AOC_PATTERNS: readonly RegExp[] = [
  /\bGmbH\b/,
  /\bGesmbH\b/,
  /\bSEZC\b/,
  /\bs\.r\.l\.?\b/i,
  /\bLtda\.?\b/,
];

/** Normalize a canonical name for equality comparison: trim, lowercase,
 * collapse interior whitespace. Mirrors the light normalization used by
 * operator-resolver's name comparator without reaching into that module. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Classify a canonical_name. Returns null when no rule matches — caller
 * leaves operator_type as NULL. Pure; safe to call in tests. */
export function classifyOperator(canonicalName: string): Classification | null {
  const normalized = normalizeName(canonicalName);
  for (const rule of EXACT_NAME_RULES) {
    if (normalizeName(rule.canonicalName) === normalized) {
      return { type: rule.type, reason: rule.reason };
    }
  }
  for (const pat of FOREIGN_AOC_PATTERNS) {
    if (pat.test(canonicalName)) {
      return {
        type: "foreign_aoc",
        reason: `non-US corporate form matched ${pat.source}`,
      };
    }
  }
  return null;
}

export function parseArgs(argv: string[]): { commit: boolean } {
  return { commit: argv.includes("--commit") };
}

// ── DB I/O ───────────────────────────────────────────────────────────────

interface OperatorRow {
  id: string;
  canonical_name: string;
  operator_type: OperatorType | null;
}

async function loadOperators(client: pg.PoolClient): Promise<OperatorRow[]> {
  const res = await client.query<OperatorRow>(
    `SELECT id, canonical_name, operator_type
       FROM operators
       ORDER BY canonical_name`,
  );
  return res.rows;
}

async function loadDistribution(
  client: pg.PoolClient,
): Promise<Array<{ operator_type: string | null; count: number }>> {
  const res = await client.query<{ operator_type: string | null; count: string }>(
    `SELECT operator_type, COUNT(*)::TEXT AS count
       FROM operators
       GROUP BY operator_type
       ORDER BY COUNT(*) DESC, operator_type ASC NULLS LAST`,
  );
  return res.rows.map((r) => ({ operator_type: r.operator_type, count: Number(r.count) }));
}

// ── Env load ─────────────────────────────────────────────────────────────

function loadEnv(): void {
  try {
    const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* .env not found — fine */
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

interface PlannedUpdate {
  id: string;
  name: string;
  classification: Classification;
}

function printDistribution(title: string, dist: Array<{ operator_type: string | null; count: number }>): void {
  console.log(`\n[backfill-operator-types] ${title}`);
  for (const row of dist) {
    const label = row.operator_type ?? "NULL";
    console.log(`  ${label.padEnd(14)} ${row.count}`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("operators:backfill-types requires DATABASE_TYPE=postgres");
  }
  initSentry();
  installProcessHandlers("backfill-operator-types");

  const { commit } = parseArgs(process.argv.slice(2));
  const pool = getPool();
  const client = await pool.connect();

  try {
    const before = await loadDistribution(client);
    printDistribution("Distribution BEFORE:", before);

    const rows = await loadOperators(client);
    console.log(`\n[backfill-operator-types] ${rows.length} operators loaded`);

    const plan: PlannedUpdate[] = [];
    const conflicts: Array<{ id: string; name: string; existing: string; proposed: OperatorType }> = [];
    let alreadyCorrect = 0;

    for (const row of rows) {
      const c = classifyOperator(row.canonical_name);
      if (!c) continue;
      if (row.operator_type === c.type) {
        alreadyCorrect++;
        continue;
      }
      if (row.operator_type !== null && row.operator_type !== c.type) {
        conflicts.push({
          id: row.id,
          name: row.canonical_name,
          existing: row.operator_type,
          proposed: c.type,
        });
        log.warn(
          { id: row.id, name: row.canonical_name, existing: row.operator_type, proposed: c.type },
          "operator_type already set to a different value; not overwriting",
        );
        continue;
      }
      plan.push({ id: row.id, name: row.canonical_name, classification: c });
    }

    console.log(
      `[backfill-operator-types] ${plan.length} rows to classify, ${alreadyCorrect} already correct, ${conflicts.length} conflicts skipped`,
    );

    if (plan.length > 0) {
      const byType = new Map<OperatorType, PlannedUpdate[]>();
      for (const p of plan) {
        const bucket = byType.get(p.classification.type) ?? [];
        bucket.push(p);
        byType.set(p.classification.type, bucket);
      }
      console.log(`\n[backfill-operator-types] Planned updates:`);
      for (const [type, entries] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(`  ${type} (${entries.length}):`);
        for (const e of entries) {
          console.log(`    ${e.name}   — ${e.classification.reason}`);
        }
      }
    }

    if (conflicts.length > 0) {
      console.log(`\n[backfill-operator-types] Conflicts (existing value differs from proposed):`);
      for (const c of conflicts) {
        console.log(`  ${c.name}   existing=${c.existing}  proposed=${c.proposed}`);
      }
    }

    if (!commit) {
      console.log(`\n[backfill-operator-types] DRY RUN — re-run with --commit to apply.`);
      return;
    }

    if (plan.length === 0) {
      console.log(`\n[backfill-operator-types] Nothing to write.`);
      return;
    }

    console.log(`\n[backfill-operator-types] Applying ${plan.length} updates...`);
    await client.query("BEGIN");
    try {
      for (const p of plan) {
        await client.query(
          `UPDATE operators
              SET operator_type = $1,
                  last_updated_at = NOW()
            WHERE id = $2
              AND operator_type IS NULL`,
          [p.classification.type, p.id],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }

    const after = await loadDistribution(client);
    printDistribution("Distribution AFTER:", after);
  } finally {
    client.release();
    await closePg();
    await flushSentry();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "backfill-operator-types fatal error");
    process.exit(1);
  });
}
