import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { runStandaloneVisualBrowser, runVisualSession, withVisualOwnerFileLock, readVisualOwner,
  publishVisualWorkerOwner, visualSessionBinding, createVisualIdleSupervisor,
  VISUAL_IDLE_TIMEOUT_MS, closeVisualExecutionSessions, assistantVisualBrowserAccountId,
  createVisualControlServer, observeAssistantManagedVisualTarget, prepareAssistantManagedVisualSecret } from '../host-runtime/scripts/trelio-visual-session.mjs';
import { browserExecutionDirectory } from '../host-runtime/scripts/trelio-browser-session.mjs';
import { visualStatus } from '../host-runtime/scripts/trelio-visual-result.mjs';
import { ProtectedVisualStore, visualStandaloneStorageScope, visualStorageScope } from '../host-runtime/scripts/trelio-visual-store.mjs';
import { loadVisualDependencies } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { resolveVisualWorkerNode } from '../host-runtime/scripts/trelio-visual-node.mjs';
import { PROCESS_DIAGNOSTIC_CODES, ProcessDiagnosticError, parseProcessDiagnostic,
  processDiagnosticCauseCode } from '../host-runtime/scripts/trelio-process-diagnostics.mjs';
import { readPrivateJsonFile, writePrivateJsonFile } from '../host-runtime/scripts/trelio-workspace.mjs';
import { ownFixtureHttpServer } from './fixtures/visual-owned-http.mjs';

test('exact text capture validates a canonical signed-origin HTTPS address before session or account I/O', async () => {
  const url = 'https://example.test/public/item';
  const env = new Proxy({}, { get() { throw Error('unexpected identity or storage access'); } });
  for (const [operation, args, observationMode] of [
    ['navigate', { url, expectedDocumentUrl: url + '/other' }, 'text'],
    ['read-text', { expectedDocumentUrl: 'https://elsewhere.test/public/item' }, 'text'],
    ['read-text', { expectedDocumentUrl: url + '?token=synthetic' }, 'text'],
    ['read-text', { expectedDocumentUrl: url + '#other' }, 'text'],
    ['read-text', { expectedDocumentUrl: url }, 'image'],
    ['read-text', { expectedDocumentUrl: url, query: 'ignore' }, 'text'],
    ['read-text', { expectedDocumentUrl: url, offset: -1 }, 'text'],
    ['click', { frameId: 'f', x: 0, y: 0, expectedDocumentUrl: url }, 'text'],
  ]) assert.equal((await runVisualSession({ origins: ['https://example.test'], operation, args, observationMode, env })).reason, 'invalid_input');
});

test('protected browser selection keeps the original assistant, device, company and observed execution', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-secret-owner-')));
  const identity = { origin: 'https://trelio.test', assistantId: randomUUID(), deviceId: randomUUID(), companyId: randomUUID() };
  const runtimeSessionId = randomUUID(), memberId = randomUUID(), handle = randomUUID(), token = 'a'.repeat(64);
  const sessionId = randomUUID(), frameId = randomUUID();
  const redirectOrigin = 'https://login.form.test';
  const redirectHash = createHash('sha256').update(redirectOrigin + '/account?fixture=1').digest('hex');
  const observedFrameSha256 = 'e'.repeat(64);
  const operations = [];
  const control = createVisualControlServer({ token, dispatch: async () => assert.fail('public dispatch'), secretDispatch(message) {
    operations.push(message.operation);
    if (message.operation === 'observe') {
      assert.deepEqual(message, { operation: 'observe', sessionId, frameId, expectedOrigin: redirectOrigin });
      return { state: 'observed', targetOrigin: redirectOrigin, targetUrlSha256: redirectHash, observedFrameSha256 };
    }
    if (message.operation === 'prepare') {
      if (message.observation) {
        assert.deepEqual(message.observation, { sessionId, frameId });
        assert.equal(Object.hasOwn(message, 'targetUrl'), false);
        assert.equal(message.context.targetUrlSha256, redirectHash);
        assert.equal(message.context.browserSteps[0].observedFrameSha256, observedFrameSha256);
      }
      return { state: 'ready', handle };
    }
    assert.equal(message.handle, handle);
    return message.operation === 'fill' ? { outcome: 'succeeded' } : { state: 'released' };
  } });
  const listener = ownFixtureHttpServer(control, t.signal);
  t.after(async () => { await listener.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  await listener.listen();
  const installOwner = async (origin, bound = true) => {
    const now = Date.now();
    const env = { TRELIO_ORIGIN: identity.origin, TRELIO_SKILL_ID: 'assistant-browser',
      TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: assistantVisualBrowserAccountId(identity, origin) }),
      TRELIO_SKILL_COMPANY_ID: identity.companyId, TRELIO_SKILL_MEMBER_ID: memberId,
      TRELIO_SKILL_RUNTIME_SESSION_ID: runtimeSessionId,
      TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({ apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 120000 }),
      TRELIO_BROWSER_SESSION_STARTED_AT: String(now), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(now + 120000) };
    const binding = visualSessionBinding(env);
    const active = path.join(browserExecutionDirectory(path.join(directory, 'visual-browser', binding.scope), env), 'active');
    await fs.mkdir(active, { recursive: true, mode: 0o700 });
    await writePrivateJsonFile(path.join(active, 'owner.json'), { schemaVersion: 1,
      token, pid: process.pid, scope: binding.scope, bindingHash: binding.bindingHash, port: control.address().port,
      deadlineAt: binding.deadlineAt, executionOwner: binding.executionOwner, origins: [origin], presentation: 'hidden',
      externalNavigation: true, assistantBrowserSecrets: bound,
      mailIdentity: { origin: identity.origin, companyId: identity.companyId, memberId } });
  };
  const targetOrigin = 'https://form.test', targetUrl = targetOrigin + '/login';
  const targetUrlSha256 = createHash('sha256').update(targetUrl).digest('hex');
  const input = { identity, runtimeSessionId, targetUrl, directory, context: {
    deliveryMode: 'browser', executable: 'trelio-workspace', fieldKeys: ['login'],
    targetOrigin, targetUrlSha256, browserSteps: [{ targetOrigin, targetUrlSha256,
      fields: [{ fieldKey: 'login', accessibleName: 'Account' }] }],
  } };
  assert.equal(await prepareAssistantManagedVisualSecret(input), null);
  await installOwner(targetOrigin, false);
  await assert.rejects(prepareAssistantManagedVisualSecret(input), { reasonCode: 'browser_unavailable' });
  assert.deepEqual(operations, [], 'an old owned worker must refuse before checkout');
  await installOwner(targetOrigin);
  assert.equal(await prepareAssistantManagedVisualSecret({ ...input, runtimeSessionId: randomUUID() }), null);
  for (const key of ['assistantId', 'deviceId', 'companyId'])
    assert.equal(await prepareAssistantManagedVisualSecret({ ...input, identity: { ...identity, [key]: randomUUID() } }), null);
  const selected = await prepareAssistantManagedVisualSecret(input);
  assert.deepEqual(await selected.fill({ secretValues: { login: 'test value' } }), { outcome: 'succeeded' });
  await assert.rejects(selected.fill({ secretValues: { login: 'test value' } }));
  await selected.close();
  assert.deepEqual(operations, ['prepare', 'fill', 'release']);
  await installOwner('https://other.form.test');
  await assert.rejects(prepareAssistantManagedVisualSecret(input), { reasonCode: 'browser_unavailable' });
  assert.deepEqual(operations, ['prepare', 'fill', 'release'], 'ambiguous ownership cannot try several browsers');

  const observation = { sessionId, frameId, siteOrigin: targetOrigin, targetOrigin: redirectOrigin };
  const lookup = { identity, runtimeSessionId, observation, directory };
  await assert.rejects(observeAssistantManagedVisualTarget({ ...lookup, runtimeSessionId: randomUUID() }),
    { reasonCode: 'browser_unavailable' });
  await assert.rejects(observeAssistantManagedVisualTarget({ ...lookup, observation: { ...observation, targetOrigin: redirectOrigin + '/path' } }),
    /VISUAL_IDENTITY_INVALID/u);
  const target = await observeAssistantManagedVisualTarget(lookup);
  assert.deepEqual(target, { targetOrigin: redirectOrigin, targetUrlSha256: redirectHash, observedFrameSha256 });
  await assert.rejects(prepareAssistantManagedVisualSecret({ ...lookup, context: input.context }),
    { reasonCode: 'target_origin_changed' });
  const context = { ...input.context, targetOrigin: target.targetOrigin, targetUrlSha256: target.targetUrlSha256,
    browserSteps: [{ ...input.context.browserSteps[0], ...target }] };
  const bound = await prepareAssistantManagedVisualSecret({ ...lookup, context });
  await bound.close();
  assert.deepEqual(operations, ['prepare', 'fill', 'release', 'observe', 'prepare', 'release']);
});

