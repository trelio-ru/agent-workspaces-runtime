/** Fixed assistant-device transport. No human OAuth/cookie or arbitrary HTTP. */
import path from 'node:path';
import { validateAssistantActivePass } from './trelio-assistant-hook.mjs';
import { buildRuntimeSessionProof, withRuntimeStateLock } from './trelio-runtime-session.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { ASSISTANT_CADENCES, assistantPassContinuation } from './trelio-assistant-scheduler.mjs';
import { assistantExecutionConfiguration } from './trelio-assistant-codex.mjs';
import { PROCESS_DIAGNOSTIC_CODES } from './trelio-process-diagnostics.mjs';
import { assistantSourceProcessingReferences, assistantConversationKeyMatches } from './trelio-assistant-inbox.mjs';

export class AssistantTransportError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new AssistantTransportError(code, status); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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
      || row.provisionLocalAccount !== undefined && typeof row.provisionLocalAccount !== 'boolean'
      || row.interactiveSetupAllowed !== undefined && typeof row.interactiveSetupAllowed !== 'boolean'
      || row.interactiveSetupAllowed === true && (row.provisionLocalAccount !== true || !['email-imap-smtp','telegram-mtproto','max-web'].includes(row.skillId))
      || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision > 2_147_483_647) invalid();
    const sourceId = responseId(row.id);
    if (seen.has(sourceId)) invalid();
    seen.add(sourceId);
    return Object.freeze({ id:sourceId, companyId, deviceId, localAccountId:responseId(row.localAccountId),
      projectId:row.projectId === null ? null : responseId(row.projectId), skillId:row.skillId,
      state:row.state, revision:row.revision, provisionLocalAccount:row.provisionLocalAccount === true,
      ...(row.interactiveSetupAllowed===true?{interactiveSetupAllowed:true}:{}),executionVerified:false });
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

/** Public-key onboarding through the SAME company-encryption workflow. This
 * narrow async profile has TWO fixed endpoints only, no task pass/model proof,
 * payload/Workspace/Secret route, owner OAuth, scope-key grant or decryption.
 * Native company membership/MCP/module/device fences remain server authority. */
