# `packages/daemon` Architecture

> The headless **local daemon** — a source-free compiled binary (coreless:
> built from `@openllmsh/wire` + `@openllmsh/protocol` + `@openllmsh/tunnel`, NOT
> `@openllm/core`) that
> runs the **subscription** data plane on the user's
> machine. It delegates to the official vendor CLIs' own credentials +
> identity (never minting, storing, or forging a subscription token),
> records request metadata to the cloud, and is driven by the openllm.sh
> dashboard directly over a localhost control surface.
>
> Compliance rationale lives in
> [`docs/proposals/subscription-oauth-terms-compliance.md`](../../docs/proposals/subscription-oauth-terms-compliance.md).
> Referenced from the root [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

---

## Why this package exists

Subscription-OAuth providers (`claude_code`, `chatgpt`, `kimi_code`, and
`grok`) cannot be served by the hosted gateway without (T1) putting a third
party in the credential path and (T2) forging a CLI identity. The daemon
moves that data plane onto the user's machine and **delegates to the official
vendor CLI** for each provider, clearing both triggers. It also owns the
`cursor-agent` CLI's login, status, usage, and model discovery; Cursor
inference uses its ACP bridge rather than a manual upstream HTTP transport.
API-key (BYOK) providers keep running on the cloud unchanged.

## Dependency boundary (load-bearing)

The daemon links `@openllmsh/wire`, `@openllmsh/protocol`, `@openllmsh/tunnel`,
and `effect` — it is **`@openllm/core`-free** (the §7.5 cut-over is done: the
core-backed `dispatch.ts`/`encode.ts` are deleted and the walker is the
sole data path). `@openllmsh/wire` is the dependency-light package of pure
wire-format transforms extracted from `core` (request/response/streaming
adapters, the per-provider transforms, SSE decode/encode + accumulate);
see
[`coreless-daemon-passthrough.md`](../../docs/proposals/coreless-daemon-passthrough.md).
A static invariant test
(`tests/deployment/daemon-walker-coreless.test.ts`) asserts no daemon
source imports `@openllm/core`. It must NOT link
`@openllm/api`, `@openllm/db`, `@openllm/vault`,
`drizzle`, `@neondatabase/serverless`, `@vercel/functions`, or `next` —
those are cloud-only. The daemon holds **no DEK and decrypts no vault
credential**; its only secret is the user's `sk-llm-...` key (for cloud
control-plane calls). Catalog + routing config are **pulled from the
cloud at runtime** (not compiled in) to keep the closure clean.

## Modules

```
daemon/
  index.ts                  re-exports
  scripts/compile.ts        bun build --compile --minify --bytecode (4 targets)
  scripts/verify.ts         download each published binary → sha256 → assert == manifest.ts pin (bun run verify)
  scripts/dist.ts           compile + emit a self-contained installer per target (daemon:dist)
  scripts/dist-install.ts   run an emitted installer by target on this host (daemon:dist:install)
  src/
    main.ts                 boot: runCli() dispatch, else refresh bootstrap → Bun.serve(127.0.0.1)
    cli.ts                  `openllmd <cmd>` dispatch (start/stop/status/restart/skill/plugin/setup/auto-update/uninstall/set-token/completion/help)
    auto-update-pref.ts     self-update opt-out flag in the shared .env (`OPENLLM_DAEMON_AUTO_UPDATE`, default ON; legacy `~/.openllm/auto-update` file migrated in); gates self-update.ts + reported on DaemonStatus.auto_update
    integrations.ts         shared executor: fetch a gateway install.sh (mode=install|uninstall|state) → verify SHA-256 (fail-closed) → bash. Behind the CLI verbs + the relay's install/uninstall_integration kinds
    device-state.ts         manifest-driven probe: run each integration's `install.sh?mode=state` (`{"installed":bool,…}`) → cached DaemonStatus.integrations (stateful dashboard buttons)
    service.ts              self-managed launch agent / systemd unit (start = self-restore; stop = disable; serviceUninstall = stop + delete registration)
    uninstall.ts            `openllmd uninstall` — confirm → stop+unregister → strip completion + owned PATH symlink → delete all state (credentials)
    completion.ts           bash/zsh/fish shell completion (emit + `completion install` / `uninstallCompletion`)
    harden-binary.ts        macOS dequarantine + ad-hoc sign (shared by service + self-update)
    sandbox/
      working-set.ts        the daemon's filesystem allow-list — ONE source consumed by every sandbox backend
      landlock.ts           cross-platform applyDaemonSandbox() dispatcher + the Linux Landlock backend (bun:ffi, inherited by children)
      seatbelt.ts           macOS Seatbelt backend — in-process sandbox_init() deny-by-default profile (bun:ffi, inherited by children)
      exec.ts               per-child sandboxing — sandboxSpawnArgs() wrap + the --sandbox-exec shim verb + the boot capability probe
    listener.ts             /v1/* inference: parse → validate → runWalker (the only path)
    walker.ts               coreless §3.3 plan-walker — the daemon's sole data path; @openllm/core-free
    sub-method.ts           per-provider execution-method table (bridge|handrolled) + per-hop selection
                            of the cloud's bootstrap-published ACTIVE_SUB_METHOD preference — a
                            `handrolled` selection never probes/spawns the native bridge
                            (docs/proposals/active-sub-method.md)
    plan-cache.ts           flag-gated signed-plan cache (bootstrap `plan_cache`, cloud default ON,
                            DAEMON_PLAN_CACHE=0 disables): a direct plan-less /v1/* request replays
                            the last cloud-signed tuple for its alias within a short TTL —
                            signature still verified per request
    client-encode.ts        client-wire encoders + the SHARED DELIVERY TAIL both execution methods
                            end in (deliverChunkStream: tee → meter → encode + heartbeat;
                            deliverJsonResponse; sseResponseForClient for pre-metered turns)
    control.ts              localhost control surface (/status,/events,/connect,/usage,/config)
    control-channel.ts      outbound relay WebSocket (partysocket) — hello/status/ack frames, heartbeat, and migrateIfRelayMoved (bootstrap-tick channel re-fetch: reconnect when a deploy moved the relay to a new content-addressed box)
    status.ts               computeStatus() — shared snapshot for relay status_push (cheap local store/metadata; not token refresh)
    usage-cache.ts          per-provider TTL cache over delegate.usage() (rate-limit safe)
    model-report.ts         demand-driven live catalog POST: login/`refresh_models` via listModels; auto/`refresh_models_due` via discoverModels — never idle bootstrap
    events.ts               /events SSE: push status on change (replaces polling)
    cors.ts                 shared CORS + PNA preflight for both surfaces
    cli-paths.ts            isolated-CLI paths + per-provider run env
    cli-install.ts          link the isolated run-view symlink + probe state (the daemon NEVER installs a vendor CLI — installs are user-run, unsandboxed, via the daemon install script; cliInstallState auto-links lazily)
    cloud-client.ts         sk-llm-authed cloud calls (bootstrap + record)
    config.ts               cached bootstrap snapshot (catalog + fallback config); @openllm/core-free
    forward.ts              forward an API-key hop in a mixed chain to the cloud /v1/*
    mux-host.ts             mux2/rtc1 channel negotiation, relay duplex ownership, and OPEN dispatch
    session-core.ts         transport-neutral PTY state machine: fan-out output, merged input, bounded per-consumer queues, and detached-idle reaping
    session-host.ts         durable session-host registry/status adapter and boot reconciler; never owns a daemon PTY
    session-host-proc/      detached per-session host: owns one durable PTY, scrollback, idle reaping, meta.json, and ctl.sock
    rtc-host.ts             werift RTCPeerConnection answerer: browser or fleet rtc_offer/answer/ice/nack + mux over data channel
    rtc-client.ts           fleet WebRTC offerer: rtc_offer/answer/ice/nack + mux over data channel
    tunnel-client.ts        consuming subscription tunnel: RTC (when open) → relay binary mux only (no JSON splice)
    tunnel-server.ts        serving in-process tunneled request dispatch for mux streams
    image-walker.ts         locally delegated image generation + cloud media-library upload
    video-walker.ts         locally delegated video operations + cloud media-library upload
    version.ts/env.ts       version metadata and environment-file loader
    delegation/             isolated-CLI delegates per provider
      types.ts              TProviderDelegate contract
      auth-config.ts        per-provider `config.json` sidecar: capture the real CLI
                            exec request's upstream URL (drift-safe) + CLI meta. Feeds
                            the request TARGET — NOT inference identity (the originator's
                            headers do that)
      claude-code.ts chatgpt.ts kimi-code.ts grok.ts cursor.ts
      observation-cache.ts  metadata-keyed determinate idle status for Claude/Cursor
      util.ts index.ts
```

