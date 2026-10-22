import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { createAssistantSetup } from '../host-runtime/scripts/trelio-assistant-setup.mjs';
import { runAssistantSetupMcp, runAssistantEntry, assistantCatalogRevision, createAssistantRuntimeHost, assistantCoordinatorReadiness, runAssistantBackgroundTick, runAssistantBackground,
  executeAssistantRuntimeRequest,ASSISTANT_SOURCE_SETUP_TOOL,ASSISTANT_EMAIL_SETUP_TOOL,ASSISTANT_EMAIL_VERIFY_TOOL,ASSISTANT_TELEGRAM_SETUP_TOOL,ASSISTANT_MAX_SETUP_TOOL,ASSISTANT_MAX_VERIFY_TOOL,ASSISTANT_ENCRYPTION_SETUP_TOOL } from '../host-runtime/scripts/trelio-assistant-entry.mjs';

test('setup projects only pairing code and live identities, with no repeated exchange', async () => {
  const origin='https://assistant.test', enrollmentId=randomUUID(), assistantUserId=randomUUID(), deviceId=randomUUID();
  const values = new Map(), key = input => JSON.stringify(input);
  const store = { get: async input => structuredClone(values.get(key(input)) ?? null),
    put: async (input,value) => values.set(key(input),structuredClone(value)) };
  let exchanges = 0, revoked = false;
  const http = async (operation) => {
    if (operation === 'pair') return { pairingId: randomUUID(), verificationCode:'ABCDEF12', expiresAt:new Date(20000).toISOString() };
    if (operation === 'exchange') { exchanges++; return { assistantUserId,deviceId,credential:`tda_${'b'.repeat(43)}`,expiresAt:new Date(30000).toISOString() }; }
    assert.equal(operation,'heartbeat');
    if(revoked) throw Object.assign(new Error('PRIVATE FAILURE'),{code:'ASSISTANT_ACCESS_DENIED'});
    return {assistantUserId,deviceId};
  };
  const setup = createAssistantSetup({origin,store,http,now:()=>100});
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
  const values=new Map(),key=input=>JSON.stringify(input),enrollmentId=randomUUID();
  const store={get:async input=>structuredClone(values.get(key(input))??null),
    put:async(input,value)=>values.set(key(input),structuredClone(value))};
  let exchanges=0;
  const options={origin:'https://assistant.test',store,now:()=>100,http:async operation=>{
    if(operation==='pair')return {pairingId:randomUUID(),verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
    exchanges++;throw new Error('committed response lost');
  }};
  const setup=createAssistantSetup(options);await setup.begin(enrollmentId,'Fixture');
  await assert.rejects(setup.finish(enrollmentId),/RECOVERY_REQUIRED/);
  const restarted=createAssistantSetup(options);
  assert.deepEqual(await restarted.status(enrollmentId),{state:'recovery_required'});
  await assert.rejects(restarted.finish(enrollmentId),/RECOVERY_REQUIRED/);assert.equal(exchanges,1);
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
  assert.deepEqual(tools,[ASSISTANT_SOURCE_SETUP_TOOL,ASSISTANT_EMAIL_SETUP_TOOL,ASSISTANT_EMAIL_VERIFY_TOOL,ASSISTANT_TELEGRAM_SETUP_TOOL,ASSISTANT_MAX_SETUP_TOOL,ASSISTANT_MAX_VERIFY_TOOL,ASSISTANT_ENCRYPTION_SETUP_TOOL],'the current worker owns setup discovery');
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
    'mcp__trelio_assistant__begin_assistant_setup','mcp__trelio_assistant__prepare_assistant_source_account','mcp__trelio_assistant__configure_assistant_email_source','mcp__trelio_assistant__verify_assistant_email_source','mcp__trelio_assistant__configure_assistant_telegram_source','mcp__trelio_assistant__configure_assistant_max_source','mcp__trelio_assistant__verify_assistant_max_source','mcp__trelio_assistant__prepare_assistant_company_encryption']){
    const output=new PassThrough();let raw='';output.on('data',chunk=>raw+=chunk);
    await runAssistantEntry(['hook'],{input:Readable.from([JSON.stringify({hook_event_name:'PreToolUse',tool_name:tool})]),output,createHook:async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_HOST_NOT_CONFIGURED'});}});
    const result=JSON.parse(raw);
    assert.equal(result.hookSpecificOutput?.permissionDecision,['begin_assistant_setup','prepare_assistant_source_account','configure_assistant_email_source','verify_assistant_email_source','configure_assistant_telegram_source','configure_assistant_max_source','verify_assistant_max_source','prepare_assistant_company_encryption'].some(name=>tool.endsWith(name))?undefined:'deny');
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
      reportHealth:async value=>reports.push(value)}, {}, {});},
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
      reportHealth:async value=>reports.push(value)}, {}, {});},proxyFor:async()=>({}),
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
      reportHealth:async value=>reports.push(value)}, {}, {});},proxyFor:async()=>({}),
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
      sourceHealthReads++;assert.equal(company,companyId);assert.equal(source,sourceId);assert.equal(sourcePolls,0);
      return {revision:0,sourceRevision:0,code:'not_checked'};
    },reportSourceHealth:async input=>{
      assert.equal(sourcePolls,1);sourceReports.push(input);assert.equal(input.sourceId,sourceId);
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
    contextCalls++;return action({...client,identity:currentIdentity},{readActivePass:async()=>null});
  },dependencies:{directory:taskConfig,
    readSourceMonitor:async(source,signal)=>{sourcePolls++;assert.ok(signal);assert.deepEqual(source,{companyId,projectId:null,
      skillId:'email-imap-smtp',accountId:sourceAccountId,cursor:null});return {events:[],nextCursor:'email-baseline',hasMore:false};},
    ensureDirectory:async()=>{},openDatabase:async directory=>{
      assert.equal(path.basename(directory),identity.deviceId);
      return {database,close:async()=>{databaseClosed++;database.close();}};
    },native,timeZone:'Europe/Moscow',readStatus:async()=>({structuredContent:{schemaVersion:1,
      assistantUserId:identity.assistantId,deviceId:identity.deviceId,authorizedByUserId:memberId,businessReady,
      availableCapabilities:['task_context','task_mutations','task_pass_outcome','workspace_execution','owner_decisions','background_service']}})}});
  try {
    await host.coordinator.pollOnce();
    assert.equal(sourcePolls,1);assert.equal(sourceInventories,3,'source inventory and both sides of the read re-enter the protected context');
    assert.equal(sourceHealthReads,1);assert.equal(sourceReports.length,1,'production composition reports a native source result in a new private invocation');
    await assert.rejects(host.coordinator.workOnce(),error=>error.code==='ASSISTANT_COORDINATOR_SETUP_REQUIRED');
    assert.equal(starts,0,'a running source poll and configured native adapter do not enable model work');
    businessReady=true;
    await host.coordinator.workOnce();
    assert.equal(starts,1);
    await host.coordinator.pollOnce();
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
    const host=await createAssistantRuntimeHost({context:async action=>action({...client,identity:currentIdentity},{readActivePass:async()=>null}),
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
  const result=await runAssistantBackgroundTick({createHost:async()=>({coordinator:{
    pollOnce:async()=>{pollCalls++;},workOnce:()=>{workCalls++;return work;},
  },close:async()=>{closed++;}}),wait:async(milliseconds)=>{
    assert.equal(milliseconds,30_000);if(++waits===2)resolveWork({state:'completed'});
  }});
  assert.equal(workCalls,1);assert.ok(pollCalls>=2);assert.equal(closed,1);
  assert.deepEqual(result,{schemaVersion:1,state:'checked'});
});

test('background supervisor resolves a fresh worker only between cycles and preserves uncertain delivery recovery',async()=>{
  const controller=new AbortController(),operations=[];let waits=0,reports=0;
  const result=await runAssistantBackground({signal:controller.signal,request:async(request,options)=>{
    operations.push(request.operation);assert.equal(options.signal.aborted,false);
    if(request.operation==='background_tick'){
      assert.equal(options.timeoutMs,35*60_000);
      if(waits===0)throw Object.assign(new Error('private transport failure'),{code:'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
    }
  },reportFailure:async error=>{assert.equal(error.code,'ASSISTANT_CODEX_DELIVERY_UNCERTAIN');reports++;},
  wait:async(milliseconds)=>{assert.equal(milliseconds,300_000);if(++waits===2)controller.abort();}});
  assert.deepEqual(operations,['health','background_tick','health','background_tick']);
  assert.equal(reports,1);assert.deepEqual(result,{schemaVersion:1,state:'stopped'});
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
  await assert.rejects(runAssistantBackgroundTick({createHost:async()=>({coordinator:{
    pollOnce:async()=>{if(++polls>1)throw failure;},workOnce:()=>{works++;return work;},
  },close:async()=>{closes++;}}),wait:async()=>{if(++waits===2)finishWork({state:'completed'});}}),error=>error===failure);
  assert.equal(works,1);assert.equal(closes,1);
});

const workspacePlan=()=>({prepared:true,scope:{assistantUserId:randomUUID(),deviceId:randomUUID(),companyId:randomUUID(),taskId:randomUUID(),passId:randomUUID()},
  localAction:{schemaVersion:1,operation:'open',parameters:{workspaceId:randomUUID(),runId:randomUUID(),runtimeSessionId:randomUUID()}}});

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
    client:{},host:{readActivePass:async()=>active},store:{get:async()=>({state:{runtimeSessionId:p.runtimeSessionId}})}});
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
    host:{readActivePass:async()=>active},store:{get:async()=>({state:{runtimeSessionId:p.runtimeSessionId}})}});
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
        reportHealth:async v=>reports.push(v)},{},{});},proxyFor:async()=>({}),
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
