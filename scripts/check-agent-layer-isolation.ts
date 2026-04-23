/**
 * Architecture-direction checks for Dumont.
 *
 * Two rules enforced:
 *
 * 1. Memory is a leaf. src/memory/ may import from src/utils, src/schemas,
 *    and node/ts stdlib only. Any import from src/ingestion, src/capabilities,
 *    src/orchestrator, src/mcp, src/server, src/analytics, src/eval, or
 *    src/monitoring is a direction violation (the application depends on
 *    memory; memory must not depend on the application).
 *
 * 2. Agent does not import from data-platform. Files under agent-side roots
 *    (src/capabilities, src/orchestrator, src/mcp, src/server, src/channels,
 *    src/router, src/integrations, src/eval, src/query, src/templates,
 *    src/fixtures) may not import from data-platform paths (src/ingestion,
 *    src/memory/canonical, src/memory/schema, src/analytics/ — EXCEPT
 *    src/analytics/wingx-queries.ts, which is the one intentional agent-side
 *    read consumer).
 *
 *    This rule guards the agent ↔ data-platform split that Phase 3 relies on.
 *    Shared roots (src/memory/ root files, src/schemas, src/utils,
 *    src/monitoring) are agent-owned SSOT — both sides import them freely.
 *
 * Exits 1 on any hit, 0 clean.
 *
 * Usage:
 *   npx tsx scripts/check-agent-layer-isolation.ts
 *   npm run lint:layers
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// ── Rule 1: memory-as-leaf ─────────────────────────────────────────────────

const MEMORY_ROOT = "src/memory";

const FORBIDDEN_SIBLINGS = [
  "ingestion",
  "capabilities",
  "orchestrator",
  "mcp",
  "server",
  "analytics",
  "eval",
  "monitoring",
];

// ── Rule 2: agent ↔ data-platform boundary ────────────────────────────────

const AGENT_ROOTS = [
  "src/capabilities",
  "src/orchestrator",
  "src/mcp",
  "src/server",
  "src/channels",
  "src/router",
  "src/integrations",
  "src/eval",
  "src/query",
  "src/templates",
  "src/fixtures",
];

const DATA_PLATFORM_FORBIDDEN_PREFIXES = [
  "src/ingestion/",
  "src/memory/canonical/",
  "src/memory/schema/",
];

// Analytics is forbidden as a whole EXCEPT these specific files — the
// agent-side read paths that legitimately consume computed analytics.
// Each entry is a src-relative path without extension.
const ANALYTICS_EXEMPT: ReadonlySet<string> = new Set([
  "src/analytics/wingx-queries",
  "src/analytics/quality-queries",
]);

// ── Shared types ───────────────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  imported: string;
  context: string;
}

// ── File-walk helper ───────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(p);
    }
  } catch {
    // dir missing — skip
  }
  return out;
}

// ── Rule 1 implementation ──────────────────────────────────────────────────

/**
 * Given an `import ... from "..."` specifier in a memory/ file, return the
 * sibling-under-src directory name if it references a forbidden one, else null.
 *
 * Handles:
 *   "../ingestion/foo.js"            → "ingestion"
 *   "../../capabilities/bar.js"      → "capabilities"
 *   "../ingestion"                    → "ingestion"
 * Does NOT flag:
 *   "./foo.js"                        (intra-memory)
 *   "../utils/logger.js"              (utils is allowed)
 *   "node:fs"                         (node stdlib)
 *   "pg"                              (external package)
 */
export function siblingFromSpecifier(spec: string): string | null {
  if (!spec.startsWith("../")) return null;
  const segments = spec.split("/");
  let i = 0;
  while (i < segments.length && segments[i] === "..") i++;
  const next = segments[i];
  if (!next) return null;
  if (!FORBIDDEN_SIBLINGS.includes(next)) return null;
  return next;
}

export function scanMemoryImports(content: string): Array<{ line: number; imported: string; context: string }> {
  const out: Array<{ line: number; imported: string; context: string }> = [];
  const lines = content.split("\n");
  const importRe = /from\s+["']([^"']+)["']/;
  const typeImportRe = /import\s+type\s+.*from\s+["']([^"']+)["']/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith("//")) continue;
    const m = line.match(importRe) ?? line.match(typeImportRe);
    if (!m || !m[1]) continue;
    const sibling = siblingFromSpecifier(m[1]);
    if (sibling) out.push({ line: i + 1, imported: sibling, context: line.trim() });
  }
  return out;
}

