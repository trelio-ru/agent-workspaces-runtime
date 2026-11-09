import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyAssistantPowerShellReadExecutable, assistantReadOnlyPreparationFailure, assistantDeliveryMarker, assistantWorkStateContext, assistantExecutionConfiguration, readAssistantCodexExecutionAvailability,readAssistantCodexExecutionAvailabilitySet, readAssistantCodexHookReadiness, readAssistantCodexPluginReadiness, readAssistantCodexDelivery, readAssistantCodexOwnerReply, runAssistantCodexPass, provisionAssistantCodexChat } from '../host-runtime/scripts/trelio-assistant-codex.mjs';

const execution = {modelId:'gpt-6.1-sol',effortLevel:'high',revision:1};
const taskContext = { assistantId:randomUUID(),companyId:randomUUID(),taskId:randomUUID() };

test('completed PREPARE permits only a separate bounded readiness witness, never provision completion',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const prepared={id:turnId,status:'completed',items:[{type:'userMessage',content:[{type:'text',
    text:`TRELIO_ASSISTANT_DESKTOP_PREPARE ${deliveryId}\nReply exactly READY. Do not use tools or access files, sites, accounts or integrations.`}]},
    {type:'agentMessage',text:'READY'}]};
  const read=(turns=[prepared],nextCursor=null,extra={})=>readAssistantCodexDelivery(threadId,deliveryId,{
    executable:process.execPath,environment:{},provision:true,allowPrepared:true,...extra,
    spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'?{thread:{id:threadId,cwd:process.cwd()}}:{data:turns,nextCursor}}))});
  assert.deepEqual(await read(),{state:'prepared',turnId,markerId:deliveryId});
  // The ordinary task/provision receipt and all incomplete or impure histories
  // retain their refusal. A missing queue/history record is never rejection.
  assert.deepEqual(await read([prepared],null,{allowPrepared:false}),{state:'uncertain'});
  assert.deepEqual(await read([prepared],null,{provision:false}),{state:'uncertain'});
  for(const turns of [[prepared,prepared],[{...prepared,status:'interrupted'}],
    [{...prepared,items:[...prepared.items,{type:'mcpToolCall',tool:'synthetic'}]}],
    [{...prepared,items:[prepared.items[0],{type:'agentMessage',text:'not READY'}]}]])
    assert.deepEqual(await read(turns),{state:'uncertain'});
  assert.deepEqual(await read([prepared],'more'),{state:'uncertain'});
});

test('independent readiness completion requires its exact tool-free GUI turn',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const prompt=`TRELIO_ASSISTANT_DELIVERY ${deliveryId}\nThis is an isolated native dispatcher readiness check. Reply exactly READY. Do not use tools or access files, sites, accounts or integrations.\n`;
  const turn={id:turnId,status:'completed',items:[{type:'userMessage',content:[{type:'text',text:prompt}]},{type:'agentMessage',text:'READY'}]};
  const read=t=>readAssistantCodexDelivery(threadId,deliveryId,{executable:process.execPath,environment:{},readinessOnly:true,
    spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'?{thread:{id:threadId,cwd:process.cwd()}}:{data:[t],nextCursor:null}}))});
  assert.equal((await read(turn)).state,'completed');
  for(const items of [[...turn.items,{type:'mcpToolCall'}],[turn.items[0],{type:'agentMessage',text:'other response'}],
    [{type:'userMessage',content:[{type:'text',text:prompt.trimEnd()}]},turn.items[1]],
    [{type:'userMessage',content:[{type:'text',text:prompt+'\nprivate body'}]},turn.items[1]]])
    assert.deepEqual(await read({...turn,items}),{state:'uncertain'});
});

test('independent READY uses the exact production queued prompt through real native readback',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID(),cwd=await fs.realpath(process.cwd());
  let submitted=null,starts=0,queues=0;
  // Reuse the actual queue payload as native history. A separately handwritten
  // fixture prompt would hide a producer/reader byte mismatch (including LF).
  // Only the native process is synthetic; prompt generation, queue submission,
  // marker polling and strict readiness receipt are the production adapter.
  const spawnProcess=nativeRpc(request=>{
    if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd,model:execution.modelId,reasoningEffort:execution.effortLevel}}};
    if(request.method==='thread/queue/list')return {result:{data:[],nextCursor:null}};
    if(request.method==='thread/queue/add'){
      queues++;submitted=request.params.input;
      return {result:{queuedSubmission:{id:randomUUID(),clientUserMessageId:deliveryId,input:submitted}}};
    }
    if(request.method==='thread/name/set')return {result:{}};
    assert.equal(request.method,'thread/turns/list');
    return {result:{data:submitted?[{id:turnId,status:'completed',error:null,
      items:[{type:'userMessage',content:submitted},{type:'agentMessage',text:'READY'}]}]:[],nextCursor:null}};
  });
  const result=await provisionAssistantCodexChat({threadId,deliveryId,cwd,execution},{
    executable:process.execPath,environment:{},spawnProcess,readinessOnly:true,
    readExecutionAvailability:async()=>true,openDesktop:async()=>{},
    onThreadStarted:()=>assert.fail('an existing review must never create another thread'),
    startInvocation:()=>{starts++;},
  });
  assert.equal(result.state,'completed');assert.equal(result.threadId,threadId);
  assert.equal(starts,1);assert.equal(queues,1);
  assert.ok(submitted[0].text.endsWith('\n'),'fixture must retain the actual canonical final LF');
  // Restart/reconciliation observes that SAME positive receipt without any
  // second queue submission; it must not require replay to accept success.
  const receipt=await readAssistantCodexDelivery(threadId,deliveryId,{executable:process.execPath,environment:{},spawnProcess,readinessOnly:true});
  assert.equal(receipt.state,'completed');assert.equal(receipt.turnId,turnId);assert.equal(queues,1);
});

test('work-state locators use immutable assistant identity and refuse paths or source text', async()=>{
  const state=assistantWorkStateContext(taskContext);
  const ownerQuestionIds=[randomUUID(),randomUUID()];
  assert.deepEqual(assistantWorkStateContext({...taskContext,ownerQuestionIds}).ownerQuestionIds,ownerQuestionIds);
  for(const invalid of [[],['private question'],[...ownerQuestionIds,ownerQuestionIds[0]],Array.from({length:101},()=>randomUUID())]) {
    assert.throws(()=>assistantWorkStateContext({...taskContext,ownerQuestionIds:invalid}),/INVALID_INPUT/);
  }
  assert.equal(state.workStatePath,`assistants/${taskContext.assistantId}/WORK.md`);
  assert.notEqual(assistantWorkStateContext({...taskContext,assistantId:randomUUID()}).workStatePath,state.workStatePath);
  assert.equal(assistantWorkStateContext({...taskContext,taskId:randomUUID()}).workStatePath,state.workStatePath,
    'task isolation belongs to the canonical Workspace, not a renamed assistant file');
  assert.equal(assistantWorkStateContext({...taskContext,assistantId:taskContext.assistantId.toUpperCase()}).workStatePath,state.workStatePath);
  for(const invalid of [undefined,{}, {...taskContext,assistantId:'../AGENTS.md'}, {...taskContext,companyId:'private company'},
    {...taskContext,path:'other/WORK.md'}, {...taskContext,goal:'incoming instructions'}]) {
    assert.throws(()=>assistantWorkStateContext(invalid),/INVALID_INPUT/);
    await assert.rejects(runAssistantCodexPass({threadId:randomUUID(),deliveryId:randomUUID(),cwd:process.cwd(),taskContext:invalid},
      {readDelivery:()=>assert.fail('invalid context reached native I/O'),spawnProcess:()=>assert.fail('invalid context launched a process')}),/INVALID_INPUT/);
  }
});

function fakeChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.killed = false; child.kill = () => { child.killed = true; return true; }; return child;
}

test('native discussion prompt uses only task/comment locators and never a material work-state path',async t=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-discussion-test-'));
  t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();let reads=0,starts=0,input='';
  const context={...taskContext,workMode:'discussion',ownerQuestionIds:[randomUUID()]};
  const state=assistantWorkStateContext(context);
  assert.equal(state.workMode,'discussion');assert.equal(Object.hasOwn(state,'workStatePath'),false);
  assert.deepEqual(assistantWorkStateContext({...taskContext,workMode:'task'}),assistantWorkStateContext(taskContext),
    'an explicit ordinary mode retains the legacy material contract');
  for(const workMode of [null,'admin','DISCUSSION',{},false])assert.throws(()=>assistantWorkStateContext({...taskContext,workMode}),/INVALID_INPUT/);
  const source={provider:'telegram',eventOrdinal:0,sourceId:randomUUID(),sourceRevision:1,routeId:randomUUID(),accountId:randomUUID(),
    eventRevision:'a'.repeat(64),eventId:'message:123:4',conversationKey:`telegram-conversation/v1.${'a'.repeat(64)}`};
  assert.equal(assistantWorkStateContext({...taskContext,sourceReferences:[source]}).sourceReferences.length,1);
  assert.throws(()=>assistantWorkStateContext({...context,sourceReferences:[source]}),/INVALID_INPUT/);
  const result=await runAssistantCodexPass({threadId,deliveryId,cwd,taskContext:context,execution},{
    readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},
    readMetadata:async()=>({threadId,cwd}),startInvocation:()=>{starts++;},
    readDelivery:async()=>++reads===1?{state:'uncertain'}:{state:'completed',turnId,receipt:`codex:${threadId}:${turnId}`},
    openDesktop:async()=>{},spawnProcess:desktopRpc({threadId,cwd:await fs.realpath(cwd),onInput:text=>{input=text;}}),
  });
  assert.equal(result.state,'completed');assert.equal(starts,1);
  const line=input.split('\n').find(value=>value.startsWith('TRELIO_ASSISTANT_SCOPE '));
  assert.deepEqual(JSON.parse(line.slice('TRELIO_ASSISTANT_SCOPE '.length)),state);
  assert.match(input,/restricted native discussion pass/u);assert.match(input,/replyCommentId/u);
  assert.match(input,/Do not create\/read a Workspace or WORK\.md/u);
  assert.doesNotMatch(input,/Use the assistant-task-worker skill|workStatePath|Save confirmed progress/u);
  assert.doesNotMatch(input,/failed read-only tab attachment/u);
});
const nativeRpc = handler => (_executable, args, options) => {
  assert.deepEqual(args,['app-server','--listen','stdio://']); assert.equal(options.shell,false);
  assert.deepEqual(options.stdio,['pipe','pipe','ignore']);
  const child = fakeChild(); let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString(); let boundary;
    while ((boundary=input.indexOf('\n'))!==-1) {
      const request=JSON.parse(input.slice(0,boundary)); input=input.slice(boundary+1);
      if (!request.id) continue;
      queueMicrotask(() => {
        try {
          const {notifications=[],...response}=request.method==='initialize'?{result:{}}:handler(request);
          child.stdout.write(`${JSON.stringify({id:request.id,...response})}\n`);
          for(const notification of notifications)child.stdout.write(`${JSON.stringify(notification)}\n`);
        }
        catch(error){child.emit('error',error);}
      });
    }
  });
  return child;
};

// Real-shaped public App Server fixture: a bootstrap owns only its empty
// READY; business messages are accepted solely by the already opened GUI queue.
const desktopRpc = ({threadId,cwd=process.cwd(),onInput=()=>{},onCreate=()=>{},onQueue=()=>{},
  onRequest=()=>{},nameFailure=false,pair=execution,queued=[],terminal=true,children=[],snapshotStatuses=[],bootstrapError=null}={}) => {
  let input='',turnId=randomUUID(),phase='read',snapshot=0;
  const rpc=nativeRpc(request=>{
    onRequest(request);
    if(request.method==='thread/name/set'){if(nameFailure)return {error:{code:-32601,message:'Synthetic unsupported name RPC'}};assert.equal(request.params.threadId,threadId);assert.ok(['Работа по задаче Trelio','Переписка с владельцем','Разбор входящих сообщений'].includes(request.params.name));return {result:{}};}
    if(request.method==='thread/start'){onCreate(request);return {result:{thread:{id:threadId}}};}
    if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd,model:pair.modelId,reasoningEffort:pair.effortLevel}}};
    if(request.method==='turn/start'){
      assert.equal(request.params.model,execution.modelId);assert.equal(request.params.effort,execution.effortLevel);
      assert.equal(request.params.collaborationMode.settings.reasoning_effort,execution.effortLevel);
      input=request.params.input[0].text;phase='bootstrap';onInput(input,'bootstrap');return {result:{turn:{id:turnId}},
        notifications:[{method:'turn/completed',params:{threadId,turn:{id:turnId,status:bootstrapError?'failed':'completed',...(bootstrapError?{error:bootstrapError}:{})}}}]};
    }
    if(request.method==='thread/queue/list')return {result:{data:queued,nextCursor:null}};
    if(request.method==='thread/queue/add'){
      onQueue(request);input=request.params.input[0].text;phase='desktop';onInput(input,'desktop');turnId=randomUUID();
      return {result:{queuedSubmission:{id:randomUUID(),clientUserMessageId:request.params.clientUserMessageId,input:request.params.input}}};
    }
    assert.equal(request.method,'thread/turns/list');
    const status=phase==='desktop'&&snapshotStatuses.length?snapshotStatuses[Math.min(snapshot++,snapshotStatuses.length-1)]:'completed';
    return {result:{data:terminal?[{id:turnId,status,items:[{type:'userMessage',content:[{type:'text',text:input}]}]}]:[],nextCursor:null}};
  });
  return (...args)=>{const child=rpc(...args);children.push(child);return child;};
};

test('actual native hook inventory gates trusted definitions, never installation or another plugin',async()=>{
  const cwd=process.cwd();let reads=0;
  const hooks=['sessionStart','preToolUse','sessionEnd'].map((eventName,i)=>({eventName,handlerType:'command',
    source:'plugin',pluginId:'trelio-digital-assistant@trelio-digital-assistants',enabled:true,
    currentHash:`native-v2:${String(i+1).repeat(64)}:${'a'.repeat(69)}`,trustStatus:'trusted',command:'PRIVATE command',sourcePath:'PRIVATE path'}));
  const read=rows=>readAssistantCodexHookReadiness(cwd,{executable:process.execPath,environment:{},spawnProcess:nativeRpc(request=>{
    assert.equal(request.method,'hooks/list');assert.deepEqual(request.params,{cwds:[cwd]});reads++;
    return {result:{data:[{hooks:rows,errors:[],warnings:[]}]}};
  })});
  const first=await read(hooks),reordered=await read([...hooks].reverse());
  assert.deepEqual(first,reordered);assert.match(first.fingerprint,/^[0-9a-f]{64}$/u);assert.doesNotMatch(JSON.stringify(first),/PRIVATE/);
  assert.notDeepEqual(await read(hooks.map((h,i)=>i? h:{...h,currentHash:'f'.repeat(64)})),first);
  for(const rows of [[],hooks.slice(1),[...hooks,hooks[0]],hooks.map(h=>({...h,trustStatus:'untrusted'})),
    hooks.map(h=>({...h,enabled:false})),hooks.map(h=>({...h,pluginId:'human@other'})),
    hooks.map(h=>({...h,currentHash:null}))])await assert.rejects(read(rows),/HOOK_REVIEW_REQUIRED/);
  assert.equal(reads,10);
});

