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
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  cliBin,
  cliConfigDir,
  cliEnv,
  cliHome,
  cliRoot,
  type TCliProvider,
} from "./cli-paths";
import { runCapture } from "./delegation/util";

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

/**
 * Run the vendor install script for `provider`, redirected into the
 * isolated provider dir. Idempotent: if the binary is already present we
 * skip the network call. Pipes the script to a shell with `cliEnv`
 * merged (so it installs into our dir, uses our home, and skips shell-rc
 * edits). Returns the resulting install state + captured output.
 */
export const installCli = async (
  provider: TCliProvider,
): Promise<TCliInstallResult> => {
  // Fast-path: already installed.
  const existing = await cliInstallState(provider);
  if (existing.installed) {
    return { installed: true, version: existing.version, output: "" };
  }

  // Ensure the isolated dirs exist before the script writes into them.
  await mkdir(cliRoot(provider), { recursive: true });
  await mkdir(cliHome(provider), { recursive: true });
  await mkdir(cliConfigDir(provider), { recursive: true });

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
