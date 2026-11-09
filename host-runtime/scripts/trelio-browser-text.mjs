import { createUtf16TextPolicy } from "./trelio-context-search-matching.mjs";
/** Fixed isolated-world reader for a signed host opt-in, never page JS.
 * It reads rendered text nodes and viewport control labels, without reading
 * input values, attributes inventories, HTML, storage or network responses.
 * Requests contain a literal text filter and offset, never a selector/script.
 */
export function installTextObserver(linkUrl, includeLinkTargets = false, textPolicy = createUtf16TextPolicy()) {
  const { sliceUtf16CodePoints, readUtf16TextChunk } = textPolicy;
  const clean = (value, limit) => sliceUtf16CodePoints(String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').replace(/\s+/gu, ' ').trim(), 0, limit);
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
      const value = sliceUtf16CodePoints(rendered, 0, remaining);
      if (!value) continue;
      characters += value.length + 1;
      lines.push(value);
    }
    // Adjacent rendered text nodes often contain the amount and its currency
    // separately from the matching heading. Keep two context lines each way;
    // literal filtering must not silently drop the price the user asked for.
    const selected = new Set();
    if (needle) for (let i = 0; i < lines.length; i++) if (lines[i].toLocaleLowerCase().includes(needle)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) selected.add(j);
    const all = (needle ? lines.filter((_, i) => selected.has(i)) : lines).join('\n');
    let page;
    try { page = readUtf16TextChunk(all, offset, 6000); }
    catch { return respond({ error: 'invalid_input' }); }
    const { text, nextOffset } = page;
    const controls = [];
    let linkTargetBytes = 0, linkTargetsLimited = false;
    // Coordinates refer to this viewport, like the image API. Do not scroll or
    // focus controls to discover them, and omit obscured/disabled elements.
    // Read-only document viewers expose File/Download as ARIA menu items,
    // rather than buttons. Project only their visible labels/coordinates in
    // the existing button shape; this does not grant a provider permission to
    // click edits, sharing or any other menu action. Visible menu controls
    // precede toolbar buttons within the SAME scan/output bounds: a viewer's
    // long toolbar must not hide an already-open Download menu past item 40.
    const candidates = includeControls ? [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="menuitem"]')].slice(0, 1200) : [];
    candidates.sort((a, b) => Number(b.getAttribute('role') === 'menuitem') - Number(a.getAttribute('role') === 'menuitem'));
    for (const element of candidates) {
      if (controls.length >= 40) break;
      if (hidden(element) || element.disabled || element.getAttribute('aria-disabled') === 'true' || ['hidden', 'password', 'file'].includes(element.type)) continue;
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
      if (controls.some(c => c.role === role && c.label === label && c.x === x && c.y === y)) continue;
      const control = { role, label, x, y };
      // A rendered link is a source reference, not a recipe for operating its
      // destination. Expose only this already-visible anchor's ordinary URL
      // under the signed external-navigation opt-in. Never inspect field or
      // draft descendants, follow the link, resolve a redirect or read headers.
      // The SAME reviewed URL function is injected with this fixed observer
      // and reused by the outer validator; page/model input cannot replace it.
      if (includeLinkTargets && role === 'link' && !privateText(element)) {
        const url = linkUrl(element.href);
        if (url) {
          const bytes = new TextEncoder().encode(JSON.stringify({ url })).length;
          // Keep the existing complete-result bound even on link-heavy pages.
          // Omit an entire target rather than fabricate a shortened URL; the
          // explicit flag distinguishes resource omission from no such link.
          if (linkTargetBytes + bytes <= 8192) { control.url = url; linkTargetBytes += bytes; }
          else linkTargetsLimited = true;
        }
      }
      controls.push(control);
    }
    respond({ title: clean(document.title, 240), text, controls, nextOffset, scanLimited,
      ...(linkTargetsLimited ? { linkTargetsLimited: true } : {}) });
  });
}