test('untrusted hooks stop a real task before renewal/start/spawn without fabricating completion',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID();let hooks=0;
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},{
    readMetadata:async()=>({threadId,cwd:process.cwd()}),readDelivery:async()=>({state:'uncertain'}),
    readExecutionAvailability:async()=>true,readHookReadiness:async()=>{hooks++;throw Object.assign(new Error('closed'),{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});},
    executable:process.execPath,environment:{},beforeInvocation:()=>assert.fail('untrusted hook renewed native lease'),
    startInvocation:()=>assert.fail('untrusted hook changed start bit'),spawnProcess:()=>assert.fail('untrusted hook launched model'),
  }),{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});
  assert.equal(hooks,1);
});

test('company execution is an immutable closed pair; missing/argv-like choices never reach native I/O', async()=>{
  const original={...execution};
  const frozen=assistantExecutionConfiguration(original);
  original.modelId='another-model';
  assert.equal(frozen.modelId,execution.modelId);assert.ok(Object.isFrozen(frozen));
  for(const invalid of [undefined,{}, {...execution,revision:0}, {...execution,modelId:'--dangerously-bypass'},
    {...execution,modelId:'gpt\n--flag'}, {...execution,effortLevel:'high" --flag'}, {...execution,taskId:randomUUID()}]) {
    assert.throws(()=>assistantExecutionConfiguration(invalid),/INVALID_EXECUTION/);
    await assert.rejects(runAssistantCodexPass({threadId:randomUUID(),deliveryId:randomUUID(),cwd:process.cwd(),taskContext,execution:invalid},
      {readDelivery:()=>assert.fail('invalid model reached native history')}),/INVALID_EXECUTION/);
  }
});

test('native model/list discovers account effort support with bounded pagination and no fallback', async()=>{
  let calls=0;
  const options={executable:process.execPath,environment:{},spawnProcess:nativeRpc(request=>{
    if(request.method==='account/read'){
      assert.deepEqual(request.params,{refreshToken:false});
      return {result:{account:{type:'chatgpt',email:'PRIVATE ACCOUNT',planType:'pro'},requiresOpenaiAuth:true}};
    }
    assert.equal(request.method,'model/list');assert.equal(request.params.includeHidden,false);calls++;
    if(!request.params.cursor) return {result:{data:[{model:'other-model'}],nextCursor:'next-page'}};
    assert.equal(request.params.cursor,'next-page');
    return {result:{data:[{model:execution.modelId,hidden:false,displayName:'PRIVATE ACCOUNT LABEL',
      supportedReasoningEfforts:[{reasoningEffort:'high',description:'PRIVATE'}]}],nextCursor:null}};
  })};
  assert.equal(await readAssistantCodexExecutionAvailability(execution,options),true);assert.equal(calls,2);
  assert.equal(await readAssistantCodexExecutionAvailability({...execution,effortLevel:'max'},options),false);
  const unavailable={...options,spawnProcess:nativeRpc(request=>({result:request.method==='account/read'
    ? {account:null,requiresOpenaiAuth:false} : {data:[],nextCursor:null}}))};
  assert.equal(await readAssistantCodexExecutionAvailability(execution,unavailable),false);
  const loop={...options,spawnProcess:nativeRpc(request=>({result:request.method==='account/read'
    ? {account:{type:'apiKey'},requiresOpenaiAuth:true} : {data:[],nextCursor:'same-cursor'}}))};
  await assert.rejects(readAssistantCodexExecutionAvailability(execution,loop),/READ_UNAVAILABLE/);
});

test('all native-selected company pairs share one read-only account/model RPC process and original deadline',async()=>{
  let children=0,accounts=0,pages=0;const methods=[];
  const rpc=nativeRpc(request=>{
    methods.push(request.method);
    if(request.method==='account/read'){accounts++;return {result:{account:{type:'chatgpt',email:'PRIVATE'},requiresOpenaiAuth:true}};}
    assert.equal(request.method,'model/list');pages++;
    if(!request.params.cursor)return {result:{data:[{model:execution.modelId,supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:'next'}};
    return {result:{data:[{model:'gpt-other',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]}],nextCursor:null}};
  });
  const choices=[execution,{...execution,effortLevel:'max'}, {...execution,modelId:'gpt-other',effortLevel:'ultra'}];
  const result=await readAssistantCodexExecutionAvailabilitySet(choices,{executable:process.execPath,environment:{},
    spawnProcess:(...args)=>{children++;return rpc(...args);}});
  assert.deepEqual(result,[true,false,true]);assert.equal(children,1);assert.equal(accounts,1);assert.equal(pages,2);
  assert.deepEqual(methods,['account/read','model/list','model/list']);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  await assert.rejects(readAssistantCodexExecutionAvailabilitySet(Array.from({length:257},()=>execution),
    {spawnProcess:()=>assert.fail('oversized native configuration inventory started a process')}),/INVALID_INPUT/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(readAssistantCodexExecutionAvailabilitySet(choices,{signal:controller.signal,executable:process.execPath,
    spawnProcess:()=>assert.fail('expired status budget started a process')}),/UNAVAILABLE/);
});

test('only explicit native missing authentication reports login, before any model lookup or invocation',async()=>{
  const calls=[];
  const options={executable:process.execPath,environment:{},spawnProcess:nativeRpc(request=>{
    calls.push(request.method);assert.equal(request.method,'account/read');
    assert.deepEqual(request.params,{refreshToken:false});
    return {result:{account:null,requiresOpenaiAuth:true}};
  })};
  await assert.rejects(readAssistantCodexExecutionAvailability(execution,options),{code:'ASSISTANT_CODEX_AUTH_REQUIRED'});
  let starts=0;
  await assert.rejects(runAssistantCodexPass({threadId:randomUUID(),deliveryId:randomUUID(),cwd:process.cwd(),taskContext,execution},{
    ...options,readDelivery:async()=>({state:'uncertain'}),readMetadata:async threadId=>({threadId,cwd:process.cwd()}),
    startInvocation:()=>{starts++;},
  }),{code:'ASSISTANT_CODEX_AUTH_REQUIRED'});
  assert.equal(starts,0);assert.deepEqual(calls,['account/read','account/read']);

  // A provider that explicitly needs no OpenAI auth remains supported. Stored
  // accounts are merely configured, not token-validity or recovery evidence.
  for(const account of [{account:null,requiresOpenaiAuth:false},
    ...['apiKey','chatgpt','amazonBedrock'].map(type=>({account:{type},requiresOpenaiAuth:true}))]){
    assert.equal(await readAssistantCodexExecutionAvailability(execution,{...options,spawnProcess:nativeRpc(request=>({result:
      request.method==='account/read'?account:{data:[{model:execution.modelId,supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null}}))}),true);
  }
});

test('malformed, unsupported or failed account reads remain unknown and expose no native diagnostics',async()=>{
  for(const value of [null,{}, {account:null}, {account:null,requiresOpenaiAuth:'true'},
    {account:[],requiresOpenaiAuth:true}, {account:{type:'futureAccount'},requiresOpenaiAuth:true}]){
    await assert.rejects(readAssistantCodexExecutionAvailability(execution,{executable:process.execPath,environment:{},
      spawnProcess:nativeRpc(()=>({result:value}))}),{code:'ASSISTANT_CODEX_READ_UNAVAILABLE'});
  }
  await assert.rejects(readAssistantCodexExecutionAvailability(execution,{executable:process.execPath,environment:{},
    spawnProcess:nativeRpc(()=>({error:{code:-32000,message:'ASSISTANT_CODEX_AUTH_REQUIRED PRIVATE'}}))}),
    error=>error.code==='ASSISTANT_CODEX_READ_UNAVAILABLE' && !error.message.includes('PRIVATE'));
});

test('an unavailable native model never crosses the durable invocation fence', async()=>{
  let starts=0,spawns=0;
  await assert.rejects(runAssistantCodexPass({threadId:randomUUID(),deliveryId:randomUUID(),cwd:process.cwd(),taskContext,execution}, {
    readDelivery:async()=>({state:'uncertain'}),readMetadata:async threadId=>({threadId,cwd:process.cwd()}),
    readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async choice=>{assert.deepEqual(choice,execution);return false;},
    startInvocation:()=>{starts++;},spawnProcess:()=>{spawns++;assert.fail('unavailable model launched native work');},
  }),/MODEL_UNAVAILABLE/);
  assert.equal(starts,0);assert.equal(spawns,0);
});

test('exact native marker read-back exposes receipt only; quoted/tool text is not acceptance', async () => {
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const text=assistantDeliveryMarker(deliveryId)+'\nprivate instruction';
  const options = { readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>true,executable:process.execPath, environment:{}, spawnProcess:nativeRpc(request => {
    if (request.method==='thread/read') return { result:{ thread:{ id:threadId,cwd:process.cwd(),name:'PRIVATE TITLE' } } };
    assert.equal(request.method,'thread/turns/list'); assert.equal(request.params.itemsView,'summary');
    return { result:{ data:[{ id:turnId,status:'completed',items:[
      { type:'agentMessage',text:'PRIVATE OUTPUT' }, { type:'userMessage',content:[{ type:'text',text }] },
    ] }] } };
  }) };
  const result = await readAssistantCodexDelivery(threadId,deliveryId,options);
  assert.equal(result.state,'completed'); assert.equal(result.turnId,turnId);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private instruction/);
  const spoofed = { ...options, spawnProcess:nativeRpc(request => request.method==='thread/read'
    ? { result:{ thread:{ id:threadId,cwd:process.cwd() } } }
    : { result:{ data:[{ id:turnId,status:'completed',items:[{ type:'agentMessage',text }] }] } }) };
  assert.deepEqual(await readAssistantCodexDelivery(threadId,deliveryId,spoofed),{ state:'uncertain' });
});

test('native read failure stays closed and never copies diagnostic content into the error', async () => {
  const threadId=randomUUID(),deliveryId=randomUUID();
  await assert.rejects(readAssistantCodexDelivery(threadId,deliveryId,{ readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},
    spawnProcess:nativeRpc(() => ({ error:{ code:-32600,message:'PRIVATE SECRET DIAGNOSTIC' } })) }),
    error => error.code==='ASSISTANT_CODEX_READ_UNAVAILABLE' && !/PRIVATE/.test(error.message));
});

test('malformed native JSON frames fail closed instead of crashing the coordinator process', async()=>{
  const options={readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},spawnProcess:()=>{
    const child=fakeChild();queueMicrotask(()=>child.stdout.write('null\n'));return child;
  }};
  await assert.rejects(readAssistantCodexDelivery(randomUUID(),randomUUID(),options),/READ_UNAVAILABLE/);
});

test('initial native chat persists its ID synchronously and consumes no business instruction', async t=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-provision-test-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const threadId=randomUUID(),deliveryId=randomUUID();let started=false,saved=null,input='',confirmed=0;
  const options={readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},
    onAuthenticationConfirmed:async()=>{confirmed++;},
    startInvocation:()=>{started=true;},onThreadStarted:value=>{assert.equal(started,true);saved=value;},
    readDelivery:async value=>{assert.equal(saved,threadId);assert.equal(value,threadId);return{state:'completed',receipt:'fixture:ready'};},
    openDesktop:async url=>{assert.equal(url,`codex://threads/${threadId}`);},
    spawnProcess:desktopRpc({threadId,cwd:await fs.realpath(cwd),onCreate:()=>assert.equal(started,true),
      onRequest:request=>{if(request.method==='turn/start')assert.equal(saved,threadId);},
      onInput:text=>{input=text;}}),
  };
  const result=await provisionAssistantCodexChat({deliveryId,cwd,execution},options);
  assert.equal(confirmed,1);
  assert.equal(result.threadId,threadId);assert.match(input,/Do not use tools/u);
  assert.doesNotMatch(input,/TRELIO_ASSISTANT_SCOPE|WORK\.md/);
  assert.doesNotMatch(input,/failed read-only tab attachment/u,'READY stays exactly tool-free');
  assert.ok(input.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));
  await assert.rejects(provisionAssistantCodexChat({deliveryId:randomUUID(),cwd,execution},{...options,onThreadStarted:()=>{throw new Error('private disk failure');}}),/DELIVERY_UNCERTAIN/);
  assert.equal(confirmed,1,'an unknown provision never reports login recovery');
});

