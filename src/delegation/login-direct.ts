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
import { clearPendingAuth, setPendingAuth } from "../pending-auth";
import type { TConnectResult, TLoginSlot } from "./login-flow";
import { guard, spawnStreamLogin } from "./login-flow";
import type { TLoginResult } from "./util";
import { openUrl, spawnLogin } from "./util";

// ─── claude: blocking native login ───────────────────────────────────────

export type TBlockingConnectConfig = {
  readonly provider: string;
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Runs before the login spawn (claude: ensure the isolated keychain). */
  readonly beforeLogin?: () => Promise<void>;
  readonly argv: () => ReadonlyArray<string>;
  readonly env: () => Record<string, string>;
  /** Runs after the login spawn (claude: grant keychain tool access). */
  readonly afterLogin?: () => Promise<void>;
  /** Authoritative connection check after the login completes. */
  readonly verifyConnected: () => Promise<boolean>;
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
      },
      async () => {
        await cfg.beforeLogin?.();
        const result = await spawnLogin([...cfg.argv()], cfg.env());
        await cfg.afterLogin?.();
        if (await cfg.verifyConnected()) {
          await cfg.onConnected?.();
          return { connected: true, detail: await cfg.successDetail() };
        }
        return { connected: false, detail: cfg.failDetail(result) };
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
  /** Parse the authorize URL off the chosen fd → `{ url, code }` (code: ""). */
  readonly parse: (buf: string) => { url: string; code: string } | null;
  readonly onConnected?: () => void | Promise<void>;
  /** Diagnostics: before spawn, after a successful parse, on a parse miss
   *  (the captured output is passed so the caller can redact + log it). */
  readonly onStart?: () => void;
  readonly onParsed?: (url: string) => void;
  readonly onParseFail?: (captured: string) => void;
  readonly pendingDetail: (url: string) => string;
  readonly failDetail: string;
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
      },
      async () => {
        cfg.onStart?.();
        const res = await spawnStreamLogin({
          provider: cfg.provider,
          slot: cfg.slot,
          argv: cfg.argv(),
          env: cfg.env(),
          stream: "stderr",
          parse: cfg.parse,
          isConnected: cfg.connected,
          onConnected: cfg.onConnected,
        });
        if (res.found === null) {
          cfg.onParseFail?.(res.captured);
          return { connected: false, detail: cfg.failDetail };
        }
        cfg.onParsed?.(res.found.url);
        setPendingAuth(cfg.provider, {
          url: res.found.url,
          code: res.found.code,
        });
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
): void => {
  let aborted = false;
  cfg.slot.start(() => {
    aborted = true;
  });
  void (async () => {
    const deadline = Date.now() + auth.expiresInMs;
    let delayMs = auth.intervalMs;
    try {
      while (Date.now() < deadline) {
        if (aborted) return;
        await sleep(delayMs);
        if (aborted) return;
        const res = await cfg.pollToken(auth.deviceCode);
        // Re-check AFTER the awaited poll: a cancel that arrived while the
        // request was in flight must win, or we'd sign in a cancelled login.
        if (aborted) return;
        if (res.kind === "success") {
          cfg.onCredential(res.wire);
          await cfg.onConnected?.();
          return;
        }
        if (res.kind === "stop") return;
        if (res.slowDown) delayMs += 5_000;
      }
    } catch {
      // swallow — the user can retry Connect
    } finally {
      cfg.slot.end();
      clearPendingAuth(cfg.provider);
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
      },
      async () => {
        const auth = await cfg.requestDeviceAuth();
        if (auth === null) {
          return { connected: false, detail: cfg.startFailDetail };
        }
        // Surface URL+code to the dashboard (the daemon may be on a different
        // machine than the user's browser). `openUrl` brings up the browser on
        // this box; on a remote box it opens nothing useful but the dashboard
        // shows these so the user authorizes from THEIR machine.
        setPendingAuth(cfg.provider, {
          url: auth.verificationUriComplete,
          code: auth.userCode,
        });
        openUrl(auth.verificationUriComplete);
        startDeviceCodePoll(cfg, auth);
        return {
          connected: false,
          pending: true,
          detail: cfg.pendingDetail(auth),
        };
      },
    );
};
