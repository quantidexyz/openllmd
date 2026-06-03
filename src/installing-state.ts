/**
 * In-memory "this CLI is installing right now" flag, per provider.
 *
 * `cli_install` runs synchronously in the control-loop handler (download +
 * unpack can take several seconds), during which the daemon can't push status.
 * The handler sets this flag and pushes ONE interim status BEFORE the blocking
 * install, so the dashboard shows a synced "Installing…" state immediately —
 * and, because it rides on the daemon's status (not a browser-local optimistic
 * flag), it survives a page refresh. Cleared when the install returns; the next
 * status then carries `cli_installed: true`.
 *
 * In-memory only — a restart drops it (and any in-flight install is gone too).
 */
const installing = new Set<string>();

export const setInstalling = (slug: string): void => {
  installing.add(slug);
};

export const clearInstalling = (slug: string): void => {
  installing.delete(slug);
};

export const isInstalling = (slug: string): boolean => installing.has(slug);

/** Any provider currently installing — gates the status-change watcher. */
export const anyInstalling = (): boolean => installing.size > 0;
