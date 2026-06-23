/**
 * Manifest-driven device-state — which skills/plugins/setups are installed on
 * THIS box, computed by running each registry item's own `install.sh -s` (the
 * unified state probe) and parsing its one-line JSON. Replaces the hardcoded
 * `integrations-detect.ts` filesystem scan: detection now lives in the BUNDLE
 * beside the install logic, so adding/removing a registry item is reflected
 * with NO daemon release. See
 * `docs/proposals/daemon-owned-state-stateless-relay.md` §4.2/§5.
 *
 * Cost-aware: the `-s` walk fetches + runs a script per item, so it is NOT run
 * on every status push (unlike the old cheap fs scan). Instead the result is
 * CACHED and refreshed on the agreed cadence — eager on boot, then on demand
 * (after an install/uninstall, or a manual refresh). `getInstalledIntegrations`
 * serves the cache to `computeStatus`; the walk updates it out of band.
 */
import type {
  TDaemonInstalledIntegration,
  TDaemonIntegrationKind,
} from "@quantidexyz/openllmp";
import { daemonEnv } from "./env";
import { runIntegration } from "./integrations";
import { logDebug, logWarn } from "./logger";

/** The cloud catalog endpoint per area — the registry manifest, served live, so
 *  the walk discovers exactly the items the gateway publishes. */
const CATALOG_PATH: Record<TDaemonIntegrationKind, string> = {
  skill: "/api/skills",
  plugin: "/api/plugins",
  setup: "/api/setup/options",
};

const FETCH_TIMEOUT_MS = 15_000;

/** Latest device-state snapshot. Served to `computeStatus`; replaced wholesale
 *  by `refreshDeviceState`, patched per-item by `probeIntegration`. */
let cache: TDaemonInstalledIntegration[] = [];

/** The cached install-state list (cheap; what `computeStatus` embeds). */
export const getInstalledIntegrations = (): TDaemonInstalledIntegration[] =>
  cache;

/** Parse the `installed` flag out of an `install.sh -s` run's output. The probe
 *  prints one JSON line (`{"installed":bool,…}`) on stdout; the wrapper's own
 *  diagnostics go to stderr, but `runIntegration` returns them concatenated, so
 *  scan for the JSON line. Null when no parseable verdict is present. */
export const parseInstalled = (output: string): boolean | null => {
  for (const line of output.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.includes('"installed"')) continue;
    try {
      const j = JSON.parse(t) as { installed?: unknown };
      if (typeof j.installed === "boolean") return j.installed;
    } catch {
      // not the JSON line — keep scanning
    }
  }
  return null;
};

/** Fetch the slugs/ids the gateway catalogs for one area. */
const fetchCatalogSlugs = async (
  kind: TDaemonIntegrationKind,
): Promise<string[]> => {
  const { cloudOrigin } = daemonEnv();
  const url = `${cloudOrigin}${CATALOG_PATH[kind]}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      data?: ReadonlyArray<{ slug?: unknown; id?: unknown }>;
    };
    return (body.data ?? [])
      .map((i) => (typeof i.slug === "string" ? i.slug : i.id))
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
};

/** Probe ONE item's state (`install.sh -s`) and patch its cache entry. Used
 *  after an install/uninstall so the next status push reflects the change
 *  without a full walk. A null verdict (probe failed) leaves the cache as-is. */
export const probeIntegration = async (
  kind: TDaemonIntegrationKind,
  slug: string,
): Promise<void> => {
  const r = await runIntegration(kind, "state", slug);
  const installed = parseInstalled(r.output);
  if (installed === null) {
    logWarn(
      "device-state",
      `state probe for ${kind}/${slug} returned no verdict`,
    );
    return;
  }
  const next = cache.filter((i) => !(i.kind === kind && i.slug === slug));
  next.push({ kind, slug, installed });
  cache = next;
};

/** Walk EVERY catalogued item, probe each `-s`, and replace the cache. Eager on
 *  boot + on a manual refresh. Items whose probe yields no verdict are dropped
 *  (the dashboard then offers both Install + Uninstall, which is safe — the
 *  scripts are idempotent). */
export const refreshDeviceState = async (): Promise<
  TDaemonInstalledIntegration[]
> => {
  const kinds: TDaemonIntegrationKind[] = ["skill", "plugin", "setup"];
  const perArea = await Promise.all(
    kinds.map(async (kind) => {
      const slugs = await fetchCatalogSlugs(kind);
      return Promise.all(
        slugs.map(async (slug) => {
          const r = await runIntegration(kind, "state", slug);
          const installed = parseInstalled(r.output);
          return installed === null
            ? null
            : ({ kind, slug, installed } satisfies TDaemonInstalledIntegration);
        }),
      );
    }),
  );
  cache = perArea
    .flat()
    .filter((i): i is TDaemonInstalledIntegration => i !== null);
  logDebug("device-state", `walk complete — ${cache.length} items probed`);
  return cache;
};
