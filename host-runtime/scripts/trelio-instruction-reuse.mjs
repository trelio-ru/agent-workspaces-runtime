/**
 * Instruction hints belong to the host, never to model-authored arguments.
 *
 * A historical successful MCP call is not a delivery receipt. Only the final
 * response_item stream of the explicitly supported Codex format is examined;
 * raw event_msg results, Code Mode locals and summaries cannot grant reuse.
 * Claude's asynchronous journal and independent tool-output clearing cannot
 * currently prove retention, so that adapter deliberately returns full reads.
 * No instruction text or receipt cache is written to disk by this module.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const REVISION_TOOLS = new Set([
  "get_agent_instructions", "get_project_meta", "get_task_create_meta", "get_workspace", "fetch",
]);
const LAYER_TOOLS = new Set(["get_task", "get_tasks", "get_task_instruction_page"]);
// Local domain reads hydrate schema-v3 authority even where the equivalent
// native tool has no instruction argument. Keep that fallback boundary explicit
// rather than stripping similarly named fields from arbitrary mutations.
const LOCAL_AUTHORITY_TOOLS = new Set([
  ...REVISION_TOOLS, ...LAYER_TOOLS,
  "get_knowledge_base_page", "get_contact", "get_registry", "get_meeting",
]);
const FIELDS = ["knownInstructionRevisionKey", "knownInstructionLayerKeys"];
const HASH = /^[a-f0-9]{64}$/u;
const LAYER = /^instruction-layer:[a-f0-9]{64}$/u;
const MAX_BYTES = 2 * 1024 * 1024;
const INSPECTION_TIMEOUT_MS = 250;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const strip = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !FIELDS.includes(key)));
// Rust hook serialization may sort object keys whereas model arguments retain
// their authored order. Compare JSON values, preserving array order and types.
const canonicalJson = (value) => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export const instructionContextBoundary = (hookInput, now = new Date()) => ({
  since: now.toISOString(),
  transcriptHash: typeof hookInput.transcript_path === "string"
    ? sha256(hookInput.transcript_path) : null,
});

/** Only typed argument slots are edited; business content is never traversed. */
export const withoutModelInstructionKeys = (input, identity) => {
  if (identity.status === "native") {
    return REVISION_TOOLS.has(identity.toolName) || LAYER_TOOLS.has(identity.toolName)
      ? strip(input) : input;
  }
  if (!["local", "local_without_native_tool"].includes(identity.status)) return input;
  if (!record(input.parameters)) return input;
  const tool = identity.toolName || input.parameters.nativeTool || input.parameters.operation;
  if (!LOCAL_AUTHORITY_TOOLS.has(tool)) return input;
  const parameters = strip(input.parameters);
  if (record(parameters.arguments)) parameters.arguments = strip(parameters.arguments);
  return { ...input, parameters };
};

export const hasManagedInstructionKeys = (identity, input) => {
  const tool = identity.toolName || input.parameters?.nativeTool || input.parameters?.operation;
  if (["local", "local_without_native_tool"].includes(identity.status)) return LOCAL_AUTHORITY_TOOLS.has(tool);
  return identity.status !== "unrelated" && (REVISION_TOOLS.has(tool) || LAYER_TOOLS.has(tool));
};

export const canInspectInstructionDelivery = (hookInput, identity, environment = process.env) =>
  identity.status === "native" && (REVISION_TOOLS.has(identity.toolName) || LAYER_TOOLS.has(identity.toolName))
  && typeof hookInput.session_id === "string" && typeof hookInput.tool_use_id === "string"
  && typeof hookInput.transcript_path === "string" && path.isAbsolute(hookInput.transcript_path)
  && !hookInput.agent_id && !environment.CLAUDE_CODE_ENTRYPOINT && !environment.CLAUDE_EFFORT && !hookInput.effort;

const callIdentity = (payload) => payload.namespace === "mcp__trelio"
  && (REVISION_TOOLS.has(payload.name) || LAYER_TOOLS.has(payload.name))
  ? payload.name : null;

