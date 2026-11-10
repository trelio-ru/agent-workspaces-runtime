import { createBrowserRequestPacing } from '../host-runtime/scripts/trelio-browser-policy.mjs';
import { createBrowserTabBudget } from '../host-runtime/scripts/trelio-browser-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualExtensionWorker, visualDocumentResponsePolicy } from '../host-runtime/scripts/trelio-visual-extension-worker.mjs';
import { visualCookieState } from '../host-runtime/scripts/trelio-visual-cookie-state.mjs';
import { randomUUID } from 'node:crypto';
const startWorker = (config, context) => {
  context.chrome.contentSettings ??= { notifications: { async set() {}, async get() { return { setting: 'block' }; } } };
  return vm.runInNewContext(`(${visualExtensionWorker.toString()})(${JSON.stringify(config)}, (${visualCookieState.toString()})(${JSON.stringify(config)}), ${createBrowserRequestPacing.toString()}, ${createBrowserTabBudget.toString()}, ${visualDocumentResponsePolicy.toString()});`, context);
};

/** Execute the actual materialised worker with a native input whose reply is
 * withheld until its dialog is answered. A listener-only mock would miss the
 * deadlock: the ORIGINAL mouseReleased promise must remain outstanding across
 * one or several independent model turns, without a second input dispatch. */
async function dialogWorker({ image = false, policyFailure, manual = false, immediateAck = false } = {}) {
  const events = { addListener() {} }, sent = [], answers = [], policy = [], raster = [];
  const pngHeader = Buffer.alloc(36); pngHeader.writeUInt32BE(800, 16); pngHeader.writeUInt32BE(600, 20);
  let socket, nativeEvent, currentUrl = 'about:blank', clicks = 0, keys = 0, keyUps = 0, reads = 0, release, rejectInput, nextType = 'confirm', answerFails = false, nextDialog = false;
  const open = (type = nextType, message = 'Send the reviewed message?', extra = {}) => nativeEvent({ tabId: 1 }, 'Page.javascriptDialogOpening',
    { type, message, url: currentUrl, ...extra });
  const context = { URL, Date, TextEncoder, Uint8Array, DataView, performance, atob, btoa, crypto: { randomUUID },
    // Real event-loop yields, without the unrelated post-input animation wait.
    setTimeout(fn) { return setTimeout(fn, 0); }, clearTimeout,
    OffscreenCanvas: class {
      getContext() { return { fillRect() {}, fillText(value) { raster.push(value); } }; }
      async convertToBlob() { return { async arrayBuffer() { return Uint8Array.of(1, 2, 3).buffer; } }; }
    },
    chrome: {
      runtime: { id: 'fixture', onMessage: events },
      contentSettings: { notifications: {
        async set(value) { policy.push(JSON.parse(JSON.stringify(value))); if (policyFailure === 'write') throw Error('PRIVATE_NOTIFICATION_ERROR'); },
        async get() { return { setting: policyFailure === 'read' ? 'ask' : 'block' }; },
      } },
      debugger: { onDetach: events, onEvent: { addListener(fn) { nativeEvent = fn; } }, async attach() {},
        async sendCommand(_source, method, args) {
          if (method === 'Page.getFrameTree') { reads++; return { frameTree: { frame: { id: 'main', loaderId: 'original', mimeType: 'text/html', url: currentUrl } } }; }
          if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 }, cssContentSize: { x: 0, y: 0, width: 800, height: 600 } };
          // Protocol-only native stub. Full PNG/MCP validation is independently
          // exercised by the real Chromium fixture, not this header stand-in.
          if (method === 'Page.captureScreenshot') return { data: pngHeader.toString('base64') };
          if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
            clicks++;
            if (immediateAck) { queueMicrotask(() => open()); return {}; }
            return new Promise((resolve, reject) => { release = resolve; rejectInput = reject; queueMicrotask(() => open()); });
          }
          if (method === 'Input.dispatchKeyEvent' && args.type === 'keyDown') {
            keys++; return new Promise(resolve => { release = resolve; queueMicrotask(() => open()); });
          }
          if (method === 'Input.dispatchKeyEvent' && args.type === 'keyUp') keyUps++;
          if (method === 'Page.handleJavaScriptDialog') {
            answers.push(JSON.parse(JSON.stringify(args)));
            if (answerFails) throw Error('PRIVATE_UNKNOWN_NATIVE_ANSWER');
            nativeEvent({ tabId: 1 }, 'Page.javascriptDialogClosed', {});
            if (nextDialog) { nextDialog = false; queueMicrotask(() => open('alert', 'Message sent')); }
            else release?.({});
          }
          return {};
        } },
      webRequest: { onBeforeRequest: events, onHeadersReceived: events },
      cookies: { onChanged: events, async getAll() { return []; } },
      declarativeNetRequest: { async getSessionRules() { return []; }, async updateSessionRules() {} },
      windows: { onCreated: events, onRemoved: events, async getAll() { return [{ id: 1 }]; } },
      tabs: { onCreated: events, onRemoved: events,
        async query() { return [{ id: 1, url: currentUrl, status: 'complete' }]; },
        async get() { return { id: 1, url: currentUrl, status: 'complete' }; },
        async update(_id, input) { assert.equal(policy.length, 1, 'notification policy precedes provider navigation'); currentUrl = input.url || currentUrl; return { id: 1, url: currentUrl, status: 'complete' }; },
        async sendMessage(_id, message) { return message.kind === 'authentication-guard' ? { blocked: false } : { title: 'Site', text: 'Original site result', controls: [], nextOffset: null, scanLimited: false }; },
      },
    }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } },
  };
  startWorker({ origins: ['https://example.test'], domains: [], matches: ['https://example.test/*'],
    initialUrl: 'https://example.test/', endpoint: 'ws://127.0.0.1/', token: 'synthetic', manual,
    observationMode: image ? 'image' : 'text', deadlineAt: Date.now() + 10_000 }, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); socket.onopen(); let sequence = 0;
  const dispatch = async (operation, args = {}) => {
    const id = String(++sequence); socket.onmessage({ data: JSON.stringify({ id, operation, args }) });
    for (let i = 0; i < 300; i++) { await new Promise(resolve => setTimeout(resolve, 1)); const result = sent.find(value => value.id === id); if (result) return result.result; }
    throw Error('synthetic_command_timeout');
  };
  if (!policyFailure) await dispatch('restore-session-auth', { cookies: [], replace: false });
  return { dispatch, open, sent, answers, policy, raster, counts: () => ({ clicks, keys, keyUps, reads }),
    set type(value) { nextType = value; }, set failAnswer(value) { answerFails = value; }, set chain(value) { nextDialog = value; },
    humanClose() { nativeEvent({ tabId: 1 }, 'Page.javascriptDialogClosed', {}); release?.({}); },
    failInput() { rejectInput?.(Error('PRIVATE_INPUT_FAILURE')); },
  };
}

