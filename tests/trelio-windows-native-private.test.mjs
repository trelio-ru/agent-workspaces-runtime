import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, copyFile, readdir as fsReaddir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import crypto from 'node:crypto';
import { createPrivateAclWorker, windowsPrivateWorkerOptions, scopedPrivateAclWorker,
  withRuntimeHookPrivateSession } from '../host-runtime/scripts/trelio-hook-private-session.mjs';
import { hardenWindowsPrivatePath, protectWindowsBridgeSessionToken, unprotectWindowsBridgeSessionToken,
  buildWindowsBridgeDpapiInvocation, resolveWindowsPowerShellExecutable } from '../host-runtime/scripts/trelio-workspace.mjs';
import { validateWindowsPrivateWorker } from '../scripts/validate-windows-private-worker.mjs';
import { createAssistantPrivateStore, resolveAssistantCompanyEncryptionDevice } from '../host-runtime/scripts/trelio-assistant-private.mjs';

const windows = {skip: process.platform !== 'win32'};
test('managed company identity survives real CurrentUser DPAPI restart without plaintext key files', windows, async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'trelio-assistant-company-key-'));
  const identity={origin:'https://fixture.invalid',assistantId:crypto.randomUUID(),deviceId:crypto.randomUUID()};
  const companyId=crypto.randomUUID(),directory=path.join(root,'credentials');
  const input={origin:identity.origin,kind:'company_encryption',id:companyId,deviceId:identity.deviceId};
  const prepare=()=>withRuntimeHookPrivateSession(8_000,async()=>{
    const store=createAssistantPrivateStore({directory});
    const device=await resolveAssistantCompanyEncryptionDevice({identity,companyId,store,
      lockDirectory:path.join(root,'locks'),assertCurrent:async()=>{}});
    const saved=await store.get(input);
    // Assertions receive booleans, never a private JWK or derived unlock key.
    const disk=await Promise.all((await fsReaddir(directory)).map(name=>readFile(path.join(directory,name),'utf8')));
    assert.equal(disk.some(text=>text.includes(device.privateBundle.encryptionPrivateJwk.d)
      ||text.includes(saved.trustedUnlockKey)),false,'OS-protected files contain no plaintext key');
    assert.equal(await store.get({...input,deviceId:crypto.randomUUID()}),null);
    return device.fingerprint;
  });
  try { assert.equal(await prepare(),await prepare()); }
  finally { await rm(root,{recursive:true,force:true}); }
});
test('native package admission rejects changed source and binary bytes', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'trelio-native-package-'));
  const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
  try {
    const source='synthetic reviewed source';
    await writeFile(path.join(root,'PrivateProcess.cpp'),source);
    const metadata={schemaVersion:1,sourceSha256:sha(source),binaries:{}};
    for(const [arch,machine] of Object.entries({x64:0x8664,ia32:0x14c,arm64:0xaa64})) {
      const bytes=Buffer.alloc(128); bytes.writeUInt16LE(0x5a4d,0); bytes.writeUInt32LE(64,0x3c);
      bytes.writeUInt32LE(0x4550,64); bytes.writeUInt16LE(machine,68);
      await mkdir(path.join(root,'bin',arch),{recursive:true});
      await writeFile(path.join(root,'bin',arch,'trelio-private-process.exe'),bytes);
      metadata.binaries[arch]={sizeBytes:bytes.length,sha256:sha(bytes)};
    }
    await writeFile(path.join(root,'bin','metadata.json'),JSON.stringify(metadata));
    await validateWindowsPrivateWorker(root);
    await writeFile(path.join(root,'PrivateProcess.cpp'),'changed source');
    await assert.rejects(validateWindowsPrivateWorker(root));
    await writeFile(path.join(root,'PrivateProcess.cpp'),source);
    await writeFile(path.join(root,'bin','x64','trelio-private-process.exe'),'changed binary');
    await assert.rejects(validateWindowsPrivateWorker(root));
  } finally { await rm(root,{recursive:true,force:true}); }
});
const run = (program, args, input = '', env = process.env, timeout = 15_000) => new Promise((resolve, reject) => {
  const child = spawn(program, args, {shell:false, windowsHide:true, env,
    stdio:['pipe','pipe','pipe'], timeout});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({code, signal, stdout, stderr}));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});
