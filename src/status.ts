/**
 * The daemon's status snapshot, computed in one place so the `/status`
 * one-shot endpoint and the `/events` SSE push share identical logic.
 *
 * Computing it spawns each delegate's `status()` (a CLI `--version` + an
 * auth/store read), so callers should not hammer it — the SSE watcher
 * recomputes on a gentle interval and only while a client is listening.
 */
import type { TDaemonStatus } from "@quantidexyz/openllmp";
import { autoUpdateEnabled } from "./auto-update-pref";
import { getCloudState } from "./config";
import { DELEGATES } from "./delegation";
import { getInstalledIntegrations } from "./device-state";
import { daemonPort, hasApiKey } from "./env";
import { isInstalling } from "./installing-state";
import { daemonPublicKey } from "./keypair";
import { logWarn } from "./logger";
import { sandboxState } from "./sandbox/landlock";
import { cachedUsage, peekUsage } from "./usage-cache";
import { DAEMON_VERSION } from "./version";

const computeStatusFresh = async (): Promise<TDaemonStatus> => {
  const connections = await Promise.all(
    Object.values(DELEGATES).map(async (d) => {
      try {
        const base = await d.status();
        // Surface an in-flight CLI install so the card shows "Installing…".
        const conn = isInstalling(d.slug)
          ? { ...base, installing: true }
          : base;
        // Attach a metadata-only usage snapshot for connected providers so the
        // dashboard can show remaining quota (read locally; never a token).
        if (!conn.connected) return conn;
        // PEEK only — never hit the vendor here. `computeStatus` runs on every
        // status push (hello/reconnect, the ~2.5s flow watcher, post-command),
        // and the vendor usage endpoint rate-limits independently of inference;
        // reading it on that cadence 429'd it ("Claude usage is rate-limited
        // right now") on a daemon nobody was even looking at. Usage is read ONLY
        // on demand — the `refresh` command → `refreshUsage` (the manual button
        // or the providers page mounting). Here we just attach whatever that last
        // on-demand read cached. See `usage-cache.ts`.
        const usage = peekUsage(d.slug);
        return usage === null ? conn : { ...conn, usage };
      } catch (err) {
        // One provider's status read must NOT sink the whole snapshot (every
        // card would vanish + the push would fail). Surface a safe placeholder;
        // the next push self-corrects once the provider recovers.
        logWarn("status", `status() failed for ${d.slug}`, {
          err: err instanceof Error ? err.message : String(err),
        });
        return {
          provider: d.slug,
          connected: false,
          cli_installed: false,
          detail: "status check failed",
        };
      }
    }),
  );
  return {
    daemon_version: DAEMON_VERSION,
    key_configured: hasApiKey(),
    auto_update: autoUpdateEnabled(),
    cloud_state: getCloudState(),
    pubkey: daemonPublicKey(),
    port: daemonPort(),
    sandbox: sandboxState(),
    connections,
    // Cached manifest-driven device state (refreshed by the `-s` walk on boot
    // + after install/uninstall + on refresh), NOT a live scan — the walk is
    // too heavy to run on every status push.
    integrations: getInstalledIntegrations(),
  };
};

let inFlightStatus: Promise<TDaemonStatus> | null = null;

export const computeStatus = async (): Promise<TDaemonStatus> => {
  if (inFlightStatus === null) {
    inFlightStatus = computeStatusFresh().finally(() => {
      inFlightStatus = null;
    });
  }
  return inFlightStatus;
};

/**
 * On-demand usage read — the ONLY path that hits the vendor usage endpoint.
 * Driven by the `refresh` command (the manual "Refresh usage" button or the
 * providers page mounting for this device, via `control-relay.ts`). Fetches
 * figures for every CONNECTED provider (or just `slug` when scoped) into the
 * usage cache; the status push that follows the command then carries them back
 * via `peekUsage`. RESPECTS each provider's TTL — `cachedUsage` serves a
 * still-fresh snapshot from cache (no vendor hit) and only re-fetches a stale or
 * never-fetched one, so a whole-daemon refresh after one login doesn't re-hit
 * every vendor. Best-effort per provider — `cachedUsage` already swallows fetch
 * failures into an `unavailable` snapshot.
 */
export const refreshUsage = async (slug?: string): Promise<void> => {
  // `allSettled`, NOT `all`: ONE provider throwing (e.g. a failing status/refresh
  // read) must not reject the whole refresh — that would error the `refresh`
  // command ack, so the dashboard's "Refresh usage" button would fail and every
  // card stay stale just because a single provider is broken. Each provider's
  // read is independent + best-effort (`cachedUsage` already swallows fetch
  // failures into an `unavailable` snapshot).
  await Promise.allSettled(
    Object.values(DELEGATES)
      .filter((d) => slug === undefined || d.slug === slug)
      .map(async (d) => {
        // Only connected providers have a usage endpoint to read.
        if (!(await d.status()).connected) return;
        await cachedUsage(d.slug, () => d.usage());
      }),
  );
};
