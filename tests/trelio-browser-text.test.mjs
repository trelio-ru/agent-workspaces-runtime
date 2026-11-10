import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { TEXT_KIND, buildTextObserverScript, readableLinkUrl, validateTextResult, normalizeBusinessFieldPolicy, validBusinessFieldChecks } from '../host-runtime/scripts/trelio-browser-text.mjs';
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
test('semantic controls retain closed state metadata and never accept field values or legacy capability widening', () => {
  const control = { role: 'checkbox', label: 'Calendar', checked: true, x: 20, y: 30 };
  const value = { ...sample(), nextControlsOffset: null, controls: [control,
    { role: 'option', label: 'Work', selected: false, x: 20, y: 60 }] };
  assert.equal(validateTextResult(value), value);
  for (const change of [{ nextControlsOffset: -1 }, { nextControlsOffset: 1201 },
    { controls: [{ ...control, value: 'PRIVATE_VALUE' }] }, { controls: [{ ...control, checked: 'true' }] },
    { controls: [{ ...control, role: 'textbox' }] }]) assert.throws(() => validateTextResult({ ...value, ...change }));
  assert.throws(() => validateTextResult({ ...sample(), controls: [control] }), /VISUAL_RESULT_INVALID/);
});

test('business comparisons are closed signed policy and return enums only', () => {
  const policy = normalizeBusinessFieldPolicy({ origins: ['https://example.test'], labels: ['Start date'] }, ['https://example.test']);
  const check = { id: 'date', label: 'Start date', match: 'equals', values: ['2030-05-12'] };
  assert.ok(validBusinessFieldChecks([check], policy));
  for (const invalid of [[{ ...check, label: 'Password' }], [{ ...check, selector: 'input' }],
    [{ ...check, match: 'regex' }], [check, check], []]) assert.equal(validBusinessFieldChecks(invalid, policy), false);
  assert.equal(validBusinessFieldChecks([check], null), false);
  assert.throws(() => normalizeBusinessFieldPolicy({ origins: ['https://foreign.test'], labels: ['Start date'] }, ['https://example.test']));
  const value = { ...sample(), nextControlsOffset: null, fieldChecks: [{ id: 'date', state: 'matches' }] };
  assert.equal(validateTextResult(value), value);
  for (const fieldChecks of [[{ id: 'date', state: 'matches', value: 'PRIVATE' }], [{ id: 'date', state: 'unknown' }]])
    assert.throws(() => validateTextResult({ ...value, fieldChecks }));
});

