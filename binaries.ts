/**
 * Daemon binary targets. The bytes themselves are NOT here — each target is
 * base64-inlined into its own `generated/<target>.ts` module (produced by the
 * repo's `scripts/generate-bundles.ts` from `scripts/compile.ts` output) and
 * served by its own static route, so a Vercel function never carries more than
 * the single binary it serves (the four together exceed the 250MB function
 * limit). The checksum route reads `generated/sha256.ts`.
 */

export const DAEMON_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
] as const;

export type TDaemonTarget = (typeof DAEMON_TARGETS)[number];
