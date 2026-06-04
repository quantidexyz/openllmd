/**
 * Daemon runtime configuration.
 *
 * - `OPENLLM_API_KEY`     — the user's `sk-llm-...` key. Authenticates
 *                            every cloud control-plane call. OPTIONAL at
 *                            boot: the daemon installs WITHOUT a key and
 *                            the dashboard sets it afterwards via the
 *                            control surface (`POST /config/api-key`). It
 *                            is persisted to a local key file so it
 *                            survives restarts / HMR. Never leaves the box.
 * - `OPENLLM_CLOUD_ORIGIN`— openllm.sh origin for config pull + request
 *                            recording + API-key-hop forwarding. Baked in
 *                            at compile time via --define, overridable.
 * - `OPENLLM_DASHBOARD_ORIGIN` — allowed CORS origin for the control
 *                            surface (the dashboard). Defaults to the
 *                            cloud origin. Access control is the
 *                            localhost bind + this origin lock; there is
 *                            no separate control token at this stage.
 * - `OPENLLM_DAEMON_STATE_DIR` — where the persisted API key lives
 *                            (default `~/.openllm`).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TDaemonEnv = {
  /** The user's `sk-llm-...` key, or null until the dashboard sets it. */
  readonly apiKey: string | null;
  readonly cloudOrigin: string;
  readonly dashboardOrigin: string;
};

/**
 * Compile-time default for the cloud origin, injected by
 * scripts/compile.ts via `--define __OPENLLM_CLOUD_ORIGIN_DEFAULT__`.
 * Declared as a global (NOT `process.env`) so the bundler replaces the
 * identifier without clobbering the runtime `process.env` read below —
 * the env var must still win for local testing. Falls back to the public
 * origin when run from source (no define).
 */
declare const __OPENLLM_CLOUD_ORIGIN_DEFAULT__: string | undefined;
const compiledCloudOrigin = (): string => {
  try {
    return typeof __OPENLLM_CLOUD_ORIGIN_DEFAULT__ === "string"
      ? __OPENLLM_CLOUD_ORIGIN_DEFAULT__
      : "https://openllm.sh";
  } catch {
    return "https://openllm.sh";
  }
};

/**
 * Dev mode (`OPENLLM_DAEMON_DEV=1`, set by `bun run dev:daemon`). Lets
 * the daemon boot from source with `bun --watch` without a full install:
 * the cloud origin defaults to the local Next server and a failed/absent
 * cloud bootstrap is non-fatal. The API key is NOT defaulted — you set a
 * real one from the dashboard's Providers tab (same as production), which
 * also exercises that flow during development. Never set in production.
 */
export const isDevMode = (): boolean => process.env.OPENLLM_DAEMON_DEV === "1";

// Dev-only fallback for the cloud origin — points at the local Next
// server. (The dashboard origin falls back through `cloudOrigin`, and the
// API key is intentionally absent — set it from the UI like a real user.)
const DEV_CLOUD_ORIGIN = "http://127.0.0.1:3000";

/**
 * Load a `KEY=value` env file into `process.env` (without overwriting
 * already-set vars). macOS launchd can't read an `EnvironmentFile`, so
 * the install agent points us at `OPENLLM_DAEMON_ENV_FILE` and we read
 * it ourselves at boot. No-op when the var is unset or the file is
 * missing. Synchronous (boot-time, before anything reads env).
 */
const loadEnvFile = (): void => {
  const path = process.env.OPENLLM_DAEMON_ENV_FILE;
  if (path === undefined || path.length === 0) return;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
};

/**
 * Root for the daemon's local state (`api-key`, the isolated vendor CLIs
 * under `cli/<provider>/`, …). Defaults to `~/.openllm`; override with
 * `OPENLLM_DAEMON_STATE_DIR`. Exported so cli-paths.ts nests under it.
 */
export const stateDir = (): string =>
  process.env.OPENLLM_DAEMON_STATE_DIR ?? join(homedir(), ".openllm");

/** The default loopback port for the daemon's `/v1/*` + `/whoami` surface. */
export const DEFAULT_DAEMON_PORT = 8787;

/**
 * The loopback port the daemon listens on (`OPENLLM_DAEMON_PORT`, default
 * `8787`). Single source — `main.ts` binds it and `status.ts` publishes it on
 * `TDaemonStatus.port` so the dashboard can probe `/whoami` for locality. See
 * `docs/proposals/this-machine-detection-audit.md`.
 */
export const daemonPort = (): number => {
  // `main()` resolves the port before anything else calls `daemonEnv()`, so load
  // the env file here too — otherwise a port supplied via `OPENLLM_DAEMON_ENV_FILE`
  // is ignored for the actual bind. Idempotent (only sets unset vars).
  loadEnvFile();
  const raw = process.env.OPENLLM_DAEMON_PORT;
  if (raw === undefined) return DEFAULT_DAEMON_PORT;
  // Whole-string integer in the valid TCP range — reject `8787abc`, `0`, > 65535.
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_DAEMON_PORT;
};

