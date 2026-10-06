import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectCodexInstructionHints, hasManagedInstructionKeys, instructionContextBoundary, manageInstructionKeys,
  withoutModelInstructionKeys,
} from "../host-runtime/scripts/trelio-instruction-reuse.mjs";
import { resolveTrelioHookToolIdentity } from "../host-runtime/scripts/trelio-hook-tool-identity.mjs";

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const timestamp = "2026-10-06T10:00:01.000Z";
const hookInput = { session_id: "session-1", transcript_path: "/synthetic/rollout.jsonl", tool_use_id: "current" };
const boundary = instructionContextBoundary(hookInput, new Date("2026-10-06T10:00:00.000Z"));
const header = { id: hookInput.session_id, cli_version: "0.160.0" };
const input = { companySlug: "test", projectSlug: "one", taskNumber: 1 };
const identity = { status: "native", toolName: "get_task" };
const layer = { key: "instruction-layer:" + hash("layer"), sha256: hash("Complete rules"), markdown: "Complete rules" };
const catalog = { effectiveInstructions: { schemaVersion: 3, status: "loaded", layers: [layer], reusedLayerKeys: [] } };
const row = (payload, type = "response_item") => ({ timestamp, type, payload });
const call = (callId, tool = "get_task", args = input) => row({
  type: "function_call", namespace: "mcp__trelio", name: tool, call_id: callId, arguments: JSON.stringify(args),
});
const output = (callId, data) => ({ ...row({
  type: "function_call_output", call_id: callId, output: "Wall time: 0.12 seconds\nOutput:\n" + JSON.stringify(data),
}), metadata: { fallback_token_limit_override: 12000 } });
const rows = () => [call("first"), output("first", catalog), call("current")];
const collect = (changes = {}) => collectCodexInstructionHints({
  rows: rows(), header, hookInput, input, identity, boundary, ...changes,
});

const localInput = (tool = "get_task", args = input, companySlug = "test") => ({
  schemaVersion: 1, route: "context", parameters: {
    operation: "native_read", nativeTool: tool, companySlug, arguments: args,
  },
});
const localCall = (id, envelope = localInput()) => row({ type: "function_call",
  namespace: "mcp__trelio_remote_skills", name: "continue_trelio_local_action",
  call_id: id, arguments: JSON.stringify(envelope),
});
// Exact unstructured MCP serialization from Codex 0.160.0 protocol/models.rs.
// The local dispatcher emits one JSON text block after ACL/hydration.
const localOutput = (id, data) => ({ ...row({ type: "function_call_output", call_id: id,
  output: [{ type: "input_text", text: JSON.stringify(data) }],
}), metadata: { fallback_token_limit_override: 12000 } });
const localIdentity = (envelope) => resolveTrelioHookToolIdentity({
  tool_name: "mcp__trelio_remote_skills__continue_trelio_local_action", tool_input: envelope,
});

test("direct local hydrated layers are injected only into exact native_read arguments", async () => {
  for (const tool of ["get_task", "get_tasks", "fetch", "get_workspace", "get_contact", "get_registry",
    "get_meeting", "get_knowledge_base_page"]) {
    const envelope = localInput(tool);
    const local = localIdentity(envelope);
    const sequence = [localCall("first", envelope), localOutput("first", catalog), localCall("current", envelope)];
    const result = await manageInstructionKeys({ hookInput, identity: local, input: envelope,
      boundary, environment: {}, readTranscript: () => ({ header, rows: sequence }) });
    assert.deepEqual(result, { ...envelope, parameters: { ...envelope.parameters,
      arguments: { ...input, knownInstructionLayerKeys: [layer.key] } } });
    assert.equal(result.parameters.nativeTool, tool);
    assert.equal(result.parameters.knownInstructionLayerKeys, undefined);
  }
});

