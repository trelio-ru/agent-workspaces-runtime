import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assistantCodexExecutionArguments, assistantCodexExecutionOverrides, assistantInterruptedAcceptedWorkspace, assistantInterruptedPendingWorkspaceFinish, assistantInterruptedRetainedHandoff, assistantInterruptedNamedWorkspaceFinish, assistantAcceptedNamedArchive, assistantInterruptedWorkspaceDraft, assistantInterruptedTaskRead, assistantInterruptedTechnicalPrelude, verifyAssistantPowerShellReadExecutable, assistantReadOnlyPreparationFailure, assistantDeliveryMarker, assistantNativePrompt, assistantWorkStateContext, assistantExecutionConfiguration, readAssistantCodexExecutionAvailability,readAssistantCodexExecutionAvailabilitySet, readAssistantCodexHookReadiness, readAssistantCodexPluginReadiness, readAssistantCodexDelivery, readAssistantUnmaterializedTriage, readAssistantRejectedTriageIgnore, readAssistantCodexOwnerReply, runAssistantCodexPass as runNativePass, provisionAssistantCodexChat } from '../host-runtime/scripts/trelio-assistant-codex.mjs';
import { ASSISTANT_WORKSPACE_ACCEPTED_TOOLS, ASSISTANT_WORKSPACE_DRAFT_TOOLS,
  ASSISTANT_NAMED_ARCHIVE_RECOVERY_TOOLS } from '../host-runtime/scripts/trelio-assistant-inbox.mjs';
import { assistantInterruptedTaskCheckpoint, matchesAssistantPortableFinishTurn, assistantInterruptedLocalDraft } from '../host-runtime/scripts/trelio-assistant-codex.mjs';
import { bindAssistantTaskSkillArtifact, bindAssistantTaskSkillRead, reviewedAssistantHistoricalSkillRead } from '../host-runtime/scripts/trelio-skill-secret-setup.mjs';
import { assistantSkillGuidePage, projectAssistantSkillGuideResult } from '../host-runtime/scripts/trelio-workspace.mjs';
const runAssistantCodexPass=(input,options)=>runNativePass(input,{readWorkflow:async()=>'Synthetic admitted workflow',...options});

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
  const read=(t,options={})=>readAssistantCodexDelivery(threadId,deliveryId,{executable:process.execPath,environment:{},readinessOnly:true,...options,
    spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'?{thread:{id:threadId,cwd:process.cwd()}}:{data:[t],nextCursor:null}}))});
  assert.equal((await read(turn)).state,'completed');
  const reasoning={...turn,items:[turn.items[0],{type:'reasoning'},turn.items[1]]};
  assert.equal((await read(reasoning)).state,'uncertain');
  assert.equal((await read(reasoning,{chatKind:'source_triage'})).state,'completed');
  assert.equal((await read({...reasoning,items:[turn.items[0],{type:'mcpToolCall'},turn.items[1]]},
    {chatKind:'source_triage'})).state,'uncertain');
  for(const items of [[...turn.items,{type:'mcpToolCall'}],[turn.items[0],{type:'agentMessage',text:'other response'}],
    [{type:'userMessage',content:[{type:'text',text:prompt.trimEnd()}]},turn.items[1]],
    [{type:'userMessage',content:[{type:'text',text:prompt+'\nprivate body'}]},turn.items[1]]])
    assert.deepEqual(await read({...turn,items}),{state:'uncertain'});
});

test('unread owner recovery needs a scoped hook refusal in the full latest native turn',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const intakePass={companyId:randomUUID(),sourceId:randomUUID(),intakeId:randomUUID()};
  const root={type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(deliveryId)+'\nSYNTHETIC_OWNER'}]};
  const hook={type:'mcpToolCall',server:'trelio-assistant',tool:'get_assistant_intake_context',status:'failed',
    arguments:{intakePass},result:{structuredContent:{code:'TRELIO_RUNTIME_HOOK_REQUIRED',reason:'missing'}}};
  const read=(items,status='completed')=>readAssistantCodexDelivery(threadId,deliveryId,{
    executable:process.execPath,environment:{},unreadOwnerPreflight:intakePass,
    spawnProcess:nativeRpc(request=>{
      if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd:process.cwd()}}};
      assert.equal(request.method,'thread/turns/list');
      assert.equal(request.params.itemsView,'full');assert.equal(request.params.limit,1);
      return {result:{data:[{id:turnId,status,items}],nextCursor:null}};
    }),
  });
  assert.deepEqual(await read([root,hook,{type:'agentMessage',text:'SYNTHETIC_NOTICE'}]),
    {state:'unread_owner_hook_refused',turnId});
  for(const items of [
    [root], [root,{...hook,status:'completed'}],
    [root,{...hook,result:{structuredContent:{code:'ASSISTANT_SOURCE_READ_TELEGRAM_REFERENCE_UNAVAILABLE'}}}],
    [root,{...hook,result:{structuredContent:{code:'ASSISTANT_SOURCE_DEADLINE'}}}],
    [root,{...hook,result:{structuredContent:{code:'TRELIO_RUNTIME_HOOK_REQUIRED',reason:'replayed'}}}],
    [root,{...hook,arguments:{intakePass:{...intakePass,intakeId:randomUUID()}}}],
    [root,{...hook,server:'other'}],
    [root,hook,{...hook,tool:'resolve_assistant_intake'}],
    [root,hook,{type:'commandExecution',status:'completed'}],
    [root,hook,root],
  ])assert.deepEqual(await read(items),{state:'uncertain'});
  assert.deepEqual(await read([root,hook],'interrupted'),{state:'uncertain'});
});

test('independent READY uses the exact owned-process prompt through native readback',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),cwd=await fs.realpath(process.cwd());
  let submitted=null,starts=0,turns=0;
  const spawnProcess=ownedRpc({threadId,cwd,onInput:text=>{submitted=text;},onTurn:()=>{turns++;},
    onRequest:request=>assert.notEqual(request.method,'thread/queue/add')});
  const result=await provisionAssistantCodexChat({threadId,deliveryId,cwd,execution},{
    executable:process.execPath,environment:{},spawnProcess,readinessOnly:true,
    readExecutionAvailability:async()=>true,openDesktop:()=>assert.fail('an owned executor cannot hand off its policy'),
    onThreadStarted:()=>assert.fail('an existing review must never create another thread'),startInvocation:()=>{starts++;},
  });
  assert.equal(result.state,'completed');assert.equal(result.threadId,threadId);
  assert.equal(starts,1);assert.equal(turns,1);assert.ok(submitted.endsWith('\n'));
  const receipt=await readAssistantCodexDelivery(threadId,deliveryId,{executable:process.execPath,environment:{},spawnProcess,readinessOnly:true});
  assert.equal(receipt.state,'completed');assert.equal(receipt.turnId,result.turnId);assert.equal(turns,1);
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
    openDesktop:async()=>{},spawnProcess:ownedRpc({threadId,cwd:await fs.realpath(cwd),onInput:text=>{input=text;}}),
  });
  assert.equal(result.state,'completed');assert.equal(starts,1);
  const line=input.split('\n').find(value=>value.startsWith('TRELIO_ASSISTANT_SCOPE '));
  assert.deepEqual(JSON.parse(line.slice('TRELIO_ASSISTANT_SCOPE '.length)),state);
  assert.match(input,/restricted native discussion pass/u);assert.match(input,/replyCommentId/u);
  assert.match(input,/Do not create\/read a Workspace or WORK\.md/u);
  assert.doesNotMatch(input,/Use the assistant-task-worker skill|workStatePath|Save confirmed progress/u);
  assert.doesNotMatch(input,/use_assistant_browser|Before carrying a technical blocker forward/u);
});
const nativeRpc = (handler, executionPolicy=()=>null) => (_executable, args, options) => {
  const controlled=args.includes('--disable');
  assert.deepEqual(args,controlled?assistantCodexExecutionArguments():['app-server','--listen','stdio://']); assert.equal(options.shell,false);
  assert.deepEqual(options.stdio,['pipe','pipe','ignore']);
  const child = fakeChild(); let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString(); let boundary;
    while ((boundary=input.indexOf('\n'))!==-1) {
      const request=JSON.parse(input.slice(0,boundary)); input=input.slice(boundary+1);
      if (!request.id) continue;
      queueMicrotask(() => {
        try {
          const policy=controlled&&request.method==='experimentalFeature/list'?{result:{data:['shell_tool','apps','multi_agent','code_mode_host','code_mode_only','code_mode'].map(name=>({name,enabled:false,stage:'stable'})),nextCursor:null}}
            :controlled&&request.method==='config/read'?{result:{config:{plugins:{'trelio-digital-assistant@trelio-digital-assistants':{enabled:true},'unrelated@fixture':{enabled:true}},mcp_servers:{unrelated:{command:'PRIVATE'}}}}}
            :controlled&&request.method==='mcpServerStatus/list'?{result:{data:[{name:'trelio-assistant',pluginId:'trelio-digital-assistant@trelio-digital-assistants',runtimeStatus:'connected',toolsError:null,
              tools:Object.fromEntries(['get_assistant_status','use_assistant_workspace_files','use_assistant_browser'].map(name=>[name,{name}]))}],nextCursor:null}}:null;
          const {notifications=[],...response}=request.method==='initialize'?{result:{}}
            :policy?executionPolicy(request,policy)??policy:handler(request);
          child.stdout.write(`${JSON.stringify({id:request.id,...response})}\n`);
          for(const notification of notifications)child.stdout.write(`${JSON.stringify(notification)}\n`);
        }
        catch(error){child.emit('error',error);}
      });
    }
  });
  return child;
};

// The actual owned-process methods and terminal notification shape. There is
// deliberately no queue/add or URI handoff in this fixture: either would bypass
// the execution policy and must fail rather than silently simulate success.
const ownedRpc = ({threadId,cwd=process.cwd(),onInput=()=>{},onCreate=()=>{},onTurn=()=>{},
  onRequest=()=>{},nameFailure=false,pair=execution,queued=[],terminal=true,children=[],snapshotStatuses=[],bootstrapError=null,
  status={type:'notLoaded'},canAcceptDirectInput=null,executionPolicy,resumeError,priorTurn}={}) => {
  let input='',turnId=randomUUID(),phase='read',snapshot=0;
  const rpc=nativeRpc(request=>{
    onRequest(request);
    if(request.method==='thread/name/set'){if(nameFailure)return {error:{code:-32601,message:'Synthetic unsupported name RPC'}};assert.equal(request.params.threadId,threadId);assert.ok(['Работа по задаче Trelio','Переписка с владельцем','Разбор входящих сообщений'].includes(request.params.name));return {result:{}};}
    if(request.method==='thread/start'){onCreate(request);return {result:{thread:{id:threadId}}};}
    if(request.method==='thread/resume'){
      assert.equal(request.params.threadId,threadId);assert.equal(request.params.sandbox,'read-only');
      assert.equal(request.params.config.plugins['unrelated@fixture'].enabled,false);
      assert.equal(request.params.config.mcp_servers.unrelated.enabled,false);
      if(resumeError)return {error:resumeError};
      return {result:{thread:{id:threadId}}};
    }
    if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd,model:pair.modelId,reasoningEffort:pair.effortLevel,status,canAcceptDirectInput}}};
    if(request.method==='turn/start'){
      assert.equal(request.params.model,execution.modelId);assert.equal(request.params.effort,execution.effortLevel);
      assert.equal(request.params.collaborationMode.settings.reasoning_effort,execution.effortLevel);
      input=request.params.input[0].text;turnId=randomUUID();
      phase=input.startsWith('TRELIO_ASSISTANT_DESKTOP_PREPARE ')?'bootstrap':'controlled';
      if(phase==='controlled')onTurn(request);onInput(input,phase);
      const failed=phase==='bootstrap'&&bootstrapError;
      return {result:{turn:{id:turnId}},notifications:terminal?[{method:'turn/completed',params:{threadId,
        turn:{id:turnId,status:failed?'failed':'completed',...(failed?{error:bootstrapError}:{})}}}]:[]};
    }
    if(request.method==='thread/queue/list')return {result:{data:queued,nextCursor:null}};
    assert.equal(request.method,'thread/turns/list');
    if(phase==='read'&&priorTurn)return {result:{data:Array.isArray(priorTurn)?priorTurn:[priorTurn],nextCursor:'older'}};
    const current=phase==='controlled'&&snapshotStatuses.length?snapshotStatuses[Math.min(snapshot++,snapshotStatuses.length-1)]:'completed';
    return {result:{data:terminal?[{id:turnId,status:current,items:[{type:'userMessage',content:[{type:'text',text:input}]},{type:'agentMessage',text:'READY'}]}]:[],nextCursor:null}};
  },executionPolicy);
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
    spawnProcess:ownedRpc({threadId,cwd:await fs.realpath(cwd),onCreate:()=>assert.equal(started,true),
      onRequest:request=>{if(request.method==='turn/start')assert.equal(saved,threadId);},
      onInput:text=>{input=text;}}),
  };
  const result=await provisionAssistantCodexChat({deliveryId,cwd,execution},options);
  assert.equal(confirmed,1);
  assert.equal(result.threadId,threadId);assert.match(input,/Do not use tools/u);
  assert.doesNotMatch(input,/TRELIO_ASSISTANT_SCOPE|WORK\.md/);
  assert.doesNotMatch(input,/use_assistant_browser/u,'READY stays exactly tool-free');
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
      launches++;assert.deepEqual(args,assistantCodexExecutionArguments());
      assert.equal(spawnOptions.shell,false);assert.equal(spawnOptions.cwd,expectedCwd);
      assert.equal(spawnOptions.env.SHOULD_NOT_PASS,undefined);assert.equal(spawnOptions.env.OPENAI_API_KEY,undefined);
      assert.equal(spawnOptions.env.ComSpec,process.platform==='win32'?String.raw`C:\Windows\System32\cmd.exe`:undefined);
      assert.equal(spawnOptions.env.PATHEXT,process.platform==='win32'?'.COM;.EXE;.BAT;.CMD':undefined);
      return ownedRpc({threadId,cwd:expectedCwd,onInput:text=>{input=text;}})(_executable,args,spawnOptions);
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
  assert.match(input,/Apply the complete assistant-task-worker skill and work-state reference supplied in this turn's developer instructions/);
  assert.match(input,/Before carrying a technical blocker forward/);
  assert.match(input,/current relevant read-only tool/);
  assert.match(input,/Unknown external mutations remain read-back-only/);
  assert.doesNotMatch(input,/Use the assistant-task-worker skill and its work-state reference/);
  assert.match(input,/unchanged blocker.*noChange.*without a new Run\/worklog/);
  assert.match(input,/only the exact recovery references needed for safe continuation/);
  assert.match(input,/use_assistant_browser/u);
  for(const invariant of ['follow a matching published skill through its declared assistant commands','already authorized action',
    'independent persisted owner decision','Read back an uncertain result before further input',
    'Do not use ordinary Chrome','Verify the actual site outcome','closes idle windows after ten minutes'])assert.ok(input.includes(invariant));
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
    spawnProcess:ownedRpc({threadId,terminal:false,onTurn:()=>{queues++;},children}),
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

test('an exact committed task receipt settles interrupted native history without a completion marker',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID(),markerId=randomUUID();
  const taskPass={companyId:randomUUID(),taskId:randomUUID(),passId:randomUUID()};
  const expected={
    assistantId:randomUUID(),deviceId:randomUUID(),companyId:taskPass.companyId,taskId:taskPass.taskId,
    threadId,deliveryId,bindingId:randomUUID(),bindingRevision:5};
  const marker={type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(markerId)+'\nScheduled input'}]};
  const effect={type:'mcpToolCall',server:'trelio-assistant',tool:'continue_assistant_workspace_action',status:'completed'};
  const receiptId=randomUUID();
  const done={type:'mcpToolCall',server:'trelio-assistant',tool:'complete_assistant_pass',status:'completed',
    arguments:{taskPass},result:{structuredContent:{schemaVersion:1,state:'confirmed',receiptId,...expected}}};
  const original={id:turnId,status:'interrupted',items:[marker,effect,done,{type:'agentMessage',text:'Final prose interrupted'}]};
  const read=async(change=()=>{},threadStatus='notLoaded',selection={turnId,taskPass,expected})=>{
    const turn=structuredClone(original);change(turn);
    return readAssistantCodexDelivery(threadId,markerId,{executable:process.execPath,environment:{},
      committedTaskOutcome:selection,spawnProcess:nativeRpc(request=>{
        if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd:process.cwd(),status:{type:threadStatus}}}};
        assert.equal(request.method,'thread/turns/list');
        assert.deepEqual(request.params,{threadId,limit:1,sortDirection:'desc',itemsView:'full'});
        return {result:{data:[turn],nextCursor:'older'}};
      })});
  };
  assert.deepEqual(await read(),{state:'committed_task_outcome',turnId,receiptId,receipt:`codex:${threadId}:${turnId}`});
  const reject=async(...args)=>assert.deepEqual(await read(...args),{state:'uncertain'});
  await reject(()=>{},'active');
  await reject(()=>{},'notLoaded',{turnId,taskPass,expected:{threadId:randomUUID()}});
  await reject(turn=>{turn.id=randomUUID();});
  await reject(turn=>{turn.items[0].content[0].text=assistantDeliveryMarker(deliveryId)+'\nWrong invocation';});
  await reject(turn=>{turn.items[1].status='inProgress';});
  await reject(turn=>{turn.items[2].arguments.taskPass.passId=randomUUID();});
  await reject(turn=>{delete turn.items[2].result.structuredContent.receiptId;});
  await reject(turn=>{turn.items[2].result.structuredContent.bindingRevision++;});
  await reject(turn=>{turn.items[2].status='failed';});
  await reject(turn=>{turn.items.push(effect);});
});

const draftHistory=()=>{
  const terminalMarkerId=randomUUID(),terminalTurnId=randomUUID(),workspaceDraft={workspaceId:randomUUID(),runId:randomUUID()};
  const taskPass={companyId:taskContext.companyId,taskId:taskContext.taskId,passId:randomUUID()};
  const call=(tool,args,result,status='completed')=>({type:'mcpToolCall',server:'trelio-assistant',tool,status,
    arguments:{...args,taskPass},result:{structuredContent:result}});
  const text='Synthetic verified draft';
  const turn={id:terminalTurnId,status:'interrupted',items:[
    {type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(terminalMarkerId)+'\nExisting request'}]},
    call('prepare_assistant_workspace_run',{...workspaceDraft,clientRequestId:randomUUID()},
      {prepared:true,workspace:{id:workspaceDraft.workspaceId,scopeType:'task',companyId:taskPass.companyId,taskId:taskPass.taskId},
        run:{id:workspaceDraft.runId}}),
    call('continue_assistant_workspace_action',{operation:'open',parameters:workspaceDraft},{operation:'open',
      authorityReads:['agent-instructions.md','user-profile.md'].map(path=>({tool:'use_assistant_workspace_files',
        arguments:{runIdentity:workspaceDraft,command:{action:'read',source:'authority',path}}}))}),
    call('use_assistant_workspace_files',{runIdentity:workspaceDraft,command:{action:'write'}},
      {code:'ASSISTANT_WORKSPACE_FILE_INPUT_INVALID'},'failed'),
    call('use_assistant_workspace_files',{runIdentity:workspaceDraft,command:{action:'replace',path:'WORKSPACE_CONTEXT.md',
      expectedSha256:null,text}},{state:'draft_updated',sha256:createHash('sha256').update(text).digest('hex')}),
  ]};
  return {turn,terminalMarkerId,terminalTurnId,taskPass,workspaceDraft};
};

