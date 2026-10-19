import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualExtensionWorker } from '../host-runtime/scripts/trelio-visual-extension-worker.mjs';

test('extension installs literal origin guards before bootstrap and never navigates an adversarial sibling', async () => {
  let rules, socket; const sent = [], events = { addListener() {} };
  const context = {
    URL, Date, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events },
      webRequest: { onBeforeRequest: events, onHeadersReceived: events },
      windows: { onRemoved: events, async getAll() { assert.ok(rules, 'navigation policy precedes window discovery'); return [{ id: 1 }]; } },
      declarativeNetRequest: { async getDynamicRules() { return []; }, async updateDynamicRules(value) { rules = value.addRules; } },
    },
    WebSocket: class {
      static OPEN = 1;
      constructor() { socket = this; this.readyState = 1; }
      send(value) { sent.push(JSON.parse(value)); }
    },
  };
  const config = { origins: ['https://www.example.test'], domains: ['example.test'], matches: ['https://*.example.test/*'], endpoint: 'ws://127.0.0.1/fixture', token: 'synthetic', deadlineAt: Date.now() + 10_000 };
  vm.runInNewContext(`(${visualExtensionWorker.toString()})(${JSON.stringify(config)});`, context);
  await new Promise(resolve => setImmediate(resolve));
  const allows = url => rules.some(rule => rule.action.type === 'allow' && new RegExp(rule.condition.regexFilter).test(url));
  assert.equal(allows('https://www.example.test/detail'), true);
  for (const url of ['https://wwwXexampleXtest/detail', 'https://example.test.evil.com/detail', 'https://evilexample.test/detail', 'https://example.test:444/detail']) assert.equal(allows(url), false, url);
  socket.onmessage({ data: JSON.stringify({ id: 'one', operation: 'navigate', args: { url: 'https://example.test.evil.com/' } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-1).result.reason, 'navigation_blocked');
});
