import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { executeAssistantRuntimeRequest, assistantHealthCompatibility, assistantHealthFailure, assistantHealthyBoundary, maintainAssistantHost, requestCurrentAssistantRuntime, reportAssistantMaintenanceFailure, reportAssistantDispatchRecovery } from '../host-runtime/scripts/trelio-assistant-entry.mjs';
import { runAssistantEntry } from '../host-runtime/scripts/trelio-assistant-entry.mjs';
import { maintainAssistantCodexDesktop, validateAssistantCodexUpdate, compareCodexDesktopVersions,
  downloadCodexDesktop, CODEX_UPDATE_INTERVAL, ASSISTANT_CODEX_UPDATE_SCRIPT, runAssistantWindowsCodexUpdate } from '../host-runtime/scripts/trelio-assistant-setup.mjs';
import { runProductionAssistantCodexMaintenance, runProductionAssistantPluginMaintenance, runAssistantBackgroundTick } from '../host-runtime/scripts/trelio-assistant-entry.mjs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const versions={pluginVersion:'3.2.3',hostRuntimeVersion:'5.0.0'};

const desktopUpdateFixture=()=>{
  let state=null,version='26.100.0.0',generation='100:1',clock=CODEX_UPDATE_INTERVAL*2;
  const effects=[],snapshots=[],identity={assistantId:randomUUID(),deviceId:randomUUID(),origin:'https://trelio.ru'};
  const options={identity,now:()=>clock,guard:async()=>{},
    readState:async()=>structuredClone(state),writeState:async(expected,next)=>{
      assert.deepEqual(expected,state);validateAssistantCodexUpdate(next);snapshots.push(structuredClone(next));state=structuredClone(next);
    },inspect:async()=>({version,architecture:'x64'}),download:async()=>({etag:'"package-v2"',sha256:'a'.repeat(64)}),
    prepare:async()=>({version:'26.101.0.0',architecture:'x64'}),install:async()=>{
      assert.equal(state.phase,'installing');effects.push('install');version='26.101.0.0';
    },desktop:async(operation,previous)=>{
      if(operation==='close'){assert.equal(state.phase,'closing');assert.equal(previous,generation);effects.push('close');generation=null;}
      if(operation==='start'){assert.equal(state.phase,'verifying');effects.push('start');generation='101:2';}
      return {state:generation?'running':'stopped',generation};
    },probe:async()=>{effects.push('probe');},
  };
  return {options,effects,snapshots,get state(){return state;},advance:()=>{clock+=CODEX_UPDATE_INTERVAL;},setVersion:v=>{version=v;},setGeneration:v=>{generation=v;}};
};

test('Desktop updates journal every effect, verify a new native generation and never touch task work',async()=>{
  const f=desktopUpdateFixture();assert.deepEqual(await maintainAssistantCodexDesktop(f.options),{state:'updated',version:'26.101.0.0'});
  assert.deepEqual(f.effects,['close','install','start','probe']);assert.equal(f.state.phase,'ready');
  assert.deepEqual(f.snapshots.map(value=>value.phase),['ready','prepared','closing','installing','starting','verifying','ready']);
  f.effects.length=0;assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'current');assert.deepEqual(f.effects,[]);
  assert.equal(compareCodexDesktopVersions('26.100.0.0','26.99.0.0'),1);
  assert.equal(compareCodexDesktopVersions('26.100.0.0','26.100.0.0'),0);
  for(const value of ['latest','26.100','26.100.0.0-beta','PRIVATE'])assert.throws(()=>compareCodexDesktopVersions(value,'26.100.0.0'));
});

test('lost install reply reconciles only native version and reopens the SAME Desktop, never installs again',async()=>{
  for(const committed of [false,true]){
    const f=desktopUpdateFixture();let installs=0;
    f.options.install=async()=>{installs++;if(committed)f.setVersion('26.101.0.0');throw new Error('PRIVATE native output');};
    await assert.rejects(maintainAssistantCodexDesktop(f.options));assert.equal(f.state.phase,'installing');
    assert.equal((await maintainAssistantCodexDesktop(f.options)).state,committed?'updated':'failed');
    assert.equal(installs,1);f.advance();
    f.options.download=async()=>({unchanged:true,etag:'"package-v2"'});
    assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'current');assert.equal(installs,1);
    if(!committed)assert.equal(f.state.failedVersion,'26.101.0.0');
  }
});

