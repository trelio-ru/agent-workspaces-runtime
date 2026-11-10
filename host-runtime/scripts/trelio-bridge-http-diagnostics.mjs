import contract from "./trelio-agent-diagnostics-contract.json" with { type: "json" };
import { projectDiagnosticDetail } from "./trelio-diagnostic-observation.mjs";

// UNKNOWN is the collector fallback, not a meaningful backend cause. Keep the
// previous in-process behavior: a literal UNKNOWN still uses the HTTP bucket.
const knownCodes = new Set(contract.errorCodes.filter(code => code !== "UNKNOWN"));
const exactStatuses = new Set([400, 401, 403, 404, 409, 429]);
const isHttpFailure = status => Number.isInteger(status) && status >= 400 && status <= 599;

// Both execution paths use one reviewed projection. A backend can put private
// text even in a code-shaped field, so only the existing catalog is eligible;
// an unknown domain code falls back to a fixed HTTP bucket, never its message.
export const bridgeHttpDiagnosticCode = (status, backendCode) =>
  knownCodes.has(backendCode) ? backendCode
    : exactStatuses.has(status) ? "TRELIO_BACKEND_HTTP_" + status
    : isHttpFailure(status) && status >= 500 ? "TRELIO_BACKEND_HTTP_5XX"
    : "TRELIO_BACKEND_HTTP_OTHER";

// Admission has several independent clocks: proof, runtime, bridge and source
// grant. Preserve only the backend's closed diagnosis, never the session/proof
// envelope. Keeping the projector shared also makes child and in-process errors
// agree without parsing human prose or promoting diagnosis into retry authority.
const runtimeReasons = new Set(["missing", "invalid", "expired", "replayed"]);
const expiredCauses = new Set([
  "proof_age", "proof_clock_skew", "runtime_session_unavailable",
  "runtime_session_ended", "runtime_session_expired", "bridge_session_revoked",
  "bridge_session_expired", "source_grant_revoked", "source_grant_expired",
]);
export const projectRuntimeAdmissionFailure = (backendCode, payload) => {
  if (backendCode !== "TRELIO_RUNTIME_HOOK_REQUIRED" || !runtimeReasons.has(payload?.reason)) return null;
  const expired = payload.reason === "expired";
  return {
    reason: payload.reason,
    ...(expired && expiredCauses.has(payload.expiredCause) ? { expiredCause: payload.expiredCause } : {}),
    ...(expired && Number.isSafeInteger(payload.proofAgeMs) ? { proofAgeMs: payload.proofAgeMs } : {}),
    // False/unknown remains distinct from affirmative pre-dispatch evidence.
    ...(typeof payload.beforeDispatch === "boolean" ? { beforeDispatch: payload.beforeDispatch } : {}),
  };
};

export const runtimeAdmissionRecovery = (runtime, operation) => {
  if (!runtime) return null;
  const reloadSkill = operation === "skill_run" && runtime.reason === "expired"
    && ["runtime_session_ended", "runtime_session_expired"].includes(runtime.expiredCause);
  return {
    requiredAction: reloadSkill ? "reload_agent_skill_in_current_chat" : "diagnose_runtime_admission",
    ...(reloadSkill ? { toolName: "get_agent_skill", sections: ["instructions", "execution"] } : {}),
    diagnosticSkill: "trelio-diagnostics",
    automaticRetry: false,
    // Admission is a completed backend refusal, not evidence that the client's
    // MCP connection or installed plugin is stale. Recovery keeps the chat and
    // existing Run; a new skill declaration must come from a fresh native read.
    pluginToggleRequired: false,
    restartRequired: false,
  };
};

export const buildBridgeHttpErrorFrame = (status, backendCode, message, payload = null) => {
  const runtime = status === 409 ? projectRuntimeAdmissionFailure(backendCode, payload) : null;
  const diagnosticEvidence = status === 409 && backendCode === "LOCAL_CONTEXT_GENERATION_CHANGED"
    ? projectDiagnosticDetail(payload?.diagnosticEvidence) : null;
  return {
    code: "TRELIO_BRIDGE_HTTP_ERROR",
    // This is the existing bounded local CLI explanation, not telemetry. Never
    // copy the response payload, headers, URL or arbitrary Error properties.
    message,
    details: {
      httpStatus: status,
      ...(knownCodes.has(backendCode) ? { backendCode } : {}),
      ...(runtime ? { runtime } : {}),
      ...(diagnosticEvidence?.kind === "generation" ? { diagnosticEvidence } : {}),
    },
  };
};

export const parseBridgeHttpDiagnostic = stderr => {
  if (typeof stderr !== "string" || Buffer.byteLength(stderr, "utf8") > 64 * 1024) return null;
  // A provider may emit arbitrary stderr before the bridge fails. Read only
  // the final complete frame, not earlier lookalikes or legacy prose. Old
  // runtimes still fall back to the process category without guessing an HTTP
  // status from human text. Classification never authorizes another request.
  const line = stderr.trimEnd().split("\n").at(-1);
  if (!line.startsWith("Ошибка: {") || Buffer.byteLength(line, "utf8") > 8 * 1024) return null;
  try {
    const payload = JSON.parse(line.slice("Ошибка: ".length));
    const status = payload?.details?.httpStatus;
    const backendCode = payload?.details?.backendCode;
    if (payload?.code !== "TRELIO_BRIDGE_HTTP_ERROR" || !isHttpFailure(status)
      || (backendCode !== undefined && !knownCodes.has(backendCode))) return null;
    const runtime = status === 409 ? projectRuntimeAdmissionFailure(backendCode, payload.details?.runtime) : null;
    const diagnosticEvidence = status === 409 && backendCode === "LOCAL_CONTEXT_GENERATION_CHANGED"
      ? projectDiagnosticDetail(payload.details?.diagnosticEvidence) : null;
    return { httpStatus: status, failureCode: bridgeHttpDiagnosticCode(status, backendCode),
      ...(diagnosticEvidence?.kind === "generation" ? { diagnosticEvidence } : {}),
      ...(runtime ? { runtime } : {}) };
  } catch { return null; }
};
