import assert from "node:assert/strict";
import test from "node:test";
import { createGigaCodeMcpHandler } from "../host-runtime/scripts/trelio-gigacode-mcp.mjs";
import { resolveHostRuntimeInvocation } from "../host-runtime/scripts/trelio-host-runtime-entry.mjs";
import { detectAgentRuntimeAttestation } from "../host-runtime/scripts/trelio-runtime-attestation.mjs";

const TOKEN = "synthetic-gigacode-access-token";
const record = () => ({ issuer: "https://trelio.ru", clientId: "trelio_gigacode_agent_workspaces_v1",
  accessToken: TOKEN, refreshToken: null, expiresAt: Date.now() + 3600000 });
const message = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const fixture = (options = {}) => {
  let stored = options.stored ?? null;
  const calls = [], connects = [], writes = [];
  const vault = { read: async () => stored, write: async (_origin, _identity, value) => { writes.push(value); stored = value; } };
  const handler = createGigaCodeMcpHandler({ platform: "darwin", vault,
    connect: async (_config, args) => { connects.push(args); return record(); },
    httpRequest: async (request, args) => {
      calls.push({ request, args });
      if (request.method === "DELETE") return { statusCode: 200, message: null };
      const { payload } = request;
      if (!payload.id) return { statusCode: 202, sessionId: "synthetic-session", message: null };
      const result = payload.method === "initialize" ? { protocolVersion: "2025-03-26",
        serverInfo: { name: "native-trelio", version: "0.0.0" }, instructions: "Synthetic native authority route" }
        : payload.method === "tools/list" ? { tools: [{ name: "get_task", inputSchema: { type: "object" } }], nextCursor: "native-cursor" }
        : { content: [{ type: "text", text: "native result" }], structuredContent: { native: true },
          _meta: { "mcp/www_authenticate": ["synthetic challenge"], "private/native": "preserved" } };
      return { statusCode: 200, sessionId: "synthetic-session", message: { jsonrpc: "2.0", id: payload.id, result } };
    }, ...options,
  });
  return { handler, calls, connects, writes };
};

test("signed mcp subprofile preserves the shell ABI and rejects extra flags", () => {
  const invocation = resolveHostRuntimeInvocation(["mcp", "gigacode"]);
  assert.match(invocation.entrypointPath, /trelio-gigacode-mcp\.mjs$/);
  assert.equal(invocation.profile, "gigacode");
  assert.deepEqual(invocation.arguments, []);
  assert.throws(() => resolveHostRuntimeInvocation(["mcp", "gigacode", "--token"]), /ARGUMENTS_UNSUPPORTED/);
});

test("GigaCode hook cannot borrow Codex or Claude model evidence", async () => {
  const observed = await detectAgentRuntimeAttestation({
    hookInput: { session_id: "synthetic-session", model: "gpt-6.1-sol", effort: { level: "ultra" }, transcript_path: "/must-not-read" },
    environment: { GIGACODE_PROJECT_DIR: "/synthetic-root", CODEX_THREAD_ID: "inherited", CLAUDE_CODE_ENTRYPOINT: "inherited" },
  });
  assert.equal(observed.clientFamily, "other");
  assert.equal(observed.source, "unknown");
  assert.equal(observed.evidenceLevel, "unavailable");
  assert.equal(observed.modelId, null);
  assert.equal(observed.effortLevel, null);
});

test("bootstrap never opens OAuth or returns credentials during enumeration", async () => {
  const f = fixture();
  const initialized = await f.handler(message(1, "initialize"));
  assert.equal(initialized.result.capabilities.tools.listChanged, true);
  assert.equal((await f.handler(message(2, "tools/list"))).result.tools[0].name, "connect_trelio_gigacode");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.connects, []);
  assert.deepEqual((await f.handler(message(3, "ping"))).result, {});
});

