import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOCAL_FORM_API, LOCAL_FORM_CSP, renderLocalFormPage, renderLocalFormMessage, renderCompanyEncryptionKeyPage, buildAgentSkillRuntimeEnvironment } from '../host-runtime/scripts/trelio-workspace.mjs';
import { renderCredentialPage } from '../host-runtime/scripts/trelio-remote-mcp.mjs';
import { loadVisualDependencies, ensureVisualChromium } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';

const moduleUrl = new URL('../host-runtime/scripts/trelio-workspace.mjs', import.meta.url);
const qr = { label: 'Синтетический QR для проверки интерфейса', help: 'Откройте приложение на телефоне', matrix: Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => (x + y) % 2 === 0)) };
const definition = () => ({ title: 'Подключить тестовый сервис', sections: [
  { fields: [{ name: 'login', label: 'Логин', type: 'text', required: true, help: 'Локальный ввод' }, { name: 'password', label: 'Пароль', type: 'password', required: true }] },
  { qr: structuredClone(qr) },
], form: { action: '/credential', nonce: 'SYNTHETIC_NONCE', actions: [
  { label: 'Сохранить на устройстве', name: 'decision', value: 'save' },
  { label: 'Отмена', name: 'decision', value: 'cancel', variant: 'secondary', formNoValidate: true },
] } });

test('one declarative renderer escapes content and owns fields, QR, feedback and native actions', () => {
  assert.equal(LOCAL_FORM_API, 'trelio.local-form/v1');
  const input = definition(); input.title = '<script>UNTRUSTED</script>'; input.sections[0].fields[0].error = '<img src=x onerror=alert(1)>';
  const html = renderLocalFormPage(input);
  assert.match(html, /data-trelio-local-form="v1"/);
  assert.match(html, /&lt;script&gt;UNTRUSTED&lt;\/script&gt;/);
  assert.match(html, /aria-invalid="true"/); assert.match(html, /aria-describedby="local-field-login-help local-field-login-error"/);
  assert.match(html, /formnovalidate/); assert.match(html, /viewBox="0 0 29 29"/);
  assert.doesNotMatch(html, /<script|<img|<iframe|onerror=alert\(1\)>|@import|url\(/);
  assert.match(LOCAL_FORM_CSP, /default-src 'none'/); assert.doesNotMatch(LOCAL_FORM_CSP, /script-src|img-src/);
  assert.equal((html.match(/<h1>/g) || []).length, 1);
});

test('private form definitions cannot inject HTML/CSS, secret prefill, external POST or QR resources', () => {
  for (const mutate of [
    input => { input.html = '<form>'; }, input => { input.style = 'body{}'; },
    input => { input.sections[0].fields[1].value = 'SYNTHETIC_PRIVATE_PASSWORD'; },
    input => { input.form.action = '//external.example.test/credential'; },
    input => { input.sections[1].qr = { url: 'https://example.test/secret-qr' }; },
    input => { input.sections[1].qr.matrix[0][0] = '<svg>'; },
    input => { input.sections[0].fields.push({ ...input.sections[0].fields[0] }); },
    input => { input.sections[0].links = [{ label: 'Link', url: 'javascript:alert(1)' }]; },
  ]) {
    const input = definition(); mutate(input);
    assert.throws(() => renderLocalFormPage(input), error => error.code === 'LOCAL_FORM_INVALID' && !/SYNTHETIC|external|alert|secret-qr/.test(error.message));
  }
});

test('host credential, key and terminal pages share exactly the same style and status semantics', () => {
  const pages = [renderLocalFormPage(definition()), renderCompanyEncryptionKeyPage({ companyName: 'Synthetic company', nonce: 'SYNTHETIC_NONCE' }),
    renderCredentialPage({ resolved: { skill: { title: 'Synthetic skill' }, remoteMcp: { config: {} } }, nonce: 'SYNTHETIC_NONCE' }),
    renderLocalFormMessage('Готово', 'Подключение сохранено', 'success')];
  const style = pages[0].match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const html of pages) { assert.equal(html.match(/<style>([\s\S]*?)<\/style>/)[1], style); assert.match(html, /data-trelio-local-form="v1"/); }
  assert.match(renderLocalFormMessage('Ошибка', 'Повторите ввод', 'error'), /role="alert"/);
  assert.match(renderLocalFormMessage('Проверка', 'Ожидание', 'pending'), /aria-busy="true"/);
});

