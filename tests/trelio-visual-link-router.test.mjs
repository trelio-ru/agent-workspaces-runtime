import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualLinkRouter, visualAttachmentRouter, visualAudioRouter, visualAudioReceiver } from '../host-runtime/scripts/trelio-visual-link-router.mjs';

test('audio routing binds one trusted coordinate click, preserves native methods/mute state and rejects multiple players', async () => {
  let message, click; const messages = [];
  class Media {
    constructor(url) { this.url = url; this.mute = false; this.plays = 0; this.pauses = 0; }
    get src() { return this.url; } get currentSrc() { return this.url; }
    get muted() { return this.mute; } set muted(value) { this.mute = value; }
    play() { this.plays++; return Promise.resolve(); } pause() { this.pauses++; }
  }
  class Audio extends Media {}
  const original = Media.prototype.play;
  const window = { addEventListener(_kind, fn) { message = fn; }, postMessage(value) { messages.push(value); } };
  vm.runInNewContext(`(${visualAudioRouter.toString()})();`, { window, document: { addEventListener(_kind, fn) { click = fn; } }, HTMLMediaElement: Media, HTMLAudioElement: Audio, Date, setTimeout, clearTimeout });
  const nonce = '00000000-0000-4000-8000-000000000001';
  const arm = () => message({ source: window, data: { kind: 'trelio_audio_arm', nonce, x: 10, y: 20 } });
  const event = patch => ({ isTrusted: true, clientX: 10, clientY: 20, ...patch });
  const ordinary = new Audio('https://example.test/ordinary');
  await ordinary.play(); assert.equal(ordinary.mute, false); assert.equal(messages.length, 0);
  arm(); const cached = Media.prototype.play;
  click(event({ isTrusted: false })); await ordinary.play();
  click(event({ clientX: 30 })); await ordinary.play();
  assert.equal(messages.filter(value => value.kind === 'trelio_audio_source').length, 0);
  const chosen = new Audio('blob:https://example.test/synthetic');
  chosen.muted = true; click(event()); await chosen.play(); await new Promise(setImmediate);
  assert.equal(messages.at(-1).url, chosen.url); assert.equal(chosen.pauses, 1); assert.equal(chosen.muted, true);
  assert.equal(Media.prototype.play, original);
  await Reflect.apply(cached, ordinary, []); assert.equal(ordinary.muted, false, 'a cached wrapper cannot consume another arm');
  arm(); click(event());
  const first = new Audio('https://example.test/one'), second = new Audio('https://example.test/two');
  await Promise.all([first.play(), second.play()]); await new Promise(setImmediate);
  assert.equal(messages.at(-1).url, '', 'an ambiguous click never chooses the first player silently');
  assert.equal(Media.prototype.play, original); assert.equal(first.muted, false);
  arm(); message({ source: window, data: { kind: 'trelio_audio_cancel', nonce } });
  assert.equal(Media.prototype.play, original);
});