## Integration triggers (skill / plugin / setup install + uninstall)

The daemon can install/uninstall any catalogued **skill**, **plugin**, or
**setup** on its own machine, two ways through ONE executor
(`integrations.ts`, coreless — `fetch` + `Bun.spawn`):

- **CLI:** `openllmd {skill|plugin|setup} <install|uninstall|list> [slug]` —
  foreground one-shot (no server boot), completion-derived from `commands.ts`.
- **Relay:** the dashboard's "Install with the daemon" button sends an
  `install_integration` / `uninstall_integration` command over the live relay
  control channel; `control-relay.ts` dispatches the typed command. There is no
  cloud command mailbox or polling leg.

`runIntegration` requests the gateway's validated non-executable pointer,
validates its full-commit raw GitHub URL, downloads the script directly into a
mode-0600 daemon temp file with redirects disabled, and hashes the exact bytes
against `script_sha256`. Only then does it add `OPENLLM_API_KEY` for install and
launch `bash <file>` with the requested mode/target. Uninstall/state receive no
key. The script performs its independent embedded self-check before side
effects; the daemon never fetches gateway script bytes or `/api/daemon/integrity`.

`device-state.ts` is catalog-driven: it runs each verified script with `-s`,
parses the single JSON line, and compares its `installed_sha256` with the
current pointer's script SHA to compute `diverged`. The result is cached on
`DaemonStatus.integrations`, so the dashboard renders Install vs installed /
Reinstall / Uninstall. Re-probed after each install/uninstall, not every status
refresh. See
[`docs/proposals/daemon-owned-state-stateless-relay.md`](../../docs/proposals/daemon-owned-state-stateless-relay.md).

## Coreless walker (the data path)

`walker.ts` is the thin `@openllm/core`-free executor of the coreless
proposal's §3.3 — the daemon's **sole** data path. A gateway redirect carries
the cloud-signed `?__plan=<provider/model,…>` (see
[`coreless-daemon-passthrough.md`](../../docs/proposals/coreless-daemon-passthrough.md)).
For a direct local-first request, `listener.ts` first reuses a valid cached
plan or fetches one from the cloud without sending the request body; a pure
BYOK plan, or a failed plan fetch, is forwarded to the cloud. The listener
validates the body and hands a subscription-containing plan to the walker.
The walker makes **zero** routing decisions — the cloud already resolved the
alias + cooldowns — it walks the ordered plan, serving each subscription hop
locally (delegate credential injected, vendor called directly) and forwarding
each API-key hop to the cloud (`forward.ts`, pinned). Every non-abort candidate failure before commitment
walks via the same `@openllmsh/wire/lib/error-class` policy as the cloud;
routing never depends on provider-specific status/message allow-lists. The
walker commits on first output, after which switching models is intentionally
unsafe. On chain exhaustion the final hop's real upstream response is preserved.

**The manual mini-runner serves four subscription providers + cross-wire**
(§9(a)) — it is built from the `@openllmsh/wire` transforms:

| Provider | Upstream wire | Anthropic-wire client | OpenAI-wire client |
| --- | --- | --- | --- |
| `claude_code` | anthropic | **passthrough** (verbatim) | `toAnthropicRequest` → decode/re-encode |
| `chatgpt` | Codex/Responses | `toChatGptRequest` → decode → Anthropic SSE | `toChatGptRequest` → decode → OpenAI SSE |
| `kimi_code` | openai | canonical re-encode | **passthrough** (verbatim) |
| `grok` | Responses | `toChatGptRequest` → decode → Anthropic SSE | `toChatGptRequest` → decode → OpenAI SSE |

`cursor` is intentionally absent from this manual-wire table: its official
`cursor-agent acp` bridge is the walker's native-runtime transport, with no
manual upstream HTTP transport to describe here. The same bridge supplies model
discovery.

The REQUEST side — body + wire-derived headers for every `(client wire ×
upstream wire)` cell, including the passthrough-vs-transform decision and
the Anthropic adaptive-thinking / `anthropic-beta` handling — is NOT
open-coded here. The walker calls
[`buildUpstreamRequest`](../wire/providers/upstream-request.ts) from
`@openllmsh/wire`, the **single** recipe the cloud runner also calls. This is
load-bearing: the recipe used to be forked between the cloud's runner and
this walker (which can't share `@openllm/core`), and the two drifted —
dropping the client's `anthropic-beta` and skipping
`normaliseAdaptiveThinking` (→ haiku 400). One builder, two thin callers,
pinned together by `tests/transport/upstream-request-parity.test.ts`. See
[`unified-upstream-request-builder.md`](../../docs/proposals/unified-upstream-request-builder.md).

The walker supplies only what's transport-local: the resolved
`providerModelId`, the client's `stream` intent (the daemon PINS both off
the 307; the cloud passthrough preserves the body's), and `baseHeaders` —
the **ORIGINATOR's own headers** (denylist passthrough via
`@openllmsh/wire/lib/forwarded-headers` `originatorHeadersFrom`), with the
delegate's CREDENTIAL-INTRINSIC headers (codex `chatgpt-account-id` — the
user's own account; none for claude/kimi) + the refreshed bearer layered on
top. Wire-derived headers (anthropic-version/-beta/content-type) are layered
last by the builder. The daemon forges NO CLI identity — a genuine vendor-CLI
request reaches the vendor with its own headers, and an unsupported one is
rejected upstream (terms compliance, see "Originator passthrough" below). On the RESPONSE
side the walker decodes the upstream SSE/JSON to canonical chunks
(`@openllmsh/wire/lib/streaming/provider-decode` — the `@openllm/core`-free
analogue of `providerEventStream`) and re-encodes to the client wire
(`chunksToMessagesSseBytes` for Anthropic clients, `chunksToSseBytes` for
OpenAI clients). `canWalkPlan` decides up front for the whole plan
(declining only an unknown subscription provider with no upstream), so a
chain is never half-attempted then bailed.

> **Standing rule.** `@openllmsh/wire` owns wire transforms **and their
> composition** (the request recipe + the response decode/encode). The
> cloud runner and this walker are thin callers — neither re-derives the
> recipe. A new provider/wire pairing is added in `upstream-request.ts`
> once, not in two places.

**Tool boundary.** The walker does not execute model-emitted function tools or
create hidden follow-up turns. Search-shaped function calls follow ordinary tool
behavior and are returned to the client. Exact Anthropic native server-tool
descriptors remain available only on the byte-verbatim Anthropic passthrough
path. Codex native hops run with PROVIDER-HOSTED web search enabled always-on
via `thread/start.config` (`codex-web-search.ts` — Codex owns execution and
continuation; a client function tool literally named `web_search` is dropped
from `dynamicTools` so the turn has exactly one search owner). Hosted-search
lifecycle items are not yet re-emitted onto client wires; the grounded answer
streams normally. The Claude native runtime still strips tools on the text path
and claims no search support.