test('the entire interrupted history must confirm an exact own draft and exclude unknown effects',()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=draftHistory();
  assert.deepEqual(assistantInterruptedWorkspaceDraft(turn,terminalMarkerId,taskPass),workspaceDraft);
  for(const mutate of [
    value=>{value.status='inProgress';},value=>{value.items[0].content[0].text='Only a quotation';},
    value=>{delete value.items[1].arguments.runId;},
    value=>{value.items[2].arguments.operation='finish';},
    value=>{value.items.at(-1).arguments.runIdentity={...workspaceDraft,runId:randomUUID()};},
    value=>{value.items.at(-1).result.structuredContent.sha256='0'.repeat(64);},
    value=>{value.items.at(-1).status='inProgress';},
    value=>{value.items.push({type:'mcpToolCall',tool:'use_assistant_browser',status:'failed'});},
  ]){
    const changed=structuredClone(turn);mutate(changed);
    assert.equal(assistantInterruptedWorkspaceDraft(changed,terminalMarkerId,taskPass),null);
  }
});

const acceptedHistory=()=>{
  const {turn,terminalMarkerId,terminalTurnId,taskPass,workspaceDraft}=draftHistory();
  const operationId=randomUUID(),acceptedHead='a'.repeat(40);
  const [prepare,open]=turn.items.slice(1);
  delete prepare.arguments.runId; // The normal prepare call selected the Run.
  open.arguments.schemaVersion=open.result.structuredContent.schemaVersion=1;
  const call=(operation,parameters,result)=>({type:'mcpToolCall',server:'trelio-assistant',
    tool:'continue_assistant_workspace_action',status:'completed',
    arguments:{schemaVersion:1,operation,parameters,runIdentity:workspaceDraft,taskPass},
    result:{structuredContent:{schemaVersion:1,...result}}});
  turn.items.push(
    call('checkpoint',{type:'draft'},{operation:'checkpoint'}),
    call('finish',{taskOutcome:'no_status_change'},{operation:'finish',operationId,state:'running'}),
    call('status',{finishOperationId:operationId},{operation:'finish',operationId,state:'completed'}),
    call('status',{},{operation:'status',nativeRunStatus:{status:'accepted',candidateHead:acceptedHead,baseHead:'b'.repeat(40)},stdout:JSON.stringify({...workspaceDraft,terminalStatus:'accepted',
      candidateHead:acceptedHead,baseHead:'b'.repeat(40),dirty:false})}),
  );
  return {turn,terminalMarkerId,terminalTurnId,taskPass,workspaceDraft:{...workspaceDraft,acceptedHead}};
};

test('interruption after exact finish and accepted readback offers only outcome settlement',()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=acceptedHistory();
  const {acceptedHead,...runIdentity}=workspaceDraft;
  assert.deepEqual(assistantInterruptedAcceptedWorkspace(turn,terminalMarkerId,taskPass),{...workspaceDraft,acceptedHead});
  for(const change of [
    value=>{value.items.at(-2).result.structuredContent.operationId=randomUUID();},
    value=>{value.items.at(-2).result.structuredContent.state='running';},
    value=>{value.items.at(-3).arguments.parameters.taskOutcome='work_completed';},
    value=>{value.items.at(-1).arguments.runIdentity={...runIdentity,runId:randomUUID()};},
    value=>{const result=value.items.at(-1).result.structuredContent;
      result.stdout=JSON.stringify({...JSON.parse(result.stdout),terminalStatus:'submitted'});},
    value=>{value.items.push({type:'mcpToolCall',server:'trelio-assistant',tool:'use_assistant_browser',status:'completed'});},
  ]){
    const edited=structuredClone(turn);change(edited);
    assert.equal(assistantInterruptedAcceptedWorkspace(edited,terminalMarkerId,taskPass),null);
  }
  const pluginId='trelio-digital-assistant@trelio-digital-assistants';
  const config=assistantCodexExecutionOverrides({plugins:{[pluginId]:{enabled:true}}},'accepted');
  const tools=config.plugins[pluginId].mcp_servers['trelio-assistant'].enabled_tools;
  assert.ok(tools.includes('complete_assistant_pass'));
  for(const tool of ['prepare_assistant_workspace_run','continue_assistant_workspace_action','use_assistant_workspace_files','use_assistant_browser'])
    assert.ok(!tools.includes(tool),tool);
});

// Compose the real native history shapes, including JSON-text-only reads,
// asynchronous open, a pre-dispatch refusal and a closed read-only browser
// visit. No private account, page or original task data enters this fixture.
const acceptedObservationHistory=()=>{
  const fixture=acceptedHistory(),{turn,taskPass,workspaceDraft}=fixture;
  const {acceptedHead,...run}=workspaceDraft,handle=randomUUID();
  const related=randomUUID(),prepare=turn.items[1];
  prepare.arguments.relatedWorkspaceIds=[related];
  prepare.result.structuredContent.contextHeads={related:[{workspaceId:related,head:'c'.repeat(40),scopeType:'project'}]};
  const call=(tool,args,value,status='completed')=>({type:'mcpToolCall',server:'trelio-assistant',tool,status,
    arguments:{taskPass,...args},result:{structuredContent:value}});
  const action=(operation,parameters,value,status='completed')=>call('continue_assistant_workspace_action',
    {schemaVersion:1,operation,parameters,runIdentity:run},value,status);
  const poll={schemaVersion:1,operation:'open',operationId:handle,state:'running',nextCall:{tool:'continue_assistant_workspace_action',
    arguments:{schemaVersion:1,operation:'status',parameters:{finishOperationId:handle},runIdentity:run}}};
  const open=turn.items[2];open.result.structuredContent=poll;
  turn.items.splice(3,0,action('status',{finishOperationId:handle},poll),
    action('status',{finishOperationId:handle},{code:'TRELIO_RUNTIME_HOOK_FAILED'},'failed'),
    action('status',{}, {schemaVersion:1,operation:'status',nativeRunStatus:{status:'running'},stdout:JSON.stringify({...run,baseHead:'b'.repeat(40),dirty:false})}));
  const read=call('get_task',{},null);read.result={structuredContent:null,content:[{type:'text',text:JSON.stringify({tasks:[{id:taskPass.taskId}]})}]};
  turn.items.splice(1,0,read,action('status',{}, {schemaVersion:1,operation:'status',localWorkspaceState:'unverified',stdout:'{}'}));
  const browser=(operation,args,state,image=false)=>{
    const item=call('use_assistant_browser',{siteOrigin:'https://example.test',command:{operation,args}},null);
    item.result={structuredContent:null,content:[{type:'text',text:JSON.stringify({state,reason:'none'})},
      ...(image?[{type:'image',mimeType:'image/png',data:'synthetic'}]:[])]};return item;
  };
  const secretArgs={holder:'company',sourceTaskId:randomUUID()};
  const secret=action('secret_list',secretArgs,{secrets:[]});delete secret.arguments.runIdentity;
  turn.items.splice(-4,0,{type:'sleep'},
    action('secret_list',secretArgs,{code:'ASSISTANT_MCP_INPUT_INVALID'},'failed'),secret,
    browser('status',{},'saved_unverified'),browser('navigate',{url:'https://example.test/login'},'preparing'),
    browser('status',{},'ready'),browser('screenshot',{},'ready',true),
    action('secret_browser_prepare',{holder:'company',secretId:randomUUID(),siteOrigin:'https://example.test'},
      {code:'ASSISTANT_ENCRYPTED_CONTENT_REQUIRED'},'failed'),browser('close',{},'closed'));
  return fixture;
};

test('accepted canonical material after a closed observation permits outcome-only settlement, never replay',()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=acceptedObservationHistory();
  assert.deepEqual(assistantInterruptedAcceptedWorkspace(turn,terminalMarkerId,taskPass),workspaceDraft);
  assert.equal(assistantInterruptedPendingWorkspaceFinish(turn,terminalMarkerId,taskPass),null);
  assert.equal(assistantInterruptedWorkspaceDraft(turn,terminalMarkerId,taskPass),null);
  const browser=(t,op)=>t.items.find(i=>i.tool==='use_assistant_browser'&&i.arguments.command.operation===op);
  const action=(t,op)=>t.items.find(i=>i.arguments?.operation===op);
  const reasons=[
    t=>{t.status='inProgress';},t=>{t.error={code:'unknown'};},
    t=>{delete t.items.at(-1).result.structuredContent.nativeRunStatus;},
    t=>{t.items.at(-1).result.structuredContent.nativeRunStatus.status='running';},
    t=>{t.items.at(-1).result.structuredContent.nativeRunStatus.candidateHead='c'.repeat(40);},
    t=>{t.items.at(-1).result.structuredContent.nativeRunStatus.baseHead='c'.repeat(40);},
    t=>{const i=t.items.at(-1);i.result={content:[{type:'text',text:JSON.stringify(i.result.structuredContent)}]};},
    t=>{t.items[1].result.content[0].text='{"code":"UNKNOWN"}';},
    t=>{t.items[2].arguments.runIdentity.runId=randomUUID();},
    t=>{t.items.find(i=>i.tool==='prepare_assistant_workspace_run').result.structuredContent.contextHeads.related=[];},
    t=>{t.items.find(i=>i.tool==='prepare_assistant_workspace_run').result.structuredContent.contextHeads.related[0].head='unknown';},
    t=>{const ids=t.items.find(i=>i.tool==='prepare_assistant_workspace_run').arguments.relatedWorkspaceIds;ids.push(ids[0]);},
    t=>{action(t,'open').result.structuredContent.nextCall.arguments.parameters.finishOperationId=randomUUID();},
    t=>{t.items.find(i=>i.result?.structuredContent?.code==='TRELIO_RUNTIME_HOOK_FAILED').arguments.parameters.finishOperationId=randomUUID();},
    t=>{t.items.find(i=>i.result?.structuredContent?.code==='TRELIO_RUNTIME_HOOK_FAILED').result.structuredContent.code='TRELIO_WORKSPACE_ACTION_FAILED';},
    t=>{browser(t,'navigate').status='inProgress';},
    t=>{browser(t,'navigate').arguments.command.operation='click';},
    t=>{browser(t,'navigate').arguments.command.args.url='http://example.test';},
    t=>{browser(t,'navigate').arguments.taskPass.passId=randomUUID();},
    t=>{browser(t,'screenshot').arguments.siteOrigin='https://other.test';},
    t=>{browser(t,'screenshot').arguments.command.args.text='not an observation';},
    t=>{browser(t,'screenshot').result.isError=true;},
    t=>{browser(t,'screenshot').result.content[0].text='{"state":"ready","reason":"operation_failed"}';},
    t=>{browser(t,'screenshot').result.content.push({type:'text',text:'unknown'});},
    t=>{t.items.splice(t.items.indexOf(browser(t,'close')),1);},
    t=>{browser(t,'close').result.content[0].text='{"state":"preparing","reason":"none"}';},
    t=>{const i=t.items.filter(i=>i.tool==='use_assistant_browser'&&i.arguments.command.operation==='status').at(-1);i.result.content[0].text='{"state":"preparing","reason":"none"}';},
    t=>{action(t,'secret_browser_prepare').arguments.operation='secret_browser_fill';},
    t=>{action(t,'secret_browser_prepare').arguments.parameters.steps=[];},
    t=>{delete action(t,'secret_browser_prepare').arguments.runIdentity;},
    t=>{action(t,'secret_browser_prepare').result.structuredContent.code='AGENT_SECRET_ACCESS_DENIED';},
    t=>{action(t,'secret_browser_prepare').status='completed';},
    t=>{action(t,'secret_list').result.structuredContent.code='UNKNOWN';},
    t=>{t.items.push(structuredClone(browser(t,'status')));},
  ];
  for(const [index,mutate] of reasons.entries()){
    const changed=structuredClone(turn);mutate(changed);
    assert.equal(assistantInterruptedAcceptedWorkspace(changed,terminalMarkerId,taskPass),null,`refusal ${index}`);
  }
});

// One ordinary continuation can inspect the previous accepted Run, reconcile
// an absent operation, update a control and then save a NEW accepted Run. The
// composition matters: each action used to pass its own isolated test while
// the complete native history was rejected and held every later task hostage.
const acceptedControlHistory=()=>{
  const f=acceptedObservationHistory(),{turn,taskPass,workspaceDraft}=f;
  const prior=turn.items[2],oldRun={workspaceId:workspaceDraft.workspaceId,runId:randomUUID()};
  prior.arguments.runIdentity=oldRun;
  prior.result.structuredContent={schemaVersion:1,operation:'status',
    nativeRunStatus:{status:'accepted',candidateHead:'b'.repeat(40),baseHead:'d'.repeat(40)},
    stdout:JSON.stringify({...oldRun,terminalStatus:'accepted',dirty:false,candidateHead:'b'.repeat(40),baseHead:'d'.repeat(40)})};
  const request=randomUUID(),controlId=randomUUID();
  turn.items.splice(1,0,{type:'mcpToolCall',server:'trelio-assistant',tool:'get_assistant_status',status:'completed',
    arguments:{operationReceipt:request,view:'task'},result:{structuredContent:null,
      content:[{type:'text',text:JSON.stringify({state:'not_recorded',clientRequestId:request,companies:[]})}]}});
  turn.items.splice(-4,0,{type:'mcpToolCall',server:'trelio-assistant',tool:'update_task_control',status:'completed',
    arguments:{taskPass,clientRequestId:randomUUID(),controlId,visibility:'shared'},
    result:{structuredContent:{schemaVersion:1,operation:'update_task_control',taskId:taskPass.taskId,resultId:controlId,receiptId:randomUUID()}}});
  return f;
};

test('accepted save with prior accepted read, absent operation and settled control only permits confirmation',()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=acceptedControlHistory();
  assert.deepEqual(assistantInterruptedAcceptedWorkspace(turn,terminalMarkerId,taskPass),workspaceDraft);
  assert.equal(assistantInterruptedPendingWorkspaceFinish(turn,terminalMarkerId,taskPass),null);
  const receipt=t=>t.items.find(i=>i.tool==='get_assistant_status');
  const control=t=>t.items.find(i=>i.tool==='update_task_control');
  const prior=t=>t.items.find(i=>i.arguments?.operation==='status'&&i.result?.structuredContent?.nativeRunStatus?.candidateHead==='b'.repeat(40));
  for(const [index,mutate] of [
    t=>{receipt(t).arguments.operationReceipt=randomUUID();},
    t=>{receipt(t).arguments.view='unknown';},
    t=>{receipt(t).result.content[0].text='{}';},
    t=>{const i=receipt(t),v=JSON.parse(i.result.content[0].text);v.state='committed';i.result.content[0].text=JSON.stringify(v);},
    t=>{receipt(t).result.isError=true;},
    t=>{const i=prior(t),v=JSON.parse(i.result.structuredContent.stdout);v.dirty=true;i.result.structuredContent.stdout=JSON.stringify(v);},
    t=>{prior(t).result.structuredContent.nativeRunStatus.candidateHead='c'.repeat(40);},
    t=>{const i=prior(t);i.arguments.runIdentity.workspaceId=randomUUID();},
    t=>{control(t).result.structuredContent.taskId=randomUUID();},
    t=>{control(t).result.structuredContent.receiptId=null;},
    t=>{control(t).arguments.ownerDecisionId=randomUUID();},
    t=>{control(t).arguments.taskPass.passId=randomUUID();},
    t=>{const i=control(t);i.result={content:[{type:'text',text:JSON.stringify(i.result.structuredContent)}]};},
    t=>{t.items.splice(-4,0,structuredClone(control(t)));},
    t=>{const i=control(t);t.items.splice(t.items.indexOf(i),1);t.items.push(i);},
    t=>{t.items.splice(-3);}, // A prior accepted Run never substitutes for this save.
  ].entries()){
    const changed=structuredClone(turn);mutate(changed);
    assert.equal(assistantInterruptedAcceptedWorkspace(changed,terminalMarkerId,taskPass),null,`refusal ${index}`);
  }
});

const pendingFinishHistory=()=>{
  const {turn,workspaceDraft,...locators}=acceptedHistory();
  const {acceptedHead,...identity}=workspaceDraft;
  const finish=turn.items.at(-3),result=finish.result.structuredContent;
  result.nextCall={tool:finish.tool,arguments:{schemaVersion:1,operation:'status',runIdentity:identity,
    parameters:{finishOperationId:result.operationId}}};
  const effect=(tool,args,value)=>({type:'mcpToolCall',server:'trelio-assistant',tool,status:'completed',
    arguments:{taskPass:locators.taskPass,...args},result:{structuredContent:value}});
  const questionId=randomUUID(),controlId=randomUUID(),receiptId=randomUUID();
  // Real Codex persists an encrypted exact task read with structuredContent
  // null and one JSON text block. Mutation and finish receipts remain typed.
  turn.items.splice(1,0,{...effect('get_task',{},null),result:{structuredContent:null,
    content:[{type:'text',text:JSON.stringify({effectiveInstructions:{status:'complete'},tasks:[{id:locators.taskPass.taskId}]})}]}});
  turn.items.splice(-4,4,
    effect('ask_assistant_owner',{clientRequestId:randomUUID()},
      {id:questionId,path:'/profile/',state:'pending',replayed:false}),
    effect('update_task_control',{clientRequestId:randomUUID(),controlId,visibility:'shared'},
      {schemaVersion:1,operation:'update_task_control',taskId:locators.taskPass.taskId,resultId:controlId,receiptId}),
    finish,
  );
  return {turn,...locators,workspaceDraft:{...identity,finishPending:true}};
};

test('a started finish is recoverable without treating its pending handle or earlier effects as completion',()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=pendingFinishHistory();
  assert.equal(assistantInterruptedAcceptedWorkspace(turn,terminalMarkerId,taskPass),null);
  assert.deepEqual(assistantInterruptedPendingWorkspaceFinish(turn,terminalMarkerId,taskPass),workspaceDraft);
  for(const change of [
    value=>{value.items[1].result.content[0].text='Read done';},
    value=>{value.items[1].result.content[0].text='{"code":"UNAVAILABLE"}';},
    value=>{value.items[1].result.isError=true;},
    value=>{value.items.at(-3).result.structuredContent.replayed=true;},
    value=>{value.items.at(-2).result.structuredContent.receiptId=null;},
    value=>{const item=value.items.at(-2);item.result={content:[{type:'text',
      text:JSON.stringify(item.result.structuredContent)}],structuredContent:null};},
    value=>{value.items.at(-2).arguments.visibility='other';},
    value=>{value.items.at(-2).result.structuredContent.taskId=randomUUID();},
    value=>{value.items.at(-2).arguments.taskPass={...taskPass,passId:randomUUID()};},
    value=>{value.items.at(-1).result.structuredContent.nextCall.arguments.runIdentity={...workspaceDraft,runId:randomUUID()};},
    value=>{value.items.at(-1).result.structuredContent.nextCall.arguments.parameters.finishOperationId=randomUUID();},
    value=>{value.items.at(-1).result.structuredContent.state='completed';},
    value=>{value.items.splice(-1,0,{...value.items.at(-2),tool:'use_assistant_skill'});},
    value=>{value.items.push(structuredClone(value.items.at(-2)));},
  ]){
    const edited=structuredClone(turn);change(edited);
    assert.equal(assistantInterruptedPendingWorkspaceFinish(edited,terminalMarkerId,taskPass),null);
  }
});

