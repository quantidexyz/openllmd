/**
 * Per-provider usage-snapshot cache.
 *
 * Usage reads never run on the status-push cadence or request path. The vendor
 * usage endpoint (e.g. Claude's `api/oauth/usage`) has its OWN low rate limit,
 * separate from inference — reading it on the status-push cadence 429'd it
 * after ~5 min ("Claude usage is rate-limited right now") on a daemon nobody
 * was even looking at. `cachedUsage` is reached only by a manual `refresh`
 * command or by {@link sampleUsageAfterRequest}, which coalesces successful
 * real user request bursts and runs detached. The background status push reads
 * the cache PASSIVELY via {@link peekUsage}, which NEVER calls the vendor — it
 * just attaches whatever was last fetched. See `status.ts` / `control-relay.ts`.
 *
 * The TTL + back-off below is a second layer of protection on that on-demand
 * path: rapid refresh clicks (or several dashboards refreshing at once) still
 * hit the vendor at most once per {@link FRESH_TTL_MS}, and a failed read backs
 * off the same way instead of hammering a rate-limited endpoint.
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
 *     (`<stateDir>/usage-cache.json`, or `usage-cache.dev.json` in dev mode so
 *     a source-run dev daemon never shares a cache with the installed prod one)
 *     once the daemon opts in via
 *     {@link enableUsagePersistence}, so a daemon RESTART doesn't lose it —
 *     before this, a restart wiped the in-memory good snapshot and, if the
 *     first post-restart read 429'd, the card showed a rate-limit error with
 *     NOTHING to fall back to (the bug behind "it says it shows previous
 *     results but it doesn't"). The persisted `lastAttemptAtMs` also makes a
 *     quick restart respect the back-off instead of re-hitting the vendor
 *     immediately;
 *   - concurrent callers during a refresh share ONE in-flight fetch
 *     (single-flight per provider).
 *
 * The dashboard's display TTL is deliberately NOT the routing TTL. The walker
 * uses {@link peekUsageForQuotaGate}: after the UI has stopped showing an old
 * card, it may retain only an exhausted quota pool with a known future reset.
 * That pool is self-validating — it cannot refill before its own reset — and is
 * therefore safe evidence to skip a dead hop. When a cached reset has passed,
 * the routing reader asks only that provider/account to revalidate through this
 * cache's existing single-flight and back-off machinery; it never creates a
 * polling sweep or blocks an inference request on the vendor.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TProviderUsageSnapshot } from "@openllmsh/protocol";
import { isDevMode } from "./env";

// Hit the vendor at most once per this window — applies to BOTH a successful
// read (the figures are reused) and a failed one (we back off instead of
// hammering a rate-limited endpoint).
const FRESH_TTL_MS = 5 * 60_000;
// After a failed refresh, keep serving the last good snapshot for up to this
// long rather than showing an error — but don't show stale quota forever.
const STALE_TTL_MS = 30 * 60_000;
// When there's NO good snapshot to serve (only a failure, or nothing yet), an
// on-demand read retries after just this — much shorter than FRESH_TTL_MS — so
// the UI recovers quickly once a transient failure clears (e.g. a token that was
// briefly expired and has since refreshed). Manual refreshes may retry quickly;
// request-driven samples are separately coalesced and capped below, and status
// pushes only read the cache passively via `peekUsage`.
const FAILURE_RETRY_MS = 20_000;
// Real gateway requests are naturally bursty. Wait for a burst to settle, then
// capture one fresh meter boundary without placing a vendor usage read on the
// request/streaming path.
const REQUEST_SAMPLE_DEBOUNCE_MS = 60_000;
// The vendor usage endpoint has a separate, tight rate limit. Request-driven
// samples therefore remain capped even during a long coding session.
const REQUEST_SAMPLE_MIN_INTERVAL_MS = 2 * 60_000;

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
const generations = new Map<string, number>();

/** Stable cache partition for a provider identity, preserving legacy slug keys. */
export const usageCacheKey = (slug: string, accountHash?: string): string =>
  accountHash === undefined ? slug : `${slug}#${accountHash}`;

const generationFor = (key: string): number => generations.get(key) ?? 0;

const bumpGeneration = (key: string): void => {
  generations.set(key, generationFor(key) + 1);
};

const matchesSlug = (key: string, slug: string): boolean =>
  key === slug || key.startsWith(`${slug}#`);

const clearRequestSamples = (matches: (key: string) => boolean): void => {
  for (const [key, sample] of requestSamples.entries()) {
    if (!matches(key)) continue;
    if (sample.timer !== null) clearTimeout(sample.timer);
    requestSamples.delete(key);
  }
};

type TRequestSample = {
  fetcher: () => Promise<TProviderUsageSnapshot>;
  timer: ReturnType<typeof setTimeout> | null;
  lastSampleAtMs: number;
  generation: number;
};

