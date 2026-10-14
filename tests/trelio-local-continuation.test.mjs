import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectLocalContinuationArguments, recoverLocalContinuationArguments,
  validateLocalContinuationArguments } from "../host-runtime/scripts/trelio-local-continuation.mjs";
import { handleToolCall } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { attachLocalContextNextCall } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { createLocalSearchSelections } from "../host-runtime/scripts/trelio-search-selection.mjs";
import { validateNativeCheckpoint, assertNativeCheckpointBinding, readNativeCheckpointInput } from "../host-runtime/scripts/trelio-native-checkpoint.mjs";
import { buildTrelioWorkspaceActionInvocation, handleTrelioWorkspaceActionOperation } from "../host-runtime/scripts/trelio-local-context.mjs";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAgentEncryptionDevice, decryptCompanyPayload } from "../host-runtime/scripts/trelio-company-encryption.mjs";
import { protectAgentWorkspaceCheckpoint } from "../host-runtime/scripts/trelio-workspace.mjs";

const now = Date.now();
const timestamp = new Date(now - 1000).toISOString();
const input = { schemaVersion: 1, route: "action", parameters: { companySlug: "demo", nativeTool: "create_task",
  arguments: { companySlug: "demo", projectSlug: "project" },
  nativeCallRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  nativeArgumentKeys: ["companySlug", "projectSlug", "title", "clientRequestId"] } };
const original = { companySlug: "demo", projectSlug: "project", title: "PRIVATE-CONTINUATION-CANARY",
  clientRequestId: "same-idempotency-key", runtimeSessionProof: { nonce: "old-proof" } };
const hookInput = { session_id: "session", tool_use_id: "current", transcript_path: "/synthetic/rollout.jsonl" };
const header = { id: "session", cli_version: "0.162.0-alpha.17.2" };
const call = (id, namespace, name, args) => ({ timestamp, type: "response_item", payload: {
  type: "function_call", call_id: id, namespace, name, arguments: JSON.stringify(args) } });
const result = { code: "MCP_LOCAL_CONTEXT_REQUIRED", providerSelection: { automatic: true,
  provider: "local_company_context", server: "trelio-remote-skills", tool: "continue_trelio_local_action",
  companySlug: "demo", nativeTool: "create_task", arguments: input } };
const output = { timestamp, type: "response_item", metadata: { fallback_token_limit_override: 12000 },
  payload: { type: "function_call_output", call_id: "source",
    output: "Wall time: 0.1 seconds\nOutput:\n" + JSON.stringify(result) } };
const rows = [call("source", "mcp__trelio", "create_task", original), output,
  call("current", "mcp__trelio_remote_skills", "continue_trelio_local_action", input)];
const collect = (changes = {}) => collectLocalContinuationArguments({ header, rows, hookInput, input, now, ...changes });

const nativeCheckpoint = { runId: "11111111-1111-4111-8111-111111111111",
  leaseId: "22222222-2222-4222-8222-222222222222", fencingToken: 2, checkpointType: "analysis",
  summary: "Checkpoint with structured evidence", evidence: [{ source: "test", checked: true }],
  filesChanged: ["artifacts/result.md"], openQuestions: [], nextAction: { instruction: "Review the result" } };

