import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { buildKimiWorkBundle, installKimiWorkBundle, prepareMimoDesktopInstallation, workspaceBridgeCredentialAccount } from "../host-runtime/scripts/trelio-workspace.mjs";
import { createHarnessConnection, createKimiMcpHandler, createKimiLocalMcpHandler, remoteMcpHttpRequest, runKimiStdioHost } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
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

test("all fixed native profiles negotiate gzip only for catalog reads", async () => {
  for (const nativeClient of ["codex", "kimi-work", "multitool", "mimo-desktop", "deepseek-harness"]) {
    const methods = [];
    const connection = createHarnessConnection({ nativeClient, httpJson: async () => ({ body: metadata }),
      vault: { read: async () => ({ accessToken: "synthetic", expiresAt: Date.now() + 120_000 }) },
      httpRequest: async ({ payload }, options) => {
        methods.push([payload.method, options.acceptCatalogGzip === true]);
        return { message: { jsonrpc: "2.0", id: payload.id, result: payload.method === "initialize"
          ? { protocolVersion: "2025-03-26" } : payload.method === "tools/list" ? { tools: [] } : output({}) } };
      } });
    await connection.listTools();
    await connection.call("get_agent_instructions", {});
    assert.deepEqual(methods, [["initialize", false], ["notifications/initialized", false],
      ["tools/list", true], ["tools/call", false]], nativeClient);
  }
});

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

for (const { nativeClient, clientId } of [
  { nativeClient: "kimi-work", clientId: "trelio_kimi_work_agent_workspaces_v1" },
  { nativeClient: "multitool", clientId: "trelio_multitool_agent_workspaces_v1" },
  { nativeClient: "mimo-desktop", clientId: "trelio_mimo_desktop_agent_workspaces_v1" },
]) {
  test(`${nativeClient} connects through the real S256/state/loopback OAuth engine and its own vault cell`, async () => {
    let credential, authorize, exchange, writes = 0, dcrCalls = 0;
    const httpJson = async (url, options = {}) => {
      if (url.includes(".well-known")) return { body: metadata };
      if (url === metadata.registration_endpoint) { dcrCalls++; throw new Error("fixed profile must not use DCR"); }
      assert.equal(url, metadata.token_endpoint);
      exchange = new URLSearchParams(options.body);
      return { body: { access_token: `synthetic-${nativeClient}-oauth`, token_type: "Bearer", expires_in: 3600,
        scope: metadata.scopes_supported.join(" ") } };
    };
    const connection = createHarnessConnection({ nativeClient, httpJson,
      vault: { read: async () => credential, write: async (_origin, _identity, value) => { writes++; credential = value; } },
      connectOAuth: (config, options) => connectRemoteMcpOAuth(config, { ...options, httpJson,
        openBrowserFn: async url => {
          authorize = new URL(url);
          assert.equal(authorize.searchParams.get("client_id"), clientId);
          assert.equal(authorize.searchParams.get("resource"), `${origin}/mcp`);
          const callback = new URL(authorize.searchParams.get("redirect_uri"));
          assert.equal(callback.hostname, "127.0.0.1"); assert.equal(callback.pathname, "/callback");
          callback.searchParams.set("state", authorize.searchParams.get("state"));
          callback.searchParams.set("code", "synthetic-code");
          const response = await fetch(callback); assert.equal(response.status, 200);
        } }),
      httpRequest: async ({ payload, credential: token }) => {
        assert.equal(token, `synthetic-${nativeClient}-oauth`);
        if (!payload.id) return { body: null };
        return { sessionId: "synthetic-mcp", message: { jsonrpc: "2.0", id: payload.id,
          result: payload.method === "initialize" ? { protocolVersion: "2025-03-26", instructions: "server authority" }
            : { tools: [] } } };
      } });
    const handler = createKimiMcpHandler({ connection, nativeClient, multiTool: nativeClient === "multitool" });
    const connected = await handler(call("trelio_connect"), { signal: signal() });
    assert.equal(connected.result.structuredContent.connected, true, JSON.stringify(connected.result));
    assert.equal(dcrCalls, 0); assert.equal(writes, 1);
    assert.equal(exchange.get("client_id"), clientId);
    assert.equal(exchange.get("resource"), `${origin}/mcp`);
    assert.equal(exchange.get("redirect_uri"), authorize.searchParams.get("redirect_uri"));
    assert.equal(crypto.createHash("sha256").update(exchange.get("code_verifier")).digest("base64url"), authorize.searchParams.get("code_challenge"));
    assert.equal((await connection.connect(signal())).saving, "not_checked");
    assert.equal(writes, 1, "valid existing authorization is reused");
    const resolved = { remoteMcp: { configFingerprint: "synthetic" } };
    const account = remoteMcpOAuthSessionAccount(origin, resolved, "native", nativeClient);
    for (const otherClient of ["kimi-work", "multitool", "mimo-desktop", "deepseek-harness"].filter(client => client !== nativeClient)) {
      assert.notEqual(account, remoteMcpOAuthSessionAccount(origin, resolved, "native", otherClient));
    }
  });
}

