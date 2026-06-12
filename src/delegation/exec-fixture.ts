/**
 * Exec-fixtures — capture the REAL upstream request a vendor CLI makes, so the
 * daemon serves with the genuine CLI identity instead of hand-copied literals.
 *
 * The daemon must impersonate the official CLI byte-for-byte on the wire (T2 of
 * `docs/proposals/subscription-oauth-terms-compliance.md`: do not FORGE a CLI
 * identity — use the real one). Hardcoding each vendor's inference URL + identity
 * headers is a best-effort reconstruction that silently drifts when a CLI
 * updates. Instead we run the CLI once in headless `exec` mode pointed at a
 * loopback recorder, capture the exact request it builds (path + headers),
 * KILL it before anything reaches the vendor (zero token cost, works offline),
 * and serve from that fixture. See
 * `docs/proposals/delegation-exec-fixtures.md`.
 *
 * The ONLY retained constants are the upstream ORIGIN (scheme+host) per provider
 * — irreducible without a TLS MITM, which codex's rustls closure blocks — and
 * the default PATH used as the pre-capture fallback. Everything else (the full
 * path, user-agent, telemetry headers, betas) is captured live.
 *
 * Bright line (proposal §6): the fixture feeds the LOCAL runner only; nothing
 * captured is sent off-box, and the volatile/secret `authorization` header is
 * denylisted out of the fixture entirely (the delegate injects a fresh bearer).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TCliProvider } from "../cli-paths";
import { cliBin, cliEnv, cliRoot } from "../cli-paths";
import { logDebug, logInfo } from "../logger";
import { cliVersion, ptyScriptArgv, readJsonFile } from "./util";

export type TExecFixture = {
  /** The isolated binary's `--version` at capture time; a mismatch re-captures. */
  readonly cli_version: string;
  /** Epoch ms of capture; older than the 24h TTL re-captures. */
  readonly captured_at_ms: number;
  /** ORIGIN + the captured request path (e.g. `https://api.anthropic.com/v1/messages`). */
  readonly url: string;
  /** The CLI's genuine request headers, minus the volatile/secret/transport set. */
  readonly headers: Readonly<Record<string, string>>;
};

/** Re-capture a fixture once it is older than this, even when neither the CLI
 *  version nor the login changed (catches server-side identity rotations). */
const FIXTURE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Hard cap on a capture run — the CLI should emit its first request in <1s; a
 *  CLI that errors before sending (bad base override, refuses headless, …) just
 *  times out and the caller falls back to the default fixture. */
const CAPTURE_TIMEOUT_MS = 20_000;

/**
 * Volatile / secret / transport headers dropped from the captured fixture.
 * Everything else the CLI sent is kept verbatim — including telemetry headers
 * (`x-stainless-*`, `openai-beta`, …) — which makes us MORE byte-identical to
 * the real CLI, not less. `authorization` is dropped here and re-attached fresh
 * per request by the delegate; `content-type` is owned by the wire builder.
 */
const HEADER_DENYLIST: ReadonlySet<string> = new Set([
  "authorization",
  "host",
  "content-length",
  "content-type",
  "accept-encoding",
  "transfer-encoding",
  "connection",
  "cookie",
  // WebSocket-handshake transport: codex opens `/responses` over a WS upgrade,
  // but the daemon serves it as a plain HTTP POST — the handshake bytes must
  // never be replayed (`connection` is already covered above).
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  // Per-request / per-session volatiles (codex Responses). Replaying a captured
  // value would pin a stale session/turn/window onto every served request; the
  // daemon omits them (or sets them per request), so they must not persist.
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-turn-metadata",
  "x-codex-window-id",
]);

const filterHeaders = (
  raw: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (!HEADER_DENYLIST.has(key)) out[key] = v;
  }
  return out;
};

/**
 * Per-provider capture recipe. `origin` is the retained constant (the redirect
 * replaces it, so it can't be captured); `path` is only the PRE-capture
 * fallback (the live capture overrides it with the real path). `match` picks the
 * INFERENCE request out of the CLI's request stream — CLIs emit preamble calls
 * first (e.g. codex hits `/backend-api/ps/plugins/installed` before its
 * `/responses` call), which the recorder forwards to the vendor so the CLI
 * proceeds; only the matching inference request is captured. `argv` + `env`
 * point the headless CLI at the loopback recorder — see the corrected exec
 * formats in `docs/proposals/delegation-exec-fixtures.md` §2.
 */
