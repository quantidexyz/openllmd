/**
 * Shared helpers for official-CLI delegation.
 *
 * ⚠️ UNVERIFIED AGAINST LIVE CLIs. The credential-store paths, file
 * shapes, and login commands below are derived from public docs +
 * upstream source research (2025-2026), NOT yet validated against real
 * logged-in installations. Each delegate is marked accordingly; confirm
 * hands-on before relying on it in production. See the per-delegate
 * `RESEARCH` notes.
 *
 * Bright line (proposal §6): nothing read from a CLI's store may be sent
 * off-box. These helpers feed the LOCAL runner + the local usage panel
 * only.
 */
import { chmodSync, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { logError } from "../logger";
import { daemonTempDir } from "../sandbox/working-set";

/** Merge an env map onto the parent env for a spawned isolated CLI. */
const spawnEnv = (
  env: Record<string, string> | undefined,
): Record<string, string | undefined> | undefined =>
  env === undefined ? undefined : { ...process.env, ...env };

/**
 * Surface a child that was KILLED BY A SIGNAL (`signalCode` set) — the silent
 * failure mode behind "the flow doesn't trigger, no errors". The OS sandbox
 * SIGKILLs/SIGABRTs a child that hits a denied operation, and a plain exit-code
 * check misses it. Logging the command + signal at ERROR level puts the actual
 * culprit in `openllmd.err.log` instead of letting it vanish. Returns whether a
 * kill was detected (so callers can treat it as a definite failure). No-op for
 * a clean exit.
 */
const logIfKilled = (
  argv: ReadonlyArray<string>,
  proc: {
    readonly signalCode: string | null;
    readonly exitCode: number | null;
  },
): boolean => {
  if (proc.signalCode === null) return false;
  logError("delegation", `child killed by ${proc.signalCode}`, {
    command: argv[0],
    argv: [...argv],
    signal: proc.signalCode,
    // The dominant cause on a sandboxed daemon: the child hit a denied op.
    hint: "likely an OS sandbox denial — see DaemonStatus.sandbox / the sandbox working set",
  });
  return true;
};

/**
 * Run a command and capture trimmed stdout (best-effort). Returns null on
 * spawn failure or non-zero exit. stdin is ignored so it never blocks.
 * `env` is merged onto the parent env — used to run the isolated vendor
 * CLIs with their home pointed inside the OpenLLM dir.
 */
export const runCapture = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string>,
): Promise<string | null> => {
  try {
    const proc = Bun.spawn([...argv], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    logIfKilled(argv, proc);
    if (code !== 0) return null;
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
};

/** Run a binary's `--version` (best-effort). Returns null on failure. */
export const cliVersion = (
  bin: string,
  env?: Record<string, string>,
): Promise<string | null> => runCapture([bin, "--version"], env);

export type TLoginResult = {
  readonly code: number;
  /** Combined stdout+stderr (trimmed), for surfacing failures. */
  readonly output: string;
  /** True when we abandoned the child (early `until` match or timeout) rather
   *  than it exiting on its own — its OUTPUT is still valid (the token/cred was
   *  produced first), it just never cleanly exited. */
  readonly abandoned: boolean;
};

export type TSpawnLoginOpts = {
  /** Hard ceiling: kill the child after this and return what was captured.
   *  A browser OAuth needs the user to sign in, so it's generous. */
  readonly timeoutMs?: number;
  /** When the COMBINED output matches this, the child has produced what we
   *  need (e.g. a printed verification prompt) — kill it and return immediately
   *  instead of waiting for it to exit. Vendor CLIs (themselves Bun/Node
   *  binaries) can hang in `__cxa_finalize`/atexit AFTER printing it, so waiting
   *  on `proc.exited` would block forever + pile up 99%-CPU runaways. We don't
   *  need the exit — only the output. */
  readonly until?: RegExp;
};

/** Default login ceiling — long enough for a human to complete the browser
 *  OAuth, short enough that a wedged child is reaped, not left forever. */
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** After `opts.until` first matches, wait this long for the rest of a
 *  chunk-split token to arrive before killing — so the captured token is the
 *  COMPLETE one even though the regex isn't boundary-anchored. */
const UNTIL_SETTLE_MS = 400;

/**
 * Spawn a vendor CLI's login command and capture its output. The CLI opens the
 * user's browser; the user signs in and the CLI completes via its own localhost
 * callback, at which point the credential is in the CLI's OWN store. stdin is
 * ignored (browser-driven; headless daemon has no usable stdin).
 *
 * Robustness (load-bearing): we NEVER block indefinitely on the child exiting.
 * Output is STREAMED; if `opts.until` matches we kill the child and return
 * (the vendor CLI can hang in atexit AFTER printing the token — see
 * `TSpawnLoginOpts.until`), and a `timeoutMs` ceiling reaps a wedged child
 * regardless. Either way the captured output is returned — the caller re-reads
 * the store / parses the token from it.
 */
export const spawnLogin = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string>,
  opts?: TSpawnLoginOpts,
): Promise<TLoginResult> => {
  const proc = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
  });
  const dec = new TextDecoder();
  let out = "";
  let err = "";
  let abandoned = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const kill = (): void => {
    if (abandoned) return;
    abandoned = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  };

  killTimer = setTimeout(kill, opts?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);

  const pump = async (
    stream: ReadableStream<Uint8Array>,
    onChunk: (s: string) => void,
  ): Promise<void> => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) onChunk(dec.decode(value));
        // Early-return once the awaited output appears (the child may never exit
        // cleanly — it can WEDGE after printing the token). Match the COMBINED
        // stream so a token on either fd is seen. We don't kill immediately: a
        // token can arrive split across read chunks, so a SETTLE delay lets the
        // remaining bytes land before we kill + parse — capturing the FULL token
        // without needing a stricter (and more brittle) trailing-boundary regex.
        if (
          opts?.until !== undefined &&
          settleTimer === null &&
          !abandoned &&
          opts.until.test(`${out}\n${err}`)
        ) {
          settleTimer = setTimeout(kill, UNTIL_SETTLE_MS);
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  await Promise.all([
    pump(proc.stdout, (s) => {
      out += s;
    }),
    pump(proc.stderr, (s) => {
      err += s;
    }),
    proc.exited,
  ]);
  if (killTimer !== null) clearTimeout(killTimer);
  if (settleTimer !== null) clearTimeout(settleTimer);

  // Only surface a SIGNAL kill we did NOT cause (a sandbox/OS kill) — our own
  // `until`/timeout kill is expected and its output is valid.
  if (!abandoned) logIfKilled(argv, proc);
  // Join with a newline, NOT bare concatenation: a token printed as the last
  // bytes of stdout (no trailing newline) must not fuse with the first bytes
  // of stderr, or a greedy token match would swallow the spillover.
  return {
    code: proc.exitCode ?? -1,
    output: `${out}\n${err}`.trim(),
    abandoned,
  };
};

