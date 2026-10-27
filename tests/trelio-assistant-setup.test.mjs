import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { createAssistantSetup, maintainAssistantPlugin, runAssistantWindowsDesktop, ASSISTANT_WINDOWS_DESKTOP_SCRIPT } from '../host-runtime/scripts/trelio-assistant-setup.mjs';
import { createAssistantDeviceClient,createAssistantMcpClient,AssistantTransportError } from '../host-runtime/scripts/trelio-assistant-transport.mjs';
import { createAssistantHostState } from '../host-runtime/scripts/trelio-assistant-hook.mjs';
import { runAssistantSetupMcp, runAssistantEntry,requestCurrentAssistantRuntime,withAssistantNewWorkAdmission,assistantCatalogRevision, createAssistantRuntimeHost, assistantCoordinatorReadiness, runAssistantBackgroundTick, runAssistantBackground,
  executeAssistantRuntimeRequest,readProductionAssistantDispatchStatus,ASSISTANT_LOCAL_CONNECTION_TOOL,ASSISTANT_SOURCE_SETUP_TOOL,ASSISTANT_EMAIL_SETUP_TOOL,ASSISTANT_EMAIL_VERIFY_TOOL,ASSISTANT_TELEGRAM_SETUP_TOOL,ASSISTANT_MAX_SETUP_TOOL,ASSISTANT_MAX_VERIFY_TOOL,ASSISTANT_ENCRYPTION_SETUP_TOOL } from '../host-runtime/scripts/trelio-assistant-entry.mjs';

const memorySetupHost=(store,{afterWrite}={})=>{
  const files=new Map();let queued=Promise.resolve();
  const host=createAssistantHostState({directory:path.join(os.tmpdir(),'synthetic-setup-'+randomUUID()),store,primitives:{
    ensurePrivateDirectory:async()=>{},assertPrivatePathKind:async file=>{if(!files.has(file))throw Object.assign(new Error(),{code:'ENOENT'});},
    readPrivateJsonFile:async file=>structuredClone(files.get(file)),
    writePrivateJsonFile:async(file,value)=>{files.set(file,structuredClone(value));await afterWrite?.(file,value);},
    withSetupLock:action=>{const result=queued.then(action);queued=result.catch(()=>{});return result;},
  }});
  return {host,files};
};

const stagedSetupFixture=async({previous=null,target=previous?.assistantId??randomUUID(),legacy=false,afterWrite}={})=>{
  const origin='https://owner-rebind.test',deviceId=randomUUID(),values=new Map(),reads=[],writes=[],pairs=new Map();
  const oldSecret=previous?{assistantId:previous.assistantId,deviceId:previous.deviceId,credential:`tda_${'o'.repeat(43)}`,expiresAt:1}:null;
  const secret={assistantId:target,deviceId,credential:`tda_${'n'.repeat(43)}`,expiresAt:90000};
  let activeAuthorization=null,background='not_installed',removed=0,inspected=0,exchanged=0,failActiveWrite=false,expired=false,clock=100,pairRequests=0,loseAttach=false,removeError=null;
  const slot=input=>JSON.stringify(input),deviceKey=assistantId=>({origin,kind:'device',id:assistantId});
  const store={get:async input=>{reads.push(input);return structuredClone(values.get(slot(input))??null);},put:async(input,value)=>{
    writes.push({input,value:structuredClone(value)});values.set(slot(input),structuredClone(value));
    if(input.kind==='device'&&failActiveWrite){failActiveWrite=false;throw new Error('synthetic lost protected-write acknowledgement');}
  }};
  if(oldSecret)await store.put(deviceKey(previous.assistantId),oldSecret);
  if(legacy)await store.put(deviceKey(target),secret);
  const {host,files}=memorySetupHost(store,{afterWrite});
  if(previous)await host.saveIdentity(previous);
  const authorization=(row,replace=true)=>({schemaVersion:1,mode:previous&&replace?'replace':'initial',assistantUserId:target,
    replacesAssistantUserId:previous&&replace?previous.assistantId:null,replacesDeviceId:previous&&replace?previous.deviceId:null,authorizationId:row.pairingId});
  const http=async(operation,input,credential)=>{
    if(operation==='pair'){
      pairRequests++;
      if(expired)throw new AssistantTransportError('ASSISTANT_PAIRING_EXPIRED',410);
      let row=pairs.get(input.enrollmentId);
      if(!row){row={pairingId:randomUUID(),state:'pending',recovery:null};pairs.set(input.enrollmentId,row);}
      if(credential===secret.credential){
        if(row.state!=='pending'&&!row.recovery)throw new AssistantTransportError('ASSISTANT_STATE_CHANGED',409);
        row.recovery={assistantUserId:target,deviceId};
        if(loseAttach){loseAttach=false;throw new Error('synthetic lost recovery attach response');}
      }
      return {pairingId:row.pairingId,assistantUserId:target,state:row.state,recovery:row.recovery,
        verificationCode:'ABCDEF12',expiresAt:new Date(80000).toISOString()};
    }
    if(operation==='exchange'){
      exchanged++;const row=[...pairs.values()].find(row=>row.pairingId===input.pairingId);
      if(row.state!=='approved')throw new AssistantTransportError('ASSISTANT_PAIRING_NOT_APPROVED',409);
      row.state='exchanged';activeAuthorization=authorization(row,row.replace);
      return {...secret,assistantUserId:target,expiresAt:new Date(secret.expiresAt).toISOString(),activation:activeAuthorization};
    }
    assert.equal(operation,'heartbeat');
    if(credential===secret.credential)return {assistantUserId:target,deviceId,activation:activeAuthorization};
    if(oldSecret&&credential===oldSecret.credential&&!activeAuthorization)return {assistantUserId:previous.assistantId,deviceId:previous.deviceId};
    throw new AssistantTransportError('ASSISTANT_ACCESS_DENIED',403);
  };
  const backgroundReplacement={inspect:async selected=>{
    inspected++;assert.deepEqual(await host.readIdentity(),selected);
    return {schemaVersion:1,state:background,snapshot:background==='not_installed'?null:{schemaVersion:1,
      assistantId:selected.assistantId,deviceId:selected.deviceId,principalSid:'S-1-5-21-1-2-3-1001',definitionSha256:'a'.repeat(64)}};
  },remove:async(selected,snapshot)=>{if(removeError){const code=removeError;removeError=null;throw Object.assign(new Error(code),{code});}removed++;assert.equal(snapshot.deviceId,selected.deviceId);assert.equal(background,'registered');background='not_installed';}};
  const options={origin,store,http,host,backgroundReplacement,withLock:host.withSetupLock,now:()=>clock};
  return {origin,store,host,files,reads,writes,secret,oldSecret,options,setup:createAssistantSetup(options),
    approve:(enrollmentId,replace=true)=>{const row=pairs.get(enrollmentId);row.replace=replace;row.state=row.recovery?'exchanged':'approved';if(row.recovery)activeAuthorization=authorization(row,replace);},
    deny:enrollmentId=>{pairs.get(enrollmentId).state='denied';},expire:()=>{expired=true;},unexpire:()=>{expired=false;},
    setClock:value=>{clock=value;},pairRequests:()=>pairRequests,loseAttach:()=>{loseAttach=true;},rejectRemoval:code=>{removeError=code;},
    setBackground:value=>{background=value;},loseActiveWrite:()=>{failActiveWrite=true;},
    counts:()=>({exchanged,removed,inspected,activeWrites:writes.filter(write=>write.input.kind==='device'&&write.value.credential===secret.credential).length}),
  };
};

test('setup projects only pairing code and live identities, with no repeated exchange', async () => {
  const origin='https://assistant.test', enrollmentId=randomUUID(), assistantUserId=randomUUID(), deviceId=randomUUID(),pairingId=randomUUID();
  const values = new Map(), key = input => JSON.stringify(input);
  const store = { get: async input => structuredClone(values.get(key(input)) ?? null),
    put: async (input,value) => values.set(key(input),structuredClone(value)) };
  let exchanges = 0, revoked = false;
  const http = async (operation) => {
    if (operation === 'pair') return { pairingId,assistantUserId,state:'pending',recovery:null,verificationCode:'ABCDEF12', expiresAt:new Date(20000).toISOString() };
    if (operation === 'exchange') { exchanges++; return { assistantUserId,deviceId,credential:`tda_${'b'.repeat(43)}`,expiresAt:new Date(30000).toISOString(),
      activation:{schemaVersion:1,mode:'initial',assistantUserId,replacesAssistantUserId:null,replacesDeviceId:null,authorizationId:pairingId} }; }
    assert.equal(operation,'heartbeat');
    if(revoked) throw Object.assign(new Error('PRIVATE FAILURE'),{code:'ASSISTANT_ACCESS_DENIED'});
    return {assistantUserId,deviceId};
  };
  const {host}=memorySetupHost(store);
  const setup = createAssistantSetup({origin,store,http,host,withLock:host.withSetupLock,now:()=>100});
  assert.deepEqual(await setup.status(enrollmentId),{state:'not_started'});
  assert.deepEqual(await setup.begin(enrollmentId,'Fixture'),{state:'waiting_owner',verificationCode:'ABCDEF12',expiresAt:20000});
  assert.ok(!JSON.stringify(await setup.status(enrollmentId)).includes('verifier'));
  const result = await setup.finish(enrollmentId);
  assert.equal(result.assistantId,assistantUserId); assert.equal(result.businessReady,false);
  assert.deepEqual(await setup.finish(enrollmentId),result);
  assert.deepEqual(await setup.status(enrollmentId),result);
  assert.equal(exchanges,1);
  assert.ok(!JSON.stringify(result).includes('tda_'));
  revoked=true;
  await assert.rejects(setup.status(enrollmentId),error=>error.code==='ASSISTANT_ACCESS_DENIED');
  assert.equal(exchanges,1,'revocation never causes re-pair or a second exchange');
});

test('uncertain exchange remains blocked after setup restart', async () => {
  const values=new Map(),key=input=>JSON.stringify(input),enrollmentId=randomUUID(),pairingId=randomUUID(),assistantUserId=randomUUID();
  const store={get:async input=>structuredClone(values.get(key(input))??null),
    put:async(input,value)=>values.set(key(input),structuredClone(value))};
  let exchanges=0;
  const {host}=memorySetupHost(store);
  const options={origin:'https://assistant.test',store,host,withLock:host.withSetupLock,now:()=>100,http:async operation=>{
    if(operation==='pair')return {pairingId,assistantUserId,state:'pending',recovery:null,verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
    exchanges++;throw new Error('committed response lost');
  }};
  const setup=createAssistantSetup(options);await setup.begin(enrollmentId,'Fixture');
  await assert.rejects(setup.finish(enrollmentId),/RECOVERY_REQUIRED/);
  const restarted=createAssistantSetup(options);
  assert.deepEqual(await restarted.status(enrollmentId),{state:'recovery_required'});
  await assert.rejects(restarted.finish(enrollmentId),/RECOVERY_REQUIRED/);assert.equal(exchanges,1);
});

test('replacement stages candidate before active writes, waits for exact idle background and reuses the same enrollment',async()=>{
  const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const f=await stagedSetupFixture({previous}),enrollmentId=randomUUID();
  f.setBackground('running');await f.setup.begin(enrollmentId,'Windows fixture');f.approve(enrollmentId);
  const wait=await f.setup.finish(enrollmentId);
  assert.equal(wait.state,'replacement_waiting_background');assert.equal(wait.backgroundTaskName,'Trelio-DigitalAssistant-'+previous.assistantId);
  assert.deepEqual(await f.host.readIdentity(),previous);
  assert.deepEqual(await f.store.get({origin:f.origin,kind:'device',id:previous.assistantId}),f.oldSecret,'old active credential is unchanged while background is busy');
  assert.equal((await f.host.readActivation()).stage,'quiescing');
  assert.equal((await f.setup.status(enrollmentId)).state,'activation_pending');
  assert.equal(f.counts().removed,0);assert.equal(f.counts().activeWrites,0);
  f.setBackground('registered');const done=await createAssistantSetup(f.options).finish(enrollmentId);
  assert.equal(done.state,'paired');assert.equal(done.deviceId,f.secret.deviceId);
  assert.deepEqual(f.counts(),{exchanged:1,removed:1,inspected:3,activeWrites:1});
  const before=f.counts();assert.equal((await f.setup.begin(enrollmentId,'Windows fixture')).state,'paired');
  assert.equal((await f.setup.finish(enrollmentId)).state,'paired');assert.deepEqual(f.counts(),before);
});

test('ordinary add-device approval never grants replacement or overwrites the old credential',async()=>{
  const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const f=await stagedSetupFixture({previous}),enrollmentId=randomUUID();await f.setup.begin(enrollmentId,'Windows fixture');f.approve(enrollmentId,false);
  await assert.rejects(f.setup.finish(enrollmentId),{code:'ASSISTANT_HOST_ACTIVATION_INVALID'});
  assert.deepEqual(await f.host.readIdentity(),previous);assert.equal(f.counts().activeWrites,0);assert.equal(f.counts().removed,0);
});

test('a retained local pass blocks pair before HTTP even if native work might already be closed',async()=>{
  const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const f=await stagedSetupFixture({previous}),enrollmentId=randomUUID();
  // It is deliberately NOT inferred closed from native counts or age. The
  // original pass recovery must verify/release it through its existing engine.
  await f.store.put({origin:f.origin,kind:'pass',id:previous.deviceId},{retainedUnknownOutcome:true});
  await assert.rejects(f.setup.begin(enrollmentId,'Windows fixture'));
  assert.equal(await f.store.get({origin:f.origin,kind:'pairing',id:enrollmentId}),null);
  assert.equal(await f.host.readActivation(),null);assert.equal(f.counts().exchanged,0);assert.equal(f.pairRequests(),0);
  assert.deepEqual(await f.host.readIdentity(),previous);
});

test('definitively denied or expired pending enrollment can release its denial despite a broken old credential',async()=>{
  for(const rejection of ['denied','expired']){
    const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
    const f=await stagedSetupFixture({previous,legacy:true}),enrollmentId=randomUUID();
    await f.setup.begin(enrollmentId,'Windows fixture');
    if(rejection==='denied'){f.deny(enrollmentId);assert.equal((await f.setup.status(enrollmentId)).state,'denied');}
    else{f.expire();await assert.rejects(f.setup.status(enrollmentId),{code:'ASSISTANT_PAIRING_EXPIRED'});f.unexpire();}
    assert.equal((await f.host.readActivation()).stage,'released');assert.deepEqual(await f.host.readIdentity(),previous);
    assert.equal((await f.setup.begin(randomUUID(),'Windows fixture')).state,'waiting_owner');
    assert.equal(f.counts().exchanged,0);assert.equal(f.counts().removed,0);
  }
});

test('legacy half-commit recovers same or different assistant by one exact native target, never another exchange',async()=>{
  for(const differentAssistant of [false,true]){
    const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
    const target=differentAssistant?randomUUID():previous.assistantId;
    const f=await stagedSetupFixture({previous,target,legacy:true}),enrollmentId=randomUUID();
    await f.setup.begin(enrollmentId,'Windows fixture');
    assert.equal((await f.setup.finish(enrollmentId)).state,'waiting_owner','old generic pairing is not replacement approval');
    f.approve(enrollmentId);assert.equal((await f.setup.finish(enrollmentId)).state,'paired');
    assert.equal(f.counts().exchanged,0);assert.equal(f.counts().activeWrites,1,'only the pre-existing legacy write exists');
    assert.ok(f.reads.filter(read=>read.kind==='device').every(read=>[previous.assistantId,target].includes(read.id)),'no private slot scan');
  }
});

test('lost active-credential write reply resumes by exact read-back without repeating the writer or exchange',async()=>{
  const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const f=await stagedSetupFixture({previous}),enrollmentId=randomUUID();await f.setup.begin(enrollmentId,'Windows fixture');f.approve(enrollmentId);
  f.loseActiveWrite();await assert.rejects(f.setup.finish(enrollmentId));
  assert.deepEqual(await f.host.readIdentity(),previous);assert.equal((await f.host.readActivation()).stage,'quiescing');
  assert.equal((await createAssistantSetup(f.options).finish(enrollmentId)).state,'paired');
  assert.equal(f.counts().activeWrites,1);assert.equal(f.counts().exchanged,1);
});

test('crash after identity write resumes the same activation without old background inspection or a second write',async()=>{
  for(const replacement of [false,true]){
    const previous=replacement?{schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()}:null;
    let crash=false;
    const f=await stagedSetupFixture({previous,afterWrite:async(file,value)=>{
      if(crash&&file.endsWith('identity.json')){crash=false;throw new Error('synthetic crash after identity publication');}
    }}),enrollmentId=randomUUID();
    if(replacement)f.setBackground('registered');
    await f.setup.begin(enrollmentId,'Windows fixture');f.approve(enrollmentId);crash=true;
    await assert.rejects(f.setup.finish(enrollmentId));
    assert.equal((await f.host.readIdentity()).deviceId,f.secret.deviceId);assert.equal((await f.host.readActivation()).stage,'quiescing');
    const before=f.counts();assert.equal((await createAssistantSetup(f.options).finish(enrollmentId)).state,'paired');
    assert.deepEqual(f.counts(),before,'only the interrupted structural activation commit is completed');
  }
});

test('lost different-assistant candidate attach survives restart and short enrollment expiry through durable heartbeat only',async()=>{
  const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const f=await stagedSetupFixture({previous,target:randomUUID(),legacy:true}),enrollmentId=randomUUID();f.loseAttach();
  await assert.rejects(f.setup.begin(enrollmentId,'Windows fixture'));
  const retained=await f.store.get({origin:f.origin,kind:'pairing',id:enrollmentId});
  assert.equal(retained.recovery.deviceId,f.secret.deviceId,'exact candidate is durable BEFORE the native attach request');
  f.approve(enrollmentId);f.setClock(100000);f.expire();const pairRequests=f.pairRequests();
  const restarted=createAssistantSetup(f.options);
  assert.equal((await restarted.status(enrollmentId)).state,'activation_pending');
  assert.equal((await restarted.finish(enrollmentId)).state,'paired');
  assert.equal(f.pairRequests(),pairRequests,'durable approval is read before expired enrollment refresh');
  assert.equal(f.counts().exchanged,0,'legacy candidate never repeats its original one-use exchange');
});

test('only native known-no-delete busy releases the exact background attempt fence',async()=>{
  for(const code of ['ASSISTANT_BACKGROUND_BUSY','ASSISTANT_BACKGROUND_ACCESS_DENIED']){
    const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
    const f=await stagedSetupFixture({previous}),enrollmentId=randomUUID();f.setBackground('registered');
    await f.setup.begin(enrollmentId,'Windows fixture');f.approve(enrollmentId);f.rejectRemoval(code);
    if(code==='ASSISTANT_BACKGROUND_BUSY'){
      assert.equal((await f.setup.finish(enrollmentId)).reason,'supervisor_not_idle');
      assert.equal(f.counts().removed,0,'native busy is rejected before DeleteTask');
      assert.equal((await createAssistantSetup(f.options).finish(enrollmentId)).state,'paired');
      assert.equal(f.counts().removed,1);
    }else{
      await assert.rejects(f.setup.finish(enrollmentId),{code});
      assert.equal((await createAssistantSetup(f.options).finish(enrollmentId)).reason,'removal_outcome_unknown');
      assert.equal(f.counts().removed,0,'unknown/access result never repeats the OS deletion');
    }
  }
});

test('actual stdio frames discover setup without auth I/O and reject unknown fields/tools', async () => {
  const frames=[{jsonrpc:'2.0',id:1,method:'initialize'},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'human_login',arguments:{}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_assistant_setup_status',arguments:{enrollmentId:randomUUID(),credential:'PRIVATE'}}},
    {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'get_assistant_setup_status',arguments:{enrollmentId:randomUUID()}}}];
  const output=new PassThrough();let raw='',created=0,reads=0;output.on('data',chunk=>raw+=chunk);
  await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
    createWorkspace:async()=>assert.fail('unpaired discovery must not create a Workspace coordinator'),
    createMcp:async()=>null,createSetup:async()=>{created++;return {status:async()=>{reads++;return {state:'not_started'};}};}});
  const messages=raw.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length,5);
  assert.equal(messages[1].result.tools.length,6);
  assert.equal(messages[2].result.structuredContent.code,'ASSISTANT_CAPABILITY_UNAVAILABLE');
  assert.equal(messages[3].result.structuredContent.code,'ASSISTANT_SETUP_INVALID_INPUT');
  assert.deepEqual(messages[4].result.structuredContent,{state:'not_started'});
  assert.equal(reads,1);assert.equal(created,1);assert.ok(!raw.includes('PRIVATE'));
});

