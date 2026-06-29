/**
 * xAI Grok ("Grok Build", x.ai/cli) delegate.
 *
 * Native delegation: use the installed `grok` CLI's OWN bearer + identity.
 * Grok Build is a subscription-OAuth coding agent (SuperGrok / X Premium+);
 * `grok login` runs a browser OAuth (PKCE, `accounts.x.ai`) and caches the
 * token locally. We never mint/forge/export it — the daemon reads the CLI's
 * own store and injects the bearer for ONE inference call.
 *
 * Wire format: the OpenAI Responses API (`https://api.x.ai/v1/responses`) —
 * the SAME wire as codex/chatgpt — so the coreless walker maps
 * `grok → "chatgpt"` and reuses the Responses transforms (see `walker.ts`).
 *
 * ISOLATED install: the daemon runs its OWN `grok` under
 * `~/.openllm/cli/grok/` with `HOME` pointed inside it (see cli-paths.ts), so
 * it never touches the user's personal `~/.grok`.
 *   - Store: `<HOME>/.grok/auth.json`.
 *   - Login: `grok login` (browser).
 *   - Usage: not yet wired (no confirmed endpoint).
 *
 * ⚠️ RESEARCH-UNVERIFIED — every Grok-specific detail below (auth.json shape,
 * the login subcommand + its authorize-URL output, the token's location, the
 * upstream endpoint, refresh) is inferred from public reverse-engineering
 * (Nous/Hermes `xai-grok-oauth`, `pi-xai-oauth`) and MUST be validated against
 * a real SuperGrok login before this provider is trusted. This mirrors the
 * "research-derived, marked unverified" posture used for codex + kimi.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@quantidexyz/openllmp";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir, cliEnv } from "../cli-paths";
import { logError, logInfo } from "../logger";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import { ensureAuthConfig, resolveUpstreamUrl } from "./auth-config";
import { makeStreamConnect } from "./login-direct";
import { loginSlot, makeCancelConnect } from "./login-flow";
import type { TProviderDelegate } from "./types";
import { readJsonFile, runCapture, stripAnsi } from "./util";

const PROVIDER = "grok" as const;

const bin = (): string => cliBin(PROVIDER);
const env = (): Record<string, string> => cliEnv(PROVIDER);

/** Strip query strings from any URL in a diagnostic string, so OAuth authorize
 *  params (client_id / code_challenge / state) are never persisted to the local
 *  log. Keeps the scheme+host+path for debugging. */
const redactUrls = (s: string): string =>
  s.replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1?<redacted>");

/**
 * Parse the browser authorize URL `grok login` prints.
 * ⚠️ RESEARCH-UNVERIFIED: Grok Build's OAuth issuer is `accounts.x.ai`; matched
 * leniently (any `accounts.x.ai` URL, then any `/authorize` URL) so an issuer
 * tweak doesn't break it. Confirm the exact stdout/stderr shape live.
 */
const parseAuthUrl = (raw: string): string | null => {
  const clean = stripAnsi(raw);
  return (
    clean.match(/https?:\/\/accounts\.x\.ai\/\S+/)?.[0] ??
    clean.match(/https?:\/\/\S*\/(?:oauth\/)?authorize\S+/)?.[0] ??
    null
  );
};

// ⚠️ RESEARCH-UNVERIFIED auth.json shape. We read tolerantly: a flat
// `{ access_token }` OR a nested `{ tokens: { access_token } }` (the two shapes
// the vendor CLIs in this repo use), so a minor structural surprise still reads.
type TGrokTokens = {
  readonly access_token?: string;
  readonly refresh_token?: string;
};
type TGrokStore = TGrokTokens & {
  readonly tokens?: TGrokTokens;
};

const authPath = (): string => join(cliConfigDir(PROVIDER), "auth.json");

const loadStore = (): Promise<TGrokStore | null> =>
  // Isolated HOME → <home>/.grok/auth.json (cliConfigDir).
  readJsonFile<TGrokStore>(authPath());

/**
 * Read the stored access token. ⚠️ NO proactive refresh yet — Grok Build's
 * native refresh trigger is unknown, so an expired token simply 401s upstream
 * and the dashboard prompts a re-sign-in. Wire a CLI-native refresh (mirroring
 * chatgpt's `codex doctor`) once the mechanism is confirmed.
 */
const readToken = async (): Promise<{ accessToken: string } | null> => {
  const store = await loadStore();
  const accessToken = store?.access_token ?? store?.tokens?.access_token;
  if (accessToken === undefined || accessToken.length === 0) return null;
  return { accessToken };
};

// ─── Login wiring ────────────────────────────────────────────────────────
//
// Grok's browser `connect` spawns `grok login`, which prints the authorize URL.
// We surface it (so a remote/headless box can click it from the dashboard) and
// let the process finish the flow in the background; the status watcher flips
// the card on success. Device-code (remote) login is intentionally NOT wired in
// v1 — Grok Build's headless device flow is unverified.

