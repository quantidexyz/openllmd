/**
 * Client-wire encoders — pick the right re-encode for the caller's surface.
 *
 * A committed canonical response/stream must be handed back on the SAME wire
 * the client spoke: `responses` clients get the Responses shape, Anthropic-wire
 * (`messages`) clients get Anthropic, everyone else the OpenAI ChatCompletion
 * shape. This selection was copy-pasted across the walker's manual transport
 * and the native serve/tool bridges (three copies each of the JSON and the SSE
 * ternary) — centralising it here keeps them from drifting.
 */

import type {
  TChatCompletionChunk,
  TChatCompletionResponse,
  THeartbeatOptions,
} from "@openllmsh/protocol";
import { toAnthropicMessagesResponse } from "@openllmsh/wire/adapters/messages/response";
import { chunksToMessagesSseBytes } from "@openllmsh/wire/adapters/messages/streaming";
import {
  chunksToResponsesSseBytes,
  toResponsesResponse,
} from "@openllmsh/wire/adapters/responses";
import { accumulateChunksToResponse } from "@openllmsh/wire/lib/streaming/accumulate";
import { chunksToSseBytes } from "@openllmsh/wire/lib/streaming/provider-decode";
import { withFrameAlignedHeartbeat } from "@openllmsh/wire/lib/streaming/sse";
import {
  stripIsolationFromChunks,
  stripIsolationFromResponse,
} from "@openllmsh/wire/lib/strip-subagent-isolation";

export type TClientSurface = "chat_completions" | "messages" | "responses";

/** Frame-aligned heartbeat options for a client surface — ONE literal shared
 *  by the walker's manual transport and the native serve/tool bridges so the
 *  interval + per-surface beat kind can't drift. */
export const heartbeatOptionsFor = (
  surface: TClientSurface,
): THeartbeatOptions => ({
  intervalMs: 15_000,
  kind: surface === "messages" ? "anthropic_ping" : "comment",
});
/** Matches `clientWireOf`'s return (`TUpstreamWire`). Only `anthropic`/`openai`
 *  occur for a real client wire; the `=== "anthropic"` branch handles both. */
export type TClientWire = "anthropic" | "chatgpt" | "openai";

/** Encode a canonical chunk stream to the client's wire as SSE bytes. */
export const sseBytesForClient = (
  chunks: ReadableStream<TChatCompletionChunk>,
  surface: TClientSurface,
  clientWire: TClientWire,
): ReadableStream<Uint8Array> =>
  surface === "responses"
    ? chunksToResponsesSseBytes(chunks)
    : clientWire === "anthropic"
      ? chunksToMessagesSseBytes(chunks)
      : chunksToSseBytes(chunks);

/** Re-encode a canonical response to the client's wire (the JSON body). */
export const jsonBodyForClient = (
  canonical: TChatCompletionResponse,
  surface: TClientSurface,
  clientWire: TClientWire,
): unknown =>
  surface === "responses"
    ? toResponsesResponse(canonical)
    : clientWire === "anthropic"
      ? toAnthropicMessagesResponse(canonical)
      : canonical;

// ─── Shared delivery tail (sub-method-simplified-execution.md §2) ───────────
//
// Both subscription execution methods end the same way: a COMMITTED canonical
// chunk stream (or accumulated response) is metered off a tee'd branch and
// re-encoded onto the client's wire with the same headers/heartbeat. This tail
// used to exist twice (the walker's manual transport + native-runtime/serve);
// the methods now differ only in how they PRODUCE the canonical stream.

/** SSE response headers — one literal for both execution methods. */
export const SSE_RESPONSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