test('an interrupted or refused normal close never closes another generation or loops activation',async()=>{
  const f=desktopUpdateFixture();let closes=0,starts=0;
  f.options.desktop=async operation=>{
    if(operation==='close'){closes++;throw new Error('refused');}
    if(operation==='start')starts++;
    return {state:'running',generation:closes?'200:2':'100:1'};
  };
  await assert.rejects(maintainAssistantCodexDesktop(f.options));
  assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'activating');
  assert.equal(closes,1);assert.equal(starts,0);assert.ok(!f.effects.includes('install'));
  f.advance();await assert.rejects(maintainAssistantCodexDesktop(f.options),{code:'ASSISTANT_CODEX_UPDATE_FAILED'});
  assert.equal(closes,1);
});

test('lost asynchronous activation is observed without a second start or installation',async()=>{
  const f=desktopUpdateFixture();let starts=0,visible=false;
  const original=f.options.desktop;
  f.options.desktop=async(operation,generation)=>{
    if(operation==='start'){starts++;return {state:'starting',generation:null};}
    if(starts)return {state:visible?'running':'stopped',generation:visible?'101:2':null};
    return original(operation,generation);
  };
  assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'activating');
  assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'activating');assert.equal(starts,1);
  visible=true;assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'updated');
  assert.equal(starts,1);assert.equal(f.effects.filter(value=>value==='install').length,1);
});

test('a deferred Windows registration can recover a failed receipt only from exact version and a fresh native probe',async()=>{
  const f=desktopUpdateFixture();let installs=0;
  f.options.install=async()=>{installs++;throw Error('unknown');};
  await assert.rejects(maintainAssistantCodexDesktop(f.options));
  assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'failed');
  f.setVersion('26.101.0.0');f.setGeneration('102:3');
  assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'updated');
  assert.equal(installs,1);assert.equal(f.state.failedVersion,null);
});

test('feed/signature failures, same versions and downgrades preserve the working Desktop',async()=>{
  for(const mode of ['network','signature','same','older']){
    const f=desktopUpdateFixture();
    if(mode==='network')f.options.download=async()=>{throw Error('PRIVATE');};
    else f.options.prepare=async()=>{if(mode==='signature')throw Error('PRIVATE');return {version:mode==='same'?'26.100.0.0':'26.99.0.0',architecture:'x64'};};
    assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'current');assert.deepEqual(f.effects,[]);
  }
});

test('hook review and post-install readiness cannot be inferred or clear native latches',async()=>{
  const f=desktopUpdateFixture();f.options.probe=async()=>{throw Object.assign(Error(),{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});};
  assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'hook_review');assert.equal(f.state.phase,'verifying');
  assert.equal(f.effects.filter(value=>value==='install').length,1);
  f.options.probe=async()=>{};assert.equal((await maintainAssistantCodexDesktop(f.options)).state,'updated');
  assert.equal(f.effects.filter(value=>value==='close').length,1);
});

test('the final idle fence prevents every update effect when work or setup raced preparation',async()=>{
  const f=desktopUpdateFixture();let changed=false;
  f.options.guard=async()=>{if(changed)throw Object.assign(Error(),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});};
  f.options.prepare=async()=>{changed=true;return {version:'26.101.0.0',architecture:'x64'};};
  await assert.rejects(maintainAssistantCodexDesktop(f.options),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});
  assert.deepEqual(f.effects,[]);assert.equal(f.state.phase,'ready');
});