// ─── Headless paste-back login (Claude remote) ──────────────────────
//
// `claude auth login --claudeai` with DISPLAY unset prints a hosted-callback
// authorize URL (platform.claude.com) + a `Paste code here if prompted >`
// prompt, holds an in-process PKCE verifier, and consumes the pasted code on
// stdin (a bad paste re-prompts; the process stays alive). Verified live
// against claude v2.1.185. See
// `docs/proposals/headless-claude-login-paste-back.md`.

/** Parse the authorize URL the CLI prints for the no-browser fallback. */
const HEADLESS_URL_RE = /If the browser didn't open, visit:\s*(\S+)/;
/** The CLI's inline reject on a wrong/partial paste — it stays alive to retry. */
const HEADLESS_INVALID_RE = /Invalid code\b/i;
/** Ceiling on first seeing the authorize URL before giving up. */
const HEADLESS_URL_TIMEOUT_MS = 30_000;
/** Ceiling on one code submission resolving (exchange completes or rejects). */
const HEADLESS_SUBMIT_TIMEOUT_MS = 60_000;

export type THeadlessLogin = {
  /** The authorize URL to surface to the caller's browser (hosted-callback). */
  readonly url: string;
  /** Write a pasted authorization code to the live CLI's stdin and await the
   *  outcome. `ok:false` (e.g. an `Invalid code` reject) leaves the process
   *  ALIVE for a retry; `ok:true` means the CLI exchanged + exited. */
  readonly submitCode: (code: string) => Promise<{
    readonly ok: boolean;
    readonly detail: string;
  }>;
  /** Resolves when the login process exits (success, cancel, or expiry). */
  readonly done: Promise<void>;
  /** Kill the login process (cancel an in-flight paste-back). */
  readonly cancel: () => void;
};

