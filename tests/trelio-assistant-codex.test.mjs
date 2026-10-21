import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assistantDeliveryMarker, assistantWorkStateContext, assistantExecutionConfiguration, readAssistantCodexExecutionAvailability, readAssistantCodexDelivery, runAssistantCodexPass, provisionAssistantCodexChat } from '../host-runtime/scripts/trelio-assistant-codex.mjs';

const execution = {modelId:'gpt-6.1-sol',effortLevel:'high',revision:1};
const modelArgs = ['--model',execution.modelId,'--config','model_reasoning_effort="high"'];
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
const nativeRpc = handler => (_executable, args, options) => {
  assert.deepEqual(args,['app-server','--listen','stdio://']); assert.equal(options.shell,false);
  assert.deepEqual(options.stdio,['pipe','pipe','ignore']);
  const child = fakeChild(); let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString(); let boundary;
    while ((boundary=input.indexOf('\n'))!==-1) {
      const request=JSON.parse(input.slice(0,boundary)); input=input.slice(boundary+1);
      if (!request.id) continue;
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id:request.id,
        ...(request.method==='initialize' ? { result:{} } : handler(request)) })}\n`));
    }
  });
  return child;
};

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
    readExecutionAvailability:async choice=>{assert.deepEqual(choice,execution);return false;},
    startInvocation:()=>{starts++;},spawnProcess:()=>{spawns++;assert.fail('unavailable model launched native work');},
  }),/MODEL_UNAVAILABLE/);
  assert.equal(starts,0);assert.equal(spawns,0);
});

test('exact native marker read-back exposes receipt only; quoted/tool text is not acceptance', async () => {
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const text=assistantDeliveryMarker(deliveryId)+'\nprivate instruction';
  const options = { readExecutionAvailability:async()=>true,executable:process.execPath, environment:{}, spawnProcess:nativeRpc(request => {
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
  await assert.rejects(readAssistantCodexDelivery(threadId,deliveryId,{ readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},
    spawnProcess:nativeRpc(() => ({ error:{ code:-32600,message:'PRIVATE SECRET DIAGNOSTIC' } })) }),
    error => error.code==='ASSISTANT_CODEX_READ_UNAVAILABLE' && !/PRIVATE/.test(error.message));
});

test('malformed native JSON frames fail closed instead of crashing the coordinator process', async()=>{
  const options={readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},spawnProcess:()=>{
    const child=fakeChild();queueMicrotask(()=>child.stdout.write('null\n'));return child;
  }};
  await assert.rejects(readAssistantCodexDelivery(randomUUID(),randomUUID(),options),/READ_UNAVAILABLE/);
});

test('initial native chat persists its ID synchronously and consumes no business instruction', async t=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-provision-test-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const threadId=randomUUID(),deliveryId=randomUUID();let started=false,saved=null,input='',confirmed=0;
  const options={readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},
    onAuthenticationConfirmed:async()=>{confirmed++;},
    startInvocation:()=>{started=true;},onThreadStarted:value=>{assert.equal(started,true);saved=value;},
    readDelivery:async value=>{assert.equal(saved,threadId);assert.equal(value,threadId);return{state:'completed',receipt:'fixture:ready'};},
    spawnProcess:(_executable,args)=>{
      assert.deepEqual(args,['exec',...modelArgs,'--json','--skip-git-repo-check','-']);
      const child=fakeChild();child.stdin.on('data',chunk=>{input+=chunk.toString();});
      child.stdin.on('end',()=>queueMicrotask(()=>{
        child.stdout.write(`${JSON.stringify({type:'thread.started',thread_id:threadId})}\n${JSON.stringify({type:'turn.completed'})}\n`);
        child.emit('close',0);
      }));return child;
    },
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
  const repliedTaskContext={...taskContext,ownerQuestionIds:[randomUUID()]};
  let starts=0,reads=0,launches=0,confirmed=0,input='';
  const options = { readExecutionAvailability:async()=>true,executable:process.execPath,environment:{ PATH:process.env.PATH,SHOULD_NOT_PASS:'private' },
    onAuthenticationConfirmed:async()=>{confirmed++;throw new Error('PRIVATE health report failed');},
    startInvocation:() => { if (starts++) throw new Error('private state error'); },
    readMetadata:async () => ({ threadId,cwd }), readDelivery:async () => ++reads===1 ? { state:'uncertain' }
      : { state:'completed',turnId,receipt:`codex:${threadId}:${turnId}` },
    spawnProcess:(_executable,args,spawnOptions) => {
      launches++; assert.deepEqual(args,['exec','resume',threadId,...modelArgs,'--json','--skip-git-repo-check','-']);
      assert.equal(spawnOptions.shell,false); assert.equal(spawnOptions.cwd,expectedCwd);
      assert.equal(spawnOptions.env.SHOULD_NOT_PASS,undefined);
      assert.ok(!args.some(arg => /bypass|ignore-rules|ignore-user-config|approval|sandbox/u.test(arg)));
      const child=fakeChild(); child.stdin.on('data',chunk=>{ input+=chunk.toString(); });
      child.stdin.on('end',()=>queueMicrotask(()=>{
        child.stdout.write(`${JSON.stringify({ type:'thread.started',thread_id:threadId })}\n${JSON.stringify({ type:'turn.completed' })}\n`);
        child.emit('close',0);
      })); return child;
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
  assert.equal(launches,1);
});

test('a successful CLI exit/queue claim without exact completed-turn read-back remains uncertain', async t => {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-codex-test-'));
  t.after(()=>fs.rm(cwd,{ recursive:true,force:true }));
  const threadId=randomUUID(),deliveryId=randomUUID();
  await assert.rejects(runAssistantCodexPass({ threadId,deliveryId,cwd,taskContext,execution },{
    onAuthenticationConfirmed:()=>assert.fail('an uncertain result is not login recovery'),
    readExecutionAvailability:async()=>true,executable:process.execPath,environment:{},startInvocation:()=>{},readMetadata:async()=>({ threadId,cwd }),
    readDelivery:async()=>({ state:'uncertain' }),spawnProcess:()=>{
      const child=fakeChild();child.stdin.resume();child.stdin.on('end',()=>queueMicrotask(()=>{
        child.stdout.write(`${JSON.stringify({ type:'thread.started',thread_id:threadId })}\n${JSON.stringify({ type:'turn.completed' })}\n`);
        child.emit('close',0);
      }));return child;
    },
  }),/DELIVERY_UNCERTAIN/);
});

test('external task context permits bounded structural refs only, without bodies/owner assertions/argv options',()=>{
  const ref={sourceId:randomUUID(),sourceRevision:3,routeId:randomUUID(),eventOrdinal:2,provider:'telegram',accountId:randomUUID(),eventId:'message:123:4',
    eventRevision:'b'.repeat(64),conversationKey:`telegram-conversation/v1.${'a'.repeat(64)}`};
  assert.deepEqual(assistantWorkStateContext({...taskContext,sourceReferences:[ref]}).sourceReferences,[ref]);
  for(const changed of [{body:'PRIVATE'},{owner:true},{provider:'max'},{sourceId:'--config'},{accountId:'PRIVATE'},
    {sourceRevision:-1},{routeId:'PRIVATE'},{eventOrdinal:-1},{eventOrdinal:100},{eventId:'PRIVATE'},{eventRevision:'PRIVATE'},{conversationKey:'PRIVATE'}])
    assert.throws(()=>assistantWorkStateContext({...taskContext,sourceReferences:[{...ref,...changed}]}),/INVALID_INPUT/);
  for(const refs of [[],[ref,ref],Array.from({length:101},(_,index)=>({...ref,eventId:`message:123:${index+1}`}))])
    assert.throws(()=>assistantWorkStateContext({...taskContext,sourceReferences:refs}),/INVALID_INPUT/);
});
