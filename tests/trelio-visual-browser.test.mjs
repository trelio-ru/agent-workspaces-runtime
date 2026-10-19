import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualOriginPolicy } from '../host-runtime/scripts/trelio-visual-browser.mjs';
import { ExtensionVisualBrowser, visualExtensionManifest, visualNativeLogEvidence } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';

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

test('public visual API rejects private transport commands and extra fields before storage or browser I/O', async () => {
  let reads = 0;
  const browser = new ExtensionVisualBrowser({ origins: ['https://example.test'], dependencies: {}, store: { async read() { reads++; }, close() {} }, policy: createVisualOriginPolicy({ origins: ['https://example.test'] }), lease: { deadlineAt: Date.now() + 60_000 } });
  try {
    for (const operation of ['evaluate', 'manual', 'heartbeat', 'close-windows', 'Runtime.evaluate']) assert.equal((await browser.call(operation)).reason, 'invalid_input');
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
