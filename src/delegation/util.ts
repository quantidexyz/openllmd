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
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";

/** Merge an env map onto the parent env for a spawned isolated CLI. */
const spawnEnv = (
  env: Record<string, string> | undefined,
): Record<string, string | undefined> | undefined =>
  env === undefined ? undefined : { ...process.env, ...env };

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
    if ((await proc.exited) !== 0) return null;
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
};

/**
 * Spawn a vendor CLI's login command and WAIT for it to finish.
 *
 * The CLI opens the user's browser itself; the user signs in and the CLI
 * completes via its own localhost callback ("you can close this page"),
 * then exits — at which point the credential is in the CLI's OWN store.
 * We block on that so the caller can re-read the store and report
 * connected/failed directly. stdin is ignored (browser-driven flow; the
 * headless daemon has no usable stdin) and stdout/stderr are captured for
 * surfacing a failure reason. We never capture the credential.
 */
export const spawnLogin = async (
  argv: ReadonlyArray<string>,
  env?: Record<string, string>,
): Promise<TLoginResult> => {
  const proc = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(spawnEnv(env) !== undefined ? { env: spawnEnv(env) } : {}),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}`.trim() };
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
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
};

// Keychains we've already created+unlocked this process. Auto-lock is
// disabled, so a keychain stays unlocked for the daemon's lifetime — no
// need to re-spawn `security` on every status poll (which runs ~every 5s).
const ensuredKeychains = new Set<string>();

/**
 * macOS only: ensure an isolated, unlocked login keychain exists at
 * `<home>/Library/Keychains/login.keychain-db` so a CLI run with
 * `HOME=<home>` (e.g. `claude auth login`) can WRITE its credential
 * without the "Keychain Not Found" dialog. Empty password; auto-lock
 * disabled so subsequent reads don't prompt. Idempotent + process-cached;
 * no-op off macOS.
 */
export const ensureIsolatedKeychain = async (home: string): Promise<void> => {
  if (!MAC) return;
  const kc = loginKeychainPath(home);
  // The cache skips re-spawning `security` on the hot path (the ~5s
  // status watcher), but ALWAYS re-verify the file still exists first —
  // `existsSync` is cheap (no spawn) and a missing keychain (deleted out
  // from under us, or a fresh install) must be recreated, or
  // `claude auth login` later pops the "Keychain Not Found" dialog.
  if (ensuredKeychains.has(kc) && existsSync(kc)) return;
  if (!existsSync(kc)) {
    ensuredKeychains.delete(kc); // stale cache entry — file is gone
    await mkdir(dirname(kc), { recursive: true });
    await runSecurity(["create-keychain", "-p", "", kc], home);
  }
  await runSecurity(["set-keychain-settings", kc], home); // no auto-lock
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