test('presentation validation precedes identity/storage and an old worker cannot silently become hidden', async t => {
  const unreadable = new Proxy({}, { get() { throw Error('identity must not be accessed'); } });
  for (const options of [{ profileAuthentication: 'true' }, { profileAuthentication: true, externalNavigation: false }]) {
    assert.equal((await runVisualSession({ origins: ['https://example.test'], operation: 'status',
      env: unreadable, ...options })).reason, 'invalid_input');
  }
  const fieldPolicy = { origins: ['https://example.test'], labels: ['Start date'] };
  const fieldCheck = { id: 'date', label: 'Start date', match: 'equals', values: ['2030-05-12'] };
  for (const change of [{ args: { checks: [fieldCheck] } }, { fieldCheckPolicy: fieldPolicy, args: { checks: [{ ...fieldCheck, label: 'Password' }] } },
    { fieldCheckPolicy: { ...fieldPolicy, origins: ['https://foreign.test'] }, args: {} }]) {
    assert.equal((await runVisualSession({ origins: ['https://example.test'], operation: 'read-text', observationMode: 'text', semanticControls: true,
      env: unreadable, ...change })).reason, 'invalid_input');
  }
  assert.equal((await runVisualSession({ origins: ['https://example.test'], operation: 'status', presentation: 'invalid', env: unreadable })).reason, 'invalid_input');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-presentation-')));
  const now = Date.now();
  const env = { TRELIO_ORIGIN: 'https://example.test', TRELIO_SKILL_ID: 'synthetic-presentation',
    TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: randomUUID() }), TRELIO_SKILL_COMPANY_ID: randomUUID(),
    TRELIO_SKILL_MEMBER_ID: randomUUID(), TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({
      apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 120000 }),
    TRELIO_BROWSER_SESSION_STARTED_AT: String(now), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(now + 120000) };
  let calls = 0;
  const server = http.createServer((_request, response) => { calls++; response.end(JSON.stringify(visualStatus('closed'))); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, binding = visualSessionBinding(env);
  const active = path.join(directory, 'visual-browser', binding.scope, 'active');
  await fs.mkdir(active, { recursive: true, mode: 0o700 });
  const file = path.join(active, 'owner.json');
  const legacy = { schemaVersion: 1, scope: binding.scope, bindingHash: binding.bindingHash,
    token: 'a'.repeat(64), pid: process.pid, port: server.address().port, deadlineAt: binding.deadlineAt };
  await writePrivateJsonFile(file, { ...legacy, externalNavigation: true, profileAuthentication: true });
  assert.equal((await runVisualSession({ origins: [origin], externalNavigation: true,
    operation: 'navigate', args: { url: origin }, env, fixture: { directory } })).reason, 'observation_mode_mismatch');
  await writePrivateJsonFile(file, legacy);
  const invoke = (operation, presentation) => runVisualSession({ origins: [origin], operation, presentation,
    args: operation === 'navigate' ? { url: origin } : {}, env, fixture: { directory } });
  assert.equal((await invoke('navigate', 'hidden')).reason, 'observation_mode_mismatch');
  assert.equal(calls, 0, 'mode mismatch must not dispatch any browser operation');
  assert.equal((await invoke('status', 'hidden')).state, 'closed', 'the original owner can still inspect/close safely');
  assert.equal((await invoke('navigate', 'windowed')).state, 'closed', 'omitted legacy presentation stays windowed');
  assert.equal((await runVisualSession({ origins: [origin], externalNavigation: true,
    operation: 'navigate', args: { url: origin }, env, fixture: { directory } })).reason, 'observation_mode_mismatch',
  'an explicit switch still cannot change a running legacy browser');
  await writePrivateJsonFile(file, { ...legacy, presentation: 'hidden' });
  assert.equal((await invoke('navigate', 'windowed')).reason, 'observation_mode_mismatch');
  assert.equal((await readVisualOwner(file)).deadlineAt, binding.deadlineAt, 'presentation never renews the original lease');
  const pinned = { ...legacy, presentation: 'hidden', observationMode: 'text', semanticControls: true,
    fieldCheckPolicy: { origins: [origin], labels: ['Start date'] } };
  await writePrivateJsonFile(file, pinned);
  const before = calls;
  const changed = await runVisualSession({ origins: [origin], operation: 'read-text', observationMode: 'text',
    presentation: 'hidden', semanticControls: true, fieldCheckPolicy: { origins: [origin], labels: ['End date'] },
    env, fixture: { directory } });
  assert.equal(changed.reason, 'observation_mode_mismatch'); assert.equal(calls, before);
  const completion = { success: [{ origin, pathPrefix: '/', selectors: ['#account'], blocked: ['#challenge'] }] };
  await writePrivateJsonFile(file, { ...legacy, manualCompletion: completion });
  const withCompletion = policy => runVisualSession({ origins: [origin], operation: 'navigate', args: { url: origin },
    manualCompletion: policy, env, fixture: { directory } });
  const dispatches = calls;
  assert.equal((await withCompletion(null)).reason, 'observation_mode_mismatch');
  assert.equal((await withCompletion({ success: [{ ...completion.success[0], selectors: ['#different'] }] })).reason, 'observation_mode_mismatch');
  assert.equal(calls, dispatches, 'changed completion evidence cannot control an old human window');
  assert.equal((await withCompletion(completion)).state, 'closed');
  assert.equal((await invoke('close', 'hidden')).state, 'closed', 'cleanup does not require widening the pinned policy');

});

