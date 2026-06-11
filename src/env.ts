/**
 * Daemon runtime configuration.
 *
 * Everything lives in ONE file — `~/.openllm/daemon.env` (resolved via
 * `envFilePath()`). It's the single source both dev (`bun dev:daemon`,
 * which auto-loads it) and the installed service (systemd `EnvironmentFile=`
 * / the macOS launch agent's `OPENLLM_DAEMON_ENV_FILE`) boot from. The
 * keys it holds:
 *
 * - `OPENLLM_API_KEY`     — the user's `sk-llm-...` key. Authenticates
 *                            every cloud control-plane call. OPTIONAL at
 *                            boot: the daemon installs WITHOUT a key and
 *                            the dashboard sets it afterwards via the
 *                            control surface (`POST /config/api-key`).
 *                            Persisted to daemon.env so it survives
 *                            restarts / HMR. Never leaves the box.
 * - `OPENLLM_DEVICE_ID`   — stable opaque per-machine UUID, minted into
 *                            daemon.env on first boot. Carries no PII.
 * - `OPENLLM_CLOUD_ORIGIN`— openllm.sh origin for config pull + request
 *                            recording + API-key-hop forwarding. Baked in
 *                            at compile time via --define, overridable.
 * - `OPENLLM_DASHBOARD_ORIGIN` — allowed CORS origin for the control
 *                            surface (the dashboard). Defaults to the
 *                            cloud origin. Access control is the
 *                            localhost bind + this origin lock; there is
 *                            no separate control token at this stage.
 * - `OPENLLM_DAEMON_STATE_DIR` — where daemon.env + state live
 *                            (default `~/.openllm`).
 *
 * Legacy standalone `api-key` / `device-id` files (pre-single-file
 * installs) are migrated INTO daemon.env on first read and then removed.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
 * Root for the daemon's local state (`daemon.env`, the isolated vendor CLIs
 * under `cli/<provider>/`, …). Defaults to `~/.openllm`; override with
 * `OPENLLM_DAEMON_STATE_DIR`. Exported so cli-paths.ts nests under it.
 */
export const stateDir = (): string =>
  process.env.OPENLLM_DAEMON_STATE_DIR ?? join(homedir(), ".openllm");

/**
 * The daemon's single env/config file. `OPENLLM_DAEMON_ENV_FILE` wins (the
 * macOS launch agent points us here because launchd can't read a native
 * `EnvironmentFile`); otherwise it's `daemon.env` under the state dir — the
 * same path systemd's `EnvironmentFile=` and the installer write to, and the
 * one `bun dev:daemon` auto-loads.
 */
export const envFilePath = (): string =>
  process.env.OPENLLM_DAEMON_ENV_FILE ?? join(stateDir(), "daemon.env");

/**
 * Load the daemon's `KEY=value` env file into `process.env` (without
 * overwriting already-set vars). Resolved via `envFilePath()` — the single
 * config file. systemd injects the same file via `EnvironmentFile=` before
 * exec (so this read is a harmless no-op there); the macOS launch agent and
 * `bun dev:daemon` rely on this read to load it. No-op when the file is
 * missing. Synchronous (boot-time, before anything reads env).
 */
