import { DAEMON_BINARIES } from "./generated";

/**
 * Daemon binary access — the runtime read side of the precompute-and-inline
 * pattern (mirrors `packages/{plugin,skill,setup}/scanner.ts`). The binaries
 * are compiled by `scripts/compile.ts` and base64-inlined into
 * `generated.ts` by the repo's `scripts/generate-bundles.ts`, so the cloud's
 * `/api/daemon/binary/:target` handler serves them without ever touching
 * `packages/daemon/dist` at runtime (which wouldn't ship with the function).
 */

export const DAEMON_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
] as const;

export type TDaemonTarget = (typeof DAEMON_TARGETS)[number];

/** Decode the inlined binary for one target, or null if it hasn't been built. */
export const getDaemonBinary = (target: string): Buffer | null => {
  const b64 = DAEMON_BINARIES[target];
  if (b64 === undefined) return null;
  return Buffer.from(b64, "base64");
};
