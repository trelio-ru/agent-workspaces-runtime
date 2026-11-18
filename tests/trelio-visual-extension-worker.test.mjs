import { createBrowserRequestPacing } from '../host-runtime/scripts/trelio-browser-policy.mjs';
import { createBrowserTabBudget } from '../host-runtime/scripts/trelio-browser-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualExtensionWorker, visualDocumentResponsePolicy } from '../host-runtime/scripts/trelio-visual-extension-worker.mjs';
import { visualCookieState } from '../host-runtime/scripts/trelio-visual-cookie-state.mjs';
import { randomUUID } from 'node:crypto';
import { authenticateVisualBrowser, normalizeVisualAuthentication, visualAuthenticationFingerprint } from '../host-runtime/scripts/trelio-visual-session.mjs';
const startWorker = (config, context) => {
  context.chrome.contentSettings ??= { notifications: { async set() {}, async get() { return { setting: 'block' }; } } };
  return vm.runInNewContext(`(${visualExtensionWorker.toString()})(${JSON.stringify(config)}, (${visualCookieState.toString()})(${JSON.stringify(config)}), ${createBrowserRequestPacing.toString()}, ${createBrowserTabBudget.toString()}, ${visualDocumentResponsePolicy.toString()});`, context);
};

/** Execute the actual materialised worker with a native input whose reply is
 * withheld until its dialog is answered. A listener-only mock would miss the
 * deadlock: the ORIGINAL mouseReleased promise must remain outstanding across
 * one or several independent model turns, without a second input dispatch. */
