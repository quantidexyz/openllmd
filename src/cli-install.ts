/**
 * Provision the daemon's isolated view of the vendor CLIs WITHOUT duplicating
 * any bytes on disk. There is ONE binary per CLI — the user's NON-isolated copy
 * — and the isolated path under `<stateDir>/cli/<provider>/` is always a
 * SYMLINK to it. Isolation is preserved by the RUN env (`cliEnv` points
 * HOME/config at the isolated dir), not by a separate binary, so credentials +
 * config never collide with the user's personal `~/.claude` / `~/.codex` /
 * `~/.kimi-code` while the binary itself is shared.
 *
 * Single install path (no reverse copy): if the user already has the CLI (or
 * ran the integrations setup first, which installs it), it's reused as-is;
 * otherwise the OFFICIAL vendor installer runs ONCE for the non-isolated
 * location. Either way the isolated path is then symlinked to it:
 *   claude → https://claude.ai/install.sh
 *   codex  → https://chatgpt.com/codex/install.sh
 *   kimi   → https://code.kimi.com/kimi-code/install.sh
 */
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  cliBin,
  cliConfigDir,
  cliEnv,
  cliHome,
  cliRoot,
  hostCliCandidates,
  type TCliProvider,
} from "./cli-paths";
import { runCapture } from "./delegation/util";
import { logInfo } from "./logger";
import { daemonTempDir } from "./sandbox/working-set";

const INSTALL_SCRIPT: Readonly<Record<TCliProvider, string>> = {
  claude_code: "https://claude.ai/install.sh",
  chatgpt: "https://chatgpt.com/codex/install.sh",
  kimi_code: "https://code.kimi.com/kimi-code/install.sh",
  // ⚠️ RESEARCH-UNVERIFIED: the official Grok Build (`x.ai/cli`) curl
  // installer URL. Confirm the canonical script URL (or switch to the npm
  // install path) before shipping — x.ai/cli is Cloudflare-walled.
  grok: "https://x.ai/cli/install.sh",
};

/** Hard ceiling for a vendor install — a stalled download/install is killed so
 *  it can't wedge the daemon's serial control loop. Generous (binaries are
 *  100MB+), short enough to fail visibly rather than hang forever. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export type TCliInstallState = {
  readonly installed: boolean;
  readonly version: string | null;
};

/** Is the isolated binary present + executable? Best-effort version read. */
export const cliInstallState = async (
  provider: TCliProvider,
): Promise<TCliInstallState> => {
  const bin = cliBin(provider);
  if (!existsSync(bin)) return { installed: false, version: null };
  const out = await runCapture([bin, "--version"], cliEnv(provider));
  const version = out?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  return { installed: true, version };
};

export type TCliInstallResult = {
  readonly installed: boolean;
  readonly version: string | null;
  /** Trimmed installer output (last lines), for surfacing failures. */
  readonly output: string;
};

/** Create the isolated provider dirs (root + home + config) before a write. */
const ensureIsolatedDirs = async (provider: TCliProvider): Promise<void> => {
  await mkdir(cliRoot(provider), { recursive: true });
  await mkdir(cliHome(provider), { recursive: true });
  await mkdir(cliConfigDir(provider), { recursive: true });
};

export type TEnsureHostResult = {
  /** Path to the user's non-isolated CLI binary, or null if it couldn't be
   *  provisioned. */
  readonly path: string | null;
  /** Installer output tail when an install was attempted and failed. */
  readonly output: string;
};

/**
 * Ensure the user's NON-isolated vendor CLI exists, returning its binary path.
 * The SINGLE install path: if the CLI is already present (the user had it, or
 * the integrations setup installed it first) it's reused untouched; otherwise
 * the OFFICIAL vendor installer runs ONCE for the default (non-isolated)
 * location. No isolated copy is ever downloaded.
 *
 * The install runs with the DEFAULT env (so the binary lands in the user's own
 * `~/.local/bin` etc. and the installer wires up PATH) — only `TMPDIR` is
 * redirected to a sandbox-granted dir so the installer's `mktemp` doesn't EACCES
 * on the ungranted `/tmp`. `candidates` is injectable for tests.
 */
export const ensureHostCli = async (
  provider: TCliProvider,
  candidates: readonly string[] = hostCliCandidates(provider),
): Promise<TEnsureHostResult> => {
  const present = candidates.find((c) => existsSync(c));
  if (present !== undefined) return { path: present, output: "" };

  const url = INSTALL_SCRIPT[provider];
  const proc = Bun.spawn(["bash", "-c", `curl -fsSL ${url} | bash`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMPDIR: daemonTempDir() },
  });
  // Bound the installer so a stalled download/install can't wedge the
  // serial control loop forever — kill it and surface a timeout.
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, INSTALL_TIMEOUT_MS);
  let output: string;
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    output = `${stdout}${stderr}`.trim();
  } finally {
    clearTimeout(killTimer);
  }
  if (timedOut) {
    return {
      path: null,
      output: `timed out after ${INSTALL_TIMEOUT_MS / 1000}s installing ${provider}\n${output.slice(-400)}`,
    };
  }

  const installed = candidates.find((c) => existsSync(c));
  return {
    path: installed ?? null,
    output: installed !== undefined ? "" : output.slice(-500),
  };
};

/**
 * Point the isolated CLI path (`cliBin(provider)`) at the host binary via a
 * SYMLINK — never a copy, so the isolated CLI takes no disk space. Replaces any
 * existing link/file at the isolated path so it always tracks the current host
 * binary (e.g. after the user updates their CLI).
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
};

/**
 * Provision the isolated CLI for `provider`. Idempotent. Order:
 *   1. isolated symlink already present + runnable → no-op;
 *   2. ensure the user's NON-isolated CLI exists (reuse, else official install);
 *   3. SYMLINK the isolated path to it (no copy — zero duplicate bytes).
 * Isolation comes from the run env (`cliEnv`), not a separate binary.
 */
export const installCli = async (
  provider: TCliProvider,
): Promise<TCliInstallResult> => {
  // Fast-path: the isolated path is ALREADY a symlink that resolves to a
  // runnable binary. A regular FILE here is a legacy COPY (from the older
  // copy-based daemon) — deliberately fall through so it gets replaced by a
  // symlink, reclaiming the duplicate bytes.
  const dst = cliBin(provider);
  if (existsSync(dst) && lstatSync(dst).isSymbolicLink()) {
    const existing = await cliInstallState(provider);
    if (existing.installed && existing.version !== null) {
      return { installed: true, version: existing.version, output: "" };
    }
  }

  // Ensure the single (non-isolated) binary exists — reuse or install once.
  const host = await ensureHostCli(provider);
  if (host.path === null) {
    return { installed: false, version: null, output: host.output };
  }

  // Point the isolated CLI at it (symlink — no duplicate data).
  await linkIsolatedCli(provider, host.path);

  const state = await cliInstallState(provider);
  if (state.installed && state.version !== null) {
    logInfo("cli-install", `linked isolated ${provider} CLI → host (no copy)`, {
      provider,
      host: host.path,
      version: state.version,
    });
  }
  return {
    installed: state.installed && state.version !== null,
    version: state.version,
    output:
      state.installed && state.version !== null
        ? ""
        : "isolated symlink did not resolve to a runnable binary",
  };
};
