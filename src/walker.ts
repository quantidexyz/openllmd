/**
 * The coreless §3.3 walker — a thin executor of the cloud-resolved plan.
 *
 * The cloud is the only brain: it resolves the alias + cooldowns and hands
 * the daemon the concrete ordered chain across the 307 as `?__plan=`. This
 * walker walks that list in order — making ZERO routing decisions:
 *
 *   for hop in __plan (in order):
 *     - subscription hop  → inject the local CLI credential, call the
 *                           vendor upstream
 *     - API-key hop       → forward inbound to the cloud, pinned to the hop
 *                           (the cloud decrypts the BYOK credential + runs)
 *     - PRE-STREAM error + retryable → next hop
 *     - committed (response received, ok) → stream straight to the client
 *
 * Coreless: imports `@quantidexyz/openllmw` + `@quantidexyz/openllmp` + local modules
 * only — NEVER `@openllm/core`. The pure provider wire transforms
 * (request/response/streaming for anthropic + chatgpt, the canonical
 * message adapters, and the SSE decode/encode primitives) all live in
 * `@quantidexyz/openllmw`; the walker wires them into a tiny per-hop mini-runner.
 *
 * Serves all three subscription providers + cross-wire:
 *   - claude_code (Anthropic upstream): passthrough for an Anthropic-wire
 *     client; toAnthropicRequest + response re-encode for an OpenAI client.
 *   - chatgpt (Codex/Responses upstream): always transform via
 *     toChatGptRequest, decode Responses events → canonical → client wire.
 *   - kimi_code (OpenAI-compatible upstream): passthrough for an OpenAI
 *     client; canonical re-encode for an Anthropic client.
 * API-key hops are forwarded to the cloud. See
 * docs/proposals/coreless-daemon-passthrough.md §3.3 + §9(a).
 *
 * This is the daemon's ONLY data path (no `@openllm/core`, no flag, no
 * fallback). It reports TOKEN COUNTS only — accurate for both streaming
 * (accumulated off a tee'd canonical-chunk stream) and non-streaming — and
 * the cloud computes cost from them (single pricing source of truth, so no
 * pricing table is shipped to the box).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AnthropicResponse,
  AnthropicStreamEvent,
  ChatCompletionChunk,
  daemonPlanSigningPayload,
  type TAnthropicResponse,
  type TChatCompletionChunk,
  type TChatCompletionRequest,
  type TChatCompletionResponse,
  type TDaemonRecordRequest,
  type TErrorEnvelope,
  type TRequestStatus,
  type TToolCall,
} from "@quantidexyz/openllmp";
import { toAnthropicMessagesResponse } from "@quantidexyz/openllmw/adapters/messages/response";
import { chunksToMessagesSseBytes } from "@quantidexyz/openllmw/adapters/messages/streaming";
import {
  chunksToResponsesSseBytes,
  toResponsesResponse,
} from "@quantidexyz/openllmw/adapters/responses";
import { classifyHopError } from "@quantidexyz/openllmw/lib/error-class";
import { originatorHeadersFrom } from "@quantidexyz/openllmw/lib/forwarded-headers";
import { accumulateChunksToResponse } from "@quantidexyz/openllmw/lib/streaming/accumulate";
import {
  chunksToSseBytes,
  decodeProviderEventStream,
} from "@quantidexyz/openllmw/lib/streaming/provider-decode";
import { responseToChunkStream } from "@quantidexyz/openllmw/lib/streaming/response-stream";
import { withFrameAlignedHeartbeat } from "@quantidexyz/openllmw/lib/streaming/sse";
import { fromAnthropicResponse } from "@quantidexyz/openllmw/providers/anthropic/response";
import {
  fromAnthropicStreamEvent,
  newAnthropicStreamState,
} from "@quantidexyz/openllmw/providers/anthropic/streaming";
import {
  chatGptEventToChunk,
  newChatGptStreamState,
  type TChatGptStreamEvent,
} from "@quantidexyz/openllmw/providers/chatgpt/streaming";
// The SINGLE (clientWire × upstreamWire) request recipe — shared with the
// cloud runner so the two can't drift (this fork caused two regressions). See
// `docs/proposals/unified-upstream-request-builder.md`.
import {
  buildUpstreamHeaders,
  buildUpstreamRequest,
  canonicalFromInbound,
  canonicalToUpstreamBody,
  clientWireOf,
} from "@quantidexyz/openllmw/providers/upstream-request";
import {
  buildAssistantToolCallMessage,
  buildToolResultMessages,
  extractQueryFromToolCall,
  functionNameUsesWebSearch,
  MAX_WEB_SEARCH_ROUNDS,
  toolCallUsesWebSearch,
} from "@quantidexyz/openllmw/tools/web-search/helpers";
import { Schema } from "effect";
import { recordRequest, searchViaCloud } from "./cloud-client";
import { lookupCatalogEntry, planSigningKey } from "./config";
import { errorJson } from "./cors";
import { getDelegate, isSubscriptionSlug } from "./delegation";
import { forwardToCloud } from "./forward";

// Upstream WIRE per subscription provider — structural (which adapter to run),
// the one constant that stays in the walker. The upstream URL is no longer
// hardcoded here: it's resolved per hop from the delegate's auth config
// (`credentialForUpstream().url`), captured from the real CLI request. See
// `packages/daemon/src/delegation/auth-config.ts`.
type TUpstreamWire = "anthropic" | "chatgpt" | "openai";
const UPSTREAM_WIRE: Readonly<Record<string, TUpstreamWire>> = {
  claude_code: "anthropic",
  chatgpt: "chatgpt",
  // Kimi's managed "Kimi For Coding" subscription speaks the OpenAI wire
  // (`/coding/v1/chat/completions`) — exactly what the official `kimi-code-cli`
  // sends. So we delegate over the openai wire with the CLI's genuine identity
  // (URL + headers from the delegate's `credentialForUpstream`, captured from
  // the real `kimi -p ping` request). See `kimi-code.ts`.
  kimi_code: "openai",
};

// The chatgpt Responses API emits freeform JSON events (no strict schema);
// discrimination happens inside `chatGptEventToChunk`. Mirrors the core
// spec's `Schema.Record(string, unknown)` validator.
const ChatGptStreamEventSchema: Schema.Schema<TChatGptStreamEvent> =
  Schema.Record({ key: Schema.String, value: Schema.Unknown });

export type TWalkArgs = {
  readonly req: Request;
  readonly surface: "chat_completions" | "messages" | "responses";
  readonly endpoint: string;
  /** The parsed inbound JSON body (Anthropic- or OpenAI-shaped per surface). */
  readonly rawBody: unknown;
  /** The raw inbound bytes — forwarded verbatim to the cloud for API-key hops. */
  readonly rawBytes: ArrayBuffer;
  /** The `?__plan=` value off the 307 redirect, or null. */
  readonly planParam: string | null;
  /** The `?__pmids=` value — concrete upstream `provider_model_id`s parallel
   *  to `__plan`, so the daemon serves catalog-free. Null on older redirects. */
  readonly pmidsParam: string | null;
  /** The `?__origin=` value — the deployment that issued the 307; the daemon
   *  forwards API-key hops + records usage back here. Null → pinned origin. */
  readonly originParam: string | null;
  /** The `?__sig=` HMAC of the signed payload (plan+pmids+origin), or null. */
  readonly sigParam: string | null;
  readonly startedAt: number;
};