test('native confirm unblocks the original input through a separate observed answer, never a second click', async () => {
  const worker = await dialogWorker();
  assert.deepEqual(worker.policy, [{ primaryPattern: '<all_urls>', setting: 'block', scope: 'regular' }]);
  const page = await worker.dispatch('read-text');
  const modal = await worker.dispatch('click', { frameId: page.frameId, x: 20, y: 30 });
  assert.match(modal.text, /Send the reviewed message/);
  const reads = worker.counts().reads;
  const fresh = await worker.dispatch('read-text');
  assert.equal(worker.counts().reads, reads, 'observing a modal never waits for its blocked renderer');
  assert.equal(fresh.frameId, modal.frameId, 'an unchanged native message retains its immutable one-use frame');
  assert.equal((await worker.dispatch('key', { frameId: page.frameId, key: 'Enter' })).reason, 'stale_frame');
  assert.equal((await worker.dispatch('navigate', { url: 'https://example.test/other' })).reason, 'stale_frame');
  const result = await worker.dispatch('key', { frameId: fresh.frameId, key: 'Enter' });
  assert.equal(result.text, 'Original site result');
  assert.deepEqual(worker.answers, [{ accept: true }]); assert.equal(worker.counts().clicks, 1);
  assert.equal((await worker.dispatch('key', { frameId: fresh.frameId, key: 'Enter' })).reason, 'stale_frame');
});

test('a dialog opened by Enter resumes its original key-up without a second key-down', async () => {
  const worker = await dialogWorker();
  const page = await worker.dispatch('read-text');
  const modal = await worker.dispatch('key', { frameId: page.frameId, key: 'Enter' });
  assert.match(modal.title, /confirm/);
  const result = await worker.dispatch('key', { frameId: modal.frameId, key: 'Enter' });
  assert.equal(result.text, 'Original site result');
  assert.equal(worker.counts().keys, 1); assert.equal(worker.counts().keyUps, 1);
  assert.equal(worker.counts().clicks, 0); assert.deepEqual(worker.answers, [{ accept: true }]);
});

test('an early native input acknowledgement cannot replace the delivered modal token with an unseen frame', async () => {
  const worker = await dialogWorker({ immediateAck: true });
  const page = await worker.dispatch('read-text');
  const modal = await worker.dispatch('click', { frameId: page.frameId, x: 20, y: 30 });
  await new Promise(resolve => setTimeout(resolve, 15));
  const result = await worker.dispatch('key', { frameId: modal.frameId, key: 'Enter' });
  assert.equal(result.text, 'Original site result'); assert.deepEqual(worker.answers, [{ accept: true }]);
  assert.equal(worker.counts().clicks, 1);
});

