/**
 * The daemon's OUTBOUND control channel — it dials the cloud instead of
 * waiting for the browser to reach loopback (which Chrome gates behind a
 * flaky Private Network Access prompt). See
 * `docs/proposals/daemon-control-via-neon-longpoll.md`.
 *
 * The loop holds `GET /api/daemon/poll` (long-poll, ~25s server-side) with
 * the daemon's `sk-llm` key. The held poll IS the presence signal (the cloud
 * stamps `daemon_active`/`last_seen`). When a command is delivered it's run
 * through the SAME control handlers the localhost surface uses (connect /
 * cli-install), then acked + a status snapshot pushed via
 * `POST /api/daemon/status`. On graceful exit a final `{ active:false }`
 * beacon flips the key offline immediately.
 *
 * No new secret, no `x-openllm-daemon` header — just the API key.
 */

import type { TDaemonCommand, TDaemonCommandAck } from "@openllm/schema";
import { autoUpdateEnabled, setAutoUpdate } from "./auto-update-pref";
import { installCli } from "./cli-install";
import type { TCliProvider } from "./cli-paths";
import {
  InvalidApiKeyError,
  NoApiKeyError,
  pollControl,
  relayCredential,
  reportStatus,
  TransientUpstreamError,
} from "./cloud-client";
import { latestVersion, refreshBootstrap } from "./config";
import { getDelegate } from "./delegation";
import { hasApiKey } from "./env";
import {
  anyInstalling,
  clearInstalling,
  setInstalling,
} from "./installing-state";
import type { TIntegrationKind } from "./integrations";
import { runIntegration } from "./integrations";
import { openSealed, sealTo } from "./keypair";
import { logDebug, logError, logInfo } from "./logger";
import { clearPendingAuth, hasPendingAuth } from "./pending-auth";
import { maybeSelfUpdate } from "./self-update";
import { setSetupToken } from "./setup-token";
import { computeStatus } from "./status";
import { invalidateUsage } from "./usage-cache";

// No key / unreachable / rejected → back off before re-dialing.
const BACKOFF_MS = 5_000;

// Abort a poll that outlives the server's worst-case hold, then re-dial.
// DERIVED from the server's contract (mirrored here — the daemon is
// `@openllm/core`-free and can't import the cloud constants):
//   server hold        = packages/api/lib/daemon-poll.ts  POLL_HOLD_MS  (25s)
//   one in-flight claim = packages/db/neon/client.ts  DB_FETCH_TIMEOUT_MS (8s)
// The handler enforces the hold as a hard ceiling, so the worst-case response
// is hold + one bounded claim; we add a small margin so the daemon's abort is
// always strictly above the server's worst case (never the other way round,
// which is what produced the 35s-vs-35s race). See
// `docs/proposals/daemon-poll-db-resilience.md` §3.4.
const SERVER_POLL_HOLD_MS = 25_000;
const SERVER_DB_FETCH_TIMEOUT_MS = 8_000;
const POLL_TIMEOUT_MARGIN_MS = 2_000;
const POLL_TIMEOUT_MS =
  SERVER_POLL_HOLD_MS + SERVER_DB_FETCH_TIMEOUT_MS + POLL_TIMEOUT_MARGIN_MS;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// An aborted/timed-out poll (our own `AbortSignal.timeout`, or the connection
// dropping) is expected weather, not a fault — `AbortSignal.timeout` rejects
// with a DOMException named `TimeoutError`; a manual abort, `AbortError`.
const isAbortOrTimeout = (err: unknown): boolean =>
  err instanceof Error &&
  (err.name === "TimeoutError" || err.name === "AbortError");

/**
 * Execute one delivered command via the existing control handlers. Returns
 * the terminal ack. Unknown kinds are acked as errors rather than thrown so
 * one bad command can't stall the batch.
 *
 * Every error ack is also written to the local error log — the cloud records
 * the ack, but a user debugging on the box (e.g. a relay 404, or a sealed
 * credential that wouldn't open) needs it in `~/.openllm/openllmd.log`.
 */
