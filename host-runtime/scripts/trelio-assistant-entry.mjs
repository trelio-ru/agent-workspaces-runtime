#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolveHostRuntimeLoader, prepareHostRuntimeUpgrade } from './trelio-host-runtime-recovery.mjs';
import { requireTrelioComponentVersions } from './trelio-component-versions.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ASSISTANT_MCP_TOOLS, ASSISTANT_MCP_READ_TOOLS, AssistantTransportError, assistantTaskStorageDirectory, ASSISTANT_SOURCE_ACCOUNT_ERROR_CODES, ASSISTANT_SOURCE_MONITOR_ERROR_CODES,
  validateAssistantEncryptedInspection, supportsAssistantManagedContent, parseAssistantSourceReadReference } from './trelio-assistant-transport.mjs';
import { StringDecoder } from 'node:string_decoder';
import { isDirectModuleInvocation } from './trelio-local-path.mjs';
import { createAssistantSetup, createAssistantWindowsBackground } from './trelio-assistant-setup.mjs';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const enrollment = { type: 'string', pattern: UUID };
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
// Returned by the CURRENT signed worker, not captured by the long-lived stdio
// facade. A runtime update can expose this tool through the existing list-change
// mechanism without a plugin/Codex restart or duplicating the stable setup ABI.
export const ASSISTANT_SOURCE_SETUP_TOOL=Object.freeze({name:'prepare_assistant_source_account',
  description:'With sourceId=null list owner-configured source refs for one company. With an exact sourceId prepare only its owner-requested empty local account through the common signed loader/catalogue. No login, old-account bind/import, secrets, polling or readiness claim.',
  inputSchema:schema({companyId:enrollment,sourceId:{anyOf:[enrollment,{type:'null'}]}}),annotations:{idempotentHint:true}});
export const ASSISTANT_EMAIL_SETUP_TOOL=Object.freeze({name:'configure_assistant_email_source',
  description:'Open the existing protected local email configuration form only for an exact native owner-enabled source. The human enters and saves credentials in that form on this device. No terminal/chat values, old human account import, automatic login, sending or readiness claim. Do not repeat after an uncertain result.',
  inputSchema:schema({companyId:enrollment,sourceId:enrollment}),annotations:{idempotentHint:false}});
export const ASSISTANT_EMAIL_VERIFY_TOOL=Object.freeze({name:'verify_assistant_email_source',
  description:'After saved configuration, verify one exact owner-configured email source with the SAME passive signed reader. Reads INBOX metadata only; does not open a form, change configuration/cursor/queue/read-state, test SMTP or prove background scheduling. A failure never permits repeating setup.',
  inputSchema:schema({companyId:enrollment,sourceId:enrollment}),annotations:{readOnlyHint:true,idempotentHint:true}});
export const ASSISTANT_TELEGRAM_SETUP_TOOL=Object.freeze({name:'configure_assistant_telegram_source',
  description:'Open the existing protected Telegram QR/2FA login page on this device only for an exact native owner-enabled source. The human scans/enters factors there. No terminal/chat credentials, human session import, automatic login, sending, owner identity proof or background readiness. Never repeat an uncertain login.',
  inputSchema:schema({companyId:enrollment,sourceId:enrollment}),annotations:{idempotentHint:false}});
export const ASSISTANT_MAX_SETUP_TOOL=Object.freeze({name:'configure_assistant_max_source',
  description:'Open the existing protected MAX login window on this device only for an exact native owner-enabled source. The human logs in there and closes it. Handoff is not authentication: use the separate fresh verify tool next, never automatically repeat login. No credentials, session import, owner proof or background readiness.',
  inputSchema:schema({companyId:enrollment,sourceId:enrollment}),annotations:{idempotentHint:false}});
export const ASSISTANT_MAX_VERIFY_TOOL=Object.freeze({name:'verify_assistant_max_source',
  description:'After the MAX local login handoff, run one fresh native structural home probe for the same owner-enabled source. Does not reopen login, read message bodies, register streams, advance queues, ACK messages or prove owner identity/background readiness.',
  inputSchema:schema({companyId:enrollment,sourceId:enrollment}),annotations:{readOnlyHint:true,idempotentHint:true}});
export const ASSISTANT_ENCRYPTION_SETUP_TOOL=Object.freeze({name:'prepare_assistant_company_encryption',
  description:'Prepare this managed device for one exact encrypted company through the SAME native registration and local key-opening workflow. The company owner separately grants access. Only an opened recipient key and successful TRELIOE1 round-trip return key_verified; no task/source execution or business-readiness claim. Private material stays in the existing OS store or process memory. After an uncertain result read back the same identity; never reset or replace it.',
  inputSchema:schema({companyId:enrollment,companySlug:{type:'string',minLength:1,maxLength:120}}),annotations:{idempotentHint:true}});
