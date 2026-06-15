import type {
  TDaemonProviderConnection,
  TProviderUsageSnapshot,
} from "@quantidexyz/openllmp";

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
export type TProviderDelegate = {
  readonly slug: string;

  /** Current connection state for `GET /status` (includes `cli_installed`). */
  status: () => Promise<TDaemonProviderConnection>;

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
   * Obtain a long-lived SETUP-TOKEN via the official CLI's own flow (Claude
   * Code only: `claude setup-token` — a browser login that mints a portable
   * `sk-ant-oat01-` token), then store it on the box. Same shape + browser
   * mechanics as `connect` (loopback-forwarded for a remote box); the token
   * is captured locally and never crosses the cloud. Absent on providers
   * without a setup-token flow (chatgpt/kimi use device-code).
   */
  connectSetupToken?: () => Promise<{
    connected: boolean;
    detail?: string;
    pending?: boolean;
  }>;

  /**
   * Remote-copy mint (Claude only): run the setup-token flow in the user's
   * browser on THIS machine and RETURN the captured token so the caller can
   * seal it to a remote daemon's key and relay the ciphertext. Does NOT store
   * it locally (this box isn't the one being authenticated).
   */
  mintSetupToken?: () => Promise<{ token: string } | { error: string }>;

  /**
   * Device-code login for a REMOTE/headless box (codex; kimi uses its only
   * login which is already device-code): start the vendor's device flow,
   * surface the verification URL + one-time code (via pending-auth → status)
   * so the user authorizes in THEIR browser, and let it complete in the
   * background. Absent on providers without a device-code flow.
   */
  connectDeviceCode?: () => Promise<{
    connected: boolean;
    detail?: string;
    pending?: boolean;
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
   * Produce, for ONE inference call: the bearer (from the official CLI's store),
   * the request TARGET `url` (captured from a real CLI request, or the default),
   * and only the CREDENTIAL-INTRINSIC `headers` — the small set the request can't
   * work without and that is genuinely the user's own (e.g. chatgpt's
   * `chatgpt-account-id`), NOT a synthesized CLI identity. The walker layers the
   * ORIGINATOR's own headers underneath and the wire-derived headers on top, so
   * a genuine vendor-CLI request reaches the vendor verbatim. Used ONLY by the
   * local runner; never leaves the machine.
   */
  credentialForUpstream: () => Promise<{
    readonly access_token: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly url: string;
  }>;

  /**
   * Sign out of the official CLI's LOGIN credential on this box: run the
   * vendor's own logout (revoking server-side where it supports it) and/or
   * clear the isolated store. Does NOT touch an on-box setup-token (that's
   * cleared separately) — they're independent credential sources. Idempotent:
   * already-signed-out is success. Returns `ok:false` only if a credential
   * survives the attempt.
   */
  logout: () => Promise<{ readonly ok: boolean; readonly detail?: string }>;
};
