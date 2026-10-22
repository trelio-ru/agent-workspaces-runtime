import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAgentSecretTotpValue, deriveAgentSecretTotp } from './trelio-workspace.mjs';
import { collectCredentialThroughLoopback } from './trelio-remote-mcp.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export const VISUAL_AUTHENTICATION_API = 'trelio.protected-browser-auth/v1';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const selector = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/u.test(value);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** A signed provider declares selectors once in source, not in CLI/MCP args.
 * Credentials bind to the complete normalized recipe, in addition to the
 * account/skill/origin AEAD scope. A changed destination or form therefore
 * requires explicit local replacement instead of silently reusing a secret.
 * Wildcard navigation domains never authorize credential delivery origins.
 */
export function normalizeVisualAuthentication(value, policy) {
  if (value === undefined || value === null) return null;
  if (Buffer.byteLength(JSON.stringify(value)) > 16_384) fail('invalid_input');
  if (!exact(value, ['steps', 'success']) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8 || !Array.isArray(value.success) || value.success.length < 1 || value.success.length > 8) fail('invalid_input');
  const origin = raw => {
    if (typeof raw !== 'string' || !policy.origins?.includes(raw)) fail('navigation_blocked');
    const url = new URL(raw);
    if (url.origin !== raw || url.username || url.password || (url.protocol !== 'https:' && !policy.fixtureOnly)) fail('navigation_blocked');
    return raw;
  };
  const steps = value.steps.map(step => {
    if (!exact(step, ['id', 'origin', 'challenge', 'fields', 'submit', 'manual']) || !id(step.id) || !selector(step.challenge) || (step.submit !== null && !selector(step.submit)) || !exact(step.fields, ['login', 'password', 'totp']) || !Object.keys(step.fields).length) fail('invalid_input');
    const fields = {};
    for (const key of ['login', 'password', 'totp']) if (Object.hasOwn(step.fields, key)) {
      const list = Array.isArray(step.fields[key]) ? step.fields[key] : [step.fields[key]];
      if (!list.length || list.length > (key === 'totp' ? 8 : 1) || !list.every(selector) || new Set(list).size !== list.length) fail('invalid_input');
      fields[key] = list.slice();
    }
    // A saved TOTP cannot satisfy an SMS/push challenge. Its recipe must name
    // an actual TOTP-specific rendered challenge, never just a generic OTP box.
    const manual = step.manual ?? [];
    if (!Array.isArray(manual) || manual.length > 8 || !manual.every(selector)) fail('invalid_input');
    return { id: step.id, origin: origin(step.origin), challenge: step.challenge, fields, submit: step.submit, manual: manual.slice() };
  });
  if (new Set(steps.map(step => step.id)).size !== steps.length) fail('invalid_input');
  const success = value.success.map(item => {
    if (!exact(item, ['origin', 'selector']) || !selector(item.selector)) fail('invalid_input');
    return { origin: origin(item.origin), selector: item.selector };
  });
  return { steps, success };
}

export const visualAuthenticationFingerprint = definition => crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');

function validateCredentials(value, definition) {
  if (!exact(value, ['schemaVersion', 'fingerprint', 'login', 'password', 'totp', 'attempt']) || value.schemaVersion !== 1 || value.fingerprint !== visualAuthenticationFingerprint(definition)) fail('authentication_setup_required');
  for (const field of ['login', 'password', 'totp']) if (typeof value[field] !== 'string' || Buffer.byteLength(value[field]) > 4096 || /[\x00\r\n]/u.test(value[field])) fail('authentication_setup_required');
  const uses = field => definition.steps.some(step => Object.hasOwn(step.fields, field));
  if ((uses('login') && !value.login) || (uses('password') && !value.password)) fail('authentication_setup_required');
  if (value.totp) {
    let parsed;
    try { parsed = parseAgentSecretTotpValue(value.totp); }
    catch { fail('authentication_setup_required'); }
    finally { parsed?.secret.fill(0); }
  }
  if (value.attempt !== null && (!exact(value.attempt, ['id', 'state', 'steps']) || !/^[0-9a-f-]{36}$/u.test(value.attempt.id) || !['pending', 'complete'].includes(value.attempt.state) || !Array.isArray(value.attempt.steps) || value.attempt.steps.length > 8 || !value.attempt.steps.every(key => definition.steps.some(step => step.id === key)))) fail('authentication_setup_required');
  return value;
}

