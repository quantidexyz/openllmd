/**
 * Runtime config + catalog cache.
 *
 * The daemon does NOT compile the model catalog or routing config in — it
 * pulls a single bootstrap snapshot from the cloud
 * (`GET /api/daemon/bootstrap`) and refreshes on a TTL. This keeps the
 * binary's dependency closure to core + schema + effect (no
 * `@openllm/api`, no db) and lets config update without recompiling.
 *
 * The walker makes ZERO routing decisions (the cloud resolved the chain
 * and 307'd it as `?__plan=`), so the daemon only needs from the snapshot:
 * model id → `provider_model_id` (catalog), per-model `output_token_limit`
 * (raise-only max-tokens backfill on alias hops), the per-user
 * plan-signing key, and the cloud-state for `/status`. Fallback/binding
 * fields ride along in the wire shape but are unused on the box.
 */

import type {
  TContextOverflowStrategy,
  TDaemonBootstrap,
  TDaemonCatalogEntry,
  TDaemonReportingPolicy,
  TSubMethod,
} from "@openllmsh/protocol";
import { resolveContextOverflowStrategy } from "@openllmsh/wire";
import {
  fetchBootstrap,
  InvalidApiKeyError,
  NoApiKeyError,
  publishIdentity,
} from "./cloud-client";
import { setDeviceAccessPubkey } from "./device-access-verify";
import { daemonApiKeyId } from "./env";
import { loadIdentityKey } from "./keypair";
import { clearPlanCache } from "./plan-cache";

const EMPTY: TDaemonBootstrap = {
  catalog: [],
  provider_prefixes: [],
  user_fallback_groups: [],
  user_model_fallback_bindings: [],
};

/**
 * Outcome of the last bootstrap attempt — surfaced on `GET /status` so
 * the dashboard knows whether to show the API-key picker (`no_key` /
 * `invalid_key`), a retry hint (`unreachable`), or the provider cards
 * (`ok`).
 */
export type TCloudState = "ok" | "no_key" | "invalid_key" | "unreachable";

let snapshot: TDaemonBootstrap = EMPTY;
let byModelId: Map<string, TDaemonCatalogEntry> = new Map();
let cloudState: TCloudState = "no_key";
let reportingPolicyRevision = 0;

/** Started refresh revision, used to fence delayed diagnostics callbacks. */
export const getReportingPolicyRevision = (): number => reportingPolicyRevision;

export const getCloudState = (): TCloudState => cloudState;

/** Last bootstrap reporting policy. Absent/old clouds → null (upload off). */
export const getReportingPolicy = (): TDaemonReportingPolicy | null =>
  snapshot.reporting_policy ?? null;

/** Test-only: inject bootstrap reporting policy without a cloud fetch. */
export const setReportingPolicyForTests = (
  policy: TDaemonReportingPolicy | null,
): void => {
  reportingPolicyRevision += 1;
  snapshot = {
    ...snapshot,
    ...(policy === null
      ? { reporting_policy: undefined }
      : { reporting_policy: policy }),
  };
};

/**
 * Refresh the cloud snapshot, recording the outcome in `cloudState`.
 * Never throws — classifies the failure instead so the control surface
 * and dashboard can react (the daemon stays up and serving on a stale /
 * empty snapshot regardless).
 *
 * Returns `true` when `cloudState` CHANGED, so the caller can re-push the
 * daemon's status: a transient boot-time `unreachable` that recovers to `ok`
 * on the next retry must surface immediately, not wait for the next command
 * (otherwise the dashboard shows "can't reach the cloud" indefinitely even
 * though everything is working — the bug this fixes).
 */
export const refreshBootstrap = async (): Promise<boolean> => {
  const prev = cloudState;
  const reportingRevision = ++reportingPolicyRevision;
  try {
    const next = await fetchBootstrap();
    if (reportingRevision !== reportingPolicyRevision) return false;
    snapshot = next;
    byModelId = new Map(snapshot.catalog.map((e) => [e.model_id, e]));
    cloudState = "ok";
    void import("./doctor-report")
      .then((m) => m.onBootstrapReportingPolicy(reportingRevision))
      .catch(() => {});
    // A fresh snapshot may carry new routing config — drop any cached signed
    // plans so a stale chain never outlives the config that produced it.
    clearPlanCache();
    // Pin the seed-gated device-access verifier when the cloud includes it.
    // Explicit null clears a previous pin (key un-provisioned / wiped).
    // Absent (older cloud) leaves the last-known pin alone so a rolling
    // deploy cannot silently drop enforcement.
    if (snapshot.device_access_pubkey !== undefined) {
      setDeviceAccessPubkey(snapshot.device_access_pubkey);
    }
    // Best-effort: publish the durable X25519 pin on every successful
    // bootstrap so cold dashboards / fleet peers pin via the cloud path
    // (not solely relay status_push). Isolated from cloudState — a local
    // keypair/construction failure must not flip a successful bootstrap
    // to "unreachable".
    try {
      // R5: publish ONLY a key that reached disk. The cloud pin is write-once,
      // so pinning an in-memory key that a failed write never persisted means
      // the next boot generates a different key and 409s forever — a transient
      // full disk becomes a permanent wedge. Skipping leaves no pin, and the
      // next boot pins cleanly. `keypair.ts` already logged the errno.
      // Fire-and-forget: a slow POST must not hold bootstrap. Sync throws from
      // loadIdentityKey still land in this catch (must not flip cloudState).
      const identity = loadIdentityKey();
      if (identity.persisted) {
        void publishIdentity(identity.publicKeyB64).catch(() => {});
      }
    } catch {
      // swallow — identity pin is non-critical hardening
    }
  } catch (err) {
    if (reportingRevision !== reportingPolicyRevision) return false;
    if (err instanceof NoApiKeyError) cloudState = "no_key";
    else if (err instanceof InvalidApiKeyError) cloudState = "invalid_key";
    else cloudState = "unreachable";
  }
  return cloudState !== prev;
};

