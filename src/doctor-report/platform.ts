import type { TDoctorArchitecture, TDoctorPlatform } from "@openllmsh/protocol";

export const doctorPlatform = (): TDoctorPlatform | null => {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return null;
};

export const doctorArchitecture = (): TDoctorArchitecture | null => {
  const a = process.arch;
  if (a === "arm64" || a === "x64") return a;
  return null;
};

export const isDevDaemonVersion = (version: string): boolean =>
  version === "0.0.0-dev" || version.includes("-dev");
