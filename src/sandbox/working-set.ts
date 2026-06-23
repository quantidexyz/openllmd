/**
 * The daemon's filesystem working set — the SINGLE allow-list both sandbox
 * backends consume (the Landlock ruleset in `./landlock.ts`, and the systemd
 * unit hardening rendered by `service.ts`). Derived from the existing path
 * helpers (`env.ts` / `cli-paths.ts`), never re-hardcoded, so a relocated
 * state dir or a new provider home is picked up here automatically. See
 * `docs/proposals/daemon-os-sandbox-and-typed-control.md` §3.1.
 *
 * Everything the daemon legitimately touches is deliberately centralised:
 *
 *   read-write
 *     - the state dir (`~/.openllm`): daemon.env (0600, holds the key + device
 *       id + config) and update-state, logs, the isolated vendor CLIs under `cli/<provider>/`
 *       (homes + binaries + config), AND the daemon binary itself + its
 *       atomic-swap temp (`bin/openllmd`, `.openllmd.update.<pid>.tmp` —
 *       the installer places the binary inside the state dir);
 *     - the executable's real directory (belt-and-braces when `execPath`
 *       lives outside the state dir — a manual install);
 *     - the claude-code integration footprint (`~/.claude`, `~/.claude.json`)
 *       — the DECLARED target the SHA-gated skill/plugin/setup scripts
 *       install into (`packages/api/handlers/{skills,plugins,setup}.ts`).
 *
 *   read-only
 *     - the system trees the runtime + spawned tools (`bash`, `curl`, the
 *       vendor CLIs' loaders) need: `/usr`, `/lib*`, `/bin`, `/sbin`, `/opt`,
 *       `/etc` (resolv.conf + TLS trust), `/proc`, `/sys`, `/run`, `/var`.
 *
 *   deny (implicit — everything else, notably the rest of `$HOME`)
 *     - `~/.ssh`, `~/.aws`, `~/.gnupg`, the user's real `~/.codex` /
 *       `~/.kimi-code`, browser profiles, documents.
 *
 * Note the system `/tmp` is deliberately NOT granted (granting it would leak
 * every other process's temp files — and the user unit no longer sets
 * `PrivateTmp=yes`, which broke `--user` units). Instead the daemon owns
 * `<state>/tmp` (`daemonTempDir()`, granted as part of the state dir) and
 * points every isolated CLI's `TMPDIR` at it (`cli-paths.ts` `cliEnv`), so the
 * codex/kimi installers' `mktemp -d` stages inside the working set rather than
 * EACCESing on the ungranted `/tmp`.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stateDir } from "../env";
import { DAEMON_VERSION } from "../version";

export type TWorkingSet = {
  /** Paths (recursive) the daemon and its children may read AND write. */
  readonly readWrite: readonly string[];
  /** Paths (recursive) the daemon and its children may read + execute. */
  readonly readOnly: readonly string[];
};

/** Walk up to the nearest existing ancestor for each path. Landlock's
 *  `open(O_PATH)` fails on a missing path; granting a not-yet-created target
 *  directly is meaningless, but we must grant an existing ancestor so the
 *  bootstrap install/setup scripts can CREATE the missing target. For first-run
 *  bootstrap targets like ~/.claude that don't yet exist, this walks up to the
 *  existing parent (e.g. ~/.local/) and grants that, letting the install mkdir.
 *
 *  SECURITY: stops at the user's home directory AND at the filesystem root,
 *  returning the original path unchanged when the target doesn't exist and
 *  would climb to or above either. This prevents widening grants to the entire
 *  home directory — or the entire filesystem — when a bootstrap or system
 *  target is missing (e.g. `/lib64`, absent on arm64 Linux, would otherwise
 *  climb to `/` and grant the whole root tree). Callers must pre-create
 *  bootstrap targets or handle the grant failure. */
const existing = (paths: readonly string[]): string[] => {
  const home = homedir();
  return paths.map((p) => {
    let candidate = p;
    while (candidate !== "/" && !existsSync(candidate)) {
      const parent = dirname(candidate);
      // Stop climbing at home OR root: do NOT return home (or `/`) as the
      // granted ancestor when the original target didn't exist — that would
      // widen the grant to the whole home tree or the entire filesystem.
      // Return the original path instead so callers can pre-create it or handle
      // the missing grant.
      if ((parent === home || parent === "/") && candidate !== home) {
        return p; // original path (non-existent, will fail to grant)
      }
      candidate = parent;
    }
    return candidate;
  });
};

