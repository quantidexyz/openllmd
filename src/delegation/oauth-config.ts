/**
 * Subscription-CLI OAuth config — extracted from the installed CLI, not
 * hardcoded. Shared by the Claude (`claude_code`) and Codex (`chatgpt`)
 * delegates; both self-refresh their access token and need two values the
 * daemon used to hardcode: the OAuth `client_id` and the token endpoint URL.
 *
 * Both are the VENDOR's, baked into the CLI binary, and they DRIFT — e.g. by
 * Claude CLI v2.1.159 the token URL had moved `console.anthropic.com` →
 * `platform.claude.com` while our literal still said the old host. Hardcoding
 * is the exact failure mode the exec-fixtures exist to avoid (T2: use the
 * CLI's real identity, don't hand-copy constants that go stale on an update).
 *
 * So we read them from the SAME source the CLI uses: its compiled artifact
 * embeds the OAuth config as string literals —
 *   - Claude (a JS bundle): a literal object
 *     `{ … TOKEN_URL:"https://…/v1/oauth/token", … CLIENT_ID:"<uuid>" … }`.
 *   - Codex (a Rust binary): the bare `const` literals
 *     `https://auth.openai.com/oauth/token` and `app_<base62>`.
 * — which `strings`-style scanning recovers without running anything. The
 * result is cached in a version-keyed sidecar next to the CLI root and falls
 * back to built-in defaults when extraction fails (CLI absent, format
 * changed), so token refresh never hard-breaks.
 *
 * Nothing here is secret or user-specific: `client_id` is a public OAuth app
 * id and the URL is a published endpoint. Reading the binary stays on-box.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { cliBin, cliRoot } from "../cli-paths";
import { logDebug, logInfo } from "../logger";
import { cliVersion, readJsonFile } from "./util";

/** The two providers whose CLI self-refreshes an OAuth access token. */
export type TOAuthProvider = "claude_code" | "chatgpt";

export type TOAuthConfig = {
  /** OAuth app client id (public). */
  readonly client_id: string;
  /** Token endpoint (`grant_type=refresh_token`). */
  readonly token_url: string;
};

type TCachedOAuthConfig = TOAuthConfig & {
  /** The isolated binary's `--version` at extraction time; a mismatch re-extracts. */
  readonly cli_version: string;
  /** Epoch ms of extraction; older than the TTL re-extracts. */
  readonly extracted_at_ms: number;
};

/**
 * Pull the Claude prod OAuth config out of the CLI JS bundle. The bundle holds
 * several env blocks (local/staging/prod); we anchor on the PROD token URL host
 * (`platform.claude.com` / legacy `console.anthropic.com`) and take the
 * CLIENT_ID that appears with it (the `[^}]*?` can't cross the object's closing
 * `}`), so a local-dev block (localhost URLs, a different client id) can't be
 * picked up. Returns null if the shape changed.
 */
export const extractClaude = (text: string): TOAuthConfig | null => {
  const m = text.match(
    /TOKEN_URL:"(https:\/\/(?:platform\.claude\.com|console\.anthropic\.com)\/v1\/oauth\/token)"[^}]*?CLIENT_ID:"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/,
  );
  if (m === null) return null;
  return { token_url: m[1], client_id: m[2] };
};

/** The single most frequent element of a non-empty list (ties → first seen). */
const mostFrequent = (xs: ReadonlyArray<string>): string | undefined => {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1;
    counts.set(x, n);
    if (n > bestN) {
      bestN = n;
      best = x;
    }
  }
  return best;
};

/** Codex's OAuth app id: `app_` + exactly 24 base62 chars. */
const CODEX_CLIENT_ID_RE = /app_[A-Za-z0-9]{24}/g;

/**
 * Pull the Codex OAuth config out of the `codex_cli_rs` Rust binary. Unlike the
 * Claude bundle (one quoted object literal), codex's `REFRESH_TOKEN_URL` and
 * `CLIENT_ID` are independent `const` string literals (see ref/codex
 * `login/src/auth/manager.rs`) that Rust packs into rodata WITH NO SEPARATOR —
 * the id abuts its neighbour (`…hrannContent-Type`, `…hranntokentoken_type_hint`),
 * so there's no right-edge delimiter to anchor on. We therefore match the id at
 * its EXACT known length (`app_` + 24), and since it recurs many times in the
 * binary we take the MOST FREQUENT match so a stray coincidental `app_…{24}`
 * literal can't win. Returns null unless BOTH values are found; the caller
 * additionally format-validates before trusting the result.
 *
 * ⚠️ RESEARCH: the exact-length match assumes OpenAI's `app_` ids stay 24 chars;
 * a length change would mis-extract → the format guard rejects it → fallback.
 */
export const extractCodex = (text: string): TOAuthConfig | null => {
  const token_url = text.match(
    /https:\/\/auth\.openai\.com\/oauth\/token/,
  )?.[0];
  const ids = text.match(CODEX_CLIENT_ID_RE);
  const client_id = ids !== null ? mostFrequent(ids) : undefined;
  if (token_url === undefined || client_id === undefined) return null;
  return { token_url, client_id };
};

