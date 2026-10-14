import { setTimeout as sleep } from "node:timers/promises";

// These anonymous, read-only routes exercise the same public origin as MCP
// discovery. Never use the authenticated bridge request helper here: server
// availability must remain observable when OAuth or model tools are absent.
const ENDPOINTS = Object.freeze([
  { name: "mcp", path: "/mcp", expectedStatus: 405 },
  { name: "protected_resource", path: "/.well-known/oauth-protected-resource/mcp", field: "resource", suffix: "/mcp", expectedStatus: 200 },
  { name: "authorization_server", path: "/.well-known/oauth-authorization-server", field: "issuer", suffix: "", expectedStatus: 200 },
]);
const RETRY_DELAYS_MS = Object.freeze([0, 2_000, 5_000, 15_000]);
const RESPONSE_LIMIT_BYTES = 16 * 1024;

const readMetadata = async (response) => {
  // Bound streamed bytes, including responses without Content-Length. Do not
  // return response text or native exceptions: proxies can include private data.
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT_BYTES) return null;
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

export const diagnosePublicTrelioService = async (origin, {
  signal,
  fetchImpl = globalThis.fetch,
  wait = (delay, options) => sleep(delay, undefined, options),
} = {}) => {
  let base;
  try { base = new URL(origin); } catch {
    return { state: "not_checked", reasonCode: "PUBLIC_SERVICE_ORIGIN_UNSUPPORTED", attempts: [] };
  }
  // The origin is host configuration, never a model-supplied diagnostic URL.
  // Local HTTP is retained only for the existing development transport.
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash
    || !(base.protocol === "https:" || (base.protocol === "http:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))) {
    return { state: "not_checked", reasonCode: "PUBLIC_SERVICE_ORIGIN_UNSUPPORTED", attempts: [] };
  }
  const attempts = [];
  const results = new Map();
  let pending = [...ENDPOINTS];
  for (let index = 0; index < RETRY_DELAYS_MS.length && pending.length; index += 1) {
    if (signal?.aborted) return { state: "cancelled", attempts };
    if (RETRY_DELAYS_MS[index]) {
      try { await wait(RETRY_DELAYS_MS[index], { signal }); } catch {
        return { state: "cancelled", attempts };
      }
    }
    const checks = await Promise.all(pending.map(async (endpoint) => {
      const deadline = AbortSignal.timeout(3_000);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let response;
      try {
        response = await fetchImpl(new URL(endpoint.path, base), {
          method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
          headers: { accept: "application/json" }, signal: requestSignal,
        });
        const httpStatus = response.status;
        if (httpStatus !== endpoint.expectedStatus) {
          const transient = httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599);
          const retryAfter = response.headers.get("retry-after");
          const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1_000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
          // Do not retry sooner than the server permits or extend the bounded
          // diagnostic to minutes. A longer Retry-After stops this probe only.
          const exceedsBudget = transient && retryAfterMs > (RETRY_DELAYS_MS[index + 1] ?? 0);
          return { endpoint: endpoint.name, outcome: exceedsBudget ? "retry_after_exceeds_budget"
            : transient ? "temporary_http_failure" : "unexpected_http_response", httpStatus };
        }
        if (endpoint.field) {
          const metadata = await readMetadata(response);
          if (metadata?.[endpoint.field] !== `${base.origin}${endpoint.suffix}`) {
            return { endpoint: endpoint.name, outcome: "invalid_metadata", httpStatus };
          }
        }
        return { endpoint: endpoint.name, outcome: "expected_response", httpStatus };
      } catch {
        return { endpoint: endpoint.name, outcome: signal?.aborted ? "cancelled"
          : deadline.aborted ? "timeout" : "network_failure" };
      } finally {
        await response?.body?.cancel().catch(() => undefined);
      }
    }));
    attempts.push({ attempt: index + 1, delayBeforeMs: RETRY_DELAYS_MS[index], checks });
    for (const check of checks) results.set(check.endpoint, check);
    // Retry only transient anonymous failures. 401/403, redirects, malformed
    // metadata and an unexpected route are evidence to inspect, not auth repair.
    pending = pending.filter((endpoint) => ["temporary_http_failure", "network_failure", "timeout"]
      .includes(results.get(endpoint.name).outcome));
  }
  const outcomes = [...results.values()].map((result) => result.outcome);
  const state = signal?.aborted ? "cancelled"
    : outcomes.every((outcome) => outcome === "expected_response")
      ? attempts.length > 1 ? "recovered" : "available"
      : outcomes.some((outcome) => ["unexpected_http_response", "invalid_metadata"].includes(outcome))
        ? "unexpected_response" : "unavailable";
  return { state, attempts };
};
