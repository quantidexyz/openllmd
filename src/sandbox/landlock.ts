/**
 * The cross-platform OS-sandbox entry (`applyDaemonSandbox`) + the Linux
 * Landlock backend — `docs/proposals/daemon-os-sandbox-and-typed-control.md`
 * §3.3a. `applyDaemonSandbox` dispatches by platform: **Linux → Landlock**
 * (here), **macOS → Seatbelt** (`./seatbelt.ts`), other → unsupported. Both
 * backends are in-process, unprivileged, applied once at boot before the
 * listener binds, derived from the same working set (`./working-set.ts`), and
 * inherited across `execve` — so every spawned child (`bash` running a
 * SHA-gated integration script, `curl`, the vendor CLIs) is confined too, and
 * everything outside the working set (`~/.ssh`, `~/.aws`, the user's real
 * `~/.codex`, browser profiles) is unreachable even if the daemon is fully
 * compromised.
 *
 * Landlock (this file): a ruleset granting only the working-set paths, on
 * kernels ≥ 5.13. It can't restrict the network on the kernels we target —
 * the systemd user unit's `RestrictAddressFamilies` (`service.ts`) covers that
 * side; the two layers overlap deliberately (Landlock also confines a manual
 * foreground run with no systemd).
 *
 * Failure posture is FAIL-OPEN with a loud log: the daemon must keep serving
 * on a kernel/libc this shim can't drive (the state is surfaced on
 * `DaemonStatus.sandbox` so an unconfined daemon is visible, not silent).
 * Kill switch: `OPENLLM_DAEMON_NO_SANDBOX=1`. Dev source runs are OPT-IN via
 * `OPENLLM_DAEMON_SANDBOX=1` (§3.5) so the sandbox never impedes iteration.
 *
 * Landlock rules only ever NARROW and cannot be loosened in-process — a
 * future §3.4 consent grant takes effect via the self-updater's existing
 * drain-and-exit + supervisor relaunch, never by widening a live ruleset.
 */
import { logInfo, logWarn } from "../logger";
import { DAEMON_VERSION } from "../version";
import { daemonWorkingSet } from "./working-set";

/** The sandbox posture this process ended up with, for `DaemonStatus`. */
export type TSandboxState = "enforced" | "off" | "unsupported" | "error";

// ─── Landlock ABI (uapi/linux/landlock.h) ────────────────────────────
// Syscall numbers are uniform across architectures (allocated post-table-
// unification): 444/445/446.
const SYS_LANDLOCK_CREATE_RULESET = 444;
const SYS_LANDLOCK_ADD_RULE = 445;
const SYS_LANDLOCK_RESTRICT_SELF = 446;
const LANDLOCK_CREATE_RULESET_VERSION = 1; // flags probe: returns the ABI
const LANDLOCK_RULE_PATH_BENEATH = 1;

// Filesystem access rights. v1 = bits 0..12; REFER (v2) must be handled +
// granted on read-write paths or EVERY cross-directory rename/link is denied
// (the v1 quirk REFER exists to fix); TRUNCATE (v3) likewise for truncation.
const ACCESS_FS_EXECUTE = 1n << 0n;
const ACCESS_FS_READ_FILE = 1n << 2n;
const ACCESS_FS_READ_DIR = 1n << 3n;
const ACCESS_FS_V1_ALL = 0x1fffn;
const ACCESS_FS_REFER = 1n << 13n; // ABI v2
const ACCESS_FS_TRUNCATE = 1n << 14n; // ABI v3

// asm-generic open(2) flags (identical on x86_64 + aarch64).
const O_PATH = 0o10000000;
const O_CLOEXEC = 0o2000000;

const PR_SET_NO_NEW_PRIVS = 38;