let noBrowserShimDir: string | null | undefined;
/**
 * A directory holding no-op `open` / `xdg-open` scripts to PREPEND to a login
 * child's PATH so it can't pop a browser tab on the daemon's own machine
 * (claude opens via a PATH lookup — verified interceptable, unlike codex).
 * Best-effort: returns null if it can't be created (the login still works —
 * the printed URL + paste prompt are unaffected; at worst a tab opens on a
 * remote GUI box). Cached after the first success.
 */
const ensureNoBrowserShimDir = async (): Promise<string | null> => {
  if (noBrowserShimDir !== undefined) return noBrowserShimDir;
  try {
    const dir = join(daemonTempDir(), "no-browser");
    await mkdir(dir, { recursive: true });
    for (const name of ["open", "xdg-open"]) {
      const p = join(dir, name);
      await Bun.write(p, "#!/bin/sh\nexit 0\n");
      chmodSync(p, 0o755);
    }
    noBrowserShimDir = dir;
  } catch {
    noBrowserShimDir = null;
  }
  return noBrowserShimDir;
};

/**
 * Spawn `claude auth login --claudeai` (DISPLAY-stripped, browser suppressed)
 * for a REMOTE/headless box, parse the authorize URL it prints, and hold the
 * process open on a WRITABLE stdin so the pasted code can be fed back later.
 * Returns `{ error }` if no URL is emitted within the timeout.
 */
export const spawnHeadlessLogin = async (
  argv: ReadonlyArray<string>,
  env: Record<string, string>,
  opts?: { readonly urlTimeoutMs?: number },
): Promise<THeadlessLogin | { error: string }> => {
  const shimDir = await ensureNoBrowserShimDir();
  const baseEnv = spawnEnv(env) ?? { ...process.env };
  const childEnv: Record<string, string | undefined> = { ...baseEnv };
  // No GUI → the printed URL is the hosted-callback (platform.claude.com) one
  // the user can complete from another machine; also makes any browser-open a
  // no-op fallback.
  delete childEnv.DISPLAY;
  delete childEnv.WAYLAND_DISPLAY;
  if (shimDir !== null) {
    childEnv.PATH = `${shimDir}:${baseEnv.PATH ?? process.env.PATH ?? ""}`;
  }

  const proc = Bun.spawn([...argv], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });

  const dec = new TextDecoder();
  let combined = "";
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) combined += dec.decode(value);
      }
    } finally {
      reader.releaseLock();
    }
  };
  // Drain both fds for the process's lifetime so a full pipe can't stall it.
  void pump(proc.stdout);
  void pump(proc.stderr);
  const done = proc.exited.then(() => {});

  const url = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(
      () => finish(null),
      opts?.urlTimeoutMs ?? HEADLESS_URL_TIMEOUT_MS,
    );
    const poll = setInterval(() => {
      const m = stripAnsi(combined).match(HEADLESS_URL_RE);
      if (m !== null) finish(m[1]);
    }, 100);
    void proc.exited.then(() => finish(null));
  });

  if (url === null) {
    try {
      proc.kill();
    } catch {
      // already gone
    }
    const sample = stripAnsi(combined)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return {
      error:
        sample.length > 0
          ? sample
          : "claude auth login emitted no authorize URL",
    };
  }

  const submitCode = (
    code: string,
  ): Promise<{ ok: boolean; detail: string }> => {
    const mark = combined.length;
    try {
      proc.stdin.write(`${code}\n`);
      void proc.stdin.flush();
    } catch {
      return Promise.resolve({
        ok: false,
        detail: "login process is no longer accepting input",
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: { ok: boolean; detail: string }): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(
        () => finish({ ok: false, detail: "timed out waiting for the code" }),
        HEADLESS_SUBMIT_TIMEOUT_MS,
      );
      // A wrong/partial paste prints `Invalid code` and the process stays
      // alive — surface a retryable failure without killing the flow.
      const poll = setInterval(() => {
        if (HEADLESS_INVALID_RE.test(stripAnsi(combined.slice(mark)))) {
          finish({
            ok: false,
            detail:
              "Invalid code — copy the full code from the page and paste it again.",
          });
        }
      }, 100);
      // A valid code → the CLI exchanges and exits.
      void proc.exited.then(() =>
        finish(
          proc.exitCode === 0
            ? { ok: true, detail: "signed in" }
            : { ok: false, detail: `login exited ${proc.exitCode ?? -1}` },
        ),
      );
    });
  };

  const cancel = (): void => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };

  return { url, submitCode, done, cancel };
};

