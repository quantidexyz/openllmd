import type {
  TDaemonProviderConnection,
  TProviderModelEntry,
  TProviderUsageSnapshot,
} from "@openllmsh/protocol";
import type { TRefreshErrorClass } from "./refresh";

/**
 * A provider delegate wraps ONE official vendor CLI (Claude Code, Codex,
 * Kimi CLI). It is the only thing in the daemon that touches a
 * subscription credential — and it does so via the official CLI's own
 * store + identity, never by minting/forging/exporting a token.
 *
 * The bright line (proposal §6): nothing a delegate reads from the CLI's
 * store may be returned off-box. `usage()` returns a metadata-only
 * snapshot; `credentialForUpstream()` is consumed locally by the runner
 * and never serialized to the cloud.
 */
/**
 * Credential + target for one image-generation upstream call — the same
 * locally-used shape as `credentialForUpstream`'s return. The daemon injects
 * the bearer + identity headers for a single request.
 */
export type TImageCredential = {
  readonly access_token: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
  readonly account_hash?: string;
  /**
   * Set when the native refresh settled stale; image and video walkers cool
   * the hop instead of serving the expired token, matching chat.
   */
  readonly stale_refresh?: TRefreshErrorClass;
};

/**
 * Options for automatic (no-renewal) model discovery. `cliVersion` is a
 * previously observed / cached CLI version — never probed here.
 */
export type TModelDiscoveryOptions = {
  readonly cliVersion?: string;
};

/**
 * Distinct from `listModels`: `skipped` means no usable existing credential
 * (retry after a later successful request); `failed` means an HTTP/list
 * attempt actually ran and failed (backoff). Auto callers must not share
 * `listModels`, which is refresh-capable.
 */
export type TModelDiscoveryResult =
  | {
      readonly kind: "success";
      readonly models: ReadonlyArray<TProviderModelEntry>;
    }
  | { readonly kind: "skipped" }
  | { readonly kind: "failed" };

