/**
 * Daemon logs. ONE structured destination, plus native-only stream capture —
 * no duplication between files:
 *
 *   1. `~/.openllm/openllmd.log` — the SINGLE structured log: every level, one
 *      timestamped JSON line per event, rotated past a size cap. The canonical
 *      `tail -f` / `openllmd logs` target. Find faults by grepping
 *      `"level":"error"` (or `"warn"`); every scope is tagged.
 *   2. `openllmd.out.log` / `openllmd.err.log` — the OS supervisor's capture of
 *      the daemon's raw stdout / stderr (launchd `StandardOut/ErrorPath`,
 *      systemd `append:` — see `service.ts`). These are reserved for NATIVE
 *      output the app logger CAN'T produce (Bun panics, uncaught exceptions,
 *      OOM, a sandbox SIGKILL's dying breath). The app does NOT echo its
 *      structured logs to the streams, so out/err NEVER duplicate the combined
 *      log — `err.log` is crash forensics, usually empty in steady state.
 *
 * The one stream write the app makes is the boot readiness line (a plain stdout
 * line → out.log, for humans + the install-time launcher); readiness GATING is
 * the HTTP `/status` probe (`service.ts`), not a stdout parse.
 *
 * The daemon is headless and the control loop deliberately BACKS OFF on errors
 * instead of crashing — so a relay 404, a sealed-open miss, an unreachable
 * cloud, or a SANDBOX-KILLED child used to vanish with no trace. These helpers
 * make every fault land in `openllmd.log` at `error` level with enough context
 * to diagnose it.
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
  let wroteCombinedLog = false;
  try {
    mkdirSync(stateDir(), { recursive: true });
    rotateIfBig(logFile());
    appendFileSync(logFile(), line, { mode: 0o600 });
    wroteCombinedLog = true;
  } catch {
    // Logging is best-effort — never let it throw into the caller.
  }
  try {
    // App structured logs go ONLY to the combined `openllmd.log` (the
    // appendFileSync above). They are deliberately NOT echoed to stdout/stderr:
    // the supervisor-captured `openllmd.out.log` (← stdout) / `openllmd.err.log`
    // (← stderr) are reserved for NATIVE output the app logger can't produce
    // (Bun panics, uncaught crashes, OOM) — so those files never DUPLICATE the
    // combined log. Find app errors by grepping `openllmd.log` for
    // `"level":"error"` (or `openllmd logs`); `err.log` is crash forensics.
    //
    // The ONE exception: the boot readiness line, emitted as a single PLAIN
    // stdout line (→ out.log) for humans + the install-time launcher. Readiness
    // GATING is the HTTP `/status` probe (`service.ts probeHealth`), not a
    // stdout parse, so this line is informational only.
    if (scope === "boot" && level === "info") {
      process.stdout.write(`${message}\n`);
    } else if (!wroteCombinedLog) {
      // Failure-only fallback: when the combined-log file write failed (disk
      // full, perms, read-only FS), echo to stderr so a fault during filesystem
      // trouble isn't a total diagnostics blind spot. In healthy operation this
      // never fires, so out/err stay free of structured-log duplication.
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
