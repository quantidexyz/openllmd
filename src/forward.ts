/**
 * Forward an API-key hop to the cloud `/v1/*` surface.
 *
 * In a MIXED chain (some subscription hops, some API-key BYOK hops), the
 * whole session runs on the daemon — but the daemon holds no DEK and must
 * not decrypt a vault credential. So an API-key hop is proxied to the
 * cloud, which decrypts via the zero-knowledge vault, runs it, and logs
 * it exactly as today. The daemon just streams the cloud's response back
 * to the local client.
 *
 * Authenticated with the user's `sk-llm-...` key — the same key the cloud
 * already validates for `/v1/*`.
 */
import { daemonEnv } from "./env";

/**
 * Proxy one inbound request to the cloud `/v1/*` surface verbatim,
 * pinning the model to the API-key hop the local chain selected. Streams
 * the upstream response through unchanged (status + headers + body).
 */
export const forwardToCloud = async (
  inbound: Request,
  bodyBytes: ArrayBuffer,
  pinnedModel: string,
  origin?: string | null,
): Promise<Response> => {
  const url = new URL(inbound.url);
  // Forward to the deployment that ISSUED the 307 (`?__origin=`, signed) so a
  // single daemon serves any deployment; fall back to the pinned cloud origin
  // for older/unsigned redirects. Drop the inbound query — the only params
  // here are the daemon's own `?__plan=`/`?__sig=`/… (off the 307), which the
  // cloud `/v1` surface never reads (it selects via `x-openllm-pin-model`).
  const base =
    origin !== undefined && origin !== null && origin.length > 0
      ? origin.replace(/\/+$/, "")
      : daemonEnv().cloudOrigin;
  const target = `${base}${url.pathname}`;
  const headers = new Headers(inbound.headers);
  headers.set("authorization", `Bearer ${daemonEnv().apiKey}`);
  // Lock the cloud to the exact concrete model the local chain picked, so
  // the cloud doesn't re-run its own alias/fallback resolution.
  headers.set("x-openllm-pin-model", pinnedModel);
  headers.delete("host");
  headers.delete("content-length");

  return fetch(target, {
    method: inbound.method,
    headers,
    body: bodyBytes,
    signal: inbound.signal,
  });
};
