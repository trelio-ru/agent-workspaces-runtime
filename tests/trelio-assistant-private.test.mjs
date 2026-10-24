import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { createAssistantPrivateStore, openAssistantDatabase,
  resolveAssistantCompanyEncryptionDevice } from '../host-runtime/scripts/trelio-assistant-private.mjs';
import { hpkeSeal, hpkeOpen, signCompanyEncryptionRecord, verifyCompanyEncryptionRecord,
  buildAgentDeviceRegistrationRecord } from '../host-runtime/scripts/trelio-company-encryption.mjs';

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

test('company encryption slots retain separate OS identities for two devices and preserve old token slots', async () => {
  const values=new Map(),serviceKeys=[];
  const store=createAssistantPrivateStore({directory:path.resolve(os.tmpdir(),'assistant-key-scope-fixture'),platform:'darwin',primitives:{
    ensurePrivateDirectory:async()=>{},
    getMacosPrivateKeychainValue:async(service,account)=>values.get(`${service}:${account}`)??null,
    setMacosPrivateKeychainValue:async(service,account,value)=>{serviceKeys.push(`${service}:${account}`);values.set(`${service}:${account}`,value);},
  }});
  const key={origin:'https://assistant.test',kind:'company_encryption',id:randomUUID(),deviceId:randomUUID()};
  await store.put(key,{wrapped:'synthetic ciphertext'});
  for(const other of [{...key,deviceId:randomUUID()},{...key,id:randomUUID()},
    {...key,origin:'https://other.test'},{origin:key.origin,kind:'device',id:key.id}])assert.equal(await store.get(other),null);
  assert.deepEqual(await store.get(key),{wrapped:'synthetic ciphertext'});
  await assert.rejects(store.get({...key,deviceId:undefined}),/PRIVATE_INVALID_INPUT/);
  await assert.rejects(store.get({...key,kind:'runtime'}),/PRIVATE_INVALID_INPUT/);
  assert.equal(serviceKeys.length,1);
});

test('concurrent encryption preparation and restart reuse one common device and real HPKE/signatures', {timeout:60000}, async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-crypto-lock-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID();
  const entries=new Map();let writes=0,checks=0;
  const store={get:async key=>structuredClone(entries.get(JSON.stringify(key))??null),
    put:async(key,value)=>{writes++;entries.set(JSON.stringify(key),structuredClone(value));}};
  const options={identity,companyId,store,lockDirectory:path.join(directory,'locks'),assertCurrent:async()=>{checks++;}};
  const prepared=await Promise.all(Array.from({length:3},()=>resolveAssistantCompanyEncryptionDevice(options)));
  assert.equal(new Set(prepared.map(device=>device.fingerprint)).size,1);assert.equal(writes,1);
  const reopened=await resolveAssistantCompanyEncryptionDevice({...options});
  assert.equal(reopened.fingerprint,prepared[0].fingerprint);assert.equal(writes,1);assert.ok(checks>=12);
  const registration=buildAgentDeviceRegistrationRecord({companyId,userId:identity.assistantId,...reopened});
  const signature=await signCompanyEncryptionRecord(reopened.privateKeys.signingPrivateKey,registration);
  assert.equal(await verifyCompanyEncryptionRecord(reopened.publicSigningJwk,registration,signature),true);
  const secret=randomBytes(64),aad={purpose:'synthetic company envelope',companyId};
  const sealed=await hpkeSeal({recipientPublicEncryptionJwk:reopened.publicEncryptionJwk,plaintext:secret,aad});
  const opened=await hpkeOpen({recipientPrivateKey:reopened.privateKeys.encryptionPrivateKey,
    recipientPrivateJwk:reopened.privateBundle.encryptionPrivateJwk,envelope:sealed,aad});
  assert.deepEqual(Buffer.from(opened),secret);secret.fill(0);Buffer.from(opened).fill(0);
  const saved=[...entries.values()][0];
  assert.equal(saved.companyId,companyId);assert.equal(saved.deviceId,identity.deviceId);
  assert.equal(saved.record.companyId,companyId);
  assert.equal(JSON.stringify(saved).includes(reopened.privateBundle.signingPrivateJwk.d),false);
  assert.deepEqual(await fs.readdir(options.lockDirectory),[], 'no key or second journal is written beside the common lock');
});