test('oversized frames and unsupported entry commands fail before setup or private access', async () => {
  let created=0;
  await assert.rejects(runAssistantSetupMcp({input:Readable.from(['a'.repeat(131073)]),output:new PassThrough(),
    createSetup:async()=>{created++;}}),/FRAME_TOO_LARGE/);
  await assert.rejects(runAssistantEntry(['mcp','--human-oauth']),/COMMAND_UNSUPPORTED/);
  assert.equal(created,0);
});

test('startup retains all six setup tools for an observed local device conflict without admitting business work',async()=>{
  const origin='https://rebind-fixture.test',assistantId=randomUUID(),deviceId=randomUUID();
  for(const candidate of [null,{assistantId,deviceId:randomUUID(),credential:`tda_${'c'.repeat(43)}`,expiresAt:1}]){
    let calls=0,setupCalls=0,raw='';const output=new PassThrough();output.on('data',part=>raw+=part);
    const client=createAssistantDeviceClient({origin,assistantId,deviceId,store:{get:async()=>candidate},
      http:async()=>{calls++;assert.fail('local tuple refusal must precede HTTP');}});
    const frames=[{jsonrpc:'2.0',id:1,method:'initialize'},
      {jsonrpc:'2.0',id:2,method:'tools/list'},
      {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_assistant_setup_status',arguments:{enrollmentId:randomUUID()}}},
      {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_task',arguments:{}}}];
    await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
      createMcp:async()=>({listTools:async()=>{await client.heartbeat();return [];},callTool:()=>client.heartbeat()}),
      createSetup:async()=>({status:async()=>{setupCalls++;return {state:'recovery_required'};}})});
    const messages=raw.trim().split('\n').map(JSON.parse);
    assert.ok(messages[0].result.capabilities.tools.listChanged);
    assert.equal(messages[1].result.tools.length,6);
    assert.deepEqual(messages[1].result._meta,{'trelio/assistant-setup-recovery':{
      schemaVersion:1,state:'local_identity_conflict',code:'ASSISTANT_DEVICE_REQUIRED'}});
    assert.deepEqual(messages[2].result.structuredContent,{state:'recovery_required'});
    assert.equal(messages[3].result.structuredContent.code,'ASSISTANT_DEVICE_REQUIRED');
    assert.equal(messages[3].result.isError,true);assert.equal(setupCalls,1);assert.equal(calls,0);
    assert.doesNotMatch(raw,new RegExp([assistantId,deviceId,'tda_'].join('|')),'discovery diagnostic contains no private identity/value');
  }
});

test('malformed slots, private I/O and untrusted failure flags are not setup-recovery evidence',async()=>{
  const origin='https://rebind-fixture.test',assistantId=randomUUID(),deviceId=randomUUID();
  const valid={assistantId,deviceId,credential:`tda_${'c'.repeat(43)}`,expiresAt:1};
  const cases=[
    {get:async()=>({...valid,deviceId:'malformed'}),code:'ASSISTANT_DEVICE_REQUIRED'},
    {get:async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_PRIVATE_UNAVAILABLE'});},code:'ASSISTANT_PRIVATE_UNAVAILABLE'},
    {get:async()=>valid,http:async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE',setupRecovery:'local_device_credential_mismatch'});},code:'ASSISTANT_TRANSPORT_UNAVAILABLE'},
  ];
  for(const input of cases){
    const client=createAssistantDeviceClient({origin,assistantId,deviceId,store:{get:input.get},
      http:input.http??(async()=>assert.fail('invalid private slot reached HTTP'))});
    let raw='';const output=new PassThrough();output.on('data',part=>raw+=part);
    await runAssistantSetupMcp({input:Readable.from([
      JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n',
      JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n']),output,
      createMcp:async()=>({listTools:()=>client.heartbeat()})});
    const result=JSON.parse(raw.trim().split('\n')[1]);
    assert.equal(result.error.message,input.code);assert.equal(result.result,undefined);
  }
});

test('fixed assistant MCP auth/scope rejection survives the signed child frame and leaves staged repair reachable',async()=>{
  const {RemoteMcpHostError}=await import('../host-runtime/scripts/trelio-remote-mcp.mjs');
  const {EventEmitter}=await import('node:events');
  const decode=raw=>requestCurrentAssistantRuntime({operation:'list'},{resolveLoader:async()=>'/synthetic/verified-loader.mjs',spawnProcess:()=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
    child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.write(raw);child.emit('close',0);}));return child;
  }});
  for(const [code,status]of [['REMOTE_MCP_AUTH_REJECTED',401],['REMOTE_MCP_INSUFFICIENT_SCOPE',403]]){
    const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
    const f=await stagedSetupFixture({previous}),enrollmentId=randomUUID();f.setBackground('running');
    await f.setup.begin(enrollmentId,'Windows fixture');f.approve(enrollmentId);await f.setup.finish(enrollmentId);
    let requests=0;
    const proxy=createAssistantMcpClient({...previous,store:f.store,httpRequest:async input=>{
      requests++;assert.equal(input.config.endpoint,f.origin+'/mcp/assistant');assert.equal(input.config.authentication.type,'assistant_device');
      assert.equal(input.payload.method,'initialize');throw new RemoteMcpHostError(code,'PRIVATE upstream detail');
    }});
    let workerRaw='';const workerOutput=new PassThrough();workerOutput.on('data',part=>workerRaw+=part);
    await runAssistantEntry(['request'],{input:Readable.from([JSON.stringify({operation:'list'})]),output:workerOutput,
      executeRequest:()=>proxy.listTools()});
    assert.deepEqual(JSON.parse(workerRaw),{failure:code,setupRecovery:'assistant_mcp_catalog_rejected',status});
    let raw='';const output=new PassThrough();output.on('data',part=>raw+=part);
    const frames=[{jsonrpc:'2.0',id:1,method:'initialize'}, {jsonrpc:'2.0',id:2,method:'tools/list'},
      {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_assistant_setup_status',arguments:{enrollmentId}}},
      {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_task',arguments:{}}}];
    await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
      createMcp:async()=>({listTools:()=>decode(workerRaw),callTool:()=>decode(workerRaw)}),createSetup:async()=>f.setup});
    const messages=raw.trim().split('\n').map(JSON.parse);
    assert.equal(messages[1].result.tools.length,6);
    assert.deepEqual(messages[1].result._meta,{'trelio/assistant-setup-recovery':{
      schemaVersion:1,state:'business_catalog_unavailable',code,status}});
    assert.equal(messages[2].result.structuredContent.state,'activation_pending');
    assert.equal(messages[3].result.structuredContent.code,code);assert.equal(messages[3].result.isError,true);
    assert.equal(requests,1);assert.ok(!raw.includes('PRIVATE'));assert.deepEqual(await f.host.readIdentity(),previous);
  }
  for(const frame of [{failure:'REMOTE_MCP_AUTH_REJECTED'},
    {failure:'REMOTE_MCP_AUTH_REJECTED',setupRecovery:'local_device_credential_mismatch'},
    {failure:'ASSISTANT_TRANSPORT_UNAVAILABLE',setupRecovery:'device_authorization_required',status:403}])
    await assert.rejects(decode(JSON.stringify(frame)),{code:'ASSISTANT_RUNTIME_REQUEST_UNAVAILABLE'});
});

test('pending-owner fence serializes a concurrent new pass before its HTTP boundary and blocks fresh legacy workers',async()=>{
  const previous={schemaVersion:1,origin:'https://owner-rebind.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const f=await stagedSetupFixture({previous});let issued=0,background=0,upgrades=0;
  const begin=f.setup.begin(randomUUID(),'Windows fixture');
  const admission=withAssistantNewWorkAdmission(f.host,previous,async()=>{issued++;});
  await begin;await assert.rejects(admission,{code:'ASSISTANT_HOST_REBIND_REQUIRED'});assert.equal(issued,0);
  for(const operation of ['health','health_check','background_tick']){
    const result=await executeAssistantRuntimeRequest({operation},{context:async action=>action({identity:previous},f.host),
      backgroundTick:async()=>{background++;},upgradeRuntime:async()=>{upgrades++;}});
    assert.deepEqual(result,{schemaVersion:1,state:'quiescing'});
  }
  assert.equal(background,0);assert.equal(upgrades,0);
});

test('source setup stdio accepts exact owner-ref locators only and returns closed native catalogue failures',async()=>{
  const companyId=randomUUID(),sourceId=randomUUID(),output=new PassThrough();let raw='',calls=0,contexts=0;
  output.on('data',chunk=>raw+=chunk);
  const reported=[];
  const client={identity:{origin:'https://source.test',assistantId:randomUUID(),deviceId:randomUUID()},
    readHealth:async()=>({code:'hook_review_required',revision:0,latchedCodes:['hook_review_required'],compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:null}}),
    reportHealth:async value=>reported.push(value),sourceAccounts:async selected=>{assert.equal(selected,companyId);return [{id:sourceId,
      skillId:'telegram-mtproto',projectId:null,state:'active',revision:0,provisionLocalAccount:true,executionVerified:false,label:'PRIVATE_LABEL'}];}};
  const dependencies={context:async action=>{contexts++;return action(client,{readIdentity:async()=>client.identity},{});},
    versions:()=>({pluginVersion:'3.2.3',hostRuntimeVersion:'3.10.2'}),
    proxyFor:async()=>({listTools:async()=>[],callTool:async()=>assert.fail('host setup is never delegated to human/native task MCP')}),
    prepareSource:async input=>{
      calls++;assert.equal(input.companyId,companyId);assert.equal(input.sourceId,sourceId);assert.equal(input.client,client);
      if(calls===2)throw Object.assign(new Error('PRIVATE_STORE_DETAIL'),{code:'ACCOUNT_ID_CONFLICT'});
      return {sourceId,state:'prepared',loginVerified:false};
    }};
  const tools=await executeAssistantRuntimeRequest({operation:'list'},dependencies);
  assert.deepEqual(tools,[ASSISTANT_LOCAL_CONNECTION_TOOL,ASSISTANT_SOURCE_SETUP_TOOL,ASSISTANT_EMAIL_SETUP_TOOL,ASSISTANT_EMAIL_VERIFY_TOOL,ASSISTANT_TELEGRAM_SETUP_TOOL,ASSISTANT_MAX_SETUP_TOOL,ASSISTANT_MAX_VERIFY_TOOL,ASSISTANT_ENCRYPTION_SETUP_TOOL],'the current worker owns setup discovery');
  const health=await executeAssistantRuntimeRequest({operation:'health_check'},dependencies);
  assert.equal(health.catalogRevision,assistantCatalogRevision(tools),'maintenance and discovery compare the SAME catalogue');
  const discovered=await executeAssistantRuntimeRequest({operation:'call',name:'prepare_assistant_source_account',arguments:{companyId,sourceId:null}},dependencies);
  assert.deepEqual(discovered.structuredContent,{sources:[{sourceId,skillId:'telegram-mtproto',projectId:null,state:'active',revision:0,
    provisionLocalAccount:true,executionVerified:false}]});
  assert.equal(calls,0,'listing refs never prepares an account');assert.ok(!JSON.stringify(discovered).includes('PRIVATE_LABEL'));
  const frames=[{jsonrpc:'2.0',id:1,method:'initialize'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'prepare_assistant_source_account',arguments:{companyId,sourceId}}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'prepare_assistant_source_account',arguments:{companyId,sourceId,localAccountId:randomUUID()}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'prepare_assistant_source_account',arguments:{companyId,sourceId}}}];
  const before=contexts;
  await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
    createSetup:async()=>assert.fail('the long-lived setup facade is not replaced or used for this new tool'),
    createMcp:async()=>({callTool:(name,args)=>executeAssistantRuntimeRequest({operation:'call',name,arguments:args},dependencies)})});
  const messages=raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(messages[1].result.structuredContent,{sourceId,state:'prepared',loginVerified:false});
  assert.equal(messages[2].result.structuredContent.code,'ASSISTANT_SETUP_INVALID_INPUT');
  assert.equal(messages[3].result.structuredContent.code,'ACCOUNT_ID_CONFLICT');
  assert.equal(calls,2);assert.ok(!raw.includes('PRIVATE_STORE_DETAIL'));
  assert.equal(contexts,before+2,'invalid extra fields fail before private context');
  assert.ok(reported.every(value=>value.clearedReason===undefined),'metadata setup never clears hook-review obligations');
});

test('assistant hook permits setup and blocks task tools without an installed host profile', async () => {
  for(const tool of ['mcp__trelio_assistant__get_task','mcp__plugin_trelio-digital-assistant_trelio-assistant__clear_task_control',
    'mcp__trelio_assistant__begin_assistant_setup','mcp__trelio_assistant__prepare_assistant_local_connection','mcp__trelio_assistant__prepare_assistant_source_account','mcp__trelio_assistant__configure_assistant_email_source','mcp__trelio_assistant__verify_assistant_email_source','mcp__trelio_assistant__configure_assistant_telegram_source','mcp__trelio_assistant__configure_assistant_max_source','mcp__trelio_assistant__verify_assistant_max_source','mcp__trelio_assistant__prepare_assistant_company_encryption']){
    const output=new PassThrough();let raw='';output.on('data',chunk=>raw+=chunk);
    await runAssistantEntry(['hook'],{input:Readable.from([JSON.stringify({hook_event_name:'PreToolUse',tool_name:tool})]),output,createHook:async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_HOST_NOT_CONFIGURED'});}});
    const result=JSON.parse(raw);
    assert.equal(result.hookSpecificOutput?.permissionDecision,['begin_assistant_setup','prepare_assistant_local_connection','prepare_assistant_source_account','configure_assistant_email_source','verify_assistant_email_source','configure_assistant_telegram_source','configure_assistant_max_source','verify_assistant_max_source','prepare_assistant_company_encryption'].some(name=>tool.endsWith(name))?undefined:'deny');
  }
});

test('managed encryption setup is a current-worker tool with exact company locators and no hook/login recovery claim',async()=>{
  const companyId=randomUUID(),companySlug='managed-encrypted';let contexts=0,calls=0;
  const reports=[],identity={origin:'https://enrollment.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const client={identity,readHealth:async()=>({revision:0,code:'hook_review_required',latchedCodes:['hook_review_required'],
    compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:null}}),reportHealth:async value=>reports.push(value)};
  const dependencies={context:async action=>{contexts++;return action(client,{},{});},
    proxyFor:async()=>({listTools:async()=>[],callTool:async()=>assert.fail('enrollment must not borrow task/human MCP')}),
    versions:()=>({pluginVersion:'3.2.3',hostRuntimeVersion:'3.10.2'}),prepareEncryption:async input=>{
      calls++;assert.equal(input.identity,identity);assert.equal(input.companyId,companyId);assert.equal(input.companySlug,companySlug);
      return {schemaVersion:1,state:'awaiting_company_key',companyId,businessReady:false};
    }};
  const request={operation:'call',name:ASSISTANT_ENCRYPTION_SETUP_TOOL.name,arguments:{companyId,companySlug}};
  const result=await executeAssistantRuntimeRequest(request,dependencies);
  assert.equal(result.structuredContent.state,'awaiting_company_key');assert.equal(calls,1);
  assert.ok(reports.every(row=>row.clearedReason===undefined),'public registration cannot prove hook trust or ChatGPT login');
  const before=contexts;
  for(const args of [{companyId,companySlug,ownerUserId:randomUUID()},{companyId,companySlug,registrationOnly:false},
    {companyId,companySlug,allowPendingRegistration:true},
    {companyId,companySlug,origin:'https://foreign.test'},{companyId:'bad',companySlug},{companyId,companySlug:'bad\nslug'}])
    await assert.rejects(executeAssistantRuntimeRequest({...request,arguments:args},dependencies),{code:'ASSISTANT_SETUP_INVALID_INPUT'});
  assert.equal(contexts,before,'extra authorities and malformed input refuse before private I/O');
});

test('email setup routes only exact locators under its private wait envelope and never clears hook trust',async()=>{
  const companyId=randomUUID(),sourceId=randomUUID(),identity={origin:'https://source.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const reports=[];let calls=0,contexts=0;
  const dependencies={versions:()=>({pluginVersion:'3.2.3',hostRuntimeVersion:'3.10.2'}),
    context:async(action,options)=>{contexts++;assert.equal(options.interactiveSourceSetup,true);return action({identity,
      readHealth:async()=>({code:'hook_review_required',revision:0,latchedCodes:['hook_review_required'],compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:null}}),
      reportHealth:async value=>reports.push(value)}, {withSetupLock:action=>action()}, {});},
    proxyFor:async()=>({}),configureSource:async input=>{
      calls++;assert.equal(input.companyId,companyId);assert.equal(input.sourceId,sourceId);
      return {sourceId,state:'configuration_saved',incomingEnabled:true,connectionVerified:false};
    }};
  const request={operation:'call',name:'configure_assistant_email_source',arguments:{companyId,sourceId}};
  const result=await executeAssistantRuntimeRequest(request,dependencies);
  assert.equal(result.structuredContent.state,'configuration_saved');assert.equal(calls,1);
  assert.ok(reports.every(value=>value.clearedReason===undefined));
  for(const arguments_ of [{companyId,sourceId:null},{companyId,sourceId,password:'PRIVATE'},
    {companyId,sourceId,timeoutMs:600000},{companyId,sourceId,localAccountId:randomUUID()}]){
    await assert.rejects(executeAssistantRuntimeRequest({...request,arguments:arguments_},dependencies),{code:'ASSISTANT_SETUP_INVALID_INPUT'});
  }
  assert.equal(contexts,1,'invalid arguments cannot read credentials or create a second form');assert.equal(calls,1);
});


test('Telegram setup selects only its exact native route and long input budget without clearing hook trust',async()=>{
  const companyId=randomUUID(),sourceId=randomUUID(),reports=[];let calls=0,contexts=0;
  const dependencies={versions:()=>({pluginVersion:'3.2.3',hostRuntimeVersion:'3.10.2'}),
    context:async(action,options)=>{contexts++;assert.equal(options.interactiveSourceSetup,true);return action({identity:{},
      readHealth:async()=>({code:'hook_review_required',revision:0,latchedCodes:['hook_review_required'],compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:null}}),
      reportHealth:async value=>reports.push(value)}, {withSetupLock:action=>action()}, {});},proxyFor:async()=>({}),
    configureSource:async()=>assert.fail('Telegram cannot enter email configure'),configureTelegramSource:async input=>{
      calls++;assert.equal(input.companyId,companyId);assert.equal(input.sourceId,sourceId);
      return {sourceId,state:'session_authorized',incomingVerified:false,backgroundVerified:false};
    }};
  const request={operation:'call',name:'configure_assistant_telegram_source',arguments:{companyId,sourceId}};
  assert.equal((await executeAssistantRuntimeRequest(request,dependencies)).structuredContent.state,'session_authorized');
  for(const arguments_ of [{companyId,sourceId:null},{companyId,sourceId,qr:'PRIVATE_FACTOR'},
    {companyId,sourceId,terminalPrompts:true},{companyId,sourceId,timeoutMs:600000}])
    await assert.rejects(executeAssistantRuntimeRequest({...request,arguments:arguments_},dependencies),{code:'ASSISTANT_SETUP_INVALID_INPUT'});
  assert.equal(calls,1);assert.equal(contexts,1);assert.ok(reports.every(value=>value.clearedReason===undefined));
});

test('email verification uses the normal read budget, preserves source reasons and cannot clear login/hooks',async()=>{
  const companyId=randomUUID(),sourceId=randomUUID(),reports=[];let calls=0,contexts=0;
  const dependencies={versions:()=>({pluginVersion:'3.2.3',hostRuntimeVersion:'3.10.2'}),
    context:async(action,options)=>{contexts++;assert.equal(options.interactiveSourceSetup,false);return action({identity:{},
      readHealth:async()=>({code:'hook_review_required',revision:0,latchedCodes:['hook_review_required'],compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:null}}),
      reportHealth:async value=>reports.push(value)}, {withSetupLock:action=>action()}, {});},proxyFor:async()=>({}),
    configureSource:async()=>assert.fail('verification cannot repeat configure'),verifySource:async input=>{
      calls++;assert.equal(input.companyId,companyId);assert.equal(input.sourceId,sourceId);
      throw Object.assign(new Error('PRIVATE_PROVIDER_MESSAGE'),{code:'EMAIL_MONITOR_UNAVAILABLE'});
    }};
  const request={operation:'call',name:'verify_assistant_email_source',arguments:{companyId,sourceId}};
  const result=await executeAssistantRuntimeRequest(request,dependencies);
  assert.deepEqual(result.structuredContent,{code:'EMAIL_MONITOR_UNAVAILABLE'});assert.equal(result.isError,true);
  assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  assert.ok(reports.every(value=>value.clearedReason===undefined));
  for(const arguments_ of [{companyId,sourceId:null},{companyId,sourceId,cursor:'override'},
    {companyId,sourceId,folder:'private'},{companyId,sourceId,localAccountId:randomUUID()}])
    await assert.rejects(executeAssistantRuntimeRequest({...request,arguments:arguments_},dependencies),{code:'ASSISTANT_SETUP_INVALID_INPUT'});
  assert.equal(contexts,1,'invalid selectors cannot enter the private invocation');assert.equal(calls,1);
});

