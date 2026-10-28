/** Assistant hook composes the ordinary observer, Ed25519 proof serializer,
 * private-process deadline and state lock. It never reads human OAuth/state or
 * accepts model/effort/pass identity from the model's tool arguments. */
import crypto from 'node:crypto';
import path from 'node:path';
import { validateAssistantCodexUpdate } from './trelio-assistant-codex-update.mjs';
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
const intakeKeys=['schemaVersion','kind','assistantId','deviceId','companyId','sourceId','sourceRevision','passId','deliveryId','eventId','threadId'];
export const validateAssistantActivePass=(value,identity)=>{
  const intake=value?.kind==='source_intake',routing=intake&&value.intakeKind==='route_existing',keys=intake?[...intakeKeys,...(routing?['intakeKind','eventIds']:[])]:passKeys;
  if(!exactObject(value,keys) || value.schemaVersion!==1 || value.assistantId!==identity.assistantId || value.deviceId!==identity.deviceId
    || keys.filter(key=>key.endsWith('Id')).some(key=>!uuid.test(value[key]??''))
    || !Number.isSafeInteger(intake?value.sourceRevision:value.bindingRevision) || (intake?value.sourceRevision:value.bindingRevision)<0
    ||routing&&(!Array.isArray(value.eventIds)||!value.eventIds.length||value.eventIds.length>100||value.eventIds[0]!==value.eventId
      ||new Set(value.eventIds).size!==value.eventIds.length||value.eventIds.some(id=>!uuid.test(id??''))))
    fail('ASSISTANT_ACTIVE_PASS_REQUIRED');
  return Object.freeze(Object.fromEntries(keys.map(key=>[key,key==='eventIds'?Object.freeze([...value[key]]):value[key]])));
};

