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

test('completion signs only an independently confirmed original selection with the same observed key, never model proof',async()=>{
  const {assistantSourceProcessingProofPayload,assistantSourceProcessingProofTool}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const f=fixture(),selected=[{sourceId:crypto.randomUUID(),sourceRevision:3,routeId:crypto.randomUUID(),eventOrdinal:4}];
  let confirmed=0,allowed=true;
  const hook=createAssistantTaskHook({...f.options,confirmSourceProcessing:async(pass,refs)=>{
    confirmed++;assert.deepEqual(pass,f.pass);assert.deepEqual(refs,selected);
    if(!allowed)throw Object.assign(new Error(),{code:'ASSISTANT_INBOX_SOURCE_READ_REQUIRED'});
  }});
  const fields={clientRequestId:crypto.randomUUID(),workspaceId:crypto.randomUUID(),workspaceHead:'a'.repeat(40),
    acceptedRunId:crypto.randomUUID(),noChange:false,processedSourceReferences:selected,sourceProcessingProof:{signature:'FORGED'},
    encryptedMaterialWitness:{signature:'FORGED_MATERIAL'}};
  const event={...f.event(),tool_input:fields};
  const output=await hook(event,'complete_assistant_pass'),normal=verifyProof(f,output,'complete_assistant_pass');
  const input=output.hookSpecificOutput.updatedInput,proof=input.sourceProcessingProof;
  assert.equal(input.encryptedMaterialWitness,undefined,'only the protected accepted-material host, never model input, builds a witness');
  assert.equal(proof.runtimeSessionId,normal.runtimeSessionId);assert.notEqual(proof.nonce,normal.nonce);
  const [spki]=[...f.records.entries()].find(([,row])=>row.runtimeSessionId===normal.runtimeSessionId);
  const key=crypto.createPublicKey({key:Buffer.from(spki,'base64url'),format:'der',type:'spki'});
  const verify=selection=>{
    const manifest=assistantSourceProcessingProofPayload({...f.pass,...fields,references:selection});
    const operation=assistantSourceProcessingProofTool(crypto.createHash('sha256').update(manifest).digest('hex'));
    return crypto.verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,operation,proof.issuedAt,proof.nonce].join('\n')),
      key,Buffer.from(proof.signature,'base64url'));
  };
  assert.equal(verify(selected),true);assert.equal(verify([{...selected[0],eventOrdinal:5}]),false);
  assert.equal(confirmed,1);assert.ok(!JSON.stringify(input).includes('FORGED'));
  allowed=false;await assert.rejects(hook(event,'complete_assistant_pass'),error=>error.code==='ASSISTANT_INBOX_SOURCE_READ_REQUIRED');
  await assert.rejects(hook({...event,tool_input:{...fields,noChange:true}},'complete_assistant_pass'),/SOURCE_READ_REQUIRED/);
  const empty=await hook({...event,tool_input:{...fields,processedSourceReferences:[]}},'complete_assistant_pass');
  assert.equal(empty.hookSpecificOutput.updatedInput.sourceProcessingProof,undefined);
  const read=await hook(event,'get_task');assert.equal(read.hookSpecificOutput.updatedInput.sourceProcessingProof,undefined);
});

test('taskless intake hook has genuine observed one-use proof and cannot borrow task or sensitive tools',async()=>{
 const f=fixture(),{companyId,passId,deliveryId,threadId}=f.pass;
 const pass={schemaVersion:1,kind:'source_intake',assistantId:f.identity.assistantId,deviceId:f.identity.deviceId,
  companyId,passId,deliveryId,threadId,sourceId:crypto.randomUUID(),sourceRevision:0,eventId:crypto.randomUUID()};
 f.setActive(pass);f.client.readSourceIntake=async()=>({...pass,id:passId,state:'leased',leaseExpiresAt:new Date(Date.now()+600000).toISOString()});
 f.client.registerIntakeRuntime=async input=>{const result={runtimeSessionId:crypto.randomUUID(),passId,observation:input.observation,
   expiresAt:new Date(Date.now()+300000).toISOString(),runtimeRefreshSupported:true};f.records.set(input.publicKeySpki,result);return result;};
 const event={hook_event_name:'PreToolUse',session_id:threadId,tool_input:{taskPass:{passId:'UNTRUSTED'},intakePass:{sourceId:'UNTRUSTED'},runtimeSessionProof:{signature:'UNTRUSTED'}}};
 const tool='get_assistant_intake_context',result=await f.hook(event,tool),output=result.hookSpecificOutput.updatedInput;
 assert.deepEqual(output.intakePass,{companyId,sourceId:pass.sourceId,intakeId:passId});assert.equal(output.taskPass,undefined);
 const proof=output.runtimeSessionProof,[key]=[...f.records.keys()];
 assert.equal(crypto.verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,tool,proof.issuedAt,proof.nonce].join('\n')),
   crypto.createPublicKey({key:Buffer.from(key,'base64url'),format:'der',type:'spki'}),Buffer.from(proof.signature,'base64url')),true);
 for(const read of ['search','search_tasks','get_task','get_task_sections']){
  const current=(await f.hook(event,read)).hookSpecificOutput.updatedInput;
  assert.deepEqual(current.intakePass,{companyId,sourceId:pass.sourceId,intakeId:passId});
  assert.equal(current.taskPass,undefined,'a company read must never fabricate a task pass');
  assert.notEqual(current.runtimeSessionProof.nonce,proof.nonce);
  assert.equal(crypto.verify(null,Buffer.from(['trelio-runtime-proof-v1',current.runtimeSessionProof.runtimeSessionId,read,
    current.runtimeSessionProof.issuedAt,current.runtimeSessionProof.nonce].join('\n')),
    crypto.createPublicKey({key:Buffer.from(key,'base64url'),format:'der',type:'spki'}),Buffer.from(current.runtimeSessionProof.signature,'base64url')),true);
 }
 for(const denied of ['get_assistant_task','create_task','apply_assistant_task_action','confirm_assistant_intake_read'])await assert.rejects(f.hook(event,denied),/CAPABILITY_UNAVAILABLE/);
 await assert.rejects(f.hook({...event,session_id:crypto.randomUUID()},tool),/TASK_MISMATCH/);
});

