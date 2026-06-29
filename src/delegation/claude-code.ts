/**
 * Anthropic Claude Code (Pro/Max) delegate.
 *
 * Native delegation: use the installed `claude` CLI's OWN OAuth
 * credential + identity. Replaces the server-side forging that lived in
 * `provider-usage.ts`. Lowest-risk of the three (proposal §5).
 *
 * ISOLATED install: the daemon runs its OWN `claude` under
 * `~/.openllm/cli/claude_code/` with an isolated HOME + `CLAUDE_CONFIG_DIR`
 * (see cli-paths.ts), so it never touches the user's `~/.claude`.
 *
 * Credential storage is PLATFORM-SPLIT (confirmed via the Claude Code
 * docs — there is no file-based override on macOS):
 *   - macOS → the login Keychain (service "Claude Code-credentials").
 *     Claude resolves the login keychain by HOME path, so we give the
 *     isolated HOME its own keychain (`ensureIsolatedKeychain`) before
 *     login and read the blob back from it (`readIsolatedKeychain`).
 *   - Linux/Windows → the FILE `<CLAUDE_CONFIG_DIR>/.credentials.json`.
 * Either way the payload wrapper key is `claudeAiOauth`
 * { accessToken (sk-ant-oat01-…), refreshToken, expiresAt, scopes }.
 *
 *   - Login: `claude auth login --claudeai`; `claude auth status` (JSON)
 *     is the authoritative connection check.
 *   - Upstream identity: `Authorization: Bearer sk-ant-oat01-…`,
 *     `anthropic-beta: oauth-2025-04-20`, `anthropic-version:
 *     2023-06-01`, `User-Agent: claude-cli/<version>`.
 *   - Usage: GET https://api.anthropic.com/api/oauth/usage.
 */
import { rename, rm } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@quantidexyz/openllmp";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir, cliEnv, cliHome } from "../cli-paths";
import { logDebug, logWarn } from "../logger";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import {
  ensureAuthConfig,
  oauthConfig,
  resolveUpstreamUrl,
} from "./auth-config";
import { makePasteBackDevice } from "./login-device";
import { makeBlockingConnect } from "./login-direct";
import { loginSlot } from "./login-flow";
import type { TProviderDelegate } from "./types";
import {
  cliVersion,
  ensureIsolatedKeychain,
  grantKeychainToolAccess,
  readIsolatedKeychain,
  readJsonFile,
  runCapture,
  toEpochMs,
  writeIsolatedKeychain,
} from "./util";

const PROVIDER = "claude_code" as const;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_BETA = "oauth-2025-04-20";
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// The OAuth token endpoint + public client id used to refresh the access
// token with the stored refresh token. This is the SAME flow the CLI runs —
// done here on its behalf, locally, when the daemon needs a token and the CLI
// hasn't refreshed (the CLI only refreshes mid-inference, which the daemon
// never triggers; there is no `claude auth refresh` command). The rotated
// token is written back to the CLI's store so the two stay in sync.
//
// Both values are Anthropic's and DRIFT on CLI updates (the token host moved
// console.anthropic.com → platform.claude.com), so they are NOT hardcoded
// here — `oauthConfig()` reads them from the installed CLI binary or a valid
// cache entry; when neither exists, refresh is SKIPPED (no hardcoded fallback).
// See `auth-config.ts`.
//
// Refresh proactively when within this window of expiry (hides clock skew
// + avoids a guaranteed 401 → refresh → retry on the next call).
const REFRESH_LEEWAY_MS = 60_000;
// Hard cap on the token-refresh request so a hung endpoint can't stall the
// readToken critical path (inference + usage await it).
const REFRESH_FETCH_TIMEOUT_MS = 10_000;

// Run the isolated `claude` binary with its isolated home/config env.
const bin = (): string => cliBin(PROVIDER);
const env = (): Record<string, string> => cliEnv(PROVIDER);

