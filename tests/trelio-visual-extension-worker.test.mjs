import { createBrowserRequestPacing } from '../host-runtime/scripts/trelio-browser-policy.mjs';
import { createBrowserTabBudget } from '../host-runtime/scripts/trelio-browser-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualExtensionWorker, visualDocumentResponsePolicy } from '../host-runtime/scripts/trelio-visual-extension-worker.mjs';
import { visualCookieState } from '../host-runtime/scripts/trelio-visual-cookie-state.mjs';
import { randomUUID } from 'node:crypto';
const startWorker = (config, context) => vm.runInNewContext(`(${visualExtensionWorker.toString()})(${JSON.stringify(config)}, (${visualCookieState.toString()})(${JSON.stringify(config)}), ${createBrowserRequestPacing.toString()}, ${createBrowserTabBudget.toString()}, ${visualDocumentResponsePolicy.toString()});`, context);

test('lost file-selection acknowledgement consumes the original frame and never replays native input', async () => {
  const events = { addListener() {} }, sent = [];
  let socket, nativeEvent, selections = 0, chooserFrame = 'main', currentUrl = 'about:blank';
  const context = { URL, Date, TextEncoder, performance, setTimeout, clearTimeout, crypto: { randomUUID }, chrome: {
    runtime: { id: 'fixture', onMessage: events },
    debugger: { onDetach: events, onEvent: { addListener(fn) { nativeEvent = fn; } }, async attach() {},
      async sendCommand(_source, method, args) {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'original', mimeType: 'text/html', url: currentUrl } } };
        if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 }, cssContentSize: { x: 0, y: 0, width: 800, height: 600 } };
        if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
          queueMicrotask(() => nativeEvent({ tabId: 1 }, 'Page.fileChooserOpened', { frameId: chooserFrame, backendNodeId: 7, mode: 'selectMultiple' }));
        }
        if (method === 'DOM.setFileInputFiles') { selections++; throw Error('PRIVATE_NATIVE_LOST_REPLY'); }
        return {};
      } },
    webRequest: { onBeforeRequest: events, onHeadersReceived: events },
    cookies: { onChanged: events, async getAll() { return []; } },
    declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules() {} },
    windows: { onCreated: events, onRemoved: events, async getAll() { return [{ id: 1 }]; } },
    tabs: { onCreated: events, onRemoved: events,
      async query() { return [{ id: 1, url: currentUrl, status: 'complete' }]; },
      async get() { return { id: 1, url: currentUrl, status: 'complete' }; },
      async update(_id, input) { currentUrl = input.url || currentUrl; return { id: 1, url: currentUrl, status: 'complete' }; },
      async sendMessage(_id, message) { return message.kind === 'authentication-guard' ? { blocked: false } : { text: 'synthetic', controls: [], nextOffset: null, scanLimited: false }; } },
  }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } } };
  const config = { origins: ['https://example.test'], domains: [], matches: ['https://example.test/*'],
    initialUrl: 'https://example.test/', endpoint: 'ws://127.0.0.1/', token: 'synthetic', observationMode: 'text', fileUploads: true, deadlineAt: Date.now() + 10_000 };
  startWorker(config, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); socket.onopen();
  let sequence = 0;
  const dispatch = async (operation, args = {}) => {
    const id = String(++sequence); socket.onmessage({ data: JSON.stringify({ id, operation, args }) });
    for (let i = 0; i < 30; i++) { await tick(); const item = sent.find(value => value.id === id); if (item) return item.result; }
    throw Error('synthetic_command_timeout');
  };
  await dispatch('restore-session-auth', { cookies: [], replace: false });
  const frame = await dispatch('read-text');
  assert.equal(frame.state, 'ready');
  const args = { frameId: frame.frameId, x: 10, y: 20, files: ['/synthetic/private/frozen.bin'] };
  assert.equal((await dispatch('upload-files', args)).reason, 'operation_failed');
  assert.equal(selections, 1);
  assert.equal((await dispatch('upload-files', args)).reason, 'stale_frame');
  nativeEvent({ tabId: 1 }, 'Page.fileChooserOpened', { frameId: 'main', backendNodeId: 7, mode: 'selectMultiple' });
  await tick(); assert.equal(selections, 1, 'unsolicited/late chooser cannot select files');
  chooserFrame = 'foreign-frame';
  const fresh = await dispatch('read-text');
  assert.equal((await dispatch('upload-files', { ...args, frameId: fresh.frameId })).reason, 'upload_control_required');
  assert.equal(selections, 1, 'foreign frame never receives a selection');
  assert.equal(JSON.stringify(sent).includes('PRIVATE_NATIVE_LOST_REPLY'), false);
});

