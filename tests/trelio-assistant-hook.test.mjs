import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createAssistantTaskHook, createAssistantHostState } from '../host-runtime/scripts/trelio-assistant-hook.mjs';
import { detectAgentRuntimeAttestation } from '../host-runtime/scripts/trelio-runtime-attestation.mjs';
import { withRuntimeHookPrivateSession } from '../host-runtime/scripts/trelio-hook-private-session.mjs';
import { runAssistantEntry } from '../host-runtime/scripts/trelio-assistant-entry.mjs';
import { Readable,PassThrough } from 'node:stream';

const memoryStore=()=>{
  const values=new Map(),key=input=>JSON.stringify(input);
  return {get:async input=>structuredClone(values.get(key(input))??null),
    put:async(input,value)=>values.set(key(input),structuredClone(value)),remove:async input=>values.delete(key(input)),values};
};
const fixture=()=>{
  const identity={origin:'https://assistant.test',assistantId:crypto.randomUUID(),deviceId:crypto.randomUUID()};
  const pass={schemaVersion:1,...identity,companyId:crypto.randomUUID(),taskId:crypto.randomUUID(),passId:crypto.randomUUID(),
    deliveryId:crypto.randomUUID(),threadId:crypto.randomUUID(),bindingId:crypto.randomUUID(),bindingRevision:2};delete pass.origin;
  const store=memoryStore(),records=new Map();
  let calls=0,active=pass,revoked=false,lost=false,observation={schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',
    effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook',observedAt:new Date().toISOString()};
  const client={
    readTaskPass:async()=>{if(revoked)throw Object.assign(new Error(),{code:'ASSISTANT_ACCESS_DENIED'});return {...pass,state:'leased',leaseExpiresAt:new Date(Date.now()+600_000).toISOString()};},
    registerRuntime:async input=>{
      calls++;const old=records.get(input.publicKeySpki);
      const result=old??{schemaVersion:1,passId:pass.passId,runtimeSessionId:crypto.randomUUID(),observation:input.observation,
        expiresAt:new Date(Date.now()+300_000).toISOString(),runtimeRefreshSupported:true};
      // Refresh retains the predecessor's absolute clock, matching the backend.
      if(input.previousRuntimeSessionId)result.expiresAt=[...records.values()].find(r=>r.runtimeSessionId===input.previousRuntimeSessionId).expiresAt;
      records.set(input.publicKeySpki,result);
      if(lost){lost=false;throw Object.assign(new Error(),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});}return result;
    },endRuntime:async()=>({ended:true}),
  };
  let queue=Promise.resolve();
  const lock=(_file,action)=>{const result=queue.then(action);queue=result.catch(()=>{});return result;};
  const options={identity,client,store,readActivePass:async()=>active,lockDirectory:path.join(os.tmpdir(),'assistant-hook-lock-fixture'),
    observe:async()=>observation,lock};
  return {identity,pass,store,records,options,client,hook:createAssistantTaskHook(options),calls:()=>calls,
    setObservation:value=>{observation={...observation,...value};},revoke:()=>{revoked=true;},lose:()=>{lost=true;},
    setActive:value=>{active=value;},event:()=>({hook_event_name:'PreToolUse',session_id:pass.threadId,tool_input:{modelId:'UNTRUSTED',runtimeSessionProof:{signature:'UNTRUSTED'},taskPass:{passId:'UNTRUSTED'}}})};
};
const verifyProof=(f,result,tool)=>{
  const output=result.hookSpecificOutput.updatedInput,proof=output.runtimeSessionProof;
  const entry=[...f.records.entries()].find(([,r])=>r.runtimeSessionId===proof.runtimeSessionId);
  assert.ok(entry);const publicKey=crypto.createPublicKey({key:Buffer.from(entry[0],'base64url'),format:'der',type:'spki'});
  assert.equal(crypto.verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,tool,proof.issuedAt,proof.nonce].join('\n')),
    publicKey,Buffer.from(proof.signature,'base64url')),true);
  assert.deepEqual(output.taskPass,{companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId});
  assert.ok(!JSON.stringify(result).includes('privateKeyPkcs8'));
  assert.ok(!JSON.stringify(proof).includes('UNTRUSTED'));
  return proof;
};
test('hook uses actual task conversation and fresh common signatures, never model-authored identity',async()=>{
  const f=fixture(),tool='get_assistant_task';
  const [first,second]=await Promise.all([f.hook(f.event(),tool),f.hook(f.event(),tool)]);
  assert.notEqual(verifyProof(f,first,tool).nonce,verifyProof(f,second,tool).nonce);assert.equal(f.calls(),1);
  await assert.rejects(f.hook({...f.event(),session_id:crypto.randomUUID()},tool),/TASK_MISMATCH/);
  await assert.rejects(f.hook({...f.event(),session_id:undefined},tool),/SESSION_REQUIRED/);
  assert.equal(f.calls(),1);f.revoke();await assert.rejects(f.hook(f.event(),tool),error=>error.code==='ASSISTANT_ACCESS_DENIED');
});
test('lost registration survives hook restart with the same pending key; refresh keeps old snapshot',async()=>{
  const f=fixture(),tool='get_assistant_task';f.lose();
  await assert.rejects(f.hook(f.event(),tool),error=>error.code==='ASSISTANT_TRANSPORT_UNAVAILABLE');
  assert.equal(f.records.size,1);const originalKey=[...f.records.keys()][0];
  const restarted=createAssistantTaskHook(f.options);
  const first=verifyProof(f,await restarted(f.event(),tool),tool);
  assert.equal(f.records.size,1);assert.equal([...f.records.keys()][0],originalKey);
  f.setObservation({effortLevel:'max'});
  const updated=verifyProof(f,await restarted(f.event(),tool),tool);
  assert.notEqual(updated.runtimeSessionId,first.runtimeSessionId);assert.equal(f.records.size,2);
  const saved=[...f.store.values.values()][0];
  assert.equal(saved.state.observation.effortLevel,'max');assert.ok(!saved.pending);
});
test('native SessionEnd does not clear a pass or claim business completion',async()=>{
  const f=fixture();await f.hook(f.event(),'get_assistant_task');
  await f.hook({hook_event_name:'SessionEnd',session_id:f.pass.threadId});
  assert.equal([...f.store.values.values()][0].ended,true);
  assert.equal(await f.options.readActivePass(),f.pass);
  const next=await f.hook(f.event(),'get_assistant_task');verifyProof(f,next,'get_assistant_task');assert.equal(f.records.size,2);
});
test('a closed pass accepts only SessionEnd cleanup and cannot produce another signed call',async()=>{
  const f=fixture();await f.hook(f.event(),'complete_assistant_pass');
  let endings=0;f.client.endRuntime=async()=>{endings++;return {ended:true};};
  f.client.readTaskPass=async()=>({...f.pass,state:'closed',leaseExpiresAt:new Date(1).toISOString()});
  await assert.rejects(f.hook(f.event(),'get_task'),/REVIEW_REQUIRED/);
  await f.hook({hook_event_name:'SessionEnd',session_id:f.pass.threadId});
  assert.equal(endings,1);assert.equal(f.calls(),1);assert.equal(await f.options.readActivePass(),f.pass);
});
test('common observer reads the current native Codex turn instead of tool argument claims',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-observation-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const transcript=path.join(root,'rollout.jsonl');
  await fs.writeFile(transcript,JSON.stringify({type:'turn_context',payload:{model:'gpt-6.1-sol',effort:'high'}})+'\n');
  const f=fixture(),hook=createAssistantTaskHook({...f.options,observe:args=>detectAgentRuntimeAttestation({...args,environment:{}})});
  const output=await hook({...f.event(),model:'gpt-6.1-sol',transcript_path:transcript},'get_assistant_task');
  verifyProof(f,output,'get_assistant_task');assert.equal([...f.records.values()][0].observation.effortLevel,'high');
});
test('entry injects only trusted hook output and denies errors without raw data or alternate auth',async()=>{
  const f=fixture();let text='';const output=new PassThrough();output.on('data',c=>text+=c);
  await runAssistantEntry(['hook'],{input:Readable.from([JSON.stringify({...f.event(),tool_name:'mcp__trelio_assistant__get_assistant_task'})]),
    output,createHook:async()=>f.hook});
  verifyProof(f,JSON.parse(text),'get_assistant_task');
  text='';await runAssistantEntry(['hook'],{input:Readable.from([JSON.stringify({...f.event(),tool_name:'mcp__trelio_assistant__get_assistant_task'})]),
    output,createHook:async()=>{throw new Error('PRIVATE TOKEN PATH');}});
  assert.equal(JSON.parse(text).hookSpecificOutput.permissionDecision,'deny');assert.ok(!text.includes('PRIVATE'));
});
test('host journal cannot silently rebind identity, replace an unresolved pass or release without exact outcome',async()=>{
  const f=fixture(),disk=new Map();
  const host=createAssistantHostState({directory:path.join(os.tmpdir(),'assistant-host-fixture'),store:f.store,primitives:{
    ensurePrivateDirectory:async()=>{},assertPrivatePathKind:async file=>{if(!disk.has(file))throw Object.assign(new Error(),{code:'ENOENT'});},
    readPrivateJsonFile:async file=>disk.get(file),writePrivateJsonFile:async(file,value)=>disk.set(file,value)}});
  assert.equal(await host.readIdentity(),null);await host.saveIdentity(f.identity);await host.saveIdentity(f.identity);
  await assert.rejects(host.saveIdentity({...f.identity,deviceId:crypto.randomUUID()}),/REBIND_REQUIRED/);
  await host.activatePass(f.pass);assert.deepEqual(await host.readActivePass(),f.pass);
  await assert.rejects(host.activatePass({...f.pass,passId:crypto.randomUUID()}),/REVIEW_REQUIRED/);
  await assert.rejects(host.releasePass({state:'completed'}),/REVIEW_REQUIRED/);
  const outcome={schemaVersion:1,state:'confirmed',receiptId:crypto.randomUUID(),...Object.fromEntries(
    ['assistantId','deviceId','companyId','taskId','bindingId','bindingRevision','deliveryId','threadId'].map(key=>[key,f.pass[key]]))};
  await assert.rejects(host.releasePass({...outcome,taskId:crypto.randomUUID()}),/REVIEW_REQUIRED/);
  const signingSlot={origin:f.identity.origin,kind:'runtime',id:f.pass.passId};
  await f.store.put(signingSlot,{state:{privateKeyPkcs8:'synthetic expired key'}});
  await host.releasePass(outcome);assert.equal(await host.readActivePass(),null);
  assert.equal(await f.store.get(signingSlot),null,'verified closure erases the unused local signing key');
});

test('an exhausted common hook deadline blocks the first private read',async()=>{
  const f=fixture();let reads=0;
  const hook=createAssistantTaskHook({...f.options,readActivePass:async()=>{reads++;return f.pass;}});
  await assert.rejects(withRuntimeHookPrivateSession(0,()=>hook(f.event(),'get_assistant_task')),
    error=>error.diagnosticCode==='TRELIO_RUNTIME_HOOK_DEADLINE_EXCEEDED');
  assert.equal(reads,0);assert.equal(f.calls(),0);
});
