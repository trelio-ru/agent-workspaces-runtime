import { createBrowserRequestPacing } from '../host-runtime/scripts/trelio-browser-request-pacing.mjs';
import { createBrowserTabBudget } from '../host-runtime/scripts/trelio-browser-tab-budget.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualExtensionWorker } from '../host-runtime/scripts/trelio-visual-extension-worker.mjs';
import { visualCookieState } from '../host-runtime/scripts/trelio-visual-cookie-state.mjs';
const startWorker = (config, context) => vm.runInNewContext(`(${visualExtensionWorker.toString()})(${JSON.stringify(config)}, (${visualCookieState.toString()})(${JSON.stringify(config)}), ${createBrowserRequestPacing.toString()}, ${createBrowserTabBudget.toString()});`, context);

test('extension installs literal origin guards before bootstrap and never navigates an adversarial sibling', async () => {
  let rules, socket; const sent = [], events = { addListener() {} };
  const context = {
    URL, Date, TextEncoder, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events, onEvent: events },
      webRequest: { onBeforeRequest: events, onHeadersReceived: events },
      windows: { onCreated: events, onRemoved: events, async getAll() { assert.ok(rules, 'navigation policy precedes window discovery'); return [{ id: 1 }]; } },
      tabs: { onCreated: events, onRemoved: events, async query() { assert.ok(rules); return [{ id: 1, url: 'about:blank' }]; }, async update(_id, value) { assert.equal(value.url, 'https://www.example.test/'); } },
      cookies: { onChanged: events, async getAll() { return []; }, async set() { throw Error('unexpected_cookie_restore'); } },
      declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules(value) { rules = value.addRules; } },
    },
    WebSocket: class {
      static OPEN = 1;
      constructor() { socket = this; this.readyState = 1; }
      send(value) { sent.push(JSON.parse(value)); }
    },
  };
  const config = { origins: ['https://www.example.test'], domains: ['example.test'], matches: ['https://*.example.test/*'], initialUrl: 'https://www.example.test/', endpoint: 'ws://127.0.0.1/fixture', token: 'synthetic', deadlineAt: Date.now() + 10_000 };
  startWorker(config, context);
  await new Promise(resolve => setImmediate(resolve));
  socket.onopen();
  assert.equal(sent.at(-1).kind, 'auth_required');
  socket.onmessage({ data: JSON.stringify({ id: 'bootstrap', operation: 'restore-session-auth', args: { cookies: [], replace: false } }) });
  await new Promise(resolve => setImmediate(resolve));
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
  const context = { URL, Date, TextEncoder, setTimeout, clearTimeout, chrome: {
    runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events, onEvent: events },
    webRequest: { onBeforeRequest: events, onHeadersReceived: events }, windows: { onCreated: events, onRemoved: events },
    tabs: { onCreated: events, onRemoved: events }, cookies: { onChanged: events },
    declarativeNetRequest: { async getSessionRules() { throw Error('PRIVATE native detail'); } },
  }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } } };
  startWorker({ endpoint: 'ws://127.0.0.1/', token: 'synthetic', matches: [], origins: [], domains: [], deadlineAt: Date.now() + 10_000 }, context);
  await new Promise(resolve => setImmediate(resolve)); socket.onopen();
  assert.deepEqual(sent.at(-1), { kind: 'bootstrap_failed', stage: 'policy_read' });
  socket.onmessage({ data: JSON.stringify({ id: 'ignored', operation: 'screenshot' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 2, 'failed bootstrap sends only its repeated closed readiness, never input output');
  assert.equal(JSON.stringify(sent).includes('PRIVATE'), false);
});

test('private auth observes logout but freezes before last-window cleanup and never enters a screenshot result', async () => {
  const events = { addListener() {} }, sent = [];
  const cookie = { name: 'fixture_session', value: 'SYNTHETIC_PRIVATE_AUTH', domain: 'example.test', path: '/', hostOnly: true, httpOnly: true, secure: true, sameSite: 'strict', session: true, storeId: '0' };
  let socket, cookieChanged, tabRemoved, windowRemoved, windowCreated, live = [cookie], windows = [{ id: 1 }];
  const context = { URL, Date, TextEncoder, setTimeout, clearTimeout, chrome: {
    runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events, onEvent: events },
    webRequest: { onBeforeRequest: events, onHeadersReceived: events },
    declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules() {} },
    windows: { onCreated: { addListener(fn) { windowCreated = fn; } }, onRemoved: { addListener(fn) { windowRemoved = fn; } }, async getAll() { assert.ok(windows.length, 'no async window API after final profile close'); return windows; } },
    tabs: { onCreated: events, onRemoved: { addListener(fn) { tabRemoved = fn; } }, async query() { return [{ id: 1, url: 'about:blank' }]; }, async update() { return { id: 1, status: 'complete' }; } },
    cookies: { onChanged: { addListener(fn) { cookieChanged = fn; } }, async getAll() { return live; }, async set() { throw Error('unexpected_restore'); } },
  }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } } };
  startWorker({ origins: ['https://example.test'], domains: [], matches: ['https://example.test/*'], initialUrl: 'https://example.test/', manual: true, endpoint: 'ws://127.0.0.1/', token: 'synthetic', deadlineAt: Date.now() + 10_000 }, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); socket.onopen();
  let sequence = 0;
  const dispatch = async (operation, args = {}) => {
    const id = String(++sequence); socket.onmessage({ data: JSON.stringify({ id, operation, args }) });
    for (let i = 0; i < 20; i++) { await tick(); const value = sent.find(message => message.kind === 'result' && message.id === id); if (value) return value.result; }
    throw Error('fixture_command_did_not_complete');
  };
  await dispatch('restore-session-auth', { cookies: [], replace: false }); await tick();
  assert.equal(sent.some(message => message.kind === 'hello'), true);
  live = []; cookieChanged({ removed: true, cause: 'explicit', cookie });
  assert.deepEqual((await dispatch('snapshot-session-auth')).cookies, [], 'logout in an open window removes the private saved token');
  live = [cookie]; cookieChanged({ removed: false, cause: 'explicit', cookie });
  assert.equal((await dispatch('snapshot-session-auth')).cookies.length, 1);
  windowCreated({ id: 2, type: 'popup' });
  tabRemoved(1, { isWindowClosing: true, windowId: 1 });
  windows = [{ id: 2 }]; windowRemoved(1);
  live = []; cookieChanged({ removed: true, cause: 'explicit', cookie });
  assert.deepEqual((await dispatch('snapshot-session-auth')).cookies, [], 'an auth popup keeps the user session live after its normal window closes');
  live = [cookie]; cookieChanged({ removed: false, cause: 'explicit', cookie });
  tabRemoved(2, { isWindowClosing: true, windowId: 2 });
  live = []; cookieChanged({ removed: true, cause: 'explicit', cookie });
  windows = []; windowRemoved(2); await tick();
  assert.equal((await dispatch('snapshot-session-auth')).cookies.length, 1, 'browser profile-end cleanup cannot erase a completed manual login');
  const screenshot = await dispatch('screenshot');
  assert.equal(screenshot.reason, 'manual_control_active');
  assert.equal(JSON.stringify(screenshot).includes('SYNTHETIC_PRIVATE_AUTH'), false);
});