export type TDeliverStreamParams = {
  readonly surface: TClientSurface;
  readonly clientWire: TClientWire;
  readonly providerModelId: string;
  /** Response status (the upstream's on the manual path; 200 on native). */
  readonly status?: number;
  /** The accumulated canonical response off the meter branch — record tokens
   *  (and, on the native path, advance the session) here. */
  readonly onResponse: (resp: TChatCompletionResponse) => void;
  /** The meter branch failed before accumulating (the client branch already
   *  streams independently) — record the error row here. Receives the failure
   *  so the row can carry WHY: the caller is the only place that reason is
   *  still available, and a row without it is not debuggable. */
  readonly onError: (error: unknown) => void;
  /** Apply the catalog-gated subagent-control repair on the client branch. */
  readonly stripSubagentIsolation?: boolean;
};

/**
 * Encode a canonical chunk stream as the client's SSE `Response` — client-wire
 * bytes + frame-aligned heartbeat + the shared SSE headers. No metering: use
 * this directly only when the tokens are already accounted for (the tool
 * bridges); a live upstream stream goes through {@link deliverChunkStream}.
 */
export const sseResponseForClient = (
  chunks: ReadableStream<TChatCompletionChunk>,
  surface: TClientSurface,
  clientWire: TClientWire,
  status?: number,
  stripSubagentIsolation = false,
): Response =>
  new Response(
    withFrameAlignedHeartbeat(
      sseBytesForClient(
        stripSubagentIsolation ? stripIsolationFromChunks(chunks) : chunks,
        surface,
        clientWire,
      ),
      heartbeatOptionsFor(surface),
    ),
    { status: status ?? 200, headers: SSE_RESPONSE_HEADERS },
  );

/**
 * Deliver a COMMITTED canonical chunk stream to a STREAMING client: tee →
 * meter one branch (accumulate → `onResponse`/`onError`, never blocking the
 * client) → re-encode the other onto the client wire with the frame-aligned
 * heartbeat and the shared SSE headers.
 */
const abortReason = (reason: unknown): Error => {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error(
    reason === undefined || reason === ""
      ? "The operation was aborted."
      : String(reason),
  );
  err.name = "AbortError";
  return err;
};

const viewOfReader = (
  reader: ReadableStreamDefaultReader<TChatCompletionChunk>,
  onCancel?: (reason: unknown) => void,
): ReadableStream<TChatCompletionChunk> =>
  new ReadableStream<TChatCompletionChunk>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      if (onCancel !== undefined) {
        onCancel(reason);
        return;
      }
      void reader.cancel(reason).catch(() => {});
    },
  });

export const deliverChunkStream = (
  chunks: ReadableStream<TChatCompletionChunk>,
  params: TDeliverStreamParams,
): Response => {
  const [toClient, toMeter] = chunks.tee();
  const clientReader = toClient.getReader();
  const meterReader = toMeter.getReader();
  let teeCancelled = false;
  const cancelTee = (reason: unknown): void => {
    if (teeCancelled) return;
    teeCancelled = true;
    const abort = abortReason(reason);
    void clientReader.cancel(abort).catch(() => {});
    void meterReader.cancel(abort).catch(() => {});
  };
  void accumulateChunksToResponse(
    viewOfReader(meterReader),
    params.providerModelId,
  )
    .then(params.onResponse)
    .catch((err: unknown) => {
      params.onError(err);
    });
  return sseResponseForClient(
    viewOfReader(clientReader, cancelTee),
    params.surface,
    params.clientWire,
    params.status,
    params.stripSubagentIsolation ?? false,
  );
};

/** Deliver an accumulated canonical response to a JSON client. */
export const deliverJsonResponse = (
  canonical: TChatCompletionResponse,
  surface: TClientSurface,
  clientWire: TClientWire,
  status?: number,
  stripSubagentIsolation = false,
): Response =>
  new Response(
    JSON.stringify(
      jsonBodyForClient(
        stripSubagentIsolation
          ? stripIsolationFromResponse(canonical)
          : canonical,
        surface,
        clientWire,
      ),
    ),
    {
      status: status ?? 200,
      headers: { "content-type": "application/json" },
    },
  );
