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
