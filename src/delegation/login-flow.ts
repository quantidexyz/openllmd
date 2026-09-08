/**
 * Shared, provider-agnostic login-flow scaffolding for the subscription
 * delegates.
 *
 * The three delegates (`claude-code`, `chatgpt`, `kimi-code`) each expose up to
 * two login methods on `TProviderDelegate`: `connect()` (the on-this-box native
 * login) and `connectDeviceCode()` (the remote/headless login). The orchestration
 * around those — the install-check + already-signed-in preamble, the single-flight
 * guard, the background-exit cleanup, and the codex stream-spawn reader loop —
 * is identical across providers and used to be copy-pasted into each delegate.
 * It lives here once; the per-method adaptors (`login-direct`, `login-device`)
 * build on it, and the delegates inject only their provider-specifics (token
 * store, parse fns, keychain hooks).
 *
 * The single-flight `loginSlot` is keyed by provider and SHARED between the two
 * adaptors so a provider whose `connect` + `connectDeviceCode` must not run at
 * once (codex: one `codex login` process binds the localhost callback / polls)
 * stays guarded across both methods.
 */

import type { TAuthLoginFailedCode, TAuthLoginMode } from "@openllmsh/protocol";
import { emitAuth, requestStatusPush } from "../auth-events";
import { noteAuthStoreIdentityChange } from "../auth-user-action";
import { noteLoginTerminal } from "../doctor-report/hooks";
import { logWarn } from "../logger";
import type { TPendingAuth } from "../pending-auth";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
  setPendingAuth,
} from "../pending-auth";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { KEYCHAIN_NOT_READY_DETAIL } from "./login-readiness";
import { DEFAULT_LOGIN_TIMEOUT_MS, redactUrls, spawnCwd } from "./spawn";
import { openUrl } from "./util";

/** The shared return shape of `connect()` / `connectDeviceCode()`. */
export type TConnectResult = {
  readonly connected: boolean;
  readonly detail?: string;
  readonly pending?: boolean;
};

/** One in-flight login's identity — `flowId` is the browser/relay command id. */
export type TLoginFlowCtx = {
  readonly flowId: string;
  readonly keyId: string;
  readonly slug: string;
  readonly mode: TAuthLoginMode;
};

// ─── Per-command flow identity (threaded from control-relay) ─────────────

let commandCtx: { flowId: string; keyId: string } | null = null;

/**
 * Bind the current control-command's id as `flow_id` for the duration of
 * `run()`. Background work (stream readers, `finishInBackground`) must
 * CAPTURE the resolved {@link TLoginFlowCtx} — this binding is restored
 * when `run()` returns.
 */
export const runWithLoginCommand = async <T>(
  ctx: { readonly flowId: string; readonly keyId: string },
  run: () => Promise<T>,
): Promise<T> => {
  const prev = commandCtx;
  commandCtx = ctx;
  try {
    return await run();
  } finally {
    commandCtx = prev;
  }
};

export const resolveLoginFlow = (
  slug: string,
  mode: TAuthLoginMode,
): TLoginFlowCtx => ({
  flowId: commandCtx?.flowId ?? crypto.randomUUID(),
  keyId: commandCtx?.keyId ?? "local",
  slug,
  mode,
});

// ─── Per-provider single-flight slot ─────────────────────────────────────

/**
 * One provider's login single-flight state, shared by its direct + device
 * adaptors. Holds the in-flight flag plus the set of cancelers a live
 * background flow registers — killing a spawned process (codex), setting an
 * abort flag (kimi's poll), or `THeadlessLogin.cancel()` (claude paste-back).
 * `cancelConnect` runs them all.
 */
export type TLoginSlot = {
  /** True while a background login is in flight for this provider. */
  readonly inFlight: () => boolean;
  /** The live flow's identity, or null when nothing is in flight. */
  readonly flow: () => TLoginFlowCtx | null;
  /** True after {@link TLoginSlot.cancelAll} until the next {@link TLoginSlot.start}. */
  readonly wasCancelled: () => boolean;
  /** Mark in-flight + register the live flow's canceler. Call only AFTER the
   *  spawn/handle exists — an early mark wedges the slot if the spawn throws. */
  readonly start: (canceler: () => void, flow?: TLoginFlowCtx) => void;
  /** Clear in-flight + drop all cancelers (the background-exit cleanup). */
  readonly end: () => void;
  /** Run every registered canceler and clear them. Returns how many ran (>0 ⇔
   *  a login was in flight) — `inFlight` itself is left for the flow's own exit
   *  handler to clear via `end()`, mirroring the pre-refactor kill→exit order. */
  readonly cancelAll: () => number;
};

