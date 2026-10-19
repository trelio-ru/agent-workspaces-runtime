import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProtectedVisualStore, visualStorageScope } from '../host-runtime/scripts/trelio-visual-store.mjs';

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
