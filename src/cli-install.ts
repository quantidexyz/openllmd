/**
 * Install / locate the daemon's OWN isolated copies of the vendor CLIs,
 * so it never collides with the user's personal `~/.claude` / `~/.codex`
 * / `~/.kimi-code` setups. Each CLI is installed under
 * `<stateDir>/cli/<provider>/` and run with an isolated home (see
 * `cli-paths.ts`). This is the SINGLE isolated-CLI install path: the
 * Claude harness (`tests/matrix/claude-harness/harness.ts`) reuses it
 * rather than maintaining its own download.
 *
 * All three install via the OFFICIAL vendor script, with the install
 * location + home redirected into the provider dir via `cliEnv`:
 *   claude → https://claude.ai/install.sh
 *   codex  → https://chatgpt.com/codex/install.sh
 *   kimi   → https://code.kimi.com/kimi-code/install.sh
 */
import { chmodSync, copyFileSync, existsSync, realpathSync } from "node:fs";
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

const INSTALL_SCRIPT: Readonly<Record<TCliProvider, string>> = {
  claude_code: "https://claude.ai/install.sh",
  chatgpt: "https://chatgpt.com/codex/install.sh",
  kimi_code: "https://code.kimi.com/kimi-code/install.sh",
};

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

/**
 * Install fast path: ADOPT the user's already-installed non-isolated vendor CLI
 * by copying its binary into the isolated env — skipping the upstream download
 * entirely (no network, instant onboarding, no duplicate bytes pulled). For each
 * candidate (`cli-paths.ts` `hostCliCandidates`, priority order) it resolves
 * symlinks to the real binary, copies it to the isolated bin path, and VERIFIES
 * it actually runs there (`cliInstallState` → `<bin> --version` under the
 * isolation env). A candidate that can't be read (OS sandbox), copied, or run
 * isolated (a wrapper script, wrong arch, missing deps) is discarded so the next
 * candidate — and ultimately the download path — still gets a chance.
 *
 * Returns the install state on success, or null when no candidate yields a
 * working binary (the caller then downloads as before). `candidates` is
 * injectable for tests; production callers use the default.
 */
export const adoptHostCli = async (
  provider: TCliProvider,
  candidates: readonly string[] = hostCliCandidates(provider),
): Promise<TCliInstallResult | null> => {
  const dst = cliBin(provider);
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      // Follow symlinks to the real binary — the launcher in ~/.local/bin is
      // often a symlink into a versions dir; copying the link would dangle.
      const real = realpathSync(candidate);
      if (real === dst) continue;
      await ensureIsolatedDirs(provider);
      await mkdir(dirname(dst), { recursive: true });
      copyFileSync(real, dst);
      chmodSync(dst, 0o755);
      // Verify it actually RUNS isolated: require a parsed version, not mere
      // existence (`cliInstallState.installed` is true for any present file). A
      // successful `--version` is the proof the copied binary is self-contained
      // and runnable under the isolation env.
      const state = await cliInstallState(provider);
      if (state.installed && state.version !== null) {
        logInfo("cli-install", `adopted host ${provider} CLI (no download)`, {
          provider,
          source: real,
          version: state.version,
        });
        return { installed: true, version: state.version, output: "" };
      }
      // Copied but doesn't run isolated — discard and try the next candidate.
      await rm(dst, { force: true });
    } catch {
      // Unreadable source (sandbox deny), copy failure, etc. — try next.
    }
  }
  return null;
};

/**
 * Provision the isolated CLI for `provider`. Idempotent. Order:
 *   1. already installed → no-op;
 *   2. ADOPT the user's non-isolated CLI binary if present (fast, offline);
 *   3. otherwise run the vendor install script, redirected into the isolated
 *      provider dir (`cliEnv` points HOME/install-dir/TMPDIR inside it and skips
 *      shell-rc edits). Returns the resulting install state + captured output.
 */
export const installCli = async (
  provider: TCliProvider,
): Promise<TCliInstallResult> => {
  // Fast-path: already installed.
  const existing = await cliInstallState(provider);
  if (existing.installed) {
    return { installed: true, version: existing.version, output: "" };
  }

  // Fast-path: adopt the user's existing non-isolated CLI binary (no download).
  const adopted = await adoptHostCli(provider);
  if (adopted !== null) return adopted;

  // Ensure the isolated dirs exist before the script writes into them.
  await ensureIsolatedDirs(provider);

  // `curl -fsSL <url> | bash` with the isolation env merged. We run it
  // through a shell so the vendor script's own pipeline works verbatim.
  const url = INSTALL_SCRIPT[provider];
  const proc = Bun.spawn(["bash", "-c", `curl -fsSL ${url} | bash`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...cliEnv(provider) },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const output = `${stdout}${stderr}`.trim();

  const state = await cliInstallState(provider);
  return {
    installed: state.installed,
    version: state.version,
    // Surface the tail of the installer output when it didn't produce a
    // working binary, so the dashboard can show why.
    output: state.installed ? "" : output.slice(-500),
  };
};