const sourceToolNames=()=>[ASSISTANT_SOURCE_SETUP_TOOL.name,ASSISTANT_EMAIL_SETUP_TOOL.name,ASSISTANT_EMAIL_VERIFY_TOOL.name,ASSISTANT_TELEGRAM_SETUP_TOOL.name,ASSISTANT_MAX_SETUP_TOOL.name,ASSISTANT_MAX_VERIFY_TOOL.name];
const hostSetupToolNames=()=>[...sourceToolNames(),ASSISTANT_ENCRYPTION_SETUP_TOOL.name];
const interactiveSourceTool=name=>[ASSISTANT_EMAIL_SETUP_TOOL.name,ASSISTANT_TELEGRAM_SETUP_TOOL.name,ASSISTANT_MAX_SETUP_TOOL.name].includes(name);
const sourceSetupArguments=args=>{
  if(!args || Object.getPrototypeOf(args)!==Object.prototype || Object.keys(args).sort().join(',')!=='companyId,sourceId'
    || !new RegExp(UUID,'u').test(args.companyId??'') || args.sourceId!==null&&!new RegExp(UUID,'u').test(args.sourceId??''))
    throw Object.assign(new Error(),{code:'ASSISTANT_SETUP_INVALID_INPUT'});
  return {companyId:args.companyId,sourceId:args.sourceId};
};
export const assistantWorkerToolCatalogue=tools=>{
  if(!Array.isArray(tools)||tools.some(tool=>hostSetupToolNames().includes(tool?.name)))
    throw Object.assign(new Error(),{code:'ASSISTANT_MCP_INVALID_RESPONSE'});
  return [...tools,ASSISTANT_SOURCE_SETUP_TOOL,ASSISTANT_EMAIL_SETUP_TOOL,ASSISTANT_EMAIL_VERIFY_TOOL,ASSISTANT_TELEGRAM_SETUP_TOOL,ASSISTANT_MAX_SETUP_TOOL,ASSISTANT_MAX_VERIFY_TOOL,ASSISTANT_ENCRYPTION_SETUP_TOOL];
};
export const ASSISTANT_SETUP_TOOLS = Object.freeze([
  { name: 'begin_assistant_setup', description: 'Begin protected computer enrollment using the owner-provided locator. Returns a pairing code for review on the owner device, never credentials.',
    inputSchema: schema({ enrollmentId: enrollment, deviceName: { type: 'string', minLength: 1, maxLength: 120 } }) },
  { name: 'finish_assistant_setup', description: 'Check owner approval and complete the one-use protected exchange. A lost exchange requires a new enrollment; never blindly retry it.',
    inputSchema: schema({ enrollmentId: enrollment }) },
  { name: 'get_assistant_setup_status', description: 'Read local setup state and, for a paired device, verify live server contact. Does not imply task execution or background service readiness.',
    inputSchema: schema({ enrollmentId: enrollment }), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'install_assistant_background', description: 'Register the paired assistant supervisor for this Windows user at sign-in. Requires an explicit setup request. No automatic logon, saved password, elevation, Codex restart or readiness assertion. Does not start it now.',
    inputSchema: schema({}), annotations: { idempotentHint: true } },
  { name: 'get_assistant_background_status', description: 'Read back this paired Windows user\'s exact Task Scheduler registration and OS running state. Does not prove business readiness, source delivery or a working desktop.',
    inputSchema: schema({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'start_assistant_background', description: 'Start the exact registered paired Windows supervisor after setup. Reuses an already running instance. Native task/pass/owner/model/hook admission still gates every business action; registration or OS running state is not a successful pilot.',
    inputSchema: schema({}), annotations: { idempotentHint: true } },
]);
const backgroundTools = { install_assistant_background: 'install', get_assistant_background_status: 'status', start_assistant_background: 'start' };
const codes = new Set(ASSISTANT_SETUP_TOOLS.map(tool => tool.name));
const safeError = error => assistantHealthFailure(error) || ASSISTANT_SOURCE_ACCOUNT_ERROR_CODES.includes(error?.code)
  || ASSISTANT_SOURCE_MONITOR_ERROR_CODES.includes(error?.code) || /^(?:ASSISTANT_|DIGITAL_ASSISTANTS_|TRELIO_|LOCAL_WORKSPACE_|RUN_|LEASE_|STALE_)[A-Z_]{1,100}$/u.test(error?.code ?? '')
  ? error.code : 'ASSISTANT_SETUP_UNAVAILABLE';

export const callAssistantSetupTool = async (setup, name, args) => {
  if (!codes.has(name)) throw Object.assign(new Error(), { code: 'ASSISTANT_CAPABILITY_UNAVAILABLE' });
  if (Object.hasOwn(backgroundTools, name)) {
    if (!args || Object.getPrototypeOf(args) !== Object.prototype || Object.keys(args).length !== 0) {
      throw Object.assign(new Error(), { code: 'ASSISTANT_SETUP_INVALID_INPUT' });
    }
    return setup.background(backgroundTools[name]);
  }
  const expected = name === 'begin_assistant_setup' ? ['enrollmentId', 'deviceName'] : ['enrollmentId'];
  if (!args || Object.getPrototypeOf(args) !== Object.prototype
    || Object.keys(args).length !== expected.length || Object.keys(args).some(key => !expected.includes(key))
    || typeof args.enrollmentId !== 'string' || !new RegExp(UUID, 'u').test(args.enrollmentId)
    || (name === 'begin_assistant_setup' && (typeof args.deviceName !== 'string'
      || !args.deviceName.trim() || args.deviceName.length > 120 || /[\x00-\x1f\x7f]/u.test(args.deviceName)))) {
    throw Object.assign(new Error(), { code: 'ASSISTANT_SETUP_INVALID_INPUT' });
  }
  if (name === 'begin_assistant_setup') return setup.begin(args.enrollmentId, args.deviceName);
  if (name === 'finish_assistant_setup') return setup.finish(args.enrollmentId);
  return setup.status(args.enrollmentId);
};

/** This profile never imports/starts the human local MCP, reads its OAuth, or
 * migrates Codex configuration. Setup primitives load only for an actual
 * setup call; paired schema discovery uses the separate protected read adapter. */
export const createProductionAssistantSetup = async () => {
  const [{ createAssistantPrivateStore }, { createAssistantHttp }, common, { withPrivateProcessSession }, { createAssistantHostState }] = await Promise.all([
    import('./trelio-assistant-private.mjs'), import('./trelio-assistant-transport.mjs'), import('./trelio-workspace.mjs'),
    import('./trelio-hook-private-session.mjs'), import('./trelio-assistant-hook.mjs'),
  ]);
  const origin = 'https://trelio.ru';
  const store = createAssistantPrivateStore({ directory: path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants', 'credentials') });
  const hostState = createAssistantHostState({ directory: path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants'), store });
  const setup = createAssistantSetup({ origin, store, http: createAssistantHttp({ origin }) });
  // As in the common bridge, share one native worker only inside this tool
  // invocation. A long-lived MCP must not retain its ACL results or pipes.
  return { ...Object.fromEntries(Object.entries(setup).map(([name, action]) => [name,
    (...args) => withPrivateProcessSession(async () => {
      const result = await action(...args);
      if (result.state === 'paired') await hostState.saveIdentity({ origin, assistantId: result.assistantId, deviceId: result.deviceId });
      return result;
    })])), background: async operation => (await createProductionAssistantBackground())(operation) };
};

/** OS registration is composed only after an explicit setup call, never from
 * schema discovery or a task pass. The machine identity is the protected local
 * pairing; the model cannot choose a principal, executable or assistant UUID. */
export const createProductionAssistantBackground = async () => {
  const signal = AbortSignal.timeout(45_000);
  return createAssistantWindowsBackground({
    signal,
    readIdentity: () => productionContext(client => client.identity, { signal }),
    verifyContact: () => productionContext(client => client.heartbeat(), { signal }),
  });
};

/** Reopen only the EXISTING same device inbox under the ordinary private
 * opener. Hook/skill invocations never invent a DB or persist bodies/keys in a
 * second read journal. SQLite transactions are short; native/provider I/O runs
 * outside them, with another snapshot read afterwards. */
const productionSourceReads=async({common,identity,client,host,signal})=>{
  const [{openAssistantDatabase},{createAssistantInbox},{createAssistantSourceReadObserver}]=await Promise.all([
    import('./trelio-assistant-private.mjs'),import('./trelio-assistant-inbox.mjs'),import('./trelio-assistant-transport.mjs')]);
  const directory=path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','runtime',
    identity.assistantId.toLowerCase(),identity.deviceId.toLowerCase());
  const withInbox=async action=>{
    signal?.throwIfAborted();
    await common.assertPrivatePathKind(path.join(directory,'inbox.sqlite'),'file');
    const opened=await openAssistantDatabase(directory);
    try{return await action(createAssistantInbox({database:opened.database}));}
    finally{await opened.close();}
  };
  return createAssistantSourceReadObserver({identity,client,host,withInbox,signal});
};

/** The host identity is selected by completed protected pairing, never tool
 * arguments or an inherited human thread. Every invocation gets its own native
 * ACL/DPAPI lifetime and the common non-sliding hook clock. */
export const createProductionAssistantHook = async () => {
  const [{ createAssistantPrivateStore }, { createAssistantHttp, createAssistantDeviceClient }, common,
    { createAssistantHostState, createAssistantTaskHook }] = await Promise.all([
    import('./trelio-assistant-private.mjs'), import('./trelio-assistant-transport.mjs'), import('./trelio-workspace.mjs'),
    import('./trelio-assistant-hook.mjs'),
  ]);
  const directory = path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants');
  const store = createAssistantPrivateStore({ directory: path.join(directory, 'credentials') });
  const hostState = createAssistantHostState({ directory, store });
  const identity = await hostState.readIdentity();
  if (!identity) throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_NOT_CONFIGURED' });
  if (identity.origin !== 'https://trelio.ru') throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_STATE_INVALID' });
  const client = createAssistantDeviceClient({ ...identity, store, http: createAssistantHttp({ origin: identity.origin }) });
  const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
  const reads=await productionSourceReads({common,identity,client,host:hostState,signal:runtimeHookSignal()});
  return createAssistantTaskHook({ identity, client, store, readActivePass: hostState.readActivePass,
    confirmSourceProcessing:reads.confirmProcessing,
    lockDirectory: path.join(directory, 'runtime-locks') });
};

/** Invoke the shared Workspace engine under this device/pass only. The
 * protected native worker is scoped to one action; no human OAuth slot or
 * process-global auth state is selected. This helper is not a model tool and
 * does not itself open the businessReady gate. */
export const withProductionAssistantWorkspace = async (action, {signal,encryptedTaskRead=null,encryptedInspection=null,encryptedSkillRead=null,workspaceRun=null,materialWorkspaceId=null,secretBrowserFill=null,secretGeneration=null,secretSkill=null}={}) => {
  if(typeof action!=='function')throw Object.assign(new Error(),{code:'ASSISTANT_WORKSPACE_PROFILE_DENIED'});
  const [common,{createAssistantPrivateStore},{createAssistantHostState},transport,
    {withPrivateProcessSession}]=await Promise.all([
    import('./trelio-workspace.mjs'),import('./trelio-assistant-private.mjs'),import('./trelio-assistant-hook.mjs'),
    import('./trelio-assistant-transport.mjs'),import('./trelio-hook-private-session.mjs'),
  ]);
  return withPrivateProcessSession(async()=>{
    const directory=path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants');
    const store=createAssistantPrivateStore({directory:path.join(directory,'credentials')});
    const host=createAssistantHostState({directory,store});
    const identity=await host.readIdentity();
    if(!identity || identity.origin!=='https://trelio.ru')throw Object.assign(new Error(),{code:'ASSISTANT_HOST_STATE_INVALID'});
    const client=transport.createAssistantDeviceClient({...identity,store,http:transport.createAssistantHttp({origin:identity.origin})});
    const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
    const sourceReads=await productionSourceReads({common,identity,client,host,signal:runtimeHookSignal()});
    const profile=await transport.createAssistantWorkspaceProfile({identity,client,store,host,sourceReads,encryptedTaskRead,encryptedInspection,encryptedSkillRead,workspaceRun,materialWorkspaceId,secretBrowserFill,secretGeneration,secretSkill,lockDirectory:path.join(directory,'runtime-locks')});
    return common.withWorkspaceExecutionProfile(profile,()=>action({identity,client,store,host,
      prepareWorkspaceRun:profile.prepareWorkspaceRun,
      prepareWorkspaceMaterial:profile.prepareWorkspaceMaterial,
      readCompanyContentMode:profile.readCompanyContentMode,
      preparePrivateSkillArguments:profile.preparePrivateSkillArguments,
      encryptedTaskRead:profile.encryptedTaskRead,assertEncryptedTaskReadCurrent:profile.assertEncryptedTaskReadCurrent,
      withSecretGenerationKey:profile.withSecretGenerationKey}));
  },signal);
};

/** Same private process/OS identity composition as the Workspace engine,
 * without constructing a fake task profile for a taskless source intake. The
 * fixed companies reader selects current mode; unsupported transitions never
 * send original prose to a remote tools/call. */
export const withProductionAssistantManagedContent=async({name,args,signal},send)=>{
  const [common,{createAssistantPrivateStore},{createAssistantHostState},transport,
    {withPrivateProcessSession}]=await Promise.all([
    import('./trelio-workspace.mjs'),import('./trelio-assistant-private.mjs'),import('./trelio-assistant-hook.mjs'),
    import('./trelio-assistant-transport.mjs'),import('./trelio-hook-private-session.mjs')]);
  return withPrivateProcessSession(async()=>{
    const directory=path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants');
    const store=createAssistantPrivateStore({directory:path.join(directory,'credentials')}),host=createAssistantHostState({directory,store});
    const identity=await host.readIdentity();
    if(!identity||identity.origin!=='https://trelio.ru')fail('ASSISTANT_HOST_STATE_INVALID');
    const client=transport.createAssistantDeviceClient({...identity,store,http:transport.createAssistantHttp({origin:identity.origin})});
    const company=await transport.readAssistantCompanyContentMode({identity,host,client,signal});
    if(company.encryptionState==='plain')return send(args);
    return transport.withAssistantManagedContentArguments({identity,host,client,store,lockDirectory:path.join(directory,'runtime-locks'),
      name,args,signal},send);
  },signal);
};

/** Schema discovery before enrollment needs no credential/private worker.
 * A present structural host journal switches to the ordinary protected path;
 * ACL/I/O/corruption errors are not treated as an unconfigured installation. */
export const createProductionAssistantMcp = async () => {
  const common = await import('./trelio-workspace.mjs');
  const directory = path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants');
  try { await fs.lstat(path.join(directory, 'identity.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const [{ createAssistantPrivateStore }, { createAssistantHostState }, { createAssistantMcpClient, createAssistantDeviceClient, createAssistantHttp, readAssistantOwnerIntakeMessage }] = await Promise.all([
    import('./trelio-assistant-private.mjs'), import('./trelio-assistant-hook.mjs'), import('./trelio-assistant-transport.mjs'),
  ]);
  const store = createAssistantPrivateStore({ directory: path.join(directory, 'credentials') });
  const host = createAssistantHostState({ directory, store });
  const identity = await host.readIdentity();
  if (!identity || identity.origin !== 'https://trelio.ru') throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_STATE_INVALID' });
  const sourceClient=createAssistantDeviceClient({...identity,store,http:createAssistantHttp({origin:identity.origin})});
  return createAssistantMcpClient({ ...identity, store,
    withWorkspaceArguments:withAssistantEncryptedWorkspaceArguments,
    readActivePass:host.readActivePass,
    materializeSourceIntake:async({result,arguments:args,signal})=>{
      const [{validateAssistantActivePass},{buildRuntimeSessionProof,withRuntimeStateLock},{openAssistantDatabase}]=await Promise.all([
        import('./trelio-assistant-hook.mjs'),import('./trelio-runtime-session.mjs'),import('./trelio-assistant-private.mjs')]);
      const pass=validateAssistantActivePass(await host.readActivePass(),identity),descriptor=result.structuredContent?.sourceRead;
      if(pass.kind!=='source_intake'||!descriptor||descriptor.intakeId!==pass.passId||descriptor.eventId!==pass.eventId
        ||descriptor.sourceId!==pass.sourceId||descriptor.sourceRevision!==pass.sourceRevision||descriptor.threadId!==pass.threadId
        ||descriptor.companyId!==pass.companyId||args.intakePass?.intakeId!==pass.passId)
        throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
      const opened=await openAssistantDatabase(path.join(directory,'runtime',identity.assistantId,identity.deviceId));
      let reference;
      try{
        const {createAssistantInbox}=await import('./trelio-assistant-inbox.mjs');
        const row=createAssistantInbox({database:opened.database}).ownerIntake(pass.passId);
        if(row.original_event_id!==pass.eventId||row.scope.bindingId!==pass.sourceId||row.scope.accountId!==descriptor.localAccountId
          ||row.source_revision!==pass.sourceRevision||row.thread_id!==pass.threadId||!['started','uncertain'].includes(row.state))
          throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
        reference={eventId:row.original_event_id,id:row.native_event_id,revision:row.native_revision,conversationKey:row.conversation_key};
      }finally{await opened.close();}
      const source=(await sourceClient.sourceAccounts(pass.companyId,signal)).find(row=>row.id===pass.sourceId);
      const message=await readAssistantOwnerIntakeMessage({identity,client:sourceClient,host,store,pass,source,reference,signal});
      await withRuntimeStateLock(path.join(directory,'runtime-locks',`${pass.passId}.json`),async()=>{
        const latest=validateAssistantActivePass(await host.readActivePass(),identity);
        const saved=await store.get({origin:identity.origin,kind:'runtime',id:pass.passId});
        if(JSON.stringify(latest)!==JSON.stringify(pass)||saved?.ended||!saved?.state||saved.threadId!==pass.threadId)
          throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
        await sourceClient.confirmIntakeRead({intakePass:args.intakePass,ownerIdentityId:message.ownerIdentityId,
          senderExternalUserId:message.ownerExternalUserId,runtimeSessionProof:buildRuntimeSessionProof({state:saved.state,
            toolName:'confirm_assistant_intake_read',now:new Date()})},signal);
      });
      const value={...result.structuredContent,ownerMessage:{text:message.text,verifiedNativeOwner:true}};
      delete value.sourceRead;
      return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
    },
    materializeEncryptedTask: ({descriptor,signal}) => withProductionAssistantWorkspace(async current => {
      if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key])) {
        throw Object.assign(new Error(),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
      }
      const {materializeAssistantEncryptedTask}=await import('./trelio-assistant-transport.mjs');
      return materializeAssistantEncryptedTask({origin:identity.origin,descriptor:current.encryptedTaskRead,signal,
        assertCurrent:current.assertEncryptedTaskReadCurrent});
    },{signal,encryptedTaskRead:descriptor}),
    materializeEncryptedSkill: ({descriptor,signal}) => withProductionAssistantWorkspace(async current => {
      if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key]))
        throw Object.assign(new Error(),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
      const {materializeAssistantEncryptedSkill}=await import('./trelio-assistant-transport.mjs');
      return materializeAssistantEncryptedSkill({origin:identity.origin,descriptor,signal});
    },{signal,encryptedSkillRead:descriptor}),
    materializeAttachment: ({result,attachmentId,signal}) => withProductionAssistantWorkspace(async current => {
      if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key])) {
        throw Object.assign(new Error(),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
      }
      const {materializeAssistantAttachment}=await import('./trelio-assistant-transport.mjs');
      return materializeAssistantAttachment({origin:identity.origin,result,attachmentId,signal});
    },{signal}),
  });
};

