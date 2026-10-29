/**
 * Continuation for a caller-owned Playwright process. Codex terminal stdin is
 * tied to the terminal's original filesystem policy; it cannot be a durable
 * browser protocol across turns. This channel never attaches to old terminals
 * and never executes source in the trusted host: the caller owns its handler.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readBrowserSessionBinding } from './trelio-browser-session.mjs';
import { resolveWorkspaceBridgeConfigDirectory, readPrivateJsonFile, writePrivateJsonFile, assertPrivatePathKind } from './trelio-workspace.mjs';
import { prepareVisualPrivateDirectory } from './trelio-visual-bootstrap.mjs';
import { withVisualOwnerFileLock, readVisualOwner, publishVisualWorkerOwner } from './trelio-visual-session.mjs';
import { buildLocalTaskReadToolResult, fitsMcpTaskReadResult } from './trelio-task-read-budget.mjs';

export { browserControllerEnabled, parseBrowserControllerArguments } from './trelio-browser-controller-policy.mjs';
export const BROWSER_CONTROLLER_API_VERSION = 1;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hex = /^[0-9a-f]{64}$/u;
const MAX_INPUT = 65_536, MAX_RESULT = 8192, MAX_REQUESTS = 128;
const validUuid = value => typeof value === 'string' && uuid.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedJson = (value, maximum) => {
  let text;
  try { text = JSON.stringify(value); } catch { fail('BROWSER_CONTROLLER_RESULT_INVALID'); }
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximum) fail('BROWSER_CONTROLLER_RESULT_INVALID');
  return JSON.parse(text);
};
// Measure the SAME final skill_run stdout/text envelope, including escaping.
// A byte cap alone cannot prevent client truncation of quote-heavy JSON.
const fitsDelivery = value => fitsMcpTaskReadResult(buildLocalTaskReadToolResult({
  schemaVersion: 1, operation: 'skill_run', stdout: `${JSON.stringify(value)}\n`,
}));
const deliverable = value => {
  if (!fitsDelivery(value)) fail('BROWSER_CONTROLLER_RESULT_INVALID');
  return value;
};
const privateFailure = error => {
  if (/^BROWSER_CONTROLLER_[A-Z_]+$/u.test(error?.code || '')) throw error;
  fail('BROWSER_CONTROLLER_STORAGE_UNSAFE');
};

export function browserControllerBinding(env = process.env) {
  let account;
  try { account = JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON || 'null'); } catch { fail('BROWSER_CONTROLLER_BINDING_REQUIRED'); }
  let origin;
  try { origin = new URL(env.TRELIO_BROWSER_CONTROLLER_ORIGIN).origin; }
  catch { fail('BROWSER_CONTROLLER_BINDING_REQUIRED'); }
  if (origin !== env.TRELIO_BROWSER_CONTROLLER_ORIGIN) fail('BROWSER_CONTROLLER_BINDING_REQUIRED');
  const binding = {
    origin,
    companyId: env.TRELIO_SKILL_COMPANY_ID, memberId: env.TRELIO_SKILL_MEMBER_ID,
    projectId: env.TRELIO_SKILL_PROJECT_ID || null, skillId: env.TRELIO_SKILL_ID,
    releaseId: env.TRELIO_SKILL_RELEASE_ID, runtimeSessionId: env.TRELIO_SKILL_RUNTIME_SESSION_ID || null,
    accountId: account?.id ?? null, companyBinding: account?.companyBinding ?? null,
  };
  if (env.TRELIO_BROWSER_CONTROLLER_ENABLED !== '1' || !/^[a-z][a-z0-9-]{0,79}$/u.test(binding.skillId || '')
    || ![binding.companyId, binding.memberId, binding.releaseId].every(value => validUuid(value))
    || binding.runtimeSessionId !== null && !validUuid(binding.runtimeSessionId)
    || binding.projectId !== null && !validUuid(binding.projectId)
    || binding.accountId !== null && (!validUuid(binding.accountId) || !hex.test(binding.companyBinding || '')))
    fail('BROWSER_CONTROLLER_BINDING_REQUIRED');
  return binding;
}

const ownerPath = (binding, sessionId, configHome) => {
  if (!validUuid(sessionId)) fail('BROWSER_CONTROLLER_ARGUMENTS_INVALID');
  return path.join(configHome, 'browser-controllers', digest(binding), sessionId, 'active', 'owner.json');
};
async function assertAncestors(file) {
  // readPrivateJsonFile verifies the final inode/DACL. Inspect every ancestor
  // as well, before the owner mutex creates anything; never harden a redirect.
  for (let cursor = path.dirname(file);;) {
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('BROWSER_CONTROLLER_STORAGE_UNSAFE');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function validateOwner(owner) {
  if (!exact(owner, ['schemaVersion', 'sessionId', 'binding', 'deadlineAt', 'token', ...(Object.hasOwn(owner || {}, 'port') ? ['pid', 'port'] : [])])
    || owner.schemaVersion !== 1 || !validUuid(owner.sessionId) || (typeof owner.token !== 'string' || !hex.test(owner.token))
    || !Number.isSafeInteger(owner.deadlineAt) || owner.deadlineAt <= Date.now()
    || Object.hasOwn(owner, 'port') && (!Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)) fail('BROWSER_CONTROLLER_SESSION_UNAVAILABLE');
  return owner;
}

/** Called by the admitted signed provider's `client`, before any browser/login.
 * Only structural identity and the local random transport bearer reach disk;
 * commands, results, auth state and site content stay in caller RAM. */
