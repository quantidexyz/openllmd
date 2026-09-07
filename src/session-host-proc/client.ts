/**
 * Durable session-host discovery, spawn, and CLI-pipe attach client.
 *
 * The daemon never opens a session unix socket itself — the CLI owns that
 * path. Browser attach is a child process of `openllm sessions attach --pipe`
 * whose stdio is bridged to the relay stream. Spawn still launches the
 * detached `__session-host` sibling (same binary) so the host is ready before
 * the attach child dials it.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type {
  TDeviceSessionCli,
  TSessionStreamOpenPayload,
} from "@openllmsh/protocol";
import { DeviceSessionCli, SESSION_ID_PATTERN } from "@openllmsh/protocol";
import { decodeJsonPayload, encodeJsonPayload } from "@openllmsh/tunnel/codec";
import { Schema as S } from "effect";
import { resolveOpenllmCli } from "../cli-self-update";
import { spawnCommand } from "../command";
import type { TDeadlineBudget } from "../deadline-budget";
import { createDeadlineBudget, waitUntilExpired } from "../deadline-budget";
import { isDevMode, stateDir } from "../env";
import type { TSessionStream } from "../session-core";
import type { TSessionHostMeta } from "./main";

const SPAWN_SOCKET_TIMEOUT_MS = 2_000;
/** Per-pid `ps` identity read. Expiry is unknown, never dead. */
const PROCESS_IDENTITY_TIMEOUT_MS = 250;
const DISCOVERY_CONCURRENCY = 4;
/** RS (0x1e) prefixes a JSON control line on the pipe-mode attach stdio. */
const PIPE_CTRL = 0x1e;
const PIPE_CTRL_MAX_BYTES = 512;

export type TLiveSessionHost = TSessionHostMeta & {
  readonly socketPath: string;
};

export type TSpawnSessionHostProc = {
  readonly id: string;
  readonly cli: TDeviceSessionCli;
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: string;
  readonly title?: string;
  readonly dangerous?: boolean;
  readonly resume?: string;
  readonly vendorArgs?: readonly string[];
};

const isCli: (value: unknown) => value is TDeviceSessionCli =
  S.is(DeviceSessionCli);

const sessionHostsRoot = (): string => join(stateDir(), "sessions");
const sessionHostDir = (id: string): string => join(sessionHostsRoot(), id);
const sessionHostSocketPath = (id: string): string =>
  join(sessionHostDir(id), "ctl.sock");

const isSessionHostMeta = (value: unknown): value is TSessionHostMeta => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.id === "string" &&
    SESSION_ID_PATTERN.test(meta.id) &&
    isCli(meta.cli) &&
    typeof meta.cwd === "string" &&
    meta.cwd.length > 0 &&
    typeof meta.pid === "number" &&
    Number.isInteger(meta.pid) &&
    meta.pid > 0 &&
    (meta.vendorSessionId === null ||
      typeof meta.vendorSessionId === "string") &&
    (meta.title === null || typeof meta.title === "string") &&
    typeof meta.startedAtMs === "number" &&
    Number.isFinite(meta.startedAtMs) &&
    typeof meta.processStartTime === "string" &&
    meta.processStartTime.length > 0 &&
    typeof meta.generation === "number" &&
    Number.isInteger(meta.generation) &&
    meta.generation >= 1
  );
};

export type TProcessIdentity = "alive" | "dead" | "unknown";

type TProcessIdentityReader = (
  meta: Pick<TSessionHostMeta, "pid" | "processStartTime">,
  budget: TDeadlineBudget,
) => Promise<TProcessIdentity>;

let processIdentityReaderForTests: TProcessIdentityReader | null = null;

/** Test seam: replace the bounded `ps` identity probe. */
export const setSessionHostProcessIdentityReaderForTests = (
  reader: TProcessIdentityReader | null,
): void => {
  processIdentityReaderForTests = reader;
};

/**
 * Bounded async `lstart` read. `undefined` means the deadline expired or the
 * helper could not be observed — never treat that as a dead pid.
 */
const readProcessStartTime = async (
  pid: number,
  budget: TDeadlineBudget,
): Promise<string | null | undefined> => {
  if (budget.expired()) return undefined;
  try {
    const proc = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const complete = Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]).then(([out, code]) => ({ kind: "done" as const, out, code }));
    const timeout = waitUntilExpired(budget).then(() => ({
      kind: "timeout" as const,
    }));
    const raced = await Promise.race([complete, timeout]);
    if (raced.kind === "timeout") {
      try {
        proc.kill();
      } catch {
        // The helper may already have exited.
      }
      return undefined;
    }
    if (raced.code !== 0) return null;
    const value = raced.out.trim();
    return value.length > 0 ? value : null;
  } catch {
    return undefined;
  }
};

