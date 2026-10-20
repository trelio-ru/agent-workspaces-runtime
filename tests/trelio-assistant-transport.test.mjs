import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes, generateKeyPairSync, verify } from 'node:crypto';
import { createAssistantHttp, createAssistantDeviceClient, createAssistantPairingClient, AssistantTransportError, createAssistantMcpClient } from '../host-runtime/scripts/trelio-assistant-transport.mjs';

const memoryStore = () => {
  const values=new Map(); const key=input=>JSON.stringify(input);
  return { get:async input=>structuredClone(values.get(key(input))??null),
    put:async(input,value)=>values.set(key(input),structuredClone(value)),remove:async input=>values.delete(key(input)) };
};
test('fixed HTTPS requests omit cookies, refuse redirects and redact raw failures', async () => {
  let count=0;
  const http=createAssistantHttp({ origin:'https://assistant.test',fetchImpl:async(url,options)=>{
    count++; assert.equal(url,'https://assistant.test/api/digital-assistants/runtime/companies');
    assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit'); assert.equal(options.cache,'no-store');
    assert.equal(options.headers.authorization,`Bearer tda_${'a'.repeat(43)}`);
    return new Response(JSON.stringify({code:'ASSISTANT_DEVICE_REVOKED',message:'PRIVATE SERVER TEXT'}),{status:401,headers:{'content-type':'application/json'}});
  } });
  await assert.rejects(http('companies',undefined,`tda_${'a'.repeat(43)}`),error=>error.code==='ASSISTANT_DEVICE_REVOKED' && error.status===401 && !error.message.includes('PRIVATE'));
  await assert.rejects(http('https://other.test',{},`tda_${'a'.repeat(43)}`),/INVALID_INPUT/); assert.equal(count,1);
  await assert.rejects(http('companies',undefined),/INVALID_INPUT/);
  assert.throws(()=>createAssistantHttp({origin:'https://assistant.test/path'}),/INVALID_INPUT/);
  const broken=createAssistantHttp({origin:'https://assistant.test',fetchImpl:async()=>{throw new Error('PRIVATE URL TOKEN');}});
  await assert.rejects(broken('companies',undefined,`tda_${'a'.repeat(43)}`),error=>error.message==='ASSISTANT_TRANSPORT_UNAVAILABLE');
});