test('stdio discovers live backend read schemas, notifies after pairing and keeps failures closed',async()=>{
  let paired=false,proxyCalls=0,setupCalls=0,raw='';const output=new PassThrough();output.on('data',chunk=>raw+=chunk);
  const tool={name:'get_task',description:'backend-owned',inputSchema:{type:'object'}};
  const frames=[{jsonrpc:'2.0',id:1,method:'initialize'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'finish_assistant_setup',arguments:{enrollmentId:randomUUID()}}},
    {jsonrpc:'2.0',id:4,method:'tools/list'},
    {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'get_task',arguments:{taskPass:{passId:'host'},runtimeSessionProof:{nonce:'hook'}}}},
    {jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'get_task'}},
    {jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'human_login',arguments:{}}}];
  await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
    createSetup:async()=>({finish:async()=>{setupCalls++;paired=true;return {state:'paired',businessReady:false};}}),
    createMcp:async()=>paired?{listTools:async signal=>{assert.ok(signal);return [tool];},callTool:async(name,args,signal)=>{
      assert.ok(signal);proxyCalls++;assert.equal(name,'get_task');assert.equal(args.runtimeSessionProof.nonce,'hook');
      return {content:[{type:'text',text:'ordinary task content'}],structuredContent:{tasks:[]}};
    }}:null});
  const messages=raw.trim().split('\n').map(JSON.parse);
  assert.equal(messages[0].result.capabilities.tools.listChanged,true);
  assert.equal(messages[1].result.tools.length,6);
  assert.equal(messages[3].method,'notifications/tools/list_changed');
  assert.deepEqual(messages[4].result.tools.at(-1),tool);
  assert.equal(messages[5].result.content[0].text,'ordinary task content');
  assert.equal(messages[6].result.isError,true);assert.equal(messages[7].result.isError,true);
  assert.equal(proxyCalls,1);assert.equal(setupCalls,1);
  raw='';await runAssistantSetupMcp({input:Readable.from([JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n',
    JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n']),output,
    createMcp:async()=>{throw new Error('PRIVATE DEVICE DETAIL');}});
  assert.ok(raw.includes('ASSISTANT_SETUP_UNAVAILABLE'));assert.ok(!raw.includes('PRIVATE'));
});

test('the same stdio process announces a changed signed-worker catalogue without restarting or repeated notices',async()=>{
  const input=new PassThrough(),output=new PassThrough(),messages=[];let text='',tick;
  output.on('data',chunk=>{
    text+=chunk.toString();for(;;){const newline=text.indexOf('\n');if(newline<0)break;
      messages.push(JSON.parse(text.slice(0,newline)));text=text.slice(newline+1);}
  });
  let tools=[{name:'get_task',description:'first catalogue',inputSchema:{type:'object'}}];
  let health={code:'ready',catalogRevision:assistantCatalogRevision(tools)};
  const done=runAssistantSetupMcp({input,output,
    createMcp:async()=>({listTools:async()=>tools}),maintenanceRequest:async()=>health,
    scheduleMaintenance:callback=>{tick=callback;return setInterval(()=>{},1_000_000);}});
  const request=async(id,method)=>{
    input.write(JSON.stringify({jsonrpc:'2.0',id,method})+'\n');
    for(let n=0;n<100;n++){if(messages.some(message=>message.id===id))return;await new Promise(resolve=>setImmediate(resolve));}
    assert.fail('synthetic stdio response did not complete');
  };
  try {
    await request(1,'initialize');await request(2,'tools/list');
    await tick();assert.equal(messages.length,2,'unchanged metadata needs no refresh');
    tools=[...tools,{name:'complete_assistant_pass',description:'new signed worker capability',inputSchema:{type:'object'}}];
    health={code:'ready',catalogRevision:assistantCatalogRevision(tools)};
    await tick();assert.equal(messages.at(-1).method,'notifications/tools/list_changed');
    const count=messages.length;await tick();assert.equal(messages.length,count);
    await request(3,'tools/list');assert.equal(messages.at(-1).result.tools.at(-1).name,'complete_assistant_pass');
    health={code:'runtime_update_failed'};await tick();assert.equal(messages.length,count+1,'a failed probe cannot discard the known catalogue');
  } finally {input.end();await done;}
});


test('production host composes real SQLite, fresh private calls and the native adapter, but pairing cannot open business work',async()=>{
  const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const companyId=randomUUID(),memberId=randomUUID(),taskId=randomUUID(),bindingId=randomUUID();
  const execution={state:'ready',configuration:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1}};
  const {assistantTaskStorageDirectory}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const taskConfig=path.join(os.tmpdir(),'synthetic-assistant-host-'+randomUUID());
  let businessReady=false,starts=0,contextCalls=0,databaseClosed=0,reported=0;
  let currentIdentity=identity;
  const sourceId=randomUUID(),sourceAccountId=randomUUID();let sourceInventories=0,sourcePolls=0,sourceHealthReads=0;const sourceReports=[];
  const client={identity,heartbeat:async()=>({}),companies:async()=>[{companyId,memberId}],
    sourceAccounts:async selected=>{sourceInventories++;assert.equal(selected,companyId);return [{id:sourceId,companyId,deviceId:identity.deviceId,
      localAccountId:sourceAccountId,projectId:null,skillId:'email-imap-smtp',state:'active',revision:0,executionVerified:false}];},
    readSourceHealth:async(company,source)=>{
      sourceHealthReads++;assert.equal(company,companyId);assert.equal(source,sourceId);assert.equal(sourcePolls,sourceHealthReads-1);
      return {revision:0,sourceRevision:0,code:'not_checked'};
    },reportSourceHealth:async input=>{
      assert.equal(sourcePolls,2);sourceReports.push(input);assert.equal(input.sourceId,sourceId);
      assert.equal(input.companyId,companyId);assert.equal(input.expectedRevision,0);assert.equal(input.sourceRevision,0);
      assert.equal(input.code,'ready');return {revision:1,sourceRevision:0,code:'ready'};
    },reportHealth:async()=>assert.fail('source observation cannot clear global health'),
    tasks:async()=>({bindings:[{id:bindingId,taskId,state:'accepted',revision:0}],nextCursor:null}),
    task:async()=>({id:bindingId,taskId,state:'accepted',revision:0,execution,hostState:'this_device'}),
    poll:async()=>({events:[],nextCursor:'0',hasMore:false}),
    claimTaskHost:async input=>({bindingId,provisionId:input.provisionId,threadId:null}),
    reportSchedule:async input=>{reported++;return {sequence:input.sequence};},
  };
  const native={provision:async(input,options)=>{
    starts++;assert.deepEqual(input.execution,execution.configuration);
    assert.equal(input.cwd,path.join(assistantTaskStorageDirectory(taskConfig,{...identity,companyId,taskId}),'chat'));
    options.startInvocation();const threadId=randomUUID();options.onThreadStarted(threadId);
    return {state:'completed',threadId,receipt:`codex:${threadId}:${randomUUID()}`};
  },run:async()=>assert.fail('no business pass in this fixture'),readDelivery:async()=>({state:'uncertain'})};
  const database=new DatabaseSync(':memory:');
  const host=await createAssistantRuntimeHost({context:async action=>{
    contextCalls++;return action({...client,identity:currentIdentity},{readActivePass:async()=>null,readIdentity:async()=>currentIdentity,readActivation:async()=>null,withSetupLock:action=>action()});
  },dependencies:{directory:taskConfig,
    readSourceMonitor:async(source,signal)=>{sourcePolls++;assert.ok(signal);assert.deepEqual(source,{companyId,projectId:null,
      skillId:'email-imap-smtp',sourceId,sourceRevision:0,accountId:sourceAccountId,cursor:sourcePolls===1?null:'email-history',initialUnread:true});
      return {baselineOnly:sourcePolls===1,events:[],nextCursor:sourcePolls===1?'email-baseline':'email-end',hasMore:false,
        ...(sourcePolls===1?{initialUnreadCursor:'email-history'}:{initialUnreadBackfill:true})};},
    ensureDirectory:async()=>{},openDatabase:async directory=>{
      assert.equal(path.basename(directory),identity.deviceId);
      return {database,close:async()=>{databaseClosed++;database.close();}};
    },native,timeZone:'Europe/Moscow',readStatus:async()=>({structuredContent:{schemaVersion:1,
      assistantUserId:identity.assistantId,deviceId:identity.deviceId,authorizedByUserId:memberId,businessReady,
      availableCapabilities:['task_context','task_mutations','task_pass_outcome','workspace_execution','owner_decisions','background_service']}})}});
  try {
    await host.coordinator.pollOnce();
    assert.equal(sourcePolls,1);assert.equal(sourceInventories,3,'source inventory and both sides of the read re-enter the protected context');
    assert.equal(sourceHealthReads,1);assert.equal(sourceReports.length,0,'an unfinished initial history cannot claim the whole source is ready');
    await assert.rejects(host.coordinator.workOnce(),error=>error.code==='ASSISTANT_COORDINATOR_SETUP_REQUIRED');
    assert.equal(starts,0,'a running source poll and configured native adapter do not enable model work');
    businessReady=true;
    await host.coordinator.workOnce();
    assert.equal(starts,1);
    await host.coordinator.pollOnce();
    assert.equal(sourceHealthReads,2);assert.equal(sourceReports.length,1,'production composition reports ready only after the same history stream completes');
    assert.equal(reported,1);
    assert.equal(host.coordinator.status().length,1);
    assert.ok(contextCalls>=8,'operations re-enter the private context rather than retaining its token/worker');
    currentIdentity={...identity,deviceId:randomUUID()};
    await assert.rejects(host.coordinator.workOnce(),error=>error.code==='ASSISTANT_HOST_REBIND_REQUIRED');
    assert.equal(starts,1,'re-pairing cannot silently reuse a previous device database');
  } finally {await host.close();await host.close();}
  assert.equal(databaseClosed,1);
});

test('business readiness is exact dedicated identity and complete capabilities, not a backend boolean alone',()=>{
  const identity={assistantId:randomUUID(),deviceId:randomUUID()};
  const base={schemaVersion:1,assistantUserId:identity.assistantId,deviceId:identity.deviceId,
    authorizedByUserId:randomUUID(),businessReady:true,availableCapabilities:['task_context']};
  assert.equal(assistantCoordinatorReadiness({structuredContent:base},identity),false);
  assert.throws(()=>assistantCoordinatorReadiness({structuredContent:{...base,deviceId:randomUUID()}},identity),/ADMISSION_INVALID/);
  assert.throws(()=>assistantCoordinatorReadiness({structuredContent:{...base,authorizedByUserId:identity.assistantId}},identity),/ADMISSION_INVALID/);
  assert.equal(assistantCoordinatorReadiness({isError:true,structuredContent:base},identity),false);
});

test('production native health reports survive the delivery fence; only fresh confirmed authentication clears its own latch',async()=>{
  for(const scenario of ['missing','confirmed','metadata','unknown','report_failed','report_conflict','rebound','unrelated']){
    const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()};
    const companyId=randomUUID(),memberId=randomUUID(),taskId=randomUUID(),bindingId=randomUUID();
    const reports=[];let currentIdentity=identity,contactReads=0,starts=0,schedules=0;
    const database=new DatabaseSync(':memory:');
    const client={identity,heartbeat:async()=>({}),companies:async()=>[{companyId,memberId}],
      tasks:async()=>({bindings:[{id:bindingId,taskId,state:'accepted',revision:0}],nextCursor:null}),
      task:async()=>({id:bindingId,taskId,state:'accepted',revision:0,hostState:'this_device',
        execution:{state:'ready',configuration:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1}}}),
      poll:async()=>({events:[],nextCursor:'0',hasMore:false}),
      claimTaskHost:async input=>({bindingId,provisionId:input.provisionId,threadId:null}),
      reportSchedule:async input=>{schedules++;return {sequence:input.sequence};},
      readHealth:async()=>{contactReads++;return {code:scenario==='unrelated'?'plugin_update_required':'codex_auth_required',revision:7,
        latchedCodes:['hook_review_required','codex_auth_required']};},
      reportHealth:async input=>{
        reports.push(input);
        if(scenario==='report_failed')throw new Error('PRIVATE diagnostic outage');
        if(scenario==='report_conflict')throw Object.assign(new Error('PRIVATE CAS race'),{code:'ASSISTANT_HEALTH_CHANGED'});
        return {};
      },
    };
    const host=await createAssistantRuntimeHost({context:async action=>action({...client,identity:currentIdentity},{readActivePass:async()=>null,readIdentity:async()=>currentIdentity,readActivation:async()=>null,withSetupLock:action=>action()}),
      dependencies:{directory:path.join(os.tmpdir(),'synthetic-auth-health-'+randomUUID()),ensureDirectory:async()=>{},
        openDatabase:async()=>({database,close:async()=>database.close()}),timeZone:'UTC',
        readStatus:async()=>({structuredContent:{schemaVersion:1,assistantUserId:identity.assistantId,deviceId:identity.deviceId,
          authorizedByUserId:memberId,businessReady:true,
          availableCapabilities:['task_context','task_mutations','task_pass_outcome','workspace_execution','owner_decisions','background_service']}}),
        native:{readDelivery:async()=>({state:'uncertain'}),run:async()=>assert.fail('this fixture provisions only'),
          provision:async(_input,options)=>{
            if(scenario==='missing')throw Object.assign(new Error('PRIVATE native account'),{code:'ASSISTANT_CODEX_AUTH_REQUIRED'});
            if(scenario==='unknown')throw Object.assign(new Error('Please sign in PRIVATE'),{code:'ASSISTANT_CODEX_READ_UNAVAILABLE'});
            options.startInvocation();starts++;const threadId=randomUUID();options.onThreadStarted(threadId);
            if(scenario==='rebound')currentIdentity={...identity,deviceId:randomUUID()};
            if(scenario!=='metadata')await options.onAuthenticationConfirmed();
            return {state:'completed',threadId,receipt:`codex:${threadId}:${randomUUID()}`};
          }}}});
    try {
      await host.coordinator.pollOnce();
      if(['missing','unknown','rebound'].includes(scenario)){
        await assert.rejects(host.coordinator.workOnce());
        assert.equal(schedules,0,'a diagnostic report never advances the business schedule');
      }else{
        assert.equal((await host.coordinator.workOnce()).state,'completed');
        await host.coordinator.pollOnce();assert.equal(schedules,1);
      }
      if(['metadata','unknown','rebound'].includes(scenario)){
        assert.equal(contactReads,0);assert.equal(reports.length,0,'metadata/unknown/rebound identity cannot recover or diagnose login');
      }else if(scenario==='unrelated'){
        assert.equal(contactReads,1);assert.equal(reports.length,0,'a completed native turn cannot clear an unrelated plugin incident');
      }else{
        assert.equal(contactReads,1);assert.equal(reports.length,1,'no diagnostic retry after an uncertain response or CAS conflict');
        assert.equal(reports[0].expectedRevision,7);assert.match(reports[0].clientRequestId,/^[0-9a-f-]{36}$/u);
        assert.equal(reports[0].code,scenario==='missing'?'codex_auth_required':'ready');
        assert.equal(reports[0].clearedReason,scenario==='missing'?undefined:'codex_auth_required',
          'the unrelated hook-review latch is never cleared');
        assert.ok(!JSON.stringify(reports).includes('PRIVATE'));
      }
      assert.equal(starts,['missing','unknown'].includes(scenario)?0:1);
    }finally{await host.close();}
  }
});

test('one background worker keeps model-free polling alive during a single native pass and closes after settlement',async()=>{
  let resolveWork,workCalls=0,pollCalls=0,waits=0,closed=0;
  const work=new Promise(resolve=>{resolveWork=resolve;});
  const result=await runAssistantBackgroundTick({pluginMaintenance:async()=>({state:"current"}),createHost:async()=>({coordinator:{
    pollOnce:async()=>{pollCalls++;},workOnce:()=>{workCalls++;return work;},dispatchStatus:async()=>({state:'idle'}),
  },close:async()=>{closed++;}}),wait:async(milliseconds)=>{
    assert.equal(milliseconds,30_000);if(++waits===2)resolveWork({state:'completed'});
  }});
  assert.equal(workCalls,1);assert.ok(pollCalls>=2);assert.equal(closed,1);
  assert.deepEqual(result,{schemaVersion:1,state:'checked',dispatch:{state:'idle'}});
});

test('background tick projects a company model block instead of reporting a false idle',async()=>{
  const dispatch={schemaVersion:1,state:'blocked',reasons:['model_selection_required'],pendingEvents:1};let closed=0;
  const result=await runAssistantBackgroundTick({pluginMaintenance:async()=>({state:"current"}),createHost:async()=>({coordinator:{pollOnce:async()=>{},
    workOnce:async()=>null,dispatchStatus:async()=>dispatch},close:async()=>{closed++;}})});
  assert.deepEqual(result,{schemaVersion:1,state:'blocked',dispatch});assert.equal(closed,1);
});

