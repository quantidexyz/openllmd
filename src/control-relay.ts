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
import { installCli } from "./cli-install";
import type { TCliProvider } from "./cli-paths";
import {
  InvalidApiKeyError,
  NoApiKeyError,
  pollControl,
  relayCredential,
  reportStatus,
} from "./cloud-client";
import { getDelegate } from "./delegation";
import { hasApiKey } from "./env";
import { clearInstalling, setInstalling } from "./installing-state";
import { openSealed, sealTo } from "./keypair";
import { logError } from "./logger";
import { setSetupToken } from "./setup-token";
import { computeStatus } from "./status";

// No key / unreachable / rejected → back off before re-dialing.
const BACKOFF_MS = 5_000;
// Abort a poll that outlives the server's hold + margin, then re-dial.
const POLL_TIMEOUT_MS = 35_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

const runCommandInner = async (
  cmd: TDaemonCommand,
): Promise<TDaemonCommandAck> => {
  try {
    const payload = (cmd.payload ?? {}) as {
      slug?: string;
      target_key?: string;
      target_pubkey?: string;
      sealed?: string;
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
      case "status":
        return { id: cmd.id, status: "done" };
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
        await reportStatus({ active: true, status: await computeStatus() });
        pushedInitial = true;
      }
      const { commands } = await pollControl(
        AbortSignal.timeout(POLL_TIMEOUT_MS),
      );
      if (commands.length > 0) {
        const acks: TDaemonCommandAck[] = [];
        for (const cmd of commands) acks.push(await runCommand(cmd));
        await reportStatus({
          active: true,
          status: await computeStatus(),
          acks,
        });
      }
      // Empty batch = the poll's hold elapsed; immediately re-dial (the poll
      // itself refreshed presence cloud-side).
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
      // for the benign "no key yet" state.
      if (!(err instanceof NoApiKeyError)) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== lastLoopError) {
          lastLoopError = msg;
          logError("control-loop", err);
        }
      }
      await sleep(BACKOFF_MS);
    }
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