test('retained handoff projects exact native history without exporting text, paths or browser parameters',()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=pendingFinishHistory();
  const {workspaceId,runId}=workspaceDraft, runIdentity={workspaceId,runId};
  const prepare=turn.items.find(item=>item.tool==='prepare_assistant_workspace_run').arguments;
  delete prepare.workspaceId;
  prepare.runId=runId;
  const releaseId=randomUUID(), grantId=randomUUID(), accountId=randomUUID();
  const action=(operation,parameters,result,failed=false)=>({
    type:'mcpToolCall',server:'trelio-assistant',tool:'continue_assistant_workspace_action',
    status:failed?'failed':'completed',arguments:{schemaVersion:1,operation,parameters,runIdentity,taskPass},
    result:{structuredContent:result,...(failed?{isError:true}:{})},
  });
  const browser=(operation,args,state)=>({
    type:'mcpToolCall',server:'trelio-assistant',tool:'use_assistant_browser',status:'completed',
    arguments:{taskPass,siteOrigin:'https://portal.example.test',command:{operation,args}},
    result:{structuredContent:{state,reason:'none'}},
  });
  const finish=turn.items.at(-1);
  finish.arguments.parameters={taskOutcome:'no_status_change',summary:'Synthetic exact preserved handoff',
    evidence:['Private evidence canary'],filePaths:['WORK.md'],nextAction:'Continue the original task'};
  delete finish.result.structuredContent.operationId;
  turn.items.splice(-1,0,
    action('skill_run',{skillId:'telegram-mtproto',releaseId,arguments:['account','list']},
      {operation:'skill_run',stdout:JSON.stringify({ok:true,accounts:[],revision:1})}),
    action('skill_run',{skillId:'telegram-mtproto',releaseId,arguments:['chat-info','--chat','PRIVATE_PEER','--local-account',accountId]},
      {code:'TRELIO_WORKSPACE_ACTION_FAILED'},true),
    browser('navigate',{url:'https://portal.example.test/inbox'},'preparing'),
    browser('status',{},'ready'),
    action('secret_browser_prepare',{runId}, {prepared:true,grant:{id:grantId,workspaceId,runId},bridge:{action:{arguments:{
      operation:'secret_browser_fill',runIdentity,parameters:{grantId},
    }}}}),
    action('secret_browser_fill',{grantId,targetUrl:'https://login.example.test/?private=CANARY'},
      {code:'TRELIO_WORKSPACE_ACTION_FAILED'},true),
    browser('close',{},'closed'),
  );
  const classify=value=>assistantInterruptedRetainedHandoff(value,terminalMarkerId,taskPass);
  const witness=classify(turn);
  assert.equal(witness?.locators.runId,runId);
  assert.equal(witness?.locators.browserGrantId,grantId);
  assert.equal(witness?.locators.releaseId,releaseId);
  assert.equal(witness?.automaticFiles,false);
  assert.ok(witness?.replacements.length>0);
  assert.doesNotMatch(JSON.stringify(witness),/CANARY|PRIVATE_PEER|WORK\.md|Synthetic/u);
  assert.equal(assistantInterruptedPendingWorkspaceFinish(turn,terminalMarkerId,taskPass),null);

  for(const origin of ['https://mail.google.com','https://calendar.example.test']){
    const edited=structuredClone(turn);
    for(const item of edited.items.filter(item=>item.tool==='use_assistant_browser')){
      item.arguments.siteOrigin=origin;
      if(item.arguments.command.operation==='navigate')item.arguments.command.args.url=origin+'/entry';
    }
    assert.deepEqual(classify(edited),witness);
  }
  for(const change of [
    value=>{value.items.at(-7).arguments.parameters.arguments[0]='send';},
    value=>{value.items.at(-3).arguments.parameters.grantId=randomUUID();},
    value=>{value.items.at(-2).arguments.command.operation='type-text';},
    value=>{value.items.at(-2).arguments.siteOrigin='https://different-origin.example.test';},
    value=>{value.items.at(-2).arguments.siteOrigin='http://portal.example.test';},
    value=>{value.items.at(-1).arguments.parameters.summary='';},
    value=>{value.items.push(structuredClone(value.items.at(-3)));},
  ]){
    const edited=structuredClone(turn);change(edited);
    assert.equal(classify(edited),null);
  }
});

test('local draft witness extracts only the exact native replacement bytes across provider histories',()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=pendingFinishHistory();
  const {workspaceId,runId}=workspaceDraft;
  const basis={workspaceId,runId,baseHead:'d'.repeat(40),anchorHead:'d'.repeat(40),checkpointId:null};
  turn.items[0].content[0].text=assistantDeliveryMarker(terminalMarkerId)+'\nTRELIO_ASSISTANT_SCOPE '+JSON.stringify({
    companyId:taskPass.companyId,taskId:taskPass.taskId,scheduled:true,
  });
  const finish=turn.items.pop();
  const findReplacement=value=>value.items.find(item=>item.arguments?.command?.action==='replace');
  const replace=findReplacement(turn);
  const digest=value=>createHash('sha256').update(value).digest('hex');
  replace.arguments.command.path='work/verified-result.md';
  const later=structuredClone(replace);
  later.arguments.command.text='The latest exact bytes';
  later.result.structuredContent.sha256=digest(later.arguments.command.text);
  turn.items.push({type:'mcpToolCall',server:'trelio-assistant',tool:'continue_assistant_workspace_action',
    status:'failed',arguments:{schemaVersion:1,operation:'skill_run',parameters:{skillId:'different-provider'}},
    result:{isError:true,structuredContent:{code:'SYNTHETIC_UNRESOLVED_EXTERNAL_EFFECT'}}},later);
  const read=(history=turn)=>assistantInterruptedLocalDraft(history,terminalMarkerId,taskPass,basis);
  assert.deepEqual(read(),[{pathSha256:digest(later.arguments.command.path),contentSha256:digest(later.arguments.command.text)}]);
  for(const mutate of [
    value=>{value.items.at(-1).result.structuredContent.sha256='f'.repeat(64);},
    value=>{value.items.at(-1).arguments.runIdentity.runId=randomUUID();},
    value=>{value.items.at(-1).arguments.taskPass.passId=randomUUID();},
    value=>{value.items.at(-2).status='inProgress';},
    value=>{value.items.push(finish);},
    value=>{value.items.push(structuredClone(value.items[0]));},
  ]){
    const changed=structuredClone(turn);mutate(changed);
    assert.equal(read(changed),null);
  }
});

test('native local-draft read projects signed or audited file exports without settling any provider action',async()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=pendingFinishHistory();
  const basis={workspaceId:workspaceDraft.workspaceId,runId:workspaceDraft.runId,baseHead:'d'.repeat(40),anchorHead:'d'.repeat(40),checkpointId:null};
  turn.items[0].content[0].text=assistantDeliveryMarker(terminalMarkerId)+'\nTRELIO_ASSISTANT_SCOPE '+JSON.stringify({
    companyId:taskPass.companyId,taskId:taskPass.taskId,scheduled:true,
  });
  turn.items.pop();
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const {assistantArtifactPathDigest}=await import('../host-runtime/scripts/trelio-local-path.mjs');
  const destination=path.resolve('synthetic-export-directory'),saved=path.join(destination,'message-3.eml');
  const artifact={pathSha256:assistantArtifactPathDigest(saved),contentSha256:digest('sample'),sizeBytes:6};
  const stdout=JSON.stringify({saved,uid:'3',format:'message/rfc822',size:6,sha256:artifact.contentSha256});
  const parameters={companyId:taskPass.companyId,skillId:'generic-artifact-skill',releaseId:randomUUID(),runtimeSessionId:randomUUID(),
    arguments:['save-message','--folder','archive','--uid','3','--output',destination,'--local-account',randomUUID()]};
  const taskSkillArtifact=bindAssistantTaskSkillArtifact({schemaVersion:1,releaseId:parameters.releaseId,
    packageSha256:'a'.repeat(64),outputSha256:digest(stdout),artifact},{scope:taskPass,parameters,stdout});
  assert.ok(taskSkillArtifact);
  turn.items.push({type:'mcpToolCall',server:'trelio-assistant',tool:'continue_assistant_workspace_action',status:'completed',
    arguments:{schemaVersion:1,operation:'skill_run',parameters,taskPass},
    result:{structuredContent:{schemaVersion:1,operation:'skill_run',stdout,taskSkillArtifact}}});
  const threadId=randomUUID();
  const read=history=>readAssistantCodexDelivery(threadId,terminalMarkerId,{executable:process.execPath,environment:{},
    interruptedWorkspaceDraft:{...taskPass,localDraftBasis:basis},spawnProcess:nativeRpc(request=>({
      result:request.method==='thread/read'?{thread:{id:threadId,cwd:process.cwd()}}:{data:[history],nextCursor:null},
    }))});
  assert.deepEqual((await read(turn)).retainedArtifacts,[artifact]);
  const foreign=structuredClone(turn);
  foreign.items.at(-1).result.structuredContent.stdout+='changed bytes';
  assert.equal((await read(foreign)).state,'uncertain');
  const legacy=structuredClone(turn),call=legacy.items.at(-1);
  const release={skillId:'email-imap-smtp',releaseId:'353b28f3-8c94-4d69-a287-5f66ae953484',
    packageSha256:'ef3374b49e7e5cc09330515fac6d97ec8579d64591da09726d89ad9610f238cb'};
  Object.assign(call.arguments.parameters,{skillId:release.skillId,releaseId:release.releaseId});
  delete call.result.structuredContent.taskSkillArtifact;
  const recovered=await read(legacy);
  assert.deepEqual(recovered.retainedArtifacts,[artifact]);
  assert.deepEqual(recovered.historicalSkillReleases,[release]);
  assert.doesNotMatch(JSON.stringify(recovered),/synthetic-export-directory|message-3\.eml/u);
  call.arguments.parameters.releaseId=randomUUID();
  assert.equal((await read(legacy)).retainedArtifacts,undefined);
});

test('portable finish identifies the exact save independently of earlier providers',()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=pendingFinishHistory();
  const receipt={workspaceId:workspaceDraft.workspaceId,runId:workspaceDraft.runId,
    checkpointId:randomUUID(),draftHead:'a'.repeat(40)};
  const scope={companyId:taskPass.companyId,taskId:taskPass.taskId,scheduled:true};
  turn.items[0].content[0].text=`${assistantDeliveryMarker(terminalMarkerId)}\nTRELIO_ASSISTANT_SCOPE ${JSON.stringify(scope)}\n`;
  for(const siteOrigin of ['https://mail.google.com','https://portal.example.test','https://another.example.test:8443']){
    const original=structuredClone(turn);
    // The earlier operation has an unknown result. It conveys no evidence
    // about the committed save, even when the provider has never been seen.
    original.items.splice(-1,0,{type:'mcpToolCall',server:'trelio-assistant',tool:'use_assistant_browser',
      status:'inProgress',arguments:{siteOrigin,taskPass}});
    assert.equal(matchesAssistantPortableFinishTurn(original,terminalMarkerId,taskPass,receipt),true);
    assert.equal(assistantInterruptedPendingWorkspaceFinish(original,terminalMarkerId,taskPass),null);
    original.items.at(-1).arguments.runIdentity.runId=randomUUID();
    assert.equal(matchesAssistantPortableFinishTurn(original,terminalMarkerId,taskPass,receipt),false);
  }
  assert.equal(matchesAssistantPortableFinishTurn(turn,randomUUID(),taskPass,receipt),false);
  assert.equal(matchesAssistantPortableFinishTurn(turn,terminalMarkerId,{...taskPass,passId:randomUUID()},receipt),false);
  assert.equal(matchesAssistantPortableFinishTurn({...turn,status:'inProgress'},terminalMarkerId,taskPass,receipt),false);
  turn.items[0].content[0].text=`${assistantDeliveryMarker(terminalMarkerId)}\nTRELIO_ASSISTANT_SCOPE ${JSON.stringify({...scope,scheduled:false})}\n`;
  assert.equal(matchesAssistantPortableFinishTurn(turn,terminalMarkerId,taskPass,receipt),false);
});

