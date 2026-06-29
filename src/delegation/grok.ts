/**
 * xAI Grok ("Grok Build", x.ai/cli) delegate.
 *
 * Native delegation: use the installed `grok` CLI's OWN bearer + identity.
 * Grok Build is a subscription-OAuth coding agent (SuperGrok / X Premium+);
 * `grok login` runs a browser OAuth (PKCE, issuer `auth.x.ai`) and caches the
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
 *
 * VERIFIED against grok CLI 0.2.73 (from its bundled
 * `docs/user-guide/02-authentication.md` + a real login):
 *   - Store: `<HOME>/.grok/auth.json` — a MAP of session entries keyed by
 *     `"<issuer>::<session-id>"`; each entry's `key` is the access-token JWT,
 *     alongside `refresh_token` + `expires_at` (see {@link readToken}).
 *   - Login: `grok login` (browser OAuth at `auth.x.ai`, default `--oauth`);
 *     `grok login --device-auth` is the headless/remote device-code flow.
 *   - Logout: `grok logout` (no flags) clears the cached credentials.
 *
 * ⚠️ STILL UNVALIDATED: the upstream INFERENCE endpoint (assumed
 * `api.x.ai/v1/responses`) and token REFRESH (the CLI refreshes silently only
 * when IT runs; the daemon injects the token directly, so a token past
 * `expires_at` 401s and the dashboard prompts a re-sign-in). Usage reporting is
 * stubbed (no confirmed endpoint).
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
 * Parse the browser authorize URL `grok login` prints. The OAuth issuer is
 * `auth.x.ai` (verified). Matched leniently (any `auth.x.ai` URL, then any
 * `/authorize` URL) so an issuer/path tweak doesn't break it.
 */
const parseAuthUrl = (raw: string): string | null => {
  const clean = stripAnsi(raw);
  return (
    clean.match(/https?:\/\/auth\.x\.ai\/\S+/)?.[0] ??
    clean.match(/https?:\/\/\S*\/(?:oauth\/)?authorize\S+/)?.[0] ??
    null
  );
};

// auth.json is a MAP of session entries keyed by `"<issuer>::<session-id>"`
// (verified against grok 0.2.73). The access token is the `key` field of a
// session (an OIDC JWT); `refresh_token` + `expires_at` sit alongside it. There
// can be several sessions (one per signed-in account) — we use the newest one
// carrying a usable token.
type TGrokSession = {
  /** The access-token JWT sent as `Authorization: Bearer <key>`. */
  readonly key?: string;
  readonly refresh_token?: string;
  /** ISO-8601 expiry of the access token. */
  readonly expires_at?: string;
  /** ISO-8601 session creation time — used to pick the newest session. */
  readonly create_time?: string;
  readonly auth_mode?: string;
};
type TGrokStore = Readonly<Record<string, TGrokSession>>;

const authPath = (): string => join(cliConfigDir(PROVIDER), "auth.json");

const loadStore = (): Promise<TGrokStore | null> =>
  // Isolated HOME → <home>/.grok/auth.json (cliConfigDir).
  readJsonFile<TGrokStore>(authPath());

/**
 * Read the stored access token — the `key` of the newest session entry.
 * ⚠️ NO proactive refresh: grok refreshes its token silently only when the CLI
 * itself runs, but the daemon injects the token directly, so a token past
 * `expires_at` 401s upstream and the dashboard prompts a re-sign-in. A
 * CLI-native refresh trigger is a follow-up.
 */
const readToken = async (): Promise<{ accessToken: string } | null> => {
  const store = await loadStore();
  if (store === null) return null;
  const sessions = Object.values(store).filter(
    (s): s is TGrokSession & { readonly key: string } =>
      typeof s?.key === "string" && s.key.length > 0,
  );
  if (sessions.length === 0) return null;
  // Newest session first — ISO `create_time` sorts lexicographically.
  sessions.sort((a, b) =>
    (b.create_time ?? "").localeCompare(a.create_time ?? ""),
  );
  const [best] = sessions;
  if (best === undefined) return null;
  return { accessToken: best.key };
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
