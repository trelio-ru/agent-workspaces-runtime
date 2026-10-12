import contract from "./trelio-agent-diagnostics-contract.json" with { type: "json" };

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

export const buildBridgeHttpErrorFrame = (status, backendCode, message) => ({
  code: "TRELIO_BRIDGE_HTTP_ERROR",
  // This is the existing bounded local CLI explanation, not telemetry. Never
  // copy the response payload, headers, URL or arbitrary Error properties.
  message,
  details: {
    httpStatus: status,
    ...(knownCodes.has(backendCode) ? { backendCode } : {}),
  },
});

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
    return { httpStatus: status, failureCode: bridgeHttpDiagnosticCode(status, backendCode) };
  } catch { return null; }
};