test('paired background dispatch status is SELECT-only, preserves the journal and fails closed for missing/incomplete/foreign state',async t=>{
  const {openAssistantDatabase}=await import('../host-runtime/scripts/trelio-assistant-private.mjs');
  const {createAssistantCoordinator}=await import('../host-runtime/scripts/trelio-assistant-coordinator.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-dispatch-status-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID(),memberId=randomUUID();
  const execution={state:'unconfigured',configuration:null};let current=identity,reads=0,opens=0;
  const company={companyId,memberId,execution};
  const client={identity,companies:async()=>{reads++;return [company];},poll:()=>assert.fail('status cannot poll'),
    tasks:()=>assert.fail('status cannot reconcile bindings'),acknowledge:()=>assert.fail('status cannot ACK'),claimTaskHost:()=>assert.fail('status cannot claim'),
    reportHealth:()=>assert.fail('read-only status cannot clear an auth/hook health latch')};
  const context=async action=>action(client,{readIdentity:async()=>current});
  const options={context,configurationDirectory:root,openDatabase:async(...args)=>{opens++;return openAssistantDatabase(...args);}};
  let result=await readProductionAssistantDispatchStatus(options);
  assert.equal(result.state,'blocked');assert.deepEqual(result.reasons,['model_selection_required','not_checked']);assert.equal(result.pendingEvents,null);
  await assert.rejects(fs.stat(path.join(root,'digital-assistants')),{code:'ENOENT'},'status cannot initialize a missing queue');
  const directory=path.join(root,'digital-assistants','runtime',identity.assistantId,identity.deviceId);
  const opened=await openAssistantDatabase(directory);
  const coordinator=createAssistantCoordinator({database:opened.database,client,native:{ready:async()=>true},workspaceForTask:async()=>root,timeZone:'UTC'});
  await coordinator.close();await opened.close();
  const before=await fs.readFile(path.join(directory,'inbox.sqlite'));
  result=await readProductionAssistantDispatchStatus(options);
  assert.equal(result.state,'blocked');assert.equal(result.pendingEvents,0);assert.deepEqual(result.reasons,['model_selection_required']);
  assert.deepEqual(await fs.readFile(path.join(directory,'inbox.sqlite')),before);
  execution.state='ready';execution.configuration={modelId:'gpt-6.1-sol',effortLevel:'xhigh',revision:2};
  let nativeReads=0;
  for(const nativeResult of [true,false,'auth','unknown','malformed']){
    const status=await readProductionAssistantDispatchStatus({...options,readExecutionAvailability:async(choices)=>{
      nativeReads++;assert.deepEqual(choices,[execution.configuration]);
      if(nativeResult==='auth')throw Object.assign(new Error('PRIVATE'),{code:'ASSISTANT_CODEX_AUTH_REQUIRED'});
      if(nativeResult==='unknown')throw new Error('PRIVATE');
      return nativeResult==='malformed'?'PRIVATE':[nativeResult];
    }});
    assert.equal(status.nativeExecution.state,nativeResult===true?'model_supported':nativeResult===false?'model_unavailable'
      :nativeResult==='auth'?'auth_required':'unknown');
    assert.equal(status.state,nativeResult===true?'idle':[false,'auth'].includes(nativeResult)?'blocked':'unknown');
    assert.ok(!JSON.stringify(status).includes('PRIVATE'));
  }
  assert.equal(nativeReads,5);execution.state='unconfigured';execution.configuration=null;
  const unsupported=await openAssistantDatabase(directory);
  unsupported.database.exec('UPDATE assistant_inbox_meta SET version=99');await unsupported.close();
  const unsupportedBytes=await fs.readFile(path.join(directory,'inbox.sqlite'));
  result=await readProductionAssistantDispatchStatus(options);
  assert.equal(result.state,'unknown');assert.equal(result.pendingEvents,null,'unsupported schema cannot be interpreted as an empty queue');
  assert.deepEqual(await fs.readFile(path.join(directory,'inbox.sqlite')),unsupportedBytes,'diagnostics never migrate or repair unsupported state');
  const restored=await openAssistantDatabase(directory);restored.database.exec('UPDATE assistant_inbox_meta SET version=13');await restored.close();
  const beforeDenied=opens;client.companies=async()=>{throw Object.assign(new Error('PRIVATE DETAIL'),{code:'ASSISTANT_ACCESS_DENIED'});};
  result=await readProductionAssistantDispatchStatus(options);assert.equal(result.state,'unknown');assert.equal(result.pendingEvents,null);
  assert.equal(opens,beforeDenied,'native denial must precede any journal read');
  client.companies=async()=>[company];current={...identity,deviceId:randomUUID()};
  result=await readProductionAssistantDispatchStatus(options);assert.equal(result.state,'unknown');assert.equal(result.pendingEvents,null);
  assert.ok(!JSON.stringify(result).includes(companyId));assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(reads>=2);
});

test('background supervisor resolves a fresh worker only between cycles and preserves uncertain delivery recovery',async()=>{
  const controller=new AbortController(),operations=[];let waits=0,reports=0,icons=0,iconsClosed=0;
  const identity={assistantId:randomUUID(),deviceId:randomUUID()};
  const result=await runAssistantBackground({signal:controller.signal,readHost:async()=>({identity,activation:null}),verifyRegistration:async()=>{},startConsoleIcon:async actual=>{assert.deepEqual(actual,identity);icons++;return {close:async()=>{iconsClosed++;}};},request:async(request,options)=>{
    operations.push(request.operation);assert.equal(options.signal.aborted,false);
    if(request.operation==='background_tick'){
      assert.equal(options.timeoutMs,35*60_000);
      if(waits===0)throw Object.assign(new Error('private transport failure'),{code:'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
    }
  },reportFailure:async error=>{assert.equal(error.code,'ASSISTANT_CODEX_DELIVERY_UNCERTAIN');reports++;},
  wait:async(milliseconds)=>{assert.equal(milliseconds,300_000);if(++waits===2)controller.abort();}});
  assert.deepEqual(operations,['health','background_tick','health','background_tick']);
  assert.equal(reports,1);assert.equal(icons,1);assert.equal(iconsClosed,1);assert.deepEqual(result,{schemaVersion:1,state:'stopped'});
});


test('fresh supervisor exits before maintenance when replacement is pending or its OS marker is stale',async()=>{
  const identity={assistantId:randomUUID(),deviceId:randomUUID()};let calls=0,checks=0;
  const pending=await runAssistantBackground({readHost:async()=>({identity,activation:{stage:'pending_owner'}}),
    verifyRegistration:async()=>{checks++;},request:async()=>{calls++;}});
  assert.equal(pending.reason,'replacement_pending');assert.equal(checks,0);assert.equal(calls,0);
  await assert.rejects(runAssistantBackground({readHost:async()=>({identity,activation:null}),
    verifyRegistration:async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_BACKGROUND_CONFLICT'});},request:async()=>{calls++;}}),{code:'ASSISTANT_BACKGROUND_CONFLICT'});
  assert.equal(calls,0,'an old scheduled registration never drives a new identity');
});

test('background composition validates timezone before private DB I/O and closes the opened DB after an adapter failure',async()=>{
  const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()};
  let opened=0,closed=0;
  const context=async action=>action({identity},{});
  const dependencies={directory:path.join(os.tmpdir(),'synthetic-assistant-'+randomUUID()),ensureDirectory:async()=>{},
    openDatabase:async()=>{opened++;const database=new DatabaseSync(':memory:');
      return {database,close:async()=>{closed++;database.close();}};},native:{}};
  await assert.rejects(createAssistantRuntimeHost({context,dependencies:{...dependencies,timeZone:'Not/A-Timezone'}}),/INVALID_TIMEZONE/);
  assert.equal(opened,0);
  await assert.rejects(createAssistantRuntimeHost({context,dependencies:{...dependencies,timeZone:'UTC'}}),/SETUP_REQUIRED/);
  assert.equal(opened,1);assert.equal(closed,1);
});

test('a source failure during native work is retained after settlement without repeating or cancelling the pass',async()=>{
  let finishWork,polls=0,works=0,closes=0,waits=0;
  const work=new Promise(resolve=>{finishWork=resolve;});
  const failure=Object.assign(new Error('private source detail'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});
  await assert.rejects(runAssistantBackgroundTick({pluginMaintenance:async()=>({state:"current"}),createHost:async()=>({coordinator:{
    pollOnce:async()=>{if(++polls>1)throw failure;},workOnce:()=>{works++;return work;},
  },close:async()=>{closes++;}}),wait:async()=>{if(++waits===2)finishWork({state:'completed'});}}),error=>error===failure);
  assert.equal(works,1);assert.equal(closes,1);
});

const workspacePlan=()=>({prepared:true,scope:{assistantUserId:randomUUID(),deviceId:randomUUID(),companyId:randomUUID(),taskId:randomUUID(),passId:randomUUID()},
  localAction:{schemaVersion:1,operation:'open',parameters:{workspaceId:randomUUID(),runId:randomUUID(),runtimeSessionId:randomUUID()}}});

test('stdio retains the same finish registry across fresh per-call native proxies',async t=>{
  const {createForwardingAssistantMcp,createAssistantWorkspaceExecutor}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-stdio-finish-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'digital-assistants'),{recursive:true});
  await fs.writeFile(path.join(root,'digital-assistants','identity.json'),'{}');
  const plan=workspacePlan(),runIdentity={workspaceId:plan.localAction.parameters.workspaceId,runId:plan.localAction.parameters.runId};
  let settle,launches=0,statusReads=0,factories=0,proxies=0,requests=0,stops=0,deny=false;
  const finished=new Promise(resolve=>{settle=resolve;});
  const createWorkspace=async()=>{
    factories++;
    const executor=await createAssistantWorkspaceExecutor({configDirectory:root,finishOptions:{waitMs:2},
      runPlan:async raw=>{if(raw.localAction.operation==='status'){
          statusReads++;assert.deepEqual(raw.localAction.parameters,{});
          return {schemaVersion:1,operation:'status',stdout:'synthetic exact local status'};
        }assert.equal(raw.localAction.operation,'finish');launches++;await finished;
        return {schemaVersion:1,operation:'finish',stdout:'synthetic accepted receipt'};}});
    const stop=executor.stop;executor.stop=()=>{stops++;stop();};return executor;
  };
  const input=new PassThrough(),output=new PassThrough(),messages=[],waiters=new Map();let buffered='';
  output.on('data',chunk=>{buffered+=chunk;let at;while((at=buffered.indexOf('\n'))>=0){
    const value=JSON.parse(buffered.slice(0,at));buffered=buffered.slice(at+1);messages.push(value);
    waiters.get(value.id)?.(value);waiters.delete(value.id);
  }});
  const send=(id,method,params)=>new Promise(resolve=>{waiters.set(id,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');});
  const done=runAssistantSetupMcp({input,output,createWorkspace,preservePlugin:async()=>null,
    createMcp:async options=>{proxies++;return createForwardingAssistantMcp({...options,configurationDirectory:root,
      // The fallback reproduces the former per-request executor lifetime. A
      // real stdio owner must supply one shared factory, while every native
      // request still passes this fresh proxy/authorisation boundary.
      createWorkspace:options.createWorkspace??createWorkspace,
      request:async request=>{requests++;if(deny)throw new AssistantTransportError('ASSISTANT_ACCESS_DENIED',403);return {content:[],structuredContent:{...plan,
        localAction:{schemaVersion:1,...request.arguments}}};}});}});
  t.after(async()=>{settle();input.end();await done;});
  await send(1,'initialize');
  const started=await send(2,'tools/call',{name:'continue_assistant_workspace_action',arguments:{operation:'finish',runIdentity,
    parameters:{summary:'Synthetic result',evidence:['Synthetic evidence'],nextAction:'Synthetic next step',taskOutcome:'no_status_change'}}});
  assert.equal(started.result.structuredContent.state,'running');
  deny=true;
  const refused=await send(3,'tools/call',{name:'continue_assistant_workspace_action',arguments:started.result.structuredContent.nextCall.arguments});
  assert.equal(refused.result.structuredContent.code,'ASSISTANT_ACCESS_DENIED');
  assert.equal(refused.result.isError,true,'retained progress cannot bypass a fresh native refusal');
  assert.equal(launches,1);
  deny=false;
  settle();
  const polled=await send(4,'tools/call',{name:'continue_assistant_workspace_action',arguments:started.result.structuredContent.nextCall.arguments});
  assert.equal(polled.result.structuredContent.state,'completed');
  assert.equal(polled.result.structuredContent.operationId,started.result.structuredContent.operationId);
  assert.equal(launches,1,'poll never starts another writer');
  assert.equal(requests,3,'poll repeats the native authorisation boundary');
  assert.equal(proxies,3,'the private/native proxy is not retained');
  assert.equal(factories,1,'the host-lifetime finish registry is retained');
  const unknown=await send(5,'tools/call',{name:'continue_assistant_workspace_action',arguments:{
    schemaVersion:1,operation:'status',runIdentity,parameters:{finishOperationId:randomUUID()}}});
  assert.equal(unknown.result.isError,true);
  const recovery=unknown.result.structuredContent.recovery;
  assert.equal(unknown.result.structuredContent.code,'TRELIO_WORKSPACE_FINISH_UNKNOWN');
  assert.equal(recovery.readOnly,true);assert.equal(statusReads,0,'unknown handle only prepares a fresh read');
  assert.deepEqual(recovery.nextCall,{tool:'continue_assistant_workspace_action',arguments:{schemaVersion:1,
    operation:'status',parameters:{},runIdentity}});
  assert.match(unknown.result.content[0].text,/Do not poll it again/);
  assert.doesNotMatch(JSON.stringify(recovery),/passId|runtimeSessionProof|finishOperationId|workingDirectory/);
  deny=true;
  const deniedRecovery=await send(6,'tools/call',{name:recovery.nextCall.tool,arguments:recovery.nextCall.arguments});
  assert.equal(deniedRecovery.result.structuredContent.code,'ASSISTANT_ACCESS_DENIED');
  assert.equal(deniedRecovery.result.structuredContent.recovery,undefined);assert.equal(statusReads,0);
  deny=false;
  const observed=await send(7,'tools/call',{name:recovery.nextCall.tool,arguments:recovery.nextCall.arguments});
  assert.equal(observed.result.structuredContent.operation,'status');assert.equal(statusReads,1);
  assert.equal(launches,1,'neither the hint nor the actual read repeats finish');
  assert.equal(requests,6,'the suggested read has its own fresh native authorisation');
  input.end();await done;assert.equal(stops,1,'EOF stops only this host heartbeat manager');
});

test('assistant Workspace plan rejects unreviewed paths/operations before private or child access',async()=>{
  const {validateAssistantWorkspacePlan,executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const raw=workspacePlan(),valid=await validateAssistantWorkspacePlan(raw);
  assert.equal(valid.runIdentity.runId,raw.localAction.parameters.runId);
  for(const invalid of [{...raw,credential:'PRIVATE'}, {...raw,scope:{...raw.scope,companyId:'../escape'}},
    {...raw,localAction:{...raw.localAction,parameters:{...raw.localAction.parameters,directory:'/other/user'}}},
    ...['login','secret_exec','restore','skill_run','clean'].map(operation=>({...raw,localAction:{...raw.localAction,operation}}))]) {
    await assert.rejects(executeAssistantWorkspacePlan(invalid,{withProfile:async()=>assert.fail('invalid action touched private storage')}));
  }
  raw.localAction.parameters.runId=randomUUID();
  assert.notEqual(valid.runIdentity.runId,raw.localAction.parameters.runId,'plan is snapshotted before async I/O');
});

test('assistant Workspace continuation uses fixed signed child and stdin; unknown outcome never retries',async()=>{
  const {runAssistantWorkspaceProcess}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const plan=workspacePlan();let launches=0;
  const result=await runAssistantWorkspaceProcess(plan,{resolveLoader:async()=>'/verified/loader.mjs',runProcess:async(executable,args,options)=>{
    launches++;assert.equal(executable,process.execPath);assert.deepEqual(args,['/verified/loader.mjs','bridge','assistant','workspace']);
    assert.deepEqual(JSON.parse(options.input),plan);assert.ok(!args.includes(JSON.stringify(plan)));
    return {stdout:JSON.stringify({schemaVersion:1,operation:'open',stdout:'opened native Workspace'}),stderr:''};
  }});
  assert.equal(result.stdout,'opened native Workspace');assert.equal(launches,1);
  await assert.rejects(runAssistantWorkspaceProcess(plan,{resolveLoader:async()=>'/verified/loader.mjs',runProcess:async()=>{
    launches++;throw {stderr:'PRIVATE CREDENTIAL AND STACK'};
  }}),error=>error.code==='ASSISTANT_WORKSPACE_OUTCOME_REVIEW_REQUIRED' && !error.message.includes('PRIVATE'));
  assert.equal(launches,2);
  await assert.rejects(runAssistantWorkspaceProcess(plan,{resolveLoader:async()=>'/verified/loader.mjs',runProcess:async()=>{
    throw {stderr:JSON.stringify({code:'__proto__'})};
  }}),error=>error.code==='ASSISTANT_WORKSPACE_OUTCOME_REVIEW_REQUIRED');
  await assert.rejects(runAssistantWorkspaceProcess(plan,{resolveLoader:async()=>'/verified/loader.mjs',runProcess:async()=>{
    throw {stderr:JSON.stringify({code:'AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED'})};
  }}),error=>error.code==='AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED');
  await assert.rejects(runAssistantWorkspaceProcess(plan,{resolveLoader:async()=>'/verified/loader.mjs',runProcess:async()=>{
    throw {stderr:JSON.stringify({code:'TRELIO_RUNTIME_HOOK_REQUIRED',reason:'expired'})};
  }}),error=>error.code==='TRELIO_RUNTIME_HOOK_REQUIRED' && error.reason==='expired');
});

test('encrypted Workspace descriptors survive facade, coordinator, real child pipe and automatic heartbeat',async t=>{
  const {runAssistantWorkspaceProcess,createAssistantWorkspaceExecutor,createForwardingAssistantMcp}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const {spawnSync}=await import('node:child_process');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-plan-pipe-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const moduleUrl=new URL('../host-runtime/scripts/trelio-assistant-entry.mjs',import.meta.url).href;
  // Real parent serialization -> real child stdin/worker parser -> strict plan
  // validator. The child stops before any HTTP/private authority or execution;
  // this is a pipe regression, not evidence of a provider/business E2E.
  const code=`import {runAssistantWorkspaceWorker,validateAssistantWorkspacePlan} from ${JSON.stringify(moduleUrl)};
    await runAssistantWorkspaceWorker({executePlan:async raw=>{
      const plan=await validateAssistantWorkspacePlan(raw);
      return {schemaVersion:1,operation:plan.localAction.operation,
        stdout:JSON.stringify({descriptor:raw.encryptedInspection??raw.encryptedLifecycle,sentinel:'validated-real-child'})};
    }});`;
  let launches=0;const observed=[];
  const runProcess=async(_executable,_args,options)=>{
    launches++;observed.push(JSON.parse(options.input));
    const env={...process.env,HOME:root,USERPROFILE:root,CODEX_HOME:path.join(root,'.codex'),APPDATA:root,LOCALAPPDATA:root};
    delete env.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,['--input-type=module','-e',code],{
      input:options.input,encoding:'utf8',env,timeout:10_000,maxBuffer:1024*1024});
    assert.equal(child.status,0,child.stderr);return {stdout:child.stdout,stderr:child.stderr};
  };
  for(const operation of ['inspect','checkpoint']){
    const plan=workspacePlan(),identity={workspaceId:plan.localAction.parameters.workspaceId,runId:plan.localAction.parameters.runId};
    const descriptor={schemaVersion:1,companyId:plan.scope.companyId,companySlug:'synthetic',
      workspaceId:identity.workspaceId,requestOrigin:'https://e2ee.trelio.ru'};
    plan.localAction=operation==='inspect'?{schemaVersion:1,operation,parameters:{workspaceId:identity.workspaceId}}
      :{schemaVersion:1,operation,runIdentity:identity,parameters:{type:'draft',summary:'Synthetic fixture'}};
    plan[operation==='inspect'?'encryptedInspection':'encryptedLifecycle']=descriptor;
    let scheduled;
    const executor=await createAssistantWorkspaceExecutor({configDirectory:root,
      heartbeatOptions:{scheduleTimer:callback=>(scheduled=callback),cancelTimer:()=>{}},
      runPlan:(raw,options)=>runAssistantWorkspaceProcess(raw,{...options,resolveLoader:async()=>'/verified/loader.mjs',runProcess})});
    await fs.mkdir(path.join(root,'digital-assistants'),{recursive:true});
    await fs.writeFile(path.join(root,'digital-assistants','identity.json'),'{}');
    let selected=plan;
    const facade=await createForwardingAssistantMcp({configurationDirectory:root,createWorkspace:async()=>executor,
      request:async()=>({content:[],structuredContent:selected})});
    try{
      if(operation==='checkpoint'){
        selected={...plan,localAction:{...workspacePlan().localAction,parameters:{...identity,runtimeSessionId:randomUUID()}}};
        await facade.callTool('continue_assistant_workspace_action',{operation:'open'});
        selected=plan;
      }
      const result=await facade.callTool('continue_assistant_workspace_action',{operation});
      assert.deepEqual(JSON.parse(result.structuredContent.stdout),{descriptor,sentinel:'validated-real-child'});
      if(operation==='checkpoint'){
        await scheduled();
        assert.equal(observed.at(-1).localAction.operation,'heartbeat');
        assert.deepEqual(observed.at(-1).encryptedLifecycle,descriptor,'automatic renewal retains the native routing too');
      }
    }finally{executor.stop();}
    const before=launches;
    await assert.rejects(runAssistantWorkspaceProcess({...plan,[operation==='inspect'?'encryptedInspection':'encryptedLifecycle']:
      {...descriptor,companyId:randomUUID()}},{resolveLoader:async()=>'/verified/loader.mjs',runProcess}));
    assert.equal(launches,before,'foreign descriptor refuses before the child');
  }
  assert.equal(launches,4);
});

test('only a native skill result can cross the existing visual projection boundary',async()=>{
  const {runAssistantWorkspaceProcess}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const plan=workspacePlan();
  plan.localAction={schemaVersion:1,operation:'skill_run',parameters:{companyId:plan.scope.companyId,skillId:'visual-fixture',
    releaseId:randomUUID(),runtimeSessionId:randomUUID(),arguments:['status']}};
  const visual={kind:'trelio.visual-browser/v1',state:'closed',reason:'none'};
  const run=(raw,value)=>runAssistantWorkspaceProcess(raw,{resolveLoader:async()=>'/verified/loader.mjs',
    runProcess:async()=>({stdout:JSON.stringify(value),stderr:''})});
  const valid={schemaVersion:1,operation:'skill_run',visual};
  assert.deepEqual((await run(plan,valid)).visual,visual);
  for(const value of [{...valid,stdout:'PRIVATE_RAW'},{...valid,stderr:'PRIVATE_RAW'},
    {...valid,visual:{...visual,privateContent:'PRIVATE_RAW'}},{...valid,visual:{...visual,image:{mimeType:'image/png',data:'invalid'}}}]){
    await assert.rejects(run(plan,value));
  }
  await assert.rejects(run(workspacePlan(),{...valid,operation:'open'}),/WORKSPACE_RESULT_INVALID/);
});

test('assistant finish has one writer, own poll route and no previous-pass receipt',async()=>{
  const {createAssistantWorkspaceExecutor}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const plan=workspacePlan(),identity={workspaceId:plan.localAction.parameters.workspaceId,runId:plan.localAction.parameters.runId};
  plan.localAction={schemaVersion:1,operation:'finish',runIdentity:identity,parameters:{summary:'Сохранён материал',evidence:['Проверено'],nextAction:'Ждать ответа',taskOutcome:'no_status_change'}};
  let resolve,launches=0;const child=new Promise(done=>{resolve=done;});
  const executor=await createAssistantWorkspaceExecutor({configDirectory:path.join(os.tmpdir(),'assistant-plan-fixture'),
    finishOptions:{waitMs:2},runPlan:async(raw,options)=>{launches++;assert.deepEqual(raw.scope,plan.scope);assert.equal(options.signal,undefined);
      options.onProgress({stage:'checkpoint'});return child;}});
  try {
    const first=await executor.execute(plan);assert.equal(first.state,'running');assert.equal(first.nextCall.tool,'continue_assistant_workspace_action');
    assert.equal(first.nextCall.arguments.workingDirectory,undefined);
    const second=await executor.execute(plan);assert.equal(second.operationId,first.operationId);assert.equal(launches,1);
    const poll={prepared:true,scope:plan.scope,localAction:first.nextCall.arguments};
    const cancelled=new AbortController();const wait=executor.execute(poll,{signal:cancelled.signal});cancelled.abort();await assert.rejects(wait);
    const foreign={...poll,scope:{...plan.scope,passId:randomUUID()}};
    await assert.rejects(executor.execute(foreign),error=>error.code==='ASSISTANT_WORKSPACE_FINISH_IN_PROGRESS');
    resolve({schemaVersion:1,operation:'finish',stdout:'native accepted head'});
    const final=await executor.execute(poll);assert.equal(final.state,'completed');assert.equal(final.stdout,'native accepted head');assert.equal(launches,1);
    await assert.rejects(executor.execute(foreign),error=>error.code==='TRELIO_WORKSPACE_FINISH_UNKNOWN');
  } finally {executor.stop();}
});

test('actual assistant workspace entry preserves bounded result and drops raw errors',async()=>{
  const plan=workspacePlan();const output=new PassThrough();let text='';output.on('data',part=>text+=part);
  await runAssistantEntry(['workspace'],{input:Readable.from([JSON.stringify(plan)]),output,
    executePlan:async input=>{assert.deepEqual(input,plan);return {schemaVersion:1,operation:'open',stdout:'native result'};}});
  assert.equal(JSON.parse(text).stdout,'native result');
  await assert.rejects(runAssistantEntry(['workspace','--human']),/COMMAND_UNSUPPORTED/);
  await assert.rejects(runAssistantEntry(['workspace'],{input:Readable.from(['x'.repeat(131073)]),output,
    executePlan:async()=>assert.fail('oversize action executed')}),/PLAN_INVALID/);
});

test('assistant Workspace preflight binds own protected pass and server Run before local materialization',async t=>{
  const fs=await import('node:fs/promises');
  const {executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const config=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-workspace-plan-'));t.after(()=>fs.rm(config,{recursive:true,force:true}));
  const plan=workspacePlan(),p=plan.localAction.parameters,scope=plan.scope;
  const active={schemaVersion:1,assistantId:scope.assistantUserId,deviceId:scope.deviceId,
    companyId:scope.companyId,taskId:scope.taskId,passId:scope.passId,threadId:randomUUID(),deliveryId:randomUUID(),bindingId:randomUUID(),bindingRevision:0};
  const calls=[];let allowed=true,files=0;
  const common={formatBridgeCommandError:error=>String(error.code??'UNKNOWN'),resolveWorkspaceBridgeConfigDirectory:()=>config,requireToken:async()=>({}),request:async(_origin,_token,url)=>{
    calls.push(url);if(!allowed)throw Object.assign(new Error(),{code:'ASSISTANT_ACCESS_DENIED'});
    return {run:{id:p.runId,workspaceId:p.workspaceId}};
  },readBoundedResponseBuffer:async value=>Buffer.from(JSON.stringify(value)),ensurePrivateDirectory:async directory=>{files++;await fs.mkdir(directory,{recursive:true});},
    runWorkspaceCommand:async args=>{calls.push(args);process.stdout.write('native CLI output\n');}};
  const withProfile=async action=>action({identity:{origin:'https://trelio.ru',assistantId:scope.assistantUserId,deviceId:scope.deviceId},
    prepareWorkspaceRun:async()=>null,client:{},host:{readActivePass:async()=>active},store:{get:async()=>({state:{runtimeSessionId:p.runtimeSessionId}})}});
  const result=await executeAssistantWorkspacePlan(plan,{withProfile,loadCommon:async()=>common});
  assert.equal(result.stdout,'native CLI output\n');assert.equal(files,1);
  const {assistantTaskStorageDirectory}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const argv=calls.find(Array.isArray),root=path.join(assistantTaskStorageDirectory(config,{origin:'https://trelio.ru',assistantId:scope.assistantUserId,
    deviceId:scope.deviceId,companyId:scope.companyId,taskId:scope.taskId}),'workspaces',p.workspaceId);
  if(process.platform==='win32')assert.ok(root.length<240,'native cwd remains below the Windows process limit');
  assert.equal(argv[argv.indexOf('--dir')+1],root);assert.deepEqual(argv.slice(-2),['--origin','https://trelio.ru']);
  const native=await import('../host-runtime/scripts/trelio-workspace.mjs');
  common.formatBridgeCommandError=native.formatBridgeCommandError;
  common.runWorkspaceCommand=async()=>{throw new native.TrelioApiError(409,'untrusted response prose',null,'TRELIO_RUNTIME_HOOK_REQUIRED',{reason:'expired'});};
  await assert.rejects(executeAssistantWorkspacePlan(plan,{withProfile,loadCommon:async()=>common}),
    error=>error.code==='TRELIO_RUNTIME_HOOK_REQUIRED' && error.reason==='expired');
  const filesBeforeDenied=files;
  allowed=false;
  await assert.rejects(executeAssistantWorkspacePlan(plan,{withProfile,loadCommon:async()=>common}));
  assert.equal(files,filesBeforeDenied,'server refusal precedes local filesystem writes');
  await assert.rejects(executeAssistantWorkspacePlan({...plan,scope:{...scope,passId:randomUUID()}},{withProfile,loadCommon:async()=>common}),error=>error.code==='ASSISTANT_WORKSPACE_BINDING_CHANGED');
  assert.equal(files,filesBeforeDenied);
});


test('assistant draft and pause reach the shared writer without a handoff-only outcome',async t=>{
  const {executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const {assistantTaskStorageDirectory}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const {validateHandoffTaskOutcome}=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const config=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-checkpoint-outcome-'));
  t.after(()=>fs.rm(config,{recursive:true,force:true}));
  const plan=workspacePlan(),scope=plan.scope,p=plan.localAction.parameters;
  const identity={origin:'https://trelio.ru',assistantId:scope.assistantUserId,deviceId:scope.deviceId};
  const runIdentity={workspaceId:p.workspaceId,runId:p.runId};
  const root=path.join(assistantTaskStorageDirectory(config,{...identity,companyId:scope.companyId,taskId:scope.taskId}),
    'workspaces',p.workspaceId),directory=path.join(root,'workspace');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(root,'.trelio-run.json'),JSON.stringify({schemaVersion:3,origin:identity.origin,
    workspaceId:p.workspaceId,runId:p.runId,workspaceDirectory:directory}),{mode:0o600});
  const active={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,
    companyId:scope.companyId,taskId:scope.taskId,passId:scope.passId,threadId:randomUUID(),deliveryId:randomUUID(),bindingId:randomUUID(),bindingRevision:0};
  let calls=0;
  const common={resolveWorkspaceBridgeConfigDirectory:()=>config,requireToken:async()=>({}),
    request:async()=>({run:{id:p.runId,workspaceId:p.workspaceId}}),
    readBoundedResponseBuffer:async value=>Buffer.from(JSON.stringify(value)),ensurePrivateDirectory:async()=>{},
    formatBridgeCommandError:error=>String(error.code??'UNKNOWN'),runWorkspaceCommand:async args=>{
      calls++;
      const option=name=>{const i=args.indexOf('--'+name);return i<0?'':args[i+1];};
      const checkpointType=args[0]==='finish'?'handoff':args[0]==='pause'?'blocker':option('type');
      // Exercise the production shared writer's validator, not another copy of
      // its outcome policy. The old adapter rejects draft/pause at this point.
      validateHandoffTaskOutcome({scopeType:'task',checkpointType,taskOutcome:option('task-outcome'),openQuestions:[]});
      assert.equal(option('task-outcome'),checkpointType==='handoff'?'no_status_change':'');
      process.stdout.write('shared lifecycle validation passed');
    }};
  const withProfile=async action=>action({identity,host:{readActivePass:async()=>active},prepareWorkspaceRun:async()=>null});
  for(const [operation,parameters] of [
    ['checkpoint',{type:'draft',summary:'Synthetic durable draft'}],
    ['pause',{summary:'Synthetic blocker draft',questions:['Synthetic decision'],nextAction:'Review synthetic decision'}],
    ['checkpoint',{type:'handoff',summary:'Synthetic completed material',evidence:['Synthetic check'],filePaths:['WORK.md'],nextAction:'Read result'}],
    ['finish',{summary:'Synthetic completed material',evidence:['Synthetic check'],filePaths:['WORK.md'],nextAction:'Read result',taskOutcome:'no_status_change'}],
  ]){
    const result=await executeAssistantWorkspacePlan({...plan,localAction:{schemaVersion:1,operation,runIdentity,parameters}},
      {withProfile,loadCommon:async()=>common});
    assert.equal(result.stdout,'shared lifecycle validation passed');
  }
  assert.equal(calls,4);
});

test('assistant reuses the shared local recovery and keeps heartbeat/status on its registered root after restart',async t=>{
  const {executeAssistantWorkspacePlan,createAssistantWorkspaceExecutor,validateAssistantWorkspacePlan,
    resolveAssistantWorkspaceRoot}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const native=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {WorkspaceLocalRecoveryRequiredError}=await import('../host-runtime/scripts/trelio-workspace-directory.mjs');
  const {assistantTaskStorageDirectory}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  // TEMP may contain RUNNER~1 while the shared writer canonicalises that path.
  const config=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'assistant-local-recovery-')));
  t.after(()=>fs.rm(config,{recursive:true,force:true}));
  const raw=workspacePlan(),plan=await validateAssistantWorkspacePlan(raw),p=raw.localAction.parameters,scope=plan.scope;
  const identity={origin:'https://trelio.ru',assistantId:scope.assistantUserId,deviceId:scope.deviceId};
  const base=path.join(assistantTaskStorageDirectory(config,{...identity,companyId:scope.companyId,taskId:scope.taskId}),'workspaces',p.workspaceId);
  const {workspaceRecoveryDirectory}=await import('../host-runtime/scripts/trelio-workspace-directory.mjs');
  const recovered=workspaceRecoveryDirectory(base,p.workspaceId,p.runId),oldRun=randomUUID(),oldFile=path.join(base,'workspace','WORK.md');
  const metadata=async(root,runId)=>{
    await native.ensurePrivateDirectory(path.join(root,'workspace'));
    await native.writePrivateJsonFile(path.join(root,'.trelio-run.json'),{schemaVersion:3,...identity,
      origin:identity.origin,workspaceId:p.workspaceId,runId,workspaceDirectory:path.join(root,'workspace')});
  };
  await metadata(base,oldRun);await fs.writeFile(oldFile,'synthetic unsaved original\n',{mode:0o600});
  await native.writePrivateJsonFile(path.join(config,'runs.json'),{roots:[base]});
  const active={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,
    companyId:scope.companyId,taskId:scope.taskId,passId:scope.passId,threadId:randomUUID(),deliveryId:randomUUID(),bindingId:randomUUID(),bindingRevision:0};
  let openCalls=0,allowed=true;const actions=[];
  const common={resolveWorkspaceBridgeConfigDirectory:()=>config,requireToken:async()=>({}),
    request:async()=>{if(!allowed)throw Object.assign(new Error('synthetic revoked'),{code:'ASSISTANT_ACCESS_DENIED'});
      return {run:{id:p.runId,workspaceId:p.workspaceId}};},
    readBoundedResponseBuffer:async value=>Buffer.from(JSON.stringify(value)),
    ensurePrivateDirectory:native.ensurePrivateDirectory,formatBridgeCommandError:native.formatBridgeCommandError,
    runWorkspaceCommand:async args=>{
      actions.push({args,cwd:process.cwd()});
      if(args[0]==='open'){
        openCalls++;assert.equal(args[args.indexOf('--run')+1],p.runId);
        assert.equal(args[args.indexOf('--runtime-session')+1],p.runtimeSessionId);
        if(openCalls===1)throw new WorkspaceLocalRecoveryRequiredError({workspaceId:p.workspaceId,sourceRunId:oldRun,
          targetRunId:p.runId,sourceRunStatus:'cancelled',sourceDirectory:base,sourceWorkspaceDirectory:path.join(base,'workspace'),
          suggestedDirectory:recovered,lastSavedDraftHead:null,changes:['?? WORK.md']});
        assert.equal(args[args.indexOf('--dir')+1],recovered);
        await metadata(recovered,p.runId);
        await native.writePrivateJsonFile(path.join(config,'runs.json'),{roots:[base,recovered]});
      }else assert.equal(process.cwd(),await fs.realpath(path.join(recovered,'workspace')));
      process.stdout.write('synthetic common writer result');
    }};
  const withProfile=async action=>action({identity,prepareWorkspaceRun:async()=>null,
    host:{readActivePass:async()=>active},store:{get:async()=>({state:{runtimeSessionId:p.runtimeSessionId}})}});
  const runPlan=raw=>executeAssistantWorkspacePlan(raw,{withProfile,loadCommon:async()=>common});
  let scheduled;
  const options={configDirectory:config,runPlan,
    heartbeatOptions:{scheduleTimer:callback=>(scheduled=callback),cancelTimer:()=>{}}};
  const executor=await createAssistantWorkspaceExecutor(options);
  try{
    const result=await executor.execute(raw),evidence=JSON.parse(result.stdout.trim().split('\n').at(-1)).assistantLocalRecovery;
    assert.equal(evidence.code,'TRELIO_WORKSPACE_LOCAL_RECOVERY_REQUIRED');
    assert.equal(evidence.sourceFilesMustRemainUntouched,true);assert.equal(evidence.sourceDirectory,base);
    assert.equal(openCalls,2);assert.equal(await fs.readFile(oldFile,'utf8'),'synthetic unsaved original\n');
    assert.deepEqual(await fs.readdir(path.join(recovered,'workspace')),[],'opening is not automatic copying or accepted material');
    await scheduled();assert.equal(actions.at(-1).args[0],'heartbeat');
    assert.equal(await resolveAssistantWorkspaceRoot(config,plan),recovered);
  }finally{executor.stop();}
  const restarted=await createAssistantWorkspaceExecutor(options);
  const status={...raw,localAction:{schemaVersion:1,operation:'status',parameters:{},runIdentity:plan.runIdentity}};
  try{
    await restarted.execute(status);assert.equal(actions.at(-1).args[0],'status');
    allowed=false;const before=actions.length;
    await assert.rejects(restarted.execute(status),error=>error.code==='ASSISTANT_ACCESS_DENIED');
    assert.equal(actions.length,before,'a registered path cannot bypass fresh native permission');
  }finally{restarted.stop();}
  // Registry entries from another identity are not inspected or adopted. A
  // second exact copy in this identity remains ambiguous, never newest-wins.
  const duplicate=workspaceRecoveryDirectory(recovered,p.workspaceId,p.runId);
  await metadata(duplicate,p.runId);
  await native.writePrivateJsonFile(path.join(config,'runs.json'),{roots:[recovered,duplicate,'/synthetic/foreign/workspace']});
  await assert.rejects(resolveAssistantWorkspaceRoot(config,plan));
  assert.equal(await fs.readFile(oldFile,'utf8'),'synthetic unsaved original\n');
});

test('assistant recovery rejects an out-of-scope suggested directory without another open',async t=>{
  const {executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const native=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {WorkspaceLocalRecoveryRequiredError}=await import('../host-runtime/scripts/trelio-workspace-directory.mjs');
  const {assistantTaskStorageDirectory}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const config=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-refused-recovery-'));t.after(()=>fs.rm(config,{recursive:true,force:true}));
  const plan=workspacePlan(),p=plan.localAction.parameters,s=plan.scope;
  const identity={origin:'https://trelio.ru',assistantId:s.assistantUserId,deviceId:s.deviceId};
  const base=path.join(assistantTaskStorageDirectory(config,{...identity,companyId:s.companyId,taskId:s.taskId}),'workspaces',p.workspaceId);
  let calls=0;
  const common={resolveWorkspaceBridgeConfigDirectory:()=>config,requireToken:async()=>({}),request:async()=>({run:{id:p.runId,workspaceId:p.workspaceId}}),
    readBoundedResponseBuffer:async value=>Buffer.from(JSON.stringify(value)),ensurePrivateDirectory:native.ensurePrivateDirectory,
    formatBridgeCommandError:native.formatBridgeCommandError,runWorkspaceCommand:async()=>{calls++;
      throw new WorkspaceLocalRecoveryRequiredError({workspaceId:p.workspaceId,sourceRunId:randomUUID(),targetRunId:p.runId,
        sourceRunStatus:'cancelled',sourceDirectory:base,sourceWorkspaceDirectory:path.join(base,'workspace'),
        suggestedDirectory:path.join(config,'foreign'),lastSavedDraftHead:null,changes:['?? WORK.md']});}};
  await assert.rejects(executeAssistantWorkspacePlan(plan,{loadCommon:async()=>common,withProfile:async action=>action({identity,
    prepareWorkspaceRun:async()=>null,host:{readActivePass:async()=>({schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,
      companyId:s.companyId,taskId:s.taskId,passId:s.passId,threadId:randomUUID(),deliveryId:randomUUID(),bindingId:randomUUID(),bindingRevision:0})},
    store:{get:async()=>({state:{runtimeSessionId:p.runtimeSessionId}})}})}),error=>error.code==='ASSISTANT_WORKSPACE_BINDING_CHANGED');
  assert.equal(calls,1);await assert.rejects(fs.stat(path.join(config,'foreign')),error=>error.code==='ENOENT');
});

test('accepted inspection uses no Run identity, local writable root, renewal or finish registry',async()=>{
  const {validateAssistantWorkspacePlan,executeAssistantWorkspacePlan,createAssistantWorkspaceExecutor}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const plan=workspacePlan(),workspaceId=plan.localAction.parameters.workspaceId;
  plan.localAction={schemaVersion:1,operation:'inspect',parameters:{workspaceId}};
  assert.deepEqual((await validateAssistantWorkspacePlan(plan)).runIdentity,{workspaceId});
  for(const bad of [{...plan.localAction,runIdentity:{workspaceId,runId:randomUUID()}},
    {...plan.localAction,parameters:{workspaceId,runId:randomUUID()}},
    {...plan.localAction,parameters:{workspaceId,runtimeSessionId:randomUUID()}}])
    await assert.rejects(validateAssistantWorkspacePlan({...plan,localAction:bad}));
  const active={schemaVersion:1,assistantId:plan.scope.assistantUserId,deviceId:plan.scope.deviceId,
    ...Object.fromEntries(['companyId','taskId','passId'].map(key=>[key,plan.scope[key]])),
    threadId:randomUUID(),deliveryId:randomUUID(),bindingId:randomUUID(),bindingRevision:0};
  let allowed=true,calls=0,localRoots=0;
  const common={resolveWorkspaceBridgeConfigDirectory:()=>os.tmpdir(),requireToken:async()=>({}),request:async(_origin,_token,url)=>{
    calls++;assert.equal(url,`/api/agent-workspaces/workspaces/${workspaceId}/read-snapshot`);
    if(!allowed)throw Object.assign(new Error(),{code:'ASSISTANT_ACCESS_DENIED'});
    return {workspace:{id:workspaceId,scopeType:'task',scopeKey:`task:${plan.scope.taskId}`}};
  },readBoundedResponseBuffer:async value=>Buffer.from(JSON.stringify(value)),ensurePrivateDirectory:async()=>{localRoots++;},
    runWorkspaceCommand:async args=>{assert.deepEqual(args,['inspect','--workspace',workspaceId,'--origin','https://trelio.ru']);process.stdout.write('accepted snapshot path');}};
  const withProfile=async action=>action({identity:{origin:'https://trelio.ru',assistantId:plan.scope.assistantUserId,deviceId:plan.scope.deviceId},
    host:{readActivePass:async()=>active}});
  const executor=await createAssistantWorkspaceExecutor({configDirectory:os.tmpdir(),
    runPlan:raw=>executeAssistantWorkspacePlan(raw,{withProfile,loadCommon:async()=>common})});
  try{
    assert.equal((await executor.execute(plan)).stdout,'accepted snapshot path');
    assert.equal(localRoots,0,'shared reader, not the writable Run adapter, owns its cache');
    allowed=false;await assert.rejects(executor.execute(plan),error=>error.code==='ASSISTANT_ACCESS_DENIED');
    assert.equal(calls,2);assert.equal(localRoots,0);
  }finally{executor.stop();}
});


test('prototype writable task roots stop new materialization without moving or hiding old work',async t=>{
  const fs=await import('node:fs/promises'),{executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const config=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-old-task-'));t.after(()=>fs.rm(config,{recursive:true,force:true}));
  const plan=workspacePlan(),scope=plan.scope,p=plan.localAction.parameters;
  const active={schemaVersion:1,assistantId:scope.assistantUserId,deviceId:scope.deviceId,companyId:scope.companyId,taskId:scope.taskId,
    passId:scope.passId,threadId:randomUUID(),deliveryId:randomUUID(),bindingId:randomUUID(),bindingRevision:0};
  const legacy=path.join(config,'digital-assistants','runtime',scope.assistantUserId,scope.deviceId,'tasks',scope.companyId,scope.taskId);
  await fs.mkdir(legacy,{recursive:true});await fs.writeFile(path.join(legacy,'pending.txt'),'synthetic pending work');
  let writes=0;
  const common={resolveWorkspaceBridgeConfigDirectory:()=>config,requireToken:async()=>({}),request:async()=>({run:{id:p.runId,workspaceId:p.workspaceId}}),
    readBoundedResponseBuffer:async value=>Buffer.from(JSON.stringify(value)),ensurePrivateDirectory:async()=>{writes++;},runWorkspaceCommand:async()=>{writes++;}};
  const withProfile=async action=>action({identity:{origin:'https://trelio.ru',assistantId:scope.assistantUserId,deviceId:scope.deviceId},
    prepareWorkspaceRun:async()=>null,host:{readActivePass:async()=>active},store:{get:async()=>({state:{runtimeSessionId:p.runtimeSessionId}})}});
  await assert.rejects(executeAssistantWorkspacePlan(plan,{withProfile,loadCommon:async()=>common}),error=>error.code==='ASSISTANT_TASK_STORAGE_REVIEW_REQUIRED');
  assert.equal(writes,0);assert.equal(await fs.readFile(path.join(legacy,'pending.txt'),'utf8'),'synthetic pending work');
});

test('MAX setup and verification use distinct routes and wait budgets with no factor/command overrides',async()=>{
  for(const verify of [false,true]){
    const companyId=randomUUID(),sourceId=randomUUID(),reports=[];let calls=0,contexts=0;
    const invoke=async input=>{calls++;assert.equal(input.sourceId,sourceId);return {state:verify?'session_verified':'login_handoff_finished'};};
    const deps={versions:()=>({pluginVersion:'3.2.3',hostRuntimeVersion:'3.10.2'}),
      context:async(action,options)=>{contexts++;assert.equal(options.interactiveSourceSetup,!verify);return action({identity:{},
        readHealth:async()=>({code:'hook_review_required',revision:0,latchedCodes:['hook_review_required'],compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:null}}),
        reportHealth:async v=>reports.push(v)},{withSetupLock:action=>action()},{});},proxyFor:async()=>({}),
      configureMaxSource:verify?async()=>assert.fail('probe cannot reopen login'):invoke,
      verifyMaxSource:verify?invoke:async()=>assert.fail('handoff cannot claim verification')};
    const request={operation:'call',name:verify?'verify_assistant_max_source':'configure_assistant_max_source',arguments:{companyId,sourceId}};
    assert.equal((await executeAssistantRuntimeRequest(request,deps)).structuredContent.state,verify?'session_verified':'login_handoff_finished');
    for(const args of [{companyId,sourceId:null},{companyId,sourceId,password:'PRIVATE'},
      {companyId,sourceId,holdMs:900000},{companyId,sourceId,command:'login'}])
      await assert.rejects(executeAssistantRuntimeRequest({...request,arguments:args},deps),{code:'ASSISTANT_SETUP_INVALID_INPUT'});
    assert.equal(calls,1);assert.equal(contexts,1);assert.ok(reports.every(v=>v.clearedReason===undefined));
  }
});


test('private browser continuation reuses the exact common invocation and refuses browser/executable overrides',async()=>{
  const {validateAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const base=workspacePlan(),grantId=randomUUID(),targetUrl='https://example.invalid/login';
  const raw={...base,localAction:{schemaVersion:1,operation:'secret_browser_fill',
    runIdentity:{workspaceId:base.localAction.parameters.workspaceId,runId:base.localAction.parameters.runId},parameters:{grantId,targetUrl}}};
  const plan=await validateAssistantWorkspacePlan(raw);
  assert.equal(plan.localAction.operation,'secret_browser_fill');
  assert.deepEqual(plan.runIdentity,raw.localAction.runIdentity);
  for(const extra of [{browser:'chrome'},{executable:'other'},{arguments:[]},{directory:'/foreign'}]){
    await assert.rejects(validateAssistantWorkspacePlan({...raw,localAction:{...raw.localAction,parameters:{grantId,targetUrl,...extra}}}));
  }
  for(const target of ['http://example.invalid/login','https://user:password@example.invalid/login']){
    await assert.rejects(validateAssistantWorkspacePlan({...raw,localAction:{...raw.localAction,parameters:{grantId,targetUrl:target}}}));
  }
});


test('private credential setup composes the common reserved executable and binds the original Run',async()=>{
  const {validateAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const base=workspacePlan(),runId=base.localAction.parameters.runId,workspaceId=base.localAction.parameters.workspaceId;
  const parameters={grantId:randomUUID(),companySlug:'fixture',fieldKey:'password',environmentVariable:'TRELIO_SERVICE_PASSWORD',
    skill:{companyId:base.scope.companyId,skillId:'synthetic-private',releaseId:randomUUID(),
      runtimeSessionId:randomUUID(),arguments:['login']}};
  const raw={...base,localAction:{schemaVersion:1,operation:'secret_skill_run',runIdentity:{runId,workspaceId},parameters}};
  const plan=await validateAssistantWorkspacePlan(raw);
  assert.equal(plan.invocation.argumentsList[0],'secret');
  assert.deepEqual(plan.invocation.argumentsList.slice(4,8),['--','trelio-workspace','skill','run']);
  assert.deepEqual(plan.runIdentity,{workspaceId,runId});
  for(const extra of [{value:'PRIVATE'},{executable:'powershell'},{directory:'/foreign'},{deliveryMode:'file'},
    {environmentVariable:'NODE_OPTIONS'},{skill:{...parameters.skill,companyId:randomUUID()}}])
    await assert.rejects(validateAssistantWorkspacePlan({...raw,localAction:{...raw.localAction,parameters:{...parameters,...extra}}}));
});

test('private generation accepts only structural sealed coordinates in its SAME Workspace worker plan',async()=>{
  const {validateAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const base=workspacePlan(),runId=base.localAction.parameters.runId,workspaceId=base.localAction.parameters.workspaceId;
  const parameters={runId,clientRequestId:randomUUID(),ownerDecisionId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  const raw={...base,localAction:{schemaVersion:1,operation:'secret_generate',runIdentity:{runId,workspaceId},parameters}};
  const value=await validateAssistantWorkspacePlan(raw);assert.equal(value.invocation,null);
  for(const extra of [{values:{password:'PRIVATE'}},{token:'PRIVATE'},{key:'PRIVATE'},{metadata:{}},{generatedFields:[]},
    {userExplicitlyRequestedGeneratedPersistentStorage:true},{runId:randomUUID()}]){
    await assert.rejects(validateAssistantWorkspacePlan({...raw,localAction:{...raw.localAction,parameters:{...parameters,...extra}}}));
  }
});

test('native Remote MCP instruction selects only the small presentation view and existing list-changed notification',async()=>{
  const frames=[{jsonrpc:'2.0',id:1,method:'initialize'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_agent_skill',arguments:{skillId:'synthetic-remote'}}},
    {jsonrpc:'2.0',id:3,method:'tools/list'},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_assistant_status',arguments:{}}},
    {jsonrpc:'2.0',id:5,method:'tools/list'}];
  const output=new PassThrough();let raw='';output.on('data',chunk=>{raw+=chunk;});const views=[];
  await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
    createMcp:async({presentationProfile})=>{views.push(presentationProfile);return {
      listTools:async()=>[],callTool:async(name)=>name==='get_agent_skill'?{content:[],structuredContent:{
        assistantExecution:{state:'shared_remote_mcp'},remoteMcpExecution:{localMcpServer:'trelio-assistant'}}}:{content:[],structuredContent:{schemaVersion:1}},
    };}});
  assert.deepEqual(views,['task','remote_mcp','remote_mcp','task']);
  const messages=raw.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(messages.filter(message=>message.method==='notifications/tools/list_changed').length,2);
  assert.equal(messages.filter(message=>message.id).length,5);
});

test('same task chat can wait for an exact remote owner decision, call once, and return to its task work tools',async()=>{
  const ids={question:'synthetic-question',request:'synthetic-request'},calls=[],views=[];let read=0,attempts=0;
  const actions=[['get_agent_skill',{skillId:'synthetic-remote'}],['get_task',{}],
    ['request_assistant_action',{operation:'call_remote_agent_skill_tool',fields:{toolName:'update_record',arguments:{exact:'original'}}}],
    ['get_assistant_owner_question',{questionId:ids.question}],['get_assistant_owner_question',{questionId:ids.question}],
    ['call_remote_agent_skill_tool',{toolName:'update_record',arguments:{exact:'original'},ownerDecisionId:ids.question,clientRequestId:ids.request}],
    ['get_assistant_status',{}],['prepare_assistant_workspace_run',{clientRequestId:ids.request}]];
  const frames=[{jsonrpc:'2.0',id:1,method:'initialize'},...actions.map(([name,args],index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params:{name,arguments:args}}))];
  const output=new PassThrough();let raw='';output.on('data',chunk=>{raw+=chunk;});
  await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
    createMcp:async({presentationProfile})=>{views.push(presentationProfile);return {callTool:async(name,args)=>{
      calls.push(name);
      if(name==='get_agent_skill')return {content:[],structuredContent:{assistantExecution:{state:'shared_remote_mcp'},remoteMcpExecution:{localMcpServer:'trelio-assistant'}}};
      if(name==='get_assistant_owner_question')return {content:[],structuredContent:{id:ids.question,state:++read===1?'pending':'answered',action:{state:read===1?'pending':'approved'}}};
      if(name==='call_remote_agent_skill_tool'){assert.equal(read,2);assert.equal(args.ownerDecisionId,ids.question);assert.equal(args.clientRequestId,ids.request);attempts++;}
      return {content:[],structuredContent:{schemaVersion:1}};
    }};}});
  assert.deepEqual(calls,actions.map(([name])=>name));assert.equal(attempts,1);
  assert.deepEqual(views,['task','remote_mcp','remote_mcp','remote_mcp','remote_mcp','remote_mcp','remote_mcp','task']);
  const messages=raw.trim().split('\n').map(line=>JSON.parse(line));assert.equal(messages.filter(message=>message.method==='notifications/tools/list_changed').length,2);
  assert.equal(messages.filter(message=>message.id).length,9);
});

test('public signed account setup follows task skill discovery through owner approval and its advertised setup continuation',async()=>{
  const questionId=randomUUID(),clientRequestId=randomUUID(),accountId=randomUUID(),calls=[],views=[];
  const fields={skillId:'synthetic-public-login',projectId:null,releaseId:randomUUID(),accountId,commandId:'login'};
  const parameters={...fields,clientRequestId,ownerDecisionId:questionId,expectedTaskUpdatedAt:new Date().toISOString()};
  const continuation={schemaVersion:1,operation:'skill_account_setup',parameters};
  let questionReads=0,attempts=0,raw='';
  const frames=[{jsonrpc:'2.0',id:1,method:'initialize'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_agent_skill',arguments:{skillId:fields.skillId,sections:['instructions','execution','connection']}}},
    {jsonrpc:'2.0',id:4,method:'tools/list'},
    {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'request_assistant_action',arguments:{operation:'setup_skill_account',fields,clientRequestId}}},
    {jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'get_assistant_owner_question',arguments:{questionId}}},
    {jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'get_assistant_owner_question',arguments:{questionId}}},
    {jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'continue_assistant_workspace_action',arguments:continuation}},
    {jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'get_assistant_status',arguments:{}}},
    {jsonrpc:'2.0',id:10,method:'tools/list'}];
  const output=new PassThrough();output.on('data',chunk=>{raw+=chunk;});
  await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
    createMcp:async({presentationProfile})=>{
      views.push(presentationProfile);
      const operations=presentationProfile==='skill_setup'?['skill_consent','skill_account_setup']:['skill_run'];
      return {listTools:async()=>[{name:'continue_assistant_workspace_action',inputSchema:{type:'object',properties:{operation:{enum:operations}}}}],
        callTool:async(name,args)=>{
          calls.push(name);
          if(name==='get_agent_skill'){
            assert.equal(presentationProfile,'task');
            // Native public guidance returns no pending unverified-runtime
            // consent. Its signed account setup alone selects the existing
            // small view; the backend PG regression verifies this real state.
            return {content:[],structuredContent:{assistantExecution:{state:'shared_runtime_setup',accountSetup:{
              state:'owner_review_required',operation:'setup_skill_account',continuation:'skill_account_setup',
              commands:[{id:'login',purpose:'authenticate_existing'}]}}}};
          }
          if(name==='request_assistant_action'){
            assert.equal(presentationProfile,'skill_setup');assert.deepEqual(args.fields,fields);
            return {content:[],structuredContent:{questionId,continuation:{arguments:continuation}}};
          }
          if(name==='get_assistant_owner_question'){
            assert.equal(presentationProfile,'skill_setup');assert.equal(args.questionId,questionId);
            return {content:[],structuredContent:{id:questionId,action:{state:++questionReads===1?'pending':'approved'}}};
          }
          if(name==='continue_assistant_workspace_action'){
            assert.equal(questionReads,2,'pending owner input alone never admits setup');
            assert.deepEqual(args,continuation,'facade must forward the exact returned native intent');
            assert.equal(operations.includes(args.operation),true,'never call an operation hidden in this live view');
            attempts++;
            return {content:[],structuredContent:{state:'admitted',replayAllowed:false,reconcileOnly:false}};
          }
          assert.equal(name,'get_assistant_status');
          return {content:[],structuredContent:{schemaVersion:1}};
        }};
    }});
  const messages=raw.trim().split('\n').map(line=>JSON.parse(line)),reply=id=>messages.find(message=>message.id===id);
  assert.deepEqual(reply(2).result.tools.at(-1).inputSchema.properties.operation.enum,['skill_run']);
  assert.deepEqual(reply(4).result.tools.at(-1).inputSchema.properties.operation.enum,['skill_consent','skill_account_setup']);
  assert.deepEqual(reply(10).result.tools.at(-1).inputSchema.properties.operation.enum,['skill_run']);
  assert.deepEqual(reply(5).result.structuredContent.continuation.arguments,continuation);
  assert.equal(reply(6).result.structuredContent.action.state,'pending');
  assert.equal(reply(7).result.structuredContent.action.state,'approved');
  assert.equal(reply(8).result.structuredContent.state,'admitted');assert.equal(attempts,1);
  assert.deepEqual(calls,['get_agent_skill','request_assistant_action','get_assistant_owner_question','get_assistant_owner_question',
    'continue_assistant_workspace_action','get_assistant_status']);
  assert.deepEqual(views,['task','task','skill_setup','skill_setup','skill_setup','skill_setup','skill_setup','skill_setup','task']);
  assert.equal(messages.filter(message=>message.method==='notifications/tools/list_changed').length,2,
    'the SAME notification selects/restores presentation without a session, pass or authority replacement');
});

