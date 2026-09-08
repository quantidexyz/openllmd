/**
 * Map existing daemon transitions onto closed diagnostic observations.
 * No new probes, no payloads, no argv.
 */
import type {
  TAuthLoginFailedCode,
  TDoctorErrorClass,
  TDoctorProvider,
} from "@openllmsh/protocol";
import { observeDoctorEvent } from "./engine";

export const asDoctorProvider = (slug: string): TDoctorProvider | undefined => {
  if (
    slug === "claude_code" ||
    slug === "chatgpt" ||
    slug === "kimi_code" ||
    slug === "grok" ||
    slug === "cursor"
  ) {
    return slug;
  }
  return undefined;
};

const PROTOCOL_FAILURE_COOLDOWN_MS = 60_000;
let lastProtocolFailureAtMs = 0;
let protocolFailureStreak = 0;

const noteProtocolFailure = (): void => {
  const now = Date.now();
  protocolFailureStreak += 1;
  if (
    lastProtocolFailureAtMs !== 0 &&
    now - lastProtocolFailureAtMs < PROTOCOL_FAILURE_COOLDOWN_MS
  ) {
    return;
  }
  lastProtocolFailureAtMs = now;
  const n = protocolFailureStreak;
  protocolFailureStreak = 0;
  observeDoctorEvent({
    code: "control_channel_protocol_failure",
    producer: "control_channel",
    trigger: "reconnect",
    outcome: "protocol_error",
    operation: "reconnect",
    error_class: "protocol_failure",
    ...(n > 1 ? { timings: { repeat_count: n } } : {}),
  });
};

export const noteControlChannelClose = (opts: {
  readonly code: number;
  readonly superseded: boolean;
  readonly clean: boolean;
}): void => {
  if (opts.superseded || opts.clean) return;
  if (opts.code === 4003) {
    noteProtocolFailure();
    return;
  }
  observeDoctorEvent({
    code: "control_channel_unexpected_disconnect",
    producer: "control_channel",
    trigger: "reconnect",
    outcome: "disconnect",
    operation: "reconnect",
    error_class: "transport_connect",
  });
};

export const noteControlChannelProtocolFailure = (): void => {
  noteProtocolFailure();
};

export const noteLoginTerminal = (opts: {
  readonly code: TAuthLoginFailedCode;
  readonly provider: string;
}): void => {
  if (opts.code === "user_cancelled") return;
  const provider = asDoctorProvider(opts.provider);
  const watchdog =
    opts.code === "poll_expired" || opts.code === "prompt_timeout";
  observeDoctorEvent({
    code: watchdog ? "login_watchdog_expiry" : "login_terminal_failure",
    producer: "login_flow",
    trigger: "login",
    outcome: watchdog ? "expired" : "failure",
    operation: "login",
    ...(provider !== undefined ? { provider } : {}),
    error_class:
      opts.code === "spawn_denied"
        ? "spawn_denied"
        : opts.code === "cli_crash"
          ? "cli_crash"
          : watchdog
            ? "watchdog"
            : "unclassified",
  });
};

const cliFailStreak = new Map<string, number>();

export const resetCliInstallDoctorStreakForTests = (): void => {
  cliFailStreak.clear();
  lastProtocolFailureAtMs = 0;
  protocolFailureStreak = 0;
};

export const noteCliInstallProbeResult = (opts: {
  readonly provider: string;
  readonly version: string | null;
  readonly installed: boolean;
}): void => {
  if (!opts.installed || opts.version !== null) {
    cliFailStreak.delete(opts.provider);
    return;
  }
  const n = (cliFailStreak.get(opts.provider) ?? 0) + 1;
  cliFailStreak.set(opts.provider, n);
  if (n !== 3) return;
  const provider = asDoctorProvider(opts.provider);
  observeDoctorEvent({
    code: "cli_install_repeated_failure",
    producer: "cli_install",
    trigger: "version_probe",
    outcome: "failure",
    operation: "install",
    ...(provider !== undefined ? { provider } : {}),
    error_class: "unclassified",
    timings: { repeat_count: n },
  });
};

