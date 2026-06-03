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
import { hasApiKey } from "./env";
import { daemonPublicKey } from "./keypair";
import { DAEMON_VERSION } from "./version";

export const computeStatus = async (): Promise<TDaemonStatus> => {
  const connections = await Promise.all(
    Object.values(DELEGATES).map(async (d) => {
      const conn = await d.status();
      // Attach a metadata-only usage snapshot for connected providers so the
      // dashboard can show remaining quota (read locally; never a token).
      if (!conn.connected) return conn;
      try {
        return { ...conn, usage: await d.usage() };
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
    connections,
  };
};