// OSC (ESC ] … BEL/ST), CSI (ESC [ … final), and lone ESC. Built from a
// string so the source stays free of raw control bytes.
const ANSI_RE = new RegExp(
  "\\u001b\\][^]*?(?:\\u0007|\\u001b\\\\)" +
    "|\\u001b\\[[0-9;?]*[ -/]*[@-~]" +
    "|\\u001b[@-Z\\\\-_]",
  "g",
);

/**
 * Strip ANSI/terminal control sequences (CSI colour codes, OSC, lone escapes)
 * from CLI output so a value parsed out of it isn't fused with rendering bytes.
 */
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/**
 * Build the `script(1)` argv that runs `argv` under a PSEUDO-TERMINAL, writing
 * the terminal capture to `typescript` — or null on an OS without `script`
 * (caller falls back to a plain pipe spawn). Some vendor CLIs only run attached
 * to a real terminal (e.g. `kimi -p`'s raw-mode-gated print mode), emitting
 * NOTHING under a plain pipe. Shared by
 * {@link spawnLoginPty} (which POLLS the typescript for an `until` regex) and
 * the exec-fixture capture (which ignores the typescript — pass `/dev/null` —
 * and drives off its HTTP recorder instead).
 *
 * Subtleties baked in:
 *   - `-F` (BSD) / `-f` (util-linux, inside `-qfc`) is LOAD-BEARING: without it
 *     `script` BUFFERS the typescript and only flushes on close, so a poller
 *     reads empty until the child exits. `-F` flushes after every write.
 *   - `script` allocates the PTY at the DEFAULT 80×24 — window size is an ioctl
 *     (TIOCSWINSZ), NOT `COLUMNS`/`LINES` — so a TUI rendering a fixed-width box
 *     wraps a long value mid-line. We resize the slave with `stty` INSIDE the
 *     PTY (runs on the controlling tty before the real command via `exec`).
 *     `2>/dev/null` keeps an `stty`-less environment from breaking the flow.
 *   - BSD (`script -q <file> cmd…`) vs util-linux (`script -qfc "cmd" <file>`)
 *     differ in argument order.
 */
