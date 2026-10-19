import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualLinkRouter } from '../host-runtime/scripts/trelio-visual-link-router.mjs';

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