test('native execution uses the exact chat/cwd, stdin marker, one-use start and positive live read-back', async t => {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-codex-test-'));
  t.after(() => fs.rm(cwd,{ recursive:true,force:true }));
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const expectedCwd = await fs.realpath(cwd);
  const sourceReferences=['telegram','email','max'].map((provider,eventOrdinal)=>({provider,eventOrdinal,
    sourceId:randomUUID(),sourceRevision:3,routeId:randomUUID(),accountId:randomUUID(),eventRevision:'b'.repeat(64),
    eventId:provider==='email'?'uid:17:11':'message:-123:4',conversationKey:`${provider}-conversation/v1.${'a'.repeat(64)}`}));
  const repliedTaskContext={...taskContext,scheduled:true,ownerQuestionIds:[randomUUID()],sourceReferences};
  let starts=0,reads=0,launches=0,confirmed=0,input='';
  const options = { readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>true,executable:process.execPath,environment:{ PATH:process.env.PATH,
    ComSpec:'C:\\Windows\\System32\\cmd.exe',PATHEXT:'.COM;.EXE;.BAT;.CMD',OPENAI_API_KEY:'private',SHOULD_NOT_PASS:'private' },
    onAuthenticationConfirmed:async()=>{confirmed++;throw new Error('PRIVATE health report failed');},
    startInvocation:() => { if (starts++) throw new Error('private state error'); },
    readMetadata:async () => ({ threadId,cwd }), readDelivery:async () => ++reads===1 ? { state:'uncertain' }
      : { state:'completed',turnId,receipt:`codex:${threadId}:${turnId}` },
    openDesktop:async url=>assert.equal(url,`codex://threads/${threadId}`),
    spawnProcess:(_executable,args,spawnOptions) => {
      launches++;assert.deepEqual(args,['app-server','--listen','stdio://']);
      assert.equal(spawnOptions.shell,false);assert.equal(spawnOptions.cwd,expectedCwd);
      assert.equal(spawnOptions.env.SHOULD_NOT_PASS,undefined);assert.equal(spawnOptions.env.OPENAI_API_KEY,undefined);
      assert.equal(spawnOptions.env.ComSpec,process.platform==='win32'?String.raw`C:\Windows\System32\cmd.exe`:undefined);
      assert.equal(spawnOptions.env.PATHEXT,process.platform==='win32'?'.COM;.EXE;.BAT;.CMD':undefined);
      return desktopRpc({threadId,cwd:expectedCwd,onInput:text=>{input=text;}})(_executable,args,spawnOptions);
    },
  };
  const result=await runAssistantCodexPass({ threadId,deliveryId,cwd,taskContext:repliedTaskContext,execution },options);
  assert.equal(result.state,'completed'); assert.equal(launches,1); assert.equal(starts,1);
  assert.equal(confirmed,1,'diagnostic failure neither discards nor replays a fresh positive native result');
  assert.equal((await runAssistantCodexPass({threadId,deliveryId,cwd,taskContext,execution},options)).state,'completed');
  assert.equal(confirmed,1,'old receipt reconciliation cannot clear a current login incident');
  assert.ok(input.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));
  const scopeLine=input.split('\n').find(line=>line.startsWith('TRELIO_ASSISTANT_SCOPE '));
  assert.deepEqual(JSON.parse(scopeLine.slice('TRELIO_ASSISTANT_SCOPE '.length)),assistantWorkStateContext(repliedTaskContext));
  assert.ok(input.includes('get_assistant_owner_question'));
  assert.match(input,/This is a scheduled task pass/);
  assert.match(input,/failed read-only tab attachment/u);
  for(const invariant of ['SAME existing window on this assistant computer','verify the application, site and account',
    'never bypasses a provider refusal','read back that exact result before any further input',
    'does not authorize restarting or killing Chrome/Codex','actual result is verified'])assert.ok(input.includes(invariant));
  assert.match(input,/separate last successfully reviewed message position for each task\/account\/conversation\/topic/);
  assert.match(input,/advance that position only together with successfully accepted task material/);
  assert.match(input,/never use the background monitor cursor/);
  assert.match(input,/retain its exact provider\/account\/chat\/topic selectors in accepted WORK.md/);
  assert.match(input,/even when no reply is pending/);
  assert.match(input,/Reading one mentioned message does not prove that earlier or neighbouring history was reviewed/);
  assert.ok(input.includes('never sensitive-action approval'));
  for(const invariant of ['request_assistant_action','original clientRequestId and fields','only approved','ownerDecisionId',
    'Denied, expired, stopped or changed data','server rechecks current access and target state']) {
    assert.ok(input.includes(invariant),`worker receives exact owner-action invariant: ${invariant}`);
  }
  // A lost/empty history lookup cannot bypass the durable first-attempt fence.
  reads=0;
  await assert.rejects(runAssistantCodexPass({ threadId,deliveryId,cwd,taskContext,execution },options), /DELIVERY_NOT_STARTED/);
  assert.equal(launches,2);
});

test('queue acceptance without an exact completed GUI turn stays uncertain and is never replayed', async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID();let starts=0,queues=0;const children=[];
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},{
    passTimeoutMs:100,executable:process.execPath,environment:{},openDesktop:async()=>{},
    onAuthenticationConfirmed:()=>assert.fail('accepted queue is not login recovery'),
    readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),readExecutionAvailability:async()=>true,
    startInvocation:()=>{starts++;},readMetadata:async()=>({threadId,cwd:process.cwd()}),
    readDelivery:async()=>({state:'uncertain'}),
    spawnProcess:desktopRpc({threadId,terminal:false,onQueue:()=>{queues++;},children}),
  }),/DELIVERY_UNCERTAIN/);
  assert.equal(starts,1);assert.equal(queues,1);assert.ok(children.every(child=>child.killed));
});

test('stored interrupted history is uncertain, not a failed or completed receipt',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  for(const status of ['interrupted','failed']){
    const result=await readAssistantCodexDelivery(threadId,deliveryId,{executable:process.execPath,environment:{},
      spawnProcess:nativeRpc(request=>request.method==='thread/read'?{result:{thread:{id:threadId,cwd:process.cwd()}}}:
        {result:{data:[{id:turnId,status,items:[{type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(deliveryId)+'\nSynthetic input'}]}]}],nextCursor:null}})});
    assert.equal(result.state,status==='interrupted'?'uncertain':'failed');
    assert.equal(Object.hasOwn(result,'receipt'),status==='failed');
  }
});

test('GUI stored history may say interrupted while its writer is active; retain one invocation until actual completion',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();let starts=0,queues=0,polls=0,reads=0,confirmed=0;
  const result=await runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},{
    executable:process.execPath,environment:{},openDesktop:async()=>{},passTimeoutMs:8000,
    readMetadata:async()=>({threadId,cwd:process.cwd()}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    readExecutionAvailability:async()=>true,startInvocation:()=>{starts++;},onAuthenticationConfirmed:()=>{confirmed++;},
    readDelivery:async()=>++reads===1?{state:'uncertain'}:{state:'completed',turnId,receipt:`codex:${threadId}:${turnId}`},
    spawnProcess:desktopRpc({threadId,snapshotStatuses:['interrupted','inProgress','completed'],onQueue:()=>{queues++;},
      onRequest:request=>{if(request.method==='thread/turns/list'){polls++;assert.equal(confirmed,0);}}}),
  });
  assert.equal(result.state,'completed');assert.equal(polls,3,'provisional interruption cannot close the reader or protected pass');
  assert.equal(starts,1);assert.equal(queues,1);assert.equal(reads,2);assert.equal(confirmed,1);
});

test('cancellation while stored history says interrupted closes only the reader without receipt or queue replay',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),controller=new AbortController();let starts=0,queues=0,reads=0;
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},{
    executable:process.execPath,environment:{},openDesktop:async()=>{},signal:controller.signal,
    readMetadata:async()=>({threadId,cwd:process.cwd()}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    readExecutionAvailability:async()=>true,startInvocation:()=>{starts++;},
    onAuthenticationConfirmed:()=>assert.fail('no completed GUI turn'),
    readDelivery:async()=>{assert.equal(++reads,1,'provisional interruption must not exit into receipt read-back');return {state:'uncertain'};},
    spawnProcess:desktopRpc({threadId,snapshotStatuses:['interrupted'],onQueue:()=>{queues++;},
      onRequest:request=>{if(request.method==='thread/turns/list')setImmediate(()=>controller.abort());}}),
  }),/DELIVERY_UNCERTAIN/);
  assert.equal(starts,1);assert.equal(queues,1);assert.equal(reads,1);
});

test('external task context permits bounded structural refs only, without bodies/owner assertions/argv options',()=>{
  const ref={sourceId:randomUUID(),sourceRevision:3,routeId:randomUUID(),eventOrdinal:2,provider:'telegram',accountId:randomUUID(),eventId:'message:123:4',
    eventRevision:'b'.repeat(64),conversationKey:`telegram-conversation/v1.${'a'.repeat(64)}`};
  assert.deepEqual(assistantWorkStateContext({...taskContext,sourceReferences:[ref]}).sourceReferences,[ref]);
  assert.deepEqual(assistantWorkStateContext({...taskContext,sourceReferences:[{...ref,intakeKind:'route_existing'}]}).sourceReferences,[{...ref,intakeKind:'route_existing'}]);
  for(const intakeKind of ['owner_command','create_task','PRIVATE',null])assert.throws(()=>assistantWorkStateContext({...taskContext,sourceReferences:[{...ref,intakeKind}]}),/INVALID_INPUT/);
  for(const provider of ['email','max']){
    const native={...ref,provider,eventId:provider==='email'?'uid:17:11':'message:-123:4',conversationKey:`${provider}-conversation/v1.${'a'.repeat(64)}`};
    assert.deepEqual(assistantWorkStateContext({...taskContext,sourceReferences:[native]}).sourceReferences,[native]);
    for(const changed of [{conversationKey:ref.conversationKey},{eventId:provider==='email'?'message:123:4':'uid:17:11'},
      {eventId:provider==='email'?'uid:0:11':'message:-0:4'},{body:'PRIVATE'},{owner:true}])
      assert.throws(()=>assistantWorkStateContext({...taskContext,sourceReferences:[{...native,...changed}]}),/INVALID_INPUT/);
  }
  for(const changed of [{body:'PRIVATE'},{owner:true},{provider:'max'},{sourceId:'--config'},{accountId:'PRIVATE'},
    {sourceRevision:-1},{routeId:'PRIVATE'},{eventOrdinal:-1},{eventOrdinal:100},{eventId:'PRIVATE'},{eventRevision:'PRIVATE'},{conversationKey:'PRIVATE'}])
    assert.throws(()=>assistantWorkStateContext({...taskContext,sourceReferences:[{...ref,...changed}]}),/INVALID_INPUT/);
  for(const refs of [[],[ref,ref],Array.from({length:101},(_,index)=>({...ref,eventId:`message:123:${index+1}`}))])
    assert.throws(()=>assistantWorkStateContext({...taskContext,sourceReferences:refs}),/INVALID_INPUT/);
});


test('recovery marker evidence requires complete bounded summaries and rejects present/ambiguous history',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID(),marker=assistantDeliveryMarker(deliveryId);
  for(const [data,nextCursor,evidence] of [
    [[{id:turnId,items:[]}],null,'absent'],
    [[{id:turnId,items:[]}],undefined,'ambiguous'],
    [[{id:'invalid',items:[]}],null,'ambiguous'],
    [[{id:turnId,items:[{type:'userMessage',content:[{type:'text',text:marker+'\nPRIVATE'}]}]}],null,'present'],
  ]){
    const result=await readAssistantCodexDelivery(threadId,deliveryId,{requireAbsentMarker:true,executable:process.execPath,environment:{},
      spawnProcess:nativeRpc(request=>request.method==='thread/read'?{result:{thread:{id:threadId,cwd:process.cwd()}}}:{result:{data,nextCursor}})});
    assert.deepEqual(result,{state:'uncertain',markerEvidence:evidence});assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  }
});

test('pre-native recovery callback runs once after SAME model preflight and before irreversible start',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID();let modelChecks=0,recovery=0,starts=0;
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},{requireAbsentMarker:true,
    executable:process.execPath,environment:{},readDelivery:async()=>({state:'uncertain',markerEvidence:'absent'}),
    readMetadata:async()=>({threadId,cwd:process.cwd()}),readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>{modelChecks++;return true;},
    beforeInvocation:async()=>{assert.equal(modelChecks,1);recovery++;throw Object.assign(new Error('closed native CAS conflict'),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});},
    openDesktop:async()=>{},startInvocation:()=>{starts++;},spawnProcess:desktopRpc({threadId,onQueue:()=>assert.fail('failed recovery queued work')})}),/closed native CAS conflict/);
  assert.equal(modelChecks,1);assert.equal(recovery,1);assert.equal(starts,0);
});


test('successful pre-native recovery reads a real positive receipt after the one native start',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();let reads=0,models=0,recoveries=0,starts=0;
  const result=await runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},{requireAbsentMarker:true,passTimeoutMs:1000,
    executable:process.execPath,environment:{},readMetadata:async()=>({threadId,cwd:process.cwd()}),
    readDelivery:async(_thread,_delivery,options)=>{
      if(++reads===1){assert.equal(options.requireAbsentMarker,true);return {state:'uncertain',markerEvidence:'absent'};}
      assert.equal(options.requireAbsentMarker,false);return {state:'completed',turnId,receipt:`codex:${threadId}:${turnId}`};
    },readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>{models++;return true;},beforeInvocation:async()=>{assert.equal(models,1);recoveries++;},
    startInvocation:()=>{assert.equal(recoveries,1);starts++;},openDesktop:async()=>{},
    spawnProcess:desktopRpc({threadId})});
  assert.equal(result.state,'completed');assert.equal(reads,2);assert.equal(models,1);assert.equal(recoveries,1);assert.equal(starts,1);
});

test('reviewed continuation uses a NEW stdin marker in the same chat, with receipt inspection before any action',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),priorTurnId=randomUUID(),turnId=randomUUID();let input='',reads=0,starts=0,checked=false;
  const options={continuationReview:{priorTurnId,reviewId:deliveryId},requireAbsentMarker:true,
    executable:process.execPath,environment:{},readMetadata:async()=>({threadId,cwd:process.cwd()}),readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>true,
    beforeInvocation:async()=>{checked=true;},startInvocation:()=>{assert.equal(checked,true);starts++;},
    readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',turnId,receipt:`codex:${threadId}:${turnId}`},
    openDesktop:async()=>{},spawnProcess:desktopRpc({threadId,onInput:text=>{input=text;}})};
  assert.equal((await runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},options)).state,'completed');
  assert.equal(starts,1);assert.ok(input.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));
  assert.match(input,/ONE automatic recovery continuation/);assert.ok(input.includes(priorTurnId));assert.match(input,/Do not repeat the previous command/);
  assert.match(input,/earlier error is not a current result/);
  assert.match(input,/ordinary status without that handle and an exact native Run read/);
  assert.match(input,/technical reopening needs no new owner approval/);
  assert.match(input,/Decide what remains to be done and continue the task/);
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},
    {...options,continuationReview:{priorTurnId,reviewId:randomUUID()},readDelivery:()=>assert.fail('invalid review reached I/O')}),/INVALID_INPUT/);
});


test('Desktop handoff failure and mismatched native settings never submit task content or consume its bit',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID();let starts=0,queues=0;
  const options={executable:process.execPath,environment:{},readMetadata:async()=>({threadId,cwd:process.cwd()}),
    readDelivery:async()=>({state:'uncertain'}),readExecutionAvailability:async()=>true,readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    startInvocation:()=>{starts++;},openDesktop:async()=>{throw Error('PRIVATE OS ERROR');},
    spawnProcess:desktopRpc({threadId,onQueue:()=>{queues++;}})};
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},options),
    error=>error.code==='ASSISTANT_CODEX_DELIVERY_UNCERTAIN'&&!error.message.includes('PRIVATE'));
  for(const pair of [{...execution,effortLevel:'ultra'},{...execution,modelId:'other'},{}]){
    await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},
      {...options,openDesktop:async()=>{},spawnProcess:desktopRpc({threadId,pair,onQueue:()=>{queues++;}})}),/MODEL_UNAVAILABLE/);
  }
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},
    {...options,openDesktop:async()=>{},spawnProcess:desktopRpc({threadId,queued:[{id:randomUUID()}],onQueue:()=>{queues++;}})}),/DELIVERY_UNCERTAIN/);
  assert.equal(starts,0);assert.equal(queues,0);
});

