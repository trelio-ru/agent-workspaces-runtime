import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, copyFile, readdir as fsReaddir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import crypto from 'node:crypto';
import { createPrivateAclWorker, windowsPrivateWorkerOptions, scopedPrivateAclWorker,
  withRuntimeHookPrivateSession, withPrivateProcessSession } from '../host-runtime/scripts/trelio-hook-private-session.mjs';
import { hardenWindowsPrivatePath, protectWindowsBridgeSessionToken, unprotectWindowsBridgeSessionToken,
  buildWindowsBridgeDpapiInvocation, resolveWindowsPowerShellExecutable } from '../host-runtime/scripts/trelio-workspace.mjs';
import { validateWindowsPrivateWorker } from '../scripts/validate-windows-private-worker.mjs';
import { createAssistantPrivateStore, resolveAssistantCompanyEncryptionDevice } from '../host-runtime/scripts/trelio-assistant-private.mjs';
import { createEncryptedSearchFileCache } from '../host-runtime/scripts/trelio-local-context.mjs';

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

test('native Desktop root discovery has no selector or private protocol and reports only closed metadata',windows,async()=>{
  const result=await run(windowsPrivateWorkerOptions().executable,['--codex-desktop-inspect']);
  assert.equal(result.stderr,'');const value=JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(),['generation','schemaVersion','state']);assert.equal(value.schemaVersion,1);
  assert.ok(['running','stopped','unavailable'].includes(value.state));
  if(value.state==='running'){assert.equal(result.code,0);assert.match(value.generation,/^[1-9]\d{0,9}:[1-9]\d{0,19}$/u);}
  else assert.equal(value.generation,null);
});

test('native Desktop shutdown rejects malformed or non-Codex generations without a private session',windows,async()=>{
  const options=windowsPrivateWorkerOptions();
  for(const generation of ['caller-path','0:1','1:0','1:18446744073709551616',`${process.pid}:1`]){
    const result=await run(options.executable,['--codex-desktop-close',generation]);
    assert.notEqual(result.code,0);assert.equal(result.stderr,'');
    assert.deepEqual(JSON.parse(result.stdout),{schemaVersion:1,state:'unavailable',generation:null});
  }
  const inspect=await run(options.executable,['--codex-desktop-inspect','caller-selector']);
  assert.notEqual(inspect.code,0);assert.equal(inspect.stdout,'');
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

// Offline fixture mutations use .NET solely as an independent descriptor
// writer. Production still uses only the signed native handle-based worker.
// Paths are synthetic; the helper output/descriptor/SID are never printed.
const changeSyntheticAcl = async (target, variant) => {
  assert.ok(['foreign', 'partial', 'unprotected', 'flags', 'deny'].includes(variant));
  const script=`$ErrorActionPreference='Stop';$PSModuleAutoLoadingPreference='None';
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TRELIO_TEST_PATH));
$directory=([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::Directory) -ne 0;
$item=if($directory){[IO.DirectoryInfo]::new($p)}else{[IO.FileInfo]::new($p)};$acl=$item.GetAccessControl();
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$world=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');
$acl.SetAccessRuleProtection($true,$false);
foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){[void]$acl.RemoveAccessRuleSpecific($rule)}
$rights=if($env:TRELIO_TEST_VARIANT -eq 'partial'){'ReadAndExecute'}else{'FullControl'};
$inherit=if($directory -and $env:TRELIO_TEST_VARIANT -ne 'flags'){'ContainerInherit, ObjectInherit'}else{'None'};
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,$inherit,'None','Allow'));
if($env:TRELIO_TEST_VARIANT -eq 'foreign'){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($world,'ReadAndExecute','None','None','Allow'))}
if($env:TRELIO_TEST_VARIANT -eq 'deny'){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($world,'Read','None','None','Deny'))}
if($env:TRELIO_TEST_VARIANT -eq 'unprotected'){$acl.SetAccessRuleProtection($false,$false)}
$item.SetAccessControl($acl)`;
  const result=await run(resolveWindowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],'',
    {...process.env,TRELIO_TEST_PATH:Buffer.from(target).toString('base64'),TRELIO_TEST_VARIANT:variant});
  assert.equal(result.code,0,'synthetic ACL mutation completed');
  assert.equal(result.stdout,'');
};

// x64 also exercises the shipped ia32 worker. ARM64 runs this exact fixture in
// its existing native gate; no VM compilation or source/binary mismatch.
for (const arch of process.arch === 'x64' ? ['x64','ia32'] : [process.arch]) {
  test(`native ${arch} freshly verifies an exact ACL without rewriting, then repairs later changes`,windows,async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'trelio-native-fresh-acl-'));
    const directory=path.join(root,'synthetic-directory'),file=path.join(directory,'synthetic-file');
    const phases=[];
    const options=windowsPrivateWorkerOptions(arch);
    const worker=createPrivateAclWorker({...options,spawnProcess:(program,args,settings)=>{
      const child=spawn(program,args,settings);let pending='';
      child.stdout.on('data',part=>{
        pending+=part;
        for(;;){const end=pending.indexOf('\n');if(end<0)break;
          const line=pending.slice(0,end);pending=pending.slice(end+1);
          // Select only the existing fixed phase vocabulary, not paths/values.
          const frame=JSON.parse(line);if(typeof frame.phase==='string')phases.push(frame.phase);
        }
      });return child;
    }});
    const check=async(target,kind,writes)=>{
      const start=phases.length;await worker.harden(target,kind);
      const actual=phases.slice(start);
      assert.ok(actual.includes('owner_read')&&actual.includes('dacl_verify'));
      assert.equal(actual.filter(phase=>phase==='dacl_write').length,writes,
        'only a freshly observed non-exact descriptor is rewritten');
    };
    try{
      await mkdir(directory);await writeFile(file,'SYNTHETIC_ONLY');
      for(const [target,kind] of [[directory,'directory'],[file,'file']]){
        // Force a known non-exact initial state regardless of runner defaults.
        await changeSyntheticAcl(target,'foreign');await check(target,kind,1);
        await check(target,kind,0);await check(target,kind,0);
        // Reuse the SAME process: a cached path success would miss each change.
        for(const variant of ['foreign','partial','unprotected',...(kind==='directory'?['flags']:[]),'deny']){
          await changeSyntheticAcl(target,variant);await check(target,kind,1);
          await check(target,kind,0);
        }
      }
      // Parent verification neither walks nor certifies descendants. A later
      // explicit child check must still repair that child's changed descriptor.
      await changeSyntheticAcl(file,'foreign');await check(directory,'directory',0);
      await check(file,'file',1);await check(file,'file',0);
      // This deterministic phase assertion guards scaling independently of a
      // runner's throughput: even a directory with 8,192 children must perform
      // fresh reads without another propagating SetSecurityInfo call. Children
      // here are disposable synthetic bytes, not a production private writer.
      for(let offset=0;offset<8192;offset+=32)await Promise.all(Array.from({length:32},(_,n)=>
        writeFile(path.join(directory,`synthetic-child-${offset+n}`),'SYNTHETIC_ONLY')));
      for(let repeat=0;repeat<8;repeat++)await check(directory,'directory',0);
    }finally{await worker.close();await rm(root,{recursive:true,force:true});}
  });
}

