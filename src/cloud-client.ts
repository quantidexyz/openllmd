/**
 * Authenticated HTTP client for the daemon's cloud control-plane calls.
 * Every request carries the user's `sk-llm-...` key as a bearer. The
 * cloud endpoints the daemon talks to:
 *
 *   GET  /api/daemon/bootstrap  — catalog + provider prefixes + routing
 *   POST /api/daemon/requests   — record one subscription-hop usage row
 *   POST /api/daemon/search     — content-free web_search callback
 *
 * No subscription token or user content ever appears in these payloads
 * (the no-off-box-exfiltration invariant — see the proposal §6).
 */
import { hostname } from "node:os";
import type {
  TDaemonBootstrap,
  TDaemonRecordRequest,
  TDaemonSearchResponse,
  TRelayChannelResponse,
} from "@openllm/schema";
import {
  DAEMON_DEVICE_ID_HEADER,
  DAEMON_DEVICE_LABEL_HEADER,
  RelayChannelResponse,
} from "@openllm/schema";
import { Schema } from "effect";
import { daemonEnv, deviceId } from "./env";

const decodeChannel = Schema.decodeUnknownSync(RelayChannelResponse);

/** Thrown when no API key is configured yet — the daemon is keyless. */
export class NoApiKeyError extends Error {
  constructor() {
    super("no API key configured");
    this.name = "NoApiKeyError";
  }
}

/** Thrown when the cloud rejects the key (401/403) — key invalid/stale. */
export class InvalidApiKeyError extends Error {
  constructor(status: number) {
    super(`cloud rejected the API key (${status})`);
    this.name = "InvalidApiKeyError";
  }
}

// `os.hostname()` is almost always plain ASCII, but a header value must be —
// strip anything outside printable ASCII and cap the length so an exotic
// hostname can't make `fetch` throw on an invalid header.
const deviceLabel = (): string =>
  hostname()
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, 120);

const authHeaders = (): Record<string, string> => {
  const { apiKey } = daemonEnv();
  if (apiKey === null) throw new NoApiKeyError();
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    // Device identity (metadata only): the cloud records the latest value per
    // key on `api_key_activity` so the dashboard tells two daemons behind one
    // NAT apart — device code + IP, not IP alone. Rides every control call
    // (incl. the channel handshake) so it stays fresh. See
    // `docs/proposals/daemon-device-aware-this-machine.md`.
    [DAEMON_DEVICE_ID_HEADER]: deviceId(),
    [DAEMON_DEVICE_LABEL_HEADER]: deviceLabel(),
  };
};

// Cloud control-plane calls must never hang forever. Bun's `fetch` has NO
// default timeout, so a half-open TCP connection to the cloud — routine on a
// long-lived remote daemon after a network blip — stalls the request
// indefinitely. For `fetchChannel` this is fatal: partysocket awaits the URL
// provider INSIDE its reconnect lock (`_connectLock`), released only when the
// fetch settles. A hung channel fetch wedges the lock forever, so BOTH
// partysocket's auto-reconnect AND the daemon's liveness-watchdog `reconnect()`
// early-return — the daemon is stuck "connecting" until the process restarts.
// Bounding every call with an AbortSignal lets a stalled connection reject
// promptly so the channel loop's backoff (or the caller) retries cleanly.
const CLOUD_FETCH_TIMEOUT_MS = 15_000;