test('idle closes once despite status polling, preserves in-flight work and rejects late input', async () => {
  let clock = 0, sequence = 0, closed = 0;
  const timers = new Map();
  const advance = ms => {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) {
      timers.delete(id); timer.callback();
    }
  };
  const idle = createVisualIdleSupervisor({ onIdle: () => { closed++; }, now: () => clock,
    schedule: (callback, ms) => { const id = ++sequence; timers.set(id, { callback, at: clock + ms }); return id; },
    cancel: id => timers.delete(id) });
  const passive = async () => visualStatus('manual_input_required');
  advance(VISUAL_IDLE_TIMEOUT_MS - 1);
  for (const operation of ['status', 'wait', 'credentials-status', 'heartbeat', 'not-a-command'])
    await idle.run(operation, {}, passive);
  await idle.run('click', { unexpectedField: true }, passive);
  advance(1); assert.equal(closed, 1, 'manual waiting and invalid inputs never renew idle');
  let ran = false;
  assert.equal((await idle.run('navigate', { url: 'https://example.test' }, () => { ran = true; })).reason, 'session_closed');
  assert.equal(ran, false, 'late navigation cannot revive or replay a closed worker');
  advance(VISUAL_IDLE_TIMEOUT_MS); assert.equal(closed, 1);
});

test('working commands reset only their own idle clock after completion; explicit stop cancels cleanup', async () => {
  let clock = 0, closed = 0, otherClosed = 0, sequence = 0;
  const timers = new Map();
  const options = { now: () => clock,
    schedule: (callback, ms) => { const id = ++sequence; timers.set(id, { callback, at: clock + ms }); return id; },
    cancel: id => timers.delete(id) };
  const advance = ms => { clock += ms; for (const [id, timer] of [...timers])
    if (timer.at <= clock) { timers.delete(id); timer.callback(); } };
  const own = createVisualIdleSupervisor({ ...options, onIdle: () => { closed++; } });
  const other = createVisualIdleSupervisor({ ...options, onIdle: () => { otherClosed++; } });
  let finish;
  const result = own.run('type-text', { frameId: 'synthetic', text: 'hello' },
    () => new Promise(resolve => { finish = resolve; }));
  advance(VISUAL_IDLE_TIMEOUT_MS * 2);
  assert.equal(closed, 0, 'bounded in-flight input is not interrupted by the idle clock');
  assert.equal(otherClosed, 1, 'activity never renews another owner');
  finish(visualStatus('ready')); await result;
  advance(VISUAL_IDLE_TIMEOUT_MS - 1); assert.equal(closed, 0);
  await own.run('screenshot', {}, async () => visualStatus('ready'));
  advance(VISUAL_IDLE_TIMEOUT_MS - 1); assert.equal(closed, 0);
  own.stop(); other.stop(); advance(VISUAL_IDLE_TIMEOUT_MS); assert.equal(closed, 0);
  assert.equal(timers.size, 0);
});

test('two chats on one visual account address different workers and close only their own session', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-two-chats-')));
  const start = Date.now(), hits = [[], []], servers = [];
  const attachmentDiagnostic = { stage: 'redirect', code: 'origin_not_allowed', originSha256: 'b'.repeat(64) };
  const base = { TRELIO_ORIGIN: 'https://example.test', TRELIO_SKILL_ID: 'synthetic-two-chats',
    TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: randomUUID() }), TRELIO_SKILL_COMPANY_ID: randomUUID(),
    TRELIO_SKILL_MEMBER_ID: randomUUID(), TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({
      apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 120000 }),
    TRELIO_BROWSER_SESSION_STARTED_AT: String(start), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(start + 120000) };
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const environments = [0, 1].map(() => ({ ...base, TRELIO_SKILL_RUNTIME_SESSION_ID: randomUUID() }));
  for (const [index, env] of environments.entries()) {
    const binding = visualSessionBinding(env);
    const server = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const { operation } = JSON.parse(Buffer.concat(chunks));
      hits[index].push(operation);
      response.end(JSON.stringify(operation === 'download-attachment'
        ? visualStatus('error', 'navigation_blocked', { attachmentDiagnostic })
        : visualStatus('closed')));
    });
    servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const active = path.join(browserExecutionDirectory(path.join(directory, 'visual-browser', binding.scope), env), 'active');
    await fs.mkdir(active, { recursive: true, mode: 0o700 });
    await writePrivateJsonFile(path.join(active, 'owner.json'), { schemaVersion: 1, scope: binding.scope,
      bindingHash: binding.bindingHash, token: 'a'.repeat(64), pid: process.pid,
      executionOwner:binding.executionOwner,mailIdentity:{companyId:binding.companyId},
      port: server.address().port, deadlineAt: binding.deadlineAt, attachmentDownloads: true });
  }
  const call = (index, operation) => runVisualSession({ origins: [`http://127.0.0.1:${servers[0].address().port}`], operation,
    env: environments[index], fixture: { directory } });
  assert.equal((await call(0, 'close')).state, 'closed');
  assert.deepEqual(hits, [['close'], []]);
  assert.equal((await call(1, 'status')).state, 'closed');
  assert.deepEqual(hits, [['close'], ['status']]);
  const snapshot=path.join(directory,'visual-browser',visualSessionBinding(environments[0]).scope,'state.enc');
  await fs.writeFile(snapshot,'SYNTHETIC_ENCRYPTED_AUTH',{mode:0o600});
  await closeVisualExecutionSessions({companyId:base.TRELIO_SKILL_COMPANY_ID,runtimeSessionId:environments[0].TRELIO_SKILL_RUNTIME_SESSION_ID,directory});
  assert.deepEqual(hits,[['close','close'],['status']],'native settlement closes only its observed execution owner');
  assert.equal(await fs.readFile(snapshot,'utf8'),'SYNTHETIC_ENCRYPTED_AUTH','cleanup never disconnects the saved account');
  const download = diagnostics => runVisualSession({
    origins: [`http://127.0.0.1:${servers[1].address().port}`],
    operation: 'download-attachment', args: { frameId: randomUUID(), x: 20, y: 20 },
    attachmentDownloads: true, fixture: { directory },
    env: { ...environments[1], ...(diagnostics ? { TRELIO_SKILL_VISUAL_ATTACHMENT_DIAGNOSTICS: '1' } : {}) },
  });
  assert.deepEqual((await download(false)).attachmentDiagnostic, { stage: 'redirect' });
  assert.deepEqual((await download(true)).attachmentDiagnostic, attachmentDiagnostic);
  assert.deepEqual(hits, [['close', 'close'], ['status', 'download-attachment', 'download-attachment']]);
});

test('the visual session transports a transient CSV only for the original inline download', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-inline-session-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const start = Date.now(), token = 'b'.repeat(64), sessionId = randomUUID();
  const env = { TRELIO_ORIGIN: 'https://example.test', TRELIO_SKILL_ID: 'synthetic-sheet',
    TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: randomUUID() }), TRELIO_SKILL_COMPANY_ID: randomUUID(),
    TRELIO_SKILL_MEMBER_ID: randomUUID(), TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({
      apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 120000 }),
    TRELIO_BROWSER_SESSION_STARTED_AT: String(start), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(start + 120000) };
  const reply = { kind: 'trelio.browser-inline-text/v1', state: 'ready', reason: 'none', sessionId,
    mimeType: 'text/csv', text: 'sku,stock\n001,30' };
  const server = createVisualControlServer({ token, dispatch: async () => reply });
  const port = (await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())))).port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const binding = visualSessionBinding(env);
  const active = path.join(directory, 'visual-browser', binding.scope, 'active');
  await fs.mkdir(active, { recursive: true, mode: 0o700 });
  await writePrivateJsonFile(path.join(active, 'owner.json'), { schemaVersion: 1, scope: binding.scope,
    bindingHash: binding.bindingHash, token, pid: process.pid, port, deadlineAt: binding.deadlineAt, attachmentDownloads: true });
  const read = extra => runVisualSession({ origins: [`http://127.0.0.1:${port}`], operation: 'download-attachment',
    args: { frameId: randomUUID(), x: 3, y: 5, ...extra }, env, attachmentDownloads: true, fixture: { directory } });
  assert.deepEqual(await read({ inlineMimeType: 'text/csv' }), reply);
  const refused = await read({});
  assert.equal(refused.state, 'error');
  assert.doesNotMatch(JSON.stringify(refused), /sku|inline-text/);
});

