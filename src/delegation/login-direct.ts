/**
 * The DIRECT (native `connect()`) login adaptor.
 *
 * Builds each delegate's on-this-box `connect()` from injected provider
 * specifics, on top of the shared scaffolding in `login-flow.ts`. There are
 * three native mechanisms — one per provider — each a small factory:
 *   - `makeBlockingConnect`  → claude: spawn `claude auth login`, BLOCK, verify.
 *   - `makeStreamConnect`    → codex: spawn `codex login`, parse the authorize
 *                              URL off stderr, surface it, complete in background.
 *   - `makeDeviceCodeConnect`→ kimi: run the vendor device-code OAuth handshake
 *                              (request → surface URL+code → background poll).
 *
 * Provider atoms (bin/env, token reads, parse fns, keychain hooks, the wire
 * request/poll calls) are injected — this file never imports a delegate, so
 * there is no cycle.
 */

import { clearPendingAuth } from "../pending-auth";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import type {
  TConnectResult,
  TLoginFlowCtx,
  TLoginSlot,
  TLoginTerminalEvent,
  TLoginVerify,
} from "./login-flow";
import {
  booleanLoginVerify,
  emitLoginFailed,
  emitLoginStarted,
  emitLoginSucceeded,
  finalizeLoginTerminal,
  guard,
  LOGIN_VERIFY_WATCHDOG_MS,
  openAuthUrlUnlessCancelled,
  publishPendingAuth,
  resolveLoginFlow,
  spawnStreamLogin,
  streamLoginFail,
  waitLoginVerifyHint,
} from "./login-flow";
import { KEYCHAIN_NOT_READY_DETAIL, loginReady } from "./login-readiness";
import type { TLoginResult, TStoreRead } from "./util";
import { spawnLogin } from "./util";

// ─── claude: blocking native login ───────────────────────────────────────

export type TBlockingConnectConfig = {
  readonly provider: string;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Runs before the login spawn (claude: ensure the isolated keychain). */
  readonly beforeLogin?: () => Promise<TStoreRead<void> | void>;
  readonly argv: () => ReadonlyArray<string>;
  readonly env: () => Record<string, string>;
  /** Runs after the login spawn (claude: grant keychain tool access). */
  readonly afterLogin?: () => Promise<boolean | undefined>;
  /** Authoritative connection check after the login completes. */
  readonly verifyConnected: () => Promise<TLoginVerify>;
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
  readonly verifyWatchdogMs?: number;
  /** Fire-and-forget side effect on success (claude: refresh the auth config). */
  readonly onConnected?: () => void | Promise<void>;
  /** The success `detail` — provider-computed so it can flag a credential that
   *  can't auto-refresh (claude's no-refresh-token warning). */
  readonly successDetail: () => Promise<string>;
  /** The failure `detail`, from the (abandoned-or-exited) login output. */
  readonly failDetail: (result: TLoginResult) => string;
};

/**
 * claude's `connect`: a SYNCHRONOUS browser login — `claude auth login` opens
 * the browser and blocks until its own localhost callback completes, then the
 * credential is in the CLI's store. No single-flight / pending-auth (the call
 * blocks for the whole flow), so no slot.
 */