type TClaudeOAuth = {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number | string;
  readonly scopes?: ReadonlyArray<string>;
};
type TClaudeStore = { readonly claudeAiOauth?: TClaudeOAuth };

const loadStore = async (): Promise<TClaudeStore | null> => {
  if (platform() === "darwin") {
    // macOS stores the blob in the isolated login keychain (not a file).
    const raw = await readIsolatedKeychain(
      cliHome(PROVIDER),
      KEYCHAIN_SERVICE,
      (p) => p.includes("claudeAiOauth"),
    );
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as TClaudeStore;
    } catch {
      return null;
    }
  }
  return readJsonFile<TClaudeStore>(
    join(cliConfigDir(PROVIDER), ".credentials.json"),
  );
};

// Persist a refreshed blob back to the CLI's store so the isolated CLI
// reads the same (rotated) token next time. macOS → keychain (in-place
// update, no ACL change/prompt); Linux/Windows → the credentials file.
const writeStore = async (store: TClaudeStore): Promise<void> => {
  const payload = JSON.stringify(store);
  if (platform() === "darwin") {
    await writeIsolatedKeychain(cliHome(PROVIDER), KEYCHAIN_SERVICE, payload);
    return;
  }
  // Atomic write (temp + rename) — the isolated `claude` CLI writes the SAME
  // file via its OWN atomic temp+rename, so a plain overwrite here could be lost
  // to / interleave with the CLI's write. rename(2) on the same dir is atomic,
  // so a concurrent reader always sees either the old or the new file whole.
  const path = join(cliConfigDir(PROVIDER), ".credentials.json");
  const tmp = `${path}.openllmd.tmp`;
  await Bun.write(tmp, payload);
  await rename(tmp, path);
};