export const prepareAssistantCompanyEncryption = async ({identity,host,client,store,companyId,companySlug,signal,
  lockDirectory,lock=withRuntimeStateLock}) => {
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
  const handle=Object.freeze(Object.create(null));let owned=null;
  const profile=Object.freeze({kind:'digital_assistant_enrollment',companyEncryptionUserId:assistantId,
    async requireToken(requestOrigin){if(requestOrigin!==origin)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');await assertCurrent();return handle;},
    async resolveCompanyEncryptionDevice({origin:requestOrigin,companyId:requestedCompany}){
      if(requestOrigin!==origin||requestedCompany!==companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      const {resolveAssistantCompanyEncryptionDevice}=await import('./trelio-assistant-private.mjs');
      owned=await resolveAssistantCompanyEncryptionDevice({identity:expected,companyId,store,lockDirectory,lock,assertCurrent});
      return owned;
    },
    async prepareRequest({origin:requestOrigin,token,pathname,options,buildHeaders}){
      if(requestOrigin!==origin||token!==handle||typeof pathname!=='string'||typeof buildHeaders!=='function')fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      let url;try{url=new URL(pathname,origin);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
      if(url.origin!==origin||url.hash||url.pathname!==pathname.split('?')[0])fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      const method=String(options.method??'GET').toUpperCase();let suffix;
      if(method==='GET'&&url.pathname==='/api/agent-workspaces/encryption/runtime'&&options.body===undefined){
        const keys=[...url.searchParams.keys()];
        if(new Set(keys).size!==keys.length||keys.some(key=>!['companySlug','fingerprint'].includes(key))
          ||url.searchParams.get('companySlug')!==companySlug
          ||url.searchParams.has('fingerprint')&&url.searchParams.get('fingerprint')!==owned?.fingerprint)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        suffix='/runtime';
      }else if(method==='POST'&&url.pathname==='/api/agent-workspaces/encryption/devices'&&!url.search){
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
  const context=await common.withWorkspaceExecutionProfile(profile,async()=>common.ensureCompanyEncryptionContext({
    origin,token:handle,company:{id:companyId,slug:companySlug},registrationOnly:true,
    collectEncryptionKey:async()=>fail('ASSISTANT_WORKSPACE_PROFILE_DENIED'),
  }));
  await assertCurrent();
  if(context===null)return Object.freeze({schemaVersion:1,state:'not_required',companyId,businessReady:false});
  const runtime=context.runtime;
  if(runtime.company.id!==companyId||runtime.viewer?.userId!==assistantId||runtime.device?.fingerprint!==owned?.fingerprint
    ||!UUID.test(runtime.device?.id??'')||!['access_pending','ready'].includes(runtime.accessState))fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  // An envelope on the server is NOT verified/decrypted local scope access or
  // encrypted business readiness. Do not pass the envelope/key/JWK into MCP.
  return Object.freeze({schemaVersion:1,state:runtime.accessState==='ready'?'envelope_available':'awaiting_company_key',
    companyId,cryptoDeviceId:runtime.device.id,fingerprint:owned.fingerprint,businessReady:false,
    settingsUrl:`${origin}/${encodeURIComponent(runtime.company.slug)}/settings/encryption/`});
};

/** Internal composition of native Workspace transport. Device credentials
 * are resolved from the existing private slot through a callback, never a
 * model-visible getter or a human-token fallback. */
export const createAssistantWorkspaceProfile = async ({identity,client,store,host,lockDirectory,
  sourceReads=null,lock=withRuntimeStateLock,now=Date.now}) => {
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
  const assertIdentity=async()=>{
    const current=await host.readIdentity();
    if(!same(current,expectedIdentity) || !same(validateAssistantActivePass(await host.readActivePass(),identity),pass)) fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
  };
  const assertLivePass=async signal=>{
    await assertIdentity();
    const live=await client.readTaskPass(locator,signal);
    if(live.state!=='leased' || ['passId','threadId','deliveryId','bindingId','bindingRevision'].some(key=>live[key]!==pass[key])
      || !Number.isFinite(Date.parse(live.leaseExpiresAt)) || Date.parse(live.leaseExpiresAt)<=now()) fail('ASSISTANT_PASS_REVIEW_REQUIRED');
  };
  await assertIdentity();
  // This opaque handle cannot reveal a credential through native metadata or
  // an accidental caller serialization. Only prepareRequest resolves auth.
  const handle=Object.freeze(Object.create(null));
  return Object.freeze({
    kind:'digital_assistant',
    async resolveCompanyEncryptionDevice({origin:requestOrigin,companyId}){
      // Local keys and their company envelopes belong to this exact managed
      // device, never the ambient human's remembered encryption identity. The
      // common native HTTP policy still decides whether encrypted transport is
      // available; this private provider alone does not open any server route.
      if(requestOrigin!==identity.origin || companyId!==pass.companyId)fail('ASSISTANT_WORKSPACE_BINDING_CHANGED');
      const {resolveAssistantCompanyEncryptionDevice}=await import('./trelio-assistant-private.mjs');
      return resolveAssistantCompanyEncryptionDevice({identity,companyId,store,
        lockDirectory,assertCurrent:()=>assertLivePass(),lock});
    },
    async prepareSkillBodyRead(input){
      await assertIdentity();
      if(sourceReads)return sourceReads.prepare(input);
      if(['telegram-mtproto','email-imap-smtp'].includes(input.artifact?.skillId)&&input.runtimeArguments?.[0]==='read-reference')fail('ASSISTANT_SOURCE_READ_REQUIRED');
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
    async resolveSkillCatalogueDirectory(configDirectory){
      await assertIdentity();
      return assistantSkillCatalogueDirectory(configDirectory,identity);
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
      if(requestOrigin!==identity.origin || token!==handle || typeof pathname!=='string' || pathname.length>16_384
        || typeof buildHeaders!=='function') fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      let url;try{url=new URL(pathname,identity.origin);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
      if(url.origin!==identity.origin || url.hash || url.pathname!==pathname.split('?')[0]) fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      const method=String(options.method??'GET').toUpperCase();
      let rewritten,route;
      if(url.pathname==='/api/agent-skills/runtime/resolve' && method==='POST'
        || url.pathname==='/api/agent-skills/runtime/package' && method==='GET'){
        // The signed-skill engine is shared. Only its two existing read
        // endpoints gain this narrower device/task profile; consent, setup,
        // remote MCP and secret routes remain denied before credential I/O.
        let input;
        try{input=method==='GET'?Object.fromEntries(url.searchParams):JSON.parse(options.body);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
        if(!object(input) || input.companyId!==pass.companyId
          || method==='GET' && new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        rewritten=url.pathname;
        route={proofTool:method==='POST'?'assistant-skill:resolve':'assistant-skill:package'};
      }else{
        if(!pathname.startsWith(nativePrefix+'/'))fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
        rewritten=assistantPrefix+url.pathname.slice(nativePrefix.length);
        route=assistantWorkspaceConcreteRequest(method,rewritten);
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
        headers.set('x-trelio-assistant-pass',JSON.stringify(locator));
        headers.set('x-trelio-assistant-proof',JSON.stringify(proof));
        await withCredential(credential=>{headers.set('authorization',`Bearer ${credential}`);});
        await assertIdentity();
        url.pathname=rewritten;
        return {url,headers,options:{redirect:'error',credentials:'omit',cache:'no-store'}};
      });
    },
  });
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
      ||row.skillId!==({telegram:'telegram-mtproto',email:'email-imap-smtp'}[ref.scope.provider])
      ||row.localAccountId!==ref.scope.accountId)fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
    if(!routeRequired)return row;
    const routes=await client.sourceRoutes({companyId:pass.companyId,sourceId:row.id,sourceRevision:row.revision,
      conversationKeys:[ref.conversation_key]},signal);
    if(!routes.some(route=>route.id===ref.routeId&&route.bindingId===pass.bindingId&&route.bindingRevision===pass.bindingRevision
      &&route.taskId===pass.taskId))fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
    return row;
  };
  return Object.freeze({
    async prepare({artifact,executionContext,runtimeArguments}){
      if(!['telegram-mtproto','email-imap-smtp'].includes(artifact?.skillId)||runtimeArguments?.[0]!=='read-reference')return null;
      const email=artifact.skillId==='email-imap-smtp',provider=email?'email':'telegram';
      // This is an exact native protocol, not general option stripping. Extra,
      // repeated or missing selectors cannot be interpreted as this body read.
      if(runtimeArguments.length!==9)fail('ASSISTANT_SOURCE_READ_REQUIRED');
      const fields=new Map();
      for(let i=1;i<runtimeArguments.length;i+=2){
        const name=runtimeArguments[i];
        if(!(email?['--uid','--uid-validity','--expected-revision','--expected-conversation-key']
          :['--chat','--message-id','--expected-revision','--expected-conversation-key']).includes(name)||fields.has(name))fail('ASSISTANT_SOURCE_READ_REQUIRED');
        fields.set(name,runtimeArguments[i+1]);
      }
      const eventId=email?`uid:${fields.get('--uid-validity')}:${fields.get('--uid')}`
        :`message:${fields.get('--chat')}:${fields.get('--message-id')}`;
      const pass=await current();
      if(executionContext?.companyId!==pass.companyId||!UUID.test(executionContext.account?.id??''))fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
      const refs=await withInbox(inbox=>inbox.externalDeliveryReferences(pass));
      const matched=refs.filter(row=>row.scope.provider===provider&&row.scope.accountId===executionContext.account.id
        &&row.event_id===eventId&&row.event_revision===fields.get('--expected-revision')
        &&row.conversation_key===fields.get('--expected-conversation-key'));
      if(matched.length!==1)fail('ASSISTANT_SOURCE_READ_REQUIRED');
      const ref=matched[0],source=await authorize(pass,ref);
      if(source.projectId!==null&&executionContext.projectId!==source.projectId)fail('ASSISTANT_SOURCE_SCOPE_CHANGED');
      const ticket=Object.freeze({pass,ref});tickets.add(ticket);return ticket;
    },
    async commit(ticket,{stdout}){
      if(!tickets.has(ticket))fail('ASSISTANT_SOURCE_READ_REQUIRED');tickets.delete(ticket);
      let value;try{value=JSON.parse(stdout);}catch{fail('ASSISTANT_SOURCE_READ_INVALID');}
      const {pass,ref}=ticket;
      const email=ref.scope.provider==='email';
      if(!object(value)||value.schemaVersion!==1||value.protocol!==(email?'email-message-read/v1':'telegram-message-read/v1')
        ||value.reference?.id!==ref.event_id||value.reference?.revision!==ref.event_revision
        ||value.reference?.conversationKey!==ref.conversation_key||!object(value.message)
        ||!object(value.coverage)||value.coverage.textComplete!==true||value.coverage.attachmentsContentRead!==false
        ||value.readState?.marksRead!==false||value.readState.readReceiptsSent!==false
        ||(email?typeof value.message.body!=='string'||value.coverage.otherMessagesIncluded!==false||!/^[0-9a-f]{64}$/u.test(value.originalSha256??'')
          ||ref.event_id!==`uid:${value.reference.uidValidity}:${value.reference.uid}`
          :value.message.textTruncated!==false||value.coverage.contextIncluded!==false
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

/** Host-private client. Model tools receive only projections from these named
 * operations; no method returns the credential or delegates an arbitrary URL. */
export const createAssistantDeviceClient = ({ origin, assistantId, deviceId, store, http }) => {
  origin = originOf(origin); assistantId = id(assistantId); deviceId = id(deviceId);
  if (!store || typeof store.get !== 'function' || typeof http !== 'function') fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  const call = async (operation, body, signal) => http(operation, body,
    await loadAssistantDeviceCredential({ origin, assistantId, deviceId, store }), signal);

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
      // Only opaque provider/account HMACs cross this fixed boundary. The
      // native server rechecks owner/source/task/device authority on EVERY read;
      // an old SQLite mapping or a model-authored key never grants body access.
      const key=value=>['telegram','email'].some(provider=>assistantConversationKeyMatches(provider,value));
      if(!object(input)||Object.keys(input).sort().join(',')!=='companyId,conversationKeys,sourceId,sourceRevision'
        ||!Number.isSafeInteger(input.sourceRevision)||input.sourceRevision<0||input.sourceRevision>2_147_483_647
        || !Array.isArray(input.conversationKeys)||!input.conversationKeys.length||input.conversationKeys.length>100
        || input.conversationKeys.some(value=>!key(value))||new Set(input.conversationKeys).size!==input.conversationKeys.length)
        fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      const body={companyId:id(input.companyId),sourceId:id(input.sourceId),sourceRevision:revision(input.sourceRevision),
        conversationKeys:[...input.conversationKeys]};
      const value=await call('sourceRoutes',body,signal);
      if(value.schemaVersion!==1||value.sourceId!==body.sourceId||value.sourceRevision!==body.sourceRevision
        ||!Array.isArray(value.routes)||value.routes.length>body.conversationKeys.length)fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      const seen=new Set();
      return value.routes.map(row=>{
        if(!object(row)||row.sourceId!==body.sourceId||row.sourceRevision!==body.sourceRevision
          ||!body.conversationKeys.includes(row.conversationKey)||seen.has(row.conversationKey))fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
        seen.add(row.conversationKey);
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
        encryptionState: company.encryptionState === null ? null : text(company.encryptionState, 64), execution:executionState(company.execution) }));
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
    async registerRuntime(input,signal) {
      if(!object(input.observation) || input.observation.schemaVersion!==1 || input.observation.clientFamily!=='codex'
        || input.observation.source!=='codex_hook' || input.observation.evidenceLevel!=='local_observed'
        || !/^[a-z0-9._:+/-]{1,255}$/iu.test(input.observation.modelId??'')
        || ![null,'low','medium','high','xhigh','max','ultra'].includes(input.observation.effortLevel)
        || !Number.isFinite(Date.parse(input.observation.observedAt)) || !/^[A-Za-z0-9_-]{40,256}$/u.test(input.publicKeySpki??'')) fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
      const value=await call('registerRuntime',{companyId:id(input.companyId),taskId:id(input.taskId),passId:id(input.passId),
        clientSessionId:id(input.clientSessionId),observation:input.observation,publicKeySpki:input.publicKeySpki,
        ...(input.previousRuntimeSessionId?{previousRuntimeSessionId:id(input.previousRuntimeSessionId)}:{})},signal);
      if(value.schemaVersion!==1 || value.passId!==input.passId || value.conversation?.conversationId!==input.clientSessionId
        || value.conversation?.provider!=='codex' || value.conversation?.openProtocol!=='codex-thread-v1'
        || !Number.isFinite(Date.parse(value.expiresAt)) || value.runtimeRefreshSupported!==true
        || !object(value.observation)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      for(const key of ['schemaVersion','clientFamily','modelId','effortLevel','evidenceLevel','source'])
        if(value.observation[key]!==input.observation[key]) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return {schemaVersion:1,passId:id(value.passId),runtimeSessionId:id(value.runtimeSessionId),expiresAt:isoTimestamp(value.expiresAt),
        observation:Object.fromEntries(['schemaVersion','clientFamily','modelId','effortLevel','evidenceLevel','source','observedAt'].map(key=>[key,key==='observedAt'?isoTimestamp(value.observation[key]):value.observation[key]])),
        runtimeRefreshSupported:true};
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
export const assistantModelInputSchema = source => {
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
    for(const key of ['taskPass','runtimeSessionProof','sourceProcessingProof']){
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
export const createAssistantMcpClient = ({ origin, assistantId, deviceId, store, httpRequest, materializeAttachment, timeoutMs = 30_000 }) => {
  origin = originOf(origin); assistantId = id(assistantId); deviceId = id(deviceId);
  if (!store || typeof store.get !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) fail("ASSISTANT_TRANSPORT_INVALID_INPUT");
  const perform = async (action, signal) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const protocol = await import("./trelio-remote-mcp.mjs");
      const request = httpRequest ?? protocol.remoteMcpHttpRequest;
      const credential = await loadAssistantDeviceCredential({ origin, assistantId, deviceId, store });
      if (boundedSignal.aborted) fail("ASSISTANT_MCP_UNAVAILABLE");
      // A trusted internal authentication profile, not a personal PAT/OAuth
      // declaration. The public provider-config validator still rejects it.
      const config = { endpoint: `${origin}/mcp/assistant`, protocolVersion: "2025-06-18", headers: {},
        authentication: { type: "assistant_device" } };
      const session = await protocol.createRemoteSession(config, credential, request, { signal: boundedSignal });
      try { return await action({ protocol, config, credential, session, request, signal: boundedSignal }); }
      finally { await protocol.closeRemoteSession(config, credential, session.sessionId, request, { signal: boundedSignal }); }
    } catch (error) {
      if (error instanceof AssistantTransportError) throw error;
      // Raw HTTP/JSON-RPC errors may contain paths or upstream detail. Preserve
      // the private credential and queue; never login or retry a tools/call.
      fail("ASSISTANT_MCP_UNAVAILABLE");
    }
  };
  return {
    async listTools(signal) {
      return perform(async ({ protocol, config, credential, session, request, signal }) => {
        const tools = await protocol.listRemoteTools(config, credential, session, request, { signal });
        const seen = new Set();
        const selected = tools.filter(tool => ASSISTANT_MCP_TOOLS.includes(tool?.name)
          && (tool.name !== "download_attachment" || typeof materializeAttachment === "function")).map(tool => {
          if (seen.has(tool.name) || typeof tool.description !== "string" || tool.description.length > 4096
            || !object(tool.inputSchema) || tool.inputSchema.type !== "object") fail("ASSISTANT_MCP_INVALID_RESPONSE");
          seen.add(tool.name);
          // Do not proxy remote App metadata, URLs or OAuth security schemes.
          return { name: tool.name, description: tool.description, inputSchema: assistantModelInputSchema(tool.inputSchema),
            annotations: { readOnlyHint: ASSISTANT_MCP_READ_TOOLS.includes(tool.name), destructiveHint: tool.annotations?.destructiveHint===true,
              idempotentHint: tool.annotations?.idempotentHint===true, openWorldHint: false } };
        });
        if (!seen.has("get_assistant_status") || JSON.stringify(selected).includes(credential) || Buffer.byteLength(JSON.stringify(selected)) > 65_536) fail("ASSISTANT_MCP_INVALID_RESPONSE");
        return selected;
      }, signal);
    },
    async callTool(name, args, signal) {
      if (!ASSISTANT_MCP_TOOLS.includes(name) || name === "download_attachment" && typeof materializeAttachment !== "function" || !object(args) || Buffer.byteLength(JSON.stringify(args)) > 65_536) fail("ASSISTANT_CAPABILITY_UNAVAILABLE");
      // Snapshot once before asynchronous private/network I/O, as in the shared
      // Remote MCP transport. A mutable caller cannot replace reviewed args.
      const argumentsSnapshot = JSON.parse(JSON.stringify(args));
      return perform(async ({ protocol, config, credential, session, request, signal }) => {
        const response = await request({ config, credential, sessionId: session.sessionId, payload: {
          jsonrpc: "2.0", id: session.nextRequestId(), method: "tools/call", params: { name, arguments: argumentsSnapshot },
        } }, { signal });
        const value = protocol.assertJsonRpcResult(response, "tools/call");
        if (!object(value) || !Array.isArray(value.content) || value.content.length > 20
          || value.content.some(item => !object(item) || item.type !== "text" || typeof item.text !== "string")
          || (value.structuredContent !== undefined && !object(value.structuredContent))
          || (value.isError !== undefined && typeof value.isError !== "boolean")
          || JSON.stringify(value).includes(credential) || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) fail("ASSISTANT_MCP_INVALID_RESPONSE");
        // Binary plans never enter model context. The trusted production
        // callback composes the common device/pass HTTP profile and private
        // local-file primitive under this same non-renewable MCP deadline.
        if (name === "download_attachment" && value.isError !== true) return materializeAttachment({
          result: value, attachmentId: argumentsSnapshot.attachmentId, signal });
        return { content: value.content.map(({ type, text }) => ({ type, text })),
          ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }),
          ...(value.isError === undefined ? {} : { isError: value.isError }) };
      }, signal);
    },
  };
};

/** Read one fixed, authenticated original under the active Workspace profile.
 * A remote descriptor cannot choose an origin, route, local destination or
 * header. Only its exact native task/attachment revision selects the bytes.
 * Buffering is bounded by the existing local-file limit and never returned by
 * MCP; permissions, one-hour lease and cleanup remain in the shared primitive. */
export const materializeAssistantAttachment = async ({ result, attachmentId, origin, signal,
  common, attachments }) => {
  common ??= await import('./trelio-workspace.mjs');
  attachments ??= await import('./trelio-local-attachments.mjs');
  const value=result?.structuredContent;
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
const assistantWorkspacePolicyDenied = () => new AssistantWorkspacePolicyError();
// Mount the existing native handlers, but admit only this reviewed data plane.
// New routes added to the human plugin do not silently become assistant tools,
// especially restore/cancel, secrets, company context, grants and proposals.
const assistantWorkspaceReadPaths = new Set([
    "/bridge-compatibility", "/bridge-routing",
    "/scopes/:scopeType/:scopeId/attachments/:attachmentId",
    "/scopes/:scopeType/:scopeId", "/workspaces/:workspaceId", "/workspaces/:workspaceId/runs/:runId",
    "/workspaces/:workspaceId/read-snapshot", "/workspaces/:workspaceId/bundle", "/workspaces/:workspaceId/file",
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
]);
export const assistantWorkspaceOperation = (method, route) => {
    if (!route.startsWith(ASSISTANT_WORKSPACE_PREFIX + "/"))
        throw assistantWorkspacePolicyDenied();
    const nativePath = route.slice(ASSISTANT_WORKSPACE_PREFIX.length);
    if ((method === "GET" || method === "HEAD") && assistantWorkspaceReadPaths.has(nativePath))
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
        ? [...assistantWorkspaceReadPaths] : [...assistantWorkspaceWritePaths.keys()].filter(key => key.startsWith(method + " ")).map(key => key.slice(method.length + 1));
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
export const createAssistantSourceRuntimeProfile = async ({identity,host,store,scope,accountSetup=null,sourceAcknowledgement=null,acknowledgementExecution=null,
  monotonic=()=>performance.now(),startedAt=monotonic()}) => {
  scope=sourceScope(scope);
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
    if(accountSetup!==null||!['telegram-mtproto','email-imap-smtp'].includes(scope.skillId)||!object(acknowledgementExecution)
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
  let creation=null,creationUsed=false;
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
    async resolveSkillCatalogueDirectory(configDirectory){
      await assertCurrent();
      return assistantSkillCatalogueDirectory(configDirectory,expected);
    },
    async authorizeAccountCreation(command,context){
      await assertCurrent();
      // The private native response, not a local boolean/model assertion,
      // supplies authority. This profile can consume precisely one EMPTY
      // catalogue create: never import, bind, rename, login or launch a provider.
      if(!creation || creationUsed || command.operation!=='create' || command.id!==creation.accountId
        || command.name!==scope.skillId || (command.comment??'')!==''
        || context.companyId!==scope.companyId || (context.projectId??null)!==scope.projectId
        || context.skillId!==scope.skillId || context.memberId!==creation.memberId
        || (context.connectionId??null)!==creation.connectionId)fail('ASSISTANT_SKILL_SETUP_REQUIRED');
      creationUsed=true;
      return Object.freeze({creationRequestId:accountSetup.sourceId});
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
          ...(accountSetup?{accountSetup}:{}),...(sourceAcknowledgement?{sourceAcknowledgement}:{})})) fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
        // Fence dispatch even when a local read/network response fails. Another
        // poll needs a fresh profile, not an implicit retry under this lease.
        resolveSent=true;
      }else if(pathname===packagePath && method==='GET' && !packageSent && options.body===undefined){
        packageSent=true;
      }else fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
      await assertCurrent();
      const headers=buildHeaders(null,options.headers??{});
      for(const key of ['cookie','cookie2','proxy-authorization','x-trelio-assistant-pass','x-trelio-assistant-proof'])headers.delete(key);
      headers.set('x-trelio-assistant-source-protocol','1');
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
        || admission.provider!==protocol.provider || admission.protocol!==(sourceAcknowledgement
          ?(scope.skillId==='email-imap-smtp'?'email-read-state/v1':'telegram-message-ack/v1'):setupCommand?interactiveProtocol:protocol.protocol)
        || admission.command!==(sourceAcknowledgement?'ack-reference':setupCommand?interactiveCommand:'monitor')
        || admission.pollIntervalSeconds!==300 || admission.maximumDurationMs!==(interactive?10*60_000:60_000)
        || typeof admission.issuedAt!=='string' || typeof admission.expiresAt!=='string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(admission.issuedAt)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(admission.expiresAt)
        || !Number.isFinite(issued) || !Number.isFinite(expires) || (sourceAcknowledgement?expires-issued<=0||expires-issued>maximumBudgetMs:expires-issued!==maximumBudgetMs)
        || resolution.localIdentity?.companyId!==scope.companyId || resolution.localIdentity?.projectId!==scope.projectId
        || resolution.artifact.skillId!==scope.skillId || resolution.artifact.contentProtection!=='plain'
        || resolution.trust.level!=='platform_verified' || resolution.trust.artifactLevel!=='platform_verified'
        || resolution.trust.requiresDeviceConsent || resolution.companyConnection?.secretBindings.length
        || resolution.companyConnection && !resolution.companyConnection.configured) fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      const url=new URL(resolution.packageUrl,origin);
      const query={companyId:scope.companyId,...(scope.projectId?{projectId:scope.projectId}:{}),skillId:scope.skillId,
        expectedReleaseId:resolution.releaseId,artifactId:resolution.artifact.id,
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
      if(accountSetup){
        const approved=admission.accountSetup;
        if(!object(approved) || Object.keys(approved).sort().join(',')!=='localAccountId,operation,schemaVersion,sourceId,sourceRevision'
          || approved.schemaVersion!==1 || approved.operation!==(setupCommand?accountSetup.operation:'create') || approved.sourceId!==accountSetup.sourceId
          || approved.sourceRevision!==accountSetup.expectedRevision || !UUID.test(approved.localAccountId??'')
          || !UUID.test(resolution.localIdentity.memberId??''))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
        const bound={accountId:id(approved.localAccountId),memberId:id(resolution.localIdentity.memberId),
          connectionId:resolution.localIdentity.connectionId??null};
        if(setupCommand)interactiveSetup=Object.freeze({...bound,artifactId:id(resolution.artifact.id),releaseId:id(resolution.releaseId)});
        else creation=Object.freeze(bound);
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
export const projectAssistantMonitorPage = (result,{skillId,cursor=null,chat=null,initialUnread=false,initialAccountCursor=null}) => {
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
  if(typeof initialUnread!=='boolean' || initialUnread && (skillId!=='telegram-mtproto' || !channel || cursor!==null)
    || initialAccountCursor!==null && (initialUnread || skillId!=='telegram-mtproto' || !channel || cursor!==null || !cursorRef(initialAccountCursor))
    || backfill && (skillId!=='telegram-mtproto' || !channel || accountInterval===unreadInterval
      || accountInterval && raw.coverage.earlierEditsIncluded!==false || raw.coverage.snapshotAtomic!==false || raw.hasMore!==true)
    || !backfill && (accountInterval||unreadInterval)
    || initialUnread && (!backfill || !unreadInterval) || initialAccountCursor!==null && (!backfill || !accountInterval))invalid();
  if(raw.schemaVersion!==1 || typeof raw.baselineOnly!=='boolean' || raw.baselineOnly!==(cursor===null && !initialUnread && initialAccountCursor===null)
    || !Array.isArray(raw.events) || raw.events.length>100 || raw.baselineOnly && raw.events.length
    || typeof raw.hasMore!=='boolean' || !cursorRef(raw.nextCursor)
    || !backfill && raw.coverage?.historicalBackfill!==false || raw.readState?.readReceiptsSent!==false)invalid();
  if(skillId==='email-imap-smtp' && raw.coverage.bodyContentRead!==false
    || skillId==='max-web' && (raw.coverage.ownerIdentityAvailable!==false
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
      if(row.kind==='delete' || row.id!==`message:${row.messageId}` || row.senderUserId!==null
        || row.senderNamespace!==null || raw.coverage.ownerIdentityAvailable!==false)invalid();
      Object.assign(event,{senderUserId:null,senderNamespace:null});
    }
    return event;
  });
  const page={schemaVersion:1,baselineOnly:raw.baselineOnly,events,nextCursor:raw.nextCursor,hasMore:raw.hasMore,
    ...(backfill?{[accountInterval?'initialAccountBackfill':'initialUnreadBackfill']:true}:{})};
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
export const withAssistantSourcePackage = async ({identity,host,store,scope,accountSetup=null,sourceAcknowledgement=null,acknowledgementExecution=null,signal},action) => {
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
        method:'POST',body:JSON.stringify({...scope,expectedReleaseId:null,...(accountSetup?{accountSetup}:{}),...(sourceAcknowledgement?{sourceAcknowledgement}:{})}),
        headers:{'content-type':'application/json'},signal:combined,maximumErrorResponseBytes:16_384});
      const bytes=await engine.readBoundedResponseBuffer(response,512*1024,'Source resolution');
      let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
      const resolution=engine.normalizeResolvedSkillRuntimeArtifact(raw,{transportProfile:'assistant_source'});
      await profile.bindResolution(resolution,raw.sourceAdmission);raw=null;
      return {resolution,token};
    };
    profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope,accountSetup,sourceAcknowledgement,acknowledgementExecution,startedAt});
    const initial=await engine.withWorkspaceExecutionProfile(profile,async()=>{
      const {resolution,token}=await resolve();
      const materialized=await engine.materializeResolvedAgentSkillRuntime({origin:identity.origin,token,resolution,
        requestOptions:{signal:combined,maximumErrorResponseBytes:16_384}});
      await profile.remainingMs();
      const capabilities=materialized.artifact.parsedPackage.capabilities;
      if(!['network','local-session','local-accounts-v1'].every(value=>capabilities.includes(value))
        || capabilities.includes('secret-checkout'))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      if(!accountSetup&&!sourceAcknowledgement)return {result:await action({engine,profile,materialized,resolution,signal:combined})};
      return {materialized,resolution};
    });
    if(!accountSetup&&!sourceAcknowledgement)return initial.result;
    // Exit the first async profile before entering the fresh one. The common
    // engine deliberately refuses nested profile replacement; retain that
    // device/human-isolation guard and its closed tombstone semantics.
    profile.close();
    profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope,accountSetup,sourceAcknowledgement,acknowledgementExecution,startedAt});
    return await engine.withWorkspaceExecutionProfile(profile,async()=>{
      const fresh=await resolve();
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
  if(!source || source.state!=='active' || source.provisionLocalAccount!==true)fail('ASSISTANT_SOURCE_SETUP_REQUIRED');
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
      const result=await prepare(['account','create','--id',source.localAccountId,'--name',scope.skillId,
        '--expected-revision',String(listed.revision)]);
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
  && ['id','companyId','deviceId','localAccountId','projectId','skillId','state','revision'].every(key=>left[key]===right[key]);

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
  if(!object(source) || Object.keys(source).some(key=>!['companyId','projectId','skillId','accountId','chat','folder','cursor','initialUnread','initialAccountCursor'].includes(key)))fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const scope=sourceScope({companyId:source.companyId,projectId:source.projectId,skillId:source.skillId});
  const accountId=id(source.accountId),cursor=source.cursor??null,chat=source.chat??null,folder=source.folder??null;
  const initialUnread=source.initialUnread??false;
  const initialAccountCursor=source.initialAccountCursor??null;
  const channel=typeof chat==='string' && /^-[1-9]\d{0,18}$/u.test(chat)
    && BigInt(chat)<-1000000000000n && BigInt(chat)>-9223372036854775808n;
  if(typeof initialUnread!=='boolean' || initialUnread && (scope.skillId!=='telegram-mtproto' || !channel || cursor!==null)
    || initialAccountCursor!==null && (initialUnread || scope.skillId!=='telegram-mtproto' || !channel || cursor!==null || !sourceCursor(initialAccountCursor,scope.skillId))
    || cursor!==null && !sourceCursor(cursor,scope.skillId)
    || scope.skillId==='telegram-mtproto' && (folder!==null || chat!==null && !/^-?[1-9]\d{0,18}$/u.test(chat))
    || scope.skillId==='max-web' && (folder!==null || typeof chat!=='string' || !/^https:\/\/web\.max\.ru\/[A-Za-z0-9_-]{1,128}$/u.test(chat))
    || scope.skillId==='email-imap-smtp' && (chat!==null || folder!==null && (typeof folder!=='string' || !folder.length || folder.length>256 || /[\x00-\x1f\x7f]/u.test(folder))))fail('ASSISTANT_SOURCE_INVALID_INPUT');
  try{
    return await withAssistantSourcePackage({identity,host,store,scope,signal},async({engine,profile,materialized,resolution,signal:combined})=>{
      const executionContext={...scope,releaseId:resolution.releaseId,localIdentity:resolution.localIdentity,
        companyConnection:resolution.companyConnection};
      const args=['monitor','--local-account',accountId,...(chat===null?[]:['--chat',chat]),
        ...(folder===null?[]:['--folder',folder]),...(cursor===null?[]:['--cursor',cursor]),
        ...(initialUnread?['--unread-backfill']:[]),...(initialAccountCursor===null?[]:['--initial-account-cursor',initialAccountCursor]),
        // Existing providers keep their passive ABI. Only a reviewed newer
        // signed email release is asked for bounded threading-header refs.
        ...(scope.skillId==='email-imap-smtp'&&engine.isStableVersionAtLeast(materialized.artifact.runtimeVersion,'2.6.5')
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
      return projectAssistantMonitorPage(result,{skillId:scope.skillId,cursor,chat,initialUnread,initialAccountCursor});
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
  if(!source||!['telegram-mtproto','email-imap-smtp'].includes(source.skillId)||source.state!=='active'||typeof verifyOnly!=='boolean'
    ||typeof assertReferences!=='function'||typeof beforeInvoke!=='function'||!client||typeof client.sourceAccounts!=='function'
    ||['origin','assistantId','deviceId'].some(key=>client.identity?.[key]!==identity?.[key])
    ||!Array.isArray(references)||!references.length||references.length>100)fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const email=source.skillId==='email-imap-smtp';
  if(email&&references.length!==1)fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const refs=references.map(ref=>{
    if(!object(ref)||Object.keys(ref).sort().join(',')!==(email
      ?'conversationKey,eventKey,eventOrdinal,id,originalSha256,receiptId,revision,routeId,taskId'
      :'conversationKey,eventKey,eventOrdinal,id,receiptId,revision,routeId,taskId')
      ||!/^[0-9a-f]{64}$/u.test(ref.eventKey??'')||!/^[0-9a-f]{64}$/u.test(ref.revision??'')
      ||!assistantConversationKeyMatches(email?'email':'telegram',ref.conversationKey))fail('ASSISTANT_SOURCE_INVALID_INPUT');
    const match=(email?/^uid:([1-9]\d{0,9}):([1-9]\d{0,9})$/u:/^message:(-?[1-9]\d{0,18}):([1-9]\d{0,9})$/u).exec(ref.id??'');
    if(!match||(email?[match[1],match[2]].some(value=>Number(value)>4294967295)||!/^[0-9a-f]{64}$/u.test(ref.originalSha256??'')
      :Number(match[2])>=2**31-1))fail('ASSISTANT_SOURCE_INVALID_INPUT');
    return {...ref,receiptId:id(ref.receiptId),routeId:id(ref.routeId),taskId:id(ref.taskId),
      ...(email?{uidValidity:match[1],uid:match[2]}:{chatId:match[1],messageId:match[2]})};
  });
  if(new Set(refs.map(ref=>ref.eventKey)).size!==refs.length||refs.some(ref=>ref.chatId!==refs[0].chatId
    ||ref.conversationKey!==refs[0].conversationKey))fail('ASSISTANT_SOURCE_INVALID_INPUT');
  // Multiple historical revisions of one message may have been processed.
  // Use the latest observed private row as the candidate; the signed provider
  // still verifies current native revisions and refuses a stale candidate.
  const covered=[...new Map(refs.map(ref=>[ref.messageId,ref])).values()].sort((a,b)=>Number(a.messageId)-Number(b.messageId));
  const target=covered.at(-1),receipts=new Map();
  for(const ref of refs){if(!receipts.has(ref.receiptId))receipts.set(ref.receiptId,[]);receipts.get(ref.receiptId).push(ref.eventOrdinal);}
  const intent=normalizeAssistantSourceAcknowledgement({sourceId:source.id,sourceRevision:source.revision,
    receipts:[...receipts].map(([receiptId,eventOrdinals])=>({receiptId,eventOrdinals:eventOrdinals.sort((a,b)=>a-b)})),
    ...(verifyOnly?{verifyOnly:true}:{})});
  const runtimeArguments=email?['ack-reference','--uid',target.uid,'--uid-validity',target.uidValidity,'--expected-revision',target.revision,
    '--expected-original-sha256',target.originalSha256,verifyOnly?'--verify-only':'--confirm']
    :['ack-reference','--chat',target.chatId,'--message-id',target.messageId,'--expected-revision',target.revision,
    '--expected-conversation-key',target.conversationKey,...(verifyOnly?[]:covered.flatMap(ref=>['--covered-reference',`${ref.messageId}:${ref.revision}`])),
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
