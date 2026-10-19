import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualOriginPolicy } from '../host-runtime/scripts/trelio-visual-browser.mjs';
import { ExtensionVisualBrowser } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';

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