test('native semantic controls page past long toolbars, follow layout changes and keep editable values private', {
  skip: process.env.TRELIO_TEXT_TEST !== '1', timeout: 120_000,
}, async t => {
  const { ExtensionVisualBrowser } = await import('../host-runtime/scripts/trelio-visual-extension-browser.mjs');
  const { loadVisualDependencies } = await import('../host-runtime/scripts/trelio-visual-bootstrap.mjs');
  const { createVisualOriginPolicy } = await import('../host-runtime/scripts/trelio-visual-browser.mjs');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-controls-')));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/password') { res.end('<label>Start date<input value="2030-05-12"></label><input type="password" value="PRIVATE_PASSWORD">'); return; }
    res.end('<!doctype html><body>' + Array.from({ length: 70 }, (_, i) => `<button>Action ${i}</button>`).join('')
      + '<p><button id="target" onclick="this.textContent=\'TARGET_CLICKED\'">Late target</button>'
      + '<button onclick="document.getElementById(\'target\').style.marginLeft=\'200px\'">Reflow</button></p>'
      + '<label>Selected calendar<input type="checkbox" checked value="PRIVATE_CHECK_VALUE"></label>'
      + '<label>Clipped calendar<input style="position:absolute;width:1px;height:1px;opacity:0" type="checkbox" checked value="PRIVATE_CLIPPED_VALUE"><textarea hidden>PRIVATE_LABEL_DRAFT</textarea></label>'
      + '<p><input type="checkbox" checked aria-labelledby="painted-label" style="opacity:0;width:20px;height:20px"><span id="painted-label">Painted calendar</span></p>'
      + '<input type="checkbox" checked aria-label="Native overlay" style="opacity:0;width:20px;height:20px">'
      + '<label id="calendar-label">Calendar choice</label><div role="combobox" aria-labelledby="calendar-label">Current calendar</div>'
      + '<div role="option" aria-selected="false">Work</div><button>Duplicate</button><button>Duplicate</button>'
      + '<label>Start date<input value="2030-05-12"></label><label>Start time<input value="12:00"></label>'
      + '<label>Duplicate field<input value="one"></label><label>Duplicate field<input value="two"></label>'
      + '<div hidden><label>Hidden field<input value="PRIVATE_HIDDEN"></label></div>'
      + '<div role="combobox" contenteditable="true" aria-label="Editable choice">PRIVATE_DRAFT_VALUE</div></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dependencies = await loadVisualDependencies({ install: false });
  const browser = new ExtensionVisualBrowser({ dependencies, store: { directory, async prepare() {}, async read() {}, async write() {}, close() {} },
    origins: [origin], policy: createVisualOriginPolicy({ origins: [origin], allowLoopback: true }),
    observationMode: 'text', semanticControls: true, fieldCheckPolicy: { origins: [origin], labels: ['Start date', 'Start time', 'Duplicate field', 'Hidden field'] }, presentation: 'hidden', lease: { deadlineAt: Date.now() + 100_000 } });
  t.after(async () => { await browser.close().catch(() => browser.abort()); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const ready = value => { assert.equal(value.state, 'ready', value.reason); return value; };
  let frame = ready(await browser.call('navigate', { url: origin }));
  assert.equal(frame.controls.length, 40); assert.equal(frame.nextControlsOffset, 40);
  const later = ready(await browser.call('read-text', { controlOffset: 40 }));
  assert.ok(later.controls.some(c => c.label === 'Late target'));
  frame = ready(await browser.call('read-text', { controlQuery: 'Selected calendar' }));
  assert.equal(frame.controls.length, 1); assert.equal(frame.controls[0].role, 'checkbox'); assert.equal(frame.controls[0].checked, true);
  frame = ready(await browser.call('read-text', { controlQuery: 'Clipped calendar' }));
  assert.equal(frame.controls.length, 1); assert.equal(frame.controls[0].checked, true);
  frame = ready(await browser.call('click', { frameId: frame.frameId, x: frame.controls[0].x, y: frame.controls[0].y }));
  frame = ready(await browser.call('read-text', { controlQuery: 'Clipped calendar' }));
  assert.equal(frame.controls[0].checked, false, 'the visible native label toggles its clipped associated checkbox');
  frame = ready(await browser.call('read-text', { controlQuery: 'Native overlay' }));
  assert.equal(frame.controls.length, 1); assert.equal(frame.controls[0].checked, true);
  frame = ready(await browser.call('read-text', { controlQuery: 'Painted calendar' }));
  assert.equal(frame.controls.length, 1); assert.equal(frame.controls[0].checked, true);
  frame = ready(await browser.call('read-text', { controlQuery: 'Calendar choice' }));
  assert.equal(frame.controls[0].role, 'combobox');
  frame = ready(await browser.call('read-text', { controlQuery: 'Work' }));
  assert.equal(frame.controls[0].role, 'option'); assert.equal(frame.controls[0].selected, false);
  frame = ready(await browser.call('read-text', { controlQuery: 'Duplicate' }));
  assert.equal(frame.controls.filter(control => control.role === 'button').length, 2, 'duplicate labels must remain visibly ambiguous');
  const before = ready(await browser.call('read-text', { controlQuery: 'Late target' })).controls[0];
  frame = ready(await browser.call('read-text', { controlQuery: 'Reflow' }));
  ready(await browser.call('click', { frameId: frame.frameId, x: frame.controls[0].x, y: frame.controls[0].y }));
  frame = ready(await browser.call('read-text', { controlQuery: 'Late target' }));
  assert.notEqual(frame.controls[0].x, before.x, 'the recipe receives current geometry rather than a saved coordinate');
  frame = ready(await browser.call('click', { frameId: frame.frameId, x: frame.controls[0].x, y: frame.controls[0].y }));
  assert.match(frame.text, /TARGET_CLICKED/);
  const check = (id, label, values) => ({ id, label, match: 'equals', values });
  frame = ready(await browser.call('read-text', { checks: [check('date', 'Start date', ['2030-05-12']),
    check('time', 'Start time', ['13:00']), check('duplicate', 'Duplicate field', ['one']), check('hidden', 'Hidden field', ['PRIVATE_HIDDEN'])] }));
  assert.deepEqual(frame.fieldChecks, [{ id: 'date', state: 'matches' }, { id: 'time', state: 'different' },
    { id: 'duplicate', state: 'ambiguous' }, { id: 'hidden', state: 'missing' }]);
  assert.doesNotMatch(JSON.stringify(frame), /2030-05-12|12:00|13:00|PRIVATE_HIDDEN/);
  assert.equal((await browser.call('read-text', { checks: [check('foreign', 'Password', ['x'])] })).reason, 'invalid_input');
  assert.equal((await browser.call('navigate', { url: origin + '/password' })).reason, 'manual_control_active');
  const blocked = await browser.call('read-text', { checks: [check('date', 'Start date', ['2030-05-12'])] });
  assert.equal(blocked.reason, 'manual_control_active');
  assert.equal(blocked.fieldChecks, undefined);
  assert.doesNotMatch(JSON.stringify(blocked), /2030-05-12|PRIVATE_PASSWORD/);
  assert.doesNotMatch(JSON.stringify(frame), /PRIVATE_CHECK_VALUE|PRIVATE_DRAFT_VALUE|PRIVATE_CLIPPED_VALUE|PRIVATE_LABEL_DRAFT/);
});
test('visible link handoff is generic, canonical and excludes credential/callback references', () => {
  for (const url of ['https://documents.example/contract.docx?download=1', 'https://social.example/post/123#section',
    'http://127.0.0.1:1234/document']) assert.equal(readableLinkUrl(url), url);
  for (const url of [null, '', 'javascript:alert(1)', 'data:text/plain,content', 'file:///private/source',
    'https://user:password@example.test/doc', 'https://example.test/doc?code=SECRET',
    'https://example.test/doc?access_token=SECRET', 'https://example.test/doc?%63ode=SECRET',
    'https://example.test/doc#id_token=SECRET', 'https://example.test/doc#/callback?state=SECRET',
    'https://example.test/doc?returnUrl=https%3A%2F%2Fexample.test%2Fcallback%3Fcode%3DSECRET',
    'https://example.test/doc?SAMLResponse=SECRET', 'https://example.test/' + 'x'.repeat(2048)]) {
    assert.equal(readableLinkUrl(url), null);
  }
  const link = { role: 'link', label: 'Original', x: 10, y: 20, url: 'https://documents.example/contract.docx' };
  assert.equal(validateTextResult({ ...sample(), controls: [link] }).controls[0].url, link.url);
  for (const change of [{ role: 'button' }, { url: null }, { url: 'https://example.test/doc?code=SECRET' },
    { url: 'https://documents.example:443/contract.docx' }, { href: 'https://other.example/' }]) {
    assert.throws(() => validateTextResult({ ...sample(), controls: [{ ...link, ...change }] }), /VISUAL_RESULT_INVALID/);
  }
  assert.equal(validateTextResult({ ...sample(), linkTargetsLimited: true }).linkTargetsLimited, true);
  assert.throws(() => validateTextResult({ ...sample(), linkTargetsLimited: false }), /VISUAL_RESULT_INVALID/);
  assert.throws(() => validateTextResult({ ...sample(), controls: Array.from({ length: 10 }, (_, i) => ({ ...link,
    url: 'https://documents.example/' + i + 'x'.repeat(1000) })) }), /VISUAL_RESULT_INVALID/);
});
test('the actual fixed observer does not read href without signed external-navigation opt-in', () => {
  let handler, result, hrefReads = 0;
  const anchor = { tagName: 'A', parentElement: null,
    get href() { hrefReads++; return 'https://documents.example/original.docx'; },
    getAttribute(name) { return name === 'aria-label' ? 'Original' : null; },
    closest() { return null; }, getClientRects() { return [{}]; },
    getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }; },
    contains(value) { return value === this; } };
  const context = vm.createContext({ URL, URLSearchParams, TextEncoder, innerWidth: 1440, innerHeight: 900,
    NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    chrome: { runtime: { id: 'synthetic-extension', onMessage: { addListener(value) { handler = value; } } } },
    document: { title: 'Synthetic source', body: {}, createTreeWalker: () => ({ nextNode: () => null }),
      querySelectorAll: selector => selector.includes('input[type="password"]') ? [] : [anchor], elementFromPoint: () => anchor } });
  for (const includeTargets of [false, true]) {
    vm.runInContext(buildTextObserverScript(includeTargets), context);
    handler({ kind: 'read_rendered_text' }, { id: 'synthetic-extension' }, value => { result = value; });
    assert.equal(result.controls[0].url, includeTargets ? anchor.href : undefined);
    if (!includeTargets) assert.equal(hrefReads, 0, 'legacy observation must not even inspect the link destination');
  }
});
test('isolated observer pages and metadata keep emoji whole using the packaged common policy', () => {
  let handler;
  const source = 'a'.repeat(5999) + '💗👍🏽👨‍👩‍👧‍👦🇷🇺' + 'z'.repeat(6100);
  const parent = { parentElement: null, closest: () => null, getAttribute: () => null,
    getClientRects: () => [{}] };
  const context = vm.createContext({ URL, URLSearchParams, TextEncoder,
    NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    chrome: { runtime: { id: 'synthetic-extension', onMessage: { addListener(value) { handler = value; } } } },
    document: { title: 't'.repeat(239) + '💗tail', body: {}, querySelectorAll: () => [],
      createTreeWalker() { let read = false; return { nextNode() {
        if (read) return null; read = true; return { textContent: source, parentElement: parent };
      } }; } } });
  // Execute exactly the same self-contained script that is written for Chrome,
  // without supplying lexical imports that the isolated world cannot capture.
  vm.runInContext(buildTextObserverScript(), context);
  const read = offset => { let result;
    handler({ kind: 'read_rendered_text', offset, includeControls: false }, { id: 'synthetic-extension' }, value => { result = value; });
    return result;
  };
  let offset = 0, rebuilt = '';
  for (;;) {
    const result = read(offset);
    assert.ok(result.text.isWellFormed()); assert.ok(result.title.isWellFormed());
    assert.ok(result.text.length <= 6000); assert.ok(result.title.length <= 240);
    rebuilt += result.text;
    if (result.nextOffset === null) break;
    assert.equal(result.nextOffset, offset + result.text.length);
    assert.ok(result.nextOffset > offset); offset = result.nextOffset;
  }
  assert.equal(rebuilt, source);
  assert.equal(read(6000).error, 'invalid_input');
  for (const key of ['title', 'text']) assert.throws(() => validateTextResult({ ...sample(), [key]: '\uD83D' }), /VISUAL_RESULT_INVALID/);
});
test('text crosses the actual typed MCP action handler without generic stdout truncation', async () => {
  const { handleToolCall } = await import('../host-runtime/scripts/trelio-remote-mcp.mjs');
  const { handleTrelioWorkspaceActionOperation } = await import('../host-runtime/scripts/trelio-local-context.mjs');
  const value = { ...sample(), nextControlsOffset: null, fieldChecks: [{ id: 'date', state: 'matches' }], text: 'Описание услуги '.repeat(350), controls: [
    { role: 'link', label: 'Original', x: 20, y: 30, url: 'https://documents.example/original.docx?download=1' }] };
  const result = await handleToolCall('https://example.test', 'continue_trelio_workspace_action', { schemaVersion: 1, operation: 'skill_run', parameters: { companyId: value.sessionId, skillId: 'synthetic-visual-fixture', releaseId: value.frameId, arguments: ['read-text'] } }, {
    workspaceActionOperation: (origin, args) => handleTrelioWorkspaceActionOperation(origin, args, { runBridge: async () => ({ stdout: JSON.stringify(value), stderr: '' }) }),
  });
  assert.equal(result.content.length, 1);
  assert.equal(JSON.parse(result.content[0].text).text, value.text);
  assert.deepEqual(JSON.parse(result.content[0].text).controls, value.controls);
  assert.deepEqual(JSON.parse(result.content[0].text).fieldChecks, value.fieldChecks);
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
  let received, window, externalRequests = 0;
  const externalServer = http.createServer((req, res) => {
    externalRequests++;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/contract' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>External contract</title><h1>EXTERNAL_CONTRACT_TEXT</h1><p>Linked document body</p>');
  });
  await new Promise(resolve => externalServer.listen(0, '127.0.0.1', resolve));
  const externalOrigin = `http://127.0.0.1:${externalServer.address().port}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/submitted') received = url.searchParams.get('q');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/links') {
      res.end('<!doctype html><title>Link budget</title>' + Array.from({ length: 25 }, (_, i) =>
        `<a href="${externalOrigin}/long/${i}/${'x'.repeat(600)}">Long link ${i}</a> `).join(''));
      return;
    }
    res.end(`<!doctype html><title>Синтетическое объявление</title><body style="font:20px sans-serif"><h1>Объявление для проверки</h1><form action="/submitted"><input name="q" placeholder="Поиск" value="INPUT_SECRET"><button>Найти</button></form><a target="_blank" href="/detail">Подробности</a><a target="_blank" href="${externalOrigin}/redirect">Внешний договор</a><a href="${externalOrigin}/callback?code=URL_TOKEN_SECRET">Callback</a><a href="${externalOrigin}/#/callback?access_token=FRAGMENT_TOKEN_SECRET">Fragment callback</a><a hidden href="${externalOrigin}/HIDDEN_URL_SECRET">Hidden URL</a><div hidden>HIDDEN_SECRET</div><script>const secret='SCRIPT_SECRET';</script><label>Комментарий<textarea>TEXTAREA_SECRET</textarea></label><div contenteditable="plaintext-only" role="textbox" aria-label="Текст сообщения">DRAFT_SECRET</div><input type="password" hidden value="HIDDEN_PASSWORD_SECRET">${url.pathname === '/password' ? '<input type="password" value="PASSWORD_SECRET">' : ''}${url.pathname === '/otp' ? '<input autocomplete="ONE-TIME-CODE" value="OTP_SECRET">' : ''}${url.pathname === '/readonly' ? readonlyDocumentFixture() : ''}<p>Редкая фраза: проверка фильтра</p>${url.pathname === '/long' ? '<div>' + 'Длинное описание '.repeat(800) + '</div>' : ''}${Array.from({ length: 200 }, (_, i) => `<p>Строка ${i} – ${'Описание услуги '.repeat(5)}</p>`).join('')}</body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { ExtensionVisualBrowser } = await import(new URL('trelio-visual-extension-browser.mjs', directory));
  const { loadVisualDependencies } = await import(new URL('trelio-visual-bootstrap.mjs', directory));
  const { createVisualOriginPolicy } = await import(new URL('trelio-visual-browser.mjs', directory));
  const dependencies = await loadVisualDependencies();
  const browser = new ExtensionVisualBrowser({ dependencies, observationMode: 'text', externalNavigation: true, testWindowController: value => { window = value; }, store: { directory: fixture, async read() { return null; }, async prepare() {}, async write() {}, close() {} }, policy: createVisualOriginPolicy({ origins: [origin], externalNavigation: true, allowLoopback: true }), origins: [origin], lease: { deadlineAt: Date.now() + 100_000 }, testHeadless: process.env.TRELIO_TEXT_HEADED !== '1' });
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
    assert.equal(frame.controls.find(c => c.label === 'Внешний договор')?.url, `${externalOrigin}/redirect`);
    assert.equal(externalRequests, 0, 'reading a source URL must not fetch or resolve its destination');
    const firstPageText = frame.text;
    assert.equal(frame.text.length, 6000); assert.ok(frame.nextOffset);
    assert.doesNotMatch(JSON.stringify(frame), /INPUT_SECRET|HIDDEN_SECRET|SCRIPT_SECRET|TEXTAREA_SECRET|DRAFT_SECRET|URL_TOKEN_SECRET|FRAGMENT_TOKEN_SECRET|HIDDEN_URL_SECRET/);
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
    frame = ready(await browser.call('navigate', { url: `${origin}/links` }));
    frame = ready(await browser.call('read-text'));
    assert.equal(frame.linkTargetsLimited, true);
    assert.ok(frame.controls.some(c => c.url) && frame.controls.some(c => !c.url));
    for (const c of frame.controls.filter(c => c.url)) assert.ok(c.url.endsWith('x'.repeat(600)), 'targets are omitted whole, never shortened');
    assert.equal(externalRequests, 0, 'budget handling does not inspect external responses');
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
    frame = ready(await browser.call('navigate', { url: origin }));
    frame = ready(await browser.call('click', control(frame, 'Внешний договор')));
    frame = ready(await browser.call('read-text'));
    assert.match(frame.text, /EXTERNAL_CONTRACT_TEXT/);
    ready(await browser.call('navigate', { url: origin }));
    assert.equal((await browser.call('navigate', { url: `${origin}/password` })).reason, 'manual_control_active');
    assert.equal((await browser.call('read-text')).reason, 'manual_control_active');
    assert.equal((await browser.call('navigate', { url: `${origin}/otp` })).reason, 'manual_control_active');
    assert.equal((await browser.call('read-text')).reason, 'manual_control_active');
    assert.equal((await browser.call('setup', { url: origin })).state, 'manual_input_required');
    assert.equal((await browser.call('read-text')).reason, 'manual_control_active');
  } finally {
    await browser.close().catch(() => browser.abort());
    assert.equal(window?.running() ?? false, false, 'close leaves no owned browser process or tabs');
    server.closeAllConnections(); externalServer.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => externalServer.close(resolve))]);
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