const slots = new Map<string, TLoginSlot>();

/** The memoized single-flight slot for `provider` (created on first use). */
export const loginSlot = (provider: string): TLoginSlot => {
  const existing = slots.get(provider);
  if (existing !== undefined) return existing;
  let inFlight = false;
  let cancelled = false;
  let flow: TLoginFlowCtx | null = null;
  const cancelers = new Set<() => void>();
  const slot: TLoginSlot = {
    inFlight: () => inFlight,
    flow: () => flow,
    wasCancelled: () => cancelled,
    start: (canceler, nextFlow) => {
      inFlight = true;
      cancelled = false;
      if (nextFlow !== undefined) flow = nextFlow;
      cancelers.add(canceler);
    },
    end: () => {
      inFlight = false;
      cancelers.clear();
      flow = null;
      cancelled = false;
    },
    cancelAll: () => {
      cancelled = true;
      const n = cancelers.size;
      for (const fn of cancelers) {
        try {
          fn();
        } catch {
          // already gone — the flow's own exit handler ran
        }
      }
      cancelers.clear();
      return n;
    },
  };
  slots.set(provider, slot);
  return slot;
};

/** Providers whose logout is in flight (login uses {@link loginSlot}). */
const logoutOps = new Set<string>();

/** Mark logout as the owner of this provider's auth until verification ends. */
export const beginProviderAuthOperation = (slug: string): void => {
  logoutOps.add(slug);
};

export const endProviderAuthOperation = (slug: string): void => {
  logoutOps.delete(slug);
};

/**
 * True while this provider's login OR logout operation owns auth.
 * Sticky post-logout signed_out is not included — that lives on status.
 */
export const providerAuthOperationActive = (slug: string): boolean =>
  logoutOps.has(slug) || loginSlot(slug).inFlight();

export const resetProviderAuthOperationsForTests = (): void => {
  logoutOps.clear();
};

/** Wrap logout (or other auth mutation) so observers see an active operation. */
export const runWithAuthOperation = async <T>(
  slug: string,
  work: () => Promise<T>,
): Promise<T> => {
  beginProviderAuthOperation(slug);
  try {
    return await work();
  } finally {
    endProviderAuthOperation(slug);
  }
};

/**
 * Open the vendor auth URL on the daemon's box ONLY if the login wasn't
 * cancelled in the race window between parsing the prompt and this call. A
 * `cancel_connect` can land after `spawnStreamLogin` resolved / `requestDeviceAuth`
 * returned but before we open the browser; without this a browser tab would pop
 * on the user AFTER they stopped the flow — and, worse, on the device-code path
 * the subsequent `slot.start()` clears `wasCancelled`, so this is the last point
 * the cancel is still observable. Returns whether it opened (false ⇒ cancelled,
 * so the caller must abort the flow instead of surfacing a prompt). Best-effort:
 * a status/UI cancel already tore down the dashboard side.
 */
export const openAuthUrlUnlessCancelled = (
  slot: TLoginSlot,
  url: string,
): boolean => {
  if (slot.wasCancelled()) return false;
  openUrl(url);
  return true;
};

// ─── Auth event helpers ──────────────────────────────────────────────────

export const emitLoginStarted = (flow: TLoginFlowCtx): void => {
  emitAuth({
    event: "auth.login.started",
    flow_id: flow.flowId,
    key_id: flow.keyId,
    slug: flow.slug,
    mode: flow.mode,
  });
};

export const emitLoginPrompt = (
  flow: TLoginFlowCtx,
  pending: { readonly url: string; readonly code: string },
): void => {
  emitAuth({
    event: "auth.login.prompt",
    flow_id: flow.flowId,
    key_id: flow.keyId,
    slug: flow.slug,
    url: pending.url,
    ...(pending.code.length > 0 ? { code: pending.code } : {}),
    mode: flow.mode,
  });
};

