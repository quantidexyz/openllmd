/**
 * Daemon writer for the cloud's per-user model cache
 * (live-provider-model-catalog proposal §4).
 *
 * Demand-driven: live vendor `listModels()` runs only on
 * `auth.login.succeeded` (scoped to that provider) or a `refresh_models`
 * command. Idle bootstrap ticks must not acquire catalogs or refresh
 * tokens. Previously reported daemon rows stay until a later successful
 * report replaces them — skipping an idle pass never POSTs an empty list
 * and never wipes the cache.
 *
 * Per-provider throttle: one delegate's failure (returns null) doesn't
 * block another's cadence. A vendor CLI version change bypasses the TTL
 * because some providers gate model visibility by client version (Codex
 * does this today). Unscoped refresh joins the bounded snapshot producer
 * (`computeStatus`) — never a raw background `delegate.status()`. A
 * scoped login report uses the login-succeeded barrier and last-known
 * CLI version; it must not join an in-flight unknown/pending status
 * probe that would skip the list.
 */
import type {
  TAuthEvent,
  TDaemonModelReportEntry,
  TDaemonProviderConnection,
} from "@openllmsh/protocol";
import { normalizeProviderConnection } from "@openllmsh/protocol";
import { addAuthObserver } from "./auth-events";
import { reportModels } from "./cloud-client";
import type { TProviderDelegate } from "./delegation";
import { DELEGATES, getDelegate } from "./delegation";
import { computeStatus, peekLastKnownConnection } from "./status";

/** Local demand throttle — cloud read TTL is independent (stale-while-revalidate). */
const REPORT_TTL_MS = 30 * 60 * 1000;
/**
 * A null/empty fetch (signed out, vendor error) retries on THIS slower
 * cadence. Reset per slug on a successful login so a fresh credential
 * reports immediately.
 */
const FAILURE_RETRY_MS = 15 * 60 * 1000;

type TAttempt = {
  readonly at: number;
  readonly ok: boolean;
  readonly cliVersion?: string;
};

type TDueModelReport = {
  readonly slug: string;
  readonly delegate: TProviderDelegate;
  readonly cliVersion: string | undefined;
};

/** The result of collecting and attempting one due model-list report. */
export type TMaybeModelReportResult = {
  /** Whether at least one live provider listing was POSTed to the cloud. */
  readonly attempted: boolean;
  /** Number of successful provider model listings included in the report. */
  readonly reported: number;
  /** Whether a provider listing or the cloud POST failed. */
  readonly failed: boolean;
  /** Safe diagnostic for failed provider listings or a cloud POST failure. */
  readonly error?: string;
};

const lastAttempt = new Map<string, TAttempt>();

/** Reset the throttle — all slugs, or one (post-connect / tests). */
export const resetModelReportThrottle = (slug?: string): void => {
  if (slug === undefined) lastAttempt.clear();
  else lastAttempt.delete(slug);
};

const isDue = (
  slug: string,
  now: number,
  cliVersion: string | undefined,
): boolean => {
  const prev = lastAttempt.get(slug);
  if (prev === undefined) return true;
  if (cliVersion !== undefined && cliVersion !== prev.cliVersion) return true;
  return now - prev.at >= (prev.ok ? REPORT_TTL_MS : FAILURE_RETRY_MS);
};

const dueFromConnections = (
  now: number,
  connections: ReadonlyArray<TDaemonProviderConnection>,
  slugFilter: string | undefined,
): ReadonlyArray<TDueModelReport> => {
  const byProvider = new Map(
    connections.map((conn) => [conn.provider, conn] as const),
  );
  const due: TDueModelReport[] = [];
  for (const [slug, delegate] of Object.entries(DELEGATES)) {
    if (delegate.listModels === undefined) continue;
    if (slugFilter !== undefined && slug !== slugFilter) continue;
    const conn = byProvider.get(slug);
    if (conn === undefined || !normalizeProviderConnection(conn).serviceable) {
      continue;
    }
    const cliVersion = conn.cli_version;
    if (!isDue(slug, now, cliVersion)) continue;
    due.push({ slug, delegate, cliVersion });
  }
  return due;
};

const dueForSucceededLogin = (
  now: number,
  slug: string,
): ReadonlyArray<TDueModelReport> => {
  const delegate = getDelegate(slug);
  if (delegate === null || delegate.listModels === undefined) return [];
  const cliVersion = peekLastKnownConnection(slug)?.cli_version;
  if (!isDue(slug, now, cliVersion)) return [];
  return [{ slug, delegate, cliVersion }];
};

/**
 * Collect + report due model lists without throwing. The returned outcome lets
 * explicit callers surface a cloud-report failure. Idle / skipped reports are
 * `attempted: false` without `failed` — they must not look like a failed
 * request. Pass `slug` after `auth.login.succeeded` so the other four
 * delegates are not probed or listed.
 */
export const maybeReportModels = async (
  now: number = Date.now(),
  slug?: string,
): Promise<TMaybeModelReportResult> => {
  const due =
    slug === undefined
      ? dueFromConnections(now, (await computeStatus()).connections, undefined)
      : dueForSucceededLogin(now, slug);

  const results = await Promise.all(
    due.map(async ({ slug: dueSlug, delegate, cliVersion }) => ({
      slug: dueSlug,
      cliVersion,
      models: await (delegate.listModels?.().catch(() => null) ??
        Promise.resolve(null)),
    })),
  );
  const entries: TDaemonModelReportEntry[] = [];
  const failedProviders: string[] = [];
  for (const { slug: dueSlug, cliVersion, models } of results) {
    const ok = models !== null && models.length > 0;
    lastAttempt.set(dueSlug, {
      at: now,
      ok,
      ...(cliVersion ? { cliVersion } : {}),
    });
    if (models === null) {
      failedProviders.push(dueSlug);
      continue;
    }
    if (models.length > 0) {
      entries.push({
        provider: dueSlug,
        models,
        ...(cliVersion ? { cli_version: cliVersion } : {}),
      });
    }
  }
  const listingError =
    failedProviders.length > 0
      ? `model listing failed for ${failedProviders.join(", ")}`
      : undefined;
  if (entries.length === 0) {
    return {
      attempted: false,
      reported: 0,
      failed: failedProviders.length > 0,
      ...(listingError === undefined ? {} : { error: listingError }),
    };
  }

  const result = await reportModels({ entries });
  if (result.ok) {
    return {
      attempted: true,
      reported: entries.length,
      failed: failedProviders.length > 0,
      ...(listingError === undefined ? {} : { error: listingError }),
    };
  }

  return {
    attempted: true,
    reported: 0,
    failed: true,
    error:
      listingError === undefined
        ? result.error
        : `${listingError}; ${result.error}`,
  };
};

let loginObserverInstalled = false;

const onAuthEvent = (event: TAuthEvent): void => {
  if (event.event !== "auth.login.succeeded") return;
  resetModelReportThrottle(event.slug);
  void maybeReportModels(Date.now(), event.slug).catch(() => {});
};

/**
 * Subscribe once to `auth.login.succeeded` so pending device-code / paste-back
 * logins report models when the credential actually lands — not when the
 * connect command acked `pending`, and not on failed/cancelled terminals.
 * Idempotent. Tests that must not fan out to real vendors should not call this.
 */
export const observeLoginModelReports = (): void => {
  if (loginObserverInstalled) return;
  loginObserverInstalled = true;
  addAuthObserver(onAuthEvent);
};
