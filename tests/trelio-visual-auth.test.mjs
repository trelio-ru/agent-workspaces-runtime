import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeVisualAuthentication, visualAuthenticationFingerprint, configureVisualAuthentication, authenticateVisualBrowser, hasVisualAuthenticationCredentials, VISUAL_AUTHENTICATION_TRANSITIONS_API, VISUAL_AUTHENTICATION_COMPATIBILITY_API } from '../host-runtime/scripts/trelio-visual-session.mjs';
import { ProtectedVisualStore, visualStorageScope } from '../host-runtime/scripts/trelio-visual-store.mjs';
import { deriveAgentSecretTotp } from '../host-runtime/scripts/trelio-workspace.mjs';
import { ExtensionVisualBrowser } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';
import { createVisualOriginPolicy } from '../host-runtime/scripts/trelio-visual-browser.mjs';
import { loadVisualDependencies } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { runVisualSession } from '../host-runtime/scripts/trelio-visual-session.mjs';

import { ownFixtureHttpServer } from './fixtures/visual-owned-http.mjs';

test('synthetic auth listener closes active connections on abort even when browser cleanup is never reached', {timeout:3000}, async()=>{
  const controller=new AbortController(),server=http.createServer(()=>{});
  const owned=ownFixtureHttpServer(server,controller.signal);
  let request;
  try{
    await owned.listen();const address=server.address(),incoming=once(server,'request');
    request=http.get(`http://127.0.0.1:${address.port}`);request.on('error',()=>{});
    // Destroying the server's active socket intentionally emits ECONNRESET on
    // this disposable client. Wait for actual close rather than events.once(),
    // whose error shortcut would reject before that cleanup proof arrives.
    const disconnected=new Promise(resolve=>request.once('close',resolve));await incoming;
    controller.abort(new Error('synthetic fixture timeout'));
    await owned.stop();await disconnected;
    assert.equal(server.listening,false,'a failed test has no live HTTP handle awaiting its blocked browser queue');
    await owned.stop();
  }finally{request?.destroy();await owned.stop();}
  const early=new AbortController();early.abort(new Error('already aborted'));
  const unopened=http.createServer(()=>{}),stopped=ownFixtureHttpServer(unopened,early.signal);
  await assert.rejects(stopped.listen(),/already aborted/);await stopped.stop();assert.equal(unopened.listening,false);
  const pending=new AbortController(),unbound=http.createServer(()=>{}),cancelled=ownFixtureHttpServer(unbound,pending.signal);
  const binding=cancelled.listen();pending.abort();
  await assert.rejects(binding,{name:'AbortError'});await cancelled.stop();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(unbound.listening,false,'an abort during bind cannot create a late listener after cleanup');
});

const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC 6238 synthetic vector only.
const recipe = origin => ({ steps: [
  { id: 'password', origin, challenge: '#password-form', fields: { login: '#login', password: '#password' }, submit: '#submit-password' },
  { id: 'totp', origin, challenge: '#totp-form', fields: { totp: '#totp' }, submit: '#submit-totp' },
], success: [{ origin, selector: '#account' }] });
const definition = origin => normalizeVisualAuthentication(recipe(origin), { origins: [origin], fixtureOnly: origin.startsWith('http://127.0.0.1:') });
const withTransition = origin => {
  const value = recipe(origin);
  value.steps.splice(1, 0, { id: 'choose-authenticator', origin, challenge: '#method-choice',
    action: 'follow', target: '#choose-authenticator', path: '/totp-entry', manual: ['#captcha'] });
  return normalizeVisualAuthentication(value, { origins: [origin], fixtureOnly: origin.startsWith('http://127.0.0.1:') });
};
const credential = def => ({ schemaVersion: 1, fingerprint: visualAuthenticationFingerprint(def), login: 'SYNTHETIC_LOGIN', password: 'SYNTHETIC_PASSWORD', totp: seed, attempt: null });
function memoryStore(def) {
  let saved = credential(def), snapshot;
  return { async readCredentials() { return structuredClone(saved); }, async writeCredentials(value) { saved = structuredClone(value); }, async read() { return snapshot; }, async prepare() {}, async write(value) { snapshot = structuredClone(value); }, close() {}, get saved() { return structuredClone(saved); } };
}

// Synthetic provider update: no stored secret changes destination. Only a
// factor tag and a non-secret step/success observation are added. Legacy proof
// is an exact previous recipe, never a caller-provided hash exception.
function compatibleDefinition(origin, previous = definition(origin)) {
  const next = structuredClone(recipe(origin)); next.steps[1].factor = 'totp';
  next.steps.push({ id: 'choose-email', origin, challenge: '#method-choice', action: 'follow',
    target: '#choose-email', path: '/email', factor: 'email' });
  next.success.push({ origin, selector: '#new-account' });
  next.credentialCompatibility = { previousRecipes: [previous] };
  return normalizeVisualAuthentication(next, { origins: [origin], fixtureOnly: origin.startsWith('http://127.0.0.1:') });
}