/** Store the pending snapshot then emit `auth.login.prompt` — the pair every
 *  live login uses once a URL (± code) is known. `flow.flowId` is stamped onto
 *  the stored snapshot; `mode` is only written when the caller supplies it
 *  (`paste_code`). Order matches the former inline pair. */
export const publishPendingAuth = (
  flow: TLoginFlowCtx,
  provider: string,
  pending: {
    readonly url: string;
    readonly code: string;
    readonly mode?: TPendingAuth["mode"];
  },
): void => {
  setPendingAuth(provider, {
    url: pending.url,
    code: pending.code,
    ...(pending.mode !== undefined ? { mode: pending.mode } : {}),
    flowId: flow.flowId,
  });
  emitLoginPrompt(flow, { url: pending.url, code: pending.code });
};

export const emitLoginSucceeded = (flow: TLoginFlowCtx): void => {
  noteAuthStoreIdentityChange(flow.slug);
  emitAuth({
    event: "auth.login.succeeded",
    flow_id: flow.flowId,
    key_id: flow.keyId,
    slug: flow.slug,
  });
};

export const emitLoginFailed = (
  flow: TLoginFlowCtx,
  fail: {
    readonly code: TAuthLoginFailedCode;
    readonly message: string;
    readonly retryable: boolean;
  },
): void => {
  emitAuth({
    event: "auth.login.failed",
    flow_id: flow.flowId,
    key_id: flow.keyId,
    slug: flow.slug,
    code: fail.code,
    message: fail.message,
    retryable: fail.retryable,
  });
};

/**
 * Shared login-terminal finalizer (audit A4): emit succeeded/failed (or
 * nothing), optionally drop pending-auth, then request a status push.
 * Callers keep polling-specific work (`slot.end`, connection re-read,
 * `onConnected`) and decide which event to emit so stream vs device-code
 * cancel/success semantics stay distinct.
 */
export type TLoginTerminalEvent =
  | { readonly kind: "succeeded" }
  | {
      readonly kind: "failed";
      readonly code: TAuthLoginFailedCode;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly kind: "none" };

export const finalizeLoginTerminal = (opts: {
  readonly flow: TLoginFlowCtx | null;
  readonly event: TLoginTerminalEvent;
  readonly provider: string;
  readonly clearPending: boolean;
}): void => {
  if (opts.event.kind === "failed") {
    noteLoginTerminal({
      code: opts.event.code,
      provider: opts.provider,
    });
  }
  if (opts.flow !== null) {
    if (opts.event.kind === "succeeded") {
      emitLoginSucceeded(opts.flow);
    } else if (opts.event.kind === "failed") {
      emitLoginFailed(opts.flow, {
        code: opts.event.code,
        message: opts.event.message,
        retryable: opts.event.retryable,
      });
    }
  }
  if (opts.clearPending) {
    clearPendingAuth(opts.provider, opts.flow?.flowId);
  }
  requestStatusPush();
};

const CAPTURE_MAX = 400;

const captureBody = (captured: string): string =>
  redactUrls(captured).slice(0, CAPTURE_MAX).trim();

const isInnerSpawnDenied = (
  captured: string,
  exitCode: number | null,
): boolean =>
  exitCode === 127 &&
  /EPERM|posix_spawn|operation not permitted/i.test(captured);

/**
 * Map a stream-login miss onto an `auth.login.failed` code + the dashboard
 * `detail`. The static `failDetail` is a TITLE — the body is the redacted
 * capture (and `[code]` for an outer spawn throw). Never the title alone
 * when we have anything else to say.
 */
