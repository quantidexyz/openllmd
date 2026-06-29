/**
 * Kimi Code (Moonshot) delegate.
 *
 * Native delegation: use the installed Kimi CLI's OWN token + identity.
 * Replaces the server-side synthesis in `kimi-code/common.ts`. Weakest of
 * the three — Kimi's consumer ToS has a flat no-commercial bar
 * (proposal §5); rank support/warnings accordingly.
 *
 * ISOLATED install: the daemon runs its OWN `kimi` under
 * `~/.openllm/cli/kimi_code/` with `KIMI_CODE_HOME` pointed inside it
 * (see cli-paths.ts), so it never touches the user's `~/.kimi-code`.
 * Verified against the Kimi Code CLI source (ref/kimi-code — Node/TS):
 *   - OAuth token at `<KIMI_CODE_HOME>/credentials/kimi-code.json`, shape
 *     { access_token, refresh_token, expires_at (epoch SECONDS), … }.
 *   - Device id `<KIMI_CODE_HOME>/device_id` (uuid4) — forwarded as
 *     X-Msh-Device-Id so the identity is the real CLI's, not forged.
 *   - Login: NO `login` subcommand and NO headless flag — the CLI's
 *     sign-in is the in-TUI `/login` slash command (needs a raw-mode TTY),
 *     so the daemon can't spawn it. Instead the daemon drives Kimi's OWN
 *     device-code OAuth flow directly (the exact flow the CLI runs
 *     internally — `packages/oauth`): POST `/api/oauth/device_authorization`
 *     → open the verification URL (code pre-embedded) → poll
 *     `/api/oauth/token` (grant_type=device_code) → write the credential
 *     file the CLI would have written. Same endpoints, client id, wire
 *     shape, and `device_id` as the official CLI.
 *   - Upstream identity (packages/oauth identity.ts): User-Agent
 *     `kimi-code-cli/<ver>`, `X-Msh-Platform: kimi_code_cli`,
 *     `X-Msh-Version`, `X-Msh-Device-Name` (hostname),
 *     `X-Msh-Device-Model`, `X-Msh-Os-Version` (os.release()),
 *     `X-Msh-Device-Id`.
 *   - Usage: GET https://api.kimi.com/coding/v1/usages.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { arch, hostname, release, type } from "node:os";
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@quantidexyz/openllmp";
import { cliInstallState } from "../cli-install";
import { cliBin, cliConfigDir, cliEnv } from "../cli-paths";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";
import { ensureAuthConfig, resolveUpstreamUrl } from "./auth-config";
import type { TDeviceAuth, TDevicePoll } from "./login-direct";
import { makeDeviceCodeConnect } from "./login-direct";
import { loginSlot, makeCancelConnect } from "./login-flow";
import type { TProviderDelegate } from "./types";
import { cliVersion, readJsonFile } from "./util";

const PROVIDER = "kimi_code" as const;
const USAGE_URL = "https://api.kimi.com/coding/v1/usages";

// Device-code OAuth — verbatim from `ref/kimi-code/packages/oauth`
// (constants.ts + oauth.ts). Same host + public client id the CLI uses,
// so the daemon runs the CLI's own login, not a forged one.
const OAUTH_HOST = (
  process.env.KIMI_CODE_OAUTH_HOST ??
  process.env.KIMI_OAUTH_HOST ??
  "https://auth.kimi.com"
).replace(/\/$/, "");
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// Refresh the access token when it's within this of `expires_at` — both
// on a status/usage read and before serving a request (a small skew
// avoids a guaranteed 401 → refresh → retry on the next call).
const REFRESH_LEEWAY_MS = 60_000;

const bin = (): string => cliBin(PROVIDER);
const env = (): Record<string, string> => cliEnv(PROVIDER);
const kimiHome = (): string => cliConfigDir(PROVIDER);
const credentialPath = (): string =>
  join(kimiHome(), "credentials", "kimi-code.json");

type TKimiToken = {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_at?: number;
};

/**
 * Exchange the stored refresh token for a fresh one via the SAME
 * device-code token endpoint with `grant_type=refresh_token` the CLI
 * uses (ref/kimi-code packages/oauth `refreshAccessToken`). Returns the
 * new wire blob on success, null on any failure — the caller then falls
 * back to the stale token and the upstream's own 401 surfaces.
 */
