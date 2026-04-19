/**
 * Unit tests for the operator_type backfill classifier.
 * DB-less — pure function checks. DB-bound execution is covered by
 * operating the live script in dry-run before committing.
 */

import { describe, it, expect } from "vitest";
import {
  parseArgs,
  normalizeName,
  classifyOperator,
  EXACT_NAME_RULES,
  FOREIGN_AOC_PATTERNS,
} from "../scripts/backfill-operator-types.js";

describe("parseArgs", () => {
  it("defaults to dry run", () => {
    expect(parseArgs([])).toEqual({ commit: false });
  });
  it("flips on --commit", () => {
    expect(parseArgs(["--commit"])).toEqual({ commit: true });
  });
  it("ignores unrelated flags", () => {
    expect(parseArgs(["--verbose", "--other=1"])).toEqual({ commit: false });
  });
});

describe("normalizeName", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeName("  Global  Jet  Capital  ")).toBe("global jet capital");
  });
  it("is idempotent", () => {
    const once = normalizeName("Accent Airways LLC");
    expect(normalizeName(once)).toBe(once);
  });
});

describe("classifyOperator — exact-name rules from Phase 1 calibration", () => {
  it("classifies Accent Airways LLC as billing_agent", () => {
    const c = classifyOperator("Accent Airways LLC");
    expect(c?.type).toBe("billing_agent");
  });

  it("classifies Global Jet Capital as financier", () => {
    const c = classifyOperator("Global Jet Capital");
    expect(c?.type).toBe("financier");
  });

  it("classifies VistaJet US as broker", () => {
    const c = classifyOperator("VistaJet US");
    expect(c?.type).toBe("broker");
  });

  it("classifies TAG Aviation USA as defunct", () => {
    const c = classifyOperator("TAG Aviation USA");
    expect(c?.type).toBe("defunct");
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(classifyOperator("  global jet CAPITAL  ")?.type).toBe("financier");
  });

  it("does not match a different TAG Aviation entity (UK/foreign affiliate)", () => {
    // TAG Aviation UK and TAG Aviation SA are separate legal entities;
    // only the USA row is defunct per the calibration finding.
    expect(classifyOperator("TAG Aviation UK")).toBeNull();
    expect(classifyOperator("TAG Aviation SA")).toBeNull();
  });

  it("returns a human-readable reason alongside the type", () => {
    const c = classifyOperator("VistaJet US");
    expect(c?.reason).toMatch(/broker/i);
  });
});

describe("classifyOperator — foreign_aoc corporate-form patterns", () => {
  it("matches GmbH (German/Austrian/Swiss)", () => {
    expect(classifyOperator("Tyrolean Jet Services GmbH")?.type).toBe("foreign_aoc");
  });

  it("matches GesmbH", () => {
    expect(classifyOperator("Vista Jet Austria GesmbH")?.type).toBe("foreign_aoc");
  });

  it("matches SEZC (Cayman)", () => {
    expect(classifyOperator("Sunrise Aviation SEZC")?.type).toBe("foreign_aoc");
  });

  it("matches s.r.l. (Italian)", () => {
    expect(classifyOperator("Sirio s.r.l.")?.type).toBe("foreign_aoc");
  });

  it("matches Ltda (Brazilian)", () => {
    expect(classifyOperator("Helisul Taxi Aereo Ltda")?.type).toBe("foreign_aoc");
  });

  it("does NOT match ambiguous forms Ltd or S.A. (too many US false positives)", () => {
    expect(classifyOperator("Generic Charter Ltd")).toBeNull();
    expect(classifyOperator("Something S.A.")).toBeNull();
  });

  it("does NOT match LLC (used heavily in US)", () => {
    expect(classifyOperator("Generic Aviation LLC")).toBeNull();
  });

  it("leaves unclassified canonical names as NULL", () => {
    expect(classifyOperator("NetJets Aviation, Inc.")).toBeNull();
    expect(classifyOperator("Flexjet LLC")).toBeNull();
    expect(classifyOperator("Jet Linx Aviation")).toBeNull();
  });
});

describe("rule tables — sanity", () => {
  it("EXACT_NAME_RULES contains the four confirmed Phase 1 non-carriers", () => {
    const names = EXACT_NAME_RULES.map((r) => r.canonicalName);
    expect(names).toContain("Accent Airways LLC");
    expect(names).toContain("Global Jet Capital");
    expect(names).toContain("VistaJet US");
    expect(names).toContain("TAG Aviation USA");
  });

  it("every EXACT_NAME_RULES entry has a reason string", () => {
    for (const rule of EXACT_NAME_RULES) {
      expect(rule.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("FOREIGN_AOC_PATTERNS contains only conservative (non-US-ambiguous) markers", () => {
    // Regression guard: if someone adds /\bLtd\b/ or /\bS\.A\.\b/, the test
    // catches them — those forms are too common in US filings to be safe.
    const joined = FOREIGN_AOC_PATTERNS.map((p) => p.source).join("|");
    expect(joined).not.toMatch(/\\bLtd\\b(?!a)/); // \bLtd\b but not \bLtda\b
    expect(joined).not.toMatch(/S\\\.A\\\./);
  });
});
