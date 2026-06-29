/**
 * Shared, provider-agnostic login-flow scaffolding for the subscription
 * delegates.
 *
 * The three delegates (`claude-code`, `chatgpt`, `kimi-code`) each expose up to
 * two login methods on `TProviderDelegate`: `connect()` (the on-this-box native
 * login) and `connectDeviceCode()` (the remote/headless login). The orchestration
 * around those — the install-check + already-signed-in preamble, the single-flight
 * guard, the background-exit cleanup, and the codex stream-spawn reader loop —
 * is identical across providers and used to be copy-pasted into each delegate.
 * It lives here once; the per-method adaptors (`login-direct`, `login-device`)
 * build on it, and the delegates inject only their provider-specifics (token
 * store, parse fns, keychain hooks).
 *
 * The single-flight `loginSlot` is keyed by provider and SHARED between the two
 * adaptors so a provider whose `connect` + `connectDeviceCode` must not run at
 * once (codex: one `codex login` process binds the localhost callback / polls)
 * stays guarded across both methods.
 */

import type { TPendingAuth } from "../pending-auth";
import {
  clearPendingAuth,
  getPendingAuth,
  pendingAuthDetail,
} from "../pending-auth";

/** The shared return shape of `connect()` / `connectDeviceCode()`. */
export type TConnectResult = {
  readonly connected: boolean;
  readonly detail?: string;
  readonly pending?: boolean;
};

// ─── Per-provider single-flight slot ─────────────────────────────────────

/**
 * One provider's login single-flight state, shared by its direct + device
 * adaptors. Holds the in-flight flag plus the set of cancelers a live
 * background flow registers — killing a spawned process (codex), setting an
 * abort flag (kimi's poll), or `THeadlessLogin.cancel()` (claude paste-back).
 * `cancelConnect` runs them all.
 */
export type TLoginSlot = {
  /** True while a background login is in flight for this provider. */
  readonly inFlight: () => boolean;
  /** Mark in-flight + register the live flow's canceler. Call only AFTER the
   *  spawn/handle exists — an early mark wedges the slot if the spawn throws. */
  readonly start: (canceler: () => void) => void;
  /** Clear in-flight + drop all cancelers (the background-exit cleanup). */
  readonly end: () => void;
  /** Run every registered canceler and clear them. Returns how many ran (>0 ⇔
   *  a login was in flight) — `inFlight` itself is left for the flow's own exit
   *  handler to clear via `end()`, mirroring the pre-refactor kill→exit order. */
  readonly cancelAll: () => number;
};

const slots = new Map<string, TLoginSlot>();

/** The memoized single-flight slot for `provider` (created on first use). */
export const loginSlot = (provider: string): TLoginSlot => {
  const existing = slots.get(provider);
  if (existing !== undefined) return existing;
  let inFlight = false;
  const cancelers = new Set<() => void>();
  const slot: TLoginSlot = {
    inFlight: () => inFlight,
    start: (canceler) => {
      inFlight = true;
      cancelers.add(canceler);
    },
    end: () => {
      inFlight = false;
      cancelers.clear();
    },
    cancelAll: () => {
      const n = cancelers.size;
      for (const fn of cancelers) {
        try {
          fn();
        } catch {
          // already gone — the flow's own exit handler ran
        }
      }
      cancelers.clear();
      return n;
    },
  };
  slots.set(provider, slot);
  return slot;
};

// ─── Guard preamble ──────────────────────────────────────────────────────

export type TGuardOpts = {
  readonly provider: string;
  /** Whether the vendor CLI is installed; a `false` returns `installHint`. */
  readonly installed: () => Promise<boolean>;
  readonly installHint: string;
  /** Optional already-signed-in short-circuit (codex/kimi/claude-device). */
  readonly shortCircuit?: {
    readonly connected: () => Promise<boolean>;
    readonly detail: string;
  };
  /** Optional single-flight slot — when in-flight, re-surface instead of
   *  spawning a second login. Absent ⇒ no single-flight (claude's blocking
   *  `connect`, which simply blocks in the spawned login). */
  readonly slot?: TLoginSlot;
  /** Fallback re-surface detail when no pending-auth is live. */
  readonly inProgressDetail?: string;
  /** Override the default re-surface result (kimi's `connect` returns a fixed
   *  string with no `pending` flag, unlike codex/claude's pending re-surface). */
  readonly resurface?: (pending: TPendingAuth | null) => TConnectResult;
};

/**
 * Run the shared login preamble, then `run()` if it clears: not-installed →
 * `installHint`; already-signed-in short-circuit (clears any stale pending);
 * single-flight re-surface; otherwise start the flow.
 */
export const guard = async (
  opts: TGuardOpts,
  run: () => Promise<TConnectResult>,
): Promise<TConnectResult> => {
  if (!(await opts.installed())) {
    return { connected: false, detail: opts.installHint };
  }
  if (
    opts.shortCircuit !== undefined &&
    (await opts.shortCircuit.connected())
  ) {
    clearPendingAuth(opts.provider);
    return { connected: true, detail: opts.shortCircuit.detail };
  }
  if (opts.slot?.inFlight() === true) {
    const pending = getPendingAuth(opts.provider);
    if (opts.resurface !== undefined) return opts.resurface(pending);
    return {
      connected: false,
      pending: true,
      detail:
        pending !== null
          ? pendingAuthDetail(pending)
          : (opts.inProgressDetail ??
            "Sign-in already in progress — this updates automatically."),
    };
  }
  return run();
};