type THop = {
  readonly modelId: string;
  readonly provider: string;
  readonly providerModelId: string;
};

/** Parse `?__plan=provider/model,provider/model` into ordered model ids.
 *  Also used for the parallel `?__pmids=` list (same comma encoding). */
export const parsePlan = (planParam: string | null): ReadonlyArray<string> =>
  planParam === null
    ? []
    : planParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

/**
 * Resolve a plan model id to its `{ provider, providerModelId }`. Precedence:
 * (1) the concrete `providerModelId` the cloud pushed in `__pmids` — the
 * catalog-free path; (2) the cloud-pulled catalog; (3) splitting the
 * `provider/model` pair (dev / older redirects). Only the provider prefix is
 * ever derived locally; the upstream id is authoritative from the cloud.
 */
export const resolveHop = (modelId: string, providerModelId?: string): THop => {
  const slash = modelId.indexOf("/");
  const provider = slash > 0 ? modelId.slice(0, slash) : modelId;
  if (providerModelId !== undefined && providerModelId.length > 0) {
    return { modelId, provider, providerModelId };
  }
  const entry = lookupCatalogEntry(modelId);
  if (entry !== null) {
    return {
      modelId,
      provider: entry.provider,
      providerModelId: entry.provider_model_id,
    };
  }
  return slash > 0
    ? { modelId, provider, providerModelId: modelId.slice(slash + 1) }
    : { modelId, provider: modelId, providerModelId: modelId };
};