/**
 * Get the daemon's temp directory path (under the state dir). Creates it if
 * missing (mode 0o700). Returns the path even if creation fails — callers
 * can handle the failure as needed.
 */
export const daemonTempDir = (): string => {
  const daemonTmp = join(stateDir(), "tmp");
  try {
    mkdirSync(daemonTmp, { recursive: true, mode: 0o700 });
  } catch {
    // Creation failure is non-fatal — the sandbox will still apply, but
    // operations needing temp will fail. Callers can log/handle as needed.
  }
  return daemonTmp;
};

/**
 * The daemon's base working set (no user grants — the §3.4 consent flow
 * unions persisted grants in here when it lands). Resolved at call time so
 * `OPENLLM_DAEMON_STATE_DIR` overrides are honoured.
 */
export const daemonWorkingSet = (): TWorkingSet => {
  const home = homedir();
  const state = stateDir();
  // Daemon-owned temp directory under the state dir. The unit hardening no
  // longer sets PrivateTmp (removed due to --user unit compatibility issues),
  // so granting global /tmp would leak access to every other process's temp
  // files. Instead we create and use our own isolated temp under stateDir.
  const daemonTmp = daemonTempDir();
  // The integration scripts' staging dir ($HOME/.cache/openllm — see the grant
  // below). PRE-CREATE it (best-effort) so the grant lands on the real leaf:
  // `existing()` deliberately refuses to climb to bare $HOME, so on a fresh box
  // where ~/.cache itself is absent the leaf would otherwise stay ungranted and
  // the confined script's first mktemp would still EACCES. Mirrors how
  // `daemonTempDir()` pre-creates the daemon tmp above.
  const integrationTmp = join(home, ".cache", "openllm");
  try {
    mkdirSync(integrationTmp, { recursive: true, mode: 0o700 });
  } catch {
    // Best-effort — if creation fails, `existing()` still climbs to whatever
    // ancestor DOES exist (or returns the leaf, which fails to grant safely).
  }
  // Pre-create the vendor CLI install/config dirs the host-install + setup flows
  // write into (claude / codex / kimi). REQUIRED on Linux: Landlock can only
  // grant an EXISTING path (`existing()` drops a non-existent leaf rather than
  // widen the grant to bare $HOME), so on a fresh box `~/.kimi-code` etc. would
  // be UNgranted and the vendor installer's `mkdir -p ~/.kimi-code/bin` EACCESes
  // (the Linux EC2 failure). macOS Seatbelt grants by path pattern so it doesn't
  // need this — pre-creating is a harmless no-op there. Same pattern as the
  // daemonTempDir / integrationTmp pre-creation above.
  for (const d of [
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".kimi-code"),
    join(home, ".local", "bin"),
    join(home, ".local", "share", "claude"),
  ]) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      // best-effort — an ungranted leaf just means that vendor's install falls
      // back / fails visibly, not a daemon-boot failure.
    }
  }
  const readWrite = new Set<string>([
    // The whole state dir: daemon.env (config + key + device id) + logs + isolated CLI roots
    // (`cli/<provider>/{home,bin}` all nest under it — see `cli-paths.ts`)
    // + the installed binary and its self-update temp (`<state>/bin`).
    state,
    // Belt-and-braces for a binary installed OUTSIDE the state dir (manual
    // placement): self-update renames a temp over `process.execPath`, so its
    // real directory must be writable.
    dirname(process.execPath),
    // ── Integration / setup workflow targets ──────────────────────────
    // The SHA-gated skill/plugin/setup scripts the daemon runs (via `bash -s`)
    // configure the user's CLIs IN PLACE — including the NON-isolated codex /
    // kimi / claude setups (`packages/setup/{codex,kimi-code,claude-code}`)
    // and the plugin/skill installers (`packages/{plugin,skill}`). Every path
    // they write MUST be granted or the install fails under the sandbox.
    //   claude-code: ~/.claude/** (skills, plugins, commands, hooks,
    //                settings.json, plugin-state) + ~/.claude.json (MCP config).
    join(home, ".claude"),
    join(home, ".claude.json"),
    //   codex (non-isolated setup): ~/.codex/config.toml + catalog json.
    join(home, ".codex"),
    //   kimi-code (non-isolated setup): ~/.kimi-code.
    join(home, ".kimi-code"),
    //   the user-level bin dir: the `openllmd` PATH symlink AND where the
    //   non-isolated `claude`/`codex` installers drop their launcher + where the
    //   setup fast path copies an adopted CLI binary.
    join(home, ".local", "bin"),
    //   claude's install dir: the `~/.local/bin/claude` launcher resolves to
    //   `~/.local/share/claude/versions/<v>`. The official `claude install`
    //   WRITES versions here, and the daemon's isolated CLI is a SYMLINK to that
    //   launcher — so EXECUTING the isolated claude reads through to this dir.
    //   Read-write so the setup can install claude AND the isolated symlink can
    //   run it. The user's own claude binary — no credentials (those live in
    //   `~/.claude`).
    join(home, ".local", "share", "claude"),
    //   shell rc / profile files: the non-isolated setup's tier-3 official
    //   installers (codex/kimi/claude) append a PATH line to the user's shell
    //   profile so the freshly-installed CLI is on PATH. Only these specific
    //   files are granted (existing ones grant the file; absent ones the
    //   to-be-created path), NOT all of `$HOME` — the tamper guard stays tight
    //   everywhere else. SECURITY NOTE: this is a deliberate, scoped widening of
    //   the deny-`$HOME` tamper guard to let the setup wire up PATH; a
    //   compromised daemon could append to these startup files, so the set is
    //   kept to the minimum the installers touch.
    join(home, ".zshrc"),
    join(home, ".zprofile"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    //   the integration scripts' OWN staging dir: the shared script preamble
    //   (`packages/api/lib/scripts.ts` `pick_tmpdir`) points TMPDIR at
    //   `$HOME/.cache/openllm` (the root fs, to dodge the small /tmp tmpfs on
    //   cloud images), and EVERY install/uninstall does its `mktemp` +
    //   download/extract there. Without this grant a confined integration's
    //   first `mktemp` EACCESes → the `set -e` script exits 1 (the EC2
    //   install/uninstall failure). Pre-created above so the grant lands on the
    //   real leaf even when ~/.cache didn't previously exist.
    integrationTmp,
    // Daemon-owned temp directory (NOT global /tmp). Vendor install scripts
    // stage downloads here. Created above with 0o700 so it's isolated.
    daemonTmp,
    // Device nodes the runtime + EVERY spawned child need: `/dev/null` (the
    // stdio target when a spawn uses `stdout: "ignore"` — without this, Bun's
    // `posix_spawn` of `bash`/the vendor CLIs fails `EACCES` setting up the
    // redirect, so connect + integration installs silently break), `/dev/
    // urandom`, etc. Devices hold no secrets, so granting `/dev` is safe.
    "/dev",
  ]);
  const readOnly = new Set<string>([
    // ── Dev-source-only grant (NEVER the shipped binary) ───────────────
    // A source/dev run executes `bun packages/daemon/src/main.ts`, so the
    // runtime must READ the repo's `.ts` sources + hoisted `node_modules`
    // (e.g. `effect`) at import time. Both backends are read-WHITELISTs
    // (Landlock everywhere; macOS Seatbelt deny-by-default within `$HOME`), and
    // a dev checkout lives under `$HOME`, so the repo root must be granted or
    // the from-source daemon can't load its own modules under confinement. The
    // COMPILED binary (`DAEMON_VERSION !== "0.0.0-dev"`) is
    // a self-contained executable in the state dir, needs no source tree, and
    // gets NO such grant — production confinement is unchanged. The repo root
    // is derived from this module's own location, so it's correct regardless
    // of the daemon's cwd, and it's disjoint from `$HOME` secrets like
    // `~/.ssh`, so the confinement guarantee still holds.
    ...(DAEMON_VERSION === "0.0.0-dev"
      ? [resolve(import.meta.dir, "..", "..", "..", "..")]
      : []),
    // (~/.local/share/claude is granted READ-WRITE in the readWrite set above —
    //  it serves both the install fast-path adoption READ and the non-isolated
    //  setup's tier-3 claude install WRITE.)
    // Toolchain + loaders for spawned children (bash, curl, vendor CLIs).
    "/usr",
    "/lib",
    "/lib64",
    "/bin",
    "/sbin",
    "/opt",
    // resolv.conf, TLS trust store, locale data.
    "/etc",
    // Runtime introspection some tools expect.
    "/proc",
    "/sys",
    "/run",
    "/var",
  ]);
  // A read-write grant subsumes a read-only one — keep the lists disjoint.
  for (const rw of readWrite) readOnly.delete(rw);
  return {
    readWrite: existing([...readWrite]),
    readOnly: existing([...readOnly]),
  };
};