export const streamLoginFail = (
  title: string,
  res: Extract<TStreamLoginResult<unknown>, { found: null }>,
  crashDetail?: (captured: string, exitCode: number | null) => string,
): {
  readonly code: TAuthLoginFailedCode;
  readonly message: string;
  readonly retryable: boolean;
} => {
  if (res.spawnFailure !== undefined) {
    return {
      code: "spawn_denied",
      message: `${title} [${res.spawnFailure.code}] ${res.spawnFailure.message}`,
      retryable: false,
    };
  }
  const body = captureBody(res.captured);
  const titled = body.length > 0 ? `${title}\n${body}` : title;
  if (isInnerSpawnDenied(res.captured, res.exitCode)) {
    return { code: "spawn_denied", message: titled, retryable: false };
  }
  if (res.crashed) {
    return {
      code: "cli_crash",
      message:
        crashDetail !== undefined
          ? crashDetail(res.captured, res.exitCode)
          : titled,
      retryable: false,
    };
  }
  if (res.timedOut === true) {
    return { code: "prompt_timeout", message: titled, retryable: true };
  }
  return { code: "poll_expired", message: titled, retryable: true };
};

// ─── Guard preamble ──────────────────────────────────────────────────────

export type TGuardOpts = {
  readonly provider: string;
  /** Whether the vendor CLI is installed; a `false` returns `installHint`. */
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Optional already-signed-in short-circuit (codex/kimi/claude-device). */
  readonly shortCircuit?: {
    readonly connected: () => Promise<boolean>;
    readonly detail: string;
  };
  /** Optional single-flight slot — when in-flight, re-surface instead of
   *  spawning a second login. Absent ⇒ no single-flight (claude's blocking
   *  `connect`, which simply blocks in the spawned login). */
  readonly slot?: TLoginSlot;
  /** Fallback re-surface detail when no pending-auth is live. */
  readonly inProgressDetail?: string;
  /** Override the default re-surface result (kimi's `connect` returns a fixed
   *  string with no `pending` flag, unlike codex/claude's pending re-surface). */
  readonly resurface?: (pending: TPendingAuth | null) => TConnectResult;
  /** Login mode for events fired from the preamble (not_installed / short-circuit
   *  / in-flight re-prompt). Default `browser`. */
  readonly mode?: TAuthLoginMode;
};

/**
 * Run the shared login preamble, then `run()` if it clears: not-installed →
 * `installHint`; in-flight single-flight re-surface (before expensive
 * connected verification); already-signed-in short-circuit (clears any stale
 * pending); otherwise start the flow.
 */
export const guard = async (
  opts: TGuardOpts,
  run: () => Promise<TConnectResult>,
): Promise<TConnectResult> => {
  const mode = opts.mode ?? "browser";
  if (!(await opts.installed())) {
    const flow = resolveLoginFlow(opts.provider, mode);
    emitLoginFailed(flow, {
      code: "not_installed",
      message: opts.installHint,
      retryable: false,
    });
    return { connected: false, detail: opts.installHint };
  }
  if (opts.slot?.inFlight() === true) {
    const pending = getPendingAuth(opts.provider);
    const live = opts.slot.flow();
    if (pending !== null && live !== null) {
      emitLoginPrompt(live, pending);
    }
    if (opts.resurface !== undefined) return opts.resurface(pending);
    return {
      connected: false,
      pending: true,
      detail:
        pending !== null
          ? pendingAuthDetail(pending)
          : (opts.inProgressDetail ??
            "Sign-in already in progress — this updates automatically."),
    };
  }
  if (
    opts.shortCircuit !== undefined &&
    (await opts.shortCircuit.connected())
  ) {
    clearPendingAuth(opts.provider);
    const flow = resolveLoginFlow(opts.provider, mode);
    emitLoginSucceeded(flow);
    return { connected: true, detail: opts.shortCircuit.detail };
  }
  return run();
};

// ─── Background-exit cleanup ─────────────────────────────────────────────

/** Verification watchdog after child exit — matches Claude `AUTH_STATUS_TIMEOUT_MS`. */
export const LOGIN_VERIFY_WATCHDOG_MS = 4_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Typed login observation: never collapse timeout/throw to signed-out. */
export type TLoginVerify = {
  readonly state: "connected" | "absent" | "unavailable";
};

export const booleanLoginVerify = async (
  check: () => Promise<boolean>,
): Promise<TLoginVerify> => {
  try {
    return { state: (await check()) ? "connected" : "absent" };
  } catch {
    return { state: "unavailable" };
  }
};

const sampleVerify = async (
  verify: () => Promise<TLoginVerify>,
): Promise<TLoginVerify> => {
  try {
    return await verify();
  } catch {
    return { state: "unavailable" };
  }
};