const runCommand = async (cmd: TDaemonCommand): Promise<TDaemonCommandAck> => {
  const ack = await runCommandInner(cmd);
  if (ack.status === "error") {
    const reason = (ack.result as { error?: string } | undefined)?.error;
    logError("command", reason ?? "command failed", {
      kind: cmd.kind,
      id: cmd.id,
    });
  }
  return ack;
};

// Exported for the relay-dispatch test — exercises the kind→handler mapping
// (e.g. the integration install/uninstall payload guard) without the loop.
export const runCommandInner = async (
  cmd: TDaemonCommand,
): Promise<TDaemonCommandAck> => {
  try {
    const payload = (cmd.payload ?? {}) as {
      slug?: string;
      target_key?: string;
      target_pubkey?: string;
      sealed?: string;
      kind?: string;
      target?: string;
      enabled?: boolean;
    };
    switch (cmd.kind) {
      case "connect": {
        const delegate =
          payload.slug !== undefined ? getDelegate(payload.slug) : null;
        if (delegate === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        const r = await delegate.connect();
        return { id: cmd.id, status: "done", result: r };
      }
      case "cli_install": {
        if (payload.slug === undefined || getDelegate(payload.slug) === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        const slug = payload.slug;
        // Mark installing + push ONE interim status BEFORE the (blocking)
        // download, so the card shows a synced "Installing…" immediately
        // instead of going dark until the install finishes. The push is INSIDE
        // the try so a failure in computeStatus/reportStatus can't bypass the
        // finally — `clearInstalling` always runs, never leaving the provider
        // stuck in `installing: true`. The post-command status push then
        // carries `cli_installed`.
        setInstalling(slug);
        try {
          await reportStatus({
            active: true,
            status: await computeStatus(),
          }).catch(() => {});
          const r = await installCli(slug as TCliProvider);
          return { id: cmd.id, status: "done", result: r };
        } finally {
          clearInstalling(slug);
        }
      }
      case "install_integration":
      case "uninstall_integration": {
        // Run a skill/plugin/setup install or uninstall on THIS machine via the
        // same shared executor the CLI uses. The dashboard enqueues this against
        // the selected daemon key; the executor fetches the gateway script,
        // verifies it (fail-closed), and shells out. See
        // `docs/proposals/daemon-integration-triggers.md` §5.
        const integrationKinds = ["skill", "plugin", "setup"];
        if (
          payload.kind === undefined ||
          !integrationKinds.includes(payload.kind) ||
          payload.slug === undefined
        ) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: `${cmd.kind}: bad payload` },
          };
        }
        const action =
          cmd.kind === "install_integration" ? "install" : "uninstall";
        const r = await runIntegration(
          payload.kind as TIntegrationKind,
          action,
          payload.slug,
          payload.target,
        );
        return { id: cmd.id, status: r.ok ? "done" : "error", result: r };
      }
      case "connect_device_code": {
        // Start a device-code login (codex remote; kimi falls back to its
        // normal device-code `connect`). Surfaces the URL+code via status.
        const delegate =
          payload.slug !== undefined ? getDelegate(payload.slug) : null;
        if (delegate === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        const r =
          delegate.connectDeviceCode !== undefined
            ? await delegate.connectDeviceCode()
            : await delegate.connect();
        return {
          id: cmd.id,
          status: r.connected || r.pending === true ? "done" : "error",
          result: r,
        };
      }
      case "connect_setup_token": {
        // Obtain a setup-token via the provider's own flow (Claude only) —
        // the daemon runs `claude setup-token`, captures the printed token,
        // and stores it on the box. Same control-surface path as `connect`.
        const delegate =
          payload.slug !== undefined ? getDelegate(payload.slug) : null;
        if (delegate?.connectSetupToken === undefined) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "setup token not supported for this provider" },
          };
        }
        const r = await delegate.connectSetupToken();
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
        const delegate =
          payload.slug !== undefined ? getDelegate(payload.slug) : null;
        if (delegate === null || payload.slug === undefined) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        if (delegate.cancelConnect !== undefined) {
          const r = await delegate.cancelConnect();
          return { id: cmd.id, status: r.ok ? "done" : "error", result: r };
        }
        clearPendingAuth(payload.slug);
        return { id: cmd.id, status: "done", result: { ok: true } };
      }
      case "logout": {
        // Sign out of a subscription provider's CLI-LOGIN credential on this
        // daemon (per-key: the cloud delivered this only to the target key).
        const delegate =
          payload.slug !== undefined ? getDelegate(payload.slug) : null;
        if (delegate === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        const r = await delegate.logout();
        return { id: cmd.id, status: r.ok ? "done" : "error", result: r };
      }
      case "mint_setup_token": {
        // LOCAL daemon (this machine, browser signed in): mint a Claude
        // setup-token here, SEAL it to the TARGET daemon's pubkey, and relay
        // the ciphertext via the cloud. The token never touches this box's
        // store nor the cloud in the clear.
        const delegate =
          payload.slug !== undefined ? getDelegate(payload.slug) : null;
        if (
          delegate?.mintSetupToken === undefined ||
          payload.target_key === undefined ||
          payload.target_pubkey === undefined
        ) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "mint_setup_token: bad payload / unsupported" },
          };
        }
        const minted = await delegate.mintSetupToken();
        if ("error" in minted) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: minted.error },
          };
        }
        try {
          const sealed = sealTo(payload.target_pubkey, minted.token);
          await relayCredential(payload.target_key, sealed);
        } catch (err) {
          return {
            id: cmd.id,
            status: "error",
            result: {
              error: err instanceof Error ? err.message : "relay failed",
            },
          };
        }
        return {
          id: cmd.id,
          status: "done",
          result: { relayed: true },
        };
      }
      case "receive_setup_token": {
        // TARGET daemon: open the sealed setup-token with our own key and
        // store it. We're now authenticated via the caller's browser identity.
        if (payload.sealed === undefined) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "receive_setup_token: missing sealed blob" },
          };
        }
        const token = openSealed(payload.sealed);
        if (token === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "could not open sealed credential" },
          };
        }
        setSetupToken("claude_code", token);
        return { id: cmd.id, status: "done", result: { received: true } };
      }
      case "remove_setup_token": {
        // Clear an on-box setup-token (Claude). Independent of `logout` —
        // they're separate credential sources for claude_code.
        if (payload.slug === undefined || getDelegate(payload.slug) === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        setSetupToken(payload.slug, null);
        return { id: cmd.id, status: "done", result: { ok: true } };
      }
      // A bare refresh: nothing to do — the status push below carries the
      // fresh snapshot back.
      case "refresh":
        // Manual refresh: bust the usage cache so the post-command
        // computeStatus() re-reads the vendor LIVE instead of serving the
        // cached (possibly backing-off) snapshot. `slug` scopes it to one
        // provider; the dashboard's whole-daemon refresh sends none → clears
        // all. `status` is the passive read and keeps the cache.
        invalidateUsage(payload.slug);
        return { id: cmd.id, status: "done" };
      case "status":
        return { id: cmd.id, status: "done" };
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
          await maybeSelfUpdate(latestVersion(), { force: true });
        })();
        return { id: cmd.id, status: "done", result: { checking: true } };
      // Toggle the auto-update opt-in from the dashboard. Persisted locally so it
      // survives restarts; the post-command status push carries the new value
      // back so the switch reflects it. Enabling kicks off an immediate
      // convergence check (now that it's allowed) so the daemon catches up
      // without waiting for the next bootstrap tick.
      case "set_auto_update": {
        const enabled = payload.enabled === true;
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
            await maybeSelfUpdate(latestVersion());
          })();
        }
        return {
          id: cmd.id,
          status: "done",
          result: { auto_update: persisted },
        };
      }
      default:
        return {
          id: cmd.id,
          status: "error",
          result: { error: `unknown command kind "${cmd.kind}"` },
        };
    }
  } catch (err) {
    return {
      id: cmd.id,
      status: "error",
      result: { error: err instanceof Error ? err.message : String(err) },
    };
  }
};

