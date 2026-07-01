/**
 * xAI Grok ("Grok Build", x.ai/cli) delegate.
 *
 * Native delegation: use the installed `grok` CLI's OWN bearer + identity.
 * Grok Build is a subscription-OAuth coding agent (SuperGrok / X Premium+). We
 * never mint/forge/export the token — the daemon reads the CLI's own store and
 * injects the bearer for ONE inference call.
 *
 * Wire format: the OpenAI Responses API at the CLI chat proxy
 * (`cli-chat-proxy.grok.com/v1/responses`) — both Grok Build models report
 * `api_backend: "responses"` via `/v1/models`. The coreless walker maps
 * `grok → "chatgpt"` (the shared Responses adapter).
 *
 * ISOLATED install under `~/.openllm/cli/grok/` (HOME-pinned), so it never
 * touches the user's personal `~/.grok`.
 *
 * VERIFIED against grok CLI 0.2.73 (its bundled `docs/user-guide/` + a real
 * login):
 *   - Store: `<HOME>/.grok/auth.json` — a MAP of session entries keyed by
 *     `"<issuer>::<session-id>"`; each entry's `key` is the access token,
 *     alongside `refresh_token` + `expires_at` (ISO-8601).
 *   - Login: `grok login` / `grok login --oauth` (browser at accounts.x.ai);
 *     `grok login --device-auth` (device-code, headless/remote) — both native.
 *   - Logout: `grok logout`.
 *   - Refresh: the CLI refreshes its own token on any authenticated run; the
 *     daemon TRIGGERS that (a bounded `grok models`) when near `expires_at`.
 *   - Usage: available at `cli-chat-proxy.grok.com/v1/billing` (the CLI chat
 *     proxy's OWN billing route — SAME host as inference — which the CLI's
 *     `billing.rs` reads for "View credit usage"). Bearer-authed with the CLI
 *     OAuth token (401 on a bad/absent token; the extra `x-grok-client-*`
 *     headers aren't required but are sent for parity). Returns
 *     `{ config: { monthlyLimit:{val}, used:{val}, billingPeriodStart/End, … } }`
 *     — we surface the included-quota window as one bar (see
 *     {@link parseGrokBilling}). Verified live against a SuperGrok / X Premium+
 *     session. (An earlier probe wrongly concluded usage was forbidden — it hit
 *     `grok.com/rest/rate-limits`, a DIFFERENT grpc gateway that 404/501s these
 *     routes regardless of token; that was a wrong host, not a tier limit.)
 *
 * ⚠️ STILL UNVALIDATED LIVE: the `grok login --device-auth` prompt shape
 * ({@link parseDevicePrompt}); that `grok models` actually rotates+persists the
 * token (the refresh trigger); and whether Grok's Responses endpoint tolerates
 * the Codex `instructions` preamble the shared chatgpt request builder injects
 * (it may need a grok-specific builder).
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
import {
  ensureAuthConfig,
  resolveProviderUrl,
  resolveUpstreamUrl,
} from "./auth-config";
import { makeStreamDeviceConnect } from "./login-device";
import { makeStreamConnect } from "./login-direct";
import { loginSlot } from "./login-flow";
import { makeRefresher, spawnRefresh } from "./refresh";
import type { TProviderDelegate } from "./types";
import { cliVersion, readJsonFile, runCapture, stripAnsi } from "./util";

const PROVIDER = "grok" as const;

// Usage endpoint LEAF path — the host is derived from the captured inference
// endpoint (`resolveProviderUrl`), so a vendor host migration is auto-tracked.
// This is the CLI chat-proxy's own billing route (same host as inference), which
// the CLI's `billing.rs` reads to render "View credit usage" — verified live
// against a SuperGrok / X Premium+ session (see the header block above).
const USAGE_PATH = "/v1/billing";

// Trigger the CLI's OWN refresh when the access token is within this window of
// `expires_at`. Mirrors codex's leeway.
const REFRESH_LEEWAY_MS = 5 * 60_000;

const bin = (): string => cliBin(PROVIDER);
const env = (): Record<string, string> => cliEnv(PROVIDER);

/** Strip query strings from any URL in a diagnostic string, so OAuth authorize
 *  params (client_id / code_challenge / state) are never persisted to the local
 *  log. Keeps the scheme+host+path for debugging. */