/** Race a store-lifecycle hint against a finite watchdog, then abort the hint. */
export const waitLoginVerifyHint = async (opts: {
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  readonly verifyWatchdogMs: number;
}): Promise<void> => {
  const ac = new AbortController();
  const watchdog = sleep(opts.verifyWatchdogMs);
  const hint =
    opts.waitStoreHint !== undefined
      ? opts.waitStoreHint(ac.signal).then(
          () => undefined,
          () => undefined,
        )
      : watchdog;
  await Promise.race([watchdog, hint]);
  ac.abort();
};

/**
 * The cleanup a background login runs when its process exits / its poll ends:
 * keep the slot in verifying phase until terminal classify, then — if a
 * credential landed — run `onConnected` (e.g. refresh the auth config), else
 * drop the stale pending code so the card stops showing a dead one.
 * `alwaysClearPending` also drops it on success (claude's paste-back clears
 * unconditionally; codex/kimi rely on `status()`).
 *
 * Typed verify: `connected` / `absent` / `unavailable`. Unavailable after
 * child exit waits for a store-identity hint or a finite watchdog, then one
 * reread — not a 400ms sleep as truth. Emits `auth.login.succeeded` or
 * `auth.login.failed` and triggers a status push. Explicit cancellation
 * always wins; a superseded `flowId` must not clear a newer pending.
 */
export const finishInBackground = async (opts: {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly verify: () => Promise<TLoginVerify>;
  /** Resolves when the credential store identity changes (hint, not truth). */
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  /** Finite verification watchdog. Default {@link LOGIN_VERIFY_WATCHDOG_MS}. */
  readonly verifyWatchdogMs?: number;
  /** Runs after a credential lands. Returning `false` marks the login FAILED
   *  (e.g. the keychain partition-list grant was refused) — see below. */
  readonly onConnected?: () =>
    | boolean
    | void
    | Promise<boolean>
    | Promise<void>;
  readonly alwaysClearPending?: boolean;
  /** Child exit code when known. Non-zero + absent → `cli_crash`;
   *  unavailable after a live child is retryable, never `cli_crash` from unread store. */
  readonly exitCode?: number | null;
}): Promise<void> => {
  const flow = opts.slot.flow();
  const flowId = flow?.flowId;
  const stillThisFlow = (): boolean =>
    flowId !== undefined && opts.slot.flow()?.flowId === flowId;
  const watchdogMs = opts.verifyWatchdogMs ?? LOGIN_VERIFY_WATCHDOG_MS;

  const settleNone = (clearPending: boolean): void => {
    if (stillThisFlow()) opts.slot.end();
    finalizeLoginTerminal({
      flow,
      event: { kind: "none" },
      provider: opts.provider,
      clearPending,
    });
  };

  // Both callbacks are BEST-EFFORT: this runs from a `void proc.exited.then(...)`
  // / `void login.done.then(...)`, so a throw here would be an unhandled
  // rejection AND could skip `clearPendingAuth`.
  let sampled = await sampleVerify(opts.verify);
  if (opts.slot.wasCancelled()) {
    settleNone(true);
    return;
  }
  if (!stillThisFlow()) {
    return;
  }
  if (sampled.state === "unavailable") {
    await waitLoginVerifyHint({
      waitStoreHint: opts.waitStoreHint,
      verifyWatchdogMs: watchdogMs,
    });
    if (opts.slot.wasCancelled()) {
      settleNone(true);
      return;
    }
    if (!stillThisFlow()) {
      return;
    }
    sampled = await sampleVerify(opts.verify);
    if (opts.slot.wasCancelled()) {
      settleNone(true);
      return;
    }
    if (!stillThisFlow()) {
      return;
    }
  }
  // An `onConnected` that returns `false` is an OBSERVED refusal (the keychain
  // partition-list grant), not a best-effort miss: the credential landed but the
  // daemon can't read it prompt-free, so the login is failed + retryable rather
  // than reported as succeeded. A THROW stays best-effort (swallowed) so cleanup
  // still runs and `clearPendingAuth` is never skipped.
  let grantDenied = false;
  if (sampled.state === "connected" && opts.onConnected !== undefined) {
    try {
      grantDenied = (await opts.onConnected()) === false;
    } catch {
      // best-effort — a failed onConnected must not reject the cleanup
    }
  }
  if (opts.slot.wasCancelled()) {
    settleNone(true);
    return;
  }
  if (!stillThisFlow()) {
    return;
  }
  // Only a definite non-zero exit code is a crash. `null` (killed by signal,
  // no exit code) and `undefined` (unknown) are NOT crashes — keep the
  // retryable poll_expired outcome rather than asserting a crash from an
  // ambiguous exit. Unreadable/timeout store is unavailable, not a crash.
  const crashed = typeof opts.exitCode === "number" && opts.exitCode !== 0;
  const event: TLoginTerminalEvent =
    flow === null
      ? { kind: "none" }
      : sampled.state === "connected" && grantDenied
        ? {
            kind: "failed",
            code: "spawn_denied",
            message: KEYCHAIN_NOT_READY_DETAIL,
            retryable: true,
          }
        : sampled.state === "connected"
          ? { kind: "succeeded" }
          : sampled.state === "unavailable"
            ? {
                kind: "failed",
                code: "poll_expired",
                message: "sign-in could not be verified",
                retryable: true,
              }
            : {
                kind: "failed",
                code: crashed ? "cli_crash" : "poll_expired",
                message: crashed
                  ? "sign-in process exited before a credential landed"
                  : "sign-in ended without a stored credential",
                retryable: !crashed,
              };
  opts.slot.end();
  finalizeLoginTerminal({
    flow,
    event,
    provider: opts.provider,
    clearPending:
      opts.alwaysClearPending === true ||
      sampled.state !== "connected" ||
      grantDenied,
  });
};

