#!/usr/bin/env node
import { maintainAssistantCodexUsage } from './trelio-assistant-codex.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolveHostRuntimeLoader, prepareHostRuntimeUpgrade } from './trelio-host-runtime-recovery.mjs';
// Internal source-tree harness compatibility only, not a model capability or
// an environment switch. An older signed worker must not silently ignore its
// trusted JS callbacks and reopen the production journal during QA acceptance.
export const ASSISTANT_MAINTAINER_QA_COMPOSITION_VERSION=1;
import { requireTrelioComponentVersions } from './trelio-component-versions.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ASSISTANT_MCP_TOOLS, ASSISTANT_MCP_READ_TOOLS, ASSISTANT_COMPANY_CONTEXT_READ_TOOLS, ASSISTANT_COMPANY_DISCOVERY_TOOLS, AssistantTransportError, assistantSetupRecovery, assistantTaskStorageDirectory, ASSISTANT_SOURCE_ACCOUNT_ERROR_CODES, ASSISTANT_SOURCE_MONITOR_ERROR_CODES,assistantSkillReadNeedsSetup,
  validateAssistantEncryptedInspection, supportsAssistantManagedContent, parseAssistantSourceReadReference, isAssistantStructuralResultRetraction, assistantRegistryDocumentReadSelection, normalizeAssistantSkillConsentParameters,normalizeAssistantSkillAccountSetupFields,normalizeAssistantSkillAccountSetupParameters,normalizeAssistantSkillAccountSetupPlan, assistantNeutralPrivateMetadata, assistantNeutralPrivateInput, assistantNeutralCompanySecret,projectAssistantSetupCompanies } from './trelio-assistant-transport.mjs';
import { StringDecoder } from 'node:string_decoder';
import { PROCESS_DIAGNOSTIC_CODES } from './trelio-process-diagnostics.mjs';
import { isDirectModuleInvocation, sameLocalPath } from './trelio-local-path.mjs';
import { createAssistantSetup, createAssistantWindowsBackground } from './trelio-assistant-setup.mjs';
import { maintainAssistantCodexDesktop, downloadCodexDesktop, runAssistantWindowsCodexUpdate } from './trelio-assistant-setup.mjs';
import { startLoadedCodexPluginPreservation } from './trelio-workspace.mjs';
import { workspaceRecoveryDirectory } from './trelio-workspace-directory.mjs';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const enrollment = { type: 'string', pattern: UUID };
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
// Returned by the CURRENT signed worker, not captured by the long-lived stdio
// facade. A runtime update can expose this tool through the existing list-change
// mechanism without a plugin/Codex restart or duplicating the stable setup ABI.
export const ASSISTANT_LOCAL_CONNECTION_TOOL=Object.freeze({name:'prepare_assistant_local_connection',
  description:'Start connection setup in this visible Desktop chat before choosing polling in Trelio. Use companyId:null when unknown: the sole native company is selected automatically; multiple companies return choices without creating an account. get_assistant_status also lists company IDs/slugs. Never ask the human to find an internal ID or use browser/human OAuth for company discovery. Then use the returned setup tool and human-only protected login form. Reuse clientRequestId after lost preparation; never repeat uncertain login. No import, polling, sending, intake or readiness claim.',
  inputSchema:schema({companyId:{anyOf:[enrollment,{type:'null'}]},skillId:{type:'string',enum:['telegram-mtproto','email-imap-smtp','max-web']},clientRequestId:enrollment}),annotations:{idempotentHint:true}});
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
const hostSetupToolNames=()=>[ASSISTANT_LOCAL_CONNECTION_TOOL.name,...sourceToolNames(),ASSISTANT_ENCRYPTION_SETUP_TOOL.name];
const interactiveSourceTool=name=>[ASSISTANT_EMAIL_SETUP_TOOL.name,ASSISTANT_TELEGRAM_SETUP_TOOL.name,ASSISTANT_MAX_SETUP_TOOL.name].includes(name);
const interactiveAssistantTool=name=>interactiveSourceTool(name)||name==='connect_remote_agent_skill';
const sourceSetupArguments=args=>{
  if(!args || Object.getPrototypeOf(args)!==Object.prototype || Object.keys(args).sort().join(',')!=='companyId,sourceId'
    || !new RegExp(UUID,'u').test(args.companyId??'') || args.sourceId!==null&&!new RegExp(UUID,'u').test(args.sourceId??''))
    throw Object.assign(new Error(),{code:'ASSISTANT_SETUP_INVALID_INPUT'});
  return {companyId:args.companyId,sourceId:args.sourceId};
};

