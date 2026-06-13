/**
 * The single executor behind BOTH the daemon CLI (`openllmd skill install …`)
 * and the relay command (`install_integration` from the dashboard). Coreless —
 * fetch + `Bun.spawn`. See `docs/proposals/daemon-integration-triggers.md` §4.
 *
 * It never forks install logic onto the box: it fetches the gateway's EXISTING
 * `/api/<area>/<slug>/<action>.sh` script (which already encapsulates the
 * per-target install/uninstall logic) and pipes it to `bash`. The user's API
 * key is passed as `OPENLLM_API_KEY` so an install.sh that pipes it through
 * works; uninstall.sh ignores it.
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
import { logError, logInfo } from "./logger";
import { DEFAULT_BIN_DIRS } from "./path-utils";

/** Aliased to the closed `DaemonIntegrationKind` control-schema enum so the
 *  executor's vocabulary can't drift from the wire's. */
export type TIntegrationKind = TDaemonIntegrationKind;
export type TIntegrationAction = "install" | "uninstall";

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
  action: TIntegrationAction,
  target: string,
): Promise<string | null> => {
  const url =
    `${cloudOrigin}/api/daemon/integrity?area=${encodeURIComponent(area)}` +
    `&slug=${encodeURIComponent(slug)}&action=${action}` +
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
  action: TIntegrationAction,
  slug: string,
  target = "claude-code",
): Promise<TIntegrationResult> => {
  const { cloudOrigin, apiKey } = daemonEnv();
  const area = AREA[kind];
  const scriptUrl =
    `${cloudOrigin}/api/${area}/${encodeURIComponent(slug)}` +
    `/${action}.sh?target=${encodeURIComponent(target)}`;

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
    action,
    target,
  );
  if (expected === null) {
    return fail(
      `integrity: no digest for ${area}/${slug}/${action} — refusing to run`,
    );
  }
  const actual = sha256Hex(script);
  if (expected !== actual) {
    return fail(
      `integrity mismatch for ${area}/${slug}/${action}: expected ${expected} got ${actual} — refusing to run`,
    );
  }

  // 3. Only now build the env with the key and execute. Strip any inherited
  // OPENLLM_API_KEY first so an unverified value can never leak in.
  const { OPENLLM_API_KEY: _omit, ...baseEnv } = process.env;
  // The daemon runs as a background service with a minimal inherited PATH, so
  // user-installed CLIs the scripts need (`claude` lands in ~/.local/bin; many
  // tools live under Homebrew) aren't found and a script that relies on one
  // half-applies or acks `status:error`. Prepend the standard user bin dirs
  // ONCE, here, so EVERY integration (install + uninstall, all areas) resolves
  // them. All three are within the OS-sandbox working set (`/opt`, `/usr`,
  // ~/.local/bin — see sandbox/working-set.ts), so no spawn hits a Landlock
  // denial; absent dirs are simply ignored by the shell.
  const pathValue = [...DEFAULT_BIN_DIRS, baseEnv.PATH ?? ""]
    .filter((p) => p.length > 0)
    .join(":");
  const env = { ...baseEnv, PATH: pathValue, OPENLLM_API_KEY: apiKey ?? "" };
  const proc = Bun.spawn(["bash", "-s"], {
    stdin: new TextEncoder().encode(script),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = `${out}${err}`.trim();
  // A script SIGKILLed by the sandbox produces no useful output + a confusing
  // exit code — name the actual culprit at error level so it lands in
  // openllmd.err.log instead of vanishing.
  if (proc.signalCode !== null) {
    logError("integrations", `${action} ${kind} ${slug}: script killed`, {
      signal: proc.signalCode,
      hint: "likely an OS sandbox denial — a path the script writes isn't in the daemon working set",
    });
  } else {
    logInfo("integrations", `${action} ${kind} ${slug}`, {
      ok: code === 0,
      code,
    });
  }
  return {
    ok: code === 0 && proc.signalCode === null,
    code,
    output: output.slice(-4000),
  };
};
