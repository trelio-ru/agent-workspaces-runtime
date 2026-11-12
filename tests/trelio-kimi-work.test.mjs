import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildKimiWorkBundle, installKimiWorkBundle } from "../host-runtime/scripts/trelio-workspace.mjs";
import { createHarnessConnection, createKimiMcpHandler, createKimiLocalMcpHandler, runKimiStdioHost } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { connectRemoteMcpOAuth } from "../host-runtime/scripts/trelio-remote-mcp-oauth.mjs";
import { remoteMcpOAuthSessionAccount } from "../host-runtime/scripts/trelio-remote-mcp-oauth-vault.mjs";
import { pluginDirectory } from "./test-layout.mjs";

const origin = "https://trelio.ru";
const metadata = { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
  code_challenge_methods_supported: ["S256"], scopes_supported: ["mcp:read", "mcp:workspaces:read", "mcp:workspaces:write"] };
const signal = () => new AbortController().signal;
const call = (name, args = {}, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const output = value => ({ content: [{ type: "text", text: "routing summary" }], structuredContent: value,
  _meta: { privateAppGrant: "must-never-be-serialized" } });

test("Kimi installer prepares a fresh signed launch after Plugin Builder updates the previous manifest", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-kimi-install-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { pluginRoot: pluginDirectory, configDirectory: directory };
  const result = await installKimiWorkBundle(options);
  assert.equal(result.installedInKimiWork, false);
  const manifestPath = path.join(result.bundleDirectory, "kimi.plugin.json");
  const originalManifest = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(originalManifest);
  assert.equal(manifest.name, "trelio-agent-workspaces");
  assert.equal(manifest.version, "0.1.1");
  assert.equal(manifest.interface.iconUrl, "https://trelio.ru/favicon-v2.png");
  assert.deepEqual(Object.keys(manifest.mcpServers), ["trelio", "trelio-remote-skills"]);
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers.trelio.command, path.basename(process.execPath));
  assert.equal(path.isAbsolute(manifest.mcpServers.trelio.command), false, "Kimi rejects absolute plugin command paths");
  assert.deepEqual(manifest.mcpServers.trelio.args, ["./bootstrap.mjs", "remote"]);
  assert.deepEqual(manifest.mcpServers["trelio-remote-skills"].args, ["./bootstrap.mjs", "local"]);
  const bootstrap = await fs.readFile(path.join(result.bundleDirectory, "bootstrap.mjs"), "utf8");
  assert.match(bootstrap, /await runHostRuntimeLoader\(/u);
  assert.match(bootstrap, /\['mcp','--kimi-work',profile\]/u);
  assert.doesNotMatch(bootstrap, /selectHostRuntime|selected.runtimeDirectory/u);
  assert.match(bootstrap, /TRELIO_NODE_22_REQUIRED/u);
  assert.doesNotMatch(bootstrap, /accessToken|runtimeSessionProof|CODEX_THREAD_ID/u);
  manifest.interface.category = "productivity";
  const importedManifest = JSON.stringify(manifest, null, 2);
  await fs.writeFile(manifestPath, importedManifest);
  const next = await installKimiWorkBundle(options);
  assert.notEqual(next.bundleDirectory, result.bundleDirectory);
  assert.equal(await fs.readFile(manifestPath, "utf8"), importedManifest);
  assert.equal(await fs.readFile(path.join(next.bundleDirectory, "kimi.plugin.json"), "utf8"), originalManifest);
  assert.equal(await fs.readFile(path.join(next.bundleDirectory, "bootstrap.mjs"), "utf8"), bootstrap);
});