// Exchange the stored refresh token for a fresh access token (+ possibly
// rotated refresh token). Returns null on any failure — caller falls back
// to the existing (stale) token, surfacing the upstream's own 401.
const refreshOAuth = async (
  refreshToken: string,
): Promise<{
  access: string;
  refresh: string;
  expiresAtMs: number | null;
} | null> => {
  try {
    // Read the (drift-prone) endpoint + client id from the CLI binary, not a
    // hardcoded literal. NULL when extraction failed AND nothing valid is
    // cached — skip the refresh (no hardcoded fallback to fall back to); the
    // stale access token then surfaces the vendor's own 401 → re-login.
    const cfg = await oauthConfig(PROVIDER);
    if (cfg === null) {
      // `oauthConfig`/`extractOAuthFromBinary` already WARNed the root cause
      // (extraction drift). Just note that this refresh is being skipped.
      logDebug(
        "claude-code",
        "token refresh skipped — no OAuth config available",
      );
      return null;
    }
    const { token_url, client_id } = cfg;
    const resp = await fetch(token_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // CLI meta, used ONLY here (the token endpoint is the one call the
        // daemon legitimately makes AS the CLI). Derived live from the
        // installed binary's version.
        "user-agent": await userAgent(),
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id,
      }),
      // Bound the refresh so a hung token endpoint can't stall readToken (and
      // thus every inference/usage call that awaits it) — abort → caught → null.
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // A 400/401 here means the stored REFRESH token was rejected (expired or
      // already rotated away) — every later refresh fails too, so the access
      // token stays stale and usage/inference 401/429. Surface it loudly: this
      // is a re-login situation, not a transient blip.
      const reLogin = resp.status === 400 || resp.status === 401;
      logWarn("claude-code", "OAuth token refresh rejected by token endpoint", {
        status: resp.status,
        hint: reLogin
          ? "stored refresh token is invalid — re-sign in via `openllmd connect claude_code` / `claude` login"
          : "transient token-endpoint error — will retry on the next stale read",
      });
      return null;
    }
    const d = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (typeof d.access_token !== "string" || d.access_token.length === 0) {
      return null;
    }
    return {
      access: d.access_token,
      // Anthropic rotates refresh tokens; keep the old one if absent OR empty.
      // An empty `refresh_token` would otherwise OVERWRITE a working one with
      // "", permanently stranding the credential (readToken won't refresh a ""),
      // so treat "" exactly like absent.
      refresh:
        typeof d.refresh_token === "string" && d.refresh_token.length > 0
          ? d.refresh_token
          : refreshToken,
      expiresAtMs:
        typeof d.expires_in === "number"
          ? Date.now() + d.expires_in * 1000
          : null,
    };
  } catch (err) {
    // Network error or the REFRESH_FETCH_TIMEOUT abort — transient; the stale
    // access token surfaces the vendor's own 401 and we retry next stale read.
    logDebug("claude-code", "OAuth token refresh failed (network/timeout)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};

// Single-flight guard: concurrent callers that all see an expired token
// share ONE refresh (refresh-token rotation means parallel refreshes
// would invalidate each other).
let inFlightRefresh: Promise<void> | null = null;

/**
 * The current access token, refreshed + persisted if it's within the
 * leeway of expiry. Used by `credentialForUpstream` (inference) and
 * `usage` so both always carry a live token.
 */
const readToken = async (): Promise<{
  accessToken: string;
  expiresAtMs: number | null;
} | null> => {
  const store = await loadStore();
  const oauth = store?.claudeAiOauth;
  if (oauth?.accessToken === undefined || oauth.accessToken.length === 0) {
    return null;
  }
  const expiresAtMs = toEpochMs(oauth.expiresAt);
  const stale =
    expiresAtMs !== null && expiresAtMs - Date.now() < REFRESH_LEEWAY_MS;
  // An empty refreshToken is as un-refreshable as a missing one — don't waste
  // a doomed refresh round-trip on "".
  if (!stale || !oauth.refreshToken) {
    return { accessToken: oauth.accessToken, expiresAtMs };
  }

  if (inFlightRefresh === null) {
    const rt = oauth.refreshToken;
    inFlightRefresh = (async () => {
      const refreshed = await refreshOAuth(rt);
      if (refreshed === null) return;
      await writeStore({
        claudeAiOauth: {
          ...oauth,
          accessToken: refreshed.access,
          refreshToken: refreshed.refresh,
          expiresAt: refreshed.expiresAtMs ?? oauth.expiresAt,
        },
      });
    })().finally(() => {
      inFlightRefresh = null;
    });
  }
  await inFlightRefresh;

  // Re-read the (now-rotated) store. Falls back to the stale token if the
  // refresh failed — the upstream then 401s and the UI says re-sign-in.
  const fresh = (await loadStore())?.claudeAiOauth;
  if (fresh?.accessToken !== undefined && fresh.accessToken.length > 0) {
    return {
      accessToken: fresh.accessToken,
      expiresAtMs: toEpochMs(fresh.expiresAt),
    };
  }
  return { accessToken: oauth.accessToken, expiresAtMs };
};

const userAgent = async (): Promise<string> => {
  const v = await cliVersion(bin(), env());
  // `claude --version` prints e.g. "2.0.55 (Claude Code)"; take the
  // leading semver. Falls back to a generic CLI UA when unavailable.
  const semver = v?.match(/\d+\.\d+\.\d+/)?.[0];
  return semver !== undefined ? `claude-cli/${semver}` : "claude-cli/2.0.0";
};

/**
 * Authoritative connection check via `claude auth status` (JSON):
 *   { loggedIn: bool, authMethod: "claudeai" | "api_key" | …, … }
 * We require loggedIn AND a subscription auth method (not `api_key` —
 * the daemon serves the subscription path, not a console key). Returns
 * null when the CLI is absent or the JSON is unparseable, so the caller
 * falls back to the credential-store read.
 */
const authStatusLoggedIn = async (): Promise<boolean | null> => {
  const out = await runCapture([bin(), "auth", "status"], env());
  if (out === null) return null;
  try {
    const parsed = JSON.parse(out) as {
      loggedIn?: boolean;
      authMethod?: string;
    };
    if (parsed.loggedIn !== true) return false;
    return parsed.authMethod !== "api_key";
  } catch {
    return null;
  }
};

/**
 * Whether the stored credential can AUTO-REFRESH — i.e. it carries a non-empty
 * refresh token. The hosted paste-back login grant has been observed to land an
 * EMPTY refresh token; the daemon then (correctly) refuses to refresh it, so the
 * ~8h access token silently dies and the user must re-login. Surfacing this at
 * login turns an invisible, delayed failure into an explicit one. Returns null
 * when there is no credential at all.
 */
const credentialRefreshable = async (): Promise<boolean | null> => {
  const oauth = (await loadStore())?.claudeAiOauth;
  if (oauth?.accessToken === undefined || oauth.accessToken.length === 0) {
    return null;
  }
  return (
    typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0
  );
};

// Logged + returned when a login lands a credential that can't self-refresh.
const NO_REFRESH_HINT =
  "signed in via Claude Code — warning: this credential has no refresh token and can't auto-refresh; you may need to re-sign in when it expires";

// ─── Login wiring ────────────────────────────────────────────────────────
//
// `connect` is a SYNCHRONOUS browser login (it blocks in `claude auth login`),
// so it carries no single-flight slot. `connectDeviceCode` is the headless
// paste-back (remote box) and shares the `slot` with `submitLoginCode` +
// `cancelConnect`. All paths flag a credential that can't auto-refresh (no
// refresh token) at sign-in, so the card doesn't silently die ~8h later.

const slot = loginSlot(PROVIDER);
const INSTALL_HINT =
  "Install the Claude Code CLI from the Providers tab first.";
const CONNECTED_DETAIL = "signed in via Claude Code";
const LOGIN_ARGV = (): ReadonlyArray<string> => [
  bin(),
  "auth",
  "login",
  "--claudeai",
];

const isInstalled = async (): Promise<boolean> =>
  (await cliInstallState(PROVIDER)).installed;
// Authoritative connection check: prefer `claude auth status`, fall back to the
// store read when it's unavailable (the store read is fragile on macOS).
const isConnected = async (): Promise<boolean> => {
  const viaAuth = await authStatusLoggedIn();
  return viaAuth !== null ? viaAuth : (await readToken()) !== null;
};
// Refresh the auth config now the identity / CLI may have changed (a CLI update
// can rotate the upstream URL / token endpoint / client id). Best-effort.
const refreshConfig = (): void => {
  void ensureAuthConfig(PROVIDER, { force: true }).catch(() => {});
};
// The success `detail`: a credential with no refresh token works now but can't
// be renewed — log `warning` + return the persistent NO_REFRESH_HINT so the
// dashboard shows a "re-sign in" hint instead of a card that dies at expiry.
const signedInDetail = async (warning: string): Promise<string> => {
  if ((await credentialRefreshable()) === false) {
    logWarn("claude-code", warning);
    return NO_REFRESH_HINT;
  }
  return CONNECTED_DETAIL;
};

// Native browser login: `claude auth login --claudeai` opens the browser and
// BLOCKS until its own localhost callback completes; the token then lands in
// the isolated CLI's store. (macOS keychain ensured before / granted after.)
const connectDirect = makeBlockingConnect({
  provider: PROVIDER,
  installed: isInstalled,
  installHint: INSTALL_HINT,
  beforeLogin: () => ensureIsolatedKeychain(cliHome(PROVIDER)),
  argv: LOGIN_ARGV,
  env,
  afterLogin: () => grantKeychainToolAccess(cliHome(PROVIDER)),
  verifyConnected: isConnected,
  onConnected: refreshConfig,
  successDetail: () =>
    signedInDetail(
      "signed in (browser) but the stored credential has NO refresh token — it cannot auto-refresh; re-login will be needed at access-token expiry",
    ),
  failDetail: (result) =>
    result.output.length > 0
      ? result.output.slice(0, 300)
      : `claude auth login exited ${result.code} without a stored credential`,
});

// Headless paste-back login (remote box): spawn `claude auth login --claudeai`
// with the browser suppressed, surface the hosted-callback URL (paste mode),
// and hold the process open on stdin until the user pastes the code.
const device = makePasteBackDevice({
  provider: PROVIDER,
  slot,
  installed: isInstalled,
  installHint: INSTALL_HINT,
  connected: async () => (await readToken()) !== null,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail:
    "Claude sign-in already in progress — finish in your browser, then paste the code.",
  beforeLogin: () => ensureIsolatedKeychain(cliHome(PROVIDER)),
  argv: LOGIN_ARGV,
  env,
  onConnected: async () => {
    if ((await credentialRefreshable()) === false) {
      logWarn(
        "claude-code",
        "headless login landed a credential with NO refresh token — it cannot auto-refresh (re-login will be needed at access-token expiry)",
      );
    }
    refreshConfig();
  },
  onCodeAccepted: () => grantKeychainToolAccess(cliHome(PROVIDER)),
  verifyAfterSubmit: async () =>
    (await authStatusLoggedIn()) === true || (await readToken()) !== null,
  submitSuccessDetail: () =>
    signedInDetail(
      "signed in but the stored credential has NO refresh token — it cannot auto-refresh; the access token will expire (~8h) and require re-login",
    ),
});

export const claudeCodeDelegate: TProviderDelegate = {
  slug: "claude_code",

  connect: connectDirect,
  connectDeviceCode: device.connectDeviceCode,
  submitLoginCode: device.submitLoginCode,
  cancelConnect: device.cancelConnect,

  status: async () => {
    const { installed, version } = await cliInstallState(PROVIDER);
    if (!installed) {
      return {
        provider: PROVIDER,
        connected: false,
        cli_installed: false,
        detail: "claude CLI not installed",
      };
    }
    // macOS: make sure the isolated login keychain is unlocked so
    // `claude auth status` can read the credential it stored there (else
    // it would falsely report signed-out). Process-cached, so this is
    // free after the first call. No-op elsewhere.
    await ensureIsolatedKeychain(cliHome(PROVIDER));
    // Prefer the CLI's own `auth status`; fall back to the store read
    // when it's unavailable / unparseable.
    const viaAuth = await authStatusLoggedIn();
    const connected = viaAuth !== null ? viaAuth : (await readToken()) !== null;
    // A live headless paste-back login (remote box) awaiting the user's code:
    // surface the authorize URL + paste mode so the dashboard renders the
    // paste panel; drop it the moment the credential lands.
    if (connected) clearPendingAuth(PROVIDER);
    const pending = connected ? null : getPendingAuth(PROVIDER);
    // When connected, flag a credential that can't auto-refresh (no refresh
    // token) so the dashboard shows a persistent "re-sign in" hint instead of a
    // green card that silently dies at access-token expiry.
    const unrefreshable =
      connected && (await credentialRefreshable()) === false;
    return {
      provider: PROVIDER,
      connected,
      cli_installed: true,
      ...(version !== null ? { cli_version: version } : {}),
      ...(connected
        ? {
            last_login_at_ms: null,
            ...(unrefreshable
              ? {
                  detail:
                    "signed in, but this credential can't auto-refresh — re-sign in to restore automatic renewal",
                }
              : {}),
          }
        : pending !== null
          ? {
              pending_auth: {
                url: pending.url,
                code: pending.code,
                ...(pending.mode !== undefined ? { mode: pending.mode } : {}),
              },
              detail: pendingAuthDetail(pending),
            }
          : { detail: "claude CLI installed but not signed in" }),
    };
  },

  usage: async (): Promise<TProviderUsageSnapshot> => {
    const token = await readToken();
    if (token === null) {
      return { kind: "unavailable", reason: "not signed in to Claude Code" };
    }
    try {
      const resp = await fetch(OAUTH_USAGE_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "user-agent": await userAgent(),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        },
      });
      if (!resp.ok) {
        const reason =
          resp.status === 401
            ? "Claude authorization was rejected — re-sign in via the Claude Code CLI."
            : resp.status === 403
              ? "No active Claude Pro/Max subscription on this account."
              : resp.status === 429
                ? // The usage cache serves the last known good figures (stamped
                  // `stale`) when one exists, so this bare reason only ever
                  // surfaces when there's NOTHING cached to fall back to — don't
                  // promise figures we may not have. See `usage-cache.ts`.
                  "Claude usage is rate-limited right now."
                : `Claude couldn't report usage (HTTP ${resp.status}).`;
        return { kind: "unavailable", reason };
      }
      const data = (await resp.json()) as Record<
        string,
        { utilization?: number; resets_at?: string | null } | null
      >;
      const win = (
        label: string,
        raw: { utilization?: number; resets_at?: string | null } | null,
      ) => ({
        label,
        percent_used:
          typeof raw?.utilization === "number" ? raw.utilization : 0,
        reset_at_ms:
          typeof raw?.resets_at === "string" ? toEpochMs(raw.resets_at) : null,
      });
      // The two core windows are always shown. The model-scoped 7-day
      // windows (`seven_day_opus` / `seven_day_sonnet`) are shown ONLY
      // when the account actually has them — Anthropic returns `null` for
      // a scope with no usage in the period, and the payload also carries
      // several internal/experimental codename keys we deliberately skip.
      const windows = [
        win("5-hour", data.five_hour ?? null),
        win("7-day", data.seven_day ?? null),
      ];
      const scoped: ReadonlyArray<readonly [string, string]> = [
        ["seven_day_opus", "7-day · Opus"],
        ["seven_day_sonnet", "7-day · Sonnet"],
      ];
      for (const [key, label] of scoped) {
        const raw = data[key];
        if (raw != null && typeof raw.utilization === "number") {
          windows.push(win(label, raw));
        }
      }
      const maxPct = windows.reduce(
        (a, w) => (w.percent_used > a ? w.percent_used : a),
        0,
      );
      return {
        kind: "quota",
        status:
          maxPct >= 100
            ? "rejected"
            : maxPct >= 80
              ? "allowed_warning"
              : "allowed",
        windows,
        note: "Pro/Max subscription — read locally via Claude Code",
      };
    } catch (err) {
      return {
        kind: "unavailable",
        reason: err instanceof Error ? err.message : "usage fetch failed",
      };
    }
  },

  credentialForUpstream: async () => {
    const token = await readToken();
    if (token === null) {
      throw new Error("claude_code: not signed in (no stored credential)");
    }
    // Resolve only the request TARGET URL (captured from the genuine `claude`
    // request, or the default). NO identity headers are injected here — the
    // walker carries the originator's own headers, and the wire builder layers
    // the OAuth `anthropic-beta` + `anthropic-version` on top (isOAuth). Claude
    // has no per-credential header to add, so `headers` is empty.
    const url = await resolveUpstreamUrl(PROVIDER, { captureIfMissing: true });
    return { access_token: token.accessToken, headers: {}, url };
  },

  logout: async () => {
    // `claude auth logout` clears the isolated login credential (keychain item
    // on macOS, .credentials.json on Linux).
    if ((await cliInstallState(PROVIDER)).installed) {
      await ensureIsolatedKeychain(cliHome(PROVIDER)); // macOS: reach the store
      await runCapture([bin(), "auth", "logout"], env());
    }
    // Belt-and-braces on Linux: drop the credentials file if it lingers.
    if (platform() !== "darwin") {
      await rm(join(cliConfigDir(PROVIDER), ".credentials.json"), {
        force: true,
      }).catch(() => {});
    }
    const cleared =
      (await loadStore())?.claudeAiOauth?.accessToken === undefined;
    return cleared
      ? { ok: true, detail: "signed out of Claude Code" }
      : { ok: false, detail: "credential still present after logout" };
  },
};
