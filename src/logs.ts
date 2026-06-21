/**
 * `openllmd logs [-f] [-n N]` — show or follow the daemon's log.
 *
 * Linux: prefer the systemd journal (`journalctl --user -u openllmd.service`) —
 * it captures the native crash/OOM/signal output the app logger can't reach
 * (the daemon's own `~/.openllm/openllmd.log` only has what it managed to write
 * before dying). Falls back to tailing the app log file when `journalctl` is
 * absent or the unit isn't registered (a from-source run).
 * macOS: tail the app log file (`~/.openllm/openllmd.log`).
 *
 * `-f`/`--follow` streams until Ctrl-C; `-n N`/`--lines N` sets the initial tail
 * (default 200). Implemented by exec-ing `journalctl`/`tail` with INHERITED
 * stdio so the follow stream + Ctrl-C behave exactly as running them by hand.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

/** Initial tail length when `-n`/`--lines` isn't given. */
export const DEFAULT_LOG_LINES = 200;
const UNIT = "openllmd.service";
const isMac = process.platform === "darwin";

export type TLogsOpts = { readonly follow: boolean; readonly lines: number };

/**
 * Parse `logs` args: `-f`/`--follow`, and `-n N` / `--lines N` / `-n10` for the
 * initial line count. Returns null on a malformed/unknown token so the caller
 * prints usage and exits non-zero. Pure — unit-testable without spawning.
 */
export const parseLogsArgs = (args: readonly string[]): TLogsOpts | null => {
  let follow = false;
  let lines = DEFAULT_LOG_LINES;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a === "--follow") {
      follow = true;
      continue;
    }
    let raw: string | undefined;
    if (a === "-n" || a === "--lines") {
      raw = args[++i]; // value is the next token
    } else if (a.startsWith("-n")) {
      raw = a.slice(2); // glued form: -n50
    } else {
      return null; // unknown token
    }
    if (raw === undefined) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0 || String(n) !== raw.trim()) return null;
    lines = n;
  }
  return { follow, lines };
};

/** journalctl present AND the unit known to the user manager (exit 0). */
const journalAvailable = (): boolean =>
  spawnSync("journalctl", ["--user", "--unit", UNIT, "-n", "0"], {
    stdio: "ignore",
  }).status === 0;

const tailFile = (opts: TLogsOpts): number => {
  const file = join(stateDir(), "openllmd.log");
  if (!existsSync(file)) {
    process.stderr.write(`no log file yet at ${file}\n`);
    return 1; // distinguish "nothing to show" from a clean tail for `$?` callers
  }
  const args = ["-n", String(opts.lines)];
  if (opts.follow) args.push("-F"); // -F follows across rotation (.log → .log.1)
  args.push(file);
  return spawnSync("tail", args, { stdio: "inherit" }).status ?? 0;
};

const tailJournal = (opts: TLogsOpts): number => {
  const args = ["--user", "--unit", UNIT, "-n", String(opts.lines)];
  if (opts.follow) args.push("-f");
  return spawnSync("journalctl", args, { stdio: "inherit" }).status ?? 0;
};

/** Run the `logs` subcommand. `args` is everything after `logs`. Exits. */
export const runLogs = (args: readonly string[]): never => {
  const opts = parseLogsArgs(args);
  if (opts === null) {
    process.stderr.write("usage: openllmd logs [-f] [-n N]\n");
    process.exit(2);
  }
  // Linux → journald (richer; native crash output), file fallback. macOS → file.
  const code =
    !isMac && journalAvailable() ? tailJournal(opts) : tailFile(opts);
  process.exit(code);
};
