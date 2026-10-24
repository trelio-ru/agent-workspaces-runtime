import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readCodexConversationTitle, syncRunCodexConversationTitle,resolveCodexExecutable,readWindowsCodexPackagePath } from "../host-runtime/scripts/trelio-codex-conversation.mjs";
import { protectLocalActionArguments } from "../host-runtime/scripts/trelio-local-context.mjs";
import { createAgentEncryptionDevice, decryptCompanyPayload } from "../host-runtime/scripts/trelio-company-encryption.mjs";
import { synchronizeRunCodexTitle } from "../host-runtime/scripts/trelio-workspace.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const snapshot = { conversationId: id, title: "Старое название", expectedStateHash: "a".repeat(64) };

const desktopCopyFixture=()=>{
  const w=path.win32,key=value=>w.normalize(value).toLowerCase(),root='C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture';
  const environment={PATH:'',LOCALAPPDATA:'C:\\Users\\Fixture\\AppData\\Local',USERPROFILE:'C:\\Users\\Fixture'};
  const names=['codex.exe','codex-code-mode-host.exe','codex-windows-sandbox-setup.exe','codex-command-runner.exe'];
  const bytes=names.map(name=>Buffer.from(`synthetic public vendor ${name}`)),combined=createHash('sha256');
  for(let i=0;i<names.length;i++)combined.update(names[i]).update('\0').update(createHash('sha256').update(bytes[i]).digest('hex')).update('\0');
  const selected=w.join(environment.LOCALAPPDATA,'OpenAI','Codex','bin',combined.digest('hex').slice(0,16));
  const dirs=new Set([root,w.join(root,'app'),w.join(root,'app','resources'),environment.LOCALAPPDATA,
    ...['OpenAI','OpenAI\\Codex','OpenAI\\Codex\\bin'].map(p=>w.join(environment.LOCALAPPDATA,p)),selected].map(key));
  const files=new Map();for(let i=0;i<names.length;i++){files.set(key(w.join(root,'app','resources',names[i])),bytes[i]);files.set(key(w.join(selected,names[i])),bytes[i]);}
  const links=new Set();let lookups=0,reads=0,opens=0;
  const stat=name=>({isFile:()=>files.has(key(name)),isDirectory:()=>dirs.has(key(name)),isSymbolicLink:()=>links.has(key(name)),
    size:files.get(key(name))?.length??0,mtimeMs:1,ctimeMs:1,ino:1,dev:1});
  const filesystem={realpath:async name=>{if(!dirs.has(key(name))&&!files.has(key(name)))throw Error('absent');return w.normalize(name);},
    stat:async name=>stat(name),lstat:async name=>stat(name),open:async name=>{opens++;let position=0;return {read:async(buffer,offset,length)=>{
      reads++;const bytesRead=files.get(key(name)).copy(buffer,offset,position,position+length);position+=bytesRead;return {bytesRead};},close:async()=>{}};},
    readdir:()=>assert.fail('no cache inventory or newest selection'),writeFile:()=>assert.fail('no vendor relocation/install')};
  const readPackagePath=async()=>{lookups++;return root;};
  return {environment,filesystem,readPackagePath,root,selected,names,files,links,key,lookups:()=>lookups,opens:()=>opens,reads:()=>reads};
};

test('desktop copy selection derives the exact vendor ordered four-file hash and verifies existing copy without inventory or writes',async()=>{
  const f=desktopCopyFixture();
  assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:f.readPackagePath}),path.win32.join(f.selected,'codex.exe'));
  assert.equal(f.lookups(),2,'native current-user package is read before and after exact hashes');assert.equal(f.opens(),8);
});

