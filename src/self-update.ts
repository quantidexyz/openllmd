/**
 * Daemon self-update.
 *
 * The daemon ships as a compiled binary at `process.execPath`, supervised by
 * launchd (`KeepAlive`) / systemd (`Restart=always`) — so EXITING relaunches it
 * within ~2s. On each cloud bootstrap the daemon learns the published version
 * (`latest_version`); when it differs from the compiled `DAEMON_VERSION` we
 * download the matching target binary, verify its SHA-256 against the published
 * checksum, atomically swap it in, wait for in-flight `/v1` requests to drain,
 * then exit so the supervisor relaunches the new binary.
 *
 * Policy: CONVERGE to the published version (update on any mismatch, not just
 * "newer") — the cloud is the source of truth, so republishing an older tag
 * rolls daemons back. See `docs/proposals/daemon-device-aware-this-machine.md`'s
 * sibling plan / the bootstrap `latest_version` field.
 *
 * Trust + safety: only managed compiled binaries self-update (a from-source dev
 * run reports `0.0.0-dev` and is skipped); the download is rejected unless its
 * SHA-256 matches the published digest (the same checksum the install script
 * verifies); the swap is atomic (same-dir temp + rename); and a persisted
 * attempt marker + cooldown bounds restart loops if a release is mis-published.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TDaemonTarget } from "../release-types";
import { DAEMON_TARGETS } from "../release-types";
import { autoUpdateEnabled } from "./auto-update-pref";
import { daemonEnv, stateDir } from "./env";
import { hardenMacBinary } from "./harden-binary";
import { logError, logInfo, logWarn } from "./logger";
import { DAEMON_VERSION } from "./version";

// Don't retry the SAME target version within this window if a relaunch didn't
// converge (a mis-published release) — bounds restart loops across relaunches.
const ATTEMPT_COOLDOWN_MS = 60 * 60 * 1000;
// Cap on how long we hold the restart waiting for `/v1` requests to drain.
const DRAIN_MAX_MS = 30_000;
const DRAIN_POLL_MS = 250;
// Abort a stalled binary/checksum download — without this a hung connection
// would leave `updating = true` for the rest of the process lifetime, blocking
// every later update attempt.
const DOWNLOAD_TIMEOUT_MS = 60_000;

// ─── In-flight `/v1` request tracking (for wait-until-idle restart) ──────────
let inFlightCount = 0;
export const beginRequest = (): void => {
  inFlightCount += 1;
};
export const endRequest = (): void => {
  if (inFlightCount > 0) inFlightCount -= 1;
};
export const inFlight = (): number => inFlightCount;

/**
 * Wrap a streaming response body so `onDone` fires EXACTLY once when the stream
 * finishes — normal end, error, or client cancel. A `/v1` response body keeps
 * flowing after the fetch handler returns, so this is how the in-flight count
 * stays accurate for long streams (and the wait-until-idle restart actually
 * waits for them).
 */
