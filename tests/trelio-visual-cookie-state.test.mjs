import test from 'node:test';
import assert from 'node:assert/strict';
import { visualCookieState } from '../host-runtime/scripts/trelio-visual-cookie-state.mjs';

const config = { origins: ['https://www.example.test'], domains: ['example.test'] };
const state = visualCookieState(config);
const cookie = { name: 'fixture_session', value: 'SYNTHETIC_AUTH', domain: '.example.test', path: '/', hostOnly: false, httpOnly: true, secure: true, sameSite: 'strict' };

test('private cookie state stays inside signed scope and excludes transport-only hosts, persistent and incognito cookies', () => {
  assert.deepEqual(state.fromChrome({ ...cookie, session: true, storeId: '0' }), cookie);
  for (const change of [{ session: false }, { storeId: '1' }, { domain: '127.0.0.1' }, { domain: '.test' }, { domain: 'example.test.evil.test' }, { domain: 'a..example.test' }]) assert.equal(state.fromChrome({ ...cookie, session: true, storeId: '0', ...change }), null);
  const exact = visualCookieState({ origins: config.origins, domains: [] });
  assert.equal(exact.fromChrome({ ...cookie, session: true }), null, 'an exact hostname never implicitly grants a parent domain');
  assert.equal(exact.fromChrome({ ...cookie, domain: 'www.example.test', hostOnly: true, session: true }).domain, 'www.example.test');
});

test('Cookie API restoration preserves host-only, HttpOnly, SameSite and CHIPS identity without adding expiry or navigating', () => {
  const partitionKey = { topLevelSite: 'https://other.test', hasCrossSiteAncestor: true };
  const value = { ...cookie, domain: 'www.example.test', hostOnly: true, path: '/account', partitionKey };
  const details = state.forChrome(value);
  assert.deepEqual(details, { url: 'https://www.example.test/account', name: cookie.name, value: cookie.value, path: '/account', httpOnly: true, secure: true, sameSite: 'strict', partitionKey });
  assert.equal(details.domain, undefined); assert.equal(details.expirationDate, undefined);
  assert.equal(state.key(value), state.key({ ...value, partitionKey: { hasCrossSiteAncestor: true, topLevelSite: 'https://other.test' } }));
  assert.notEqual(state.key(value), state.key({ ...value, partitionKey: { ...partitionKey, hasCrossSiteAncestor: false } }));
});

test('saved auth rejects extra fields, ambiguous duplicates, foreign domains and excessive data before Cookie API writes', () => {
  for (const bad of [{ ...cookie, script: 'SYNTHETIC_NOT_EXECUTED' }, { ...cookie, domain: '.evil.test' }, { ...cookie, path: '../outside' }, { ...cookie, partitionKey: { topLevelSite: 'file:///' } }]) assert.throws(() => state.validate([bad]), { code: 'VISUAL_STORAGE_CORRUPT' });
  assert.throws(() => state.validate([cookie, { ...cookie }]), { code: 'VISUAL_STORAGE_CORRUPT' });
  assert.throws(() => state.validate(Array.from({ length: 1025 }, (_, i) => ({ ...cookie, name: String(i) }))), { code: 'VISUAL_STORAGE_CORRUPT' });
  assert.throws(() => state.validate(Array.from({ length: 200 }, (_, i) => ({ ...cookie, name: String(i), value: 'x'.repeat(8192) }))), { code: 'VISUAL_STORAGE_CORRUPT' });
  assert.deepEqual(state.validate([]), [], 'an explicit empty jar is a valid logout snapshot');
});
