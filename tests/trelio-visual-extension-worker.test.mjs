import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualExtensionWorker } from '../host-runtime/scripts/trelio-visual-extension-worker.mjs';

test('extension installs literal origin guards before bootstrap and never navigates an adversarial sibling', async () => {
  let rules, socket; const sent = [], events = { addListener() {} };
  const context = {
    URL, Date, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events, onEvent: events },
      webRequest: { onBeforeRequest: events, onHeadersReceived: events },
      windows: { onRemoved: events, async getAll() { assert.ok(rules, 'navigation policy precedes window discovery'); return [{ id: 1 }]; } },
      tabs: { async query() { assert.ok(rules); return [{ id: 1, url: 'about:blank' }]; }, async update(_id, value) { assert.equal(value.url, 'https://www.example.test/'); } },
      declarativeNetRequest: { async getDynamicRules() { return []; }, async updateDynamicRules(value) { rules = value.addRules; } },
    },
    WebSocket: class {
      static OPEN = 1;
      constructor() { socket = this; this.readyState = 1; }
      send(value) { sent.push(JSON.parse(value)); }
    },
  };
  const config = { origins: ['https://www.example.test'], domains: ['example.test'], matches: ['https://*.example.test/*'], initialUrl: 'https://www.example.test/', endpoint: 'ws://127.0.0.1/fixture', token: 'synthetic', deadlineAt: Date.now() + 10_000 };
  vm.runInNewContext(`(${visualExtensionWorker.toString()})(${JSON.stringify(config)});`, context);
  await new Promise(resolve => setImmediate(resolve));
  socket.onopen();
  assert.equal(sent.at(-1).kind, 'hello');
  const allows = url => rules.some(rule => rule.action.type === 'allow' && new RegExp(rule.condition.regexFilter).test(url));
  assert.equal(allows('https://www.example.test/detail'), true);
  for (const url of ['https://wwwXexampleXtest/detail', 'https://example.test.evil.com/detail', 'https://evilexample.test/detail', 'https://example.test:444/detail']) assert.equal(allows(url), false, url);
  socket.onmessage({ data: JSON.stringify({ id: 'one', operation: 'navigate', args: { url: 'https://example.test.evil.com/' } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-1).result.reason, 'navigation_blocked');
});

test('bootstrap reports only a closed policy failure before accepting input', async () => {
  const sent = [], events = { addListener() {} }; let socket;
  const context = { URL, Date, setTimeout, clearTimeout, chrome: {
    runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events, onEvent: events },
    webRequest: { onBeforeRequest: events, onHeadersReceived: events }, windows: { onRemoved: events },
    declarativeNetRequest: { async getDynamicRules() { throw Error('PRIVATE native detail'); } },
  }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } } };
  vm.runInNewContext(`(${visualExtensionWorker.toString()})(${JSON.stringify({ endpoint: 'ws://127.0.0.1/', token: 'synthetic', matches: [], origins: [], domains: [], deadlineAt: Date.now() + 10_000 })});`, context);
  await new Promise(resolve => setImmediate(resolve)); socket.onopen();
  assert.deepEqual(sent.at(-1), { kind: 'bootstrap_failed', stage: 'policy' });
  socket.onmessage({ data: JSON.stringify({ id: 'ignored', operation: 'screenshot' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 2, 'failed bootstrap sends only its repeated closed readiness, never input output');
  assert.equal(JSON.stringify(sent).includes('PRIVATE'), false);
});