// ─── Stream-spawn login primitive (codex) ────────────────────────────────

/**
 * First-prompt *warn* mark. A still-alive child is NOT killed here — we keep
 * reading until parse, self-exit, or {@link DEFAULT_LOGIN_TIMEOUT_MS}.
 */
const STREAM_PROMPT_WARN_MS = 30_000;

export type TStreamLoginOpts<T> = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  /** Which fd carries the prompt: codex `login` prints the authorize URL to
   *  stderr; `codex login --device-auth` prints the device prompt to stdout. */
  readonly stream: "stdout" | "stderr";
  /** Returns the parsed prompt the instant the buffered output contains it. */
  readonly parse: (buf: string) => T | null;
  /** Hard ceiling (default {@link DEFAULT_LOGIN_TIMEOUT_MS}). Not the 30s
   *  first-prompt warn. */
  readonly timeoutMs?: number;
  /** First-prompt WARN threshold (default {@link STREAM_PROMPT_WARN_MS}) — logs
   *  a "still waiting" line, never kills. Overridable so a test can assert the
   *  no-kill behaviour without a 30s wait. */
  readonly warnMs?: number;
  /** Typed connection check for the background-exit cleanup. */
  readonly verify: () => Promise<TLoginVerify>;
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  readonly verifyWatchdogMs?: number;
  /** Runs in the background-exit cleanup when a credential landed. Returning
   *  `false` fails the login (see {@link finishInBackground}). */
  readonly onConnected?: () =>
    | boolean
    | void
    | Promise<boolean>
    | Promise<void>;
  /** Skip the sandbox wrap (macOS keychain-dependent login — see
   *  `sandbox/policy.ts`). Set from `unwrapKeychainSpawn(provider)`. */
  readonly probe?: boolean;
  /** `auth.login.started` mode. Default `browser`. */
  readonly mode?: TAuthLoginMode;
};

/**
 * Spawn a vendor CLI login, drain BOTH fds (the prompt-carrying one is parsed;
 * the other is captured so an inner `--sandbox-exec` posix_spawn EPERM on
 * stderr is not dropped when the prompt is on stdout), and resolve the instant
 * `parse` matches — then keep draining for the process's lifetime so a full
 * pipe can't stall the child's background callback/poll. The process is NOT
 * killed on a match (it runs its localhost callback / device poll until the
 * credential lands); `proc.exited` runs {@link finishInBackground}. On no
 * match the child is reaped only at the hard login ceiling, not at 30s.
 *
 * Single-flight is marked AFTER a successful spawn (a `Bun.spawn` throw must not
 * wedge the slot), mirroring the pre-refactor "set loginInFlight after spawn".
 */
