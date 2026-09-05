/**
 * Metadata-keyed determinate observation cache for Claude/Cursor idle status.
 *
 * Reuse is keyed by store identity (path + inode + mtime + size), not a clock.
 * Unknown/indeterminate results are never stored. A producer started before
 * invalidate must not overwrite a newer generation. This is presence metadata
 * only — never unlock-state or vendor-validity proof, and never a substitute
 * for live `credentialForUpstream` / `readToken`.
 */
import { statSync } from "node:fs";

export type TFileStoreIdentity = {
  readonly path: string;
  readonly present: boolean;
  readonly mtimeMs: number | null;
  readonly size: number | null;
  readonly ino: number | null;
};

export const fileStoreIdentity = (path: string): TFileStoreIdentity => {
  try {
    const st = statSync(path);
    return {
      path,
      present: true,
      mtimeMs: st.mtimeMs,
      size: st.size,
      ino: Number(st.ino),
    };
  } catch {
    return {
      path,
      present: false,
      mtimeMs: null,
      size: null,
      ino: null,
    };
  }
};

export const fingerprintStoreIdentity = (id: TFileStoreIdentity): string => {
  if (
    !id.present ||
    id.mtimeMs === null ||
    id.size === null ||
    id.ino === null
  ) {
    return `${id.path}\0absent`;
  }
  return `${id.path}\0${id.ino}\0${id.mtimeMs}\0${id.size}`;
};

export type TPassiveObservationCache<T> = {
  readonly generation: () => number;
  readonly get: (fingerprint: string) => T | undefined;
  readonly set: (
    fingerprint: string,
    value: T,
    observedGeneration: number,
  ) => void;
  readonly invalidate: () => void;
};

export const createPassiveObservationCache = <
  T,
>(): TPassiveObservationCache<T> => {
  let generation = 0;
  let entry: { readonly fingerprint: string; readonly value: T } | null = null;
  return {
    generation: () => generation,
    get: (fingerprint) =>
      entry !== null && entry.fingerprint === fingerprint
        ? entry.value
        : undefined,
    set: (fingerprint, value, observedGeneration) => {
      if (observedGeneration !== generation) return;
      entry = { fingerprint, value };
    },
    invalidate: () => {
      generation += 1;
      entry = null;
    },
  };
};

/** Cache only when the store identity did not change during the probe. */
export const rememberIfFingerprintStable = <T>(
  cache: TPassiveObservationCache<T>,
  startFingerprint: string,
  endFingerprint: string,
  value: T,
  observedGeneration: number,
): void => {
  if (startFingerprint !== endFingerprint) return;
  cache.set(startFingerprint, value, observedGeneration);
};
