import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { runStdioHost } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { runAssistantSetupMcp, runAssistantBackground } from "../host-runtime/scripts/trelio-assistant-entry.mjs";
import { retainLoadedCodexPluginInstallation, startLoadedCodexPluginPreservation } from "../host-runtime/scripts/trelio-workspace.mjs";

const execute = promisify(execFile);
const waitUntil = async (predicate) => {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "preservation did not converge in the same live process");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const fixture = async (profile = "human") => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-plugin-preservation-"));
  const assistant=profile==="assistant",name=assistant?"trelio-digital-assistant":"trelio-agent-workspaces";
  const version=assistant?"0.1.3":"3.2.3",marketplace=assistant?"trelio-digital-assistants":"trelio-plugins";
  const plugin = path.join(root, "codex", "plugins", "cache", marketplace, name, version);
  for (const directory of [".codex-plugin", "hooks", "scripts", "skills/example"]) {
    await fs.mkdir(path.join(plugin, directory), { recursive: true });
  }
  await fs.writeFile(path.join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name, version }));
  await fs.writeFile(path.join(plugin, "hooks/hooks.json"), '{"hooks":{"PreToolUse":[]}}');
  await fs.writeFile(path.join(plugin, "skills/example/SKILL.md"), "exact old instructions\n");
  await fs.writeFile(path.join(plugin, "scripts/hook.mjs"), 'process.stdout.write("exact-old-hook");\n', { mode: 0o755 });
  return { root, plugin, retentionDirectory: path.join(root, "private", "retention"), environment: {
    // Actual dedicated distribution 0.1.3 embeds the unchanged common loader
    // component 3.2.3. Its environment must not pretend these versions coincide.
    CODEX_HOME: path.join(root, "codex"), TRELIO_PLUGIN_ROOT: plugin, TRELIO_PLUGIN_VERSION: "3.2.3",
    TRELIO_HOST_RUNTIME_VERSION: "3.18.0",
  } };
};

test("dedicated assistant MCP preserves only its exact loaded shell and stops after EOF",async()=>{
  const f=await fixture("assistant"),input=new PassThrough(),output=new PassThrough();
  let data="",preservation,starts=0;
  output.on("data",chunk=>{data+=chunk;});
  const host=runAssistantSetupMcp({input,output,environment:f.environment,createMcp:async()=>assert.fail("initialize never needs a device credential"),
    preservePlugin:options=>{
      starts++;assert.ok(data.includes('"id":1'),"snapshot cannot delay initialize");
      preservation=startLoadedCodexPluginPreservation({...options,retentionDirectory:f.retentionDirectory,checkIntervalMs:20,
        onError:error=>assert.fail(error)});
      return preservation;
    }});
  try{
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    await waitUntil(()=>preservation!==undefined);const entry=await preservation.ready;
    assert.equal(entry.profile,"assistant");
    assert.equal(entry.version,"0.1.3");
    const before=await fs.readFile(path.join(f.plugin,"hooks/hooks.json"));
    await fs.rm(path.dirname(f.plugin),{recursive:true});
    const newer=path.join(path.dirname(f.plugin),"0.1.4");await fs.mkdir(newer,{recursive:true});
    await fs.writeFile(path.join(newer,"sentinel"),"independent new installation");
    await waitUntil(()=>fs.readFile(path.join(f.plugin,"scripts/hook.mjs"),"utf8").then(v=>v.includes("exact-old-hook"),()=>false));
    assert.deepEqual(await fs.readFile(path.join(f.plugin,"hooks/hooks.json")),before);
    assert.equal((await execute(process.execPath,[path.join(f.plugin,"scripts/hook.mjs")])).stdout,"exact-old-hook");
    assert.equal(await fs.readFile(path.join(newer,"sentinel"),"utf8"),"independent new installation");
    input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');await waitUntil(()=>data.includes('"id":2'));
    assert.equal(starts,1);input.end();await host;
    await fs.rm(f.plugin,{recursive:true});await new Promise(resolve=>setTimeout(resolve,80));
    await assert.rejects(fs.stat(f.plugin),{code:"ENOENT"});
  }finally{input.end();await host;await fs.rm(f.root,{recursive:true,force:true});}
});

