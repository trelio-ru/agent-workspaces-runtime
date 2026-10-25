/** Qualification against published native Harness core, with synthetic MCP
 * and no model/account/network. This deliberately uses the real immutable
 * execution pipeline and Session header fold, not a mock tool registry.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { applyHarnessAdapter, createHarnessConnection, createHarnessContinuations,
  harnessToolName, observeHarnessRuntime, projectHarnessMcpResult } from "../host-runtime/scripts/trelio-deepseek-harness.mjs";

const require = createRequire(new URL("./fixtures/deepseek-native/package.json", import.meta.url));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const [{ Context }, { default: Tools }, { default: Prompt }, { Session }] = await Promise.all(
  ["cordis", "dsh-tools", "dsh-system-prompt", "dsh-session"].map(load));
assert.equal(require("@deepseek-ai/dsh-tools/package.json").version, "0.2.1-rc.2");
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

test("real native pipeline preserves structured authority and hides dispatch-only proof", async t => {
  const ctx = new Context(); new Prompt(ctx, {}); new Tools(ctx);
  t.after(() => ctx.fiber.dispose());
  const observed = [], calls = [];
  await applyHarnessAdapter(ctx, {
    connection: { listTools: async () => [tool("get_task"), tool("hidden", { _meta: { ui: { visibility: ["app"] } } })],
      instructions: () => "server instructions", call: async (method, args) => { calls.push({ method, args }); return result; } },
    localMessage: async () => ({ result: { tools: [] } }),
    prepare: async input => { observed.push(input); return { ...input.input, runtimeSessionProof: { test: "private-dispatch" } }; },
  });
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
  // Real request-header replacement supplies the new model/effort. No old
  // high effort may be borrowed after the user disables reasoning.
  a.session.append("request/header", { reason: "change", header: { config: { provider: "custom", model: "next", reasoningEffort: "off" } } });
  assert.equal(observeHarnessRuntime({ agent: a }).observation.effortLevel, null);
  assert.equal(observeHarnessRuntime({ agent: a }).observation.modelId, "custom/next");
});

test("native observation refuses missing request header; binary and hidden metadata are never text", () => {
  assert.throws(() => observeHarnessRuntime({ agent: { session: Session.create("missing") } }), { code: "TRELIO_RUNTIME_OBSERVATION_REQUIRED" });
  const projected = projectHarnessMcpResult({ ...result,
    content: [...result.content, { type: "image", data: "private-binary", mimeType: "image/png" }] });
  assert.ok(!JSON.stringify(projected).includes("private-binary"));
  assert.ok(!JSON.stringify(projected).includes("hidden-test"));
  assert.equal(harnessToolName("trelio", "x".repeat(100)).length, 64);
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
  await connection.connect(); await connection.listTools(); await connection.listTools();
  assert.equal(logins, 1); assert.equal(initializations, 1);
  await assert.rejects(connection.call("update_task_title", {}, signal()), { code: "REMOTE_MCP_HTTP_ERROR" });
  assert.equal(calls, 1); assert.equal(logins, 1);
  await connection.connect(); assert.equal(logins, 1);
  await connection.connect(signal(), true); assert.equal(logins, 2);
});

test("explicit recovery survives a revoked grant without silently replacing it", async t => {
  const ctx = new Context(); new Prompt(ctx, {}); new Tools(ctx); t.after(() => ctx.fiber.dispose());
  await applyHarnessAdapter(ctx, { connection: { listTools: async () => { throw Object.assign(new Error("revoked"), { code: "REMOTE_MCP_AUTH_REJECTED" }); } } });
  assert.ok(ctx.tools.get("trelio_connect"));
});