/**
 * Verify a cloud-signed `?__plan=` against the per-user key handed over at
 * bootstrap (coreless proposal §9). Timing-safe. A missing/short/mismatched
 * signature fails closed.
 */
export const verifyPlanSignature = (
  plan: string,
  sig: string | null,
  key: string,
): boolean => {
  if (sig === null || sig.length === 0) return false;
  const expected = createHmac("sha256", key).update(plan).digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
};

/**
 * Can the walker serve this whole plan coreless? Every subscription hop
 * must be one of the three the walker knows an upstream for; API-key hops
 * are always walkable (forwarded to the cloud). DECLINE the whole plan up
 * front for an unknown subscription provider — so we never half-attempt a
 * chain and then bail. (All wire combinations of the three known providers
 * are supported now — passthrough where client-wire == upstream-wire,
 * transform-and-re-encode otherwise.)
 */
export const canWalkPlan = (hops: ReadonlyArray<THop>): boolean => {
  for (const hop of hops) {
    if (!isSubscriptionSlug(hop.provider)) continue; // API-key → forwardable
    if (UPSTREAM_WIRE[hop.provider] === undefined) return false;
  }
  return true;
};

/**
 * Pre-stream retry classifier — the thin, DELIBERATELY narrow daemon policy
 * (the cloud's full `classifyHopError` treats most 4xx as transient; the
 * daemon does not). 429 / 408 / 5xx fall through to the next hop; everything
 * else (incl. 401 — the delegate refreshes the token on read, so a 401 here
 * is post-refresh and terminal) commits. The ONE exception, handled
 * separately via `transient400Envelope`, is a 400 whose envelope is a
 * content-filter / context-length / capability refusal — there a different
 * model on the chain may accept the request, so we walk like the cloud.
 * Mid-stream failure is intentionally out of scope (commit-on-first-byte).
 */
export const retryable = (status: number): boolean =>
  status === 429 || status === 408 || (status >= 500 && status <= 599);

/** Map the daemon's upstream wire to the classifier's provider format
 *  (chatgpt + kimi both speak the OpenAI error-envelope shape). */
const hopFormat = (wire: TUpstreamWire): "openai" | "anthropic" =>
  wire === "anthropic" ? "anthropic" : "openai";

/**
 * Is a 400's error body a transient refusal (content-filter / context-length
 * / capability) that a different chain hop might accept? Defers to the shared
 * `classifyHopError` so the daemon and cloud agree on what a transient 400
 * looks like. `raw` is the upstream error body (best-effort JSON parse).
 */
export const transient400Envelope = (
  raw: string,
  wire: TUpstreamWire,
): boolean => {
  let envelope: TErrorEnvelope | undefined;
  try {
    const json = JSON.parse(raw) as { error?: unknown };
    envelope =
      json.error !== null && typeof json.error === "object"
        ? { error: json.error as TErrorEnvelope["error"] }
        : undefined;
  } catch {
    envelope = undefined;
  }
  return (
    classifyHopError({
      status: 400,
      envelope,
      providerFormat: hopFormat(wire),
      aborted: false,
    }).kind === "transient"
  );
};

const statusFor = (httpStatus: number): TRequestStatus =>
  httpStatus < 400
    ? "success"
    : httpStatus === 429
      ? "rate_limited"
      : httpStatus === 408
        ? "timeout"
        : "error";

/** Strip hop-by-hop headers so the body re-streams cleanly to the client. */
const passthroughHeaders = (resp: Response): Headers => {
  const headers = new Headers(resp.headers);
  for (const h of [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "connection",
  ]) {
    headers.delete(h);
  }
  return headers;
};

const report = (row: TDaemonRecordRequest, origin: string | null): void => {
  void recordRequest(row, origin);
};

const decodeAnthropicResponse = Schema.decodeUnknownSync(AnthropicResponse);

// The (clientWire × upstreamWire) request recipe — body + headers — lives in
// `@quantidexyz/openllmw/providers/upstream-request` (buildUpstreamRequest /
// buildUpstreamHeaders / buildUpstreamBody / canonicalToUpstreamBody /
// canonicalFromInbound / clientWireOf). The walker is a thin caller; it never
// re-derives the recipe (that fork caused two regressions).

