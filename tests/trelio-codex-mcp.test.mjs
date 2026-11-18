import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { PassThrough } from "node:stream";
import { createCodexMcpHandler, createHarnessConnection, handleLocalMcpMessage, handleToolCall, remoteMcpHttpRequest,
  RemoteMcpHostError, runCodexMcpStdioHost } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { buildTrelioBootstrapVerification } from "../host-runtime/scripts/trelio-installation-diagnostic.mjs";
import { TrelioApiError } from "../host-runtime/scripts/trelio-workspace.mjs";
import { RemoteMcpOAuthError } from "../host-runtime/scripts/trelio-remote-mcp-oauth.mjs";
import {
  cleanNativeRuntimeToolArguments, observeCodexMcpTurn, prepareCodexMcpToolArguments,
} from "../host-runtime/scripts/trelio-runtime-session.mjs";

const clientInfo = { name: "codex-mcp-client" };
const threadId = "019f9fcd-899a-72b3-91f6-fdf3134381bb";
const meta = (model, effort, windowId = "window-1") => ({
  threadId, windowId, "x-codex-turn-metadata": { turn_id: "turn", model, reasoning_effort: effort },
});
const frame = (method, params = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
const readResult = response => response.result.structuredContent ?? JSON.parse(response.result.content[0].text);

test("catalogue transport failures preserve visible recovery and only closed reasons", async () => {
  const privateMessage = "private-url?token=fixture-secret /private/credential.json";
  const errors = [
    ...["REMOTE_MCP_TIMEOUT", "REMOTE_MCP_HTTP_ERROR", "REMOTE_MCP_CONNECTION_CLOSED"]
      .map(code => new RemoteMcpHostError(code, privateMessage, { privateMessage })),
    ...["REMOTE_MCP_OAUTH_TIMEOUT", "REMOTE_MCP_OAUTH_NETWORK_ERROR", "REMOTE_MCP_OAUTH_HTTP_ERROR"]
      .map(code => new RemoteMcpOAuthError(code, privateMessage)),
    ...["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED",
      "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]
      .map(code => Object.assign(new Error(privateMessage), { code, cause: privateMessage })),
  ];
  for (const error of errors) {
    let reads = 0;
    const handler = createCodexMcpHandler({ connect: () => ({
      listTools: async () => { reads++; throw error; },
      connect: () => assert.fail("network failure must not start OAuth"),
      call: () => assert.fail("catalogue recovery must not dispatch work"),
    }), prepare: () => assert.fail("catalogue read needs no fabricated runtime proof") });
    await handler(frame("initialize"), { clientInfo });
    const listed = await handler(frame("tools/list"));
    assert.equal(listed.error, undefined);
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ["trelio_retry_catalog", "trelio_connect"]);
    assert.equal(listed.result._meta["trelio/catalogReason"], error.code);
    assert.ok(listed.result.tools[0].description.includes(error.code), "reason reaches model without hidden metadata");
    assert.equal(listed.result.tools[0].annotations.readOnlyHint, true);
    assert.ok(Buffer.byteLength(JSON.stringify(listed.result.tools[0])) <= 750,
      "failure-only schema and its closed reason stay bounded without enlarging the healthy catalogue");
    const retried = await handler(frame("tools/call", { name: "trelio_retry_catalog", arguments: {} }));
    assert.equal(retried.result.isError, true);
    assert.equal(readResult(retried).code, "TRELIO_CODEX_CATALOG_UNAVAILABLE");
    assert.equal(readResult(retried).reason, error.code);
    assert.equal(readResult(retried).automaticRetry, false);
    assert.equal(reads, 2, "one read per explicit request, no automatic retry");
    assert.doesNotMatch(JSON.stringify([listed, retried]), /fixture-secret|credential\.json|privateMessage/u);
    const invalid = await handler(frame("tools/call", { name: "trelio_retry_catalog", arguments: { reauthorize: true } }));
    assert.equal(readResult(invalid).code, "TRELIO_CODEX_INPUT_INVALID");
    assert.equal(reads, 2);
  }
});

test("catalogue auth, integrity, vault and cancellation failures are not network recovery", async () => {
  for (const code of ["TRELIO_CODEX_AUTH_REQUIRED", "REMOTE_MCP_AUTH_REJECTED", "REMOTE_MCP_INSUFFICIENT_SCOPE",
    "TRELIO_HARNESS_CATALOG_INVALID", "TRELIO_CODEX_CATALOG_CONFLICT", "REMOTE_MCP_HOST_BLOCKED",
    "ERR_TLS_CERT_ALTNAME_INVALID", "PRIVATE_VAULT_FAILED"]) {
    const handler = createCodexMcpHandler({ connect: () => ({
      listTools: async () => { throw new RemoteMcpHostError(code, "private error prose"); },
    }) });
    await handler(frame("initialize"), { clientInfo });
    const response = await handler(frame("tools/list"));
    if (["TRELIO_CODEX_AUTH_REQUIRED", "REMOTE_MCP_AUTH_REJECTED", "REMOTE_MCP_INSUFFICIENT_SCOPE"].includes(code)) {
      assert.deepEqual(response.result.tools.map(tool => tool.name), ["trelio_connect"]);
    } else assert.equal(response.error.message, code);
    assert.doesNotMatch(JSON.stringify(response), /private error prose/u);
  }
  for (const reserved of ["trelio_connect", "trelio_retry_catalog"]) {
    const handler = createCodexMcpHandler({ connect: () => ({ listTools: async () => [{ name: reserved }] }) });
    await handler(frame("initialize"), { clientInfo });
    assert.equal((await handler(frame("tools/list"))).error.message, "TRELIO_CODEX_CATALOG_CONFLICT");
  }
  const controller = new AbortController();
  const handler = createCodexMcpHandler({ connect: () => ({ listTools: async () => {
    controller.abort(new RemoteMcpHostError("REMOTE_MCP_TIMEOUT", "caller cancellation"));
    throw controller.signal.reason;
  } }) });
  await handler(frame("initialize"), { clientInfo });
  assert.equal((await handler(frame("tools/list"), { signal: controller.signal })).error.message, "REMOTE_MCP_TIMEOUT");
});

test("catalogue startup is bounded and late readers cannot restore stale dispatch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release, observedSignal, reads = 0;
  const started = Promise.withResolvers();
  const handler = createCodexMcpHandler({ connect: () => ({ listTools: async signal => {
    reads++;
    if (reads === 1) {
      observedSignal = signal;
      started.resolve();
      return await new Promise(resolve => { release = resolve; });
    }
    return [{ name: "current_tool" }];
  }, call: () => assert.fail("late catalogue must not authorise removed tool") }) });
  await handler(frame("initialize"), { clientInfo });
  const listing = handler(frame("tools/list"));
  await started.promise;
  t.mock.timers.tick(10_000);
  const failed = await listing;
  assert.equal(failed.result._meta["trelio/catalogReason"], "TRELIO_CODEX_CATALOG_TIMEOUT");
  assert.equal(observedSignal.aborted, true);
  const notifications = [];
  const recovered = await handler(frame("tools/call", { name: "trelio_retry_catalog", arguments: {} }),
    { notifyClient: notification => notifications.push(notification) });
  assert.equal(readResult(recovered).catalogStatus, "ready");
  assert.deepEqual(notifications.map(row => row.method), ["notifications/tools/list_changed"]);
  release([{ name: "stale_tool" }]);
  await new Promise(resolve => setImmediate(resolve));
  const stale = await handler(frame("tools/call", { name: "stale_tool", arguments: {} }));
  assert.equal(readResult(stale).code, "TRELIO_CODEX_TOOL_UNAVAILABLE");
  assert.equal(reads, 2);
});

