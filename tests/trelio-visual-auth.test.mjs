import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeVisualAuthentication, visualAuthenticationFingerprint, configureVisualAuthentication, authenticateVisualBrowser } from '../host-runtime/scripts/trelio-visual-session.mjs';
import { ProtectedVisualStore, visualStorageScope } from '../host-runtime/scripts/trelio-visual-store.mjs';
import { deriveAgentSecretTotp } from '../host-runtime/scripts/trelio-workspace.mjs';
import { ExtensionVisualBrowser } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';
import { createVisualOriginPolicy } from '../host-runtime/scripts/trelio-visual-browser.mjs';
import { loadVisualDependencies } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { runVisualSession } from '../host-runtime/scripts/trelio-visual-session.mjs';

const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC 6238 synthetic vector only.
const recipe = origin => ({ steps: [
  { id: 'password', origin, challenge: '#password-form', fields: { login: '#login', password: '#password' }, submit: '#submit-password' },
  { id: 'totp', origin, challenge: '#totp-form', fields: { totp: '#totp' }, submit: '#submit-totp' },
], success: [{ origin, selector: '#account' }] });
const definition = origin => normalizeVisualAuthentication(recipe(origin), { origins: [origin], fixtureOnly: origin.startsWith('http://127.0.0.1:') });
const credential = def => ({ schemaVersion: 1, fingerprint: visualAuthenticationFingerprint(def), login: 'SYNTHETIC_LOGIN', password: 'SYNTHETIC_PASSWORD', totp: seed, attempt: null });
function memoryStore(def) {
  let saved = credential(def), snapshot;
  return { async readCredentials() { return structuredClone(saved); }, async writeCredentials(value) { saved = structuredClone(value); }, async read() { return snapshot; }, async prepare() {}, async write(value) { snapshot = structuredClone(value); }, close() {}, get saved() { return structuredClone(saved); } };
}

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
  const def = definition('https://auth.example.test'); let saved, calls = 0;
  const store = { async prepare() {}, async writeCredentials(value) { saved = structuredClone(value); } };
  const openBrowserFn = async raw => {
    calls++; const url = new URL(raw), response = await fetch(url), html = await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(html, /TOTP-секрет/); assert.doesNotMatch(html, new RegExp(seed));
    const fields = { nonce: url.searchParams.get('nonce'), decision: 'save', login: 'SYNTHETIC_LOGIN', password: 'SYNTHETIC_PASSWORD', totp: seed };
    const post = body => fetch(`${url.origin}/credential`, { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    assert.equal((await post({ ...fields, unexpected: 'not allowed' })).status, 400);
    assert.equal(saved, undefined);
    assert.equal((await post(fields)).status, 200);
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

test('native browser performs login and TOTP privately, gates images and reuses saved authenticated state', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-auth-native-')));
  let passwordSubmits = 0, codeSubmits = 0;
  const server = http.createServer(async (req, res) => {
    const body = []; for await (const chunk of req) body.push(chunk);
    const form = new URLSearchParams(Buffer.concat(body).toString());
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/password') && req.method === 'POST') {
      passwordSubmits++; assert.equal(form.get('login'), 'SYNTHETIC_LOGIN'); assert.equal(form.get('password'), 'SYNTHETIC_PASSWORD');
      res.end(req.url.includes('segmented') ? '<!doctype html><form id="totp-form" method="post" action="/code" oninput="if([...this.elements].every(e=>e.value.length===1))this.requestSubmit()">' + Array.from({ length: 6 }, (_, i) => `<input id="d${i}" name="d${i}" maxlength="1" autocomplete="one-time-code">`).join('') + '</form>' : '<!doctype html><form id="totp-form" method="post" action="/code"><input id="totp" name="totp" autocomplete="one-time-code"><button id="submit-totp">Sign in</button></form>'); return;
    }
    if (req.url === '/code' && req.method === 'POST') {
      codeSubmits++; const code = form.get('totp') || Array.from({ length: 6 }, (_, i) => form.get(`d${i}`)).join('');
      assert.ok([Date.now() - 30000, Date.now(), Date.now() + 30000].some(now => code === deriveAgentSecretTotp(seed, now)));
      res.setHeader('Set-Cookie', 'auth_fixture=SYNTHETIC_AUTH; HttpOnly; Path=/; SameSite=Strict'); res.end('<!doctype html><h1 id="account">Synthetic account</h1>'); return;
    }
    if (req.url === '/sms') { res.end('<!doctype html><form id="sms-form" method="post"><input autocomplete="one-time-code"></form>'); return; }
    res.end(req.headers.cookie?.includes('auth_fixture=') ? '<!doctype html><h1 id="account">Synthetic account</h1>' : `<!doctype html><form id="password-form" method="post" action="${req.url === '/unsafe' ? 'https://evil.example.test/' : '/password' + (req.url.includes('segmented') ? '?segmented' : '')}"><input id="login" name="login"><input id="password" name="password" type="password">${req.url === '/ambiguous' ? '<input id="password" type="password">' : ''}<button id="submit-password">Continue</button></form>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, def = definition(origin), store = memoryStore(def); store.directory = directory;
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  let activeStore = store, activeDef = def;
  const make = () => new ExtensionVisualBrowser({ dependencies, store: activeStore, authentication: activeDef, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], lease: { deadlineAt: Date.now() + 150000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1' });
  let browser = make();
  try {
    assert.equal((await browser.call('navigate', { url: origin })).reason, 'manual_control_active');
    assert.equal((await browser.call('screenshot')).reason, 'manual_control_active');
    assert.equal((await browser.call('authenticate', { password: 'forbidden' })).reason, 'invalid_input');
    const result = await browser.call('authenticate'); assert.equal(result.state, 'saved_unverified', result.reason);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|GEZDGNBV/);
    assert.equal((await browser.call('screenshot')).state, 'ready');
    await browser.close(); browser = make();
    assert.equal((await browser.call('navigate', { url: origin })).state, 'ready');
    assert.equal((await browser.call('authenticate')).state, 'saved_unverified');
    assert.equal(passwordSubmits, 1); assert.equal(codeSubmits, 1);
    await browser.close();
    const segmented = recipe(origin); segmented.steps[1].fields.totp = Array.from({ length: 6 }, (_, i) => `#d${i}`); segmented.steps[1].submit = null;
    activeDef = normalizeVisualAuthentication(segmented, { origins: [origin], fixtureOnly: true }); activeStore = memoryStore(activeDef); activeStore.directory = directory; browser = make();
    await browser.call('navigate', { url: `${origin}/segmented` });
    assert.equal((await browser.call('authenticate')).state, 'saved_unverified');
    assert.equal(passwordSubmits, 2); assert.equal(codeSubmits, 2, 'auto-submit OTP has no additional click/submission');
    await browser.close(); activeDef = def;
    for (const route of ['/unsafe', '/ambiguous', '/sms']) {
      activeStore = memoryStore(def); activeStore.directory = directory; browser = make();
      await browser.call('navigate', { url: origin + route });
      assert.equal((await browser.call('authenticate')).state, 'manual_input_required');
      assert.equal((await browser.call('screenshot')).reason, 'manual_control_active');
      assert.equal(passwordSubmits, 2); assert.equal(codeSubmits, 2, 'untrusted form/SMS never receives stored credentials or TOTP');
      await browser.close();
    }
  } finally {
    await browser.close().catch(() => browser.abort()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('detached authentication uses the same account vault, pins the recipe and exposes no credentials in its owner file', { skip: process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 180000 }, async () => {
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
  const origin = `http://127.0.0.1:${server.address().port}`, def = definition(origin), start = Date.now();
  const accountId = randomUUID(), companyId = randomUUID(), memberId = randomUUID();
  const env = { TRELIO_ORIGIN: 'https://example.test', TRELIO_SKILL_ID: 'synthetic-visual-auth', TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: accountId }), TRELIO_SKILL_COMPANY_ID: companyId, TRELIO_SKILL_MEMBER_ID: memberId, TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({ apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 150000 }), TRELIO_BROWSER_SESSION_STARTED_AT: String(start), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(start + 150000) };
  const { AsyncEntry } = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
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
  try {
    await store.writeCredentials(credential(def)); store.close();
    assert.equal((await call('navigate', { url: origin })).state, 'preparing');
    let status;
    for (let i = 0; i < 100; i++) {
      status = await call('status'); if (status.state !== 'preparing') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(status.state, 'saved_unverified', status.reason);
    const changed = recipe(origin); changed.steps[0].fields.password = '#different-password';
    assert.equal((await call('authenticate', {}, changed)).reason, 'observation_mode_mismatch');
    assert.equal((await call('authenticate')).state, 'saved_unverified');
    const owner = await fs.readFile(path.join(store.directory, 'active', 'owner.json'), 'utf8');
    assert.doesNotMatch(owner, /SYNTHETIC_PASSWORD|SYNTHETIC_LOGIN|GEZDGNBV/);
    assert.equal((await call('screenshot')).state, 'ready');
    await call('close'); await untilClosed();
    assert.equal((await store.readCredentials()).attempt.state, 'complete');
  } finally {
    await call('close').catch(() => {}); await untilClosed(); await store.remove();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
