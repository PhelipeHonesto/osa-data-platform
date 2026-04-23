/**
 * Fix a single canonical_name on the operators table.
 *
 * This script corrects OSA's canonical record when the ingested name was
 * wrong — typically a typo that propagated in from FAA's legal-name field
 * (Phase 1 calibration finding #3: "Premiere Private Jets" vs the correct
 * "Premier Private Jets"). NOT a rebrand handler: if a real operator
 * actually renamed themselves, that's a Stage 3 concern (REBRANDED_TO
 * edge + Two-Source Rule) and should never route through this script.
 *
 * Behaviour:
 *   1. Locate operator by --id (UUID). Never by name match — too fragile.
 *   2. UPDATE operators SET canonical_name = <new>, last_updated_at = NOW()
 *   3. INSERT operator_aliases capturing the OLD name as alias_type='historical'
 *      with source='faa_registry' — preserves the claim that this variant
 *      used to be recorded (and, for our flagship case, still is the FAA
 *      legal-name value; we've diverged deliberately).
 *   4. All inside one transaction.
 *
 * No trust-score recompute needed — canonical_name doesn't feed either
 * score's inputs (source reliability / freshness / agreement / completeness
 * / accidents / source count / identity stability). Just the name changes.
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:fix-name -- \
 *     --id <uuid> --new-name 'Premier Private Jets'              # dry run
 *   DATABASE_TYPE=postgres npm run operators:fix-name -- \
 *     --id <uuid> --new-name 'Premier Private Jets' --commit
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getPool, closePg } from "../src/db/pg-database.js";
import { initSentry, flushSentry, installProcessHandlers } from "../src/utils/sentry.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("fix-canonical-name");

// ── Types ────────────────────────────────────────────────────────────────

export interface FixArgs {
  id: string;
  newName: string;
  /** Value for the new alias row's `source` column — defaults to 'faa_registry'
   * because that's the origin of our typo case. Override via --alias-source
   * for future typo fixes that didn't come from FAA. */
  aliasSource: string;
  commit: boolean;
}

// ── Pure helpers (testable) ──────────────────────────────────────────────

export function parseArgs(argv: string[]): FixArgs {
  let id = "";
  let newName = "";
  let aliasSource = "faa_registry";
  let commit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id" && argv[i + 1]) id = argv[++i]!;
    else if (a === "--new-name" && argv[i + 1]) newName = argv[++i]!;
    else if (a === "--alias-source" && argv[i + 1]) aliasSource = argv[++i]!;
    else if (a === "--commit") commit = true;
  }
  return { id, newName, aliasSource, commit };
}

export function validateArgs(args: FixArgs): string | null {
  if (!args.id) return "missing --id <uuid>";
  if (!args.newName.trim()) return "missing --new-name <string>";
  return null;
}

/**
 * Normalization matching operator_aliases.alias_normalized convention:
 * trim, lowercase, collapse interior whitespace. Identical to the helper
 * in dedup-operator-rows / operators-review so UNIQUE lookups line up.
 */
export function normalizeAlias(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── DB I/O ───────────────────────────────────────────────────────────────

interface OperatorRow {
  id: string;
  canonical_name: string;
}

async function loadOperator(client: pg.PoolClient, id: string): Promise<OperatorRow | null> {
  const res = await client.query<OperatorRow>(
    `SELECT id, canonical_name FROM operators WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export interface FixResult {
  old_name: string;
  new_name: string;
  alias_inserted: boolean;
  /** True when the (operator_id, alias_normalized) already existed; the
   * INSERT is skipped and no harm done. */
  alias_already_existed: boolean;
}

export async function applyFix(
  client: pg.PoolClient,
  args: FixArgs,
  existing: OperatorRow,
): Promise<FixResult> {
  const oldName = existing.canonical_name;
  const newName = args.newName.trim();

  await client.query("BEGIN");
  try {
    await client.query(
      `UPDATE operators
          SET canonical_name = $1,
              last_updated_at = NOW()
        WHERE id = $2`,
      [newName, args.id],
    );

    const aliasRes = await client.query<{ id: number }>(
      `INSERT INTO operator_aliases
         (operator_id, alias, alias_normalized, alias_type, source)
       VALUES ($1, $2, $3, 'historical', $4)
       ON CONFLICT (operator_id, alias_normalized) DO NOTHING
       RETURNING id`,
      [args.id, oldName, normalizeAlias(oldName), args.aliasSource],
    );
    const inserted = (aliasRes.rowCount ?? 0) > 0;

    await client.query("COMMIT");
    return {
      old_name: oldName,
      new_name: newName,
      alias_inserted: inserted,
      alias_already_existed: !inserted,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
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

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("operators:fix-name requires DATABASE_TYPE=postgres");
  }
  initSentry();
  installProcessHandlers("fix-canonical-name");

  const args = parseArgs(process.argv.slice(2));
  const err = validateArgs(args);
  if (err) {
    console.error(`[fix-name] ${err}`);
    console.error(
      `Usage: npm run operators:fix-name -- --id <uuid> --new-name '<string>' [--alias-source <string>] [--commit]`,
    );
    process.exit(2);
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    const existing = await loadOperator(client, args.id);
    if (!existing) throw new Error(`no operator with id=${args.id}`);

    const newName = args.newName.trim();
    if (existing.canonical_name === newName) {
      console.log(`[fix-name] canonical_name is already '${newName}'. Nothing to do.`);
      return;
    }

    console.log(`\n[fix-name] Target:`);
    console.log(`  id:         ${existing.id}`);
    console.log(`  old_name:   ${existing.canonical_name}`);
    console.log(`  new_name:   ${newName}`);
    console.log(`  new alias:  '${existing.canonical_name}' (type=historical, source=${args.aliasSource})`);

    if (!args.commit) {
      console.log(`\n[fix-name] DRY RUN — re-run with --commit to apply.`);
      return;
    }

    const result = await applyFix(client, args, existing);
    console.log(`\n[fix-name] Applied:`);
    console.log(`  canonical_name:  '${result.old_name}' → '${result.new_name}'`);
    console.log(
      `  alias:           ${result.alias_inserted ? "inserted" : "already existed (skipped)"}`,
    );
  } finally {
    client.release();
    await closePg();
    await flushSentry();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "fix-canonical-name fatal error");
    process.exit(1);
  });
}