const refreshOAuth = async (
  refresh: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | null> => {
  try {
    const { status, data } = await postForm(
      "/api/oauth/token",
      {
        client_id: OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refresh,
      },
      headers,
    );
    return status === 200 && typeof data.access_token === "string"
      ? data
      : null;
  } catch {
    return null;
  }
};

// Single-flight guard: concurrent callers that all see a stale token
// share ONE refresh (Kimi rotates the refresh token, so parallel
// refreshes would invalidate each other).
let inFlightRefresh: Promise<void> | null = null;

/**
 * The current access token from
 * `<KIMI_CODE_HOME>/credentials/kimi-code.json` (storage name resolves to
 * `kimi-code`; see packages/oauth resolveKimiTokenStorageName) —
 * REFRESHED + persisted when it's within the leeway of `expires_at`.
 * Used by `status`, `usage`, and `credentialForUpstream`, so a status
 * check AND a served request both carry a live token (the CLI itself
 * only refreshes mid-its-own-inference, which the daemon never triggers).
 */
const readToken = async (): Promise<{ accessToken: string } | null> => {
  const tok = await readJsonFile<TKimiToken>(credentialPath());
  if (tok?.access_token === undefined || tok.access_token.length === 0) {
    return null;
  }
  const expiresAtMs =
    typeof tok.expires_at === "number" && tok.expires_at > 0
      ? tok.expires_at * 1000
      : null;
  const stale =
    expiresAtMs !== null && expiresAtMs - Date.now() < REFRESH_LEEWAY_MS;
  if (
    !stale ||
    tok.refresh_token === undefined ||
    tok.refresh_token.length === 0
  ) {
    return { accessToken: tok.access_token };
  }

  if (inFlightRefresh === null) {
    const rt = tok.refresh_token;
    inFlightRefresh = (async () => {
      const wire = await refreshOAuth(rt, await identityHeaders());
      if (wire === null) return;
      // Kimi rotates the refresh token; keep the old one if the response
      // omits it so we can still refresh next time. `writeCredential`
      // persists the exact wire shape the CLI's storage uses.
      if (
        typeof wire.refresh_token !== "string" ||
        wire.refresh_token.length === 0
      ) {
        wire.refresh_token = rt;
      }
      writeCredential(wire);
    })().finally(() => {
      inFlightRefresh = null;
    });
  }
  await inFlightRefresh;

  // Re-read the (now-rotated) credential; fall back to the stale token if
  // the refresh failed — the upstream then 401s and the UI says re-login.
  const fresh = await readJsonFile<TKimiToken>(credentialPath());
  return {
    accessToken:
      fresh?.access_token !== undefined && fresh.access_token.length > 0
        ? fresh.access_token
        : tok.access_token,
  };
};

// Read the persisted device id, or mint + persist one (uuid4, mode 0600)
// at `<KIMI_CODE_HOME>/device_id` — exactly `createKimiDeviceId` in
// packages/oauth identity.ts. The SAME id is used for the login device
// flow and every subsequent upstream call, so the identity is stable.
const ensureDeviceId = async (): Promise<string> => {
  const path = join(kimiHome(), "device_id");
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      const id = (await file.text()).trim();
      if (id.length > 0) return id;
    }
  } catch {
    // fall through to create
  }
  const id = crypto.randomUUID();
  mkdirSync(kimiHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, id, { encoding: "utf-8", mode: 0o600 });
  return id;
};

const kimiVersion = async (): Promise<string> => {
  const v = await cliVersion(bin(), env());
  return v?.match(/\d+\.\d+\.\d+/)?.[0] ?? "1.0.0";
};

// Mirrors packages/oauth identity.ts deviceModel().
const deviceModel = (): string => {
  const os = type();
  const ver = release();
  const a = arch();
  if (os === "Darwin") return `macOS ${ver} ${a}`;
  if (os === "Windows_NT") return `Windows ${ver} ${a}`;
  return `${os} ${ver} ${a}`.trim();
};