async function dialogWorker({ image = false, policyFailure, manual = false, profileAuthentication = false, immediateAck = false, bootstrapUrl, fixtureOnly = false, screenshot, layout, credentialCheck, armLink, textObservation, authenticationMessage, mouseWheel, policyRead, focusEmulation, deferAuthentication = false, assistantBrowserSecrets = false, secretHit = true, referenceRoutes = [], uploadChooser, fileUploadPickerPaths = [] } = {}) {
  const events = { addListener() {} }, sent = [], answers = [], policy = [], raster = [];
  const pngHeader = Buffer.alloc(36); pngHeader.writeUInt32BE(800, 16); pngHeader.writeUInt32BE(600, 20);
  const navigation=[], transport=[], nativeCommands=[], windowUpdates=[], tabUpdates=[], networkRules=[];
  const openTabs = new Set([1]);
  let windowCreated, windowRemoved, tabCreated, headersReceived, detached, connections = 0, selectedTab = 1;
  let socket, nativeEvent, currentUrl = bootstrapUrl || 'about:blank', loaderId = 'original', clicks = 0, keys = 0, keyUps = 0, reads = 0, release, rejectInput, nextType = 'confirm', answerFails = false, nextDialog = false;
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
      debugger: { async detach(source) { detached(source); }, onDetach: { addListener(fn) { detached = fn; } }, onEvent: { addListener(fn) { nativeEvent = fn; } }, async attach() {},
        async sendCommand(_source, method, args) {
          nativeCommands.push({ method, args: JSON.parse(JSON.stringify(args)) });
          if (method === 'Emulation.setFocusEmulationEnabled') await focusEmulation?.();
          if (method === 'Page.getFrameTree') {
            reads++;
            return { frameTree: { frame: { id: 'main', loaderId, mimeType: 'text/html', url: currentUrl },
              ...(uploadChooser?.url ? { childFrames: [{ frame: { id: 'picker', parentId: 'main', loaderId: 'picker-loader', url: uploadChooser.url } }] } : {}) } };
          }
          if (method === 'Page.getLayoutMetrics') {
            await layout?.();
            return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 }, cssContentSize: { x: 0, y: 0, width: 800, height: 600 } };
          }
          // Protocol-only native stub. Full PNG/MCP validation is independently
          // exercised by the real Chromium fixture, not this header stand-in.
          if (method === 'Page.captureScreenshot') {
            await screenshot?.();
            return { data: pngHeader.toString('base64') };
          }
          if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseWheel') await mouseWheel?.();
          if (assistantBrowserSecrets && method === 'Runtime.evaluate') {
            if (args.expression.startsWith('globalThis.__trelioSecretBrowserApply(')) return { result: { value: { outcome: 'succeeded' } } };
            if (args.expression.startsWith('globalThis.__trelioSecretBrowserCheckFollowingClick')) return { result: { value: secretHit } };
          }
          if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
            clicks++;
            if (uploadChooser) {
              nativeEvent({ tabId: 1, ...(uploadChooser.outOfProcess ? { sessionId: 'foreign' } : {}) }, 'Page.fileChooserOpened',
                { frameId: 'picker', backendNodeId: 3, mode: 'selectSingle' });
              return {};
            }
            if (assistantBrowserSecrets) {
              loaderId = 'new-document';
              nativeEvent({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'main', loaderId, url: currentUrl } });
              return {};
            }
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
      webRequest: { onBeforeRequest: events, onHeadersReceived: { addListener(fn) { headersReceived = fn; } } },
      cookies: { onChanged: events, async getAll() { return []; } },
      declarativeNetRequest: { async getSessionRules() { await policyRead?.(); return []; }, async updateSessionRules(value) { networkRules.push(JSON.parse(JSON.stringify(value))); } },
      windows: { onCreated: {addListener(fn){windowCreated=fn;}}, onRemoved: {addListener(fn){windowRemoved=fn;}},
        async getAll() { return [{ id: 1 }]; }, async remove(id){windowRemoved(id);},
        async update(id, input) { windowUpdates.push({ id, input: JSON.parse(JSON.stringify(input)) }); } },
      tabs: { onCreated: { addListener(fn) { tabCreated = fn; } }, onRemoved: events,
        async query() { return [...openTabs].map(id => ({ id, url: currentUrl, status: 'complete', active: id === selectedTab })); },
        async get(id) { return { id, url: currentUrl, status: 'complete' }; },
        async update(_id, input) { assert.equal(policy.length, 1, 'notification policy precedes provider navigation'); tabUpdates.push(JSON.parse(JSON.stringify(input))); if(input.url)navigation.push(input.url);currentUrl = input.url || currentUrl; return { id: 1, url: currentUrl, status: 'complete' }; },
        async sendMessage(_id, message, target) {
          if (message.kind === 'authentication-guard') { await credentialCheck?.(); return { blocked: false }; }
          if (message.kind === 'arm_link_click') await armLink?.();
          if (authenticationMessage && message.kind.startsWith('authentication-')) return authenticationMessage(message, target);
          if (message.kind === 'read_rendered_text') await textObservation?.();
          return { title: 'Site', text: 'Original site result', controls: [], nextOffset: null, scanLimited: false };
        },
      },
    }, WebSocket: class { static OPEN = 1;
      constructor() { socket = this; this.readyState = 1; connections++; }
      send(value) { const message=JSON.parse(value);sent.push(message);transport.push(message.kind); }
      close(){this.readyState=3;transport.push('transport_closed');this.onclose?.();}
    },
  };
  startWorker({ origins: ['https://example.test'], domains: [], matches: ['https://example.test/*'],
    initialUrl: 'https://example.test/', endpoint: 'ws://127.0.0.1/', token: 'synthetic', manual, profileAuthentication, externalNavigation: profileAuthentication, fixtureOnly,
    observationMode: image ? 'image' : 'text', assistantBrowserSecrets, referenceRoutes, fileUploads: !!uploadChooser, fileUploadPickerPaths,
    ...(authenticationMessage?{authentication:true}:{}), ...(bootstrapUrl?{bootstrapUrl}:{}), deadlineAt: Date.now() + 10_000 }, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); socket.onopen(); let sequence = 0;
  const dispatch = async (operation, args = {}) => {
    const id = String(++sequence); socket.onmessage({ data: JSON.stringify({ id, operation, args }) });
    for (let i = 0; i < 300; i++) { await new Promise(resolve => setTimeout(resolve, 1)); const result = sent.find(value => value.kind === 'result' && value.id === id); if (result) return result.result; }
    throw Error('synthetic_command_timeout');
  };
  if (!policyFailure && !deferAuthentication) await dispatch('restore-session-auth', { cookies: [], replace: false });
  return { dispatch, open, sent, answers, policy, raster, navigation, transport, nativeCommands, windowUpdates, tabUpdates, networkRules,
    frameEvent: (method, params, tabId = 1) => nativeEvent({ tabId }, method, params),
    restoreDocument(id) {
      loaderId = id;
      nativeEvent({ tabId: 1 }, 'Page.frameNavigated', { type: 'BackForwardCacheRestore', frame: { id: 'main', loaderId, url: currentUrl } });
    },
    selectTab(tabId) {
      if (!openTabs.has(tabId)) {
        openTabs.add(tabId);
        tabCreated({ id: tabId });
      }
      selectedTab = tabId;
    },
    reportHttpError(statusCode) { headersReceived({ tabId: 1, url: currentUrl, statusCode }); },
    async rejectDocument(frameId, tabId = 1) {
      nativeEvent({ tabId }, 'Fetch.requestPaused', { frameId, requestId: frameId, resourceType: 'Document',
        responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html-invalid' }] });
      await tick();
    },
    detach: () => detached({ tabId: 1 }),
    addWindow:id=>windowCreated({id,type:'normal'}), removeWindow:id=>windowRemoved(id),
    disconnect:()=>socket.close(), connections:()=>connections,
    counts: () => ({ clicks, keys, keyUps, reads }),
    set type(value) { nextType = value; }, set failAnswer(value) { answerFails = value; }, set chain(value) { nextDialog = value; },
    humanClose() { nativeEvent({ tabId: 1 }, 'Page.javascriptDialogClosed', {}); release?.({}); },
    failInput() { rejectInput?.(Error('PRIVATE_INPUT_FAILURE')); },
  };
}

test('a signed editor route projects only the top document ID and its valid selected tab', async () => {
  const worker = await dialogWorker({ referenceRoutes: [
    { origin: 'https://example.test', prefix: '/docs/d/', suffix: '/edit', selector: 'tab' },
    { origin: 'https://example.test', prefix: '/sheets/d/', suffix: '/edit', selector: 'gid' },
  ] });
  for (const [input, expected] of [
    ['/docs/d/document_1234/edit?state=PRIVATE&tab=t.2#PRIVATE', '/docs/d/document_1234/edit?tab=t.2'],
    ['/sheets/d/document_1234/edit?gid=3&private=PRIVATE#gid=3', '/sheets/d/document_1234/edit#gid=3'],
    ['/docs/d/document_1234/edit?tab=t.1&tab=t.2', undefined],
    ['/sheets/d/document_1234/edit?gid=2#gid=3', undefined],
    ['/docs/d/document_1234/export?private=PRIVATE', undefined],
  ]) {
    assert.equal((await worker.dispatch('navigate', { url: 'https://example.test' + input })).state, 'ready');
    const result = await worker.dispatch('read-text');
    assert.equal(result.state, 'ready');
    assert.equal(result.documentReference, expected && 'https://example.test' + expected);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
  }
});

test('only a signed same-origin child picker on the exact top editor can receive a staged file', async () => {
  const editor = 'https://example.test/sheets/d/synthetic_document/edit';
  for (const [top, url, fileUploadPickerPaths, outOfProcess, admitted] of [
    [editor, 'https://example.test/picker?private=1', ['/picker'], false, true],
    [editor, 'https://example.test/picker', [], false, false],
    [editor, 'https://example.test/picker', ['/picker'], true, false],
    [editor, 'https://example.test/picker/login', ['/picker'], false, false],
    [editor, 'https://other.test/picker', ['/picker'], false, false],
    ['https://example.test/', 'https://example.test/picker', ['/picker'], false, false],
  ]) {
    const worker = await dialogWorker({ fileUploadPickerPaths, uploadChooser: { url, outOfProcess }, referenceRoutes: [
      { origin: 'https://example.test', prefix: '/sheets/d/', suffix: '/edit', selector: 'gid' },
    ] });
    assert.equal((await worker.dispatch('navigate', { url: top })).state, 'ready');
    const frame = await worker.dispatch('read-text');
    const args = { frameId: frame.frameId, x: 30, y: 20, files: ['/fixture/staged.csv'] };
    const result = await worker.dispatch('upload-files', args);
    assert.equal(result.state, admitted ? 'ready' : 'error');
    assert.equal(worker.nativeCommands.filter(command => command.method === 'DOM.setFileInputFiles').length, admitted ? 1 : 0);
    assert.equal((await worker.dispatch('upload-files', args)).reason, 'stale_frame');
    assert.doesNotMatch(JSON.stringify(result), /staged\.csv|private=1/u);
  }
});

for (const mode of ['confirmed', 'changed-button', 'same-document-navigation', 'release-only']) {
  test('managed field-only fill masks the page and admits one original submit click only when proven: ' + mode, async () => {
    const worker = await dialogWorker({ assistantBrowserSecrets: true, secretHit: mode !== 'changed-button' });
    const original = await worker.dispatch('read-text');
    const handle = randomUUID(), targetUrl = 'https://example.test/';
    assert.equal((await worker.dispatch('secret-browser-bind', { handle, targetUrl, expiry: Date.now() + 9000 })).state, 'bound');
    const apply = { handle, method: 'Runtime.evaluate',
      params: { contextId: 9, returnByValue: true, expression: 'globalThis.__trelioSecretBrowserApply({"login":"fixture-value"})' } };
    assert.equal((await worker.dispatch('secret-browser-native', apply)).state, 'accepted');
    assert.equal((await worker.dispatch('secret-browser-native', apply)).reason, 'invalid_input');
    assert.equal((await worker.dispatch('secret-browser-release', { handle, allowFollowingClick: mode !== 'release-only' })).state, 'released');
    assert.equal((await worker.dispatch('read-text')).reason, 'manual_control_active');
    assert.equal((await worker.dispatch('screenshot')).reason, 'manual_control_active');
    worker.open('alert', 'fixture-value');
    assert.equal((await worker.dispatch('read-text')).state, 'manual_input_required');
    worker.humanClose();
    if (mode === 'same-document-navigation') worker.frameEvent('Page.navigatedWithinDocument', { frameId: 'main' });
    const input = { frameId: original.frameId, x: 20, y: 20 };
    const click = await worker.dispatch('click', input);
    assert.equal(click.state, mode === 'confirmed' ? 'ready' : 'error');
    if (mode === 'confirmed') {
      assert.equal(click.text, 'Original site result');
      worker.restoreDocument('restored-document');
      assert.equal((await worker.dispatch('read-text')).reason, 'manual_control_active', 'back/forward restore cannot expose a credential');
    }
    assert.equal((await worker.dispatch('click', input)).reason, 'stale_frame');
    assert.equal(worker.counts().clicks, mode === 'confirmed' ? 1 : 0);
    assert.equal(worker.sent.some(item => JSON.stringify(item).includes('fixture-value')), false);
  });
}

for (const [operation, phase] of [
  ['screenshot', 'layout'],
  ['screenshot', 'screenshot'],
  ['read-text', 'layout'],
  ['read-text', 'textObservation'],
]) {
  test(operation + ' refuses a top-document change during ' + phase, async () => {
    let worker, change;
    worker = await dialogWorker({ [phase]: () => change?.() });
    change = () => worker.frameEvent('Page.navigatedWithinDocument', { frameId: 'main' });
    const result = await worker.dispatch(operation);
    assert.deepEqual(result, { state: 'error', reason: 'stale_frame' });
    assert.equal(result.image, undefined);
    assert.equal(result.text, undefined);
  });
}

test('input refuses an original frame invalidated while its credential guard is pending', async () => {
  let worker, change;
  worker = await dialogWorker({ credentialCheck: () => change?.() });
  const before = await worker.dispatch('read-text');
  assert.equal(before.state, 'ready');
  change = () => worker.frameEvent('Page.navigatedWithinDocument', { frameId: 'main' });
  const result = await worker.dispatch('scroll', { frameId: before.frameId, x: 20, y: 20, deltaY: 100 });
  assert.deepEqual(result, { state: 'error', reason: 'stale_frame' });
  assert.equal(worker.nativeCommands.filter(value => value.method.startsWith('Input.')).length, 0);
});

test('click refuses navigation during link arming before the first input', async () => {
  let worker, change;
  worker = await dialogWorker({ armLink: () => change?.() });
  const before = await worker.dispatch('read-text');
  change = () => worker.frameEvent('Page.navigatedWithinDocument', { frameId: 'main' });
  const result = await worker.dispatch('click', { frameId: before.frameId, x: 20, y: 20 });
  assert.deepEqual(result, { state: 'error', reason: 'stale_frame' });
  assert.equal(worker.nativeCommands.filter(value => value.method.startsWith('Input.')).length, 0);
});

for (const operation of ['screenshot', 'read-text']) {
  test(operation + ' cannot republish an observation revoked by a child document refusal', async () => {
    let worker, refuse;
    const observe = () => refuse?.();
    worker = await dialogWorker({ screenshot: observe, textObservation: observe });
    worker.frameEvent('Page.frameAttached', { frameId: 'child', parentFrameId: 'main' });
    refuse = () => worker.rejectDocument('child');
    assert.deepEqual(await worker.dispatch(operation), { state: 'error', reason: 'stale_frame' });
    refuse = undefined;
    assert.equal((await worker.dispatch(operation)).state, 'ready');
  });
}

for (const scenario of ['child changes anchor', 'other tab navigates', 'current root changes anchor']) {
  test('in-flight observation when ' + scenario, async () => {
    let change;
    const worker = await dialogWorker({ textObservation: () => change?.() });
    worker.selectTab(2);
    assert.equal((await worker.dispatch('read-text')).state, 'ready');
    worker.selectTab(1);
    assert.equal((await worker.dispatch('read-text')).state, 'ready');
    worker.frameEvent('Page.frameAttached', { frameId: 'child', parentFrameId: 'main' });
    change = () => scenario === 'other tab navigates'
      ? worker.frameEvent('Page.frameNavigated', { frame: { id: 'other-main' } }, 2)
      : worker.frameEvent('Page.navigatedWithinDocument', { frameId: scenario === 'child changes anchor' ? 'child' : 'main' });
    const result = await worker.dispatch('read-text');
    // The negative control is a genuine transition of the observed root.
    assert.equal(result.state, scenario === 'current root changes anchor' ? 'error' : 'ready', JSON.stringify(result));
    if (scenario === 'current root changes anchor') assert.equal(result.reason, 'stale_frame');
  });
}

test('a blocked document in another attached tab leaves the active frame usable', async () => {
  const worker = await dialogWorker();
  worker.selectTab(2);
  assert.equal((await worker.dispatch('read-text')).state, 'ready');
  worker.selectTab(1);
  const observed = await worker.dispatch('read-text');
  assert.equal(observed.state, 'ready');
  await worker.rejectDocument('other-main', 2);
  const result = await worker.dispatch('scroll', { frameId: observed.frameId, x: 20, y: 20, deltaY: 100 });
  assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.equal(worker.nativeCommands.filter(value => value.method === 'Input.dispatchMouseEvent'
    && value.args.type === 'mouseWheel').length, 1);
  worker.selectTab(2);
  assert.deepEqual(await worker.dispatch('read-text'), { state: 'error', reason: 'document_blocked' });
});

test('a confirmed main document 403 has the same diagnostic for text and screenshots', async () => {
  const worker = await dialogWorker();
  worker.reportHttpError(403);
  await worker.rejectDocument('main');
  const reads = worker.counts().reads;
  for (const operation of ['read-text', 'screenshot']) {
    const result = await worker.dispatch(operation);
    assert.equal(result.reason, 'http_document_failure', JSON.stringify({ operation, result }));
    assert.equal(result.httpStatus, 403);
  }
  assert.equal(worker.counts().reads, reads, 'diagnostics do not observe the blocked document');
});

test('a blocked child Document invalidates the old frame but allows fresh parent observation', async () => {
  const worker = await dialogWorker();
  const before = await worker.dispatch('read-text');
  assert.equal(before.state, 'ready');
  worker.frameEvent('Page.frameAttached', { frameId: 'child', parentFrameId: 'main' });
  const reads = worker.counts().reads;
  await worker.rejectDocument('child');
  assert.equal(worker.counts().reads, reads, 'no frame query can stall the refusal of a paused response');
  assert.deepEqual(worker.nativeCommands.filter(value => value.method.startsWith('Fetch.') && value.method !== 'Fetch.enable'),
    [{ method: 'Fetch.failRequest', args: { requestId: 'child', errorReason: 'BlockedByClient' } }]);
  assert.deepEqual(await worker.dispatch('click', { frameId: before.frameId, x: 20, y: 20 }),
    { state: 'error', reason: 'stale_frame' });
  for (const operation of ['read-text', 'screenshot']) {
    const after = await worker.dispatch(operation);
    assert.equal(after.state, 'ready');
    assert.notEqual(after.frameId, before.frameId);
  }
  assert.equal(worker.counts().clicks, 0);
});

test('the document guard still fences a blocked root or an unknown frame', async () => {
  for (const frameId of ['main', 'unknown', 'detached-child', 'previous-document-child']) {
    const worker = await dialogWorker();
    assert.equal((await worker.dispatch('read-text')).state, 'ready');
    if (frameId === 'detached-child') {
      worker.frameEvent('Page.frameAttached', { frameId, parentFrameId: 'main' });
      worker.frameEvent('Page.frameDetached', { frameId, reason: 'remove' });
    }
    if (frameId === 'previous-document-child') {
      worker.frameEvent('Page.frameAttached', { frameId, parentFrameId: 'main' });
      worker.frameEvent('Page.frameNavigated', { frame: { id: 'main' } });
    }
    await worker.rejectDocument(frameId);
    worker.frameEvent('Page.frameAttached', { frameId: 'current-child', parentFrameId: 'main' });
    await worker.rejectDocument('current-child');
    for (const operation of ['read-text', 'screenshot'])
      assert.deepEqual(await worker.dispatch(operation), { state: 'error', reason: 'document_blocked' });
    assert.deepEqual(worker.nativeCommands.filter(value => value.method === 'Fetch.failRequest'),
      [frameId, 'current-child'].map(requestId => ({ method: 'Fetch.failRequest', args: { requestId, errorReason: 'BlockedByClient' } })));
  }
});

test('owned renderer activation precedes provider navigation and is not repeated by observations or input', async () => {
  let activate, calls = 0;
  const pending = new Promise(resolve => { activate = resolve; });
  const worker = await dialogWorker({ image: true, focusEmulation: async () => { calls++; await pending; } });
  assert.equal(calls, 1);
  assert.deepEqual(worker.navigation, [], 'no provider URL before the renderer and document guards are ready');
  assert.equal(worker.sent.some(value => value.kind === 'hello'), false);
  activate(); await new Promise(resolve => setImmediate(resolve));
  const before = await worker.dispatch('screenshot'); assert.equal(before.state, 'ready');
  assert.equal((await worker.dispatch('scroll', { frameId: before.frameId, x: 20, y: 20, deltaY: 100 })).state, 'ready');
  assert.equal((await worker.dispatch('screenshot')).state, 'ready');
  assert.deepEqual(worker.nativeCommands.filter(value => value.method.startsWith('Emulation.')),
    [{ method: 'Emulation.setFocusEmulationEnabled', args: { enabled: true } }]);
  assert.deepEqual(worker.windowUpdates, [], 'renderer focus never focuses/restores a native window');
  assert.ok(worker.tabUpdates.every(value => value.active === undefined), 'no native tab activation');
  assert.equal(worker.nativeCommands.filter(value => value.method === 'Input.dispatchMouseEvent' && value.args.type === 'mouseWheel').length, 1);
});

test('manual phases release renderer emulation and a new owned attachment enables it once', async () => {
  const worker = await dialogWorker({ manual: true });
  const activations = () => worker.nativeCommands.filter(value => value.method === 'Emulation.setFocusEmulationEnabled').length;
  assert.equal(activations(), 0, 'initial human login keeps native focus behaviour');
  assert.equal((await worker.dispatch('ready')).state, 'saved_unverified');
  assert.equal((await worker.dispatch('read-text')).state, 'ready');
  assert.equal(activations(), 1, 'an already attached manual tab acquires the work-phase renderer handle');
  assert.equal((await worker.dispatch('manual')).state, 'manual_input_required');
  assert.deepEqual(await worker.dispatch('read-text'), { state: 'error', reason: 'manual_control_active' });
  assert.equal(activations(), 1);
  await worker.dispatch('ready');
  assert.equal((await worker.dispatch('read-text')).state, 'ready');
  assert.equal(activations(), 2, 'the previous native detach released its handle');
  worker.detach();
  assert.equal((await worker.dispatch('read-text')).state, 'ready');
  assert.equal(activations(), 3, 'unexpected native detach cannot leave a stale activated-tab cache');
});

test('renderer activation refusal fences later work without input, retry or native error disclosure', async () => {
  let refuse = false, calls = 0;
  const worker = await dialogWorker({ focusEmulation() { calls++; if (refuse) throw Error('PRIVATE_NATIVE_FOCUS_ERROR'); } });
  const before = await worker.dispatch('read-text'); assert.equal(before.state, 'ready');
  refuse = true; worker.detach();
  assert.deepEqual(await worker.dispatch('read-text'), { state: 'error', reason: 'document_blocked' });
  assert.deepEqual(await worker.dispatch('scroll', { frameId: before.frameId, x: 20, y: 20, deltaY: 100 }), { state: 'error', reason: 'document_blocked' });
  assert.deepEqual(await worker.dispatch('navigate', { url: 'https://example.test/other' }), { state: 'error', reason: 'document_blocked' });
  assert.equal(calls, 2, 'the failed activation is not retried by another command');
  assert.equal(worker.nativeCommands.filter(value => value.method.startsWith('Input.')).length, 0);
  assert.deepEqual(worker.navigation, ['https://example.test/']);
  assert.doesNotMatch(JSON.stringify(worker.sent), /PRIVATE_NATIVE_FOCUS_ERROR/u);
});

test('fixture window controls cannot be enabled by ordinary transport arguments', async () => {
  const worker = await dialogWorker();
  for (const operation of ['fixture-minimize-windows', 'fixture-window-state']) {
    const before = await worker.dispatch('read-text');
    assert.deepEqual(await worker.dispatch(operation, { frameId: before.frameId, fixtureOnly: true, x: 20, y: 20 }),
      { state: 'error', reason: 'invalid_input' });
  }
  assert.deepEqual(worker.windowUpdates, []);
  assert.equal(worker.nativeCommands.filter(value => value.method.startsWith('Input.')).length, 0);
});

test('a failed initial renderer activation cannot publish readiness or navigate the provider', async () => {
  let calls = 0;
  const worker = await dialogWorker({ focusEmulation() { calls++; throw Error('PRIVATE_STARTUP_FOCUS_ERROR'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(worker.navigation, []);
  assert.equal(worker.sent.some(value => value.kind === 'hello'), false);
  assert.equal(worker.sent.filter(value => value.kind === 'bootstrap_failed').length, 1);
  assert.doesNotMatch(JSON.stringify(worker.sent), /PRIVATE_STARTUP_FOCUS_ERROR/u);
});

test('materialized startup emits closed fixture phases and ordinary startup emits none', async () => {
  for (const fixtureOnly of [false, true]) {
    const worker = await dialogWorker({ fixtureOnly, bootstrapUrl: 'chrome-extension://fixture/bootstrap.html' });
    const phases = worker.sent.filter(value => value.kind === 'startup_fixture_stage');
    if (fixtureOnly) {
      const unique = [...new Set(phases.map(value => value.phase))];
      assert.deepEqual(unique, ['policy_read', 'policy_write', 'notifications_write', 'notifications_read',
        'window_inventory', 'tab_inventory', 'tab_cleanup', 'auth', 'window', 'blank_commit',
        'debugger_attach', 'initial_navigation', 'auth_snapshot', 'ready']);
      for (const value of phases) assert.deepEqual(Object.keys(value), ['kind', 'phase']);
    } else assert.deepEqual(phases, []);
    assert.deepEqual(worker.navigation, ['about:blank', 'https://example.test/']);
    assert.equal(worker.sent.filter(value => value.kind === 'hello').length, 1);
    assert.equal(worker.connections(), 1);
  }
});

test('a cold pending policy read reports its phase when the original socket opens without another API attempt', async () => {
  let release, reads = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const worker = await dialogWorker({ fixtureOnly: true, deferAuthentication: true,
    policyRead: async () => { reads++; await pending; } });
  assert.equal(reads, 1);
  assert.equal(worker.sent.filter(value => value.kind === 'startup_fixture_stage').at(-1).phase, 'policy_read');
  assert.deepEqual(worker.navigation, []);
  assert.equal(worker.sent.some(value => value.kind === 'hello'), false);
  release(); await new Promise(resolve => setImmediate(resolve));
  await worker.dispatch('restore-session-auth', { cookies: [], replace: false });
  // The second ordinary policy installation admits the exact debugger-guarded
  // tab. It is independent of the first pending call and is not a retry.
  assert.equal(reads, 2);
  assert.equal(worker.sent.filter(value => value.kind === 'hello').length, 1);
});

test('the exact owned bootstrap page is reused only after policy/auth and commits blank before provider navigation', async () => {
  const worker=await dialogWorker({bootstrapUrl:'chrome-extension://fixture/bootstrap.html'});
  assert.deepEqual(worker.navigation,['about:blank','https://example.test/']);
  assert.ok(worker.sent.some(value=>value.kind==='hello'));
  assert.equal((await worker.dispatch('read-text')).state,'ready');
});

const nativeReceiverTransitions = [
  'Could not establish connection. Receiving end does not exist.',
  'The message port closed before a response was received.',
  'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
  'The page keeping the extension port is moved into back/forward cache, so the message channel is closed.',
];
for (const [index, expected] of nativeReceiverTransitions.entries()) test(`authentication maps only native receiver transition ${index} from a top-frame probe`, async () => {
  let nativeError = expected, reads = 0, writes = 0;
  const worker = await dialogWorker({ authenticationMessage(message, target) {
    assert.equal(target.frameId, 0);
    if (message.kind === 'authentication-probe') reads++;
    else if (['authentication-fill', 'authentication-follow'].includes(message.kind)) writes++;
    else assert.fail(message.kind);
    throw Error(nativeError);
  } });
  assert.equal((await worker.dispatch('authentication-start')).state, 'connected');
  assert.deepEqual(await worker.dispatch('authentication-probe'), { state: 'error', reason: 'authentication_document_transition' });
  assert.deepEqual(await worker.dispatch('authentication-fill'), { state: 'error', reason: 'operation_failed' });
  assert.deepEqual(await worker.dispatch('authentication-follow'), { state: 'error', reason: 'operation_failed' });
  nativeError = 'PRIVATE_PROVIDER_ERROR';
  assert.deepEqual(await worker.dispatch('authentication-probe'), { state: 'error', reason: 'operation_failed' });
  assert.equal(reads, 2); assert.equal(writes, 2);
  assert.doesNotMatch(JSON.stringify(worker.sent), /PRIVATE_PROVIDER_ERROR|Receiving end|back\/forward cache/);
});

// Compose the materialised extension with the actual attempt controller. A
// worker-only mapping test cannot prove that the closed receiver result waits
// under the original clock, preserves the durable fence and never fills twice.
for (const mode of ['after_ack', 'initial', 'input_unknown', 'persistent', 'foreign_error']) test(`native BFCache receiver handling preserves the authentication attempt: ${mode}`, async () => {
  const origin = 'https://example.test';
  const definition = normalizeVisualAuthentication({ steps: [{ id: 'password', origin,
    challenge: '#login-form', fields: { password: '#password' }, submit: '#submit' }],
    success: [{ origin, selector: '#account' }] }, { origins: [origin] });
  let saved = { schemaVersion: 1, fingerprint: visualAuthenticationFingerprint(definition),
    login: '', password: 'SYNTHETIC_PASSWORD', totp: '', attempt: null };
  const store = { async readCredentials() { return structuredClone(saved); },
    async writeCredentials(value) { saved = structuredClone(value); } };
  let fills = 0, probes = 0, transitions = 0, clock = 60_000;
  const worker = await dialogWorker({ authenticationMessage(message, target) {
    assert.equal(target.frameId, 0);
    if (message.kind === 'authentication-fill') {
      fills++;
      assert.equal(saved.attempt.state, 'pending');
      assert.deepEqual(saved.attempt.steps, ['password']);
      if (mode === 'input_unknown') throw Error(nativeReceiverTransitions[3]);
      return { state: 'submitted' };
    }
    assert.equal(message.kind, 'authentication-probe'); probes++;
    if (!fills && mode !== 'initial') return { state: 'challenge', stepId: 'password', documentId: randomUUID() };
    if (mode === 'foreign_error') throw Error('PRIVATE_LOOKALIKE: ' + nativeReceiverTransitions[3]);
    if (mode !== 'after_ack' || transitions++ < 2) throw Error(nativeReceiverTransitions[3]);
    return { state: 'success' };
  } });
  assert.equal((await worker.dispatch('authentication-start')).state, 'connected');
  const run = () => authenticateVisualBrowser({ definition, store, active() {},
    now: () => clock, wait: async ms => { clock += ms; }, send: worker.dispatch });
  if (mode === 'after_ack') {
    assert.equal((await run()).state, 'saved_unverified');
    assert.equal(fills, 1); assert.equal(probes, 4); assert.equal(clock, 60_600);
    assert.equal(saved.attempt.state, 'complete');
  } else if (mode === 'persistent') {
    assert.equal((await run()).reason, 'authentication_unknown');
    assert.equal(clock, 90_000, 'the original thirty-second attempt deadline is not renewed');
    assert.equal(saved.attempt.state, 'pending'); assert.equal(fills, 1);
    await assert.rejects(run(), { code: 'authentication_unknown' });
    assert.equal(fills, 1, 'restart cannot consume the input twice');
  } else {
    await assert.rejects(run(), { code: 'authentication_unknown' });
    assert.equal(fills, mode === 'initial' ? 0 : 1);
    assert.equal(probes, mode === 'foreign_error' ? 2 : 1);
    assert.equal(saved.attempt?.state ?? null, mode === 'initial' ? null : 'pending');
  }
  assert.doesNotMatch(JSON.stringify(worker.sent), /SYNTHETIC_PASSWORD|PRIVATE_LOOKALIKE|back\/forward cache/);
});

test('a stalled native capture marks the original navigation before it can reply, only in synthetic fixtures', async () => {
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; });
  const stalled = new Promise(resolve => { resume = resolve; });
  const worker = await dialogWorker({ image: true, fixtureOnly: true, screenshot: () => { enter(); return stalled; } });
  const request = worker.dispatch('navigate', { url: 'https://example.test/second' });
  try {
    await entered;
    const trace = worker.sent.filter(value => value.kind === 'navigation_fixture_stage');
    assert.deepEqual(trace.map(value => value.phase), ['received', 'dequeued', 'policy_queue', 'navigate_tab',
      'navigate_attach', 'navigate_update', 'navigate_settle', 'observe_tab', 'document_load', 'observe_attach',
      'frame_tree', 'credential_guard', 'layout', 'compositor_capture']);
    assert.equal(new Set(trace.map(value => value.id)).size, 1);
    assert.ok(trace.every(value => Object.keys(value).sort().join() === 'id,kind,phase'));
    assert.equal(worker.sent.some(value => value.kind === 'result' && value.id === trace[0].id), false);
  } finally { resume(); }
  assert.equal((await request).state, 'ready');
  assert.equal(worker.navigation.filter(url => url.endsWith('/second')).length, 1, 'the original update occurs once');
  const ordinary = await dialogWorker({ image: true });
  assert.equal((await ordinary.dispatch('navigate', { url: 'https://example.test/second' })).state, 'ready');
  assert.equal(ordinary.sent.some(value => value.kind === 'navigation_fixture_stage'), false);
});

// A fresh host navigate calls one of these reads after the one startup
// navigation. Exercise the actual materialised worker while its original
// native read is pending; a source-text assertion would miss a dropped
// callback between execute and the screenshot/rendered-text implementation.
for (const operation of ['screenshot', 'read-text']) test(`a fresh ${operation} retains its own stalled observation phase without another navigation`, async () => {
  let enter, resume, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const stalled = new Promise(resolve => { resume = resolve; });
  const read = () => { calls++; enter(); return stalled; };
  const image = operation === 'screenshot';
  const worker = await dialogWorker({ image, fixtureOnly: true, ...(image ? { screenshot: read } : { textObservation: read }) });
  const request = worker.dispatch(operation);
  try {
    await entered;
    const trace = worker.sent.filter(value => value.kind === 'navigation_fixture_stage');
    assert.deepEqual(trace.map(value => value.phase), ['received', 'dequeued', 'policy_queue', 'observe_tab',
      'document_load', 'observe_attach', 'frame_tree', ...(image ? ['credential_guard'] : []), 'layout',
      image ? 'compositor_capture' : 'text_read']);
    assert.equal(new Set(trace.map(value => value.id)).size, 1);
    assert.ok(trace.every(value => Object.keys(value).sort().join() === 'id,kind,phase'));
    assert.equal(worker.sent.some(value => value.kind === 'result' && value.id === trace[0].id), false);
  } finally { resume(); }
  assert.equal((await request).state, 'ready');
  assert.equal(calls, 1);
  assert.deepEqual(worker.navigation, ['https://example.test/']);
  assert.equal(worker.counts().clicks, 0);
  const ordinary = await dialogWorker({ image });
  assert.equal((await ordinary.dispatch(operation)).state, 'ready');
  assert.equal(ordinary.sent.some(value => value.kind === 'navigation_fixture_stage'), false);
});

for (const stalledPhase of ['input_mouse_wheel', 'compositor_capture']) test(`one scroll retains its original stalled ${stalledPhase} without input replay`, async () => {
  let enter, resume, armed = false, captures = 0, wheels = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const stalled = new Promise(resolve => { resume = resolve; });
  const worker = await dialogWorker({ image: true, fixtureOnly: true,
    mouseWheel() { wheels++; if (stalledPhase === 'input_mouse_wheel') { enter(); return stalled; } },
    screenshot() { captures++; if (armed && stalledPhase === 'compositor_capture') { enter(); return stalled; } },
  });
  const first = await worker.dispatch('screenshot'); armed = true; worker.sent.length = 0;
  const request = worker.dispatch('scroll', { frameId: first.frameId, x: 30, y: 40, deltaY: 100 });
  try {
    await entered;
    const trace = worker.sent.filter(value => value.kind === 'navigation_fixture_stage');
    assert.equal(trace.at(-1).phase, stalledPhase);
    assert.equal(new Set(trace.map(value => value.id)).size, 1);
    assert.ok(trace.every(value => Object.keys(value).sort().join() === 'id,kind,phase'));
    assert.ok(trace.some(value => value.phase === 'input_mouse_wheel'));
    assert.equal(worker.sent.some(value => value.kind === 'result'), false);
    assert.equal(wheels, 1);
    assert.equal(captures, stalledPhase === 'input_mouse_wheel' ? 1 : 2);
  } finally { resume(); }
  assert.equal((await request).state, 'ready');
  assert.equal(wheels, 1); assert.equal(captures, 2);
  assert.deepEqual(worker.navigation, ['https://example.test/']);
  const ordinary = await dialogWorker({ image: true });
  const frame = await ordinary.dispatch('screenshot');
  assert.equal((await ordinary.dispatch('scroll', { frameId: frame.frameId, x: 30, y: 40, deltaY: 100 })).state, 'ready');
  assert.equal(ordinary.sent.some(value => value.kind === 'navigation_fixture_stage'), false);
});

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
    for (let i = 0; i < 30; i++) { await tick(); const item = sent.find(value => value.kind === 'result' && value.id === id); if (item) return item.result; }
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
  let rules = [], continuations = 0;
  const cdn = 'https://files.download.test/export?sig=PRIVATE_REDIRECT_ID';
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
          if (method === 'Fetch.continueRequest' && args.requestId === 'network-redirect') {
            const exemptions = rules.filter(rule => rule.condition.tabIds);
            assert.equal(exemptions.length, 1);
            const condition = exemptions[0].condition;
            assert.deepEqual(JSON.parse(JSON.stringify(condition.tabIds)), [1]);
            assert.deepEqual(JSON.parse(JSON.stringify(condition.requestMethods)), ['get']);
            assert.equal(condition.isUrlFilterCaseSensitive, true);
            assert.match(cdn, new RegExp(condition.regexFilter));
            assert.doesNotMatch(cdn + '&unreviewed=1', new RegExp(condition.regexFilter));
            continuations++;
            queueMicrotask(() => nativeEvent({ tabId: 1 }, 'Fetch.requestPaused', {
              requestId: 'redirect-body', frameId: 'main', resourceType: 'Document', request: { url: cdn, method: 'GET' },
              responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: mode === 'cdn-html' ? 'text/html' : 'text/csv' }],
            }));
          }
          return {};
        } },
      webRequest: { onBeforeRequest: events, onHeadersReceived: events }, cookies: { onChanged: events, async getAll() { return []; } },
      declarativeNetRequest: {
        async getSessionRules() { return rules; },
        async updateSessionRules(update) { rules = update.addRules; },
        async isRegexSupported() { return { isSupported: true }; },
      },
      windows: { onCreated: events, onRemoved: events, async getAll() { return [{ id: 1 }]; } },
      tabs: { onCreated: events, onRemoved: events,
        async query() { return [{ id: 1, url: currentUrl, status: 'complete' }]; },
        async get() { return { id: 1, url: currentUrl, status: 'complete' }; },
        async update(_id, input) {
          currentUrl = input.url || currentUrl;
          if (currentUrl === 'https://example.test/original') {
            routed.push(currentUrl);
            const redirect = mode.startsWith('cdn');
            queueMicrotask(() => nativeEvent({ tabId: 1 }, 'Fetch.requestPaused', {
              requestId: redirect ? 'network-redirect' : 'guarded-original', frameId: 'main', resourceType: 'Document',
              request: { url: currentUrl, method: 'GET' }, responseStatusCode: redirect ? 307 : 200,
              responseHeaders: redirect ? [{ name: 'Location', value: mode === 'cdn-foreign' ? cdn.replace('download.test', 'download.test.other') : cdn }]
                : [{ name: 'Content-Type', value: 'application/octet-stream' }],
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
    attachmentDownloads: true, attachmentRedirectDomains: ['download.test'], deadlineAt: Date.now() + 10_000 }, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); socket.onopen(); let sequence = 0;
  const dispatch = async (operation, args = {}) => {
    const id = String(++sequence); socket.onmessage({ data: JSON.stringify({ id, operation, args }) });
    for (let i = 0; i < 40; i++) { await tick(); const result = sent.find(value => value.kind === 'result' && value.id === id); if (result) return result.result; }
    throw Error('synthetic_command_timeout');
  };
  await dispatch('restore-session-auth', { cookies: [], replace: false });
  for (const [next, reason] of [['main', null], ['iframe', null], ['post', 'attachment_link_required'],
    ['foreign', 'attachment_link_required'], ['navigate', 'stale_frame'], ['cdn', null],
    ['cdn-html', 'attachment_unsupported'], ['cdn-foreign', 'navigation_blocked']]) {
    mode = next;
    const frame = await dispatch('read-text'), args = { frameId: frame.frameId, x: 10, y: 20 };
    assert.equal(frame.state, 'ready', JSON.stringify({ mode, reason: frame.reason }));
    const result = await dispatch('download-attachment', args);
    if (reason) { assert.equal(result.reason, reason); assert.equal(result.file, undefined); }
    else { assert.equal(result.state, 'ready', JSON.stringify({ mode, reason: result.reason, clicks, reads, routedCount: routed.length, stages })); assert.equal(result.file.dataBase64, 'AQID'); }
    assert.equal(stages.at(-1), 'Response', 'request-stage routing is revoked after every result/refusal');
    assert.equal(rules.some(rule => rule.condition.tabIds), false, 'transient destination authority is revoked after the request');
    assert.equal((await dispatch('download-attachment', args)).reason, 'stale_frame', 'the original click token cannot replay');
  }
  assert.equal(clicks, 8); assert.equal(reads, 3); assert.equal(routed.length, 5, 'POST/foreign/stale clicks never reach the receiver');
  assert.equal(continuations, 2);
  assert.equal((await dispatch('navigate', { url: cdn })).reason, 'navigation_blocked');
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
    for (let i = 0; i < 30; i++) { await tick(); const item = sent.find(value => value.kind === 'result' && value.id === id); if (item) return item.result; }
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
  }, WebSocket: class { static OPEN = 1; constructor() { socket = this; this.readyState = 1; } send(value) { sent.push(JSON.parse(value)); } close() { this.readyState = 3; this.onclose?.(); } } };
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
  const screenshot = await dispatch('screenshot');
  assert.equal(screenshot.reason, 'manual_control_active');
  assert.equal(JSON.stringify(screenshot).includes('SYNTHETIC_PRIVATE_AUTH'), false);
  tabRemoved(2, { isWindowClosing: true, windowId: 2 });
  live = []; cookieChanged({ removed: true, cause: 'explicit', cookie });
  windows = []; windowRemoved(2); await tick();
  // The final private payload must be delivered before the transport closes;
  // a stopped browser cannot accept a new snapshot command as evidence.
  const finalAuth = sent.filter(message => message.kind === 'session_auth').at(-1);
  assert.equal(finalAuth.cookies.length, 1, 'browser profile-end cleanup cannot erase a completed manual login');
  assert.equal(sent.at(-1).kind, 'windows_closed');
  assert.equal(socket.readyState, 3);
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


for(const manual of [true,false])test(`last native window drains auth and stops transport without reconnect: manual=${manual}`,async()=>{
  const worker=await dialogWorker({manual});
  worker.addWindow(2);worker.removeWindow(2);
  assert.equal(worker.transport.includes('transport_closed'),false,'another native window still exists');
  const before=worker.transport.length;
  worker.removeWindow(1);
  assert.deepEqual(worker.transport.slice(before),['session_auth','windows_closed','transport_closed']);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(worker.connections(),1,'intentional shutdown never revives the extension transport');
  assert.deepEqual(worker.counts(),{clicks:0,keys:0,keyUps:0,reads:0},'shutdown never repeats provider input');
});

test('ordinary transport reconnect stays available, but its queued timer cannot revive a stopped browser',async()=>{
  const ordinary=await dialogWorker();ordinary.disconnect();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(ordinary.connections(),2,'normal network reconnection is unchanged');
  ordinary.removeWindow(1);
  const stopped=await dialogWorker();stopped.disconnect();stopped.removeWindow(1);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(stopped.connections(),1,'already scheduled reconnect is fenced at dispatch');
});

// No website-specific hostname list: the manual profile login can traverse
// unfamiliar SSO and non-HTML responses without a renderer/MIME gate.
test('manual profile authentication leaves website traffic to Chromium and restores work guards afterwards', async () => {
  const worker = await dialogWorker({ manual: true, profileAuthentication: true });
  assert.equal(worker.networkRules.at(-1).addRules.length, 0);
  assert.equal(worker.nativeCommands.some(value => value.method === 'Fetch.enable'), false);
  assert.equal((await worker.dispatch('screenshot')).reason, 'manual_control_active');
  assert.equal((await worker.dispatch('ready')).state, 'saved_unverified');
  assert.ok(worker.networkRules.at(-1).addRules.some(rule => rule.action.type === 'block'));
});
