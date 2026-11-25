import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { assistantCodexExecutionArguments } from '../../host-runtime/scripts/trelio-assistant-codex.mjs';

const execution = {modelId:'gpt-6.1-sol',effortLevel:'high',revision:1};

export function fakeChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.killed = false; child.kill = () => { child.killed = true; return true; }; return child;
}

export const nativeRpc = (handler, executionPolicy=()=>null) => (_executable, args, options) => {
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
export const ownedRpc = ({threadId,cwd=process.cwd(),onInput=()=>{},onCreate=()=>{},onTurn=()=>{},
  onRequest=()=>{},nameFailure=false,pair=execution,queued=[],terminal=true,children=[],snapshotStatuses=[],bootstrapError=null,
  status={type:'notLoaded'},canAcceptDirectInput=null,executionPolicy,resumeError,priorTurn,storedHistory=[],onHistoryRead,terminalId,storedId}={}) => {
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
      assert.equal(request.params.model,pair.modelId);assert.equal(request.params.effort,pair.effortLevel);
      assert.equal(request.params.collaborationMode.settings.reasoning_effort,pair.effortLevel);
      input=request.params.input[0].text;turnId=randomUUID();
      phase=input.startsWith('TRELIO_ASSISTANT_DESKTOP_PREPARE ')?'bootstrap':'controlled';
      if(phase==='controlled')onTurn(request);onInput(input,phase);
      const failed=phase==='bootstrap'&&bootstrapError;
      return {result:{turn:{id:turnId}},notifications:terminal?[{method:'turn/completed',params:{threadId,
        turn:{id:terminalId??turnId,status:failed?'failed':'completed',...(failed?{error:bootstrapError}:{})}}}]:[]};
    }
    if(request.method==='thread/queue/list')return {result:{data:queued,nextCursor:null}};
    assert.equal(request.method,'thread/turns/list');
    if(phase==='read'&&onHistoryRead)return onHistoryRead(request.params);
    if(phase==='read'&&priorTurn)return {result:{data:Array.isArray(priorTurn)?priorTurn:[priorTurn],nextCursor:'older'}};
    const current=phase==='controlled'&&snapshotStatuses.length?snapshotStatuses[Math.min(snapshot++,snapshotStatuses.length-1)]:'completed';
    const turns=terminal?[{id:storedId??turnId,status:current,items:[{type:'userMessage',content:[{type:'text',text:input}]},{type:'agentMessage',text:'READY'}]},...storedHistory]:[];
    return {result:{data:turns.slice(0,request.params.limit),nextCursor:turns.length>request.params.limit?'older':null}};
  },executionPolicy);
  return (...args)=>{const child=rpc(...args);children.push(child);return child;};
};
