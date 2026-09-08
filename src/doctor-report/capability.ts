import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  DOCTOR_LOCAL_CAPABILITY_FILENAME,
  DOCTOR_LOCAL_CAPABILITY_HEADER,
} from "@openllmsh/protocol";
import { atomicWriteText, doctorStatePath, readTextFile } from "./files";

let cachedToken: string | null = null;
/** This boot's mint failed after bind — do not honor a leftover file token. */
let mintFailedClosed = false;

export const doctorCapabilityPath = (): string =>
  doctorStatePath(DOCTOR_LOCAL_CAPABILITY_FILENAME);

export const doctorCapabilityHeaderName = (): string =>
  DOCTOR_LOCAL_CAPABILITY_HEADER;

/** Mint a per-boot owner-only capability. Local FS only — never network. */
export const mintDoctorCapability = (): boolean => {
  const token = randomBytes(32).toString("hex");
  if (!atomicWriteText(doctorCapabilityPath(), `${token}\n`)) {
    cachedToken = null;
    mintFailedClosed = true;
    return false;
  }
  mintFailedClosed = false;
  cachedToken = token;
  return true;
};

/**
 * Rotate the capability only after the loopback listener is bound.
 * A failed bind must not clobber a live process's token.
 */
export const onDoctorListenAttempt = (bound: boolean): boolean => {
  if (!bound) return false;
  return mintDoctorCapability();
};

export const readDoctorCapability = (): string | null => {
  if (mintFailedClosed) return null;
  if (cachedToken !== null) return cachedToken;
  const raw = readTextFile(doctorCapabilityPath());
  if (raw === null) return null;
  const token = raw.trim();
  if (token.length < 16) return null;
  cachedToken = token;
  return token;
};

export const capabilityMatches = (presented: string | null): boolean => {
  const expected = readDoctorCapability();
  if (expected === null || presented === null) return false;
  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);
  if (expectedBytes.length !== presentedBytes.length) return false;
  return timingSafeEqual(expectedBytes, presentedBytes);
};

export const resetDoctorCapabilityForTests = (): void => {
  cachedToken = null;
  mintFailedClosed = false;
};
