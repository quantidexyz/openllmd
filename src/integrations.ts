/**
 * The single executor behind BOTH the daemon CLI (`openllmd skill install …`)
 * and the relay command (`install_integration` from the dashboard). Coreless —
 * fetch + `Bun.spawn`. See `docs/proposals/daemon-integration-triggers.md` §4.
 *
 * It never forks install logic onto the box: it fetches the gateway's unified
 * `/api/<area>/<slug>/install.sh?mode=<mode>` script (which encapsulates the
 * per-target install / uninstall / state logic) and pipes it to `bash`. The
 * user's API key is injected as `OPENLLM_API_KEY` for the `install` mode ONLY —
 * the uninstall/state paths don't need it, so it's never exposed to them.
 *
 * Script integrity (fail-closed). The script is fetched and piped to `bash`
 * with the daemon's key in its environment — so a corrupted/tampered script
 * would be arbitrary code execution with the key exposed. Before ANY
 * execution we fetch the gateway's separately-served SHA-256
 * (`/api/daemon/integrity`) and compare. On any mismatch — or if no digest is
 * available — we abort and log (fail closed), and the key is placed into the
 * executed environment ONLY after verification passes. Mirrors the daemon
 * binary's checksum gate in `packages/setup/daemon/install.sh`.
 */
import { createHash } from "node:crypto";
import type { TDaemonIntegrationKind } from "@quantidexyz/openllmp";
import { daemonEnv } from "./env";
import { logDebug, logError, logInfo } from "./logger";
import { DEFAULT_BIN_DIRS } from "./path-utils";

/** Aliased to the closed `DaemonIntegrationKind` control-schema enum so the
 *  executor's vocabulary can't drift from the wire's. */
export type TIntegrationKind = TDaemonIntegrationKind;
/** The unified install endpoint's mode. `state` (`-s`) reports install state as
 *  one JSON line on stdout (the device-state walk parses it); `install` /
 *  `uninstall` run the bundle's `install.sh` with no flag / `-u`. */
export type TIntegrationMode = "install" | "uninstall" | "state";

const AREA: Record<TIntegrationKind, string> = {
  skill: "skills",
  plugin: "plugins",
  setup: "setup", // singular route, keyed by id
};

export type TIntegrationResult = {
  readonly ok: boolean;
  readonly code: number;
  /** Tail of combined stdout+stderr, for the relay ack / CLI stdout. */
  readonly output: string;
};

// Cap every gateway fetch so a hung/slow origin can't stall the install
// command (the relay processes commands serially). On timeout `fetch` throws
// an AbortError, which both call sites already handle → fail-closed.
const FETCH_TIMEOUT_MS = 15_000;

// Bound the spawned `install.sh` so a hung script (a wedged install, a `-s`
// probe that blocks on a missing tool) can't stall `refreshDeviceState()` or a
// post-command re-probe indefinitely. On expiry Bun kills the process and sets
// `signalCode`, which the kill branch below already reports.
const SCRIPT_TIMEOUT_MS = 120_000;

const sha256Hex = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

const fail = (output: string): TIntegrationResult => {
  logError("integrations", output);
  return { ok: false, code: 1, output };
};

