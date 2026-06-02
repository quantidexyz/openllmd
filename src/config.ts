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
 * model id → `provider_model_id` (catalog), the per-user plan-signing key,
 * and the cloud-state for `/status`. The fallback/binding/token-limit
 * fields ride along in the wire shape but are unused on the box.
 */

import type { TDaemonBootstrap, TDaemonCatalogEntry } from "@openllm/schema";
import {
  fetchBootstrap,
  InvalidApiKeyError,
  NoApiKeyError,
} from "./cloud-client";

const EMPTY: TDaemonBootstrap = {
  catalog: [],
  provider_prefixes: [],
  user_fallback_groups: [],
  user_model_fallback_bindings: [],
  default_fallback_groups: [],
  default_model_fallback_bindings: [],
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

export const getCloudState = (): TCloudState => cloudState;

/**
 * Refresh the cloud snapshot, recording the outcome in `cloudState`.
 * Never throws — classifies the failure instead so the control surface
 * and dashboard can react (the daemon stays up and serving on a stale /
 * empty snapshot regardless).
 */
export const refreshBootstrap = async (): Promise<void> => {
  try {
    snapshot = await fetchBootstrap();
    byModelId = new Map(snapshot.catalog.map((e) => [e.model_id, e]));
    cloudState = "ok";
  } catch (err) {
    if (err instanceof NoApiKeyError) cloudState = "no_key";
    else if (err instanceof InvalidApiKeyError) cloudState = "invalid_key";
    else cloudState = "unreachable";
  }
};

/**
 * The per-user key for verifying the cloud's `?__plan=` signature (handed
 * over at bootstrap). Null when the cloud has no signing secret configured
 * — the walker then accepts unsigned plans (dev). See `walker.ts`.
 */
export const planSigningKey = (): string | null =>
  snapshot.plan_signing_key ?? null;

/**
 * Look up a model id in the cached catalog → its `{ provider,
 * provider_model_id }` row. The walker uses this to resolve each `__plan`
 * hop to its concrete upstream model id (falling back to splitting the
 * `provider/model` pair when uncached).
 */
export const lookupCatalogEntry = (
  modelId: string,
): TDaemonCatalogEntry | null => byModelId.get(modelId) ?? null;
