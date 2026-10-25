import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { installDeepseekBundle } from "../host-runtime/scripts/trelio-deepseek-install.mjs";
import { pluginDirectory } from "./test-layout.mjs";

test("native bundle is immutable, uses signed selection and never edits a Harness profile", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-dsh-install-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { pluginRoot: pluginDirectory, configDirectory: directory };
  const installed = await installDeepseekBundle(options);
  assert.equal(installed.installedInHarness, false);
  assert.deepEqual(await installDeepseekBundle(options), installed);
  const pkg = JSON.parse(await fs.readFile(path.join(installed.bundleDirectory, "package.json"), "utf8"));
  assert.equal(pkg.engines.dsh, "0.2.1-rc.2");
  const entry = await fs.readFile(path.join(installed.bundleDirectory, "index.mjs"), "utf8");
  assert.match(entry, /await selectHostRuntime\(\)/);
  assert.match(entry, /selected.runtimeVersion/);
  assert.doesNotMatch(entry, /runtimeSessionProof|accessToken|CODEX_THREAD_ID/);
  await fs.appendFile(path.join(installed.bundleDirectory, "index.mjs"), "// user edit\n");
  await assert.rejects(installDeepseekBundle(options), /TRELIO_HARNESS_BUNDLE_CHANGED/);
});

test("native adapter reaches the same private state and creates fresh method-bound signatures", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-dsh-proof-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const source = `
    import assert from 'node:assert/strict'; import crypto from 'node:crypto'; import path from 'node:path';
    import { writePrivateJsonFile, resolveWorkspaceBridgeConfigDirectory } from './host-runtime/scripts/trelio-workspace.mjs';
    import { prepareNativeRuntimeToolArguments } from './host-runtime/scripts/trelio-runtime-session.mjs';
    const observation = {schemaVersion:1,clientFamily:'deepseek-harness',modelId:'deepseek/v4',effortLevel:null,
      source:'deepseek_native',evidenceLevel:'local_observed',observedAt:new Date().toISOString()};
    const pair = crypto.generateKeyPairSync('ed25519'), runtimeSessionId=crypto.randomUUID();
    const key=crypto.createHash('sha256').update('https://trelio.ru\\ndsh:test-native').digest('hex');
    await writePrivateJsonFile(path.join(resolveWorkspaceBridgeConfigDirectory(),'runtime-sessions',key+'.json'),{
      schemaVersion:1,runtimeSessionId,expiresAt:new Date(Date.now()+60000).toISOString(),observation,runtimeRefreshSupported:true,
      privateKeyPkcs8:pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64url')});
    const nonces=new Set();
    for (let i=0;i<2;i++) {
      const input={companySlug:'synthetic-company',runtimeSessionProof:{forged:true},knownInstructionRevisionKey:'forged'};
      const prepared=await prepareNativeRuntimeToolArguments({sessionId:'test-native',observation,
        toolName:'mcp__trelio__get_agent_instructions',input});
      assert.equal(input.runtimeSessionProof.forged,true);
      assert.equal(prepared.knownInstructionRevisionKey,undefined);
      const proof=prepared.runtimeSessionProof; assert.ok(proof); assert.equal(nonces.has(proof.nonce),false); nonces.add(proof.nonce);
      const bytes=Buffer.from(['trelio-runtime-proof-v1',runtimeSessionId,'get_agent_instructions',proof.issuedAt,proof.nonce].join('\\n'));
      assert.equal(crypto.verify(null,bytes,pair.publicKey,Buffer.from(proof.signature,'base64url')),true);
    }
    process.stdout.write('verified');
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { shell: false,
      cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData/Local"),
        XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex"),
        TRELIO_WORKSPACE_ORIGIN: "https://trelio.ru", TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1" } });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    child.once("error", reject); child.once("close", code => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "verified");
});