test("local delivery never borrows native, another company, route or envelope receipts", () => {
  const envelope = localInput();
  const options = { input: envelope, identity: localIdentity(envelope) };
  const badRoute = { ...envelope, route: "action" };
  const badOperation = { ...envelope, parameters: { ...envelope.parameters, operation: "get_task" } };
  for (const pair of [
    [call("first"), output("first", catalog)],
    [localCall("first", localInput("get_task", input, "other")), localOutput("first", catalog)],
    [localCall("first", badRoute), localOutput("first", catalog)],
    [localCall("first", badOperation), localOutput("first", catalog)],
  ]) assert.deepEqual(collect({ ...options, rows: [...pair, localCall("current")] }), {});
  assert.deepEqual(collect({ ...options, rows: [localCall("first"), localOutput("first", catalog),
    localCall("current", localInput("get_task", { ...input, taskNumber: 2 }))] }), {});
  assert.deepEqual(collect({ rows: [localCall("first"), localOutput("first", catalog), call("current")] }), {});
});

test("local mixed text, errors, truncation, quoted catalogs and context resets cannot grant reuse", () => {
  const envelope = localInput();
  const options = { input: envelope, identity: localIdentity(envelope) };
  const full = localOutput("first", catalog);
  for (const candidate of [
    { ...full, metadata: undefined }, { ...full, metadata: { fallback_token_limit_override: 1 } },
    { ...full, payload: { ...full.payload, success: false } },
    localOutput("first", { notes: catalog }), localOutput("first", { ...catalog, isError: true }),
    { ...full, payload: { ...full.payload, output: [...full.payload.output, { type: "input_text", text: "extra" }] } },
    { ...full, payload: { ...full.payload, output: [{ type: "input_text", text: "```json\n" + JSON.stringify(catalog) + "\n```" }] } },
    { ...full, payload: { ...full.payload, output: [{ type: "input_text", text: JSON.stringify(catalog), annotations: {} }] } },
  ]) assert.deepEqual(collect({ ...options, rows: [localCall("first"), candidate, localCall("current")] }), {});
  for (const type of ["compacted", "turn_context"]) {
    assert.deepEqual(collect({ ...options, rows: [localCall("first"), full,
      row({}, type), localCall("current")] }), {});
  }
});

test("local pagination retains the original reuse set and validates complete part digests", () => {
  const revision = hash("local-page");
  const initial = { effectiveInstructions: { schemaVersion: 3, status: "incomplete", layers: [],
    reusedLayerKeys: [], delivery: { catalogRevisionKey: revision,
      layerManifest: [{ ...layer, markdown: undefined, partCount: 2 }] } } };
  const pageInput = localInput("get_task_instruction_page", {
    tasks: [input], expectedCatalogRevisionKey: revision, pageIndex: 0,
  });
  const page = { schemaVersion: 3, responseKind: "instruction_page_batch", catalogRevisionKey: revision,
    parts: ["Complete ", "rules"].map((markdown, partIndex) => ({
      key: layer.key, sha256: layer.sha256, partCount: 2, partIndex, markdown,
    })) };
  const prefix = [localCall("first"), localOutput("first", initial),
    localCall("page", pageInput), localOutput("page", page)];
  assert.deepEqual(collect({ input: localInput(), identity: localIdentity(localInput()),
    rows: [...prefix, localCall("current")] }), { knownInstructionLayerKeys: [layer.key] });
  // Reading pages grants future exact-read receipts, but cannot alter the
  // original empty reused set (and therefore the current catalog/page offsets).
  assert.deepEqual(collect({ input: pageInput, identity: localIdentity(pageInput),
    rows: [...prefix, localCall("current", pageInput)] }), {});
});

test("direct complete delivered catalog is reused without model-authored hints", () => {
  assert.deepEqual(collect(), { knownInstructionLayerKeys: [layer.key] });
  assert.deepEqual(collect({ input: { taskNumber: 1, projectSlug: "one", companySlug: "test" } }),
    { knownInstructionLayerKeys: [layer.key] });
});

