/**
 * Daemon error log → a file under the state dir (`~/.openllm/openllmd.log`).
 *
 * The daemon is headless (launchd / systemd swallow stdout+stderr) and the
 * control loop deliberately BACKS OFF on errors instead of crashing — so a
 * relay 404, a sealed-open miss, or an unreachable cloud used to vanish with
 * no trace. This appends one timestamped JSON line per event so a user can
 * `tail -f ~/.openllm/openllmd.log` (or paste it) to see exactly what broke.
 *
 * Best-effort + self-contained: it never throws (a logging failure must not
 * take down the daemon), depends only on `stateDir`, and rotates once past a
 * size cap so a long-lived daemon can't fill the disk. It also echoes to
 * stderr so `journalctl --user -u openllmd` / `log show` capture it live.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

const logFile = (): string => join(stateDir(), "openllmd.log");
// Rotate past 5MB → `openllmd.log.1` (one generation; the daemon is chatty
// only on errors, and we only need the recent tail to debug).
const MAX_BYTES = 5 * 1024 * 1024;

type TLevel = "error" | "warn" | "info";

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
    process.stderr.write(line);
  } catch {
    // stderr may be closed under a service manager — ignore.
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