test('Desktop production composition requires its own consent and SAME coordinator/setup idle boundary',async()=>{
  const identity={assistantId:randomUUID(),deviceId:randomUUID(),origin:'https://trelio.ru'};
  let enabled=false,reads=0,idle=0,setup=0,inside=false;
  const local={readCodexUpdatesEnabled:async()=>enabled,readCodexUpdate:async()=>null,
    readActivation:async()=>null,readActivePass:async()=>null,codexUpdatePackagePath:async()=>'C:\\private\\desktop.msix',
    withSetupLock:async action=>{setup++;inside=true;try{return await action();}finally{inside=false;}},writeCodexUpdate:async()=>{}};
  const runtime={identity,coordinator:{maintainPluginAtIdleBoundary:async action=>{idle++;return action(async()=>{});}}};
  const options={platform:'win32',context:async action=>action({identity,readHealth:async()=>({code:'ready'})},local),
    nativeUpdate:async()=>{assert.equal(inside,true);reads++;throw Error('native unavailable');}};
  assert.equal((await runProductionAssistantCodexMaintenance(runtime,options)).state,'disabled');assert.equal(reads,0);assert.equal(idle,0);
  enabled=true;await assert.rejects(runProductionAssistantCodexMaintenance(runtime,options),{code:'ASSISTANT_CODEX_UPDATE_FAILED'});
  assert.equal(idle,1);assert.equal(setup,1);assert.equal(reads,1);
  local.readActivePass=async()=>({kind:'task'});reads=0;
  await assert.rejects(runProductionAssistantCodexMaintenance(runtime,options));assert.equal(reads,0,'native operation must recheck current pass');
});

test('live device revocation during download blocks preparation and every GUI/install effect',async()=>{
  const identity={assistantId:randomUUID(),deviceId:randomUUID(),origin:'https://trelio.ru'};
  let authorized=true,healthReads=0;const native=[];
  const client={identity,readHealth:async()=>{healthReads++;if(!authorized)throw Object.assign(Error(),{code:'DIGITAL_ASSISTANT_DEVICE_REVOKED'});return {};}};
  const host={readCodexUpdatesEnabled:async()=>true,readCodexUpdate:async()=>null,writeCodexUpdate:async()=>{},
    readActivation:async()=>null,readActivePass:async()=>null,codexUpdatePackagePath:async()=>'C:\\private\\desktop.msix',withSetupLock:async action=>action()};
  const runtime={identity,coordinator:{maintainPluginAtIdleBoundary:async action=>action(async()=>{})}};
  await assert.rejects(runProductionAssistantCodexMaintenance(runtime,{platform:'win32',context:async action=>action(client,host),
    nativeUpdate:async(operation,options)=>{await options.guard();native.push(operation);return {version:'26.100.0.0',architecture:'x64'};},
    download:async()=>{authorized=false;return {etag:'"new"',sha256:'a'.repeat(64)};},
    desktop:async()=>assert.fail('revoked device cannot close or start Desktop'),probe:async()=>assert.fail('revocation is not readiness'),
  }),{code:'ASSISTANT_CODEX_UPDATE_FAILED'});
  assert.deepEqual(native,['inspect']);assert.ok(healthReads>=3,'native liveness is rechecked after the asynchronous preparation');
});

test('an unfinished Desktop journal excludes plugin servicing before the same tick resumes Desktop recovery',async()=>{
  const result=await runProductionAssistantPluginMaintenance({coordinator:{maintainPluginAtIdleBoundary:()=>assert.fail('plugin side effects raced Desktop recovery')}},
    {platform:'win32',context:async action=>action({}, {readPluginUpdatesEnabled:async()=>true,readCodexUpdate:async()=>({phase:'installing'})})});
  assert.equal(result.state,'codex_pending');
  const effects=[];
  const tick=await runAssistantBackgroundTick({pluginMaintenance:async()=>result,
    codexMaintenance:async()=>{effects.push('recover');return {state:'activating',blockBusiness:true};},
    createHost:async()=>({coordinator:{pollOnce:()=>assert.fail('pending update cannot dispatch tasks')},close:async()=>{effects.push('release');}})});
  assert.equal(tick.state,'blocked');assert.deepEqual(effects,['recover','release']);
});

test('a long Desktop update yields before task claim so the next worker keeps its full native deadline',async()=>{
  let clock=0,closed=false;
  const result=await runAssistantBackgroundTick({now:()=>clock,
    pluginMaintenance:async()=>({state:'disabled'}),codexMaintenance:async()=>{clock=151_000;return {state:'updated',version:'26.101.0.0'};},
    createHost:async()=>({coordinator:{pollOnce:()=>assert.fail('long servicing cannot spend a new task deadline'),
      workOnce:()=>assert.fail('no new pass may start in the old worker budget')},close:async()=>{closed=true;}})});
  assert.deepEqual(result,{schemaVersion:1,state:'idle'});assert.equal(closed,true);
});