export const ptyScriptArgv = (
  argv: ReadonlyArray<string>,
  typescript: string,
): string[] | null => {
  const os = platform();
  if (os !== "darwin" && os !== "linux") return null;
  const escapeShellArg = (arg: string): string =>
    `'${arg.replace(/'/g, "'\\''")}'`;
  const cmd = argv.map(escapeShellArg).join(" ");
  const widen = `stty cols 1000 rows 50 2>/dev/null; exec ${cmd}`;
  return os === "darwin"
    ? ["script", "-F", "-q", typescript, "sh", "-c", widen]
    : ["script", "-qfc", widen, typescript];
};

/**
 * Like {@link spawnLogin}, but runs `argv` under a PSEUDO-TERMINAL (via
 * `script(1)`). Some vendor CLIs only work attached to a real terminal — e.g.
 * `kimi -p`'s raw-mode-gated print mode writes to its controlling terminal
 * (`/dev/tty`), so spawned with a plain pipe (no controlling TTY) it emits
 * NOTHING and the headless daemon captures `outputLen: 0`. A PTY makes it
 * actually run, and we capture its terminal output to a `script` typescript
 * file which we POLL — so `opts.until` returns the instant the match appears.
 *
 * Key subtleties, each load-bearing (see the harness in `tests/`):
 *   - stdin is `/dev/null` (`"ignore"`): a Bun pipe/stream/inherited stdin makes
 *     `script` block before it sets up the PTY (empirically 0 bytes captured).
 *   - the child does NOT EOF-exit despite `/dev/null`: it reads the PTY SLAVE,
 *     not `script`'s stdin, so its stdin stays open for the browser flow.
 *   - we read the typescript FILE, not `script`'s stdout: piping `script`'s
 *     stdout under `Bun.spawn` also yields 0 bytes.
 *   - BSD (`script -q <file> cmd…`) vs util-linux (`script -qfc "cmd" <file>`)
 *     differ; unsupported elsewhere → falls back to plain {@link spawnLogin}.
 */