const defaultProcessIdentity: TProcessIdentityReader = async (meta, budget) => {
  const startTime = await readProcessStartTime(meta.pid, budget);
  if (startTime === undefined) return "unknown";
  if (startTime === null) return "dead";
  return startTime === meta.processStartTime ? "alive" : "dead";
};

const sessionHostProcessIdentity = async (
  meta: Pick<TSessionHostMeta, "pid" | "processStartTime">,
  parent?: AbortSignal,
): Promise<TProcessIdentity> => {
  const budget = createDeadlineBudget(PROCESS_IDENTITY_TIMEOUT_MS, parent);
  const reader = processIdentityReaderForTests ?? defaultProcessIdentity;
  return reader(meta, budget);
};

const mapLimited = async <T, R>(
  values: readonly T[],
  limit: number,
  visit: (value: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(values.length);
  if (values.length === 0) return results;
  const maxConcurrency = Math.max(1, Math.min(limit, values.length));
  let cursor = 0;
  const workers = Array.from({ length: maxConcurrency }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await visit(values[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
};

const socketPresent = (path: string): boolean => {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
};

type TDiscoveryCandidate = {
  readonly id: string;
  readonly directory: string;
  readonly socketPath: string;
  readonly meta: TSessionHostMeta;
  readonly socketReady: boolean;
};

const reapSessionHostDir = (directory: string): void => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // A concurrently exiting host owns final cleanup.
  }
};

const withinSpawnGrace = (directory: string, startedAtMs: number): boolean => {
  let ageStart = startedAtMs;
  try {
    ageStart = Number.isFinite(startedAtMs)
      ? startedAtMs
      : statSync(directory).mtimeMs;
  } catch {
    return false;
  }
  return Date.now() - ageStart < SPAWN_SOCKET_TIMEOUT_MS;
};

let discoveryInFlight: Promise<readonly TLiveSessionHost[]> | null = null;

const discoverSessionHostsOnce = async (): Promise<
  readonly TLiveSessionHost[]
> => {
  let entries: string[];
  try {
    entries = readdirSync(sessionHostsRoot());
  } catch {
    return [];
  }
  const candidates: TDiscoveryCandidate[] = [];
  for (const id of entries) {
    if (!SESSION_ID_PATTERN.test(id)) continue;
    const directory = sessionHostDir(id);
    const socketPath = sessionHostSocketPath(id);
    let meta: TSessionHostMeta | null = null;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(directory, "meta.json"), "utf8"),
      );
      meta = isSessionHostMeta(parsed) && parsed.id === id ? parsed : null;
    } catch {
      meta = null;
    }
    if (meta === null) {
      reapSessionHostDir(directory);
      continue;
    }
    candidates.push({
      id,
      directory,
      socketPath,
      meta,
      socketReady: socketPresent(socketPath),
    });
  }

  const hosts: TLiveSessionHost[] = [];
  await mapLimited(candidates, DISCOVERY_CONCURRENCY, async (candidate) => {
    const identity = await sessionHostProcessIdentity(candidate.meta);
    if (identity === "unknown") {
      // Uncertainty never authorizes deletion. Surface a socket-ready host so
      // attach/status keep the session; keep a grace-window host without a
      // socket; otherwise leave the directory for a later observation.
      if (candidate.socketReady) {
        hosts.push({ ...candidate.meta, socketPath: candidate.socketPath });
      }
      return;
    }
    if (identity === "alive" && !candidate.socketReady) {
      if (withinSpawnGrace(candidate.directory, candidate.meta.startedAtMs)) {
        return;
      }
      reapSessionHostDir(candidate.directory);
      return;
    }
    if (identity === "dead" || !candidate.socketReady) {
      reapSessionHostDir(candidate.directory);
      return;
    }
    hosts.push({ ...candidate.meta, socketPath: candidate.socketPath });
  });
  return hosts.sort((a, b) => b.startedAtMs - a.startedAtMs);
};

/** Scan, validate, and reap stale durable session-host registry entries. */
export const discoverSessionHosts = async (): Promise<
  readonly TLiveSessionHost[]
> => {
  if (discoveryInFlight !== null) return discoveryInFlight;
  const run = discoverSessionHostsOnce();
  discoveryInFlight = run;
  void run.finally(() => {
    if (discoveryInFlight === run) discoveryInFlight = null;
  });
  return run;
};