test('Desktop servicing never bypasses the independent quota pause or stops model-free polling',async()=>{
  const effects=[];
  const result=await runAssistantBackgroundTick({
    pluginMaintenance:async()=>({state:'disabled'}),codexMaintenance:async()=>{effects.push('update');return {state:'updated'};},
    createHost:async()=>({codexUsage:async()=>{effects.push('quota');return {blocked:true};},
      coordinator:{pollOnce:async()=>{effects.push('poll');},workOnce:()=>assert.fail('Desktop update cannot clear quota admission')},close:async()=>{effects.push('close');}})});
  assert.equal(result.reason,'codex_usage_limited');assert.deepEqual(effects,['update','quota','poll','close']);
});

test('a failed Desktop journal survives metadata health checks until its actual version/GUI/probe recovers',async()=>{
  const f=fixture();f.state={...snapshot(),code:'runtime_update_failed'};
  const output=await executeAssistantRuntimeRequest({operation:'health_check'},
    {context:async action=>action(f.client,{readPluginUpdate:async()=>null,readCodexUpdate:async()=>({phase:'failed',failedVersion:'26.101.0.0'})}),
      versions:()=>versions,proxyFor:async()=>({listTools:async()=>[]})});
  assert.equal(output.code,'runtime_update_failed');assert.ok(!f.reports.some(value=>value.code==='ready'));
});

test('Desktop download freezes official code bytes and rejects redirects, truncation and quota excess',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-update-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const packagePath=path.join(root,'desktop.msix'),bytes=Buffer.alloc(1024,42),requests=[];
  const fetcher=async(url,options)=>{
    requests.push(options.method);assert.equal(url,'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix');
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    return new Response(options.method==='HEAD'?null:bytes,{headers:{etag:'"same"','content-length':String(bytes.length)}});
  };
  const result=await downloadCodexDesktop({architecture:'x64',packagePath,fetcher});assert.match(result.sha256,/^[a-f0-9]{64}$/u);
  assert.deepEqual(await fs.readFile(packagePath),bytes);
  assert.deepEqual(await downloadCodexDesktop({architecture:'x64',packagePath,fetcher,etag:'"same"'}),{unchanged:true,etag:'"same"'});
  assert.deepEqual(requests,['HEAD','GET','HEAD']);
  let headOnly=0;
  const metadata=await downloadCodexDesktop({architecture:'x64',packagePath,installedVersion:'26.101.0.0',fetcher:async(_url,options)=>{
    assert.equal(options.method,'HEAD');headOnly++;
    return new Response(null,{headers:{etag:'"new-blob"','x-ms-meta-package_identity':'OpenAI.Codex',
      'x-ms-meta-package_version':'26.101.0.0','x-ms-meta-architecture':'x64'}});
  }});
  assert.deepEqual(metadata,{unchanged:true,etag:'"new-blob"'});assert.equal(headOnly,1);
  for(const mode of ['quota','truncated','encoding','changed']){
    await assert.rejects(downloadCodexDesktop({architecture:'x64',packagePath,fetcher:async(_url,options)=>new Response(options.method==='HEAD'?null:bytes,
      {headers:{etag:mode==='changed'&&options.method==='GET'?'"other"':'"same"','content-length':mode==='quota'?String(2**31):'2048',
        ...(mode==='encoding'?{'content-encoding':'gzip'}:{})}})}));
    assert.deepEqual(await fs.readFile(packagePath),bytes,'failed download cannot replace the inspected artifact');
  }
});