type TLibc = {
  readonly syscall3: (n: number, a: bigint, b: bigint, c: bigint) => bigint;
  readonly syscall4: (
    n: number,
    a: bigint,
    b: bigint,
    c: bigint,
    d: bigint,
  ) => bigint;
  readonly open: (path: Uint8Array, flags: number) => number;
  readonly close: (fd: number) => number;
  readonly prctl: (
    op: number,
    a: bigint,
    b: bigint,
    c: bigint,
    d: bigint,
  ) => number;
};

/**
 * Bind the libc entry points through `bun:ffi`. `syscall(2)` is variadic;
 * declaring it with fixed integer signatures is sound on the Linux x86_64
 * SysV and aarch64 AAPCS ABIs (integer varargs ride the same registers as
 * named args). Imported lazily so non-Linux platforms never load `bun:ffi`.
 */
const bindLibc = async (): Promise<TLibc | null> => {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  for (const lib of ["libc.so.6", "libc.so"]) {
    try {
      const { symbols } = dlopen(lib, {
        syscall: {
          args: [
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
          ],
          returns: FFIType.i64,
        },
        open: {
          args: [FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        prctl: {
          args: [
            FFIType.i32,
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
            FFIType.i64,
          ],
          returns: FFIType.i32,
        },
      });
      // Bun maps `FFIType.i64` to a `bigint` in BOTH directions, so `sys`
      // takes + returns bigints. The wrappers convert the `number` syscall
      // NUMBER `n` to bigint once and return the raw bigint result unwrapped.
      const sys = symbols.syscall as unknown as (
        n: bigint,
        a: bigint,
        b: bigint,
        c: bigint,
        d: bigint,
      ) => bigint;
      return {
        syscall3: (n, a, b, c) => sys(BigInt(n), a, b, c, 0n),
        syscall4: (n, a, b, c, d) => sys(BigInt(n), a, b, c, d),
        open: (path, flags) =>
          Number(
            (symbols.open as unknown as (p: number, f: number) => number)(
              ptr(path),
              flags,
            ),
          ),
        close: (fd) =>
          Number((symbols.close as unknown as (f: number) => number)(fd)),
        prctl: (op, a, b, c, d) =>
          Number(
            (
              symbols.prctl as unknown as (
                o: number,
                a: bigint,
                b: bigint,
                c: bigint,
                d: bigint,
              ) => number
            )(op, a, b, c, d),
          ),
      };
    } catch {
      // try the next libc name (glibc vs musl)
    }
  }
  return null;
};

const cstr = (s: string): Uint8Array => {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
};

/** struct landlock_ruleset_attr — only `handled_access_fs` (size 8 = ABI-v1
 *  layout; newer kernels accept smaller, older sizes by design). */
const rulesetAttr = (handled: bigint): Uint8Array => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, handled, true);
  return buf;
};

/** struct landlock_path_beneath_attr — { u64 allowed_access; s32 parent_fd; }
 *  packed (12 bytes). */
const pathBeneathAttr = (allowed: bigint, fd: number): Uint8Array => {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, allowed, true);
  view.setInt32(8, fd, true);
  return buf;
};

let appliedState: TSandboxState = "off";

/** The posture {@link applyDaemonSandbox} ended up with (for `status.ts`). */
export const sandboxState = (): TSandboxState => appliedState;

/**
 * Apply the Landlock working-set ruleset to THIS process (and, by
 * inheritance, every child it ever spawns). Call once at boot, before the
 * listener binds. Never throws; returns + records the resulting posture.
 */
export const applyDaemonSandbox = async (): Promise<TSandboxState> => {
  appliedState = await applyInner();
  return appliedState;
};