// Owner UI navigation is deterministic runtime metadata, not something the
// model should reconstruct from usernames, remembered UUIDs or a task pass.
// IDs come only from the current paired client and exact native source scope;
// this link grants nothing and never claims that polling actually succeeded.
const assistantSourceSettings = (identity,companyId,sourceId,skillId) => {
  const label={'telegram-mtproto':'Telegram','email-imap-smtp':'Почта','max-web':'MAX'}[skillId];
  if(!label||![identity?.assistantId,companyId,sourceId].every(value=>new RegExp(UUID,'u').test(value??'')))return {};
  const url=new URL('/profile/',identity.origin);
  if(url.protocol!=='https:')fail('ASSISTANT_HOST_STATE_INVALID');
  url.searchParams.set('assistantSources',identity.assistantId);
  url.searchParams.set('sourceCompany',companyId);url.searchParams.set('source',sourceId);url.hash='account-assistants';
  return {sourceLabel:`${label} · ${sourceId.slice(-8)}`,settingsUrl:url.href};
};
export const assistantWorkerToolCatalogue=tools=>{
  if(!Array.isArray(tools)||tools.some(tool=>hostSetupToolNames().includes(tool?.name)))
    throw Object.assign(new Error(),{code:'ASSISTANT_MCP_INVALID_RESPONSE'});
  return [...tools,ASSISTANT_LOCAL_CONNECTION_TOOL,ASSISTANT_SOURCE_SETUP_TOOL,ASSISTANT_EMAIL_SETUP_TOOL,ASSISTANT_EMAIL_VERIFY_TOOL,ASSISTANT_TELEGRAM_SETUP_TOOL,ASSISTANT_MAX_SETUP_TOOL,ASSISTANT_MAX_VERIFY_TOOL,ASSISTANT_ENCRYPTION_SETUP_TOOL];
};
export const ASSISTANT_SETUP_TOOLS = Object.freeze([
  { name: 'begin_assistant_setup', description: 'Begin protected computer enrollment using the owner-provided locator. Returns a pairing code for review on the owner device, never credentials.',
    inputSchema: schema({ enrollmentId: enrollment, deviceName: { type: 'string', minLength: 1, maxLength: 120 } }) },
  { name: 'finish_assistant_setup', description: 'Check owner approval and complete the one-use protected exchange. A lost exchange requires a new enrollment; never blindly retry it.',
    inputSchema: schema({ enrollmentId: enrollment }) },
  { name: 'get_assistant_setup_status', description: 'Read local setup state and, for a paired device, verify live server contact. Does not imply task execution or background service readiness.',
    inputSchema: schema({ enrollmentId: enrollment }), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'install_assistant_background', description: 'Register the paired assistant supervisor for this Windows user at sign-in. Requires an explicit setup request. No automatic logon, saved password, elevation or readiness assertion. autoUpdatePlugin opts into model-free plugin maintenance and a graceful idle Desktop restart; set it only when the human explicitly requests that setup policy. autoUpdateCodex separately opts this machine into official signed Windows Desktop updates at the same idle boundary; never infer it from autoUpdatePlugin. Standalone CLI updates are excluded. Changed hooks remain human-reviewed. Does not start it now.',
    inputSchema: {type:'object',properties:{autoUpdatePlugin:{type:'boolean'},autoUpdateCodex:{type:'boolean'}},required:[],additionalProperties:false}, annotations: { idempotentHint: true } },
  { name: 'get_assistant_background_status', description: 'Read back this paired Windows user\'s exact Task Scheduler registration and OS running state, plus a content-free dispatch diagnostic. Missing company model or reasoning is a configuration block, even with no queued events. Unknown is not idle. Does not prove delivery or business readiness.',
    inputSchema: schema({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'start_assistant_background', description: 'Start the exact registered paired Windows supervisor after setup. Reuses an already running instance. Native task/pass/owner/model/hook admission still gates every business action; registration or OS running state is not a successful pilot.',
    inputSchema: schema({}), annotations: { idempotentHint: true } },
]);
const backgroundTools = { install_assistant_background: 'install', get_assistant_background_status: 'status', start_assistant_background: 'start' };
const codes = new Set(ASSISTANT_SETUP_TOOLS.map(tool => tool.name));
const safeError = error => assistantHealthFailure(error) || assistantSetupRecovery(error) || ASSISTANT_SOURCE_ACCOUNT_ERROR_CODES.includes(error?.code)
  || PROCESS_DIAGNOSTIC_CODES.includes(error?.code)
  || ASSISTANT_SOURCE_MONITOR_ERROR_CODES.includes(error?.code) || /^(?:REMOTE_MCP_|ASSISTANT_|DIGITAL_ASSISTANTS_|TRELIO_|LOCAL_WORKSPACE_|RUN_|LEASE_|STALE_)[A-Z_]{1,100}$/u.test(error?.code ?? '')
  ? error.code : 'ASSISTANT_SETUP_UNAVAILABLE';

export const callAssistantSetupTool = async (setup, name, args) => {
  if (!codes.has(name)) throw Object.assign(new Error(), { code: 'ASSISTANT_CAPABILITY_UNAVAILABLE' });
  if (Object.hasOwn(backgroundTools, name)) {
    if (!args || Object.getPrototypeOf(args) !== Object.prototype
      ||Object.keys(args).some(key=>name!=='install_assistant_background'||!['autoUpdatePlugin','autoUpdateCodex'].includes(key))
      ||['autoUpdatePlugin','autoUpdateCodex'].some(key=>Object.hasOwn(args,key)&&typeof args[key]!=='boolean')) {
      throw Object.assign(new Error(), { code: 'ASSISTANT_SETUP_INVALID_INPUT' });
    }
    return setup.background(backgroundTools[name],args);
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
export const createProductionAssistantSetup = async ({expectedOrigin='https://trelio.ru',configurationDirectory,createBackground=createProductionAssistantBackground}={}) => {
  const [{ createAssistantPrivateStore }, { createAssistantHttp }, common, { withPrivateProcessSession }, { createAssistantHostState }] = await Promise.all([
    import('./trelio-assistant-private.mjs'), import('./trelio-assistant-transport.mjs'), import('./trelio-workspace.mjs'),
    import('./trelio-hook-private-session.mjs'), import('./trelio-assistant-hook.mjs'),
  ]);
  const origin = expectedOrigin;
  const config=configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory();
  if(!path.isAbsolute(config))fail('ASSISTANT_HOST_STATE_INVALID');
  const store = createAssistantPrivateStore({ directory: path.join(config, 'digital-assistants', 'credentials') });
  const hostState = createAssistantHostState({ directory: path.join(config, 'digital-assistants'), store });
  const replacement=async()=>{
    const implementation=await import('./trelio-assistant-setup.mjs');
    if(typeof implementation.createAssistantWindowsBackgroundReplacement!=='function')fail('ASSISTANT_BACKGROUND_UNAVAILABLE');
    return implementation.createAssistantWindowsBackgroundReplacement({expectedOrigin:origin,readIdentity:hostState.readIdentity});
  };
  const setup = createAssistantSetup({ origin, store, host:hostState,http:createAssistantHttp({origin}),
    withLock:hostState.withSetupLock,
    backgroundReplacement:{inspect:async previous=>(await replacement()).inspect(previous),
      remove:async(previous,snapshot)=>(await replacement()).remove(previous,snapshot)} });
  // As in the common bridge, share one native worker only inside this tool
  // invocation. A long-lived MCP must not retain its ACL results or pipes.
  return { ...Object.fromEntries(Object.entries(setup).map(([name, action]) => [name,
    (...args) => withPrivateProcessSession(async () => {
      return action(...args);
    })])), background: async (operation,options) => (await createBackground())(operation,options) };
};

/** OS registration is composed only after an explicit setup call, never from
 * schema discovery or a task pass. The machine identity is the protected local
 * pairing; the model cannot choose a principal, executable or assistant UUID. */
export const createProductionAssistantBackground = async () => {
  const signal = AbortSignal.timeout(45_000);
  return createAssistantWindowsBackground({
    signal,
    prepareDependencies:({identity})=>prepareAssistantHookComponentBootstrap({signal,expectedIdentity:identity}),
    readIdentity: () => productionContext(client => client.identity, { signal }),
    setPluginUpdates:(enabled,identity,registration)=>productionContext((_client,host)=>host.withSetupLock(()=>host.setPluginUpdatesEnabled(enabled,identity,registration)),{signal}),
    setCodexUpdates:(enabled,identity)=>productionContext((_client,host)=>host.withSetupLock(()=>host.setCodexUpdatesEnabled(enabled,identity)),{signal}),
    verifyContact: () => productionContext(client => client.heartbeat(), { signal }),
    readDispatchStatus: ({signal:diagnosticSignal}) => readProductionAssistantDispatchStatus({signal:diagnosticSignal}),
    readMaintenanceStatus:({signal:diagnosticSignal})=>productionContext(async(_client,host)=>{
      const enabled=await host.readPluginUpdatesEnabled(),record=await host.readPluginUpdate();
      const codex=await host.readCodexUpdate();
      return {enabled,stage:record?.stage??'not_checked',lastCheckedVersion:record?.targetVersion??null,
        hookReviewRequired:record?.stage==='hook_review',codexUpdates:{enabled:await host.readCodexUpdatesEnabled(),
          stage:codex?.phase??'not_checked',lastCheckedVersion:codex?.targetVersion??null}};
    },{signal:diagnosticSignal}),
  });
};

/** Explicit initial background installation also needs its executable hook
 * dependency, even when ongoing automatic updates are opted out. Reuse the
 * SAME private update intent and official native installer; no Desktop/trust
 * operation is performed from this setup call. Unknown installation replies
 * can be reconciled on another explicit call, never replayed. */
export const prepareAssistantHookComponentBootstrap = async ({context=productionContext,environment=process.env,signal,expectedIdentity}={}) =>
  context(async(client,host)=>host.withSetupLock(async()=>{
    const common=await import('./trelio-workspace.mjs');
    const {resolveCodexExecutable,buildCodexEnvironment}=await import('./trelio-codex-conversation.mjs');
    const {promisify}=await import('node:util'),{execFile}=await import('node:child_process'),execute=promisify(execFile);
    const executable=await resolveCodexExecutable(environment,{signal}),env=buildCodexEnvironment(environment);
    if(!executable)fail('ASSISTANT_CODEX_UNAVAILABLE');
    const guard=async()=>{
      signal?.throwIfAborted();
      const current=await host.readIdentity();
      if(['assistantId','deviceId','origin'].some(key=>current?.[key]!==client.identity[key]
        ||expectedIdentity&&client.identity[key]!==expectedIdentity[key])||await host.readActivePass())
        fail('ASSISTANT_BACKGROUND_BUSY');
    };
    const execFileCommand=async(_c,args,options)=>{await guard();return execute(executable,args,{...options,env:{...env,GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat'},signal,timeout:30_000,shell:false,windowsHide:true});};
    const inventory=await common.readCodexPluginUpdateInventory({profile:'assistant',execFileCommand,environment:env});
    if(inventory.state!=='installed')fail('ASSISTANT_PLUGIN_UPDATE_REQUIRED');
    if(!inventory.hookComponent)return {state:'legacy'};
    let state=await host.readPluginUpdate();
    const save=async patch=>{
      await guard();const next={...state,...patch};await host.writePluginUpdate(state,next);state=next;
    };
    if(state&&(['failed','rolling_back','installing','closing','starting','verifying','retargeting'].includes(state.stage)
      ||state.targetVersion!==inventory.version||state.targetTreeSha256!==inventory.treeSha256))fail('ASSISTANT_BACKGROUND_BUSY');
    const options={requirement:inventory.hookComponent,execFileCommand,environment:env,signal};
    if(state?.stage==='hook_installing'){
      if(['pluginId','version','integritySha256'].some(key=>state.hookComponent?.[key]!==inventory.hookComponent[key])
        ||(await common.inspectAssistantHookComponent(options)).matches!==true)fail('ASSISTANT_PLUGIN_UPDATE_FAILED');
      await save({stage:'installed'});return {state:'installed'};
    }
    const result=await common.installAssistantHookComponent({...options,beforeInstall:async admission=>{
      await save({...(!state?{schemaVersion:1,assistantId:client.identity.assistantId,deviceId:client.identity.deviceId,
        previousVersion:inventory.version,previousTreeSha256:inventory.treeSha256,targetVersion:inventory.version,
        targetTreeSha256:inventory.treeSha256,desktopGeneration:null,restarts:0,failures:0,failedVersion:null}:{}),
        stage:'hook_installing',hookComponent:admission});
    }});
    if(result.publicationPending)fail('ASSISTANT_PLUGIN_UPDATE_REQUIRED');
    if(state?.stage==='hook_installing')await save({stage:'installed'});
    return {state:result.unchanged?'current':'installed'};
  }),{signal,pluginMaintenance:true});

/** The existing status tool may inspect the SAME private inbox only after a
 * fresh native company/device check. It does not construct a coordinator or
 * writable inbox: no migrations, polls, leases, schedule writes or ACKs occur.
 * Missing local state keeps counts null; a known native model block is still
 * shown before the first poll. Pairing changes discard the entire observation.
 */
export const readProductionAssistantDispatchStatus = async ({context=productionContext,
  configurationDirectory,openDatabase,readExecutionAvailability,now=Date.now,signal}={}) => {
  const {assistantDispatchDiagnostics}=await import('./trelio-assistant-coordinator.mjs');
  const unchecked=()=>({state:'not_checked',checkedConfigurations:0,unsupportedConfigurations:null,failureCode:null});
  try{
    const observed=await context(async(client,host)=>{
      const identity=client.identity;
      if(!identity||!new RegExp(UUID,'u').test(identity.assistantId??'')||!new RegExp(UUID,'u').test(identity.deviceId??''))
        fail('ASSISTANT_HOST_NOT_CONFIGURED');
      const companies=await client.companies(signal);
      const [{openAssistantDatabase},{readAssistantInboxDispatchSummary},common]=await Promise.all([
        import('./trelio-assistant-private.mjs'),import('./trelio-assistant-inbox.mjs'),import('./trelio-workspace.mjs')]);
      const directory=path.join(configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory(),
        'digital-assistants','runtime',identity.assistantId.toLowerCase(),identity.deviceId.toLowerCase());
      let opened,summary=null;
      try{
        opened=await (openDatabase??openAssistantDatabase)(directory,{readOnly:true});
        summary=readAssistantInboxDispatchSummary({database:opened.database,identity,companies});
      }catch(error){
        // Only positively absent state is an uninitialized queue. ACL, corrupt
        // schema or I/O never becomes empty or an idle/healthy observation.
        if(error?.code!=='ASSISTANT_PRIVATE_STATE_NOT_INITIALIZED')throw error;
      }finally{await opened?.close();}
      let diagnostic=assistantDispatchDiagnostics({companies,summary,now:now()});
      let nativeExecution=unchecked();
      // A single shared RPC reads account/model metadata for ALL current native
      // ready pairs under the original status signal. No model selection,
      // model turn, health report, login, hook trust or retry is performed.
      const choices=companies.filter(company=>company.execution?.state==='ready').map(company=>company.execution.configuration);
      if(choices.length&&diagnostic.state!=='unknown'){
        try{
          const check=readExecutionAvailability??(await import('./trelio-assistant-codex.mjs')).readAssistantCodexExecutionAvailabilitySet;
          const supported=await check(choices,{signal});
          if(!Array.isArray(supported)||supported.length!==choices.length||supported.some(value=>typeof value!=='boolean'))fail('ASSISTANT_CODEX_READ_UNAVAILABLE');
          const unavailable=supported.filter(value=>!value).length;
          nativeExecution={state:unavailable?'model_unavailable':'model_supported',checkedConfigurations:choices.length,unsupportedConfigurations:unavailable,
            failureCode:unavailable?'ASSISTANT_CODEX_MODEL_UNAVAILABLE':null};
        }catch(error){nativeExecution={state:error?.code==='ASSISTANT_CODEX_AUTH_REQUIRED'?'auth_required':'unknown',checkedConfigurations:0,unsupportedConfigurations:null,
          failureCode:['ASSISTANT_CODEX_AUTH_REQUIRED','ASSISTANT_CODEX_UNAVAILABLE','ASSISTANT_CODEX_READ_UNAVAILABLE','ASSISTANT_CODEX_INVALID_EXECUTION']
            .includes(error?.code)?error.code:'ASSISTANT_CODEX_READ_UNAVAILABLE'};}
        if(['model_unavailable','auth_required'].includes(nativeExecution.state))diagnostic={...diagnostic,state:'blocked',
          reasons:[...diagnostic.reasons,nativeExecution.state==='auth_required'?'codex_auth_required':'native_model_unavailable']};
        else if(nativeExecution.state==='unknown'&&diagnostic.state!=='blocked')diagnostic={...diagnostic,state:'unknown',reasons:['not_checked']};
      }
      const current=await host.readIdentity();
      if(['origin','assistantId','deviceId'].some(key=>current?.[key]!==identity[key]))fail('ASSISTANT_HOST_REBIND_REQUIRED');
      return {...diagnostic,nativeExecution};
    },{signal});
    return observed??{...assistantDispatchDiagnostics({now:now()}),nativeExecution:unchecked()};
  }catch{return {...assistantDispatchDiagnostics({now:now()}),nativeExecution:unchecked()};}
};

/** Reopen only the EXISTING same device inbox under the ordinary private
 * opener. Hook/skill invocations never invent a DB or persist bodies/keys in a
 * second read journal. SQLite transactions are short; native/provider I/O runs
 * outside them, with another snapshot read afterwards. */
const productionSourceReads=async({common,identity,client,host,signal})=>{
  const [{openAssistantDatabase},{createAssistantInbox},{createAssistantSourceReadObserver}]=await Promise.all([
    import('./trelio-assistant-private.mjs'),import('./trelio-assistant-inbox.mjs'),import('./trelio-assistant-transport.mjs')]);
  const directory=path.join(host.configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','runtime',
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
export const createProductionAssistantHook = async ({context=productionContext}={}) => context(async(client,hostState,store)=>{
  const common=await import('./trelio-workspace.mjs');
  const {createAssistantTaskHook}=await import('./trelio-assistant-hook.mjs');
  const identity=client.identity;
  const directory=path.join(hostState.configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants');
  const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
  const reads=await productionSourceReads({common,identity,client,host:hostState,signal:runtimeHookSignal()});
  return createAssistantTaskHook({identity,client,store,readActivePass:hostState.readActivePass,
    confirmSourceProcessing:reads.confirmProcessing,lockDirectory:path.join(directory,'runtime-locks')});
});

/** Invoke the shared Workspace engine under this device/pass only. The
 * protected native worker is scoped to one action; no human OAuth slot or
 * process-global auth state is selected. This helper is not a model tool and
 * does not itself open the businessReady gate. */
export const withProductionAssistantWorkspace = async (action, {signal,encryptedTaskRead=null,encryptedCompanyContext=null,companyReadPreparation=false,sourceAttachment=null,sourceWorkspaceFile=null,sourceRegistryDocument=null,encryptedInspection=null,encryptedSkillRead=null,workspaceRun=null,materialWorkspaceId=null,secretBrowserFill=null,secretGeneration=null,secretSkill=null,remoteMcp=null,skillAccountSetup=null,context=productionContext}={}) => {
  if(typeof action!=='function')throw Object.assign(new Error(),{code:'ASSISTANT_WORKSPACE_PROFILE_DENIED'});
  if(typeof companyReadPreparation!=='boolean'||companyReadPreparation&&!encryptedCompanyContext)
    fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  const [common,transport]=await Promise.all([import('./trelio-workspace.mjs'),import('./trelio-assistant-transport.mjs')]);
  return context(async(client,host,store)=>{
    const identity=client.identity;
    const directory=path.join(host.configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants');
    const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
    const sourceReads=encryptedCompanyContext||sourceAttachment||sourceWorkspaceFile||sourceRegistryDocument||(await host.readActivePass())?.kind==='source_intake'?null:await productionSourceReads({common,identity,client,host,signal:runtimeHookSignal()});
    const profile=await transport.createAssistantWorkspaceProfile({identity,client,store,host,sourceReads,encryptedTaskRead,encryptedCompanyContext,sourceAttachment,sourceWorkspaceFile,sourceRegistryDocument,encryptedInspection,encryptedSkillRead,workspaceRun,materialWorkspaceId,secretBrowserFill,secretGeneration,secretSkill,remoteMcp,skillAccountSetup,lockDirectory:path.join(directory,'runtime-locks')});
    return common.withWorkspaceExecutionProfile(profile,()=>action({identity,client,store,host,
      prepareWorkspaceRun:profile.prepareWorkspaceRun,
      prepareWorkspaceMaterial:profile.prepareWorkspaceMaterial,
      prepareAttachmentRead:profile.prepareAttachmentRead,
      readCompanyContentMode:profile.readCompanyContentMode,
      prepareCompanyContextRead:profile.prepareCompanyContextRead,
      assertPlainSourceFileRead:profile.assertPlainSourceFileRead,
      preparePrivateSkillArguments:profile.preparePrivateSkillArguments,
      preparePrivateBrowserArguments:profile.preparePrivateBrowserArguments,
      preparePrivateCardArguments:profile.preparePrivateCardArguments,
      prepareSkillConsentArguments:profile.prepareSkillConsentArguments,
      prepareSkillAccountSetupArguments:profile.prepareSkillAccountSetupArguments,
      encryptedTaskRead:profile.encryptedTaskRead,assertEncryptedTaskReadCurrent:profile.assertEncryptedTaskReadCurrent,
      withSecretGenerationKey:profile.withSecretGenerationKey}));
  },{signal,workspaceRun,...(companyReadPreparation?{companyReadPreparation:true}:{})});
};

/** Same private process/OS identity composition as the Workspace engine,
 * without constructing a fake task profile for a taskless source intake. The
 * fixed companies reader selects current mode; unsupported transitions never
 * send original prose to a remote tools/call. */
export const withProductionAssistantManagedContent=async({name,args,signal},send,{context=productionContext,withProfile=withProductionAssistantWorkspace}={})=>{
  const [common,transport]=await Promise.all([import('./trelio-workspace.mjs'),import('./trelio-assistant-transport.mjs')]);
  return context(async(client,host,store)=>{
    const identity=client.identity;
    const directory=path.join(host.configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants');
    const company=await transport.readAssistantCompanyContentMode({identity,host,client,signal});
    if(company.encryptionState==='plain')return send(args);
    let selectedArguments=args,privateSkillPreparation=null;
    if(name==='continue_assistant_workspace_action'&&args.operation==='secret_skill_prepare'){
      const skill=args.parameters?.skill;
      privateSkillPreparation=await withProfile(async current=>{
        if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key])
          ||typeof current.preparePrivateSkillArguments!=='function')fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
        return current.preparePrivateSkillArguments(args.parameters,signal,{inspectRecipe:true});
      },{signal,encryptedSkillRead:{schemaVersion:1,nativeTool:'get_agent_skill',companyId:company.companyId,
        projectId:skill?.projectId??null,skillId:skill?.skillId,releaseId:skill?.releaseId,arguments:{sections:['instructions','execution']}}});
    }
    if(name==='request_assistant_action'&&args.operation==='setup_skill_account'){
      const fields=transport.normalizeAssistantSkillAccountSetupFields(args.fields);
      const inspected=await withProfile(async current=>{
        if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key]))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
        return transport.inspectAssistantSkillAccountSetupForOwner({origin:identity.origin,companyId:company.companyId,fields,signal,common});
      },{signal,encryptedSkillRead:{schemaVersion:1,nativeTool:'get_agent_skill',companyId:company.companyId,
        projectId:fields.projectId,skillId:fields.skillId,releaseId:fields.releaseId,arguments:{sections:['instructions','execution']}}});
      if(inspected.privateRuntime)selectedArguments={...args,fields:{...fields,inspectedCommand:inspected.command}};
    }
    if(name==='request_assistant_action'&&args.operation==='accept_skill_runtime'){
      if(typeof args.reason!=='string'||Buffer.byteLength(args.reason.trim(),'utf8')>1400)fail('ASSISTANT_SKILL_CONSENT_REASON_TOO_LONG');
      const inspected=await withProfile(async current=>{
        if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key]))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
        const {validateAssistantActivePass}=await import('./trelio-assistant-hook.mjs');
        const pass=validateAssistantActivePass(await current.host.readActivePass(),identity);
        return transport.inspectAssistantSkillConsentForOwner({origin:identity.origin,companyId:pass.companyId,
          fields:args.fields,signal,common});
      },{signal,encryptedSkillRead:{schemaVersion:1,nativeTool:'get_agent_skill',companyId:company.companyId,
        projectId:args.fields?.projectId,skillId:args.fields?.skillId,releaseId:args.fields?.releaseId,
        arguments:{sections:['instructions','execution']}}});
      // Host-authored observation is protected in the SAME owner reason/intent.
      // It cannot be supplied by a model boolean or reused for another package;
      // the native sealed snapshot still pins its original exact byte hashes.
      selectedArguments={...args,reason:`${args.reason.trim()}\n\nЛокальная проверка подписанного зашифрованного пакета: ${inspected.capabilities.join(', ')||'нет заявленных возможностей'}; ${inspected.packageSizeBytes} байт. Пакет не запускался.`};
    }
    return transport.withAssistantManagedContentArguments({identity,host,client,store,lockDirectory:path.join(directory,'runtime-locks'),
      name,args:selectedArguments,signal,privateSkillPreparation},send);
  },{signal});
};

/** Execute only the positive native SAME accepted-file plan. This is a
 * production orchestration seam over the shared downloader, not a human bridge
 * call or a source writable pass. Native target/ACL/head fences remain live. */
export const materializeProductionAssistantCompanyFile = async ({identity,result,arguments:args,signal,withProfile=withProductionAssistantWorkspace}) => {
  const {buildTrelioWorkspaceActionInvocation}=await import('./trelio-local-context.mjs');
  const action=result.structuredContent?.bridge?.action;
  try{buildTrelioWorkspaceActionInvocation(action?.arguments);}catch{throw new AssistantTransportError('ASSISTANT_MCP_INVALID_RESPONSE');}
  if(action?.arguments?.operation!=='download_file'||result.structuredContent.delivery!=='local-file'
    ||['workspaceId','workspaceHead','filePath'].some(key=>action.arguments.parameters?.[key]!==args[key]))
    throw new AssistantTransportError('ASSISTANT_MCP_INVALID_RESPONSE');
  const locator=Object.fromEntries(['workspaceId','workspaceHead','filePath'].map(key=>[key,args[key]]));
  return withProfile(async current=>{
    if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key]))
      throw new AssistantTransportError('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    const files=await import('./trelio-workspace-files.mjs');
    const receipt=await files.downloadAcceptedWorkspaceFile(identity.origin,locator,
      {signal,assertPlainCompanyRead:current.assertPlainSourceFileRead});
    return {content:[{type:'text',text:'Original source file is available in the private local-file receipt.'}],structuredContent:receipt};
  },{signal,sourceWorkspaceFile:locator});
};

/** Schema discovery before enrollment needs no credential/private worker.
 * A present structural host journal switches to the ordinary protected path;
 * ACL/I/O/corruption errors are not treated as an unconfigured installation. */
export const createProductionAssistantMcp = async ({presentationProfile='task',prepareCompanySearch=false,context=productionContext,withProfile=withProductionAssistantWorkspace,withManagedContent=withProductionAssistantManagedContent,httpRequest}={}) => {
  if(typeof prepareCompanySearch!=='boolean')fail('ASSISTANT_REQUEST_INVALID');
  const common = await import('./trelio-workspace.mjs');
  // Preserve credential-free production discovery. A trusted maintainer context
  // owns its own private root; no tool, CLI envelope or environment selects it.
  if(context===productionContext){
    try{await fs.lstat(path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','identity.json'));}
    catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  const {createAssistantMcpClient,readAssistantOwnerIntakeMessage,replyAssistantOwnerIntake}=await import('./trelio-assistant-transport.mjs');
  return context(async(sourceClient,host,store)=>{
  const identity=sourceClient.identity;
  const directory=path.join(host.configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants');
  return createAssistantMcpClient({ ...identity, store, presentationProfile,httpRequest,
    withWorkspaceArguments:async(request,send)=>{
      // Discovery has its own native read session from startup. Ordinary task
      // get_task retains its existing adapter; only the protected owner intake
      // selects other company reads implicitly. Names never select authority.
      const active=typeof host.readActivePass==='function'?await host.readActivePass():null;
      return withAssistantEncryptedWorkspaceArguments(request,send,{withProfile,withManagedContent,
        companyContextRead:ASSISTANT_COMPANY_DISCOVERY_TOOLS.includes(request.name)||presentationProfile==='company_context'
          ||active?.kind==='source_intake'&&ASSISTANT_COMPANY_CONTEXT_READ_TOOLS.includes(request.name)});
    },
    readActivePass:host.readActivePass,
    materializeSourceIntake:async({result,arguments:args,signal})=>{
      const [{validateAssistantActivePass},{buildRuntimeSessionProof,withRuntimeStateLock},{openAssistantDatabase}]=await Promise.all([
        import('./trelio-assistant-hook.mjs'),import('./trelio-runtime-session.mjs'),import('./trelio-assistant-private.mjs')]);
      const pass=validateAssistantActivePass(await host.readActivePass(),identity),descriptor=result.structuredContent?.sourceRead;
      if(pass.kind!=='source_intake'||!descriptor||descriptor.intakeId!==pass.passId||descriptor.eventId!==pass.eventId
        ||descriptor.sourceId!==pass.sourceId||descriptor.sourceRevision!==pass.sourceRevision||descriptor.threadId!==pass.threadId
        ||descriptor.companyId!==pass.companyId||args.intakePass?.intakeId!==pass.passId)
        throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
      const routing=pass.intakeKind==='route_existing';
      if(routing&&(descriptor.kind!=='route_existing'||JSON.stringify(descriptor.eventIds)!==JSON.stringify(pass.eventIds)))
        throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
      const opened=await openAssistantDatabase(path.join(directory,'runtime',identity.assistantId,identity.deviceId));
      let references;
      try{
        const {createAssistantInbox}=await import('./trelio-assistant-inbox.mjs');
        const row=createAssistantInbox({database:opened.database}).ownerIntake(pass.passId);
        if(row.original_event_id!==pass.eventId||row.scope.bindingId!==pass.sourceId||row.scope.accountId!==descriptor.localAccountId
          ||row.source_revision!==pass.sourceRevision||row.thread_id!==pass.threadId||!['started','uncertain'].includes(row.state))
          throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
        if(routing&&(row.kind!=='route_existing'||!row.frozen||JSON.stringify(row.eventIds)!==JSON.stringify(pass.eventIds)))
          throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
        references=routing?row.originals.map(original=>({eventId:original.original_event_id,id:original.native_event_id,revision:original.native_revision,conversationKey:row.conversation_key}))
          :[{eventId:row.original_event_id,id:row.native_event_id,revision:row.native_revision,conversationKey:row.conversation_key}];
      }finally{await opened.close();}
      const source=(await sourceClient.sourceAccounts(pass.companyId,signal)).find(row=>row.id===pass.sourceId);
      const messages=[];let bytes=0;
      // Complete the frozen exact batch through the SAME signed read engine.
      // Partial reads never earn confirmation, owner proof, processing or ACK.
      for(const reference of references){
        const message=await readAssistantOwnerIntakeMessage({identity,client:sourceClient,host,store,pass,source,reference,signal});
        bytes+=Buffer.byteLength(message.text);if(bytes>262144)throw Object.assign(new Error(),{code:'ASSISTANT_SOURCE_READ_INVALID'});
        messages.push({...message,eventId:reference.eventId});
      }
      const message=messages[0];
      await withRuntimeStateLock(path.join(directory,'runtime-locks',`${pass.passId}.json`),async()=>{
        const latest=validateAssistantActivePass(await host.readActivePass(),identity);
        const saved=await store.get({origin:identity.origin,kind:'runtime',id:pass.passId});
        if(JSON.stringify(latest)!==JSON.stringify(pass)||saved?.ended||!saved?.state||saved.threadId!==pass.threadId)
          throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
        await sourceClient.confirmIntakeRead({intakePass:args.intakePass,...(routing?{kind:'route_existing',eventIds:pass.eventIds}
          :{ownerIdentityId:message.ownerIdentityId,senderExternalUserId:message.ownerExternalUserId,
            ...(message.privateOwnerConversation?{privateOwnerConversation:true}:{})}),runtimeSessionProof:buildRuntimeSessionProof({state:saved.state,
            toolName:'confirm_assistant_intake_read',now:new Date()})},signal);
      });
      const value={...result.structuredContent,...(routing?{sourceMessages:messages.map(({eventId,text})=>({eventId,text}))}
        :{ownerMessage:{text:message.text,verifiedNativeOwner:true,privateConversation:message.privateOwnerConversation===true}})};
      delete value.sourceRead;
      const readState=await openAssistantDatabase(path.join(directory,'runtime',identity.assistantId,identity.deviceId));
      try{const {createAssistantInbox}=await import('./trelio-assistant-inbox.mjs');
        createAssistantInbox({database:readState.database}).confirmIntakeModelRead(pass.passId,
          messages.map(({eventId,originalSha256})=>({eventId,...(originalSha256?{originalSha256}:{})})));
      }finally{await readState.close();}
      return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
    },
    materializeSourceReply:async({result,arguments:args,signal})=>{
      const [{validateAssistantActivePass},{openAssistantDatabase},{createAssistantInbox}]=await Promise.all([
        import('./trelio-assistant-hook.mjs'),import('./trelio-assistant-private.mjs'),import('./trelio-assistant-inbox.mjs')]);
      const pass=validateAssistantActivePass(await host.readActivePass(),identity),admitted=result.structuredContent;
      if(pass.kind!=='source_intake'||pass.intakeKind||args.intakePass?.intakeId!==pass.passId
        ||admitted?.state!=='reply_pending'||admitted.id!==pass.passId||admitted.eventId!==pass.eventId
        ||admitted.threadId!==pass.threadId||admitted.sourceId!==pass.sourceId||admitted.sourceRevision!==pass.sourceRevision
        ||admitted.reply?.receiptId!==admitted.receiptId||admitted.reply?.delivery!=='not_observed')
        throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
      const withInbox=async action=>{
        const opened=await openAssistantDatabase(path.join(directory,'runtime',identity.assistantId,identity.deviceId));
        try{return await action(createAssistantInbox({database:opened.database}));}finally{await opened.close();}
      };
      const row=await withInbox(inbox=>inbox.ownerIntake(pass.passId));
      if(row.kind!=='owner_command'||row.state!=='started'||row.thread_id!==pass.threadId||row.original_event_id!==pass.eventId
        ||row.scope.bindingId!==pass.sourceId||row.source_revision!==pass.sourceRevision||row.reply_receipt_id!==null)
        throw Object.assign(new Error(),{code:'ASSISTANT_INTAKE_CHANGED'});
      const source=(await sourceClient.sourceAccounts(pass.companyId,signal)).find(value=>value.id===pass.sourceId);
      await replyAssistantOwnerIntake({identity,client:sourceClient,host,store,pass,source,signal,
        receiptId:admitted.receiptId,replyText:args.replyText,
        reference:{eventId:row.original_event_id,id:row.native_event_id,revision:row.native_revision,conversationKey:row.conversation_key},
        beforeInvoke:()=>withInbox(inbox=>inbox.startOwnerReply(pass.passId,admitted.receiptId)),
        onConfirmed:positive=>withInbox(inbox=>inbox.confirmOwnerReply(pass.passId,positive))});
      // Positive provider evidence is already durable in SAME private SQLite.
      // A failed/lost confirmation is retried by coordinator as receipt-only
      // settlement, including after SessionEnd; it can never resend the text.
      const value=await sourceClient.confirmOwnerReply({intakePass:args.intakePass,receiptId:admitted.receiptId},signal);
      return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
    },
    materializeEncryptedTask: ({descriptor,signal}) => withProfile(async current => {
      if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key])) {
        throw Object.assign(new Error(),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
      }
      const {materializeAssistantEncryptedTask}=await import('./trelio-assistant-transport.mjs');
      return materializeAssistantEncryptedTask({origin:identity.origin,descriptor:current.encryptedTaskRead,signal,
        assertCurrent:current.assertEncryptedTaskReadCurrent});
    },{signal,encryptedTaskRead:descriptor}),
    materializeEncryptedCompanyContext: ({descriptor,name,arguments:args,signal}) => withProfile(async current => {
      if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key])
        ||typeof current.prepareCompanyContextRead!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      const {materializeAssistantEncryptedCompanyContext}=await import('./trelio-assistant-transport.mjs');
      const opened=await current.prepareCompanyContextRead(signal);
      // A cold encrypted mirror may require many bounded native file reads.
      // Only the new facade requests this host-only descriptor. It has already
      // passed the ordinary search schema/proof/native read admission, and the
      // fresh managed profile above repeats owner/pass/recipient checks. No
      // original query, plaintext result or key enters the preparation plan.
      if(prepareCompanySearch&&name==='search')return {content:[],
        _meta:{'trelio/assistant-company-read':{schemaVersion:1,descriptor,binding:assistantCompanyPreparationBinding(opened)}}};
      return materializeAssistantEncryptedCompanyContext({origin:identity.origin,descriptor,name,arguments:args,signal,
        assertCurrent:current.prepareCompanyContextRead});
    },{signal,encryptedCompanyContext:descriptor}),
    materializeEncryptedSkill: ({descriptor,signal}) => withProfile(async current => {
      if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key]))
        throw Object.assign(new Error(),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
      const {materializeAssistantEncryptedSkill}=await import('./trelio-assistant-transport.mjs');
      return materializeAssistantEncryptedSkill({origin:identity.origin,descriptor,signal});
    },{signal,encryptedSkillRead:descriptor}),
    materializeAttachment: ({result,attachmentId,registryDocument,knowledgeAttachment,signal}) => withProfile(async current => {
      if(['origin','assistantId','deviceId'].some(key=>current.identity[key]!==identity[key])) {
        throw Object.assign(new Error(),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
      }
      const {materializeAssistantAttachment}=await import('./trelio-assistant-transport.mjs');
      return materializeAssistantAttachment({origin:identity.origin,result,attachmentId,registryDocument,knowledgeAttachment,signal,
        prepareEncryptedRead:value=>current.prepareAttachmentRead(value),assertCurrent:()=>current.assertCompanyContextCurrent?.(signal)});
    },{signal,...(registryDocument?{sourceRegistryDocument:result.structuredContent}:{sourceAttachment:presentationProfile==='company_context'?result.structuredContent:null})}),
    materializeCompanyFile: input => materializeProductionAssistantCompanyFile({...input,identity,withProfile}),
  });
  });
};

// Long-lived stdio is deliberately only a facade. A fresh child resolves the
// current signed implementation for each invocation without reconnecting Codex.
export const createForwardingAssistantMcp = async ({presentationProfile='task',request=requestCurrentAssistantRuntime,createWorkspace=createAssistantWorkspaceExecutor,configurationDirectory}={}) => {
  // Preserve secret-free pre-enrollment discovery. A source-only or not-yet
  // paired installation must not require a loader, private worker or network.
  const common=await import('./trelio-workspace.mjs');
  try {await fs.lstat(path.join(configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','identity.json'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  const workspace = await createWorkspace();
  return {listTools:signal=>request({operation:'list',...(['remote_mcp','skill_setup','company_context'].includes(presentationProfile)?{presentationProfile}:{})},{signal}),
    async callTool(name,args,signal) {
      // The deferred read retains this invocation beyond its first await.
      // Preserve exactly the parsed original, never a mutable caller object.
      args=JSON.parse(JSON.stringify(args));
      const result=await request({operation:'call',name,arguments:args,
        ...(name==='search'?{prepareCompanySearch:true}:{}),
        ...(['remote_mcp','skill_setup','company_context'].includes(presentationProfile)?{presentationProfile}:{})},{signal});
      const preparation=result?._meta?.['trelio/assistant-company-read'];
      if(preparation!==undefined){
        if(name!=='search'||result.isError||preparation?.schemaVersion!==1
          ||Object.keys(preparation).sort().join(',')!=='binding,descriptor,schemaVersion')fail('ASSISTANT_MCP_INVALID_RESPONSE');
        // The native search proof was consumed exactly once above. A long
        // read-only preparation child has its own managed profile/lifetime;
        // polling never resends that proof or extends this MCP request. The
        // actual query executes only after preparation, under a fresh local
        // profile and all native source/recipient/generation fences.
        const prepared=await workspace.prepareCompanySearch(preparation,{signal,request});
        if(!prepared){
          const business=Object.fromEntries(Object.entries(args).filter(([key])=>!['taskPass','intakePass','runtimeSessionProof'].includes(key)));
          return {content:[{type:'text',text:'The complete encrypted company index is still preparing. After 10 seconds call nextCall with fresh hook admission. Do not create a task or Workspace Run, claim absence, or send a final unavailable reply while this preparation is progressing.'}],
            structuredContent:{schemaVersion:1,state:'preparing',readOnly:true,nextCall:{tool:'search',arguments:business}}};
        }
        return request({operation:'company_context_read',descriptor:preparation.descriptor,binding:preparation.binding,
          arguments:Object.fromEntries(Object.entries(args).filter(([key])=>!['taskPass','intakePass','runtimeSessionProof'].includes(key)))},{signal});
      }
      if(name!=='continue_assistant_workspace_action' || result?.isError)return result;
      // These are native metadata/preparation/creation receipts, not local command
      // plans. The next returned secret_browser_fill continuation executes in
      // the SAME isolated Workspace worker; no second browser executor exists.
      if(['secret_list','secret_browser_prepare','secret_create','skill_consent','skill_account_setup','external_account_admit'].includes(args?.operation))return result;
      let executed;
      try {executed=await workspace.execute(result.structuredContent,{signal});}
      catch(error) {
        await reportAssistantMaintenanceFailure(error).catch(()=>undefined);
        if(error?.code==='TRELIO_WORKSPACE_FINISH_UNKNOWN'){
          // The native request has already authorised this exact status plan.
          // A facade restart loses only its in-memory handle: polling it again
          // can never recover the writer's outcome. Return the existing READ
          // action without that handle, not a finish/claim, cached receipt or
          // permission to replay. The next call obtains a fresh native proof.
          const plan=await validateAssistantWorkspacePlan(result.structuredContent);
          if(plan.localAction.operation==='status' && plan.localAction.parameters.finishOperationId){
            const nextCall={tool:'continue_assistant_workspace_action',arguments:{schemaVersion:1,
              operation:'status',parameters:{},runIdentity:plan.runIdentity}};
            return {isError:true,content:[{type:'text',text:'The local finish handle is no longer retained. Do not poll it again or infer acceptance/a running writer. Execute the returned ordinary read-only status, then read the exact server Run. For an expired own Run, prepare that runId and execute its returned open before further writes. Preserve files; never resubmit an accepted Run or blindly repeat finish. Technical inspection/recovery does not need a new owner decision or approve sensitive actions.'}],
              structuredContent:{code:'TRELIO_WORKSPACE_FINISH_UNKNOWN',recovery:{readOnly:true,nextCall}}};
          }
        }
        throw error;
      }
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
  createWorkspace = createAssistantWorkspaceExecutor,
  maintenanceRequest = requestCurrentAssistantRuntime, scheduleMaintenance = setInterval,
  environment=process.env, preservePlugin=startLoadedCodexPluginPreservation } = {}) => {
  let pluginPreservation=null;
  // Only the progress/heartbeat coordinator belongs to the stdio host. Creating
  // it inside each short private invocation lost the finish operation between
  // its running response and the next status call. Keep ONE lazy coordinator,
  // not the native proxy, OS worker, credential, proof or request context. Each
  // call still constructs its fresh proxy and reauthorises the exact native
  // plan before the shared registry can return a receipt or poll its writer.
  let workspace;
  const sharedWorkspace=async()=>workspace??=await createWorkspace();
  let setup, initialized = false, busy = false, maintenance = null, maintenanceController = null, catalogRevision = null, presentationProfile = 'task';
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
    return withPrivateProcessSession(async () => action(await createMcp({presentationProfile,createWorkspace:sharedWorkspace}), runtimeHookSignal()),
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
      const response=respond({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'trelio-assistant', version: '1.0.0' },
        instructions: 'This computer uses assistant device pairing, not human OAuth. Setup/contact alone does not authorize task work.' });
      // SAME immutable-shell preservation as the human MCP, after writing
      // initialize and outside the request queue. A marketplace update must not
      // delete the exact already trusted hook/loader paths of this live client.
      pluginPreservation=preservePlugin({environment});
      return response;
    }
    if (message.method === 'ping') return respond({});
    if (!initialized) return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: 'Initialize first' } });
    if (message.method === 'tools/list') {
      try {
        const tools=await withProxy((proxy,signal)=>proxy?proxy.listTools(signal):[]);
        catalogRevision=assistantCatalogRevision(tools);
        return respond({tools:[...ASSISTANT_SETUP_TOOLS,...tools]});
      }
      catch (error) {
        if (assistantSetupRecovery(error)) {
          // Native clients load a server's initial catalogue during startup. A
          // broken local tuple OR a confirmed native device-auth refusal must
          // not make the six public repair tools unreachable. This is an
          // explicit failure projection, not an empty
          // privileged catalogue or a readiness claim. A later maintenance
          // heartbeat cannot clear it; only a fresh, successful tools/list can.
          const recovery=assistantSetupRecovery(error),native=recovery!=='local_device_credential_mismatch';
          catalogRevision=assistantCatalogRevision(ASSISTANT_SETUP_TOOLS);
          return respond({tools:[...ASSISTANT_SETUP_TOOLS],_meta:{'trelio/assistant-setup-recovery':{
            schemaVersion:1,state:recovery==='assistant_mcp_catalog_rejected'?'business_catalog_unavailable'
              :native?'device_authorization_required':'local_identity_conflict',code:error.code,
            ...(native?{status:error.status}:{}),
          }}});
        }
        return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: safeError(error) } });
      }
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
          const result=await withProxy((proxy, signal) => {
            if (!proxy) throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_NOT_CONFIGURED' });
            return proxy.callTool(message.params.name, message.params.arguments, signal);
          },{interactiveSourceSetup:interactiveAssistantTool(message.params.name)});
          // Reuse the existing catalogue-change notification. A native exact
          // skill read selects a SMALL presentation only, never another pass,
          // principal, scope, provider or retry policy. Returning status in the
          // remote view restores ordinary task tools without touching domain.
          let next=presentationProfile;
          if(message.params.name==='get_agent_skill' && !result?.isError
            && result?.structuredContent?.assistantExecution?.state==='shared_remote_mcp'
            && result.structuredContent.remoteMcpExecution?.localMcpServer==='trelio-assistant') next='remote_mcp';
          if(message.params.name==='get_agent_skill' && !result?.isError
            && result?.structuredContent?.assistantExecution?.state==='shared_runtime_setup'){
            const execution=result.structuredContent.assistantExecution;
            // A signed login declaration describes an AVAILABLE setup path;
            // it does not mean this task needs authentication. Ordinary skill
            // instructions/execution reads must retain task/Run operations.
            // Otherwise a configured messenger hides skill_run and finish,
            // making their valid returned arguments fail against setup's enum.
            // Connection is the existing explicit setup-read section. Pending
            // native runtime consent independently still needs the small view;
            // neither choice approves setup or changes pass/provider authority.
            next=assistantSkillReadNeedsSetup(execution,message.params.arguments.sections)?'skill_setup':'task';
          }
          if(message.params.name==='get_assistant_status' && !result?.isError)next=message.params.arguments.view==='company_context'
            &&result?.structuredContent?.companyContextRead===true&&result.structuredContent.presentationProfile==='company_context'?'company_context':'task';
          respond(result);
          if(next!==presentationProfile){presentationProfile=next;catalogRevision=null;reply({jsonrpc:'2.0',method:'notifications/tools/list_changed'});}
          return;
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
    await workspace?.stop();
    await pluginPreservation?.close?.();
  }
};

