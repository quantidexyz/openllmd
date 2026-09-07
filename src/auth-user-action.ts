/**
 * User-caused auth-action tracker (LEAF module).
 *
 * Records when the user intentionally started, completed, or cancelled a login
 * or logout, so the session-lost notifier can suppress a falling edge the user
 * themselves caused (browser login/out churn) instead of treating it as an
 * unprompted drop worth emailing about.
 *
 * Deliberately a LEAF — no `./delegation/login-flow` (or barrel `./delegation`).
 * `login-flow` records actions here; importing login-flow would put `loginSlot`
 * in the temporal dead zone. `observation-cache` is a sibling leaf.
 */

import { bumpStoreIdentityEpoch } from "./delegation/observation-cache";

/** Last time the user intentionally started, completed, or cancelled auth. */
const lastUserAuthActionAt = new Map<string, number>();

type TStoreIdentityChangeHook = (slug: string) => void;
let storeIdentityChangeHook: TStoreIdentityChangeHook | null = null;

/**
 * Status registers probe-backoff clear here so delegates can notify a
 * credential-store identity change without importing `status.ts`.
 */
export const setAuthStoreIdentityChangeHook = (
  hook: TStoreIdentityChangeHook | null,
): void => {
  storeIdentityChangeHook = hook;
};

/** Credential store identity changed (login/logout/refresh/invalidate). */
export const noteAuthStoreIdentityChange = (slug: string): void => {
  bumpStoreIdentityEpoch(slug);
  storeIdentityChangeHook?.(slug);
};

/** Record a user-caused authentication action for login-flow churn tracking. */
export const noteUserAuthAction = (slug: string, now = Date.now()): void => {
  lastUserAuthActionAt.set(slug, now);
};

/** Test-only: clear all recorded user actions. */
export const resetUserAuthActionsForTests = (): void => {
  lastUserAuthActionAt.clear();
};