test("an older concurrent catalogue result cannot replace or clear the latest dispatch map", async () => {
  for (const fails of [false, true]) {
    const first = Promise.withResolvers(), started = Promise.withResolvers();
    let reads = 0;
    const called = [];
    const handler = createCodexMcpHandler({ connect: () => ({
      listTools: async () => {
        if (++reads === 1) { started.resolve(); return await first.promise; }
        return [{ name: "current_tool" }];
      },
      call: async name => { called.push(name); return { content: [] }; },
    }), prepare: async ({ input }) => input });
    await handler(frame("initialize"), { clientInfo });
    const older = handler(frame("tools/list"));
    await started.promise;
    await handler(frame("tools/list"));
    if (fails) first.reject(new RemoteMcpHostError("REMOTE_MCP_HTTP_ERROR", "old failure"));
    else first.resolve([{ name: "stale_tool" }]);
    await older;
    assert.equal(readResult(await handler(frame("tools/call", { name: "stale_tool" }))).code,
      "TRELIO_CODEX_TOOL_UNAVAILABLE");
    assert.equal((await handler(frame("tools/call", { name: "current_tool" }))).result.isError, undefined);
    assert.deepEqual(called, ["current_tool"]);
    assert.equal(reads, 2, "old failure cannot erase the completed newer read");
  }
});

