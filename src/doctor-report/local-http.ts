/**
 * CLI-only localhost doctor routes. Loopback + capability required.
 * CORS/Origin is not a grant — browser Origin is rejected.
 */

import type {
  TDoctorLocalPreference,
  TDoctorLocalReportRequest,
} from "@openllmsh/protocol";
import {
  DOCTOR_LOCAL_CAPABILITY_HEADER,
  DOCTOR_LOCAL_PREFERENCE_PATH,
  DOCTOR_LOCAL_REPORT_PATH,
  DOCTOR_LOCAL_STATUS_PATH,
  DOCTOR_REPORT_MAX_BODY_BYTES,
  parseDoctorLocalPreference,
  parseDoctorLocalReportRequest,
} from "@openllmsh/protocol";
import { capabilityMatches } from "./capability";
import {
  applyLocalPreferenceAndMaybePurge,
  flushDoctorReport,
  reportingScope,
  reportingStatus,
} from "./engine";
import { writeLocalPreference } from "./preference";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const portOk = (port: string): boolean => {
  if (!/^\d{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
};

/** Strict Host allow-list: loopback only. Rejects userinfo, extras, remotes. */
export const isLoopbackDoctorHost = (host: string | null): boolean => {
  if (host === null) return false;
  const raw = host.trim().toLowerCase();
  if (raw === "" || raw.includes("@") || /\s/.test(raw)) return false;
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close <= 1) return false;
    const name = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (name !== "::1") return false;
    if (rest === "") return true;
    return rest.startsWith(":") && portOk(rest.slice(1));
  }
  if (raw.includes("]")) return false;
  const parts = raw.split(":");
  if (parts.length > 2) return false;
  const name = parts[0] ?? "";
  if (name !== "127.0.0.1" && name !== "localhost") return false;
  const port = parts[1];
  if (port === undefined) return true;
  return portOk(port);
};

const capabilityDeniedBody = (pathname: string): Record<string, unknown> => {
  if (pathname === DOCTOR_LOCAL_STATUS_PATH) {
    return {
      local_enabled: false,
      account_enabled: false,
      pending_account_sync: false,
      unavailable_reason: "capability_missing",
    };
  }
  return {
    nothing_new: true,
    dry_run: false,
    accepted_count: 0,
    skipped_count: 0,
    gap_count: 0,
    legacy_records_skipped: 0,
    daemon_versions: [],
    pending: false,
    unavailable_reason: "capability_missing",
  };
};

const authorizeLocalDoctor = (
  req: Request,
  pathname: string,
): Response | null => {
  if (!isLoopbackDoctorHost(req.headers.get("host"))) {
    return json(403, { error: "forbidden" });
  }
  if (req.headers.get("origin") !== null) {
    return json(403, { error: "forbidden" });
  }
  const presented = req.headers.get(DOCTOR_LOCAL_CAPABILITY_HEADER);
  if (!capabilityMatches(presented)) {
    return json(403, capabilityDeniedBody(pathname));
  }
  return null;
};

const readJsonBody = async (req: Request): Promise<unknown | Response> => {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > DOCTOR_REPORT_MAX_BODY_BYTES) {
    return json(413, { error: "oversize" });
  }
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) {
    return json(415, { error: "unsupported_media_type" });
  }
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.byteLength > DOCTOR_REPORT_MAX_BODY_BYTES) {
    return json(413, { error: "oversize" });
  }
  try {
    return JSON.parse(buf.toString("utf8")) as unknown;
  } catch {
    return json(400, { error: "invalid" });
  }
};

export const isDoctorLocalPath = (pathname: string): boolean =>
  pathname === DOCTOR_LOCAL_REPORT_PATH ||
  pathname === DOCTOR_LOCAL_STATUS_PATH ||
  pathname === DOCTOR_LOCAL_PREFERENCE_PATH;

export const handleDoctorLocal = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const denied = authorizeLocalDoctor(req, url.pathname);
  if (denied !== null) return denied;
  if (url.pathname === DOCTOR_LOCAL_STATUS_PATH) {
    if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
    return json(200, reportingStatus());
  }
  if (url.pathname === DOCTOR_LOCAL_REPORT_PATH) {
    if (req.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    let parsed: TDoctorLocalReportRequest;
    try {
      parsed = parseDoctorLocalReportRequest(body);
    } catch {
      return json(400, { error: "invalid" });
    }
    const result = await flushDoctorReport({
      dryRun: parsed.dry_run,
      ...(parsed.reporter_cli_version !== undefined
        ? { reporterCliVersion: parsed.reporter_cli_version }
        : {}),
      trigger: "doctor_manual",
    });
    return json(200, result);
  }
  if (url.pathname === DOCTOR_LOCAL_PREFERENCE_PATH) {
    if (req.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    let parsed: TDoctorLocalPreference;
    try {
      parsed = parseDoctorLocalPreference(body);
    } catch {
      return json(400, { error: "invalid" });
    }
    const scope = reportingScope();
    const scoped = {
      ...parsed,
      origin_scope: scope.originScope,
      account_scope: scope.accountScope,
      ...(parsed.generation !== undefined
        ? { generation: parsed.generation }
        : scope.generation !== null
          ? { generation: scope.generation }
          : {}),
    };
    if (!writeLocalPreference(scoped)) {
      return json(500, { error: "persist_failed" });
    }
    applyLocalPreferenceAndMaybePurge(scoped.enabled);
    return json(200, scoped);
  }
  return json(404, { error: "not found" });
};
