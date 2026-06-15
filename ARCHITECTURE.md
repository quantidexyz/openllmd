# `packages/daemon` Architecture

> The headless **local daemon** — a source-free compiled binary (coreless:
> built from `@quantidexyz/openllmw` + `@quantidexyz/openllmp`, NOT `@openllm/core`) that
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

Subscription-OAuth providers (`claude_code`, `chatgpt`, `kimi_code`)
cannot be served by the hosted gateway without (T1) putting a third party
in the credential path and (T2) forging a CLI identity. The daemon moves
that data plane onto the user's machine and **delegates to the official
vendor CLI** for each provider, clearing both triggers. API-key (BYOK)
providers keep running on the cloud unchanged.

## Dependency boundary (load-bearing)

The daemon links **only** `@quantidexyz/openllmw`, `@quantidexyz/openllmp`, and
`effect` — it is **`@openllm/core`-free** (the §7.5 cut-over is done: the
core-backed `dispatch.ts`/`encode.ts` are deleted and the walker is the
sole data path). `@quantidexyz/openllmw` is the dependency-light package of pure
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
  scripts/install-local.ts  build host binary + install locally (no release)
  src/
    main.ts                 boot: runCli() dispatch, else refresh bootstrap → Bun.serve(127.0.0.1)
    cli.ts                  `openllmd <cmd>` dispatch (start/stop/status/restart/skill/plugin/setup/auto-update/uninstall/set-token/completion/help)
    auto-update-pref.ts     persisted self-update opt-out flag (`~/.openllm/auto-update`, default ON); gates self-update.ts + reported on DaemonStatus.auto_update
    integrations.ts         shared executor: fetch a gateway install/uninstall script → verify SHA-256 (fail-closed) → bash. Behind the CLI verbs + the relay's install/uninstall_integration kinds
    integrations-detect.ts  best-effort claude-code footprint scan → DaemonStatus.integrations (stateful dashboard buttons)
    service.ts              self-managed launch agent / systemd unit (start = self-restore; stop = disable; serviceUninstall = stop + delete registration)
    uninstall.ts            `openllmd uninstall` — confirm → stop+unregister → strip completion + owned PATH symlink → delete all state (credentials)
    completion.ts           bash/zsh/fish shell completion (emit + `completion install` / `uninstallCompletion`)
    harden-binary.ts        macOS dequarantine + ad-hoc sign (shared by service + self-update)
    sandbox/
      working-set.ts        the daemon's filesystem allow-list — ONE source consumed by every sandbox backend
      landlock.ts           cross-platform applyDaemonSandbox() dispatcher + the Linux Landlock backend (bun:ffi, inherited by children)
      seatbelt.ts           macOS Seatbelt backend — in-process sandbox_init() deny-by-default profile (bun:ffi, inherited by children)
    listener.ts             /v1/* inference: parse → validate → runWalker (the only path)
    walker.ts               coreless §3.3 plan-walker — the daemon's sole data path; @openllm/core-free
    control.ts              localhost control surface (/status,/events,/connect,/cli-install,/usage,/config)
    status.ts               computeStatus() — shared snapshot for /status + /events
    usage-cache.ts          per-provider TTL cache over delegate.usage() (rate-limit safe)
    events.ts               /events SSE: push status on change (replaces polling)
    cors.ts                 shared CORS + PNA preflight for both surfaces
    cli-paths.ts            isolated-CLI paths + per-provider run/install env
    cli-install.ts          install the daemon's own isolated vendor CLIs
    cloud-client.ts         sk-llm-authed cloud calls (bootstrap + record + web_search callback)
    config.ts               cached bootstrap snapshot (catalog + fallback config); @openllm/core-free
    forward.ts              forward an API-key hop in a mixed chain to the cloud /v1/*
    record.ts/version/env   request recording, version, env (+ env-file loader)
    delegation/             isolated-CLI delegates per provider
      types.ts              TProviderDelegate contract
      auth-config.ts        per-provider `config.json` sidecar: capture the real CLI
                            exec request's upstream URL (drift-safe) + CLI meta, and
                            extract Claude's + Codex's OAuth client_id + token URL
                            from the binary. Feeds the request TARGET + token refresh
                            — NOT inference identity (the originator's headers do that)
      claude-code.ts chatgpt.ts kimi-code.ts util.ts index.ts
```

## Integration triggers (skill / plugin / setup install + uninstall)

The daemon can install/uninstall any catalogued **skill**, **plugin**, or
**setup** on its own machine, two ways through ONE executor
(`integrations.ts`, coreless — `fetch` + `Bun.spawn`):

- **CLI:** `openllmd {skill|plugin|setup} <install|uninstall|list> [slug]` —
  foreground one-shot (no server boot), completion-derived from `commands.ts`.
- **Relay:** the dashboard's "Install with the daemon" button enqueues an
  `install_integration` / `uninstall_integration` command (via the existing
  `POST /api/daemon/cmd` → poll), dispatched in `control-relay.ts`.

`runIntegration` fetches the gateway's EXISTING
`/api/<area>/<slug>/<action>.sh` (so no install logic is forked onto the box —
the script already encapsulates the per-target footprint) and pipes it to
`bash` with `OPENLLM_API_KEY` in its env. **Fail-closed integrity:** before any
execution it fetches the gateway's separately-served SHA-256
(`/api/daemon/integrity`), refuses on mismatch / missing digest, and places the
key into the executed env ONLY after verification — mirroring the binary
checksum gate in `packages/setup/daemon/install.sh`.

`integrations-detect.ts` scans the claude-code footprint
(`~/.claude/skills|plugins/<slug>/`, the `settings.json` / codex / kimi config
markers) and reports it on `DaemonStatus.integrations`, so the dashboard renders
a stateful Install vs ✓ installed / Uninstall button. See
[`docs/proposals/daemon-integration-triggers.md`](../../docs/proposals/daemon-integration-triggers.md).

## Coreless walker (the data path)

`walker.ts` is the thin `@openllm/core`-free executor of the coreless
proposal's §3.3 — the daemon's **sole** data path. Every `/v1/*` request
carries the cloud's `?__plan=<provider/model,…>` (off the 307 — see
[`coreless-daemon-passthrough.md`](../../docs/proposals/coreless-daemon-passthrough.md));
`listener.ts` validates the body and hands the plan to the walker. (No
`?__plan=` is a misuse of the daemon surface → clean 400; clients reach it
only via the gateway's 307.) The walker makes **zero** routing decisions —
the cloud already resolved the alias + cooldowns — it walks the ordered
plan, serving each subscription hop locally (delegate credential injected,
vendor called directly) and forwarding each API-key hop to the cloud
(`forward.ts`, pinned), classifying pre-stream errors with a ~10-line
`retryable()` and committing on first byte.

**Serves all three subscription providers + cross-wire** (§9(a)) — a tiny
per-hop mini-runner built from the `@quantidexyz/openllmw` transforms:

| Provider | Upstream wire | Anthropic-wire client | OpenAI-wire client |
| --- | --- | --- | --- |
| `claude_code` | anthropic | **passthrough** (verbatim) | `toAnthropicRequest` → decode/re-encode |
| `chatgpt` | Codex/Responses | `toChatGptRequest` → decode → Anthropic SSE | `toChatGptRequest` → decode → OpenAI SSE |
| `kimi_code` | openai | canonical re-encode | **passthrough** (verbatim) |

The REQUEST side — body + wire-derived headers for every `(client wire ×
upstream wire)` cell, including the passthrough-vs-transform decision and
the Anthropic adaptive-thinking / `anthropic-beta` handling — is NOT
open-coded here. The walker calls
[`buildUpstreamRequest`](../wire/providers/upstream-request.ts) from
`@quantidexyz/openllmw`, the **single** recipe the cloud runner also calls. This is
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
`@quantidexyz/openllmw/lib/forwarded-headers` `originatorHeadersFrom`), with the
delegate's CREDENTIAL-INTRINSIC headers (codex `chatgpt-account-id` — the
user's own account; none for claude/kimi) + the refreshed bearer layered on
top. Wire-derived headers (anthropic-version/-beta/content-type) are layered
last by the builder. The daemon forges NO CLI identity — a genuine vendor-CLI
request reaches the vendor with its own headers, and an unsupported one is
rejected upstream (terms compliance, see "Originator passthrough" below). On the RESPONSE
side the walker decodes the upstream SSE/JSON to canonical chunks
(`@quantidexyz/openllmw/lib/streaming/provider-decode` — the `@openllm/core`-free
analogue of `providerEventStream`) and re-encodes to the client wire
(`chunksToMessagesSseBytes` for Anthropic clients, `chunksToSseBytes` for
OpenAI clients). `canWalkPlan` decides up front for the whole plan
(declining only an unknown subscription provider with no upstream), so a
chain is never half-attempted then bailed.

> **Standing rule.** `@quantidexyz/openllmw` owns wire transforms **and their
> composition** (the request recipe + the response decode/encode). The
> cloud runner and this walker are thin callers — neither re-derives the
> recipe. A new provider/wire pairing is added in `upstream-request.ts`
> once, not in two places.

**web_search (§5).** When a request declares the openllm `web_search`
function tool on a TRANSFORM path (every wire combo but the
Anthropic→Anthropic passthrough, where the native server tool forwards
verbatim + Anthropic runs it), the walker runs the agentic loop: call the
vendor accumulated, and for each `web_search` tool call POST ONLY the query
to `POST /api/daemon/search` (the cloud recovers the DEK from the daemon's
key + runs the user's vault search credential), append the results as a
follow-up turn, re-call — bounded to 4 rounds. Only the query leaves the
box. Non-stream messages responses get the native `server_tool_use` /
`web_search_tool_result` blocks spliced in for Claude Code's parser.

**Cost is computed cloud-side.** The daemon reports only TOKEN COUNTS in
its metadata row (`POST /api/daemon/requests`); the cloud's
`daemonRecordHandler` recomputes `cost_usd` from those tokens (the single
pricing source of truth — no pricing table is shipped to the box, and
`cost_usd` is not even on the daemon→cloud wire). Token counts are accurate
for streaming too: the walker tees the canonical-chunk stream and
accumulates usage off one branch while the client reads the other.

**Validated live** (`RUN_DAEMON_LIVE=1`, `tests/server/daemon-walker-live
.e2e.test.ts`) against the real authenticated CLIs, through the full
production flow (client → cloud → signed 307 → walker → vendor): all three
providers + cross-wire, stream + non-stream, the web_search loop, and the
forged-signature → 403 gate. The remaining §8 byte-identical-upstream diff
is a belt-and-braces confidence check, not a ship gate.

## Two localhost surfaces

`Bun.serve` on `127.0.0.1:<port>` (default 8787) routes by path:

- **`/v1/*` — inference.** Mirrors the cloud's OpenAI/Anthropic surface.
  `listener.ts` parses → `dispatch.runLocalDispatch` resolves the user's
  fallback chain (from the cloud-pulled config) and runs `CoreLive` →
  `encode.encodeDispatchResult` streams back and fire-and-forget POSTs a
  metadata-only row to the cloud. Subscription hops use the delegate's
  credential; an API-key hop inside a mixed chain is forwarded to the
  cloud (`forward.ts`) rather than decrypted locally.
- **Control surface** — called DIRECTLY by the dashboard browser. Reads
  (`GET /status`, `GET /events`, `GET /usage/:slug`) and writes
  (`POST /config/api-key`, `POST /cli-install/:slug`,
  `POST /connect/:slug`) are served to the dashboard origin. Access control is the localhost bind + the CORS
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
`OPENLLM_API_KEY` in `~/.openllm/daemon.env` (`0600`) — the single config
file — so it
survives restarts / HMR, and re-bootstraps in-request so a valid key
flips `cloud_state` to `ok` immediately. Until a key is set the daemon
runs and serves its control surface so the dashboard can set one. The
bootstrap poll uses a short retry interval until `cloud_state === "ok"`,
then relaxes to the 5-minute TTL — so a just-set key (or a `next dev`
that just finished compiling) is picked up within seconds. This also
makes dev fast: `bun run dev` boots the daemon keyless and you set a key
once from the UI.

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
  env: `HOME` pointed at the isolated home for all three (which also
  redirects Claude's installer), plus the explicit install-dir + home
  knobs each vendor script honors — `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`+`CODEX_INSTALL_DIR`, `KIMI_CODE_HOME`+`KIMI_INSTALL_DIR`
  (+ PATH-edit suppression so the installer never touches the user's
  shell rc files). Every spawn (`spawnLogin`/`runCapture`/`cliVersion`)
  merges `cliEnv(slug)`; every store read derives from `cliConfigDir`, so
  the read location and the run location can't drift.
- **`cli-install.ts`** — `installCli(provider)` pipes the official vendor
  script (`claude.ai/install.sh`, `chatgpt.com/codex/install.sh`,
  `code.kimi.com/kimi-code/install.sh`) through a shell with `cliEnv`
  merged. Idempotent (skips when the binary is already present).
  `cliInstallState(provider)` → `{ installed, version }` from the
  isolated binary's `--version`.

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
  below is **kernel-enforced on Linux AND macOS**, not just env-redirected.
  `sandbox/working-set.ts` derives ONE allow-list from `env.ts`/`cli-paths.ts`
  (the state dir — which contains the binary, CLI homes, and logs — plus the
  claude-code integration footprint `~/.claude`/`~/.claude.json` read-write;
  system trees read-only; everything else, notably `~/.ssh`/`~/.aws`/the
  user's real CLI homes, implicitly denied). `applyDaemonSandbox()`
  (`sandbox/landlock.ts`) dispatches by platform to one of two in-process,
  unprivileged, self-applied backends — both applied in `main()` before the
  listener binds, both inherited across `execve` (so `bash` running a SHA-gated
  integration script, `curl`, and the vendor CLIs are confined too):
  - **Linux → Landlock** (`sandbox/landlock.ts`) — a deny-by-default Landlock
    ruleset over the working set (kernel ≥ 5.13, `bun:ffi` → `syscall(2)`).
    Landlock is file-only, so non-file ops are untouched; `/dev` is in the
    working set because every `Bun.spawn` with `stdout:"ignore"` opens
    `/dev/null` (without it `posix_spawn` of `bash`/the vendor CLIs fails
    `EACCES` and connect/integrations silently break).
  - **macOS → Seatbelt** (`sandbox/seatbelt.ts`) — an SBPL profile applied via
    `sandbox_init()` (`bun:ffi` → `libsandbox`), deprecated-but-functional, no
    Developer ID signing (App Sandbox is Phase C). It is **asymmetric**, because
    macOS forces it: WRITES are a deny-by-default whitelist (working set +
    workflow targets only — strong tamper guard), but READS are allow-default
    with a credential deny-list (`~/.ssh`, `~/.aws`, `~/Library/Keychains`,
    browser data). A read-whitelist isn't viable — a spawned child's dyld needs
    broad read at `exec` (which `sandbox-exec` grants implicitly but a raw
    `sandbox_init` profile can't), so it SIGABRTs every child. Non-file ops stay
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
  silent). Kill switch `OPENLLM_DAEMON_NO_SANDBOX=1`; dev source runs opt in
  via `OPENLLM_DAEMON_SANDBOX=1`. CLI verbs run unconfined (service
  registration/uninstall touch paths outside the working set).

## Delegation (the compliance core)

Each `TProviderDelegate` wraps the daemon's isolated CLI: `detect`
(`cliInstallState`), `connect` (trigger the CLI's native login under the
isolated env), `usage` (read locally with the CLI's own credential), and
`credentialForUpstream` (bearer + only the credential-intrinsic headers, e.g.
codex's account id + the captured upstream URL — the local runner adds the
ORIGINATOR's headers and the wire-derived ones). Nothing the delegate reads from
a CLI's store is ever sent off-box.

**Usage reads go through a TTL cache, not live (`usage-cache.ts`).**
`computeStatus()` runs on every status push — every control-relay poll (~30s)
and every ~2.5s while a background flow is in flight — but the vendor usage
endpoints (e.g. Claude's `api/oauth/usage`) rate-limit **independently of
inference**. Reading them live there 429s after ~5 minutes while inference keeps
working. `cachedUsage(slug, () => delegate.usage())` hits the vendor at most
once per few minutes (the quota windows are 5h/7d, so minute-level staleness is
irrelevant), shares one in-flight fetch across concurrent callers, and serves
the last good snapshot when a refresh fails (rather than flapping the card to an
error) until it ages out. So the usage panel no longer couples to the push
cadence.

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
[`@quantidexyz/openllmw/lib/forwarded-headers`](../wire/lib/forwarded-headers.ts) (two
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

**OAuth refresh config is extracted too (`auth-config.ts`).** Refreshing a
Claude Pro/Max OR Codex/ChatGPT token needs the OAuth `client_id` + token
endpoint — the vendor's, baked into the CLI binary, and also drift-prone. Rather
than hand-copy them, `oauthConfig(provider)` scans the installed CLI binary:
Claude's JS bundle exposes an embedded prod config block
(`TOKEN_URL:"…/v1/oauth/token" … CLIENT_ID:"<uuid>"`, anchored on the prod host
so a local/staging dev block can't be picked up); Codex's Rust binary packs
`REFRESH_TOKEN_URL` + `CLIENT_ID` as separator-less literals (matched at exact
length + most-frequent pick). A per-provider format guard rejects a
mis-extracted value. **No hardcoded fallback** (for compliance — a stale literal
is exactly the drift that bit us): `oauthConfig` serves the freshly-extracted
value or the last successfully-extracted one cached in `config.ts`, else `null`
→ the delegate skips refresh (the stale access token then surfaces the vendor's
own 401 → re-login), never a hardcoded credential. No value is secret (a public
app id + a published URL) and the binary read stays on-box. The CLI version is
attached as the `user-agent` on the refresh POST (the one call the daemon
legitimately makes AS the CLI — CLI meta, used ONLY for refresh).

Both the captured URL + the extracted OAuth config (+ `cli_version` and per-part
TTL timestamps) persist to ONE consolidated per-provider `config.json` sidecar
(`<cliRoot>/config.json`, plain JSON). Each part is version-keyed with its own
24h TTL, re-captured / re-extracted on a CLI version bump or after a re-login
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
  `set-key-partition-list` after login keeps reads prompt-free. See
  `delegation/util.ts`.
- **chatgpt** — `codex login`; token at `<CODEX_HOME>/auth.json`.
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
  URL; no terminal, no TUI.

The dashboard's `/providers` OAuth tab drives a 3-state flow off
`/status`'s per-provider `cli_installed` + `connected`: **Install** the
isolated CLI → **Connect** (sign in) → connected (usage panel).

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
`PATH` as `openllmd`, writes the single config file `~/.openllm/daemon.env`
(`0600`) with `OPENLLM_CLOUD_ORIGIN` + `OPENLLM_DAEMON_PORT` +
`OPENLLM_API_KEY` (the daemon mints `OPENLLM_DEVICE_ID` into the same file
on first boot; legacy standalone `api-key` / `device-id` files from older
installs are migrated into daemon.env and removed), then hands off to
`openllmd start`. That one file is what both the installed service
(systemd `EnvironmentFile=` / the macOS launch agent's
`OPENLLM_DAEMON_ENV_FILE`) and `bun dev:daemon` boot from.

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

**Local install without a release.** `scripts/install-local.ts` (run via
`bun run daemon:install` from the repo root, or `daemon:uninstall` to
reverse) compiles the host binary, drops it under `~/.openllm/bin/openllmd`,
symlinks it onto `PATH`, and hands off to `openllmd start` — the same flow
`install.sh` runs, but from source. `OPENLLM_CLOUD_ORIGIN=… bun run
daemon:install` bakes a dev cloud origin in.

## Layering rules

- Depends only on `core` + `schema` + `effect`. No db/vault/vercel/next.
- Holds no DEK; never decrypts a vault credential.
- Never transmits a subscription token or CLI-store contents off-box;
  cloud-bound payloads are metadata only.