export const runAssistantEntry = async (args, options = {}) => {
  const flags=args.slice(1),names={'plugin':'autoUpdatePlugin','codex':'autoUpdateCodex'};
  const pluginPolicy=args[0]==='background-install'&&flags.length>0&&flags.length<=2
    &&flags.every(flag=>/^--auto-update-(plugin|codex)=(on|off)$/u.test(flag))
    &&new Set(flags.map(flag=>flag.split('=')[0])).size===flags.length
    ?Object.fromEntries(flags.map(flag=>[names[flag.split('=')[0].slice('--auto-update-'.length)],flag.endsWith('=on')])):null;
  if ((!pluginPolicy&&args.length !== 1) || !['mcp', 'hook', 'request', 'background', 'workspace',
    'background-install', 'background-status', 'background-start', 'background-remove'].includes(args[0])) throw new Error('ASSISTANT_COMMAND_UNSUPPORTED');
  if (args[0].startsWith('background-')) {
    const manage = await (options.createBackground ?? createProductionAssistantBackground)();
    (options.output ?? process.stdout).write(JSON.stringify(await manage(args[0].slice('background-'.length),pluginPolicy??{})) + '\n');
    return;
  }
  if (args[0] === 'workspace') return runAssistantWorkspaceWorker(options);
  if (args[0] === 'mcp') return runAssistantSetupMcp(options);
  if (args[0] === 'background') return options.runBackground?options.runBackground(options):runAssistantBackground({...options,
    recordSupervisor:recordProductionAssistantSupervisor,maintainUnavailableWorker:maintainAssistantUnavailableWorker});
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
    } catch(error) {output.write(JSON.stringify({failure:safeError(error),
      ...(assistantSetupRecovery(error)?{setupRecovery:assistantSetupRecovery(error),
        ...(assistantSetupRecovery(error)!=='local_device_credential_mismatch'?{status:error.status}:{})}:{})})+'\n');}
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
const reasons = new Set(['ready','not_checked','plugin_update_required','plugin_restart_required','mcp_reconnect_required','runtime_update_failed','codex_auth_required','hook_review_required','dispatch_review_required','codex_capacity_wait','connection_lost']);
const assistantHealthCodes = Object.freeze({
  ASSISTANT_CODEX_UPDATE_FAILED:'runtime_update_failed',
  AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED:'plugin_update_required',
  TRELIO_PLUGIN_RESTART_REQUIRED:'plugin_restart_required',
  ASSISTANT_PLUGIN_UPDATE_REQUIRED:'plugin_update_required',
  ASSISTANT_PLUGIN_UPDATE_FAILED:'plugin_update_required',
  ASSISTANT_PLUGIN_DESKTOP_UNAVAILABLE:'plugin_restart_required',
  ASSISTANT_RUNTIME_UPDATE_REQUIRED:'runtime_update_failed',
  AGENT_WORKSPACE_HOST_RUNTIME_UPGRADE_REQUIRED:'runtime_update_failed',
  ASSISTANT_MCP_RECONNECT_REQUIRED:'mcp_reconnect_required',
  ASSISTANT_CODEX_AUTH_REQUIRED:'codex_auth_required',
  ASSISTANT_CODEX_MODEL_CAPACITY:'codex_capacity_wait',
  ASSISTANT_HOOK_REVIEW_REQUIRED:'hook_review_required',
  ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN:'dispatch_review_required',
  ASSISTANT_COORDINATOR_DELIVERY_REVIEW_REQUIRED:'dispatch_review_required',
  ASSISTANT_COORDINATOR_PROVISION_REVIEW_REQUIRED:'dispatch_review_required',
  ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED:'dispatch_review_required',
  ASSISTANT_INTAKE_PROVISION_REVIEW_REQUIRED:'dispatch_review_required',
  ASSISTANT_INTAKE_REVIEW_REQUIRED:'dispatch_review_required',
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
  if(['company_context_prepare','company_context_read'].includes(request?.operation)){
    const keys=request.operation==='company_context_read'?'arguments,binding,descriptor,operation':'binding,descriptor,operation';
    if(Object.getPrototypeOf(request)!==Object.prototype||Object.keys(request).sort().join(',')!==keys
      ||!request.descriptor||Object.getPrototypeOf(request.descriptor)!==Object.prototype
      ||request.descriptor.nativeTool!=='search'
      ||request.operation==='company_context_read'&&(!request.arguments||Object.getPrototypeOf(request.arguments)!==Object.prototype))
      fail('ASSISTANT_REQUEST_INVALID');
    validateAssistantCompanyPreparationBinding(request.binding);
    return request;
  }
  if(!request || !['list','call','health','health_check','background_tick'].includes(request.operation)
    || Object.keys(request).some(key=>!['operation','name','arguments','presentationProfile','prepareCompanySearch'].includes(key))
    || request.prepareCompanySearch!==undefined&&(request.prepareCompanySearch!==true||request.operation!=='call'||request.name!=='search')
    || request.presentationProfile!==undefined && (!['list','call'].includes(request.operation)||!['remote_mcp','skill_setup','company_context'].includes(request.presentationProfile))
    || request.operation==='call' && (typeof request.name!=='string' || !/^[a-z][a-z0-9_]{0,99}$/u.test(request.name)
      || !request.arguments || Object.getPrototypeOf(request.arguments)!==Object.prototype)
    || request.operation!=='call' && Object.keys(request).length!==(request.presentationProfile===undefined?1:2)) fail('ASSISTANT_REQUEST_INVALID');
  return request;
};

export const requestCurrentAssistantRuntime = async (request, {environment=process.env,spawnProcess=spawn,
  resolveLoader=resolveHostRuntimeLoader,signal,timeoutMs}={}) => {
  validateAssistantRuntimeRequest(request);
  const interactive=request.operation==='call'&&interactiveAssistantTool(request.name);
  const preparing=request.operation==='company_context_prepare';
  timeoutMs??=interactive||preparing?11*60_000:120_000;
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<50 || timeoutMs>(request.operation==='background_tick'?35*60_000:interactive||preparing?11*60_000:180_000))fail('ASSISTANT_REQUEST_INVALID');
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
          if(value?.failure && (/^(?:ASSISTANT_|DIGITAL_ASSISTANTS_)[A-Z_]{1,100}$/u.test(value.failure)
            ||PROCESS_DIAGNOSTIC_CODES.includes(value.failure)||value.failure==='TRELIO_SKILL_PYTHON_REQUIRED'
            ||assistantSetupRecovery({code:value.failure,setupRecovery:value.setupRecovery,status:value.status}))) {
            const allowed=Object.keys(value).sort().join(',') === 'failure'
              || ['failure,setupRecovery','failure,setupRecovery,status'].includes(Object.keys(value).sort().join(','))
                &&assistantSetupRecovery({code:value.failure,setupRecovery:value.setupRecovery,status:value.status})
                &&(value.setupRecovery!=='local_device_credential_mismatch')===Object.hasOwn(value,'status');
            if(!allowed)return abort();
            return finish(Object.assign(new Error(value.failure),{code:value.failure,
              ...(value.setupRecovery?{setupRecovery:value.setupRecovery}:{}) ,...(value.status?{status:value.status}:{})}));
          }
          if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).join(',')!=='value')return abort();
          finish(null,value.value);
        } catch { abort(); }
      });
      child.stdin.end(input);
    } catch { abort(); }
  });
};

