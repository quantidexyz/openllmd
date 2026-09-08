/**
 * Spawn helpers for official-CLI delegation: capture runs, browser/PTY
 * login spawns, and terminal-output hygiene. Split out of `util.ts`
 * (which re-exports everything here — import from either).
 *
 * Bright line (proposal §6): nothing read from a CLI's store may be sent
 * off-box. These helpers feed the LOCAL runner + the local usage panel
 * only.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import type { TSuperviseSpawnOptions } from "../child-supervisor";
import { superviseSpawn } from "../child-supervisor";
import type { TCliVersionOpts } from "../cli-version-cache";
import { cachedCliVersion } from "../cli-version-cache";
import { spawnCommand } from "../command";
import {
  budgetFromSignal,
  createDeadlineBudget,
  splitReapBudget,
  timeoutCallbackLatenessMs,
} from "../deadline-budget";
import { noteNativeAuthTimeout } from "../doctor-report/hooks";
import { logDebug, logError, logWarn } from "../logger";
import { currentTickId } from "../op-context";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { daemonTempDir } from "../sandbox/working-set";
import { redactSensitiveArgv } from "./redact-sensitive-argv";

/** Merge an env map onto the parent env for a spawned isolated CLI. */
export const spawnEnv = (
  env: Record<string, string> | undefined,
): Record<string, string | undefined> | undefined =>
  env === undefined ? undefined : { ...process.env, ...env };

/**
 * The working directory for a spawned isolated CLI. SECURITY: the daemon runs
 * with cwd `/` (launchd/systemd start it with no `WorkingDirectory`), and a
 * child inherits it. A vendor CLI launched at `/` enumerates project context
 * from the filesystem ROOT — statting `/Volumes/*`, which on macOS trips the
 * TCC "wants to access files on a network volume" consent prompt (attributed to
 * the daemon as the responsible parent) and needlessly walks the whole disk.
 *
 * So pin the cwd to the child's OWN isolated home (`env.HOME`, e.g.
 * `~/.openllm/cli/claude_code/home` for claude) — which `cliEnv` always sets and
 * the sandbox working set grants read-write — so the CLI's project scan is
 * confined to its empty isolated home, NEVER `/`. Falls back to the daemon-owned
 * temp dir (always created + granted) when no isolated HOME is present or the
 * home dir doesn't yet exist (a not-yet-created cwd would make `Bun.spawn`
 * `ENOENT`). Never returns `/`.
 */
export const spawnCwd = (env: Record<string, string> | undefined): string => {
  const home = env?.HOME;
  // Reject `/` explicitly: it "exists", so an env with `HOME=/` (or a daemon
  // whose HOME wasn't isolated) would otherwise pass the existsSync check and
  // re-introduce the exact root-cwd bug this helper exists to prevent.
  if (home !== undefined && home.length > 0 && home !== "/" && existsSync(home))
    return home;
  return daemonTempDir();
};

/**
 * Surface a child that was KILLED BY A SIGNAL (`signalCode` set) — the silent
 * failure mode behind "the flow doesn't trigger, no errors". The OS sandbox
 * SIGKILLs/SIGABRTs a child that hits a denied operation, and a plain exit-code
 * check misses it. Logging the command + signal at ERROR level puts the actual
 * culprit in `openllmd.err.log` instead of letting it vanish. Returns whether a
 * kill was detected (so callers can treat it as a definite failure). No-op for
 * a clean exit.
 */
export type TLogIfKilledOpts = {
  /**
   * Whether the killed child ran through the `--sandbox-exec` shim. The
   * "OS sandbox denial" hint is only defensible for a CONFINED child; a
   * `probe:true` spawn runs UNWRAPPED (see {@link sandboxSpawnArgs}), so a
   * signal death there cannot be a Seatbelt denial — it's an external signal
   * (a daemon restart/drain, a manual kill). Blaming the sandbox there actively
   * misdirects diagnosis. Defaults to `true` (confined) when the caller can't
   * say, preserving the historical hint for unknown call sites.
   */
  readonly confined?: boolean;
};

export const logIfKilled = (
  argv: ReadonlyArray<string>,
  proc: {
    readonly signalCode: string | null;
    readonly exitCode: number | null;
  },
  opts?: TLogIfKilledOpts,
): boolean => {
  // The `--sandbox-exec` shim mirrors a signal death of its tail as exit code
  // `128 + N` (the daemon-side proc is the SHIM, so its signalCode is null) —
  // without this mapping a sandbox kill of a wrapped child is invisible here
  // and the spawn just looks like a quiet non-zero exit. A CLI can exit 130
  // by its own convention (ctrl-c), so this is a diagnostic breadcrumb, not a
  // hard verdict.
  const signal =
    proc.signalCode ??
    (proc.exitCode !== null && proc.exitCode > 128 && proc.exitCode <= 128 + 31
      ? (SIGNAL_NAMES[proc.exitCode - 128] ?? `signal ${proc.exitCode - 128}`)
      : null);
  if (signal === null) return false;
  // Only a CONFINED child can be Seatbelt-denied. An unconfined (`probe`) kill
  // is an EXTERNAL signal — attributing it to the sandbox sent a real incident's
  // diagnosis down a dead end. Default to the sandbox hint only when confinement
  // is unknown or true.
  const confined = opts?.confined !== false;
  logError("delegation", `child killed by ${signal}`, {
    command: argv[0],
    argv: [...argv],
    signal,
    confined,
    hint: confined
      ? "likely an OS sandbox denial — see DaemonStatus.sandbox / the sandbox working set"
      : "external signal on an unconfined child — likely a daemon restart/drain or manual kill (the sandbox was not involved)",
  });
  return true;
};

