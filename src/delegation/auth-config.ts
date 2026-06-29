/**
 * Per-provider AUTH CONFIG — a `config.json` sidecar next to the isolated CLI
 * (`<cliRoot>/config.json`) that caches:
 *
 *   - `upstream_url` — the genuine inference endpoint the vendor CLI POSTs to,
 *     CAPTURED from a real headless `exec` request (it drifts on CLI updates —
 *     e.g. codex's `/backend-api/codex/responses` host moved — and can't be
 *     hardcoded). The capture KILLS the CLI before anything reaches the vendor
 *     (zero token cost, works offline).
 *   - `cli_version` — CLI meta, the capture freshness key.
 *
 * Token REFRESH is NOT done here — each delegate triggers its CLI's OWN native
 * refresh (see `delegation/refresh.ts`), so no OAuth `client_id`/`token_url` is
 * extracted or stored.
 *
 * Bright line (terms-compliance): NOTHING here is replayed as inference
 * identity. The daemon serves each request with the ORIGINATOR's own headers
 * (`@quantidexyz/openllmw/lib/forwarded-headers`) + the injected bearer; this config
 * supplies only the request TARGET URL. The volatile/secret `authorization`
 * header is never captured or stored.
 *
 * Plain JSON (read via `readJsonFile`, written via `Bun.write` + `JSON.stringify`)
 * — always fresh on re-read after a re-capture, no runtime transpiler, works
 * identically in the compiled `--bytecode` binary.
 *
 * Supersedes the former `exec-fixture.ts` (URL+identity capture) — see
 * `docs/proposals/delegation-exec-fixtures.md` (amended) and
 * `docs/proposals/subscription-oauth-terms-compliance.md`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TCliProvider } from "../cli-paths";
import { cliBin, cliEnv, cliRoot } from "../cli-paths";
import { logDebug, logInfo } from "../logger";
import { cliVersion, ptyScriptArgv, readJsonFile } from "./util";

/** The persisted shape (all fields optional). */
export type TAuthConfig = {
  /** ORIGIN + the captured request path (e.g. `https://api.anthropic.com/v1/messages`). */
  readonly upstream_url?: string;
  /** The isolated binary's `--version` at capture time; a mismatch re-captures. */
  readonly cli_version?: string;
  /** Epoch ms of the last URL capture; older than the TTL re-captures. */
  readonly captured_at_ms?: number;
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
  /** When `false`, NEVER spawn a live `-p ping` capture for this provider —
   *  serve the default endpoint verbatim instead. Set for a provider whose
   *  capture does more harm than good: the `-p ping` is a REAL inference, which
   *  makes the isolated CLI refresh + ROTATE its single-use OAuth refresh token
   *  behind the daemon's back. That rotation races the daemon's own self-refresh
   *  and stranded claude_code's credential (the CLI cleared the refresh token to
   *  `""` on a lost-race refresh → un-refreshable → re-login every ~8h). claude's
   *  `/v1/messages` has never drifted (every capture returned the default), so
   *  the capture was pure risk with no benefit. */
  readonly liveCapture?: boolean;
};

const CAPTURE: Readonly<Record<TCliProvider, TCaptureSpec>> = {
  claude_code: {
    origin: "https://api.anthropic.com",
    path: "/v1/messages",
    match: (p) => p.endsWith("/v1/messages"),
    // `-p/--print` = headless single-shot; ANTHROPIC_BASE_URL redirects it.
    // RETAINED for shape only — `liveCapture: false` means this is NEVER run:
    // a real `claude -p ping` would rotate the OAuth refresh token mid-capture
    // (see `liveCapture`). The default `/v1/messages` (stable) is served instead.
    argv: (bin) => [bin, "-p", "ping"],
    env: (base) => ({ ANTHROPIC_BASE_URL: base }),
    liveCapture: false,
  },
  chatgpt: {
    // NOTE: codex's `/responses` endpoint genuinely DRIFTS on CLI updates
    // (unlike claude's stable `/v1/messages`), so we can't set
    // `liveCapture: false` here — the capture must keep running to track the
    // real endpoint. Codex's analogous refresh-token rotation race is instead
    // narrowed by the empty-token guard + atomic `auth.json` write in chatgpt.ts.
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
  // Providers flagged `liveCapture: false` NEVER spawn a `-p ping` capture (it
  // would rotate their OAuth refresh token behind the daemon's back). Short-
  // circuit to the stored URL (or null → the stable default via
  // `resolveUpstreamUrl`) BEFORE the `cliVersion` probe below, so a legacy
  // stored URL can't trigger a pointless `claude --version` spawn either. For
  // claude_code the only other isolated-CLI call the daemon makes is
  // `claude auth status`, a pure local READ (verified — no token refresh), so
  // with the capture gone the daemon is the SOLE refresher (no rotation race).
  if (CAPTURE[provider].liveCapture === false) return stored;
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

/**
 * Build a URL for a sibling endpoint on the SAME host as a provider's captured
 * inference endpoint — e.g. the vendor usage endpoint. The HOST is taken from
 * the captured `upstream_url` (falling back to the default origin), so a vendor
 * host migration — the exact drift that bit the token host — is auto-tracked
 * with no hardcoded origin; only the stable leaf `path` (e.g. `/api/oauth/usage`)
 * is a constant. NEVER spawns a capture (`captureIfMissing:false`) — callers
 * (usage reads) must not trigger a CLI spawn.
 */
export const resolveProviderUrl = async (
  provider: TCliProvider,
  path: string,
): Promise<string> => {
  // Enforce the same-host contract: `path` must be an absolute PATH on the
  // captured host. An absolute (`https://…`) or protocol-relative (`//host`)
  // value would let `new URL(path, origin)` OVERRIDE the origin and silently
  // point off-host — refuse it.
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(
      `resolveProviderUrl: path must be a same-origin absolute path, got "${path}"`,
    );
  }
  const base = await resolveUpstreamUrl(provider, { captureIfMissing: false });
  return new URL(path, new URL(base).origin).toString();
};

// ─── Combined entry (post-login / -relogin re-capture) ───────────────────────

/**
 * Re-capture a provider's upstream URL — called after a fresh login, when the
 * identity / CLI may have changed. Best-effort. Token REFRESH is the CLI's own
 * job (see `delegation/refresh.ts`), so the URL is all there is to refresh here.
 */
export const ensureAuthConfig = async (
  provider: TCliProvider,
  opts?: { readonly force?: boolean; readonly captureIfMissing?: boolean },
): Promise<void> => {
  await ensureUpstreamUrl(provider, opts).catch(() => null);
};
