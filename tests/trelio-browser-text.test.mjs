import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { TEXT_KIND, validateTextResult } from '../host-runtime/scripts/trelio-browser-text.mjs';
const sample = () => ({ kind: TEXT_KIND, state: 'ready', reason: 'none', sessionId: '12345678-1234-4234-8234-123456789012', frameId: '12345678-1234-4234-8234-123456789013', width: 1440, height: 1000, scroll: { up: false, down: true, left: false, right: false }, title: 'Fixture', text: 'Объявление', controls: [{ role: 'button', label: 'Найти', x: 200, y: 100 }], nextOffset: null, scanLimited: false });

// Synthetic published-document markup, not a copy of any provider page. The
// same native reader must distinguish static read-only blocks from disabled
// form fields and non-editable islands that still belong to an active draft.
const readonlyDocumentFixture = () => `
  <article>
    <h2 contenteditable="false">READONLY_DOCUMENT_HEADING</h2>
    <div contenteditable="false"><p>READONLY_PARAGRAPH_START <b>выделенный текст</b></p></div>
    <table><tr><th contenteditable="false">READONLY_TABLE_HEADER</th><td><div contenteditable="false">READONLY_TABLE_CELL</div></td></tr></table>
    <p contenteditable="FALSE">READONLY_CASE_INSENSITIVE</p>
    <div contenteditable="false">${'Часть длинной опубликованной статьи. '.repeat(450)} READONLY_DOCUMENT_END</div>
  </article>
  <div contenteditable="true">TRUE_EDITOR_SECRET <span contenteditable="false">FALSE_ISLAND_SECRET</span></div>
  <div contenteditable>EMPTY_EDITOR_SECRET</div>
  <div contenteditable="inherit">UNKNOWN_EDITOR_SECRET</div>
  <div contenteditable="plaintext-only"><span contenteditable="false">PLAINTEXT_ISLAND_SECRET</span></div>
  <div contenteditable="false" role="textbox" aria-readonly="true">READONLY_TEXTBOX_SECRET</div>
  <div contenteditable="false" role="TEXTBOX" aria-disabled="true">READONLY_UPPER_TEXTBOX_SECRET</div>
  <div role="textbox"><p contenteditable="false">TEXTBOX_ISLAND_SECRET</p></div>
  <form><div contenteditable="false">READONLY_FORM_SECRET</div></form>
  <label>Безопасная подпись<input><span contenteditable="false">READONLY_LABEL_SECRET</span></label>
  <div hidden contenteditable="false">READONLY_HIDDEN_SECRET</div>
  <div style="opacity:0" contenteditable="false">READONLY_INVISIBLE_SECRET</div>`;
test('text projection rejects extra data, excessive content and invalid coordinates', () => {
  assert.equal(validateTextResult(sample()).kind, TEXT_KIND);
  for (const change of [{ html: '<div>' }, { text: 'a'.repeat(6001) }, { controls: [{ ...sample().controls[0], x: 1440 }] }, { controls: [{ ...sample().controls[0], value: 'SECRET' }] }, { scanLimited: 'false' }, { nextOffset: -1 }, { sessionId: 'invalid' }]) assert.throws(() => validateTextResult({ ...sample(), ...change }), /VISUAL_RESULT_INVALID/);
});
test('text crosses the actual typed MCP action handler without generic stdout truncation', async () => {
  const { handleToolCall } = await import('../host-runtime/scripts/trelio-remote-mcp.mjs');
  const { handleTrelioWorkspaceActionOperation } = await import('../host-runtime/scripts/trelio-local-context.mjs');
  const value = { ...sample(), text: 'Описание услуги '.repeat(350) };
  const result = await handleToolCall('https://example.test', 'continue_trelio_workspace_action', { schemaVersion: 1, operation: 'skill_run', parameters: { companyId: value.sessionId, skillId: 'synthetic-visual-fixture', releaseId: value.frameId, arguments: ['read-text'] } }, {
    workspaceActionOperation: (origin, args) => handleTrelioWorkspaceActionOperation(origin, args, { runBridge: async () => ({ stdout: JSON.stringify(value), stderr: '' }) }),
  });
  assert.equal(result.content.length, 1);
  assert.equal(JSON.parse(result.content[0].text).text, value.text);
  assert.equal(JSON.parse(result.content[0].text).controls[0].label, 'Найти');
  assert.doesNotMatch(result.content[0].text, /stdout|stderr|html/);
});

