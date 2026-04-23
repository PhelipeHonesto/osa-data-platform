/**
 * Safety Ratings Ingestion — ARGUS, Wyvern, IS-BAO ratings for operators
 *
 * Accepts a JSON file of safety ratings, fuzzy-matches operator names against
 * faa_operators, updates ratings, and propagates safety scores to the
 * knowledge_graph for ghost candidate enrichment.
 *
 * Safety score mapping:
 *   0 = unrated
 *   1 = ARGUS Gold
 *   2 = ARGUS Gold Plus / Wyvern Wingman (without ARGUS Platinum+)
 *   3 = ARGUS Platinum / IS-BAO Stage 2+
 *   4 = ARGUS Platinum Elite
 *
 * Usage:
 *   npm run ingest:safety                                     # uses default seed
 *   npm run ingest:safety -- /path/to/ratings.json            # custom file
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase, setPgBridge } from "../db/database.js";
import { getPgBridge, closePg } from "../db/pg-database.js";
import { childLogger } from "../utils/logger.js";
import { fuzzyMatch } from "./safety-ratings-fuzzy.js";

const log = childLogger("safety-ratings");

// ── Types ─────────────────────────────────────────────────────────────────

interface RatingInput {
  operator_name: string;
  argus_rating?: "gold" | "gold_plus" | "platinum" | "platinum_elite" | null;
  wyvern_rating?: "wingman" | null;
  is_bao_stage?: 1 | 2 | 3 | null;
}

/** Compute safety score from ratings */
function computeSafetyScore(
  argus: string | null,
  wyvern: string | null,
  isBao: number | null,
): number {
  if (argus === "platinum_elite") return 4;
  if (argus === "platinum" || (isBao != null && isBao >= 2)) return 3;
  if (argus === "gold_plus" || wyvern === "wingman") return 2;
  if (argus === "gold") return 1;
  return 0;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "safety-ratings requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  const args = process.argv.slice(2);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const defaultSeed = resolve(__dirname, "..", "..", "data", "seeds", "safety-ratings.json");
  const filePath = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : defaultSeed;

  console.log(`[safety] Loading ratings from: ${filePath}`);
  const raw = readFileSync(filePath, "utf-8");
  const ratings: RatingInput[] = JSON.parse(raw);
  console.log(`[safety] Parsed ${ratings.length} rating entries`);

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  // ── Load all operators for matching ─────────────────────────────────

  const allOperators = await db.prepare(
    `SELECT certificate_number, name FROM faa_operators`,
  ).all() as Array<{ certificate_number: string; name: string }>;

  console.log(`[safety] ${allOperators.length} operators in database for matching`);

  // ── Match and update ────────────────────────────────────────────────

  const updateOp = db.prepare(
    `UPDATE faa_operators
     SET argus_rating = ?, wyvern_rating = ?, is_bao_stage = ?, safety_verified_at = ?
     WHERE certificate_number = ?`,
  );

  let matched = 0;
  let unmatched = 0;
  const matchedCerts = new Set<string>();

  for (const rating of ratings) {
    const inputName = rating.operator_name.trim();
    if (!inputName) continue;

    // Find matching operators (may match multiple — e.g., "NetJets" matches both EJA and NETJETS SALES INC)
    const matches = allOperators.filter((op) => fuzzyMatch(inputName, op.name));

    if (matches.length === 0) {
      console.log(`  [miss] ${inputName}`);
      unmatched++;
      continue;
    }

    for (const match of matches) {
      await updateOp.run(
        rating.argus_rating ?? null,
        rating.wyvern_rating ?? null,
        rating.is_bao_stage ?? null,
        now,
        match.certificate_number,
      );
      matchedCerts.add(match.certificate_number);
    }

    matched++;
    if (matches.length > 1) {
      console.log(`  [multi] ${inputName} → ${matches.length} operators: ${matches.map((m) => m.name).join(", ")}`);
    }
  }
  console.log(`\n[safety] Matched ${matched}/${ratings.length} rating entries (${unmatched} unmatched)`);
  console.log(`[safety] Updated ${matchedCerts.size} operator records`);

  // ── Propagate to knowledge_graph ────────────────────────────────────

  console.log("[safety] Propagating safety scores to knowledge_graph...");

  // Update knowledge_graph via operator_name join to faa_operators
  const propagate = db.prepare(
    `UPDATE knowledge_graph
     SET operator_argus = (
       SELECT o.argus_rating FROM faa_operators o
       WHERE o.name = knowledge_graph.operator_name
         AND o.argus_rating IS NOT NULL
       LIMIT 1
     ),
     operator_wyvern = (
       SELECT o.wyvern_rating FROM faa_operators o
       WHERE o.name = knowledge_graph.operator_name
         AND o.wyvern_rating IS NOT NULL
       LIMIT 1
     ),
     operator_safety_score = COALESCE((
       SELECT CASE
         WHEN o.argus_rating = 'platinum_elite' THEN 4
         WHEN o.argus_rating = 'platinum' OR (o.is_bao_stage IS NOT NULL AND o.is_bao_stage >= 2) THEN 3
         WHEN o.argus_rating = 'gold_plus' OR o.wyvern_rating = 'wingman' THEN 2
         WHEN o.argus_rating = 'gold' THEN 1
         ELSE 0
       END
       FROM faa_operators o
       WHERE o.name = knowledge_graph.operator_name
         AND (o.argus_rating IS NOT NULL OR o.wyvern_rating IS NOT NULL)
       LIMIT 1
     ), 0)
     WHERE operator_name IS NOT NULL AND operator_name != '' AND operator_name != '-'`,
  );

  const propResult = await propagate.run() as { changes: number };
  console.log(`[safety] Updated ${propResult.changes} knowledge_graph rows`);

  // Also try fuzzy matching: match KG operator_name that CONTAINS a rated operator name
  const ratedOperators = await db.prepare(
    `SELECT name, argus_rating, wyvern_rating, is_bao_stage FROM faa_operators
     WHERE argus_rating IS NOT NULL OR wyvern_rating IS NOT NULL`,
  ).all() as Array<{
    name: string; argus_rating: string | null;
    wyvern_rating: string | null; is_bao_stage: number | null;
  }>;

  const fuzzyUpdate = db.prepare(
    `UPDATE knowledge_graph SET operator_argus = ?, operator_wyvern = ?, operator_safety_score = ?
     WHERE operator_name LIKE ? AND operator_safety_score = 0`,
  );

  let fuzzyUpdated = 0;
  for (const op of ratedOperators) {
    const score = computeSafetyScore(op.argus_rating, op.wyvern_rating, op.is_bao_stage);
    // Match "NETJETS SALES INC, BUFFETT WARREN E" → contains "NETJETS"
    const pattern = `%${op.name}%`;
    const result = await fuzzyUpdate.run(op.argus_rating, op.wyvern_rating, score, pattern) as { changes: number };
    fuzzyUpdated += result.changes;
  }

  if (fuzzyUpdated > 0) {
    console.log(`[safety] Fuzzy-matched ${fuzzyUpdated} additional knowledge_graph rows`);
  }

  // ── Report ──────────────────────────────────────────────────────────

  const totalOps = ((await db.prepare("SELECT COUNT(*) as cnt FROM faa_operators").get()) as { cnt: number }).cnt;
  const ratedOps = ((await db.prepare(
    "SELECT COUNT(*) as cnt FROM faa_operators WHERE argus_rating IS NOT NULL OR wyvern_rating IS NOT NULL",
  ).get()) as { cnt: number }).cnt;

  const byArgus = await db.prepare(
    `SELECT argus_rating, COUNT(*) as cnt FROM faa_operators
     WHERE argus_rating IS NOT NULL GROUP BY argus_rating ORDER BY cnt DESC`,
  ).all() as Array<{ argus_rating: string; cnt: number }>;

  const byWyvern = ((await db.prepare(
    "SELECT COUNT(*) as cnt FROM faa_operators WHERE wyvern_rating = 'wingman'",
  ).get()) as { cnt: number }).cnt;

  // Ghost candidates by safety tier
  const ghostsByTier = await db.prepare(
    `SELECT
       operator_safety_score as score,
       COUNT(*) as cnt
     FROM knowledge_graph
     WHERE state = 'idle_transient' AND idle_hours >= 6
     GROUP BY operator_safety_score
     ORDER BY score DESC`,
  ).all() as Array<{ score: number; cnt: number }>;

  const totalGhosts = await db.prepare(
    `SELECT COUNT(*) as cnt FROM knowledge_graph WHERE state = 'idle_transient' AND idle_hours >= 6`,
  ).get() as { cnt: number };

  // Ghost candidates with safety detail
  const ghostDetail = await db.prepare(
    `SELECT tail_number, operator_name, aircraft_class, nearest_airport,
            ROUND(idle_hours, 1) as idle_hours,
            operator_argus, operator_wyvern, operator_safety_score
     FROM knowledge_graph
     WHERE state = 'idle_transient' AND idle_hours >= 6
     ORDER BY operator_safety_score DESC, idle_hours DESC`,
  ).all() as Array<{
    tail_number: string; operator_name: string; aircraft_class: string;
    nearest_airport: string; idle_hours: number;
    operator_argus: string | null; operator_wyvern: string | null;
    operator_safety_score: number;
  }>;

  // KG safety coverage
  const kgTotal = ((await db.prepare("SELECT COUNT(*) as cnt FROM knowledge_graph WHERE operator_name IS NOT NULL AND operator_name != ''").get()) as { cnt: number }).cnt;
  const kgRated = ((await db.prepare("SELECT COUNT(*) as cnt FROM knowledge_graph WHERE operator_safety_score > 0").get()) as { cnt: number }).cnt;

  const tierName = (score: number) =>
    score === 4 ? "Platinum Elite" :
    score === 3 ? "Platinum/IS-BAO" :
    score === 2 ? "Gold Plus/Wingman" :
    score === 1 ? "Gold" : "Unrated";

  console.log(`\n═══ Safety Ratings Report ═══`);
  console.log(`Operators rated:  ${ratedOps} / ${totalOps}`);
  console.log(`\n── ARGUS Distribution ──`);
  for (const row of byArgus) {
    console.log(`  ${row.argus_rating.padEnd(16)} ${row.cnt}`);
  }
  console.log(`  ${"wyvern_wingman".padEnd(16)} ${byWyvern}`);

  console.log(`\n── Knowledge Graph Coverage ──`);
  console.log(`  Aircraft with safety score: ${kgRated.toLocaleString()} / ${kgTotal.toLocaleString()}`);

  console.log(`\n── Ghost Candidates by Safety Tier ──`);
  console.log(`  Total ghosts: ${totalGhosts.cnt}`);
  for (const row of ghostsByTier) {
    console.log(`  ${tierName(row.score).padEnd(20)} ${row.cnt}`);
  }

  if (ghostDetail.length > 0) {
    console.log(`\n── Ghost Candidate Detail ──`);
    console.log(`${"Tail".padEnd(10)} ${"Operator".padEnd(35)} ${"Class".padEnd(12)} ${"Airport".padEnd(8)} ${"Idle".padEnd(8)} Safety`);
    console.log("─".repeat(95));
    for (const g of ghostDetail) {
      const safety = g.operator_safety_score > 0
        ? `${tierName(g.operator_safety_score)}${g.operator_argus ? ` (ARGUS ${g.operator_argus})` : ""}`
        : "Unrated";
      console.log(
        `${(g.tail_number ?? "").padEnd(10)} ${(g.operator_name ?? "").slice(0, 35).padEnd(35)} ${(g.aircraft_class ?? "").padEnd(12)} ${(g.nearest_airport ?? "").padEnd(8)} ${String(g.idle_hours ?? 0).padEnd(8)} ${safety}`,
      );
    }
  }

  await closePg();
  console.log(`\n[safety] Done.`);
}

main().catch((err) => {
  log.fatal({ err }, "safety-ratings fatal error");
  process.exit(1);
});
