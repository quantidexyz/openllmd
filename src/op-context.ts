/**
 * The daemon's ONE AsyncLocalStorage module. Refresh spawn metadata and the
 * status-tick correlation bag both live here so a later reader never has to
 * hunt a second ALS.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type TRefreshSpawnBag = {
  meta:
    | {
        readonly spawned_at_ms: number | null;
        readonly child_pid: number | null;
      }
    | undefined;
  timeoutMs: number | undefined;
};

export const refreshSpawnBag = new AsyncLocalStorage<TRefreshSpawnBag>();

/** Who kicked `makeRefresher` — demand-path tag for `refresh_spawns.last`. */
export type TRefreshCaller = "upstream" | "usage" | "models" | "login";

export const refreshCallerBag = new AsyncLocalStorage<TRefreshCaller>();

export const currentRefreshCaller = (): TRefreshCaller | null =>
  refreshCallerBag.getStore() ?? null;

export type TOpTick = {
  readonly tick_id: number;
  readonly slug?: string;
};

export const opTickContext = new AsyncLocalStorage<TOpTick>();

let nextTickId = 0;

export const nextStatusTickId = (): number => {
  nextTickId += 1;
  return nextTickId;
};

/** `null` off a status tick (e.g. a request-path refresh). */
export const currentTickId = (): number | null =>
  opTickContext.getStore()?.tick_id ?? null;
