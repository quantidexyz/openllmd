/**
 * Native-runtime serve adapter — the walker-facing entry. Decides whether a
 * subscription hop is native-eligible, runs the provider's bridge, and
 * re-encodes the canonical chunk stream onto the client's wire with exactly
 * the walker's own streaming/JSON/metering behavior, so a native-served
 * response is indistinguishable from a manual-served one downstream
 * (dashboard rows included — token counts ride the same recorder).
 *
 * The native path is PRIMARY for `claude_code` / `chatgpt`; the walker's
 * MANUAL transport is the FALLBACK. Returns a `Response` on commit, or
 * `{ declined }` for any pre-commit condition (ineligible request — tools the
 * native path can't serve, images, structured output — or a bridge decline).
 * A decline falls through to the manual transport on the SAME hop; the walker
 * only advances the plan if the manual transport ALSO fails pre-stream.
 * Post-commit the response is final (commit-on-first-byte).
 */

import { randomUUID } from "node:crypto";
import type {
  TChatCompletionChunk,
  TChatCompletionRequest,
  TCooldownReason,
} from "@openllmsh/protocol";
import { declaresAnthropicServerSearchTool } from "@openllmsh/wire/adapters/messages/request";
import { accumulateChunksToResponse } from "@openllmsh/wire/lib/streaming/accumulate";
import { partialUsageFrom } from "@openllmsh/wire/lib/streaming/upstream-error";
import { clientWireOf } from "@openllmsh/wire/providers/upstream-request";
import { cliBin, cliEnv } from "../cli-paths";
import {
  deliverChunkStream,
  deliverJsonResponse,
  isClientHangUp,
} from "../client-encode";
import { planSigningKey } from "../config";
import { errorJson } from "../cors";
import { daemonApiKeyId } from "../env";
import { logDebug, logWarn } from "../logger";
import { runClaudeNative } from "./claude-native";
import type { TToolContinuationIdentity } from "./claude-tool-continuation";
import { hasClientTools, tryServeNativeToolTurn } from "./claude-tool-serve";
import { runCodexNative } from "./codex-app-server";
import { runCursorNative } from "./cursor-acp";
import { cursorRequestOf, jsonInstruction } from "./cursor-request";
import {
  deriveConversation,
  NativeSessionStore,
  nextPrefixHash,
  renderSeed,
} from "./session-store";
import type {
  TNativeRunResult,
  TNativeRuntimeProvider,
  TNativeTokens,
} from "./types";
import {
  isNativeRuntimeProvider,
  nativeRequestOf,
  tokensFromResponse,
  unsupportedNativeControl,
  ZERO_TOKENS,
} from "./types";

/** One conversation→session map per native provider (daemon-resident; the
 *  live resume files/threads are daemon-local, so the map is too). */
const stores: Record<TNativeRuntimeProvider, NativeSessionStore> = {
  claude_code: new NativeSessionStore(),
  chatgpt: new NativeSessionStore(),
  // cursor runs COLD sessions in v1 (`runCursorNative` never yields a
  // resumable id, so this store stays empty); every prior-history turn takes
  // the renderSeed path. TODO(cursor-resume): ACP `session/load` follow-up.
  cursor: new NativeSessionStore(),
};

const toolContinuationEpoch = randomUUID();
const localContinuationSecret = randomUUID();

const toolContinuationIdentity = (): TToolContinuationIdentity => {
  const ownerDaemonKey = daemonApiKeyId() ?? "unpaired";
  return {
    // The bootstrap signing secret is scoped per user. The key id distinguishes
    // devices/keys within that account without putting a user id on the wire.
    subject: ownerDaemonKey,
    ownerDaemonKey,
    ownerDaemonEpoch: toolContinuationEpoch,
    secret: planSigningKey() ?? localContinuationSecret,
  };
};

