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
    const sql = exclusionSubquery("new_only");
    expect(sql).toContain("FROM canonical.operator_aircraft_resolution_log r");
    expect(sql).toContain("WHERE r.aircraft_id = ai.aircraft_id");
    expect(sql).not.toContain("resolver_action");
  });

  it("re_resolve_no_match excludes only non-no_match rows", () => {
    const sql = exclusionSubquery("re_resolve_no_match");
    expect(sql).toContain("WHERE r.aircraft_id = ai.aircraft_id");
    expect(sql).toContain("AND r.resolver_action != 'no_match'");
  });

  it("both modes start with the same SELECT 1 anchor (the WHERE wraps it)", () => {
    expect(exclusionSubquery("new_only").startsWith("SELECT 1")).toBe(true);
    expect(exclusionSubquery("re_resolve_no_match").startsWith("SELECT 1")).toBe(true);
  });
});
