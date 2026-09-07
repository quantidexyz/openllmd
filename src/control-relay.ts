/**
 * The daemon's command executor — the kind→handler mapping for every control
 * command (connect / integration / login-code / auto-update / …).
 *
 * It is transport-agnostic: the WebSocket control channel (`control-channel.ts`)
 * pulls a command off the relay socket, runs it through `runCommandInner`, and
 * acks + pushes a fresh status snapshot back over the same socket. There is no
 * long-poll anymore — the relay socket is the daemon's only control transport.
 */

import type {
  TDaemonCommand,
  TDaemonCommandAck,
  TLocalCliSession,
} from "@openllmsh/protocol";
import { autoUpdateEnabled, setAutoUpdate } from "./auto-update-pref";
import { maybeUpdateCli } from "./cli-self-update";
import { latestCliVersion, latestVersion, refreshBootstrap } from "./config";
import { getDelegate } from "./delegation";
import {
  runWithAuthOperation,
  runWithLoginCommand,
} from "./delegation/login-flow";
import { daemonApiKeyId } from "./env";
import { openSealed } from "./keypair";
import { clampLimit, readLocalSessions } from "./local-sessions";
import { logError } from "./logger";
import { maybeReportModels, resetModelReportThrottle } from "./model-report";
import { clearPendingAuth } from "./pending-auth";
import { clearPlanCache } from "./plan-cache";
import { maybeSelfUpdate } from "./self-update";
import { deviceSessionsForList } from "./session-host";
import {
  clearProviderSignedOut,
  markProviderSignedOut,
  refreshUsage,
} from "./status";
import { invalidateUsage } from "./usage-cache";

/** Short TTL so picker double-fetch / remounts do not re-scan vendor stores. */
const LIST_LOCAL_SESSIONS_TTL_MS = 1_500;

const listLocalSessionsCache = new Map<
  string,
  { readonly at: number; readonly sessions: TLocalCliSession[] }
>();

/**
 * Execute one delivered command via the control handlers. Returns the terminal
 * ack. `cmd` is the CLOSED `DaemonCommand` union — the relay socket's schema
 * decode already rejected unknown kinds and out-of-vocabulary payloads, so
 * each `case` narrows to its exact typed payload (no hand-cast). The delegate
 * null-checks stay as belt-and-braces for any non-wire caller.
 */
