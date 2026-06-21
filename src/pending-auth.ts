/**
 * In-memory pending device-code auth, per provider.
 *
 * When a delegate starts a device-code flow on a REMOTE daemon (codex /
 * kimi), the box that runs it isn't where the user's browser is — so the
 * verification URL + one-time code must reach the dashboard. The delegate
 * stashes them here; the daemon's STATUS push surfaces them (as the
 * connection `detail`) so the user can open the URL and authorize from their
 * own machine. Cleared when the credential lands (status sees `connected`) or
 * the flow is abandoned/expires.
 *
 * In-memory only — a daemon restart drops it and a fresh Connect re-creates
 * it. Not a secret (a device code is single-use + short-lived), so no
 * persistence and nothing sensitive is held.
 */
export type TPendingAuth = {
  readonly url: string;
  readonly code: string;
  /** `device_code` (codex/kimi: the user enters `code` in their browser at
   *  `url`, the daemon polls) or `paste_code` (claude headless login: the user
   *  signs in at `url`, the hosted page shows a code, the user pastes it back
   *  — `code` is empty, the dashboard renders a paste input). Absent ⇒
   *  `device_code`. See `docs/proposals/headless-claude-login-paste-back.md`. */
  readonly mode?: "device_code" | "paste_code";
};

const pending = new Map<string, TPendingAuth>();

export const setPendingAuth = (slug: string, auth: TPendingAuth): void => {
  pending.set(slug, auth);
};

export const getPendingAuth = (slug: string): TPendingAuth | null =>
  pending.get(slug) ?? null;

export const clearPendingAuth = (slug: string): void => {
  pending.delete(slug);
};

/** Any provider awaiting device-code authorization — gates the status-change
 *  watcher so a background login completing flips the card without a manual
 *  refresh. See `docs/proposals/daemon-browser-status-sync.md` §2.2. */
export const hasPendingAuth = (): boolean => pending.size > 0;

/** A human-facing one-liner for the dashboard `detail` while a pending auth is
 *  live. `paste_code` (claude headless) asks the user to paste the code the
 *  hosted page shows; device-code flows that carry a `code` ask the user to
 *  enter it in the browser; the browser-OAuth flow (codex) has none (the
 *  localhost callback completes it), so the code clause is omitted. */
export const pendingAuthDetail = (auth: TPendingAuth): string =>
  auth.mode === "paste_code"
    ? `Open ${auth.url} in your browser, sign in, then paste the code it shows back here to authorize.`
    : auth.code.length > 0
      ? `Open ${auth.url} in your browser and enter the code ${auth.code} to authorize. This updates automatically once you're done.`
      : `Open ${auth.url} in your browser to authorize. This updates automatically once you're done.`;
