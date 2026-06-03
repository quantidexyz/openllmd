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
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
  setPendingAuth,
} from "../pending-auth";
import type { TProviderDelegate } from "./types";
import { cliVersion, readJsonFile, runCapture, spawnLogin } from "./util";

const PROVIDER = "chatgpt" as const;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const bin = (): string => cliBin(PROVIDER);
const env = (): Record<string, string> => cliEnv(PROVIDER);

// Keep spawned device-auth processes referenced so they aren't GC'd while
// they poll in the background (they exit on success / expiry).
const deviceProcs = new Set<ReturnType<typeof Bun.spawn>>();

// Built via RegExp so the literal ESC control char is not in a regex literal.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Parse the verification URL + one-time code from `codex login --device-auth`
 * stdout. ⚠️ RESEARCH: format inferred from ref/codex
 * `login/src/device_code_auth.rs` (an ANSI-wrapped prompt — a `…/codex/device`
 * URL line, then a "one-time code" line). Matched leniently; confirm live.
 */
const parseDevicePrompt = (
  raw: string,
): { url: string; code: string } | null => {
  const clean = raw.replace(ANSI_RE, "");
  const url =
    clean.match(/https?:\/\/\S+\/codex\/device\b/)?.[0] ??
    clean.match(/https?:\/\/\S+/)?.[0];
  const code = clean.match(
    /one-time code[^\n]*\n\s*([A-Z0-9][A-Z0-9-]{3,})/i,
  )?.[1];
  return url !== undefined && code !== undefined ? { url, code } : null;
};

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
    const proc = Bun.spawn([bin(), "login", "--device-auth"], {
      stdin: "ignore",
      stdout: "pipe",
      // The process stays alive polling for the whole login; only stdout is
      // read (for the device prompt). Leaving stderr piped + undrained could
      // fill its pipe and stall the child, so discard it.
      stderr: "ignore",
      env: { ...process.env, ...env() },
    });
    deviceProcs.add(proc);
    void proc.exited.then(async () => {
      deviceProcs.delete(proc);
      // The process stays alive polling until the user authorizes; once it
      // exits WITHOUT a stored credential the flow expired / was cancelled /
      // errored — drop the stale code so the card stops showing a dead one.
      if ((await readToken()) === null) clearPendingAuth(PROVIDER);
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