test('native Desktop servicing uses fixed OS modules and defers in-use registration without force',async()=>{
  assert.match(ASSISTANT_CODEX_UPDATE_SCRIPT,/Add-AppxPackage -Path.*-DeferRegistrationWhenPackagesAreInUse/);
  assert.doesNotMatch(ASSISTANT_CODEX_UPDATE_SCRIPT,/ForceApplicationShutdown|ForceTargetApplicationShutdown|ForceUpdateFromAnyVersion|AllowUnsigned|RunAs|ExecutionPolicy/);
  assert.match(ASSISTANT_CODEX_UPDATE_SCRIPT,/Get-AuthenticodeSignature/);assert.match(ASSISTANT_CODEX_UPDATE_SCRIPT,/\[IO.FileShare\]::Read/);
  assert.match(ASSISTANT_CODEX_UPDATE_SCRIPT,/identity.Publisher -cne \$installed.Publisher/);
  assert.match(ASSISTANT_CODEX_UPDATE_SCRIPT,/DtdProcessing.*Prohibit/);
  let invoked=0;
  await assert.rejects(runAssistantWindowsCodexUpdate('evil',{runNative:()=>{invoked++;}}));assert.equal(invoked,0);
  await assert.rejects(runAssistantWindowsCodexUpdate('inspect',{guard:async()=>{throw Object.assign(Error(),{code:'DIGITAL_ASSISTANT_DEVICE_REVOKED'});},
    runNative:()=>{invoked++;}}),{code:'DIGITAL_ASSISTANT_DEVICE_REVOKED'});
  assert.equal(invoked,0,'the real native adapter checks liveness before spawning the OS helper');
  const result=await runAssistantWindowsCodexUpdate('inspect',{runNative:async(_input,options)=>options.project({schemaVersion:1,version:'26.100.0.0',architecture:'arm64'})});
  assert.equal(result.architecture,'arm64');
  await assert.rejects(runAssistantWindowsCodexUpdate('inspect',{runNative:async(_input,options)=>options.project({schemaVersion:1,version:'26.100.0.0',architecture:'x64',private:'never'})}));
});

test('Windows parses the complete Desktop helper and executes its real read/refusal boundary without installing',
  {skip:process.platform!=='win32'},async()=>{
    const {runAssistantWindowsBackgroundNative}=await import('../host-runtime/scripts/trelio-assistant-setup.mjs');
    const source=Buffer.from(ASSISTANT_CODEX_UPDATE_SCRIPT,'utf8').toString('base64');
    const script=`[void][Console]::In.ReadToEnd();$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'));$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){exit 1};[Console]::Out.Write('{"schemaVersion":1,"version":"26.100.0.0","architecture":"x64"}')`;
    const parsed=await runAssistantWindowsBackgroundNative({operation:'inspect'},{script,project:value=>value});
    assert.equal(parsed.version,'26.100.0.0');
    const observed=await runAssistantWindowsCodexUpdate('inspect');
    assert.ok(observed.state==='not_installed'||/^\d+\.\d+\.\d+\.\d+$/u.test(observed.version));
    // Invalid digest is rejected before opening any candidate/deployment. This
    // test uses the production script, not a mock deployment or a trusted cert.
    await assert.rejects(runAssistantWindowsBackgroundNative({operation:'install',sha256:'invalid',packagePath:'C:\\invalid.msix'},
      {script:ASSISTANT_CODEX_UPDATE_SCRIPT,project:()=>assert.fail('invalid install cannot succeed')}));
  });
const snapshot=()=>({revision:0,generation:0,code:'ready',latchedCodes:[],compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:'4.9.0'}});
const fixture=()=>{
  let state=snapshot();const reports=[];
  return {reports,get state(){return state;},set state(value){state={...value,latchedCodes:[...new Set([...(value.latchedCodes??[]),...(['codex_auth_required','hook_review_required','dispatch_review_required'].includes(value.code)?[value.code]:[])])]};},
    client:{readHealth:async()=>structuredClone(state),reportHealth:async input=>{
      assert.equal(input.expectedRevision,state.revision);assert.match(input.clientRequestId,/^[a-f0-9-]{36}$/u);
      const latched=new Set(state.latchedCodes);if(['codex_auth_required','hook_review_required','dispatch_review_required'].includes(input.code))latched.add(input.code);
      if(input.clearedReason)latched.delete(input.clearedReason);
      const code=input.code==='ready'?(latched.has('codex_auth_required')?'codex_auth_required':latched.has('hook_review_required')?'hook_review_required':latched.has('dispatch_review_required')?'dispatch_review_required':'ready'):input.code;
      reports.push(input);state={...state,revision:state.revision+1,code,latchedCodes:[...latched]};return state;
    }},
  };
};