const redactUrls = (s: string): string =>
  s.replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1?<redacted>");

/**
 * Parse the browser authorize URL `grok login` prints. The user clicks an
 * `accounts.x.ai/sign-in` URL (the OIDC backend is `auth.x.ai`). Matched
 * leniently so a path tweak doesn't break it.
 */
const parseAuthUrl = (raw: string): string | null => {
  const clean = stripAnsi(raw);
  return (
    clean.match(/https?:\/\/accounts\.x\.ai\/\S+/)?.[0] ??
    clean.match(/https?:\/\/auth\.x\.ai\/\S+/)?.[0] ??
    clean.match(/https?:\/\/\S*\/(?:oauth\/)?authorize\S+/)?.[0] ??
    null
  );
};

/**
 * Parse the verification URL + one-time code from `grok login --device-auth`
 * stdout. ⚠️ RESEARCH-UNVERIFIED prompt shape — matched leniently (an
 * `accounts.x.ai`/`auth.x.ai` URL + a code-looking token near "code"); confirm
 * against a real device login.
 */
const parseDevicePrompt = (
  raw: string,
): { url: string; code: string } | null => {
  const clean = stripAnsi(raw);
  const url =
    clean.match(/https?:\/\/(?:accounts|auth)\.x\.ai\/\S+/)?.[0] ??
    clean.match(/https?:\/\/\S+/)?.[0];
  const code = clean.match(/code[^\n]*?\b([A-Z0-9][A-Z0-9-]{3,})\b/i)?.[1];
  return url !== undefined && code !== undefined ? { url, code } : null;
};

// auth.json is a MAP of session entries keyed by `"<issuer>::<session-id>"`
// (verified against grok 0.2.73). The access token is the `key` field; the
// session also carries `refresh_token` + `expires_at`.
type TGrokSession = {
  /** The access token sent as `Authorization: Bearer <key>`. */
  readonly key?: string;
  readonly refresh_token?: string;
  /** ISO-8601 expiry of the access token. */
  readonly expires_at?: string;
  /** ISO-8601 session creation time — used to pick the newest session. */
  readonly create_time?: string;
};
type TGrokStore = Readonly<Record<string, TGrokSession>>;

const authPath = (): string => join(cliConfigDir(PROVIDER), "auth.json");

const loadStore = (): Promise<TGrokStore | null> =>
  // Isolated HOME → <home>/.grok/auth.json (cliConfigDir).
  readJsonFile<TGrokStore>(authPath());

/** The newest session entry carrying a usable access token, or null. */
const newestSession = async (): Promise<TGrokSession | null> => {
  const store = await loadStore();
  if (store === null) return null;
  const sessions = Object.values(store).filter(
    (s): s is TGrokSession & { readonly key: string } =>
      typeof s?.key === "string" && s.key.length > 0,
  );
  if (sessions.length === 0) return null;
  // Newest first — ISO `create_time` sorts lexicographically.
  sessions.sort((a, b) =>
    (b.create_time ?? "").localeCompare(a.create_time ?? ""),
  );
  return sessions[0] ?? null;
};

