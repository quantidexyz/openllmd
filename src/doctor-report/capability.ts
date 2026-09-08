import { randomBytes } from "node:crypto";
import {
  DOCTOR_LOCAL_CAPABILITY_FILENAME,
  DOCTOR_LOCAL_CAPABILITY_HEADER,
} from "@openllmsh/protocol";
import { atomicWriteText, doctorStatePath, readTextFile } from "./files";

let cachedToken: string | null = null;

export const doctorCapabilityPath = (): string =>
  doctorStatePath(DOCTOR_LOCAL_CAPABILITY_FILENAME);

export const doctorCapabilityHeaderName = (): string =>
  DOCTOR_LOCAL_CAPABILITY_HEADER;

/** Mint a per-boot owner-only capability. Local FS only — never network. */
export const mintDoctorCapability = (): string => {
  const token = randomBytes(32).toString("hex");
  if (!atomicWriteText(doctorCapabilityPath(), `${token}\n`)) {
    cachedToken = null;
    return token;
  }
  cachedToken = token;
  return token;
};

export const readDoctorCapability = (): string | null => {
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
  if (expected.length !== presented.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return mismatch === 0;
};

export const resetDoctorCapabilityForTests = (): void => {
  cachedToken = null;
};
