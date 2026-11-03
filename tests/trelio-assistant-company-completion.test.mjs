import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {createForwardingAssistantMcp,createAssistantWorkspaceExecutor,requestCurrentAssistantRuntime,
  runAssistantSetupMcp} from '../host-runtime/scripts/trelio-assistant-entry.mjs';

const pendingSearchFixture=async(t,handlers={},nativeTool='search')=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-pending-search-'));
  await fs.mkdir(path.join(root,'digital-assistants'));await fs.writeFile(path.join(root,'digital-assistants','identity.json'),'{}');
  const descriptor={nativeTool,companySlug:'synthetic'},binding={scopeId:randomUUID(),scopeEpoch:1,deviceId:randomUUID(),envelopeId:randomUUID()};
  const observed=[],admissions=[];
  const value=title=>({schemaVersion:1,generation:'a'.repeat(64),result:{content:[],structuredContent:{results:[{title}]}}});
  const workspace=await createAssistantWorkspaceExecutor({configDirectory:root,companyPreparationOptions:{waitMs:2}});
  const request=async(raw,options)=>{
    observed.push(raw.operation);
    if(raw.operation==='call'){
      admissions.push(raw.arguments.runtimeSessionProof.nonce);
      return {content:[],_meta:{'trelio/assistant-company-read':{schemaVersion:nativeTool==='fetch'?3:2,descriptor,binding:{...binding}}}};
    }
    if(raw.operation==='company_context_search')return handlers.search?handlers.search(raw,options):value('CURRENT');
    assert.equal(raw.operation,'company_context_validate');
    return handlers.validate?handlers.validate(raw,options):{schemaVersion:1,current:true};
  };
  const proxy=await createForwardingAssistantMcp({configurationDirectory:root,request,createWorkspace:()=>workspace});
  const call=(args={},signal)=>proxy.callTool(nativeTool,{...(nativeTool==='fetch'?{id:'context:registry:synthetic'}:{companySlugs:['synthetic'],queries:['PRIVATE_QUERY']}),
    ...args,runtimeSessionProof:{nonce:randomUUID()}},signal);
  t.after(async()=>{await workspace.stop();await fs.rm(root,{recursive:true,force:true});});
  return {workspace,call,observed,admissions,value,binding};
};

test('pending search validates its generation and consumes one result rather than caching answers',async t=>{
  let queries=0,checks=0;
  const f=await pendingSearchFixture(t,{search:()=>f.value(`SOURCE_${++queries}`),
    validate:async()=>({schemaVersion:1,current:++checks!==1})});
  assert.equal((await f.call()).structuredContent.state,'preparing','changed generation cannot leak the first result');
  assert.equal((await f.call()).structuredContent.results[0].title,'SOURCE_2');
  assert.equal((await f.call()).structuredContent.results[0].title,'SOURCE_3','an independent same-query call must read again');
  assert.equal(queries,3);assert.equal(checks,3);assert.equal(new Set(f.admissions).size,3);
});

test('pending search refuses a native revocation once and never returns the retained result',async t=>{
  const refusal=Object.assign(Error(),{code:'ASSISTANT_COMPANY_CONTEXT_ACCESS_DENIED'});let checks=0;
  const f=await pendingSearchFixture(t,{validate:async()=>{checks++;throw refusal;}});
  await assert.rejects(f.call(),error=>error===refusal);
  await assert.rejects(f.call(),error=>error===refusal);
  assert.equal(checks,1);assert.equal(f.observed.filter(v=>v==='company_context_search').length,1);
});

