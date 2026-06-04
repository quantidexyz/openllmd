/**
 * Canonical `openllmd` CLI surface — the SINGLE source of truth for the
 * subcommands, flags, providers, and completion shells. `cli.ts` dispatches and
 * renders `--help` from this, and `completion.ts` derives its bash/zsh/fish
 * scripts from it, so the help text and the completion scripts can't drift
 * apart (they did, which is what this consolidation fixes).
 *
 * Descriptions are deliberately free of `:` and `'` so they embed into the
 * zsh/bash/fish completion grammars without escaping.
 */
export type TCommand = {
  readonly name: string;
  /** Positional-arg hint shown in help, e.g. `<provider> <token>`. */
  readonly args?: string;
  readonly description: string;
};

export const COMMANDS: readonly TCommand[] = [
  { name: "start", description: "Register and start in self-restore mode" },
  { name: "stop", description: "Stop and disable all self-restore" },
  { name: "status", description: "Show service registration and run status" },
  { name: "restart", description: "Stop then start the daemon" },
  {
    name: "skill",
    args: "<install|uninstall|list> [slug]",
    description: "Install or remove a Claude Code skill on this machine",
  },
  {
    name: "plugin",
    args: "<install|uninstall|list> [slug]",
    description: "Install or remove a Claude Code plugin on this machine",
  },
  {
    name: "setup",
    args: "<install|uninstall|list> [id]",
    description: "Install or remove a client setup on this machine",
  },
  {
    name: "auto-update",
    args: "<on|off|status>",
    description:
      "Enable or disable automatic daemon self-updates (on by default)",
  },
  {
    name: "uninstall",
    args: "[--yes]",
    description: "Remove the daemon and ALL state (credentials, service)",
  },
  {
    name: "set-token",
    args: "<provider> <token>",
    description: "Store a subscription setup-token (omit token to clear)",
  },
  {
    name: "completion",
    args: "<bash|zsh|fish|install>",
    description: "Print or install shell completion",
  },
  { name: "help", description: "Show help" },
  { name: "version", description: "Print the version" },
] as const;

export type TFlag = { readonly name: string; readonly description: string };

export const FLAGS: readonly TFlag[] = [
  { name: "-h", description: "Show help" },
  { name: "--help", description: "Show help" },
  { name: "--version", description: "Print the version" },
] as const;

export const PROVIDERS = ["claude_code", "chatgpt", "kimi_code"] as const;

/** Action choices for the `skill` / `plugin` / `setup` integration groups. */
export const INTEGRATION_GROUPS = ["skill", "plugin", "setup"] as const;
export const INTEGRATION_ACTIONS = ["install", "uninstall", "list"] as const;

/** Argument choices for the `auto-update` subcommand. */
export const AUTO_UPDATE_ACTIONS = ["on", "off", "status"] as const;

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type TCompletionShell = (typeof COMPLETION_SHELLS)[number];