test('device client loads only its exact private slot and projects server content away', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),memberId=randomUUID();
  const store=memoryStore(); await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'a'.repeat(43)}`,expiresAt:10000});
  let calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,now:()=>100,http:async(operation,_body,credential)=>{
    calls++; assert.equal(operation,'companies'); assert.match(credential,/^tda_/u);
    return {assistantUserId:assistantId,bindingId:deviceId,companies:[{id:companyId,memberId,encryptionState:null,secret:'PRIVATE',slug:'PRIVATE'}]};
  }});
  assert.deepEqual(await client.companies(),[{companyId,memberId,encryptionState:null,execution:{state:'unconfigured',configuration:null,policyRevisionId:null}}]);
  const other=createAssistantDeviceClient({origin,assistantId,deviceId:randomUUID(),store,http:async()=>{calls++;},now:()=>100});
  await assert.rejects(other.companies(),/DEVICE_REQUIRED/); assert.equal(calls,1);
});

test('pairing persists verifier before I/O, handles pending and erases it after protected device save', async () => {
  const origin='https://assistant.test',enrollmentId=randomUUID(),pairingId=randomUUID(),assistantUserId=randomUUID(),deviceId=randomUUID();
  const store=memoryStore(); let exchanges=0,seenVerifier;
  const client=createAssistantPairingClient({origin,store,now:()=>100,http:async(operation,input)=>{
    const saved=await store.get({origin,kind:'pairing',id:enrollmentId});
    if(operation==='pair') {
      assert.equal(saved.phase,'prepared'); assert.equal(saved.verifier.length,43);
      return {pairingId,verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
    }
    assert.equal(saved.phase,'exchanging'); assert.equal(input.verifier,saved.verifier); seenVerifier=input.verifier;
    if(!exchanges++) throw new AssistantTransportError('ASSISTANT_STATE_CHANGED',409);
    return {assistantUserId,deviceId,credential:`tda_${'b'.repeat(43)}`,expiresAt:new Date(30000).toISOString()};
  }});
  const begin=await client.begin(enrollmentId,'Fixture'); assert.equal(begin.verificationCode,'ABCDEF12'); assert.doesNotMatch(JSON.stringify(begin),/verifier/);
  assert.deepEqual(await client.exchange(enrollmentId),{state:'pending'});
  assert.deepEqual(await client.exchange(enrollmentId),{state:'ready',origin,assistantId:assistantUserId,deviceId});
  assert.ok(!(JSON.stringify(await store.get({origin,kind:'pairing',id:enrollmentId}))).includes(seenVerifier));
  assert.match((await store.get({origin,kind:'device',id:assistantUserId})).credential,/^tda_/u);
});

test('lost exchange response is fenced across restarts and is never blindly repeated', async () => {
  const origin='https://assistant.test',enrollmentId=randomUUID(),store=memoryStore(); let exchanges=0;
  const http=async operation=>{
    if(operation==='pair') return {pairingId:randomUUID(),verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
    exchanges++; throw new Error('response lost after server commit');
  };
  const client=createAssistantPairingClient({origin,store,http,now:()=>100}); await client.begin(enrollmentId,'Fixture');
  await assert.rejects(client.exchange(enrollmentId),/RECOVERY_REQUIRED/);
  const restarted=createAssistantPairingClient({origin,store,http,now:()=>100});
  await assert.rejects(restarted.exchange(enrollmentId),/RECOVERY_REQUIRED/); assert.equal(exchanges,1);
});


test('owner renewal recovers the same device after its cached pairing expiry without local re-pairing', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  const original={assistantId,deviceId,credential:`tda_${'c'.repeat(43)}`,expiresAt:1};
  const slot={origin,kind:'device',id:assistantId}; await store.put(slot,original);
  let renewed=false,calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async(operation,body,credential)=>{
    calls++; assert.equal(operation,'heartbeat'); assert.equal(credential,original.credential);
    if(!renewed) throw new AssistantTransportError('ASSISTANT_ACCESS_DENIED',403);
    return {assistantUserId:assistantId,deviceId};
  }});
  await assert.rejects(client.heartbeat(),error=>error.code==='ASSISTANT_ACCESS_DENIED' && error.status===403);
  assert.deepEqual(await store.get(slot),original,'denial must not delete, replace or locally extend the credential');
  renewed=true;
  assert.deepEqual(await client.heartbeat(),{assistantId,deviceId});
  assert.equal(calls,2,'no hidden retry; only the next explicit polling pass contacts the server');
  assert.deepEqual(await store.get(slot),original,'server renewal needs no private store rewrite or key rotation');
});

test('task-pass and observed-runtime transport retain exact bindings and project away private server fields',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'x'.repeat(43)}`,expiresAt:1});
  const companyId=randomUUID(),taskId=randomUUID(),passId=randomUUID(),bindingId=randomUUID(),deliveryId=randomUUID(),threadId=randomUUID();
  const observation={schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook',observedAt:new Date().toISOString()};
  const sessionId=randomUUID();let mismatch=false;const operations=[];
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async(operation,input)=>{
    operations.push(operation);
    if(operation==='passBegin'||operation==='passRead')return {passId,bindingId,bindingRevision:3,deliveryId,threadId,state:'leased',leaseRevision:0,
      leaseExpiresAt:new Date(Date.now()+60000).toISOString(),execution:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1},secret:'PRIVATE'};
    if(operation==='passRenew')return {passId,leaseRevision:input.expectedLeaseRevision+1,leaseExpiresAt:new Date(Date.now()+60000).toISOString(),state:'leased',execution:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1}};
    if(operation==='endRuntime')return {ended:true,secret:'PRIVATE'};
    assert.equal(operation,'registerRuntime');
    return {schemaVersion:1,passId:input.passId,runtimeSessionId:sessionId,conversation:{provider:'codex',conversationId:mismatch?randomUUID():threadId,
      openProtocol:'codex-thread-v1'},expiresAt:new Date(Date.now()+300000).toISOString(),observation:input.observation,runtimeRefreshSupported:true,secret:'PRIVATE'};
  }});
  const begin=await client.beginTaskPass({companyId,taskId,bindingId,bindingRevision:3,deliveryId,threadId});
  assert.equal(begin.passId,passId);assert.ok(!JSON.stringify(begin).includes('PRIVATE'));
  assert.deepEqual(begin.execution,{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1});
  const locator={companyId,taskId,passId};assert.equal((await client.readTaskPass(locator)).threadId,threadId);
  assert.equal((await client.renewTaskPass({...locator,expectedLeaseRevision:0,clientRequestId:randomUUID()})).leaseRevision,1);
  const request={...locator,clientSessionId:threadId,observation,publicKeySpki:'a'.repeat(59)};
  const registered=await client.registerRuntime(request);assert.equal(registered.runtimeSessionId,sessionId);
  assert.ok(!JSON.stringify(registered).includes('PRIVATE'));mismatch=true;
  await assert.rejects(client.registerRuntime(request),/INVALID_RESPONSE/);
  await assert.rejects(client.registerRuntime({...request,observation:{...observation,source:'agent_request'}}),/INVALID_INPUT/);
  assert.deepEqual(await client.endRuntime({...locator,runtimeSessionId:sessionId}),{ended:true});
  assert.deepEqual(operations,['passBegin','passRead','passRenew','registerRuntime','registerRuntime','endRuntime']);
});

