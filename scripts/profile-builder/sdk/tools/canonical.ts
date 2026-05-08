/**
 * canonical_lookup tool for the SDK runner.
 *
 * Calls the existing scripts/canonical-lookup.ts helper via direct
 * import (faster than child_process spawn + tsx startup).
 *
 * Why import directly: canonical-lookup.ts has a `main()` that
 * exits — we replicate just the lookup logic here using the same SQL
 * shape, so we can call it as an in-process function.
 */

import pg from "pg";
import { connectWithRetry } from "../db.js";

const QUERY_MIN_LEN = 3;
const MAX_RESULTS = 5;

export interface CanonicalLookupResult {
  id: string;
  canonical_name: string;
  operator_type: string | null;
  match_via: "canonical_name" | "alias";
  match_strength: number;
  matched_alias?: string;
}

export interface CanonicalLookupResponse {
  entity_type: "operator";
  query: string;
  n_results: number;
  results: CanonicalLookupResult[];
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export async function canonicalLookup(
  pool: pg.Pool,
  query: string,
  entityType: "operator" = "operator",
): Promise<CanonicalLookupResponse> {
  const q = normalize(query);
  if (q.length < QUERY_MIN_LEN) {
    return { entity_type: entityType, query: q, n_results: 0, results: [] };
  }

  const client = await connectWithRetry(pool);
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

    const results: CanonicalLookupResult[] = res.rows.map((r) => {
      const out: CanonicalLookupResult = {
        id: r.id,
        canonical_name: r.canonical_name,
        operator_type: r.operator_type,
        match_via: r.match_via,
        match_strength: parseFloat(r.match_strength),
      };
      if (r.matched_alias) out.matched_alias = r.matched_alias;
      return out;
    });

    return { entity_type: entityType, query: q, n_results: results.length, results };
  } finally {
    client.release();
  }
}