/**
 * Resume-correlation counters, per provider. INSTRUMENTATION ONLY — nothing
 * branches on these.
 *
 * The session key is derived from a hash of the conversation prefix
 * (`deriveConversation`), not from a vendor session id, so any client-side
 * history edit, compaction, or model switch MISSES and falls back to
 * `renderSeed` — which flattens the whole transcript into a fresh cold
 * session. That fallback is the expensive path (full history re-sent, no
 * vendor-side session memory), and we currently have no visibility into how
 * often it fires. These counters answer that before we invest in a
 * persistent-session redesign.
 *
 *   - `firstTurn`  — no prior assistant turn; a fresh session is CORRECT.
 *   - `resumeHit`  — prior history AND the prefix matched → delta-only feed.
 *   - `resumeMiss` — prior history but NO match → `renderSeed` cold start.
 *
 * The ratio that matters is `resumeMiss / (resumeHit + resumeMiss)`;
 * `firstTurn` is excluded because it isn't a correlation failure.
 */
type TResumeStats = {
  firstTurn: number;
  resumeHit: number;
  resumeMiss: number;
};

const resumeStats: Record<TNativeRuntimeProvider, TResumeStats> = {
  claude_code: { firstTurn: 0, resumeHit: 0, resumeMiss: 0 },
  chatgpt: { firstTurn: 0, resumeHit: 0, resumeMiss: 0 },
  cursor: { firstTurn: 0, resumeHit: 0, resumeMiss: 0 },
};

/** Snapshot the resume-correlation counters (introspection / tests). */
export const nativeResumeStats = (): Record<
  TNativeRuntimeProvider,
  TResumeStats
> => ({
  claude_code: { ...resumeStats.claude_code },
  chatgpt: { ...resumeStats.chatgpt },
  cursor: { ...resumeStats.cursor },
});

/** Reset the counters (tests). */
export const resetNativeResumeStats = (): void => {
  resumeStats.claude_code = { firstTurn: 0, resumeHit: 0, resumeMiss: 0 };
  resumeStats.chatgpt = { firstTurn: 0, resumeHit: 0, resumeMiss: 0 };
  resumeStats.cursor = { firstTurn: 0, resumeHit: 0, resumeMiss: 0 };
};

/**
 * Record one correlation outcome and log it. A MISS logs at `warn` with the
 * transcript size being re-sent (the cost of the fallback); the other two log
 * at `debug` so steady-state traffic stays quiet.
 */
const recordResumeOutcome = (
  provider: TNativeRuntimeProvider,
  outcome: "firstTurn" | "resumeHit" | "resumeMiss",
  turnCount: number,
  seedChars: number,
): void => {
  const s = resumeStats[provider];
  s[outcome]++;
  const meta = {
    provider,
    outcome,
    turnCount,
    firstTurn: s.firstTurn,
    resumeHit: s.resumeHit,
    resumeMiss: s.resumeMiss,
  };
  if (outcome === "resumeMiss") {
    logWarn(
      "native-runtime",
      "resume MISS — prior history did not correlate; re-seeding a fresh session with the rendered transcript",
      { ...meta, seedChars },
    );
    return;
  }
  logDebug("native-runtime", `resume ${outcome}`, meta);
};

/**
 * A native serve either COMMITS (a `Response` — the vendor runtime produced
 * output) or DECLINES with a reason. A decline means the request is outside the
 * native path's scope (tools/images/structured-output, or a pre-commit
 * failure); the walker then falls back to the MANUAL transport on the SAME hop
 * (`UPSTREAM_WIRE`) so no workflow is blocked.
 */
export type TNativeServeOutcome =
  | Response
  | {
      readonly declined: string;
      readonly cooldownReason?: TCooldownReason;
    };

const declinedOutcome = (
  declined: string,
  cooldownReason?: TCooldownReason,
): { readonly declined: string; readonly cooldownReason?: TCooldownReason } =>
  cooldownReason === undefined ? { declined } : { declined, cooldownReason };

export type TNativeServeParams = {
  readonly provider: string;
  readonly providerModelId: string;
  readonly surface: "chat_completions" | "messages" | "responses";
  readonly rawBody: unknown;
  readonly canonical: TChatCompletionRequest;
  readonly wantsStream: boolean;
  /** Opaque continuation capability echoed by a client after a tool pause. */
  readonly continuationToken?: string | null;
  /** Catalog-gated client-output repair, resolved by the walker. */
  readonly stripSubagentIsolation: boolean;
  readonly signal: AbortSignal;
  /** Report the hop's token counts + outcome to the cloud (walker's `report`):
   *  "success" with accumulated tokens, or "error" with the last usage observed
   *  before a committed stream failed (zero only when no usage was emitted). */
  readonly record: (tokens: TNativeTokens, status: "success" | "error") => void;
};