/** Conventional signal number → name, for the shim's `128 + N` exit mirror. */
const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  7: "SIGBUS",
  8: "SIGFPE",
  9: "SIGKILL",
  10: "SIGUSR1",
  11: "SIGSEGV",
  12: "SIGUSR2",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};

/** Hard ceiling for one-shot vendor CLI captures and probes. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 5_000;
const MIN_CAPTURE_TIMEOUT_MS = 250;

const captureTimeoutMs = (timeoutMs: number | undefined): number =>
  Math.max(MIN_CAPTURE_TIMEOUT_MS, timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);

export type TRunCaptureOpts = {
  /** Skip the sandbox shim for a read-only probe that needs direct execution. */
  readonly probe?: boolean;
  /** Classify the disposable child independently of sandbox-shim behavior. */
  readonly kind?: "probe" | "vendor-capture";
  /** Hard ceiling for stdout capture plus child exit before group termination. */
  readonly timeoutMs?: number;
  /** Early-cancel: terminate the process group when aborted (status-probe race). */
  readonly signal?: AbortSignal;
  /** Exit 0 with empty stdout is success (logout prints nothing). */
  readonly allowEmpty?: boolean;
  /**
   * When set, stop reading stdout after this many bytes and treat overflow
   * as failure. Version probes pass a small cap so a hung printer cannot
   * fill memory/disk.
   */
  readonly maxBytes?: number;
  readonly producer?: TNativeAuthProducer;
  readonly operationId?: string;
};

/** Subscribe to `signal` abort; invoke `onAbort` immediately if already aborted. */
export const bindAbort = (
  signal: AbortSignal | undefined,
  onAbort: () => void,
): (() => void) => {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return (): void => {
    signal.removeEventListener("abort", onAbort);
  };
};