export const spawnLoginPty = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string>,
  opts?: TSpawnLoginOpts,
): Promise<TLoginResult> => {
  const os = platform();
  if (os !== "darwin" && os !== "linux") return spawnLogin(argv, env, opts);

  const tsFile = join(
    daemonTempDir(),
    `openllmd-pty-${process.pid}-${Date.now().toString(36)}.log`,
  );
  await Bun.write(tsFile, "");
  // PTY argv (shared with the exec-fixture capture). Non-null here: the OS was
  // already gated to darwin/linux above. We POLL `tsFile` for `opts.until`.
  const scriptArgv = ptyScriptArgv(argv, tsFile) ?? [...argv];

  const proc = Bun.spawn(scriptArgv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
  });

  const deadline = Date.now() + (opts?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  const readFile = (): Promise<string> =>
    Bun.file(tsFile)
      .text()
      .catch(() => "");
  let abandoned = false;
  let captured = "";
  for (;;) {
    captured = await readFile();
    if (opts?.until?.test(stripAnsi(captured)) === true) {
      // Settle: let the rest of the token line render before we kill + parse.
      await new Promise((r) => setTimeout(r, UNTIL_SETTLE_MS));
      captured = await readFile();
      abandoned = true;
      proc.kill("SIGKILL");
      break;
    }
    if (proc.exitCode !== null || proc.signalCode !== null) break; // exited
    if (Date.now() >= deadline) {
      abandoned = true;
      proc.kill("SIGKILL");
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  await proc.exited;
  captured = await readFile(); // final read (token written just before exit)
  await rm(tsFile, { force: true }).catch(() => {});
  if (!abandoned) logIfKilled(scriptArgv, proc);
  return { code: proc.exitCode ?? -1, output: stripAnsi(captured), abandoned };
};

/**
 * Best-effort open a URL in the user's default browser (macOS `open`, Windows
 * `cmd /c start`, else `xdg-open`). Used by the browser / device-code login
 * flows to bring up the vendor's auth page FROM the daemon — some vendor CLIs
 * print the URL but their own auto-open doesn't reach the user's GUI session
 * when the daemon spawns them (e.g. codex). Never throws; the user can copy the
 * URL from the card.
 */
export const openUrl = (url: string): void => {
  const os = platform();
  // Windows: `start` is a cmd builtin, so it must run via `cmd /c`; the empty
  // "" is the (required) window-title arg, and the URL is quoted so `cmd.exe`
  // doesn't treat an OAuth URL's `&` as a command separator.
  const argv: string[] =
    os === "darwin"
      ? ["open", url]
      : os === "win32"
        ? ["cmd", "/c", "start", "", `"${url}"`]
        : ["xdg-open", url];
  try {
    Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // best-effort — the user can copy the URL from the card detail
  }
};

/** Read + JSON-parse a file, or null if absent / unparseable. */
export const readJsonFile = async <T>(path: string): Promise<T | null> => {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return (await file.json()) as T;
  } catch {
    return null;
  }
};

// ─── Isolated macOS login keychain ──────────────────────────────────────
//
// On macOS, Claude Code stores its OAuth credential in the login Keychain
// (there is NO file-based override — confirmed via the Claude Code docs).
// Claude resolves the login keychain by HOME path, so running it with an
// isolated HOME and no keychain there fails with the system dialog "A
// keychain cannot be found to store <user>". The fix: give the isolated
// HOME its OWN login keychain at `<home>/Library/Keychains/login.keychain-db`.
//
// We deliberately do NOT call `security default-keychain`/`list-keychains`:
// those mutate the live securityd SESSION search list (not HOME-scoped),
// which would pollute the user's real keychain environment. Instead we
// create + unlock the keychain at the HOME-derived path (which Claude
// finds on its own) and READ it back by EXPLICIT path (the `security` CLI
// resolves the default via the session, not HOME, so the path is required).

const MAC = platform() === "darwin";

const loginKeychainPath = (home: string): string =>
  join(home, "Library", "Keychains", "login.keychain-db");

const runSecurity = async (
  argv: ReadonlyArray<string>,
  home: string,
): Promise<boolean> => {
  try {
    const proc = Bun.spawn(["security", ...argv], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, HOME: home },
    });
    const code = await proc.exited;
    // A `security` child SIGKILLed by the sandbox leaves no keychain + no
    // trace — surface it so a later "Keychain Not Found" dialog is explained.
    logIfKilled(["security", ...argv], proc);
    return code === 0;
  } catch {
    return false;
  }
};

// Keychains we've already created+unlocked this process. Auto-lock is
// disabled, so a keychain stays unlocked for the daemon's lifetime — no
// need to re-spawn `security` on every status poll (which runs ~every 5s).
const ensuredKeychains = new Set<string>();

// In-flight ensures, keyed by keychain path. The status watcher fires every
// ~2.5s and is NOT serialized, so a slow `status()` lets ticks overlap; without
// this, concurrent callers would race `security create-keychain` on the same
// path and collide with `errSecDuplicateKeychain`. Overlapping callers instead
// await the SAME operation.
const inFlightKeychains = new Map<string, Promise<void>>();

// Throttle the create-failure log so a persistent failure doesn't spam the
// error stream on every ~2.5s status tick (it used to re-log forever because a
// failure never entered `ensuredKeychains`). One line per keychain per window.
const lastKeychainFailureLogMs = new Map<string, number>();
const KEYCHAIN_FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;

const logKeychainFailure = (kc: string): void => {
  const now = Date.now();
  if (
    now - (lastKeychainFailureLogMs.get(kc) ?? 0) <
    KEYCHAIN_FAILURE_LOG_INTERVAL_MS
  )
    return;
  lastKeychainFailureLogMs.set(kc, now);
  logError(
    "keychain",
    "failed to create the isolated login keychain — claude login will pop the 'Keychain Not Found' dialog and hang",
    { keychain: kc },
  );
};

/**
 * macOS only: ensure an isolated, unlocked login keychain exists at
 * `<home>/Library/Keychains/login.keychain-db` so a CLI run with
 * `HOME=<home>` (e.g. `claude auth login`) can WRITE its credential
 * without the "Keychain Not Found" dialog. Empty password; auto-lock
 * disabled so subsequent reads don't prompt. Idempotent + process-cached;
 * concurrency-deduped; no-op off macOS.
 */