export const makeBlockingConnect = (
  cfg: TBlockingConnectConfig,
): (() => Promise<TConnectResult>) => {
  return () =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        mode: "browser",
      },
      async () => {
        const flow = resolveLoginFlow(cfg.provider, "browser");
        const ready = await cfg.beforeLogin?.();
        if (!loginReady(ready)) {
          emitLoginFailed(flow, {
            code: "spawn_denied",
            message: KEYCHAIN_NOT_READY_DETAIL,
            retryable: true,
          });
          return { connected: false, detail: KEYCHAIN_NOT_READY_DETAIL };
        }
        emitLoginStarted(flow);
        // Keychain-dependent login (claude) runs unconfined on macOS — see
        // `sandbox/policy.ts`; codex/kimi/grok stay confined on both platforms.
        const result = await spawnLogin([...cfg.argv()], cfg.env(), {
          probe: unwrapKeychainSpawn(cfg.provider),
        });
        const granted = await cfg.afterLogin?.();
        const sample = async (): Promise<TLoginVerify> => {
          try {
            return await cfg.verifyConnected();
          } catch {
            return { state: "unavailable" };
          }
        };
        let verified = await sample();
        if (verified.state === "unavailable") {
          await waitLoginVerifyHint({
            waitStoreHint: cfg.waitStoreHint,
            verifyWatchdogMs: cfg.verifyWatchdogMs ?? LOGIN_VERIFY_WATCHDOG_MS,
          });
          verified = await sample();
        }
        if (verified.state === "connected") {
          if (granted === false) {
            emitLoginFailed(flow, {
              code: "spawn_denied",
              message: KEYCHAIN_NOT_READY_DETAIL,
              retryable: true,
            });
            return { connected: false, detail: KEYCHAIN_NOT_READY_DETAIL };
          }
          await cfg.onConnected?.();
          emitLoginSucceeded(flow);
          return { connected: true, detail: await cfg.successDetail() };
        }
        const detail = cfg.failDetail(result);
        if (verified.state === "unavailable") {
          emitLoginFailed(flow, {
            code: "poll_expired",
            message: detail,
            retryable: true,
          });
          return { connected: false, detail };
        }
        const crashed = typeof result.code === "number" && result.code !== 0;
        emitLoginFailed(flow, {
          code: crashed ? "cli_crash" : "poll_expired",
          message: detail,
          retryable: !crashed,
        });
        return { connected: false, detail };
      },
    );
};

// ─── codex: stream-spawn native login ────────────────────────────────────

export type TStreamConnectConfig = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Already-signed-in short-circuit + its detail. */
  readonly connected: () => Promise<boolean>;
  readonly connectedDetail: string;
  /** Re-surface detail when a login is already in flight. */
  readonly inProgressDetail: string;
  readonly argv: () => ReadonlyArray<string>;
  readonly env: () => Record<string, string>;
  /** Which fd carries the authorize URL. Codex/Grok: stderr. Cursor: stdout. Default stderr. */
  readonly stream?: "stdout" | "stderr";
  /** Parse the authorize URL off the chosen fd → `{ url, code }` (code: ""). */
  readonly parse: (buf: string) => { url: string; code: string } | null;
  /** Runs once a credential lands. Returning `false` FAILS the login — the
   *  keychain partition-list grant is observed, not best-effort. */
  readonly onConnected?: () =>
    | boolean
    | void
    | Promise<boolean>
    | Promise<void>;
  /** Cursor: isolated keychain must be `present` before a prompt-capable spawn. */
  readonly beforeLogin?: () => Promise<TStoreRead<void> | void>;
  /** Diagnostics: before spawn, after a successful parse, on a parse miss
   *  (the captured output is passed so the caller can redact + log it). */
  readonly onStart?: () => void;
  readonly onParsed?: (url: string) => void;
  readonly onParseFail?: (captured: string) => void;
  readonly pendingDetail: (url: string) => string;
  /** Detail when NO prompt was parsed — the benign case (the child is still
   *  running its browser flow, or timed out): a generic "Retry" is right. */
  readonly failDetail: string;
  /** Detail when the login child CRASHED (exited non-zero before a prompt).
   *  A retry can't fix a deterministic crash, so surface the captured error
   *  instead of `failDetail`. Optional — omit to keep the generic message. */
  readonly crashDetail?: (captured: string, exitCode: number | null) => string;
  /** File-store identity hint after child exit (not Darwin keychain). */
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
};

/**
 * codex's `connect`: spawn `codex login`, which binds a localhost callback +
 * prints the authorize URL to STDERR. We parse + surface that URL (codex opens
 * its OWN browser, so we do NOT open a second tab) and let the process complete
 * the flow in the background; the status watcher flips the card on success.
 */