type TCaptureOutcome =
  | { readonly kind: "complete"; readonly out: string; readonly code: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | { readonly kind: "overflow" };

type TCaptureCompleteHook = () => void;

let captureCompleteHookForTests: TCaptureCompleteHook | null = null;

/** Test-only: run after `complete` settles, before `Promise.race` reactions. */
export const setCaptureCompleteHookForTests = (
  hook: TCaptureCompleteHook | null,
): void => {
  captureCompleteHookForTests = hook;
};

type TCaptureTimeoutScheduler = (
  callback: () => void,
  delayMs: number,
) => ReturnType<typeof setTimeout>;

let captureTimeoutSchedulerForTests: TCaptureTimeoutScheduler | null = null;
let loginTimeoutSchedulerForTests: TCaptureTimeoutScheduler | null = null;

export type TNativeAuthProducer = "claude-refresh" | "claude-auth-status";

let nativeAuthOperationSeq = 0;

/** Ephemeral correlation id for one native-auth child. Not an account identity. */
export const newNativeAuthOperationId = (): string => {
  nativeAuthOperationSeq += 1;
  return `na-${nativeAuthOperationSeq.toString(36)}-${Math.floor(performance.now()).toString(36)}`;
};

/**
 * Test-only: replace the capture watchdog `setTimeout`. Used to inject a
 * delayed fire for lateness fields. Production always uses `setTimeout`.
 */
export const setCaptureTimeoutSchedulerForTests = (
  scheduler: TCaptureTimeoutScheduler | null,
): void => {
  captureTimeoutSchedulerForTests = scheduler;
};

/**
 * Test-only: replace the login watchdog `setTimeout`. Used to inject a
 * delayed fire for lateness fields. Production always uses `setTimeout`.
 */
export const setLoginTimeoutSchedulerForTests = (
  scheduler: TCaptureTimeoutScheduler | null,
): void => {
  loginTimeoutSchedulerForTests = scheduler;
};

export type TRunCaptureResult =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed" };

/**
 * Run a command and capture trimmed stdout. Distinguishes timeout from
 * abort / non-zero / empty / spawn failure. stdin is ignored so it never
 * blocks. `env` is merged onto the parent env — used to run the isolated vendor
 * CLIs with their home pointed inside the OpenLLM dir.
 *
 * The stdout read and root child exit share one hard deadline. On expiry, use
 * the supervisor's process-group termination rather than `proc.kill()`: a
 * descendant holding the inherited stdout fd must be reaped for EOF to occur.
 */
export const runCaptureResult = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string>,
  opts?: TRunCaptureOpts,
): Promise<TRunCaptureResult> => {
  if (opts?.signal?.aborted === true) return { kind: "aborted" };
  try {
    const setupStartedAtMs = performance.now();
    const command = spawnCommand(
      process.platform,
      argv[0] ?? "",
      argv.slice(1),
    );
    const spawnOptions: TSuperviseSpawnOptions = {
      kind: opts?.kind ?? (opts?.probe === true ? "probe" : "vendor-capture"),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      cwd: spawnCwd(env),
      ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
    };
    const child = superviseSpawn(
      sandboxSpawnArgs(command, { probe: opts?.probe }),
      spawnOptions,
    );
    const spawnedAtMs = performance.now();
    const spawnSetupMs = spawnedAtMs - setupStartedAtMs;
    const proc = child.subprocess;
    if (opts?.producer !== undefined) {
      logDebug("spawn", "native auth child started", {
        producer: opts.producer,
        ...(opts.operationId !== undefined
          ? { operation_id: opts.operationId }
          : {}),
        phase: "start",
        child_pid: typeof proc.pid === "number" ? proc.pid : null,
        tick_id: currentTickId(),
        configured_timeout_ms: captureTimeoutMs(opts.timeoutMs),
        spawn_setup_ms: spawnSetupMs,
        clock: "performance.now",
      });
    }
    const stdout = proc.stdout;
    if (stdout === undefined || typeof stdout === "number") {
      await child.terminate();
      return { kind: "failed" };
    }
    const configuredTimeoutMs = captureTimeoutMs(opts?.timeoutMs);
    const parentBudget = budgetFromSignal(opts?.signal);
    const budget =
      parentBudget?.child(configuredTimeoutMs) ??
      createDeadlineBudget(configuredTimeoutMs, opts?.signal);
    const remainingAtSpawn = budget.remainingMs();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timerArmedAtMs: number | null = null;
    let timerFiredAtMs: number | null = null;
    let timerDelayMs = remainingAtSpawn;
    let stdoutClosed = false;
    let rootExitCode: number | null = null;
    const unbind = bindAbort(opts?.signal, () => {
      void child.terminate(splitReapBudget(budget.remainingMs()));
    });
    let unbindAbortWait = (): void => {};
    try {
      const readStdout = async (): Promise<{
        readonly out: string;
        readonly overflow: boolean;
      }> => {
        const cap = opts?.maxBytes;
        if (cap === undefined || cap <= 0) {
          const out = await new Response(stdout).text();
          return { out, overflow: false };
        }
        const reader = stdout.getReader();
        const chunks: Uint8Array[] = [];
        let n = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;
            n += value.byteLength;
            if (n > cap) {
              try {
                await reader.cancel();
              } catch {
                // already closed
              }
              return { out: "", overflow: true };
            }
            chunks.push(value);
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // already released
          }
        }
        const merged = new Uint8Array(n);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
        return { out: new TextDecoder().decode(merged), overflow: false };
      };
      void proc.exited.then((code) => {
        rootExitCode = code;
      });
      const complete = (async (): Promise<TCaptureOutcome> => {
        const read = await readStdout().finally(() => {
          stdoutClosed = true;
        });
        if (read.overflow) return { kind: "overflow" };
        const code = await proc.exited;
        return { kind: "complete", out: read.out, code };
      })();
      const scheduleTimeout =
        captureTimeoutSchedulerForTests ??
        ((
          callback: () => void,
          delayMs: number,
        ): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs));
      const timeout = new Promise<TCaptureOutcome>((resolve) => {
        timerDelayMs = budget.remainingMs();
        timerArmedAtMs = performance.now();
        timer = scheduleTimeout(() => {
          timerFiredAtMs = performance.now();
          resolve({ kind: "timeout" });
        }, timerDelayMs);
      });
      const abortWait =
        opts?.signal === undefined
          ? null
          : new Promise<TCaptureOutcome>((resolve) => {
              unbindAbortWait = bindAbort(opts.signal, () =>
                resolve({ kind: "aborted" }),
              );
            });
      if (captureCompleteHookForTests !== null) {
        const hook = captureCompleteHookForTests;
        void complete.then(() => {
          hook();
        });
      }
      const outcome = await Promise.race(
        abortWait === null
          ? [complete, timeout]
          : [complete, timeout, abortWait],
      );
      const raceObservedAtMs = performance.now();
      // Race winner is authoritative. Unbind before branching so a late abort
      // cannot flip the shared flag and discard a completed stdout.
      unbind();
      unbindAbortWait();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (outcome.kind === "timeout") {
        const stdoutClosedAtRace = stdoutClosed;
        const rootExitedAtRace =
          rootExitCode !== null ||
          proc.exitCode !== null ||
          proc.signalCode !== null;
        const rootExitCodeAtRace = rootExitCode ?? proc.exitCode;
        const cleanupStartedAtMs = performance.now();
        await child.terminate(splitReapBudget(budget.remainingMs()));
        const cleanupMs = performance.now() - cleanupStartedAtMs;
        const armed = timerArmedAtMs ?? spawnedAtMs;
        const fired = timerFiredAtMs ?? raceObservedAtMs;
        logWarn("spawn", "capture timed out", {
          configured_timeout_ms: configuredTimeoutMs,
          deadline_ms: remainingAtSpawn,
          remaining_at_spawn_ms: remainingAtSpawn,
          budget_remaining_ms_at_spawn: remainingAtSpawn,
          spawn_elapsed_ms: raceObservedAtMs - spawnedAtMs,
          spawn_setup_ms: spawnSetupMs,
          timer_armed_at_ms: armed,
          timer_fired_at_ms: fired,
          race_observed_at_ms: raceObservedAtMs,
          timeout_callback_lateness_ms: timeoutCallbackLatenessMs(
            armed,
            fired,
            timerDelayMs,
          ),
          stdout_closed: stdoutClosedAtRace,
          root_exited: rootExitedAtRace,
          root_exit_code: rootExitCodeAtRace,
          cleanup_ms: cleanupMs,
          clock: "performance.now",
          child_pid: typeof proc.pid === "number" ? proc.pid : null,
          tick_id: currentTickId(),
          kind: spawnOptions.kind,
          probe: opts?.probe === true,
          reason_code: "timeout",
          ...(opts?.producer !== undefined ? { producer: opts.producer } : {}),
          ...(opts?.operationId !== undefined
            ? { operation_id: opts.operationId }
            : {}),
          ...(opts?.producer === undefined
            ? { argv: redactSensitiveArgv(argv) }
            : {}),
        });
        noteNativeAuthTimeout({
          trigger:
            opts?.producer === "claude-refresh"
              ? "refresh"
              : opts?.producer === "claude-auth-status"
                ? "status_poll"
                : opts?.producer !== undefined
                  ? "native_login"
                  : "capture",
          operation:
            opts?.producer === "claude-refresh"
              ? "refresh"
              : opts?.producer === "claude-auth-status"
                ? "probe"
                : opts?.producer !== undefined
                  ? "native_auth"
                  : "capture",
          timings: {
            configured_timeout_ms: configuredTimeoutMs,
            spawn_elapsed_ms: raceObservedAtMs - spawnedAtMs,
            budget_remaining_ms_at_spawn: remainingAtSpawn,
            timeout_callback_lateness_ms: timeoutCallbackLatenessMs(
              armed,
              fired,
              timerDelayMs,
            ),
            cleanup_ms: cleanupMs,
            stdout_closed: stdoutClosedAtRace,
            root_exited: rootExitedAtRace,
            ...(typeof rootExitCodeAtRace === "number"
              ? { root_exit_code: rootExitCodeAtRace }
              : {}),
          },
        });
        return { kind: "timeout" };
      }
      if (outcome.kind === "aborted") {
        await child.terminate(splitReapBudget(budget.remainingMs()));
        return { kind: "aborted" };
      }
      if (outcome.kind === "overflow") {
        await child.terminate(splitReapBudget(budget.remainingMs()));
        return { kind: "failed" };
      }
      // `probe:true` runs UNWRAPPED — a signal death there is not a sandbox
      // denial (this was the mislabeled `--version` status-probe drain).
      logIfKilled(redactSensitiveArgv(argv), proc, {
        confined: opts?.probe !== true,
      });
      if (outcome.code !== 0) return { kind: "failed" };
      const trimmed = outcome.out.trim();
      if (trimmed.length > 0) return { kind: "ok", text: trimmed };
      return opts?.allowEmpty === true
        ? { kind: "ok", text: "" }
        : { kind: "failed" };
    } finally {
      unbind();
      unbindAbortWait();
      if (timer !== null) clearTimeout(timer);
    }
  } catch {
    return { kind: "failed" };
  }
};