test('an unsafe owner mutex root refuses before its operation without replacing the existing entry', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-owner-unsafe-test-')));
  const file = path.join(directory, 'active', 'owner.json'), root = path.join(directory, 'owner-control');
  let entered = false;
  try {
    await fs.writeFile(root, 'synthetic existing entry', { mode: 0o600 });
    await assert.rejects(withVisualOwnerFileLock(file, () => { entered = true; }), /VISUAL_STORAGE_UNSAFE/);
    assert.equal(entered, false);
    assert.equal(await fs.readFile(root, 'utf8'), 'synthetic existing entry');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('owner publication waits for the original reader, rechecks the claim and never changes its lease', { timeout: 60000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-owner-mutex-test-')));
  const active = path.join(directory, 'active'), file = path.join(active, 'owner.json');
  await fs.mkdir(active, { mode: 0o700 });
  const owner = { schemaVersion: 1, token: 'a'.repeat(64), bindingHash: 'b'.repeat(64),
    scope: 'c'.repeat(64), pid: process.pid, deadlineAt: Date.now() + 120000 };
  let releaseReader, signalReader, rejectReader, reader;
  const held = new Promise(resolve => { releaseReader = resolve; });
  const opened = new Promise((resolve, reject) => { signalReader = resolve; rejectReader = reject; });
  let reading, publishing;
  try {
    await withVisualOwnerFileLock(file, () => writePrivateJsonFile(file, owner));
    await assert.rejects(publishVisualWorkerOwner(file, owner, { pid: process.pid, port: 12345,
      deadlineAt: Date.now() + 240000 }), /VISUAL_IDENTITY_INVALID/);
    assert.deepEqual(await readVisualOwner(file), owner, 'publication cannot accept a lease override');
    reading = withVisualOwnerFileLock(file, async () => {
      reader = await fs.open(file, 'r');
      signalReader();
      try {
        await held;
        assert.deepEqual(JSON.parse(await reader.readFile('utf8')), owner);
      } finally { await reader.close(); reader = null; }
    });
    // Fail the original test normally if native preparation fails before the
    // handoff; do not leave a never-resolved startup barrier/owned directory.
    reading.catch(rejectReader);
    await opened;
    // A suspended/slow LIVE reader must not be evicted by an age-based stale
    // lock timeout. Reuse the existing PID/nonce mutex's native guarantee.
    const old = new Date(0);
    await fs.utimes(path.join(directory, 'owner-control', 'retention.lock'), old, old);
    let settled = false;
    publishing = publishVisualWorkerOwner(file, owner, { pid: process.pid, port: 12345 })
      .finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(settled, false, 'publication cannot overlap an open participating read handle');
    releaseReader(); await reading; await publishing;
    const published = { ...owner, pid: process.pid, port: 12345 };
    assert.deepEqual(await readVisualOwner(file), published);
    await assert.rejects(publishVisualWorkerOwner(file, published, { pid: process.pid, port: 12346 }), /VISUAL_IDENTITY_INVALID/,
      'a published descriptor cannot become a fresh publication baseline');
    // A replacement identity is a conflict, never a new baseline for retry.
    await assert.rejects(publishVisualWorkerOwner(file, owner, { pid: process.pid, port: 12346 }), /VISUAL_IDENTITY_INVALID/);
    assert.deepEqual(await readVisualOwner(file), published);
    const expired = { ...owner, deadlineAt: Date.now() - 1 };
    await withVisualOwnerFileLock(file, () => writePrivateJsonFile(file, expired));
    await assert.rejects(publishVisualWorkerOwner(file, expired, { pid: process.pid, port: 12345 }), /VISUAL_IDENTITY_INVALID/);
    assert.deepEqual(await readVisualOwner(file), expired);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['active', 'owner-control']);
    assert.deepEqual(await fs.readdir(path.join(directory, 'owner-control')), [],
      'the shared mutex leaves no second journal or persistent ownership record');
  } finally {
    releaseReader(); await reading?.catch(() => {}); await publishing?.catch(() => {});
    await reader?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native Windows characterizes atomic descriptor publication while the original reader is open', {
  skip: process.platform !== 'win32' || process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 20000,
}, async t => {
  // The detached parent's startup poll reads this SAME private writer's file.
  // Keep one ordinary native read handle open deliberately, rather than infer
  // Windows sharing semantics from an intermittent startup failure. These are
  // disposable structural counters, never a real owner/bearer/credential.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-owner-publish-fixture-'));
  const file = path.join(directory, 'owner.json');
  let reader, blocked = null;
  try {
    await writePrivateJsonFile(file, { version: 1 });
    reader = await fs.open(file, 'r');
    try { await writePrivateJsonFile(file, { version: 2 }); }
    catch (error) {
      blocked = { code: error.code, syscall: error.syscall };
      // A native refusal is characterized, not swallowed as a successful write.
      // Every other failure remains a hard error without exposing raw paths.
      assert.deepEqual(blocked, { code: 'EPERM', syscall: 'rename' });
      assert.deepEqual(await readPrivateJsonFile(file), { version: 1 });
    }
    assert.deepEqual(JSON.parse(await reader.readFile('utf8')), { version: 1 });
    await reader.close(); reader = null;
    await writePrivateJsonFile(file, { version: 2 });
    assert.deepEqual(await readPrivateJsonFile(file), { version: 2 });
    t.diagnostic(JSON.stringify({ publicationWithReader: blocked ? 'rename_access_denied' : 'published' }));
  } finally {
    await reader?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('synthetic worker evidence retains closed failure categories and drops arbitrary error/owner data',async()=>{
  const {visualNavigationFixturePhase,visualStartupFixturePhase}=await import('../host-runtime/scripts/trelio-visual-extension-browser.mjs');
  const source=await fs.readFile(new URL('../host-runtime/scripts/trelio-visual-worker.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function fixtureDiagnostic(value) {'),end=source.indexOf('\nasync function stop()',start);
  assert.ok(start>=0&&end>start);
  const snapshots=[];
  const scope={fixtureOnly:true,fixtureEvidence:[],fixtureWrites:Promise.resolve(),
    PROCESS_DIAGNOSTIC_CODES,ProcessDiagnosticError,parseProcessDiagnostic,processDiagnosticCauseCode,visualNavigationFixturePhase,visualStartupFixturePhase,path,owner:{directory:os.tmpdir()},
    writePrivateJsonFile:async(_file,value)=>snapshots.push(JSON.parse(JSON.stringify(value)))};
  vm.createContext(scope);vm.runInContext(source.slice(start,end),scope);
  scope.input={stage:'startup_failed',startupPhase:'owner_publish',failureCode:'TRELIO_WINDOWS_PRIVATE_ACL_FAILED',
    causeCode:'EACCES',message:'SYNTHETIC PRIVATE MESSAGE',stack:'PRIVATE STACK',token:'PRIVATE BEARER',owner:{token:'PRIVATE'}};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1),{evidence:[{stage:'startup_failed',startupPhase:'owner_publish',
    failureCode:'TRELIO_WINDOWS_PRIVATE_ACL_FAILED',causeCode:'EACCES'}]});
  scope.input={stage:'startup_failed',startupPhase:'PRIVATE',failureCode:'PRIVATE',causeCode:'PRIVATE'};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'startup_failed'});
  scope.input={stage:'startup_failed',error:new ProcessDiagnosticError('TRELIO_WINDOWS_PRIVATE_ACL_FAILED',
    'SYNTHETIC PRIVATE MESSAGE',{operation:'windows_acl.dacl_write',causeCode:'EACCES',path:'PRIVATE'})};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'startup_failed',process:{
    failureCode:'TRELIO_WINDOWS_PRIVATE_ACL_FAILED',operation:'windows_acl.dacl_write',causeCode:'EACCES'}});
  scope.input={stage:'startup_failed',startupPhase:'owner_publish',error:{
    syscall:'rename',path:'PRIVATE PATH',dest:'PRIVATE DESTINATION',message:'PRIVATE ERROR'}};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1).evidence.at(-1),{
    stage:'startup_failed',startupPhase:'owner_publish',ioOperation:'rename'});
  for(const [startupPhase,syscall] of [['owner_publish','PRIVATE SYSCALL'],['browser','rename']]) {
    scope.input={stage:'startup_failed',startupPhase,error:{syscall,message:'PRIVATE ERROR'}};
    vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
    assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'startup_failed',startupPhase});
  }
  scope.input={stage:'navigation_transport',outcome:'response_timeout',phase:'compositor_capture',url:'PRIVATE URL',requestId:'PRIVATE ID'};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'navigation_transport',outcome:'response_timeout',phase:'compositor_capture'});
  scope.input={stage:'navigation_transport',outcome:'response_timeout',phase:'PRIVATE PHASE'};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'navigation_transport',outcome:'response_timeout'});
  for (const operation of ['navigate', 'screenshot', 'read-text', 'scroll', 'PRIVATE_OPERATION']) {
    scope.input={stage:'navigation_transport',operation,outcome:'response_timeout',phase:'compositor_capture',args:{token:'PRIVATE'}};
    vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
    assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'navigation_transport',outcome:'response_timeout',
      ...(operation==='PRIVATE_OPERATION'?{}:{operation}),phase:'compositor_capture'});
  }
  // The SAME closed projector retains the last await of one scroll, never
  // page/input/owner data. Unknown native strings remain omitted.
  for (const phase of ['input_frame', 'input_tab', 'input_credential_guard',
    'input_mouse_move', 'input_mouse_wheel', 'input_settle', 'PRIVATE_PHASE']) {
    scope.input={stage:'navigation_transport',operation:'scroll',outcome:'response_timeout',phase,
      args:{text:'PRIVATE INPUT'},message:'PRIVATE ERROR',requestId:'PRIVATE REQUEST'};
    vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
    assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'navigation_transport',operation:'scroll',
      outcome:'response_timeout',...(phase==='PRIVATE_PHASE'?{}:{phase})});
  }
  const beforeInvalidOutcome=snapshots.length;
  scope.input={stage:'navigation_transport',outcome:'PRIVATE ERROR'};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.equal(snapshots.length,beforeInvalidOutcome);
  scope.input={stage:'startup_handshake',milestones:[
    {phase:'transport_connected',elapsedMs:17,token:'PRIVATE',url:'PRIVATE'},
    {phase:'policy_read',elapsedMs:25},{phase:'PRIVATE',elapsedMs:30},
    {phase:'hello',elapsedMs:-1},{phase:'hello',elapsedMs:600001},null,
    {phase:'hello',elapsedMs:'30'},{phase:'hello',elapsedMs:NaN}],error:'PRIVATE'};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'startup_handshake',milestones:[
    {phase:'transport_connected',elapsedMs:17},{phase:'policy_read',elapsedMs:25}]});
  for(const milestones of [null,{},Array(33).fill({phase:'hello',elapsedMs:1})]) {
    const before=snapshots.length;scope.input={stage:'startup_handshake',milestones};
    vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
    assert.equal(snapshots.length,before);
  }
  scope.input={stage:'navigation_transport',outcome:'response_timeout'};
  scope.fixtureOnly=false;const count=snapshots.length;
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.equal(snapshots.length,count,'ordinary production never writes fixture evidence');
});