test('maintainer QA configuration is exact, hash-pinned and never a production origin or credential container',async t=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {createHash}=await import('node:crypto');
  const {normalizeAssistantQaConfiguration,readAssistantQaConfiguration}=await import('../scripts/assistant-qa-pilot.mjs');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-qa-config-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const configuration={schemaVersion:1,origin:'https://assistant-qa.example.test',configurationDirectory:path.join(directory,'state'),
    pluginRoot:path.join(directory,'shell'),runtimeVersion:'3.18.0',packageSha256:'a'.repeat(64)};
  assert.equal(normalizeAssistantQaConfiguration(configuration).origin,configuration.origin);
  for(const override of [{origin:'https://trelio.ru'},{origin:'https://e2ee.trelio.ru.'},{origin:'http://qa.example.test'},
    {origin:'https://user:password@qa.example.test'},{origin:'https://qa.example.test/path'},
    {credential:'PRIVATE'},{configurationDirectory:'relative'},{runtimeVersion:'3.18.0-candidate'},{runtimeVersion:'3.17.0'},
    {origin:'https://10.86.0.1'}])
    assert.throws(()=>normalizeAssistantQaConfiguration({...configuration,...override}));
  const file=path.join(directory,'instance.json'),bytes=Buffer.from(JSON.stringify(configuration));await fs.writeFile(file,bytes,{mode:0o600});
  const hash=createHash('sha256').update(bytes).digest('hex');assert.deepEqual(await readAssistantQaConfiguration(file,hash),configuration);
  await fs.writeFile(file,JSON.stringify({...configuration,origin:'https://other.example.test'}));
  await assert.rejects(readAssistantQaConfiguration(file,hash),error=>error.code==='ASSISTANT_QA_PILOT_UNAVAILABLE');
  const link=path.join(directory,'link.json');await fs.symlink(file,link);
  await assert.rejects(readAssistantQaConfiguration(link,hash));
});

