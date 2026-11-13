import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ExtensionVisualBrowser, visualLifecycleFailureEvidence, visualExtensionBootstrapPage } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';
import { loadVisualDependencies } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { createVisualOriginPolicy } from '../host-runtime/scripts/trelio-visual-browser.mjs';
import { ownFixtureHttpServer } from './fixtures/visual-owned-http.mjs';
import { syntheticDocx } from './fixtures/visual-docx.mjs';
import vm from 'node:vm';

test('extension bootstrap sends exactly one value-free wake event without a network request or retry', async () => {
  const page=visualExtensionBootstrapPage(),messages=[];
  assert.match(page.url,/^chrome-extension:\/\/[a-p]{32}\/bootstrap\.html$/u);
  assert.equal(page.html,'<!doctype html><meta charset="utf-8"><script src="bootstrap.js" defer></script>');
  vm.runInNewContext(page.script,{chrome:{runtime:{sendMessage:async message=>{
    messages.push(JSON.parse(JSON.stringify(message)));throw Error('synthetic unavailable receiver');
  }}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(messages,[{kind:'trelio_visual_bootstrap'}]);
  assert.doesNotMatch(page.html+page.script,/https?:|WebSocket|fetch|token|password|setTimeout|setInterval/u);
});

test('lifecycle failure callbacks contain closed original errno/syscall only, never native errors or profile data', () => {
  const error = Object.assign(new Error('PRIVATE_ERROR_PROSE'), { code: 'EBUSY', syscall: 'rmdir',
    path: 'PRIVATE_PROFILE_PATH', cookie: 'PRIVATE_AUTH_VALUE', diagnostic: { causeCode: 'SECRET' } });
  assert.deepEqual(visualLifecycleFailureEvidence(error), { causeCode: 'EBUSY', ioOperation: 'rmdir' });
  assert.deepEqual(visualLifecycleFailureEvidence({ code: 'VISUAL_STORAGE_CONFLICT', syscall: 'UNKNOWN_PRIVATE_OP' }),
    { causeCode: 'UNKNOWN', storageCode: 'VISUAL_STORAGE_CONFLICT' });
  assert.deepEqual(visualLifecycleFailureEvidence({ code: 'operation_failed', syscall: 'PRIVATE_OP', message: 'PRIVATE' }),
    { causeCode: 'UNKNOWN', reason: 'operation_failed' });
  assert.doesNotMatch(JSON.stringify(visualLifecycleFailureEvidence(error)), /PRIVATE|SECRET|path|cookie|message|stack/u);
});

test('native alert/confirm is observed and answered without replay in text/image modes and restored profiles deny notifications', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-native-dialog-')));
  const effects = []; let snapshot, browser, clickStarts = 0;
  t.signal.addEventListener('abort', () => browser?.abort(), { once: true });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    if (url.pathname === '/click-start') { clickStarts++; response.end(); return; }
    if (url.pathname === '/effect') { effects.push({ answer: url.searchParams.get('answer'), count: url.searchParams.get('count'), permission: url.searchParams.get('permission') }); response.end(); return; }
    const left = url.searchParams.get('layout') === 'offset' ? 220 : 20;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Native dialog fixture</title><body>
      <p>Notification state: <span id="permission"></span></p>
      <button style="position:absolute;left:${left}px;top:100px;width:300px;height:60px" onclick="
        window.clicks=(window.clicks||0)+1;
        navigator.sendBeacon('/click-start');
        const accepted=confirm('Synthetic confirm?');
        alert('Synthetic follow-up alert');
        fetch('/effect?answer='+accepted+'&amp;count='+window.clicks+'&amp;permission='+Notification.permission);
        document.getElementById('result').textContent='ORIGINAL_ACTION_FINISHED';">Open confirm</button>
      <p id="result" style="position:absolute;top:200px"></p>
      <button style="position:absolute;left:${left}px;top:300px;width:300px;height:60px"
        onclick="prompt('PRIVATE_UNSUPPORTED_PROMPT','PRIVATE_DEFAULT')">Open unsupported prompt</button>
      <script>document.getElementById('permission').textContent=Notification.permission;</script>`);
  });
  const listener = ownFixtureHttpServer(server, t.signal); t.after(() => listener.stop()); await listener.listen();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const store = { directory, async read() { return snapshot; }, async prepare() {}, async write(value) { snapshot = structuredClone(value); }, close() {} };
  const ready = value => { assert.equal(value.state, 'ready', JSON.stringify({ state: value.state, reason: value.reason })); return value; };
  const click = (view, observationMode, label, imagePoint) => {
    if (observationMode === 'image') return browser.call('click', { frameId: view.frameId, ...imagePoint });
    // The text fixture consumes the actual viewport hit target from the
    // renderer. Hard-coded offsets can point to another layer or miss the
    // control on a different hosted display. The one native click and every
    // dialog/effect assertion are unchanged. No click retry is allowed.
    const targets = view.controls.filter(control => control.role === 'button' && control.label === label);
    assert.equal(targets.length, 1, 'fixture button must be a unique observed hit target');
    const [{ x, y }] = targets;
    assert.ok(Number.isInteger(x) && x >= 0 && x < view.width
      && Number.isInteger(y) && y >= 0 && y < view.height, 'observed target is inside the exact viewport');
    return browser.call('click', { frameId: view.frameId, x, y });
  };
  try {
    for (const observationMode of ['text', 'image']) {
      browser = new ExtensionVisualBrowser({ dependencies, store, observationMode,
        policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin],
        lease: { deadlineAt: Date.now() + 75_000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1' });
      const url = observationMode === 'text' ? origin + '/?layout=offset' : origin;
      let view = ready(await browser.call('navigate', { url }));
      if (observationMode === 'text') assert.match(view.text, /Notification state:\s+denied/);
      view = ready(await click(view, observationMode, 'Open confirm', { x: 100, y: 125 }));
      if (observationMode === 'text') assert.match(view.text, /Synthetic confirm/, JSON.stringify({ phase: 'confirm', clickStarts, effects: effects.length }));
      else { assert.ok(view.image); assert.equal(view.text, undefined); }
      const spent = view.frameId;
      view = ready(await browser.call('key', { frameId: view.frameId, key: 'Escape' }));
      if (observationMode === 'text') assert.match(view.text, /Synthetic follow-up alert/);
      else assert.ok(view.image);
      assert.notEqual(view.frameId, spent);
      view = ready(await browser.call('key', { frameId: view.frameId, key: 'Enter' }));
      if (observationMode === 'text') assert.match(view.text, /ORIGINAL_ACTION_FINISHED/);
      else assert.ok(view.image);
      assert.equal((await browser.call('key', { frameId: spent, key: 'Enter' })).state, 'error');
      const expected = observationMode === 'text' ? 1 : 2;
      for (let attempt = 0; effects.length < expected && attempt < 40; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(effects.length, expected);
      assert.deepEqual(effects.at(-1), { answer: 'false', count: '1', permission: 'denied' });
      const unsupported = await click(view, observationMode, 'Open unsupported prompt', { x: 100, y: 325 });
      assert.equal(unsupported.state, 'manual_input_required');
      assert.equal((await browser.call('status')).state, 'manual_input_required');
      assert.doesNotMatch(JSON.stringify(unsupported), /PRIVATE_/);
      await browser.close(); browser = undefined;
      assert.ok(snapshot, 'the second mode exercises an actually restored profile');
    }
  } finally {
    await listener.stop(); await browser?.close().catch(() => browser.abort());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('a linked HTML office viewer exposes safe menus and downloads the complete DOCX from one native iframe/same-tab GET', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-docx-viewer-')));
  const docx = syntheticDocx(), hits = [], evidence = [], observations = [];
  let mode = 'not_started', phase = 'not_started';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    if (url.pathname === '/original') {
      hits.push(request.method);
      response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename=untrusted-original.docx', 'Content-Length': docx.length });
      response.end(docx); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/preview') {
      const action = url.searchParams.get('mode') === 'iframe'
        ? "const f=document.createElement('iframe');f.hidden=true;document.body.append(f);f.src='/original'"
        : "location.href='/original'";
      response.end(`<!doctype html><title>Synthetic original.docx - Google Docs</title><body style="font:24px sans-serif">
        <h1>SYNTHETIC_VIEWER_REMAINS</h1>
        ${Array.from({ length: 45 }, (_, i) => `<button style="position:absolute;left:${500 + i % 10 * 70}px;top:${350 + Math.floor(i / 10) * 40}px">Tool ${i}</button>`).join('')}
        <div role="menuitem" style="position:absolute;left:20px;top:100px" onclick="document.getElementById('download').hidden=false">File</div>
        <div role="menuitem" aria-disabled="true" style="position:absolute;left:300px;top:100px">DISABLED_MENU</div>
        <div id="download" role="menuitem" hidden style="position:absolute;left:20px;top:150px" onclick="document.getElementById('word').hidden=false">Download</div>
        <div id="word" role="menuitem" hidden style="position:absolute;left:20px;top:200px" onclick="if(confirm('Download the selected original?')){${action}}">Microsoft Word (.docx)</div>`); return;
    }
    response.end(`<!doctype html><title>Synthetic article</title><body style="font:24px sans-serif">
      <a href="/preview?mode=${url.searchParams.get('mode') || 'iframe'}" style="position:absolute;left:20px;top:80px">Original DOCX</a>`);
  });
  const listener = ownFixtureHttpServer(server, t.signal);
  t.after(() => listener.stop());
  await listener.listen();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  // Exercise the actual signed hidden route used by digital assistants, even
  // on a headed CI desktop. A native confirm is allowed to activate a windowed
  // Chromium; the background route must preserve foreground through BOTH the
  // confirmation and the original download, with no Save As or second GET.
  const browser = new ExtensionVisualBrowser({ dependencies, observationMode: 'text', attachmentDownloads: true, presentation: 'hidden',
    testDiagnostics: value => evidence.push(value),
    store: { directory, async read() {}, async prepare() {}, async write() {}, close() {} },
    policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin],
    lease: { deadlineAt: Date.now() + 165_000 } });
  const focus = () => process.platform === 'darwin' && process.env.TRELIO_VISUAL_EXTENSION_HEADED === '1'
    ? execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim() : null;
  const control = (view, label) => { const matches = view.controls.filter(c => c.label === label); assert.equal(matches.length, 1, label);
    return { frameId: view.frameId, x: matches[0].x, y: matches[0].y }; };
  // A missing menu previously left only the browser's lifecycle evidence ([]
  // when startup itself succeeded). Retain the ORIGINAL action's already
  // validated response so a failed File click can be distinguished from an
  // error response, stale frame or incomplete rendered-controls observation.
  // Only fixed fixture phases, closed public state/reason, counts and boolean
  // comparisons leave the fixture: never text, labels, URLs, frame IDs, private
  // paths or file receipts. This adds no browser call, wait, input retry or
  // readiness inference, and the strict unique-control assertion stays intact.
  const call = async (nextPhase, operation, args) => {
    phase = nextPhase;
    const view = await browser.call(operation, args);
    const count = label => view.controls?.filter(c => c.label === label).length ?? null;
    observations.push({ phase, mode, state: view.state, reason: view.reason,
      textObservation: view.kind === 'trelio.browser-text/v1',
      controlCount: view.controls?.length ?? null,
      fileMenuCount: count('File'), downloadMenuCount: count('Download'), wordMenuCount: count('Microsoft Word (.docx)'),
      disabledMenuCount: count('DISABLED_MENU'), viewerTitle: /\.docx/u.test(view.title || ''),
      frameChanged: args?.frameId ? typeof view.frameId === 'string' && view.frameId !== args.frameId : null,
      requestCount: hits.length });
    return view;
  };
  try {
    for (mode of ['iframe', 'main']) {
      let view = await call('article', 'navigate', { url: origin + '/?mode=' + mode });
      assert.equal(view.state, 'ready', view.reason);
      const before = focus();
      view = await call('viewer', 'download-attachment', control(view, 'Original DOCX'));
      assert.equal(view.kind, 'trelio.browser-text/v1', 'an HTML viewer is not a file receipt');
      assert.match(view.title, /\.docx/); assert.equal(view.controls.some(c => c.label === 'DISABLED_MENU'), false);
      view = await call('file_menu', 'click', control(view, 'File'));
      view = await call('download_menu', 'click', control(view, 'Download'));
      const confirmation = await call('original', 'download-attachment', control(view, 'Microsoft Word (.docx)'));
      assert.match(confirmation.text, /Download the selected original/);
      const file = await call('confirm_original', 'key', { frameId: confirmation.frameId, key: 'Enter' });
      assert.equal(file.state, 'ready', JSON.stringify({ mode, reason: file.reason, requestCount: hits.length }));
      assert.equal(file.kind, 'trelio.browser-file/v1'); assert.equal(path.extname(file.filePath), '.docx');
      assert.deepEqual(await fs.readFile(file.filePath), docx); assert.equal(file.sha256, createHash('sha256').update(docx).digest('hex'));
      assert.doesNotMatch(JSON.stringify(file), /untrusted-original|Content-Disposition|\/original|dataBase64/);
      view = await call('retained_viewer', 'read-text'); assert.match(view.text, /SYNTHETIC_VIEWER_REMAINS/);
      if (before) assert.equal(focus(), before, 'viewer download never opens Save As or changes foreground');
    }
    assert.deepEqual(hits, ['GET', 'GET'], 'each UI download performs one actual GET; paused originals are not replayed');
    phase = 'close'; await browser.close();
  } catch (error) { t.diagnostic(JSON.stringify({ phase, mode, observations, requestCount: hits.length, native: evidence })); throw error; } finally {
    await listener.stop();
    await browser.close().catch(() => browser.abort());
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('voice players deliver the complete HTTP/blob original through the audio-only path without replacing the chat or replay', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-voice-browser-')));
  // Real playable PCM, not an external recording, network fixture or company
  // data. The player may be detached and construct its blob only AFTER click.
  const bytes = Buffer.alloc(16044); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  // Public synthetic 250-ms mono silence, generated with FFmpeg's anullsrc
  // + AAC at 8 kHz/24 kbit and bitexact flags; no real recording or site data.
  // Unlike a box-only parser fixture, this exercises an actually playable
  // AAC-in-M4A source through native play, HTTP and lazy same-document blob.
  const m4a = Buffer.from('AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAtZtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAB9AAAAH0AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACJXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAH0AAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAB9AAAAQAAAEAAAAAAZ1tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAB9AAAAL0FXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAFIbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEMc3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAB9AAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAF3AAAAA/QWAgIAFFYhW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAAAgAABAAAAAABAAAD0AAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAUc3RzegAAAAAAAAAEAAAAAwAAABRzdGNvAAAAAAAAAAEAAAMCAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAAAMAAAABAAAAPXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdAAAAAhmcmVlAAAAFG1kYXQBGCAHARggBwEYIAc=', 'base64');
  let clicks = 0, foreignRequests = 0, snapshot;
  const server = http.createServer((request, response) => {
    if (request.url === '/clicked') { clicks++; response.end(); return; }
    if (request.url === '/voice') { response.setHeader('Content-Type', 'audio/wav'); response.end(bytes); return; }
    if (request.url === '/codec-labelled') { response.setHeader('Content-Type', 'audio/aac'); response.end(m4a); return; }
    if (request.url === '/foreign') { foreignRequests++; response.writeHead(302, { Location: 'http://127.0.0.1:1/not-allowed' }); response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><body style="font:24px sans-serif">
      <h1>Synthetic private chat</h1>
      <button onclick="fetch('/clicked');new Audio('/voice').play()">HTTP voice</button>
      <button onclick="fetch('/clicked');fetch('/voice').then(r=>r.blob()).then(b=>new Audio(window.URL.createObjectURL(b)).play()).catch(()=>{})">Blob voice</button>
      <button onclick="fetch('/clicked');new Audio('/codec-labelled').play().catch(()=>{})">M4A HTTP voice</button>
      <button onclick="fetch('/clicked');fetch('/codec-labelled').then(r=>r.blob()).then(b=>new Audio(window.URL.createObjectURL(b)).play()).catch(()=>{})">M4A blob voice</button>
      <button onclick="fetch('/clicked');new Audio('/foreign').play().catch(()=>{})">Unavailable voice</button>
      <audio controls src="/voice" style="position:absolute;left:20px;top:240px;width:300px;height:60px"></audio>`);
  });
  const ownedHttp = ownFixtureHttpServer(server, t.signal);
  t.after(() => ownedHttp.stop());
  await ownedHttp.listen();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const store = { directory, async read() { return snapshot; }, async prepare() {}, async write(value) { snapshot = structuredClone(value); }, close() {} };
  const diagnostics = [];
  const browser = new ExtensionVisualBrowser({ dependencies, store, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], audioDownloads: true, observationMode: 'text', lease: { deadlineAt: Date.now() + 150_000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1', testDiagnostics: value => diagnostics.push(value) });
  const abortOwned = () => browser.abort(); t.signal.addEventListener('abort', abortOwned, { once: true });
  const ready = value => { assert.equal(value.state, 'ready', JSON.stringify({ state: value.state, reason: value.reason, diagnostics })); return value; };
  const target = (frame, label) => {
    const controls = frame.controls.filter(value => value.role === 'button' && value.label === label);
    assert.equal(controls.length, 1); return { frameId: frame.frameId, x: controls[0].x, y: controls[0].y };
  };
  const focus = () => process.platform === 'darwin' && process.env.TRELIO_VISUAL_EXTENSION_HEADED === '1' ? execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim() : null;
  let primaryFailure;
  try {
    ready(await browser.call('navigate', { url: origin }));
    if (focus()) await new Promise(resolve => setTimeout(resolve, 1200));
    let frame = ready(await browser.call('read-text'));
    for (const [label, original, mimeType] of [['HTTP voice', bytes, 'audio/wav'], ['Blob voice', bytes, 'audio/wav'],
      ['M4A HTTP voice', m4a, 'audio/mp4'], ['M4A blob voice', m4a, 'audio/mp4']]) {
      const selected = target(frame, label), before = focus();
      const outcome = await browser.call('download-audio', selected);
      if (outcome.state !== 'ready') {
        const observed = await browser.call('read-text');
        assert.fail(JSON.stringify({ label, state: outcome.state, reason: outcome.reason, clicks, foreignRequests, chatRetained: observed.text?.includes('Synthetic private chat') === true, diagnostics }));
      }
      const receipt = ready(outcome);
      assert.equal(receipt.kind, 'trelio.browser-file/v1'); assert.equal(receipt.mimeType, mimeType);
      assert.equal(receipt.sizeBytes, original.length); assert.equal(receipt.sha256, createHash('sha256').update(original).digest('hex'));
      assert.deepEqual(await fs.readFile(receipt.filePath), original);
      assert.equal(path.extname(receipt.filePath), mimeType === 'audio/mp4' ? '.m4a' : '.wav');
      assert.equal(Object.keys(receipt).sort().join(), 'expiresAt,filePath,kind,mimeType,reason,sessionId,sha256,sizeBytes,state');
      if (before) assert.equal(focus(), before);
      assert.equal((await browser.call('download-audio', selected)).reason, 'stale_frame');
      frame = ready(await browser.call('read-text')); assert.ok(frame.text.includes('Synthetic private chat'));
    }
    assert.equal(clicks, 4, 'each lazy voice player is clicked exactly once');
    // Native <audio> can expose its source without clicking at all. Use its
    // known fixture box; text frames use the same CSS coordinate space.
    const receipt = ready(await browser.call('download-audio', { frameId: frame.frameId, x: 100, y: 270 }));
    assert.deepEqual(await fs.readFile(receipt.filePath), bytes); assert.equal(clicks, 4);
    frame = ready(await browser.call('read-text'));
    const unavailable = await browser.call('download-audio', target(frame, 'Unavailable voice'));
    assert.equal(unavailable.state, 'error'); assert.equal(unavailable.reason, 'attachment_link_required');
    assert.equal(clicks, 5); assert.ok(foreignRequests <= 1, 'source failure never replays the player');
    frame = ready(await browser.call('read-text')); assert.ok(frame.text.includes('Synthetic private chat'));
    assert.equal((await browser.call('download-audio', { ...target(frame, 'HTTP voice'), url: origin })).reason, 'invalid_input');
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    t.signal.removeEventListener('abort', abortOwned);
    if (primaryFailure || t.signal.aborted) browser.abort();
    await ownedHttp.stop();
    if (!primaryFailure && !t.signal.aborted) {
      await browser.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('outgoing chooser uploads original image, document, archive and arbitrary files without a native dialog or replay', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-upload-browser-')));
  const originals = path.join(directory, 'originals'); await fs.mkdir(originals, { mode: 0o700 });
  const received = [], clicks = [];
  const rendered = Promise.withResolvers();
  let snapshot;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/selected') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.end('ok'); return;
    }
    if (request.url === '/clicked') { clicks.push(true); response.end(); return; }
    if (request.url === '/rendered') { rendered.resolve(); response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><body style="margin:0;font:24px sans-serif">
      <button style="position:absolute;left:30px;top:40px;width:220px;height:60px" onclick="fetch('/clicked');document.getElementById('files').click()">Attach files</button>
      <button style="position:absolute;left:300px;top:40px;width:220px;height:60px" onclick="document.getElementById('single').click()">Single file</button>
      <input id="files" type="file" multiple hidden><input id="single" type="file" hidden>
      <p id="result" style="position:absolute;top:150px">No files selected</p>
      <script>
      for(const input of document.querySelectorAll('input')) input.onchange=async()=>{
        const selected=[];
        for(const file of input.files){
          const bytes=new Uint8Array(await file.arrayBuffer());
          selected.push({name:file.name,bytes:Array.from(bytes)});
        }
        await fetch('/selected',{method:'POST',body:JSON.stringify(selected)});
        document.getElementById('result').textContent=selected.map(file=>file.name).join(', ');
        await fetch('/rendered',{method:'POST'});
      };
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const store = { directory, async read() { return snapshot; }, async prepare() {}, async write(value) { snapshot = structuredClone(value); }, close() {} };
  const diagnostics = [];
  const browser = new ExtensionVisualBrowser({ dependencies, store, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }),
    origins: [origin], fileUploads: true, observationMode: 'text', lease: { deadlineAt: Date.now() + 150_000 },
    testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1', testDiagnostics: value => diagnostics.push(value) });
  const selected = [
    ['photo.png', Buffer.from('synthetic image bytes')],
    ['договор.docx', Buffer.from('synthetic document bytes')],
    ['archive.zip', Buffer.from('synthetic archive bytes')],
    ['unknown.bin', Buffer.from([0, 1, 2, 255])],
  ], files = [];
  for (const [name, bytes] of selected) { const file = path.join(originals, name); await fs.writeFile(file, bytes); files.push(file); }
  const ready = value => { assert.equal(value.state, 'ready', JSON.stringify({ state: value.state, reason: value.reason, diagnostics, clickCount: clicks.length, receivedCount: received.length })); return value; };
  // The fixture uses the SAME rendered-control observation available to a
  // text-mode agent. Fixed pixels assume a particular native viewport; use
  // this fresh frame's unique, hit-tested button centre instead. A missing
  // control fails before input, never by trying the upload a second time.
  const control = (frame, label) => {
    const matches = frame.controls.filter(value => value.role === 'button' && value.label === label);
    assert.equal(matches.length, 1, 'the fresh frame contains one synthetic upload control');
    return { frameId: frame.frameId, x: matches[0].x, y: matches[0].y };
  };
  const focus = () => process.platform === 'darwin' && process.env.TRELIO_VISUAL_EXTENSION_HEADED === '1'
    ? execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim() : null;
  try {
    let frame = ready(await browser.call('navigate', { url: origin }));
    if (focus()) await new Promise(resolve => setTimeout(resolve, 1200));
    frame = ready(await browser.call('read-text'));
    const before = focus(), attach = control(frame, 'Attach files');
    frame = ready(await browser.call('upload-files', { ...attach, files }));
    if (before) assert.equal(focus(), before, 'native file selection never activates a dialog or another app');
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], selected.map(([name, bytes]) => ({ name, bytes: [...bytes] })));
    assert.equal(clicks.length, 1);
    assert.equal((await browser.call('upload-files', { ...attach, files })).reason, 'stale_frame');
    assert.equal(received.length, 1, 'consumed input cannot repeat an upload');
    // A file chooser dispatch does not await the site's asynchronous change
    // handler or its upload response. The previous assertion raced that
    // response on ARM64: bytes had arrived, but the page had not rendered its
    // acknowledgement yet. Observe this synthetic site's explicit completion
    // once, then take a NEW read-only frame. Never repeat the chooser action,
    // relax the bytes/click/stale-token assertions or extend the browser lease.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic upload acknowledgement did not render.')), 5000);
      rendered.promise.then(() => { clearTimeout(timer); resolve(); });
    });
    frame = ready(await browser.call('read-text'));
    assert.ok(frame.text.includes('договор.docx'));
    assert.equal((await browser.call('upload-files', { ...control(frame, 'Attach files'), files: [originals] })).reason, 'upload_file_invalid');
    assert.equal(clicks.length, 1, 'invalid sources fail before the website is clicked');
    frame = ready(await browser.call('read-text'));
    assert.equal((await browser.call('upload-files', { ...control(frame, 'Single file'), files })).reason, 'upload_control_required');
    assert.equal(received.length, 1, 'multi-file selection never silently narrows to the first file');
    frame = ready(await browser.call('read-text'));
    ready(await browser.call('upload-files', { ...control(frame, 'Single file'), files: [files[1]] }));
    assert.deepEqual(received[1], [{ name: selected[1][0], bytes: [...selected[1][1]] }]);
    await browser.close();
    assert.deepEqual((await fs.readdir(directory)).sort(), ['originals'], 'owned staged copies disappear on normal close');
    for (const [index, [, bytes]] of selected.entries()) assert.deepEqual(await fs.readFile(files[index]), bytes);
  } finally {
    await browser.close().catch(() => browser.abort());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// Inspect only this file's synthetic fixture snapshot, never a real account.
// Closed counts distinguish persistence from browser startup loss; cookie
// values, ciphertext, paths and profile contents never enter the log.
async function fixtureCookieEvidence(snapshot, directory, name) {
  const files = JSON.parse(gunzipSync(Buffer.from(snapshot.profile, 'base64')));
  const cookie = files.find(file => file.path === 'Default/Network/Cookies') || files.find(file => file.path === 'Default/Cookies');
  const local = JSON.parse(Buffer.from(files.find(file => file.path === 'Local State')?.data || 'e30=', 'base64').toString());
  const prefs = JSON.parse(Buffer.from(files.find(file => file.path === 'Default/Preferences')?.data || 'e30=', 'base64').toString());
  const secure = JSON.parse(Buffer.from(files.find(file => file.path === 'Default/Secure Preferences')?.data || 'e30=', 'base64').toString());
  const result = { cookieFile: Boolean(cookie), networkStore: cookie?.path === 'Default/Network/Cookies', encryptedKey: Boolean(local.os_crypt?.encrypted_key), appBoundKey: Boolean(local.os_crypt?.app_bound_encrypted_key), startupPref: Number.isInteger(prefs.session?.restore_on_startup) ? prefs.session.restore_on_startup : null, secureStartupPref: Number.isInteger(secure.session?.restore_on_startup) ? secure.session.restore_on_startup : null };
  if (!cookie) return result;
  const file = path.join(directory, 'synthetic-cookie-evidence.sqlite');
  await fs.writeFile(file, Buffer.from(cookie.data, 'base64'), { mode: 0o600 });
  for (const suffix of ['-wal', '-shm']) {
    const extra = files.find(candidate => candidate.path === cookie.path + suffix);
    if (extra) await fs.writeFile(file + suffix, Buffer.from(extra.data, 'base64'), { mode: 0o600 });
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    result.count = db.prepare('SELECT count(*) AS count FROM cookies WHERE name = ?').get(name).count;
    result.persistentCount = db.prepare('SELECT count(*) AS count FROM cookies WHERE name = ?').get('fixture_persistent').count;
  }
  finally { db.close(); for (const suffix of ['', '-wal', '-shm']) await fs.rm(file + suffix, { force: true }); }
  return result;
}

// Execute the same real native browser assertions through both the unchanged
// headed/fixture path and the signed production hidden presentation. A fixture
// override alone cannot establish that a provider's ordinary path works.
for (const presentation of ['windowed', 'hidden']) test(presentation === 'windowed'
  ? 'ordinary Chromium extension clicks, types, scrolls and restores auth without a page-code reader'
  : 'signed hidden Chromium clicks, types, scrolls and restores auth through the production presentation', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-extension-fixture-')));
  const received = [], webdriverAtInput = [];
  let cookieRestored = false, persistentRestored = false, storageRestored = false, detailSeen = false, snapshot;
  const server = http.createServer((request, response) => {
    const u = new URL(request.url, 'http://127.0.0.1');
    if (u.pathname === '/typed') { received.push(u.searchParams.get('value')); webdriverAtInput.push(u.searchParams.get('webdriver')); response.end(); return; }
    if (u.pathname === '/storage') { if (u.searchParams.get('value') === 'SYNTHETIC_STORAGE') storageRestored = true; response.end(); return; }
    if (u.pathname === '/detail') detailSeen = true;
    if (request.headers.cookie?.includes('fixture_session=SYNTHETIC_COOKIE')) cookieRestored = true;
    if (request.headers.cookie?.includes('fixture_persistent=SYNTHETIC_PERSISTENT')) persistentRestored = true;
    if (u.pathname === '/login') response.setHeader('Set-Cookie', ['fixture_session=SYNTHETIC_COOKIE; HttpOnly; SameSite=Strict; Path=/', 'fixture_persistent=SYNTHETIC_PERSISTENT; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600']);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><body style="margin:0;background:#d6efde;font:24px sans-serif;${u.pathname === '/detail' ? '' : 'height:2400px'}"><input id="entry" style="position:absolute;left:40px;top:60px;width:360px;height:50px;font-size:24px"><button style="position:absolute;left:450px;top:60px;width:160px;height:55px" onclick="fetch('/typed?value='+encodeURIComponent(document.getElementById('entry').value)+'&webdriver='+navigator.webdriver)">Submit</button><a href="/detail" target="_blank" style="position:absolute;left:700px;top:60px">Detail</a><h1 style="position:absolute;top:180px">${u.pathname === '/detail' ? 'Detail fixture' : 'Input fixture'}</h1><script>${u.pathname === '/login' ? 'localStorage.setItem("fixture","SYNTHETIC_STORAGE");' : ''}fetch('/storage?value='+localStorage.getItem('fixture'))</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const store = { directory, async read() { return snapshot; }, async prepare() {}, async write(value) { snapshot = structuredClone(value); }, close() {} };
  const diagnostics = [];
  const create = () => new ExtensionVisualBrowser({ dependencies, store, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], presentation, lease: { deadlineAt: Date.now() + 150_000 }, testHeadless: presentation === 'windowed' && process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1', testDiagnostics: value => diagnostics.push(value) });
  let browser = create();
  const originalCall = ExtensionVisualBrowser.prototype.call;
  // A native headed Mac run independently samples the OS foreground identity.
  // Only the initial launch may change it; input/capture never restore another
  // app to conceal an activation. Samples contain no window title/page text.
  const focus = () => process.platform === 'darwin' && process.env.TRELIO_VISUAL_EXTENSION_HEADED === '1' ? execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim() : null;
  let focusChecks = 0;
  ExtensionVisualBrowser.prototype.call = async function(operation, args) {
    const before = focus(); const value = await originalCall.call(this, operation, args);
    if (before && ['click', 'key', 'type-text', 'scroll', 'screenshot'].includes(operation)) {
      assert.equal(focus(), before, `${operation} must preserve the foreground application`); focusChecks++;
    }
    return value;
  };
  const ready = value => { assert.equal(value.state, 'ready', JSON.stringify({ state: value.state, reason: value.reason, diagnostics })); return value; };
  try {
    const startupFocus = focus();
    let f = ready(await browser.call('navigate', { url: `${origin}/login` }));
    if (presentation === 'hidden' && startupFocus) assert.equal(focus(), startupFocus, 'hidden startup must preserve the foreground application');
    assert.equal(cookieRestored, true, 'the first document accepted its synthetic cookie before shutdown');
    // Chromium can finish its one permitted startup activation just after the
    // first picture. Sample input focus only after the app has settled.
    if (focus()) await new Promise(resolve => setTimeout(resolve, 1200));
    const original = f.frameId;
    // Coordinates come from this synthetic fixture's known rendered controls;
    // the production controller has no selector/evaluate/DOM-text command.
    f = ready(await browser.call('click', { frameId: f.frameId, x: 120, y: 85 }));
    f = ready(await browser.call('type-text', { frameId: f.frameId, text: 'Проверка ввода 123' }));
    f = ready(await browser.call('click', { frameId: f.frameId, x: 500, y: 85 }));
    assert.deepEqual(received, ['Проверка ввода 123']);
    assert.equal((await browser.call('click', { frameId: original, x: 500, y: 85 })).reason, 'stale_frame');
    assert.equal(received.length, 1);
    f = ready(await browser.call('screenshot'));
    f = ready(await browser.call('scroll', { frameId: f.frameId, x: 900, y: 500, deltaY: 600 }));
    assert.equal(f.scroll.up, true);
    f = ready(await browser.call('scroll', { frameId: f.frameId, x: 900, y: 500, deltaY: -900 }));
    f = ready(await browser.call('click', { frameId: f.frameId, x: 120, y: 85 }));
    f = ready(await browser.call('key', { frameId: f.frameId, key: process.platform === 'darwin' ? 'Meta+A' : 'Control+A' }));
    f = ready(await browser.call('type-text', { frameId: f.frameId, text: 'Второй ввод' }));
    f = ready(await browser.call('click', { frameId: f.frameId, x: 500, y: 85 }));
    assert.deepEqual(received, ['Проверка ввода 123', 'Второй ввод']);
    if (presentation === 'windowed' && process.env.TRELIO_VISUAL_EXTENSION_HEADED === '1') assert.deepEqual(webdriverAtInput, ['false', 'false']);
    f = ready(await browser.call('click', { frameId: f.frameId, x: 730, y: 75 }));
    assert.equal(detailSeen, true); assert.equal(f.scroll.down, false);
    await browser.close();
    assert.equal(snapshot.schemaVersion, 2);
    console.log(JSON.stringify({ fixture: 'visual-cookie-snapshot', sessionAuthCount: snapshot.sessionCookies.length, ...await fixtureCookieEvidence(snapshot, directory, 'fixture_session') }));
    cookieRestored = false; persistentRestored = false; storageRestored = false;
    browser = create();
    ready(await browser.call('navigate', { url: origin }));
    assert.equal(cookieRestored, true, 'session cookie survives stopped-profile restore');
    assert.equal(persistentRestored, true, 'persistent cookie survives native Cookie database restore');
    assert.equal(storageRestored, true, 'local storage survives stopped-profile restore');
    if (focus()) assert.ok(focusChecks >= 10, 'native foreground checks covered the input sequence');
  } finally {
    ExtensionVisualBrowser.prototype.call = originalCall;
    await browser.close().catch(() => browser.abort());
    // Keep the primary startup evidence visible even when Windows is still
    // releasing owned profile handles during fixture cleanup. Never print
    // native stderr or snapshot bytes as a substitute for these closed fields.
    console.log(JSON.stringify({ fixture: 'visual-input', diagnostics }));
    server.closeAllConnections(); // Fixture keep-alive cannot conceal a failed owned browser shutdown.
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('signed hidden presentation preserves auth and original lease through visible setup and hidden resume', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async t => {
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-hidden-setup-')));
  let snapshot, writes = 0, restored = false, persistentRestored = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/login') response.setHeader('Set-Cookie', ['fixture_hidden=SYNTHETIC_SESSION; HttpOnly; SameSite=Strict; Path=/',
      'fixture_persistent=SYNTHETIC_PERSISTENT; Max-Age=86400; HttpOnly; SameSite=Strict; Path=/']);
    if (request.url === '/after' && request.headers.cookie?.includes('fixture_persistent=SYNTHETIC_PERSISTENT')) persistentRestored = true;
    if (request.url === '/after' && request.headers.cookie?.includes('fixture_hidden=SYNTHETIC_SESSION')) restored = true;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><body><h1>Visible setup fixture</h1><button>Ordinary control</button></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const lease = { deadlineAt: Date.now() + 150_000 }, deadline = lease.deadlineAt;
  const store = { directory, async prepare() {}, async read() { return snapshot; },
    async write(value) { snapshot = structuredClone(value); writes++; }, close() {} };
  // Use the new signed presentation, not testHeadless. The explicit setup must
  // launch a genuine headed browser on every native OS before returning to
  // hidden work; normal input and observations stay closed during human input.
  const browser = new ExtensionVisualBrowser({ dependencies, store, presentation: 'hidden', origins: [origin],
    policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), lease });
  const sessionId = browser.sessionId;
  try {
    const first = await browser.call('navigate', { url: origin });
    assert.equal(first.state, 'ready');
    assert.equal((await browser.call('setup', { url: `${origin}/login` })).state, 'manual_input_required');
    assert.equal(writes, 1, 'the stopped hidden profile was persisted before visible setup');
    assert.equal((await browser.call('screenshot')).reason, 'manual_control_active');
    assert.equal((await browser.call('ready')).state, 'saved_unverified');
    assert.equal(writes, 2, 'human completion persisted before observations can resume');
    const savedPreferences = JSON.parse(Buffer.from(JSON.parse(gunzipSync(Buffer.from(snapshot.profile, 'base64')))
      .find(file => file.path === 'Default/Preferences').data, 'base64'));
    assert.equal(savedPreferences.signin.allowed, false, 'native Chromium retained browser sign-in isolation');
    assert.equal(savedPreferences.signin.allowed_on_next_startup, false, 'the next-startup preference cannot re-enable sign-in');
    const resumed = await browser.call('navigate', { url: `${origin}/after` });
    assert.equal(resumed.state, 'ready');
    assert.equal(restored, true, 'the hidden resumed document receives the exact synthetic auth');
    assert.equal(persistentRestored, true, 'persistent auth also survives the visible-to-hidden restart');
    assert.equal(browser.sessionId, sessionId);
    assert.equal(lease.deadlineAt, deadline, 'human setup never renews the original lease');
    assert.notEqual(resumed.frameId, first.frameId);
    assert.equal((await browser.call('click', { frameId: first.frameId, x: 10, y: 10 })).reason, 'stale_frame');
  } finally {
    await browser.close().catch(() => browser.abort());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('manual window close and ready save once before unlocking images; crash preserves the previous snapshot', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async t => {
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-extension-manual-')));
  let snapshot, writes = 0, window, restored = false, logout = false, logoutObserved = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/login') response.setHeader('Set-Cookie', 'manual_fixture=SYNTHETIC; HttpOnly; SameSite=Strict; Path=/');
    if (request.url === '/keep' && logout) {
      if (!request.headers.cookie?.includes('manual_fixture=SYNTHETIC')) logoutObserved = true;
      response.setHeader('Set-Cookie', 'manual_fixture=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    }
    if (request.url === '/restore' && request.headers.cookie?.includes('manual_fixture=SYNTHETIC')) restored = true;
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><body style="background:#def;height:1400px">Synthetic manual fixture<script>setInterval(()=>fetch("/keep"),100)</script></body>');
  });
  const ownedServer=ownFixtureHttpServer(server,t.signal);await ownedServer.listen();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const store = { directory, async read() { return snapshot; }, async prepare() {}, async write(value) { snapshot = structuredClone(value); writes++; }, close() {} };
  const diagnostics = [];
  const create = () => new ExtensionVisualBrowser({ dependencies, store, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], lease: { deadlineAt: Date.now() + 150_000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1', testWindowController: value => { window = value; }, testDiagnostics: value => diagnostics.push(value) });
  let browser = create(),phase='start',completion='none',primaryFailure=null,lastState='none',lastReason='none';
  const abortOwned=()=>browser.abort();t.signal.addEventListener('abort',abortOwned,{once:true});
  const call=async(operation,args)=>{
    phase=operation;const result=await browser.call(operation,args);
    lastState=['ready','error','manual_input_required','saved_unverified'].includes(result?.state)?result.state:'other';
    lastReason=['none','bootstrap_failed','manual_control_active','operation_failed','lease_expired','storage_unavailable','browser_process_lost'].includes(result?.reason)?result.reason:'other';
    return result;
  };
  const diagnose=()=>console.log(JSON.stringify({fixture:'visual-manual-failure',phase,completion,lastState,lastReason,writes,
    failure:primaryFailure?.code==='ERR_ASSERTION'?'assertion':t.signal.aborted?'timeout':'operation',
    // Report the original closed failure BEFORE async cleanup can block its
    // TAP record. Native exception prose/paths and browser state stay private.
    code:['EBUSY','EPERM','EACCES','ENOENT','ENOTEMPTY','operation_failed','storage_unavailable','browser_process_lost'].includes(primaryFailure?.code)?primaryFailure.code:'other',
    syscall:['open','unlink','rmdir','scandir','lstat','rename'].includes(primaryFailure?.syscall)?primaryFailure.syscall:null,
    lifecycle:diagnostics.slice(-18).map(value=>value.stage),failedTarget:diagnostics.findLast(value=>value.target)?.target??null,ownedBrowserRunning:Boolean(window?.running())}));
  t.signal.addEventListener('abort',diagnose,{once:true});
  try {
    for (completion of ['window_close', 'ready', 'logout_window_close']) {
      diagnostics.push({ stage: completion });
      assert.equal((await call('setup', { url: `${origin}/login` })).state, 'manual_input_required', JSON.stringify(diagnostics));
      assert.equal((await call('show-login')).image, undefined);
      assert.equal((await call('screenshot')).reason, 'manual_control_active');
      assert.equal((await call('type-text', { frameId: 'invalid', text: 'blocked' })).reason, 'manual_control_active');
      const before = writes;
      if (completion === 'logout_window_close') {
        logout = true;
        for (let i = 0; i < 50 && !logoutObserved; i++) await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(logoutObserved, true, 'the fixture browser completed explicit logout before the user closed its window');
      }
      if (completion === 'ready') assert.equal((await call('ready')).state, 'saved_unverified');
      else {phase='user_window_close';await window.close().then(value => diagnostics.push({ stage: 'fixture_close_reply', state: value.state, reason: value.reason })).catch(() => diagnostics.push({ stage: 'fixture_close_disconnected' })); } // UI close can race its socket's graceful shutdown.
      for (let i = 0; i < 200 && (await call('status')).state !== 'saved_unverified'; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await call('status')).state, 'saved_unverified');
      assert.equal(writes, before + 1, 'the final manual snapshot is saved once');
      restored = false;
      assert.equal((await call('navigate', { url: `${origin}/restore` })).state, 'ready');
      assert.equal(restored, completion !== 'logout_window_close', 'window-close retains login but never resurrects an explicit logout');
      phase='cycle_close';await browser.close(); browser = create();
    }
    assert.equal((await call('navigate', { url: `${origin}/restore` })).state, 'ready');
    const before = writes, previous = structuredClone(snapshot);
    phase='crash';window.crash();
    for (let i = 0; i < 100 && (await call('status')).reason !== 'browser_process_lost'; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await call('status')).reason, 'browser_process_lost');
    phase='crash_close';await browser.close(); assert.equal(writes, before); assert.deepEqual(snapshot, previous);
  } catch(error){primaryFailure=error;diagnose();throw error;} finally {
    // Cancel the exact owned producer BEFORE waiting for HTTP close: it may
    // still be issuing the fixture's periodic requests after close() failed.
    // Never wait behind that failed browser queue or replace its assertion.
    let cleanupFailed=false;
    if(primaryFailure||t.signal.aborted)try{browser.abort();}catch{cleanupFailed=true;}
    try{await ownedServer.stop();}catch{cleanupFailed=true;}
    try{
      if(!primaryFailure&&!t.signal.aborted)await browser.close().catch(()=>browser.abort());
      // Preserve a failed native profile instead of entering recursive removal
      // retries on the very sharing violation being diagnosed. The listener
      // and exact producer are already stopped independently above. Successful
      // scenarios still prove complete cleanup; a failure keeps its assertion.
      if(!primaryFailure&&!t.signal.aborted)await fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    }catch{cleanupFailed=true;}finally{
      t.signal.removeEventListener('abort',abortOwned);t.signal.removeEventListener('abort',diagnose);
      console.log(JSON.stringify({fixture:'visual-manual',diagnostics}));
    }
    if(cleanupFailed&&!primaryFailure)throw new Error('visual_manual_fixture_cleanup_failed');
  }
});

test('document guard follows headerless redirects and blocks final files including deceptive Location', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 120_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-extension-redirect-')));
  const server = http.createServer((request, response) => {
    if (request.url === '/short' || request.url === '/chain') {
      response.writeHead(request.url === '/short' ? 301 : 302, { Location: request.url === '/short' ? '/detail' : '/short' }); response.end(); return;
    }
    if (request.url === '/json') { response.setHeader('Content-Type', 'application/json'); response.end('{"synthetic":"must not be observed"}'); return; }
    if (request.url === '/binary-location') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', Location: '/detail' }); response.end('SYNTHETIC_NOT_A_REDIRECT'); return; }
    if (request.url === '/attachment') { response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename=synthetic.html' }); response.end('SYNTHETIC_ATTACHMENT'); return; }
    if (request.url === '/missing-type') { response.end('SYNTHETIC_WITHOUT_CONTENT_TYPE'); return; }
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><body>Completed synthetic redirect</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const store = { directory, async read() {}, async prepare() {}, async write() {}, close() {} };
  const browser = new ExtensionVisualBrowser({ dependencies, store, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], observationMode: 'text', lease: { deadlineAt: Date.now() + 110_000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1' });
  try {
    for (const suffix of ['/short', '/chain']) {
      const result = await browser.call('navigate', { url: origin + suffix });
      assert.equal(result.state, 'ready', JSON.stringify({ state: result.state, reason: result.reason }));
      assert.match(result.text, /Completed synthetic redirect/);
    }
    for (const suffix of ['/json', '/binary-location', '/attachment', '/missing-type']) {
      const result = await browser.call('navigate', { url: origin + suffix });
      assert.equal(result.state, 'error');
      assert.equal(result.reason, 'document_blocked');
      assert.equal(result.text, undefined);
      assert.equal(result.image, undefined);
    }
  } finally {
    await browser.close().catch(() => browser.abort());
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Windows may release Chromium's Account Web Data handle just after the
    // owned process has exited. Match the other native fixtures' bounded
    // cleanup; exhaustion still fails, and no document assertion is skipped.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('explicit incoming attachment uses browser transport, preserves the chat and delivers only verified local bytes', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 150_000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-extension-attachment-')));
  const pdf = Buffer.from('%PDF-1.7\nSYNTHETIC_ATTACHMENT_NOT_MCP_TEXT\n%%EOF\n'), text = Buffer.from('Synthetic incoming document\n');
  const received = [], evidence = [];
  const server = http.createServer((request, response) => {
    received.push(request.url);
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/file' }); response.end(); return; }
    if (request.url === '/file') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=untrusted-name.pdf', 'Content-Length': pdf.length }); response.end(pdf); return; }
    if (request.url === '/text') { response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment', 'Content-Length': text.length }); response.end(text); return; }
    if (request.url === '/html') { response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename=pretend.pdf' }); response.end('<html>SYNTHETIC_SOURCE_MUST_NOT_EXPORT</html>'); return; }
    if (request.url === '/fake') { response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment' }); response.end('SYNTHETIC_NOT_PDF'); return; }
    if (request.url === '/large') { response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment', 'Content-Length': 30 * 1024 * 1024 }); response.end(); return; }
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><body style="font:25px sans-serif">Original synthetic chat<a target="_blank" download href="/redirect" style="position:absolute;left:30px;top:60px">PDF</a><a href="/text" style="position:absolute;left:30px;top:120px">Text</a><a href="/html" style="position:absolute;left:30px;top:180px">HTML</a><a href="/fake" style="position:absolute;left:30px;top:240px">Invalid PDF</a><a href="/large" style="position:absolute;left:30px;top:300px">Large</a><button style="position:absolute;left:200px;top:60px" onclick="setTimeout(() =&gt; window.open(&quot;/file&quot;, &quot;_blank&quot;), 20)">Button file</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const browser = new ExtensionVisualBrowser({ dependencies, testDiagnostics: value => evidence.push(value), store: { directory, async read() {}, async prepare() {}, async write() {}, close() {} }, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], observationMode: 'text', attachmentDownloads: true, lease: { deadlineAt: Date.now() + 140_000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1' });
  const focus = () => process.platform === 'darwin' && process.env.TRELIO_VISUAL_EXTENSION_HEADED === '1' ? execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim() : null;
  try {
    let f = await browser.call('navigate', { url: origin + '/' }); assert.equal(f.state, 'ready');
    await new Promise(resolve => setTimeout(resolve, 1200)); const before = focus();
    const file = await browser.call('download-attachment', { frameId: f.frameId, x: 50, y: 75 });
    assert.equal(file.state, 'ready', JSON.stringify({ reason: file.reason })); assert.equal(file.kind, 'trelio.browser-file/v1');
    assert.deepEqual(await fs.readFile(file.filePath), pdf); assert.equal(file.sha256, createHash('sha256').update(pdf).digest('hex')); assert.equal(file.mimeType, 'application/pdf');
    assert.doesNotMatch(JSON.stringify(file), /SYNTHETIC_ATTACHMENT|untrusted-name|\/redirect|dataBase64/);
    f = await browser.call('read-text'); assert.equal(f.state, 'ready'); assert.match(f.text, /Original synthetic chat/);
    assert.equal((await browser.call('download-attachment', { frameId: f.frameId, x: 1000, y: 500 })).reason, 'attachment_link_required');
    for (const [y, expected] of [[135, 'ready'], [195, 'attachment_unsupported'], [255, 'attachment_unsupported'], [315, 'attachment_too_large']]) {
      f = await browser.call('read-text'); assert.equal(f.state, 'ready');
      const value = await browser.call('download-attachment', { frameId: f.frameId, x: 50, y });
      assert.equal(value.state === 'ready' ? 'ready' : value.reason, expected);
      if (value.state === 'ready') assert.deepEqual(await fs.readFile(value.filePath), text);
      // An intentional refusal may leave Chrome's error document. A fresh
      // explicit fixture navigation is a new read, never a blind file retry.
      await browser.call('navigate', { url: origin + '/' });
    }
    if (before) assert.equal(focus(), before, 'attachment receipt never creates/activates a tab or native Save As');
    f = await browser.call('read-text');
    const button = await browser.call('download-attachment', {frameId:f.frameId,x:230,y:70});
    assert.equal(button.state, 'ready', JSON.stringify({reason:button.reason})); assert.deepEqual(await fs.readFile(button.filePath), pdf);
    if (before) assert.equal(focus(), before, 'script-open attachment never activates a popup');
    assert.equal(received.filter(url => url === '/file').length, 2, 'each of the two deliberate reads fetches once');
    await browser.close(); assert.deepEqual(await fs.readFile(file.filePath), pdf, 'browser close does not remove the delivered original');
  } catch (error) { t.diagnostic(JSON.stringify(evidence)); throw error; } finally {
    await browser.close().catch(() => browser.abort()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});


test('signed manual completion closes only a stable authenticated document, saves once and resumes hidden without chat acknowledgement', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async () => {
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-manual-complete-')));
  let phase = 'password', snapshot, writes = 0, restored = false, window;
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/after') {
      restored = Boolean(request.headers.cookie?.includes('fixture_completion=SYNTHETIC_SESSION'));
      response.end('<!doctype html><body>Hidden authenticated fixture</body>'); return;
    }
    const challenge = phase === 'password' ? '<input type="password">' : phase === 'challenge' ? '<div role="dialog">Human challenge</div>' : '';
    if (phase === 'success') response.setHeader('Set-Cookie', 'fixture_completion=SYNTHETIC_SESSION; HttpOnly; SameSite=Strict; Path=/');
    // Synthetic human progress is controlled only by this fixture's server.
    // The production observer sends no clicks, values, navigation or submit.
    response.end(`<!doctype html><body><nav id="account">Account</nav><main id="calendar">Calendar</main>${challenge}${phase === 'success' ? '' : '<script>setTimeout(()=>location.reload(),250)</script>'}</body>`);
  });
  const controller = new AbortController(), owned = ownFixtureHttpServer(server, controller.signal);
  await owned.listen();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const lease = { deadlineAt: Date.now() + 150_000 }, deadline = lease.deadlineAt;
  const browser = new ExtensionVisualBrowser({ dependencies, origins: [origin], presentation: 'hidden', lease,
    policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }),
    manualCompletion: { success: [{ origin, pathPrefix: '/login', selectors: ['#account', '#calendar'], blocked: ['[role="dialog"]'] }] },
    store: { directory, async prepare() {}, async read() { return snapshot; }, async write(value) { snapshot = structuredClone(value); writes++; }, close() {} },
    testWindowController: value => { window = value; } });
  const sessionId = browser.sessionId;
  try {
    assert.equal((await browser.call('setup', { url: `${origin}/login` })).state, 'manual_input_required');
    for (const next of ['password', 'challenge']) {
      phase = next; await new Promise(resolve => setTimeout(resolve, 3000));
      assert.equal((await browser.call('status')).state, 'manual_input_required');
      assert.equal(window.running(), true); assert.equal(writes, 0);
      assert.equal((await browser.call('screenshot')).reason, 'manual_control_active');
    }
    phase = 'success';
    const until = Date.now() + 25_000; let status;
    do { await new Promise(resolve => setTimeout(resolve, 100)); status = await browser.call('status'); }
    while (status.state === 'manual_input_required' && Date.now() < until);
    assert.equal(status.state, 'saved_unverified');
    assert.equal(window.running(), false, 'the owned visible process has actually stopped');
    assert.equal(writes, 1, 'one stopped-profile save, without ready/chat input');
    assert.equal((await browser.call('ready')).state, 'saved_unverified'); assert.equal(writes, 1);
    assert.equal((await browser.call('navigate', { url: `${origin}/after` })).state, 'ready');
    assert.equal(restored, true); assert.equal(browser.sessionId, sessionId); assert.equal(lease.deadlineAt, deadline);
  } finally {
    await browser.close().catch(() => browser.abort()); controller.abort(); await owned.stop();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
