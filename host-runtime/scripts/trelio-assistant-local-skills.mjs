/** Ordinary-chat catalogue/skill adapter. All data and execution still belong to
 * the native skill readers, signed package/account engine and protected input
 * forms. This module grants no task, monitoring source or external-action authority. */
import path from 'node:path';
import { assistantSkillCatalogueDirectory, loadAssistantDeviceCredential,
  hydrateAssistantEncryptedSkill, projectAssistantSetupCompanies, readAssistantEncryptedSnapshotBundle } from './trelio-assistant-transport.mjs';
import { parseAccountCommand } from './trelio-skill-accounts.mjs';
import { parseVisualSkillOutput, visualMcpResult } from './trelio-visual-result.mjs';
import { readSkillSecretSetupCommand, deliverSkillSetupEnvironment } from './trelio-skill-secret-setup.mjs';
import { browserControllerEnabled, parseBrowserControllerArguments, runBrowserControllerCommand } from './trelio-browser-session.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SKILL=/^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PREFIX='/api/digital-assistants/runtime/source-skills/skills';
const SETUP_HEADER='x-trelio-assistant-local-skill-setup';
const object=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
const fail=(code='ASSISTANT_LOCAL_SKILL_SETUP_CHANGED')=>{throw Object.assign(new Error(code),{code});};
const id=v=>{if(!UUID.test(v??''))fail('ASSISTANT_SETUP_INVALID_INPUT');return v.toLowerCase();};
const schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const nullableId={anyOf:[{type:'string',pattern:UUID.source},{type:'null'}]};
const skill={type:'string',pattern:SKILL.source,maxLength:120};
// Closed shared-controller refusals may reach the model; private owner files,
// input data and arbitrary provider exceptions may not become diagnostics.
export const ASSISTANT_SKILL_FAILURE_CODES=Object.freeze(['BROWSER_CONTROLLER_ARGUMENTS_INVALID','BROWSER_CONTROLLER_POLICY_INVALID',
  'BROWSER_CONTROLLER_BINDING_REQUIRED','BROWSER_CONTROLLER_SESSION_UNAVAILABLE','BROWSER_CONTROLLER_STORAGE_UNSAFE',
  'BROWSER_CONTROLLER_TRANSPORT_UNKNOWN','BROWSER_CONTROLLER_COMMAND_DENIED']);