const parseOutput = (output, metadata) => {
  if (typeof output !== "string") return null;
  // Codex preserves original bytes in rollout even when live history truncates
  // them (core/context_manager/history.rs). In 0.160.0 the *serialized* name of
  // history_truncation_token_limit is fallback_token_limit_override; its budget
  // already includes the tool allowance. utils/string uses exactly 4 UTF-8
  // bytes/token for this no-truncation decision, not a tokenizer estimate.
  const limit = metadata?.fallback_token_limit_override;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > Number.MAX_SAFE_INTEGER / 4
    || Buffer.byteLength(output, "utf8") > limit * 4) return null;
  // This is the exact direct MCP output wrapper observed in Codex 0.160.0.
  // Do not search arbitrary prose/code blocks for JSON: quoted task content
  // must not be mistaken for an authority envelope returned by the tool.
  const prefix = /^Wall time: [0-9.]+ seconds\nOutput:\n/u;
  const text = output.replace(prefix, "");
  try {
    const parsed = JSON.parse(text);
    if (!record(parsed) || parsed.isError === true) return null;
    return record(parsed.structuredContent) ? parsed.structuredContent : parsed;
  } catch { return null; }
};

const revisionReceipt = (payload) => {
  const authority = payload.effectiveInstructions;
  if (record(authority) && authority.status === "loaded"
    && HASH.test(authority.revisionKey || "")
    && typeof authority.workingRules?.compiledMarkdown === "string"
    && (authority.personalProfile === null
      || typeof authority.personalProfile?.compiledMarkdown === "string")) return authority.revisionKey;
  if (HASH.test(payload.instructionRevisionKey || "")
    && typeof payload.effective?.compiledMarkdown === "string"
    && typeof payload.personalProfile?.effective?.compiledMarkdown === "string") return payload.instructionRevisionKey;
  return null;
};

// Scope reuse is deliberately exact per operation/locator. Cross-route aliases
// and encrypted hydration can be added only with their own delivery fixtures.
const requestKey = (tool, args) => JSON.stringify([tool,
  args.companySlug ?? null, args.projectSlug ?? null, args.workspaceId ?? null, args.id ?? null,
]);

const taskLocators = (tool, args) => canonicalJson(
  tool === "get_task" ? [{ companySlug: args.companySlug, projectSlug: args.projectSlug,
    taskNumber: args.taskNumber }] : args.tasks,
);

// A page's final nextExactReadArguments is only a suggestion. Reuse requires
// every original part, its exact manifest and a verified concatenated digest.
// The assembly is in RAM for this inspection only, never a second rule cache.
const acceptInstructionPage = (result, call, pageCatalogs, layers) => {
  const page = pageCatalogs.get(result.catalogRevisionKey);
  if (!page || result.schemaVersion !== 3
    || call.args.expectedCatalogRevisionKey !== result.catalogRevisionKey
    || taskLocators(call.tool, call.args) !== page.locators) return;
  const parts = result.responseKind === "instruction_page_batch" ? result.parts
    : result.responseKind === "instruction_page" ? [result.part] : [];
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    const entry = page.manifest.get(part?.key);
    if (!entry || part.sha256 !== entry.sha256 || part.partCount !== entry.partCount
      || !Number.isInteger(part.partIndex) || part.partIndex < 0 || part.partIndex >= entry.partCount
      || typeof part.markdown !== "string") continue;
    if (entry.parts.has(part.partIndex) && entry.parts.get(part.partIndex) !== part.markdown) {
      // Conflicting duplicate parts poison this layer, even if one variant
      // happened to match the manifest; do not choose a convenient version.
      entry.conflicted = true;
      layers.delete(part.key);
    }
    entry.parts.set(part.partIndex, part.markdown);
    if (!entry.conflicted && entry.parts.size === entry.partCount) {
      const markdown = Array.from({ length: entry.partCount }, (_, index) => entry.parts.get(index)).join("");
      if (sha256(markdown) === entry.sha256) layers.add(part.key);
    }
  }
};

