/**
 * The daemon's command executor — the kind→handler mapping for every control
 * command (connect / cli-install / integration / login-code / auto-update / …).
 *
 * It is transport-agnostic: the WebSocket control channel (`control-channel.ts`)
 * pulls a command off the relay socket, runs it through `runCommandInner`, and
 * acks + pushes a fresh status snapshot back over the same socket. There is no
 * long-poll anymore — the relay socket is the daemon's only control transport.
 */

import type { TDaemonCommand, TDaemonCommandAck } from "@quantidexyz/openllmp";
import { autoUpdateEnabled, setAutoUpdate } from "./auto-update-pref";
import { installCli } from "./cli-install";
import { latestVersion, refreshBootstrap } from "./config";
import { getDelegate } from "./delegation";
import { clearInstalling, setInstalling } from "./installing-state";
import { runIntegration } from "./integrations";
import { openSealed } from "./keypair";
import { clearPendingAuth } from "./pending-auth";
import { maybeSelfUpdate } from "./self-update";
import { invalidateUsage } from "./usage-cache";

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
        const r = await delegate.connect();
        return { id: cmd.id, status: "done", result: r };
      }
      case "cli_install": {
        const slug = cmd.payload.slug;
        if (getDelegate(slug) === null) {
          return {
            id: cmd.id,
            status: "error",
            result: { error: "unknown provider" },
          };
        }
        // Mark installing so the next status snapshot the control channel pushes
        // (its change-detected watcher, or the post-command push) carries
        // `installing: true` and the card shows "Installing…". `clearInstalling`
        // always runs in the finally so a failed install never wedges the
        // provider in `installing: true`.
        setInstalling(slug);
        try {
          const r = await installCli(slug);
          // The vendor installer can run to completion yet never produce a
          // working binary (sandbox EACCES, network failure, …). Reflect the
          // REAL outcome in the ack status so the dashboard shows the failure
          // (and `r.output` carries the installer tail) instead of a misleading
          // "done". See docs/audit/2026-06-22-daemon-mac-sandbox-failures.md §2.
          return {
            id: cmd.id,
            status: r.installed ? "done" : "error",
            result: r,
          };
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
        // `docs/proposals/daemon-integration-triggers.md` §5. The kind enum +
        // charset-pinned slug/target are guaranteed by the command schema.
        const action =
          cmd.kind === "install_integration" ? "install" : "uninstall";
        const r = await runIntegration(
          cmd.payload.kind,
          action,
          cmd.payload.slug,
          cmd.payload.target,
        );
        return { id: cmd.id, status: r.ok ? "done" : "error", result: r };
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
        if (delegate.cancelConnect !== undefined) {
          const r = await delegate.cancelConnect();
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
        const r = await delegate.logout();
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
        const r = await delegate.submitLoginCode(code);
        return { id: cmd.id, status: r.ok ? "done" : "error", result: r };
      }
      // A bare refresh: nothing to do — the status push below carries the
      // fresh snapshot back.
      case "refresh":
        // Manual refresh: bust the usage cache so the post-command
        // computeStatus() re-reads the vendor LIVE instead of serving the
        // cached (possibly backing-off) snapshot. `slug` scopes it to one
        // provider; the dashboard's whole-daemon refresh sends none → clears
        // all. `status` is the passive read and keeps the cache.
        invalidateUsage(cmd.payload?.slug);
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
            await maybeSelfUpdate(latestVersion());
          })();
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