const apiKeyFile = (): string => join(stateDir(), "api-key");

const deviceIdFile = (): string => join(stateDir(), "device-id");

const cloudOriginFile = (): string => join(stateDir(), "cloud-origin");

/**
 * A cloud origin the daemon ADOPTED at runtime (dev only — see
 * `setCloudOrigin`), persisted so it survives a restart. Lets a dev daemon
 * keep serving whatever deployment's dashboard it last followed instead of
 * snapping back to the local-Next default (which may be unreachable when
 * you're testing a preview/prod). Null when none was adopted.
 */
const loadPersistedCloudOrigin = (): string | null => {
  try {
    const v = readFileSync(cloudOriginFile(), "utf-8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
};

let cachedDeviceId: string | null = null;

/**
 * A stable per-machine id, generated once and persisted under the state dir
 * (`~/.openllm/device-id`). Opaque (a random uuid) — carries no PII. Used to
 * bind the daemon's presence token to this device
 * (`docs/proposals/daemon-presence-without-heartbeat.md`); survives restarts
 * so the token stays constant.
 */
export const deviceId = (): string => {
  if (cachedDeviceId !== null) return cachedDeviceId;
  try {
    const existing = readFileSync(deviceIdFile(), "utf-8").trim();
    if (existing.length > 0) {
      cachedDeviceId = existing;
      return existing;
    }
  } catch {
    // no id yet — generate + persist below
  }
  const fresh = randomUUID();
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(deviceIdFile(), fresh, { mode: 0o600 });
  } catch {
    // best-effort persistence; an in-memory id still works for this run
  }
  cachedDeviceId = fresh;
  return fresh;
};

/**
 * The persisted API key, if any. Precedence: the local key file (set via
 * the dashboard) wins, then the `OPENLLM_API_KEY` env var (legacy /
 * explicit override). Returns null when neither is present — the daemon
 * runs keyless until the dashboard sets one.
 */
const loadApiKey = (): string | null => {
  try {
    const fromFile = readFileSync(apiKeyFile(), "utf-8").trim();
    if (fromFile.length > 0) return fromFile;
  } catch {
    // no key file yet — fall through to env
  }
  const fromEnv = process.env.OPENLLM_API_KEY;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : null;
};

let cached: TDaemonEnv | null = null;

export const daemonEnv = (): TDaemonEnv => {
  if (cached !== null) return cached;
  loadEnvFile();
  // In dev, default the cloud origin to the local Next server rather than
  // the compiled-in production origin.
  const originDefault = isDevMode() ? DEV_CLOUD_ORIGIN : compiledCloudOrigin();
  // Precedence: an explicit env var (the installed prod daemon sets it) wins;
  // then a dev-adopted origin persisted across restart; then the default.
  const cloudOrigin = (
    process.env.OPENLLM_CLOUD_ORIGIN ??
    loadPersistedCloudOrigin() ??
    originDefault
  ).replace(/\/+$/, "");
  cached = {
    apiKey: loadApiKey(),
    cloudOrigin,
    dashboardOrigin: (
      process.env.OPENLLM_DASHBOARD_ORIGIN ?? cloudOrigin
    ).replace(/\/+$/, ""),
  };
  return cached;
};

/**
 * Persist a new API key (set from the dashboard) and update the in-memory
 * cache so the next cloud call uses it immediately. Writes `0600` to the
 * key file under the state dir. Pass `null`/empty to clear it.
 */
export const setApiKey = (key: string | null): void => {
  const trimmed = key?.trim() ?? "";
  const dir = stateDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort — write below will surface a real failure
  }
  writeFileSync(apiKeyFile(), trimmed, { mode: 0o600 });
  // Refresh the cache in place so callers don't need to re-resolve env.
  const current = daemonEnv();
  cached = { ...current, apiKey: trimmed.length > 0 ? trimmed : null };
};

export const hasApiKey = (): boolean => daemonEnv().apiKey !== null;

/**
 * Re-point the daemon's cloud origin at runtime (DEV only — gated by the
 * caller in `control.ts`). PERSISTS the choice (so it survives a restart)
 * and updates the in-memory cache so the next bootstrap, usage record, and
 * API-key-hop forward target the new origin. Lets one local dev daemon serve
 * whichever deployment's dashboard it last followed (a preview, prod, or
 * localhost) without a reinstall. No-op on an empty origin.
 */
export const setCloudOrigin = (origin: string): void => {
  const trimmed = origin.replace(/\/+$/, "");
  if (trimmed.length === 0) return;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(cloudOriginFile(), trimmed, { mode: 0o600 });
  } catch {
    // best-effort persistence; the in-memory update below still applies
  }
  const current = daemonEnv();
  cached = { ...current, cloudOrigin: trimmed, dashboardOrigin: trimmed };
};
