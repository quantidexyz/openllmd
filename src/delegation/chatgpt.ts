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
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@openllm/schema";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir, cliEnv } from "../cli-paths";
import { logError, logInfo } from "../logger";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
  setPendingAuth,
} from "../pending-auth";
import {
  defaultUpstreamUrl,
  ensureExecFixture,
  resolveUpstream,
} from "./exec-fixture";
import { ensureOAuthConfig } from "./oauth-config";
import type { TProviderDelegate } from "./types";
import {
  cliVersion,
  openUrl,
  readJsonFile,
  runCapture,
  stripAnsi,
} from "./util";

const PROVIDER = "chatgpt" as const;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

// Refresh the access token proactively when its JWT `exp` is within this window
// — matches codex's own `CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES` (5 min),
// hiding clock skew and avoiding a guaranteed 401 → refresh → retry. The
// `client_id` + token endpoint are read from the codex binary, not hardcoded
// (they drift on CLI updates); see `oauth-config.ts`.
const REFRESH_LEEWAY_MS = 5 * 60_000;
// Hard cap on the token-refresh request so a hung endpoint can't stall the
// readToken critical path (inference + usage await it).
const REFRESH_FETCH_TIMEOUT_MS = 10_000;

const bin = (): string => cliBin(PROVIDER);
const env = (): Record<string, string> => cliEnv(PROVIDER);

// Keep spawned device-auth processes referenced so they aren't GC'd while
// they poll in the background (they exit on success / expiry).
const deviceProcs = new Set<ReturnType<typeof Bun.spawn>>();