/** Decode an upstream SSE stream into canonical chunks, per upstream wire. */
const decodeUpstreamStream = (
  wire: TUpstreamWire,
  body: ReadableStream<Uint8Array>,
  providerModelId: string,
): ReadableStream<TChatCompletionChunk> => {
  const options = { providerModelId };
  if (wire === "anthropic") {
    return decodeProviderEventStream(
      body,
      {
        eventSchema: AnthropicStreamEvent,
        initialState: newAnthropicStreamState,
        eventToChunk: fromAnthropicStreamEvent,
      },
      options,
    );
  }
  if (wire === "chatgpt") {
    return decodeProviderEventStream(
      body,
      {
        eventSchema: ChatGptStreamEventSchema,
        initialState: newChatGptStreamState,
        eventToChunk: chatGptEventToChunk,
      },
      options,
    );
  }
  // openai/kimi: the upstream chunk IS the canonical chunk.
  return decodeProviderEventStream(
    body,
    {
      eventSchema: ChatCompletionChunk,
      initialState: () => ({}),
      eventToChunk: (event: TChatCompletionChunk) => event,
    },
    options,
  );
};

/** Decode an upstream non-streaming JSON body into a canonical response. */
const decodeUpstreamJson = (
  wire: TUpstreamWire,
  json: unknown,
  providerModelId: string,
): TChatCompletionResponse => {
  if (wire === "anthropic") {
    const anthropic: TAnthropicResponse = decodeAnthropicResponse(json);
    return fromAnthropicResponse(anthropic, { providerModelId });
  }
  // chatgpt Responses + openai/kimi: already ChatCompletion-shaped (mirror
  // the core chatgpt spec's inline `fromBody`, which only pins the model).
  return { ...(json as TChatCompletionResponse), model: providerModelId };
};

const tokensFromCanonical = (
  resp: TChatCompletionResponse,
): { tokens_in: number; tokens_out: number } => ({
  tokens_in: resp.usage?.prompt_tokens ?? 0,
  tokens_out: resp.usage?.completion_tokens ?? 0,
});

// ─── web_search (§5) ──────────────────────────────────────────────────
// The agentic round cap (`MAX_WEB_SEARCH_ROUNDS`) is shared with the cloud
// orchestrator via `@quantidexyz/openllmw/tools/web-search/helpers` so both paths
// agent the same depth.

/** Does the request ask the gateway to run web_search (an openllm function
 *  tool, NOT a vendor-native server tool)? */
const requestDeclaresWebSearch = (req: TChatCompletionRequest): boolean =>
  req.tools?.some((t) => functionNameUsesWebSearch(t.function.name)) === true;

/**
 * The gateway runs openllm-managed web_search on every wire path EXCEPT the
 * Anthropic→Anthropic passthrough — there the request's native
 * `web_search_*` server tool is forwarded verbatim and Anthropic runs the
 * search itself (no DEK / vault credential needed). Mirrors the cloud's
 * `webSearchTool.appliesTo` (all combos but `messages.anthropic.passthrough`).
 */
const shouldInterceptWebSearch = (
  wire: TUpstreamWire,
  surface: TWalkArgs["surface"],
  canonical: TChatCompletionRequest,
): boolean =>
  requestDeclaresWebSearch(canonical) &&
  !(wire === "anthropic" && clientWireOf(surface) === "anthropic");

/** Splice native `server_tool_use` + `web_search_tool_result` blocks to the
 *  front of an Anthropic response's content so Claude Code's WebSearch
 *  parser recognises the search ran (non-streaming messages surface). */
const spliceAnthropicWebSearchBlocks = (
  resp: Record<string, unknown>,
  blocks: ReadonlyArray<{ server_tool_use: unknown; tool_result: unknown }>,
): Record<string, unknown> => {
  if (blocks.length === 0) return resp;
  const native = blocks.flatMap((b) => [b.server_tool_use, b.tool_result]);
  const existing = Array.isArray(resp.content) ? resp.content : [];
  return { ...resp, content: [...native, ...existing] };
};

/**
 * Build the BASE upstream headers for a hop: the ORIGINATOR's own headers
 * (denylist passthrough — `originatorHeadersFrom`), then the credential-intrinsic
 * headers + the subscription bearer layered on top. The wire-derived headers
 * (anthropic-version / anthropic-beta / content-type) are layered last by
 * `buildUpstreamRequest`/`buildUpstreamHeaders`. So a genuine vendor-CLI request
 * reaches the vendor with ITS real identity; the daemon forges nothing and only
 * swaps in the bearer (+ the user's own account id where required). Returns
 * "retry" when no usable local credential is available, so the walker falls
 * through.
 */
