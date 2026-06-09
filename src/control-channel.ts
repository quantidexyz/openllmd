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
import { logDebug, logInfo, logWarn } from "./logger";
import { computeStatus } from "./status";

const decodeFrame = Schema.decodeUnknownEither(RelayFrame);

const WATCH_MS = 2_500;
// Liveness watchdog: the relay pings every 20s; if NO traffic arrives within
// this window the connection is a silent half-open (no `close` fired), so we
// `reconnect()`. partysocket owns connect/backoff but has no app heartbeat.
const LIVENESS_TIMEOUT_MS = 70_000;
// Reconnect jitter: a relay redeploy closes EVERY daemon's socket at once, and
// partysocket's backoff is deterministic (no jitter of its own), so without this
// the whole fleet re-dials in lockstep and stampedes the successor box. Add up to
// this much random delay before a RE-dial (gated on `hasConnected`, so the first
// connect stays immediate). Small vs the 35s presence grace, so it never surfaces
// as a flap. See `packages/audit/presence-reconnect-prior-art.md` §3.
const RECONNECT_JITTER_MS = 3_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let ws: ReconnectingWebSocket | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;
let livenessTimer: ReturnType<typeof setTimeout> | null = null;
/** Fresh connect ticket, stashed by the url provider for the next `hello`. */
let ticket = "";
let lastFingerprint = "";
/** Whether the socket has opened at least once — lets `onopen` log a first
 *  "connected" vs a recovery "reconnected", so the log shows the channel coming
 *  back, not just dropping. */
let hasConnected = false;

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

// At-most-once command execution. Within a single session the SAME command id
// can still arrive more than once — the connect-time replay path can overlap a
// live push for a command that lands just as the daemon connects (read as
// `pending` by the replay before the relay flips it to `delivered`). Commands
// like `connect` aren't idempotent (a second run spawns a second login), so we
// dedupe by id here. `null` = still running (skip the re-ack — the in-flight run
// will ack); an ack value = completed (re-ack with the REAL result so a lost
// first-ack still marks it terminal, without clobbering an `error` with `done`).
// Across restarts the relay marks every pushed command `delivered` and only ever
// replays never-delivered (`pending`) rows, so a restart does NOT re-run a
// command it already received — this in-memory map only guards the in-session
// double-delivery above.
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
    logWarn(
      "control-channel",
      `no relay traffic in ${LIVENESS_TIMEOUT_MS}ms; forcing reconnect`,
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
  // De-sync fleet reconnect storms (relay redeploy). First connect is immediate;
  // only re-dials are jittered. partysocket calls this before every (re)connect.
  if (hasConnected) await sleep(Math.random() * RECONNECT_JITTER_MS);
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
    logInfo(
      "control-channel",
      hasConnected ? "reconnected over websocket" : "connected over websocket",
    );
    hasConnected = true;
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
  socket.onerror = (ev): void => {
    // Surface connect failures (a timed-out channel fetch — message `TIMEOUT` —,
    // a thrown channel URL provider, a refused dial) at WARN so "I don't know
    // why it keeps dropping" is answerable from the log. partysocket still backs
    // off + retries; the matching `reconnected` line lands on recovery. The real
    // reason lives on `.message` (partysocket wraps the thrown error) but native
    // ws error events carry only `.error`, so read both.
    const e = ev as { message?: unknown; error?: unknown } | null;
    const reason =
      (typeof e?.message === "string" && e.message) ||
      (e?.error instanceof Error && e.error.message) ||
      "unknown";
    logWarn("control-channel", `socket error: ${reason} (reconnecting)`);
  };
  socket.onclose = (ev): void => {
    stopWatcher();
    // 4003 = relay rejected our ticket (usually a NEON_AUTH_COOKIE_SECRET
    // mismatch); 1006 = relay unreachable. 1000/1001 = relay cycling. partysocket
    // reconnects automatically in all cases.
    const clean = ev.code === 1000 || ev.code === 1001;
    const line = `socket closed code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ""}${clean ? "" : " (reconnecting)"}`;
    // A clean close (relay cycling its box, or our own graceful stop) is routine
    // → debug. An abnormal close (1006 unreachable, 4003 rejected ticket) is a
    // real drop the user needs to see → warn, paired with the `reconnected` line.
    if (clean) logDebug("control-channel", line);
    else logWarn("control-channel", line);
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