test('fresh company execution state is projected without accepting local defaults or private metadata',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),taskId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'v'.repeat(43)}`,expiresAt:1});
  const selected={id:randomUUID(),modelId:'gpt-6.1-sol',effortLevel:'high',revision:3,secret:'PRIVATE'};
  let execution={state:'ready',configuration:selected,policyRevisionId:randomUUID(),content:'PRIVATE'};
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async()=>({
    binding:{id:randomUUID(),taskId,state:'accepted',revision:2},hostState:'this_device',execution,
  })});
  const projected=await client.task(companyId,taskId);
  assert.deepEqual(projected.execution.configuration,{modelId:selected.modelId,effortLevel:'high',revision:3});
  assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
  execution={...execution,state:'policy_blocked'};
  assert.equal((await client.task(companyId,taskId)).execution.state,'policy_blocked');
  execution={...execution,configuration:{...selected,effortLevel:'high\n--flag'}};
  await assert.rejects(client.task(companyId,taskId),/INVALID_RESPONSE/);
});

test('business outcome read is fixed, exact and strict; pending never implies failure or permits a retry',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'o'.repeat(43)}`,expiresAt:1});
  const expected={assistantId,deviceId,companyId:randomUUID(),taskId:randomUUID(),bindingId:randomUUID(),
    bindingRevision:2,deliveryId:randomUUID(),threadId:randomUUID()};
  let value={schemaVersion:1,state:'pending'},calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:createAssistantHttp({origin,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,origin+'/api/digital-assistants/runtime/task-pass/outcome');assert.equal(options.method,'POST');
    assert.deepEqual(JSON.parse(options.body),Object.fromEntries(Object.entries(expected).filter(([key])=>!['assistantId','deviceId'].includes(key))));
    return Response.json(value);
  }})});
  assert.deepEqual(await client.readBusinessOutcome(expected),value);assert.equal(calls,1);
  value={schemaVersion:1,state:'confirmed',receiptId:randomUUID(),...expected,
    continuation:{goalState:'waiting_external',cadence:'weekly',timeZone:'Europe/Moscow'}};
  assert.deepEqual(await client.readBusinessOutcome(expected),value);assert.equal(calls,2);
  const good=value;
  for(const bad of [{...good,taskId:randomUUID()},{...good,body:'PRIVATE'},
    {...good,continuation:{...good.continuation,cadence:'every_second'}},{schemaVersion:1,state:'pending',receiptId:randomUUID()}]) {
    value=bad;await assert.rejects(client.readBusinessOutcome(expected),/INVALID_RESPONSE/);
  }
  assert.equal(calls,6,'one request per explicit read; malformed outcomes do not cause a hidden retry');
  await assert.rejects(client.readBusinessOutcome({...expected,assistantId:randomUUID()}),/INVALID_INPUT/);assert.equal(calls,6);
});