test('one file-menu click routes only a fresh native GET and never queries a paused main frame', async () => {
  const events = { addListener() {} }, sent = [], routed = [], stages = [];
  let socket, nativeEvent, currentUrl = 'about:blank', mode = 'main', paused = false, clicks = 0, reads = 0;
  const context = { URL, Date, TextEncoder, Uint8Array, performance, atob, btoa, setTimeout, clearTimeout,
    crypto: { randomUUID }, chrome: {
      runtime: { id: 'fixture', onMessage: events },
      debugger: { onDetach: events, onEvent: { addListener(fn) { nativeEvent = fn; } }, async attach() {},
        async sendCommand(_source, method, args) {
          if (method === 'Page.getFrameTree') {
            assert.ok(!paused || mode !== 'main', 'native main-frame metadata can wait on the paused GET itself');
            return { frameTree: { frame: { id: 'main', loaderId: 'original', mimeType: 'text/html', url: currentUrl },
              childFrames: [{ frame: { id: 'child' } }] } };
          }
          if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 },
            cssContentSize: { x: 0, y: 0, width: 800, height: 600 } };
          if (method === 'Fetch.enable') stages.push(args.patterns.map(p => p.requestStage).join(','));
          if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
            clicks++; paused = true;
            if (mode === 'navigate') nativeEvent({ tabId: 1 }, 'Page.navigatedWithinDocument', { frameId: 'main' });
            queueMicrotask(() => nativeEvent({ tabId: 1 }, 'Fetch.requestPaused', {
              requestId: 'original-click', frameId: mode === 'iframe' ? 'child' : 'main', resourceType: 'Document',
              request: { method: mode === 'post' ? 'POST' : 'GET', url: mode === 'foreign' ? 'https://foreign.test/original' : 'https://example.test/original' },
            }));
          }
          if (method === 'Fetch.fulfillRequest' || method === 'Fetch.failRequest') {
            paused = false;
            if (method === 'Fetch.fulfillRequest') {
              assert.equal(args.responseCode, 204);
              assert.deepEqual(JSON.parse(JSON.stringify(args.responseHeaders)), [{ name: 'Cache-Control', value: 'no-store' }]);
            }
          }
          if (method === 'Fetch.takeResponseBodyAsStream') { reads++; return { stream: 'synthetic' }; }
          if (method === 'IO.read') return { data: 'AQID', base64Encoded: true, eof: true };
          return {};
        } },
      webRequest: { onBeforeRequest: events, onHeadersReceived: events }, cookies: { onChanged: events, async getAll() { return []; } },
      declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules() {} },
      windows: { onCreated: events, onRemoved: events, async getAll() { return [{ id: 1 }]; } },
      tabs: { onCreated: events, onRemoved: events,
        async query() { return [{ id: 1, url: currentUrl, status: 'complete' }]; },
        async get() { return { id: 1, url: currentUrl, status: 'complete' }; },
        async update(_id, input) {
          currentUrl = input.url || currentUrl;
          if (currentUrl === 'https://example.test/original') {
            routed.push(currentUrl);
            queueMicrotask(() => nativeEvent({ tabId: 1 }, 'Fetch.requestPaused', {
              requestId: 'guarded-original', frameId: 'main', resourceType: 'Document',
              request: { url: currentUrl, method: 'GET' }, responseStatusCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }],
            }));
          }
          return { id: 1, url: currentUrl, status: 'complete' };
        },
        async sendMessage(_id, message) {
          if (message.kind === 'authentication-guard') return { blocked: false };
          if (message.kind === 'resolve_attachment_link') return null;
          if (message.kind === 'arm_attachment_click') return { ready: true };
          return { text: 'synthetic', controls: [], nextOffset: null, scanLimited: false };
        } },
    }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } } };
  startWorker({ origins: ['https://example.test'], domains: [], matches: ['https://example.test/*'],
    initialUrl: 'https://example.test/', endpoint: 'ws://127.0.0.1/', token: 'synthetic', observationMode: 'text',
    attachmentDownloads: true, deadlineAt: Date.now() + 10_000 }, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); socket.onopen(); let sequence = 0;
  const dispatch = async (operation, args = {}) => {
    const id = String(++sequence); socket.onmessage({ data: JSON.stringify({ id, operation, args }) });
    for (let i = 0; i < 40; i++) { await tick(); const result = sent.find(value => value.id === id); if (result) return result.result; }
    throw Error('synthetic_command_timeout');
  };
  await dispatch('restore-session-auth', { cookies: [], replace: false });
  for (const [next, reason] of [['main', null], ['iframe', null], ['post', 'attachment_link_required'],
    ['foreign', 'attachment_link_required'], ['navigate', 'stale_frame']]) {
    mode = next;
    const frame = await dispatch('read-text'), args = { frameId: frame.frameId, x: 10, y: 20 };
    assert.equal(frame.state, 'ready', JSON.stringify({ mode, reason: frame.reason }));
    const result = await dispatch('download-attachment', args);
    if (reason) { assert.equal(result.reason, reason); assert.equal(result.file, undefined); }
    else { assert.equal(result.state, 'ready', JSON.stringify({ mode, reason: result.reason, clicks, reads, routedCount: routed.length, stages })); assert.equal(result.file.dataBase64, 'AQID'); }
    assert.equal(stages.at(-1), 'Response', 'request-stage routing is revoked after every result/refusal');
    assert.equal((await dispatch('download-attachment', args)).reason, 'stale_frame', 'the original click token cannot replay');
  }
  assert.equal(clicks, 5); assert.equal(reads, 2); assert.equal(routed.length, 2, 'POST/foreign/stale requests never reach the receiver');
  assert.doesNotMatch(JSON.stringify(sent), /foreign\.test|original-click|PRIVATE/);
});

