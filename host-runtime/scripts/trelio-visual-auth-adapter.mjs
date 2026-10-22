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
