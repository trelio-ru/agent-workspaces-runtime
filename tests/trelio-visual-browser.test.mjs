import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualOriginPolicy } from '../host-runtime/scripts/trelio-visual-browser.mjs';
import { ExtensionVisualBrowser, visualExtensionManifest, visualNativeLogEvidence, waitVisualBrowserStopped } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('stopped browser joins native stdio closure after main exit without extending its stop deadline', { timeout: 5000 }, async () => {
  // Exercise the actual native pipe on every OS. Windows can deliver 'close'
  // in the same event-loop batch as 'exit'; a POSIX descendant's delayed pipe
  // inheritance is not a portable assertion about Windows process lifetime.
  const child = spawn(process.execPath, ['-e', "process.stderr.write('SYNTHETIC_NATIVE_PIPE');"], { stdio: ['ignore', 'ignore', 'pipe'], env: {} });
  child.stderr.resume();
  let closed = false;
  child.once('close', () => { closed = true; });
  try {
    const [code] = await once(child, 'exit'); assert.equal(code, 0);
    const deadline = Date.now() + 2500;
    await waitVisualBrowserStopped(child, () => closed, deadline);
    assert.equal(closed, true); assert.ok(Date.now() < deadline);
    // Control only the close observation for the separate ordering invariant.
    // Even an already-exited child must not permit profile I/O while that
    // boundary is still pending. This does not weaken the real browser tests.
    let observed = false, settled = false;
    const pending = waitVisualBrowserStopped(child, () => observed, deadline).then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    observed = true; await pending; assert.equal(settled, true);
    await assert.rejects(waitVisualBrowserStopped(child, () => false, Date.now()), { code: 'operation_failed' });
  } finally { child.stderr.destroy(); if (child.exitCode === null) child.kill(); }
});

test('extension transport has an exact loopback CSP without expanding page navigation or content injection', () => {
  const matches = ['https://example.test/*'], manifest = visualExtensionManifest(matches, 23145);
  assert.deepEqual(manifest.host_permissions, [...matches, 'http://127.0.0.1/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, matches);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:23145");
  assert.throws(() => visualExtensionManifest(matches, '23145'), { code: 'invalid_input' });
  const counts = visualNativeLogEvidence('[1:ERROR:os_crypt_win.cc:3] PRIVATE_COOKIE\n[2:ERROR:sqlite.cc:5] PRIVATE_PATH\n[3:INFO:cookie.cc:1] PRIVATE_TOKEN');
  assert.deepEqual(counts, { osCryptErrors: 1, cookieErrors: 0, sqliteErrors: 1, networkSandboxErrors: 0 });
  assert.equal(JSON.stringify(counts).includes('PRIVATE'), false);
});

test('origin policy rejects source resources, credentials, schemes and sibling origins', () => {
  const policy = createVisualOriginPolicy({ origins: ['https://example.test'] });
  assert.equal(policy.navigate('https://example.test/listing/123'), 'https://example.test/listing/123');
  for (const url of ['view-source:https://example.test', 'file:///private/data', 'https://user:secret@example.test', 'https://example.test/app%2Ejs', 'https://example.test/app.json', 'https://other.test']) assert.throws(() => policy.navigate(url), { code: 'navigation_blocked' });
  assert.equal(policy.allowsCookie('.example.test'), true);
  assert.equal(policy.allowsCookie('.other.test'), false);
});

test('native storage failure precedes browser I/O and remains visible in status', async () => {
  const browser = new ExtensionVisualBrowser({ origins: ['https://example.test'], dependencies: {}, store: {
    async read() { throw Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), { code: 'VISUAL_STORAGE_UNAVAILABLE' }); }, close() {},
  }, policy: createVisualOriginPolicy({ origins: ['https://example.test'] }), lease: { deadlineAt: Date.now() + 60_000 } });
  try {
    assert.equal((await browser.call('setup', { url: 'https://example.test' })).reason, 'storage_unavailable');
    const status = await browser.call('status');
    assert.equal(status.state, 'error'); assert.equal(status.reason, 'storage_unavailable');
    assert.doesNotMatch(JSON.stringify(status), /SYNTHETIC_PRIVATE_DETAIL/);
  } finally { await browser.close(); }
});

test('invalid private auth state cannot launch Chromium, echo credentials or overwrite the previous encrypted state', async () => {
  let writes = 0;
  const browser = new ExtensionVisualBrowser({ origins: ['https://example.test'], dependencies: {}, store: {
    async read() { return { schemaVersion: 2, profile: 'unused', sessionCookies: [{ value: 'SYNTHETIC_PRIVATE_AUTH', domain: '.other.test' }] }; },
    async write() { writes++; }, close() {},
  }, policy: createVisualOriginPolicy({ origins: ['https://example.test'] }), lease: { deadlineAt: Date.now() + 60_000 } });
  try {
    const status = await browser.call('setup', { url: 'https://example.test' });
    assert.equal(status.state, 'error'); assert.equal(status.reason, 'storage_unavailable');
    assert.equal(JSON.stringify(status).includes('SYNTHETIC_PRIVATE_AUTH'), false); assert.equal(writes, 0);
  } finally { await browser.close(); }
});

test('public visual API rejects private transport commands and extra fields before storage or browser I/O', async () => {
  let reads = 0;
  const browser = new ExtensionVisualBrowser({ origins: ['https://example.test'], dependencies: {}, store: { async read() { reads++; }, close() {} }, policy: createVisualOriginPolicy({ origins: ['https://example.test'] }), lease: { deadlineAt: Date.now() + 60_000 } });
  try {
    for (const operation of ['evaluate', 'manual', 'heartbeat', 'close-windows', 'fixture-close-windows', 'restore-session-auth', 'snapshot-session-auth', 'Runtime.evaluate']) assert.equal((await browser.call(operation)).reason, 'invalid_input');
    assert.equal((await browser.call('status', { script: 'not-executed' })).reason, 'invalid_input');
    assert.equal((await browser.call('click', { frameId: 'x', x: 1, y: 1, selector: '#unsafe' })).reason, 'invalid_input');
    assert.equal(reads, 0);
  } finally { await browser.close(); }
});

test('lease expiry during native preparation prevents a late browser launch', { timeout: 2000 }, async () => {
  let resume, closed = false;
  const browser = new ExtensionVisualBrowser({ origins: ['https://example.test'], dependencies: {},
    store: { async read() { await new Promise(resolve => { resume = resolve; }); return null; }, close() { closed = true; } },
    policy: createVisualOriginPolicy({ origins: ['https://example.test'] }), lease: { deadlineAt: Date.now() + 40 } });
  const starting = browser.call('setup', { url: 'https://example.test' });
  await new Promise(resolve => setTimeout(resolve, 80)); resume();
  assert.equal((await starting).reason, 'lease_expired');
  for (let i = 0; i < 10 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true);
});
