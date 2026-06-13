/**
 * The daemon's local `/v1/*` inference surface. Mirrors the cloud's
 * OpenAI/Anthropic-compatible endpoints, served LOCALLY by the
 * `@openllm/core`-free `walker.ts` (subscription hops run on the official
 * CLI's credential; API-key hops are forwarded to the cloud).
 *
 * Single flow: a client points at the gateway, the gateway 307s a
 * subscription-involving chain here with the resolved `?__plan=`, and the
 * walker executes that plan. The daemon holds NO routing brain of its own
 * — without a `?__plan=` there is nothing to walk, so it answers 400
 * (there is no legacy "daemon resolves its own chain" path).
 *
 * The daemon binds to 127.0.0.1 and the caller owns the machine, so there
 * is no API-key auth gate here (unlike the cloud handler).
 */

import {
  AnthropicRequest,
  ChatCompletionRequest,
  ResponsesRequest,
} from "@quantidexyz/openllmp";
import { Schema } from "effect";
import { corsHeaders, errorJson, isPreflight, preflightResponse } from "./cors";
import { runWalker } from "./walker";

const parseAnthropicRequest = Schema.decodeUnknownSync(AnthropicRequest);
const parseOpenAIRequest = Schema.decodeUnknownSync(ChatCompletionRequest);
const parseResponsesRequest = Schema.decodeUnknownSync(ResponsesRequest);

/**
 * Add CORS headers to a response WITHOUT consuming its body, so streaming
 * (SSE) responses keep streaming. The dashboard browser calls this
 * localhost surface cross-origin, so every `/v1/*` response needs them.
 */
const withCors = (req: Request, res: Response): Response => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};

export const handleInference = async (req: Request): Promise<Response> => {
  // CORS/PNA preflight — the dashboard fetches this surface cross-origin
  // (HTTPS page → http://127.0.0.1) for subscription models.
  if (isPreflight(req)) return preflightResponse(req);

  const startedAt = Date.now();
  const url = new URL(req.url);
  const surface: "chat_completions" | "messages" | "responses" =
    url.pathname.endsWith("/messages")
      ? "messages"
      : url.pathname.endsWith("/responses")
        ? "responses"
        : "chat_completions";
  const endpoint = url.pathname.replace(/^\/api(?=\/v1\/)/, "");

  let rawBytes: ArrayBuffer;
  let rawBody: unknown;
  try {
    rawBytes = await req.arrayBuffer();
    rawBody = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return withCors(req, errorJson(400, "Body must be valid JSON"));
  }

  // Validate against the surface schema for a clean 400 — the walker
  // passes the body through (passthrough) or adapts it, so a malformed
  // body would otherwise surface as an opaque upstream/transform failure.
  try {
    if (surface === "messages") parseAnthropicRequest(rawBody);
    else if (surface === "responses") parseResponsesRequest(rawBody);
    else parseOpenAIRequest(rawBody);
  } catch (err) {
    return withCors(
      req,
      errorJson(
        400,
        err instanceof Error ? err.message : "Invalid request body",
      ),
    );
  }

  return withCors(
    req,
    await runWalker({
      req,
      surface,
      endpoint,
      rawBody,
      rawBytes,
      planParam: url.searchParams.get("__plan"),
      pmidsParam: url.searchParams.get("__pmids"),
      originParam: url.searchParams.get("__origin"),
      sigParam: url.searchParams.get("__sig"),
      startedAt,
    }),
  );
};
