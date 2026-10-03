import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDocumentHttpObserver, safeHttpFailure } from '../host-runtime/scripts/trelio-browser-session.mjs';
const fixture = () => {
  const context = new EventEmitter();
  const page = { url: () => page.current, isClosed: () => false, mainFrame: () => frame, current: 'https://service.test/' };
  const frame = { page: () => page };
  const observer = createDocumentHttpObserver(context, { isAllowedUrl: url => new URL(url).origin === 'https://service.test', ignoreStatus: status => status === 401 });
  const request = (url, overrides = {}) => ({ url: () => url, isNavigationRequest: () => true, resourceType: () => 'document', frame: () => frame, ...overrides });
  const response = (req, status) => context.emit('response', { request: () => req, status: () => status, url: req.url });
  const navigate = (url, status) => { const req = request(url); context.emit('request', req); response(req, status); page.current = url; return req; };
  return { context, page, observer, request, response, navigate };
};
test('HTTP evidence returns only status and approved origin, never OAuth URL or response content', () => {
  const f = fixture(); f.navigate('https://service.test/callback?code=SECRET&state=PRIVATE', 503);
  assert.deepEqual(f.observer.failure(f.page), { httpStatus: 503, origin: 'https://service.test' });
  f.page.current += '#chat'; assert.equal(f.observer.failure(f.page).httpStatus, 503);
  const result = f.observer.failure(f.page); result.httpStatus = 404;
  assert.equal(f.observer.failure(f.page).httpStatus, 503);
});
test('new same-URL navigation clears stale proof and rejects late previous responses', () => {
  const f = fixture(); const old = f.navigate(f.page.current, 503);
  const fresh = f.request(f.page.current); f.context.emit('request', fresh);
  assert.equal(f.observer.failure(f.page), null); f.response(old, 502);
  assert.equal(f.observer.failure(f.page), null); f.response(fresh, 200);
  assert.equal(f.observer.failure(f.page), null);
});
test('asset, XHR, subframe and sibling page errors cannot overwrite current document', () => {
  const f = fixture(); f.navigate(f.page.current, 200);
  for (const overrides of [{ isNavigationRequest: () => false, resourceType: () => 'xhr' }, { resourceType: () => 'image' }, { frame: () => ({ page: () => f.page }) }]) {
    const req = f.request(f.page.current, overrides); f.context.emit('request', req); f.response(req, 503);
    assert.equal(f.observer.failure(f.page), null);
  }
  const sibling = { mainFrame: () => frame, url: () => f.page.current, isClosed: () => false }; const frame = { page: () => sibling };
  const req = f.request(f.page.current, { frame: () => frame }); f.context.emit('request', req); f.response(req, 503);
  assert.equal(f.observer.failure(f.page), null); assert.equal(f.observer.failure(sibling).httpStatus, 503);
});
test('provider exceptions, unexpected origins, transport failures and different document are not HTTP proof', () => {
  const f = fixture(); f.navigate(f.page.current, 401); assert.equal(f.observer.failure(f.page), null);
  f.navigate('https://other.test/', 503); assert.equal(f.observer.failure(f.page), null);
  f.navigate('https://service.test/one', 503); f.page.current = 'https://service.test/two'; assert.equal(f.observer.failure(f.page), null);
  const req = f.request(f.page.current); f.context.emit('request', req); f.context.emit('requestfailed', req); assert.equal(f.observer.failure(f.page), null);
  f.navigate(f.page.current, 503); f.page.isClosed = () => true; assert.equal(f.observer.failure(f.page), null);
  f.observer.dispose(); assert.equal(f.context.listenerCount('response'), 0); assert.equal(f.observer.failure(f.page), null);
});
test('safe metadata validates numeric status and canonical HTTPS origin without echoing unknown fields', () => {
  for (const httpStatus of [true, '503', 399, 600, NaN, 503.5]) assert.deepEqual(safeHttpFailure({ httpStatus, origin: 'https://service.test' }), {});
  for (const origin of ['http://service.test', 'https://service.test/path', 'https://u:p@service.test', 'https://service.test:8443', 'https://service.test?secret=x']) assert.deepEqual(safeHttpFailure({ httpStatus: 503, origin }), {});
  assert.deepEqual(safeHttpFailure({ httpStatus: 429, origin: 'https://service.test', body: 'secret', headers: {} }), { httpStatus: 429, origin: 'https://service.test' });
});
