/**
 * The DEVICE (remote/headless `connectDeviceCode()`) login adaptor.
 *
 * Builds each delegate's remote-box login — the flow that surfaces an authorize
 * URL (± one-time code) so the user authorizes from THEIR machine — on top of
 * the shared scaffolding in `login-flow.ts`. Two mechanisms:
 *   - `makePasteBackDevice` → claude: a headless `claude auth login` that prints
 *     a hosted-callback URL and consumes a pasted code on stdin (returns
 *     `connectDeviceCode` + `submitLoginCode` + `cancelConnect`).
 *   - `makeStreamDeviceConnect` → codex: spawn `codex login --device-auth`, parse
 *     the device prompt off stdout, surface URL+code, poll in the background
 *     (returns `connectDeviceCode` + `cancelConnect`).
 *
 * The single-flight slot is the SAME `loginSlot(provider)` the direct adaptor
 * uses, so codex's two login methods stay mutually exclusive, and `cancelConnect`
 * cancels whichever flow is live. Provider atoms are injected — no delegate import.
 */

import { pendingAuthDetail } from "../pending-auth";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import type { TConnectResult, TLoginSlot, TLoginVerify } from "./login-flow";
import {
  booleanLoginVerify,
  emitLoginFailed,
  emitLoginStarted,
  finishInBackground,
  guard,
  makeCancelConnect,
  openAuthUrlUnlessCancelled,
  publishPendingAuth,
  resolveLoginFlow,
  spawnStreamLogin,
  streamLoginFail,
} from "./login-flow";
import { KEYCHAIN_NOT_READY_DETAIL, loginReady } from "./login-readiness";
import type { THeadlessLogin, TStoreRead } from "./util";
import { spawnHeadlessLogin } from "./util";

type TCancelConnect = () => Promise<{
  readonly ok: boolean;
  readonly detail: string;
}>;

// ─── claude: headless paste-back ─────────────────────────────────────────

export type TPasteBackConfig = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Already-signed-in short-circuit + its detail. */
  readonly connected: () => Promise<boolean>;
  readonly connectedDetail: string;
  /** Re-surface detail when a login is already in flight. */
  readonly inProgressDetail: string;
  /** Runs before the login spawn (claude: ensure the isolated keychain). */
  readonly beforeLogin?: () => Promise<TStoreRead<void> | void>;
  readonly argv: () => ReadonlyArray<string>;
  readonly env: () => Record<string, string>;
  /** Background side effect once the credential lands (warn-if-unrefreshable +
   *  refresh the auth config). Invoked only when connected. */
  readonly onConnected?: () => void | Promise<void>;
  /** Runs after a code is accepted (claude: grant keychain tool access). */
  readonly onCodeAccepted?: () => Promise<boolean | undefined>;
  /** Authoritative connection check after a submitted code. */
  readonly verifyAfterSubmit: () => Promise<TLoginVerify>;
  /** Typed verify for background-exit cleanup. Defaults to wrapping `connected`. */
  readonly verify?: () => Promise<TLoginVerify>;
  /** The submit success `detail` (refreshable-aware). */
  readonly submitSuccessDetail: () => Promise<string>;
  /** File-store identity hint after child exit (not Darwin keychain). */
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
};

export type TPasteBackDevice = {
  readonly connectDeviceCode: () => Promise<TConnectResult>;
  readonly submitLoginCode: (code: string) => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  readonly cancelConnect: TCancelConnect;
};

/**
 * claude's remote login: spawn `claude auth login --claudeai` headless
 * (DISPLAY stripped, browser suppressed), surface the hosted-callback URL via
 * pending-auth (`paste_code` mode → dashboard paste panel), and hold the process
 * open on stdin until the user pastes the code (`submitLoginCode`) or cancels.
 * The credential that lands is the real refreshable claude.ai OAuth one.
 */