const INSTALL_HINT = "Install the Grok CLI from the Providers tab first.";
const CONNECTED_DETAIL = "signed in via Grok";
const IN_PROGRESS_DETAIL =
  "Grok sign-in already in progress — finish authorizing in your browser; this updates automatically.";

const isInstalled = async (): Promise<boolean> =>
  (await cliInstallState(PROVIDER)).installed;
const isConnected = async (): Promise<boolean> => (await readToken()) !== null;
// A fresh login may rotate the captured upstream URL — refresh the auth config,
// best-effort + non-blocking, exactly as codex's browser flow does.
const refreshConfig = (): void => {
  void ensureAuthConfig(PROVIDER, { force: true }).catch(() => {});
};

const slot = loginSlot(PROVIDER);

const connectDirect = makeStreamConnect({
  provider: PROVIDER,
  slot,
  installed: isInstalled,
  installHint: INSTALL_HINT,
  connected: isConnected,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail: IN_PROGRESS_DETAIL,
  argv: () => [bin(), "login"],
  env,
  parse: (buf) => {
    const url = parseAuthUrl(buf);
    return url !== null ? { url, code: "" } : null;
  },
  onConnected: refreshConfig,
  onStart: () =>
    logInfo("grok-connect", "spawning `grok login` (browser flow)"),
  onParsed: (url) =>
    logInfo("grok-connect", "parsed authorize URL; surfacing to dashboard", {
      urlLen: url.length,
    }),
  onParseFail: (captured) =>
    logError("grok-connect", "no authorize URL parsed from grok login", {
      stderrLen: captured.length,
      stderrSample: redactUrls(captured.slice(0, 400)),
    }),
  pendingDetail: (url) =>
    `Authorize Grok in the browser window that opened — or open ${url}. This page updates automatically once you're done.`,
  failDetail:
    "Couldn't start Grok sign-in. Retry, or run `grok login` on the box.",
});

export const grokDelegate: TProviderDelegate = {
  slug: PROVIDER,

  connect: connectDirect,
  cancelConnect: makeCancelConnect(PROVIDER, slot, {
    cancelled: "Grok sign-in cancelled",
    none: "no sign-in was in progress",
  }),

  status: async () => {
    const { installed, version } = await cliInstallState(PROVIDER);
    const token = installed ? await readToken() : null;
    if (token !== null) clearPendingAuth(PROVIDER);
    const pending = token === null ? getPendingAuth(PROVIDER) : null;
    return {
      provider: PROVIDER,
      connected: token !== null,
      cli_installed: installed,
      ...(version !== null ? { cli_version: version } : {}),
      ...(pending !== null
        ? { pending_auth: { url: pending.url, code: pending.code } }
        : {}),
      ...(token === null
        ? {
            detail:
              pending !== null
                ? pendingAuthDetail(pending)
                : installed
                  ? "grok CLI installed but not signed in"
                  : "grok CLI not installed",
          }
        : { last_login_at_ms: null }),
    };
  },

  usage: async (): Promise<TProviderUsageSnapshot> => {
    const token = await readToken();
    if (token === null) {
      return { kind: "unavailable", reason: "not signed in to Grok" };
    }
    // ⚠️ RESEARCH-UNVERIFIED: Grok Build has no confirmed subscription-usage
    // endpoint. Report unavailable rather than guessing one. Wire a real
    // quota read (mirroring chatgpt's `/backend-api/wham/usage`) once known.
    return {
      kind: "unavailable",
      reason: "Grok usage reporting is not yet wired",
    };
  },

  credentialForUpstream: async () => {
    const token = await readToken();
    if (token === null) {
      throw new Error("grok: not signed in (no stored credential)");
    }
    // Resolve only the request TARGET URL (the captured/default Responses
    // endpoint). No credential-intrinsic header beyond the bearer is known to
    // be required for api.x.ai; the originator's own headers ride through.
    const url = await resolveUpstreamUrl(PROVIDER);
    return { access_token: token.accessToken, headers: {}, url };
  },

  logout: async () => {
    // ⚠️ RESEARCH-UNVERIFIED: `grok logout` is assumed to revoke + clear the
    // store. We additionally rm the isolated auth.json so a missing/renamed
    // subcommand still leaves the box signed out.
    if ((await cliInstallState(PROVIDER)).installed) {
      await runCapture([bin(), "logout"], env());
    }
    await rm(authPath(), { force: true }).catch(() => {});
    const cleared = (await readToken()) === null;
    return cleared
      ? { ok: true, detail: "signed out of Grok" }
      : { ok: false, detail: "credential still present after logout" };
  },
};