test('desktop discovery rejects modified/missing/reparse/retargeted copies and cancels before another file read',async()=>{
  for(const scenario of ['modified','missing','source_link','copy_link','package_change','abort']){
    const f=desktopCopyFixture(),controller=new AbortController();let lookups=0;
    if(scenario==='modified')f.files.set(f.key(path.win32.join(f.selected,'codex.exe')),Buffer.from('other binary'));
    if(scenario==='missing')f.files.delete(f.key(path.win32.join(f.selected,f.names[3])));
    if(scenario==='source_link')f.links.add(f.key(path.win32.join(f.root,'app','resources','codex.exe')));
    if(scenario==='copy_link')f.links.add(f.key(f.selected));
    const readPackagePath=async()=>{lookups++;return scenario==='package_change'&&lookups===2?f.root+'2':f.root;};
    if(scenario==='abort'){const open=f.filesystem.open;f.filesystem.open=async name=>{const handle=await open(name);return {...handle,read:async(...args)=>{
      const result=await handle.read(...args);controller.abort();return result;}};};}
    assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath,signal:controller.signal}),null,scenario);
    if(scenario==='abort')assert.equal(f.reads(),1);
  }
});

test('fixed AppModel worker protocol exposes only validated available metadata and accepts no path/command selectors',async()=>{
  for(const response of [{schemaVersion:1,state:'available',pathBase64:Buffer.from('C:\\Program Files\\WindowsApps\\Codex_fixture').toString('base64')},
    {schemaVersion:1,state:'unavailable'},{schemaVersion:1,state:'available',pathBase64:'not canonical base64'},
    {schemaVersion:1,state:'available',pathBase64:Buffer.from('C:\\fixture').toString('base64'),canary:'not allowed'}]){
    const spawnProcess=(program,args,settings)=>{assert.equal(program,'signed-native-worker');assert.deepEqual(args,['--codex-package-path']);
      assert.equal(settings.shell,false);assert.deepEqual(settings.stdio,['ignore','pipe','ignore']);assert.equal(settings.env.PATH,'');
      const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};
      queueMicrotask(()=>{child.stdout.end(JSON.stringify(response)+'\n');child.emit('close',0);});return child;};
    const result=await readWindowsCodexPackagePath({spawnProcess,selectWorker:async()=>({executable:'signed-native-worker'})});
    assert.equal(result,response.state==='available'&&!response.canary&&response.pathBase64!=='not canonical base64'?'C:\\Program Files\\WindowsApps\\Codex_fixture':null);
  }
});

const windowsStandaloneFixture=({modern=true,customHome=false}={})=>{
  const w=path.win32,key=value=>w.normalize(value).toLowerCase();
  const environment={PATH:'',LOCALAPPDATA:'C:\\Users\\Fixture\\AppData\\Local',USERPROFILE:'C:\\Users\\Fixture',
    ...(customHome?{CODEX_HOME:'D:\\Codex profile'}:{})};
  const home=environment.CODEX_HOME??w.join(environment.USERPROFILE,'.codex'),root=w.join(home,'packages','standalone'),releases=w.join(root,'releases');
  const selected=w.join(releases,'0.164.0-x86_64-pc-windows-msvc'),current=w.join(root,'current');
  const visible=w.join(environment.LOCALAPPDATA,'Programs','OpenAI','Codex','bin','codex.exe');
  const executable=w.join(selected,modern?'bin\\codex.exe':'codex.exe');
  const companions=modern?['codex-package.json','bin\\codex.exe','bin\\codex-code-mode-host.exe','codex-path\\rg.exe',
    'codex-resources\\codex-command-runner.exe','codex-resources\\codex-windows-sandbox-setup.exe']
    :['codex.exe','codex-resources\\codex-command-runner.exe','codex-resources\\codex-windows-sandbox-setup.exe','codex-resources\\rg.exe'];
  const directories=new Set([home,root,releases,selected].map(key)),files=new Set(companions.map(name=>key(w.join(selected,name))));
  const resolved=new Map([...directories,...files].map(name=>[name,name]));resolved.set(key(current),selected);resolved.set(key(visible),executable);
  const links=new Set();let reads=0;
  const filesystem={realpath:async name=>{reads++;if(!resolved.has(key(name)))throw Object.assign(new Error('absent'),{code:'ENOENT'});return resolved.get(key(name));},
    stat:async name=>({isFile:()=>files.has(key(name)),isDirectory:()=>directories.has(key(name))}),
    lstat:async name=>({isSymbolicLink:()=>links.has(key(name))}),readdir:()=>assert.fail('resolver must not scan a directory'),
    writeFile:()=>assert.fail('resolver must not change installation/PATH')};
  return {environment,filesystem,root,releases,current,visible,selected,executable,files,resolved,links,key,reads:()=>reads};
};

