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

import type { TContextOverflowStrategy } from "@openllmsh/protocol";
import {
  AnthropicCountTokensRequest,
  AnthropicRequest,
  ChatCompletionRequest,
  ImageGenerationRequest,
  ResponsesRequest,
  VideoGenerationRequest,
} from "@openllmsh/protocol";
import { estimateBodyTokens } from "@openllmsh/wire/lib/canonical/token-estimate";
import { Schema } from "effect";
import { fetchPlan } from "./cloud-client";
import { planCacheEnabled } from "./config";
import { notePresenceActivity } from "./control-channel";
import { corsHeaders, errorJson, isPreflight, preflightResponse } from "./cors";
import { isSubscriptionSlug } from "./delegation";
import { passthroughToOrigin } from "./forward";
import { runImageWalker } from "./image-walker";
import { logWarn } from "./logger";
import {
  originFailureMessage,
  originFailureStatus,
  originFailureType,
  planFetchFailureAction,
} from "./net-error";
import { lookupPlan, storePlan } from "./plan-cache";
import { isBodylessVideoOp, videoOperationFor } from "./video-ops";
import {
  runVideoCancel,
  runVideoContent,
  runVideoCreate,
  runVideoPoll,
} from "./video-walker";
import {
  parsePlan,
  planSignatureOk,
  runCountTokens,
  runResponsesCompact,
  runWalker,
} from "./walker";

const parseAnthropicRequest = Schema.decodeUnknownSync(AnthropicRequest);
const parseOpenAIRequest = Schema.decodeUnknownSync(ChatCompletionRequest);
const parseImageRequest = Schema.decodeUnknownSync(ImageGenerationRequest);
const parseVideoRequest = Schema.decodeUnknownSync(VideoGenerationRequest);
const parseResponsesRequest = Schema.decodeUnknownSync(ResponsesRequest);
const parseCountTokensRequest = Schema.decodeUnknownSync(
  AnthropicCountTokensRequest,
);

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

const contextOverflowStrategyParam = (
  raw: string | null,
): TContextOverflowStrategy | null =>
  raw === "compact_in_place" ? "compact_in_place" : null;

