/**
 * ChatGPT (Codex) delegate.
 *
 * Native delegation: use the installed Codex CLI's OWN bearer + identity.
 * Replaces the server-side synthesis in `chatgpt/common.ts`. Residual T3:
 * Codex rides the private `backend-api/codex` API (proposal §5).
 *
 * ISOLATED install: the daemon runs its OWN `codex` under
 * `~/.openllm/cli/chatgpt/` with `CODEX_HOME` pointed inside it (see
 * cli-paths.ts), so it never touches the user's `~/.codex`.
 *   - Store: `<CODEX_HOME>/auth.json`, shape { tokens: { id_token (JWT),
 *     access_token, refresh_token, account_id? }, auth_mode? }.
 *   - Login: `codex login` (browser) — writes auth.json with
 *     auth_mode:"chatgpt".
 *   - Upstream identity: originator `codex_cli_rs`, User-Agent
 *     `codex_cli_rs/<ver> (<os>; <arch>) <terminal>`, plus
 *     `ChatGPT-Account-Id: <account_id>`.
 *   - Usage: GET https://chatgpt.com/backend-api/wham/usage.
 */
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@quantidexyz/openllmp";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir, cliEnv } from "../cli-paths";
import { logDebug, logError, logInfo, logWarn } from "../logger";
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
import { makeStreamDeviceConnect } from "./login-device";
import { makeStreamConnect } from "./login-direct";
import { loginSlot } from "./login-flow";
import type { TProviderDelegate } from "./types";
import { cliVersion, readJsonFile, runCapture, stripAnsi } from "./util";

const PROVIDER = "chatgpt" as const;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

// Refresh the access token proactively when its JWT `exp` is within this window
// — matches codex's own `CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES` (5 min),
// hiding clock skew and avoiding a guaranteed 401 → refresh → retry. The
// `client_id` + token endpoint are read from the codex binary, not hardcoded
// (they drift on CLI updates); see `auth-config.ts`.
const REFRESH_LEEWAY_MS = 5 * 60_000;
// Hard cap on the token-refresh request so a hung endpoint can't stall the
// readToken critical path (inference + usage await it).
const REFRESH_FETCH_TIMEOUT_MS = 10_000;

const bin = (): string => cliBin(PROVIDER);
const env = (): Record<string, string> => cliEnv(PROVIDER);

/**
 * Strip query strings from any URL in a diagnostic string, so OAuth authorize
 * params (client_id / code_challenge / state) are never persisted to the local
 * log. Keeps the scheme+host+path for debugging.
 */
const redactUrls = (s: string): string =>
  s.replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1?<redacted>");

/**
 * Parse the verification URL + one-time code from `codex login --device-auth`
 * stdout. ⚠️ RESEARCH: format inferred from ref/codex
 * `login/src/device_code_auth.rs` (an ANSI-wrapped prompt — a `…/codex/device`
 * URL line, then a "one-time code" line). Matched leniently; confirm live.
 */
const parseDevicePrompt = (
  raw: string,
): { url: string; code: string } | null => {
  const clean = stripAnsi(raw);
  const url =
    clean.match(/https?:\/\/\S+\/codex\/device\b/)?.[0] ??
    clean.match(/https?:\/\/\S+/)?.[0];
  const code = clean.match(
    /one-time code[^\n]*\n\s*([A-Z0-9][A-Z0-9-]{3,})/i,
  )?.[1];
  return url !== undefined && code !== undefined ? { url, code } : null;
};

/**
 * Parse the browser authorize URL `codex login` prints to STDERR ("…navigate to
 * this URL to authenticate: https://auth.openai.com/oauth/authorize?…").
 * Confirmed against codex 0.136.0. Matched leniently (any `/oauth/authorize`
 * URL) so an issuer tweak doesn't break it.
 */
const parseAuthUrl = (raw: string): string | null => {
  const clean = stripAnsi(raw);
  return (
    clean.match(/https?:\/\/auth\.openai\.com\/oauth\/authorize\S+/)?.[0] ??
    clean.match(/https?:\/\/\S*\/oauth\/authorize\S+/)?.[0] ??
    null
  );
};

type TCodexTokens = {
  readonly id_token?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly account_id?: string;
};
type TCodexStore = {
  readonly tokens?: TCodexTokens;
  readonly auth_mode?: string;
};

const authPath = (): string => join(cliConfigDir(PROVIDER), "auth.json");