export type TProviderDelegate = {
  readonly slug: string;

  /** Current connection state for the status snapshot (`cli_installed`).
   *  HTTP `GET /status` is `buildHealth` and does not call this. */
  status: (signal?: AbortSignal) => Promise<TDaemonProviderConnection>;

  /**
   * Drop a TTL'd NONSECRET status observation (presence/account hint, never
   * credentials). Inference auth failures and login/logout/refresh call this
   * so the next status tick re-reads the store. Absent = no observation cache.
   */
  invalidateStatusObservation?: () => void;

  /**
   * Whether this delegate's `status()` honours the optional `AbortSignal`.
   * Required so a new provider cannot silently land in the wrong timeout
   * bucket. `true` means aborting the observer actually cancels the probe;
   * `false` means the probe ignores the signal (timing out is "we stopped
   * waiting", not "we cancelled them"). Do not thread a signal into a
   * `false` implementation without the observer-sharing invariant: aborting
   * one waiter must not kill another waiter's in-flight probe.
   */
  readonly statusCancellable: boolean;

  /**
   * Trigger the official CLI's NATIVE login locally (no OpenLLM OAuth).
   * Returns once the CLI reports a terminal state — EXCEPT Kimi's
   * device-code flow, which returns `pending: true` (browser opened,
   * daemon polling in the background) and resolves via the status stream.
   * We never receive the token — it lands in the CLI's own store.
   */
  connect: () => Promise<{
    connected: boolean;
    detail?: string;
    pending?: boolean;
  }>;

  /**
   * Login for a REMOTE/headless box, surfacing an authorize URL via
   * pending-auth → status so the user authorizes in THEIR browser:
   *   - codex: the vendor's device-code flow (URL + one-time code, background
   *     poll completes it);
   *   - kimi: its only login, already device-code;
   *   - claude: a headless paste-back login — the URL is the hosted-callback
   *     one and the user pastes the code it shows back via `submitLoginCode`.
   * Absent on providers without a headless flow.
   */
  connectDeviceCode?: () => Promise<{
    connected: boolean;
    detail?: string;
    pending?: boolean;
  }>;

  /**
   * Feed a pasted authorization code into an in-flight headless login (claude
   * only): the daemon writes it to the waiting `claude auth login` stdin, which
   * exchanges it with its in-process PKCE verifier. `ok:false` (e.g. an invalid
   * code) leaves the flow ALIVE for a retry; `ok:true` means the credential
   * landed. Absent on providers whose remote login self-completes (codex/kimi
   * device-code poll in the background).
   */
  submitLoginCode?: (code: string) => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;

  /**
   * Abort an IN-FLIGHT login (device-code or browser): kill the spawned vendor
   * process / stop the background token poll and clear this provider's
   * `pending_auth`, so the card drops out of "Awaiting authorization" back to
   * Not signed in. Idempotent — no in-flight flow is success. Absent on
   * providers whose `connect` is fully synchronous (nothing to cancel). When
   * absent, the control relay clears `pending_auth` directly as a fallback.
   */
  cancelConnect?: () => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;

  /**
   * Read this provider's usage locally using the official CLI's own
   * credential + identity. Metadata only.
   */
  usage: () => Promise<TProviderUsageSnapshot>;

  /**
   * Fetch the vendor's LIVE model list using the official CLI's own
   * credential (e.g. Kimi's `GET /coding/v1/models`). Metadata only —
   * model ids + optional display/context data, reported to the cloud's
   * `POST /api/daemon/models` so `/v1/models` reflects what this
   * subscription actually serves (live-provider-model-catalog proposal
   * §4). Absent on providers without a listing endpoint (they keep the
   * static-catalog fallback). Returns `null` on any failure — never an
   * empty list.
   */
  listModels?: () => Promise<ReadonlyArray<TProviderModelEntry> | null>;

  /**
   * Automatic model discovery: existing unexpired credential only, no
   * refresh/CLI/version/identity mint/config write/endpoint capture. Returns
   * `skipped` when there is no usable stored credential or required cached
   * metadata; `failed` only after a real list attempt; `success` never with
   * an empty list (empty/null fetch is `failed` so a cache is not wiped).
   */
  discoverModels?: (
    options: TModelDiscoveryOptions,
  ) => Promise<TModelDiscoveryResult>;

  /**
   * Whether ONE model accepts a configurable `reasoning.effort` on this
   * provider's wire, read from the vendor's live model list (grok's
   * `/v1/models` rows carry `supports_reasoning_effort`; only current
   * flagship models set it — the partner client strips the param for the
   * rest, and so does the walker). `null` = unknown (row missing, list
   * unreachable, or field absent) — the walker then leaves the request
   * untouched. Absent on providers whose wire has no such per-model gate.
   */
  supportsReasoningEffort?: (
    providerModelId: string,
  ) => Promise<boolean | null>;

  /**
   * JSON-Schema keywords this provider's endpoint REJECTS in tool
   * `parameters` (xAI: `minContains`/`maxContains`). The walker strips them
   * recursively from every tool schema before the upstream call. Absent =
   * forward schemas verbatim.
   */
  readonly unsupportedToolSchemaKeywords?: ReadonlyArray<string>;

  /**
   * When true, the walker rewrites every tool `parameters` schema so local
   * definitions `$ref`s point at `#/$defs/…` (`#/definitions/…` → `#/$defs/…`;
   * `definitions` map → `$defs`) before the upstream call. Kimi/Moonshot's
   * endpoint 400s any other ref base ("references must start with #/$defs/").
   * Applied after keyword stripping. Absent/false = forward refs verbatim. See
   * docs/proposals/kimi-tool-schema-ref-normalization.md.
   */
  readonly normalizesToolSchemaRefs?: boolean;

  /**
   * Produce, for ONE inference call: the bearer (from the official CLI's store),
   * the request TARGET `url` (captured from a real CLI request, or the default),
   * and only the CREDENTIAL-INTRINSIC `headers` — the small set the request can't
   * work without and that is genuinely the user's own (e.g. chatgpt's
   * `chatgpt-account-id`). The walker layers the ORIGINATOR's own headers
   * underneath and the wire-derived headers on top, so a genuine vendor-CLI
   * request reaches the vendor verbatim. Used ONLY by the local runner; never
   * leaves the machine.
   *
   * `inbound` is the originator's own request headers, so a delegate can tell
   * whether the caller ALREADY presents the vendor CLI's identity and only fill
   * in what's missing (chatgpt does this: some models are gated on a
   * `codex_cli_rs` originator + user-agent). A delegate that needs no such
   * backfill ignores it.
   */
  credentialForUpstream: (inbound?: Headers) => Promise<{
    readonly access_token: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly url: string;
    /**
     * `account_hash` of the credential serving THIS hop (same digest the
     * status frame reports — `account-id.ts`), stamped onto the recorded
     * request row so the cloud's usage-calibration estimator attributes
     * the cost to the right meter series. Derived from the same token
     * that serves the request, so it tracks a mid-session account switch
     * where a status cache would not. Absent when the stable id is
     * unreadable.
     */
    readonly account_hash?: string;
    /**
     * Present when `readToken` kept an expired token after a stale native
     * refresh. The walker cools the hop BEFORE any upstream fetch.
     */
    readonly stale_refresh?: TRefreshErrorClass;
  }>;

  /**
   * Produce a credential for the provider's image-generation endpoint. The
   * daemon uses it only locally, just like `credentialForUpstream`.
   */
  credentialForImage?: (inbound?: Headers) => Promise<TImageCredential>;

  /**
   * Produce a credential for the provider's video-generation API base. The
   * daemon uses it only locally, just like `credentialForImage`.
   */
  credentialForVideo?: (inbound?: Headers) => Promise<TImageCredential>;

  /**
   * Sign out of the official CLI's LOGIN credential on this box: run the
   * vendor's own logout (revoking server-side where it supports it) and/or
   * clear the isolated store. Idempotent: already-signed-out is success.
   * Returns `ok:false` only if a credential survives the attempt.
   */
  logout: () => Promise<{ readonly ok: boolean; readonly detail?: string }>;
};
