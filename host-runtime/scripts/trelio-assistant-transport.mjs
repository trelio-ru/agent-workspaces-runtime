/** Fixed assistant-device transport. No human OAuth/cookie or arbitrary HTTP. */
import path from 'node:path';
import { validateAssistantActivePass } from './trelio-assistant-hook.mjs';
import { buildRuntimeSessionProof, withRuntimeStateLock } from './trelio-runtime-session.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { ASSISTANT_CADENCES, assistantPassContinuation } from './trelio-assistant-scheduler.mjs';
import { assistantExecutionConfiguration } from './trelio-assistant-codex.mjs';
import { PROCESS_DIAGNOSTIC_CODES } from './trelio-process-diagnostics.mjs';
import { assistantSourceProcessingReferences, assistantConversationKeyMatches } from './trelio-assistant-inbox.mjs';
import { splitAccountArguments } from './trelio-skill-accounts.mjs';
import { canonicalJson } from './trelio-company-encryption.mjs';

export class AssistantTransportError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new AssistantTransportError(code, status); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEAD = /^[0-9a-f]{40,64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
/** Structural coordinates of an existing native consent, never the package,
 * preview prose, a caller-selected device or a human bridge token. The native
 * common builder independently selects every coordinate before its write. */
export const normalizeAssistantSkillConsentFields=value=>{
  const keys=['skillId','projectId','releaseId','publicationId','runtimeArtifactId','packageSha256','instructionsSha256'];
  if(!object(value)||Object.keys(value).sort().join(',')!==keys.sort().join(',')
    ||typeof value.skillId!=='string'||!value.skillId.trim()||value.skillId.length>120||value.skillId!==value.skillId.trim()
    ||value.projectId!==null&&!UUID.test(value.projectId??'')
    ||['releaseId','publicationId','runtimeArtifactId'].some(key=>!UUID.test(value[key]??''))
    ||['packageSha256','instructionsSha256'].some(key=>!SHA256.test(value[key]??'')))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  return structuredClone(value);
};
export const normalizeAssistantSkillConsentParameters=value=>{
  if(!object(value))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  const {clientRequestId,ownerDecisionId,expectedTaskUpdatedAt,...fields}=value;
  normalizeAssistantSkillConsentFields(fields);
  if(!UUID.test(clientRequestId??'')||!UUID.test(ownerDecisionId??'')
    ||typeof expectedTaskUpdatedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(expectedTaskUpdatedAt)
    ||!Number.isFinite(Date.parse(expectedTaskUpdatedAt)))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  return structuredClone(value);
};
/** Native-only setup admission, never model argv or catalogue metadata.
 * Encrypted private declarations remain opaque markers in the native receipt;
 * the host reselects their commandId from that exact signed package locally. */
const assistantSkillSetupMarker=value=>object(value)&&Object.keys(value).join(',')==='$trelioE2ee'
  &&object(value.$trelioE2ee)&&Object.keys(value.$trelioE2ee).sort().join(',')==='field,id,v'
  &&value.$trelioE2ee.v===1&&UUID.test(value.$trelioE2ee.id??'')&&value.$trelioE2ee.field==='skill_setup_command_json';
export const normalizeAssistantSkillAccountSetupPlan=value=>{
  const keys=['schemaVersion','requestId','accountId','companyId','projectId','memberId','connectionId','connectionConfigSha256','skillId','releaseId','artifactId','packageSha256','commandId','purpose','maximumDurationMs'];
  if(!object(value)||Object.keys(value).sort().join(',')!==[...keys,...(Object.hasOwn(value,'arguments')?['arguments']:['inspectedCommand'])].sort().join(',')
    ||value.schemaVersion!==1||value.purpose!=='authenticate_existing'
    ||['requestId','accountId','companyId','memberId','releaseId','artifactId'].some(key=>!UUID.test(value[key]??''))
    ||value.projectId!==null&&!UUID.test(value.projectId??'')||value.connectionId!==null&&!UUID.test(value.connectionId??'')
    ||value.connectionConfigSha256!==null&&!SHA256.test(value.connectionConfigSha256??'')
    ||(value.connectionId===null)!==(value.connectionConfigSha256===null)
    ||typeof value.skillId!=='string'||!value.skillId.trim()||value.skillId!==value.skillId.trim()||value.skillId.length>120
    ||!SHA256.test(value.packageSha256??'')||!/^[a-z][a-z0-9-]{0,47}$/u.test(value.commandId??'')
    ||!Number.isSafeInteger(value.maximumDurationMs)||value.maximumDurationMs<60000||value.maximumDurationMs>600000
    ||Object.hasOwn(value,'arguments')&&(!Array.isArray(value.arguments)||!value.arguments.length||value.arguments.length>8
      ||value.arguments.some(argument=>typeof argument!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/u.test(argument)))
    ||!Object.hasOwn(value,'arguments')&&!assistantSkillSetupMarker(value.inspectedCommand))
    fail('ASSISTANT_SKILL_SETUP_REQUIRED');
  return structuredClone(value);
};
export const normalizeAssistantSkillAccountSetupFields=value=>{
  if(!object(value)||Object.keys(value).sort().join(',')!=='accountId,commandId,projectId,releaseId,skillId'
    ||typeof value.skillId!=='string'||!value.skillId.trim()||value.skillId!==value.skillId.trim()||value.skillId.length>120
    ||!UUID.test(value.accountId??'')||!UUID.test(value.releaseId??'')||value.projectId!==null&&!UUID.test(value.projectId??'')
    ||!/^[a-z][a-z0-9-]{0,47}$/u.test(value.commandId??''))fail('ASSISTANT_SKILL_SETUP_REQUIRED');
  return structuredClone(value);
};
export const normalizeAssistantSkillAccountSetupParameters=value=>{
  if(!object(value))fail('ASSISTANT_SKILL_SETUP_REQUIRED');
  const {clientRequestId,ownerDecisionId,expectedTaskUpdatedAt,inspectedCommand,...fields}=value;
  normalizeAssistantSkillAccountSetupFields(fields);
  if(inspectedCommand!==undefined&&!assistantSkillSetupMarker(inspectedCommand))fail('ASSISTANT_SKILL_SETUP_REQUIRED');
  if(!UUID.test(clientRequestId??'')||!UUID.test(ownerDecisionId??'')||typeof expectedTaskUpdatedAt!=='string'
    ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(expectedTaskUpdatedAt)
    ||!Number.isFinite(Date.parse(expectedTaskUpdatedAt)))fail('ASSISTANT_SKILL_SETUP_REQUIRED');
  return structuredClone(value);
};
/** A closed structural exception, never a generic encrypted mutation bypass.
 * The live native schema/proof still owns the operation. This small presend
 * predicate merely proves there is no company prose to protect or leak: a
 * restore reason or an unknown root field cannot ride along with retraction. */
export const isAssistantStructuralResultRetraction = (name,args) => name === 'repair_assistant_workspace_result'
  &&object(args)&&args.operation==='retract'&&args.agentRecognizedOwnError===true
  &&['workspaceId','runId'].every(key=>typeof args[key]==='string'&&UUID.test(args[key]))
  &&typeof args.expectedHead==='string'&&HEAD.test(args.expectedHead)
  &&['wrong_scope','unauthorized_write','incorrect_result'].includes(args.errorKind)
  &&(args.correctionRunId===undefined||typeof args.correctionRunId==='string'&&UUID.test(args.correctionRunId))
  &&Object.keys(args).every(key=>['operation','workspaceId','runId','expectedHead','errorKind','agentRecognizedOwnError',
    'correctionRunId','taskPass','runtimeSessionProof'].includes(key));
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('ASSISTANT_TRANSPORT_INVALID_INPUT'); return value.toLowerCase(); };
/** One catalogue for source polling and task execution on this managed device.
 * Company/member bindings remain inside the common catalogue. Neither profile
 * may read/import the interactive human's catalogue merely because both run as
 * the same OS user. The caller rechecks its live identity before resolving it. */
const assistantSkillCatalogueDirectory = (configDirectory, identity) => {
  if (!path.isAbsolute(configDirectory ?? '')) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  return path.join(configDirectory,'digital-assistants','runtime',id(identity.assistantId),id(identity.deviceId),'accounts');
};
/** Compact identity-bound task roots avoid concatenating five UUIDs into a
 * Windows cwd. The same digest isolates origin/assistant/device/company/task;
 * it is a locator only, never permission or a substitute for private ACLs. */
