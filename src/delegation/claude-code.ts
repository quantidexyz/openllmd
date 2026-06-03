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
import { platform } from "node:os";
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@openllm/schema";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir, cliEnv, cliHome } from "../cli-paths";
import { hasSetupToken, loadSetupToken } from "../setup-token";
import type { TProviderDelegate } from "./types";
import {
  cliVersion,
  ensureIsolatedKeychain,
  grantKeychainToolAccess,
  readIsolatedKeychain,
  readJsonFile,
  runCapture,
  spawnLogin,
  toEpochMs,
  writeIsolatedKeychain,
} from "./util";

const PROVIDER = "claude_code" as const;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_BETA = "oauth-2025-04-20";
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// The official Claude Code OAuth token endpoint + public client id, used
// to refresh the access token with the stored refresh token. This is the
// SAME flow the CLI runs — done here on its behalf, locally, when the
// daemon needs a token and the CLI hasn't refreshed (the CLI only
// refreshes mid-inference, which the daemon never triggers; there is no
// `claude auth refresh` command). The rotated token is written back to
// the CLI's store so the two stay in sync.
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Refresh proactively when within this window of expiry (hides clock skew
// + avoids a guaranteed 401 → refresh → retry on the next call).
const REFRESH_LEEWAY_MS = 60_000;

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
  await Bun.write(join(cliConfigDir(PROVIDER), ".credentials.json"), payload);
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
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!resp.ok) return null;
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
      // Anthropic rotates refresh tokens; keep the old one if absent.
      refresh:
        typeof d.refresh_token === "string" ? d.refresh_token : refreshToken,
      expiresAtMs:
        typeof d.expires_in === "number"
          ? Date.now() + d.expires_in * 1000
          : null,
    };
  } catch {
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
  // On-box setup-token (sk-ant-oat01-) wins: a long-lived Pro/Max
  // subscription credential the user delivered to this box (env /
  // `set-token`). It carries no refresh token, so there's nothing to
  // self-refresh — used verbatim until it expires (the user re-sets it).
  // This path needs NO isolated `claude` CLI install or `auth login`.
  const setupToken = loadSetupToken(PROVIDER);
  if (setupToken !== null) {
    return { accessToken: setupToken, expiresAtMs: null };
  }
  const store = await loadStore();
  const oauth = store?.claudeAiOauth;
  if (oauth?.accessToken === undefined || oauth.accessToken.length === 0) {
    return null;
  }
  const expiresAtMs = toEpochMs(oauth.expiresAt);
  const stale =
    expiresAtMs !== null && expiresAtMs - Date.now() < REFRESH_LEEWAY_MS;
  if (!stale || oauth.refreshToken === undefined) {
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

export const claudeCodeDelegate: TProviderDelegate = {
  slug: "claude_code",

  status: async () => {
    const { installed, version } = await cliInstallState(PROVIDER);
    // Setup-token mode: connected via the on-box subscription token,
    // independent of any isolated CLI install / `auth login`.
    if (hasSetupToken(PROVIDER)) {
      return {
        provider: PROVIDER,
        connected: true,
        cli_installed: installed,
        ...(version !== null ? { cli_version: version } : {}),
        detail: "connected via setup token",
        last_login_at_ms: null,
      };
    }
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
    return {
      provider: PROVIDER,
      connected,
      cli_installed: true,
      ...(version !== null ? { cli_version: version } : {}),
      ...(connected
        ? { last_login_at_ms: null }
        : { detail: "claude CLI installed but not signed in" }),
    };
  },

  connect: async () => {
    // Already authenticated via an on-box setup token — there's no browser
    // login to run; the dashboard surfaces token instructions, not Connect.
    if (hasSetupToken(PROVIDER)) {
      return { connected: true, detail: "connected via setup token" };
    }
    if (!(await cliInstallState(PROVIDER)).installed) {
      return {
        connected: false,
        detail: "Install the Claude Code CLI from the Providers tab first.",
      };
    }
    // macOS: ensure the isolated HOME has its own (unlocked) login
    // keychain BEFORE login, or `claude auth login`'s credential WRITE
    // fails with the system "Keychain Not Found" dialog. No-op elsewhere.
    await ensureIsolatedKeychain(cliHome(PROVIDER));
    // Native subscription login. `claude auth login --claudeai` is the
    // real CLI subcommand (NOT the REPL `/login` slash command, which
    // errors with "isn't available in this environment" when spawned).
    // It opens the user's browser and BLOCKS until the user signs in and
    // the CLI's own localhost callback completes ("you can close this
    // page"); the token then lands in the isolated CLI's own store.
    const result = await spawnLogin(
      [bin(), "auth", "login", "--claudeai"],
      env(),
    );
    // macOS: grant CLI tools prompt-free access to the just-written
    // keychain item so our later credential reads don't pop a GUI prompt.
    await grantKeychainToolAccess(cliHome(PROVIDER));
    // Verify via the SAME authoritative check `status()` uses
    // (`claude auth status`), not a raw credential-store read — the store
    // read is fragile (macOS Keychain shape varies) and can report a
    // false negative even when the CLI is correctly signed in. Fall back
    // to the store read only if `auth status` is unavailable.
    const viaAuth = await authStatusLoggedIn();
    const connected = viaAuth !== null ? viaAuth : (await readToken()) !== null;
    if (connected) {
      return { connected: true, detail: "signed in via Claude Code" };
    }
    return {
      connected: false,
      detail:
        result.output.length > 0
          ? result.output.slice(0, 300)
          : `claude auth login exited ${result.code} without a stored credential`,
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
    return {
      access_token: token.accessToken,
      headers: {
        "anthropic-beta": OAUTH_BETA,
        "anthropic-version": "2023-06-01",
        "user-agent": await userAgent(),
      },
    };
  },
};