test('compatible signed legacy proof preserves credentials; status never rewrites ciphertext', async () => {
  const origin = 'https://auth.example.test', old = definition(origin), next = compatibleDefinition(origin), store = memoryStore(old);
  assert.equal(VISUAL_AUTHENTICATION_COMPATIBILITY_API, 'trelio.protected-browser-auth-compatibility/v1');
  const before = store.saved;
  assert.equal(await hasVisualAuthenticationCredentials(store, next), true);
  assert.deepEqual(store.saved, before);
  const noProof = { ...next }; delete noProof.credentialCompatibility;
  await assert.rejects(hasVisualAuthenticationCredentials(store, noProof), { code: 'authentication_setup_required' });
  let fills = 0;
  const result = await authenticateVisualBrowser({ store, definition: next, active() {}, wait: async () => {},
    send: async (op, args) => {
      if (op === 'authentication-probe') return fills ? { state: 'success' } : { state: 'challenge', stepId: 'password', documentId: randomUUID() };
      assert.equal(store.saved.schemaVersion, 2); assert.equal(store.saved.attempt.state, 'pending');
      assert.equal(args.values.password, 'SYNTHETIC_PASSWORD'); fills++; return { state: 'submitted' };
    } });
  assert.equal(result.state, 'saved_unverified'); assert.equal(fills, 1);
  assert.equal(store.saved.password, before.password); assert.equal(store.saved.totp, before.totp);
  assert.equal(store.saved.fingerprint, visualAuthenticationFingerprint(next));
  // A later v2 release needs no growing history of old recipes.
  assert.equal(await hasVisualAuthenticationCredentials(store, noProof), true);
});

test('compatibility cannot change any reusable secret destination or form guard', async () => {
  const origin = 'https://auth.example.test', old = definition(origin), store = memoryStore(old);
  for (const patch of [{ origin: 'https://other.example.test' }, { challenge: '#other' },
    { fields: { login: '#login', password: '#other' } }, { submit: '#other' }, { manual: ['#captcha'] }, { id: 'renamed-password' }]) {
    const raw = structuredClone(recipe(origin)); Object.assign(raw.steps[0], patch);
    raw.credentialCompatibility = { previousRecipes: [old] };
    assert.throws(() => normalizeVisualAuthentication(raw, { origins: [origin, 'https://other.example.test'] }), { code: 'invalid_input' });
  }
  const next = compatibleDefinition(origin); next.steps[0].fields.password = ['#other'];
  // This simulates an updated normalized v2 recipe, not just a legacy proof.
  // The saved stable binding still rejects a changed destination.
  let complete = false;
  await authenticateVisualBrowser({ store, definition: old, active() {}, wait: async () => {}, send: async op => {
    if (op === 'authentication-probe') return complete ? { state: 'success' } : { state: 'challenge', stepId: 'password', documentId: randomUUID() };
    complete = true; return { state: 'submitted' };
  } });
  await assert.rejects(hasVisualAuthenticationCredentials(store, next), { code: 'authentication_setup_required' });
  assert.throws(() => normalizeVisualAuthentication({ ...old, credentialCompatibility: { previousRecipes: [{ ...old, credentialCompatibility: {} }] } }, { origins: [origin] }));
  assert.throws(() => normalizeVisualAuthentication({ ...old, credentialCompatibility: { previousRecipes: [old, old] } }, { origins: [origin] }));
});

test('compatible updates preserve pending input and unknown mail ACK without any write or replay', async () => {
  const origin = 'https://auth.example.test', old = definition(origin), next = compatibleDefinition(origin);
  for (const acknowledgement of [null, 'pending', 'unknown']) {
    const store = memoryStore(old), saved = store.saved;
    saved.attempt = { id: randomUUID(), state: acknowledgement ? 'complete' : 'pending', steps: ['password'] };
    if (acknowledgement) saved.attempt.mail = { requestId: randomUUID(), requestedAt: 1, expiresAt: 1001,
      mailAccountId: randomUUID(), state: 'failed', acknowledgement, reference: null, baseline: null };
    await store.writeCredentials(saved);
    assert.equal(await hasVisualAuthenticationCredentials(store, next), true);
    await assert.rejects(authenticateVisualBrowser({ store, definition: next, active() {}, send: async op => {
      assert.equal(op, 'authentication-probe', 'no fill/follow may occur');
      return { state: 'challenge', stepId: 'password', documentId: randomUUID() };
    } }), { code: 'authentication_unknown' });
    assert.deepEqual(store.saved, saved, 'a recipe update cannot clear/rebind the historical fence');
  }
});

test('signed authentication recipe pins exact origins and rejects unknown instructions/oversized data', () => {
  const origin = 'https://auth.example.test', def = definition(origin);
  assert.equal(def.steps[0].fields.password[0], '#password');
  assert.equal(normalizeVisualAuthentication(null, {}), null);
  for (const value of [{ ...recipe(origin), script: 'arbitrary()' }, { ...recipe(origin), steps: [{ ...recipe(origin).steps[0], origin: 'https://auth.example.test.evil.test' }] }, { ...recipe(origin), steps: [{ ...recipe(origin).steps[0], fields: { token: '#token' } }] }]) assert.throws(() => normalizeVisualAuthentication(value, { origins: [origin] }));
  assert.throws(() => normalizeVisualAuthentication(recipe(origin), { origins: [], domains: ['example.test'] }), { code: 'navigation_blocked' });
  const changed = definition('https://different.example.test');
  assert.notEqual(visualAuthenticationFingerprint(def), visualAuthenticationFingerprint(changed));
});

test('TOTP reuses the existing private generator and RFC vectors, not a seed delivered to the browser', () => {
  assert.equal(deriveAgentSecretTotp(seed, 59000), '287082');
  assert.equal(deriveAgentSecretTotp(`otpauth://totp/Fixture?secret=${seed}&digits=8`, 59000), '94287082');
});

