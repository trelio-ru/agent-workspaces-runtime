/** Fixed isolated-world adapter, never a model-selected script or DOM reader.
 * A single armed, trusted coordinate click may route an anchor's destination
 * locally. No element text, attributes, tree or source is returned to the host
 * API/model. Routing before the browser's default action prevents Chromium's
 * new-tab activation instead of stealing focus and restoring it afterwards. */
export function visualLinkRouter() {
  let armed, cancelAttachment;
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.kind === 'cancel_attachment_click') { cancelAttachment?.(); return; }
    if (message?.kind === 'arm_attachment_click') {
      cancelAttachment?.();
      const nonce = message.nonce;
      if (typeof nonce !== 'string' || nonce.length !== 36) return;
      let timer;
      const listener = event => {
        if (event.source !== window || event.data?.nonce !== nonce) return;
        if (event.data.kind === 'trelio_attachment_armed') reply({ ready: true });
        if (event.data.kind === 'trelio_attachment_open') {
          const url = event.data.url; cancelAttachment();
          void chrome.runtime.sendMessage({ kind: 'route_attachment_open', nonce, url });
        }
      };
      cancelAttachment = () => {
        clearTimeout(timer); window.removeEventListener('message', listener);
        window.postMessage({ kind: 'trelio_attachment_cancel', nonce }, '*'); cancelAttachment = undefined;
      };
      window.addEventListener('message', listener);
      window.postMessage({ kind: 'trelio_attachment_arm', nonce, x: message.x, y: message.y }, '*');
      timer = setTimeout(() => { cancelAttachment?.(); }, 5000);
      return true; // Only the acknowledgement waits on a browser-local message.
    }
    if (message?.kind === 'resolve_attachment_link') {
      // Fixed coordinate-only preflight, not a selector or a synthetic page
      // click. This anchor preflight dispatches no page input; only the
      // separately armed button route can dispatch a reviewed file click.
      // Only the exact hit-tested
      // anchor's URL travels to the trusted worker, never to the model.
      const hit = document.elementFromPoint(message.x, message.y);
      const anchor = hit?.closest('a[href]');
      reply(anchor ? { url: anchor.href } : null);
      return;
    }
    if (message?.kind !== 'arm_link_click') return;
    armed = { x: message.x, y: message.y, until: Date.now() + 2000 };
  });
  document.addEventListener('click', event => {
    const pending = armed;
    if (!pending || !event.isTrusted || Date.now() > pending.until || Math.abs(event.clientX - pending.x) > 2 || Math.abs(event.clientY - pending.y) > 2) return;
    armed = undefined;
    // Only an anchor on this exact click path is inspected. The closed bridge
    // receives its navigation URL, never an arbitrary DOM query or page text.
    const anchor = event.composedPath().slice(0, 64).find(node => node?.nodeType === 1 && node.tagName === 'A');
    if (!anchor || anchor.target !== '_blank') return;
    event.preventDefault(); event.stopImmediatePropagation();
    void chrome.runtime.sendMessage({ kind: 'route_link_click', url: anchor.href, download: anchor.hasAttribute('download') });
  }, true);
}

/** Fixed MAIN-world popup router, installed only for signed attachment opt-in.
 * It reads no DOM, page source/state or response. During one armed trusted
 * coordinate click it routes window.open's destination to the isolated worker
 * instead of creating/activating a popup. All other calls keep native behavior.
 * Page messages remain untrusted candidates: the worker checks frame, nonce,
 * origin, MIME, size and bytes. No message can authorize sending or execution.
 */
export function visualAttachmentRouter() {
  let armed, previousOpen, routeOpen;
  const disarm = () => { armed = undefined; if (window.open === routeOpen) window.open = previousOpen; previousOpen = undefined; routeOpen = undefined; };
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || typeof data?.nonce !== 'string' || data.nonce.length !== 36) return;
    if (data.kind === 'trelio_attachment_cancel' && data.nonce === armed?.nonce) { disarm(); return; }
    if (data.kind !== 'trelio_attachment_arm' || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    // Leave window.open entirely untouched during page load/ordinary work.
    // Install only after an explicit file operation; restore the exact current
    // site value on success/cancel. Never replace a nonwritable page property.
    disarm();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'open');
    if (!descriptor?.writable || typeof descriptor.value !== 'function') return;
    const original = descriptor.value, pending = { nonce: data.nonce, x: data.x, y: data.y, until: Date.now() + 5000, trusted: false };
    // Retain the exact original in this invocation's closure: if page code
    // caches the temporary wrapper, a later call still has native behavior and
    // cannot capture a future operation's URL or reuse its arm.
    previousOpen = original;
    routeOpen = function(...args) {
      if (armed !== pending || !pending.trusted || Date.now() >= pending.until) { if (armed === pending) disarm(); return Reflect.apply(original, window, args); }
      disarm();
      const url = typeof args[0] === 'string' && args[0].length <= 4096 ? args[0] : '';
      window.postMessage({ kind: 'trelio_attachment_open', nonce: pending.nonce, url }, '*');
      return null;
    };
    window.open = routeOpen; armed = pending;
    setTimeout(() => { if (armed?.nonce === data.nonce) disarm(); }, 5000);
    window.postMessage({ kind: 'trelio_attachment_armed', nonce: data.nonce }, '*');
  });
  document.addEventListener('click', event => {
    if (armed && event.isTrusted && Date.now() < armed.until && Math.abs(event.clientX - armed.x) <= 2 && Math.abs(event.clientY - armed.y) <= 2) armed.trusted = true;
  }, true);
}