test('pending search keeps one query per native binding when a caller changes formulations',async t=>{
  let release,launched=0;
  const f=await pendingSearchFixture(t,{search:raw=>{
    launched++;assert.deepEqual(raw.arguments.queries,['PRIVATE_QUERY']);
    return new Promise(resolve=>{release=()=>resolve(f.value('ORIGINAL_RESULT'));});
  }});
  assert.equal((await f.call()).structuredContent.state,'preparing');
  const different=await f.call({queries:['DIFFERENT_QUERY']});
  assert.equal(different.structuredContent.state,'preparing');
  assert.deepEqual(different.structuredContent.nextCall.arguments.queries,['PRIVATE_QUERY']);
  assert.equal(launched,1);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.call()).structuredContent.results[0].title,'ORIGINAL_RESULT');
  assert.equal(launched,1);assert.equal(f.admissions.length,3);
});

test('pending search polls do not own the query cancellation and EOF stops only its own child',async t=>{
  let release,ownedSignal;
  const f=await pendingSearchFixture(t,{search:(_raw,{signal})=>{
    ownedSignal=signal;return new Promise((resolve,reject)=>{
      release=()=>resolve(f.value('CURRENT'));
      signal.addEventListener('abort',()=>reject(Object.assign(Error(),{code:'ASSISTANT_RUNTIME_REQUEST_CANCELLED'})),{once:true});
    });}});
  const waiter=new AbortController(),first=f.call({},waiter.signal);
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  waiter.abort(new Error('synthetic wait ended'));
  await assert.rejects(first,/synthetic wait ended/);assert.equal(ownedSignal.aborted,false);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.call()).structuredContent.results[0].title,'CURRENT');
  release=null;
  assert.equal((await f.call()).structuredContent.state,'preparing');
  await f.workspace.stop();assert.equal(ownedSignal.aborted,true);
});

test('pending search records between-poll failure and permits only one exact owned timeout resume',async t=>{
  const originalTimeout=globalThis.setTimeout,deadlines=[];let started=0;
  // Fire only the actual parent's captured ten-minute timer. A returned error
  // with the same public code is not evidence that THIS operation timed out.
  t.mock.method(globalThis,'setTimeout',(callback,milliseconds,...rest)=>{
    if(milliseconds===600000)deadlines.push(callback);
    return originalTimeout(callback,milliseconds,...rest);
  });
  const f=await pendingSearchFixture(t,{search:(_raw,{signal})=>{started++;return new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(Object.assign(Error(),{code:'ASSISTANT_RUNTIME_REQUEST_CANCELLED'})),{once:true});
  });}});
  assert.equal((await f.call()).structuredContent.state,'preparing');deadlines[0]();
  await new Promise(resolve=>setImmediate(resolve));
  const changed=await f.call({queries:['DIFFERENT_AFTER_TIMEOUT']});
  assert.deepEqual(changed.structuredContent.nextCall.arguments.queries,['PRIVATE_QUERY']);
  assert.equal(started,1,'an owned timeout grants one resume of the original formulation, not a new query');
  assert.equal((await f.call()).structuredContent.state,'preparing');assert.equal(started,2);
  deadlines[1]();await new Promise(resolve=>setImmediate(resolve));
  for(let i=0;i<3;i++)await assert.rejects(f.call(),{code:'ASSISTANT_COMPANY_CONTEXT_PREPARATION_TIMED_OUT'});
  assert.equal(started,2,'another admitted poll cannot create a third owned reader');
});

test('a request-child lookalike timeout cannot grant another owned first sync',async t=>{
  const timeout=Object.assign(Error(),{code:'ASSISTANT_COMPANY_CONTEXT_PREPARATION_TIMED_OUT'});
  const f=await pendingSearchFixture(t,{search:()=>{throw timeout;}});
  for(let i=0;i<3;i++)await assert.rejects(f.call(),error=>error===timeout);
  assert.equal(f.observed.filter(value=>value==='company_context_search').length,1);
});

