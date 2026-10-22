/** Fixed isolated-world reader for a signed host opt-in, never page JS.
 * It reads rendered text nodes and viewport control labels, without reading
 * input values, attributes inventories, HTML, storage or network responses.
 * Requests contain a literal text filter and offset, never a selector/script.
 */
export function installTextObserver() {
  const clean = (value, limit) => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, limit);
  const hidden = element => {
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return true;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return true;
    }
    return !element.getClientRects().length;
  };
  const privateText = element => {
    // Published rich-text documents can keep contenteditable="false" on every
    // paragraph, heading and table cell. That explicit read-only attribute is
    // not an input value. Keep every other editable declaration fail-closed,
    // including invalid/inherited values and false islands in a live editor.
    // A role=textbox stays a field even when it is disabled or read-only.
    if (element.closest('script,style,noscript,template,input,textarea,select,option,[contenteditable]:not([contenteditable="false" i]),[role~="textbox" i]')) return true;
    // A disabled rich-text field or its wrapping label must not become a
    // document merely because a form switched its editor to read-only.
    return Boolean(element.closest('[contenteditable="false" i]') && element.closest('form,label'));
  };
  const fieldLabel = element => {
    const label = element.labels?.[0];
    if (!label) return '';
    // A wrapping label may contain the textarea itself. textContent on that
    // label would reveal its initial value, even without reading .value.
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    let text = '', visited = 0;
    for (let node; (node = walker.nextNode()) && ++visited <= 64 && text.length < 160;) {
      const parent = node.parentElement;
      if (!parent || parent.closest('textarea,select,option,script,style,[contenteditable],[role="textbox"]') || hidden(parent)) continue;
      text += ' ' + node.textContent;
    }
    return clean(text, 160);
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.kind !== 'read_rendered_text') return;
    const { query = '', offset = 0, includeControls = true } = message;
    if (typeof query !== 'string' || query.length > 120 || typeof includeControls !== 'boolean' || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return respond({ error: 'invalid_input' });
    // Credentials never become a model observation. A trusted host may handle
    // automatic authentication privately; the model still cannot inspect its
    // password/OTP form. A hidden template must not block ordinary reading.
    if ([...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code" i]')].some(node => !hidden(node))) return respond({ error: 'manual_control_active' });
    const lines = [], needle = query.toLocaleLowerCase();
    let visited = 0, characters = 0, scanLimited = false;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (++visited > 20_000 || characters >= 100_000) { scanLimited = true; break; }
      const parent = node.parentElement;
      if (!parent || privateText(parent) || hidden(parent)) continue;
      // Keep long rendered nodes pageable; cap only the total scan, not an
      // arbitrary per-node prefix that would silently lose an ad description.
      const remaining = 100_000 - characters;
      const rendered = clean(node.textContent, remaining + 1);
      if (rendered.length > remaining) scanLimited = true;
      const value = rendered.slice(0, remaining);
      if (!value) continue;
      characters += value.length + 1;
      lines.push(value);
    }
    // Adjacent rendered text nodes often contain the amount and its currency
    // separately from the matching heading. Keep two context lines each way;
    // literal filtering must not silently drop the price the user asked for.
    const selected = new Set();
    if (needle) for (let i = 0; i < lines.length; i++) if (lines[i].toLocaleLowerCase().includes(needle)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) selected.add(j);
    const all = (needle ? lines.filter((_, i) => selected.has(i)) : lines).join('\n'), text = all.slice(offset, offset + 6000);
    const controls = [];
    // Coordinates refer to this viewport, like the image API. Do not scroll or
    // focus controls to discover them, and omit obscured/disabled elements.
    for (const element of includeControls ? [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"]')].slice(0, 1200) : []) {
      if (controls.length >= 40) break;
      if (hidden(element) || element.disabled || ['hidden', 'password', 'file'].includes(element.type)) continue;
      const r = element.getBoundingClientRect(), x = Math.round(Math.max(0, r.left) + (Math.min(innerWidth, r.right) - Math.max(0, r.left)) / 2), y = Math.round(Math.max(0, r.top) + (Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / 2);
      if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== element && !element.contains(hit))) continue;
      // ARIA textboxes and plaintext-only editables are field values too.
      // Never use their innerText as a label or leak a saved message draft.
      const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable || element.getAttribute('role') === 'textbox';
      const label = clean(element.getAttribute('aria-label') || fieldLabel(element) || element.getAttribute('placeholder') || (!field && element.innerText) || element.getAttribute('title'), 120);
      const role = element.tagName === 'A' ? 'link' : ['INPUT', 'TEXTAREA'].includes(element.tagName) || element.isContentEditable || element.getAttribute('role') === 'textbox' ? 'textbox' : element.tagName === 'SELECT' ? 'select' : 'button';
      if (!label) continue;
      if (!controls.some(c => c.role === role && c.label === label && c.x === x && c.y === y)) controls.push({ role, label, x, y });
    }
    respond({ title: clean(document.title, 240), text, controls, nextOffset: offset + text.length < all.length ? offset + text.length : null, scanLimited });
  });
}

/** Closed rendered-text boundary for signed providers that explicitly opt in.
 * Revalidate the extension response outside the renderer, enforcing a closed
 * schema and byte budget. Site text is untrusted data, never instructions.
 */
export const TEXT_KIND = 'trelio.browser-text/v1';
const fail = () => { throw new Error('VISUAL_RESULT_INVALID'); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const string = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v);
export function validateTextResult(v) {
  if (!exact(v, ['kind', 'state', 'reason', 'sessionId', 'frameId', 'width', 'height', 'scroll', 'title', 'text', 'controls', 'nextOffset', 'scanLimited']) || v.kind !== TEXT_KIND || v.state !== 'ready' || v.reason !== 'none') fail();
  for (const key of ['sessionId', 'frameId']) if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v[key])) fail();
  for (const key of ['width', 'height']) if (!Number.isInteger(v[key]) || v[key] < 1 || v[key] > 8192) fail();
  if (!exact(v.scroll, ['up', 'down', 'left', 'right']) || Object.values(v.scroll).some(x => typeof x !== 'boolean')) fail();
  if (!string(v.title, 240) || !string(v.text, 6000) || typeof v.scanLimited !== 'boolean' || (v.nextOffset !== null && (!Number.isInteger(v.nextOffset) || v.nextOffset < 1 || v.nextOffset > 106_000))) fail();
  if (!Array.isArray(v.controls) || v.controls.length > 40) fail();
  for (const c of v.controls) if (!exact(c, ['role', 'label', 'x', 'y']) || !['link', 'button', 'textbox', 'select'].includes(c.role) || !string(c.label, 120) || !Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.x >= v.width || c.y < 0 || c.y >= v.height) fail();
  if (Buffer.byteLength(JSON.stringify(v)) > 40_000) fail();
  return v;
}