test('optional releases do not block; real shared minimum is checked without relying on model errors',()=>{
  assert.equal(assistantHealthCompatibility(snapshot(),versions),null);
  assert.equal(assistantHealthCompatibility({...snapshot(),compatibility:{minimumPluginVersion:'3.2.4',minimumRuntimeVersion:'4.9.0'}},versions),'plugin_update_required');
  assert.equal(assistantHealthCompatibility({...snapshot(),compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:'5.0.1'}},versions),'runtime_update_failed');
  assert.throws(()=>assistantHealthCompatibility({...snapshot(),compatibility:{minimumPluginVersion:'garbage'}},versions),/INVALID_RESPONSE/);
  assert.equal(assistantHealthFailure(new Error('Please reinstall plugin PRIVATE')),null,'never infer a cause from prose');
  for(const code of ['__proto__','constructor','toString'])assert.equal(assistantHealthFailure({code}),null,'health identity is a closed own-key map');
});

test('maintenance has no model turn, retries only signed update and cannot clear an unrelated auth/trust failure',async()=>{
  const f=fixture();let probes=0,updates=0;
  const options={client:f.client,versions,update:async()=>{updates++;},probe:async()=>{probes++;}};
  await maintainAssistantHost(options);assert.equal(f.state.code,'ready');
  f.state={...f.state,code:'hook_review_required'};await maintainAssistantHost(options);
  assert.equal(f.state.code,'hook_review_required','metadata success is not hook approval');
  f.state={...f.state,code:'codex_auth_required'};await maintainAssistantHost(options);assert.equal(f.state.code,'codex_auth_required');
  await maintainAssistantHost({...options,update:async()=>{throw new Error('PRIVATE update log');}});
  assert.equal(f.state.code,'runtime_update_failed');assert.ok(f.state.latchedCodes.includes('codex_auth_required'));
  await maintainAssistantHost(options);assert.equal(f.state.code,'codex_auth_required','the newer updater error did not erase native login');
  f.state={...snapshot(),revision:f.state.revision,code:'runtime_update_failed'};
  await maintainAssistantHost(options);assert.equal(f.state.code,'ready');
  assert.equal(updates,5);assert.equal(probes,6);
  assert.ok(!JSON.stringify(f.reports).includes('PRIVATE'));
});

test('confirmed plugin floor requests owner action even if updater fails; unknown network error never reports recovery',async()=>{
  const f=fixture();f.state={...f.state,compatibility:{minimumPluginVersion:'3.3.0',minimumRuntimeVersion:'4.9.0'}};
  await maintainAssistantHost({client:f.client,versions,update:async()=>{throw new Error();},probe:async()=>assert.fail('obsolete plugin must not probe business')});
  assert.equal(f.state.code,'plugin_update_required');
  f.state={...snapshot(),code:'connection_lost'};
  const before=f.reports.length;
  await assert.rejects(maintainAssistantHost({client:f.client,versions,update:async()=>{},probe:async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});}}));
  assert.equal(f.reports.length,before);
});

test('current-runtime request uses the exact loader, bounded stdin/UTF-8 output, and never retries the tool',async()=>{
  let calls=0,received;
  const result=await requestCurrentAssistantRuntime({operation:'call',name:'get_task',arguments:{note:'Привет'}},{
    environment:{TRELIO_PLUGIN_ROOT:'/fixture/plugin'},resolveLoader:async()=>'/fixture/plugin/scripts/trelio-host-runtime-loader.mjs',
    spawnProcess:(executable,args,options)=>{
      calls++;assert.equal(executable,process.execPath);assert.deepEqual(args,['/fixture/plugin/scripts/trelio-host-runtime-loader.mjs','bridge','assistant','request']);
      assert.equal(options.shell,false);assert.deepEqual(options.stdio,['pipe','pipe','ignore']);
      const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
      let input='';child.stdin.on('data',chunk=>input+=chunk);child.stdin.on('finish',()=>queueMicrotask(()=>{
        received=JSON.parse(input);const bytes=Buffer.from(JSON.stringify({value:{text:'Привет'}}));
        const split=bytes.indexOf(Buffer.from('П'))+1;child.stdout.write(bytes.subarray(0,split));child.stdout.write(bytes.subarray(split));child.emit('close',0);
      }));return child;
    },
  });
  assert.deepEqual(result,{text:'Привет'});assert.equal(received.arguments.note,'Привет');assert.equal(calls,1);
  await assert.rejects(requestCurrentAssistantRuntime({operation:'call',name:'get_task',arguments:{},command:'PRIVATE'},{resolveLoader:async()=>assert.fail('invalid input touched loader')}),/REQUEST_INVALID/);
});

