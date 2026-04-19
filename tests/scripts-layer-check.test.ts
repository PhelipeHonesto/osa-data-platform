import { describe, it, expect } from "vitest";
import { siblingFromSpecifier, scanMemoryImports, scanMemoryRoot } from "../scripts/check-agent-layer-isolation.js";

describe("siblingFromSpecifier", () => {
  it("flags ../ingestion/foo.js as 'ingestion'", () => {
    expect(siblingFromSpecifier("../ingestion/foo.js")).toBe("ingestion");
  });
  it("flags ../../capabilities/x.js as 'capabilities'", () => {
    expect(siblingFromSpecifier("../../capabilities/x.js")).toBe("capabilities");
  });
  it("flags bare '../orchestrator' (no trailing path)", () => {
    expect(siblingFromSpecifier("../orchestrator")).toBe("orchestrator");
  });
  it("allows intra-memory imports (./foo.js)", () => {
    expect(siblingFromSpecifier("./foo.js")).toBeNull();
  });
  it("allows ../utils/logger.js (utils is a permitted sibling)", () => {
    expect(siblingFromSpecifier("../utils/logger.js")).toBeNull();
  });
  it("allows node stdlib specifiers", () => {
    expect(siblingFromSpecifier("node:fs")).toBeNull();
  });
  it("allows external packages", () => {
    expect(siblingFromSpecifier("pg")).toBeNull();
  });
  it("flags all forbidden sibling roots by name", () => {
    for (const sibling of ["ingestion", "capabilities", "orchestrator", "mcp", "server", "analytics", "eval", "monitoring"]) {
      expect(siblingFromSpecifier(`../${sibling}/foo.js`)).toBe(sibling);
    }
  });
  it("allows ../schemas/ (Zod SSOT — leaf like utils)", () => {
    expect(siblingFromSpecifier("../schemas/deal.js")).toBeNull();
  });
});

describe("scanMemoryImports — file-level", () => {
  it("finds an import from ../ingestion in the middle of a file", () => {
    const code = [
      `import { getPool } from "../pg-database.js";`,
      `import { normalize } from "../../ingestion/safety-ratings-fuzzy.js";`,
      `export const x = 1;`,
    ].join("\n");
    const hits = scanMemoryImports(code);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.imported).toBe("ingestion");
  });

  it("finds multiple violations in one file", () => {
    const code = [
      `import { a } from "../capabilities/foo.js";`,
      `import { b } from "../orchestrator/bar.js";`,
    ].join("\n");
    expect(scanMemoryImports(code)).toHaveLength(2);
  });

  it("skips commented-out imports", () => {
    const code = `// import { x } from "../ingestion/foo.js";`;
    expect(scanMemoryImports(code)).toHaveLength(0);
  });

  it("catches `import type` statements too", () => {
    const code = `import type { Foo } from "../ingestion/foo.js";`;
    expect(scanMemoryImports(code)).toHaveLength(1);
  });
});

describe("scanMemoryRoot — current codebase is clean", () => {
  it("src/memory/ has zero upward imports today (memory is a leaf)", () => {
    // Baseline: if this test fails, someone just added a cross-layer import.
    // Re-home the code into src/memory/ (if it's memory-semantics), or move
    // the caller into the right module and invert the dependency.
    const violations = scanMemoryRoot();
    if (violations.length > 0) {
      const preview = violations
        .slice(0, 5)
        .map((v) => `${v.file}:${v.line} → src/${v.imported}`)
        .join("\n");
      throw new Error(`Unexpected memory-import violation:\n${preview}`);
    }
    expect(violations).toEqual([]);
  });
});
