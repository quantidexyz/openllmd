/**
 * macOS in-process Seatbelt sandbox — the darwin counterpart to Linux Landlock
 * (`sandbox/landlock.ts`). Applied once at boot via `sandbox_init` (libsandbox)
 * through `bun:ffi`, BEFORE the listener binds: a deny-by-default SBPL profile
 * grants filesystem access ONLY to the daemon's working set (`working-set.ts`)
 * plus the system trees the runtime needs, and is inherited by every spawned
 * child — the same confinement model `sandbox-exec` uses. Everything else
 * (`~/.ssh`, `~/.aws`, the user's real `~/.codex`, other `~/Library` data) is
 * unreadable even if the daemon process is fully compromised.
 *
 * Why Seatbelt and not the App Sandbox: the App Sandbox (proposal §3.2) is the
 * "fully supported" path but requires Developer ID signing + notarization + a
 * container migration. Seatbelt's `sandbox_init` is deprecated-but-functional
 * (it's what `sandbox-exec` wraps) and works UNPRIVILEGED, in-process, with no
 * signing — exactly parallel to Landlock. The App Sandbox stays the future
 * Phase-C upgrade; this delivers real confinement now, on parity with Linux.
 *
 * Fail-open with a loud log (parity with Landlock): a macOS where the profile
 * is rejected must not stop the daemon serving — the posture rides
 * `DaemonStatus.sandbox` so an unconfined daemon is visible, not silent.
 */

import type { Pointer } from "bun:ffi";
import { CString, dlopen, FFIType, ptr } from "bun:ffi";
import { homedir } from "node:os";
import { join } from "node:path";
import { logInfo, logWarn } from "../logger";
import type { TSandboxState } from "./landlock";
import { daemonWorkingSet } from "./working-set";

/** Escape a path for embedding in an SBPL `(subpath "...")` / `(literal "...")`. */
const esc = (p: string): string =>
  p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** macOS runtime paths the process tree must WRITE (beyond the daemon working
 *  set): device nodes, the per-user temp/cache (LaunchServices + Bun mmap),
 *  and the user-Library bits the vendor-CLI / browser-open flows write —
 *  `Caches` (npm/node + CLI caches) and `Preferences` (CLI prefs / Launch
 *  Services). The read side is open (see {@link buildProfile}); these are the
 *  WRITE allow-list additions. */
const macRuntimeWrite = (home: string): string[] => [
  "/dev",
  "/private/tmp",
  "/tmp",
  "/private/var/folders",
  join(home, "Library", "Caches"),
  join(home, "Library", "Preferences"),
];

/**
 * The user's credential stores a compromised daemon (or a poisoned integration
 * script) must never READ. The daemon's OWN isolated vendor creds live under
 * `~/.openllm` (never denied); these are the user's REAL secrets, which no
 * workflow needs to read. Also covers the vendor credential FILES inside the
 * write-target config dirs (`~/.codex/auth.json`, `~/.claude/.credentials.json`)
 * — the daemon writes config there but never needs the user's tokens.
 */
const readDenyList = (home: string): string[] => [
  `(subpath "${esc(home)}/.ssh")`,
  `(subpath "${esc(home)}/.aws")`,
  `(subpath "${esc(home)}/.gnupg")`,
  `(subpath "${esc(home)}/.config/gcloud")`,
  `(subpath "${esc(home)}/.config/gh")`,
  `(subpath "${esc(home)}/.kube")`,
  `(subpath "${esc(home)}/.docker")`,
  `(literal "${esc(home)}/.netrc")`,
  `(literal "${esc(home)}/.npmrc")`,
  `(literal "${esc(home)}/.pypirc")`,
  // Vendor credential files inside the write-target config dirs.
  `(literal "${esc(home)}/.codex/auth.json")`,
  `(literal "${esc(home)}/.claude/.credentials.json")`,
  // The user's REAL login keychain (the daemon's isolated one is under
  // ~/.openllm and unaffected).
  `(subpath "${esc(home)}/Library/Keychains")`,
  // Browser cookies / profiles (session tokens).
  `(subpath "${esc(home)}/Library/Cookies")`,
  `(subpath "${esc(home)}/Library/HTTPStorages")`,
  `(subpath "${esc(home)}/Library/Application Support/Google/Chrome")`,
  `(subpath "${esc(home)}/Library/Application Support/BraveSoftware")`,
  `(subpath "${esc(home)}/Library/Application Support/Firefox")`,
  `(subpath "${esc(home)}/Library/Safari")`,
  `(subpath "${esc(home)}/Library/Containers/com.apple.Safari")`,
];

