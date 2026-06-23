/**
 * Per-provider AUTH CONFIG — one consolidated `config.json` sidecar next to the
 * isolated CLI (`<cliRoot>/config.json`), serving multiple purposes:
 *
 *   - `upstream_url` — the genuine inference endpoint the vendor CLI POSTs to,
 *     CAPTURED from a real headless `exec` request (it drifts on CLI updates —
 *     e.g. codex's `/backend-api/codex/responses` host moved — and can't be
 *     hardcoded). The capture KILLS the CLI before anything reaches the vendor
 *     (zero token cost, works offline).
 *   - `client_id` + `token_url` — the OAuth refresh identity (claude_code +
 *     chatgpt only), EXTRACTED from the CLI binary (also drifts; see below).
 *   - `cli_version` — CLI meta, used for the refresh User-Agent + as the
 *     freshness key.
 *
 * Bright line (terms-compliance): NOTHING here is replayed as inference
 * identity. The daemon serves each request with the ORIGINATOR's own headers
 * (`@quantidexyz/openllmw/lib/forwarded-headers`) + the injected bearer; this config
 * supplies only the request TARGET URL and the refresh-token identity. The
 * volatile/secret `authorization` header is never captured or stored.
 *
 * Plain JSON (read via `readJsonFile`, written via `Bun.write` + `JSON.stringify`)
 * — always fresh on re-read after a re-capture, no runtime transpiler, works
 * identically in the compiled `--bytecode` binary.
 *
 * Supersedes the former `exec-fixture.ts` (URL+identity capture) and
 * `oauth-config.ts` (binary extraction) — see
 * `docs/proposals/delegation-exec-fixtures.md` (amended) and
 * `docs/proposals/subscription-oauth-terms-compliance.md`.
 */
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TCliProvider } from "../cli-paths";
import { cliBin, cliEnv, cliRoot } from "../cli-paths";
import { logDebug, logInfo, logWarn } from "../logger";
import { cliVersion, ptyScriptArgv, readJsonFile } from "./util";

/** The persisted shape (all fields optional — the URL-capture and the OAuth
 *  extraction populate independently and merge into the one file). */
export type TAuthConfig = {
  /** ORIGIN + the captured request path (e.g. `https://api.anthropic.com/v1/messages`). */
  readonly upstream_url?: string;
  /** The isolated binary's `--version` at capture/extract time; a mismatch refreshes. */
  readonly cli_version?: string;
  /** Epoch ms of the last URL capture; older than the TTL re-captures. */
  readonly captured_at_ms?: number;
  /** OAuth app client id (public) — claude_code + chatgpt only. */
  readonly client_id?: string;
  /** OAuth token endpoint (`grant_type=refresh_token`) — claude_code + chatgpt only. */
  readonly token_url?: string;
  /** Epoch ms of the last OAuth extraction; older than the TTL re-extracts. */
  readonly extracted_at_ms?: number;
};

/** Re-capture / re-extract once older than this, even when neither the CLI
 *  version nor the login changed (catches server-side identity rotations). */
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Hard cap on a capture run — the CLI should emit its first request in <1s; a
 *  CLI that errors before sending just times out and the caller falls back. */
const CAPTURE_TIMEOUT_MS = 20_000;

// ─── Persisted config.json sidecar (read/write/patch) ────────────────────────

const configPath = (provider: TCliProvider): string =>
  join(cliRoot(provider), "config.json");

const readConfig = (provider: TCliProvider): Promise<TAuthConfig | null> =>
  readJsonFile<TAuthConfig>(configPath(provider));

const writeConfig = async (
  provider: TCliProvider,
  config: TAuthConfig,
): Promise<void> => {
  await Bun.write(configPath(provider), JSON.stringify(config));
};

// Serialize read-modify-write per provider — the URL capture and the OAuth
// extraction both patch the ONE file; a per-provider queue stops them clobbering
// each other's sub-part.
const writeLocks = new Map<TCliProvider, Promise<void>>();
const patchConfig = async (
  provider: TCliProvider,
  patch: TAuthConfig,
): Promise<void> => {
  const prev = writeLocks.get(provider) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const cur = (await readConfig(provider)) ?? {};
      await writeConfig(provider, { ...cur, ...patch });
    });
  writeLocks.set(provider, next);
  await next;
};

// ─── URL capture (the genuine inference endpoint) ────────────────────────────

