/**
 * Filesystem layout + isolated-run environment for the daemon's OWN copies
 * of the vendor CLIs. Each CLI is installed under
 * `<stateDir>/cli/<provider>/` and ALWAYS run with its home/config pointed
 * inside that dir, so it never reads or writes the user's personal
 * `~/.claude` / `~/.codex` / `~/.kimi-code` state (which they may be using
 * interactively). The Claude harness
 * (`tests/matrix/claude-harness/harness.ts`) runs the SAME isolated CLI
 * via `cliBin`/`cliEnv` rather than installing its own.
 *
 *   <stateDir>/cli/<provider>/
 *     bin/<binary>     the isolated CLI executable
 *     home/            the CLI's home/config + credentials (isolated)
 */
import { join } from "node:path";
import type { TSubscriptionProviderSlug } from "@quantidexyz/openllmp";
import { stateDir } from "./env";

/** The providers with an isolated CLI — exactly the closed
 *  `SubscriptionProviderSlug` vocabulary of the control schema, so a slug
 *  that reaches a CLI path provably came through the typed command union. */
export type TCliProvider = TSubscriptionProviderSlug;

// Where the vendor installer drops the binary, RELATIVE to the provider
// root. (Run/install env knobs live in `cliEnv` below, not here.)
type TCliSpec = {
  readonly binRel: string;
};

const SPECS: Readonly<Record<TCliProvider, TCliSpec>> = {
  // `claude install` (run by claude.ai/install.sh under our HOME) places
  // the launcher at $HOME/.local/bin/claude.
  claude_code: { binRel: "home/.local/bin/claude" },
  // codex install.sh with CODEX_INSTALL_DIR=<root>/bin → <root>/bin/codex.
  chatgpt: { binRel: "bin/codex" },
  // kimi install.sh with KIMI_INSTALL_DIR=<root> → <root>/bin/kimi.
  kimi_code: { binRel: "bin/kimi" },
};

export const cliRoot = (provider: TCliProvider): string =>
  join(stateDir(), "cli", provider);

/** The CLI's isolated home/config dir (passed as the CLI's home env). */
export const cliHome = (provider: TCliProvider): string =>
  join(cliRoot(provider), "home");

/** Absolute path to the installed isolated binary. */
export const cliBin = (provider: TCliProvider): string =>
  join(cliRoot(provider), SPECS[provider].binRel);

/**
 * The CLI's home/config root as the CLI itself sees it (the value of its
 * home env var). Delegates derive their credential-store paths from this
 * so the read location and the `cliEnv` run location never drift.
 *   claude → <home>/.claude   codex → <home>/.codex   kimi → <home>/.kimi-code
 */
export const cliConfigDir = (provider: TCliProvider): string => {
  const home = cliHome(provider);
  switch (provider) {
    case "claude_code":
      return join(home, ".claude");
    case "chatgpt":
      return join(home, ".codex");
    case "kimi_code":
      return join(home, ".kimi-code");
  }
};

/**
 * Environment overrides that (1) isolate the CLI's runtime home and
 * (2) — at INSTALL time — redirect where the vendor script drops the
 * binary. Merge onto `process.env` for every spawn of an isolated CLI.
 *
 * All three get `HOME` pointed at the isolated home (isolates Claude's
 * binary + state, and is the floor for the others). Codex/Kimi also get
 * their explicit install-dir + home knobs and PATH-edit suppression so
 * the installer doesn't touch the user's shell profiles.
 */
export const cliEnv = (provider: TCliProvider): Record<string, string> => {
  const home = cliHome(provider);
  const root = cliRoot(provider);
  const config = cliConfigDir(provider);
  switch (provider) {
    case "claude_code":
      return {
        HOME: home,
        // Claude reads its config/credentials from CLAUDE_CONFIG_DIR
        // (defaults to $HOME/.claude); pin it to the isolated home so
        // login/status/usage all use it, never the user's.
        CLAUDE_CONFIG_DIR: config,
      };
    case "chatgpt":
      return {
        HOME: home,
        CODEX_HOME: config,
        CODEX_INSTALL_DIR: join(root, "bin"),
        // Skip interactive prompts during the scripted install.
        CODEX_NON_INTERACTIVE: "1",
      };
    case "kimi_code":
      return {
        HOME: home,
        KIMI_CODE_HOME: config,
        KIMI_INSTALL_DIR: root,
        // Don't edit the user's shell rc files.
        KIMI_NO_MODIFY_PATH: "1",
      };
  }
};