export const collectCodexInstructionHints = ({ rows, header, hookInput, input, identity, boundary }) => {
  if (header?.cli_version !== "0.160.0" || header.id !== hookInput.session_id
    || hookInput.agent_id || !boundary?.transcriptHash
    || boundary.transcriptHash !== sha256(hookInput.transcript_path || "")
    || !Number.isFinite(Date.parse(boundary.since))
    || typeof hookInput.tool_use_id !== "string") return {};
  const layers = new Set();
  const revisions = new Map();
  const pageCatalogs = new Map();
  const calls = new Map();
  let witnessedCurrentCall = false;
  const reset = () => { layers.clear(); revisions.clear(); pageCatalogs.clear(); calls.clear(); };
  for (const row of rows) {
    if (row.type === "session_meta") {
      // A resumed rollout may contain several headers. The original header
      // must never whitelist a later client with different delivery semantics.
      reset();
      if (row.payload?.id !== header.id || row.payload?.cli_version !== header.cli_version) return {};
      continue;
    }
    // No authority is recovered from replacement_history, retained_context or
    // summaries, even when they happen to quote the old full JSON verbatim.
    if (row.type === "compacted" || row.type === "turn_context") { reset(); continue; }
    const time = Date.parse(row.timestamp);
    if (!Number.isFinite(time) || time < Date.parse(boundary.since)) continue;
    if (row.type !== "response_item") continue;
    const payload = row.payload;
    if (!record(payload)) continue;
    if (payload.type === "function_call") {
      const tool = callIdentity(payload);
      if (!tool) continue;
      let args;
      try { args = JSON.parse(payload.arguments); } catch { continue; }
      if (!record(args)) continue;
      if (payload.call_id === hookInput.tool_use_id) {
        witnessedCurrentCall = tool === identity.toolName
          && canonicalJson(strip(args)) === canonicalJson(input);
        break;
      }
      calls.set(payload.call_id, { tool, args });
    } else if (payload.type === "function_call_output") {
      const call = calls.get(payload.call_id);
      calls.delete(payload.call_id);
      if (!call) continue;
      const result = parseOutput(payload.output, row.metadata);
      if (!result) continue;
      if (REVISION_TOOLS.has(call.tool)) {
        const key = revisionReceipt(result);
        if (key) revisions.set(requestKey(call.tool, call.args), key);
      }
      if (call.tool === "get_task_instruction_page") acceptInstructionPage(result, call, pageCatalogs, layers);
      const catalog = result.effectiveInstructions;
      if (!record(catalog) || catalog.schemaVersion !== 3) continue;
      if (catalog.status === "loaded" && Array.isArray(catalog.layers)) {
        for (const layer of catalog.layers) {
          if (LAYER.test(layer?.key || "") && HASH.test(layer.sha256 || "")
            && typeof layer.markdown === "string" && sha256(layer.markdown) === layer.sha256) layers.add(layer.key);
        }
      } else if (catalog.status === "incomplete" && HASH.test(catalog.delivery?.catalogRevisionKey || "")
        && Array.isArray(catalog.reusedLayerKeys)
        && catalog.reusedLayerKeys.every((key) => layers.has(key))) {
        // Pagination's revision includes the ORIGINAL reused set. New receipts
        // during page delivery must not change it, or page offsets would shift.
        const manifest = new Map();
        for (const entry of catalog.delivery.layerManifest ?? []) {
          if (LAYER.test(entry?.key || "") && HASH.test(entry.sha256 || "")
            && Number.isInteger(entry.partCount) && entry.partCount > 0 && entry.partCount <= 2048) {
            manifest.set(entry.key, { ...entry, parts: new Map(), conflicted: false });
          }
        }
        pageCatalogs.set(catalog.delivery.catalogRevisionKey, {
          reused: [...catalog.reusedLayerKeys], manifest, locators: taskLocators(call.tool, call.args),
        });
      }
    }
  }
  if (!witnessedCurrentCall) return {};
  if (identity.toolName === "get_task_instruction_page") {
    const page = pageCatalogs.get(input.expectedCatalogRevisionKey);
    const frozenKeys = page?.locators === taskLocators(identity.toolName, input) ? page.reused : null;
    return frozenKeys?.length ? { knownInstructionLayerKeys: frozenKeys } : {};
  }
  if (LAYER_TOOLS.has(identity.toolName)) {
    const keys = [...layers].slice(-200);
    return keys.length ? { knownInstructionLayerKeys: keys } : {};
  }
  const key = revisions.get(requestKey(identity.toolName, input));
  return key ? { knownInstructionRevisionKey: key } : {};
};

