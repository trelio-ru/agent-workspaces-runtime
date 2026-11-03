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

/** Signed audio-only isolated adapter. HTTPS sources go to the SAME guarded
 * browser download stream. Only a same-document blob is read here: it has no
 * HTTP fallback and cannot read a page/API response or an arbitrary model URL.
 * Source URLs and binary remain in the private extension channel, never MCP.
 */
export function visualAudioReceiver() {
  let pending;
  // A reused player may still expose the PREVIOUS loaded currentSrc while
  // src already targets another message. Never return that earlier voice as
  // the selected original; defer to the one-play route or refuse ambiguity.
  const source = audio => audio && (!audio.currentSrc || !audio.src || audio.currentSrc === audio.src) && (audio.currentSrc || audio.src);
  const stop = () => {
    if (!pending) return;
    const previous = pending; pending = undefined;
    clearTimeout(previous.timer); previous.abort.abort();
    window.removeEventListener('message', previous.listener);
    window.postMessage({ kind: 'trelio_audio_cancel', nonce: previous.nonce }, '*');
  };
  async function resolve(url, until, signal) {
    if (typeof url !== 'string' || !url || url.length > 4096 || Date.now() >= until) throw Error('attachment_link_required');
    const parsed = new URL(url);
    if (parsed.protocol !== 'blob:') return { url }; // Worker rechecks signed origins.
    if (parsed.origin !== location.origin || !['https:', 'http:'].includes(location.protocol)) throw Error('attachment_unsupported');
    const response = await fetch(parsed.href, { signal });
    const mimeType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!response.ok || !/^(?:audio\/(?:wav|x-wav|wave|mpeg|mp3|ogg|opus|mp4|x-m4a|aac|aacp|flac|x-flac)|application\/(?:ogg|octet-stream))$/u.test(mimeType)) throw Error('attachment_unsupported');
    const reader = response.body?.getReader();
    if (!reader) throw Error('attachment_unsupported');
    const chunks = []; let total = 0;
    try {
      for (;;) {
        if (signal.aborted || Date.now() >= until) throw Error('operation_failed');
        const item = await reader.read();
        if (item.done) break;
        if ((total += item.value.length) > 20 * 1024 * 1024) throw Error('attachment_too_large');
        chunks.push(item.value);
      }
      if (!total || signal.aborted || Date.now() >= until) throw Error('attachment_unsupported');
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; chunk.fill(0); }
      let dataBase64 = '';
      try { for (let i = 0; i < total; i += 49152) dataBase64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 49152))); }
      finally { bytes.fill(0); }
      return { file: { mimeType, dataBase64 } };
    } finally { for (const chunk of chunks) chunk.fill(0); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.kind === 'resolve_audio_link') {
      const audio = document.elementFromPoint(message.x, message.y)?.closest('audio');
      reply(source(audio) ? { url: source(audio) } : null); return;
    }
    if (message?.kind === 'cancel_audio_click') { stop(); return; }
    if (message?.kind === 'read_audio_blob') {
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), Math.max(1, message.until - Date.now()));
      resolve(message.url, message.until, abort.signal).then(reply, () => reply({ reason: 'attachment_unsupported' })).finally(() => clearTimeout(timer));
      return true;
    }
    if (message?.kind !== 'arm_audio_click' || typeof message.nonce !== 'string' || message.nonce.length !== 36 || !Number.isSafeInteger(message.until) || message.until <= Date.now()) return;
    stop();
    const current = { nonce: message.nonce, abort: new AbortController(), claimed: false };
    current.listener = event => {
      if (pending !== current || event.source !== window || event.data?.nonce !== current.nonce) return;
      if (event.data.kind === 'trelio_audio_armed') { reply({ ready: true }); return; }
      if (event.data.kind !== 'trelio_audio_source' || current.claimed) return;
      current.claimed = true;
      clearTimeout(current.timer);
      current.timer = setTimeout(() => { if (pending === current) { void chrome.runtime.sendMessage({ kind: 'route_audio_source', nonce: current.nonce, reason: 'attachment_link_required' }); stop(); } }, Math.max(1, message.until - Date.now()));
      resolve(event.data.url, message.until, current.abort.signal).then(
        result => { if (pending === current) void chrome.runtime.sendMessage({ kind: 'route_audio_source', nonce: current.nonce, ...result }); },
        error => { if (pending === current) void chrome.runtime.sendMessage({ kind: 'route_audio_source', nonce: current.nonce, reason: ['attachment_too_large', 'attachment_unsupported'].includes(error.message) ? error.message : 'attachment_link_required' }); },
      ).finally(() => { if (pending === current) stop(); });
    };
    pending = current;
    window.addEventListener('message', current.listener);
    // The full file transfer shares the original 30s/lease bound. A player
    // must identify its source within five seconds, never a future click.
    current.timer = setTimeout(() => {
      if (pending === current) { void chrome.runtime.sendMessage({ kind: 'route_audio_source', nonce: current.nonce, reason: 'attachment_link_required' }); stop(); }
    }, Math.max(1, Math.min(5000, message.until - Date.now())));
    window.postMessage({ kind: 'trelio_audio_arm', nonce: current.nonce, x: message.x, y: message.y }, '*');
    return true;
  });
}