// ─── Change-detected status push + flow-gated watcher ───────────────────
//
// The relay only pushes a status snapshot after running a command (and on a
// `cloud_state` change, from main.ts). But a provider's state can change with
// NO command in flight — most visibly a device-code login: the spawned vendor
// process keeps polling and writes its credential in the BACKGROUND, so
// `connected` flips on the box but never reaches the cloud until the next
// command (which is why the card used to sit on "connecting" until a manual
// Refresh). We close that gap with a change-detected push driven by a watcher
// that runs ONLY while a background flow is in flight. See
// `docs/proposals/daemon-browser-status-sync.md` §2.

// Fingerprint of the last snapshot we pushed — every push site updates it so
// the watcher never re-sends an unchanged snapshot.
let lastFingerprint: string | null = null;

/**
 * Recompute the status snapshot and push it ONLY if it changed since the last
 * push. The de-dupe makes it safe to call on a timer. No-op when keyless.
 */
export const pushStatusIfChanged = async (): Promise<void> => {
  if (!hasApiKey()) return;
  const status = await computeStatus();
  // Fingerprint = JSON of the snapshot. `computeStatus()` builds the object
  // with a fixed key order (status.ts), and V8 (Node/Bun) preserves insertion
  // order, so JSON.stringify is a stable identity here — equal snapshots
  // stringify equally and we skip the redundant push. If computeStatus ever
  // becomes non-deterministic in key order, this would need a canonical
  // serialize; the only downside today is a spurious push (the cloud just
  // re-stores the same status), and a failed push resets the fp so we retry.
  const fp = JSON.stringify(status);
  if (fp === lastFingerprint) return;
  lastFingerprint = fp;
  try {
    await reportStatus({ active: true, status });
  } catch {
    // Failed to push — forget the fingerprint so the next tick retries.
    lastFingerprint = null;
  }
};