export const ASSISTANT_SKILL_TOOLS=Object.freeze([
  {name:'list_assistant_skills',description:'Read the complete enabled Trelio company/project skill catalogue in this ordinary chat, without a task or Run. This is the skill inventory, unlike the three Telegram/email/MAX background-source setup tools. Use companyId:null for native company selection; paginate while hasMore. Set skillId for the exact published instructions/connection guidance before setup. Do this before searching for a separate plugin. No credentials or provider execution.',
    inputSchema:schema({companyId:nullableId,projectId:nullableId,skillId:{anyOf:[skill,{type:'null'}]},
      offset:{type:'integer',minimum:0,maximum:10000},limit:{type:'integer',minimum:1,maximum:50}}),annotations:{readOnlyHint:true,idempotentHint:true}},
  {name:'use_assistant_skill',description:'Use or configure an enabled skill in this ordinary owner chat without a task or Run. Read its exact list_assistant_skills instructions first and pass skill.currentReleaseId as releaseId. Uses the SAME signed package, commands, account selector and protected forms as human users; no assistant-specific setup declaration is required. For run, parameters.arguments is the literal argv from those instructions, including ordinary account list/create/--local-account. Human credentials stay in the protected form. Other operations use the SAME Remote MCP connect/doctor/call and exact write approval; doctor_remote accepts optional parameters.schemaToolName for its exact input schema. External changes still require the user request. Reuse clientRequestId after uncertainty; never replay an attempted command. Background task/intake tools retain their independent restrictions.',
    inputSchema:schema({companyId:nullableId,projectId:nullableId,skillId:skill,releaseId:nullableId,clientRequestId:{type:'string',pattern:UUID.source},
      operation:{type:'string',enum:['run','connect_remote','doctor_remote','call_remote']},
      parameters:{anyOf:[schema({arguments:{type:'array',minItems:1,maxItems:128,items:{type:'string',maxLength:16384}}}),
        {type:'object',properties:{},additionalProperties:false},schema({schemaToolName:{type:'string',minLength:1,maxLength:200}}),
        schema({toolName:{type:'string',minLength:1,maxLength:200},arguments:{type:'object'}})]}}),annotations:{idempotentHint:false}},
]);
export const assistantLocalSkillArguments=(name,input)=>{
  // The trusted PreToolUse hook adds the SAME v1 proof AFTER the model authors
  // a call. It is intentionally absent from public tool schemas. Strict local
  // framing precedes private I/O; native shared signature/nonce validation is
  // authoritative and never trusts model-supplied observation or scope flags.
  let runtimeSessionProof;
  if(name==='use_assistant_skill'&&object(input)&&Object.hasOwn(input,'runtimeSessionProof')){
    ({runtimeSessionProof,...input}=input);
    if(!object(runtimeSessionProof)||Object.keys(runtimeSessionProof).sort().join(',')!=='issuedAt,nonce,runtimeSessionId,schemaVersion,signature'
      ||runtimeSessionProof.schemaVersion!==1||!UUID.test(runtimeSessionProof.runtimeSessionId??'')||!UUID.test(runtimeSessionProof.nonce??'')
      ||typeof runtimeSessionProof.issuedAt!=='string'||runtimeSessionProof.issuedAt.length>64||!Number.isFinite(Date.parse(runtimeSessionProof.issuedAt))
      ||typeof runtimeSessionProof.signature!=='string'||!/^[A-Za-z0-9_-]{40,160}$/u.test(runtimeSessionProof.signature))fail('ASSISTANT_SETUP_INVALID_INPUT');
  }
  const expected=name==='list_assistant_skills'?'companyId,limit,offset,projectId,skillId'
    :name==='use_assistant_skill'?'clientRequestId,companyId,operation,parameters,projectId,releaseId,skillId':null;
  if(!expected||!object(input)||Object.keys(input).sort().join(',')!==expected)fail('ASSISTANT_SETUP_INVALID_INPUT');
  const result={...input,companyId:input.companyId===null?null:id(input.companyId),projectId:input.projectId===null?null:id(input.projectId)};
  if(input.skillId!==null&&(typeof input.skillId!=='string'||input.skillId.length>120||!SKILL.test(input.skillId)))fail('ASSISTANT_SETUP_INVALID_INPUT');
  if(name==='list_assistant_skills'){
    if(!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>10000||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>50)fail('ASSISTANT_SETUP_INVALID_INPUT');
  }else{
    result.clientRequestId=id(input.clientRequestId);
    result.releaseId=input.releaseId===null?null:id(input.releaseId);
    if(input.skillId===null||!object(input.parameters))fail('ASSISTANT_SETUP_INVALID_INPUT');
    const keys=Object.keys(input.parameters).sort().join(',');
    if(input.operation==='run'){
      const args=input.parameters.arguments;
      if(keys!=='arguments'||!Array.isArray(args)||!args.length||args.length>128
        ||args.some(value=>typeof value!=='string'||value.length>16384||value.includes('\0')))
        fail('ASSISTANT_SETUP_INVALID_INPUT');
    }else if(input.operation==='doctor_remote'){
      if(keys&&(keys!=='schemaToolName'||typeof input.parameters.schemaToolName!=='string'
        ||!input.parameters.schemaToolName.length||input.parameters.schemaToolName.length>200))fail('ASSISTANT_SETUP_INVALID_INPUT');
    }else if(input.operation==='connect_remote'){
      if(keys)fail('ASSISTANT_SETUP_INVALID_INPUT');
    }else if(input.operation==='call_remote'){
      if(keys!=='arguments,toolName'||typeof input.parameters.toolName!=='string'||!input.parameters.toolName.length
        ||input.parameters.toolName.length>200||!object(input.parameters.arguments))fail('ASSISTANT_SETUP_INVALID_INPUT');
    }else fail('ASSISTANT_SETUP_INVALID_INPUT');
    if(Buffer.byteLength(JSON.stringify(input.parameters))>65536)fail('ASSISTANT_SETUP_INVALID_INPUT');
  }
  return {...result,...(runtimeSessionProof?{runtimeSessionProof}:{})};
};

