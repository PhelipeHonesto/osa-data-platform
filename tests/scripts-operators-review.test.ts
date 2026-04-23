import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import {
  parseArgs,
  parseActionKey,
  parseTypeKey,
  formatRowDisplay,
  formatTypePrompt,
  approveMatch,
  rejectAndCreateNew,
  addAlias,
  escalate,
  classifyResolvedOperator,
  TYPE_KEYS,
  type PendingRow,
  type CandidateRef,
} from "../scripts/operators-review.js";

const baseRow: PendingRow = {
  id: 42,
  scraped_name: "NetJets Aviation",
  scraped_source: "wyvern",
  scraped_source_id: "123",
  scraped_payload: { _resolver_reason: "medium_name_only" },
  candidate_matches: [
    { operator_id: "uuid-top", canonical_name: "NetJets Aviation Inc", score: 0.88 },
    { operator_id: "uuid-second", canonical_name: "NetJets Sales", score: 0.71 },
  ],
  reviewer_notes: "Labeler note: top candidate is right.",
  created_at: "2026-04-19T10:00:00Z",
};

// ── Arg + action parsing ─────────────────────────────────────────────────

describe("parseArgs", () => {
  it("defaults to no limit, no force", () => {
    expect(parseArgs([])).toEqual({ limit: null, help: false, force: false });
  });
  it("reads --limit N", () => {
    expect(parseArgs(["--limit", "10"])).toEqual({ limit: 10, help: false, force: false });
  });
  it("detects --help / -h", () => {
    expect(parseArgs(["--help"])).toEqual({ limit: null, help: true, force: false });
    expect(parseArgs(["-h"])).toEqual({ limit: null, help: true, force: false });
  });
  it("ignores garbage --limit values", () => {
    expect(parseArgs(["--limit", "abc"])).toEqual({ limit: null, help: false, force: false });
  });
  it("flips force on --force", () => {
    expect(parseArgs(["--force"])).toEqual({ limit: null, help: false, force: true });
  });
  it("combines --limit and --force", () => {
    expect(parseArgs(["--limit", "5", "--force"])).toEqual({ limit: 5, help: false, force: true });
  });
});