export function scanMemoryRoot(root: string = MEMORY_ROOT): Violation[] {
  const all: Violation[] = [];
  for (const path of walk(root)) {
    const content = readFileSync(path, "utf-8");
    const hits = scanMemoryImports(content);
    for (const h of hits) {
      all.push({ file: path, ...h });
    }
  }
  return all;
}

// ── Rule 2 implementation ──────────────────────────────────────────────────

/**
 * Resolve a relative import specifier from the perspective of a file,
 * returning the src-relative path without extension. Returns null for
 * non-relative specifiers (external packages, node: stdlib) or targets
 * outside src/.
 */
export function resolveSrcRelative(filePath: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  // join(dirname(filePath), spec) collapses ".." segments and normalizes separators.
  const resolved = join(dirname(filePath), spec).replace(/\\/g, "/");
  const withoutExt = resolved.replace(/\.(js|ts)$/, "");
  if (!withoutExt.startsWith("src/")) return null;
  return withoutExt;
}

/**
 * Classify an import from an agent-side file. Returns the forbidden prefix
 * if the target is data-platform territory, or null if the import is allowed.
 *
 * `src/analytics/wingx-queries.ts` is the one exception — agent-side MCP
 * tools and server routes consume it as the read layer.
 */
export function agentToDataPlatformImport(filePath: string, spec: string): string | null {
  const target = resolveSrcRelative(filePath, spec);
  if (!target) return null;

  if (target.startsWith("src/analytics/")) {
    for (const exempt of ANALYTICS_EXEMPT) {
      if (target.startsWith(exempt)) return null;
    }
    return "src/analytics/";
  }

  for (const prefix of DATA_PLATFORM_FORBIDDEN_PREFIXES) {
    if (target.startsWith(prefix)) return prefix;
  }

  return null;
}

export function scanAgentImports(
  filePath: string,
  content: string,
): Array<{ line: number; target: string; context: string }> {
  const out: Array<{ line: number; target: string; context: string }> = [];
  const lines = content.split("\n");
  const importRe = /from\s+["']([^"']+)["']/;
  const typeImportRe = /import\s+type\s+.*from\s+["']([^"']+)["']/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith("//")) continue;
    const m = line.match(importRe) ?? line.match(typeImportRe);
    if (!m || !m[1]) continue;
    const target = agentToDataPlatformImport(filePath, m[1]);
    if (target) out.push({ line: i + 1, target, context: line.trim() });
  }
  return out;
}

export function scanAgentRoots(roots: string[] = AGENT_ROOTS): Violation[] {
  const all: Violation[] = [];
  for (const root of roots) {
    for (const filePath of walk(root)) {
      const content = readFileSync(filePath, "utf-8");
      const hits = scanAgentImports(filePath, content);
      for (const h of hits) {
        all.push({ file: filePath, line: h.line, imported: h.target, context: h.context });
      }
    }
  }
  return all;
}

// ── CLI / main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const memoryViolations = scanMemoryRoot();
  const agentViolations = scanAgentRoots();

  if (memoryViolations.length === 0 && agentViolations.length === 0) {
    console.log(
      `[layer-check] ✓ memory is a leaf + agent does not import from data-platform (both rules pass).`,
    );
    return;
  }

  if (memoryViolations.length > 0) {
    console.error(`[layer-check] ✗ Rule 1 (memory leaf) — ${memoryViolations.length} violation(s):`);
    console.error(`[layer-check]   src/memory/ imports from sibling src/ modules it must not depend on.`);
    console.error(`[layer-check]   The application layer depends on memory, not the other way around.\n`);
    for (const v of memoryViolations) {
      console.error(`  ${v.file}:${v.line}  (imports → src/${v.imported})`);
      console.error(`    ${v.context}`);
    }
  }

  if (agentViolations.length > 0) {
    if (memoryViolations.length > 0) console.error("");
    console.error(`[layer-check] ✗ Rule 2 (agent ↔ data-platform) — ${agentViolations.length} violation(s):`);
    console.error(`[layer-check]   Agent code must not import from src/ingestion, src/memory/canonical,`);
    console.error(`[layer-check]   src/memory/schema, or src/analytics/ (except wingx-queries.ts).\n`);
    for (const v of agentViolations) {
      console.error(`  ${v.file}:${v.line}  (imports → ${v.imported})`);
      console.error(`    ${v.context}`);
    }
  }

  process.exit(1);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    console.error(`[layer-check] fatal:`, err);
    process.exit(2);
  });
}
