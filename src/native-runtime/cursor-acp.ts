/**
 * Cursor ACP bridge — executes a `cursor` hop through the OFFICIAL
 * `cursor-agent acp` runtime (Agent Client Protocol v1). Cursor has NO manual
 * HTTP inference path (api2.cursor.sh is a dashboard host, not a model
 * endpoint), so this bridge is the provider's ONLY transport.
 *
 * Protocol facts VERIFIED LIVE against `cursor-agent 2026.07.23-e383d2b`:
 * newline-delimited JSON-RPC 2.0 over stdio (WITH the `"jsonrpc":"2.0"`
 * field, unlike the Codex app-server); flow per turn:
 *
 *   initialize            → { protocolVersion: 1, clientCapabilities, clientInfo }
 *   authenticate          → { methodId: "cursor_login" } (the CLI's own stored
 *                           login — fails when not logged in → bridge decline)
 *   session/new           → { cwd, mcpServers } → { sessionId, models:
 *                           { availableModels: [{ modelId, name }] }, modes }
 *                           (mcpServers carries the per-request loopback HTTP
 *                           MCP server exposing CLIENT tools — see
 *                           cursor-mcp-server.ts)
 *   session/set_model     → { sessionId, modelId } (best-effort; failure is
 *                           non-fatal — the session runs on Cursor's default)
 *   session/prompt        → { sessionId, prompt: [{ type: "text", text },
 *                           { type: "image", data, mimeType }...] };
 *                           resolves with { stopReason } when the turn ENDS
 *   session/update NOTIF  → { sessionId, update: { sessionUpdate:
 *                           "agent_message_chunk" | "agent_thought_chunk",
 *                           content: { type: "text", text } } } (plus
 *                           tool_call / plan / info updates — Cursor's NATIVE
 *                           agent tools; never surfaced as OpenAI tool_calls)
 *   session/cancel NOTIF  → { sessionId } on client abort / tool cutover
 *
 * v1 scope: one COLD ACP session per request (the conversation is flattened
 * by `cursorRequestOf`; the run result's `sessionId()` is always null so the
 * session store records nothing). Serves text + images + structured output +
 * CLIENT function tools:
 *   - images ride as ACP image prompt blocks (base64 + mimeType);
 *   - structured output is a prompt-embedded instruction + local JSON
 *     extraction of the buffered reply (no protocol channel exists);
 *   - client tools ride the loopback MCP server; the FIRST agent tools/call
 *     ends the turn with OpenAI `tool_calls` semantics (session cancelled,
 *     client executes and resends with tool-role results, which the renderer
 *     folds back in). Correct OpenAI semantics at the cost of a cold session
 *     per tool round — the documented v1 tradeoff.
 * TODO(cursor-resume): prefix-hash session resume via ACP `session/load`
 * (`loadSession: true` is advertised) — follow-up, not v1.
 *
 * ACP reports NO token usage; the terminal chunk carries a `chars/4`
 * ESTIMATE (`estimateBodyTokens`, the walker's own routing ruler) so the
 * recorder gets non-zero figures instead of silent zeros.
 */

import { existsSync } from "node:fs";
import type { TChatCompletionChunk, TUsage } from "@openllmsh/protocol";
import { estimateBodyTokens } from "@openllmsh/wire/lib/canonical/token-estimate";
import { spawnCwd } from "../delegation/util";
import { logError, logInfo, logWarn } from "../logger";
import { sandboxSpawnArgs } from "../sandbox/exec";
import { unwrapKeychainSpawn } from "../sandbox/policy";
import { DAEMON_VERSION } from "../version";
import type { TCursorMcpServer } from "./cursor-mcp-server";
import { startCursorMcpServer } from "./cursor-mcp-server";
import {
  cursorNativeModelGeneration,
  observeCursorNativeModelsFromSession,
  parseCursorListAvailableModels,
  takeCursorNativeModelObservationTicket,
} from "./cursor-model-observation";
import type { TCursorImage, TCursorTool } from "./cursor-request";
import { acpPromptBlocks, extractJsonObject } from "./cursor-request";
import type { TNativeRunResult } from "./types";
import { cleanNativeSpawnEnv, PRE_COMMIT_TIMEOUT_MS } from "./types";