test("parallel Kimi installs succeed with a modified legacy digest bundle and leave it intact", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-kimi-legacy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pluginRoot = await fs.realpath(pluginDirectory);
  const files = buildKimiWorkBundle({ pluginRoot });
  const manifest = JSON.parse(files["kimi.plugin.json"]);
  manifest.version = "0.1.0";
  delete manifest.interface.iconUrl;
  const legacyFiles = { ...files, "kimi.plugin.json": `${JSON.stringify(manifest, null, 2)}\n` };
  const digest = crypto.createHash("sha256").update(JSON.stringify(legacyFiles)).digest("hex");
  const legacy = path.join(directory, "native-clients", "kimi-work", "bundles", digest);
  await fs.mkdir(legacy, { recursive: true, mode: 0o700 });
  manifest.interface.category = "productivity";
  const changedManifest = JSON.stringify(manifest);
  await fs.writeFile(path.join(legacy, "kimi.plugin.json"), changedManifest, { mode: 0o600 });
  await fs.writeFile(path.join(legacy, "bootstrap.mjs"), files["bootstrap.mjs"], { mode: 0o600 });

  const options = { pluginRoot, configDirectory: directory };
  const [first, second] = await Promise.all([installKimiWorkBundle(options), installKimiWorkBundle(options)]);
  assert.equal(new Set([first.bundleDirectory, second.bundleDirectory, legacy]).size, 3);
  for (const { bundleDirectory } of [first, second]) {
    for (const [name, content] of Object.entries(files)) {
      assert.equal(await fs.readFile(path.join(bundleDirectory, name), "utf8"), content);
    }
  }
  assert.equal(await fs.readFile(path.join(legacy, "kimi.plugin.json"), "utf8"), changedManifest);
  assert.equal(await fs.readFile(path.join(legacy, "bootstrap.mjs"), "utf8"), files["bootstrap.mjs"]);
});

test("generated Kimi bootstrap runs both profiles through updating loader MCP and enforces Node 22+", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-kimi-bootstrap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts"); await fs.mkdir(scripts);
  // Only the loader boundary is synthetic. Execute the generated file with
  // real Node so invalid manifest commands, interpolation or import ordering
  // cannot pass as a successful native startup based on a string assertion.
  await fs.writeFile(path.join(scripts, "trelio-host-runtime-loader.mjs"),
    "export const runHostRuntimeLoader=async({rawArguments})=>{if(process.env.TRELIO_WORKSPACE_CLIENT_PROFILE!=='kimi-work')throw Error('profile lost'); if(rawArguments.length!==3||rawArguments[0]!=='mcp'||rawArguments[1]!=='--kimi-work'||!['remote','local'].includes(rawArguments[2]))throw Error('loader MCP update bypassed'); process.stdout.write(rawArguments[2]); return 0;};");
  const run = (profile, preloads = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preloads, "./bootstrap.mjs", profile], { cwd: root, shell: false,
      stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
  });
  const files = buildKimiWorkBundle({ pluginRoot: root });
  await fs.writeFile(path.join(root, "bootstrap.mjs"), files["bootstrap.mjs"]);
  for (const profile of ["remote", "local"]) {
    const result = await run(profile); assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, profile);
  }
  // Only the reported major is synthetic; parsing, import ordering and both
  // startup functions still execute in real Node. No obsolete binary or PATH
  // mutation is needed to check this pre-loader compatibility boundary.
  const versionFile = path.join(root, "node-version.mjs");
  await fs.writeFile(versionFile, "Object.defineProperty(process.versions,'node',{value:'20.19.0'});");
  const refused = await run("remote", ["--import", pathToFileURL(versionFile).href]);
  assert.notEqual(refused.code, 0); assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /TRELIO_NODE_22_REQUIRED/u);
  await fs.writeFile(versionFile, "Object.defineProperty(process.versions,'node',{value:'24.1.0'});");
  const compatible = await run("remote", ["--import", pathToFileURL(versionFile).href]);
  assert.equal(compatible.code, 0, compatible.stderr); assert.equal(compatible.stdout, "remote");
});