type TCaptureSpec = {
  readonly origin: string;
  readonly path: string;
  readonly match: (path: string) => boolean;
  readonly argv: (bin: string, base: string) => ReadonlyArray<string>;
  readonly env: (base: string) => Record<string, string>;
  /**
   * Run the headless CLI under a pseudo-terminal (`script(1)`). Set for a CLI
   * whose print/exec mode is gated on a real TTY and emits NO request under a
   * plain pipe (kimi's `-p` raw-mode gate) — see `ptyScriptArgv`. On an OS
   * without `script` it falls back to a plain spawn (capture then yields no
   * request → the delegate's hand-mirrored identity fallback).
   */
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
    // `openai_base_url` overrides the built-in openai provider — the ONLY
    // config hook (`model_providers.openai` is a reserved id codex refuses to
    // override). WITHOUT the `openai_base_url` override the inference hits the
    // REAL endpoint and spends tokens; WITH it the recorder intercepts
    // `/responses` (codex opens it as a WebSocket upgrade — the handshake's
    // identity headers are captured, its WS-transport headers denylisted). The
    // built-in openai provider keeps `requires_openai_auth`, so the ChatGPT
    // subscription token is still attached. `--ephemeral` + bypass flags keep
    // it non-interactive.
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
    // `kimi-code-cli` POSTs to. Captured live (with its real `kimi-code-cli`
    // identity) by driving `kimi -p ping` headless against the recorder; the
    // delegate's hand-mirrored identity is the fallback when capture can't run.
    path: "/coding/v1/chat/completions",
    match: (p) => p.endsWith("/coding/v1/chat/completions"),
    // `-p/--prompt` = headless single-shot (a non-empty prompt is required). The
    // isolated home has only the credential — no provisioned config/model — so
    // `kimi -p` would error "No model configured" before issuing a request. The
    // `KIMI_MODEL_*` trio synthesizes an EPHEMERAL in-memory model (ref/kimi-code
    // `packages/agent-core/src/config/env-model.ts`) that auto-becomes the
    // default: provider type `kimi` (so the genuine `kimi-code-cli` UA + X-Msh-*
    // identity headers are attached via the same provider-manager path) pointed
    // at the recorder. The OpenAI SDK appends `/chat/completions` to the base, so
    // the base must NOT include it. The dummy api key only rides `authorization`,
    // which the fixture denylists + the delegate re-injects fresh.
    argv: (bin) => [bin, "-p", "ping"],
    env: (base) => ({
      KIMI_MODEL_NAME: "kimi-for-coding",
      KIMI_MODEL_API_KEY: "sk-openllm-capture",
      KIMI_MODEL_BASE_URL: `${base}/coding/v1`,
    }),
    // `kimi -p` is gated on a real TTY (raw-mode detection) — under a plain pipe
    // it emits no request. Run it under a PTY like `claude setup-token`.
    usePty: true,
  },
};

/** The default (pre-capture) upstream URL: ORIGIN + default PATH. The delegate
 *  passes this as the `resolveUpstream` fallback so no URL literal lives in the
 *  delegate handler itself. */
export const defaultUpstreamUrl = (provider: TCliProvider): string =>
  CAPTURE[provider].origin + CAPTURE[provider].path;

const fixturePath = (provider: TCliProvider): string =>
  join(cliRoot(provider), "exec-fixture.json");

const readFixture = (provider: TCliProvider): Promise<TExecFixture | null> =>
  readJsonFile<TExecFixture>(fixturePath(provider));

const writeFixture = async (
  provider: TCliProvider,
  fixture: TExecFixture,
): Promise<void> => {
  await Bun.write(fixturePath(provider), JSON.stringify(fixture));
};

const isFresh = (fixture: TExecFixture, cliVer: string | null): boolean =>
  fixture.cli_version === (cliVer ?? "") &&
  Date.now() - fixture.captured_at_ms < FIXTURE_TTL_MS;

/**
 * A fixture is only servable if its captured path IS the provider's inference
 * endpoint (passes `spec.match`). Guards against a legacy/stale fixture written
 * before capture learned to skip preamble calls — e.g. codex's
 * `/backend-api/ps/plugins/installed`, a GET-only endpoint that 405s the
 * inference POST. A non-matching fixture is treated as absent so it's never
 * served and gets re-captured.
 */
