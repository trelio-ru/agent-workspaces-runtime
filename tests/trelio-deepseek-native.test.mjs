/** Qualification against published native Harness core, with synthetic MCP
 * and no model/account/network. This deliberately uses the real immutable
 * execution pipeline and Session header fold, not a mock tool registry.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { DEEPSEEK_HARNESS_VERSION_RANGE, DEEPSEEK_HARNESS_QUALIFIED_VERSION } from "../host-runtime/scripts/trelio-component-versions.mjs";
import { applyHarnessAdapter, createHarnessConnection, createHarnessContinuations,
  harnessToolName, observeHarnessRuntime, projectHarnessMcpResult, AGENT_SKILL_ROUTING_INSTRUCTIONS,
  remoteMcpHttpRequest, RemoteMcpHostError } from "../host-runtime/scripts/trelio-remote-mcp.mjs";

const require = createRequire(new URL("./fixtures/deepseek-native/package.json", import.meta.url));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const [{ Context }, { default: Tools }, { default: Prompt }, { Session }, { default: Attachments }] = await Promise.all(
  ["cordis", "dsh-tools", "dsh-system-prompt", "dsh-session", "dsh-attachment-local"].map(load));
assert.equal(require("@deepseek-ai/dsh-tools/package.json").version, DEEPSEEK_HARNESS_QUALIFIED_VERSION);
const signal = () => new AbortController().signal;
const agent = (id = "native-test") => {
  const session = Session.create(id);
  session.append("request/header", { reason: "initial", header: { config: {
    provider: "deepseek", model: "v4", reasoningEffort: "high",
  } } });
  return { session };
};
const tool = (name, extra = {}) => ({ name, inputSchema: { type: "object", additionalProperties: false,
  properties: { companySlug: { type: "string" }, runtimeSessionProof: { type: "object" } } }, ...extra });
const result = { content: [{ type: "text", text: "Routing summary only" }],
  structuredContent: { effectiveInstructions: { markdown: "FULL authority {{no interpolation}}" },
    data: { value: "полный результат" } }, _meta: { secretAppGrant: "hidden-test" } };

test("Harness engine range accepts newer releases without an upper bound", () => {
  // Match upstream app-boot's actual SemVer options. Without includePrerelease,
  // a range test could accidentally reject newer prereleases.
  const semver = require("semver");
  for (const version of ["0.2.1-rc.2", "0.2.1-rc.3", "0.2.1-rc.10", "0.2.1", "0.2.2-rc.1", "0.2.9", "0.3.0-alpha.1", "0.3.0", "1.0.0"]) {
    assert.equal(semver.satisfies(version, DEEPSEEK_HARNESS_VERSION_RANGE, { includePrerelease: true }), true, version);
  }
  for (const version of ["0.2.0", "0.2.1-alpha.5", "0.2.1-rc.1", "invalid"]) {
    assert.equal(semver.satisfies(version, DEEPSEEK_HARNESS_VERSION_RANGE, { includePrerelease: true }), false, version);
  }
});

test("incompatible registration API refuses before catalogue or private I/O", async () => {
  for (const missing of ["tools", "inject", "effect"]) {
    const ctx = { tools: { register: () => assert.fail("must not register") }, inject() {}, effect() {} };
    delete ctx[missing];
    await assert.rejects(applyHarnessAdapter(ctx, {
      connection: { listTools: async () => assert.fail("must not contact Trelio") },
      localMessage: async () => assert.fail("must not inspect local state"),
    }), { code: "TRELIO_HARNESS_API_INCOMPATIBLE" });
  }
});

test("real native pipeline preserves structured authority and hides dispatch-only proof", async t => {
  const ctx = new Context(); new Prompt(ctx, {}); new Tools(ctx);
  t.after(() => ctx.fiber.dispose());
  const observed = [], calls = [];
  await applyHarnessAdapter(ctx, {
    connection: { listTools: async () => [tool("get_task"), tool("prepare_agent_secret_browser_fill"), tool("hidden", { _meta: { ui: { visibility: ["app"] } } })],
      instructions: () => "server instructions", call: async (method, args) => { calls.push({ method, args }); return result; } },
    localMessage: async () => ({ result: { tools: [] } }),
    prepare: async input => { observed.push(input); return { ...input.input, runtimeSessionProof: { test: "private-dispatch" } }; },
  });
  const assembly = await ctx.systemPrompt.assemble({});
  const prefix = assembly.sections.map(section => section.text).join("\n");
  assert.ok(prefix.includes("server instructions"));
  assert.ok(prefix.includes(AGENT_SKILL_ROUTING_INSTRUCTIONS));
  const a = agent(), name = harnessToolName("trelio", "get_task");
  assert.equal(ctx.tools.get(harnessToolName("trelio", "hidden")), undefined);
  assert.equal(ctx.tools.get(name).parameters.properties.runtimeSessionProof, undefined);
  const args = Object.freeze({ companySlug: "synthetic-company" });
  const executed = await ctx.tools.execute({ name, callId: "call-1", arguments: args, agent: a, signal: signal() });
  assert.equal(executed.isError, false);
  const visible = JSON.stringify(executed);
  assert.ok(visible.includes("FULL authority"));
  assert.equal(executed.value.structuredContent.effectiveInstructions.markdown, "FULL authority {{no interpolation}}");
  assert.ok(visible.includes("полный результат"));
  assert.ok(!visible.includes("hidden-test") && !visible.includes("private-dispatch"));
  assert.equal(calls.length, 1); assert.equal(calls[0].args.runtimeSessionProof.test, "private-dispatch");
  assert.equal(observed[0].observation.modelId, "deepseek/v4");
  assert.equal(Object.hasOwn(args, "runtimeSessionProof"), false);
  const unsupported = await ctx.tools.execute({ name: harnessToolName("trelio", "prepare_agent_secret_browser_fill"),
    callId: "browser-1", arguments: {}, agent: a, signal: signal() });
  assert.equal(unsupported.isError, true);
  assert.ok(JSON.stringify(unsupported.content).includes("TRELIO_HARNESS_UNSUPPORTED_OPERATION"));
  assert.equal(calls.length, 1, "Unsupported browser fill must stop before granting or dispatching");

  // Real request-header replacement supplies the new model/effort. No old
  // high effort may be borrowed after the user disables reasoning.
  a.session.append("request/header", { reason: "change", header: { config: { provider: "custom", model: "next", reasoningEffort: "off" } } });
  assert.equal(observeHarnessRuntime({ agent: a }).observation.effortLevel, null);
  assert.equal(observeHarnessRuntime({ agent: a }).observation.modelId, "custom/next");
});

test("native observation refuses missing request header; binary and hidden metadata are never text", () => {
  assert.throws(() => observeHarnessRuntime({ agent: { session: Session.create("missing") } }), { code: "TRELIO_RUNTIME_OBSERVATION_REQUIRED" });
  assert.throws(() => observeHarnessRuntime({ agent: { session: { requestHeader: "removed API" } } }), { code: "TRELIO_RUNTIME_OBSERVATION_REQUIRED" });
  const projected = projectHarnessMcpResult({ ...result,
    content: [...result.content, { type: "image", data: "private-binary", mimeType: "image/png" }] });
  assert.ok(!JSON.stringify(projected).includes("private-binary"));
  assert.ok(!JSON.stringify(projected).includes("hidden-test"));
  assert.equal(harnessToolName("trelio", "x".repeat(100)).length, 64);
});

// A genuine raster goes through the published Harness registry AND its durable
// attachment store. A mocked successful save alone would miss invalid reference
// rendering, lost image content or a buffer erased before native publication.
const imageData = (() => {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([size, type, bytes, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
})();
const imageBlock = () => ({ type: "image", mimeType: "image/png", data: imageData });
const imageFixture = async (t, { content = [{ type: "text", text: "before" }, imageBlock(),
  { type: "text", text: "after" }], modelInfo, store, absentStore = false, errorResult = false } = {}) => {
  const ctx = new Context(); new Prompt(ctx, {}); new Tools(ctx);
  t.after(() => ctx.fiber.dispose());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-harness-images-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const attachments = absentStore ? undefined : new Attachments(ctx, { dshHome: home });
  let reads = 0, saves = 0;
  const nativeSave = attachments?.saveImages.bind(attachments);
  if (attachments) attachments.saveImages = async inputs => {
    saves++; return store ? store(inputs, nativeSave) : nativeSave(inputs);
  };
  ctx.provide("llm", { resolveModelInfo: async (...args) => modelInfo ? modelInfo(...args) : { inputModalities: ["text", "image"] } });
  await applyHarnessAdapter(ctx, {
    connection: { listTools: async () => [tool("image_probe")], instructions: () => "",
      call: async () => { reads++; return { content, ...(errorResult ? { isError: true } : {}), _meta: { private: "hidden-image-grant" } }; } },
    localMessage: async () => ({ result: { tools: [] } }), prepare: async input => input.input,
  });
  const a = agent(), controller = new AbortController();
  return { ctx, home, attachments, a, controller, counts: () => ({ reads, saves }),
    run: () => ctx.tools.execute({ name: harnessToolName("trelio", "image_probe"), callId: "image-1",
      arguments: {}, agent: a, signal: controller.signal }) };
};

test("real Harness pipeline durably renders ordered images without inline bytes or hidden metadata", async t => {
  const f = await imageFixture(t, { content: [{ type: "text", text: "first" }, imageBlock(),
    { type: "text", text: "middle" }, imageBlock(), { type: "text", text: "last" }] });
  const output = await f.run();
  assert.equal(output.isError, false);
  assert.deepEqual(output.content.map(x => x.type), ["text", "image", "text", "image", "text"]);
  assert.deepEqual(output.value.content, output.content, "PTC and native receive the same durable, byte-free references");
  assert.deepEqual(f.counts(), { reads: 1, saves: 1 });
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes(imageData) && !serialized.includes("hidden-image-grant") && !serialized.includes(f.home));
  const ref = output.content[1].attachment;
  assert.equal(ref.width, 1); assert.equal(ref.height, 1); assert.equal(ref.mediaType, "image/png");
  const reopenedContext = new Context();
  t.after(() => reopenedContext.fiber.dispose());
  const reopened = new Attachments(reopenedContext, { dshHome: f.home });
  const saved = await reopened.readImage(ref);
  assert.ok(saved.data.length > 0, "reference survives reopening the real native store");
});

test("image admission refuses missing APIs, text models, malformed batches and private errors without replay", async t => {
  const cases = [
    { absentStore: true, expected: "attachment_store_unavailable" },
    { modelInfo: async () => ({ inputModalities: ["text"] }), expected: "model_image_input_unavailable" },
    { modelInfo: async () => ({}), expected: "model_image_input_unavailable" },
    { modelInfo: async () => ({ inputModalities: "image" }), expected: "model_image_input_unavailable" },
    { modelInfo: async () => { throw Error("private-model-credential"); }, expected: "image_admission_failed" },
    { content: [imageBlock(), { ...imageBlock(), data: "YWJj=" }], expected: "image_result_invalid" },
    { content: [{ ...imageBlock(), data: "Zh==" }], expected: "image_result_invalid" },
    { content: [{ ...imageBlock(), mimeType: "image/svg+xml" }], expected: "image_result_invalid" },
    { content: Array.from({ length: 9 }, imageBlock), expected: "image_result_limit" },
    { content: [{ ...imageBlock(), data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }], expected: "image_result_limit" },
    { content: Array.from({ length: 2 }, () => ({ ...imageBlock(), data: Buffer.alloc(3 * 1024 * 1024).toString("base64") })), expected: "image_result_limit" },
  ];
  for (const [index, entry] of cases.entries()) await t.test(String(index), async child => {
    const f = await imageFixture(child, entry); const output = await f.run();
    assert.equal(output.isError, false, "a display refusal does not convert the completed browser operation to a replayable failure");
    assert.ok(output.content.every(x => x.type === "text"));
    assert.ok(JSON.stringify(output).includes(entry.expected));
    assert.ok(!JSON.stringify(output).includes(imageData) && !JSON.stringify(output).includes("private-model-credential"));
    assert.deepEqual(f.counts(), { reads: 1, saves: 0 });
  });
  await t.test("native image validation and storage refusal", async child => {
    const f = await imageFixture(child, { content: [{ ...imageBlock(), data: Buffer.from("not a raster").toString("base64") }] });
    const output = await f.run();
    assert.ok(JSON.stringify(output).includes("image_admission_failed"));
    assert.deepEqual(f.counts(), { reads: 1, saves: 1 });
  });
  await t.test("MCP errors never start image storage", async child => {
    const f = await imageFixture(child, { errorResult: true }); const output = await f.run();
    assert.equal(output.isError, true); assert.deepEqual(f.counts(), { reads: 1, saves: 0 });
    assert.ok(!JSON.stringify(output).includes(imageData));
  });
  await t.test("native storage errors do not disclose paths or retry", async child => {
    const f = await imageFixture(child, { store: async () => { throw Error("private-image-storage-path"); } });
    const output = await f.run();
    assert.equal(output.isError, false);
    assert.ok(JSON.stringify(output).includes("image_admission_failed"));
    assert.ok(!JSON.stringify(output).includes("private-image-storage-path"));
    assert.deepEqual(f.counts(), { reads: 1, saves: 1 });
  });
});

test("native image capability and storage awaits retain current route and cancellation fences", async t => {
  for (const phase of ["capability", "storage"]) for (const action of ["model_change", "cancel"]) {
    await t.test(`${phase}/${action}`, async child => {
      let f;
      const change = () => action === "cancel" ? f.controller.abort()
        : f.a.session.append("request/header", { reason: "change", header: { config: {
          provider: "custom", model: "text-only", reasoningEffort: "off" } } });
      f = await imageFixture(child, {
        modelInfo: async () => { if (phase === "capability") change(); return { inputModalities: ["image"] }; },
        store: async (inputs, save) => { const refs = await save(inputs); if (phase === "storage") change(); return refs; },
      });
      const output = await f.run();
      assert.ok(output.content.every(x => x.type !== "image"));
      assert.deepEqual(f.counts(), { reads: 1, saves: phase === "capability" ? 0 : 1 });
      assert.ok(!JSON.stringify(output).includes(imageData));
    });
  }
});

const receipt = input => ({ structuredContent: { code: "MCP_LOCAL_CONTEXT_REQUIRED", providerSelection: { automatic: true,
  provider: "local_company_context", server: "trelio-remote-skills", tool: "continue_trelio_local_action",
  companySlug: "synthetic-company", nativeTool: "get_task", arguments: { schemaVersion: 1, route: "context",
    parameters: { companySlug: "synthetic-company", nativeTool: "get_task", arguments: { companySlug: "synthetic-company" },
      nativeCallRef: "f907e97c-0f19-401b-aa70-fb7e7b599adb", nativeArgumentKeys: Object.keys(input) } } } } });
test("continuation recovery is per agent, bounded, exact and shares ordinary scope validation", () => {
  const cache = createHarnessContinuations(), a = agent("first"), b = agent("second");
  const input = { companySlug: "synthetic-company", title: "private original" }, r = receipt(input);
  const next = structuredClone(r.structuredContent.providerSelection.arguments);
  cache.remember(a, "get_task", input, r, 1000);
  assert.equal(cache.recover(a, next, 1100).parameters.arguments.title, "private original");
  for (const [who, request, at] of [[b, next, 1100], [a, next, 1_000_000],
    [a, { ...next, route: "action" }, 1100],
    [a, { ...next, parameters: { ...next.parameters, arguments: { title: "forged" } } }, 1100]]) {
    assert.throws(() => cache.recover(who, request, at), { code: "LOCAL_CONTEXT_INVALID_INPUT" });
  }
  const changed = agent("compacted");
  const old = changed.session.append("user/message", { role: "user", content: [{ type: "text", text: "original" }] }, { surfaceOp: "append" });
  cache.remember(changed, "get_task", input, r, 1000);
  changed.session.append("user/message", { role: "user", content: [{ type: "text", text: "summary" }] },
    { surfaceOp: { op: "replace", startSeq: old.seq, endSeq: old.seq }, sourceEventSeqs: [old.seq] });
  assert.throws(() => cache.recover(changed, next, 1100), { code: "LOCAL_CONTEXT_INVALID_INPUT" });
  assert.throws(() => cache.remember(a, "get_task", { ...input, companySlug: "other" }, r, 1200), { code: "LOCAL_CONTEXT_INVALID_INPUT" });
});

test("fixed-origin connection reuses vault, negotiates once and never retries business calls", async () => {
  let stored = null, logins = 0, calls = 0, initializations = 0;
  const connection = createHarnessConnection({
    vault: { read: async () => stored, write: async (_origin, _identity, value) => { stored = value; } },
    httpJson: async url => { assert.equal(url, "https://trelio.ru/.well-known/oauth-authorization-server");
      return { body: { issuer: "https://trelio.ru", scopes_supported: ["mcp:read"] } }; },
    connectOAuth: async (config, options) => {
      logins++; assert.equal(config.endpoint, "https://trelio.ru/mcp");
      assert.equal(options.resource, config.endpoint);
      assert.equal(options.clientName, "Trelio – DeepSeek Harness");
      return { accessToken: "synthetic-native-token", expiresAt: Date.now() + 10_000 };
    },
    httpRequest: async ({ payload, credential, config }) => {
      assert.equal(credential, "synthetic-native-token");
      assert.ok(config.headers["x-trelio-host-runtime-version"]);
      if (payload.method === "initialize") { initializations++; return { message: { jsonrpc: "2.0", id: payload.id,
        result: { protocolVersion: "2025-03-26", instructions: "full" } } }; }
      if (payload.method === "notifications/initialized") return {};
      if (payload.method === "tools/list") return { message: { jsonrpc: "2.0", id: payload.id, result: { tools: [tool("get_task")] } } };
      calls++; throw Object.assign(new Error("synthetic ambiguous transport"), { code: "REMOTE_MCP_HTTP_ERROR" });
    },
  });
  await assert.rejects(connection.listTools(), { code: "TRELIO_HARNESS_AUTH_REQUIRED" });
  const connected = await connection.connect();
  assert.equal(Object.hasOwn(connected, "experimental"), false);
  await connection.listTools(); await connection.listTools();
  assert.equal(logins, 1); assert.equal(initializations, 1);
  await assert.rejects(connection.call("update_task_title", {}, signal()), { code: "REMOTE_MCP_HTTP_ERROR" });
  assert.equal(calls, 1); assert.equal(logins, 1);
  await connection.connect(); assert.equal(logins, 1);
  await connection.connect(signal(), true); assert.equal(logins, 2);
});

// These transports never open the user's OAuth vault or contact Trelio. The
// real HTTP fixture below still exercises the production response classifier.
const syntheticConnection = httpRequest => createHarnessConnection({
  httpRequest,
  httpJson: async () => ({ body: { issuer: "https://trelio.ru", scopes_supported: ["mcp:read"] } }),
  vault: { read: async () => ({ accessToken: "synthetic-native-token", expiresAt: Date.now() + 60_000 }),
    write: async () => assert.fail("session recovery must not replace OAuth") },
  connectOAuth: async () => assert.fail("session recovery must not open OAuth"),
});
const sessionRejected = () => new RemoteMcpHostError("REMOTE_MCP_SESSION_NOT_FOUND", "synthetic retired session");
const rpcSuccess = (payload, sessionId) => ({ sessionId, message: { jsonrpc: "2.0", id: payload.id,
  result: payload.method === "initialize" ? { protocolVersion: "2025-03-26" }
    : payload.method === "tools/list" ? { tools: [] } : { content: [] } } });

test("Harness recovers an expired HTTP session without OAuth or duplicate mutation dispatch", { timeout: 5_000 }, async t => {
  let activeSession, initializations = 0, rejected = 0, writes = 0;
  const acceptedArguments = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    if (payload.method === "initialize") {
      assert.equal(request.headers["mcp-session-id"], undefined, "fresh initialize cannot carry the retired header");
      activeSession = `synthetic-session-${++initializations}`;
    } else if (request.headers["mcp-session-id"] !== activeSession) {
      rejected++;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "MCP session not found." } }));
      return;
    }
    if (payload.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
    if (payload.params?.name === "update_task_title") { writes++; acceptedArguments.push(payload.params.arguments); }
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": activeSession });
    response.end(JSON.stringify(rpcSuccess(payload, activeSession).message));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const connection = syntheticConnection((args, options) => remoteMcpHttpRequest(args, {
    ...options, timeoutMs: 1_000,
    resolveEndpoint: async () => ({ endpoint: new URL(`http://mcp.test:${server.address().port}/mcp`), address: "127.0.0.1", family: 4 }),
  }));
  await connection.listTools();
  activeSession = null; // Same observable rejection as idle expiry/server restart.
  const args = { title: "Synthetic title", clientRequestId: "synthetic-request", runtimeSessionProof: { nonce: "synthetic-proof" } };
  await connection.call("update_task_title", args);
  assert.equal(initializations, 2);
  assert.equal(rejected, 1);
  assert.equal(writes, 1, "the rejected attempt never reached the mutation handler");
  assert.deepEqual(acceptedArguments, [args], "keep the original idempotency key and unconsumed method proof");
});

test("concurrent late rejections share one recovery and cannot retire the new generation", { timeout: 5_000 }, async () => {
  let initializations = 0, oldRequests = 0, releaseLateRejection;
  const lateRejection = new Promise(resolve => { releaseLateRejection = resolve; });
  const connection = syntheticConnection(async ({ payload, sessionId }) => {
    if (payload.method === "initialize") {
      assert.equal(sessionId, undefined);
      initializations++;
      return rpcSuccess(payload, `synthetic-${initializations}`);
    }
    if (payload.method === "tools/call" && sessionId === "synthetic-1") {
      if (++oldRequests === 2) await lateRejection;
      throw sessionRejected();
    }
    if (payload.method === "tools/call" && sessionId === "synthetic-2") releaseLateRejection();
    return rpcSuccess(payload, sessionId);
  });
  await connection.listTools();
  await Promise.all([connection.call("list_companies", {}), connection.call("get_my_context", {})]);
  await connection.call("get_my_context", {});
  assert.equal(initializations, 2);
  assert.equal(oldRequests, 2);
});

test("repeated session rejection is bounded and leaves the next call able to negotiate", async () => {
  let initializations = 0, attempts = 0, reject = true;
  const connection = syntheticConnection(async ({ payload, sessionId }) => {
    if (payload.method === "initialize") return rpcSuccess(payload, `synthetic-${++initializations}`);
    if (payload.method === "tools/call") { attempts++; if (reject) throw sessionRejected(); }
    return rpcSuccess(payload, sessionId);
  });
  await assert.rejects(connection.call("get_my_context", {}), { code: "REMOTE_MCP_SESSION_NOT_FOUND" });
  assert.equal(initializations, 2); assert.equal(attempts, 2);
  reject = false;
  await connection.call("get_my_context", {});
  assert.equal(initializations, 3); assert.equal(attempts, 3);
});

test("catalogue recovery is bounded; ambiguous/auth failures never retry a mutation", async () => {
  for (const code of ["REMOTE_MCP_HTTP_ERROR", "REMOTE_MCP_AUTH_REJECTED", "REMOTE_MCP_INSUFFICIENT_SCOPE", "REMOTE_MCP_TIMEOUT", "REMOTE_MCP_CONNECTION_CLOSED"]) {
    let initializations = 0, attempts = 0;
    const connection = syntheticConnection(async ({ payload, sessionId }) => {
      if (payload.method === "initialize") return rpcSuccess(payload, `synthetic-${++initializations}`);
      if (payload.method === "tools/call") { attempts++; throw new RemoteMcpHostError(code, "synthetic failure"); }
      return rpcSuccess(payload, sessionId);
    });
    await assert.rejects(connection.call("update_task_title", {}), { code });
    assert.equal(initializations, 1); assert.equal(attempts, 1);
  }
  let initializations = 0, catalogues = 0;
  const connection = syntheticConnection(async ({ payload, sessionId }) => {
    if (payload.method === "initialize") return rpcSuccess(payload, `synthetic-${++initializations}`);
    if (payload.method === "tools/list" && ++catalogues === 1) throw sessionRejected();
    return rpcSuccess(payload, sessionId);
  });
  await connection.listTools();
  assert.equal(initializations, 2); assert.equal(catalogues, 2);
});

test("cancellation after session rejection prevents handshake and replay", async () => {
  const controller = new AbortController();
  let initializations = 0, attempts = 0;
  const connection = syntheticConnection(async ({ payload, sessionId }) => {
    if (payload.method === "initialize") return rpcSuccess(payload, `synthetic-${++initializations}`);
    if (payload.method === "tools/call") { attempts++; controller.abort(); throw sessionRejected(); }
    return rpcSuccess(payload, sessionId);
  });
  await assert.rejects(connection.call("update_task_title", {}, controller.signal), error => error === controller.signal.reason);
  assert.equal(initializations, 1); assert.equal(attempts, 1);
});

test("explicit recovery survives a revoked grant without silently replacing it", async t => {
  const ctx = new Context(); new Prompt(ctx, {}); new Tools(ctx); t.after(() => ctx.fiber.dispose());
  await applyHarnessAdapter(ctx, { connection: { listTools: async () => { throw Object.assign(new Error("revoked"), { code: "REMOTE_MCP_AUTH_REJECTED" }); } } });
  assert.ok(ctx.tools.get("trelio_connect"));
});


test("native text compatibility preserves the shared complete skill-response budget", () => {
  const source = { content: [{ type: "text", text: "summary" }],
    structuredContent: { instructionsMarkdown: "private-overflow-marker" + "x".repeat(41000) } };
  const projected = projectHarnessMcpResult(source, "get_agent_skill");
  assert.equal(projected.isError, true);
  assert.ok(JSON.stringify(projected).includes("AGENT_SKILL_RESPONSE_TOO_LARGE"));
  assert.ok(!JSON.stringify(projected).includes("private-overflow-marker"));
  assert.ok(source.structuredContent.instructionsMarkdown.includes("private-overflow-marker"));
});