test('document response guard distinguishes redirects from final resources without revealing headers', () => {
  const header = (name, value) => ({ name, value });
  for (const status of [301, 302, 303, 307, 308]) assert.equal(visualDocumentResponsePolicy(status, [header('Location', '/detail')]), 'redirect');
  assert.equal(visualDocumentResponsePolicy(200, [header('Content-Type', 'text/html; charset=utf-8')]), 'html');
  for (const headers of [[], [header('Location', '/detail')], [header('content-type', 'application/json')], [header('content-type', 'application/octet-stream'), header('location', '/detail')], [header('content-type', 'text/html'), header('content-disposition', 'attachment; filename=synthetic')], [header('content-type', 'text/html'), header('Content-Type', 'application/json')]]) {
    assert.equal(visualDocumentResponsePolicy(200, headers), 'block');
  }
  assert.equal(visualDocumentResponsePolicy(301, [header('location', '/detail'), header('content-disposition', 'attachment')]), 'block');
  assert.equal(visualDocumentResponsePolicy(undefined, []), 'block');
  assert.equal(visualDocumentResponsePolicy(200, [header('content-type', 'text/html'), header('irrelevant', 'x'.repeat(65536))]), 'block');
});

for (const fixtureOnly of [false, true]) test(`audio source delivery rechecks navigation and credentials without body reads or diagnostic authority (fixture=${fixtureOnly})`, async () => {
  const events = { addListener() {} }, sent = [];
  let socket, nativeEvent, messageEvent, currentUrl = 'about:blank', clicks = 0, armed, mode = 'navigate', blocked = false;
  const context = { URL, Date, TextEncoder, performance, setTimeout, clearTimeout, crypto: { randomUUID }, chrome: {
    runtime: { id: 'fixture', onMessage: { addListener(fn) { messageEvent = fn; } } },
    debugger: { onDetach: events, onEvent: { addListener(fn) { nativeEvent = fn; } }, async attach() {},
      async sendCommand(_source, method, args) {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'original', mimeType: 'text/html', url: currentUrl } } };
        if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 }, cssContentSize: { x: 0, y: 0, width: 800, height: 600 } };
        if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
          clicks++;
          if (mode === 'navigate') nativeEvent({ tabId: 1 }, 'Page.navigatedWithinDocument', { frameId: 'main' });
          if (mode === 'credential') blocked = true;
          messageEvent({ kind: 'route_audio_source', nonce: armed.nonce,
            ...(['response206', 'mimewebm'].includes(mode) ? { url: 'https://example.test/audio' } : { file: { mimeType: 'audio/wav', dataBase64: 'AQID' } }) }, { id: 'fixture', tab: { id: 1 }, frameId: 0 });
        }
        assert.notEqual(method, 'Fetch.takeResponseBodyAsStream', 'no test case grants a network body');
        return {};
      } },
    webRequest: { onBeforeRequest: events, onHeadersReceived: events }, cookies: { onChanged: events, async getAll() { return []; } },
    declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules() {} },
    windows: { onCreated: events, onRemoved: events, async getAll() { return [{ id: 1 }]; } },
    tabs: { onCreated: events, onRemoved: events,
      async query() { return [{ id: 1, url: currentUrl, status: 'complete' }]; },
      async get() { return { id: 1, url: currentUrl, status: 'complete' }; },
      async update(_id, input) {
        currentUrl = input.url || currentUrl;
        if (currentUrl === 'https://example.test/audio') queueMicrotask(() => nativeEvent({ tabId: 1 }, 'Fetch.requestPaused', {
          requestId: 'fixture', frameId: 'main', resourceType: 'Document', request: { url: currentUrl },
          responseStatusCode: mode === 'response206' ? 206 : 200,
          responseHeaders: [{ name: 'content-type', value: mode === 'mimewebm' ? 'audio/webm' : 'audio/mpeg' }, { name: 'x-private', value: 'PRIVATE_HEADER_BODY' }],
        }));
        return { id: 1, url: currentUrl, status: 'complete' };
      },
      async sendMessage(_id, message) {
        if (message.kind === 'authentication-guard') return { blocked };
        if (message.kind === 'resolve_audio_link') return null;
        if (message.kind === 'arm_audio_click') {
          armed = message;
          const sender = { id: 'fixture', tab: { id: 1 }, frameId: 0 };
          const report = (stage, patch = {}) => messageEvent({ kind: 'audio_fixture_stage', nonce: armed.nonce, stage,
            privateValue: 'PRIVATE_AUDIO_DIAGNOSTIC', ...patch }, sender);
          report('PRIVATE_AUDIO_DIAGNOSTIC'); report('main_armed', { nonce: 'foreign' });
          for (let i = 0; i < 12; i++) report('main_armed');
          return { ready: true };
        }
        return { text: 'synthetic', controls: [], nextOffset: null, scanLimited: false };
      } },
  }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } } };
  startWorker({ fixtureOnly, origins: ['https://example.test'], domains: [], matches: ['https://example.test/*'], initialUrl: 'https://example.test/', endpoint: 'ws://127.0.0.1/', token: 'synthetic', observationMode: 'text', audioDownloads: true, deadlineAt: Date.now() + 10_000 }, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); socket.onopen(); let sequence = 0;
  const dispatch = async (operation, args = {}) => {
    const id = String(++sequence); socket.onmessage({ data: JSON.stringify({ id, operation, args }) });
    for (let i = 0; i < 30; i++) { await tick(); const item = sent.find(value => value.id === id); if (item) return item.result; }
    throw Error('synthetic_command_timeout');
  };
  await dispatch('restore-session-auth', { cookies: [], replace: false });
  for (const [next, reason] of [['navigate', 'stale_frame'], ['credential', 'manual_control_active'], ['response206', 'attachment_unsupported'], ['mimewebm', 'attachment_unsupported'], ['valid', undefined]]) {
    mode = next; blocked = false;
    const frame = await dispatch('read-text'), args = { frameId: frame.frameId, x: 10, y: 20 };
    const result = await dispatch('download-audio', args);
    if (reason) { assert.equal(result.reason, reason); assert.equal(result.file, undefined); }
    else { assert.equal(result.state, 'ready'); assert.equal(result.file.mimeType, 'audio/wav'); }
    if (next === 'response206') assert.deepEqual(JSON.parse(JSON.stringify(result.audioDiagnostic)), { stage: 'audio_response', code: 'unsupported_status', httpStatus: 206 });
    if (next === 'mimewebm') assert.deepEqual(JSON.parse(JSON.stringify(result.audioDiagnostic)), { stage: 'audio_response', code: 'unsupported_mime', format: 'webm' });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_HEADER_BODY|https:|dataBase64.*PRIVATE/u);
    blocked = false;
    assert.equal((await dispatch('download-audio', args)).reason, 'stale_frame');
  }
  assert.equal(clicks, 5, 'each independent source dispatch gets exactly one original click');
  const diagnostics = sent.filter(value => value.kind === 'audio_fixture_stage');
  assert.equal(diagnostics.length, fixtureOnly ? 5 * 8 : 0, 'only a synthetic operation admits a bounded phase tail');
  for (const item of diagnostics) assert.deepEqual(item, { kind: 'audio_fixture_stage', stage: 'main_armed' });
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_AUDIO_DIAGNOSTIC|"nonce"/u);
});

