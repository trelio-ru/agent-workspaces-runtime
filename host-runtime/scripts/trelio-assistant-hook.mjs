/** Assistant hook composes the ordinary observer, Ed25519 proof serializer,
 * private-process deadline and state lock. It never reads human OAuth/state or
 * accepts model/effort/pass identity from the model's tool arguments. */
import crypto from 'node:crypto';
import path from 'node:path';
import { ensurePrivateDirectory, assertPrivatePathKind, readPrivateJsonFile, writePrivateJsonFile } from './trelio-workspace.mjs';
import { detectAgentRuntimeAttestation } from './trelio-runtime-attestation.mjs';
import { buildRuntimeSessionProof, withRuntimeStateLock } from './trelio-runtime-session.mjs';
import { TRELIO_COMPACTION_RECOVERY_CONTEXT } from './trelio-context-recovery.mjs';
import { runtimeHookSignal, assertRuntimeHookBudget } from './trelio-hook-private-session.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exactObject=(value,keys)=>value && Object.getPrototypeOf(value)===Object.prototype
  && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const sameObservation=(left,right)=>left && right && ['schemaVersion','clientFamily','modelId','effortLevel','evidenceLevel','source'].every(key=>left[key]===right[key]);
const passKeys=['schemaVersion','assistantId','deviceId','companyId','taskId','passId','deliveryId','threadId','bindingId','bindingRevision'];
export const validateAssistantActivePass=(value,identity)=>{
  if(!exactObject(value,passKeys) || value.schemaVersion!==1 || value.assistantId!==identity.assistantId || value.deviceId!==identity.deviceId
    || passKeys.filter(key=>key.endsWith('Id')).some(key=>!uuid.test(value[key]??''))
    || !Number.isSafeInteger(value.bindingRevision) || value.bindingRevision<0) fail('ASSISTANT_ACTIVE_PASS_REQUIRED');
  return Object.freeze(Object.fromEntries(passKeys.map(key=>[key,value[key]])));
};