test('empty bootstrap is closed before GUI opens and only the second Desktop READY earns provision',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),children=[];let starts=0,saved=false,opened=false,queues=0,bootstraps=0,names=0;
  const options={executable:process.execPath,environment:{},chatKind:'owner_dialogue',readExecutionAvailability:async()=>true,
    readHookReadiness:()=>assert.fail('empty READY never earns or needs business hook authority'),
    startInvocation:()=>{starts++;},onThreadStarted:value=>{assert.equal(value,threadId);saved=true;},
    openDesktop:async uri=>{assert.equal(uri,`codex://threads/${threadId}`);assert.ok(saved);assert.ok(children.every(c=>c.killed));opened=true;},
    readDelivery:async()=>{assert.equal(queues,1);return {state:'completed',turnId:randomUUID(),receipt:'exact:desktop:ready'};},
    spawnProcess:desktopRpc({threadId,children,onRequest:request=>{if(request.method==='thread/name/set'){names++;assert.ok(opened);assert.equal(queues,1);assert.equal(request.params.name,'Переписка с владельцем');}},onCreate:request=>{
      assert.deepEqual(request.params,{cwd:process.cwd(),model:execution.modelId,ephemeral:false,allowProviderModelFallback:false});
    },onInput:(text,phase)=>{
      assert.ok(saved);assert.doesNotMatch(text,/TRELIO_ASSISTANT_SCOPE|WORK\.md/);
      if(phase==='bootstrap'){bootstraps++;assert.ok(!opened);assert.ok(text.startsWith(`TRELIO_ASSISTANT_DESKTOP_PREPARE ${deliveryId}\n`));
        assert.ok(!text.includes(assistantDeliveryMarker(deliveryId)));}
      else{assert.ok(opened);assert.ok(text.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));}
    },onQueue:()=>{queues++;assert.ok(opened);}}),
  };
  assert.equal((await provisionAssistantCodexChat({deliveryId,cwd:process.cwd(),execution},options)).threadId,threadId);
  assert.equal(starts,1);assert.equal(bootstraps,1);assert.equal(queues,1);assert.equal(children.length,3);assert.equal(names,1);
  assert.ok(children.every(c=>c.killed));
  // The same API bootstrap receipt cannot masquerade as a GUI receipt if the
  // owner has closed Desktop or its URI handler is unavailable.
  let readbacks=0;
  await assert.rejects(provisionAssistantCodexChat({deliveryId:randomUUID(),cwd:process.cwd(),execution},
    {...options,spawnProcess:desktopRpc({threadId}),openDesktop:async()=>{throw Error('NO_DESKTOP');},
      readDelivery:async()=>{readbacks++;return {state:'completed'};}}),/DELIVERY_UNCERTAIN/);
  assert.equal(readbacks,0);
});

test('lost queue response retains uncertainty, closes its own reader and never retries or interrupts GUI',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),children=[];let queues=0,starts=0;
  const spawnProcess=nativeRpc(request=>{
    if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd:process.cwd(),model:execution.modelId,reasoningEffort:execution.effortLevel}}};
    if(request.method==='thread/queue/list')return {result:{data:[],nextCursor:null}};
    assert.equal(request.method,'thread/queue/add');queues++;
    return {error:{code:-32000,message:'PRIVATE LOST RESPONSE'}};
  });
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},{
    executable:process.execPath,environment:{},openDesktop:async()=>{},
    readMetadata:async()=>({threadId,cwd:process.cwd()}),readDelivery:async()=>({state:'uncertain'}),
    readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),readExecutionAvailability:async()=>true,startInvocation:()=>{starts++;},
    spawnProcess:(...args)=>{const child=spawnProcess(...args);children.push(child);return child;},
  }),error=>error.code==='ASSISTANT_CODEX_DELIVERY_UNCERTAIN'&&!error.message.includes('PRIVATE'));
  assert.equal(queues,1);assert.equal(starts,1);assert.equal(children.length,1);assert.ok(children[0].killed);
});


test('fresh plugin readiness requires native trusted hooks plus connected MCP/tools, without experimental plugin RPC or a model',async()=>{
  const hooks=['sessionStart','preToolUse','sessionEnd'].map(eventName=>({eventName,handlerType:'command',source:'plugin',
    pluginId:'trelio-digital-assistant@trelio-digital-assistants',enabled:true,currentHash:'opaque-current-native-hash',trustStatus:'trusted'}));
  const tools=Object.fromEntries(['begin_assistant_setup','finish_assistant_setup','get_assistant_setup_status',
    'install_assistant_background','start_assistant_background','get_assistant_background_status'].map(name=>[name,{name}]));
  const run=async(patch={},rows=hooks)=>{
    const calls=[];
    const value=await readAssistantCodexPluginReadiness(process.cwd(),{executable:process.execPath,environment:{},spawnProcess:nativeRpc(request=>{
      calls.push(request.method);
      if(request.method==='hooks/list')return {result:{data:[{hooks:rows,errors:[],warnings:[]}]}};
      if(request.method==='config/mcpServer/reload')return {result:{}};
      assert.equal(request.method,'mcpServerStatus/list');assert.equal(request.params.serverName,'trelio-assistant');
      return {result:{data:[{name:'trelio-assistant',pluginId:'trelio-digital-assistant@trelio-digital-assistants',
        runtimeStatus:'connected',toolsError:null,tools,...patch}],nextCursor:null}};
    })});
    assert.deepEqual(calls,['hooks/list','config/mcpServer/reload','mcpServerStatus/list']);return value;
  };
  assert.deepEqual(await run(),{state:'configuration_present'});
  assert.deepEqual(await run({runtimeStatus:null}),{state:'configuration_present'},'cached native status is configuration only, not activation');
  for(const patch of [{runtimeStatus:'failed'},{toolsError:'PRIVATE native error'},{pluginId:'human@other'},{tools:{}}])
    await assert.rejects(run(patch),{code:'ASSISTANT_MCP_RECONNECT_REQUIRED'});
  await assert.rejects(run({},hooks.map(h=>({...h,trustStatus:'untrusted'}))),{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});
});

test('separate native hook trust survives main metadata changes but refuses missing, duplicated or modified executable components',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-stable-hook-native-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'codex'),main=path.join(root,'main'),component=path.join(home,'plugins/cache/trelio-digital-assistants/trelio-digital-assistant-hooks/0.1.0');
  const digest=text=>createHash('sha256').update(text).digest('hex');
  const files={'.gitattributes':'* -text\n','.codex-plugin/plugin.json':'{"name":"trelio-digital-assistant-hooks","version":"0.1.0"}','hooks/hooks.json':'{}'};
  for(const file of ['launch-trelio-node','launch-trelio-node.cmd','resolve-node.ps1','trelio-host-runtime-download.mjs','trelio-host-runtime-loader.mjs','trelio-host-runtime-shell.mjs','trelio-mcp-startup-budget.mjs'])files[`scripts/${file}`]='// synthetic executable dependency';
  for(const [name,text] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(component,name)),{recursive:true});await fs.writeFile(path.join(component,name),text);}
  const inventory=JSON.stringify({schemaVersion:1,plugin:'trelio-digital-assistant-hooks',version:'0.1.0',sharedShell:{},files:Object.entries(files).map(([p,text])=>({path:p,mode:0o644,size:Buffer.byteLength(text),sha256:digest(text)}))});
  await fs.writeFile(path.join(component,'package-integrity.json'),inventory);await fs.mkdir(main);
  const requirement={pluginId:'trelio-digital-assistant-hooks@trelio-digital-assistants',version:'0.1.0',integritySha256:digest(inventory)};
  const mainInventory=version=>fs.writeFile(path.join(main,'package-integrity.json'),JSON.stringify({schemaVersion:1,plugin:'trelio-digital-assistant',version,hookComponent:requirement}));
  await mainInventory('0.1.5');
  let trustStatus='trusted',extra=false,wrongPath=false;
  const hooks=()=>['preToolUse','sessionEnd','sessionStart'].map(eventName=>({eventName,pluginId:requirement.pluginId,source:'plugin',enabled:true,
    trustStatus,handlerType:'command',currentHash:'synthetic-native-immutable-hook-hash',sourcePath:path.join(component,wrongPath?'other.json':'hooks/hooks.json')}));
  const options={executable:process.execPath,environment:{TRELIO_PLUGIN_ROOT:main,CODEX_HOME:home},spawnProcess:nativeRpc(request=>{
    assert.equal(request.method,'hooks/list');return {result:{data:[{hooks:[...hooks(),...(extra?[{...hooks()[0],pluginId:'trelio-digital-assistant@trelio-digital-assistants'}]:[])],errors:[],warnings:[]}]}};
  })};
  const before=await readAssistantCodexHookReadiness(root,options);await mainInventory('0.1.6');
  assert.deepEqual(await readAssistantCodexHookReadiness(root,options),before,'only the executable component participates in native hook trust');
  for(const status of ['untrusted','modified']){trustStatus=status;await assert.rejects(readAssistantCodexHookReadiness(root,options),{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});}trustStatus='trusted';
  extra=true;await assert.rejects(readAssistantCodexHookReadiness(root,options),{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});extra=false;
  wrongPath=true;await assert.rejects(readAssistantCodexHookReadiness(root,options),{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});wrongPath=false;
  await fs.appendFile(path.join(component,'scripts/trelio-host-runtime-loader.mjs'),'\n// changed executable');
  await assert.rejects(readAssistantCodexHookReadiness(root,options),{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});
});


test('owner reply recovery reads one completed exact native call, never invokes a model or accepts ambiguous history',async()=>{
 const threadId=randomUUID(),deliveryId=randomUUID(),pass={companyId:randomUUID(),sourceId:randomUUID(),intakeId:randomUUID()};
 const original={id:randomUUID(),status:'completed',items:[{type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(deliveryId)+'\nprivate scope'}]},
  {type:'mcpToolCall',server:'trelio-assistant',tool:'resolve_assistant_intake',arguments:{intakePass:pass,clientRequestId:pass.intakeId,decision:'reply_owner',replyText:'  Synthetic answer\n'}}]};
 let turns=[original];const spawnProcess=nativeRpc(request=>{
  assert.equal(request.method,'thread/read');return {result:{thread:{id:threadId,cwd:process.cwd(),...(request.params.includeTurns?{turns}:{})}}};});
 const options={executable:process.execPath,environment:{},spawnProcess};
 assert.equal(await readAssistantCodexOwnerReply(threadId,deliveryId,pass,options),'  Synthetic answer\n',
  'read-only reconciliation preserves the immutable original, including legacy plain whitespace');
 for(const changed of [{...original,status:'interrupted'},{...original,items:[...original.items,original.items[1]]},
  {...original,items:[original.items[0],{...original.items[1],arguments:{...original.items[1].arguments,intakePass:{...pass,sourceId:randomUUID()}}}]}]){
   turns=[changed];assert.equal(await readAssistantCodexOwnerReply(threadId,deliveryId,pass,options),null);
 }
 turns=[original,original];assert.equal(await readAssistantCodexOwnerReply(threadId,deliveryId,pass,options),null);
});

test('prepared reply capture selects only the final exact pre-dispatch refusal without replaying earlier tools',async()=>{
 const {assistantPreparedOwnerReply}=await import('../host-runtime/scripts/trelio-assistant-codex.mjs');
 const deliveryId=randomUUID(),intakePass={companyId:randomUUID(),sourceId:randomUUID(),intakeId:randomUUID()};
 const code='ASSISTANT_MCP_LOCAL_WORKSPACE_ARGUMENTS_TRELIO_BACKEND_HTTP_404';
 const reply={type:'mcpToolCall',server:'trelio-assistant',tool:'resolve_assistant_intake',status:'failed',error:null,
  arguments:{intakePass,clientRequestId:intakePass.intakeId,decision:'reply_owner',replyText:'  Prepared answer\n',runtimeSessionProof:{}},
  result:{isError:true,content:[{type:'text',text:code}]}};
 const context={type:'mcpToolCall',server:'trelio-assistant',tool:'get_assistant_intake_context',status:'completed',error:null,
  arguments:{intakePass,runtimeSessionProof:{}},result:{content:[{type:'text',text:'synthetic original'}]}};
 const turn={id:randomUUID(),status:'completed',error:null,items:[
  {type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(deliveryId)+'\nsynthetic scope'}]},context,
  {type:'mcpToolCall',server:'codex_apps',tool:'google_calendar.read_event',status:'completed',result:{content:[]}},
  // A completed earlier action is NOT certified read-only. The new primitive
  // only captures an already prepared output; it never re-executes this code,
  // classifies its effects as absent, starts a model, or grants delivery.
  {type:'mcpToolCall',server:'cua_repl',tool:'js',status:'completed',arguments:{code:'synthetic unknown action'},result:{content:[]}},
  context,reply,{type:'agentMessage',text:'synthetic final note'}]};
 const options={deliveryId,intakePass};
 assert.equal(typeof assistantPreparedOwnerReply,'function');
 assert.deepEqual(assistantPreparedOwnerReply(turn,options),{turnId:turn.id,replyText:'  Prepared answer\n'});
 assert.equal(await assistantReadOnlyPreparationFailure(turn,{...options,replyDispatchCorrection:true}),false,
  'output capture must NEVER broaden an existing whole-turn read-only certificate');
 const changed=change=>{const copy=structuredClone(turn);change(copy);return assistantPreparedOwnerReply(copy,options);};
 for(const state of ['failed','interrupted','inProgress'])assert.equal(changed(t=>{t.status=state;}),null);
 assert.equal(changed(t=>{t.error={message:'unknown native error'};}),null);
 assert.equal(changed(t=>{t.items.push(reply);}),null);
 assert.equal(changed(t=>{t.items.push(context);}),null,'a tool after the final refusal is not the selected output');
 assert.equal(changed(t=>{t.items[3].status='inProgress';}),null);
 assert.equal(changed(t=>{t.items.push(t.items[0]);}),null);
 for(const mutation of [r=>{r.status='completed';},r=>{r.result.isError=false;},
  r=>{r.result.content[0].text='prose '+code;},r=>{r.error={message:'prose '+code};},
  r=>{r.result.structuredContent={code:'ASSISTANT_INTAKE_CHANGED'};},
  r=>{r.arguments.intakePass.sourceId=randomUUID();},r=>{r.arguments.clientRequestId=randomUUID();},
  r=>{r.arguments.replyFile={workspaceId:randomUUID()};},r=>{r.arguments.replyText='';},
  r=>{r.arguments.replyText='\ud800';},r=>{r.arguments.replyText='x'.repeat(4097);},r=>{r.arguments.replyText='x\0';}])
  assert.equal(changed(t=>mutation(t.items[5])),null);
});

