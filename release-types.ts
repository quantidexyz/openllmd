/**
 * Shape of the committed daemon-release manifest (`./release.ts`). The data
 * module is rewritten by `scripts/release.ts` after each GitHub release; this
 * type stays hand-written so the manifest is type-checked.
 */

export type TDaemonTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64";

export type TDaemonRelease = {
  /** GitHub `owner/repo` the binaries are released to. */
  readonly repo: string;
  /** Release tag, e.g. `v1.3.0-alpha.0`. Empty string until first publish. */
  readonly tag: string;
  /** Every buildable target — stable, independent of what's published yet. */
  readonly targets: readonly TDaemonTarget[];
  /** sha256 (hex) of each published asset, keyed by target. Empty pre-publish. */
  readonly sha256: Readonly<Record<string, string>>;
};
