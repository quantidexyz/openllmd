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
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@openllm/schema";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir, cliEnv } from "../cli-paths";
import type { TProviderDelegate } from "./types";
import { cliVersion, readJsonFile, spawnLogin } from "./util";

const PROVIDER = "chatgpt" as const;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const bin = (): string => cliBin(PROVIDER);
const env = (): Record<string, string> => cliEnv(PROVIDER);

type TCodexStore = {
  readonly tokens?: {
    readonly id_token?: string;
    readonly access_token?: string;
    readonly refresh_token?: string;
    readonly account_id?: string;
  };
  readonly auth_mode?: string;
};

const loadStore = (): Promise<TCodexStore | null> =>
  // Isolated CODEX_HOME → auth.json lives there.
  readJsonFile<TCodexStore>(join(cliConfigDir(PROVIDER), "auth.json"));

const readToken = async (): Promise<{
  accessToken: string;
  accountId: string | null;
} | null> => {
  const store = await loadStore();
  const tokens = store?.tokens;
  if (tokens?.access_token === undefined || tokens.access_token.length === 0) {
    return null;
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
    return {
      provider: PROVIDER,
      connected: token !== null,
      cli_installed: installed,
      ...(version !== null ? { cli_version: version } : {}),
      ...(token === null
        ? {
            detail: installed
              ? "codex CLI installed but not signed in"
              : "codex CLI not installed",
          }
        : { last_login_at_ms: null }),
    };
  },

  connect: async () => {
    if (!(await cliInstallState(PROVIDER)).installed) {
      return {
        connected: false,
        detail: "Install the Codex CLI from the Providers tab first.",
      };
    }
    // `codex login` opens the browser and BLOCKS until the user signs in
    // and its localhost callback completes; the token then lands in the
    // isolated CLI's own store.
    const result = await spawnLogin([bin(), "login"], env());
    const token = await readToken();
    if (token !== null) {
      return { connected: true, detail: "signed in via Codex" };
    }
    return {
      connected: false,
      detail:
        result.output.length > 0
          ? result.output.slice(0, 300)
          : `codex login exited ${result.code} without a stored credential`,
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
    return {
      access_token: token.accessToken,
      headers: {
        originator: "codex_cli_rs",
        "user-agent": await userAgent(),
        ...(token.accountId !== null
          ? { "chatgpt-account-id": token.accountId }
          : {}),
      },
    };
  },
};