/** Run a command and capture trimmed stdout (best-effort). Returns null on
 *  spawn failure, non-zero exit, abort, or a timeout. */
export const runCapture = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string>,
  opts?: TRunCaptureOpts,
): Promise<string | null> => {
  const result = await runCaptureResult(argv, env, opts);
  return result.kind === "ok" ? result.text : null;
};

/** Run a binary's `--version` (best-effort). Returns null on failure.
 *  UNWRAPPED (`probe: true`): a fixed-argv, read-only `<bin> --version` is the
 *  canonical skip-the-shim probe (see {@link TSandboxSpawnOpts.probe}). Leaving
 *  it confined was a latent bug — harmless while `--version` was a pure print,
 *  but the `openllm` CLI's `--version` now spawns a nested `openllmd --version`
 *  child, and a confined caller spawning that child can be Seatbelt/Landlock
 *  denied (→ null → the CLI converger's "did not report a version" skip).
 *  Stamp-keyed via {@link cachedCliVersion}: success and completed failure
 *  reuse until the resolved binary identity changes (no TTL). */
export const cliVersion = (
  bin: string,
  env?: Record<string, string>,
  opts?: TCliVersionOpts,
): Promise<string | null> => cachedCliVersion(bin, env, opts);

export type TLoginResult = {
  readonly code: number;
  /** Combined stdout+stderr (trimmed), for surfacing failures. */
  readonly output: string;
  /** True when we abandoned the child (early `until` match or timeout) rather
   *  than it exiting on its own — its OUTPUT is still valid (the token/cred was
   *  produced first), it just never cleanly exited. */
  readonly abandoned: boolean;
  /** Wall clock immediately after `superviseSpawn`. Null when no child ran. */
  readonly spawned_at_ms: number | null;
  /** Child pid immediately after `superviseSpawn`. Null when no child ran. */
  readonly child_pid: number | null;
};

const noChildResult = (abandoned: boolean): TLoginResult => ({
  code: -1,
  output: "",
  abandoned,
  spawned_at_ms: null,
  child_pid: null,
});

const spawnStamp = (proc: {
  readonly pid?: number;
}): Pick<TLoginResult, "spawned_at_ms" | "child_pid"> => ({
  spawned_at_ms: Date.now(),
  child_pid: typeof proc.pid === "number" ? proc.pid : null,
});

export type TSpawnLoginOpts = {
  /** Hard ceiling: kill the child after this and return what was captured.
   *  A browser OAuth needs the user to sign in, so it's generous. */
  readonly timeoutMs?: number;
  /** When the COMBINED output matches this, the child has produced what we
   *  need (e.g. a printed verification prompt) — kill it and return immediately
   *  instead of waiting for it to exit. Vendor CLIs (themselves Bun/Node
   *  binaries) can hang in `__cxa_finalize`/atexit AFTER printing it, so waiting
   *  on `proc.exited` would block forever + pile up 99%-CPU runaways. We don't
   *  need the exit — only the output. */
  readonly until?: RegExp;
  /** Skip the `--sandbox-exec` wrap (see `TSandboxSpawnOpts.probe`). REQUIRED
   *  for children that must operate a macOS-keychain-backed credential store
   *  (claude/cursor status + refresh): securityd refuses keychain reads for a
   *  Seatbelt-confined caller, so a wrapped spawn reports "not signed in" and
   *  a wrapped refresh silently never persists the rotated token. */
  readonly probe?: boolean;
  /** Early-cancel the login child. Refresh must not pass an observer abort here. */
  readonly signal?: AbortSignal;
  /**
   * Refresh-only: after the spawn deadline fires, decide whether to defer
   * SIGTERM for {@link TSpawnLoginOpts.persistenceGraceMs}. True only when a
   * validated newer store is already visible. The child stays supervised; a
   * later exit or bounded terminate still finalizes ownership.
   */
  readonly onDeadline?: () => boolean | Promise<boolean>;
  /** Finite persistence grace after a true {@link TSpawnLoginOpts.onDeadline}. */
  readonly persistenceGraceMs?: number;
  readonly producer?: TNativeAuthProducer;
  readonly operationId?: string;
};