test('pending search bounds continuously changing snapshots without renewing its read operation',async t=>{
  const originalTimeout=globalThis.setTimeout;let ownedTimers=0;
  t.mock.method(globalThis,'setTimeout',(callback,milliseconds,...rest)=>{
    if(milliseconds===600000)ownedTimers++;
    return originalTimeout(callback,milliseconds,...rest);
  });
  const f=await pendingSearchFixture(t,{validate:async()=>({schemaVersion:1,current:false})});
  assert.equal((await f.call()).structuredContent.state,'preparing');
  await assert.rejects(f.call(),{code:'ASSISTANT_COMPANY_CONTEXT_LOCAL_CONTEXT_GENERATION_CHANGED'});
  await assert.rejects(f.call(),{code:'ASSISTANT_COMPANY_CONTEXT_LOCAL_CONTEXT_GENERATION_CHANGED'});
  assert.equal(f.observed.filter(v=>v==='company_context_search').length,2);
  assert.equal(ownedTimers,1,'fresh snapshot assembly cannot renew the original deadline');
});

test('pending search rejects malformed completion/validation frames without another child or retained-answer delivery',async t=>{
  for(const invalid of ['result','validation'])await t.test(invalid,async t=>{
    let launched=0,checked=0;
    const f=await pendingSearchFixture(t,{search:()=>{launched++;return invalid==='result'
      ?{schemaVersion:1,generation:'a'.repeat(64),result:[]}:f.value('PRIVATE_RESULT');},
      validate:()=>{checked++;return {schemaVersion:1,current:true,foreign:true};}});
    for(let i=0;i<2;i++)await assert.rejects(f.call(),{code:invalid==='result'
      ?'ASSISTANT_COMPANY_CONTEXT_PREPARATION_RESULT_INVALID':'ASSISTANT_MCP_INVALID_RESPONSE'});
    assert.equal(launched,1);assert.equal(checked,invalid==='result'?0:1);
  });
});

test('pending search cannot gain retry authority from a different validator timeout or EOF',async t=>{
  await t.test('validator lookalike',async t=>{
    const error=Object.assign(Error(),{code:'ASSISTANT_COMPANY_CONTEXT_PREPARATION_TIMED_OUT'});
    const f=await pendingSearchFixture(t,{validate:()=>{throw error;}});
    for(let i=0;i<2;i++)await assert.rejects(f.call(),value=>value===error);
    assert.equal(f.observed.filter(v=>v==='company_context_search').length,1);
  });
  await t.test('EOF after computation',async t=>{
    let validate;
    const f=await pendingSearchFixture(t,{validate:()=>new Promise(resolve=>{validate=()=>resolve({schemaVersion:1,current:true});})});
    const pending=f.call();while(!validate)await new Promise(resolve=>setImmediate(resolve));
    await f.workspace.stop();validate();
    await assert.rejects(pending,{code:'ASSISTANT_RUNTIME_REQUEST_CANCELLED'});
  });
});

