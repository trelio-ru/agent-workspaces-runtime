import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readCodexConversationTitle, syncRunCodexConversationTitle } from "../host-runtime/scripts/trelio-codex-conversation.mjs";
import { protectLocalActionArguments } from "../host-runtime/scripts/trelio-local-context.mjs";
import { createAgentEncryptionDevice, decryptCompanyPayload } from "../host-runtime/scripts/trelio-company-encryption.mjs";
import { synchronizeRunCodexTitle } from "../host-runtime/scripts/trelio-workspace.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const snapshot = { conversationId: id, title: "Старое название", expectedStateHash: "a".repeat(64) };

const fakeServer = (respond) => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  const requests = [];
  let killed = false;
  child.kill = () => { killed = true; return true; };
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    requests.push(request);
    queueMicrotask(() => respond(request, child.stdout));
  });
  let options;
  let args;
  const spawnProcess = (_executable, passedArgs, passedOptions) => {
    args = passedArgs;
    options = passedOptions;
    return child;
  };
  return { child, requests, spawnProcess, get killed() { return killed; }, get options() { return options; }, get args() { return args; } };
};
const reply = (output, value) => output.write(`${JSON.stringify(value)}\n`);

test("exact App Server metadata read has no inventory, transcript or model calls", async () => {
  const server = fakeServer((request, output) => {
    if (request.id === 1) reply(output, { id: 1, result: {} });
    if (request.id === 2) {
      const bytes = JSON.stringify({ id: 2, result: { thread: { id, name: "  Новый план  " } } });
      output.write(bytes.slice(0, 9));
      output.write(`${bytes.slice(9)}\n`);
    }
  });
  assert.equal(await readCodexConversationTitle(id, { executable: "/exact/codex", spawnProcess: server.spawnProcess,
    environment: { PATH: "/bin", HOME: "/user", TRELIO_TOKEN: "excluded", OPENAI_API_KEY: "excluded", CODEX_THREAD_ID: "stale" } }), "Новый план");
  assert.deepEqual(server.requests.map((request) => request.method), ["initialize", "initialized", "thread/read"]);
  assert.deepEqual(server.requests[2].params, { threadId: id, includeTurns: false });
  assert.deepEqual(server.options.env, { PATH: "/bin", HOME: "/user" });
  assert.deepEqual(server.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(server.options.shell, false);
  assert.equal(server.options.stdio[2], "ignore");
  assert.equal(server.killed, true);
});

for (const [label, response] of [
  ["wrong exact ID", { thread: { id: "22222222-2222-4222-8222-222222222222", name: "Wrong" } }],
  ["missing name", { thread: { id } }],
  ["empty name", { thread: { id, name: "  " } }],
  ["oversized name", { thread: { id, name: "x".repeat(501) } }],
]) {
  test(`metadata read skips ${label} and cleans up`, async () => {
    const server = fakeServer((request, output) => {
      if (request.id === 1) reply(output, { id: 1, result: {} });
      if (request.id === 2) reply(output, { id: 2, result: response });
    });
    assert.equal(await readCodexConversationTitle(id, { executable: "/exact/codex", spawnProcess: server.spawnProcess }), null);
    assert.equal(server.killed, true);
  });
}

test("timeout, malformed and oversized responses close the optional child", async () => {
  for (const output of [null, "not JSON\n", "x".repeat(256 * 1024 + 1)]) {
    const server = fakeServer((_request, stream) => { if (output) stream.write(output); });
    assert.equal(await readCodexConversationTitle(id, { executable: "/exact/codex", spawnProcess: server.spawnProcess, timeoutMs: 10 }), null);
    assert.equal(server.killed, true);
  }
  const controller = new AbortController();
  const server = fakeServer(() => {});
  const pending = readCodexConversationTitle(id, { executable: "/exact/codex", spawnProcess: server.spawnProcess, signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(server.killed, true);
});

test("missing verified locator never starts title discovery", async () => {
  let reads = 0;
  for (const conversation of [null, { ...snapshot, conversationId: "unsupported" }, { ...snapshot, expectedStateHash: null }]) {
    assert.equal(await syncRunCodexConversationTitle({ readConversation: async () => conversation,
      readTitle: async () => { reads++; }, protectTitle: assert.fail, writeTitle: assert.fail }), false);
  }
  assert.equal(reads, 0);
});

test("unchanged title performs no encryption or write; renamed title carries live CAS", async () => {
  let writes = [];
  const options = { readConversation: async () => snapshot,
    readTitle: async (exactId) => { assert.equal(exactId, id); return snapshot.title; },
    protectTitle: async (title) => title,
    writeTitle: async (body) => { writes.push(body); } };
  assert.equal(await syncRunCodexConversationTitle({ ...options, protectTitle: assert.fail }), false);
  assert.deepEqual(writes, []);
  assert.equal(await syncRunCodexConversationTitle({ ...options, readTitle: async () => " Новое название " }), true);
  assert.deepEqual(writes, [{ ...snapshot, title: "Новое название" }]);
});

test("optional denied/old route/CAS/write errors preserve work without replay", async () => {
  let attempts = 0;
  const options = { readConversation: async () => snapshot, readTitle: async () => "Renamed",
    protectTitle: async (title) => title, writeTitle: async () => { attempts++; throw new Error("Ambiguous write"); } };
  assert.equal(await syncRunCodexConversationTitle(options), false);
  assert.equal(attempts, 1);
  for (const stage of ["readConversation", "readTitle", "protectTitle"]) {
    assert.equal(await syncRunCodexConversationTitle({ ...options, [stage]: async () => { throw new Error("Unavailable"); } }), false);
  }
  assert.equal(attempts, 1);
});

test("encrypted renamed title reaches the writer only as existing field-bound ciphertext", async () => {
  const device = await createAgentEncryptionDevice();
  const companyEncryption = { runtime: { company: { id, slug: "acme" },
    scope: { id: "22222222-2222-4222-8222-222222222222", epoch: 1, publicEncryptionJwk: device.publicEncryptionJwk },
    device: { id: "33333333-3333-4333-8333-333333333333" } }, device };
  const title = "Confidential new title";
  let protectedRequest;
  assert.equal(await syncRunCodexConversationTitle({ readConversation: async () => snapshot,
    readTitle: async () => title, protectTitle: async (value) => {
      protectedRequest = await protectLocalActionArguments({ nativeTool: "sync_codex_conversation_titles",
        arguments: { title: value }, companyEncryption });
      return protectedRequest.value.title;
    }, writeTitle: async (body) => {
      assert.match(body.title, /^~e1:[^:]+:title~$/u);
      assert.equal(JSON.stringify(body).includes(title), false);
      assert.equal(JSON.stringify(protectedRequest.payloads).includes(title), false);
      const payload = protectedRequest.payloads[0];
      assert.equal(payload.entityType, "api.browser_mutation");
      const opened = await decryptCompanyPayload({ encryptedPayload: payload,
        scopePrivateKey: device.privateKeys.encryptionPrivateKey, scopePrivateJwk: device.privateBundle.encryptionPrivateJwk });
      assert.equal(opened.values.title, title);
    } }), true);
});

test("lifecycle transport retries only GET, carries the exact lease and skips named Workspaces", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let failures = 3;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), ...options });
    if (!options.method && failures-- > 0) throw new TypeError("fixture transport failure");
    if (options.method === "PUT") return new Response("{}", { status: 503 });
    return Response.json({ conversation: snapshot });
  };
  const metadata = { scopeType: "task", runId: "22222222-2222-4222-8222-222222222222",
    leaseId: "33333333-3333-4333-8333-333333333333", fencingToken: 7 };
  try {
    await synchronizeRunCodexTitle({ metadata, workspaceOrigin: "https://trelio.example.test", token: "fixture",
      readTitle: async (exactId) => { assert.equal(exactId, id); return "Changed"; } });
    assert.equal(requests.length, 5);
    assert.ok(requests.every((request) => request.url === `https://trelio.example.test/api/agent-workspaces/runs/${metadata.runId}/codex-conversation`));
    assert.deepEqual(JSON.parse(requests[4].body), { conversationId: id, expectedStateHash: snapshot.expectedStateHash,
      title: "Changed", leaseId: metadata.leaseId, fencingToken: metadata.fencingToken });
    await synchronizeRunCodexTitle({ metadata: { ...metadata, scopeType: "workspace" } });
    assert.equal(requests.length, 5);
    requests.length = 0;
    globalThis.fetch = async () => { requests.push({}); return new Response("{}", { status: 404 }); };
    await synchronizeRunCodexTitle({ metadata, workspaceOrigin: "https://trelio.example.test", token: "fixture", readTitle: assert.fail });
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("lifecycle E2EE transport uploads a signed title payload before sending only its marker", async () => {
  const originalFetch = globalThis.fetch;
  const device = await createAgentEncryptionDevice();
  const companyEncryption = { runtime: { company: { id, slug: "acme" },
    scope: { id: "22222222-2222-4222-8222-222222222222", epoch: 1, publicEncryptionJwk: device.publicEncryptionJwk },
    device: { id: "33333333-3333-4333-8333-333333333333" } }, device };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), ...options });
    return options.method ? Response.json({ syncedCount: 1 }) : Response.json({ conversation: { ...snapshot, title: null } });
  };
  try {
    await synchronizeRunCodexTitle({ metadata: { scopeType: "task", runId: id, leaseId: id, fencingToken: 1 },
      workspaceOrigin: "https://e2ee.trelio.ru", token: "fixture", companyEncryption, readTitle: async () => "Private new title" });
    assert.equal(requests.length, 3);
    assert.equal(requests[1].url, "https://e2ee.trelio.ru/api/agent-workspaces/encryption/payloads");
    assert.equal(requests[2].method, "PUT");
    const payload = JSON.parse(requests[1].body).payloads[0];
    assert.equal(payload.entityType, "api.browser_mutation");
    assert.ok(payload.signature);
    assert.equal(JSON.parse(requests[2].body).title, `~e1:${payload.entityId}:title~`);
    assert.ok(requests.every((request) => !request.body?.includes("Private new title")));
  } finally { globalThis.fetch = originalFetch; }
});