const requestSamples = new Map<string, TRequestSample>();

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
// The cache FILE is dev-namespaced, exactly like `openllmd.dev.log` — a
// source-run dev daemon shares the state dir (`~/.openllm`) with the installed
// prod daemon most developers also run, and an undifferentiated
// `usage-cache.json` would let the two fight over one file: prod (an older
// binary that never read the subscription tier) writes a tier-less snapshot,
// dev hydrates it and serves it back for the freshness window, so a tier the
// dev build DOES compute never appears. Separate files keep dev and prod
// caches fully independent.
const cacheFile = (): string =>
  join(
    persistDir as string,
    isDevMode() ? "usage-cache.dev.json" : "usage-cache.json",
  );

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

/**
 * Test-only: opt this process back OUT of disk persistence so a case that
 * enabled it (via a temp dir) can't leak a `persistDir` into later in-memory
 * cases. Never called by the daemon itself.
 */
export const disableUsagePersistenceForTest = (): void => {
  persistDir = null;
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
  options: { readonly force?: boolean; readonly accountHash?: string } = {},
): Promise<TProviderUsageSnapshot> => {
  const key = usageCacheKey(slug, options.accountHash);
  const generation = generationFor(key);
  const now = Date.now();
  const entry = cache.get(key);
  if (entry !== undefined) {
    // Fresh, usable snapshot — serve it with no upstream call.
    if (
      !options.force &&
      entry.good !== null &&
      now - entry.good.atMs < FRESH_TTL_MS &&
      isUsable(entry.good.snapshot)
    ) {
      return entry.good.snapshot;
    }
    // A refresh is already running — share it (refresh-token rotation and rate
    // limits make parallel fetches actively harmful).
    if (entry.inFlight !== null) return entry.inFlight;
    // We hit the vendor recently (success or fail). Back off rather than hammer.
    // The window depends on what we can serve: with a usable GOOD snapshot, hold
    // it for the full FRESH_TTL (the figures are fine for minutes). With ONLY a
    // failure (or nothing fetched yet), back off for just FAILURE_RETRY_MS so an
    // on-demand refresh recovers fast once a transient failure clears — without
    // this, a single failed read (e.g. a momentarily-expired token) stuck the UI
    // on the error for 5 min even after the token refreshed.
    // The long back-off applies only while there's a SERVABLE good snapshot to
    // show meanwhile (within STALE_TTL_MS — what `servable()` actually returns);
    // once the good has aged out, fall back to the short retry so a failed
    // refresh recovers sooner instead of sitting on FRESH_TTL.
    const goodServable =
      entry.good !== null && now - entry.good.atMs < STALE_TTL_MS;
    const backoff = goodServable ? FRESH_TTL_MS : FAILURE_RETRY_MS;
    if (!options.force && now - entry.lastAttemptAtMs < backoff) {
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
    if (generationFor(key) !== generation) {
      return { kind: "unavailable", reason: "usage cache invalidated" };
    }
    const prev = cache.get(key);
    const updated: TUsageEntry = {
      good: isUsable(next)
        ? { snapshot: next, atMs: at }
        : (prev?.good ?? null),
      failure: isUsable(next) ? null : next,
      lastAttemptAtMs: at,
      inFlight: null,
    };
    cache.set(key, updated);
    // Persist the good snapshot (+ attempt time) so a daemon restart can serve
    // it instead of going dark when the post-restart read is rate-limited.
    persist();
    return servable(updated, at);
  })();

  // Publish the in-flight promise so a concurrent caller shares this fetch,
  // preserving the prior good/failure/attempt state for the fallback path.
  cache.set(key, {
    good: entry?.good ?? null,
    failure: entry?.failure ?? null,
    lastAttemptAtMs: entry?.lastAttemptAtMs ?? 0,
    inFlight: run,
  });
  return run;
};

/**
 * PASSIVE read — return this provider's cached usage snapshot WITHOUT ever
 * calling the vendor. `computeStatus()` uses this on every background status
 * push so a push never triggers a usage read (usage is on-demand only — see the
 * module header). Returns the last good figures stamped `stale` once past the
 * freshness window, including past {@link STALE_TTL_MS} (the card stays filled
 * and honestly aged). With no good snapshot, returns the last failure, else
 * `null` when nothing has ever been fetched for this provider (the daemon
 * booted but no one has demanded usage yet) — the card then simply shows no
 * quota until a `refresh` populates it.
 */
export const peekUsage = (
  slug: string,
  accountHash?: string,
): TProviderUsageSnapshot | null => {
  const entry = cache.get(usageCacheKey(slug, accountHash));
  if (entry === undefined) return null;
  const now = Date.now();
  if (entry.good !== null) {
    return stampStale(entry.good.snapshot, entry.good.atMs, now);
  }
  return entry.failure;
};

/**
 * PASSIVE routing read — retains a long-aged quota snapshot only when an
 * exhausted window or extra pool has a known reset still ahead. Unlike the UI
 * display reader, that fact remains valid regardless of snapshot age: the
 * exhausted pool cannot refill until its own reset instant. All other cases
 * preserve {@link peekUsage}'s exact display-TTL behavior.
 *
 * A passed reset proves the cached quota is expired. When a fetcher is supplied,
 * schedule one detached, provider/account-scoped cache read without `force`;
 * `cachedUsage` supplies the existing freshness, back-off, and single-flight
 * limits. The reader returns immediately and never lets a vendor failure throw.
 */