const readCodexTranscript = async (filePath) => {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
  const info = await fs.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== info.ino
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    const head = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    const firstRead = await handle.read(head, 0, head.length, 0);
    if (firstRead.bytesRead !== head.length) return null;
    const headerEnd = head.indexOf(10);
    if (headerEnd < 0) return null;
    const first = JSON.parse(head.subarray(0, headerEnd).toString("utf8"));
    if (first.type !== "session_meta") return null;
    const offset = Math.max(0, stat.size - MAX_BYTES);
    const tail = Buffer.alloc(stat.size - offset);
    const { bytesRead } = await handle.read(tail, 0, tail.length, offset);
    const finalStat = await handle.stat();
    if (bytesRead !== tail.length || tail.at(-1) !== 10 || finalStat.size !== stat.size
      || finalStat.mtimeMs !== stat.mtimeMs || finalStat.ctimeMs !== stat.ctimeMs) return null;
    const lines = tail.toString("utf8").split("\n");
    lines.pop();
    if (offset > 0) lines.shift();
    // A malformed/interrupted record invalidates this inspection; skipping it
    // could miss the very context boundary that invalidated old receipts.
    return { header: first.payload, rows: lines.map((line) => JSON.parse(line)) };
  } finally { await handle.close(); }
};

const inspectInWorker = (options) => new Promise((resolve) => {
  // Optional journal IO/JSON parsing must never use the registration budget or
  // keep the hook waiting on a slow filesystem. A disposable worker allows us
  // to stop parsing and abandon IO without an unbounded main-thread scan.
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: "instruction-delivery", options }, stdout: true, stderr: true,
    env: {},
    // Do not inherit a test runner/loader, preload or inspector into the worker.
    execArgv: [],
  });
  let finished = false;
  const finish = (hints = {}) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    void worker.terminate();
    resolve(hints);
  };
  const timer = setTimeout(finish, INSPECTION_TIMEOUT_MS);
  worker.once("message", finish);
  worker.once("error", () => finish());
  worker.once("exit", () => finish());
});

export const manageInstructionKeys = async ({ hookInput, identity, input, boundary, environment = process.env,
  readTranscript }) => {
  const cleaned = withoutModelInstructionKeys(input, identity);
  // An unknown/Claude client has no proven retention adapter. No waiting for
  // journal flush, auth recovery or client settings changes are allowed here.
  if (!canInspectInstructionDelivery(hookInput, identity, environment)) return cleaned;
  try {
    if (!boundary) return cleaned;
    if (!readTranscript) return { ...cleaned, ...await inspectInWorker({
      hookInput, identity, input: cleaned, boundary,
    }) };
    const snapshot = await readTranscript(hookInput.transcript_path);
    if (!snapshot) return cleaned;
    return { ...cleaned, ...collectCodexInstructionHints({ ...snapshot, hookInput, input: cleaned, identity, boundary }) };
  } catch {
    // Only this optional optimization fails open to a FULL read. The caller's
    // mandatory registration, proof and access checks remain outside this catch.
    return cleaned;
  }
};

if (!isMainThread && workerData?.kind === "instruction-delivery") {
  const options = workerData.options;
  try {
    const snapshot = await readCodexTranscript(options.hookInput.transcript_path);
    parentPort.postMessage(snapshot ? collectCodexInstructionHints({ ...options, ...snapshot }) : {});
  } catch { parentPort.postMessage({}); }
}