export const runCommandInner = async (
  cmd: TDaemonCommand,
): Promise<TDaemonCommandAck> => {
  try {
    switch (cmd.kind) {
      case "connect": {
        const delegate = getDelegate(cmd.payload.slug);
        if (delegate === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        const r = await runWithLoginCommand(
          { flowId: cmd.id, keyId: daemonApiKeyId() ?? "local" },
          () => delegate.connect(),
        );
        // A login that just landed is the freshest moment to report this
        // provider's live model list to the cloud's model cache. Clear
        // THIS slug's throttle first — pre-login attempts stamped it
        // with a failure backoff, and a fresh credential must report
        // immediately. Fire-and-forget — never delays the ack.
        if (r.connected) {
          clearProviderSignedOut(cmd.payload.slug);
          invalidateUsage(cmd.payload.slug);
        }
        // Model catalog: `auth.login.succeeded` (observeLoginModelReports),
        // not this ack — pending logins land later; r.connected can race a
        // stale unknown probe. Duplicate immediate report is avoided there.
        // A connect that neither landed a credential NOR opened a pending flow
        // is a FAILURE (e.g. cursor's `cursor-agent login` printed no auth URL
        // on a remote box). Ack `error` — mirroring `connect_device_code` — so
        // the relay routes a real `command_lifecycle` error to the originating
        // watcher and the dashboard surfaces the delegate's `detail` instead of
        // a silent "done" with no dialog (issue #2).
        return {
          id: cmd.id,
          status: r.connected || r.pending === true ? "done" : "error",
          result: r,
        };
      }
      case "connect_device_code": {
        // Start a device-code login (codex remote; kimi falls back to its
        // normal device-code `connect`). Surfaces the URL+code via status.
        const delegate = getDelegate(cmd.payload.slug);
        if (delegate === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        const r = await runWithLoginCommand(
          { flowId: cmd.id, keyId: daemonApiKeyId() ?? "local" },
          () =>
            delegate.connectDeviceCode !== undefined
              ? delegate.connectDeviceCode()
              : delegate.connect(),
        );
        if (r.connected) {
          clearProviderSignedOut(cmd.payload.slug);
          invalidateUsage(cmd.payload.slug);
        }
        return {
          id: cmd.id,
          status: r.connected || r.pending === true ? "done" : "error",
          result: r,
        };
      }
      case "cancel_connect": {
        // Abort an in-flight device-code / browser login: the delegate kills
        // its spawned process / stops its background poll and clears the
        // pending code. Fall back to clearing the daemon's in-memory
        // `pending_auth` directly for a provider whose `connect` is synchronous
        // (no `cancelConnect`) — there's no live flow, so dropping a stale code
        // is the whole job. The post-command status push (with the cleared
        // `pending_auth`) flips the card back to Not signed in.
        const delegate = getDelegate(cmd.payload.slug);
        if (delegate === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        const cancelConnect = delegate.cancelConnect;
        if (cancelConnect !== undefined) {
          const r = await runWithLoginCommand(
            { flowId: cmd.id, keyId: daemonApiKeyId() ?? "local" },
            () => cancelConnect(),
          );
          return { id: cmd.id, status: r.ok ? "done" : "error", result: r };
        }
        clearPendingAuth(cmd.payload.slug);
        return { id: cmd.id, status: "done", result: { ok: true } };
      }
      case "logout": {
        // Sign out of a subscription provider's CLI-LOGIN credential on this
        // daemon (per-key: the cloud delivered this only to the target key).
        const delegate = getDelegate(cmd.payload.slug);
        if (delegate === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        // Sticky signed_out at command receipt — before the (possibly slow)
        // `delegate.logout()` — so interleaved status ticks never produce a
        // `connected → disconnected` edge.
        markProviderSignedOut(cmd.payload.slug);
        let r: Awaited<ReturnType<typeof delegate.logout>>;
        try {
          r = await runWithAuthOperation(cmd.payload.slug, () =>
            delegate.logout(),
          );
        } catch (err) {
          clearProviderSignedOut(cmd.payload.slug);
          throw err;
        }
        if (r.ok) invalidateUsage(cmd.payload.slug);
        else clearProviderSignedOut(cmd.payload.slug);
        return { id: cmd.id, status: r.ok ? "done" : "error", result: r };
      }
      case "submit_login_code": {
        // TARGET (remote) daemon: open the sealed OAuth authorization code the
        // user pasted from the hosted callback page and feed it into the
        // in-flight headless `claude auth login` (paste-back). The code is
        // single-use + PKCE-bound; the cloud relayed only ciphertext.
        const delegate = getDelegate(cmd.payload.slug);
        if (delegate?.submitLoginCode === undefined) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "submit_login_code: unsupported provider" },
          };
        }
        const code = openSealed(cmd.payload.sealed);
        if (code === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "could not open sealed login code" },
          };
        }
        const submitLoginCode = delegate.submitLoginCode;
        const r = await runWithLoginCommand(
          { flowId: cmd.id, keyId: daemonApiKeyId() ?? "local" },
          () => submitLoginCode(code),
        );
        if (r.ok) {
          clearProviderSignedOut(cmd.payload.slug);
          invalidateUsage(cmd.payload.slug);
        }
        return { id: cmd.id, status: r.ok ? "done" : "error", result: r };
      }
      // The on-demand usage read. The demand is the manual "Refresh usage"
      // button OR the providers page mounting for this device — this is the
      // ONLY path that hits the vendor usage endpoint (the background status
      // push only PEEKS the cache; see `status.ts`). `slug` scopes it to one
      // provider; the dashboard's whole-daemon refresh sends none → all.
      case "refresh":
        // Fetch the connected providers' usage into the cache, RESPECTING each
        // provider's TTL: `refreshUsage` → `cachedUsage` serves a still-fresh
        // snapshot from cache (no vendor hit) and only re-fetches a STALE or
        // never-fetched one. We deliberately do NOT bust the cache first —
        // invalidating would (a) re-hit EVERY provider when only one was just
        // connected (the whole-daemon refresh the dashboard fires on login), (b)
        // ignore a provider's freshness window, and (c) clear the served snapshot
        // so the card blanks mid-refresh. Leaving the cache intact means the last
        // figures keep being served (`peekUsage`) while a re-fetch runs. The
        // post-command status push then carries whatever the cache now holds.
        await refreshUsage(cmd.payload?.slug);
        // NB: a bare `refresh` does NOT re-walk device state — the `-s` walk is
        // heavy (a fetch + bash per registry item) and the dashboard fires
        // `refresh` often, which would flood. Device state refreshes on connect
        // (eager) and after each install/uninstall (single-item probe); a
        // dedicated on-demand re-walk is future work (proposal §9 cadence).
        return { id: cmd.id, status: "done" };
      case "status":
        return { id: cmd.id, status: "done" };
      // Drop every cached signed plan tuple. Enqueued by the dashboard after
      // a chain/config save so the next request re-resolves through the cloud
      // instead of replaying the pre-save chain for up to the cache TTL.
      case "bust_plan_cache":
        // Config saves use this existing control command. Refresh bootstrap
        // first so per-user routing preferences take effect immediately rather
        // than waiting for the normal bootstrap TTL. `refreshBootstrap` returns
        // whether cloudState changed, not success — always clear the cache so a
        // failed refresh cannot leave a stale signed plan / overflow strategy.
        await refreshBootstrap();
        clearPlanCache();
        return { id: cmd.id, status: "done" };
      // Force a live model-list re-report. The dashboard's "Available
      // models" refresh button enqueues this mid-TTL so the user doesn't
      // have to `openllmd restart`. Clear EVERY slug's throttle first
      // (a successful report stamps the 30m window; a failed one stamps
      // the 15m failure backoff — both would otherwise block a manual
      // refresh), then AWAIT the report so the lifecycle frame the
      // dashboard keys off of only lands AFTER `/api/daemon/models` has
      // the fresh rows. For explicit refresh, surface a report failure as
      // `error`; no entries to report still returns done.
      case "refresh_models": {
        resetModelReportThrottle();
        const report = await maybeReportModels();
        if (report.failed) {
          return {
            id: cmd.id,
            status: "error",
            result: {
              error: report.error,
            },
          };
        }
        return { id: cmd.id, status: "done" };
      }
      // Automatic discovery when due. Never resets the throttle, never
      // calls `listModels`. Quiet `done` on skip and on failure so an
      // old-dashboard force path is not implied and the UI stays silent.
      case "refresh_models_due": {
        const report = await maybeReportModels(
          Date.now(),
          undefined,
          "auto",
        ).catch(
          (): {
            readonly attempted: boolean;
            readonly reported: number;
            readonly failed: boolean;
            readonly error?: string;
          } => ({
            attempted: false,
            reported: 0,
            failed: true,
          }),
        );
        return {
          id: cmd.id,
          status: "done",
          result: {
            attempted: report.attempted,
            reported: report.reported,
            failed: report.failed,
            ...(report.error === undefined ? {} : { error: report.error }),
          },
        };
      }
      // Vendor-local session index for the device-session picker (history +
      // ~/.openllm/run live.json + durable session-host registry). Result rides the lifecycle.
      // Short-TTL cache so rapid picker refreshes do not re-scan vendor stores
      // + run dirs on the daemon event loop every time.
      case "list_local_sessions": {
        const now = Date.now();
        // Key by the CLAMPED limit so callers passing equivalent limits (e.g.
        // undefined vs the default, or any value ≥ HARD_CAP) share one entry.
        const cacheKey = `${cmd.payload.cli}:${clampLimit(cmd.payload.limit)}`;
        const cached = listLocalSessionsCache.get(cacheKey);
        if (
          cached !== undefined &&
          now - cached.at < LIST_LOCAL_SESSIONS_TTL_MS
        ) {
          return {
            id: cmd.id,
            status: "done",
            result: { sessions: cached.sessions },
          };
        }
        // Prune expired entries on each miss so the map can't grow unbounded.
        for (const [key, entry] of listLocalSessionsCache) {
          if (now - entry.at >= LIST_LOCAL_SESSIONS_TTL_MS) {
            listLocalSessionsCache.delete(key);
          }
        }
        const deviceHosts = await deviceSessionsForList();
        const sessions = await readLocalSessions(cmd.payload.cli, {
          limit: cmd.payload.limit,
          deps: {
            deviceSessions: () => deviceHosts,
          },
        });
        listLocalSessionsCache.set(cacheKey, { at: now, sessions });
        return {
          id: cmd.id,
          status: "done",
          result: { sessions },
        };
      }
      // Force a self-update check now (the daemon also checks on every bootstrap
      // tick WHEN auto-update is opted in). This is an EXPLICIT user request, so
      // it passes `force` to converge regardless of the opt-in preference.
      // Refresh the bootstrap first so a release published since the last tick is
      // seen — otherwise a forced check would read a stale `latestVersion()`.
      // Fire-and-forget: it self-guards and, if it updates, swaps the binary +
      // exits once idle so the supervisor relaunches it.
      case "update":
        void (async () => {
          await refreshBootstrap();
          // CLI first: converging openllm is a plain file swap, while a daemon
          // update EXITS the process — anything after it would never run (and
          // with auto-update toggled off, the relaunched boot wouldn't force it).
          await maybeUpdateCli(latestCliVersion(), { force: true });
          await maybeSelfUpdate(latestVersion(), { force: true });
        })().catch((err) => logError("control-relay", err));
        return { id: cmd.id, status: "done", result: { checking: true } };
      // Toggle the auto-update opt-in from the dashboard. Persisted locally so it
      // survives restarts; the post-command status push carries the new value
      // back so the switch reflects it. Enabling kicks off an immediate
      // convergence check (now that it's allowed) so the daemon catches up
      // without waiting for the next bootstrap tick.
      case "set_auto_update": {
        const enabled = cmd.payload.enabled;
        setAutoUpdate(enabled);
        // Confirm the write actually took before acking success — the persist
        // can fail silently (read-only state dir / full disk; setAutoUpdate logs
        // + swallows it). `autoUpdateEnabled` reads the flag back fresh, so a
        // mismatch means the effective state isn't what was requested → error.
        const persisted = autoUpdateEnabled();
        if (persisted !== enabled) {
          return {
            id: cmd.id,
            status: "error",
            result: {
              error: "failed to persist auto-update preference",
              auto_update: persisted,
            },
          };
        }
        // Only converge now if it actually stuck on.
        if (enabled) {
          void (async () => {
            await refreshBootstrap();
            // CLI first — a daemon update exits the process (see "update" above;
            // here the toggle is on, so the relaunched boot would catch up, but
            // converging both now avoids the extra tick).
            await maybeUpdateCli(latestCliVersion());
            await maybeSelfUpdate(latestVersion());
          })().catch((err) => logError("control-relay", err));
        }
        return {
          id: cmd.id,
          status: "done",
          result: { auto_update: persisted },
        };
      }
      default: {
        // Unreachable for a wire-delivered command — the closed union rejects
        // unknown kinds at the schema boundary before this runs. Kept as
        // defence-in-depth for any future non-wire caller.
        const unknown = cmd as { id: string; kind: string };
        return {
          id: unknown.id,
          status: "error",
          result: { error: `unknown command kind "${unknown.kind}"` },
        };
      }
    }
  } catch (err) {
    return {
      id: cmd.id,
      status: "error",
      result: { error: err instanceof Error ? err.message : String(err) },
    };
  }
};