/**
 * Cap for `onDeadline` (store re-read). A hung Darwin `security`/keychain must
 * not delay SIGTERM; grace starts only after a finished verified persist.
 */
export const DEADLINE_CHECK_CAP_MS = 400;

const awaitOnDeadline = async (
  check: (() => boolean | Promise<boolean>) | undefined,
): Promise<boolean> => {
  if (check === undefined) return false;
  try {
    return await Promise.race([
      Promise.resolve(check()).then((v) => v === true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), DEADLINE_CHECK_CAP_MS);
      }),
    ]);
  } catch {
    return false;
  }
};

/** Default login ceiling — long enough for a human to complete the browser
 *  OAuth, short enough that a wedged child is reaped, not left forever. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** After `opts.until` first matches, wait this long for the rest of a
 *  chunk-split token to arrive before killing — so the captured token is the
 *  COMPLETE one even though the regex isn't boundary-anchored. */
export const UNTIL_SETTLE_MS = 400;

/**
 * Spawn a vendor CLI's login command and capture its output. The CLI opens the
 * user's browser; the user signs in and the CLI completes via its own localhost
 * callback, at which point the credential is in the CLI's OWN store. stdin is
 * ignored (browser-driven; headless daemon has no usable stdin).
 *
 * Robustness (load-bearing): we NEVER block indefinitely on the child exiting.
 * Output is STREAMED; if `opts.until` matches we kill the child and return
 * (the vendor CLI can hang in atexit AFTER printing the token — see
 * `TSpawnLoginOpts.until`), and a `timeoutMs` ceiling reaps a wedged child
 * regardless. Either way the captured output is returned — the caller re-reads
 * the store / parses the token from it.
 */