/** Test seam: drop a coalesced scan so the next call starts a fresh one. */
export const resetSessionHostDiscoveryForTests = (): void => {
  discoveryInFlight = null;
  processIdentityReaderForTests = null;
};

const waitForSessionHostSocket = async (id: string): Promise<string | null> => {
  const socketPath = sessionHostSocketPath(id);
  const deadline = Date.now() + SPAWN_SOCKET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (socketPresent(socketPath)) return socketPath;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return socketPresent(socketPath) ? socketPath : null;
};

const daemonBinary = (): readonly string[] => {
  // The detached session host is what actually owns the PTY and spawns the
  // openllm CLI. Re-exec THIS daemon's own entrypoint so it inherits our code
  // (and, in dev, the CLI override). In dev we run from source under
  // `bun --watch src/main.ts`, so `process.argv[1]` is that script — re-exec it
  // rather than the INSTALLED `~/.openllm/bin/openllmd`, which would otherwise
  // run shipped code with none of the dev overrides (and can protocol-skew the
  // source daemon, surfacing as `spawn_failed` in the browser).
  const sourceRunner = process.argv[1];
  if (isDevMode()) {
    return sourceRunner === undefined
      ? [process.execPath]
      : [process.execPath, sourceRunner];
  }
  const installed = join(stateDir(), "bin", "openllmd");
  if (existsSync(installed)) return [installed];
  return sourceRunner === undefined
    ? [process.execPath]
    : [process.execPath, sourceRunner];
};

