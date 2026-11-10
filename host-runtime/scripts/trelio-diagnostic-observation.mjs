import { randomUUID } from "node:crypto";
import contract from "./trelio-agent-diagnostics-contract.json" with { type: "json" };
import { getPluginVersion, getHostRuntimeVersion } from "./trelio-component-versions.mjs";

const known = (list, value, fallback = "unknown") => list.includes(value) ? value : fallback;
const version = value => typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(value) ? value : "0.0.0";
const vocabulary = contract.detailEvidence;
const detailKeys = {
  generation: ["kind", "stage", "reason", "count"],
  input: ["kind", "stage", "reason", "key", "expectedType", "actualType", "count"],
  delivery: ["kind", "stage", "reason", "httpStatus", "count"],
  journal: ["kind", "stage", "reason", "ageBucket", "count"],
};

// Strict canonical projection is shared by typed errors, untrusted HTTP/child
// frames, the journal and delivery. No getter, arbitrary Error property or
// free-form key/value may become a telemetry label. Unknown evidence is absent.
export const projectDiagnosticDetail = input => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.values(descriptors).some(value => !Object.hasOwn(value, "value"))) return null;
    const value = Object.fromEntries(Object.entries(descriptors).map(([key, entry]) => [key, entry.value]));
    const keys = detailKeys[value.kind];
    if (!keys || Object.keys(value).some(key => !keys.includes(key))) return null;
    const count = Object.hasOwn(value, "count") ? value.count : 1;
    if (!Number.isInteger(count) || count < 1 || count > 1000000) return null;
    if (!vocabulary[value.kind + "Stages"].includes(value.stage) || !vocabulary[value.kind + "Reasons"].includes(value.reason)) return null;
    const detail = { kind: value.kind, stage: value.stage, reason: value.reason };
    if (value.kind === "input") {
      if (!vocabulary.inputFields.includes(value.key) || !vocabulary.types.includes(value.expectedType) || !vocabulary.types.includes(value.actualType)) return null;
      Object.assign(detail, { key: value.key, expectedType: value.expectedType, actualType: value.actualType });
    } else if (value.kind === "delivery") {
      if (!Number.isInteger(value.httpStatus) || value.httpStatus !== 0 && (value.httpStatus < 400 || value.httpStatus > 599)) return null;
      detail.httpStatus = value.httpStatus;
    } else if (value.kind === "journal") {
      if (!vocabulary.ageBuckets.includes(value.ageBucket)) return null;
      detail.ageBucket = value.ageBucket;
    }
    return { ...detail, count };
  } catch { return null; }
};
const errorDetails = new WeakMap();
export const rememberDiagnosticDetail = (error, detail) => {
  const projected = projectDiagnosticDetail(detail);
  if (error && typeof error === "object" && projected) errorDetails.set(error, projected);
  return error;
};
export const readDiagnosticDetail = error => error && typeof error === "object" ? errorDetails.get(error) : undefined;
export const diagnosticValueType = value => value === undefined ? "missing" : value === null ? "null"
  : Array.isArray(value) ? "array" : ["string", "number", "boolean", "object"].includes(typeof value) ? typeof value : "other";
const detailKey = ({ count: _count, ...detail }) => JSON.stringify(detail);
export const diagnosticDetailsMatch = (row, code, loss) => {
  if (row.details === undefined) return true;
  if (!Array.isArray(row.details) || !row.details.length || row.details.length > vocabulary.maxPerRow) return false;
  const details = row.details.map(projectDiagnosticDetail);
  if (details.some((detail, index) => !detail || Object.keys(row.details[index]).length !== detailKeys[detail.kind].length)
    || details.reduce((sum, detail) => sum + detail.count, 0) > row.count
    || new Set(details.map(detailKey)).size !== details.length) return false;
  return details.every(detail => code !== undefined
    ? detail.kind === "generation" ? code === "LOCAL_CONTEXT_GENERATION_CHANGED"
      : detail.kind === "input" && code === "TRELIO_WORKSPACE_INPUT_" + detail.reason
    : detail.kind === "delivery" ? ["delivery_timeout", "delivery_transport", "delivery_rejected", "credential_unavailable"].includes(loss)
      : detail.kind === "journal" && ["journal_full", "journal_invalid", "journal_expired"].includes(loss));
};
export const addDiagnosticDetail = (row, raw, sample) => {
  const detail = projectDiagnosticDetail(raw);
  if (!detail || !diagnosticDetailsMatch({ count: detail.count, details: [detail] }, row.code, row.reason)) return;
  detail.count = Math.min(detail.count, row.count - (row.details ?? []).reduce((sum, item) => sum + item.count, 0));
  if (detail.count <= 0) return;
  const previous = row.details?.find(item => detailKey(item) === detailKey(detail));
  if (previous) { previous.count += detail.count; return; }
  // Dropped detail never drops its paired outcome. Coverage in the report
  // exposes the difference; the bounded journal/body ABI is not enlarged.
  if ((row.details?.length ?? 0) >= vocabulary.maxPerRow
    || [...sample.outcomes, ...sample.losses].reduce((sum, item) => sum + (item.details?.length ?? 0), 0) >= vocabulary.maxPerSample) return;
  (row.details ??= []).push(detail);
};
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
    if (!row || Object.keys(row).some(key => !["code", "field", "count", "details"].includes(key)) || !Object.hasOwn(row, "code") || !Object.hasOwn(row, "field")
      || observationCode(row.code) !== row.code || !contract.validationFields.includes(row.field)
      || !Number.isInteger(row.count) || row.count < 1 || row.count > 1000 || !diagnosticDetailsMatch(row, row.code)) return false;
    const key = row.code + ":" + row.field;
    if (pairs.has(key)) return false;
    pairs.add(key);
  }
  const losses = new Set();
  for (const row of sample.losses) {
    if (!row || Object.keys(row).some(key => !["reason", "count", "details"].includes(key)) || !contract.lossReasons.includes(row.reason)
      || !Number.isInteger(row.count) || row.count < 1 || row.count > 1000000 || losses.has(row.reason)
      || !diagnosticDetailsMatch(row, undefined, row.reason)) return false;
    losses.add(row.reason);
  }
  return observationCount(sample) <= 1000 && (sample.outcomes.length > 0 || sample.losses.length > 0)
    && [...sample.outcomes, ...sample.losses].reduce((sum, row) => sum + (row.details?.length ?? 0), 0) <= vocabulary.maxPerSample;
};
