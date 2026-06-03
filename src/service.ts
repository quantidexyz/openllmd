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
 * refused; use the compiled binary (`bun run daemon:install`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonEnv, stateDir } from "./env";
import { hardenMacBinary } from "./harden-binary";
import { DAEMON_VERSION } from "./version";

const LABEL = "sh.openllm.daemon";
const DEFAULT_PORT = 8787;
const isMac = process.platform === "darwin";

const envFilePath = (): string => join(stateDir(), "daemon.env");
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
 * Write the env file (cloud origin + port) the service reads at boot. Created
 * when absent so a standalone `openllmd start` works without the installer;
 * also (re)written when `OPENLLM_CLOUD_ORIGIN` or `OPENLLM_DAEMON_PORT` is set
 * explicitly, so `OPENLLM_CLOUD_ORIGIN=… openllmd start` (or `…PORT=…`)
 * re-points an existing install. The installer writes its own env file first
 * (with the gateway origin it paired to), so this leaves that untouched.
 */
const writeEnvFileIfNeeded = (): void => {
  const path = envFilePath();
  // Either var set explicitly re-points an existing install — otherwise
  // `OPENLLM_DAEMON_PORT=9000 openllmd start` would report :9000 while the
  // persisted env file (what the service actually boots with) kept the old one.
  const explicitOverride =
    process.env.OPENLLM_CLOUD_ORIGIN !== undefined ||
    process.env.OPENLLM_DAEMON_PORT !== undefined;
  if (existsSync(path) && !explicitOverride) return;
  mkdirSync(stateDir(), { recursive: true });
  const env = daemonEnv();
  writeFileSync(
    path,
    `OPENLLM_CLOUD_ORIGIN=${env.cloudOrigin}\nOPENLLM_DAEMON_PORT=${daemonPort()}\n`,
    { mode: 0o600 },
  );
};

const renderPlist = (binPath: string): string => {
  const dir = stateDir();
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
  <key>ThrottleInterval</key><integer>2</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${join(dir, "openllmd.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(dir, "openllmd.err.log")}</string>
</dict>
</plist>
`;
};

const renderUnit = (binPath: string): string => `[Unit]
Description=OpenLLM local daemon
After=network-online.target
Wants=network-online.target
# Never give up. systemd's default start-limit (5 starts / 10s) would park the
# unit in "failed" after a brief crash loop and stop trying — the daemon is
# meant to run forever, so disable the rate limiter entirely.
StartLimitIntervalSec=0

[Service]
EnvironmentFile=${envFilePath()}
ExecStart=${binPath}
# Always restart: clean exit, crash, OOM-kill, signal — anything. The ONLY
# thing that keeps it down is an explicit \`systemctl --user stop openllmd\` (a
# manual stop does not re-trigger Restart=). RestartSec throttles the respawn so
# a hard crash loop can't peg the CPU.
Restart=always
RestartSec=2

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

const macRunning = (): boolean => {
  // `launchctl print` exits non-zero when the label isn't bootstrapped; when it
  // is, the output carries a `state = running` (or a numeric pid) line.
  const out = capture("launchctl", ["print", guiTarget()]);
  if (out.length === 0) return false;
  return /state = running/.test(out) || /\bpid = \d+/.test(out);
};

const linuxRunning = (): boolean =>
  capture("systemctl", ["--user", "is-active", "openllmd.service"]).trim() ===
  "active";

/**
 * Register + start the service in full self-restore mode. Idempotent. Refuses
 * to register a from-source run (would point the service at `bun`).
 */
export const serviceStart = (): void => {
  if (DAEMON_VERSION === "0.0.0-dev") {
    process.stderr.write(
      "refusing to register a service from a source run.\n" +
        "Build + install the compiled binary first: bun run daemon:install\n",
    );
    process.exit(2);
  }
  const binPath = process.execPath;
  writeEnvFileIfNeeded();
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

/** Print the service's registration + run state. */
export const serviceStatus = (): void => {
  const registered = isMac ? existsSync(plistPath()) : existsSync(unitPath());
  const running = isMac ? macRunning() : linuxRunning();
  const port = daemonPort();
  process.stdout.write(
    [
      `openllmd v${DAEMON_VERSION}`,
      `  service:   ${registered ? "registered" : "not registered"}`,
      `  state:     ${running ? "running (self-restore on)" : "stopped"}`,
      `  port:      ${port}`,
      `  binary:    ${process.execPath}`,
      `  state dir: ${stateDir()}`,
      `  logs:      ${join(stateDir(), "openllmd.log")}`,
      "",
    ].join("\n"),
  );
};