// Long-lived stdio is deliberately only a facade. A fresh child resolves the
// current signed implementation for each invocation without reconnecting Codex.
export const createForwardingAssistantMcp = async () => {
  // Preserve secret-free pre-enrollment discovery. A source-only or not-yet
  // paired installation must not require a loader, private worker or network.
  const common=await import('./trelio-workspace.mjs');
  try {await fs.lstat(path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','identity.json'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  const workspace = await createAssistantWorkspaceExecutor();
  return {listTools:signal=>requestCurrentAssistantRuntime({operation:'list'},{signal}),
    async callTool(name,args,signal) {
      const result=await requestCurrentAssistantRuntime({operation:'call',name,arguments:args},{signal});
      if(name!=='continue_assistant_workspace_action' || result?.isError)return result;
      // These are native metadata/preparation/creation receipts, not local command
      // plans. The next returned secret_browser_fill continuation executes in
      // the SAME isolated Workspace worker; no second browser executor exists.
      if(['secret_list','secret_browser_prepare','secret_create'].includes(args?.operation))return result;
      let executed;
      try {executed=await workspace.execute(result.structuredContent,{signal});}
      catch(error) {await reportAssistantMaintenanceFailure(error).catch(()=>undefined);throw error;}
      if(executed?.operation==='skill_run' && executed.visual){
        const {visualMcpResult}=await import('./trelio-visual-result.mjs');
        return visualMcpResult(executed.visual);
      }
      return {content:[{type:'text',text:'Assistant Workspace action completed or remains in progress; inspect structuredContent.'}],structuredContent:executed};
    }};
};

/** Bounded JSON-lines MCP facade for setup and declared read capabilities. No raw incoming body, transport
 * exception or store envelope is returned/logged. Calls are serialized, so two
 * exchanges from this client cannot race its one-use private journal. */
export const runAssistantSetupMcp = async ({ input = process.stdin, output = process.stdout,
  createSetup = createProductionAssistantSetup, createMcp = createForwardingAssistantMcp,
  maintenanceRequest = requestCurrentAssistantRuntime, scheduleMaintenance = setInterval } = {}) => {
  let setup, initialized = false, busy = false, maintenance = null, maintenanceController = null, catalogRevision = null;
  const controller=new AbortController();
  const tick=()=>{
    if(busy || maintenance || controller.signal.aborted)return;
    maintenanceController=new AbortController();
    const signal=AbortSignal.any([controller.signal,maintenanceController.signal]);
    maintenance=maintenanceRequest({operation:'health'},{signal}).then(value=>{
      // Download/activation alone is not a catalogue refresh in Codex. Signal
      // only a positively read new schema catalogue, never a failed/empty probe.
      // This stable host ABI lets future signed workers add tools without
      // restarting the facade or waking a model on each maintenance poll.
      if(/^[a-f0-9]{64}$/u.test(value?.catalogRevision??'')) {
        if(catalogRevision!==null && catalogRevision!==value.catalogRevision) reply({jsonrpc:'2.0',method:'notifications/tools/list_changed'});
        catalogRevision=value.catalogRevision;
      }
      return value;
    }).catch(error=>
      signal.aborted?undefined:reportAssistantMaintenanceFailure(error).catch(()=>undefined)).finally(()=>{maintenance=null;maintenanceController=null;});
    return maintenance;
  };
  const timer=createMcp===createForwardingAssistantMcp || maintenanceRequest!==requestCurrentAssistantRuntime
    ?scheduleMaintenance(()=>{if(initialized)return tick();},300_000):null;
  timer?.unref();
  const reply = value => output.write(JSON.stringify(value) + '\n');
  const withProxy = async (action,{interactiveSourceSetup=false}={}) => {
    const { withPrivateProcessSession, runtimeHookSignal } = await import('./trelio-hook-private-session.mjs');
    // One deadline covers journal/DPAPI, initialization, request, body and
    // cleanup. A long-lived stdio process never caches a private worker/token.
    return withPrivateProcessSession(async () => action(await createMcp(), runtimeHookSignal()),
      AbortSignal.timeout(interactiveSourceSetup?11*60_000:45_000));
  };
  const dispatch = async message => {
    const requestId = message?.id;
    const hasId = typeof requestId === 'string' && requestId.length <= 128 || Number.isSafeInteger(requestId);
    if (!hasId) return; // Notifications, including cancellation, have no response.
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32600, message: 'Invalid request' } });
    }
    const respond = result => reply({ jsonrpc: '2.0', id: requestId, result });
    if (message.method === 'initialize' && !initialized) {
      initialized = true;
      return respond({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'trelio-assistant', version: '1.0.0' },
        instructions: 'This computer uses assistant device pairing, not human OAuth. Setup/contact alone does not authorize task work.' });
    }
    if (message.method === 'ping') return respond({});
    if (!initialized) return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: 'Initialize first' } });
    if (message.method === 'tools/list') {
      try {
        const tools=await withProxy((proxy,signal)=>proxy?proxy.listTools(signal):[]);
        catalogRevision=assistantCatalogRevision(tools);
        return respond({tools:[...ASSISTANT_SETUP_TOOLS,...tools]});
      }
      catch (error) { return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: safeError(error) } }); }
    }
    if (message.method === 'tools/call') {
      try {
        // Validate before touching private storage. Unknown tools cannot cause
        // an auth read or be delegated to another MCP implementation.
        if (ASSISTANT_MCP_TOOLS.includes(message.params?.name) || hostSetupToolNames().includes(message.params?.name)
          || createMcp===createForwardingAssistantMcp && !codes.has(message.params?.name)
            && /^[a-z][a-z0-9_]{0,99}$/u.test(message.params?.name ?? '')) {
          if (!message.params.arguments || Object.getPrototypeOf(message.params.arguments) !== Object.prototype) {
            throw Object.assign(new Error(), { code: 'ASSISTANT_TASK_INPUT_INVALID' });
          }
          return respond(await withProxy((proxy, signal) => {
            if (!proxy) throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_NOT_CONFIGURED' });
            return proxy.callTool(message.params.name, message.params.arguments, signal);
          },{interactiveSourceSetup:interactiveSourceTool(message.params.name)}));
        }
        if (!codes.has(message.params?.name)) throw Object.assign(new Error(), { code: 'ASSISTANT_CAPABILITY_UNAVAILABLE' });
        // The adapter is constructed once but every paired status revalidates
        // the protected slot and live device. It contains no cached authority.
        setup ??= await createSetup();
        const result = await callAssistantSetupTool(setup, message.params.name, message.params.arguments);
        respond({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
        if (message.params.name === 'finish_assistant_setup' && result.state === 'paired') {
          reply({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        }
        return;
      } catch (error) {
        const result = { code: safeError(error),
          ...(error?.code==='TRELIO_RUNTIME_HOOK_REQUIRED' && ['missing','invalid','expired','replayed'].includes(error.reason)?{reason:error.reason}:{}) };
        return respond({ isError: true, content: [{ type: 'text', text: result.code }], structuredContent: result });
      }
    }
    return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32601, message: 'Method not found' } });
  };
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const consume = async text => {
    pending += text;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > 131_072) throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');
      let parsed; try { parsed = JSON.parse(line); } catch {
        reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue;
      }
      // Work has priority over safe metadata/download maintenance. Cancelling
      // that child does not authorize replay of any business request.
      if(maintenance){maintenanceController?.abort();await maintenance;}
      busy=true;try {await dispatch(parsed);} finally {busy=false;}
    }
    if (Buffer.byteLength(pending) > 131_072) throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');
  };
  try {
    for await (const chunk of input) await consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    await consume(decoder.end());
    if (pending.trim()) await consume('\n');
  } finally {
    if(timer)clearInterval(timer);controller.abort();await maintenance;
  }
};

export const runAssistantEntry = async (args, options = {}) => {
  if (args.length !== 1 || !['mcp', 'hook', 'request', 'background', 'workspace',
    'background-install', 'background-status', 'background-start', 'background-remove'].includes(args[0])) throw new Error('ASSISTANT_COMMAND_UNSUPPORTED');
  if (args[0].startsWith('background-')) {
    const manage = await (options.createBackground ?? createProductionAssistantBackground)();
    (options.output ?? process.stdout).write(JSON.stringify(await manage(args[0].slice('background-'.length))) + '\n');
    return;
  }
  if (args[0] === 'workspace') return runAssistantWorkspaceWorker(options);
  if (args[0] === 'mcp') return runAssistantSetupMcp(options);
  if (args[0] === 'background') return (options.runBackground ?? runAssistantBackground)(options);
  if (args[0] === 'request') {
    let bytes=0;const chunks=[];
    for await (const chunk of options.input ?? process.stdin) {
      const part=Buffer.from(chunk);bytes+=part.length;if(bytes>131072)throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');chunks.push(part);
    }
    const body=Buffer.concat(chunks).toString('utf8');
    const output=options.output ?? process.stdout;
    try {
      const request=JSON.parse(body);
      output.write(JSON.stringify({value:await (options.executeRequest ?? executeAssistantRuntimeRequest)(validateAssistantRuntimeRequest(request))})+'\n');
    } catch(error) {output.write(JSON.stringify({failure:safeError(error)})+'\n');}
    return;
  }
  let bytes = 0, text = '';
  for await (const chunk of options.input ?? process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 131_072) throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');
    text += chunk.toString();
  }
  let event; try { event = JSON.parse(text); } catch { throw new Error('ASSISTANT_HOOK_INVALID_INPUT'); }
  const tool = String(event.tool_name ?? '');
  const name = tool.split(/__|[:./-]/u).at(-1);
  const assistantTool = /^(?:mcp__)?trelio[-_]assistant__|^mcp__plugin_trelio-digital-assistant_trelio-assistant__|^(?:mcp[:./-])?trelio-assistant[:./-]/u.test(tool);
  let decision = {};
  if (event.hook_event_name === 'PreToolUse' && assistantTool && !codes.has(name)
    && !hostSetupToolNames().includes(name) && name !== 'get_assistant_status') {
    const { withRuntimeHookPrivateSession } = await import('./trelio-hook-private-session.mjs');
    const { resolveRuntimeHookStartedAt, runtimeHookRemainingMilliseconds } = await import('./trelio-runtime-session-limits.mjs');
    try {
      decision = await withRuntimeHookPrivateSession(runtimeHookRemainingMilliseconds(event.hook_event_name,
        { startedAt: resolveRuntimeHookStartedAt() }), async () => {
        const hook = await (options.createHook ?? createProductionAssistantHook)();
        return hook(event, name);
      });
    } catch (error) {
      const suppliedCode = error?.diagnosticCode ?? error?.code;
      const code = /^(?:ASSISTANT_|TRELIO_)[A-Z_]{1,100}$/u.test(suppliedCode ?? '')
        ? suppliedCode : 'ASSISTANT_HOOK_UNAVAILABLE';
      decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: code } };
    }
  } else if (event.hook_event_name === 'SessionStart' && event.source === 'compact') {
    const { TRELIO_COMPACTION_RECOVERY_CONTEXT } = await import('./trelio-context-recovery.mjs');
    decision = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: TRELIO_COMPACTION_RECOVERY_CONTEXT } };
  } else if (event.hook_event_name === 'SessionEnd') {
    const { withRuntimeHookPrivateSession } = await import('./trelio-hook-private-session.mjs');
    const { resolveRuntimeHookStartedAt, runtimeHookRemainingMilliseconds } = await import('./trelio-runtime-session-limits.mjs');
    try { await withRuntimeHookPrivateSession(runtimeHookRemainingMilliseconds('SessionEnd',
      { startedAt: resolveRuntimeHookStartedAt() }), async () => {
      const hook = await (options.createHook ?? createProductionAssistantHook)(); await hook(event);
    }); } catch { /* No grant or retry is issued by a failed end notification. */ }
  }

  (options.output ?? process.stdout).write(JSON.stringify(decision) + '\n');
};

/** Model-free maintenance and a stable stdio -> current signed runtime ABI.
 * Never install/update/trust the plugin, restart Codex, copy human OAuth, or
 * retry a business invocation. The shell remains the sole package verifier. */

const fail = code => { throw Object.assign(new Error(code), {code}); };
/** A fingerprint of bounded public tool definitions, not credentials or task
 * content. The long-lived process can compare it across immutable workers. */