/**
 * Build the SBPL profile. Two asymmetric halves, because macOS forces it:
 *
 *   WRITES — **deny-by-default whitelist.** Only the daemon working set + the
 *   workflow targets (`working-set.ts`, incl. ~/.claude, ~/.codex, ~/.kimi-code,
 *   ~/.local/bin) + the macOS runtime ({@link macRuntimeWrite}) are writable.
 *   Everything else (the rest of `$HOME`, the system) is write-denied — strong
 *   tamper protection, and the model the request asked for.
 *
 *   READS — **allow-default with a credential deny-list** ({@link readDenyList}).
 *   A read-WHITELIST is not viable: a spawned child's dynamic loader needs broad
 *   read access at `exec` (the dyld shared cache + dylibs), which `sandbox-exec`
 *   grants implicitly but a raw `sandbox_init` profile does not — a read-
 *   whitelist SIGABRTs EVERY child (`echo`, `open`, the vendor CLIs). So reads
 *   are open except the user's credential stores, which blocks the concrete
 *   exfiltration threat without breaking the login flows.
 *
 * `(allow default)` keeps non-file ops (mach/IPC/process/network) allowed so
 * the OAuth browser launch + keychain access run. `(with kill)` is NOT used —
 * a denial is a graceful `EPERM`. (Full read-whitelist parity is the App
 * Sandbox, proposal Phase C, where the container grants the dyld essentials.)
 */
const buildProfile = (home: string): string => {
  const ws = daemonWorkingSet();
  const writeAllow = [...ws.readWrite, ...macRuntimeWrite(home)]
    .map((p) => `  (subpath "${esc(p)}")`)
    .join("\n");
  const readDeny = readDenyList(home)
    .map((rule) => `  ${rule}`)
    .join("\n");
  return `(version 1)
(allow default)
; WRITES — deny-by-default whitelist: only the working set + workflow targets +
; macOS runtime are writable; everything else is write-denied (tamper guard).
(deny file-write*)
(allow file-write*
${writeAllow})
; READS — allow by default (the dynamic loader needs broad read at exec, so a
; read-whitelist SIGABRTs every child), but DENY the user's credential stores so
; secrets can't be exfiltrated. See buildProfile() for the full rationale.
(deny file-read*
${readDeny})
`;
};

let cachedState: TSandboxState | null = null;

/**
 * Apply the Seatbelt profile to THIS process (and, by inheritance, every child
 * it spawns). Idempotent. Never throws; returns + caches the resulting posture.
 */
export const applySeatbelt = (): TSandboxState => {
  if (cachedState !== null) return cachedState;
  try {
    const profile = `${buildProfile(homedir())}\0`;
    const profileBuf = new TextEncoder().encode(profile);
    const lib = dlopen("/usr/lib/libsandbox.1.dylib", {
      sandbox_init: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      sandbox_free_error: { args: [FFIType.ptr], returns: FFIType.void },
    });
    // `int sandbox_init(const char *profile, uint64_t flags, char **errorbuf)`
    // — flags 0 = the profile arg is an SBPL string (not a named profile).
    const errBuf = new BigUint64Array(1);
    const rc = Number(
      lib.symbols.sandbox_init(ptr(profileBuf), 0n, ptr(errBuf)),
    );
    if (rc !== 0) {
      let msg = "unknown";
      const e = errBuf[0];
      if (e !== 0n) {
        const errPtr = Number(e) as unknown as Pointer;
        try {
          msg = new CString(errPtr).toString();
        } catch {
          // best-effort error text
        }
        lib.symbols.sandbox_free_error(errPtr);
      }
      logWarn(
        "sandbox",
        `seatbelt sandbox_init failed (${rc}): ${msg} — running unconfined`,
      );
      cachedState = "error";
      return cachedState;
    }
    logInfo("sandbox", "seatbelt enforced", {
      allowWrite: daemonWorkingSet().readWrite.length,
    });
    cachedState = "enforced";
    return cachedState;
  } catch (err) {
    logWarn(
      "sandbox",
      `seatbelt setup threw (${err instanceof Error ? err.message : String(err)}) — running unconfined`,
    );
    cachedState = "error";
    return cachedState;
  }
};