// This reproduces the REAL serial facade and signed-request process boundary.
// The external reader is deliberately slow; it never touches an account, live
// company, operator Keychain or model. Preparation succeeding does not make a
// subsequent fresh encrypted read fit inside setup's unrelated 45-second clock.
test('a slow fresh search stays in its original owned read operation after preparation', {timeout:75000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-slow-search-'));
  const input=new PassThrough(),output=new PassThrough();
  await fs.mkdir(path.join(root,'digital-assistants'));
  await fs.writeFile(path.join(root,'digital-assistants','identity.json'),'{}');
  const descriptor={nativeTool:'search',companySlug:'synthetic'},binding={scopeId:randomUUID(),
    scopeEpoch:1,deviceId:randomUUID(),envelopeId:randomUUID()};
  const loader=path.join(root,'loader.mjs'),started=path.join(root,'read-started');
  const entry=new URL('../host-runtime/scripts/trelio-assistant-entry.mjs',import.meta.url).href;
  await fs.writeFile(loader,`import fs from 'node:fs/promises';import {runAssistantEntry} from ${JSON.stringify(entry)};
    await runAssistantEntry(['request'],{executeRequest:async raw=>{
      if(raw.operation==='company_context_validate')return {schemaVersion:1,current:true};
      if(raw.operation!=='company_context_search')throw Error('UNEXPECTED_SYNTHETIC_OPERATION');
      await fs.writeFile(${JSON.stringify(started)},'started');
      await new Promise(resolve=>setTimeout(resolve,46000));
      return {schemaVersion:1,generation:'a'.repeat(64),result:{content:[],structuredContent:{results:[{title:'SYNTHETIC_CURRENT_SOURCE'}]}}};
    }});`);
  let admissions=0,reads=0;
  const request=(raw,options)=>{
    if(raw.operation==='call'){
      assert.equal(raw.prepareCompanySearch,2);
      admissions++;return Promise.resolve({content:[],_meta:{'trelio/assistant-company-read':{schemaVersion:2,descriptor,binding}}});
    }
    if(raw.operation==='company_context_search')reads++;
    return requestCurrentAssistantRuntime(raw,{...options,resolveLoader:async()=>loader});
  };
  const workspace=await createAssistantWorkspaceExecutor({configDirectory:root,companyPreparationOptions:{waitMs:5}});
  let buffer='',sequence=0;const responses=[];
  output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))!==-1){
    responses.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
  const running=runAssistantSetupMcp({input,output,preservePlugin:()=>null,scheduleMaintenance:()=>null,
    createWorkspace:()=>workspace,createMcp:options=>createForwardingAssistantMcp({...options,request,configurationDirectory:root})});
  t.after(async()=>{input.end();await running;await fs.rm(root,{recursive:true,force:true});});
  const send=async(method,params)=>{
    const id=++sequence;input.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
    const until=Date.now()+60000;
    while(Date.now()<until){const value=responses.find(row=>row.id===id);if(value)return value;
      await new Promise(resolve=>setTimeout(resolve,10));}
    assert.fail('the real serial facade did not settle its bounded response');
  };
  await send('initialize');
  const search=()=>send('tools/call',{name:'search',arguments:{companySlugs:['synthetic'],queries:['SYNTHETIC_QUESTION'],
    runtimeSessionProof:{nonce:randomUUID()}}});
  let result;
  const until=Date.now()+60000;
  while(Date.now()<until){
    result=(await search()).result;
    assert.notEqual(result?.isError,true,JSON.stringify(result));
    if(result?.structuredContent?.state!=='preparing')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(result.structuredContent.results[0].title,'SYNTHETIC_CURRENT_SOURCE');
  assert.equal(reads,1,'polling must not launch another query reader');
  assert.ok(admissions>1,'each short poll needs a fresh native admission');
});

test('pending exact fetch binds the original selection and independently refuses late revocation',async t=>{
  let release,reads=0,refuse=false;
  const denied=Object.assign(Error(),{code:'ASSISTANT_COMPANY_CONTEXT_ACCESS_DENIED'});
  const f=await pendingSearchFixture(t,{search:raw=>{
    reads++;assert.equal(raw.descriptor.nativeTool,'fetch');assert.deepEqual(raw.arguments,{id:'context:registry:synthetic'});
    return new Promise(resolve=>{release=()=>resolve(f.value('EXACT_SOURCE'));});
  },validate:()=>{if(refuse)throw denied;return {schemaVersion:1,current:true};}},'fetch');
  assert.equal((await f.call()).structuredContent.state,'preparing');
  const changed=await f.call({id:'context:registry:different'});
  assert.equal(changed.structuredContent.nextCall.tool,'fetch');
  assert.deepEqual(changed.structuredContent.nextCall.arguments,{id:'context:registry:synthetic'});
  assert.equal(reads,1,'another selected id cannot launch a parallel reader or reset its budget');
  release();await new Promise(resolve=>setImmediate(resolve));refuse=true;
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(f.call(),error=>error===denied);
  assert.equal(reads,1,'fresh native refusal never retries or leaks the completed source');
  assert.equal(new Set(f.admissions).size,4);
});