export const assistantCatalogRevision = tools => {
  if(!Array.isArray(tools)) fail('ASSISTANT_MCP_INVALID_RESPONSE');
  const text=JSON.stringify(tools);
  if(Buffer.byteLength(text)>768*1024) fail('ASSISTANT_MCP_FRAME_TOO_LARGE');
  return createHash('sha256').update(text).digest('hex');
};
const reasons = new Set(['ready','not_checked','plugin_update_required','plugin_restart_required','mcp_reconnect_required','runtime_update_failed','codex_auth_required','hook_review_required','connection_lost']);
const assistantHealthCodes = Object.freeze({
  AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED:'plugin_update_required',
  TRELIO_PLUGIN_RESTART_REQUIRED:'plugin_restart_required',
  ASSISTANT_PLUGIN_UPDATE_REQUIRED:'plugin_update_required',
  ASSISTANT_RUNTIME_UPDATE_REQUIRED:'runtime_update_failed',
  AGENT_WORKSPACE_HOST_RUNTIME_UPGRADE_REQUIRED:'runtime_update_failed',
  ASSISTANT_MCP_RECONNECT_REQUIRED:'mcp_reconnect_required',
  ASSISTANT_CODEX_AUTH_REQUIRED:'codex_auth_required',
  ASSISTANT_HOOK_REVIEW_REQUIRED:'hook_review_required',
});
export const assistantHealthFailure = error => Object.hasOwn(assistantHealthCodes,error?.code??'') ? assistantHealthCodes[error.code] : null;
const version = value => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(value);
const atLeast = (actual, minimum) => {
  if (!version(actual) || !version(minimum)) fail('ASSISTANT_HEALTH_INVALID_RESPONSE');
  const a=actual.split('.').map(Number),b=minimum.split('.').map(Number);
  for(let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];
  return true;
};
export const assistantHealthCompatibility = (state, versions) => {
  if(!state || !reasons.has(state.code) || !Number.isSafeInteger(state.revision) || state.revision<0
    || !version(state.compatibility?.minimumPluginVersion)
    || state.compatibility.minimumRuntimeVersion!==null && !version(state.compatibility.minimumRuntimeVersion)) fail('ASSISTANT_HEALTH_INVALID_RESPONSE');
  if(!atLeast(versions.pluginVersion,state.compatibility.minimumPluginVersion)) return 'plugin_update_required';
  if(state.compatibility.minimumRuntimeVersion && !atLeast(versions.hostRuntimeVersion,state.compatibility.minimumRuntimeVersion)) return 'runtime_update_failed';
  return null;
};

/** A successful metadata poll cannot claim that ChatGPT login or hook trust
 * was repaired. Those latches clear only at their own successful boundary. */
export const assistantHealthyBoundary = (current,request) => ({code:'ready',
  ...((current.code==='hook_review_required' || current.latchedCodes?.includes('hook_review_required'))
    && request.operation==='call' && request.name!=='get_assistant_status'
    && !hostSetupToolNames().includes(request.name) ? {clearedReason:'hook_review_required'} : {}),
});

export const maintainAssistantHost = async ({client,probe,update,versions,signal}) => {
  let updateFailed=false;
  try { await update(); } catch { updateFailed=true; }
  const current=await client.readHealth(signal);
  let code=assistantHealthCompatibility(current,versions);
  if(!code) {
    try { await probe(signal); }
    catch(error) { code=assistantHealthFailure(error); if(!code) throw error; }
  }
  code ??= updateFailed ? 'runtime_update_failed' : 'ready';
  return client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code},signal);
};

/** Each business call selects the current immutable package through the exact
 * installed loader. The long-lived facade does not import a new module into an
 * active invocation, tear down stdio, or replay the request after an error.
 * Secrets/content travel only inside protected runtime or bounded stdin pipes. */
const validateAssistantRuntimeRequest = request => {
  if(!request || !['list','call','health','health_check','background_tick'].includes(request.operation)
    || Object.keys(request).some(key=>!['operation','name','arguments'].includes(key))
    || request.operation==='call' && (typeof request.name!=='string' || !/^[a-z][a-z0-9_]{0,99}$/u.test(request.name)
      || !request.arguments || Object.getPrototypeOf(request.arguments)!==Object.prototype)
    || request.operation!=='call' && Object.keys(request).length!==1) fail('ASSISTANT_REQUEST_INVALID');
  return request;
};

export const requestCurrentAssistantRuntime = async (request, {environment=process.env,spawnProcess=spawn,
  resolveLoader=resolveHostRuntimeLoader,signal,timeoutMs}={}) => {
  validateAssistantRuntimeRequest(request);
  const interactive=request.operation==='call'&&interactiveSourceTool(request.name);
  timeoutMs??=interactive?11*60_000:120_000;
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<50 || timeoutMs>(request.operation==='background_tick'?35*60_000:interactive?11*60_000:180_000))fail('ASSISTANT_REQUEST_INVALID');
  const input=JSON.stringify(request);
  if(Buffer.byteLength(input)>131072) fail('ASSISTANT_MCP_FRAME_TOO_LARGE');
  const loader=await resolveLoader({environment});
  return new Promise((resolve,reject)=>{
    let child,done=false,bytes=0,output='';const decoder=new StringDecoder('utf8');
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child?.kill?.();error?reject(error):resolve(value);};
    const abort=()=>finish(Object.assign(new Error(),{code:'ASSISTANT_RUNTIME_REQUEST_UNAVAILABLE'}));
    const timer=setTimeout(abort,timeoutMs);
    if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});
    try {
      child=spawnProcess(process.execPath,[loader,'bridge','assistant','request'],{
        env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],
      });
      child.on('error',abort);child.stdin.on('error',abort);
      child.stdout.on('data',chunk=>{
        bytes+=chunk.length;if(bytes>768*1024)return abort();output+=decoder.write(chunk);
      });
      child.once('close',code=>{
        if(code!==0)return abort();
        try {
          const value=JSON.parse(output+decoder.end());
          if(value?.failure && /^(?:ASSISTANT_|DIGITAL_ASSISTANTS_)[A-Z_]{1,100}$/u.test(value.failure)) {
            return finish(Object.assign(new Error(value.failure),{code:value.failure}));
          }
          if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).join(',')!=='value')return abort();
          finish(null,value.value);
        } catch { abort(); }
      });
      child.stdin.end(input);
    } catch { abort(); }
  });
};

const productionContext = async (action, { signal, interactiveSourceSetup=false } = {}) => {
  const [{createAssistantPrivateStore},{createAssistantHostState},{createAssistantDeviceClient,createAssistantHttp},common,
    {withPrivateProcessSession}]=await Promise.all([
    import('./trelio-assistant-private.mjs'),import('./trelio-assistant-hook.mjs'),import('./trelio-assistant-transport.mjs'),
    import('./trelio-workspace.mjs'),import('./trelio-hook-private-session.mjs'),
  ]);
  return withPrivateProcessSession(async()=>{
    const directory=path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants');
    const store=createAssistantPrivateStore({directory:path.join(directory,'credentials')});
    const host=createAssistantHostState({directory,store});
    const identity=await host.readIdentity();
    if(!identity)return null;
    if(identity.origin!=='https://trelio.ru')fail('ASSISTANT_HOST_STATE_INVALID');
    return action(createAssistantDeviceClient({...identity,store,http:createAssistantHttp({origin:identity.origin})}),host,store);
  }, signal ? AbortSignal.any([signal, AbortSignal.timeout(interactiveSourceSetup?11*60_000:45_000)])
    : AbortSignal.timeout(interactiveSourceSetup?11*60_000:45_000));
};

const coordinatorMethods = ['heartbeat','companies','tasks','task','poll','acknowledge','claimTaskHost',
  'beginTaskPass','readTaskPass','renewTaskPass','readBusinessOutcome','reportSchedule','ownerIdentities',
  'beginSourceIntake','readSourceIntake','registerIntakeRuntime','endIntakeRuntime','cancelSourceIntake'];
const businessCapabilities = ['task_context','task_mutations','task_pass_outcome','workspace_execution','owner_decisions','background_service'];
/** The actual dedicated backend must open the whole business profile. A local
 * executable, successful pairing, timer, or human MCP cannot turn this on.
 * This is product admission, not evidence of a working Windows desktop or
 * trusted loaded hooks: every protected call still needs its observed proof.
 */
export const assistantCoordinatorReadiness = (result, identity) => {
  const value=result?.structuredContent;
  if(result?.isError===true) return false;
  if(!value || value.schemaVersion!==1 || value.assistantUserId!==identity.assistantId
    || value.deviceId!==identity.deviceId || !new RegExp(UUID,'u').test(value.authorizedByUserId??'')
    || value.authorizedByUserId===identity.assistantId || typeof value.businessReady!=='boolean'
    || !Array.isArray(value.availableCapabilities) || value.availableCapabilities.length>32
    || value.availableCapabilities.some(item=>typeof item!=='string' || !/^[a-z_]{1,64}$/u.test(item))) fail('ASSISTANT_COORDINATOR_ADMISSION_INVALID');
  return value.businessReady && businessCapabilities.every(capability=>value.availableCapabilities.includes(capability));
};

/** Compose the real protected identity/SQLite/client/native adapters. No live
 * token, native private worker or cached ACL is retained by the long-running
 * coordinator. Each network/journal operation owns a fresh bounded private
 * invocation. Dependency injection is internal test composition, never a tool
 * argument, arbitrary command runner, or alternate credential route.
 */