/** Handshake RPC budget (initialize / authenticate / session/new). */
const RPC_TIMEOUT_MS = 30_000;

type TAcpErrorKind = "rpc" | "timeout" | "transport";

/** Typed ACP request failure so setup declines can tell an explicit
 *  authenticate rejection from a timeout/crash/transport drop. */
class AcpRpcError extends Error {
  readonly method: string;
  readonly kind: TAcpErrorKind;
  readonly rpcCode: number | undefined;

  constructor(opts: {
    readonly method: string;
    readonly kind: TAcpErrorKind;
    readonly message: string;
    readonly rpcCode?: number;
  }) {
    super(opts.message);
    this.name = "AcpRpcError";
    this.method = opts.method;
    this.kind = opts.kind;
    this.rpcCode = opts.rpcCode;
  }
}

/** Vendor JSON-RPC authenticate errors that mean the stored login was
 *  rejected — not a timeout, child exit, or generic protocol failure. */
const AUTHENTICATE_REJECTION_RE =
  /not logged in|not signed in|unauthorized|unauthenticated|authentication (?:failed|rejected)|auth(?:entication)? rejected|please (?:log|sign)[\s-]?in/i;

const isExplicitAuthenticateRejection = (error: unknown): boolean =>
  error instanceof AcpRpcError &&
  error.method === "authenticate" &&
  error.kind === "rpc" &&
  AUTHENTICATE_REJECTION_RE.test(error.message);

/** Cap on the retained stderr tail (bytes) used for failure diagnostics. */
const STDERR_TAIL_MAX = 4_096;
/** Hard per-turn budget — the prompt is abandoned (child killed) past this. */
export const CURSOR_TURN_TIMEOUT_MS = 180_000;
/** Idle-chunk budget — no session/update within this window kills the turn. */
export const CURSOR_IDLE_TIMEOUT_MS = 60_000;

type TJsonRpcId = number;

/** One inbound JSON-RPC frame (response or notification). */
export type TAcpInbound = {
  readonly id?: TJsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string; readonly code?: number };
};

/**
 * Parse one newline-delimited frame. Malformed lines (non-JSON stdout noise,
 * non-object values) return null — the pump skips them, never crashes.
 */
export const parseAcpLine = (line: string): TAcpInbound | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as TAcpInbound;
  } catch {
    return null;
  }
};

/** The text payload of a `session/update` content block, or null. */
const updateText = (content: unknown): string | null => {
  if (typeof content !== "object" || content === null) return null;
  const c = content as { readonly type?: unknown; readonly text?: unknown };
  return c.type === "text" && typeof c.text === "string" ? c.text : null;
};

/**
 * The per-turn chunk mapper: `session/update` payloads → canonical chunks.
 * `agent_message_chunk` → content deltas (with the role-opener on first
 * output); `agent_thought_chunk` → `reasoning_content` deltas (the canonical
 * delta models reasoning natively — see `protocol/chat.ts`); everything else
 * (tool_call, plan, info updates) is ignored in v1.
 *
 * Two non-text modes reshape the tail:
 *   - JSON mode (`response_format` json_object / json_schema): visible content
 *     is BUFFERED (not streamed) and `finish` emits ONE content chunk with the
 *     first balanced JSON object extracted from the reply (raw text on
 *     extraction failure — never errors).
 *   - Tool mode: the loopback MCP server calls `emitToolCall`, which yields an
 *     OpenAI `tool_calls` delta + a `finish_reason: "tool_calls"` terminal.
 *
 * `finish` / `emitToolCall` return chunk ARRAYS (JSON mode needs two).
 * Exported for tests (fabricated sequences).
 */
export type TAcpTurnState = {
  /** Map one `session/update`'s `update` value; null → nothing to emit. */
  readonly handleUpdate: (update: unknown) => TChatCompletionChunk | null;
  /** The terminal chunk(s): estimated usage + finish_reason (+ buffered JSON
   *  content in json mode). */
  readonly finish: (stopReason: string | null) => TChatCompletionChunk[];
  /** The `tool_calls` terminal for one agent tool invocation. */
  readonly emitToolCall: (
    name: string,
    args: unknown,
  ) => TChatCompletionChunk[];
  /** Whether any model OUTPUT (content or thought) was observed. */
  readonly sawOutput: () => boolean;
  /** Accumulated visible content chars (usage estimation input). */
  readonly contentChars: () => number;
};

