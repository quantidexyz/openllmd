/**
 * Stamp-keyed `--version` cache.
 *
 * One probe per resolved-binary identity until that identity changes.
 * Successful stdout AND completed failure/timeout are cached. No TTL, no
 * autonomous retry timer, no filesystem watcher. Missing/unstatable
 * binaries return `null` without spawning and are re-statted on the next
 * demand.
 *
 * Timeout policy (first caller wins): the in-flight probe uses the first
 * waiter's `timeoutMs`. Joiners cannot shorten or lengthen it. When the
 * first waiter omits `timeoutMs`, spawn's 5s capture default
 * applies unless `OPENLLM_CLI_VERSION_PROBE_TIMEOUT_MS` is set (shared
 * configured policy). Vendor install/status callers that need 3s must
 * pass `{ timeoutMs }` explicitly.
 *
 * In-flight probes coalesce. An observer abort does not cancel the shared
 * child or persist a failure. A stamp change during a probe is not
 * published under the replacement identity. Env is passed to the child
 * only — never persisted.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveVersionBinary, versionBinaryStamp } from "./cli-version-stamp";
import { stateDir } from "./env";

export type TCliVersionOpts = {
  readonly timeoutMs?: number;
  /** Observer-only. Does not abort the shared probe. */
  readonly signal?: AbortSignal;
};

const SCHEMA_V = 1;
export const CLI_VERSION_CACHE_MAX_RECORDS = 64;
/** Version stdout is a short banner; anything larger is treated as failure. */
export const CLI_VERSION_OUTPUT_MAX_BYTES = 4_096;
const MAX_PATH_CHARS = 4_096;
const MAX_STAMP_CHARS = 256;
const MAX_FILE_BYTES =
  64 * 1024 +
  CLI_VERSION_CACHE_MAX_RECORDS *
    (MAX_PATH_CHARS + CLI_VERSION_OUTPUT_MAX_BYTES);

let persistTmpSeq = 0;
let persistLocked = false;
let persistQueued = false;

const envMs = (name: string, fallback: number): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Timeout for a NEW probe. `undefined` means runCapture's 5s default.
 * First caller of an in-flight identity wins; this is not re-read for joiners.
 */
export const versionProbeTimeoutMs = (
  override: number | undefined,
): number | undefined => {
  if (override !== undefined) return override;
  return envMs("OPENLLM_CLI_VERSION_PROBE_TIMEOUT_MS", 5_000);
};

type TPersistRecord = {
  readonly path: string;
  readonly stamp: string;
  readonly output: string | null;
  readonly probedAt: number;
};

type TPersistFile = {
  readonly v: number;
  readonly records: readonly TPersistRecord[];
};

type TMemoryEntry = TPersistRecord;

const memory = new Map<string, TMemoryEntry>();
const inflight = new Map<string, Promise<string | null>>();
let persistLoaded = false;

const identityKey = (path: string, stamp: string): string =>
  `${path}\n${stamp}`;

export const cliVersionCacheFilePath = (): string =>
  join(stateDir(), "cli-version-cache.json");

const isRecord = (v: unknown): v is TPersistRecord => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as TPersistRecord;
  if (
    typeof r.path !== "string" ||
    r.path.length === 0 ||
    r.path.length > MAX_PATH_CHARS ||
    typeof r.stamp !== "string" ||
    r.stamp.length === 0 ||
    r.stamp.length > MAX_STAMP_CHARS ||
    typeof r.probedAt !== "number" ||
    !Number.isFinite(r.probedAt)
  ) {
    return false;
  }
  if (r.output === null) return true;
  return (
    typeof r.output === "string" &&
    r.output.length <= CLI_VERSION_OUTPUT_MAX_BYTES
  );
};

const coerceFile = (v: unknown): TPersistRecord[] => {
  if (typeof v !== "object" || v === null) return [];
  const raw = v as { v?: unknown; records?: unknown };
  if (raw.v !== SCHEMA_V || !Array.isArray(raw.records)) return [];
  return raw.records.filter(isRecord).slice(-CLI_VERSION_CACHE_MAX_RECORDS);
};