test('intermediate restart requires an exact durable checkpoint and signed read effects across the whole turn',async()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=draftHistory();
  const threadId=randomUUID();
  turn.items.splice(3,1); // This case has no unclassified local refusal.
  const [original,,open,replace]=turn.items;
  open.arguments.schemaVersion=1;
  const checkpoint={...workspaceDraft,checkpointId:randomUUID(),draftHead:'b'.repeat(40)};
  const add=(tool,args,result)=>({type:'mcpToolCall',server:'trelio-assistant',tool,status:'completed',
    arguments:{...args,taskPass},result:{structuredContent:result}});
  const continuation=(operation,parameters,value,identity={})=>add('continue_assistant_workspace_action',
    {schemaVersion:1,operation,parameters,...identity},{schemaVersion:1,operation,...value});
  const stage=continuation('checkpoint',{type:'draft'},{taskDraftCheckpoint:checkpoint},{runIdentity:workspaceDraft});
  turn.items.push(stage);
  // The scheduler may be processing an owner answer instead of its regular
  // clock. Neither that answer nor the provider name grants read classification.
  for(const [skillId,inputs] of [['inventory-reader',{scheduled:true}],['archive-index',{ownerQuestionIds:[randomUUID()]}]]){
    const workStateContext=assistantWorkStateContext({
      assistantId:taskContext.assistantId,companyId:taskPass.companyId,taskId:taskPass.taskId,...inputs,
    });
    original.content[0].text=assistantNativePrompt(terminalMarkerId,workStateContext,{});
    const originalTurn=structuredClone(turn);
    const parameters={companyId:taskPass.companyId,skillId,releaseId:randomUUID(),runtimeSessionId:randomUUID(),arguments:['read','fixture']};
    const stdout='Synthetic signed read output';
    const taskSkillRead=bindAssistantTaskSkillRead({schemaVersion:1,releaseId:parameters.releaseId,packageSha256:'a'.repeat(64),
      outputSha256:createHash('sha256').update(stdout).digest('hex')},{scope:taskPass,parameters,stdout});
    originalTurn.items.push({type:'contextCompaction',id:randomUUID(),startedAtMs:1,completedAtMs:2},
      continuation('skill_run',parameters,{stdout,taskSkillRead}));
    const proof={taskPass,workStateContext,checkpoint};
    assert.equal(assistantInterruptedTaskCheckpoint(originalTurn,terminalMarkerId,proof),true);
    const observed=await readAssistantCodexDelivery(threadId,terminalMarkerId,{
      executable:process.execPath,environment:{},interruptedWorkspaceDraft:{...taskPass,intermediateDraft:{workStateContext,checkpoint}},
      spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'?{thread:{id:threadId,cwd:process.cwd()}}:{data:[originalTurn],nextCursor:null}})),
    });
    assert.deepEqual(observed,{state:'interrupted_task_checkpoint',turnId:turn.id,checkpoint});
    for(const mutate of [
      value=>{value.items.at(-1).status='inProgress';},
      value=>{value.items.at(-1).result.structuredContent.stdout+='x';},
      value=>{delete value.items.at(-1).result.structuredContent.taskSkillRead;},
      value=>{value.items.at(-1).arguments.parameters.arguments=['publish'];},
      value=>{value.items.push(structuredClone(replace));},
      value=>{value.items.push(add('create_comment',{},{}));},
      value=>{value.items.push(add('use_assistant_browser',{command:{operation:'navigate'}},{}));},
      value=>{value.items.at(-2).completedAtMs=null;},
      value=>{value.items.at(-3).result.structuredContent.taskDraftCheckpoint.checkpointId=randomUUID();},
      value=>{value.items[2].result.structuredContent.authorityReads=[];},
    ]){
      const changed=structuredClone(originalTurn);mutate(changed);
      assert.equal(assistantInterruptedTaskCheckpoint(changed,terminalMarkerId,proof),false);
    }
    const cwd=await fs.realpath(process.cwd());
    for(const variant of ['exact','busy','late-effect']){
      const deliveryId=randomUUID(),steps=[],latest=structuredClone(originalTurn);
      let starts=0,reads=0;
      if(variant==='late-effect')latest.items.push(add('create_comment',{},{}));
      const attempt=()=>runAssistantCodexPass({threadId,deliveryId,cwd,execution,
        taskContext:{assistantId:taskContext.assistantId,companyId:taskPass.companyId,taskId:taskPass.taskId,...inputs}},{
        executable:process.execPath,environment:{},requireAbsentMarker:true,
        taskReadRecovery:{intermediateDraft:checkpoint,taskPass,terminalMarkerId,terminalTurnId:turn.id},
        continuationReview:{priorTurnId:turn.id,reviewId:deliveryId},
        readMetadata:async()=>({threadId,cwd}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
        readExecutionAvailability:async()=>true,
        beforeInvocation:async()=>{steps.push('renew');},
        startInvocation:()=>{starts++;},
        readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',receipt:'fixture:completed'},
        spawnProcess:ownedRpc({threadId,cwd,priorTurn:[latest],
          resumeError:variant==='busy'?{code:-32600,message:'thread '+threadId+' already has an active writer'}:undefined,
          onRequest:req=>{
            if(req.method==='thread/resume')steps.push('writer');
            if(req.method==='thread/turns/list'&&req.params.limit===1)steps.push('readlatest');
          },
        }),
      });
      if(variant==='exact'){
        assert.equal((await attempt()).state,'completed');
        assert.deepEqual(steps,['writer','readlatest','renew']);
        assert.equal(starts,1);
      }else{
        await assert.rejects(attempt(),{code:variant==='busy'?'ASSISTANT_CODEX_THREAD_BUSY':'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
        assert.equal(starts,0);
        assert.ok(!steps.includes('renew'));
      }
    }
  }
});


test('a completed legacy file export requires the same opened Run and a later checkpoint',async()=>{
  const {assistantArtifactPathDigest}=await import('../host-runtime/scripts/trelio-local-path.mjs');
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=draftHistory();
  turn.items.splice(3,2); // No text replacement: the export is the only delta.
  turn.items[2].arguments.schemaVersion=1;
  const context=assistantWorkStateContext({assistantId:taskContext.assistantId,companyId:taskPass.companyId,
    taskId:taskPass.taskId,scheduled:true});
  turn.items[0].content[0].text=assistantNativePrompt(terminalMarkerId,context,{});
  const checkpoint={...workspaceDraft,checkpointId:randomUUID(),draftHead:'b'.repeat(40)};
  const release={skillId:'email-imap-smtp',releaseId:'353b28f3-8c94-4d69-a287-5f66ae953484',
    packageSha256:'ef3374b49e7e5cc09330515fac6d97ec8579d64591da09726d89ad9610f238cb'};
  const output=path.resolve('synthetic-workspace','originals'),saved=path.join(output,'message-17.eml');
  const contentSha256='d'.repeat(64),sizeBytes=6541;
  const native=(operation,parameters,result,identity={})=>({type:'mcpToolCall',server:'trelio-assistant',
    tool:'continue_assistant_workspace_action',status:'completed',
    arguments:{schemaVersion:1,operation,parameters,taskPass,...identity},
    result:{structuredContent:{schemaVersion:1,operation,...result}}});
  const exportCall=native('skill_run',{companyId:taskPass.companyId,skillId:release.skillId,releaseId:release.releaseId,
    arguments:['--local-account',randomUUID(),'save-message','--folder','INBOX','--uid','17','--output',output]},
    {stdout:JSON.stringify({saved,size:sizeBytes,sha256:contentSha256,uid:'17',format:'message/rfc822',subject:'private'})});
  turn.items.push(exportCall,native('checkpoint',{type:'draft'},{taskDraftCheckpoint:checkpoint},{runIdentity:workspaceDraft}));
  const read=items=>readAssistantCodexDelivery(randomUUID(),terminalMarkerId,{
    executable:process.execPath,environment:{},interruptedWorkspaceDraft:{...taskPass,intermediateDraft:{workStateContext:context,checkpoint}},
    spawnProcess:nativeRpc(req=>({result:req.method==='thread/read'?{thread:{id:req.params.threadId,cwd:process.cwd()}}
      :{data:[{...turn,items}],nextCursor:null}})),
  });
  const receipt=await read(turn.items);
  const artifact={pathSha256:assistantArtifactPathDigest(saved),contentSha256,sizeBytes};
  assert.deepEqual(receipt,{state:'interrupted_task_checkpoint',turnId:turn.id,checkpoint:{...checkpoint,
    retainedLocalCheckpoint:true,historicalSkillReleases:[release],retainedArtifacts:[artifact]}});
  assert.doesNotMatch(JSON.stringify(receipt),/synthetic-workspace|private/);
  for(const mutate of [
    items=>{items.push(items.splice(-2,1)[0]);}, // An export after checkpoint is unsaved.
    items=>{items.splice(2,0,items.splice(-2,1)[0]);}, // No completed open.
    items=>{items.at(-2).arguments.parameters.arguments.push('--overwrite');},
    items=>{items.at(-2).arguments.parameters.releaseId=randomUUID();},
    items=>{items.at(-2).result.structuredContent.stdout=JSON.stringify({saved,size:sizeBytes,sha256:contentSha256,uid:'18',format:'message/rfc822'});},
    items=>{items.at(-2).status='inProgress';},
  ]){
    const items=structuredClone(turn.items);mutate(items);
    assert.deepEqual(await read(items),{state:'uncertain'});
  }
  const generic=structuredClone(turn.items);
  const call=generic.at(-2),parameters=call.arguments.parameters;
  Object.assign(parameters,{skillId:'different-signed-exporter',releaseId:randomUUID(),arguments:['export','--output',output]});
  const value=call.result.structuredContent;
  value.taskSkillArtifact=bindAssistantTaskSkillArtifact({schemaVersion:1,releaseId:parameters.releaseId,packageSha256:'2'.repeat(64),
    outputSha256:createHash('sha256').update(value.stdout).digest('hex'),artifact},{scope:taskPass,parameters,stdout:value.stdout});
  assert.ok(value.taskSkillArtifact);
  assert.deepEqual(await read(generic),{state:'interrupted_task_checkpoint',turnId:turn.id,
    checkpoint:{...checkpoint,retainedLocalCheckpoint:true,retainedArtifacts:[artifact]}});
  value.stdout+=' ';
  assert.deepEqual(await read(generic),{state:'uncertain'});
});

test('pre-receipt recovery classifies an exact signed legacy release and keeps all other effects fenced',async()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=draftHistory();
  turn.items.splice(3,1);
  const [original,,open]=turn.items;
  open.arguments.schemaVersion=1;
  const context=assistantWorkStateContext({assistantId:taskContext.assistantId,companyId:taskPass.companyId,
    taskId:taskPass.taskId,ownerQuestionIds:[randomUUID()]});
  original.content[0].text=assistantNativePrompt(terminalMarkerId,context,{});
  const checkpoint={...workspaceDraft,checkpointId:randomUUID(),draftHead:'b'.repeat(40)};
  const historyCall=(operation,parameters,identity={})=>({type:'mcpToolCall',server:'trelio-assistant',
    tool:'continue_assistant_workspace_action',status:'completed',arguments:{schemaVersion:1,operation,parameters,taskPass,...identity},
    result:{structuredContent:{schemaVersion:1,operation,stdout:'Synthetic old process result'}}});
  turn.items.push(historyCall('checkpoint',{type:'draft'},{runIdentity:workspaceDraft}));
  const release={skillId:'telegram-mtproto',releaseId:'8f0e4a2a-c63d-4aa2-958c-1fb2701c5c76',
    packageSha256:'ef85be194ef9a52c8ac20b497cd726a5487553884afd511f882be06901f8eaf0'};
  const common={companyId:taskPass.companyId,projectId:randomUUID(),skillId:release.skillId,
    releaseId:release.releaseId,runtimeSessionId:randomUUID()};
  const account=['--local-account',randomUUID()];
  // The real producer emits page JSON plus both display metadata and a
  // native nextCall, including null at the end. A bare stdout fixture misses
  // that boundary and can pass while actual signed guide reads refuse.
  const runtimeDirectory=path.resolve('synthetic-guide-package');
  const files=['references/first.md','references/last.md'].map(relative=>({path:relative,bytes:Buffer.from(relative)}));
  const manifest=JSON.stringify({ok:true,guides:files.map(file=>({path:path.join(runtimeDirectory,file.path),
    sizeBytes:file.bytes.length,sha256:createHash('sha256').update(file.bytes).digest('hex')}))});
  const guideCall=part=>{
    const parameters={...common,arguments:['guides',...account],...(part?{guidePart:part}:{})};
    const call=historyCall('skill_run',parameters);
    const page=assistantSkillGuidePage({stdout:manifest,runtimeDirectory,parsedPackage:{files},part});
    call.result.structuredContent=projectAssistantSkillGuideResult(
      {schemaVersion:1,operation:'skill_run',stdout:JSON.stringify(page)},
      {schemaVersion:1,operation:'skill_run',parameters},part);
    return call;
  };
  const first=guideCall(0),last=guideCall(1);
  assert.equal(first.result.structuredContent.nextCall.arguments.parameters.guidePart,1);
  assert.equal(last.result.structuredContent.nextCall,null);
  turn.items.push(historyCall('skill_run',{...common,arguments:['account','list']}),first,last,
    historyCall('skill_run',{...common,arguments:['read','--link','https://t.me/c/12345/67','--context','2',...account]}));
  const threadId=randomUUID();
  const read=items=>readAssistantCodexDelivery(threadId,terminalMarkerId,{
    executable:process.execPath,environment:{},interruptedWorkspaceDraft:{...taskPass,
      intermediateDraft:{workStateContext:context,checkpoint}},
    spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'?{thread:{id:threadId,cwd:process.cwd()}}
      :{data:[{...turn,items}],nextCursor:null}})),
  });
  const proof=await read(turn.items);
  assert.deepEqual(proof,{state:'interrupted_task_checkpoint',turnId:turn.id,checkpoint:{...checkpoint,
    retainedLocalCheckpoint:true,historicalSkillReleases:[release]}});
  assert.doesNotMatch(JSON.stringify(proof),/Synthetic|t\.me/);
  for(const change of [
    items=>{items.at(-1).arguments.parameters.releaseId=randomUUID();},
    items=>{items.at(-1).arguments.parameters.skillId='another-skill';},
    items=>{items.at(-1).arguments.parameters.arguments.push('--confirm');},
    items=>{items.at(-1).arguments.parameters.arguments[2]='https://example.test/something';},
    items=>{items.at(-1).arguments.parameters.arguments[0]='send';},
    items=>{items.at(-1).result.structuredContent.taskSkillRead={};},
    items=>{items.at(-5).result.structuredContent.taskDraftCheckpoint={};},
    items=>{items.at(-2).arguments.parameters.guidePart=64;},
    items=>{items.at(-3).result.structuredContent.nextCall.arguments.parameters.arguments=['send'];},
    items=>{items.at(-3).result.structuredContent.nextCall.arguments.parameters.releaseId=randomUUID();},
    items=>{items.at(-2).result.structuredContent.nextCall=items.at(-3).result.structuredContent.nextCall;},
    items=>{
      const result=items.at(-3).result.structuredContent,page=JSON.parse(result.stdout);
      result.stdout=JSON.stringify({...page,text:page.text+' altered'});
    },
    items=>{items.at(-3).result.structuredContent.instruction='x'.repeat(513);},
    items=>{items.at(-3).result.structuredContent.unverified=true;},
  ]){
    const edited=structuredClone(turn.items);change(edited);
    assert.deepEqual(await read(edited),{state:'uncertain'});
  }
});

test('an interrupted named archive permits only recovery of its positively witnessed save',()=>{
  const {turn,terminalMarkerId,taskPass,workspaceDraft}=draftHistory();
  const [marker,prepare,open,_refusal,replace]=turn.items;
  const target=prepare.result.structuredContent.workspace;
  Object.assign(target,{scopeType:'project',scopeKey:`workspace:${workspaceDraft.workspaceId}`,taskId:null});
  const openHandle=randomUUID(),finishHandle=randomUUID();
  const call=(tool,args,result,status='completed')=>({type:'mcpToolCall',server:'trelio-assistant',tool,status,
    arguments:{...args,taskPass},result:{structuredContent:result}});
  const action=(operation,parameters,result,status)=>call('continue_assistant_workspace_action',
    {schemaVersion:1,operation,parameters,runIdentity:workspaceDraft},result,status);
  const pending=(operation,operationId)=>({schemaVersion:1,operation,state:'running',operationId,
    nextCall:{tool:'continue_assistant_workspace_action',arguments:{schemaVersion:1,operation:'status',
      parameters:{finishOperationId:operationId},runIdentity:workspaceDraft}}});
  open.arguments.schemaVersion=1;open.result.structuredContent=pending('open',openHandle);
  const finishInput={taskOutcome:'no_status_change'};
  turn.items=[marker,prepare,open,action('status',{finishOperationId:openHandle},pending('open',openHandle)),
    action('status',{finishOperationId:openHandle},{code:'TRELIO_RUNTIME_HOOK_FAILED'},'failed'),
    action('status',{}, {schemaVersion:1,operation:'status',stdout:JSON.stringify({...workspaceDraft,
      baseHead:'a'.repeat(40),terminalStatus:null,dirty:false})}),
    call('use_assistant_workspace_files',{runIdentity:workspaceDraft,command:{action:'read',path:'WORKSPACE_CONTEXT.md'}},
      {code:'ASSISTANT_MCP_LOCAL_WORKSPACE_FILES_FAILED'},'failed'),
    replace,action('checkpoint',{type:'draft'},{schemaVersion:1,operation:'checkpoint'}),
    action('finish',finishInput,{code:'TRELIO_WORKSPACE_ACTION_INVALID_INPUT'},'failed'),
    action('finish',finishInput,pending('finish',finishHandle)),
    call('create_task_control',{visibility:'shared',clientRequestId:randomUUID()},
      {schemaVersion:1,operation:'create_task_control',taskId:taskPass.taskId,resultId:randomUUID(),receiptId:randomUUID()}),
    action('status',{finishOperationId:finishHandle},pending('finish',finishHandle)),
    call('get_task_sections',{}, {schemaVersion:3}),
  ];
  const receiptLookup=randomUUID();
  turn.items.push({type:'mcpToolCall',server:'trelio-assistant',tool:'get_assistant_status',status:'completed',
    arguments:{operationReceipt:receiptLookup},result:{structuredContent:{state:'not_recorded',clientRequestId:receiptLookup,companies:[]}}});
  assert.deepEqual(assistantInterruptedNamedWorkspaceFinish(turn,terminalMarkerId,taskPass),
    {...workspaceDraft,finishPending:true,namedArchive:true});
  assert.equal(assistantInterruptedPendingWorkspaceFinish(turn,terminalMarkerId,taskPass),null);
  for(const edit of [
    x=>{x.items[1].result.structuredContent.workspace.companyId=randomUUID();},
    x=>{delete x.items[1].arguments.runId;},
    x=>{x.items[5].result.structuredContent.stdout='{}';},
    x=>{x.items[7].result.structuredContent.sha256='0'.repeat(64);},
    x=>{x.items[8].status='failed';},
    x=>{delete x.items[11].result.structuredContent.receiptId;},
    x=>{x.items.at(-3).arguments.parameters.finishOperationId=randomUUID();},
    x=>{x.items.at(-3).status='inProgress';},
    x=>{x.items.at(-1).result.structuredContent.clientRequestId=randomUUID();},
    x=>{x.items.at(-1).result.structuredContent.state='recorded';},
    x=>{x.items.push(call('use_assistant_browser',{command:{operation:'navigate'}},{state:'ready'}));},
    x=>{x.items.push(call('execute_assistant_operation',{operation:'skill_run'},{state:'completed'}));},
    x=>{x.items.push(call('complete_assistant_pass',{}, {state:'completed'}));},
  ]){
    const changed=structuredClone(turn);edit(changed);
    assert.equal(assistantInterruptedNamedWorkspaceFinish(changed,terminalMarkerId,taskPass),null);
  }
});

test('named-archive settlement requires the real restricted turn and exact accepted read-back',()=>{
  const run={workspaceId:randomUUID(),runId:randomUUID()},deliveryId=randomUUID();
  const taskPass={companyId:randomUUID(),taskId:randomUUID(),passId:randomUUID()};
  const baseHead='a'.repeat(40),candidateHead='b'.repeat(40);
  const {companyId,taskId}=taskPass;
  const text=`${assistantDeliveryMarker(deliveryId)}\nTRELIO_ASSISTANT_SCOPE ${JSON.stringify({companyId,taskId})}\nRecover only the existing named Workspace save. Read exact status for workspaceId=${run.workspaceId}, runId=${run.runId}, without the old poll handle.\n`;
  const status={...run,terminalStatus:'accepted',baseHead,candidateHead,dirty:false};
  const turn={id:randomUUID(),status:'completed',items:[
    {type:'userMessage',content:[{type:'text',text}]},
    {type:'mcpToolCall',server:'trelio-assistant',tool:'continue_assistant_workspace_action',status:'completed',
      arguments:{schemaVersion:1,operation:'status',parameters:{},runIdentity:run,taskPass},
      result:{structuredContent:{schemaVersion:1,operation:'status',stdout:JSON.stringify(status),
        nativeRunStatus:{status:'accepted',baseHead,candidateHead}}}},
  ]};
  assert.deepEqual(assistantAcceptedNamedArchive(turn,deliveryId,taskPass,run),{...run,acceptedHead:candidateHead});
  for(const edit of [
    x=>{x.status='interrupted';},
    x=>{x.items[0].content[0].text=text.replace('Recover only','Proceed with');},
    x=>{x.items[1].arguments.runIdentity={...run,runId:randomUUID()};},
    x=>{x.items[1].result.structuredContent.nativeRunStatus.candidateHead='c'.repeat(40);},
    x=>{x.items[1].result.structuredContent.stdout=JSON.stringify({...status,dirty:true});},
    x=>{x.items[1].result.structuredContent.stdout=JSON.stringify({...status,terminalStatus:null});},
    x=>{x.items.push({...x.items[1],tool:'complete_assistant_pass'});},
    x=>{x.items.push({...x.items[1],tool:'use_assistant_browser'});},
  ]){
    const changed=structuredClone(turn);edit(changed);
    assert.equal(assistantAcceptedNamedArchive(changed,deliveryId,taskPass,run),null);
  }
});

// Exercise the complete save-only history, rather than a lone accepted status:
// a failed read during asynchronous open precedes successful authority reads,
// one finish and its independent exact native/local acceptance read-back.
const archiveWithRefusedOpenPoll=()=>{
  const run={workspaceId:randomUUID(),runId:randomUUID()},deliveryId=randomUUID();
  const taskPass={companyId:taskContext.companyId,taskId:taskContext.taskId,passId:randomUUID()};
  const baseHead='a'.repeat(40),candidateHead='b'.repeat(40),openHandle=randomUUID(),finishHandle=randomUUID();
  const call=(tool,args,value,status='completed')=>({type:'mcpToolCall',server:'trelio-assistant',tool,status,
    arguments:{...args,taskPass},result:{structuredContent:value}});
  const action=(operation,parameters,value,status)=>call('continue_assistant_workspace_action',
    {schemaVersion:1,operation,parameters,...operation==='open'?{}:{runIdentity:run}},value,status);
  const pending=(operation,operationId)=>({schemaVersion:1,operation,state:'running',operationId,
    nextCall:{tool:'continue_assistant_workspace_action',arguments:{schemaVersion:1,operation:'status',
      parameters:{finishOperationId:operationId},runIdentity:run}}});
  const state=(accepted=false)=>({schemaVersion:1,operation:'status',stdout:JSON.stringify({...run,
    baseHead,candidateHead,dirty:false,terminalStatus:accepted?'accepted':null}),
    ...accepted?{nativeRunStatus:{status:'accepted',baseHead,candidateHead}}:{}});
  const text=`${assistantDeliveryMarker(deliveryId)}\nTRELIO_ASSISTANT_SCOPE ${JSON.stringify(taskContext)}\nRecover only the existing named Workspace save. Read exact status for workspaceId=${run.workspaceId}, runId=${run.runId}, without the old poll handle.\n`;
  const turn={id:randomUUID(),status:'completed',items:[
    {type:'userMessage',content:[{type:'text',text}]},action('status',{},state()),
    call('prepare_assistant_workspace_run',run,{prepared:true,run:{id:run.runId},workspace:{id:run.workspaceId,
      companyId:taskPass.companyId,scopeType:'project',scopeKey:`workspace:${run.workspaceId}`,taskId:null}}),
    action('open',run,pending('open',openHandle)),
    action('status',{finishOperationId:openHandle},{code:'TRELIO_RUNTIME_HOOK_FAILED'},'failed'),
    action('status',{},state()),
    ...['context/agent-instructions.md','context/user-profile.md'].map(path=>call('use_assistant_workspace_files',
      {runIdentity:run,command:{action:'read',path}},{state:'read'})),
    action('finish',{taskOutcome:'no_status_change'},pending('finish',finishHandle)),
    {type:'sleep'},action('status',{finishOperationId:finishHandle},pending('finish',finishHandle)),
    action('status',{finishOperationId:finishHandle},{schemaVersion:1,operation:'finish',state:'completed'}),
    action('status',{},state(true)),
  ]};
  return {turn,deliveryId,taskPass,run,candidateHead};
};