export const makePasteBackDevice = (
  cfg: TPasteBackConfig,
): TPasteBackDevice => {
  // The live headless login handle, awaiting the user's pasted code. Single-
  // flight — one in-flight paste-back per provider (the slot also guards it).
  let handle: THeadlessLogin | null = null;
  // The in-flight code submission, if any. A VALID pasted code exits the CLI —
  // firing `login.done` (the finalizer) AND resolving `submitLoginCode`, which
  // grants prompt-free keychain access (`onCodeAccepted`). The finalizer must
  // wait for that submit so `finishInBackground` runs its connection check +
  // `onConnected` (the auth-config refresh) AFTER the grant, not racing before
  // it (where the credential isn't yet readable → a false not-connected).
  let submitting: Promise<unknown> | null = null;

  const connectDeviceCode = (): Promise<TConnectResult> =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        shortCircuit: { connected: cfg.connected, detail: cfg.connectedDetail },
        slot: cfg.slot,
        inProgressDetail: cfg.inProgressDetail,
        mode: "paste_code",
      },
      async () => {
        const flow = resolveLoginFlow(cfg.provider, "paste_code");
        const ready = await cfg.beforeLogin?.();
        if (!loginReady(ready)) {
          emitLoginFailed(flow, {
            code: "spawn_denied",
            message: KEYCHAIN_NOT_READY_DETAIL,
            retryable: true,
          });
          return { connected: false, detail: KEYCHAIN_NOT_READY_DETAIL };
        }
        // Keychain-dependent paste-back login (claude) is unconfined on macOS
        // (`sandbox/policy.ts`).
        const login = await spawnHeadlessLogin([...cfg.argv()], cfg.env(), {
          probe: unwrapKeychainSpawn(cfg.provider),
        });
        if ("error" in login) {
          emitLoginFailed(flow, {
            code: "cli_crash",
            message: login.error,
            retryable: false,
          });
          return { connected: false, detail: login.error };
        }
        handle = login;
        cfg.slot.start(() => login.cancel(), flow);
        emitLoginStarted(flow);
        const auth = {
          url: login.url,
          code: "",
          mode: "paste_code" as const,
        };
        publishPendingAuth(flow, cfg.provider, auth);
        // On exit (success, cancel, or expiry) drop the handle + the stale
        // pending URL; on success run onConnected (warn + refresh auth config).
        // Wait for any in-flight submit FIRST so the keychain grant lands before
        // the connection check (a valid code triggers both at once).
        void login.done.then(async () => {
          handle = null;
          if (submitting !== null) await submitting.catch(() => {});
          await finishInBackground({
            provider: cfg.provider,
            slot: cfg.slot,
            verify: cfg.verify ?? (() => booleanLoginVerify(cfg.connected)),
            waitStoreHint: cfg.waitStoreHint,
            onConnected: cfg.onConnected,
            alwaysClearPending: true,
          });
        });
        return {
          connected: false,
          pending: true,
          detail: pendingAuthDetail(auth),
        };
      },
    );

  const submitLoginCode = async (
    code: string,
  ): Promise<{ readonly ok: boolean; readonly detail?: string }> => {
    const current = handle;
    if (current === null) {
      return { ok: false, detail: "no Claude sign-in is awaiting a code." };
    }
    // Track this submission so the `login.done` finalizer can await it: a valid
    // code exits the CLI, firing the finalizer concurrently with the keychain
    // grant + verify below.
    const work = (async (): Promise<{
      readonly ok: boolean;
      readonly detail?: string;
    }> => {
      const r = await current.submitCode(code);
      if (!r.ok) return { ok: false, detail: r.detail };
      const granted = await cfg.onCodeAccepted?.();
      if (granted === false) {
        return { ok: false, detail: KEYCHAIN_NOT_READY_DETAIL };
      }
      const submitted = await cfg.verifyAfterSubmit();
      if (submitted.state === "absent") {
        return {
          ok: false,
          detail: "code accepted but no credential was stored.",
        };
      }
      // unavailable must not fail a paste whose code was accepted — finishInBackground
      // re-reads with a store hint / watchdog.
      return { ok: true, detail: await cfg.submitSuccessDetail() };
    })();
    submitting = work;
    try {
      return await work;
    } finally {
      submitting = null;
    }
  };

  const cancelConnect = makeCancelConnect(cfg.provider, cfg.slot, {
    cancelled: "sign-in cancelled",
    none: "sign-in cancelled",
  });

  return { connectDeviceCode, submitLoginCode, cancelConnect };
};

