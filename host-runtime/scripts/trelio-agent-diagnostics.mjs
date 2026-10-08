import { randomUUID } from "node:crypto";
import contract from "./trelio-agent-diagnostics-contract.json" with { type: "json" };
import { getPluginVersion, getHostRuntimeVersion } from "./trelio-component-versions.mjs";
import { readExistingBridgeSessionToken } from "./trelio-workspace.mjs";

const known = (values, value, fallback) => values.includes(value) ? value : fallback;
const version = (value) => /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(value) ? value : "0.0.0";

export const buildAgentDiagnosticEvent = (tool, args, code, environment = process.env) => ({
  id: randomUUID(),
  tool: known(contract.localTools, tool, "unknown"),
  // Only the envelope discriminator is considered. Never inspect skill args,
  // messages, paths, company identity, proofs or any nested provider payload.
  operation: known(contract.operations, args?.operation ?? args?.route, "unknown"),
  code: known(contract.errorCodes, code, "UNKNOWN"),
  pluginVersion: version(getPluginVersion(environment)),
  runtimeVersion: version(getHostRuntimeVersion(environment)),
  count: 1,
});

export const sendAgentDiagnosticBatch = async (origin, events, {
  fetchImpl = fetch,
  readToken = readExistingBridgeSessionToken,
  signal,
} = {}) => {
  // Telemetry is optional: use an existing paired session without login,
  // credential migration, refresh, pairing or source OAuth fallback.
  signal?.throwIfAborted();
  const token = await readToken(origin, { signal });
  signal?.throwIfAborted();
  if (!token) return;
  const response = await fetchImpl(new URL("/api/agent-workspaces/diagnostics/errors", origin), {
    method: "POST", redirect: "error", signal,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, events }),
  });
  await response.body?.cancel();
  // Rejected/old servers need no recovery. Only transport/5xx are retried,
  // always using the identical batch IDs so a lost 204 cannot inflate counts.
  if (response.status >= 500) throw new Error("DIAGNOSTICS_RETRY");
};

export { createAgentDiagnosticReporter } from "./trelio-diagnostic-reporter.mjs";