test('signed setup guidance cannot broaden origins or change the credential/fence fingerprint', () => {
  const origin = 'https://auth.example.test', base = definition(origin);
  const setup = { paragraphs: ['Enable the authenticator in your profile.'],
    links: [{ label: 'Profile', url: `${origin}/profile` }] };
  const extended = normalizeVisualAuthentication({ ...base, setup }, { origins: [origin] });
  assert.deepEqual(extended.setup, setup);
  assert.equal(visualAuthenticationFingerprint(extended), visualAuthenticationFingerprint(base));
  for (const patch of [{ url: 'https://foreign.example.test/profile' },
    { url: `${origin}/profile?code=not-a-setup-link` }, { url: `${origin}/profile#private` },
    { url: `https://login:password@auth.example.test/profile` }, { script: 'arbitrary()' }]) {
    assert.throws(() => normalizeVisualAuthentication({ ...base,
      setup: { ...setup, links: [{ ...setup.links[0], ...patch }] } }, { origins: [origin] }));
  }
  assert.throws(() => normalizeVisualAuthentication({ ...base, setup: { ...setup, fields: [] } }, { origins: [origin] }));
});

test('signed transitions are bounded exact-path anchors and preserve legacy recipe shapes', () => {
  const origin = 'https://auth.example.test', def = withTransition(origin), step = def.steps[1];
  assert.equal(VISUAL_AUTHENTICATION_TRANSITIONS_API, 'trelio.protected-browser-auth-transitions/v1');
  assert.equal(step.action, 'follow'); assert.equal(step.path, '/totp-entry');
  assert.equal(Object.hasOwn(definition(origin).steps[0], 'action'), false, 'legacy credentials retain their normalized fingerprint');
  // Golden fingerprint from the published field-only v1 implementation.
  // Adding optional transitions must not invalidate existing users' vaults.
  assert.equal(visualAuthenticationFingerprint(definition(origin)), 'a4952e064d09a964d908203d11fbf120690a662d69f11d740a5da95ac3958887');
  for (const patch of [{ fields: { password: '#password' } }, { values: { code: 'not-allowed' } },
    { action: 'click' }, { target: '' }, { origin: 'https://foreign.example.test' },
    ...['//foreign.example.test/path', '/totp?code=anything', '/totp#fragment', '/a/../totp', '/with space', '/a\\b'].map(path => ({ path }))]) {
    const changed = { ...def, steps: [def.steps[0], { ...step, ...patch }, def.steps[2]] };
    assert.throws(() => normalizeVisualAuthentication(changed, { origins: [origin] }));
  }
  assert.throws(() => normalizeVisualAuthentication({ ...def, steps: [step] }, { origins: [origin] }), { code: 'invalid_input' });
});

test('password, signed transition and TOTP share one private attempt without exposing values on navigation', async () => {
  const def = withTransition('https://auth.example.test'), store = memoryStore(def), dispatched = [];
  let attemptId;
  const result = await authenticateVisualBrowser({ definition: def, store, active() {}, now: () => 60000, wait: async () => {},
    send: async (operation, args) => {
      if (operation === 'authentication-probe') return dispatched.length === 3 ? { state: 'success' }
        : { state: 'challenge', stepId: def.steps[dispatched.length].id, documentId: randomUUID() };
      assert.equal(store.saved.attempt.state, 'pending');
      attemptId ||= store.saved.attempt.id; assert.equal(store.saved.attempt.id, attemptId);
      assert.ok(store.saved.attempt.steps.includes(args.stepId));
      if (args.stepId === 'choose-authenticator') {
        assert.equal(operation, 'authentication-follow');
        assert.deepEqual(Object.keys(args).sort(), ['documentId', 'stepId']);
        assert.doesNotMatch(JSON.stringify(args), /SYNTHETIC|GEZDGNBV|values|totp-entry/);
      } else assert.equal(operation, 'authentication-fill');
      dispatched.push(args.stepId); return { state: 'submitted' };
    } });
  assert.deepEqual(dispatched, ['password', 'choose-authenticator', 'totp']);
  assert.equal(store.saved.attempt.state, 'complete');
  assert.deepEqual(result, { state: 'saved_unverified', reason: 'none' });
});

test('lost transition, same-page loop and restart never repeat the click or earlier password', async () => {
  const def = withTransition('https://auth.example.test');
  for (const lost of [false, true]) {
    const store = memoryStore(def); let clicks = 0, clock = 60000;
    const run = () => authenticateVisualBrowser({ definition: def, store, active() {}, now: () => clock,
      wait: async ms => { clock += ms; }, send: async operation => {
        if (operation === 'authentication-probe') return { state: 'challenge', stepId: 'choose-authenticator', documentId: randomUUID() };
        assert.equal(operation, 'authentication-follow'); clicks++;
        assert.ok(store.saved.attempt.steps.includes('choose-authenticator'));
        if (lost) throw Error('synthetic lost navigation response');
        return { state: 'submitted' };
      } });
    if (lost) await assert.rejects(run());
    else assert.equal((await run()).reason, 'authentication_unknown');
    await assert.rejects(run(), { code: 'authentication_unknown' });
    assert.equal(clicks, 1);
  }
});

test('automatic password and TOTP input persist fences before dispatch, return only a status and never replay a lost result', async () => {
  const def = definition('https://auth.example.test'), store = memoryStore(def), sent = [];
  let stage = 0;
  const run = () => authenticateVisualBrowser({ store, definition: def, active() {}, now: () => 60000, wait: async () => {}, send: async (op, args) => {
    if (op === 'authentication-probe') return stage === 2 ? { state: 'success' } : { state: 'challenge', stepId: stage ? 'totp' : 'password', documentId: randomUUID() };
    assert.equal(store.saved.attempt.state, 'pending'); assert.ok(store.saved.attempt.steps.includes(args.stepId));
    sent.push(structuredClone(args)); stage++;
    return { state: 'submitted' };
  } });
  const result = await run();
  assert.deepEqual(result, { state: 'saved_unverified', reason: 'none' });
  assert.equal(sent[0].values.login, 'SYNTHETIC_LOGIN'); assert.equal(sent[0].values.password, 'SYNTHETIC_PASSWORD');
  assert.match(sent[1].values.totp, /^\d{6}$/u); assert.notEqual(sent[1].values.totp, seed);
  assert.equal(store.saved.attempt.state, 'complete');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|password|totp|values/);
  const lost = memoryStore(def); let inputs = 0;
  const attempt = () => authenticateVisualBrowser({ store: lost, definition: def, active() {}, wait: async () => {}, send: async op => {
    if (op === 'authentication-probe') return { state: 'challenge', stepId: 'password', documentId: randomUUID() };
    inputs++; throw Error('SYNTHETIC_PRIVATE_NATIVE_FAILURE');
  } });
  await assert.rejects(attempt());
  await assert.rejects(attempt(), { code: 'authentication_unknown' });
  assert.equal(inputs, 1, 'even a new invocation must not resubmit a lost password attempt');
});