**Cost is computed cloud-side.** For inference records, the daemon reports
metadata only — token counts plus model/provider, outcome, latency, endpoint,
and optional account/cache/cooldown fields — to `POST /api/daemon/requests`;
it never records prompt or completion content. The cloud's
`daemonRecordHandler` recomputes `cost_usd` from the tokens (the single pricing
source of truth — no pricing table is shipped to the box, and `cost_usd` is not
on the daemon→cloud record wire). The row carries the prompt-cache split
(`cached_tokens` / `cache_creation_tokens`, both optional so an older daemon
still records) because `tokens_in` INCLUDES those tokens and the cloud prices
them at the cache rates, not the input rate. Token counts are accurate for
streaming too: the walker tees the canonical-chunk stream and accumulates usage
off one branch while the client reads the other. This does not describe the
separate, explicit media-library feature: `image-walker.ts` and
`video-walker.ts` may upload locally generated image/video bytes to
`/api/daemon/media` so the user can retrieve them from the cloud library.

**Validated live** (`RUN_DAEMON_LIVE=1`, `tests/server/daemon-walker-live
.e2e.test.ts`) against the real authenticated CLIs, through the full
production flow (client → cloud → signed 307 → walker → vendor): the core
Claude/Codex/Kimi providers + cross-wire, stream + non-stream, and the
forged-signature → 403 gate. The remaining §8 byte-identical-upstream diff
is a belt-and-braces confidence check, not a ship gate.

**Native runtime path (`src/native-runtime/`).** `claude_code` and `chatgpt`
are served through the OFFICIAL vendor runtime FIRST
(`isNativeRuntimeProvider`), with the MANUAL upstream-HTTP transport (bearer
export + hand-built request + direct `fetch`, still in `UPSTREAM_WIRE`) as the
fallback when the native path declines — see "Native decline → manual
fallback" below. Both paths authenticate + refresh through the CLI via the
delegate. The native bridges:

- `claude_code` → the isolated Claude Code CLI in headless stream-json mode
  (`claude -p --output-format stream-json --include-partial-messages`, under
  `cliEnv("claude_code")`). The runtime owns auth/refresh/identity and the
  upstream request; the daemon never reads the credential store on this
  path. Its `stream_event` lines carry the raw Anthropic SSE events, decoded
  by the SAME `fromAnthropicStreamEvent` the manual wire uses. **Two
  non-obvious requirements** (verified live against the isolated home, both
  load-bearing): (1) NO `--bare` — that flag disables the setting sources
  that carry the Claude subscription credential, so `claude -p --bare`
  reports "Not logged in" even when logged in; `--tools ""` alone gives the
  empty tool set safely. (2) the spawn env INHERITS the full session env
  (macOS keychain access needs it — an `env -i` minimal env breaks the
  credential read) minus the `ANTHROPIC_*` auth-poison keys
  (`cleanNativeSpawnEnv`).
- `chatgpt` → `codex app-server` JSON-RPC over stdio (one child per daemon,
  fresh EPHEMERAL thread per request, `approvalPolicy: "never"` + read-only
  sandbox, under `cliEnv("chatgpt")`). The runtime owns auth.json parsing,
  refresh, endpoint discovery, Codex identity headers, request shape, and
  cache/thread affinity — the manual path's whole private-API surface.
  Usage maps from `thread/tokenUsage/updated` (`total`; cached input stays a
  SUBSET of `tokens_in`).

**Multi-turn via session resume (`session-store.ts`).** OpenLLM is a
STATELESS gateway (the client resends the full history every request); the
native runtimes are STATEFUL agents that only accept the NEW turn. The
session store bridges them the way T3 does: it correlates a conversation to
a provider session and feeds only the delta. Correlation is content-derived
(the gateway carries no session id) — the conversation is keyed by a hash of
its "consumed prefix" (system + turns up to and including the last assistant
turn); the DELTA (the new user turn after it) is fed to the resumed session
(`claude -p --resume <session_id>` / `thread/resume` + `turn/start`). After
the runtime answers, the store re-keys the session under `hash(prefix +
delta + response)` so the NEXT request — which carries exactly those messages
plus its own new user turn — matches and resumes. First turn / unmatched
history (daemon restart, client compaction) starts fresh; an unmatched
mid-conversation join renders the transcript as a lossy seed. State is
daemon-resident (the resume files/threads are daemon-local); in-memory LRU +
TTL, per-conversation lock. Verified live: a follow-up recalled a codeword
set in turn 1 while only the new question was fed.

**Claude tool-passthrough (`claude-tool-session.ts` + `claude-tool-serve.ts`).**
A tool-bearing `claude_code` request (client function tools present) is served
through the `@anthropic-ai/claude-agent-sdk` `query()` in a completion shape,
so a `/v1/*` client that runs its OWN tools can use the subscription. The
client's function tools become in-process SDK MCP tools (`alwaysLoad`, granted
via `canUseTool`); the tool HANDLER PAUSES awaiting the client's result, so the
model's `tool_use` is returned to the client (as OpenAI `tool_calls` /
Anthropic `tool_use`) instead of executed. The live `query()` is held (indexed
by its pending tool-call ids); the client's `tool_result` on the next request
resolves the paused handler and drives the query to its next tool call or final
text. A whole agentic task is ONE held query: the opening user turn starts it,
each tool round-trip continues it. Verified live: `get_weather("Paris")` →
client supplies "21C and sunny" → "The weather in Paris is currently 21°C and
sunny."

