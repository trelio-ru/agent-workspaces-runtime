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
import { ExtensionVisualBrowser } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';
import { loadVisualDependencies } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { createVisualOriginPolicy } from '../host-runtime/scripts/trelio-visual-browser.mjs';
import { ownFixtureHttpServer } from './fixtures/visual-owned-http.mjs';

test('outgoing chooser uploads original image, document, archive and arbitrary files without a native dialog or replay', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-upload-browser-')));
  const originals = path.join(directory, 'originals'); await fs.mkdir(originals, { mode: 0o700 });
  const received = [], clicks = [];
  let snapshot;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/selected') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.end('ok'); return;
    }
    if (request.url === '/clicked') { clicks.push(true); response.end(); return; }
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
  const ready = value => { assert.equal(value.state, 'ready', JSON.stringify({ state: value.state, reason: value.reason, diagnostics })); return value; };
  const focus = () => process.platform === 'darwin' && process.env.TRELIO_VISUAL_EXTENSION_HEADED === '1'
    ? execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim() : null;
  try {
    let frame = ready(await browser.call('navigate', { url: origin }));
    if (focus()) await new Promise(resolve => setTimeout(resolve, 1200));
    const before = focus(), token = frame.frameId;
    frame = ready(await browser.call('upload-files', { frameId: token, x: 100, y: 70, files }));
    if (before) assert.equal(focus(), before, 'native file selection never activates a dialog or another app');
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], selected.map(([name, bytes]) => ({ name, bytes: [...bytes] })));
    assert.equal(clicks.length, 1);
    assert.ok(frame.text.includes('договор.docx'));
    assert.equal((await browser.call('upload-files', { frameId: token, x: 100, y: 70, files })).reason, 'stale_frame');
    assert.equal(received.length, 1, 'consumed input cannot repeat an upload');
    frame = ready(await browser.call('read-text'));
    assert.equal((await browser.call('upload-files', { frameId: frame.frameId, x: 100, y: 70, files: [originals] })).reason, 'upload_file_invalid');
    assert.equal(clicks.length, 1, 'invalid sources fail before the website is clicked');
    frame = ready(await browser.call('read-text'));
    assert.equal((await browser.call('upload-files', { frameId: frame.frameId, x: 400, y: 70, files })).reason, 'upload_control_required');
    assert.equal(received.length, 1, 'multi-file selection never silently narrows to the first file');
    frame = ready(await browser.call('read-text'));
    ready(await browser.call('upload-files', { frameId: frame.frameId, x: 400, y: 70, files: [files[1]] }));
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

test('ordinary Chromium extension clicks, types, scrolls and restores auth without a page-code reader', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async () => {
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
  const create = () => new ExtensionVisualBrowser({ dependencies, store, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], lease: { deadlineAt: Date.now() + 150_000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1', testDiagnostics: value => diagnostics.push(value) });
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
    let f = ready(await browser.call('navigate', { url: `${origin}/login` }));
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
    if (process.env.TRELIO_VISUAL_EXTENSION_HEADED === '1') assert.deepEqual(webdriverAtInput, ['false', 'false']);
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
    failure:primaryFailure?.code==='ERR_ASSERTION'?'assertion':t.signal.aborted?'timeout':'operation'}));
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
    // SAME fixture-owned abort/HTTP cleanup as the native authentication test.
    // A failure cannot wait behind the browser queue or leave a live listener;
    // stop accepting before closing sockets and preserve the primary assertion.
    let cleanupFailed=false;
    try{await ownedServer.stop();}catch{cleanupFailed=true;}
    try{
      if(primaryFailure||t.signal.aborted)browser.abort();
      else await browser.close().catch(()=>browser.abort());
      await fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});
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

test('explicit incoming attachment uses browser transport, preserves the chat and delivers only verified local bytes', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 150_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-extension-attachment-')));
  const pdf = Buffer.from('%PDF-1.7\nSYNTHETIC_ATTACHMENT_NOT_MCP_TEXT\n%%EOF\n'), text = Buffer.from('Synthetic incoming document\n');
  const received = [];
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
  const browser = new ExtensionVisualBrowser({ dependencies, store: { directory, async read() {}, async prepare() {}, async write() {}, close() {} }, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], observationMode: 'text', attachmentDownloads: true, lease: { deadlineAt: Date.now() + 140_000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1' });
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
  } finally {
    await browser.close().catch(() => browser.abort()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
