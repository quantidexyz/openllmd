/**
 * OpenLLM local daemon — entrypoint.
 *
 * Headless. Boots a localhost `Bun.serve` that exposes ONE surface — the
 * OpenAI/Anthropic-compatible `/v1/*` inference surface, run locally
 * against `packages/core`'s pipeline for SUBSCRIPTION hops (credentials
 * delegated to the official vendor CLIs). Control (status / connect /
 * cli-install) is NOT served on localhost anymore: the daemon dials OUT to
 * the cloud control channel (`control-relay.ts`) and the dashboard drives
 * it from there — so there's no browser→loopback hop (no Private Network
 * Access prompt). See `docs/proposals/daemon-control-via-neon-longpoll.md`.
 *
 * It holds NO DEK and decrypts NO vault credential. The only secret it
 * carries is the user's `sk-llm-...` key, used to authenticate cloud
 * control-plane calls (config pull + request-metadata recording) and to
 * forward API-key hops in a mixed chain to the cloud `/v1/*` surface.
 *
 * This file is compiled into a source-free standalone binary with
 * `bun build --compile --minify --bytecode` (see scripts/compile.ts).
 */
import { getCloudState, latestVersion, refreshBootstrap } from "./config";
import {
  pushStatus,
  reportControlInactive,
  startControlRelay,
} from "./control-relay";
import { isDevMode } from "./env";
import { handleInference } from "./listener";
import { logError, logInfo } from "./logger";
import {
  beginRequest,
  endRequest,
  maybeSelfUpdate,
  trackBodyDone,
} from "./self-update";
import { setSetupToken } from "./setup-token";
import { DAEMON_VERSION } from "./version";

const DEFAULT_PORT = 8787;

// Once the cloud snapshot is healthy, refresh every 5 minutes to stay in
// lockstep with dashboard config changes.
const BOOTSTRAP_TTL_MS = 5 * 60 * 1000;
// Until it's healthy (no key yet / cloud still starting up in dev / key
// just changed), retry quickly so the daemon picks up a freshly-set key
// or a `next dev` that finished compiling — without waiting a full TTL.
const BOOTSTRAP_RETRY_MS = 5 * 1000;

const readPort = (): number => {
  const raw = process.env.OPENLLM_DAEMON_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
};

const main = async (): Promise<void> => {
  const port = readPort();

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
      // A retry that flips cloud_state (e.g. a boot-time `unreachable`
      // recovering to `ok` once the network/cloud is up) must re-push the
      // status, or the dashboard stays stuck on the stale value until the next
      // command. The relay only pushes on commands, so do it here on change.
      const changed = await refreshBootstrap();
      if (changed) await pushStatus();
      // Periodic version check — picks up a release published while running.
      void maybeSelfUpdate(latestVersion());
      scheduleBootstrap();
    }, delay);
  };
  scheduleBootstrap();

  // Dial OUT to the cloud control channel: a long-poll that delivers
  // dashboard commands (connect / cli-install) and, by being held open,
  // marks this key's daemon "online" server-side — so the dashboard no
  // longer has to reach loopback (no Private Network Access prompt). See
  // `docs/proposals/daemon-control-via-neon-longpoll.md`.
  startControlRelay();

  // Graceful-exit beacon: flip the key offline immediately on Ctrl-C /
  // termination instead of waiting for the presence-staleness window.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void reportControlInactive().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

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
      // The daemon serves ONLY /v1/* locally now — control comes via the
      // cloud relay, not a browser→loopback call.
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  // Single line to stdout so the install-time launcher can confirm boot.
  process.stdout.write(
    `openllmd v${DAEMON_VERSION}${isDevMode() ? " (dev)" : ""} listening on http://127.0.0.1:${port}\n`,
  );
  logInfo("boot", `openllmd v${DAEMON_VERSION} listening on :${port}`);
};

/**
 * `openllmd set-token <provider> <sk-ant-oat01-…>` — persist an on-box
 * subscription setup-token for a delegate (Claude Code today), then exit.
 * The on-box delivery path (docs/proposals/daemon-auth-loopback-forwarding.md
 * §7.4 b): the user mints the token in their own browser (`claude
 * setup-token`) and sets it here — it never transits the cloud. Run with an
 * empty/absent token to clear it. `argv` is scanned (not indexed) so it works
 * both from source (`bun src/main.ts set-token …`) and the compiled binary.
 */
const runSetTokenSubcommand = (): boolean => {
  const i = process.argv.indexOf("set-token");
  if (i === -1) return false;
  const provider = process.argv[i + 1];
  const token = process.argv[i + 2] ?? null;
  if (provider === undefined || provider.length === 0) {
    process.stderr.write("usage: openllmd set-token <provider> <token>\n");
    process.exit(2);
  }
  if (!setSetupToken(provider, token)) {
    process.stderr.write(
      "refused: that doesn't look like a setup token (expected sk-ant-oat01-…)\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `setup token ${token !== null && token.length > 0 ? "saved" : "cleared"} for ${provider}\n`,
  );
  process.exit(0);
};

if (!runSetTokenSubcommand()) void main();
