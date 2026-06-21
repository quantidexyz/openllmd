/**
 * OpenLLM local daemon — entrypoint.
 *
 * Headless. Boots a localhost `Bun.serve` that exposes the
 * OpenAI/Anthropic-compatible `/v1/*` inference surface (run locally against
 * `packages/core`'s pipeline for SUBSCRIPTION hops, credentials delegated to
 * the official vendor CLIs) plus a tiny read-only `/whoami` that returns this
 * daemon's opaque `device_id` so the dashboard can tell which key's daemon is
 * on THIS host (`docs/proposals/this-machine-detection-audit.md`). CONTROL
 * (status / connect / cli-install) is NOT served on localhost: the daemon
 * dials OUT to the cloud relay over a WebSocket (`control-channel.ts`) and the
 * dashboard drives it from there. Both loopback routes share one cross-origin
 * CORS/PNA grant. See `docs/proposals/daemon-relay-websocket-push.md`.
 *
 * It holds NO DEK and decrypts NO vault credential. The only secret it
 * carries is the user's `sk-llm-...` key, used to authenticate cloud
 * control-plane calls (config pull + request-metadata recording) and to
 * forward API-key hops in a mixed chain to the cloud `/v1/*` surface.
 *
 * This file is compiled into a source-free standalone binary with
 * `bun build --compile --minify --bytecode` (see scripts/compile.ts).
 */
import { migrateLegacyAutoUpdate } from "./auto-update-pref";
import { guardCrashLoop } from "./boot-guard";
import { runCli } from "./cli";
import { getCloudState, latestVersion, refreshBootstrap } from "./config";
import {
  pushStatusIfChanged,
  startControlChannel,
  stopControlChannel,
} from "./control-channel";
import { corsHeaders, isPreflight, preflightResponse } from "./cors";
import { daemonPort, deviceId, hasApiKey, isDevMode, stateDir } from "./env";
import { buildHealth } from "./health";
import { handleInference } from "./listener";
import { logError, logInfo } from "./logger";
import { applyDaemonSandbox, sandboxState } from "./sandbox/landlock";
import {
  beginRequest,
  endRequest,
  maybeSelfUpdate,
  trackBodyDone,
} from "./self-update";
import { enableUsagePersistence } from "./usage-cache";
import { DAEMON_VERSION } from "./version";

// Once the cloud snapshot is healthy, refresh every 5 minutes to stay in
// lockstep with dashboard config changes.
const BOOTSTRAP_TTL_MS = 5 * 60 * 1000;
// Until it's healthy (no key yet / cloud still starting up in dev / key
// just changed), retry quickly so the daemon picks up a freshly-set key
// or a `next dev` that finished compiling — without waiting a full TTL.
const BOOTSTRAP_RETRY_MS = 5 * 1000;

// Wall-clock at process start, for the `/status` uptime field. Module-load time
// is "boot" for our purposes (the listener binds within the same tick).
const BOOT_AT = Date.now();

