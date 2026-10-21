import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualLinkRouter, visualAttachmentRouter } from '../host-runtime/scripts/trelio-visual-link-router.mjs';

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
  arm(); click({isTrusted:true,clientX:10,clientY:20}); assert.equal(window.open('https://example.test/incoming'), null);
  assert.equal(calls, 1); assert.equal(window.open, nativeOpen);
  assert.equal(messages.at(-1).kind, 'trelio_attachment_open'); assert.equal(messages.at(-1).url, 'https://example.test/incoming');
  arm(); message({source:window,data:{kind:'trelio_attachment_cancel',nonce}}); assert.equal(window.open,nativeOpen);
  arm(); now += 5001; timers.at(-1)(); assert.equal(window.open,nativeOpen, 'expiry restores the same original');
});