export const createAssistantRuntimeHost = async ({ context=productionContext, dependencies={} }={}) => {
  const [common,privateRuntime,nativeRuntime,{createAssistantCoordinator},{withPrivateProcessSession}]=await Promise.all([
    import('./trelio-workspace.mjs'),import('./trelio-assistant-private.mjs'),import('./trelio-assistant-codex.mjs'),
    import('./trelio-assistant-coordinator.mjs'),import('./trelio-hook-private-session.mjs'),
  ]);
  const identity=await context(client=>client.identity);
  if(!identity || Object.keys(identity).sort().join(',')!=='assistantId,deviceId,origin'
    || !new RegExp(UUID,'u').test(identity.assistantId??'') || !new RegExp(UUID,'u').test(identity.deviceId??'')) fail('ASSISTANT_HOST_NOT_CONFIGURED');
  let origin;try{origin=new URL(identity.origin);}catch{fail('ASSISTANT_HOST_STATE_INVALID');}
  if(origin.protocol!=='https:' || origin.origin!==identity.origin)fail('ASSISTANT_HOST_STATE_INVALID');
  const stableIdentity=Object.freeze({origin:identity.origin,assistantId:identity.assistantId,deviceId:identity.deviceId});
  const timeZone=dependencies.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone;
  try{if(typeof timeZone!=='string' || timeZone.length>128)throw new Error();
    new Intl.DateTimeFormat('en-US',{timeZone}).format(0);
  }catch{fail('ASSISTANT_COORDINATOR_INVALID_TIMEZONE');}
  const invoke=async action=>{
    const value=await context(async(client,host,store)=>{
      if(['origin','assistantId','deviceId'].some(key=>client.identity[key]!==stableIdentity[key])) fail('ASSISTANT_HOST_REBIND_REQUIRED');
      return {value:await action(client,host,store)};
    });
    if(value===null) fail('ASSISTANT_HOST_NOT_CONFIGURED');
    return value.value;
  };
  const client={identity:stableIdentity,...Object.fromEntries(coordinatorMethods.map(name=>[name,(...args)=>invoke(live=>live[name](...args))]))};
  const privateInvocation=action=>withPrivateProcessSession(action,AbortSignal.timeout(45_000));
  const configDirectory=dependencies.directory??common.resolveWorkspaceBridgeConfigDirectory();
  const root=dependencies.directory??path.join(configDirectory,'digital-assistants','runtime');
  if(!path.isAbsolute(root)) fail('ASSISTANT_HOST_STATE_INVALID');
  const ensureDirectory=dependencies.ensureDirectory??(directory=>privateInvocation(()=>common.ensurePrivateDirectory(directory)));
  await ensureDirectory(root);
  const deviceRoot=path.join(root,stableIdentity.assistantId.toLowerCase(),stableIdentity.deviceId.toLowerCase());
  const openDatabase=dependencies.openDatabase??(directory=>privateInvocation(()=>privateRuntime.openAssistantDatabase(directory)));
  const database=await openDatabase(deviceRoot);
  let coordinator,closed=false;
  try {
    const native=dependencies.native??{provision:nativeRuntime.provisionAssistantCodexChat,run:nativeRuntime.runAssistantCodexPass,
      readDelivery:nativeRuntime.readAssistantCodexDelivery};
    if(['provision','run','readDelivery'].some(name=>typeof native[name]!=='function'))fail('ASSISTANT_COORDINATOR_SETUP_REQUIRED');
    // Observe the native boundary before the coordinator deliberately replaces
    // a post-admission error with its durable delivery-uncertain fence. That
    // fence must stay intact, but must not hide a positively established login
    // problem from the owner. Neither a message nor metadata success supplies
    // this evidence; the native adapter calls the positive callback only after
    // a fresh completed turn and exact read-back. Every report re-enters the
    // protected identity; health failure never retries or changes business work.
    const reportAuthentication=async(code,signal)=>{
      try {await invoke(async live=>{
        const current=await live.readHealth(signal);
        // This API clears an exact latch only with a ready report. A native
        // model turn does not establish recovery of an unrelated plugin/MCP
        // incident, so retain a covered login latch until that independent
        // boundary is repaired and login becomes the current problem again.
        if(code==='ready' && current.code!=='codex_auth_required')return;
        await live.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code,
          ...(code==='ready'?{clearedReason:'codex_auth_required'}:{})},signal);
      });} catch { /* A CAS/transport refusal preserves the original receipt and incident. */ }
    };
    const observedNative={...native,...Object.fromEntries(['provision','run'].map(name=>[name,async(input,options)=>{
      try {return await native[name](input,{...options,
        onAuthenticationConfirmed:()=>reportAuthentication('ready',options.signal)});}
      catch(error){
        if(error?.code==='ASSISTANT_CODEX_AUTH_REQUIRED')await reportAuthentication('codex_auth_required',options.signal);
        throw error;
      }
    }]))};
    const readStatus=dependencies.readStatus??(signal=>invoke(async()=>{
      const proxy=await createProductionAssistantMcp();
      if(!proxy) fail('ASSISTANT_HOST_NOT_CONFIGURED');
      return proxy.callTool('get_assistant_status',{},signal);
    }));
    const passHost=Object.fromEntries(['readActivePass','activatePass','releasePass'].map(name=>[name,(...args)=>invoke((_client,host)=>host[name](...args))]));
    // Source calls re-enter the same protected private invocation and signed
    // account/provider reader. No long-lived credential/worker or provider code
    // is copied into this coordinator. The narrower private deadline propagates
    // to the child as well as native I/O; it never extends a poll lease.
    const readSourceMonitor=dependencies.readSourceMonitor??((source,signal)=>invoke(async(_client,host,store)=>{
      const {readAssistantSourceMonitor}=await import('./trelio-assistant-transport.mjs');
      const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
      const current=runtimeHookSignal(),combined=signal?AbortSignal.any([signal,current]):current;
      return readAssistantSourceMonitor({identity:stableIdentity,host,store,source,signal:combined});
    }));
    const acknowledgeSource=dependencies.acknowledgeSource??((input,signal)=>invoke(async(live,host,store)=>{
      const {acknowledgeAssistantSource}=await import('./trelio-assistant-transport.mjs');
      const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
      const current=runtimeHookSignal(),combined=signal?AbortSignal.any([signal,current]):current;
      return acknowledgeAssistantSource({identity:stableIdentity,host,store,client:live,...input,signal:combined});
    }));
    coordinator=createAssistantCoordinator({database:database.database,client:{...client,
      sourceAccounts:(...args)=>invoke(live=>live.sourceAccounts(...args)),
      sourceRoutes:(...args)=>invoke(live=>live.sourceRoutes(...args))},passHost,readSourceMonitor,acknowledgeSource,
      sourceHealth:{read:(row,signal)=>invoke(live=>live.readSourceHealth(row.companyId,row.id,signal)),
        report:(row,observation,signal)=>invoke(live=>live.reportSourceHealth({companyId:row.companyId,sourceId:row.id,...observation},signal))},
      native:{...observedNative,ready:async(_identity,signal)=>assistantCoordinatorReadiness(await readStatus(signal),stableIdentity)},
      workspaceForIntake:async scope=>{
        if(!scope||Object.keys(scope).sort().join(',')!=='companyId,sourceId'
          ||![scope.companyId,scope.sourceId].every(value=>new RegExp(UUID,'u').test(value??'')))fail('ASSISTANT_HOST_STATE_INVALID');
        const directory=path.join(deviceRoot,'intake',scope.companyId,scope.sourceId,'chat');
        await ensureDirectory(directory);return directory;
      },
      workspaceForTask:async scope=>{
        if(scope.origin!==stableIdentity.origin || scope.assistantId!==stableIdentity.assistantId
          || !new RegExp(UUID,'u').test(scope.companyId??'') || !new RegExp(UUID,'u').test(scope.taskId??'')) fail('ASSISTANT_HOST_STATE_INVALID');
        // This is a private chat working folder, not an accepted Workspace or
        // an instruction authority. The worker opens its native Run separately.
        await rejectLegacyAssistantTaskStorage(configDirectory,{...stableIdentity,companyId:scope.companyId,taskId:scope.taskId});
        const directory=path.join(assistantTaskStorageDirectory(configDirectory,{...stableIdentity,companyId:scope.companyId,taskId:scope.taskId}),'chat');
        await ensureDirectory(directory);return directory;
      },timeZone,
      ...(dependencies.now?{now:dependencies.now}:{}),...(dependencies.notify?{notify:dependencies.notify}:{}),
    });
    return {identity:stableIdentity,coordinator,async close(){
      if(closed)return;closed=true;
      try {await coordinator.close();} finally {await privateInvocation(()=>database.close());}
    }};
  } catch(error) {
    await privateInvocation(()=>database.close()).catch(()=>undefined);throw error;
  }
};

const waitForAssistantPoll = (milliseconds,signal) => new Promise(resolve=>{
  const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
  const timer=setTimeout(finish,milliseconds);signal?.addEventListener('abort',finish,{once:true});
  if(signal?.aborted)finish();
});

/** One worker owns one native pass, but keeps the model-free source poll alive
 * while that pass waits/runs. Return only after its result and durable recovery
 * boundary; source polling never starts a second native invocation. A later
 * worker reconstructs the same SQLite queue rather than replaying the pass.
 */
export const runAssistantBackgroundTick = async ({createHost=createAssistantRuntimeHost,signal,
  wait=waitForAssistantPoll}={}) => {
  if(signal?.aborted)fail('ASSISTANT_COORDINATOR_STOPPED');
  const host=await createHost();
  try {
    await host.coordinator.pollOnce(signal);
    let done=false,pollFailure=null;
    const work=host.coordinator.workOnce(signal).then(value=>({value}),error=>({error})).finally(()=>{done=true;});
    while(!done && !signal?.aborted) {
      const pollWait=new AbortController();
      await Promise.race([work,wait(30_000,signal?AbortSignal.any([signal,pollWait.signal]):pollWait.signal)]);
      pollWait.abort();
      if(!done && !signal?.aborted) {
        // A temporary inventory outage cannot independently replay/cancel a
        // native operation. Its own exact task watcher continues to authorize
        // or abort it. The next poll retries only model-free source reads.
        try {await host.coordinator.pollOnce(signal);pollFailure=null;} catch(error){pollFailure=error;}
      }
    }
    if(signal?.aborted)await host.coordinator.close();
    const result=await work;if(result.error)throw result.error;
    if(pollFailure)throw pollFailure; // Preserve a source outage after settling the one native pass.
    return {schemaVersion:1,state:result.value===null?'idle':'checked'};
  } finally {await host.close();}
};

/** The old plugin cache can disappear while this facade is still alive. A
 * diagnostic device report does not need that missing loader; use the retained
 * protected control plane, never another plugin path or a business fallback. */
export const reportAssistantMaintenanceFailure = async (error, client = null) => {
  const code=assistantHealthFailure(error);
  if(!code)return;
  const report=async connection=>{
    const current=await connection.readHealth();
    return connection.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code});
  };
  return client?report(client):productionContext(report);
};

/** Stable model-free supervisor of our own runtime workers, never Codex.
 * A fresh verified loader selects the immutable implementation for every
 * cycle. Updates wait for the active pass; no in-process import replacement,
 * guessed plugin cache, business retry or automatic Codex restart is involved.
 * OS registration is a separate explicit onboarding step.
 */
export const runAssistantBackground = async ({signal,request=requestCurrentAssistantRuntime,
  wait=waitForAssistantPoll,reportFailure=reportAssistantMaintenanceFailure}={}) => {
  const controller=new AbortController();
  const stop=()=>controller.abort();
  const effective=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  try {
    while(!effective.aborted) {
      try {
        await request({operation:'health'},{signal:effective});
        if(!effective.aborted)await request({operation:'background_tick'},{signal:effective,timeoutMs:35*60_000});
      } catch(error) {
        if(!effective.aborted)await reportFailure(error).catch(()=>undefined);
        // Retained SQLite/native-start/pass receipts own recovery. This is the
        // next polling cycle, never a second invocation of a business tool.
      }
      if(!effective.aborted)await wait(300_000,effective);
    }
    return {schemaVersion:1,state:'stopped'};
  } finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
};

export const executeAssistantRuntimeRequest = async (request,{context=productionContext,proxyFor=createProductionAssistantMcp,
  versions=requireTrelioComponentVersions,prepareSource=async input=>(await import('./trelio-assistant-transport.mjs')).prepareAssistantSourceAccount(input),
  prepareEncryption=async input=>(await import('./trelio-assistant-transport.mjs')).prepareAssistantCompanyEncryption(input),
  configureSource=async input=>(await import('./trelio-assistant-transport.mjs')).configureAssistantEmailSource(input),
  configureTelegramSource=async input=>(await import('./trelio-assistant-transport.mjs')).configureAssistantTelegramSource(input),
  configureMaxSource=async input=>(await import('./trelio-assistant-transport.mjs')).configureAssistantMaxSource(input),
  verifyMaxSource=async input=>(await import('./trelio-assistant-transport.mjs')).verifyAssistantMaxSource(input),
  verifySource=async input=>(await import('./trelio-assistant-transport.mjs')).verifyAssistantEmailSource(input)}={}) => {
  validateAssistantRuntimeRequest(request);
  if(request.operation==='background_tick')return runAssistantBackgroundTick();
  if(request.operation==='health') {
    const canUpdate=await context(async (_client,host)=>!await host.readActivePass());
    if(canUpdate===null)return null;
    try {
      if(canUpdate)await prepareHostRuntimeUpgrade({timeoutMs:30_000});
      // Downloading is not activation. A new worker selected by the verified
      // pointer proves the actual loaded version before reporting recovery.
      return await requestCurrentAssistantRuntime({operation:'health_check'});
    } catch(error) {
      const direct=assistantHealthFailure(error);
      return context(client=>maintainAssistantHost({client,versions:versions(),
        update:async()=>{throw new Error();},probe:async()=>{if(direct)fail(error.code);},
      }));
    }
  }
  if(request.operation==='health_check') {
    return context(async client=>{
      let catalog=null;
      const state=await maintainAssistantHost({client,versions:versions(),update:async()=>{},
        probe:async signal=>{const proxy=await proxyFor();if(!proxy)fail('ASSISTANT_HOST_NOT_CONFIGURED');catalog=assistantWorkerToolCatalogue(await proxy.listTools(signal));},
      });
      return {...state,...(catalog===null?{}:{catalogRevision:assistantCatalogRevision(catalog)})};
    });
  }
  if(!['list','call'].includes(request.operation))fail('ASSISTANT_REQUEST_INVALID');
  // Validate the exact tool before any credential read, as in ordinary MCP.
  const {ASSISTANT_MCP_TOOLS}=await import('./trelio-assistant-transport.mjs');
  const sourceSetup=request.operation==='call'&&sourceToolNames().includes(request.name);
  const interactiveSourceSetup=sourceSetup&&interactiveSourceTool(request.name);
  const sourceVerification=sourceSetup&&[ASSISTANT_EMAIL_VERIFY_TOOL.name,ASSISTANT_MAX_VERIFY_TOOL.name].includes(request.name);
  const encryptionSetup=request.operation==='call'&&request.name===ASSISTANT_ENCRYPTION_SETUP_TOOL.name;
  const encryptionArguments=encryptionSetup?request.arguments:null;
  if(encryptionSetup&&(!encryptionArguments||Object.getPrototypeOf(encryptionArguments)!==Object.prototype
    ||Object.keys(encryptionArguments).sort().join(',')!=='companyId,companySlug'
    ||!new RegExp(UUID,'u').test(encryptionArguments.companyId??'')||typeof encryptionArguments.companySlug!=='string'
    ||!encryptionArguments.companySlug.length||encryptionArguments.companySlug.length>120
    ||/[\x00-\x20\x7f]/u.test(encryptionArguments.companySlug)))fail('ASSISTANT_SETUP_INVALID_INPUT');
  const sourceArguments=sourceSetup?sourceSetupArguments(request.arguments):null;
  if((interactiveSourceSetup||sourceVerification)&&sourceArguments.sourceId===null)fail('ASSISTANT_SETUP_INVALID_INPUT');
  if(request.operation==='call' && !sourceSetup && !encryptionSetup && !ASSISTANT_MCP_TOOLS.includes(request.name))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
  return context(async (client,host,store)=>{
    const current=await client.readHealth();
    const blocked=assistantHealthCompatibility(current,versions());
    if(blocked) {
      await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code:blocked});
      fail(blocked==='plugin_update_required'?'ASSISTANT_PLUGIN_UPDATE_REQUIRED':'ASSISTANT_RUNTIME_UPDATE_REQUIRED');
    }
    const proxy=await proxyFor();
    if(!proxy)return request.operation==='list'?[]:fail('ASSISTANT_HOST_NOT_CONFIGURED');
    try {
      let result;
      if(encryptionSetup){
        try{
          const value=await prepareEncryption({identity:client.identity,client,host,store,...encryptionArguments});
          result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
        }catch(error){const code=safeError(error);result={isError:true,content:[{type:'text',text:code}],structuredContent:{code}};}
      }else if(sourceSetup){
        try{
          const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
          const value=sourceVerification?await(request.name===ASSISTANT_MAX_VERIFY_TOOL.name?verifyMaxSource:verifySource)({identity:client.identity,client,host,store,...sourceArguments,signal:runtimeHookSignal()}):
            interactiveSourceSetup?await(request.name===ASSISTANT_MAX_SETUP_TOOL.name?configureMaxSource:request.name===ASSISTANT_TELEGRAM_SETUP_TOOL.name?configureTelegramSource:configureSource)
              ({identity:client.identity,client,host,store,...sourceArguments,signal:runtimeHookSignal()}):sourceArguments.sourceId===null?
            {sources:(await client.sourceAccounts(sourceArguments.companyId,runtimeHookSignal())).map(source=>({sourceId:source.id,
              skillId:source.skillId,projectId:source.projectId,state:source.state,revision:source.revision,
              provisionLocalAccount:source.provisionLocalAccount,
              ...(source.interactiveSetupAllowed===true?{interactiveSetupAllowed:true}:{}),executionVerified:false}))}:
            await prepareSource({identity:client.identity,client,host,store,...sourceArguments,signal:runtimeHookSignal()});
          result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
        }catch(error){const code=safeError(error);result={isError:true,content:[{type:'text',text:code}],structuredContent:{code}};}
      }else result=await(request.operation==='list'?proxy.listTools():proxy.callTool(request.name,request.arguments));
      if(request.operation==='list')result=assistantWorkerToolCatalogue(result);
      const code=result?.isError?assistantHealthFailure(result.structuredContent):null;
      if(code)await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code}).catch(()=>undefined);
      if(!result?.isError) {
        const boundary=assistantHealthyBoundary(current,request);
        // Confirm contact during long active passes too. A lost diagnostic
        // response cannot discard or replay the successful business result.
        await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),...boundary}).catch(()=>undefined);
      }
      return result;
    } catch(error) {
      const code=assistantHealthFailure(error);
      if(code)await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code}).catch(()=>undefined);
      throw error; // Never repeat the original business invocation.
    }
  },{interactiveSourceSetup}).then(result=>result ?? (request.operation==='list'?[]:fail('ASSISTANT_HOST_NOT_CONFIGURED')));
};

