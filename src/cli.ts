/**
 * `openllmd` command-line dispatch.
 *
 * The same binary is BOTH the long-running daemon (run with no args by the
 * launch agent / systemd unit) AND a small management CLI. `runCli()` handles
 * the management subcommands and returns `true` when one was handled (the
 * caller must NOT boot the server); it returns `false` only for the bare
 * no-arg invocation, which is the server boot path.
 *
 *   openllmd                      run the daemon (used by the service)
 *   openllmd start                register + start in self-restore mode
 *   openllmd stop                 stop + disable self-restore
 *   openllmd status               show service + run status
 *   openllmd restart              stop then start
 *   openllmd set-token <p> <tok>  store a subscription setup-token
 *   openllmd completion <shell>   emit / install shell completion
 *   openllmd -h | --help          show help
 *   openllmd --version            show version
 */
import { COMMANDS, FLAGS } from "./commands";
import { runCompletion } from "./completion";
import {
  serviceRestart,
  serviceStart,
  serviceStatus,
  serviceStop,
} from "./service";
import { setSetupToken } from "./setup-token";
import { DAEMON_VERSION } from "./version";

const COL = 36;
const row = (left: string, desc: string): string =>
  `  ${left.padEnd(COL)}${desc}`;

// Rendered from the shared command/flag definitions so help and completion
// (completion.ts, same source) can't drift.
const HELP = `openllmd — OpenLLM local daemon (v${DAEMON_VERSION})

Usage:
  openllmd [command]

Commands:
${row("(none)", "Run the daemon in the foreground (used by the service)")}
${COMMANDS.map((c) => row(c.args ? `${c.name} ${c.args}` : c.name, c.description)).join("\n")}

Flags:
${FLAGS.map((f) => row(f.name, f.description)).join("\n")}

State lives under ~/.openllm (override with OPENLLM_DAEMON_STATE_DIR).
`;

/**
 * The daemon's user arguments. Bun keeps the entry path at `argv[1]` in BOTH
 * forms — a from-source run (`bun src/main.ts …` → `argv[1]` is the script) and
 * a compiled standalone binary (`argv[1]` is the embedded `/$bunfs/root/…`
 * entry) — so user args always start at index 2.
 */
const userArgs = (): string[] => process.argv.slice(2);

/** Persist (or clear) a subscription setup-token, then exit. */
const runSetToken = (args: readonly string[]): never => {
  const provider = args[0];
  const token = args[1] ?? null;
  if (provider === undefined || provider.length === 0) {
    process.stderr.write("usage: openllmd set-token <provider> <token>\n");
    process.exit(2);
  }
  if (!setSetupToken(provider, token)) {
    process.stderr.write(
      "refused: that doesn't look like a setup token (expected sk-ant-oat01-…)\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `setup token ${token !== null && token.length > 0 ? "saved" : "cleared"} for ${provider}\n`,
  );
  process.exit(0);
};

export const runCli = (): boolean => {
  const args = userArgs();
  if (args.length === 0) return false; // bare invocation → boot the server

  if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.includes("--version") || args[0] === "version") {
    process.stdout.write(`openllmd v${DAEMON_VERSION}\n`);
    process.exit(0);
  }

  const rest = args.slice(1);
  switch (args[0]) {
    case "start":
      serviceStart();
      process.exit(0);
      break;
    case "stop":
      serviceStop();
      process.exit(0);
      break;
    case "restart":
      serviceRestart();
      process.exit(0);
      break;
    case "status":
      serviceStatus();
      process.exit(0);
      break;
    case "set-token":
      runSetToken(rest);
      break;
    case "completion":
      runCompletion(rest);
      break;
    default:
      process.stderr.write(`unknown command: ${args[0]}\n\n${HELP}`);
      process.exit(2);
  }
  return true;
};