const applyInner = async (): Promise<TSandboxState> => {
  if (process.env.OPENLLM_DAEMON_NO_SANDBOX === "1") {
    logWarn("sandbox", "OPENLLM_DAEMON_NO_SANDBOX=1 — running unconfined");
    return "off";
  }
  // Source runs opt in (§3.5); the compiled service path always applies it.
  if (
    DAEMON_VERSION === "0.0.0-dev" &&
    process.env.OPENLLM_DAEMON_SANDBOX !== "1"
  ) {
    return "off";
  }
  if (process.platform === "darwin") {
    // macOS gets the in-process Seatbelt sandbox — the deny-by-default
    // counterpart to Landlock, applied via `sandbox_init` (no signing needed).
    // The App Sandbox (proposal §3.2 / Phase C) remains the future upgrade.
    const { applySeatbelt } = await import("./seatbelt");
    return applySeatbelt();
  }
  if (process.platform !== "linux") {
    return "unsupported";
  }
  try {
    const libc = await bindLibc();
    if (libc === null) {
      logWarn("sandbox", "could not bind libc — running unconfined");
      return "error";
    }

    // Probe the kernel's Landlock ABI (≤ 0 = unsupported / disabled).
    const abi = Number(
      libc.syscall3(
        SYS_LANDLOCK_CREATE_RULESET,
        0n,
        0n,
        BigInt(LANDLOCK_CREATE_RULESET_VERSION),
      ),
    );
    if (abi <= 0) {
      logInfo(
        "sandbox",
        "landlock unavailable on this kernel — relying on systemd hardening",
      );
      return "unsupported";
    }

    let handled = ACCESS_FS_V1_ALL;
    if (abi >= 2) handled |= ACCESS_FS_REFER;
    if (abi >= 3) handled |= ACCESS_FS_TRUNCATE;

    const attr = rulesetAttr(handled);
    const { ptr } = await import("bun:ffi");
    const rulesetFd = Number(
      libc.syscall3(
        SYS_LANDLOCK_CREATE_RULESET,
        BigInt(ptr(attr)),
        BigInt(attr.length),
        0n,
      ),
    );
    if (rulesetFd < 0) {
      logWarn("sandbox", `landlock_create_ruleset failed (${rulesetFd})`);
      return "error";
    }

    const readOnlyAccess =
      ACCESS_FS_EXECUTE | ACCESS_FS_READ_FILE | ACCESS_FS_READ_DIR;
    const ws = daemonWorkingSet();
    const addRules = (paths: readonly string[], allowed: bigint): void => {
      for (const path of paths) {
        const fd = libc.open(cstr(path), O_PATH | O_CLOEXEC);
        if (fd < 0) continue; // raced away since the existence filter — skip
        try {
          const rule = pathBeneathAttr(allowed & handled, fd);
          const rc = Number(
            libc.syscall4(
              SYS_LANDLOCK_ADD_RULE,
              BigInt(rulesetFd),
              BigInt(LANDLOCK_RULE_PATH_BENEATH),
              BigInt(ptr(rule)),
              0n,
            ),
          );
          if (rc !== 0) logWarn("sandbox", `landlock rule failed for ${path}`);
        } finally {
          libc.close(fd);
        }
      }
    };
    addRules(ws.readWrite, handled);
    addRules(ws.readOnly, readOnlyAccess);

    // restrict_self requires no_new_privs (we're an unprivileged process).
    if (libc.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) {
      libc.close(rulesetFd);
      logWarn("sandbox", "prctl(NO_NEW_PRIVS) failed — running unconfined");
      return "error";
    }
    const rc = Number(
      libc.syscall3(SYS_LANDLOCK_RESTRICT_SELF, BigInt(rulesetFd), 0n, 0n),
    );
    libc.close(rulesetFd);
    if (rc !== 0) {
      logWarn("sandbox", `landlock_restrict_self failed (${rc})`);
      return "error";
    }
    logInfo("sandbox", "landlock enforced", {
      abi,
      readWrite: ws.readWrite.length,
      readOnly: ws.readOnly.length,
    });
    return "enforced";
  } catch (err) {
    logWarn(
      "sandbox",
      `landlock setup threw (${err instanceof Error ? err.message : String(err)}) — running unconfined`,
    );
    return "error";
  }
};