// Compose the actual prompt builder and native reader across all task save
// entry points. A precomputed portable prompt hid the local-draft mismatch.
for(const anchor of ['base','checkpoint','portable'])test(`native read-back recognizes its own restricted save (${anchor})`,async()=>{
  const {turn,deliveryId,taskPass,run,candidateHead}=archiveWithRefusedOpenPoll();
  const threadId=randomUUID(),cwd=await fs.realpath(process.cwd());
  const scope={...taskContext,scheduled:true};
  const portable=anchor==='portable';
  const receipt=portable
    ?{...run,checkpointId:randomUUID(),draftHead:candidateHead}
    :{...run,baseHead:'a'.repeat(40),anchorHead:(anchor==='base'?'a':'c').repeat(40),
      checkpointId:anchor==='base'?null:randomUUID()};
  const selected=portable?{portableFinish:receipt}:{localDraft:{
    basis:{...receipt,deltaSha256:'d'.repeat(64)},
    replacements:[{pathSha256:'e'.repeat(64),contentSha256:'f'.repeat(64)}],
  }};
  const options=workspaceDraft=>({workspaceDraftRecovery:{workspaceDraft:{...run,finishPending:true,...workspaceDraft}}});
  const text=assistantNativePrompt(deliveryId,scope,options(selected));
  turn.items[0].content[0].text=text;
  Object.assign(turn.items[2].result.structuredContent.workspace,{
    scopeType:'task',scopeKey:`task:${taskPass.taskId}`,taskId:taskPass.taskId,
  });
  const read=history=>readAssistantCodexDelivery(threadId,deliveryId,{executable:process.execPath,environment:{},
    [portable?'acceptedPortableFinish':'acceptedLocalDraft']:{taskPass,receipt},
    spawnProcess:nativeRpc(request=>{
      if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd}}};
      assert.equal(request.method,'thread/turns/list');
      assert.equal(request.params.itemsView,'full');
      return {result:{data:[history]}};
    }),
  });
  assert.deepEqual(await read(turn),{state:'portable_finish_saved',turnId:turn.id,acceptedHead:candidateHead});
  const wrongMode=structuredClone(turn);
  wrongMode.items[0].content[0].text=assistantNativePrompt(deliveryId,scope,
    options(portable?{localDraft:{}}:{portableFinish:{}}));
  assert.deepEqual(await read(wrongMode),{state:'uncertain'});
  const changed=structuredClone(turn);
  changed.items.at(-1).result.structuredContent.nativeRunStatus.candidateHead='9'.repeat(40);
  assert.deepEqual(await read(changed),{state:'uncertain'});
  const stale=structuredClone(turn);
  const accepted=stale.items.at(-1).result.structuredContent;
  const staleHead=portable?'9'.repeat(40):receipt.anchorHead;
  accepted.nativeRunStatus.candidateHead=staleHead;
  accepted.stdout=JSON.stringify({...JSON.parse(accepted.stdout),candidateHead:staleHead});
  assert.deepEqual(await read(stale),{state:'uncertain'});
  if(!portable){
    const unfinished=structuredClone(turn);
    unfinished.items=unfinished.items.filter(item=>item.arguments?.operation!=='finish');
    assert.deepEqual(await read(unfinished),{state:'uncertain'});
  }
});

test('an accepted local save can nominate only the exact observed outbound effect of its preceding turn',async()=>{
  const {turn:save,deliveryId:saveMarkerId,taskPass,run,candidateHead}=archiveWithRefusedOpenPoll();
  const scope={companyId:taskPass.companyId,taskId:taskPass.taskId,scheduled:true};
  const deliveryId=randomUUID(),sourceMarkerId=randomUUID(),threadId=randomUUID();
  const receipt={...run,baseHead:'a'.repeat(40),anchorHead:'c'.repeat(40),checkpointId:randomUUID()};
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const {assistantArtifactPathDigest}=await import('../host-runtime/scripts/trelio-local-path.mjs');
  const destination=path.resolve('synthetic-provider-archive'),saved=path.join(destination,'message-7.eml');
  const parent='<original@example.test>',messageId='<sent@example.test>',bytes=`Message-ID: ${messageId}\r\nIn-Reply-To: ${parent}\r\n\r\nsample`;
  const artifact={pathSha256:assistantArtifactPathDigest(saved),contentSha256:digest(bytes),sizeBytes:Buffer.byteLength(bytes)};
  const release={skillId:'email-imap-smtp',releaseId:'353b28f3-8c94-4d69-a287-5f66ae953484',
    packageSha256:'ef3374b49e7e5cc09330515fac6d97ec8579d64591da09726d89ad9610f238cb'};
  const call=(tool,args,structuredContent,status='completed')=>({type:'mcpToolCall',server:'trelio-assistant',tool,status,
    arguments:{...args,taskPass},result:{structuredContent}});
  const action=(operation,parameters,result,status)=>call('continue_assistant_workspace_action',
    {schemaVersion:1,operation,parameters,...operation==='open'?{}:{runIdentity:run}},result,status);
  const localAccount=randomUUID(),runtimeSessionId=randomUUID(),startedAt=1_700_000_000;
  const skill=(args,outcome)=>{
    const parameters={companyId:taskPass.companyId,skillId:release.skillId,releaseId:release.releaseId,
      runtimeSessionId,arguments:['--local-account',localAccount,...args]};
    return call('continue_assistant_workspace_action',{schemaVersion:1,operation:'skill_run',parameters},
      outcome===null?{code:'ASSISTANT_WORKSPACE_OUTCOME_REVIEW_REQUIRED'}:{schemaVersion:1,operation:'skill_run',stdout:JSON.stringify(outcome)},
      outcome===null?'failed':'completed');
  };
  const plan={source:{folder:'INBOX',uid:'3',messageId:parent},from:'assistant@example.test',to:['owner@example.test'],
    cc:[],subject:'Re: Sample',body:'sample',attachments:[]};
  const reply=['reply','--folder','INBOX','--uid','3','--body','sample'],planSha256=digest('synthetic preview');
  const confirm=skill([...reply,'--confirm','--expected-plan-sha256',planSha256],null);
  const obtain=['search','--special-use','sent','--since','2023-11-14','--to','owner@example.test','--limit','10'];
  const sentRead=skill(['read','--folder','Sent','--uid','7'],{folder:'Sent',uid:'7',messageId,
    from:plan.from,to:plan.to[0],cc:'',subject:plan.subject,body:'sample\r\n',attachments:[],
    date:new Date((startedAt+60)*1000).toISOString(),originalSha256:artifact.contentSha256});
  const original={id:randomUUID(),status:'interrupted',startedAt,completedAt:null,items:[
    {type:'userMessage',content:[{type:'text',text:assistantNativePrompt(sourceMarkerId,scope,{})}]},
    call('prepare_assistant_workspace_run',run,{prepared:true,workspace:{id:run.workspaceId,companyId:taskPass.companyId,
      scopeType:'task',taskId:taskPass.taskId},run:{id:run.runId}}),
    action('open',run,{operation:'open'}),skill(['signature','show'],{signatureSha256:digest('')}),
    skill(reply,{prepared:true,sent:false,plan,planSha256}),confirm,skill(obtain,null),
    skill(obtain,{folder:'Sent',messages:[{uid:'7',messageId}]}),sentRead,
    skill(['save-message','--folder','Sent','--uid','7','--output',destination],
      {saved,uid:'7',format:'message/rfc822',size:artifact.sizeBytes,sha256:artifact.contentSha256}),
    action('checkpoint',{type:'draft'},{code:'TRELIO_WORKSPACE_RUN_RECLAIM_REQUIRED'},'failed'),
    call('use_assistant_workspace_files',{runIdentity:run,command:{action:'replace',path:'WORK.md',text:'Reply archived',
      expectedSha256:null}},{state:'draft_updated',sha256:digest('Reply archived')}),
  ]};
  save.items[0].content[0].text=assistantNativePrompt(saveMarkerId,scope,{workspaceDraftRecovery:{workspaceDraft:{...run,localDraft:{basis:receipt}}}});
  save.items[2].result.structuredContent.workspace={id:run.workspaceId,scopeType:'task',scopeKey:`task:${taskPass.taskId}`,
    companyId:taskPass.companyId,taskId:taskPass.taskId};
  const read=(history=original)=>readAssistantCodexDelivery(threadId,saveMarkerId,{executable:process.execPath,environment:{},
    recoveredWorkspaceOutcome:{deliveryId,originalTurnId:original.id,saveMarkerId,saveTurnId:save.id,taskPass,
      mode:'local_draft',receipt,sourceMarkerId},spawnProcess:nativeRpc(request=>({
      result:request.method==='thread/read'?{thread:{id:threadId,cwd:process.cwd()}}:{data:[save,history]},
    }))});
  const effect=await read();
  assert.equal(effect.state,'recovered_outcome_observed');
  assert.equal(effect.evidence.acceptedHead,candidateHead);
  assert.deepEqual(effect.evidence.providerEffect.artifact,artifact);
  assert.deepEqual(effect.evidence.historicalSkillReleases,[release]);
  assert.doesNotMatch(JSON.stringify(effect),/original@example|sent@example|synthetic-provider-archive/u);
  const openHandle=randomUUID(),openParameters={finishOperationId:openHandle};
  const pending={schemaVersion:1,operation:'open',state:'running',operationId:openHandle,
    nextCall:{tool:'continue_assistant_workspace_action',arguments:{schemaVersion:1,operation:'status',
      runIdentity:run,parameters:openParameters}}};
  const polled=structuredClone(original);
  polled.items.splice(2,1,action('open',run,pending),
    action('status',openParameters,{code:'TRELIO_RUNTIME_HOOK_FAILED'},'failed'),
    action('status',{}, {operation:'status',stdout:JSON.stringify({...run,dirty:false})}));
  assert.deepEqual(await read(polled),effect);
  const unrelated=structuredClone(polled);
  unrelated.items[3].arguments.parameters.finishOperationId=randomUUID();
  assert.deepEqual(await read(unrelated),{state:'uncertain'});
  for(const change of [
    value=>value.items.splice(6,0,structuredClone(confirm)),
    value=>{value.items[8].result.structuredContent.stdout=JSON.stringify({folder:'Sent',uid:'7',messageId});},
    value=>{value.items[8].arguments.parameters.runtimeSessionId=randomUUID();},
    value=>{value.items[0].content[0].text=assistantNativePrompt(randomUUID(),scope,{});},
    value=>value.items.push(call('create_comment',{},{})),
  ]){
    const modified=structuredClone(original);change(modified);
    assert.deepEqual(await read(modified),{state:'uncertain'});
  }
});