test("unknown version, session, agent, boundary and unflushed current call cannot grant reuse", () => {
  for (const changes of [
    { header: { ...header, cli_version: "0.161.0" } },
    { header: { ...header, id: "other" } },
    { hookInput: { ...hookInput, agent_id: "child" } },
    { hookInput: { ...hookInput, tool_use_id: "not-flushed" } },
    { boundary: null },
    { boundary: instructionContextBoundary(hookInput, new Date("2026-10-06T10:00:02.000Z")) },
    { boundary: { ...boundary, transcriptHash: hash("other") } },
  ]) assert.deepEqual(collect(changes), {});
});

test("raw events, Code Mode results, quoted JSON and truncated output never count as delivery", () => {
  const raw = row({ type: "McpToolCall", result: catalog }, "event_msg");
  const codeMode = row({ type: "custom_tool_call_output", call_id: "first", output: JSON.stringify(catalog) });
  const truncated = output("first", catalog);
  truncated.payload.output = truncated.payload.output.slice(0, -4) + "[truncated]";
  for (const candidate of [raw, codeMode, truncated, output("first", { notes: catalog }),
    output("first", { ...catalog, isError: true })]) {
    assert.deepEqual(collect({ rows: [call("first"), candidate, call("current")] }), {});
  }
});

test("complete rollout JSON is rejected when the live model history truncated it", () => {
  for (const metadata of [undefined, {}, { fallback_token_limit_override: 0 },
    { fallback_token_limit_override: 1 }, { fallback_token_limit_override: "12000" }]) {
    const fullOnDisk = { ...output("first", catalog), metadata };
    assert.deepEqual(collect({ rows: [call("first"), fullOnDisk, call("current")] }), {});
  }
});

test("compaction and a new turn discard old receipts, including a full copy in the summary", () => {
  for (const type of ["compacted", "turn_context"]) {
    assert.deepEqual(collect({ rows: [
      call("first"), output("first", catalog),
      row({ replacement_history: [output("first", catalog)] }, type), call("current"),
    ] }), {});
  }
});

test("partial catalogs and incorrect content hashes are not full instruction layers", () => {
  for (const bad of [
    { ...catalog.effectiveInstructions, status: "incomplete" },
    { ...catalog.effectiveInstructions, layers: [{ ...layer, markdown: "only a fragment" }] },
    { ...catalog.effectiveInstructions, layers: [], reusedLayerKeys: [layer.key] },
  ]) assert.deepEqual(collect({ rows: [call("first"), output("first", { effectiveInstructions: bad }), call("current")] }), {});
});

test("same-shaped output from another MCP namespace is not Trelio authority", () => {
  const otherCall = call("first");
  otherCall.payload.namespace = "mcp__other";
  assert.deepEqual(collect({ rows: [otherCall, output("first", catalog), call("current")] }), {});
});

test("pagination freezes the original reuse set rather than newly delivered layers", () => {
  const revision = hash("page-catalog");
  const pageInput = { tasks: [input], expectedCatalogRevisionKey: revision, pageIndex: 0 };
  const secondLayer = { key: "instruction-layer:" + hash("second"), markdown: "Second", sha256: hash("Second") };
  const sequence = [call("first"), output("first", catalog), call("paged"), output("paged", {
    effectiveInstructions: { schemaVersion: 3, status: "incomplete", layers: [],
      reusedLayerKeys: [layer.key], delivery: { catalogRevisionKey: revision } },
  }), call("another"), output("another", { effectiveInstructions: {
    schemaVersion: 3, status: "loaded", layers: [secondLayer], reusedLayerKeys: [],
  } }), call("current", "get_task_instruction_page", pageInput)];
  assert.deepEqual(collect({ rows: sequence, input: pageInput,
    identity: { status: "native", toolName: "get_task_instruction_page" } }), { knownInstructionLayerKeys: [layer.key] });
});

