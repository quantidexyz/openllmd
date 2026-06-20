/**
 * `openllmd uninstall` — completely remove the OpenLLM daemon from this
 * machine. The inverse of `packages/setup/daemon/install.sh`: it leaves
 * NOTHING behind.
 *
 * Order matters — we STOP the self-restoring service FIRST (so launchd /
 * systemd can't relaunch the daemon mid-teardown), then delete state:
 *
 *   1. confirm (destructive + irreversible — credentials are deleted)
 *   2. stop + unregister the background service (launch agent / systemd unit)
 *   3. remove shell completion (rc line + fish file)
 *   4. remove the `openllmd` PATH symlink (only if it's ours)
 *   5. delete the entire state dir `~/.openllm` — binary, paired API key,
 *      subscription CREDENTIALS, setup-tokens, the encryption keypair, logs
 *
 * The running process keeps executing from its already-loaded binary even
 * after its file is unlinked (the inode survives until exit), so deleting the
 * state dir from within is safe; we exit at the end.
 */
import {
  existsSync,
  lstatSync,
  readlinkSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { uninstallCompletion } from "./completion";
import { stateDir } from "./env";
import { serviceUninstall } from "./service";

const out = (s: string): void => {
  process.stdout.write(s);
};

/** The `openllmd` binary the installers drop under the state dir. */
const binPath = (): string => join(stateDir(), "bin", "openllmd");

/**
 * Remove an `openllmd` PATH symlink ONLY when it's one we own — a symlink
 * resolving to OUR `bin/openllmd`. A real binary, or a link to a different
 * install, is left untouched (we never delete an unrelated `openllmd`). The
 * installers try `/usr/local/bin` then `~/.local/bin`, so check both.
 */
const removeOwnedLinks = (): string[] => {
  const removed: string[] = [];
  const ours = binPath();
  for (const dir of ["/usr/local/bin", join(homedir(), ".local", "bin")]) {
    const link = join(dir, "openllmd");
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(link);
    } catch {
      continue; // nothing there
    }
    if (!stat.isSymbolicLink()) continue; // a real file — not ours, leave it
    let target: string;
    try {
      target = resolve(dir, readlinkSync(link));
    } catch {
      continue;
    }
    if (target !== ours) continue; // points elsewhere — not ours
    try {
      unlinkSync(link);
      removed.push(link);
    } catch {
      // best-effort — a non-writable dir shouldn't abort the uninstall
    }
  }
  return removed;
};

const CONFIRM_PROMPT = `⚠️  This will COMPLETELY remove the OpenLLM daemon from this machine:

  • stop and UNREGISTER the background service (launch agent / systemd unit),
    so it no longer self-restores on login or reboot
  • DELETE all local state under ${stateDir()} — including your stored
    subscription CREDENTIALS, setup-tokens, the paired API key, and the
    daemon's encryption keypair
  • remove the openllmd binary, its PATH symlink, and shell completion

This is IRREVERSIBLE. You'll need to reinstall and reconnect your
subscriptions to use the daemon again.

Type 'yes' to remove everything: `;

/** True when the user passed an explicit non-interactive confirm flag. */
const hasYesFlag = (args: readonly string[]): boolean =>
  args.includes("--yes") || args.includes("-y");

/**
 * Confirm the destructive action. With `--yes`/`-y`, skip the prompt. In an
 * interactive shell, require the user to type `yes`. In a NON-interactive shell
 * without `--yes`, refuse (rather than read a misleading empty line) and tell
 * them how to proceed.
 */
const confirm = (args: readonly string[]): boolean => {
  if (hasYesFlag(args)) return true;
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      "openllmd uninstall is destructive and needs confirmation.\n" +
        "Re-run in an interactive shell, or pass --yes to skip the prompt:\n" +
        "  openllmd uninstall --yes\n",
    );
    return false;
  }
  // Require the exact word the prompt asks for — no bare `y` shorthand for an
  // irreversible, credential-deleting action (the explicit -y/--yes flag is the
  // intentional non-interactive shorthand).
  const answer = (prompt(CONFIRM_PROMPT) ?? "").trim().toLowerCase();
  return answer === "yes";
};

/**
 * Run `openllmd uninstall`. Exits the process (0 on completion, 1 on abort).
 */
export const runUninstall = (args: readonly string[]): never => {
  if (!confirm(args)) {
    out("\nAborted — nothing was removed.\n");
    process.exit(1);
  }

  out("\nRemoving the OpenLLM daemon…\n");

  // 1. Stop + unregister the service (kills self-restore before we delete).
  const removedService = serviceUninstall();
  out(
    removedService !== null
      ? `  ✓ stopped + unregistered the service (${removedService})\n`
      : "  ✓ service stopped (no registration found)\n",
  );

  // 2. Shell completion.
  const completion = uninstallCompletion();
  out(
    completion.length > 0
      ? `  ✓ removed shell completion (${completion.join(", ")})\n`
      : "  ✓ shell completion (none found)\n",
  );

  // 3. PATH symlink (only if it's ours).
  const links = removeOwnedLinks();
  out(
    links.length > 0
      ? `  ✓ removed PATH symlink (${links.join(", ")})\n`
      : "  ✓ PATH symlink (none owned by us)\n",
  );

  // 4. All local state — binary, API key, credentials, tokens, keypair, logs.
  const dir = stateDir();
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    out(`  ✓ deleted all state (${dir})\n`);
  } else {
    out(`  ✓ state dir already gone (${dir})\n`);
  }

  out("\nOpenLLM daemon fully removed. Your machine is clean.\n");
  process.exit(0);
};