export const makeStreamConnect = (
  cfg: TStreamConnectConfig,
): (() => Promise<TConnectResult>) => {
  return () =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        shortCircuit: { connected: cfg.connected, detail: cfg.connectedDetail },
        slot: cfg.slot,
        inProgressDetail: cfg.inProgressDetail,
        mode: "browser",
      },
      async () => {
        const ready = await cfg.beforeLogin?.();
        if (!loginReady(ready)) {
          const flow = resolveLoginFlow(cfg.provider, "browser");
          emitLoginFailed(flow, {
            code: "spawn_denied",
            message: KEYCHAIN_NOT_READY_DETAIL,
            retryable: true,
          });
          return { connected: false, detail: KEYCHAIN_NOT_READY_DETAIL };
        }
        cfg.onStart?.();
        const res = await spawnStreamLogin({
          provider: cfg.provider,
          slot: cfg.slot,
          argv: cfg.argv(),
          env: cfg.env(),
          stream: cfg.stream ?? "stderr",
          parse: cfg.parse,
          verify: () => booleanLoginVerify(cfg.connected),
          waitStoreHint: cfg.waitStoreHint,
          onConnected: cfg.onConnected,
          // cursor's store is the macOS keychain → unconfined on mac; codex is
          // file-backed → stays confined (`sandbox/policy.ts`).
          probe: unwrapKeychainSpawn(cfg.provider),
          mode: "browser",
        });
        if (res.found === null) {
          if (res.cancelled === true) {
            return { connected: false, detail: "sign-in cancelled" };
          }
          if (res.spawnFailure === undefined) cfg.onParseFail?.(res.captured);
          const fail = streamLoginFail(cfg.failDetail, res, cfg.crashDetail);
          emitLoginFailed(res.flow, fail);
          return { connected: false, detail: fail.message };
        }
        cfg.onParsed?.(res.found.url);
        const flow =
          cfg.slot.flow() ?? resolveLoginFlow(cfg.provider, "browser");
        publishPendingAuth(flow, cfg.provider, res.found);
        return {
          connected: false,
          pending: true,
          detail: cfg.pendingDetail(res.found.url),
        };
      },
    );
};

// ─── kimi: device-code native login ──────────────────────────────────────

export type TDeviceAuth = {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly verificationUriComplete: string;
  readonly intervalMs: number;
  readonly expiresInMs: number;
};

export type TDevicePoll =
  | { readonly kind: "success"; readonly wire: Record<string, unknown> }
  | { readonly kind: "pending"; readonly slowDown: boolean }
  | { readonly kind: "stop" };

export type TDeviceCodeConnectConfig = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  readonly connected: () => Promise<boolean>;
  readonly connectedDetail: string;
  /** Fixed re-surface string (kimi returns no `pending` flag, unlike codex). */
  readonly inProgressDetail: string;
  /** Request a device code from the vendor (null on failure). */
  readonly requestDeviceAuth: () => Promise<TDeviceAuth | null>;
  /** Poll the token endpoint for one device code. */
  readonly pollToken: (deviceCode: string) => Promise<TDevicePoll>;
  /** Persist the credential the poll returned (writes the CLI's store shape). */
  readonly onCredential: (wire: Record<string, unknown>) => void;
  /** Fire-and-forget side effect after the credential lands (refresh config). */
  readonly onConnected?: () => void | Promise<void>;
  readonly pendingDetail: (auth: TDeviceAuth) => string;
  readonly startFailDetail: string;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Background device-code poll: register an abort canceler on the slot, then
 * poll the token endpoint until success / stop / expiry. On success persist the
 * credential + refresh the auth config; the `finally` always clears single-flight
 * and drops the in-memory device code (on success `status()` reports connected
 * from the token regardless; on expiry/denial it stops showing a dead code).
 */