export const peekUsageForQuotaGate = (
  slug: string,
  accountHash?: string,
  revalidate?: () => Promise<TProviderUsageSnapshot>,
): TProviderUsageSnapshot | null => {
  const entry = cache.get(usageCacheKey(slug, accountHash));
  if (entry === undefined) return null;
  const now = Date.now();
  if (entry.good === null) return entry.failure;

  const snapshot = entry.good.snapshot;
  if (snapshot.kind !== "quota") return peekUsage(slug, accountHash);
  const pools = [...snapshot.windows, ...(snapshot.extra_pools ?? [])];
  if (
    revalidate !== undefined &&
    pools.some((pool) => pool.reset_at_ms !== null && now >= pool.reset_at_ms)
  ) {
    void cachedUsage(slug, revalidate, { accountHash });
  }
  if (now - entry.good.atMs < STALE_TTL_MS) {
    return stampStale(snapshot, entry.good.atMs, now);
  }
  if (
    pools.some(
      (pool) =>
        pool.percent_used >= 100 &&
        pool.reset_at_ms !== null &&
        now < pool.reset_at_ms,
    )
  ) {
    return stampStale(snapshot, entry.good.atMs, now);
  }
  return entry.failure;
};

/**
 * Schedule one detached usage refresh after a burst of successful real user
 * requests. This never awaits, retries, or changes the request itself; it only
 * improves the next passive calibration boundary when the vendor allows it.
 */
export const sampleUsageAfterRequest = (
  slug: string,
  fetcher: () => Promise<TProviderUsageSnapshot>,
  accountHash?: string,
): void => {
  const key = usageCacheKey(slug, accountHash);
  const current = requestSamples.get(key);
  const sample: TRequestSample = current ?? {
    fetcher,
    timer: null,
    lastSampleAtMs: 0,
    generation: generationFor(key),
  };
  sample.fetcher = fetcher;
  if (sample.timer !== null) clearTimeout(sample.timer);
  sample.timer = setTimeout(() => {
    sample.timer = null;
    if (generationFor(key) !== sample.generation) return;
    const now = Date.now();
    if (now - sample.lastSampleAtMs < REQUEST_SAMPLE_MIN_INTERVAL_MS) return;
    sample.lastSampleAtMs = now;
    // Request-driven sampling intentionally asks for a fresh boundary while
    // preserving the prior good snapshot as a fallback if the read is limited.
    void cachedUsage(slug, sample.fetcher, { force: true, accountHash });
  }, REQUEST_SAMPLE_DEBOUNCE_MS);
  requestSamples.set(key, sample);
};

/**
 * Sample usage IMMEDIATELY on a quota exhaustion signal — no debounce, no
 * per-request min-interval floor. Unlike {@link sampleUsageAfterRequest} (the
 * success path, which coalesces a burst and waits), an exhausted account emits
 * no successful request, so nothing else would ever re-sample it; we want the
 * rejected snapshot in the cache NOW so the quota gate can route on it for the
 * rest of the window. Still safe: `cachedUsage`'s in-flight single-flight check
 * precedes its force/freshness logic, so a concurrent herd of exhaustion signals
 * collapses to ONE vendor read. Fire-and-forget; never throws.
 */
export const sampleUsageOnExhaustion = (
  slug: string,
  fetcher: () => Promise<TProviderUsageSnapshot>,
  accountHash?: string,
): void => {
  // Fire-and-forget: attach a rejection handler so a `persist()` failure that
  // escapes `cachedUsage`'s internal catch can never surface as an unhandled
  // rejection — the documented "never throws" contract holds.
  void cachedUsage(slug, fetcher, { force: true, accountHash }).catch(() => {});
};

/** Test-only cleanup for the module-global request sampler. */
export const clearRequestUsageSamples = (): void => {
  for (const sample of requestSamples.values()) {
    if (sample.timer !== null) clearTimeout(sample.timer);
  }
  requestSamples.clear();
};

/** Test-only volatile cache reset; intentionally preserves persisted snapshots. */
export const resetUsageCacheForTest = (): void => {
  cache.clear();
  generations.clear();
  clearRequestUsageSamples();
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
export const invalidateUsage = (slug?: string, accountHash?: string): void => {
  const matches =
    slug === undefined
      ? (): boolean => true
      : accountHash === undefined
        ? (key: string): boolean => matchesSlug(key, slug)
        : (key: string): boolean => key === usageCacheKey(slug, accountHash);
  const keys = new Set([
    ...cache.keys(),
    ...generations.keys(),
    ...requestSamples.keys(),
  ]);
  for (const key of keys) {
    if (!matches(key)) continue;
    bumpGeneration(key);
    cache.delete(key);
  }
  clearRequestSamples(matches);
  persist();
};