export const createAssistantTaskHook=({identity,client,store,readActivePass,lockDirectory,
  observe=detectAgentRuntimeAttestation,lock=withRuntimeStateLock,now=Date.now})=>{
  if(!uuid.test(identity?.assistantId??'') || !uuid.test(identity?.deviceId??'') || !path.isAbsolute(lockDirectory??'')
    || !store || !client || typeof readActivePass!=='function') fail('ASSISTANT_HOOK_SETUP_REQUIRED');
  return async (event,toolName)=>{
    // An inherited environment thread ID is not evidence for an assistant
    // pass. The actual hook event must name the permanent task conversation.
    if(!uuid.test(event?.session_id??'')) fail('ASSISTANT_HOOK_SESSION_REQUIRED');
    assertRuntimeHookBudget();
    const pass=validateAssistantActivePass(await readActivePass(),identity);
    if(event.session_id.toLowerCase()!==pass.threadId.toLowerCase()) fail('ASSISTANT_HOOK_TASK_MISMATCH');
    const locator={companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId};
    const slot={origin:identity.origin,kind:'runtime',id:pass.passId};
    return lock(path.join(lockDirectory,`${pass.passId}.json`),async()=>{
      assertRuntimeHookBudget();
      const active=validateAssistantActivePass(await readActivePass(),identity);
      if(JSON.stringify(active)!==JSON.stringify(pass)) fail('ASSISTANT_HOOK_TASK_MISMATCH');
      const live=await client.readTaskPass(locator,runtimeHookSignal());
      if(live.state!=='leased' || live.threadId!==pass.threadId || live.deliveryId!==pass.deliveryId
        || live.bindingId!==pass.bindingId || live.bindingRevision!==pass.bindingRevision
        || !Number.isFinite(Date.parse(live.leaseExpiresAt)) || Date.parse(live.leaseExpiresAt)<=now()) fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      let record=await store.get(slot);
      if(record && (record.schemaVersion!==1 || record.passId!==pass.passId || record.threadId!==pass.threadId)) fail('ASSISTANT_HOOK_STATE_INVALID');
      if(event.hook_event_name==='SessionEnd') {
        if(record?.state?.runtimeSessionId && !record.ended) {
          // Persist the local end boundary before HTTP. A lost end reply must
          // not let the next hook sign with a remotely ended key. A later
          // initial registration safely retires any unended predecessor.
          await store.put(slot,{...record,ended:true});
          await client.endRuntime({...locator,runtimeSessionId:record.state.runtimeSessionId},runtimeHookSignal());
        }
        // Retain the same pass journal/key until host completion/recovery; an
        // ended native turn does not authorize a new business invocation.
        return {};
      }
      if(event.hook_event_name==='SessionStart') return event.source==='compact'
        ? {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:TRELIO_COMPACTION_RECOVERY_CONTEXT}} : {};
      if(event.hook_event_name!=='PreToolUse' || !/^[a-z][a-z0-9_]{0,159}$/u.test(toolName??'')) fail('ASSISTANT_HOOK_INVALID_INPUT');
      if(!event.tool_input || Object.getPrototypeOf(event.tool_input)!==Object.prototype) fail('ASSISTANT_HOOK_INVALID_INPUT');
      const observation=await observe({hookInput:event});assertRuntimeHookBudget();
      if(observation?.schemaVersion!==1 || observation.clientFamily!=='codex' || observation.source!=='codex_hook'
        || observation.evidenceLevel!=='local_observed' || !observation.modelId) fail('ASSISTANT_HOOK_OBSERVATION_REQUIRED');
      let state=record?.ended?null:record?.state;
      if(state && (!uuid.test(state.runtimeSessionId??'') || !Number.isFinite(Date.parse(state.expiresAt))
        || typeof state.privateKeyPkcs8!=='string' || state.privateKeyPkcs8.length>256 || !state.observation)) fail('ASSISTANT_HOOK_STATE_INVALID');
      if(!state || !sameObservation(state.observation,observation) || Date.parse(state.expiresAt)<=now()) {
        // Save the one pending key before HTTP. A lost reply reuses that exact
        // key instead of replacing sessions or replaying a business operation.
        const pending=record?.pending;
        const privateKey=pending && sameObservation(pending.observation,observation)
          ? crypto.createPrivateKey({key:Buffer.from(pending.privateKeyPkcs8,'base64url'),format:'der',type:'pkcs8'})
          : crypto.generateKeyPairSync('ed25519').privateKey;
        const privateKeyPkcs8=privateKey.export({type:'pkcs8',format:'der'}).toString('base64url');
        const publicKeySpki=crypto.createPublicKey(privateKey).export({type:'spki',format:'der'}).toString('base64url');
        record={schemaVersion:1,passId:pass.passId,threadId:pass.threadId,...(state?{state}:{}),pending:{observation,privateKeyPkcs8}};
        await store.put(slot,record);
        const registered=await client.registerRuntime({...locator,clientSessionId:pass.threadId,observation,publicKeySpki,
          ...(state && Date.parse(state.expiresAt)>now()?{previousRuntimeSessionId:state.runtimeSessionId}:{})},runtimeHookSignal());
        if(registered.passId!==pass.passId || !uuid.test(registered.runtimeSessionId??'')
          || !sameObservation(registered.observation,observation) || !Number.isFinite(Date.parse(registered.expiresAt))
          || Date.parse(registered.expiresAt)<=now() || registered.runtimeRefreshSupported!==true
          || (state && Date.parse(state.expiresAt)>now() && Date.parse(registered.expiresAt)>Date.parse(state.expiresAt))) fail('ASSISTANT_HOOK_REGISTRATION_INVALID');
        state={runtimeSessionId:registered.runtimeSessionId,expiresAt:registered.expiresAt,
          privateKeyPkcs8,observation:registered.observation};
        await store.put(slot,{schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state});
      }
      // Every call gets a fresh ordinary v1 nonce. Replace any model-authored
      // pass/proof; private signing keys never appear in the updated input.
      assertRuntimeHookBudget();
      const latest=validateAssistantActivePass(await readActivePass(),identity);
      if(JSON.stringify(latest)!==JSON.stringify(pass)) fail('ASSISTANT_HOOK_TASK_MISMATCH');
      return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...event.tool_input,
        taskPass:locator,runtimeSessionProof:buildRuntimeSessionProof({state,toolName,now:new Date(now())})}}};
    });
  };
};