/** Read-only handoff of a visible source link, shared by the isolated reader
 * and host/MCP validation. This self-contained function is materialized from
 * signed host source, never evaluated from a provider/model/page string.
 * Refuse credential/callback-bearing references without rewriting their URL;
 * ordinary private browser navigation retains its independent policy. No
 * domain or foreign-service UI behavior belongs in this generic primitive. */
export function readableLinkUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  // These are authentication/credential parameters, not document references.
  // Inspect keys only; never copy a refused value into diagnostics or strip a
  // token and pretend that the resulting different URL is the original link.
  const sensitiveKey = /^(?:code|state|nonce|token|accesstoken|idtoken|refreshtoken|clientsecret|password|passwd|otp|totp|authorization|authcode|sessionid|sessiontoken|ticket|csrf|csrftoken|xsrf|xsrftoken|samlrequest|samlresponse|relaystate|returnurl|returnto|redirect|redirecturl|redirecturi)$/iu;
  const fragment = url.hash.slice(1);
  for (const params of [url.searchParams, new URLSearchParams(fragment),
    new URLSearchParams(fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : '')]) {
    for (const key of params.keys()) if (sensitiveKey.test(key.replace(/[-_]/gu, ''))) return null;
  }
  return url.href;
}

/** Closed rendered-text boundary for signed providers that explicitly opt in.
 * Revalidate the extension response outside the renderer, enforcing a closed
 * schema and byte budget. Site text is untrusted data, never instructions.
 */
export const TEXT_KIND = 'trelio.browser-text/v1';
const fail = () => { throw new Error('VISUAL_RESULT_INVALID'); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const string = (v, max) => typeof v === 'string' && v.length <= max && v.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v);
export function validateTextResult(v) {
  if (!exact(v, ['kind', 'state', 'reason', 'sessionId', 'frameId', 'width', 'height', 'scroll', 'title', 'text', 'controls', 'nextOffset', 'scanLimited',
    ...(Object.hasOwn(v || {}, 'linkTargetsLimited') ? ['linkTargetsLimited'] : [])]) || v.kind !== TEXT_KIND || v.state !== 'ready' || v.reason !== 'none') fail();
  if (Object.hasOwn(v, 'linkTargetsLimited') && v.linkTargetsLimited !== true) fail();
  for (const key of ['sessionId', 'frameId']) if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v[key])) fail();
  for (const key of ['width', 'height']) if (!Number.isInteger(v[key]) || v[key] < 1 || v[key] > 8192) fail();
  if (!exact(v.scroll, ['up', 'down', 'left', 'right']) || Object.values(v.scroll).some(x => typeof x !== 'boolean')) fail();
  if (!string(v.title, 240) || !string(v.text, 6000) || typeof v.scanLimited !== 'boolean' || (v.nextOffset !== null && (!Number.isInteger(v.nextOffset) || v.nextOffset < 1 || v.nextOffset > 106_000))) fail();
  if (!Array.isArray(v.controls) || v.controls.length > 40) fail();
  let linkTargetBytes = 0;
  for (const c of v.controls) {
    const hasUrl = Object.hasOwn(c || {}, 'url');
    if (!exact(c, ['role', 'label', 'x', 'y', ...(hasUrl ? ['url'] : [])]) || !['link', 'button', 'textbox', 'select'].includes(c.role) || !string(c.label, 120) || !Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.x >= v.width || c.y < 0 || c.y >= v.height) fail();
    if (hasUrl) {
      if (c.role !== 'link' || typeof c.url !== 'string' || readableLinkUrl(c.url) !== c.url) fail();
      linkTargetBytes += Buffer.byteLength(JSON.stringify({ url: c.url }));
      if (linkTargetBytes > 8192) fail();
    }
  }
  if (Buffer.byteLength(JSON.stringify(v)) > 40_000) fail();
  return v;
}

/** Only fixed reviewed functions and the signed boolean enter the isolated
 * script. No page code, selector, caller source or text content is evaluated.
 */
export const buildTextObserverScript = (includeLinkTargets = false) =>
  `(${installTextObserver.toString()})(${readableLinkUrl.toString()},${includeLinkTargets === true},(${createUtf16TextPolicy.toString()})());`;
