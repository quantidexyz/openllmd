/**
 * Shell completion for `openllmd` — `openllmd completion <bash|zsh|fish>` emits
 * a completion script; `openllmd completion install` detects the current shell
 * (`$SHELL`) and wires it into the user's rc (idempotent). Every subcommand,
 * flag, provider, and shell is derived from the shared definitions in
 * `commands.ts`, so completion can't drift from the actual CLI surface.
 *
 * The bash/zsh scripts are sourced dynamically (`source <(openllmd completion
 * <shell>)`) so they always reflect the installed binary; fish writes a static
 * file into its completions dir.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TCompletionShell } from "./commands";
import {
  COMMANDS,
  COMPLETION_SHELLS,
  FLAGS,
  INTEGRATION_ACTIONS,
  INTEGRATION_GROUPS,
  PROVIDERS,
} from "./commands";

export type { TCompletionShell } from "./commands";

/** Top-level completion tokens: every subcommand + every flag alias. */
const TOP_LEVEL = [...COMMANDS.map((c) => c.name), ...FLAGS.map((f) => f.name)];
/** `completion`'s own argument choices. */
const COMPLETION_ARGS = [...COMPLETION_SHELLS, "install"];
/** The integration groups' shared `<install|uninstall|list>` action choices. */
const INTEGRATION_ARGS = [...INTEGRATION_ACTIONS];

const bashScript = (): string => {
  const top = TOP_LEVEL.join(" ");
  return `# openllmd bash completion
_openllmd() {
  local cur cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${top}" -- "$cur") )
    return
  fi
  case "$cmd" in
    completion) COMPREPLY=( $(compgen -W "${COMPLETION_ARGS.join(" ")}" -- "$cur") ) ;;
    set-token)  [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "${PROVIDERS.join(" ")}" -- "$cur") ) ;;
    ${INTEGRATION_GROUPS.join("|")}) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "${INTEGRATION_ARGS.join(" ")}" -- "$cur") ) ;;
  esac
}
complete -F _openllmd openllmd
`;
};

const zshScript = (): string => {
  // Descriptions are colon-free (commands.ts), so the `value:desc` specs parse.
  const specs = [
    ...COMMANDS.map((c) => `'${c.name}:${c.description}'`),
    ...FLAGS.map((f) => `'${f.name}:${f.description}'`),
  ].join("\n    ");
  return `# openllmd zsh completion
_openllmd() {
  local -a _cmds
  _cmds=(
    ${specs}
  )
  _arguments -C '1:command:->cmd' '*::arg:->args'
  case "$state" in
    cmd) _describe -t commands 'openllmd command' _cmds ;;
    args)
      case "$line[1]" in
        completion) _values 'shell' ${COMPLETION_ARGS.join(" ")} ;;
        set-token)  _values 'provider' ${PROVIDERS.join(" ")} ;;
        ${INTEGRATION_GROUPS.join("|")}) _values 'action' ${INTEGRATION_ARGS.join(" ")} ;;
      esac ;;
  esac
}
compdef _openllmd openllmd
`;
};

const fishScript = (): string => {
  const lines = COMMANDS.map(
    (c) =>
      `complete -c openllmd -n __fish_use_subcommand -a ${c.name} -d '${c.description}'`,
  );
  lines.push(
    `complete -c openllmd -n '__fish_seen_subcommand_from completion' -a '${COMPLETION_ARGS.join(" ")}'`,
    `complete -c openllmd -n '__fish_seen_subcommand_from set-token' -a '${PROVIDERS.join(" ")}'`,
    `complete -c openllmd -n '__fish_seen_subcommand_from ${INTEGRATION_GROUPS.join(" ")}' -a '${INTEGRATION_ARGS.join(" ")}'`,
    `complete -c openllmd -s h -l help -d 'Show help'`,
    `complete -c openllmd -l version -d 'Print the version'`,
  );
  return `# openllmd fish completion\ncomplete -c openllmd -f\n${lines.join("\n")}\n`;
};

