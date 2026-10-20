import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
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
      {name:'create_comment',description:'Current assistant backend write',inputSchema:shape},
      {name:'update_task_due_date',description:'Sensitive; must remain closed',inputSchema:shape},
    ]});
    assert.equal(input.payload.method,'tools/call');receivedArgs=input.payload.params.arguments;
    return response({content:[{type:'text',text:echoed?credential:'native content'}],structuredContent:{schemaVersion:3},_meta:{discard:true}});
  }});
  const tools=await client.listTools();assert.deepEqual(tools.map(tool=>tool.name),['get_assistant_status','get_task','create_comment']);
  assert.deepEqual(tools[1].inputSchema,shape);assert.ok(!JSON.stringify(tools).includes('DO_NOT_PROXY_METADATA'));
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