test("actual signed-runtime entry selects both Kimi carriers and rejects malformed or unnamespaced startup", async t => {
  const { spawnSync } = await import("node:child_process");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-kimi-entry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(new URL("../host-runtime/scripts/trelio-host-runtime-entry.mjs", import.meta.url));
  const remote = fileURLToPath(new URL("../host-runtime/scripts/trelio-remote-mcp.mjs", import.meta.url));
  const env = { ...process.env, HOME: directory, USERPROFILE: directory,
    LOCALAPPDATA: path.join(directory, "local"), XDG_CACHE_HOME: path.join(directory, "cache"),
    CODEX_HOME: path.join(directory, "foreign-codex"),
    TRELIO_PLUGIN_VERSION: "3.2.5", TRELIO_HOST_RUNTIME_VERSION: "3.31.4",
    TRELIO_WORKSPACE_CLIENT_PROFILE: "kimi-work" };
  const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26" } }) + "\n";
  for (const profile of ["remote", "local"]) {
    const result = spawnSync(process.execPath, [entry, "mcp", "--kimi-work", profile],
      { env, input, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    const messages = result.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 1);
    assert.equal(messages[0].result.serverInfo.name, profile === "remote" ? "trelio-kimi-work" : "trelio-remote-skills");
    assert.equal(messages[0].result.serverInfo.version, "3.31.4");
  }
  // Exercise BOTH actual executables: a selector alone never selects common
  // OAuth/bridge storage, and an unknown argument never starts ordinary MCP.
  for (const executable of [entry, remote]) {
    for (const args of [["--kimi-work"], ["--kimi-work", "other"], ["--kimi-work", "local", "extra"]]) {
      const result = spawnSync(process.execPath, [executable, ...(executable === entry ? ["mcp"] : []), ...args],
        { env, input, encoding: "utf8", timeout: 20_000 });
      assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
      assert.match(result.stderr, /TRELIO_MCP_ARGUMENTS_UNSUPPORTED/u);
    }
    for (const profile of ["remote", "local"]) {
      const withoutNamespace = { ...env }; delete withoutNamespace.TRELIO_WORKSPACE_CLIENT_PROFILE;
      const result = spawnSync(process.execPath, [executable, ...(executable === entry ? ["mcp"] : []), "--kimi-work", profile],
        { env: withoutNamespace, input, encoding: "utf8", timeout: 20_000 });
      assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
      assert.match(result.stderr, /TRELIO_KIMI_PROFILE_REQUIRED/u);
    }
  }
  await assert.rejects(fs.stat(path.join(directory, "foreign-codex")), { code: "ENOENT" });
});

test("Kimi uses the real S256/state/loopback OAuth engine and a distinct native vault cell", async () => {
  let credential, authorize, exchange, writes = 0, dcrCalls = 0;
  const httpJson = async (url, options = {}) => {
    if (url.includes(".well-known")) return { body: metadata };
    if (url === metadata.registration_endpoint) { dcrCalls++; throw new Error("fixed profile must not use DCR"); }
    assert.equal(url, metadata.token_endpoint);
    exchange = new URLSearchParams(options.body);
    return { body: { access_token: "synthetic-kimi-oauth", token_type: "Bearer", expires_in: 3600,
      scope: metadata.scopes_supported.join(" ") } };
  };
  const connection = createHarnessConnection({ nativeClient: "kimi-work", httpJson,
    vault: { read: async () => credential, write: async (_origin, _identity, value) => { writes++; credential = value; } },
    connectOAuth: (config, options) => connectRemoteMcpOAuth(config, { ...options, httpJson,
      openBrowserFn: async url => {
        authorize = new URL(url);
        assert.equal(authorize.searchParams.get("client_id"), "trelio_kimi_work_agent_workspaces_v1");
        assert.equal(authorize.searchParams.get("resource"), `${origin}/mcp`);
        const callback = new URL(authorize.searchParams.get("redirect_uri"));
        assert.equal(callback.hostname, "127.0.0.1"); assert.equal(callback.pathname, "/callback");
        callback.searchParams.set("state", authorize.searchParams.get("state"));
        callback.searchParams.set("code", "synthetic-code");
        const response = await fetch(callback); assert.equal(response.status, 200);
      } }),
    httpRequest: async ({ payload, credential: token }) => {
      assert.equal(token, "synthetic-kimi-oauth");
      if (!payload.id) return { body: null };
      return { sessionId: "synthetic-mcp", message: { jsonrpc: "2.0", id: payload.id,
        result: payload.method === "initialize" ? { protocolVersion: "2025-03-26", instructions: "server authority" }
          : { tools: [] } } };
    } });
  assert.equal((await connection.connect(signal())).connected, true);
  assert.equal(dcrCalls, 0); assert.equal(writes, 1);
  assert.equal(exchange.get("client_id"), "trelio_kimi_work_agent_workspaces_v1");
  assert.equal(exchange.get("redirect_uri"), authorize.searchParams.get("redirect_uri"));
  assert.equal(crypto.createHash("sha256").update(exchange.get("code_verifier")).digest("base64url"), authorize.searchParams.get("code_challenge"));
  assert.equal((await connection.connect(signal())).saving, "not_checked");
  assert.equal(writes, 1, "valid existing authorization is reused");
  const resolved = { remoteMcp: { configFingerprint: "synthetic" } };
  assert.notEqual(remoteMcpOAuthSessionAccount(origin, resolved, "native", "kimi-work"),
    remoteMcpOAuthSessionAccount(origin, resolved, "native", "deepseek-harness"));
});

test("Kimi reads tasks in the first and later chats using a cached startup catalogue", async () => {
  const input = new PassThrough(), stream = new PassThrough();
  let connected = false, connects = 0, calls = 0, sequence = 0, pending = new Map(), lineBuffer = "";
  const notifications = [];
  stream.on("data", bytes => {
    lineBuffer += bytes.toString();
    for (;;) {
      const end = lineBuffer.indexOf("\n"); if (end < 0) break;
      const row = JSON.parse(lineBuffer.slice(0, end)); lineBuffer = lineBuffer.slice(end + 1);
      if (row.id === undefined) notifications.push(row); else { pending.get(row.id)?.(row); pending.delete(row.id); }
    }
  });
  const request = (method, params) => new Promise(resolve => {
    const id = ++sequence; pending.set(id, resolve); input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const encryptedRead = { companySlug: "synthetic-encrypted" };
  const localReadArguments = { schemaVersion: 1, route: "action", parameters: {
    companySlug: encryptedRead.companySlug, nativeTool: "get_agent_instructions", arguments: {},
  } };
  const encryptedRoute = { code: "MCP_LOCAL_CONTEXT_REQUIRED", providerSelection: {
    automatic: true, provider: "local_company_context", server: "trelio-remote-skills",
    tool: "continue_trelio_local_action", companySlug: encryptedRead.companySlug,
    nativeTool: "get_agent_instructions", route: "action", arguments: localReadArguments,
    nativeArgumentsTarget: "parameters.arguments",
  } };
  const connection = { instructions: () => "COMPLETE SERVER INSTRUCTIONS", connect: async () => {
    connects++;
    connected = true; return { connected: true, protectedRead: "not_checked", saving: "not_checked" };
  }, listTools: async () => {
    if (!connected) throw Object.assign(new Error(), { code: "TRELIO_KIMI_AUTH_REQUIRED" });
    return [{ name: "get_agent_instructions", inputSchema: { type: "object", properties: { runtimeSessionProof: {} } } },
      { name: "search_trelio_tools" },
      { name: "list_my_tasks", inputSchema: { type: "object", properties: { companySlug: { type: "string" },
        dueState: { enum: ["overdue"] }, runtimeSessionProof: {} }, required: ["companySlug", "runtimeSessionProof"] } },
      { name: "prepare_agent_secret_browser_fill" }, { name: "app_only", _meta: { ui: { visibility: ["app"] } } }];
  }, call: async (method, args) => {
    calls++;
    if (method === "search_trelio_tools") {
      assert.deepEqual(args, { query: "my overdue tasks", limit: 5 });
      return output({ tools: [{ name: "list_my_tasks" }, { name: "app_only" }] });
    }
    if (method === "list_my_tasks") {
      assert.deepEqual(args, { companySlug: "synthetic-company", dueState: "overdue" });
      return output({ tasks: [{ title: "Overdue task" }] });
    }
    assert.equal(method, "get_agent_instructions");
    if (args.companySlug === encryptedRead.companySlug) {
      assert.deepEqual(args, encryptedRead);
      return output(encryptedRoute);
    }
    assert.deepEqual(args, { companySlug: "synthetic-company" });
    return output({ effectiveInstructions: { markdown: "FULL AUTHORITY" } });
  } };
  const running = runKimiStdioHost({ inputStream: input, outputStream: stream, connection,
    startupTrace() {}, diagnosticReporter: { record() {}, close() {} },
    environment: { CODEX_HOME: "/must-not-migrate-codex", CODEX_THREAD_ID: "foreign" } });
  try {
    assert.equal((await request("initialize", { protocolVersion: "2025-03-26" })).result.capabilities.tools.listChanged, true);
    const initial = (await request("tools/list")).result.tools.map(tool => tool.name);
    assert.deepEqual(initial, ["trelio_connect", "trelio_find_tools", "trelio_call_tool"]);
    // Work had loaded only the initial catalogue in the affected chat. Simulate
    // that client on the real line protocol, without a second tools/list call.
    const initialCall = (name, args) => {
      assert.ok(initial.includes(name), "the client can only call tools from its initial list");
      return request("tools/call", { name, arguments: args });
    };
    const beforeLogin = await initialCall("trelio_find_tools", { query: "list_my_tasks" });
    assert.equal(beforeLogin.result.structuredContent.code, "TRELIO_KIMI_AUTH_REQUIRED");
    assert.equal(calls, 0);
    const connectedResult = await initialCall("trelio_connect", {});
    assert.equal(connectedResult.result.structuredContent.saving, "not_checked");
    assert.match(connectedResult.result.structuredContent.instructions, /same chat/u);
    assert.equal(notifications[0].method, "notifications/tools/list_changed");
    const found = await initialCall("trelio_find_tools", { query: "my overdue tasks" });
    assert.deepEqual(found.result.structuredContent.tools, [{ name: "list_my_tasks" }]);
    const selected = await initialCall("trelio_find_tools", { query: "list_my_tasks" });
    const exact = selected.result.structuredContent.tool;
    assert.deepEqual(exact.inputSchema.required, ["companySlug"]);
    assert.equal(exact.inputSchema.properties.runtimeSessionProof, undefined);
    const result = await initialCall("trelio_call_tool", { name: exact.name, arguments: {
      companySlug: "synthetic-company", dueState: "overdue", runtimeSessionProof: { forged: true }, knownInstructionRevisionKey: "forged" } });
    assert.deepEqual(result.result.structuredContent.tasks, [{ title: "Overdue task" }]);
    assert.equal(JSON.stringify(result).includes("must-never-be-serialized"), false);
    for (const name of ["prepare_agent_secret_browser_fill", "app_only", "trelio_connect", "trelio_call_tool"]) {
      const refused = await initialCall("trelio_call_tool", { name, arguments: {} });
      assert.equal(refused.result.structuredContent.code, "TRELIO_KIMI_TOOL_UNAVAILABLE");
    }
    const invalid = await initialCall("trelio_call_tool", { name: "list_my_tasks", arguments: [] });
    assert.equal(invalid.result.structuredContent.code, "TRELIO_KIMI_INPUT_INVALID");
    assert.equal(calls, 2);
    // Work also reused the startup list in a second chat opened after the
    // first chat had connected. That chat can read using the existing grant.
    const later = await initialCall("trelio_call_tool", { name: exact.name, arguments: {
      companySlug: "synthetic-company", dueState: "overdue" } });
    assert.deepEqual(later.result.structuredContent.tasks, [{ title: "Overdue task" }]);
    // A later chat with the same stale inventory can also receive and dispatch
    // the server's encrypted route through the distinct local MCP adapter.
    const encrypted = await initialCall("trelio_call_tool", { name: "get_agent_instructions", arguments: encryptedRead });
    assert.deepEqual(encrypted.result.structuredContent, encryptedRoute);
    const selection = encrypted.result.structuredContent.providerSelection;
    const localInput = structuredClone(selection.arguments);
    localInput.parameters.arguments = encryptedRead;
    const local = createKimiLocalMcpHandler({ localMessage: async (message) => {
      assert.deepEqual(message.params, { name: "continue_trelio_local_action", arguments: localInput });
      return { jsonrpc: "2.0", id: message.id, result: output({ effectiveInstructions: { markdown: "LOCAL AUTHORITY" } }) };
    } });
    const localResult = await local(call(selection.tool, localInput));
    assert.equal(localResult.result.structuredContent.effectiveInstructions.markdown, "LOCAL AUTHORITY");
    assert.equal(connects, 1);
    // Clients that refresh can still call the same exact native definition.
    const catalogue = (await request("tools/list")).result.tools;
    assert.deepEqual(catalogue.map(tool => tool.name), [...initial, "get_agent_instructions", "search_trelio_tools", "list_my_tasks"]);
    const direct = await request("tools/call", { name: "get_agent_instructions", arguments: {
      companySlug: "synthetic-company", runtimeSessionProof: { forged: true }, knownInstructionRevisionKey: "forged" } });
    assert.equal(direct.result.structuredContent.effectiveInstructions.markdown, "FULL AUTHORITY");
    assert.equal(calls, 5);
  } finally { input.end(); await running; }
});

test("Kimi never replays an ambiguous mutation and exposes only a closed failure", async () => {
  let attempts = 0;
  const handler = createKimiMcpHandler({ connection: { instructions: () => "", listTools: async () => [{ name: "create_workspace" }],
    call: async () => { attempts++; throw Object.assign(new Error("private token or provider detail"), { code: "REMOTE_MCP_CONNECTION_FAILED" }); } } });
  for (const message of [call("create_workspace"), call("trelio_call_tool", { name: "create_workspace", arguments: {} })]) {
    const before = attempts;
    const reply = await handler(message, { signal: signal() });
    assert.equal(attempts, before + 1); assert.equal(reply.result.isError, true);
    assert.equal(JSON.stringify(reply).includes("private token"), false);
  }
});

test("Kimi local dispatcher refuses nested browser fill before private I/O and cannot hand off to a foreign profile", async () => {
  let calls = 0;
  const handler = createKimiLocalMcpHandler({ localMessage: async (message, options) => {
    calls++; assert.equal(message.params.arguments.runtimeSessionProof, undefined);
    assert.equal(options.runtimeUpgradeRecovery, null);
    return { jsonrpc: "2.0", id: message.id, result: output({ saved: true }) };
  } });
  for (const args of [{ parameters: { nativeTool: "prepare_agent_secret_browser_fill" } },
    { operation: "secret_browser_fill" }, { parameters: { operation: "secret_browser_prepare" } }]) {
    const refused = await handler(call("continue_trelio_local_action", args));
    assert.equal(refused.result.isError, true);
  }
  assert.equal(calls, 0);
  await handler(call("continue_trelio_workspace_action", { operation: "status", runtimeSessionProof: { forged: true } }),
    { runtimeUpgradeRecovery() { throw new Error("must not switch to ordinary MCP"); } });
  assert.equal(calls, 1);
});

test("Kimi bridge state never adopts a common Codex/Claude device or legacy OAuth credential", { timeout: 30_000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-kimi-isolation-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const moduleUrl = new URL("../host-runtime/scripts/trelio-workspace.mjs", import.meta.url).href;
  const source = `import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import path from 'node:path';
    import { resolveWorkspaceBridgeConfigDirectory, workspaceBridgeCredentialAccount, workspaceBridgeClientEnvironment, loadToken } from ${JSON.stringify(moduleUrl)};
    const globalRoot = resolveWorkspaceBridgeConfigDirectory({ environment: { LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE } });
    const ownRoot = resolveWorkspaceBridgeConfigDirectory();
    assert.notEqual(ownRoot, globalRoot);
    assert.equal(ownRoot, path.join(globalRoot, 'native-clients', 'kimi-work'));
    assert.equal(workspaceBridgeCredentialAccount('https://trelio.ru'), 'kimi-work:https://trelio.ru');
    assert.equal(workspaceBridgeCredentialAccount('https://trelio.ru', {}), 'https://trelio.ru');
    assert.deepEqual(workspaceBridgeClientEnvironment(), {TRELIO_WORKSPACE_CLIENT_PROFILE:'kimi-work'});
    assert.throws(()=>resolveWorkspaceBridgeConfigDirectory({environment:{TRELIO_WORKSPACE_CLIENT_PROFILE:'codex'}}), /PROFILE_INVALID/);
    await fs.mkdir(globalRoot,{recursive:true,mode:0o700});
    const file=path.join(globalRoot,'credentials.json');
    const bytes=JSON.stringify({'https://trelio.ru':{accessToken:'synthetic-foreign-oauth',bridgeSessionToken:'synthetic-foreign-device'}});
    await fs.writeFile(file,bytes,{mode:0o600});
    assert.equal(await loadToken('https://trelio.ru'),null);
    assert.equal(await fs.readFile(file,'utf8'),bytes);
    process.stdout.write('isolated');`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { shell: false,
      stdio: ["ignore", "pipe", "pipe"], timeout: 25_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local"),
        XDG_CONFIG_HOME: path.join(home, ".config"), TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1", TRELIO_WORKSPACE_CLIENT_PROFILE: "kimi-work" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, "isolated");
});