test("browser consent persists once, reads back, notifies catalogue and forwards native guards", async () => {
  const f = fixture();
  const notifications = [];
  const result = await f.handler(message(1, "tools/call", { name: "connect_trelio_gigacode", arguments: {} }),
    { notifyClient: async name => notifications.push(name) });
  assert.equal(result.error, undefined);
  assert.equal(f.connects.length, 1);
  assert.equal(f.connects[0].fixedClientId, record().clientId);
  assert.equal(f.connects[0].resource, "https://trelio.ru/mcp");
  assert.equal(f.connects[0].useSupportedScopes, true);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(notifications, ["notifications/tools/list_changed"]);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.match(result.result.content[0].text, /Synthetic native authority/);
  await f.handler(message(2, "tools/call", { name: "connect_trelio_gigacode", arguments: {} }));
  assert.equal(f.connects.length, 1, "working stored authorization must be reused");
  const tools = await f.handler(message(3, "tools/list"));
  assert.deepEqual(tools.result.tools.map(tool => tool.name), ["connect_trelio_gigacode", "get_task"]);
  assert.equal(tools.result.nextCursor, "native-cursor");
  const args = { companySlug: "synthetic", runtimeSessionProof: { invalid: true } };
  const returned = await f.handler(message(4, "tools/call", { name: "get_task", arguments: args }));
  const forwarded = f.calls.findLast(call => call.request.payload?.method === "tools/call").request;
  assert.deepEqual(forwarded.payload.params.arguments, args, "supplied proof must reach native validation unchanged");
  assert.equal(forwarded.config.endpoint, "https://trelio.ru/mcp");
  assert.equal(returned.id, 4);
  assert.equal(returned.result._meta["private/native"], "preserved");
  assert.equal(f.calls[0].request.payload.params.capabilities.elicitation, undefined);
});

test("unknown mutation outcome is never replayed or exposed with its native cause", async () => {
  let attempts = 0;
  const f = fixture({ stored: record() });
  const failing = createGigaCodeMcpHandler({ platform: "darwin",
    vault: { read: async () => record() },
    httpRequest: async request => {
      if (request.method === "DELETE") return { statusCode: 200, message: null };
      if (request.payload.method === "initialize") return { sessionId: "fixture", message: {
        jsonrpc: "2.0", id: request.payload.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "fixture", version: "0" } } } };
      if (request.payload.method === "notifications/initialized") return { statusCode: 202 };
      attempts++;
      assert.equal(request.payload.params.name, "create_task");
      throw new Error(`private failure ${request.credential}`);
    },
  });
  const result = await failing(message(2, "tools/call", { name: "create_task", arguments: { title: "synthetic" } }));
  assert.equal(attempts, 1);
  assert.equal(result.error.message, "TRELIO_GIGACODE_CONNECTION_FAILED");
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.equal(f.connects.length, 0);
});

test("revoked authorization and transient failures retain the setup tool without automatic login", async () => {
  for (const [error, expected] of [[Object.assign(new Error("private response"), { code: "REMOTE_MCP_AUTH_REJECTED" }), "TRELIO_GIGACODE_AUTH_REJECTED"],
    [new Error(`private network ${TOKEN}`), "TRELIO_GIGACODE_CONNECTION_FAILED"]]) {
    const f = fixture({ stored: record(), httpRequest: async () => { throw error; } });
    const initialized = await f.handler(message(1, "initialize"));
    assert.equal(initialized.error, undefined, "bootstrap must remain connected for recovery");
    assert.match(initialized.result.instructions, new RegExp(expected));
    const listed = await f.handler(message(2, "tools/list"));
    assert.equal(listed.result.tools.length, 1);
    assert.equal(listed.result.tools[0].name, "connect_trelio_gigacode");
    assert.match(listed.result.tools[0].description, new RegExp(expected));
    assert.ok(!JSON.stringify([initialized, listed]).includes(TOKEN));
    assert.equal(f.connects.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

test("unsupported OS, malformed local state and failed read-back never fall back", async () => {
  for (const platform of ["win32", "linux"]) {
    const f = fixture({ platform });
    assert.equal((await f.handler(message(1, "tools/list"))).error.message, "TRELIO_GIGACODE_PLATFORM_UNSUPPORTED");
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.connects, []);
  }
  const wrong = fixture({ stored: { ...record(), issuer: "https://evil.example" } });
  assert.match((await wrong.handler(message(1, "initialize"))).result.instructions, /TRELIO_GIGACODE_SESSION_INVALID/);
  assert.equal((await wrong.handler(message(2, "tools/call", { name: "connect_trelio_gigacode" }))).error.message, "TRELIO_GIGACODE_SESSION_INVALID");
  assert.deepEqual(wrong.calls, []);
  const recovered = await wrong.handler(message(3, "tools/call", {
    name: "connect_trelio_gigacode", arguments: { reauthorize: true },
  }));
  assert.equal(recovered.error, undefined, "explicit consent can replace an invalid old record");
  assert.equal(wrong.connects.length, 1);
  assert.equal(wrong.writes.length, 1);
  let reads = 0;
  const failed = fixture({ vault: { read: async () => { reads++; return null; }, write: async () => {} } });
  const result = await failed.handler(message(1, "tools/call", { name: "connect_trelio_gigacode" }));
  assert.ok(reads >= 2);
  assert.equal(result.error.message, "TRELIO_GIGACODE_STORE_FAILED");
  assert.deepEqual(failed.calls, []);
});