const main = async (): Promise<void> => {
  // `daemonPort()` loads the env file, so the kill-switch / opt-in vars are
  // resolved before the sandbox decision.
  const port = daemonPort();

  // Fold any pre-`daemon.env` legacy config into the single config file (and
  // remove the stray files) before anything reads it — the `auto-update` flag
  // here; `api-key` / `device-id` migrate lazily in env.ts on first read.
  migrateLegacyAutoUpdate();

  // Crash-loop circuit breaker. The supervisor (systemd `Restart=always` /
  // launchd `KeepAlive`) relaunches us on every exit, so a persistent boot
  // failure (port permanently in use, a bad binary) would otherwise respawn
  // forever — flooding the log + burning CPU on each boot's sandbox/FFI setup.
  // Record this boot and, if we've restarted too many times in a short window,
  // disable self-restore and exit cleanly so the thrashing STOPS (recover with
  // `openllmd restart`). systemd ALSO has a native start-limit backstop
  // (`service.ts`); this is the cross-platform half (launchd has no equivalent).
  // Runs before the sandbox so it can't be tripped by an FS-confinement bug,
  // and before the (costly) sandbox/FFI work it's meant to stop repeating.
  guardCrashLoop();

  // OS sandbox (Linux Landlock / macOS Seatbelt — see `sandbox/landlock.ts`'s
  // `applyDaemonSandbox` dispatcher): confine this process + every child it
  // spawns to the declared working set BEFORE any listener binds or network
  // dial happens. Fail-open with a loud log; the resulting posture rides every
  // status push (`DaemonStatus.sandbox`). CLI verbs (`runCli` below)
  // deliberately run unconfined — service registration and uninstall touch
  // paths outside the working set.
  const sandbox = await applyDaemonSandbox();
  // Always record the decision at boot so an unconfined daemon is visible in
  // the log, not just on the (cloud-pushed) `DaemonStatus.sandbox` field —
  // the localhost-only boot never pushes status.
  logInfo("sandbox", `os sandbox: ${sandbox}`);

  // Last-resort crash handling. The daemon is headless under launchd/systemd,
  // so an uncaught throw or rejected promise would otherwise die silently —
  // log it to `~/.openllm/openllmd.log`, then EXIT non-zero. Registering a
  // handler does NOT stop the runtime from terminating, and continuing after a
  // fatal error leaves the process in an indeterminate state; exiting lets the
  // launch agent / systemd unit restart it clean. `logError` writes
  // synchronously (appendFileSync), so the line is flushed before exit.
  process.on("uncaughtException", (err) => {
    logError("uncaughtException", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logError("unhandledRejection", reason);
    process.exit(1);
  });

  // Opt the usage cache into disk-backed survival across restarts, and hydrate
  // it from any prior file NOW — before the control relay's first status push —
  // so a freshly restarted daemon already has last-known figures to serve if
  // the post-restart usage read is rate-limited (rather than showing an error
  // with nothing to fall back to). See `usage-cache.ts`.
  enableUsagePersistence(stateDir());

  // Pull the catalog + routing config. This NEVER throws — when there's
  // no API key yet (the daemon installs keyless; the dashboard sets the
  // key afterwards) or the cloud isn't reachable, it records the reason
  // in `cloudState` and the daemon comes up anyway, serving the control
  // surface so the dashboard can set/fix the key. We poll on a SHORT
  // interval until the snapshot is healthy, then relax to the TTL — so a
  // just-set key (or a `next dev` that just finished booting) is picked
  // up within seconds, not after a 5-minute wait.
  await refreshBootstrap();
  // Converge to the cloud's published daemon version (no-op from source / when
  // already current). Fire-and-forget: it self-guards and, when it updates,
  // swaps the binary + exits once `/v1` is idle so the supervisor relaunches.
  void maybeSelfUpdate(latestVersion());
  const scheduleBootstrap = (): void => {
    const delay =
      getCloudState() === "ok" ? BOOTSTRAP_TTL_MS : BOOTSTRAP_RETRY_MS;
    setTimeout(async () => {
      try {
        // A retry that flips cloud_state (e.g. a boot-time `unreachable`
        // recovering to `ok` once the network/cloud is up) must re-push the
        // status, or the dashboard stays stuck on the stale value. Push it over
        // the relay socket immediately on change (the channel's own watcher
        // would catch it within a couple seconds anyway).
        const changed = await refreshBootstrap();
        if (changed) await pushStatusIfChanged();
        // Periodic version check — picks up a release published while running.
        void maybeSelfUpdate(latestVersion());
      } catch (err) {
        // setTimeout doesn't observe the async callback's promise, so an
        // unguarded throw here is an unhandled rejection AND skips the reschedule
        // below — silently killing the bootstrap/self-update loop forever. Catch,
        // log, and always reschedule in `finally`.
        logError("main", err);
      } finally {
        scheduleBootstrap();
      }
    }, delay);
  };
  scheduleBootstrap();

  // Dial OUT to the cloud relay over a WebSocket: it delivers dashboard
  // commands and marks this key's daemon "online" server-side — so the
  // dashboard never reaches loopback (no Private Network Access prompt). See
  // `docs/proposals/daemon-relay-websocket-push.md`.
  startControlChannel();

  // Graceful-exit beacon: flip the key offline immediately on Ctrl-C /
  // termination instead of waiting for the presence-staleness window.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void stopControlChannel().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Bun.serve throws synchronously when the port can't be bound. The headline
  // failure is EADDRINUSE (another openllmd, or a stray process, on the port) —
  // emit ONE clear line instead of an opaque stack trace on every supervised
  // respawn, then exit non-zero (the crash-loop guard above bounds the retries).
  try {
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      // Long-lived connections: streaming `/v1/*` inference. The default
      // ~10s idle timeout would sever a stream between writes, so raise it to
      // Bun's max; the stream emits its own keep-alives well under it.
      idleTimeout: 255,
      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/v1/")) {
          // Stamp every inference response as daemon-served — an
          // observability marker (you can always tell a response came from
          // the local daemon vs the cloud) AND a safety net: an unexpected
          // throw in `handleInference` becomes a clean error envelope
          // instead of a bare runtime 500. Body is passed through
          // untouched so streaming responses keep streaming.
          //
          // Count this request as in-flight so a self-update holds the restart
          // until it finishes (no cut streams). A streaming body keeps flowing
          // AFTER this handler returns, so `endRequest` must fire when the BODY
          // completes (or cancels/errors), not when the handler resolves —
          // `trackBodyDone` wraps the stream to do exactly that.
          beginRequest();
          let res: Response;
          try {
            res = await handleInference(req);
          } catch (err) {
            logError("inference", err, { path: url.pathname });
            res = new Response(
              JSON.stringify({
                error: {
                  message: err instanceof Error ? err.message : String(err),
                },
              }),
              { status: 500, headers: { "content-type": "application/json" } },
            );
          }
          const headers = new Headers(res.headers);
          headers.set("x-openllm-served-by", "daemon");
          if (res.body === null) {
            endRequest();
            return new Response(null, {
              status: res.status,
              statusText: res.statusText,
              headers,
            });
          }
          return new Response(trackBodyDone(res.body, endRequest), {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
        }
        // `/whoami` — the ONLY non-`/v1` loopback route: returns this daemon's
        // opaque `device_id` so the dashboard can learn which key's daemon is on
        // THIS host (a daemon answering your own loopback IS on your machine —
        // the single authoritative locality signal, replacing the IP heuristic +
        // localStorage device-code guess). No PII, no token; reuses the same
        // cross-origin CORS/PNA grant the browser already holds for `/v1/*`. See
        // `docs/proposals/this-machine-detection-audit.md`.
        if (url.pathname === "/whoami") {
          if (isPreflight(req)) return preflightResponse(req);
          const headers = new Headers(corsHeaders(req));
          headers.set("content-type", "application/json");
          return new Response(JSON.stringify({ device_id: deviceId() }), {
            status: 200,
            headers,
          });
        }
        // `/status` — read-only loopback health snapshot. A successful fetch is
        // the authoritative "this daemon is actually SERVING" signal (the
        // supervisor only knows it has a process, not that it bound the port),
        // and it carries the real sandbox posture this process applied at boot —
        // which `openllmd status` can't compute itself. Secret-free subset of
        // `computeStatus()`; see `health.ts`. Shares the loopback CORS grant.
        if (url.pathname === "/status") {
          if (isPreflight(req)) return preflightResponse(req);
          const headers = new Headers(corsHeaders(req));
          headers.set("content-type", "application/json");
          const health = buildHealth({
            version: DAEMON_VERSION,
            port,
            sandbox: sandboxState(),
            cloudState: getCloudState(),
            keyConfigured: hasApiKey(),
            bootAt: BOOT_AT,
            now: Date.now(),
          });
          return new Response(JSON.stringify(health), { status: 200, headers });
        }
        // Everything else: control comes via the cloud relay, not a
        // browser→loopback call.
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "EADDRINUSE") {
      logError(
        "boot",
        `port ${port} already in use — another openllmd (or a stray process) holds 127.0.0.1:${port}. ` +
          "Stop it (`openllmd stop`) or set OPENLLM_DAEMON_PORT to a free port.",
      );
    } else {
      logError("boot", err);
    }
    process.exit(1);
  }
  // Single line to stdout so the install-time launcher can confirm boot.
  process.stdout.write(
    `openllmd v${DAEMON_VERSION}${isDevMode() ? " (dev)" : ""} listening on http://127.0.0.1:${port}\n`,
  );
  logInfo("boot", `openllmd v${DAEMON_VERSION} listening on :${port}`);
};

// Dispatch management subcommands (start/stop/status/completion/…);
// a bare `openllmd` with no args falls through to boot the server. See `cli.ts`.
if (!runCli()) void main();