export async function hasVisualAuthenticationCredentials(store, definition) {
  const value = await store.readCredentials();
  if (!value) return false;
  try { validateCredentials(value, definition); return true; }
  finally { value.login = ''; value.password = ''; value.totp = ''; }
}

/** Fields are entered by the human in the host's existing guarded loopback
 * collector. The completion callback writes encrypted bytes before reporting
 * success. There is no credential-returning API, terminal mode or model input.
 */
export async function configureVisualAuthentication({ store, definition, signal, openBrowserFn, handoffTimeoutMs, setupTimeoutMs }) {
  await store.prepare();
  const fingerprint = visualAuthenticationFingerprint(definition);
  const uses = field => definition.steps.some(step => Object.hasOwn(step.fields, field));
  const field = (key, label, help = '') => `<label for="${key}">${label}</label><input id="${key}" name="${key}" type="${key === 'login' ? 'text' : 'password'}" maxlength="4096" autocomplete="off" ${key !== 'totp' ? 'required' : ''}>${help ? `<p id="${key}-help">${help}</p>` : ''}`;
  await collectCredentialThroughLoopback('https://trelio.ru', {}, {
    signal, ...(openBrowserFn ? { openBrowserFn } : {}), ...(handoffTimeoutMs ? { handoffTimeoutMs } : {}), ...(setupTimeoutMs ? { setupTimeoutMs } : {}), allowCancel: true,
    renderForm: ({ nonce, errorMessage }) => `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Данные входа</title><style>:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{max-width:38rem;margin:2rem auto;padding:0 1rem}form{display:grid;gap:.75rem}input,button{box-sizing:border-box;width:100%;min-height:44px;padding:.75rem;font:inherit}p{margin:.25rem 0 1rem}button:focus-visible,input:focus-visible{outline:3px solid #3984ff;outline-offset:3px}</style><h1>Данные входа</h1><p>Сохранение только на этом устройстве. Агент и Trelio не получат значения.</p><p>Адреса входа: ${escape([...new Set(definition.steps.map(step => step.origin))].join(', '))}</p>${errorMessage ? '<p role="alert">Проверьте поля. Данные не сохранены; повторите ввод или отмените настройку.</p>' : ''}<form method="post" action="/credential" autocomplete="off"><input type="hidden" name="nonce" value="${escape(nonce)}">${uses('login') ? field('login', 'Логин') : ''}${uses('password') ? field('password', 'Пароль') : ''}${uses('totp') ? field('totp', 'TOTP-секрет (необязательно)', 'Заранее включите TOTP у сервиса. Введите Base32-секрет или ссылку otpauth://totp, а не текущий код. Совместное хранение с паролем уменьшает независимость второго фактора. Можно оставить пустым и вводить код вручную.') : ''}<p>Сохранять данные в браузере не нужно – подключение будет сохранено отдельно на этом устройстве. Если браузер предложит сохранить данные, выберите «Нет, спасибо».</p><button name="decision" value="save" type="submit">Сохранить на устройстве</button><button name="decision" value="cancel" type="submit" formnovalidate>Отмена</button></form></html>`,
    parseSubmission: form => {
      const allowed = ['nonce', 'decision', ...['login', 'password', 'totp'].filter(uses)];
      if ([...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1) || form.get('decision') !== 'save') fail('invalid_input');
      return validateCredentials({ schemaVersion: 1, fingerprint, login: form.get('login') || '', password: form.get('password') || '', totp: (form.get('totp') || '').trim(), attempt: null }, definition);
    },
    doctorCredential: async () => {},
    persistCredential: async (_origin, _resolved, credentials) => { signal?.throwIfAborted(); await store.writeCredentials(credentials); },
    successMessage: 'Данные входа зашифрованы и сохранены на устройстве. Эту вкладку можно закрыть.',
  });
}