/** Fetch the gateway's SHA-256 for this exact script, or null if unavailable. */
const fetchExpectedDigest = async (
  cloudOrigin: string,
  area: string,
  slug: string,
  mode: TIntegrationMode,
  target: string,
): Promise<string | null> => {
  const url =
    `${cloudOrigin}/api/daemon/integrity?area=${encodeURIComponent(area)}` +
    `&slug=${encodeURIComponent(slug)}&mode=${mode}` +
    `&target=${encodeURIComponent(target)}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sha256?: unknown };
    return typeof body.sha256 === "string" ? body.sha256 : null;
  } catch {
    return null;
  }
};

export const runIntegration = async (
  kind: TIntegrationKind,
  mode: TIntegrationMode,
  slug: string,
  target = "claude-code",
): Promise<TIntegrationResult> => {
  const { cloudOrigin, apiKey } = daemonEnv();
  const area = AREA[kind];
  const scriptUrl =
    `${cloudOrigin}/api/${area}/${encodeURIComponent(slug)}` +
    `/install.sh?target=${encodeURIComponent(target)}&mode=${mode}`;

  // 1. Fetch the script (PUBLIC endpoint — no auth header needed).
  let res: Response;
  try {
    res = await fetch(scriptUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(
      `fetch ${scriptUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const output = `fetch ${scriptUrl} → ${res.status}`;
    logError("integrations", output);
    return { ok: false, code: res.status, output };
  }
  const script = await res.text();

  // 2. Verify integrity BEFORE the key touches the environment (fail-closed).
  const expected = await fetchExpectedDigest(
    cloudOrigin,
    area,
    slug,
    mode,
    target,
  );
  if (expected === null) {
    return fail(
      `integrity: no digest for ${area}/${slug}/${mode} — refusing to run`,
    );
  }
  const actual = sha256Hex(script);
  if (expected !== actual) {
    return fail(
      `integrity mismatch for ${area}/${slug}/${mode}: expected ${expected} got ${actual} — refusing to run`,
    );
  }

  // 3. Only now build the env with the key and execute. Strip any inherited
  // OPENLLM_API_KEY first so an unverified value can never leak in.
  const { OPENLLM_API_KEY: _omit, ...baseEnv } = process.env;
  // The daemon runs as a background service with a minimal inherited PATH, so
  // user-installed CLIs the scripts need (`claude` lands in ~/.local/bin; `bun`
  // lands in ~/.bun/bin; many tools live under Homebrew) aren't found and a
  // script that relies on one half-applies or acks `status:error`. Prepend the
  // standard user bin dirs ONCE, here, so EVERY integration (install +
  // uninstall, all areas) resolves them. All are within the OS-sandbox working
  // set (`/opt`, `/usr`, ~/.local/bin, ~/.bun — see sandbox/working-set.ts), so
  // no spawn hits a Landlock denial; absent dirs are simply ignored by the shell.
  const pathValue = [...DEFAULT_BIN_DIRS, baseEnv.PATH ?? ""]
    .filter((p) => p.length > 0)
    .join(":");
  // The key is exposed to the `install` script only — uninstall/state don't
  // need it, so they run with it stripped from the env entirely.
  const env =
    mode === "install"
      ? { ...baseEnv, PATH: pathValue, OPENLLM_API_KEY: apiKey ?? "" }
      : { ...baseEnv, PATH: pathValue };
  const proc = Bun.spawn(["bash", "-s"], {
    stdin: new TextEncoder().encode(script),
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: SCRIPT_TIMEOUT_MS,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = `${out}${err}`.trim();
  // The captured output is piped into `bash` with `OPENLLM_API_KEY` in its env,
  // so a script that echoes its env (or a tool that prints the key on error)
  // could leak it into a tail we PERSIST to openllmd.err.log. Redact the key
  // before any tail is logged. (The returned `output` for the relay ack is the
  // raw value — it goes to the dashboard over the authed socket, not to disk.)
  const redactTail = (s: string): string =>
    apiKey ? s.split(apiKey).join("[REDACTED_OPENLLM_API_KEY]") : s;
  // A script SIGKILLed by the sandbox produces no useful output + a confusing
  // exit code — name the actual culprit at error level so it lands in
  // openllmd.err.log instead of vanishing.
  if (proc.signalCode !== null) {
    logError("integrations", `${mode} ${kind} ${slug}: script killed`, {
      signal: proc.signalCode,
      hint: `likely an OS sandbox denial (a path the script writes isn't in the daemon working set) or the ${SCRIPT_TIMEOUT_MS}ms script timeout`,
      // The captured tail — even on a kill there may be partial output that
      // names the offending path.
      output: redactTail(output.slice(-2000)),
    });
  } else if (code !== 0) {
    // A non-zero exit is a script-level failure (a write that EACCES'd, a
    // missing tool, the script's own error path). Log its captured stdout+stderr
    // at ERROR level — otherwise the only data point is a bare exit code and the
    // failure is undiagnosable from the box (the relay ack carries `output`, but
    // it isn't persisted anywhere). This is how an install/uninstall that exits
    // 1 surfaces its real reason in openllmd.err.log.
    logError("integrations", `${mode} ${kind} ${slug} failed`, {
      code,
      output: redactTail(output.slice(-2000)),
    });
  } else if (mode === "state") {
    // The device-state walk runs one probe per registry item (10+) on connect —
    // log success at DEBUG so it doesn't flood the daemon log.
    logDebug("integrations", `${mode} ${kind} ${slug}`, { ok: true, code });
  } else {
    logInfo("integrations", `${mode} ${kind} ${slug}`, { ok: true, code });
  }
  return {
    ok: code === 0 && proc.signalCode === null,
    code,
    output: output.slice(-4000),
  };
};
