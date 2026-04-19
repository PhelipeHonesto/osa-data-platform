/**
 * Architecture-direction check: src/memory/ (persistence) is a leaf module.
 *
 * It may import from src/utils/ and node/ts stdlib — nothing else. Any
 * import from src/ingestion, src/capabilities, src/orchestrator, src/mcp,
 * src/server, src/analytics, src/eval, or src/monitoring is a direction
 * violation (the application depends on memory; memory must not depend on
 * the application).
 *
 * Exits 1 on any hit.
 *
 * Note: Schema Evolution Rule 6 ("agents must not reference Silver/Gold
 * canonical tables directly — route through MCP tools + Gold views") is a
 * separate check. It's deferred until Phase 2, when Gold views land. At
 * that point src/mcp/tools.ts rewrites to consume views, and we can add
 * a stricter scan.
 *
 * Usage:
 *   npx tsx scripts/check-agent-layer-isolation.ts
 *   npm run lint:layers
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MEMORY_ROOT = "src/memory";

/**
 * Sibling roots under src/ that memory must not import from.
 * src/utils and src/schemas are explicitly allowed — utils is stdlib-like
 * (logger, sentry, haversine), schemas is the Zod SSOT for runtime
 * validation, both leaf modules memory legitimately depends on.
 */
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

interface Violation {
  file: string;
  line: number;
  imported: string;
  context: string;
}

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

/**
 * Given an `import ... from "..."` specifier, return the sibling-under-src
 * directory name if it references one, else null.
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
 *   any absolute "src/..." paths (we don't use those)
 */
export function siblingFromSpecifier(spec: string): string | null {
  // Only care about relative imports that go UP out of memory/.
  if (!spec.startsWith("../")) return null;
  // Strip leading ../ segments, then take the next path segment.
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

async function main(): Promise<void> {
  const violations = scanMemoryRoot();
  if (violations.length === 0) {
    console.log(`[layer-check] ✓ src/memory/ has no upward imports (memory is a leaf — correct).`);
    return;
  }
  console.error(`[layer-check] ✗ Found ${violations.length} direction violation(s):`);
  console.error(`[layer-check]   src/memory/ imports from sibling src/ modules it must not depend on.`);
  console.error(`[layer-check]   The application layer depends on memory, not the other way around.\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  (imports → src/${v.imported})`);
    console.error(`    ${v.context}`);
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