test('a confirm cancellation and a following alert retain their distinct one-use observations', async () => {
  const worker = await dialogWorker(); worker.chain = true;
  const page = await worker.dispatch('read-text');
  const confirm = await worker.dispatch('click', { frameId: page.frameId, x: 20, y: 30 });
  const alert = await worker.dispatch('key', { frameId: confirm.frameId, key: 'Escape' });
  assert.match(alert.title, /alert/); assert.notEqual(alert.frameId, confirm.frameId);
  const button = alert.controls[0];
  const result = await worker.dispatch('click', { frameId: alert.frameId, x: button.x, y: button.y });
  assert.equal(result.text, 'Original site result'); assert.equal(worker.counts().clicks, 1);
  assert.deepEqual(worker.answers, [{ accept: false }, { accept: true }]);
});

test('unknown answer outcome remains consumed; prompt defaults, unsupported dialogs and manual phases stay private', async () => {
  const worker = await dialogWorker();
  const page = await worker.dispatch('read-text');
  const modal = await worker.dispatch('click', { frameId: page.frameId, x: 20, y: 30 });
  worker.failAnswer = true;
  assert.equal((await worker.dispatch('key', { frameId: modal.frameId, key: 'Enter' })).reason, 'operation_failed');
  assert.equal((await worker.dispatch('key', { frameId: modal.frameId, key: 'Enter' })).reason, 'stale_frame');
  assert.equal((await worker.dispatch('read-text')).state, 'manual_input_required');
  assert.equal(worker.answers.length, 1); worker.humanClose();
  for (const [type, message] of [['prompt', 'PRIVATE_PROMPT'], ['beforeunload', 'PRIVATE_UNSAVED'], ['confirm', 'x'.repeat(4001)]]) {
    worker.open(type, message, { defaultPrompt: 'PRIVATE_DEFAULT' });
    assert.equal((await worker.dispatch('read-text')).state, 'manual_input_required'); worker.humanClose();
  }
  assert.doesNotMatch(JSON.stringify(worker.sent), /PRIVATE_/);
  const manual = await dialogWorker({ manual: true }); manual.open('confirm', 'PRIVATE_LOGIN');
  assert.equal((await manual.dispatch('read-text')).state, 'manual_input_required');
  assert.doesNotMatch(JSON.stringify(manual.sent), /PRIVATE_LOGIN/);
});

test('image-mode dialog observation rasterises native text without a new page or text-valued model payload', async () => {
  const worker = await dialogWorker({ image: true });
  const page = await worker.dispatch('screenshot');
  const modal = await worker.dispatch('click', { frameId: page.frameId, x: 20, y: 30 });
  assert.equal(modal.image.mimeType, 'image/png'); assert.equal(modal.text, undefined);
  assert.ok(worker.raster.includes('Send the reviewed message?'));
  assert.doesNotMatch(JSON.stringify(worker.sent), /Send the reviewed message|Website text|dialogId/);
  const result = await worker.dispatch('key', { frameId: modal.frameId, key: 'Enter' });
  assert.ok(result.image); assert.equal(worker.counts().clicks, 1);
  assert.deepEqual(worker.answers, [{ accept: true }]);
});

test('human closure invalidates the dialog frame and read-back never repeats its original action', async () => {
  const worker = await dialogWorker();
  const page = await worker.dispatch('read-text');
  const modal = await worker.dispatch('click', { frameId: page.frameId, x: 20, y: 30 });
  worker.humanClose();
  const result = await worker.dispatch('read-text');
  assert.equal(result.text, 'Original site result');
  assert.equal((await worker.dispatch('key', { frameId: modal.frameId, key: 'Enter' })).reason, 'stale_frame');
  assert.equal(worker.counts().clicks, 1); assert.equal(worker.answers.length, 0);
});

test('notification policy refusal stops startup before provider navigation with only a closed stage', async () => {
  for (const policyFailure of ['write', 'read']) {
    const worker = await dialogWorker({ policyFailure });
    const failure = worker.sent.find(value => value.kind === 'bootstrap_failed');
    assert.equal(failure.stage, policyFailure === 'write' ? 'policy_write' : 'policy_read');
    assert.doesNotMatch(JSON.stringify(worker.sent), /PRIVATE_NOTIFICATION_ERROR/);
  }
});

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

test('audio source delivery rechecks navigation and credentials, consumes its frame and never reads an arbitrary body', async () => {
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
        if (message.kind === 'arm_audio_click') { armed = message; return { ready: true }; }
        return { text: 'synthetic', controls: [], nextOffset: null, scanLimited: false };
      } },
  }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } } };
  startWorker({ origins: ['https://example.test'], domains: [], matches: ['https://example.test/*'], initialUrl: 'https://example.test/', endpoint: 'ws://127.0.0.1/', token: 'synthetic', observationMode: 'text', audioDownloads: true, deadlineAt: Date.now() + 10_000 }, context);
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
