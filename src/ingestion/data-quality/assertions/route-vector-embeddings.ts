/**
 * Assertion: every route_vectors row has a non-null embedding.
 *
 * A null embedding means the embeddings-build pipeline half-wrote a row
 * — either an abort mid-INSERT that persisted the keys but not the
 * vector, or a schema change that forgot to backfill. Either way it
 * breaks the pgvector kNN queries that agents will run against this
 * table in Phase 2+.
 */

import type { Assertion } from "./types.js";

export const routeVectorEmbeddings: Assertion = {
  name: "route_vector_embeddings",
  description: "Zero route_vectors rows with embedding IS NULL",
  async run(client) {
    const res = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::TEXT AS cnt FROM route_vectors WHERE embedding IS NULL`,
    );
    const nulls = Number(res.rows[0]?.cnt ?? 0);
    return {
      status: nulls === 0 ? "pass" : "fail",
      threshold: "= 0",
      actual_value: String(nulls),
      context: { null_embedding_count: nulls },
    };
  },
};