/**
 * Per-provider capture recipe. `origin` is the retained constant (the redirect
 * replaces it, so it can't be captured); `path` is only the PRE-capture fallback
 * (the live capture overrides it with the real path). `match` picks the
 * INFERENCE request out of the CLI's request stream — CLIs emit preamble calls
 * first, which the recorder forwards to the vendor so the CLI proceeds; only the
 * matching inference request is captured. `argv` + `env` point the headless CLI
 * at the loopback recorder — see `docs/proposals/delegation-exec-fixtures.md` §2.
 */
type TCaptureSpec = {
  readonly origin: string;
  readonly path: string;
  readonly match: (path: string) => boolean;
  readonly argv: (bin: string, base: string) => ReadonlyArray<string>;
  readonly env: (base: string) => Record<string, string>;
  /** Run the headless CLI under a pseudo-terminal (`script(1)`) — set for a CLI
   *  whose print/exec mode is gated on a real TTY (kimi's `-p`). */
  readonly usePty?: boolean;
};

const CAPTURE: Readonly<Record<TCliProvider, TCaptureSpec>> = {
  claude_code: {
    origin: "https://api.anthropic.com",
    path: "/v1/messages",
    match: (p) => p.endsWith("/v1/messages"),
    // `-p/--print` = headless single-shot; ANTHROPIC_BASE_URL redirects it.
    argv: (bin) => [bin, "-p", "ping"],
    env: (base) => ({ ANTHROPIC_BASE_URL: base }),
  },
  chatgpt: {
    origin: "https://chatgpt.com",
    path: "/backend-api/codex/responses",
    // Codex fires backend-api preamble (`/ps/plugins/installed`, `/wham/apps`,
    // analytics) before inference — match only the `/responses` call.
    match: (p) => p.endsWith("/responses"),
    // TWO redirects are required. `chatgpt_base_url` only covers the preamble;
    // the INFERENCE `/responses` call uses the model provider's base_url, which
    // under ChatGPT auth resolves to the hardcoded CHATGPT_CODEX_BASE_URL unless
    // `openai_base_url` overrides the built-in openai provider — the ONLY config
    // hook. WITHOUT it the inference hits the REAL endpoint and spends tokens;
    // WITH it the recorder intercepts `/responses` (codex opens it as a
    // WebSocket upgrade — the handshake's identity headers aren't replayed; only
    // the URL is captured). `--ephemeral` + bypass flags keep it non-interactive.
    argv: (bin, base) => [
      bin,
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
      "-c",
      `chatgpt_base_url=${base}/backend-api`,
      "-c",
      `openai_base_url=${base}/backend-api/codex`,
      "ping",
    ],
    env: () => ({}),
  },
  kimi_code: {
    origin: "https://api.kimi.com",
    // The managed "Kimi For Coding" subscription speaks the OpenAI wire
    // (`/coding/v1/chat/completions`) — the genuine endpoint the official
    // `kimi-code-cli` POSTs to. Captured live by driving `kimi -p ping` headless
    // against the recorder; `defaultUpstreamUrl` is the fallback.
    path: "/coding/v1/chat/completions",
    match: (p) => p.endsWith("/coding/v1/chat/completions"),
    // `-p/--prompt` = headless single-shot. The isolated home has only the
    // credential — no provisioned model — so the `KIMI_MODEL_*` trio synthesizes
    // an EPHEMERAL in-memory model (provider type `kimi`) pointed at the
    // recorder. The OpenAI SDK appends `/chat/completions` to the base, so the
    // base must NOT include it.
    argv: (bin) => [bin, "-p", "ping"],
    env: (base) => ({
      KIMI_MODEL_NAME: "kimi-for-coding",
      KIMI_MODEL_API_KEY: "sk-openllm-capture",
      KIMI_MODEL_BASE_URL: `${base}/coding/v1`,
    }),
    // `kimi -p` is gated on a real TTY (raw-mode detection) — run under a PTY.
    usePty: true,
  },
};

/** The default (pre-capture) upstream URL: ORIGIN + default PATH. The delegate
 *  passes this as the `resolveUpstreamUrl` fallback so no URL literal lives in
 *  the delegate handler itself. */
export const defaultUpstreamUrl = (provider: TCliProvider): string =>
  CAPTURE[provider].origin + CAPTURE[provider].path;

/** A stored URL is only servable if it IS the provider's inference endpoint
 *  (passes `spec.match`). Guards against a legacy/stale URL captured before the
 *  preamble-skip — e.g. codex's `/backend-api/ps/plugins/installed`, a GET-only
 *  endpoint that 405s the inference POST. A non-matching URL is treated as
 *  absent so it's never served and gets re-captured. */
const urlIsInference = (provider: TCliProvider, url: string): boolean => {
  try {
    return CAPTURE[provider].match(new URL(url).pathname);
  } catch {
    return false;
  }
};

