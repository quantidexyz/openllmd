/**
 * The daemon's status snapshot, computed in one place so the `/status`
 * one-shot endpoint and the `/events` SSE push share identical logic.
 *
 * Computing it spawns each delegate's `status()` (a CLI `--version` + an
 * auth/store read), so callers should not hammer it — the SSE watcher
 * recomputes on a gentle interval and only while a client is listening.
 */
import type { TDaemonStatus } from "@openllm/schema";
import { getCloudState } from "./config";
import { DELEGATES } from "./delegation";
import { daemonPort, hasApiKey } from "./env";
import { isInstalling } from "./installing-state";
import { daemonPublicKey } from "./keypair";
import { cachedUsage } from "./usage-cache";
import { DAEMON_VERSION } from "./version";

export const computeStatus = async (): Promise<TDaemonStatus> => {
  const connections = await Promise.all(
    Object.values(DELEGATES).map(async (d) => {
      const base = await d.status();
      // Surface an in-flight CLI install so the card shows "Installing…".
      const conn = isInstalling(d.slug) ? { ...base, installing: true } : base;
      // Attach a metadata-only usage snapshot for connected providers so the
      // dashboard can show remaining quota (read locally; never a token).
      if (!conn.connected) return conn;
      // A setup-token connection (claude_code) can't reliably query the vendor
      // usage endpoint — it 429s — and the panel is optional, so skip it for
      // that mode. CLI-login usage is unaffected.
      if (conn.auth_mode === "setup_token") return conn;
      // Read through the per-provider TTL cache, NOT live: `computeStatus`
      // runs on every status push (~30s, ~2.5s during a flow), but the vendor
      // usage endpoints rate-limit independently of inference — a live read
      // here 429s after ~5 min while inference keeps working. The cache hits
      // the vendor at most once per few minutes and serves the last good
      // snapshot if a refresh fails. See `usage-cache.ts`.
      try {
        return { ...conn, usage: await cachedUsage(d.slug, () => d.usage()) };
      } catch {
        return conn; // usage read failed — status still useful
      }
    }),
  );
  return {
    daemon_version: DAEMON_VERSION,
    key_configured: hasApiKey(),
    cloud_state: getCloudState(),
    pubkey: daemonPublicKey(),
    port: daemonPort(),
    connections,
  };
};