const cloudFetch = (url: string, init: RequestInit): Promise<Response> =>
  fetch(url, {
    ...init,
    signal:
      init.signal != null
        ? AbortSignal.any([
            init.signal,
            AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
  });

// Default to the pinned cloud origin, but let the same-machine-307 path
// override per-request with the deployment that issued the redirect
// (`?__origin=`), so one daemon serves any deployment.
const cloudUrl = (path: string, origin?: string | null): string => {
  const base =
    origin !== undefined && origin !== null && origin.length > 0
      ? origin.replace(/\/+$/, "")
      : daemonEnv().cloudOrigin;
  return `${base}${path}`;
};

/**
 * One snapshot with the catalog + provider prefixes + the user's and
 * global fallback config. Pulled at boot + on a TTL by config.ts.
 * Throws `NoApiKeyError` when keyless and `InvalidApiKeyError` on
 * 401/403 so callers can distinguish "needs a key" from "key is bad".
 */
export const fetchBootstrap = async (): Promise<TDaemonBootstrap> => {
  const resp = await cloudFetch(cloudUrl("/api/daemon/bootstrap"), {
    method: "GET",
    headers: authHeaders(),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new InvalidApiKeyError(resp.status);
  }
  if (!resp.ok) throw new Error(`bootstrap fetch failed: ${resp.status}`);
  return (await resp.json()) as TDaemonBootstrap;
};

/**
 * Ask the cloud for a relay channel: `GET /api/daemon/channel`. Returns the
 * stable per-env WSS URL + a short-lived connect ticket the daemon presents in
 * its `hello` frame. The daemon then holds ONE WebSocket to the relay — its
 * only control transport. Throws `NoApiKeyError`/`InvalidApiKeyError` so the
 * channel loop can back off. See `docs/proposals/daemon-relay-websocket-push.md`.
 */
export const fetchChannel = async (): Promise<TRelayChannelResponse> => {
  const resp = await cloudFetch(cloudUrl("/api/daemon/channel"), {
    method: "GET",
    headers: authHeaders(),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new InvalidApiKeyError(resp.status);
  }
  if (!resp.ok) throw new Error(`channel fetch failed: ${resp.status}`);
  // Validate before we dial: a malformed `wss_url`/`ticket` would otherwise
  // surface as a cryptic WebSocket construction failure. Throwing here routes
  // through the channel loop's backoff like any other channel-fetch error.
  try {
    return decodeChannel(await resp.json());
  } catch (err) {
    throw new Error(
      `invalid channel response: ${err instanceof Error ? err.message : "decode failed"}`,
    );
  }
};

/**
 * Record one `public.requests` row for a subscription hop the daemon ran
 * locally. Best-effort: a recording failure must never fail the user's
 * request (the bytes already streamed back), so callers fire-and-forget.
 */
export const recordRequest = async (
  row: TDaemonRecordRequest,
  origin?: string | null,
): Promise<void> => {
  try {
    await cloudFetch(cloudUrl("/api/daemon/requests", origin), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(row),
    });
  } catch {
    // swallow — usage recording is non-critical telemetry
  }
};

/**
 * The content-free web_search callback (coreless proposal §5). The daemon
 * holds no DEK, so when a subscription model it's serving calls the openllm
 * web_search tool, the daemon POSTs ONLY the query here; the cloud recovers
 * the DEK from the daemon's `sk-llm` key, runs the search with the user's
 * vault search credential, and returns the tool-result content + native
 * Anthropic blocks. The conversation never crosses. Returns null on any
 * failure (keyless / unreachable / non-2xx) — the caller surfaces a search
 * error to the model rather than failing the turn.
 */
export const searchViaCloud = async (
  query: string,
  origin?: string | null,
  signal?: AbortSignal,
): Promise<TDaemonSearchResponse | null> => {
  try {
    const resp = await cloudFetch(cloudUrl("/api/daemon/search", origin), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as TDaemonSearchResponse;
  } catch {
    return null;
  }
};

/**
 * Relay a SEALED credential to another of the user's daemons:
 * `POST /api/daemon/relay-credential`. The minting daemon (this machine, the
 * browser) seals a Claude setup-token to the target daemon's pubkey and posts
 * the ciphertext here; the cloud (verifying same-user ownership of
 * `targetKey`) enqueues a `receive_setup_token` command to it. The cloud only
 * ever sees ciphertext. Throws on a non-2xx so the caller can ack the failure.
 */
export const relayCredential = async (
  targetKey: string,
  sealed: string,
): Promise<void> => {
  const resp = await cloudFetch(cloudUrl("/api/daemon/relay-credential"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ target_key: targetKey, sealed }),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new InvalidApiKeyError(resp.status);
  }
  if (!resp.ok) throw new Error(`relay-credential failed: ${resp.status}`);
};
