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
 *     - the state dir (`~/.openllm`): api-key/device-id/update-state (0600),
 *       daemon.env, logs, the isolated vendor CLIs under `cli/<provider>/`
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
 * Note `/tmp` is granted read-write: vendor install scripts stage downloads
 * there, and the systemd layer gives the service a PRIVATE `/tmp` anyway
 * (`PrivateTmp=yes`).
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stateDir } from "../env";

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
 *  SECURITY: stops at the user's home directory and returns the original path
 *  unchanged when the target doesn't exist and would climb to or above home.
 *  This prevents widening grants to the entire home directory when a bootstrap
 *  target is missing — callers must pre-create bootstrap targets or handle the
 *  grant failure. */
const existing = (paths: readonly string[]): string[] => {
  const home = homedir();
  return paths.map((p) => {
    let candidate = p;
    while (candidate !== "/" && !existsSync(candidate)) {
      const parent = dirname(candidate);
      // Stop climbing at home: do NOT return home as the granted ancestor when
      // the original target didn't exist. Return the original path instead so
      // callers can pre-create it or handle the missing grant.
      if (parent === home && candidate !== home) {
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
  const readWrite = new Set<string>([
    // The whole state dir: api-key + env + logs + isolated CLI roots
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
    //   non-isolated `claude install` drops its launcher.
    join(home, ".local", "bin"),
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