/** Only closed structural observations cross the private browser boundary.
 * Persist the attempt BEFORE the first secret dispatch; timeout, crash, reload
 * or another CLI cannot replay it. A verified success may reconcile a pending
 * result without resubmitting. Human replacement explicitly clears the fence.
 */
export async function authenticateVisualBrowser({ store, definition, send, active, wait = sleep, now = Date.now }) {
  const observe = async () => {
    active();
    const value = await send('authentication-probe');
    if (!exact(value, ['state', 'stepId', 'documentId']) || !['success', 'challenge', 'unknown'].includes(value.state) || (value.state === 'challenge' && (!definition.steps.some(step => step.id === value.stepId) || typeof value.documentId !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.documentId)))) fail('authentication_unknown');
    return value;
  };
  let credentials;
  try {
    const initial = await observe();
    if (initial.state === 'success') {
      // Reuse a proven active session without accessing the credential vault.
      // A previous pending fence is reconciled only if credentials are needed
      // again; it cannot authorize a replay merely from this success result.
      return { state: 'saved_unverified', reason: 'none' };
    }
    if (initial.state !== 'challenge') return { state: 'manual_input_required', reason: 'authentication_required' };
    credentials = validateCredentials(await store.readCredentials(), definition);
    if (credentials.attempt?.state === 'pending') fail('authentication_unknown');
    const attempt = { id: crypto.randomUUID(), state: 'pending', steps: [] };
    credentials.attempt = attempt;
    await store.writeCredentials(credentials);
    const until = now() + 30_000;
    let probe = initial;
    while (now() < until) {
      active();
      if (probe.state === 'success') {
        attempt.state = 'complete'; await store.writeCredentials(credentials);
        return { state: 'saved_unverified', reason: 'none' };
      }
      const step = definition.steps.find(item => item.id === probe.stepId);
      if (probe.state === 'challenge' && step && !attempt.steps.includes(step.id)) {
        if (step.fields.totp && credentials.totp) {
          const parsed = parseAgentSecretTotpValue(credentials.totp);
          const remaining = parsed.periodSeconds * 1000 - now() % (parsed.periodSeconds * 1000); parsed.secret.fill(0);
          if (remaining < 5000) {
            // Restart the WHOLE challenge after waiting, not just a field loop:
            // no partially filled/missing code may reach the submission path.
            await wait(remaining + 50); active(); probe = await observe(); continue;
          }
        }
        const values = {};
        for (const key of Object.keys(step.fields)) {
          if (!credentials[key]) return { state: 'manual_input_required', reason: 'authentication_required' };
          if (key === 'totp') {
            values.totp = deriveAgentSecretTotp(credentials.totp, now());
          } else values[key] = credentials[key];
        }
        // No old document token survives a time-window wait or navigation.
        if (probe.state !== 'challenge' || probe.stepId !== step.id) continue;
        attempt.steps.push(step.id); await store.writeCredentials(credentials); active();
        let value;
        try { value = await send('authentication-fill', { stepId: step.id, documentId: probe.documentId, values }); }
        finally { for (const key of Object.keys(values)) values[key] = ''; }
        if (!exact(value, ['state']) || value.state !== 'submitted') fail('authentication_unknown');
      }
      await wait(200); active(); probe = await observe();
      // Unknown after submission can be a normal redirect/SPA loading state.
      // Wait only within this attempt; never choose another field or method.
    }
    return { state: 'manual_input_required', reason: 'authentication_unknown' };
  } finally {
    if (credentials) { credentials.login = ''; credentials.password = ''; credentials.totp = ''; }
  }
}

/** Fixed isolated-world credential adapter. Materialized with a SIGNED recipe,
 * never caller JS/selectors or values. Secret values arrive only in a private
 * extension message, stay in RAM/the provider form and are never observations.
 * Top-frame origin, document token, uniqueness, form destination and the whole
 * challenge are checked again immediately before each field and submission.
 */
