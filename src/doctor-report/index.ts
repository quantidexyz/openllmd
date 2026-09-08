export {
  mintDoctorCapability,
  readDoctorCapability,
  resetDoctorCapabilityForTests,
} from "./capability";
export {
  applyLocalPreferenceAndMaybePurge,
  flushDoctorReport,
  initDoctorCursorAtTail,
  observeDoctorEvent,
  onBootstrapReportingPolicy,
  reportingScope,
  reportingStatus,
  resetDoctorEngineForTests,
  scheduleDoctorFlush,
  setDoctorEngineClockForTests,
  setDoctorObservationListenerForTests,
  setDoctorSchedulerForTests,
  setDoctorUploadForTests,
} from "./engine";
export {
  noteCliInstallProbeResult,
  noteControlChannelClose,
  noteLoginTerminal,
  noteWalkerStreamTerminal,
  resetCliInstallDoctorStreakForTests,
} from "./hooks";
export { handleDoctorLocal, isDoctorLocalPath } from "./local-http";
export {
  clearLocalPreference,
  readLocalPreference,
  writeLocalPreference,
} from "./preference";
export type { TDoctorObservationInput } from "./record";
export {
  recordDoctorObservation,
  resetDoctorRecordForTests,
  setDoctorRecordClockForTests,
} from "./record";