const SPAWN_FAILURE_MAX_ERROR_CHARS = 400;

const redactSpawnFailure = (raw: string): string =>
  redactUrls(raw.slice(0, SPAWN_FAILURE_MAX_ERROR_CHARS)).trim();

type TSpawnFailure = Readonly<{
  readonly code: string;
  /** Short, redacted message suitable for surfacing to the dashboard. */
  readonly message: string;
}>;

const spawnFailureFromError = (error: unknown): TSpawnFailure => {
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "unknown";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "no error message was provided";
  return { code, message: redactSpawnFailure(message) };
};

export type TStreamLoginResult<T> =
  | { readonly found: T }
  | {
      readonly found: null;
      readonly captured: string;
      readonly exitCode: number | null;
      /** True iff the child exited NON-ZERO on its own before printing a prompt
       *  — a deterministic failure a "Retry" can't fix (e.g. `grok login`
       *  crashing with a traceback). False for a benign prompt timeout, so the
       *  connect layer can surface the captured error only when it's real. */
      readonly crashed: boolean;
      /** Spawn-level failure (e.g. `EPERM`, `ENOENT`) with a short redacted
       *  message. Set when `Bun.spawn(...)` itself throws before a child exists.
       */
      readonly spawnFailure?: TSpawnFailure;
      /** True iff we hit the hard login ceiling and reaped a still-alive child. */
      readonly timedOut?: boolean;
      /** True iff `cancelConnect` killed this child while we were still waiting
       *  for a prompt — the cancel path already emitted `user_cancelled`. */
      readonly cancelled?: boolean;
      /** Captured before `slot.end()` so the handler can emit `failed` with the
       *  same `flow_id` as `started`. */
      readonly flow: TLoginFlowCtx;
    };

const drainStream = async (
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> => {
  const decoder = new TextDecoder();
  try {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        onChunk(decoder.decode(value, { stream: true }));
      }
    }
  } catch {
    // peer closed — the prompt loop settles on EOF
  }
};