for(const mode of ['local_draft','portable_draft'])test(`a verified ${mode} save can observe only its settled original outcome`,async()=>{
  const {turn:save,deliveryId:saveMarkerId,taskPass,run,candidateHead}=archiveWithRefusedOpenPoll();
  const {workspaceId,runId}=run,threadId=randomUUID(),deliveryId=randomUUID(),requestId=randomUUID(),questionId=randomUUID();
  const scope={...taskContext,scheduled:true,workMode:'task'};
  const local={...run,baseHead:'a'.repeat(40),anchorHead:'a'.repeat(40),checkpointId:null};
  const portable={...run,checkpointId:randomUUID(),draftHead:candidateHead};
  const receipt=mode==='local_draft'?local:portable;
  const workspaceDraft={...run,finishPending:true,...mode==='local_draft'
    ?{localDraft:{basis:local}}:{portableFinish:portable}};
  const root=marker=>({type:'userMessage',content:[{type:'text',text:assistantNativePrompt(marker,scope,{})}]});
  const call=(tool,args,value,status='completed')=>({type:'mcpToolCall',server:'trelio-assistant',tool,status,
    arguments:{...args,taskPass},result:{structuredContent:value}});
  const action=(operation,parameters,value)=>call('continue_assistant_workspace_action',
    {schemaVersion:1,operation,parameters,...operation==='open'?{}:{runIdentity:run}},value);
  const nativeWorkspace={id:workspaceId,companyId:taskPass.companyId,scopeType:'task',
    scopeKey:`task:${taskPass.taskId}`,taskId:taskPass.taskId};
  save.items[0].content[0].text=assistantNativePrompt(saveMarkerId,scope,{workspaceDraftRecovery:{workspaceDraft}});
  save.items[2].result.structuredContent.workspace=nativeWorkspace;
  const p={companyId:taskPass.companyId,skillId:'example-read',releaseId:randomUUID(),arguments:['read']};
  const stdout='{"ok":true,"private":"do not project"}';
  const signedRead=bindAssistantTaskSkillRead({schemaVersion:1,releaseId:p.releaseId,packageSha256:'b'.repeat(64),
    outputSha256:createHash('sha256').update(stdout).digest('hex')},{scope:taskPass,parameters:p,stdout});
  const legacy={...p,skillId:'telegram-mtproto',releaseId:'b1dabd59-00fa-42e1-a4f4-45e09081de2a',
    arguments:['--local-account',randomUUID(),'chat-info','--chat','1234']};
  const historical=reviewedAssistantHistoricalSkillRead(legacy,
    {providerArguments:['chat-info','--chat','1234'],accountId:legacy.arguments[1]},{terminal:true});
  assert.ok(historical);
  assert.equal(reviewedAssistantHistoricalSkillRead(legacy,
    {providerArguments:['chat-info','--chat','1234'],accountId:legacy.arguments[1]}),null);
  const original={id:randomUUID(),status:'interrupted',items:[root(deliveryId),
    call('prepare_assistant_workspace_run',run,{prepared:true,workspace:nativeWorkspace,run:{id:runId}}),
    action('open',run,{operation:'open'}),
    call('continue_assistant_workspace_action',{schemaVersion:1,operation:'skill_run',parameters:p},
      {schemaVersion:1,operation:'skill_run',stdout,taskSkillRead:signedRead}),
    call('continue_assistant_workspace_action',{schemaVersion:1,operation:'skill_run',parameters:legacy},
      {schemaVersion:1,operation:'skill_run',stdout}),
    call('ask_assistant_owner',{clientRequestId:requestId},{id:questionId,path:'/profile/',state:'pending',replayed:false}),
    call('use_assistant_workspace_files',{runIdentity:run,command:{action:'replace',path:'WORK.md',text:'pending',
      expectedSha256:null}},{state:'draft_updated',sha256:createHash('sha256').update('pending').digest('hex')}),
  ]};
  const guideParameters={...legacy,arguments:['guides']};
  const guideText='Synthetic signed guide';
  const guide=projectAssistantSkillGuideResult({schemaVersion:1,operation:'skill_run',stdout:JSON.stringify({
    schemaVersion:1,part:0,count:1,nextGuidePart:null,path:'instruction-guides/part-01.md',text:guideText,
    sha256:createHash('sha256').update(guideText).digest('hex'),
  })},{schemaVersion:1,operation:'skill_run',parameters:guideParameters},0);
  original.items.push(call('continue_assistant_workspace_action',
    {schemaVersion:1,operation:'skill_run',parameters:guideParameters},guide));
  if(mode==='portable_draft')original.items.push(action('finish',{taskOutcome:'no_status_change'},{operation:'finish'}));
  const read=(history=[save,original])=>readAssistantCodexDelivery(threadId,saveMarkerId,{
    executable:process.execPath,environment:{},recoveredWorkspaceOutcome:{deliveryId,originalTurnId:original.id,
      saveMarkerId,saveTurnId:save.id,taskPass,mode,receipt},
    spawnProcess:nativeRpc(request=>{
      if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd:process.cwd()}}};
      assert.equal(request.method,'thread/turns/list');assert.equal(request.params.limit,2);
      assert.equal(request.params.itemsView,'full');
      return {result:{data:history}};
    }),
  });
  assert.deepEqual(await read(),{state:'recovered_outcome_observed',turnId:save.id,
    evidence:{...run,acceptedHead:candidateHead,questionId,questionRequestId:requestId,historicalSkillReleases:[historical]}});
  const evidence={...run,acceptedHead:candidateHead,questionId,questionRequestId:requestId,historicalSkillReleases:[historical]};
  const historyWithBrowser=siteOrigin=>{
    const parent=structuredClone(original);
    const browser=(operation,args,state)=>call('use_assistant_browser',{siteOrigin,command:{operation,args}}, {state,reason:'none'});
    parent.items.splice(3,0,browser('navigate',{url:siteOrigin+'/read'},'preparing'),
      browser('status',{},'ready'),browser('screenshot',{},'ready'),browser('close',{},'closed'));
    return parent;
  };
  for(const origin of ['https://mail.google.com','https://school.example.test','https://different.example.test:8443']){
    const parent=historyWithBrowser(origin);
    assert.deepEqual(await read([save,parent]),{state:'recovered_outcome_observed',turnId:save.id,evidence});
    const changed=structuredClone(parent);
    changed.items[6].arguments.siteOrigin='https://unrelated.example.test';
    assert.deepEqual(await read([save,changed]),{state:'uncertain'});
    changed.items[6].arguments.siteOrigin=origin;
    changed.items[6].arguments.command.operation='type-text';
    assert.deepEqual(await read([save,changed]),{state:'uncertain'});
    parent.items.splice(6,1);
    assert.deepEqual(await read([save,parent]),{state:'uncertain'});
  }
  const reviewId=randomUUID(),cwd=await fs.realpath(process.cwd());
  const plan={saveReviewId:saveMarkerId,evidence,schedule:{
    priorReceiptId:randomUUID(),cadence:'daily',timeZone:'Europe/Moscow',dailyLocalTime:'20:00',
  }};
  const failureMarker=randomUUID(),failureTurnId=randomUUID();
  const failed={id:failureTurnId,status:'completed',items:[root(failureMarker),
    call('complete_assistant_pass',{workspaceId,acceptedRunId:runId,workspaceHead:candidateHead,goalState:'waiting_owner',
      noChange:false,clientRequestId:failureMarker,cadence:'daily',timeZone:'Europe/Moscow',dailyLocalTime:'20:00'},
    {code:'ASSISTANT_MCP_LOCAL_WORKSPACE_ARGUMENTS_FAILED'},'failed')]};
  const retry={plan,retryFromReviewId:failureMarker,terminalTurnId:failureTurnId};
  const readRetry=(latest=failed,parent=original)=>readAssistantCodexDelivery(threadId,failureMarker,{
    executable:process.execPath,environment:{},recoveredWorkspaceOutcome:{deliveryId,originalTurnId:original.id,
      saveMarkerId,saveTurnId:save.id,taskPass,mode,receipt,retry},
    spawnProcess:nativeRpc(request=>{
      if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd:process.cwd()}}};
      assert.equal(request.method,'thread/turns/list');assert.equal(request.params.limit,3);
      return {result:{data:[latest,save,parent]}};
    })});
  assert.deepEqual(await readRetry(),{state:'recovered_outcome_observed',turnId:failureTurnId,evidence});
  for(const change of ['changed-head','unknown-transport','duplicate-call']){
    const wrong=structuredClone(failed),tool=wrong.items[1];
    if(change==='changed-head')tool.arguments.workspaceHead=receipt.baseHead??'a'.repeat(40);
    if(change==='unknown-transport')tool.result.structuredContent.code='ASSISTANT_MCP_UNAVAILABLE';
    if(change==='duplicate-call')wrong.items.push(structuredClone(tool));
    assert.deepEqual(await readRetry(wrong),{state:'uncertain'});
  }
  for(const changed of [false,true]){
    let reads=0,starts=0;
    const steps=[],parent=historyWithBrowser('https://unrelated.example.test');
    if(changed)parent.items[6].status='inProgress';
    const attempt=runAssistantCodexPass({threadId,deliveryId:reviewId,cwd,taskContext:scope,execution},{
      executable:process.execPath,environment:{},requireAbsentMarker:true,
      continuationReview:{priorTurnId:save.id,reviewId},
      workspaceDraftRecovery:{terminalMarkerId:saveMarkerId,terminalTurnId:save.id,originalDeliveryId:deliveryId,taskPass,
        workspaceDraft:{...run,acceptedHead:candidateHead,recoveredOutcome:{plan,originalTurnId:original.id,mode,receipt}}},
      readMetadata:async()=>({threadId,cwd}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
      readExecutionAvailability:async()=>true,beforeInvocation:async()=>{steps.push('renew');},
      startInvocation:()=>{starts++;},
      readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',receipt:'native:accepted'},
      spawnProcess:ownedRpc({threadId,cwd,priorTurn:[save,parent],
        executionPolicy:(request,base)=>{
          if(request.method!=='mcpServerStatus/list')return;
          base.result.data[0].tools={complete_assistant_pass:{name:'complete_assistant_pass'}};
          return base;
        },
        onRequest:request=>{
          if(request.method==='thread/resume'){
            const plugin=request.params.config.plugins['trelio-digital-assistant@trelio-digital-assistants'];
            assert.deepEqual(plugin.mcp_servers['trelio-assistant'].enabled_tools,['complete_assistant_pass']);
            steps.push('writer');
          }
          if(request.method==='thread/turns/list'&&request.params.limit===2)steps.push('readboth');
        },
        onInput:text=>{
          assert.match(text,/Call only complete_assistant_pass once/u);
          assert.match(text,/"goalState":"waiting_owner"/u);assert.match(text,/"dailyLocalTime":"20:00"/u);
          assert.doesNotMatch(text,/unrelated\.example|do not project/u);
        },
      }),
    });
    if(changed){
      await assert.rejects(attempt,{code:'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
      assert.equal(starts,0);assert.deepEqual(steps,['writer','readboth']);
    }else{
      assert.equal((await attempt).state,'completed');
      assert.equal(starts,1);assert.deepEqual(steps,['writer','readboth','renew']);
    }
  }
  for(const change of [
    parent=>{parent.items[3].result.structuredContent.stdout+='x';},
    parent=>{parent.items[4].arguments.parameters.arguments.push('--send');},
    parent=>{parent.items[5].result.structuredContent.replayed=true;},
    parent=>{parent.items[5].arguments.taskPass={...taskPass,passId:randomUUID()};},
    parent=>{parent.items.push(call('use_assistant_browser',{},{}));},
    parent=>{parent.items.push(call('continue_assistant_workspace_action',{schemaVersion:1,operation:'skill_run',
      parameters:{...legacy,arguments:['send']}},{code:'TRELIO_WORKSPACE_ACTION_FAILED'},'failed'));},
    parent=>{parent.items.push(call('update_task_control',{},{}));},
    parent=>{parent.items.push(structuredClone(parent.items[0]));},
  ]){
    const changed=structuredClone(original);change(changed);
    assert.deepEqual(await read([save,changed]),{state:'uncertain'});
  }
  assert.deepEqual(await read([save]),{state:'uncertain'});
  assert.deepEqual(await read([save,{...original,id:randomUUID()}]),{state:'uncertain'});
});

test('accepted named archive tolerates only its own pre-finish hook-refused open-status read',()=>{
  const {turn,deliveryId,taskPass,run,candidateHead}=archiveWithRefusedOpenPoll();
  assert.deepEqual(assistantAcceptedNamedArchive(turn,deliveryId,taskPass,run),{...run,acceptedHead:candidateHead});
  for(const edit of [
    x=>{x.items[4].arguments.parameters.finishOperationId=randomUUID();},
    x=>{x.items[4].arguments.parameters.extra=true;},
    x=>{x.items[4].arguments.runIdentity.runId=randomUUID();},
    x=>{x.items[4].arguments.taskPass.passId=randomUUID();},
    x=>{x.items[4].arguments.schemaVersion=2;},
    x=>{x.items[4].arguments.operation='finish';},
    x=>{x.items[4].arguments.operation='open';},
    x=>{x.items[4].tool='use_assistant_browser';},
    x=>{x.items[4].server='foreign';},
    x=>{x.items[4].status='inProgress';},
    x=>{x.items[4].status='completed';},
    x=>{x.items[4].result.isError=false;},
    x=>{x.items[4].result.structuredContent.code='ASSISTANT_MCP_LOCAL_WORKSPACE_FILES_FAILED';},
    x=>{x.items[4].result.structuredContent.extra=true;},
    x=>{x.items[4].error={message:'foreign failure'};},
    x=>{x.items[3].result.structuredContent.nextCall.arguments.runIdentity={...run,runId:randomUUID()};},
    x=>{x.items[3].result.structuredContent.nextCall.arguments.parameters.finishOperationId=randomUUID();},
    x=>{x.items[3].result.structuredContent.state='completed';},
    x=>{x.items.splice(3,1);},
    x=>{x.items.splice(9,0,x.items.splice(4,1)[0]);},
    x=>{x.items.push(structuredClone(x.items[4]));},
    x=>{x.items.pop();},
    x=>{x.items.at(-1).result.structuredContent.nativeRunStatus.status='submitted';},
    x=>{x.items.at(-1).result.structuredContent.nativeRunStatus.candidateHead='c'.repeat(40);},
  ]){
    const changed=structuredClone(turn);edit(changed);
    assert.equal(assistantAcceptedNamedArchive(changed,deliveryId,taskPass,run),null);
  }
});

for(const changed of [false,true])test(`native archive read and owned-writer recheck compose refused-poll history (${changed?'changed':'confirmed'})`,async()=>{
  const f=archiveWithRefusedOpenPoll(),threadId=randomUUID(),cwd=await fs.realpath(process.cwd()),steps=[];
  const read=await readAssistantCodexDelivery(threadId,f.deliveryId,{executable:process.execPath,environment:{},
    acceptedNamedArchive:{taskPass:f.taskPass,run:f.run},spawnProcess:nativeRpc(request=>{
      if(request.method==='thread/read')return {result:{thread:{id:threadId,cwd}}};
      assert.equal(request.method,'thread/turns/list');assert.equal(request.params.itemsView,'full');
      assert.equal(request.params.limit,1);return {result:{data:[f.turn]}};
    })});
  assert.deepEqual(read,{state:'named_archive_saved',turnId:f.turn.id,namedArchiveSettled:{...f.run,acceptedHead:f.candidateHead}});
  const deliveryId=randomUUID(),prior=structuredClone(f.turn);let reads=0;
  if(changed)prior.items[4].arguments.parameters.finishOperationId=randomUUID();
  const operation=()=>runAssistantCodexPass({threadId,deliveryId,cwd,taskContext,execution},{
    executable:process.execPath,environment:{},requireAbsentMarker:true,
    continuationReview:{priorTurnId:f.turn.id,reviewId:deliveryId},
    namedArchiveResume:{archive:read.namedArchiveSettled,taskPass:f.taskPass,terminalMarkerId:f.deliveryId,terminalTurnId:f.turn.id},
    readMetadata:async()=>({threadId,cwd}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    readExecutionAvailability:async()=>true,beforeInvocation:async()=>{steps.push('renew');},startInvocation:()=>{steps.push('start');},
    readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',receipt:'fixture:completed'},
    spawnProcess:ownedRpc({threadId,cwd,priorTurn:prior,onRequest:request=>{
      if(request.method==='thread/resume')steps.push('writer');
      if(request.method==='thread/turns/list'&&request.params.limit===1)steps.push('accepted-read');
    },onInput:text=>{assert.match(text,/Reuse that accepted archive revision/u);}}),
  });
  if(changed){
    await assert.rejects(operation(),{code:'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
    assert.deepEqual(steps,['writer','accepted-read']);
  }else{
    assert.equal((await operation()).state,'completed');
    assert.deepEqual(steps,['writer','accepted-read','renew','start']);
  }
});

for(const state of ['confirmed','busy','changed','unfiltered','accepted','finish_pending','accepted_observation','accepted_observation_busy','accepted_observation_changed','accepted_observation_unfiltered','accepted_control','accepted_control_busy','accepted_control_changed','accepted_control_unfiltered','local','local_busy','local_changed','local_unfiltered'])test(`native Workspace recovery requires its own writer and restricted catalogue (${state})`,async()=>{
  const accepted=state==='accepted'||state.startsWith('accepted_observation')||state.startsWith('accepted_control');
  const local=state==='local'||state.startsWith('local_');
  const mode=state.replace(/^(?:accepted_(?:observation|control)|local)_/u,'');
  const {turn,...workspaceDraftRecovery}=state.startsWith('accepted_control')?acceptedControlHistory():state.startsWith('accepted_observation')?acceptedObservationHistory():state==='accepted'?acceptedHistory():state==='finish_pending'||local?pendingFinishHistory():draftHistory();
  const threadId=randomUUID(),deliveryId=randomUUID(),cwd=await fs.realpath(process.cwd()),steps=[];
  const pluginId='trelio-digital-assistant@trelio-digital-assistants';
  const tools=accepted?ASSISTANT_WORKSPACE_ACCEPTED_TOOLS:local?ASSISTANT_NAMED_ARCHIVE_RECOVERY_TOOLS:ASSISTANT_WORKSPACE_DRAFT_TOOLS;
  if(local){
    const {workspaceId,runId}=workspaceDraftRecovery.workspaceDraft;
    const {terminalMarkerId,taskPass}=workspaceDraftRecovery;
    const basis={workspaceId,runId,baseHead:'c'.repeat(40),anchorHead:'c'.repeat(40),checkpointId:null};
    turn.items.pop(); // No finish was invoked in this original turn.
    turn.items[0].content[0].text=assistantDeliveryMarker(terminalMarkerId)+'\nTRELIO_ASSISTANT_SCOPE '+JSON.stringify({
      companyId:taskContext.companyId,taskId:taskContext.taskId,scheduled:true,
    });
    const replacements=assistantInterruptedLocalDraft(turn,terminalMarkerId,taskPass,basis);
    assert.ok(replacements);
    workspaceDraftRecovery.workspaceDraft.localDraft={basis:{...basis,deltaSha256:'c'.repeat(64)},replacements};
  }
  let reads=0,starts=0;
  const operation=()=>runAssistantCodexPass({threadId,deliveryId,cwd,taskContext:local?{...taskContext,scheduled:true}:taskContext,execution},{
    executable:process.execPath,environment:{},workspaceDraftRecovery,requireAbsentMarker:true,
    continuationReview:{priorTurnId:workspaceDraftRecovery.terminalTurnId,reviewId:deliveryId},
    readMetadata:async()=>({threadId,cwd}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    readExecutionAvailability:async()=>true,beforeInvocation:async()=>{steps.push('renew');},startInvocation:()=>{starts++;},
    readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',receipt:'fixture:completed'},
    spawnProcess:ownedRpc({threadId,cwd,priorTurn:mode==='changed'?{...turn,id:randomUUID()}:turn,
      resumeError:mode==='busy'?{code:-32600,message:`thread ${threadId} already has an active writer`}:undefined,
      onRequest:request=>{
        if(request.method==='thread/resume'){
          steps.push('writer');
          assert.deepEqual(request.params.config.plugins[pluginId].mcp_servers['trelio-assistant'].enabled_tools,tools);
        }
        if(request.method==='thread/turns/list'&&request.params.limit===1)steps.push('draft');
      },
      executionPolicy:(request,policy)=>{
        if(request.method!=='mcpServerStatus/list'||mode==='unfiltered')return policy;
        policy.result.data[0].tools=Object.fromEntries(tools.map(name=>[name,{name}]));
        return policy;
      },
      onInput:text=>{
        if(accepted){
          assert.match(text,/Only confirm the result already accepted/u);
          assert.ok(text.includes(workspaceDraftRecovery.workspaceDraft.acceptedHead));
        }else if(state==='finish_pending'){
          assert.match(text,/First call continue_assistant_workspace_action/u);
          assert.match(text,/do not repeat any question, control change/u);
        }else if(local){
          assert.match(text,/Only save the verified local changes/u);
        }else{
          assert.match(text,/only to preserve its interrupted Workspace draft/u);
          assert.match(text,/Do not repeat the browser check/u);
        }
      },
    }),
  });
  if(['confirmed','accepted','finish_pending','accepted_observation','accepted_control','local'].includes(mode)){
    assert.equal((await operation()).state,'completed');
    assert.deepEqual(steps,['writer','draft','renew']);assert.equal(starts,1);
  }else{
    await assert.rejects(operation(),{code:mode==='busy'?'ASSISTANT_CODEX_THREAD_BUSY':
      mode==='unfiltered'?'ASSISTANT_CODEX_EXECUTION_POLICY_UNAVAILABLE':'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
    assert.equal(starts,0);assert.ok(!steps.includes('renew'));
  }
});

test('GUI stored history may say interrupted while its writer is active; retain one invocation until actual completion',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();let starts=0,queues=0,polls=0,reads=0,confirmed=0;
  const result=await runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},{
    executable:process.execPath,environment:{},openDesktop:async()=>{},passTimeoutMs:8000,
    readMetadata:async()=>({threadId,cwd:process.cwd()}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    readExecutionAvailability:async()=>true,startInvocation:()=>{starts++;},onAuthenticationConfirmed:()=>{confirmed++;},
    readDelivery:async()=>++reads===1?{state:'uncertain'}:{state:'completed',turnId,receipt:`codex:${threadId}:${turnId}`},
    spawnProcess:ownedRpc({threadId,snapshotStatuses:['interrupted','inProgress','completed'],onTurn:()=>{queues++;},
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
    spawnProcess:ownedRpc({threadId,snapshotStatuses:['interrupted'],onTurn:()=>{queues++;},
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
    openDesktop:async()=>{},startInvocation:()=>{starts++;},spawnProcess:ownedRpc({threadId,onTurn:()=>assert.fail('failed recovery queued work')})}),/closed native CAS conflict/);
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
    spawnProcess:ownedRpc({threadId})});
  assert.equal(result.state,'completed');assert.equal(reads,2);assert.equal(models,1);assert.equal(recoveries,1);assert.equal(starts,1);
});

test('reviewed continuation uses a NEW stdin marker in the same chat, with receipt inspection before any action',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),priorTurnId=randomUUID(),turnId=randomUUID();let input='',reads=0,starts=0,checked=false;
  const options={continuationReview:{priorTurnId,reviewId:deliveryId},requireAbsentMarker:true,
    executable:process.execPath,environment:{},readMetadata:async()=>({threadId,cwd:process.cwd()}),readHookReadiness:async()=>({fingerprint:"a".repeat(64)}),readExecutionAvailability:async()=>true,
    beforeInvocation:async()=>{checked=true;},startInvocation:()=>{assert.equal(checked,true);starts++;},
    readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',turnId,receipt:`codex:${threadId}:${turnId}`},
    openDesktop:async()=>{},spawnProcess:ownedRpc({threadId,onInput:text=>{input=text;}})};
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


test('foreign live writers, queued input and mismatched settings refuse before a native start',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID();let starts=0,turns=0;
  const options={executable:process.execPath,environment:{},readMetadata:async()=>({threadId,cwd:process.cwd()}),
    readDelivery:async()=>({state:'uncertain'}),readExecutionAvailability:async()=>true,readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    startInvocation:()=>{starts++;},openDesktop:()=>assert.fail('no Desktop fallback')};
  for(const pair of [{...execution,effortLevel:'ultra'},{...execution,modelId:'other'},{}])
    await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},
      {...options,spawnProcess:ownedRpc({threadId,pair,onTurn:()=>{turns++;}})}),/MODEL_UNAVAILABLE/);
  for(const extra of [{status:{type:'active'}},{status:{type:'idle'},canAcceptDirectInput:false},{status:{}},{queued:[{id:randomUUID()}]}])
    await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},
      {...options,spawnProcess:ownedRpc({threadId,...extra,onTurn:()=>{turns++;},onRequest:request=>{
        assert.notEqual(request.method,'thread/resume','a foreign or ambiguous writer cannot be taken over');}})}),/THREAD_BUSY/);
  assert.equal(starts,0);assert.equal(turns,0);
});

test('scoped overrides preserve disabled hooks and never copy user configuration values',()=>{
  const own='trelio-digital-assistant@trelio-digital-assistants';
  const hooks='trelio-digital-assistant-hooks@trelio-digital-assistants';
  const config={features:{hooks:true},plugins:{[own]:{enabled:true,config:'PRIVATE'},[hooks]:{enabled:false},
    'foreign@market':{enabled:true,config:'PRIVATE'}},mcp_servers:{'trelio-assistant':{command:'PRIVATE',enabled:true}}};
  const before=structuredClone(config);
  const overrides=assistantCodexExecutionOverrides(config);
  assert.equal(overrides.features.code_mode_only,false);
  assert.deepEqual(overrides.features.code_mode,{enabled:false,direct_only_tool_namespaces:['mcp__trelio_assistant']});
  assert.deepEqual(overrides.plugins,{[own]:{enabled:true},[hooks]:{enabled:false},'foreign@market':{enabled:false}});
  assert.deepEqual(overrides.mcp_servers,{'trelio-assistant':{enabled:false}});
  assert.deepEqual(config,before);
  assert.doesNotMatch(JSON.stringify(overrides),/PRIVATE/);
  for(const input of [undefined,null,{},[],{...config,plugins:{[own]:{enabled:false}}},{...config,mcp_servers:[]},
    {...config,mcp_servers:{foreign:null}}]){
    assert.throws(()=>assistantCodexExecutionOverrides(input),{code:'ASSISTANT_CODEX_EXECUTION_POLICY_UNAVAILABLE'});
  }
});

test('unverifiable native tool policy refuses before spending the pass invocation',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID();let starts=0,turns=0;
  const options={executable:process.execPath,environment:{},readMetadata:async()=>({threadId,cwd:process.cwd()}),
    readExecutionAvailability:async()=>true,readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    startInvocation:()=>{starts++;}};
  const cases=[
    ['experimentalFeature/list',result=>{result.data[0].enabled=true;}],
    ['experimentalFeature/list',result=>{result.data.pop();}],
    ['experimentalFeature/list',result=>{result.nextCursor='same-page';}],
    ['config/read',result=>{result.config.plugins={};}],
    ['mcpServerStatus/list',result=>{result.data[0].pluginId='foreign@market';}],
    ['mcpServerStatus/list',result=>{result.data[0].runtimeStatus='connecting';}],
    ['mcpServerStatus/list',result=>{delete result.data[0].tools.use_assistant_workspace_files;}],
    ['mcpServerStatus/list',result=>{result.nextCursor='incomplete';}],
    ['mcpServerStatus/list',result=>{result.data.push({name:'foreign',runtimeStatus:null,tools:{},toolsError:null});}],
    ['mcpServerStatus/list',result=>{result.data.push({name:'foreign',runtimeStatus:'disabled',tools:{cached:{}},toolsError:null});}],
  ];
  for(const [method,modify] of cases){
    const spawnProcess=ownedRpc({threadId,onTurn:()=>{turns++;},executionPolicy:(request,reply)=>{
      if(request.method===method)modify(reply.result);
      return reply;
    }});
    await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},
      {...options,spawnProcess}),{code:'ASSISTANT_CODEX_EXECUTION_POLICY_UNAVAILABLE'});
  }
  for(const [message,expected] of [[`thread ${threadId} already has an active writer`,'ASSISTANT_CODEX_THREAD_BUSY'],
    [`thread ${randomUUID()} already has an active writer`,'ASSISTANT_CODEX_DELIVERY_UNCERTAIN']]){
    await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},
      {...options,spawnProcess:ownedRpc({threadId,resumeError:{code:-32600,message},onTurn:()=>{turns++;}})}),{code:expected});
  }
  assert.equal(starts,0);assert.equal(turns,0);
});