test("failed refresh invalidates cached tools while a dispatched mutation is never retried", async () => {
  let unavailable = false, reads = 0, dispatched = 0, prepared = 0;
  const handler = createCodexMcpHandler({ connect: () => ({ listTools: async () => {
    reads++;
    if (unavailable) throw new RemoteMcpHostError("REMOTE_MCP_HTTP_ERROR", "private upstream cause");
    return [{ name: "update_task_title", outputSchema: { type: "object", required: ["updated"] } }];
  }, call: async () => { dispatched++; throw new RemoteMcpHostError("REMOTE_MCP_HTTP_ERROR", "request outcome unknown"); } }),
  prepare: async ({ input }) => { prepared++; return input; } });
  await handler(frame("initialize"), { clientInfo });
  await handler(frame("tools/list"));
  const mutation = frame("tools/call", { name: "update_task_title", arguments: {} });
  const unknown = await handler(mutation);
  assert.equal(readResult(unknown).code, "REMOTE_MCP_HTTP_ERROR");
  assert.equal(readResult(unknown).catalogStatus, undefined, "dispatch failure is never a catalogue failure");
  assert.equal(dispatched, 1);
  unavailable = true;
  await handler(frame("tools/list"));
  const observations = [];
  const blocked = await handler(mutation, {
    recordDiagnostic: (name, _args, code) => observations.push([name, code]),
  });
  assert.equal(readResult(blocked).code, "TRELIO_CODEX_CATALOG_UNAVAILABLE");
  assert.equal(blocked.result.structuredContent, undefined, "cached success-only output schema stays valid");
  assert.deepEqual(observations, [["update_task_title", "TRELIO_CODEX_CATALOG_UNAVAILABLE"]],
    "the reporter receives the typed host failure even when the wire result must omit its structured code");
  assert.equal(prepared, 1);
  assert.equal(dispatched, 1);
  assert.equal(reads, 3, "failed refresh cannot leave the old dispatch map active");
});