/** Race a promise against a timeout, resolving the fallback if it elapses OR if
 *  `p` rejects (capture failure → fallback, never an unhandled rejection). */
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });

type TRecorder = {
  readonly base: string;
  readonly first: Promise<{ path: string }>;
  readonly stop: () => void;
};

/**
 * A loopback HTTP recorder bound to an ephemeral 127.0.0.1 port. It resolves
 * `first` with the PATH of the first request whose path passes `spec.match` (the
 * INFERENCE call) — replying 204, after which the caller kills the CLI. Every
 * OTHER (preamble) request is FORWARDED to the real vendor so the CLI proceeds
 * far enough to issue its inference call. The inference request itself is
 * captured-then-killed and never forwarded, so it never reaches the vendor. Only
 * the request PATH is read — no identity headers are retained.
 */
const startRecorder = (spec: TCaptureSpec): TRecorder => {
  let resolveFirst!: (v: { path: string }) => void;
  let captured = false;
  const first = new Promise<{ path: string }>((resolve) => {
    resolveFirst = resolve;
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (!captured && spec.match(url.pathname)) {
        captured = true;
        resolveFirst({ path: url.pathname });
        return new Response(null, { status: 204 });
      }
      // Preamble — forward to the real vendor so the CLI continues to the
      // inference call. Strip `host` so fetch sets it for the real origin.
      try {
        const fwd = new Headers(req.headers);
        fwd.delete("host");
        return await fetch(spec.origin + url.pathname + url.search, {
          method: req.method,
          headers: fwd,
          body:
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : await req.arrayBuffer(),
        });
      } catch {
        return new Response(null, { status: 502 });
      }
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    first,
    stop: () => server.stop(true),
  };
};

/**
 * Run the CLI's headless `exec` against the recorder, capture the INFERENCE
 * request PATH (preamble calls forwarded so the CLI gets there), and return the
 * full upstream URL. Null on any failure (CLI absent, never issued a matching
 * request within the timeout, spawn error) — the caller falls back to the
 * default URL.
 */
const captureUpstreamUrl = async (
  provider: TCliProvider,
): Promise<string | null> => {
  const spec = CAPTURE[provider];
  const bin = cliBin(provider);
  const recorder = startRecorder(spec);
  const cmdArgv = [...spec.argv(bin, recorder.base)];
  const spawnArgv =
    spec.usePty === true
      ? (ptyScriptArgv(cmdArgv, "/dev/null") ?? cmdArgv)
      : cmdArgv;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn(spawnArgv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      cwd: tmpdir(),
      env: { ...process.env, ...cliEnv(provider), ...spec.env(recorder.base) },
    });
  } catch (err) {
    recorder.stop();
    logDebug("auth-config", `capture spawn failed for ${provider}`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Resolve as soon as the inference request is captured, OR the CLI exits — a
  // CLI that errors before issuing its request is never going to send one.
  const captured = await withTimeout(
    Promise.race([
      recorder.first,
      proc.exited.then(() => null as { path: string } | null),
    ]),
    CAPTURE_TIMEOUT_MS,
    null as { path: string } | null,
  );
  proc.kill();
  recorder.stop();

  if (captured === null) {
    logDebug("auth-config", `capture yielded no request for ${provider}`);
    return null;
  }
  return spec.origin + captured.path;
};

// One URL capture in flight per provider — concurrent serve requests that all
// find a stale/missing URL share ONE capture rather than racing the recorder.
const urlInFlight = new Map<TCliProvider, Promise<string | null>>();

const urlFresh = (cfg: TAuthConfig, cliVer: string | null): boolean =>
  cfg.upstream_url !== undefined &&
  cfg.cli_version === (cliVer ?? "") &&
  typeof cfg.captured_at_ms === "number" &&
  Date.now() - cfg.captured_at_ms < TTL_MS;

/**
 * Ensure (and return) the captured upstream URL for a provider: the stored URL
 * if fresh (version match AND within TTL AND a valid inference path), else a
 * freshly captured one. Returns the stale stored URL (or null) if capture fails
 * so serving never hard-breaks. `force` bypasses the cache (used right after a
 * re-login). `captureIfMissing: false` NEVER spawns the CLI — it serves the best
 * stored URL (even stale) or null, for callers that must not spawn a capture
 * (e.g. when the isolated CLI may be logged OUT).
 */
const ensureUpstreamUrl = async (
  provider: TCliProvider,
  opts?: { readonly force?: boolean; readonly captureIfMissing?: boolean },
): Promise<string | null> => {
  const cfg = (await readConfig(provider)) ?? {};
  const stored =
    cfg.upstream_url !== undefined && urlIsInference(provider, cfg.upstream_url)
      ? cfg.upstream_url
      : null;
  if (opts?.force !== true && stored !== null) {
    const ver = await cliVersion(cliBin(provider), cliEnv(provider));
    if (urlFresh(cfg, ver)) return stored;
  }
  if (opts?.captureIfMissing === false) return stored;
  const existing = urlInFlight.get(provider);
  if (existing !== undefined) return existing;
  const run = (async () => {
    const captured = await captureUpstreamUrl(provider);
    if (captured === null) return stored;
    const ver = await cliVersion(cliBin(provider), cliEnv(provider));
    await patchConfig(provider, {
      upstream_url: captured,
      cli_version: ver ?? "",
      captured_at_ms: Date.now(),
    });
    logInfo("auth-config", `captured ${provider} upstream URL`, {
      url: captured,
    });
    return captured;
  })().finally(() => urlInFlight.delete(provider));
  urlInFlight.set(provider, run);
  return run;
};

/**
 * Resolve the upstream URL for a served hop — the captured URL, or the
 * delegate's default when none exists. `opts` forwarded to {@link
 * ensureUpstreamUrl}.
 */
export const resolveUpstreamUrl = async (
  provider: TCliProvider,
  opts?: { readonly captureIfMissing?: boolean },
): Promise<string> => {
  const url = await ensureUpstreamUrl(provider, opts).catch(() => null);
  return url ?? defaultUpstreamUrl(provider);
};

// ─── OAuth refresh config (client_id + token_url, extracted from the binary) ──

/** The two providers whose CLI self-refreshes an OAuth access token. */
export type TOAuthProvider = "claude_code" | "chatgpt";

export type TOAuthConfig = {
  /** OAuth app client id (public). */
  readonly client_id: string;
  /** Token endpoint (`grant_type=refresh_token`). */
  readonly token_url: string;
};

/**
 * Pull the Claude prod OAuth config out of the CLI JS bundle. Anchored on the
 * PROD token URL host so a local-dev block can't be picked up. Null if the shape
 * changed.
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
 * Pull the Codex OAuth config out of the `codex_cli_rs` Rust binary. The id is
 * packed into rodata WITH NO SEPARATOR, so we match it at its EXACT known length
 * (`app_` + 24) and take the MOST FREQUENT match so a stray coincidental literal
 * can't win. Null unless BOTH values are found; the caller format-validates.
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

type TOAuthProviderSpec = {
  readonly extract: (binaryText: string) => TOAuthConfig | null;
  /** Shape guard for an extracted/cached config — rejects a mis-extraction so a
   *  previously-cached bad value self-heals (re-extract on the next run). The
   *  host allow-list is structural (which vendor we're talking to), NOT a
   *  hardcoded credential — it just refuses a value that ISN'T the vendor's. */
  readonly valid: (c: TOAuthConfig) => boolean;
};