const nodeCode = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  const cause =
    err instanceof Error && "cause" in err
      ? (err as { cause: unknown }).cause
      : null;
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const c = (cause as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return "";
};

export const classifyWalkerTransport = (err: unknown): TDoctorErrorClass => {
  const code = nodeCode(err).toUpperCase();
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "transport_dns";
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  ) {
    return "transport_connect";
  }
  if (code.includes("CERT") || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return "transport_tls";
  }
  if (
    code === "ABORT_ERR" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return "timeout";
  }
  return "upstream_http";
};

export const noteWalkerStreamTerminal = (opts: {
  readonly aborted: boolean;
  readonly hang: boolean;
  readonly err: unknown;
}): void => {
  if (opts.aborted) return;
  try {
    observeDoctorEvent({
      code: opts.hang ? "stream_hang_watchdog" : "stream_unexpected_failure",
      producer: "walker",
      trigger: "stream",
      outcome: opts.hang ? "hang" : "failure",
      operation: "stream",
      error_class: opts.hang ? "watchdog" : classifyWalkerTransport(opts.err),
    });
  } catch {
    // reporting failure must not affect the stream
  }
};

export const runDoctorHookPromise = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined,
  );

export const noteNativeAuthTimeout = (input: {
  readonly trigger: "native_login" | "capture" | "refresh" | "status_poll";
  readonly operation: "native_auth" | "capture" | "refresh" | "probe";
  readonly timings: {
    readonly configured_timeout_ms: number;
    readonly spawn_elapsed_ms: number;
    readonly budget_remaining_ms_at_spawn: number;
    readonly timeout_callback_lateness_ms: number;
    readonly cleanup_ms: number;
    readonly stdout_closed: boolean;
    readonly root_exited: boolean;
    readonly root_exit_code?: number;
    readonly stderr_closed?: boolean;
  };
}): void => {
  try {
    observeDoctorEvent({
      code: "native_auth_timeout",
      producer: "spawn",
      trigger: input.trigger,
      outcome: "timeout",
      operation: input.operation,
      error_class: "timeout",
      timings: {
        ...input.timings,
        timeout_callback_lateness_ms: Math.max(
          0,
          input.timings.timeout_callback_lateness_ms,
        ),
        spawn_elapsed_ms: Math.max(0, input.timings.spawn_elapsed_ms),
        cleanup_ms: Math.max(0, input.timings.cleanup_ms),
        budget_remaining_ms_at_spawn: Math.max(
          0,
          input.timings.budget_remaining_ms_at_spawn,
        ),
      },
    });
  } catch {
    // Diagnostics must not affect native authentication.
  }
};

export const noteRefreshFailure = (opts: {
  readonly provider: string;
  readonly errorClass: string;
  readonly spawnElapsedMs: number | null;
  readonly timeoutMs: number;
  readonly exitCode: number | undefined;
}): void => {
  if (opts.errorClass === "abandoned") return;
  const provider = asDoctorProvider(opts.provider);
  try {
    observeDoctorEvent({
      code: "refresh_failure",
      producer: "refresh",
      trigger: "refresh",
      outcome: opts.errorClass === "timeout" ? "timeout" : "failure",
      operation: "refresh",
      error_class:
        opts.errorClass === "timeout"
          ? "timeout"
          : opts.errorClass === "spawn_failed"
            ? "spawn_denied"
            : "unclassified",
      ...(provider !== undefined ? { provider } : {}),
      timings: {
        ...(opts.spawnElapsedMs !== null
          ? { spawn_elapsed_ms: opts.spawnElapsedMs }
          : {}),
        configured_timeout_ms: opts.timeoutMs,
        ...(typeof opts.exitCode === "number"
          ? { root_exit_code: opts.exitCode }
          : {}),
      },
    });
  } catch {
    // Diagnostics must not affect credential refresh.
  }
};