/**
 * Try to serve one subscription hop through its native runtime. `bin`/`env`
 * are injectable for tests (fixture runtimes); production callers omit them
 * and get the daemon's isolated CLI paths.
 */
const textOf = (
  resp: Awaited<ReturnType<typeof accumulateChunksToResponse>>,
): string => {
  const content = resp.choices[0]?.message.content;
  return typeof content === "string" ? content : "";
};

const hasAnthropicNativeServerTool = (params: TNativeServeParams): boolean =>
  params.surface === "messages" &&
  declaresAnthropicServerSearchTool(params.rawBody);

export const tryServeNativeRuntime = async (
  params: TNativeServeParams,
  overrides?: {
    readonly bin?: string;
    readonly env?: Record<string, string>;
  },
): Promise<TNativeServeOutcome> => {
  if (!isNativeRuntimeProvider(params.provider)) {
    return { declined: `${params.provider} has no native runtime` };
  }
  // claude_code ONLY: an Anthropic-native server tool must reach Anthropic
  // byte-verbatim (the manual transport IS the Anthropic wire there), so the
  // provider runs it and the client gets authentic server_tool_use blocks.
  // On a chatgpt hop the manual transport is CROSS-WIRE — declining would
  // leak an unexecutable `web_search` tool_use to the client; instead the
  // codex path serves it with HOSTED search (the canonicalised `web_search`
  // function is suppressed from dynamicTools — one search owner per turn).
  if (
    params.provider === "claude_code" &&
    hasAnthropicNativeServerTool(params)
  ) {
    return {
      declined:
        "Anthropic native server tools need the byte-verbatim transport",
    };
  }
  // Requests with client-defined tools use the native runtime's ordinary
  // tool passthrough when supported. Search-shaped function tools are not
  // special-cased or executed by the daemon.
  // cursor is BRIDGE-ONLY (no manual transport to decline to), so its serve
  // path accepts the widest request surface the ACP runtime can represent:
  // tools (loopback MCP), images (ACP image blocks), and structured output
  // (prompt-embedded instruction + local JSON extraction). It skips the
  // generic control gate below — declining response_format/tool_choice there
  // would fail the hop outright instead of routing slower.
  if (params.provider === "cursor") {
    // cursor accepts the wide surface (tools/images/response_format/tool_choice/
    // sampling), but `n>1` (multiple choices) and `logprobs` are STRUCTURALLY
    // unrepresentable over ACP — the agent yields one message with no
    // token-logprob channel. Decline explicitly rather than silently serving a
    // single un-scored choice against a request that asked for more.
    const cursorUnrepresentable =
      (typeof params.canonical.n === "number" && params.canonical.n > 1) ||
      params.canonical.logprobs === true;
    if (cursorUnrepresentable) {
      return {
        declined:
          "cursor ACP can't honor n>1 or logprobs (single un-scored message per turn)",
      };
    }
    return serveCursorHop(params, overrides);
  }
  // Generation controls the native runtimes can't honor (non-default
  // temperature/top_p/penalties, stop, seed, n, logprobs, logit_bias,
  // response_format, forced tool_choice) → decline rather than silently serving
  // at the runtime's defaults. The walker decides whether a handrolled transport
  // is available for this hop. Guards BOTH the tool and text paths. (max_tokens
  // is a documented carve-out — see `unsupportedNativeControl`.)
  // TODO(docs/audit/2026-08-30-claude-code-bridge-failures.md §4 B2): route
  // bridge-only temperature requests through an approved temperature-honoring
  // transport rather than rejecting this native capability gap.
  const unsupported = unsupportedNativeControl(params.canonical);
  if (unsupported !== null) {
    return { declined: `native runtime can't honor ${unsupported}` };
  }
  // Tool-bearing requests use completion tool-passthrough. claude_code: the
  // held-open SDK query. chatgpt: the Codex app-server's native dynamic-tool
  // protocol (`dynamicTools` + `item/tool/call` with code-mode disabled —
  // `codex-tool-session.ts`). A native decline still falls through to the
  // manual transport on the same hop, so an unexpected protocol mismatch just
  // routes slower, never breaks.
  if (hasClientTools(params.canonical)) {
    return tryServeNativeToolTurn({
      provider: params.provider,
      providerModelId: params.providerModelId,
      surface: params.surface,
      canonical: params.canonical,
      wantsStream: params.wantsStream,
      stripSubagentIsolation: params.stripSubagentIsolation,
      bin: overrides?.bin ?? cliBin(params.provider),
      env: overrides?.env ?? cliEnv(params.provider),
      record: params.record,
      continuationToken: params.continuationToken ?? null,
      continuationIdentity: toolContinuationIdentity(),
    });
  }
  const req = nativeRequestOf(params.canonical);
  if (req === null) {
    // Tool-bearing requests were handled above; this is a non-tool request the
    // native text path still can't represent (image parts, structured output,
    // a tool-role message) — the manual transport serves it.
    return {
      declined:
        "native runtime serves text + tool conversations; images and structured output fall to the manual transport",
    };
  }

  // Correlate to a persisted session and compute the delta turn to feed.
  const store = stores[params.provider];
  const { prefixHash, deltaText, hasPrior } = deriveConversation(
    params.providerModelId,
    req.systemText,
    req.turns,
  );
  if (deltaText.length === 0) return { declined: "no user turn to answer" };
  const lease = await store.lease(prefixHash);
  const resumeId = lease.sessionId; // null → fresh session
  // Resume feeds ONLY the delta. A fresh session with unmatched prior history
  // renders the transcript as a seed (lossy fallback); a true first turn feeds
  // the delta (which is all the user text) directly.
  const userText =
    resumeId !== null
      ? deltaText
      : hasPrior
        ? renderSeed(req.turns, deltaText)
        : deltaText;
  // Instrumentation: which of the three correlation outcomes this turn took.
  // `hasPrior && resumeId === null` is the expensive `renderSeed` fallback.
  recordResumeOutcome(
    params.provider,
    resumeId !== null ? "resumeHit" : hasPrior ? "resumeMiss" : "firstTurn",
    req.turns.length,
    resumeId === null && hasPrior ? userText.length : 0,
  );
  // A resumed session already carries the system prompt; only a fresh start
  // applies it.
  const systemText = resumeId !== null ? null : req.systemText;

  const bin = overrides?.bin ?? cliBin(params.provider);
  const env = overrides?.env ?? cliEnv(params.provider);
  let run: TNativeRunResult;
  try {
    run =
      params.provider === "claude_code"
        ? await runClaudeNative({
            bin,
            env,
            providerModelId: params.providerModelId,
            systemText,
            userText,
            resumeSessionId: resumeId,
            signal: params.signal,
          })
        : await runCodexNative({
            bin,
            env,
            providerModelId: params.providerModelId,
            systemText,
            userText,
            resumeThreadId: resumeId,
            reasoningEffort: params.canonical.reasoning_effort ?? null,
            signal: params.signal,
          });
  } catch (error) {
    lease.abandon();
    return {
      declined: error instanceof Error ? error.message : String(error),
    };
  }
  if (run.kind === "declined") {
    lease.abandon();
    return declinedOutcome(run.reason, run.cooldownReason);
  }

  const committed = run;
  // After the response is accumulated, record tokens AND advance the session:
  // re-key it under `hash(inbound turns + assistant response)` so the NEXT
  // request resumes it. On accumulation failure, abandon (next turn re-seeds).
  const settle = (
    resp: Awaited<ReturnType<typeof accumulateChunksToResponse>>,
  ): void => {
    params.record(tokensFromResponse(resp), "success");
    lease.commit(
      nextPrefixHash(
        params.providerModelId,
        req.systemText,
        req.turns,
        textOf(resp),
      ),
      committed.sessionId(),
    );
  };
  const fail = (err: unknown): void => {
    if (params.signal.aborted || isClientHangUp(err)) {
      lease.abandon();
      return;
    }
    const usage = partialUsageFrom(err);
    params.record(
      usage === null ? ZERO_TOKENS : tokensFromResponse({ usage }),
      "error",
    );
    lease.abandon();
  };

  const clientWire = clientWireOf(params.surface);

  // ── Streaming client: the shared delivery tail (walker parity) ──────
  if (params.wantsStream) {
    return deliverChunkStream(committed.chunks, {
      surface: params.surface,
      clientWire,
      providerModelId: params.providerModelId,
      onResponse: settle,
      onError: fail,
      stripSubagentIsolation: params.stripSubagentIsolation,
    });
  }

  // ── JSON client: accumulate → record + advance session → re-encode ──
  let canonical: Awaited<ReturnType<typeof accumulateChunksToResponse>>;
  try {
    canonical = await accumulateChunksToResponse(
      committed.chunks,
      params.providerModelId,
    );
  } catch (err) {
    fail(err);
    return errorJson(
      502,
      partialUsageFrom(err) === null
        ? "native runtime stream ended before output"
        : "native runtime stream failed after output began",
    );
  }
  settle(canonical);
  return deliverJsonResponse(
    canonical,
    params.surface,
    clientWire,
    undefined,
    params.stripSubagentIsolation,
  );
};