// ─── Background-exit cleanup ─────────────────────────────────────────────

/**
 * The cleanup a background login runs when its process exits / its poll ends:
 * clear single-flight, then — if a credential landed — run `onConnected`
 * (e.g. refresh the auth config), else drop the stale pending code so the card
 * stops showing a dead one. `alwaysClearPending` also drops it on success
 * (claude's paste-back clears unconditionally; codex/kimi rely on `status()`).
 */
export const finishInBackground = async (opts: {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly isConnected: () => Promise<boolean>;
  readonly onConnected?: () => void | Promise<void>;
  readonly alwaysClearPending?: boolean;
}): Promise<void> => {
  opts.slot.end();
  const connected = await opts.isConnected();
  if (opts.alwaysClearPending === true || !connected) {
    clearPendingAuth(opts.provider);
  }
  if (connected && opts.onConnected !== undefined) {
    await opts.onConnected();
  }
};

// ─── Stream-spawn login primitive (codex) ────────────────────────────────

/** Ceiling on first seeing the spawned CLI's auth prompt before giving up. */
const STREAM_PROMPT_TIMEOUT_MS = 30_000;

export type TStreamLoginOpts<T> = {
  readonly provider: string;
  readonly slot: TLoginSlot;
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  /** Which fd carries the prompt: codex `login` prints the authorize URL to
   *  stderr; `codex login --device-auth` prints the device prompt to stdout. */
  readonly stream: "stdout" | "stderr";
  /** Returns the parsed prompt the instant the buffered output contains it. */
  readonly parse: (buf: string) => T | null;
  readonly timeoutMs?: number;
  /** Already-signed-in check for the background-exit cleanup. */
  readonly isConnected: () => Promise<boolean>;
  /** Runs in the background-exit cleanup when a credential landed. */
  readonly onConnected?: () => void | Promise<void>;
};

/**
 * Spawn a vendor CLI login, drain ONE fd, and resolve the instant `parse`
 * matches — then keep draining for the process's lifetime so a full pipe can't
 * stall the child's background callback/poll. The process is NOT killed on a
 * match (it runs its localhost callback / device poll until the credential
 * lands); `proc.exited` runs {@link finishInBackground}. On no match within the
 * timeout the child is killed and `{ found: null, captured }` is returned (the
 * captured output fuels codex's redacted no-URL log).
 *
 * Single-flight is marked AFTER a successful spawn (a `Bun.spawn` throw must not
 * wedge the slot), mirroring the pre-refactor "set loginInFlight after spawn".
 */
export const spawnStreamLogin = async <T>(
  opts: TStreamLoginOpts<T>,
): Promise<
  { readonly found: T } | { readonly found: null; readonly captured: string }
> => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...opts.argv], {
      stdin: "ignore",
      stdout: opts.stream === "stdout" ? "pipe" : "ignore",
      // The unread fd is discarded (not piped) so an undrained pipe can't stall
      // the child — only the prompt-carrying fd is read.
      stderr: opts.stream === "stderr" ? "pipe" : "ignore",
      env: { ...process.env, ...opts.env },
    });
  } catch {
    return { found: null, captured: "" };
  }
  opts.slot.start(() => {
    try {
      proc.kill();
    } catch {
      // already exited — its own exit handler ran
    }
  });
  void proc.exited.then(() =>
    finishInBackground({
      provider: opts.provider,
      slot: opts.slot,
      isConnected: opts.isConnected,
      onConnected: opts.onConnected,
    }),
  );

  const readable = (
    opts.stream === "stdout" ? proc.stdout : proc.stderr
  ) as ReadableStream<Uint8Array>;
  let captured = "";
  const found = await new Promise<T | null>((resolve) => {
    let settled = false;
    const settle = (v: T | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(
      () => settle(null),
      opts.timeoutMs ?? STREAM_PROMPT_TIMEOUT_MS,
    );
    void (async () => {
      const decoder = new TextDecoder();
      try {
        const reader = readable.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          captured += decoder.decode(value, { stream: true });
          const p = opts.parse(captured);
          if (p !== null) settle(p);
        }
      } catch {
        /* ignore — settle(null) in finally */
      } finally {
        clearTimeout(timer);
        settle(null);
      }
    })();
  });

  if (found === null) {
    try {
      proc.kill();
    } catch {
      // already gone
    }
    return { found: null, captured };
  }
  return { found };
};

// ─── cancelConnect ───────────────────────────────────────────────────────

/**
 * Build the delegate's `cancelConnect`: run the in-flight flow's canceler(s)
 * via the shared slot + drop the pending code. Idempotent — no in-flight flow
 * is success. The `messages` carry the provider's wording.
 */
export const makeCancelConnect = (
  provider: string,
  slot: TLoginSlot,
  messages: { readonly cancelled: string; readonly none: string },
): (() => Promise<{ readonly ok: boolean; readonly detail: string }>) => {
  return async () => {
    const n = slot.cancelAll();
    clearPendingAuth(provider);
    return { ok: true, detail: n > 0 ? messages.cancelled : messages.none };
  };
};