test('common choice and file controls retain native semantics and require explicit multipart ownership', () => {
  const input = definition();
  input.sections[0].fields = [
    { name: 'mode', label: 'Режим', type: 'select', options: [{ label: 'Только отправка', value: 'send' }, { label: 'Чтение и отправка', value: 'both' }] },
    { name: 'confirm', label: 'Подтверждаю выбор', type: 'checkbox', required: true },
    { name: 'image', label: 'Изображение', type: 'file', accept: 'image/png' },
  ];
  assert.throws(() => renderLocalFormPage(input), { code: 'LOCAL_FORM_INVALID' });
  input.form.encoding = 'multipart';
  const html = renderLocalFormPage(input);
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.match(html, /<select[^>]*name="mode"/);
  assert.match(html, /<option value="send">Только отправка/);
  assert.match(html, /type="checkbox"[^>]*required/);
  assert.match(html, /type="file"[^>]*accept="image\/png"/);
});

test('non-JS process adapter renders the same definition with closed failures and no argument input', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(moduleUrl), 'local-form-render'], { input: JSON.stringify(definition()), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0); assert.equal(result.stderr, ''); assert.equal(result.stdout, renderLocalFormPage(definition()));
  const rejected = spawnSync(process.execPath, [fileURLToPath(moduleUrl), 'local-form-render', 'SYNTHETIC_PRIVATE_ARGUMENT'], { input: '{}', encoding: 'utf8', timeout: 10000 });
  assert.equal(rejected.status, 1); assert.equal(rejected.stdout, ''); assert.equal(rejected.stderr, 'LOCAL_FORM_INVALID\n');
});

test('signed skills receive only the current host form module and executable, never inherited replacements', () => {
  const base = { artifact: { skillId: 'synthetic', runtimeVersion: '0.0.0', parsedPackage: { capabilities: [] } }, runtimeDirectory: '/synthetic/runtime', executionContext: { releaseId: 'synthetic-release', companyId: 'synthetic-company' }, inheritedEnvironment: { TRELIO_LOCAL_FORM_MODULE_URL: 'file:///untrusted.mjs', TRELIO_LOCAL_FORM_NODE_EXECUTABLE: '/untrusted/node' } };
  const env = buildAgentSkillRuntimeEnvironment(base);
  assert.equal(env.TRELIO_LOCAL_FORM_MODULE_URL, moduleUrl.href); assert.equal(env.TRELIO_LOCAL_FORM_NODE_EXECUTABLE, process.execPath);
  for (const name of ['TRELIO_LOCAL_FORM_MODULE_URL', 'TRELIO_LOCAL_FORM_NODE_EXECUTABLE']) assert.throws(() => buildAgentSkillRuntimeEnvironment({ ...base, grantedEnvironment: { [name]: 'SYNTHETIC_OVERRIDE' } }));
});

test('native local form stays keyboard accessible at 1440, 390 and 320px; POST preserves decision and clears secret on error', { skip: process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 120000 }, async () => {
  const deps = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const executablePath = await ensureVisualChromium(deps);
  const submissions = []; const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = definition();
    if (request.method === 'POST') { submissions.push(new URLSearchParams(Buffer.concat(chunks).toString())); input.notice = { tone: 'error', text: 'Синтетическая ошибка. Повторите ввод' }; }
    response.writeHead(request.method === 'POST' ? 400 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': LOCAL_FORM_CSP }).end(renderLocalFormPage(input));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await deps.chromium.launch({ executablePath, headless: true });
  try {
    for (const width of [1440, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: width === 1440 ? 900 : 844 }, hasTouch: width !== 1440 });
      const outbound = []; page.on('request', request => { if (!request.url().startsWith(origin)) outbound.push(request.url()); });
      await page.goto(origin);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('h1').count(), 1);
      assert.ok((await page.getByRole('button', { name: 'Сохранить на устройстве' }).boundingBox()).height >= 44);
      await page.keyboard.press('Tab'); assert.equal(await page.locator(':focus').getAttribute('name'), 'login');
      assert.notEqual(await page.locator(':focus').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
      await page.getByLabel('Логин', { exact: true }).fill('SYNTHETIC_LOGIN'); await page.getByLabel('Пароль', { exact: true }).fill('SYNTHETIC_PRIVATE_PASSWORD');
      await page.getByRole('button', { name: 'Сохранить на устройстве' }).click(); await page.waitForLoadState();
      assert.equal(submissions.at(-1).get('decision'), 'save'); assert.equal(submissions.at(-1).get('nonce'), 'SYNTHETIC_NONCE');
      assert.equal(await page.getByLabel('Пароль', { exact: true }).inputValue(), '');
      await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await page.waitForLoadState();
      assert.equal(submissions.at(-1).get('decision'), 'cancel'); assert.deepEqual(outbound, []);
      // Optional artifacts contain synthetic UI only, never a live auth QR.
      if (process.env.TRELIO_LOCAL_FORM_SCREENSHOT_DIR) { await fs.mkdir(process.env.TRELIO_LOCAL_FORM_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.TRELIO_LOCAL_FORM_SCREENSHOT_DIR, `local-form-${width}.png`), fullPage: true }); }
      await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
