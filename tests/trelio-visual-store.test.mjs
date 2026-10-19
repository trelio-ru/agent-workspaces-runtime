import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProtectedVisualStore, visualStorageScope, awaitVisualVault } from '../host-runtime/scripts/trelio-visual-store.mjs';

test('native vault cancellation rejects without waiting for the OS and zeroes a late secret', async () => {
  const controller = new AbortController();
  let finishNative, calls = 0;
  const operation = new Promise(resolve => { finishNative = resolve; });
  const pending = awaitVisualVault(() => { calls++; return operation; }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { code: 'VISUAL_STORAGE_UNAVAILABLE' });
  const secret = Buffer.alloc(32, 77);
  finishNative(secret);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(secret, Buffer.alloc(32));
  assert.equal(calls, 1, 'timed-out native operation is never retried');
});

test('an already-expired vault deadline never starts the operation or reports readiness', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(awaitVisualVault(() => { throw new Error('must not run'); }, controller.signal),
    { code: 'VISUAL_STORAGE_UNAVAILABLE' });
});

test('late native failure after abort is consumed and cannot resume the caller', async () => {
  const controller = new AbortController(); let failNative;
  const pending = awaitVisualVault(() => new Promise((_resolve, reject) => { failNative = reject; }), controller.signal);
  await Promise.resolve(); controller.abort();
  await assert.rejects(pending, { code: 'VISUAL_STORAGE_UNAVAILABLE' });
  failNative(new Error('synthetic private native error'));
  await new Promise(resolve => setImmediate(resolve));
});

test('AEAD snapshot survives a new instance; missing key/corruption never replaces saved data', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-store-')));
  const keys = new Map();
  class Entry {
    constructor(service, name, options) { this.name = `${service}/${name}`; assert.equal(options.linux.store, 'secret-service'); }
    async getSecret() { return keys.get(this.name) || null; }
    async setSecret(value) { keys.set(this.name, [...value]); }
    async deleteCredential() { return keys.delete(this.name); }
  }
  const scope = visualStorageScope({ origin: 'https://example.test', skillId: 'fixture-browser', accountId: randomUUID() });
  const make = () => new ProtectedVisualStore({ directory, scope, AsyncEntry: Entry });
  const value = { cookies: [{ value: 'SYNTHETIC_SESSION_ONLY' }], origins: [] };
  try {
    const first = make(); assert.equal(await first.read(), null);
    await first.prepare(); assert.equal(keys.size, 1);
    assert.equal(await fs.stat(first.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
    await first.write(value); first.close();
    const text = await fs.readFile(first.file, 'utf8');
    assert.doesNotMatch(text, /SYNTHETIC_SESSION_ONLY/);
    const second = make(); assert.deepEqual(await second.read(), value); second.close();
    const savedKeys = new Map(keys); keys.clear();
    await assert.rejects(make().read(), { code: 'VISUAL_STORAGE_UNAVAILABLE' });
    await assert.rejects(make().write({ cookies: [] }), { code: 'VISUAL_STORAGE_UNAVAILABLE' });
    assert.equal(await fs.readFile(first.file, 'utf8'), text);
    for (const [name, key] of savedKeys) keys.set(name, key);
    const envelope = JSON.parse(text); envelope.data = Buffer.from('corrupted').toString('base64');
    await fs.writeFile(first.file, JSON.stringify(envelope));
    await assert.rejects(make().read(), { code: 'VISUAL_STORAGE_CORRUPT' });
    await fs.writeFile(first.file, text);
    const third = make(); assert.deepEqual(await third.read(), value); await third.remove();
    assert.equal(keys.size, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