describe("parseActionKey", () => {
  const cases: Array<[string, string | null]> = [
    ["a", "approve"],
    ["A", "approve"],
    ["approve", "approve"],
    ["r", "reject"],
    ["reject", "reject"],
    ["d", "defer"],
    ["l", "add-alias"],
    ["alias", "add-alias"],
    ["e", "escalate"],
    ["n", "pick-other"],
    ["other", "pick-other"],
    ["q", "quit"],
    ["exit", "quit"],
    [" a ", "approve"],
    ["x", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    it(`maps "${input}" → ${expected ?? "null"}`, () => {
      expect(parseActionKey(input)).toBe(expected);
    });
  }
});

// ── Display formatting ───────────────────────────────────────────────────

describe("formatRowDisplay", () => {
  it("includes scraped name + source in the header", () => {
    const out = formatRowDisplay(baseRow, 1, 1);
    expect(out).toContain("NetJets Aviation");
    expect(out).toContain("wyvern");
    expect(out).toContain("row id 42");
  });

  it("surfaces reviewer_notes prominently with the clipboard emoji", () => {
    const out = formatRowDisplay(baseRow, 1, 1);
    expect(out).toContain("📝 Labeler note");
    expect(out).toContain("top candidate is right");
  });

  it("lists all candidates with score + rank", () => {
    const out = formatRowDisplay(baseRow, 1, 1);
    expect(out).toContain("[1] 0.880  NetJets Aviation Inc");
    expect(out).toContain("[2] 0.710  NetJets Sales");
  });

  it("works when reviewer_notes is null (no clipboard section)", () => {
    const out = formatRowDisplay({ ...baseRow, reviewer_notes: null }, 3, 10);
    expect(out).not.toContain("📝");
    expect(out).toContain("Review 3/10");
  });
});

// ── Action handlers with mock client ─────────────────────────────────────

function mockClient(): { client: pg.PoolClient; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.PoolClient;
  return { client, queries };
}

describe("approveMatch — writes identity + flips review status", () => {
  it("INSERTs operator_identities with match_confidence='manual' and UPDATEs the review row to 'matched'", async () => {
    const { client, queries } = mockClient();
    const candidate: CandidateRef = baseRow.candidate_matches[0]!;
    await approveMatch(client, baseRow, candidate);
    expect(queries.length).toBe(2);
    expect(queries[0]!.sql).toMatch(/INSERT INTO operator_identities/);
    expect(queries[0]!.sql).toContain("'manual'");
    expect(queries[1]!.sql).toMatch(/UPDATE operator_match_review/);
    expect(queries[1]!.sql).toContain("'matched'");
  });
});

describe("rejectAndCreateNew — INSERTs operator + identity, status='new_operator'", () => {
  it("creates a fresh operators row and links the scraped source_id to it", async () => {
    const { client, queries } = mockClient();
    await rejectAndCreateNew(client, baseRow);
    expect(queries.length).toBe(3);
    expect(queries[0]!.sql).toMatch(/INSERT INTO operators/);
    expect(queries[1]!.sql).toMatch(/INSERT INTO operator_identities/);
    expect(queries[1]!.sql).toContain("'exact'");
    expect(queries[2]!.sql).toMatch(/UPDATE operator_match_review/);
    expect(queries[2]!.sql).toContain("'new_operator'");
  });
});

describe("addAlias — approves match AND records alias", () => {
  it("runs the approve path plus an INSERT INTO operator_aliases", async () => {
    const { client, queries } = mockClient();
    const candidate: CandidateRef = baseRow.candidate_matches[0]!;
    await addAlias(client, baseRow, candidate);
    expect(queries.length).toBe(3);
    // 1: INSERT operator_identities (from approveMatch)
    expect(queries[0]!.sql).toMatch(/INSERT INTO operator_identities/);
    // 2: UPDATE operator_match_review (from approveMatch)
    expect(queries[1]!.sql).toMatch(/UPDATE operator_match_review/);
    // 3: INSERT operator_aliases
    expect(queries[2]!.sql).toMatch(/INSERT INTO operator_aliases/);
    expect(queries[2]!.sql).toContain("'dba'");
  });
});

describe("escalate — skips with [ESCALATED] prefix in notes", () => {
  it("prepends [ESCALATED] to existing reviewer_notes", async () => {
    const { client, queries } = mockClient();
    await escalate(client, baseRow);
    expect(queries.length).toBe(1);
    expect(queries[0]!.sql).toContain("'skipped'");
    expect(queries[0]!.params[0]).toMatch(/^\[ESCALATED\]/);
    expect(queries[0]!.params[0]).toContain("top candidate is right");
  });

  it("uses bare [ESCALATED] when no prior notes", async () => {
    const { client, queries } = mockClient();
    await escalate(client, { ...baseRow, reviewer_notes: null });
    expect(queries[0]!.params[0]).toBe("[ESCALATED]");
  });
});

// ── operator_type classification prompt ─────────────────────────────────

describe("parseTypeKey — numeric keypad → operator_type", () => {
  const expected: Array<[string, string | null]> = [
    ["1", "part_135"],
    ["2", "part_121"],
    ["3", "part_91k"],
    ["4", "foreign_aoc"],
    ["5", "broker"],
    ["6", "billing_agent"],
    ["7", "financier"],
    ["8", "holding_co"],
    ["9", "defunct"],
    ["0", "trust_holder"],
    ["s", "skip"],
    ["S", "skip"],
    ["  s  ", "skip"],
    ["", "skip"],           // bare Enter means skip
    ["   ", "skip"],        // whitespace-only → skip
    ["x", null],
    ["abc", null],
    ["10", null],           // two-digit rejected
  ];
  for (const [input, want] of expected) {
    it(`maps "${input}" → ${want ?? "null"}`, () => {
      expect(parseTypeKey(input)).toBe(want);
    });
  }

  it("every OperatorType value from backfill rules is reachable via TYPE_KEYS", () => {
    // Guards against drift between the CLI menu and the migration's enum set.
    // If the schema ever adds a new operator_type value, TYPE_KEYS must learn it.
    const expectedValues = [
      "part_135","part_121","part_91k","foreign_aoc","broker",
      "billing_agent","financier","holding_co","defunct","trust_holder",
    ];
    const reachable = new Set(Object.values(TYPE_KEYS).filter((v) => v !== "skip"));
    for (const v of expectedValues) {
      expect(reachable.has(v as never)).toBe(true);
    }
  });
});

describe("formatTypePrompt", () => {
  it("lists all ten type labels", () => {
    const out = formatTypePrompt("Example Op", null);
    for (const label of [
      "part_135","part_121","part_91k","foreign_aoc","broker",
      "billing_agent","financier","holding_co","defunct","trust_holder",
    ]) {
      expect(out).toContain(label);
    }
  });

  it("includes the operator name and the skip affordance", () => {
    const out = formatTypePrompt("A-Ok Jets", null);
    expect(out).toContain("A-Ok Jets");
    expect(out).toContain("skip");
  });

  it("warns when an existing value is about to be overwritten", () => {
    const out = formatTypePrompt("Example Op", "broker");
    expect(out).toContain("broker");
    expect(out).toMatch(/force/);
  });

  it("omits the warning when no existing value", () => {
    const out = formatTypePrompt("Example Op", null);
    expect(out).not.toMatch(/force/);
  });
});

describe("classifyResolvedOperator — post-resolution prompt flow", () => {
  function typedClient(existingType: string | null): {
    client: pg.PoolClient;
    updates: Array<{ sql: string; params: unknown[] }>;
  } {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("SELECT operator_type")) {
          return { rows: [{ operator_type: existingType }], rowCount: 1 };
        }
        updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as pg.PoolClient;
    return { client, updates };
  }

  it("writes the chosen operator_type when the current value is NULL", async () => {
    const { client, updates } = typedClient(null);
    const result = await classifyResolvedOperator(
      client,
      "op-123",
      "Some Operator",
      false,
      async () => "1", // picks part_135
    );
    expect(result).toBe("part_135");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toMatch(/UPDATE operators/);
    expect(updates[0]!.sql).toMatch(/operator_type/);
    expect(updates[0]!.params[0]).toBe("part_135");
    expect(updates[0]!.params[1]).toBe("op-123");
  });

  it("skips silently when existing value is set and --force is off (no UPDATE runs)", async () => {
    const { client, updates } = typedClient("broker");
    const result = await classifyResolvedOperator(
      client,
      "op-123",
      "Some Operator",
      false,
      async () => "1", // would pick part_135 — but the prompt never actually fires
    );
    expect(result).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it("overwrites existing value when --force is on", async () => {
    const { client, updates } = typedClient("broker");
    const result = await classifyResolvedOperator(
      client,
      "op-123",
      "Some Operator",
      true,              // --force
      async () => "9",   // defunct
    );
    expect(result).toBe("defunct");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.params[0]).toBe("defunct");
  });

  it("honours 'skip' (s) and leaves the column alone", async () => {
    const { client, updates } = typedClient(null);
    const result = await classifyResolvedOperator(
      client,
      "op-123",
      "Some Operator",
      false,
      async () => "s",
    );
    expect(result).toBe("skip");
    expect(updates).toHaveLength(0);
  });

  it("bare Enter (empty answer) is equivalent to skip", async () => {
    const { client, updates } = typedClient(null);
    const result = await classifyResolvedOperator(
      client,
      "op-123",
      "Some Operator",
      false,
      async () => "",
    );
    expect(result).toBe("skip");
    expect(updates).toHaveLength(0);
  });

  it("returns null and does not UPDATE on unrecognised input", async () => {
    const { client, updates } = typedClient(null);
    const result = await classifyResolvedOperator(
      client,
      "op-123",
      "Some Operator",
      false,
      async () => "garbage",
    );
    expect(result).toBeNull();
    expect(updates).toHaveLength(0);
  });
});

// ── Pre-flight gate ──────────────────────────────────────────────────────

describe("pre-flight gate (via isCalibrated)", () => {
  it("commit 8b calibration must have set calibrated_at before review runs", async () => {
    const { isCalibrated, THRESHOLDS } = await import("../src/entity-resolution/match-thresholds.js");
    // After 8b: THRESHOLDS.calibrated_at should be an ISO string, not null.
    expect(THRESHOLDS.calibrated_at).not.toBeNull();
    expect(isCalibrated()).toBe(true);
  });
});