const loadEnvFile = (): void => {
  let text: string;
  try {
    text = readFileSync(envFilePath(), "utf-8");
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
 * Upsert `KEY=value` pairs into daemon.env, preserving every other line
 * (comments, unrelated keys, ordering). Creates the file `0600` when absent.
 * This is how runtime-resolved secrets/ids (`OPENLLM_API_KEY`,
 * `OPENLLM_DEVICE_ID`) and re-pointed config (`OPENLLM_CLOUD_ORIGIN`,
 * `OPENLLM_DAEMON_PORT`) get persisted back to the one file both dev and the
 * service boot from. Returns true on successful write, false on failure.
 */
export const writeEnvFileVars = (
  updates: Readonly<Record<string, string>>,
): boolean => {
  let existing: string[] = [];
  try {
    existing = readFileSync(envFilePath(), "utf-8").split("\n");
  } catch {
    // no file yet — start fresh
  }
  const pending = new Map(Object.entries(updates));
  const out = existing.map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    const next = pending.get(key);
    if (next === undefined) return line;
    pending.delete(key);
    return `${key}=${next}`;
  });
  // Drop trailing blank lines so re-writes don't accumulate them, then append
  // any keys that weren't already present.
  while (out.length > 0 && out[out.length - 1].trim().length === 0) out.pop();
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  try {
    const parentDir = dirname(envFilePath());
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(envFilePath(), `${out.join("\n")}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
};

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
 * A stable per-machine id, minted once and persisted in daemon.env as
 * `OPENLLM_DEVICE_ID`. Opaque (a random uuid) — carries no PII. Used to bind
 * the daemon's presence token to this device
 * (`docs/proposals/daemon-presence-without-heartbeat.md`); survives restarts
 * so the token stays constant. A legacy standalone `device-id` file (older
 * installs) is migrated into daemon.env and removed.
 */
export const deviceId = (): string => {
  if (cachedDeviceId !== null) return cachedDeviceId;
  loadEnvFile();
  const fromEnv = process.env.OPENLLM_DEVICE_ID?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    cachedDeviceId = fromEnv;
    return fromEnv;
  }
  // Adopt a legacy standalone file if present, else mint a fresh id. Either
  // way it lives in daemon.env afterwards (single source).
  let id: string | null = null;
  try {
    const legacy = readFileSync(deviceIdFile(), "utf-8").trim();
    if (legacy.length > 0) id = legacy;
  } catch {
    // no legacy file — mint below
  }
  if (id === null) id = randomUUID();
  const written = writeEnvFileVars({ OPENLLM_DEVICE_ID: id });
  process.env.OPENLLM_DEVICE_ID = id;
  if (written) {
    try {
      rmSync(deviceIdFile(), { force: true });
    } catch {
      // best-effort cleanup of the now-migrated legacy file
    }
  }
  cachedDeviceId = id;
  return id;
};

/**
 * The persisted API key, if any. `OPENLLM_API_KEY` (loaded from daemon.env by
 * `loadEnvFile`, or set explicitly in the environment) wins; otherwise a
 * legacy standalone `api-key` file (older installs) is migrated into
 * daemon.env, removed, and used. Returns null when neither is present — the
 * daemon runs keyless until the dashboard sets one. Callers run `loadEnvFile`
 * before this (via `daemonEnv`).
 */
const loadApiKey = (): string | null => {
  const fromEnv = process.env.OPENLLM_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    const legacy = readFileSync(apiKeyFile(), "utf-8").trim();
    if (legacy.length > 0) {
      const written = writeEnvFileVars({ OPENLLM_API_KEY: legacy });
      process.env.OPENLLM_API_KEY = legacy;
      if (written) {
        try {
          rmSync(apiKeyFile(), { force: true });
        } catch {
          // best-effort cleanup of the now-migrated legacy file
        }
      }
      return legacy;
    }
  } catch {
    // no legacy key file — keyless
  }
  return null;
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
 * Persist a new API key (set from the dashboard) into daemon.env (`0600`) and
 * update the in-memory cache so the next cloud call uses it immediately. Pass
 * `null`/empty to clear it. Removes any legacy standalone `api-key` file so
 * daemon.env stays the single source.
 */
export const setApiKey = (key: string | null): void => {
  const trimmed = key?.trim() ?? "";
  writeEnvFileVars({ OPENLLM_API_KEY: trimmed });
  process.env.OPENLLM_API_KEY = trimmed;
  try {
    rmSync(apiKeyFile(), { force: true });
  } catch {
    // best-effort cleanup of the now-migrated legacy file
  }
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
