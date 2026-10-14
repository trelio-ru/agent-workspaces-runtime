import { isUtf8 } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
// Native MCP and CLI checkpoint payloads have different wire shapes. Keep the
// conversion explicit: arbitrary evidence remains JSON, not "[object Object]",
// and caller lease/head are checked before the bridge can upload a draft.
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const types = new Set(["research", "analysis", "draft", "decision", "artifact", "blocker", "handoff"]);
const outcomes = new Set(["work_completed", "review_passed", "direct_completion", "no_status_change"]);
export const NATIVE_CHECKPOINT_MAX_BYTES = 256 * 1024;
export class NativeCheckpointError extends Error {
  constructor(code = "TRELIO_WORKSPACE_ACTION_INVALID_INPUT") {
    super(code === "TRELIO_WORKSPACE_CHECKPOINT_BINDING_CHANGED"
      ? "Native checkpoint Run, lease or draft changed. Reopen the exact Run before deciding whether to retry."
      : "Invalid native checkpoint input. No checkpoint was dispatched.");
    this.code = code;
  }
  toJSON() { return { code: this.code, message: this.message }; }
}
const fail = () => { throw new NativeCheckpointError(); };
export const parseNativeCheckpointError = stderr => {
  if (typeof stderr !== "string" || stderr.length > 1000 || !stderr.trim().startsWith("Ошибка: ")) return null;
  try {
    const value = JSON.parse(stderr.trim().slice("Ошибка: ".length));
    if (!record(value) || Object.keys(value).length !== 2
      || !["TRELIO_WORKSPACE_ACTION_INVALID_INPUT", "TRELIO_WORKSPACE_CHECKPOINT_BINDING_CHANGED"].includes(value.code)) return null;
    const error = new NativeCheckpointError(value.code);
    return value.message === error.message ? error : null;
  } catch { return null; }
};
const string = (value, maximum) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const strings = (value, maximumItems, maximumLength) => value === undefined
  || Array.isArray(value) && value.length <= maximumItems && value.every(item => string(item, maximumLength));

export const validateNativeCheckpoint = input => {
  const allowed = new Set(["runId", "leaseId", "fencingToken", "checkpointType", "summary",
    "evidence", "filesChanged", "openQuestions", "nextAction", "taskOutcome", "draftHead"]);
  if (!record(input) || Object.keys(input).some(key => !allowed.has(key))
    || !uuid.test(input.runId || "") || !uuid.test(input.leaseId || "")
    || !Number.isSafeInteger(input.fencingToken) || input.fencingToken <= 0
    || !types.has(input.checkpointType) || !string(input.summary, 20000)
    || input.evidence !== undefined && (!Array.isArray(input.evidence) || input.evidence.length > 100)
    || !strings(input.filesChanged, 5000, 2048) || !strings(input.openQuestions, 100, 5000)
    || input.taskOutcome !== undefined && !outcomes.has(input.taskOutcome)
    || input.draftHead !== undefined && !/^[0-9a-f]{40,64}$/u.test(input.draftHead)) fail();
  if (input.nextAction !== undefined && input.nextAction !== null) {
    if (!record(input.nextAction) || Object.keys(input.nextAction).some(key => !["instruction", "taskOutcome"].includes(key))
      || input.nextAction.instruction !== undefined && !string(input.nextAction.instruction, 20000)
      || input.nextAction.taskOutcome !== undefined && !outcomes.has(input.nextAction.taskOutcome)
      || input.nextAction.taskOutcome !== undefined && input.nextAction.taskOutcome !== input.taskOutcome) fail();
  }
  // JSON round-trip is the transport boundary. Reject oversized/non-JSON input
  // before registry/process access, rather than silently dropping object leaves.
  let wire;
  try { wire = JSON.stringify(input); } catch { fail(); }
  if (Buffer.byteLength(wire, "utf8") > NATIVE_CHECKPOINT_MAX_BYTES
    || !isDeepStrictEqual(input, JSON.parse(wire))) fail();
  // Match the native Zod trim boundary locally. The encrypted REST receiver
  // sees array markers and cannot normalize the plaintext leaves afterwards.
  return { ...input, summary: input.summary.trim(),
    ...(input.filesChanged !== undefined ? { filesChanged: input.filesChanged.map(value => value.trim()) } : {}),
    ...(input.openQuestions !== undefined ? { openQuestions: input.openQuestions.map(value => value.trim()) } : {}) };
};

export const assertNativeCheckpointBinding = (input, metadata) => {
  if (input.runId !== metadata.runId || input.leaseId !== metadata.leaseId
    || input.fencingToken !== metadata.fencingToken
    || input.draftHead !== undefined && input.draftHead !== (metadata.draftHead ?? metadata.baseHead)) {
    throw new NativeCheckpointError("TRELIO_WORKSPACE_CHECKPOINT_BINDING_CHANGED");
  }
};

export const readNativeCheckpointInput = async stream => {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > NATIVE_CHECKPOINT_MAX_BYTES) fail();
    chunks.push(bytes);
  }
  let input;
  const bytes = Buffer.concat(chunks);
  if (!isUtf8(bytes)) fail();
  try { input = JSON.parse(bytes.toString("utf8")); } catch { fail(); }
  return validateNativeCheckpoint(input);
};
