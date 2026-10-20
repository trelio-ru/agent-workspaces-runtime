/** Fixed isolated-world reader for a maintainer experiment, never page JS.
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
  const fieldLabel = element => {
    const label = element.labels?.[0];
    if (!label) return '';
    // A wrapping label may contain the textarea itself. textContent on that
    // label would reveal its initial value, even without reading .value.
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    let text = '', visited = 0;
    for (let node; (node = walker.nextNode()) && ++visited <= 64 && text.length < 160;) {
      const parent = node.parentElement;
      if (!parent || parent.closest('textarea,select,option,script,style,[contenteditable="true"]') || hidden(parent)) continue;
      text += ' ' + node.textContent;
    }
    return clean(text, 160);
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.kind !== 'experimental_read_text') return;
    const { query = '', offset = 0, includeControls = true } = message;
    if (typeof query !== 'string' || query.length > 120 || typeof includeControls !== 'boolean' || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return respond({ error: 'invalid_input' });
    // Authentication must remain a human step even outside the host's manual
    // phase. Omit every input value; refuse the whole observation if a rendered
    // password/OTP control is present. A hidden template must not block reading.
    if ([...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code" i]')].some(node => !hidden(node))) return respond({ error: 'manual_control_active' });
    const lines = [], needle = query.toLocaleLowerCase();
    let visited = 0, characters = 0, scanLimited = false;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (++visited > 20_000 || characters >= 100_000) { scanLimited = true; break; }
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,template,textarea,select,option,[contenteditable="true"]') || hidden(parent)) continue;
      const rendered = clean(node.textContent, 100_001);
      if (rendered.length > 2000) scanLimited = true;
      const value = rendered.slice(0, 2000);
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
      const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
      const label = clean(element.getAttribute('aria-label') || fieldLabel(element) || element.getAttribute('placeholder') || (!field && element.innerText) || element.getAttribute('title'), 160);
      const role = element.tagName === 'A' ? 'link' : ['INPUT', 'TEXTAREA'].includes(element.tagName) ? 'textbox' : element.tagName === 'SELECT' ? 'select' : 'button';
      if (!label) continue;
      if (!controls.some(c => c.role === role && c.label === label && c.x === x && c.y === y)) controls.push({ role, label, x, y });
    }
    respond({ title: clean(document.title, 240), text, controls, nextOffset: offset + text.length < all.length ? offset + text.length : null, scanLimited });
  });
}
