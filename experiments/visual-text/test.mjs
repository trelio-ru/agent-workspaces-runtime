import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildTextOverlay } from './build-overlay.mjs';
import { TEXT_KIND, validateTextResult } from './result.mjs';
const sample = () => ({ kind: TEXT_KIND, state: 'ready', reason: 'none', sessionId: '12345678-1234-4234-8234-123456789012', frameId: '12345678-1234-4234-8234-123456789013', width: 1440, height: 1000, scroll: { up: false, down: true, left: false, right: false }, title: 'Fixture', text: 'Объявление', controls: [{ role: 'button', label: 'Найти', x: 200, y: 100 }], nextOffset: null, scanLimited: false });
test('text projection rejects extra data, excessive content and invalid coordinates', () => {
  assert.equal(validateTextResult(sample()).kind, TEXT_KIND);
  for (const change of [{ html: '<div>' }, { text: 'a'.repeat(6001) }, { controls: [{ ...sample().controls[0], x: 1440 }] }, { controls: [{ ...sample().controls[0], value: 'SECRET' }] }, { scanLimited: 'false' }, { nextOffset: -1 }, { sessionId: 'invalid' }]) assert.throws(() => validateTextResult({ ...sample(), ...change }), /EXPERIMENTAL_TEXT_INVALID/);
});
test('overlay is separate; production result/input contract remains image-only', async () => {
  const directory = await buildTextOverlay();
  try {
    const production = await import('../../host-runtime/scripts/trelio-visual-result.mjs');
    assert.throws(() => production.validateVisualResult(sample()), /VISUAL_RESULT_INVALID/);
    const prototype = await import(pathToFileURL(path.join(directory, 'trelio-visual-result.mjs')));
    assert.equal(prototype.validateVisualResult(sample()).kind, TEXT_KIND);
    const browser = await fs.readFile(new URL('../../host-runtime/scripts/trelio-visual-extension-browser.mjs', import.meta.url), 'utf8');
    assert.equal(browser.includes("'read-text'"), false);
    const worker = await fs.readFile(path.join(directory, 'trelio-visual-extension-worker.mjs'), 'utf8');
    assert.equal(worker.includes('Runtime.evaluate'), false);
    assert.equal(worker.includes('experimental_read_text'), true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('native fixed text reader: labels, Unicode input, links, paging, secrets, stale frame and manual gate', { skip: process.env.TRELIO_TEXT_NATIVE_TEST !== '1', timeout: 120_000 }, async () => {
  const directory = await buildTextOverlay();
  const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-text-fixture-')));
  let received;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/submitted') received = url.searchParams.get('q');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Синтетическое объявление</title><body style="font:20px sans-serif"><h1>Объявление для проверки</h1><form action="/submitted"><input name="q" placeholder="Поиск" value="INPUT_SECRET"><button>Найти</button></form><a target="_blank" href="/detail">Подробности</a><div hidden>HIDDEN_SECRET</div><script>const secret='SCRIPT_SECRET';</script><label>Комментарий<textarea>TEXTAREA_SECRET</textarea></label><input type="password" hidden value="HIDDEN_PASSWORD_SECRET">${url.pathname === '/password' ? '<input type="password" value="PASSWORD_SECRET">' : ''}${url.pathname === '/otp' ? '<input autocomplete="ONE-TIME-CODE" value="OTP_SECRET">' : ''}<p>Редкая фраза: проверка фильтра</p>${Array.from({ length: 200 }, (_, i) => `<p>Строка ${i} – ${'Описание услуги '.repeat(5)}</p>`).join('')}</body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { ExtensionVisualBrowser } = await import(pathToFileURL(path.join(directory, 'trelio-visual-extension-browser.mjs')));
  const { loadVisualDependencies } = await import(pathToFileURL(path.join(directory, 'trelio-visual-bootstrap.mjs')));
  const { createVisualOriginPolicy } = await import(pathToFileURL(path.join(directory, 'trelio-visual-browser.mjs')));
  const dependencies = await loadVisualDependencies();
  const browser = new ExtensionVisualBrowser({ dependencies, store: { directory: fixture, async read() { return null; }, async prepare() {}, async write() {}, close() {} }, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], lease: { deadlineAt: Date.now() + 100_000 }, testHeadless: process.env.TRELIO_TEXT_HEADED !== '1' });
  const ready = value => { assert.equal(value.state, 'ready', value.reason); return value; };
  const control = (frame, label) => { const c = frame.controls.find(c => c.label === label); assert.ok(c, `missing ${label}`); return { frameId: frame.frameId, x: c.x, y: c.y }; };
  try {
    ready(await browser.call('navigate', { url: origin }));
    let frame = ready(await browser.call('read-text'));
    const firstPageText = frame.text;
    assert.equal(frame.text.length, 6000); assert.ok(frame.nextOffset);
    assert.doesNotMatch(JSON.stringify(frame), /INPUT_SECRET|HIDDEN_SECRET|SCRIPT_SECRET|TEXTAREA_SECRET/);
    const stale = frame.frameId;
    frame = ready(await browser.call('click', control(frame, 'Поиск')));
    frame = ready(await browser.call('key', { frameId: frame.frameId, key: process.platform === 'darwin' ? 'Meta+A' : 'Control+A' }));
    frame = ready(await browser.call('type-text', { frameId: frame.frameId, text: 'Русский ввод 123' }));
    frame = ready(await browser.call('key', { frameId: frame.frameId, key: 'Enter' }));
    assert.equal(received, 'Русский ввод 123');
    assert.equal((await browser.call('click', { frameId: stale, x: 10, y: 10 })).reason, 'stale_frame');
    frame = ready(await browser.call('read-text', { query: 'Редкая фраза' }));
    assert.match(frame.text, /Редкая фраза: проверка фильтра/);
    const filtered = ready(await browser.call('read-text', { query: 'Редкая фраза', includeControls: false }));
    assert.deepEqual(filtered.controls, []);
    assert.equal((await browser.call('read-text', { query: 'x'.repeat(121) })).reason, 'invalid_input');
    frame = ready(await browser.call('read-text', { offset: 6000 }));
    assert.equal(frame.text.length, 6000); assert.notEqual(frame.text, firstPageText);
    assert.equal(frame.nextOffset, 12000);
    frame = ready(await browser.call('click', control(frame, 'Подробности')));
    assert.equal(frame.kind, TEXT_KIND);
    ready(await browser.call('screenshot'));
    assert.equal((await browser.call('navigate', { url: 'https://example.com/' })).reason, 'navigation_blocked');
    ready(await browser.call('navigate', { url: `${origin}/password` }));
    assert.equal((await browser.call('read-text')).reason, 'manual_control_active');
    ready(await browser.call('navigate', { url: `${origin}/otp` }));
    assert.equal((await browser.call('read-text')).reason, 'manual_control_active');
    assert.equal((await browser.call('setup', { url: origin })).state, 'manual_input_required');
    assert.equal((await browser.call('read-text')).reason, 'manual_control_active');
  } finally {
    await browser.close().catch(() => browser.abort());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
