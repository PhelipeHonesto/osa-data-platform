import { describe, it, expect } from "vitest";
import {
  parseArgs,
  formatRunId,
  exclusionSubquery,
} from "../scripts/backfill-operator-aircraft-link.js";

describe("parseArgs", () => {
  it("defaults to dry-run, batch=5000, mode=new_only", () => {
    expect(parseArgs([])).toEqual({
      write: false,
      batchSize: 5000,
      maxBatches: null,
      mode: "new_only",
    });
  });

  it("reads --write", () => {
    expect(parseArgs(["--write"]).write).toBe(true);
  });

  it("reads --batch-size=N", () => {
    expect(parseArgs(["--batch-size=2500"]).batchSize).toBe(2500);
  });

  it("reads --max-batches=N", () => {
    expect(parseArgs(["--max-batches=10"]).maxBatches).toBe(10);
  });

  it("reads --re-resolve-no-match → mode=re_resolve_no_match", () => {
    expect(parseArgs(["--re-resolve-no-match"]).mode).toBe("re_resolve_no_match");
  });

  it("re-resolve mode coexists with --write and other flags", () => {
    const args = parseArgs(["--write", "--re-resolve-no-match", "--batch-size=1000"]);
    expect(args).toEqual({
      write: true,
      batchSize: 1000,
      maxBatches: null,
      mode: "re_resolve_no_match",
    });
  });

  it("ignores unknown flags", () => {
    expect(parseArgs(["--commit", "--verbose"]).mode).toBe("new_only");
  });
});

describe("formatRunId", () => {
  const fixed = new Date(Date.UTC(2026, 3, 25, 12, 34, 56));

  it("formats new_only as bare timestamp", () => {
    expect(formatRunId("new_only", fixed)).toBe("20260425T123456Z");
  });

  it("prefixes re_resolve_no_match with 'rerun_'", () => {
    expect(formatRunId("re_resolve_no_match", fixed)).toBe("rerun_20260425T123456Z");
  });

  it("defaults to new_only when mode omitted", () => {
    expect(formatRunId(undefined, fixed)).toBe("20260425T123456Z");
  });
});

describe("exclusionSubquery", () => {
  it("new_only excludes any aircraft with ANY resolution_log row", () => {
    const sql = exclusionSubquery("new_only", 1);
    expect(sql).toContain("FROM canonical.operator_aircraft_resolution_log r");
    expect(sql).toContain("WHERE r.aircraft_id = ai.aircraft_id");
    expect(sql).not.toContain("resolver_action");
  });

  it("re_resolve_no_match excludes (a) non-no_match rows OR (b) rows from this run", () => {
    const sql = exclusionSubquery("re_resolve_no_match", 1);
    expect(sql).toContain("WHERE r.aircraft_id = ai.aircraft_id");
    expect(sql).toContain("r.resolver_action != 'no_match'");
    expect(sql).toContain("r.backfill_run_id = $1");
    expect(sql).toMatch(/\(\s*r\.resolver_action != 'no_match'\s+OR\s+r\.backfill_run_id = \$1\s*\)/);
  });

  it("both modes start with the same SELECT 1 anchor (the WHERE wraps it)", () => {
    expect(exclusionSubquery("new_only", 1).startsWith("SELECT 1")).toBe(true);
    expect(exclusionSubquery("re_resolve_no_match", 1).startsWith("SELECT 1")).toBe(true);
  });

  // ── Loop-exit fix (rerun_20260425T021140Z idle-loop bug) ─────────────

  it("re_resolve_no_match SQL references the runId via the supplied param index — not string-interpolated", () => {
    // Verify the runId only appears as a $N parameter reference, never
    // inlined as a literal. Belt-and-braces against any future regression
    // toward string concat (e.g., `r.backfill_run_id = '${runId}'`).
    expect(exclusionSubquery("re_resolve_no_match", 3)).toContain("$3");
    expect(exclusionSubquery("re_resolve_no_match", 7)).toContain("$7");
    const sample = exclusionSubquery("re_resolve_no_match", 2);
    expect(sample).not.toMatch(/r\.backfill_run_id = '[^$]/); // no quoted literal
  });

  it("new_only ignores runId — no $N reference, no backfill_run_id text (regression)", () => {
    const sql = exclusionSubquery("new_only", 1);
    expect(sql).not.toContain("backfill_run_id");
    expect(sql).not.toContain("$1");
  });

  it("re_resolve_no_match excludes an aircraft already touched by the same runId in this run", () => {
    // SQL-snippet behavior verified by string match: applied to a fixture
    // resolution_log with (aircraft_id=A, action='no_match', backfill_run_id='X'),
    // the predicate would match (existence) and therefore EXCLUDE A in
    // re_resolve mode when runId='X' is bound to the supplied param.
    //
    // Logical equivalence:
    //   r.aircraft_id = ai.aircraft_id  ← matches (A = A)
    //   AND (
    //     r.resolver_action != 'no_match'   ← FALSE (it IS no_match)
    //     OR
    //     r.backfill_run_id = $1            ← TRUE  (X = X)
    //   )
    // → row exists in subquery → NOT EXISTS is false → A excluded. ✓
    const sql = exclusionSubquery("re_resolve_no_match", 1);
    expect(sql).toMatch(/\(\s*r\.resolver_action != 'no_match'\s+OR\s+r\.backfill_run_id = \$1\s*\)/);
  });
});
