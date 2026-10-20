import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createBrowserTabBudget } from '../host-runtime/scripts/trelio-browser-policy.mjs';
import { createBrowserRequestPacing } from '../host-runtime/scripts/trelio-browser-policy.mjs';
import { visualCookieState } from '../host-runtime/scripts/trelio-visual-cookie-state.mjs';
import { visualExtensionWorker } from '../host-runtime/scripts/trelio-visual-extension-worker.mjs';

test('five tabs over the browser lifetime, not five more after a tab is closed', () => {
  const budget = createBrowserTabBudget();
  for (let id = 1; id <= 5; id++) assert.equal(budget.admit(id), true);
  assert.equal(budget.canCreate, false);
  assert.equal(budget.admit(6), false);
  budget.removed(2);
  assert.equal(budget.admit(2), false, 'a removed target cannot be resurrected by stale inventory');
  assert.equal(budget.admit(7), false, 'closing a tab does not refill the lifetime budget');
  assert.deepEqual(budget.counts, { maximum: 5, opened: 5, open: 4 });
});

test('native extension events remove popup overflow; close removes every owned window', async () => {
  const noop = { addListener() {} }, sent = [], removed = [], closedWindows = [];
  let socket, onCreated, onRemoved;
  const config = { origins: ['https://example.test'], domains: [], matches: ['https://example.test/*'], initialUrl: 'https://example.test/', endpoint: 'ws://127.0.0.1/', token: 'synthetic', deadlineAt: Date.now() + 10000, manual: true };
  const context = { URL, Date, TextEncoder, setTimeout, clearTimeout, chrome: {
    runtime: { id: 'fixture', onMessage: noop }, debugger: { onDetach: noop, onEvent: noop },
    webRequest: { onBeforeRequest: noop, onHeadersReceived: noop },
    cookies: { onChanged: noop, async getAll() { return []; } },
    declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules() {} },
    windows: { onCreated: noop, onRemoved: noop, async getAll() { return [{ id: 1, type: 'normal' }, { id: 2, type: 'popup' }]; }, async remove(id) { closedWindows.push(id); } },
    tabs: { onCreated: { addListener(fn) { onCreated = fn; } }, onRemoved: { addListener(fn) { onRemoved = fn; } },
      async query() { return [{ id: 1, url: 'about:blank' }]; }, async update() { return { id: 1, status: 'complete' }; }, async remove(id) { removed.push(id); onRemoved(id, { windowId: 2, isWindowClosing: false }); } },
  }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } } };
  vm.runInNewContext(`(${visualExtensionWorker.toString()})(${JSON.stringify(config)}, (${visualCookieState.toString()})(${JSON.stringify(config)}), ${createBrowserRequestPacing.toString()}, ${createBrowserTabBudget.toString()});`, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); socket.onopen();
  socket.onmessage({ data: JSON.stringify({ id: 'auth', operation: 'restore-session-auth', args: { cookies: [], replace: false } }) });
  await tick(); await tick();
  assert.equal(sent.some(m => m.kind === 'hello'), true);
  for (let id = 2; id <= 12; id++) onCreated({ id, windowId: 2 });
  await tick(); await tick();
  assert.deepEqual(removed, [6, 7, 8, 9, 10, 11, 12]);
  onRemoved(2, { windowId: 1, isWindowClosing: false }); onCreated({ id: 13, windowId: 2 });
  await tick(); assert.equal(removed.at(-1), 13);
  socket.onmessage({ data: JSON.stringify({ id: 'close', operation: 'close-windows' }) });
  await tick(); await tick();
  assert.deepEqual(closedWindows, [1, 2]);
  assert.equal(sent.find(m => m.id === 'close').result.state, 'closed');
});
