/**
 * The WebSocket control transport — the daemon's ONLY control channel. Uses
 * `partysocket` for auto-reconnect + backoff; its url provider re-fetches a
 * fresh channel (ticket + wss url) before every (re)connect. Holds ONE socket to
 * the relay, runs pushed commands with `runCommandInner`, and acks + pushes
 * status over the socket. See `docs/proposals/daemon-relay-websocket-push.md`.
 */

import type { TDaemonCommandAck, TRelayFrame } from "@openllm/schema";
import { RelayFrame } from "@openllm/schema";
import { Schema } from "effect";
import { WebSocket as ReconnectingWebSocket } from "partysocket";
import { fetchChannel } from "./cloud-client";
import { runCommandInner } from "./control-relay";
import { logDebug, logInfo } from "./logger";
import { computeStatus } from "./status";

const decodeFrame = Schema.decodeUnknownEither(RelayFrame);

const WATCH_MS = 2_500;
// Liveness watchdog: the relay pings every 30s; if NO traffic arrives within
// this window the connection is a silent half-open (no `close` fired), so we
// `reconnect()`. partysocket owns connect/backoff but has no app heartbeat.
const LIVENESS_TIMEOUT_MS = 70_000;

let ws: ReconnectingWebSocket | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;
let livenessTimer: ReturnType<typeof setTimeout> | null = null;
/** Fresh connect ticket, stashed by the url provider for the next `hello`. */
let ticket = "";
let lastFingerprint = "";

const send = (frame: TRelayFrame): void => {
  if (ws === null || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // best-effort: a failed send means the socket is closing; partysocket reconnects
  }
};

const pushStatus = async (active?: boolean): Promise<void> => {
  const status = await computeStatus();
  lastFingerprint = JSON.stringify(status);
  send(
    active === undefined
      ? { type: "status", status }
      : { type: "status", active, status },
  );
};

/** Send a fresh snapshot only when it changed — surfaces out-of-band flips
 *  (a device-code login completing) while a command isn't in flight. Exported
 *  so the bootstrap scheduler can push a `cloud_state` change immediately. */
export const pushStatusIfChanged = async (): Promise<void> => {
  const status = await computeStatus();
  const fp = JSON.stringify(status);
  if (fp === lastFingerprint) return;
  lastFingerprint = fp;
  send({ type: "status", status });
};

const startWatcher = (): void => {
  if (watchTimer !== null) return;
  watchTimer = setInterval(() => {
    pushStatusIfChanged().catch(() => {
      // best-effort: a failed snapshot push retries on the next tick
    });
  }, WATCH_MS);
  watchTimer.unref?.();
};

const stopWatcher = (): void => {
  if (watchTimer !== null) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
};

// At-most-once command execution. Delivery is at-LEAST-once: the relay's
// logical-replication stream replays unacked WAL on reconnect (and the
// connect-time replay path can overlap a live push), so the SAME command id can
// arrive more than once. Commands like `connect` aren't idempotent (a second
// run spawns a second login), so we dedupe by id here. `null` = still running
// (skip the re-ack — the in-flight run will ack); an ack value = completed
// (re-ack with the REAL result so a lost first-ack still marks it terminal,
// without clobbering an `error` with `done`). Bounded — a daemon restart starts
// fresh and re-runs any still-pending command exactly once.
const commandResults = new Map<string, TDaemonCommandAck | null>();
const PROCESSED_CAP = 500;