test('prepared reply reader completes bounded native pages and refuses unknown or duplicate later history',async()=>{
 const {readAssistantCodexPreparedOwnerReply}=await import('../host-runtime/scripts/trelio-assistant-codex.mjs');
 const threadId=randomUUID(),deliveryId=randomUUID(),pass={companyId:randomUUID(),sourceId:randomUUID(),intakeId:randomUUID()};
 const context={type:'mcpToolCall',server:'trelio-assistant',tool:'get_assistant_intake_context',status:'completed',
  arguments:{intakePass:pass,runtimeSessionProof:{}},result:{content:[]}};
 const original={id:randomUUID(),status:'completed',items:[
  {type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(deliveryId)+'\nsynthetic original'}]},context,
  {type:'mcpToolCall',server:'trelio-assistant',tool:'resolve_assistant_intake',status:'failed',arguments:{
   intakePass:pass,clientRequestId:pass.intakeId,decision:'reply_owner',replyText:'  Exact prepared text\n',runtimeSessionProof:{}},
   result:{structuredContent:{code:'ASSISTANT_MCP_LOCAL_WORKSPACE_ARGUMENTS_TRELIO_BACKEND_HTTP_404'},content:[]}}]};
 const proof={...pass,intakeId:randomUUID(),deliveryId:randomUUID(),eventId:randomUUID(),sourceRevision:2,
  receiptId:randomUUID(),taskId:randomUUID(),threadId};
 const successor={id:randomUUID(),status:'completed',items:[
  {type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(proof.deliveryId)+'\nsynthetic later original'}]},
  {...context,arguments:{intakePass:{companyId:pass.companyId,sourceId:pass.sourceId,intakeId:proof.intakeId},runtimeSessionProof:{}}},
  {type:'mcpToolCall',server:'trelio-assistant',tool:'resolve_assistant_intake',status:'completed',arguments:{
   intakePass:{companyId:pass.companyId,sourceId:pass.sourceId,intakeId:proof.intakeId},clientRequestId:proof.intakeId,
   decision:'create_task',projectId:randomUUID(),fields:{title:'synthetic'},runtimeSessionProof:{}},result:{structuredContent:{
    schemaVersion:1,id:proof.intakeId,companyId:pass.companyId,sourceId:pass.sourceId,sourceRevision:proof.sourceRevision,
    eventId:proof.eventId,threadId,state:'created',taskId:proof.taskId,receiptId:proof.receiptId,readConfirmed:true,ownerPrivateRead:true}}}]};
 let pages=[{data:[successor],nextCursor:'older'},{data:[original],nextCursor:null}],requests=[];
 const read=(extra={})=>readAssistantCodexPreparedOwnerReply(threadId,deliveryId,pass,{executable:process.execPath,environment:{},
  settledCreationSuccessors:[proof],...extra,spawnProcess:nativeRpc(request=>{
   requests.push(request.method);
   if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd:process.cwd()}}};
   assert.equal(request.method,'thread/turns/list','capture may never queue/start/resume or execute a tool');
   return {result:pages[request.params.cursor===undefined?0:1]};
  })});
 assert.deepEqual(await read(),{turnId:original.id,replyText:'  Exact prepared text\n'});
 assert.equal(requests.filter(method=>method==='thread/turns/list').length,2);
 assert.equal(await read({settledCreationSuccessors:[]}),null);
 pages=[{data:[successor,original],nextCursor:'older'},{data:[structuredClone(original)],nextCursor:null}];
 assert.equal(await read(),null,'the original duplicate on a later page must still refuse');
 pages=[{data:[{...successor,status:'interrupted'},original],nextCursor:null}];assert.equal(await read(),null);
 pages=[{data:[{...successor,items:[...successor.items,{type:'mcpToolCall',server:'other',tool:'send',status:'completed'}]},original],nextCursor:null}];
 assert.equal(await read(),null,'a later creation receipt does not certify extra native effects');
 pages=[{data:[successor,original],nextCursor:'older'},{data:[],nextCursor:'older'}];assert.equal(await read(),null);
 assert.throws(()=>read({settledCreationSuccessors:[{...proof,replyText:'must stay private'}]}),/INVALID_INPUT/);
});

test('model-free Codex usage reads exact native account and quotas without a model or private fields',async()=>{
  const {readAssistantCodexUsage}=await import('../host-runtime/scripts/trelio-assistant-codex.mjs');
  const calls=[];
  const value=await readAssistantCodexUsage({executable:process.execPath,environment:{},spawnProcess:nativeRpc(request=>{
    calls.push(request.method);
    if(request.method==='account/read')return {result:{account:{type:'chatgpt',email:'PRIVATE'},requiresOpenaiAuth:true}};
    assert.equal(request.method,'account/rateLimits/read');
    return {result:{ordinaryUsageAllowed:true,accountId:'PRIVATE',rateLimits:{primary:{usedPercent:1}},rateLimitsByLimitId:{codex:{
      primary:{usedPercent:91,windowDurationMins:10080,resetsAt:1800000000},secondary:{usedPercent:95,windowDurationMins:300,resetsAt:1799999999},
      credits:{balance:'PRIVATE',hasCredits:false,unlimited:false},limitName:'PRIVATE'}}}};
  })});
  assert.deepEqual(calls,['account/read','account/rateLimits/read']);assert.equal(value.state,'available');
  assert.deepEqual(value.windows.map(w=>[w.remainingPercent,w.windowDurationMins]),[[9,10080],[5,300]]);
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
});

test('quota denial and recovery use native permission, never percent, timer or another model bucket',async()=>{
  const {normalizeAssistantCodexUsage:project,validateAssistantCodexUsage}=await import('../host-runtime/scripts/trelio-assistant-codex.mjs');
  const bucket={primary:{usedPercent:100,windowDurationMins:300,resetsAt:1},credits:{hasCredits:false,unlimited:false}};
  const value={rateLimits:bucket,ordinaryUsageAllowed:false};
  assert.equal(project(value).state,'blocked');
  assert.equal(project({...value,ordinaryUsageAllowed:true}).state,'available');
  assert.equal(project({...value,ordinaryUsageAllowed:null}).state,'unknown');
  assert.equal(project({...value,rateLimits:{...bucket,credits:{hasCredits:true,unlimited:false}}}).state,'available');
  assert.equal(project({...value,ordinaryUsageAllowed:true,rateLimits:{...bucket,spendControlReached:true}}).state,'blocked');
  assert.equal(project({...value,rateLimitsByLimitId:{codex:{},other:{...bucket,spendControlReached:true}}}).state,'unknown');
  assert.equal(project({...value,rateLimits:{...bucket,primary:{usedPercent:101}}}).windows[0].remainingPercent,0);
  assert.throws(()=>project({...value,rateLimits:{...bucket,primary:{usedPercent:-1}}}));
  assert.throws(()=>validateAssistantCodexUsage({state:'available',windows:[],accountId:'PRIVATE'}));
});

test('usage observer retains confirmed block after native failure or unknown CAS and never retries POST',async()=>{
  const {maintainAssistantCodexUsage}=await import('../host-runtime/scripts/trelio-assistant-codex.mjs');
  let writes=0;const current={revision:1,checkedAt:null,snapshot:null,blocked:true};
  const client={readCodexUsage:async()=>current,reportCodexUsage:async()=>{writes++;throw new Error('PRIVATE');}};
  assert.equal((await maintainAssistantCodexUsage({client,readUsage:async()=>{throw new Error('PRIVATE');}})).blocked,true);
  assert.equal(writes,0);
  assert.equal((await maintainAssistantCodexUsage({client,readUsage:async()=>({state:'available',windows:[]})})).blocked,true);
  assert.equal(writes,1);
});


test('a refused cosmetic name RPC preserves the exact verified GUI provision, with no second queue/create',async()=>{
 const threadId=randomUUID(),deliveryId=randomUUID();let creates=0,queues=0,starts=0,names=0;
 const options={executable:process.execPath,environment:{},readExecutionAvailability:async()=>true,
  startInvocation:()=>{starts++;},onThreadStarted:id=>assert.equal(id,threadId),openDesktop:async()=>{},
  readDelivery:async()=>({state:'completed',turnId:randomUUID(),receipt:'synthetic:positive-gui-ready'}),
  spawnProcess:desktopRpc({threadId,nameFailure:true,onCreate:()=>{creates++;},onQueue:()=>{queues++;},
   onRequest:request=>{if(request.method==='thread/name/set')names++;}})};
 const value=await provisionAssistantCodexChat({deliveryId,cwd:process.cwd(),execution},options);
 assert.equal(value.state,'completed');assert.equal(value.threadId,threadId);
 assert.equal(creates,1);assert.equal(queues,1);assert.equal(starts,1);assert.equal(names,1);
});

// Public native failure metadata is authoritative only on the exact failed
// turn. Provider/tool prose, quota errors and ambiguous reads stay closed.
test('capacity projection recognises native overload and the exact older Desktop message without exposing diagnostics',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const read=async(status,error,extra=[])=>readAssistantCodexDelivery(threadId,deliveryId,{
    executable:process.execPath,environment:{},spawnProcess:nativeRpc(request=>request.method==='thread/read'?{result:{thread:{id:threadId,cwd:process.cwd()}}}:({result:{data:[{id:turnId,status,error,
      items:[{type:'userMessage',content:[{type:'text',text:`TRELIO_ASSISTANT_DELIVERY ${deliveryId}\nwork`}]},...extra]}]}}))});
  const message='Selected model is at capacity. Please try a different model.';
  for(const error of [{codexErrorInfo:'serverOverloaded',message:'PRIVATE native details'},
    {message},{codexErrorInfo:'other',message}]){
    const result=await read('failed',error);assert.equal(result.failure,'model_capacity');
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|Selected model/);
  }
  for(const error of [{codexErrorInfo:'usageLimitExceeded',message},
    {codexErrorInfo:'rateLimitExceeded',message},{message:`${message} PRIVATE`},
    {message:'server_is_overloaded'},{codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}}}])
    assert.equal((await read('failed',error)).failure,undefined);
  assert.equal((await read('completed',{codexErrorInfo:'serverOverloaded'})).failure,undefined);
  assert.equal((await read('failed',null,[{type:'agentMessage',text:message}])).failure,undefined);
});

test('an overloaded owned bootstrap keeps its persisted UUID; a later READY retries through the GUI without thread creation',async()=>{
  const threadId=randomUUID(),original=randomUUID(),retry=randomUUID();let creates=0,starts=0,queues=0,reads=0;
  const common={executable:process.execPath,environment:{},readExecutionAvailability:async()=>true,openDesktop:async()=>{},
    startInvocation:()=>{starts++;},onThreadStarted:id=>assert.equal(id,threadId)};
  await assert.rejects(provisionAssistantCodexChat({deliveryId:original,cwd:process.cwd(),execution},{...common,
    spawnProcess:desktopRpc({threadId,onCreate:()=>{creates++;},onQueue:()=>assert.fail('failed bootstrap cannot queue READY'),
      bootstrapError:{codexErrorInfo:'serverOverloaded',message:'PRIVATE error'}})}),{code:'ASSISTANT_CODEX_MODEL_CAPACITY'});
  const result=await provisionAssistantCodexChat({deliveryId:retry,threadId,cwd:process.cwd(),execution},{...common,
    onThreadStarted:()=>assert.fail('retry may not create another chat'),
    readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',turnId:randomUUID(),receipt:'ready'},
    spawnProcess:desktopRpc({threadId,onCreate:()=>assert.fail('no thread/start on retry'),onQueue:()=>{queues++;}})});
  assert.equal(result.state,'completed');assert.equal(result.threadId,threadId);assert.equal(creates,1);assert.equal(queues,1);assert.equal(starts,2);
});

test('a PREPARE witness is visible only for failed capacity, never a successful GUI provision or task delivery',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const read=(status,provision,error)=>readAssistantCodexDelivery(threadId,deliveryId,{executable:process.execPath,environment:{},provision,
    spawnProcess:nativeRpc(request=>request.method==='thread/read'?{result:{thread:{id:threadId,cwd:process.cwd()}}}:
      {result:{data:[{id:turnId,status,error,items:[{type:'userMessage',content:[{type:'text',
        text:`TRELIO_ASSISTANT_DESKTOP_PREPARE ${deliveryId}\nREADY`}]}]}],nextCursor:null}})});
  assert.equal((await read('completed',true,null)).state,'uncertain');
  assert.equal((await read('failed',true,{codexErrorInfo:'other',message:'PRIVATE'})).state,'uncertain');
  assert.equal((await read('failed',false,{codexErrorInfo:'serverOverloaded'})).state,'uncertain');
  assert.equal((await read('failed',true,{codexErrorInfo:'serverOverloaded'})).failure,'model_capacity');
});


const readonlyPreparationFixture=()=>{
 const deliveryId=randomUUID(),threadId=randomUUID(),intakePass={companyId:randomUUID(),sourceId:randomUUID(),intakeId:randomUUID()};
 const environment={TRELIO_PLUGIN_ROOT:'C:\\public\\assistant',ProgramFiles:'C:\\Program Files',WINDIR:'C:\\Windows'};
 const args={companySlugs:['synthetic'],queries:['SYNTHETIC_PRIVATE_QUERY'],intakePass,runtimeSessionProof:{}};
 const call=(tool,arguments_,structuredContent,status='completed')=>({type:'mcpToolCall',server:'trelio-assistant',tool,status,
  arguments:arguments_,result:{structuredContent,content:[]}});
 const turn={id:randomUUID(),status:'completed',error:null,items:[
  {type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(deliveryId)+'\nSYNTHETIC_PRIVATE_BODY'}]},
  {type:'commandExecution',status:'completed',exitCode:0,
   command:'"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content -LiteralPath \'C:\\public\\assistant\\skills\\assistant-task-worker\\SKILL.md\'"',
   commandActions:[{type:'read',name:'SKILL.md',path:'C:/public/assistant/skills/assistant-task-worker/SKILL.md'}]},
  call('get_assistant_intake_context',{intakePass,runtimeSessionProof:{}},{schemaVersion:1}),
  call('search',args,{schemaVersion:1,state:'preparing',readOnly:true,nextCall:{tool:'search',arguments:{queries:args.queries,companySlugs:args.companySlugs}}}),
  call('search',structuredClone(args),{code:'ASSISTANT_COMPANY_CONTEXT_PREPARATION_TIMED_OUT'},'failed'),
  call('resolve_assistant_intake',{intakePass,runtimeSessionProof:{},clientRequestId:intakePass.intakeId,decision:'reply_owner',replyText:'SYNTHETIC_PRIVATE_REPLY'},
   {code:'ASSISTANT_INTAKE_CHANGED'},'failed')]};
 return {turn,deliveryId,threadId,intakePass,environment};
};
/** Synthetic reproduction of a terminal, ordinary owner read cancellation.
 * The two failed fetches and failed file preparation are native MCP results,
 * not an interpretation of an assistant's explanation. No production message,
 * locator, answer or company material is used by this regression.
 */