const legacy = async (origin, mode, input) => {
  const invocation = buildWindowsBridgeDpapiInvocation(origin, mode);
  // This is an OFFLINE compatibility oracle, outside the original 8-second
  // native hook below. On hosted ARM the separate inbox PowerShell/CLR process
  // was killed at exactly 15 seconds before this oracle completed; that is not
  // native worker timing. Give only this oracle a bounded startup budget, keep
  // its original script/DPAPI call and do not retry any invocation.
  const args=[...invocation.args], script=Buffer.from(args.at(-1),'base64').toString('utf16le');
  args[args.length-1]=Buffer.from('[Console]::Error.WriteLine("TRELIO_LEGACY_STAGE entered")\n'+script
    .replace('Add-Type -AssemblyName System.Security', 'Add-Type -AssemblyName System.Security\n[Console]::Error.WriteLine("TRELIO_LEGACY_STAGE assembly")'), 'utf16le').toString('base64');
  const started=Date.now();
  const result = await run(invocation.executable, args, input+'\n',
    {...process.env,...invocation.environment},45_000);
  const phase=result.stderr.includes('TRELIO_LEGACY_STAGE assembly')?'assembly'
    :result.stderr.includes('TRELIO_LEGACY_STAGE entered')?'entered':'startup';
  // Never expose the oracle's stdout, input or arbitrary PowerShell error text.
  console.error(JSON.stringify({fixtureStage:'legacy_dpapi',phase,elapsedMs:Date.now()-started,
    code:result.code,signal:result.signal}));
  assert.equal(result.code,0,`Legacy DPAPI oracle did not complete (${phase}).`);
  return result.stdout.trim();
};

test('native selector has exact package paths and never resolves a shell or PATH', () => {
  for (const arch of ['x64','ia32','arm64']) {
    const options = windowsPrivateWorkerOptions(arch);
    assert.deepEqual(options.args,[]);
    assert.ok(options.executable.endsWith(path.join(arch,'trelio-private-process.exe')));
    assert.doesNotMatch(options.executable,/powershell|cmd\.exe/iu);
  }
  assert.throws(()=>windowsPrivateWorkerOptions('../x64'));
});

test('hosted native artifacts match reviewed source and PE architectures', windows, async () => {
  await validateWindowsPrivateWorker(fileURLToPath(new URL('../host-runtime/scripts/native-private-process',import.meta.url)));
});

test('native fixed current-user Codex AppModel query has no private protocol or caller selector',windows,async()=>{
  const options=windowsPrivateWorkerOptions();
  const result=await run(options.executable,['--codex-package-path'],'',{...process.env,PATH:'',PSModulePath:'nonexistent'});
  assert.equal(result.code,0);assert.equal(result.stderr,'');const value=JSON.parse(result.stdout);
  assert.equal(value.schemaVersion,1);assert.ok(['available','unavailable'].includes(value.state));
  assert.deepEqual(Object.keys(value).sort(),value.state==='available'?['pathBase64','schemaVersion','state']:['schemaVersion','state']);
  if(value.state==='available'){
    const bytes=Buffer.from(value.pathBase64,'base64');assert.equal(bytes.toString('base64'),value.pathBase64);
    assert.match(bytes.toString('utf8'),/^[a-z]:\\/iu);
  }
  const denied=await run(options.executable,['--codex-package-path','caller-path']);assert.notEqual(denied.code,0);assert.equal(denied.stdout,'');
  // Hosted Windows normally has no registered Store Codex: absence is actual
  // API evidence, not a positive installed-CLI or account acceptance claim.
});

test('native Desktop shutdown rejects malformed or non-Codex generations without a private session',windows,async()=>{
  const options=windowsPrivateWorkerOptions();
  for(const generation of ['caller-path','0:1','1:0','1:18446744073709551616',`${process.pid}:1`]){
    const result=await run(options.executable,['--codex-desktop-close',generation]);
    assert.notEqual(result.code,0);assert.equal(result.stderr,'');
    assert.deepEqual(JSON.parse(result.stdout),{schemaVersion:1,state:'unavailable',generation:null});
  }
  const extra=await run(options.executable,['--codex-desktop-close','1:1','extra']);
  assert.notEqual(extra.code,0);assert.equal(extra.stdout,'');
});

// x64 Windows can execute x86 too. The separate hosted ARM64 gate exercises
// the third published binary natively; packaging requires all three hashes.
for (const arch of process.arch === 'x64' ? ['x64','ia32'] : [process.arch]) {
  test(`native ${arch} readiness needs no request, PowerShell, profile or private state`, windows, async () => {
    const options=windowsPrivateWorkerOptions(arch);
    const result=await run(options.executable,[], '', {...process.env,PATH:'',PSModulePath:'nonexistent'});
    assert.equal(result.code,0);
    assert.equal(result.stdout,'{"ready":true}\n');
    assert.equal(result.stderr,'');
  });
}

