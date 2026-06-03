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
  TDaemonPollResponse,
  TDaemonRecordRequest,
  TDaemonSearchResponse,
  TDaemonStatusReport,
} from "@openllm/schema";
import {
  DAEMON_DEVICE_ID_HEADER,
  DAEMON_DEVICE_LABEL_HEADER,
} from "@openllm/schema";
import { daemonEnv, deviceId } from "./env";

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
    // NAT apart — device code + IP, not IP alone. Rides EVERY control call so
    // the most frequent one (the poll) keeps it fresh. See
    // `docs/proposals/daemon-device-aware-this-machine.md`.
    [DAEMON_DEVICE_ID_HEADER]: deviceId(),
    [DAEMON_DEVICE_LABEL_HEADER]: deviceLabel(),
  };
};

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
  const resp = await fetch(cloudUrl("/api/daemon/bootstrap"), {
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
 * Record one `public.requests` row for a subscription hop the daemon ran
 * locally. Best-effort: a recording failure must never fail the user's
 * request (the bytes already streamed back), so callers fire-and-forget.
 */
export const recordRequest = async (
  row: TDaemonRecordRequest,
  origin?: string | null,
): Promise<void> => {
  try {
    await fetch(cloudUrl("/api/daemon/requests", origin), {
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
    const resp = await fetch(cloudUrl("/api/daemon/search", origin), {
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
  const resp = await fetch(cloudUrl("/api/daemon/relay-credential"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ target_key: targetKey, sealed }),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new InvalidApiKeyError(resp.status);
  }
  if (!resp.ok) throw new Error(`relay-credential failed: ${resp.status}`);
};

/**
 * The daemon's control long-poll: `GET /api/daemon/poll`. Held open
 * server-side (~25s) until a command is queued for this key or the deadline
 * passes. The poll itself stamps presence cloud-side (the open poll IS the
 * "daemon online" signal). Throws `NoApiKeyError`/`InvalidApiKeyError` so the
 * loop can back off; pass an `AbortSignal` (timeout) so a stalled connection
 * is retried. See `docs/proposals/daemon-control-via-neon-longpoll.md`.
 */
export const pollControl = async (
  signal?: AbortSignal,
): Promise<TDaemonPollResponse> => {
  const resp = await fetch(cloudUrl("/api/daemon/poll"), {
    method: "GET",
    headers: authHeaders(),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new InvalidApiKeyError(resp.status);
  }
  if (!resp.ok) throw new Error(`control poll failed: ${resp.status}`);
  return (await resp.json()) as TDaemonPollResponse;
};

/**
 * Report the daemon's status to the cloud: `POST /api/daemon/status`.
 * Refreshes presence + the per-provider snapshot and acks executed
 * commands; `{ active: false }` is the graceful-exit beacon that flips the
 * key offline immediately. Best-effort — never throws into the caller.
 */
export const reportStatus = async (
  report: TDaemonStatusReport,
): Promise<void> => {
  try {
    await fetch(cloudUrl("/api/daemon/status"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(report),
    });
  } catch {
    // best-effort — presence also self-heals via the next poll / staleness
  }
};
