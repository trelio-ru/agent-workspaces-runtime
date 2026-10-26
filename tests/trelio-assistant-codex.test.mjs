import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assistantDeliveryMarker, assistantWorkStateContext, assistantExecutionConfiguration, readAssistantCodexExecutionAvailability,readAssistantCodexExecutionAvailabilitySet, readAssistantCodexHookReadiness, readAssistantCodexDelivery, runAssistantCodexPass, provisionAssistantCodexChat } from '../host-runtime/scripts/trelio-assistant-codex.mjs';

const execution = {modelId:'gpt-6.1-sol',effortLevel:'high',revision:1};
const taskContext = { assistantId:randomUUID(),companyId:randomUUID(),taskId:randomUUID() };

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
  onRequest=()=>{},pair=execution,queued=[],terminal=true,children=[],snapshotStatuses=[]}={}) => {
  let input='',turnId=randomUUID(),phase='read',snapshot=0;
  const rpc=nativeRpc(request=>{
    onRequest(request);
    if(request.method==='thread/start'){onCreate(request);return {result:{thread:{id:threadId}}};}
    if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd,model:pair.modelId,reasoningEffort:pair.effortLevel}}};
    if(request.method==='turn/start'){
      assert.equal(request.params.model,execution.modelId);assert.equal(request.params.effort,execution.effortLevel);
      assert.equal(request.params.collaborationMode.settings.reasoning_effort,execution.effortLevel);
      input=request.params.input[0].text;phase='bootstrap';onInput(input,'bootstrap');return {result:{turn:{id:turnId}},
        notifications:[{method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}}]};
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
  const repliedTaskContext={...taskContext,ownerQuestionIds:[randomUUID()],sourceReferences};
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
      assert.equal(spawnOptions.env.ComSpec,process.platform==='win32'?'C:\Windows\System32\cmd.exe':undefined);
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
  const threadId=randomUUID(),deliveryId=randomUUID(),children=[];let starts=0,saved=false,opened=false,queues=0,bootstraps=0;
  const options={executable:process.execPath,environment:{},readExecutionAvailability:async()=>true,
    readHookReadiness:()=>assert.fail('empty READY never earns or needs business hook authority'),
    startInvocation:()=>{starts++;},onThreadStarted:value=>{assert.equal(value,threadId);saved=true;},
    openDesktop:async uri=>{assert.equal(uri,`codex://threads/${threadId}`);assert.ok(saved);assert.ok(children.every(c=>c.killed));opened=true;},
    readDelivery:async()=>{assert.equal(queues,1);return {state:'completed',turnId:randomUUID(),receipt:'exact:desktop:ready'};},
    spawnProcess:desktopRpc({threadId,children,onCreate:request=>{
      assert.deepEqual(request.params,{cwd:process.cwd(),model:execution.modelId,ephemeral:false,allowProviderModelFallback:false});
    },onInput:(text,phase)=>{
      assert.ok(saved);assert.doesNotMatch(text,/TRELIO_ASSISTANT_SCOPE|WORK\.md/);
      if(phase==='bootstrap'){bootstraps++;assert.ok(!opened);assert.ok(text.startsWith(`TRELIO_ASSISTANT_DESKTOP_PREPARE ${deliveryId}\n`));
        assert.ok(!text.includes(assistantDeliveryMarker(deliveryId)));}
      else{assert.ok(opened);assert.ok(text.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));}
    },onQueue:()=>{queues++;assert.ok(opened);}}),
  };
  assert.equal((await provisionAssistantCodexChat({deliveryId,cwd:process.cwd(),execution},options)).threadId,threadId);
  assert.equal(starts,1);assert.equal(bootstraps,1);assert.equal(queues,1);assert.equal(children.length,2);
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