const parseExpiryMs = (iso: string | undefined): number | null => {
  if (iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

// cli-chat-proxy.grok.com GATES on the CLI version header: a request without
// `x-grok-client-version` (or with an old one) is rejected 426 "Your Grok CLI
// version (none) is outdated. Please update to version 0.1.202 or later". We
// send the INSTALLED binary's real version (the genuine CLI identity), read
// once + memoized (it only changes on a CLI update); fall back to a known-good
// floor if `--version` can't be read.
let cachedVersion: string | null = null;
const clientVersion = async (): Promise<string> => {
  if (cachedVersion !== null) return cachedVersion;
  const v = await cliVersion(bin(), env());
  cachedVersion = v?.match(/\d+\.\d+\.\d+/)?.[0] ?? "0.2.73";
  return cachedVersion;
};

/**
 * Trigger the grok CLI's OWN token refresh: a bounded `grok models` (a cheap
 * authenticated call). The CLI's auth manager refreshes + persists the rotated
 * token to `auth.json` when it's near expiry; the daemon never writes the store.
 */
const triggerRefresh = async (): Promise<void> => {
  await spawnRefresh([bin(), "models"], env());
};

// Within leeway → refresh in the background (token still valid, no stall);
// hard-expired → await it. Single-flight per provider.
const refresh = makeRefresher({
  leewayMs: REFRESH_LEEWAY_MS,
  trigger: triggerRefresh,
});

/** Read the stored access token, triggering the CLI's native refresh near
 *  expiry (the CLI owns the store; we just re-read after a hard-expired await). */
const readToken = async (): Promise<{ accessToken: string } | null> => {
  const session = await newestSession();
  if (session?.key === undefined || session.key.length === 0) return null;
  const expiresAtMs = parseExpiryMs(session.expires_at);
  // Only trigger when the credential CAN be refreshed (a refresh token exists).
  const outcome = session.refresh_token ? await refresh(expiresAtMs) : "fresh";
  if (outcome !== "awaited") return { accessToken: session.key };
  // Hard-expired path: the CLI refresh was awaited — re-read the rotated store.
  const fresh = await newestSession();
  return {
    accessToken:
      fresh?.key !== undefined && fresh.key.length > 0
        ? fresh.key
        : session.key,
  };
};

// ─── Login wiring ────────────────────────────────────────────────────────
//
// Grok has BOTH native flows, so we wire both (mirroring codex). They share ONE
// `loginSlot` so only one `grok login` runs at a time, and `cancelConnect`
// (from the device adaptor) kills whichever is live:
//   - connect            → `grok login` (browser, this machine);
//   - connectDeviceCode  → `grok login --device-auth` (headless/remote).

const INSTALL_HINT = "Install the Grok CLI from the Providers tab first.";
const CONNECTED_DETAIL = "signed in via Grok";
const IN_PROGRESS_DETAIL =
  "Grok sign-in already in progress — finish authorizing in your browser; this updates automatically.";

const isInstalled = async (): Promise<boolean> =>
  (await cliInstallState(PROVIDER)).installed;
const isConnected = async (): Promise<boolean> => (await readToken()) !== null;
// A fresh login may rotate the captured upstream URL — refresh the auth config,
// best-effort + non-blocking, exactly as codex's flows do.
const refreshConfig = (): void => {
  void ensureAuthConfig(PROVIDER, { force: true }).catch(() => {});
};

const slot = loginSlot(PROVIDER);

// Browser flow: `grok login` prints the authorize URL to stderr; it opens its
// OWN browser, so we only surface the URL (so a remote box can click it).
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

// Device-code flow: `grok login --device-auth` prints the verification URL +
// one-time code to stderr (verified against x.ai/cli v0.2.77); we surface them
// + open the URL locally.
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
  stream: "stderr",
  parse: parseDevicePrompt,
  onConnected: refreshConfig,
  pendingDetail: (found) => pendingAuthDetail(found),
  failDetail:
    "Couldn't start Grok device sign-in. Retry, or run `grok login --device-auth` on the box.",
  cancelMessages: {
    cancelled: "Grok sign-in cancelled",
    none: "no sign-in was in progress",
  },
});