/**
 * The per-user key for verifying the cloud's `?__plan=` signature (handed
 * over at bootstrap). Null when the cloud has no signing secret configured
 * — the walker then accepts unsigned plans (dev). See `walker.ts`.
 */
export const planSigningKey = (): string | null =>
  snapshot.plan_signing_key ?? null;

/** Per-user context-overflow policy from bootstrap; absence preserves hopping. */
export const contextOverflowStrategy = (): TContextOverflowStrategy =>
  resolveContextOverflowStrategy(snapshot.context_overflow_strategy);

/**
 * The cloud's resolved `ACTIVE_SUB_METHOD` preference from the last
 * bootstrap (`bridge` | `handrolled` | null = no preference). The daemon
 * NEVER reads an `ACTIVE_SUB_METHOD` env of its own — this snapshot field
 * is the only source; a daemon that has never bootstrapped has no
 * preference, and a stale snapshot keeps the last-known value. Sampled
 * once per hop at selection time (`sub-method.ts`) so it never switches
 * mid-hop. See `docs/proposals/active-sub-method.md`.
 */
export const activeSubMethod = (): TSubMethod | null =>
  snapshot.active_sub_method ?? null;

/**
 * Per-provider overrides layered on top of `activeSubMethod` (from the
 * same bootstrap snapshot — `provider:method` entries in the cloud's
 * `ACTIVE_SUB_METHOD` env). Empty when the cloud sent none / predates the
 * field. Sampled together with the global preference once per request so
 * a mid-walk bootstrap refresh never switches a hop.
 */
export const activeSubMethodOverrides = (): Readonly<
  Record<string, TSubMethod>
> => snapshot.active_sub_methods ?? {};

/**
 * Cloud-controlled opt-in for the daemon's signed-plan cache (default off —
 * absent on older clouds keeps the rider inert). See `plan-cache.ts`.
 */
export const planCacheEnabled = (): boolean => snapshot.plan_cache === true;

/**
 * The fleet-peer key id serving `provider` (subscription tunnel — feature
 * §1), from the last bootstrap. Null when no online fleet daemon serves it
 * (or the cloud predates the field), or when a stale cloud snapshot names this
 * daemon's own key — local serving is handled separately and must not tunnel
 * back to itself.
 */
export const fleetSubscriptionServerFor = (provider: string): string | null => {
  const keyId =
    snapshot.fleet_subscriptions?.find((f) => f.provider === provider)
      ?.key_id ?? null;
  return keyId === daemonApiKeyId() ? null : keyId;
};

/** Serving daemon X25519 pubkey for a fleet peer, when its bootstrap status supplied one. */
export const fleetSubscriptionPubkeyFor = (keyId: string): string | null =>
  snapshot.fleet_subscriptions?.find((f) => f.key_id === keyId)?.pubkey ?? null;

/**
 * The daemon version the cloud currently publishes (bare semver), from the last
 * bootstrap. Null when unpublished or the cloud is too old to advertise it. The
 * self-updater compares it to `DAEMON_VERSION`. See `self-update.ts`.
 */
export const latestVersion = (): string | null =>
  snapshot.latest_version ?? null;

/**
 * The `openllm` CLI version the cloud currently publishes (bare semver),
 * from the last bootstrap. Null when unpublished or the cloud is too old to
 * advertise it. The CLI converger compares it to the installed binary's
 * version. See `cli-self-update.ts`.
 */
export const latestCliVersion = (): string | null =>
  snapshot.latest_cli_version ?? null;

/**
 * Look up a model id in the cached catalog → its `{ provider,
 * provider_model_id }` row. The walker uses this to resolve each `__plan`
 * hop to its concrete upstream model id (falling back to splitting the
 * `provider/model` pair when uncached).
 */
export const lookupCatalogEntry = (
  modelId: string,
): TDaemonCatalogEntry | null => byModelId.get(modelId) ?? null;

/**
 * Test seam: pin the in-memory catalog the walker resolves hops against.
 * Production never calls this — bootstrap is the only writer.
 */
export const setCatalogForTest = (
  catalog: ReadonlyArray<TDaemonCatalogEntry>,
): void => {
  snapshot = { ...EMPTY, catalog: [...catalog] };
  byModelId = new Map(snapshot.catalog.map((e) => [e.model_id, e]));
};
