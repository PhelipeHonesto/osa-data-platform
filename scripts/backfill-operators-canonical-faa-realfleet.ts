/**
 * Backfill operators + operator_identities + operator_aliases from the
 * real-fleet subset of public.faa_operators.
 *
 * Stage 2b follow-up (2026-04-24). Companion to
 * scripts/backfill-operators-canonical-faa.ts, which seeded the first 50
 * real operators via a cert-shape regex filter. That regex missed the
 * rows that carry a 3-letter ICAO airline designator as certificate_number
 * (EJA, LXJ, WUP, PCH, VJA, FFL, XSR, JTL, EJM, ...) — the top-fleet
 * Part 135 operators (NetJets, Flexjet, Wheels Up, PlaneSense, Vista,
 * FlyExclusive, XO, JSX, Executive Jet Management). CP3 operator-resolver
 * walk rate stuck at ~0.05% because those operators weren't in canonical.
 *
 * This script merges the real-fleet subset by aircraft_count threshold
 * instead of cert-shape, and adds dba_name as an alias where the dba is
 * a real DBA (not an ICAO callsign).
 *
 * MODES:
 *   --threshold=N (default)  Bulk path. All faa_operators rows with
 *                            aircraft_count >= N. Existing behavior.
 *   --cert-numbers=A,B,C     Curated path (added 2026-04-25). Explicit
 *                            cert list, bypasses aircraft_count threshold.
 *                            Detects canonical-name dups against existing
 *                            public.operators rows; for matches, appends a
 *                            faa:<cert> identity to the existing operator
 *                            (preserves prior synthetic seeds for audit)
 *                            instead of creating a duplicate canonical row.
 *
 * FILTER (both modes):
 *   - TRIM(UPPER(certificate_number)) != TRIM(UPPER(name))
 *       drops co-holder duplicate rows where faa-operators-full.ts wrote
 *       the legal entity name into both fields (FLEXJET LLC, NETJETS
 *       SALES INC, WHEELS UP PARTNERS LLC, FEDERAL EXPRESS CORPORATION).
 *   - NOT EXISTS (operator_identities WHERE source='faa' AND source_id =
 *     certificate_number) — skips rows already merged by either path.
 *
 * MODE-SPECIFIC FILTER:
 *   - threshold mode: fo.aircraft_count >= threshold
 *   - cert-list mode: fo.certificate_number = ANY($cert_numbers)
 *
 * WRITES (all in public schema — operators still lives in public; future
 * ALTER TABLE ... SET SCHEMA to canonical is a one-line migration per
 * docs/phase1-followups.md "Future migration: operators schema move"):
 *   1. public.operators
 *        canonical_name = name (trimmed)
 *        type_tags = '{}'    — Phase 1 convention; CHECK forbids 'part_135'
 *        operator_type = 'part_135'
 *        data_confidence_score = 1.0
 *        first_seen_at = faa_operators.created_at (or NOW() if null)
 *   2. public.operator_identities
 *        source='faa', source_id=certificate_number, match_confidence='exact',
 *        match_method='faa_operators_realfleet_merge',
 *        match_evidence={backfill_run_id, threshold, aircraft_count,
 *                        checkpoint: 'stage-2b-followup'}
 *   3. public.operator_aliases (conditional)
 *        Insert alias_type='dba' when dba_name is present AND differs from
 *        name AND is NOT an ICAO callsign (^[A-Z]{3}$). ICAO callsigns are
 *        logged to stdout and not inserted — they're identifiers, not
 *        aliases. See docs/phase1-followups.md "Add icao_callsign column
 *        to public.operators" for the follow-up plan.
 *
 * IDEMPOTENT: operator_identities UNIQUE (source, source_id) + the
 * NOT EXISTS pre-filter make re-runs safe. operator_aliases UNIQUE
 * (operator_id, alias_normalized) uses ON CONFLICT DO NOTHING.
 *
 * ROLLBACK: schema/rollback/2026-04-24-operators-realfleet-rollback.sql,
 * filtered by the backfill_run_id printed at the end of this script.
 *
 * OUT OF SCOPE (explicitly):
 *   - No CP3 re-run. No target_companies pathway. No Firecrawl activation.
 *   - No schema migrations.
 *   - No reconciliation against existing canonical operator rows
 *     (name-collisions at canonical_name level are accepted — uniqueness
 *     is enforced at identity level only).
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:backfill-faa-realfleet
 *   DATABASE_TYPE=postgres npm run operators:backfill-faa-realfleet -- --threshold=10
 *   DATABASE_TYPE=postgres npm run operators:backfill-faa-realfleet -- --commit
 *   DATABASE_TYPE=postgres npm run operators:backfill-faa-realfleet -- --cert-numbers=SLH,KFS,LJY --commit
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getPool, closePg } from "../src/db/pg-database.js";
import { initSentry, flushSentry, installProcessHandlers } from "../src/utils/sentry.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("faa-realfleet-backfill");

const DEFAULT_THRESHOLD = 20;
const ICAO_CALLSIGN_REGEX = /^[A-Z]{3}$/;

// ── Types ────────────────────────────────────────────────────────────────

export interface RealFleetRow {
  certificate_number: string;
  name: string;
  dba_name: string | null;
  aircraft_count: number;
  state: string | null;
  city: string | null;
  created_at: string | Date | null;
}

export interface RealFleetArgs {
  commit: boolean;
  threshold: number;
  certNumbers: string[]; // empty = threshold mode; non-empty = curated cert-list mode
}

export interface OperatorInsertPayload {
  canonicalName: string;
  typeTags: string[];
  operatorType: string;
  dataConfidenceScore: number;
  firstSeenAt: Date;
}

export type AliasAction =
  | { kind: "skip_null" }
  | { kind: "skip_same_as_name" }
  | { kind: "skip_icao_callsign"; callsign: string }
  | { kind: "insert"; alias: string; aliasNormalized: string };

export type RowAction =
  | { kind: "insert_new"; row: RealFleetRow }
  | {
      kind: "merge_existing";
      row: RealFleetRow;
      existingOperatorId: string;
      existingCanonicalName: string;
    };

export type IdentityCtx =
  | { mode: "threshold"; threshold: number }
  | { mode: "cert_list"; mergedIntoExisting: boolean };

// ── Pure helpers (testable) ──────────────────────────────────────────────

export function parseCertNumbersList(value: string): string[] {
  const raw = value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  if (raw.length === 0) {
    throw new Error("--cert-numbers= requires at least one comma-separated value");
  }
  return Array.from(new Set(raw));
}

export function parseArgs(argv: string[]): RealFleetArgs {
  let threshold = DEFAULT_THRESHOLD;
  let certNumbers: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--threshold=")) {
      const n = Number(arg.slice("--threshold=".length));
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`invalid --threshold value: ${arg}`);
      }
      threshold = Math.floor(n);
    } else if (arg.startsWith("--cert-numbers=")) {
      certNumbers = parseCertNumbersList(arg.slice("--cert-numbers=".length));
    }
  }
  return { commit: argv.includes("--commit"), threshold, certNumbers };
}

export function isIcaoCallsign(s: string): boolean {
  return ICAO_CALLSIGN_REGEX.test(s);
}

/**
 * Matches the operator_aliases.alias_normalized convention used in
 * scripts/fix-canonical-name.ts and scripts/dedup-operator-rows.ts.
 */