/** Ordinary-chat observation reuses the SAME session/key/refresh/proof engine
 * as tasks, with its own device-bound slot in the EXISTING OS private store.
 * No fake task/pass, human journal, model-selected identity or new hook trust. */
export const createAssistantLocalSkillHook=({identity,host,store,client,common,observe=null,lock=null,now=Date.now})=>async event=>{
  if(!UUID.test(event?.session_id??''))fail('ASSISTANT_HOOK_SESSION_REQUIRED');
  let supplied,input;
  if(event.hook_event_name==='PreToolUse'){
    if(!object(event.tool_input))fail('ASSISTANT_SETUP_INVALID_INPUT');
    supplied={...event.tool_input};delete supplied.runtimeSessionProof;
    input=assistantLocalSkillArguments('use_assistant_skill',supplied);
  }
  // Catalogue/ordinary request workers must not load the hook observer/key
  // lifecycle just to list two schemas or forward a closed failure frame.
  // Lazy loading stays inside the hook's ORIGINAL private-session deadline.
  const [{ensureObservedAssistantSession},{detectAgentRuntimeAttestation},
    {buildRuntimeSessionProof,withRuntimeStateLock},{assertRuntimeHookBudget,runtimeHookSignal}]=await Promise.all([
      import('./trelio-assistant-hook.mjs'),import('./trelio-runtime-attestation.mjs'),
      import('./trelio-runtime-session.mjs'),import('./trelio-hook-private-session.mjs')]);
  if(await host.readActivePass())fail('ASSISTANT_LOCAL_SETUP_TASK_ACTIVE');
  const threadId=event.session_id.toLowerCase(),slot={origin:identity.origin,kind:'local_runtime',id:threadId,deviceId:identity.deviceId};
  const config=host.configurationDirectory??(common??await import('./trelio-workspace.mjs')).resolveWorkspaceBridgeConfigDirectory();
  return (lock??withRuntimeStateLock)(path.join(config,'digital-assistants','runtime-locks',`local-${threadId}.json`),async()=>{
    assertRuntimeHookBudget();
    const record=await store.get(slot);
    if(record&&(record.schemaVersion!==1||record.assistantId!==identity.assistantId||record.deviceId!==identity.deviceId
      ||record.threadId!==threadId||!UUID.test(record.companyId??'')||record.projectId!==null&&!UUID.test(record.projectId??'')))fail('ASSISTANT_HOOK_STATE_INVALID');
    if(event.hook_event_name==='SessionEnd'){
      if(record?.state?.runtimeSessionId&&!record.ended){
        await store.put(slot,{...record,ended:true});
        await withAssistantLocalSkillProfile({identity,host,store,client,common,companyId:record.companyId,signal:runtimeHookSignal(),configure:true},
          context=>context.requestJson('/runtime/end',{companyId:record.companyId,projectId:record.projectId,runtimeSessionId:record.state.runtimeSessionId}));
      }
      return {};
    }
    if(event.hook_event_name!=='PreToolUse')return {};
    let companyId=input.companyId;
    if(companyId===null){
      const companies=projectAssistantSetupCompanies(await client.companies(runtimeHookSignal()));
      // The actual tool returns the ordinary company-selection result; no
      // runtime observation or provider/account invocation occurs yet.
      if(companies.length!==1)return {};
      companyId=companies[0].companyId;
    }
    const observation=await(observe??detectAgentRuntimeAttestation)({hookInput:event});assertRuntimeHookBudget();
    if(observation?.schemaVersion!==1||observation.clientFamily!=='codex'||observation.source!=='codex_hook'
      ||observation.evidenceLevel!=='local_observed'||!observation.modelId)fail('ASSISTANT_HOOK_OBSERVATION_REQUIRED');
    const state=await ensureObservedAssistantSession({record,slot,store,observation,now,
      binding:{schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,threadId,companyId,projectId:input.projectId},
      register:fields=>withAssistantLocalSkillProfile({identity,host,store,client,common,companyId,signal:runtimeHookSignal(),configure:true},
        context=>context.requestJson('/runtime/register',{companyId,projectId:input.projectId,clientSessionId:threadId,...fields})),
      validateRegistered:value=>value.companyId===companyId&&value.projectId===input.projectId&&value.conversation?.conversationId===threadId});
    if(await host.readActivePass())fail('ASSISTANT_LOCAL_SETUP_TASK_ACTIVE');
    return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...supplied,
      runtimeSessionProof:buildRuntimeSessionProof({state,toolName:'use_assistant_skill',now:new Date(now())})}}};
  });
};

