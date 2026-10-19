/** Fixed isolated-world adapter, never a model-selected script or DOM reader.
 * A single armed, trusted coordinate click may route an anchor's destination
 * locally. No element text, attributes, tree or source is returned to the host
 * API/model. Routing before the browser's default action prevents Chromium's
 * new-tab activation instead of stealing focus and restoring it afterwards. */
export function visualLinkRouter() {
  let armed;
  chrome.runtime.onMessage.addListener(message => {
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
