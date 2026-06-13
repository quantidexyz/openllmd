/**
 * Per-provider usage-snapshot cache.
 *
 * `computeStatus()` runs on every status push — every control-relay poll
 * (~25-35s) and every ~2.5s while a background flow (CLI install / device-code
 * login) is in flight. Each call used to hit the vendor's usage endpoint
 * LIVE (e.g. Claude's `api/oauth/usage`), which has its OWN low rate limit,
 * separate from inference. After ~5 minutes of pushes that endpoint started
 * returning 429 ("Claude couldn't report usage (HTTP 429)") even though
 * inference kept working fine.
 *
 * This cache decouples the usage read from the push cadence by gating the
 * vendor call on time-since-last-ATTEMPT — success OR failure — so we hit the
 * vendor at most once per {@link FRESH_TTL_MS} no matter what:
 *   - a fresh successful snapshot is reused for {@link FRESH_TTL_MS} (the quota
 *     windows are 5h/7d, so minute-level staleness is irrelevant);
 *   - CRUCIALLY, a FAILED read also starts the same back-off window. Without
 *     this, an `unavailable` snapshot never satisfied the "fresh" check, so the
 *     cache fell through and re-hit the vendor on EVERY push — once you were
 *     429'd with a cold/aged cache (daemon restart, or the first read already
 *     429'd because inference shares the limit) the daemon hammered the
 *     rate-limited endpoint every ~2.5-30s and never recovered. Now a failure
 *     backs off for {@link FRESH_TTL_MS} too;
 *   - while backing off after a failure, the last good snapshot keeps being
 *     served for up to {@link STALE_TTL_MS} (so the card shows the last known
 *     figures, not an error) — after that the failure reason surfaces;
 *   - the served snapshot is STAMPED (`stale` + `as_of_ms`) whenever it's a
 *     fallback rather than a this-instant read, so the dashboard shows the
 *     last-known figures under a "cached · updated Xm ago" badge instead of
 *     silently presenting old numbers as live (or a bare error);
 *   - the last good snapshot is PERSISTED to disk
 *     (`<stateDir>/usage-cache.json`) once the daemon opts in via
 *     {@link enableUsagePersistence}, so a daemon RESTART doesn't lose it —
 *     before this, a restart wiped the in-memory good snapshot and, if the
 *     first post-restart read 429'd, the card showed a rate-limit error with
 *     NOTHING to fall back to (the bug behind "it says it shows previous
 *     results but it doesn't"). The persisted `lastAttemptAtMs` also makes a
 *     quick restart respect the back-off instead of re-hitting the vendor
 *     immediately;
 *   - concurrent callers during a refresh share ONE in-flight fetch
 *     (single-flight per provider).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@quantidexyz/openllmp";

// Hit the vendor at most once per this window — applies to BOTH a successful
// read (the figures are reused) and a failed one (we back off instead of
// hammering a rate-limited endpoint).
const FRESH_TTL_MS = 5 * 60_000;
// After a failed refresh, keep serving the last good snapshot for up to this
// long rather than showing an error — but don't show stale quota forever.
const STALE_TTL_MS = 30 * 60_000;

type TUsageEntry = {
  // The last USABLE snapshot + when we obtained it (drives the "last known
  // figures" fallback and its STALE_TTL_MS age-out). Null until the first
  // successful read.
  good: { snapshot: TProviderUsageSnapshot; atMs: number } | null;
  // The last FAILED snapshot — served only once `good` has aged out.
  failure: TProviderUsageSnapshot | null;
  // When we last CALLED the vendor (success or fail). Gates re-fetching.
  lastAttemptAtMs: number;
  inFlight: Promise<TProviderUsageSnapshot> | null;
};

const cache = new Map<string, TUsageEntry>();

const isUsable = (s: TProviderUsageSnapshot): boolean =>
  s.kind !== "unavailable";

// ---------------------------------------------------------------------------
// Disk persistence (opt-in; the daemon enables it at boot, unit tests don't).
// ---------------------------------------------------------------------------

type TPersistedEntry = {
  good: { snapshot: TProviderUsageSnapshot; atMs: number };
  lastAttemptAtMs: number;
};

// Directory the cache file lives in, or null when persistence is disabled
// (the default — keeps this module hermetic for unit tests that import it
// directly). The daemon sets it once via enableUsagePersistence().
let persistDir: string | null = null;
const cacheFile = (): string => join(persistDir as string, "usage-cache.json");

/**
 * Opt this process into disk-backed survival of the last good usage snapshot
 * across restarts. Call ONCE at daemon boot with the state dir. Immediately
 * hydrates the in-memory cache from any prior file so the first status push
 * after a restart already has figures to serve. No-op'd in unit tests (they
 * never call this), keeping the cache purely in-memory there.
 */
export const enableUsagePersistence = (dir: string): void => {
  persistDir = dir;
  hydrate();
};

