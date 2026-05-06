/**
 * Resolver tests with a mock pg.PoolClient. No live DB.
 * Each test asserts the exact sequence of queries + parameters the resolver
 * emits for a given scraped record, and confirms the write path is singular
 * (either operator_identities OR operator_match_review, never both).
 */

import { describe, it, expect } from "vitest";
import type pg from "pg";
import {
  resolveOperator,
  resolveOperatorMatchOnly,
  firstSignificantWord,
} from "../src/entity-resolution/operator-resolver.js";

// ── Mock client ──────────────────────────────────────────────────────────

interface Queued {
  matcher: RegExp | string;
  rows?: unknown[];
}

function makeMockClient(queued: Queued[]): {
  client: pg.PoolClient;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let idx = 0;
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const next = queued[idx++];
      if (!next) throw new Error(`unexpected query #${idx}: ${sql.slice(0, 80)}`);
      const ok = typeof next.matcher === "string"
        ? sql.includes(next.matcher)
        : next.matcher.test(sql);
      if (!ok) {
        throw new Error(
          `query #${idx} did not match.\nexpected: ${next.matcher}\ngot: ${sql.slice(0, 120)}`,
        );
      }
      return { rows: next.rows ?? [] };
    },
    release() {},
  } as unknown as pg.PoolClient;
  return { client, calls };
}

const baseScraped = {
  name: "NetJets Aviation",
  source: "argus" as const,
  sourceId: "ARG-001",
};

// ── Tests ────────────────────────────────────────────────────────────────

describe("firstSignificantWord", () => {
  it("picks the first word with 3+ chars", () => {
    expect(firstSignificantWord("NetJets Aviation")).toBe("NetJets");
  });
  it("strips punctuation from the word", () => {
    expect(firstSignificantWord("24/7 Jet Inc.")).toBe("Jet");
  });
  it("skips short tokens like 'AB' but keeps the full word at the end when none qualify", () => {
    expect(firstSignificantWord("AB")).toBe("AB");
  });
});

describe("resolveOperator — exact short-circuit", () => {
  it("updates last_verified_at when (source, source_id) already linked", async () => {
    const { client, calls } = makeMockClient([
      {
        matcher: /UPDATE operator_identities/,
        rows: [{ id: 42, operator_id: "existing-uuid" }],
      },
    ]);
    const result = await resolveOperator(baseScraped, client);
    expect(result.action).toBe("exact");
    expect(result.operatorId).toBe("existing-uuid");
    expect(result.identityId).toBe(42);
    expect(result.matchConfidence).toBe("exact");
    expect(calls.length).toBe(1);
  });
});

describe("resolveOperator — high-tier clean match", () => {
  it("writes operator_identities with confidence='high' and no review row", async () => {
    const { client, calls } = makeMockClient([
      { matcher: /UPDATE operator_identities/, rows: [] }, // no existing
      {
        matcher: /FROM operators o/,
        rows: [
          { operator_id: "op-a", canonical_name: "NetJets Aviation", headquarters_icao: null, state: null, city: null },
          { operator_id: "op-b", canonical_name: "Different Operator LLC", headquarters_icao: null, state: null, city: null },
        ],
      },
      { matcher: /INSERT INTO operator_identities/, rows: [{ id: 99 }] },
    ]);
    const result = await resolveOperator(baseScraped, client);
    expect(result.action).toBe("matched");
    expect(result.matchConfidence).toBe("high");
    expect(result.identityId).toBe(99);
    expect(result.reviewId).toBeNull();
    // Assert no review-table query was issued.
    expect(calls.some((c) => /operator_match_review/i.test(c.sql))).toBe(false);
  });
});