test("paged authority needs all manifest parts and their concatenated hash", () => {
  const revision = hash("paged");
  const textParts = ["Complete ", "rules"];
  const begin = { effectiveInstructions: { schemaVersion: 3, status: "incomplete", layers: [],
    reusedLayerKeys: [], delivery: { catalogRevisionKey: revision,
      layerManifest: [{ ...layer, markdown: undefined, partCount: 2 }] } } };
  const pageInput = { tasks: [input], expectedCatalogRevisionKey: revision, pageIndex: 0 };
  const part = (partIndex, markdown = textParts[partIndex]) => ({
    key: layer.key, sha256: layer.sha256, partCount: 2, partIndex, markdown,
  });
  const page = (parts) => ({ schemaVersion: 3, responseKind: "instruction_page_batch",
    catalogRevisionKey: revision, parts, nextPageIndex: null,
    nextExactReadArguments: { knownInstructionLayerKeys: [layer.key] } });
  for (const [parts, expected] of [
    [[part(0), part(1)], [layer.key]], [[part(1)], []],
    [[part(0), part(1, "wrong")], []], [[part(0), part(1), part(1, "conflict")], []],
  ]) {
    const hints = collect({ rows: [call("initial"), output("initial", begin),
      call("page", "get_task_instruction_page", pageInput), output("page", page(parts)), call("current")] });
    assert.deepEqual(hints.knownInstructionLayerKeys ?? [], expected);
  }
  // Last-page hints without the original manifest cannot grant any authority.
  assert.deepEqual(collect({ rows: [
    call("page", "get_task_instruction_page", pageInput), output("page", page([part(0), part(1)])),
    call("current"),
  ] }), {});
});

test("a resumed journal from an unknown client cannot reuse the first header's compatibility", () => {
  assert.deepEqual(collect({ rows: [
    row({ ...header, cli_version: "0.161.0" }, "session_meta"), ...rows(),
  ] }), {});
});