const signingPolicy = compatible => ({ status: 0, stdout: compatible
  ? '<key>com.apple.security.cs.disable-library-validation</key>\n<true/>' : '',
stderr: 'flags=0x10000(runtime)' });
const nodeFixture = overrides => ({ platform: 'darwin', executable: '/app/node',
  home: '/user', arch: 'arm64', uid: 501, now: () => 0,
  realpath: value => value, stat: () => ({ isFile: () => true, mode: 0o100755, uid: 501 }),
  ...overrides });

test('visual worker keeps the current binary outside macOS without probing executable candidates', () => {
  for (const platform of ['win32', 'linux']) assert.equal(resolveVisualWorkerNode(nodeFixture({ platform,
    run() { throw new Error('unexpected native probe'); } })), '/app/node');
});

test('compatible current macOS Node needs no replacement or signing mutation', () => {
  for (const response of [signingPolicy(true), { status: 0, stderr: 'flags=0x2(adhoc)' },
    { status: 1, stderr: 'code object is not signed at all' }]) {
    const calls = [];
    assert.equal(resolveVisualWorkerNode(nodeFixture({ run: (file, args, options) => {
      calls.push([file, args]); assert.equal(options.shell, false); return response;
    } })), '/app/node');
    assert.deepEqual(calls, [['/usr/bin/codesign', ['-dvv', '--entitlements', ':-', '/app/node']]]);
  }
});