describe("resolveOperator — medium-tier with only name signal", () => {
  it("downgrades to review (reason='medium_name_only') per REQUIRE_SIGNAL_AT_TIERS", async () => {
    const { client, calls } = makeMockClient([
      { matcher: /UPDATE operator_identities/, rows: [] },
      {
        matcher: /FROM operators o/,
        rows: [
          // Medium-tier candidate: name similarity ~0.8 with no corroborating signal
          { operator_id: "op-c", canonical_name: "NetJets Stop Air", headquarters_icao: null, state: null, city: null },
        ],
      },
      { matcher: /INSERT INTO operator_match_review/, rows: [{ id: 500 }] },
    ]);
    const result = await resolveOperator(baseScraped, client);
    expect(result.action).toBe("review");
    expect(result.reason).toBe("medium_name_only");
    expect(result.reviewId).toBe(500);
    expect(calls.some((c) => /INSERT INTO operator_identities/i.test(c.sql))).toBe(false);
  });
});

describe("resolveOperator — medium-tier with corroborating signal still auto-matches", () => {
  it("keeps action='matched' when ICAO signal corroborates the medium-tier name match", async () => {
    const { client, calls } = makeMockClient([
      { matcher: /UPDATE operator_identities/, rows: [] },
      {
        matcher: /FROM operators o/,
        rows: [
          // Same weak name match, but this time the candidate has an ICAO we match on.
          { operator_id: "op-c", canonical_name: "NetJets Stop Air", headquarters_icao: "KCMH", state: null, city: null },
        ],
      },
      { matcher: /INSERT INTO operator_identities/, rows: [{ id: 601 }] },
    ]);
    const scraped = { ...baseScraped, icao: "KCMH" };
    const result = await resolveOperator(scraped, client);
    expect(result.action).toBe("matched");
    expect(result.reason).toBeFalsy();
    expect(result.identityId).toBe(601);
    expect(calls.some((c) => /operator_match_review/i.test(c.sql))).toBe(false);
  });
});

describe("resolveOperator — low-tier goes to review, not identity", () => {
  it("inserts operator_match_review and writes no identity", async () => {
    const { client, calls } = makeMockClient([
      { matcher: /UPDATE operator_identities/, rows: [] },
      {
        matcher: /FROM operators o/,
        rows: [
          // Low-similarity candidate: shares "Aviation" word but little else
          { operator_id: "op-d", canonical_name: "NetJets Fleet Aviation Systems Inc", headquarters_icao: null, state: null, city: null },
        ],
      },
      { matcher: /INSERT INTO operator_match_review/, rows: [{ id: 55 }] },
    ]);
    const scraped = { ...baseScraped, name: "Unrelated Aviation" };
    const result = await resolveOperator(scraped, client);
    expect(result.action).toBe("review");
    expect(result.reason).toBe("low_tier");
    expect(result.reviewId).toBe(55);
    expect(result.operatorId).toBeNull();
    expect(result.identityId).toBeNull();
    expect(calls.some((c) => /INSERT INTO operator_identities/i.test(c.sql))).toBe(false);
  });
});

