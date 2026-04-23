/**
 * Sentry error reporting — Phase 15 Step 2.
 *
 * Thin safe wrapper. If SENTRY_DSN is unset every function is a no-op so
 * local dev and test runs never try to reach Sentry.
 *
 * Bridged from pino via a logMethod hook in src/utils/logger.ts:
 *   - log.error(obj, msg) → captureException
 *   - log.fatal(obj, msg) → captureFatal
 *   - warn / info / debug never hit Sentry (free-tier budget protection)
 */
import * as Sentry from "@sentry/node";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

let initialized = false;

const SCRUB_KEY_RE = /dsn|api[_-]?key|token|secret|password|auth/i;
const SCRUB_VALUES = new Set<string>(
  [
    "SUPABASE_DATABASE_URL",
    "ANTHROPIC_API_KEY",
    "MCP_AUTH_TOKEN",
    "VAPI_SECRET",
    "SENTRY_DSN",
    "GITHUB_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]
    .map((k) => process.env[k])
    .filter((v): v is string => typeof v === "string" && v.length >= 8),
);

/** Recursively scrub values whose key matches the sensitive-key regex, or whose
 *  value matches one of the known env-var secrets. Bounds recursion depth so
 *  a cyclic object can't hang the hook. */
export function scrubSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 8) return obj;
  if (obj == null) return obj;
  if (typeof obj === "string") {
    for (const secret of SCRUB_VALUES) {
      if (obj.includes(secret)) return "[REDACTED]";
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => scrubSecrets(v, depth + 1));
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SCRUB_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = scrubSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env["SENTRY_DSN"];
  if (!dsn) return; // no-op when DSN unset

  Sentry.init({
    dsn,
    environment: process.env["NODE_ENV"] ?? "development",
    release: readVersion(),
    tracesSampleRate: 0.1,
    beforeSend: (event) => scrubSecrets(event) as Sentry.ErrorEvent,
  });
  initialized = true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

/** Capture an exception. Safe to call whether Sentry is initialized or not. */
export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (extra) {
      const scrubbed = scrubSecrets(extra) as Record<string, unknown>;
      for (const [k, v] of Object.entries(scrubbed)) {
        if (k === "component" && typeof v === "string") scope.setTag("component", v);
        else scope.setExtra(k, v);
      }
    }
    if (err instanceof Error) {
      Sentry.captureException(err);
    } else if (err != null) {
      Sentry.captureException(new Error(typeof err === "string" ? err : JSON.stringify(err)));
    } else {
      Sentry.captureMessage(
        typeof extra?.["msg"] === "string" ? extra["msg"] : "error (no err object)",
        "error",
      );
    }
  });
}

/** Capture a fatal-level event. Same as captureException but tagged level=fatal. */
export function captureFatal(err: unknown, extra?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    scope.setLevel("fatal");
    if (extra) {
      const scrubbed = scrubSecrets(extra) as Record<string, unknown>;
      for (const [k, v] of Object.entries(scrubbed)) {
        if (k === "component" && typeof v === "string") scope.setTag("component", v);
        else scope.setExtra(k, v);
      }
    }
    if (err instanceof Error) {
      Sentry.captureException(err);
    } else if (err != null) {
      Sentry.captureException(new Error(typeof err === "string" ? err : JSON.stringify(err)));
    } else {
      Sentry.captureMessage(
        typeof extra?.["msg"] === "string" ? extra["msg"] : "fatal (no err object)",
        "fatal",
      );
    }
  });
}

/** Flush pending events. Call before process.exit to avoid losing the final batch. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // best-effort
  }
}

/** Register uncaughtException + unhandledRejection handlers that log.fatal,
 *  flush Sentry, and exit. Uses stderr directly (not pino) because an
 *  uncaught exception may have left the logger in an undefined state, and
 *  a static import of logger.js would form a cycle. */
export function installProcessHandlers(component: string): void {
  const emitFatal = (err: unknown, reason: "uncaughtException" | "unhandledRejection") => {
    const line = JSON.stringify({
      level: 60,
      time: Date.now(),
      service: "osa-dumont",
      version: readVersion(),
      component,
      reason,
      err: err instanceof Error
        ? { type: err.name, message: err.message, stack: err.stack }
        : { value: String(err) },
      msg: reason,
    });
    try { process.stderr.write(line + "\n"); } catch { /* best-effort */ }
  };

  process.on("uncaughtException", (err) => {
    emitFatal(err, "uncaughtException");
    captureFatal(err, { component, reason: "uncaughtException" });
    void flushSentry().finally(() => setTimeout(() => process.exit(1), 200));
  });
  process.on("unhandledRejection", (reason) => {
    emitFatal(reason, "unhandledRejection");
    captureFatal(reason, { component, reason: "unhandledRejection" });
    void flushSentry().finally(() => setTimeout(() => process.exit(1), 200));
  });
}