const loadStore = (): Promise<TCodexStore | null> =>
  // Isolated CODEX_HOME → auth.json lives there.
  readJsonFile<TCodexStore>(authPath());

// The codex access token is a JWT; its expiry lives in the `exp` claim (codex
// itself refreshes off this — see ref/codex `should_refresh_proactively`).
// Returns null when the token isn't a parseable JWT (then we skip the proactive
// refresh and let a real 401 surface).
const parseJwtExpMs = (jwt: string): number | null => {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
};

// Exchange the stored refresh token for a fresh access token (+ rotated refresh
// / id tokens). Mirrors codex's own refresh request
// (`{ client_id, grant_type:"refresh_token", refresh_token }` → `{ id_token,
// access_token, refresh_token }`). Returns null on any failure — the caller
// falls back to the existing (stale) token, surfacing the upstream's own 401.
const refreshOAuth = async (
  refreshToken: string,
): Promise<{
  access: string;
  refresh: string;
  idToken: string | null;
} | null> => {
  try {
    // Read the (drift-prone) endpoint + client id from the codex binary, not a
    // hardcoded literal. NULL when extraction failed AND nothing valid is
    // cached — skip the refresh (no hardcoded fallback); the stale access token
    // then surfaces the vendor's own 401 → re-login.
    const cfg = await oauthConfig(PROVIDER);
    if (cfg === null) {
      // `oauthConfig`/`extractOAuthFromBinary` already WARNed the root cause
      // (extraction drift). Just note that this refresh is being skipped.
      logDebug("chatgpt", "token refresh skipped — no OAuth config available");
      return null;
    }
    const { token_url, client_id } = cfg;
    const resp = await fetch(token_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // CLI meta, used ONLY here (the token endpoint is the one call the
        // daemon legitimately makes AS the CLI). Derived live from the binary.
        "user-agent": await userAgent(),
        originator: "codex_cli_rs",
      },
      body: JSON.stringify({
        client_id,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      // Bound the refresh so a hung token endpoint can't stall readToken (and
      // thus every inference/usage call that awaits it) — abort → caught → null.
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // A 400/401 here means the stored REFRESH token was rejected (expired or
      // already rotated away) — every later refresh will fail too, so the access
      // token stays stale and usage/inference 401. Surface it loudly: this is a
      // re-login situation, not a transient blip (which the access-token 401
      // alone reads as).
      const reLogin = resp.status === 400 || resp.status === 401;
      logWarn("chatgpt", "OAuth token refresh rejected by token endpoint", {
        status: resp.status,
        hint: reLogin
          ? "stored refresh token is invalid — re-sign in via `openllmd connect chatgpt` / `codex login`"
          : "transient token-endpoint error — will retry on the next stale read",
      });
      return null;
    }
    const d = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };
    if (typeof d.access_token !== "string" || d.access_token.length === 0) {
      return null;
    }
    return {
      access: d.access_token,
      // OpenAI rotates the refresh token; keep the old one if absent OR empty.
      // An empty `refresh_token` would otherwise OVERWRITE a working one with
      // "", permanently stranding the credential (readToken won't refresh a "").
      refresh:
        typeof d.refresh_token === "string" && d.refresh_token.length > 0
          ? d.refresh_token
          : refreshToken,
      idToken: typeof d.id_token === "string" ? d.id_token : null,
    };
  } catch (err) {
    // Network error or the REFRESH_FETCH_TIMEOUT abort — transient; the stale
    // access token surfaces the vendor's own 401 and we retry next stale read.
    logDebug("chatgpt", "OAuth token refresh failed (network/timeout)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};

// Persist refreshed tokens back into auth.json so the isolated codex CLI reads
// the same (rotated) credential next time. Preserve every other field
// (`OPENAI_API_KEY`, unknown keys) and refresh `last_refresh`, exactly as codex
// does (`update_tokens`).
const persistRefresh = async (next: {
  access: string;
  refresh: string;
  idToken: string | null;
}): Promise<void> => {
  const raw = (await readJsonFile<Record<string, unknown>>(authPath())) ?? {};
  const prevTokens = (raw.tokens as TCodexTokens | undefined) ?? {};
  raw.tokens = {
    ...prevTokens,
    access_token: next.access,
    refresh_token: next.refresh,
    ...(next.idToken !== null ? { id_token: next.idToken } : {}),
  };
  raw.last_refresh = new Date().toISOString();
  // Atomic write (temp + rename) — the isolated `codex` CLI writes the SAME
  // auth.json via its own atomic write, so a plain overwrite could be lost to /
  // interleave with it (the two-writer rotation race). rename(2) on the same dir
  // is atomic, so a concurrent reader always sees a whole file.
  const path = authPath();
  const tmp = `${path}.openllmd.tmp`;
  await Bun.write(tmp, JSON.stringify(raw));
  await rename(tmp, path);
};

// Single-flight guard: concurrent callers that all see an expiring token share
// ONE refresh (refresh-token rotation means parallel refreshes invalidate each
// other).
let inFlightRefresh: Promise<void> | null = null;

const readToken = async (): Promise<{
  accessToken: string;
  accountId: string | null;
} | null> => {
  const store = await loadStore();
  const tokens = store?.tokens;
  if (tokens?.access_token === undefined || tokens.access_token.length === 0) {
    return null;
  }
  const expMs = parseJwtExpMs(tokens.access_token);
  const stale = expMs !== null && expMs - Date.now() < REFRESH_LEEWAY_MS;
  // An empty refresh_token is as un-refreshable as a missing one — don't waste
  // a doomed refresh round-trip on "".
  if (!stale || !tokens.refresh_token) {
    return {
      accessToken: tokens.access_token,
      accountId: tokens.account_id ?? null,
    };
  }

  if (inFlightRefresh === null) {
    const rt = tokens.refresh_token;
    inFlightRefresh = (async () => {
      const refreshed = await refreshOAuth(rt);
      if (refreshed === null) return;
      await persistRefresh(refreshed);
    })().finally(() => {
      inFlightRefresh = null;
    });
  }
  await inFlightRefresh;

  // Re-read the (now-rotated) store. Falls back to the stale token if the
  // refresh failed — the upstream then 401s and the UI says re-sign-in.
  const fresh = (await loadStore())?.tokens;
  if (fresh?.access_token !== undefined && fresh.access_token.length > 0) {
    return {
      accessToken: fresh.access_token,
      accountId: fresh.account_id ?? null,
    };
  }
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id ?? null,
  };
};

const userAgent = async (): Promise<string> => {
  const v = await cliVersion(bin(), env());
  const semver = v?.match(/\d+\.\d+\.\d+/)?.[0] ?? "0.0.0";
  return `codex_cli_rs/${semver} (${process.platform}; ${process.arch}) openllmd`;
};

// ─── Login wiring ────────────────────────────────────────────────────────
//
// codex's browser `connect` and device-code `connectDeviceCode` share ONE
// `loginSlot` so only one `codex login` runs at a time (each binds a localhost
// callback / polls), and `cancelConnect` kills whichever is live.

const INSTALL_HINT = "Install the Codex CLI from the Providers tab first.";
const CONNECTED_DETAIL = "signed in via Codex";
const IN_PROGRESS_DETAIL =
  "Codex sign-in already in progress — finish authorizing in your browser; this updates automatically.";

const isInstalled = async (): Promise<boolean> =>
  (await cliInstallState(PROVIDER)).installed;
const isConnected = async (): Promise<boolean> => (await readToken()) !== null;
// Device-code lands the credential on THIS box; refresh the auth config (a CLI
// update can rotate the upstream URL / token endpoint / client id), exactly as
// the browser flow does. Best-effort + non-blocking.
const refreshConfig = (): void => {
  void ensureAuthConfig(PROVIDER, { force: true }).catch(() => {});
};

const slot = loginSlot(PROVIDER);

// Browser flow: `codex login` prints the authorize URL to STDERR. Its OWN
// browser-open reaches the user, so we do NOT open a second tab — only surface
// the URL (so a remote/headless box can click it from the dashboard).
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
    logInfo("chatgpt-connect", "spawning `codex login` (browser flow)"),
  onParsed: (url) =>
    logInfo("chatgpt-connect", "parsed authorize URL; surfacing to dashboard", {
      urlLen: url.length,
    }),
  onParseFail: (captured) =>
    logError("chatgpt-connect", "no authorize URL parsed from codex login", {
      stderrLen: captured.length,
      // Redact URL query strings so OAuth params can't land in the local log,
      // while keeping the sample useful for diagnosing a parse miss.
      stderrSample: redactUrls(captured.slice(0, 400)),
    }),
  pendingDetail: (url) =>
    `Authorize Codex in the browser window that opened — or open ${url}. This page updates automatically once you're done.`,
  failDetail:
    "Couldn't start Codex sign-in. Retry, or run `codex login` on the box.",
});

