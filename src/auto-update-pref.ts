/**
 * Daemon auto-update opt-out preference.
 *
 * Self-update is OPT-OUT (on by default): a freshly installed daemon keeps
 * itself current automatically, and the user can DISABLE it (from the
 * dashboard's daemon section, or `openllmd auto-update off`) to pin the
 * installed version. The choice is persisted to a tiny `~/.openllm/auto-update`
 * flag file (`1`/`0`) so it survives restarts, and is read fresh on every
 * self-update check + status push (no caching — a toggle takes effect on the
 * next tick without a daemon restart).
 *
 * Precedence: the persisted flag wins; absent it, the `OPENLLM_DAEMON_AUTO_UPDATE`
 * env var seeds the initial default (`0`/`false` opts out up front); absent
 * both, ON. See `packages/daemon/src/self-update.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";
import { logWarn } from "./logger";

const prefFile = (): string => join(stateDir(), "auto-update");

/** Whether automatic daemon self-update is enabled. Default TRUE (opt-out). */
export const autoUpdateEnabled = (): boolean => {
  try {
    const raw = readFileSync(prefFile(), "utf-8").trim();
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // no persisted preference yet — fall through to the env default
  }
  const env = process.env.OPENLLM_DAEMON_AUTO_UPDATE;
  // Default ON: only an explicit `0`/`false` opts out before a flag is written.
  return env !== "0" && env !== "false";
};

/** Persist the auto-update opt-in (`0600`). Takes effect on the next check. */
export const setAutoUpdate = (enabled: boolean): void => {
  try {
    mkdirSync(stateDir(), { recursive: true });
  } catch {
    // best-effort — the write below surfaces a real failure
  }
  try {
    writeFileSync(prefFile(), enabled ? "1" : "0", { mode: 0o600 });
  } catch (err) {
    logWarn("auto-update", "failed to persist preference", {
      err: String(err),
    });
  }
};
