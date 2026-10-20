/** Fixed assistant-device transport. No human OAuth/cookie or arbitrary HTTP. */
import { createHash, randomBytes } from 'node:crypto';
import { ASSISTANT_CADENCES } from './trelio-assistant-scheduler.mjs';

export class AssistantTransportError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new AssistantTransportError(code, status); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('ASSISTANT_TRANSPORT_INVALID_INPUT'); return value.toLowerCase(); };
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const revision = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE'); return value;
};
const text = (value, limit = 2048) => {
  if (typeof value !== 'string' || !value.length || value.length > limit || /[\x00-\x20\x7f]/u.test(value)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE'); return value;
};
const state = value => {
  if (!['accepted','waiting_owner','paused','done','revoked'].includes(value)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE'); return value;
};
const binding = value => {
  if (!object(value)) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  return { id: id(value.id), taskId: id(value.taskId), state: state(value.state), revision: revision(value.revision) };
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
    ['heartbeat',['POST','/runtime/heartbeat']], ['companies',['GET','/runtime/companies']],
    ['tasks',['POST','/runtime/tasks']], ['task',['POST','/runtime/task']],
    ['claim',['POST','/runtime/task/claim']],
    ['poll',['POST','/runtime/notifications/poll']], ['ack',['POST','/runtime/notifications/ack']],
    ['report',['POST','/runtime/schedule']],
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

/** Host-private client. Model tools receive only projections from these named
 * operations; no method returns the credential or delegates an arbitrary URL. */
export const createAssistantDeviceClient = ({ origin, assistantId, deviceId, store, http }) => {
  origin = originOf(origin); assistantId = id(assistantId); deviceId = id(deviceId);
  if (!store || typeof store.get !== 'function' || typeof http !== 'function') fail('ASSISTANT_TRANSPORT_INVALID_INPUT');
  const call = async (operation, body, signal) => {
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
    return http(operation, body, secret.credential, signal);
  };
  return {
    identity: Object.freeze({ origin, assistantId, deviceId }),
    async heartbeat(signal) {
      const value = await call('heartbeat', {}, signal);
      if (value.assistantUserId !== assistantId || value.deviceId !== deviceId) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return { assistantId, deviceId };
    },
    async companies(signal) {
      const value = await call('companies', undefined, signal);
      if (value.assistantUserId !== assistantId || value.bindingId !== deviceId || !Array.isArray(value.companies) || value.companies.length > 256) fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return value.companies.map(company => ({ companyId: id(company.id), memberId: id(company.memberId),
        encryptionState: company.encryptionState === null ? null : text(company.encryptionState, 64) }));
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
      return {...result,hostState:value.hostState};
    },
    async poll(companyId, cursor = null, signal) {
      companyId = id(companyId); if (cursor !== null) text(cursor);
      const value = await call('poll', { companyId, cursor }, signal);
      if (!Array.isArray(value.events) || value.events.length > 100 || typeof value.hasMore !== 'boolean') fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
      return { events: value.events.map(event => {
        if (typeof event.wake !== 'boolean') fail('ASSISTANT_TRANSPORT_INVALID_RESPONSE');
        return { id: id(event.id), revision: text(event.revision,128), taskId: id(event.taskId), wake: event.wake,
          bindingId: id(event.bindingId), bindingRevision: revision(event.bindingRevision), taskState: state(event.taskState) };
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