// Device-code flow: `codex login --device-auth` prints the verification URL +
// one-time code to STDOUT; we surface them + open the URL locally.
const deviceLogin = makeStreamDeviceConnect({
  provider: PROVIDER,
  slot,
  installed: isInstalled,
  installHint: INSTALL_HINT,
  connected: isConnected,
  connectedDetail: CONNECTED_DETAIL,
  inProgressDetail: IN_PROGRESS_DETAIL,
  argv: () => [bin(), "login", "--device-auth"],
  env,
  parse: parseDevicePrompt,
  onConnected: refreshConfig,
  pendingDetail: (found) => pendingAuthDetail(found),
  failDetail:
    "Couldn't start Codex device sign-in. Retry, or run `codex login --device-auth` on the box.",
  cancelMessages: {
    cancelled: "Codex sign-in cancelled",
    none: "no sign-in was in progress",
  },
});

export const chatgptDelegate: TProviderDelegate = {
  slug: PROVIDER,

  connect: connectDirect,
  connectDeviceCode: deviceLogin.connectDeviceCode,
  cancelConnect: deviceLogin.cancelConnect,

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
                  ? "codex CLI installed but not signed in"
                  : "codex CLI not installed",
          }
        : { last_login_at_ms: null }),
    };
  },

  usage: async (): Promise<TProviderUsageSnapshot> => {
    const token = await readToken();
    if (token === null) {
      return { kind: "unavailable", reason: "not signed in to Codex" };
    }
    try {
      const resp = await fetch(USAGE_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          ...(token.accountId !== null
            ? { "chatgpt-account-id": token.accountId }
            : {}),
          "user-agent": await userAgent(),
          originator: "codex_cli_rs",
          accept: "application/json",
        },
      });
      if (!resp.ok) {
        const reason =
          resp.status === 401
            ? "ChatGPT authorization was rejected — re-sign in via the Codex CLI."
            : resp.status === 403
              ? "No active ChatGPT subscription on this account."
              : `ChatGPT couldn't report usage (HTTP ${resp.status}).`;
        return { kind: "unavailable", reason };
      }
      const data = (await resp.json()) as {
        plan_type?: string;
        rate_limit?: {
          primary_window?: { used_percent?: number; reset_at?: number } | null;
          secondary_window?: {
            used_percent?: number;
            reset_at?: number;
          } | null;
        };
      };
      const win = (
        label: string,
        raw: { used_percent?: number; reset_at?: number } | null | undefined,
      ) => ({
        label,
        percent_used:
          typeof raw?.used_percent === "number" ? raw.used_percent : 0,
        reset_at_ms:
          typeof raw?.reset_at === "number" ? raw.reset_at * 1000 : null,
      });
      const windows = [];
      if (data.rate_limit?.primary_window) {
        windows.push(win("Primary", data.rate_limit.primary_window));
      }
      if (data.rate_limit?.secondary_window) {
        windows.push(win("Secondary", data.rate_limit.secondary_window));
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
        ...(typeof data.plan_type === "string" ? { plan: data.plan_type } : {}),
        windows,
        note: "ChatGPT Codex — read locally via Codex CLI",
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
      throw new Error("chatgpt: not signed in (no stored credential)");
    }
    // Resolve only the request TARGET URL (captured from the genuine `codex`
    // request, or the default). The ONE credential-intrinsic header injected is
    // `chatgpt-account-id` — the user's OWN account, read from the store, which
    // routes the request to their subscription (not a synthesized CLI identity).
    // Everything else (user-agent, originator, …) rides through from the
    // originator's own request.
    const url = await resolveUpstreamUrl(PROVIDER);
    const headers: Record<string, string> =
      token.accountId !== null ? { "chatgpt-account-id": token.accountId } : {};
    return { access_token: token.accessToken, headers, url };
  },

  logout: async () => {
    // `codex logout` revokes the token server-side; then ensure the isolated
    // auth.json is gone regardless of CLI version.
    if ((await cliInstallState(PROVIDER)).installed) {
      await runCapture([bin(), "logout"], env());
    }
    await rm(join(cliConfigDir(PROVIDER), "auth.json"), {
      force: true,
    }).catch(() => {});
    const cleared = (await readToken()) === null;
    return cleared
      ? { ok: true, detail: "signed out of Codex" }
      : { ok: false, detail: "credential still present after logout" };
  },
};