const acquireUpstream = async (
  provider: string,
  args: TWalkArgs,
): Promise<{ headers: Record<string, string>; url: string } | "retry"> => {
  const delegate = getDelegate(provider);
  if (delegate === null) return "retry";
  try {
    const cred = await delegate.credentialForUpstream();
    return {
      headers: {
        ...originatorHeadersFrom(args.req.headers),
        ...cred.headers,
        authorization: `Bearer ${cred.access_token}`,
      },
      url: cred.url,
    };
  } catch {
    return "retry";
  }
};

/** The client's inbound `anthropic-beta` (messages surface only) — merged into
 *  the upstream beta by `buildUpstreamHeaders`. */
const inboundBetaOf = (args: TWalkArgs): string | null =>
  args.surface === "messages" ? args.req.headers.get("anthropic-beta") : null;

/**
 * Serve a subscription hop that runs openllm-managed web_search (§5): the
 * agentic loop. Each round calls the vendor (ACCUMULATED — we must read the
 * whole response to spot tool calls), and for every `web_search` tool call
 * POSTs only the QUERY to the cloud (`searchViaCloud`), appends the results
 * as a follow-up turn, and re-calls — until the model answers without
 * searching (or the round cap). The conversation never leaves the box; only
 * the query crosses (to a third-party engine the user already authorized).
 */