test('worker preserves one response and never exposes raw exceptions or copies credentials',async()=>{
  const output=new PassThrough();let raw='';output.on('data',chunk=>raw+=chunk);
  await runAssistantEntry(['request'],{input:Readable.from([JSON.stringify({operation:'list'})]),output,
    executeRequest:async()=>{throw new Error('PRIVATE CREDENTIAL');}});
  assert.ok(!raw.includes('PRIVATE'));assert.equal(JSON.parse(raw).failure,'ASSISTANT_SETUP_UNAVAILABLE');
});

test('source setup failures survive the worker and facade without private diagnostics or replay',async()=>{
  for(const code of ['ASSISTANT_SOURCE_SETUP_TELEGRAM_NETWORK_UNAVAILABLE','TRELIO_SKILL_RUNTIME_EXIT_2',
    'TRELIO_SKILL_RUNTIME_OUTPUT_INVALID','TRELIO_SKILL_PYTHON_REQUIRED']){
    const output=new PassThrough();let raw='',executions=0,spawns=0;
    output.on('data',chunk=>raw+=chunk);
    await runAssistantEntry(['request'],{input:Readable.from([JSON.stringify({operation:'list'})]),output,
      executeRequest:async()=>{executions++;throw Object.assign(new Error('PRIVATE_FACTOR'),{code,details:{path:'PRIVATE_PATH'}});}});
    assert.deepEqual(JSON.parse(raw),{failure:code});assert.equal(executions,1);
    await assert.rejects(requestCurrentAssistantRuntime({operation:'list'},{resolveLoader:async()=>'/fixture/loader.mjs',
      spawnProcess:()=>{
        spawns++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
        child.stdin.resume();child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.write(raw);child.emit('close',0);}));return child;
      }}),error=>error.code===code);
    assert.equal(spawns,1);assert.doesNotMatch(raw,/PRIVATE/);
  }
});

test('the longer private worker wait is reserved for the fixed protected setup tools, never general commands',async()=>{
  let spawns=0;
  const options={timeoutMs:11*60_000,resolveLoader:async()=>'/fixture/loader.mjs',spawnProcess:()=>{
    spawns++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
    child.stdin.resume();child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.write(JSON.stringify({value:{state:'configuration_saved'}}));child.emit('close',0);}));return child;
  }};
  await assert.rejects(requestCurrentAssistantRuntime({operation:'call',name:'get_task',arguments:{}},options),/REQUEST_INVALID/);
  assert.equal(spawns,0);
  for(const name of ['configure_assistant_email_source','configure_assistant_telegram_source','configure_assistant_max_source']){
    const before=spawns;
    const result=await requestCurrentAssistantRuntime({operation:'call',name,arguments:{}},options);
    assert.equal(result.state,'configuration_saved');assert.equal(spawns,before+1);
    await assert.rejects(requestCurrentAssistantRuntime({operation:'call',name,arguments:{}},
      {...options,timeoutMs:11*60_000+1}),/REQUEST_INVALID/);
    assert.equal(spawns,before+1);
  }
});

test('a failed worker invocation is not retried or replaced with a human profile',async()=>{
  let spawns=0;
  await assert.rejects(requestCurrentAssistantRuntime({operation:'call',name:'get_task',arguments:{}},{
    resolveLoader:async()=>'/fixture/loader.mjs',spawnProcess:()=>{
      spawns++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
      child.stdin.resume();child.stdin.on('finish',()=>queueMicrotask(()=>{
        child.stdout.write(JSON.stringify({failure:'ASSISTANT_ACCESS_DENIED'}));child.emit('close',0);
      }));return child;
    },
  }),{code:'ASSISTANT_ACCESS_DENIED'});
  assert.equal(spawns,1);
});