test("bounded on-disk adapter handles complete, partial, oversized and absent journals", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-instruction-reuse-"));
  const file = path.join(directory, "rollout.jsonl");
  const diskHook = { ...hookInput, transcript_path: file };
  const diskBoundary = instructionContextBoundary(diskHook, new Date(boundary.since));
  const headerLine = JSON.stringify(row(header, "session_meta")) + "\n";
  const body = rows().map((item) => JSON.stringify(item)).join("\n") + "\n";
  const inspect = () => manageInstructionKeys({ hookInput: diskHook, identity,
    input: { ...input, knownInstructionLayerKeys: ["model-authored"] },
    boundary: diskBoundary, environment: {} });
  try {
    await fs.writeFile(file, headerLine + body);
    assert.deepEqual(await inspect(), { ...input, knownInstructionLayerKeys: [layer.key] });
    for (const invalid of [
      headerLine + body.slice(0, -1), // A still-being-written final record.
      headerLine + "{broken record}\n" + body,
      headerLine + rows().slice(0, 2).map((item) => JSON.stringify(item)).join("\n") + "\n"
        + JSON.stringify(row({ text: "x".repeat(2 * 1024 * 1024) }, "event_msg")) + "\n"
        + JSON.stringify(call("current")) + "\n", // The old authority is outside the bounded tail.
    ]) {
      await fs.writeFile(file, invalid);
      assert.deepEqual(await inspect(), input);
    }
    await fs.rm(file);
    assert.deepEqual(await inspect(), input);
    if (process.platform !== "win32") {
      const target = path.join(directory, "target.jsonl");
      await fs.writeFile(target, headerLine + body);
      await fs.symlink(target, file);
      assert.deepEqual(await inspect(), input);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("whole revision reuse requires both full rules and profile for the exact locator", () => {
  const tool = "get_project_meta";
  const args = { companySlug: "test", projectSlug: "one" };
  const revision = hash("revision");
  const full = { effectiveInstructions: { status: "loaded", revisionKey: revision,
    workingRules: { compiledMarkdown: "Rules" }, personalProfile: { compiledMarkdown: "Profile" } } };
  const options = { input: args, identity: { status: "native", toolName: tool } };
  const sequence = [call("first", tool, args), output("first", full), call("current", tool, args)];
  assert.deepEqual(collect({ ...options, rows: sequence }), { knownInstructionRevisionKey: revision });
  const missingProfile = structuredClone(full);
  delete missingProfile.effectiveInstructions.personalProfile.compiledMarkdown;
  assert.deepEqual(collect({ ...options, rows: [call("first", tool, args), output("first", missingProfile), call("current", tool, args)] }), {});
  const otherArgs = { ...args, projectSlug: "two" };
  assert.deepEqual(collect({ ...options, input: otherArgs,
    rows: [...sequence.slice(0, -1), call("current", tool, otherArgs)] }), {});
});

test("Claude tool-output clearing and delayed journal always retain the full-read fallback", async () => {
  for (const environment of [{ CLAUDE_CODE_ENTRYPOINT: "desktop" }, { CLAUDE_EFFORT: "high" }]) {
    const result = await manageInstructionKeys({
      hookInput, identity, input: { ...input, knownInstructionLayerKeys: [layer.key] }, boundary, environment,
      readTranscript: () => { throw new Error("Must not inspect Claude as Codex"); },
    });
    assert.deepEqual(result, input);
  }
});

test("optimizer errors discard authored hints and preserve all business arguments", async () => {
  const result = await manageInstructionKeys({
    hookInput, identity, input: { ...input, knownInstructionLayerKeys: [layer.key] }, boundary, environment: {},
    readTranscript: () => { throw new Error("Unavailable journal"); },
  });
  assert.deepEqual(result, input);
});

test("encrypted local envelope removes hints only from argument slots, preserving content and proof", () => {
  const content = { knownInstructionLayerKeys: ["ordinary document data"] };
  const envelope = { schemaVersion: 1, route: "context", runtimeSessionProof: { signature: "untouched" },
    parameters: { operation: "native_read", nativeTool: "get_task",
      arguments: { ...input, knownInstructionLayerKeys: [layer.key], content } } };
  const result = withoutModelInstructionKeys(envelope, { status: "local", toolName: "get_task" });
  assert.equal(result.parameters.arguments.knownInstructionLayerKeys, undefined);
  assert.equal(result.parameters.arguments.content, content);
  assert.equal(result.runtimeSessionProof, envelope.runtimeSessionProof);
});

test("local domain reads cannot suppress authority with model-authored hints", async () => {
  for (const toolName of ["get_knowledge_base_page", "get_contact", "get_registry", "get_meeting"]) {
    const identity = { status: "local", toolName };
    const business = { filters: { knownInstructionRevisionKey: "ordinary filter data" } };
    const envelope = { schemaVersion: 1, route: "context", parameters: {
      operation: "native_read", nativeTool: toolName, knownInstructionLayerKeys: [layer.key],
      arguments: { ...business, knownInstructionLayerKeys: [layer.key], knownInstructionRevisionKey: hash("rules") },
    } };
    assert.equal(hasManagedInstructionKeys(identity, envelope), true);
    const cleaned = await manageInstructionKeys({ hookInput, identity, input: envelope, boundary,
      readTranscript: () => { throw new Error("Unavailable local delivery evidence keeps the full read"); } });
    assert.deepEqual(cleaned.parameters.arguments, business);
    assert.equal(cleaned.parameters.knownInstructionLayerKeys, undefined);
    assert.equal(cleaned.parameters.nativeTool, toolName);
  }
  const mutation = { parameters: { nativeTool: "update_registry_definition",
    arguments: { knownInstructionLayerKeys: ["ordinary data"] } } };
  const identity = { status: "local", toolName: "update_registry_definition" };
  assert.equal(hasManagedInstructionKeys(identity, mutation), false);
  assert.equal(withoutModelInstructionKeys(mutation, identity), mutation);
});
