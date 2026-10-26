import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createAssistantWindowsBackground, runAssistantWindowsBackgroundNative, projectAssistantBackgroundResult,
  quoteAssistantWindowsArgument, ASSISTANT_WINDOWS_BACKGROUND_SCRIPT, createAssistantWindowsBackgroundReplacement,
  validateAssistantBackgroundReplacementSnapshot,startAssistantWindowsConsoleIcon,runAssistantWindowsDesktop } from '../host-runtime/scripts/trelio-assistant-setup.mjs';
import { callAssistantSetupTool, runAssistantEntry, ASSISTANT_SETUP_TOOLS } from '../host-runtime/scripts/trelio-assistant-entry.mjs';

const identity = { origin: 'https://trelio.ru', assistantId: randomUUID(), deviceId: randomUUID() };
const registered = () => ({ schemaVersion: 1, state: 'registered', installed: true,
  interactiveUserRequired: true, startsAtUserLogon: true, businessReady: false });

test('background registration selects only the paired identity and loaded shell after live contact', async () => {
  let contacts = 0, calls = 0, actual;
  const manage = createAssistantWindowsBackground({ platform: 'win32', executable: 'C:\\Program Files\\nodejs\\node.exe',
    readIdentity: async () => identity, verifyContact: async () => { contacts++; },
    resolveLoader: async () => 'C:\\Users\\Irina\\plugin with spaces\\loader.mjs',
    runNative: async plan => { calls++; actual = plan; return registered(); },
  });
  assert.deepEqual(await manage('install'), registered());
  assert.equal(contacts, 1); assert.equal(calls, 1);
  assert.equal(actual.assistantId, identity.assistantId); assert.equal(actual.deviceId, identity.deviceId);
  assert.equal(actual.arguments, '"C:\\Users\\Irina\\plugin with spaces\\loader.mjs" bridge assistant background');
  assert.equal(actual.workingDirectory, 'C:\\Program Files\\nodejs');
  await manage('status'); await manage('remove');
  assert.equal(contacts, 1, 'read-only status/removal must work during a network outage or device revocation');
  await manage('start'); assert.equal(contacts, 2);
  assert.equal(quoteAssistantWindowsArgument('C:\\folder\\'), '"C:\\folder\\\\"');
});

test('unpaired, wrong origin, revoked, unsupported OS and rebind failures precede OS mutation', async () => {
  let calls = 0, reads = 0;
  const options = { platform: 'win32', executable: 'C:\\node.exe', readIdentity: async () => { reads++; return identity; },
    verifyContact: async () => {}, resolveLoader: async () => 'C:\\loader.mjs', runNative: async () => { calls++; return registered(); } };
  await assert.rejects(createAssistantWindowsBackground({ ...options, platform: 'linux' })('install'), /PLATFORM_UNSUPPORTED/u);
  assert.equal(reads, 0);
  for (const value of [null, { ...identity, origin: 'https://another.test' }, { ...identity, assistantId: 'owner-selected' }]) {
    await assert.rejects(createAssistantWindowsBackground({ ...options, readIdentity: async () => value })('install'), /HOST_NOT_CONFIGURED/u);
  }
  await assert.rejects(createAssistantWindowsBackground({ ...options, verifyContact: async () => { throw Object.assign(new Error(), { code: 'ASSISTANT_ACCESS_DENIED' }); } })('start'), /./u);
  let current = identity;
  await assert.rejects(createAssistantWindowsBackground({ ...options, readIdentity: async () => current,
    verifyContact: async () => { current = { ...identity, deviceId: randomUUID() }; } })('install'), /REBIND_REQUIRED/u);
  await assert.rejects(createAssistantWindowsBackground(options)('start --as-system'), /INVALID_INPUT/u);
  assert.equal(calls, 0);
});

test('only internal plugin handoff can retarget the exact paired scheduled action after live contact',async()=>{
  let contact=0,plan;
  const options={platform:'win32',executable:'C:\\node.exe',readIdentity:async()=>identity,
    verifyContact:async()=>{contact++;},resolveLoader:async()=>'C:\\plugins\\0.1.4\\scripts\\trelio-host-runtime-loader.mjs',
    previousLoaders:['C:\\plugins\\0.1.3\\scripts\\trelio-host-runtime-loader.mjs'],restartRequested:true,
    runNative:async value=>{plan=value;return registered();}};
  await createAssistantWindowsBackground(options)('retarget');assert.equal(contact,1);
  assert.deepEqual(plan.previousArguments,['"C:\\plugins\\0.1.3\\scripts\\trelio-host-runtime-loader.mjs" bridge assistant background']);
  assert.equal(plan.restartRequested,true);assert.equal(plan.operation,'retarget');
  await assert.rejects(createAssistantWindowsBackground({...options,previousLoaders:null})('retarget'),/INVALID_INPUT/);
  await assert.rejects(runAssistantEntry(['background-retarget']),/COMMAND_UNSUPPORTED/);
});

