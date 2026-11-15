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
  for (const metadata of [undefined, { threadId, windowId: "window-2" },
    meta("invalid model", "high", "window-3"),
    { ...meta("gpt-6.1-sol", "high"), "x-codex-turn-metadata": { model: "gpt-6.1-sol" } },
  ]) {
    assert.deepEqual(await prepareCodexMcpToolArguments({ metadata, clientInfo, toolName: "mcp__trelio__get_task",
      input: { taskNumber: 42, runtimeSessionProof: "old-hook-proof", knownInstructionLayerKeys: ["old-layer"],
        knownInstructionRevisionKey: "old-revision", knownInstructionKey: "old-skill" },
    }), { taskNumber: 42 });
  }
});

test("Codex MCP keeps current proof and Apps across context changes without refusing unseen pinned reads", async () => {
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
  assert.deepEqual((await call("apply_proposal", undefined, "window-2")).result, result);
  // Pinned files read through shell/Code Mode or the independent local MCP do
  // not produce remote MCP frames. Their absence in this handler is not proof
  // of a skipped reread and must not cause a false refusal or a mutation retry.
  assert.equal((await call("update_task_title", "high", "window-2")).result, result);
  assert.deepEqual(received, [
    { name: "get_task", args: { runtimeSessionProof: "high" } },
    { name: "get_task", args: { runtimeSessionProof: "low" } },
    { name: "apply_proposal", args: {} },
    { name: "update_task_title", args: { runtimeSessionProof: "high" } },
  ]);
  assert.deepEqual((await handler(frame("resources/read", { uri: "ui://fixture" }), { clientInfo })).result,
    { contents: [{ uri: "ui://fixture" }] });
});

test("paged and standalone authority responses remain opaque to Codex transport across context changes", async () => {
  const results = {
    get_task: { content: [], structuredContent: { schemaVersion: 3,
      effectiveInstructions: { status: "incomplete", layers: [], delivery: { pageCount: 2 } } } },
    get_agent_instructions: { content: [], structuredContent: {
      instructionRevisionKey: "fixture-revision", effective: { compiledMarkdown: "Fixture rules" },
      personalProfile: { effective: { compiledMarkdown: "Fixture profile" } },
    } },
    get_agent_skill: { content: [{ type: "text", text: "Fixture skill instructions" }], structuredContent: { ready: true } },
  };
  const received = [];
  const handler = createCodexMcpHandler({
    connect: () => ({
      listTools: async () => [...Object.keys(results), "get_task_instruction_page"].map(name => ({
        name, _meta: { "trelio/runtimePolicy": { class: "context" } },
      })),
      call: async (name, args) => {
        received.push({ name, args });
        // Page responses deliberately have no effectiveInstructions.status:
        // the domain reader owns assembly/digests, not the MCP transport.
        return name === "get_task_instruction_page" ? { content: [], structuredContent: {
          schemaVersion: 3, responseKind: "instruction_page", catalogRevisionKey: "fixture-catalog",
          part: { partIndex: args.pageIndex, partCount: 2, markdown: `Fixture part ${args.pageIndex}` },
          nextPageIndex: args.pageIndex === 0 ? 1 : null,
        } } : results[name];
      },
    }),
    prepare: async ({ input }) => ({ ...input, runtimeSessionProof: "fresh-fixture-proof" }),
  });
  await handler(frame("initialize"), { clientInfo });
  const call = (name, windowId, args = {}) => handler(frame("tools/call", {
    name, arguments: args, _meta: meta("gpt-6.1-sol", "high", windowId),
  }), { clientInfo });
  await call("get_task", "window-1");
  assert.equal((await call("get_task", "window-2")).result, results.get_task);
  for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
    const page = await call("get_task_instruction_page", "window-2", { pageIndex });
    assert.equal(page.result.structuredContent.part.partIndex, pageIndex);
  }
  assert.equal((await call("get_agent_skill", "window-2")).result, results.get_agent_skill);
  assert.equal((await call("get_agent_instructions", "window-3")).result, results.get_agent_instructions);
  assert.equal((await call("get_agent_skill", "window-3")).result, results.get_agent_skill);
  assert.deepEqual(received.map(({ name }) => name), ["get_task", "get_task", "get_task_instruction_page",
    "get_task_instruction_page", "get_agent_skill", "get_agent_instructions", "get_agent_skill"]);
});

test("parallel changed-window calls preserve each admission and exact backend refusal without replay", async () => {
  const received = [], prepared = [];
  // A tool with a success-only outputSchema reports errors in text; adding a
  // code/reason structured object would itself violate that real client ABI.
  const refusal = { isError: true, content: [{ type: "text", text: "TRELIO_RUNTIME_POLICY_DENIED (fixture-policy)" }],
    _meta: { appPayload: { preserved: true } } };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const handler = createCodexMcpHandler({
    connect: () => ({
      listTools: async () => [{ name: "update_task_title",
        outputSchema: { type: "object", properties: { updated: { type: "boolean" } }, required: ["updated"] },
        _meta: { "trelio/runtimePolicy": { class: "mutation" } } }],
      call: async (_name, args) => {
        received.push(args);
        if (args.title !== "baseline") await pending;
        return refusal;
      },
    }),
    prepare: async ({ metadata, input }) => {
      const observation = observeCodexMcpTurn(metadata, clientInfo);
      prepared.push({ title: input.title, effort: observation?.observation.effortLevel });
      if (input.title === "denied") throw Object.assign(new Error("Fixture admission refusal"),
        { code: "TRELIO_RUNTIME_OBSERVATION_REQUIRED" });
      return { ...input, runtimeSessionProof: observation?.observation.effortLevel };
    },
  });
  await handler(frame("initialize"), { clientInfo });
  // Warm the catalog before parallel calls; the test exercises overlapping
  // business requests, not unrelated first-initialize catalog behavior.
  await handler(frame("tools/list"), { clientInfo });
  const call = (title, effort, windowId) => handler(frame("tools/call", {
    name: "update_task_title", _meta: meta("gpt-6.1-sol", effort, windowId),
    arguments: { title, runtimeSessionProof: "forged", knownInstructionLayerKeys: ["stale"],
      knownInstructionRevisionKey: "stale-revision", knownInstructionKey: "stale-skill" },
  }), { clientInfo });
  assert.equal((await call("baseline", "high", "window-1")).result, refusal);
  const calls = [call("left", "high", "window-2"), call("right", "low", "window-3")];
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.length, 3, "both concurrent requests reach their independent backend decision once");
  } finally { release(); }
  for (const response of await Promise.all(calls)) assert.equal(response.result, refusal);
  const denial = (await call("denied", "high", "window-4")).result;
  assert.equal(denial.isError, true);
  assert.equal(denial.structuredContent, undefined);
  assert.equal(JSON.parse(denial.content[0].text).code, "TRELIO_RUNTIME_OBSERVATION_REQUIRED");
  assert.deepEqual(prepared, [
    { title: "baseline", effort: "high" }, { title: "left", effort: "high" }, { title: "right", effort: "low" },
    { title: "denied", effort: "high" },
  ]);
  assert.deepEqual(received, [
    { title: "baseline", runtimeSessionProof: "high" },
    { title: "left", runtimeSessionProof: "high" }, { title: "right", runtimeSessionProof: "low" },
  ]);
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