/** The setup request deadline is not the lifetime of a Workspace bridge.
 * A finish can stream several files while its existing coordinator owns the
 * child. As in the human CLI, private startup/each IPC request stay bounded;
 * every HTTP request still rechecks the genuine pass, own Run and native lease.
 * Killing that private session at 45s discarded healthy saves near publication.
 * This internal selector is not a model deadline/grant: only the closed own-Run
 * cell can omit the setup timer. Technical plugin maintenance has its own fixed
 * bounded budget; neither profile can extend a caller/outer hook signal.
 */
export const assistantProductionContextSignal = ({signal,interactiveSourceSetup=false,workspaceRun=null,pluginMaintenance=false,codexMaintenance=false,companyReadPreparation=false}={},
  timeout=milliseconds=>AbortSignal.timeout(milliseconds)) => {
  if(typeof pluginMaintenance!=='boolean'||typeof codexMaintenance!=='boolean'||typeof companyReadPreparation!=='boolean'
    ||Number(pluginMaintenance)+Number(codexMaintenance)+Number(interactiveSourceSetup)+Number(companyReadPreparation)>1)fail('ASSISTANT_REQUEST_INVALID');
  if(workspaceRun!==null){
    if(pluginMaintenance || codexMaintenance || interactiveSourceSetup || companyReadPreparation || !workspaceRun || Object.getPrototypeOf(workspaceRun)!==Object.prototype
      || Object.keys(workspaceRun).sort().join(',')!=='runId,workspaceId'
      || Object.values(workspaceRun).some(value=>typeof value!=='string'||!new RegExp(UUID,'u').test(value)))
      fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
    return signal;
  }
  const deadline=timeout(codexMaintenance?15*60_000:companyReadPreparation?10*60_000:pluginMaintenance?150_000:interactiveSourceSetup?11*60_000:45_000);
  return signal?AbortSignal.any([signal,deadline]):deadline;
};

const productionContext = async (action, options = {}) => {
  const signal=assistantProductionContextSignal(options);
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
  },signal);
};

const coordinatorMethods = ['heartbeat','companies','tasks','task','poll','acknowledge','claimTaskHost',
  'beginTaskPass','readTaskPass','renewTaskPass','readBusinessOutcome','reportSchedule','ownerIdentities',
  'beginSourceIntake','readSourceIntake','registerIntakeRuntime','endIntakeRuntime','cancelSourceIntake','confirmOwnerReply'];
const businessCapabilities = ['task_context','task_mutations','task_pass_outcome','workspace_execution','owner_decisions','background_service'];
/** Reuse the host setup mutex at the final NEW-work HTTP boundary. This is a
 * denial/CAS check, never domain admission: native owner/device/task guards
 * still authorize the callback. Existing pass outcome/recovery does not enter
 * it and cannot lose its signing key because a replacement was requested. */