test('both closed variants cross MCP; default image mode rejects text commands before IO', async () => {
  const { parseVisualSkillOutput, visualMcpResult } = await import('../host-runtime/scripts/trelio-visual-result.mjs');
  assert.equal(parseVisualSkillOutput(JSON.stringify(sample())).kind, TEXT_KIND);
  assert.equal(visualMcpResult(sample()).content.length, 1);
  const escaped = { ...sample(), text: '\\'.repeat(6000), controls: Array.from({ length: 40 }, () => ({ role: 'button', label: '\\'.repeat(120), x: 20, y: 30 })) };
  assert.throws(() => visualMcpResult(escaped), /VISUAL_RESULT_INVALID/, 'the twice-serialized MCP envelope must also fit');
  assert.throws(() => parseVisualSkillOutput(JSON.stringify({ ...sample(), html: '<secret>' })), /VISUAL_RESULT_INVALID/);
  const { ExtensionVisualBrowser, visualExtensionManifest } = await import('../host-runtime/scripts/trelio-visual-extension-browser.mjs');
  const browser = new ExtensionVisualBrowser({ policy: {}, store: { close() {} }, lease: { deadlineAt: Date.now() + 1000 } });
  try { for (const op of ['read-text', 'submit', 'request-ready']) assert.equal((await browser.call(op)).reason, 'invalid_input'); }
  finally { await browser.close(); }
  assert.deepEqual(visualExtensionManifest(['https://example.test/*'], 1234).content_scripts[0].js, ['link-router.js', 'authentication.js']);
  assert.deepEqual(visualExtensionManifest(['https://example.test/*'], 1234, 'text').content_scripts[0].js, ['link-router.js', 'authentication.js', 'text-observer.js']);
});