**Codex tools (`codex-tool-session.ts`) — NATIVE.** Codex's protocol has a
completion-tool mechanism: `thread/start.dynamicTools` (client function tools,
`inputSchema` = raw JSON) + the server→client `item/tool/call` request (the
app-server asks US to run the tool, we respond with the client's result). The
held-turn orchestrator mirrors the Claude path. A 2026-07-14 live probe (audit
`docs/audit/2026-07-14-codex-upstream-wire-openclaw-comparison.md` §6) settled
the one non-obvious protocol fact: dynamic tools default to Codex **code-mode**
(a `codex-code-mode-host` sidecar the isolated install doesn't ship), so with
code-mode ON `item/tool/call` never reaches the client (once misread as
"0.144.0 doesn't emit it"). Setting `features.code_mode:false` on `thread/start`
routes the call to us and the turn completes. A native decline still falls back
to the MANUAL Codex Responses path (`function_call` for client execution), so a
protocol mismatch degrades to slower, never broken.

Current native scope (`nativeRequestOf`): multi-turn TEXT (system +
user/assistant text) via the CLI resume path; claude_code tool requests take
the SDK tool path. **Native decline → manual fallback.** Anything the native
path declines — images, structured output, chatgpt tools (until Codex
activates), or ANY pre-commit failure — falls through to the MANUAL transport
on the SAME hop (`claude_code` → Anthropic Messages with the OAuth bearer,
`chatgpt` → Codex Responses), so no client workflow is blocked. Auth + refresh
run through the CLI (the delegate's `credentialForUpstream`) on both paths.
Only if the manual transport ALSO fails pre-stream does the walker advance to
the next PLAN hop. Cloud plan signing, model pins, mixed-chain BYOK forwarding,
and metadata-only token reporting are unchanged; the recorder rides the
walker's own `report`. Offline coverage:
`tests/transport/native-runtime.test.ts` (fixture runtimes). See
`docs/audit/2026-07-13-t3code-provider-routing-comparison.md` §5.

## Tunnel transport

Consumer ladder (browser and fleet daemon): **RTC (when open) → relay binary
mux**. The legacy JSON `tunnel_*` / `session_*` splice has been removed — if
neither RTC nor mux is available the hop fails and the walker continues. Mux
peers carry the `mux2` channel-id envelope on every relay binary message
(per-device channels multiplex on one watcher socket). RTC refusals return an
explicit `rtc_nack` (seedgate / overloaded / disabled / not_capable) instead of
silent signaling timeouts. Detail lives in
`@packages/daemon-relay/ARCHITECTURE.md` (relay) and
`@packages/tunnel/ARCHITECTURE.md` (codec / envelope / RTC helpers).

- `mux-host.ts` owns relay duplex/channel state, negotiates `channel_open` /
  `channel_open_ack`, receives mux OPEN frames, and dispatches via
  `serveStream` into `tunnel-server.ts`. Advertises `mux` (wire `mux2`) +
  `rtc1`, and layers `seedgate1` when a device-access pubkey is pinned from
  bootstrap.
- `rtc-host.ts` is the werift RTC answerer for browser or fleet-peer offers:
  same-user `rtc_offer` / `rtc_answer` / `rtc_ice` / `rtc_nack` traverse the
  relay, then the mux runs over the data channel (signaling-only relay;
  payload-cap negotiation; kill-switch / failure-cache fallthrough to mux).
- `rtc-client.ts` is the fleet WebRTC offerer for daemon→daemon tunnels.
  It reuses `rtc-auth`, `rtc-duplex`, and mux; it does not introduce a second
  direct-path or hole-punch transport.
- `tunnel-client.ts` uses the consumer ladder **RTC (when open) → relay binary
  mux** for daemon→daemon fleet hops (mirrors browser `tunnelFetch`).
- `tunnel-server.ts` maps a closed tunnel-surface vocabulary to the daemon's
  in-process `/v1/*` handler and streams the result. Stamps
  `x-openllm-tunneled` **only** when the stream OPEN carries
  `consumer:"daemon"` (fleet hop from another daemon) so the peer walker
  cannot re-tunnel. Browser tunnels omit the stamp so the selected device
  may still `tryFleetTunnel` once (browser→A→B).
- `device-access-verify.ts` verifies vault-signed device grants (node:crypto)
  with ts window + nonce map; browser-only enforcement (daemon fleet hops
  skip grant). Locked-vault consumers fail closed before probing transports.

**Kill-switches.** `OPENLLM_MUX_DISABLE=1` withdraws the mux transport
wholesale — including the terminal sessions that ride it. `OPENLLM_RTC_DISABLE=1`
withdraws only `rtc1`, so the browser never offers, no ICE agent is built, no
UDP leaves the host, and everything still works over relay mux one hop slower.
Reach for the latter on a network where the peer-to-peer path is a liability.

**A remote peer's socket is never fatal.** An ICE agent probes the browser's
candidates over UDP; an unreachable one is answered with ICMP port-unreachable,
which Linux reports as `ECONNREFUSED` on the next receive. `werift` attaches no
`"error"` listener to that socket, so it surfaces as an uncaughtException — and
the daemon used to exit on any of those, turning one dead candidate into a
permanent crash loop (and a remote DoS: anything that makes the daemon send a
datagram to a closed port took it down). `crash-policy.ts` classifies a closed
set of transport errnos as survivable; every other uncaught throw still exits
for the supervisor to restart clean.

### Durable device-session host

A local session is a detached `openllmd __session-host` sibling process, not a
child of the daemon. It owns one vendor-cli PTY, scrollback, multi-attach fan-out,
and the 15-second idle-reap poll. Its private registry is
`~/.openllm/sessions/<id>/`: `meta.json` records the host pid and session
metadata; `ctl.sock` carries the existing open/ctrl/reset/exit Unix-WebSocket
attach envelope. An attach adds a consumer, fans output to independent ordered
write tails, and merges input. A lagging consumer is removed without affecting
the PTY or other consumers.

**Sizing: the PTY fits whoever focused last.** The PTY has one size, so with
several viewers attached one of them — the PRIMARY — decides it, and its
viewport IS the canonical size. Primacy moves on exactly two signals: a `focus`
claim and an explicit `resize`. Both are deliberate acts on a specific viewer.

Input deliberately moves nothing. It used to: the input path re-ran an election
on every keystroke, hedged with a shrink rule, a "did these dims come from a
real resize" flag, and a debounce window. With two viewers attached that
alternated the canonical size as the user typed — re-sizing the PTY and
re-serializing the other viewer mid-keystroke. Every guard was an attempt to
tame a signal that should not have been driving size at all.

The primary is on the raw byte-identical fast path (its size already matches the
PTY). Every other viewer keeps a private `@xterm/headless` emulator at its own
size and is repainted from the shared screen — reflowed for the normal buffer,
letterboxed for the alt buffer, which cannot be reflowed by any mux. Those
repaints are full-screen serializes wrapped in synchronized output (DEC 2026),
emitted only when there is genuinely new output, and only once the emulator has
PARSED it (`xterm` writes are asynchronous — serializing earlier paints the
screen as it was before the chunk).

A terminal has no focus events to forward, so the local attach client claims
focus on its first keystroke after a ≥1s lull; that is what lets a terminal
sharing a session with a browser pane take the size back. When the primary
detaches, the most recently focused survivor inherits it.

The host, rather than the daemon, reaps an unattached session after both output
and process-tree CPU have been idle for `OPENLLM_SESSION_IDLE_TIMEOUT_MIN`
(default 60; `0` disables it): SIGTERM then SIGKILL after 10 seconds. Consequently
a daemon shutdown, fatal exit, update, or crash cannot kill a durable local
session. On boot the daemon reconciles the socket-directory registry: valid
`meta.json` + live host pid + present socket is **adopted** (kept, never
signalled); a dead or incomplete directory is removed.

`mux-host.ts` attaches browser mux session streams to the durable host through
`attachSessionHostViaCli`; `session-host.ts` is now only the durable
registry/status adapter and boot reconciler. There is no legacy JSON
`session_*` relay splice. See
[`durable-session-host.md`](../../docs/proposals/durable-session-host.md) and
[`shared-session-viewing.md`](../../docs/proposals/shared-session-viewing.md).

The session PTY spawn remains deliberately outside the per-child sandbox: it
runs the user's real vendor CLI against the user's real `$HOME`; only its
standalone host owns lifecycle and transport fan-out.

## Two localhost surfaces

`Bun.serve` on `127.0.0.1:<port>` (default 8787; 8788 in dev mode) routes
by path:

- **`/v1/*` — inference.** Mirrors the cloud's OpenAI/Anthropic surface.
  `listener.ts` validates the request, obtains/verifies the cloud-signed plan
  (from the redirect, cache, or local-first plan fetch), then invokes the
  coreless `walker.ts` (or the image/video walkers). The walker serves
  subscription hops with the delegate's credential and forwards an API-key hop
  in a mixed chain to the cloud (`forward.ts`) rather than decrypting it
  locally. It fire-and-forget records inference metadata to the cloud; explicit
  locally generated media may additionally be uploaded to the media library.
- **Control surface** — called DIRECTLY by the dashboard browser. Reads
  (`GET /status`, `GET /events`, `GET /usage/:slug`) and writes
  (`POST /config/api-key`, `POST /connect/:slug`) are served to the
  dashboard origin. Access control is the localhost bind + the CORS
  origin lock (`allowOrigin` reflects the configured dashboard origin and
  its loopback sibling; any loopback origin in dev) — there is no
  separate control token at this stage; revisit if the daemon ever binds
  beyond loopback. All answer the Chrome Private-Network-Access preflight
  (`Access-Control-Allow-Private-Network: true`).

  `GET /status` reports `key_configured` + `cloud_state` (`ok` / `no_key`
  / `invalid_key` / `unreachable`) so the dashboard's Providers tab can
  render its 3-state flow: offline → install command; online + no usable
  key → API-key picker; online + `ok` → provider connect cards.

  **`GET /events` is the live channel** (`events.ts`, SSE). The dashboard
  subscribes once; the daemon pushes a fresh `status` snapshot on
  connect, after every control mutation (`broadcastStatus()`), and when a
  client-gated watcher detects an OUT-OF-BAND change — the case polling
  handled worst, e.g. the user signing into Kimi via its in-terminal
  `/login`. SSE (not WebSocket) so it reuses the same CORS + PNA preflight
  as the rest of the surface; `/status` stays as the initial snapshot +
  SSE-blocked fallback (the dashboard also keeps a slow 30s fallback
  poll). `computeStatus()` (`status.ts`) is the shared snapshot logic.

## API key — set at runtime, not install time

The daemon installs **keyless**. The dashboard authenticates it afterwards
via `POST /config/api-key` — but it does NOT make the user pick/paste a
key: the Providers tab AUTO-PROVISIONS a dedicated daemon key (the browser
mints a fresh `sk-llm` under the unlocked vault, named "OpenLLM Daemon",
and sends the one-time plaintext to localhost — never to the cloud; revoke
it on the Keys page). The daemon still needs this DEK-bearing key for its
cloud control-plane calls AND for forwarding API-key hops — the `?__plan=`
HMAC secures the plan, not the daemon's identity. `env.ts` persists it as
`OPENLLM_API_KEY` in `~/.openllm/.env` (`0600`) — the single config
file — so it
survives restarts / HMR, and re-bootstraps in-request so a valid key
flips `cloud_state` to `ok` immediately. Until a key is set the daemon
runs and serves its control surface so the dashboard can set one. The
bootstrap poll uses a short retry interval until `cloud_state === "ok"`,
then relaxes to the 5-minute TTL — so a just-set key (or a `next dev`
that just finished compiling) is picked up within seconds. This also
makes dev fast: `bun run dev` boots the daemon keyless and you set a key
once from the UI.

**Dev-mode config isolation.** With `OPENLLM_DAEMON_DEV=1` the daemon's
config file is `~/.openllm/.dev.env` (not the shared `.env`), the default
port is `8788`, and the cloud origin defaults to the local Next server —
so a source-run dev daemon coexists with the installed daemon without
clobbering its config. The ONLY dev read of the shared `.env` is a live,
read-only `OPENLLM_API_KEY` fallback when `.dev.env` is keyless (dev
reuses the paired key without forking it); every dev write — key, origin,
minted device id, auto-update pref — lands in `.dev.env`. The dashboard
probes both 8787 and 8788 for `/whoami` (`lib/hooks/use-this-device.ts`).

## Isolated CLIs (install + run)

The daemon does **not** use whatever `claude` / `codex` / `kimi` the user
has on their PATH — that would race with and mutate the user's personal
`~/.claude` / `~/.codex` / `~/.kimi-code` state. Instead it installs and
runs its OWN copy of each CLI under `<stateDir>/cli/<provider>/`
(`stateDir` = `~/.openllm`, overridable via `OPENLLM_DAEMON_STATE_DIR`):

```
~/.openllm/cli/<provider>/
  bin/<binary>     # codex/kimi land here; claude at home/.local/bin/claude
  home/            # the CLI's isolated $HOME + config + credentials
```

- **`cli-paths.ts`** — `cliRoot/cliBin/cliHome/cliConfigDir/cliEnv` per
  provider. `cliEnv` is the single source of truth for the isolation
  env: `HOME` pointed at the isolated home for all providers, plus the
  explicit home knobs each vendor CLI honors — `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `KIMI_CODE_HOME`. Every spawn
  (`spawnLogin`/`runCapture`/`cliVersion`) merges `cliEnv(slug)`; every
  store read derives from `cliConfigDir`, so the read location and the run
  location can't drift.
- **`cli-install.ts`** — the daemon NEVER installs a vendor CLI; installs
  are user-run + unsandboxed (the daemon install script background-runs the
  official installer for any missing CLI, or the user runs it by hand).
  `linkIsolatedCli(provider, hostBin)` points the isolated run-view
  (`<state>/cli/<provider>/…`) at the user's host binary via a symlink (no
  copy). `cliInstallState(provider)` → `{ installed, version }` is the single
  chokepoint every delegate reads: SELF-HEALING — if the isolated symlink is
  missing but the host binary exists (`hostCliCandidates`), it links it before
  probing `--version`, so a newly-installed CLI shows up on the next status
  push with no command.

## OS sandbox + typed control vocabulary (hardening)

Two orthogonal hardenings from
[`docs/proposals/daemon-os-sandbox-and-typed-control.md`](../../docs/proposals/daemon-os-sandbox-and-typed-control.md):

- **Closed command vocabulary (the parse boundary).** `DaemonCommand` /
  `DaemonCmdRequest` (`packages/schema/daemon.ts`) are a **discriminated
  union** — one struct per kind, literal-discriminated, every payload field a
  constrained scalar (provider-slug enum, charset-pinned artifact slug,
  boolean, opaque base64 blob). No field can carry a command string, script
  body, args array, URL, or free filesystem path. An unmodelled command fails
  decode at EVERY boundary: the cloud enqueue (`enqueueCommand` in
  `packages/api/lib/daemon-commands.ts`), the relay's watcher `enqueue` frame
  + delivery push (`packages/daemon-relay`), and the daemon's own relay
  socket (`RelayCommandFrame` embeds the union) — before `runCommandInner`
  ever runs. `control-relay.ts` narrows each `case` from the union (no
  hand-cast). The union ⇔ executor lockstep is machine-checked by
  `tests/deployment/daemon-command-vocabulary.test.ts`.
- **Filesystem confinement (the blast-radius bound).** The path isolation
  below is **kernel-enforced on Linux AND macOS**, not just env-redirected —
  and it is **PER-CHILD**, not process-wide
  (`docs/audits/daemon-sandbox-scoping.md`): the daemon process boots
  UNCONFINED (device-session PTYs must run the user's real CLI over their real
  files), and each risky child argv is wrapped by
  `sandboxSpawnArgs()` (`sandbox/exec.ts`) into the
  `openllmd --sandbox-exec -- <argv…>` self-re-exec shim, which applies
  `applyDaemonSandbox({ force: true })` to itself before running the child
  (inheritance across `execve` does the rest). Wrapped: delegation capture /
  login / keychain spawns, the `open`/`xdg-open` browser launch, and the
  long-lived native runtimes. NOT wrapped: the session-host PTY spawn (the
  exemption), read-only diagnostics (`ps`, `journalctl`/`tail`), and CLI-verb
  paths. `sandbox/working-set.ts` derives ONE allow-list from
  `env.ts`/`cli-paths.ts`
  (the state dir — which contains the binary, CLI homes, and logs — plus the
  claude-code integration footprint `~/.claude`/`~/.claude.json` read-write;
  system trees read-only; everything else, notably `~/.ssh`/`~/.aws`/the
  user's real CLI homes, implicitly denied). `applyDaemonSandbox()`
  (`sandbox/landlock.ts`) dispatches by platform to one of two in-process,
  unprivileged, self-applied backends — applied in the SHIM process, both
  inherited across `execve` (so `bash` running a SHA-gated
  integration script, `curl`, and the vendor CLIs are confined too):
  - **Linux → Landlock** (`sandbox/landlock.ts`) — a deny-by-default Landlock
    ruleset over the working set (kernel ≥ 5.13, `bun:ffi` → `syscall(2)`).
    Landlock is file-only, so non-file ops are untouched; `/dev` is in the
    working set because every `Bun.spawn` with `stdout:"ignore"` opens
    `/dev/null` (without it `posix_spawn` of `bash`/the vendor CLIs fails
    `EACCES` and connect/integrations silently break).
  - **macOS → Seatbelt** (`sandbox/seatbelt.ts`) — an SBPL profile applied via
    `sandbox_init()` (`bun:ffi` → `libsandbox`), deprecated-but-functional, no
    Developer ID signing (App Sandbox is Phase C). BOTH WRITES and READS are
    deny-by-default whitelists (parity with Landlock): WRITES grant only the
    working set + workflow targets (tamper guard); READS stay open OUTSIDE
    `$HOME` — where the dynamic loader's broad `exec`-time read lives and no
    user secret does (`(allow file-read* (require-not (subpath $HOME)))`) — but
    deny-by-default INSIDE `$HOME`, re-allowing only the daemon footprint, so
    `~/.ssh`, `~/.aws`, `~/Library/Keychains`, browser data, and any
    unenumerated `$HOME` secret are unreadable. (The two vendor credential files
    inside the re-allowed config dirs — `~/.codex/auth.json`,
    `~/.claude/.credentials.json` — are re-denied last, SBPL being
    last-match-wins.) The earlier "a read-whitelist SIGABRTs every child" note
    was a too-narrow system-read set, not a hard limit — validated in-process
    (`sandbox_init` + child inheritance, `tests/sandbox`). Non-file ops stay
    allowed so the OAuth-browser + keychain login flows run.

  The **systemd user unit** (`renderUnitHardening()` in `service.ts`) adds a
  defense-in-depth SECCOMP layer ONLY — `NoNewPrivileges`,
  `RestrictAddressFamilies`, `SystemCallFilter=@system-service @sandbox`, etc.
  It deliberately carries no capability/mount directives: a `systemctl --user`
  unit runs unprivileged and can't drop capabilities (`218/CAPABILITIES`) or
  set up mount namespaces, so FS confinement is Landlock's job, not systemd's.
  W^X stays off (`MemoryDenyWriteExecute` is absent — Bun's JIT needs it).

  Posture rides every status push as `DaemonStatus.sandbox`
  (`enforced`/`off`/`unsupported`/`error` — fail-open with a loud log, never
  silent). Under the per-child model it comes from a boot-time CAPABILITY
  probe (`probeSandboxCapability` in `sandbox/exec.ts` — gates + platform +
  Linux Landlock ABI, restricting nothing): `enforced` means "risky children
  are wrapped", not "this process is confined". Kill switch
  `OPENLLM_DAEMON_NO_SANDBOX=1` (children spawn unwrapped); dev source runs
  opt in via `OPENLLM_DAEMON_SANDBOX=1` (wraps via `bun <entry>
  --sandbox-exec`). CLI verbs run unconfined (service registration/uninstall
  touch paths outside the working set).

## Delegation (the compliance core)

Each `TProviderDelegate` wraps the daemon's isolated CLI: `detect`
(`cliInstallState`), `connect` (trigger the CLI's native login under the
isolated env), and `usage` (read locally with the CLI's own credential).
Inference-capable delegates additionally provide `credentialForUpstream`
(bearer + only the credential-intrinsic headers, e.g. Codex's account id + the
captured upstream URL — the local runner adds the ORIGINATOR's headers and the
wire-derived ones). Cursor has no manual credential-to-upstream path; the
walker serves it through the `cursor-agent acp` native-runtime bridge instead.
Nothing a delegate reads from a CLI store is sent off-box as request recording.

**Usage is read ON DEMAND, never polled (`usage-cache.ts`).** The vendor usage
endpoints (e.g. Claude's `api/oauth/usage`) rate-limit **independently of
inference** — reading them on the status-push cadence 429'd them after ~5 min
("Claude usage is rate-limited right now") on a daemon **nobody was even looking
at**. So `computeStatus()` — which runs on every status push (hello/reconnect,
the ~2.5s flow watcher, post-command) — only **peeks** the cache (`peekUsage`,
never a vendor call); it attaches whatever was last fetched, or nothing. The
**only** path that hits the vendor is the `refresh` command (`control-relay.ts`
→ `refreshUsage` in `status.ts`), and its two demand signals are the manual
**"Refresh usage"** button and a **one-shot providers-page mount** for that
device when a connected provider still has no snapshot. Age-out of a cached
snapshot is not a demand signal — `peekUsage` keeps serving the last good
figures stamped `stale`.
`cachedUsage(slug, () => delegate.usage())` still wraps that on-demand read in a
TTL + back-off (at most once per few minutes — the quota windows are 5h/7d, so
minute-level staleness is irrelevant — shared in-flight fetch, last-good
fallback stamped `stale` when a refresh fails) so rapid refreshes or several
dashboards can't hammer the endpoint either.

**Passive status does not refresh tokens or provision vendor config.** File-backed
delegates (`chatgpt`, `kimi_code`, `grok`) derive `status()` from **one** typed
store snapshot (`present` / `absent` / `indeterminate`). They never call
`readToken()` on that path, so a status tick cannot native-refresh, spawn
`codex doctor` / `kimi -p` / `grok models`, fetch `/models`, or write Kimi's
managed `config.toml`. Expired-but-stored credentials stay `connected`; a
read error stays `unknown` (`store_unreadable`) and is not collapsed to
`credential_absent`. `readToken()` remains the demand path for inference and requested
(refresh-capable) `listModels()`. `usage()` is a stored-credential read
(`readStoredToken`) — an expired token yields `unavailable` /
`credential_expired` and does not spawn a native refresh; the next real
request refreshes. Automatic catalog observation uses `discoverModels`
instead and must not call `readToken()`.

**Claude / Cursor idle observations are reused while store identity is stable
(`delegation/observation-cache.ts`).** Reuse is keyed by path + inode + mtime +
size (and on macOS, keychain replacement identity), not a clock TTL. Determinate
connected/absent answers may be reused; unknown/indeterminate, aborted, and
invalidated results are never cached. A producer started before `invalidate`
must not overwrite a newer generation; reuse also requires the store fingerprint
to match from start to end of the probe. Passive macOS reads go through
`observeKeychainReady` / `observeOnly`: an existing chain may be unlocked, but
status must not create, recreate, rename, or mutate ACL/settings/partition-list.
Active `ensureKeychainReady` on login / `readToken` / refresh still repairs.
mtime is not proof the chain is unlocked, and a locked store is not dumped.
Cold, changed, or unknown stores keep bounded guarded probes. Connect/logout,
successful refresh, and credential mutations invalidate the cache. This is
presence metadata, not vendor-validity proof, and does not replace request-time
`readToken`.

**Live model catalogs are demand-driven (`model-report.ts`).** Healthy cloud
bootstrap and the 5-minute (or unhealthy-retry) tick in `main.ts` MUST NOT call
`maybeReportModels` / `listModels` / `discoverModels` / a vendor catalog fetch.
Boot only `observeLoginModelReports()` once (subscribe to auth events — zero
vendor I/O). The local 30m success / 15m failure throttle applies to demand
callers; it is not a background timer. An idle skip never stamps failure
backoff and never POSTs an empty list.

Two listing authorities (do not collapse them):
- **`listModels()`** — refresh-capable. Explicit `refresh_models` and
  successful login may acquire a live token (`readToken`) and native-refresh
  as they always did.
- **`discoverModels({ cliVersion? })`** — auto only. Returns `success` (non-empty
  models), `skipped` (no usable existing credential / cached CLI identity /
  remaining lifetime for a bounded fetch), or `failed` (an HTTP/list attempt
  actually ran). Never renews auth, never probes CLI version, never mints
  device id / repairs keychain / writes vendor config / captures endpoints.
  Uses an existing unexpired store snapshot, observe-only reads, no-capture
  URL resolution, and the cached `cliVersion` (or last-known identity) passed
  in. Missing metadata → `skipped` so a later successful use can retry;
  real fetch failure → `failed` (backoff). Empty vendor lists are `failed`,
  not a wipe.

Discovery still runs:
- **Unscoped force:** control command `refresh_models` (dashboard “Available
  models”). Awaits `maybeReportModels()` with `listModels`. Not cron, not
  `model-lists-sweep`, not `GET /v1/models`, not a cache-read auto-enqueue.
- **Scoped login:** `auth.login.succeeded` only. One slug; `listModels` for that
  provider; last-known CLI version via `peekLastKnownConnection` — does not join
  an in-flight unknown/pending status probe. Connect /
  `connect_device_code` / `submit_login_code` acks do **not** report.
- **Automatic (use-triggered):** `discoverModels` after real provider use and
  on model-management activation, gated by the existing TTL/single-flight.
  Exact command/capability wiring is owned by the scheduler (`refresh_models_due`
  / `control_caps`); auto must never fall back to `listModels`. Cursor auto
  discovery captures **only** advertised `session/new` models from an **actual
  inference** turn — never a standalone ACP client and never an extra
  same-client `cursor/list_available_models` RPC (even while inference is
  active). A generation ticket is taken at request entry; the trusted store
  fingerprint is recorded after native authenticate and before `session/new`;
  a late result from a switched account is dropped.

Cloud cache: `MODEL_CACHE_TTL_MS` (30m) is freshness for cloud/BYOK writers
(`scheduleModelListRefresh` skips fresh rows). `MODEL_CACHE_MAX_AGE_MS` (24h)
still drops `source=cloud` rows to catalog fallback. `source=daemon` rows stay
servable past 24h as last-known fallback (`liveCacheRowIsServable`). An idle
skip never POSTs an empty list. An older CLI must not overwrite a newer
parseable daemon row even after 24h (`shouldSkipDaemonModelWrite` + upsert
`setWhere`; the old 24h write escape hatch is gone). Per-provider failure
isolation and CLI-version invalidation on demand reports are unchanged.

**Originator passthrough (the compliance core, `auth-config.ts`).** The daemon
is a transparent, credential-injecting reverse proxy: each inference request
carries the **originator's own headers** to the vendor (denylist passthrough —
pass everything except a small stable deny set: auth, host, content-*,
accept-encoding, hop-by-hop, `sec-websocket-*`, cookie, the separately-composed
`anthropic-beta`), and the daemon injects ONLY the subscription bearer + the
credential-intrinsic bits the request can't work without — those vary by
provider's binding model:
- **claude_code** — bearer only (the OAuth `anthropic-beta` is wire-derived).
- **chatgpt** — bearer + `chatgpt-account-id` (the user's own account).
- **kimi_code** — bearer + kimi's `x-msh-*` device identity (`x-msh-device-id`
  the daemon registered during kimi's OWN device-code OAuth, + `x-msh-platform`
  / `x-msh-version` / device-name / model / os-version). Kimi's managed endpoint
  BINDS the token to its kimi-code client identity and 403s without the full set
  (confirmed live), so it's credential-intrinsic here — not a forged identity:
  the daemon genuinely holds a kimi-code device credential. (The DESCRIPTIVE
  bits still come from the live `identityHeaders()`; the originator's UA is
  overridden for this hop because kimi requires its own.)

It forges no CLI identity for claude/codex. So a genuine vendor-CLI request (the
real path: Claude Code → `claude_code`) reaches the vendor byte-for-byte, and a
request in a shape/identity the vendor doesn't support is rejected upstream —
which is the correct, compliant outcome (the daemon doesn't launder it). The
denylist is single-sourced with the cloud's allow-list policy in
[`@openllmsh/wire/lib/forwarded-headers`](../wire/lib/forwarded-headers.ts) (two
policies, one home): the cloud is a multi-tenant BYOK proxy that must CURATE
what reaches first-party providers; the local daemon, in front of the user's own
subscription CLI, passes the originator through.

**The upstream URL is captured, not hardcoded (`auth-config.ts`).** The only
thing the daemon still captures is the inference URL — it drifts on CLI updates
(by Claude CLI 2.1.159 the token host had moved `console.anthropic.com` →
`platform.claude.com`; codex's `/responses` host likewise) and can't be
hardcoded. The daemon runs the CLI once in headless `exec` mode (`claude -p`,
`codex exec`, `kimi -p`) pointed at a loopback recorder, reads the exact PATH it
POSTs to, kills it before anything reaches the vendor (zero token cost), and
stores ONLY that URL + the CLI version — never an identity-header set to replay.
`resolveUpstreamUrl` prefers the captured URL and falls back to the retained
ORIGIN + default path per provider.

**Token refresh is the CLI's own job (`delegation/refresh.ts`), on demand.** The
daemon never refreshes a subscription token itself — no `grant_type=refresh_token`
calls, no extracted or hardcoded token endpoint / client id. When a demand path
(`credentialForUpstream`, requested `listModels`, login) calls `readToken`, it
checks the stored access token's expiry and, when it's within the leeway window,
TRIGGERS the official CLI's OWN native refresh: a bounded spawn whose side
effect is the CLI refreshing + persisting its token to its own store. Passive
`status()` and on-demand `usage()` must not take this path — usage reads the
stored token only. Shared refresh producers are not cancelled
because a status observer timed out.
claude → a minimal `claude -p` query (the CLI refreshes mid-request); codex →
`codex doctor` (its websocket-reachability check forces the proactive refresh —
no inference); kimi → a minimal `kimi -p` query under a PTY (subscription model).
The refresher (`makeRefresher`) fires in the BACKGROUND while the token is still
valid — no hot-path stall — and only AWAITS the spawn once the token is
hard-expired ("no latency unless the refresh is close"); single-flight per
provider. A hard-expired refresh that the daemon itself killed (`abandoned` /
`timeout`) or otherwise failed is a **local** miss: the walker cools the hop
`upstream_auth_cooldown` with `refresh_abandoned` / `refresh_failed` *before*
returning the stale token, so the request falls through the chain instead of
spending a 401 to discover it. An expired token inside the failure-backoff
window is the same typed stale (counted in `fallbacks`); a still-valid token
in that window stays `"fresh"` and does not re-spawn. Being the SINGLE
refresher means claude's URL capture stays disabled and the old refresh-token
rotation race is gone. (kimi's device-code LOGIN — which the daemon must drive,
the CLI having only an in-TUI `/login` — keeps its public OAuth
`client_id`/host; that is login infra, not refresh.)

The captured URL (+ `cli_version` and a TTL timestamp) persists to a per-provider
`config.json` sidecar (`<cliRoot>/config.json`, plain JSON), version-keyed with a
24h TTL, re-captured on a CLI version bump or after a re-login
(`ensureAuthConfig({ force })`). See
[`delegation-exec-fixtures.md`](../../docs/proposals/delegation-exec-fixtures.md)
(amended).

Login per provider (the CLI opens the user's browser, the user signs in,
and the CLI completes via its own localhost callback then exits;
`spawnLogin` BLOCKS on that, so `connect` re-reads the store and reports
connected/failed directly — the dashboard's Connect button stays in its
"Signing in…" state for the duration):

- **claude_code** — `claude auth login --claudeai` (the real subcommand;
  NOT the REPL `/login`, which errors "isn't available in this
  environment" when spawned). `claude auth status` (JSON `loggedIn` +
  `authMethod`) is the authoritative connection check. Credential storage
  is platform-split (no file override exists on macOS): **macOS → the
  login Keychain**, **Linux/Windows → `<cliConfigDir>/.credentials.json`**.
  Claude resolves the login keychain by HOME path, so on macOS the daemon
  gives the isolated HOME its OWN keychain — `ensureIsolatedKeychain`
  (create + unlock at `<home>/Library/Keychains/login.keychain-db`, empty
  password, auto-lock off) runs before login, or the credential WRITE
  pops the system "Keychain Not Found" dialog. It deliberately does NOT
  touch `security default-keychain`/`list-keychains` (those mutate the
  live securityd session, polluting the user's real keychain); reads name
  the isolated keychain by explicit path (`readIsolatedKeychain`), and
  `set-key-partition-list` after login keeps reads prompt-free. Passive
  `status()` reuses a determinate observation while keychain/file identity
  is unchanged (`observation-cache.ts`); it uses `observeKeychainReady`
  (unlock-only, no create/repair) and does not call `readToken`. A timed-out
  `claude auth status` returns unknown (`probe_timeout`) without a keychain
  dump/find fallback; a parse failure or definite `loggedIn: false` still
  consults the store. See `delegation/util.ts` and `delegation/keychain.ts`.
- **chatgpt** — `codex login`; token at `<CODEX_HOME>/auth.json`. Passive
  `status()` reads that file once and does not run `codex doctor`.
- **kimi_code** — the Kimi CLI has NO spawnable login (sign-in is the
  in-TUI `/login`, which needs a raw-mode TTY), so the daemon drives
  Kimi's OWN device-code OAuth flow directly — the exact flow the CLI runs
  internally (`packages/oauth`): POST `auth.kimi.com/api/oauth/
  device_authorization` (same public client id) → `open` the
  verification URL (code pre-embedded) → background-poll
  `/api/oauth/token` (grant_type=device_code) → write
  `<KIMI_CODE_HOME>/credentials/kimi-code.json` in the CLI's exact wire
  shape (+ persist `device_id`). The status watcher then flips the card to
  connected (~5s). `connect` returns immediately with the device code /
  URL; no terminal, no TUI. Passive `status()` reads the credential file
  once and does not refresh or provision `config.toml`.
- **grok** — `grok login` (or `grok login --device-auth` for a headless
  device-code flow). Demand-path `readToken` may spawn a bounded `grok models`
  so the CLI can refresh; passive `status()` only reads `auth.json`. The
  isolated run-view points to the user's `grok` executable.
- **cursor** — `cursor-agent login`; its local credential store is checked for
  status/usage (idle status reuses a determinate observation while store
  identity is unchanged). Manual `listModels` may still spawn ACP and call
  `cursor/list_available_models`. Automatic `discoverModels` only reads models
  advertised on `session/new` of a real inference turn (observation age is
  that capture time); generation is ticketed at request entry, the trusted
  store fingerprint is taken after native authenticate and before
  `session/new`, and a late switched-account result is dropped. Logout /
  connect / refresh invalidate via `clearCursorStatusObservationCache`. The
  walker still uses the ACP bridge for native-runtime inference.

The dashboard's `/providers` OAuth tab drives a flow off `/status`'s
per-provider `cli_installed` + `connected`: CLI missing (prompt to re-run
the daemon installer, which background-installs it) → **Connect** (sign in)
→ connected (usage panel). The daemon never installs the CLI itself — it
auto-links its isolated run-view to whatever the user-run installer lands.

> ⚠️ The delegates are **research-derived**. `claude_code` install +
> isolation is validated (binary in the isolated dir; `auth status` reads
> isolated state; user's real `~/.claude` untouched). The macOS
> isolated-keychain mechanism is validated for create→write→read with
> zero pollution of the real keychain, but the live `claude auth login`
> WRITE landing in the isolated keychain (vs the session default) is only
> inferred from the "Keychain Not Found" failure mode — confirm with a
> real browser login. `chatgpt`/`kimi_code` install knobs are confirmed
> from the vendor scripts but the full connect→usage path still wants a
> live pass; each carries `RESEARCH` notes + `⚠️` markers.

## Build + distribution

`scripts/compile.ts` → `bun build --compile --minify --bytecode
--target=bun-<os>-<arch>` for darwin-{arm64,x64} + linux-{x64,arm64} (no
Windows). Compile-time defaults are injected via `--define` GLOBALS
(`__OPENLLM_CLOUD_ORIGIN_DEFAULT__`, `__OPENLLM_DAEMON_VERSION__`) — NOT
`process.env.*`, which would clobber the runtime env read. Distribution is
the `packages/setup/daemon` install target (`includeBundle:false`,
`requires_key:false` so the installer runs with a plain `curl … | bash` —
no key piped in): `install.sh` downloads the binary from
`/api/daemon/binary/<target>` and verifies it against the published
`.sha256` (a checksum sidecar, not a detached signature), symlinks it onto
`PATH` as `openllmd`, writes the shared config file `~/.openllm/.env`
(`0600`) with `OPENLLM_CLOUD_ORIGIN` + `OPENLLM_DAEMON_PORT` +
`OPENLLM_API_KEY` (the daemon mints `OPENLLM_DEVICE_ID` into the same file
on first boot; legacy standalone `api-key` / `device-id` files from older
installs are migrated into the env file and removed), then hands off to
`openllmd start`. That one file is what both the installed service
(systemd `EnvironmentFile=` / the macOS launch agent's
`OPENLLM_DAEMON_ENV_FILE`) and `bun dev:daemon` boot from.

**Anyone can verify a published binary.** `scripts/verify.ts` (`bun run
verify`) downloads each published `openllmd-<target>.gz` straight from the
GitHub Release named in `manifest.ts`, decompresses it, sha256's the
decompressed bytes (what runs), and asserts the digest equals the pin
committed in `manifest.ts` — exiting non-zero on any mismatch. `--host` /
`--target` narrow the set; `--file <path>` / `--installed` hash a local
binary instead of downloading. This is the same digest `install.sh` and
`src/self-update.ts` enforce on download, surfaced as a standalone
source-repo check so the source-available mirror's users can independently
confirm the served artifact matches what the source pins. It is NOT a
reproducible-build check: `--compile --bytecode` is not byte-deterministic,
so a fresh local build won't hash-match — the trust anchor is the committed
manifest plus the published asset, not two identical builds.

**The binary supervises itself.** Service registration is NOT open-coded in
`install.sh` — it lives in `src/service.ts`, exposed as the `openllmd
start|stop|status|restart` CLI (`src/cli.ts`), so the installer and a user
run the exact same code path. `start` writes + enables the launch agent
(`KeepAlive`+`RunAtLoad`) / systemd unit (`Restart=always` + boot start +
linger) in **full self-restore mode** and (re)starts it; `stop` stops it
AND disables all self-restore (launchd `bootout`+`disable`, systemd
`disable --now`) so it stays down until the next `start`. The service runs
`process.execPath`, so a from-source run (`0.0.0-dev`) is refused — only the
compiled binary registers. `openllmd uninstall [--yes]` is the full inverse
of install (`src/uninstall.ts`): after a typed-`yes` confirmation (warning it
deletes credentials), it stops + **unregisters** the service (deletes the
plist / unit, not just `stop`'s disable), strips shell completion, removes the
owned `PATH` symlink, and deletes the entire state dir — leaving the machine
clean. It only ever removes a symlink resolving to our own `bin/openllmd` and
files under the state dir, never an unrelated `openllmd`. `openllmd completion
<bash|zsh|fish|install>` emits/installs shell completion for every subcommand.
The CLI surface is defined once in `src/commands.ts` (consumed by both
`cli.ts`'s help and `completion.ts`). See
[`daemon-self-managing-cli.md`](../../docs/proposals/daemon-self-managing-cli.md).

**Local install without a release.** `scripts/dist.ts` (`bun run daemon:dist`)
compiles all four targets and emits a self-contained installer per target —
the real `packages/setup/daemon/install.sh` embedded verbatim with the
locally-built binary appended, so the produced `openllmd-<target>.install.sh`
replicates the exact production install flow offline. `scripts/dist-install.ts`
(`bun run daemon:dist:install -- <target>`, default: this host) runs the
emitted installer without copying a dist path. Credentials use the same
OpenLLM-prefixed env as the real install — `OPENLLM_CLOUD_ORIGIN` +
`OPENLLM_API_KEY` — and an existing `~/.openllm/.env` is reused when
present (a re-run re-pairs in place; the minted `OPENLLM_DEVICE_ID` is kept).

## Layering rules

- Depends on `wire` + `protocol` + `tunnel` + `effect` (with schema used through
  protocol), never `core`; no db/vault/vercel/next.
- Holds no DEK; never decrypts a vault credential.
- Never transmits a subscription token or CLI-store contents off-box;
  request-recording payloads are metadata only. The separate media-library
  feature may upload locally generated image/video bytes for cloud retrieval.