test("MiMo installer generates both JSONC entries and starts each through the signed runtime entry", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-mimo-entry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "Trelio plugin");
  await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "trelio-agent-workspaces" }));
  const entry = new URL("../host-runtime/scripts/trelio-host-runtime-entry.mjs", import.meta.url).href;
  // Only signature/download selection is stubbed. The generated command and
  // both real stdio executables run on this process boundary.
  await fs.writeFile(path.join(root, "scripts", "trelio-host-runtime-loader.mjs"),
    'import { runHostRuntime } from ' + JSON.stringify(entry) + '; export const runHostRuntimeLoader = runHostRuntime;');
  const options = { pluginRoot: root, homeDirectory: directory,
    configDirectory: path.join(directory, "bridge"),
    platform: "darwin" };
  const [result, repeated] = await Promise.all([prepareMimoDesktopInstallation(options), prepareMimoDesktopInstallation(options)]);
  assert.deepEqual(result, repeated);
  assert.equal(result.installedInMimoDesktop, false);
  assert.equal(result.configurationPath, path.join(directory, ".config", "mimocode", "mimocode.jsonc"));
  await assert.rejects(fs.stat(result.configurationPath), { code: "ENOENT" });
  assert.deepEqual(Object.keys(result.mcpServers), ["trelio", "trelio-remote-skills"]);
  const env = { ...process.env,
    HOME: directory, USERPROFILE: directory, LOCALAPPDATA: path.join(directory, "local"),
    XDG_CACHE_HOME: path.join(directory, "cache"), CODEX_HOME: path.join(directory, "foreign-codex"),
    TRELIO_PLUGIN_VERSION: "3.3.1", TRELIO_HOST_RUNTIME_VERSION: "3.36.0" };
  const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26" } }) + "\n";
  for (const [name, server] of Object.entries(result.mcpServers)) {
    assert.equal(server.type, "local");
    assert.equal(server.enabled, true);
    const [node, ...args] = server.command;
    assert.equal(node, process.execPath);
    const invoked = spawnSync(node, args, { env, input, encoding: "utf8", timeout: 20_000 });
    assert.equal(invoked.status, 0, invoked.stderr);
    const initialize = JSON.parse(invoked.stdout).result;
    assert.equal(initialize.serverInfo.name, name === "trelio" ? "trelio-mimo-desktop" : name);
  }
  for (const script of ["trelio-host-runtime-entry.mjs", "trelio-remote-mcp.mjs"]) {
    const executable = fileURLToPath(new URL("../host-runtime/scripts/" + script, import.meta.url));
    const mode = script.includes("entry") ? ["mcp"] : [];
    const foreign = { ...env, TRELIO_WORKSPACE_CLIENT_PROFILE: "kimi-work" };
    const invoked = spawnSync(process.execPath, [executable, ...mode, "--mimo-desktop", "local"],
      { env: foreign, input, encoding: "utf8", timeout: 20_000 });
    assert.notEqual(invoked.status, 0);
    assert.match(invoked.stderr, /TRELIO_MIMO_PROFILE_REQUIRED/u);
    assert.equal(invoked.stdout, "");
  }
  assert.notEqual(workspaceBridgeCredentialAccount(origin, { TRELIO_WORKSPACE_CLIENT_PROFILE: "mimo-desktop" }),
    workspaceBridgeCredentialAccount(origin, { TRELIO_WORKSPACE_CLIENT_PROFILE: "kimi-work" }));
  const bootstrap = result.mcpServers.trelio.command[1];
  await fs.appendFile(bootstrap, "// user change");
  await assert.rejects(prepareMimoDesktopInstallation(options), /TRELIO_MIMO_BUNDLE_CHANGED/u);
  assert.match(await fs.readFile(bootstrap, "utf8"), /user change$/u);
  await assert.rejects(prepareMimoDesktopInstallation({ ...options, platform: "win32" }), /TRELIO_MIMO_MACOS_REQUIRED/u);
  await assert.rejects(fs.stat(env.CODEX_HOME), { code: "ENOENT" });
});

