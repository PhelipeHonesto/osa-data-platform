/**
 * Bulk upsert helper — collapses per-row INSERTs into multi-row batches.
 *
 * Used across analytics rebuilds and live ingestion to avoid the
 * round-trips-per-row bottleneck against Supabase PostgreSQL.
 *
 * Modes:
 *   - conflictCols empty/omitted → plain bulk INSERT
 *   - conflictCols + default update → "col = EXCLUDED.col" for non-conflict cols
 *   - conflictCols + opts.updateClause → custom SET clause (PG SQL passed verbatim)
 *
 * Batches at 500 rows by default to stay well under PG's 65K parameter limit.
 */
import type { DbBridge } from "./pg-database.js";

export interface BulkUpsertOptions {
  /** Custom ON CONFLICT DO UPDATE SET body. Required when conflict semantics
   *  differ from the default "col = EXCLUDED.col" (e.g. COALESCE preservation,
   *  CASE expressions). Ignored when conflictCols is empty. */
  updateClause?: string;
  /** Rows per batch. Default 500. */
  batchSize?: number;
}

export async function bulkUpsert(
  db: DbBridge,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  conflictCols: readonly string[] = [],
  opts: BulkUpsertOptions = {},
): Promise<void> {
  if (rows.length === 0) return;
  const batchSize = opts.batchSize ?? 500;
  const colList = columns.join(", ");

  let onConflict = "";
  if (conflictCols.length > 0) {
    const conflictList = conflictCols.join(", ");
    const updateSet = opts.updateClause ?? columns
      .filter((c) => !conflictCols.includes(c))
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(", ");
    onConflict = ` ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
  }

  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const placeholders: string[] = [];
    const values: unknown[] = [];
    let p = 1;
    for (const row of slice) {
      const rowPh = row.map(() => `$${p++}`).join(",");
      placeholders.push(`(${rowPh})`);
      values.push(...row);
    }
    const sql =
      `INSERT INTO ${table} (${colList}) VALUES ${placeholders.join(",")}${onConflict}`;
    await db.prepare(sql).run(...values);
  }
}