test('source triage hook seals the exact frozen role/batch with ordinary observed proof, never owner/task authority',async()=>{
 const f=fixture(),{companyId,passId,deliveryId,threadId}=f.pass,eventIds=[crypto.randomUUID(),crypto.randomUUID()];
 const pass={schemaVersion:1,kind:'source_intake',intakeKind:'route_existing',eventIds,assistantId:f.identity.assistantId,deviceId:f.identity.deviceId,
   companyId,passId,deliveryId,threadId,sourceId:crypto.randomUUID(),sourceRevision:2,eventId:eventIds[0]};
 f.setActive(pass);let live={...pass,kind:'route_existing',id:passId,state:'leased',leaseExpiresAt:new Date(Date.now()+600000).toISOString()};
 f.client.readSourceIntake=async()=>({...live});f.client.registerIntakeRuntime=async input=>{
   const result={runtimeSessionId:crypto.randomUUID(),passId,observation:input.observation,expiresAt:new Date(Date.now()+300000).toISOString(),runtimeRefreshSupported:true};
   f.records.set(input.publicKeySpki,result);return result;};
 const event={hook_event_name:'PreToolUse',session_id:threadId,tool_input:{decision:'route_existing',taskId:crypto.randomUUID(),clientRequestId:passId}};
 const first=await f.hook(event,'resolve_assistant_intake'),proof=first.hookSpecificOutput.updatedInput.runtimeSessionProof;
 const [key]=[...f.records.keys()];assert.equal(crypto.verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,'resolve_assistant_intake',proof.issuedAt,proof.nonce].join('\n')),
   crypto.createPublicKey({key:Buffer.from(key,'base64url'),format:'der',type:'spki'}),Buffer.from(proof.signature,'base64url')),true);
 assert.deepEqual(first.hookSpecificOutput.updatedInput.intakePass,{companyId,sourceId:pass.sourceId,intakeId:passId});
 for(const name of ['create_task','request_assistant_action','get_task','confirm_assistant_intake_read'])await assert.rejects(f.hook(event,name),/CAPABILITY_UNAVAILABLE/);
 live={...live,eventIds:[crypto.randomUUID()]};await assert.rejects(f.hook(event,'resolve_assistant_intake'),/PASS_REVIEW_REQUIRED/);
 live={...live,eventIds,kind:'owner_command'};await assert.rejects(f.hook(event,'get_assistant_intake_context'),/PASS_REVIEW_REQUIRED/);
});


test('protected taskless pass releases only an exact negative native receipt, never task/triage or missing owner proof',async()=>{
 const f=fixture(),disk=new Map();
 const host=createAssistantHostState({directory:path.join(os.tmpdir(),'assistant-negative-receipt'),store:f.store,primitives:{
  ensurePrivateDirectory:async()=>{},assertPrivatePathKind:async file=>{if(!disk.has(file))throw Object.assign(Error(),{code:'ENOENT'});},
  readPrivateJsonFile:async file=>disk.get(file),writePrivateJsonFile:async(file,value)=>disk.set(file,value)}});
 await host.saveIdentity(f.identity);
 const pass={schemaVersion:1,kind:'source_intake',assistantId:f.identity.assistantId,deviceId:f.identity.deviceId,
  companyId:crypto.randomUUID(),passId:crypto.randomUUID(),deliveryId:crypto.randomUUID(),threadId:crypto.randomUUID(),
  sourceId:crypto.randomUUID(),sourceRevision:4,eventId:crypto.randomUUID()};
 await host.activatePass(pass);
 const receipt={schemaVersion:1,state:'reply_abandoned',companyId:pass.companyId,id:pass.passId,sourceId:pass.sourceId,sourceRevision:pass.sourceRevision,
  eventId:pass.eventId,threadId:pass.threadId,receiptId:crypto.randomUUID(),ownerPrivateRead:true,readConfirmed:true,taskId:null};
 for(const patch of [{companyId:crypto.randomUUID()},{sourceRevision:5},{threadId:crypto.randomUUID()},{ownerPrivateRead:false},{readConfirmed:false},{taskId:crypto.randomUUID()}])
  await assert.rejects(host.releasePass({...receipt,...patch}),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});
 assert.deepEqual(await host.readActivePass(),pass);
 await host.releasePass(receipt);assert.equal(await host.readActivePass(),null);
});