test('lease expiry during private cookie restore cannot open a late provider window', async () => {
  const events = { addListener() {} }, sent = [];
  let socket, finishSet, now = 1000, navigations = 0;
  // Delay the actual Cookie API acknowledgement, rather than a public call.
  // An expired host lease must still block the continuation after that await.
  const context = { URL, Date: class extends Date { static now() { return now; } }, TextEncoder, setTimeout, clearTimeout, chrome: {
    runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events, onEvent: events },
    webRequest: { onBeforeRequest: events, onHeadersReceived: events },
    declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules() {} },
    windows: { onCreated: events, onRemoved: events, async getAll() { return []; }, async create() { navigations++; } },
    tabs: { onCreated: events, onRemoved: events, async query() { return []; }, async create() { navigations++; } },
    cookies: { onChanged: events, async getAll() { return []; }, set() { return new Promise(resolve => { finishSet = resolve; }); } },
  }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } } };
  startWorker({ origins: ['https://example.test'], domains: [], matches: ['https://example.test/*'], initialUrl: 'https://example.test/', endpoint: 'ws://127.0.0.1/', token: 'synthetic', deadlineAt: 2000 }, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); socket.onopen();
  const cookie = { name: 'fixture', value: 'SYNTHETIC_PRIVATE', domain: 'example.test', path: '/', hostOnly: true, httpOnly: true, secure: true, sameSite: 'strict' };
  socket.onmessage({ data: JSON.stringify({ id: 'restore', operation: 'restore-session-auth', args: { cookies: [cookie], replace: false } }) });
  await tick(); assert.equal(typeof finishSet, 'function');
  now = 2001; finishSet({}); await tick(); await tick();
  assert.equal(navigations, 0);
  assert.equal(sent.some(message => message.kind === 'hello'), false);
  assert.equal(sent.some(message => message.kind === 'bootstrap_failed' && message.stage === 'auth'), true);
  assert.equal(JSON.stringify(sent).includes('SYNTHETIC_PRIVATE'), false);
});