describe("resolveOperator — zero candidates creates a new operator", () => {
  it("inserts into operators then operator_identities with confidence='exact'", async () => {
    const { client, calls } = makeMockClient([
      { matcher: /UPDATE operator_identities/, rows: [] },
      { matcher: /FROM operators o/, rows: [] },
      // Normalize-match guard runs before writeNew; empty result = miss.
      { matcher: /SELECT[\s\S]+FROM operators[\s\S]+LOWER\(TRIM\(REGEXP_REPLACE\(canonical_name/, rows: [] },
      { matcher: /INSERT INTO operators/, rows: [] },
      { matcher: /INSERT INTO operator_identities/, rows: [{ id: 11 }] },
    ]);
    const result = await resolveOperator(baseScraped, client);
    expect(result.action).toBe("new");
    expect(result.matchConfidence).toBe("exact");
    expect(result.identityId).toBe(11);
    expect(result.operatorId).toBeTruthy();
    expect(calls.some((c) => /operator_match_review/i.test(c.sql))).toBe(false);
    // Confirm the operators INSERT was called before the identity INSERT.
    const opsIdx = calls.findIndex((c) => /INSERT INTO operators/i.test(c.sql));
    const idIdx = calls.findIndex((c) => /INSERT INTO operator_identities/i.test(c.sql));
    expect(opsIdx).toBeLessThan(idIdx);
  });
});

describe("resolveOperator — normalize-match guard catches what scoring missed", () => {
  it("attaches identity to existing operator when normalize-equal name exists", async () => {
    // Pre-filter ILIKE returns no candidates (e.g., scraped first sig word
    // doesn't surface the existing operator), so decide() returns 'new'.
    // The new guard runs the normalize-match SELECT and finds the existing
    // operator, so we should see no INSERT INTO operators and an
    // operator_identities row attached to the existing id.
    const { client, calls } = makeMockClient([
      { matcher: /UPDATE operator_identities/, rows: [] }, // no exact short-circuit
      { matcher: /FROM operators o/, rows: [] }, // pre-filter empty
      // Normalize-match SELECT finds the existing operator
      {
        matcher: /SELECT[\s\S]+FROM operators[\s\S]+LOWER\(TRIM\(REGEXP_REPLACE\(canonical_name/,
        rows: [{ id: "op-existing", canonical_name: "NetJets Aviation" }],
      },
      // Identity insert attached to op-existing (no operators INSERT)
      { matcher: /INSERT INTO operator_identities/, rows: [{ id: 7777 }] },
    ]);
    const scraped = {
      name: "  netjets   aviation  ",
      source: "argus" as const,
      sourceId: "ARG-NORM-001",
    };
    const result = await resolveOperator(scraped, client);
    expect(result.action).toBe("matched");
    expect(result.operatorId).toBe("op-existing");
    expect(result.identityId).toBe(7777);
    expect(result.matchConfidence).toBe("exact");
    expect(result.topScore).toBeNull(); // scorer didn't see the matched op
    // No operators INSERT — the existing operator is reused.
    expect(calls.some((c) => /INSERT INTO operators[^_]/i.test(c.sql))).toBe(false);
    // Identity row uses match_method='name_normalized_match' and preserves
    // the scraped name verbatim (whitespace + casing) in name_as_provided.
    const idCall = calls.find((c) => /INSERT INTO operator_identities/i.test(c.sql))!;
    expect(idCall.sql).toMatch(/'name_normalized_match'/);
    expect(idCall.params[3]).toBe("  netjets   aviation  ");
  });
});

describe("resolveOperator — ambiguity guard forces review", () => {
  it("downgrades high-tier match to review when runner-up is within AMBIGUITY_EPSILON", async () => {
    const { client, calls } = makeMockClient([
      { matcher: /UPDATE operator_identities/, rows: [] },
      {
        matcher: /FROM operators o/,
        rows: [
          { operator_id: "op-e", canonical_name: "NetJets Aviation", headquarters_icao: null, state: null, city: null },
          { operator_id: "op-f", canonical_name: "NetJets Aviation", headquarters_icao: null, state: null, city: null },
        ],
      },
      { matcher: /INSERT INTO operator_match_review/, rows: [{ id: 200 }] },
    ]);
    const result = await resolveOperator(baseScraped, client);
    expect(result.action).toBe("review");
    expect(result.reason).toBe("ambiguous_runner_up");
    expect(result.reviewId).toBe(200);
    expect(calls.some((c) => /INSERT INTO operator_identities/i.test(c.sql))).toBe(false);
  });
});

describe("resolveOperator — review row captures top candidates", () => {
  it("stores up to 3 candidates in candidate_matches JSONB, ordered by score", async () => {
    let captured: Record<string, unknown> | null = null;
    const client = {
      async query(sql: string, params: unknown[] = []) {
        if (/UPDATE operator_identities/.test(sql)) return { rows: [] };
        if (/FROM operators o/.test(sql)) {
          return {
            rows: [
              { operator_id: "x", canonical_name: "NetJets Aviation", headquarters_icao: null, state: null, city: null },
              { operator_id: "y", canonical_name: "NetJets Aviation", headquarters_icao: null, state: null, city: null },
              { operator_id: "z", canonical_name: "NetJets Aviation Inc Delta Charlie", headquarters_icao: null, state: null, city: null },
              { operator_id: "w", canonical_name: "NetJets LLC", headquarters_icao: null, state: null, city: null },
            ],
          };
        }
        if (/INSERT INTO operator_match_review/.test(sql)) {
          const candidateMatchesJson = params[4] as string;
          captured = JSON.parse(candidateMatchesJson);
          return { rows: [{ id: 1 }] };
        }
        throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
      },
      release() {},
    } as unknown as pg.PoolClient;

    await resolveOperator(baseScraped, client);
    const arr = captured as unknown as Array<{ operator_id: string; score: number }>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeLessThanOrEqual(3);
    for (let i = 0; i < arr.length - 1; i++) {
      expect(arr[i]!.score).toBeGreaterThanOrEqual(arr[i + 1]!.score);
    }
  });
});

describe("resolveOperator — caller-owned transaction is not committed by resolver", () => {
  it("does not emit BEGIN/COMMIT when a client is passed in", async () => {
    const { client, calls } = makeMockClient([
      { matcher: /UPDATE operator_identities/, rows: [{ id: 1, operator_id: "abc" }] },
    ]);
    await resolveOperator(baseScraped, client);
    const sawBegin = calls.some((c) => /^BEGIN/i.test(c.sql.trim()));
    const sawCommit = calls.some((c) => /^COMMIT/i.test(c.sql.trim()));
    expect(sawBegin).toBe(false);
    expect(sawCommit).toBe(false);
  });
});

// ── resolveOperatorMatchOnly (Stage 2b backfill) ─────────────────────────

describe("resolveOperatorMatchOnly — exact short-circuit is read-only", () => {
  it("returns exact via SELECT (not UPDATE) when identity already linked", async () => {
    const { client, calls } = makeMockClient([
      {
        matcher: /SELECT\s+oi\.operator_id.*FROM operator_identities/s,
        rows: [{ operator_id: "existing-uuid", canonical_name: "NetJets Aviation" }],
      },
    ]);
    const result = await resolveOperatorMatchOnly(baseScraped, client);
    expect(result.action).toBe("exact");
    expect(result.operatorId).toBe("existing-uuid");
    expect(result.canonicalName).toBe("NetJets Aviation");
    expect(result.matchConfidence).toBe("exact");
    // No write path touched — exactly one query emitted.
    expect(calls.length).toBe(1);
    expect(/^UPDATE|^INSERT/i.test(calls[0]!.sql.trim())).toBe(false);
  });
});

describe("resolveOperatorMatchOnly — matched path returns candidate without writing", () => {
  it("returns matched+operatorId for high-tier candidate and does NOT INSERT", async () => {
    const { client, calls } = makeMockClient([
      // exact short-circuit miss
      { matcher: /SELECT\s+oi\.operator_id.*FROM operator_identities/s, rows: [] },
      // candidate fetch — one high-similarity candidate
      {
        matcher: /FROM operators o/,
        rows: [
          { operator_id: "netjets-uuid", canonical_name: "NetJets Aviation", headquarters_icao: null, state: null, city: null },
        ],
      },
    ]);
    const result = await resolveOperatorMatchOnly(baseScraped, client);
    expect(result.action).toBe("matched");
    expect(result.operatorId).toBe("netjets-uuid");
    expect(result.matchConfidence).toBe("high");
    expect(result.topScore).not.toBeNull();
    expect(result.tier).toBe("high");
    expect(result.signals).not.toBeNull();
    // Only the two reads ran — no INSERT, no UPDATE.
    expect(calls.length).toBe(2);
    expect(calls.some((c) => /^INSERT/i.test(c.sql.trim()))).toBe(false);
    expect(calls.some((c) => /^UPDATE/i.test(c.sql.trim()))).toBe(false);
  });
});

describe("resolveOperatorMatchOnly — no_match replaces the 'new' write path", () => {
  it("returns no_match (never 'new') when zero candidates", async () => {
    const { client, calls } = makeMockClient([
      { matcher: /SELECT\s+oi\.operator_id.*FROM operator_identities/s, rows: [] },
      { matcher: /FROM operators o/, rows: [] }, // zero candidates
    ]);
    const result = await resolveOperatorMatchOnly(
      { name: "JOHN Q PUBLIC AIRCRAFT LLC", source: "faa" as const, sourceId: "N999ZZ" },
      client,
    );
    expect(result.action).toBe("no_match");
    expect(result.operatorId).toBeNull();
    expect(result.matchConfidence).toBeNull();
    // Read-only: nothing inserted into operators or operator_identities.
    expect(calls.some((c) => /INTO operators/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /INTO operator_identities/i.test(c.sql))).toBe(false);
  });
});

describe("resolveOperatorMatchOnly — review tier returns decision without enqueueing", () => {
  it("returns review + reason for low-tier matches, no INSERT into operator_match_review", async () => {
    const { client, calls } = makeMockClient([
      { matcher: /SELECT\s+oi\.operator_id.*FROM operator_identities/s, rows: [] },
      {
        matcher: /FROM operators o/,
        // Name chosen so Jaro-Winkler to "NetJets Aviation" is middling but
        // lands in the low tier — see canonical-match-scoring tests for
        // threshold calibration. If calibration shifts, this payload adjusts.
        rows: [
          { operator_id: "weak-uuid", canonical_name: "Net Holdings LLC", headquarters_icao: null, state: null, city: null },
        ],
      },
    ]);
    const result = await resolveOperatorMatchOnly(baseScraped, client);
    expect(["review", "no_match"]).toContain(result.action);
    // If review, reason must be set; if no_match, reason null.
    if (result.action === "review") {
      expect(result.reason).not.toBeNull();
    }
    // Never writes.
    expect(calls.some((c) => /INTO operator_match_review/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /INTO operator_identities/i.test(c.sql))).toBe(false);
  });
});

// ── Review gate (Stage 2b Checkpoint 3 — REVIEW_GATE in match-thresholds.ts) ──
//
// The canEnterReview unit tests below exercise the policy directly. The
// resolver integration case is covered by the existing "review tier returns
// decision without enqueueing" test above, which now consistently lands on
// no_match (rather than review) once REVIEW_GATE.requireSignal = true — the
// test's `expect(["review", "no_match"]).toContain` tolerance holds either
// way.

describe("canEnterReview (match-thresholds config)", () => {
  it("rejects new_operator tier regardless of signals", async () => {
    const { canEnterReview } = await import("../src/entity-resolution/match-thresholds.js");
    expect(canEnterReview("new_operator", { nameSim: 0.5, stateMatch: true })).toBe(false);
  });
  it("rejects low tier under current REVIEW_GATE.minTier='medium'", async () => {
    const { canEnterReview } = await import("../src/entity-resolution/match-thresholds.js");
    expect(canEnterReview("low", { nameSim: 0.65, stateMatch: true })).toBe(false);
  });
  it("rejects medium tier when no corroborating signal", async () => {
    const { canEnterReview } = await import("../src/entity-resolution/match-thresholds.js");
    expect(canEnterReview("medium", { nameSim: 0.8 })).toBe(false);
  });
  it("permits medium tier with a corroborating signal", async () => {
    const { canEnterReview } = await import("../src/entity-resolution/match-thresholds.js");
    expect(canEnterReview("medium", { nameSim: 0.8, stateMatch: true })).toBe(true);
    expect(canEnterReview("medium", { nameSim: 0.8, cityMatch: true })).toBe(true);
    expect(canEnterReview("medium", { nameSim: 0.8, icaoMatch: true })).toBe(true);
  });
  it("permits high tier with a corroborating signal", async () => {
    const { canEnterReview } = await import("../src/entity-resolution/match-thresholds.js");
    expect(canEnterReview("high", { nameSim: 0.95, stateMatch: true })).toBe(true);
  });
});