const cancelledContextReadFixture=()=>{
 const f=readonlyPreparationFixture(),code='ASSISTANT_MCP_LOCAL_COMPANY_READ_FAILED';
 f.turn.items=f.turn.items.filter(item=>item.type!=='commandExecution');
 const failed=(tool,args,failure)=>({type:'mcpToolCall',server:'trelio-assistant',tool,status:'failed',
  arguments:{intakePass:f.intakePass,runtimeSessionProof:{},...args},
  result:{isError:true,content:[{type:'text',text:failure}]}});
 f.turn.items.splice(2,0,
  failed('fetch',{id:'task:synthetic/project/1'},code),
  failed('fetch',{id:`workspace-file:${randomUUID()}:${'a'.repeat(40)}:artifacts%2Fexample.md`},code));
 // The real native sequence can try the selected file between preparation
 // polls. Every fetch still failed before reservation; no result or effect is
 // hidden merely because the model alternated the two read-only operations.
 const [fileFetch]=f.turn.items.splice(3,1);f.turn.items.splice(4,0,fileFetch);
 f.turn.items[f.turn.items.length-2]=failed('search',
  {companySlugs:['synthetic'],queries:['SYNTHETIC_PRIVATE_QUERY']},'ASSISTANT_COMPANY_CONTEXT_PREPARATION_TIMED_OUT');
 f.turn.items[f.turn.items.length-1]=failed('resolve_assistant_intake',{
  clientRequestId:f.intakePass.intakeId,decision:'reply_owner',replyText:'SYNTHETIC_PRIVATE_REPLY',
  replyFile:{workspaceId:randomUUID(),workspaceHead:'a'.repeat(40),name:'artifacts/example.md'}},code);
 return f;
};
test('cancelled context-read recovery requires its own closed whole-terminal certificate',async()=>{
 const f=cancelledContextReadFixture();
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,cancelledContextRead:true}),true,
  'An ordinary cancelled read needs a distinct native classifier; it cannot borrow the old continuation mode');
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,f),false);
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,readOnlyContinuation:true}),false);
});
test('cancelled context-read certificate accepts only exact native result projections, never prose',async()=>{
 for(const shape of ['structured','literal_content','literal_error']){
  const f=cancelledContextReadFixture();
  for(const item of f.turn.items.filter(item=>item.type==='mcpToolCall'&&item.status==='failed')){
   const code=item.result.content[0].text;
   if(shape==='structured')item.result={isError:true,structuredContent:{code},content:[]};
   if(shape==='literal_error'){item.error={message:code};item.result={content:[]};}
  }
  const preparing=f.turn.items.find(item=>item.tool==='search'&&item.status==='completed');
  preparing.result={content:[{type:'text',text:JSON.stringify(preparing.result.structuredContent)}]};
  assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,cancelledContextRead:true}),true,shape);
 }
});
test('cancelled context-read certificate refuses effects, incomplete history, foreign pass and unknown sends',async()=>{
 const alterations=[
  t=>{t.status='failed';},t=>{t.error={codexErrorInfo:'serverOverloaded'};},
  t=>{t.items.push(structuredClone(t.items[0]));},
  t=>{t.items[2].server='other';},t=>{t.items[2].arguments.intakePass.intakeId=randomUUID();},
  t=>{t.items[2].arguments.extra=true;},t=>{t.items[2].tool='create_task';},
  t=>{t.items[2].status='completed';},t=>{t.items[2].result.isError=false;},
  t=>{t.items[2].result.content[0].text='explanation ASSISTANT_MCP_LOCAL_COMPANY_READ_FAILED';},
  t=>{t.items[2].result.content[0].text='ASSISTANT_TRANSPORT_RATE_LIMITED';},
  t=>{t.items[2].error={message:'OTHER'};},
  t=>{t.items[2].result.structuredContent={code:'OTHER'};},
  t=>{t.items=t.items.filter(item=>item.tool!=='fetch');},
  t=>{t.items.at(-2).result.content[0].text='ASSISTANT_RUNTIME_REQUEST_CANCELLED';},
  t=>{t.items.at(-2).arguments.queries=['OTHER_QUERY'];},
  t=>{t.items.find(i=>i.tool==='search'&&i.status==='completed').result.structuredContent.state='ready';},
  t=>{const i=t.items.find(i=>i.tool==='search'&&i.status==='completed');i.result={content:[{type:'text',text:'prose '+JSON.stringify(i.result.structuredContent)}]};},
  t=>{t.items.at(-1).status='completed';},
  t=>{t.items.at(-1).result.structuredContent={state:'reply_pending'};},
  t=>{t.items.at(-1).arguments.decision='create_task';},
  t=>{delete t.items.at(-1).arguments.replyFile;},
  t=>{t.items.at(-1).arguments.replyFile.name='../outside';},
  t=>{t.items.at(-1).arguments.replyFile.workspaceHead='UNKNOWN';},
  t=>{t.items.at(-1).arguments.clientRequestId=randomUUID();},
  t=>{t.items.at(-1).arguments.replyText='x'.repeat(1025);},
  t=>{t.items.at(-1).result.content[0].text='ASSISTANT_INTAKE_CHANGED';},
  t=>{t.items.pop();},t=>{t.items.push(structuredClone(t.items.at(-1)));},
  t=>{t.items.splice(-1,0,structuredClone(t.items[2]));},
  t=>{t.items.splice(2,0,{type:'commandExecution',status:'completed',exitCode:0,command:'provider send',commandActions:[]});},
  t=>{t.items.splice(2,0,{type:'unknown'});},
 ];
 for(const change of alterations){
  const f=cancelledContextReadFixture();change(f.turn);
  assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,cancelledContextRead:true}),false,String(change));
 }
 const f=cancelledContextReadFixture();
 for(const options of [{cancelledContextRead:false},{cancelledContextRead:true,readOnlyContinuation:true},
  {cancelledContextRead:true,replyDispatchCorrection:true},{cancelledContextRead:true,technicalReplyCorrection:{}}])
  assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,...options}),false);
});
test('cancelled context-read native adapter preserves complete unique history and returns only the separate witness',async()=>{
 const f=cancelledContextReadFixture();
 const read=(pages,extra={})=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{
  executable:process.execPath,environment:f.environment,readOnlyPreparation:f.intakePass,cancelledContextRead:true,...extra,
  spawnProcess:nativeRpc(request=>{
   if(request.method==='thread/read')return {result:{thread:{id:f.threadId,cwd:process.cwd()}}};
   assert.equal(request.method,'thread/turns/list');assert.equal(request.params.itemsView,'full');
   return {result:pages(request.params)};
  })});
 const value=await read(()=>({data:[f.turn],nextCursor:null}));
 assert.deepEqual(value,{state:'completed',turnId:f.turn.id,receipt:`codex:${f.threadId}:${f.turn.id}`,
  readOnlyFailure:'company_context_file_read_cancelled'});
 assert.equal(JSON.stringify(value).includes('SYNTHETIC_PRIVATE'),false);
 assert.deepEqual(await read(params=>params.cursor?{data:[f.turn],nextCursor:null}
  :{data:[f.turn],nextCursor:'duplicate'}),{state:'uncertain'});
 assert.deepEqual(await read(()=>({data:[{id:randomUUID(),status:'completed',items:[]},f.turn],nextCursor:null})),{state:'uncertain'});
 assert.deepEqual(await read(()=>({data:[f.turn],nextCursor:'loop'})),{state:'uncertain'});
 assert.deepEqual(await read(()=>({data:[f.turn],nextCursor:null}),{readOnlyContinuation:true}),{state:'uncertain'});
});
test('portable PowerShell recovery verifies a signature with the fixed reader, never executes the candidate',async()=>{
 const candidate='C:\\portable\\pwsh.exe',environment={WINDIR:'C:\\Windows'};
 let spawned=0,stdin='',killed=0;
 const statFile=async file=>{assert.equal(file,candidate);return {isFile:()=>true,size:1024};};
 const run=async(output,code=0,signal)=>verifyAssistantPowerShellReadExecutable(candidate,{platform:'win32',environment,signal,statFile,
  spawnProcess:(executable,args,options)=>{
   spawned++;assert.equal(executable,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
   assert.deepEqual(args,['-NoLogo','-NoProfile','-NonInteractive','-Command','-']);
   assert.deepEqual(options,{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore']});
   const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();
   child.kill=()=>{killed++;};
   child.stdin.on('data',data=>{stdin+=data.toString();});
   child.stdin.on('finish',()=>queueMicrotask(()=>{
    if(output===null){signal?.dispatchEvent(new Event('abort'));return;}
    child.stdout.write(output);child.emit('close',code);
   }));return child;
  }});
 assert.equal(await run('VALID'),true);
 assert.match(stdin,/Get-AuthenticodeSignature -LiteralPath \$p/);
 assert.match(stdin,/Microsoft Corporation/);assert.match(stdin,/ProductName -eq 'PowerShell'/);
 assert.ok(stdin.includes(Buffer.from(candidate).toString('base64')));
 assert.ok(!stdin.includes(candidate),'candidate is encoded data, never shell syntax');
 for(const [output,code] of [['',0],['INVALID',0],['VALID',1],['VALID PRIVATE',0],['x'.repeat(33),0]])
  assert.equal(await run(output,code),false);
 assert.equal(await run(null,0,new AbortController().signal),false);
 assert.equal(spawned,7);assert.equal(killed,7);
 // Reject unsupported platforms, already-cancelled reads and oversized/non-files
 // before a subprocess. A basename or successful process exit alone never grants it.
 for(const options of [{platform:'linux'},{signal:AbortSignal.abort()},
  {statFile:async()=>({isFile:()=>false,size:1024})},
  {statFile:async()=>({isFile:()=>true,size:64*1024*1024+1})}])
  assert.equal(await verifyAssistantPowerShellReadExecutable(candidate,{platform:'win32',environment,statFile,
   spawnProcess:()=>assert.fail('invalid candidate cannot start a reader'),...options}),false);
});
test('portable bootstrap signature is consulted only after exact public command and target validation',async()=>{
 const f=readonlyPreparationFixture();f.turn.items[1].command=f.turn.items[1].command.replace('C:\\Program Files\\PowerShell\\7','C:\\portable');
 let calls=0;const verifyShell=async(executable,options)=>{calls++;assert.equal(executable,'C:\\portable\\pwsh.exe');
  assert.equal(options.environment,f.environment);return true;};
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,verifyShell}),true);assert.equal(calls,1);
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,verifyShell:async()=>false}),false);
 for(const change of [t=>{t.items[1].command+='; side_effect';},t=>{t.items[1].commandActions[0].path='C:/private/SKILL.md';},
  t=>{t.items[1].command=t.items[1].command.replace('SKILL.md','private.md');}]){
  const turn=structuredClone(f.turn);change(turn);
  assert.equal(await assistantReadOnlyPreparationFailure(turn,{...f,verifyShell:()=>assert.fail('invalid command never checks signature')}),false);
 }
});
test('read-only owner recovery requires the whole terminal native chain and exact public bootstrap read',async()=>{
 const f=readonlyPreparationFixture();assert.equal(await assistantReadOnlyPreparationFailure(f.turn,f),true);
 const changes=[
  t=>{t.status='running';},t=>{t.error={message:'unknown'};},
  t=>{t.items.push({type:'webSearch'});},t=>{t.items[1].command+='; Write-Output side_effect';},
  t=>{t.items[1].command=t.items[1].command.replace('pwsh.exe','untrusted.exe');},
  t=>{t.items[1].command=t.items[1].command.replace('SKILL.md','other.md');},
  t=>{t.items[1].commandActions[0].path='C:/private/other/SKILL.md';},
  t=>{t.items[3].server='untrusted';},t=>{t.items[3].tool='create_task';},
  t=>{t.items[3].arguments.intakePass={...f.intakePass,intakeId:randomUUID()};},
  t=>{t.items[3].result.structuredContent.state='ready';},
  t=>{t.items[4].result.structuredContent={code:'OTHER'};t.items[4].error={message:'ASSISTANT_COMPANY_CONTEXT_PREPARATION_TIMED_OUT'};},
  t=>{t.items[4].arguments.queries=['another formulation'];},
  t=>{t.items[5].result.structuredContent={state:'reply_pending'};},
  t=>{t.items.splice(3,0,structuredClone(t.items[2]));},
 ];
 for(const change of changes){const turn=structuredClone(f.turn);change(turn);assert.equal(await assistantReadOnlyPreparationFailure(turn,f),false,String(change));}
 const afterContext=structuredClone(f.turn);[afterContext.items[1],afterContext.items[2]]=[afterContext.items[2],afterContext.items[1]];
 afterContext.items.splice(4,0,{type:'sleep',durationMs:10000});
 assert.equal(await assistantReadOnlyPreparationFailure(afterContext,f),true,'public bootstrap after context and native waiting are read-only too');
 const preview=structuredClone(f.turn);preview.items[1].command=preview.items[1].command.replace('PowerShell\\7\\','PowerShell\\7-preview\\');
 assert.equal(await assistantReadOnlyPreparationFailure(preview,f),true);
 const redirected={...f.environment,ProgramFiles:'C:\\Program Files (x86)',ProgramW6432:f.environment.ProgramFiles};
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,environment:redirected}),true);
 const withoutResolve=structuredClone(f.turn);withoutResolve.items.pop();assert.equal(await assistantReadOnlyPreparationFailure(withoutResolve,f),true);
});
test('reply-only native recovery retains the structural intake ABI and queues one scoped original',async()=>{
 const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID(),cwd=await fs.realpath(process.cwd());
 const intakeContext={assistantId:randomUUID(),companyId:randomUUID(),sourceId:randomUUID(),sourceRevision:1,intakeId:randomUUID(),eventId:randomUUID()};
 let reads=0,starts=0,input='';
 await runAssistantCodexPass({threadId,deliveryId,cwd,intakeContext,execution},{replyOnlyRecovery:true,
  readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},
  readMetadata:async()=>({threadId,cwd}),startInvocation:()=>{starts++;},
  readDelivery:async()=>++reads===1?{state:'uncertain'}:{state:'completed',turnId,receipt:`codex:${threadId}:${turnId}`},
  openDesktop:async()=>{},spawnProcess:desktopRpc({threadId,cwd,onInput:text=>{input=text;}})});
 assert.equal(starts,1);assert.ok(input.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));
 const scope=input.split('\n').find(line=>line.startsWith('TRELIO_ASSISTANT_INTAKE '));
 assert.deepEqual(JSON.parse(scope.slice('TRELIO_ASSISTANT_INTAKE '.length)),{kind:'source_intake',...intakeContext});
 assert.match(input,/Only reply_owner is permitted/);
 assert.match(input,/already available external sources/);
 assert.match(input,/failed read-only tab attachment/u);
 assert.match(input,/In a source intake it remains read-only/u);
 assert.match(input,/A personal question does not require a task or Workspace Run/);
 assert.match(input,/real ACL and current login/);assert.match(input,/fresh current company sources again/);
 assert.match(input,/does not establish that a prior response was delivered/);
 assert.doesNotMatch(input,/prior technical limitation reply was positively delivered/);
 assert.doesNotMatch(scope,/taskId|recovery|workStatePath/,'hook ABI stays structural and unchanged');
 await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd,taskContext,execution},{replyOnlyRecovery:true}),/INVALID_INPUT/);
});
test('routing-only intake receives no browser observation recovery or wider tool guidance',async()=>{
 const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID(),eventId=randomUUID(),cwd=await fs.realpath(process.cwd());
 const intakeContext={assistantId:randomUUID(),companyId:randomUUID(),sourceId:randomUUID(),sourceRevision:1,
  intakeId:randomUUID(),eventId,intakeKind:'route_existing',eventIds:[eventId]};
 let reads=0,starts=0,input='';
 await runAssistantCodexPass({threadId,deliveryId,cwd,intakeContext,execution},{
  readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},
  readMetadata:async()=>({threadId,cwd}),startInvocation:()=>{starts++;},
  readDelivery:async()=>++reads===1?{state:'uncertain'}:{state:'completed',turnId,receipt:`codex:${threadId}:${turnId}`},
  openDesktop:async()=>{},spawnProcess:desktopRpc({threadId,cwd,onInput:text=>{input=text;}})});
 assert.equal(starts,1);assert.match(input,/restricted source_triage\/v1/u);
 assert.doesNotMatch(input,/failed read-only tab attachment|native app\/computer interface/u);
 assert.match(input,/Use only get_assistant_intake_context and resolve_assistant_intake/u);
});
test('native recovery reader requires complete latest unique marker coverage and returns only a closed witness',async()=>{
 const f=readonlyPreparationFixture();let reads=0;
 const read=(pages,extra={})=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{executable:process.execPath,environment:f.environment,...extra,
  readOnlyPreparation:f.intakePass,spawnProcess:nativeRpc(request=>{
   if(request.method==='thread/read')return {result:{thread:{id:f.threadId,cwd:process.cwd()}}};
   assert.equal(request.method,'thread/turns/list');assert.equal(request.params.itemsView,'full');reads++;
   return {result:pages(request.params)};
  })});
 const result=await read(()=>({data:[f.turn],nextCursor:null}));
 assert.deepEqual(result,{state:'completed',turnId:f.turn.id,receipt:`codex:${f.threadId}:${f.turn.id}`,readOnlyFailure:'company_context_preparation_timeout'});
 assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);
 assert.deepEqual(await read(params=>params.cursor?{data:[f.turn],nextCursor:null}:{data:[f.turn],nextCursor:'second'}),{state:'uncertain'});
 assert.deepEqual(await read(()=>({data:[{id:randomUUID(),status:'completed',items:[]},f.turn],nextCursor:null})),{state:'uncertain'});
 assert.deepEqual(await read(()=>({data:[f.turn],nextCursor:'repeating'})),{state:'uncertain'});
 f.turn.items[1].command=f.turn.items[1].command.replace('C:\\Program Files\\PowerShell\\7','C:\\portable');
 let verified=0;
 assert.equal((await read(()=>({data:[f.turn],nextCursor:null}),{verifyReadOnlyShell:async()=>{verified++;return true;}})).readOnlyFailure,
  'company_context_preparation_timeout');assert.equal(verified,1);
 assert.ok(reads>=5);
});

