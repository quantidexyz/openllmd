/**
 * One monotonic operation budget for daemon-local external process work
 * (status owner, keychain `security` lane, login/PTY child lifecycle).
 *
 * Timebase is `performance.now()`. Expiry is typed unavailability, never auth
 * truth. Observer cancellation must not be passed as `parent` of a producer
 * budget the observer does not own.
 */
import {
  DEFAULT_FINAL_REAP_MS,
  DEFAULT_TERMINATE_GRACE_MS,
} from "./child-supervisor/posix";

export type TDeadlineBudget = {
  readonly signal: AbortSignal;
  remainingMs(): number;
  expired(): boolean;
  child(maxMs: number): TDeadlineBudget;
};

const attached = new WeakMap<AbortSignal, TDeadlineBudget>();

export const budgetFromSignal = (
  signal: AbortSignal | undefined,
): TDeadlineBudget | undefined =>
  signal === undefined ? undefined : attached.get(signal);

export const createDeadlineBudget = (
  durationMs: number,
  parent?: AbortSignal,
): TDeadlineBudget => {
  const cap = Math.max(0, durationMs);
  const expiresAt = performance.now() + cap;
  const ac = new AbortController();

  const remainingMs = (): number => Math.max(0, expiresAt - performance.now());
  const expired = (): boolean => remainingMs() === 0 || ac.signal.aborted;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const abortFromDeadline = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!ac.signal.aborted) ac.abort();
  };

  if (cap === 0) {
    abortFromDeadline();
  } else {
    timer = setTimeout(abortFromDeadline, cap);
  }

  if (parent !== undefined) {
    if (parent.aborted) abortFromDeadline();
    else parent.addEventListener("abort", abortFromDeadline, { once: true });
  }

  const budget: TDeadlineBudget = {
    signal: ac.signal,
    remainingMs,
    expired,
    child(maxMs: number): TDeadlineBudget {
      return createDeadlineBudget(Math.min(Math.max(0, maxMs), remainingMs()));
    },
  };
  attached.set(ac.signal, budget);
  return budget;
};

export const waitUntilExpired = (budget: TDeadlineBudget): Promise<void> => {
  if (budget.expired()) return Promise.resolve();
  return new Promise((resolve) => {
    budget.signal.addEventListener("abort", () => resolve(), { once: true });
  });
};

/** Race work against the budget. Expired wins; work is not cancelled unless it honors `budget.signal`. */
export const firstOfBudget = async <T>(
  budget: TDeadlineBudget,
  work: Promise<T>,
): Promise<{ readonly kind: "value"; readonly value: T } | { readonly kind: "expired" }> => {
  if (budget.expired()) return { kind: "expired" };
  return Promise.race([
    work.then((value) => ({ kind: "value" as const, value })),
    waitUntilExpired(budget).then(() => ({ kind: "expired" as const })),
  ]);
};

/**
 * How late a `setTimeout(delayMs)` callback ran relative to arming, using the
 * same `performance.now()` clock as {@link createDeadlineBudget}. Negative
 * (early fire) is preserved; callers must not treat this as host-sleep proof.
 */
export const timeoutCallbackLatenessMs = (
  timerArmedAtMs: number,
  timerFiredAtMs: number,
  delayMs: number,
): number => timerFiredAtMs - timerArmedAtMs - delayMs;

export const splitReapBudget = (
  remainingMs: number,
): { graceMs: number; finalReapMs: number } => {
  if (remainingMs <= 0) {
    return { graceMs: 0, finalReapMs: Math.min(50, DEFAULT_FINAL_REAP_MS) };
  }
  const graceMs = Math.min(
    DEFAULT_TERMINATE_GRACE_MS,
    Math.floor(remainingMs / 2),
  );
  return {
    graceMs,
    finalReapMs: Math.min(
      DEFAULT_FINAL_REAP_MS,
      Math.max(0, remainingMs - graceMs),
    ),
  };
};