test('restricted embedded Node selects an owner-checked compatible standalone with matching architecture', () => {
  const selected = '/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node';
  const calls = [];
  assert.equal(resolveVisualWorkerNode(nodeFixture({ run: (file, args, options) => {
    calls.push([file, args]); assert.equal(options.shell, false);
    assert.deepEqual(options.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
    assert.ok(options.timeout > 0 && options.timeout <= (file === '/usr/bin/codesign' ? 1500 : 5000));
    if (file === '/usr/bin/codesign') return signingPolicy(args.at(-1) !== '/app/node');
    assert.equal(file, selected);
    return { status: 0, stdout: JSON.stringify({ major: 26, platform: 'darwin', arch: 'arm64' }) };
  } })), selected);
  assert.equal(calls.length, 3);
});

test('slow public Node identity uses the original remaining budget without another candidate or late acceptance', () => {
  for (const duration of [2000, 5000]) {
    let clock = 0, identities = 0;
    const invoke = () => resolveVisualWorkerNode(nodeFixture({ now: () => clock,
      run: (file, args, options) => {
        if (file === '/usr/bin/codesign') { clock += 100; return signingPolicy(args.at(-1) !== '/app/node'); }
        identities++;
        assert.equal(options.timeout, 4800, 'both signature probes consume the SAME five-second deadline');
        clock += duration;
        return { status: 0, stdout: JSON.stringify({ major: 24, platform: 'darwin', arch: 'arm64' }) };
      },
    }));
    if (duration === 2000) assert.equal(invoke(), '/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node');
    else assert.throws(invoke, { code: 'VISUAL_BOOTSTRAP_NODE_REQUIRED' });
    assert.equal(identities, 1, 'an exhausted deadline never spawns a second identity probe');
  }
});

for (const refusal of ['writable', 'foreign-owner', 'not-file', 'old-node', 'wrong-arch', 'wrong-platform', 'unknown-signature', 'failed-probe']) {
  test(`unsafe/incompatible standalone Node is not selected: ${refusal}`, () => {
    assert.throws(() => resolveVisualWorkerNode(nodeFixture({
      stat: () => ({ isFile: () => refusal !== 'not-file', mode: refusal === 'writable' ? 0o100777 : 0o100755,
        uid: refusal === 'foreign-owner' ? 502 : 501 }),
      run: (file, args) => {
        if (file === '/usr/bin/codesign') return args.at(-1) === '/app/node' ? signingPolicy(false)
          : refusal === 'unknown-signature' ? { status: 1, stderr: 'unverified signing state' } : signingPolicy(true);
        return refusal === 'failed-probe' ? { status: 1 } : { status: 0, stdout: JSON.stringify({
          major: refusal === 'old-node' ? 21 : 26, platform: refusal === 'wrong-platform' ? 'linux' : 'darwin',
          arch: refusal === 'wrong-arch' ? 'x64' : 'arm64' }) };
      },
    })), { code: 'VISUAL_BOOTSTRAP_NODE_REQUIRED' });
  });
}

test('all signing and version discovery shares one non-sliding deadline', () => {
  let clock = 0, probes = 0;
  assert.throws(() => resolveVisualWorkerNode(nodeFixture({ now: () => clock,
    run: () => { probes++; clock = 5001; return signingPolicy(false); },
  })), { code: 'VISUAL_BOOTSTRAP_NODE_REQUIRED' });
  assert.equal(probes, 1);
});

test('standalone browser opens a real page, hands off manual input and isolates another chat', {
  skip: process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 180_000,
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-standalone-')));
  const seen = [];
  let restoredCookie;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/proof') {
      seen.push(req.url);
      res.setHeader('Set-Cookie', 'browser_fixture=kept; Path=/; HttpOnly');
    }
    if (req.url === '/restored') restoredCookie = req.headers.cookie;
    res.end('<!doctype html><main style="height:1800px"><a href="/proof">Fixture link</a></main>');
  });
  const listener = ownFixtureHttpServer(server, t.signal);
  await listener.listen();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = { kind: 'codex', id: randomUUID() };
  const sibling = { kind: 'codex', id: randomUUID() };
  const active = path.join(directory, 'visual-browser', visualStandaloneStorageScope({ origin, ...owner }), 'active');
  const call = async (operation, args = {}, currentOwner = owner, signal = t.signal) => {
    const result = await runStandaloneVisualBrowser({ origin, owner: currentOwner, input: { operation, args }, signal,
      run: options => runVisualSession({ ...options, fixture: { directory, headless: process.env.TRELIO_VISUAL_FIXTURE_HEADLESS === '1' } }),
    });
    const [meta, image] = result.content;
    return { ...JSON.parse(meta.text), image };
  };
  t.after(async () => {
    await listener.stop();
    await call('close', {}, owner, null).catch(() => {});
    for (let i = 0; i < 160; i++) {
      if (!await fs.stat(active).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
        // The claim is gone, but Chromium may still be releasing file handles
        // in this owned fixture directory. A persistent cleanup failure stays red.
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Standalone fixture worker did not release its own claim');
  });

  assert.equal((await call('navigate', { url: origin })).state, 'preparing');
  assert.equal((await call('wait')).state, 'ready');
  assert.equal((await call('status', {}, sibling)).state, 'not_configured');
  assert.equal((await call('screenshot', {}, sibling)).reason, 'session_closed');
  const frame = await call('screenshot');
  assert.equal(frame.image.type, 'image');
  assert.equal(frame.image.mimeType, 'image/png');
  assert.equal((await call('click', { frameId: frame.frameId, x: 24, y: 16 })).state, 'ready');
  assert.deepEqual(seen, ['/proof']);
  assert.equal((await call('click', { frameId: frame.frameId, x: 24, y: 16 })).reason, 'stale_frame');
  assert.equal((await call('setup', { url: origin })).state, 'manual_input_required');
  const manual = await call('screenshot');
  assert.equal(manual.reason, 'manual_control_active');
  assert.equal(manual.image, undefined);
  assert.equal((await call('ready')).state, 'saved_unverified');
  assert.equal((await call('navigate', { url: origin + '/restored' })).state, 'ready');
  assert.equal(restoredCookie, 'browser_fixture=kept');
});