// One in-flight codex login at a time (shared by the browser `connect` and the
// device-code `connectDeviceCode` paths) — each spawns a `codex login` process
// that binds a localhost callback / polls in the background, so a second
// concurrent spawn would race for the port + the credential write. Cleared when
// the spawned process exits (success / expiry / cancel).
let loginInFlight = false;

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
    // hardcoded literal. Falls back to current built-in defaults on failure.
    const { token_url, client_id } = await ensureOAuthConfig(PROVIDER);
    const resp = await fetch(token_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
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
    if (!resp.ok) return null;
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
      // OpenAI rotates the refresh token; keep the old one if absent.
      refresh:
        typeof d.refresh_token === "string" ? d.refresh_token : refreshToken,
      idToken: typeof d.id_token === "string" ? d.id_token : null,
    };
  } catch {
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
  await Bun.write(authPath(), JSON.stringify(raw));
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

export const chatgptDelegate: TProviderDelegate = {
  slug: PROVIDER,

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

  // Device-code login for a REMOTE/headless box: the daemon runs `codex login
  // --device-auth`, captures the verification URL + one-time code, and
  // surfaces them (pending-auth → status) so the user authorizes in THEIR
  // browser. The spawned process keeps polling and writes auth.json on
  // success; the status watcher flips the card. ⚠️ RESEARCH: device-auth
  // stdout shape unverified against a live login.
  connectDeviceCode: async () => {
    if (!(await cliInstallState(PROVIDER)).installed) {
      return {
        connected: false,
        detail: "Install the Codex CLI from the Providers tab first.",
      };
    }
    if ((await readToken()) !== null) {
      clearPendingAuth(PROVIDER);
      return { connected: true, detail: "signed in via Codex" };
    }
    if (loginInFlight) {
      const pending = getPendingAuth(PROVIDER);
      return {
        connected: false,
        pending: true,
        detail:
          pending !== null
            ? pendingAuthDetail(pending)
            : "Codex sign-in already in progress — finish authorizing in your browser; this updates automatically.",
      };
    }
    const proc = Bun.spawn([bin(), "login", "--device-auth"], {
      stdin: "ignore",
      stdout: "pipe",
      // The process stays alive polling for the whole login; only stdout is
      // read (for the device prompt). Leaving stderr piped + undrained could
      // fill its pipe and stall the child, so discard it.
      stderr: "ignore",
      env: { ...process.env, ...env() },
    });
    // Set only AFTER the spawn succeeds — if Bun.spawn throws, the proc.exited
    // cleanup below never registers, so an early set would wedge the flag true.
    loginInFlight = true;
    deviceProcs.add(proc);
    void proc.exited.then(async () => {
      deviceProcs.delete(proc);
      loginInFlight = false;
      if ((await readToken()) !== null) {
        // Device-code lands the credential on THIS box (the user authorized on
        // another machine, but auth.json is written here) — refresh the genuine
        // request fixture + OAuth refresh config now, exactly like the browser
        // `connect` path does. Best-effort + non-blocking.
        void ensureExecFixture(PROVIDER, { force: true }).catch(() => {});
        void ensureOAuthConfig(PROVIDER, { force: true }).catch(() => {});
      } else {
        // The process stays alive polling until the user authorizes; once it
        // exits WITHOUT a stored credential the flow expired / was cancelled /
        // errored — drop the stale code so the card stops showing a dead one.
        clearPendingAuth(PROVIDER);
      }
    });

    // One reader loop: resolves the moment the device prompt appears, then
    // keeps draining stdout for the process's lifetime so a full pipe can't
    // block codex's background polling.
    const found = await new Promise<{ url: string; code: string } | null>(
      (resolve) => {
        let settled = false;
        const settle = (v: { url: string; code: string } | null): void => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        const timer = setTimeout(() => settle(null), 30_000);
        void (async () => {
          const decoder = new TextDecoder();
          let buf = "";
          try {
            const reader = proc.stdout.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const p = parseDevicePrompt(buf);
              if (p !== null) settle(p);
            }
          } catch {
            /* ignore — settle(null) in finally */
          } finally {
            clearTimeout(timer);
            settle(null);
          }
        })();
      },
    );

    if (found === null) {
      proc.kill();
      return {
        connected: false,
        detail:
          "Couldn't start Codex device sign-in. Retry, or run `codex login --device-auth` on the box.",
      };
    }
    setPendingAuth(PROVIDER, found);
    // Open the verification URL locally too (kimi's device flow does the same).
    // On this machine it brings up the browser; on a remote box it opens
    // nothing useful but the URL is still surfaced via pending-auth for the
    // user to open on their own machine. This makes codex open a browser on
    // BOTH routes, so a mis-detected `thisMachine` can't leave it browser-less.
    openUrl(found.url);
    return {
      connected: false,
      pending: true,
      detail: pendingAuthDetail(found),
    };
  },

  connect: async () => {
    if (!(await cliInstallState(PROVIDER)).installed) {
      return {
        connected: false,
        detail: "Install the Codex CLI from the Providers tab first.",
      };
    }
    if ((await readToken()) !== null) {
      clearPendingAuth(PROVIDER);
      return { connected: true, detail: "signed in via Codex" };
    }
    if (loginInFlight) {
      const pending = getPendingAuth(PROVIDER);
      return {
        connected: false,
        pending: true,
        detail:
          pending !== null
            ? pendingAuthDetail(pending)
            : "Codex sign-in already in progress — finish authorizing in your browser; this updates automatically.",
      };
    }
    // `codex login` starts a localhost OAuth callback server and prints the
    // authorize URL to STDERR. Its OWN webbrowser-open does NOT reach the
    // user's browser when the daemon spawns it (unlike claude/kimi) — so the
    // daemon parses the URL, opens it itself, and surfaces it to the dashboard
    // (pending-auth), exactly like the kimi device-code flow. The process keeps
    // running the callback server until the browser flow completes + writes
    // auth.json; the status watcher then flips the card to connected.
    logInfo("chatgpt-connect", "spawning `codex login` (browser flow)");
    const proc = Bun.spawn([bin(), "login"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, ...env() },
    });
    // Set only AFTER the spawn succeeds — if Bun.spawn throws, the proc.exited
    // cleanup below never registers, so an early set would wedge the flag true.
    loginInFlight = true;
    deviceProcs.add(proc);
    void proc.exited.then(async () => {
      deviceProcs.delete(proc);
      loginInFlight = false;
      if ((await readToken()) !== null) {
        // Re-capture the exec fixture + re-extract the OAuth config now that the
        // identity is established (a CLI update can rotate the token endpoint or
        // client id). Best-effort + non-blocking.
        void ensureExecFixture(PROVIDER, { force: true }).catch(() => {});
        void ensureOAuthConfig(PROVIDER, { force: true }).catch(() => {});
      } else {
        // Exited without a credential (expired / cancelled / errored) — drop
        // the stale pending URL so the card stops showing a dead link.
        clearPendingAuth(PROVIDER);
      }
    });

    // Drain stderr: resolve the moment the authorize URL appears, then keep
    // reading for the process's lifetime so a full pipe can't stall codex.
    let lastBuf = "";
    const url = await new Promise<string | null>((resolve) => {
      let settled = false;
      const settle = (v: string | null): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const timer = setTimeout(() => settle(null), 30_000);
      void (async () => {
        const decoder = new TextDecoder();
        let buf = "";
        try {
          const reader = proc.stderr.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            lastBuf = buf;
            const u = parseAuthUrl(buf);
            if (u !== null) settle(u);
          }
        } catch {
          /* ignore — settle(null) in finally */
        } finally {
          clearTimeout(timer);
          settle(null);
        }
      })();
    });

    if (url === null) {
      proc.kill();
      logError("chatgpt-connect", "no authorize URL parsed from codex login", {
        stderrLen: lastBuf.length,
        // Redact URL query strings so any OAuth params can't land in the local
        // log, while keeping the sample useful for diagnosing a parse miss.
        stderrSample: redactUrls(lastBuf.slice(0, 400)),
      });
      return {
        connected: false,
        detail:
          "Couldn't start Codex sign-in. Retry, or run `codex login` on the box.",
      };
    }
    // Open it from the daemon (codex's own open doesn't reach the session) AND
    // surface it so a remote box / failed open still lets the user click it.
    logInfo("chatgpt-connect", "parsed authorize URL; opening browser", {
      urlLen: url.length,
    });
    openUrl(url);
    setPendingAuth(PROVIDER, { url, code: "" });
    return {
      connected: false,
      pending: true,
      detail: `Authorize Codex in the browser window that just opened — or open ${url}. This page updates automatically once you're done.`,
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

  ensureFixture: (opts) => ensureExecFixture(PROVIDER, opts),

  credentialForUpstream: async () => {
    const token = await readToken();
    if (token === null) {
      throw new Error("chatgpt: not signed in (no stored credential)");
    }
    // Prefer the captured exec fixture (the genuine `codex` request); fall back
    // to the delegate defaults when no fixture exists.
    const { url, headers } = await resolveUpstream(PROVIDER, {
      url: defaultUpstreamUrl(PROVIDER),
      headers: {
        originator: "codex_cli_rs",
        "user-agent": await userAgent(),
      },
    });
    // The account id is per-credential — inject the live store's value on top so
    // a fixture captured under a different/absent account can't pin a stale one.
    const withAccount =
      token.accountId !== null
        ? { ...headers, "chatgpt-account-id": token.accountId }
        : headers;
    return { access_token: token.accessToken, headers: withAccount, url };
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
