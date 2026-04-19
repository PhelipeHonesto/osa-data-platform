/**
 * Smoke test for the migration loader — catches regressions in:
 *   - Schema-file load order (extensions → transactional → silver →
 *     analytics → gold/* → migrations)
 *   - Migration idempotency (every statement must be safe to re-apply)
 *   - "new-indexes-on-new-columns" rule (index creation referencing a
 *     column that doesn't exist on pre-migration DBs hard-fails)
 *   - Missing IF NOT EXISTS guards
 *
 * Gated on SUPABASE_DATABASE_URL via describeIf. Runs the real
 * `npm run db:migrate-pg` subprocess against the configured DB. This is
 * safe because migrate-pg is idempotent by construction (see
 * docs/data-architecture.md — Rule 5): every statement either has an
 * IF NOT EXISTS guard or is wrapped in an information_schema check.
 * Re-applying on an up-to-date DB should always be a no-op.
 *
 * Writes to the real configured DB (no schema isolation). Each run is a
 * no-op on a healthy DB; the test exists specifically to surface the
 * moment that stops being true.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const hasPg = !!process.env["SUPABASE_DATABASE_URL"];
const describeIf = hasPg ? describe : describe.skip;

describeIf("migrate-pg — idempotent loader smoke", () => {
  it(
    "npm run db:migrate-pg re-applies without error and verifies every declared table",
    () => {
      const cwd = resolve(__dirname, "..");
      const res = spawnSync("npm", ["run", "db:migrate-pg"], {
        encoding: "utf-8",
        cwd,
        env: { ...process.env, DATABASE_TYPE: "postgres" },
      });

      const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;

      // Exit status: migrate-pg uses process.exit(1) on fatal errors.
      expect(res.status).toBe(0);

      // Missing tables flow through log.error (Sentry bridge) but don't
      // exit non-zero. Asserting the success line catches that gap —
      // main() only prints "All N declared tables verified." when
      // missing.length === 0.
      expect(combined).toMatch(/All \d+ declared tables verified\./);

      // Sanity floor: the schema has grown to 52 tables as of
      // 2026-04-19; anything below 50 means something got pruned.
      const m = combined.match(/All (\d+) declared tables verified\./);
      const count = m?.[1] ? Number(m[1]) : 0;
      expect(count).toBeGreaterThanOrEqual(50);

      // No unexpected fatal logs. 'expected tables missing' is the
      // specific warning that indicates a declared table didn't land.
      expect(combined).not.toMatch(/expected tables missing/i);
    },
    60_000,
  );
});
