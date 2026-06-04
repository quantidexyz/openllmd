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
 *   openllmd skill  <install|uninstall|list> [slug]   manage a Claude Code skill
 *   openllmd plugin <install|uninstall|list> [slug]   manage a Claude Code plugin
 *   openllmd setup  <install|uninstall|list> [id]     manage a client setup
 *   openllmd uninstall [--yes]    remove the daemon + ALL state (credentials)
 *   openllmd set-token <p> <tok>  store a subscription setup-token
 *   openllmd completion <shell>   emit / install shell completion
 *   openllmd -h | --help          show help
 *   openllmd --version            show version
 */
import { COMMANDS, FLAGS } from "./commands";
import { runCompletion } from "./completion";
import { daemonEnv } from "./env";
import type { TIntegrationAction, TIntegrationKind } from "./integrations";
import { runIntegration } from "./integrations";
import { logError } from "./logger";
import {
  serviceRestart,
  serviceStart,
  serviceStatus,
  serviceStop,
} from "./service";
import { setSetupToken } from "./setup-token";
import { runUninstall } from "./uninstall";
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

// The `list` endpoint per integration group (setup is singular + keyed by id).
const LIST_PATH: Record<TIntegrationKind, string> = {
  skill: "/api/skills",
  plugin: "/api/plugins",
  setup: "/api/setup/options",
};

const integrationUsage = (kind: TIntegrationKind): never => {
  process.stderr.write(
    `usage: openllmd ${kind} <install|uninstall|list> [${kind === "setup" ? "id" : "slug"}]\n`,
  );
  process.exit(2);
};

/**
 * Run a `skill|plugin|setup` subcommand. Foreground one-shot (no server boot):
 * `list` prints the catalog; `install|uninstall <slug>` runs the shared
 * executor and exits with its status. Exits the process in every branch.
 */
const runIntegrationCli = async (
  kind: TIntegrationKind,
  args: readonly string[],
): Promise<never> => {
  const action = args[0];

  if (action === "list") {
    const url = `${daemonEnv().cloudOrigin}${LIST_PATH[kind]}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        process.stderr.write(`list failed: ${url} → ${res.status}\n`);
        process.exit(1);
      }
      const body = (await res.json()) as {
        data?: ReadonlyArray<{ slug?: string; id?: string; name?: string }>;
      };
      for (const item of body.data ?? []) {
        const id = item.slug ?? item.id ?? "";
        process.stdout.write(`${id.padEnd(24)}${item.name ?? ""}\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `list failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  if (action === "install" || action === "uninstall") {
    const slug = args[1];
    if (slug === undefined || slug.length === 0) return integrationUsage(kind);
    const result = await runIntegration(
      kind,
      action as TIntegrationAction,
      slug,
    );
    if (result.output.length > 0) process.stdout.write(`${result.output}\n`);
    process.exit(result.ok ? 0 : 1);
  }

  return integrationUsage(kind);
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
    case "skill":
    case "plugin":
    case "setup":
      // Foreground one-shot: the async executor process.exit()s when done; the
      // pending fetch keeps the event loop alive. Returning true prevents the
      // server boot path in main.ts. Any unexpected rejection is caught here so
      // it exits deterministically (non-zero) instead of an unhandled rejection.
      runIntegrationCli(args[0] as TIntegrationKind, rest).catch((err) => {
        logError("cli", err);
        process.exit(1);
      });
      return true;
    case "set-token":
      runSetToken(rest);
      break;
    case "uninstall":
      runUninstall(rest);
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