export async function prepareBrowserController({ environment = process.env } = {}) {
  const binding = browserControllerBinding(environment);
  const lease = readBrowserSessionBinding({ environment });
  const sessionId = crypto.randomUUID();
  const file = ownerPath(binding, sessionId, resolveWorkspaceBridgeConfigDirectory({ environment }));
  const owner = { schemaVersion: 1, sessionId, binding, deadlineAt: lease.deadlineAt, token: crypto.randomBytes(32).toString('hex') };
  try {
    await prepareVisualPrivateDirectory(path.dirname(file));
    await withVisualOwnerFileLock(file, () => writePrivateJsonFile(file, owner));
  } catch (error) { privateFailure(error); }
  // Deliberately no port/token in this public bootstrap descriptor.
  return { apiVersion: 1, sessionId, ownerFile: file, deadlineAt: owner.deadlineAt, moduleUrl: import.meta.url };
}

/** One caller claims an unused descriptor once. There is no reconnect/adoption
 * path: a dead/unknown worker never becomes a fresh browser or login attempt. */
export async function openBrowserController(descriptor, options = {}) {
  if (!options || typeof options.onClose !== 'function') fail('BROWSER_CONTROLLER_DESCRIPTOR_INVALID');
  let attemptedCleanup = false;
  const onClose = async () => {
    if (attemptedCleanup || typeof options.onClose !== 'function') return;
    attemptedCleanup = true;
    return options.onClose();
  };
  try { return await openController(descriptor, { handle: options.handle, onClose }); }
  catch (error) {
    // The caller may already have prepared its ephemeral browser before claim.
    // Even an early descriptor/ACL refusal must attempt its owned cleanup once,
    // without a second call after the internal startup cleanup already ran.
    let timer;
    try { await Promise.race([onClose(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), 5000); })]); }
    catch {}
    finally { clearTimeout(timer); }
    privateFailure(error);
  }
}