export function installVisualAuthentication(definition) {
  if (window.top !== window) return;
  const documentId = crypto.randomUUID(), spent = new Set();
  const visible = element => {
    if (!(element instanceof HTMLElement) || element.hidden || element.closest('[hidden],[inert]')) return false;
    const css = getComputedStyle(element), rect = element.getBoundingClientRect();
    return css.display !== 'none' && css.visibility === 'visible' && css.opacity !== '0' && rect.width > 0 && rect.height > 0;
  };
  const unique = selector => {
    const nodes = [...document.querySelectorAll(selector)].filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const sensitive = () => [...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code" i]')].some(visible);
  const challenge = step => {
    if (location.origin !== step.origin || !unique(step.challenge) || step.manual.some(selector => [...document.querySelectorAll(selector)].some(visible))) return null;
    const submit = step.submit === null ? null : unique(step.submit);
    if (step.submit !== null && (!(submit instanceof HTMLButtonElement || submit instanceof HTMLInputElement) || submit.disabled)) return null;
    const fields = [];
    for (const [key, selectors] of Object.entries(step.fields)) for (const selector of selectors) {
      const input = unique(selector);
      if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly || !['text', 'email', 'tel', 'password', 'number'].includes(input.type) || (key === 'password' && input.type !== 'password')) return null;
      fields.push({ key, input });
    }
    if (new Set(fields.map(item => item.input)).size !== fields.length) return null;
    // A same-origin form action is necessary but does not sandbox the site's
    // own JavaScript. Only explicitly trusted provider origins may be signed.
    const form = fields[0]?.input.form;
    if (!form || fields.some(item => item.input.form !== form) || (submit && submit.form !== form) || new URL(submit?.formAction || form.action, location.href).origin !== step.origin || (submit?.formTarget || form.target || '_self') !== '_self' || (submit?.getAttribute('formmethod') || form.method).toLowerCase() !== 'post') return null;
    return { fields, submit };
  };
  const probe = () => {
    if (!definition) return { state: 'unknown' };
    if (!sensitive() && definition.success.some(item => location.origin === item.origin && unique(item.selector))) return { state: 'success' };
    const matches = definition.steps.filter(step => challenge(step));
    return matches.length === 1 ? { state: 'challenge', stepId: matches[0].id, documentId } : { state: 'unknown' };
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    try {
      if (message?.kind === 'authentication-guard') { respond({ blocked: sensitive() || Boolean(definition?.steps.some(step => challenge(step))) }); return; }
      if (!definition) return;
      if (message?.kind === 'authentication-probe') { respond(probe()); return; }
      if (message?.kind !== 'authentication-fill') return;
      const current = probe(), step = definition.steps.find(item => item.id === message.stepId);
      if (!step || current.state !== 'challenge' || current.stepId !== step.id || message.documentId !== documentId || spent.has(step.id) || !message.values || Object.keys(message.values).sort().join() !== Object.keys(step.fields).sort().join()) throw Error();
      for (const [key, value] of Object.entries(message.values)) if (typeof value !== 'string' || !value || value.length > 4096 || (key === 'totp' && !/^\d{6}(?:\d{2})?$/u.test(value))) throw Error();
      const controls = challenge(step);
      if (!controls) throw Error();
      // Fence BEFORE setting the first character. Even an event handler that
      // throws, navigates, submits early or replaces a field cannot replay it.
      spent.add(step.id);
      const indexes = {};
      for (const { key, input } of controls.fields) {
        if (location.origin !== step.origin || !input.isConnected || !challenge(step)?.fields.some(item => item.input === input)) throw Error();
        const value = message.values[key], parts = step.fields[key].length;
        if (parts > 1 && value.length !== parts) throw Error();
        const index = indexes[key] || 0; indexes[key] = index + 1;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, parts > 1 ? value[index] : value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const final = challenge(step);
      if (!final || final.submit !== controls.submit || location.origin !== step.origin) throw Error();
      // A TOTP last-character handler may already submit. No click is made if
      // it replaced/detached the form. Such an uncertain result stays fenced.
      // null is a signed declaration that the provider auto-submits on input.
      // Never add an extra click to such a challenge (including segmented OTP).
      controls.submit?.click(); respond({ state: 'submitted' });
    } catch { respond({ state: 'unknown' }); }
    finally {
      if (message?.values) for (const key of Object.keys(message.values)) message.values[key] = '';
    }
  });
}