/** Only exact native setup endpoints can receive the private credential. The
 * opaque token is unusable by the human path, and the closed async profile is
 * tombstoned when the invocation ends. No profile/cache/secret import occurs.
 * Every native resolve/package/consent repeats the device/intent/ACL checks. */
export const withAssistantLocalSkillProfile=async({identity,host,store,client,companyId,signal,configure=false,common},action)=>{
  common??=await import('./trelio-workspace.mjs');
  const origin=new URL(identity.origin).origin;
  if(origin!==identity.origin||!identity.origin.startsWith('https:')||!UUID.test(identity.assistantId??'')||!UUID.test(identity.deviceId??''))fail();
  companyId=id(companyId);
  const expected={schemaVersion:1,...identity},token=Object.freeze(Object.create(null));
  const budget=AbortSignal.timeout(configure?600000:45000);
  signal=signal?AbortSignal.any([signal,budget]):budget;
  let plan=null,attemptId=null,execution=null,processUsed=false,companySlug=null,fingerprint=null;
  const assertCurrent=async()=>{
    signal.throwIfAborted();
    const current=await host.readIdentity();
    if(!current||['schemaVersion','origin','assistantId','deviceId'].some(key=>current[key]!==expected[key])
      ||await host.readActivePass())fail('ASSISTANT_LOCAL_SETUP_TASK_ACTIVE');
    signal.throwIfAborted();
  };
  await assertCurrent();
  const binding=()=>({companyId,requestId:plan.requestId,...(attemptId?{attemptId}:{})});
  const requestJson=async(suffix,body)=>{
    const response=await common.request(origin,token,PREFIX+suffix,{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const bytes=await common.readBoundedResponseBuffer(response,3*1024*1024,'Assistant skill setup');
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
  };
  const openCompany=async company=>{
    if(company.id!==companyId||typeof company.slug!=='string')fail();
    companySlug=company.slug;
    return common.ensureCompanyEncryptionContext({origin,token,company:{id:companyId,slug:companySlug},collectEncryptionKey:async()=>fail('ASSISTANT_SOURCE_ENCRYPTION_UNAVAILABLE')});
  };
  const hydrateRuntime=async raw=>hydrateAssistantEncryptedSkill({raw,bundle:raw.assistantEncryption,common,origin,token,companyId,
    assistantId:identity.assistantId,fingerprint,openCompany,assertCurrent,signal,taskRuntimeMetadata:true});
  const hydrateSnapshot=async value=>{
    const bundle=value?.managedEncryptedContent;
    if(!bundle)return value;
    if(bundle.companyId!==companyId||bundle.schemaVersion!==1||!object(bundle.context)||!Array.isArray(bundle.encryptedPayloads)
      ||bundle.encryptedPayloads.length>250||!fingerprint)fail();
    const companies=await client.companies(signal),selected=companies.find(row=>row.companyId===companyId);
    if(!selected?.companySlug)fail();
    const opened=await openCompany({id:companyId,slug:selected.companySlug});
    if(opened.runtime.viewer?.userId!==identity.assistantId||opened.runtime.device?.id!==bundle.recipientDeviceId
      ||opened.runtime.envelope?.id!==bundle.envelopeId||opened.runtime.scope?.id!==bundle.scopeId
      ||opened.runtime.scope?.epoch!==bundle.scopeEpoch||opened.runtime.device?.fingerprint!==fingerprint)fail();
    const {payloads}=readAssistantEncryptedSnapshotBundle({schemaVersion:1,context:bundle.context,encryptedPayloads:bundle.encryptedPayloads},opened,companyId);
    const hydrated=await common.hydrateAgentCompanyEncryptedJson({value:bundle.context,origin,token,companyEncryption:opened,signal,
      resolvePayloads:async ids=>{if(ids.some(id=>!payloads.has(id)))fail();return {payloads:ids.map(id=>payloads.get(id))};}});
    await assertCurrent();return hydrated;
  };
  const begin=async commandId=>{
    await assertCurrent();if(!plan||processUsed)fail();
    // One native receipt covers one invocation. Account changes, local provider
    // commands and Remote MCP use this SAME pre-dispatch fence. A lost reply
    // never reopens the invocation, even though its actual outcome is unknown.
    processUsed=true;
    const begun=await requestJson('/begin',{companyId,clientRequestId:plan.requestId,commandId});
    if(begun.state!=='attempted'||begun.requestId!==plan.requestId||!UUID.test(begun.attemptId??''))fail();
    attemptId=begun.attemptId;await assertCurrent();
  };
  const nativeFence=async()=>{
    await assertCurrent();if(!plan)fail();
    const response=await common.request(origin,token,'/api/agent-workspaces/bridge-compatibility',{signal});
    const bytes=await common.readBoundedResponseBuffer(response,512*1024,'Assistant interactive skill fence');
    bytes.fill(0);await assertCurrent();
  };
  const profile={kind:'digital_assistant',interactiveLocal:true,companyEncryptionUserId:identity.assistantId,
    async requireToken(requestOrigin){if(requestOrigin!==origin)fail();await assertCurrent();return token;},
    async resolveCompanyEncryptionDevice({origin:requestedOrigin,companyId:requestedCompany}){
      if(requestedOrigin!==origin||requestedCompany!==companyId)fail();
      const {resolveAssistantCompanyEncryptionDevice}=await import('./trelio-assistant-private.mjs');
      const device=await resolveAssistantCompanyEncryptionDevice({identity:expected,companyId,store,assertCurrent,allowCreate:false,
        lockDirectory:path.join(host.configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','encryption-locks')});
      if(device.fingerprint!==fingerprint)fail();return device;
    },
    async prepareRequest({origin:requestedOrigin,token:supplied,pathname,options,buildHeaders}){
      if(requestedOrigin!==origin||supplied!==token)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      const url=new URL(pathname,origin),method=String(options.method??'GET').toUpperCase();
      if(url.origin!==origin||url.hash)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      let body;if(method==='POST'){try{body=JSON.parse(options.body);}catch{fail('ASSISTANT_SETUP_INVALID_INPUT');}}
      const metadata=method==='POST'&&['/read','/prepare','/begin','/runtime/register','/runtime/end'].some(suffix=>url.pathname===PREFIX+suffix)&&!url.search;
      if(metadata){
        if(!object(body)||body.companyId!==companyId||!configure&&url.pathname!==PREFIX+'/read')fail();
      }else if(method==='GET'&&url.pathname==='/api/agent-workspaces/encryption/runtime'&&options.body===undefined){
        if(!companySlug||url.searchParams.get('companySlug')!==companySlug
          ||[...url.searchParams.keys()].some(key=>!['companySlug','fingerprint'].includes(key))
          ||url.searchParams.has('fingerprint')&&url.searchParams.get('fingerprint')!==fingerprint)fail();
        url.pathname='/api/digital-assistants/runtime/encryption/runtime';
      }else{
        if(!plan||!configure)fail();
        if(method==='GET'&&url.pathname==='/api/agent-workspaces/bridge-compatibility'&&!url.search&&options.body===undefined)
          url.pathname=PREFIX+'/compatibility';
        else{
          const runtime=method==='POST'&&!url.search&&['/api/agent-skills/runtime/resolve','/api/agent-skills/runtime/device-consents',
            '/api/agent-skills/runtime/setup-secret','/api/agent-skills/remote-mcp/resolve'].includes(url.pathname);
          if(url.pathname==='/api/agent-skills/runtime/setup-secret'&&(!attemptId||body?.runtimeSessionId!==plan.runtimeSessionId))fail();
          const packageRead=method==='GET'&&url.pathname==='/api/agent-skills/runtime/package'&&options.body===undefined;
          if(packageRead&&([...url.searchParams.keys()].some(key=>!['companyId','projectId','skillId','expectedReleaseId','artifactId'].includes(key))
            ||new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          const selected=runtime?body:packageRead?Object.fromEntries(url.searchParams):null;
          if(!selected||selected.companyId!==companyId||(selected.projectId??null)!==plan.projectId
            ||selected.skillId!==plan.skillId||selected.expectedReleaseId!==plan.releaseId)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        }
      }
      await assertCurrent();const headers=buildHeaders(null,options.headers??{});
      for(const key of ['cookie','cookie2','proxy-authorization','x-trelio-assistant-pass','x-trelio-assistant-proof',
        'x-trelio-assistant-source-encryption-fingerprint',SETUP_HEADER])headers.delete(key);
      if(plan)headers.set(SETUP_HEADER,JSON.stringify(binding()));
      fingerprint=null;
      const stored=await store.get({origin,kind:'company_encryption',id:companyId,deviceId:identity.deviceId});
      if(stored?.assistantId===identity.assistantId&&stored.deviceId===identity.deviceId&&stored.companyId===companyId
        &&/^[A-Za-z0-9_-]{40,128}$/u.test(stored.record?.fingerprint??'')){
        fingerprint=stored.record.fingerprint;headers.set('x-trelio-assistant-source-encryption-fingerprint',fingerprint);
      }
      headers.set('x-trelio-assistant-encryption-protocol','1');
      headers.set('authorization',`Bearer ${await loadAssistantDeviceCredential({...identity,store})}`);
      await assertCurrent();return {url,headers,options:{redirect:'error',credentials:'omit',cache:'no-store',signal}};
    },
    hydrateSkillRuntimeResolution:hydrateRuntime,
    async resolveSkillCatalogueDirectory(directory){await assertCurrent();return assistantSkillCatalogueDirectory(host.configurationDirectory??directory,identity);},
    async resolveSkillRuntimeChat(){await assertCurrent();if(!plan)fail();return plan.requestId;},
    remoteMcpCredentialNamespace:`assistant:${identity.assistantId}:${identity.deviceId}`,
    resolveRemoteMcpCredentialDirectory(selected,directory){
      if(!plan||selected.companyId!==companyId||selected.skillId!==plan.skillId||(selected.projectId??null)!==plan.projectId)fail();
      return path.join(assistantSkillCatalogueDirectory(host.configurationDirectory??directory,identity),selected.skillId,id(companyId),id(selected.memberId));
    },
    assertRemoteMcpCurrent:nativeFence,
    async authorizeAccountCreation(selected,context){
      await assertCurrent();
      if(!plan||processUsed||!['create','update','unbind','default','remove'].includes(selected.operation)||context.companyId!==companyId
        ||(context.projectId??null)!==plan.projectId||context.skillId!==plan.skillId||context.memberId!==plan.memberId
        ||JSON.stringify(selected)!==JSON.stringify(execution?.accountCommand))fail();
      await begin('account-change');return selected.operation==='create'?{creationRequestId:plan.requestId}:{mutationRequestId:plan.requestId};
    },
    async authorizeAccountRemovalCommand({artifact,executionContext,runtimeArguments}){
      // Removal keeps the ordinary signed erasure receipt. It spends the SAME
      // account intent above, rather than opening a second provider attempt.
      if(!processUsed||!attemptId||execution?.accountCommand?.operation!=='remove'
        ||executionContext.account?.id!==execution.accountCommand.id||artifact.id!==execution.artifact.id
        ||artifact.packageSha256!==execution.artifact.packageSha256||executionContext.releaseId!==plan.releaseId
        ||executionContext.localIdentity?.memberId!==plan.memberId
        ||JSON.stringify(runtimeArguments)!=='["__trelio_account_remove"]')fail();
      await nativeFence();
    },
    async authorizeInteractiveSkillCommand({artifact,executionContext,runtimeArguments}){
      await assertCurrent();
      if(processUsed||artifact.id!==execution?.artifact.id||artifact.packageSha256!==execution.artifact.packageSha256
        ||executionContext.releaseId!==plan.releaseId||executionContext.localIdentity?.memberId!==plan.memberId
        ||JSON.stringify(runtimeArguments)!==JSON.stringify(execution.runtimeArguments))fail();
      await begin('skill-run');return 600000;
    },
    async assertInteractiveSkillCurrent(){if(!processUsed||!attemptId)fail();await nativeFence();},
  };
  return common.withWorkspaceExecutionProfile(profile,()=>action({common,profile,token,origin,signal,assertCurrent,requestJson,hydrateSnapshot,hydrateRuntime,
    setPlan:value=>{if(plan||!object(value)||value.companyId!==companyId||value.deviceId!==identity.deviceId||!UUID.test(value.requestId??'')||value.state!=='prepared')fail();plan=value;},
    setExecution:value=>{execution=value;},beginRemote:()=>begin('remote-operation'),nativeFence}));
};

export const executeAssistantLocalSkillTool=async(name,raw,{identity,host,store,client,signal,common}={})=>{
  const args=assistantLocalSkillArguments(name,raw);
  let companyId=args.companyId;
  if(companyId===null){
    const companies=projectAssistantSetupCompanies(await client.companies(signal));
    if(companies.length!==1)return {state:companies.length?'company_selection_required':'company_unavailable',companies};
    companyId=companies[0].companyId;
  }
  return withAssistantLocalSkillProfile({identity,host,store,client,companyId,signal,common,configure:name==='use_assistant_skill'},async context=>{
    const {requestJson,hydrateSnapshot,common,token,origin,signal}=context;
    const detail=await hydrateSnapshot(await requestJson('/read',{companyId,projectId:args.projectId,
      ...(args.skillId?{skillId:args.skillId}:{}),offset:args.offset??0,limit:args.limit??25}));
    if(name==='list_assistant_skills')return detail;
    if(!detail.skill?.runtimeRelease&&!detail.skill?.remoteMcp)return {content:[{type:'text',text:JSON.stringify({state:'instruction_only',taskRequired:false,instructions:detail})}]};
    if(!args.runtimeSessionProof)fail('ASSISTANT_HOOK_OBSERVATION_REQUIRED');
    if(!args.releaseId)fail('AGENT_SKILL_RELEASE_CHANGED');
    const plan=await requestJson('/prepare',{companyId,projectId:args.projectId,skillId:args.skillId,clientRequestId:args.clientRequestId,
      expectedReleaseId:args.releaseId,runtimeSessionProof:args.runtimeSessionProof});
    if(plan.reconcileOnly||plan.state!=='prepared')return {state:'attempt_already_recorded',loginVerified:false,replayAllowed:false};
    if(!plan.releaseId)fail('ASSISTANT_SKILL_OPERATION_UNAVAILABLE');
    if(plan.releaseId!==args.releaseId||detail.skill.currentReleaseId!==args.releaseId)
      return {content:[{type:'text',text:JSON.stringify({state:'skill_release_changed',instructions:detail})}]};
    context.setPlan(plan);
    if(args.operation!=='run'){
      if(!detail.skill?.remoteMcp)fail('ASSISTANT_SKILL_OPERATION_UNAVAILABLE');
      await context.beginRemote();
      const {executeRemoteMcpTool}=await import('./trelio-remote-mcp.mjs');
      const operation={connect_remote:'connect_remote_agent_skill',doctor_remote:'doctor_remote_agent_skill',call_remote:'call_remote_agent_skill_tool'}[args.operation];
      return executeRemoteMcpTool(origin,operation,{companyId,projectId:args.projectId,skillId:args.skillId,releaseId:plan.releaseId,...args.parameters},{signal});
    }
    if(detail.skill?.remoteMcp)fail('ASSISTANT_SKILL_OPERATION_UNAVAILABLE');
    const response=await common.resolveAgentSkillRuntimeWithDeviceConsent({origin,token,companyId,projectId:args.projectId,
      skillId:args.skillId,releaseId:plan.releaseId},{prepareEncryptedConsentFn:value=>common.prepareEncryptedAgentSkillDeviceConsent({...value,hydrateRuntime:context.hydrateRuntime})});
    const hydrated=await context.hydrateRuntime(await response.json());
    const resolution=common.normalizeResolvedSkillRuntimeArtifact(hydrated.rawResolution);
    const materialized=await common.materializeResolvedAgentSkillRuntime({origin,token,resolution,companyEncryption:hydrated.companyEncryption,
      requestOptions:{signal,maximumErrorResponseBytes:16384}});
    const executionContext={origin,companyId,projectId:args.projectId,skillId:args.skillId,releaseId:plan.releaseId,runtimeSessionId:plan.runtimeSessionId,
      localIdentity:resolution.localIdentity,companyConnection:resolution.companyConnection};
    // The ordinary host parser/catalogue chooses accounts. A provider without
    // local-accounts-v1 needs no artificial account or assistant-only manifest.
    // Managed storage remains separate from the logged-in human's sessions.
    let runtimeArguments=args.parameters.arguments,accountOutput;
    context.setExecution({artifact:materialized.artifact,accountCommand:parseAccountCommand(runtimeArguments)});
    if(materialized.artifact.parsedPackage.capabilities.includes('local-accounts-v1')){
      const account=await common.prepareSkillAccount({origin,artifact:materialized.artifact,runtimeDirectory:materialized.runtimeDirectory,executionContext,
        runtimeArguments,output:value=>{accountOutput=value;}});
      if(account.handled){await context.nativeFence();return {content:[{type:'text',text:JSON.stringify(accountOutput)}],structuredContent:accountOutput};}
      executionContext.account=account.account;runtimeArguments=account.runtimeArguments;
    }
    context.setExecution({artifact:materialized.artifact,runtimeArguments});
    const controller=parseBrowserControllerArguments(runtimeArguments);
    if(controller){
      if(!browserControllerEnabled(materialized.artifact.parsedPackage))fail('BROWSER_CONTROLLER_COMMAND_DENIED');
      // The ordinary controller validates its original session/account/release
      // binding and owns its lease/input/receipt. Do not send this host command
      // to the provider parser or mint an assistant-specific browser session.
      await context.beginRemote();await context.nativeFence();
      const result=await runBrowserControllerCommand({command:controller,environment:common.buildAgentSkillRuntimeEnvironment({
        artifact:materialized.artifact,runtimeDirectory:materialized.runtimeDirectory,executionContext})});
      await context.nativeFence();return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
    }
    const secretSetup=readSkillSecretSetupCommand(materialized.artifact.parsedPackage,runtimeArguments);
    // The ordinary signed-Secret service is plain-only. Refuse locally BEFORE
    // deriving/sending a hash of hydrated company config, not after native HTTP.
    if(secretSetup&&hydrated.companyEncryption)fail('AGENT_SKILL_SETUP_PROTECTION_UNSUPPORTED');
    const result=await common.runMaterializedAgentSkill({artifact:materialized.artifact,runtimeDirectory:materialized.runtimeDirectory,executionContext,
      runtimeArguments,captureOutput:true,captureMode:'assistant_interactive',timeoutMs:600000,signal,
      ...(secretSetup?{prepareSetupEnvironment:()=>deliverSkillSetupEnvironment({request:common.request,origin,token,command:secretSetup,
        resolution,companyId,projectId:args.projectId,skillId:args.skillId,releaseId:plan.releaseId,runtimeSessionId:plan.runtimeSessionId})}:{})});
    await context.nativeFence();
    if(secretSetup)return {content:[{type:'text',text:JSON.stringify({state:'command_completed',verificationRequired:true})}]};
    // Use the SAME closed visual/text decoder as ordinary skill_run. Manual
    // input has no screenshot/field values; saved_unverified stays unverified.
    const visual=parseVisualSkillOutput(result.stdout);
    if(visual)return visualMcpResult(visual);
    if(Buffer.byteLength(result.stdout)>40000)fail('TRELIO_SKILL_RUNTIME_OUTPUT_LIMIT');
    return {content:[{type:'text',text:result.stdout}]};
  });
};
