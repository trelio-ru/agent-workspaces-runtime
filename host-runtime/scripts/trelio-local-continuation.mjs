import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readCodexTranscript, parseCodexMcpOutput } from "./trelio-instruction-reuse.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const canonical = (value) => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const clean = (args) => Object.fromEntries(Object.entries(args).filter(([key]) =>
  !["runtimeSessionProof", "knownInstructionRevisionKey", "knownInstructionLayerKeys", "knownInstructionKey"].includes(key)));
const missing = (input) => Array.isArray(input.parameters?.nativeArgumentKeys)
  && input.parameters.nativeArgumentKeys.some((key) => !Object.hasOwn(input.parameters.arguments ?? {}, key));
// These two serializations were verified against direct MCP call/result rows.
// Unknown clients keep explicit input rather than heuristic journal parsing.
const SUPPORTED_CODEX = new Set(["0.160.0", "0.162.0-alpha.17.2"]);

/** A ref is only correlation, never execution authority or a request cache. */
export const collectLocalContinuationArguments = ({ header, rows, hookInput, input, now = Date.now() }) => {
  if (!SUPPORTED_CODEX.has(header?.cli_version) || header.id !== hookInput.session_id || hookInput.agent_id
    || typeof hookInput.tool_use_id !== "string" || !uuid.test(input.parameters?.nativeCallRef || "")) return null;
  const calls = new Map();
  let candidate = null;
  let duplicates = false;
  for (const row of rows) {
    // A continuation cannot borrow a call from another turn or a summary. It
    // must still exist as an actual native call/result pair in this transcript.
    if (["compacted", "turn_context", "session_meta"].includes(row.type)) {
      if (row.type === "session_meta" && (row.payload?.id !== header.id
        || row.payload?.cli_version !== header.cli_version)) return null;
      calls.clear(); candidate = null; duplicates = false; continue;
    }
    if (row.type !== "response_item" || !record(row.payload)) continue;
    const p = row.payload;
    if (p.type === "function_call") {
      let args;
      try { args = JSON.parse(p.arguments); } catch { continue; }
      if (!record(args)) continue;
      if (p.call_id === hookInput.tool_use_id) {
        const sameCall = p.namespace === "mcp__trelio_remote_skills" && p.name === "continue_trelio_local_action"
          && canonical(clean(args)) === canonical(clean(input));
        return sameCall && !duplicates ? candidate : null;
      }
      if (p.namespace === "mcp__trelio" && p.name === input.parameters.nativeTool) {
        calls.set(p.call_id, args);
      }
    } else if (p.type === "function_call_output") {
      const original = calls.get(p.call_id);
      calls.delete(p.call_id);
      if (!original || p.success === false) continue;
      const result = parseCodexMcpOutput(p.output, row.metadata, true);
      const selection = result?.providerSelection;
      const envelope = selection?.arguments;
      const age = now - Date.parse(row.timestamp);
      if (result?.code !== "MCP_LOCAL_CONTEXT_REQUIRED" || selection?.automatic !== true
        || selection.provider !== "local_company_context" || selection.server !== "trelio-remote-skills"
        || selection.tool !== "continue_trelio_local_action" || selection.nativeTool !== input.parameters.nativeTool
        || selection.companySlug !== input.parameters.companySlug || envelope?.schemaVersion !== 1
        || envelope.route !== input.route || !Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000
        || envelope.parameters?.nativeCallRef !== input.parameters.nativeCallRef) continue;
      // Require the complete server-selected routing fields and unchanged
      // structural seed. A lookalike ref, changed target/operation, or duplicate
      // receipt cannot choose a convenient source for a mutation.
      const { arguments: seed, ...route } = envelope.parameters;
      const { arguments: supplied, ...requested } = input.parameters;
      if (!record(seed) || !record(supplied) || canonical(route) !== canonical(requested)) return null;
      const authored = clean(original);
      if (authored.companySlug !== undefined && (typeof authored.companySlug !== "string"
        || authored.companySlug.trim() !== selection.companySlug)) return null;
      if (Array.isArray(authored.companySlugs) && (authored.companySlugs.length !== 1
        || authored.companySlugs[0] !== selection.companySlug)) return null;
      if (!Array.isArray(route.nativeArgumentKeys)
        || Object.keys(authored).some((key) => !route.nativeArgumentKeys.includes(key))) return null;
      // SDK schemas may insert defaults or trim structural locators before the
      // server builds its seed. Keep those reviewed values, while recovering
      // the original optional content and letting native validation reapply
      // any remaining defaults. Never invent missing protected content.
      const recovered = { ...authored, ...seed };
      for (const [key, value] of Object.entries(seed)) {
        if (!Object.hasOwn(authored, key)) continue;
        const sourceValue = typeof authored[key] === "string" ? authored[key].trim() : authored[key];
        if (canonical(value) !== canonical(sourceValue)) return null;
      }
      for (const [key, value] of Object.entries(supplied)) {
        if (canonical(value) !== canonical(recovered[key])) return null;
      }
      if (candidate) duplicates = true;
      candidate = recovered;
    }
  }
  return null;
};