// NO hardcoded fallback client_id / token_url: the OAuth config is ALWAYS the
// value extracted from the installed CLI binary (or the last successfully
// extracted one, cached in `config.json`). A stale hardcoded literal is exactly
// the drift that bit us (the token host moved `console.anthropic.com` →
// `platform.claude.com`); relying solely on extraction means we can never serve
// a wrong value — if extraction fails and nothing valid is cached, refresh is
// skipped (the stale access token surfaces the vendor's own 401 → re-login).
const OAUTH_SPECS: Readonly<Record<TOAuthProvider, TOAuthProviderSpec>> = {
  claude_code: {
    extract: extractClaude,
    valid: (c) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        c.client_id,
      ) &&
      /^https:\/\/(?:platform\.claude\.com|console\.anthropic\.com)\/v1\/oauth\/token$/.test(
        c.token_url,
      ),
  },
  // Codex extractor from ref/codex `login/src/auth/manager.rs`.
  chatgpt: {
    extract: extractCodex,
    valid: (c) =>
      /^app_[A-Za-z0-9]{24}$/.test(c.client_id) &&
      /^https:\/\/auth\.openai\.com\/oauth\/token$/.test(c.token_url),
  },
};

// Pull the OAuth config out of the provider's CLI binary via its extractor.
const extractOAuthFromBinary = async (
  provider: TOAuthProvider,
): Promise<TOAuthConfig | null> => {
  let bin = cliBin(provider);
  try {
    // The launcher may be a symlink to the real binary under versions/<ver>
    // (Claude); scan the resolved target. A plain binary (codex) self-resolves.
    bin = await realpath(bin).catch(() => bin);
    const file = Bun.file(bin);
    if (!(await file.exists())) return null;
    const text = await file.text(); // ASCII literals survive a latin1-ish read
    const extracted = OAUTH_SPECS[provider].extract(text);
    if (extracted === null) {
      // The binary read fine but the OAuth `token_url`/`client_id` pattern didn't
      // match — almost always a CLI version whose layout drifted past the
      // extractor. WARN (not debug): with no cached config this silently disables
      // token refresh, so the access token expires and usage/inference start
      // 401ing. This line is the breadcrumb to update the extractor.
      logWarn(
        "auth-config",
        "no OAuth config found in CLI binary — extractor likely needs updating for this CLI version; token refresh is disabled until a valid config is cached",
        { provider, bin, bytes: text.length },
      );
    }
    return extracted;
  } catch (err) {
    logDebug("auth-config", "binary extraction failed", {
      provider,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};

const oauthFresh = (cfg: TAuthConfig, ver: string | null): boolean =>
  cfg.cli_version === (ver ?? "") &&
  typeof cfg.extracted_at_ms === "number" &&
  Date.now() - cfg.extracted_at_ms < TTL_MS;

// One OAuth extraction in flight PER PROVIDER — concurrent refreshers share it.
const oauthInFlight = new Map<TOAuthProvider, Promise<TOAuthConfig | null>>();

/**
 * The OAuth config to use for a token refresh: the cached extraction if fresh
 * (version match AND within TTL AND passes the format guard), else a freshly
 * extracted one, else the last valid cached one — else `null` (NO hardcoded
 * fallback). A null result means the caller can't refresh right now and should
 * skip it (the stale access token then surfaces the vendor's own 401). `force`
 * bypasses the cache. Never throws.
 */
export const oauthConfig = async (
  provider: TOAuthProvider,
  opts?: { readonly force?: boolean },
): Promise<TOAuthConfig | null> => {
  const spec = OAUTH_SPECS[provider];
  const cfg = (await readConfig(provider)) ?? {};
  const cached: TOAuthConfig | null =
    cfg.client_id !== undefined &&
    cfg.token_url !== undefined &&
    spec.valid({ client_id: cfg.client_id, token_url: cfg.token_url })
      ? { client_id: cfg.client_id, token_url: cfg.token_url }
      : null;
  if (opts?.force !== true && cached !== null) {
    const ver = await cliVersion(cliBin(provider), {});
    if (oauthFresh(cfg, ver)) return cached;
  }
  const existing = oauthInFlight.get(provider);
  if (existing !== undefined) return existing;
  const run = (async () => {
    const extracted = await extractOAuthFromBinary(provider);
    // No hardcoded fallback — serve the last valid extraction if we have one,
    // else null (caller skips refresh).
    if (extracted === null || !spec.valid(extracted)) return cached;
    const ver = await cliVersion(cliBin(provider), {});
    await patchConfig(provider, {
      client_id: extracted.client_id,
      token_url: extracted.token_url,
      cli_version: ver ?? "",
      extracted_at_ms: Date.now(),
    });
    logInfo("auth-config", "extracted OAuth config from CLI", {
      provider,
      token_url: extracted.token_url,
      client_id_prefix: `${extracted.client_id.slice(0, 8)}…`,
    });
    return extracted;
  })().finally(() => oauthInFlight.delete(provider));
  oauthInFlight.set(provider, run);
  return run;
};

// ─── Combined entry (post-login / -relogin refresh) ──────────────────────────

const OAUTH_PROVIDERS: ReadonlySet<TCliProvider> = new Set<TCliProvider>([
  "claude_code",
  "chatgpt",
]);

const isOAuthProvider = (p: TCliProvider): p is TOAuthProvider =>
  OAUTH_PROVIDERS.has(p);

/**
 * Refresh the WHOLE auth config for a provider: re-capture the upstream URL and
 * (for the two OAuth providers) re-extract the refresh config. Best-effort —
 * each sub-part falls back independently. Called after a fresh login, when the
 * identity / CLI may have changed.
 */
export const ensureAuthConfig = async (
  provider: TCliProvider,
  opts?: { readonly force?: boolean; readonly captureIfMissing?: boolean },
): Promise<void> => {
  await Promise.all([
    ensureUpstreamUrl(provider, opts).catch(() => null),
    isOAuthProvider(provider)
      ? oauthConfig(provider, { force: opts?.force }).catch(() => null)
      : Promise.resolve(null),
  ]);
};