test('detached worker keeps its original lease and encrypted storage across short calls', { skip: process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 180_000 }, async t => {
  const fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-worker-test-')));
  // The retired layout would append the account hash and browser generation
  // here, then cross MAX_PATH inside Chromium's cache. Keep this Unicode path
  // below the new launch budget while exercising the real detached worker.
  const directory = process.platform === 'win32'
    ? path.join(fixtureRoot, 'Профиль ' + 'a'.repeat(Math.max(0, 107 - fixtureRoot.length))) : fixtureRoot;
  await fs.mkdir(directory, { recursive: true });
  let invalidDocumentRequests = 0;
  const externalNavigations = [];
  const externalPdf = Buffer.from('%PDF-1.7\nSynthetic external original\n%%EOF\n');
  const upload = Promise.withResolvers();
  const external = http.createServer(async (req, res) => {
    if (['/direct', '/redirected'].includes(req.url)) externalNavigations.push(req.url);
    if (req.url === '/original') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment' });
      res.end(externalPdf);
      return;
    }
    if (req.url === '/upload' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      upload.resolve(Buffer.concat(chunks));
      res.end('ok');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><p>External visual fixture</p>
      <button style="position:absolute;left:30px;top:100px;width:160px;height:50px"
        onclick="document.querySelector('input').click()">Attach file</button>
      <input type="file" hidden onchange="fetch('/upload',{method:'POST',body:this.files[0]})">`);
  });
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    external.closeAllConnections();
    await new Promise(resolve => external.close(resolve));
  });
  const externalOrigin = `http://127.0.0.1:${external.address().port}`;
  const server = http.createServer((req, res) => {
    if (req.url === '/download-page') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><a href="${externalOrigin}/original"
        style="position:absolute;left:30px;top:50px;width:160px;height:50px">Download PDF</a>`);
      return;
    }
    if (req.url === '/redirect-external') {
      res.writeHead(302, { Location: externalOrigin + '/redirected' });
      res.end();
      return;
    }
    if (req.url === '/non-document') {
      invalidDocumentRequests++;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"fixture":"never observed"}');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><body style="background:#45cc77;height:1800px">Synthetic visual fixture</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const start = Date.now();
  const env = { TRELIO_ORIGIN: 'https://example.test', TRELIO_SKILL_ID: 'synthetic-visual-fixture', TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: randomUUID() }), TRELIO_SKILL_COMPANY_ID: randomUUID(), TRELIO_SKILL_MEMBER_ID: randomUUID(), TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({ apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 150_000 }), TRELIO_BROWSER_SESSION_STARTED_AT: String(start), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(start + 150_000) };
  const supportedFiles = { attachmentDownloads: true, fileUploads: true };
  const call = (operation, args = {}) => runVisualSession({ origins: [origin], ...supportedFiles,
    operation, args, env, fixture: { directory, headless: process.env.TRELIO_VISUAL_FIXTURE_HEADLESS === '1' } });
  const scope = visualStorageScope({ origin: 'https://example.test', skillId: env.TRELIO_SKILL_ID, accountId: JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON).id });
  const { AsyncEntry } = await loadVisualDependencies();
  const store = new ProtectedVisualStore({ directory, scope, AsyncEntry });
  const waitForClose = async () => {
    for (let i = 0; i < 160; i++) {
      if (!await fs.stat(path.join(store.directory, 'active')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Synthetic worker did not close within cleanup deadline');
  };
  let failure;
  try {
    assert.equal((await call('setup', { url: origin })).state, 'preparing');
    let status;
    for (let i = 0; i < 120; i++) {
      status = await call('status');
      if (status.state !== 'preparing') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(status.state, 'manual_input_required', JSON.stringify({ reason: status.reason, diagnostic: await fs.readFile(path.join(directory, 'fixture-diagnostic.json'), 'utf8').catch(() => '') }));
    if (process.platform === 'win32') {
      const staging = path.join(directory, 'v');
      const [generation, ...others] = await fs.readdir(staging);
      assert.match(generation, /^b-[a-zA-Z0-9]{6}$/u);
      assert.deepEqual(others, []);
      assert.ok((await fs.stat(path.join(staging, generation, 'profile'))).isDirectory());
      assert.ok((await fs.stat(path.join(staging, generation, 'extension', 'manifest.json'))).isFile());
      assert.equal((await fs.readdir(store.directory)).some(name => name.startsWith('extension-session-')), false);
    }
    assert.equal((await call('screenshot')).reason, 'manual_control_active');
    assert.equal((await call('ready')).state, 'saved_unverified');
    if (process.platform === 'win32') assert.deepEqual(await fs.readdir(path.join(directory, 'v')), []);
    const frame = await call('navigate', { url: origin });
    assert.equal(frame.state, 'ready', JSON.stringify({ reason: frame.reason, diagnostic: await fs.readFile(path.join(directory, 'fixture-diagnostic.json'), 'utf8').catch(() => '') })); assert.ok(frame.image);
    assert.equal((await runVisualSession({ origins: [origin], ...supportedFiles, externalNavigation: false,
      operation: 'navigate', args: { url: origin }, env,
      fixture: { directory, headless: process.env.TRELIO_VISUAL_FIXTURE_HEADLESS === '1' } })).reason,
      'observation_mode_mismatch', 'a live worker cannot change its pinned navigation mode');
    const next = await call('scroll', { frameId: frame.frameId, x: 300, y: 300, deltaY: 500 });
    assert.equal(next.state, 'ready', JSON.stringify({ next, diagnostic: await fs.readFile(path.join(directory, 'fixture-diagnostic.json'), 'utf8').catch(() => '') }));
    assert.equal(next.scroll.up, true);
    assert.equal((await call('scroll', { frameId: frame.frameId, x: 300, y: 300, deltaY: 500 })).reason, 'stale_frame');
    assert.equal((await call('navigate', { url: externalOrigin + '/direct' })).state, 'ready');
    const redirected = await call('navigate', { url: origin + '/redirect-external' });
    assert.equal(redirected.state, 'ready');
    assert.deepEqual(externalNavigations, ['/direct', '/redirected']);
    // The provider declares only the first origin. Use its ordinary link to
    // fetch an original from the second origin, with no additional CDN scope.
    const filePage = await call('navigate', { url: origin + '/download-page' });
    assert.equal(filePage.state, 'ready');
    const downloaded = await call('download-attachment', { frameId: filePage.frameId, x: 100, y: 75 });
    assert.equal(downloaded.state, 'ready', downloaded.reason);
    assert.deepEqual(await fs.readFile(downloaded.filePath), externalPdf);
    const uploadPage = await call('navigate', { url: externalOrigin + '/file-picker' });
    assert.equal(uploadPage.state, 'ready');
    const uploaded = await call('upload-files', { frameId: uploadPage.frameId, x: 100, y: 125, files: [downloaded.filePath] });
    assert.equal(uploaded.state, 'ready', uploaded.reason);
    let uploadTimeout;
    try {
      const received = await Promise.race([upload.promise, new Promise((_, reject) => {
        uploadTimeout = setTimeout(() => reject(new Error('Synthetic upload did not reach the second origin.')), 5000);
      })]);
      assert.deepEqual(received, externalPdf);
    } finally { clearTimeout(uploadTimeout); }
    assert.equal((await call('close')).state, 'closed');
    // Close is acknowledged before its bounded cleanup, so wait for the exact
    // claim to disappear before removing this synthetic key and directory.
    await waitForClose();
    assert.ok(await store.read());
    // A cold Chromium restores its synthetic snapshot but refuses a non-HTML
    // response. Wait must observe that result, even though storage restored.
    assert.equal((await call('navigate', { url: origin + '/non-document' })).state, 'preparing');
    const original = await call('wait');
    assert.equal(original.reason, 'document_blocked', JSON.stringify({ state: original.state, reason: original.reason }));
    assert.equal(original.state, 'error');
    assert.ok(original.sessionId);
    assert.equal((await call('status')).state, 'saved_unverified');
    assert.deepEqual(await call('wait'), original);
    assert.equal(invalidDocumentRequests, 1, 'waiting never repeats the original navigation');
    const recovered = await call('navigate', { url: origin });
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.sessionId, original.sessionId);
    assert.equal((await call('wait')).state, 'ready', 'a new operation supersedes the initial failure');
    await call('close'); await waitForClose();
    // Exercise the REAL detached entrypoint and repeated public observations
    // after a deterministic pre-browser failure. Never corrupt a real account
    // or unlock the synthetic vault again: malformed envelope shape is refused
    // before key access, and the original bytes must remain untouched.
    await writePrivateJsonFile(store.file, { format: 'SYNTHETIC_INVALID_ENVELOPE' });
    const rejectedBytes = await fs.readFile(store.file);
    assert.equal((await call('navigate', { url: origin })).state, 'preparing');
    let failed;
    for (let i = 0; i < 120; i++) {
      failed = await call('status');
      if (failed.state !== 'preparing') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(failed.state, 'error');
    assert.deepEqual(failed.diagnostic, { stage: 'storage_read', code: 'storage_corrupt' });
    assert.deepEqual((await call('wait')).diagnostic, failed.diagnostic);
    assert.deepEqual((await call('status')).diagnostic, failed.diagnostic);
    assert.deepEqual(await fs.readFile(store.file), rejectedBytes, 'diagnosis never resets damaged auth state');
    await call('close'); await waitForClose();
  } catch (error) { failure = error; }
  finally {
    let stopped = false, diagnostic = '';
    try {
      await call('close'); await waitForClose(); stopped = true; await store.remove();
    } catch (error) {
      // A failed shutdown must neither mask the ORIGINAL browser assertion nor
      // leave this test's HTTP listener alive until the hosted job is killed.
      // Keep the private directory/key if a worker still owns its claim: test
      // cleanup is not permission to erase an active profile or kill a disk PID.
      failure ||= error;
    } finally {
      store.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (failure) diagnostic = await fs.readFile(path.join(directory, 'fixture-diagnostic.json'), 'utf8').catch(() => '');
      if (stopped && !failure) {
        // The exact worker claim is gone and this directory belongs only to
        // the fixture. Windows may briefly retain a just-closed file handle;
        // use the same bounded disposal policy as the other native fixtures.
        // This retries removal only, never close/authentication/provider work,
        // and failed assertions retain their original evidence without disposal.
        try { await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
        catch (error) { failure ||= error; }
      }
    }
    if (failure) {
      // This synthetic worker writes only closed, allowlisted stages. Never
      // dump owner.json: it includes the private control bearer token.
      failure.message += `; synthetic worker evidence: ${diagnostic || 'unavailable'}`;
      throw failure;
    }
  }
});


// Independent fresh accounts exercise concurrent cold init more than once;
// these are separate synthetic lifecycles, never retries of a failed action.
for (const repetition of [1, 2, 3]) test(`native browser workers of two chats keep separate contexts, frames and shutdown on one saved account (fresh ${repetition})`, {
  skip: process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 180000,
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-native-two-chats-')));
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><body style="background:#45cc77;height:2000px">Synthetic parallel browser</body>');
  });
  const ownedServer = ownFixtureHttpServer(server, t.signal);
  await ownedServer.listen();
  const origin = `http://127.0.0.1:${server.address().port}`, started = Date.now();
  const base = { TRELIO_ORIGIN: 'https://example.test', TRELIO_SKILL_ID: 'synthetic-parallel-native',
    TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: randomUUID() }), TRELIO_SKILL_COMPANY_ID: randomUUID(),
    TRELIO_SKILL_MEMBER_ID: randomUUID(), TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({
      apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 150000 }),
    TRELIO_BROWSER_SESSION_STARTED_AT: String(started), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(started + 150000) };
  const owners = [0, 1].map(() => ({ ...base, TRELIO_SKILL_RUNTIME_SESSION_ID: randomUUID() }));
  const call = (index, operation, args = {}) => runVisualSession({ origins: [origin], operation, args,
    env: owners[index], fixture: { directory, headless: process.env.TRELIO_VISUAL_FIXTURE_HEADLESS === '1' } });
  const binding = visualSessionBinding(owners[0]);
  const evidence = index => fs.readFile(path.join(directory,
    `fixture-diagnostic-${visualSessionBinding(owners[index]).executionOwner}.json`), 'utf8').catch(() => 'unavailable');
  const active = index => path.join(browserExecutionDirectory(path.join(directory, 'visual-browser', binding.scope), owners[index]), 'active');
  const closed = async index => {
    for (let attempt = 0; attempt < 160; attempt++) {
      const exists = await fs.lstat(active(index)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (!exists) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Synthetic parallel worker cleanup was not confirmed');
  };
  let cleanupComplete = false, failure;
  try {
    const starts = await Promise.all(owners.map((_, index) => call(index, 'setup', { url: origin })));
    assert.deepEqual(starts.map(value => value.state), ['preparing', 'preparing']);
    for (let index = 0; index < 2; index++) {
      let status;
      for (let attempt = 0; attempt < 120; attempt++) {
        status = await call(index, 'status');
        if (status.state !== 'preparing') break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      // Keep only the production closed startup diagnostic. A failed native
      // child must expose its stage/cause, never owner.json or control tokens.
      assert.equal(status.state, 'manual_input_required', JSON.stringify({ reason: status.reason, diagnostic: status.diagnostic,
        workerEvidence: await evidence(index) }));
      const ready = await call(index, 'ready');
      // Observe the original response once. A failure must retain its closed
      // reason and SAME worker tail without another ready/status/native input,
      // a longer deadline or a weaker snapshot assertion.
      assert.equal(ready.state, 'saved_unverified', JSON.stringify({ index, reason: ready.reason,
        diagnostic: ready.diagnostic, workerEvidence: await evidence(index) }));
    }
    const observations = await Promise.all(owners.map(async (_, index) => {
      const navigationStarted = performance.now();
      const value = await call(index, 'navigate', { url: origin });
      return { value, elapsedMs: Math.round(performance.now() - navigationStarted) };
    }));
    // Preserve each ORIGINAL initial response before cleanup. The fresh
    // launch uses screenshot internally, so the navigation-only trace used
    // to omit its failure entirely. Never print image/body/frame/owner data,
    // repeat the request or relax the same ready assertion.
    observations.forEach(({ value, elapsedMs }, index) => assert.equal(value.state, 'ready',
      JSON.stringify({ phase: 'initial_navigation', index, elapsedMs, reason: value.reason, diagnostic: value.diagnostic })));
    const [a, b] = observations.map(({ value }) => value);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal((await call(1, 'scroll', { frameId: a.frameId, x: 300, y: 300, deltaY: 100 })).reason, 'stale_frame');
    assert.equal((await call(0, 'close')).state, 'closed'); await closed(0);
    const navigationStarted = performance.now();
    const next = await call(1, 'navigate', { url: origin });
    // Capture the original closed result before cleanup. Time the failed
    // request itself so setup and shutdown do not look like its timeout.
    assert.equal(next.state, 'ready', 'closing the sibling preserves this browser: ' + JSON.stringify({
      elapsedMs: Math.round(performance.now() - navigationStarted),
      reason: next.reason,
      diagnostic: next.diagnostic,
    }));
    const scrollStarted = performance.now();
    const scrolled = await call(1, 'scroll', { frameId: next.frameId, x: 300, y: 300, deltaY: 100 });
    // The original scroll response must survive later shutdown diagnostics.
    // Do not repeat input or capture to manufacture a successful observation.
    assert.equal(scrolled.state, 'ready', 'the surviving browser scrolls once: ' + JSON.stringify({
      elapsedMs: Math.round(performance.now() - scrollStarted), reason: scrolled.reason,
      diagnostic: scrolled.diagnostic,
    }));
  } catch (error) { failure = error; }
  finally {
    // Stop this fixture's listener even if a browser's queue never settles.
    // The shared helper also runs on test cancellation, which does not resume
    // a blocked async finally. No foreign worker/claim is touched here.
    try { await ownedServer.stop(); } catch (error) { failure ||= error; }
    try {
      let allClosed = true;
      for (let index = 0; index < 2; index++) {
        try { await call(index, 'close'); await closed(index); }
        catch (error) {
          // A second shutdown failure must not replace the original ready,
          // navigation or close assertion. Still close the other OWN worker;
          // one failed sibling must not skip its independent cleanup.
          failure ||= error; allClosed = false;
        }
      }
      if (allClosed) {
        const { AsyncEntry } = await loadVisualDependencies();
        const store = new ProtectedVisualStore({ directory, scope: binding.scope, AsyncEntry });
        try { await store.remove(); } finally { store.close(); }
        cleanupComplete = true;
      }
    } catch (error) { failure ||= error; }
    finally {
      // Keep failed native evidence and any still-owned profile intact. Both
      // tails contain only the worker's existing closed diagnostic vocabulary;
      // owner.json contains a bearer and must never be printed instead.
      if (failure) failure.message += `; synthetic parallel worker evidence: ${JSON.stringify(await Promise.all(owners.map((_, index) => evidence(index))))}`;
      if (cleanupComplete && !failure) {
        try { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
        catch (error) { failure ||= error; }
      }
    }
    if (failure) throw failure;
  }
});
