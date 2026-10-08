/**
 * Content-free errors at subprocess boundaries. The bridge's own final error
 * frame preserves the inner failure instead of replacing a skill exit with
 * the exit of the enclosing Node CLI. No provider output is interpreted here.
 */
const WINDOWS_CODES = [
  "TRELIO_WINDOWS_PRIVATE_PROCESS_START_FAILED",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_START_TIMEOUT",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_REQUEST_TIMEOUT",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_PROTOCOL_INVALID",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_EXITED",
  "TRELIO_WINDOWS_PRIVATE_PROCESS_IO_FAILED",
  "TRELIO_WINDOWS_PRIVATE_ACL_FAILED",
  "TRELIO_WINDOWS_PRIVATE_DPAPI_FAILED",
  "TRELIO_RUNTIME_HOOK_DEADLINE_EXCEEDED",
];
const SKILL_CODES = [
  "TRELIO_SKILL_RUNTIME_START_FAILED",
  "TRELIO_SKILL_RUNTIME_TERMINATED",
  "TRELIO_SKILL_RUNTIME_LEASE_EXPIRED",
  ...[1, 2, 3, 4, 5, 6].map(value => `TRELIO_SKILL_RUNTIME_EXIT_${value}`),
  "TRELIO_SKILL_RUNTIME_EXIT_OTHER",
];
export const PROCESS_DIAGNOSTIC_CODES = Object.freeze([...WINDOWS_CODES, ...SKILL_CODES]);
const codes = new Set(PROCESS_DIAGNOSTIC_CODES);
const windowsCodes = new Set(WINDOWS_CODES);
const stages = new Set([
  "local_state", "hook_setup", "runtime_state_read", "state_lock",
  "runtime_attestation", "bridge_credentials", "runtime_registration", "runtime_state_write",
]);
const phases = ["worker_startup", "request_dispatch", "path_decode", "identity", "owner_read",
  "owner_write", "dacl_write", "dacl_verify"];
const operations = new Set([
  "local_state", ...phases.map(phase => `windows_acl.${phase}`),
  "windows_dpapi.worker_startup", "windows_dpapi.request_dispatch",
  "windows_dpapi.protect", "windows_dpapi.unprotect", "skill_run",
]);
const causeCodes = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EPIPE",
  "ECONNRESET", "EIO", "EINVAL", "ENOMEM", "EMFILE", "ENFILE", "ABORT_ERR"]);
const signals = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGHUP", "SIGBUS"]);
export const processDiagnosticCauseCode = error => causeCodes.has(error?.code) ? error.code : "UNKNOWN";
const publicCodeFor = code => windowsCodes.has(code) ? "TRELIO_RUNTIME_HOOK_FAILED" : code;

// Copy only closed technical fields, never spread an Error, child reply or
// provider object. Numeric exits are local evidence; telemetry uses fixed
// buckets 1..6/OTHER and retains its existing schema/cardinality bound.
const safeDetails = (code, value = {}) => ({
  failureCode: code,
  ...(stages.has(value.hookStage) ? { hookStage: value.hookStage } : {}),
  ...(operations.has(value.operation) ? { operation: value.operation } : {}),
  ...(["hook", "private_process"].includes(value.timeoutKind) ? { timeoutKind: value.timeoutKind } : {}),
  ...(Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 0xffffffff
    ? { exitCode: value.exitCode } : {}),
  ...(causeCodes.has(value.causeCode) || value.causeCode === "UNKNOWN" ? { causeCode: value.causeCode } : {}),
  ...(signals.has(value.signal) ? { signal: value.signal } : {}),
});

export class ProcessDiagnosticError extends Error {
  constructor(diagnosticCode, message, details = {}) {
    if (!codes.has(diagnosticCode)) throw new TypeError("Unknown process diagnostic category.");
    super(message);
    this.code = publicCodeFor(diagnosticCode);
    this.diagnosticCode = diagnosticCode;
    this.details = safeDetails(diagnosticCode, details);
    // Hook callers historically read these fields directly. Keep the ABI,
    // including the original TRELIO_RUNTIME_HOOK_FAILED public code.
    for (const key of ["hookStage", "operation", "timeoutKind"]) {
      if (this.details[key] !== undefined) this[key] = this.details[key];
    }
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}

export const skillRuntimeExitError = exitCode => new ProcessDiagnosticError(
  Number.isInteger(exitCode) && exitCode >= 1 && exitCode <= 6
    ? `TRELIO_SKILL_RUNTIME_EXIT_${exitCode}` : "TRELIO_SKILL_RUNTIME_EXIT_OTHER",
  `Runtime навыка завершился с кодом ${exitCode}.`,
  { operation: "skill_run", exitCode },
);

export const parseProcessDiagnostic = stderr => {
  if (typeof stderr !== "string" || stderr.length > 64 * 1024
      || Buffer.byteLength(stderr, "utf8") > 64 * 1024) return null;
  // Providers may have written stderr before the bridge's final frame. Only
  // that final complete line is eligible; an earlier lookalike followed by a
  // legacy/plain failure cannot manufacture a structured bridge result.
  const line = stderr.trimEnd().split("\n").at(-1);
  if (!line.startsWith("Ошибка: {") || Buffer.byteLength(line, "utf8") > 8 * 1024) return null;
  try {
    const payload = JSON.parse(line.slice("Ошибка: ".length));
    const code = payload?.details?.failureCode;
    if (!codes.has(code) || payload.code !== publicCodeFor(code)) return null;
    return safeDetails(code, payload.details);
  } catch { return null; }
};