export const withAssistantNewWorkAdmission = (host,identity,action) => {
  const run=async()=>{
    const current=await host.readIdentity();
    if(!current||['origin','assistantId','deviceId'].some(key=>current[key]!==identity[key]))fail('ASSISTANT_HOST_REBIND_REQUIRED');
    if(['pending_owner','quiescing'].includes((await host.readActivation())?.stage))fail('ASSISTANT_HOST_REBIND_REQUIRED');
    return action();
  };
  return host.withSetupLock(run);
};
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
  const invoke=async (action,newWork=false)=>{
    const value=await context(async(client,host,store)=>{
      if(['origin','assistantId','deviceId'].some(key=>client.identity[key]!==stableIdentity[key])) fail('ASSISTANT_HOST_REBIND_REQUIRED');
      const execute=async()=>({value:await action(client,host,store)});
      // The local pending-owner fence and a native NEW pass admission cannot
      // cross between their check and HTTP. Existing pass completion/recovery
      // never takes this denial path and retains its original key/outcome.
      return newWork?withAssistantNewWorkAdmission(host,stableIdentity,execute):execute();
    });
    if(value===null) fail('ASSISTANT_HOST_NOT_CONFIGURED');
    return value.value;
  };
  const client={identity:stableIdentity,...Object.fromEntries(coordinatorMethods.map(name=>[name,(...args)=>invoke(live=>live[name](...args),
    ['claimTaskHost','beginTaskPass','beginSourceIntake'].includes(name))]))};
  const privateInvocation=action=>withPrivateProcessSession(action,AbortSignal.timeout(45_000));
  const configDirectory=dependencies.configurationDirectory??dependencies.directory??common.resolveWorkspaceBridgeConfigDirectory();
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
      readDelivery:nativeRuntime.readAssistantCodexDelivery,readOwnerReply:nativeRuntime.readAssistantCodexOwnerReply};
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
        if(error?.code==='ASSISTANT_HOOK_REVIEW_REQUIRED')await reportAuthentication('hook_review_required',options.signal);
        throw error;
      }
    }]))};
    const readStatus=dependencies.readStatus??(signal=>invoke(async()=>{
      const proxy=await createProductionAssistantMcp();
      if(!proxy) fail('ASSISTANT_HOST_NOT_CONFIGURED');
      return proxy.callTool('get_assistant_status',{},signal);
    }));
    const passHost=Object.fromEntries(['readActivePass','activatePass','releasePass'].map(name=>[name,(...args)=>invoke((_client,host)=>host[name](...args))]));
    passHost.recoverPass=(input,expectedPass,signal)=>invoke(async(live,host)=>{
      // Pairing/rebind and recovery share the existing setup mutex. Never use
      // a pre-lock host getter as proof of the current protected pass identity.
      const current=await host.readActivePass();
      const same=value=>value&&Object.keys(value).length===Object.keys(expectedPass).length&&Object.keys(expectedPass).every(key=>value[key]===expectedPass[key]);
      if(!same(current))fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      const result=await live.renewTaskPass({...input,preNativeRecovery:true},signal);
      if(!same(await host.readActivePass()))fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      return result;
    },true);
    passHost.continuePass=(input,expectedPass,signal)=>invoke(async(live,host)=>{
      // The control request stays device-only and under the existing setup
      // mutex. A replacement identity, task or pass cannot inherit the original
      // task authorization. It is never exposed as a model MCP alias.
      const same=value=>value&&Object.keys(value).length===Object.keys(expectedPass).length
        &&Object.keys(expectedPass).every(key=>value[key]===expectedPass[key]);
      if(!same(await host.readActivePass()))fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      const result=await live.continueTaskPass(input,signal);
      if(!same(await host.readActivePass()))fail('ASSISTANT_PASS_REVIEW_REQUIRED');
      return result;
    },true);

    // Source calls re-enter the same protected private invocation and signed
    // account/provider reader. No long-lived credential/worker or provider code
    // is copied into this coordinator. The narrower private deadline propagates
    // to the child as well as native I/O; it never extends a poll lease.
    const readSourceMonitor=dependencies.readSourceMonitor??((source,signal)=>invoke(async(live,host,store)=>{
      const {readAssistantSourceMonitor}=await import('./trelio-assistant-transport.mjs');
      const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
      const current=runtimeHookSignal(),combined=signal?AbortSignal.any([signal,current]):current;
      return readAssistantSourceMonitor({identity:stableIdentity,host,store,client:live,source,signal:combined});
    }));
    const acknowledgeSource=dependencies.acknowledgeSource??((input,signal)=>invoke(async(live,host,store)=>{
      const {acknowledgeAssistantSource}=await import('./trelio-assistant-transport.mjs');
      const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
      const current=runtimeHookSignal(),combined=signal?AbortSignal.any([signal,current]):current;
      return acknowledgeAssistantSource({identity:stableIdentity,host,store,client:live,...input,signal:combined});
    }));
    const verifyOwnerReply=dependencies.verifyOwnerReply??((input,signal)=>invoke(async(live,host,store)=>{
      const {verifyAssistantOwnerReply}=await import('./trelio-assistant-transport.mjs');
      const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
      const current=runtimeHookSignal(),combined=signal?AbortSignal.any([signal,current]):current;
      const row=input.row,pass=await host.readActivePass();
      if(pass?.kind!=='source_intake'||pass.passId!==row.id||pass.threadId!==row.thread_id)fail('ASSISTANT_INTAKE_CHANGED');
      const source=(await live.sourceAccounts(pass.companyId,combined)).find(value=>value.id===pass.sourceId);
      return verifyAssistantOwnerReply({identity:stableIdentity,client:live,host,store,pass,source,signal:combined,
        receiptId:input.outcome.receiptId,replyText:input.replyText,candidateMessageId:input.candidateMessageId,
        reference:{eventId:row.original_event_id,id:row.native_event_id,revision:row.native_revision,conversationKey:row.conversation_key}});
    }));
    coordinator=createAssistantCoordinator({database:database.database,client:{...client,
      sourceAccounts:(...args)=>invoke(live=>live.sourceAccounts(...args)),
      sourceRoutes:(...args)=>invoke(live=>live.sourceRoutes(...args))},passHost,readSourceMonitor,acknowledgeSource,verifyOwnerReply,
      sourceHealth:{read:(row,signal)=>invoke(live=>live.readSourceHealth(row.companyId,row.id,signal)),
        report:(row,observation,signal)=>invoke(live=>live.reportSourceHealth({companyId:row.companyId,sourceId:row.id,...observation},signal))},
      native:{...observedNative,
        readPrerequisites:dependencies.readHookReadiness??nativeRuntime.readAssistantCodexHookReadiness,
        ready:async(_identity,signal)=>assistantCoordinatorReadiness(await readStatus(signal),stableIdentity)},
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
      // Only the coordinator's committed business/native completion boundary
      // may clear dispatch review. A metadata check, READY provision, model
      // catalogue or an empty queue is never evidence of repaired work.
      onBusinessConfirmed:()=>invoke(live=>reportAssistantDispatchRecovery(live)),
      ...(dependencies.now?{now:dependencies.now}:{}),...(dependencies.notify?{notify:dependencies.notify}:{}),
    });
    return {identity:stableIdentity,coordinator,
      async codexUsage(signal){
        return invoke(live=>maintainAssistantCodexUsage({client:live,signal,
          readUsage:()=>nativeRuntime.readAssistantCodexUsage({signal})}));
      },
      // Every immutable worker owns its diagnostic boundary. An already live
      // supervisor may still run an older module and cannot know a new cause.
      reportDispatchFailure:error=>invoke(live=>reportAssistantMaintenanceFailure(error,live)),async close(){
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

/** Resolve the NEW executable through the common strict loader reader. The
 * old paths are only literal CAS comparators for the existing native scheduled
 * action: Codex may already have pruned those versions. Requiring an old file
 * to remain executable makes both forward activation and rollback deadlock.
 * The caller supplies only its loader-selected root and protected journal;
 * these paths are never discovered from cache, executed or model-selectable.
 */
export const resolveAssistantPluginHandoffLoaders = async ({installedPath,loadedPluginDirectory,journal,
  environment=process.env,resolveLoader=resolveHostRuntimeLoader}) => {
  if(!installedPath||!path.isAbsolute(installedPath)||!loadedPluginDirectory||!path.isAbsolute(loadedPluginDirectory))
    fail('TRELIO_PLUGIN_RESTART_REQUIRED');
  const nextLoader=await resolveLoader({environment:{...environment,TRELIO_PLUGIN_ROOT:installedPath}});
  const previousLoaders=[...new Set([path.join(loadedPluginDirectory,'scripts','trelio-host-runtime-loader.mjs'),
    ...[journal.previousVersion,journal.failedVersion].filter(Boolean)
      .map(version=>path.join(path.dirname(installedPath),version,'scripts','trelio-host-runtime-loader.mjs'))])];
  return {nextLoader,previousLoaders};
};

/** Only the supervisor's signed tick enters plugin maintenance. An idle
 * model-facing MCP health call never closes the user's Desktop/setup chat.
 * Keep the existing SQLite coordinator lease and protected setup identity;
 * the common updater/retention and native executable resolver remain the only
 * installation/process paths. No experimental plugin/install RPC is used. */
export const runProductionAssistantPluginMaintenance = async (runtime,{context=productionContext,
  environment=process.env,platform=process.platform,signal}={}) => {
  if(platform!=='win32')return {state:'unsupported'};
  // Existing setup explicitly excluded Desktop restart. Preserve that contract
  // until the human opts this paired device into maintenance once at setup.
  const policy=await context(async(_client,host)=>({enabled:await host.readPluginUpdatesEnabled(),codex:await host.readCodexUpdate?.()}),{signal});
  if(policy.enabled!==true)return {state:'disabled'};
  // A prior Desktop deployment owns its GUI lifecycle until read-back. Do not
  // start a plugin installation/restart over that unresolved private journal.
  // The ordinary tick proceeds directly to the Desktop recovery below.
  if(policy.codex&&!['ready','failed'].includes(policy.codex.phase))return {state:'codex_pending'};
  const deadline=AbortSignal.timeout(150_000);
  signal=signal?AbortSignal.any([signal,deadline]):deadline;
  return runtime.coordinator.maintainPluginAtIdleBoundary(coordinatorGuard=>context(async (lockedClient,lockedHost)=>lockedHost.withSetupLock(async()=>{
    // This control plane deliberately remains reachable under a business
    // version floor, but revoked/expired/paused devices cannot maintain code.
    await lockedClient.readHealth(signal);
    const common=await import('./trelio-workspace.mjs');
    const {resolveCodexExecutable,buildCodexEnvironment}=await import('./trelio-codex-conversation.mjs');
    const {maintainAssistantPlugin,runAssistantWindowsDesktop}=await import('./trelio-assistant-setup.mjs');
    const {readAssistantCodexPluginReadiness}=await import('./trelio-assistant-codex.mjs');
    const executable=await resolveCodexExecutable(environment,{signal});
    if(!executable)fail('ASSISTANT_CODEX_UNAVAILABLE');
    const {promisify}=await import('node:util'),{execFile}=await import('node:child_process');
    const execute=promisify(execFile),env=buildCodexEnvironment(environment);
    const guard=async()=>{
      await coordinatorGuard();signal.throwIfAborted();
      if(['assistantId','deviceId','origin'].some(key=>lockedClient.identity[key]!==runtime.identity[key])
        ||['pending_owner','quiescing'].includes((await lockedHost.readActivation())?.stage)
        ||await lockedHost.readActivePass()!==null||await lockedHost.readPluginUpdatesEnabled()!==true)
        fail('ASSISTANT_HOST_REBIND_REQUIRED');
    };
    const execFileCommand=async(_command,args,options)=>{
      await guard();return execute(executable,args,{...options,env:{...env,GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat'},
        timeout:40_000,signal,shell:false,windowsHide:true});
    };
    const inventory=async()=>{
      const journal=await lockedHost.readPluginUpdate();
      const version=journal?.stage==='rolling_back'?journal.previousVersion:journal?.targetVersion;
      const treeSha256=journal?.stage==='rolling_back'?journal.previousTreeSha256:journal?.targetTreeSha256;
      const current=await common.readCodexPluginUpdateInventory({profile:'assistant',execFileCommand,environment:env,
        receipt:version&&treeSha256?{version,treeSha256}:null});
      if(current.state==='installed'&&(!treeSha256||current.version!==version)){
        // Pin the exact NEW native candidate before maintenance adopts its
        // digest. A later GUI/native metadata refresh must still have that
        // original immutable basis; never manufacture it from changed bytes.
        const retained=await common.retainLoadedCodexPluginInstallation({profile:'assistant',
          loadedPluginDirectory:current.installedPath,loadedPluginVersion:current.version});
        if(retained.treeSha256!==current.treeSha256)fail('ASSISTANT_PLUGIN_UPDATE_FAILED');
      }
      return current;
    };
    const loadedPluginDirectory=environment.TRELIO_PLUGIN_ROOT;
    if(!loadedPluginDirectory||!path.isAbsolute(loadedPluginDirectory))fail('TRELIO_PLUGIN_RESTART_REQUIRED');
    const parent=await lockedHost.readPluginSupervisor();
    const bootstrapHost=parent?.generation!==environment.TRELIO_ASSISTANT_SUPERVISOR_GENERATION
      ||parent?.runtimeVersion!==requireTrelioComponentVersions().hostRuntimeVersion;
    return maintainAssistantPlugin({identity:runtime.identity,guard,inventory,bootstrapHost,
      readState:()=>lockedHost.readPluginUpdate(),
      writeState:(expected,next)=>lockedHost.writePluginUpdate(expected,next),
      upgrade:(current,beforeInstall)=>common.updateCodexPluginMarketplace({profile:'assistant',onlyIfNewerThan:current,beforeInstall,
        execFileCommand,environment:env,signal,loadedPluginDirectory,loadedPluginVersion:path.basename(loadedPluginDirectory)}),
      hooks:(operation,requirement,beforeInstall)=>operation==='inspect'
        ?common.inspectAssistantHookComponent({requirement,execFileCommand,environment:env})
        :common.installAssistantHookComponent({requirement,beforeInstall,execFileCommand,environment:env,signal}),
      rollback:(version,treeSha256)=>common.restoreAssistantCodexPluginVersion({version,treeSha256,execFileCommand,environment:env,
        loadedPluginDirectory,loadedPluginVersion:path.basename(loadedPluginDirectory)}),
      desktop:(operation,generation)=>runAssistantWindowsDesktop(operation,generation,{environment,signal,guard}),
      activateHost:async installed=>{
        await guard();
        const restartRequested=bootstrapHost||path.resolve(installed.installedPath)!==path.resolve(loadedPluginDirectory);
        const journal=await lockedHost.readPluginUpdate();
        // These are only exact previously observed versions in the protected
        // journal. Old arguments are compared, never executed or adopted. This
        // also repairs the registration when rolling back an uncertain update.
        const {nextLoader,previousLoaders}=await resolveAssistantPluginHandoffLoaders({
          installedPath:installed.installedPath,loadedPluginDirectory,journal,environment});
        const retarget=createAssistantWindowsBackground({environment,signal,previousLoaders,restartRequested,
          resolveLoader:async()=>nextLoader,readIdentity:()=>lockedHost.readIdentity(),
          verifyContact:async()=>{await guard();await lockedClient.heartbeat(signal);await guard();}});
        await retarget('retarget');await guard();
        // The existing parent already understands quiescing. Its clean exit
        // releases the same lease/snapshot; the native one-shot trigger starts
        // the retargeted task later, without killing or detaching a process.
        return {state:restartRequested?'handoff':'current'};
      },
      probe:async installed=>{
        await readAssistantCodexPluginReadiness(process.cwd(),{environment:{...environment,TRELIO_PLUGIN_ROOT:installed.installedPath},signal});
        // Native global status may be null even with a cached catalogue. Prove
        // the exact installed shell can start a fresh signed request worker and
        // perform the genuine paired device read, without a model/new chat.
        const result=await requestCurrentAssistantRuntime({operation:'call',name:'get_assistant_status',arguments:{}},
          {environment,signal,timeoutMs:30_000,resolveLoader:async()=>path.join(installed.installedPath,'scripts','trelio-host-runtime-loader.mjs')});
        const value=result?.structuredContent;
        if(result?.isError||value?.assistantUserId!==runtime.identity.assistantId||value?.deviceId!==runtime.identity.deviceId)
          fail('ASSISTANT_MCP_RECONNECT_REQUIRED');
      },
    });
  }),{signal,pluginMaintenance:true}),signal).catch(error=>{
    if(['TRELIO_RUNTIME_LOCK_TIMEOUT','ASSISTANT_COORDINATOR_BUSY'].includes(error?.code))return {state:'deferred',blockBusiness:true};
    if(assistantHealthFailure(error))throw error;
    fail('ASSISTANT_PLUGIN_UPDATE_FAILED');
  });
};

/** Desktop servicing is available only to the background worker, with separate
 * per-device consent. It reuses the strict coordinator and setup locks rather
 * than interpreting a quiet UI or an expired delivery as an idle computer. */
export const runProductionAssistantCodexMaintenance = async (runtime,{context=productionContext,environment=process.env,
  platform=process.platform,signal,nativeUpdate=runAssistantWindowsCodexUpdate,download=downloadCodexDesktop,desktop,probe}={}) => {
  if(platform!=='win32')return {state:'unsupported'};
  const policy=await context(async(_client,host)=>({enabled:await host.readCodexUpdatesEnabled(),state:await host.readCodexUpdate()}),{signal});
  if(!policy.enabled){
    // Revoking permission cannot silently make an unfinished installation idle.
    // Leave its journal intact and surface the same closed health incident.
    if(policy.state&&!['ready','failed'].includes(policy.state.phase))fail('ASSISTANT_CODEX_UPDATE_FAILED');
    return {state:'disabled'};
  }
  const deadline=AbortSignal.timeout(15*60_000);signal=signal?AbortSignal.any([signal,deadline]):deadline;
  return runtime.coordinator.maintainPluginAtIdleBoundary(coordinatorGuard=>context(async(client,host)=>host.withSetupLock(async()=>{
    const guard=async()=>{
      await coordinatorGuard();signal.throwIfAborted();
      if(['assistantId','deviceId','origin'].some(key=>client.identity[key]!==runtime.identity[key])
        ||['pending_owner','quiescing'].includes((await host.readActivation())?.stage)
        ||await host.readActivePass()!==null||await host.readCodexUpdatesEnabled()!==true)fail('ASSISTANT_HOST_REBIND_REQUIRED');
      // Desktop servicing has its own consent and can outlive a normal tick.
      // A local opt-in/identity never proves that this device is still live:
      // recheck the model-free native control plane before every effect, even
      // when plugin maintenance was disabled or the download took minutes.
      // Revocation, pause, owner removal and expiry must stop OS mutations.
      await client.readHealth(signal);signal.throwIfAborted();
    };
    const packagePath=await host.codexUpdatePackagePath();
    const update=(operation,extra={})=>nativeUpdate(operation,{environment,signal,guard,packagePath,...extra});
    const desktopEngine=desktop??(await import('./trelio-assistant-setup.mjs')).runAssistantWindowsDesktop;
    return maintainAssistantCodexDesktop({identity:runtime.identity,guard,
      readState:()=>host.readCodexUpdate(),writeState:(expected,value)=>host.writeCodexUpdate(expected,value),
      inspect:()=>update('inspect'),prepare:sha256=>update('prepare',{sha256}),install:(sha256,version)=>update('install',{sha256,version}),
      download:(architecture,etag,installedVersion)=>download({architecture,etag,installedVersion,packagePath,signal}),
      desktop:(operation,generation)=>desktopEngine(operation,generation,{environment,signal,guard}),
      probe:probe??(async()=>{
        // A fresh process must still see the genuine configured/trusted plugin.
        // This never clears login/trust/dispatch latches or starts a model turn.
        const {readAssistantCodexPluginReadiness}=await import('./trelio-assistant-codex.mjs');
        await guard();await readAssistantCodexPluginReadiness(process.cwd(),{environment,signal});
        const response=await requestCurrentAssistantRuntime({operation:'call',name:'get_assistant_status',arguments:{}},
          {environment,signal,timeoutMs:30_000});
        if(response?.isError||response?.structuredContent?.assistantUserId!==runtime.identity.assistantId
          ||response?.structuredContent?.deviceId!==runtime.identity.deviceId)fail('ASSISTANT_MCP_RECONNECT_REQUIRED');
      }),
    });
  }),{signal,codexMaintenance:true}),signal).catch(error=>{
    if(['TRELIO_RUNTIME_LOCK_TIMEOUT','ASSISTANT_COORDINATOR_BUSY'].includes(error?.code))return {state:'deferred'};
    if(assistantHealthFailure(error))throw error;
    fail('ASSISTANT_CODEX_UPDATE_FAILED');
  });
};

/** One worker owns one native pass, retaining model-free polling and durable
 * recovery. Neither code maintenance nor a later worker replays that pass. */
export const runAssistantBackgroundTick = async ({createHost=createAssistantRuntimeHost,signal,
  pluginMaintenance=runProductionAssistantPluginMaintenance,codexMaintenance=runProductionAssistantCodexMaintenance,wait=waitForAssistantPoll,
  now=()=>performance.now()}={}) => {
  if(signal?.aborted)fail('ASSISTANT_COORDINATOR_STOPPED');
  const startedAt=now();
  const host=await createHost();
  const reportDispatch=async(dispatch,error=null)=>{
    const failure=dispatch?.failure?.code==='ASSISTANT_CODEX_MODEL_CAPACITY'
      && (!error||['ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN','ASSISTANT_COORDINATOR_DELIVERY_REVIEW_REQUIRED'].includes(error.code))
      ?{code:'ASSISTANT_CODEX_MODEL_CAPACITY'}:dispatch?.reasons?.includes('delivery_uncertain')
      ?{code:'ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN'}:error;
    // The CURRENT signed worker reports even when its long-lived parent knows
    // only an older health enum. Failed reporting never hides the original
    // cause, advances a cursor, clears the fence or repeats native work.
    if(failure&&host.reportDispatchFailure)try{await host.reportDispatchFailure(failure);}catch{}
  };
  try {
    // The already-running stable supervisor selects this fresh signed worker;
    // enabling maintenance needs no extra plugin ABI or manual parent restart.
    const update=await pluginMaintenance(host,{signal});
    if(update?.blockBusiness){
      if(update.state==='host_handoff')return {schemaVersion:1,state:'quiescing'};
      if(update.state==='hook_review')await reportDispatch(null,{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});
      return {schemaVersion:1,state:'blocked',reason:update.state};
    }
    if(update?.failedVersion||update?.state==='rolled_back')await reportDispatch(null,{code:'ASSISTANT_PLUGIN_UPDATE_FAILED'});
    // Finish plugin activation first; two independent installers must never
    // close/activate Desktop under competing journals. The same coordinator
    // lease/setup mutex then excludes new tasks, uncertain deliveries and login.
    const codex=await codexMaintenance(host,{signal});
    if(codex?.blockBusiness){
      if(codex.state==='hook_review')await reportDispatch(null,{code:'ASSISTANT_HOOK_REVIEW_REQUIRED'});
      return {schemaVersion:1,state:'blocked',reason:codex.state};
    }
    if(codex?.failedVersion)await reportDispatch(null,{code:'ASSISTANT_CODEX_UPDATE_FAILED'});
    // The parent grants one 35-minute request budget, including maintenance.
    // A large MSIX must not consume a later task's native execution window and
    // indirectly interrupt that task. Before any poll/claim, yield to the next
    // ordinary worker when servicing exceeded the original plugin allowance.
    // No pass exists yet, so this needs no replay, renewed task lease or change
    // to an in-flight deadline. The parent's next request gets its own budget.
    if(now()-startedAt>=150_000)return {schemaVersion:1,state:'idle'};
    let usage=null;
    try{usage=await host.codexUsage?.(signal);}catch{
      // An unavailable usage read cannot erase an already stored quota block.
      // Polling remains safe, but a fresh worker must not guess it can start.
      await host.coordinator.pollOnce(signal);
      return {schemaVersion:1,state:'blocked',reason:'codex_usage_unavailable'};
    }
    await host.coordinator.pollOnce(signal);
    if(usage?.blocked)return {schemaVersion:1,state:'blocked',reason:'codex_usage_limited'};
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
    const dispatch=await host.coordinator.dispatchStatus(signal);
    await reportDispatch(dispatch);
    const nextPollMs=host.coordinator.modelCapacityRetryDelay?.();
    return {schemaVersion:1,state:['blocked','unknown','queued'].includes(dispatch.state)?dispatch.state:result.value===null?'idle':'checked',dispatch,
      ...(nextPollMs?{nextPollMs}:{})};
  } catch(error) {
    let dispatch=null;
    try{dispatch=await host.coordinator.dispatchStatus?.(signal);}catch{}
    await reportDispatch(dispatch,error);
    // A confirmed native capacity failure is a paced WAIT, not unknown work.
    // Returning its closed projection also keeps an older long-lived parent
    // from manufacturing a generic dispatch-review latch on every tick.
    if(dispatch?.failure?.code==='ASSISTANT_CODEX_MODEL_CAPACITY'
      &&['ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN','ASSISTANT_COORDINATOR_DELIVERY_REVIEW_REQUIRED'].includes(error.code))
      return {schemaVersion:1,state:'blocked',dispatch,...(host.coordinator.modelCapacityRetryDelay?.()?{nextPollMs:host.coordinator.modelCapacityRetryDelay()}:{})};
    throw error;
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
    // A new worker and an older/newer parent can both observe this SAME fence.
    // The second read must preserve the current incident rather than rewrite
    // contact/CAS or cover a newer unrelated problem. Native generations still
    // independently deduplicate every concurrent report at commit.
    if(['dispatch_review_required','codex_capacity_wait'].includes(code)&&(current.code===code||current.latchedCodes?.includes(code)))return current;
    return connection.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code});
  };
  return client?report(client):productionContext(report);
};

/** Called only after the SAME coordinator has committed its exact native +
 * business receipt and released the protected pass. No status read calls this
 * function. Preserve a newer unrelated incident; CAS/network failures cannot
 * roll back the committed work or replay the native/provider action. */
export const reportAssistantDispatchRecovery = async client => {
  try {
    // Only this committed business/native boundary clears either obligation.
    // Re-read between independent CAS reports; an auth/hook/other dispatch
    // incident cannot be erased by successfully recovering a capacity episode.
    for(const reason of ['dispatch_review_required','codex_capacity_wait']) {
      const current=await client.readHealth();
      if(!['dispatch_review_required','codex_capacity_wait'].includes(current.code))return;
      if(current.code!==reason&&!current.latchedCodes?.includes(reason))continue;
      await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),
        code:'ready',clearedReason:reason});
    }
  } catch { /* A future genuine completion may safely retry this diagnostic boundary. */ }
};

/** A non-authorizing generation stamp identifies this actual immutable parent,
 * not a fresh request worker. It is separate from hook/pass/owner authority.
 * The private store and setup mutex remain the only state engine. */
export const recordProductionAssistantSupervisor = async (identity,generation) => {
  if(process.platform!=='win32')return;
  return productionContext((_client,host)=>host.withSetupLock(()=>host.recordPluginSupervisor(
    requireTrelioComponentVersions().hostRuntimeVersion,generation,identity)));
};

/** Technical recovery also remains reachable in an already-loaded signed
 * parent when a new plugin/runtime floor prevents a fresh worker from loading.
 * Only global device metadata, verified native plugin code and the SAME idle
 * lease are used. No old business code, model turn or company content runs. */