export const spawnStreamLogin = async <T>(
  opts: TStreamLoginOpts<T>,
): Promise<TStreamLoginResult<T>> => {
  const flow = resolveLoginFlow(opts.provider, opts.mode ?? "browser");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(sandboxSpawnArgs(opts.argv, { probe: opts.probe }), {
      stdin: "ignore",
      // Always pipe BOTH fds: the prompt may be on stdout (device-code) while
      // the `--sandbox-exec` shim writes inner posix_spawn EPERM to stderr.
      stdout: "pipe",
      stderr: "pipe",
      cwd: spawnCwd(opts.env),
      env: { ...process.env, ...opts.env },
    });
  } catch (error) {
    const spawnFailure = spawnFailureFromError(error);
    return {
      found: null,
      captured: spawnFailure.message,
      exitCode: null,
      crashed: false,
      spawnFailure,
      flow,
    };
  }
  opts.slot.start(() => {
    try {
      proc.kill();
    } catch {
      // already exited — its own exit handler ran
    }
  }, flow);
  emitLoginStarted(flow);

  const promptStream = (
    opts.stream === "stdout" ? proc.stdout : proc.stderr
  ) as ReadableStream<Uint8Array>;
  const otherStream = (
    opts.stream === "stdout" ? proc.stderr : proc.stdout
  ) as ReadableStream<Uint8Array>;
  let promptBuf = "";
  let otherBuf = "";
  const otherDone = drainStream(otherStream, (text) => {
    otherBuf += text;
  });
  const combined = (): string =>
    [promptBuf, otherBuf].filter((s) => s.length > 0).join("\n");
  // Set ONLY by the hard-ceiling timer. Distinguishes the two null outcomes:
  // a timeout (child still running → kill it, not a crash) vs the reader
  // reaching EOF because the child EXITED on its own before a prompt (a crash).
  let timedOut = false;
  const ceilingMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const found = await new Promise<T | null>((resolve) => {
    let settled = false;
    const settle = (v: T | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const warnMs = opts.warnMs ?? STREAM_PROMPT_WARN_MS;
    const warnTimer =
      ceilingMs > warnMs
        ? setTimeout(() => {
            if (!settled) {
              logWarn(
                "login-flow",
                "vendor login has not printed an authorize prompt yet; waiting until the login ceiling",
                { provider: opts.provider },
              );
            }
          }, warnMs)
        : null;
    const ceilingTimer = setTimeout(() => {
      timedOut = true;
      settle(null);
    }, ceilingMs);
    void (async (): Promise<void> => {
      try {
        await drainStream(promptStream, (text) => {
          promptBuf += text;
          const p = opts.parse(promptBuf) ?? opts.parse(combined());
          if (p !== null) settle(p);
        });
      } finally {
        if (warnTimer !== null) clearTimeout(warnTimer);
        clearTimeout(ceilingTimer);
        settle(null);
      }
    })();
  });

  if (found === null) {
    // Pull any remaining other-fd bytes so inner EPERM isn't dropped.
    await Promise.race([otherDone, sleep(200)]);
    const captured = combined();
    const cancelled = opts.slot.wasCancelled();
    if (!timedOut) {
      // The prompt reader hit EOF before the ceiling — the child normally has
      // already exited, so this resolves at once. Guard the rare case where the
      // fd closed but the process lingers: race a short grace and kill on
      // expiry, so a wedged child can't hang the connect indefinitely.
      const EXIT_GRACE_MS = 2_000;
      const exitCode = await Promise.race([
        proc.exited,
        sleep(EXIT_GRACE_MS).then(() => null),
      ]);
      if (exitCode === null) {
        try {
          proc.kill();
        } catch {
          // already gone
        }
      }
      opts.slot.end();
      return {
        found: null,
        captured,
        exitCode,
        crashed: exitCode !== null && exitCode !== 0,
        cancelled,
        flow,
      };
    }
    try {
      proc.kill();
    } catch {
      // already gone
    }
    opts.slot.end();
    return {
      found: null,
      captured,
      exitCode: null,
      crashed: false,
      timedOut: true,
      cancelled,
      flow,
    };
  }

  // Prompt parsed: keep the child alive for the localhost callback / device
  // poll. finishInBackground is the ONLY terminal path from here.
  //
  // Abandonment ceiling: the child now holds its localhost callback / device
  // poll waiting for the user. If the user neither finishes NOR cancels, nothing
  // else bounds it — an abandoned `codex login` would sit alive holding that
  // callback indefinitely (leaking a process + a stale pending_auth). Reap it at
  // the login ceiling. A reap is an EXPIRY, not a crash, so report `exitCode: 0`
  // → `finishInBackground` emits `poll_expired` (not `cli_crash`); a login that
  // DID land a credential in the last moment still reports succeeded, since
  // `finishInBackground` checks typed verify before the exit code.
  let reaped = false;
  const reaper = setTimeout(() => {
    reaped = true;
    try {
      proc.kill();
    } catch {
      // already exited — its own exit handler ran
    }
  }, ceilingMs);
  void proc.exited.then((exitCode) => {
    clearTimeout(reaper);
    return finishInBackground({
      provider: opts.provider,
      slot: opts.slot,
      verify: opts.verify,
      waitStoreHint: opts.waitStoreHint,
      verifyWatchdogMs: opts.verifyWatchdogMs,
      onConnected: opts.onConnected,
      exitCode: reaped ? 0 : exitCode,
    });
  });
  return { found };
};

// ─── cancelConnect ───────────────────────────────────────────────────────

/**
 * Build the delegate's `cancelConnect`: run the in-flight flow's canceler(s)
 * via the shared slot + drop the pending code. Idempotent — no in-flight flow
 * is success. The `messages` carry the provider's wording.
 */
export const makeCancelConnect = (
  provider: string,
  slot: TLoginSlot,
  messages: { readonly cancelled: string; readonly none: string },
): (() => Promise<{ readonly ok: boolean; readonly detail: string }>) => {
  return async () => {
    const flow = slot.flow();
    const n = slot.cancelAll();
    clearPendingAuth(provider);
    if (n > 0 && flow !== null) {
      emitLoginFailed(flow, {
        code: "user_cancelled",
        message: messages.cancelled,
        retryable: false,
      });
    }
    return { ok: true, detail: n > 0 ? messages.cancelled : messages.none };
  };
};