/** Spawn a detached sibling session host and wait for its private control socket. */
export const spawnSessionHostProc = async (
  args: TSpawnSessionHostProc,
): Promise<string | null> => {
  if (!SESSION_ID_PATTERN.test(args.id)) return null;
  const argv = [
    "__session-host",
    "--id",
    args.id,
    "--cli",
    args.cli,
    ...(args.cwd === undefined ? [] : ["--cwd", args.cwd]),
    ...(args.title === undefined ? [] : ["--title", args.title]),
    ...(args.dangerous === true ? ["--dangerous"] : []),
    ...(args.resume === undefined ? [] : ["--resume", args.resume]),
    ...(args.vendorArgs ?? []).flatMap((arg) => ["--vendor-arg", arg]),
    "--cols",
    String(args.cols),
    "--rows",
    String(args.rows),
  ];
  try {
    const proc = Bun.spawn([...daemonBinary(), ...argv], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
  } catch {
    return null;
  }
  return waitForSessionHostSocket(args.id);
};

const openllmCliBinary = (): string | null => resolveOpenllmCli();

/**
 * A TSessionStream that pipes to `openllm sessions attach --pipe`.
 *
 * The CLI child owns the unix-socket dial; the daemon only owns this process
 * and the bridge. Binary frames go to the child's stdin; RS-prefixed JSON
 * lines carry resize/close controls. The child's stdout is PTY output.
 */
class CliPipeSessionStream implements TSessionStream {
  private readonly dataHandlers = new Set<(payload: Uint8Array) => unknown>();
  private readonly ctrlHandlers = new Set<(payload: Uint8Array) => unknown>();
  private readonly resetHandlers = new Set<(payload: Uint8Array) => unknown>();
  private readonly endHandlers = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly proc: ReturnType<typeof Bun.spawn>,
    private readonly stdin: {
      write: (data: Uint8Array | string) => number | Promise<number>;
      flush: () => number | Promise<number>;
    },
  ) {
    const stdout = proc.stdout;
    if (stdout !== null && typeof stdout !== "number") {
      void (async () => {
        const reader = (stdout as ReadableStream<Uint8Array>).getReader();
        const ctrlDecoder = new TextDecoder();
        let ctrlBytes: number[] = [];
        let ctrlOverflow = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || value === undefined) break;
            let index = 0;
            while (index < value.length) {
              if (
                ctrlBytes.length > 0 ||
                ctrlOverflow ||
                value[index] === PIPE_CTRL
              ) {
                if (ctrlBytes.length === 0 && !ctrlOverflow) index += 1;
                while (index < value.length) {
                  const byte = value[index] ?? 0;
                  index += 1;
                  if (byte === 0x0a) {
                    if (!ctrlOverflow) {
                      try {
                        const decoded: unknown = JSON.parse(
                          ctrlDecoder.decode(new Uint8Array(ctrlBytes)),
                        );
                        if (
                          typeof decoded === "object" &&
                          decoded !== null &&
                          !Array.isArray(decoded)
                        ) {
                          const control = decoded as Record<string, unknown>;
                          if (control.t === "reset") {
                            const { t: _tag, ...reset } = control;
                            const payload = encodeJsonPayload(reset);
                            for (const handler of this.resetHandlers)
                              handler(payload);
                          } else {
                            const payload = encodeJsonPayload(control);
                            for (const handler of this.ctrlHandlers)
                              handler(payload);
                          }
                        }
                      } catch {
                        // Malformed control — drop and keep streaming.
                      }
                    }
                    ctrlBytes = [];
                    ctrlOverflow = false;
                    break;
                  }
                  ctrlBytes.push(byte);
                  if (ctrlBytes.length > PIPE_CTRL_MAX_BYTES) {
                    // Keep consuming through newline so a malformed frame tail
                    // cannot be emitted as raw terminal output.
                    ctrlBytes = [];
                    ctrlOverflow = true;
                  }
                }
                continue;
              }
              const start = index;
              while (index < value.length && value[index] !== PIPE_CTRL)
                index += 1;
              if (index > start) {
                const bytes = value.subarray(start, index);
                for (const handler of this.dataHandlers) handler(bytes);
              }
            }
          }
        } catch {
          // Child closed stdout.
        } finally {
          this.fireEnd();
        }
      })();
    }
    void proc.exited.then(() => this.fireEnd());
  }

  private fireEnd = (): void => {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.endHandlers) handler();
  };

  write = async (bytes: Uint8Array): Promise<void> => {
    if (this.closed) throw new Error("session pipe closed");
    await this.stdin.write(bytes);
    await this.stdin.flush();
  };

  private writeControl = (control: object): void => {
    void Promise.resolve(
      this.stdin.write(
        `${String.fromCharCode(PIPE_CTRL)}${JSON.stringify(control)}\n`,
      ),
    )
      .then(() => this.stdin.flush())
      .catch(() => this.fireEnd());
  };

  sendCtrl = (payload: Uint8Array): void => {
    if (this.closed) return;
    const decoded = decodeJsonPayload(payload);
    if (
      decoded === undefined ||
      typeof decoded !== "object" ||
      decoded === null
    )
      return;
    const ctrl = decoded as {
      t?: string;
      cols?: number;
      rows?: number;
      intent?: string;
    };
    if (
      ctrl.t === "resize" &&
      typeof ctrl.cols === "number" &&
      typeof ctrl.rows === "number"
    ) {
      this.writeControl({ t: "resize", cols: ctrl.cols, rows: ctrl.rows });
      return;
    }
    if (ctrl.t === "focus") {
      // Forward opaque focus claims so a browser tab can claim primary through
      // the pipe-bridged attach child without typing.
      this.writeControl({ t: "focus" });
      return;
    }
    if (ctrl.t === "close") {
      this.writeControl({ t: "close", intent: ctrl.intent ?? "detach" });
    }
  };

  reset = (_payload?: Uint8Array): void => {
    // Parent-side teardown: kill the attach child. The durable host is untouched.
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    this.fireEnd();
  };

  end = (): void => {
    this.sendCtrl(encodeJsonPayload({ t: "close", intent: "detach" }));
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    this.fireEnd();
  };

  onData = (handler: (payload: Uint8Array) => unknown): (() => void) => {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  };
  onCtrl = (handler: (payload: Uint8Array) => unknown): (() => void) => {
    this.ctrlHandlers.add(handler);
    return () => this.ctrlHandlers.delete(handler);
  };
  onReset = (handler: (payload: Uint8Array) => unknown): (() => void) => {
    this.resetHandlers.add(handler);
    return () => this.resetHandlers.delete(handler);
  };
  onEnd = (handler: () => void): (() => void) => {
    this.endHandlers.add(handler);
    return () => this.endHandlers.delete(handler);
  };
}

/**
 * Attach to a durable session by spawning `openllm sessions attach --pipe`.
 * The CLI owns the unix-socket dial; this returns a TSessionStream over the
 * child's stdio so the daemon can bridge a relay mux stream without opening
 * any session socket itself.
 */
export const attachSessionHostViaCli = (
  open: TSessionStreamOpenPayload,
): TSessionStream | null => {
  const bin = openllmCliBinary();
  if (bin === null) return null;
  const proc = Bun.spawn(
    spawnCommand(process.platform, bin, [
      "sessions",
      "attach",
      open.session_id,
      "--pipe",
      "--cols",
      String(open.cols),
      "--rows",
      String(open.rows),
    ]),
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  if (proc.stdin === null || typeof proc.stdin === "number") {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    return null;
  }
  return new CliPipeSessionStream(proc, proc.stdin);
};
