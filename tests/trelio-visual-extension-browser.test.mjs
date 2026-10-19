import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ExtensionVisualBrowser } from '../host-runtime/scripts/trelio-visual-extension-browser.mjs';
import { loadVisualDependencies } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { createVisualOriginPolicy } from '../host-runtime/scripts/trelio-visual-browser.mjs';

test('ordinary Chromium extension clicks, types, scrolls and restores auth without a page-code reader', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-extension-fixture-')));
  const received = [], webdriverAtInput = [];
  let cookieRestored = false, storageRestored = false, detailSeen = false, snapshot;
  const server = http.createServer((request, response) => {
    const u = new URL(request.url, 'http://127.0.0.1');
    if (u.pathname === '/typed') { received.push(u.searchParams.get('value')); webdriverAtInput.push(u.searchParams.get('webdriver')); response.end(); return; }
    if (u.pathname === '/storage') { if (u.searchParams.get('value') === 'SYNTHETIC_STORAGE') storageRestored = true; response.end(); return; }
    if (u.pathname === '/detail') detailSeen = true;
    if (request.headers.cookie?.includes('fixture_session=SYNTHETIC_COOKIE')) cookieRestored = true;
    if (u.pathname === '/login') response.setHeader('Set-Cookie', 'fixture_session=SYNTHETIC_COOKIE; HttpOnly; SameSite=Strict; Path=/');
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
    cookieRestored = false; storageRestored = false;
    browser = create();
    ready(await browser.call('navigate', { url: origin }));
    assert.equal(cookieRestored, true, 'session cookie survives stopped-profile restore');
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

test('manual window close and ready save once before unlocking images; crash preserves the previous snapshot', { skip: process.env.TRELIO_VISUAL_EXTENSION_TEST !== '1', timeout: 180_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-extension-manual-')));
  let snapshot, writes = 0, window, restored = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/login') response.setHeader('Set-Cookie', 'manual_fixture=SYNTHETIC; HttpOnly; SameSite=Strict; Path=/');
    if (request.url === '/restore' && request.headers.cookie?.includes('manual_fixture=SYNTHETIC')) restored = true;
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><body style="background:#def;height:1400px">Synthetic manual fixture</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dependencies = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const store = { directory, async read() { return snapshot; }, async prepare() {}, async write(value) { snapshot = structuredClone(value); writes++; }, close() {} };
  const diagnostics = [];
  const create = () => new ExtensionVisualBrowser({ dependencies, store, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], lease: { deadlineAt: Date.now() + 150_000 }, testHeadless: process.env.TRELIO_VISUAL_EXTENSION_HEADED !== '1', testWindowController: value => { window = value; }, testDiagnostics: value => diagnostics.push(value) });
  let browser = create();
  try {
    for (const completion of ['window_close', 'ready']) {
      assert.equal((await browser.call('setup', { url: `${origin}/login` })).state, 'manual_input_required', JSON.stringify(diagnostics));
      assert.equal((await browser.call('show-login')).image, undefined);
      assert.equal((await browser.call('screenshot')).reason, 'manual_control_active');
      assert.equal((await browser.call('type-text', { frameId: 'invalid', text: 'blocked' })).reason, 'manual_control_active');
      const before = writes;
      if (completion === 'ready') assert.equal((await browser.call('ready')).state, 'saved_unverified');
      else await window.close().catch(() => {}); // UI close can race its socket's graceful shutdown.
      for (let i = 0; i < 200 && (await browser.call('status')).state !== 'saved_unverified'; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await browser.call('status')).state, 'saved_unverified');
      assert.equal(writes, before + 1, 'the final manual snapshot is saved once');
      assert.equal((await browser.call('navigate', { url: `${origin}/restore` })).state, 'ready');
      assert.equal(restored, true, 'the closed manual window retained its session cookie');
      await browser.close(); browser = create();
    }
    assert.equal((await browser.call('navigate', { url: `${origin}/restore` })).state, 'ready');
    const before = writes, previous = structuredClone(snapshot);
    window.crash();
    for (let i = 0; i < 100 && (await browser.call('status')).reason !== 'browser_process_lost'; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await browser.call('status')).reason, 'browser_process_lost');
    await browser.close(); assert.equal(writes, before); assert.deepEqual(snapshot, previous);
  } finally {
    await browser.close().catch(() => browser.abort());
    console.log(JSON.stringify({ fixture: 'visual-manual', diagnostics }));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