export const trackBodyDone = (
  body: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let settled = false;
  const finish = (): void => {
    if (!settled) {
      settled = true;
      onDone();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
};

/**
 * This host's release target (`darwin-arm64` / `darwin-x64` / `linux-x64` /
 * `linux-arm64`), or null if it isn't one we publish. `process.arch` reports
 * `arm64` / `x64`, matching the server's `DAEMON_TARGETS` naming.
 */
export const currentTarget = (): TDaemonTarget | null => {
  const t = `${process.platform}-${process.arch}`;
  return (DAEMON_TARGETS as readonly string[]).includes(t)
    ? (t as TDaemonTarget)
    : null;
};

type TAttempt = { readonly version: string; readonly ts: number };

const attemptFile = (): string => join(stateDir(), "update-state.json");

// True when we already tried to converge to `version` recently — so a relaunch
// that still isn't on it (bad publish) backs off instead of looping.
const recentlyAttempted = (version: string): boolean => {
  try {
    const raw = JSON.parse(readFileSync(attemptFile(), "utf-8")) as TAttempt;
    return raw.version === version && Date.now() - raw.ts < ATTEMPT_COOLDOWN_MS;
  } catch {
    return false;
  }
};

const recordAttempt = (version: string): void => {
  try {
    writeFileSync(
      attemptFile(),
      JSON.stringify({ version, ts: Date.now() } satisfies TAttempt),
      { mode: 0o600 },
    );
  } catch {
    // best-effort — the in-memory `updating` guard still prevents a tight loop
  }
};

const fetchBinary = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`binary download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

// The `.sha256` endpoint returns `"<hex>  openllmd-<target>\n"` — take the hex.
const fetchDigest = async (url: string): Promise<string> => {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`checksum download failed: ${res.status}`);
  const text = (await res.text()).trim();
  const hex = text.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("checksum response was not a sha-256 digest");
  }
  return hex.toLowerCase();
};

const waitUntilIdle = async (): Promise<void> => {
  const deadline = Date.now() + DRAIN_MAX_MS;
  while (inFlight() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }
};

// Re-entrancy guard: a bootstrap-refresh tick and a force-update command could
// both fire `maybeSelfUpdate`; only one swap+exit should run.
let updating = false;

/**
 * Update to `latest` (the cloud's published version) when it differs from this
 * binary, then exit so the supervisor relaunches it. No-op (returns) when not
 * applicable — auto-update opted out, running from source, already converged,
 * unknown target, no release, or a recent failed attempt. Never throws into the
 * caller.
 *
 * Self-update is OPT-OUT (on by default): the automatic callers (boot + each
 * bootstrap tick) are gated on {@link autoUpdateEnabled}, which only returns
 * false once the user has explicitly disabled it. An EXPLICIT user request —
 * the dashboard's "update now" command — passes `force: true` to run the
 * convergence even when disabled. See `packages/daemon/src/auto-update-pref.ts`.
 */
export const maybeSelfUpdate = async (
  latest: string | null,
  opts?: { readonly force?: boolean },
): Promise<void> => {
  if (updating) return;
  // Opt-out gate: skip automatic updates only when the user disabled them
  // (default on). A forced (explicit) check bypasses it — the user asked for
  // this one update.
  if (opts?.force !== true && !autoUpdateEnabled()) return;
  // Only managed compiled binaries self-update; a from-source run is `0.0.0-dev`.
  if (DAEMON_VERSION === "0.0.0-dev") return;
  if (latest === null || latest.length === 0) return;
  if (latest === DAEMON_VERSION) return; // already converged
  const target = currentTarget();
  if (target === null) {
    logWarn(
      "self-update",
      `unknown target ${process.platform}-${process.arch}`,
    );
    return;
  }
  if (recentlyAttempted(latest)) return;

  updating = true;
  const dest = process.execPath;
  const tmp = join(dirname(dest), `.openllmd.update.${process.pid}.tmp`);
  try {
    const origin = daemonEnv().cloudOrigin;
    const base = `${origin}/api/daemon/binary/${target}`;
    const [bin, expected] = await Promise.all([
      fetchBinary(base),
      fetchDigest(`${base}.sha256`),
    ]);
    const actual = createHash("sha256").update(bin).digest("hex");
    if (actual !== expected) {
      logError("self-update", "checksum mismatch — refusing update", {
        target,
        latest,
        expected,
        actual,
      });
      updating = false;
      return;
    }
    writeFileSync(tmp, bin, { mode: 0o755 });
    chmodSync(tmp, 0o755); // force mode regardless of umask
    renameSync(tmp, dest); // atomic on POSIX; running process keeps old inode
    hardenMacBinary(dest); // dequarantine + ad-hoc sign so arm64 can exec it
    // Record only AFTER a successful swap — a transient download/rename failure
    // should retry on the next tick, but a swap that doesn't converge (the
    // relaunched binary still reports the old version) must back off.
    recordAttempt(latest);
    logInfo(
      "self-update",
      `updated ${DAEMON_VERSION} → ${latest}; restarting when idle`,
    );
    await waitUntilIdle();
    process.exit(0);
  } catch (err) {
    logError("self-update", err, { target, latest });
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    updating = false; // allow a retry on the next bootstrap tick
  }
};