test('native fixed text reader: read-only documents, paging, secrets, stale frame and manual gate', { skip: process.env.TRELIO_TEXT_NATIVE_TEST !== '1', timeout: 120_000 }, async () => {
  const directory = new URL('../host-runtime/scripts/', import.meta.url);
  const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-text-fixture-')));
  let received, window;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/submitted') received = url.searchParams.get('q');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Синтетическое объявление</title><body style="font:20px sans-serif"><h1>Объявление для проверки</h1><form action="/submitted"><input name="q" placeholder="Поиск" value="INPUT_SECRET"><button>Найти</button></form><a target="_blank" href="/detail">Подробности</a><div hidden>HIDDEN_SECRET</div><script>const secret='SCRIPT_SECRET';</script><label>Комментарий<textarea>TEXTAREA_SECRET</textarea></label><div contenteditable="plaintext-only" role="textbox" aria-label="Текст сообщения">DRAFT_SECRET</div><input type="password" hidden value="HIDDEN_PASSWORD_SECRET">${url.pathname === '/password' ? '<input type="password" value="PASSWORD_SECRET">' : ''}${url.pathname === '/otp' ? '<input autocomplete="ONE-TIME-CODE" value="OTP_SECRET">' : ''}${url.pathname === '/readonly' ? readonlyDocumentFixture() : ''}<p>Редкая фраза: проверка фильтра</p>${url.pathname === '/long' ? '<div>' + 'Длинное описание '.repeat(800) + '</div>' : ''}${Array.from({ length: 200 }, (_, i) => `<p>Строка ${i} – ${'Описание услуги '.repeat(5)}</p>`).join('')}</body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { ExtensionVisualBrowser } = await import(new URL('trelio-visual-extension-browser.mjs', directory));
  const { loadVisualDependencies } = await import(new URL('trelio-visual-bootstrap.mjs', directory));
  const { createVisualOriginPolicy } = await import(new URL('trelio-visual-browser.mjs', directory));
  const dependencies = await loadVisualDependencies();
  const browser = new ExtensionVisualBrowser({ dependencies, observationMode: 'text', testWindowController: value => { window = value; }, store: { directory: fixture, async read() { return null; }, async prepare() {}, async write() {}, close() {} }, policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }), origins: [origin], lease: { deadlineAt: Date.now() + 100_000 }, testHeadless: process.env.TRELIO_TEXT_HEADED !== '1' });
  const nativeCall = browser.call.bind(browser);
  const focus = () => process.platform === 'darwin' && process.env.TRELIO_TEXT_HEADED === '1' ? execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim() : null;
  browser.call = async (operation, args) => {
    const before = focus(), value = await nativeCall(operation, args);
    if (before && ['click', 'key', 'type-text', 'scroll', 'read-text', 'screenshot', 'submit', 'request-ready'].includes(operation)) assert.equal(focus(), before, `${operation} must preserve OS foreground`);
    return value;
  };
  const ready = value => { assert.equal(value.state, 'ready', value.reason); return value; };
  const control = (frame, label) => { const c = frame.controls.find(c => c.label === label); assert.ok(c, `missing ${label}`); return { frameId: frame.frameId, x: c.x, y: c.y }; };
  try {
    ready(await browser.call('navigate', { url: origin }));
    const tabs = await window.tabs();
    assert.equal(tabs.maximum, 5); assert.equal(tabs.opened, 5);
    assert.equal(tabs.open, 5); assert.equal(tabs.actualOpen, 5, 'real Chromium popup overflow has been removed');
    if (focus()) await new Promise(resolve => setTimeout(resolve, 1200));
    let frame = ready(await browser.call('read-text'));
    const firstPageText = frame.text;
    assert.equal(frame.text.length, 6000); assert.ok(frame.nextOffset);
    assert.doesNotMatch(JSON.stringify(frame), /INPUT_SECRET|HIDDEN_SECRET|SCRIPT_SECRET|TEXTAREA_SECRET|DRAFT_SECRET/);
    const stale = frame.frameId;
    frame = ready(await browser.call('click', control(frame, 'Поиск')));
    frame = ready(await browser.call('key', { frameId: frame.frameId, key: process.platform === 'darwin' ? 'Meta+A' : 'Control+A' }));
    frame = ready(await browser.call('type-text', { frameId: frame.frameId, text: 'Русский ввод 123' }));
    frame = ready(await browser.call('submit', { action: 'key', frameId: frame.frameId, key: 'Enter' }));
    assert.equal(received, 'Русский ввод 123');
    assert.equal((await browser.call('submit', { action: 'navigate', url: `${origin}/detail` })).reason, 'request_not_reviewed');
    assert.equal((await browser.call('request-ready', { frameId: stale })).reason, 'stale_frame');
    frame = ready(await browser.call('request-ready', { frameId: frame.frameId }));
    frame = ready(await browser.call('submit', { action: 'navigate', url: `${origin}/detail` }));
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
    frame = ready(await browser.call('navigate', { url: `${origin}/long` }));
    frame = ready(await browser.call('read-text', { offset: 6000, includeControls: false }));
    assert.match(frame.text, /Длинное описание/);
    assert.equal(frame.scanLimited, false, 'a long single text node remains pageable instead of losing its suffix');
    // Read the whole rendered document in ordinary 6000-character pages. No
    // screenshot, page script, scrolling or model-supplied selector is used.
    frame = ready(await browser.call('navigate', { url: `${origin}/readonly` }));
    let documentText = '', pages = 0, offset = 0;
    do {
      frame = ready(await browser.call('read-text', { offset, includeControls: false }));
      assert.equal(frame.scanLimited, false);
      assert.doesNotMatch(JSON.stringify(frame), /[A-Z_]+_SECRET/);
      documentText += frame.text;
      assert.ok(++pages < 20, 'bounded pagination must make forward progress');
      if (frame.nextOffset !== null) assert.ok(frame.nextOffset > offset);
      offset = frame.nextOffset;
    } while (offset !== null);
    assert.ok(pages > 2, 'the read-only article must span several real text pages');
    for (const marker of ['READONLY_DOCUMENT_HEADING', 'READONLY_PARAGRAPH_START', 'выделенный текст', 'READONLY_TABLE_HEADER', 'READONLY_TABLE_CELL', 'READONLY_CASE_INSENSITIVE', 'READONLY_DOCUMENT_END']) assert.ok(documentText.includes(marker), `missing ${marker}`);
    assert.equal((documentText.match(/READONLY_DOCUMENT_END/gu) || []).length, 1);
    assert.ok(documentText.indexOf('READONLY_TABLE_HEADER') < documentText.indexOf('READONLY_TABLE_CELL'));
    assert.equal((await browser.call('navigate', { url: 'https://example.com/' })).reason, 'navigation_blocked');
    assert.equal((await browser.call('navigate', { url: `${origin}/password` })).reason, 'manual_control_active');
    assert.equal((await browser.call('read-text')).reason, 'manual_control_active');
    assert.equal((await browser.call('navigate', { url: `${origin}/otp` })).reason, 'manual_control_active');
    assert.equal((await browser.call('read-text')).reason, 'manual_control_active');
    assert.equal((await browser.call('setup', { url: origin })).state, 'manual_input_required');
    assert.equal((await browser.call('read-text')).reason, 'manual_control_active');
  } finally {
    await browser.close().catch(() => browser.abort());
    assert.equal(window?.running() ?? false, false, 'close leaves no owned browser process or tabs');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