test('QA launcher composes the same protected factories and fresh bounded worker with one immutable instance',async()=>{
  const path=await import('node:path'),os=await import('node:os');
  const {EventEmitter}=await import('node:events');
  const entry=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const {createAssistantQaPilot}=await import('../scripts/assistant-qa-pilot.mjs');
  const configuration={schemaVersion:1,origin:'https://assistant-qa.example.test',configurationDirectory:path.join(os.tmpdir(),'qa-private-instance'),
    pluginRoot:path.join(os.tmpdir(),'qa-installed-shell'),runtimeVersion:'3.18.0',packageSha256:'a'.repeat(64)};
  const identity={schemaVersion:1,origin:configuration.origin,assistantId:randomUUID(),deviceId:randomUUID()};
  const status={structuredContent:{schemaVersion:1,assistantUserId:identity.assistantId,deviceId:identity.deviceId,
    authorizedByUserId:randomUUID(),stage:'non-production-pilot',businessReady:true,
    availableCapabilities:['task_context','task_mutations','task_pass_outcome','workspace_execution','owner_decisions','background_service']}};
  const calls=[],spawns=[];let current=identity,nativeStatus=status,entryOptions;
  // Constructor/OS adapters here are deliberately controlled wiring fixtures.
  // They do not claim genuine grant, signature, provider or Windows evidence;
  // those stay in native PG, signed-child/HPKE and the real Windows acceptance.
  const modules={entry:{...entry,
    runAssistantEntry:async(_args,options)=>{entryOptions=options;return options.maintenanceRequest({operation:'list'});},
    withProductionAssistantWorkspace:async(action,options)=>{calls.push(['profile',options]);return options.context((client,host)=>action({identity:client.identity,host}));},
    createProductionAssistantMcp:async options=>{calls.push(['mcp',options]);return {callTool:async()=>nativeStatus};},
    withProductionAssistantManagedContent:async(request,send,options)=>{calls.push(['managed',options]);return options.context(()=>send(request.args));}},
    transport:{createAssistantHttp:()=>{},createAssistantDeviceClient:input=>({identity:{origin:input.origin,assistantId:input.assistantId,deviceId:input.deviceId}}),
      createAssistantMcpClient:()=>({callTool:async(name,args)=>{calls.push(['native-status',name,args]);return nativeStatus;}})},
    privateRuntime:{createAssistantPrivateStore:options=>{calls.push(['store',options.directory]);return {}; }},
    hook:{createAssistantHostState:options=>{calls.push(['host',options.directory]);return {readIdentity:async()=>current};}},
    common:{resolveWorkspaceBridgeConfigDirectory:()=>path.join(os.tmpdir(),'production-private-root'),assertPrivatePathKind:async()=>{}},
    session:{withPrivateProcessSession:async action=>action()},setup:{},finish:{}};
  const spawnProcess=(executable,args,options)=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
    let input='';child.stdin.on('data',chunk=>{input+=chunk;});child.stdin.on('finish',()=>setImmediate(()=>{
      spawns.push({executable,args,options,input});child.stdout.end(JSON.stringify({value:[]}));child.emit('close',0);
    }));return child;
  };
  const file=path.join(os.tmpdir(),'qa-instance.json'),hash='b'.repeat(64),launcher=path.join(os.tmpdir(),'maintainer-launcher.mjs');
  const pilot=await createAssistantQaPilot({configuration,configurationFile:file,configurationSha256:hash,modules,spawnProcess,launcher});
  await pilot.withProfile(async value=>{
    assert.equal(value.identity.origin,configuration.origin);assert.equal(value.host.configurationDirectory,configuration.configurationDirectory);
  });
  const mcp=await pilot.createMcp();assert.ok(mcp);
  const selected=calls.find(row=>row[0]==='mcp')[1];assert.equal(selected.context,pilot.context);assert.equal(selected.withProfile,pilot.withProfile);
  await selected.withManagedContent({name:'ask_assistant_owner',args:{questionText:'fixture only'}},async value=>value);
  assert.equal(calls.find(row=>row[0]==='managed')[1].context,pilot.context);
  assert.ok(calls.filter(row=>row[0]==='store').every(row=>row[1]===path.join(configuration.configurationDirectory,'digital-assistants','credentials')));
  assert.ok(calls.filter(row=>row[0]==='native-status').every(row=>row[1]==='get_assistant_status'));
  await pilot.run(['mcp']);assert.equal(spawns.length,1);
  assert.deepEqual(spawns[0].args,[launcher,'--configuration',file,'--sha256',hash,'bridge','assistant','request']);
  assert.deepEqual(JSON.parse(spawns[0].input),{operation:'list'},'QA configuration is not a model/native request field');
  assert.equal(typeof entryOptions.createHook,'function');assert.equal(typeof entryOptions.executePlan,'function');
  nativeStatus={...status,structuredContent:{...status.structuredContent,stage:'release-gated'}};
  await assert.rejects(pilot.context(()=>assert.fail('wrong native stage executed business work')));
  nativeStatus=status;current={...identity,origin:'https://trelio.ru'};
  await assert.rejects(pilot.context(()=>assert.fail('production identity was adopted')));
  await assert.rejects(createAssistantQaPilot({configuration:{...configuration,configurationDirectory:modules.common.resolveWorkspaceBridgeConfigDirectory()},
    configurationFile:file,configurationSha256:hash,modules}),error=>error.code==='ASSISTANT_QA_PILOT_UNAVAILABLE');
});

