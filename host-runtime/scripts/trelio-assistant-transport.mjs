/** Fixed assistant-device transport. No human OAuth/cookie or arbitrary HTTP. */
import path from 'node:path';
import { validateAssistantActivePass } from './trelio-assistant-hook.mjs';
import { buildRuntimeSessionProof, withRuntimeStateLock } from './trelio-runtime-session.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { ASSISTANT_CADENCES, assistantPassContinuation } from './trelio-assistant-scheduler.mjs';
import { assistantExecutionConfiguration } from './trelio-assistant-codex.mjs';
import { PROCESS_DIAGNOSTIC_CODES } from './trelio-process-diagnostics.mjs';

export class AssistantTransportError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new AssistantTransportError(code, status); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('ASSISTANT_TRANSPORT_INVALID_INPUT'); return value.toLowerCase(); };
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
export const validateAssistantPassOutcome = (value, expected) => {
  if(!object(value)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  if(value.state==='pending') {
    if(value.schemaVersion!==1 || Object.keys(value).sort().join(',')!=='schemaVersion,state') fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
    return {schemaVersion:1,state:'pending'};
  }
  const keys=['schemaVersion','state','receiptId','continuation',...Object.keys(expected)].sort();
  if(value.schemaVersion!==1 || value.state!=='confirmed' || Object.keys(value).sort().join(',')!==keys.join(',')
    || Object.keys(expected).some(key=>value[key]!==expected[key])) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  let continuation;try{continuation=assistantPassContinuation(value.continuation);}catch{fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');}
  return {schemaVersion:1,state:'confirmed',receiptId:id(value.receiptId),...expected,continuation};
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${origin}/api/digital-assistants${route[1]}`, {
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

/** Internal composition of native Workspace transport. Device credentials
 * are resolved from the existing private slot through a callback, never a
 * model-visible getter or a human-token fallback. */
export const createAssistantWorkspaceProfile = async ({identity,client,store,host,lockDirectory,
  lock=withRuntimeStateLock,now=Date.now}) => {
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
  await assertIdentity();
  // This opaque handle cannot reveal a credential through native metadata or
  // an accidental caller serialization. Only prepareRequest resolves auth.
  const handle=Object.freeze(Object.create(null));
  return Object.freeze({
    kind:'digital_assistant',
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
        || !pathname.startsWith(nativePrefix+'/') || typeof buildHeaders!=='function') fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      let url;try{url=new URL(pathname,identity.origin);}catch{fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');}
      if(url.origin!==identity.origin || url.hash || url.pathname!==pathname.split('?')[0]) fail('ASSISTANT_WORKSPACE_ORIGIN_DENIED');
      const method=String(options.method??'GET').toUpperCase();
      const rewritten=assistantPrefix+url.pathname.slice(nativePrefix.length);
      const route=assistantWorkspaceConcreteRequest(method,rewritten);
      return lock(path.join(lockDirectory,`${pass.passId}.json`),async()=>{
        await assertIdentity();
        const live=await client.readTaskPass(locator,options.signal);
        if(live.state!=='leased' || ['passId','threadId','deliveryId','bindingId','bindingRevision'].some(key=>live[key]!==pass[key])
          || !Number.isFinite(Date.parse(live.leaseExpiresAt)) || Date.parse(live.leaseExpiresAt)<=now()) fail('ASSISTANT_PASS_REVIEW_REQUIRED');
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
export const ASSISTANT_MCP_READ_TOOLS = Object.freeze(["get_assistant_status", "download_attachment", "get_task", "get_task_sections", "get_task_instruction_page", "prepare_assistant_workspace_read", "get_assistant_owner_question", "search_agent_guidance", "get_agent_skill", "get_agent_procedure"]);
// Names only: the backend supplies current schemas and exact task/action
// authority. No human assertion, owner decision or company role is synthesized.
export const ASSISTANT_MCP_TOOLS = Object.freeze([...ASSISTANT_MCP_READ_TOOLS,
  'ask_assistant_owner', 'request_assistant_action', 'complete_assistant_pass', 'prepare_assistant_workspace_run', 'continue_assistant_workspace_action',
  "update_task_due_date", "update_task_assignee", "set_task_participants", "update_task_custom_field",
  "create_comment", "update_comment", "update_task_title", "update_task_description", "update_task_urgency", "update_task_status",
  "create_task_control", "update_task_control", "clear_task_control", "create_checklist", "update_checklist",
  "complete_checklist_item", "create_subtask", "create_task_relation", "delete_task_relation", "delete_checklist", "delete_attachment",
]);
/** Hook-owned admission fields never belong to the model's tool arguments.
 * Keep the live backend validators as the wire authority, while removing only
 * those two root fields from model discovery. PreToolUse still injects them
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
    for(const key of ['taskPass','runtimeSessionProof']){
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
const sourceCursor = (value,skillId) => typeof value==='string' && value.length<=16_384
  && (skillId==='telegram-mtproto' ? /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u : /^[A-Za-z0-9_-]+$/u).test(value);
const sourceScope = input => {
  if(!object(input) || Object.keys(input).some(key=>!['companyId','projectId','skillId'].includes(key))
    || !Object.hasOwn(SOURCE_PROTOCOLS,input.skillId)) fail('ASSISTANT_SOURCE_INVALID_INPUT');
  return Object.freeze({companyId:id(input.companyId),projectId:input.projectId==null?null:id(input.projectId),skillId:input.skillId});
};

/** One poll's transport profile for the common package loader. It has no task
 * pass/model observation, human vault or renewal cache. The server rechecks the
 * live device, MCP grant, scope, assignment, current release and package on each
 * fixed endpoint. A local format header and a callback are not authorization. */
export const createAssistantSourceRuntimeProfile = async ({identity,host,store,scope,
  monotonic=()=>performance.now(),startedAt=monotonic()}) => {
  scope=sourceScope(scope);
  const origin=originOf(identity?.origin),assistantId=id(identity?.assistantId),deviceId=id(identity?.deviceId);
  if(!host || typeof host.readIdentity!=='function' || !store || typeof store.get!=='function'
    || typeof monotonic!=='function' || !Number.isFinite(startedAt)) fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const expected={schemaVersion:1,origin,assistantId,deviceId};
  let active=true,resolveSent=false,packageSent=false,packagePath=null,budgetMs=120_000;
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
    async requireToken(requestOrigin){
      if(requestOrigin!==origin)fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
      await assertCurrent();return handle;
    },
    async prepareRequest({origin:requestOrigin,token,pathname,options,buildHeaders}){
      if(requestOrigin!==origin || token!==handle || typeof pathname!=='string' || typeof buildHeaders!=='function') fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
      const method=String(options.method??'GET').toUpperCase();
      if(pathname===`${ASSISTANT_SOURCE_PREFIX}/resolve` && method==='POST' && !resolveSent){
        let body;try{body=JSON.parse(options.body);}catch{fail('ASSISTANT_SOURCE_ORIGIN_DENIED');}
        if(!object(body) || JSON.stringify(body)!==JSON.stringify({...scope,expectedReleaseId:null})) fail('ASSISTANT_SOURCE_ORIGIN_DENIED');
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
        || admission.provider!==protocol.provider || admission.protocol!==protocol.protocol || admission.command!=='monitor'
        || admission.pollIntervalSeconds!==300 || admission.maximumDurationMs!==60_000
        || typeof admission.issuedAt!=='string' || typeof admission.expiresAt!=='string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(admission.issuedAt)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(admission.expiresAt)
        || !Number.isFinite(issued) || !Number.isFinite(expires) || expires-issued!==120_000
        || resolution.localIdentity?.companyId!==scope.companyId || resolution.localIdentity?.projectId!==scope.projectId
        || resolution.artifact.skillId!==scope.skillId || resolution.artifact.contentProtection!=='plain'
        || resolution.trust.level!=='platform_verified' || resolution.trust.artifactLevel!=='platform_verified'
        || resolution.trust.requiresDeviceConsent || resolution.companyConnection?.secretBindings.length
        || resolution.companyConnection && !resolution.companyConnection.configured) fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      const url=new URL(resolution.packageUrl,origin);
      const query={companyId:scope.companyId,...(scope.projectId?{projectId:scope.projectId}:{}),skillId:scope.skillId,
        expectedReleaseId:resolution.releaseId,artifactId:resolution.artifact.id};
      if(url.origin!==origin || url.pathname!==`${ASSISTANT_SOURCE_PREFIX}/package` || url.hash
        || [...url.searchParams.keys()].length!==Object.keys(query).length
        || Object.entries(query).some(([key,value])=>url.searchParams.get(key)!==value)) fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
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
export const projectAssistantMonitorPage = (result,{skillId,cursor=null,chat=null}) => {
  const invalid=()=>fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
  if(!object(result) || !Number.isSafeInteger(result.exitCode) || typeof result.stdout!=='string'
    || Buffer.byteLength(result.stdout,'utf8')>1024*1024 || !Object.hasOwn(SOURCE_PROTOCOLS,skillId))invalid();
  let raw;try{raw=JSON.parse(result.stdout);}catch{invalid();}
  if(!object(raw))invalid();
  if(result.exitCode!==0){
    const prefix={ 'telegram-mtproto':'TELEGRAM','email-imap-smtp':'EMAIL','max-web':'MAX' }[skillId];
    const suffixes=['INVALID_CURSOR','SCOPE_CHANGED','UIDVALIDITY_CHANGED','GAP','INVALID_RESPONSE','REFERENCE_UNAVAILABLE','UNAVAILABLE'];
    const allowed=suffixes.map(suffix=>`${prefix}_MONITOR_${suffix}`);
    fail(allowed.includes(raw.code)?raw.code:'ASSISTANT_SOURCE_PROVIDER_UNAVAILABLE');
  }
  const ref=value=>typeof value==='string' && value.length>0 && value.length<=512 && !/[\x00-\x20\x7f]/u.test(value);
  const digest=value=>typeof value==='string' && /^[a-f0-9]{64}$/u.test(value);
  const positive=value=>typeof value==='string' && /^[1-9]\d{0,18}$/u.test(value);
  const peer=value=>typeof value==='string' && /^-?[1-9]\d{0,18}$/u.test(value);
  const cursorRef=value=>sourceCursor(value,skillId);
  if(raw.schemaVersion!==1 || typeof raw.baselineOnly!=='boolean' || raw.baselineOnly!==(cursor===null)
    || !Array.isArray(raw.events) || raw.events.length>100 || raw.baselineOnly && raw.events.length
    || typeof raw.hasMore!=='boolean' || !cursorRef(raw.nextCursor)
    || raw.coverage?.historicalBackfill!==false || raw.readState?.readReceiptsSent!==false)invalid();
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
      return {id:row.id,revision:row.revision,kind:row.kind,uid:row.uid,uidValidity:row.uidValidity};
    }
    if(!ref(row.chatId) || !ref(row.messageId))invalid();
    const event={id:row.id,revision:row.revision,kind:row.kind,chatId:row.chatId,messageId:row.messageId};
    if(skillId==='telegram-mtproto'){
      if(!peer(row.chatId) || !positive(row.messageId) || row.id!==`message:${row.chatId}:${row.messageId}`
        || chat!==null && row.chatId!==chat)invalid();
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
  const page={schemaVersion:1,baselineOnly:raw.baselineOnly,events,nextCursor:raw.nextCursor,hasMore:raw.hasMore};
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
export const readAssistantSourceMonitor = async ({identity,host,store,source,signal}) => {
  if(!object(source) || Object.keys(source).some(key=>!['companyId','projectId','skillId','accountId','chat','folder','cursor'].includes(key)))fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const scope=sourceScope({companyId:source.companyId,projectId:source.projectId,skillId:source.skillId});
  const accountId=id(source.accountId),cursor=source.cursor??null,chat=source.chat??null,folder=source.folder??null;
  if(cursor!==null && !sourceCursor(cursor,scope.skillId)
    || scope.skillId==='telegram-mtproto' && (folder!==null || chat!==null && !/^-?[1-9]\d{0,18}$/u.test(chat))
    || scope.skillId==='max-web' && (folder!==null || typeof chat!=='string' || !/^https:\/\/web\.max\.ru\/[A-Za-z0-9_-]{1,128}$/u.test(chat))
    || scope.skillId==='email-imap-smtp' && (chat!==null || folder!==null && (typeof folder!=='string' || !folder.length || folder.length>256 || /[\x00-\x1f\x7f]/u.test(folder))))fail('ASSISTANT_SOURCE_INVALID_INPUT');
  const startedAt=performance.now(),controller=new AbortController();
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),120_000);
  let profile;
  try{
    // Import the existing engine lazily: discovery/pairing never initializes
    // the human vault, account catalogue or package cache just by importing us.
    const engine=await import('./trelio-workspace.mjs');
    profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope,startedAt});
    return await engine.withWorkspaceExecutionProfile(profile,async()=>{
      if(combined.aborted)fail('ASSISTANT_SOURCE_DEADLINE');
      const token=await profile.requireToken(identity.origin);
      const response=await engine.request(identity.origin,token,`${ASSISTANT_SOURCE_PREFIX}/resolve`,{
        method:'POST',body:JSON.stringify({...scope,expectedReleaseId:null}),
        headers:{'content-type':'application/json'},signal:combined,maximumErrorResponseBytes:16_384});
      const bytes=await engine.readBoundedResponseBuffer(response,512*1024,'Source resolution');
      let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
      const resolution=engine.normalizeResolvedSkillRuntimeArtifact(raw,{transportProfile:'assistant_source'});
      await profile.bindResolution(resolution,raw.sourceAdmission);raw=null;
      const materialized=await engine.materializeResolvedAgentSkillRuntime({origin:identity.origin,token,resolution,
        requestOptions:{signal:combined,maximumErrorResponseBytes:16_384}});
      await profile.remainingMs();
      const capabilities=materialized.artifact.parsedPackage.capabilities;
      if(!['network','local-session','local-accounts-v1'].every(value=>capabilities.includes(value))
        || capabilities.includes('secret-checkout'))fail('ASSISTANT_SOURCE_INVALID_RESPONSE');
      const executionContext={...scope,releaseId:resolution.releaseId,localIdentity:resolution.localIdentity,
        companyConnection:resolution.companyConnection};
      const args=['monitor','--local-account',accountId,...(chat===null?[]:['--chat',chat]),
        ...(folder===null?[]:['--folder',folder]),...(cursor===null?[]:['--cursor',cursor]),'--limit','100'];
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
      return projectAssistantMonitorPage(result,{skillId:scope.skillId,cursor,chat});
    });
  }catch(error){
    if(error instanceof AssistantTransportError)throw error;
    // Only closed backend/process codes survive. Never attach cause/raw JSON,
    // private account/config, argv, provider stderr or cache paths to a failure.
    const code=error?.code;
    const backendCodes=['ASSISTANT_SOURCE_AUTH_REQUIRED','ASSISTANT_SOURCE_ACCESS_DENIED','ASSISTANT_SOURCE_SCOPE_UNAVAILABLE',
      'ASSISTANT_SOURCE_INPUT_INVALID','ASSISTANT_SOURCE_PROTOCOL_REQUIRED','ASSISTANT_SOURCE_PROTOCOL_UNAVAILABLE',
      'ASSISTANT_SOURCE_SETUP_REQUIRED','ASSISTANT_SOURCE_ENCRYPTED_UNAVAILABLE','ASSISTANT_SOURCE_SKILL_UNAVAILABLE',
      'ASSISTANT_SOURCE_UNAVAILABLE','ASSISTANT_ACCESS_DENIED','ASSISTANT_COMPANY_REMOVED','ASSISTANT_DEVICE_REQUIRED',
      'ASSISTANT_DEVICE_REVOKED','ASSISTANT_STATE_CHANGED','ASSISTANT_RUNTIME_ADMISSION_DENIED',
      'AGENT_SKILL_RELEASE_CHANGED','AGENT_SKILL_RUNTIME_REVOKED','AGENT_SKILL_RUNTIME_HOST_UPGRADE_REQUIRED',
      'AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED','AGENT_WORKSPACE_HOST_RUNTIME_UPGRADE_REQUIRED'];
    if(backendCodes.includes(code) || PROCESS_DIAGNOSTIC_CODES.includes(code))fail(code);
    if(['ACCOUNT_NOT_FOUND','ACCOUNT_NOT_BOUND','ACCOUNT_SETUP_REQUIRED','ACCOUNT_SELECTION_REQUIRED'].includes(code))fail('ASSISTANT_SOURCE_ACCOUNT_REQUIRED');
    fail(combined.aborted?'ASSISTANT_SOURCE_DEADLINE':'ASSISTANT_SOURCE_UNAVAILABLE');
  }finally{clearTimeout(timer);profile?.close();}
};