// "A background flow that can complete WITHOUT a further command is running":
// a provider awaiting device-code authorization, or a CLI install in progress.
// While true, the watcher ticks; once false it stands down (zero steady-state
// cost on an idle daemon).
const aFlowIsInFlight = (): boolean => hasPendingAuth() || anyInstalling();

// Cheap enough to tick while a flow is live; the change-detection in
// `pushStatusIfChanged` means at most one push per actual change.
const WATCH_MS = 2_500;
let watcher: ReturnType<typeof setInterval> | null = null;

/**
 * Arm the status-change watcher if a background flow is in flight (idempotent).
 * It pushes on every snapshot change and disarms itself once nothing is
 * pending — so a device-code login completing in the background flips the card
 * within ~{@link WATCH_MS}, with no manual refresh.
 */
export const armStatusWatcher = (): void => {
  if (watcher !== null || !aFlowIsInFlight()) return;
  watcher = setInterval(() => {
    void (async () => {
      // Push the final state BEFORE disarming, so the completing flow's
      // terminal snapshot (connected / expired) is always delivered.
      await pushStatusIfChanged();
      if (!aFlowIsInFlight() && watcher !== null) {
        clearInterval(watcher);
        watcher = null;
      }
    })();
  }, WATCH_MS);
};

let running = false;

/**
 * Start the control loop (idempotent). Runs for the daemon's lifetime:
 * dial → drain commands → run → ack + push status → re-dial.
 */
export const startControlRelay = (): void => {
  if (running) return;
  running = true;
  void loop();
};

