/**
 * pg-pool resilience helpers (V1.2.1).
 *
 * Background: V1.2 first launch crashed at the 49-profile mark from a
 * pg-pool `read ETIMEDOUT` — Supabase's pooler closes idle connections,
 * and the next query on the stale connection threw, propagating as an
 * unhandled rejection that killed the runner. This module wraps
 * pool.connect() with retry-with-backoff, and attaches a pool-error
 * handler so idle-client errors don't leak as unhandled rejections.
 */

import pg from "pg";

const TRANSIENT_PATTERNS = [
  /ETIMEDOUT/,
  /ECONNRESET/,
  /EPIPE/,
  /connection terminated/i,
  /Connection terminated/i,
  /Connection terminated unexpectedly/i,
  /Client has encountered a connection error/,
];

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(msg));
}

export async function connectWithRetry(
  pool: pg.Pool,
  maxRetries = 3,
): Promise<pg.PoolClient> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === maxRetries) break;
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pg-pool] connect attempt ${attempt + 1} failed (${msg}), retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Attach a generic error handler to the pool so idle-connection errors
 * (which fire on the pool object, not on a specific query) get caught
 * and logged instead of becoming unhandled rejections that kill the
 * Node process.
 */
export function attachPoolErrorHandler(pool: pg.Pool): void {
  pool.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pg-pool] idle client error (caught, non-fatal): ${msg}`);
  });
}

/**
 * Detect Anthropic 429 rate-limit error from the SDK's thrown error
 * message. Used by the runner to apply backoff.
 */
export function isRateLimitError(detail: string | undefined): boolean {
  if (!detail) return false;
  return /429\b/.test(detail) && /rate_limit_error/i.test(detail);
}

export function isPoolTimeoutError(detail: string | undefined): boolean {
  if (!detail) return false;
  return /ETIMEDOUT|ECONNRESET|connection terminated/i.test(detail);
}