export const createAcpTurnState = (params: {
  readonly providerModelId: string;
  /** Prompt text fed to the session — the input side of the usage estimate. */
  readonly promptText: string;
  /** Buffer + JSON-extract the reply instead of streaming it. */
  readonly jsonMode?: boolean;
}): TAcpTurnState => {
  const created = Math.floor(Date.now() / 1000);
  const chunkId = `chatcmpl-cursor-${created.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let sawOutput = false;
  let outputChars = 0;
  let thoughtChars = 0;
  let buffered = "";
  const baseChunk = (
    delta: Record<string, unknown>,
    finish: "stop" | "length" | "tool_calls" | null,
    usage?: TUsage,
  ): TChatCompletionChunk =>
    ({
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model: params.providerModelId,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage !== undefined ? { usage } : {}),
    }) as TChatCompletionChunk;
  // `openerEmitted` tracks the on-WIRE role preamble separately from
  // `sawOutput` (the pre-commit "output is arriving" gate): JSON mode flips
  // `sawOutput` while buffering with nothing on the wire yet, so the first
  // real chunk (from `finish`/`emitToolCall`) must still carry
  // `role: "assistant"`.
  let openerEmitted = false;
  const opener = (
    delta: Record<string, unknown>,
  ): TChatCompletionChunk | null => {
    sawOutput = true;
    if (openerEmitted) return baseChunk(delta, null);
    openerEmitted = true;
    return baseChunk({ role: "assistant", content: "", ...delta }, null);
  };
  const usageRow = (): TUsage => {
    // ACP reports no token counts — ESTIMATE with the walker's own chars/4
    // ruler (marked by construction: prompt side runs through
    // estimateBodyTokens; output side is the accumulated chunk text).
    const promptTokens = estimateBodyTokens(params.promptText);
    const completionTokens = Math.ceil((outputChars + thoughtChars) / 4);
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  };
  return {
    handleUpdate: (update) => {
      if (typeof update !== "object" || update === null) return null;
      const u = update as {
        readonly sessionUpdate?: unknown;
        readonly content?: unknown;
      };
      if (u.sessionUpdate === "agent_message_chunk") {
        const text = updateText(u.content);
        if (text === null || text.length === 0) return null;
        outputChars += text.length;
        // JSON mode buffers the whole reply; `finish` emits the extracted
        // object as one content chunk. `sawOutput` still flips so the
        // pre-commit gate commits (output IS arriving, just not on the wire).
        if (params.jsonMode === true) {
          buffered += text;
          sawOutput = true;
          return null;
        }
        return opener({ content: text });
      }
      if (u.sessionUpdate === "agent_thought_chunk") {
        const text = updateText(u.content);
        if (text === null || text.length === 0) return null;
        thoughtChars += text.length;
        if (params.jsonMode === true) {
          sawOutput = true;
          return null;
        }
        return opener({ reasoning_content: text });
      }
      // tool_call / tool_call_update / plan / session_info_update /
      // available_commands_update — ignored in v1 (Cursor's NATIVE agent
      // tools run agent-side; only CLIENT tools via the MCP server surface).
      return null;
    },
    finish: (stopReason) => {
      const terminal = baseChunk(
        {},
        stopReason === "max_tokens" ? "length" : "stop",
        usageRow(),
      );
      if (params.jsonMode !== true) return [terminal];
      const extracted = extractJsonObject(buffered) ?? buffered;
      const content = opener({ content: extracted });
      return content !== null ? [content, terminal] : [terminal];
    },
    emitToolCall: (name, args) => {
      const open = opener({
        tool_calls: [
          {
            index: 0,
            id: `call_${created.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            type: "function",
            function: {
              name,
              arguments:
                typeof args === "string" ? args : JSON.stringify(args ?? {}),
            },
          },
        ],
      });
      const terminal = baseChunk({}, "tool_calls", usageRow());
      return open !== null ? [open, terminal] : [terminal];
    },
    sawOutput: () => sawOutput,
    contentChars: () => outputChars,
  };
};