test('the existing OS status keeps its running state and appends dispatch only after native registration and identity checks',async()=>{
  let diagnosticReads=0,current=identity;
  const running={...registered(),state:'running'};
  const dispatch={schemaVersion:1,state:'blocked',reasons:['model_selection_required'],pendingEvents:0};
  const options={platform:'win32',executable:'C:\\node.exe',readIdentity:async()=>current,verifyContact:async()=>{},
    resolveLoader:async()=>'C:\\loader.mjs',runNative:async()=>running,
    readDispatchStatus:async()=>{diagnosticReads++;return dispatch;}};
  const manage=createAssistantWindowsBackground(options);
  const result=await manage('status');assert.equal(result.state,'running');assert.deepEqual(result.dispatch,dispatch);
  assert.equal(diagnosticReads,1);await manage('start');assert.equal(diagnosticReads,1,'start is not a status/poll request');
  await assert.rejects(createAssistantWindowsBackground({...options,readDispatchStatus:async()=>{
    current={...identity,deviceId:randomUUID()};return dispatch;}})('status'),{code:'ASSISTANT_HOST_REBIND_REQUIRED'});
});

test('setup tools and exact CLI commands expose no arbitrary principal, identity or executable', async () => {
  const setup = { background: async operation => ({ operation }) };
  for (const [name, operation] of [['install_assistant_background', 'install'], ['get_assistant_background_status', 'status'], ['start_assistant_background', 'start']]) {
    const tool = ASSISTANT_SETUP_TOOLS.find(value => value.name === name);
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: name==='install_assistant_background'?{autoUpdatePlugin:{type:'boolean'}}:{}, required: [], additionalProperties: false });
    assert.deepEqual(await callAssistantSetupTool(setup, name, {}), { operation });
    for (const args of [null, { user: 'SYSTEM' }, { executable: 'cmd.exe' }, { assistantId: identity.assistantId }]) {
      await assert.rejects(callAssistantSetupTool(setup, name, args), error => error.code === 'ASSISTANT_SETUP_INVALID_INPUT');
    }
    const output = new PassThrough(); let value = ''; output.on('data', chunk => value += chunk);
    await runAssistantEntry([`background-${operation}`], { output, createBackground: async () => setup.background });
    assert.deepEqual(JSON.parse(value), { operation });
  }
  await assert.rejects(runAssistantEntry(['background-install', '--system']), /COMMAND_UNSUPPORTED/u);
});