test("MiMo projects exact remote authority and routes in MCP text while keeping the Kimi guards", async () => {
  const tools = [{ name: "get_task", inputSchema: { properties: { runtimeSessionProof: {} } } },
    { name: "prepare_agent_secret_browser_fill" },
    { name: "app_only", _meta: { ui: { visibility: ["app"] } } }];
  const authority = { effectiveInstructions: { markdown: "Exact task authority" },
    bridge: { action: { server: "trelio-remote-skills", tool: "continue_trelio_workspace_action" } } };
  const connection = { instructions: () => "", listTools: async () => tools,
    call: async (name, args) => { assert.equal(name, "get_task"); assert.deepEqual(args, { taskNumber: 1 }); return output(authority); } };
  const remote = createKimiMcpHandler({ nativeClient: "mimo-desktop", connection });
  const result = await remote(call("trelio_call_tool", { name: "get_task", arguments: { taskNumber: 1, runtimeSessionProof: {} } }));
  assert.ok(result.result.content.some(block => block.text.includes("Exact task authority")));
  assert.deepEqual(result.result.structuredContent.bridge.action, authority.bridge.action,
    "MiMo must receive the canonical local action, not Kimi's short alias");
  assert.doesNotMatch(JSON.stringify(result), /privateAppGrant/u);
  for (const name of ["prepare_agent_secret_browser_fill", "app_only"]) {
    const denied = await remote(call(name));
    assert.equal(denied.result.structuredContent.code, "TRELIO_MIMO_TOOL_UNAVAILABLE");
  }
  const local = createKimiLocalMcpHandler({ nativeClient: "mimo-desktop", localMessage: async (message, options) => {
    assert.equal(options.textCompatibility, true);
    assert.equal(options.runtimeUpgradeRecovery, null);
    if (message.method === "tools/list") return { result: { tools: [
      { name: "continue_trelio_workspace_action" },
      { name: "app_only", _meta: { ui: { visibility: ["app"] } } },
    ] } };
    assert.equal(message.params.name, "continue_trelio_local_action");
    return { result: output(authority) };
  } });
  const listed = await local({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ["continue_trelio_workspace_action"]);
  await local(call("continue_trelio_local_action", { route: "context" }));
  const denied = await local(call("continue_trelio_workspace_action", { operation: "secret_browser_fill" }));
  assert.match(denied.result.content[0].text, /TRELIO_MIMO_UNSUPPORTED_OPERATION/u);
});

test("MiMo returns its canonical local tool when a request is sent to the remote server", async () => {
  let remoteCalls = 0;
  const remote = createKimiMcpHandler({ nativeClient: "mimo-desktop", connection: {
    listTools: async () => { remoteCalls++; return []; },
    call: async () => { remoteCalls++; return output({}); },
  } });
  const name = "diagnose_trelio_installation";
  const args = { clientKind: "mimo-desktop", intent: "diagnostics" };
  for (const request of [call(name, args), call("trelio_find_tools", { query: name }),
    call("trelio_call_tool", { name, arguments: args })]) {
    const { result } = await remote(request);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      code: "TRELIO_MIMO_LOCAL_TOOL_REQUIRED", server: "trelio-remote-skills", tool: name,
    });
    assert.match(result.content[0].text, /trelio-remote-skills\.diagnose_trelio_installation/u);
    assert.doesNotMatch(result.content[0].text, /Kimi|select_tools/u);
  }
  assert.equal(remoteCalls, 0, "Local arguments and lookups must stay off the remote MCP connection");
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
    assert.deepEqual(encrypted.result.structuredContent, {
      ...encryptedRoute, providerSelection: { ...encryptedRoute.providerSelection, tool: "local" },
    });
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

test("Kimi native HTTP calls survive the provider deadline and share one 60-second call budget", { timeout: 10_000 }, async t => {
  const requests = [], selections = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const send = result => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    };
    switch (payload.method) {
      case "initialize":
        send({ protocolVersion: "2025-03-26" });
        break;
      case "notifications/initialized":
        response.writeHead(202).end();
        break;
      case "tools/list": {
        const names = payload.params?._meta?.["trelio/toolNames"];
        selections.push({ encoding: request.headers["accept-encoding"], names });
        const tools = ["search", "get_task", "update_task_title"].filter(name => names?.includes(name)).map(name => ({ name }));
        response.setHeader("content-type", "application/json");
        response.setHeader("content-encoding", "gzip");
        response.end(gzipSync(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools } })));
        break;
      }
      case "tools/call":
        requests.push(payload.params.name);
        pending.resolve({ send, closed: new Promise(resolve => response.once("close", resolve)) });
        break;
      default:
        response.writeHead(400).end();
    }
  });
  let pending;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const connection = createHarnessConnection({
    nativeClient: "kimi-work",
    httpJson: async () => ({ body: metadata }),
    vault: { read: async () => ({ accessToken: "synthetic-token", expiresAt: Date.now() + 120_000 }) },
    // Replace DNS/endpoint in the test only. Exercise the real HTTP timer and
    // response parser with the options selected by the production connection.
    httpRequest: (request, options) => remoteMcpHttpRequest(request, {
      ...options,
      resolveEndpoint: async endpoint => {
        assert.equal(endpoint, `${origin}/mcp`);
        return { endpoint: new URL(`http://127.0.0.1:${server.address().port}/mcp`), address: "127.0.0.1", family: 4 };
      },
    }),
  });
  const handler = createKimiMcpHandler({ connection });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  for (const [message, name] of [
    [call("search"), "search"],
    [call("trelio_call_tool", { name: "get_task", arguments: {} }), "get_task"],
  ]) {
    pending = Promise.withResolvers();
    const reply = handler(message);
    const { send } = await pending.promise;
    t.mock.timers.tick(21_000);
    send(output({ name }));
    assert.deepEqual((await reply).result.structuredContent, { name });
  }

  pending = Promise.withResolvers();
  const timedOut = handler(call("update_task_title"));
  // Charge setup to the same call before its tool HTTP timer starts. This
  // makes the outer deadline expire first even if the wire request stalls.
  t.mock.timers.tick(5_000);
  const { closed } = await pending.promise;
  t.mock.timers.tick(55_000);
  assert.equal((await timedOut).result.structuredContent.code, "TRELIO_CALL_TIMEOUT");
  await closed;
  assert.deepEqual(requests, ["search", "get_task", "update_task_title"]);
  assert.deepEqual(selections, requests.map(name => ({ encoding: "gzip", names: [name] })));
});