export const ensureIsolatedKeychain = async (home: string): Promise<void> => {
  if (!MAC) return;
  const kc = loginKeychainPath(home);
  // The cache skips re-spawning `security` on the hot path (the ~2.5s status
  // watcher), but ALWAYS re-verify the file still exists first — `existsSync`
  // is cheap (no spawn) and a missing keychain (deleted out from under us, or a
  // fresh install) must be recreated, or `claude auth login` later pops the
  // "Keychain Not Found" dialog.
  if (ensuredKeychains.has(kc) && existsSync(kc)) return;
  const pending = inFlightKeychains.get(kc);
  if (pending !== undefined) return pending;
  const op = ensureKeychainNow(home, kc).finally(() => {
    inFlightKeychains.delete(kc);
  });
  inFlightKeychains.set(kc, op);
  return op;
};

const ensureKeychainNow = async (home: string, kc: string): Promise<void> => {
  if (!existsSync(kc)) {
    ensuredKeychains.delete(kc); // stale cache entry — file is gone
    const dir = dirname(kc);
    await mkdir(dir, { recursive: true });
    // macOS `securityd` REFUSES to `create-keychain` at the RESERVED
    // `login.keychain-db` name when it sits inside the $HOME subtree under the
    // Seatbelt sandbox: it routes through the session login-keychain machinery,
    // which needs the real `~/Library/Keychains` the deny-$HOME read policy
    // blocks → `errSec 161` (no file) or a GUI auth prompt. So create +
    // configure at a NON-reserved staging name (which securityd treats as an
    // ordinary keychain), THEN atomically rename the finished file into place.
    // Claude finds `login.keychain-db` by default-resolution and our own reads
    // use the explicit path. See
    // docs/audit/2026-06-22-daemon-mac-sandbox-failures.md §3.
    const staging = join(dir, `.openllm-staging-${process.pid}.keychain-db`);
    // Sweep orphaned staging files from a prior run that crashed between
    // create + rename (the filename carries the pid, so they'd otherwise
    // accumulate). Best-effort.
    try {
      for (const f of await readdir(dir)) {
        if (f.startsWith(".openllm-staging-") && f.endsWith(".keychain-db")) {
          await rm(join(dir, f), { force: true });
        }
      }
    } catch {
      // dir unreadable / race — non-fatal
    }
    const created = await runSecurity(
      ["create-keychain", "-p", "", staging],
      home,
    );
    if (created) {
      // Disable auto-lock on the STAGING name (set-keychain-settings on the
      // reserved name pops "User canceled the operation" under the sandbox);
      // the setting persists in the file through the rename.
      await runSecurity(["set-keychain-settings", staging], home);
      try {
        await rename(staging, kc);
      } catch {
        await rm(staging, { force: true });
      }
    } else {
      await rm(staging, { force: true });
    }
    // If the file STILL isn't there, a later `claude auth login` will pop the
    // "Keychain Not Found" dialog and WEDGE. Surface it (throttled) so the real
    // cause is in openllmd.err.log without spamming every status tick.
    if (!existsSync(kc)) {
      logKeychainFailure(kc);
      return; // not ensured; retried next call
    }
  }
  // Unlock at the FINAL path (securityd keys unlock state by path, so re-unlock
  // after the rename). Unlocking the reserved name by explicit path is fine —
  // only `create-keychain` at it fails.
  await runSecurity(["unlock-keychain", "-p", "", kc], home);
  ensuredKeychains.add(kc);
};

/**
 * macOS only: grant command-line tools prompt-free access to the items in
 * the isolated keychain. Run AFTER a login writes them, so our later
 * `security find-generic-password` reads don't trigger the "security
 * wants to access the keychain" GUI prompt. Best-effort.
 */