test('ready sessions need no credential read; missing seed, changed recipe and expired lease fail closed', async () => {
  const def = definition('https://auth.example.test');
  const ready = await authenticateVisualBrowser({ store: { readCredentials() { throw Error('must not read'); } }, definition: def, active() {}, send: async () => ({ state: 'success' }) });
  assert.equal(ready.state, 'saved_unverified');
  const store = memoryStore(def); await store.writeCredentials({ ...store.saved, totp: '' });
  let fills = 0;
  assert.equal((await authenticateVisualBrowser({ store, definition: def, active() {}, send: async op => { if (op === 'authentication-fill') fills++; return { state: 'challenge', stepId: 'totp', documentId: randomUUID() }; } })).reason, 'authentication_required');
  assert.equal(fills, 0);
  await assert.rejects(authenticateVisualBrowser({ store, definition: definition('https://other.example.test'), active() {}, send: async () => ({ state: 'challenge', stepId: 'password', documentId: randomUUID() }) }), { code: 'authentication_setup_required' });
  await assert.rejects(authenticateVisualBrowser({ store, definition: def, active() { throw Object.assign(Error(), { code: 'lease_expired' }); }, send: async () => assert.fail('expired input') }), { code: 'lease_expired' });
});

test('TOTP window wait rechecks the complete document and never dispatches an empty code', async () => {
  const def = definition('https://auth.example.test'), store = memoryStore(def);
  let clock = 59000, probes = 0, fills = 0;
  const result = await authenticateVisualBrowser({ store, definition: def, active() {}, now: () => clock, wait: async ms => { clock += ms; }, send: async (op, args) => {
    if (op === 'authentication-probe') { probes++; return fills ? { state: 'success' } : { state: 'challenge', stepId: 'totp', documentId: randomUUID() }; }
    assert.equal(clock >= 60000, true); assert.match(args.values.totp, /^\d{6}$/u); fills++; return { state: 'submitted' };
  } });
  assert.equal(result.state, 'saved_unverified'); assert.ok(probes >= 3); assert.equal(fills, 1);
});

test('credential management rejects value-bearing arguments before identity, state writes or worker creation', async () => {
  for (const operation of ['credentials-setup', 'credentials-status', 'credentials-forget', 'authenticate']) {
    assert.equal((await runVisualSession({ origins: ['https://auth.example.test'], operation, args: { password: 'SYNTHETIC_NOT_AN_ARGUMENT' }, env: {} })).reason, 'invalid_input');
  }
});

test('one guarded local form saves the whole bundle, rejects injected fields, supports cancel and never returns values', async () => {
  const def = withTransition('https://auth.example.test'); let saved, calls = 0;
  def.setup = { paragraphs: ['Enable the authenticator in your profile.'],
    links: [{ label: 'Open account profile', url: 'https://auth.example.test/profile' }] };
  const store = { async prepare() {}, async writeCredentials(value) { saved = structuredClone(value); } };
  const openBrowserFn = async raw => {
    calls++; const url = new URL(raw), response = await fetch(url), html = await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(html, /TOTP-секрет/); assert.doesNotMatch(html, new RegExp(seed));
    assert.match(html, /Enable the authenticator in your profile/);
    assert.match(html, /href="https:\/\/auth\.example\.test\/profile"/);
    const fields = { nonce: url.searchParams.get('nonce'), decision: 'save', login: 'SYNTHETIC_LOGIN', password: 'SYNTHETIC_PASSWORD', totp: seed };
    const post = body => fetch(`${url.origin}/credential`, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    assert.equal((await post({ ...fields, unexpected: 'not allowed' })).status, 400);
    assert.equal(saved, undefined);
    const savedResponse = await post(fields);
    assert.equal(savedResponse.status, 200); assert.match(await savedResponse.text(), /<title>Сохранено<\/title>/);
  };
  assert.equal(await configureVisualAuthentication({ store, definition: def, openBrowserFn, setupTimeoutMs: 2000 }), undefined);
  assert.equal(saved.password, 'SYNTHETIC_PASSWORD'); assert.equal(saved.totp, seed); assert.equal(calls, 1);
  await assert.rejects(configureVisualAuthentication({ store, definition: def, setupTimeoutMs: 2000, openBrowserFn: async raw => {
    const url = new URL(raw); await fetch(url);
    await fetch(`${url.origin}/credential`, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ nonce: url.searchParams.get('nonce'), decision: 'cancel' }) });
  } }), { code: 'PROTECTED_FORM_CANCELLED' });
});

