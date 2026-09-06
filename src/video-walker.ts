import type {
  TVideoDeleted,
  TVideoGenerationRequest,
  TVideoIdPayload,
  TVideoJob,
  TVideoJobStatus,
} from "@openllmsh/protocol";
import {
  decodeVideoId,
  encodeVideoId,
  normalizeContentType,
  VideoGenerationRequest,
} from "@openllmsh/protocol";
import { originatorHeadersFrom } from "@openllmsh/wire/lib/forwarded-headers";
import { Schema } from "effect";
import { uploadMedia } from "./cloud-client";
import { errorJson } from "./cors";
import { getDelegate, isSubscriptionSlug } from "./delegation";
import { logWarn } from "./logger";
import type { TWalkArgs } from "./walker";
import {
  coolHopAfterStaleRefresh,
  parsePlan,
  passthroughHeaders,
  planSignatureOk,
  postUpstream,
  report,
  resolveHop,
  statusFor,
} from "./walker";

const parseVideoRequest = Schema.decodeUnknownSync(VideoGenerationRequest);

type TVideoUpstream = {
  readonly headers: Record<string, string>;
  readonly url: string;
  readonly accountHash: string | null;
};

type TXaiVideoStatus = {
  readonly status?: unknown;
  readonly progress?: unknown;
  readonly video?: { readonly url?: unknown };
  readonly error?: { readonly message?: unknown } | string;
};

export const acquireVideoUpstream = async (
  provider: string,
  args: TWalkArgs,
  hop: { readonly provider: string; readonly modelId: string },
  walkSessionKey?: string,
): Promise<TVideoUpstream | "retry"> => {
  const delegate = getDelegate(provider);
  if (delegate?.credentialForVideo === undefined) return "retry";
  try {
    const cred = await delegate.credentialForVideo(args.req.headers);
    if (cred.stale_refresh !== undefined) {
      coolHopAfterStaleRefresh(hop, cred.stale_refresh, walkSessionKey);
      return "retry";
    }
    return {
      headers: {
        ...originatorHeadersFrom(args.req.headers),
        ...cred.headers,
        authorization: `Bearer ${cred.access_token}`,
      },
      url: cred.url.replace(/\/+$/, ""),
      accountHash: cred.account_hash ?? null,
    };
  } catch {
    return "retry";
  }
};

const videoHop = (
  args: TWalkArgs,
): ReturnType<typeof resolveHop> | undefined => {
  const pmids = args.pmidsParam === null ? [] : args.pmidsParam.split(",");
  return parsePlan(args.planParam)
    .map((modelId, index) => resolveHop(modelId, pmids[index]))
    .find((candidate) => {
      const delegate = getDelegate(candidate.provider);
      return (
        isSubscriptionSlug(candidate.provider) &&
        delegate?.credentialForVideo !== undefined
      );
    });
};

const signedPlanError = (args: TWalkArgs): Response | null => {
  if (
    !planSignatureOk(
      args.planParam,
      args.pmidsParam,
      args.originParam,
      args.contextOverflowStrategy ?? null,
      args.sigParam,
    )
  ) {
    return errorJson(403, "invalid or missing __plan signature");
  }
  if (args.planParam === null)
    return errorJson(400, "videos require a daemon plan");
  return null;
};

const upstreamError = async (resp: Response): Promise<Response> => {
  const body = await resp.text().catch(() => "");
  return new Response(body.length > 0 ? body : null, {
    status: resp.status,
    headers: passthroughHeaders(resp),
  });
};

const responseJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const xaiStatus = (body: unknown): TXaiVideoStatus | null =>
  body !== null && typeof body === "object" ? (body as TXaiVideoStatus) : null;

const errorMessageFrom = (status: TXaiVideoStatus): string | undefined => {
  if (typeof status.error === "string") return status.error;
  return typeof status.error?.message === "string"
    ? status.error.message
    : undefined;
};

const upstreamHeaders = (headers: Record<string, string>): Headers =>
  new Headers({ ...headers, accept: "application/json" });

const videoRequestIdFrom = (body: unknown): string | null => {
  if (body === null || typeof body !== "object") return null;
  const requestId = (body as { readonly request_id?: unknown }).request_id;
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : null;
};