// ─── /v1/billing parsing ───────────────────────────────────────────────────
//
// The CLI chat-proxy's billing route returns a `config` object whose numeric
// fields are `{ val: number }` wrappers (verified live + cross-checked against
// the CLI binary's own `billing.rs` struct):
//   { config: { monthlyLimit:{val}, used:{val}, onDemandCap:{val},
//               billingPeriodStart, billingPeriodEnd, history:[…] } }
// We surface the INCLUDED-quota window (`used` / `monthlyLimit`) as one bar; the
// period end is the reset. `?format=credits` returns a different (weekly
// on-demand/prepaid) view we don't use.

type TGrokBillingVal = { readonly val?: number };
type TGrokBillingConfig = {
  readonly monthlyLimit?: TGrokBillingVal;
  readonly used?: TGrokBillingVal;
  readonly billingPeriodEnd?: string;
};
type TGrokBilling = { readonly config?: TGrokBillingConfig };

/** Map a `/v1/billing` body into a usage snapshot. Pure (no network) so it can
 *  be unit-tested. Returns `unavailable` when there is no included-quota window
 *  (a plan that only reports on-demand credit), so the UI points to grok.com. */
export const parseGrokBilling = (body: unknown): TProviderUsageSnapshot => {
  const config =
    body !== null && typeof body === "object" && "config" in body
      ? ((body as TGrokBilling).config ?? {})
      : {};
  const limit =
    typeof config.monthlyLimit?.val === "number" ? config.monthlyLimit.val : 0;
  if (limit <= 0) {
    return {
      kind: "unavailable",
      reason: "Grok reported no included-quota window for this plan.",
      link: "https://grok.com",
    };
  }
  const used = typeof config.used?.val === "number" ? config.used.val : 0;
  const percentUsed = Math.max(0, Math.min(100, (used / limit) * 100));
  const resetMs =
    typeof config.billingPeriodEnd === "string"
      ? Date.parse(config.billingPeriodEnd)
      : Number.NaN;
  return {
    kind: "quota",
    status:
      percentUsed >= 100
        ? "rejected"
        : percentUsed >= 80
          ? "allowed_warning"
          : "allowed",
    windows: [
      {
        label: "Monthly",
        percent_used: percentUsed,
        reset_at_ms: Number.isNaN(resetMs) ? null : resetMs,
      },
    ],
    note: "Grok — read locally via Grok CLI",
  };
};

export const grokDelegate: TProviderDelegate = {
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
    try {
      // Same host as inference (`resolveProviderUrl` derives it from the captured
      // upstream, never spawning the CLI). The plain OAuth bearer is accepted;
      // we send the CLI's genuine identity headers too, mirroring
      // `credentialForUpstream`.
      const resp = await fetch(await resolveProviderUrl(PROVIDER, USAGE_PATH), {
        method: "GET",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "x-grok-client-version": await clientVersion(),
          "x-grok-client-identifier": "xai-grok-cli",
          accept: "application/json",
        },
      });
      if (!resp.ok) {
        const reason =
          resp.status === 401
            ? "Grok authorization was rejected — re-sign in via `grok login`."
            : resp.status === 403
              ? "No active SuperGrok / X Premium+ subscription on this account."
              : `Grok couldn't report usage (HTTP ${resp.status}).`;
        return { kind: "unavailable", reason, link: "https://grok.com" };
      }
      return parseGrokBilling(await resp.json());
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
      throw new Error("grok: not signed in (no stored credential)");
    }
    // cli-chat-proxy.grok.com gates on the CLI's genuine identity headers — a
    // request without `x-grok-client-version` is rejected 426. We send the
    // installed CLI's REAL version + client identifier (the same identity the
    // official `grok` sends). The Responses TARGET URL is captured/default
    // per-hop; the originator's other headers ride through.
    const url = await resolveUpstreamUrl(PROVIDER);
    return {
      access_token: token.accessToken,
      headers: {
        "x-grok-client-version": await clientVersion(),
        "x-grok-client-identifier": "xai-grok-cli",
      },
      url,
    };
  },

  logout: async () => {
    // `grok logout` clears the cached credentials; then ensure the isolated
    // auth.json is gone regardless of CLI version.
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