export const createAssistantTaskHook=({identity,client,store,readActivePass,lockDirectory,
  confirmSourceProcessing=null,observe=detectAgentRuntimeAttestation,lock=withRuntimeStateLock,now=Date.now})=>{
  if(!uuid.test(identity?.assistantId??'') || !uuid.test(identity?.deviceId??'') || !path.isAbsolute(lockDirectory??'')
    || !store || !client || typeof readActivePass!=='function') fail('ASSISTANT_HOOK_SETUP_REQUIRED');
  return async (event,toolName)=>{
    // An inherited environment thread ID is not evidence for an assistant
    // pass. The actual hook event must name the permanent task conversation.
    if(!uuid.test(event?.session_id??'')) fail('ASSISTANT_HOOK_SESSION_REQUIRED');
    assertRuntimeHookBudget();
    const pass=validateAssistantActivePass(await readActivePass(),identity);
    if(event.session_id.toLowerCase()!==pass.threadId.toLowerCase()) fail('ASSISTANT_HOOK_TASK_MISMATCH');
    const intake=pass.kind==='source_intake';
    const locator=intake?{companyId:pass.companyId,sourceId:pass.sourceId,intakeId:pass.passId}
      :{companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId};
    const slot={origin:identity.origin,kind:'runtime',id:pass.passId};
    return lock(path.join(lockDirectory,`${pass.passId}.json`),async()=>{
      assertRuntimeHookBudget();
      const active=validateAssistantActivePass(await readActivePass(),identity);
      if(JSON.stringify(active)!==JSON.stringify(pass)) fail('ASSISTANT_HOOK_TASK_MISMATCH');
      const live=await client[intake?'readSourceIntake':'readTaskPass'](locator,runtimeHookSignal());
      const ending=event.hook_event_name==='SessionEnd';
      if((live.state!=='leased' && !(ending && (intake?['ignored','created','routed','waiting_owner','redirected','cancelled','reply_pending','replied'].includes(live.state):live.state==='closed')))
        || live.threadId!==pass.threadId || (intake?live.eventId!==pass.eventId || live.sourceRevision!==pass.sourceRevision
          ||pass.intakeKind==='route_existing'&&(live.kind!=='route_existing'||JSON.stringify(live.eventIds)!==JSON.stringify(pass.eventIds))
          :live.deliveryId!==pass.deliveryId || live.bindingId!==pass.bindingId || live.bindingRevision!==pass.bindingRevision)
        || !Number.isFinite(Date.parse(live.leaseExpiresAt)) || live.state==='leased' && Date.parse(live.leaseExpiresAt)<=now())
        fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      let record=await store.get(slot);
      if(record && (record.schemaVersion!==1 || record.passId!==pass.passId || record.threadId!==pass.threadId)) fail('ASSISTANT_HOOK_STATE_INVALID');
      if(event.hook_event_name==='SessionEnd') {
        if(record?.state?.runtimeSessionId && !record.ended) {
          // Persist the local end boundary before HTTP. A lost end reply must
          // not let the next hook sign with a remotely ended key. A later
          // initial registration safely retires any unended predecessor.
          await store.put(slot,{...record,ended:true});
          await client[intake?'endIntakeRuntime':'endRuntime']({...locator,runtimeSessionId:record.state.runtimeSessionId},runtimeHookSignal());
        }
        // Retain the same pass journal/key until host completion/recovery; an
        // ended native turn does not authorize a new business invocation.
        return {};
      }
      if(event.hook_event_name==='SessionStart') return event.source==='compact'
        ? {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:TRELIO_COMPACTION_RECOVERY_CONTEXT}} : {};
      if(event.hook_event_name!=='PreToolUse' || !/^[a-z][a-z0-9_]{0,159}$/u.test(toolName??'')) fail('ASSISTANT_HOOK_INVALID_INPUT');
      if(!event.tool_input || Object.getPrototypeOf(event.tool_input)!==Object.prototype) fail('ASSISTANT_HOOK_INVALID_INPUT');
      if(intake && !['get_assistant_intake_context','resolve_assistant_intake'].includes(toolName))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
      if(!intake && ['get_assistant_intake_context','resolve_assistant_intake'].includes(toolName))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
      const supplied=structuredClone(event.tool_input);
      delete supplied.intakePass;delete supplied.taskPass;delete supplied.runtimeSessionProof;
      delete supplied.sourceProcessingProof;
      delete supplied.encryptedMaterialWitness;
      delete supplied.encryptedContent;
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
        const registered=await client[intake?'registerIntakeRuntime':'registerRuntime']({...locator,clientSessionId:pass.threadId,observation,publicKeySpki,
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
      let sourceProcessingProof;
      if(toolName==='complete_assistant_pass'){
        const [{assistantSourceProcessingReferences},{assistantSourceProcessingProofPayload,assistantSourceProcessingProofTool}]=await Promise.all([
          import('./trelio-assistant-inbox.mjs'),import('./trelio-assistant-transport.mjs')]);
        const selected=assistantSourceProcessingReferences(supplied.processedSourceReferences??[]);
        if(selected.length){
          if(supplied.noChange!==false||!uuid.test(supplied.clientRequestId??'')||!uuid.test(supplied.workspaceId??'')
            ||!uuid.test(supplied.acceptedRunId??'')||!(/^[0-9a-f]{40,64}$/u).test(supplied.workspaceHead??'')
            ||typeof confirmSourceProcessing!=='function')fail('ASSISTANT_SOURCE_READ_REQUIRED');
          // Actual read slots come from the SAME protected SQLite snapshot,
          // independently of the model's explicit semantic selection. Fresh
          // source/pass checks never infer processing from a native turn.
          await confirmSourceProcessing(pass,selected);assertRuntimeHookBudget();
          const current=validateAssistantActivePass(await readActivePass(),identity);
          if(JSON.stringify(current)!==JSON.stringify(pass))fail('ASSISTANT_HOOK_TASK_MISMATCH');
          supplied.processedSourceReferences=selected;
          const manifest=assistantSourceProcessingProofPayload({...pass,clientRequestId:supplied.clientRequestId,
            workspaceId:supplied.workspaceId,workspaceHead:supplied.workspaceHead,acceptedRunId:supplied.acceptedRunId,references:selected});
          sourceProcessingProof=buildRuntimeSessionProof({state,toolName:assistantSourceProcessingProofTool(
            crypto.createHash('sha256').update(manifest).digest('hex')),now:new Date(now())});
        }
      }
      return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...supplied,
        ...(sourceProcessingProof?{sourceProcessingProof}:{}),
        ...(intake?{intakePass:locator}:{taskPass:locator}),runtimeSessionProof:buildRuntimeSessionProof({state,toolName,now:new Date(now())})}}};
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
const sameIdentity=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
/** Native owner approval distinguishes enrolling an additional computer from
 * replacing this exact old host. This validator is not an approval source: the
 * setup engine accepts it only from its fixed authenticated native transport.
 * Both old UUIDs are mandatory so a same-owner, different-assistant device can
 * never be inferred from a display name or a stale local record. */
export const validateAssistantActivationAuthorization=value=>{
  if(!exactObject(value,['schemaVersion','mode','assistantUserId','replacesAssistantUserId','replacesDeviceId','authorizationId'])
    ||value.schemaVersion!==1||!['initial','replace'].includes(value.mode)
    ||!uuid.test(value.assistantUserId??'')||!uuid.test(value.authorizationId??'')
    ||(value.mode==='initial'?(value.replacesAssistantUserId!==null||value.replacesDeviceId!==null)
      :!uuid.test(value.replacesAssistantUserId??'')||!uuid.test(value.replacesDeviceId??'')))fail('ASSISTANT_HOST_ACTIVATION_INVALID');
  return Object.fromEntries(['schemaVersion','mode','assistantUserId','replacesAssistantUserId','replacesDeviceId','authorizationId']
    .map(key=>[key,value[key]]));
};
const activationRecord=value=>{
  if(!exactObject(value,['schemaVersion','enrollmentId','previous','next','authorization','stage'])
    ||value.schemaVersion!==1||!uuid.test(value.enrollmentId??'')||!['pending_owner','released','quiescing','active'].includes(value.stage))
    fail('ASSISTANT_HOST_ACTIVATION_INVALID');
  const previous=value.previous===null?null:validate(value.previous);
  if(['pending_owner','released'].includes(value.stage)){
    if(previous===null||value.next!==null||value.authorization!==null)fail('ASSISTANT_HOST_ACTIVATION_INVALID');
    return {schemaVersion:1,enrollmentId:value.enrollmentId,previous,next:null,authorization:null,stage:value.stage};
  }
  const next=validate(value.next);
  const authorization=validateAssistantActivationAuthorization(value.authorization);
  if(authorization.assistantUserId!==next.assistantId
    ||previous===null&&authorization.mode!=='initial'
    ||previous!==null&&(authorization.mode!=='replace'||previous.origin!==next.origin
      ||authorization.replacesAssistantUserId!==previous.assistantId||authorization.replacesDeviceId!==previous.deviceId))
    fail('ASSISTANT_HOST_ACTIVATION_INVALID');
  return {schemaVersion:1,enrollmentId:value.enrollmentId,previous,next,authorization,stage:value.stage};
};
/** Technical updater journal, not task/owner authority or a trust store. The
 * current paired identity and exact native version/tree are retained; no tool
 * input, credential, hook hash/approval, process path or business text belongs
 * here. A pending/failed update is never evidence that an action can be replayed. */
const pluginUpdateRecord = value => {
  const keys='assistantId,desktopGeneration,deviceId,failedVersion,failures,previousTreeSha256,previousVersion,restarts,schemaVersion,stage,targetTreeSha256,targetVersion';
  const actual=value&&Object.keys(value).filter(key=>key!=='hookComponent').sort().join(',');
  const component=value?.hookComponent;
  if (!value || Object.getPrototypeOf(value)!==Object.prototype
    || actual!==keys
    || value.schemaVersion!==1 || !uuid.test(value.assistantId??'') || !uuid.test(value.deviceId??'')
    || !['ready','installing','installed','hook_installing','closing','starting','verifying','hook_review','retargeting','rolling_back','failed'].includes(value.stage)
    || ![value.previousVersion,value.targetVersion].every(v=>typeof v==='string'&&/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(v))
    || !/^[0-9a-f]{64}$/u.test(value.previousTreeSha256??'')
    || value.failedVersion!==null&&!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(value.failedVersion??'')
    || !Number.isSafeInteger(value.failures)||value.failures<0||value.failures>3
    || value.targetTreeSha256!==null && !/^[0-9a-f]{64}$/u.test(value.targetTreeSha256??'')
    || value.desktopGeneration!==null && !/^[1-9]\d{0,9}:[0-9]{1,20}$/u.test(value.desktopGeneration??'')
    || !Number.isSafeInteger(value.restarts) || value.restarts<0 || value.restarts>2
    || Object.hasOwn(value,'hookComponent')&&(!component||Object.getPrototypeOf(component)!==Object.prototype
      ||Object.keys(component).sort().join(',')!=='integritySha256,pluginId,previousVersion,version'
      ||component.pluginId!=='trelio-digital-assistant-hooks@trelio-digital-assistants'
      ||!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(component.version??'')
      ||component.previousVersion!==null&&!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(component.previousVersion??'')
      ||!/^[a-f0-9]{64}$/u.test(component.integritySha256??''))
    ||value.stage==='hook_installing'&&component===undefined)
    fail('ASSISTANT_PLUGIN_UPDATE_STATE_INVALID');
  return value;
};

export const createAssistantHostState=({directory,store,primitives={}})=>{
  if(!path.isAbsolute(directory??'') || !store) fail('ASSISTANT_HOST_STATE_INVALID');
  const ops={ensurePrivateDirectory,assertPrivatePathKind,readPrivateJsonFile,writePrivateJsonFile,...primitives};
  const file=path.join(directory,'identity.json');
  const activationFile=path.join(directory,'activation.json');
  const maintenanceFile=async name=>{
    const identity=await readIdentity();if(!identity)fail('ASSISTANT_HOST_NOT_CONFIGURED');
    const root=path.join(directory,'plugin-maintenance',identity.assistantId,identity.deviceId);
    await ops.ensurePrivateDirectory(root);return path.join(root,`${name}.json`);
  };
  const readActivation=async()=>{
    await ops.ensurePrivateDirectory(directory);
    try{await ops.assertPrivatePathKind(activationFile,'file');}catch(error){if(error.code==='ENOENT')return null;throw error;}
    return activationRecord(await ops.readPrivateJsonFile(activationFile,{maximumBytes:8192}));
  };
  const readIdentity=async()=>{
    await ops.ensurePrivateDirectory(directory);
    try{await ops.assertPrivatePathKind(file,'file');}catch(error){if(error.code==='ENOENT')return null;throw error;}
    return validate(await ops.readPrivateJsonFile(file,{maximumBytes:4096}));
  };
  return {
    readIdentity,
    readActivation,
    // This separate per-device opt-in must never inherit plugin-update consent.
    // Missing policy means disabled, including every existing installation.
    async readCodexUpdatesEnabled(){
      const target=await maintenanceFile('codex-policy');
      try{await ops.assertPrivatePathKind(target,'file');}catch(error){if(error.code==='ENOENT')return false;throw error;}
      const value=await ops.readPrivateJsonFile(target,{maximumBytes:4096}),current=await readIdentity();
      if(!value||Object.keys(value).sort().join(',')!=='assistantId,autoUpdateCodex,deviceId,schemaVersion'
        ||value.schemaVersion!==1||typeof value.autoUpdateCodex!=='boolean'||!current
        ||value.assistantId!==current.assistantId||value.deviceId!==current.deviceId)fail('ASSISTANT_CODEX_UPDATE_FAILED');
      return value.autoUpdateCodex;
    },
    async setCodexUpdatesEnabled(enabled,expectedIdentity){
      const current=await readIdentity();
      if(typeof enabled!=='boolean'||!current||['origin','assistantId','deviceId'].some(key=>current[key]!==expectedIdentity[key]))
        fail('ASSISTANT_HOST_REBIND_REQUIRED');
      if(enabled&&await this.readActivePass()!==null)fail('ASSISTANT_LOCAL_SETUP_TASK_ACTIVE');
      await ops.writePrivateJsonFile(await maintenanceFile('codex-policy'),{schemaVersion:1,assistantId:current.assistantId,deviceId:current.deviceId,autoUpdateCodex:enabled});
      if(await this.readCodexUpdatesEnabled()!==enabled)fail('ASSISTANT_CODEX_UPDATE_FAILED');
    },
    async codexUpdatePackagePath(){
      const target=await maintenanceFile('codex-update');
      const directory=path.join(path.dirname(target),'desktop-code');
      await ops.ensurePrivateDirectory(directory);return path.join(directory,'desktop.msix');
    },
    async readCodexUpdate(){
      const target=await maintenanceFile('codex-update');
      try{await ops.assertPrivatePathKind(target,'file');}catch(error){if(error.code==='ENOENT')return null;throw error;}
      const value=validateAssistantCodexUpdate(await ops.readPrivateJsonFile(target,{maximumBytes:4096})),current=await readIdentity();
      if(!current||value.assistantId!==current.assistantId||value.deviceId!==current.deviceId)fail('ASSISTANT_HOST_REBIND_REQUIRED');
      return value;
    },
    async writeCodexUpdate(expected,value){
      const next=validateAssistantCodexUpdate(value),current=await readIdentity();
      if(!current||next.assistantId!==current.assistantId||next.deviceId!==current.deviceId
        ||JSON.stringify(await this.readCodexUpdate())!==JSON.stringify(expected))fail('ASSISTANT_CODEX_UPDATE_FAILED');
      await ops.writePrivateJsonFile(await maintenanceFile('codex-update'),next);
      if(JSON.stringify(await this.readCodexUpdate())!==JSON.stringify(next))fail('ASSISTANT_CODEX_UPDATE_FAILED');
    },
    async readPluginUpdatesEnabled(){
      const pluginPolicyFile=await maintenanceFile('policy');
      try{await ops.assertPrivatePathKind(pluginPolicyFile,'file');}catch(error){if(error.code==='ENOENT')return false;throw error;}
      const value=await ops.readPrivateJsonFile(pluginPolicyFile,{maximumBytes:4096}),current=await readIdentity();
      if(!value||Object.keys(value).sort().join(',')!=='assistantId,autoUpdatePlugin,deviceId,schemaVersion'
        ||value.schemaVersion!==1||typeof value.autoUpdatePlugin!=='boolean'||!current
        ||value.assistantId!==current.assistantId||value.deviceId!==current.deviceId)fail('ASSISTANT_PLUGIN_UPDATE_STATE_INVALID');
      return value.autoUpdatePlugin;
    },
    async setPluginUpdatesEnabled(enabled,expectedIdentity,{ownTaskWriteVerified=false}={}){
      const pluginPolicyFile=await maintenanceFile('policy');
      const current=await readIdentity();
      if(typeof enabled!=='boolean'||!current||['origin','assistantId','deviceId'].some(k=>current[k]!==expectedIdentity[k]))
        fail('ASSISTANT_HOST_REBIND_REQUIRED');
      // A business task cannot grant itself this machine-wide setup policy.
      // Disabling remains safe immediately; granting waits for the idle host.
      if(enabled&&await this.readActivePass()!==null)fail('ASSISTANT_LOCAL_SETUP_TASK_ACTIVE');
      await ops.writePrivateJsonFile(pluginPolicyFile,{schemaVersion:1,assistantId:current.assistantId,deviceId:current.deviceId,autoUpdatePlugin:enabled});
      if(await this.readPluginUpdatesEnabled()!==enabled)fail('ASSISTANT_PLUGIN_UPDATE_STATE_INVALID');
      // Only a NEW explicit setup operation, after its exact native registration
      // verified the principal's own write access, may resume a failed initial
      // host handoff. No plugin was installed/restarted in this narrow state.
      // Polling, a bare policy write and failures of a different candidate keep
      // their latch; no provider/business action or hook approval is repeated.
      if(enabled&&ownTaskWriteVerified===true){
        const failed=await this.readPluginUpdate();
        if(failed?.stage==='failed'&&failed.previousVersion===failed.targetVersion
          &&failed.previousTreeSha256===failed.targetTreeSha256&&failed.failedVersion===failed.targetVersion
          &&failed.desktopGeneration===null&&failed.restarts===0){
          await this.writePluginUpdate(failed,{...failed,stage:'retargeting',failures:0,failedVersion:null});
        }
      }
    },
    async readPluginUpdate(){
      const pluginUpdateFile=await maintenanceFile('update');
      try{await ops.assertPrivatePathKind(pluginUpdateFile,'file');}catch(error){if(error.code==='ENOENT')return null;throw error;}
      const value=pluginUpdateRecord(await ops.readPrivateJsonFile(pluginUpdateFile,{maximumBytes:4096}));
      const current=await readIdentity();
      if(!current||value.assistantId!==current.assistantId||value.deviceId!==current.deviceId)fail('ASSISTANT_HOST_REBIND_REQUIRED');
      return value;
    },
    async writePluginUpdate(expected,value){
      const pluginUpdateFile=await maintenanceFile('update');
      const next=pluginUpdateRecord(value),current=await readIdentity();
      if(!current||next.assistantId!==current.assistantId||next.deviceId!==current.deviceId
        || JSON.stringify(await this.readPluginUpdate())!==JSON.stringify(expected))fail('ASSISTANT_PLUGIN_UPDATE_STATE_INVALID');
      await ops.writePrivateJsonFile(pluginUpdateFile,next);
      if(JSON.stringify(await this.readPluginUpdate())!==JSON.stringify(next))fail('ASSISTANT_PLUGIN_UPDATE_STATE_INVALID');
      return next;
    },
    async readPluginSupervisor(){
      const target=await maintenanceFile('supervisor');
      try{await ops.assertPrivatePathKind(target,'file');}catch(error){if(error.code==='ENOENT')return null;throw error;}
      const value=await ops.readPrivateJsonFile(target,{maximumBytes:4096}),current=await readIdentity();
      if(!value||Object.keys(value).sort().join(',')!=='assistantId,deviceId,generation,runtimeVersion,schemaVersion'
        ||value.schemaVersion!==1||!current||value.assistantId!==current.assistantId||value.deviceId!==current.deviceId
        ||!uuid.test(value.generation??'')||!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(value.runtimeVersion??''))
        fail('ASSISTANT_PLUGIN_UPDATE_STATE_INVALID');
      return value;
    },
    async recordPluginSupervisor(runtimeVersion,generation,expectedIdentity){
      const current=await readIdentity();
      if(!current||['origin','assistantId','deviceId'].some(key=>current[key]!==expectedIdentity[key])
        ||!uuid.test(generation??'')||!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(runtimeVersion??''))fail('ASSISTANT_HOST_REBIND_REQUIRED');
      const value={schemaVersion:1,assistantId:current.assistantId,deviceId:current.deviceId,runtimeVersion,generation};
      await ops.writePrivateJsonFile(await maintenanceFile('supervisor'),value);
      if(JSON.stringify(await this.readPluginSupervisor())!==JSON.stringify(value))fail('ASSISTANT_PLUGIN_UPDATE_STATE_INVALID');
    },
    withSetupLock:action=>(ops.withSetupLock??(run=>withRuntimeStateLock(path.join(directory,'setup'),run)))(action),
    async prepareSetupIntent(enrollmentId){
      const current=await readIdentity(),old=await readActivation();
      if(!current||!uuid.test(enrollmentId??''))fail('ASSISTANT_HOST_STATE_INVALID');
      if(old&&['pending_owner','quiescing'].includes(old.stage)){
        if(old.enrollmentId!==enrollmentId||!sameIdentity(current,old.previous))fail('ASSISTANT_HOST_REBIND_REQUIRED');
        return old;
      }
      const pending=await store.get({origin:current.origin,kind:'pass',id:current.deviceId});
      if(pending!==null)fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      const next=activationRecord({schemaVersion:1,enrollmentId,previous:current,next:null,authorization:null,stage:'pending_owner'});
      await ops.writePrivateJsonFile(activationFile,next);
      if(JSON.stringify(await readActivation())!==JSON.stringify(next))fail('ASSISTANT_HOST_ACTIVATION_INVALID');
      return next;
    },
    /** A rejected/expired native enrollment and the unchanged protected old
     * identity may release ONLY this pending denial. Never release an activation
     * authorization, a pass or an unknown exchange by local age/expiry alone. */
    async releaseSetupIntent(enrollmentId){
      const old=await readActivation(),current=await readIdentity();
      if(old===null||old.enrollmentId!==enrollmentId||old.stage!=='pending_owner')return;
      if(!sameIdentity(current,old.previous)||await store.get({origin:current.origin,kind:'pass',id:current.deviceId})!==null)
        fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      await ops.writePrivateJsonFile(activationFile,{...old,stage:'released'});
      if((await readActivation()).stage!=='released')fail('ASSISTANT_HOST_ACTIVATION_INVALID');
    },
    /** Only setup calls this under the existing host mutex. The structural
     * quiesce record is durable before any credential/identity replacement;
     * current passes retain their original protected slots and must settle. */
    async prepareActivation(input){
      const next=activationRecord({...input,schemaVersion:1,stage:'quiescing'});
      const old=await readActivation(),current=await readIdentity();
      if(old?.enrollmentId===next.enrollmentId&&old.stage!=='pending_owner'&&old.stage!=='released'){
        if(JSON.stringify({...old,stage:'quiescing'})!==JSON.stringify(next))fail('ASSISTANT_HOST_ACTIVATION_INVALID');
        return old;
      }
      if(old&&['pending_owner','quiescing'].includes(old.stage)
        &&(old.enrollmentId!==next.enrollmentId||!sameIdentity(old.previous,next.previous)))fail('ASSISTANT_HOST_REBIND_REQUIRED');
      if(JSON.stringify(current)!==JSON.stringify(next.previous))fail('ASSISTANT_HOST_REBIND_REQUIRED');
      await ops.writePrivateJsonFile(activationFile,next);
      if(JSON.stringify(await readActivation())!==JSON.stringify(next))fail('ASSISTANT_HOST_ACTIVATION_INVALID');
      return next;
    },
    async assertActivationQuiescent(input){
      const expected=activationRecord(input),current=await readIdentity();
      if(JSON.stringify(await readActivation())!==JSON.stringify(expected)
        ||![JSON.stringify(expected.previous),JSON.stringify(expected.next)].includes(JSON.stringify(current)))
        fail('ASSISTANT_HOST_REBIND_REQUIRED');
      if(expected.previous!==null){
        const pending=await store.get({origin:expected.previous.origin,kind:'pass',id:expected.previous.deviceId});
        if(pending!==null)fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      }
    },
    async commitActivation(input){
      const expected=activationRecord(input);
      if(expected.stage!=='quiescing')fail('ASSISTANT_HOST_ACTIVATION_INVALID');
      await this.assertActivationQuiescent(expected);
      const current=await readIdentity();
      if(JSON.stringify(current)!==JSON.stringify(expected.next))await ops.writePrivateJsonFile(file,expected.next);
      if(JSON.stringify(await readIdentity())!==JSON.stringify(expected.next))fail('ASSISTANT_HOST_STATE_INVALID');
      const complete={...expected,stage:'active'};
      await ops.writePrivateJsonFile(activationFile,complete);
      if(JSON.stringify(await readActivation())!==JSON.stringify(complete))fail('ASSISTANT_HOST_ACTIVATION_INVALID');
      return complete;
    },
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
      const intake=pass.kind==='source_intake';
      if(outcome?.schemaVersion!==1 || (intake?!['ignored','created','routed','waiting_owner','redirected','cancelled','replied'].includes(outcome.state):outcome.state!=='confirmed')
        || !uuid.test(outcome.receiptId??'') || (intake?outcome.id!==pass.passId || outcome.sourceId!==pass.sourceId || outcome.eventId!==pass.eventId||outcome.threadId!==pass.threadId||outcome.sourceRevision!==pass.sourceRevision
          ||pass.intakeKind==='route_existing'&&(outcome.kind!=='route_existing'||JSON.stringify(outcome.eventIds)!==JSON.stringify(pass.eventIds))
          :['assistantId','deviceId','companyId','taskId','bindingId','bindingRevision','deliveryId','threadId'].some(key=>outcome[key]!==pass[key])))
        fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      // The backend already ended these signing sessions. Remove their local
      // private key before freeing the active journal; a crash between removals
      // leaves a recoverable closed pass rather than a retained signing key.
      await store.remove({origin:identity.origin,kind:'runtime',id:pass.passId});
      await store.remove(slot);
    },
  };
};