test('native Windows encrypted search cache writes and reopens 8192 growing entries within the first-sync budget',
  {...windows,timeout:630000},async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'trelio-native-growing-cache-'));
    let stage='keys',written=0,read=0;const beginning=performance.now();
    const progress=()=>console.log(JSON.stringify({fixture:'native-growing-encrypted-cache',stage,written,read,
      elapsedMs:Math.round(performance.now()-beginning),providerCalls:0}));
    try{await withPrivateProcessSession(async()=>{
      const keys=await crypto.webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
      const companyEncryption={runtime:{company:{id:crypto.randomUUID()},device:{id:crypto.randomUUID()},scope:{id:crypto.randomUUID(),epoch:1,
        publicEncryptionJwk:await crypto.webcrypto.subtle.exportKey('jwk',keys.publicKey)}},
        scopePrivateEncryptionKey:{privateKey:keys.privateKey,privateJwk:await crypto.webcrypto.subtle.exportKey('jwk',keys.privateKey)}};
      const options={paths:{root},origin:'https://synthetic.invalid',companyEncryption};
      const workspace={workspaceId:crypto.randomUUID(),acceptedHead:'a'.repeat(40)};
      const files=Array.from({length:8192},(_,n)=>({id:crypto.randomUUID(),path:`synthetic-${n}.md`,sizeBytes:1024,contentType:'text/plain'}));
      stage='open';const text='SYNTHETIC_ONLY_'.repeat(64),cache=await createEncryptedSearchFileCache(options);
      stage='write';let started=performance.now();
      for(const file of files){await cache.write(workspace,file,text);written++;if(written%1024===0)progress();}
      const writeMs=Math.round(performance.now()-started);
      // Reopen the actual encrypted cache, not an in-memory result; every read
      // repeats file ACL, exact head/AAD and authenticated crypto verification.
      stage='reopen';started=performance.now();const reopened=await createEncryptedSearchFileCache(options);
      stage='read';for(const file of files){
        assert.equal(await reopened.read(workspace,file)===text,true,'synthetic encrypted cache round-trip');
        read++;if(read%1024===0)progress();
      }
      stage='complete';
      console.log(JSON.stringify({fixture:'native-growing-encrypted-cache',entries:files.length,writeMs,readMs:Math.round(performance.now()-started),providerCalls:0}));
    // Use the existing production cold first-sync bound for this larger
    // end-to-end workload, not the earlier 4,096-record profiling probe's 120s
    // cap. Per-request native 10s and all ACL/crypto checks remain unchanged.
    // Closed progress makes a remaining slow stage observable before expiry.
    },AbortSignal.timeout(600000));}
    catch(error){progress();throw error;}
    finally{await rm(root,{recursive:true,force:true});}
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