/** Host identity contains structural locators only. Credentials and signing
 * keys stay in the same protected OS store, never this file or local SQLite. */
const validate=value=>{
  if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).sort().join(',')!=='assistantId,deviceId,origin,schemaVersion'
    || value.schemaVersion!==1 || !uuid.test(value.assistantId??'') || !uuid.test(value.deviceId??'')) fail('ASSISTANT_HOST_STATE_INVALID');
  let url;try{url=new URL(value.origin);}catch{fail('ASSISTANT_HOST_STATE_INVALID');}
  if(url.protocol!=='https:' || url.origin!==value.origin || url.username || url.password) fail('ASSISTANT_HOST_STATE_INVALID');
  return Object.freeze({schemaVersion:1,origin:value.origin,assistantId:value.assistantId,deviceId:value.deviceId});
};
export const createAssistantHostState=({directory,store,primitives={}})=>{
  if(!path.isAbsolute(directory??'') || !store) fail('ASSISTANT_HOST_STATE_INVALID');
  const ops={ensurePrivateDirectory,assertPrivatePathKind,readPrivateJsonFile,writePrivateJsonFile,...primitives};
  const file=path.join(directory,'identity.json');
  const readIdentity=async()=>{
    await ops.ensurePrivateDirectory(directory);
    try{await ops.assertPrivatePathKind(file,'file');}catch(error){if(error.code==='ENOENT')return null;throw error;}
    return validate(await ops.readPrivateJsonFile(file,{maximumBytes:4096}));
  };
  return {
    readIdentity,
    async saveIdentity(identity){
      const next=validate({schemaVersion:1,origin:identity.origin,assistantId:identity.assistantId,deviceId:identity.deviceId});
      const old=await readIdentity();
      if(old && JSON.stringify(old)!==JSON.stringify(next)) fail('ASSISTANT_HOST_REBIND_REQUIRED');
      if(!old) await ops.writePrivateJsonFile(file,next);
      if(JSON.stringify(await readIdentity())!==JSON.stringify(next)) fail('ASSISTANT_HOST_STATE_INVALID');
      return next;
    },
    async readActivePass(){
      const identity=await readIdentity();if(!identity)fail('ASSISTANT_HOST_NOT_CONFIGURED');
      const value=await store.get({origin:identity.origin,kind:'pass',id:identity.deviceId});
      return value===null?null:validateAssistantActivePass(value,identity);
    },
    async activatePass(value){
      const identity=await readIdentity();if(!identity)fail('ASSISTANT_HOST_NOT_CONFIGURED');
      const next=validateAssistantActivePass(value,identity),slot={origin:identity.origin,kind:'pass',id:identity.deviceId};
      const old=await store.get(slot);
      if(old && JSON.stringify(validateAssistantActivePass(old,identity))!==JSON.stringify(next)) fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      if(!old)await store.put(slot,next);
      return next;
    },
    // Only a positive, exact backend outcome allows the host to release its
    // active journal. Timeout/CLI exit/file existence cannot call this path.
    async releasePass(outcome){
      const identity=await readIdentity();if(!identity)fail('ASSISTANT_HOST_NOT_CONFIGURED');
      const slot={origin:identity.origin,kind:'pass',id:identity.deviceId};
      const old=await store.get(slot);if(!old)fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      const pass=validateAssistantActivePass(old,identity);
      if(outcome?.schemaVersion!==1 || outcome.state!=='confirmed' || !uuid.test(outcome.receiptId??'')
        || ['assistantId','deviceId','companyId','taskId','bindingId','bindingRevision','deliveryId','threadId'].some(key=>outcome[key]!==pass[key])) fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      await store.remove(slot);
    },
  };
};