const headersFor = (
  version: string,
  deviceId: string,
): Record<string, string> => ({
  "user-agent": `kimi-code-cli/${version}`,
  "x-msh-platform": "kimi_code_cli",
  "x-msh-version": version,
  "x-msh-device-name": hostname(),
  "x-msh-device-model": deviceModel(),
  "x-msh-os-version": release(),
  "x-msh-device-id": deviceId,
});

const identityHeaders = async (): Promise<Record<string, string>> =>
  headersFor(await kimiVersion(), await ensureDeviceId());

// ─── Device-code login flow ──────────────────────────────────────────────
//
// kimi DRIVES the device-code flow; the direct-login adaptor ORCHESTRATES it
// (surface URL+code → background poll). The request (`TDeviceAuth`) + poll
// (`TDevicePoll`) shapes are the adaptor's generic contract, imported above.

const postForm = async (
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> => {
  const resp = await fetch(`${OAUTH_HOST}${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  let data: Record<string, unknown> = {};
  try {
    const parsed = (await resp.json()) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // non-JSON — caller interprets by status
  }
  return { status: resp.status, data };
};

const requestDeviceCode = async (
  headers: Record<string, string>,
): Promise<TDeviceAuth | null> => {
  try {
    const { status, data } = await postForm(
      "/api/oauth/device_authorization",
      { client_id: OAUTH_CLIENT_ID },
      headers,
    );
    const deviceCode = data.device_code;
    const userCode = data.user_code;
    const uriComplete = data.verification_uri_complete;
    if (
      status !== 200 ||
      typeof deviceCode !== "string" ||
      typeof userCode !== "string" ||
      typeof uriComplete !== "string"
    ) {
      return null;
    }
    const interval = Number(data.interval ?? 5);
    const expiresIn = Number(data.expires_in ?? 900);
    return {
      userCode,
      deviceCode,
      verificationUriComplete: uriComplete,
      intervalMs:
        (Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000,
      expiresInMs:
        (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900) * 1000,
    };
  } catch {
    return null;
  }
};

const pollDeviceToken = async (
  deviceCode: string,
  headers: Record<string, string>,
): Promise<TDevicePoll> => {
  const { status, data } = await postForm(
    "/api/oauth/token",
    {
      client_id: OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT,
    },
    headers,
  );
  if (status === 200 && typeof data.access_token === "string") {
    return { kind: "success", wire: data };
  }
  const code = typeof data.error === "string" ? data.error : "";
  if (code === "authorization_pending")
    return { kind: "pending", slowDown: false };
  if (code === "slow_down") return { kind: "pending", slowDown: true };
  return { kind: "stop" }; // expired_token / access_denied / anything else
};

// Persist the token in the EXACT wire shape the CLI's FileTokenStorage
// writes (`tokenToWire`): snake_case, `expires_at` epoch SECONDS. mode
// 0600 file under a 0700 credentials dir, matching packages/oauth.
const writeCredential = (wire: Record<string, unknown>): void => {
  const expiresIn = Number(wire.expires_in ?? 0);
  const blob = {
    access_token: String(wire.access_token ?? ""),
    refresh_token: String(wire.refresh_token ?? ""),
    expires_at:
      Math.floor(Date.now() / 1000) +
      (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0),
    scope: typeof wire.scope === "string" ? wire.scope : "",
    token_type:
      typeof wire.token_type === "string" ? wire.token_type : "Bearer",
    expires_in: Number.isFinite(expiresIn) ? expiresIn : 0,
  };
  const dir = join(kimiHome(), "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "kimi-code.json"), JSON.stringify(blob), {
    encoding: "utf-8",
    mode: 0o600,
  });
};

// ─── /usages parsing ─────────────────────────────────────────────────────
//
// Port of `parseManagedUsagePayload` (ref/kimi-code packages/oauth
// managed-usage.ts). The payload is:
//   { usage: { name, used, limit, resetAt },
//     limits: [ { detail: {used,limit,name}, window: {duration,timeUnit} } ] }
// Field spelling/casing drifts across versions, so the parse is loose:
// `used` or `limit - remaining`; name from name/title/scope or a duration
// label; reset from any of reset_at/resetAt/reset_time/resetTime.

type TUsageRow = {
  readonly label: string;
  readonly percentUsed: number;
  readonly resetAtMs: number | null;
};

const toInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object";

const resetAtMsOf = (raw: Record<string, unknown>): number | null => {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const v = raw[key];
    if (typeof v === "string" && v.length > 0) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
};

const toUsageRow = (raw: unknown, fallbackLabel: string): TUsageRow | null => {
  if (!isRec(raw)) return null;
  const limit = toInt(raw.limit);
  let used = toInt(raw.used);
  if (used === null) {
    const remaining = toInt(raw.remaining);
    if (remaining !== null && limit !== null) used = limit - remaining;
  }
  if (used === null && limit === null) return null;
  const label =
    typeof raw.name === "string"
      ? raw.name
      : typeof raw.title === "string"
        ? raw.title
        : fallbackLabel;
  const u = used ?? 0;
  const l = limit ?? 0;
  return {
    label,
    percentUsed: l > 0 ? Math.max(0, Math.min(100, (u / l) * 100)) : 0,
    resetAtMs: resetAtMsOf(raw),
  };
};

// Derive a friendly window label (mirrors `limitLabel` in managed-usage.ts):
// an explicit name/title/scope, else from the window's duration + timeUnit
// (e.g. 300 TIME_UNIT_MINUTE → "5h limit"), else a positional fallback.
const limitLabel = (
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  window: Record<string, unknown>,
  idx: number,
): string => {
  for (const key of ["name", "title", "scope"]) {
    const v = item[key] ?? detail[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const duration = toInt(window.duration ?? item.duration ?? detail.duration);
  const rawUnit = window.timeUnit ?? item.timeUnit ?? detail.timeUnit;
  const unit = typeof rawUnit === "string" ? rawUnit : "";
  if (duration !== null) {
    if (unit.includes("MINUTE")) {
      return duration >= 60 && duration % 60 === 0
        ? `${duration / 60}h limit`
        : `${duration}m limit`;
    }
    if (unit.includes("HOUR")) return `${duration}h limit`;
    if (unit.includes("DAY")) return `${duration}d limit`;
    return `${duration}s limit`;
  }
  return `Limit #${idx + 1}`;
};

const parseUsageWindows = (payload: unknown): ReadonlyArray<TUsageRow> => {
  if (!isRec(payload)) return [];
  const rows: TUsageRow[] = [];
  const summary = toUsageRow(payload.usage, "Weekly limit");
  if (summary !== null) rows.push(summary);
  const rawLimits = payload.limits;
  if (Array.isArray(rawLimits)) {
    rawLimits.forEach((item, idx) => {
      if (!isRec(item)) return;
      const detail = isRec(item.detail) ? item.detail : item;
      const window = isRec(item.window) ? item.window : {};
      const row = toUsageRow(detail, limitLabel(item, detail, window, idx));
      if (row !== null) rows.push(row);
    });
  }
  return rows;
};

// ─── Login wiring ────────────────────────────────────────────────────────
//
// kimi's only sign-in is the device-code flow, driven via the direct-login
// adaptor; `cancelConnect` aborts the background poll through the shared slot.

const slot = loginSlot(PROVIDER);
// Identity headers (UA + device id) computed ONCE per login (single-flight
// guarantees no overlap) and reused by the device-code request + every poll,
// matching the pre-refactor flow which captured `headers` once in `connect`.
let loginHeaders: Record<string, string> = {};

const connectDevice = makeDeviceCodeConnect({
  provider: PROVIDER,
  slot,
  installed: async () => (await cliInstallState(PROVIDER)).installed,
  installHint: "Install the Kimi CLI from the Providers tab first.",
  connected: async () => (await readToken()) !== null,
  connectedDetail: "signed in via Kimi Code",
  inProgressDetail:
    "Kimi sign-in already in progress — finish authorizing in your browser; this updates automatically.",
  requestDeviceAuth: async () => {
    loginHeaders = await identityHeaders();
    return requestDeviceCode(loginHeaders);
  },
  pollToken: (deviceCode) => pollDeviceToken(deviceCode, loginHeaders),
  onCredential: (wire) => writeCredential(wire),
  // Refresh the auth config (upstream URL) now the identity is established.
  onConnected: () => {
    void ensureAuthConfig(PROVIDER, { force: true }).catch(() => {});
  },
  pendingDetail: (auth) =>
    `Authorize Kimi in the browser window that just opened (code ${auth.userCode}). This page updates automatically when you're done — or open ${auth.verificationUriComplete}`,
  startFailDetail:
    "Couldn't start Kimi sign-in (device authorization failed). Check your connection and retry.",
});

const cancelConnect = makeCancelConnect(PROVIDER, slot, {
  cancelled: "Kimi sign-in cancelled",
  none: "no sign-in was in progress",
});

export const kimiCodeDelegate: TProviderDelegate = {
  slug: PROVIDER,

  connect: connectDevice,
  cancelConnect,

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
                  ? "kimi CLI installed but not signed in"
                  : "kimi CLI not installed",
          }
        : { last_login_at_ms: null }),
    };
  },

  usage: async (): Promise<TProviderUsageSnapshot> => {
    const token = await readToken();
    if (token === null) {
      return { kind: "unavailable", reason: "not signed in to Kimi CLI" };
    }
    try {
      const resp = await fetch(USAGE_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          ...(await identityHeaders()),
          accept: "application/json",
        },
      });
      if (!resp.ok) {
        // Phrase like the Kimi CLI itself (packages/oauth managed-usage):
        // 401 = the token was rejected — your Kimi Code subscription has
        // likely run out / is inactive, or the session needs a re-login.
        // 403 = the coding feature isn't available to this account.
        // 404 = the usage endpoint isn't enabled for this plan.
        const reason =
          resp.status === 401
            ? "Kimi Code authorization was rejected — your subscription may be inactive or expired. Re-sign in via the Kimi CLI (/login)."
            : resp.status === 403
              ? "No active Kimi Code subscription — your coding plan has run out or isn't enabled for this account."
              : resp.status === 404
                ? "Kimi Code usage isn't available on this plan."
                : `Kimi Code couldn't report usage (HTTP ${resp.status}).`;
        return { kind: "unavailable", reason };
      }
      // Parse the `{ usage, limits[] }` payload into one window per limit
      // (+ the rolled-up summary) — see parseUsageWindows.
      const rows = parseUsageWindows(await resp.json());
      if (rows.length === 0) {
        return {
          kind: "unavailable",
          reason: "/usages had no parseable window",
        };
      }
      const windows = rows.map((r) => ({
        label: r.label,
        percent_used: r.percentUsed,
        reset_at_ms: r.resetAtMs,
      }));
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
        note: "Kimi Code — read locally via Kimi CLI",
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
      throw new Error("kimi_code: not signed in (no stored credential)");
    }
    // Resolve the request TARGET URL — the genuine OpenAI-wire
    // `/coding/v1/chat/completions` endpoint, captured from `kimi -p ping` (or
    // the default) — and inject kimi's CREDENTIAL-BINDING identity. Kimi's
    // managed endpoint binds the token to its kimi-code client identity and
    // VALIDATES the full `x-msh-*` set + UA on every request (it 403s on any
    // subset — confirmed live with just device-id/platform/version). The daemon
    // legitimately holds a kimi-code credential (it ran kimi's OWN device-code
    // OAuth, registering `x-msh-device-id`), so presenting that identity is
    // credential-intrinsic, not a forged CLI identity — unlike claude/codex,
    // kimi's token is unusable without it. These are spread OVER the
    // originator's headers in the walker, so the kimi-code UA/device identity
    // wins for this hop. `identityHeaders()` is the same set used for the
    // device-login + /usages calls.
    const url = await resolveUpstreamUrl(PROVIDER);
    return {
      access_token: token.accessToken,
      headers: await identityHeaders(),
      url,
    };
  },

  logout: async () => {
    // Kimi's CLI has no spawnable logout (device-code only) — clear the
    // isolated credential file. The device_id is kept (stable per box).
    await rm(credentialPath(), { force: true }).catch(() => {});
    const cleared = (await readToken()) === null;
    return cleared
      ? { ok: true, detail: "removed Kimi Code credential" }
      : { ok: false, detail: "credential still present after logout" };
  },
};