/**
 * The cursor serve path — bridge-only, so it accepts tools/images/structured
 * output instead of declining them (there is no manual transport behind it).
 * One COLD ACP session per request: `cursorRequestOf` flattens the full
 * conversation (including assistant tool_calls + tool results) into one
 * prompt; token counts are chars/4 ESTIMATES (ACP reports none).
 */
const serveCursorHop = async (
  params: TNativeServeParams,
  overrides?: {
    readonly bin?: string;
    readonly env?: Record<string, string>;
  },
): Promise<TNativeServeOutcome> => {
  const req = cursorRequestOf(params.canonical);
  if (req.promptText.length === 0 && req.images.length === 0) {
    return { declined: "no user turn to answer" };
  }
  const run = await runCursorNative({
    bin: overrides?.bin ?? cliBin("cursor"),
    env: overrides?.env ?? cliEnv("cursor"),
    providerModelId: params.providerModelId,
    systemText: req.systemText,
    userText: req.promptText,
    images: req.images,
    tools: req.tools,
    jsonInstructionText:
      req.jsonMode !== null
        ? jsonInstruction(req.jsonMode, req.jsonSchema)
        : null,
    signal: params.signal,
  });
  if (run.kind === "declined") {
    return declinedOutcome(run.reason, run.cooldownReason);
  }

  const settle = (
    resp: Awaited<ReturnType<typeof accumulateChunksToResponse>>,
  ): void => {
    params.record(tokensFromResponse(resp), "success");
  };
  const fail = (err: unknown): void => {
    if (params.signal.aborted || isClientHangUp(err)) return;
    const usage = partialUsageFrom(err);
    params.record(
      usage === null ? ZERO_TOKENS : tokensFromResponse({ usage }),
      "error",
    );
  };
  const clientWire = clientWireOf(params.surface);
  if (params.wantsStream) {
    return deliverChunkStream(run.chunks, {
      surface: params.surface,
      clientWire,
      providerModelId: params.providerModelId,
      onResponse: settle,
      onError: fail,
      stripSubagentIsolation: params.stripSubagentIsolation,
    });
  }
  let canonical: Awaited<ReturnType<typeof accumulateChunksToResponse>>;
  try {
    canonical = await accumulateChunksToResponse(
      run.chunks,
      params.providerModelId,
    );
  } catch (err) {
    fail(err);
    return errorJson(
      502,
      partialUsageFrom(err) === null
        ? "native runtime stream ended before output"
        : "native runtime stream failed after output began",
    );
  }
  settle(canonical);
  return deliverJsonResponse(
    canonical,
    params.surface,
    clientWire,
    undefined,
    params.stripSubagentIsolation,
  );
};

export type { TChatCompletionChunk };
/** Re-exported for the walker + tests. */
export { isNativeRuntimeProvider, nativeRequestOf };