export const spawnLogin = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string>,
  opts?: TSpawnLoginOpts,
): Promise<TLoginResult> => {
  const loginOpts = opts;
  if (loginOpts?.signal?.aborted === true) {
    return noChildResult(true);
  }
  const setupStartedAtMs = performance.now();
  const timeoutMs = loginOpts?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const parentBudget = budgetFromSignal(loginOpts?.signal);
  const budget =
    parentBudget?.child(timeoutMs) ??
    createDeadlineBudget(timeoutMs, loginOpts?.signal);
  const remainingAtSpawn = budget.remainingMs();
  const child = superviseSpawn(
    sandboxSpawnArgs(argv, { probe: loginOpts?.probe }),
    {
      kind: "login",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: spawnCwd(env),
      ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
    },
  );
  const spawnedAtMs = performance.now();
  const spawnSetupMs = spawnedAtMs - setupStartedAtMs;
  const proc = child.subprocess;
  const stamp = spawnStamp(proc);
  if (loginOpts?.producer !== undefined) {
    logDebug("spawn", "native auth child started", {
      producer: loginOpts.producer,
      ...(loginOpts.operationId !== undefined
        ? { operation_id: loginOpts.operationId }
        : {}),
      phase: "start",
      child_pid: stamp.child_pid,
      tick_id: currentTickId(),
      configured_timeout_ms: timeoutMs,
      remaining_at_spawn_ms: remainingAtSpawn,
      spawn_setup_ms: spawnSetupMs,
      clock: "performance.now",
    });
  }
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  if (
    stdout === undefined ||
    typeof stdout === "number" ||
    stderr === undefined ||
    typeof stderr === "number"
  ) {
    await child.terminate(splitReapBudget(budget.remainingMs()));
    return { code: -1, output: "", abandoned: true, ...stamp };
  }
  const dec = new TextDecoder();
  let out = "";
  let err = "";
  let abandoned = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let timerArmedAtMs: number | null = null;
  let timerFiredAtMs: number | null = null;
  let timerDelayMs = remainingAtSpawn;
  let stdoutClosed = false;
  let stderrClosed = false;
  let rootExitCode: number | null = null;
  let cleanupMs: number | null = null;
  void proc.exited.then((code) => {
    rootExitCode = code;
  });
  let markAbandoned!: () => void;
  const abandonedGate = new Promise<void>((resolve) => {
    markAbandoned = resolve;
  });
  const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
  const kill = (): void => {
    if (abandoned) return;
    abandoned = true;
    markAbandoned();
    for (const reader of readers) {
      void reader.cancel().catch(() => {});
    }
    void child.terminate(splitReapBudget(budget.remainingMs()));
  };

  const emitLoginTimeout = (opts: {
    readonly stdoutClosed: boolean;
    readonly stderrClosed: boolean;
    readonly rootExited: boolean;
    readonly rootExitCode: number | null;
    readonly cleanupMs: number;
  }): void => {
    const raceObservedAtMs = performance.now();
    const armed = timerArmedAtMs ?? spawnedAtMs;
    const fired = timerFiredAtMs ?? raceObservedAtMs;
    logWarn("spawn", "login timed out", {
      configured_timeout_ms: timeoutMs,
      deadline_ms: remainingAtSpawn,
      remaining_at_spawn_ms: remainingAtSpawn,
      budget_remaining_ms_at_spawn: remainingAtSpawn,
      spawn_elapsed_ms: raceObservedAtMs - spawnedAtMs,
      spawn_setup_ms: spawnSetupMs,
      timer_armed_at_ms: armed,
      timer_fired_at_ms: fired,
      race_observed_at_ms: raceObservedAtMs,
      timeout_callback_lateness_ms: timeoutCallbackLatenessMs(
        armed,
        fired,
        timerDelayMs,
      ),
      stdout_closed: opts.stdoutClosed,
      stderr_closed: opts.stderrClosed,
      root_exited: opts.rootExited,
      root_exit_code: opts.rootExitCode,
      cleanup_ms: opts.cleanupMs,
      clock: "performance.now",
      child_pid: stamp.child_pid,
      tick_id: currentTickId(),
      kind: "login",
      probe: loginOpts?.probe === true,
      reason_code: "timeout",
      abandoned: true,
      ...(loginOpts?.producer !== undefined
        ? { producer: loginOpts.producer }
        : {}),
      ...(loginOpts?.operationId !== undefined
        ? { operation_id: loginOpts.operationId }
        : {}),
    });
    noteNativeAuthTimeout({
      trigger: "native_login",
      operation: "native_auth",
      timings: {
        configured_timeout_ms: timeoutMs,
        spawn_elapsed_ms: raceObservedAtMs - spawnedAtMs,
        budget_remaining_ms_at_spawn: remainingAtSpawn,
        timeout_callback_lateness_ms: timeoutCallbackLatenessMs(
          armed,
          fired,
          timerDelayMs,
        ),
        cleanup_ms: opts.cleanupMs,
        stdout_closed: opts.stdoutClosed,
        stderr_closed: opts.stderrClosed,
        root_exited: opts.rootExited,
        ...(typeof opts.rootExitCode === "number"
          ? { root_exit_code: opts.rootExitCode }
          : {}),
      },
    });
  };

  const onTimeout = (): void => {
    void (async (): Promise<void> => {
      if (abandoned) return;
      const stdoutClosedAtDeadline = stdoutClosed;
      const stderrClosedAtDeadline = stderrClosed;
      const rootExitedAtDeadline =
        rootExitCode !== null ||
        proc.exitCode !== null ||
        proc.signalCode !== null;
      const rootExitCodeAtDeadline = rootExitCode ?? proc.exitCode;
      const defer = await awaitOnDeadline(loginOpts?.onDeadline);
      if (abandoned) return;
      if (defer) {
        const graceMs = Math.max(0, loginOpts?.persistenceGraceMs ?? 0);
        if (graceMs > 0 && proc.exitCode === null && proc.signalCode === null) {
          await Promise.race([
            proc.exited,
            new Promise<void>((resolve) => {
              setTimeout(resolve, graceMs);
            }),
          ]);
        }
        if (abandoned) return;
        if (proc.exitCode !== null || proc.signalCode !== null) return;
      }
      const cleanupStartedAtMs = performance.now();
      kill();
      await child.terminate(splitReapBudget(budget.remainingMs()));
      cleanupMs = performance.now() - cleanupStartedAtMs;
      emitLoginTimeout({
        stdoutClosed: stdoutClosedAtDeadline,
        stderrClosed: stderrClosedAtDeadline,
        rootExited: rootExitedAtDeadline,
        rootExitCode: rootExitCodeAtDeadline,
        cleanupMs,
      });
    })();
  };
  const scheduleTimeout =
    loginTimeoutSchedulerForTests ??
    ((callback: () => void, delayMs: number): ReturnType<typeof setTimeout> =>
      setTimeout(callback, delayMs));
  timerDelayMs = budget.remainingMs();
  timerArmedAtMs = performance.now();
  killTimer = scheduleTimeout(() => {
    timerFiredAtMs = performance.now();
    onTimeout();
  }, timerDelayMs);
  const unbindAbort = bindAbort(opts?.signal, kill);

  const pump = async (
    stream: ReadableStream<Uint8Array>,
    onChunk: (s: string) => void,
    onClose: () => void,
  ): Promise<void> => {
    const reader = stream.getReader();
    readers.push(reader);
    try {
      for (;;) {
        if (abandoned) break;
        const { done, value } = await reader.read();
        if (done) {
          onClose();
          break;
        }
        if (abandoned) break;
        if (value !== undefined) onChunk(dec.decode(value));
        // Early-return once the awaited output appears (the child may never exit
        // cleanly — it can WEDGE after printing the token). Match the COMBINED
        // stream so a token on either fd is seen. We don't kill immediately: a
        // token can arrive split across read chunks, so a SETTLE delay lets the
        // remaining bytes land before we kill + parse — capturing the FULL token
        // without needing a stricter (and more brittle) trailing-boundary regex.
        if (
          opts?.until !== undefined &&
          settleTimer === null &&
          !abandoned &&
          opts.until.test(`${out}\n${err}`)
        ) {
          settleTimer = setTimeout(kill, UNTIL_SETTLE_MS);
        }
      }
    } catch {
      // Cancelled reader after abandon — captured output is still valid.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already cancelled.
      }
    }
  };

  await Promise.race([
    Promise.all([
      pump(
        stdout,
        (s) => {
          out += s;
        },
        () => {
          stdoutClosed = true;
        },
      ),
      pump(
        stderr,
        (s) => {
          err += s;
        },
        () => {
          stderrClosed = true;
        },
      ),
      proc.exited,
    ]),
    abandonedGate,
  ]);
  unbindAbort();
  if (killTimer !== null) clearTimeout(killTimer);
  if (settleTimer !== null) clearTimeout(settleTimer);
  if (abandoned) {
    await child.terminate(splitReapBudget(budget.remainingMs()));
  }

  // Only surface a SIGNAL kill we did NOT cause (a sandbox/OS kill) — our own
  // `until`/timeout kill is expected and its output is valid.
  if (!abandoned) logIfKilled(argv, proc, { confined: opts?.probe !== true });
  if (loginOpts?.producer !== undefined) {
    logDebug("spawn", "native auth child finished", {
      producer: loginOpts.producer,
      ...(loginOpts.operationId !== undefined
        ? { operation_id: loginOpts.operationId }
        : {}),
      phase: "result",
      reason_code: abandoned ? "abandoned" : "complete",
      abandoned,
      child_pid: stamp.child_pid,
      tick_id: currentTickId(),
      clock: "performance.now",
    });
  }
  // Join with a newline, NOT bare concatenation: a token printed as the last
  // bytes of stdout (no trailing newline) must not fuse with the first bytes
  // of stderr, or a greedy token match would swallow the spillover.
  return {
    code: proc.exitCode ?? -1,
    output: `${out}\n${err}`.trim(),
    abandoned,
    ...stamp,
  };
};