/**
 * Minimal hand-rolled JSON-RPC 2.0 client over one `cursor-agent acp` child:
 * id counter, pending map, notification handler. One child per use — the
 * caller kills it via `dispose()` when the turn (or the model-list probe)
 * completes. No dependency — ~80 lines beats shipping a protocol package.
 */
class AcpClient {
  private nextId: TJsonRpcId = 1;
  private readonly pending = new Map<
    TJsonRpcId,
    {
      readonly method: string;
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
    }
  >();
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly stdin: { write: (s: string) => void; flush?: () => void };
  private disposed = false;
  /** Bounded tail of the child's stderr — surfaced on a handshake/startup
   *  failure so a decline isn't a silent black box. Capped so a chatty child
   *  can't grow it unbounded. */
  private stderrTail = "";

  constructor(
    bin: string,
    env: Record<string, string>,
    private readonly onNotification: (method: string, params: unknown) => void,
    /** Handle a server→client REQUEST. Returns the JSON-RPC `result` to send,
     *  or null to refuse with a "not supported" error. Defaults to refusing. */
    private readonly onServerRequest: (
      method: string,
      params: unknown,
    ) => unknown = () => null,
  ) {
    // The ACP bridge reads cursor's isolated macOS keychain credential;
    // securityd denies a Seatbelt-confined caller, so it runs unconfined on
    // macOS (confined on Linux) — `sandbox/policy.ts`.
    this.proc = Bun.spawn(
      sandboxSpawnArgs([bin, "acp"], { probe: unwrapKeychainSpawn("cursor") }),
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: spawnCwd(env),
        env: cleanNativeSpawnEnv(env),
      },
    );
    this.stdin = this.proc.stdin as unknown as {
      write: (s: string) => void;
      flush?: () => void;
    };
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>).catch(() => {
      // reader ends on child exit; dispose() handles state
    });
    void this.drainStderr(this.proc.stderr as ReadableStream<Uint8Array>).catch(
      () => {
        // reader ends on child exit
      },
    );
    void this.proc.exited.then(() =>
      this.failAllPending("cursor-agent acp exited"),
    );
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number = RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new AcpRpcError({
              method,
              kind: "timeout",
              message: `cursor-agent acp ${method} timed out`,
            }),
          );
        }
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new AcpRpcError({
            method,
            kind: "transport",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      // child gone — dispose path handles it
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAllPending("cursor-agent acp disposed");
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // already exited
    }
  }

  private failAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      entry.reject(
        new AcpRpcError({
          method: entry.method,
          kind: "transport",
          message: reason,
        }),
      );
    }
    this.pending.clear();
  }

  /** The most recent stderr output (bounded), for failure diagnostics. */
  stderr(): string {
    return this.stderrTail.trim();
  }

  private async drainStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stderr.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      this.stderrTail = (
        this.stderrTail + decoder.decode(value, { stream: true })
      ).slice(-STDERR_TAIL_MAX);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.disposed) throw new Error("cursor-agent acp not running");
    this.stdin.write(`${JSON.stringify(message)}\n`);
    this.stdin.flush?.();
  }

  private async pump(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const message = parseAcpLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message !== null) this.route(message);
      }
    }
  }

  private route(message: TAcpInbound): void {
    // Response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        entry.reject(
          new AcpRpcError({
            method: entry.method,
            kind: "rpc",
            message: message.error.message ?? "cursor-agent acp error",
            ...(typeof message.error.code === "number"
              ? { rpcCode: message.error.code }
              : {}),
          }),
        );
        return;
      }
      entry.resolve(message.result);
      return;
    }
    // Server→client REQUEST. Permission asks / question prompts are answered
    // (auto-approve / empty) so the agent never blocks; fs reads and anything
    // else the handler declines get a "not supported" error.
    if (message.id !== undefined && message.method !== undefined) {
      const result = this.onServerRequest(message.method, message.params);
      try {
        this.send(
          result !== null
            ? { jsonrpc: "2.0", id: message.id, result }
            : {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "not supported by openllmd" },
              },
        );
      } catch {
        // child gone
      }
      return;
    }
    // Notification.
    if (message.method !== undefined) {
      this.onNotification(message.method, message.params);
    }
  }
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  clientInfo: { name: "openllm-daemon", version: DAEMON_VERSION },
} as const;