export const assistantTaskStorageDirectory = (configDirectory, scope) => {
  if (!path.isAbsolute(configDirectory ?? '')) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  const origin = originOf(scope.origin);
  const identity = ['trelio-assistant-task-v1', origin, ...['assistantId','deviceId','companyId','taskId'].map(key=>id(scope[key]))];
  return path.join(configDirectory,'digital-assistants','tasks',createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
};
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const revision = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE'); return value;
};
const text = (value, limit = 2048) => {
  if (typeof value !== 'string' || !value.length || value.length > limit || /[\x00-\x20\x7f]/u.test(value)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE'); return value;
};
const isoTimestamp = value => {
  text(value,64);
  if(!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  return value;
};
const state = value => {
  if (!['accepted','waiting_owner','paused','done','revoked'].includes(value)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE'); return value;
};
const binding = value => {
  if (!object(value)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  return { id: id(value.id), taskId: id(value.taskId), state: state(value.state), revision: revision(value.revision) };
};
const executionConfiguration = value => {
  if (!object(value)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  if (value.id !== undefined) id(value.id);
  try { return assistantExecutionConfiguration({ modelId:value.modelId,effortLevel:value.effortLevel,revision:value.revision }); }
  catch { fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE'); }
};
const executionState = value => {
  // An older backend never authorizes fallback to local Codex defaults.
  if (value === undefined) return {state:'unconfigured',configuration:null,policyRevisionId:null};
  if (!object(value) || !['ready','unconfigured','policy_blocked'].includes(value.state)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  if (value.state==='unconfigured' && value.configuration!==null) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  return {state:value.state,configuration:value.state==='unconfigured'?null:executionConfiguration(value.configuration),
    policyRevisionId:value.policyRevisionId===null?null:id(value.policyRevisionId)};
};
const passExecution = value => value.state==='leased' ? executionConfiguration(value.execution)
  : value.execution == null ? null : executionConfiguration(value.execution);

/** Native auth bindings are routing metadata, not a grant to accept an owner
 * command. A signed provider must still prove the real sender/namespace, and a
 * later task intake must recheck live ownership and normal company/task ACL.
 * Never derive a binding from a username, display name or a forwarded author.
 * Keep this projection outside SQLite and the model-facing MCP catalogue. */
export const projectAssistantOwnerIdentities = (value, assistantId) => {
  assistantId = id(assistantId);
  const invalid = () => fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  if (!object(value) || value.schemaVersion !== 1 || value.assistantUserId !== assistantId
    || typeof value.bindingRevision !== 'string' || !/^[0-9a-f]{64}$/u.test(value.bindingRevision)
    || !Array.isArray(value.identities) || value.identities.length > 2) invalid();
  // Report malformed response identifiers as response failures, never as an
  // input mistake that could invite another enrollment or credential reset.
  const responseId = candidate => {
    if (typeof candidate !== 'string' || !UUID.test(candidate)) invalid();
    return candidate.toLowerCase();
  };
  const ownerUserId = responseId(value.ownerUserId);
  if (ownerUserId === assistantId) invalid();
  const providers = new Set(), bindings = new Set();
  const identities = value.identities.map(row => {
    if (!object(row) || !['telegram','max'].includes(row.provider) || providers.has(row.provider)
      || typeof row.externalUserId !== 'string' || row.externalUserId.length < 1
      || row.externalUserId.length > 256 || /[\x00-\x20\x7f]/u.test(row.externalUserId)) invalid();
    const bindingId = responseId(row.bindingId);
    if (bindings.has(bindingId)) invalid();
    providers.add(row.provider); bindings.add(bindingId);
    // Preserve the provider's exact opaque id. Numeric coercion/trim/case
    // normalization could merge distinct accounts or lose large integer bits.
    return Object.freeze({ bindingId, provider:row.provider, externalUserId:row.externalUserId });
  });
  // Do not retain the wire object, provider payloads or notification settings.
  // A confirmed empty list remains distinct from transport/ACL/unlink failures.
  return Object.freeze({ schemaVersion:1, assistantUserId:assistantId, ownerUserId,
    bindingRevision:value.bindingRevision, identities:Object.freeze(identities) });
};

/** Desired source configuration is not a provider grant or evidence of login.
 * Bind even an empty response to the exact device/company before it could be
 * used as an inventory. Never retain private labels, selectors or credentials
 * from an extended server response, and never interpret an error as absence. */
const projectAssistantSourceAccounts = (value, { assistantId, deviceId, companyId }) => {
  const invalid = () => fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  const responseId = candidate => {
    if (typeof candidate !== 'string' || !UUID.test(candidate)) invalid();
    return candidate.toLowerCase();
  };
  if (!object(value) || value.schemaVersion !== 1
    || responseId(value.assistantUserId) !== assistantId || responseId(value.deviceId) !== deviceId
    || responseId(value.companyId) !== companyId || !Array.isArray(value.sources) || value.sources.length > 128) invalid();
  const seen = new Set();
  return Object.freeze(value.sources.map(row => {
    if (!object(row) || responseId(row.companyId) !== companyId || responseId(row.deviceId) !== deviceId
      || !['telegram-mtproto','email-imap-smtp','max-web'].includes(row.skillId)
      || !['active','paused','revoked'].includes(row.state) || row.executionVerified !== false
      || row.bindFromSourceId!=null&&!UUID.test(row.bindFromSourceId)
      || row.provisionLocalAccount !== undefined && typeof row.provisionLocalAccount !== 'boolean'
      || row.ownerTaskIntakeAllowed !== undefined && typeof row.ownerTaskIntakeAllowed !== 'boolean'
      || row.ownerTaskIntakeAllowed === true && !(row.skillId==='telegram-mtproto'||row.skillId==='max-web'&&assistantMaxChatUrl(row.maxChatUrl)&&row.maxChatUrl!=='https://web.max.ru/0')
      || row.interactiveSetupAllowed !== undefined && typeof row.interactiveSetupAllowed !== 'boolean'
      || row.maxChatUrl != null && (row.skillId!=='max-web'||!assistantMaxChatUrl(row.maxChatUrl))
      || row.interactiveSetupAllowed === true && (row.provisionLocalAccount !== true || !['email-imap-smtp','telegram-mtproto','max-web'].includes(row.skillId))
      || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision > 2_147_483_647) invalid();
    const sourceId = responseId(row.id);
    if (seen.has(sourceId)) invalid();
    seen.add(sourceId);
    return Object.freeze({ id:sourceId, companyId, deviceId, localAccountId:responseId(row.localAccountId),
      projectId:row.projectId === null ? null : responseId(row.projectId), skillId:row.skillId,
      state:row.state, revision:row.revision, provisionLocalAccount:row.provisionLocalAccount === true,
      ...(row.interactiveSetupAllowed===true?{interactiveSetupAllowed:true}:{}),
      ...(row.ownerTaskIntakeAllowed===true?{ownerTaskIntakeAllowed:true}:{}),
      ...(row.maxChatUrl!=null?{maxChatUrl:row.maxChatUrl}:{}),...(row.bindFromSourceId!=null?{bindFromSourceId:row.bindFromSourceId}:{}),executionVerified:false });
  }));
};
export const validateAssistantPassOutcome = (value, expected) => {
  if(!object(value)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  if(value.state==='pending') {
    if(value.schemaVersion!==1 || Object.keys(value).sort().join(',')!=='schemaVersion,state') fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
    return {schemaVersion:1,state:'pending'};
  }
  const hasProcessing=Object.hasOwn(value,'processedSourceReferences');
  let processed;try{processed=assistantSourceProcessingReferences(hasProcessing?value.processedSourceReferences:[]);}
  catch{fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');}
  if(hasProcessing&&!processed.length)fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  const keys=['schemaVersion','state','receiptId','continuation',...Object.keys(expected),...(hasProcessing?['processedSourceReferences']:[])].sort();
  if(value.schemaVersion!==1 || value.state!=='confirmed' || Object.keys(value).sort().join(',')!==keys.join(',')
    || Object.keys(expected).some(key=>value[key]!==expected[key])) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  let continuation;try{continuation=assistantPassContinuation(value.continuation);}catch{fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');}
  return {schemaVersion:1,state:'confirmed',receiptId:id(value.receiptId),...expected,continuation,
    ...(hasProcessing?{processedSourceReferences:processed}:{})};
};
// These latches describe diagnostic obligations only, never task authority.
// An unrelated plugin/network recovery must not forget login or hook review.
const healthState = value => {
  const codes=['not_checked','ready','plugin_update_required','plugin_restart_required','mcp_reconnect_required','runtime_update_failed','codex_auth_required','hook_review_required','connection_lost'];
  if(!object(value) || !codes.includes(value.code) || !Array.isArray(value.latchedCodes) || value.latchedCodes.length>2
    || new Set(value.latchedCodes).size!==value.latchedCodes.length
    || value.latchedCodes.some(code=>!['codex_auth_required','hook_review_required'].includes(code))) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  return {revision:revision(value.revision),code:value.code,generation:revision(value.generation),latchedCodes:[...value.latchedCodes]};
};
const sourceHealthCodes=Object.freeze(['ready','setup_required','authentication_required','scope_changed','history_gap','read_failed']);
const sourceAcknowledgementHealthCodes=Object.freeze(['ready','acknowledgement_uncertain','acknowledgement_blocked']);
const sourceHealthState=value=>{
  if(!object(value)||!['not_checked',...sourceHealthCodes,...sourceAcknowledgementHealthCodes].includes(value.code)
    || value.lastCheckedAt!==null && (typeof value.lastCheckedAt!=='string'||!Number.isFinite(Date.parse(value.lastCheckedAt)))
    || (value.code==='not_checked')!==(value.lastCheckedAt===null))fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  return Object.freeze({revision:revision(value.revision),sourceRevision:revision(value.sourceRevision),
    generation:revision(value.generation),code:value.code,lastCheckedAt:value.lastCheckedAt});
};
const originOf = origin => {
  let url; try { url = new URL(origin); } catch { fail('ASSISTANT_TRANSPORT_INVALID_INPUT'); }
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  return origin;
};

/** Redirects cannot forward the device credential to a login page/other host.
 * Bounded JSON is projected immediately; backend prose, content and raw network
 * exceptions are never exposed. Fetch timeout covers response-body reading too.
 * No automatic retry is hidden here, especially for a one-use pairing exchange. */
export const createAssistantHttp = ({ origin, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) => {
  origin = originOf(origin);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  const routes = new Map([
    ['pair', ['POST','/pairings']], ['exchange',['POST','/pairings/exchange']],
    ['healthRead',['GET','/runtime/health']], ['healthReport',['POST','/runtime/health']],
    ['heartbeat',['POST','/runtime/heartbeat']], ['companies',['GET','/runtime/companies']],
    ['ownerIdentities',['GET','/runtime/owner-identities']],
    ['sourceAccounts',['GET','/runtime/source-skills/accounts']],
    ['sourceRoutes',['POST','/runtime/source-skills/routing']],
    ['sourceHealthRead',['GET','/runtime/source-skills/health']],['sourceHealthReport',['POST','/runtime/source-skills/health']],
    ['tasks',['POST','/runtime/tasks']], ['task',['POST','/runtime/task']],
    ['claim',['POST','/runtime/task/claim']],
    ['poll',['POST','/runtime/notifications/poll']], ['ack',['POST','/runtime/notifications/ack']],
    ['report',['POST','/runtime/schedule']],
    ['passBegin',['POST','/runtime/task-pass/begin']], ['passRead',['POST','/runtime/task-pass/read']],
    ['passRenew',['POST','/runtime/task-pass/renew']], ['passOutcome',['POST','/runtime/task-pass/outcome']], ['registerRuntime',['POST','/runtime/session/register']],
    ['endRuntime',['POST','/runtime/session/end']],
    ...['begin','read','session/register','session/end','read-confirm','cancel'].map((suffix,index)=>[['intakeBegin','intakeRead','intakeRegister','intakeEnd','intakeReadConfirm','intakeCancel'][index],['POST',`/runtime/source-skills/intake/${suffix}`]]),
  ]);
  return async (operation, body, credential = null, signal = null) => {
    const route = routes.get(operation);
    if (!route || (credential !== null && !/^tda_[A-Za-z0-9_-]{43}$/u.test(credential))) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
    // These two public routes use the enrollment's S256 verifier, never an
    // owner bearer. All runtime operations require the separate device token.
    if (['pair','exchange'].includes(operation) ? credential !== null : credential === null) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
    // This sole GET query has a closed structural schema. The caller cannot
    // choose an endpoint, append selectors or smuggle a request body to fetch.
    let query = '';
    if (operation === 'sourceAccounts') {
      if (!object(body) || Object.keys(body).join(',') !== 'companyId') fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      query = `?${new URLSearchParams({ companyId:id(body.companyId) })}`;
      body = undefined;
    }
    if(operation==='sourceHealthRead'){
      if(!object(body)||Object.keys(body).sort().join(',')!=='companyId,sourceId')fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      query=`?${new URLSearchParams({companyId:id(body.companyId),sourceId:id(body.sourceId)})}`;body=undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${origin}/api/digital-assistants${route[1]}${query}`, {
        method: route[0], redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.body || !/\bapplication\/json\b/iu.test(response.headers.get('content-type') ?? '')) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      const reader = response.body.getReader(); let bytes = 0, chunks = [];
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 512 * 1024) { await reader.cancel(); fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE'); }
          chunks.push(Buffer.from(next.value));
        }
      } finally { reader.releaseLock(); }
      let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE'); }
      chunks = [];
      if (!response.ok) {
        const code = typeof result?.code === 'string' && /^(?:ASSISTANT_|DIGITAL_ASSISTANTS_)[A-Z_]{1,80}$/u.test(result.code)
          ? result.code : 'ASSISTANT_TRANSPORT_REJECTED';
        fail(code, response.status);
      }
      if (!object(result)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return result;
    } catch (error) {
      if (error instanceof AssistantTransportError) throw error;
      fail('ASSISTANT_TRANSPORT_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  };
};

const loadAssistantDeviceCredential = async ({ origin, assistantId, deviceId, store }) => {
  const secret = await store.get({ origin, kind: 'device', id: assistantId });
  if (!secret || secret.assistantId !== assistantId || secret.deviceId !== deviceId
    || !/^tda_[A-Za-z0-9_-]{43}$/u.test(secret.credential ?? '') || !Number.isSafeInteger(secret.expiresAt)
    || secret.expiresAt <= 0) fail('ASSISTANT_DEVICE_REQUIRED');
  // Pairing's stored expiry is historical metadata, not live authority: the
  // owner can renew this exact device in Trelio without changing its protected
  // credential. Every fixed endpoint rechecks current absolute/idle expiry,
  // revocation and lifecycle. Rejecting by this stale local date would require
  // touching the assistant computer after an otherwise valid server renewal.
  // A denial preserves the private slot and never retries a mutation here.
  return secret.credential;
};

/** Fresh structural privacy preflight shared by task and taskless content.
 * Native mode and the original lease bracket each other; neither absent keys
 * nor cached local metadata may turn encrypted/unknown company into plain.
 * This grants no mutation/owner authority and consumes no business proof.
 */
export const readAssistantCompanyContentMode=async({identity,host,client,signal})=>{
  const pass=validateAssistantActivePass(await host.readActivePass(),identity);
  const intake=pass.kind==='source_intake',locator=intake
    ?{companyId:pass.companyId,sourceId:pass.sourceId,intakeId:pass.passId}
    :{companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId};
  const assertCurrent=async()=>{
    signal?.throwIfAborted();
    if(JSON.stringify(await host.readIdentity())!==JSON.stringify(identity)
      || JSON.stringify(validateAssistantActivePass(await host.readActivePass(),identity))!==JSON.stringify(pass))
      fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    const live=intake?await client.readSourceIntake(locator,signal):await client.readTaskPass(locator,signal);
    if(live.state!=='leased'||live.threadId!==pass.threadId||!Number.isFinite(Date.parse(live.leaseExpiresAt))
      || Date.parse(live.leaseExpiresAt)<=Date.now()
      || (intake ? live.eventId!==pass.eventId||live.sourceRevision!==pass.sourceRevision
        : ['passId','deliveryId','bindingId','bindingRevision'].some(key=>live[key]!==pass[key])))
      fail('ASSISTANT_PASS_REVIEW_REQUIRED');
  };
  await assertCurrent();
  const matches=(await client.companies(signal)).filter(company=>company.companyId===pass.companyId);
  if(matches.length!==1 || ![null,'plain','encrypted'].includes(matches[0].encryptionState))
    fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  await assertCurrent();
  return Object.freeze({...matches[0],encryptionState:matches[0].encryptionState??'plain'});
};

/** Public-key onboarding through the SAME company-encryption workflow. This
 * narrow async profile has TWO fixed endpoints only, no task pass/model proof,
 * payload/Workspace/Secret route, owner OAuth, scope-key grant or decryption.
 * Native company membership/MCP/module/device fences remain server authority. */
export const prepareAssistantCompanyEncryption = async ({identity,host,client,store,companyId,companySlug,signal,
  lockDirectory,lock=withRuntimeStateLock,managedContentOperation=null}) => {
  companyId=id(companyId);
  if(typeof companySlug!=='string'||!companySlug.length||companySlug.length>120||companySlug.trim()!==companySlug
    ||/[\x00-\x20\x7f]/u.test(companySlug)||!identity
    ||typeof host?.readIdentity!=='function'||typeof client?.companies!=='function')fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  const common=await import('./trelio-workspace.mjs');
  lockDirectory??=path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','encryption-locks');
  if(!path.isAbsolute(lockDirectory))fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  // All inventory, key-store and HTTP phases share ONE budget; progress and
  // repeated read-only checks never extend the caller's request deadline.
  const budget=AbortSignal.timeout(25_000);signal=signal?AbortSignal.any([signal,budget]):budget;
  const origin=originOf(identity.origin),assistantId=id(identity.assistantId),deviceId=id(identity.deviceId);
  const expected={schemaVersion:1,origin,assistantId,deviceId};
  const assertCurrent=async()=>{
    signal?.throwIfAborted();
    if(JSON.stringify(await host.readIdentity())!==JSON.stringify(expected))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    const companies=await client.companies(signal),company=companies.find(row=>row.companyId===companyId);
    if(!company||!['plain','encrypted'].includes(company.encryptionState??'plain'))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    return company;
  };
  await assertCurrent();
  const handle=Object.freeze(Object.create(null));let owned=null,activePreparation=null,contentOrigin=null;
  if(managedContentOperation!==null && typeof managedContentOperation!=='function')fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  const profile=Object.freeze({kind:'digital_assistant_enrollment',companyEncryptionUserId:assistantId,
    async requireToken(requestOrigin){if(requestOrigin!==origin && (!activePreparation || requestOrigin!==contentOrigin))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');await assertCurrent();return handle;},
    async resolveCompanyEncryptionDevice({origin:requestOrigin,companyId:requestedCompany}){
      if(requestOrigin!==origin||requestedCompany!==companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      const {resolveAssistantCompanyEncryptionDevice}=await import('./trelio-assistant-private.mjs');
      owned=await resolveAssistantCompanyEncryptionDevice({identity:expected,companyId,store,lockDirectory,lock,assertCurrent,allowCreate:managedContentOperation===null});
      return owned;
    },
    async prepareRequest({origin:requestOrigin,token,pathname,options,buildHeaders}){
      if(token!==handle||typeof pathname!=='string'||typeof buildHeaders!=='function')fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      let url;try{url=new URL(pathname,requestOrigin);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
      if(url.origin!==requestOrigin||url.hash||url.pathname!==pathname.split('?')[0])fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      const method=String(options.method??'GET').toUpperCase();let suffix;
      if(activePreparation && requestOrigin===contentOrigin && method==='POST' && !url.search
        && ['/api/agent-workspaces/encryption/payloads','/api/agent-workspaces/encryption/payloads/resolve'].includes(url.pathname)){
        let input;try{input=JSON.parse(options.body);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
        if(JSON.stringify(input)!==activePreparation.body || url.pathname!==activePreparation.pathname)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        await assertCurrent();await activePreparation.assertCurrent();
        const headers=buildHeaders(null,options.headers??{});
        for(const key of ['cookie','cookie2','proxy-authorization','x-trelio-assistant-pass','x-trelio-assistant-proof'])headers.delete(key);
        headers.set('authorization',`Bearer ${await loadAssistantDeviceCredential({...expected,store})}`);
        headers.set('x-trelio-assistant-content-preparation','1');
        headers.set('x-trelio-assistant-content-target',JSON.stringify(activePreparation.target));
        headers.set('x-trelio-assistant-source-encryption-fingerprint',owned.fingerprint);
        await assertCurrent();await activePreparation.assertCurrent();
        url.pathname='/api/digital-assistants/runtime/workspace'+url.pathname.slice('/api/agent-workspaces'.length);
        return {url,headers,options:{redirect:'error',credentials:'omit',cache:'no-store',signal}};
      }
      if(requestOrigin!==origin)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      if(method==='GET'&&url.pathname==='/api/agent-workspaces/encryption/runtime'&&options.body===undefined){
        const keys=[...url.searchParams.keys()];
        if(new Set(keys).size!==keys.length||keys.some(key=>!['companySlug','fingerprint'].includes(key))
          ||url.searchParams.get('companySlug')!==companySlug
          ||url.searchParams.has('fingerprint')&&url.searchParams.get('fingerprint')!==owned?.fingerprint)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        suffix='/runtime';
      }else if(method==='POST'&&url.pathname==='/api/agent-workspaces/encryption/devices'&&!url.search){
        if(managedContentOperation)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
        let input;try{input=JSON.parse(options.body);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
        if(!owned||!object(input)||input.companySlug!==companySlug||input.fingerprint!==owned.fingerprint
          ||JSON.stringify(input.publicEncryptionJwk)!==JSON.stringify(owned.publicEncryptionJwk)
          ||JSON.stringify(input.publicSigningJwk)!==JSON.stringify(owned.publicSigningJwk))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        suffix='/devices';
      }else fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      await assertCurrent();
      const headers=buildHeaders(null,options.headers??{});
      for(const key of ['cookie','cookie2','proxy-authorization','x-trelio-assistant-pass','x-trelio-assistant-proof'])headers.delete(key);
      headers.set('x-trelio-assistant-encryption-protocol','1');
      headers.set('authorization',`Bearer ${await loadAssistantDeviceCredential({...expected,store})}`);
      await assertCurrent();url.pathname='/api/digital-assistants/runtime/encryption'+suffix;
      return {url,headers,options:{redirect:'error',credentials:'omit',cache:'no-store',signal}};
    },
  });
  const context=await common.withWorkspaceExecutionProfile(profile,async()=>{
    const opened=await common.ensureCompanyEncryptionContext({
      origin,token:handle,company:{id:companyId,slug:companySlug},allowPendingRegistration:true,
      collectEncryptionKey:async()=>fail('ASSISTANT_WORKSPACE_PROFILE_DENIED'),
    });
    if(opened?.scopePrivateEncryptionKey){
      // Envelope presence alone proves neither key opening nor a matching
      // scope key. Reuse the ordinary 64-byte TRELIOE1 diagnostic; its exact
      // private staging is removed before success and no business file exists.
      await assertCurrent();
      await common.runCompanyEncryptionSelfTest(opened);
    }
    return opened;
  });
  await assertCurrent();
  if(context===null)return Object.freeze({schemaVersion:1,state:'not_required',companyId,businessReady:false});
  const runtime=context.runtime;
  if(runtime.company.id!==companyId||runtime.viewer?.userId!==assistantId||runtime.device?.fingerprint!==owned?.fingerprint
    ||!UUID.test(runtime.device?.id??'')||!['access_pending','ready'].includes(runtime.accessState))fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  if(managedContentOperation){
    if(runtime.accessState!=='ready'||!context.scopePrivateEncryptionKey)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
    // Routing is current native metadata. Only the ordinary approved encrypted
    // origin may receive ciphertext; never silently retry it on canonical HTTP.
    if(typeof runtime.requestOrigin!=='string')fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
    try{contentOrigin=common.resolveEncryptedDataPlaneOrigin(origin,runtime.requestOrigin);}
    catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
    context.requestOrigin=contentOrigin;
    return common.withWorkspaceExecutionProfile(profile,()=>managedContentOperation({context,token:handle,
      assertCurrent,requestPayloads:async(requestOrigin,token,pathname,options)=>{
        if(activePreparation||requestOrigin!==contentOrigin)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        const {managedTarget:target,assertPass,...httpOptions}=options;
        if(!object(target)||typeof assertPass!=='function')fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        // These two trusted callback properties never enter Fetch/JSON. The
        // strict native body carries only ciphertext and its signed inventory.
        activePreparation={body:options.body,pathname,target,assertCurrent:assertPass};
        try{return await common.request(requestOrigin,token,pathname,{...httpOptions,signal});}
        finally{activePreparation=null;}
      }}));
  }
  // Only the completed common round-trip permits key_verified. This is local
  // key readiness, never business execution or a reusable content capability.
  // The envelope, opened key and private/JWK fields stay outside MCP/state.
  return Object.freeze({schemaVersion:1,state:runtime.accessState==='ready'?'key_verified':'awaiting_company_key',
    companyId,cryptoDeviceId:runtime.device.id,fingerprint:owned.fingerprint,businessReady:false,
    settingsUrl:`${origin}/${encodeURIComponent(runtime.company.slug)}/settings/encryption/`});
};

/** SAME field crypto, narrowed to native-selected config/guidance payloads.
 * Source and task profiles authenticate independently; neither obtains the
 * ordinary arbitrary company payload resolver or a human encryption identity.
 * The native bundle is bounded before opening and never kept in SQLite. */
export const hydrateAssistantEncryptedSkill = async ({raw,bundle,common,origin,token,companyId,assistantId,
  fingerprint,openCompany,assertCurrent,signal,taskRuntimeMetadata=false}) => {
  const privateRuntime=raw?.artifact?.contentProtection==='company_e2ee_v1';
  if(privateRuntime&&!taskRuntimeMetadata)fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  const runtimeMetadata=privateRuntime?{manifest:raw.artifact.manifest,consentChallenge:raw.consentChallenge}:null;
  const manifestReference=privateRuntime?common.parseAgentEncryptedContentReference(raw.artifact.manifest):null;
  if(privateRuntime&&manifestReference?.field!=='manifest_json')fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  if(bundle===undefined){
    if(common.collectAgentEncryptedReferences({config:raw?.remoteMcp?.config??raw?.companyConnection?.config,guidance:raw?.assistantGuidance,runtimeMetadata,...(raw?.remoteMcp?{skillTitle:raw?.skill?.title}:{})}).size)
      fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
    return {rawResolution:raw,companyEncryption:null};
  }
  await assertCurrent();
  if(!object(bundle)||Object.keys(bundle).sort().join(',')!=='companyId,encryptedPayloads,envelopeId,recipientDeviceId,schemaVersion,scopeEpoch,scopeId'
    ||bundle.schemaVersion!==1||bundle.companyId!==companyId||!UUID.test(bundle.recipientDeviceId??'')
    ||!UUID.test(bundle.envelopeId??'')||!UUID.test(bundle.scopeId??'')||!Number.isSafeInteger(bundle.scopeEpoch)||bundle.scopeEpoch<1
    ||!object(raw.company)||raw.company.id!==companyId||typeof raw.company.slug!=='string'||!fingerprint)
    fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  const opened=await openCompany(raw.company);
  if(!opened||opened.runtime.company.id!==companyId||opened.runtime.viewer?.userId!==assistantId
    ||opened.runtime.device?.id!==bundle.recipientDeviceId||opened.runtime.envelope?.id!==bundle.envelopeId
    ||opened.runtime.scope?.id!==bundle.scopeId||opened.runtime.scope?.epoch!==bundle.scopeEpoch
    ||opened.runtime.device?.fingerprint!==fingerprint)fail('ASSISTANT_SOURCE_BINDING_CHANGED');
  const selected=readAssistantEncryptedSnapshotBundle({schemaVersion:1,context:raw,encryptedPayloads:bundle.encryptedPayloads},opened,companyId);
  const config=raw.remoteMcp?(raw.remoteMcp.contentProtection==='company_e2ee_v1'?raw.remoteMcp.config:null):raw.companyConnection?.config??null,reference=config===null?null:common.parseAgentEncryptedContentReference(config);
  const expected=common.collectAgentEncryptedReferences({config,...(raw.assistantGuidance?{guidance:raw.assistantGuidance}:{}),...(raw.remoteMcp?{skillTitle:raw.skill?.title}:{}),...(runtimeMetadata?{runtimeMetadata}:{})});
  if(config!==null&&reference?.field!==(raw.remoteMcp?'remote_mcp_config_json':'config_json')||expected.size>8||selected.payloads.size!==expected.size
    ||[...expected.keys()].some(entityId=>!selected.payloads.has(entityId)))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  const value={...raw};delete value.sourceEncryption;delete value.assistantEncryption;
  // Always hydrate the exact native guidance too: a null connection does not
  // imply the current member's personal skill rule is plaintext or empty.
  const hydrated=await common.hydrateAgentCompanyEncryptedJson({value,origin,token,companyEncryption:opened,signal,
    resolvePayloads:async ids=>{
      if(ids.some(entityId=>!selected.payloads.has(entityId)))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      return {payloads:ids.map(entityId=>selected.payloads.get(entityId))};
    }});
  await assertCurrent();return {rawResolution:{...hydrated,...(privateRuntime?{encryptedManifestEntityId:manifestReference.entityId}:{})},companyEncryption:opened};
};

const validateAssistantEncryptedSkillRead = (value,pass=null) => {
  if(!object(value)||Object.keys(value).filter(key=>key!=='executionKind').sort().join(',')!=='arguments,companyId,nativeTool,projectId,releaseId,schemaVersion,skillId'
    ||value.executionKind!==undefined&&value.executionKind!=='remote_mcp'
    ||value.schemaVersion!==1||value.nativeTool!=='get_agent_skill'||!UUID.test(value.companyId??'')
    ||value.projectId!==null&&!UUID.test(value.projectId??'')||!UUID.test(value.releaseId??'')
    ||typeof value.skillId!=='string'||!value.skillId.length||value.skillId.length>120||!object(value.arguments)
    ||Object.keys(value.arguments).some(key=>!['sections','knownInstructionKey'].includes(key))
    ||value.arguments.sections!==undefined&&(!Array.isArray(value.arguments.sections)
      ||value.arguments.sections.length>5||value.arguments.sections.some(item=>!['instructions','execution','connection','publication'].includes(item)))
    ||value.arguments.knownInstructionKey!==undefined&&(typeof value.arguments.knownInstructionKey!=='string'||value.arguments.knownInstructionKey.length>300)
    ||pass&&value.companyId!==pass.companyId)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  return structuredClone(value);
};

/** Closed content surface implemented with the SAME local protector, payload
 * collision comparison, managed OS identity and native data-plane routes. This
 * list is a transport capability, never a replacement domain schema or ACL. */
const ASSISTANT_MANAGED_CONTENT_TOOLS=new Set(['call_remote_agent_skill_tool','cancel_agent_workspace_run','ask_assistant_owner','request_assistant_action','resolve_assistant_intake',
  'create_task','create_comment','update_comment','update_task_title','update_task_description','create_task_control',
  'update_task_control','create_checklist','update_checklist','create_subtask','create_task_relation','update_task_status',
  'update_task_urgency','update_task_due_date','update_task_assignee','set_task_participants','clear_task_control',
  'update_task_custom_field','delete_attachment','delete_checklist','complete_checklist_item','delete_task_relation',
  'get_assistant_owner_question','get_assistant_intake_context']);
export const supportsAssistantManagedContent=(name,args)=>ASSISTANT_MANAGED_CONTENT_TOOLS.has(name)
  ||name==='continue_assistant_workspace_action'&&(args?.operation==='skill_run'
    ||args?.operation==='secret_list'&&args.parameters?.holder==='company');
/** Closed local projection, not owner authority. Textual metadata is never
 * declassified into the global personal pool by naming this mode. Native
 * schemas/review still select fixed labels, one policy and the exact Run. */
export const assistantNeutralPrivateMetadata=value=>{
  if(!object(value)||value.metadataMode!=='neutral'||!['opaque','login','password'].includes(value.cardType)
    ||Object.keys(value).some(key=>!['metadataMode','cardType','runId','generatedFields'].includes(key)))return false;
  if(value.runId===undefined&&value.generatedFields===undefined)return true;
  return UUID.test(value.runId??'')&&value.cardType==='password'&&Array.isArray(value.generatedFields)&&value.generatedFields.length===1
    &&value.generatedFields.every(row=>object(row)&&Object.keys(row).sort().join(',')==='generator,key,length'
      &&row.key==='password'&&row.generator==='password'&&Number.isSafeInteger(row.length)&&row.length>=16&&row.length<=128);
};
/** Value-free NEW company intent. This is a syntax/privacy check only;
 * native scope/create ACL, original owner decision and Run remain authority. */
export const assistantNeutralCompanySecret=value=>{
  if(!object(value)||value.metadataMode!=='neutral'||!['opaque','login','password'].includes(value.cardType)
    ||value.scopeType!=='task'||!UUID.test(value.runId??'')||!['empty','generated','protected_input'].includes(value.valueSource)
    ||Object.keys(value).some(key=>!['metadataMode','cardType','scopeType','runId','valueSource','generatedFields'].includes(key)))return false;
  return value.valueSource==='generated'?assistantNeutralPrivateMetadata({metadataMode:'neutral',cardType:value.cardType,
    runId:value.runId,generatedFields:value.generatedFields}):value.generatedFields===undefined;
};
const managedBusinessArguments=raw=>Object.fromEntries(Object.entries(raw).filter(([key])=>
  !['taskPass','intakePass','runtimeSessionProof','encryptedContent'].includes(key)));
const rejectBorrowedManagedMarkers=(value,depth=0)=>{
  if(depth>40)fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
  // A model may know a marker from another task. Signing it would turn a
  // narrow preparation into a payload oracle, so only freshly produced local
  // markers may ever receive our private binding signature.
  if(typeof value==='string'&&/~e1:[0-9a-f-]{36}:[a-z][a-z0-9_]{0,63}~/iu.test(value)
    ||object(value)&&Object.hasOwn(value,'$trelioE2ee'))fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
  if(value&&typeof value==='object')for(const child of Object.values(value))rejectBorrowedManagedMarkers(child,depth+1);
};

/** Only canonical structural value shapes may cross encrypted transport.
 * This is not a second domain normalizer: number precision, current select
 * membership, eligible people and definition CAS remain native checks. It
 * prevents malformed prose in an alleged number/date/ID from leaking FIRST.
 */
const managedCustomFieldValue=(definition,value)=>{
  if(value===null||value===undefined||value==='')return null;
  const id=value=>typeof value==='string'&&UUID.test(value);
  const ids=value=>id(value)||Array.isArray(value)&&value.length<=200&&value.every(id);
  const selection=value=>typeof value==='string'&&definition.optionIds.includes(value);
  const entity=value=>object(value)&&Object.keys(value).sort().join(',')==='entityType,id'
    &&['member','group'].includes(value.entityType)&&id(value.id);
  let valid=false;
  switch(definition.fieldType){
    case 'text':valid=typeof value==='string'&&value.length<=255;break;
    case 'number':valid=typeof value==='number'&&Number.isFinite(value);break;
    case 'checkbox':valid=typeof value==='boolean';break;
    case 'date':valid=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(value)
      &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;break;
    case 'select':valid=selection(value)||Array.isArray(value)&&value.length<=200&&value.every(selection);break;
    case 'user':case 'group':valid=ids(value);break;
    case 'user_or_group':valid=entity(value)||Array.isArray(value)&&value.length<=200&&value.every(entity);break;
  }
  if(!valid)fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
  return value; // The SAME protector preserves text; this guard never normalizes domain values.
};

/** One bounded tools/call exchange. Staging has no domain effect and consumes
 * no observed nonce. The ordinary send callback still executes exactly once
 * with its independent live native pass/proof/CAS and sealed owner decision. */
export const withAssistantManagedContentArguments=async({identity,host,client,store,lockDirectory,name,args,signal},send)=>{
  if(!supportsAssistantManagedContent(name,args)||!object(args)||typeof send!=='function')fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
  // Ignore model-authored transport hints before signing; all private metadata
  // comes from the genuine current OS/pass context below.
  let business=managedBusinessArguments(args);rejectBorrowedManagedMarkers(business);
  const secretMetadata=name==='continue_assistant_workspace_action'&&business.operation==='secret_list'&&business.parameters?.holder==='company';
  if(secretMetadata&&(business.schemaVersion!==1||business.runIdentity!==undefined||Object.keys(business).some(key=>!['schemaVersion','operation','parameters'].includes(key))
    ||Object.keys(business.parameters).some(key=>!['holder','offset','limit'].includes(key))
    ||business.parameters.offset!==undefined&&(!Number.isSafeInteger(business.parameters.offset)||business.parameters.offset<0)
    ||business.parameters.limit!==undefined&&(!Number.isSafeInteger(business.parameters.limit)||business.parameters.limit<1||business.parameters.limit>50)))fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
  const skillArguments=name==='continue_assistant_workspace_action'&&business.operation==='skill_run';
  let originalSkillArguments=null;
  if(skillArguments){
    // Preserve the SAME CLI vector exactly, including account/option order.
    // Only this fixed operation may replace it with a native-owned JSON marker;
    // model-supplied transport fields or arbitrary continuation operations fail.
    if(!object(business.parameters)||Object.hasOwn(business.parameters,'encryptedArguments')
      ||!Array.isArray(business.parameters.arguments)||!business.parameters.arguments.length||business.parameters.arguments.length>100
      ||business.parameters.arguments.some(value=>typeof value!=='string'||value.length>4096))fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
    // The wire catalogue intentionally exposes generic parameters; reuse the
    // SAME pure continuation parser BEFORE the first preparation HTTP rather
    // than duplicating its closed skill parameter schema in a protector.
    const {buildTrelioWorkspaceActionInvocation}=await import('./trelio-local-context.mjs');
    try{buildTrelioWorkspaceActionInvocation(business);}catch{fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');}
    originalSkillArguments=structuredClone(business.parameters.arguments);
    business.parameters={...business.parameters,encryptedArguments:business.parameters.arguments,arguments:[]};
  }

  if(Object.hasOwn(business,'encryptedFiles')||Object.hasOwn(business,'acceptedFiles')&&name!=='create_comment'
    ||object(business.fields)&&Object.hasOwn(business.fields,'acceptedFiles')
    ||name==='request_assistant_action'&&business.operation==='create_private_secret'&&!assistantNeutralPrivateMetadata(business.fields)
    ||name==='request_assistant_action'&&business.operation==='create_company_secret'&&!assistantNeutralCompanySecret(business.fields))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
  if(business.acceptedFiles!==undefined&&(!Array.isArray(business.acceptedFiles)||business.acceptedFiles.length<1
    ||business.acceptedFiles.length>10||business.acceptedFiles.some(file=>!object(file)
      ||Object.keys(file).sort().join(',')!=='filePath,runId'||!UUID.test(file.runId)||typeof file.filePath!=='string'
      ||!file.filePath||file.filePath.length>1024||file.filePath.replaceAll('\\','/').toLowerCase().split('/').filter(Boolean)[0]==='assistants')
    ||new Set(business.acceptedFiles.map(file=>`${file.runId}\0${file.filePath}`)).size!==business.acceptedFiles.length))fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
  // Content-dependent refinements cannot be evaluated on opaque markers by
  // the native Zod validator. Preserve its question/choice contract BEFORE
  // sealing; these local guards grant no action or owner decision authority.
  const question=name==='ask_assistant_owner'||name==='resolve_assistant_intake'&&business.decision==='ask_owner';
  if(question){
    if(typeof business.questionText!=='string'||!business.questionText.trim()
      ||Buffer.byteLength(business.questionText.trim(),'utf8')>16384)fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
    business.questionText=business.questionText.trim();
    if(business.options!==undefined){
      if(!Array.isArray(business.options)||business.options.length<2||business.options.length>8
        ||business.options.some(value=>typeof value!=='string'||!value.trim()||value.trim().length>300
          ||Buffer.byteLength(value.trim(),'utf8')>600||['other','другое'].includes(value.trim().toLocaleLowerCase('ru-RU'))))
        fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
      business.options=business.options.map(value=>value.trim());
      if(new Set(business.options.map(value=>value.toLocaleLowerCase('ru-RU'))).size!==business.options.length)fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
    }
  }
  const pass=validateAssistantActivePass(await host.readActivePass(),identity);
  const target=pass.kind==='source_intake'
    ?{kind:'source_intake',pass:{companyId:pass.companyId,sourceId:pass.sourceId,intakeId:pass.passId}}
    :{kind:'task',pass:{companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId}};
  if((target.kind==='source_intake')!==['get_assistant_intake_context','resolve_assistant_intake'].includes(name))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  if(name==='request_assistant_action'&&(typeof business.reason!=='string'||!business.reason.trim()
    ||Buffer.byteLength(business.reason.trim(),'utf8')>2000))fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
  let publicationTerminal=null;
  const assertPass=async()=>{
    signal?.throwIfAborted();
    if(JSON.stringify(validateAssistantActivePass(await host.readActivePass(),identity))!==JSON.stringify(pass))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
    const current=target.kind==='task'?await client.readTaskPass(target.pass,signal):await client.readSourceIntake(target.pass,signal);
    if((current.state!=='leased'&&current.state!==publicationTerminal)||current.threadId!==pass.threadId||Date.parse(current.leaseExpiresAt)<=Date.now()
      ||target.kind==='source_intake'&&(current.eventId!==pass.eventId||current.sourceRevision!==pass.sourceRevision)
      ||target.kind==='task'&&current.passId!==pass.passId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  };
  await assertPass();
  const company=(await client.companies(signal)).find(row=>row.companyId===pass.companyId);
  if(company?.encryptionState!=='encrypted'||typeof company.companySlug!=='string')fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  return prepareAssistantCompanyEncryption({identity,host,client,store,companyId:pass.companyId,companySlug:company.companySlug,
    signal,lockDirectory,managedContentOperation:async({context,token,requestPayloads,assertCurrent})=>{
      const common=await import('./trelio-workspace.mjs'),local=await import('./trelio-local-context.mjs'),
        crypto=await import('./trelio-company-encryption.mjs');
      const current=async()=>{await assertCurrent();await assertPass();};
      let customField=null,commentFiles=null,commentMentions=null,commentAttachmentLinks=[];
      const binding=async(phase,wire,action)=>{
        await current();
        return crypto.signCompanyEncryptionRecord(context.device.privateKeys.signingPrivateKey,
          {protocol:'assistant-managed-content/v1',phase,companyId:pass.companyId,target,nativeTool:name,
            arguments:managedBusinessArguments(wire),...(action?{action}:{}),...(customField?{customField}:{}),...(commentFiles?{commentFiles}:{}),...(commentMentions?{commentMentions}:{})});
      };
      const hydrate=async bundle=>{
        await current();
        if(!object(bundle)||bundle.companyId!==pass.companyId||bundle.recipientDeviceId!==context.runtime.device.id
          ||bundle.envelopeId!==context.runtime.envelope.id||bundle.scopeId!==context.runtime.scope.id
          ||bundle.scopeEpoch!==context.runtime.scope.epoch)fail('ASSISTANT_MCP_INVALID_RESPONSE');
        const selected=readAssistantEncryptedSnapshotBundle({schemaVersion:1,...bundle},context,pass.companyId);
        const value=await common.hydrateAgentCompanyEncryptedJson({value:selected.context,origin:identity.origin,token,
          companyEncryption:context,signal,resolvePayloads:async ids=>{
            await current();
            if(ids.some(id=>!selected.payloads.has(id)))fail('ASSISTANT_MCP_INVALID_RESPONSE');
            return {payloads:ids.map(id=>selected.payloads.get(id))};
          }});
        await current();return value;
      };
      const stage=async(protectedValue,{actionPreview=false,ownerActionContent}={})=>{
        const wire=Object.fromEntries(Object.entries(protectedValue.value).filter(([key])=>key!=='ownerDecisionId'));
        const action=actionPreview?{preview:true}:ownerActionContent?{content:ownerActionContent}:undefined;
        const preparation={nativeTool:name,arguments:wire,...(customField?{customField}:{}),...(commentFiles?{commentFiles}:{}),...(commentMentions?{commentMentions}:{}),...(actionPreview?{actionPreview:true}:{}),
          ...(ownerActionContent?{ownerActionContent}:{}),signature:await binding('preparation',wire,action)};
        const request=async(origin,selectedToken,pathname,options)=>{
          await current();
          return requestPayloads(origin,selectedToken,pathname,{...options,managedTarget:target,assertPass:current,
            body:JSON.stringify({...JSON.parse(options.body),preparation})});
        };
        // Reuse native collision -> exact selected ciphertext -> local expected
        // plaintext equality. Never repeat the later business request here.
        await local.uploadLocalActionPayloads({origin:identity.origin,token,companyEncryption:context,
          payloads:protectedValue.payloads,expectedPayloadValues:protectedValue.expectedPayloadValues,signal,requestPayloads:request});
        if(actionPreview){
          const response=await request(context.requestOrigin,token,'/api/agent-workspaces/encryption/payloads',
            {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({companySlug:company.companySlug,
              writerDeviceId:context.runtime.device.id,payloads:[]}),signal});
          const bytes=await common.readBoundedResponseBuffer(response,3*1024*1024,'Assistant managed content');
          try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
          catch{fail('ASSISTANT_MCP_INVALID_RESPONSE');}finally{bytes.fill(0);}
        }
        return null;
      };
      if(business.acceptedFiles){
        const descriptors=[],links=[];
        for(const [ordinal,file]of business.acceptedFiles.entries()){
          // Select the exact own accepted Run with STRUCTURAL arguments only.
          // No original path/body/name enters this preparatory HTTP request.
          const selected={clientRequestId:business.clientRequestId,expectedTaskUpdatedAt:business.expectedTaskUpdatedAt};
          const definition={runId:file.runId,ordinal},action={commentFileDefinition:definition};
          const preparation={nativeTool:name,arguments:selected,commentFileDefinition:definition,
            signature:await binding('preparation',selected,action)};
          const response=await requestPayloads(context.requestOrigin,token,'/api/agent-workspaces/encryption/payloads',
            {method:'POST',headers:{'content-type':'application/json'},signal,managedTarget:target,assertPass:current,
              body:JSON.stringify({companySlug:company.companySlug,writerDeviceId:context.runtime.device.id,payloads:[],preparation})});
          const bytes=await common.readBoundedResponseBuffer(response,16*1024*1024,'Assistant accepted file manifest');let result;
          try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
          catch{fail('ASSISTANT_MCP_INVALID_RESPONSE');}finally{bytes.fill(0);}
          if(!object(result)||result.schemaVersion!==1||result.runId!==file.runId
            ||!UUID.test(result.workspaceId)||!HEAD.test(result.workspaceHead)||!UUID.test(result.projectionId)
            ||!UUID.test(result.manifestFileId)||!UUID.test(result.attachmentId)
            ||!Number.isSafeInteger(result.projectionFileCount)||result.projectionFileCount<1
            ||typeof result.ciphertextSha256!=='string'||!SHA256.test(result.ciphertextSha256)
            ||typeof result.ciphertextBase64!=='string'||result.ciphertextBase64.length>14*1024*1024
            ||typeof result.publicUrl!=='string')fail('ASSISTANT_MCP_INVALID_RESPONSE');
          let url;try{url=new URL(result.publicUrl);}catch{fail('ASSISTANT_MCP_INVALID_RESPONSE');}
          if(url.origin!==new URL(identity.origin).origin||url.search||url.hash
            ||!url.pathname.endsWith(`/attachments/${result.attachmentId}/download`))fail('ASSISTANT_MCP_INVALID_RESPONSE');
          const ciphertext=Buffer.from(result.ciphertextBase64,'base64');delete result.ciphertextBase64;let opened;
          try{
            await current();
            opened=await crypto.decryptFileFromCompanyContainerBytes({bytes:ciphertext,
              scopePrivateKey:context.scopePrivateEncryptionKey.privateKey,scopePrivateJwk:context.scopePrivateEncryptionKey.privateJwk,
              expectedCiphertextSha256:result.ciphertextSha256,maximumPlaintextBytes:8*1024*1024});
            const aad=opened.header?.aad;
            if(aad?.companyId!==pass.companyId||aad?.scopeId!==context.runtime.scope.id||aad?.scopeEpoch!==context.runtime.scope.epoch
              ||aad?.entityType!=='agent_workspace_browser_manifest'||aad?.entityId!==result.manifestFileId
              ||aad?.entityRevision!==1||aad?.schemaVersion!==1||aad?.purpose!=='file')fail('ASSISTANT_MCP_INVALID_RESPONSE');
            const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(opened.bytes));
            const [selectedFile]=local.selectEncryptedProposalFilesFromManifest({manifest,projectionId:result.projectionId,
              projectionFileCount:result.projectionFileCount,workspaceId:result.workspaceId,acceptedHead:result.workspaceHead,
              filePaths:[file.filePath]});
            descriptors.push({runId:file.runId,sourceFileId:selectedFile.sourceFileId,filePath:selectedFile.filePath,
              fileName:selectedFile.fileName,contentType:selectedFile.contentType});
            links.push({id:result.attachmentId,fileName:selectedFile.fileName,publicUrl:result.publicUrl});
            await current();
          }finally{ciphertext.fill(0);opened?.bytes.fill(0);}
        }
        const normalized=local.normalizeLocalActionRichTextInputs(business);
        if(normalized.bodyText!==undefined||normalized.bodyMarkdown!==undefined)fail('ASSISTANT_ENCRYPTED_CONTENT_INVALID');
        commentAttachmentLinks=links;
        delete normalized.acceptedFiles;business={...normalized,encryptedFiles:descriptors};
      }
      if(name==='update_task_custom_field'){
        // Ask the SAME native preparation cell for one active field's OPEN
        // type/settings. Never send `value` (even malformed input) in this read.
        const selected={fieldId:business.fieldId,clientRequestId:business.clientRequestId,expectedTaskUpdatedAt:business.expectedTaskUpdatedAt};
        const preparation={nativeTool:name,arguments:selected,customFieldDefinition:true,
          signature:await binding('preparation',selected,{customFieldDefinition:true})};
        const response=await requestPayloads(context.requestOrigin,token,'/api/agent-workspaces/encryption/payloads',
          {method:'POST',headers:{'content-type':'application/json'},signal,managedTarget:target,assertPass:current,
            body:JSON.stringify({companySlug:company.companySlug,writerDeviceId:context.runtime.device.id,payloads:[],preparation})});
        const bytes=await common.readBoundedResponseBuffer(response,32768,'Assistant field definition');let result;
        try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
        catch{fail('ASSISTANT_MCP_INVALID_RESPONSE');}finally{bytes.fill(0);}
        const definition=result?.customField;
        if(result?.schemaVersion!==1||!object(definition)||definition.id!==business.fieldId||!UUID.test(definition.id)
          ||!['text','number','checkbox','date','select','user','group','user_or_group'].includes(definition.fieldType)
          ||typeof definition.updatedAt!=='string'||!Number.isFinite(Date.parse(definition.updatedAt))
          ||Object.keys(definition).some(key=>!['id','fieldType','updatedAt','optionIds'].includes(key))
          ||definition.fieldType==='select'&&(!Array.isArray(definition.optionIds)||definition.optionIds.length>200
            ||definition.optionIds.some(id=>typeof id!=='string'||!id||id.length>255))
          ||definition.fieldType!=='select'&&definition.optionIds!==undefined)fail('ASSISTANT_MCP_INVALID_RESPONSE');
        business.value=managedCustomFieldValue(definition,business.value);
        customField={id:definition.id,fieldType:definition.fieldType,updatedAt:definition.updatedAt};
        await current();
      }
      if(['create_comment','update_comment'].includes(name)){
        const selected={clientRequestId:business.clientRequestId,expectedTaskUpdatedAt:business.expectedTaskUpdatedAt,
          ...(name==='update_comment'?{commentId:business.commentId}:{})};
        const action={commentDefinition:true},preparation={nativeTool:name,arguments:selected,commentDefinition:true,
          signature:await binding('preparation',selected,action)};
        const response=await requestPayloads(context.requestOrigin,token,'/api/agent-workspaces/encryption/payloads',
          {method:'POST',headers:{'content-type':'application/json'},signal,managedTarget:target,assertPass:current,
            body:JSON.stringify({companySlug:company.companySlug,writerDeviceId:context.runtime.device.id,payloads:[],preparation})});
        const bytes=await common.readBoundedResponseBuffer(response,512*1024,'Assistant comment audience');let definition;
        try{definition=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
        catch{fail('ASSISTANT_MCP_INVALID_RESPONSE');}finally{bytes.fill(0);}
        const members=definition?.commentDefinition?.members,groupIds=definition?.commentDefinition?.groupIds;
        if(definition?.schemaVersion!==1||!Array.isArray(members)||members.length>5000
          ||!Array.isArray(groupIds)||groupIds.length>5000||groupIds.some(id=>!UUID.test(id))||new Set(groupIds).size!==groupIds.length
          ||members.some(member=>!object(member)||Object.keys(member).sort().join(',')!=='displayName,memberId,username'
            ||!UUID.test(member.memberId)||typeof member.username!=='string'||member.username.length>128
            ||typeof member.displayName!=='string'||member.displayName.length>1000)
          ||new Set(members.map(member=>member.memberId)).size!==members.length
          ||new Set(members.map(member=>member.username.toLowerCase())).size!==members.length)fail('ASSISTANT_MCP_INVALID_RESPONSE');
        business=local.normalizeLocalActionRichTextInputs(business);
        business.bodyJson=local.canonicalizeLocalProposalMentions(business.bodyJson,members);
        commentMentions=local.collectLocalTaskCommentMentions(business.bodyJson,{members,groupIds});
        await current();
      }
      // Keep the human publication order: canonicalize the actual message,
      // then append file links. A filename containing @username is not a ping.
      if(commentAttachmentLinks.length)business.bodyJson=local.appendLocalTaskCommentAttachmentLinks(business.bodyJson,commentAttachmentLinks);
      const readonly=secretMetadata||['get_assistant_owner_question','get_assistant_intake_context'].includes(name);
      let wire=business,action;
      if(!readonly){
        if(name==='request_assistant_action'&&business.operation==='create_private_secret'&&!assistantNeutralPrivateMetadata(business.fields)
          ||name==='request_assistant_action'&&business.operation==='create_company_secret'&&!assistantNeutralCompanySecret(business.fields))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
        const protectedValue=await local.protectLocalActionArguments({nativeTool:name,arguments:business,companyEncryption:context,
          ...(customField?{customFieldTypeForId:id=>id===customField.id?customField.fieldType:null}:{})});
        // All new host metadata stays inside the ALREADY hidden envelope.
        // Older model-schema projectors know that envelope; a new root field
        // would otherwise expose a path-bearing input before their preflight.
        if(protectedValue.value.encryptedFiles){
          commentFiles=protectedValue.value.encryptedFiles;
          delete protectedValue.value.encryptedFiles;
        }
        wire=protectedValue.value;
        if(name==='request_assistant_action'){
          const preview=await stage(protectedValue,{actionPreview:true}),opened=await hydrate(preview);
          if(typeof opened.questionText!=='string'||Buffer.byteLength(opened.questionText,'utf8')>16384||!object(opened.snapshot)||!Array.isArray(opened.requiredActions))fail('ASSISTANT_MCP_INVALID_RESPONSE');
          // Keep original native markers for final CAS. Only the owner-visible
          // preview and intent are hydrated and protected into this SAME store.
          const rawSnapshot=structuredClone(preview.context.snapshot);
          const content=await local.protectLocalActionArguments({nativeTool:name,companyEncryption:context,
            arguments:{clientRequestId:business.clientRequestId,encryptedAction:{questionText:opened.questionText,
              intentJson:{fields:business.fields,snapshot:opened.snapshot,reason:business.reason}}}});
          const ownerActionContent=content.value.encryptedAction;
          await stage({value:wire,payloads:content.payloads,expectedPayloadValues:content.expectedPayloadValues},{ownerActionContent});
          action={...ownerActionContent,snapshot:rawSnapshot};
        }else await stage(protectedValue);
      }
      const encryptedContent={schemaVersion:1,fingerprint:context.device.fingerprint,...(customField?{customField}:{}),...(commentFiles?{commentFiles}:{}),...(commentMentions?{commentMentions}:{}),
        ...(!readonly?{signature:await binding('publication',wire,action)}:{}),...(action?{action}:{})};
      await current();
      const authority=Object.fromEntries(Object.entries(args).filter(([key])=>['taskPass','intakePass','runtimeSessionProof'].includes(key)));
      const result=await send({...authority,...wire,encryptedContent}); // exactly ONE domain invocation
      if(result?.isError===true)return result;
      const terminal=result?.structuredContent?.managedEncryptedContent?.context?.state??result?.structuredContent?.state;
      if(name==='resolve_assistant_intake'&&['ignored','created','waiting_owner','redirected'].includes(terminal))publicationTerminal=terminal;
      const bundle=result?.structuredContent?.managedEncryptedContent;
      if(skillArguments&&!bundle)fail('ASSISTANT_MCP_INVALID_RESPONSE');
      if(!bundle){await current();return result;}
      const value=await hydrate(bundle);
      if(skillArguments){
        // Hydration precedes the ordinary continuation validator and signed
        // skill policy/account/process engine. The encrypted adapter grants no
        // command permission, provider input or replay exception by itself.
        const action=value.localAction,parameters=action?.parameters;
        if(value.prepared!==true||action?.operation!=='skill_run'||!object(parameters)
          ||!Array.isArray(parameters.arguments)||parameters.arguments.length!==0
          ||!Array.isArray(parameters.encryptedArguments)||parameters.encryptedArguments.length>100
          ||parameters.encryptedArguments.some(value=>typeof value!=='string'||value.length>4096)
          ||JSON.stringify(parameters.encryptedArguments)!==JSON.stringify(originalSkillArguments))fail('ASSISTANT_MCP_INVALID_RESPONSE');
        action.parameters={...parameters,arguments:parameters.encryptedArguments};
        delete action.parameters.encryptedArguments;
      }

      if(name==='get_assistant_intake_context'){
        const authority=value.creationAuthority;
        if(!object(authority)||authority.company?.id!==pass.companyId||!authority.instructions)fail('ASSISTANT_MCP_INVALID_RESPONSE');
        value.effectiveInstructions=local.buildLocalScopedEffectiveInstructions(authority,null);
        if(value.metadata){
          const project=authority.projects.find(row=>row.id===value.projectId);
          if(!project)fail('ASSISTANT_MCP_INVALID_RESPONSE');
          value.metadata.structuredContent.effectiveInstructions=local.buildLocalScopedEffectiveInstructions(authority,project);
          value.metadata.content=[{type:'text',text:JSON.stringify(value.metadata.structuredContent)}];
        }
        delete value.creationAuthority;
      }
      return {...result,content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
    }});
};

/** Internal composition of native Workspace transport. Device credentials
 * are resolved from the existing private slot through a callback, never a
 * model-visible getter or a human-token fallback. */
export const createAssistantWorkspaceProfile = async ({identity,client,store,host,lockDirectory,
  sourceReads=null,encryptedTaskRead=null,encryptedInspection=null,encryptedSkillRead=null,workspaceRun=null,materialWorkspaceId=null,secretBrowserFill=null,secretGeneration=null,secretSkill=null,remoteMcp=null,skillAccountSetup=null,lock=withRuntimeStateLock,now=Date.now}) => {
  const uuid=UUID, same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
  const nativePrefix='/api/agent-workspaces', assistantPrefix='/api/digital-assistants/runtime/workspace';
  const withCredential=async action=>action(await loadAssistantDeviceCredential({...identity,store}));
  if(!identity || !uuid.test(identity.assistantId??'') || !uuid.test(identity.deviceId??'')
    || !path.isAbsolute(lockDirectory??'') || !host || !client || !store) fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  let origin;try{origin=new URL(identity.origin);}catch{fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');}
  if(origin.protocol!=='https:' || origin.origin!==identity.origin || origin.username || origin.password) fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  const expectedIdentity=Object.freeze({schemaVersion:1,origin:identity.origin,assistantId:identity.assistantId,deviceId:identity.deviceId});
  const pass=validateAssistantActivePass(await host.readActivePass(),identity);
  const locator={companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId};
  // This descriptor comes only from the authenticated native MCP result. It
  // scopes ONE invocation of the shared reader, not a reusable company route.
  const encryptedRead=encryptedTaskRead===null?null:await validateAssistantEncryptedTaskRead({
    descriptor:encryptedTaskRead,identity,pass});
  // A native plan narrows this invocation to ONE prepared private grant.
  // Structural IDs alone do not authorize it: every HTTP request still repeats
  // the native grant/holder/pass/device/Run checks before value delivery.
  if(secretBrowserFill!==null && (!object(secretBrowserFill)
    || Object.keys(secretBrowserFill).sort().join(',')!=='grantId,runId,workspaceId'
    || Object.values(secretBrowserFill).some(value=>!uuid.test(value??''))))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  const privateFill=secretBrowserFill===null?null:Object.freeze({...secretBrowserFill});
  const companyGeneration=secretGeneration?.holder==='company';
  if(secretGeneration!==null && (!object(secretGeneration)
    || (companyGeneration?Object.keys(secretGeneration).sort().join(',')!=='clientRequestId,expectedTaskUpdatedAt,holder,ownerDecisionId,plan,runId,workspaceId'
      ||!assistantNeutralCompanySecret(secretGeneration.plan)||secretGeneration.plan.runId!==secretGeneration.runId
      :Object.keys(secretGeneration).filter(key=>key!=='neutralPlan').sort().join(',')!=='clientRequestId,expectedTaskUpdatedAt,ownerDecisionId,runId,workspaceId')
    || ['clientRequestId','ownerDecisionId','runId','workspaceId'].some(key=>!uuid.test(secretGeneration[key]??''))
    || typeof secretGeneration.expectedTaskUpdatedAt!=='string' || !Number.isFinite(Date.parse(secretGeneration.expectedTaskUpdatedAt))
    ||secretGeneration.neutralPlan!==undefined&&!assistantNeutralPrivateMetadata({metadataMode:'neutral',runId:secretGeneration.runId,...secretGeneration.neutralPlan})))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  const privateGeneration=secretGeneration===null?null:Object.freeze({...secretGeneration});
  let selectedCompanySecretId=null;
  if(secretSkill!==null && (!object(secretSkill)
    || Object.keys(secretSkill).sort().join(',')!=='companySlug,environmentVariable,fieldKey,grantId,runId,skill,workspaceId'
    || !/^[a-z0-9][a-z0-9_-]{0,159}$/u.test(secretSkill.companySlug??'')
    || ['grantId','runId','workspaceId'].some(key=>!uuid.test(secretSkill[key]??''))
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(secretSkill.fieldKey??'')
    || !/^TRELIO_[A-Z0-9_]{1,100}$/u.test(secretSkill.environmentVariable??'')
    || !object(secretSkill.skill)))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  const privateSkill=secretSkill===null?null:structuredClone(secretSkill);
  if(privateSkill){
    const {buildTrelioWorkspaceActionInvocation}=await import('./trelio-local-context.mjs');
    buildTrelioWorkspaceActionInvocation({schemaVersion:1,operation:'skill_run',parameters:privateSkill.skill});
    if(privateSkill.skill.companyId!==pass.companyId)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
    Object.freeze(privateSkill.skill.arguments);Object.freeze(privateSkill.skill);Object.freeze(privateSkill);
  }
  const accountSetup=skillAccountSetup===null?null:Object.freeze(normalizeAssistantSkillAccountSetupPlan(skillAccountSetup));
  if(accountSetup&&accountSetup.companyId!==pass.companyId)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  const setupStarted=performance.now();let setupBudget=accountSetup?.maximumDurationMs??0;
  let setupCommand=null,setupCreationUsed=false,setupProcessUsed=false,setupLeaseExpiresAt=0;
  const setupRemaining=()=>Math.floor(Math.min(setupBudget-(performance.now()-setupStarted),setupLeaseExpiresAt-now()));
  const skillRead=encryptedSkillRead===null?(accountSetup?validateAssistantEncryptedSkillRead({schemaVersion:1,nativeTool:'get_agent_skill',
    companyId:accountSetup.companyId,projectId:accountSetup.projectId,skillId:accountSetup.skillId,releaseId:accountSetup.releaseId,
    arguments:{sections:['instructions','execution']}},pass):null):validateAssistantEncryptedSkillRead(encryptedSkillRead,pass);
  let inspection=encryptedInspection===null?null:await validateAssistantEncryptedInspection({descriptor:encryptedInspection,identity,pass});
  if(materialWorkspaceId!==null && !uuid.test(materialWorkspaceId??''))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  if(workspaceRun!==null && (!object(workspaceRun) || Object.keys(workspaceRun).sort().join(',')!=='runId,workspaceId'
    || Object.values(workspaceRun).some(value=>!uuid.test(value??''))))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  const explicitRun=workspaceRun===null?null:Object.freeze({...workspaceRun});
  const privateRun=privateSkill??privateFill??privateGeneration;
  const ownRun=explicitRun??(privateRun?Object.freeze({runId:privateRun.runId,workspaceId:privateRun.workspaceId}):null);
  if([privateFill,privateGeneration,privateSkill,encryptedRead,inspection,explicitRun,materialWorkspaceId,skillRead].filter(Boolean).length>1)
    fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  let managedEncryptionDevice=null,inspectionEncryption=null,inspectionPayloads=null,encryptedSkillCompany=null,skillFingerprint=null;
  let lifecycle=null,lifecycleEncryption=null,attachmentSelection=null,attachmentEncryption=null;
  const assertIdentity=async()=>{
    const current=await host.readIdentity();
    if(!same(current,expectedIdentity) || !same(validateAssistantActivePass(await host.readActivePass(),identity),pass)) fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  };
  const assertLivePass=async signal=>{
    await assertIdentity();
    const live=await client.readTaskPass(locator,signal);
    if(live.state!=='leased' || ['passId','threadId','deliveryId','bindingId','bindingRevision'].some(key=>live[key]!==pass[key])
      || !Number.isFinite(Date.parse(live.leaseExpiresAt)) || Date.parse(live.leaseExpiresAt)<=now()) fail('ASSISTANT_PASS_REVIEW_REQUIRED');
    if(accountSetup)setupLeaseExpiresAt=setupLeaseExpiresAt?Math.min(setupLeaseExpiresAt,Date.parse(live.leaseExpiresAt)):Date.parse(live.leaseExpiresAt);
  };
  await assertIdentity();
  // This opaque handle cannot reveal a credential through native metadata or
  // an accidental caller serialization. Only prepareRequest resolves auth.
  const handle=Object.freeze(Object.create(null));
  return Object.freeze({
    kind:'digital_assistant',
    async prepareAttachmentRead(value){
      if([privateFill,privateGeneration,privateSkill,encryptedRead,inspection,ownRun,materialWorkspaceId,skillRead].some(Boolean))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      const selected=await validateAssistantEncryptedAttachment(value,identity.origin);
      if(selected.companyId!==pass.companyId||selected.taskId!==pass.taskId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      if(attachmentSelection&&JSON.stringify(attachmentSelection)!==JSON.stringify(selected))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      attachmentSelection=selected;await assertLivePass();
      const common=await import('./trelio-workspace.mjs');
      const opened=await common.ensureCompanyEncryptionContext({origin:identity.origin,requestOrigin:selected.requestOrigin,token:handle,
        company:{id:pass.companyId,slug:selected.companySlug},collectEncryptionKey:async()=>fail('ASSISTANT_WORKSPACE_PROFILE_DENIED')});
      if(!opened?.metadata?.enabled||opened.runtime.company.id!==pass.companyId||opened.runtime.viewer.userId!==identity.assistantId
        ||opened.runtime.scope.id!==selected.aad.scopeId||opened.runtime.scope.epoch!==selected.aad.scopeEpoch)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      if(attachmentEncryption&&(opened.runtime.device.id!==attachmentEncryption.runtime.device.id
        ||opened.runtime.envelope.id!==attachmentEncryption.runtime.envelope.id))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      await assertLivePass();attachmentEncryption=opened;return opened;
    },
    encryptedTaskRead:encryptedRead,
    companyEncryptionUserId:identity.assistantId,
    async readCompanyContentMode(signal){
      return (await readAssistantCompanyContentMode({identity,host,client,signal})).encryptionState;
    },
    async prepareSkillAccountSetupArguments(parameters,signal){
      const selected=normalizeAssistantSkillAccountSetupParameters(parameters);
      await assertLivePass(signal);
      if((await readAssistantCompanyContentMode({identity,host,client,signal})).encryptionState==='plain')return selected;
      const stored=await store.get({origin:identity.origin,kind:'company_encryption',id:pass.companyId,deviceId:identity.deviceId});
      if(stored?.assistantId!==identity.assistantId||stored.deviceId!==identity.deviceId||stored.companyId!==pass.companyId
        ||!/^[A-Za-z0-9_-]{40,128}$/u.test(stored.record?.fingerprint??''))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertLivePass(signal);return {...selected,encryptionFingerprint:stored.record.fingerprint};
    },
    async readHumanInputSkillSetupCommand(common){
      await assertLivePass();
      if(!accountSetup||setupCommand||setupRemaining()<1000)fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      const inspected=await inspectAssistantSkillAccountSetupForOwner({origin:identity.origin,companyId:pass.companyId,
        fields:{skillId:accountSetup.skillId,projectId:accountSetup.projectId,releaseId:accountSetup.releaseId,
          accountId:accountSetup.accountId,commandId:accountSetup.commandId},common});
      if(inspected.artifactId!==accountSetup.artifactId||inspected.packageSha256!==accountSetup.packageSha256
        ||accountSetup.arguments&&accountSetup.maximumDurationMs>(inspected.command.maximumDurationMs??600000)
        ||accountSetup.arguments&&JSON.stringify(accountSetup.arguments)!==JSON.stringify(inspected.command.arguments))fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      if(accountSetup.inspectedCommand&&common.parseAgentEncryptedContentReference(accountSetup.inspectedCommand)?.field!=='skill_setup_command_json')
        fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      setupBudget=Math.min(setupBudget,inspected.command.maximumDurationMs??600000);
      setupCommand=Object.freeze({...inspected.command,arguments:Object.freeze([...inspected.command.arguments])});
      const record=await store.get({origin:identity.origin,kind:'runtime',id:pass.passId});
      if(record?.ended||!UUID.test(record?.state?.runtimeSessionId??''))fail('ASSISTANT_WORKSPACE_SESSION_REQUIRED');
      await assertLivePass();
      return {...accountSetup,arguments:[...setupCommand.arguments],runtimeSessionId:record.state.runtimeSessionId};
    },
    async prepareHumanInputSkillSetupAccount({artifact,runtimeDirectory,executionContext,humanInputCommand}){
      if(!accountSetup||!setupCommand||!same(setupCommand,humanInputCommand)||setupCreationUsed
        ||artifact.id!==accountSetup.artifactId||executionContext.companyId!==accountSetup.companyId
        ||executionContext.localIdentity?.memberId!==accountSetup.memberId
        ||(executionContext.localIdentity?.connectionId??null)!==accountSetup.connectionId)fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      await assertLivePass();
      const common=await import('./trelio-workspace.mjs');
      const prepare=async runtimeArguments=>{
        let output;const result=await common.prepareSkillAccount({origin:identity.origin,artifact,runtimeDirectory,executionContext,
          runtimeArguments,output:value=>{if(output)fail('ASSISTANT_SKILL_SETUP_REQUIRED');output=value;}});
        if(!result.handled||!output?.ok||!Number.isSafeInteger(output.revision)||!Array.isArray(output.accounts))fail('ASSISTANT_SKILL_SETUP_REQUIRED');
        await assertLivePass();return output;
      };
      const listed=await prepare(['account','list']);
      if(listed.accounts.some(row=>row.id===accountSetup.accountId&&row.bound===true)){
        // A new exact owner approval may reopen this device/company's already
        // bound managed account. Hidden/unbound and human entries never appear
        // here; no rebind, import, metadata rewrite or duplicate is attempted.
        setupCreationUsed=true;return;
      }
      // Creation remains the SAME atomic catalogue intent. A pre-existing
      // human/unbound entry or different native request is never adopted.
      const created=await prepare(['account','create','--id',accountSetup.accountId,'--name',accountSetup.skillId,
        '--expected-revision',String(listed.revision)]);
      if(created.id!==accountSetup.accountId||!created.accounts.some(row=>row.id===accountSetup.accountId&&row.bound))fail('ASSISTANT_SKILL_SETUP_REQUIRED');
    },
    async authorizeAccountCreation(command,context){
      await assertLivePass();
      if(!accountSetup||!setupCommand||setupCreationUsed||setupProcessUsed||setupRemaining()<1000
        ||command.operation!=='create'||command.id!==accountSetup.accountId||command.name!==accountSetup.skillId||(command.comment??'')!==''
        ||context.companyId!==accountSetup.companyId||(context.projectId??null)!==accountSetup.projectId||context.skillId!==accountSetup.skillId
        ||context.memberId!==accountSetup.memberId||(context.connectionId??null)!==accountSetup.connectionId)fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      setupCreationUsed=true;return Object.freeze({creationRequestId:accountSetup.requestId});
    },
    async authorizeHumanInputSkillSetup({artifact,executionContext,runtimeArguments}){
      await assertLivePass();
      if(!accountSetup||!setupCommand||!setupCreationUsed||setupProcessUsed||setupRemaining()<1000
        ||artifact.id!==accountSetup.artifactId||executionContext.releaseId!==accountSetup.releaseId
        ||executionContext.account?.id!==accountSetup.accountId||executionContext.localIdentity?.memberId!==accountSetup.memberId
        ||JSON.stringify(runtimeArguments)!==JSON.stringify(setupCommand.arguments))fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      setupProcessUsed=true;return setupRemaining();
    },
    async assertHumanInputSkillSetupCurrent(){
      await assertLivePass();
      if(!accountSetup||!setupProcessUsed||setupRemaining()<1000)fail('ASSISTANT_SKILL_SETUP_REQUIRED');
    },
    async prepareSkillConsentArguments(parameters,signal){
      const selected=normalizeAssistantSkillConsentParameters(parameters);
      await assertLivePass(signal);
      const stored=await store.get({origin:identity.origin,kind:'company_encryption',id:pass.companyId,deviceId:identity.deviceId});
      if(stored?.assistantId!==identity.assistantId||stored.deviceId!==identity.deviceId||stored.companyId!==pass.companyId
        ||!/^[A-Za-z0-9_-]{40,128}$/u.test(stored.record?.fingerprint??''))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertLivePass(signal);
      return {...selected,encryptionFingerprint:stored.record.fingerprint};
    },
    async preparePrivateSkillArguments(parameters,signal){
      // No provider argv is sent to obtain a native refusal. Only an existing
      // signed command ID and public structural refs can reach encrypted MCP;
      // the native parser expands its immutable public recipe afterwards.
      if(!object(parameters)||Object.keys(parameters).sort().join(',')!=='environmentVariable,fieldKey,runId,secretId,skill'
        ||!uuid.test(parameters.secretId??'')||!uuid.test(parameters.runId??'')
        ||!/^[a-z][a-z0-9_]{0,63}$/u.test(parameters.fieldKey??'')
        ||!/^TRELIO_[A-Z0-9_]{1,100}$/u.test(parameters.environmentVariable??'')||!object(parameters.skill))fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      const skill=parameters.skill,keys=Object.keys(skill).sort().join(',');
      if(!['commandId,companyId,projectId,releaseId,runtimeSessionId,skillId','commandId,companyId,releaseId,runtimeSessionId,skillId'].includes(keys)
        ||skill.companyId!==pass.companyId||!uuid.test(skill.releaseId??'')||!uuid.test(skill.runtimeSessionId??'')
        ||skill.projectId!==undefined&&!uuid.test(skill.projectId??'')||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.skillId??'')
        ||skill.skillId.length>120||!/^[a-z][a-z0-9-]{0,47}$/u.test(skill.commandId??''))fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      await assertLivePass(signal);
      const stored=await store.get({origin:identity.origin,kind:'company_encryption',id:pass.companyId,deviceId:identity.deviceId});
      if(stored?.assistantId!==identity.assistantId||stored.deviceId!==identity.deviceId||stored.companyId!==pass.companyId
        ||!/^[A-Za-z0-9_-]{40,128}$/u.test(stored.record?.fingerprint??''))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertLivePass(signal);
      return {...structuredClone(parameters),encryptionFingerprint:stored.record.fingerprint};
    },
    async preparePrivateBrowserArguments(args,signal){
      const {normalizeSecretBrowserGrantTarget,normalizeSecretBrowserFieldSelector}=await import('./trelio-secret-browser.mjs');
      const crypto=await import('./trelio-company-encryption.mjs');
      const {resolveAssistantCompanyEncryptionDevice}=await import('./trelio-assistant-private.mjs');
      const current=()=>assertLivePass(signal),parameters=args.parameters;
      if(!object(parameters)||Object.hasOwn(parameters,'encryptedPlan'))fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      let selected,first;
      if(args.operation==='secret_browser_prepare'){
        if(Object.keys(parameters).sort().join(',')!=='runId,secretId,steps'||!uuid.test(parameters.runId??'')||!uuid.test(parameters.secretId??'')
          ||!Array.isArray(parameters.steps)||parameters.steps.length<1||parameters.steps.length>10)fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
        const seen=new Set();
        const steps=parameters.steps.map((step,index)=>{
          if(!object(step)||Object.keys(step).some(key=>!['targetUrl','fields','activationSelector','submitSelector'].includes(key))
            ||!Array.isArray(step.fields)||!step.fields.length||step.fields.length>50
            ||index<parameters.steps.length-1&&step.submitSelector===undefined)fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
          const {targetUrl,...target}=normalizeSecretBrowserGrantTarget(step.targetUrl);first??=targetUrl;
          const fields=step.fields.map(field=>{
            if(!object(field)||Object.keys(field).sort().join(',')!=='fieldKey,selector'
              ||!/^[a-z][a-z0-9_]{0,63}$/u.test(field.fieldKey??'')||seen.has(field.fieldKey))fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
            seen.add(field.fieldKey);return {fieldKey:field.fieldKey,selector:normalizeSecretBrowserFieldSelector(field.selector)};
          });
          return {...target,fields,...(step.activationSelector!==undefined?{activationSelector:normalizeSecretBrowserFieldSelector(step.activationSelector)}:{}),
            ...(step.submitSelector!==undefined?{submitSelector:normalizeSecretBrowserFieldSelector(step.submitSelector)}:{})};
        });
        selected={schemaVersion:1,operation:args.operation,parameters:{secretId:parameters.secretId,runId:parameters.runId,steps}};
      }else if(args.operation==='secret_browser_fill'){
        if(Object.keys(parameters).sort().join(',')!=='grantId,targetUrl'||!uuid.test(parameters.grantId??'')
          ||!object(args.runIdentity)||Object.keys(args.runIdentity).sort().join(',')!=='runId,workspaceId'
          ||Object.values(args.runIdentity).some(value=>!uuid.test(value??'')))fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
        const {targetUrl,...target}=normalizeSecretBrowserGrantTarget(parameters.targetUrl);first=targetUrl;
        selected={schemaVersion:1,operation:args.operation,runIdentity:structuredClone(args.runIdentity),parameters:{grantId:parameters.grantId,...target}};
      }else fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      await current();
      const device=await resolveAssistantCompanyEncryptionDevice({identity,companyId:pass.companyId,store,lockDirectory,
        assertCurrent:current,allowCreate:false,lock});
      const signature=await crypto.signCompanyEncryptionRecord(device.privateKeys.signingPrivateKey,{protocol:'assistant-managed-content/v1',
        phase:'publication',companyId:pass.companyId,target:{kind:'task',pass:locator},nativeTool:'continue_assistant_workspace_action',arguments:selected});
      await current();
      return {parameters:{...selected.parameters,encryptedPlan:{schemaVersion:1,fingerprint:device.fingerprint,signature}},
        targetUrl:first,target:selected.parameters.steps?.[0]??selected.parameters};
    },
    async preparePrivateCardArguments(args,signal){
      const p=args.parameters,current=()=>assertLivePass(signal);
      if(!object(p)||typeof p.expectedTaskUpdatedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(p.expectedTaskUpdatedAt)||!Number.isFinite(Date.parse(p.expectedTaskUpdatedAt))
        ||['clientRequestId','ownerDecisionId'].some(key=>!uuid.test(p[key]??'')))fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      if(args.operation==='secret_create'){
        if(Object.keys(p).sort().join(',')!=='clientRequestId,expectedTaskUpdatedAt,metadata,ownerDecisionId'
          ||!assistantNeutralPrivateMetadata(p.metadata)||p.metadata.runId!==undefined)fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      }else if(args.operation==='secret_generate'){
        if(Object.keys(p).sort().join(',')!=='clientRequestId,expectedTaskUpdatedAt,neutralPlan,ownerDecisionId,runId'
          ||!assistantNeutralPrivateMetadata({metadataMode:'neutral',runId:p.runId,...p.neutralPlan})
          ||Object.keys(p.neutralPlan).sort().join(',')!=='cardType,generatedFields'
          ||!object(args.runIdentity)||Object.keys(args.runIdentity).sort().join(',')!=='runId,workspaceId'
          ||args.runIdentity.runId!==p.runId||Object.values(args.runIdentity).some(value=>!uuid.test(value??'')))fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      }else if(args.operation==='secret_company_create'){
        if(Object.keys(p).sort().join(',')!=='clientRequestId,expectedTaskUpdatedAt,holder,ownerDecisionId,plan,runId'
          ||p.holder!=='company'||!assistantNeutralCompanySecret(p.plan)||p.plan.runId!==p.runId
          ||!object(args.runIdentity)||Object.keys(args.runIdentity).sort().join(',')!=='runId,workspaceId'
          ||args.runIdentity.runId!==p.runId||Object.values(args.runIdentity).some(value=>!uuid.test(value??'')))fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      }else fail('ASSISTANT_ENCRYPTED_CONTENT_REQUIRED');
      const {resolveAssistantCompanyEncryptionDevice}=await import('./trelio-assistant-private.mjs');
      await current();const device=await resolveAssistantCompanyEncryptionDevice({identity,companyId:pass.companyId,store,
        lockDirectory,assertCurrent:current,allowCreate:false,lock});await current();
      return {...structuredClone(p),encryptionFingerprint:device.fingerprint};
    },
    async prepareWorkspaceMaterial(){
      if(!materialWorkspaceId)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertLivePass();
      const common=await import('./trelio-workspace.mjs');
      const routing=await common.resolveBridgeDataPlaneRouting({origin:identity.origin,token:handle,workspaceId:materialWorkspaceId});
      if(routing.company.id!==pass.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      if(routing.encryptionState==='plain')return null;
      if(routing.encryptionState!=='encrypted')fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      // Only the authenticated native routing response selects this accepted
      // read cell. A model's Workspace UUID never chooses another company,
      // recipient, history route or data-plane origin.
      inspection=await validateAssistantEncryptedInspection({descriptor:{schemaVersion:1,companyId:pass.companyId,
        companySlug:routing.company.slug,workspaceId:materialWorkspaceId,requestOrigin:routing.requestOrigin},identity,pass});
      await assertLivePass();
      return inspection;
    },
    async prepareWorkspaceRun(){
      if(!ownRun)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      lifecycle=null;lifecycleEncryption=null;inspectionPayloads=null;
      await assertLivePass();
      const common=await import('./trelio-workspace.mjs');
      const routing=await common.resolveBridgeDataPlaneRouting({origin:identity.origin,token:handle,workspaceId:ownRun.workspaceId});
      if(routing.company.id!==pass.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      if(routing.encryptionState==='plain')return null;
      if(routing.encryptionState!=='encrypted')fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      lifecycle=Object.freeze({...routing,workspaceId:ownRun.workspaceId});
      const opened=await common.ensureCompanyEncryptionContext({origin:identity.origin,requestOrigin:routing.requestOrigin,token:handle,
        company:routing.company,collectEncryptionKey:async()=>fail('ASSISTANT_WORKSPACE_PROFILE_DENIED')});
      if(!opened || opened.runtime.company.id!==pass.companyId || opened.runtime.viewer?.userId!==identity.assistantId
        || opened.runtime.device?.fingerprint!==managedEncryptionDevice?.fingerprint || opened.runtime.accessState!=='ready')
        fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      lifecycleEncryption=opened;inspectionPayloads=new Map();
      await assertLivePass();
      return {...opened,requestOrigin:routing.requestOrigin};
    },
    async readWorkspaceJsonResponse(response){
      if(!lifecycleEncryption)return response.json();
      const bundle=await readAssistantEncryptedSnapshotResponse(response,await import('./trelio-workspace.mjs'));
      if(!object(bundle) || !Object.hasOwn(bundle,'encryptedPayloads'))return bundle;
      await assertLivePass();
      const opened=readAssistantEncryptedSnapshotBundle(bundle,lifecycleEncryption,pass.companyId);
      const snapshot=opened.context;
      const run=snapshot.run??(snapshot.id===ownRun.runId?snapshot:null);
      if((run ? run.id!==ownRun.runId || run.workspaceId!==ownRun.workspaceId
        : snapshot.workspace?.id!==ownRun.workspaceId || snapshot.workspace?.scopeType!=='task'
          || snapshot.workspace?.scopeKey!==`task:${pass.taskId}`)
        || snapshot.company && snapshot.company.id!==pass.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      for(const [id,payload] of opened.payloads){
        const previous=inspectionPayloads.get(id);
        if(previous && JSON.stringify(previous)!==JSON.stringify(payload))fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
        inspectionPayloads.set(id,payload);
      }
      if(inspectionPayloads.size>4096)fail('ASSISTANT_MCP_INVALID_RESPONSE');
      return opened.context;
    },
    async assertEncryptedTaskReadCurrent(signal){
      if(!encryptedRead)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertLivePass(signal);
    },
    async resolveCompanyEncryptionDevice({origin:requestOrigin,companyId}){
      // Local keys and their company envelopes belong to this exact managed
      // device, never the ambient human's remembered encryption identity. The
      // common native HTTP policy still decides whether encrypted transport is
      // available; this private provider alone does not open any server route.
      if(requestOrigin!==identity.origin || companyId!==pass.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      const {resolveAssistantCompanyEncryptionDevice}=await import('./trelio-assistant-private.mjs');
      managedEncryptionDevice=await resolveAssistantCompanyEncryptionDevice({identity,companyId,store,
        lockDirectory,assertCurrent:()=>assertLivePass(),allowCreate:!encryptedSkillCompany&&!privateRun&&!attachmentSelection,lock});
      return managedEncryptionDevice;
    },
    async collectSkillRuntimeConsent({companyId}){
      await assertLivePass();
      if(companyId!==pass.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      // The owner reviews the native exact publication in Trelio. Neither a
      // model reply nor a local human-session UI may impersonate that decision.
      fail('ASSISTANT_SKILL_OWNER_CONSENT_REQUIRED');
    },
    async prepareSkillRuntimeConsent({companyId}){
      await assertLivePass();
      if(companyId!==pass.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      // Pending encrypted packages need the native selected manifest/preview
      // adapter before they can become an owner question or executable cache.
      fail('ASSISTANT_SKILL_OWNER_CONSENT_REQUIRED');
    },
    async hydrateSkillRuntimeResolution(raw,common,signal){
      if(accountSetup&&(raw?.artifact?.id!==accountSetup.artifactId||raw.artifact.packageSha256!==accountSetup.packageSha256
        ||raw.releaseId!==accountSetup.releaseId||raw.artifact.skillId!==accountSetup.skillId
        ||raw.localIdentity?.memberId!==accountSetup.memberId||(raw.localIdentity?.connectionId??null)!==accountSetup.connectionId
        ||(raw.companyConnection?createHash('sha256').update(canonicalJson(raw.companyConnection.config)).digest('hex'):null)!==accountSetup.connectionConfigSha256))
        fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      return hydrateAssistantEncryptedSkill({raw,bundle:raw?.assistantEncryption,common,origin:identity.origin,token:handle,
        companyId:pass.companyId,assistantId:identity.assistantId,fingerprint:skillFingerprint,assertCurrent:()=>assertLivePass(signal),signal,taskRuntimeMetadata:true,
        openCompany:async company=>{
          encryptedSkillCompany={id:company.id,slug:company.slug};
          return common.ensureCompanyEncryptionContext({origin:identity.origin,token:handle,company:encryptedSkillCompany,
            collectEncryptionKey:async()=>fail('ASSISTANT_WORKSPACE_PROFILE_DENIED')});
        }});
    },
    async prepareWorkspaceInspection({origin,workspaceId,requestOrigin}){
      if(!inspection)return null;
      if(origin!==identity.origin || workspaceId!==inspection.workspaceId || requestOrigin!==inspection.requestOrigin)
        fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      await assertLivePass();inspectionPayloads=null;
      const common=await import('./trelio-workspace.mjs');
      const opened=await common.ensureCompanyEncryptionContext({origin,requestOrigin,token:handle,
        company:{id:pass.companyId,slug:inspection.companySlug},collectEncryptionKey:async()=>fail('ASSISTANT_WORKSPACE_PROFILE_DENIED')});
      if(!opened || opened.runtime.company.id!==pass.companyId || opened.runtime.viewer?.userId!==identity.assistantId
        || opened.runtime.device?.fingerprint!==managedEncryptionDevice?.fingerprint || !uuid.test(opened.runtime.device?.id??'')
        || opened.runtime.accessState!=='ready' || opened.runtime.envelope?.recipientId!==opened.runtime.device.id)
        fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      await assertLivePass();inspectionEncryption=opened;
      return opened;
    },
    async unwrapWorkspaceInspectionSnapshot(bundle){
      if(!inspection)return bundle;
      await assertLivePass();
      if(!inspectionEncryption)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      const opened=readAssistantEncryptedSnapshotBundle(bundle,inspectionEncryption,pass.companyId);
      if(opened.context.workspace?.id!==inspection.workspaceId || opened.context.company?.id!==pass.companyId
        || opened.context.workspace?.scopeType!=='task' || opened.context.workspace?.scopeKey!==`task:${pass.taskId}`
        || opened.context.company?.slug!==inspection.companySlug || opened.context.encryption?.state!=='encrypted')
        fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      inspectionPayloads=opened.payloads;
      return opened.context;
    },
    async readWorkspaceInspectionResponse(response){
      if(!inspection)return response.json();
      return readAssistantEncryptedSnapshotResponse(response,await import('./trelio-workspace.mjs'));
    },
    async resolveCompanyEncryptedPayloads({entityIds:ids,companyId,scopeId,scopeEpoch}){
      await assertLivePass();
      const opened=inspectionEncryption??lifecycleEncryption;
      if(!opened || !inspectionPayloads || !Array.isArray(ids) || ids.length>250
        || companyId!==pass.companyId || scopeId!==opened.runtime.scope.id
        || scopeEpoch!==opened.runtime.scope.epoch
        || ids.some(id=>!inspectionPayloads.has(id)))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      return {payloads:ids.map(id=>inspectionPayloads.get(id))};
    },
    async assertWorkspaceInspectionCurrent(){
      if(!inspection)return;
      await assertLivePass();
      const common=await import('./trelio-workspace.mjs');
      const current=await common.ensureCompanyEncryptionContext({origin:identity.origin,requestOrigin:inspection.requestOrigin,token:handle,
        company:{id:pass.companyId,slug:inspection.companySlug},collectEncryptionKey:async()=>fail('ASSISTANT_WORKSPACE_PROFILE_DENIED')});
      if(!current || current.runtime.envelope?.id!==inspectionEncryption?.runtime.envelope?.id
        || current.runtime.device?.id!==inspectionEncryption?.runtime.device?.id
        || current.runtime.scope?.id!==inspectionEncryption?.runtime.scope?.id
        || current.runtime.scope?.epoch!==inspectionEncryption?.runtime.scope?.epoch)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      await assertLivePass();
    },
    async prepareSkillBodyRead(input){
      await assertIdentity();
      if(sourceReads)return sourceReads.prepare(input);
      if(['telegram-mtproto','email-imap-smtp','max-web'].includes(input.artifact?.skillId)&&input.runtimeArguments?.[0]==='read-reference')fail('ASSISTANT_SOURCE_READ_REQUIRED');
      return null;
    },
    async commitSkillBodyRead(ticket,result){
      if(ticket===null)return;
      await assertIdentity();
      if(!sourceReads)fail('ASSISTANT_SOURCE_READ_REQUIRED');
      await sourceReads.commit(ticket,result);
    },
    async resolveSkillRuntimeChat({companyId,runtimeSessionId}){
      await assertIdentity();
      if(companyId!==pass.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      const record=await store.get({origin:identity.origin,kind:'runtime',id:pass.passId});
      if(!uuid.test(runtimeSessionId??'') || record?.schemaVersion!==1 || record?.ended
        || record?.state?.runtimeSessionId!==runtimeSessionId || !Number.isFinite(Date.parse(record.state.expiresAt))
        || Date.parse(record.state.expiresAt)<=now())fail('ASSISTANT_WORKSPACE_SESSION_REQUIRED');
      return pass.threadId;
    },
    // The SAME remote credential engine keeps a managed namespace even on
    // macOS/libsecret, where the physical file path alone is not a vault key.
    remoteMcpCredentialNamespace: `assistant:${identity.assistantId}:${identity.deviceId}`,
    resolveRemoteMcpCredentialDirectory(selected, configDirectory) {
      if (!remoteMcp || selected.companyId !== pass.companyId || selected.companyId !== remoteMcp.input.companyId
        || selected.skillId !== remoteMcp.input.skillId || (selected.projectId ?? null) !== (remoteMcp.input.projectId ?? null))
        fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      return path.join(assistantSkillCatalogueDirectory(configDirectory, identity), selected.skillId,
        id(selected.companyId), id(selected.memberId));
    },
    async assertRemoteMcpCurrent(signal) { if (!remoteMcp) fail('ASSISTANT_WORKSPACE_PROFILE_DENIED'); await assertLivePass(signal); },
    async authorizeRemoteMcpWrite(fresh, name, args, raw, { signal } = {}) {
      if (!remoteMcp || remoteMcp.consumed || typeof remoteMcp.authorize !== 'function'
        || fresh.releaseId !== remoteMcp.input.releaseId || fresh.localIdentity.companyId !== pass.companyId
        || fresh.localIdentity.skillId !== remoteMcp.input.skillId || name !== remoteMcp.input.toolName
        || JSON.stringify(args) !== JSON.stringify(remoteMcp.input.arguments)
        || raw.ownerDecisionId !== remoteMcp.input.ownerDecisionId || raw.clientRequestId !== remoteMcp.input.clientRequestId)
        fail('ASSISTANT_REMOTE_MCP_WRITE_DENIED');
      await assertLivePass(signal);
      remoteMcp.consumed = true; // fence BEFORE sending; never replay unknown admission
      const result = await remoteMcp.authorize();
      const receipt = result?.structuredContent;
      if (result?.isError || receipt?.schemaVersion !== 1 || !UUID.test(receipt.receiptId ?? '')
        || receipt.ownerDecisionId !== remoteMcp.input.ownerDecisionId || receipt.attemptAdmitted !== true
        || receipt.providerOutcome !== 'not_observed' || receipt.replayAllowed !== false) fail('ASSISTANT_REMOTE_MCP_WRITE_DENIED');
      await assertLivePass(signal);
    },
    async resolveSkillCatalogueDirectory(configDirectory){
      await assertIdentity();
      return assistantSkillCatalogueDirectory(configDirectory,identity);
    },
    async selectCompanySecretContext(context){
      if(!companyGeneration||!privateGeneration||!object(context)||context.completed!==false
        ||!uuid.test(context.secretId??'')||context.runId!==privateGeneration.runId
        ||['companyId','taskId'].some(key=>context[key]!==pass[key])
        ||context.assistantUserId!==identity.assistantId||context.deviceId!==identity.deviceId
        ||selectedCompanySecretId&&selectedCompanySecretId!==context.secretId)fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertLivePass();selectedCompanySecretId=context.secretId;
    },
    async withSecretGenerationKey(action){
      if(!privateGeneration || typeof action!=='function')fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertLivePass();
      // SAME protected device credential, never the opaque requireToken handle
      // or ambient human OAuth. The generator/fingerprint use their distinct
      // domain and full reviewed binding. No extra key/vault slot is created.
      return withCredential(async credential=>{
        const key=Buffer.from(credential,'utf8');
        try {const result=await action(key);await assertLivePass();return result;}
        finally {key.fill(0);}
      });
    },
    async authorizePrivateSkillCheckout({grantId,runId,commandArguments}){
      if(!privateSkill || privateSkill.grantId!==grantId || privateSkill.runId!==runId)
        fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      const {buildTrelioWorkspaceActionInvocation}=await import('./trelio-local-context.mjs');
      const expected=buildTrelioWorkspaceActionInvocation({schemaVersion:1,operation:'skill_run',parameters:privateSkill.skill});
      if(JSON.stringify(commandArguments)!==JSON.stringify(['trelio-workspace',...expected.argumentsList]))
        fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertLivePass();
      return Object.freeze({fieldKey:privateSkill.fieldKey,environmentVariable:privateSkill.environmentVariable});
    },
    async resolveSecretBrowserStorage({configDirectory,grantId,runId}){
      if(!privateFill || privateFill.grantId!==grantId || privateFill.runId!==runId
        || !path.isAbsolute(configDirectory??''))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertIdentity();
      // Reuse the SAME native/owned browser implementation, but never borrow
      // its ordinary human fallback profile or another assistant/task's state.
      const root=path.join(assistantTaskStorageDirectory(configDirectory,{...identity,companyId:pass.companyId,taskId:pass.taskId}),'secret-browser');
      return {directory:path.join(root,'native'),profileDirectory:path.join(root,'profile')};
    },
    async resolveInspectionDirectory(configDirectory){
      // Accepted files are shared company content, but the accompanying
      // personal profile belongs to this exact assistant/device/task. Never
      // overwrite the ordinary user's or another assistant's inspection cache.
      if(!path.isAbsolute(configDirectory??''))fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      await assertIdentity();
      return path.join(assistantTaskStorageDirectory(configDirectory,{...identity,companyId:pass.companyId,taskId:pass.taskId}),'inspections');
    },
    async requireToken(requestOrigin){
      if(requestOrigin!==identity.origin)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      await assertIdentity();return handle;
    },
    async prepareRequest({origin:requestOrigin,token,pathname,options,buildHeaders}){
      // Validate destination/method before touching private state or observing
      // the live pass. No redirect, encoded separator or native secret/admin
      // path can turn this profile into a bearer-forwarding primitive.
      if(![identity.origin,encryptedRead?.requestOrigin,inspection?.requestOrigin,lifecycle?.requestOrigin,attachmentSelection?.requestOrigin].includes(requestOrigin) || token!==handle || typeof pathname!=='string' || pathname.length>16_384
        || typeof buildHeaders!=='function') fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      let url;try{url=new URL(pathname,requestOrigin);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
      if(url.origin!==requestOrigin || url.hash || url.pathname!==pathname.split('?')[0]) fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      const method=String(options.method??'GET').toUpperCase();
      let rewritten,route,encryptionRuntime=false;
      if((encryptedRead || privateSkill || inspection || lifecycle || encryptedSkillCompany || attachmentSelection) && method==='GET'
        && (requestOrigin===identity.origin || inspection && requestOrigin===inspection.requestOrigin || lifecycle && requestOrigin===lifecycle.requestOrigin || attachmentSelection&&requestOrigin===attachmentSelection.requestOrigin)
        && url.pathname==='/api/agent-workspaces/encryption/runtime' && options.body===undefined){
        const keys=[...url.searchParams.keys()];
        if(new Set(keys).size!==keys.length || keys.some(key=>!['companySlug','fingerprint'].includes(key))
          || url.searchParams.get('companySlug')!==(encryptedRead?.companySlug??privateSkill?.companySlug??inspection?.companySlug??lifecycle?.company.slug??encryptedSkillCompany?.slug??attachmentSelection?.companySlug)
          || privateSkill && !lifecycle && url.searchParams.has('fingerprint')
          || url.searchParams.has('fingerprint') && url.searchParams.get('fingerprint')!==managedEncryptionDevice?.fingerprint)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        // SAME native registry reader. A private authentication invocation may
        // discover only its server-bound company's current encryption state.
        // Common withRun compares the exact company and own managed recipient
        // before protected use; registration/grants/key fallback stay closed.
        rewritten='/api/digital-assistants/runtime/encryption/runtime';
        // The SAME managed registry is a fixed canonical control-plane route.
        // Ciphertext Workspace snapshots/bundles remain on the server-selected
        // data origin; this initial mapping is never an error/fallback retry.
        if(inspection || lifecycle || attachmentSelection)url=new URL(url.pathname+url.search,identity.origin);
        route={proofTool:'assistant_workspace_data_plane_read'};encryptionRuntime=true;
      }else if(attachmentSelection&&url.pathname===nativePrefix+`/scopes/task/${pass.taskId}/attachments/${attachmentSelection.attachmentId}`){
        if(requestOrigin!==attachmentSelection.requestOrigin||method!=='GET'||options.body!==undefined||!attachmentEncryption
          ||[...url.searchParams.keys()].join(',')!=='revision'||url.searchParams.get('revision')!==attachmentSelection.revision)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        rewritten=assistantPrefix+url.pathname.slice(nativePrefix.length);route={proofTool:'assistant_workspace_data_plane_read'};
      }else if(attachmentSelection){
        fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      }else if(companyGeneration&&privateGeneration&&requestOrigin===(lifecycle?.requestOrigin??identity.origin)
        &&(url.pathname==='/api/agent-secrets/generated-save-context'||selectedCompanySecretId&&url.pathname===`/api/agent-secrets/secrets/${selectedCompanySecretId}/value-from-bridge`)){
        const {workspaceId:_workspace,...expected}=privateGeneration;
        if(method==='GET'&&url.pathname==='/api/agent-secrets/generated-save-context'&&options.body===undefined
          &&[...url.searchParams.keys()].length===Object.keys(expected).length&&new Set(url.searchParams.keys()).size===Object.keys(expected).length
          &&Object.entries(expected).every(([key,value])=>url.searchParams.get(key)===(key==='plan'?JSON.stringify(value):value))){
          route={proofTool:'assistant_secret_generate_context'};
        }else if(method==='PUT'&&!url.search&&selectedCompanySecretId){
          let input;try{input=JSON.parse(options.body);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
          const begin=input?.stage==='begin';
          const allowed=Object.keys(expected).concat(['secretId','stage'],begin?[]:['expectedCurrentVersion','requestFingerprint','companySlug','contentProtection','values','fieldKeys','name','publicDescription','templateType','fields','encryptedPayloads']);
          if(!object(input)||Object.keys(input).some(key=>!allowed.includes(key))||input.secretId!==selectedCompanySecretId
            ||!Object.entries(expected).every(([key,value])=>(key==='plan'?JSON.stringify(input[key]):input[key])===(key==='plan'?JSON.stringify(value):value))
            ||begin&&privateGeneration.plan.valueSource!=='protected_input'
            ||!begin&&(input.stage!=='save'||input.expectedCurrentVersion!==0||!/^[a-f0-9]{64}$/u.test(input.requestFingerprint??'')
              ||!object(input.values)||!Array.isArray(input.fields)||!Array.isArray(input.fieldKeys)))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          route={proofTool:'assistant_secret_generate_write'};
        }else fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        rewritten=url.pathname;if(lifecycle)url=new URL(url.pathname+url.search,identity.origin);
      }else if(privateGeneration && requestOrigin===(lifecycle?.requestOrigin??identity.origin)
        && (url.pathname==='/api/agent-secrets/generated-save-context'
          || url.pathname===`/api/agent-secrets/secrets/${privateGeneration.clientRequestId}/value-from-bridge`)){
        const expected={clientRequestId:privateGeneration.clientRequestId,ownerDecisionId:privateGeneration.ownerDecisionId,
          expectedTaskUpdatedAt:privateGeneration.expectedTaskUpdatedAt,runId:privateGeneration.runId,
          ...(privateGeneration.neutralPlan?{neutralPlan:JSON.stringify(privateGeneration.neutralPlan)}:{})};
        if(method==='GET' && url.pathname==='/api/agent-secrets/generated-save-context' && options.body===undefined
          && [...url.searchParams.keys()].length===Object.keys(expected).length && new Set(url.searchParams.keys()).size===Object.keys(expected).length
          && Object.entries(expected).every(([key,value])=>url.searchParams.get(key)===value)){
          route={proofTool:'assistant_secret_generate_context'};
        }else if(method==='PUT' && !url.search && url.pathname.endsWith('/value-from-bridge')){
          let input;try{input=JSON.parse(options.body);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
          if(!object(input) || Object.keys(input).filter(key=>key!=='neutralPlan').sort().join(',')!=='clientRequestId,expectedCurrentVersion,expectedTaskUpdatedAt,ownerDecisionId,requestFingerprint,runId,values'
            || !Object.entries(expected).every(([key,value])=>(key==='neutralPlan'?JSON.stringify(input[key]):input[key])===value)
            ||!privateGeneration.neutralPlan&&input.neutralPlan!==undefined || input.expectedCurrentVersion!==0
            || !/^[a-f0-9]{64}$/u.test(input.requestFingerprint??'') || !object(input.values)
            || Object.keys(input.values).length<1 || Object.keys(input.values).length>50
            || Object.entries(input.values).some(([key,value])=>!/^[a-z][a-z0-9_]{0,63}$/u.test(key)
              || typeof value!=='string' || value.length<16 || value.length>128))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          route={proofTool:'assistant_secret_generate_write'};
        }else fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        rewritten=url.pathname;
        if(lifecycle)url=new URL(url.pathname+url.search,identity.origin);
      }else if(privateFill && requestOrigin===(lifecycle?.requestOrigin??identity.origin)
        && url.pathname.startsWith(`/api/agent-secrets/checkout-grants/${privateFill.grantId}/`)){
        const base=`/api/agent-secrets/checkout-grants/${privateFill.grantId}`;
        if(method==='GET' && url.pathname===base+'/browser-fill-context' && options.body===undefined
          && [...url.searchParams.keys()].length===1 && url.searchParams.get('runId')===privateFill.runId){
          route={proofTool:'assistant_secret_browser_context'};
        }else if(method==='POST' && !url.search && ['/consume','/browser-fill-outcome'].some(suffix=>url.pathname===base+suffix)){
          let input;try{input=JSON.parse(options.body);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
          const outcome=url.pathname.endsWith('/browser-fill-outcome');
          if(!object(input) || input.runId!==privateFill.runId
            || Object.keys(input).some(key=>!(outcome?['runId','outcome','reasonCode']:['runId']).includes(key))
            || outcome && (typeof input.outcome!=='string' || input.outcome.length>32
              || input.reasonCode!==undefined && (typeof input.reasonCode!=='string' || input.reasonCode.length>64)))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          route={proofTool:outcome?'assistant_secret_browser_outcome':'assistant_secret_browser_consume'};
        }else fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        rewritten=url.pathname;
        if(lifecycle)url=new URL(url.pathname+url.search,identity.origin);
      }else if(privateSkill && requestOrigin===(lifecycle?.requestOrigin??identity.origin)
        && url.pathname.startsWith(`/api/agent-secrets/checkout-grants/${privateSkill.grantId}/`)){
        const base=`/api/agent-secrets/checkout-grants/${privateSkill.grantId}`;
        if(method==='GET' && url.pathname===base+'/browser-fill-context' && options.body===undefined
          && [...url.searchParams.keys()].length===2 && new Set(url.searchParams.keys()).size===2
          && url.searchParams.get('runId')===privateSkill.runId && url.searchParams.get('purpose')==='signed_skill'){
          route={proofTool:'assistant_secret_skill_context'};
        }else if(method==='POST' && !url.search && url.pathname===base+'/consume'){
          let input;try{input=JSON.parse(options.body);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
          if(!object(input) || Object.keys(input).sort().join(',')!=='purpose,runId'
            || input.runId!==privateSkill.runId || input.purpose!=='signed_skill')fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          route={proofTool:'assistant_secret_skill_consume'};
        }else fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        rewritten=url.pathname;
        // Personal values live in the SAME global private keyring. This is a
        // fixed native control-plane endpoint, not a company plaintext retry.
        // The handler still checks the surrounding encrypted task recipient.
        if(lifecycle)url=new URL(url.pathname+url.search,identity.origin);
      }else if(requestOrigin===identity.origin && (url.pathname==='/api/agent-skills/runtime/resolve' && method==='POST'
        || url.pathname==='/api/agent-skills/runtime/package' && method==='GET'
        || (remoteMcp||skillRead?.executionKind==='remote_mcp') && url.pathname==='/api/agent-skills/remote-mcp/resolve' && method==='POST')){
        if(inspection)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        // Signed-skill and Remote MCP declaration reads share this narrower
        // device/task profile. The latter is admitted only during its exact
        // selected read/operation; consent, setup and Secret delivery retain
        // their independent native gates before private I/O.
        let input;
        try{input=method==='GET'?Object.fromEntries(url.searchParams):JSON.parse(options.body);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
        if(!object(input) || input.companyId!==pass.companyId
          || method==='GET' && new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        if(skillRead && (input.skillId!==skillRead.skillId||input.expectedReleaseId!==skillRead.releaseId
          ||(input.projectId??null)!==skillRead.projectId))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        if(remoteMcp && (input.skillId!==remoteMcp.input.skillId||input.expectedReleaseId!==remoteMcp.input.releaseId
          ||(input.projectId??null)!==(remoteMcp.input.projectId??null)))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        if(privateSkill && (input.skillId!==privateSkill.skill.skillId || input.expectedReleaseId!==privateSkill.skill.releaseId
          || (input.projectId??null)!==(privateSkill.skill.projectId??null)))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        rewritten=url.pathname;
        route={proofTool:url.pathname==='/api/agent-skills/remote-mcp/resolve'?'assistant-skill:remote-resolve':method==='POST'?'assistant-skill:resolve':'assistant-skill:package'};
      }else{
        if(!pathname.startsWith(nativePrefix+'/'))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        rewritten=assistantPrefix+url.pathname.slice(nativePrefix.length);
        route=assistantWorkspaceConcreteRequest(method,rewritten);
        const taskRead=route.routePattern.endsWith('/tasks/read') || route.routePattern.endsWith('/sections/read');
        if(taskRead){
          if(!encryptedRead || requestOrigin!==encryptedRead.requestOrigin || url.search
            || !encryptedRead.paths.includes(url.pathname))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        }else if(inspection){
          if(!assistantWorkspaceEncryptedInspectionReadRoute(method,route.routePattern))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          if(options.body!==undefined)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          const keys=[...url.searchParams.keys()];
          if(new Set(keys).size!==keys.length)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          if(route.routePattern.endsWith('/bridge-routing')){
            if(keys.length!==1 || keys[0]!=='workspaceId' || url.searchParams.get('workspaceId')!==inspection.workspaceId)
              fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          }else if(route.routePattern.endsWith('/encrypted-bundle')){
            if(keys.length!==1 || keys[0]!=='head' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(url.searchParams.get('head')??''))
              fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          }else if(keys.length)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          const workspaceRoute=route.routePattern.includes('/workspaces/');
          if(workspaceRoute ? requestOrigin!==inspection.requestOrigin
            || !url.pathname.startsWith(nativePrefix+`/workspaces/${inspection.workspaceId}/`)
            || !inspectionEncryption : requestOrigin!==identity.origin)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        }else if(lifecycle){
          if(privateRun&&method!=='GET')fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          if(!assistantWorkspaceEncryptedLifecycleRoute(method,route.routePattern))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          const suffix=url.pathname.slice(nativePrefix.length);
          const runPath=suffix.startsWith(`/runs/${ownRun.runId}/`);
          const workspacePath=[`/workspaces/${ownRun.workspaceId}`,
            `/workspaces/${ownRun.workspaceId}/runs/${ownRun.runId}`,
            `/workspaces/${ownRun.workspaceId}/read-snapshot`,`/workspaces/${ownRun.workspaceId}/encrypted-bundle`].includes(suffix);
          const control=['/bridge-routing','/bridge-compatibility'].includes(suffix);
          if(!runPath && !workspacePath && !control && suffix!=='/encryption/payloads'
            || requestOrigin!==(control?identity.origin:lifecycle.requestOrigin)
            || !control && !lifecycleEncryption)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          if(suffix==='/encryption/payloads'){
            let input;try{input=JSON.parse(options.body);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
            if(input.companySlug!==lifecycle.company.slug || input.writerDeviceId!==lifecycleEncryption.runtime.device.id
              || !Array.isArray(input.payloads) || input.payloads.length<1 || input.payloads.length>100
              || input.payloads.some(payload=>!['agent_workspace.checkpoint','agent_workspace.derived_artifact'].includes(payload?.entityType))
              || input.payloads.some(payload=>payload.entityType==='agent_workspace.checkpoint') && input.payloads.length!==1)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
          }
        }else if(requestOrigin!==identity.origin)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      }
      return lock(path.join(lockDirectory,`${pass.passId}.json`),async()=>{
        await assertLivePass(options.signal);
        const record=await store.get({origin:identity.origin,kind:'runtime',id:pass.passId});
        const state=record?.state;
        if(record?.schemaVersion!==1 || record.ended || record.passId!==pass.passId || record.threadId!==pass.threadId
          || !uuid.test(state?.runtimeSessionId??'') || !Number.isFinite(Date.parse(state.expiresAt)) || Date.parse(state.expiresAt)<=now()
          || typeof state.privateKeyPkcs8!=='string' || state.privateKeyPkcs8.length>256) fail('ASSISTANT_WORKSPACE_SESSION_REQUIRED');
        let proof;try{proof=buildRuntimeSessionProof({state,toolName:route.proofTool,now:new Date(now())});}
        catch{fail('ASSISTANT_WORKSPACE_SESSION_REQUIRED');}
        // Keys use the ordinary observed-hook serializer; no model-authored
        // proof/session or human vault lookup is accepted. Scope/proof headers
        // overwrite any untrusted values from an initial header collection.
        const headers=buildHeaders(null,options.headers??{});
        headers.delete('cookie');headers.delete('cookie2');headers.delete('proxy-authorization');
        headers.delete('x-trelio-assistant-secret-checkout');
        headers.delete(ASSISTANT_WORKSPACE_RECIPIENT_HEADER);
        if(attachmentEncryption&&!encryptionRuntime)headers.set(ASSISTANT_WORKSPACE_RECIPIENT_HEADER,attachmentEncryption.runtime.device.id);
        headers.delete('x-trelio-assistant-workspace-run');
        if(inspection && route.routePattern?.includes('/workspaces/'))
          headers.set(ASSISTANT_WORKSPACE_RECIPIENT_HEADER,inspectionEncryption.runtime.device.id);
        if(lifecycleEncryption && route.routePattern && !encryptionRuntime){
          headers.set(ASSISTANT_WORKSPACE_RECIPIENT_HEADER,lifecycleEncryption.runtime.device.id);
          headers.set('x-trelio-assistant-workspace-run',ownRun.runId);
        }
        headers.delete('x-trelio-assistant-source-encryption-fingerprint');
        headers.delete('x-trelio-assistant-skill-guidance');
        if(route.proofTool.startsWith('assistant-skill:')||route.proofTool.startsWith('assistant_secret_skill_')||route.proofTool.startsWith('assistant_secret_browser_')||route.proofTool.startsWith('assistant_secret_generate_')){
          const stored=await store.get({origin:identity.origin,kind:'company_encryption',id:pass.companyId,deviceId:identity.deviceId});
          if(stored?.assistantId===identity.assistantId&&stored.deviceId===identity.deviceId&&stored.companyId===pass.companyId
            &&typeof stored.record?.fingerprint==='string'&&/^[A-Za-z0-9_-]{40,128}$/u.test(stored.record.fingerprint)){
            skillFingerprint=stored.record.fingerprint;headers.set('x-trelio-assistant-source-encryption-fingerprint',skillFingerprint);
          }
          if(skillRead && ['assistant-skill:resolve','assistant-skill:remote-resolve'].includes(route.proofTool))headers.set('x-trelio-assistant-skill-guidance','1');
        }
        if(privateSkill && route.proofTool.startsWith('assistant-skill:'))headers.set('x-trelio-assistant-secret-checkout',
          JSON.stringify({grantId:privateSkill.grantId,runId:privateSkill.runId}));
        headers.set('x-trelio-assistant-pass',JSON.stringify(locator));
        headers.set('x-trelio-assistant-proof',JSON.stringify(proof));
        if(encryptionRuntime)headers.set('x-trelio-assistant-encryption-protocol','1');
        await withCredential(credential=>{headers.set('authorization',`Bearer ${credential}`);});
        await assertIdentity();
        url.pathname=rewritten;
        return {url,headers,options:{redirect:'error',credentials:'omit',cache:'no-store'}};
      });
    },
  });
};

/** Pure syntax boundary shared by pre-send privacy admission and the exact
 * source reader. The account selector is parsed by the SAME catalogue grammar;
 * this function performs no account/native/network I/O and grants no read or
 * owner authority. The observer still matches the original frozen inbox ref
 * and repeats current native source/task/route checks before provider work. */
export const parseAssistantSourceReadReference = ({skillId,arguments:rawArguments}) => {
  if(!['telegram-mtproto','email-imap-smtp','max-web'].includes(skillId))return null;
  if(!Array.isArray(rawArguments)||rawArguments.length>11||rawArguments.some(value=>typeof value!=='string'))
    fail('ASSISTANT_SOURCE_READ_REQUIRED');
  let selected;try{selected=splitAccountArguments(rawArguments);}catch{fail('ASSISTANT_SOURCE_READ_REQUIRED');}
  const args=selected.providerArguments;
  if(args[0]!=='read-reference')return null;
  const email=skillId==='email-imap-smtp',max=skillId==='max-web',provider=email?'email':max?'max':'telegram';
  if(args.length!==9)fail('ASSISTANT_SOURCE_READ_REQUIRED');
  const fields=new Map(),allowed=email?['--uid','--uid-validity','--expected-revision','--expected-conversation-key']
    :['--chat','--message-id','--expected-revision','--expected-conversation-key'];
  for(let i=1;i<args.length;i+=2){
    if(!allowed.includes(args[i])||fields.has(args[i]))fail('ASSISTANT_SOURCE_READ_REQUIRED');
    fields.set(args[i],args[i+1]);
  }
  const positive=value=>typeof value==='string'&&/^[1-9]\d{0,18}$/u.test(value);
  const chat=fields.get('--chat'),eventRevision=fields.get('--expected-revision'),conversationKey=fields.get('--expected-conversation-key');
  // Positional shape alone is not a privacy boundary: an approved flag could
  // otherwise carry arbitrary protected prose. Admit only the provider-bound
  // opaque hashes and native numeric selectors already used by the inbox.
  if(!/^[0-9a-f]{64}$/u.test(eventRevision??'')||!assistantConversationKeyMatches(provider,conversationKey)
    ||(email?!positive(fields.get('--uid'))||!positive(fields.get('--uid-validity'))
      :!positive(fields.get('--message-id'))||(max?!assistantMaxChatUrl(chat):typeof chat!=='string'||!/^-?[1-9]\d{0,18}$/u.test(chat))))
    fail('ASSISTANT_SOURCE_READ_REQUIRED');
  const eventId=email?`uid:${fields.get('--uid-validity')}:${fields.get('--uid')}`
    :`message:${max?chat.slice('https://web.max.ru/'.length):chat}:${fields.get('--message-id')}`;
  return Object.freeze({provider,accountId:selected.accountId===null?null:selected.accountId.toLowerCase(),eventId,eventRevision,
    conversationKey,...(email?{}:{chat})});
};

/** A trusted observer of the SAME signed task executor, not a second provider.
 * Only an exact original queued read-reference can earn a private read slot.
 * Native source/route/pass reads happen before AND after provider I/O; the
 * actual account-scoped HMAC is checked by the signed provider before its body
 * fetch. Successful EOF output is inspected in RAM and never persisted here.
 * A read slot still is NOT a processing receipt or permission to issue ACK. */
export const createAssistantSourceReadObserver=({identity,client,host,withInbox,signal,now=Date.now})=>{
  if(typeof withInbox!=='function')fail('ASSISTANT_SOURCE_READ_REQUIRED');
  const tickets=new WeakSet();
  const current=async expected=>{
    signal?.throwIfAborted();
    const pass=validateAssistantActivePass(await host.readActivePass(),identity);
    if(expected&&JSON.stringify(expected)!==JSON.stringify(pass))fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
    const live=await client.readTaskPass({companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId},signal);
    if(live.state!=='leased'||['passId','deliveryId','threadId','bindingId','bindingRevision'].some(key=>live[key]!==pass[key])
      ||!Number.isFinite(Date.parse(live.leaseExpiresAt))||Date.parse(live.leaseExpiresAt)<=now())fail('ASSISTANT_PASS_REVIEW_REQUIRED');
    return pass;
  };
  const authorize=async(pass,ref,{routeRequired=true}={})=>{
    await current(pass);
    const sources=await client.sourceAccounts(pass.companyId,signal);
    const row=sources.find(row=>row.id===ref.sourceId);
    if(!row||row.state!=='active'||row.deviceId!==identity.deviceId||row.revision!==ref.sourceRevision
      ||row.skillId!==({telegram:'telegram-mtproto',email:'email-imap-smtp',max:'max-web'}[ref.scope.provider])
      ||row.localAccountId!==ref.scope.accountId)fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
    if(!routeRequired)return row;
    const routes=await client.sourceRoutes({companyId:pass.companyId,sourceId:row.id,sourceRevision:row.revision,
      routeIds:[ref.routeId]},signal);
    if(!routes.some(route=>route.id===ref.routeId&&route.bindingId===pass.bindingId&&route.bindingRevision===pass.bindingRevision
      &&route.taskId===pass.taskId))fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
    return row;
  };
  return Object.freeze({
    async prepare({artifact,executionContext,runtimeArguments}){
      if(!['telegram-mtproto','email-imap-smtp','max-web'].includes(artifact?.skillId)||runtimeArguments?.[0]!=='read-reference')return null;
      const parsed=parseAssistantSourceReadReference({skillId:artifact.skillId,arguments:runtimeArguments});
      if(!parsed)fail('ASSISTANT_SOURCE_READ_REQUIRED');
      const {provider,eventId,eventRevision,conversationKey,chat}=parsed,max=provider==='max';
      const pass=await current();
      if(executionContext?.companyId!==pass.companyId||!UUID.test(executionContext.account?.id??''))fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
      const refs=await withInbox(inbox=>inbox.externalDeliveryReferences(pass));
      const matched=refs.filter(row=>row.scope.provider===provider&&row.scope.accountId===executionContext.account.id
        &&row.event_id===eventId&&row.event_revision===eventRevision
        &&row.conversation_key===conversationKey);
      if(matched.length!==1)fail('ASSISTANT_SOURCE_READ_REQUIRED');
      const ref=matched[0],source=await authorize(pass,ref);
      if(source.projectId!==null&&executionContext.projectId!==source.projectId||max&&source.maxChatUrl!==chat)fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
      const ticket=Object.freeze({pass,ref});tickets.add(ticket);return ticket;
    },
    async commit(ticket,{stdout}){
      if(!tickets.has(ticket))fail('ASSISTANT_SOURCE_READ_REQUIRED');tickets.delete(ticket);
      let value;try{value=JSON.parse(stdout);}catch{fail('ASSISTANT_SOURCE_READ_INVALID');}
      const {pass,ref}=ticket;
      const email=ref.scope.provider==='email',max=ref.scope.provider==='max';
      if(!object(value)||value.schemaVersion!==1||value.protocol!==(email?'email-message-read/v1':max?'max-message-read/v1':'telegram-message-read/v1')
        ||value.reference?.id!==ref.event_id||value.reference?.revision!==ref.event_revision
        ||value.reference?.conversationKey!==ref.conversation_key||!object(value.message)
        ||!object(value.coverage)||value.coverage.textComplete!==true||value.coverage.attachmentsContentRead!==false
        ||value.readState?.marksRead!==false||value.readState.readReceiptsSent!==false
        ||(email?typeof value.message.body!=='string'||value.coverage.otherMessagesIncluded!==false||!/^[0-9a-f]{64}$/u.test(value.originalSha256??'')
          ||ref.event_id!==`uid:${value.reference.uidValidity}:${value.reference.uid}`
          :value.message.textTruncated!==false||value.coverage.contextIncluded!==false
            ||max&&(typeof value.message.text!=='string'||value.coverage.nativeMessageVerified!==true||value.coverage.otherMessagesIncluded!==false)
            ||value.readState.mode!=='history-only'||value.readState.viewsRegistered!==false))fail('ASSISTANT_SOURCE_READ_INVALID');
      await authorize(pass,ref);
      await withInbox(inbox=>{
        // Repeat the immutable local snapshot after asynchronous native reads.
        const rows=inbox.externalDeliveryReferences(pass,{selected:[{sourceId:ref.sourceId,sourceRevision:ref.sourceRevision,
          routeId:ref.routeId,eventOrdinal:ref.eventOrdinal}]});
        if(rows.length!==1||rows[0].event_key!==ref.event_key)fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
        inbox.recordExternalRead(ref.scope,{deliveryId:pass.deliveryId,eventKey:ref.event_key,
          sourceRevision:ref.sourceRevision,routeId:ref.routeId,...(email?{originalSha256:value.originalSha256}:{})});
      });
    },
    async confirmProcessing(pass,selected){
      // Called only by the observed hook immediately before its same-session
      // signature. The model may select semantic work, never assert a read.
      const refs=await withInbox(inbox=>inbox.externalDeliveryReferences(pass,{selected,requireRead:true,allowTaskDone:true}));
      // The task may have become done after the actual body read. This
      // signature proves that read, not permission: native completion checks
      // the exact stored route/task/source again in its closing transaction.
      // Do not grant a new read or resurrect a done routing inventory here.
      for(const ref of refs)await authorize(pass,ref,{routeRequired:false});
      await withInbox(inbox=>inbox.externalDeliveryReferences(pass,{selected,requireRead:true,allowTaskDone:true}));
      return selected;
    },
  });
};

/** Native encrypted get_agent_skill uses the SAME signed runtime resolver and
 * response projector. Only instructions/config ciphertext is opened locally;
 * package execution still needs its separate task proof and signed loader. */
export const materializeAssistantEncryptedSkill = async ({origin,descriptor,signal,common}) => {
  common??=await import('./trelio-workspace.mjs');
  const selected=validateAssistantEncryptedSkillRead(descriptor),profile=common.currentWorkspaceExecutionProfile();
  if(profile?.kind!=='digital_assistant'||typeof profile.hydrateSkillRuntimeResolution!=='function')fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  const token=await common.requireToken(origin);
  const response=await common.request(origin,token,selected.executionKind==='remote_mcp'?'/api/agent-skills/remote-mcp/resolve':'/api/agent-skills/runtime/resolve',{method:'POST',signal,
    headers:{'content-type':'application/json'},body:JSON.stringify({companyId:selected.companyId,projectId:selected.projectId,
      skillId:selected.skillId,expectedReleaseId:selected.releaseId})});
  const raw=await readAssistantEncryptedSnapshotResponse(response,common);
  if(raw.releaseId!==selected.releaseId||raw.company?.id!==selected.companyId||(selected.executionKind==='remote_mcp'?raw.localIdentity?.skillId:raw.artifact?.skillId)!==selected.skillId
    ||(raw.localIdentity?.projectId??null)!==selected.projectId||!raw.assistantGuidance)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  const {rawResolution,companyEncryption}=await profile.hydrateSkillRuntimeResolution(raw,common,signal);
  if (selected.executionKind === 'remote_mcp') {
    const native = rawResolution.assistantGuidance, remote = native?.structuredContent?.remoteMcpExecution;
    if (!remote || remote.releaseId !== selected.releaseId || native.structuredContent.skill?.id !== selected.skillId)
      fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
    native.content = [{ type:'text', text:'Current skill instructions and assistant execution capability are in structuredContent.' }];
    native.structuredContent = { ...native.structuredContent, runtimeExecution:null,
      remoteMcpExecution:{...remote,updatePolicy:'fresh_current_pass',localMcpServer:'trelio-assistant',
        tools:{connect:'connect_remote_agent_skill',doctor:'doctor_remote_agent_skill',call:'call_remote_agent_skill_tool'}},
      assistantExecution:{state:'shared_remote_mcp',automaticFallbackAllowed:false} };
    const {compactLocalNativeMcpResult}=await import('./trelio-mcp-results.mjs');
    return compactLocalNativeMcpResult('get_agent_skill',native,selected.arguments);
  }
  const pending=rawResolution?.trust?.requiresDeviceConsent===true&&rawResolution.trust.consentId===null;
  const resolved=common.normalizeResolvedSkillRuntimeArtifact(rawResolution,{allowPendingEncryptedConsent:pending});
  const companyRuntime=resolved.trust.level==='company_unverified'&&resolved.trust.requiresDeviceConsent
    &&['company_unverified','platform_verified'].includes(resolved.trust.artifactLevel);
  if(!(companyRuntime||resolved.artifact.contentProtection==='plain'&&resolved.trust.level==='platform_verified'
    &&resolved.trust.artifactLevel==='platform_verified'&&!resolved.trust.requiresDeviceConsent)
    ||resolved.companyConnection?.secretBindings.length)fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  const setupRequested=selected.arguments.sections?.includes('connection')===true;
  let inspected=null;
  if(pending||setupRequested&&resolved.artifact.contentProtection==='company_e2ee_v1'){
    if(resolved.artifact.contentProtection!=='company_e2ee_v1'||!companyEncryption)fail('ASSISTANT_SKILL_OWNER_CONSENT_REQUIRED');
    // SAME verifier, bounded encrypted download, TRELIOE1/AAD decrypt, complete
    // manifest equality and ephemeral cleanup. This is inspection, never an
    // executable cache or a provider launch, before exact owner approval.
    inspected=await common.inspectEncryptedAgentSkillRuntimeForConsent({origin,token,packageUrl:resolved.packageUrl,
      artifact:resolved.artifact,companyEncryption,inspectHumanInputCommands:setupRequested});
  }
  const native=rawResolution.assistantGuidance,execution=native?.structuredContent?.runtimeExecution;
  if(!execution||execution.releaseId!==selected.releaseId||native.structuredContent.skill?.id!==selected.skillId)
    fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  native.content=[{type:'text',text:'Current skill instructions and assistant execution capability are in structuredContent.'}];
  const privateAuthentication=native.structuredContent.assistantExecution?.privateAuthentication;
  const runtimeConsent=native.structuredContent.assistantExecution?.runtimeConsent;
  const accountSetup=setupRequested&&inspected?.humanInputCommands?.length
    ?{state:'owner_review_required',operation:'setup_skill_account',continuation:'skill_account_setup',
      commands:inspected.humanInputCommands.map(({id,purpose,maximumDurationMs})=>({id,purpose,...(maximumDurationMs===undefined?{}:{maximumDurationMs})}))}
    :native.structuredContent.assistantExecution?.accountSetup;
  if(pending&&(!runtimeConsent||runtimeConsent.state!=='owner_review_required'
    ||runtimeConsent.fields?.runtimeArtifactId!==resolved.artifact.id||runtimeConsent.fields.releaseId!==resolved.releaseId
    ||runtimeConsent.fields.packageSha256!==resolved.artifact.packageSha256))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  native.structuredContent={...native.structuredContent,runtimeExecution:{...execution,localAction:{...execution.localAction,
    server:'trelio-assistant',tool:'continue_assistant_workspace_action'}},remoteMcpExecution:null,
    assistantExecution:{state:pending||setupRequested&&accountSetup?'shared_runtime_setup':'shared_runtime',automaticFallbackAllowed:false,
      ...(runtimeConsent?{runtimeConsent:{...runtimeConsent,...(inspected?{localInspection:{capabilities:inspected.capabilities,
        packageSizeBytes:inspected.packageSizeBytes}}:{})}}:{}),...(accountSetup?{accountSetup}:{}),...(privateAuthentication?{privateAuthentication}:{})}};
  const {compactLocalNativeMcpResult}=await import('./trelio-mcp-results.mjs');
  return compactLocalNativeMcpResult('get_agent_skill',native,selected.arguments);
};

/** Exact signed human-input recipe selected locally, never model argv.
 * This uses the SAME metadata hydrator and signature/TRELIOE1 inspector for
 * public or private artifacts. Current device consent is required first. */
export const inspectAssistantSkillAccountSetupForOwner=async({origin,companyId,fields,signal,common})=>{
  const selected=normalizeAssistantSkillAccountSetupFields(fields);common??=await import('./trelio-workspace.mjs');
  const profile=common.currentWorkspaceExecutionProfile();
  if(profile?.kind!=='digital_assistant'||typeof profile.hydrateSkillRuntimeResolution!=='function')fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  const token=await common.requireToken(origin);
  const response=await common.request(origin,token,'/api/agent-skills/runtime/resolve',{method:'POST',signal,
    headers:{'content-type':'application/json'},body:JSON.stringify({companyId,projectId:selected.projectId,skillId:selected.skillId,expectedReleaseId:selected.releaseId})});
  const raw=await readAssistantEncryptedSnapshotResponse(response,common);
  const hydrated=await profile.hydrateSkillRuntimeResolution(raw,common,signal);
  const resolved=common.normalizeResolvedSkillRuntimeArtifact(hydrated.rawResolution);
  if(resolved.company.id!==companyId||resolved.releaseId!==selected.releaseId||resolved.artifact.skillId!==selected.skillId
    ||(resolved.localIdentity?.projectId??null)!==selected.projectId)fail('ASSISTANT_SKILL_SETUP_REQUIRED');
  const inspected=await common.inspectEncryptedAgentSkillRuntimeForConsent({origin,token,packageUrl:resolved.packageUrl,
    artifact:resolved.artifact,companyEncryption:hydrated.companyEncryption,humanInputCommandId:selected.commandId});
  if(!inspected.capabilities.includes('local-session')||!inspected.capabilities.includes('local-accounts-v1')||!inspected.humanInputCommand)
    fail('ASSISTANT_SKILL_SETUP_REQUIRED');
  return {command:inspected.humanInputCommand,artifactId:resolved.artifact.id,packageSha256:resolved.artifact.packageSha256,
    privateRuntime:resolved.artifact.contentProtection==='company_e2ee_v1'};
};

/** Fresh encrypted private-package inspection for the owner question. The
 * exact native fields are compared again; model-supplied capability claims,
 * package paths and device/recipient selectors never enter the review. */
export const inspectAssistantSkillConsentForOwner=async({origin,companyId,fields,signal,common})=>{
  const selected=normalizeAssistantSkillConsentFields(fields);
  const result=await materializeAssistantEncryptedSkill({origin,descriptor:{schemaVersion:1,nativeTool:'get_agent_skill',companyId,
    projectId:selected.projectId,skillId:selected.skillId,releaseId:selected.releaseId,arguments:{sections:['instructions','execution']}},signal,common});
  const consent=result.structuredContent?.assistantExecution?.runtimeConsent;
  if(consent?.state!=='owner_review_required'||Object.keys(selected).some(key=>JSON.stringify(selected[key])!==JSON.stringify(consent.fields?.[key]))
    ||!object(consent.localInspection)||!Array.isArray(consent.localInspection.capabilities)
    ||consent.localInspection.capabilities.some(value=>typeof value!=='string'||!/^[a-z][a-z0-9-]{0,63}$/u.test(value)))fail('ASSISTANT_SKILL_CONSENT_CHANGED');
  return {capabilities:[...consent.localInspection.capabilities],packageSizeBytes:consent.localInspection.packageSizeBytes};
};

/** Host-private client. Model tools receive only projections from these named
 * operations; no method returns the credential or delegates an arbitrary URL. */
const intakeLocator=input=>({companyId:id(input.companyId),sourceId:id(input.sourceId),intakeId:id(input.intakeId)});
const intakeProjection=(value,expected)=>{
  if(!object(value)||value.schemaVersion!==1||value.id!==expected.intakeId||value.sourceId!==expected.sourceId||value.companyId!==expected.companyId
    ||!['leased','ignored','created','waiting_owner','redirected','cancelled'].includes(value.state)||typeof value.readConfirmed!=='boolean')fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  return {schemaVersion:1,id:id(value.id),companyId:id(value.companyId),sourceId:id(value.sourceId),sourceRevision:revision(value.sourceRevision),
    eventId:id(value.eventId),threadId:id(value.threadId),state:value.state,leaseExpiresAt:isoTimestamp(value.leaseExpiresAt),
    taskId:value.taskId===null?null:id(value.taskId),receiptId:value.receiptId===null?null:id(value.receiptId),
    readConfirmed:value.readConfirmed,execution:executionConfiguration(value.execution),
    ...(value.redirect?{redirect:{sourceId:id(value.redirect.sourceId),companyId:id(value.redirect.companyId),sourceRevision:revision(value.redirect.sourceRevision)}}:{}),
    ...(value.route?{route:{id:id(value.route.id),sourceId:id(value.route.sourceId),sourceRevision:revision(value.route.sourceRevision),
      bindingId:id(value.route.bindingId),bindingRevision:revision(value.route.bindingRevision),conversationKey:text(value.route.conversationKey,96)}}:{})};
};

export const createAssistantDeviceClient = ({ origin, assistantId, deviceId, store, http }) => {
  origin = originOf(origin); assistantId = id(assistantId); deviceId = id(deviceId);
  if (!store || typeof store.get !== 'function' || typeof http !== 'function') fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  const call = async (operation, body, signal) => http(operation, body,
    await loadAssistantDeviceCredential({ origin, assistantId, deviceId, store }), signal);

  const registerObservedRuntime=async(input,signal,intake=false)=>{
      if(!object(input.observation) || input.observation.schemaVersion!==1 || input.observation.clientFamily!=='codex'
        || input.observation.source!=='codex_hook' || input.observation.evidenceLevel!=='local_observed'
        || !/^[a-z0-9._:+/-]{1,255}$/iu.test(input.observation.modelId??'')
        || ![null,'low','medium','high','xhigh','max','ultra'].includes(input.observation.effortLevel)
        || !Number.isFinite(Date.parse(input.observation.observedAt)) || !/^[A-Za-z0-9_-]{40,256}$/u.test(input.publicKeySpki??'')) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      const value=await call(intake?'intakeRegister':'registerRuntime',{companyId:id(input.companyId),...(intake?{sourceId:id(input.sourceId),intakeId:id(input.intakeId)}:{taskId:id(input.taskId),passId:id(input.passId)}),
        clientSessionId:id(input.clientSessionId),observation:input.observation,publicKeySpki:input.publicKeySpki,
        ...(input.previousRuntimeSessionId?{previousRuntimeSessionId:id(input.previousRuntimeSessionId)}:{})},signal);
      if(value.schemaVersion!==1 || value.passId!==(intake?input.intakeId:input.passId) || value.conversation?.conversationId!==input.clientSessionId
        || value.conversation?.provider!=='codex' || value.conversation?.openProtocol!=='codex-thread-v1'
        || !Number.isFinite(Date.parse(value.expiresAt)) || value.runtimeRefreshSupported!==true
        || !object(value.observation)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      for(const key of ['schemaVersion','clientFamily','modelId','effortLevel','evidenceLevel','source'])
        if(value.observation[key]!==input.observation[key]) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {schemaVersion:1,passId:id(value.passId),runtimeSessionId:id(value.runtimeSessionId),expiresAt:isoTimestamp(value.expiresAt),
        observation:Object.fromEntries(['schemaVersion','clientFamily','modelId','effortLevel','evidenceLevel','source','observedAt'].map(key=>[key,key==='observedAt'?isoTimestamp(value.observation[key]):value.observation[key]])),
        runtimeRefreshSupported:true};
  };
  return {
    identity: Object.freeze({ origin, assistantId, deviceId }),
    async ownerIdentities(signal) {
      // One fresh native read per explicit call. Neither the twelve-hour skill
      // admission cache nor a previously matched username authorizes routing.
      // No task pass, current model, human cookie or owner OAuth is involved.
      return projectAssistantOwnerIdentities(await call('ownerIdentities',undefined,signal),assistantId);
    },
    async sourceAccounts(companyId, signal) {
      // Validate input before private credential I/O. Read fresh every time;
      // no model turn, task pass, account import/setup or provider launch here.
      companyId = id(companyId);
      return projectAssistantSourceAccounts(await call('sourceAccounts',{companyId},signal),{assistantId,deviceId,companyId});
    },
    async sourceRoutes(input, signal) {
      // Exact route IDs also admit independently created owner-command events;
      // a model-authored conversation key still grants no task/body authority.
      const ids=input?.routeIds,keys=input?.conversationKeys;
      const key=value=>['telegram','email','max'].some(provider=>assistantConversationKeyMatches(provider,value));
      if(!object(input)||Object.keys(input).sort().join(',')!==(ids?'companyId,routeIds,sourceId,sourceRevision':'companyId,conversationKeys,sourceId,sourceRevision')
        ||!Number.isSafeInteger(input.sourceRevision)||input.sourceRevision<0||input.sourceRevision>2_147_483_647
        ||(ids!==undefined)===(keys!==undefined)||!Array.isArray(ids??keys)||!(ids??keys).length||(ids??keys).length>100
        ||(ids??keys).some(value=>ids?!UUID.test(value??''):!key(value))||new Set(ids??keys).size!==(ids??keys).length)
        fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      const body={companyId:id(input.companyId),sourceId:id(input.sourceId),sourceRevision:revision(input.sourceRevision),
        ...(ids?{routeIds:ids.map(id)}:{conversationKeys:[...keys]})};
      const value=await call('sourceRoutes',body,signal);
      if(value.schemaVersion!==1||value.sourceId!==body.sourceId||value.sourceRevision!==body.sourceRevision
        ||!Array.isArray(value.routes)||value.routes.length>(ids??keys).length)fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      const seen=new Set();
      return value.routes.map(row=>{
        if(!object(row)||row.sourceId!==body.sourceId||row.sourceRevision!==body.sourceRevision
          ||(ids?!body.routeIds.includes(row.id):!keys.includes(row.conversationKey))||seen.has(ids?row.id:row.conversationKey))fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
        seen.add(ids?row.id:row.conversationKey);
        return {id:id(row.id),sourceId:body.sourceId,sourceRevision:body.sourceRevision,conversationKey:row.conversationKey,
          bindingId:id(row.bindingId),bindingRevision:revision(row.bindingRevision),taskId:id(row.taskId)};
      });
    },
    async readSourceHealth(companyId,sourceId,signal){
      companyId=id(companyId);sourceId=id(sourceId);
      return sourceHealthState(await call('sourceHealthRead',{companyId,sourceId},signal));
    },
    async reportSourceHealth(input,signal){
      if(!object(input)||Object.keys(input).filter(key=>key!=='phase').sort().join(',')!=='clientRequestId,code,companyId,expectedRevision,sourceId,sourceRevision'
        || Object.hasOwn(input,'phase')&&input.phase!=='acknowledgement'
        || !(input.phase?sourceAcknowledgementHealthCodes:sourceHealthCodes).includes(input.code)
        || !Number.isSafeInteger(input.sourceRevision)||input.sourceRevision<0||input.sourceRevision>2_147_483_647
        || !Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>2_000_000_000)fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      const body={companyId:id(input.companyId),sourceId:id(input.sourceId),sourceRevision:revision(input.sourceRevision),
        expectedRevision:revision(input.expectedRevision),clientRequestId:id(input.clientRequestId),code:input.code,
        ...(input.phase?{phase:input.phase}:{})};
      const result=sourceHealthState(await call('sourceHealthReport',body,signal));
      // The native row retains independent READ/ACK observations. Its effective
      // reason may still describe the OTHER boundary after this report, so code
      // equality would turn a valid CAS write into a false transport failure.
      // This projection is diagnostic, never an ACK receipt or write admission.
      if(result.revision!==body.expectedRevision+1||result.sourceRevision!==body.sourceRevision||result.code==='not_checked')
        fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return result;
    },
    async readHealth(signal) {
      const value=await call('healthRead',undefined,signal),current=healthState(value);
      const stable=v=>typeof v==='string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(v);
      if(!object(value.compatibility) || !stable(value.compatibility.minimumPluginVersion)
        || value.compatibility.minimumRuntimeVersion!==null && !stable(value.compatibility.minimumRuntimeVersion)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {...current,compatibility:{minimumPluginVersion:value.compatibility.minimumPluginVersion,minimumRuntimeVersion:value.compatibility.minimumRuntimeVersion}};
    },
    async reportHealth(input,signal) {
      const keys=Object.keys(input??{}).filter(key=>key!=='clearedReason').sort().join(',');
      if(!object(input) || keys!=='clientRequestId,code,expectedRevision'
        || !['ready','plugin_update_required','plugin_restart_required','mcp_reconnect_required','runtime_update_failed','codex_auth_required','hook_review_required'].includes(input.code)
        || input.clearedReason!==undefined && (input.code!=='ready' || !['codex_auth_required','hook_review_required'].includes(input.clearedReason))) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      const value=await call('healthReport',{clientRequestId:id(input.clientRequestId),expectedRevision:revision(input.expectedRevision),code:input.code,
        ...(input.clearedReason?{clearedReason:input.clearedReason}:{})},signal);
      if(value.revision!==input.expectedRevision+1) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return healthState(value);
    },
    async heartbeat(signal) {
      const value = await call('heartbeat', {}, signal);
      if (value.assistantUserId !== assistantId || value.deviceId !== deviceId) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return { assistantId, deviceId };
    },
    async companies(signal) {
      const value = await call('companies', undefined, signal);
      if (value.assistantUserId !== assistantId || value.bindingId !== deviceId || !Array.isArray(value.companies) || value.companies.length > 256) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return value.companies.map(company => ({ companyId: id(company.id), memberId: id(company.memberId),
        encryptionState: company.encryptionState === null ? null : text(company.encryptionState, 64),
        ...(typeof company.slug==='string'?{companySlug:text(company.slug,120)}:{}), execution:executionState(company.execution) }));
    },
    async tasks(companyId, after = null, signal) {
      companyId = id(companyId); if (after !== null) after = id(after);
      const value = await call('tasks', { companyId, after }, signal);
      if (!Array.isArray(value.bindings) || value.bindings.length > 100) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return { bindings: value.bindings.map(binding), nextCursor: value.nextCursor === null ? null : id(value.nextCursor) };
    },
    async task(companyId, taskId, signal) {
      taskId=id(taskId);
      const value = await call('task', { companyId: id(companyId), taskId }, signal);
      const result = binding(value.binding);
      if (result.taskId !== taskId) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      if(!['unclaimed','this_device','other_device','stopped'].includes(value.hostState)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {...result,hostState:value.hostState,execution:executionState(value.execution)};
    },
    async poll(companyId, cursor = null, signal) {
      companyId = id(companyId); if (cursor !== null) text(cursor);
      const value = await call('poll', { companyId, cursor }, signal);
      if (!Array.isArray(value.events) || value.events.length > 100 || typeof value.hasMore !== 'boolean') fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return { events: value.events.map(event => {
        if (typeof event.wake !== 'boolean' || event.ownerQuestionId !== undefined && !event.wake) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
        return { id: id(event.id), revision: text(event.revision,128), taskId: id(event.taskId), wake: event.wake,
          bindingId: id(event.bindingId), bindingRevision: revision(event.bindingRevision), taskState: state(event.taskState),
          ...(event.ownerQuestionId === undefined ? {} : { ownerQuestionId: id(event.ownerQuestionId) }) };
      }), nextCursor: text(value.nextCursor), hasMore: value.hasMore };
    },
    async acknowledge(companyId, events, signal) {
      if (!Array.isArray(events) || !events.length || events.length > 100) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      const input = events.map(event => ({ id: id(event.id), revision: text(event.revision,128), bindingId: id(event.bindingId), bindingRevision: revision(event.bindingRevision) }));
      const value = await call('ack', { companyId: id(companyId), acceptSuperseded: true, events: input }, signal);
      if (value.acknowledged !== input.length) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return { acknowledged: value.acknowledged };
    },
    async claimTaskHost(input, signal) {
      const value=await call('claim',{companyId:id(input.companyId),taskId:id(input.taskId),bindingId:id(input.bindingId),
        bindingRevision:revision(input.bindingRevision),provisionId:id(input.provisionId)},signal);
      if(value.bindingId!==input.bindingId || value.provisionId!==input.provisionId) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {bindingId:id(value.bindingId),provisionId:id(value.provisionId),threadId:value.threadId===null?null:id(value.threadId)};
    },
    async beginTaskPass(input,signal) {
      const value=await call('passBegin',{companyId:id(input.companyId),taskId:id(input.taskId),bindingId:id(input.bindingId),
        bindingRevision:revision(input.bindingRevision),deliveryId:id(input.deliveryId),threadId:id(input.threadId)},signal);
      if(value.bindingId!==input.bindingId || value.deliveryId!==input.deliveryId || value.threadId!==input.threadId
        || value.bindingRevision!==input.bindingRevision || !['leased','closed','review_required'].includes(value.state)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {passId:id(value.passId),bindingId:id(value.bindingId),bindingRevision:revision(value.bindingRevision),
        deliveryId:id(value.deliveryId),threadId:id(value.threadId),leaseRevision:revision(value.leaseRevision),
        leaseExpiresAt:isoTimestamp(value.leaseExpiresAt),state:value.state,execution:passExecution(value)};
    },
    async readTaskPass(input,signal) {
      const value=await call('passRead',{companyId:id(input.companyId),taskId:id(input.taskId),passId:id(input.passId)},signal);
      if(value.passId!==input.passId || !['leased','closed','review_required'].includes(value.state)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {passId:id(value.passId),bindingId:id(value.bindingId),bindingRevision:revision(value.bindingRevision),
        deliveryId:id(value.deliveryId),threadId:id(value.threadId),leaseRevision:revision(value.leaseRevision),
        leaseExpiresAt:isoTimestamp(value.leaseExpiresAt),state:value.state,execution:passExecution(value)};
    },
    async readTaskMaterialBasis(input,signal){
      const value=await call('passRead',{companyId:id(input.companyId),taskId:id(input.taskId),passId:id(input.passId),includeMaterialBasis:true},signal);
      if(value.passId!==input.passId || value.state!=='leased' || !Object.hasOwn(value,'materialBasis'))fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      if(value.materialBasis===null)return null;
      const basis=value.materialBasis;
      if(!object(basis)||Object.keys(basis).sort().join(',')!=='receiptId,workspaceHead,workspaceId'
        || !/^[0-9a-f]{40,64}$/u.test(basis.workspaceHead??''))fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return Object.freeze({receiptId:id(basis.receiptId),workspaceId:id(basis.workspaceId),workspaceHead:basis.workspaceHead});
    },
    async renewTaskPass(input,signal) {
      const value=await call('passRenew',{companyId:id(input.companyId),taskId:id(input.taskId),passId:id(input.passId),
        expectedLeaseRevision:revision(input.expectedLeaseRevision),clientRequestId:id(input.clientRequestId)},signal);
      if(value.passId!==input.passId || value.leaseRevision!==input.expectedLeaseRevision+1 || value.state!=='leased') fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {passId:id(value.passId),leaseRevision:revision(value.leaseRevision),leaseExpiresAt:isoTimestamp(value.leaseExpiresAt),
        execution:executionConfiguration(value.execution)};
    },
    async readBusinessOutcome(input,signal) {
      const fields=['assistantId','deviceId','companyId','taskId','bindingId','bindingRevision','deliveryId','threadId'];
      if(!object(input) || Object.keys(input).sort().join(',')!==fields.sort().join(',')
        || input.assistantId!==assistantId || input.deviceId!==deviceId) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      const body={companyId:id(input.companyId),taskId:id(input.taskId),bindingId:id(input.bindingId),
        bindingRevision:revision(input.bindingRevision),deliveryId:id(input.deliveryId),threadId:id(input.threadId)};
      return validateAssistantPassOutcome(await call('passOutcome',body,signal),{assistantId,deviceId,...body});
    },
    registerRuntime:(input,signal)=>registerObservedRuntime(input,signal),
    registerIntakeRuntime:(input,signal)=>registerObservedRuntime(input,signal,true),
    async beginSourceIntake(input,signal){
      const body={...intakeLocator(input),sourceRevision:revision(input.sourceRevision),eventId:id(input.eventId),threadId:id(input.threadId),
        ownerIdentityId:id(input.ownerIdentityId),senderExternalUserId:text(input.senderExternalUserId,19),conversationKey:text(input.conversationKey,96)};
      if(!/^[1-9]\d{0,18}$/u.test(body.senderExternalUserId)||!(/^(telegram|max)-conversation\/v1\.[0-9a-f]{64}$/u).test(body.conversationKey))fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      return intakeProjection(await call('intakeBegin',body,signal),body);
    },
    async cancelSourceIntake(input,signal){const body=intakeLocator(input);return intakeProjection(await call('intakeCancel',body,signal),body);},
    async readSourceIntake(input,signal){
      const body=intakeLocator(input);return intakeProjection(await call('intakeRead',body,signal),body);
    },
    async endIntakeRuntime(input,signal){
      const value=await call('intakeEnd',{...intakeLocator(input),runtimeSessionId:id(input.runtimeSessionId)},signal);
      if(value.ended!==true)fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');return {ended:true};
    },
    async confirmIntakeRead(input,signal){
      const value=await call('intakeReadConfirm',input,signal);
      if(value.schemaVersion!==1||value.intakeId!==input.intakePass?.intakeId||value.readConfirmed!==true)fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {readConfirmed:true};
    },
    async endRuntime(input,signal) {
      const value=await call('endRuntime',{companyId:id(input.companyId),taskId:id(input.taskId),passId:id(input.passId),
        runtimeSessionId:id(input.runtimeSessionId)},signal);
      if(value.ended!==true) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');return {ended:true};
    },
    async reportSchedule(input, signal) {
      // The server independently validates task authority and CAS. It receives
      // actual host timing/receipt only, never a claimed native automation ID.
      const fields=['companyId','taskId','bindingId','bindingRevision','sequence','threadId','cadence','timeZone','state','nextRunAt','lastCycleAt','lastCompletedAt'];
      if(!object(input) || Object.keys(input).length!==fields.length || Object.keys(input).some(key=>!fields.includes(key))
        || !ASSISTANT_CADENCES.includes(input.cadence) || !['active','paused','done','revoked'].includes(input.state)
        || (input.state==='active')!==(input.nextRunAt!==null) || typeof input.timeZone!=='string' || input.timeZone.length>100
        || ['nextRunAt','lastCycleAt','lastCompletedAt'].some(key=>input[key]!==null&&(!Number.isSafeInteger(input[key])||input[key]<0||input[key]>8_000_000_000_000_000))) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      try { new Intl.DateTimeFormat('en',{timeZone:input.timeZone}); } catch { fail('ASSISTANT_TRANSPORT_INVALID_INPUT'); }
      const body={...input,companyId:id(input.companyId),taskId:id(input.taskId),bindingId:id(input.bindingId),threadId:id(input.threadId),
        bindingRevision:revision(input.bindingRevision),sequence:revision(input.sequence)};
      const value=await call('report', body, signal);
      if(value.sequence!==input.sequence) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {sequence:revision(value.sequence)};
    },
  };
};

/** Enrollment is a durable state machine. Store the verifier before network
 * I/O, and cross an `exchanging` fence before a one-use exchange. If a response
 * is lost or storing the new credential fails, do not exchange again: the owner
 * revokes the device and creates a new enrollment. Pending 409 is a known
 * rejection of this invocation and can be checked again without reauthorizing. */
export const createAssistantPairingClient = ({ origin, store, http, now = Date.now }) => {
  origin = originOf(origin);
  if (!store || typeof http !== 'function') fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  return {
    async begin(enrollmentId, deviceName) {
      enrollmentId = id(enrollmentId);
      if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 120 || /[\x00-\x1f\x7f]/u.test(deviceName)) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      const key = { origin, kind: 'pairing', id: enrollmentId };
      let current = await store.get(key);
      if (!current) {
        current = { phase: 'prepared', verifier: randomBytes(32).toString('base64url'), deviceName };
        await store.put(key, current);
      }
      if (!['prepared','pending'].includes(current.phase) || current.deviceName !== deviceName || !/^[A-Za-z0-9_-]{43}$/u.test(current.verifier ?? '')) fail('ASSISTANT_PAIRING_RECOVERY_REQUIRED');
      if (current.phase === 'prepared') {
        const result = await http('pair', { enrollmentId, deviceName,
          challenge: createHash('sha256').update(current.verifier).digest('base64url') });
        if (!/^[A-F0-9]{8}$/u.test(result.verificationCode ?? '') || !Number.isFinite(Date.parse(result.expiresAt))) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
        current = { ...current, phase: 'pending', pairingId: id(result.pairingId), verificationCode: result.verificationCode, expiresAt: Date.parse(result.expiresAt) };
        await store.put(key, current);
      }
      if (current.expiresAt <= now()) fail('ASSISTANT_PAIRING_EXPIRED');
      return { pairingId: id(current.pairingId), verificationCode: current.verificationCode, expiresAt: current.expiresAt };
    },
    async exchange(enrollmentId) {
      const key = { origin, kind: 'pairing', id: id(enrollmentId) };
      const current = await store.get(key);
      if (!current || current.phase !== 'pending') fail('ASSISTANT_PAIRING_RECOVERY_REQUIRED');
      if (current.expiresAt <= now()) fail('ASSISTANT_PAIRING_EXPIRED');
      await store.put(key, { ...current, phase: 'exchanging' });
      let result;
      try { result = await http('exchange', { pairingId: id(current.pairingId), verifier: current.verifier }); }
      catch (error) {
        if (error instanceof AssistantTransportError && error.status === 409) {
          await store.put(key, current); return { state: 'pending' };
        }
        // Persisted `exchanging` is intentionally left terminal on uncertainty.
        // A restart cannot recreate the verifier and issue a second device.
        fail('ASSISTANT_PAIRING_RECOVERY_REQUIRED');
      }
      if (!/^tda_[A-Za-z0-9_-]{43}$/u.test(result.credential ?? '') || !Number.isFinite(Date.parse(result.expiresAt))) fail('ASSISTANT_PAIRING_RECOVERY_REQUIRED');
      const identity = { origin, assistantId: id(result.assistantUserId), deviceId: id(result.deviceId) };
      await store.put({ origin, kind: 'device', id: identity.assistantId }, { assistantId: identity.assistantId,
        deviceId: identity.deviceId, credential: result.credential, expiresAt: Date.parse(result.expiresAt) });
      await store.put(key, { phase: 'complete', ...identity }); // Erase verifier.
      return { state: 'ready', ...identity };
    },
  };
};

/** The backend owns these schemas and business authorization. This closed host
 * capability list is only a transport boundary: unknown/new server tools are
 * not exposed until the host can execute them. No input schema is copied here. */
export const ASSISTANT_MCP_READ_TOOLS = Object.freeze(["get_assistant_status", "download_attachment", "get_task_create_meta", "get_task", "get_task_sections", "get_task_instruction_page", "prepare_assistant_workspace_read", "get_assistant_owner_question", "search_agent_guidance", "get_agent_skill", "get_agent_procedure"]);
// Names only: the backend supplies current schemas and exact task/action
// authority. No human assertion, owner decision or company role is synthesized.
export const ASSISTANT_MCP_TOOLS = Object.freeze([...ASSISTANT_MCP_READ_TOOLS,
  // Native task-local mapping only. Live schema/proof/CAS remain backend-owned;
  // exposing the name does not read a provider body or create a new task.
  'bind_assistant_source_conversation',
  'connect_remote_agent_skill','doctor_remote_agent_skill','call_remote_agent_skill_tool',
  'ask_assistant_owner', 'request_assistant_action', 'complete_assistant_pass', 'prepare_assistant_workspace_run', 'continue_assistant_workspace_action',
  // Native server cancellation needs no local file/CLI adapter. Its live
  // dedicated schema and pass/own-Run checks remain backend authority; adding
  // this name never opens cancel/restore in the local Workspace dispatcher.
  'cancel_agent_workspace_run',
  // Self-repair is also server-only. The live dedicated schema selects native
  // retirement/restore under the current pass; this name grants no generic
  // history restore, filesystem reset or second mutation attempt.
  'repair_assistant_workspace_result',
  // An independent task still needs the backend's exact sealed owner decision
  // and both actors' native project-create ACL. This is the SAME generic
  // transport: no client-side creator, owner assertion or new task-pass binding.
  'create_task',
  "update_task_due_date", "update_task_assignee", "set_task_participants", "update_task_custom_field",
  "create_comment", "update_comment", "update_task_title", "update_task_description", "update_task_urgency", "update_task_status",
  "create_task_control", "update_task_control", "clear_task_control", "create_checklist", "update_checklist",
  "complete_checklist_item", "create_subtask", "create_task_relation", "delete_task_relation", "delete_checklist", "delete_attachment",
]);
/** Hook-owned admission fields never belong to the model's tool arguments.
 * Keep the live backend validators as the wire authority, while removing only
 * these root fields from model discovery. PreToolUse still injects them
 * into the raw call before the backend's mandatory validation/admission.
 * No domain schema, scope or permission is inferred/copied by this projection.
 */
const ASSISTANT_MCP_ADMISSION_FIELDS=Object.freeze(['taskPass','intakePass','runtimeSessionProof','sourceProcessingProof','encryptedMaterialWitness','encryptedContent']);
export const assistantModelInputSchema = (source,{omittedRootFields=ASSISTANT_MCP_ADMISSION_FIELDS}={}) => {
  const schema=structuredClone(source);
  let visited=0;
  const projectRoot=(node,depth=0)=>{
    if(typeof node==='boolean')return; // Valid boolean alternative schemas have no fields.
    if(!object(node))fail('ASSISTANT_MCP_INVALID_RESPONSE');
    if(++visited>512||depth>32)fail('ASSISTANT_MCP_INVALID_RESPONSE');
    // A root $ref cannot be pruned by modifying shared $defs: the same target
    // might also describe nested business data. Require a reviewed host path
    // instead of rewriting those definitions or exposing managed arguments.
    if(Object.hasOwn(node,'$ref'))fail('ASSISTANT_MCP_INVALID_RESPONSE');
    for(const key of omittedRootFields){
      if(object(node.properties))delete node.properties[key];
      if(Array.isArray(node.required))node.required=node.required.filter(value=>value!==key);
    }
    // Logical alternatives still describe the same argument root. Do NOT walk
    // properties/items/$defs: similarly named fields inside native parameters
    // are business data, not hook-owned transport fields.
    for(const key of ['anyOf','oneOf','allOf'])if(Object.hasOwn(node,key)){
      if(!Array.isArray(node[key]))fail('ASSISTANT_MCP_INVALID_RESPONSE');
      for(const branch of node[key])projectRoot(branch,depth+1);
    }
  };
  if(!object(schema))fail('ASSISTANT_MCP_INVALID_RESPONSE');
  projectRoot(schema);
  return schema;
};
/** Privacy preflight over the CURRENT native input inventory, not a copied
 * domain schema or a JSON-Schema authorization engine. Unknown closed-object
 * fields and incompatible scalar/container shapes must fail locally BEFORE
 * any managed preparation can transmit unprotected metadata. Native domain
 * refinements, format constraints, pass/proof/ACL/CAS remain independent.
 * Local refs/compositions follow the same native document; no remote resolver,
 * schema cache, input coercion, default injection or error-value echo exists. */
export const validateAssistantNativeInputShape=(nativeSchema,raw,{omittedRootFields=ASSISTANT_MCP_ADMISSION_FIELDS,
  ignoredRootFields=ASSISTANT_MCP_ADMISSION_FIELDS}={})=>{
  if(!object(nativeSchema)||nativeSchema.type!=='object'||!object(raw))fail('ASSISTANT_MCP_INVALID_RESPONSE');
  const root=assistantModelInputSchema(nativeSchema,{omittedRootFields});
  const input=Object.fromEntries(Object.entries(raw).filter(([key])=>!ignoredRootFields.includes(key)));
  let visits=0;
  const walk=(schema,value,depth=0)=>{
    if(++visits>16384||depth>64)fail('ASSISTANT_MCP_INVALID_RESPONSE');
    if(typeof schema==='boolean')return schema;
    if(!object(schema))fail('ASSISTANT_MCP_INVALID_RESPONSE');
    if(Object.hasOwn(schema,'$ref')){
      // Only a bounded JSON pointer into this exact fresh native document.
      // A cycle consumes the same traversal budget and fails closed.
      if(typeof schema.$ref!=='string'||!schema.$ref.startsWith('#/'))fail('ASSISTANT_MCP_INVALID_RESPONSE');
      let target=root;
      for(const token of schema.$ref.slice(2).split('/')){
        const key=token.replace(/~1/gu,'/').replace(/~0/gu,'~');
        if(!object(target)||!Object.hasOwn(target,key))fail('ASSISTANT_MCP_INVALID_RESPONSE');
        target=target[key];
      }
      if(!walk(target,value,depth+1))return false;
    }
    for(const key of ['allOf','anyOf','oneOf'])if(Object.hasOwn(schema,key)){
      if(!Array.isArray(schema[key])||schema[key].length===0||schema[key].length>128)fail('ASSISTANT_MCP_INVALID_RESPONSE');
      const matches=schema[key].map(branch=>walk(branch,value,depth+1));
      if(key==='allOf'?!matches.every(Boolean):!matches.some(Boolean))return false;
      // oneOf is intentionally a structural union here: overlapping native
      // format/refinement branches remain the server validator's authority.
    }
    const types=schema.type===undefined?[]:Array.isArray(schema.type)?schema.type:[schema.type];
    const matchesType=type=>type==='null'?value===null:type==='object'?object(value):type==='array'?Array.isArray(value)
      :type==='integer'?Number.isSafeInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value)
      :type==='string'||type==='boolean'?typeof value===type:false;
    if(types.length&&!types.some(matchesType))return false;
    if(typeof value==='string'&&schema.pattern!==undefined){
      // Reuse the native published syntax (UUID/date/ID patterns), never a
      // second per-field regex map. No caller/provider can select this schema.
      if(typeof schema.pattern!=='string'||schema.pattern.length>4096)fail('ASSISTANT_MCP_INVALID_RESPONSE');
      let pattern;try{pattern=new RegExp(schema.pattern,'u');}catch{fail('ASSISTANT_MCP_INVALID_RESPONSE');}
      if(!pattern.test(value))return false;
    }

    if(Object.hasOwn(schema,'const')&&JSON.stringify(schema.const)!==JSON.stringify(value))return false;
    if(Object.hasOwn(schema,'enum')){
      if(!Array.isArray(schema.enum))fail('ASSISTANT_MCP_INVALID_RESPONSE');
      if(!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))return false;
    }
    if(object(value)){
      if(schema.properties!==undefined&&!object(schema.properties))fail('ASSISTANT_MCP_INVALID_RESPONSE');
      if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.some(key=>typeof key!=='string')))
        fail('ASSISTANT_MCP_INVALID_RESPONSE');
      if(schema.required?.some(key=>!Object.hasOwn(value,key)))return false;
      for(const [key,child]of Object.entries(value)){
        if(Object.hasOwn(schema.properties??{},key)){
          if(!walk(schema.properties[key],child,depth+1))return false;
        }else if(schema.additionalProperties===false)return false;
        else if(object(schema.additionalProperties)&&!walk(schema.additionalProperties,child,depth+1))return false;
      }
    }else if(Array.isArray(value)){
      const prefix=schema.prefixItems??(Array.isArray(schema.items)?schema.items:null);
      if(prefix!==null&&!Array.isArray(prefix))fail('ASSISTANT_MCP_INVALID_RESPONSE');
      for(let index=0;index<value.length;index++){
        const child=prefix&&index<prefix.length?prefix[index]
          :prefix&&Array.isArray(schema.items)?schema.additionalItems:schema.items;
        if(child!==undefined&&!walk(child,value[index],depth+1))return false;
      }
    }
    return true;
  };
  if(!walk(root,input))fail('ASSISTANT_MCP_INPUT_INVALID');
};
export const createAssistantMcpClient = ({ origin, assistantId, deviceId, store, httpRequest, materializeAttachment,
  materializeEncryptedTask, materializeEncryptedSkill, withWorkspaceArguments, readActivePass=null, materializeSourceIntake=null, presentationProfile='task', timeoutMs = 30_000 }) => {
  if (!['task','remote_mcp','skill_setup'].includes(presentationProfile)) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  origin = originOf(origin); assistantId = id(assistantId); deviceId = id(deviceId);
  if (!store || typeof store.get !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) fail("ASSISTANT_TRANSPORT_INVALID_INPUT");
  const selectedTools=async()=>{
    const pass=typeof readActivePass==='function'?await readActivePass():null;
    return pass?.kind==='source_intake'?['get_assistant_intake_context','resolve_assistant_intake']:presentationProfile==='remote_mcp'
      ?['get_assistant_status','connect_remote_agent_skill','doctor_remote_agent_skill','call_remote_agent_skill_tool','get_task','get_task_instruction_page','ask_assistant_owner','get_assistant_owner_question','request_assistant_action']
      :presentationProfile==='skill_setup'?['get_assistant_status','get_task','get_task_instruction_page','get_agent_skill','get_assistant_owner_question','ask_assistant_owner','request_assistant_action','continue_assistant_workspace_action']
      :ASSISTANT_MCP_TOOLS.filter(name=>!['connect_remote_agent_skill','doctor_remote_agent_skill','call_remote_agent_skill_tool'].includes(name));
  };
  const perform = async (action, signal, operationTimeoutMs = timeoutMs) => {
    const deadline = AbortSignal.timeout(operationTimeoutMs);
    const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const protocol = await import("./trelio-remote-mcp.mjs");
      const request = httpRequest ?? protocol.remoteMcpHttpRequest;
      const credential = await loadAssistantDeviceCredential({ origin, assistantId, deviceId, store });
      if (boundedSignal.aborted) fail("ASSISTANT_MCP_UNAVAILABLE");
      // A trusted internal authentication profile, not a personal PAT/OAuth
      // declaration. The public provider-config validator still rejects it.
      const active=typeof readActivePass==='function'?await readActivePass():null;
      // This only narrows a single native MCP session's presentation. Every
      // handler retains its genuine pass/proof/ACL checks independently.
      const config = { endpoint: `${origin}/mcp/assistant`, protocolVersion: "2025-06-18", headers: active?.kind==='source_intake'
        ?{'x-trelio-assistant-capability-profile':'source_intake'}:["remote_mcp","skill_setup"].includes(presentationProfile)?{'x-trelio-assistant-capability-profile':presentationProfile}:{},
        authentication: { type: "assistant_device" } };
      const session = await protocol.createRemoteSession(config, credential, request, { signal: boundedSignal });
      try { return await action({ protocol, config, credential, session, request, signal: boundedSignal }); }
      finally { await protocol.closeRemoteSession(config, credential, session.sessionId, request, { signal: boundedSignal }); }
    } catch (error) {
      if (error instanceof AssistantTransportError) throw error;
      if (/^REMOTE_MCP_[A-Z_]{1,100}$/u.test(error?.code ?? '')) fail(error.code);
      // Raw HTTP/JSON-RPC errors may contain paths or upstream detail. Preserve
      // the private credential and queue; never login or retry a tools/call.
      fail("ASSISTANT_MCP_UNAVAILABLE");
    }
  };
  return {
    async listTools(signal) {
      return perform(async ({ protocol, config, credential, session, request, signal }) => {
        const tools = await protocol.listRemoteTools(config, credential, session, request, { signal });
        const allowed=await selectedTools(),seen = new Set();
        const selected = tools.filter(tool => allowed.includes(tool?.name)
          && (tool.name !== "download_attachment" || typeof materializeAttachment === "function")).map(tool => {
          if (seen.has(tool.name) || typeof tool.description !== "string" || tool.description.length > 4096
            || !object(tool.inputSchema) || tool.inputSchema.type !== "object") fail("ASSISTANT_MCP_INVALID_RESPONSE");
          seen.add(tool.name);
          // Do not proxy remote App metadata, URLs or OAuth security schemes.
          return { name: tool.name, description: tool.description, inputSchema: assistantModelInputSchema(tool.inputSchema),
            annotations: { readOnlyHint: tool.name==='get_assistant_intake_context'||ASSISTANT_MCP_READ_TOOLS.includes(tool.name), destructiveHint: tool.annotations?.destructiveHint===true,
              idempotentHint: tool.annotations?.idempotentHint===true, openWorldHint: false } };
        });
        if (!seen.has(allowed.includes("get_assistant_status")?"get_assistant_status":"get_assistant_intake_context") || JSON.stringify(selected).includes(credential) || Buffer.byteLength(JSON.stringify(selected)) > 65_536) fail("ASSISTANT_MCP_INVALID_RESPONSE");
        return selected;
      }, signal);
    },
    async callTool(name, args, signal) {
      if (![...ASSISTANT_MCP_TOOLS,"get_assistant_intake_context","resolve_assistant_intake"].includes(name) || name === "download_attachment" && typeof materializeAttachment !== "function" || !object(args) || Buffer.byteLength(JSON.stringify(args)) > 65_536) fail("ASSISTANT_CAPABILITY_UNAVAILABLE");
      // Snapshot once before asynchronous private/network I/O, as in the shared
      // Remote MCP transport. A mutable caller cannot replace reviewed args.
      const argumentsSnapshot = JSON.parse(JSON.stringify(args));
      return perform(async ({ protocol, config, credential, session, request, signal }) => {
        const allowed=await selectedTools();
        if(!allowed.includes(name)&&name!=='get_assistant_status')fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
        // Fetch the exact native schema in this SAME session/deadline. A prior
        // model catalogue or mutable caller never becomes staging authority.
        // The request contains no caller arguments and no business mutation.
        const catalog=await protocol.listRemoteTools(config,credential,session,request,{signal});
        if(Buffer.byteLength(JSON.stringify(catalog))>65_536)fail('ASSISTANT_MCP_INVALID_RESPONSE');
        const definitions=catalog.filter(tool=>tool?.name===name);
        if(definitions.length!==1)fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
        validateAssistantNativeInputShape(definitions[0].inputSchema,argumentsSnapshot);
        if(name==='request_assistant_action'&&argumentsSnapshot.operation==='setup_skill_account'){
          normalizeAssistantSkillAccountSetupFields(argumentsSnapshot.fields);
        }else if(name==='request_assistant_action'&&argumentsSnapshot.operation==='accept_skill_runtime'){
          // This native-only owner action has no ordinary human task mutation
          // alias. Its SAME pure structural parser closes generic fields before
          // any plain send or encrypted preparation HTTP.
          normalizeAssistantSkillConsentFields(argumentsSnapshot.fields);
        }else if(name==='request_assistant_action'&&argumentsSnapshot.operation==='create_company_secret'){
          if(!assistantNeutralCompanySecret(argumentsSnapshot.fields))fail('ASSISTANT_MCP_INPUT_INVALID');
        }else if(name==='request_assistant_action'&&argumentsSnapshot.operation!=='create_private_secret'){
          // Native action planning reuses the ordinary operation's schema for
          // its generic fields record. Apply that SAME live inventory here;
          // wrapper metadata is omitted, never supplied/faked by the model.
          const operation=catalog.filter(tool=>tool?.name===argumentsSnapshot.operation);
          if(operation.length!==1||!ASSISTANT_MCP_TOOLS.includes(argumentsSnapshot.operation))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
          if(!object(argumentsSnapshot.fields))fail('ASSISTANT_MCP_INPUT_INVALID');
          validateAssistantNativeInputShape(operation[0].inputSchema,argumentsSnapshot.fields,{
            omittedRootFields:[...ASSISTANT_MCP_ADMISSION_FIELDS,'clientRequestId','expectedTaskUpdatedAt','ownerDecisionId'],ignoredRootFields:[]});
        }

        const send=async wireArguments=>{
          // The public input bound was checked before protection. Ciphertext
          // adds only the standard bounded envelope/base64 overhead; this is
          // not a larger model input or a caller-controlled wire override.
          if(Buffer.byteLength(JSON.stringify(wireArguments))>96*1024)fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
          const response=await request({config,credential,sessionId:session.sessionId,payload:{
            jsonrpc:"2.0",id:session.nextRequestId(),method:"tools/call",params:{name,arguments:wireArguments},
          }},{signal});
          return protocol.assertJsonRpcResult(response,"tools/call");
        };
        const value=typeof withWorkspaceArguments==='function'
          ? await withWorkspaceArguments({name,args:argumentsSnapshot,signal},send) : await send(argumentsSnapshot);

        if (!object(value) || !Array.isArray(value.content) || value.content.length > 20
          || value.content.some(item => !object(item) || item.type !== "text" || typeof item.text !== "string")
          || (value.structuredContent !== undefined && !object(value.structuredContent))
          || (value.isError !== undefined && typeof value.isError !== "boolean")
          || JSON.stringify(value).includes(credential) || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) fail("ASSISTANT_MCP_INVALID_RESPONSE");
        if(name==='get_assistant_intake_context'&&value.isError!==true){
          if(typeof materializeSourceIntake!=='function')fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
          return materializeSourceIntake({result:value,arguments:argumentsSnapshot,signal});
        }
        // Binary plans never enter model context. The trusted production
        // callback composes the common device/pass HTTP profile and private
        // local-file primitive under this same non-renewable MCP deadline.
        if (name === "download_attachment" && value.isError !== true) return materializeAttachment({
          result: value, attachmentId: argumentsSnapshot.attachmentId, signal });
        // A native refusal selects the encrypted transport BEFORE reading any
        // content. Do not give the model markers/an executable plan or treat
        // the refusal as complete authority. One current signed invocation
        // uses the SAME exact reader/hydrator within this original deadline.
        if(value.isError===true && value.structuredContent?.code==='ASSISTANT_ENCRYPTED_TASK_READ_REQUIRED'){
          if(typeof materializeEncryptedTask!=='function' || value.structuredContent.localRead?.nativeTool!==name)fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
          await validateAssistantEncryptedTaskRead({descriptor:value.structuredContent.localRead,
            identity:{origin,assistantId,deviceId}});
          return materializeEncryptedTask({descriptor:structuredClone(value.structuredContent.localRead),name,signal});
        }
        if(value.isError===true && value.structuredContent?.code==='ASSISTANT_ENCRYPTED_SKILL_READ_REQUIRED'){
          if(name!=='get_agent_skill'||typeof materializeEncryptedSkill!=='function')fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
          const descriptor=validateAssistantEncryptedSkillRead(value.structuredContent.localRead);
          return materializeEncryptedSkill({descriptor,signal});
        }
        return { content: value.content.map(({ type, text }) => ({ type, text })),
          ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }),
          ...(value.isError === undefined ? {} : { isError: value.isError }) };
      }, signal, name==='connect_remote_agent_skill'?10*60*1000:timeoutMs);
    },
  };
};

/** Closed native result only; never a model request or persisted routing cache.
 * The common origin validator is reused before credential/private-key I/O.
 * Native pass checks are repeated by the private profile and by every server
 * snapshot, so these coordinates confer no domain authority on their own. */
export const validateAssistantEncryptedTaskRead = async ({descriptor,identity,pass}) => {
  if(!object(descriptor) || Object.keys(descriptor).sort().join(',')!==
    'arguments,assistantUserId,companyId,deviceId,nativeTool,passId,requestOrigin,schemaVersion,taskId'
    || descriptor.schemaVersion!==1 || !['get_task','get_task_instruction_page','get_task_sections'].includes(descriptor.nativeTool)
    || !object(descriptor.arguments) || ['taskPass','runtimeSessionProof','knownInstructionLayerKeys'].some(key=>Object.hasOwn(descriptor.arguments,key))
    || descriptor.assistantUserId!==identity.assistantId || descriptor.deviceId!==identity.deviceId
    || ['companyId','taskId','passId'].some(key=>!UUID.test(descriptor[key]??'') || pass && descriptor[key]!==pass[key]))fail('ASSISTANT_MCP_INVALID_RESPONSE');
  const common=await import('./trelio-workspace.mjs');
  let requestOrigin;try{requestOrigin=common.resolveEncryptedDataPlaneOrigin(identity.origin,descriptor.requestOrigin);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
  if(requestOrigin!==descriptor.requestOrigin)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
  const args=structuredClone(descriptor.arguments);
  const locators=descriptor.nativeTool==='get_task_instruction_page'?args.tasks:[args];
  if(!Array.isArray(locators) || locators.length!==1 || !object(locators[0]))fail('ASSISTANT_MCP_INVALID_RESPONSE');
  const {companySlug,projectSlug,taskNumber}=locators[0];
  if(![companySlug,projectSlug].every(value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value))
    || !Number.isSafeInteger(Number(taskNumber)) || Number(taskNumber)<=0)fail('ASSISTANT_MCP_INVALID_RESPONSE');
  const suffix=descriptor.nativeTool==='get_task_sections'
    ? `/tasks/${encodeURIComponent(projectSlug)}/${Number(taskNumber)}/sections/read`:'/tasks/read';
  return Object.freeze({...structuredClone(descriptor),arguments:args,companySlug,
    paths:Object.freeze([`/api/agent-workspaces/company-context/${encodeURIComponent(companySlug)}${suffix}`])});
};

/** The native accepted-read result selects only this pass's canonical
 * Workspace and production data-plane origin. It contains no key, payload ID,
 * path, user-authored command or permission to mutate/history-read anything.
 */
export const validateAssistantEncryptedInspection = async ({descriptor,identity,pass}) => {
  if(!object(descriptor) || Object.keys(descriptor).sort().join(',')!=='companyId,companySlug,requestOrigin,schemaVersion,workspaceId'
    || descriptor.schemaVersion!==1 || descriptor.companyId!==pass.companyId || !UUID.test(descriptor.workspaceId??'')
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(descriptor.companySlug??''))fail('ASSISTANT_MCP_INVALID_RESPONSE');
  const common=await import('./trelio-workspace.mjs');
  let selected;try{selected=common.resolveEncryptedDataPlaneOrigin(identity.origin,descriptor.requestOrigin);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
  if(selected!==descriptor.requestOrigin)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
  return Object.freeze(structuredClone(descriptor));
};

/** Native-selected ciphertext coordinates only. Filenames, MIME, plaintext
 * hashes and full storage keys remain inside the authenticated container. The
 * ordinary upload and accepted-Workspace reference have DIFFERENT AAD types;
 * neither can be substituted for the other from a model-supplied attachment. */
export const validateAssistantEncryptedAttachment = async (value,origin) => {
  const keys='aad,attachmentId,companyId,companySlug,delivery,requestOrigin,revision,schemaVersion,sha256,sizeBytes,taskId';
  const aad=value?.aad;
  if(!object(value)||Object.keys(value).sort().join(',')!==keys||value.schemaVersion!==2||value.delivery!=='assistant-encrypted-local-file'
    ||['companyId','taskId','attachmentId'].some(key=>!UUID.test(value[key]??''))||!/^[A-Za-z0-9_-]{1,128}$/u.test(value.companySlug??'')
    ||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<12||value.sizeBytes>25*1024*1024+108
    ||!(/^[a-f0-9]{64}$/u).test(value.sha256??'')||!(/^[a-f0-9]{64}$/u).test(value.revision??'')
    ||!object(aad)||Object.keys(aad).sort().join(',')!=='companyId,entityId,entityRevision,entityType,purpose,schemaVersion,scopeEpoch,scopeId,suite'
    ||aad.suite!=='trelio-e2ee-v1'||aad.companyId!==value.companyId||!UUID.test(aad.scopeId??'')||!UUID.test(aad.entityId??'')
    ||!Number.isSafeInteger(aad.scopeEpoch)||aad.scopeEpoch<1||aad.entityRevision!==1||aad.schemaVersion!==1||aad.purpose!=='file'
    ||!['file.task_attachments','agent_workspace_browser_file'].includes(aad.entityType))fail('ASSISTANT_ATTACHMENT_DESCRIPTOR_INVALID');
  const common=await import('./trelio-workspace.mjs');
  try{if(common.resolveEncryptedDataPlaneOrigin(origin,value.requestOrigin)!==value.requestOrigin)throw new Error();}
  catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
  return Object.freeze(structuredClone(value));
};

const encryptedWorkspaceArgumentBinding = value => {
  if(!object(value) || Object.keys(value).sort().join(',')!==
    'assistantUserId,companyId,deviceId,fencingToken,operation,passId,runId,taskId,workspaceId'
    || !['checkpoint','finish','pause'].includes(value.operation)
    || !Number.isSafeInteger(value.fencingToken) || value.fencingToken<1
    || ['assistantUserId','companyId','deviceId','passId','runId','taskId','workspaceId'].some(key=>!UUID.test(value[key]??'')))
    fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]]));
};
const assertWorkspaceArgumentContext = (binding,context) => {
  if(context?.runtime?.company?.id!==binding.companyId || context.runtime.viewer?.userId!==binding.assistantUserId
    || context.runtime.state!=='encrypted' || context.runtime.accessState!=='ready'
    || !UUID.test(context.runtime.device?.id??'') || !UUID.test(context.runtime.scope?.id??'')
    || !Number.isSafeInteger(context.runtime.scope.epoch) || context.runtime.scope.epoch<1
    || context.runtime.device.fingerprint!==context.device?.fingerprint
    || context.runtime.envelope?.recipientType!=='agent_device' || context.runtime.envelope.recipientId!==context.runtime.device.id
    || context.runtime.envelope.scopeId!==context.runtime.scope.id || context.runtime.envelope.scopeEpoch!==context.runtime.scope.epoch)
    fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
};

/** Process-only protection for the ordinary typed continuation parameters.
 * The caller must first validate its original local plan and genuine native
 * pass/own Run. This codec neither admits a tool nor enables an HTTP route.
 * Reuse the SAME field payload/signature codec; never send summary/evidence to
 * remote MCP while waiting for an encrypted-capability refusal. No temporary
 * field, second vault, human key or new cryptographic wire format is created.
 */
export const sealAssistantWorkspaceArguments = async ({binding:rawBinding,parameters,companyEncryption}) => {
  const binding=encryptedWorkspaceArgumentBinding(rawBinding);
  assertWorkspaceArgumentContext(binding,companyEncryption);
  if(!object(parameters))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  let serialized;
  try{serialized=JSON.stringify(parameters);}catch{fail('ASSISTANT_WORKSPACE_PLAN_INVALID');}
  // Keep the existing one-MiB ordinary local action process boundary. The
  // independently bounded remote request still counts encoded ciphertext.
  if(Buffer.byteLength(serialized)>1024*1024)fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  const crypto=await import('./trelio-company-encryption.mjs'),common=await import('./trelio-workspace.mjs');
  // Keep the existing AAD codec unchanged: pass UUID fits the native 64-byte
  // entityType bound, Run UUID is entityId and the current fence is revision.
  // The complete device/task/Workspace tuple is additionally checked inside
  // the encrypted body. No custom AAD extension or crypto suite is introduced.
  const aad={companyId:binding.companyId,scopeId:companyEncryption.runtime.scope.id,
    scopeEpoch:companyEncryption.runtime.scope.epoch,entityType:`assistant.local_${binding.operation}.${binding.passId}`,
    entityId:binding.runId,entityRevision:binding.fencingToken,schemaVersion:1,purpose:'content'};
  const payload={...await crypto.encryptCompanyPayload({payload:{schemaVersion:1,binding,parameters:JSON.parse(serialized)},
    scopePublicEncryptionJwk:companyEncryption.runtime.scope.publicEncryptionJwk,aad}),
    scopeId:aad.scopeId,scopeEpoch:aad.scopeEpoch,entityType:aad.entityType,entityId:aad.entityId,
    entityRevision:aad.entityRevision,writerDeviceId:companyEncryption.runtime.device.id};
  payload.signature=await crypto.signCompanyEncryptionRecord(companyEncryption.device.privateKeys.signingPrivateKey,
    common.buildAgentEncryptedPayloadSignatureRecord(payload));
  return {schemaVersion:1,payload};
};

export const openAssistantWorkspaceArguments = async ({binding:rawBinding,sealed,companyEncryption}) => {
  const binding=encryptedWorkspaceArgumentBinding(rawBinding);
  assertWorkspaceArgumentContext(binding,companyEncryption);
  if(!object(sealed) || Object.keys(sealed).sort().join(',')!=='payload,schemaVersion' || sealed.schemaVersion!==1)
    fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
  try{if(Buffer.byteLength(JSON.stringify(sealed))>2*1024*1024)fail('ASSISTANT_WORKSPACE_PLAN_INVALID');}
  catch{fail('ASSISTANT_WORKSPACE_PLAN_INVALID');}
  const payload=sealed.payload,scope=companyEncryption.runtime.scope;
  const fields='aad,ciphertext,ciphertextSha256,entityId,entityRevision,entityType,nonce,schemaVersion,scopeEpoch,scopeId,signature,suite,wrappedDataKey,writerDeviceId';
  if(!object(payload) || Object.keys(payload).filter(key=>key!=='writerIdentityId').sort().join(',')!==fields
    || Object.hasOwn(payload,'writerIdentityId') && payload.writerIdentityId!==null
    || payload.writerDeviceId!==companyEncryption.runtime.device.id
    || payload.scopeId!==scope.id || payload.scopeEpoch!==scope.epoch
    || payload.entityType!==`assistant.local_${binding.operation}.${binding.passId}` || payload.entityId!==binding.runId
    || payload.entityRevision!==binding.fencingToken || payload.aad?.companyId!==binding.companyId
    || payload.aad?.scopeId!==scope.id || payload.aad?.scopeEpoch!==scope.epoch
    || payload.aad?.entityType!==payload.entityType || payload.aad?.entityId!==binding.runId
    || payload.aad?.entityRevision!==binding.fencingToken || payload.aad?.schemaVersion!==1 || payload.aad?.purpose!=='content'
    || Object.keys(payload.aad).sort().join(',')!=='companyId,entityId,entityRevision,entityType,purpose,schemaVersion,scopeEpoch,scopeId,suite')
    fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  const crypto=await import('./trelio-company-encryption.mjs'),common=await import('./trelio-workspace.mjs');
  let opened;
  try{
    if(!await crypto.verifyCompanyEncryptionRecord(companyEncryption.device.publicSigningJwk,
      common.buildAgentEncryptedPayloadSignatureRecord(payload),payload.signature))fail('ASSISTANT_WORKSPACE_PLAN_INVALID');
    opened=await crypto.decryptCompanyPayload({encryptedPayload:payload,
      scopePrivateKey:companyEncryption.scopePrivateEncryptionKey.privateKey,
      scopePrivateJwk:companyEncryption.scopePrivateEncryptionKey.privateJwk});
  }catch{fail('ASSISTANT_WORKSPACE_PLAN_INVALID');}
  if(!object(opened) || Object.keys(opened).sort().join(',')!=='binding,parameters,schemaVersion'
    || opened.schemaVersion!==1 || JSON.stringify(opened.binding)!==JSON.stringify(binding)
    || !object(opened.parameters) || Buffer.byteLength(JSON.stringify(opened.parameters))>1024*1024)
    fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  return opened.parameters;
};

// Field authority is the SAME bounded native envelope for exact task and
// accepted-Workspace reads. A bundle never becomes a generic payload cache:
// only the selected snapshot's references can be opened by the common codec.
const readAssistantEncryptedSnapshotResponse=async(response,common)=>{
  // Apply the existing native snapshot bound while reading, BEFORE JSON
  // allocation. The same decoder serves task and accepted-Workspace snapshots;
  // a declared length is never trusted instead of the actual streamed bytes.
  const bytes=await common.readBoundedResponseBuffer(response,32*1024*1024,'Assistant encrypted snapshot');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{fail('ASSISTANT_MCP_INVALID_RESPONSE');}finally{bytes.fill(0);}
};
const readAssistantEncryptedSnapshotBundle=(bundle,companyEncryption,companyId)=>{
  if(!object(bundle) || bundle.schemaVersion!==1 || !object(bundle.context) || !Array.isArray(bundle.encryptedPayloads)
    || bundle.encryptedPayloads.length>4096 || Buffer.byteLength(JSON.stringify(bundle))>32*1024*1024)fail('ASSISTANT_MCP_INVALID_RESPONSE');
  const payloads=new Map();
  for(const payload of bundle.encryptedPayloads){
    if(!object(payload) || !UUID.test(payload.entityId??'') || payloads.has(payload.entityId)
      || payload.aad?.companyId!==companyId || payload.scopeId!==companyEncryption.runtime.scope.id
      || payload.scopeEpoch!==companyEncryption.runtime.scope.epoch
      || payload.aad?.scopeId!==payload.scopeId || payload.aad?.scopeEpoch!==payload.scopeEpoch
      || payload.aad?.entityId!==payload.entityId || payload.aad?.entityType!==payload.entityType
      || payload.aad?.entityRevision!==payload.entityRevision)fail('ASSISTANT_MCP_INVALID_RESPONSE');
    payloads.set(payload.entityId,payload);
  }
  return {context:bundle.context,payloads};
};

/** Reuse the native exact-task projection and SAME crypto engine. Bundled
 * ciphertext is process-only; it is neither a new mirror/cache nor permission
 * to resolve arbitrary payload IDs. Only the native snapshot's requested
 * batches may be opened, with common signature/AAD/field validation intact. */
export const materializeAssistantEncryptedTask = async ({origin,descriptor,signal,common,context,assertCurrent}) => {
  if(typeof assertCurrent!=='function')fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
  await assertCurrent(signal);
  common??=await import('./trelio-workspace.mjs');
  context??=await import('./trelio-local-context.mjs');
  const token=await common.requireToken(origin);
  const companyEncryption=await common.ensureCompanyEncryptionContext({origin,token,
    company:{id:descriptor.companyId,slug:descriptor.companySlug},
    collectEncryptionKey:async()=>fail('ASSISTANT_WORKSPACE_PROFILE_DENIED')});
  if(!companyEncryption || companyEncryption.runtime.viewer?.userId!==descriptor.assistantUserId
    || companyEncryption.runtime.company.id!==descriptor.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  let payloads=null;
  const requestJson=async(pathname,body)=>{
    if(!descriptor.paths.includes(pathname))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
    const response=await common.request(descriptor.requestOrigin,token,pathname,{method:'POST',signal,
      headers:{'content-type':'application/json'},body:JSON.stringify({...body,recipientDeviceId:companyEncryption.runtime.device.id})});
    const bundle=await readAssistantEncryptedSnapshotResponse(response,common);
    const opened=readAssistantEncryptedSnapshotBundle(bundle,companyEncryption,descriptor.companyId);
    payloads=opened.payloads;return opened.context;
  };
  const hydrate=value=>common.hydrateAgentCompanyEncryptedJson({value,origin,token,companyEncryption,signal,
    resolvePayloads:async ids=>{
      if(!payloads || ids.some(id=>!payloads.has(id)))fail('ASSISTANT_MCP_INVALID_RESPONSE');
      return {payloads:ids.map(id=>payloads.get(id))};
    }});
  const args=descriptor.arguments;
  const result=descriptor.nativeTool==='get_task_sections'
    ? await context.getTaskSectionsFromProvider({origin,token,companyEncryption,mirror:{company:{slug:descriptor.companySlug}},
      rawInput:args,signal,fresh:true,requestJson,hydrate})
    : await context.readFreshExactTaskContext({origin,companySlug:descriptor.companySlug,nativeTool:descriptor.nativeTool,
      input:args,provider:{requestOrigin:descriptor.requestOrigin,token,companyEncryption},signal,requestJson,hydrate});
  signal?.throwIfAborted();
  await assertCurrent(signal);
  const {compactLocalNativeMcpResult}=await import('./trelio-mcp-results.mjs');
  const {buildLocalTaskReadToolResult}=await import('./trelio-task-read-budget.mjs');
  return compactLocalNativeMcpResult(descriptor.nativeTool,descriptor.nativeTool==='get_task_sections'
    ? {structuredContent:result,content:[{type:'text',text:'Read the selected task sections from structuredContent.'}]}
    : buildLocalTaskReadToolResult(result),args);
};

/** Read one fixed, authenticated original under the active Workspace profile.
 * A remote descriptor cannot choose an origin, route, local destination or
 * header. Only its exact native task/attachment revision selects the bytes.
 * Buffering is bounded by the existing local-file limit and never returned by
 * MCP; permissions, one-hour lease and cleanup remain in the shared primitive. */
export const materializeAssistantAttachment = async ({ result, attachmentId, origin, signal,
  common, attachments, prepareEncryptedRead }) => {
  common ??= await import('./trelio-workspace.mjs');
  attachments ??= await import('./trelio-local-attachments.mjs');
  const value=result?.structuredContent;
  if(value?.schemaVersion===2){
    const selected=await validateAssistantEncryptedAttachment(value,origin);
    if(selected.attachmentId!==id(attachmentId)||typeof prepareEncryptedRead!=='function')fail('ASSISTANT_ATTACHMENT_DESCRIPTOR_INVALID');
    let response,bytes;
    try{
      signal?.throwIfAborted();
      if(common.currentWorkspaceExecutionProfile()?.kind!=='digital_assistant')fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
      const encryption=await prepareEncryptedRead(selected),token=await common.requireToken(origin);
      const pathname=`/api/agent-workspaces/scopes/task/${selected.taskId}/attachments/${selected.attachmentId}?revision=${selected.revision}`;
      response=await common.request(selected.requestOrigin,token,pathname,{signal,maximumErrorResponseBytes:16*1024});
      if(response.status!==200||response.redirected===true||response.headers.has('content-range')
        ||response.headers.get('content-length')!==String(selected.sizeBytes)||response.headers.get('x-trelio-attachment-sha256')!==selected.sha256
        ||response.headers.get('x-trelio-attachment-revision')!==selected.revision
        ||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/octet-stream'
        ||!['','identity'].includes(response.headers.get('content-encoding')??''))fail('ASSISTANT_ATTACHMENT_SOURCE_CHANGED');
      bytes=await common.readBoundedResponseBuffer(response,25*1024*1024+108,'Encrypted attachment');
      if(bytes.length!==selected.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==selected.sha256)fail('ASSISTANT_ATTACHMENT_SOURCE_CHANGED');
      const context=await import('./trelio-local-context.mjs');
      // Reuse the SAME TRELIOE1 parser/HPKE codec and private-file publication.
      // The exact full header AAD is checked BEFORE any decryption; the live
      // pass/current recipient is read again after opening and before writing.
      return await context.openLocalActionAttachmentResult({origin,token,companyEncryption:encryption,signal,
        result:{structuredContent:{taskId:selected.taskId,attachmentId:selected.attachmentId,revision:selected.revision},content:[]},
        readCiphertext:async()=>bytes,expectedCiphertextSha256:selected.sha256,
        validateHeader:header=>{if(Object.keys(header.aad??{}).sort().join(',')!==Object.keys(selected.aad).sort().join(',')
          ||Object.keys(selected.aad).some(key=>header.aad[key]!==selected.aad[key]))fail('ASSISTANT_ATTACHMENT_SOURCE_CHANGED');},
        assertCurrent:()=>prepareEncryptedRead(selected),materialize:attachments.materializeLocalAttachment});
    }catch(error){
      if(error instanceof AssistantTransportError)throw error;
      fail('ASSISTANT_ATTACHMENT_DOWNLOAD_UNAVAILABLE');
    }finally{bytes?.fill(0);if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>undefined);}
  }
  const fields=['schemaVersion','delivery','taskId','attachmentId','originalName','mimeType','sizeBytes','sha256','revision'];
  if(!object(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))
    ||value.schemaVersion!==1||value.delivery!=='assistant-local-file'||!UUID.test(value.taskId??'')
    ||!UUID.test(value.attachmentId??'')||value.attachmentId.toLowerCase()!==id(attachmentId)
    ||typeof value.originalName!=='string'||!value.originalName.length||value.originalName.length>255
    ||typeof value.mimeType!=='string'||!value.mimeType.length||value.mimeType.length>255
    ||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<0||value.sizeBytes>attachments.LOCAL_ATTACHMENT_MAX_BYTES
    ||!(/^[a-f0-9]{64}$/u).test(value.sha256??'')||!(/^[a-f0-9]{64}$/u).test(value.revision??'')) fail('ASSISTANT_ATTACHMENT_DESCRIPTOR_INVALID');
  let response,bytes;
  try {
    signal?.throwIfAborted();
    if(common.currentWorkspaceExecutionProfile()?.kind!=='digital_assistant')fail('ASSISTANT_WORKSPACE_PROFILE_DENIED');
    const token=await common.requireToken(origin);
    const pathname=`/api/agent-workspaces/scopes/task/${value.taskId}/attachments/${value.attachmentId}?revision=${value.revision}`;
    response=await common.request(origin,token,pathname,{signal,maximumErrorResponseBytes:16*1024});
    // Refuse redirects/encoding, unexpected bytes or a changed snapshot before
    // allocating or creating a local file. The shared profile rejects redirects
    // before credentials leave the admitted endpoint; no public URL fallback.
    if(response.status!==200||response.redirected===true||response.headers.has('content-range')
      ||response.headers.get('content-length')!==String(value.sizeBytes)
      ||response.headers.get('x-trelio-attachment-sha256')!==value.sha256
      ||response.headers.get('x-trelio-attachment-revision')!==value.revision
      ||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/octet-stream'
      ||!['', 'identity'].includes(response.headers.get('content-encoding')??'')) fail('ASSISTANT_ATTACHMENT_SOURCE_CHANGED');
    bytes=await common.readBoundedResponseBuffer(response,attachments.LOCAL_ATTACHMENT_MAX_BYTES,'Attachment');
    signal?.throwIfAborted();
    if(bytes.length!==value.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==value.sha256) fail('ASSISTANT_ATTACHMENT_SOURCE_CHANGED');
    const file=await attachments.materializeLocalAttachment({bytes,originalName:value.originalName,signal});
    // Explicit projection discards server TextContent; it cannot smuggle bytes,
    // credentials, App links or arbitrary instructions through a second copy.
    return attachments.buildLocalAttachmentFileResult({result:{structuredContent:value,content:[]},opened:value,file});
  } catch(error) {
    if(error instanceof AssistantTransportError)throw error;
    if(error?.code==='ASSISTANT_ATTACHMENT_SOURCE_CHANGED')fail(error.code);
    fail('ASSISTANT_ATTACHMENT_DOWNLOAD_UNAVAILABLE');
  } finally {
    bytes?.fill(0);
    if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>undefined);
  }
};

// BEGIN GENERATED ASSISTANT WORKSPACE POLICY
// Generated portable assistant Workspace route/proof policy. Do not edit by hand.
/** Portable closed route/proof policy. Backend and host generate one copy of
 * this pure algorithm; it contains no credential, DB or network capability. */
export class AssistantWorkspacePolicyError extends Error {
    code = "ASSISTANT_WORKSPACE_SCOPE_DENIED";
    constructor() { super("Assistant Workspace route is unavailable."); }
}
export const ASSISTANT_WORKSPACE_PREFIX = "/api/digital-assistants/runtime/workspace";
export const ASSISTANT_WORKSPACE_PROOF_TOOL = "assistant_workspace_data_plane";
export const ASSISTANT_WORKSPACE_RECIPIENT_HEADER = "x-trelio-assistant-encryption-device";
const assistantWorkspacePolicyDenied = () => new AssistantWorkspacePolicyError();
// Mount the existing native handlers, but admit only this reviewed data plane.
// New routes added to the human plugin do not silently become assistant tools,
// especially restore/cancel, secrets, company context, grants and proposals.
const assistantWorkspaceReadPaths = new Set([
    "/bridge-compatibility", "/bridge-routing",
    "/scopes/:scopeType/:scopeId/attachments/:attachmentId",
    "/scopes/:scopeType/:scopeId", "/workspaces/:workspaceId", "/workspaces/:workspaceId/runs/:runId",
    "/workspaces/:workspaceId/read-snapshot", "/workspaces/:workspaceId/bundle", "/workspaces/:workspaceId/file",
    "/workspaces/:workspaceId/encrypted-bundle",
    "/runs/:runId/encrypted-bundle", "/runs/:runId/context/:dependencyKind/encrypted-bundle",
    "/runs/:runId/context/related/:relatedWorkspaceId/encrypted-bundle",
    "/runs/:runId/encrypted-storage", "/runs/:runId/encrypted-storage/uploads/:uploadId",
    "/runs/:runId/encrypted-storage/publication",
    "/runs/:runId/bundle", "/runs/:runId/file", "/runs/:runId/objects/:sha256", "/runs/:runId/codex-conversation",
    "/runs/:runId/context/:dependencyKind/bundle", "/runs/:runId/context-objects/:dependencyWorkspaceId",
    "/runs/:runId/context/related/:relatedWorkspaceId/bundle",
]);
const assistantWorkspaceWritePaths = new Map([
    ["POST /scopes/:scopeType/:scopeId", "ensure"], ["POST /workspaces/:workspaceId/runs", "start"],
    ["POST /runs/:runId/heartbeat", "heartbeat"], ["POST /runs/:runId/claim", "claim"],
    ["POST /runs/:runId/checkpoints", "checkpoint"], ["POST /runs/:runId/draft", "draft"],
    ["POST /runs/:runId/candidate", "candidate"], ["POST /runs/:runId/objects/register", "register_object"],
    ["PUT /runs/:runId/objects/:sha256/content", "upload_object"], ["PUT /runs/:runId/codex-conversation", "sync_title"],
    ["POST /encryption/payloads", "encrypted_payload"],
    ["POST /runs/:runId/encrypted-storage/uploads", "encrypted_upload"],
    ["PUT /runs/:runId/encrypted-storage/uploads/:uploadId/parts/:partIndex", "encrypted_part"],
    ["POST /runs/:runId/encrypted-storage/uploads/:uploadId/complete", "encrypted_complete"],
    ["POST /runs/:runId/encrypted-storage/projection", "encrypted_projection"],
    ["POST /runs/:runId/encrypted-storage/draft", "encrypted_draft"],
    ["POST /runs/:runId/encrypted-storage/candidate", "encrypted_candidate"],
    ["POST /runs/:runId/encrypted-derived-artifacts", "encrypted_derived"],
    ["POST /runs/:runId/encrypted-candidate-from-draft", "encrypted_candidate"],
]);
// POST-shaped reads keep the native exact-task parsers/MVCC snapshot. They
// expose no mirror, generic payload resolver, key grant or write route. Only
// these two paths may enter the separately implemented encrypted task reader.
const assistantWorkspaceEncryptedTaskReadPaths = new Set([
    "/company-context/:companySlug/tasks/read",
    "/company-context/:companySlug/tasks/:projectSlug/:taskNumber/sections/read",
]);
export const assistantWorkspaceEncryptedTaskReadRoute = (route) => route.startsWith(ASSISTANT_WORKSPACE_PREFIX + "/")
    && assistantWorkspaceEncryptedTaskReadPaths.has(route.slice(ASSISTANT_WORKSPACE_PREFIX.length));
/** Accepted inspection is a separate READ-ONLY cell of the common data plane.
 * These four native routes are sufficient for routing, immutable authority and
 * its pinned full/delta ciphertext bundle. Ordinary overview/file/history,
 * writable Runs and arbitrary payload resolution do not inherit encrypted
 * admission. Classification is not authorization: native pass/task/Workspace,
 * current recipient envelope and point-of-send checks still apply separately.
 */
export const assistantWorkspaceEncryptedInspectionReadRoute = (method, route) => (method === "GET" || method === "HEAD") && [
    "/bridge-compatibility", "/bridge-routing", "/workspaces/:workspaceId/read-snapshot",
    "/workspaces/:workspaceId/encrypted-bundle",
].some(path => route === ASSISTANT_WORKSPACE_PREFIX + path);
/** Reviewed Run lifecycle of the SAME engine. This classification does not
 * grant a key, allow server Git/plaintext, admit general fields/proposals or
 * replace current own-Run/recipient/lease/CAS/native writer authorization. */
export const assistantWorkspaceEncryptedLifecycleRoute = (method, route) => {
    if (assistantWorkspaceEncryptedInspectionReadRoute(method, route))
        return true;
    const suffix = route.startsWith(ASSISTANT_WORKSPACE_PREFIX + "/")
        ? route.slice(ASSISTANT_WORKSPACE_PREFIX.length) : "";
    return (method === "GET" || method === "HEAD") && (suffix === "/workspaces/:workspaceId"
        || suffix === "/workspaces/:workspaceId/runs/:runId" || suffix === "/runs/:runId/codex-conversation"
        || suffix === "/runs/:runId/encrypted-bundle" || suffix === "/runs/:runId/context/:dependencyKind/encrypted-bundle"
        || suffix === "/runs/:runId/context/related/:relatedWorkspaceId/encrypted-bundle"
        || suffix.startsWith("/runs/:runId/encrypted-storage"))
        || assistantWorkspaceWritePaths.has(`${method} ${suffix}`) && (suffix === "/encryption/payloads"
            || ["/runs/:runId/claim", "/runs/:runId/heartbeat", "/runs/:runId/checkpoints", "/runs/:runId/codex-conversation"].includes(suffix)
            || suffix.startsWith("/runs/:runId/encrypted-"));
};
export const assistantWorkspaceOperation = (method, route) => {
    if (!route.startsWith(ASSISTANT_WORKSPACE_PREFIX + "/"))
        throw assistantWorkspacePolicyDenied();
    const nativePath = route.slice(ASSISTANT_WORKSPACE_PREFIX.length);
    if ((method === "GET" || method === "HEAD") && assistantWorkspaceReadPaths.has(nativePath))
        return "read";
    if (method === "POST" && assistantWorkspaceEncryptedTaskReadPaths.has(nativePath))
        return "read";
    if (assistantWorkspaceWritePaths.has(`${method} ${nativePath}`))
        return "write";
    throw assistantWorkspacePolicyDenied();
};
/** Bind a read proof to reads and each mutation proof to its own reviewed
 * native operation. The nonce store contains only a platform code, never a
 * filename, URL/query/body digest or company content. */
export const assistantWorkspaceProofTool = (method, route) => {
    const operation = assistantWorkspaceOperation(method, route);
    return `${ASSISTANT_WORKSPACE_PROOF_TOOL}_${operation === "read" ? "read" : assistantWorkspaceWritePaths.get(`${method} ${route.slice(ASSISTANT_WORKSPACE_PREFIX.length)}`)}`;
};
/** Resolve concrete host URLs from the same reviewed templates. Path values
 * remain locators; the backend still resolves canonical task/Run ACL. Encoded
 * separators, traversal and unknown routes cannot become a signed request. */
export const assistantWorkspaceConcreteRequest = (method, pathname) => {
    const templates = method === "GET" || method === "HEAD"
        ? [...assistantWorkspaceReadPaths] : [
        ...(method === "POST" ? assistantWorkspaceEncryptedTaskReadPaths : []),
        ...[...assistantWorkspaceWritePaths.keys()].filter(key => key.startsWith(method + " ")).map(key => key.slice(method.length + 1)),
    ];
    for (const template of templates) {
        const pattern = ASSISTANT_WORKSPACE_PREFIX + template;
        const matcher = new RegExp("^" + pattern.split("/").map(part => part.startsWith(":") ? "[A-Za-z0-9_-]{1,128}" : part).join("/") + "$");
        if (matcher.test(pathname))
            return { routePattern: pattern,
                operation: assistantWorkspaceOperation(method, pattern), proofTool: assistantWorkspaceProofTool(method, pattern) };
    }
    throw assistantWorkspacePolicyDenied();
};
/** One portable serializer for the existing observed runtime signature engine.
 * The host signs this ONLY after matching every selected slot to its exact
 * successful native body read. Reuse the ordinary v1 proof/nonce/key; no new
 * credential or signer is introduced. Bind the selected accepted material as
 * well, so a proof cannot be moved to another pass, result or partial subset.
 * Validation belongs to the native schema and the protected host boundary.
 * Only this structural payload's digest may enter the nonce operation name. */
export const assistantSourceProcessingProofPayload = (input) => JSON.stringify(["assistant-source-processing/v1", input.assistantId, input.deviceId,
    input.companyId, input.taskId, input.passId, input.deliveryId, input.bindingId,
    input.bindingRevision, input.threadId, input.clientRequestId, input.workspaceId,
    input.workspaceHead, input.acceptedRunId, input.references.map(ref => [ref.sourceId, ref.sourceRevision, ref.routeId, ref.eventOrdinal])]);
export const assistantSourceProcessingProofTool = (structuralManifestSha256) => {
    if (!/^[0-9a-f]{64}$/u.test(structuralManifestSha256))
        throw assistantWorkspacePolicyDenied();
    return `assistant_source_processing_${structuralManifestSha256}`;
};
/** Structural evidence for the SAME observed runtime signer. The protected
 * host verifies the computed own accepted WORK.md locally; neither its bytes,
 * name nor plaintext hash crosses the encrypted data boundary. Native receipt,
 * current envelope and material/retraction/CAS checks remain server authority. */
export const assistantEncryptedMaterialProofPayload = (input) => JSON.stringify(["assistant-encrypted-material/v1", input.assistantId, input.deviceId,
    input.companyId, input.taskId, input.passId, input.deliveryId, input.bindingId,
    input.bindingRevision, input.threadId, input.clientRequestId, input.workspaceId,
    input.workspaceHead, input.acceptedRunId ?? null, input.noChange, input.goalState,
    input.cadence, input.timeZone, input.cryptoDeviceId, input.envelopeId, input.scopeId,
    input.scopeEpoch, input.previousOutcomeId, input.previousHead, input.references.map(ref => [ref.sourceId, ref.sourceRevision, ref.routeId, ref.eventOrdinal])]);
export const assistantEncryptedMaterialProofTool = (structuralManifestSha256) => {
    if (!/^[0-9a-f]{64}$/u.test(structuralManifestSha256))
        throw assistantWorkspacePolicyDenied();
    return `assistant_encrypted_material_${structuralManifestSha256}`;
};
// END GENERATED ASSISTANT WORKSPACE POLICY

// A source is a private, explicitly selected account/stream. These protocol
// names only select reviewed wire formats; provider APIs, selectors, credentials
// and passive-read guards stay in their signed packages.
const ASSISTANT_SOURCE_PREFIX='/api/digital-assistants/runtime/source-skills';
const SOURCE_PROTOCOLS=Object.freeze({
  'telegram-mtproto':{provider:'telegram',protocol:'telegram-monitor/v1'},
  'email-imap-smtp':{provider:'email',protocol:'email-monitor/v1'},
  'max-web':{provider:'max',protocol:'max-monitor/v1'},
});
export const ASSISTANT_SOURCE_ACCOUNT_ERROR_CODES=Object.freeze(['ACCOUNT_CATALOGUE_CONFLICT','ACCOUNT_CATALOGUE_INVALID',
  'ACCOUNT_CATALOGUE_TOO_LARGE','ACCOUNT_CATALOGUE_BUSY','ACCOUNT_CATALOGUE_READBACK_FAILED','ACCOUNT_ID_CONFLICT','ACCOUNT_NOT_BOUND']);
export const ASSISTANT_SOURCE_MONITOR_ERROR_CODES=Object.freeze(['TELEGRAM','EMAIL','MAX'].flatMap(prefix=>
  ['INVALID_CURSOR','SCOPE_CHANGED','UIDVALIDITY_CHANGED','GAP','INVALID_RESPONSE','REFERENCE_UNAVAILABLE','UNAVAILABLE']
    .map(suffix=>`${prefix}_MONITOR_${suffix}`)));
const SOURCE_BACKEND_ERROR_CODES=Object.freeze(['ASSISTANT_SOURCE_AUTH_REQUIRED','ASSISTANT_SOURCE_ACCESS_DENIED','ASSISTANT_SOURCE_SCOPE_UNAVAILABLE',
  'ASSISTANT_SOURCE_INPUT_INVALID','ASSISTANT_SOURCE_PROTOCOL_REQUIRED','ASSISTANT_SOURCE_PROTOCOL_UNAVAILABLE',
  'ASSISTANT_SOURCE_SETUP_REQUIRED','ASSISTANT_SOURCE_ENCRYPTED_UNAVAILABLE','ASSISTANT_SOURCE_SKILL_UNAVAILABLE',
  'ASSISTANT_SOURCE_UNAVAILABLE','ASSISTANT_ACCESS_DENIED','ASSISTANT_COMPANY_REMOVED','ASSISTANT_DEVICE_REQUIRED',
  'ASSISTANT_DEVICE_REVOKED','ASSISTANT_STATE_CHANGED','ASSISTANT_RUNTIME_ADMISSION_DENIED',
  'AGENT_SKILL_RELEASE_CHANGED','AGENT_SKILL_RUNTIME_REVOKED','AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED',
  'AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED','AGENT_WORKSPACE_HOST_RUNTIME_UPGRADE_REQUIRED']);
/** One closed error boundary for source reads and empty-account preparation.
 * No caller receives raw HTTP/provider/config/exception text or hidden retry. */
export const rethrowAssistantSourceError=(error,{signal,setup=false}={})=>{
  if(error instanceof AssistantTransportError)throw error;
  const code=error?.code;
  if(SOURCE_BACKEND_ERROR_CODES.includes(code) || PROCESS_DIAGNOSTIC_CODES.includes(code)
    || setup&&ASSISTANT_SOURCE_ACCOUNT_ERROR_CODES.includes(code))fail(code);
  if(['ACCOUNT_NOT_FOUND','ACCOUNT_NOT_BOUND','ACCOUNT_SETUP_REQUIRED','ACCOUNT_SELECTION_REQUIRED'].includes(code))fail('ASSISTANT_SOURCE_ACCOUNT_REQUIRED');
  fail(signal?.aborted?'ASSISTANT_SOURCE_DEADLINE':setup?'ASSISTANT_SOURCE_SETUP_UNAVAILABLE':'ASSISTANT_SOURCE_UNAVAILABLE');
};
const sourceCursor = (value,skillId) => typeof value==='string' && value.length<=16_384
  && (skillId==='telegram-mtproto' ? /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u : /^[A-Za-z0-9_-]+$/u).test(value);
/** Wire metadata only, not another IMAP parser or source authority. The signed
 * provider rechecks the real account/folder scope. This closed projection keeps
 * arbitrary encoded text and a changed history ceiling out of the journal. */
const emailMonitorPosition=(value,history)=>{
  try{
    if(!sourceCursor(value,'email-imap-smtp')||value.length>2048)return null;
    const row=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    const keys=history?'lastUid,mode,scope,throughUid,uidValidity,v':'lastUid,scope,uidValidity,v';
    const uid=(number,minimum)=>Number.isSafeInteger(number)&&number>=minimum&&number<2**32;
    if(!object(row)||Object.keys(row).sort().join(',')!==keys||row.v!==(history?2:1)
      ||typeof row.scope!=='string'||!/^[a-f0-9]{64}$/u.test(row.scope)||!uid(row.uidValidity,1)||!uid(row.lastUid,0)
      ||history&&(row.mode!=='initial_unread'||!uid(row.throughUid,0)||row.lastUid>row.throughUid))return null;
    return row;
  }catch{return null;}
};
const maxMonitorPosition=value=>{
  try{
    if(!sourceCursor(value,'max-web')||value.length>2048)return null;
    const row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(value,'base64url')));
    if(!object(row)||Object.keys(row).sort().join(',')!=='anchorId,anchorRevision,scope,v'||row.v!==2
      ||!/^[a-f0-9]{64}$/u.test(row.scope??'')||(row.anchorId===null?row.anchorRevision!==null:
        !/^[1-9]\d{0,38}$/u.test(row.anchorId??'')||!/^[a-f0-9]{64}$/u.test(row.anchorRevision??'')))return null;
    return row;
  }catch{return null;}
};
/** Only an owner-selected native numeric MAX route, never a handle/title. */
export const assistantMaxChatUrl=value=>{
  if(typeof value!=='string'||!/^https:\/\/web\.max\.ru\/-?(?:0|[1-9]\d{0,18})$/u.test(value))return false;
  const id=BigInt(value.slice('https://web.max.ru/'.length));
  return id!==0n&&id>=-9223372036854775808n&&id<=9223372036854775807n;
};
const sourceScope = input => {
  if(!object(input) || Object.keys(input).some(key=>!['companyId','projectId','skillId'].includes(key))
    || !Object.hasOwn(SOURCE_PROTOCOLS,input.skillId)) fail('ASSISTANT_SOURCE_INVALID_INPUT');
  return Object.freeze({companyId:id(input.companyId),projectId:input.projectId==null?null:id(input.projectId),skillId:input.skillId});
};

/** Structural selectors use the SAME committed native receipt/slot vocabulary.
 * They carry no provider key/ID/body into the backend, URL or a new grant store. */
const normalizeAssistantSourceAcknowledgement=input=>{
  if(!object(input)||Object.keys(input).sort().join(',')!==(input.verifyOnly===undefined?'receipts,sourceId,sourceRevision':'receipts,sourceId,sourceRevision,verifyOnly')
    ||input.verifyOnly!==undefined&&input.verifyOnly!==true
    ||!Number.isSafeInteger(input.sourceRevision)||input.sourceRevision<0||input.sourceRevision>2_147_483_647
    ||!Array.isArray(input.receipts)||!input.receipts.length||input.receipts.length>100)fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const receipts=input.receipts.map(row=>{
    if(!object(row)||Object.keys(row).sort().join(',')!=='eventOrdinals,receiptId'||!Array.isArray(row.eventOrdinals)
      ||!row.eventOrdinals.length||row.eventOrdinals.length>100
      ||row.eventOrdinals.some((value,index)=>!Number.isSafeInteger(value)||value<0||value>99||index&&value<=row.eventOrdinals[index-1]))
      fail('ASSISTANT_SOURCE_INVALID_INPUT');
    return Object.freeze({receiptId:id(row.receiptId),eventOrdinals:Object.freeze([...row.eventOrdinals])});
  }).sort((a,b)=>a.receiptId.localeCompare(b.receiptId));
  if(new Set(receipts.map(row=>row.receiptId)).size!==receipts.length||receipts.reduce((n,row)=>n+row.eventOrdinals.length,0)>100)
    fail('ASSISTANT_SOURCE_INVALID_INPUT');
  return Object.freeze({sourceId:id(input.sourceId),sourceRevision:input.sourceRevision,receipts:Object.freeze(receipts),
    ...(input.verifyOnly?{verifyOnly:true}:{})});
};
const validateAssistantAcknowledgementArguments=(args,skillId)=>{
  if(skillId==='max-web'){
    if(!Array.isArray(args)||args.length<12||args.length>210||args[0]!=='ack-reference'
      ||args[1]!=='--chat'||!assistantMaxChatUrl(args[2])||args[3]!=='--message-id'||!/^[1-9]\d{0,38}$/u.test(args[4]??'')
      ||args[5]!=='--expected-revision'||!/^[0-9a-f]{64}$/u.test(args[6]??'')
      ||args[7]!=='--expected-conversation-key'||!assistantConversationKeyMatches('max',args[8])
      ||!['--confirm','--verify-only'].includes(args.at(-1))||(args.length-10)%2
      ||args.slice(9,-1).some((value,index)=>index%2===0?value!=='--covered-reference':!/^[1-9]\d{0,38}:[0-9a-f]{64}$/u.test(value)))
      fail('ASSISTANT_SOURCE_INVALID_INPUT');
    return [...args];
  }
  if(skillId==='email-imap-smtp'){
    // Exactly one UID, bound to independently read full RFC822 bytes. No
    // folder/account override, range, SMTP or model approval flag is accepted.
    if(!Array.isArray(args)||args.length!==10||args[0]!=='ack-reference'
      ||args[1]!=='--uid'||args[3]!=='--uid-validity'
      ||[args[2],args[4]].some(value=>!/^\d{1,10}$/u.test(value??'')||Number(value)<1||Number(value)>4294967295)
      ||args[5]!=='--expected-revision'||!/^[0-9a-f]{64}$/u.test(args[6]??'')
      ||args[7]!=='--expected-original-sha256'||!/^[0-9a-f]{64}$/u.test(args[8]??'')
      ||!['--confirm','--verify-only'].includes(args[9]))fail('ASSISTANT_SOURCE_INVALID_INPUT');
    return [...args];
  }
  if(!Array.isArray(args)||args.length<10||args.length>210||args[0]!=='ack-reference'
    ||args[1]!=='--chat'||!/^-?[1-9]\d{0,18}$/u.test(args[2]??'')||args[3]!=='--message-id'
    ||!/^\d{1,10}$/u.test(args[4]??'')||Number(args[4])<1||Number(args[4])>=2**31-1
    ||args[5]!=='--expected-revision'||!/^[0-9a-f]{64}$/u.test(args[6]??'')
    ||args[7]!=='--expected-conversation-key'||!/^telegram-conversation\/v1\.[0-9a-f]{64}$/u.test(args[8]??'')
    ||!['--confirm','--verify-only'].includes(args.at(-1))||(args.length-10)%2
    ||args.slice(9,-1).some((value,index)=>index%2===0?value!=='--covered-reference':!/^\d{1,10}:[0-9a-f]{64}$/u.test(value)))
    fail('ASSISTANT_SOURCE_INVALID_INPUT');
  return [...args];
};

/** One poll's transport profile for the common package loader. It has no task
 * pass/model observation, human vault or renewal cache. The server rechecks the
 * live device, MCP grant, scope, assignment, current release and package on each
 * fixed endpoint. A local format header and a callback are not authorization. */
export const createAssistantSourceRuntimeProfile = async ({identity,host,store,scope,sourceSelection=null,accountSetup=null,sourceAcknowledgement=null,acknowledgementExecution=null,sourceIntake=null,intakeExecution=null,
  monotonic=()=>performance.now(),startedAt=monotonic()}) => {
  scope=sourceScope(scope);
  if(sourceSelection!==null){
    if(!object(sourceSelection)||Object.keys(sourceSelection).sort().join(',')!=='expectedRevision,sourceId'
      ||!Number.isSafeInteger(sourceSelection.expectedRevision)||sourceSelection.expectedRevision<0
      ||sourceSelection.expectedRevision>2_147_483_647)fail('ASSISTANT_SOURCE_INVALID_INPUT');
    sourceSelection=Object.freeze({sourceId:id(sourceSelection.sourceId),expectedRevision:sourceSelection.expectedRevision});
  }
  if(accountSetup!==null){
    if(!object(accountSetup) || Object.keys(accountSetup).some(key=>!['sourceId','expectedRevision','operation'].includes(key))
      || accountSetup.operation!==undefined && !['configure','login','verify_login'].includes(accountSetup.operation)
      || accountSetup.operation==='configure' && scope.skillId!=='email-imap-smtp'
      || accountSetup.operation==='login' && !['telegram-mtproto','max-web'].includes(scope.skillId)
      || accountSetup.operation==='verify_login' && scope.skillId!=='max-web'
      || !Number.isSafeInteger(accountSetup.expectedRevision) || accountSetup.expectedRevision<0
      || accountSetup.expectedRevision>2_147_483_647)fail('ASSISTANT_SOURCE_INVALID_INPUT');
    accountSetup=Object.freeze({sourceId:id(accountSetup.sourceId),expectedRevision:accountSetup.expectedRevision,
      ...(accountSetup.operation?{operation:accountSetup.operation}:{})});
  }
  if(sourceAcknowledgement!==null){
    sourceAcknowledgement=normalizeAssistantSourceAcknowledgement(sourceAcknowledgement);
    if(accountSetup!==null||!['telegram-mtproto','email-imap-smtp','max-web'].includes(scope.skillId)||!object(acknowledgementExecution)
      ||Object.keys(acknowledgementExecution).sort().join(',')!=='accountId,beforeInvoke,runtimeArguments,slots'
      ||typeof acknowledgementExecution.beforeInvoke!=='function')fail('ASSISTANT_SOURCE_INVALID_INPUT');
    acknowledgementExecution=Object.freeze({accountId:id(acknowledgementExecution.accountId),
      runtimeArguments:Object.freeze(validateAssistantAcknowledgementArguments(acknowledgementExecution.runtimeArguments,scope.skillId)),
      slots:Object.freeze((()=>{
        const rows=acknowledgementExecution.slots;
        if(!Array.isArray(rows)||rows.length!==sourceAcknowledgement.receipts.reduce((n,row)=>n+row.eventOrdinals.length,0)
          ||rows.some(row=>!object(row)||Object.keys(row).sort().join(',')!=='eventOrdinal,receiptId,routeId'
            ||!UUID.test(row.receiptId??'')||!UUID.test(row.routeId??'')||!Number.isSafeInteger(row.eventOrdinal)
            ||row.eventOrdinal<0||row.eventOrdinal>99))fail('ASSISTANT_SOURCE_INVALID_INPUT');
        return rows.map(row=>Object.freeze({...row}));
      })()),
      beforeInvoke:acknowledgementExecution.beforeInvoke});
    if(sourceAcknowledgement.verifyOnly&&acknowledgementExecution.runtimeArguments.at(-1)!=='--verify-only')
      fail('ASSISTANT_SOURCE_ACK_REQUIRED');
  }else if(acknowledgementExecution!==null)fail('ASSISTANT_SOURCE_INVALID_INPUT');
  if(sourceIntake!==null){
    if(accountSetup||sourceAcknowledgement||!['telegram-mtproto','max-web'].includes(scope.skillId)||!object(sourceIntake)
      ||Object.keys(sourceIntake).sort().join(',')!=='expectedRevision,intakeId,sourceId'||!object(intakeExecution)
      ||Object.keys(intakeExecution).sort().join(',')!=='accountId,beforeInvoke,eventId,runtimeArguments,threadId'
      ||typeof intakeExecution.beforeInvoke!=='function')fail('ASSISTANT_SOURCE_INVALID_INPUT');
    sourceIntake=Object.freeze({intakeId:id(sourceIntake.intakeId),sourceId:id(sourceIntake.sourceId),expectedRevision:revision(sourceIntake.expectedRevision)});
    const args=intakeExecution.runtimeArguments;
    if(!Array.isArray(args)||args.length!==9||args[0]!=='read-reference'||args[1]!=='--chat'||!(scope.skillId==='max-web'?assistantMaxChatUrl(args[2])&&args[2]!=='https://web.max.ru/0':(/^-?[1-9]\d{0,18}$/u).test(args[2]))
      ||args[3]!=='--message-id'||!(scope.skillId==='max-web'?(/^[1-9]\d{0,18}$/u):(/^[1-9]\d{0,9}$/u)).test(args[4])||args[5]!=='--expected-revision'||!(/^[0-9a-f]{64}$/u).test(args[6])
      ||args[7]!=='--expected-conversation-key'||!assistantConversationKeyMatches(scope.skillId==='max-web'?'max':'telegram',args[8]))fail('ASSISTANT_SOURCE_INVALID_INPUT');
    intakeExecution=Object.freeze({accountId:id(intakeExecution.accountId),eventId:id(intakeExecution.eventId),threadId:id(intakeExecution.threadId),
      runtimeArguments:Object.freeze([...args]),beforeInvoke:intakeExecution.beforeInvoke});
  }else if(intakeExecution!==null)fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const interactive=accountSetup?.operation==='configure'||accountSetup?.operation==='login';
  // The closed setup operation also admits one independent MAX probe after
  // the human handoff. Probe retains the short read budget; it cannot reopen
  // login. These are protocol selectors, not a second provider/executor.
  const setupCommand=Boolean(accountSetup?.operation);
  const interactiveCommand=accountSetup?.operation==='verify_login'?'probe':accountSetup?.operation==='login'?'login':'configure';
  const interactiveProtocol=scope.skillId==='max-web'
    ?(interactive?'max-login/v1':'max-login-verify/v1')
    :accountSetup?.operation==='login'?'telegram-login/v1':'email-configure/v1';
  const maximumBudgetMs=interactive?10*60_000:120_000;
  const origin=originOf(identity?.origin),assistantId=id(identity?.assistantId),deviceId=id(identity?.deviceId);
  if(!host || typeof host.readIdentity!=='function' || !store || typeof store.get!=='function'
    || typeof monotonic!=='function' || !Number.isFinite(startedAt)) fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const expected={schemaVersion:1,origin,assistantId,deviceId};
  let active=true,resolveSent=false,packageSent=false,packagePath=null,budgetMs=maximumBudgetMs;
  let creation=null,creationUsed=false,intakeAdmission=null,intakeUsed=false,intakeStarted=false;
  let encryptedCompany=null,managedEncryptionDevice=null,encryptionFingerprint=null;
  let interactiveSetup=null,interactiveUsed=false,acknowledgement=null,acknowledgementUsed=false,acknowledgementStarted=false;
  const handle=Object.freeze(Object.create(null));
  const assertCurrent=async()=>{
    // Monotonic time starts before resolve/private I/O. Neither a delayed
    // response, local clock rollback nor download metadata can renew it.
    const elapsed=monotonic()-startedAt;
    if(!active || !Number.isFinite(elapsed) || elapsed<0 || elapsed>=budgetMs) fail('ASSISTANT_SOURCE_DEADLINE');
    const current=await host.readIdentity();
    if(!object(current) || Object.keys(current).sort().join(',')!==Object.keys(expected).sort().join(',')
      || Object.keys(expected).some(key=>current[key]!==expected[key])) fail('ASSISTANT_SOURCE_BINDING_CHANGED');
    const after=monotonic()-startedAt;
    if(!active || !Number.isFinite(after) || after<0 || after>=budgetMs) fail('ASSISTANT_SOURCE_DEADLINE');
  };
  await assertCurrent();
  return Object.freeze({
    kind:'digital_assistant_source',
    companyEncryptionUserId:assistantId,
    async resolveCompanyEncryptionDevice({origin:requestOrigin,companyId}){
      if(!encryptedCompany||requestOrigin!==origin||companyId!==scope.companyId)fail('ASSISTANT_SOURCE_BINDING_CHANGED');
      const common=await import('./trelio-workspace.mjs');
      const {resolveAssistantCompanyEncryptionDevice}=await import('./trelio-assistant-private.mjs');
      managedEncryptionDevice=await resolveAssistantCompanyEncryptionDevice({identity:expected,companyId,store,
        lockDirectory:path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','encryption-locks'),assertCurrent,allowCreate:false});
      if(managedEncryptionDevice.fingerprint!==encryptionFingerprint)fail('ASSISTANT_SOURCE_BINDING_CHANGED');
      return managedEncryptionDevice;
    },
    async hydrateResolution(raw,common,signal){
      return hydrateAssistantEncryptedSkill({raw,bundle:raw?.sourceEncryption,common,origin,token:handle,
        companyId:scope.companyId,assistantId,fingerprint:encryptionFingerprint,assertCurrent,signal,
        openCompany:async company=>{
          encryptedCompany={id:company.id,slug:company.slug};
          return common.ensureCompanyEncryptionContext({origin,token:handle,company:encryptedCompany,
            collectEncryptionKey:async()=>fail('ASSISTANT_SOURCE_BINDING_CHANGED')});
        }});
    },
    async resolveSkillCatalogueDirectory(configDirectory){
      await assertCurrent();
      return assistantSkillCatalogueDirectory(configDirectory,expected);
    },
    async authorizeAccountCreation(command,context){
      await assertCurrent();
      // The private native response, not a local boolean/model assertion,
      // supplies authority. Consume one exact EMPTY create or an independently
      // reviewed extra-company bind; never import, rename or launch a provider.
      if(!creation || creationUsed || command.operation!==creation.operation || command.id!==creation.accountId
        || creation.operation==='create'&&(command.name!==scope.skillId || (command.comment??'')!=='')
        ||creation.operation==='bind'&&(command.name!==undefined||command.comment!==undefined)
        || context.companyId!==scope.companyId || (context.projectId??null)!==scope.projectId
        || context.skillId!==scope.skillId || context.memberId!==creation.memberId
        || (context.connectionId??null)!==creation.connectionId)fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      creationUsed=true;
      return creation.operation==='bind'?Object.freeze({bindingRequestId:accountSetup.sourceId,bindingOrigin:creation.bindingOrigin}):Object.freeze({creationRequestId:accountSetup.sourceId});
    },
    async authorizeInteractiveSourceSetup({artifact,executionContext:context,runtimeArguments}){
      await assertCurrent();
      // A native EMPTY-create admission never enters this branch. The fixed
      // command opens the provider's existing protected browser form; it cannot
      // receive credentials, terminal input, secret checkout or arbitrary args.
      // Saving still requires the human's explicit action in that local form.
      const approved=interactiveSetup;
      if(!approved || interactiveUsed || artifact?.id!==approved.artifactId || artifact.skillId!==scope.skillId
        || context?.companyId!==scope.companyId || (context.projectId??null)!==scope.projectId
        || context.releaseId!==approved.releaseId || context.localIdentity?.memberId!==approved.memberId
        || (context.localIdentity?.connectionId??null)!==approved.connectionId || context.account?.id!==approved.accountId
        || JSON.stringify(runtimeArguments)!==JSON.stringify(scope.skillId==='max-web'
          ?(interactiveCommand==='probe'?['probe']:['login','--headed','--hold-ms','540000'])
          :interactiveCommand==='login'?['login','--account',approved.accountId,'--qr']
          :['configure','--account',approved.accountId,'--password-input','browser']))
        fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      interactiveUsed=true;
      return Math.floor(Math.min(interactive?600000:60000,budgetMs-(monotonic()-startedAt)));
    },
    async assertInteractiveSourceSetupCurrent(){
      await assertCurrent();
      if(!interactiveSetup || !interactiveUsed)fail('ASSISTANT_SKILL_SETUP_REQUIRED');
    },
    async authorizeSourceAcknowledgement({artifact,executionContext:context,runtimeArguments}){
      await assertCurrent();
      if(!acknowledgement||acknowledgementUsed||artifact?.id!==acknowledgement.artifactId
        ||artifact.skillId!==scope.skillId||context?.companyId!==scope.companyId
        ||(context.projectId??null)!==scope.projectId||context.releaseId!==acknowledgement.releaseId
        ||context.account?.id!==acknowledgementExecution.accountId||context.localIdentity?.memberId!==acknowledgement.memberId
        ||(context.localIdentity?.connectionId??null)!==acknowledgement.connectionId
        ||JSON.stringify(runtimeArguments)!==JSON.stringify(acknowledgementExecution.runtimeArguments)
        ||acknowledgement.verifyOnly&&runtimeArguments.at(-1)!=='--verify-only')fail('ASSISTANT_SOURCE_ACK_REQUIRED');
      acknowledgementUsed=true;return Math.floor(Math.min(60000,budgetMs-(monotonic()-startedAt)));
    },
    async startSourceAcknowledgement(){
      await assertCurrent();
      if(!acknowledgement||!acknowledgementUsed||acknowledgementStarted)fail('ASSISTANT_SOURCE_ACK_REQUIRED');
      // Called by the SAME executor at its final spawn boundary, after account,
      // interpreter and environment preparation. Persist the ORIGINAL attempt
      // before a single child starts. No callback retry on an unknown failure.
      acknowledgementStarted=true;await acknowledgementExecution.beforeInvoke();await assertCurrent();
    },
    async authorizeSourceIntake({artifact,executionContext:context,runtimeArguments}){
      await assertCurrent();const approved=intakeAdmission;
      if(!approved||intakeUsed||artifact?.id!==approved.artifactId||artifact.skillId!==scope.skillId
        ||context?.companyId!==scope.companyId||(context.projectId??null)!==scope.projectId||context.releaseId!==approved.releaseId
        ||context.account?.id!==intakeExecution.accountId||context.localIdentity?.memberId!==approved.memberId
        ||(context.localIdentity?.connectionId??null)!==approved.connectionId
        ||JSON.stringify(runtimeArguments)!==JSON.stringify(intakeExecution.runtimeArguments))fail('ASSISTANT_INTAKE_ACCESS_DENIED');
      intakeUsed=true;return Math.floor(Math.min(60000,budgetMs-(monotonic()-startedAt)));
    },
    async startSourceIntake(){
      await assertCurrent();if(!intakeAdmission||!intakeUsed||intakeStarted)fail('ASSISTANT_INTAKE_ACCESS_DENIED');
      intakeStarted=true;await intakeExecution.beforeInvoke();await assertCurrent();
    },
    async readIntakeOwner(){await assertCurrent();if(!intakeStarted)fail('ASSISTANT_INTAKE_ACCESS_DENIED');
      return {ownerIdentityId:intakeAdmission.ownerIdentityId,ownerExternalUserId:intakeAdmission.ownerExternalUserId};},
    async requireToken(requestOrigin){
      if(requestOrigin!==origin)fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
      await assertCurrent();return handle;
    },
    async prepareRequest({origin:requestOrigin,token,pathname,options,buildHeaders}){
      if(requestOrigin!==origin || token!==handle || typeof pathname!=='string' || typeof buildHeaders!=='function') fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
      const method=String(options.method??'GET').toUpperCase();
      if(pathname===`${ASSISTANT_SOURCE_PREFIX}/resolve` && method==='POST' && !resolveSent){
        let body;try{body=JSON.parse(options.body);}catch{fail('ASSISTANT_SOURCE_ORIGIN_DENIED');}
        if(!object(body) || JSON.stringify(body)!==JSON.stringify({...scope,expectedReleaseId:null,
          ...(sourceSelection?{sourceSelection}:{}),...(accountSetup?{accountSetup}:{}),...(sourceAcknowledgement?{sourceAcknowledgement}:{}),...(sourceIntake?{sourceIntake}:{})})) fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
        // Fence dispatch even when a local read/network response fails. Another
        // poll needs a fresh profile, not an implicit retry under this lease.
        resolveSent=true;
      }else if(pathname===packagePath && method==='GET' && !packageSent && options.body===undefined){
        packageSent=true;
      }else if(method==='GET'&&options.body===undefined&&encryptedCompany){
        const url=new URL(pathname,origin),keys=[...url.searchParams.keys()];
        if(url.origin!==origin||url.pathname!=='/api/agent-workspaces/encryption/runtime'||url.hash
          ||new Set(keys).size!==keys.length||keys.some(key=>!['companySlug','fingerprint'].includes(key))
          ||url.searchParams.get('companySlug')!==encryptedCompany.slug
          ||url.searchParams.has('fingerprint')&&url.searchParams.get('fingerprint')!==encryptionFingerprint)fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
        url.pathname='/api/digital-assistants/runtime/encryption/runtime';pathname=url.pathname+url.search;
      }else fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
      await assertCurrent();
      const headers=buildHeaders(null,options.headers??{});
      for(const key of ['cookie','cookie2','proxy-authorization','x-trelio-assistant-pass','x-trelio-assistant-proof','x-trelio-assistant-source-encryption-fingerprint'])headers.delete(key);
      headers.set('x-trelio-assistant-source-protocol','1');
      headers.set('x-trelio-assistant-encryption-protocol','1');
      // Only metadata from an already prepared managed identity is sent.
      // Missing setup never creates keys or opens a human remembered identity.
      const stored=await store.get({origin,kind:'company_encryption',id:scope.companyId,deviceId});
      if(stored?.assistantId===assistantId&&stored.deviceId===deviceId&&stored.companyId===scope.companyId
        &&typeof stored.record?.fingerprint==='string'&&/^[A-Za-z0-9_-]{40,128}$/u.test(stored.record.fingerprint)){
        encryptionFingerprint=stored.record.fingerprint;
        headers.set('x-trelio-assistant-source-encryption-fingerprint',encryptionFingerprint);
      }
      headers.set('authorization',`Bearer ${await loadAssistantDeviceCredential({origin,assistantId,deviceId,store})}`);
      await assertCurrent();
      return {url:new URL(pathname,origin),headers,options:{redirect:'error',credentials:'omit',cache:'no-store'}};
    },
    async bindResolution(resolution,admission){
      await assertCurrent();
      const protocol=SOURCE_PROTOCOLS[scope.skillId];
      const issued=Date.parse(admission?.issuedAt),expires=Date.parse(admission?.expiresAt);
      if(!resolveSent || packagePath!==null || !object(admission) || admission.schemaVersion!==1
        || admission.assistantUserId!==assistantId || admission.deviceId!==deviceId
        || admission.provider!==protocol.provider || admission.protocol!==(sourceIntake?(scope.skillId==='max-web'?'max-message-read/v1':'telegram-message-read/v1'):sourceAcknowledgement
          ?(scope.skillId==='email-imap-smtp'?'email-read-state/v1':scope.skillId==='max-web'?'max-message-ack/v1':'telegram-message-ack/v1'):setupCommand?interactiveProtocol:protocol.protocol)
        || admission.command!==(sourceIntake?'read-reference':sourceAcknowledgement?'ack-reference':setupCommand?interactiveCommand:'monitor')
        || admission.pollIntervalSeconds!==300 || admission.maximumDurationMs!==(interactive?10*60_000:60_000)
        || typeof admission.issuedAt!=='string' || typeof admission.expiresAt!=='string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(admission.issuedAt)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(admission.expiresAt)
        || !Number.isFinite(issued) || !Number.isFinite(expires) || ((sourceAcknowledgement||sourceIntake)?expires-issued<=0||expires-issued>maximumBudgetMs:expires-issued!==maximumBudgetMs)
        || resolution.localIdentity?.companyId!==scope.companyId || resolution.localIdentity?.projectId!==scope.projectId
        || resolution.artifact.skillId!==scope.skillId || resolution.artifact.contentProtection!=='plain'
        || resolution.trust.level!=='platform_verified' || resolution.trust.artifactLevel!=='platform_verified'
        || resolution.trust.requiresDeviceConsent || resolution.companyConnection?.secretBindings.length
        || resolution.companyConnection && !resolution.companyConnection.configured) fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      const url=new URL(resolution.packageUrl,origin);
      // The native encrypted setup adapter binds its exact registration as
      // well as the immutable owner account intent. Reuse the same selected
      // package path; no setup flag can borrow an unrelated source scope.
      const packageSelection=sourceSelection??(encryptedCompany&&sourceAcknowledgement?{sourceId:sourceAcknowledgement.sourceId,expectedRevision:sourceAcknowledgement.sourceRevision}
        :encryptedCompany&&accountSetup?{sourceId:accountSetup.sourceId,expectedRevision:accountSetup.expectedRevision}:null);
      const query={companyId:scope.companyId,...(scope.projectId?{projectId:scope.projectId}:{}),skillId:scope.skillId,
        expectedReleaseId:resolution.releaseId,artifactId:resolution.artifact.id,
        ...(packageSelection?{sourceId:packageSelection.sourceId,sourceRevision:String(packageSelection.expectedRevision)}:{}),
        ...(accountSetup?{accountSetupSourceId:accountSetup.sourceId,accountSetupRevision:String(accountSetup.expectedRevision),
          ...(setupCommand?{accountSetupOperation:accountSetup.operation}:{})}:{})};
      if(url.origin!==origin || url.pathname!==`${ASSISTANT_SOURCE_PREFIX}/package` || url.hash
        || [...url.searchParams.keys()].length!==Object.keys(query).length
        || Object.entries(query).some(([key,value])=>url.searchParams.get(key)!==value)) fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      if(sourceAcknowledgement){
        const approved=admission.acknowledgement;
        const wanted=sourceAcknowledgement.receipts.flatMap(row=>row.eventOrdinals.map(eventOrdinal=>({receiptId:row.receiptId,eventOrdinal})));
        if(!object(approved)||Object.keys(approved).sort().join(',')!==(sourceAcknowledgement.verifyOnly
          ?'localAccountId,schemaVersion,slots,sourceId,sourceRevision,verifyOnly':'localAccountId,schemaVersion,slots,sourceId,sourceRevision')
          ||approved.verifyOnly!==sourceAcknowledgement.verifyOnly
          ||approved.schemaVersion!==1||approved.sourceId!==sourceAcknowledgement.sourceId
          ||approved.sourceRevision!==sourceAcknowledgement.sourceRevision||approved.localAccountId!==acknowledgementExecution.accountId
          ||!Array.isArray(approved.slots)||approved.slots.length!==wanted.length
          ||approved.slots.some((row,index)=>!object(row)||Object.keys(row).sort().join(',')!=='eventOrdinal,receiptId,routeId'
            ||row.receiptId!==wanted[index].receiptId||row.eventOrdinal!==wanted[index].eventOrdinal||!UUID.test(row.routeId??'')
            ||!acknowledgementExecution.slots.some(slot=>slot.receiptId===row.receiptId&&slot.routeId===row.routeId&&slot.eventOrdinal===row.eventOrdinal)))
          fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
        acknowledgement=Object.freeze({artifactId:id(resolution.artifact.id),releaseId:id(resolution.releaseId),
          memberId:id(resolution.localIdentity.memberId),connectionId:resolution.localIdentity.connectionId??null,slots:approved.slots,
          ...(approved.verifyOnly?{verifyOnly:true}:{})});
      }else if(admission.acknowledgement!==undefined)fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      if(sourceIntake){
        const approved=admission.intake;
        if(!object(approved)||Object.keys(approved).sort().join(',')!==['eventId','intakeId','localAccountId','ownerExternalUserId','ownerIdentityId','schemaVersion','sourceId','sourceRevision','threadId',...(scope.skillId==='max-web'?['maxChatUrl']:[])].sort().join(',')
          ||approved.schemaVersion!==1||approved.intakeId!==sourceIntake.intakeId||approved.sourceId!==sourceIntake.sourceId
          ||approved.sourceRevision!==sourceIntake.expectedRevision||approved.localAccountId!==intakeExecution.accountId
          ||approved.eventId!==intakeExecution.eventId||approved.threadId!==intakeExecution.threadId
          ||scope.skillId==='max-web'&&(!assistantMaxChatUrl(approved.maxChatUrl)||approved.maxChatUrl!==intakeExecution.runtimeArguments[2])
          ||!UUID.test(approved.ownerIdentityId??'')||!(/^[1-9]\d{0,18}$/u).test(approved.ownerExternalUserId??''))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
        intakeAdmission=Object.freeze({artifactId:id(resolution.artifact.id),releaseId:id(resolution.releaseId),memberId:id(resolution.localIdentity.memberId),
          connectionId:resolution.localIdentity.connectionId??null,ownerIdentityId:approved.ownerIdentityId,ownerExternalUserId:approved.ownerExternalUserId});
      }else if(admission.intake!==undefined)fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      if(accountSetup){
        const approved=admission.accountSetup;
        if(!object(approved) || Object.keys(approved).sort().join(',')!==['localAccountId','operation','schemaVersion','sourceId','sourceRevision',...(approved.operation==='bind'?['bindingOrigin']:[])].sort().join(',')
          || approved.schemaVersion!==1 || (setupCommand?approved.operation!==accountSetup.operation:!['create','bind'].includes(approved.operation)) || approved.sourceId!==accountSetup.sourceId
          || approved.sourceRevision!==accountSetup.expectedRevision || !UUID.test(approved.localAccountId??'')
          || !UUID.test(resolution.localIdentity.memberId??''))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
        const bound={accountId:id(approved.localAccountId),memberId:id(resolution.localIdentity.memberId),
          connectionId:resolution.localIdentity.connectionId??null};
        if(setupCommand)interactiveSetup=Object.freeze({...bound,artifactId:id(resolution.artifact.id),releaseId:id(resolution.releaseId)});
        else {
          if(approved.operation==='bind'&&(!object(approved.bindingOrigin)||Object.keys(approved.bindingOrigin).sort().join(',')!=='companyId,connectionId,memberId'
            ||!UUID.test(approved.bindingOrigin.companyId)||!UUID.test(approved.bindingOrigin.memberId)||approved.bindingOrigin.connectionId!==null
            ||approved.bindingOrigin.companyId===scope.companyId))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
          creation=Object.freeze({...bound,operation:approved.operation,...(approved.operation==='bind'?{bindingOrigin:{companyId:approved.bindingOrigin.companyId,memberId:approved.bindingOrigin.memberId}}:{})});
        }
      }else if(admission.accountSetup!==undefined)fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      // The wire date pair bounds duration, not local wall time. Original
      // monotonic start already charged transport latency before this response.
      budgetMs=Math.min(budgetMs,expires-issued);packagePath=resolution.packageUrl;
      await assertCurrent();
    },
    async remainingMs(){await assertCurrent();return Math.floor(budgetMs-(monotonic()-startedAt));},
    close(){active=false;},
  });
};

/** Strip native monitor output to a private structural page before queue I/O.
 * Never return the provider envelope, Error/cause or optional content fields.
 * An error/gap is not an empty page and never supplies a replacement cursor. */
export const projectAssistantMonitorPage = (result,{skillId,cursor=null,chat=null,initialUnread=false,initialAccountCursor=null,nativeMax=false}) => {
  const invalid=()=>fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  if(!object(result) || !Number.isSafeInteger(result.exitCode) || typeof result.stdout!=='string'
    || Buffer.byteLength(result.stdout,'utf8')>1024*1024 || !Object.hasOwn(SOURCE_PROTOCOLS,skillId))invalid();
  let raw;try{raw=JSON.parse(result.stdout);}catch{invalid();}
  if(!object(raw))invalid();

  if(result.exitCode!==0){
    const prefix={ 'telegram-mtproto':'TELEGRAM','email-imap-smtp':'EMAIL','max-web':'MAX' }[skillId];
    const allowed=ASSISTANT_SOURCE_MONITOR_ERROR_CODES.filter(code=>code.startsWith(`${prefix}_MONITOR_`));
    fail(allowed.includes(raw.code)?raw.code:'ASSISTANT_SOURCE_PROVIDER_UNAVAILABLE');
  }
  const ref=value=>typeof value==='string' && value.length>0 && value.length<=512 && !/[\x00-\x20\x7f]/u.test(value);
  const digest=value=>typeof value==='string' && /^[a-f0-9]{64}$/u.test(value);
  const positive=value=>typeof value==='string' && /^[1-9]\d{0,18}$/u.test(value);
  const peer=value=>typeof value==='string' && /^-?[1-9]\d{0,18}$/u.test(value);
  const cursorRef=value=>sourceCursor(value,skillId);
  const channel=typeof chat==='string' && /^-[1-9]\d{0,18}$/u.test(chat)
    && BigInt(chat)<-1000000000000n && BigInt(chat)>-9223372036854775808n;
  const backfill=raw.coverage?.historicalBackfill===true;
  const accountInterval=raw.coverage?.initialAccountInterval===true;
  const unreadInterval=raw.coverage?.initialUnreadOnly===true;
  const emailInitial=skillId==='email-imap-smtp'&&initialUnread;
  const maxInitial=nativeMax&&skillId==='max-web'&&initialUnread;
  if(typeof nativeMax!=='boolean'||nativeMax&&(skillId!=='max-web'||!assistantMaxChatUrl(chat)))invalid();
  let emailPrevious=null,emailNext=null;
  if(typeof initialUnread!=='boolean')invalid();
  if(emailInitial){
    if(chat!==null||initialAccountCursor!==null||accountInterval)invalid();
    if(cursor===null){
      const forward=emailMonitorPosition(raw.nextCursor,false),seed=emailMonitorPosition(raw.initialUnreadCursor,true);
      if(!forward||!seed||seed.scope!==forward.scope||seed.uidValidity!==forward.uidValidity
        ||seed.lastUid!==0||seed.throughUid!==forward.lastUid||raw.coverage?.initialUnreadBackfillAvailable!==true
        ||raw.hasMore!==false||backfill||unreadInterval)invalid();
    }else{
      emailPrevious=emailMonitorPosition(cursor,true);emailNext=emailMonitorPosition(raw.nextCursor,true);
      if(!emailPrevious||!emailNext||emailNext.scope!==emailPrevious.scope||emailNext.uidValidity!==emailPrevious.uidValidity
        ||emailNext.throughUid!==emailPrevious.throughUid||emailNext.lastUid<emailPrevious.lastUid
        ||raw.hasMore!==(emailNext.lastUid<emailNext.throughUid)||raw.hasMore&&emailNext.lastUid===emailPrevious.lastUid
        ||!backfill||!unreadInterval||raw.coverage?.snapshotAtomic!==false
        ||raw.coverage.backfillThroughUid!==String(emailPrevious.throughUid)||raw.initialUnreadCursor!==undefined
        ||raw.coverage.initialUnreadBackfillAvailable===true)invalid();
    }
  }else if(typeof raw.initialUnreadCursor!=='undefined'||raw.coverage?.initialUnreadBackfillAvailable===true)invalid();
  if(maxInitial){
    if(cursor!==null||initialAccountCursor!==null||raw.coverage?.initialUnreadOnly!==true||raw.coverage.snapshotAtomic!==false
      ||backfill!==(raw.events?.length>0)||raw.baselineOnly!==(raw.events?.length===0))invalid();
  }
  if(!emailInitial&&!maxInitial&&(initialUnread && (skillId!=='telegram-mtproto' || !channel || cursor!==null)
    || initialAccountCursor!==null && (initialUnread || skillId!=='telegram-mtproto' || !channel || cursor!==null || !cursorRef(initialAccountCursor))
    || backfill && (skillId!=='telegram-mtproto' || !channel || accountInterval===unreadInterval
      || accountInterval && raw.coverage.earlierEditsIncluded!==false || raw.coverage.snapshotAtomic!==false || raw.hasMore!==true)
    || !backfill && (accountInterval||unreadInterval)
    || initialUnread && (!backfill || !unreadInterval) || initialAccountCursor!==null && (!backfill || !accountInterval)))invalid();
  if(raw.schemaVersion!==1 || typeof raw.baselineOnly!=='boolean' || !maxInitial&&raw.baselineOnly!==(cursor===null && (!initialUnread||emailInitial) && initialAccountCursor===null)
    || !Array.isArray(raw.events) || raw.events.length>100 || raw.baselineOnly && raw.events.length
    || typeof raw.hasMore!=='boolean' || !cursorRef(raw.nextCursor)
    || !backfill && raw.coverage?.historicalBackfill!==false || raw.readState?.readReceiptsSent!==false)invalid();
  if(skillId==='email-imap-smtp' && raw.coverage.bodyContentRead!==false
    || skillId==='max-web' && (raw.coverage.ownerIdentityAvailable!==nativeMax
      ||nativeMax&&raw.coverage.nativeMessageVerified!==true
      || raw.coverage.earlierEditsIncluded!==false || raw.coverage.otherChatsIncluded!==false))invalid();
  const seen=new Set();
  const events=raw.events.map(row=>{
    if(!object(row) || !ref(row.id) || !digest(row.revision) || !['new','edit','delete'].includes(row.kind))invalid();
    const key=JSON.stringify([row.id,row.revision]);if(seen.has(key))invalid();seen.add(key);
    if(skillId==='email-imap-smtp'){
      if(row.kind!=='new' || !positive(row.uid) || !positive(row.uidValidity)
        || row.id!==`uid:${row.uidValidity}:${row.uid}` || raw.coverage.bodyContentRead!==false)invalid();
      if(row.conversationKey!==undefined&&(!assistantConversationKeyMatches('email',row.conversationKey)
        ||raw.coverage.conversationHeadersRead!==true))invalid();
      return {id:row.id,revision:row.revision,kind:row.kind,uid:row.uid,uidValidity:row.uidValidity,
        ...(row.conversationKey===undefined?{}:{conversationKey:row.conversationKey})};
    }
    if(!ref(row.chatId) || !ref(row.messageId))invalid();
    const event={id:row.id,revision:row.revision,kind:row.kind,chatId:row.chatId,messageId:row.messageId};
    if(skillId==='telegram-mtproto'){
      if(!peer(row.chatId) || !positive(row.messageId) || row.id!==`message:${row.chatId}:${row.messageId}`
        || chat!==null && row.chatId!==chat)invalid();
      // Older signed providers may still omit this capability; keep their
      // passive cursor protocol usable, but do not invent a routable key.
      if(row.conversationKey!==undefined){
        if(typeof row.conversationKey!=='string'||!/^telegram-conversation\/v1\.[0-9a-f]{64}$/u.test(row.conversationKey))invalid();
        event.conversationKey=row.conversationKey;
      }
      if(row.kind!=='delete'){
        if(row.topicId!==null && !positive(row.topicId) || row.senderUserId!==null && !positive(row.senderUserId)
          || row.senderNamespace!==(row.senderUserId===null?null:'telegram_user_id')
          || ['outgoing','forwarded','viaBot'].some(key=>typeof row[key]!=='boolean'))invalid();
        Object.assign(event,{topicId:row.topicId,senderUserId:row.senderUserId,senderNamespace:row.senderNamespace,
          outgoing:row.outgoing,forwarded:row.forwarded,viaBot:row.viaBot});
      }
    }else{
      if(nativeMax){
        if(row.kind==='delete'||row.chatId!==chat.slice('https://web.max.ru/'.length)||!/^[1-9]\d{0,38}$/u.test(row.messageId)
          ||row.id!==`message:${row.chatId}:${row.messageId}`||!assistantConversationKeyMatches('max',row.conversationKey)
          ||row.senderUserId!==null&&!positive(row.senderUserId)||row.senderNamespace!==(row.senderUserId===null?null:'max_user_id')
          ||typeof row.outgoing!=='boolean'||typeof row.forwarded!=='boolean')invalid();
        Object.assign(event,{conversationKey:row.conversationKey,senderUserId:row.senderUserId,senderNamespace:row.senderNamespace,
          outgoing:row.outgoing,forwarded:row.forwarded});
      }else{
        if(row.kind==='delete' || row.id!==`message:${row.messageId}` || row.senderUserId!==null
          || row.senderNamespace!==null || raw.coverage.ownerIdentityAvailable!==false)invalid();
        Object.assign(event,{senderUserId:null,senderNamespace:null});
      }
    }
    return event;
  });
  if(emailPrevious&&events.some(row=>row.uidValidity!==String(emailPrevious.uidValidity)
    ||BigInt(row.uid)<=BigInt(emailPrevious.lastUid)||BigInt(row.uid)>BigInt(emailNext.lastUid)))invalid();
  if(nativeMax){
    const previous=cursor===null?null:maxMonitorPosition(cursor),next=maxMonitorPosition(raw.nextCursor);
    if(!next||cursor!==null&&!previous||previous&&previous.scope!==next.scope
      ||new Set(events.map(row=>row.conversationKey)).size>1
      ||events.length&&(next.anchorId!==events.at(-1).messageId||next.anchorRevision!==events.at(-1).revision)
      ||!events.length&&previous&&(previous.anchorId!==next.anchorId||previous.anchorRevision!==next.anchorRevision)
      ||raw.hasMore&&!events.length)invalid();
  }
  const page={schemaVersion:1,baselineOnly:raw.baselineOnly,events,nextCursor:raw.nextCursor,hasMore:raw.hasMore,
    ...(backfill?{[accountInterval?'initialAccountBackfill':'initialUnreadBackfill']:true}:{}),
    ...(emailInitial&&cursor===null?{initialUnreadCursor:raw.initialUnreadCursor}:{})};
  if(skillId==='telegram-mtproto'){
    const list=(value,validator)=>{
      if(!Array.isArray(value) || value.length>100 || value.some(item=>!validator(item)) || new Set(value).size!==value.length)invalid();
      return [...value];
    };
    if(raw.stream?.kind!==(chat===null?'account_cloud':'channel') || raw.stream.chatId!==chat
      || raw.readState.viewsRegistered!==false || raw.coverage.secretChatsIncluded!==false
      || raw.coverage.otherChannelStreamsIncluded!==false)invalid();
    page.channelsToSync=list(raw.channelsToSync,positive);
    page.unresolvedDeletionIds=list(raw.unresolvedDeletionIds,positive);
  }
  return page;
};

/** One bounded model-free read through the same verifier, local-account
 * selector and materialized executor as a human skill invocation. This helper
 * does not register a source, acknowledge a message, advance SQLite or create
 * a task; the coordinator owns those independent durable transitions. */
/** One shared native materialization path for a passive source page and the
 * owner's empty-account setup. It is not an executor or an admission cache.
 * Setup refreshes native authority after materialization, charging both reads
 * to the ORIGINAL monotonic budget; no account/provider mutation is retried. */
export const withAssistantSourcePackage = async ({identity,host,store,scope,sourceSelection=null,accountSetup=null,sourceAcknowledgement=null,acknowledgementExecution=null,sourceIntake=null,intakeExecution=null,signal},action) => {
  scope=sourceScope(scope);
  if(sourceAcknowledgement!==null)sourceAcknowledgement=normalizeAssistantSourceAcknowledgement(sourceAcknowledgement);
  if(typeof action!=='function')fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const startedAt=performance.now(),controller=new AbortController();
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  // A separately native-admitted form has a fixed ten-minute outer budget,
  // including preparation; the provider retains its shorter input deadline.
  // This is not a longer passive reader or
  // a caller-controlled timeout; both resolves and bootstrap charge this clock.
  const timer=setTimeout(()=>controller.abort(),['configure','login'].includes(accountSetup?.operation)?10*60_000:120_000);
  let profile;
  try{
    // Import the existing engine lazily: discovery/pairing never initializes
    // the human vault, account catalogue or package cache just by importing us.
    const engine=await import('./trelio-workspace.mjs');
    const resolve=async()=>{
      if(combined.aborted)fail('ASSISTANT_SOURCE_DEADLINE');
      const token=await profile.requireToken(identity.origin);
      const response=await engine.request(identity.origin,token,`${ASSISTANT_SOURCE_PREFIX}/resolve`,{
        method:'POST',body:JSON.stringify({...scope,expectedReleaseId:null,...(sourceSelection?{sourceSelection}:{}),...(accountSetup?{accountSetup}:{}),...(sourceAcknowledgement?{sourceAcknowledgement}:{}),...(sourceIntake?{sourceIntake}:{})}),
        headers:{'content-type':'application/json'},signal:combined,maximumErrorResponseBytes:16_384});
      const bytes=await engine.readBoundedResponseBuffer(response,512*1024,'Source resolution');
      let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
      const hydrated=await profile.hydrateResolution(raw,engine,combined);
      const resolution=engine.normalizeResolvedSkillRuntimeArtifact(hydrated.rawResolution,{transportProfile:'assistant_source'});
      await profile.bindResolution(resolution,raw.sourceAdmission);raw=null;
      return {resolution,token,companyEncryption:hydrated.companyEncryption};
    };
    profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope,sourceSelection,accountSetup,sourceAcknowledgement,acknowledgementExecution,sourceIntake,intakeExecution,startedAt});
    const initial=await engine.withWorkspaceExecutionProfile(profile,async()=>{
      const {resolution,token,companyEncryption}=await resolve();
      const materialized=await engine.materializeResolvedAgentSkillRuntime({origin:identity.origin,token,resolution,companyEncryption,
        requestOptions:{signal:combined,maximumErrorResponseBytes:16_384}});
      await profile.remainingMs();
      const capabilities=materialized.artifact.parsedPackage.capabilities;
      if(!['network','local-session','local-accounts-v1'].every(value=>capabilities.includes(value))
        || capabilities.includes('secret-checkout'))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      const refresh=Boolean(accountSetup||sourceAcknowledgement||sourceIntake||companyEncryption);
      if(!refresh)return {result:await action({engine,profile,materialized,resolution,signal:combined})};
      return {materialized,resolution,refresh};
    });
    if(!initial.refresh)return initial.result;
    // Exit the first async profile before entering the fresh one. The common
    // engine deliberately refuses nested profile replacement; retain that
    // device/human-isolation guard and its closed tombstone semantics.
    profile.close();
    profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope,sourceSelection,accountSetup,sourceAcknowledgement,acknowledgementExecution,sourceIntake,intakeExecution,startedAt});
    return await engine.withWorkspaceExecutionProfile(profile,async()=>{
      const fresh=await resolve();
      if(JSON.stringify(fresh.resolution.companyConnection)!==JSON.stringify(initial.resolution.companyConnection)
        ||JSON.stringify(fresh.resolution.localIdentity)!==JSON.stringify(initial.resolution.localIdentity))fail('ASSISTANT_SOURCE_BINDING_CHANGED');
      if(fresh.resolution.artifact.id!==initial.resolution.artifact.id
        || fresh.resolution.artifact.packageSha256!==initial.resolution.artifact.packageSha256
        || fresh.resolution.releaseId!==initial.resolution.releaseId)fail('AGENT_SKILL_RELEASE_CHANGED');
      return action({engine,profile,materialized:initial.materialized,resolution:fresh.resolution,signal:combined});
    });
  }catch(error){if(combined.aborted)fail('ASSISTANT_SOURCE_DEADLINE');throw error;}
  finally{clearTimeout(timer);profile?.close();}
};

/** Owner-authorized empty account preparation, not provider onboarding or a
 * second account engine. The common catalogue commits metadata, binding and
 * an exact native-intent receipt atomically, so a lost response can be read
 * back without adopting an unrelated account or resetting a provider session. */
export const prepareAssistantSourceAccount = async ({identity,host,store,client,companyId,sourceId,signal}) => {
  companyId=id(companyId);sourceId=id(sourceId);
  if(!identity || !client || typeof client.sourceAccounts!=='function'
    || ['origin','assistantId','deviceId'].some(key=>client.identity?.[key]!==identity[key]))fail('ASSISTANT_SOURCE_BINDING_CHANGED');
  // Discovery is desired configuration only. Native package admission below
  // independently repeats live owner/device/scope/generation and write scope;
  // a model-authored local JSON or an existing UUID can supply neither.
  const rows=await client.sourceAccounts(companyId,signal);
  const source=rows.find(row=>row.id===sourceId);
  if(!source || source.state!=='active' || source.provisionLocalAccount!==true&&!source.bindFromSourceId)fail('ASSISTANT_SOURCE_SETUP_REQUIRED');
  const scope={companyId,projectId:source.projectId,skillId:source.skillId};
  try{
    return await withAssistantSourcePackage({identity,host,store,scope,signal,
      accountSetup:{sourceId,expectedRevision:source.revision}},async({engine,profile,materialized,resolution,signal:currentSignal})=>{
      const executionContext={...scope,releaseId:resolution.releaseId,localIdentity:resolution.localIdentity,
        companyConnection:resolution.companyConnection};
      const prepare=async runtimeArguments=>{
        if(currentSignal.aborted)fail('ASSISTANT_SOURCE_DEADLINE');
        let output=null,count=0;
        const result=await engine.prepareSkillAccount({origin:identity.origin,artifact:materialized.artifact,
          runtimeDirectory:materialized.runtimeDirectory,executionContext,runtimeArguments,
          output:value=>{output=value;count++;}});
        await profile.remainingMs();
        if(currentSignal.aborted)fail('ASSISTANT_SOURCE_DEADLINE');
        if(!result.handled || count!==1 || !output?.ok || !Number.isSafeInteger(output.revision)
          || output.revision<0 || !Array.isArray(output.accounts) || output.accounts.length>64)fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
        return output;
      };
      const listed=await prepare(['account','list']);
      // The caller cannot choose an old provider reference, metadata or another
      // company. Only the native-authorized server-generated account UUID and
      // a fixed platform label enter this common host command. No provider is
      // launched: account commands are handled by the catalogue itself.
      const result=await prepare(['account',source.bindFromSourceId?'bind':'create','--id',source.localAccountId,
        ...(!source.bindFromSourceId?['--name',scope.skillId]:[]),'--expected-revision',String(listed.revision)]);
      if(result.id!==source.localAccountId || typeof result.replayed!=='boolean'
        || !result.accounts.some(account=>account.id===source.localAccountId&&account.bound===true))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      return Object.freeze({sourceId,localAccountId:source.localAccountId,state:'prepared',replayed:result.replayed,loginVerified:false});
    });
  }catch(error){
    rethrowAssistantSourceError(error,{signal,setup:true});
  }
};

/** The operator enters credentials ONLY in the existing provider's protected
 * browser form on this device. This helper cannot choose an old human account,
 * supply fields, invoke a terminal prompt or infer permission from EMPTY-create.
 * A saved configuration is not a network/login/readiness/processing receipt. */
const configureAssistantInteractiveSource = async ({identity,host,store,client,companyId,sourceId,signal},kind) => {
  companyId=id(companyId);sourceId=id(sourceId);
  if(!['win32','darwin'].includes(process.platform))fail('ASSISTANT_SOURCE_SETUP_UNAVAILABLE');
  if(!identity || !client || typeof client.sourceAccounts!=='function'
    || ['origin','assistantId','deviceId'].some(key=>client.identity?.[key]!==identity[key]))fail('ASSISTANT_SOURCE_BINDING_CHANGED');
  const rows=await client.sourceAccounts(companyId,signal),source=rows.find(row=>row.id===sourceId);
  const telegram=kind==='telegram',max=kind==='max'||kind==='max-verify',verify=kind==='max-verify';
  const skillId=max?'max-web':telegram?'telegram-mtproto':'email-imap-smtp',operation=verify?'verify_login':telegram||max?'login':'configure';
  if(!source || source.state!=='active' || source.skillId!==skillId
    || source.provisionLocalAccount!==true || source.interactiveSetupAllowed!==true)fail('ASSISTANT_SOURCE_SETUP_REQUIRED');
  const scope={companyId,projectId:source.projectId,skillId:source.skillId};
  try{
    return await withAssistantSourcePackage({identity,host,store,scope,signal,
      accountSetup:{sourceId,expectedRevision:source.revision,operation}},
    async({engine,profile,materialized,resolution,signal:currentSignal})=>{
      const executionContext={...scope,releaseId:resolution.releaseId,localIdentity:resolution.localIdentity,
        companyConnection:resolution.companyConnection};
      const args=max?[...(verify?['probe']:['login','--headed','--hold-ms','540000']),'--local-account',source.localAccountId]:
        telegram?['login','--local-account',source.localAccountId,'--account',source.localAccountId,'--qr']:
        ['configure','--local-account',source.localAccountId,'--account',source.localAccountId,'--password-input','browser'];
      const selected=await engine.prepareSkillAccount({origin:identity.origin,artifact:materialized.artifact,
        runtimeDirectory:materialized.runtimeDirectory,executionContext,runtimeArguments:args});
      if(selected.handled || selected.account?.id!==source.localAccountId)fail('ASSISTANT_SOURCE_ACCOUNT_REQUIRED');
      executionContext.account=selected.account;
      const remaining=await profile.remainingMs();
      if(currentSignal.aborted || remaining<1000)fail('ASSISTANT_SOURCE_DEADLINE');
      const result=await engine.runMaterializedAgentSkill({artifact:materialized.artifact,runtimeDirectory:materialized.runtimeDirectory,
        executionContext,runtimeArguments:selected.runtimeArguments,captureOutput:true,captureExitCode:true,
        captureMode:'assistant_source_setup',timeoutMs:verify?Math.min(60000,remaining):remaining,signal:currentSignal});
      await profile.remainingMs();
      if(currentSignal.aborted)fail('ASSISTANT_SOURCE_DEADLINE');
      let value;try{value=JSON.parse(result.stdout);}catch{fail('ASSISTANT_SOURCE_INVALID_RESPONSE');}
      if(max){
        // Closing a login window or reaching its hold limit proves no login.
        // Drop the provider's private profile/path/fingerprint and never repeat
        // the handoff automatically. A fresh native probe is a separate read.
        if(result.exitCode!==0||!object(value)|| (verify
          ?value.authenticated!==true||value.searchReady!==true
          :value.opened!==true||value.sessionVerified!==false||!['window_closed','hold_expired'].includes(value.handoffCompletion)))
          fail('ASSISTANT_SOURCE_SETUP_UNAVAILABLE');
        const current=await client.sourceAccounts(companyId,currentSignal);await profile.remainingMs();
        if(!sameAssistantSourceRegistration(source,current.find(row=>row.id===sourceId)))fail('ASSISTANT_SOURCE_BINDING_CHANGED');
        return Object.freeze({sourceId,localAccountId:source.localAccountId,
          state:verify?'session_verified':'login_handoff_finished',sessionVerified:verify,
          incomingVerified:false,backgroundVerified:false,
          ...(verify?{}:{nextAction:{tool:'verify_assistant_max_source',arguments:{companyId,sourceId}}})});
      }
      if(telegram){
        if(result.exitCode!==0||!object(value)||value.authorized!==true)fail('ASSISTANT_SOURCE_SETUP_UNAVAILABLE');
        // The native Telegram account's ID/username and QR/login factors never
        // leave the provider boundary. Successful login does not identify the
        // assistant OWNER, approve new tasks, alter read-state or prove polling.
        const current=await client.sourceAccounts(companyId,currentSignal);await profile.remainingMs();
        if(!sameAssistantSourceRegistration(source,current.find(row=>row.id===sourceId)))fail('ASSISTANT_SOURCE_BINDING_CHANGED');
        return Object.freeze({sourceId,localAccountId:source.localAccountId,state:'session_authorized',
          incomingVerified:false,backgroundVerified:false});
      }
      if(result.exitCode!==0 || !object(value) || value.configured!==source.localAccountId || value.passwordInput!=='browser'
        || !['imap_smtp','smtp_only'].includes(value.connectionMode) || value.credentialStore!==(process.platform==='win32'?'dpapi':'keychain'))
        fail('ASSISTANT_SOURCE_SETUP_UNAVAILABLE');
      // Discard provider diagnostics, mailbox/address, config paths and labels.
      // Neither stdout nor the fact that the window closed is owner authority.
      return Object.freeze({sourceId,localAccountId:source.localAccountId,state:'configuration_saved',
        incomingEnabled:value.connectionMode==='imap_smtp',connectionVerified:false,
        ...(value.connectionMode==='imap_smtp'?{nextAction:{tool:'verify_assistant_email_source',arguments:{companyId,sourceId}}}:{})});
    });
  }catch(error){rethrowAssistantSourceError(error,{signal,setup:true});}
};

export const configureAssistantEmailSource = input => configureAssistantInteractiveSource(input,'email');
/** Opens the SAME provider's protected QR/2FA page on the assistant computer.
 * The human scans/types there. No terminal prompts, app identity, login factor,
 * human-session import, credential copying or automatic retry enters this host. */
export const configureAssistantTelegramSource = input => configureAssistantInteractiveSource(input,'telegram');
/** SAME protected browser and account engine. Neither handoff nor a fresh
 * structural home probe grants owner identity, chat routing or read ACK. */
export const configureAssistantMaxSource = input => configureAssistantInteractiveSource(input,'max');
export const verifyAssistantMaxSource = input => configureAssistantInteractiveSource(input,'max-verify');

/** Registration equality is shared with the background coordinator. A late
 * pause/revoke/rebind must invalidate a verification just as it invalidates
 * a poll; a successful provider read cannot resurrect stale desired state. */
export const sameAssistantSourceRegistration = (left,right) => Boolean(left && right)
  && ['id','companyId','deviceId','localAccountId','projectId','skillId','state','revision'].every(key=>left[key]===right[key])
  &&(left.maxChatUrl??null)===(right.maxChatUrl??null)
  &&(left.bindFromSourceId??null)===(right.bindFromSourceId??null)
  &&(left.ownerTaskIntakeAllowed===true)===(right.ownerTaskIntakeAllowed===true);

/** Independently verify incoming access AFTER a saved local configuration.
 * This reuses the exact passive reader and normal native/account/signature
 * gates. No SQLite is opened and the returned baseline/cursor/refs are thrown
 * away: testing a connection must not advance a live worker's durable position.
 * It checks INBOX metadata only, never SMTP, body processing or read-state.
 */
export const verifyAssistantEmailSource = async ({identity,host,store,client,companyId,sourceId,signal}) => {
  companyId=id(companyId);sourceId=id(sourceId);
  if(!identity || !client || typeof client.sourceAccounts!=='function'
    || ['origin','assistantId','deviceId'].some(key=>client.identity?.[key]!==identity[key]))fail('ASSISTANT_SOURCE_BINDING_CHANGED');
  const rows=await client.sourceAccounts(companyId,signal),source=rows.find(row=>row.id===sourceId);
  if(!source || source.state!=='active' || source.skillId!=='email-imap-smtp')fail('ASSISTANT_SOURCE_SETUP_REQUIRED');
  await readAssistantSourceMonitor({identity,host,store,signal,source:{companyId,projectId:source.projectId,
    skillId:source.skillId,accountId:source.localAccountId,cursor:null}});
  const current=(await client.sourceAccounts(companyId,signal)).find(row=>row.id===sourceId);
  if(signal?.aborted)fail('ASSISTANT_SOURCE_DEADLINE');
  if(!sameAssistantSourceRegistration(source,current))fail('ASSISTANT_SOURCE_BINDING_CHANGED');
  return Object.freeze({sourceId,localAccountId:source.localAccountId,state:'incoming_verified',
    verification:'imap_inbox_metadata',incomingVerified:true,outgoingVerified:false,
    queuePositionChanged:false,readStateChanged:false});
};

export const readAssistantSourceMonitor = async ({identity,host,store,source,signal}) => {
  if(!object(source) || Object.keys(source).some(key=>!['companyId','projectId','skillId','accountId','chat','folder','cursor','initialUnread','initialAccountCursor','sourceId','sourceRevision'].includes(key)))fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const scope=sourceScope({companyId:source.companyId,projectId:source.projectId,skillId:source.skillId});
  const accountId=id(source.accountId),cursor=source.cursor??null,chat=source.chat??null,folder=source.folder??null;
  const initialUnread=source.initialUnread??false;
  const initialAccountCursor=source.initialAccountCursor??null;
  const channel=typeof chat==='string' && /^-[1-9]\d{0,18}$/u.test(chat)
    && BigInt(chat)<-1000000000000n && BigInt(chat)>-9223372036854775808n;
  const emailInitial=scope.skillId==='email-imap-smtp'&&initialUnread;
  const maxInitial=scope.skillId==='max-web'&&initialUnread;
  if(typeof initialUnread!=='boolean' || maxInitial&&(cursor!==null||initialAccountCursor!==null)
    || initialUnread && !emailInitial&&!maxInitial && (scope.skillId!=='telegram-mtproto' || !channel || cursor!==null)
    ||emailInitial&&(chat!==null||initialAccountCursor!==null||cursor!==null&&!emailMonitorPosition(cursor,true))
    || initialAccountCursor!==null && (initialUnread || scope.skillId!=='telegram-mtproto' || !channel || cursor!==null || !sourceCursor(initialAccountCursor,scope.skillId))
    || cursor!==null && !sourceCursor(cursor,scope.skillId)
    || scope.skillId==='telegram-mtproto' && (folder!==null || chat!==null && !/^-?[1-9]\d{0,18}$/u.test(chat))
    || scope.skillId==='max-web' && (folder!==null || !assistantMaxChatUrl(chat))
    || scope.skillId==='email-imap-smtp' && (chat!==null || folder!==null && (typeof folder!=='string' || !folder.length || folder.length>256 || /[\x00-\x1f\x7f]/u.test(folder))))fail('ASSISTANT_SOURCE_INVALID_INPUT');
  try{
    return await withAssistantSourcePackage({identity,host,store,scope,signal,
      sourceSelection:source.sourceId===undefined?null:{sourceId:source.sourceId,expectedRevision:source.sourceRevision}},async({engine,profile,materialized,resolution,signal:combined})=>{
      // A fresh source cannot durably claim a baseline while silently losing
      // its historical unread seed. Existing forward positions are untouched.
      if(scope.skillId==='max-web'&&!engine.isStableVersionAtLeast(materialized.artifact.runtimeVersion,'2.11.0'))
        fail('ASSISTANT_SOURCE_HISTORY_CAPABILITY_REQUIRED');
      if(emailInitial&&!engine.isStableVersionAtLeast(materialized.artifact.runtimeVersion,'2.6.6'))
        fail('ASSISTANT_SOURCE_HISTORY_CAPABILITY_REQUIRED');
      const executionContext={...scope,releaseId:resolution.releaseId,localIdentity:resolution.localIdentity,
        companyConnection:resolution.companyConnection};
      const args=['monitor','--local-account',accountId,...(chat===null?[]:['--chat',chat]),
        ...(folder===null?[]:['--folder',folder]),...(cursor===null?[]:['--cursor',cursor]),
        ...(initialUnread?['--unread-backfill']:[]),...(initialAccountCursor===null?[]:['--initial-account-cursor',initialAccountCursor]),
        // Existing providers keep their passive ABI. Only a reviewed newer
        // signed email release is asked for bounded threading-header refs.
        ...(scope.skillId==='max-web'||scope.skillId==='email-imap-smtp'&&engine.isStableVersionAtLeast(materialized.artifact.runtimeVersion,'2.6.5')
          ?['--conversation-references']:[]),'--limit',scope.skillId==='email-imap-smtp'?'20':'100'];
      const selected=await engine.prepareSkillAccount({origin:identity.origin,artifact:materialized.artifact,
        runtimeDirectory:materialized.runtimeDirectory,executionContext,runtimeArguments:args});
      if(selected.handled || selected.account?.id!==accountId)fail('ASSISTANT_SOURCE_ACCOUNT_REQUIRED');
      executionContext.account=selected.account;
      const remaining=await profile.remainingMs();
      if(combined.aborted || remaining<1000)fail('ASSISTANT_SOURCE_DEADLINE');
      const result=await engine.runMaterializedAgentSkill({artifact:materialized.artifact,runtimeDirectory:materialized.runtimeDirectory,
        executionContext,runtimeArguments:selected.runtimeArguments,captureOutput:true,captureExitCode:true,
        timeoutMs:Math.min(60_000,remaining),signal:combined});
      await profile.remainingMs();
      if(combined.aborted)fail('ASSISTANT_SOURCE_DEADLINE');
      return projectAssistantMonitorPage(result,{skillId:scope.skillId,cursor,chat,initialUnread,initialAccountCursor,nativeMax:scope.skillId==='max-web'});
    });
  }catch(error){
    rethrowAssistantSourceError(error,{signal});
  }
};

/** Narrow ACK projection: no body/error prose/private provider envelope escapes
 * the trusted adapter. Only complete signed EOF output may establish no-write;
 * timeout, partial pipes and verify-only=false claims never clear an old fence. */
export const projectAssistantSourceAcknowledgement=(result,{target,verifyOnly})=>{
  const invalid=()=>fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  if(!object(result)||(!Number.isSafeInteger(result.exitCode)||result.exitCode<0)||typeof result.stdout!=='string'
    ||Buffer.byteLength(result.stdout)>1024*1024||typeof verifyOnly!=='boolean')invalid();
  let raw;try{raw=JSON.parse(result.stdout);}catch{invalid();}
  if(!object(raw))invalid();
  if(target.maxChatUrl!==undefined){
    if(result.exitCode!==0){
      const codes=['MAX_ACK_INPUT_INVALID','MAX_ACK_POLICY_DENIED','MAX_ACK_NATIVE_UNAVAILABLE','MAX_ACK_CHANGED',
        'MAX_ACK_COVERAGE_INCOMPLETE','MAX_ACK_UNAVAILABLE'];
      if(raw.ok!==false||!codes.includes(raw.code)||!object(raw.details)||raw.details.writeAttempted!==false
        ||raw.details.automaticRetryAllowed!==false||raw.details.writeOutcome!=='not_attempted')invalid();
      return {acknowledged:false,notAttempted:true,code:raw.code};
    }
    const state=raw.readState,ref=raw.reference;
    if(raw.ok!==true||raw.schemaVersion!==1||raw.protocol!=='max-message-ack/v1'||!object(ref)||!object(state)
      ||ref.id!==target.id||ref.revision!==target.revision||ref.conversationKey!==target.conversationKey
      ||ref.chatId!==target.chatId||ref.messageId!==target.messageId||typeof state.acknowledged!=='boolean'
      ||typeof state.writeAttempted!=='boolean'||state.coveredReferencesVerified!==true
      ||state.writeOutcome!==(state.writeAttempted?state.acknowledged?'confirmed':'unknown':'not_attempted')
      ||state.automaticRetryAllowed!==false||state.verifyOnly!==verifyOnly||verifyOnly&&state.writeAttempted
      ||state.viewsRegistered!==false||state.snapshotAtomic!==false)invalid();
    return {acknowledged:state.acknowledged,notAttempted:!state.writeAttempted,
      code:state.writeAttempted&&!state.acknowledged?'MAX_ACK_OUTCOME_UNKNOWN':null};
  }
  if(target.uid!==undefined){
    // This projection consumes a complete SAME-provider result privately.
    // Seen is per UID; no thread/range acknowledgement or sender proof exists.
    if(result.exitCode!==0){
      const codes=['EMAIL_ACK_CHANGED','EMAIL_ACK_POLICY_DENIED','EMAIL_ACK_UNAVAILABLE','EMAIL_ACK_UNVERIFIED'];
      const state=raw.readState;
      if(raw.ok!==false||!codes.includes(raw.code)||!object(state)||state.verified!==false
        ||typeof state.writeAttempted!=='boolean'||state.automaticRetryAllowed!==false
        ||state.writeOutcome!==(state.writeAttempted?'unknown':'not_attempted'))invalid();
      return {acknowledged:false,notAttempted:!state.writeAttempted,code:raw.code};
    }
    const state=raw.readState,ref=raw.reference;
    if(raw.schemaVersion!==1||raw.protocol!=='email-read-state/v1'||!object(ref)||!object(state)
      ||ref.id!==target.id||ref.revision!==target.revision||raw.originalSha256!==target.originalSha256
      ||state.verified!==true||typeof state.seen!=='boolean'||typeof state.writeAttempted!=='boolean'
      ||state.automaticRetryAllowed!==false||state.readReceiptsSent!==false
      ||verifyOnly&&state.writeAttempted||state.writeAttempted&&!state.seen)invalid();
    return {acknowledged:state.seen,notAttempted:!state.writeAttempted,code:null};
  }
  if(result.exitCode!==0){
    const codes=['TELEGRAM_ACK_RANGE_INCOMPLETE','TELEGRAM_ACK_RANGE_UNSUPPORTED','TELEGRAM_ACK_UNAVAILABLE',
      'TELEGRAM_ACK_OUTCOME_UNKNOWN','TELEGRAM_REFERENCE_CHANGED','TELEGRAM_REFERENCE_SCOPE_CHANGED'];
    if(raw.ok!==false||!codes.includes(raw.code)||!object(raw.details)
      ||typeof raw.details.writeAttempted!=='boolean'||raw.details.automaticRetryAllowed!==false
      ||raw.details.writeOutcome!==(raw.details.writeAttempted?'unknown':'not_attempted'))invalid();
    return {acknowledged:false,notAttempted:!raw.details.writeAttempted,code:raw.code};
  }
  const state=raw.readState,ref=raw.reference;
  if(raw.ok!==true||raw.schemaVersion!==1||raw.protocol!=='telegram-message-ack/v1'||!object(ref)||!object(state)
    ||ref.id!==target.id||ref.revision!==target.revision||ref.conversationKey!==target.conversationKey
    ||ref.chatId!==target.chatId||ref.messageId!==target.messageId
    ||typeof state.acknowledged!=='boolean'||typeof state.writeAttempted!=='boolean'
    ||state.writeOutcome!==(state.writeAttempted?'confirmed':'not_attempted')
    ||state.automaticRetryAllowed!==false||state.viewsRegistered!==false||state.snapshotAtomic!==false
    ||state.verifyOnly!==verifyOnly||verifyOnly&&state.writeAttempted||state.writeAttempted&&!state.acknowledged)invalid();
  return {acknowledged:state.acknowledged,notAttempted:!state.writeAttempted,code:null};
};

/** Model-free source ACK uses the SAME signed loader, managed catalogue and
 * native process engine. The caller supplies ORIGINAL private inbox refs and
 * synchronous reread/fence callbacks, never a model boolean or free-form CLI.
 * Native admission derives from immutable committed receipts, separately from
 * the provider's exact account/key/revision and contiguous-range verification. */
export const acknowledgeAssistantSource=async({identity,host,store,client,source,references,verifyOnly,
  assertReferences,beforeInvoke,signal})=>{
  if(!source||!['telegram-mtproto','email-imap-smtp','max-web'].includes(source.skillId)||source.state!=='active'||typeof verifyOnly!=='boolean'
    ||typeof assertReferences!=='function'||typeof beforeInvoke!=='function'||!client||typeof client.sourceAccounts!=='function'
    ||['origin','assistantId','deviceId'].some(key=>client.identity?.[key]!==identity?.[key])
    ||!Array.isArray(references)||!references.length||references.length>100)fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const email=source.skillId==='email-imap-smtp';
  const max=source.skillId==='max-web';
  if(max&&!assistantMaxChatUrl(source.maxChatUrl))fail('ASSISTANT_SOURCE_INVALID_INPUT');
  if(email&&references.length!==1)fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const refs=references.map(ref=>{
    if(!object(ref)||Object.keys(ref).sort().join(',')!==(email
      ?'conversationKey,eventKey,eventOrdinal,id,originalSha256,receiptId,revision,routeId,taskId'
      :'conversationKey,eventKey,eventOrdinal,id,receiptId,revision,routeId,taskId')
      ||!/^[0-9a-f]{64}$/u.test(ref.eventKey??'')||!/^[0-9a-f]{64}$/u.test(ref.revision??'')
      ||!assistantConversationKeyMatches(email?'email':max?'max':'telegram',ref.conversationKey))fail('ASSISTANT_SOURCE_INVALID_INPUT');
    const match=(email?/^uid:([1-9]\d{0,9}):([1-9]\d{0,9})$/u:max?/^message:(-?(?:0|[1-9]\d{0,18})):([1-9]\d{0,38})$/u:/^message:(-?[1-9]\d{0,18}):([1-9]\d{0,9})$/u).exec(ref.id??'');
    if(!match||(email?[match[1],match[2]].some(value=>Number(value)>4294967295)||!/^[0-9a-f]{64}$/u.test(ref.originalSha256??'')
      :max?source.maxChatUrl!==`https://web.max.ru/${match[1]}`:Number(match[2])>=2**31-1))fail('ASSISTANT_SOURCE_INVALID_INPUT');
    return {...ref,receiptId:id(ref.receiptId),routeId:id(ref.routeId),taskId:id(ref.taskId),
      ...(email?{uidValidity:match[1],uid:match[2]}:{chatId:match[1],messageId:match[2],...(max?{maxChatUrl:source.maxChatUrl}:{})})};
  });
  if(new Set(refs.map(ref=>ref.eventKey)).size!==refs.length||refs.some(ref=>ref.chatId!==refs[0].chatId
    ||ref.conversationKey!==refs[0].conversationKey))fail('ASSISTANT_SOURCE_INVALID_INPUT');
  // Multiple historical revisions of one message may have been processed.
  // Use the latest observed private row as the candidate; the signed provider
  // still verifies current native revisions and refuses a stale candidate.
  const covered=[...new Map(refs.map(ref=>[ref.messageId,ref])).values()].sort((a,b)=>BigInt(a.messageId??a.uid)<BigInt(b.messageId??b.uid)?-1:1);
  const target=covered.at(-1),receipts=new Map();
  for(const ref of refs){if(!receipts.has(ref.receiptId))receipts.set(ref.receiptId,[]);receipts.get(ref.receiptId).push(ref.eventOrdinal);}
  const intent=normalizeAssistantSourceAcknowledgement({sourceId:source.id,sourceRevision:source.revision,
    receipts:[...receipts].map(([receiptId,eventOrdinals])=>({receiptId,eventOrdinals:eventOrdinals.sort((a,b)=>a-b)})),
    ...(verifyOnly?{verifyOnly:true}:{})});
  const runtimeArguments=email?['ack-reference','--uid',target.uid,'--uid-validity',target.uidValidity,'--expected-revision',target.revision,
    '--expected-original-sha256',target.originalSha256,verifyOnly?'--verify-only':'--confirm']
    :['ack-reference','--chat',max?target.maxChatUrl:target.chatId,'--message-id',target.messageId,'--expected-revision',target.revision,
    '--expected-conversation-key',target.conversationKey,...(verifyOnly&&!max?[]:covered.flatMap(ref=>['--covered-reference',`${ref.messageId}:${ref.revision}`])),
    verifyOnly?'--verify-only':'--confirm'];
  const fresh=async()=>{
    if(signal?.aborted)fail('ASSISTANT_SOURCE_DEADLINE');
    const current=(await client.sourceAccounts(source.companyId,signal)).find(row=>row.id===source.id);
    if(!sameAssistantSourceRegistration(source,current))fail('ASSISTANT_SOURCE_BINDING_CHANGED');
    const result=assertReferences();if(result&&typeof result.then==='function')fail('ASSISTANT_SOURCE_INVALID_INPUT');
  };
  try{
    await fresh();
    return await withAssistantSourcePackage({identity,host,store,scope:{companyId:source.companyId,projectId:source.projectId,skillId:source.skillId},
      sourceAcknowledgement:intent,acknowledgementExecution:{accountId:source.localAccountId,runtimeArguments,
        slots:refs.map(ref=>({receiptId:ref.receiptId,routeId:ref.routeId,eventOrdinal:ref.eventOrdinal})),
        beforeInvoke:async()=>{await fresh();await beforeInvoke();}},signal},async({engine,profile,materialized,resolution,signal:combined})=>{
      if(max&&!engine.isStableVersionAtLeast(materialized.artifact.runtimeVersion,'2.11.0'))fail('ASSISTANT_SOURCE_HISTORY_CAPABILITY_REQUIRED');
      const executionContext={companyId:source.companyId,projectId:source.projectId,skillId:source.skillId,releaseId:resolution.releaseId,
        localIdentity:resolution.localIdentity,companyConnection:resolution.companyConnection};
      const selected=await engine.prepareSkillAccount({origin:identity.origin,artifact:materialized.artifact,runtimeDirectory:materialized.runtimeDirectory,
        executionContext,runtimeArguments:['ack-reference','--local-account',source.localAccountId,...runtimeArguments.slice(1)]});
      if(selected.handled||selected.account?.id!==source.localAccountId)fail('ASSISTANT_SOURCE_ACCOUNT_REQUIRED');
      executionContext.account=selected.account;
      const result=await engine.runMaterializedAgentSkill({artifact:materialized.artifact,runtimeDirectory:materialized.runtimeDirectory,
        executionContext,runtimeArguments:selected.runtimeArguments,captureOutput:true,captureExitCode:true,captureMode:'assistant_source_ack',
        timeoutMs:Math.min(60000,await profile.remainingMs()),signal:combined});
      await profile.remainingMs();await fresh();await profile.remainingMs();
      return projectAssistantSourceAcknowledgement(result,{target,verifyOnly});
    });
  }catch(error){rethrowAssistantSourceError(error,{signal});}
};

/** One original incoming owner command, through the SAME signed package,
 * account selector and process engine. This taskless read grants no task pass,
 * neighboring history, provider sending, read-state mutation or human vault.
 * The private journal ref is selected by the trusted host, never tool text. */
export const readAssistantOwnerIntakeMessage=async({identity,client,host,store,pass,source,reference,signal})=>{
  pass=validateAssistantActivePass(pass,identity);
  if(pass.kind!=='source_intake'||source.id!==pass.sourceId||source.companyId!==pass.companyId||source.revision!==pass.sourceRevision
    ||!['telegram-mtproto','max-web'].includes(source.skillId)||source.state!=='active'||source.ownerTaskIntakeAllowed!==true
    ||reference.eventId!==pass.eventId||!(source.skillId==='max-web'?(/^message:-?[1-9]\d{0,18}:[1-9]\d{0,18}$/u):(/^message:-?[1-9]\d{0,18}:[1-9]\d{0,9}$/u)).test(reference.id??'')
    ||!(/^[0-9a-f]{64}$/u).test(reference.revision??'')||!assistantConversationKeyMatches(source.skillId==='max-web'?'max':'telegram',reference.conversationKey))
    fail('ASSISTANT_INTAKE_ACCESS_DENIED');
  const [,chat,messageId]=reference.id.split(':');
  if(source.skillId==='max-web'&&source.maxChatUrl!==`https://web.max.ru/${chat}`)fail('ASSISTANT_INTAKE_ACCESS_DENIED');
  const args=['read-reference','--chat',source.skillId==='max-web'?source.maxChatUrl:chat,'--message-id',messageId,'--expected-revision',reference.revision,
    '--expected-conversation-key',reference.conversationKey];
  const check=async()=>{
    const active=validateAssistantActivePass(await host.readActivePass(),identity);
    if(JSON.stringify(active)!==JSON.stringify(pass))fail('ASSISTANT_INTAKE_CHANGED');
    const current=await client.readSourceIntake({companyId:pass.companyId,sourceId:pass.sourceId,intakeId:pass.passId},signal);
    if(current.state!=='leased'||current.threadId!==pass.threadId||current.eventId!==pass.eventId||current.sourceRevision!==pass.sourceRevision
      ||Date.parse(current.leaseExpiresAt)<=Date.now())fail('ASSISTANT_INTAKE_CHANGED');
    const rows=await client.sourceAccounts(pass.companyId,signal);
    if(!sameAssistantSourceRegistration(source,rows.find(row=>row.id===source.id)))fail('ASSISTANT_INTAKE_CHANGED');
  };
  await check();
  const scope=sourceScope({companyId:source.companyId,projectId:source.projectId,skillId:source.skillId});
  return withAssistantSourcePackage({identity,host,store,scope,signal,
    sourceIntake:{intakeId:pass.passId,sourceId:source.id,expectedRevision:source.revision},
    intakeExecution:{accountId:source.localAccountId,eventId:pass.eventId,threadId:pass.threadId,runtimeArguments:args,beforeInvoke:check}},
  async({engine,profile,materialized,resolution,signal:combined})=>{
    if(!engine.isStableVersionAtLeast(materialized.artifact.runtimeVersion,source.skillId==='max-web'?'2.11.0':'2.13.1'))fail('ASSISTANT_SOURCE_HISTORY_CAPABILITY_REQUIRED');
    const executionContext={...scope,releaseId:resolution.releaseId,localIdentity:resolution.localIdentity,companyConnection:resolution.companyConnection};
    const selected=await engine.prepareSkillAccount({origin:identity.origin,artifact:materialized.artifact,runtimeDirectory:materialized.runtimeDirectory,
      executionContext,runtimeArguments:['read-reference','--local-account',source.localAccountId,...args.slice(1)]});
    if(selected.handled||selected.account?.id!==source.localAccountId)fail('ASSISTANT_SOURCE_ACCOUNT_REQUIRED');
    executionContext.account=selected.account;
    const result=await engine.runMaterializedAgentSkill({artifact:materialized.artifact,runtimeDirectory:materialized.runtimeDirectory,
      executionContext,runtimeArguments:selected.runtimeArguments,captureMode:'assistant_source_intake',captureOutput:true,captureExitCode:true,
      timeoutMs:Math.min(60_000,await profile.remainingMs()),signal:combined});
    let value;try{value=JSON.parse(result.stdout);}catch{fail('ASSISTANT_SOURCE_READ_INVALID');}
    const owner=await profile.readIntakeOwner(),ref=value?.reference;
    if(result.exitCode!==0||!object(value)||value.schemaVersion!==1||value.protocol!==(source.skillId==='max-web'?'max-message-read/v1':'telegram-message-read/v1')
      ||!object(ref)||ref.id!==reference.id||ref.revision!==reference.revision||ref.conversationKey!==reference.conversationKey
      ||ref.senderNamespace!==(source.skillId==='max-web'?'max_user_id':'telegram_user_id')||ref.senderUserId!==owner.ownerExternalUserId
      ||ref.outgoing!==false||ref.forwarded!==false||source.skillId==='telegram-mtproto'&&ref.viaBot!==false
      ||source.skillId==='max-web'&&value.coverage?.nativeMessageVerified!==true
      ||!object(value.message)||typeof value.message.text!=='string'||Buffer.byteLength(value.message.text)>65536
      ||value.message.textTruncated!==false||source.skillId==='telegram-mtproto'&&value.message.replyContext!==null||value.coverage?.textComplete!==true
      ||value.coverage.contextIncluded!==false||value.coverage.attachmentsContentRead!==false||value.readState?.mode!=='history-only'
      ||value.readState.marksRead!==false||value.readState.readReceiptsSent!==false||value.readState.viewsRegistered!==false)
      fail('ASSISTANT_INTAKE_OWNER_UNVERIFIED');
    await check();
    // Native identity is returned ONLY to the private confirmation callback.
    // The model gets the original text after native read-confirm succeeds.
    return {text:value.message.text,...owner};
  });
};