export const completionScript = (shell: TCompletionShell): string => {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
  }
};

const isShell = (v: string): v is TCompletionShell =>
  (COMPLETION_SHELLS as readonly string[]).includes(v);

/** The fish completions file `install`/`uninstall` write + remove. Single
 *  source so the two paths can't drift. */
const fishCompletionPath = (): string =>
  join(homedir(), ".config", "fish", "completions", "openllmd.fish");

/** The current login shell name from `$SHELL`, or null if not recognized. */
const detectShell = (): TCompletionShell | null => {
  const sh = basename(process.env.SHELL ?? "");
  return isShell(sh) ? sh : null;
};

/** Append a line to a file once (idempotent on an exact marker substring). */
const appendOnce = (file: string, line: string, marker: string): boolean => {
  try {
    const existing = readFileSync(file, "utf-8");
    if (existing.includes(marker)) return false;
  } catch {
    // file may not exist yet — created by appendFileSync below
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `\n${line}\n`);
  return true;
};

/**
 * Install completion for the current shell by wiring it into the rc
 * (bash/zsh) or dropping a completions file (fish). Idempotent. Returns the
 * file it touched, or null when the shell is unsupported.
 */
export const installCompletion = (): string | null => {
  const shell = detectShell();
  if (shell === null) return null;
  if (shell === "fish") {
    const file = fishCompletionPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fishScript());
    return file;
  }
  const rc = join(homedir(), shell === "zsh" ? ".zshrc" : ".bashrc");
  const marker = "openllmd completion";
  appendOnce(
    rc,
    `command -v openllmd >/dev/null && source <(openllmd completion ${shell})  # openllmd-completion`,
    marker,
  );
  return rc;
};

// The trailing comment installCompletion stamps on the rc line — the stable,
// unique marker we strip on uninstall (the line text itself derives from the
// shell, so match on this).
const RC_MARKER = "# openllmd-completion";

/**
 * Remove everything {@link installCompletion} may have written: the sourced
 * line from BOTH `~/.zshrc` and `~/.bashrc` (the login shell may have changed
 * since install, so clean both) and the fish completions file. Best-effort +
 * idempotent. Returns the files it actually changed/removed (for reporting).
 * Used by `openllmd uninstall`.
 */
export const uninstallCompletion = (): string[] => {
  const touched: string[] = [];
  for (const name of [".zshrc", ".bashrc"]) {
    const rc = join(homedir(), name);
    let text: string;
    try {
      text = readFileSync(rc, "utf-8");
    } catch {
      continue; // rc doesn't exist — nothing to strip
    }
    if (!text.includes(RC_MARKER)) continue;
    const cleaned = text
      .split("\n")
      .filter((line) => !line.includes(RC_MARKER))
      .join("\n");
    try {
      writeFileSync(rc, cleaned);
      touched.push(rc);
    } catch {
      // best-effort — a read-only rc shouldn't fail the whole uninstall
    }
  }
  const fish = fishCompletionPath();
  if (existsSync(fish)) {
    try {
      rmSync(fish, { force: true });
      touched.push(fish);
    } catch {
      // best-effort
    }
  }
  return touched;
};

/**
 * Handle the `completion` subcommand. `args` is everything after `completion`.
 * Exits the process.
 */
export const runCompletion = (args: readonly string[]): never => {
  const what = args[0];
  if (what === "install") {
    const file = installCompletion();
    if (file === null) {
      process.stderr.write(
        `unsupported shell (set $SHELL to one of: ${COMPLETION_SHELLS.join(", ")}).\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `openllmd completion installed → ${file}\nOpen a new shell (or 'source ${file}') to use it.\n`,
    );
    process.exit(0);
  }
  if (what !== undefined && isShell(what)) {
    process.stdout.write(completionScript(what));
    process.exit(0);
  }
  process.stderr.write(
    `usage: openllmd completion <${COMPLETION_SHELLS.join("|")}|install>\n`,
  );
  process.exit(2);
};