export const grantKeychainToolAccess = async (home: string): Promise<void> => {
  if (!MAC) return;
  await runSecurity(
    [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      "",
      loginKeychainPath(home),
    ],
    home,
  );
};

/**
 * Discover every generic-password service name in the isolated keychain
 * that STARTS WITH `prefix`. Claude suffixes its keychain service with a
 * per-install hash (e.g. `Claude Code-credentials-753e4afa`) so multiple
 * configs don't collide, so an exact-name lookup misses it. `dump-keychain`
 * lists attributes only (no `-d`), so it doesn't prompt for secrets.
 */
const findKeychainServices = async (
  home: string,
  prefix: string,
): Promise<ReadonlyArray<string>> => {
  try {
    const proc = Bun.spawn(
      ["security", "dump-keychain", loginKeychainPath(home)],
      { stdout: "pipe", stderr: "ignore", env: { ...process.env, HOME: home } },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const names = new Set<string>();
    for (const line of out.split("\n")) {
      const m = line.match(/"svce"<blob>="([^"]*)"/);
      if (m?.[1]?.startsWith(prefix) === true) {
        names.add(m[1]);
      }
    }
    return [...names];
  } catch {
    return [];
  }
};

const readKeychainSecret = async (
  home: string,
  service: string,
): Promise<string | null> => {
  try {
    const proc = Bun.spawn(
      [
        "security",
        "find-generic-password",
        "-s",
        service,
        "-w",
        loginKeychainPath(home),
      ],
      { stdout: "pipe", stderr: "ignore", env: { ...process.env, HOME: home } },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
};

/**
 * Read a generic-password `-w` payload from the ISOLATED login keychain,
 * matching `servicePrefix` (Claude's service name carries a per-install
 * hash suffix, so we match by prefix and try each candidate). `validate`
 * rejects a wrong-but-matching item — the first valid payload wins.
 * Returns null off macOS / on any failure.
 */
export const readIsolatedKeychain = async (
  home: string,
  servicePrefix: string,
  validate?: (payload: string) => boolean,
): Promise<string | null> => {
  if (!MAC) return null;
  await ensureIsolatedKeychain(home); // ensure present + unlocked
  try {
    for (const service of await findKeychainServices(home, servicePrefix)) {
      const secret = await readKeychainSecret(home, service);
      if (secret === null) continue;
      if (validate !== undefined && !validate(secret)) continue;
      return secret;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Update an existing generic-password item in the ISOLATED login keychain
 * (matching `servicePrefix` — Claude's suffixed service name) with a new
 * `payload`. Used to write a daemon-refreshed OAuth blob back so the
 * isolated CLI stays in sync (same access/refresh token + expiry).
 *
 * `-U` updates the item's secret IN PLACE. We deliberately do NOT pass
 * `-A`: that rewrites the item's ACL, which macOS gate-keeps behind a GUI
 * keychain-password prompt a headless daemon can't answer. Instead we
 * re-run the partition-list grant (password supplied inline via `-k ""`,
 * no prompt) so `security` keeps write access. Returns false off macOS /
 * when no matching item exists.
 */
export const writeIsolatedKeychain = async (
  home: string,
  servicePrefix: string,
  payload: string,
): Promise<boolean> => {
  if (!MAC) return false;
  await ensureIsolatedKeychain(home);
  await grantKeychainToolAccess(home); // authorize tool writes (no prompt)
  const service = (await findKeychainServices(home, servicePrefix))[0];
  if (service === undefined) return false;
  const account = process.env.USER ?? "";
  return runSecurity(
    [
      "add-generic-password",
      "-U",
      "-s",
      service,
      "-a",
      account,
      "-w",
      payload,
      loginKeychainPath(home),
    ],
    home,
  );
};

/** Tolerant epoch parser — accepts ms-int, sec-float, or ISO string. */
export const toEpochMs = (raw: unknown): number | null => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: < 1e12 is seconds, else ms.
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};
