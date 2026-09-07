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
import type { TCliProvider } from "./cli-paths";
import {
  cliBin,
  cliConfigDir,
  cliEnv,
  cliHome,
  cliRoot,
  hostCliCandidates,
} from "./cli-paths";
import { cliVersion } from "./delegation/util";

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
 *      candidate on a throttled refresh (not only when absent) — an update that
 *      moves the binary to a different preferred path re-points the link.
 *   2. `--version` is owned by the shared stamp-keyed cache (`cliVersion`):
 *      an unchanged resolved binary is never re-spawned, including after a
 *      timeout. Cached timeout means installed / version unknown, not absent.
 * The short TTL only throttles how often periodic status observations re-stat /
 * re-reconcile the isolated link; it never pins or expires a version.
 */

/** Numeric env override (tests only) — returns `fallback` unless the var parses
 *  to a non-negative integer. Lets a test collapse the reconcile TTL. */
const envMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Cache TTL — 30 s throttles the re-stat / re-reconcile on the hot status
 *  path. Version identity is NOT gated here. */
const CLI_INSTALL_STATE_TTL_MS = envMs("OPENLLM_CLI_STATE_TTL_MS", 30_000);

/**
 * Per-spawn kill deadline for a `--version` probe. A vendor CLI can wedge
 * under the isolated HOME/config; the shared cache stores that completed
 * timeout until the binary stamp changes. Resolved LAZILY because `.env` is
 * loaded by `daemonPort()` AFTER this module is first evaluated.
 */
const cliVersionProbeTimeoutMs = (): number =>
  envMs("OPENLLM_CLI_VERSION_PROBE_TIMEOUT_MS", 3_000);

/** Per-provider last-reconcile throttle. Version spawns live in `cliVersion`. */
const cliInstallReconcileUntil = new Map<TCliProvider, number>();

/** In-flight `cliInstallState` probes — overlapping callers share one reconcile. */
const cliInstallStateInFlight = new Map<
  TCliProvider,
  Promise<TCliInstallState>
>();

/**
 * Clear the reconcile throttle — used by tests that change
 * `OPENLLM_DAEMON_STATE_DIR`. Does NOT drop the shared version-stamp cache.
 */
export const clearCliInstallStateCache = (): void => {
  cliInstallReconcileUntil.clear();
  cliInstallStateInFlight.clear();
};

const parseVendorVersion = (out: string | null): string | null =>
  out?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;

const probeCliInstallState = async (
  provider: TCliProvider,
): Promise<TCliInstallState> => {
  const now = Date.now();
  const bin = cliBin(provider);
  if (!existsSync(bin)) {
    const host = hostCliCandidates(provider).find((c) => existsSync(c));
    if (host === undefined) {
      return { installed: false, version: null };
    }
    await linkIsolatedCli(provider, host);
  } else {
    const until = cliInstallReconcileUntil.get(provider);
    if (until !== undefined && until <= now) {
      await reconcileIsolatedLink(provider, bin);
      cliInstallReconcileUntil.set(provider, now + CLI_INSTALL_STATE_TTL_MS);
    }
  }
  if (!existsSync(bin)) {
    return { installed: false, version: null };
  }

  linkSidecars(bin);
  if (!cliInstallReconcileUntil.has(provider)) {
    cliInstallReconcileUntil.set(provider, now + CLI_INSTALL_STATE_TTL_MS);
  }

  const out = await cliVersion(bin, cliEnv(provider), {
    timeoutMs: cliVersionProbeTimeoutMs(),
  });
  return { installed: true, version: parseVendorVersion(out) };
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
