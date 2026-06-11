/**
 * Daemon logs. Two destinations, by design:
 *
 *   1. `~/.openllm/openllmd.log` — the COMBINED stream (every level), one
 *      timestamped JSON line per event, rotated past a size cap. The canonical
 *      `tail -f ~/.openllm/openllmd.log` target.
 *   2. stdout / stderr, split BY LEVEL — `error`/`warn` go to **stderr**,
 *      `info`/`debug` to **stdout**. The launch agent routes those to separate
 *      files (`openllmd.err.log` ← stderr, `openllmd.out.log` ← stdout — see
 *      `service.ts`), so the ERROR log holds only faults + their culprits and
 *      isn't drowned by routine info. systemd's journald captures both streams
 *      together; the split still tags each line's level.
 *
 * The daemon is headless and the control loop deliberately BACKS OFF on errors
 * instead of crashing — so a relay 404, a sealed-open miss, an unreachable
 * cloud, or a SANDBOX-KILLED child used to vanish with no trace. These helpers
 * make every fault land in the error stream with enough context to diagnose it.
 *
 * Best-effort + self-contained: never throws (a logging failure must not take
 * down the daemon), depends only on `stateDir`, rotates past a size cap.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

const logFile = (): string => join(stateDir(), "openllmd.log");
// Rotate past 5MB → `openllmd.log.1` (one generation; the daemon is chatty
// only on errors, and we only need the recent tail to debug).
const MAX_BYTES = 5 * 1024 * 1024;

type TLevel = "error" | "warn" | "info" | "debug";

const serializeErr = (err: unknown): string => {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

const rotateIfBig = (file: string): void => {
  try {
    if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or rotate failed — either way, keep appending.
  }
};

const write = (
  level: TLevel,
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
): void => {
  let line: string;
  try {
    // Serialize INSIDE the guard: a circular / BigInt `meta` would otherwise
    // throw here and escape the logger despite its "never throws" contract.
    line = `${JSON.stringify({
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...(meta !== undefined ? { meta } : {}),
    })}\n`;
  } catch {
    // Unserializable meta — drop it rather than throw; keep the message.
    line = `${JSON.stringify({ ts: new Date().toISOString(), level, scope, message })}\n`;
  }
  try {
    mkdirSync(stateDir(), { recursive: true });
    rotateIfBig(logFile());
    appendFileSync(logFile(), line, { mode: 0o600 });
  } catch {
    // Logging is best-effort — never let it throw into the caller.
  }
  try {
    // The boot readiness sentinel ("openllmd v<VERSION> listening on :<port>")
    // in main.ts must be a single plain-text line on stdout, but all other
    // structured JSON logs go to stderr during bootstrap. The "boot" scope
    // carries the readiness message; send all JSON to stderr so the sentinel
    // stands alone on stdout.
    if (scope === "boot" && level === "info") {
      // Plain sentinel line to stdout (the install-time launcher reads it).
      process.stdout.write(`${message}\n`);
    } else {
      // All other logs (JSON-structured) go to stderr so they don't break
      // the bootstrap readiness contract.
      process.stderr.write(line);
    }
  } catch {
    // streams may be closed under a service manager — ignore.
  }
};

/** Log an error (Error, string, or anything) with an optional context bag. */
export const logError = (
  scope: string,
  err: unknown,
  meta?: Record<string, unknown>,
): void => write("error", scope, serializeErr(err), meta);

export const logWarn = (
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
): void => write("warn", scope, message, meta);

export const logInfo = (
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
): void => write("info", scope, message, meta);

/**
 * Low-severity backoff/weather (a transient cloud hiccup, an abort/timeout on
 * the long-poll). Recorded for context but NOT a fault — keeps the error log
 * free of expected re-dials. See `docs/proposals/daemon-poll-db-resilience.md`.
 */
export const logDebug = (
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
): void => write("debug", scope, message, meta);
