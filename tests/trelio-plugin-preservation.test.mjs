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
import { retainLoadedCodexPluginInstallation, restoreRetainedCodexPluginInstallations, startLoadedCodexPluginPreservation,
  readCodexPluginUpdateInventory, restoreAssistantCodexPluginVersion } from "../host-runtime/scripts/trelio-workspace.mjs";

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

test("hook-free main rollback reconciles a real native re-clone against its original receipt without rewriting Git or trust", async t => {
  const f = await fixture("assistant");
  t.after(() => fs.rm(f.root, {recursive: true, force: true}));
  await fs.rm(path.join(f.plugin, "hooks"), {recursive: true});
  await fs.writeFile(path.join(f.plugin, "package-integrity.json"), JSON.stringify({schemaVersion: 1,
    plugin: "trelio-digital-assistant", hookComponent: {pluginId: "trelio-digital-assistant-hooks@trelio-digital-assistants",
      version: "0.1.1", integritySha256: "a".repeat(64)}}));
  const source = path.join(f.root, "source"), hooks = path.join(f.root, "empty-hooks");
  const config = path.join(f.root, "empty-git-config");
  await fs.mkdir(hooks); await fs.writeFile(config, ""); await fs.rename(f.plugin, source);
  const git = (cwd, ...args) => execute("git", ["-c", `core.hooksPath=${hooks}`, ...args], {
    cwd, env: {...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config},
  });
  const commit = cwd => git(cwd, "-c", "user.name=Synthetic", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  await git(source, "init"); await git(source, "branch", "-M", "main"); await git(source, "add", "."); await commit(source);
  const detached = (await git(source, "rev-parse", "HEAD")).stdout.trim();
  await git(source, "repack", "-ad", "-n");
  await git(f.root, "clone", "--no-hardlinks", source, f.plugin); await git(f.plugin, "checkout", "--detach", detached);
  const entry = await retainLoadedCodexPluginInstallation({profile: "assistant", retentionDirectory: f.retentionDirectory,
    loadedPluginDirectory: f.plugin, loadedPluginVersion: "0.1.3"});
  const receiptBytes = await fs.readFile(path.join(entry.entryDirectory, "metadata.json"));
  // The official repository advanced after the first install. Reinstalling
  // the SAME immutable old commit now clones newer inactive main/tag history.
  // Only the disposable fixture is pruned; no live/native cache is touched.
  await fs.writeFile(path.join(source, "newer-source-only"), "not part of the old distribution\n");
  await git(source, "add", "."); await commit(source); await git(source, "tag", "future-version"); await git(source, "repack", "-ad", "-n");
  await fs.rm(f.plugin, {recursive: true});
  await git(f.root, "clone", "--no-hardlinks", source, f.plugin); await git(f.plugin, "checkout", "--detach", detached);
  const currentRefs = await fs.readFile(path.join(f.plugin, ".git/packed-refs"));
  const market = path.join(f.root, "market"); await fs.mkdir(path.join(market, ".agents/plugins"), {recursive: true});
  await fs.writeFile(path.join(market, ".agents/plugins/marketplace.json"), JSON.stringify({name: "trelio-digital-assistants",
    plugins: [{name: "trelio-digital-assistant", source: {source: "url", url: "https://github.com/trelio-ru/digital-assistants.git", ref: "plugin-v0.1.3"}}]}));
  const mutations = []; let present = true;
  const execFileCommand = async (_command, args) => {
    let result;
    if (args[1] === "marketplace" && args[2] === "list") result = {marketplaces: present ? [{name: "trelio-digital-assistants", root: market,
      marketplaceSource: {sourceType: "git", source: "https://github.com/trelio-ru/digital-assistants.git"}}] : []};
    else if (args[1] === "list") result = {installed: [{pluginId: "trelio-digital-assistant@trelio-digital-assistants", version: "0.1.3", installed: true, enabled: true}]};
    else {
      mutations.push(args);
      assert.equal(args[1], "marketplace", "a positive rollback read-back NEVER repeats plugin add");
      if (args[2] === "remove") {present = false; result = {};}
      else {assert.deepEqual(args, ["plugin", "marketplace", "add", "https://github.com/trelio-ru/digital-assistants.git", "--ref", "main", "--json"]); present = true; result = {};}
    }
    return {stdout: JSON.stringify(result)};
  };
  const options = {profile: "assistant", execFileCommand, environment: f.environment, retentionDirectory: f.retentionDirectory};
  const receipt = {version: "0.1.3", treeSha256: entry.treeSha256};
  const raw = await readCodexPluginUpdateInventory(options);
  assert.notEqual(raw.treeSha256, receipt.treeSha256, "the real clone must have different physical Git bytes");
  const observed = await readCodexPluginUpdateInventory({...options, receipt});
  assert.equal(observed.treeSha256, receipt.treeSha256);
  assert.equal(observed.observedTreeSha256, raw.treeSha256);
  assert.equal(await restoreRetainedCodexPluginInstallations({profile: "assistant", retentionDirectory: f.retentionDirectory}), 1);
  const restored = await restoreAssistantCodexPluginVersion({...options, ...receipt,
    loadedPluginDirectory: f.plugin, loadedPluginVersion: "0.1.3"});
  assert.equal(restored.treeSha256, receipt.treeSha256);
  assert.equal(mutations.length, 2, "only official main discovery is restored, once");
  assert.deepEqual(await fs.readFile(path.join(f.plugin, ".git/packed-refs")), currentRefs);
  assert.deepEqual(await fs.readFile(path.join(entry.entryDirectory, "metadata.json")), receiptBytes);

  for (const name of [".git/config", ".git/HEAD", ".git/refs/heads/foreign", ".git/hooks/post-checkout", "skills/example/SKILL.md"]) {
    const file = path.join(f.plugin, name); let original = null;
    try { original = await fs.readFile(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, "changed authority or executable bytes\n");
    await assert.rejects(readCodexPluginUpdateInventory({...options, receipt}), undefined, name);
    assert.equal(await fs.readFile(file, "utf8"), "changed authority or executable bytes\n", "refusal never repairs/overwrites changed bytes");
    if (original === null) await fs.rm(file); else await fs.writeFile(file, original);
  }
  await assert.rejects(readCodexPluginUpdateInventory({...options, receipt: {...receipt, treeSha256: "f".repeat(64)}}), /unavailable/);
  const packDirectory=path.join(f.plugin,'.git/objects/pack');
  const pack=path.join(packDirectory,(await fs.readdir(packDirectory)).find(name=>name.endsWith('.pack')));
  const originalPack=await fs.readFile(pack),mode=(await fs.stat(pack)).mode&0o777;
  await fs.chmod(pack,0o600);const corrupt=Buffer.from(originalPack);corrupt[20]^=0xff;await fs.writeFile(pack,corrupt);
  await assert.rejects(readCodexPluginUpdateInventory({...options,receipt}),/could not be verified/);
  await fs.writeFile(pack,originalPack);await fs.chmod(pack,mode);
  assert.equal(mutations.length, 2, "negative receipt checks are read-only");
});

for (const profile of ["human", "assistant"]) {
  test(`${profile} live preservation restores an in-place empty native version root`, async () => {
    const f = await fixture(profile);
    const errors = [];
    const preservation = startLoadedCodexPluginPreservation({environment: f.environment,
      retentionDirectory: f.retentionDirectory, checkIntervalMs: 20, onError: error => errors.push(error)});
    try {
      const entry = await preservation.ready;
      const metadataPath = path.join(entry.entryDirectory, "metadata.json");
      const metadata = await fs.readFile(metadataPath);
      const manifest = await fs.readFile(path.join(f.plugin, ".codex-plugin/plugin.json"));
      // Model the observed Codex Windows prune exactly: remove children from
      // OUR disposable fixture, leaving the regular version directory empty.
      // Presence of the root alone must not suppress the same retained restore.
      for (const name of await fs.readdir(f.plugin)) await fs.rm(path.join(f.plugin, name), {recursive: true});
      await waitUntil(() => fs.readFile(path.join(f.plugin, "scripts/hook.mjs"), "utf8")
        .then(value => value.includes("exact-old-hook"), () => false));
      await preservation.close(); // Wait for full publication, not mere file visibility.
      assert.deepEqual(errors, []);
      assert.deepEqual(await fs.readFile(path.join(f.plugin, ".codex-plugin/plugin.json")), manifest);
      assert.deepEqual(await fs.readFile(metadataPath), metadata, "neither immutable receipt nor native trust is rewritten");
    } finally { await preservation.close(); await fs.rm(f.root, {recursive: true, force: true}); }
  });

  for (const race of ["none", "concurrent-file", "permission"]) {
    test(`${profile} empty-root restore preserves concurrent bytes and real rmdir refusals (${race})`, async t => {
      const f = await fixture(profile);
      const originalRmdir = fs.rmdir;
      try {
        await retainLoadedCodexPluginInstallation({profile, retentionDirectory: f.retentionDirectory,
          loadedPluginDirectory: f.plugin, loadedPluginVersion: path.basename(f.plugin)});
        for (const name of await fs.readdir(f.plugin)) await fs.rm(path.join(f.plugin, name), {recursive: true});
        let attempts = 0;
        t.mock.method(fs, "rmdir", async (target, ...options) => {
          if (target === f.plugin) {
            attempts++;
            assert.equal(options.length, 0, "the exact empty root is NEVER recursively deleted");
            if (race === "concurrent-file") await fs.writeFile(path.join(f.plugin, "foreign-sentinel"), "preserve concurrent bytes");
            if (race === "permission") throw Object.assign(new Error("synthetic native permission refusal"), {code: "EPERM"});
          }
          return originalRmdir.call(fs, target, ...options);
        });
        const restore = restoreRetainedCodexPluginInstallations({profile, retentionDirectory: f.retentionDirectory});
        if (race === "none") {
          assert.equal(await restore, 1);
          assert.match(await fs.readFile(path.join(f.plugin, "scripts/hook.mjs"), "utf8"), /exact-old-hook/);
        } else {
          await assert.rejects(restore, race === "permission" ? {code: "EPERM"} : undefined);
          if (race === "concurrent-file") assert.equal(await fs.readFile(path.join(f.plugin, "foreign-sentinel"), "utf8"), "preserve concurrent bytes");
          else assert.deepEqual(await fs.readdir(f.plugin), [], "permission refusal never becomes an overwrite");
        }
        assert.equal(attempts, 1, "one observed empty-root publication, no blind retry");
      } finally { t.mock.restoreAll(); await fs.rm(f.root, {recursive: true, force: true}); }
    });
  }

  test(`${profile} legacy retention accepts native Git metadata changes without overwriting them`, async () => {
    const f = await fixture(profile);
    try {
      // Use a genuine native Git clone, not a directory called .git. Codex's
      // Git-backed install refreshes this mutable index/reflog independently
      // of the immutable plugin payload and the schema-v1 retained receipt.
      const source = path.join(f.root, "source"), hooks = path.join(f.root, "empty-hooks");
      // Git for Windows does not accept Node's extended \\.\nul device as
      // GIT_CONFIG_GLOBAL. Use an actual empty fixture file on every OS; the
      // real user's global configuration is never read or modified.
      const globalConfig = path.join(f.root, "empty-git-config");
      await fs.writeFile(globalConfig, "");
      await fs.mkdir(hooks);
      await fs.rename(f.plugin, source);
      const git = (cwd, ...args) => execute("git", ["-c", `core.hooksPath=${hooks}`, ...args], {
        cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig },
      });
      await git(source, "init");
      await git(source, "add", ".");
      await git(source, "-c", "user.name=Synthetic", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
      await git(f.root, "clone", "--no-hardlinks", source, f.plugin);
      // Match native Git-backed packages, which are already packed before
      // retention. Re-encoding that SAME object set must not become changed
      // executable code; the legacy schema-v1 copy remains byte-exact.
      await git(f.plugin, "-c", "repack.writeBitmaps=false", "repack", "-ad", "-n");
      const version = path.basename(f.plugin);
      const entry = await retainLoadedCodexPluginInstallation({
        profile, retentionDirectory: f.retentionDirectory, loadedPluginDirectory: f.plugin, loadedPluginVersion: version,
      });
      const metadataPath = path.join(entry.entryDirectory, "metadata.json"), metadata = await fs.readFile(metadataPath);
      assert.equal(JSON.parse(metadata).schemaVersion, 1);
      await git(f.plugin, "update-index", "--assume-unchanged", "scripts/hook.mjs");
      await git(f.plugin, "reflog", "expire", "--expire=now", "--all");
      const index = await fs.readFile(path.join(f.plugin, ".git/index"));
      const config = await fs.readFile(path.join(f.plugin, ".git/config"));
      assert.notDeepEqual(index, await fs.readFile(path.join(entry.pluginDirectory, ".git/index")));

      assert.equal(await restoreRetainedCodexPluginInstallations({ profile, retentionDirectory: f.retentionDirectory }), 1);
      assert.deepEqual(await fs.readFile(path.join(f.plugin, ".git/index")), index);
      assert.deepEqual(await fs.readFile(path.join(f.plugin, ".git/config")), config);
      assert.deepEqual(await fs.readFile(metadataPath), metadata, "old immutable receipts are not rewritten");

      const packDirectory=path.join(f.plugin,'.git','objects','pack');
      const originalPacks=await fs.readdir(packDirectory);
      await git(f.plugin,'-c','pack.compression=0','-c','repack.writeBitmaps=false','repack','-adf','-n','--window=0');
      const repackedNames=await fs.readdir(packDirectory);
      assert.notDeepEqual(repackedNames,originalPacks,'real Git must generate a different physical pack');
      const repacked=await Promise.all(repackedNames.map(async name=>[name,await fs.readFile(path.join(packDirectory,name))]));
      assert.equal(await restoreRetainedCodexPluginInstallations({profile,retentionDirectory:f.retentionDirectory}),1);
      for(const [name,bytes] of repacked)assert.deepEqual(await fs.readFile(path.join(packDirectory,name)),bytes,'valid repack is left untouched');
      assert.deepEqual(await fs.readFile(metadataPath),metadata,'a repack cannot rewrite the historical receipt');

      // A new valid but unreachable packed object is NOT a mere repack.
      // Keep refs/config/payload unchanged so only the complete object reader
      // can reject it, rather than relying on a changed-ref shortcut.
      const gitInput=(args,input)=>new Promise((resolve,reject)=>{
        const child=execFile('git',['-c',`core.hooksPath=${hooks}`,...args],{cwd:f.plugin,env:{...process.env,GIT_CONFIG_GLOBAL:globalConfig,GIT_CONFIG_NOSYSTEM:'1'}},(error,stdout)=>error?reject(error):resolve(stdout.trim()));
        child.stdin.end(input);
      });
      const extra=await gitInput(['hash-object','-w','--stdin'],'new packed object, never an admitted payload');
      assert.match(extra,/^[a-f0-9]{40}$/u);
      const extraPack=await gitInput(['pack-objects',path.join(packDirectory,'pack')],extra+'\n');
      assert.match(extraPack,/^[a-f0-9]{40}$/u);
      await fs.rm(path.join(f.plugin,'.git','objects',extra.slice(0,2),extra.slice(2)));
      await assert.rejects(restoreRetainedCodexPluginInstallations({profile,retentionDirectory:f.retentionDirectory}));
      for(const ext of ['pack','idx','rev'])await fs.rm(path.join(packDirectory,`pack-${extraPack}.${ext}`),{force:true});
      const packedFile=repacked.find(([name])=>name.endsWith('.pack'));
      const damaged=Buffer.from(packedFile[1]);damaged[20]^=0xff;
      // Git makes pack files read-only. Change only this disposable fixture's
      // mode to construct corruption; production readers never chmod objects.
      const packMode=(await fs.stat(path.join(packDirectory,packedFile[0]))).mode & 0o777;
      await fs.chmod(path.join(packDirectory,packedFile[0]),0o600);
      await fs.writeFile(path.join(packDirectory,packedFile[0]),damaged);
      await assert.rejects(restoreRetainedCodexPluginInstallations({profile,retentionDirectory:f.retentionDirectory}));
      await fs.writeFile(path.join(packDirectory,packedFile[0]),packedFile[1]);
      await fs.chmod(path.join(packDirectory,packedFile[0]),packMode);

      // Git control files can select commands and filters. They remain strict
      // code bytes, even though native index/reflog changes are permitted.
      await git(f.plugin, "config", "trelioFixture.changed", "true");
      await assert.rejects(restoreRetainedCodexPluginInstallations({ profile, retentionDirectory: f.retentionDirectory }), /другие bytes/);
      await fs.writeFile(path.join(f.plugin, ".git/config"), config);
      const checkoutHook = path.join(f.plugin, ".git/hooks/post-checkout");
      await fs.writeFile(checkoutHook, "never execute this synthetic changed hook\n");
      await assert.rejects(restoreRetainedCodexPluginInstallations({ profile, retentionDirectory: f.retentionDirectory }), /другие bytes/);
      await fs.rm(checkoutHook);
      await git(f.plugin, "update-ref", "refs/heads/retention-fixture", "HEAD");
      await assert.rejects(restoreRetainedCodexPluginInstallations({ profile, retentionDirectory: f.retentionDirectory }), /другие bytes/);
      await git(f.plugin, "update-ref", "-d", "refs/heads/retention-fixture");

      // Every payload byte still matters, even alongside a legitimate native
      // metadata change. No other file may be excluded as checkout metadata.
      const hookPath = path.join(f.plugin, "scripts/hook.mjs"), originalHook = await fs.readFile(hookPath);
      await fs.writeFile(hookPath, "changed executable");
      await assert.rejects(restoreRetainedCodexPluginInstallations({ profile, retentionDirectory: f.retentionDirectory }), /другие bytes/);
      assert.equal(await fs.readFile(hookPath, "utf8"), "changed executable", "refusal does not overwrite an existing installation");
      await fs.writeFile(hookPath, originalHook);
      await fs.writeFile(path.join(f.plugin, ".gitignore"), "a payload file, not checkout metadata\n");
      await assert.rejects(restoreRetainedCodexPluginInstallations({ profile, retentionDirectory: f.retentionDirectory }), /другие bytes/);
      await fs.rm(path.join(f.plugin, ".gitignore"));

      // A gitdir file cannot borrow the directory exception. The retained
      // snapshot itself must always pass its historical COMPLETE digest too.
      await fs.rename(path.join(f.plugin, ".git"), path.join(f.root, "moved-git"));
      await fs.writeFile(path.join(f.plugin, ".git"), "gitdir: elsewhere\n");
      await assert.rejects(restoreRetainedCodexPluginInstallations({ profile, retentionDirectory: f.retentionDirectory }), /другие bytes/);
      await fs.rm(path.join(f.plugin, ".git"));
      await fs.rename(path.join(f.root, "moved-git"), path.join(f.plugin, ".git"));
      await fs.appendFile(path.join(entry.pluginDirectory, ".git/config"), "\ncorrupted retained metadata\n");
      await assert.rejects(restoreRetainedCodexPluginInstallations({ profile, retentionDirectory: f.retentionDirectory }), /повреждена/);
      assert.deepEqual(await fs.readFile(metadataPath), metadata);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
}

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
  const rename = fs.rename;
  const remove = fs.rm;
  let releasePublications = () => {};
  let publicationBarrier;
  let publications = 0;
  let cleanups = 0;
  try {
    await Promise.all([first.ready, second.ready]);
    // Make both real observers reach publication before either rename runs.
    // A restored file becoming visible does NOT mean the losing observer has
    // finished checking the winner. Pruning again at that point can erase the
    // only evidence that distinguishes Windows' EPERM collision from a genuine
    // permission failure. Keep those refusals terminal: the separate deletion-
    // during-verification regression covers a positively observed second prune.
    fs.rename = async (source, destination) => {
      if (destination === f.plugin) {
        publications++;
        if (publications === 2) releasePublications();
        await publicationBarrier;
      }
      return rename(source, destination);
    };
    fs.rm = async (target, ...args) => {
      const result = await remove(target, ...args);
      if (path.dirname(target) === path.dirname(f.plugin)
        && path.basename(target).startsWith(".3.2.3.trelio-retain-")) cleanups++;
      return result;
    };
    for (let i = 0; i < 3; i++) {
      publications = 0;
      cleanups = 0;
      publicationBarrier = new Promise(resolve => { releasePublications = resolve; });
      await fs.rm(f.plugin, { recursive: true });
      // Each finally removes only its own staging tree AFTER verification.
      // Observe both completions, without sleeps, fake rename results or an
      // observer restart between rounds; all filesystem/security checks run.
      await waitUntil(() => cleanups === 2);
      assert.equal(publications, 2);
      assert.match(await fs.readFile(path.join(f.plugin, "scripts/hook.mjs"), "utf8"), /exact-old-hook/u);
    }
    assert.deepEqual(errors, []);
    // A present replacement is never overwritten by a background timer.
    await fs.writeFile(path.join(f.plugin, "skills/example/SKILL.md"), "operator-edited bytes");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await fs.readFile(path.join(f.plugin, "skills/example/SKILL.md"), "utf8"), "operator-edited bytes");
  } finally {
    releasePublications();
    await Promise.all([first.close(), second.close()]);
    fs.rename = rename;
    fs.rm = remove;
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