export function normalizeAlias(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function decideAliasAction(dbaName: string | null, name: string): AliasAction {
  if (dbaName === null) return { kind: "skip_null" };
  const trimmed = dbaName.trim();
  if (trimmed === "") return { kind: "skip_null" };
  if (trimmed === name.trim()) return { kind: "skip_same_as_name" };
  if (isIcaoCallsign(trimmed)) return { kind: "skip_icao_callsign", callsign: trimmed };
  return { kind: "insert", alias: trimmed, aliasNormalized: normalizeAlias(trimmed) };
}

export function buildOperatorPayload(row: RealFleetRow): OperatorInsertPayload {
  const firstSeenAt =
    row.created_at instanceof Date
      ? row.created_at
      : row.created_at
        ? new Date(row.created_at)
        : new Date();
  return {
    canonicalName: row.name.trim(),
    typeTags: [],
    operatorType: "part_135",
    dataConfidenceScore: 1.0,
    firstSeenAt,
  };
}

export function buildIdentityEvidence(
  row: RealFleetRow,
  runId: string,
  ctx: IdentityCtx,
): Record<string, unknown> {
  const base = {
    backfill_run_id: runId,
    aircraft_count: row.aircraft_count,
  };
  if (ctx.mode === "threshold") {
    return { ...base, checkpoint: "stage-2b-followup", threshold: ctx.threshold };
  }
  // cert_list mode — only attach merged_into_existing when true so the
  // evidence stays compact for the common (insert_new) case.
  return ctx.mergedIntoExisting
    ? { ...base, checkpoint: "stage-2b-followup-curated", merged_into_existing: true }
    : { ...base, checkpoint: "stage-2b-followup-curated" };
}

// ── DB I/O ───────────────────────────────────────────────────────────────

async function loadRealFleetCandidates(
  client: pg.PoolClient,
  args: RealFleetArgs,
): Promise<RealFleetRow[]> {
  if (args.certNumbers.length > 0) {
    const res = await client.query<RealFleetRow>(
      `SELECT fo.certificate_number,
              fo.name,
              fo.dba_name,
              fo.aircraft_count,
              fo.state,
              fo.city,
              fo.created_at
       FROM public.faa_operators fo
       WHERE fo.certificate_number = ANY($1::TEXT[])
         AND TRIM(UPPER(fo.certificate_number)) != TRIM(UPPER(fo.name))
         AND NOT EXISTS (
           SELECT 1 FROM public.operator_identities oi
           WHERE oi.source = 'faa' AND oi.source_id = fo.certificate_number
         )
       ORDER BY fo.aircraft_count DESC NULLS LAST, fo.certificate_number`,
      [args.certNumbers],
    );
    return res.rows.map((r) => ({ ...r, aircraft_count: Number(r.aircraft_count) }));
  }
  const res = await client.query<RealFleetRow>(
    `SELECT fo.certificate_number,
            fo.name,
            fo.dba_name,
            fo.aircraft_count,
            fo.state,
            fo.city,
            fo.created_at
     FROM public.faa_operators fo
     WHERE fo.aircraft_count >= $1
       AND TRIM(UPPER(fo.certificate_number)) != TRIM(UPPER(fo.name))
       AND NOT EXISTS (
         SELECT 1 FROM public.operator_identities oi
         WHERE oi.source = 'faa' AND oi.source_id = fo.certificate_number
       )
     ORDER BY fo.aircraft_count DESC, fo.certificate_number`,
    [args.threshold],
  );
  return res.rows.map((r) => ({ ...r, aircraft_count: Number(r.aircraft_count) }));
}

async function lookupExistingOperatorByName(
  client: pg.PoolClient,
  name: string,
): Promise<{ id: string; canonical_name: string } | null> {
  const res = await client.query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name
       FROM public.operators
      WHERE TRIM(UPPER(canonical_name)) = TRIM(UPPER($1))
      LIMIT 1`,
    [name],
  );
  return res.rows[0] ?? null;
}

async function planActions(
  client: pg.PoolClient,
  rows: RealFleetRow[],
  certListMode: boolean,
): Promise<RowAction[]> {
  const actions: RowAction[] = [];
  for (const row of rows) {
    if (!certListMode) {
      // threshold mode preserves existing behavior — no dup detection
      actions.push({ kind: "insert_new", row });
      continue;
    }
    const existing = await lookupExistingOperatorByName(client, row.name);
    if (existing) {
      actions.push({
        kind: "merge_existing",
        row,
        existingOperatorId: existing.id,
        existingCanonicalName: existing.canonical_name,
      });
    } else {
      actions.push({ kind: "insert_new", row });
    }
  }
  return actions;
}

interface WriteCounts {
  operators: number;
  identitiesNew: number;
  identitiesMerged: number;
  aliases: number;
  skippedIcao: number;
  skippedNull: number;
  skippedSame: number;
}

async function writeOneAction(
  client: pg.PoolClient,
  action: RowAction,
  runId: string,
  ctxBase: IdentityCtx,
  counts: WriteCounts,
): Promise<void> {
  const row = action.row;
  let operatorId: string;
  let evidenceCtx: IdentityCtx;
  let aliasInsertEnabled: boolean;

  if (action.kind === "merge_existing") {
    operatorId = action.existingOperatorId;
    // cert_list mode is the only path that produces merge actions
    evidenceCtx = { mode: "cert_list", mergedIntoExisting: true };
    // Don't write an alias for a merged-into-existing operator: the
    // existing canonical row may already carry aliases, and this row's
    // dba is almost always the ICAO callsign anyway. Leave alias state
    // to a dedicated audit pass.
    aliasInsertEnabled = false;
  } else {
    const payload = buildOperatorPayload(row);
    const opsRes = await client.query<{ id: string }>(
      `INSERT INTO public.operators
         (canonical_name, type_tags, operator_type, data_confidence_score, first_seen_at)
       VALUES ($1, $2::TEXT[], $3, $4, $5)
       RETURNING id`,
      [
        payload.canonicalName,
        payload.typeTags,
        payload.operatorType,
        payload.dataConfidenceScore,
        payload.firstSeenAt,
      ],
    );
    const newId = opsRes.rows[0]?.id;
    if (!newId) {
      throw new Error(`operators INSERT returned no id for ${row.certificate_number}`);
    }
    operatorId = newId;
    counts.operators += 1;
    evidenceCtx =
      ctxBase.mode === "cert_list"
        ? { mode: "cert_list", mergedIntoExisting: false }
        : { mode: "threshold", threshold: ctxBase.threshold };
    aliasInsertEnabled = true;
  }

  const evidence = buildIdentityEvidence(row, runId, evidenceCtx);
  const idRes = await client.query(
    `INSERT INTO public.operator_identities
       (operator_id, source, source_id, name_as_provided,
        match_confidence, match_method, match_evidence)
     VALUES ($1, 'faa', $2, $3, 'exact', 'faa_operators_realfleet_merge', $4::jsonb)`,
    [operatorId, row.certificate_number, row.name, JSON.stringify(evidence)],
  );
  if (action.kind === "merge_existing") {
    counts.identitiesMerged += idRes.rowCount ?? 0;
  } else {
    counts.identitiesNew += idRes.rowCount ?? 0;
  }

  const aliasDecision = decideAliasAction(row.dba_name, row.name);
  switch (aliasDecision.kind) {
    case "skip_null":
      counts.skippedNull += 1;
      break;
    case "skip_same_as_name":
      counts.skippedSame += 1;
      break;
    case "skip_icao_callsign":
      counts.skippedIcao += 1;
      console.log(
        `[faa-realfleet] ICAO callsign skipped (not an alias): ${row.name} -> ${aliasDecision.callsign}`,
      );
      break;
    case "insert": {
      if (!aliasInsertEnabled) break;
      const aliasRes = await client.query(
        `INSERT INTO public.operator_aliases
           (operator_id, alias, alias_normalized, alias_type, source)
         VALUES ($1, $2, $3, 'dba', 'faa_operators_realfleet')
         ON CONFLICT (operator_id, alias_normalized) DO NOTHING`,
        [operatorId, aliasDecision.alias, aliasDecision.aliasNormalized],
      );
      counts.aliases += aliasRes.rowCount ?? 0;
      break;
    }
  }
}

// ── Env load (same pattern as sibling scripts) ──────────────────────────

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
    // .env absent — env may be set directly
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("operators:backfill-faa-realfleet requires DATABASE_TYPE=postgres");
  }

  initSentry();
  installProcessHandlers("faa-realfleet-backfill");

  const args = parseArgs(process.argv.slice(2));
  const { commit, threshold, certNumbers } = args;
  const certListMode = certNumbers.length > 0;
  const runId = randomUUID();
  const t0 = Date.now();

  if (certListMode) {
    console.log(
      `[faa-realfleet] mode=cert_list  certs=[${certNumbers.join(",")}]  commit=${commit}  run_id=${runId}`,
    );
  } else {
    console.log(
      `[faa-realfleet] mode=threshold  threshold=${threshold}  commit=${commit}  run_id=${runId}`,
    );
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    const rows = await loadRealFleetCandidates(client, args);
    console.log(`[faa-realfleet] Candidate rows: ${rows.length}`);
    if (rows.length === 0) {
      console.log(`[faa-realfleet] Nothing to write. Exiting.`);
      await closePg();
      await flushSentry();
      return;
    }

    if (certListMode) {
      const requested = new Set(certNumbers);
      const found = new Set(rows.map((r) => r.certificate_number));
      const missing = [...requested].filter((c) => !found.has(c));
      if (missing.length > 0) {
        console.log(
          `[faa-realfleet] WARNING: ${missing.length} requested cert(s) not loaded (already merged, or filtered by cert!=name): ${missing.join(",")}`,
        );
      }
    }

    const actions = await planActions(client, rows, certListMode);
    const planSummary = { insert_new: 0, merge_existing: 0 };
    console.log(`[faa-realfleet] Action plan:`);
    actions.forEach((a, i) => {
      const r = a.row;
      if (a.kind === "merge_existing") {
        planSummary.merge_existing += 1;
        console.log(
          `  ${i + 1}. MERGE  cert=${r.certificate_number}  aircraft=${r.aircraft_count}  name='${r.name}' → existing operator ${a.existingOperatorId} (canonical='${a.existingCanonicalName}')`,
        );
      } else {
        planSummary.insert_new += 1;
        console.log(
          `  ${i + 1}. NEW    cert=${r.certificate_number}  aircraft=${r.aircraft_count}  name='${r.name}'  dba=${r.dba_name ?? "NULL"}  state=${r.state ?? "NULL"}`,
        );
      }
    });
    console.log(
      `[faa-realfleet] Plan summary: ${planSummary.insert_new} new operator(s), ${planSummary.merge_existing} identity merge(s) into existing canonical row(s)`,
    );

    const aliasPreview = { insert: 0, skip_icao: 0, skip_null: 0, skip_same: 0 };
    for (const a of actions) {
      // alias inserts only happen on insert_new path; for merge_existing
      // we hold off (see writeOneAction comment)
      if (a.kind === "merge_existing") {
        aliasPreview.skip_icao += 1; // count under skip_icao for visibility
        continue;
      }
      const d = decideAliasAction(a.row.dba_name, a.row.name);
      if (d.kind === "insert") aliasPreview.insert += 1;
      else if (d.kind === "skip_icao_callsign") aliasPreview.skip_icao += 1;
      else if (d.kind === "skip_null") aliasPreview.skip_null += 1;
      else aliasPreview.skip_same += 1;
    }
    console.log(
      `[faa-realfleet] Alias plan: ${aliasPreview.insert} insert, ${aliasPreview.skip_icao} skip ICAO/merge, ${aliasPreview.skip_null} skip null, ${aliasPreview.skip_same} skip dba==name`,
    );

    if (!commit) {
      console.log(`[faa-realfleet] Dry run complete. Pass --commit to write.`);
      await closePg();
      await flushSentry();
      return;
    }

    const counts: WriteCounts = {
      operators: 0,
      identitiesNew: 0,
      identitiesMerged: 0,
      aliases: 0,
      skippedIcao: 0,
      skippedNull: 0,
      skippedSame: 0,
    };

    const ctxBase: IdentityCtx = certListMode
      ? { mode: "cert_list", mergedIntoExisting: false }
      : { mode: "threshold", threshold };

    console.log(`[faa-realfleet] Writing in a single transaction...`);
    await client.query("BEGIN");
    try {
      for (const action of actions) {
        await writeOneAction(client, action, runId, ctxBase, counts);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }

    const dtSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[faa-realfleet] Inserted ${counts.operators} new operators, ${counts.identitiesNew} new identities, ${counts.identitiesMerged} merged identities, ${counts.aliases} aliases`,
    );
    console.log(
      `[faa-realfleet] Skipped aliases: ${counts.skippedIcao} ICAO/merge, ${counts.skippedNull} null, ${counts.skippedSame} dba==name`,
    );
    console.log(`[faa-realfleet] backfill_run_id=${runId}`);
    const rollbackFile = certListMode
      ? "schema/rollback/2026-04-25-operators-curated-rollback.sql"
      : "schema/rollback/2026-04-24-operators-realfleet-rollback.sql";
    console.log(
      `[faa-realfleet] Rollback: psql "$SUPABASE_DATABASE_URL" -v run_id='${runId}' -f ${rollbackFile}`,
    );
    console.log(`[faa-realfleet] Done. ${dtSec}s`);
  } finally {
    client.release();
    await closePg();
    await flushSentry();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "faa-realfleet-backfill fatal error");
    process.exit(1);
  });
}
