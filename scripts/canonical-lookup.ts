/**
 * canonical_lookup — V4.1 helper for the LLM-ER pass agent.
 *
 * Purpose
 *   The V4 prompt's F7 hint ("successor exists IRL but not in candidate
 *   pool") was a flag, not an ER answer. V4.1 closes that gap: when
 *   research surfaces a successor entity (acquirer, rebrand target,
 *   parent brand), the agent calls this lookup to check whether that
 *   successor already exists in our canonical operators table. If it
 *   does, the decision becomes match + rebrand_outside_pool /
 *   acquisition_outside_pool with the canonical operator_id, instead
 *   of ambiguous-F7.
 *
 * Usage (invoked by the agent via Bash)
 *   npx tsx scripts/canonical-lookup.ts <query>
 *   npx tsx scripts/canonical-lookup.ts --entity=operator <query>   (default)
 *   → JSON object on stdout: {entity_type, query, n_results, results: [...max 5]}
 *
 * Generalizes — entity_type defaults to 'operator'. Future entity types
 * (aircraft, fbo, airport, person) plug in here as additional branches.
 *
 * Match strength (high → low)
 *   1.00  exact_canonical_name           (case-insensitive equality)
 *   0.90  exact_alias                    (alias.alias matches exactly)
 *   0.80  prefix_canonical_name          (canonical starts with query, ≥3 chars)
 *   0.70  prefix_alias
 *   0.50  contains_canonical_name        (ILIKE %query% on canonical)
 *   0.40  contains_alias
 *
 * Notes for the agent (these are also in the V4.1 prompt)
 *   - Lookup is for RESEARCH-IDENTIFIED SUCCESSOR ENTITIES ONLY.
 *     Do not call this on the holder name itself (that bypasses the
 *     hidden-mode test design).
 *   - 0 results means the successor isn't in canonical → F7 still applies.
 *   - 1+ result with strength ≥ 0.80 is a strong canonical hit;
 *     verify operator_type and disambiguate via verbatim citations
 *     before deciding. Generic-name false positives happen
 *     (e.g. "Elevate" matches Elevate Jet, Elevated Aviation, Joby Elevate).
 */

import "dotenv/config";
import pg from "pg";

const QUERY_MIN_LEN = 3;
const MAX_RESULTS = 5;

interface LookupResult {
  id: string;
  canonical_name: string;
  operator_type: string | null;
  match_via: "canonical_name" | "alias";
  match_strength: number;
  // When match_via='alias', show which alias hit so the agent can sanity-check.
  matched_alias?: string;
}

function getPool(): pg.Pool {
  const cs = process.env["SUPABASE_DATABASE_URL"];
  if (!cs) {
    console.error("SUPABASE_DATABASE_URL not set");
    process.exit(2);
  }
  return new pg.Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
  });
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

async function lookup(rawQuery: string): Promise<LookupResult[]> {
  const q = normalize(rawQuery);
  if (q.length < QUERY_MIN_LEN) {
    return [];
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    const sql = `
      WITH q AS (SELECT $1::text AS raw, UPPER($1::text) AS upper_raw),
      canonical_hits AS (
        SELECT
          o.id::text                        AS id,
          o.canonical_name                  AS canonical_name,
          o.operator_type                   AS operator_type,
          'canonical_name'::text            AS match_via,
          NULL::text                        AS matched_alias,
          CASE
            WHEN UPPER(o.canonical_name) = (SELECT upper_raw FROM q)             THEN 1.00
            WHEN UPPER(o.canonical_name) LIKE (SELECT upper_raw FROM q) || '%'   THEN 0.80
            WHEN UPPER(o.canonical_name) LIKE '%' || (SELECT upper_raw FROM q) || '%' THEN 0.50
            ELSE 0
          END                               AS match_strength
        FROM public.operators o
        WHERE UPPER(o.canonical_name) LIKE '%' || (SELECT upper_raw FROM q) || '%'
      ),
      alias_hits AS (
        SELECT
          a.operator_id::text               AS id,
          o.canonical_name                  AS canonical_name,
          o.operator_type                   AS operator_type,
          'alias'::text                     AS match_via,
          a.alias                           AS matched_alias,
          CASE
            WHEN UPPER(a.alias) = (SELECT upper_raw FROM q)             THEN 0.90
            WHEN UPPER(a.alias) LIKE (SELECT upper_raw FROM q) || '%'   THEN 0.70
            WHEN UPPER(a.alias) LIKE '%' || (SELECT upper_raw FROM q) || '%' THEN 0.40
            ELSE 0
          END                               AS match_strength
        FROM public.operator_aliases a
        JOIN public.operators o ON o.id = a.operator_id
        WHERE UPPER(a.alias) LIKE '%' || (SELECT upper_raw FROM q) || '%'
      ),
      combined AS (
        SELECT * FROM canonical_hits WHERE match_strength > 0
        UNION ALL
        SELECT * FROM alias_hits     WHERE match_strength > 0
      ),
      -- For each operator id, keep the strongest match
      ranked AS (
        SELECT DISTINCT ON (id)
               id, canonical_name, operator_type,
               match_via, matched_alias, match_strength
          FROM combined
         ORDER BY id, match_strength DESC, match_via ASC
      )
      SELECT id, canonical_name, operator_type, match_via, matched_alias, match_strength
        FROM ranked
       ORDER BY match_strength DESC, canonical_name ASC
       LIMIT ${MAX_RESULTS};
    `;
    const res = await client.query<{
      id: string;
      canonical_name: string;
      operator_type: string | null;
      match_via: "canonical_name" | "alias";
      matched_alias: string | null;
      match_strength: string;
    }>(sql, [q]);

    return res.rows.map((r) => {
      const out: LookupResult = {
        id: r.id,
        canonical_name: r.canonical_name,
        operator_type: r.operator_type,
        match_via: r.match_via,
        match_strength: parseFloat(r.match_strength),
      };
      if (r.matched_alias) out.matched_alias = r.matched_alias;
      return out;
    });
  } finally {
    client.release();
    await pool.end();
  }
}

type EntityType = "operator";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.error("Usage: canonical-lookup.ts [--entity=operator] <query>");
    console.error("  query:  search string (≥3 chars)");
    console.error("  entity: 'operator' (default). Future: aircraft, fbo, person.");
    console.error("  output: {entity_type, query, n_results, results: [...]} as JSON");
    process.exit(1);
  }

  let entityType: EntityType = "operator";
  const queryParts: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--entity=")) {
      const e = a.slice("--entity=".length);
      if (e !== "operator") {
        console.error(`unsupported entity_type: ${e} (only 'operator' implemented)`);
        process.exit(1);
      }
      entityType = e;
    } else {
      queryParts.push(a);
    }
  }
  const query = queryParts.join(" ");

  const results = await lookup(query);
  console.log(JSON.stringify({
    entity_type: entityType,
    query,
    n_results: results.length,
    results,
  }, null, 2));
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`canonical-lookup error: ${msg}`);
  process.exit(3);
});