/** Internal server plan, never an arbitrary command/directory selected by a
 * model. Parse it before private I/O; the child repeats live pass/Run admission
 * before accessing local files, including the nominally local status action. */
export const validateAssistantWorkspacePlan = async raw => {
  if(!raw || Object.getPrototypeOf(raw)!==Object.prototype || Object.keys(raw).some(key=>!['prepared','localAction','scope','encryptedInspection','encryptedLifecycle'].includes(key))
    || raw.prepared!==true || !raw.scope || Object.keys(raw.scope).sort().join(',')!=='assistantUserId,companyId,deviceId,passId,taskId'
    || Object.values(raw.scope).some(value=>typeof value!=='string' || !new RegExp(UUID,'u').test(value)))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  const snapshot=JSON.parse(JSON.stringify(raw));
  const action=snapshot.localAction;
  if(Object.hasOwn(snapshot,'encryptedLifecycle')){
    if(!['open','status','heartbeat','checkpoint','finish','pause'].includes(action?.operation)
      || snapshot.encryptedLifecycle?.workspaceId!==(action.operation==='open'?action.parameters?.workspaceId:action.runIdentity?.workspaceId))
      fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
    await validateAssistantEncryptedInspection({descriptor:snapshot.encryptedLifecycle,
      identity:{origin:'https://trelio.ru'},pass:snapshot.scope});
  }
  if(Object.hasOwn(snapshot,'encryptedInspection')){
    if(action?.operation!=='inspect' || snapshot.encryptedInspection?.workspaceId!==action.parameters?.workspaceId)
      fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
    await validateAssistantEncryptedInspection({descriptor:snapshot.encryptedInspection,
      identity:{origin:'https://trelio.ru'},pass:snapshot.scope});
  }
  if(!action || !['inspect','open','status','heartbeat','checkpoint','finish','pause','skill_run','secret_browser_fill','secret_generate','secret_skill_run'].includes(action.operation)
    || Object.keys(action).some(key=>!['schemaVersion','operation','parameters','runIdentity'].includes(key))
    || action.parameters?.taskOutcome!==undefined && action.parameters.taskOutcome!=='no_status_change'
    || action.operation==='finish' && action.parameters?.taskOutcome!=='no_status_change'
    || Object.hasOwn(action.parameters??{},'nativeInput') || Object.hasOwn(action.parameters??{},'directory'))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  if(action.operation==='secret_browser_fill' && (!action.parameters
    || Object.keys(action.parameters).sort().join(',')!=='grantId,targetUrl'))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  if(action.operation==='secret_skill_run' && (!action.parameters
    || Object.keys(action.parameters).sort().join(',')!=='companySlug,environmentVariable,fieldKey,grantId,skill'
    || typeof action.parameters.companySlug!=='string' || !/^[a-z0-9][a-z0-9_-]{0,159}$/u.test(action.parameters.companySlug)
    || !new RegExp(UUID,'u').test(action.parameters.grantId??'')
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(action.parameters.fieldKey??'')
    || !/^TRELIO_[A-Z0-9_]{1,100}$/u.test(action.parameters.environmentVariable??'')
    || action.parameters.skill?.companyId!==snapshot.scope.companyId
    || !new RegExp(UUID,'u').test(action.parameters.skill?.runtimeSessionId??'')))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  if(action.operation==='secret_generate'){
    if(!action.parameters || Object.keys(action.parameters).sort().join(',')!=='clientRequestId,expectedTaskUpdatedAt,ownerDecisionId,runId'
      || ['clientRequestId','ownerDecisionId','runId'].some(key=>!new RegExp(UUID,'u').test(action.parameters[key]??''))
      || !action.runIdentity || Object.keys(action.runIdentity).sort().join(',')!=='runId,workspaceId'
      || Object.values(action.runIdentity).some(value=>!new RegExp(UUID,'u').test(value??''))
      || action.parameters.runId!==action.runIdentity.runId || typeof action.parameters.expectedTaskUpdatedAt!=='string'
      || !Number.isFinite(Date.parse(action.parameters.expectedTaskUpdatedAt)))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
    return {...snapshot,runIdentity:action.runIdentity,invocation:null};
  }
  const {buildTrelioWorkspaceActionInvocation}=await import('./trelio-local-context.mjs');
  const invocation=buildTrelioWorkspaceActionInvocation(action);
  if(action.operation==='skill_run'){
    if(action.runIdentity!==undefined || action.parameters.companyId!==snapshot.scope.companyId
      || !new RegExp(UUID,'u').test(action.parameters.runtimeSessionId??'')
      || Buffer.byteLength(JSON.stringify(snapshot))>131072)fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
    return {...snapshot,invocation};
  }
  const runIdentity=action.operation==='inspect'?{workspaceId:action.parameters.workspaceId}
    :action.operation==='open'?{workspaceId:action.parameters.workspaceId,runId:action.parameters.runId}:action.runIdentity;
  if(action.operation==='inspect' && action.runIdentity!==undefined)fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  if(!runIdentity || Object.values(runIdentity).some(value=>!new RegExp(UUID,'u').test(value??''))
    || action.operation==='open' && !new RegExp(UUID,'u').test(action.parameters.runtimeSessionId??''))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  if(Buffer.byteLength(JSON.stringify(snapshot))>131072)fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  return {...snapshot,runIdentity,invocation};
};

/** Protect the SAME typed continuation BEFORE a remote MCP call can receive
 * summary, evidence, paths or questions. Keep the managed key/profile alive
 * only for this one bounded exchange; no plaintext or key-bearing closure
 * survives its action. A native refusal/lost result is never replayed.
 */
export const withAssistantEncryptedWorkspaceArguments = async ({name,args,signal},send,
  {withProfile=withProductionAssistantWorkspace,loadCommon=()=>import('./trelio-workspace.mjs'),
    withManagedContent=withProductionAssistantManagedContent}={})=>{
  if(supportsAssistantManagedContent(name,args))return withManagedContent({name,args,signal},send);
  if(name==='complete_assistant_pass')return withAssistantEncryptedMaterial({args,signal},send,{withProfile,loadCommon});
  if(name!=='continue_assistant_workspace_action' || !['checkpoint','finish','pause'].includes(args.operation))
    return withAssistantCompanyContentArguments({name,args,signal},send,{withProfile});
  if(!args.parameters || Object.hasOwn(args.parameters,'encryptedArguments'))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  return withProfile(async({identity,host,prepareWorkspaceRun})=>{
    const common=await loadCommon();
    const {validateAssistantActivePass}=await import('./trelio-assistant-hook.mjs');
    const pass=validateAssistantActivePass(await host.readActivePass(),identity);
    const scope={assistantUserId:identity.assistantId,deviceId:identity.deviceId,
      companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId};
    const plan=await validateAssistantWorkspacePlan({prepared:true,scope,localAction:{
      schemaVersion:args.schemaVersion,operation:args.operation,parameters:args.parameters,runIdentity:args.runIdentity}});
    const encryption=await prepareWorkspaceRun();
    if(!encryption)return send(args);
    const response=await common.request(encryption.requestOrigin??identity.origin,
      await common.requireToken(identity.origin),
      `/api/agent-workspaces/workspaces/${plan.runIdentity.workspaceId}/runs/${plan.runIdentity.runId}`,{signal});
    const current=await common.currentWorkspaceExecutionProfile().readWorkspaceJsonResponse(response);
    if(current.run?.id!==plan.runIdentity.runId || !Number.isSafeInteger(current.run.fencingToken)
      || !['running','waiting_for_human'].includes(current.run.status))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    const transport=await import('./trelio-assistant-transport.mjs');
    const binding={...scope,...plan.runIdentity,fencingToken:current.run.fencingToken,operation:args.operation};
    const sealed=await transport.sealAssistantWorkspaceArguments({binding,parameters:args.parameters,companyEncryption:encryption});
    const result=await send({...args,parameters:{encryptedArguments:sealed}});
    if(result?.isError)return result;
    if(!result?.structuredContent?.encryptedLifecycle
      || JSON.stringify(result.structuredContent.localAction?.parameters)!==JSON.stringify({encryptedArguments:sealed})
      || Object.keys(result.structuredContent.scope??{}).sort().join(',')!==Object.keys(scope).sort().join(',')
      || Object.entries(scope).some(([key,value])=>result.structuredContent.scope[key]!==value))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
    const opened=await transport.openAssistantWorkspaceArguments({binding,sealed,companyEncryption:encryption});
    return {...result,structuredContent:{...result.structuredContent,localAction:{
      ...result.structuredContent.localAction,parameters:opened}}};
  },{signal,workspaceRun:args.runIdentity});
};

/** All task prose crosses ONE common pre-send boundary, including operations
 * whose encrypted adapter is not available yet. A server-side refusal is too
 * late: its HTTP request would already contain company text. Names below
 * select structural reads/lifecycle only; native schemas, ACL, CAS and observed
 * proofs remain authoritative and are neither copied nor synthesized here.
 * New mutation names therefore fail closed without another hand-maintained
 * list of content fields. Guidance queries are text even though they are reads.
 */
