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
import { pendingAuthDetail, setPendingAuth } from "../pending-auth";
import type { TConnectResult, TLoginSlot } from "./login-flow";
import {
  finishInBackground,
  guard,
  makeCancelConnect,
  spawnStreamLogin,
} from "./login-flow";
import type { THeadlessLogin } from "./util";
import { openUrl, spawnHeadlessLogin } from "./util";

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
  readonly beforeLogin?: () => Promise<void>;
  readonly argv: () => ReadonlyArray<string>;
  readonly env: () => Record<string, string>;
  /** Background side effect once the credential lands (warn-if-unrefreshable +
   *  refresh the auth config). Invoked only when connected. */
  readonly onConnected?: () => void | Promise<void>;
  /** Runs after a code is accepted (claude: grant keychain tool access). */
  readonly onCodeAccepted?: () => Promise<void>;
  /** Authoritative connection check after a submitted code. */
  readonly verifyAfterSubmit: () => Promise<boolean>;
  /** The submit success `detail` (refreshable-aware). */
  readonly submitSuccessDetail: () => Promise<string>;
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
      },
      async () => {
        await cfg.beforeLogin?.();
        const login = await spawnHeadlessLogin([...cfg.argv()], cfg.env());
        if ("error" in login) {
          return { connected: false, detail: login.error };
        }
        handle = login;
        cfg.slot.start(() => login.cancel());
        const auth = { url: login.url, code: "", mode: "paste_code" as const };
        setPendingAuth(cfg.provider, auth);
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
            isConnected: cfg.connected,
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
      await cfg.onCodeAccepted?.();
      if (!(await cfg.verifyAfterSubmit())) {
        return {
          ok: false,
          detail: "code accepted but no credential was stored.",
        };
      }
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
  /** Parse the device prompt off stdout → `{ url, code }`. */
  readonly parse: (buf: string) => { url: string; code: string } | null;
  readonly onConnected?: () => void | Promise<void>;
  readonly pendingDetail: (found: { url: string; code: string }) => string;
  readonly failDetail: string;
  /** cancelConnect wording. */
  readonly cancelMessages: {
    readonly cancelled: string;
    readonly none: string;
  };
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
      },
      async () => {
        const res = await spawnStreamLogin({
          provider: cfg.provider,
          slot: cfg.slot,
          argv: cfg.argv(),
          env: cfg.env(),
          stream: "stdout",
          parse: cfg.parse,
          isConnected: cfg.connected,
          onConnected: cfg.onConnected,
        });
        if (res.found === null) {
          return { connected: false, detail: cfg.failDetail };
        }
        setPendingAuth(cfg.provider, {
          url: res.found.url,
          code: res.found.code,
        });
        openUrl(res.found.url);
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