test("assistant supervisor keeps the same shell for later workers independently of any MCP",async()=>{
  const f=await fixture("assistant"),order=[],identity={origin:"https://assistant.test",assistantId:"synthetic",deviceId:"synthetic"};
  let preservation;
  try{
    const result=await runAssistantBackground({environment:f.environment,
      readHost:async()=>({identity,activation:null}),verifyRegistration:async()=>{order.push("registration");},
      startConsoleIcon:async()=>null,
      preservePlugin:options=>{
        order.push("preservation");preservation=startLoadedCodexPluginPreservation({...options,retentionDirectory:f.retentionDirectory,
          checkIntervalMs:20,onError:error=>assert.fail(error)});return preservation;
      },
      request:async request=>{
        if(request.operation==="health"){
          order.push("worker");assert.ok(await preservation.ready);
          await fs.rm(f.plugin,{recursive:true});
          await waitUntil(()=>fs.readFile(path.join(f.plugin,"scripts/hook.mjs"),"utf8").then(v=>v.includes("exact-old-hook"),()=>false));
          return {};
        }
        assert.equal(request.operation,"background_tick");return {state:"quiescing"};
      }});
    assert.equal(result.state,"stopped");assert.deepEqual(order,["registration","preservation","worker"]);
    await fs.rm(f.plugin,{recursive:true});await new Promise(resolve=>setTimeout(resolve,80));
    await assert.rejects(fs.stat(f.plugin),{code:"ENOENT"},"stopped supervisor does not retain an eternal watcher");
  }finally{await preservation?.close();await fs.rm(f.root,{recursive:true,force:true});}
});