/**
 * Derive Grok's `aspect_ratio` from a `WIDTHxHEIGHT` size by reducing the
 * ratio; defaults to `1:1` when the size is absent or unparsable. (Video needs
 * its own W:H derivation — the image walker's `sizeToAspect` only recognizes a
 * few fixed image sizes and would map, e.g., 1280x720 to 1:1.)
 */
export const videoAspectRatio = (size?: string): string => {
  const match = size?.match(/^(\d+)x(\d+)$/i);
  if (!match) return "1:1";
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!(width > 0 && height > 0)) return "1:1";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
};

/** Map xAI's asynchronous video statuses to OpenLLM's job lifecycle. */
export const mapVideoStatus = (status: unknown): TVideoJobStatus => {
  if (status === "done") return "completed";
  if (status === "failed" || status === "expired") return "failed";
  return status === "queued" ? "queued" : "in_progress";
};

/** Select Grok's required output resolution from a WIDTHxHEIGHT size. */
export const sizeToResolution = (size?: string): string => {
  const height = size?.match(/^\d+x(\d+)$/i)?.[1];
  return height !== undefined && Number.parseInt(height, 10) >= 720
    ? "720p"
    : "480p";
};

/** Build the provider-native video generation request without performing I/O. */
export const buildVideoUpstreamBody = (
  provider: string,
  req: TVideoGenerationRequest,
  providerModelId: string,
): Record<string, unknown> => {
  if (provider !== "grok") {
    throw new Error(`Unsupported subscription video provider: ${provider}`);
  }
  // Only forward `duration` when `seconds` is a whole positive-integer string.
  // Require a full `\d+` match so "6.5"/"6junk" are omitted rather than
  // truncated to 6; `parseInt` alone would forward a wrong value.
  const duration =
    req.seconds !== undefined && /^\d+$/.test(req.seconds)
      ? Number.parseInt(req.seconds, 10)
      : Number.NaN;
  return {
    model: providerModelId,
    prompt: req.prompt,
    ...(req.input_image !== undefined
      ? { image: { url: req.input_image } }
      : {}),
    ...(req.reference_images !== undefined && req.reference_images.length > 0
      ? { reference_images: req.reference_images.map((url) => ({ url })) }
      : {}),
    ...(req.reference_voices !== undefined && req.reference_voices.length > 0
      ? {
          reference_audios: req.reference_voices.map((voice_id) => ({
            voice_id,
          })),
        }
      : {}),
    ...(Number.isInteger(duration) && duration > 0 ? { duration } : {}),
    aspect_ratio: videoAspectRatio(req.size),
    resolution: sizeToResolution(req.size),
  };
};

const reportVideo = (
  args: TWalkArgs,
  provider: string,
  model: string,
  httpStatus: number,
  accountHash: string | null,
): void => {
  report(
    {
      model,
      provider,
      status: statusFor(httpStatus),
      tokens_in: 0,
      tokens_out: 0,
      latency_ms: Date.now() - args.startedAt,
      endpoint: args.endpoint,
      ...(accountHash !== null ? { account_hash: accountHash } : {}),
    },
    args.originParam,
  );
};

const decodeJob = (videoId: string | undefined): TVideoIdPayload | Response => {
  if (videoId === undefined) return errorJson(404, "No such video");
  const payload = decodeVideoId(videoId);
  return payload ?? errorJson(404, `No such video: ${videoId}`);
};

// Bound a single xAI status GET so a hung upstream can't stall the poll —
// combined with the client's own abort signal (same pattern as cloud-client).
const VIDEO_STATUS_TIMEOUT_MS = 30_000;

// Bound the presigned MP4 download so a hung transfer can't stall indefinitely
// even if the client stays connected. Generous — a Grok clip is ≤15s of video,
// so a real download finishes well inside this.
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