const loop = async (): Promise<void> => {
  // Push an initial snapshot once a key is present so the dashboard has
  // state immediately, not only after the first command.
  let pushedInitial = false;
  // Last logged loop-error message — for throttling repeated identical errors
  // (see the catch below). Reset to "" so a recovered→failed transition logs.
  let lastLoopError = "";
  for (;;) {
    if (!hasApiKey()) {
      await sleep(BACKOFF_MS);
      continue;
    }
    try {
      if (!pushedInitial) {
        const status = await computeStatus();
        lastFingerprint = JSON.stringify(status);
        await reportStatus({ active: true, status });
        pushedInitial = true;
      }
      const { commands } = await pollControl(
        AbortSignal.timeout(POLL_TIMEOUT_MS),
      );
      if (commands.length > 0) {
        logInfo("control-loop", "drained commands", {
          kinds: commands.map((c) => c.kind),
        });
        const acks: TDaemonCommandAck[] = [];
        for (const cmd of commands) acks.push(await runCommand(cmd));
        const status = await computeStatus();
        lastFingerprint = JSON.stringify(status);
        await reportStatus({ active: true, status, acks });
        // A command may have STARTED a background flow that finishes with no
        // further command (device-code awaiting auth, a CLI install) — arm the
        // change-detected watcher so its completion is pushed automatically.
        armStatusWatcher();
      } else {
        // Empty batch = the poll's hold elapsed (the poll itself refreshed
        // presence cloud-side). Catch any out-of-band drift since the last push
        // (a credential changed in the user's own terminal, a token expiry)
        // with a change-detected push before re-dialing.
        await pushStatusIfChanged();
      }
      lastLoopError = ""; // a clean pass — let the next failure log afresh.
    } catch (err) {
      // Invalid/absent key or an unreachable/stalled cloud — back off, then
      // re-try. A freshly set key (or recovered network) is picked up on the
      // next iteration. Re-push the initial snapshot after a key change.
      if (err instanceof InvalidApiKeyError || err instanceof NoApiKeyError) {
        pushedInitial = false;
      }
      // Log, but throttle: the loop retries every BACKOFF_MS, so an ongoing
      // outage would otherwise flood the log with the same line. Only write
      // when the error MESSAGE changes (i.e. a real transition), and never
      // for the benign "no key yet" state. A transient hiccup (our own
      // abort/timeout on the long-poll, or a soft 503/5xx from the cloud
      // degrading on Neon weather) is downgraded to `debug` — and we never
      // emit an empty message (the abort path used to log `""`).
      if (!(err instanceof NoApiKeyError)) {
        const transient =
          isAbortOrTimeout(err) || err instanceof TransientUpstreamError;
        const msg =
          err instanceof Error && err.message.length > 0
            ? err.message
            : "control poll timed out";
        if (msg !== lastLoopError) {
          lastLoopError = msg;
          if (transient) logDebug("control-loop", msg);
          else logError("control-loop", err);
        }
      }
      await sleep(BACKOFF_MS);
    }
  }
};

/**
 * Push the current status snapshot now (best-effort, keeps the daemon online).
 * The relay loop only re-pushes after a command, so a `cloud_state` change that
 * happens between commands (e.g. a retried bootstrap recovering from
 * `unreachable` → `ok`) would otherwise stay invisible to the dashboard. The
 * bootstrap scheduler calls this on every state change. No-op when keyless.
 */
export const pushStatus = async (): Promise<void> => {
  if (!hasApiKey()) return;
  try {
    const status = await computeStatus();
    lastFingerprint = JSON.stringify(status);
    await reportStatus({ active: true, status });
  } catch {
    // best-effort — the relay loop re-pushes on its next command anyway
  }
};

/**
 * Fire-and-forget graceful-exit beacon: tell the cloud this key's daemon is
 * going offline so the dashboard flips immediately (rather than waiting for
 * the presence-staleness window). Awaitable so the signal handler can let it
 * flush before exiting.
 */
export const reportControlInactive = async (): Promise<void> => {
  if (!hasApiKey()) return;
  await reportStatus({ active: false });
};
