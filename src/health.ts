/**
 * The daemon's read-only loopback HEALTH snapshot — the body of `GET /status`
 * (served in `main.ts`) and the shape `openllmd status` (the CLI, `service.ts`)
 * fetches to learn the LIVE state of a running daemon.
 *
 * It's deliberately a tiny, secret-free subset of the cloud-facing
 * `TDaemonStatus` (`computeStatus()` in `status.ts`): no `pubkey`, no
 * `connections`, no `usage`, and — crucially — it spawns NO delegate `status()`
 * subprocesses, so the CLI probe stays cheap. The contract lives here (not in
 * `packages/schema`) because both producer and consumer are the SAME binary;
 * there's no wire-version skew to guard against.
 *
 * The point of the endpoint: the supervisor (systemd/launchd) only knows
 * whether it has a process; it can't tell a daemon that's actually SERVING from
 * one that's crash-looping on the listener bind. A successful fetch of this body
 * IS the authoritative "the daemon is up and serving" signal, and it carries the
 * real `sandbox` posture this process applied at boot (the CLI can't compute
 * that itself — it never ran `applyDaemonSandbox`).
 */
import type { TCloudState } from "./config";
import type { TSandboxState } from "./sandbox/landlock";

export type TDaemonHealth = {
  readonly version: string;
  readonly port: number;
  /** The OS-sandbox posture this process applied at boot (`sandboxState()`). */
  readonly sandbox: TSandboxState;
  readonly cloud_state: TCloudState;
  readonly key_configured: boolean;
  /** Seconds since this process booted (whole seconds). */
  readonly uptime_s: number;
};

/**
 * Assemble the `/status` body. Pure (all live values injected) so the snapshot
 * shape — and its secret-free key set — is unit-testable without booting the
 * daemon. `main.ts` is the only caller, passing live `sandboxState()` etc.
 */
export const buildHealth = (deps: {
  readonly version: string;
  readonly port: number;
  readonly sandbox: TSandboxState;
  readonly cloudState: TCloudState;
  readonly keyConfigured: boolean;
  readonly bootAt: number;
  readonly now: number;
}): TDaemonHealth => ({
  version: deps.version,
  port: deps.port,
  sandbox: deps.sandbox,
  cloud_state: deps.cloudState,
  key_configured: deps.keyConfigured,
  uptime_s: Math.max(0, Math.floor((deps.now - deps.bootAt) / 1000)),
});