export const maintainAssistantUnavailableWorker = async ({environment,signal}={}) => {
  if(process.platform!=='win32'||await productionContext((_client,host)=>host.readPluginUpdatesEnabled())!==true)
    return {state:'disabled'};
  const runtime=await createAssistantRuntimeHost();
  try{
    const plugin=await runProductionAssistantPluginMaintenance(runtime,{environment,signal});
    return plugin?.blockBusiness?plugin:await runProductionAssistantCodexMaintenance(runtime,{environment,signal});
  }
  finally{await runtime.close();}
};

/** Stable model-free supervisor of our own runtime workers.
 * A fresh verified loader selects the immutable implementation for every
 * cycle. Updates wait for the active pass; no in-process import replacement,
 * guessed plugin cache or business retry is involved. Explicitly opted-in
 * plugin maintenance owns its separate idle Desktop/registered-parent handoff.
 * OS registration is a separate explicit onboarding step.
 */
export const runAssistantBackground = async ({signal,request=requestCurrentAssistantRuntime,
  readHost=()=>productionContext(async(client,host)=>({identity:client.identity,activation:await host.readActivation()})),
  verifyRegistration=async()=>process.platform==='win32'?(await createProductionAssistantBackground())('status'):null,
  startConsoleIcon=async identity=>(await import('./trelio-assistant-setup.mjs')).startAssistantWindowsConsoleIcon({identity}),
  wait=waitForAssistantPoll,reportFailure=reportAssistantMaintenanceFailure,
  environment=process.env,preservePlugin=startLoadedCodexPluginPreservation,
  recordSupervisor=async()=>{},maintainUnavailableWorker=async()=>({state:'disabled'})}={}) => {
  const controller=new AbortController();
  const stop=()=>controller.abort();
  const effective=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  let consoleIcon=null,pluginPreservation=null;
  try {
    const initial=await readHost();
    if(!initial?.identity)fail('ASSISTANT_HOST_NOT_CONFIGURED');
    const identity=JSON.stringify(initial.identity);
    const fenced=value=>['pending_owner','quiescing'].includes(value?.activation?.stage);
    if(fenced(initial))return {schemaVersion:1,state:'stopped',reason:'replacement_pending'};
    // An old Task Scheduler registration must never start a fresh parent for
    // the new identity at its next logon. The SAME native status validator
    // checks the current marker/SID/action before any worker or maintenance.
    await verifyRegistration();
    // A supervisor outlives individual MCP clients. Preserve its exact loaded
    // shell BEFORE starting workers, using the common verifier/watch lifecycle;
    // this never chooses another installed plugin or changes hook trust.
    pluginPreservation=preservePlugin({environment});
    await pluginPreservation.ready;
    const generation=randomUUID();
    await recordSupervisor(initial.identity,generation);
    const workerEnvironment={...environment,TRELIO_ASSISTANT_SUPERVISOR_GENERATION:generation};
    // Cosmetic only, after the exact identity/OS registration checks. The
    // helper refuses shared/hidden/terminal-host windows; a failed icon never
    // changes admission, native work, its deadline or a running window's focus.
    try{consoleIcon=await startConsoleIcon(initial.identity);}catch{}
    while(!effective.aborted) {
      let nextPollMs=300_000;
      try {
        const current=await readHost();
        if(JSON.stringify(current?.identity)!==identity||fenced(current))break;
        const health=await request({operation:'health'},{signal:effective,environment:workerEnvironment});
        if(health?.state==='quiescing')break;
        if(!effective.aborted){
          const cycle=await request({operation:'background_tick'},{signal:effective,timeoutMs:35*60_000,environment:workerEnvironment});
          if(cycle?.state==='quiescing')break;
          if(Number.isSafeInteger(cycle?.nextPollMs)&&cycle.nextPollMs>=1000&&cycle.nextPollMs<=300_000)nextPollMs=cycle.nextPollMs;
          // A retained unknown operation can be returned by reconciliation
          // without throwing. Report only this closed, device-global fence;
          // missing model and waiting-owner remain their independent policies.
          if(cycle?.dispatch?.reasons?.includes('delivery_uncertain'))
            await reportFailure({code:'ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN'}).catch(()=>undefined);
        }
      } catch(error) {
        if(!effective.aborted)await reportFailure(error).catch(()=>undefined);
        if(!effective.aborted)try{
          const maintenance=await maintainUnavailableWorker({environment:workerEnvironment,signal:effective});
          if(maintenance?.state==='host_handoff')break;
        }catch(maintenanceError){await reportFailure(maintenanceError).catch(()=>undefined);}
        // Retained SQLite/native-start/pass receipts own recovery. This is the
        // next polling cycle, never a second invocation of a business tool.
      }
      if(!effective.aborted)await wait(nextPollMs,effective);
    }
    return {schemaVersion:1,state:'stopped'};
  } finally {
    try{await consoleIcon?.close?.();}catch{} // Cosmetic cleanup cannot hide a work/transport outcome.
    await pluginPreservation?.close?.();
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
  }
};

export const executeAssistantRuntimeRequest = async (request,{context=productionContext,proxyFor=createProductionAssistantMcp,
  backgroundTick=runAssistantBackgroundTick,requestRuntime=requestCurrentAssistantRuntime,upgradeRuntime=prepareHostRuntimeUpgrade,
  companyContextOperation=executeAssistantCompanyContextRequest,
  createRuntimeHost=createAssistantRuntimeHost,
  versions=requireTrelioComponentVersions,prepareSource=async input=>(await import('./trelio-assistant-transport.mjs')).prepareAssistantSourceAccount(input),
  prepareLocalConnection=async input=>(await import('./trelio-assistant-transport.mjs')).prepareAssistantLocalConnection(input),
  prepareEncryption=async input=>(await import('./trelio-assistant-transport.mjs')).prepareAssistantCompanyEncryption(input),
  configureSource=async input=>(await import('./trelio-assistant-transport.mjs')).configureAssistantEmailSource(input),
  configureTelegramSource=async input=>(await import('./trelio-assistant-transport.mjs')).configureAssistantTelegramSource(input),
  configureMaxSource=async input=>(await import('./trelio-assistant-transport.mjs')).configureAssistantMaxSource(input),
  verifyMaxSource=async input=>(await import('./trelio-assistant-transport.mjs')).verifyAssistantMaxSource(input),
  verifySource=async input=>(await import('./trelio-assistant-transport.mjs')).verifyAssistantEmailSource(input)}={}) => {
  validateAssistantRuntimeRequest(request);
  if(['company_context_prepare','company_context_read'].includes(request.operation))return companyContextOperation(request);
  if(['health','health_check','background_tick'].includes(request.operation)){
    // Fresh workers fence legacy supervisors too: an old parent may ignore
    // this structural response and remain running, but cannot start polling,
    // updater work or another task while replacement is pending. It must be
    // stopped manually only after the exact protected pass has settled.
    const pending=await context(async(_client,host)=>['pending_owner','quiescing'].includes((await host.readActivation?.())?.stage));
    if(pending===true)return {schemaVersion:1,state:'quiescing'};
  }
  if(request.operation==='background_tick')return backgroundTick();
  if(request.operation==='health') {
    const canUpdate=await context(async (_client,host)=>!await host.readActivePass());
    if(canUpdate===null)return null;
    try {
      if(canUpdate)await upgradeRuntime({timeoutMs:30_000});
      else {
        // The current worker verifies an idle terminal boundary under the
        // existing SQLite lease. A completed retained pass must not deadlock
        // the very signed update which repairs its recovery flow. Active,
        // unknown and unstarted continuations remain pinned and untouched.
        const runtime=await createRuntimeHost();
        try{await runtime.coordinator.updateRuntimeAtBoundary(()=>upgradeRuntime({timeoutMs:30_000}));}
        finally{await runtime.close();}
      }
      // Downloading is not activation. A new worker selected by the verified
      // pointer proves the actual loaded version before reporting recovery.
      return await requestRuntime({operation:'health_check'});
    } catch(error) {
      const direct=assistantHealthFailure(error);
      return context(client=>maintainAssistantHost({client,versions:versions(),
        update:async()=>{throw new Error();},probe:async()=>{if(direct)fail(error.code);},
      }));
    }
  }
  if(request.operation==='health_check') {
    return context(async (client,host)=>{
      let catalog=null;
      const state=await maintainAssistantHost({client,versions:versions(),update:async()=>{},
        probe:async signal=>{
          const update=await host.readPluginUpdate?.();
          if(update?.failedVersion||update?.stage==='failed')fail('ASSISTANT_PLUGIN_UPDATE_FAILED');
          const codex=await host.readCodexUpdate?.();
          if(codex?.failedVersion||codex&&!['ready'].includes(codex.phase))fail('ASSISTANT_CODEX_UPDATE_FAILED');
          const proxy=await proxyFor();if(!proxy)fail('ASSISTANT_HOST_NOT_CONFIGURED');
          catalog=assistantWorkerToolCatalogue(await proxy.listTools(signal));
        },
      });
      // Discovery is read-only metadata, independent of idle-only maintenance.
      // A retained pass may be precisely the reason a loaded Desktop catalogue
      // needs the new signed worker's definitions. Never clear health, renew a
      // pass or replay a tool here; the old facade only emits list_changed.
      if(catalog===null){const proxy=await proxyFor();if(proxy)catalog=assistantWorkerToolCatalogue(await proxy.listTools());}
      return {...state,...(catalog===null?{}:{catalogRevision:assistantCatalogRevision(catalog)})};
    });
  }
  if(!['list','call'].includes(request.operation))fail('ASSISTANT_REQUEST_INVALID');
  // Validate the exact tool before any credential read, as in ordinary MCP.
  const {ASSISTANT_MCP_TOOLS}=await import('./trelio-assistant-transport.mjs');
  const localConnection=request.operation==='call'&&request.name===ASSISTANT_LOCAL_CONNECTION_TOOL.name;
  if(localConnection&&(!request.arguments||Object.getPrototypeOf(request.arguments)!==Object.prototype
    ||Object.keys(request.arguments).sort().join(',')!=='clientRequestId,companyId,skillId'
    ||request.arguments.companyId!==null&&!new RegExp(UUID,'u').test(request.arguments.companyId??'')
    ||!new RegExp(UUID,'u').test(request.arguments.clientRequestId??'')
    ||!['telegram-mtproto','email-imap-smtp','max-web'].includes(request.arguments.skillId)))fail('ASSISTANT_SETUP_INVALID_INPUT');
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
  if(request.operation==='call' && !sourceSetup && !localConnection && !encryptionSetup && !ASSISTANT_MCP_TOOLS.includes(request.name))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
  return context(async (client,host,store)=>{
    const current=await client.readHealth();
    const blocked=assistantHealthCompatibility(current,versions());
    if(blocked) {
      await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code:blocked});
      fail(blocked==='plugin_update_required'?'ASSISTANT_PLUGIN_UPDATE_REQUIRED':'ASSISTANT_RUNTIME_UPDATE_REQUIRED');
    }
    const proxy=await proxyFor({presentationProfile:request.presentationProfile??'task',
      ...(request.prepareCompanySearch?{prepareCompanySearch:true}:{})});
    if(!proxy)return request.operation==='list'?[]:fail('ASSISTANT_HOST_NOT_CONFIGURED');
    try {
      let result;
      if(localConnection){
        // A normal task/inbound conversation cannot self-provision new accounts.
        // This settings action is taskless; the human supplies factors only in
        // the SAME protected local form, and native rows remain non-polling.
        try{
          if(await host.readActivePass())fail('ASSISTANT_LOCAL_SETUP_TASK_ACTIVE');
          const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
          const value=await prepareLocalConnection({identity:client.identity,client,host,store,...request.arguments,signal:runtimeHookSignal()});
          result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
        }catch(error){const code=safeError(error);result={isError:true,content:[{type:'text',text:code}],structuredContent:{code}};}
      }else if(encryptionSetup){
        try{
          const value=await prepareEncryption({identity:client.identity,client,host,store,...encryptionArguments});
          result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
        }catch(error){const code=safeError(error);result={isError:true,content:[{type:'text',text:code}],structuredContent:{code}};}
      }else if(sourceSetup){
        try{
          const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
          const perform=async()=>sourceVerification?await(request.name===ASSISTANT_MAX_VERIFY_TOOL.name?verifyMaxSource:verifySource)({identity:client.identity,client,host,store,...sourceArguments,signal:runtimeHookSignal()}):
            interactiveSourceSetup?await(request.name===ASSISTANT_MAX_SETUP_TOOL.name?configureMaxSource:request.name===ASSISTANT_TELEGRAM_SETUP_TOOL.name?configureTelegramSource:configureSource)
              ({identity:client.identity,client,host,store,...sourceArguments,signal:runtimeHookSignal()}):sourceArguments.sourceId===null?
            {sources:(await client.sourceAccounts(sourceArguments.companyId,runtimeHookSignal())).map(source=>({sourceId:source.id,
              skillId:source.skillId,projectId:source.projectId,state:source.state,revision:source.revision,
              provisionLocalAccount:source.provisionLocalAccount,
              ...assistantSourceSettings(client.identity,sourceArguments.companyId,source.id,source.skillId),
              ...(source.interactiveSetupAllowed===true?{interactiveSetupAllowed:true}:{}),executionVerified:false}))}:
            await prepareSource({identity:client.identity,client,host,store,...sourceArguments,signal:runtimeHookSignal()});
          let value=interactiveSourceSetup?await host.withSetupLock(perform):await perform();
          if(request.name===ASSISTANT_TELEGRAM_SETUP_TOOL.name&&value?.state==='session_authorized'
            &&value.sourceId===sourceArguments.sourceId)value={...value,
              ...assistantSourceSettings(client.identity,sourceArguments.companyId,value.sourceId,'telegram-mtproto')};
          result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
        }catch(error){const code=safeError(error);result={isError:true,content:[{type:'text',text:code}],structuredContent:{code}};}
      }else result=await(request.operation==='list'?proxy.listTools():proxy.callTool(request.name,request.arguments));
      if(request.operation==='call'&&request.name==='get_assistant_status'&&!result?.isError){
        // Reuse the SAME authenticated runtime inventory, not the human MCP or
        // an owner browser. Slugs/UUIDs are structural locators only; no company
        // names/content or execution policy is copied into the setup chat.
        if(!result?.structuredContent||typeof result.structuredContent!=='object')fail('ASSISTANT_MCP_INVALID_RESPONSE');
        const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
        const companies=projectAssistantSetupCompanies(await client.companies(runtimeHookSignal()));
        const status={...result.structuredContent,companies};
        result={...result,structuredContent:status,content:[{type:'text',text:JSON.stringify(status)}]};
      }
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
  },{interactiveSourceSetup:interactiveSourceSetup||request.operation==='call'&&request.name==='connect_remote_agent_skill'}).then(result=>result ?? (request.operation==='list'?[]:fail('ASSISTANT_HOST_NOT_CONFIGURED')));
};

/** Internal server plan, never an arbitrary command/directory selected by a
 * model. Parse it before private I/O; the child repeats live pass/Run admission
 * before accessing local files, including the nominally local status action. */