test('one isolated writer runs both empty readiness turns and persists the UUID before either',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),children=[];let starts=0,saved=false,turns=0,bootstraps=0,names=0;
  const options={executable:process.execPath,environment:{},chatKind:'owner_dialogue',readExecutionAvailability:async()=>true,
    readHookReadiness:()=>assert.fail('empty READY never earns business authority'),
    startInvocation:()=>{starts++;},onThreadStarted:value=>{assert.equal(value,threadId);saved=true;},
    openDesktop:()=>assert.fail('the native GUI cannot replace this executor policy'),
    readDelivery:async()=>{assert.equal(turns,1);return {state:'completed',turnId:randomUUID(),receipt:'exact:owned:ready'};},
    spawnProcess:ownedRpc({threadId,children,onRequest:request=>{
      assert.notEqual(request.method,'thread/queue/add');
      if(request.method==='thread/name/set'){names++;assert.equal(turns,1);assert.ok(children[0].killed);}
    },onCreate:request=>{
      assert.equal(request.params.cwd,process.cwd());assert.equal(request.params.model,execution.modelId);
      assert.equal(request.params.ephemeral,false);assert.equal(request.params.allowProviderModelFallback,false);
      assert.equal(request.params.sandbox,'read-only');assert.equal(request.params.approvalPolicy,'never');
      assert.deepEqual(request.params.environments,[]);assert.deepEqual(request.params.selectedCapabilityRoots,[]);
      assert.equal(request.params.config.features.shell_tool,false);
      assert.deepEqual(request.params.config.features.code_mode,{enabled:false,direct_only_tool_namespaces:['mcp__trelio_assistant']});
      assert.equal(request.params.config.plugins['unrelated@fixture'].enabled,false);
    },onInput:(text,phase)=>{
      assert.ok(saved);assert.doesNotMatch(text,/TRELIO_ASSISTANT_SCOPE|WORK\.md/);
      if(phase==='bootstrap'){bootstraps++;assert.ok(text.startsWith(`TRELIO_ASSISTANT_DESKTOP_PREPARE ${deliveryId}\n`));}
      else assert.ok(text.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));
    },onTurn:()=>{turns++;}}),
  };
  assert.equal((await provisionAssistantCodexChat({deliveryId,cwd:process.cwd(),execution},options)).threadId,threadId);
  assert.equal(starts,1);assert.equal(bootstraps,1);assert.equal(turns,1);assert.equal(children.length,2);assert.equal(names,1);
  assert.ok(children.every(c=>c.killed));
});

test('lost owned turn response retains uncertainty without queue fallback or a second start',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),children=[];let turns=0,starts=0;
  const spawnProcess=ownedRpc({threadId,onTurn:()=>{turns++;},onRequest:request=>{
    if(request.method==='turn/start')throw Error('PRIVATE lost response');}});
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd:process.cwd(),taskContext,execution},{
    executable:process.execPath,environment:{},openDesktop:()=>assert.fail('no fallback'),
    readMetadata:async()=>({threadId,cwd:process.cwd()}),readDelivery:async()=>({state:'uncertain'}),
    readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),readExecutionAvailability:async()=>true,startInvocation:()=>{starts++;},
    spawnProcess:(...args)=>{const child=spawnProcess(...args);children.push(child);return child;},
  }),error=>error.code==='ASSISTANT_CODEX_DELIVERY_UNCERTAIN'&&!error.message.includes('PRIVATE'));
  assert.equal(turns,0);assert.equal(starts,1);assert.equal(children.length,1);assert.ok(children[0].killed);
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
  spawnProcess:ownedRpc({threadId,nameFailure:true,onCreate:()=>{creates++;},onTurn:()=>{queues++;},
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
    spawnProcess:ownedRpc({threadId,onCreate:()=>{creates++;},onTurn:()=>assert.fail('failed bootstrap cannot queue READY'),
      bootstrapError:{codexErrorInfo:'serverOverloaded',message:'PRIVATE error'}})}),{code:'ASSISTANT_CODEX_MODEL_CAPACITY'});
  const result=await provisionAssistantCodexChat({deliveryId:retry,threadId,cwd:process.cwd(),execution},{...common,
    onThreadStarted:()=>assert.fail('retry may not create another chat'),
    readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',turnId:randomUUID(),receipt:'ready'},
    spawnProcess:ownedRpc({threadId,onCreate:()=>assert.fail('no thread/start on retry'),onTurn:()=>{queues++;}})});
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
const cancelledSourceReadFixture=()=>{
 const f=readonlyPreparationFixture();
 const call=(tool,args,code)=>({type:'mcpToolCall',server:'trelio-assistant',tool,status:code?'failed':'completed',arguments:args,
  result:code?{structuredContent:{code},content:[{type:'text',text:code}]}:{content:[]}});
 const scoped={intakePass:f.intakePass,runtimeSessionProof:{}};
 f.turn.items=[f.turn.items[0],call('get_assistant_intake_context',scoped),
  call('get_assistant_intake_context',scoped,'ASSISTANT_SOURCE_DEADLINE'),
  call('list_assistant_skills',{companyId:f.intakePass.companyId,projectId:null,skillId:null,limit:50,offset:0},'ASSISTANT_LOCAL_SETUP_TASK_ACTIVE'),
  call('search_agent_guidance',{companySlug:'synthetic',query:'SYNTHETIC_ASR_QUERY',hints:[],limit:5},'ASSISTANT_CAPABILITY_UNAVAILABLE'),
  {...call('get_assistant_intake_context',{}),status:'failed'},
  call('resolve_assistant_intake',{clientRequestId:f.intakePass.intakeId,decision:'reply_owner',replyText:'SYNTHETIC_REPLY'},
   'ASSISTANT_MCP_LOCAL_WORKSPACE_ARGUMENTS_TRELIO_BACKEND_HTTP_409')];
 return f;
};
test('cancelled source-read certificate is separate from file, legacy and successful business turns',async()=>{
 const f=cancelledSourceReadFixture();
 assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,cancelledSourceRead:true}),true);
 for(const options of [{},{cancelledContextRead:true},{readOnlyContinuation:true},
  {cancelledSourceRead:false},{cancelledSourceRead:true,cancelledContextRead:true},
  {cancelledSourceRead:true,replyDispatchCorrection:true},{cancelledSourceRead:true,technicalReplyCorrection:{}}])
  assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,...options}),false);
});
test('cancelled source-read certificate refuses provider attempts, foreign reads, extra actions and unknown reply results',async()=>{
 const changes=[t=>{t.status='failed';},t=>{t.error={code:'OTHER'};},t=>{t.items.push(structuredClone(t.items[0]));},
  t=>{t.items[1].arguments.intakePass={...t.items[1].arguments.intakePass,intakeId:randomUUID()};},
  t=>{t.items[2].result.structuredContent.code='ASSISTANT_INTAKE_CHANGED';},
  t=>{t.items[2].status='completed';},t=>{t.items[3].status='completed';},
  t=>{t.items[3].arguments.companyId=randomUUID();},t=>{t.items[3].arguments.skillId='other';},
  t=>{t.items[4].result.structuredContent.code='ASSISTANT_SOURCE_UNAVAILABLE';},
  t=>{t.items[5].status='completed';},t=>{t.items[5].arguments={arbitrary:true};},
  t=>{t.items.at(-1).status='completed';},t=>{t.items.at(-1).result.isError=false;},
  t=>{t.items.at(-1).result.structuredContent.code='ASSISTANT_INTAKE_CHANGED';},
  t=>{t.items.at(-1).arguments.clientRequestId=randomUUID();},
  t=>{t.items.at(-1).arguments.replyFile={workspaceId:randomUUID()};},
  t=>{t.items.at(-1).arguments.decision='create_task';},t=>{t.items.at(-1).arguments.replyText='x'.repeat(4097);},
  t=>{t.items.splice(-1,0,{type:'mcpToolCall',server:'trelio-assistant',tool:'continue_assistant_workspace_action',status:'failed',arguments:{},result:{}});},
  t=>{t.items.splice(2,0,{type:'commandExecution',status:'completed',exitCode:0,command:'provider start',commandActions:[]});},
  t=>{t.items.splice(2,0,{type:'unknown'});},t=>{t.items.pop();},t=>{t.items.push(structuredClone(t.items.at(-1)));}];
 for(const change of changes){const f=cancelledSourceReadFixture();change(f.turn);
  assert.equal(await assistantReadOnlyPreparationFailure(f.turn,{...f,cancelledSourceRead:true}),false,String(change));}
});
test('native cancelled-source reader requires its independent selector and complete unique history',async()=>{
 const f=cancelledSourceReadFixture();
 const read=(options={},pages=()=>({data:[f.turn],nextCursor:null}))=>readAssistantCodexDelivery(f.threadId,f.deliveryId,{
  executable:process.execPath,environment:f.environment,readOnlyPreparation:f.intakePass,...options,
  spawnProcess:nativeRpc(request=>{
   if(request.method==='thread/read')return {result:{thread:{id:f.threadId,cwd:process.cwd()}}};
   assert.equal(request.method,'thread/turns/list');assert.equal(request.params.itemsView,'full');return {result:pages(request.params)};
  })});
 const witness=await read({cancelledSourceRead:true});
 assert.equal(witness.readOnlyFailure,'owner_source_read_deadline_cancelled');assert.equal(witness.turnId,f.turn.id);
 assert.equal(JSON.stringify(witness).includes('SYNTHETIC_REPLY'),false,'only the closed structural witness leaves the native reader');
 assert.deepEqual(await read({cancelledContextRead:true}),{state:'uncertain'},'a file-only backend cannot admit a source deadline');
 assert.equal((await read({cancelledContextRead:true,cancelledSourceRead:true})).readOnlyFailure,witness.readOnlyFailure);
 for(const options of [{cancelledSourceRead:false},{cancelledSourceRead:true,readOnlyContinuation:true},
  {cancelledSourceRead:true,replyDispatchCorrection:true}])assert.deepEqual(await read(options),{state:'uncertain'});
 assert.deepEqual(await read({cancelledSourceRead:true},()=>({data:[f.turn,f.turn],nextCursor:null})),{state:'uncertain'});
 assert.deepEqual(await read({cancelledSourceRead:true},()=>({data:[f.turn],nextCursor:'same'})),{state:'uncertain'},'incomplete/repeated pages never certify a prefix');
});
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
  openDesktop:async()=>{},spawnProcess:ownedRpc({threadId,cwd,onInput:text=>{input=text;}})});
 assert.equal(starts,1);assert.ok(input.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));
 const scope=input.split('\n').find(line=>line.startsWith('TRELIO_ASSISTANT_INTAKE '));
 assert.deepEqual(JSON.parse(scope.slice('TRELIO_ASSISTANT_INTAKE '.length)),{kind:'source_intake',...intakeContext});
 assert.match(input,/Only reply_owner is permitted/);
 assert.match(input,/already available external sources/);
 assert.match(input,/Use use_assistant_browser for ordinary site work that needs no specialized capability or existing skill session/u);
 assert.match(input,/explicitly supported fallback admitted for this assistant/u);
 assert.match(input,/Source intake stays read-only/u);
 assert.match(input,/Do not use ordinary Chrome, native computer tools or a shell\/browser script as a silent fallback/u);
 assert.match(input,/closes idle windows after ten minutes/u);
 assert.match(input,/A personal question does not require a task or Workspace Run/);
 assert.match(input,/route_existing with taskId for ONE already accepted assignment/);
 assert.match(input,/explicit owner request for a separate card/);
 assert.match(input,/Missing assignment or access needs ask_owner, never a new workaround card/);
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
  openDesktop:async()=>{},spawnProcess:ownedRpc({threadId,cwd,onInput:text=>{input=text;}})});
 assert.equal(starts,1);assert.match(input,/restricted source_triage\/v1/u);
 assert.doesNotMatch(input,/use_assistant_browser|native app\/computer interface/u);
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

test('unmaterialized triage probe observes only two exact native refusals',async()=>{
  const threadId=randomUUID();
  for(const mode of ['unmaterialized','indexed','wrong_uuid','generic_failure']){
    const methods=[];
    const options={executable:process.execPath,environment:{},spawnProcess:nativeRpc(request=>{
      methods.push(request.method);
      assert.equal(request.params.threadId,threadId);
      if(request.method==='thread/turns/list'&&mode==='indexed')return {result:{data:[],nextCursor:null}};
      return {error:{code:mode==='generic_failure'?-32000:-32600,
        message:'thread not loaded: '+(mode==='wrong_uuid'?randomUUID():threadId)}};
    })};
    if(mode==='wrong_uuid'||mode==='generic_failure'){
      await assert.rejects(readAssistantUnmaterializedTriage(threadId,options),/READ_UNAVAILABLE/);
      assert.deepEqual(methods,['thread/read']);
    }else{
      assert.equal(await readAssistantUnmaterializedTriage(threadId,options),mode==='unmaterialized');
      assert.deepEqual(methods,['thread/read','thread/turns/list']);
    }
  }
});

for(const chatKind of ['source_triage','task'])test(`${chatKind} waits for the same scoped native server before either readiness turn`,async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),children=[];
  let catalogueReads=0,starts=0,turns=0,inputs=0,saved=false;
  const result=await provisionAssistantCodexChat({deliveryId,cwd:process.cwd(),execution},{
    executable:process.execPath,environment:{},chatKind,
    readExecutionAvailability:async()=>true,
    startInvocation:()=>{starts++;},
    onThreadStarted:value=>{assert.equal(value,threadId);saved=true;},
    readDelivery:async()=>({state:'completed',turnId:randomUUID(),receipt:'fixture:complete'}),
    spawnProcess:ownedRpc({threadId,children,onInput:()=>{assert.equal(catalogueReads,3);assert.ok(saved);inputs++;},
      onTurn:()=>{turns++;},
      executionPolicy:(request,reply)=>{
        if(request.method==='mcpServerStatus/list'){
          assert.equal(request.params.threadId,threadId);
          assert.equal(turns,0);assert.ok(saved);
          const server=reply.result.data[0];
          server.runtimeStatus=['notStarted','starting','connected'][catalogueReads++];
          if(server.runtimeStatus==='notStarted')server.tools={};
        }
        return reply;
      }}),
  });
  assert.equal(result.state,'completed');assert.equal(starts,1);assert.equal(turns,1);
  assert.equal(inputs,2);
  assert.equal(catalogueReads,3,'the cached result earns no readiness');
  assert.equal(children.length,2,'one owned writer plus the separate cosmetic naming client');
});

for(const kind of ['task','discussion','owner'])test(`resumed ${kind} waits for its own pending native connection before renewal and start`,async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),cwd=await fs.realpath(process.cwd()),children=[];
  const scope=kind==='owner'?{intakeContext:{assistantId:randomUUID(),companyId:randomUUID(),sourceId:randomUUID(),
    sourceRevision:1,intakeId:randomUUID(),eventId:randomUUID()}}
    :{taskContext:{...taskContext,...(kind==='discussion'?{workMode:'discussion'}:{scheduled:true})}};
  let reads=0,renewals=0,starts=0,turns=0;
  const result=await runAssistantCodexPass({threadId,deliveryId,cwd,execution,...scope},{
    executable:process.execPath,environment:{},readExecutionAvailability:async()=>true,
    readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),readMetadata:async()=>({threadId,cwd}),
    beforeInvocation:async()=>{assert.equal(reads,4);renewals++;},
    startInvocation:()=>{assert.equal(reads,4);assert.equal(renewals,1);starts++;},
    spawnProcess:ownedRpc({threadId,cwd,children,onTurn:()=>{assert.equal(reads,4);turns++;},
      executionPolicy:(request,reply)=>{
        if(request.method==='mcpServerStatus/list'){
          assert.equal(request.params.threadId,threadId);assert.equal(starts,0);assert.equal(renewals,0);
          const server=reply.result.data[0];
          server.runtimeStatus=[null,'notStarted','starting','connected'][reads++];
          if(reads===1)server.tools={};
        }
        return reply;
      }}),
  });
  assert.equal(result.state,'completed');assert.equal(starts,1);assert.equal(turns,1);
  assert.equal(reads,4);assert.ok(children.every(child=>child.killed));
});

for(const refusal of ['foreign','error','incomplete','cancel','deadline'])test(`resumed pending connection preserves ${refusal} refusal without an invocation`,async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),cwd=await fs.realpath(process.cwd()),children=[];
  const controller=new AbortController();let reads=0;
  const options={executable:process.execPath,environment:{},signal:controller.signal,
    ...(refusal==='deadline'?{passTimeoutMs:100}:{}),
    readExecutionAvailability:async()=>true,readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    readMetadata:async()=>({threadId,cwd}),
    beforeInvocation:()=>assert.fail('pending/refused tools cannot renew a retained pass'),
    startInvocation:()=>assert.fail('pending/refused tools cannot spend the start bit'),
    spawnProcess:ownedRpc({threadId,cwd,children,onTurn:()=>assert.fail('no model input'),
      executionPolicy:(request,reply)=>{
        if(request.method==='mcpServerStatus/list'){
          reads++;const server=reply.result.data[0];
          if(reads===1){
            server.runtimeStatus='starting';server.tools={};
            if(refusal==='cancel')queueMicrotask(()=>controller.abort());
          }else if(refusal==='foreign')server.pluginId='foreign@market';
          else if(refusal==='error')server.toolsError='SYNTHETIC PRIVATE ERROR';
          else if(refusal==='incomplete')reply.result.nextCursor='unread';
        }
        return reply;
      }}),
  };
  await assert.rejects(runAssistantCodexPass({threadId,deliveryId,cwd,taskContext,execution},options),
    {code:['cancel','deadline'].includes(refusal)?'ASSISTANT_CODEX_DELIVERY_UNCERTAIN':'ASSISTANT_CODEX_EXECUTION_POLICY_UNAVAILABLE'});
  assert.equal(reads,['cancel','deadline'].includes(refusal)?1:2);
  assert.ok(children.every(child=>child.killed),'cancel/deadline closes only its own reader');
});