for (const externalNavigation of [false, true]) test(`extension applies signed navigation policy before bootstrap (external=${externalNavigation})`, async () => {
  const initialUrl = externalNavigation ? 'https://documents.other.test/contract' : 'https://www.example.test/';
  let rules, socket, detach; const sent = [], events = { addListener() {} };
  const guardCommands = [];
  const context = {
    URL, Date, TextEncoder, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: { addListener(fn) { detach = fn; } }, onEvent: events, async attach() {}, async sendCommand(_source, method) { guardCommands.push(method); return {}; } },
      webRequest: { onBeforeRequest: events, onHeadersReceived: events },
      windows: { onCreated: events, onRemoved: events, async getAll() { assert.ok(rules, 'navigation policy precedes window discovery'); return [{ id: 1 }]; } },
      tabs: { onCreated: events, onRemoved: events, async query() { assert.ok(rules); return [{ id: 1, url: 'chrome://newtab/' }]; }, async update(_id, value) {
        if (value.url === 'about:blank') assert.equal(guardCommands.includes('Fetch.enable'), false, 'privileged new-tab commits inert blank before attachment');
        else { assert.equal(value.url, initialUrl); assert.ok(guardCommands.includes('Fetch.enable'), 'provider URL follows the installed response guard'); }
        return { id: 1, url: value.url, status: 'complete' };
      } },
      cookies: { onChanged: events, async getAll() { return []; }, async set() { throw Error('unexpected_cookie_restore'); } },
      declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules(value) { rules = value.addRules; } },
    },
    WebSocket: class {
      static OPEN = 1;
      constructor() { socket = this; this.readyState = 1; }
      send(value) { sent.push(JSON.parse(value)); }
    },
  };
  const config = { externalNavigation, origins: ['https://www.example.test'], domains: ['example.test'], matches: ['https://*.example.test/*'], initialUrl, endpoint: 'ws://127.0.0.1/fixture', token: 'synthetic', deadlineAt: Date.now() + 10_000 };
  startWorker(config, context);
  await new Promise(resolve => setImmediate(resolve));
  socket.onopen();
  assert.equal(sent.at(-1).kind, 'auth_required');
  socket.onmessage({ data: JSON.stringify({ id: 'bootstrap', operation: 'restore-session-auth', args: { cookies: [], replace: false } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-1).kind, 'hello');
  assert.ok(guardCommands.includes('Fetch.enable'), 'response interception precedes the first provider URL');
  assert.deepEqual([...rules.find(rule => rule.id === 3).condition.excludedTabIds], [1]);
  assert.equal(rules.find(rule => rule.id === 4).condition.excludedTabIds, undefined, 'subframe MIME guards remain strict');
  detach({ tabId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rules.find(rule => rule.id === 3).condition.excludedTabIds, undefined, 'native detach revokes the exact MIME exception');
  const allows = url => rules.some(rule => rule.action.type === 'allow' && new RegExp(rule.condition.regexFilter).test(url));
  assert.equal(allows('https://www.example.test/detail'), true);
  assert.equal(allows('https://user:secret@documents.other.test/contract'), false, 'web navigation never admits URL credentials');
  for (const url of ['https://wwwXexampleXtest/detail', 'https://example.test.evil.com/detail', 'https://evilexample.test/detail', 'https://example.test:444/detail']) assert.equal(allows(url), externalNavigation, url);
  socket.onmessage({ data: JSON.stringify({ id: 'one', operation: 'navigate', args: { url: externalNavigation ? 'file:///private/data' : 'https://example.test.evil.com/' } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-1).result.reason, 'navigation_blocked');
});

test('bootstrap reports only a closed policy failure before accepting input', async () => {
  const sent = [], events = { addListener() {} }; let socket;
  const context = { URL, Date, TextEncoder, setTimeout, clearTimeout, chrome: {
    runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events, onEvent: events, async attach() {}, async sendCommand() { return {}; } },
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
    runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events, onEvent: events, async attach() {}, async sendCommand() { return {}; } },
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
    runtime: { id: 'fixture', onMessage: events }, debugger: { onDetach: events, onEvent: events, async attach() {}, async sendCommand() { return {}; } },
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