test('isolated audio reads only same-origin blobs and never fetches an HTTPS or foreign source', async () => {
  let listener, requests = 0, audio;
  vm.runInNewContext(`(${visualAudioReceiver.toString()})();`, {
    chrome: { runtime: { id: 'fixture', onMessage: { addListener(fn) { listener = fn; } } } },
    window: {}, document: { elementFromPoint() { return { closest(selector) { assert.equal(selector, 'audio'); return audio; } }; } }, location: { origin: 'https://example.test', protocol: 'https:' }, URL, Date, AbortController, setTimeout, clearTimeout,
    async fetch(url) { requests++; assert.equal(url, 'blob:https://example.test/synthetic'); return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/ogg' } }); },
    Uint8Array, Response, btoa,
  });
  const native = () => new Promise(resolve => listener({ kind: 'resolve_audio_link', x: 10, y: 20 }, { id: 'fixture' }, resolve));
  audio = { src: 'https://example.test/new', currentSrc: 'https://example.test/previous' };
  assert.equal(await native(), null, 'a reused player cannot return the previous voice original');
  audio.currentSrc = audio.src; assert.equal((await native()).url, audio.src);
  assert.equal(requests, 0);
  const read = url => new Promise(resolve => listener({ kind: 'read_audio_blob', url, until: Date.now() + 1000 }, { id: 'fixture' }, resolve));
  assert.equal((await read('https://example.test/audio')).url, 'https://example.test/audio');
  assert.equal(requests, 0, 'network audio belongs to the guarded browser stream, never isolated fetch');
  assert.equal((await read('blob:https://foreign.test/synthetic')).reason, 'attachment_unsupported');
  assert.equal(requests, 0);
  const result = await read('blob:https://example.test/synthetic');
  assert.equal(result.file.dataBase64, 'AQID'); assert.equal(requests, 1);
  assert.equal(Object.keys(result.file).sort().join(), 'dataBase64,mimeType');
});

test('link routing is one-shot, trusted and bound to the armed coordinates', () => {
  let listener, arm; const messages = [];
  vm.runInNewContext(`(${visualLinkRouter.toString()})();`, {
    chrome: { runtime: { onMessage: { addListener(value) { arm = value; } }, sendMessage(value) { messages.push(value); } } },
    document: { addEventListener(type, value, capture) { assert.equal(type, 'click'); assert.equal(capture, true); listener = value; } }, Date,
  });
  const anchor = { nodeType: 1, tagName: 'A', target: '_blank', href: 'https://example.test/detail', hasAttribute: () => false };
  let cancelled = 0;
  const event = patch => ({ isTrusted: true, clientX: 40, clientY: 70, composedPath: () => [anchor], preventDefault() { cancelled++; }, stopImmediatePropagation() {}, ...patch });
  listener(event()); assert.equal(cancelled, 0, 'ordinary unarmed browsing is unaffected');
  arm({ kind: 'arm_link_click', x: 40, y: 70 });
  listener(event({ isTrusted: false })); listener(event({ clientX: 200 }));
  assert.equal(messages.length, 0, 'page-created clicks and another coordinate cannot route');
  listener(event()); assert.equal(cancelled, 1); assert.equal(messages.length, 1);
  assert.deepEqual(Object.keys(messages[0]).sort(), ['download', 'kind', 'url']);
  assert.equal(messages[0].url, anchor.href);
  listener(event()); assert.equal(messages.length, 1, 'an armed click is consumed once');
});

test('attachment preflight returns only the exact coordinate anchor and dispatches no click', () => {
  let listener; const replies = [];
  vm.runInNewContext(`(${visualLinkRouter.toString()})();`, {
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    document: { addEventListener() {}, elementFromPoint(x, y) { assert.equal(x, 12); assert.equal(y, 34); return { closest(selector) { assert.equal(selector, 'a[href]'); return { href: 'https://example.test/incoming' }; } }; } }, Date,
  });
  listener({kind:'resolve_attachment_link',x:12,y:34}, {}, value => replies.push(value));
  assert.equal(replies[0].url, 'https://example.test/incoming'); assert.deepEqual(Object.keys(replies[0]), ['url']);
});

test('popup router changes window.open only during one explicit trusted file click and restores it', () => {
  const messages = [], timers = []; let message, click, calls = 0, now = 1000;
  const nativeOpen = () => { calls++; return 'native'; }, window = { open: nativeOpen, addEventListener(_type, fn) { message = fn; }, postMessage(value) { messages.push(value); } };
  vm.runInNewContext(`(${visualAttachmentRouter.toString()})();`, { window, document: { addEventListener(_type, fn) { click = fn; } }, Date: class extends Date { static now() { return now; } }, setTimeout(fn) { timers.push(fn); } });
  assert.equal(window.open, nativeOpen, 'ordinary page startup is untouched');
  const nonce = '00000000-0000-4000-8000-000000000001';
  const arm = () => message({ source: window, data: { kind:'trelio_attachment_arm',nonce,x:10,y:20 } });
  arm(); click({isTrusted:false,clientX:10,clientY:20}); assert.equal(window.open('https://example.test/untrusted'), 'native');
  arm(); const cached = window.open; click({isTrusted:true,clientX:10,clientY:20}); assert.equal(window.open('https://example.test/incoming'), null);
  assert.equal(calls, 1); assert.equal(window.open, nativeOpen);
  assert.equal(messages.at(-1).kind, 'trelio_attachment_open'); assert.equal(messages.at(-1).url, 'https://example.test/incoming');
  assert.equal(cached('https://example.test/later'), 'native'); assert.equal(calls,2, 'cached temporary wrapper keeps the exact native function after disarm');
  arm(); message({source:window,data:{kind:'trelio_attachment_cancel',nonce}}); assert.equal(window.open,nativeOpen);
  arm(); now += 5001; timers.at(-1)(); assert.equal(window.open,nativeOpen, 'expiry restores the same original');
});