const startDeviceCodePoll = (
  cfg: TDeviceCodeConnectConfig,
  auth: TDeviceAuth,
  flow: TLoginFlowCtx,
): void => {
  let aborted = false;
  let outcome: "success" | "stop" | "expired" | "aborted" = "expired";
  cfg.slot.start(() => {
    aborted = true;
  }, flow);
  void (async () => {
    const deadline = Date.now() + auth.expiresInMs;
    let delayMs = auth.intervalMs;
    try {
      while (Date.now() < deadline) {
        if (aborted) {
          outcome = "aborted";
          return;
        }
        await sleep(delayMs);
        if (aborted) {
          outcome = "aborted";
          return;
        }
        let res: TDevicePoll;
        try {
          res = await cfg.pollToken(auth.deviceCode);
        } catch {
          // A transient poll failure (network blip / parse error) must NOT end
          // the whole login — keep polling until success, stop, cancel, or
          // expiry. The next iteration retries after the same backoff.
          continue;
        }
        // Re-check AFTER the awaited poll: a cancel that arrived while the
        // request was in flight must win, or we'd sign in a cancelled login.
        if (aborted) {
          outcome = "aborted";
          return;
        }
        if (res.kind === "success") {
          cfg.onCredential(res.wire);
          await cfg.onConnected?.();
          outcome = "success";
          return;
        }
        if (res.kind === "stop") {
          outcome = "stop";
          return;
        }
        if (res.slowDown) delayMs += 5_000;
      }
    } catch {
      // swallow — the user can retry Connect
    } finally {
      const cancelled = cfg.slot.wasCancelled() || aborted;
      cfg.slot.end();
      const event: TLoginTerminalEvent =
        outcome === "success"
          ? { kind: "succeeded" }
          : cancelled
            ? { kind: "none" }
            : {
                kind: "failed",
                code: outcome === "stop" ? "cli_crash" : "poll_expired",
                message:
                  outcome === "stop"
                    ? "sign-in was rejected"
                    : "sign-in expired before a credential landed",
                retryable: outcome !== "stop",
              };
      finalizeLoginTerminal({
        flow,
        event,
        provider: cfg.provider,
        clearPending: true,
      });
    }
  })();
};

/**
 * kimi's `connect`: the CLI's sign-in is the in-TUI `/login` slash command
 * (raw-mode TTY), which the daemon can't spawn — so the daemon drives kimi's
 * OWN device-code OAuth flow directly: request a device code, open the
 * pre-filled verification URL, surface URL+code to the dashboard, and poll in
 * the background. On success the credential file lands; the status watcher flips
 * the card.
 */
export const makeDeviceCodeConnect = (
  cfg: TDeviceCodeConnectConfig,
): (() => Promise<TConnectResult>) => {
  return () =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        shortCircuit: { connected: cfg.connected, detail: cfg.connectedDetail },
        slot: cfg.slot,
        resurface: () => ({ connected: false, detail: cfg.inProgressDetail }),
        mode: "device_code",
      },
      async () => {
        const flow = resolveLoginFlow(cfg.provider, "device_code");
        const auth = await cfg.requestDeviceAuth();
        if (auth === null) {
          emitLoginFailed(flow, {
            code: "cli_crash",
            message: cfg.startFailDetail,
            retryable: true,
          });
          return { connected: false, detail: cfg.startFailDetail };
        }
        emitLoginStarted(flow);
        // A cancel_connect can land while `requestDeviceAuth` was in flight —
        // the slot isn't in-flight yet, but `cancelAll` still set `wasCancelled`.
        // Check it BEFORE `startDeviceCodePoll`, whose `slot.start()` resets the
        // flag: otherwise we'd open a browser + start polling a login the user
        // already cancelled. Guarding the URL-open here is that last observation.
        if (
          !openAuthUrlUnlessCancelled(cfg.slot, auth.verificationUriComplete)
        ) {
          clearPendingAuth(cfg.provider);
          emitLoginFailed(flow, {
            code: "user_cancelled",
            message: "sign-in cancelled",
            retryable: true,
          });
          return { connected: false, detail: "sign-in cancelled" };
        }
        // Surface URL+code to the dashboard (the daemon may be on a different
        // machine than the user's browser). The browser is already up (above);
        // on a remote box it opens nothing useful but the dashboard shows these
        // so the user authorizes from THEIR machine.
        publishPendingAuth(flow, cfg.provider, {
          url: auth.verificationUriComplete,
          code: auth.userCode,
        });
        startDeviceCodePoll(cfg, auth, flow);
        return {
          connected: false,
          pending: true,
          detail: cfg.pendingDetail(auth),
        };
      },
    );
};