test("encrypted checkpoint keeps JSON evidence and explicit empty nextAction without plaintext transport", async () => {
  const scope = await createAgentEncryptionDevice();
  const device = await createAgentEncryptionDevice();
  const companyEncryption = { device, runtime: { company: { id: nativeCheckpoint.runId, slug: "demo" },
    scope: { id: nativeCheckpoint.leaseId, epoch: 1, publicEncryptionJwk: scope.publicEncryptionJwk },
    device: { id: "33333333-3333-4333-8333-333333333333" } } };
  const originalFetch = globalThis.fetch;
  let uploaded;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://checkpoint.example/api/agent-workspaces/encryption/payloads");
    assert.equal(options.body.includes("PRIVATE-CHECKPOINT-CANARY"), false);
    uploaded = JSON.parse(options.body).payloads[0];
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    for (const nextAction of [{}, { instruction: "" }, { instruction: "Review", taskOutcome: "no_status_change" }]) {
      const protectedContent = await protectAgentWorkspaceCheckpoint({
        metadata: { runId: nativeCheckpoint.runId }, origin: "https://checkpoint.example", token: "synthetic-token",
        companyEncryption, summary: "PRIVATE-CHECKPOINT-CANARY", evidence: [{ checked: true, source: "PRIVATE-CHECKPOINT-CANARY" }],
        filesChanged: [], openQuestions: [], nextActionInstruction: nextAction.instruction ?? "", taskOutcome: "",
        nextActionTaskOutcome: nextAction.taskOutcome ?? null, nextActionProvided: true,
        nextActionInstructionProvided: Object.hasOwn(nextAction, "instruction"),
      });
      const clear = await decryptCompanyPayload({ encryptedPayload: uploaded, scopePrivateKey: scope.privateKeys.encryptionPrivateKey,
        scopePrivateJwk: scope.privateBundle.encryptionPrivateJwk });
      assert.deepEqual(clear.values.evidence_json, [{ checked: true, source: "PRIVATE-CHECKPOINT-CANARY" }]);
      assert.equal(clear.values.next_action_instruction, nextAction.instruction ?? "");
      assert.equal(JSON.stringify(protectedContent).includes("PRIVATE-CHECKPOINT-CANARY"), false);
      assert.deepEqual(Object.keys(protectedContent.nextAction), Object.keys(nextAction));
      assert.equal(protectedContent.nextAction.taskOutcome, nextAction.taskOutcome);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("native checkpoint continuation recovers all fields and enters the same Run-bound bridge", async () => {
  const runIdentity = { workspaceId: "33333333-3333-4333-8333-333333333333", runId: nativeCheckpoint.runId };
  const args = { schemaVersion: 1, route: "workspace", parameters: {
    companySlug: "demo", nativeTool: "checkpoint_agent_workspace_run", operation: "checkpoint_native", runIdentity,
    arguments: { runId: nativeCheckpoint.runId, leaseId: nativeCheckpoint.leaseId, fencingToken: 2, checkpointType: "analysis" },
    nativeCallRef: input.parameters.nativeCallRef, nativeArgumentKeys: Object.keys(nativeCheckpoint),
  } };
  const selection = { code: "MCP_LOCAL_BRIDGE_REQUIRED", providerSelection: {
    automatic: true, provider: "local_agent_workspace_bridge", companySlug: "demo",
    nativeTool: "checkpoint_agent_workspace_run", server: "trelio-remote-skills", tool: "continue_trelio_local_action", arguments: args,
  } };
  const checkpointRows = [call("source", "mcp__trelio", "checkpoint_agent_workspace_run", nativeCheckpoint),
    { ...output, payload: { ...output.payload, output: JSON.stringify({ isError: true, structuredContent: selection }) } },
    call("current", "mcp__trelio_remote_skills", "continue_trelio_local_action", args)];
  const recovered = await recoverLocalContinuationArguments({ hookInput, input: args,
    readTranscript: () => ({ header, rows: checkpointRows }) });
  assert.deepEqual(recovered.parameters.arguments, nativeCheckpoint);
  let passed;
  await handleToolCall("https://trelio.example", "continue_trelio_local_action", recovered, {
    workspaceActionOperation: async (_origin, invocation) => { passed = invocation; return {}; },
  });
  assert.deepEqual(passed, { schemaVersion: 1, operation: "checkpoint", runIdentity, parameters: { nativeInput: nativeCheckpoint } });
  assert.deepEqual(buildTrelioWorkspaceActionInvocation(passed).argumentsList, ["checkpoint", "--native-input"]);
  let processInput;
  await handleTrelioWorkspaceActionOperation("https://trelio.example", passed, {
    resolveRunRootDirectory: async () => "/synthetic/run",
    runBridge: async (_origin, argv, options) => {
      assert.deepEqual(argv, ["checkpoint", "--native-input"]); processInput = options.input; return { stdout: "saved" };
    },
  });
  assert.deepEqual(JSON.parse(processInput), nativeCheckpoint);
  assert.equal(collectLocalContinuationArguments({ header, hookInput, rows: checkpointRows,
    input: { ...args, parameters: { ...args.parameters, runIdentity: { ...runIdentity, runId: nativeCheckpoint.leaseId } } }, now }), null);
});

test("native checkpoint validates exact bounds, JSON evidence and caller lease before IO", async () => {
  assert.deepEqual(await readNativeCheckpointInput(Readable.from([JSON.stringify(nativeCheckpoint)])), nativeCheckpoint);
  const normalized = validateNativeCheckpoint({ ...nativeCheckpoint, summary: "  Result  ",
    filesChanged: ["  artifacts/result.md  "], openQuestions: ["  Question  "] });
  assert.equal(normalized.summary, "Result");
  assert.deepEqual(normalized.filesChanged, ["artifacts/result.md"]);
  assert.deepEqual(normalized.openQuestions, ["Question"]);
  assert.deepEqual(validateNativeCheckpoint({ ...nativeCheckpoint,
    nextAction: { instruction: "Review", taskOutcome: "no_status_change" } }).nextAction,
  { instruction: "Review", taskOutcome: "no_status_change" });
  for (const nextAction of [null, {}, { instruction: "" }]) {
    assert.deepEqual(validateNativeCheckpoint({ ...nativeCheckpoint, nextAction }).nextAction, nextAction);
  }
  assert.equal(validateNativeCheckpoint({ ...nativeCheckpoint, summary: " " + "x".repeat(20000) + " " }).summary.length, 20000);
  const metadata = { ...nativeCheckpoint, baseHead: "a".repeat(40) };
  assert.doesNotThrow(() => assertNativeCheckpointBinding(nativeCheckpoint, metadata));
  for (const patch of [{ leaseId: nativeCheckpoint.runId }, { runId: nativeCheckpoint.leaseId }, { fencingToken: 3 }, { draftHead: "b".repeat(40) }]) {
    assert.throws(() => assertNativeCheckpointBinding({ ...nativeCheckpoint, ...patch }, metadata), { code: "TRELIO_WORKSPACE_CHECKPOINT_BINDING_CHANGED" });
  }
  for (const patch of [{ checkpointType: "unknown" }, { evidence: Array(101).fill({}) },
    { summary: "" }, { nextAction: { privateField: "secret" } }, { runtimeSessionProof: {} },
    { evidence: ["x".repeat(256 * 1024)] }, { evidence: [NaN] }, { evidence: [{ field: undefined }] },
    { openQuestions: Array(101).fill("question") }]) {
    assert.throws(() => validateNativeCheckpoint({ ...nativeCheckpoint, ...patch }), { code: "TRELIO_WORKSPACE_ACTION_INVALID_INPUT" });
  }
});

test("real bridge native stdin rejects a stale lease before auth, writes or upload", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-native-checkpoint-"));
  try {
    const cwd = path.join(dir, "workspace"); await fs.mkdir(cwd);
    const metadataPath = path.join(dir, ".trelio-run.json");
    const metadata = JSON.stringify({ schemaVersion: 3, ...nativeCheckpoint, leaseId: nativeCheckpoint.runId,
      workspaceDirectory: cwd, origin: "https://trelio.example" });
    await fs.writeFile(metadataPath, metadata, { mode: 0o600 });
    const pending = promisify(execFile)(process.execPath, [path.resolve("host-runtime/scripts/trelio-workspace.mjs"), "checkpoint", "--native-input"], {
      cwd, env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: path.join(dir, "codex"),
        LOCALAPPDATA: path.join(dir, "AppData", "Local"), TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
        TRELIO_WORKSPACE_ORIGIN: "https://trelio.example", TRELIO_WORKSPACE_CONFIG_DIRECTORY: path.join(dir, "config") },
    });
    pending.child.stdin.end(JSON.stringify(nativeCheckpoint));
    await assert.rejects(pending, error => {
      assert.match(error.stderr, /TRELIO_WORKSPACE_CHECKPOINT_BINDING_CHANGED/u); return true;
    });
    assert.equal(await fs.readFile(metadataPath, "utf8"), metadata);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("selected search result transfers exact coordinates while normal live read remains in charge", async () => {
  for (const [operation, result, expected] of [
    ["search", { id: "task:demo/project/12", type: "task" }, { id: "task:demo/project/12" }],
    ["search_workspace_files", { workspaceId: nativeCheckpoint.runId, workspaceHead: "a".repeat(40), filePath: "notes/результат.md" },
      { workspaceId: nativeCheckpoint.runId, workspaceHead: "a".repeat(40), filePath: "notes/результат.md" }],
  ]) {
    const search = attachLocalContextNextCall({ provider: "local_company_context", results: [result] }, { operation, companySlug: "demo" }, "https://trelio.example");
    const next = structuredClone(search.nextCall.arguments);
    next.parameters.selectedResultRef = search.results[0].selectionRef;
    let read;
    await handleToolCall("https://trelio.example", "continue_trelio_local_action", next, {
      localContextOperation: async (_origin, request) => { read = request; return { provider: "local_company_context" }; },
    });
    assert.deepEqual(read.arguments, expected);
    let calls = 0;
    await assert.rejects(handleToolCall("https://trelio.example", "continue_trelio_local_action",
      { ...next, parameters: { ...next.parameters, companySlug: "foreign" } }, {
        localContextOperation: async () => { calls++; },
      }), { code: "LOCAL_CONTEXT_SELECTION_STALE" });
    assert.equal(calls, 0);
  }
});

test("selection refs reject expiry, eviction, changed routes and locator overrides without refreshing", () => {
  let time = 0;
  const cache = createLocalSearchSelections({ now: () => time, maximumEntries: 1, ttlMs: 1000 });
  const origin = "https://trelio.example";
  const ref = cache.add({ origin, companySlug: "demo", nativeTool: "fetch", arguments: { id: "task:demo/p/1" } });
  const input = { schemaVersion: 1, route: "context", parameters: {
    companySlug: "demo", nativeTool: "fetch", operation: "native_read", selectedResultRef: ref, arguments: {},
  } };
  assert.deepEqual(cache.resolve(origin, input).parameters.arguments, { id: "task:demo/p/1" });
  assert.equal(cache.resolve(origin, { ...input, parameters: { ...input.parameters, arguments: { responseDetail: "full" } } }).parameters.arguments.responseDetail, "full");
  for (const changed of [{ ...input, route: "action" }, { ...input, parameters: { ...input.parameters, nativeTool: "get_task" } },
    { ...input, parameters: { ...input.parameters, arguments: { id: "task:demo/p/2" } } }]) {
    assert.throws(() => cache.resolve(origin, changed), { code: "LOCAL_CONTEXT_SELECTION_STALE" });
  }
  assert.throws(() => cache.resolve("https://foreign.example", input), { code: "LOCAL_CONTEXT_SELECTION_STALE" });
  time = 1000; assert.throws(() => cache.resolve(origin, input), { code: "LOCAL_CONTEXT_SELECTION_STALE" });
  time = 0; const evicted = cache.add({ origin, companySlug: "demo", nativeTool: "fetch", arguments: { id: "task:demo/p/1" } });
  cache.add({ origin, companySlug: "demo", nativeTool: "fetch", arguments: { id: "task:demo/p/2" } });
  assert.throws(() => cache.resolve(origin, { ...input, parameters: { ...input.parameters, selectedResultRef: evicted } }), { code: "LOCAL_CONTEXT_SELECTION_STALE" });
});

test("exact server continuation recovers original content and preserves idempotency without old proof", async () => {
  assert.deepEqual(collect(), { companySlug: "demo", projectSlug: "project", title: original.title, clientRequestId: original.clientRequestId });
  const recovered = await recoverLocalContinuationArguments({ hookInput, input,
    readTranscript: () => ({ header, rows }) });
  assert.equal(recovered.parameters.nativeCallRef, undefined);
  assert.equal(recovered.parameters.arguments.runtimeSessionProof, undefined);
  let forwarded;
  await handleToolCall("https://trelio.example", "continue_trelio_local_action", recovered, {
    localActionOperation: async (_origin, request) => { forwarded = request; return { content: [] }; },
  });
  assert.deepEqual(forwarded.arguments, collect());
});

test("changed target, operation, current call, session, bounds and context do not recover", () => {
  for (const change of [
    { header: { ...header, id: "other" } }, { header: { ...header, cli_version: "unknown" } },
    { hookInput: { ...hookInput, tool_use_id: "other" } }, { hookInput: { ...hookInput, agent_id: "child" } },
    { now: now + 16 * 60 * 1000 },
    { input: { ...input, route: "context" } },
    { input: { ...input, parameters: { ...input.parameters, companySlug: "other" } } },
    { input: { ...input, parameters: { ...input.parameters, arguments: { companySlug: "demo", projectSlug: "other" } } } },
    { rows: [rows[0], output, { type: "compacted" }, rows[2]] },
    { rows: [rows[0], output, { type: "turn_context" }, rows[2]] },
    { rows: [rows[0], { ...output, metadata: { fallback_token_limit_override: 1 } }, rows[2]] },
    { rows: [rows[0], { ...output, payload: { ...output.payload, success: false } }, rows[2]] },
    { rows: [rows[0], output, rows[0], output, rows[2]] },
  ]) assert.equal(collect(change), null, JSON.stringify(change));
});

test("unresolved input fails before invoking any provider; explicit and old calls remain usable", async () => {
  let calls = 0;
  const options = { localActionOperation: async () => { calls++; return { content: [] }; } };
  await assert.rejects(handleToolCall("https://trelio.example", "continue_trelio_local_action", input, options),
    { code: "LOCAL_CONTEXT_INVALID_INPUT" });
  assert.equal(calls, 0);
  const args = { companySlug: "demo", projectSlug: "project", title: original.title, clientRequestId: original.clientRequestId };
  await handleToolCall("https://trelio.example", "continue_trelio_local_action",
    { ...input, parameters: { ...input.parameters, arguments: args } }, options);
  await handleToolCall("https://trelio.example", "continue_trelio_local_action",
    { schemaVersion: 1, route: "action", parameters: { companySlug: "demo", nativeTool: "create_task", arguments: args } }, options);
  assert.equal(calls, 2);
  assert.throws(() => validateLocalContinuationArguments({ ...input, parameters: {
    ...input.parameters, arguments: { ...args, companySlug: "other" } } }), { code: "LOCAL_CONTEXT_INVALID_INPUT" });
});

test("production bounded worker uses only its exact owner transcript, rejecting symlinks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-continuation-test-"));
  try {
    const transcript = path.join(dir, "rollout.jsonl");
    const hook = { ...hookInput, transcript_path: transcript };
    await fs.writeFile(transcript, [JSON.stringify({ type: "session_meta", payload: header }),
      ...rows.map((row) => JSON.stringify(row))].join("\n") + "\n", { mode: 0o600 });
    const recovered = await recoverLocalContinuationArguments({ hookInput: hook, input });
    assert.equal(recovered.parameters.arguments.title, original.title);
    const linked = path.join(dir, "link.jsonl");
    await fs.symlink(transcript, linked);
    assert.deepEqual(await recoverLocalContinuationArguments({ hookInput: { ...hook, transcript_path: linked }, input }), input);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