export const withAssistantCompanyContentArguments = async ({name,args,signal},send,
  {withProfile=withProductionAssistantWorkspace}={})=>{
  if(!ASSISTANT_MCP_TOOLS.includes(name))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
  if(ASSISTANT_MCP_READ_TOOLS.includes(name) && name!=='search_agent_guidance'
    || name==='prepare_assistant_workspace_run'
    || name==='continue_assistant_workspace_action'
      && ['inspect','open','status','heartbeat','secret_list','secret_generate'].includes(args.operation))return send(args);
  return withProfile(async({readCompanyContentMode,preparePrivateSkillArguments})=>{
    if(typeof readCompanyContentMode!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_PROFILE_DENIED');
    if(await readCompanyContentMode(signal)!=='plain'){
      if(name==='continue_assistant_workspace_action'&&args.operation==='secret_skill_prepare'){
        if(typeof preparePrivateSkillArguments!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_PROFILE_DENIED');
        const parameters=await preparePrivateSkillArguments(args.parameters,signal);
        signal?.throwIfAborted();return send({...args,parameters});
      }
      // This narrow adapter carries only original native message selectors and
      // account/HMAC refs. Reuse the SAME source observer parser, not a second
      // provider grammar. Arbitrary search/send prose still needs a separate
      // sealed argument adapter and must never be sent to obtain a refusal.
      const read=name==='continue_assistant_workspace_action'&&args.operation==='skill_run'
        ?parseAssistantSourceReadReference({skillId:args.parameters?.skillId,arguments:args.parameters?.arguments}):null;
      if(!read?.accountId)throw new AssistantTransportError('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
    }
    signal?.throwIfAborted();
    // Exactly one exchange. No retry after refusal/transport failure and no
    // native human flag, temporary plain copy, key lookup or mode cache.
    return send(args);
  },{signal});
};

/** Completing an encrypted pass uses the SAME accepted inspector/Git and the
 * existing observed runtime signer. No cleartext/digest is sent to native MCP
 * or kept in another journal. The native server still owns accepted material,
 * noChange/retraction and final grant/head/envelope/CAS validation. */
export const withAssistantEncryptedMaterial = async ({args,signal},send,
  {withProfile=withProductionAssistantWorkspace,loadCommon=()=>import('./trelio-workspace.mjs')}={})=>{
  if(Object.hasOwn(args,'encryptedMaterialWitness') || !new RegExp(UUID,'u').test(args.workspaceId??'')
    || !/^[0-9a-f]{40,64}$/u.test(args.workspaceHead??'') || typeof args.noChange!=='boolean')fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  return withProfile(async({identity,host,client,store,prepareWorkspaceMaterial})=>{
    const {validateAssistantActivePass}=await import('./trelio-assistant-hook.mjs');
    const pass=validateAssistantActivePass(await host.readActivePass(),identity);
    if(!await prepareWorkspaceMaterial())return send(args);
    const locator={companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId};
    const basis=args.noChange?await client.readTaskMaterialBasis(locator,signal):null;
    if(args.noChange && (!basis || basis.workspaceId!==args.workspaceId))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    const common=await loadCommon();
    const inspection=await common.inspectAcceptedWorkspace(identity.origin,{workspace:args.workspaceId});
    await common.validateAcceptedAssistantWorkState({inspection,assistantId:identity.assistantId,workspaceHead:args.workspaceHead,
      previousHead:basis?.workspaceHead??null});
    const runtime=inspection.companyEncryption?.runtime;
    if(runtime?.state!=='encrypted' || runtime.accessState!=='ready' || runtime.company.id!==pass.companyId
      || runtime.viewer?.userId!==identity.assistantId || runtime.envelope?.recipientId!==runtime.device?.id)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    const witness={schemaVersion:1,cryptoDeviceId:runtime.device.id,envelopeId:runtime.envelope.id,
      scopeId:runtime.scope.id,scopeEpoch:runtime.scope.epoch,
      previousOutcomeId:basis?.receiptId??null,previousHead:basis?.workspaceHead??null};
    const transport=await import('./trelio-assistant-transport.mjs');
    const {assistantSourceProcessingReferences}=await import('./trelio-assistant-inbox.mjs');
    const manifest=transport.assistantEncryptedMaterialProofPayload({...pass,...args,...witness,
      references:assistantSourceProcessingReferences(args.processedSourceReferences??[])});
    const {buildRuntimeSessionProof,withRuntimeStateLock}=await import('./trelio-runtime-session.mjs');
    const directory=path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','runtime-locks');
    // Native reads acquire the ordinary state lock themselves. Complete their
    // fresh envelope check before taking that lock for this one local signature.
    await common.currentWorkspaceExecutionProfile().assertWorkspaceInspectionCurrent();
    return withRuntimeStateLock(path.join(directory,`${pass.passId}.json`),async()=>{
      signal?.throwIfAborted();
      if(JSON.stringify(validateAssistantActivePass(await host.readActivePass(),identity))!==JSON.stringify(pass))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      const record=await store.get({origin:identity.origin,kind:'runtime',id:pass.passId});
      if(record?.schemaVersion!==1 || record.passId!==pass.passId || record.threadId!==pass.threadId || record.ended
        || !record.state || record.state.runtimeSessionId!==args.runtimeSessionProof?.runtimeSessionId
        || !Number.isFinite(Date.parse(record.state.expiresAt)) || Date.parse(record.state.expiresAt)<=Date.now())fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      const proof=buildRuntimeSessionProof({state:record.state,toolName:transport.assistantEncryptedMaterialProofTool(
        createHash('sha256').update(manifest).digest('hex'))});
      return send({...args,encryptedMaterialWitness:{...witness,runtimeSessionProof:proof}});
    });
  },{signal,materialWorkspaceId:args.workspaceId});
};
const assistantPlanTaskScope=plan=>({origin:'https://trelio.ru',assistantId:plan.scope.assistantUserId,deviceId:plan.scope.deviceId,
  companyId:plan.scope.companyId,taskId:plan.scope.taskId});
const assistantWorkspaceRoot=(config,plan)=>path.join(assistantTaskStorageDirectory(config,assistantPlanTaskScope(plan)),
  'workspaces',plan.runIdentity.workspaceId.toLowerCase());
/** No silent move/reset of prototype writable folders or permanent chat cwd.
 * Presence requires explicit outcome recovery. This exact lstat reads no files;
 * access errors are not mistaken for absence. Inspection caches are rebuildable. */
const rejectLegacyAssistantTaskStorage=async(config,scope)=>{
  const legacy=path.join(config,'digital-assistants','runtime',scope.assistantId.toLowerCase(),scope.deviceId.toLowerCase(),
    'tasks',scope.companyId.toLowerCase(),scope.taskId.toLowerCase());
  try{await fs.lstat(legacy);}catch(error){if(error.code==='ENOENT')return;throw error;}
  fail('ASSISTANT_TASK_STORAGE_REVIEW_REQUIRED');
};

/** The stable facade owns only bounded progress/heartbeat coordination. Actual
 * private storage, native ACL checks, transport and Git execute in a fresh
 * signed child. It cannot keep an expired async auth profile or a human token.
 * Finishing survives cancellation of a short MCP wait, as in the human host. */
export const createAssistantWorkspaceExecutor = async ({runPlan=runAssistantWorkspaceProcess,configDirectory,
  finishOptions={},heartbeatOptions={}}={}) => {
  const common=await import('./trelio-workspace.mjs');
  const {createWorkspaceFinishOperations}=await import('./trelio-workspace-finish-progress.mjs');
  const {createWorkspaceRunHeartbeatManager}=await import('./trelio-local-context.mjs');
  const config=configDirectory??common.resolveWorkspaceBridgeConfigDirectory();
  if(!path.isAbsolute(config))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  const plans=new Map();
  const finishes=createWorkspaceFinishOperations({...finishOptions,toolName:'continue_assistant_workspace_action'});
  const heartbeat=createWorkspaceRunHeartbeatManager({...heartbeatOptions,resolveOpenedDirectory:async()=>fail('ASSISTANT_WORKSPACE_REVIEW_REQUIRED'),
    runBridge:async (_origin,args,options)=>{
      const plan=plans.get(path.resolve(options.cwd??''));
      if(!plan || args.length!==1 || args[0]!=='heartbeat')fail('ASSISTANT_WORKSPACE_REVIEW_REQUIRED');
      const value=await runPlan({prepared:true,scope:plan.scope,localAction:{schemaVersion:1,operation:'heartbeat',
        parameters:{},runIdentity:plan.runIdentity}},options);
      return {stdout:value.stdout??'',stderr:value.stderr??''};
    }});
  return {async execute(raw,{signal}={}) {
    const plan=await validateAssistantWorkspacePlan(raw);
    // Accepted inspection has no Run, renewal, progress registry or writable
    // task directory. The common reader selects its isolated cache in the child.
    if(['inspect','skill_run'].includes(plan.localAction.operation))return runPlan({prepared:true,scope:plan.scope,localAction:plan.localAction},{signal});
    const root=assistantWorkspaceRoot(config,plan),directory=path.join(root,'workspace');
    const key=`${plan.scope.assistantUserId}:${plan.scope.deviceId}:${plan.scope.companyId}:${plan.scope.taskId}:${plan.runIdentity.workspaceId}`;
    const scope=`${plan.scope.passId}:${plan.runIdentity.runId}`;
    const previous=plans.get(directory);
    if(previous && (previous.scope.passId!==plan.scope.passId || previous.runIdentity.runId!==plan.runIdentity.runId)) {
      if(finishes.active(key))fail('ASSISTANT_WORKSPACE_FINISH_IN_PROGRESS');
      heartbeat.stop(directory);
    }
    if(!plans.has(directory) && plans.size>=64) {
      for(const [oldDirectory,oldPlan] of plans) {
        if(!heartbeat.inspect(oldDirectory) && !finishes.active(oldPlan.key))plans.delete(oldDirectory);
      }
      if(plans.size>=64)fail('ASSISTANT_WORKSPACE_CAPACITY');
    }
    // Keep only structural renewal locators. Handoff text stays in the common
    // bounded finish registry for its ordinary retention, not a second cache.
    plans.set(directory,{scope:plan.scope,runIdentity:plan.runIdentity,key});
    const execute=async(onProgress,actionSignal)=>{
      const entry=await heartbeat.beginAction(directory,plan.localAction.operation);
      try {
        const result=await runPlan({prepared:true,scope:plan.scope,localAction:plan.localAction},{signal:actionSignal,onProgress});
        if(plan.localAction.operation==='open')heartbeat.start({origin:'https://trelio.ru',...plan.runIdentity,workspaceDirectory:directory});
        else heartbeat.markActionSuccess(entry,plan.localAction.operation,plan.localAction.parameters);
        return result;
      } finally {heartbeat.endAction(entry);}
    };
    if(plan.localAction.operation==='status' && plan.localAction.parameters.finishOperationId)
      return finishes.poll(key,plan.localAction.parameters.finishOperationId,signal,scope);
    if(plan.localAction.operation==='finish')return finishes.start({key,scope,signal,
      fingerprint:JSON.stringify(plan.localAction.parameters),
      pollAction:{schemaVersion:1,operation:'status',parameters:{},runIdentity:plan.runIdentity},
      execute:onProgress=>execute(onProgress,undefined)});
    const active=finishes.active(key);
    if(active && plan.localAction.operation!=='heartbeat') {
      if(plan.localAction.operation==='status')return active;
      fail('ASSISTANT_WORKSPACE_FINISH_IN_PROGRESS');
    }
    return execute(undefined,signal);
  },stop(){for(const directory of plans.keys())heartbeat.stop(directory);}};
};

/** This runner selects the installed verifier, not an arbitrary source path or
 * executable. Payload is bounded stdin; stdout is the common action result,
 * and only ordinary fixed progress frames are observed before completion. */
export const runAssistantWorkspaceProcess = async (raw,{signal,onProgress,resolveLoader=resolveHostRuntimeLoader,
  runProcess,environment=process.env}={}) => {
  const plan=await validateAssistantWorkspacePlan(raw);
  const input=JSON.stringify({prepared:true,scope:plan.scope,localAction:plan.localAction});
  const loader=await resolveLoader({environment});
  const {runWorkspaceFinishProcess}=await import('./trelio-workspace-finish-progress.mjs');
  let result;
  try {result=await (runProcess??runWorkspaceFinishProcess)(process.execPath,[loader,'bridge','assistant','workspace'],{signal,onProgress,input,
    maximumCharacters:(plan.localAction.operation==='skill_run'?3:1)*1024*1024});}
  catch(error) {
    // The isolated worker emits one closed error frame; never classify raw
    // child prose/cause or retry the command. A killed/ambiguous writer remains
    // an explicit review condition, not proof that acceptance did not happen.
    let frame;try{if(typeof error?.stderr==='string' && error.stderr.length<1024)frame=JSON.parse(error.stderr);}catch{}
    const code=assistantHealthFailure(frame) || /^(?:ASSISTANT_|TRELIO_|LOCAL_WORKSPACE_|RUN_|LEASE_|STALE_)[A-Z_]{1,100}$/u.test(frame?.code??'')?frame.code:'ASSISTANT_WORKSPACE_OUTCOME_REVIEW_REQUIRED';
    throw Object.assign(new Error(code),{code,
      ...(code==='TRELIO_RUNTIME_HOOK_REQUIRED' && ['missing','invalid','expired','replayed'].includes(frame?.reason)?{reason:frame.reason}:{})});
  }
  let value;try{value=JSON.parse(result.stdout);}catch{fail('ASSISTANT_WORKSPACE_RESULT_INVALID');}
  if(!value || value.schemaVersion!==1 || value.operation!==plan.localAction.operation
    || Object.keys(value).some(key=>!['schemaVersion','operation','stdout','stderr','visual'].includes(key)))fail('ASSISTANT_WORKSPACE_RESULT_INVALID');
  if(value.visual!==undefined){
    if(value.operation!=='skill_run' || value.stdout!==undefined || value.stderr!==undefined
      || Buffer.byteLength(JSON.stringify(value))>3*1024*1024)fail('ASSISTANT_WORKSPACE_RESULT_INVALID');
    const {validateVisualResult}=await import('./trelio-visual-result.mjs');
    validateVisualResult(value.visual);
  }else if(typeof value.stdout!=='string' || Buffer.byteLength(JSON.stringify(value))>768*1024)fail('ASSISTANT_WORKSPACE_RESULT_INVALID');
  return value;
};

/** Exactly one command runs in this isolated process. chdir/stdout capture are
 * confined here, never a long-lived MCP/background host. All native Workspace
 * algorithms (safe materialization, dirty state, recovery, checkpoint and
 * acceptance) remain the common engine. No module is copied into this adapter. */
export const executeAssistantWorkspacePlan = async (raw,{withProfile=withProductionAssistantWorkspace,
  loadCommon=()=>import('./trelio-workspace.mjs'),loadContext=()=>import('./trelio-local-context.mjs')}={}) => {
  const plan=await validateAssistantWorkspacePlan(raw);
  return withProfile(async({identity,client,store,host,withSecretGenerationKey,prepareWorkspaceRun})=>{
    const common=await loadCommon(),context=await loadContext();
    const {validateAssistantActivePass}=await import('./trelio-assistant-hook.mjs');
    const active=validateAssistantActivePass(await host.readActivePass(),identity);
    if(identity.origin!=='https://trelio.ru' || identity.assistantId!==plan.scope.assistantUserId || identity.deviceId!==plan.scope.deviceId
      || ['companyId','taskId','passId'].some(key=>active[key]!==plan.scope[key]))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    // A profile HTTP read consumes its own observed one-use proof and native
    // canonical target/own-Run checks, even for local status or heartbeat.
    const token=await common.requireToken(identity.origin);
    const inspecting=plan.localAction.operation==='inspect';
    const skill=plan.localAction.operation==='skill_run';
    const runLifecycle=['open','status','heartbeat','checkpoint','finish','pause'].includes(plan.localAction.operation);
    const encryption=runLifecycle||plan.localAction.operation==='secret_skill_run'?await prepareWorkspaceRun():null;
    if(plan.encryptedLifecycle && (!encryption || encryption.requestOrigin!==plan.encryptedLifecycle.requestOrigin
      || encryption.runtime.company.id!==plan.encryptedLifecycle.companyId))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    if(!skill && !(inspecting && plan.encryptedInspection)){
      const response=await common.request(encryption?.requestOrigin??identity.origin,token,`/api/agent-workspaces/workspaces/${plan.runIdentity.workspaceId}/${inspecting?'read-snapshot':`runs/${plan.runIdentity.runId}`}`);
      const snapshot=encryption?await common.currentWorkspaceExecutionProfile().readWorkspaceJsonResponse(response)
        :JSON.parse((await common.readBoundedResponseBuffer(response,512*1024,inspecting?'Assistant accepted Workspace':'Assistant Run')).toString('utf8'));
      if(inspecting ? snapshot.workspace?.id!==plan.runIdentity.workspaceId || snapshot.workspace.scopeType!=='task'
        || snapshot.workspace.scopeKey!==`task:${plan.scope.taskId}`
        : snapshot.run?.id!==plan.runIdentity.runId || snapshot.run.workspaceId!==plan.runIdentity.workspaceId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    }
    if(plan.localAction.operation==='open' || skill || plan.localAction.operation==='secret_skill_run') {
      const runtime=await store.get({origin:identity.origin,kind:'runtime',id:active.passId});
      const selected=plan.localAction.operation==='secret_skill_run'?plan.localAction.parameters.skill.runtimeSessionId:plan.localAction.parameters.runtimeSessionId;
      if(runtime?.ended || runtime?.state?.runtimeSessionId!==selected)fail('ASSISTANT_WORKSPACE_SESSION_REQUIRED');
    }
    const config=common.resolveWorkspaceBridgeConfigDirectory();
    if(!inspecting)await rejectLegacyAssistantTaskStorage(config,assistantPlanTaskScope(plan));
    // Signed skill commands use the same task-local cwd, but need no invented
    // Workspace/Run. Their native resolver repeats task admission before launch.
    const root=skill?assistantTaskStorageDirectory(config,assistantPlanTaskScope(plan)):assistantWorkspaceRoot(config,plan),directory=path.join(root,'workspace');
    // The common opener claims a new root itself. Precreating that final
    // --dir makes it look like an unrelated existing directory and correctly
    // trips its ownership guard. Prepare ONLY its private parent for open;
    // never weaken that guard or adopt an unrecognized existing folder.
    const opening=plan.localAction.operation==='open';
    if(!inspecting)await common.ensurePrivateDirectory(opening?path.dirname(root):root);
    if(!inspecting && !skill && plan.localAction.operation!=='open') {
      const local=await context.readOpenedWorkspaceRunIdentity(directory,identity.origin);
      if(local.workspaceId!==plan.runIdentity.workspaceId || local.runId!==plan.runIdentity.runId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    }
    if(plan.localAction.operation==='secret_generate'){
      const {handleAssistantGeneratedPrivateSecret}=await import('./trelio-secret-generate.mjs');
      const result=await handleAssistantGeneratedPrivateSecret({origin:identity.origin,token,input:plan.localAction.parameters,
        scope:{assistantUserId:identity.assistantId,deviceId:identity.deviceId,companyId:active.companyId,taskId:active.taskId},
        withGenerationKey:withSecretGenerationKey});
      return {schemaVersion:1,operation:'secret_generate',stdout:JSON.stringify(result),stderr:''};
    }
    const action={...plan.localAction,parameters:{...plan.localAction.parameters,
      ...(plan.localAction.operation==='open'?{directory:root}:{}),
      ...(['checkpoint','finish','pause'].includes(plan.localAction.operation)?{taskOutcome:'no_status_change'}:{}),
    }};
    let nativeReason,nativeHealthCause,nativeCommandPolicyCause;
    try {return await context.handleTrelioWorkspaceActionOperation(identity.origin,action,{
      resolveRunRootDirectory:async()=>root,
      runBridge:async(_origin,args,options)=>{
        if(options.cwd && path.resolve(options.cwd)!==directory)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
        let stdout='',bytes=0;const write=process.stdout.write;
        const previousDirectory=process.cwd();
        process.stdout.write=function(chunk,encoding,callback){
          const part=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);bytes+=Buffer.byteLength(part);
          if(bytes>(skill?3:1)*1024*1024)fail('ASSISTANT_WORKSPACE_RESULT_INVALID');stdout+=part;
          const done=typeof encoding==='function'?encoding:callback;done?.();return true;
        };
        try {
          process.chdir(options.cwd??(inspecting?previousDirectory:opening?path.dirname(root):root));
          // The common CLI's `--` starts provider arguments. Keep host origin
          // before that boundary; appending it would mutate the provider's
          // command instead of selecting the authenticated native endpoint.
          const boundary=args.indexOf('--'),nativeArgs=[...args];
          nativeArgs.splice(boundary<0?args.length:boundary,0,'--origin',identity.origin);
          await common.runWorkspaceCommand(nativeArgs);return {stdout,stderr:''};
        }
        catch(error) {
          // Reuse the ordinary in-process -> CLI error projection so common
          // lease/recovery and bounded HTTP classification remain identical.
          if(assistantHealthFailure(error))nativeHealthCause=error.code;
          // These are closed local policy outcomes, not provider stderr or an
          // HTTP diagnosis. Preserve them across the common CLI wrapper so a
          // missing provider opt-in is not reported as a transport outage.
          if(['ASSISTANT_SKILL_COMMAND_UNAVAILABLE','ASSISTANT_SKILL_COMMAND_POLICY_INVALID',
            'ASSISTANT_SKILL_COMMAND_DENIED'].includes(error?.code))nativeCommandPolicyCause=error.code;
          if(error?.code==='TRELIO_RUNTIME_HOOK_REQUIRED' && ['missing','invalid','expired','replayed'].includes(error.payload?.reason))nativeReason=error.payload.reason;
          throw Object.assign(error,{stderr:'Ошибка: '+common.formatBridgeCommandError(error,args[0])});
        }
        finally {process.stdout.write=write;process.chdir(previousDirectory);}
      },
    });} catch(error) {
      const diagnostic=error?.details?.http?.failureCode;
      if(error?.code==='TRELIO_WORKSPACE_ACTION_FAILED' && typeof diagnostic==='string')error.code=diagnostic;
      if(nativeHealthCause)error.code=nativeHealthCause;
      if(nativeCommandPolicyCause)error.code=nativeCommandPolicyCause;
      if(error?.code==='TRELIO_RUNTIME_HOOK_REQUIRED' && nativeReason)error.reason=nativeReason;
      throw error;
    }
  },{encryptedInspection:plan.encryptedInspection??null,
    workspaceRun:['open','status','heartbeat','checkpoint','finish','pause'].includes(plan.localAction.operation)?plan.runIdentity:null,
    secretBrowserFill:plan.localAction.operation==='secret_browser_fill'
    ? {grantId:plan.localAction.parameters.grantId,...plan.runIdentity}:null,
    secretSkill:plan.localAction.operation==='secret_skill_run'
      ? {...plan.localAction.parameters,...plan.runIdentity}:null,
    secretGeneration:plan.localAction.operation==='secret_generate'?{...plan.localAction.parameters,workspaceId:plan.runIdentity.workspaceId}:null});
};

export const runAssistantWorkspaceWorker = async ({input=process.stdin,output=process.stdout,executePlan=executeAssistantWorkspacePlan}={}) => {
  let bytes=0;const chunks=[];
  for await(const chunk of input){const part=Buffer.from(chunk);bytes+=part.length;if(bytes>131072)fail('ASSISTANT_WORKSPACE_PLAN_INVALID');chunks.push(part);}
  try {output.write(JSON.stringify(await executePlan(JSON.parse(Buffer.concat(chunks).toString('utf8'))))+'\n');}
  catch(error) {
    // The ordinary dispatcher has already projected typed HTTP/recovery errors.
    // Never return a native exception/cause/stack, arbitrary stderr or a private
    // store failure. Preserve just its closed code for explicit recovery.
    const {bridgeHttpDiagnosticCode}=await import('./trelio-bridge-http-diagnostics.mjs');
    const code=assistantHealthFailure(error)?error.code:Number.isInteger(error?.statusCode)?bridgeHttpDiagnosticCode(error.statusCode,error.code)
      : /^(?:ASSISTANT_|TRELIO_|LOCAL_WORKSPACE_|RUN_|LEASE_|STALE_)[A-Z_]{1,100}$/u.test(error?.code??'')?error.code:'ASSISTANT_WORKSPACE_EXECUTION_FAILED';
    const reason=error?.reason??error?.payload?.reason;
    process.stderr.write(JSON.stringify({code,...(code==='TRELIO_RUNTIME_HOOK_REQUIRED' && ['missing','invalid','expired','replayed'].includes(reason)?{reason}:{})})+'\n');process.exitCode=1;
  }
};

if (isDirectModuleInvocation(import.meta.url)) {
  runAssistantEntry(process.argv.slice(2)).catch(error => {
    if (process.argv[2] === 'hook') {
      // Preserve the common JSON-deny/exit-0 contract across Windows shells.
      // Broken input cannot silently turn a protected hook into permission.
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
        permissionDecision: 'deny', permissionDecisionReason: 'ASSISTANT_HOOK_UNAVAILABLE' } }) + '\n');
    } else {
      process.stderr.write((process.argv[2]?.startsWith('background-') ? safeError(error) : 'ASSISTANT_ENTRY_UNAVAILABLE') + '\n');
      process.exitCode = 1;
    }
  });
}