const inspect = (options) => new Promise((resolve) => {
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: "local-continuation", options },
    stdout: true, stderr: true, env: {}, execArgv: [] });
  let finished = false;
  const finish = (result = null) => {
    if (finished) return;
    finished = true; clearTimeout(timer); void worker.terminate(); resolve(result);
  };
  const timer = setTimeout(finish, 250);
  worker.once("message", finish); worker.once("error", () => finish()); worker.once("exit", () => finish());
});

export const recoverLocalContinuationArguments = async ({ hookInput, input, readTranscript }) => {
  if (!missing(input)) return input;
  // Unsupported clients preserve explicit argument transport. They never read
  // another client's journal or create a plaintext fallback/cache.
  if (!uuid.test(input.parameters?.nativeCallRef || "") || !path.isAbsolute(hookInput.transcript_path || "")
    || hookInput.agent_id || hookInput.effort || process.env.CLAUDE_CODE_ENTRYPOINT) return input;
  let recovered;
  try {
    if (readTranscript) {
      const snapshot = await readTranscript(hookInput.transcript_path);
      recovered = snapshot && collectLocalContinuationArguments({ ...snapshot, hookInput, input });
    } else recovered = await inspect({ hookInput, input });
  } catch { return input; }
  if (!record(recovered)) return input;
  const { nativeCallRef: _ref, nativeArgumentKeys: _keys, ...parameters } = input.parameters;
  return { ...input, parameters: { ...parameters, arguments: recovered } };
};

export const validateLocalContinuationArguments = (input) => {
  const parameters = input.parameters;
  if (parameters?.nativeArgumentKeys !== undefined && (!Array.isArray(parameters.nativeArgumentKeys)
    || parameters.nativeArgumentKeys.length > 64 || parameters.nativeArgumentKeys.some((key) =>
      typeof key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/u.test(key)))) {
    throw Object.assign(new Error("Invalid local continuation descriptor."), { code: "LOCAL_CONTEXT_INVALID_INPUT" });
  }
  if (missing(input)) throw Object.assign(new Error("The original local request is unavailable. Supply its complete original arguments, or obtain a fresh server-selected continuation for a read. No local action was dispatched."),
    { code: "LOCAL_CONTEXT_INVALID_INPUT" });
  if (parameters?.arguments?.companySlug !== undefined && parameters.arguments.companySlug !== parameters.companySlug) {
    throw Object.assign(new Error("Local continuation company does not match its native request."), { code: "LOCAL_CONTEXT_INVALID_INPUT" });
  }
};

if (!isMainThread && workerData?.kind === "local-continuation") {
  try {
    const options = workerData.options;
    const snapshot = await readCodexTranscript(options.hookInput.transcript_path);
    parentPort.postMessage(snapshot ? collectLocalContinuationArguments({ ...options, ...snapshot }) : null);
  } catch { parentPort.postMessage(null); }
}