// Load persisted good snapshots into the in-memory cache. Never clobbers a
// slug that already has live state. Best-effort: a missing/corrupt file just
// starts the cache cold.
const hydrate = (): void => {
  if (persistDir === null) return;
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), "utf-8")) as Record<
      string,
      TPersistedEntry
    >;
    for (const [slug, e] of Object.entries(parsed)) {
      if (cache.has(slug)) continue;
      if (e?.good?.snapshot === undefined) continue;
      cache.set(slug, {
        good: e.good,
        failure: null,
        lastAttemptAtMs:
          typeof e.lastAttemptAtMs === "number" ? e.lastAttemptAtMs : 0,
        inFlight: null,
      });
    }
  } catch {
    // no / unreadable cache file — start cold
  }
};

// Write the current good snapshots back to disk (failures + in-flight promises
// are runtime-only). Best-effort; a write failure just means the next restart
// starts cold for that provider.
const persist = (): void => {
  if (persistDir === null) return;
  const out: Record<string, TPersistedEntry> = {};
  for (const [slug, e] of cache.entries()) {
    if (e.good !== null) {
      out[slug] = { good: e.good, lastAttemptAtMs: e.lastAttemptAtMs };
    }
  }
  try {
    mkdirSync(persistDir, { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(out), { mode: 0o600 });
  } catch {
    // best-effort — losing the cache only costs a cold start next time
  }
};

// Stamp a snapshot served as a FALLBACK with its age so the UI can render a
// "cached · updated Xm ago" badge instead of presenting old figures as live.
// A fresh read (age < FRESH_TTL_MS) is returned untouched — it IS current.
const stampStale = (
  snapshot: TProviderUsageSnapshot,
  atMs: number,
  now: number,
): TProviderUsageSnapshot => {
  if (snapshot.kind !== "quota" || now - atMs < FRESH_TTL_MS) return snapshot;
  return { ...snapshot, as_of_ms: atMs, stale: true };
};

// What to serve right now without calling the vendor: the last good figures if
// still within STALE_TTL_MS (stamped stale once past the freshness window),
// otherwise the last failure (or a loading placeholder before the first
// attempt completes).
const servable = (entry: TUsageEntry, now: number): TProviderUsageSnapshot => {
  if (entry.good !== null && now - entry.good.atMs < STALE_TTL_MS) {
    return stampStale(entry.good.snapshot, entry.good.atMs, now);
  }
  return entry.failure ?? { kind: "unavailable", reason: "loading" };
};

/**
 * Return this provider's usage snapshot, calling `fetcher` at most once per
 * {@link FRESH_TTL_MS} whether the previous call succeeded or failed. A failed
 * read falls back to the last good snapshot (within {@link STALE_TTL_MS});
 * never throws.
 */
export const cachedUsage = async (
  slug: string,
  fetcher: () => Promise<TProviderUsageSnapshot>,
): Promise<TProviderUsageSnapshot> => {
  const now = Date.now();
  const entry = cache.get(slug);
  if (entry !== undefined) {
    // Fresh, usable snapshot — serve it with no upstream call.
    if (
      entry.good !== null &&
      now - entry.good.atMs < FRESH_TTL_MS &&
      isUsable(entry.good.snapshot)
    ) {
      return entry.good.snapshot;
    }
    // A refresh is already running — share it (refresh-token rotation and rate
    // limits make parallel fetches actively harmful).
    if (entry.inFlight !== null) return entry.inFlight;
    // We hit the vendor recently (success or fail). Back off rather than
    // hammer — the usage endpoint rate-limits independently of inference, and
    // re-trying every push is exactly what triggers the 429 in the first
    // place. Serve the best we have meanwhile.
    if (now - entry.lastAttemptAtMs < FRESH_TTL_MS) {
      return servable(entry, now);
    }
  }

  const run = (async (): Promise<TProviderUsageSnapshot> => {
    let next: TProviderUsageSnapshot;
    try {
      next = await fetcher();
    } catch (err) {
      next = {
        kind: "unavailable",
        reason: err instanceof Error ? err.message : "usage fetch failed",
      };
    }
    const at = Date.now();
    const prev = cache.get(slug);
    const updated: TUsageEntry = {
      good: isUsable(next)
        ? { snapshot: next, atMs: at }
        : (prev?.good ?? null),
      failure: isUsable(next) ? null : next,
      lastAttemptAtMs: at,
      inFlight: null,
    };
    cache.set(slug, updated);
    // Persist the good snapshot (+ attempt time) so a daemon restart can serve
    // it instead of going dark when the post-restart read is rate-limited.
    persist();
    return servable(updated, at);
  })();

  // Publish the in-flight promise so a concurrent caller shares this fetch,
  // preserving the prior good/failure/attempt state for the fallback path.
  cache.set(slug, {
    good: entry?.good ?? null,
    failure: entry?.failure ?? null,
    lastAttemptAtMs: entry?.lastAttemptAtMs ?? 0,
    inFlight: run,
  });
  return run;
};

/**
 * Drop the cached snapshot so the next {@link cachedUsage} call re-hits the
 * vendor LIVE — the deliberate override behind a manual refresh. With no
 * `slug`, clears every provider (the dashboard's whole-daemon refresh).
 *
 * Safe mid-refresh: an in-flight fetch repopulates the entry when it settles,
 * so a concurrent caller still gets a result; this only guarantees the NEXT
 * read bypasses the back-off / freshness window.
 */
export const invalidateUsage = (slug?: string): void => {
  if (slug === undefined) cache.clear();
  else cache.delete(slug);
};