const loadPersist = (): void => {
  if (persistLoaded) return;
  persistLoaded = true;
  const path = cliVersionCacheFilePath();
  try {
    const st = statSync(path);
    if (st.size > MAX_FILE_BYTES) return;
  } catch {
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  if (raw.length > MAX_FILE_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  for (const rec of coerceFile(parsed)) {
    memory.set(identityKey(rec.path, rec.stamp), rec);
  }
};

const recordsFromMemory = (): TPersistRecord[] =>
  [...memory.values()].slice(-CLI_VERSION_CACHE_MAX_RECORDS);

const writePersistAtomic = (records: readonly TPersistRecord[]): void => {
  persistTmpSeq += 1;
  const tmp = join(
    stateDir(),
    `.cli-version-cache.json.${process.pid}.${persistTmpSeq}.tmp`,
  );
  const body: TPersistFile = { v: SCHEMA_V, records };
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, cliVersionCacheFilePath());
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
};

/** Snapshot the in-memory map (no disk RMW). Serialized; unique tmp names. */
const flushPersist = (): void => {
  if (persistLocked) {
    persistQueued = true;
    return;
  }
  persistLocked = true;
  try {
    do {
      persistQueued = false;
      writePersistAtomic(recordsFromMemory());
    } while (persistQueued);
  } finally {
    persistLocked = false;
  }
};

const persistEntry = (entry: TMemoryEntry): void => {
  const key = identityKey(entry.path, entry.stamp);
  memory.set(key, entry);
  if (memory.size > CLI_VERSION_CACHE_MAX_RECORDS) {
    const first = memory.keys().next().value;
    if (first !== undefined && first !== key) memory.delete(first);
  }
  flushPersist();
};

const settleShared = (shared: Promise<string | null>): Promise<string | null> =>
  shared.then(
    (value) => value,
    () => null,
  );

const joinObserver = (
  shared: Promise<string | null>,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
  const settled = settleShared(shared);
  if (signal === undefined) return settled;
  if (signal.aborted) {
    void settled;
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
};

const boundOutput = (output: string | null): string | null => {
  if (output === null) return null;
  if (output.length > CLI_VERSION_OUTPUT_MAX_BYTES) return null;
  return output;
};

const probeRaw = async (
  bin: string,
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
): Promise<string | null> => {
  const { runCapture } = await import("./delegation/spawn");
  return runCapture([bin, "--version"], env, {
    kind: "probe",
    probe: true,
    maxBytes: CLI_VERSION_OUTPUT_MAX_BYTES,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
};

const runProbe = async (
  bin: string,
  resolved: string,
  stamp: string,
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
): Promise<string | null> => {
  const output = boundOutput(await probeRaw(bin, env, timeoutMs));
  const stampAfter = versionBinaryStamp(bin);
  const resolvedAfter = resolveVersionBinary(bin);
  if (stampAfter !== stamp || resolvedAfter !== resolved) {
    return output;
  }
  persistEntry({
    path: resolved,
    stamp,
    output,
    probedAt: Date.now(),
  });
  return output;
};

/**
 * Stamp-keyed `--version`. Trimmed stdout on success; `null` on completed
 * failure/timeout, missing binary, or observer abort.
 */
export const cachedCliVersion = (
  bin: string,
  env?: Record<string, string>,
  opts?: TCliVersionOpts,
): Promise<string | null> => {
  loadPersist();
  const resolved = resolveVersionBinary(bin);
  const stamp = versionBinaryStamp(bin);
  if (resolved === null || stamp === null) {
    return Promise.resolve(null);
  }
  const key = identityKey(resolved, stamp);
  const hit = memory.get(key);
  if (hit !== undefined) {
    return Promise.resolve(hit.output);
  }
  const existing = inflight.get(key);
  if (existing !== undefined) {
    return joinObserver(existing, opts?.signal);
  }
  const shared = runProbe(
    bin,
    resolved,
    stamp,
    env,
    versionProbeTimeoutMs(opts?.timeoutMs),
  ).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, shared);
  return joinObserver(shared, opts?.signal);
};

/** Drop memory + inflight and re-read persist on the next lookup. */
export const clearCliVersionCacheForTests = (): void => {
  memory.clear();
  inflight.clear();
  persistLoaded = false;
  persistLocked = false;
  persistQueued = false;
};