test('Windows fixed standalone discovery follows only the official selected junction layout with complete companions and keeps PATH priority',async()=>{
  for(const modern of [true,false])for(const customHome of [true,false]){
    const f=windowsStandaloneFixture({modern,customHome});
    assert.equal((await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:async()=>null})).toLowerCase(),f.executable.toLowerCase());
    const pathExe='C:\\Tools\\codex.exe';f.environment.PATH='C:\\Tools';f.resolved.set(f.key(pathExe),pathExe);f.files.add(f.key(pathExe));
    assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:async()=>null}),pathExe);
  }
});

test('Windows fallback rejects escaped/partial/file-link and concurrently retargeted installs without scanning or launching anything',async()=>{
  for(const scenario of ['escaped','nested','incomplete','file_link','releases_link','retarget','absent','store']){
    const f=windowsStandaloneFixture();let currentReads=0;
    if(scenario==='escaped'||scenario==='store')f.resolved.set(f.key(f.visible),scenario==='store'?'C:\\Program Files\\WindowsApps\\OpenAI.Codex_example\\app\\resources\\codex.exe':'D:\\elsewhere\\codex.exe');
    if(scenario==='nested')f.resolved.set(f.key(f.current),path.win32.join(f.selected,'nested'));
    if(scenario==='incomplete')f.files.delete(f.key(path.win32.join(f.selected,'codex-package.json')));
    if(scenario==='file_link')f.links.add(f.key(f.visible));
    if(scenario==='releases_link')f.links.add(f.key(f.releases));
    if(scenario==='absent')f.resolved.delete(f.key(f.current));
    const realpath=f.filesystem.realpath;f.filesystem.realpath=async name=>{
      if(scenario==='retarget'&&f.key(name)===f.key(f.current)&&++currentReads>1)return path.win32.join(f.releases,'0.165.0-x86_64-pc-windows-msvc');
      return realpath(name);
    };
    assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:async()=>null}),null,scenario);
  }
  const f=windowsStandaloneFixture(),controller=new AbortController();controller.abort();
  assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:async()=>null,signal:controller.signal}),null);
  assert.equal(f.reads(),0,'an expired original deadline performs no discovery I/O');
});

test('Windows native filesystem accepts only its own synthetic official junctions when the Store app is absent', {skip:process.platform!=='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-standalone-discovery-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const environment={PATH:'',LOCALAPPDATA:path.join(directory,'Local'),USERPROFILE:path.join(directory,'User')};
  const root=path.join(environment.USERPROFILE,'.codex','packages','standalone'),selected=path.join(root,'releases','0.164.0-x86_64-pc-windows-msvc');
  const files=['codex-package.json','bin/codex.exe','bin/codex-code-mode-host.exe','codex-path/rg.exe',
    'codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe'];
  for(const name of files){await fs.mkdir(path.dirname(path.join(selected,name)),{recursive:true});await fs.writeFile(path.join(selected,name),'synthetic non-executable fixture');}
  const visible=path.join(environment.LOCALAPPDATA,'Programs','OpenAI','Codex','bin');
  await fs.mkdir(path.dirname(visible),{recursive:true});await fs.symlink(selected,path.join(root,'current'),'junction');
  await fs.symlink(path.join(root,'current','bin'),visible,'junction');
  assert.equal((await resolveCodexExecutable(environment)).toLowerCase(),(await fs.realpath(path.join(selected,'bin','codex.exe'))).toLowerCase());
  await fs.rm(path.join(selected,'codex-package.json'));
  assert.equal(await resolveCodexExecutable(environment),null,'a copied CLI alone is not a standalone runtime');
  // These are synthetic regular files and actual OS junctions, not a real
  // installed Codex CLI, account, executable launch or business acceptance.
});

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