type TProviderSpec = {
  /**
   * Built-in fallback, used verbatim when extraction fails. Kept CURRENT so
   * even the no-extract path is right today — a known-good fallback beats a
   * known-stale one.
   */
  readonly fallback: TOAuthConfig;
  readonly extract: (binaryText: string) => TOAuthConfig | null;
  /**
   * Shape guard for an extracted/cached config. A mis-extraction (binary format
   * drift, the rodata-bleed that produced `app_…tokentoken`) is REJECTED here
   * so it's never trusted and a previously-cached bad value self-heals on the
   * next run (re-extract → fallback) instead of breaking refresh.
   */
  readonly valid: (c: TOAuthConfig) => boolean;
};

const SPECS: Readonly<Record<TOAuthProvider, TProviderSpec>> = {
  // Claude prod values as of CLI 2.1.159 (the `platform.claude.com` token host).
  claude_code: {
    fallback: {
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      token_url: "https://platform.claude.com/v1/oauth/token",
    },
    extract: extractClaude,
    valid: (c) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        c.client_id,
      ) &&
      /^https:\/\/(?:platform\.claude\.com|console\.anthropic\.com)\/v1\/oauth\/token$/.test(
        c.token_url,
      ),
  },
  // Codex values from ref/codex `login/src/auth/manager.rs` (CLIENT_ID +
  // REFRESH_TOKEN_URL).
  chatgpt: {
    fallback: {
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      token_url: "https://auth.openai.com/oauth/token",
    },
    extract: extractCodex,
    valid: (c) =>
      /^app_[A-Za-z0-9]{24}$/.test(c.client_id) &&
      /^https:\/\/auth\.openai\.com\/oauth\/token$/.test(c.token_url),
  },
};

/** The built-in fallback for a provider (used when binary extraction fails). */
export const fallbackOAuthConfig = (provider: TOAuthProvider): TOAuthConfig =>
  SPECS[provider].fallback;

/** Back-compat alias — Claude's built-in fallback. */
export const FALLBACK_OAUTH_CONFIG: TOAuthConfig = SPECS.claude_code.fallback;

const TTL_MS = 24 * 60 * 60 * 1000; // re-extract daily (catches rotations)

const configPath = (provider: TOAuthProvider): string =>
  join(cliRoot(provider), "oauth-config.json");

// Pull the OAuth config out of the provider's CLI binary via its extractor.
const extractFromBinary = async (
  provider: TOAuthProvider,
): Promise<TOAuthConfig | null> => {
  let bin = cliBin(provider);
  try {
    // The launcher may be a symlink to the real binary under versions/<ver>
    // (Claude); scan the resolved target. A plain binary (codex) resolves to
    // itself.
    bin = await realpath(bin).catch(() => bin);
    const file = Bun.file(bin);
    if (!(await file.exists())) return null;
    const text = await file.text(); // binary read as latin1-ish; ASCII literals survive
    return SPECS[provider].extract(text);
  } catch (err) {
    logDebug("oauth-config", "binary extraction failed", {
      provider,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};

const readCache = (
  provider: TOAuthProvider,
): Promise<TCachedOAuthConfig | null> =>
  readJsonFile<TCachedOAuthConfig>(configPath(provider));

const isFresh = (c: TCachedOAuthConfig, ver: string | null): boolean =>
  c.cli_version === (ver ?? "") && Date.now() - c.extracted_at_ms < TTL_MS;

// One extraction in flight PER PROVIDER — concurrent refreshers share it.
const inFlight = new Map<TOAuthProvider, Promise<TOAuthConfig>>();

/**
 * The OAuth config to use for a token refresh: the cached extraction if fresh
 * (version match AND within TTL), else a freshly extracted one, else the
 * built-in fallback. `force` bypasses the cache (used right after a re-login /
 * CLI update). Never throws.
 */
export const ensureOAuthConfig = async (
  provider: TOAuthProvider,
  opts?: { readonly force?: boolean },
): Promise<TOAuthConfig> => {
  const spec = SPECS[provider];
  const cached = await readCache(provider);
  // Only trust a cache that still PASSES the format guard — a value cached by an
  // older, buggier extractor (e.g. the `app_…tokentoken` rodata-bleed) fails
  // here and is re-extracted instead of served.
  const validCache = cached !== null && spec.valid(cached) ? cached : null;
  if (opts?.force !== true && validCache !== null) {
    const ver = await cliVersion(cliBin(provider), {});
    if (isFresh(validCache, ver)) return validCache;
  }
  const existing = inFlight.get(provider);
  if (existing !== undefined) return existing;
  const run = (async () => {
    const extracted = await extractFromBinary(provider);
    // Reject a null OR malformed extraction — never cache/serve a bad value.
    if (extracted === null || !spec.valid(extracted)) {
      // Serve the last VALID cache if we have one, else the built-in fallback.
      // Don't overwrite a good cache with nothing.
      return validCache ?? spec.fallback;
    }
    const ver = await cliVersion(cliBin(provider), {});
    const next: TCachedOAuthConfig = {
      ...extracted,
      cli_version: ver ?? "",
      extracted_at_ms: Date.now(),
    };
    await Bun.write(configPath(provider), JSON.stringify(next)).catch(() => {});
    logInfo("oauth-config", "extracted OAuth config from CLI", {
      provider,
      token_url: extracted.token_url,
      // client_id is a public app id, but log only a prefix to keep logs tidy.
      client_id_prefix: `${extracted.client_id.slice(0, 8)}…`,
    });
    return extracted;
  })().finally(() => {
    inFlight.delete(provider);
  });
  inFlight.set(provider, run);
  return run;
};