const serveWithWebSearch = async (
  hop: THop,
  wire: TUpstreamWire,
  args: TWalkArgs,
  initialCanonical: TChatCompletionRequest,
): Promise<Response | "retry"> => {
  const acquired = await acquireUpstream(hop.provider, args);
  if (acquired === "retry") return "retry";
  const { headers: baseHeaders, url } = acquired;
  // Headers are computed once; the body is rebuilt per round from the
  // accumulated canonical (web_search appends tool results between rounds).
  const headers = buildUpstreamHeaders({
    surface: args.surface,
    upstreamWire: wire,
    rawBody: args.rawBody,
    providerModelId: hop.providerModelId,
    stream: false,
    baseHeaders,
    inboundBeta: inboundBetaOf(args),
    isOAuth: wire === "anthropic",
  });

  let canonical = initialCanonical;
  const collectedBlocks: Array<{
    server_tool_use: unknown;
    tool_result: unknown;
  }> = [];
  let final: TChatCompletionResponse | null = null;

  for (let round = 0; round < MAX_WEB_SEARCH_ROUNDS; round++) {
    // Accumulated cross-wire body (chatgpt still streams + is drained).
    const body = canonicalToUpstreamBody(
      wire,
      canonical,
      hop.providerModelId,
      false,
    );
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: args.req.signal,
      });
    } catch {
      if (round === 0) return "retry";
      return errorJson(502, "web_search: upstream request failed");
    }
    if (!resp.ok) {
      if (round === 0 && retryable(resp.status)) return "retry";
      const detail = await resp.text().catch(() => "");
      // Parity with serveSubscription: a content-filter / context-length /
      // capability 400 is transient — walk to the next hop (round 0 only).
      if (
        round === 0 &&
        resp.status === 400 &&
        transient400Envelope(detail, wire)
      ) {
        return "retry";
      }
      return new Response(detail.length > 0 ? detail : null, {
        status: resp.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (resp.body === null) {
      if (round === 0) return "retry";
      return errorJson(502, "web_search: empty upstream response");
    }
    let roundResp: TChatCompletionResponse;
    try {
      roundResp =
        wire === "chatgpt"
          ? await accumulateChunksToResponse(
              decodeUpstreamStream(wire, resp.body, hop.providerModelId),
              hop.providerModelId,
            )
          : decodeUpstreamJson(
              wire,
              JSON.parse(await resp.text()),
              hop.providerModelId,
            );
    } catch {
      return errorJson(502, "web_search: could not decode upstream response");
    }

    const webCalls: TToolCall[] = (
      roundResp.choices[0]?.message.tool_calls ?? []
    ).filter(toolCallUsesWebSearch);
    const assistantMsg =
      webCalls.length > 0
        ? buildAssistantToolCallMessage({
            response: roundResp,
            toolCalls: webCalls,
          })
        : null;
    if (assistantMsg === null) {
      final = roundResp; // model answered without searching → done
      break;
    }

    const contentsById = new Map<string, string>();
    for (const call of webCalls) {
      const query = extractQueryFromToolCall(call);
      const result =
        query.length === 0
          ? null
          : await searchViaCloud(query, args.originParam, args.req.signal);
      contentsById.set(
        call.id,
        result?.content ??
          "Search error: web_search is unavailable (no result from the gateway)",
      );
      if (result !== null && result.server_tool_use !== null) {
        collectedBlocks.push({
          server_tool_use: result.server_tool_use,
          tool_result: result.tool_result,
        });
      }
    }
    canonical = {
      ...canonical,
      messages: [
        ...canonical.messages,
        assistantMsg,
        ...buildToolResultMessages({ calls: webCalls, contentsById }),
      ],
    };
  }

  if (final === null) {
    return errorJson(
      502,
      `web_search: exceeded ${MAX_WEB_SEARCH_ROUNDS} rounds without a final answer`,
    );
  }

  report(
    {
      model: hop.modelId,
      provider: hop.provider,
      status: statusFor(200),
      latency_ms: Date.now() - args.startedAt,
      endpoint: args.endpoint,
      ...tokensFromCanonical(final),
    },
    args.originParam,
  );

  const clientWire = clientWireOf(args.surface);
  const wantsStream =
    (args.rawBody as { stream?: unknown } | null)?.stream === true;
  if (wantsStream) {
    const bytes =
      args.surface === "responses"
        ? chunksToResponsesSseBytes(responseToChunkStream(final))
        : clientWire === "anthropic"
          ? chunksToMessagesSseBytes(responseToChunkStream(final))
          : chunksToSseBytes(responseToChunkStream(final));
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
  const clientBody =
    args.surface === "responses"
      ? toResponsesResponse(final)
      : clientWire === "anthropic"
        ? spliceAnthropicWebSearchBlocks(
            toAnthropicMessagesResponse(final) as unknown as Record<
              string,
              unknown
            >,
            collectedBlocks,
          )
        : final;
  return new Response(JSON.stringify(clientBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

/**
 * Serve one subscription hop locally: inject the official CLI's bearer +
 * real identity headers, adapt the request to the provider's wire, call
 * the vendor, and re-encode the response back to the client's wire. The
 * conversation goes only to the vendor; the token never leaves the box.
 * Returns "retry" on a pre-stream retryable error so the walker advances.
 */
const serveSubscription = async (
  hop: THop,
  wire: TUpstreamWire,
  args: TWalkArgs,
): Promise<Response | "retry"> => {
  const acquired = await acquireUpstream(hop.provider, args);
  if (acquired === "retry") return "retry";
  const { headers: baseHeaders, url } = acquired;

  const clientWantsStream =
    (args.rawBody as { stream?: unknown } | null)?.stream === true;
  // ONE shared recipe — body + headers — for the (clientWire × upstreamWire)
  // pairing (the cloud runner calls the same builder).
  const { body, headers } = buildUpstreamRequest({
    surface: args.surface,
    upstreamWire: wire,
    rawBody: args.rawBody,
    providerModelId: hop.providerModelId,
    stream: clientWantsStream,
    baseHeaders,
    inboundBeta: inboundBetaOf(args),
    isOAuth: wire === "anthropic",
  });
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: args.req.signal,
    });
  } catch {
    return "retry"; // network error — pre-stream, fall through
  }
  if (!resp.ok) {
    if (retryable(resp.status)) return "retry";
    const raw = await resp.text().catch(() => "");
    // A content-filter / context-length / capability 400 is transient — walk
    // to the next hop like the cloud does.
    if (resp.status === 400 && transient400Envelope(raw, wire)) {
      return "retry";
    }
    // Every other non-OK is terminal: surface the upstream error verbatim.
    // Returning here (instead of falling through) keeps an error body out of
    // the success path, which would otherwise try to decode it as a chat
    // response or stream it as SSE.
    return new Response(raw.length > 0 ? raw : null, {
      status: resp.status,
      headers: passthroughHeaders(resp),
    });
  }

  if (!resp.body) return "retry";

  // Committed. Re-encode the response to the client's wire + record a
  // metadata row. Cost is NOT computed here — the cloud recomputes it from
  // these token counts (single pricing source of truth, no local table).
  const clientWire = clientWireOf(args.surface);
  // `responses` clients always need a Responses re-encode (never raw upstream
  // bytes), so they never take the verbatim passthrough.
  const passthrough = wire === clientWire && args.surface !== "responses";
  // What the UPSTREAM produced, decided deterministically (not sniffed):
  // chatgpt's Codex/Responses endpoint ALWAYS streams (`toChatGptRequest`
  // forces `stream: true`); anthropic + kimi propagate the request's stream
  // flag, which buildUpstreamBody set from the client's. So upstream is SSE
  // iff chatgpt, or the client asked to stream.
  const upstreamStreams = wire === "chatgpt" || clientWantsStream;
  const baseRow = {
    model: hop.modelId,
    provider: hop.provider,
    status: statusFor(resp.status),
    latency_ms: Date.now() - args.startedAt,
    endpoint: args.endpoint,
  } satisfies Partial<TDaemonRecordRequest>;
  const recordTokens = (u: {
    readonly tokens_in: number;
    readonly tokens_out: number;
  }): void =>
    report(
      { ...baseRow, tokens_in: u.tokens_in, tokens_out: u.tokens_out },
      args.originParam,
    );

  // ── Client wants a live stream ──────────────────────────────────────
  // First-class path: stream chunk-by-chunk, re-encoding to the client's
  // wire as bytes arrive. (upstreamStreams is always true here — chatgpt
  // always streams; anthropic/kimi stream because the client asked.)
  if (clientWantsStream) {
    const sseHeaders = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    } as const;
    // Keep the (localhost) client connection warm while the upstream is
    // quiet during a long reasoning / tool run — the same "chat stopped
    // while it was actually doing something" symptom the cloud guards. The
    // daemon does NOT add `withStreamDeadline`: that exists only to beat
    // Vercel's `maxDuration` guillotine (a cloud-only concept), and a daemon
    // crash can't emit a terminator regardless. Frame-aligned so a beat is
    // never spliced inside a half-sent SSE event.
    const heartbeat = (
      bytes: ReadableStream<Uint8Array>,
    ): ReadableStream<Uint8Array> =>
      withFrameAlignedHeartbeat(bytes, {
        intervalMs: 15_000,
        kind: args.surface === "messages" ? "anthropic_ping" : "comment",
      });
    // Meter token usage off a tee'd canonical branch (never blocks the
    // client; accurate counts come from the final chunk's usage).
    const meter = (chunks: ReadableStream<TChatCompletionChunk>): void => {
      void accumulateChunksToResponse(chunks, hop.providerModelId)
        .then((r) => recordTokens(tokensFromCanonical(r)))
        .catch(() => recordTokens({ tokens_in: 0, tokens_out: 0 }));
    };
    if (passthrough) {
      // Same wire in and out — the client gets the upstream bytes verbatim
      // (no transform round-trip that could alter them); a tee'd copy is
      // decoded purely to meter.
      const [toClient, toMeter] = resp.body.tee();
      meter(decodeUpstreamStream(wire, toMeter, hop.providerModelId));
      return new Response(heartbeat(toClient), {
        status: resp.status,
        headers: passthroughHeaders(resp),
      });
    }
    // Cross-wire (or chatgpt): decode → tee → re-encode + meter.
    const [toClient, toMeter] = decodeUpstreamStream(
      wire,
      resp.body,
      hop.providerModelId,
    ).tee();
    meter(toMeter);
    const clientBytes =
      args.surface === "responses"
        ? chunksToResponsesSseBytes(toClient)
        : clientWire === "anthropic"
          ? chunksToMessagesSseBytes(toClient)
          : chunksToSseBytes(toClient);
    return new Response(heartbeat(clientBytes), {
      status: resp.status,
      headers: sseHeaders,
    });
  }

  // ── Client wants a single JSON response ─────────────────────────────
  const jsonHeaders = { "content-type": "application/json" } as const;
  const reencodeJson = (canonical: TChatCompletionResponse): string =>
    JSON.stringify(
      args.surface === "responses"
        ? toResponsesResponse(canonical)
        : clientWire === "anthropic"
          ? toAnthropicMessagesResponse(canonical)
          : canonical,
    );

  if (upstreamStreams) {
    // The upstream streamed but the client wants JSON (chatgpt, whose Codex
    // endpoint always streams): DRAIN the SSE → accumulate → one response.
    let canonical: TChatCompletionResponse;
    try {
      canonical = await accumulateChunksToResponse(
        decodeUpstreamStream(wire, resp.body, hop.providerModelId),
        hop.providerModelId,
      );
    } catch {
      recordTokens({ tokens_in: 0, tokens_out: 0 });
      return errorJson(502, "upstream stream ended before producing output");
    }
    recordTokens(tokensFromCanonical(canonical));
    return new Response(reencodeJson(canonical), {
      status: resp.status,
      headers: jsonHeaders,
    });
  }

  // Upstream returned JSON + client wants JSON (anthropic/kimi non-stream).
  // Decode for tokens + client re-encode; on parse/decode failure surface
  // the upstream payload verbatim rather than mangling it.
  const text = await resp.text();
  let upstreamJson: unknown;
  try {
    upstreamJson = JSON.parse(text);
  } catch {
    recordTokens({ tokens_in: 0, tokens_out: 0 });
    return new Response(text, {
      status: resp.status,
      headers: passthroughHeaders(resp),
    });
  }
  let canonical: TChatCompletionResponse;
  try {
    canonical = decodeUpstreamJson(wire, upstreamJson, hop.providerModelId);
  } catch {
    recordTokens({ tokens_in: 0, tokens_out: 0 });
    return new Response(text, {
      status: resp.status,
      headers: passthroughHeaders(resp),
    });
  }
  recordTokens(tokensFromCanonical(canonical));
  // Passthrough returns the upstream bytes verbatim; cross-wire re-encodes.
  return new Response(passthrough ? text : reencodeJson(canonical), {
    status: resp.status,
    headers: jsonHeaders,
  });
};

/**
 * Walk the plan and return the committed `Response`. The walker is the
 * daemon's ONLY data path — there is no core-backed fallback — so it
 * always answers with a Response (never throws; a bare throw would 500 the
 * user instead of surfacing a clean error). A request with no `?__plan=`
 * is a misuse of the daemon surface (clients reach it only via the
 * gateway's 307, which always carries a plan) → 400.
 */
export const runWalker = async (args: TWalkArgs): Promise<Response> => {
  const planModelIds = parsePlan(args.planParam);
  if (planModelIds.length === 0) {
    return errorJson(
      400,
      "the daemon /v1 surface expects a cloud-issued ?__plan= — point your client at the gateway, which 307s subscription chains here with the resolved plan",
    );
  }

  // Reject a forged plan: when the cloud configured a signing secret (so it
  // handed us a per-user key at bootstrap), the 307 MUST carry a valid `__sig`
  // over the full canonical payload (plan + pmids + origin). No key → unsigned
  // mode (dev), accept. (§9 + daemon-presence-without-heartbeat)
  const sigKey = planSigningKey();
  if (
    sigKey !== null &&
    !verifyPlanSignature(
      daemonPlanSigningPayload(
        args.planParam ?? "",
        args.pmidsParam ?? "",
        args.originParam ?? "",
      ),
      args.sigParam,
      sigKey,
    )
  ) {
    return errorJson(403, "invalid or missing __plan signature");
  }

  // The concrete upstream ids ride parallel to the plan — split WITHOUT
  // trimming empties so positions stay aligned (an empty entry = uncatalogued
  // hop, falls back inside resolveHop).
  const pmids = args.pmidsParam === null ? [] : args.pmidsParam.split(",");
  const hops = planModelIds.map((m, i) => resolveHop(m, pmids[i]));
  if (!canWalkPlan(hops)) {
    return errorJson(
      400,
      "the plan contains a subscription provider the daemon has no upstream for",
    );
  }

  // Canonical view of the inbound — used to detect openllm-managed
  // web_search on the transform paths (§5).
  const canonical = canonicalFromInbound(args.surface, args.rawBody);

  let lastError: string | null = null;
  for (const hop of hops) {
    const wire = UPSTREAM_WIRE[hop.provider];
    if (wire !== undefined) {
      const served = shouldInterceptWebSearch(wire, args.surface, canonical)
        ? await serveWithWebSearch(hop, wire, args, canonical)
        : await serveSubscription(hop, wire, args);
      if (served !== "retry") return served; // committed
      lastError = `subscription hop ${hop.modelId} failed pre-stream`;
      continue;
    }
    // API-key hop: forward to the cloud pinned to this concrete model.
    let resp: Response;
    try {
      resp = await forwardToCloud(
        args.req,
        args.rawBytes,
        hop.modelId,
        args.originParam,
      );
    } catch {
      lastError = `forward of ${hop.modelId} to cloud failed`;
      continue;
    }
    if (!resp.ok && retryable(resp.status)) {
      lastError = `cloud hop ${hop.modelId} returned ${resp.status}`;
      continue;
    }
    return new Response(resp.body, {
      status: resp.status,
      headers: passthroughHeaders(resp),
    });
  }
  // Every hop in the plan failed pre-stream.
  return errorJson(
    502,
    `all hops in the plan failed${lastError !== null ? ` (last: ${lastError})` : ""}`,
  );
};