test('Workspace lifetime does not inherit a setup timer or extend an enclosing hook/caller deadline',async()=>{
  const {assistantProductionContextSignal}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const {withPrivateProcessSession,runtimeHookSignal,assertRuntimeHookBudget}=await import('../host-runtime/scripts/trelio-hook-private-session.mjs');
  const calls=[],timer=milliseconds=>{calls.push(milliseconds);return new AbortController().signal;};
  const run={workspaceId:randomUUID(),runId:randomUUID()},caller=new AbortController();
  assert.ok(assistantProductionContextSignal({},timer));
  assert.ok(assistantProductionContextSignal({interactiveSourceSetup:true},timer));
  assert.deepEqual(calls,[45_000,660_000],'short setup and human-input budgets remain unchanged');
  assert.equal(assistantProductionContextSignal({workspaceRun:run},timer),undefined);
  assert.equal(assistantProductionContextSignal({workspaceRun:run,signal:caller.signal},timer),caller.signal);
  assert.deepEqual(calls,[45_000,660_000],'the bridge reuses the human private-session lifetime, not another enlarged timer');
  const maintenance=assistantProductionContextSignal({pluginMaintenance:true,signal:caller.signal},timer);
  assert.deepEqual(calls,[45_000,660_000,150_000],'only the closed technical maintenance profile owns its bounded update budget');
  assert.throws(()=>assistantProductionContextSignal({pluginMaintenance:true,interactiveSourceSetup:true},timer),/INVALID/);
  assert.throws(()=>assistantProductionContextSignal({pluginMaintenance:true,workspaceRun:run},timer),/PROFILE_DENIED/);
  for(const bad of [false,{},[],{...run,extra:true},{...run,runId:'invalid'}])
    assert.throws(()=>assistantProductionContextSignal({workspaceRun:bad},timer),{code:'ASSISTANT_WORKSPACE_PROFILE_DENIED'});
  assert.throws(()=>assistantProductionContextSignal({workspaceRun:run,interactiveSourceSetup:true},timer),
    {code:'ASSISTANT_WORKSPACE_PROFILE_DENIED'});
  // A nested bridge cannot replace the original hook's cancellation scope.
  // This exercises the real shared ALS session rather than a copied deadline.
  await withPrivateProcessSession(async()=>{
    await withPrivateProcessSession(async()=>{
      assert.equal(runtimeHookSignal(),caller.signal);caller.abort();
      assert.equal(maintenance.aborted,true,'maintenance cannot extend the original enclosing signal');
      assert.throws(()=>assertRuntimeHookBudget(),{code:'TRELIO_RUNTIME_HOOK_FAILED'});
    },assistantProductionContextSignal({workspaceRun:run},timer));
  },caller.signal);
  assert.equal(assistantProductionContextSignal({workspaceRun:run,signal:caller.signal},timer).aborted,true);
});

test('trusted Workspace context retains attachment reader and isolates actual account/inspection profile paths',async()=>{
  const {withProductionAssistantWorkspace}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const identity={schemaVersion:1,origin:'https://assistant-qa.example.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const pass={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,companyId:randomUUID(),taskId:randomUUID(),
    passId:randomUUID(),deliveryId:randomUUID(),threadId:randomUUID(),bindingId:randomUUID(),bindingRevision:0};
  const configurationDirectory=path.join(os.tmpdir(),'qa-profile-context');
  const host=Object.freeze({configurationDirectory,readIdentity:async()=>identity,readActivePass:async()=>pass});
  const client={identity};
  const workspaceRun={workspaceId:randomUUID(),runId:randomUUID()};let contextOptions;
  await withProductionAssistantWorkspace(async current=>{
    assert.equal(current.identity.origin,identity.origin);assert.equal(current.host.configurationDirectory,configurationDirectory);
    assert.equal(typeof current.prepareAttachmentRead,'function','the SAME encrypted attachment reader survives factory composition');
    const profile=common.currentWorkspaceExecutionProfile();
    const accounts=await profile.resolveSkillCatalogueDirectory(path.join(os.tmpdir(),'unselected-production-state'));
    const inspection=await profile.resolveInspectionDirectory(path.join(os.tmpdir(),'unselected-production-state'));
    assert.ok(accounts.startsWith(configurationDirectory+path.sep));assert.ok(inspection.startsWith(configurationDirectory+path.sep));
    assert.doesNotMatch(accounts+inspection,/unselected-production-state/);
  },{workspaceRun,context:async(action,options)=>{contextOptions=options;return action(client,host,{});}});
  assert.deepEqual(contextOptions,{signal:undefined,workspaceRun},'the genuine factory forwards only its exact own-Run cell');
});


test('supervisor reports retained unknown dispatch returned by recovery without misreporting policy/owner waiting',async()=>{
  const controller=new AbortController();let cycles=0,waits=0;const reports=[];
  const identity={assistantId:randomUUID(),deviceId:randomUUID()};
  await runAssistantBackground({signal:controller.signal,readHost:async()=>({identity,activation:null}),
    verifyRegistration:async()=>{},startConsoleIcon:async()=>null,request:async request=>{
      if(request.operation!=='background_tick')return;
      return {state:'blocked',dispatch:{reasons:[['delivery_uncertain'],['model_selection_required'],['waiting_owner']][cycles++]}};
    },reportFailure:async error=>{reports.push(error);},wait:async()=>{if(++waits===3)controller.abort();}});
  assert.equal(cycles,3);assert.deepEqual(reports,[{code:'ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN'}]);
});


test('fresh tick worker reports retained/throwing uncertainty under an unchanged old supervisor without replay',async()=>{
  for(const scenario of ['returned','thrown','report_failed','model_blocked']){
    const reports=[];let work=0,closes=0;
    const failure=Object.assign(new Error('PRIVATE original native read failure'),{code:'ASSISTANT_CODEX_READ_UNAVAILABLE'});
    const dispatch={state:'blocked',reasons:[scenario==='model_blocked'?'model_selection_required':'delivery_uncertain']};
    const tick=()=>runAssistantBackgroundTick({pluginMaintenance:async()=>({state:"current"}),createHost:async()=>({coordinator:{pollOnce:async()=>{},
      workOnce:async()=>{work++;if(['thrown','report_failed'].includes(scenario))throw failure;return null;},
      dispatchStatus:async()=>dispatch},reportDispatchFailure:async error=>{
        reports.push(error);if(scenario==='report_failed')throw new Error('PRIVATE diagnostic CAS/transport refusal');
      },close:async()=>{closes++;}})});
    // This caller deliberately has NO new supervisor failure mapping. Only the
    // current immutable worker can deliver the owner report after hot update.
    if(['thrown','report_failed'].includes(scenario))await assert.rejects(tick,error=>error===failure);
    else assert.equal((await tick()).state,'blocked');
    assert.equal(work,1);assert.equal(closes,1);
    assert.deepEqual(reports,scenario==='model_blocked'?[]:[{code:'ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN'}]);
    assert.ok(!JSON.stringify(reports).includes('PRIVATE'));
  }
});


test('local connection is taskless, validates before private I/O and reuses the current signed worker',async()=>{
  const companyId=randomUUID(),clientRequestId=randomUUID(),sourceId=randomUUID();let contexts=0,prepares=0,active=null;
  const request={operation:'call',name:'prepare_assistant_local_connection',arguments:{companyId,clientRequestId,skillId:'telegram-mtproto'}};
  const client={identity:{origin:'https://source.test',assistantId:randomUUID(),deviceId:randomUUID()},
    readHealth:async()=>({code:'ready',revision:0,compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:null}}),reportHealth:async()=>{}};
  const dependencies={versions:()=>({pluginVersion:'3.2.3',hostRuntimeVersion:'3.20.0'}),
    context:async action=>{contexts++;return action(client,{readActivePass:async()=>active},{});},
    proxyFor:async()=>({callTool:()=>assert.fail('no native task/human alias')}),
    prepareLocalConnection:async input=>{prepares++;assert.equal(input.clientRequestId,clientRequestId);assert.equal(input.client,client);
      return {sourceId,state:'prepared',backgroundEnabled:false,loginVerified:false};}};
  const value=await executeAssistantRuntimeRequest(request,dependencies);
  assert.equal(value.structuredContent.backgroundEnabled,false);assert.equal(prepares,1);
  assert.equal((await executeAssistantRuntimeRequest({...request,arguments:{...request.arguments,companyId:null}},dependencies))
    .structuredContent.backgroundEnabled,false,'null chooses discovery in the current worker, not a browser or human alias');
  assert.equal(prepares,2);
  active={passId:randomUUID()};
  assert.equal((await executeAssistantRuntimeRequest(request,dependencies)).structuredContent.code,'ASSISTANT_LOCAL_SETUP_TASK_ACTIVE');
  assert.equal(prepares,2,'an active task cannot create a local setup reservation');
  const before=contexts;
  await assert.rejects(executeAssistantRuntimeRequest({...request,arguments:{...request.arguments,localAccountId:randomUUID()}},dependencies),/ASSISTANT_SETUP_INVALID_INPUT/);
  assert.equal(contexts,before);
});

test('status returns native company locators without exposing policy/content or hiding a failed inventory',async()=>{
  const identity={origin:'https://company-discovery.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID();
  const native={structuredContent:{schemaVersion:1,assistantUserId:identity.assistantId,deviceId:identity.deviceId,businessReady:true},content:[]};
  let rows=[{companyId,companySlug:'native-company',memberId:randomUUID(),execution:{privateCanary:'PRIVATE_POLICY'},name:'PRIVATE_NAME'}],reads=0,result=native;
  const client={identity,readHealth:async()=>({code:'ready',revision:0,compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:null}}),
    reportHealth:async()=>{},companies:async()=>{reads++;if(rows instanceof Error)throw rows;return rows;}};
  const options={versions:()=>({pluginVersion:'3.2.3',hostRuntimeVersion:'3.20.1'}),context:async action=>action(client,{},{}),
    proxyFor:async()=>({callTool:async(name,args)=>{assert.equal(name,'get_assistant_status');assert.deepEqual(args,{});return result;}})};
  const request={operation:'call',name:'get_assistant_status',arguments:{}};
  const actual=await executeAssistantRuntimeRequest(request,options);
  assert.deepEqual(actual.structuredContent.companies,[{companyId,companySlug:'native-company'}]);
  assert.deepEqual(JSON.parse(actual.content[0].text),actual.structuredContent);
  assert.ok(!JSON.stringify(actual).includes('PRIVATE'));assert.equal(native.structuredContent.companies,undefined);
  rows=Object.assign(new Error('PRIVATE inventory failure'),{code:'ASSISTANT_SOURCE_ACCESS_DENIED'});
  await assert.rejects(executeAssistantRuntimeRequest(request,options),error=>error.code==='ASSISTANT_SOURCE_ACCESS_DENIED');
  rows=[];assert.deepEqual((await executeAssistantRuntimeRequest(request,options)).structuredContent.companies,[]);
  result={isError:true,structuredContent:{code:'ASSISTANT_DEVICE_REQUIRED'},content:[]};const before=reads;
  assert.deepEqual(await executeAssistantRuntimeRequest(request,options),result);
  assert.equal(reads,before,'native denial performs no additional discovery');
});


const pluginUpdateFixture=()=>{
  let state=null,current={state:'installed',version:'0.1.3',desiredVersion:'0.1.4',treeSha256:'a'.repeat(64)},
    generation='100:1000',starts=1,trusted=true,upgrades=0,installs=0;
  const effects=[];const identity={assistantId:randomUUID(),deviceId:randomUUID()};
  const options={identity,readState:async()=>structuredClone(state),writeState:async(expected,next)=>{
    assert.deepEqual(expected,state);state=structuredClone(next);
  },inventory:async()=>({...current}),upgrade:async(version,before)=>{
    upgrades++;if(current.desiredVersion===version)return {unchanged:true};
    await before(current.desiredVersion);assert.equal(state.stage,'installing');installs++;
    current={...current,version:current.desiredVersion,treeSha256:'b'.repeat(64)};return {version:current.version};
  },desktop:async(operation,expected)=>{
    effects.push(operation);
    if(operation==='close'){assert.equal(state.stage,'closing');assert.equal(generation,expected);generation=null;}
    if(operation==='start'){assert.equal(state.stage,'verifying');generation=`${++starts*100}:${starts*1000}`;}
    return {state:generation?'running':'stopped',generation};
  },probe:async()=>{effects.push('probe');if(!trusted)throw Object.assign(new Error(),{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});},guard:async()=>{}};
  return {options,effects,state:()=>state,current:()=>current,generation:value=>{generation=value;},trust:value=>{trusted=value;},counts:()=>({upgrades,installs})};
};

test('plugin update is one native installation and graceful GUI restart, then current cycles do no GUI work',async()=>{
  const f=pluginUpdateFixture();assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'updated',version:'0.1.4'});
  assert.equal(f.state().stage,'ready');assert.equal(f.counts().installs,1);
  assert.deepEqual(f.effects,['inspect','close','inspect','inspect','start','inspect','probe']);
  f.effects.length=0;assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'current',version:'0.1.4'});
  assert.deepEqual(f.effects,[]);assert.equal(f.counts().installs,1);
});

test('changed hooks wait durably for native human trust; approval resumes without reinstall/restart or config writes',async()=>{
  const f=pluginUpdateFixture();f.trust(false);
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'hook_review',blockBusiness:true});
  assert.equal(f.state().stage,'hook_review');f.effects.length=0;
  await maintainAssistantPlugin(f.options);assert.deepEqual(f.effects,['inspect','probe']);
  f.trust(true);f.effects.length=0;
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'updated',version:'0.1.4'});
  assert.deepEqual(f.effects,['inspect','probe']);assert.deepEqual(f.counts(),{upgrades:3,installs:1});
});

test('asynchronous Windows activation is observed on a later tick without a second launch in the same tick',async()=>{
  const f=pluginUpdateFixture(),desktop=f.options.desktop;let launches=0;
  f.options.desktop=async(operation,...args)=>{
    if(operation==='start'){
      launches++;assert.equal(f.state().stage,'verifying');f.generation(null);
      return {state:'starting',generation:null};
    }
    return desktop(operation,...args);
  };
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'activating',blockBusiness:true});
  assert.equal(launches,1);assert.equal(f.state().restarts,1);assert.equal(f.state().failures,0);
  f.generation('200:2000');
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'updated',version:'0.1.4'});
  assert.equal(launches,1);assert.equal(f.counts().installs,1);
});

test('an optional marketplace outage leaves the verified current plugin usable before any install intent',async()=>{
  const f=pluginUpdateFixture();f.options.upgrade=async()=>{throw Error('synthetic network outage before install');};
  for(let i=0;i<4;i++)assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'current',version:'0.1.3',updateDeferred:true});
  assert.equal(f.state().stage,'ready');assert.equal(f.state().failures,0);assert.equal(f.counts().installs,0);
  assert.deepEqual(f.effects,[]);
});

test('plugin activation durably hands off the registered supervisor before business resumes, without replacing its task chat',async()=>{
  const f=pluginUpdateFixture();let freshParent=false,activations=0;
  f.options.activateHost=async installed=>{
    assert.equal(f.state().stage,'retargeting');assert.equal(installed.version,'0.1.4');activations++;
    return {state:freshParent?'current':'handoff'};
  };
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'host_handoff',blockBusiness:true});
  assert.equal(f.state().stage,'retargeting');assert.equal(activations,1);
  freshParent=true;
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'updated',version:'0.1.4'});
  assert.equal(f.state().stage,'ready');assert.equal(f.counts().installs,1);
  assert.equal(f.effects.filter(value=>value==='close').length,1);
  assert.equal(f.effects.filter(value=>value==='start').length,1);assert.equal(activations,2);
});

test('a registered host handoff tells the existing parent to quiesce before polling or starting business work',async()=>{
  let closed=0;
  const result=await runAssistantBackgroundTick({createHost:async()=>({close:async()=>{closed++;},coordinator:{
    pollOnce:()=>assert.fail('handoff cannot poll'),workOnce:()=>assert.fail('handoff cannot start work')
  }}),pluginMaintenance:async()=>({state:'host_handoff',blockBusiness:true})});
  assert.deepEqual(result,{schemaVersion:1,state:'quiescing'});assert.equal(closed,1);
});

test('a legacy parent bootstraps the current registered implementation without a marketplace network check',async()=>{
  const f=pluginUpdateFixture();Object.assign(f.current(),{desiredVersion:'0.1.3'});f.options.bootstrapHost=true;
  f.options.upgrade=()=>assert.fail('bootstrap must remain reachable while optional Git discovery is offline');
  f.options.activateHost=async()=>({state:'handoff'});
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'host_handoff',blockBusiness:true});
  assert.equal(f.state().targetVersion,'0.1.3');assert.equal(f.state().stage,'retargeting');assert.deepEqual(f.effects,[]);
});

test('a positively busy setup/coordinator defers maintenance without reporting a false update failure',async()=>{
  const {runProductionAssistantPluginMaintenance}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  for(const code of ['TRELIO_RUNTIME_LOCK_TIMEOUT','ASSISTANT_COORDINATOR_BUSY']){
    const runtime={coordinator:{maintainPluginAtIdleBoundary:async()=>{throw Object.assign(new Error(),{code});}}};
    assert.deepEqual(await runProductionAssistantPluginMaintenance(runtime,{platform:'win32',context:async()=>true}),
      {state:'deferred',blockBusiness:true});
  }
});

test('supervisor generations use the protected identity namespace without granting hook or task authority',async()=>{
  const {host,files}=memorySetupHost({get:async()=>null});const identity={origin:'https://trelio.ru',assistantId:randomUUID(),deviceId:randomUUID()};
  await host.saveIdentity(identity);assert.equal(await host.readPluginSupervisor(),null);
  const generation=randomUUID();await host.recordPluginSupervisor('3.21.0',generation,identity);
  assert.equal((await host.readPluginSupervisor()).generation,generation);assert.equal(await host.readPluginUpdatesEnabled(),false);
  await assert.rejects(host.recordPluginSupervisor('3.21.0',generation,{...identity,deviceId:randomUUID()}),/REBIND_REQUIRED/);
  const identityPath=[...files.keys()].find(name=>path.basename(name)==='identity.json');
  files.set(identityPath,{schemaVersion:1,...identity,deviceId:randomUUID()});assert.equal(await host.readPluginSupervisor(),null);
});

