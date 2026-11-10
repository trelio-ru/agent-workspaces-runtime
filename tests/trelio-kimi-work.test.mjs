import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
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

test("Kimi bundle uses both signed stdio profiles, no foreign hooks, and preserves changed files", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-kimi-install-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { pluginRoot: pluginDirectory, configDirectory: directory };
  const result = await installKimiWorkBundle(options);
  assert.equal(result.installedInKimiWork, false);
  assert.deepEqual(await installKimiWorkBundle(options), result);
  const manifest = JSON.parse(await fs.readFile(path.join(result.bundleDirectory, "kimi.plugin.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.mcpServers), ["trelio", "trelio-remote-skills"]);
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers.trelio.command, path.basename(process.execPath));
  assert.equal(path.isAbsolute(manifest.mcpServers.trelio.command), false, "Kimi rejects absolute plugin command paths");
  assert.deepEqual(manifest.mcpServers.trelio.args, ["./bootstrap.mjs", "remote"]);
  assert.deepEqual(manifest.mcpServers["trelio-remote-skills"].args, ["./bootstrap.mjs", "local"]);
  const bootstrap = await fs.readFile(path.join(result.bundleDirectory, "bootstrap.mjs"), "utf8");
  assert.match(bootstrap, /await selectHostRuntime\(\)/u);
  assert.match(bootstrap, /selected.runtimeDirectory/u);
  assert.match(bootstrap, /TRELIO_KIMI_NODE_PATH_MISMATCH/u);
  assert.doesNotMatch(bootstrap, /accessToken|runtimeSessionProof|CODEX_THREAD_ID/u);
  await fs.appendFile(path.join(result.bundleDirectory, "bootstrap.mjs"), "// own modification\n");
  await assert.rejects(installKimiWorkBundle(options), /TRELIO_KIMI_BUNDLE_CHANGED/u);
});

test("generated Kimi bootstrap runs both profiles and refuses a different Node before runtime selection", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-kimi-bootstrap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts"); await fs.mkdir(scripts);
  // Only the loader boundary is synthetic. Execute the generated file with
  // real Node so invalid manifest commands, interpolation or import ordering
  // cannot pass as a successful native startup based on a string assertion.
  await fs.writeFile(path.join(scripts, "trelio-host-runtime-loader.mjs"),
    `export const selectHostRuntime=async()=>({runtimeVersion:'test',runtimeDirectory:${JSON.stringify(root)}});`);
  await fs.writeFile(path.join(scripts, "trelio-host-runtime-shell.mjs"), "export const PLUGIN_VERSION='test';");
  await fs.writeFile(path.join(scripts, "trelio-remote-mcp.mjs"),
    "if(process.env.TRELIO_WORKSPACE_CLIENT_PROFILE!=='kimi-work')throw Error('profile lost'); export const runKimiStdioHost=()=>process.stdout.write('remote'); export const runKimiLocalStdioHost=()=>process.stdout.write('local');");
  const run = profile => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./bootstrap.mjs", profile], { cwd: root, shell: false,
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
  const otherNode = path.join(root, "other-node"); await fs.writeFile(otherNode, "synthetic different executable");
  await fs.writeFile(path.join(root, "bootstrap.mjs"), buildKimiWorkBundle({ pluginRoot: root, nodePath: otherNode })["bootstrap.mjs"]);
  const refused = await run("remote"); assert.notEqual(refused.code, 0); assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /TRELIO_KIMI_NODE_PATH_MISMATCH/u);
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

test("Kimi stdio announces real tools after connect and preserves complete structured authority", async () => {
  const input = new PassThrough(), stream = new PassThrough();
  let connected = false, calls = 0, sequence = 0, pending = new Map(), lineBuffer = "";
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
  const connection = { instructions: () => "COMPLETE SERVER INSTRUCTIONS", connect: async () => {
    connected = true; return { connected: true, protectedRead: "not_checked", saving: "not_checked" };
  }, listTools: async () => {
    if (!connected) throw Object.assign(new Error(), { code: "TRELIO_KIMI_AUTH_REQUIRED" });
    return [{ name: "get_agent_instructions", inputSchema: { type: "object", properties: { runtimeSessionProof: {} } } },
      { name: "prepare_agent_secret_browser_fill" }, { name: "app_only", _meta: { ui: { visibility: ["app"] } } }];
  }, call: async (method, args) => { calls++; assert.equal(method, "get_agent_instructions");
    assert.deepEqual(args, { companySlug: "synthetic-company" }); return output({ effectiveInstructions: { markdown: "FULL AUTHORITY" } }); } };
  const running = runKimiStdioHost({ inputStream: input, outputStream: stream, connection,
    startupTrace() {}, diagnosticReporter: { record() {}, close() {} },
    environment: { CODEX_HOME: "/must-not-migrate-codex", CODEX_THREAD_ID: "foreign" } });
  try {
    assert.equal((await request("initialize", { protocolVersion: "2025-03-26" })).result.capabilities.tools.listChanged, true);
    assert.deepEqual((await request("tools/list")).result.tools.map(tool => tool.name), ["trelio_connect"]);
    const connectedResult = await request("tools/call", { name: "trelio_connect", arguments: {} });
    assert.equal(connectedResult.result.structuredContent.saving, "not_checked");
    assert.equal(notifications[0].method, "notifications/tools/list_changed");
    const catalogue = (await request("tools/list")).result.tools;
    assert.deepEqual(catalogue.map(tool => tool.name), ["trelio_connect", "get_agent_instructions"]);
    assert.equal(catalogue[1].inputSchema.properties.runtimeSessionProof, undefined);
    const result = await request("tools/call", { name: "get_agent_instructions", arguments: {
      companySlug: "synthetic-company", runtimeSessionProof: { forged: true }, knownInstructionRevisionKey: "forged" } });
    assert.equal(result.result.structuredContent.effectiveInstructions.markdown, "FULL AUTHORITY");
    assert.equal(JSON.stringify(result).includes("must-never-be-serialized"), false);
    const refused = await request("tools/call", { name: "prepare_agent_secret_browser_fill", arguments: {} });
    assert.equal(refused.result.isError, true); assert.equal(calls, 1);
  } finally { input.end(); await running; }
});

test("Kimi never replays an ambiguous mutation and exposes only a closed failure", async () => {
  let attempts = 0;
  const handler = createKimiMcpHandler({ connection: { instructions: () => "", listTools: async () => [{ name: "create_workspace" }],
    call: async () => { attempts++; throw Object.assign(new Error("private token or provider detail"), { code: "REMOTE_MCP_CONNECTION_FAILED" }); } } });
  const reply = await handler(call("create_workspace"), { signal: signal() });
  assert.equal(attempts, 1); assert.equal(reply.result.isError, true);
  assert.equal(JSON.stringify(reply).includes("private token"), false);
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