test('credential ciphertext survives restart, is separate from sessions and cannot replace a lost OS key', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-auth-store-'))), keys = new Map();
  class Entry { constructor(_service, scope) { this.scope = scope; } async getSecret() { return keys.get(this.scope) || null; } async setSecret(value) { keys.set(this.scope, [...value]); } async deleteCredential() { keys.delete(this.scope); } }
  const scope = visualStorageScope({ origin: 'https://trelio.example.test', skillId: 'fixture-browser', accountId: randomUUID() });
  const make = () => new ProtectedVisualStore({ directory, scope, AsyncEntry: Entry });
  const def = definition('https://auth.example.test'), first = make();
  try {
    await first.writeCredentials(credential(def)); first.close();
    assert.doesNotMatch(await fs.readFile(first.credentialsFile, 'utf8'), /SYNTHETIC|GEZDGNBV/);
    const next = make(); assert.equal((await next.readCredentials()).password, 'SYNTHETIC_PASSWORD'); await next.write({ schemaVersion: 2, files: [] }); next.close();
    const swapped = await fs.readFile(first.credentialsFile); await fs.writeFile(first.file, swapped);
    await assert.rejects(make().read(), { code: 'VISUAL_STORAGE_CORRUPT' });
    await fs.unlink(first.file); const savedKeys = new Map(keys); keys.clear();
    await assert.rejects(make().prepare(), { code: 'VISUAL_STORAGE_UNAVAILABLE' });
    await assert.rejects(make().write({ files: [] }), { code: 'VISUAL_STORAGE_UNAVAILABLE' });
    for (const [key, value] of savedKeys) keys.set(key, value);
    const final = make(); await final.write({ schemaVersion: 2, files: [] }); await final.forgetCredentials();
    assert.equal(await final.readCredentials(), null); assert.equal((await final.read()).schemaVersion, 2); await final.remove();
  } finally { first.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('native browser performs login and TOTP privately, gates images and reuses saved authenticated state', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180000 }, async t => {
  // Preflight before allocating a listener: an absent exact native dependency
  // must fail normally rather than leave this test process alive indefinitely.
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-auth-native-')));
  let passwordSubmits = 0, codeSubmits = 0, methodFollows = 0, mailSubmits = 0;
  // Fixed synthetic phases/counters locate a hosted outer deadline without
  // printing forms, credentials, private browser output, URLs or native logs.
  let phase='fixture_server',reported=false,variant='none',action='none',lastState='none',lastReason='none',primaryFailure=null;const evidence=[];
  const record=value=>{if(['auth','window_inventory','window','close_queue','close_manual','close_browser','close_snapshot',
    'browser_exit','browser_quit','browser_stop_timeout','extension_not_ready','extension_not_connected',
    'stopped_profile_snapshot_failed','stopped_profile_persist_failed','stopped_profile_cleanup_failed'].includes(value?.stage)){
    evidence.push(value.stage);if(evidence.length>8)evidence.shift();}};
  const diagnose=()=>{if(reported)return;reported=true;process.stderr.write(JSON.stringify({fixture:'synthetic_visual_auth',
    phase,variant,action,lastState,lastReason,failure:primaryFailure?.code==='ERR_ASSERTION'?'assertion':t.signal.aborted?'timeout':'operation',
    code:['EBUSY','EPERM','EACCES','ENOENT','ENOTEMPTY','operation_failed','storage_unavailable','VISUAL_STORAGE_CORRUPT'].includes(primaryFailure?.code)?primaryFailure.code:'other',
    syscall:['open','unlink','rmdir','scandir','lstat','rename'].includes(primaryFailure?.syscall)?primaryFailure.syscall:null,
    passwordSubmits,codeSubmits,methodFollows,mailSubmits,evidence})+'\n');};
  const observe=value=>{
    lastState=['ready','error','manual_input_required','saved_unverified'].includes(value?.state)?value.state:'other';
    lastReason=['none','bootstrap_failed','manual_control_active','operation_failed','lease_expired','storage_unavailable'].includes(value?.reason)?value.reason:'other';
    return value;
  };
  t.signal.addEventListener('abort',diagnose,{once:true});
  const methodChoice = (href = '/totp-entry', extra = '') => `<!doctype html><section id="method-choice"><a id="choose-authenticator" href="${href}">Use authenticator</a>${extra}</section>`;
  const totpForm = '<!doctype html><form id="totp-form" method="post" action="/code"><input id="totp" name="totp" autocomplete="one-time-code"><button id="submit-totp">Sign in</button></form>';
  const server = http.createServer(async (req, res) => {
    const body = []; for await (const chunk of req) body.push(chunk);
    const form = new URLSearchParams(Buffer.concat(body).toString());
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/mail-start') { res.end('<!doctype html><form id="password-form" method="post" action="/mail-password"><input id="login" name="login"><input id="password" name="password" type="password"><button id="submit-password">Continue</button></form>'); return; }
    if (req.url === '/mail-password' && req.method === 'POST') {
      assert.equal(form.get('password'), 'SYNTHETIC_PASSWORD');
      res.end('<!doctype html><section id="method-choice"><a id="choose-email" href="/mail-entry">Use email</a><a id="choose-authenticator" href="/totp-entry">Use authenticator</a></section>'); return;
    }
    if (req.url === '/mail-entry') { res.end('<!doctype html><form id="email-form" action="/mail-code" method="post"><input id="mail-code" name="code" autocomplete="one-time-code"><button id="submit-email">Continue</button></form>'); return; }
    if (req.url === '/mail-code' && req.method === 'POST') {
      mailSubmits++; assert.equal(form.get('code'), '123456');
      res.end('<!doctype html><h1 id="mail-account">Synthetic email login complete</h1>'); return;
    }
    if (req.url.startsWith('/password') && req.method === 'POST') {
      passwordSubmits++; assert.equal(form.get('login'), 'SYNTHETIC_LOGIN'); assert.equal(form.get('password'), 'SYNTHETIC_PASSWORD');
      if (req.url.includes('follow')) { res.end(methodChoice()); return; }
      res.end(req.url.includes('segmented') ? '<!doctype html><form id="totp-form" method="post" action="/code" oninput="if([...this.elements].every(e=>e.value.length===1))this.requestSubmit()">' + Array.from({ length: 6 }, (_, i) => `<input id="d${i}" name="d${i}" maxlength="1" autocomplete="one-time-code">`).join('') + '</form>' : '<!doctype html><form id="totp-form" method="post" action="/code"><input id="totp" name="totp" autocomplete="one-time-code"><button id="submit-totp">Sign in</button></form>'); return;
    }
    if (req.url === '/code' && req.method === 'POST') {
      codeSubmits++; const code = form.get('totp') || Array.from({ length: 6 }, (_, i) => form.get(`d${i}`)).join('');
      assert.ok([Date.now() - 30000, Date.now(), Date.now() + 30000].some(now => code === deriveAgentSecretTotp(seed, now)));
      res.setHeader('Set-Cookie', 'auth_fixture=SYNTHETIC_AUTH; HttpOnly; Path=/; SameSite=Strict'); res.end('<!doctype html><h1 id="account">Synthetic account</h1>'); return;
    }
    if (req.url === '/sms') { res.end('<!doctype html><form id="sms-form" method="post"><input autocomplete="one-time-code"></form>'); return; }
    if (req.url === '/totp-entry') { methodFollows++; res.end(totpForm); return; }
    if (req.url.startsWith('/follow-')) {
      const variants = {
        '/follow-unsafe': methodChoice('https://foreign.example.test/totp-entry'),
        '/follow-path': methodChoice('/different-path'),
        '/follow-popup': methodChoice().replace('href=', 'target="_blank" href='),
        '/follow-download': methodChoice().replace('href=', 'download href='),
        '/follow-hidden': methodChoice().replace('id="choose-authenticator"', 'id="choose-authenticator" hidden'),
        '/follow-ambiguous': methodChoice('/totp-entry', '<a id="choose-authenticator" href="/totp-entry">Duplicate</a>'),
        '/follow-sensitive': methodChoice('/totp-entry', '<input type="password">'),
        '/follow-captcha': methodChoice('/totp-entry', '<div id="captcha">Manual verification</div>'),
      };
      res.end(variants[req.url]); return;
    }
    res.end(req.headers.cookie?.includes('auth_fixture=') ? '<!doctype html><h1 id="account">Synthetic account</h1>' : `<!doctype html><form id="password-form" method="post" action="${req.url === '/unsafe' ? 'https://evil.example.test/' : '/password' + (req.url.includes('segmented') ? '?segmented' : req.url === '/with-follow' ? '?follow' : '')}"><input id="login" name="login"><input id="password" name="password" type="password">${req.url === '/ambiguous' ? '<input id="password" type="password">' : ''}<button id="submit-password">Continue</button></form>`);
  });
  const ownedServer=ownFixtureHttpServer(server,t.signal);await ownedServer.listen();
  const origin = `http://127.0.0.1:${server.address().port}`, def = definition(origin), store = memoryStore(def); store.directory = directory;
  let activeStore = store, activeDef = def;
  const companyId = randomUUID(), memberId = randomUUID(), mailAccountId = randomUUID();
  const make = () => new ExtensionVisualBrowser({ dependencies, store: activeStore, authentication: activeDef, testDiagnostics:record,
    mailIdentity: { origin: 'https://trelio.ru', companyId, memberId, scope: 'd'.repeat(64) },
    policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], lease: { deadlineAt: Date.now() + 150000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1' });
  let browser = make();
  // A timed-out fixture must stop only its own live browser handle, rather
  // than leave it running into the next native test. The original timeout
  // remains a failure; this neither repeats an action nor hides its evidence.
  const abortOwned=()=>browser.abort();t.signal.addEventListener('abort',abortOwned,{once:true});
  try {
    assert.equal((await browser.call('navigate', { url: origin })).reason, 'manual_control_active');
    assert.equal((await browser.call('screenshot')).reason, 'manual_control_active');
    assert.equal((await browser.call('authenticate', { password: 'forbidden' })).reason, 'invalid_input');
    phase='first_auth';const result = await browser.call('authenticate'); assert.equal(result.state, 'saved_unverified', result.reason);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|GEZDGNBV/);
    assert.equal((await browser.call('screenshot')).state, 'ready');
    phase='session_reuse';await browser.close(); browser = make();
    assert.equal((await browser.call('navigate', { url: origin })).state, 'ready');
    assert.equal((await browser.call('authenticate')).state, 'saved_unverified');
    assert.equal(passwordSubmits, 1); assert.equal(codeSubmits, 1);
    await browser.close();
    phase='segmented_totp';const segmented = recipe(origin); segmented.steps[1].fields.totp = Array.from({ length: 6 }, (_, i) => `#d${i}`); segmented.steps[1].submit = null;
    activeDef = normalizeVisualAuthentication(segmented, { origins: [origin], fixtureOnly: true }); activeStore = memoryStore(activeDef); activeStore.directory = directory; browser = make();
    await browser.call('navigate', { url: `${origin}/segmented` });
    assert.equal((await browser.call('authenticate')).state, 'saved_unverified');
    assert.equal(passwordSubmits, 2); assert.equal(codeSubmits, 2, 'auto-submit OTP has no additional click/submission');
    await browser.close();
    phase='follow_transition';activeDef = withTransition(origin); activeStore = memoryStore(activeDef); activeStore.directory = directory; browser = make();
    await browser.call('navigate', { url: `${origin}/with-follow` });
    const followedAuthentication = await browser.call('authenticate');
    // Keep the original success requirement. A closed native reason and exact
    // effect counters locate a failed transition without printing credentials,
    // URLs, browser state or private provider output into the hosted log.
    assert.equal(followedAuthentication.state, 'saved_unverified', JSON.stringify({
      reason: followedAuthentication.reason, passwordSubmits, methodFollows, codeSubmits,
    }));
    assert.equal(passwordSubmits, 3); assert.equal(methodFollows, 1); assert.equal(codeSubmits, 3);
    await browser.close();
    phase='unsafe_transition_loop';for (const [selectedVariant,route] of [['foreign_origin','/follow-unsafe'],['wrong_path','/follow-path'],
      ['popup','/follow-popup'],['download','/follow-download'],['hidden','/follow-hidden'],['ambiguous','/follow-ambiguous'],
      ['sensitive','/follow-sensitive'],['captcha','/follow-captcha']]) {
      variant=selectedVariant;activeStore = memoryStore(activeDef); activeStore.directory = directory; browser = make();
      action='navigate';observe(await browser.call('navigate', { url: origin + route }));
      action='authenticate';assert.equal(observe(await browser.call('authenticate')).state, 'manual_input_required', route);
      action='screenshot';assert.equal(observe(await browser.call('screenshot')).reason, 'manual_control_active');
      action='counters';assert.equal(methodFollows, 1, 'an unsafe/ambiguous transition never follows its link');
      assert.equal(passwordSubmits, 3); assert.equal(codeSubmits, 3);
      action='close';await browser.close();
    }
    variant='none';action='none';
    await browser.close(); activeDef = def;
    phase='manual_form_loop';for (const route of ['/unsafe', '/ambiguous', '/sms']) {
      activeStore = memoryStore(def); activeStore.directory = directory; browser = make();
      await browser.call('navigate', { url: origin + route });
      assert.equal((await browser.call('authenticate')).state, 'manual_input_required');
      assert.equal((await browser.call('screenshot')).reason, 'manual_control_active');
      assert.equal(passwordSubmits, 3); assert.equal(codeSubmits, 3, 'untrusted form/SMS never receives stored credentials or TOTP');
      await browser.close();
    }
    phase='mail_factor';const mail = recipe(origin);
    mail.steps[1].factor = 'totp';
    mail.steps.push({ id: 'choose-email', origin, challenge: '#method-choice', factor: 'email',
      action: 'follow', target: '#choose-email', path: '/mail-entry' },
    { id: 'email-code', origin, factor: 'email', challenge: '#email-form',
      fields: { emailOtp: '#mail-code' }, submit: '#submit-email',
      mail: { skillId: 'mail-fixture', sender: 'login@example.test', subjectIncludes: 'Sign in', bodyIncludes: 'Example account', digits: 6 } });
    mail.success = [{ origin, selector: '#mail-account' }];
    mail.credentialCompatibility = { previousRecipes: [def] };
    activeDef = normalizeVisualAuthentication(mail, { origins: [origin], fixtureOnly: true });
    activeStore = memoryStore(def); activeStore.directory = directory; browser = make();
    assert.equal((await browser.call('credentials-status')).state, 'saved_unverified');
    assert.equal(activeStore.saved.schemaVersion, 1, 'status must not migrate the record');
    await browser.call('navigate', { url: `${origin}/mail-start` });
    await browser.call('authenticate-mail', { mailAccountId });
    let status;
    const until = Date.now() + 10000;
    do { status = await browser.call('status'); if (status.kind === 'trelio.browser-mail-request/v1') break; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < until);
    assert.equal(status.kind, 'trelio.browser-mail-request/v1');
    assert.doesNotMatch(JSON.stringify(status), /123456|SYNTHETIC|example\.test/);
    assert.equal((await browser.call('screenshot')).kind, status.kind, 'pending auth never exposes the OTP form');
    const actor = { origin: 'https://trelio.ru', companyId, memberId, accountId: mailAccountId, skillId: 'mail-fixture' };
    await assert.rejects(browser.mailCall({ operation: 'prepare', handle: status.handle, actor: { ...actor, accountId: randomUUID() } }));
    assert.equal((await browser.mailCall({ operation: 'prepare', handle: status.handle, actor })).sender, 'login@example.test');
    const reference = { scope: 'a'.repeat(64), uidValidity: 10, uid: 21, revision: 'b'.repeat(64), originalSha256: 'c'.repeat(64) };
    await browser.mailCall({ operation: 'begin', handle: status.handle, actor,
      payload: { scope: reference.scope, uidValidity: reference.uidValidity, lastUid: reference.uid - 1 } });
    const complete = await browser.mailCall({ operation: 'deliver', handle: status.handle, actor,
      payload: { code: '123456', reference } });
    assert.equal(complete.authenticated, true); assert.equal(mailSubmits, 1);
    // ACK happens in a later mail process, after authentication has released
    // its short mailbox lock. That normal cleanup must not revoke read-back
    // or the one authorized flag write under the still-active browser lease.
    phase='mail_ack';await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await browser.mailCall({ operation: 'claim-ack', handle: status.handle, actor, payload: reference })).action, 'mark_seen_once');
    assert.equal((await browser.mailCall({ operation: 'claim-ack', handle: status.handle, actor, payload: reference })).action, 'verify_only');
    assert.equal((await browser.mailCall({ operation: 'record-ack', handle: status.handle, actor,
      payload: { seenVerified: true, writeAttempted: true } })).acknowledgement, 'complete');
    assert.equal(activeStore.saved.password, 'SYNTHETIC_PASSWORD', 'late mail ACK preserves the encrypted credential bundle');
    assert.equal(activeStore.saved.schemaVersion, 2, 'legacy credentials migrate during the same native email attempt');
    assert.equal(activeStore.saved.attempt.mail.acknowledgement, 'complete');
    await assert.rejects(browser.mailCall({ operation: 'deliver', handle: status.handle, actor,
      payload: { code: '123456', reference } }));
    assert.equal(mailSubmits, 1);
  } catch(error) {primaryFailure=error;diagnose();throw error;} finally {
    phase='final_close';
    // A failed body must preserve its original assertion, not wait behind the
    // same browser queue which just failed. Abort only this owned test browser;
    // cancel its failed producer before waiting for the separate HTTP listener.
    // The listener also has its own independent abort path.
    let cleanupFailed=false;
    if(primaryFailure||t.signal.aborted)try{browser.abort();}catch{cleanupFailed=true;}
    try { await ownedServer.stop(); } catch { cleanupFailed=true; }
    try {
      if(!primaryFailure&&!t.signal.aborted)await browser.close().catch(() => browser.abort());
      // A failed sharing-boundary profile is retained, not recursively retried
      // inside finally. Native failure must reach TAP under its original
      // deadline; only a successful scenario asserts full profile disposal.
      if(!primaryFailure&&!t.signal.aborted)await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch { cleanupFailed=true; } finally {
      t.signal.removeEventListener('abort',diagnose);t.signal.removeEventListener('abort',abortOwned);
    }
    // The primary native assertion is the useful failure. A cleanup problem
    // may fail a successful body, but never replace that original evidence.
    if(cleanupFailed&&!primaryFailure)throw new Error('synthetic_visual_auth_cleanup_failed');
  }
});

test('detached authentication uses the same account vault, pins the recipe and exposes no credentials in its owner file', { skip: process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 180000 }, async () => {
  const { AsyncEntry } = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-auth-worker-')));
  const server = http.createServer(async (req, res) => {
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    res.setHeader('Content-Type', 'text/html');
    if (req.method === 'POST') {
      const body = new URLSearchParams(Buffer.concat(bytes).toString()); assert.equal(body.get('password'), 'SYNTHETIC_PASSWORD');
      res.end('<!doctype html><h1 id="account">Synthetic ready account</h1>');
    } else res.end('<!doctype html><form id="password-form" action="/login" method="post"><input id="login" name="login"><input id="password" name="password" type="password"><button id="submit-password">Continue</button></form>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, legacy = definition(origin), def = compatibleDefinition(origin), start = Date.now();
  const accountId = randomUUID(), companyId = randomUUID(), memberId = randomUUID();
  const env = { TRELIO_ORIGIN: 'https://example.test', TRELIO_SKILL_ID: 'synthetic-visual-auth', TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: accountId }), TRELIO_SKILL_COMPANY_ID: companyId, TRELIO_SKILL_MEMBER_ID: memberId, TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({ apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 150000 }), TRELIO_BROWSER_SESSION_STARTED_AT: String(start), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(start + 150000) };
  const scope = visualStorageScope({ origin: 'https://example.test', skillId: env.TRELIO_SKILL_ID, accountId });
  const store = new ProtectedVisualStore({ directory, scope, AsyncEntry });
  const call = (operation, args = {}, authentication = def) => runVisualSession({ origins: [origin], authentication, operation, args, env, fixture: { directory } });
  const untilClosed = async () => {
    for (let i = 0; i < 200; i++) {
      if (!await fs.stat(path.join(store.directory, 'active')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('owned worker cleanup deadline');
  };
  const diagnostic = () => fs.readFile(path.join(directory, 'fixture-diagnostic.json'), 'utf8').catch(() => 'unavailable');
  let failure;
  try {
    await store.writeCredentials(credential(legacy)); store.close();
    assert.equal((await call('navigate', { url: origin })).state, 'preparing');
    let status;
    for (let i = 0; i < 100; i++) {
      status = await call('status'); if (status.state !== 'preparing') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(status.state, 'saved_unverified', JSON.stringify({reason:status.reason,diagnostic:await diagnostic()}));
    const changed = recipe(origin); changed.steps[0].fields.password = '#different-password';
    assert.equal((await call('authenticate', {}, changed)).reason, 'observation_mode_mismatch');
    assert.equal((await call('authenticate')).state, 'saved_unverified');
    const owner = await fs.readFile(path.join(store.directory, 'active', 'owner.json'), 'utf8');
    // Do not let a failed assertion print owner.json: even this synthetic
    // worker descriptor contains the private loopback control bearer.
    assert.equal(/SYNTHETIC_PASSWORD|SYNTHETIC_LOGIN|GEZDGNBV/u.test(owner), false, 'owner metadata contains no credential values');
    assert.equal((await call('screenshot')).state, 'ready');
    await call('close'); await untilClosed();
    assert.equal((await store.readCredentials()).attempt.state, 'complete');
    assert.equal((await store.readCredentials()).schemaVersion, 2, 'detached worker upgrades the real encrypted record without another form');
  } catch(error) { failure=error; }
  finally {
    let stopped=false,evidence='';
    try {
      await call('close'); await untilClosed(); stopped=true; await store.remove();
    } catch(error) {
      // Preserve the FIRST native authentication assertion. Cleanup is not
      // permission to erase an active profile, kill a disk PID or hide that
      // error behind an untilClosed timeout. Same bounded cleanup budget.
      failure ||= error;
    } finally {
      store.close();
      server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
      if(failure)evidence=await diagnostic();
      if(stopped)await fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    }
    if(failure){
      // The fixture writer accepts closed stages/counts only, never the
      // credential bundle, owner descriptor, browser content or native stderr.
      failure.message+=`; synthetic authentication worker evidence: ${evidence}`;
      throw failure;
    }
  }
});