test('a vanished exact loaded shell reports restart through the protected control plane without another loader',async()=>{
  const f=fixture();
  await reportAssistantMaintenanceFailure({code:'TRELIO_PLUGIN_RESTART_REQUIRED',message:'PRIVATE path'},f.client);
  assert.equal(f.state.code,'plugin_restart_required');
  assert.ok(!JSON.stringify(f.reports).includes('PRIVATE'));
  await maintainAssistantHost({client:f.client,versions,update:async()=>{},probe:async()=>{}});
  assert.equal(f.state.code,'ready','a new worker through the valid loaded shell confirms restart recovery');
  const before=f.reports.length;
  await reportAssistantMaintenanceFailure({code:'UNKNOWN',message:'Please reinstall'},f.client);
  assert.equal(f.reports.length,before);
});

test('only a successful protected read clears hook review; metadata cannot clear native login',()=>{
  const current={code:'plugin_update_required',latchedCodes:['hook_review_required','codex_auth_required']};
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'list'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'get_assistant_status'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'prepare_assistant_source_account'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'configure_assistant_email_source'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'verify_assistant_email_source'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'get_task'}),{code:'ready',clearedReason:'hook_review_required'});
});


test('retained dispatch failures report one closed reason and only the committed recovery boundary may clear it',async()=>{
  const f=fixture();
  for(const code of ['ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN','ASSISTANT_COORDINATOR_DELIVERY_REVIEW_REQUIRED',
    'ASSISTANT_COORDINATOR_PROVISION_REVIEW_REQUIRED','ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED',
    'ASSISTANT_INTAKE_PROVISION_REVIEW_REQUIRED','ASSISTANT_INTAKE_REVIEW_REQUIRED'])
    assert.equal(assistantHealthFailure({code,message:'PRIVATE'}),'dispatch_review_required');
  assert.equal(assistantHealthFailure({code:'ASSISTANT_INTAKE_CHANGED'}),null);
  assert.equal(assistantHealthFailure({code:'ASSISTANT_COORDINATOR_SETUP_REQUIRED'}),null);
  await reportAssistantMaintenanceFailure({code:'ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN',message:'PRIVATE'},f.client);
  assert.equal(f.reports.at(-1).code,'dispatch_review_required');
  const reported=f.reports.length;
  await reportAssistantMaintenanceFailure({code:'ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN'},f.client);
  assert.equal(f.reports.length,reported,'worker/parent observation of the same fence does not post twice');
  await maintainAssistantHost({client:f.client,versions,update:async()=>{},probe:async()=>{}});
  assert.equal(f.state.code,'dispatch_review_required','signed metadata/catalogue success never clears retained dispatch review');
  assert.deepEqual(assistantHealthyBoundary(f.state,{operation:'list'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(f.state,{operation:'call',name:'get_task'}),{code:'ready'});
  await reportAssistantDispatchRecovery(f.client);
  assert.equal(f.reports.at(-1).clearedReason,'dispatch_review_required');
  f.state={...f.state,code:'plugin_update_required',latchedCodes:['dispatch_review_required']};
  const count=f.reports.length;await reportAssistantDispatchRecovery(f.client);
  assert.equal(f.reports.length,count,'a business receipt does not clear a newer unrelated outage');
  await reportAssistantDispatchRecovery({readHealth:async()=>{throw new Error('PRIVATE');}});
  await reportAssistantDispatchRecovery({readHealth:async()=>({code:'dispatch_review_required',revision:1}),
    reportHealth:async()=>{throw new Error('PRIVATE');}});
  assert.ok(!JSON.stringify(f.reports).includes('PRIVATE'));
});

for(const permitted of [false,true])test(`health offers a retained pass only the coordinator-fenced signed update (allowed=${permitted})`,async()=>{
  let updates=0,closed=0,checks=0,boundaries=0;
  const result=await executeAssistantRuntimeRequest({operation:'health'},{
    context:async action=>action({}, {readActivation:async()=>null,readActivePass:async()=>({retained:true})}),
    createRuntimeHost:async()=>({coordinator:{updateRuntimeAtBoundary:async update=>{
      boundaries++;if(permitted)await update();return permitted;
    }},close:async()=>{closed++;}}),
    upgradeRuntime:async options=>{assert.equal(options.timeoutMs,30000);updates++;},
    requestRuntime:async request=>{assert.deepEqual(request,{operation:'health_check'});checks++;return {state:'checked'};},
  });
  assert.deepEqual(result,{state:'checked'});assert.equal(boundaries,1);assert.equal(closed,1);assert.equal(checks,1);
  assert.equal(updates,permitted?1:0);
});
