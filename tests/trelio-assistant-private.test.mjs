import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createAssistantPrivateStore, openAssistantDatabase } from '../host-runtime/scripts/trelio-assistant-private.mjs';

test('private credential slots isolate origin, assistant and purpose; no plaintext Windows fallback', async () => {
  const disk = new Map(), key = { origin: 'https://assistant.test', kind: 'device', id: randomUUID() };
  const primitives = {
    ensurePrivateDirectory: async () => {}, assertPrivatePathKind: async name => { if (!disk.has(name)) throw Object.assign(new Error(), { code: 'ENOENT' }); },
    writePrivateJsonFile: async (name,value) => disk.set(name,value), readPrivateJsonFile: async name => disk.get(name),
    protectWindowsBridgeSessionToken: async (_origin,text) => `protected:${Buffer.from(text).toString('base64')}`,
    unprotectWindowsBridgeSessionToken: async (_origin,text) => Buffer.from(text.slice(10),'base64').toString(),
  };
  const store = createAssistantPrivateStore({ directory:path.resolve(os.tmpdir(),'assistant-private-fixture'), platform:'win32', primitives });
  const value = { credential:'fixture-only', deviceId:randomUUID() };
  assert.equal(await store.get(key),null);
  await store.put(key,value); assert.deepEqual(await store.get(key),value);
  assert.ok([...disk.values()].every(entry => !JSON.stringify(entry).includes(value.credential)));
  assert.equal(await store.get({ ...key,id:randomUUID() }),null);
  assert.equal(await store.get({ ...key,kind:'pairing' }),null);
  assert.equal(await store.get({ ...key,origin:'https://other.test' }),null);
  // Swapping an encrypted slot does not change its bound identity.
  const second = { ...key,id:randomUUID() }; await store.put(second,{ credential:'other' });
  const entries = [...disk.entries()]; disk.set(entries[1][0],{ ...entries[0][1],key:entries[1][1].key });
  await assert.rejects(store.get(second), /PRIVATE_CORRUPT/);
  const failing = createAssistantPrivateStore({ directory:path.resolve(os.tmpdir(),'assistant-private-fixture'),platform:'win32',
    primitives:{ ...primitives,protectWindowsBridgeSessionToken:async()=>{throw new Error('PRIVATE RAW OUTPUT');} } });
  await assert.rejects(failing.put(key,value), error => error.code==='ASSISTANT_PRIVATE_UNAVAILABLE' && !error.message.includes('RAW'));
  assert.deepEqual(await store.get(key),value);
});

test('macOS uses a separate Keychain namespace; unsupported hosts cannot store a plaintext token', async () => {
  const values = new Map(), key = { origin:'https://assistant.test',kind:'pairing',id:randomUUID() };
  const store = createAssistantPrivateStore({ directory:path.resolve(os.tmpdir(),'assistant-private-fixture'),platform:'darwin',primitives:{
    ensurePrivateDirectory:async()=>{},
    getMacosPrivateKeychainValue:async(service,account)=>values.get(`${service}:${account}`)??null,
    setMacosPrivateKeychainValue:async(service,account,value)=>values.set(`${service}:${account}`,value),
    deleteMacosPrivateKeychainValue:async(service,account)=>values.delete(`${service}:${account}`),
  } });
  await store.put(key,{ verifier:'fixture-only' });
  assert.match([...values.keys()][0],/^ru\.trelio\.digital-assistant\.v1:[a-f0-9]{64}$/u);
  assert.deepEqual(await store.get(key),{ verifier:'fixture-only' }); await store.remove(key); assert.equal(await store.get(key),null);
  await assert.rejects(createAssistantPrivateStore({ directory:path.resolve(os.tmpdir(),'assistant-private-fixture'),platform:'linux' }).put(key,{}),/PLATFORM_UNSUPPORTED/);
});

test('real SQLite private opener survives restart and rejects symlinks without repairing them', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'assistant-db-fixture-'));
  t.after(()=>fs.rm(root,{ recursive:true,force:true }));
  const directory=path.join(root,'private');
  const first=await openAssistantDatabase(directory);
  first.database.exec('CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES(7)');
  await first.close();
  const second=await openAssistantDatabase(directory);
  assert.equal(second.database.prepare('SELECT value FROM fixture').get().value,7); await second.close();
  if (process.platform!=='win32') {
    assert.equal((await fs.stat(directory)).mode&0o777,0o700);
    assert.equal((await fs.stat(path.join(directory,'inbox.sqlite'))).mode&0o777,0o600);
    const link=path.join(root,'linked'); await fs.symlink(directory,link);
    await assert.rejects(openAssistantDatabase(link),/PRIVATE_UNAVAILABLE/);
    await fs.chmod(path.join(directory,'inbox.sqlite'),0o644);
    await assert.rejects(openAssistantDatabase(directory),/PRIVATE_UNAVAILABLE/);
  }
});
