/**
 * The daemon's liveness heartbeat — extracted from `control-channel.ts` so the
 * timer logic is pure and unit-testable (no partysocket, no module singletons).
 *
 * Why it exists (R4 in
 * docs/audit/2026-06-08-daemon-relay-websocket-stability.md): the daemon used to
 * arm its liveness watchdog off *any* inbound frame — including the relay's
 * ping. That makes the daemon blind to a half-open where relay→daemon still
 * flows but daemon→relay is dead: it keeps "seeing traffic," stays satisfied,
 * and never reconnects — recovery falls entirely to the relay terminating the
 * socket (the alarming `1006`), up to ~40s later.
 *
 * The fix is a round-trip the daemon OWNS: it sends its own `ping` on an
 * interval and arms the watchdog off the relay's `pong` (`notePong`), NOT off
 * arbitrary inbound frames. If the daemon→relay direction is dead, the relay
 * never receives the ping, never pongs, and the watchdog fires `onSilent()` —
 * so the daemon detects its *own* dead direction and reconnects proactively,
 * instead of waiting for the relay's reap.
 */

export type THeartbeatDeps = {
  /** Send one heartbeat `ping` frame to the relay. */
  readonly sendPing: () => void;
  /** Called when no `pong` has arrived within the liveness window — the relay
   *  (or the daemon→relay direction) is silent, so force a reconnect. */
  readonly onSilent: () => void;
  /** How often the daemon sends its heartbeat ping. */
  readonly heartbeatMs: number;
  /** How long with no `pong` before declaring the link silent. Keep it a
   *  comfortable multiple of `heartbeatMs` so a single slow round-trip never
   *  trips it (the relay tolerates a missed pong symmetrically). */
  readonly livenessMs: number;
};

export type THeartbeat = {
  /** Begin pinging + arm the liveness window. Idempotent: a second call while
   *  running is a no-op (so a reconnect's re-`start` can't stack intervals). */
  readonly start: () => void;
  /** Record a `pong` from the relay — re-arms the liveness window. */
  readonly notePong: () => void;
  /** Stop pinging and disarm the window. */
  readonly stop: () => void;
};

export const createHeartbeat = (deps: THeartbeatDeps): THeartbeat => {
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let livenessTimer: ReturnType<typeof setTimeout> | null = null;

  const armLiveness = (): void => {
    if (livenessTimer !== null) clearTimeout(livenessTimer);
    livenessTimer = setTimeout(deps.onSilent, deps.livenessMs);
    livenessTimer.unref?.();
  };

  const start = (): void => {
    if (pingTimer !== null) return; // already running
    // Arm the window immediately so a relay that never pongs is caught within
    // `livenessMs` of connecting, not only after the first ping interval.
    armLiveness();
    pingTimer = setInterval(deps.sendPing, deps.heartbeatMs);
    pingTimer.unref?.();
  };

  const notePong = (): void => {
    // Only meaningful while running — a stray pong after `stop` must not
    // resurrect the window.
    if (pingTimer === null) return;
    armLiveness();
  };

  const stop = (): void => {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (livenessTimer !== null) {
      clearTimeout(livenessTimer);
      livenessTimer = null;
    }
  };

  return { start, notePong, stop };
};