export const validateAssistantWorkspacePlan = async (raw,{expectedOrigin='https://trelio.ru'}={}) => {
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
      identity:{origin:expectedOrigin},pass:snapshot.scope});
  }
  if(Object.hasOwn(snapshot,'encryptedInspection')){
    if(action?.operation!=='inspect' || snapshot.encryptedInspection?.workspaceId!==action.parameters?.workspaceId)
      fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
    await validateAssistantEncryptedInspection({descriptor:snapshot.encryptedInspection,
      identity:{origin:expectedOrigin},pass:snapshot.scope});
  }
  if(!action || !['inspect','open','status','heartbeat','checkpoint','finish','pause','skill_run','secret_browser_fill','secret_generate','secret_company_create','secret_input','secret_skill_run'].includes(action.operation)
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
  if(action.operation==='secret_company_create'||action.operation==='secret_input'){
    const p=action.parameters;
    if(!p||Object.keys(p).sort().join(',')!=='clientRequestId,expectedTaskUpdatedAt,holder,ownerDecisionId,plan,runId'
      ||!(action.operation==='secret_input'?p.holder==='assistant'&&assistantNeutralPrivateInput(p.plan):p.holder==='company'&&assistantNeutralCompanySecret(p.plan))||p.plan.runId!==p.runId
      ||['clientRequestId','ownerDecisionId'].some(key=>!new RegExp(UUID,'u').test(p[key]??''))
      ||typeof p.expectedTaskUpdatedAt!=='string'||!Number.isFinite(Date.parse(p.expectedTaskUpdatedAt))
      ||!action.runIdentity||Object.keys(action.runIdentity).sort().join(',')!=='runId,workspaceId'
      ||action.runIdentity.runId!==p.runId||Object.values(action.runIdentity).some(value=>!new RegExp(UUID,'u').test(value??'')))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
    return {...snapshot,runIdentity:action.runIdentity,invocation:null};
  }
  if(action.operation==='secret_generate'){
    if(!action.parameters || Object.keys(action.parameters).filter(key=>key!=='neutralPlan').sort().join(',')!=='clientRequestId,expectedTaskUpdatedAt,ownerDecisionId,runId'
      || ['clientRequestId','ownerDecisionId','runId'].some(key=>!new RegExp(UUID,'u').test(action.parameters[key]??''))
      || !action.runIdentity || Object.keys(action.runIdentity).sort().join(',')!=='runId,workspaceId'
      || Object.values(action.runIdentity).some(value=>!new RegExp(UUID,'u').test(value??''))
      || action.parameters.runId!==action.runIdentity.runId || typeof action.parameters.expectedTaskUpdatedAt!=='string'
      || !Number.isFinite(Date.parse(action.parameters.expectedTaskUpdatedAt))
      ||action.parameters.neutralPlan!==undefined&&(!assistantNeutralPrivateMetadata({metadataMode:'neutral',runId:action.parameters.runId,...action.parameters.neutralPlan})
        ||Object.keys(action.parameters.neutralPlan).sort().join(',')!=='cardType,generatedFields'))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
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
    withManagedContent=withProductionAssistantManagedContent,companyContextRead=false}={})=>{
  if (['connect_remote_agent_skill','doctor_remote_agent_skill','call_remote_agent_skill_tool'].includes(name)) {
    // Live native schema was checked before this local composition. All three
    // operations reuse the SAME resolver/credential UI/vault/doctor/HTTP engine.
    // Only its last write boundary may spend the exact native owner decision.
    const selected=structuredClone(args);
    return withProfile(async({identity})=>{
      const common=await loadCommon(),profile=common.currentWorkspaceExecutionProfile();
      await profile.assertRemoteMcpCurrent(signal);
      const {executeRemoteMcpTool}=await import('./trelio-remote-mcp.mjs');
      const result=await executeRemoteMcpTool(identity.origin,name,selected,{signal});
      await profile.assertRemoteMcpCurrent(signal);
      return result;
    },{signal,remoteMcp:{input:selected,consumed:false,
      authorize:()=>withManagedContent({name:'call_remote_agent_skill_tool',args:selected,signal},send)}});
  }
  if(supportsAssistantManagedContent(name,args))return withManagedContent({name,args,signal},send);
  if(name==='complete_assistant_pass')return withAssistantEncryptedMaterial({args,signal},send,{withProfile,loadCommon});
  if(name!=='continue_assistant_workspace_action' || !['checkpoint','finish','pause'].includes(args.operation))
    return withAssistantCompanyContentArguments({name,args,signal},send,{withProfile,companyContextRead});
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
    // The native strict schema rebuilds its objects in schema order. The SAME
    // ciphertext/signature/AAD may therefore have a different property order
    // on echo. Compare exact JSON values with the existing crypto canonicalizer,
    // not insertion order. Arrays, extra fields, types and every ciphertext
    // byte remain significant; an invalid/absent echo still refuses closed.
    const {canonicalJson}=await import('./trelio-company-encryption.mjs');
    let exactEcho=false;
    try{exactEcho=canonicalJson(result?.structuredContent?.localAction?.parameters)===canonicalJson({encryptedArguments:sealed});}catch{}
    if(!result?.structuredContent?.encryptedLifecycle
      || !exactEcho
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
  {withProfile=withProductionAssistantWorkspace,companyContextRead=false}={})=>{
  if(!ASSISTANT_MCP_TOOLS.includes(name))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
  if(name==='get_assistant_status'||name==='get_trelio_tool_contract'){
    // These metadata reads use genuine device auth but no business proof.
    // An observed task hook may have added its managed fields; do not forward
    // ignored content/authority to a schema that deliberately accepts none.
    const {taskPass:_pass,intakePass:_intake,runtimeSessionProof:_proof,...metadata}=args;
    // Contract lookup is metadata only when its locator is one of the native
    // names in this presentation. Reject arbitrary prose BEFORE HTTP even
    // though the backend's exact contract registry would also refuse it.
    if(name==='get_trelio_tool_contract'&&(!companyContextRead&&!args.intakePass
      ||!ASSISTANT_COMPANY_CONTEXT_READ_TOOLS.includes(metadata.name)
      ||Object.keys(metadata).some(key=>key!=='name')))
      throw new AssistantTransportError('ASSISTANT_MCP_INPUT_INVALID');
    return send(metadata);
  }
  if(name==='download_knowledge_base_attachment'){
    if(!companyContextRead||Object.keys(args).some(key=>!['pageId','attachmentId','taskPass','runtimeSessionProof'].includes(key))
      ||!new RegExp(UUID,'u').test(args.pageId??'')||!new RegExp(UUID,'u').test(args.attachmentId??''))throw new AssistantTransportError('ASSISTANT_MCP_INPUT_INVALID');
    return send(args);
  }
  if(name==='download_registry_document'){
    if(!companyContextRead)throw new AssistantTransportError('ASSISTANT_CAPABILITY_UNAVAILABLE');
    const {taskPass:_pass,runtimeSessionProof:_proof,...selection}=args;
    try{assistantRegistryDocumentReadSelection(selection);}catch{throw new AssistantTransportError('ASSISTANT_MCP_INPUT_INVALID');}
    return send(args);
  }
  if(name==='download_attachment'){
    if(!new RegExp(UUID,'u').test(args.attachmentId??'')
      ||Object.keys(args).some(key=>!['attachmentId','taskPass','runtimeSessionProof'].includes(key)))
      throw new AssistantTransportError('ASSISTANT_MCP_INPUT_INVALID');
    return send(args);
  }
  if(companyContextRead&&ASSISTANT_COMPANY_CONTEXT_READ_TOOLS.includes(name)){
    if(Object.hasOwn(args,'localContextRead'))throw new AssistantTransportError('ASSISTANT_MCP_INPUT_INVALID');
    return withProfile(async({readCompanyContentMode})=>{
      if(typeof readCompanyContentMode!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      const mode=await readCompanyContentMode(signal);
      signal?.throwIfAborted();
      if(mode==='plain')return send(args);
      if(mode!=='encrypted')throw new AssistantTransportError('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      // The original full native input was checked against fresh discovery.
      // Search text, filters, paths and URLs remain in this invocation's RAM;
      // a closed structural request obtains native routing BEFORE source I/O.
      return send({localContextRead:true,...(args.intakePass?{intakePass:args.intakePass}:{taskPass:args.taskPass}),runtimeSessionProof:args.runtimeSessionProof});
    },{signal});
  }

  if(name==='continue_assistant_workspace_action'&&['inspect','open','status','heartbeat'].includes(args.operation)){
    // The native catalogue keeps generic parameters for returned plans. Reuse
    // its SAME local pure parser before structural forwarding, not only after
    // the server reply. Human-only open paths/session overrides are not part
    // of the dedicated native ABI and could otherwise carry arbitrary prose.
    if(Object.keys(args).some(key=>!['schemaVersion','operation','parameters','runIdentity','taskPass','runtimeSessionProof'].includes(key))
      ||args.operation==='open'&&args.parameters&&['directory','runtimeSessionId'].some(key=>Object.hasOwn(args.parameters,key)))
      throw new AssistantTransportError('ASSISTANT_WORKSPACE_PLAN_INVALID');
    const {buildTrelioWorkspaceActionInvocation}=await import('./trelio-local-context.mjs');
    const structural=Object.fromEntries(Object.entries(args).filter(([key])=>!['taskPass','runtimeSessionProof'].includes(key)));
    try{buildTrelioWorkspaceActionInvocation(structural);}catch{throw new AssistantTransportError('ASSISTANT_WORKSPACE_PLAN_INVALID');}
  }
  const privateEnvelope=()=>{
    const object=value=>value&&typeof value==='object'&&!Array.isArray(value),uuid=value=>new RegExp(UUID,'u').test(value??'');
    if(args.schemaVersion!==1||Object.keys(args).some(key=>!['schemaVersion','operation','parameters','runIdentity','taskPass','runtimeSessionProof'].includes(key)))
      throw new AssistantTransportError('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
    // These are host transport coordinates, not arbitrary textual containers.
    // Native proof verification is still the authority; this projection only
    // prevents ignored prose from crossing HTTP before that verification.
    if(args.taskPass!==undefined&&(!object(args.taskPass)||Object.keys(args.taskPass).sort().join(',')!=='companyId,passId,taskId'
      ||Object.values(args.taskPass).some(value=>!uuid(value))))throw new AssistantTransportError('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
    const p=args.runtimeSessionProof;
    if(p!==undefined&&(!object(p)||Object.keys(p).sort().join(',')!=='issuedAt,nonce,runtimeSessionId,schemaVersion,signature'
      ||p.schemaVersion!==1||!uuid(p.runtimeSessionId)||!uuid(p.nonce)||typeof p.issuedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(p.issuedAt)||!Number.isFinite(Date.parse(p.issuedAt))
      ||typeof p.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/u.test(p.signature)))throw new AssistantTransportError('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
  };
  if(name==='continue_assistant_workspace_action'&&args.operation==='secret_list'){
    privateEnvelope();const p=args.parameters;
    if(args.runIdentity!==undefined||!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(key=>!['holder','offset','limit'].includes(key))
      ||p.holder!==undefined&&p.holder!=='company'
      ||p.offset!==undefined&&(!Number.isSafeInteger(p.offset)||p.offset<0)
      ||p.limit!==undefined&&(!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>50))throw new AssistantTransportError('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
    return send(args);
  }
  if(name==='continue_assistant_workspace_action'&&args.operation==='skill_account_setup'){
    privateEnvelope();if(args.runIdentity!==undefined)throw new AssistantTransportError('ASSISTANT_SKILL_SETUP_REQUIRED');
    normalizeAssistantSkillAccountSetupParameters(args.parameters);
    return withProfile(async({readCompanyContentMode,prepareSkillAccountSetupArguments})=>{
      if(typeof readCompanyContentMode!=='function'||typeof prepareSkillAccountSetupArguments!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      const parameters=await prepareSkillAccountSetupArguments(args.parameters,signal);
      signal?.throwIfAborted();const result=await send({...args,parameters});
      if(result?.isError)return result;
      const admitted=result?.structuredContent;
      if(!admitted||admitted.state!=='admitted'||admitted.replayAllowed!==false||typeof admitted.reconcileOnly!=='boolean')throw new AssistantTransportError('ASSISTANT_MCP_INVALID_RESPONSE');
      if(admitted.reconcileOnly)return result;
      const plan=normalizeAssistantSkillAccountSetupPlan(admitted.accountSetup);
      if(plan.requestId!==args.parameters.clientRequestId||['skillId','projectId','releaseId','accountId','commandId'].some(key=>plan[key]!==args.parameters[key]))
        throw new AssistantTransportError('ASSISTANT_SKILL_SETUP_REQUIRED');
      const finished=await withProfile(async({identity})=>{
        const common=await import('./trelio-workspace.mjs');return common.runAssistantSkillAccountSetup({origin:identity.origin});
      },{signal,skillAccountSetup:plan});
      return {content:[{type:'text',text:'Protected existing-account handoff finished; a separate fresh provider probe is required.'}],
        structuredContent:{...admitted,accountSetup:undefined,...finished}};
    },{signal});
  }
  if(name==='continue_assistant_workspace_action'&&args.operation==='skill_consent'){
    privateEnvelope();
    if(args.runIdentity!==undefined)throw new AssistantTransportError('ASSISTANT_WORKSPACE_PLAN_INVALID');
    normalizeAssistantSkillConsentParameters(args.parameters);
    return withProfile(async({readCompanyContentMode,prepareSkillConsentArguments})=>{
      if(typeof readCompanyContentMode!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      const parameters=await readCompanyContentMode(signal)==='plain'?args.parameters
        :await prepareSkillConsentArguments(args.parameters,signal);
      signal?.throwIfAborted();return send({...args,parameters});
    },{signal});
  }
  if(name==='search_agent_guidance')return withProfile(async({readCompanyContentMode})=>{
    if(typeof readCompanyContentMode!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_PROFILE_DENIED');
    if(await readCompanyContentMode(signal)==='plain')return send(args);
    if(Object.keys(args).some(key=>!['companySlug','projectSlug','query','hints','limit','taskPass','runtimeSessionProof'].includes(key))
      ||typeof args.query!=='string')throw new AssistantTransportError('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
    // Only this platform literal crosses encrypted MCP. Original query/hints
    // stay in the current invocation and are restored AFTER the native scoped
    // read descriptor is verified, before shared local matching. No payload,
    // disk query cache, human mirror or plaintext HTTP fallback is created.
    const {hints:_hints,...wire}=args;
    signal?.throwIfAborted();return send({...wire,query:'[local guidance]'});
  },{signal});
  if(isAssistantStructuralResultRetraction(name,args)
    ||ASSISTANT_MCP_READ_TOOLS.includes(name) && name!=='search_agent_guidance'
    || name==='prepare_assistant_workspace_run'
    || name==='continue_assistant_workspace_action'
      && ['inspect','open','status','heartbeat'].includes(args.operation))return send(args);
  return withProfile(async({readCompanyContentMode,preparePrivateSkillArguments,preparePrivateBrowserArguments,preparePrivateCardArguments})=>{
    if(typeof readCompanyContentMode!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_PROFILE_DENIED');
    if(await readCompanyContentMode(signal)!=='plain'){
      if(name==='continue_assistant_workspace_action'&&['secret_skill_prepare','secret_browser_prepare','secret_browser_fill','secret_create','secret_generate','secret_company_create','secret_input'].includes(args.operation)
        && (args.schemaVersion!==1||Object.keys(args).some(key=>!['schemaVersion','operation','parameters','runIdentity','taskPass','runtimeSessionProof'].includes(key))
          ||!['secret_browser_fill','secret_generate','secret_company_create','secret_input'].includes(args.operation)&&args.runIdentity!==undefined))throw new AssistantTransportError('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      if(name==='continue_assistant_workspace_action'&&['secret_skill_prepare','secret_browser_prepare','secret_browser_fill','secret_create','secret_generate','secret_company_create','secret_input'].includes(args.operation))privateEnvelope();
      if(name==='continue_assistant_workspace_action'&&['secret_create','secret_generate','secret_company_create','secret_input'].includes(args.operation)){
        if(typeof preparePrivateCardArguments!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_PROFILE_DENIED');
        const parameters=await preparePrivateCardArguments(args,signal);signal?.throwIfAborted();
        return send({...args,parameters});
      }
      if(name==='continue_assistant_workspace_action'&&['secret_browser_prepare','secret_browser_fill'].includes(args.operation)){
        if(typeof preparePrivateBrowserArguments!=='function')throw new AssistantTransportError('ASSISTANT_WORKSPACE_PROFILE_DENIED');
        const local=await preparePrivateBrowserArguments(args,signal);
        signal?.throwIfAborted();const result=await send({...args,parameters:local.parameters});
        if(result?.isError)return result;
        const value=structuredClone(result.structuredContent),action=args.operation==='secret_browser_prepare'
          ?value?.bridge?.action?.arguments:value?.localAction;
        const target=action?.parameters;
        if(!action||action.schemaVersion!==1||action.operation!=='secret_browser_fill'||!target
          ||Object.keys(target).sort().join(',')!=='grantId,targetOrigin,targetUrlSha256'
          ||target.targetOrigin!==local.target.targetOrigin||target.targetUrlSha256!==local.target.targetUrlSha256
          ||args.operation==='secret_browser_prepare'&&(target.grantId!==value.grant?.id||value.grant.secretId!==args.parameters.secretId
            ||action.runIdentity?.runId!==args.parameters.runId||action.runIdentity?.workspaceId!==value.grant.workspaceId)
          ||args.operation==='secret_browser_fill'&&(target.grantId!==args.parameters.grantId
            ||JSON.stringify(action.runIdentity)!==JSON.stringify(args.runIdentity)))throw new AssistantTransportError('ASSISTANT_WORKSPACE_PLAN_INVALID');
        action.parameters={grantId:target.grantId,targetUrl:local.targetUrl};
        // Original full URL is restored ONLY in the private local result. The
        // native grant/browser will match its exact SHA again before filling.
        return {...result,content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
      }
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
  if(Object.hasOwn(args,'replyCommentId')) {
    // A discussion pass completes from its own exact published-comment receipt,
    // never from a fabricated Workspace/WORK.md. No company key/material read
    // is needed, including in encrypted firms. The ordinary observed proof and
    // native handler still reject task-mode passes, stale/foreign comments and
    // missing native mutation receipts. Mixed evidence fails before private I/O.
    if(!new RegExp(UUID,'u').test(args.replyCommentId??'') || args.goalState!=='completed' || args.noChange!==false
      || ['workspaceId','workspaceHead','acceptedRunId','encryptedMaterialWitness','sourceProcessingProof'].some(key=>Object.hasOwn(args,key))
      || args.processedSourceReferences!==undefined && (!Array.isArray(args.processedSourceReferences)||args.processedSourceReferences.length))
      fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
    return send(args);
  }
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
    const directory=path.join(host.configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','runtime-locks');
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
const assistantPlanTaskScope=(plan,expectedOrigin='https://trelio.ru')=>({origin:expectedOrigin,assistantId:plan.scope.assistantUserId,deviceId:plan.scope.deviceId,
  companyId:plan.scope.companyId,taskId:plan.scope.taskId});
const assistantWorkspaceRoot=(config,plan,expectedOrigin)=>path.join(assistantTaskStorageDirectory(config,assistantPlanTaskScope(plan,expectedOrigin)),
  'workspaces',plan.runIdentity.workspaceId.toLowerCase());
const isAssistantWorkspaceRoot=(candidate,base)=>{
  if(typeof candidate!=='string'||!path.isAbsolute(candidate)||candidate.includes('\0')
    ||!sameLocalPath(path.dirname(candidate),path.dirname(base)))return false;
  // Only registered siblings in this exact task namespace are considered.
  // The common private metadata reader still matches full Workspace/Run IDs;
  // a compact locator alone grants no identity or execution authority.
  if(/^r-[A-Za-z0-9_-]{43}$/u.test(path.basename(candidate)))return true;
  const suffix=path.basename(candidate).slice(path.basename(base).length);
  // Common recovery uses these bounded sibling names, not arbitrary custom
  // directories. The registry is discovery only; exact private metadata and
  // the child native pass/Run/recipient checks remain independent authority.
  return /^(?:-recovery-[0-9a-f]{8}){0,8}$/u.test(suffix)&&sameLocalPath(candidate,base+suffix);
};
export const resolveAssistantWorkspaceRoot=async(config,plan,expectedOrigin='https://trelio.ru')=>{
  const common=await import('./trelio-workspace.mjs'),context=await import('./trelio-local-context.mjs');
  const base=assistantWorkspaceRoot(config,plan,expectedOrigin);
  const root=await common.resolveRegisteredWorkspaceRootDirectory({workspaceId:plan.runIdentity.workspaceId,
    runId:plan.runIdentity.runId,origin:expectedOrigin,startDirectory:base},{readRegistry:async()=>
    (await common.readRunRegistry({configurationDirectory:config})).filter(candidate=>isAssistantWorkspaceRoot(candidate,base))});
  if(!root)return base;
  if(!isAssistantWorkspaceRoot(root,base))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  const identity=await context.readOpenedWorkspaceRunIdentity(path.join(root,'workspace'),expectedOrigin);
  return identity.workspaceId===plan.runIdentity.workspaceId&&identity.runId===plan.runIdentity.runId?root:base;
};
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
// Both parent handoffs use ONE closed projection of an already validated
// native plan. Derived invocation fields stay local; encrypted routing must
// survive facade -> coordinator -> process -> child, not only the last pipe.
const assistantWorkspaceExecutionPlan = plan => ({prepared:true,scope:plan.scope,localAction:plan.localAction,
  ...(plan.encryptedInspection?{encryptedInspection:plan.encryptedInspection}:{}),
  ...(plan.encryptedLifecycle?{encryptedLifecycle:plan.encryptedLifecycle}:{})});

export const createAssistantWorkspaceExecutor = async ({runPlan=runAssistantWorkspaceProcess,configDirectory,
  finishOptions={},heartbeatOptions={},companyPreparationOptions={},expectedOrigin='https://trelio.ru'}={}) => {
  const common=await import('./trelio-workspace.mjs');
  const {createWorkspaceFinishOperations}=await import('./trelio-workspace-finish-progress.mjs');
  const {createWorkspaceRunHeartbeatManager}=await import('./trelio-local-context.mjs');
  const config=configDirectory??common.resolveWorkspaceBridgeConfigDirectory();
  if(!path.isAbsolute(config))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  const plans=new Map();
  const finishes=createWorkspaceFinishOperations({...finishOptions,toolName:'continue_assistant_workspace_action'});
  // Reuse the SAME bounded operation registry/short-wait algorithm as finish,
  // but retain only preparation readiness, never a cached company answer. Each
  // query first obtains a fresh native search admission; after preparation its
  // real local read rechecks pass, recipient, ACL and current mirror generation.
  // No Run, writable directory, new journal, provider or background model exists.
  const preparations=createWorkspaceFinishOperations({...companyPreparationOptions,toolName:'search'});
  const preparationControllers=new Set(),preparationRequests=new Set();
  const heartbeat=createWorkspaceRunHeartbeatManager({...heartbeatOptions,resolveOpenedDirectory:async()=>fail('ASSISTANT_WORKSPACE_REVIEW_REQUIRED'),
    runBridge:async (_origin,args,options)=>{
      const plan=plans.get(path.resolve(options.cwd??''));
      if(!plan || args.length!==1 || args[0]!=='heartbeat')fail('ASSISTANT_WORKSPACE_REVIEW_REQUIRED');
      const value=await runPlan(assistantWorkspaceExecutionPlan({...plan,localAction:{schemaVersion:1,operation:'heartbeat',
        parameters:{},runIdentity:plan.runIdentity}}),options);
      return {stdout:value.stdout??'',stderr:value.stderr??''};
    }});
  return {async prepareCompanySearch(raw,{signal,request=requestCurrentAssistantRuntime}={}){
    if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||raw.schemaVersion!==1
      ||Object.keys(raw).sort().join(',')!=='binding,descriptor,schemaVersion'||raw.descriptor?.nativeTool!=='search'
      ||Buffer.byteLength(JSON.stringify(raw))>8192)fail('ASSISTANT_MCP_INVALID_RESPONSE');
    validateAssistantCompanyPreparationBinding(raw.binding);
    const {descriptor,binding}=structuredClone(raw);
    const {canonicalJson}=await import('./trelio-company-encryption.mjs');
    const fingerprint=canonicalJson({descriptor,binding}),key=createHash('sha256').update(fingerprint).digest('hex');
    const result=await preparations.start({key,scope:key,fingerprint,pollAction:{},signal,
      execute:async()=>{
        const controller=new AbortController();preparationControllers.add(controller);
        // Normalize a synchronous launcher refusal too: the owned controller
        // must always reach the same cleanup path, even before child spawn.
        const pending=Promise.resolve().then(()=>request({operation:'company_context_prepare',descriptor,binding},{signal:controller.signal}));
        preparationRequests.add(pending);
        try{
          const value=await pending;
          if(value?.schemaVersion!==1||value.prepared!==true||Object.keys(value).sort().join(',')!=='prepared,schemaVersion')
            fail('ASSISTANT_MCP_INVALID_RESPONSE');
          return {prepared:true};
        }finally{preparationRequests.delete(pending);preparationControllers.delete(controller);}
      }});
    if(result.state==='completed'&&result.prepared===true)return true;
    if(result.state!=='running')fail('ASSISTANT_MCP_INVALID_RESPONSE');
    return false;
  },async execute(raw,{signal}={}) {
    const plan=await validateAssistantWorkspacePlan(raw,{expectedOrigin});
    // Accepted inspection has no Run, renewal, progress registry or writable
    // task directory. The common reader selects its isolated cache in the child.
    if(['inspect','skill_run'].includes(plan.localAction.operation))return runPlan(assistantWorkspaceExecutionPlan(plan),{signal});
    const root=await resolveAssistantWorkspaceRoot(config,plan,expectedOrigin),directory=path.join(root,'workspace');
    const key=`${plan.scope.assistantUserId}:${plan.scope.deviceId}:${plan.scope.companyId}:${plan.scope.taskId}:${plan.runIdentity.workspaceId}`;
    const scope=`${plan.scope.passId}:${plan.runIdentity.runId}`;
    for(const [oldDirectory,previous] of plans){
      if(previous.key===key&&(previous.scope.passId!==plan.scope.passId||previous.runIdentity.runId!==plan.runIdentity.runId)){
        if(finishes.active(key))fail('ASSISTANT_WORKSPACE_FINISH_IN_PROGRESS');
        heartbeat.stop(oldDirectory);plans.delete(oldDirectory);
      }
    }
    if(!plans.has(directory) && plans.size>=64) {
      for(const [oldDirectory,oldPlan] of plans) {
        if(!heartbeat.inspect(oldDirectory) && !finishes.active(oldPlan.key))plans.delete(oldDirectory);
      }
      if(plans.size>=64)fail('ASSISTANT_WORKSPACE_CAPACITY');
    }
    // Keep only structural renewal locators. Handoff text stays in the common
    // bounded finish registry for its ordinary retention, not a second cache.
    plans.set(directory,{scope:plan.scope,runIdentity:plan.runIdentity,key,
      ...(plan.encryptedLifecycle?{encryptedLifecycle:plan.encryptedLifecycle}:{})});
    const execute=async(onProgress,actionSignal)=>{
      const entry=await heartbeat.beginAction(directory,plan.localAction.operation);
      try {
        const result=await runPlan(assistantWorkspaceExecutionPlan(plan),{signal:actionSignal,onProgress});
        if(plan.localAction.operation==='open'){
          const opened=path.join(await resolveAssistantWorkspaceRoot(config,plan,expectedOrigin),'workspace');
          if(!sameLocalPath(opened,directory)){
            heartbeat.stop(directory);plans.set(opened,plans.get(directory));plans.delete(directory);
          }
          heartbeat.start({origin:expectedOrigin,...plan.runIdentity,workspaceDirectory:opened});
        }
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
  },async stop(){
    for(const directory of plans.keys())heartbeat.stop(directory);
    for(const controller of preparationControllers)controller.abort();
    await Promise.allSettled([...preparationRequests]);
  }};
};

const validateAssistantCompanyPreparationBinding = binding => {
  if(!binding||Object.getPrototypeOf(binding)!==Object.prototype
    ||Object.keys(binding).sort().join(',')!=='deviceId,envelopeId,scopeEpoch,scopeId'
    ||['deviceId','envelopeId','scopeId'].some(key=>!new RegExp(UUID,'u').test(binding[key]??''))
    ||!Number.isSafeInteger(binding.scopeEpoch)||binding.scopeEpoch<1)fail('ASSISTANT_MCP_INVALID_RESPONSE');
  return binding;
};
const assistantCompanyPreparationBinding = opened => validateAssistantCompanyPreparationBinding({
  scopeId:opened?.runtime?.scope?.id,scopeEpoch:opened?.runtime?.scope?.epoch,
  deviceId:opened?.runtime?.device?.id,envelopeId:opened?.runtime?.envelope?.id,
});

/** The ordinary signed request worker owns ONE managed readonly operation.
 * Preparation may outlive a short MCP poll, just like the common finish child;
 * it receives the existing ten-minute first-sync budget, not a longer native
 * lease/proof. Every HTTP/stream retains the existing native late fences. Read
 * execution is a separate fresh invocation and returns no stale cached answer.
 * Both variants reuse the common mirror/crypto/exact engines without a task Run.
 */
export const executeAssistantCompanyContextRequest = async(raw,{withProfile=withProductionAssistantWorkspace,
  loadContext=()=>import('./trelio-local-context.mjs'),loadTransport=()=>import('./trelio-assistant-transport.mjs'),signal}={})=>{
  const request=validateAssistantRuntimeRequest(raw);
  if(!['company_context_prepare','company_context_read'].includes(request.operation))fail('ASSISTANT_REQUEST_INVALID');
  return withProfile(async current=>{
    // Propagate the profile's ORIGINAL bounded private-session deadline, not
    // merely an optional outer poll signal, through mirror lock/network work.
    const {runtimeHookSignal}=await import('./trelio-hook-private-session.mjs');
    signal=runtimeHookSignal()??signal;
    if(typeof current.prepareCompanyContextRead!=='function')fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
    const assertCurrent=async readSignal=>{
      const opened=await current.prepareCompanyContextRead(readSignal);
      const actual=assistantCompanyPreparationBinding(opened);
      if(Object.keys(actual).some(key=>actual[key]!==request.binding[key]))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      return opened;
    };
    await assertCurrent(signal);
    if(request.operation==='company_context_prepare'){
      const context=await loadContext();
      const result=await context.prepareTrelioLocalCompanyContext(current.identity.origin,request.descriptor.companySlug,{signal});
      await assertCurrent(signal);
      return result;
    }
    const transport=await loadTransport();
    return transport.materializeAssistantEncryptedCompanyContext({origin:current.identity.origin,descriptor:request.descriptor,
      name:'search',arguments:request.arguments,signal,assertCurrent});
  },{signal,encryptedCompanyContext:request.descriptor,
    ...(request.operation==='company_context_prepare'?{companyReadPreparation:true}:{})});
};

/** This runner selects the installed verifier, not an arbitrary source path or
 * executable. Payload is bounded stdin; stdout is the common action result,
 * and only ordinary fixed progress frames are observed before completion. */
export const runAssistantWorkspaceProcess = async (raw,{signal,onProgress,resolveLoader=resolveHostRuntimeLoader,
  runProcess,environment=process.env,expectedOrigin='https://trelio.ru'}={}) => {
  const plan=await validateAssistantWorkspacePlan(raw,{expectedOrigin});
  // The native encryption descriptors are part of the validated plan, not
  // optional presentation metadata. Dropping them here made the isolated
  // inspector attempt the canonical/plain snapshot route, despite the parent
  // having admitted an encrypted inspection. Forward only these two validated
  // fields; the child repeats their scope/origin checks before any private I/O.
  const input=JSON.stringify(assistantWorkspaceExecutionPlan(plan));
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
  loadCommon=()=>import('./trelio-workspace.mjs'),loadContext=()=>import('./trelio-local-context.mjs'),expectedOrigin='https://trelio.ru'}={}) => {
  const plan=await validateAssistantWorkspacePlan(raw,{expectedOrigin});
  return withProfile(async({identity,client,store,host,withSecretGenerationKey,selectCompanySecretContext,prepareWorkspaceRun})=>{
    const common=await loadCommon(),context=await loadContext();
    const {validateAssistantActivePass}=await import('./trelio-assistant-hook.mjs');
    const active=validateAssistantActivePass(await host.readActivePass(),identity);
    if(identity.origin!==expectedOrigin || identity.assistantId!==plan.scope.assistantUserId || identity.deviceId!==plan.scope.deviceId
      || ['companyId','taskId','passId'].some(key=>active[key]!==plan.scope[key]))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    // A profile HTTP read consumes its own observed one-use proof and native
    // canonical target/own-Run checks, even for local status or heartbeat.
    const token=await common.requireToken(identity.origin);
    const inspecting=plan.localAction.operation==='inspect';
    const skill=plan.localAction.operation==='skill_run';
    const runLifecycle=['open','status','heartbeat','checkpoint','finish','pause'].includes(plan.localAction.operation);
    const encryption=runLifecycle||['secret_skill_run','secret_browser_fill','secret_generate','secret_company_create','secret_input'].includes(plan.localAction.operation)?await prepareWorkspaceRun():null;
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
    const config=host.configurationDirectory??common.resolveWorkspaceBridgeConfigDirectory();
    if(!inspecting)await rejectLegacyAssistantTaskStorage(config,assistantPlanTaskScope(plan,expectedOrigin));
    // Signed skill commands use the same task-local cwd, but need no invented
    // Workspace/Run. Their native resolver repeats task admission before launch.
    let root=skill?assistantTaskStorageDirectory(config,assistantPlanTaskScope(plan,expectedOrigin))
      :inspecting?assistantWorkspaceRoot(config,plan,expectedOrigin):await resolveAssistantWorkspaceRoot(config,plan,expectedOrigin);
    let directory=path.join(root,'workspace');
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
    if(plan.localAction.operation==='secret_company_create'||plan.localAction.operation==='secret_input'){
      const {handleAssistantCompanySecretCreation}=await import('./trelio-secret-generate.mjs');
      const result=await handleAssistantCompanySecretCreation({origin:encryption?.requestOrigin??identity.origin,token,input:plan.localAction.parameters,
        scope:{assistantUserId:identity.assistantId,deviceId:identity.deviceId,companyId:active.companyId,taskId:active.taskId},
        withGenerationKey:withSecretGenerationKey,companyEncryption:encryption,onContext:selectCompanySecretContext});
      return {schemaVersion:1,operation:plan.localAction.operation,stdout:JSON.stringify(result),stderr:''};
    }
    if(plan.localAction.operation==='secret_generate'){
      const {handleAssistantGeneratedPrivateSecret}=await import('./trelio-secret-generate.mjs');
      const result=await handleAssistantGeneratedPrivateSecret({origin:encryption?.requestOrigin??identity.origin,token,input:plan.localAction.parameters,
        scope:{assistantUserId:identity.assistantId,deviceId:identity.deviceId,companyId:active.companyId,taskId:active.taskId},
        withGenerationKey:withSecretGenerationKey});
      return {schemaVersion:1,operation:'secret_generate',stdout:JSON.stringify(result),stderr:''};
    }
    let recovery=null;
    const action=await(async()=>{
      const parameters={...plan.localAction.parameters,...(plan.localAction.operation==='open'?{directory:root}:{})};
      const handoff=plan.localAction.operation==='finish' || plan.localAction.operation==='checkpoint'
        && plan.localAction.parameters.type==='handoff';
      if(handoff){
        // A task pass can legitimately write an independently selected named
        // Workspace. Its target scope, not the enclosing pass, determines the
        // common handoff ABI: task Runs require no_status_change; named Runs
        // must omit taskOutcome. Read the exact native target under the SAME
        // own-Run/recipient profile rather than trusting a model/local hint.
        const response=await common.request(encryption?.requestOrigin??identity.origin,token,
          `/api/agent-workspaces/workspaces/${plan.runIdentity.workspaceId}`);
        const overview=encryption?await common.currentWorkspaceExecutionProfile().readWorkspaceJsonResponse(response)
          :JSON.parse((await common.readBoundedResponseBuffer(response,512*1024,'Assistant handoff Workspace')).toString('utf8'));
        const target=overview.workspace;
        if(target?.id!==plan.runIdentity.workspaceId || !(target.scopeType==='task'
          ?target.scopeKey===`task:${plan.scope.taskId}`
          :['project','company'].includes(target.scopeType)&&target.scopeKey===`workspace:${plan.runIdentity.workspaceId}`)
          || overview.company?.id!==plan.scope.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
        delete parameters.taskOutcome;
        if(target.scopeType==='task')parameters.taskOutcome='no_status_change';
      }
      // Ordinary draft/blocker continuity still carries no injected outcome.
      // Native ACL, own-Run lease, handoff validation and acceptance CAS remain
      // authoritative; this translation grants no task/status permission.
      return {...plan.localAction,parameters};
    })();
    let nativeReason,nativeHealthCause,nativeCommandPolicyCause;
    try {
      const result=await context.handleTrelioWorkspaceActionOperation(identity.origin,action,{
      resolveRunRootDirectory:async()=>root,
      selectOpenRecovery:opening?async error=>{
        const d=error.details,base=assistantWorkspaceRoot(config,plan,expectedOrigin);
        if(!['TRELIO_WORKSPACE_LOCAL_RECOVERY_REQUIRED','TRELIO_WORKSPACE_DRAFT_RECOVERY_REQUIRED'].includes(error.code))return false;
        // Only a positive common LOCAL/DRAFT preflight can choose a new sibling.
        // No model path, foreign registry root, lease failure or missing source
        // metadata can enter this branch. Opening never copies/clears old work.
        if(d?.workspaceId!==plan.runIdentity.workspaceId
          ||(error.code==='TRELIO_WORKSPACE_LOCAL_RECOVERY_REQUIRED'?d.targetRunId:d.runId)!==plan.runIdentity.runId
          ||d.sourceFilesMustRemainUntouched!==true||!sameLocalPath(d.sourceDirectory,root)
          ||!sameLocalPath(d.sourceWorkspaceDirectory,directory)
          ||!sameLocalPath(d.suggestedDirectory,workspaceRecoveryDirectory(root,plan.runIdentity.workspaceId,plan.runIdentity.runId))
          ||!isAssistantWorkspaceRoot(d.suggestedDirectory,base))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
        recovery={code:error.code,...d};root=d.suggestedDirectory;directory=path.join(root,'workspace');
        return true;
      }:undefined,
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
    });
      // Preserve the common bounded evidence for semantic reconciliation in
      // this SAME chat. It stays local, not in HTTP/SQLite or a second journal.
      // A fresh open is not saved material and never completes the task.
      return recovery?{...result,stdout:result.stdout+'\n'+JSON.stringify({assistantLocalRecovery:recovery})+'\n'}:result;
    } catch(error) {
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
    secretGeneration:['secret_generate','secret_company_create','secret_input'].includes(plan.localAction.operation)?{...plan.localAction.parameters,workspaceId:plan.runIdentity.workspaceId}:null});
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