test("MultiTool checks exact live schemas and filters ranked App-only and revoked matches", async () => {
  const { createMultiToolConnection } = await import("../host-runtime/scripts/trelio-remote-mcp.mjs");
  const appOnly = { name: "app_only", _meta: { ui: { visibility: ["app"] } } };
  const definitions = [{ name: "search_trelio_tools" }, { name: "get_task" }, appOnly];
  const selections = [], calls = [];
  let revoked = false;
  const native = { instructions: () => "",
    listTools: async (_signal, { toolNames }) => {
      selections.push(toolNames);
      return definitions.filter(tool => toolNames.includes(tool.name) && !(revoked && tool.name === "get_task"));
    },
    call: async (name) => {
      calls.push(name);
      return name === "search_trelio_tools" ? output({ tools: [...definitions.slice(1), { name: "bad name" }].map(tool => ({ name: tool.name })) })
        : output({ name });
    } };
  const handler = createKimiMcpHandler({ multiTool: true, connection: createMultiToolConnection({ native,
    local: async ({ params }) => ({ result: output({ name: params.name }) }),
  }) });
  const invoke = async (name, args) => (await handler(call(name, args))).result.structuredContent;
  assert.deepEqual((await invoke("trelio_find_tools", { query: "task search" })).tools, [{ name: "get_task" }]);
  assert.equal((await invoke("trelio_find_tools", { query: "get_task" })).tool.name, "get_task");
  await invoke("get_task");
  assert.equal((await invoke("continue_trelio_local_action")).name, "continue_trelio_local_action");
  revoked = true;
  assert.equal((await invoke("trelio_call_tool", { name: "get_task", arguments: {} })).code, "TRELIO_MULTITOOL_TOOL_UNAVAILABLE");
  assert.deepEqual(selections, [["search_trelio_tools"], ["get_task", "app_only"], ["get_task", "search_trelio_tools"],
    ["get_task"], ["continue_trelio_local_action"], ["get_task"]]);
  assert.deepEqual(calls, ["search_trelio_tools", "get_task"]);
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
  for (const name of ["continue_trelio_local_action", "local", "ws"]) {
    for (const args of [{ parameters: { nativeTool: "prepare_agent_secret_browser_fill" } },
      { operation: "secret_browser_fill" }, { parameters: { operation: "secret_browser_prepare" } }]) {
      const refused = await handler(call(name, args));
      assert.equal(refused.result.isError, true);
    }
  }
  assert.equal(calls, 0);
  await handler(call("continue_trelio_workspace_action", { operation: "status", runtimeSessionProof: { forged: true } }),
    { runtimeUpgradeRecovery() { throw new Error("must not switch to ordinary MCP"); } });
  assert.equal(calls, 1);
});