async function openController(descriptor, { handle, onClose }) {
  if (!exact(descriptor, ['apiVersion', 'sessionId', 'ownerFile', 'deadlineAt', 'moduleUrl'])
    || descriptor.apiVersion !== 1 || descriptor.moduleUrl !== import.meta.url
    || !path.isAbsolute(descriptor.ownerFile || '') || typeof handle !== 'function' || typeof onClose !== 'function')
    fail('BROWSER_CONTROLLER_DESCRIPTOR_INVALID');
  const file = descriptor.ownerFile;
  let original;
  try { await assertAncestors(file); original = validateOwner(await readVisualOwner(file)); }
  catch (error) { privateFailure(error); }
  if (Object.hasOwn(original, 'port') || original.sessionId !== descriptor.sessionId || original.deadlineAt !== descriptor.deadlineAt
    || ownerPath(original.binding, original.sessionId, path.resolve(file, '../../../../..')) !== file)
    fail('BROWSER_CONTROLLER_DESCRIPTOR_INVALID');
  const monotonicDeadline = performance.now() + original.deadlineAt - Date.now();
  const alive = () => !stopping && Date.now() < original.deadlineAt && performance.now() < monotonicDeadline;
  const attempts = new Map(), events = [];
  let queue = Promise.resolve(), stopping = false, sequence = 0, eventBytes = 0, eventOverflow = false;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const publish = value => {
    if (!alive()) return false;
    // Reporting must not reject an otherwise verified auth promise. Retain an
    // explicit observation gap rather than crash the caller or rewrite proof.
    let event;
    try { event = boundedJson(value, 4096); } catch { eventOverflow = true; return false; }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (events.length >= 64 || eventBytes + bytes > 262_144) { eventOverflow = true; return false; }
    events.push({ sequence: ++sequence, value: event }); eventBytes += bytes;
    return true;
  };
  const snapshot = since => {
    const result = { state: 'ready', deadlineAt: original.deadlineAt, events: [], eventOverflow, sequence, nextSequence: since };
    for (const event of events) {
      if (event.sequence <= since) continue;
      const candidate = { ...result, events: [...result.events, event], nextSequence: event.sequence };
      if (!fitsDelivery(candidate)) break;
      result.events.push(event); result.nextSequence = event.sequence;
    }
    return result;
  };
  const server = http.createServer();
  let timer;
  const close = async (preserveResponse = false) => {
    if (stopping) return closed;
    stopping = true; clearTimeout(timer);
    // Stop input first, then attempt ALL caller-owned cleanup through its one
    // callback. A hung handler does not block expiry cleanup. No saved PID is
    // ever killed. Native credential guards retain their independent deadline.
    server.close();
    if (!preserveResponse) server.closeAllConnections();
    let cleanup = 'closed';
    let cleanupTimer;
    try {
      await Promise.race([Promise.resolve().then(onClose), new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error()), 5000);
      })]);
    } catch { cleanup = 'cleanup_unconfirmed'; }
    finally {
      clearTimeout(cleanupTimer); attempts.clear(); events.length = 0;
      // Remove only our exact transport record after stopping input. Never
      // recursively delete a profile/claim or touch a replaced owner's state.
      try {
        await withVisualOwnerFileLock(file, async () => {
          const current = await readPrivateJsonFile(file, { maximumBytes: 65_536 });
          if (current.token === original.token && current.pid === process.pid
            && current.sessionId === original.sessionId) await fs.unlink(file);
        });
      } catch { cleanup = 'cleanup_unconfirmed'; }
      resolveClosed({ state: cleanup });
    }
    return closed;
  };
  server.on('request', async (request, response) => {
    const reply = value => { const body = JSON.stringify(deliverable(value)); response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(body); };
    if (!alive() || request.method !== 'POST' || request.url !== '/command' || request.headers.host !== `127.0.0.1:${server.address()?.port}`
      || request.socket.remoteAddress !== '127.0.0.1' || request.headers.origin !== undefined
      || request.headers.authorization !== `Bearer ${original.token}` || request.headers['content-type'] !== 'application/json') {
      response.writeHead(403); response.end(); return;
    }
    let size = 0, chunks = [];
    try {
      for await (const chunk of request) { size += chunk.length; if (size > MAX_INPUT) throw new Error(); chunks.push(chunk); }
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!alive()) throw new Error();
      if (exact(input, ['operation', 'since']) && input.operation === 'status' && Number.isSafeInteger(input.since) && input.since >= 0) {
        reply(snapshot(input.since)); return;
      }
      if (exact(input, ['operation']) && input.operation === 'close') {
        const result = await close(true);
        response.once('finish', () => server.closeAllConnections());
        reply(result); return;
      }
      if (!validUuid(input.requestId)) throw new Error();
      if (exact(input, ['operation', 'requestId']) && input.operation === 'poll') {
        const attempt = attempts.get(input.requestId);
        reply(attempt ? { state: attempt.state, ...(attempt.state === 'completed' ? { result: attempt.result } : {}) } : { state: 'unknown_request' }); return;
      }
      if (!exact(input, ['operation', 'requestId', 'command']) || input.operation !== 'submit') throw new Error();
      const command = boundedJson(input.command, MAX_INPUT - 1024), hash = digest(command);
      const existing = attempts.get(input.requestId);
      if (existing) { reply({ state: existing.hash === hash ? existing.state : 'request_conflict' }); return; }
      if (attempts.size >= MAX_REQUESTS) { reply({ state: 'request_limit' }); return; }
      const attempt = { hash, state: 'queued' };
      // Reserve BEFORE enqueue/handler. Duplicate IDs (including a lost HTTP
      // response) observe the old attempt; they can never repeat site input.
      attempts.set(input.requestId, attempt);
      queue = queue.then(async () => {
        if (!alive()) { attempt.state = 'expired'; return; }
        attempt.state = 'running';
        try {
          attempt.result = boundedJson((await handle(command)) ?? null, MAX_RESULT);
          deliverable({ state: 'completed', result: attempt.result }); attempt.state = 'completed';
        }
        catch { attempt.state = 'outcome_unknown'; }
      });
      reply({ state: attempt.state });
    } catch { if (!response.headersSent) { response.writeHead(400); response.end(); } }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 8;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await publishVisualWorkerOwner(file, original, { pid: process.pid, port: server.address().port });
    timer = setTimeout(() => { void close(); }, Math.max(1, original.deadlineAt - Date.now()));
  } catch (error) { await close(); privateFailure(error); }
  return Object.freeze({ publish, close, closed });
}