test('assistant MCP reuses the bounded protocol with its real device profile and no schema copies or hidden retry', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  const credential=`tda_${'z'.repeat(43)}`;
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential,expiresAt:1});
  const {buildRemoteMcpRequestHeaders,validateRemoteMcpPublicationConfig}=await import('../host-runtime/scripts/trelio-remote-mcp.mjs');
  const calls=[];let echoed=false,broken=false,receivedArgs;
  const shape={type:'object',properties:{taskPass:{},runtimeSessionProof:{}},additionalProperties:false};
  const client=createAssistantMcpClient({origin,assistantId,deviceId,store,httpRequest:async(input,{signal})=>{
    assert.ok(signal);assert.equal(input.config.endpoint,origin+'/mcp/assistant');assert.equal(input.config.authentication.type,'assistant_device');
    assert.equal(buildRemoteMcpRequestHeaders({...input,body:null}).authorization,`Bearer ${credential}`);
    assert.equal(input.credential,credential);calls.push(input.method??input.payload.method);
    if(broken)throw new Error('PRIVATE HTTP DETAIL');
    const response=result=>({sessionId:'fixture-session',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE')return response({});
    if(input.payload.method==='initialize')return response({protocolVersion:'2025-06-18'});
    if(input.payload.method==='notifications/initialized')return response({});
    if(input.payload.method==='tools/list')return response({tools:[
      {name:'get_assistant_status',description:'Live status',inputSchema:shape,_meta:{private:'DO_NOT_PROXY_METADATA'}},
      {name:'get_task',description:'Live backend schema',inputSchema:shape},
      {name:'human_login',description:'Never delegate this',inputSchema:shape},
      {name:'create_comment',description:'Current assistant backend write',inputSchema:shape,annotations:{idempotentHint:true}},
      {name:'continue_assistant_workspace_action',description:'Current local action',inputSchema:shape,annotations:{idempotentHint:false}},
      {name:'update_task_due_date',description:'Sensitive; must remain closed',inputSchema:shape},
    ]});
    assert.equal(input.payload.method,'tools/call');receivedArgs=input.payload.params.arguments;
    return response({content:[{type:'text',text:echoed?credential:'native content'}],structuredContent:{schemaVersion:3},_meta:{discard:true}});
  }});
  const tools=await client.listTools();assert.deepEqual(tools.map(tool=>tool.name),['get_assistant_status','get_task','create_comment','continue_assistant_workspace_action']);
  assert.deepEqual(tools[1].inputSchema,{type:'object',properties:{},additionalProperties:false});
  assert.deepEqual(Object.keys(shape.properties),['taskPass','runtimeSessionProof']);
  assert.equal(tools[2].annotations.idempotentHint,true);assert.equal(tools[3].annotations.idempotentHint,false);assert.ok(!JSON.stringify(tools).includes('DO_NOT_PROXY_METADATA'));
  const args={taskPass:{passId:randomUUID()},runtimeSessionProof:{signature:'original'}};
  const resultPromise=client.callTool('get_task',args);args.runtimeSessionProof.signature='changed';
  const result=await resultPromise;assert.equal(receivedArgs.runtimeSessionProof.signature,'original');
  assert.equal(result.content[0].text,'native content');assert.ok(!('_meta' in result));
  assert.deepEqual(calls,['initialize','notifications/initialized','tools/list','DELETE','initialize','notifications/initialized','tools/call','DELETE']);
  const count=calls.length;await assert.rejects(client.callTool('update_task_due_date',{}),/CAPABILITY_UNAVAILABLE/);assert.equal(calls.length,count);
  assert.equal(tools[2].annotations.readOnlyHint,false);
  const beforeWrite=calls.length;
  const body={bodyMarkdown:'Scoped working update',clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  await client.callTool('create_comment',body);
  assert.deepEqual(receivedArgs,body,'the current backend owns validation; the host adds no human approval flags');
  assert.equal(calls.slice(beforeWrite).filter(name=>name==='tools/call').length,1,'one write is never replayed');
  echoed=true;await assert.rejects(client.callTool('get_task',{}),/INVALID_RESPONSE/);
  broken=true;await assert.rejects(client.callTool('get_task',{}),error=>error.code==='ASSISTANT_MCP_UNAVAILABLE'&&!error.message.includes('PRIVATE'));
  assert.equal((await store.get({origin,kind:'device',id:assistantId})).credential,credential,'failure preserves the exact pairing');
  assert.throws(()=>validateRemoteMcpPublicationConfig({schemaVersion:1,endpoint:origin+'/mcp/assistant',transport:'streamable_http',
    protocolVersion:'2025-03-26',authentication:{type:'assistant_device'},headers:{},allowedTools:['get_task']}),
    error=>error.code==='REMOTE_MCP_UNSUPPORTED_AUTH', 'public Remote MCP declarations cannot request the trusted device profile');
});

test('assistant MCP shares one absolute network deadline and never retries a timed-out call',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'d'.repeat(43)}`,expiresAt:1});
  let calls=0;
  const client=createAssistantMcpClient({origin,assistantId,deviceId,store,timeoutMs:100,httpRequest:async(_input,{signal})=>{
    calls++;await new Promise((resolve,reject)=>{if(signal.aborted)reject(new Error('abort'));else signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});});
  }});
  const keepAlive=setTimeout(()=>{},1000);
  try{await assert.rejects(client.callTool('get_task',{}),/MCP_UNAVAILABLE/);assert.equal(calls,1);}
  finally{clearTimeout(keepAlive);}
});


import { AsyncResource } from 'node:async_hooks';
import path from 'node:path';
import os from 'node:os';
import { request as nativeWorkspaceRequest, requireToken as nativeWorkspaceToken } from '../host-runtime/scripts/trelio-workspace.mjs';
import { createAssistantWorkspaceProfile } from '../host-runtime/scripts/trelio-assistant-transport.mjs';
import { withWorkspaceExecutionProfile, currentWorkspaceExecutionProfile } from '../host-runtime/scripts/trelio-workspace.mjs';

const workspaceProfileFixture = async () => {
  const identity={schemaVersion:1,origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const pass={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,companyId:randomUUID(),taskId:randomUUID(),
    passId:randomUUID(),deliveryId:randomUUID(),threadId:randomUUID(),bindingId:randomUUID(),bindingRevision:1};
  const keys=generateKeyPairSync('ed25519'), store=memoryStore(), credential='tda_'+randomBytes(32).toString('base64url');
  const runtime={schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state:{runtimeSessionId:randomUUID(),
    expiresAt:new Date(Date.now()+300_000).toISOString(),privateKeyPkcs8:keys.privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'),
    observation:{schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook'}}};
  await store.put({origin:identity.origin,kind:'device',id:identity.assistantId},{assistantId:identity.assistantId,deviceId:identity.deviceId,credential,expiresAt:1});
  await store.put({origin:identity.origin,kind:'runtime',id:pass.passId},runtime);
  let active=pass, currentIdentity=identity, live=true, contacts=0;
  const host={readIdentity:async()=>currentIdentity,readActivePass:async()=>active};
  const client={readTaskPass:async()=>{contacts++;return {...pass,state:live?'leased':'closed',leaseExpiresAt:new Date(Date.now()+300_000).toISOString()};}};
  const profile=await createAssistantWorkspaceProfile({identity,store,host,client,lockDirectory:path.join(os.tmpdir(),'synthetic-assistant-workspace-locks'),lock:(_file,action)=>action()});
  return {identity,pass,keys,store,credential,runtime,profile,contacts:()=>contacts,
    changeIdentity:value=>{currentIdentity=value;},changePass:value=>{active=value;},close:()=>{live=false;}};
};

test('assistant profile reuses the native HTTP engine with private auth and one-use operation proofs',async()=>{
  const f=await workspaceProfileFixture(), originalFetch=globalThis.fetch, seen=[];
  globalThis.fetch=async(url,options)=>{
    seen.push({url,options});return new Response('{}',{headers:{'content-type':'application/json'}});
  };
  try {
    await withWorkspaceExecutionProfile(f.profile,async()=>{
      const token=await nativeWorkspaceToken(f.identity.origin);
      assert.equal(typeof token,'object');assert.ok(!JSON.stringify(token).includes(f.credential));
      const route='/api/agent-workspaces/runs/'+randomUUID()+'/candidate';
      await nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST',body:'immutable bundle',
        headers:{authorization:'Bearer UNTRUSTED',cookie:'UNTRUSTED','x-trelio-assistant-pass':'UNTRUSTED','x-trelio-assistant-proof':'UNTRUSTED'}});
      await nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST',body:'immutable bundle'});
      const nonces=new Set();
      for(const {url,options} of seen){
        assert.equal(url.origin,f.identity.origin);assert.ok(url.pathname.startsWith('/api/digital-assistants/runtime/workspace/'));
        assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.body,'immutable bundle');
        assert.equal(options.headers.get('cookie'),null);
        assert.equal(options.headers.get('authorization'),'Bearer '+f.credential);
        assert.deepEqual(JSON.parse(options.headers.get('x-trelio-assistant-pass')),{companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId});
        const proof=JSON.parse(options.headers.get('x-trelio-assistant-proof'));
        assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,'assistant_workspace_data_plane_candidate',proof.issuedAt,proof.nonce].join('\n')),
          f.keys.publicKey,Buffer.from(proof.signature,'base64url')),true);
        assert.ok(!JSON.stringify(proof).includes('privateKeyPkcs8'));nonces.add(proof.nonce);
      }
      assert.equal(nonces.size,2);assert.equal(f.contacts(),2);
      // Unknown routes/origins are refused before private access and HTTP.
      await assert.rejects(nativeWorkspaceRequest('https://other.test',token,route),/ORIGIN_DENIED/);
      for(const bad of ['/api/agent-workspaces/runs/id/cancel','/api/agent-workspaces/bridge-pairings','/api/agent-workspaces/runs/../candidate']){
        await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,bad));
      }
      assert.equal(seen.length,2);assert.equal(f.contacts(),2);
      assert.throws(()=>withWorkspaceExecutionProfile({...f.profile},async()=>{}),/profile is unavailable/);
    });
    assert.equal(currentWorkspaceExecutionProfile(),null);
    // A parallel/sequential ordinary call retains its original native path
    // and synthetic human auth, rather than inheriting this device's profile.
    await nativeWorkspaceRequest(f.identity.origin,'synthetic-human','/api/agent-workspaces/bridge-compatibility');
    assert.equal(seen.at(-1).url.pathname,'/api/agent-workspaces/bridge-compatibility');
    assert.equal(seen.at(-1).options.headers.get('authorization'),'Bearer synthetic-human');
  } finally {globalThis.fetch=originalFetch;}
});

test('assistant Workspace request refuses ended sessions, rebind and closed passes before mutation; no retry',async()=>{
  const f=await workspaceProfileFixture(), originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('synthetic network failure');};
  const slot={origin:f.identity.origin,kind:'runtime',id:f.pass.passId};
  try {
    await withWorkspaceExecutionProfile(f.profile,async()=>{
      const token=await nativeWorkspaceToken(f.identity.origin), route='/api/agent-workspaces/runs/'+randomUUID()+'/heartbeat';
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}));
      assert.equal(calls,1,'an uncertain native mutation is not repeated');
      await f.store.put(slot,{...f.runtime,ended:true});
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}),/SESSION_REQUIRED/);
      assert.equal(calls,1);
      await f.store.put(slot,f.runtime);
      f.changeIdentity({...f.identity,deviceId:randomUUID()});
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}),/BINDING_CHANGED/);
      f.changeIdentity(f.identity);f.changePass({...f.pass,passId:randomUUID()});
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}),/BINDING_CHANGED/);
      f.changePass(f.pass);f.close();
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}),/REVIEW_REQUIRED/);
      assert.equal(calls,1);
    });
  }finally{globalThis.fetch=originalFetch;}
});


test('parallel human requests are isolated and expired child async resources cannot fall back to human auth',async()=>{
  const f=await workspaceProfileFixture(), originalFetch=globalThis.fetch,seen=[];let child;
  globalThis.fetch=async(url,options)=>{seen.push({url,authorization:options.headers.get('authorization')});return new Response('{}');};
  let release,entered;const barrier=new Promise(resolve=>{release=resolve;}), ready=new Promise(resolve=>{entered=resolve;});
  try{
    const pending=withWorkspaceExecutionProfile(f.profile,async()=>{
      child=new AsyncResource('assistant-workspace-fixture');entered();await barrier;
      const token=await nativeWorkspaceToken(f.identity.origin);
      await nativeWorkspaceRequest(f.identity.origin,token,'/api/agent-workspaces/bridge-compatibility');
    });
    await ready;
    await nativeWorkspaceRequest(f.identity.origin,'synthetic-human','/api/agent-workspaces/bridge-compatibility');
    release();await pending;
    assert.equal(seen[0].url.pathname,'/api/agent-workspaces/bridge-compatibility');
    assert.equal(seen[0].authorization,'Bearer synthetic-human');
    assert.ok(seen[1].url.pathname.startsWith('/api/digital-assistants/runtime/workspace/'));
    assert.throws(()=>child.runInAsyncScope(()=>currentWorkspaceExecutionProfile()),/profile is unavailable/);
    assert.equal(currentWorkspaceExecutionProfile(),null);
  }finally{release();child?.emitDestroy();globalThis.fetch=originalFetch;}
});


test('assistant protected bootstrap specializes human-only clauses and never reads the human unfiled vault',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {readUnfiledResponseContext}=await import('../host-runtime/scripts/trelio-unfiled-context.mjs');
  const human=common.buildAgentWorkspaceRuntimeAgentsMarkdown();
  assert.equal(human,common.AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN);
  const assistant=common.buildAgentWorkspaceRuntimeAgentsMarkdown('WORKSPACE_CONTEXT.md',{assistant:true});
  assert.ok(assistant.includes('continue_assistant_workspace_action'));assert.ok(assistant.includes('complete_assistant_pass'));
  assert.ok(!assistant.includes('through `continue_trelio_workspace_action`'));
  assert.ok(!assistant.includes('`get_task_review_context`'));assert.ok(assistant.includes('pinned ../context/agent-instructions.md'));
  const profile={kind:'digital_assistant',requireToken:async()=>({}),prepareRequest:async()=>assert.fail('queue attempted HTTP')};
  const result=await common.withWorkspaceExecutionProfile(profile,()=>readUnfiledResponseContext('https://trelio.ru','fixture',{bridge:{
    currentWorkspaceExecutionProfile:common.currentWorkspaceExecutionProfile,
    readExistingBridgeSessionToken:async()=>assert.fail('assistant attempted human vault'),
  }}));
  assert.equal(result,undefined);
});


test('live assistant schema projection hides hook-owned required fields without copying domain validators',async()=>{
  const {assistantModelInputSchema}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const wire={type:'object',additionalProperties:false,required:['clientRequestId','taskPass'],properties:{
    clientRequestId:{type:'string',format:'uuid'},taskPass:{type:'object',required:['passId'],properties:{passId:{type:'string'}}},
    runtimeSessionProof:{type:'object'},parameters:{type:'object',properties:{summary:{type:'string',maxLength:16000}}},
  }};
  const snapshot=structuredClone(wire),model=assistantModelInputSchema(wire);
  assert.deepEqual(model.required,['clientRequestId']);assert.deepEqual(Object.keys(model.properties),['clientRequestId','parameters']);
  assert.deepEqual(model.properties.parameters,wire.properties.parameters);assert.equal(model.additionalProperties,false);
  assert.deepEqual(wire,snapshot,'the current backend schema remains the exact validation authority');
});