/** One reviewed player click may expose its native HTMLAudioElement source,
 * including a detached new Audio(blobURL). No selectors, site variables,
 * scripts, network interception, microphone or system/tab recording exist.
 * The temporary play wrapper is restored on every exit. Ordinary playback is
 * untouched; this explicit download briefly mutes/pauses ONLY the selected
 * player, then restores its prior mute value without replaying the click.
 */
export function visualAudioRouter() {
  const prototype = HTMLMediaElement.prototype;
  const nativePlay = Object.getOwnPropertyDescriptor(prototype, 'play');
  const nativePause = prototype.pause;
  const muted = Object.getOwnPropertyDescriptor(prototype, 'muted');
  const src = Object.getOwnPropertyDescriptor(prototype, 'src').get;
  const currentSrc = Object.getOwnPropertyDescriptor(prototype, 'currentSrc').get;
  let pending;
  const clean = current => {
    if (pending !== current) return;
    pending = undefined; clearTimeout(current.timer);
    if (prototype.play === current.wrapper) Object.defineProperty(prototype, 'play', nativePlay);
    if (current.audio) {
      Reflect.apply(nativePause, current.audio, []);
      Reflect.apply(muted.set, current.audio, [current.wasMuted]);
    }
  };
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || typeof data?.nonce !== 'string' || data.nonce.length !== 36) return;
    if (data.kind === 'trelio_audio_cancel') { if (pending?.nonce === data.nonce) clean(pending); return; }
    if (data.kind !== 'trelio_audio_arm' || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    if (pending) clean(pending);
    // Never overwrite a site's replacement or a nonconfigurable property.
    // A cached old wrapper keeps its own native method and cannot consume a
    // later operation. The page is an untrusted source, never authority.
    if (prototype.play !== nativePlay.value || nativePlay.configurable !== true) return;
    const current = { nonce: data.nonce, x: data.x, y: data.y, until: Date.now() + 5000, trusted: false };
    current.wrapper = function(...args) {
      if (pending !== current || !current.trusted || Date.now() >= current.until || !(this instanceof HTMLAudioElement)) return Reflect.apply(nativePlay.value, this, args);
      if (current.audio) {
        if (current.audio !== this) { clean(current); window.postMessage({ kind: 'trelio_audio_source', nonce: current.nonce, url: '' }, '*'); }
        return Reflect.apply(nativePlay.value, this, args);
      }
      current.audio = this; current.wasMuted = Reflect.apply(muted.get, this, []);
      Reflect.apply(muted.set, this, [true]);
      let result;
      try { result = Reflect.apply(nativePlay.value, this, args); }
      catch (error) { clean(current); throw error; }
      Promise.resolve(result).then(() => {
        if (pending !== current || Date.now() >= current.until) return;
        const url = Reflect.apply(currentSrc, this, []) || Reflect.apply(src, this, []);
        clean(current);
        window.postMessage({ kind: 'trelio_audio_source', nonce: current.nonce, url }, '*');
      }, () => { clean(current); });
      return result;
    };
    pending = current;
    Object.defineProperty(prototype, 'play', { ...nativePlay, value: current.wrapper });
    current.timer = setTimeout(() => clean(current), 5000);
    window.postMessage({ kind: 'trelio_audio_armed', nonce: current.nonce }, '*');
  });
  document.addEventListener('click', event => {
    if (pending && event.isTrusted && Date.now() < pending.until && Math.abs(event.clientX - pending.x) <= 2 && Math.abs(event.clientY - pending.y) <= 2) pending.trusted = true;
  }, true);
}