const settledCreationFixture=f=>{
 const witness={companyId:f.intakePass.companyId,sourceId:f.intakePass.sourceId,sourceRevision:1,
  intakeId:randomUUID(),eventId:randomUUID(),threadId:f.threadId,deliveryId:randomUUID(),taskId:randomUUID(),receiptId:randomUUID()};
 const intakePass={companyId:witness.companyId,sourceId:witness.sourceId,intakeId:witness.intakeId},projectId=randomUUID();
 const call=(tool,args,result)=>({type:'mcpToolCall',server:'trelio-assistant',tool,status:'completed',
  arguments:{intakePass,runtimeSessionProof:{},...args},result:{isError:false,structuredContent:result}});
 const turn={id:randomUUID(),status:'completed',error:null,items:[
  {type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(witness.deliveryId)+'\nSYNTHETIC_OTHER_ORIGINAL'}]},
  call('get_assistant_intake_context',{},{}),
  call('get_assistant_intake_context',{projectId},{}),
  call('resolve_assistant_intake',{clientRequestId:witness.intakeId,decision:'create_task',projectId,fields:{title:'SYNTHETIC_TASK'}},
   {schemaVersion:1,id:witness.intakeId,companyId:witness.companyId,sourceId:witness.sourceId,sourceRevision:witness.sourceRevision,
    eventId:witness.eventId,threadId:witness.threadId,state:'created',taskId:witness.taskId,receiptId:witness.receiptId,
    readConfirmed:true,ownerPrivateRead:true}),{type:'agentMessage',text:'SYNTHETIC_OTHER_RESULT'}]};
 // Native context is commonly content-only. Its prose is never parsed as
 // authority; only the final create receipt must be structured and exact.
 for(const item of turn.items.slice(1,3))item.result={content:[{type:'text',text:'SYNTHETIC_PRIVATE_CONTEXT'}]};
 return {witness,turn};
};
test('read-only recovery skips only separately certified completed task-creation successors across complete history',async()=>{
 const f=readonlyPreparationFixture(),successor=settledCreationFixture(f);
 const read=(turns=[successor.turn,f.turn],proofs=[successor.witness],pageSize=20)=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{
  executable:process.execPath,environment:f.environment,readOnlyPreparation:f.intakePass,settledCreationSuccessors:proofs,
  spawnProcess:nativeRpc(request=>{
   if(request.method==='thread/read')return {result:{thread:{id:f.threadId,cwd:process.cwd()}}};
   assert.equal(request.method,'thread/turns/list');assert.equal(request.params.itemsView,'full');
   const offset=Number(request.params.cursor??0),data=turns.slice(offset,offset+pageSize);
   return {result:{data,nextCursor:offset+data.length<turns.length?String(offset+data.length):null}};
  })});
 assert.equal((await read()).readOnlyFailure,'company_context_preparation_timeout');
 assert.equal((await read(undefined,undefined,1)).readOnlyFailure,'company_context_preparation_timeout','original may be on the next full page');
 assert.deepEqual(await read(undefined,[]),{state:'uncertain'},'a completed turn alone is not a native outcome receipt');
 for(const change of [
  t=>{t.status='running';},t=>{t.error={codexErrorInfo:'serverOverloaded'};},
  t=>{t.items.splice(2,0,{type:'commandExecution',status:'completed',exitCode:0});},
  t=>{t.items[3].arguments.decision='reply_owner';},t=>{t.items[3].arguments.replyText='PRIVATE';},
  t=>{t.items[3].arguments.clientRequestId=randomUUID();},t=>{t.items[3].arguments.projectId=randomUUID();},
  t=>{t.items[3].arguments.intakePass={...t.items[3].arguments.intakePass,intakeId:randomUUID()};},
  t=>{t.items[3].status='failed';},t=>{t.items[3].result.isError=true;},
  t=>{t.items[3].result.structuredContent.receiptId=randomUUID();},t=>{t.items[3].result.structuredContent.taskId=randomUUID();},
  t=>{t.items[3].result.structuredContent.eventId=randomUUID();},t=>{t.items[3].result.structuredContent.sourceRevision++;},
  t=>{t.items[3].result.structuredContent.ownerPrivateRead=false;},
  t=>{t.items.splice(4,0,structuredClone(t.items[3]));},t=>{t.items[1].tool='send';},
 ]){
  const turn=structuredClone(successor.turn);change(turn);
  assert.deepEqual(await read([turn,f.turn]),{state:'uncertain'},String(change));
 }
 for(const proofs of [[{...successor.witness,companyId:randomUUID()}],[{...successor.witness,threadId:randomUUID()}],
  [{...successor.witness,intakeId:f.intakePass.intakeId}],[successor.witness,successor.witness],Array(9).fill(successor.witness)])
  assert.deepEqual(await read(undefined,proofs),{state:'uncertain'});
 assert.deepEqual(await read([successor.turn,successor.turn,f.turn]),{state:'uncertain'},'duplicate native turn refuses');
 assert.deepEqual(await read([successor.turn,f.turn,structuredClone(f.turn)]),{state:'uncertain'},'duplicate original refuses');
 assert.deepEqual(await read([f.turn,successor.turn]),{state:'uncertain'},'a receipt cannot excuse a missing newer turn');
 assert.deepEqual(await read([successor.turn,{id:randomUUID(),status:'completed',items:[]},f.turn]),{state:'uncertain'},'unknown intervening turn refuses');
 const second=settledCreationFixture(f);
 assert.equal((await read([second.turn,successor.turn,f.turn],[second.witness,successor.witness])).readOnlyFailure,'company_context_preparation_timeout');
});

// A confirmed technical reply is a distinct recovery boundary: the old send
// happened and remains immutable. Prove the entire native read-only chain and
// its positive receipt before admitting any later corrective response.
test('technical reply correction requires exact read-only rate failure and positive native reply receipt',async()=>{
 const f=readonlyPreparationFixture(),receiptId=randomUUID(),eventId=randomUUID(),sourceRevision=2;
 const witness={receiptId,eventId,sourceRevision,threadId:f.threadId};
 const options={...f,technicalReplyCorrection:witness};
 const error=f.turn.items.at(-2),resolve=f.turn.items.at(-1);
 error.result.structuredContent={code:'ASSISTANT_TRANSPORT_RATE_LIMITED'};
 resolve.status='completed';resolve.result.structuredContent={schemaVersion:1,...f.intakePass,id:f.intakePass.intakeId,
  sourceRevision,eventId,threadId:f.threadId,state:'replied',taskId:null,receiptId,readConfirmed:true,ownerPrivateRead:true};
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,options),true);
 const nativeRead=turns=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{...options,readOnlyPreparation:f.intakePass,
  executable:process.execPath,spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'
   ?{thread:{id:f.threadId,cwd:process.cwd()}}:{data:turns,nextCursor:null}}))});
 assert.equal((await nativeRead([f.turn])).readOnlyFailure,'company_context_rate_limited_reply');
 assert.deepEqual(await nativeRead([f.turn,f.turn]),{state:'uncertain'});
 assert.deepEqual(await nativeRead([{id:randomUUID(),status:'completed',items:[]},f.turn]),{state:'uncertain'});
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,f),false,'never reclassify a positive send as an absent-provider timeout');
 for(const patch of [{receiptId:randomUUID()},{eventId:randomUUID()},{threadId:randomUUID()},{sourceRevision:3},{extra:true}])
  assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...options,technicalReplyCorrection:{...witness,...patch}}),false);
 const altered=change=>{const t=structuredClone(f.turn);change(t);return t;};
 for(const t of [altered(t=>{t.status='failed';}),altered(t=>{t.error={codexErrorInfo:'serverOverloaded'};}),
  altered(t=>{t.items.at(-1).status='failed';}),altered(t=>{t.items.at(-1).result.structuredContent.state='reply_pending';}),
  altered(t=>{t.items.at(-1).result.structuredContent.taskId=randomUUID();}),
  altered(t=>{t.items.at(-2).result.structuredContent.code='ASSISTANT_INTAKE_ACCESS_DENIED';}),
  altered(t=>{t.items.at(-2).status='completed';}),altered(t=>{t.items.splice(-1,0,structuredClone(t.items.at(-2)));}),
  altered(t=>{t.items[3].result.structuredContent={schemaVersion:1,state:'ready'};}),
  altered(t=>{t.items.splice(-1,0,{...structuredClone(t.items[3]),tool:'fetch'});}),
  altered(t=>{t.items.at(-1).arguments.decision='create_task';})])
  assert.equal(await assistantReadOnlyPreparationFailure(t,options),false);
});

test('cancelled reply-only continuation certifies only the whole original no-send search turn',async()=>{
 const f=readonlyPreparationFixture();f.turn.items.pop();
 f.turn.items.at(-1).result.structuredContent={code:'ASSISTANT_RUNTIME_REQUEST_CANCELLED'};
 const options={...f,readOnlyContinuation:true};
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,options),true);
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,f),false,'cancellation never becomes legacy timeout authority');
 const read=turns=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{...options,readOnlyPreparation:f.intakePass,
  executable:process.execPath,spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'
   ?{thread:{id:f.threadId,cwd:process.cwd()}}:{data:turns,nextCursor:null}}))});
 assert.equal((await read([f.turn])).readOnlyFailure,'company_context_read_cancelled');
 assert.deepEqual(await read([f.turn,f.turn]),{state:'uncertain'});
 assert.deepEqual(await read([{id:randomUUID(),status:'completed',items:[]},f.turn]),{state:'uncertain'});
 for(const change of [t=>{t.items.at(-1).result.structuredContent={code:'OTHER'};},
  t=>{t.items.at(-1).status='completed';},t=>{t.items[3].result.structuredContent={schemaVersion:1,state:'ready'};},
  t=>{t.items.push({...structuredClone(t.items[3]),tool:'fetch'});},
  t=>{t.items.push({...structuredClone(t.items[3]),tool:'resolve_assistant_intake'});},
  t=>{t.items.at(-1).arguments.queries=['changed query'];},
  t=>{t.items[1].command+='; side_effect';},t=>{t.status='running';},
  t=>{t.error={codexErrorInfo:'serverOverloaded'};}]){
  const turn=structuredClone(f.turn);change(turn);
  assert.equal(await assistantReadOnlyPreparationFailure(turn,options),false);
 }
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...options,technicalReplyCorrection:{}}),false);
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...options,readOnlyContinuation:false}),false);
});