test("Kimi exposes stable local tools and redirects a misrouted browser-binding request without running it", async () => {
  const server = "trelio-remote-skills";
  const aliases = {
    diag: "diagnose_trelio_installation",
    local: "continue_trelio_local_action",
    ws: "continue_trelio_workspace_action",
    prop: "render_trelio_local_proposal",
  };
  const bridgeCall = { schemaVersion: 1, operation: "folder_onboarding_apply", parameters: { planHash: "exact" } };
  const requiredAction = { code: "START_BRIDGE_PAIRING", call: {
    toolName: aliases.ws, arguments: { schemaVersion: 1, operation: "login", parameters: {} },
  } };
  const diagnostic = {
    plan: { apply: { toolName: aliases.ws, arguments: bridgeCall } },
    workingFolder: { refresh: { action: { toolName: aliases.ws, arguments: bridgeCall } } },
    requiredActions: [requiredAction],
  };
  const requests = [];
  const local = createKimiLocalMcpHandler({ localMessage: async message => {
    if (message.method === "tools/list") return { result: { tools: Object.values(aliases).map(name => ({
      name, description: "Native tool", inputSchema: { type: "object", additionalProperties: false },
    })) } };
    requests.push(message.params);
    return { result: { content: [{ type: "text", text: JSON.stringify(diagnostic) }] } };
  } });
  const catalogue = (await local({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
  for (const [name, canonical] of Object.entries(aliases)) {
    const tool = catalogue.find(entry => entry.name === name);
    assert.ok(tool.description.includes(canonical));
    assert.ok(`mcp__plugin-trelio-agent-workspaces_${server}__${name}`.length < 64);
    assert.deepEqual(tool.inputSchema, catalogue.find(entry => entry.name === canonical).inputSchema);
  }

  const remote = createKimiMcpHandler({ connection: {
    listTools: async () => assert.fail("Local discovery must never reach remote MCP"),
    call: async () => assert.fail("Local dispatch must never reach remote MCP"),
  } });
  const args = { clientKind: "kimi-work", intent: "onboarding",
    folderOnboarding: { companySlug: "fixture", confirmBrowser: true } };
  for (const request of [
    call(aliases.diag, args),
    call("trelio_call_tool", { name: aliases.diag, arguments: args }),
    call("trelio_find_tools", { query: aliases.diag }),
  ]) {
    const refused = (await remote(request)).result;
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.structuredContent, { code: "TRELIO_KIMI_LOCAL_TOOL_REQUIRED", server, tool: "diag" });
    assert.doesNotMatch(JSON.stringify(refused), /confirmBrowser|fixture/u);
  }
  assert.deepEqual(requests, []);
  const result = (await local(call("diag", args))).result;
  assert.deepEqual(requests, [{ name: aliases.diag, arguments: args }]);
  assert.equal(result.structuredContent, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    plan: { apply: { toolName: "ws", arguments: bridgeCall } },
    workingFolder: { refresh: { action: { toolName: "ws", arguments: bridgeCall } } },
    requiredActions: [{ ...requiredAction, call: { ...requiredAction.call, toolName: "ws" } }],
  });
});

test("Kimi and MultiTool resolve remote and local continuations against their own catalogues", async () => {
  const { createMultiToolConnection } = await import("../host-runtime/scripts/trelio-remote-mcp.mjs");
  const server = "trelio-remote-skills";
  const contextTool = "continue_trelio_local_action";
  const workspaceTool = "continue_trelio_workspace_action";
  const embedded = { server, tool: workspaceTool };
  const context = { server, tool: contextTool, provider: "local_company_context",
    arguments: { schemaVersion: 1, route: "context", parameters: { nativeTool: "get_task", arguments: { embedded } } } };
  const download = { server, tool: workspaceTool,
    arguments: { schemaVersion: 1, operation: "download_file", parameters: { filePath: "original.pdf" } } };
  const upload = { server, tool: contextTool, schemaVersion: 1, route: "action",
    parameters: { nativeTool: "upload_import_package" }, requiredParameters: ["localFilePath"] };
  const skill = { runtimeExecution: { localAction: { ...download, arguments: { schemaVersion: 1, operation: "skill_run", parameters: {} } } } };
  const fixtures = {
    get_task: { code: "MCP_LOCAL_CONTEXT_REQUIRED", providerSelection: context, task: { contentProvider: embedded } },
    get_agent_workspace_file: { bridge: { action: download } },
    fetch: { materialize: download },
    list_companies: { companies: [{ contentProvider: { server, tool: contextTool, provider: "local_company_context" } }] },
    get_import_specification: { localUpload: upload },
    get_agent_skill: skill,
  };
  const native = {
    listTools: async () => Object.keys(fixtures).map(name => ({ name, inputSchema: { type: "object" } })),
    call: async name => name === "get_task" ? {
      ...output(fixtures[name]), content: [{ type: "text", text: `MCP_LOCAL_CONTEXT_REQUIRED: Continue through "${server}", "${contextTool}".` }],
      isError: true,
    } : output(fixtures[name]),
  };
  const localFixture = { nextCall: context, materialize: download };
  const dispatches = [];
  const local = ({ params }) => {
    dispatches.push(params);
    return { result: { content: [{ type: "text", text: JSON.stringify(localFixture) }] } };
  };
  for (const multiTool of [false, true]) {
    const handler = createKimiMcpHandler({ multiTool, connection: multiTool
      ? createMultiToolConnection({ native, local }) : native });
    const expectedServer = multiTool ? "trelio" : server;
    const expectedContextTool = multiTool ? contextTool : "local";
    const expectedWorkspaceTool = multiTool ? workspaceTool : "ws";
    // Compare both entry points. The generic dispatcher must never be asked
    // to dispatch a remote request again to resolve a local result.
    for (const mode of ["direct", "fallback"]) {
      const ask = async name => (await handler(mode === "direct" ? call(name)
        : call("trelio_call_tool", { name, arguments: {} }))).result;
      const encrypted = await ask("get_task");
      assert.equal(encrypted.isError, true);
      assert.deepEqual(encrypted.structuredContent, { ...fixtures.get_task,
        providerSelection: { ...context, server: expectedServer, tool: expectedContextTool } });
      assert.ok(encrypted.content[0].text.includes(`"${expectedServer}", "${expectedContextTool}"`));
      assert.deepEqual((await ask("get_agent_workspace_file")).structuredContent.bridge.action,
        { ...download, server: expectedServer, tool: expectedWorkspaceTool });
      assert.deepEqual((await ask("fetch")).structuredContent.materialize,
        { ...download, server: expectedServer, tool: expectedWorkspaceTool });
      assert.deepEqual((await ask("list_companies")).structuredContent.companies[0].contentProvider,
        { ...fixtures.list_companies.companies[0].contentProvider, server: expectedServer, tool: expectedContextTool });
      assert.deepEqual((await ask("get_import_specification")).structuredContent.localUpload,
        { ...upload, server: expectedServer, tool: expectedContextTool });
      const skillResult = await ask("get_agent_skill");
      const skillPayload = skillResult.structuredContent ?? JSON.parse(skillResult.content[0].text);
      assert.deepEqual(skillPayload.runtimeExecution.localAction,
        { ...skill.runtimeExecution.localAction, server: expectedServer, tool: expectedWorkspaceTool });
    }
    const result = (await (multiTool ? handler : createKimiLocalMcpHandler({ localMessage: local }))(
      call(expectedContextTool, context.arguments))).result;
    assert.deepEqual(JSON.parse(result.content[0].text), {
      nextCall: { ...context, server: expectedServer, tool: expectedContextTool },
      materialize: { ...download, server: expectedServer, tool: expectedWorkspaceTool },
    });
  }
  assert.deepEqual(dispatches, [false, true].map(() => ({ name: contextTool, arguments: context.arguments })));
  assert.equal(fixtures.get_task.providerSelection.server, server);
  assert.equal(fixtures.fetch.materialize.tool, workspaceTool);
});

test("Kimi bridge state never adopts a common Codex/Claude device or legacy OAuth credential", { timeout: 30_000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-kimi-isolation-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const moduleUrl = new URL("../host-runtime/scripts/trelio-workspace.mjs", import.meta.url).href;
  const source = `import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import path from 'node:path';
    import { resolveWorkspaceBridgeConfigDirectory, workspaceBridgeCredentialAccount, workspaceBridgeClientEnvironment, loadToken, readDesktopComputerGroupKey } from ${JSON.stringify(moduleUrl)};
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
    const sharedComputer = await readDesktopComputerGroupKey('https://trelio.ru');
    assert.equal(sharedComputer, await readDesktopComputerGroupKey('https://trelio.ru', globalRoot));
    assert.notEqual(sharedComputer, await readDesktopComputerGroupKey('https://trelio.ru', ownRoot));
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

test("MultiTool enforces the final skill budget for remote and local reads", async () => {
  const { createMultiToolConnection } = await import("../host-runtime/scripts/trelio-remote-mcp.mjs");
  const skill = { instructionsMarkdown: "я".repeat(11000), runtimeExecution: { localAction: { route: "fixture" } } };
  const continuation = "continue_trelio_local_action";
  let data = skill;
  const result = () => ({ structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] });
  const connection = createMultiToolConnection({
    native: { call: async () => result() },
    local: async (_message, options) => {
      assert.equal(options.textCompatibility, true);
      return { result: result() };
    },
  });
  const call = (name) => connection.call(name, name === continuation ? { parameters: { nativeTool: "get_agent_skill" } } : {});
  for (const tool of ["get_agent_skill", continuation]) {
    const reply = await call(tool);
    assert.equal(reply.structuredContent, undefined);
    assert.deepEqual(JSON.parse(reply.content[0].text), skill);
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 40000);
  }
  data = { ...skill, instructionsMarkdown: skill.instructionsMarkdown.repeat(2) };
  for (const tool of ["get_agent_skill", continuation]) {
    const reply = await call(tool);
    assert.equal(reply.structuredContent.code, "AGENT_SKILL_RESPONSE_TOO_LARGE");
    assert.doesNotMatch(JSON.stringify(reply), /localAction/u);
  }
});

test("MultiTool sends exact open and inspect envelopes and plans complete local authority reads", async t => {
  const { createMultiToolConnection } = await import("../host-runtime/scripts/trelio-remote-mcp.mjs");
  const { buildLocalTaskReadToolResult } = await import("../host-runtime/scripts/trelio-task-read-budget.mjs");
  const { TRELIO_WORKSPACE_ACTION_TOOL, buildTrelioWorkspaceActionInvocation,
    readOpenedWorkspaceRunIdentity, resolveOpenedWorkspaceDirectory } =
    await import("../host-runtime/scripts/trelio-local-context.mjs");
  const trelioOrigin = "https://trelio.ru";
  const workspaceId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multitool-authority-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceDirectory = path.join(root, "workspace");
  const contextDirectory = path.join(root, "context");
  await fs.mkdir(workspaceDirectory);
  await fs.mkdir(contextDirectory);
  await fs.writeFile(path.join(root, ".trelio-run.json"), JSON.stringify({
    schemaVersion: 3, origin: trelioOrigin, workspaceId, runId, workspaceDirectory,
  }), { mode: 0o600 });
  const instructions = path.join(contextDirectory, "agent-instructions.md");
  const profile = path.join(contextDirectory, "user-profile.md");
  await fs.writeFile(instructions, "private-rule\n".repeat(121));
  await fs.writeFile(profile, "private-profile\nlast line without newline");

  const tool = TRELIO_WORKSPACE_ACTION_TOOL.name;
  const open = { schemaVersion: 1, operation: "open", parameters: { workspaceId, runId } };
  const inspect = { schemaVersion: 1, operation: "inspect", parameters: { workspaceId } };
  const finish = { tool, server: "trelio-remote-skills", arguments: { schemaVersion: 1, operation: "finish", parameters: {}, runIdentity: { workspaceId, runId } } };
  const requests = [];
  const connection = createMultiToolConnection({
    native: {
      listTools: async () => ["prepare_agent_workspace_run", "prepare_agent_workspace_read"].map(name => ({
        name, inputSchema: { type: "object" },
      })),
      instructions: () => "",
      call: async (name, args) => {
        if (name === "prepare_agent_workspace_run") {
          assert.equal(args.clientKind, "multitool");
          return output({ bridge: { actions: { open: { tool, server: "trelio-remote-skills", arguments: open, workingDirectory: "current_project" }, finish } } });
        }
        return output({ bridge: { action: { tool, server: "trelio-remote-skills", arguments: inspect } } });
      },
    },
    origin: trelioOrigin,
    workspaceTool: TRELIO_WORKSPACE_ACTION_TOOL,
    resolveOpenedDirectory: resolveOpenedWorkspaceDirectory,
    readOpenedRunIdentity: readOpenedWorkspaceRunIdentity,
    local: async ({ params }, options) => {
      assert.equal(options.origin, trelioOrigin);
      assert.equal(params.name, tool);
      buildTrelioWorkspaceActionInvocation(params.arguments);
      requests.push(params.arguments);
      return { result: buildLocalTaskReadToolResult({
        schemaVersion: 1, operation: params.arguments.operation, stdout: workspaceDirectory + "\n",
      }) };
    },
  });
  const handler = createKimiMcpHandler({ connection, multiTool: true });
  const tools = (await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
  for (const [name, fields] of [["trelio_workspace_open", ["workspaceId", "runId"]],
    ["trelio_workspace_inspect", ["workspaceId"]]]) {
    const { inputSchema } = tools.find(tool => tool.name === name);
    assert.equal(inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(inputSchema.properties), fields);
  }
  const run = (await handler(call("prepare_agent_workspace_run", { workspaceId }))).result;
  const prepared = run.structuredContent.bridge.actions;
  assert.deepEqual(prepared.open, { tool: "trelio_workspace_open", server: "trelio", arguments: open.parameters });
  assert.deepEqual(prepared.finish, { ...finish, server: "trelio" });
  assert.doesNotMatch(run.content[0].text, /current_project/u);
  const read = (await handler(call("prepare_agent_workspace_read", { workspaceId }))).result;
  assert.deepEqual(read.structuredContent.bridge.action, { tool: "trelio_workspace_inspect", server: "trelio", arguments: inspect.parameters });

  const unexpectedDirectory = (await handler(call(prepared.open.tool, { ...prepared.open.arguments, workingDirectory: "current_project" }))).result;
  assert.equal(unexpectedDirectory.isError, true);
  assert.deepEqual(requests, []);
  for (const descriptor of [prepared.open, read.structuredContent.bridge.action]) {
    const result = (await handler(call(descriptor.tool, descriptor.arguments))).result;
    assert.equal(result.structuredContent.authorityReadPlan.state, "ready");
    assert.equal(result.structuredContent.workspaceDirectory, workspaceDirectory);
    assert.deepEqual(result.structuredContent.authorityReadPlan.files, [
      { filePath: instructions, offset: 1, limit: 121, expectedLastLine: 121 },
      { filePath: profile, offset: 1, limit: 2, expectedLastLine: 2 },
    ]);
    assert.doesNotMatch(result.content[0].text, /private-rule|private-profile|privateAppGrant/u);
  }
  assert.deepEqual(requests, [open, inspect]);

  await fs.rm(profile);
  const unavailable = (await handler(call(prepared.open.tool, prepared.open.arguments))).result;
  assert.equal(unavailable.structuredContent.operation, "open");
  assert.equal(unavailable.structuredContent.authorityReadPlan.state, "unavailable");
  assert.equal(requests.length, 3, "a failed plan must not repeat open");
});

test("MultiTool installer prepares an exact signed-loader launch without modifying client configuration", async t => {
  const { prepareMultiToolInstallation } = await import("../host-runtime/scripts/trelio-workspace.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-multitool-install-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const homeDirectory = path.join(directory, "home");
  const configurationPath = path.join(homeDirectory, ".config", "gigatool", "opencode.json");
  await fs.mkdir(path.dirname(configurationPath), { recursive: true });
  const existing = '{"mcp":{"other":{"type":"remote","url":"https://example.test/mcp"}}}';
  await fs.writeFile(configurationPath, existing);

  const options = { pluginRoot: pluginDirectory, configDirectory: directory, homeDirectory };
  await assert.rejects(prepareMultiToolInstallation({ ...options, platform: "linux" }), /TRELIO_MULTITOOL_MACOS_REQUIRED/u);
  const first = await prepareMultiToolInstallation({ ...options, platform: "darwin" });
  const second = await prepareMultiToolInstallation({ ...options, platform: "darwin" });
  assert.equal(first.installedInMultiTool, false);
  assert.equal(first.serverName, "trelio");
  assert.equal(first.configurationPath, configurationPath);
  assert.equal(await fs.readFile(configurationPath, "utf8"), existing);
  assert.notEqual(first.bundleDirectory, second.bundleDirectory);
  assert.deepEqual(first.mcpServer, {
    type: "local", command: [process.execPath, path.join(first.bundleDirectory, "bootstrap.mjs")], enabled: true,
  });
  const bootstrap = await fs.readFile(first.mcpServer.command[1], "utf8");
  assert.match(bootstrap, /runHostRuntimeLoader.*\['mcp','--multitool'\]/u);
  assert.match(bootstrap, /TRELIO_WORKSPACE_CLIENT_PROFILE = 'multitool'/u);
  assert.doesNotMatch(bootstrap, /127\.0\.0\.1:4187|preview|runtimeSessionProof/u);
});

test("signed MultiTool stdio startup checks its own namespace before exposing OAuth", async t => {
  const { spawnSync } = await import("node:child_process");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-multitool-entry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const entry = new URL("../host-runtime/scripts/trelio-host-runtime-entry.mjs", import.meta.url);
  const env = { ...process.env, HOME: directory, USERPROFILE: directory,
    LOCALAPPDATA: path.join(directory, "local"), XDG_CONFIG_HOME: path.join(directory, ".config"),
    TRELIO_PLUGIN_VERSION: "3.2.5", TRELIO_HOST_RUNTIME_VERSION: "4.0.0",
    TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1", TRELIO_WORKSPACE_CLIENT_PROFILE: "multitool" };
  const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
  const launch = (args, launchEnv = env) => spawnSync(process.execPath,
    [fileURLToPath(entry), "mcp", ...args], { env: launchEnv, input, encoding: "utf8", timeout: 8000 });
  const started = launch(["--multitool"]);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).result.serverInfo.name, "trelio-multitool");
  const foreign = launch(["--multitool"], { ...env, TRELIO_WORKSPACE_CLIENT_PROFILE: "kimi-work" });
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /TRELIO_MULTITOOL_PROFILE_REQUIRED/u);
  const extra = launch(["--multitool", "extra"]);
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /TRELIO_MCP_ARGUMENTS_UNSUPPORTED/u);
});
