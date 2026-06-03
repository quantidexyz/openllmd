/**
 * On-box setup-token source for subscription delegates (Claude Code today).
 *
 * A `claude setup-token` (`sk-ant-oat01-…`) is a long-lived Pro/Max
 * SUBSCRIPTION credential the user mints in THEIR OWN browser
 * (`claude setup-token`) and delivers to this box. It is read here and used
 * verbatim as the upstream Bearer by the delegate's `credentialForUpstream`
 * — no refresh (it's long-lived; re-set on expiry).
 *
 * Delivery is ON THE BOX, never through the cloud (which must not see the
 * secret) and never via a browser→localhost write (that control surface was
 * removed in the cloud-relay cutover). See
 * `docs/proposals/daemon-auth-loopback-forwarding.md` §7.4 (option b). Two
 * sources, file wins:
 *   1. `<stateDir>/setup-token/<provider>` — set by `openllmd set-token …`
 *      or the installer, `0600`.
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` env — Anthropic's own convention (the
 *      installer's env file or an `export` can carry it).
 *
 * The `sk-ant-oat01-` prefix is validated defensively: a Console key
 * (`sk-ant-api03-`) or junk dropped here is IGNORED, never used as a
 * subscription bearer. Never sent off-box.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

const OAT_PREFIX = "sk-ant-oat01-";
// The full token shape: prefix + base64url body. Used to EXTRACT a clean token
// from a stored value, so trailing terminal junk that slipped past capture
// (newlines, a fused log line, etc.) can never reach the upstream as a corrupt
// Bearer — we send only the matched token, never the raw file/env contents.
const OAT_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;

const extractOat = (raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined) return null;
  return raw.match(OAT_RE)?.[0] ?? null;
};

const setupTokenDir = (): string => join(stateDir(), "setup-token");
const tokenFile = (provider: string): string => join(setupTokenDir(), provider);

/** The env var a provider's setup-token may also arrive in (claude only). */
const envVarFor = (provider: string): string | null =>
  provider === "claude_code" ? "CLAUDE_CODE_OAUTH_TOKEN" : null;

/**
 * The on-box setup-token for `provider`, or null. File wins over env. Only a
 * value with the `sk-ant-oat01-` subscription prefix is accepted.
 */
export const loadSetupToken = (provider: string): string | null => {
  try {
    const fromFile = extractOat(readFileSync(tokenFile(provider), "utf-8"));
    if (fromFile !== null) return fromFile;
  } catch {
    // no file — fall through to env
  }
  const envVar = envVarFor(provider);
  return envVar !== null ? extractOat(process.env[envVar]) : null;
};

export const hasSetupToken = (provider: string): boolean =>
  loadSetupToken(provider) !== null;

/**
 * Persist a setup-token for `provider` (the `openllmd set-token` path),
 * `0600` under the state dir. Pass null/empty to clear it. Returns false
 * when a non-empty value doesn't look like a setup-token (wrong prefix), so
 * a fat-fingered Console key isn't silently stored as a subscription bearer.
 */
export const setSetupToken = (
  provider: string,
  token: string | null,
): boolean => {
  const trimmed = token?.trim() ?? "";
  if (trimmed.length > 0 && !trimmed.startsWith(OAT_PREFIX)) return false;
  try {
    mkdirSync(setupTokenDir(), { recursive: true });
  } catch {
    // best-effort — the write below surfaces a real failure
  }
  writeFileSync(tokenFile(provider), trimmed, { mode: 0o600 });
  return true;
};