test('native helper uses constant code, JSON stdin, bounded closed output and no inherited secret environment', async () => {
  let supplied, child;
  const spawnProcess = (executable, args, options) => {
    supplied = { executable, args, options }; child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    let input = ''; child.stdin.on('data', chunk => input += chunk);
    child.stdin.on('finish', () => {
      assert.deepEqual(JSON.parse(input), { operation: 'status' });
      queueMicrotask(() => { child.stdout.write(JSON.stringify(registered())); child.emit('close', 0); });
    });
    return child;
  };
  const result = await runAssistantWindowsBackgroundNative({ operation: 'status' }, { spawnProcess,
    environment: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Irina', PRIVATE_TOKEN: 'DO_NOT_COPY', PSModulePath: 'C:\\UntrustedModules' } });
  assert.deepEqual(result, registered());
  assert.equal(supplied.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(Buffer.from(supplied.args.at(-1), 'base64').toString('utf16le'), ASSISTANT_WINDOWS_BACKGROUND_SCRIPT);
  assert.equal(supplied.options.shell, false);
  assert.equal(supplied.options.env.PRIVATE_TOKEN, undefined);
  assert.equal(supplied.options.env.PSModulePath, undefined, 'the public helper never loads an inherited module catalogue');
  assert.ok(!JSON.stringify(supplied).includes('DO_NOT_COPY'));
  for (const value of [{ ...registered(), stdout: 'PRIVATE' }, { ...registered(), businessReady: true },
    { ...registered(), state: 'not_installed' }, { code: 'RAW_PRIVATE_ERROR', message: 'PRIVATE' }]) {
    assert.throws(() => projectAssistantBackgroundResult(value), error => error.code === 'ASSISTANT_BACKGROUND_READBACK_FAILED' && !JSON.stringify(error).includes('PRIVATE'));
  }
  for (const code of ['ASSISTANT_BACKGROUND_CONFLICT', 'ASSISTANT_BACKGROUND_BUSY', 'ASSISTANT_BACKGROUND_ACCESS_DENIED']) {
    assert.throws(() => projectAssistantBackgroundResult({ code }), error => error.code === code);
  }
});

test('abort, timeout and oversized native output terminate one attempt without retry or raw error', async () => {
  for (const mode of ['abort', 'timeout', 'overflow', 'native-error']) {
    const controller = new AbortController(); let calls = 0, killed = false;
    const spawnProcess = () => {
      calls++; const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { killed = true; };
      queueMicrotask(() => {
        if (mode === 'abort') controller.abort();
        if (mode === 'overflow') child.stdout.write('PRIVATE'.repeat(1000));
        if (mode === 'native-error') child.emit('error', new Error('PRIVATE_OS_ERROR'));
      });
      return child;
    };
    await assert.rejects(runAssistantWindowsBackgroundNative({ operation: 'install' }, { spawnProcess,
      environment: { SystemRoot: 'C:\\Windows' }, timeoutMs: 20, signal: controller.signal }),
    error => /^ASSISTANT_BACKGROUND_/u.test(error.code) && !JSON.stringify(error).includes('PRIVATE'));
    assert.equal(calls, 1); assert.equal(killed, true);
  }
});

test('replacement captures only the exact old registration and removes it without selecting or replaying a command', async () => {
  const snapshot = { schemaVersion: 1, assistantId: identity.assistantId, deviceId: identity.deviceId,
    principalSid: 'S-1-5-21-1-2-3-1001', definitionSha256: 'a'.repeat(64) };
  const seen = [];
  let current = identity;
  const background = createAssistantWindowsBackgroundReplacement({ platform: 'win32', readIdentity: async () => current,
    runNative: async (plan, options) => {
      seen.push(plan);
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 40_000);
      assert.equal(plan.command, ''); assert.equal(plan.arguments, ''); assert.equal(plan.workingDirectory, '');
      return { schemaVersion: 1, state: plan.operation === 'replacement_inspect' ? 'registered' : 'not_installed',
        snapshot: plan.operation === 'replacement_inspect' ? snapshot : null };
    } });
  assert.deepEqual(await background.inspect(identity), { schemaVersion: 1, state: 'registered', snapshot });
  assert.deepEqual(await background.remove(identity, snapshot), { schemaVersion: 1, state: 'not_installed', snapshot: null });
  assert.deepEqual(seen.map(plan => plan.operation), ['replacement_inspect', 'replacement_remove']);
  assert.deepEqual(seen[1].snapshot, snapshot);
  for (const invalid of [{ ...snapshot, deviceId: randomUUID() }, { ...snapshot, command: 'PRIVATE' },
    { ...snapshot, principalSid: 'SYSTEM' }, { ...snapshot, definitionSha256: 'bad' }]) {
    assert.throws(() => validateAssistantBackgroundReplacementSnapshot(invalid, identity), { code: 'ASSISTANT_BACKGROUND_CONFLICT' });
    await assert.rejects(background.remove(identity, invalid), { code: 'ASSISTANT_BACKGROUND_CONFLICT' });
  }
  current = { ...identity, deviceId: randomUUID() };
  await assert.rejects(background.inspect(identity), { code: 'ASSISTANT_HOST_REBIND_REQUIRED' });
  assert.equal(seen.length, 2, 'bad snapshot/changed identity must refuse before the native operation');
});

test('replacement keeps busy, changed, ambiguous and malformed registrations closed without an OS retry', async () => {
  const snapshot = { schemaVersion: 1, assistantId: identity.assistantId, deviceId: identity.deviceId,
    principalSid: 'S-1-5-21-1-2-3-1001', definitionSha256: 'a'.repeat(64) };
  for (const failure of ['ASSISTANT_BACKGROUND_BUSY', 'ASSISTANT_BACKGROUND_CONFLICT', 'ASSISTANT_BACKGROUND_ACCESS_DENIED']) {
    let calls = 0;
    const background = createAssistantWindowsBackgroundReplacement({ platform: 'win32', readIdentity: async () => identity,
      runNative: async () => { calls++; return { code: failure }; } });
    await assert.rejects(background.remove(identity, snapshot), { code: failure });
    assert.equal(calls, 1);
  }
  for (const result of [{ schemaVersion: 1, state: 'not_installed', snapshot },
    { schemaVersion: 1, state: 'running', snapshot: null },
    { schemaVersion: 1, state: 'not_installed', snapshot: null, path: 'PRIVATE' }]) {
    const background = createAssistantWindowsBackgroundReplacement({ platform: 'win32', readIdentity: async () => identity,
      runNative: async () => result });
    await assert.rejects(background.inspect(identity), { code: 'ASSISTANT_BACKGROUND_READBACK_FAILED' });
  }
  let calls = 0;
  const changed = createAssistantWindowsBackgroundReplacement({ platform: 'win32',
    readIdentity: async () => ++calls === 1 ? identity : { ...identity, deviceId: randomUUID() },
    runNative: async () => ({ schemaVersion: 1, state: 'not_installed', snapshot: null }) });
  await assert.rejects(changed.inspect(identity), { code: 'ASSISTANT_HOST_REBIND_REQUIRED' });
});

test('the actual bounded native pipe selects the strict replacement receipt before its factory read-back', async () => {
  const snapshot = { schemaVersion: 1, assistantId: identity.assistantId, deviceId: identity.deviceId,
    principalSid: 'S-1-5-21-1-2-3-1001', definitionSha256: 'a'.repeat(64) };
  const wire = (value, operation = 'replacement_inspect') => runAssistantWindowsBackgroundNative({ operation,
    assistantId: identity.assistantId, deviceId: identity.deviceId }, { environment: { SystemRoot: 'C:\\Windows' },
    spawnProcess: () => {
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
      child.stdin.on('finish', () => queueMicrotask(() => { child.stdout.write(JSON.stringify(value)); child.emit('close', value.code ? 1 : 0); }));
      return child;
    } });
  const captured = { schemaVersion: 1, state: 'registered', snapshot };
  assert.deepEqual(await wire(captured), captured);
  const absent = { schemaVersion: 1, state: 'not_installed', snapshot: null };
  assert.deepEqual(await wire(absent, 'replacement_remove'), absent);
  await assert.rejects(wire({ code: 'ASSISTANT_BACKGROUND_BUSY' }, 'replacement_remove'), { code: 'ASSISTANT_BACKGROUND_BUSY' });
  for (const invalid of [registered(), { ...captured, rawXml: 'PRIVATE' }, { ...absent, state: 'running' }])
    await assert.rejects(wire(invalid), { code: 'ASSISTANT_BACKGROUND_READBACK_FAILED' });
  await assert.rejects(wire(captured, 'replacement_remove'), { code: 'ASSISTANT_BACKGROUND_READBACK_FAILED' });
});

test('console branding uses one fixed native mode with bounded closed output and retains icons only until supervisor close',async()=>{
  for(const scenario of ['applied','shared','console_already_attached','console_attach_failed','malformed','overflow','exit']){
    let child,spawned=0,ended=0,killed=0;
    const icon=await startAssistantWindowsConsoleIcon({platform:'win32',environment:{SystemRoot:'C:\Windows',PRIVATE:'never-inherited'},
      selectWorker:async()=>({executable:'C:\signed\trelio-private-process.exe',args:[]}),
      spawnProcess:(executable,args,options)=>{
        spawned++;assert.equal(executable,'C:\signed\trelio-private-process.exe');assert.deepEqual(args,['--assistant-console-icon']);
        assert.deepEqual(options.env,{SystemRoot:'C:\Windows',PATH:''});assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
        child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{killed++;child.emit('close',1);};
        child.stdin.on('finish',()=>{ended++;child.emit('close',0);});
        queueMicrotask(()=>{
          if(scenario==='exit'){child.emit('close',1);return;}
          const value=scenario==='applied'?{schemaVersion:1,state:'applied',verified:true,foregroundUnchanged:true}
            :['shared','console_already_attached','console_attach_failed'].includes(scenario)?{schemaVersion:1,state:'skipped',reason:scenario==='shared'?'shared_console':scenario}
            :{schemaVersion:1,state:'applied',verified:true,rawWindow:'PRIVATE'};
          child.stdout.write(scenario==='overflow'?'PRIVATE'.repeat(100):JSON.stringify(value)+'\n');
        });return child;
      }});
    assert.equal(spawned,1);assert.equal(icon.state,scenario==='applied'?'applied':['shared','console_already_attached','console_attach_failed'].includes(scenario)?'skipped':'unavailable');
    if(scenario==='applied')assert.equal(ended,0,'HICON lifetime cannot end at successful startup');
    await icon.close();
    if(scenario==='applied')assert.equal(ended,1);
    assert.ok(killed<=1,'cosmetic process is never retried');assert.ok(!JSON.stringify(icon).includes('PRIVATE'));
  }
  const skipped=await startAssistantWindowsConsoleIcon({platform:'linux',selectWorker:async()=>assert.fail('non-Windows never resolves worker')});
  assert.equal(skipped.reason,'unsupported_platform');
});

test('the signed worker brands only an isolated visible parent console and reads actual WM_GETICON without changing focus',
  {skip:process.platform!=='win32'},async()=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-icon-classic-'));
    const fixture=path.join(directory,'fixture.mjs'),receipt=path.join(directory,'receipt.json');
    const ready=path.join(directory,'ready'),release=path.join(directory,'release');
    const setupUrl=new URL('../host-runtime/scripts/trelio-assistant-setup.mjs',import.meta.url).href;
    try{
      for(const mode of ['visible','shared','hidden']){
        await Promise.all([ready,release,receipt].map(file=>fs.rm(file,{force:true})));
        // libuv's detached:true means DETACHED_PROCESS, not CREATE_NEW_CONSOLE.
        // The test-only native launcher explicitly creates a classic console;
        // production branding itself never creates or shows a window.
        await fs.writeFile(fixture,`import fs from 'node:fs/promises';
          import {startAssistantWindowsConsoleIcon} from ${JSON.stringify(setupUrl)};
          import {spawn} from 'node:child_process';
          await fs.writeFile(${JSON.stringify(ready)},'ready');
          let released=false;
          for(let attempt=0;attempt<500;attempt++){
            try{await fs.access(${JSON.stringify(release)});released=true;break;}catch{}
            await new Promise(resolve=>setTimeout(resolve,20));
          }
          if(!released)process.exit(126);
          let sibling=null;
          if(${JSON.stringify(mode)}==='shared'){
            sibling=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:false,stdio:'ignore'});
            await new Promise((resolve,reject)=>{sibling.once('spawn',resolve);sibling.once('error',reject);});
          }
          let presentationChild;
          const icon=await startAssistantWindowsConsoleIcon({spawnProcess:(...args)=>{presentationChild=spawn(...args);return presentationChild;}});
          const result=Object.fromEntries(Object.entries(icon).filter(([key])=>key!=='close'));
          if(icon.state==='applied'){
            // The actual native receipt has crossed the restored stdout pipe.
            // Keep stdin open and prove the keeper does not exit until EOF.
            await new Promise(resolve=>setTimeout(resolve,100));
            result.keeperAliveBeforeClose=presentationChild.exitCode===null;
          }
          await icon.close();
          if(icon.state==='applied')result.closedAtEof=presentationChild.exitCode===0&&!presentationChild.killed;
          await fs.writeFile(${JSON.stringify(receipt)},JSON.stringify(result));
          if(sibling)sibling.kill();`);
        const {resolveWindowsPowerShellExecutable}=await import('../host-runtime/scripts/trelio-workspace.mjs');
        const script="$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n"+PSEUDOCONSOLE_FIXTURE+"\n'@\n$p=[Console]::In.ReadToEnd()|ConvertFrom-Json\nexit [AssistantIconPseudoConsoleFixture]::RunClassic([string]$p.executable,[string]$p.arguments,[bool]$p.hidden,[string]$p.ready,[string]$p.release)";
        const code=await new Promise((resolve,reject)=>{
          const child=spawn(resolveWindowsPowerShellExecutable(process.env),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
            {shell:false,windowsHide:true,stdio:['pipe','ignore','ignore'],timeout:60000});
          child.once('error',reject);child.once('close',resolve);
          child.stdin.end(JSON.stringify({executable:process.execPath,arguments:quoteAssistantWindowsArgument(fixture),hidden:mode==='hidden',ready,release}));
        });
        assert.equal(code,0,`the synthetic native classic-console host must complete (closed precondition stage ${code})`);
        const result=JSON.parse(await fs.readFile(receipt,'utf8'));
        if(mode==='visible')assert.deepEqual(result,{state:'applied',verified:true,foregroundUnchanged:true,keeperAliveBeforeClose:true,closedAtEof:true});
        else if(mode==='shared')assert.deepEqual(result,{state:'skipped',reason:'shared_console'});
        else{assert.equal(result.state,'skipped');assert.ok(['no_console','not_visible_classic_console'].includes(result.reason));}
      }
    }finally{await fs.rm(directory,{recursive:true,force:true});}
});

// Native console fixtures only. They own every process/pipe below; production
// branding never creates a console or terminal and never compiles native code.
const PSEUDOCONSOLE_FIXTURE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
public static class AssistantIconPseudoConsoleFixture {
  [StructLayout(LayoutKind.Sequential)] struct Coord { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reservedSize;
    public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Startup Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public int Id,ThreadId; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security attributes,int size);
  [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size,IntPtr input,IntPtr output,int flags,out IntPtr console);
  [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,int flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,int flags,IntPtr environment,string directory,ref Extended startup,out ProcessInfo process);
  [DllImport("kernel32.dll", EntryPoint="CreateProcessW",ExactSpelling=true,CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateClassicProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,int flags,IntPtr environment,string directory,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(int processId);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool SetStdHandle(int kind,IntPtr handle);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int length);
  [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr handle,int milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out int code);
  [DllImport("kernel32.dll")] static extern bool ReadFile(IntPtr handle,byte[] bytes,int length,out int count,IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,int code);
  static void Check(bool value) { if(!value)throw new Exception("synthetic pseudoconsole API failed"); }
  public static int RunClassic(string executable,string arguments,bool hidden,string ready,string release) {
    ProcessInfo process=new ProcessInfo();bool released=false,attached=false;
    IntPtr input=GetStdHandle(-10),output=GetStdHandle(-11),error=GetStdHandle(-12);
    try {
      // Node waits at a test-only file gate after its console initialization.
      // An independent API read proves the expected classic console before the
      // gate opens; no helper-under-test is used to establish that precondition.
      Startup startup=new Startup {cb=Marshal.SizeOf(typeof(Startup)),flags=1,show=(short)(hidden?0:4)};
      Check(CreateClassicProcess(executable,new StringBuilder("\""+executable+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x00000010,IntPtr.Zero,null,ref startup,out process));
      for(int attempt=0;attempt<500&&!System.IO.File.Exists(ready);attempt++)System.Threading.Thread.Sleep(20);
      if(!System.IO.File.Exists(ready))return 35;
      if(!FreeConsole())return 30;
      attached=AttachConsole(process.Id);if(!attached)return 31;
      IntPtr window=GetConsoleWindow();if(window==IntPtr.Zero)return 32;
      StringBuilder name=new StringBuilder(64);
      if(GetClassName(window,name,64)<=0||name.ToString()!="ConsoleWindowClass")return 33;
      if(IsWindowVisible(window)==hidden)return 34;
      Check(FreeConsole());attached=false;
      SetStdHandle(-10,input);SetStdHandle(-11,output);SetStdHandle(-12,error);
      System.IO.File.WriteAllText(release,"release");released=true;
      if(WaitForSingleObject(process.Process,15000)!=0) { TerminateProcess(process.Process,124);throw new Exception("synthetic classic console timeout"); }
      int result;Check(GetExitCodeProcess(process.Process,out result));return result;
    } finally {
      if(attached)FreeConsole();
      SetStdHandle(-10,input);SetStdHandle(-11,output);SetStdHandle(-12,error);
      if(!released&&process.Process!=IntPtr.Zero)TerminateProcess(process.Process,125);
      if(process.Thread!=IntPtr.Zero)CloseHandle(process.Thread);if(process.Process!=IntPtr.Zero)CloseHandle(process.Process);
    }
  }
  public static int Run(string executable,string arguments) {
    IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,console=IntPtr.Zero,attributes=IntPtr.Zero;
    ProcessInfo process=new ProcessInfo();Task drain=null;bool initialized=false;
    try {
      Security security=new Security {Length=Marshal.SizeOf(typeof(Security)),Inherit=false};
      Check(CreatePipe(out inputRead,out inputWrite,ref security,0));Check(CreatePipe(out outputRead,out outputWrite,ref security,0));
      Check(CreatePseudoConsole(new Coord {X=80,Y=25},inputRead,outputWrite,0,out console)==0);
      // Drain the synthetic terminal independently before ClosePseudoConsole:
      // its output is deliberately discarded, never an MCP/content fixture.
      drain=Task.Run(()=>{byte[] bytes=new byte[4096];int count;while(ReadFile(outputRead,bytes,bytes.Length,out count,IntPtr.Zero)&&count>0){};});
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      attributes=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attributes,1,0,ref size));initialized=true;
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020016),console,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      Extended startup=new Extended {Info=new Startup {cb=Marshal.SizeOf(typeof(Extended))},Attributes=attributes};
      Check(CreateProcess(executable,new StringBuilder("\""+executable+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x00080000,IntPtr.Zero,null,ref startup,out process));
      if(WaitForSingleObject(process.Process,15000)!=0) { TerminateProcess(process.Process,124);throw new Exception("synthetic pseudoconsole timeout"); }
      int result;Check(GetExitCodeProcess(process.Process,out result));return result;
    } finally {
      if(process.Thread!=IntPtr.Zero)CloseHandle(process.Thread);if(process.Process!=IntPtr.Zero)CloseHandle(process.Process);
      if(initialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);
      if(console!=IntPtr.Zero)ClosePseudoConsole(console);
      foreach(IntPtr handle in new[]{inputRead,inputWrite,outputWrite})if(handle!=IntPtr.Zero)CloseHandle(handle);
      if(drain!=null)drain.Wait(2000);if(outputRead!=IntPtr.Zero)CloseHandle(outputRead);
    }
  }
}
`;

test('a real Windows pseudoconsole stays unbranded without opening or selecting its terminal host',
  {skip:process.platform!=='win32'},async()=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-icon-conpty-'));
    const fixture=path.join(directory,'fixture.mjs'),receipt=path.join(directory,'receipt.json');
    const setupUrl=new URL('../host-runtime/scripts/trelio-assistant-setup.mjs',import.meta.url).href;
    try{
      await fs.writeFile(fixture,`import fs from 'node:fs/promises';import {startAssistantWindowsConsoleIcon} from ${JSON.stringify(setupUrl)};
        const icon=await startAssistantWindowsConsoleIcon();await fs.writeFile(${JSON.stringify(receipt)},JSON.stringify({state:icon.state,reason:icon.reason}));await icon.close();`);
      const {resolveWindowsPowerShellExecutable}=await import('../host-runtime/scripts/trelio-workspace.mjs');
      const script="$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n"+PSEUDOCONSOLE_FIXTURE+"\n'@\n$p=[Console]::In.ReadToEnd()|ConvertFrom-Json\nexit [AssistantIconPseudoConsoleFixture]::Run([string]$p.executable,[string]$p.arguments)";
      const code=await new Promise((resolve,reject)=>{
        const child=spawn(resolveWindowsPowerShellExecutable(process.env),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
          {shell:false,windowsHide:true,stdio:['pipe','ignore','ignore'],timeout:60000});
        child.once('error',reject);child.once('close',resolve);
        child.stdin.end(JSON.stringify({executable:process.execPath,arguments:quoteAssistantWindowsArgument(fixture)}));
      });
      assert.equal(code,0,'the synthetic native ConPTY host must complete');
      const result=JSON.parse(await fs.readFile(receipt,'utf8'));assert.equal(result.state,'skipped');
      assert.ok(['no_console','not_visible_classic_console'].includes(result.reason));
    }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('Windows Task Scheduler actually registers, rereads, deduplicates, runs and removes only its own fixture', { skip: process.platform !== 'win32' }, async t => {
  // Hosted Windows only; never an assistant/user VM or live service. A tiny
  // native Node action proves Task Scheduler invocation independently of Codex,
  // backend, credentials and the businessReady gate.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant background Юникод '));
  const loader = path.join(directory, 'old shell', 'scripts', 'trelio-host-runtime-loader.mjs'), marker = path.join(directory, 'receipt.json');
  await fs.mkdir(path.dirname(loader), { recursive: true });
  const fixture = { ...identity, assistantId: randomUUID(), deviceId: randomUUID() };
  await fs.writeFile(loader, `import fs from 'node:fs';\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['bridge','assistant','background']))process.exit(9);\nfs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ready:true}));\n`);
  const controller = createAssistantWindowsBackground({ readIdentity: async () => fixture, verifyContact: async () => {}, resolveLoader: async () => loader,
    runNative: (plan, options) => runAssistantWindowsBackgroundNative(plan, { ...options, spawnProcess: (command, args, settings) => {
      const child = spawn(command, args, { ...settings, stdio: ['pipe', 'pipe', 'pipe'] });
      let diagnostic = '';
      child.stderr.on('data', chunk => {
        diagnostic += chunk.toString('utf8');
        for (;;) {
          const end = diagnostic.indexOf('\n'); if (end < 0) break;
          const line = diagnostic.slice(0, end).trim(); diagnostic = diagnostic.slice(end + 1);
          if (/^TRELIO_TASK_CHECK [a-z_]{1,32}$/u.test(line)
            || /^TRELIO_TASK_STAGE (?:script|encoding|module|input|identity|scheduler|folder|lookup|result)$/u.test(line)) console.log(line);
        }
        if (diagnostic.length > 4096) diagnostic = '';
      });
      return child;
    } }),
  });
  const manage = async operation => {
    console.log(`Native fixture step: ${operation}`);
    try { const result = await controller(operation); console.log(`Native fixture result: ${operation} ${result.state}`); return result; }
    catch (error) { throw new Error(`Native fixture ${operation}: ${error.code}`, { cause: error }); }
  };
  t.after(async () => {
    // The fixture exits immediately; a busy task is polled, never killed or
    // unregistered underneath a native action. Random UUIDs isolate runs.
    let removed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await manage('remove'); removed = true; break; }
      catch (error) { if (error.cause?.code !== 'ASSISTANT_BACKGROUND_BUSY') throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.equal(removed, true, 'a busy native fixture is preserved and reported instead of deleting its action');
    await fs.rm(directory, { recursive: true, force: true });
  });
  assert.equal((await manage('status')).state, 'not_installed');
  assert.equal((await manage('install')).state, 'registered');
  assert.equal((await manage('install')).state, 'registered', 'idempotent install reads the exact definition instead of overwriting it');
  const replacementController = createAssistantWindowsBackgroundReplacement({ readIdentity: async () => fixture });
  const captured = await replacementController.inspect(fixture);
  assert.equal(captured.state, 'registered');
  assert.equal(captured.snapshot.assistantId, fixture.assistantId);
  assert.match(captured.snapshot.definitionSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.keys(captured.snapshot).length, 5, 'paths and XML must not escape the native helper');
  await assert.rejects(replacementController.remove(fixture, { ...captured.snapshot, definitionSha256: '0'.repeat(64) }),
    { code: 'ASSISTANT_BACKGROUND_CONFLICT' });
  assert.equal((await manage('status')).state, 'registered', 'a different full definition digest never deletes the registration');
  const replacement = { ...fixture, deviceId: randomUUID() };
  const otherDevice = createAssistantWindowsBackground({ readIdentity: async () => replacement,
    verifyContact: async () => {}, resolveLoader: async () => loader });
  await assert.rejects(otherDevice('install'), error => error.code === 'ASSISTANT_BACKGROUND_CONFLICT');
  await manage('start');
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { ready = JSON.parse(await fs.readFile(marker, 'utf8')).ready === true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'the actual native task must execute, not merely register or return queue acceptance');
  assert.equal((await manage('status')).businessReady, false, 'a positive OS receipt cannot claim business delivery');
  // The action has genuinely finished. Removal must reread the exact original
  // native definition and preserve the registration if it is still running.
  let removed = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { assert.equal((await replacementController.remove(fixture, captured.snapshot)).state, 'not_installed'); removed = true; break; }
    catch (error) { if (error.code !== 'ASSISTANT_BACKGROUND_BUSY') throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.equal(removed, true);
  assert.equal((await replacementController.inspect(fixture)).snapshot, null);
});


test('native plugin handoff retargets only the exact scheduled action and preserves its running old process', {skip:process.platform!=='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-native-handoff-'));
  const oldLoader=path.join(directory,'old','scripts','trelio-host-runtime-loader.mjs');
  const nextLoader=path.join(directory,'new','scripts','trelio-host-runtime-loader.mjs');
  const heartbeat=path.join(directory,'old-heartbeat.json'),release=path.join(directory,'release'),receipt=path.join(directory,'new.json');
  const fixture={...identity,assistantId:randomUUID(),deviceId:randomUUID()};
  await fs.mkdir(path.dirname(oldLoader),{recursive:true});await fs.mkdir(path.dirname(nextLoader),{recursive:true});
  await fs.writeFile(oldLoader,`import fs from 'node:fs';const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);return;}fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now()));},100);`);
  await fs.writeFile(nextLoader,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({ready:true}));`);
  const options={readIdentity:async()=>fixture,verifyContact:async()=>{}};
  const old=createAssistantWindowsBackground({...options,resolveLoader:async()=>oldLoader});
  const next=createAssistantWindowsBackground({...options,resolveLoader:async()=>nextLoader,previousLoaders:[oldLoader],restartRequested:true});
  const steady=createAssistantWindowsBackground({...options,resolveLoader:async()=>nextLoader,previousLoaders:[oldLoader],restartRequested:false});
  const triggerCount=()=>runAssistantWindowsBackgroundNative({assistantId:fixture.assistantId},{script:String.raw`
$PSModuleAutoLoadingPreference='None'
Microsoft.PowerShell.Core\Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
$p=ConvertFrom-Json ([Console]::In.ReadToEnd())
$s=[Activator]::CreateInstance([type]::GetTypeFromProgID('Schedule.Service'));$s.Connect()
$count=$s.GetFolder('\').GetTask('Trelio-DigitalAssistant-'+$p.assistantId).Definition.Triggers.Count
[Console]::Out.Write((ConvertTo-Json -Compress @{count=$count}))
`,project:value=>{assert.ok([1,2].includes(value.count));return value.count;}});
  t.after(async()=>{
    await fs.writeFile(release,'');
    for(let attempt=0;attempt<20;attempt++){
      for(const manage of [next,old]){
        try{await manage('remove');await fs.rm(directory,{recursive:true,force:true});return;}
        catch(error){if(!['ASSISTANT_BACKGROUND_BUSY','ASSISTANT_BACKGROUND_CONFLICT'].includes(error.code))throw error;}
      }
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.fail('native handoff fixture did not become idle; no process was killed');
  });
  await old('install');await old('start');
  const read=async file=>{try{return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const until=async predicate=>{for(let i=0;i<80;i++){if(await predicate())return true;await new Promise(resolve=>setTimeout(resolve,250));}return false;};
  assert.equal(await until(async()=>await read(heartbeat)!==null),true);
  const wrong=createAssistantWindowsBackground({...options,resolveLoader:async()=>nextLoader,previousLoaders:[nextLoader],restartRequested:true});
  await assert.rejects(wrong('retarget'),{code:'ASSISTANT_BACKGROUND_CONFLICT'});
  assert.equal((await next('retarget')).installed,true);
  assert.equal(await triggerCount(),2,'a bounded native time trigger arms the registered handoff');
  assert.equal((await next('status')).state,'running');
  const before=await read(heartbeat);
  assert.equal(await until(async()=>await read(heartbeat)!==before),true,'updating the definition must not terminate its live old process');
  await next('retarget'); // A positive read-back does not rearm an unexpired trigger.
  await assert.rejects(old('status'),{code:'ASSISTANT_BACKGROUND_CONFLICT'});
  await fs.writeFile(release,'');
  assert.equal(await until(async()=>(await next('status')).state==='registered'),true);
  await next('start');
  assert.equal(await until(async()=>await read(receipt)!==null),true,'the next native invocation uses the new loader');
  assert.deepEqual(JSON.parse(await read(receipt)),{ready:true});
  await steady('retarget');assert.equal(await triggerCount(),1,'the confirmed parent restores the original steady-state logon definition');
});

test('native Desktop inspection selects the GUI App from the real two-application manifest shape', {skip:process.platform!=='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-desktop-manifest-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.mkdir(path.join(directory,'app'));
  await fs.writeFile(path.join(directory,'app','ChatGPT.exe'),'synthetic non-executable fixture');
  await fs.writeFile(path.join(directory,'AppxManifest.xml'),`<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"><Identity Name="OpenAI.Codex"/><Applications><Application Id="App" Executable="app/ChatGPT.exe"/><Application Id="CodexCoreCommandRunner" Executable="app/resources/codex-command-runner.exe"/></Applications></Package>`);
  const observed=await runAssistantWindowsDesktop('inspect',null,{readPackagePath:async()=>directory});
  assert.deepEqual(observed,{schemaVersion:1,state:'stopped',generation:null});
  // Inspection never runs the fake executable or opens/activates a window.
  await fs.writeFile(path.join(directory,'AppxManifest.xml'),'<Package><Identity Name="Other.App"/></Package>');
  await assert.rejects(runAssistantWindowsDesktop('inspect',null,{readPackagePath:async()=>directory}));
});


test('plugin maintenance is a one-time explicit setup policy, recorded only after exact native registration',async()=>{
  let writes=0,installed=0;const flags=[];
  const manage=createAssistantWindowsBackground({platform:'win32',executable:'C:\\node.exe',readIdentity:async()=>identity,
    verifyContact:async()=>{},resolveLoader:async()=>'C:\\plugin\\loader.mjs',runNative:async()=>{installed++;return registered();},
    setPluginUpdates:async(enabled,current)=>{assert.deepEqual(current,identity);flags.push(enabled);writes++;}});
  await manage('install');assert.equal(writes,0,'legacy installation cannot silently authorize Desktop restart');
  await manage('install',{autoUpdatePlugin:true});await manage('install',{autoUpdatePlugin:false});
  assert.deepEqual(flags,[true,false]);assert.equal(installed,3);
  await assert.rejects(manage('start',{autoUpdatePlugin:true}),/INVALID_INPUT/);assert.equal(writes,2);
  const output=new PassThrough();let supplied;
  await runAssistantEntry(['background-install','--auto-update-plugin=on'],{output,createBackground:async()=>async(op,options)=>{supplied={op,options};return registered();}});
  assert.deepEqual(supplied,{op:'install',options:{autoUpdatePlugin:true}});
});
