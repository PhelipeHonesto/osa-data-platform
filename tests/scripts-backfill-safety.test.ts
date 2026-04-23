import { describe, it, expect } from "vitest";
import {
  parseArgs,
  planResolutions,
  emptyTally,
  tallyResult,
  type SafetyRatingRow,
} from "../scripts/backfill-operators-canonical-safety.js";
import type { ResolverResult } from "../src/entity-resolution/operator-resolver.js";

const baseRow: SafetyRatingRow = {
  id: 1,
  operator_name: "NetJets Aviation",
  argus_rating: null,
  wyvern_status: null,
  argus_home_base_icao: null,
};

describe("parseArgs", () => {
  it("defaults to dry run", () => {
    expect(parseArgs([])).toEqual({ commit: false });
  });
  it("flips on --commit", () => {
    expect(parseArgs(["--commit"])).toEqual({ commit: true });
  });
});

describe("planResolutions", () => {
  it("emits zero scraped records when both ratings are null (row will be skipped)", () => {
    const plan = planResolutions(baseRow);
    expect(plan.scraped).toHaveLength(0);
  });

  it("emits one ARGUS ScrapedRecord when only argus_rating is present", () => {
    const plan = planResolutions({
      ...baseRow,
      argus_rating: "platinum",
    });
    expect(plan.scraped).toHaveLength(1);
    expect(plan.scraped[0]?.source).toBe("argus");
    expect(plan.scraped[0]?.sourceId).toBe("1");
    expect(plan.scraped[0]?.name).toBe("NetJets Aviation");
  });

  it("emits one Wyvern ScrapedRecord when only wyvern_status is present", () => {
    const plan = planResolutions({
      ...baseRow,
      wyvern_status: "wingman",
    });
    expect(plan.scraped).toHaveLength(1);
    expect(plan.scraped[0]?.source).toBe("wyvern");
  });

  it("emits TWO ScrapedRecords when both ratings are present", () => {
    const plan = planResolutions({
      ...baseRow,
      argus_rating: "platinum",
      wyvern_status: "wingman",
    });
    expect(plan.scraped).toHaveLength(2);
    const sources = plan.scraped.map((s) => s.source).sort();
    expect(sources).toEqual(["argus", "wyvern"]);
  });

  it("passes argus_home_base_icao as icao signal when ARGUS provides it", () => {
    const plan = planResolutions({
      ...baseRow,
      argus_rating: "gold",
      argus_home_base_icao: "KTEB",
    });
    expect(plan.scraped[0]?.icao).toBe("KTEB");
  });
});

describe("tallyResult — outcome aggregation", () => {
  const mk = (over: Partial<ResolverResult>): ResolverResult => ({
    action: "exact",
    operatorId: null,
    identityId: null,
    reviewId: null,
    matchConfidence: null,
    topScore: null,
    reason: null,
    ...over,
  });

  it("tallies matched results by confidence tier", () => {
    const t = emptyTally();
    tallyResult(t, mk({ action: "matched", matchConfidence: "high" }));
    tallyResult(t, mk({ action: "matched", matchConfidence: "medium" }));
    tallyResult(t, mk({ action: "matched", matchConfidence: "high" }));
    expect(t.matched_high).toBe(2);
    expect(t.matched_medium).toBe(1);
  });

  it("splits review tally by reason", () => {
    const t = emptyTally();
    tallyResult(t, mk({ action: "review", reason: "low_tier" }));
    tallyResult(t, mk({ action: "review", reason: "ambiguous_runner_up" }));
    tallyResult(t, mk({ action: "review", reason: "ambiguous_runner_up" }));
    expect(t.review_low_tier).toBe(1);
    expect(t.review_ambiguous).toBe(2);
  });

  it("counts new/exact actions correctly", () => {
    const t = emptyTally();
    tallyResult(t, mk({ action: "new" }));
    tallyResult(t, mk({ action: "new" }));
    tallyResult(t, mk({ action: "exact" }));
    expect(t.new_).toBe(2);
    expect(t.exact).toBe(1);
  });
});