// OSC (ESC ] … BEL/ST), CSI (ESC [ … final), and lone ESC. Built from a
// string so the source stays free of raw control bytes.
const ANSI_RE = new RegExp(
  "\\u001b\\][^]*?(?:\\u0007|\\u001b\\\\)" +
    "|\\u001b\\[[0-9;?]*[ -/]*[@-~]" +
    "|\\u001b[@-Z\\\\-_]",
  "g",
);

/**
 * Strip ANSI/terminal control sequences (CSI colour codes, OSC, lone escapes)
 * from CLI output so a value parsed out of it isn't fused with rendering bytes.
 */
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/** Strip URL query strings from diagnostics so OAuth parameters never surface
 * in a local log or dashboard error while retaining the actionable origin/path. */
export const redactUrls = (value: string): string =>
  value.replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1?<redacted>");

/**
 * Build the `script(1)` argv that runs `argv` under a PSEUDO-TERMINAL, writing
 * the terminal capture to `typescript` — or null on an OS without `script`
 * (caller falls back to a plain pipe spawn). Some vendor CLIs only run attached
 * to a real terminal (e.g. `kimi -p`'s raw-mode-gated print mode), emitting
 * NOTHING under a plain pipe. Shared by
 * {@link spawnLoginPty} (which POLLS the typescript for an `until` regex) and
 * the exec-fixture capture (which ignores the typescript — pass `/dev/null` —
 * and drives off its HTTP recorder instead).
 *
 * Subtleties baked in:
 *   - `-F` (BSD) / `-f` (util-linux, inside `-qfc`) is LOAD-BEARING: without it
 *     `script` BUFFERS the typescript and only flushes on close, so a poller
 *     reads empty until the child exits. `-F` flushes after every write.
 *   - `script` allocates the PTY at the DEFAULT 80×24 — window size is an ioctl
 *     (TIOCSWINSZ), NOT `COLUMNS`/`LINES` — so a TUI rendering a fixed-width box
 *     wraps a long value mid-line. We resize the slave with `stty` INSIDE the
 *     PTY (runs on the controlling tty before the real command via `exec`).
 *     `2>/dev/null` keeps an `stty`-less environment from breaking the flow.
 *   - BSD (`script -q <file> cmd…`) vs util-linux (`script -qfc "cmd" <file>`)
 *     differ in argument order.
 */
export const ptyScriptArgv = (
  argv: ReadonlyArray<string>,
  typescript: string,
): string[] | null => {
  const os = platform();
  if (os !== "darwin" && os !== "linux") return null;
  const escapeShellArg = (arg: string): string =>
    `'${arg.replace(/'/g, "'\\''")}'`;
  const cmd = argv.map(escapeShellArg).join(" ");
  const widen = `stty cols 1000 rows 50 2>/dev/null; exec ${cmd}`;
  return os === "darwin"
    ? ["script", "-F", "-q", typescript, "sh", "-c", widen]
    : ["script", "-qfc", widen, typescript];
};

/**
 * Like {@link spawnLogin}, but runs `argv` under a PSEUDO-TERMINAL (via
 * `script(1)`). Some vendor CLIs only work attached to a real terminal — e.g.
 * `kimi -p`'s raw-mode-gated print mode writes to its controlling terminal
 * (`/dev/tty`), so spawned with a plain pipe (no controlling TTY) it emits
 * NOTHING and the headless daemon captures `outputLen: 0`. A PTY makes it
 * actually run, and we capture its terminal output to a `script` typescript
 * file which we POLL — so `opts.until` returns the instant the match appears.
 *
 * Key subtleties, each load-bearing (see the harness in `tests/`):
 *   - stdin is `/dev/null` (`"ignore"`): a Bun pipe/stream/inherited stdin makes
 *     `script` block before it sets up the PTY (empirically 0 bytes captured).
 *   - the child does NOT EOF-exit despite `/dev/null`: it reads the PTY SLAVE,
 *     not `script`'s stdin, so its stdin stays open for the browser flow.
 *   - we read the typescript FILE, not `script`'s stdout: piping `script`'s
 *     stdout under `Bun.spawn` also yields 0 bytes.
 *   - BSD (`script -q <file> cmd…`) vs util-linux (`script -qfc "cmd" <file>`)
 *     differ; unsupported elsewhere → falls back to plain {@link spawnLogin}.
 */