const fixtureUrlIsInference = (
  provider: TCliProvider,
  fixture: TExecFixture,
): boolean => {
  try {
    return CAPTURE[provider].match(new URL(fixture.url).pathname);
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
  readonly first: Promise<{ path: string; headers: Record<string, string> }>;
  readonly stop: () => void;
};

/**
 * A loopback HTTP recorder bound to an ephemeral 127.0.0.1 port. It resolves
 * `first` with the path + headers of the first request whose path passes
 * `spec.match` (the INFERENCE call) — replying 204, after which the caller kills
 * the CLI. Every OTHER (preamble) request is FORWARDED to the real vendor so the
 * CLI proceeds far enough to actually issue its inference call (codex fires
 * `/ps/plugins/installed` etc. first). Preamble forwards use the CLI's own auth
 * verbatim — the same calls it would make directly; the inference request itself
 * is captured-then-killed and never forwarded, so it never reaches the vendor.
 */
const startRecorder = (spec: TCaptureSpec): TRecorder => {
  let resolveFirst!: (v: {
    path: string;
    headers: Record<string, string>;
  }) => void;
  let captured = false;
  const first = new Promise<{
    path: string;
    headers: Record<string, string>;
  }>((resolve) => {
    resolveFirst = resolve;
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (!captured && spec.match(url.pathname)) {
        captured = true;
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });
        resolveFirst({ path: url.pathname, headers });
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
 * request (preamble calls are forwarded so the CLI gets there), and write the
 * fixture. Returns null on any failure (CLI absent, never issued a matching
 * request within the timeout, spawn error) — the caller falls back to the
 * default fixture. The inference request is captured-then-killed and never
 * forwarded, so it never reaches the vendor.
 */
const captureExecFixture = async (
  provider: TCliProvider,
): Promise<TExecFixture | null> => {
  const spec = CAPTURE[provider];
  const bin = cliBin(provider);
  const recorder = startRecorder(spec);
  const cmdArgv = [...spec.argv(bin, recorder.base)];
  // PTY-gated CLIs (kimi `-p`) run under `script(1)`; the terminal capture goes
  // to /dev/null since we drive off the HTTP recorder, not the typescript. On an
  // OS without `script` it falls back to a plain pipe (→ likely no request → the
  // delegate's hand-mirrored identity fallback).
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
    logDebug("exec-fixture", `capture spawn failed for ${provider}`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Resolve as soon as the inference request is captured, OR the CLI exits — a
  // CLI that errors before issuing its request (bad override, refuses headless,
  // missing config) is never going to send one, so don't burn the full timeout
  // waiting. The hard cap still bounds a CLI that hangs without doing either.
  const captured = await withTimeout(
    Promise.race([
      recorder.first,
      proc.exited.then(
        () => null as { path: string; headers: Record<string, string> } | null,
      ),
    ]),
    CAPTURE_TIMEOUT_MS,
    null as { path: string; headers: Record<string, string> } | null,
  );
  proc.kill();
  recorder.stop();

  if (captured === null) {
    logDebug("exec-fixture", `capture yielded no request for ${provider}`);
    return null;
  }

  const fixture: TExecFixture = {
    cli_version: (await cliVersion(bin, cliEnv(provider))) ?? "",
    captured_at_ms: Date.now(),
    url: spec.origin + captured.path,
    headers: filterHeaders(captured.headers),
  };
  await writeFixture(provider, fixture);
  logInfo("exec-fixture", `captured ${provider} exec fixture`, {
    url: fixture.url,
    headerKeys: Object.keys(fixture.headers).length,
  });
  return fixture;
};

// One capture in flight per provider — concurrent serve requests that all find a
// stale/missing fixture share ONE capture rather than racing the recorder/CLI.
const inFlight = new Map<TCliProvider, Promise<TExecFixture | null>>();

/**
 * The current exec fixture for a provider: the cached file if fresh (version
 * match AND within the 24h TTL), else a freshly captured one. Returns the stale
 * cache (or null) if capture fails so serving never hard-breaks. `force`
 * bypasses the cache (used right after a re-login, when identity may have
 * shifted).
 *
 * `captureIfMissing: false` NEVER spawns the CLI to capture — it serves the
 * best cached fixture (even if stale) or null. Use it when the isolated CLI is
 * NOT the credential source and so can't produce a genuine request anyway: a
 * Claude setup-token is delivered out-of-band, leaving the isolated CLI logged
 * OUT, so a capture would spawn a doomed `claude -p ping` on every inference.
 */
export const ensureExecFixture = async (
  provider: TCliProvider,
  opts?: { readonly force?: boolean; readonly captureIfMissing?: boolean },
): Promise<TExecFixture | null> => {
  const raw = await readFixture(provider);
  // Discard a fixture that captured a non-inference path (legacy/stale) — it
  // would send the inference request to the wrong endpoint (→ 405). Treat as no
  // fixture so it's re-captured and never served, NEITHER as a fresh hit NOR as
  // the capture-failure fallback below.
  const cached =
    raw !== null && fixtureUrlIsInference(provider, raw) ? raw : null;
  if (opts?.force !== true && cached !== null) {
    const ver = await cliVersion(cliBin(provider), cliEnv(provider));
    if (isFresh(cached, ver)) return cached;
  }
  // No-capture mode: serve the best cached fixture (stale ok) or null → the
  // delegate's defaults. Never spawn the (logged-out) CLI.
  if (opts?.captureIfMissing === false) return cached;
  const existing = inFlight.get(provider);
  if (existing !== undefined) return existing;
  const run = captureExecFixture(provider)
    .then((fx) => fx ?? cached)
    .finally(() => inFlight.delete(provider));
  inFlight.set(provider, run);
  return run;
};

/**
 * Resolve the upstream `{ url, headers }` for a served hop, PREFERRING the
 * captured fixture and layering its headers over the delegate's fallback (so
 * captured identity wins, while per-credential headers the fallback supplies —
 * e.g. an account id absent from the fixture — are kept). On no fixture the
 * fallback is used verbatim. `opts` is forwarded to {@link ensureExecFixture}
 * (e.g. `captureIfMissing: false` for the setup-token inference path).
 */
export const resolveUpstream = async (
  provider: TCliProvider,
  fallback: { readonly url: string; readonly headers: Record<string, string> },
  opts?: { readonly captureIfMissing?: boolean },
): Promise<{ url: string; headers: Record<string, string> }> => {
  const fixture = await ensureExecFixture(provider, opts).catch(() => null);
  if (fixture === null) return fallback;
  return {
    url: fixture.url,
    headers: { ...fallback.headers, ...fixture.headers },
  };
};