test('the live parent can recover an unavailable fresh worker through maintenance without replaying the request',async()=>{
  const controller=new AbortController();let requests=0,repairs=0,recorded=null;
  const identity={assistantId:randomUUID(),deviceId:randomUUID()};
  const result=await runAssistantBackground({signal:controller.signal,readHost:async()=>({identity,activation:null}),
    verifyRegistration:async()=>{},startConsoleIcon:async()=>null,recordSupervisor:async(value,generation)=>{assert.deepEqual(value,identity);recorded=generation;},
    request:async(_request,options)=>{requests++;assert.equal(options.environment.TRELIO_ASSISTANT_SUPERVISOR_GENERATION,recorded);
      throw Object.assign(new Error(),{code:'ASSISTANT_RUNTIME_REQUEST_UNAVAILABLE'});},reportFailure:async()=>{},
    maintainUnavailableWorker:async({environment})=>{repairs++;assert.equal(environment.TRELIO_ASSISTANT_SUPERVISOR_GENERATION,recorded);return {state:'host_handoff'};},
    wait:()=>assert.fail('a positively registered handoff exits this parent immediately')});
  assert.equal(result.state,'stopped');assert.equal(requests,1);assert.equal(repairs,1);
});

test('a failed activation stays blocked for the same version but a newer release can recover without replacing the rollback basis',async()=>{
  const f=pluginUpdateFixture(),desktop=f.options.desktop;
  f.options.desktop=async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_PLUGIN_DESKTOP_UNAVAILABLE'});};
  // No rollback implementation: retain the failed original candidate. Nothing
  // silently treats that failed native installation as a verified ready one.
  for(let i=0;i<2;i++)assert.equal((await maintainAssistantPlugin(f.options)).state,'retrying');
  await assert.rejects(maintainAssistantPlugin(f.options),{code:'ASSISTANT_PLUGIN_DESKTOP_UNAVAILABLE'});
  assert.equal(f.state().stage,'failed');assert.equal(f.state().failedVersion,'0.1.4');
  f.options.desktop=desktop;
  await assert.rejects(maintainAssistantPlugin(f.options),{code:'ASSISTANT_PLUGIN_UPDATE_FAILED'});
  assert.equal(f.counts().installs,1);
  Object.assign(f.current(),{desiredVersion:'0.1.5'});
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'updated',version:'0.1.5'});
  assert.equal(f.state().previousVersion,'0.1.3');assert.equal(f.state().previousTreeSha256,'a'.repeat(64));
  assert.equal(f.counts().installs,2);
});

test('an installed-tree mismatch is never treated as an optional marketplace outage',async()=>{
  const f=pluginUpdateFixture();Object.assign(f.current(),{desiredVersion:'0.1.3'});
  assert.equal((await maintainAssistantPlugin(f.options)).state,'current');
  Object.assign(f.current(),{treeSha256:'b'.repeat(64)});
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'retrying',blockBusiness:true});
  assert.equal(f.counts().installs,0);assert.deepEqual(f.effects,[]);
});

test('lost install reply reconciles the exact installed version after restart, with zero native installation replay',async()=>{
  const f=pluginUpdateFixture(),upgrade=f.options.upgrade;
  f.options.upgrade=async(...args)=>{await upgrade(...args);throw Error('synthetic lost install acknowledgement');};
  assert.equal((await maintainAssistantPlugin(f.options)).state,'retrying');assert.equal(f.state().stage,'installing');
  f.options.upgrade=()=>assert.fail('must read native outcome, not install again');
  assert.equal((await maintainAssistantPlugin(f.options)).state,'updated');assert.equal(f.counts().installs,1);
});

test('lost close/start replies preserve their journal and inspect the process generation instead of replaying an effect',async()=>{
  for(const operation of ['close','start']){
    const f=pluginUpdateFixture(),desktop=f.options.desktop;let lost=true;
    f.options.desktop=async(...args)=>{const result=await desktop(...args);if(args[0]===operation&&lost){lost=false;throw Error('lost native reply');}return result;};
    assert.equal((await maintainAssistantPlugin(f.options)).state,'retrying');
    assert.equal((await maintainAssistantPlugin(f.options)).state,'updated');
    assert.equal(f.effects.filter(value=>value===operation).length,1);assert.equal(f.counts().installs,1);
  }
});

test('disabled native plugin and changed identity/pass fence cannot install, close GUI or alter hook trust',async()=>{
  const f=pluginUpdateFixture();f.options.inventory=async()=>({state:'disabled'});
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'disabled',blockBusiness:true});
  assert.equal(f.state(),null);assert.deepEqual(f.effects,[]);
  f.options.guard=async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_HOST_REBIND_REQUIRED'});};
  await assert.rejects(maintainAssistantPlugin(f.options),{code:'ASSISTANT_HOST_REBIND_REQUIRED'});
  assert.deepEqual(f.counts(),{upgrades:0,installs:0});
});

test('plugin journal has identity/CAS/read-back and never accepts hook trust, commands, paths or company content',async()=>{
  const {host}=memorySetupHost({get:async()=>null});const identity={origin:'https://trelio.ru',assistantId:randomUUID(),deviceId:randomUUID()};
  await host.saveIdentity(identity);assert.equal(await host.readPluginUpdate(),null);
  const record={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,previousVersion:'0.1.3',targetVersion:'0.1.4',
    targetTreeSha256:'a'.repeat(64),previousTreeSha256:'a'.repeat(64),failedVersion:null,failures:0,stage:'installing',desktopGeneration:null,restarts:0};
  await host.writePluginUpdate(null,record);assert.deepEqual(await host.readPluginUpdate(),record);
  await assert.rejects(host.writePluginUpdate(null,record),/STATE_INVALID/);
  for(const patch of [{trusted:true},{command:'private'},{path:'private'},{targetVersion:'../bad'},{restarts:3},{assistantId:randomUUID()}])
    await assert.rejects(host.writePluginUpdate(record,{...record,...patch}));
});

test('Desktop helper has only fixed registered package and graceful close, with closed pipe projection',async()=>{
  const operations=[];
  const result=await runAssistantWindowsDesktop('close','100:1000',{readPackagePath:async()=> 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1',
    runNative:async(plan,options)=>{operations.push(plan);assert.equal(options.script,ASSISTANT_WINDOWS_DESKTOP_SCRIPT);
      assert.throws(()=>options.project({schemaVersion:1,state:'running',generation:'private path'}));
      assert.deepEqual(options.nativeCommand.args,['--codex-desktop-close','100:1000']);
      return options.project({schemaVersion:1,state:'stopped',generation:null});}});
  assert.equal(result.state,'stopped');assert.equal(operations.length,1);
  await runAssistantWindowsDesktop('inspect',null,{readPackagePath:async()=> 'C:/fixed',
    runNative:async(_plan,options)=>{assert.deepEqual(options.nativeCommand.args,['--codex-desktop-inspect']);
      return options.project({schemaVersion:1,state:'running',generation:'100:1000'});}});
  assert.doesNotMatch(ASSISTANT_WINDOWS_DESKTOP_SCRIPT,/Stop-Process|taskkill|TerminateProcess|trusted_hash|config\.toml|SendKeys/);
  assert.doesNotMatch(ASSISTANT_WINDOWS_DESKTOP_SCRIPT,/CloseMainWindow|WaitForExit/);
  // No window-only fallback: generation-less/extra operations fail before any
  // worker launch, and the existing idle guard still precedes native close.
  await assert.rejects(runAssistantWindowsDesktop('close',null,{readPackagePath:()=>assert.fail('invalid generation before IO')}),/STATE_INVALID/);
  await assert.rejects(runAssistantWindowsDesktop('close','100:1000',{readPackagePath:async()=> 'C:\\fixed',
    guard:async()=>{throw Object.assign(Error(),{code:'SYNTHETIC_NOT_IDLE'});},runNative:()=>assert.fail('must not close')}),{code:'SYNTHETIC_NOT_IDLE'});
  await assert.rejects(runAssistantWindowsDesktop('kill'),/STATE_INVALID/);
});


test('bounded failed activation rolls back exact previous tree and latches the failed version without repeated installation',async()=>{
  const f=pluginUpdateFixture();let rollbacks=0,good=false;
  f.options.probe=async()=>{if(!good)throw Object.assign(new Error(),{code:'ASSISTANT_MCP_RECONNECT_REQUIRED'});};
  f.options.rollback=async(version,hash)=>{rollbacks++;assert.equal(version,'0.1.3');assert.equal(hash,'a'.repeat(64));
    Object.assign(f.current(),{version,treeSha256:hash});return {...f.current()};};
  for(let i=0;i<3;i++)assert.equal((await maintainAssistantPlugin(f.options)).state,'retrying');
  assert.equal(rollbacks,1);assert.equal(f.state().failedVersion,'0.1.4');good=true;
  assert.equal((await maintainAssistantPlugin(f.options)).state,'rolled_back');
  f.effects.length=0;assert.equal((await maintainAssistantPlugin(f.options)).state,'current');
  assert.equal(rollbacks,1);assert.equal(f.counts().installs,1);assert.deepEqual(f.effects,[]);
});


test('a newer fix can replace an awaiting-hooks version without trusting it or adopting it as rollback basis',async()=>{
  const f=pluginUpdateFixture();f.trust(false);await maintainAssistantPlugin(f.options);
  Object.assign(f.current(),{desiredVersion:'0.1.5'});await maintainAssistantPlugin(f.options);
  assert.equal(f.state().targetVersion,'0.1.5');assert.equal(f.state().stage,'hook_review');
  assert.equal(f.state().previousVersion,'0.1.3');assert.equal(f.state().previousTreeSha256,'a'.repeat(64));
  assert.equal(f.counts().installs,2);f.trust(true);
  assert.equal((await maintainAssistantPlugin(f.options)).state,'updated');
  assert.equal(f.counts().installs,2);
});

test('old devices remain opted out and an explicit policy remains bound to the current protected identity',async()=>{
  const {host}=memorySetupHost({get:async()=>null});const identity={origin:'https://trelio.ru',assistantId:randomUUID(),deviceId:randomUUID()};
  await host.saveIdentity(identity);assert.equal(await host.readPluginUpdatesEnabled(),false);
  await host.setPluginUpdatesEnabled(true,identity);assert.equal(await host.readPluginUpdatesEnabled(),true);
  await assert.rejects(host.setPluginUpdatesEnabled(true,{...identity,deviceId:randomUUID()}),/REBIND_REQUIRED/);
  await host.setPluginUpdatesEnabled(false,identity);assert.equal(await host.readPluginUpdatesEnabled(),false);
  host.readActivePass=async()=>({kind:'task'});
  await assert.rejects(host.setPluginUpdatesEnabled(true,identity),{code:'ASSISTANT_LOCAL_SETUP_TASK_ACTIVE'});
  assert.equal(await host.readPluginUpdatesEnabled(),false);
});

test('explicit native-writable setup resumes only an untouched bootstrap, never a failed plugin or hook decision',async()=>{
  const {host}=memorySetupHost({get:async()=>null});
  const identity={origin:'https://trelio.ru',assistantId:randomUUID(),deviceId:randomUUID()};await host.saveIdentity(identity);
  const failed={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,
    previousVersion:'0.1.3',targetVersion:'0.1.3',previousTreeSha256:'a'.repeat(64),targetTreeSha256:'a'.repeat(64),
    stage:'failed',failures:3,restarts:0,desktopGeneration:null,failedVersion:'0.1.3'};
  await host.writePluginUpdate(null,failed);
  await host.setPluginUpdatesEnabled(true,identity);
  assert.deepEqual(await host.readPluginUpdate(),failed,'a bare policy write is not native registration evidence');
  await host.setPluginUpdatesEnabled(true,identity,{ownTaskWriteVerified:true});
  assert.deepEqual(await host.readPluginUpdate(),{...failed,stage:'retargeting',failures:0,failedVersion:null});
  const f=pluginUpdateFixture();Object.assign(f.current(),{desiredVersion:'0.1.3'});
  Object.assign(f.options,{identity,readState:()=>host.readPluginUpdate(),writeState:(a,b)=>host.writePluginUpdate(a,b),
    bootstrapHost:true,upgrade:()=>assert.fail('bootstrap recovery never reinstalls the plugin'),activateHost:async()=>({state:'handoff'})});
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'host_handoff',blockBusiness:true});
  assert.deepEqual(f.effects,[]);assert.equal(f.counts().installs,0);
  for(const change of [
    {targetVersion:'0.1.4',targetTreeSha256:'b'.repeat(64),failedVersion:'0.1.4'},
    {failedVersion:'0.1.4'}, {stage:'hook_review',failedVersion:null}, {desktopGeneration:'100:1000',restarts:1},
  ]){
    const value={...failed,...change};await host.writePluginUpdate(await host.readPluginUpdate(),value);
    await host.setPluginUpdatesEnabled(true,identity,{ownTaskWriteVerified:true});assert.deepEqual(await host.readPluginUpdate(),value);
  }
});


test('re-pairing never adopts or destroys another device maintenance policy/journal',async()=>{
  const {host,files}=memorySetupHost({get:async()=>null});const identity={origin:'https://trelio.ru',assistantId:randomUUID(),deviceId:randomUUID()};
  await host.saveIdentity(identity);await host.setPluginUpdatesEnabled(true,identity);
  const saved=[...files.entries()].filter(([name])=>name.endsWith('policy.json'));
  const identityPath=[...files.keys()].find(name=>path.basename(name)==='identity.json');
  files.set(identityPath,{schemaVersion:1,...identity,deviceId:randomUUID()});
  assert.equal(await host.readPluginUpdatesEnabled(),false);assert.equal(await host.readPluginUpdate(),null);
  assert.deepEqual([...files.entries()].filter(([name])=>name.endsWith('policy.json')),saved);
});

test('unpublished newer main defers without burning its intent or clearing the previous failed-version latch',async()=>{
  const f=pluginUpdateFixture();Object.assign(f.current(),{desiredVersion:'0.1.3'});
  await maintainAssistantPlugin(f.options);
  await f.options.writeState(f.state(),{...f.state(),failedVersion:'0.1.4'});
  Object.assign(f.current(),{desiredVersion:'0.1.5'});f.effects.length=0;
  let published=false;const upgrade=f.options.upgrade;
  f.options.upgrade=async(current,before)=>published?upgrade(current,before):{unchanged:true,publicationPending:true};
  const saved=structuredClone(f.state());
  for(let i=0;i<4;i++)assert.deepEqual(await maintainAssistantPlugin(f.options),
    {state:'current',version:'0.1.3',updateDeferred:true,failedVersion:'0.1.4'});
  assert.deepEqual(f.state(),saved);assert.equal(f.counts().installs,0);assert.deepEqual(f.effects,[]);
  published=true;assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'updated',version:'0.1.5'});
  assert.equal(f.counts().installs,1);assert.equal(f.state().failedVersion,null);
});

test('unpublished hook dependency retains the same installed candidate until one native add and human review',async()=>{
  const f=pluginUpdateFixture(),requirement={pluginId:'trelio-digital-assistant-hooks@trelio-digital-assistants',version:'0.1.0',integritySha256:'c'.repeat(64)};
  const upgrade=f.options.upgrade;f.options.upgrade=async(...args)=>{const result=await upgrade(...args);f.current().hookComponent=requirement;return result;};
  let published=false,present=false,adds=0;
  f.options.hooks=async(operation,_expected,before)=>{
    if(operation==='inspect')return {matches:present};
    if(present)return {matches:true,unchanged:true};
    if(!published)return {matches:false,unchanged:true,publicationPending:true};
    await before({...requirement,previousVersion:null});adds++;present=true;return {matches:true};
  };
  assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'deferred',blockBusiness:true});
  const saved=structuredClone(f.state());assert.equal(saved.stage,'installed');assert.equal(saved.failures,0);assert.equal(adds,0);
  for(let i=0;i<4;i++)assert.deepEqual(await maintainAssistantPlugin(f.options),{state:'deferred',blockBusiness:true});
  assert.deepEqual(f.state(),saved);assert.deepEqual(f.effects,[]);assert.equal(f.counts().installs,1);
  published=true;f.trust(false);
  assert.equal((await maintainAssistantPlugin(f.options)).state,'hook_review');assert.equal(adds,1);
  f.trust(true);assert.equal((await maintainAssistantPlugin(f.options)).state,'updated');assert.equal(adds,1);
});

test('stable hook install survives lost reply by read-back only, then native trust resumes the SAME update',async()=>{
  const f=pluginUpdateFixture(),requirement={pluginId:'trelio-digital-assistant-hooks@trelio-digital-assistants',version:'0.1.0',integritySha256:'c'.repeat(64)};
  const upgrade=f.options.upgrade;f.options.upgrade=async(...args)=>{const result=await upgrade(...args);f.current().hookComponent=requirement;return result;};
  let component=false,adds=0,reads=0;
  f.options.hooks=async(operation,expected,beforeInstall)=>{
    assert.deepEqual(expected,requirement);
    if(operation==='inspect'){reads++;return {matches:component};}
    if(component)return {matches:true,unchanged:true};
    await beforeInstall({...requirement,previousVersion:null});assert.equal(f.state().stage,'hook_installing');
    adds++;component=true;throw Error('synthetic lost native reply');
  };
  f.trust(false);
  assert.equal((await maintainAssistantPlugin(f.options)).state,'retrying');assert.equal(f.state().stage,'hook_installing');assert.equal(adds,1);
  assert.equal((await maintainAssistantPlugin(f.options)).state,'hook_review');assert.equal(reads,1);assert.equal(adds,1);
  f.trust(true);assert.equal((await maintainAssistantPlugin(f.options)).state,'updated');
  assert.equal(adds,1);assert.equal(f.counts().installs,1);assert.equal(f.state().stage,'ready');
  assert.equal(f.effects.filter(e=>e==='close').length,1);assert.equal(f.effects.filter(e=>e==='start').length,1);
});

test('unknown hook dependency install neither replays add nor rolls back into duplicate legacy hooks',async()=>{
  const f=pluginUpdateFixture(),requirement={pluginId:'trelio-digital-assistant-hooks@trelio-digital-assistants',version:'0.1.0',integritySha256:'c'.repeat(64)};
  const upgrade=f.options.upgrade;f.options.upgrade=async(...args)=>{const result=await upgrade(...args);f.current().hookComponent=requirement;return result;};
  let adds=0;f.options.rollback=()=>assert.fail('a dependency-changing update cannot restore a combined legacy hook plugin');
  f.options.hooks=async(operation,_expected,beforeInstall)=>{
    if(operation==='inspect')return {matches:false};
    await beforeInstall({...requirement,previousVersion:null});adds++;throw Error('synthetic unknown native result');
  };
  assert.equal((await maintainAssistantPlugin(f.options)).state,'retrying');
  assert.equal((await maintainAssistantPlugin(f.options)).state,'retrying');
  await assert.rejects(maintainAssistantPlugin(f.options),{code:'ASSISTANT_PLUGIN_UPDATE_FAILED'});
  assert.equal(adds,1);assert.equal(f.state().stage,'failed');assert.equal(f.effects.length,0,'no Desktop or business operation follows unknown installation');
});

test('a legacy worker waiting for missing main hooks can prepare the new dependency without an endless review loop',async()=>{
  const f=pluginUpdateFixture();f.trust(false);
  assert.equal((await maintainAssistantPlugin(f.options)).state,'hook_review');
  const requirement={pluginId:'trelio-digital-assistant-hooks@trelio-digital-assistants',version:'0.1.0',integritySha256:'c'.repeat(64)};
  f.current().hookComponent=requirement;let present=false,adds=0;
  f.options.hooks=async(operation,_expected,before)=>{
    if(operation==='inspect')return {matches:present};
    if(present)return {matches:true,unchanged:true};
    await before({...requirement,previousVersion:null});adds++;present=true;return {matches:true};
  };
  assert.equal((await maintainAssistantPlugin(f.options)).state,'hook_review');assert.equal(adds,1);
  f.trust(true);assert.equal((await maintainAssistantPlugin(f.options)).state,'updated');assert.equal(adds,1);
  assert.equal(f.counts().installs,1,'a main package already installed by the prior worker is never installed again');
});