const onCommand = async (command: TRelayFrame): Promise<void> => {
  if (command.type !== "command") return;
  const id = command.command.id;
  const prior = commandResults.get(id);
  if (prior !== undefined) {
    logDebug("control-channel", "duplicate command ignored", {
      id,
      kind: command.command.kind,
    });
    if (prior !== null) send({ type: "ack", ack: prior });
    return;
  }
  commandResults.set(id, null); // mark in-flight
  if (commandResults.size > PROCESSED_CAP) {
    // Evict the oldest COMPLETED entry. Skipping in-flight (`null`) entries is
    // load-bearing: evicting one would let a duplicate delivery of a still-
    // running command slip past the dedup above and execute twice (a second
    // `connect` spawns a second login). Map iteration is insertion-ordered, so
    // the first non-null is the oldest completed. If EVERY entry is in-flight we
    // keep them all — the cap is a soft bound, not a hard guarantee.
    for (const [key, value] of commandResults) {
      if (value !== null) {
        commandResults.delete(key);
        break;
      }
    }
  }
  // Log only non-sensitive metadata — a command `payload` (e.g. `set_config`)
  // and an ack `result` can carry control-plane secrets, so they must not land
  // in the daemon's logs. Kind + id + status are enough to trace a command.
  logInfo("control-channel", "command received", {
    kind: command.command.kind,
    id: command.command.id,
  });
  const ack = await runCommandInner(command.command);
  commandResults.set(id, ack);
  logInfo("control-channel", "command done", {
    kind: command.command.kind,
    id: command.command.id,
    status: ack.status,
  });
  send({ type: "ack", ack });
  // Carry a fresh snapshot back so the dashboard reflects the result.
  await pushStatus();
};

const onFrame = (frame: TRelayFrame): void => {
  switch (frame.type) {
    case "command":
      onCommand(frame).catch(() => {
        // best-effort: a command failure is reflected by the next status push
      });
      return;
    case "ping":
      send({ type: "pong" });
      return;
    default:
      // welcome / others: nothing to do (partysocket owns reconnection)
      return;
  }
};

const onMessage = (data: unknown): void => {
  if (typeof data !== "string") return;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }
  const r = decodeFrame(json);
  if (r._tag === "Right") onFrame(r.right);
};

// (Re)arm on open + every inbound frame; if the relay goes quiet past the window
// the connection is a silent half-open → force a reconnect.
const armLiveness = (): void => {
  if (livenessTimer !== null) clearTimeout(livenessTimer);
  livenessTimer = setTimeout(() => {
    logDebug(
      "control-channel",
      "no relay traffic in liveness window; reconnecting",
    );
    ws?.reconnect();
  }, LIVENESS_TIMEOUT_MS);
  livenessTimer.unref?.();
};

const clearLiveness = (): void => {
  if (livenessTimer !== null) {
    clearTimeout(livenessTimer);
    livenessTimer = null;
  }
};

/** partysocket calls this before every (re)connect — fetch a fresh channel so
 *  each connection presents a fresh short-lived ticket. Throws when keyless /
 *  unreachable; partysocket backs off and retries. */
const channelUrl = async (): Promise<string> => {
  const channel = await fetchChannel();
  ticket = channel.ticket;
  return channel.wss_url;
};

/** Start the WebSocket control loop (idempotent). */
export const startControlChannel = (): void => {
  if (ws !== null) return;
  logInfo("control-channel", "connecting over websocket");
  const socket = new ReconnectingWebSocket(channelUrl, undefined, {
    WebSocket: globalThis.WebSocket,
    minReconnectionDelay: 1_000,
    maxReconnectionDelay: 30_000,
  });
  ws = socket;
  socket.onopen = (): void => {
    armLiveness();
    void (async () => {
      const status = await computeStatus();
      lastFingerprint = JSON.stringify(status);
      send({ type: "hello", ticket, status });
      startWatcher();
    })().catch(() => {
      // best-effort: partysocket reconnects if the hello never lands
    });
  };
  socket.onmessage = (ev: MessageEvent): void => {
    armLiveness(); // any inbound frame (incl. the relay's ping) = alive
    onMessage(ev.data);
  };
  socket.onclose = (ev): void => {
    stopWatcher();
    // 4003 = relay rejected our ticket (usually a NEON_AUTH_COOKIE_SECRET
    // mismatch); 1006 = relay unreachable. 1000/1001 = relay cycling. partysocket
    // reconnects automatically in all cases.
    const clean = ev.code === 1000 || ev.code === 1001;
    logDebug(
      "control-channel",
      `socket closed code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ""}${clean ? "" : " (reconnecting)"}`,
    );
  };
};

/** Graceful-exit beacon: flip the key offline, then close. Best-effort. */
export const stopControlChannel = async (): Promise<void> => {
  if (ws === null) return;
  stopWatcher();
  clearLiveness();
  if (ws.readyState === ws.OPEN) send({ type: "status", active: false });
  ws.close(); // partysocket: a manual close() disables further reconnection
  ws = null;
};