export const handleInference = async (req: Request): Promise<Response> => {
  // CORS/PNA preflight — the dashboard fetches this surface cross-origin
  // (HTTPS page → http://127.0.0.1) for subscription models.
  if (isPreflight(req)) return preflightResponse(req);

  // A client pointed DIRECTLY at the daemon port is the strongest possible
  // liveness proof — republish presence (throttled, off the response path) so
  // the cloud can never hold this daemon offline while it is serving, which
  // would refuse the next subscription chain with `subscription_requires_daemon`.
  notePresenceActivity();

  const startedAt = Date.now();
  const url = new URL(req.url);
  // Codex's own compaction endpoint rides the responses surface but is a
  // verbatim vendor passthrough (`runResponsesCompact`) — no surface
  // schema, no walk.
  const isResponsesCompact = url.pathname.endsWith("/responses/compact");
  const isImages = url.pathname.endsWith("/images/generations");
  // Normalize the optional `/api` prefix once; reused for video routing + the
  // recorded `endpoint`.
  const normalizedPath = url.pathname.replace(/^\/api(?=\/v1\/)/, "");

  // Model listing is not an inference surface — the daemon holds no local
  // catalog, so a `GET /v1/models[...]` is passed straight through to the
  // cloud (same local-first passthrough as a pure-BYOK hop; the daemon's
  // paired key fills in when the caller sends none). Handled before the body
  // parse below, which assumes an inference request with a JSON body.
  if (req.method === "GET" && /^\/v1\/models(?:\/|$)/.test(normalizedPath)) {
    return withCors(req, await passthroughToOrigin(req, new ArrayBuffer(0)));
  }

  const { operation: videoOperation, videoId } = videoOperationFor(
    req.method,
    normalizedPath,
  );
  // Anthropic's PREFLIGHT, not inference. It must be matched BEFORE the
  // `/messages` test below (which it does not satisfy) or it falls through to
  // the `chat_completions` default and gets served as a real Opus generation —
  // see `runCountTokens` for what that cost us.
  const isCountTokens = url.pathname.endsWith("/messages/count_tokens");
  const surface: "chat_completions" | "messages" | "responses" =
    url.pathname.endsWith("/messages") || isCountTokens
      ? "messages"
      : url.pathname.endsWith("/responses") || isResponsesCompact
        ? "responses"
        : "chat_completions";
  const endpoint = normalizedPath;

  let rawBytes: ArrayBuffer;
  let rawBody: unknown;
  try {
    rawBytes = await req.arrayBuffer();
    rawBody = isBodylessVideoOp(videoOperation)
      ? null
      : JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return withCors(req, errorJson(400, "Body must be valid JSON"));
  }

  // Validate against the surface schema for a clean 400 — the walker
  // passes the body through (passthrough) or adapts it, so a malformed
  // body would otherwise surface as an opaque upstream/transform failure.
  // Compact bodies skip this: the vendor owns that contract and the call
  // is forwarded verbatim (strictness here would 400 shapes the upstream
  // accepts).
  try {
    if (isResponsesCompact) {
      // no-op — verbatim vendor passthrough
    } else if (isCountTokens) parseCountTokensRequest(rawBody);
    else if (videoOperation === "create") parseVideoRequest(rawBody);
    else if (isBodylessVideoOp(videoOperation)) {
      // no-op — id-addressed video ops carry no body (rawBody is null); the
      // signed plan rides the query string, so there's nothing to validate.
    } else if (isImages) parseImageRequest(rawBody);
    else if (surface === "messages") parseAnthropicRequest(rawBody);
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

  // Signed-plan cache (flag-gated rider — `plan-cache.ts`). A 307-borne
  // request remembers its signed tuple per model alias; a DIRECT request
  // (no `?__plan=`) within the TTL replays it, skipping the cloud round
  // trip. The walker verifies the signature either way, so the flag being
  // off (or a cache miss) is exactly the pre-rider flow: no plan → the
  // walker's clean 400.
  //
  // A tuple enters the cache ONLY after the same signature check the walker
  // enforces (unsigned accepted only in no-key dev mode), so a forged or
  // tampered tuple can never overwrite an entry. Residual scope, accepted:
  // the alias is NOT inside the signed payload (adding it would change the
  // canonical payload and fail-close every already-deployed daemon), so a
  // LOOPBACK caller could pair a genuinely-signed tuple with a different
  // `model` in the body — but this surface is 127.0.0.1 with the caller
  // owning the machine (see the module doc: no auth gate), and such a
  // caller can already address the daemon/cloud arbitrarily as themselves.
  let planParam = url.searchParams.get("__plan");
  let pmidsParam = url.searchParams.get("__pmids");
  let originParam = url.searchParams.get("__origin");
  let contextOverflowStrategy = contextOverflowStrategyParam(
    url.searchParams.get("__context_overflow_strategy"),
  );
  let sigParam = url.searchParams.get("__sig");
  const alias = (rawBody as { model?: unknown } | null)?.model;
  if (planCacheEnabled() && typeof alias === "string" && alias.length > 0) {
    if (planParam !== null) {
      if (
        planSignatureOk(
          planParam,
          pmidsParam,
          originParam,
          contextOverflowStrategy,
          sigParam,
        )
      ) {
        storePlan(alias, {
          planParam,
          pmidsParam,
          originParam,
          contextOverflowStrategy,
          sigParam,
        });
      }
    } else {
      const cached = lookupPlan(alias);
      if (cached !== null) {
        ({
          planParam,
          pmidsParam,
          originParam,
          contextOverflowStrategy,
          sigParam,
        } = cached);
      }
    }
  }

  // Local-first gateway (docs/proposals/local-first-gateway.md): a DIRECT
  // request (no `?__plan=` — the client's base URL is the daemon, baked at
  // install time by a `--gateway local` setup) that the plan cache didn't
  // cover. Fetch a signed plan from the origin (body never transits the
  // cloud), verify it with the SAME per-user key a 307 is verified with,
  // and walk it locally when it contains at least one subscription hop; a
  // pure-BYOK plan (and a failed fetch) passes through to the origin
  // verbatim — the cloud keeps its own fallback/cooldown machinery,
  // byte-identical to a directly-pointed client. 307-borne requests are
  // untouched by this branch.
  if (
    planParam === null &&
    !isResponsesCompact &&
    typeof alias === "string" &&
    alias.length > 0
  ) {
    let fetched: Awaited<ReturnType<typeof fetchPlan>> | null = null;
    try {
      fetched = await fetchPlan(alias, estimateBodyTokens(rawBody), req.signal);
    } catch (err) {
      const decision = planFetchFailureAction(err, req.signal);
      if (decision.action === "origin-error") {
        logWarn(
          "listener",
          `plan fetch ${decision.kind} for ${alias} — not repeating the same origin`,
        );
        return withCors(
          req,
          errorJson(
            originFailureStatus(decision.kind),
            originFailureMessage(decision.kind),
            originFailureType(decision.kind),
          ),
        );
      }
      if (decision.action === "throw") throw err;
      logWarn(
        "listener",
        `plan fetch failed for ${alias} — passing through to origin (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (fetched === null) {
      return withCors(req, await passthroughToOrigin(req, rawBytes));
    }
    const fetchedContextOverflowStrategy =
      fetched.context_overflow_strategy ?? null;
    const verified = planSignatureOk(
      fetched.plan,
      fetched.pmids,
      fetched.origin,
      fetchedContextOverflowStrategy,
      fetched.sig,
    );
    const hasSubscriptionHop =
      verified &&
      parsePlan(fetched.plan).some((entry) =>
        isSubscriptionSlug(entry.split("/")[0] ?? ""),
      );
    if (!verified || !hasSubscriptionHop) {
      // Unverifiable, or nothing for the box to serve — the origin is
      // strictly better placed to run this request.
      return withCors(req, await passthroughToOrigin(req, rawBytes));
    }
    planParam = fetched.plan;
    pmidsParam = fetched.pmids;
    originParam = fetched.origin;
    contextOverflowStrategy = fetchedContextOverflowStrategy;
    sigParam = fetched.sig;
    if (planCacheEnabled()) {
      storePlan(alias, {
        planParam,
        pmidsParam,
        originParam,
        contextOverflowStrategy,
        sigParam,
      });
    }
  }

  const walkArgs = {
    req,
    surface,
    endpoint,
    rawBody,
    rawBytes,
    planParam,
    pmidsParam,
    originParam,
    contextOverflowStrategy,
    sigParam,
    startedAt,
  };
  return withCors(
    req,
    await (videoOperation === "create"
      ? runVideoCreate(walkArgs)
      : videoOperation === "poll"
        ? runVideoPoll(walkArgs, videoId)
        : videoOperation === "content"
          ? runVideoContent(walkArgs, videoId)
          : videoOperation === "cancel"
            ? runVideoCancel(walkArgs, videoId)
            : isResponsesCompact
              ? runResponsesCompact(walkArgs)
              : isCountTokens
                ? runCountTokens(walkArgs)
                : isImages
                  ? runImageWalker(walkArgs)
                  : runWalker(walkArgs)),
  );
};
