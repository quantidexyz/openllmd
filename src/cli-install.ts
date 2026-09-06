/**
 * The daemon's isolated RUN-VIEW of the vendor CLIs — a SYMLINK, never a copy.
 * There is ONE binary per CLI, the user's NON-isolated copy (installed OUT of
 * band by the user-run daemon install script or the user themselves — the daemon
 * NEVER installs a vendor CLI). The isolated path under `<stateDir>/cli/<provider>/`
 * is always a symlink to that host binary; isolation is preserved by the RUN env
 * (`cliEnv` points HOME/config at the isolated dir), not by a separate binary, so
 * credentials + config never collide with the user's personal
 * `~/.claude` / `~/.codex` / `~/.kimi-code` while the binary itself is shared.
 *
 * `cliInstallState` is the single chokepoint every delegate's `installed`/`status`
 * reads (run on every status push). It is SELF-HEALING: if the isolated symlink is
 * missing but the host binary exists, it links it before probing — so a CLI the
 * user just installed shows up on the next status push with no command. The
 * host-binary candidate paths live in `cli-paths.ts` (`hostCliCandidates`).
 */
import {
  existsSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { binarySignature } from "./bin-signature";
import type { TCliProvider } from "./cli-paths";
import {
  cliBin,
  cliConfigDir,
  cliEnv,
  cliHome,
  cliRoot,
  hostCliCandidates,
} from "./cli-paths";
import { runCapture } from "./delegation/util";

export type TCliInstallState = {
  readonly installed: boolean;
  readonly version: string | null;
};

/** Create the isolated provider dirs (root + home + config) before a write. */
const ensureIsolatedDirs = async (provider: TCliProvider): Promise<void> => {
  await mkdir(cliRoot(provider), { recursive: true });
  await mkdir(cliHome(provider), { recursive: true });
  await mkdir(cliConfigDir(provider), { recursive: true });
};

/**
 * Point the isolated CLI path (`cliBin(provider)`) at the host binary via a
 * SYMLINK — never a copy, so the isolated CLI takes no disk space. Replaces any
 * existing link/file at the isolated path so it always tracks the current host
 * binary (e.g. after the user updates their CLI). Writes ONLY into the
 * always-granted state dir (`<stateDir>/cli/<provider>/`); it merely READS the
 * host binary, so it needs no grant on the host CLI's own dir.
 */
export const linkIsolatedCli = async (
  provider: TCliProvider,
  hostBin: string,
): Promise<void> => {
  await ensureIsolatedDirs(provider);
  const dst = cliBin(provider);
  await mkdir(dirname(dst), { recursive: true });
  await rm(dst, { force: true });
  symlinkSync(hostBin, dst);
  linkSidecars(dst);
};

/**
 * Link executable SIDECARS that ship NEXT TO THE REAL host binary (the
 * resolved end of the symlink chain) into the isolated bin dir, alongside the
 * main link. Codex's tool router spawns `codex-code-mode-host` — the
 * 5.6-family web-search / code-mode host — from the INVOKED binary's own
 * directory (our isolated `bin/`), NOT the resolved target's; without the
 * sidecar link, web search on gpt-5.6-* dies with "failed to spawn code-mode
 * host … No such file or directory" (observed live 2026-07-15) while 5.4
 * (hosted-tool route) keeps working. Generic: every sibling named
 * `<binary>-*` is linked, so a future vendor sidecar is picked up without a
 * code change. Idempotent (an up-to-date link is left alone — safe on the
 * 30s `cliInstallState` self-heal path) and best-effort per entry: a sidecar
 * failure must never break the main CLI link.
 */
const linkSidecars = (isolatedBin: string): void => {
  try {
    const real = realpathSync(isolatedBin);
    const realDir = dirname(real);
    const isolatedDir = dirname(isolatedBin);
    const prefix = `${basename(isolatedBin)}-`;
    const current = new Set<string>();
    for (const entry of readdirSync(realDir)) {
      if (!entry.startsWith(prefix)) continue;
      current.add(entry);
      const target = join(realDir, entry);
      const link = join(isolatedDir, entry);
      try {
        if (readlinkSync(link) === target) continue; // already current
      } catch {
        // absent or not a symlink — (re)create below
      }
      try {
        rmSync(link, { force: true });
        symlinkSync(target, link);
      } catch {
        // per-sidecar best effort — the main CLI still runs without it
      }
    }
    // Reconcile: drop managed sidecar links whose target no longer ships
    // beside the real binary (a host update that removed/renamed one) — a
    // dangling link would otherwise shadow the vendor's own resolution.
    for (const entry of readdirSync(isolatedDir)) {
      if (!entry.startsWith(prefix) || current.has(entry)) continue;
      try {
        rmSync(join(isolatedDir, entry), { force: true });
      } catch {
        // best effort — a stale link is degraded behaviour, not a crash
      }
    }
  } catch {
    // unresolvable host binary / unreadable dir — main-link errors surface
    // through the install-state probe; sidecars just stay absent
  }
};

/**
 * Re-point the isolated main symlink at the currently-preferred host binary when
 * they diverge — the fix for an out-of-band vendor update that installs to a
 * DIFFERENT preferred path (e.g. a new `~/.codex/bin/codex` while an older
 * `~/.local/bin/codex` still exists, or a brew/npm relocation). Without this the
 * link, once created, would track the old binary forever and freeze the reported
 * version. Cheap: a `realpath` compare, with `linkIsolatedCli` (rm + symlink)
 * only when they actually differ. Best-effort — a stat/link failure leaves the
 * existing link intact and surfaces through the probe below.
 *
 * Returns `true` when the link was re-pointed (the caller must then recompute the
 * binary signature, since the resolved target changed).
 */
const reconcileIsolatedLink = async (
  provider: TCliProvider,
  bin: string,
): Promise<boolean> => {
  const host = hostCliCandidates(provider).find((c) => existsSync(c));
  if (host === undefined) return false;
  try {
    if (realpathSync(bin) === realpathSync(host)) return false;
  } catch {
    // Broken link / unresolvable host — fall through to re-link defensively.
  }
  await linkIsolatedCli(provider, host);
  return true;
};

/**
 * Is the vendor CLI the daemon runs installed + runnable? SELF-HEALING: the
 * daemon never installs, so the isolated run-view symlink is created lazily here —
 * if `cliBin(provider)` is absent but the user's host binary exists
 * (`hostCliCandidates`), link it first, then probe. A user who installs the CLI
 * out of band (the daemon install script, or by hand) therefore shows as
 * installed on the next status read with no command. Best-effort version read.
 *
 * VENDOR updates happen OUT OF BAND, WITHOUT a daemon restart (the user runs
 * `codex`/`claude`/`kimi` self-update, brew, npm, etc.), so freshness cannot
 * assume a restart clears anything. Two paths defend against a frozen version:
 *   1. The isolated main symlink is RE-RECONCILED against the preferred host
 *      candidate on every probe (not only when absent) — an update that moves
 *      the binary to a different preferred path re-points the link.
 *   2. A real `--version` re-runs when the resolved binary's stat signature
 *      changes OR the cached version is older than `CLI_VERSION_HARD_MAX_MS`
 *      (catches a stable launcher/wrapper whose own stat never moves).
 * The short TTL only throttles how often periodic status observations re-stat /
 * re-reconcile; it never pins a version past a detected binary change.
 */

/** Numeric env override (tests only) — returns `fallback` unless the var parses
 *  to a non-negative integer. Lets a test collapse the TTL / hard-max windows to
 *  drive the refresh/re-probe paths deterministically. */
const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Cache TTL — 30 s throttles the re-stat / re-reconcile on the hot status
 *  path; a detected signature change re-probes even inside this window. */
const CLI_INSTALL_STATE_TTL_MS = envMs("OPENLLM_CLI_STATE_TTL_MS", 30_000);

/** Hard ceiling on version staleness: even with an unchanged stat signature
 *  (a stable launcher that execs a versioned binary without moving its own
 *  metadata), re-spawn `--version` at least this often so an out-of-band vendor
 *  update is picked up. Model discovery is version-gated (Codex), so this bounds
 *  how long a new vendor version can stay undetected. */
const CLI_VERSION_HARD_MAX_MS = envMs(
  "OPENLLM_CLI_VERSION_MAX_MS",
  10 * 60_000,
);

/**
 * Per-spawn kill deadline for a `--version` probe — distinct from
 * {@link CLI_VERSION_HARD_MAX_MS} (a cache-staleness interval, NOT a process
 * timeout). A vendor CLI can wedge indefinitely under the isolated HOME/config
 * (a corrupt `.claude.json`, a first-run prompt with stdin ignored, a launcher
 * update/keychain probe), and a hung probe on the status sweep is what stalls a
 * boot. Resolved LAZILY on each call — NOT a module-level constant — because
 * `.env` is loaded by `daemonPort()` AFTER this module is first evaluated, so a
 * module-eval read would miss an `~/.openllm/.env` override (only a plist-injected
 * value would be visible that early). The 3s default is daemon-owned, so the
 * guard holds with no `.env` or plist edit at all. */
const cliVersionProbeTimeoutMs = (): number =>
  envMs("OPENLLM_CLI_VERSION_PROBE_TIMEOUT_MS", 3_000);

interface CliInstallCacheEntry {
  readonly result: TCliInstallState;
  readonly expiresAt: number;
  /** Stat signature of the resolved binary at probe time — an unchanged
   *  signature reuses the version instead of re-spawning `--version` (see
   *  {@link binarySignature}), unless {@link CLI_VERSION_HARD_MAX_MS} elapsed. */
  readonly signature: string | null;
  /** Wall-clock ms of the last real `--version` spawn (not a cache renewal) —
   *  gates the {@link CLI_VERSION_HARD_MAX_MS} forced re-probe. */
  readonly probedAt: number;
  /**
   * Internal only — not on {@link TCliInstallState}. True when the last spawn
   * returned no parseable version (`runCapture` null / no semver match). Such
   * an entry is still reusable while the binary signature is unchanged, so a
   * timed-out `--version` does not re-spawn on every status tick.
   */
  readonly inconclusive: boolean;
  /**
   * TTL used for this entry. After a consecutive inconclusive probe this
   * doubles (capped at {@link CLI_VERSION_HARD_MAX_MS}); a successful parse
   * resets it to {@link CLI_INSTALL_STATE_TTL_MS}. The initial inconclusive TTL
   * is also `min(base, hard-max)` so a configured hard-max below the base
   * never lets the first cache window overshoot.
   */
  readonly ttlMs: number;
}

/** Per-provider cache of `cliInstallState` results. */
const cliInstallStateCache = new Map<TCliProvider, CliInstallCacheEntry>();

/** In-flight `cliInstallState` probes — overlapping callers share one spawn. */
const cliInstallStateInFlight = new Map<
  TCliProvider,
  Promise<TCliInstallState>
>();

/**
 * Generation token to invalidate in-flight probes. Incremented on each clear
 * so concurrent probes that started before the clear do not write stale results.
 */
let cacheGeneration = 0;

const writeCacheEntry = (
  provider: TCliProvider,
  generation: number,
  entry: CliInstallCacheEntry,
): void => {
  if (generation === cacheGeneration) {
    cliInstallStateCache.set(provider, entry);
  }
};

/**
 * Clear the `cliInstallState` cache — used by tests that change
 * `OPENLLM_DAEMON_STATE_DIR` between calls, and after the isolated link is
 * re-pointed at a moved host binary (so the next read re-probes `--version`).
 * Drops in-flight joiners so a post-clear caller does not share a pre-clear
 * probe (the generation guard still discards that probe's cache write).
 */
export const clearCliInstallStateCache = (): void => {
  cliInstallStateCache.clear();
  cliInstallStateInFlight.clear();
  cacheGeneration++;
};

const nextInconclusiveTtlMs = (
  cached: CliInstallCacheEntry | undefined,
): number => {
  if (cached?.inconclusive !== true) {
    return Math.min(CLI_INSTALL_STATE_TTL_MS, CLI_VERSION_HARD_MAX_MS);
  }
  return Math.min(cached.ttlMs * 2, CLI_VERSION_HARD_MAX_MS);
};

const probeCliInstallState = async (
  provider: TCliProvider,
): Promise<TCliInstallState> => {
  const cached = cliInstallStateCache.get(provider);
  const now = Date.now();

  // Capture generation at probe start to guard against stale writes after clear.
  const generation = cacheGeneration;

  const bin = cliBin(provider);
  if (!existsSync(bin)) {
    // No isolated run-view yet — link it from the host binary if that exists.
    const host = hostCliCandidates(provider).find((c) => existsSync(c));
    if (host === undefined) {
      const result: TCliInstallState = { installed: false, version: null };
      writeCacheEntry(provider, generation, {
        result,
        expiresAt: now + CLI_INSTALL_STATE_TTL_MS,
        signature: null,
        probedAt: now,
        inconclusive: false,
        ttlMs: CLI_INSTALL_STATE_TTL_MS,
      });
      return result;
    }
    await linkIsolatedCli(provider, host);
  } else if (cached !== undefined && cached.expiresAt <= now) {
    // Link exists AND we've probed it before (a genuine mid-lifetime REFRESH,
    // not a cold start): RE-RECONCILE it against the preferred host candidate so
    // an out-of-band update that moved the binary re-points the link. Gated to
    // the refresh path — a cold daemon trusts its existing link (whatever the
    // user last linked), and a `realpath` compare per observation would be needless
    // churn. A re-point changes the resolved target, forcing a `--version` probe.
    await reconcileIsolatedLink(provider, bin);
  }
  const notInstalled: TCliInstallState = { installed: false, version: null };
  if (!existsSync(bin)) {
    writeCacheEntry(provider, generation, {
      result: notInstalled,
      expiresAt: now + CLI_INSTALL_STATE_TTL_MS,
      signature: null,
      probedAt: now,
      inconclusive: false,
      ttlMs: CLI_INSTALL_STATE_TTL_MS,
    });
    return notInstalled;
  }

  // The resolved binary's stat signature — the cheap change-detector. Computed
  // even on the TTL-fresh path so a binary swap re-probes immediately instead of
  // waiting out the TTL.
  const signature = binarySignature(bin);
  const reusable =
    cached?.result.installed === true &&
    (cached.result.version !== null || cached.inconclusive) &&
    signature !== null &&
    cached.signature === signature &&
    generation === cacheGeneration;

  // TTL-fresh AND the binary hasn't changed. Successful versions also stay
  // inside the hard-max staleness ceiling; inconclusive entries honour only
  // their (backing-off) TTL — the hard-max is the cap on that TTL, not a
  // second forced re-probe clock.
  if (cached !== undefined && cached.expiresAt > now && reusable) {
    if (
      cached.inconclusive ||
      now - cached.probedAt < CLI_VERSION_HARD_MAX_MS
    ) {
      return cached.result;
    }
  }

  // Self-heal SIDECARS for installs whose main link predates sidecar linking
  // (the main link existing skips `linkIsolatedCli` above forever). Idempotent
  // — an up-to-date link is a readlink+compare, so the 30s probe stays cheap.
  linkSidecars(bin);

  // Past the TTL but the binary is unchanged AND still inside the hard-max
  // window → reuse a SUCCESSFUL version without re-spawning `--version`, just
  // renewing the TTL. Inconclusive entries must re-spawn when their TTL
  // expires (that is the backoff clock).
  if (
    reusable &&
    cached !== undefined &&
    !cached.inconclusive &&
    now - cached.probedAt < CLI_VERSION_HARD_MAX_MS
  ) {
    writeCacheEntry(provider, generation, {
      result: cached.result,
      expiresAt: now + CLI_INSTALL_STATE_TTL_MS,
      signature,
      probedAt: cached.probedAt,
      inconclusive: false,
      ttlMs: CLI_INSTALL_STATE_TTL_MS,
    });
    return cached.result;
  }

  // `--version` runs as a read-only probe: skip the sandbox shim so the version
  // check can execute a deep release binary path directly (including symlinked
  // release trees like Codex), while still only re-running on change / stale
  // thresholds.
  const out = await runCapture([bin, "--version"], cliEnv(provider), {
    probe: true,
    timeoutMs: cliVersionProbeTimeoutMs(),
  });
  const version = out?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  const inconclusive = version === null;
  const ttlMs = inconclusive
    ? nextInconclusiveTtlMs(cached)
    : CLI_INSTALL_STATE_TTL_MS;
  const result: TCliInstallState = { installed: true, version };
  writeCacheEntry(provider, generation, {
    result,
    expiresAt: now + ttlMs,
    signature,
    probedAt: now,
    inconclusive,
    ttlMs,
  });
  return result;
};

export const cliInstallState = async (
  provider: TCliProvider,
): Promise<TCliInstallState> => {
  const existing = cliInstallStateInFlight.get(provider);
  if (existing !== undefined) return existing;
  const pending = probeCliInstallState(provider).finally(() => {
    if (cliInstallStateInFlight.get(provider) === pending) {
      cliInstallStateInFlight.delete(provider);
    }
  });
  cliInstallStateInFlight.set(provider, pending);
  return pending;
};