test('native hook performs real owner-only ACL and legacy-compatible DPAPI with no shell startup', windows, async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'trelio-native-private-'));
  const directory=path.join(root,"unicode Ж ' $() [directory]");
  const file=path.join(directory,'private.json');
  const origin='https://fixture.invalid', value='synthetic-token-Ж-only';
  let ciphertext, starts=0;
  try {
    await mkdir(directory); await writeFile(file,'{}');
    const old=await legacy(origin,'protect',value);
    await withRuntimeHookPrivateSession(8_000, async () => {
      const options=windowsPrivateWorkerOptions();
      const worker=scopedPrivateAclWorker({...options,
        environment:{...process.env,PATH:'',PSModulePath:'nonexistent'},
        spawnProcess:(program,args,settings)=>{
          starts++; assert.equal(program,options.executable); assert.deepEqual(args,[]);
          return spawn(program,args,settings);
        }});
      await hardenWindowsPrivatePath(directory,'directory');
      await hardenWindowsPrivatePath(file,'file');
      assert.equal(await unprotectWindowsBridgeSessionToken(origin,old),value);
      ciphertext=await protectWindowsBridgeSessionToken(origin,value);
      assert.equal(await unprotectWindowsBridgeSessionToken(origin,ciphertext),value);
      await worker.harden(file,'file'); // Fresh verification, not cached success.
      assert.equal(starts,1);
    });
    assert.equal(await legacy(origin,'unprotect',ciphertext),value);
    // Independent .NET read-back checks what the native handle APIs persisted.
    // This runs only in CI on synthetic paths, outside the production helper.
    const script=`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRELIO_TEST_PATH));
$a=[IO.FileInfo]::new($p).GetAccessControl(); $s=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$r=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);
if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s.Value -or !$a.AreAccessRulesProtected -or $r.Count -ne 1 -or $r[0].IdentityReference.Value -ne $s.Value -or $r[0].IsInherited -or $r[0].AccessControlType -ne 'Allow' -or $r[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){exit 2}`;
    const checked=await run(resolveWindowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], '',
      {...process.env,TRELIO_TEST_PATH:Buffer.from(file).toString('base64')});
    assert.equal(checked.code,0,checked.stderr);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('native helper rejects reparse points and wrong path kinds without touching targets', windows, async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'trelio-native-reparse-'));
  try {
    const target=path.join(root,'target'), link=path.join(root,'junction'), file=path.join(root,'file');
    await mkdir(target); await symlink(target,link,'junction'); await writeFile(file,'synthetic');
    for(const [name,kind] of [[link,'directory'],[file,'directory'],[target,'file']]) {
      const worker=createPrivateAclWorker(windowsPrivateWorkerOptions());
      try { await assert.rejects(worker.harden(name,kind)); }
      finally { await worker.close(); }
    }
    assert.equal(await readFile(file,'utf8'),'synthetic');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('native selector and ACL support installed paths beyond Win32 MAX_PATH', windows, async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'trelio-native-long-'));
  try {
    const scripts=path.join(root,...Array(6).fill('long signed runtime Ж '+ 'x'.repeat(30)));
    const binaryDirectory=path.join(scripts,'native-private-process','bin',process.arch);
    await mkdir(binaryDirectory,{recursive:true});
    await copyFile(windowsPrivateWorkerOptions().executable,path.join(binaryDirectory,'trelio-private-process.exe'));
    const modulePath=path.join(scripts,'trelio-hook-private-session.mjs');
    // Preserve the selector's reviewed module dependency too, as the signed
    // package builder does. A partial source copy cannot represent an actual
    // installed runtime and would fail module resolution before CreateProcess.
    for (const name of ['trelio-hook-private-session.mjs','trelio-process-diagnostics.mjs']) {
      await copyFile(fileURLToPath(new URL('../host-runtime/scripts/'+name,import.meta.url)),path.join(scripts,name));
    }
    // Load the exact production selector at an installed-style long location.
    // Node fs success alone does not prove CreateProcess can execute that path.
    const installed=await import(pathToFileURL(modulePath).href);
    const options=installed.windowsPrivateWorkerOptions();
    assert.ok(options.executable.length>300);
    const result=await run(options.executable,[]);
    assert.equal(result.code,0,result.stderr);
    assert.equal(result.stdout,'{"ready":true}\n');
    const file=path.join(scripts,'private.json');
    await writeFile(file,'synthetic');
    await hardenWindowsPrivatePath(file,'file');
    assert.equal(await readFile(file,'utf8'),'synthetic');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('native protocol rejects malformed/oversized requests without echoing private input', windows, async () => {
  const options=windowsPrivateWorkerOptions();
  for (const input of ['synthetic-private-input\n','1\tunprotect\tAAAA\tAAAA\n','X'.repeat(1400001)+'\n']) {
    const result=await run(options.executable,[],input);
    assert.equal(result.code,1);
    assert.equal(result.stderr,'');
    assert.doesNotMatch(result.stdout,/synthetic-private-input|AAAA|XXX/u);
    assert.ok(result.stdout.length<100);
  }
});

test('native DPAPI binds ciphertext to origin entropy and fails without plaintext output', windows, async () => {
  const value='synthetic-private-entropy-test';
  const ciphertext=await protectWindowsBridgeSessionToken('https://one.invalid',value);
  await assert.rejects(unprotectWindowsBridgeSessionToken('https://two.invalid',ciphertext), error=>{
    assert.doesNotMatch(error.message,new RegExp(value));
    assert.equal(error.stdout,undefined); assert.equal(error.stderr,undefined); return true;
  });
});
