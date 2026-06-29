/**
 * Native-CLI token refresh.
 *
 * The daemon does NOT refresh subscription OAuth tokens itself any more (no
 * `grant_type=refresh_token` calls, no extracted/hardcoded token endpoint or
 * client id). Instead each delegate's `readToken` checks expiry and, when the
 * access token is near or past expiry, TRIGGERS the official CLI's OWN native
 * refresh by running a bounded CLI invocation; the CLI refreshes + persists its
 * token to its own store, and the daemon just re-reads it. See each delegate's
 * `triggerRefresh` for the per-CLI command (claude/kimi: a minimal `-p` ping;
 * codex: `codex doctor`).
 *
 * Latency: a refresh spawn is seconds, so it must not block the serving hot
 * path. `makeRefresher` fires it in the BACKGROUND while the token is still
 * valid (within the leeway window) and only AWAITS it once the token is already
 * hard-expired — exactly "no latency unless the refresh is close".
 */
import { spawnLogin, spawnLoginPty } from "./util";

/** Bound on a refresh spawn — generous for a slow first call, short enough that
 *  a wedged child is reaped (the refresh already landed mid-request before the
 *  child's slow exit, so the timeout never costs correctness). */
export const REFRESH_SPAWN_TIMEOUT_MS = 60_000;

/**
 * Run a bounded CLI invocation whose SIDE EFFECT is the CLI refreshing +
 * persisting its own OAuth token. Output is ignored; the daemon never writes the
 * store (the CLI owns it). `pty` runs it under a pseudo-terminal for a CLI whose
 * print mode is TTY-gated (kimi's `-p`).
 */
export const spawnRefresh = async (
  argv: ReadonlyArray<string>,
  env: Record<string, string>,
  opts?: { readonly pty?: boolean },
): Promise<void> => {
  const run = opts?.pty === true ? spawnLoginPty : spawnLogin;
  await run([...argv], env, { timeoutMs: REFRESH_SPAWN_TIMEOUT_MS });
};

/** What `makeRefresher` did for this read — tells the caller whether the store
 *  was (synchronously) refreshed and should be re-read. */
export type TRefreshOutcome =
  /** Not near expiry, or no expiry known — nothing triggered. */
  | "fresh"
  /** Within the window but still valid — refresh KICKED in the background; the
   *  current token is returned as-is (the store updates before it's next used). */
  | "kicked"
  /** Hard-expired — the refresh was AWAITED; re-read the store for the new token. */
  | "awaited";

/**
 * Build a per-provider refresher around its `trigger` (the CLI-refresh spawn).
 * Single-flight: concurrent callers that all see a stale token share ONE spawn
 * (refresh-token rotation means parallel refreshes would invalidate each other).
 *
 * Returns a function the delegate's `readToken` calls with the token's
 * `expiresAtMs`:
 *   - `>= leewayMs` remaining → `"fresh"` (no trigger).
 *   - within the window but still valid → fire the trigger in the BACKGROUND,
 *     return `"kicked"` (caller returns the current still-valid token — no stall).
 *   - hard-expired → AWAIT the trigger, return `"awaited"` (caller re-reads).
 */
export const makeRefresher = (opts: {
  readonly leewayMs: number;
  readonly trigger: () => Promise<void>;
}): ((expiresAtMs: number | null) => Promise<TRefreshOutcome>) => {
  let inFlight: Promise<void> | null = null;
  const fire = (): Promise<void> => {
    if (inFlight === null) {
      inFlight = opts.trigger().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
  return async (expiresAtMs) => {
    if (expiresAtMs === null) return "fresh";
    const remaining = expiresAtMs - Date.now();
    if (remaining >= opts.leewayMs) return "fresh";
    if (remaining > 0) {
      void fire();
      return "kicked";
    }
    await fire();
    return "awaited";
  };
};
