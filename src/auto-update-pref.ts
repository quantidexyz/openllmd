/**
 * Daemon auto-update opt-out preference — stored in the single config file
 * `daemon.env` as `OPENLLM_DAEMON_AUTO_UPDATE` (`1`/`0`), alongside every other
 * daemon config (no separate flag file).
 *
 * Self-update is OPT-OUT (on by default): a freshly installed daemon keeps
 * itself current automatically, and the user can DISABLE it (from the
 * dashboard's daemon section, `openllmd auto-update off`, or
 * `OPENLLM_DAEMON_AUTO_UPDATE=0`) to pin the installed version. The value is
 * read fresh on every self-update check + status push — `setAutoUpdate` keeps
 * both `daemon.env` and the in-process env in sync, so a toggle takes effect on
 * the next tick without a restart.
 *
 * Precedence: an explicit `OPENLLM_DAEMON_AUTO_UPDATE` (set in the environment,
 * or loaded from `daemon.env` by `loadEnvFile`) decides; absent it, ON.
 *
 * Legacy: a pre-`daemon.env` standalone `~/.openllm/auto-update` flag file is
 * migrated into `daemon.env` and removed — lazily on first read, and proactively
 * at boot via {@link migrateLegacyAutoUpdate}. Mirrors the `api-key` /
 * `device-id` migrations in `env.ts`.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile, stateDir, writeEnvFileVars } from "./env";
import { logWarn } from "./logger";

/** The daemon.env key the preference lives under. */
const AUTO_UPDATE_KEY = "OPENLLM_DAEMON_AUTO_UPDATE";

/** The legacy standalone flag file (pre-`daemon.env` installs). */
const legacyPrefFile = (): string => join(stateDir(), "auto-update");

/** Parse a flag value to bool; null when unrecognized/absent. */
const parseFlag = (raw: string | undefined): boolean | null => {
  const v = raw?.trim();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
};

/**
 * Migrate a legacy `~/.openllm/auto-update` flag file INTO `daemon.env`
 * (`OPENLLM_DAEMON_AUTO_UPDATE`) and remove it, so `daemon.env` stays the single
 * config source. Returns the migrated value, or null when there's no (valid)
 * legacy file. Best-effort + idempotent — safe to call on every boot.
 */
export const migrateLegacyAutoUpdate = (): boolean | null => {
  let legacy: boolean | null;
  try {
    legacy = parseFlag(readFileSync(legacyPrefFile(), "utf-8"));
  } catch {
    return null; // no legacy file — nothing to migrate
  }
  // A stray/garbage file: drop it rather than leave it lying around.
  if (legacy === null) {
    try {
      rmSync(legacyPrefFile(), { force: true });
    } catch {
      // best-effort cleanup
    }
    return null;
  }
  const written = writeEnvFileVars({ [AUTO_UPDATE_KEY]: legacy ? "1" : "0" });
  process.env[AUTO_UPDATE_KEY] = legacy ? "1" : "0";
  if (written) {
    try {
      rmSync(legacyPrefFile(), { force: true });
    } catch {
      // best-effort cleanup of the now-migrated legacy file
    }
  }
  return legacy;
};

/** Whether automatic daemon self-update is enabled. Default TRUE (opt-out). */
export const autoUpdateEnabled = (): boolean => {
  loadEnvFile(); // pull daemon.env into process.env (idempotent; sets unset only)
  const fromEnv = parseFlag(process.env[AUTO_UPDATE_KEY]);
  if (fromEnv !== null) return fromEnv;
  // No value in daemon.env yet — adopt a legacy standalone file if present.
  const migrated = migrateLegacyAutoUpdate();
  if (migrated !== null) return migrated;
  return true; // default ON until explicitly opted out
};

/**
 * Persist the auto-update opt-in into `daemon.env` (`0600`, merge) and update
 * the in-process env so the next check sees it immediately. Drops any legacy
 * standalone flag file so `daemon.env` stays the single source.
 */
export const setAutoUpdate = (enabled: boolean): void => {
  const value = enabled ? "1" : "0";
  if (!writeEnvFileVars({ [AUTO_UPDATE_KEY]: value })) {
    logWarn("auto-update", "failed to persist preference to daemon.env");
  }
  process.env[AUTO_UPDATE_KEY] = value;
  try {
    rmSync(legacyPrefFile(), { force: true });
  } catch {
    // best-effort cleanup of the now-superseded legacy file
  }
};