/** Invoked only AFTER the ordinary signed skill/account/session admission.
 * Every short invocation rechecks its own identity; an owner file or caller
 * PID alone never supplies company/release/chat access. No HTTP retry occurs. */
export async function runBrowserControllerCommand({ environment, command }) {
  const binding = browserControllerBinding(environment);
  const file = ownerPath(binding, command.sessionId, resolveWorkspaceBridgeConfigDirectory({ environment }));
  let owner;
  try { await assertAncestors(file); owner = validateOwner(await readVisualOwner(file)); }
  catch (error) { privateFailure(error); }
  if (digest(owner.binding) !== digest(binding) || owner.sessionId !== command.sessionId) fail('BROWSER_CONTROLLER_SESSION_UNAVAILABLE');
  if (!owner.port) return { state: 'not_started', deadlineAt: owner.deadlineAt };
  // A positively dead caller cannot own its old port. Read-only PID probing
  // never authorizes adoption, process termination or a replacement login.
  try { process.kill(owner.pid, 0); } catch { fail('BROWSER_CONTROLLER_SESSION_UNAVAILABLE'); }
  let input = { operation: command.operation };
  if (command.operation === 'status') input.since = command.afterSequence || 0;
  if (command.operation === 'poll') input.requestId = command.requestId;
  if (command.operation === 'submit') {
    try {
      await assertAncestors(command.inputFile);
      await assertPrivatePathKind(command.inputFile, 'file');
      input = { ...input, requestId: command.requestId, command: await readPrivateJsonFile(command.inputFile, { maximumBytes: MAX_INPUT - 1024, fatalUtf8: true }) };
    } catch (error) { privateFailure(error); }
  }
  // The deadline is original, including controller preparation and caller
  // launch. New turns, a new cwd and polling never mint another lease.
  try {
    const response = await fetch(`http://127.0.0.1:${owner.port}/command`, {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(Math.max(1, Math.min(command.operation === 'close' ? 10_000 : 5000, owner.deadlineAt - Date.now()))),
    });
    if (response.status !== 200) throw new Error();
    let size = 0, chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 524_288) throw new Error(); chunks.push(chunk); }
    return deliverable(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
  } catch { fail('BROWSER_CONTROLLER_TRANSPORT_UNKNOWN'); }
}