test("real Codex stdio survives HTTP 503 catalogue failure and reloads without OAuth or work replay", { timeout: 5_000 }, async () => {
  let unavailable = true, catalogReads = 0, businessCalls = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    if (payload.method === "tools/list") {
      catalogReads++;
      if (unavailable) { response.writeHead(503); response.end("private backend diagnostic"); return; }
    }
    if (payload.method === "tools/call") businessCalls++;
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null,
      result: payload.method === "initialize" ? { protocolVersion: "2025-03-26" }
        : { tools: [{ name: "list_companies", inputSchema: { type: "object", properties: {} } }] } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const input = new PassThrough(), output = new PassThrough();
  let sequence = 0, buffer = "";
  const pending = new Map(), notifications = [];
  output.on("data", bytes => {
    buffer += bytes.toString();
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (row.id === undefined) notifications.push(row);
      else { pending.get(row.id)?.(row); pending.delete(row.id); }
    }
  });
  const request = (method, params = {}) => new Promise(resolve => {
    const id = ++sequence; pending.set(id, resolve);
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const connection = createHarnessConnection({ nativeClient: "codex",
    httpJson: async () => ({ body: { issuer: "https://trelio.ru", scopes_supported: ["mcp:read"] } }),
    vault: { read: async () => ({ accessToken: "synthetic-token", expiresAt: Date.now() + 60_000 }),
      write: () => assert.fail("catalogue retry must not replace credentials") },
    connectOAuth: () => assert.fail("catalogue retry must not open OAuth"),
    httpRequest: (args, options) => remoteMcpHttpRequest(args, { ...options, resolveEndpoint: async () => ({
      endpoint: new URL(`http://mcp.test:${server.address().port}/mcp`), address: "127.0.0.1", family: 4,
    }) }),
  });
  const running = runCodexMcpStdioHost({ profile: "remote", connect: () => connection,
    inputStream: input, outputStream: output, environment: {}, preservePlugin: () => null,
    startupTrace() {}, diagnosticReporter: { record() {}, close() {} } });
  try {
    assert.ok((await request("initialize", { clientInfo, protocolVersion: "2025-03-26" })).result);
    const initial = await request("tools/list");
    assert.deepEqual(initial.result.tools.map(tool => tool.name), ["trelio_retry_catalog", "trelio_connect"]);
    const retry = () => request("tools/call", { name: "trelio_retry_catalog", arguments: {} });
    assert.equal(readResult(await retry()).reason, "REMOTE_MCP_HTTP_ERROR");
    assert.equal(notifications.length, 0);
    unavailable = false;
    const recovered = readResult(await retry());
    assert.equal(recovered.catalogStatus, "ready");
    assert.deepEqual(recovered.catalogEvidence, {
      nativeToolCount: 1,
      readTools: { list_companies: true, get_agent_instructions: false, get_task: false, list_my_tasks: false, list_project_tasks: false },
      listChangedNotification: "sent",
      clientToolExposure: "not_checked",
    });
    assert.deepEqual(notifications.map(row => row.method), ["notifications/tools/list_changed"]);
    const fresh = await request("tools/list");
    assert.deepEqual(fresh.result.tools.map(tool => tool.name), ["list_companies", "trelio_connect"]);
    assert.equal(fresh.result._meta, undefined, "healthy catalogue has no additional context cost");
    assert.equal(catalogReads, 4);
    assert.equal(businessCalls, 0);
    assert.doesNotMatch(JSON.stringify([initial, fresh, notifications]), /private backend diagnostic|synthetic-token/u);
  } finally {
    input.end();
    await running;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("Codex returns a manual OAuth link through ordinary tool text without premature connection or App capabilities", async () => {
  let ready = false, catalogReads = 0, notifications = 0, closes = 0;
  const pending = { connected: false, status: "awaiting_authorization",
    authorizationUrl: "https://trelio.ru/oauth/authorize?state=synthetic-state&code_challenge=synthetic-challenge",
    expiresAt: "2026-11-16T10:00:00.000Z", browser: { stage: "shell_execute", nativeCode: 5 } };
  const handler = createCodexMcpHandler({ connect: () => ({
    connect: async () => ready ? { connected: true } : pending,
    listTools: async () => { catalogReads++; return []; },
    close: async () => { closes++; },
  }) });
  await handler(frame("initialize"), { clientInfo, clientCapabilities: {} });
  const call = () => handler(frame("tools/call", { name: "trelio_connect", arguments: {} }),
    { clientInfo, notifyClient: async () => { notifications++; } });
  const first = await call();
  assert.equal(first.result.isError, undefined);
  assert.deepEqual(JSON.parse(first.result.content[0].text), pending);
  assert.equal(catalogReads, 0); assert.equal(notifications, 0);
  ready = true;
  assert.equal(JSON.parse((await call()).result.content[0].text).connected, true);
  assert.equal(catalogReads, 1); assert.equal(notifications, 1);
  await handler.close(); assert.equal(closes, 1);
});

test("Codex preserves typed OAuth causes while discarding arbitrary process messages", async () => {
  const failures = [
    new RemoteMcpOAuthError("REMOTE_MCP_OAUTH_TIMEOUT", "Время входа истекло (10 минут). Начните новую попытку подключения.", { stage: "spawn", causeCode: "ENOENT" }),
    new RemoteMcpOAuthError("REMOTE_MCP_OAUTH_REJECTED", "OAuth-подключение отклонено."),
    new Error("private callback code=synthetic-secret"),
  ];
  const handler = createCodexMcpHandler({ connect: () => ({ connect: async () => { throw failures.shift(); } }) });
  await handler(frame("initialize"), { clientInfo });
  const call = async () => (await handler(frame("tools/call", { name: "trelio_connect" }), { clientInfo })).result;
  const timeout = await call();
  assert.equal(timeout.isError, true);
  assert.match(timeout.structuredContent.message, /10 минут/u);
  assert.deepEqual(timeout.structuredContent.browser, { stage: "spawn", causeCode: "ENOENT" });
  assert.equal((await call()).structuredContent.message, "OAuth-подключение отклонено.");
  assert.doesNotMatch(JSON.stringify(await call()), /synthetic-secret/u);
});

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

test("a stalled Codex component check returns completed diagnostics within the ordinary MCP budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = Promise.withResolvers();
  const checks = [];
  let localSignal;
  const reply = handleLocalMcpMessage(frame("tools/call", {
    name: "diagnose_trelio_installation",
    arguments: { clientKind: "codex", intent: "diagnostics", readTarget: { companySlug: "demo" } },
  }), {
    clientInfo, codexMcpRuntime: true,
    callTool: (origin, name, args, options) => handleToolCall(origin, name, args, {
      ...options,
      localPrerequisiteDiagnosis: ({ signal }) => {
        localSignal = signal;
        started.resolve();
        return new Promise(() => {});
      },
      publicServiceDiagnosis: async () => {
        checks.push("public_service");
        return { state: "available" };
      },
      folderDiagnosticPrepare: async () => {
        checks.push("working_folder");
        return { status: "ready" };
      },
    }),
  });
  await started.promise;
  assert.deepEqual(checks.sort(), ["public_service", "working_folder"], "independent probes start even while local inspection is blocked");
  // Let the two already resolved check promises clear their fake timers.
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(45_000);
  const response = await reply;
  const report = readResult(response);
  assert.equal(response.result.isError, undefined);
  assert.equal(report.status, "partial");
  assert.deepEqual(report.diagnosticTimeouts, [{ stage: "local_components", timeoutMs: 45_000 }]);
  assert.equal(localSignal.aborted, true);
  assert.equal(report.local.status, "not_checked");
  assert.equal(report.local.connection.deviceSessionConfigured, null);
  assert.ok(report.local.hostRuntime.loadedVersion);
  assert.equal(report.workingFolder.status, "ready");
  assert.equal(report.publicService.state, "available");
  assert.deepEqual(report.requiredActions, []);
  assert.equal(report.liveVerification.read.state, "prerequisites_not_checked");
  assert.equal(report.liveVerification.read.nextCall, null);
  assert.equal(report.liveVerification.toolExposure.state, "not_checked");
});

test("a stalled folder check preserves the exact ordinary read plan while caller cancellation stays terminal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = { clientKind: "codex", intent: "diagnostics", readTarget: { companySlug: "demo" } };
  const controller = new AbortController();
  const options = {
    codexMcpRuntime: true,
    localPrerequisiteDiagnosis: async () => ({ status: "ready", node: { status: "ready" }, git: { status: "ready" },
      plugin: { status: "ready" }, connection: { status: "ready" } }),
    publicServiceDiagnosis: async () => ({ state: "available" }),
    folderDiagnosticPrepare: () => new Promise(() => {}),
  };
  const diagnose = extra => handleToolCall("https://trelio.ru", "diagnose_trelio_installation", input, { ...options, ...extra });
  const reply = diagnose();
  const cancelled = diagnose({ signal: controller.signal });
  const reason = new Error("Client cancelled the diagnostic.");
  const rejected = assert.rejects(cancelled, error => error === reason);
  controller.abort(reason);
  await rejected;
  t.mock.timers.tick(30_000);
  const report = readResult({ result: await reply });
  assert.equal(report.status, "partial");
  assert.deepEqual(report.diagnosticTimeouts, [{ stage: "working_folder", timeoutMs: 30_000 }]);
  assert.equal(report.workingFolder.status, "not_checked");
  assert.deepEqual(report.liveVerification.read.nextCall, { toolName: "get_agent_instructions", arguments: input.readTarget });
  assert.equal(report.liveVerification.read.readResult, "not_checked");
});

test("legacy routing and public service deadlines preserve confirmed local diagnostic evidence", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waitingHookConfig = Promise.withResolvers();
  let routingPlans = 0;
  const reply = handleToolCall("https://trelio.ru", "diagnose_trelio_installation", {
    clientKind: "codex", intent: "diagnostics",
  }, {
    localPrerequisiteDiagnosis: async () => ({ status: "action_required", node: { status: "ready" },
      git: { status: "missing" }, plugin: { status: "ready" }, connection: { status: "ready" } }),
    codexHookSettingsRead: () => waitingHookConfig.promise,
    codexRoutingPlan: async () => {
      routingPlans++;
      return { status: "ready" };
    },
    publicServiceDiagnosis: () => new Promise(() => {}),
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(40_000);
  const report = readResult({ result: await reply });
  assert.equal(report.status, "partial");
  assert.deepEqual(report.diagnosticTimeouts, [
    { stage: "codex_hook_routing", timeoutMs: 20_000 },
    { stage: "public_service", timeoutMs: 40_000 },
  ]);
  assert.deepEqual(report.requiredActions.map(({ code }) => code), ["INSTALL_STANDALONE_GIT"]);
  assert.equal(report.readiness.checks.publicService, "not_checked");
  assert.equal(report.liveVerification.read.nextCall, null);
  waitingHookConfig.resolve({ status: "ready" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(routingPlans, 0, "an expired hook inspection must not start a routing plan");
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
  let observations = 0;
  assert.equal(await handler(original, { clientInfo, recordDiagnostic: () => { observations++; }, runtimeUpgradeRecovery: (_error, message) => {
    assert.equal(message, original);
    handedOff = true;
    return true;
  } }), null);
  assert.ok(handedOff);
  assert.equal(observations, 0, "the delegate owns the observation");
});

test("native diagnostics keep routing, login, malformed input and opaque failures distinct", async () => {
  const observations = [], dispatched = [];
  const results = [
    { isError: true, structuredContent: { code: "MCP_LOCAL_CONTEXT_REQUIRED" }, content: [] },
    // A success-only output schema may omit structured errors. Do not parse
    // text or App metadata to recover a code; the backend owns that evidence.
    { isError: true, content: [{ type: "text", text: "PRIVATE_ERROR" }], _meta: { private: true } },
  ];
  const handler = createCodexMcpHandler({ connect: () => ({
    listTools: async () => [{ name: "get_task" }],
    call: async name => { dispatched.push(name); return results.shift(); },
    connect: async () => { throw new RemoteMcpHostError("TRELIO_CODEX_AUTH_REQUIRED", "PRIVATE_AUTH"); },
  }), prepare: async ({ input }) => input });
  const options = { clientInfo, recordDiagnostic: (name, _args, code) => observations.push([name, code]) };
  await handler(frame("initialize"), options);
  await handler(frame("tools/list"), options);
  for (const params of [{ name: "get_task" }, { name: "get_task" }, { name: "trelio_connect" },
    { name: "get_task", arguments: [] }, { name: "missing_tool" }]) {
    assert.equal((await handler(frame("tools/call", params), options)).result.isError, true);
  }
  assert.deepEqual(observations, [["get_task", "ROUTED"], ["get_task", "MCP_TOOL_ERROR"],
    ["trelio_connect", "TRELIO_CODEX_AUTH_REQUIRED"], ["get_task", "TRELIO_CODEX_INPUT_INVALID"],
    ["missing_tool", "TRELIO_CODEX_TOOL_UNAVAILABLE"]]);
  assert.deepEqual(dispatched, ["get_task", "get_task"]);
  assert.doesNotMatch(JSON.stringify(observations), /PRIVATE/);
});


test("native Codex calls record one outcome through the real reporter, including pre-dispatch refusals", async () => {
  const { createAgentDiagnosticReporter } = await import("../host-runtime/scripts/trelio-agent-diagnostics.mjs");
  const batches = [], dispatched = [];
  const reporter = createAgentDiagnosticReporter({ origin: "https://fixture.invalid", journal: null, delayMs: 60000,
    send: async (_origin, samples) => { batches.push(...structuredClone(samples)); } });
  const native = { content: [], structuredContent: { code: "ACCESS_DENIED", message: "PRIVATE_NATIVE" }, isError: true };
  const handler = createCodexMcpHandler({ connect: () => ({
    listTools: async () => ["get_task", "search", "get_task_review_context"].map(name => ({ name })),
    call: async (name) => { dispatched.push(name); return name === "search" ? native : { content: [] }; },
  }), prepare: async ({ input, toolName }) => {
    if (toolName.endsWith("get_task_review_context")) throw new TrelioApiError(403, "PRIVATE_ERROR", null, "ACCESS_DENIED");
    return input;
  } });
  const options = { clientInfo, recordDiagnostic: reporter.record };
  try {
    await handler(frame("initialize"), options); await handler(frame("tools/list"), options);
    const results = await Promise.all(["get_task", "search", "get_task_review_context"].map(name => handler(frame("tools/call", {
      name, arguments: { companySlug: "PRIVATE_SCOPE" }, _meta: meta("gpt-6.1-sol", "high"),
    }), options)));
    assert.equal(results[1].result, native);
    assert.deepEqual(dispatched.sort(), ["get_task", "search"]);
    await reporter.flush();
    assert.deepEqual(batches.map(sample => [sample.tool, sample.outcomes[0].code, sample.outcomes[0].count]).sort(), [
      ["get_task", "OK", 1], ["get_task_review_context", "ACCESS_DENIED", 1], ["search", "ACCESS_DENIED", 1],
    ]);
    assert.doesNotMatch(JSON.stringify(batches), /PRIVATE/);
    // Telemetry failures are isolated from the native result and do not retry it.
    assert.equal((await handler(frame("tools/call", { name: "search", arguments: {} }), {
      clientInfo, recordDiagnostic: () => { throw Error("collector down"); },
    })).result, native);
    assert.equal(dispatched.length, 3);
  } finally { reporter.close(); }
});

test("unknown native codes retain only UNKNOWN plus the existing collector gap", async () => {
  const { createAgentDiagnosticReporter } = await import("../host-runtime/scripts/trelio-agent-diagnostics.mjs");
  const batches = [];
  const reporter = createAgentDiagnosticReporter({ origin: "https://fixture.invalid", journal: null, delayMs: 60000,
    send: async (_origin, samples) => { batches.push(...structuredClone(samples)); } });
  const handler = createCodexMcpHandler({ connect: () => ({ listTools: async () => [{ name: "search" }],
    call: async () => ({ isError: true, structuredContent: { code: "PRIVATE_UNREVIEWED_CODE" }, content: [] }),
  }), prepare: async ({ input }) => input });
  const options = { clientInfo, recordDiagnostic: reporter.record };
  try {
    await handler(frame("initialize"), options);
    await handler(frame("tools/call", { name: "search" }), options);
    assert.equal(reporter.health().losses.unknown_code, 1);
    await reporter.flush();
    assert.equal(batches.find(sample => sample.tool === "search").outcomes[0].code, "UNKNOWN");
    assert.doesNotMatch(JSON.stringify(batches), /PRIVATE/);
  } finally { reporter.close(); }
});
