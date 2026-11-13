import assert from "node:assert/strict";
import test from "node:test";
import { createCodexMcpHandler, handleToolCall } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { buildTrelioBootstrapVerification } from "../host-runtime/scripts/trelio-installation-diagnostic.mjs";
import { TrelioApiError } from "../host-runtime/scripts/trelio-workspace.mjs";
import {
  cleanNativeRuntimeToolArguments, observeCodexMcpTurn, prepareCodexMcpToolArguments,
} from "../host-runtime/scripts/trelio-runtime-session.mjs";

const clientInfo = { name: "codex-mcp-client" };
const threadId = "019f9fcd-899a-72b3-91f6-fdf3134381bb";
const meta = (model, effort, windowId = "window-1") => ({
  threadId, windowId, "x-codex-turn-metadata": { turn_id: "turn", model, reasoning_effort: effort },
});
const frame = (method, params = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

test("Codex observes the current outer MCP frame and ignores legacy proof if its observation is absent", async () => {
  assert.equal(observeCodexMcpTurn(meta("gpt-6.1-sol", "high"), clientInfo).observation.effortLevel, "high");
  assert.equal(observeCodexMcpTurn(meta("gpt-6.1-sol", "low"), clientInfo).observation.effortLevel, "low");
  assert.equal(observeCodexMcpTurn(meta("gpt-6.1-sol", undefined), clientInfo).observation.effortLevel, null);
  assert.equal(observeCodexMcpTurn(meta("gpt-6.1-sol", "high"), { name: "claude-code" }), null);
  assert.equal(observeCodexMcpTurn({ threadId }, clientInfo), null);
  assert.deepEqual(await prepareCodexMcpToolArguments({ clientInfo, toolName: "mcp__trelio__get_task",
    input: { taskNumber: 42, runtimeSessionProof: "old-hook-proof", knownInstructionLayerKeys: ["old-layer"] },
  }), { taskNumber: 42 });
});

test("Codex MCP passes only the new prepared proof, preserves Apps, and reports compaction before dispatch", async () => {
  const received = [];
  const tools = [
    { name: "get_task", _meta: { "trelio/runtimePolicy": { class: "context" } } },
    { name: "update_task_title", _meta: { "trelio/runtimePolicy": { class: "mutation" } } },
    { name: "apply_proposal", _meta: { ui: { visibility: ["app"] } } },
  ];
  const result = { content: [], structuredContent: {}, _meta: { appPayload: "private-to-app" } };
  const handler = createCodexMcpHandler({
    connect: (caps) => {
      assert.deepEqual(caps, { extensions: { "io.modelcontextprotocol/ui": {} } });
      return {
        listTools: async () => tools,
        call: async (name, args) => { received.push({ name, args }); return result; },
        readResource: async uri => ({ contents: [{ uri }] }),
      };
    },
    prepare: async ({ metadata, input }) => ({
      ...cleanNativeRuntimeToolArguments(input),
      runtimeSessionProof: observeCodexMcpTurn(metadata, clientInfo).observation.effortLevel,
    }),
  });
  await handler(frame("initialize", { protocolVersion: "2025-06-18" }),
    { clientInfo, clientCapabilities: { extensions: { "io.modelcontextprotocol/ui": {} } } });
  await handler(frame("tools/list"), { clientInfo });
  const call = (name, effort, windowId) => handler(frame("tools/call", {
    name, arguments: { runtimeSessionProof: "old-hook-proof" }, _meta: meta("gpt-6.1-sol", effort, windowId),
  }), { clientInfo });
  assert.deepEqual((await call("get_task", "high")).result, result);
  assert.deepEqual((await call("get_task", "low")).result, result);
  assert.deepEqual((await call("apply_proposal", undefined)).result, result);
  const compacted = await call("update_task_title", "high", "window-2");
  assert.equal(compacted.result.structuredContent.code, "TRELIO_CODEX_CONTEXT_RELOAD_REQUIRED");
  assert.deepEqual(received, [
    { name: "get_task", args: { runtimeSessionProof: "high" } },
    { name: "get_task", args: { runtimeSessionProof: "low" } },
    { name: "apply_proposal", args: {} },
  ]);
  assert.deepEqual((await handler(frame("resources/read", { uri: "ui://fixture" }), { clientInfo })).result,
    { contents: [{ uri: "ui://fixture" }] });
});

test("new Codex diagnostics route the read to stdio without checking or changing legacy hook trust", async () => {
  const result = await handleToolCall("https://trelio.ru", "diagnose_trelio_installation", {
    clientKind: "codex", intent: "diagnostics", readTarget: { companySlug: "demo" },
  }, {
    codexMcpRuntime: true,
    localPrerequisiteDiagnosis: async ({ includeHookStartup }) => {
      assert.equal(includeHookStartup, false);
      return { status: "ready", node: { status: "ready" }, git: { status: "ready" },
        plugin: { status: "ready", hooks: { status: "not_applicable" } }, connection: { status: "ready" } };
    },
    codexHookSettingsRead: () => assert.fail("new route does not inspect trust"),
    codexRoutingPlan: () => assert.fail("new route does not plan legacy config edits"),
    publicServiceDiagnosis: async () => ({ state: "available" }),
    folderDiagnosticPrepare: async () => ({ status: "ready" }),
  });
  const report = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.equal(report.liveVerification.read.namespace, "mcp__trelio_runtime");
  assert.equal(report.liveVerification.read.invocation, "direct_or_code_mode");
  assert.match(report.liveVerification.read.instructions, /Code Mode/u);
  assert.equal(report.clientInspection.toolExposure.invocation, "direct_or_code_mode");
  assert.deepEqual(report.clientInspection.toolExposure.checks, ["tool_available_on_current_route", "safe_read_result"]);
  assert.match(report.clientInspection.mcpRecovery.evidence.instructions, /direct и Code Mode/u);
  assert.equal(report.liveVerification.hook.state, "not_applicable");
  assert.equal(report.clientInspection.hookDispatch, undefined);
  assert.deepEqual(report.requiredActions, []);
});

test("bootstrap recovery keeps the hook-free Codex route when local tools are unavailable", () => {
  const report = buildTrelioBootstrapVerification({
    local: { plugin: { status: "ready", hooks: { runtimeAdmission: "codex_mcp" } },
      node: { status: "ready" }, git: { status: "ready" } },
    publicService: { state: "available" },
  });
  assert.equal(report.readVerification.invocation, "direct_or_code_mode");
  assert.match(report.clientRecoveryByKind.selection, /Code Mode/u);
  assert.ok(report.clientRecoveryByKind.codex.verification.checks.includes("safe_read_in_target_thread"));
});

test("an unpaired Codex call leaves the company decision to the backend and returns exact pairing on denial", async () => {
  const received = [];
  let enforcement = false;
  const pairing = { pairingId: "11111111-1111-4111-8111-111111111111", deviceName: "Fixture device", codeVerifier: "private" };
  const handler = createCodexMcpHandler({
    connect: () => ({
      listTools: async () => [{ name: "get_task" }],
      call: async (_name, args) => {
        received.push(args);
        return enforcement ? { isError: true, content: [],
          structuredContent: { code: "TRELIO_RUNTIME_HOOK_REQUIRED", reason: "missing" } }
          : { content: [], structuredContent: { task: "fixture" } };
      },
    }),
    prepare: async () => { throw Object.assign(new Error(), { code: "TRELIO_BRIDGE_PAIRING_REQUIRED", pairing }); },
  });
  await handler(frame("initialize", { protocolVersion: "2025-06-18" }), { clientInfo });
  const call = () => handler(frame("tools/call", { name: "get_task", _meta: meta("gpt-6.1-sol", "high"),
    arguments: { taskNumber: 42, runtimeSessionProof: "old" } }), { clientInfo });
  assert.equal((await call()).result.structuredContent.task, "fixture");
  enforcement = true;
  const denial = (await call()).result;
  assert.equal(denial.isError, true);
  assert.equal(denial.structuredContent.code, "TRELIO_BRIDGE_PAIRING_REQUIRED");
  assert.equal(denial.structuredContent.pairingId, pairing.pairingId);
  assert.doesNotMatch(JSON.stringify(denial), /codeVerifier/u);
  assert.deepEqual(received, [{ taskNumber: 42 }, { taskNumber: 42 }]);
});

test("a verified upgrade before remote dispatch hands the original Codex frame to the signed delegate", async () => {
  const handler = createCodexMcpHandler({
    connect: () => ({ listTools: async () => [{ name: "get_task" }], call: () => assert.fail("remote dispatch") }),
    prepare: async () => { throw new TrelioApiError(426, "fixture", null, "AGENT_WORKSPACE_HOST_RUNTIME_UPGRADE_REQUIRED"); },
  });
  await handler(frame("initialize", { protocolVersion: "2025-06-18" }), { clientInfo });
  const original = frame("tools/call", { name: "get_task", _meta: meta("gpt-6.1-sol", "high"), arguments: {} });
  let handedOff = false;
  assert.equal(await handler(original, { clientInfo, runtimeUpgradeRecovery: (_error, message) => {
    assert.equal(message, original);
    handedOff = true;
    return true;
  } }), null);
  assert.ok(handedOff);
});