export const spawnLoginPty = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string>,
  opts?: TSpawnLoginOpts,
): Promise<TLoginResult> => {
  const ptyOpts = opts;
  const os = platform();
  if (os !== "darwin" && os !== "linux") return spawnLogin(argv, env, ptyOpts);
  if (ptyOpts?.signal?.aborted === true) {
    return noChildResult(true);
  }

  const tsFile = join(
    daemonTempDir(),
    `openllmd-pty-${process.pid}-${Date.now().toString(36)}.log`,
  );
  await Bun.write(tsFile, "");
  // PTY argv (shared with the exec-fixture capture). Non-null here: the OS was
  // already gated to darwin/linux above. We POLL `tsFile` for `opts.until`.
  const scriptArgv = ptyScriptArgv(argv, tsFile) ?? [...argv];

  // Wrap the WHOLE `script(1)` argv — the PTY wrapper and the vendor CLI it
  // runs are one confined tree.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const parentBudget = budgetFromSignal(opts?.signal);
  const budget =
    parentBudget?.child(timeoutMs) ??
    createDeadlineBudget(timeoutMs, opts?.signal);
  const child = superviseSpawn(
    sandboxSpawnArgs(scriptArgv, { probe: opts?.probe }),
    {
      kind: "login",
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      cwd: spawnCwd(env),
      ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
    },
  );
  const proc = child.subprocess;
  const stamp = spawnStamp(proc);

  const readFile = (): Promise<string> =>
    Bun.file(tsFile)
      .text()
      .catch(() => "");
  let abandoned = false;
  let captured = "";
  const kill = (): void => {
    if (abandoned) return;
    abandoned = true;
    void child.terminate(splitReapBudget(budget.remainingMs()));
  };
  const unbindAbort = bindAbort(opts?.signal, kill);
  try {
    for (;;) {
      if (abandoned) break;
      captured = await readFile();
      if (opts?.until?.test(stripAnsi(captured)) === true) {
        // Settle: let the rest of the token line render before we kill + parse.
        await new Promise((r) => setTimeout(r, UNTIL_SETTLE_MS));
        captured = await readFile();
        kill();
        break;
      }
      if (proc.exitCode !== null || proc.signalCode !== null) break; // exited
      if (budget.expired()) {
        const defer = await awaitOnDeadline(ptyOpts?.onDeadline);
        if (defer) {
          const graceMs = Math.max(0, ptyOpts?.persistenceGraceMs ?? 0);
          if (
            graceMs > 0 &&
            proc.exitCode === null &&
            proc.signalCode === null
          ) {
            await Promise.race([
              proc.exited,
              new Promise<void>((resolve) => {
                setTimeout(resolve, graceMs);
              }),
            ]);
          }
          if (proc.exitCode !== null || proc.signalCode !== null) break;
        }
        kill();
        break;
      }
      await new Promise((r) =>
        setTimeout(r, Math.min(400, budget.remainingMs())),
      );
    }
    if (abandoned) {
      await child.terminate(splitReapBudget(budget.remainingMs()));
    } else {
      const leftover = budget.remainingMs();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          proc.exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, leftover);
          }),
        ]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      if (proc.exitCode === null && proc.signalCode === null) {
        await child.terminate(splitReapBudget(0));
        abandoned = true;
      }
    }
  } finally {
    unbindAbort();
  }
  captured = await readFile(); // final read (token written just before exit)
  await rm(tsFile, { force: true }).catch(() => {});
  if (!abandoned)
    logIfKilled(scriptArgv, proc, { confined: opts?.probe !== true });
  return {
    code: proc.exitCode ?? -1,
    output: stripAnsi(captured),
    abandoned,
    ...stamp,
  };
};

/**
 * Best-effort open a URL in the user's default browser (macOS `open`, Windows
 * `cmd /c start`, else `xdg-open`). Used by the browser / device-code login
 * flows to bring up the vendor's auth page FROM the daemon — some vendor CLIs
 * print the URL but their own auto-open doesn't reach the user's GUI session
 * when the daemon spawns them (e.g. codex). Never throws; the user can copy the
 * URL from the card.
 */
export const openUrl = (url: string): void => {
  // Never launch a real browser under the test runner (`bun test` sets
  // NODE_ENV=test) — a device/browser login test that reaches this line would
  // otherwise pop a tab on the developer's machine. Production is unaffected.
  if (process.env.NODE_ENV === "test") return;
  const os = platform();
  // Windows: `start` is a cmd builtin, so it must run via `cmd /c`; the empty
  // "" is the (required) window-title arg, and the URL is quoted so `cmd.exe`
  // doesn't treat an OAuth URL's `&` as a command separator.
  const argv: string[] =
    os === "darwin"
      ? ["open", url]
      : os === "win32"
        ? ["cmd", "/c", "start", "", `"${url}"`]
        : ["xdg-open", url];
  try {
    // Deliberately UNWRAPPED (no `sandboxSpawnArgs`): opening the user's
    // browser is a user-facing action like the session-PTY exemption — the
    // launcher must reach the real GUI session/LaunchServices state, and it
    // takes only the URL string (no filesystem payload to confine).
    Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      cwd: spawnCwd(undefined),
    });
  } catch {
    // best-effort — the user can copy the URL from the card detail
  }
};