test('foreign, corrupt or unavailable encryption state never regenerates or falls back to human identity', async () => {
  const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID();
  let saved=null,writes=0,live=true;
  const store={get:async()=>structuredClone(saved),put:async(_key,value)=>{saved=structuredClone(value);writes++;}};
  const options={identity,companyId,store,lockDirectory:path.resolve(os.tmpdir(),'assistant-crypto-fixture'),
    lock:(_name,action)=>action(),assertCurrent:async()=>{if(!live)throw new Error('PRIVATE revoked device');}};
  await assert.rejects(resolveAssistantCompanyEncryptionDevice({...options,allowCreate:false}),/PRIVATE_CORRUPT/);
  assert.equal(writes,0,'passive reader cannot create its first or replacement key');
  await resolveAssistantCompanyEncryptionDevice(options);assert.equal(writes,1);
  const original=structuredClone(saved);
  saved=null;
  await assert.rejects(resolveAssistantCompanyEncryptionDevice({...options,allowCreate:false}),/PRIVATE_CORRUPT/);
  assert.equal(writes,1,'lost reader state preserves the old enrollment instead of a new key');
  saved=structuredClone(original);
  for(const mutate of [entry=>{entry.deviceId=randomUUID();},entry=>{entry.assistantId=randomUUID();},
    entry=>{entry.companyId=randomUUID();},entry=>{entry.record.companyId=randomUUID();},
    entry=>{entry.record.wrappedPrivateBundle.ciphertext='invalid';}]){
    saved=structuredClone(original);mutate(saved);
    await assert.rejects(resolveAssistantCompanyEncryptionDevice(options),error=>/^ASSISTANT_PRIVATE_/u.test(error.code)&&!error.message.includes('PRIVATE revoked'));
    assert.equal(writes,1);
  }
  saved=structuredClone(original);live=false;
  await assert.rejects(resolveAssistantCompanyEncryptionDevice(options),/PRIVATE_UNAVAILABLE/);assert.equal(writes,1);
  live=true;
  await assert.rejects(resolveAssistantCompanyEncryptionDevice({...options,store:{...store,get:async()=>{throw new Error('RAW KEYRING OUTPUT');}}}),
    error=>error.code==='ASSISTANT_PRIVATE_UNAVAILABLE'&&!error.message.includes('RAW'));
  assert.deepEqual(saved,original);assert.equal(writes,1);
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
  const before=await fs.readFile(path.join(directory,'inbox.sqlite'));
  const readonly=await openAssistantDatabase(directory,{readOnly:true});
  assert.equal(readonly.database.prepare('SELECT value FROM fixture').get().value,7);
  assert.throws(()=>readonly.database.exec('INSERT INTO fixture VALUES(8)'),/readonly/u);
  await readonly.close();assert.deepEqual(await fs.readFile(path.join(directory,'inbox.sqlite')),before);
  const absent=path.join(root,'not-initialized');
  await assert.rejects(openAssistantDatabase(absent,{readOnly:true}),{code:'ASSISTANT_PRIVATE_STATE_NOT_INITIALIZED'});
  await assert.rejects(fs.stat(absent),{code:'ENOENT'});
  if (process.platform!=='win32') {
    assert.equal((await fs.stat(directory)).mode&0o777,0o700);
    assert.equal((await fs.stat(path.join(directory,'inbox.sqlite'))).mode&0o777,0o600);
    const link=path.join(root,'linked'); await fs.symlink(directory,link);
    await assert.rejects(openAssistantDatabase(link),/PRIVATE_UNAVAILABLE/);
    await assert.rejects(openAssistantDatabase(link,{readOnly:true}),/PRIVATE_UNAVAILABLE/);
    await fs.chmod(path.join(directory,'inbox.sqlite'),0o644);
    await assert.rejects(openAssistantDatabase(directory),/PRIVATE_UNAVAILABLE/);
    await assert.rejects(openAssistantDatabase(directory,{readOnly:true}),/PRIVATE_UNAVAILABLE/);
  }
});
