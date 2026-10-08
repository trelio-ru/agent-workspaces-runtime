import { randomUUID } from "node:crypto";
import contract from "./trelio-agent-diagnostics-contract.json" with { type: "json" };
import { getPluginVersion, getHostRuntimeVersion } from "./trelio-component-versions.mjs";

const known = (list, value, fallback = "unknown") => list.includes(value) ? value : fallback;
const version = value => typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(value) ? value : "0.0.0";
export const observationCode = code => ["OK", "ROUTED"].includes(code) ? code
  : known(contract.errorCodes, code, "UNKNOWN");
export const observationCount = sample => sample.outcomes.reduce((sum, item) => sum + item.count, 0);
export const buildDiagnosticObservation = (tool, args, code = "OK", {
  environment = process.env, boundary = "mcp", field = "unknown",
  platform = process.platform, architecture = process.arch,
} = {}) => ({
  id: randomUUID(), boundary: known(contract.boundaries, boundary, "mcp"),
  tool: boundary === "hook" ? "runtime_hook" : known(contract.localTools, tool),
  operation: known(boundary === "hook" ? contract.hookEvents : contract.operations, args?.operation ?? args?.route),
  platform: known(contract.platforms, platform), architecture: known(contract.architectures, architecture),
  pluginVersion: version(getPluginVersion(environment)), runtimeVersion: version(getHostRuntimeVersion(environment)),
  outcomes: code === null ? [] : [{ code: observationCode(code), field: known(contract.validationFields, field), count: 1 }],
  losses: [],
});

// Journal input is untrusted, even on a single-user machine. Reject the entire
// record, including unknown keys, instead of reflecting any arbitrary text.
export const isDiagnosticObservation = sample => {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return false;
  const keys = ["id", "boundary", "tool", "operation", "platform", "architecture", "pluginVersion", "runtimeVersion", "outcomes", "losses"];
  if (Object.keys(sample).length !== keys.length || Object.keys(sample).some(key => !keys.includes(key))) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sample.id)) return false;
  if (!contract.boundaries.includes(sample.boundary) || !contract.platforms.includes(sample.platform)
    || !contract.architectures.includes(sample.architecture) || version(sample.pluginVersion) !== sample.pluginVersion
    || version(sample.runtimeVersion) !== sample.runtimeVersion) return false;
  if (sample.boundary === "hook" ? sample.tool !== "runtime_hook" || !contract.hookEvents.includes(sample.operation)
    : !contract.localTools.includes(sample.tool) || !contract.operations.includes(sample.operation)) return false;
  if (!Array.isArray(sample.outcomes) || sample.outcomes.length > 64 || !Array.isArray(sample.losses) || sample.losses.length > contract.lossReasons.length) return false;
  const pairs = new Set();
  for (const row of sample.outcomes) {
    if (!row || Object.keys(row).length !== 3 || !Object.hasOwn(row, "code") || !Object.hasOwn(row, "field")
      || observationCode(row.code) !== row.code || !contract.validationFields.includes(row.field)
      || !Number.isInteger(row.count) || row.count < 1 || row.count > 1000) return false;
    const key = row.code + ":" + row.field;
    if (pairs.has(key)) return false;
    pairs.add(key);
  }
  const losses = new Set();
  for (const row of sample.losses) {
    if (!row || Object.keys(row).length !== 2 || !contract.lossReasons.includes(row.reason)
      || !Number.isInteger(row.count) || row.count < 1 || row.count > 1000000 || losses.has(row.reason)) return false;
    losses.add(row.reason);
  }
  return observationCount(sample) <= 1000 && (sample.outcomes.length > 0 || sample.losses.length > 0);
};