test('task provision recovery sends one new technical marker and requires the complete tool-free READY history',async()=>{
  const threadId=randomUUID(),deliveryId=randomUUID(),children=[],inputs=[];
  let prepared=false,started=false,saved=false;
  const state=await provisionAssistantCodexChat({deliveryId,cwd:process.cwd(),execution},{
    executable:process.execPath,environment:{},chatKind:'task',taskProvisionRecovery:true,
    beforeInvocation:async()=>{assert.equal(started,false);prepared=true;},
    readExecutionAvailability:async()=>true,
    startInvocation:()=>{assert.ok(prepared);started=true;},
    onThreadStarted:value=>{assert.equal(value,threadId);assert.ok(started);saved=true;},
    readDelivery:async(_thread,_delivery,options)=>{
      assert.equal(options.taskProvisionRecovery,true);
      return {state:'completed',threadId,turnId:randomUUID()};
    },
    spawnProcess:ownedRpc({threadId,children,onInput:text=>{assert.ok(saved);inputs.push(text);}}),
  });
  assert.equal(state.state,'completed');
  assert.equal(inputs.length,1);assert.match(inputs[0],new RegExp('^'+assistantDeliveryMarker(deliveryId)));
  assert.equal(children.filter(child=>child.killed).length,2);
  const turn={id:randomUUID(),status:'completed',items:[{type:'userMessage',content:[{type:'text',text:inputs[0]}]},
    {type:'reasoning'},{type:'agentMessage',text:'READY'}]};
  for(const [turns,nextCursor,expected] of [
    [[turn],null,'completed'],[[turn],'unread','uncertain'],
    [[turn,{id:randomUUID(),status:'completed',items:[]}],null,'uncertain'],
    [[{...turn,items:[turn.items[0],{type:'mcpToolCall'},turn.items[2]]}],null,'uncertain'],
  ]){
    const result=await readAssistantCodexDelivery(threadId,deliveryId,{executable:process.execPath,environment:{},
      taskProvisionRecovery:true,spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'
        ?{thread:{id:threadId,cwd:process.cwd()}}:{data:turns,nextCursor}}))});
    assert.equal(result.state,expected);
  }
});

test('rejected triage ignore is proven by the exact full terminal turn and typed refusal only', async () => {
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID(),runtimeSessionId=randomUUID();
  const intakePass={companyId:randomUUID(),sourceId:randomUUID(),intakeId:randomUUID()},eventIds=[randomUUID(),randomUUID()];
  const code='ASSISTANT_INTAKE_INPUT_INVALID';
  const native={server:'trelio-assistant',type:'mcpToolCall'};
  const context={...native,tool:'get_assistant_intake_context',status:'completed',
    arguments:{intakePass,runtimeSessionProof:{runtimeSessionId}},result:{content:[{type:'text',text:'SYNTHETIC_READ'}]}};
  const resolve={...native,tool:'resolve_assistant_intake',status:'failed',arguments:{clientRequestId:intakePass.intakeId,
    decision:'ignore',ignoredEventIds:[...eventIds].reverse(),intakePass,runtimeSessionProof:{runtimeSessionId}},
    result:{structuredContent:{code,retryable:false},content:[{type:'text',text:code}]}};
  const original={type:'userMessage',content:[{type:'text',text:`${assistantDeliveryMarker(deliveryId)}\nSYNTHETIC`} ]};
  const turn={id:turnId,status:'completed',items:[original,context,{type:'reasoning'},resolve,{type:'agentMessage'}]};
  const read=(data,nextCursor=null)=>readAssistantRejectedTriageIgnore(threadId,deliveryId,intakePass,eventIds,{
    executable:process.execPath,environment:{},spawnProcess:nativeRpc(request=>({result:request.method==='thread/read'
      ?{thread:{id:threadId,cwd:process.cwd()}}:{data,nextCursor}}))});
  assert.deepEqual(await read([turn]),{terminalTurnId:turnId});
  assert.equal(await read([turn],'unread'),null);
  assert.equal(await read([{id:randomUUID(),status:'completed',items:[]},turn]),null);
  for(const changed of [
    {...turn,status:'interrupted'},
    {...turn,items:[...turn.items,context]},
    {...turn,items:[original,{...context,status:'failed'},resolve]},
    ...[{ignoredEventIds:[eventIds[0]]},{ignoredEventIds:[eventIds[0],eventIds[0]]},{ignoredEventIds:[eventIds[0],randomUUID()]},
      {unsubscribeEventIds:[eventIds[0]]},{decision:'ask_owner'},{runtimeSessionProof:{runtimeSessionId:randomUUID()}}]
      .map(args=>({...turn,items:[original,context,{...resolve,arguments:{...resolve.arguments,...args}}]})),
    {...turn,items:[original,context,{...resolve,result:{...resolve.result,structuredContent:{code,retryable:true}}}]},
  ])assert.equal(await read([changed]),null);
});

const interruptedTaskReadHistory=()=>{
  const taskPass={companyId:taskContext.companyId,taskId:taskContext.taskId,passId:randomUUID()};
  const terminalMarkerId=randomUUID(),terminalTurnId=randomUUID(),parentTurnId=randomUUID(),parentMarkerId=randomUUID();
  const proof={taskPass,runtimeSessionProof:{synthetic:true}};
  const catalogue='b'.repeat(64);
  const read=(tool,args,value,{text=false}={})=>({type:'mcpToolCall',server:'trelio-assistant',tool,status:'completed',arguments:args,
    result:text?{content:[{type:'text',text:JSON.stringify(value)}]}:{structuredContent:value}});
  const scope=assistantWorkStateContext(taskContext);
  const turn={id:terminalTurnId,status:'interrupted',items:[
    {type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(terminalMarkerId)+'\nTRELIO_ASSISTANT_SCOPE '+JSON.stringify(scope)
      +'\nThis is ONE automatic recovery continuation after terminal turn '+parentTurnId+', with invocation marker '+terminalMarkerId+'. '} ]},
    read('get_assistant_status',{view:'task'},{schemaVersion:1,assistantUserId:taskContext.assistantId}),
    read('get_task',proof,{effectiveInstructions:{schemaVersion:3,status:'incomplete',delivery:{catalogRevisionKey:catalogue}},
      tasks:[{task:{id:taskContext.taskId}}]},{text:true}),
    read('get_task_instruction_page',{...proof,pageIndex:0,pageSize:4,expectedCatalogRevisionKey:catalogue},
      {schemaVersion:3,responseKind:'instruction_page_batch',pageIndex:0,nextPageIndex:null,catalogRevisionKey:catalogue},{text:true}),
    {type:'reasoning'},
    read('get_assistant_operation_contract',proof,{schemaVersion:1,operations:{}}),
  ]};
  const parent={id:parentTurnId,status:'completed',items:[{type:'userMessage',content:[{type:'text',text:assistantDeliveryMarker(parentMarkerId)+'\noriginal'}]}]};
  return {turn,parent,taskPass,terminalMarkerId,terminalTurnId,parentTurnId,parentMarkerId};
};

test('only exact full native read-only continuation qualifies as an interrupted task read',()=>{
  const {turn,taskPass,terminalMarkerId,parentTurnId}=interruptedTaskReadHistory();
  const witness={taskPass,parentTurnId,assistantId:taskContext.assistantId};
  assert.equal(assistantInterruptedTaskRead(turn,terminalMarkerId,witness),true);
  for(const change of [
    value=>{value.status='inProgress';},value=>{value.error={code:'unknown'};},
    value=>{value.items[0].content[0].text+='\nother';value.items[0].content.push({type:'text',text:'extra user input'});},
    value=>{value.items[2].status='inProgress';},value=>{value.items[2].arguments.taskPass={...taskPass,passId:randomUUID()};},
    value=>{value.items[3].arguments.pageIndex=8;},value=>{value.items[3].result.content[0].text='{invalid';},
    value=>{value.items[5].tool='execute_assistant_operation';},value=>{value.items.push({type:'commandExecution'});},
    value=>{value.items.push({type:'userMessage'});},
  ]){
    const invalid=structuredClone(turn);change(invalid);
    assert.equal(assistantInterruptedTaskRead(invalid,terminalMarkerId,witness),false);
  }
  assert.equal(assistantInterruptedTaskRead(turn,randomUUID(),witness),false);
  assert.equal(assistantInterruptedTaskRead(turn,terminalMarkerId,{...witness,parentTurnId:randomUUID()}),false);
});

for(const variant of ['exact','busy','changed-parent','newer-turn','pending'])test(`read-only continuation rechecks both turns under its own native writer (${variant})`,async()=>{
  const {turn,parent,...taskReadRecovery}=interruptedTaskReadHistory();
  const threadId=randomUUID(),deliveryId=randomUUID(),cwd=await fs.realpath(process.cwd()),steps=[];
  const priorTurn=[turn,parent];
  if(variant==='changed-parent')parent.id=randomUUID();
  if(variant==='newer-turn')priorTurn.unshift({id:randomUUID(),status:'completed',items:[]});
  if(variant==='pending')turn.items[3].status='inProgress';
  let reads=0,starts=0;
  const attempt=()=>runAssistantCodexPass({threadId,deliveryId,cwd,taskContext,execution},{
    executable:process.execPath,environment:{},taskReadRecovery,requireAbsentMarker:true,
    continuationReview:{priorTurnId:taskReadRecovery.terminalTurnId,reviewId:deliveryId},
    readMetadata:async()=>({threadId,cwd}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
    readExecutionAvailability:async()=>true,
    beforeInvocation:async()=>{steps.push('renew');},
    startInvocation:()=>{starts++;},
    readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',receipt:'fixture:completed'},
    spawnProcess:ownedRpc({threadId,cwd,priorTurn,
      resumeError:variant==='busy'?{code:-32600,message:`thread ${threadId} already has an active writer`}:undefined,
      onRequest:req=>{
        if(req.method==='thread/resume')steps.push('writer');
        if(req.method==='thread/turns/list'&&req.params.limit===2)steps.push('readboth');
      },
    }),
  });
  if(variant==='exact'){
    assert.equal((await attempt()).state,'completed');
    assert.deepEqual(steps,['writer','readboth','renew']);assert.equal(starts,1);
  }else{
    await assert.rejects(attempt(),{code:variant==='busy'?'ASSISTANT_CODEX_THREAD_BUSY':'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
    assert.equal(starts,0);assert.ok(!steps.includes('renew'));
  }
});

for(const variant of ['exact','inline-authority','cached-authority','newer-turn','incomplete-authority','provider-command','owner-input','changed-prompt','busy'])
  test('scheduled original is checked under its own writer before the one renewal ('+variant+')',async()=>{
    const {turn,taskPass,terminalMarkerId,terminalTurnId}=interruptedTaskReadHistory();
    const threadId=randomUUID(),deliveryId=randomUUID(),cwd=await fs.realpath(process.cwd());
    const scheduledContext={...taskContext,scheduled:true};
    const witness={taskPass,initialScheduled:true,assistantId:taskContext.assistantId};
    const scope=assistantWorkStateContext(variant==='owner-input'?{...scheduledContext,ownerQuestionIds:[randomUUID()]}:scheduledContext);
    turn.items[0].content[0].text=assistantNativePrompt(terminalMarkerId,scope,{});
    if(variant==='changed-prompt')turn.items[0].content[0].text+='extra instructions';
    if(variant==='incomplete-authority')turn.items.splice(3,1);
    if(variant==='inline-authority'||variant==='cached-authority'){
      const payload=JSON.parse(turn.items[2].result.content[0].text);
      payload.effectiveInstructions={schemaVersion:3,status:'loaded',
        layers:[{key:'layer',markdown:'Pinned rules fixture'}],
        reusedLayerKeys:variant==='cached-authority'?['another-layer']:[]};
      payload.tasks[0].instructionScope={status:'loaded',orderedLayerKeys:['layer']};
      turn.items[2].result.content[0].text=JSON.stringify(payload);
      turn.items.splice(3,1);
    }
    if(variant==='provider-command')turn.items[5].tool='continue_assistant_workspace_action';
    const changed=['cached-authority','incomplete-authority','provider-command','owner-input','changed-prompt'].includes(variant);
    assert.equal(assistantInterruptedTaskRead(turn,terminalMarkerId,witness),!changed);
    const priorTurn=variant==='newer-turn'?[{id:randomUUID(),status:'completed',items:[]}]:[turn];
    const steps=[];
    let reads=0,starts=0;
    const attempt=()=>runAssistantCodexPass({threadId,deliveryId,cwd,taskContext:scheduledContext,execution},{
      executable:process.execPath,environment:{},requireAbsentMarker:true,
      taskReadRecovery:{taskPass,initialScheduled:true,terminalMarkerId,terminalTurnId},
      continuationReview:{priorTurnId:terminalTurnId,reviewId:deliveryId},
      readMetadata:async()=>({threadId,cwd}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
      readExecutionAvailability:async()=>true,beforeInvocation:async()=>{steps.push('renew');},
      startInvocation:()=>{starts++;},
      readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',receipt:'fixture:completed'},
      spawnProcess:ownedRpc({threadId,cwd,priorTurn,
        resumeError:variant==='busy'?{code:-32600,message:'thread '+threadId+' already has an active writer'}:undefined,
        onRequest:req=>{
          if(req.method==='thread/resume')steps.push('writer');
          if(req.method==='thread/turns/list'&&req.params.limit===1)steps.push('readlatest');
        },
      }),
    });
    if(variant==='exact'||variant==='inline-authority'){
      assert.equal((await attempt()).state,'completed');
      assert.deepEqual(steps,['writer','readlatest','renew']);assert.equal(starts,1);
    }else{
      await assert.rejects(attempt(),{code:variant==='busy'?'ASSISTANT_CODEX_THREAD_BUSY':'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
      assert.equal(starts,0);assert.ok(!steps.includes('renew'));
    }
  });

test('an interrupted technical prelude matches the original native Run and historical release under the same writer',async()=>{
  const {turn,taskPass,terminalMarkerId,terminalTurnId}=interruptedTaskReadHistory();
  const task={...taskContext,scheduled:true};
  const run={workspaceId:randomUUID(),runId:randomUUID()};
  const selection={skillId:'telegram-mtproto',releaseId:randomUUID(),projectId:randomUUID()};
  const proof={taskPass,runtimeSessionProof:{synthetic:true}};
  const known={taskPass,assistantId:task.assistantId,initialScheduled:true};
  const complete=(tool,args,structuredContent)=>({type:'mcpToolCall',server:'trelio-assistant',tool,status:'completed',
    arguments:args,result:{structuredContent}});
  const refuse=(item,code)=>({...item,status:'failed',result:{structuredContent:{code}}});
  const local=(operation,parameters,output)=>complete('continue_assistant_workspace_action',
    {...proof,operation,schemaVersion:1,parameters},output);
  const provider=(args,stdout,more={})=>local('skill_run',
    {...selection,companyId:task.companyId,runtimeSessionId:randomUUID(),arguments:args,...more},
    {schemaVersion:1,operation:'skill_run',stdout:JSON.stringify(stdout)});
  const doctor={ok:true,runtimeReady:true,appCredentialsBundled:true,appCredentialBoundary:'signed-runtime-package',
    appCredentialsUserConfigRequired:false,legacyApiHashCacheRemoved:false,sessionPresent:true,
    policy:{},localRoot:'synthetic',securityBoundary:'chat-only'};
  const guide='fixture instruction';
  turn.items[0].content[0].text=assistantNativePrompt(terminalMarkerId,assistantWorkStateContext(task),{});
  turn.items.push(
    complete('get_agent_skill',{...proof,skillId:selection.skillId},{schemaVersion:1}),
    complete('prepare_assistant_workspace_run',{...proof,clientRequestId:randomUUID()},
      {prepared:true,workspace:{id:run.workspaceId,scopeType:'task',taskId:task.taskId,companyId:task.companyId},
        run:{id:run.runId},bridge:{actions:{open:{arguments:{parameters:run}}}}}),
    refuse(local('open',run,{}),'TRELIO_WORKSPACE_DIRECTORY_REQUIRED'),
    provider(['account','list'],{ok:true,accounts:[],revision:4}),
    provider(['guides'],{schemaVersion:1,part:0,count:1,path:'instruction-guides/part-01.md',
      sha256:createHash('sha256').update(guide).digest('hex'),text:guide,nextGuidePart:null}),
    provider(['doctor','--local-account',randomUUID()],doctor),
  );
  const expected={kind:'local_skill_diagnostics_v1',...run,...selection};
  assert.deepEqual(assistantInterruptedTechnicalPrelude(turn,terminalMarkerId,known),expected);
  for(const mutate of [
    value=>{value.items.at(-1).arguments.parameters.arguments[0]='send';},
    value=>{value.items.at(-1).arguments.parameters.arguments.push('--unknown');},
    value=>{value.items.at(-1).arguments.parameters.releaseId=randomUUID();},
    value=>{value.items.at(-1).status='inProgress';},
    value=>{value.items.at(-1).result.structuredContent={operation:'skill_run',schemaVersion:1,stdout:'{}'};},
    value=>{value.items.at(-2).arguments.parameters.guidePart=1;},
    value=>{value.items.at(-4).arguments.parameters.runId=randomUUID();},
    value=>{value.items.at(-4).result.structuredContent.code='ASSISTANT_WORKSPACE_OUTCOME_REVIEW_REQUIRED';},
    value=>{value.items.push(complete('create_comment',proof,{}));},
    value=>{value.items.push({type:'commandExecution',status:'completed'});},
    value=>{value.items.splice(3,1);},
  ]){
    const changed=structuredClone(turn);mutate(changed);
    assert.equal(assistantInterruptedTechnicalPrelude(changed,terminalMarkerId,known),null);
  }
  const cwd=await fs.realpath(process.cwd()),threadId=randomUUID(),deliveryId=randomUUID();
  for(const stale of [false,true]){
    const steps=[];
    let reads=0,starts=0;
    const attempt=runAssistantCodexPass({threadId,deliveryId,cwd,taskContext:task,execution},{
      executable:process.execPath,environment:{},requireAbsentMarker:true,
      taskReadRecovery:{taskPass,initialScheduled:true,terminalMarkerId,terminalTurnId,
        technicalPrelude:stale?{...expected,releaseId:randomUUID()}:expected},
      continuationReview:{priorTurnId:terminalTurnId,reviewId:deliveryId},
      readMetadata:async()=>({threadId,cwd}),readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
      readExecutionAvailability:async()=>true,beforeInvocation:async()=>{steps.push('renew');},
      startInvocation:()=>{starts++;},
      readDelivery:async()=>++reads===1?{state:'uncertain',markerEvidence:'absent'}:{state:'completed',receipt:'fixture:completed'},
      spawnProcess:ownedRpc({threadId,cwd,priorTurn:[turn],onRequest:req=>{
        if(req.method==='thread/resume')steps.push('writer');
        if(req.method==='thread/turns/list'&&req.params.limit===1)steps.push('readlatest');
      }}),
    });
    if(stale){
      await assert.rejects(attempt,{code:'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
      assert.equal(starts,0);assert.deepEqual(steps,['writer','readlatest']);
    }else{
      assert.equal((await attempt).state,'completed');
      assert.equal(starts,1);assert.deepEqual(steps,['writer','readlatest','renew']);
    }
  }
});