/** `initialize` + `authenticate` (the CLI's own stored login). Throws on
 *  failure — the caller maps it to a bridge decline / null model list.
 *
 *  NB: the agent advertises `promptCapabilities.image` at initialize, but it's
 *  a STATIC protocol capability (always true for current cursor-agent), NOT
 *  per-model — so it can't gate images by the selected model. Verified live
 *  (2026-07-29): composer-2.5 reads image blocks correctly (blue→"blue",
 *  green→"green"); the models accept `{ type:"image", data, mimeType }` blocks
 *  as-is. So we send images unconditionally and let the model handle them. */
const handshake = async (
  client: AcpClient,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<void> => {
  await client.request("initialize", INIT_PARAMS, timeoutMs);
  await client.request("authenticate", { methodId: "cursor_login" }, timeoutMs);
};

const setupDecline = (
  error: unknown,
  signal: AbortSignal,
): TNativeRunResult => {
  if (signal.aborted) {
    return { kind: "declined", reason: "client aborted" };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "declined",
    reason: `cursor ACP handshake failed: ${message}`,
    ...(isExplicitAuthenticateRejection(error)
      ? { cooldownReason: "auth" as const }
      : {}),
  };
};

/**
 * Server→client request handler: auto-approve permission asks (Cursor's
 * native agent tools run agent-side under our auto-approval — we advertise
 * fs/terminal off and never block) and answer `cursor/ask_question`
 * immediately so the agent never stalls. Everything else → null (refused).
 */
export const handleCursorServerRequest = (
  method: string,
  params: unknown,
): unknown => {
  if (method === "session/request_permission") {
    const options = (
      params as {
        readonly options?: ReadonlyArray<{
          readonly optionId?: unknown;
          readonly kind?: unknown;
        }>;
      }
    )?.options;
    const pick =
      (Array.isArray(options)
        ? (options.find((o) => o.kind === "allow_always") ??
          options.find((o) => o.kind === "allow_once"))
        : undefined) ?? undefined;
    const optionId =
      typeof pick?.optionId === "string" ? pick.optionId : "allow-always";
    logInfo("native-runtime", "cursor auto-approving permission request", {
      optionId,
    });
    return { outcome: { outcome: "selected", optionId } };
  }
  if (method === "cursor/ask_question") {
    const questions = (
      params as {
        readonly questions?: ReadonlyArray<{
          readonly options?: ReadonlyArray<{ readonly value?: unknown }>;
        }>;
      }
    )?.questions;
    logInfo("native-runtime", "cursor auto-answering ask_question", {});
    const answers = Array.isArray(questions)
      ? questions.map((q) => {
          const first = Array.isArray(q.options) ? q.options[0] : undefined;
          return typeof first?.value === "string" ? first.value : "";
        })
      : [];
    return { answers };
  }
  return null;
};

/**
 * Best-effort model pin. `session/new` reports the selectable
 * `models.availableModels` as `modelId` strings that carry bracketed config
 * (`"claude-opus-5[thinking=true,...]"`); the provider model id is the BARE
 * value, so match on the bracket-stripped base. "auto"/"default" (or no
 * match) keeps the session on Cursor's router default. Failure is NON-FATAL:
 * the turn still runs, just on auto routing — logged so misroutes are
 * diagnosable.
 */
const trySetModel = async (
  client: AcpClient,
  sessionId: string,
  providerModelId: string,
  sessionResult: unknown,
): Promise<void> => {
  const base = providerModelId.split("[")[0]?.trim() ?? "";
  if (base.length === 0 || base === "auto" || base === "default") return;
  const models = (
    sessionResult as {
      readonly models?: {
        readonly availableModels?: ReadonlyArray<{
          readonly modelId?: unknown;
        }>;
      };
    }
  ).models?.availableModels;
  const match = Array.isArray(models)
    ? models.find(
        (m) =>
          typeof m.modelId === "string" && m.modelId.split("[")[0] === base,
      )
    : undefined;
  const modelId =
    typeof match?.modelId === "string" ? match.modelId : providerModelId;
  try {
    await client.request("session/set_model", { sessionId, modelId });
  } catch (error) {
    logWarn(
      "native-runtime",
      "cursor session/set_model failed — auto routing",
      {
        providerModelId,
        modelId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
};

export type TCursorNativeParams = {
  /** Absolute path to the isolated cursor-agent binary (`cliBin("cursor")`). */
  readonly bin: string;
  /** Isolated run env (`cliEnv("cursor")`), merged onto process.env. */
  readonly env: Record<string, string>;
  readonly providerModelId: string;
  /** System prompt — prepended to the rendered prompt (ACP has no separate
   *  system channel on `session/prompt`). Null when the client sent none. */
  readonly systemText: string | null;
  /** The rendered conversation text (seed or single turn) to feed. */
  readonly userText: string;
  /** Inbound image parts, forwarded as ACP image prompt blocks. */
  readonly images?: ReadonlyArray<TCursorImage>;
  /** Client function tools, exposed via the loopback MCP server. The FIRST
   *  agent `tools/call` ends the turn with OpenAI `tool_calls` semantics. */
  readonly tools?: ReadonlyArray<TCursorTool>;
  /** Structured output: append the JSON instruction, buffer the reply, and
   *  emit the extracted JSON object as the single content chunk. */
  readonly jsonInstructionText?: string | null;
  readonly signal: AbortSignal;
  /** Test overrides for the three deadlines. */
  readonly precommitMs?: number;
  readonly idleMs?: number;
  readonly turnTimeoutMs?: number;
  /** Test override for handshake RPC timeout. */
  readonly rpcTimeoutMs?: number;
};

/**
 * Run one COLD ACP turn: spawn → handshake → session/new → best-effort model
 * pin → session/prompt, streaming `session/update` chunks until the prompt
 * response (stopReason) ends the turn. Commit-on-first-output; every
 * pre-commit failure declines (the walker advances the plan — cursor has no
 * manual transport). The child is killed on completion, abort, and both
 * timeouts (hard 180s turn / 60s idle).
 */
export const runCursorNative = async (
  params: TCursorNativeParams,
): Promise<TNativeRunResult> => {
  // Generation is captured at request entry, before the vendor child or MCP
  // server exists, so a logout during spawn/handshake cannot be stamped as
  // the current account when session/new later returns.
  const observationGeneration = cursorNativeModelGeneration();
  if (!existsSync(params.bin)) {
    return { kind: "declined", reason: "cursor-agent CLI not installed" };
  }

  // Event plumbing: notifications feed a queue the ReadableStream drains.
  const queue: Array<TChatCompletionChunk | "end"> = [];
  let wake: (() => void) | null = null;
  const push = (item: TChatCompletionChunk | "end"): void => {
    queue.push(item);
    wake?.();
    wake = null;
  };

  const jsonMode =
    params.jsonInstructionText !== undefined &&
    params.jsonInstructionText !== null;
  const promptText =
    (params.systemText !== null
      ? `${params.systemText}\n\n${params.userText}`
      : params.userText) + (jsonMode ? (params.jsonInstructionText ?? "") : "");
  const turn = createAcpTurnState({
    providerModelId: params.providerModelId,
    promptText,
    jsonMode,
  });

  let sessionId: string | null = null;
  let ended = false;
  let lastActivityAt = Date.now();
  const endWith = (chunks: ReadonlyArray<TChatCompletionChunk>): void => {
    if (ended) return;
    ended = true;
    for (const chunk of chunks) push(chunk);
    push("end");
  };
  const endTurn = (stopReason: string | null): void => {
    endWith(turn.finish(stopReason));
  };

  // Client tools ride an ephemeral loopback MCP server. The FIRST agent
  // tools/call cuts the turn over to OpenAI tool_calls semantics: emit the
  // tool_calls delta + finish_reason "tool_calls", cancel the ACP session,
  // and let the client execute the tool + resend with tool-role results
  // (folded back in by cursorRequestOf) — one cold session per tool round.
  let mcp: TCursorMcpServer | null = null;
  const stopMcp = (): void => {
    mcp?.stop();
    mcp = null;
  };

  // `client` is created FIRST so the MCP server's onToolCall never closes over
  // it before initialization (a tools/call can only arrive after session/new,
  // which needs `client` — but declaring it first makes that ordering explicit
  // rather than relying on it).
  const client = new AcpClient(
    params.bin,
    params.env,
    (method, p) => {
      if (method !== "session/update") return;
      const notif = p as
        | { readonly sessionId?: unknown; readonly update?: unknown }
        | undefined;
      if (sessionId === null || notif?.sessionId !== sessionId) return;
      lastActivityAt = Date.now();
      const chunk = turn.handleUpdate(notif.update);
      if (chunk !== null && !ended) push(chunk);
    },
    handleCursorServerRequest,
  );

  if ((params.tools?.length ?? 0) > 0) {
    mcp = startCursorMcpServer({
      tools: params.tools ?? [],
      onToolCall: (name, args) => {
        if (ended) return;
        lastActivityAt = Date.now();
        endWith(turn.emitToolCall(name, args));
        if (sessionId !== null) client.notify("session/cancel", { sessionId });
      },
    });
  }

  const cancelAndDispose = (): void => {
    if (sessionId !== null) client.notify("session/cancel", { sessionId });
    client.dispose();
    stopMcp();
  };

  const abort = (): void => {
    cancelAndDispose();
    if (!ended) {
      ended = true;
      push("end");
    }
  };
  if (params.signal.aborted) {
    client.dispose();
    stopMcp();
    return { kind: "declined", reason: "client aborted" };
  }
  params.signal.addEventListener("abort", abort, { once: true });

  // ── Handshake + session ────────────────────────────────────────────
  const rpcTimeoutMs = params.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
  const failSetup = (error: unknown): TNativeRunResult => {
    const stderrTail = client.stderr();
    client.dispose();
    stopMcp();
    if (stderrTail.length > 0) {
      logError("native-runtime", "cursor ACP handshake failed", {
        stderrTail: stderrTail.slice(-400),
      });
    }
    return setupDecline(error, params.signal);
  };
  try {
    await handshake(client, rpcTimeoutMs);
  } catch (error) {
    return failSetup(error);
  }
  const observationTicket = takeCursorNativeModelObservationTicket(
    params.env,
    observationGeneration,
  );
  let opened: unknown;
  try {
    opened = await client.request(
      "session/new",
      {
        // A daemon-owned, empty cwd — the isolated cursor home (spawnCwd already
        // pins the child's process cwd there too), never the user's project.
        // Empty also bounds what Cursor's NATIVE fs tools can see.
        cwd: spawnCwd(params.env),
        // Client tools ride the ephemeral loopback MCP server (see above).
        mcpServers:
          mcp !== null
            ? [
                {
                  type: "http",
                  name: "openllm-client-tools",
                  url: mcp.url,
                  headers: mcp.headers,
                },
              ]
            : [],
      },
      rpcTimeoutMs,
    );
  } catch (error) {
    return failSetup(error);
  }
  const sid = (opened as { readonly sessionId?: unknown }).sessionId;
  if (typeof sid !== "string" || sid.length === 0) {
    client.dispose();
    stopMcp();
    return { kind: "declined", reason: "session/new returned no sessionId" };
  }
  sessionId = sid;
  if (observationTicket !== null) {
    observeCursorNativeModelsFromSession({
      ticket: observationTicket,
      env: params.env,
      sessionResult: opened,
    });
  }
  await trySetModel(client, sid, params.providerModelId, opened);

  // ── The prompt turn ────────────────────────────────────────────────
  const turnBudget = params.turnTimeoutMs ?? CURSOR_TURN_TIMEOUT_MS;
  const promptDone = client
    .request(
      "session/prompt",
      {
        sessionId,
        prompt: acpPromptBlocks(promptText, params.images ?? []),
      },
      turnBudget,
    )
    .then((result) => {
      const stop = (result as { readonly stopReason?: unknown }).stopReason;
      endTurn(typeof stop === "string" ? stop : null);
    })
    .catch((error: unknown) => {
      if (!turn.sawOutput()) {
        // Pre-commit failure — surfaced by the pre-commit race below.
        push("end");
        return;
      }
      logError("native-runtime", "cursor prompt failed after output began", {
        error: error instanceof Error ? error.message : String(error),
      });
      endTurn(null);
    });
  void promptDone;

  // Idle-chunk watchdog: no session/update (or terminal) within the idle
  // budget kills the turn. The hard turn budget rides the RPC timeout above.
  const idleBudget = params.idleMs ?? CURSOR_IDLE_TIMEOUT_MS;
  const idleTimer = setInterval(() => {
    if (ended) {
      clearInterval(idleTimer);
      return;
    }
    if (Date.now() - lastActivityAt > idleBudget) {
      clearInterval(idleTimer);
      logError("native-runtime", "cursor turn idle timeout — killing child", {
        idleMs: idleBudget,
      });
      cancelAndDispose();
      if (turn.sawOutput()) endTurn(null);
      else push("end");
    }
  }, 1_000);

  const nextItem = async (): Promise<TChatCompletionChunk | "end"> => {
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) return item;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  // ── Pre-commit: first output, terminal, or deadline ─────────────────
  // JSON mode buffers the reply (no chunk reaches the queue until `finish`),
  // so a deadline hit with output ALREADY OBSERVED (`sawOutput`) keeps
  // waiting — the model is generating, the wire is just deliberately quiet;
  // the idle watchdog + turn budget still bound the wait.
  let first: TChatCompletionChunk | "end" | "timeout";
  for (;;) {
    let precommitTimer: ReturnType<typeof setTimeout> | undefined;
    first = await Promise.race([
      nextItem(),
      new Promise<"timeout">((resolve) => {
        precommitTimer = setTimeout(
          () => resolve("timeout"),
          params.precommitMs ?? PRE_COMMIT_TIMEOUT_MS,
        );
      }),
    ]);
    clearTimeout(precommitTimer);
    if (first === "timeout" && turn.sawOutput()) continue;
    break;
  }
  if (first === "timeout" || first === "end") {
    clearInterval(idleTimer);
    cancelAndDispose();
    const reason =
      first === "timeout"
        ? "cursor ACP produced no output before the pre-commit deadline"
        : "cursor turn ended before producing output";
    logError("native-runtime", "cursor hop declined pre-commit", { reason });
    return { kind: "declined", reason };
  }

  const chunks = new ReadableStream<TChatCompletionChunk>({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      const next = await nextItem();
      if (next === "end") {
        controller.close();
        clearInterval(idleTimer);
        client.dispose();
        stopMcp();
        return;
      }
      controller.enqueue(next);
    },
    cancel() {
      clearInterval(idleTimer);
      abort();
    },
  });
  // Cold sessions in v1 — never record a resumable id (see module header).
  return { kind: "committed", chunks, sessionId: () => null };
};

/**
 * Manual `listModels` only: a short-lived ACP session whose
 * `cursor/list_available_models` request returns `{ models: [{ value, name }] }`
 * (VERIFIED LIVE). Auto `discoverModels` must not call this — it reads native
 * observations captured on an already-authorized inference session. Null on
 * ANY failure (not installed / not logged in / protocol drift).
 */
export const listCursorModelsViaAcp = async (params: {
  readonly bin: string;
  readonly env: Record<string, string>;
}): Promise<ReadonlyArray<{ value: string; name: string | null }> | null> => {
  if (!existsSync(params.bin)) return null;
  const client = new AcpClient(params.bin, params.env, () => {
    // notifications are irrelevant to the model-list probe
  });
  try {
    await handshake(client);
    const opened = await client.request("session/new", {
      cwd: spawnCwd(params.env),
      mcpServers: [],
    });
    const sid = (opened as { readonly sessionId?: unknown }).sessionId;
    if (typeof sid !== "string") return null;
    const listed = await client.request("cursor/list_available_models", {
      sessionId: sid,
    });
    return parseCursorListAvailableModels(listed);
  } catch {
    return null;
  } finally {
    client.dispose();
  }
};