test("assistant cache paths cannot adopt a human manifest or foreign CODEX_HOME",async()=>{
  const f=await fixture("assistant");
  try{
    const wrong=startLoadedCodexPluginPreservation({...f,environment:{...f.environment,CODEX_HOME:path.join(f.root,"foreign")}});
    assert.equal(await wrong.ready,null);await wrong.close();
    const missing=startLoadedCodexPluginPreservation({...f,environment:{...f.environment,TRELIO_PLUGIN_VERSION:""}});
    assert.equal(await missing.ready,null);await missing.close();
    await fs.writeFile(path.join(f.plugin,".codex-plugin/plugin.json"),JSON.stringify({name:"trelio-digital-assistant",version:"0.1.4"}));
    const mismatch=startLoadedCodexPluginPreservation({...f,onError:()=>{}});
    await assert.rejects(mismatch.ready,/manifest/);await mismatch.close();
    await fs.writeFile(path.join(f.plugin,".codex-plugin/plugin.json"),JSON.stringify({name:"trelio-agent-workspaces",version:"0.1.3"}));
    const errors=[],preservation=startLoadedCodexPluginPreservation({...f,onError:error=>errors.push(error)});
    await assert.rejects(preservation.ready,/manifest/);await preservation.close();
    await assert.rejects(fs.stat(f.retentionDirectory),{code:"ENOENT"});
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

// This regression uses the production MCP composition, not only the retention
// helper. A signed-runtime refactor must not silently disconnect this lifecycle
// hook again. Everything is synthetic: no user's state, OAuth or remote Trelio.
test("open MCP restores its old hook and skill paths after an external plugin update", async () => {
  const f = await fixture();
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  let preservation;
  let starts = 0;
  let pending = "";
  output.on("data", chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      frames.push(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
    }
  });
  const host = runStdioHost({
    inputStream: input, outputStream: output, environment: f.environment,
    legacyMcpMigration: async () => ({ status: "not_found" }),
    diagnosticReporter: { record() {}, close() {} },
    handleMessage: async message => ({ jsonrpc: "2.0", id: message.id, result: { method: message.method } }),
    preservePlugin: options => {
      starts++;
      assert.ok(frames.some(frame => frame.id === 1), "initialize must already be written before snapshot starts");
      preservation = startLoadedCodexPluginPreservation({ ...options, retentionDirectory: f.retentionDirectory, checkIntervalMs: 20,
        onError: error => { throw error; } });
      return preservation;
    },
  });
  try {
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await waitUntil(() => preservation !== undefined);
    await preservation.ready;
    const hookBefore = await fs.readFile(path.join(f.plugin, "hooks/hooks.json"));
    // Model an update performed by Codex's own manager, outside our updater:
    // remove the whole old plugin parent, then install a different version.
    const parent = path.dirname(f.plugin);
    await fs.rm(parent, { recursive: true });
    const newer = path.join(parent, "3.2.4");
    await fs.mkdir(newer, { recursive: true });
    await fs.writeFile(path.join(newer, "sentinel"), "new release stays untouched");
    await waitUntil(async () => fs.readFile(path.join(f.plugin, "skills/example/SKILL.md"), "utf8").then(text => text === "exact old instructions\n", () => false));
    assert.deepEqual(await fs.readFile(path.join(f.plugin, "hooks/hooks.json")), hookBefore);
    assert.equal((await execute(process.execPath, [path.join(f.plugin, "scripts/hook.mjs")])).stdout, "exact-old-hook");
    assert.equal(await fs.readFile(path.join(newer, "sentinel"), "utf8"), "new release stays untouched");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await waitUntil(() => frames.some(frame => frame.id === 2));
    assert.equal(starts, 1, "the same MCP stays alive without a restart or second snapshot owner");
    input.end();
    await host;
    await fs.rm(f.plugin, { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 80));
    await assert.rejects(fs.stat(f.plugin), { code: "ENOENT" }, "closed MCP must not resurrect its former installation");
  } finally {
    input.end();
    await host;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("slow preservation does not hold initialize or subsequent MCP requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let data = "";
  let closed = false;
  output.on("data", chunk => { data += chunk; });
  const host = runStdioHost({ inputStream: input, outputStream: output, environment: {},
    legacyMcpMigration: async () => ({ status: "not_found" }), diagnosticReporter: { record() {}, close() {} },
    handleMessage: async message => ({ jsonrpc: "2.0", id: message.id, result: {} }),
    preservePlugin: () => ({ ready: new Promise(() => {}), close: async () => { closed = true; } }),
  });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await waitUntil(() => data.includes('"id":2'));
  input.end();
  await host;
  assert.equal(closed, true);
});

test("preservation rejects corrupted retained bytes without replacing the missing shell", async () => {
  const f = await fixture();
  const errors = [];
  const preservation = startLoadedCodexPluginPreservation({ ...f, checkIntervalMs: 20, onError: error => errors.push(error) });
  try {
    const entry = await preservation.ready;
    await fs.writeFile(path.join(entry.pluginDirectory, "scripts/hook.mjs"), 'process.stdout.write("untrusted");');
    await fs.rm(f.plugin, { recursive: true });
    await waitUntil(() => errors.length > 0);
    await assert.rejects(fs.stat(f.plugin), { code: "ENOENT" });
    assert.equal(errors.length, 1, "integrity failure stops repair instead of looping");
  } finally {
    await preservation.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("two open sessions survive repeated external pruning without replacing different bytes", async () => {
  const f = await fixture();
  const errors = [];
  const options = { ...f, checkIntervalMs: 20, onError: error => errors.push(error) };
  const first = startLoadedCodexPluginPreservation(options);
  const second = startLoadedCodexPluginPreservation(options);
  try {
    await Promise.all([first.ready, second.ready]);
    for (let i = 0; i < 3; i++) {
      await fs.rm(f.plugin, { recursive: true });
      await waitUntil(async () => fs.readFile(path.join(f.plugin, "scripts/hook.mjs"), "utf8").then(text => text.includes("exact-old-hook"), () => false));
    }
    assert.deepEqual(errors, []);
    // A present replacement is never overwritten by a background timer.
    await fs.writeFile(path.join(f.plugin, "skills/example/SKILL.md"), "operator-edited bytes");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await fs.readFile(path.join(f.plugin, "skills/example/SKILL.md"), "utf8"), "operator-edited bytes");
  } finally {
    await Promise.all([first.close(), second.close()]);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("source and non-Codex shell roots never create a retention store", async () => {
  const f = await fixture();
  try {
    for (const environment of [{}, { ...f.environment, TRELIO_PLUGIN_ROOT: f.root },
      { ...f.environment, CODEX_HOME: path.join(f.root, "different-client") },
      { ...f.environment, TRELIO_PLUGIN_VERSION: "3.2.4" }]) {
      const preservation = startLoadedCodexPluginPreservation({ environment, retentionDirectory: f.retentionDirectory });
      assert.equal(await preservation.ready, null);
      await preservation.close();
    }
    await assert.rejects(fs.stat(f.retentionDirectory), { code: "ENOENT" });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

// Exercise Windows' EPERM collision result on every OS as well as through the
// native concurrent-start scenario above. Only an independently verified exact
// destination can turn a failed rename into an already-completed publication.
test("EPERM publication accepts only an existing verified snapshot, never an access denial", async () => {
  for (const publishFirst of [false, true]) {
    const f = await fixture();
    const rename = fs.rename;
    try {
      fs.rename = async (source, destination) => {
        if (destination.startsWith(f.retentionDirectory + path.sep)) {
          if (publishFirst) await rename(source, destination);
          throw Object.assign(new Error("synthetic directory rename result"), { code: "EPERM" });
        }
        return rename(source, destination);
      };
      const result = retainLoadedCodexPluginInstallation({
        loadedPluginDirectory: f.plugin, loadedPluginVersion: "3.2.3", retentionDirectory: f.retentionDirectory,
      });
      if (publishFirst) assert.equal((await result).version, "3.2.3");
      else await assert.rejects(result, { code: "EPERM" });
    } finally {
      fs.rename = rename;
      await fs.rm(f.root, { recursive: true, force: true });
    }
  }
});

test("EPERM cache restoration needs identical published bytes and preserves real access failures", async () => {
  for (const publishFirst of [false, true]) {
    const f = await fixture();
    const errors = [];
    const preservation = startLoadedCodexPluginPreservation({ ...f, checkIntervalMs: 20, onError: error => errors.push(error) });
    const rename = fs.rename;
    try {
      await preservation.ready;
      fs.rename = async (source, destination) => {
        if (destination === f.plugin) {
          if (publishFirst) await rename(source, destination);
          throw Object.assign(new Error("synthetic cache rename result"), { code: "EPERM" });
        }
        return rename(source, destination);
      };
      await fs.rm(f.plugin, { recursive: true });
      if (publishFirst) {
        await waitUntil(async () => fs.stat(f.plugin).then(() => true, () => false));
        await preservation.close();
        assert.deepEqual(errors, []);
      } else {
        await waitUntil(() => errors.length > 0);
        assert.equal(errors[0].code, "EPERM", "do not hide a permission failure behind missing destination");
        await assert.rejects(fs.stat(f.plugin), { code: "ENOENT" });
      }
    } finally {
      await preservation.close();
      fs.rename = rename;
      await fs.rm(f.root, { recursive: true, force: true });
    }
  }
});

test("a positively observed concurrent destination pruned during verification is rechecked", async () => {
  const f = await fixture();
  const errors = [];
  const preservation = startLoadedCodexPluginPreservation({ ...f, checkIntervalMs: 20, onError: error => errors.push(error) });
  const rename = fs.rename;
  const lstat = fs.lstat;
  let pruneOnObservation = false;
  let pruned = false;
  try {
    await preservation.ready;
    fs.rename = async (source, destination) => {
      await rename(source, destination);
      if (destination === f.plugin && !pruned) {
        // Emulate Windows' losing rename after another MCP has published the
        // same bytes. The next external update then prunes that winner while
        // this observer is still verifying it, before its next timer check.
        pruneOnObservation = true;
        throw Object.assign(new Error("synthetic concurrent publication"), { code: "EPERM" });
      }
    };
    fs.lstat = async (target, ...options) => {
      const metadata = await lstat(target, ...options);
      if (target === f.plugin && pruneOnObservation) {
        pruneOnObservation = false;
        pruned = true;
        await fs.rm(f.plugin, { recursive: true });
      }
      return metadata;
    };
    await fs.rm(f.plugin, { recursive: true });
    await waitUntil(() => pruned);
    await waitUntil(async () => fs.readFile(path.join(f.plugin, "scripts/hook.mjs"), "utf8").then(text => text.includes("exact-old-hook"), () => false));
    await preservation.close();
    assert.deepEqual(errors, [], "a proven second deletion must not stop the live observer");
  } finally {
    await preservation.close();
    fs.rename = rename;
    fs.lstat = lstat;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
