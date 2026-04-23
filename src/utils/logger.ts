/**
 * Structured logger (pino) for Dumont.
 *
 * - Writes to stderr (not stdout) so the MCP stdio server stays uncorrupted
 *   and CLI scripts can still print data tables to stdout cleanly.
 * - Pretty-printed in dev (TTY + non-production), JSON in prod.
 * - Level from LOG_LEVEL env var, default 'info'.
 * - Base fields: service, version, pid, hostname (pino adds pid/hostname).
 * - error and fatal events are bridged to Sentry via the logMethod hook
 *   (Phase 15 Step 2). warn/info/debug stay local to protect free-tier
 *   event budget.
 *
 * Usage:
 *   import { childLogger } from "../utils/logger.js";
 *   const log = childLogger("faa-daily-diff");
 *   log.info({ rows: 12345, duration_ms: 4200 }, "diff complete");
 *   log.error({ err, context: { date } }, "processing failed");
 */
import pino, { type Logger, type LoggerOptions } from "pino";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { captureException, captureFatal } from "./sentry.js";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const isProd = process.env["NODE_ENV"] === "production";
const isTTY = process.stderr.isTTY === true;
const usePretty = !isProd && isTTY;

/** Pino level numbers: error=50, fatal=60. Bridge these (and nothing else). */
function bridgeToSentry(this: Logger, args: unknown[], level: number): void {
  const [first, second] = args;
  let err: unknown;
  let extra: Record<string, unknown> = {};
  let msg: string | undefined;

  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    const obj = first as Record<string, unknown>;
    err = obj["err"];
    extra = { ...obj };
    delete extra["err"];
    if (typeof second === "string") msg = second;
  } else if (typeof first === "string") {
    msg = first;
  }

  // Thread the component binding through as a Sentry tag (grouping).
  const bindings = this.bindings() as { component?: string };
  if (bindings.component) extra["component"] = bindings.component;
  if (msg) extra["msg"] = msg;

  if (level >= 60) {
    captureFatal(err, extra);
  } else {
    captureException(err, extra);
  }
}

const baseOptions: LoggerOptions = {
  level: process.env["LOG_LEVEL"] ?? "info",
  base: {
    service: "osa-dumont",
    version: readVersion(),
  },
  hooks: {
    logMethod(this: Logger, args, method, level) {
      method.apply(this, args as Parameters<typeof method>);
      if (typeof level === "number" && level >= 50) {
        try {
          bridgeToSentry.call(this, args, level);
        } catch {
          // never let Sentry bridge crash the log path
        }
      }
    },
  },
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            destination: 2, // stderr
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname,service,version",
            messageFormat: "{component} | {msg}",
          },
        },
      }
    : {}),
};

export const logger: Logger = usePretty
  ? pino(baseOptions)
  : pino(baseOptions, pino.destination({ dest: 2, sync: false }));

export function childLogger(component: string): Logger {
  return logger.child({ component });
}
