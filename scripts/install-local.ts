#!/usr/bin/env bun

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Install the daemon on THIS machine from source — the "without releasing"
 * path. Compiles the host binary, drops it under ~/.openllm/bin/openllmd,
 * symlinks it onto PATH, then hands off to `openllmd start` (which registers
 * the launch agent / systemd unit in full self-restore mode + installs shell
 * completion). `--uninstall` reverses it: `openllmd stop` + remove.
 *
 * The compiled-in cloud origin honors OPENLLM_CLOUD_ORIGIN — point a local
 * install at a dev server with:
 *   OPENLLM_CLOUD_ORIGIN=http://127.0.0.1:3000 bun run daemon:install
 *
 * Usage:
 *   bun run packages/daemon/scripts/install-local.ts
 *   bun run packages/daemon/scripts/install-local.ts --uninstall
 */
import { $ } from "bun";

// Resolve everything from THIS script's location, not the cwd — `bun run
// install:local` runs from packages/daemon, so cwd-relative paths would
// double-nest (packages/daemon/packages/daemon/…) and break before install.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // packages/daemon/scripts
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const COMPILE_SCRIPT = join(SCRIPT_DIR, "compile.ts");
const COMPILED = join(REPO_ROOT, "packages", "daemon", "dist", "openllmd"); // compile.ts --host output

const STATE_DIR =
  process.env.OPENLLM_DAEMON_STATE_DIR ?? join(homedir(), ".openllm");
const BIN_DIR = join(STATE_DIR, "bin");
const BIN_PATH = join(BIN_DIR, "openllmd");

const isWritable = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** First PATH-friendly dir we can write a symlink into. */
const linkDir = (): string => {
  for (const cand of ["/usr/local/bin", join(homedir(), ".local", "bin")]) {
    if (existsSync(cand) && isWritable(cand)) return cand;
  }
  const fallback = join(homedir(), ".local", "bin");
  mkdirSync(fallback, { recursive: true });
  return fallback;
};

const onPath = (dir: string): boolean =>
  (process.env.PATH ?? "").split(":").includes(dir);

/**
 * Remove the `openllmd` PATH entry ONLY when it's a symlink we own (points at
 * BIN_PATH). If something else lives there — a real binary, or a link to a
 * different install — leave it and tell the user, so we never delete an
 * unrelated `openllmd`.
 */
const removeOurLink = (link: string): void => {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(link);
  } catch {
    return; // nothing there — fine
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(
      `refusing to remove ${link}: not a symlink. Remove it manually if it's a stale openllmd.`,
    );
  }
  const target = resolve(dirname(link), readlinkSync(link));
  if (target !== BIN_PATH) {
    throw new Error(
      `refusing to remove ${link}: it points to ${target}, not ${BIN_PATH}. Remove it manually.`,
    );
  }
  unlinkSync(link);
};

const uninstall = async (): Promise<void> => {
  if (existsSync(BIN_PATH)) {
    // Best-effort stop via the installed binary itself.
    await $`${BIN_PATH} stop`.nothrow();
  }
  const link = join(linkDir(), "openllmd");
  removeOurLink(link);
  rmSync(BIN_PATH, { force: true });
  console.log(
    `Removed ${BIN_PATH} and ${link}. State under ${STATE_DIR} is kept.`,
  );
};

const install = async (): Promise<void> => {
  console.log("Compiling host binary…");
  // compile.ts uses repo-root-relative paths, so pin its cwd to the repo root.
  await $`bun ${COMPILE_SCRIPT} --host`.cwd(REPO_ROOT);
  if (!existsSync(COMPILED)) {
    throw new Error(`compile did not produce ${COMPILED}`);
  }

  mkdirSync(BIN_DIR, { recursive: true });
  copyFileSync(COMPILED, BIN_PATH);
  chmodSync(BIN_PATH, 0o755);
  console.log(`Installed binary → ${BIN_PATH}`);

  const dir = linkDir();
  const link = join(dir, "openllmd");
  removeOurLink(link); // refuses if it's someone else's openllmd
  symlinkSync(BIN_PATH, link);
  console.log(`Linked ${link} → ${BIN_PATH}`);
  if (!onPath(dir)) {
    console.log(
      `Note: ${dir} is not on your PATH — add it to run 'openllmd' directly.`,
    );
  }

  // Hand off to the binary: register the service (self-restore) + completion.
  await $`${BIN_PATH} start`;
  await $`${BIN_PATH} completion install`.nothrow();
  console.log(
    "\nDone. Manage it with: openllmd status | openllmd stop | openllmd start",
  );
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--uninstall")) {
    await uninstall();
    return;
  }
  await install();
};

await main();
