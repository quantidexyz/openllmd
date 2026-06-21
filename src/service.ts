/**
 * Service lifecycle — `openllmd start | stop | status | restart`.
 *
 * The daemon supervises ITSELF: registering, starting, stopping, and querying
 * its own background service (a macOS launch agent / a Linux systemd --user
 * unit). The install script (`packages/setup/daemon/install.sh`) downloads the
 * binary, puts it on PATH, and then delegates to `openllmd start` — so the same
 * code path the installer uses is the one a user runs by hand.
 *
 * - `start`  — register + enable + (re)start in FULL self-restore mode: launchd
 *              `KeepAlive`+`RunAtLoad`, systemd `Restart=always` + boot start +
 *              linger. Survives crash, logout, and reboot. Idempotent.
 * - `stop`   — stop AND disable all self-restore: launchd `bootout`+`disable`
 *              (persistent override so login won't relaunch it), systemd
 *              `disable --now`. Stays down until the next explicit `start`.
 * - `status` — service registration/run state + listening check.
 * - `restart`— stop then start.
 *
 * The service runs `process.execPath` — the compiled binary that invoked
 * `start`. Running `start` from a source checkout (`bun src/main.ts start`,
 * reported as `0.0.0-dev`) would register `bun` as the service, so it's
 * refused; install + run the compiled binary (`bun run daemon:dist` then
 * `bun run daemon:dist:install`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setAutoUpdate } from "./auto-update-pref";
import { daemonEnv, envFilePath, stateDir, writeEnvFileVars } from "./env";
import { hardenMacBinary } from "./harden-binary";
import type { TDaemonHealth } from "./health";
import { DAEMON_VERSION } from "./version";

const LABEL = "sh.openllm.daemon";
const DEFAULT_PORT = 8787;
const isMac = process.platform === "darwin";

const plistPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const unitDir = (): string => join(homedir(), ".config", "systemd", "user");
const unitPath = (): string => join(unitDir(), "openllmd.service");

const uid = (): number => (process.getuid ? process.getuid() : 0);
const guiDomain = (): string => `gui/${uid()}`;
const guiTarget = (): string => `${guiDomain()}/${LABEL}`;

const daemonPort = (): number => {
  const raw = process.env.OPENLLM_DAEMON_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
};

/** Run a command, swallowing failure; returns whether it exited 0. */
const tryRun = (cmd: string, args: readonly string[]): boolean => {
  try {
    execFileSync(cmd, args as string[], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Run a command and capture stdout (empty string on failure). */
const capture = (cmd: string, args: readonly string[]): string => {
  try {
    return execFileSync(cmd, args as string[], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
  } catch {
    return "";
  }
};

/**
 * Ensure daemon.env carries the cloud origin + port the service reads at boot.
 * Written when absent so a standalone `openllmd start` works without the
 * installer; also (re)written when `OPENLLM_CLOUD_ORIGIN` or
 * `OPENLLM_DAEMON_PORT` is set explicitly, so `OPENLLM_CLOUD_ORIGIN=… openllmd
 * start` (or `…PORT=…`) re-points an existing install. Upserts only these two
 * keys — the paired `OPENLLM_API_KEY` and minted `OPENLLM_DEVICE_ID` lines in
 * the same file are preserved.
 */
const writeEnvFileIfNeeded = (): void => {
  // Either var set explicitly re-points an existing install — otherwise
  // `OPENLLM_DAEMON_PORT=9000 openllmd start` would report :9000 while the
  // persisted env file (what the service actually boots with) kept the old one.
  const explicitOverride =
    process.env.OPENLLM_CLOUD_ORIGIN !== undefined ||
    process.env.OPENLLM_DAEMON_PORT !== undefined;
  if (existsSync(envFilePath()) && !explicitOverride) return;
  const env = daemonEnv();
  writeEnvFileVars({
    OPENLLM_CLOUD_ORIGIN: env.cloudOrigin,
    OPENLLM_DAEMON_PORT: String(daemonPort()),
  });
};

/**
 * The daemon's service-captured log files — the stdout/stderr the OS
 * supervisor (launchd/systemd) redirects, distinct from the app's own
 * structured `openllmd.log`. Single source of truth, consumed by `renderPlist`,
 * `renderUnit`, and `serviceStatus` so the capture policy is ONE value, not
 * per-renderer copies that drift (the bug: macOS captured an err.log, Linux
 * didn't).
 */
const serviceLogPaths = (): { out: string; err: string } => ({
  out: join(stateDir(), "openllmd.out.log"),
  err: join(stateDir(), "openllmd.err.log"),
});

/**
 * Major version from `systemctl --version` (first line: `systemd 249 (…)`).
 * Returns 0 when systemctl is absent/unparseable so callers fall back to
 * journald rather than emitting a directive an older systemd rejects at unit
 * load.
 */
const systemdMajor = (): number => {
  const m = capture("systemctl", ["--version"]).match(/\bsystemd\s+(\d+)/);
  return m === null ? 0 : Number.parseInt(m[1], 10);
};

/**
 * Service-log directives for the systemd unit. Always tags journald with a
 * greppable identity; ADDITIONALLY mirrors stdout/stderr to files — parity with
 * the macOS launch agent's `StandardOut/ErrorPath`, so Linux finally writes an
 * `openllmd.err.log` capturing crash/OOM/native output the app logger can't
 * reach — when systemd supports `append:` (≥240) and the paths are absolute (an
 * `OPENLLM_DAEMON_STATE_DIR` override could be relative). Otherwise stays
 * journald-only — never `file:`, which truncates the log on every (re)start.
 * `append:` needs the parent dir to exist at exec time (see `startLinux`).
 *
 * Takes the systemd major (from `systemdMajor()`) so the version gate is
 * injectable — exported for the same reason `renderUnitHardening` is: so a test
 * can assert both branches without a real systemd.
 */
export const renderUnitLogging = (systemdMajorVersion: number): string => {
  const { out, err } = serviceLogPaths();
  let s = "SyslogIdentifier=openllmd\n";
  if (systemdMajorVersion >= 240 && isAbsolute(out) && isAbsolute(err)) {
    s += `StandardOutput=append:${out}\n`;
    s += `StandardError=append:${err}\n`;
  }
  return s;
};

export const renderPlist = (binPath: string): string => {
  const { out, err } = serviceLogPaths();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${binPath}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>OPENLLM_DAEMON_ENV_FILE</key><string>${envFilePath()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Minimum seconds between respawns ("cap on retry" — backoff floor). launchd
       has no exponential ramp or start-limit, so a higher floor is the only
       native throttle on a crash loop; the hard ceiling is boot-guard.ts. -->
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${err}</string>
</dict>
</plist>
`;
};

/**
 * OS-sandbox half of the unit (`docs/proposals/daemon-os-sandbox-and-typed-
 * control.md` §3.3b) — the directives that are SAFE in a `systemctl --user`
 * unit, which is the only kind the daemon registers (it installs without root).
 *
 * The daemon runs UNPRIVILEGED, so the systemd layer here is **seccomp/prctl
 * only**. The earlier set included capability- and mount-namespace directives
 * (`ProtectKernelModules`, `ProtectKernelTunables`, `ProtectControlGroups`,
 * `ProtectHome`, `ProtectSystem`, `ReadWritePaths`, `PrivateTmp`) — but a user
 * manager has no `CAP_SETPCAP`, so any directive that drops a capability makes
 * the unit fail at the CAPABILITIES exec step with `218/CAPABILITIES`
 * ("Failed to drop capabilities: Operation not permitted") and the daemon
 * crash-loops, never starting. The mount directives are likewise privilege-
 * dependent (they fail on distros that restrict unprivileged user namespaces,
 * e.g. Ubuntu 24.04's AppArmor default).
 *
 * So FILESYSTEM confinement is **Landlock's** job (`sandbox/landlock.ts`):
 * in-process, unprivileged, inherited across `execve` — it needs no systemd
 * mount/capability privileges and is the real FS boundary on Linux (proven by
 * `tests/sandbox`). The directives kept below all apply per-process via seccomp
 * filters / prctl, which an unprivileged user unit CAN do. Omitted entirely
 * when the kill switch (`OPENLLM_DAEMON_NO_SANDBOX=1`) is set at registration.
 *
 * NOTE: we deliberately do NOT set `MemoryDenyWriteExecute=` — Bun's JIT needs
 * writable-executable pages, so W^X must stay off; never add it.
 */
export const renderUnitHardening = (): string => {
  if (process.env.OPENLLM_DAEMON_NO_SANDBOX === "1") return "";
  return `# --- OS sandbox: seccomp/prctl only (a --user unit can't drop caps
# or set up mount namespaces; FS confinement is Landlock's job — see
# packages/daemon/src/sandbox/landlock.ts). ---
NoNewPrivileges=yes
# AF_NETLINK: glibc getaddrinfo enumerates interfaces over netlink.
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
# The daemon self-restricts via Landlock at boot, so the seccomp allow-list MUST
# keep those syscalls callable. The \`@sandbox\` GROUP only exists on systemd
# >= 257 — on Debian 12 / Ubuntu 22.04|24.04 (systemd <= 256, most production
# Linux) it is silently ignored ("Unknown system call group, ignoring: @sandbox"),
# so the daemon's landlock_create_ruleset() hit the default action and was
# SIGSYS-KILLED at boot → an endless Restart=always crash loop, killed before any
# log flushed. Whitelist the three Landlock syscalls BY NAME (resolves on every
# systemd) AND keep @sandbox for forward-compat. SystemCallErrorNumber=EPERM is
# the belt-and-braces: a blocked syscall returns EPERM (the daemon's sandbox
# apply fails OPEN) instead of crash-looping — so a future syscall gap degrades,
# never kills.
SystemCallFilter=@system-service @sandbox landlock_create_ruleset landlock_add_rule landlock_restrict_self
SystemCallErrorNumber=EPERM
SystemCallArchitectures=native
`;
};

/**
 * Restart policy for the systemd unit — exponential backoff with a hard ceiling
 * ("cap on retry"). Takes the systemd major (from `systemdMajor()`) so the
 * version gate is injectable for tests (like `renderUnitLogging`).
 *
 * Always `Restart=always` (recover from clean exit, crash, OOM, signal — only an
 * explicit `systemctl --user stop` keeps it down). On systemd ≥254 the respawn
 * interval RAMPS from `RestartSec` to `RestartMaxDelaySec` over `RestartSteps`
 * rather than hammering at a fixed 2s — so a persistent boot failure backs off
 * to a 30s cadence instead of pegging the CPU. Older systemd lacks `RestartSteps`
 * (it would reject the unit), so it falls back to a fixed, slightly slower 5s.
 */
export const renderUnitRestart = (systemdMajorVersion: number): string => {
  if (systemdMajorVersion >= 254) {
    return "Restart=always\nRestartSec=2\nRestartSteps=8\nRestartMaxDelaySec=30\n";
  }
  return "Restart=always\nRestartSec=5\n";
};

export const renderUnit = (binPath: string): string => `[Unit]
Description=OpenLLM local daemon
After=network-online.target
Wants=network-online.target
# Start-limit cap ("cap on retry"). The daemon is meant to run forever, so the
# bound is generous — but NOT infinite: a persistent boot failure (port
# permanently in use, a bad binary) used to crash-loop forever with the limiter
# disabled, flooding the log + burning CPU. With backoff (RestartSteps below) a
# real loop runs at ~30s/boot, so 20 starts in 5 min only triggers after minutes
# of genuine thrashing → systemd parks the unit "failed" and stops. The app-side
# crash-loop guard (boot-guard.ts) is the cross-platform backstop (+ the only one
# on macOS). Recover from a parked unit with \`openllmd restart\`.
StartLimitIntervalSec=300
StartLimitBurst=20

[Service]
EnvironmentFile=${envFilePath()}
ExecStart=${binPath}
${renderUnitRestart(systemdMajor())}${renderUnitLogging(systemdMajor())}${renderUnitHardening()}
[Install]
WantedBy=default.target
`;

const startMac = (binPath: string): void => {
  const plist = plistPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plist, renderPlist(binPath));
  const domain = guiDomain();
  const target = guiTarget();
  // Modern launchd lifecycle (domain-target). The legacy `launchctl load`
  // silently no-ops in common states — notably when a prior `stop` left the
  // label in a DISABLED override — so KeepAlive/RunAtLoad never take effect and
  // the daemon "won't stay running". `enable` clears that override; `bootstrap`
  // loads it (fall back to `load` on older macOS); `kickstart -k` (re)starts it.
  tryRun("launchctl", ["bootout", target]);
  tryRun("launchctl", ["enable", target]);
  if (
    !tryRun("launchctl", ["bootstrap", domain, plist]) &&
    !tryRun("launchctl", ["load", plist])
  ) {
    throw new Error(`failed to load launch agent ${LABEL} (${plist})`);
  }
  tryRun("launchctl", ["kickstart", "-k", target]);
};

const startLinux = (binPath: string): void => {
  mkdirSync(unitDir(), { recursive: true });
  // systemd opens the `append:` log targets (renderUnitLogging) at exec time —
  // the state dir must exist first or the unit fails to start.
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(unitPath(), renderUnit(binPath));
  if (!tryRun("systemctl", ["--version"])) {
    throw new Error("systemctl not found — cannot register a systemd unit");
  }
  // Keep the user manager (and the daemon) alive across logout + at boot —
  // critical on headless servers where logind would otherwise reap it when the
  // SSH session ends. Self-linger usually needs no root (polkit); fall back to
  // sudo, then a hint.
  const user =
    capture("id", ["-un"]).trim() || homedir().split("/").pop() || "";
  if (
    user.length > 0 &&
    !tryRun("loginctl", ["enable-linger", user]) &&
    !tryRun("sudo", ["-n", "loginctl", "enable-linger", user])
  ) {
    process.stdout.write(
      `Note: run 'sudo loginctl enable-linger ${user}' so the daemon survives logout + reboot.\n`,
    );
  }
  tryRun("systemctl", ["--user", "daemon-reload"]);
  if (!tryRun("systemctl", ["--user", "enable", "--now", "openllmd.service"])) {
    throw new Error("failed to enable openllmd.service");
  }
  // Restart so a re-run with changed config takes effect (enable --now no-ops
  // when already running).
  tryRun("systemctl", ["--user", "restart", "openllmd.service"]);
};

const stopMac = (): void => {
  const target = guiTarget();
  tryRun("launchctl", ["bootout", target]);
  // Persistent disable override so a login/boot won't relaunch it — this is the
  // "disable all self-restore" half. Cleared by the next `start`'s `enable`.
  tryRun("launchctl", ["disable", target]);
};

const stopLinux = (): void => {
  // `disable --now` stops it AND removes the WantedBy symlink (no boot start);
  // a manual stop does not re-trigger Restart=always, so it stays down.
  tryRun("systemctl", ["--user", "disable", "--now", "openllmd.service"]);
};

// ─── Supervisor state (real, not a boolean) ──────────────────────────
// `is-active`/`state = running` answers "does the supervisor have a process",
// NOT "is the daemon actually serving". A daemon crash-looping on its listener
// bind (e.g. port in use) flickers through `active`/`running` between respawns
// and reports "running" — the bug this replaces. We now surface the supervisor's
// REAL state (systemd sub-state + restart count + last exit; launchd pid + last
// exit) and pair it with a live `/status` probe (see `serviceStatus`) so a crash
// loop reads as `activating (auto-restart) · N restarts` + `health: NOT
// responding` instead of a falsely reassuring "running".

/** Parse `key=value` lines (systemctl show output) into a record. */
export const parseKeyValues = (out: string): Record<string, string> => {
  const rec: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) rec[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return rec;
};

/** Render a systemd `show` record into a human supervisor line. Pure. */
export const renderSystemdSupervisor = (f: Record<string, string>): string => {
  const active = f.ActiveState ?? "unknown";
  const sub = f.SubState ?? "";
  const parts = [sub && sub !== active ? `${active} (${sub})` : active];
  const n = Number.parseInt(f.NRestarts ?? "", 10);
  if (Number.isFinite(n) && n > 0) parts.push(`${n} restarts`);
  const exit = Number.parseInt(f.ExecMainStatus ?? "", 10);
  if (Number.isFinite(exit) && exit !== 0) parts.push(`last exit ${exit}`);
  return parts.join(" · ");
};

/** Parse the fields we need from `launchctl print` output. */
export const parseLaunchctlPrint = (
  out: string,
): { running: boolean; pid: number | null; lastExitCode: number | null } => {
  const pidMatch = out.match(/\bpid = (\d+)/);
  const exitMatch = out.match(/last exit code = (\d+)/); // `(none)` → no match
  return {
    running: /state = running/.test(out) || pidMatch !== null,
    pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
    lastExitCode: exitMatch ? Number.parseInt(exitMatch[1], 10) : null,
  };
};

/** Render parsed launchd fields into a human supervisor line. Pure. */
export const renderLaunchdSupervisor = (s: {
  running: boolean;
  pid: number | null;
  lastExitCode: number | null;
}): string => {
  if (s.running) return s.pid !== null ? `running (pid ${s.pid})` : "running";
  const exit =
    s.lastExitCode !== null && s.lastExitCode !== 0
      ? ` · last exit ${s.lastExitCode}`
      : "";
  return `not running${exit}`;
};

const supervisorState = (): string => {
  if (isMac) {
    // `launchctl print` exits non-zero (empty capture) when the label isn't
    // bootstrapped at all.
    const out = capture("launchctl", ["print", guiTarget()]);
    return out.length === 0
      ? "not loaded"
      : renderLaunchdSupervisor(parseLaunchctlPrint(out));
  }
  const out = capture("systemctl", [
    "--user",
    "show",
    "-p",
    "ActiveState,SubState,NRestarts,ExecMainStatus,Result",
    "openllmd.service",
  ]);
  return out.length === 0
    ? "unknown"
    : renderSystemdSupervisor(parseKeyValues(out));
};

/**
 * Probe the running daemon's read-only `/status` (see `health.ts`/`main.ts`).
 * A successful fetch is the authoritative "actually serving" signal — and the
 * only source of the LIVE sandbox posture (the CLI never ran the sandbox). Short
 * timeout so a hung daemon can't hang the CLI; null on any failure.
 */
const probeHealth = async (port: number): Promise<TDaemonHealth | null> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(750),
    });
    return res.ok ? ((await res.json()) as TDaemonHealth) : null;
  } catch {
    return null;
  }
};

/**
 * Register + start the service in full self-restore mode. Idempotent. Refuses
 * to register a from-source run (would point the service at `bun`).
 */
export const serviceStart = (): void => {
  if (DAEMON_VERSION === "0.0.0-dev") {
    process.stderr.write(
      "refusing to register a service from a source run.\n" +
        "Build + install the compiled binary first: bun run daemon:dist && bun run daemon:dist:install\n",
    );
    process.exit(2);
  }
  const binPath = process.execPath;
  writeEnvFileIfNeeded();
  // An explicit OPENLLM_DAEMON_AUTO_UPDATE at registration is persisted to
  // daemon.env BEFORE the service first boots — so a `daemon:dist` install that
  // sets it `0` can't be clobbered by a self-update on the daemon's first tick.
  // Mirrors how writeEnvFileIfNeeded persists an explicit cloud-origin/port.
  const autoUpdateEnv = process.env.OPENLLM_DAEMON_AUTO_UPDATE;
  if (autoUpdateEnv !== undefined) {
    setAutoUpdate(autoUpdateEnv !== "0" && autoUpdateEnv !== "false");
  }
  hardenMacBinary(binPath); // arm64 SIGKILLs an unsigned binary launchd spawns
  if (isMac) startMac(binPath);
  else startLinux(binPath);
  process.stdout.write(
    `openllmd v${DAEMON_VERSION} started in self-restore mode (listening on http://127.0.0.1:${daemonPort()}).\n`,
  );
};

/** Stop the service and disable all self-restore. Idempotent. */
export const serviceStop = (): void => {
  if (isMac) stopMac();
  else stopLinux();
  process.stdout.write("openllmd stopped; self-restore disabled.\n");
};

/** Stop then start — picks up a changed binary/config. */
export const serviceRestart = (): void => {
  serviceStop();
  serviceStart();
};

/**
 * Stop the service AND remove its registration entirely (full uninstall) —
 * stronger than `stop`, which only disables self-restore but leaves the launch
 * agent / systemd unit file on disk. Stops the running daemon + any self-restore
 * first (so nothing relaunches mid-removal), then deletes the plist / unit file
 * and reloads the user manager on Linux. Returns the path it removed, or null if
 * no registration was present. Best-effort + idempotent. Used by
 * `openllmd uninstall`.
 */
export const serviceUninstall = (): string | null => {
  // 1. Stop + disable self-restore so nothing respawns while we tear down.
  if (isMac) stopMac();
  else stopLinux();
  // 2. Remove the registration file itself.
  const path = isMac ? plistPath() : unitPath();
  const existed = existsSync(path);
  rmSync(path, { force: true });
  // Linux: drop the removed unit from the in-memory view so it's fully gone.
  if (!isMac && existed) tryRun("systemctl", ["--user", "daemon-reload"]);
  return existed ? path : null;
};

/**
 * Print the service's registration + RUN state. Three independent signals:
 *   - service:    is a launch agent / systemd unit registered (file on disk);
 *   - supervisor: the OS supervisor's REAL state (sub-state, restarts, last
 *                 exit) — a crash loop shows here, not a false "running";
 *   - health:     a live `/status` probe — the authoritative "actually serving"
 *                 signal, and the source of the live sandbox + cloud state.
 * Async because of the health probe.
 */
export const serviceStatus = async (): Promise<void> => {
  const registered = isMac ? existsSync(plistPath()) : existsSync(unitPath());
  const port = daemonPort();
  const supervisor = supervisorState();
  const health = await probeHealth(port);
  const logs = serviceLogPaths();
  const unknown = "unknown (daemon not responding)";
  process.stdout.write(
    [
      `openllmd v${DAEMON_VERSION}`,
      `  service:    ${registered ? "registered" : "not registered"}`,
      `  supervisor: ${supervisor}`,
      `  health:     ${health !== null ? `serving on 127.0.0.1:${port}` : `NOT responding on :${port}`}`,
      `  sandbox:    ${health !== null ? health.sandbox : unknown}`,
      `  cloud:      ${health !== null ? health.cloud_state : unknown}`,
      `  port:       ${port}`,
      `  binary:     ${process.execPath}`,
      `  state dir:  ${stateDir()}`,
      `  logs:       ${join(stateDir(), "openllmd.log")}`,
      `  stdout:     ${logs.out}`,
      `  stderr:     ${logs.err}`,
      "",
    ].join("\n"),
  );
};