const getStatus = async (
  args: TWalkArgs,
  upstream: TVideoUpstream,
  payload: TVideoIdPayload,
): Promise<Response | TXaiVideoStatus> => {
  let resp: Response;
  try {
    resp = await (args.fetchImpl ?? fetch)(
      `${upstream.url}/videos/${encodeURIComponent(payload.u)}`,
      {
        method: "GET",
        headers: upstreamHeaders(upstream.headers),
        signal: AbortSignal.any([
          args.req.signal,
          AbortSignal.timeout(VIDEO_STATUS_TIMEOUT_MS),
        ]),
      },
    );
  } catch {
    return args.req.signal.aborted
      ? errorJson(499, "client aborted request")
      : errorJson(502, "upstream video provider is unreachable");
  }
  if (!resp.ok) return upstreamError(resp);
  try {
    const body = xaiStatus(await resp.json());
    return (
      body ?? errorJson(502, "upstream video provider returned invalid JSON")
    );
  } catch {
    return errorJson(502, "upstream video provider returned invalid JSON");
  }
};

export const runVideoCreate = async (args: TWalkArgs): Promise<Response> => {
  const signatureError = signedPlanError(args);
  if (signatureError !== null) return signatureError;

  let request: TVideoGenerationRequest;
  try {
    request = parseVideoRequest(args.rawBody);
  } catch (err) {
    return errorJson(
      400,
      err instanceof Error ? err.message : "Invalid video generation request",
    );
  }
  const hop = videoHop(args);
  if (hop === undefined) {
    return errorJson(
      404,
      "No subscription video provider in the daemon plan can serve this request",
    );
  }
  const upstream = await acquireVideoUpstream(hop.provider, args, hop);
  if (upstream === "retry") {
    return errorJson(404, `No video credential available for ${hop.provider}`);
  }

  let body: Record<string, unknown>;
  try {
    body = buildVideoUpstreamBody(hop.provider, request, hop.providerModelId);
  } catch (err) {
    return errorJson(
      400,
      err instanceof Error ? err.message : "Unsupported video provider",
    );
  }
  const resp = await postUpstream(
    `${upstream.url}/videos/generations`,
    {
      method: "POST",
      headers: {
        ...upstream.headers,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: args.req.signal,
    },
    // `postUpstream` makes exactly one attempt — correct for a non-idempotent
    // video job (a retry could enqueue a second render / double-spend quota).
  );
  if (resp === null) {
    return args.req.signal.aborted
      ? errorJson(499, "client aborted request")
      : errorJson(502, "upstream video provider is unreachable");
  }
  if (!resp.ok) {
    reportVideo(
      args,
      hop.provider,
      hop.modelId,
      resp.status,
      upstream.accountHash,
    );
    return upstreamError(resp);
  }

  let requestId: string | null;
  try {
    requestId = videoRequestIdFrom(await resp.json());
  } catch {
    requestId = null;
  }
  if (requestId === null) {
    return errorJson(502, "upstream video provider returned no request_id");
  }
  const createdAt = Math.floor(Date.now() / 1000);
  const job: TVideoJob = {
    id: encodeVideoId({
      p: hop.provider,
      u: requestId,
      m: hop.modelId,
      c: createdAt,
    }),
    object: "video",
    created_at: createdAt,
    status: "queued",
    model: hop.modelId,
    progress: 0,
    ...(request.seconds !== undefined ? { seconds: request.seconds } : {}),
    ...(request.size !== undefined ? { size: request.size } : {}),
  };
  reportVideo(
    args,
    hop.provider,
    hop.modelId,
    resp.status,
    upstream.accountHash,
  );
  return responseJson(job);
};

export const runVideoPoll = async (
  args: TWalkArgs,
  videoId?: string,
): Promise<Response> => {
  const signatureError = signedPlanError(args);
  if (signatureError !== null) return signatureError;
  const payload = decodeJob(videoId);
  if (payload instanceof Response) return payload;
  const hop = videoHop(args);
  if (hop === undefined)
    return errorJson(404, "No subscription video provider available");
  const upstream = await acquireVideoUpstream(hop.provider, args, hop);
  if (upstream === "retry")
    return errorJson(404, `No video credential available for ${hop.provider}`);
  const status = await getStatus(args, upstream, payload);
  if (status instanceof Response) return status;
  const errorMessage = errorMessageFrom(status);
  const job: TVideoJob = {
    id: videoId ?? "",
    object: "video",
    created_at: payload.c,
    status: mapVideoStatus(status.status),
    model: payload.m,
    ...(typeof status.progress === "number"
      ? { progress: status.progress }
      : {}),
    ...(errorMessage !== undefined ? { error: { message: errorMessage } } : {}),
  };
  return responseJson(job);
};

export const runVideoContent = async (
  args: TWalkArgs,
  videoId?: string,
): Promise<Response> => {
  const signatureError = signedPlanError(args);
  if (signatureError !== null) return signatureError;
  const payload = decodeJob(videoId);
  if (payload instanceof Response) return payload;
  const hop = videoHop(args);
  if (hop === undefined)
    return errorJson(404, "No subscription video provider available");
  const upstream = await acquireVideoUpstream(hop.provider, args, hop);
  if (upstream === "retry")
    return errorJson(404, `No video credential available for ${hop.provider}`);
  const status = await getStatus(args, upstream, payload);
  if (status instanceof Response) return status;
  if (status.status !== "done") {
    return errorJson(
      409,
      `Video is not ready yet (status: ${typeof status.status === "string" ? status.status : "unknown"}). Poll GET /v1/videos/${videoId} until it completes.`,
    );
  }
  const contentUrl = status.video?.url;
  if (typeof contentUrl !== "string" || contentUrl.length === 0) {
    return errorJson(502, "Completed video has no downloadable content URL");
  }
  let content: Response;
  try {
    // NOT tied to `args.req.signal`: the client (e.g. the browser tool) cancels
    // the response body as soon as it has read the durable-url header, which
    // aborts the inbound request. If this download were bound to that signal the
    // teed persist branch would die mid-flight and nothing would ever land in the
    // library. A timeout alone bounds it so persistence completes regardless.
    content = await (args.fetchImpl ?? fetch)(contentUrl, {
      method: "GET",
      signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    return args.req.signal.aborted
      ? errorJson(499, "client aborted request")
      : errorJson(502, "video download is unreachable");
  }
  if (!content.ok) return upstreamError(content);

  const body = content.body;
  if (body === null) {
    return errorJson(502, "upstream video has no content body");
  }

  const id = videoId;
  if (id === undefined) {
    return errorJson(404, "No such video");
  }
  // This is a video content endpoint, so the payload IS a video. Pin a video
  // content-type when the upstream CDN serves a generic one (e.g.
  // application/octet-stream): the library allowlist keys on the exact type,
  // and the ingest rejects an x-media-kind that disagrees with the content-type
  // — a non-video type would fail-close a legitimate video.
  const rawContentType = normalizeContentType(
    content.headers.get("content-type"),
    "video/mp4",
  );
  const contentType = rawContentType.startsWith("video/")
    ? rawContentType
    : "video/mp4";
  const [clientBranch, persistBranch] = body.tee();

  void (async () => {
    const bytes = await new Response(persistBranch).arrayBuffer();
    await uploadMedia(
      bytes,
      {
        contentType,
        kind: "video",
        sourceRef: videoId,
        id,
      },
      args.originParam,
    );
  })().catch((err) => {
    logWarn("video-walker", "Failed to persist generated video", {
      error: err instanceof Error ? err.message : String(err),
      videoId,
    });
  });

  const durable = args.originParam
    ? `${args.originParam}/api/media/${id}`
    : null;

  const responseHeaders: Record<string, string> = {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-openllm-media-id": id,
  };
  if (durable !== null) {
    responseHeaders["x-openllm-media-url"] = durable;
  }

  return new Response(clientBranch, {
    status: 200,
    headers: responseHeaders,
  });
};

export const runVideoCancel = async (
  args: TWalkArgs,
  videoId?: string,
): Promise<Response> => {
  const signatureError = signedPlanError(args);
  if (signatureError !== null) return signatureError;
  const payload = decodeJob(videoId);
  if (payload instanceof Response) return payload;
  const hop = videoHop(args);
  if (hop !== undefined) {
    const upstream = await acquireVideoUpstream(hop.provider, args, hop);
    if (upstream !== "retry") {
      await fetch(`${upstream.url}/videos/${encodeURIComponent(payload.u)}`, {
        method: "DELETE",
        headers: upstreamHeaders(upstream.headers),
        signal: AbortSignal.any([
          args.req.signal,
          AbortSignal.timeout(VIDEO_STATUS_TIMEOUT_MS),
        ]),
      }).catch(() => {});
    }
  }
  const deleted: TVideoDeleted = {
    id: videoId ?? "",
    object: "video.deleted",
    deleted: true,
  };
  return responseJson(deleted);
};