test('generation correction certifies the whole positive technical turn, one refresh and no business effect',async()=>{
 const f=readonlyPreparationFixture(),receiptId=randomUUID(),eventId=randomUUID(),sourceRevision=2;
 const witness={receiptId,eventId,sourceRevision,threadId:f.threadId};
 const options={...f,generationReplyCorrection:witness};
 const refusal=f.turn.items.at(-2),resolve=f.turn.items.at(-1);
 refusal.result.structuredContent={code:'ASSISTANT_COMPANY_CONTEXT_LOCAL_CONTEXT_GENERATION_CHANGED'};
 resolve.status='completed';resolve.result.structuredContent={schemaVersion:1,...f.intakePass,id:f.intakePass.intakeId,
  sourceRevision,eventId,threadId:f.threadId,state:'replied',taskId:null,receiptId,readConfirmed:true,ownerPrivateRead:true};
 const refresh=structuredClone(f.turn.items.find(item=>item.tool==='get_assistant_intake_context'));
 const second=structuredClone(refusal);second.arguments.queries=['independent closed failure'];
 f.turn.items.splice(-1,0,refresh,second);
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,options),true);
 const read=turns=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{...options,readOnlyPreparation:f.intakePass,
  executable:process.execPath,spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'
   ?{thread:{id:f.threadId,cwd:process.cwd()}}:{data:turns,nextCursor:null}}))});
 assert.equal((await read([f.turn])).readOnlyFailure,'company_context_generation_changed_reply');
 for(const shape of ['native_error','content']){
  const turn=structuredClone(f.turn);
  for(const item of turn.items.filter(item=>item.tool==='search'&&item.status==='failed')){
   item.result={isError:true};
   if(shape==='native_error')item.error={message:'ASSISTANT_COMPANY_CONTEXT_LOCAL_CONTEXT_GENERATION_CHANGED'};
   else item.result.content=[{type:'text',text:'ASSISTANT_COMPANY_CONTEXT_LOCAL_CONTEXT_GENERATION_CHANGED'}];
  }
  assert.equal(await assistantReadOnlyPreparationFailure(turn,options),true,shape);
 }
 for(const alter of [t=>{t.status='failed';},t=>{t.error={codexErrorInfo:'serverOverloaded'};},
  t=>{t.items.at(-1).result.structuredContent.state='reply_pending';},
  t=>{t.items.at(-1).result.structuredContent.receiptId=randomUUID();},
  t=>{t.items.at(-1).result.structuredContent.taskId=randomUUID();},
  t=>{t.items.at(-2).result.structuredContent.code='ASSISTANT_TRANSPORT_RATE_LIMITED';},
  t=>{t.items.at(-2).result.isError=false;},t=>{t.items.at(-2).error={message:'OTHER'};},
  t=>{t.items.at(-2).status='completed';},t=>{t.items.splice(-1,0,refresh);},
  t=>{t.items.splice(2,0,refresh);},t=>{t.items.splice(-1,0,{...second,tool:'fetch'});},
  t=>{t.items.at(-1).arguments.decision='create_task';},
  t=>{t.items.find(item=>item.tool==='search'&&item.status==='completed').result.structuredContent.state='ready';},
  t=>{t.items.at(-2).result.structuredContent={code:'explanation ASSISTANT_COMPANY_CONTEXT_LOCAL_CONTEXT_GENERATION_CHANGED'};},
  t=>{t.items.push(structuredClone(resolve));}]){
  const turn=structuredClone(f.turn);alter(turn);
  assert.equal(await assistantReadOnlyPreparationFailure(turn,options),false,String(alter));
 }
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...options,readOnlyContinuation:true}),false);
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...options,technicalReplyCorrection:witness}),false);
 assert.deepEqual(await read([f.turn,f.turn]),{state:'uncertain'});
 assert.deepEqual(await read([{id:randomUUID(),status:'completed',items:[]},f.turn]),{state:'uncertain'});
});


test('final dispatch refusal requires the whole successful read-only turn and one exact failed resolve',async()=>{
 const f=readonlyPreparationFixture(),options={...f,replyDispatchCorrection:true};
 f.turn.items.splice(4,1); // No prior preparation error may borrow this certificate.
 const call=(tool,args,result={})=>({type:'mcpToolCall',server:'trelio-assistant',tool,status:'completed',
  arguments:{...args,intakePass:f.intakePass,runtimeSessionProof:{}},result:{content:[],structuredContent:result}});
 f.turn.items.splice(-1,0,
  call('search',{companySlugs:['synthetic'],queries:['SYNTHETIC_PRIVATE_QUERY']},{schemaVersion:1,results:[{id:'task:synthetic/work/1'}]}),
  call('fetch',{id:'task:synthetic/work/1'},{task:{number:1}}),
  call('get_task_sections',{companySlug:'synthetic',projectSlug:'work',taskNumber:1,sections:['comments']},{comments:[]}));
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,options),true);
 const read=turns=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{...options,readOnlyPreparation:f.intakePass,
  executable:process.execPath,spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'
   ?{thread:{id:f.threadId,cwd:process.cwd()}}:{data:turns,nextCursor:null}}))});
 assert.equal((await read([f.turn])).readOnlyFailure,'owner_reply_dispatch_refused');
 for(const shape of ['native_error','content']){
  const turn=structuredClone(f.turn),last=turn.items.at(-1);last.result={isError:true};
  if(shape==='native_error')last.error={message:'ASSISTANT_INTAKE_CHANGED'};
  else last.result.content=[{type:'text',text:'ASSISTANT_INTAKE_CHANGED'}];
  assert.equal(await assistantReadOnlyPreparationFailure(turn,options),true,shape);
 }
 for(const alter of [t=>{t.status='running';},t=>{t.status='failed';},t=>{t.error={codexErrorInfo:'serverOverloaded'};},
  t=>{t.items.at(-1).status='completed';},t=>{t.items.at(-1).arguments.decision='create_task';},
  t=>{t.items.at(-1).arguments.clientRequestId=randomUUID();},t=>{t.items.at(-1).arguments.intakePass.sourceId=randomUUID();},
  t=>{t.items.at(-1).result.structuredContent={code:'explanation ASSISTANT_INTAKE_CHANGED'};},
  t=>{t.items.at(-1).result.structuredContent={code:'ASSISTANT_TRANSPORT_RATE_LIMITED'};},
  t=>{t.items.at(-1).result.isError=false;},t=>{t.items.at(-1).error={message:'OTHER'};},
  t=>{t.items[3].status='failed';},t=>{t.items[3].result.isError=true;},
  t=>{t.items[4].tool='create_comment';},t=>{t.items[4].server='other';},
  t=>{t.items.splice(2,1);},t=>{t.items[1].command+='; side_effect';},
  t=>{t.items.push(structuredClone(t.items.at(-1)));}]){
  const turn=structuredClone(f.turn);alter(turn);assert.equal(await assistantReadOnlyPreparationFailure(turn,options),false,String(alter));
 }
 for(const patch of [{replyDispatchCorrection:false},{readOnlyContinuation:true},{technicalReplyCorrection:{}},{generationReplyCorrection:{}}])
  assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...options,...patch}),false);
 assert.deepEqual(await read([f.turn,f.turn]),{state:'uncertain'});
 assert.deepEqual(await read([{id:randomUUID(),status:'completed',items:[]},f.turn]),{state:'uncertain'});
});

// A permanent owner chat may receive an independent question while an older
// no-send receipt is closed. Only the new dispatch profile can skip a later
// fully settled read-only reply; its positive receipt never proves the old
// answer or permits provider replay. Exercise complete pagination and refusals.
test('dispatch recovery skips only independently certified settled read-only replies',async()=>{
 const f=readonlyPreparationFixture(),context=structuredClone(f.turn.items.find(i=>i.tool==='get_assistant_intake_context'));
 const refused=structuredClone(f.turn.items.at(-1));
 const parent={id:randomUUID(),status:'completed',error:null,items:[structuredClone(f.turn.items[0]),context,refused]};
 const later=settledCreationFixture(f);later.witness.taskId=null;
 const pass={companyId:later.witness.companyId,sourceId:later.witness.sourceId,intakeId:later.witness.intakeId};
 const call=(tool,args,result={})=>({type:'mcpToolCall',server:'trelio-assistant',tool,status:'completed',
  arguments:{intakePass:pass,runtimeSessionProof:{},...args},result:{structuredContent:result}});
 later.turn.items=[later.turn.items[0],call('get_assistant_intake_context',{}),
  call('search',{companySlugs:['synthetic'],queries:['SYNTHETIC_OTHER_QUERY']},{state:'ready',results:[]}),
  call('fetch',{id:'task:synthetic/work/other'}),call('get_task_sections',{sections:['comments']}),
  call('resolve_assistant_intake',{decision:'reply_owner',clientRequestId:pass.intakeId,replyText:'SYNTHETIC_OTHER_REPLY'},
   {schemaVersion:1,id:pass.intakeId,companyId:pass.companyId,sourceId:pass.sourceId,sourceRevision:later.witness.sourceRevision,
    eventId:later.witness.eventId,threadId:f.threadId,state:'replied',taskId:null,receiptId:later.witness.receiptId,
    readConfirmed:true,ownerPrivateRead:true})];
 const read=(turns=[later.turn,parent],proofs=[later.witness],patch={})=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{
  executable:process.execPath,environment:f.environment,readOnlyPreparation:f.intakePass,replyDispatchCorrection:true,
  settledReplySuccessors:proofs,...patch,spawnProcess:nativeRpc(request=>{
   if(request.method==='thread/read')return {result:{thread:{id:f.threadId,cwd:process.cwd()}}};
   assert.equal(request.method,'thread/turns/list');assert.equal(request.params.itemsView,'full');
   const index=Number(request.params.cursor??0);return {result:{data:turns.slice(index,index+1),nextCursor:index+1<turns.length?String(index+1):null}};
  })});
 assert.equal((await read()).readOnlyFailure,'owner_reply_dispatch_refused');
 assert.deepEqual(await read(undefined,[]),{state:'uncertain'});
 assert.deepEqual(await read(undefined,undefined,{replyDispatchCorrection:undefined}),{state:'uncertain'},'older modes do not acquire this exception');
 for(const change of [t=>{t.status='running';},t=>{t.error={codexErrorInfo:'serverOverloaded'};},
  t=>{t.items[2].status='failed';},t=>{t.items[3].tool='create_comment';},t=>{t.items[1].server='foreign';},
  t=>{t.items.at(-1).status='failed';},t=>{t.items.at(-1).result.isError=true;},
  t=>{t.items.at(-1).result.structuredContent.state='reply_pending';},t=>{t.items.at(-1).result.structuredContent.taskId=randomUUID();},
  t=>{t.items.at(-1).result.structuredContent.receiptId=randomUUID();},t=>{t.items.at(-1).result.structuredContent.eventId=randomUUID();},
  t=>{t.items.at(-1).result.structuredContent.ownerPrivateRead=false;},t=>{t.items.at(-1).arguments.clientRequestId=randomUUID();},
  t=>{t.items.splice(2,0,structuredClone(t.items[1]));},t=>{t.items.push(structuredClone(t.items.at(-1)));}]){
  const turn=structuredClone(later.turn);change(turn);assert.deepEqual(await read([turn,parent]),{state:'uncertain'},String(change));
 }
 for(const proofs of [[{...later.witness,taskId:randomUUID()}],[{...later.witness,threadId:randomUUID()}],
  [later.witness,later.witness],Array(9).fill(later.witness)])assert.deepEqual(await read(undefined,proofs),{state:'uncertain'});
 assert.deepEqual(await read([later.turn,later.turn,parent]),{state:'uncertain'});
 assert.deepEqual(await read([parent,later.turn]),{state:'uncertain'});
 assert.deepEqual(await read([later.turn,{id:randomUUID(),status:'completed',items:[]},parent]),{state:'uncertain'});
});


test('exact-read technical correction certifies READY, selected failures and the original positive reply',async()=>{
  const f=readonlyPreparationFixture(),witness={receiptId:randomUUID(),eventId:randomUUID(),sourceRevision:1,threadId:f.threadId};
  f.turn.items=f.turn.items.filter(item=>item.type!=='commandExecution');
  const ready=structuredClone(f.turn.items[2]);
  ready.result.structuredContent={schemaVersion:1,provider:'local_company_context',results:[{id:'context:registry:synthetic'}]};
  const failure={type:'mcpToolCall',server:'trelio-assistant',tool:'fetch',status:'failed',
    arguments:{id:'context:registry:synthetic',intakePass:f.intakePass,runtimeSessionProof:{}},
    result:{isError:true,content:[{type:'text',text:'ASSISTANT_MCP_LOCAL_COMPANY_READ_FAILED'}]}};
  const resolve=f.turn.items.at(-1);resolve.status='completed';
  resolve.result.structuredContent={schemaVersion:1,id:f.intakePass.intakeId,...f.intakePass,...witness,
    state:'replied',taskId:null,readConfirmed:true,ownerPrivateRead:true};
  f.turn.items.splice(3,1,ready,failure);
  const options={...f,technicalReplyCorrection:witness};
  assert.equal(await assistantReadOnlyPreparationFailure(f.turn,options),true);
  assert.equal(await assistantReadOnlyPreparationFailure(f.turn,f),false,'a positive reply never becomes absent-send recovery');
  const read=turns=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{...options,readOnlyPreparation:f.intakePass,
    executable:process.execPath,spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'
      ?{thread:{id:f.threadId,cwd:process.cwd()}}:{data:turns,nextCursor:null}}))});
  assert.equal((await read([f.turn])).readOnlyFailure,'company_context_exact_read_failed_reply');
  assert.deepEqual(await read([f.turn,f.turn]),{state:'uncertain'});
  for(const change of [t=>{t.status='running';},t=>{t.error={message:'PRIVATE'};},
    t=>{t.items[4].status='completed';},t=>{t.items[4].result.isError=false;},
    t=>{t.items[4].arguments.id='unselected';},t=>{t.items[4].tool='create_task';},
    t=>{t.items[4].result.content[0].text='explanation ASSISTANT_MCP_LOCAL_COMPANY_READ_FAILED';},
    t=>{t.items[4].arguments.intakePass.sourceId=randomUUID();},
    t=>{t.items[3].result.structuredContent.results=[];},
    t=>{t.items.at(-1).result.structuredContent.receiptId=randomUUID();},
    t=>{t.items.at(-1).result.structuredContent.state='reply_pending';},
    t=>{t.items.at(-1).result.structuredContent.taskId=randomUUID();},
    t=>{t.items.at(-1).arguments.decision='create_task';},
    t=>{t.items.push(structuredClone(t.items.at(-1)));}]){
    const changed=structuredClone(f.turn);change(changed);
    assert.equal(await assistantReadOnlyPreparationFailure(changed,options),false,String(change));
  }
});