// ─── codex: stream-spawn device-code ─────────────────────────────────────

export type TStreamDeviceConfig = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  readonly connected: () => Promise<boolean>;
  readonly connectedDetail: string;
  readonly inProgressDetail: string;
  readonly argv: () => ReadonlyArray<string>;
  readonly env: () => Record<string, string>;
  /** Which fd carries the device prompt. Codex uses stdout; Grok uses stderr. */
  readonly stream?: "stdout" | "stderr";
  readonly parse: (buf: string) => { url: string; code: string } | null;
  readonly onConnected?: () => void | Promise<void>;
  readonly pendingDetail: (found: { url: string; code: string }) => string;
  readonly failDetail: string;
  /** Detail when the login child CRASHED (exited non-zero before a prompt).
   *  Optional — omit to fall back to `failDetail` plus the redacted capture. */
  readonly crashDetail?: (captured: string, exitCode: number | null) => string;
  /** cancelConnect wording. */
  readonly cancelMessages: {
    readonly cancelled: string;
    readonly none: string;
  };
  readonly waitStoreHint?: (signal: AbortSignal) => Promise<void>;
};

export type TStreamDevice = {
  readonly connectDeviceCode: () => Promise<TConnectResult>;
  readonly cancelConnect: TCancelConnect;
};

/**
 * codex's remote login: run `codex login --device-auth`, capture the
 * verification URL + one-time code off stdout, surface them (and open the URL
 * locally — kimi's device flow does the same), then let the process poll in the
 * background and write auth.json on success.
 */
export const makeStreamDeviceConnect = (
  cfg: TStreamDeviceConfig,
): TStreamDevice => {
  const connectDeviceCode = (): Promise<TConnectResult> =>
    guard(
      {
        provider: cfg.provider,
        installed: cfg.installed,
        installHint: cfg.installHint,
        shortCircuit: { connected: cfg.connected, detail: cfg.connectedDetail },
        slot: cfg.slot,
        inProgressDetail: cfg.inProgressDetail,
        mode: "device_code",
      },
      async () => {
        const res = await spawnStreamLogin({
          provider: cfg.provider,
          slot: cfg.slot,
          argv: cfg.argv(),
          env: cfg.env(),
          stream: cfg.stream ?? "stdout",
          parse: cfg.parse,
          verify: () => booleanLoginVerify(cfg.connected),
          waitStoreHint: cfg.waitStoreHint,
          onConnected: cfg.onConnected,
          // codex/grok device-code login is file-backed → stays confined
          // (`sandbox/policy.ts`); the predicate returns false for them.
          probe: unwrapKeychainSpawn(cfg.provider),
          mode: "device_code",
        });
        if (res.found === null) {
          if (res.cancelled === true) {
            return { connected: false, detail: "sign-in cancelled" };
          }
          const fail = streamLoginFail(cfg.failDetail, res, cfg.crashDetail);
          emitLoginFailed(res.flow, fail);
          return { connected: false, detail: fail.message };
        }
        // A cancel_connect can land between the prompt parsing and here; don't
        // pop a browser on a user who already stopped. `spawnStreamLogin` kills
        // the child on cancel, so only the URL-open needs guarding.
        if (!openAuthUrlUnlessCancelled(cfg.slot, res.found.url)) {
          return { connected: false, detail: "sign-in cancelled" };
        }
        const flow =
          cfg.slot.flow() ?? resolveLoginFlow(cfg.provider, "device_code");
        publishPendingAuth(flow, cfg.provider, res.found);
        return {
          connected: false,
          pending: true,
          detail: cfg.pendingDetail(res.found),
        };
      },
    );

  const cancelConnect = makeCancelConnect(
    cfg.provider,
    cfg.slot,
    cfg.cancelMessages,
  );

  return { connectDeviceCode, cancelConnect };
};
