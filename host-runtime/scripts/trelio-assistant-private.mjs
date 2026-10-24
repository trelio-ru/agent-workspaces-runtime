/** Digital-assistant state uses the same reviewed OS primitives as the bridge.
 * This module is host-only: neither values nor arbitrary vault keys are tools. */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import {
  ensurePrivateDirectory, assertPrivatePathKind, readPrivateJsonFile, writePrivateJsonFile,
  getMacosPrivateKeychainValue, setMacosPrivateKeychainValue, deleteMacosPrivateKeychainValue,
  protectWindowsBridgeSessionToken, unprotectWindowsBridgeSessionToken,
} from './trelio-workspace.mjs';
import { createAgentEncryptionDevice, wrapAndRememberAgentEncryptionDevice,
  unlockRememberedAgentEncryptionDevice } from './trelio-company-encryption.mjs';
import { withRuntimeStateLock } from './trelio-runtime-session.mjs';

export class AssistantPrivateError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AssistantPrivateError(code); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SERVICE = 'ru.trelio.digital-assistant.v1';
const slot = ({ origin, kind, id, deviceId }) => {
  let url; try { url = new URL(origin); } catch { fail('ASSISTANT_PRIVATE_INVALID_INPUT'); }
  if (url.origin !== origin || url.protocol !== 'https:' || !['device','pairing','pass','runtime','company_encryption'].includes(kind) || !UUID.test(id ?? '')) fail('ASSISTANT_PRIVATE_INVALID_INPUT');
  // A company UUID alone would share one Keychain account across every managed
  // device on this OS user. Keep the existing four slot keys byte-identical,
  // but bind this new purpose to BOTH the enrolled device and company UUID.
  if (kind === 'company_encryption' ? !UUID.test(deviceId ?? '') : deviceId !== undefined) fail('ASSISTANT_PRIVATE_INVALID_INPUT');
  const identity = { origin, kind, id: id.toLowerCase(),
    ...(kind === 'company_encryption' ? { deviceId: deviceId.toLowerCase() } : {}) };
  return { ...identity, key: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
};

/** A separate service/account namespace, with an identity-bound inner envelope.
 * Windows reuses CurrentUser DPAPI and the native ACL helper, not OAuth storage
 * with a fictitious company/skill. macOS reuses the stdin-only Keychain helper.
 * Linux has no plaintext fallback. OS failures retain the old state and expose
 * only a closed error; raw helper paths/output must never reach a model/log. */
export const createAssistantPrivateStore = ({ directory, platform = process.platform, primitives = {} }) => {
  if (!path.isAbsolute(directory ?? '')) fail('ASSISTANT_PRIVATE_INVALID_INPUT');
  const ops = { ensurePrivateDirectory, assertPrivatePathKind, readPrivateJsonFile, writePrivateJsonFile,
    getMacosPrivateKeychainValue, setMacosPrivateKeychainValue, deleteMacosPrivateKeychainValue,
    protectWindowsBridgeSessionToken, unprotectWindowsBridgeSessionToken, ...primitives };
  const guard = action => async (...args) => {
    if (!['darwin','win32'].includes(platform)) fail('ASSISTANT_PRIVATE_PLATFORM_UNSUPPORTED');
    try { return await action(...args); }
    catch (error) { if (error instanceof AssistantPrivateError) throw error; fail('ASSISTANT_PRIVATE_UNAVAILABLE'); }
  };
  const file = key => path.join(directory, `${key}.json`);
  const ready = () => ops.ensurePrivateDirectory(directory);
  const decode = (text, identity) => {
    if(typeof text!=='string' || Buffer.byteLength(text)>16_384) fail('ASSISTANT_PRIVATE_CORRUPT');
    let envelope; try { envelope = JSON.parse(text); } catch { fail('ASSISTANT_PRIVATE_CORRUPT'); }
    if (envelope?.version !== 1 || envelope.key !== identity.key || !envelope.value || typeof envelope.value !== 'object'
      || Array.isArray(envelope.value)) fail('ASSISTANT_PRIVATE_CORRUPT');
    return envelope.value;
  };
  const get = guard(async input => {
    const identity = slot(input); await ready();
    if (platform === 'darwin') {
      const text = await ops.getMacosPrivateKeychainValue(SERVICE, identity.key);
      return text === null ? null : decode(text, identity);
    }
    try { await ops.assertPrivatePathKind(file(identity.key), 'file'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const entry = await ops.readPrivateJsonFile(file(identity.key), { maximumBytes: 32_768 });
    if (entry.version !== 1 || entry.key !== identity.key || typeof entry.ciphertext !== 'string'
      || entry.ciphertext.length > 30_000) fail('ASSISTANT_PRIVATE_CORRUPT');
    return decode(await ops.unprotectWindowsBridgeSessionToken(identity.origin, entry.ciphertext), identity);
  });
  const put = guard(async (input, value) => {
    const identity = slot(input); await ready();
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('ASSISTANT_PRIVATE_INVALID_INPUT');
    const text = JSON.stringify({ version: 1, key: identity.key, value });
    if (Buffer.byteLength(text) > 12_000) fail('ASSISTANT_PRIVATE_INVALID_INPUT');
    if (platform === 'darwin') await ops.setMacosPrivateKeychainValue(SERVICE, identity.key, text);
    else {
      const ciphertext = await ops.protectWindowsBridgeSessionToken(identity.origin, text);
      await ops.writePrivateJsonFile(file(identity.key), { version: 1, key: identity.key, ciphertext });
    }
    // Verify the final published slot too; protect() alone verifies only its
    // ciphertext. Never report successful enrollment on an unconfirmed save.
    const verified = await get(input);
    if (JSON.stringify(verified) !== JSON.stringify(value)) fail('ASSISTANT_PRIVATE_UNAVAILABLE');
  });
  const remove = guard(async input => {
    const identity = slot(input); await ready();
    if (platform === 'darwin') await ops.deleteMacosPrivateKeychainValue(SERVICE, identity.key);
    else {
      try { await ops.assertPrivatePathKind(file(identity.key), 'file'); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      await fs.unlink(file(identity.key));
    }
  });
  return { get, put, remove };
};

/** The assistant owns its encryption identity; it never imports the interactive
 * user's remembered device or asks the model for an unlock phrase. Reuse the
 * SAME P-256/wrapping codec, and store its wrapped record plus derived unlock
 * key together in the existing OS-protected store. No company scope key is
 * persisted here, and a local identity cannot grant a company envelope.
 *
 * This host-only primitive is deliberately not a tool or readiness signal. Its
 * caller must admit the exact live device/company before using the common
 * registration/envelope/data-plane flow, which can still refuse independently.
 */
export const resolveAssistantCompanyEncryptionDevice = async ({ identity, companyId, store,
  lockDirectory, assertCurrent, allowCreate = true, lock = withRuntimeStateLock }) => {
  if (!identity || !UUID.test(identity.assistantId ?? '') || !UUID.test(identity.deviceId ?? '')
    || !path.isAbsolute(lockDirectory ?? '') || typeof assertCurrent !== 'function'
    || typeof allowCreate !== 'boolean' || typeof store?.get !== 'function' || typeof store?.put !== 'function') fail('ASSISTANT_PRIVATE_INVALID_INPUT');
  const input = { origin: identity.origin, kind: 'company_encryption', id: companyId, deviceId: identity.deviceId };
  const key = slot(input);
  const binding = { version: 1, origin: key.origin, assistantId: identity.assistantId.toLowerCase(),
    deviceId: key.deviceId, companyId: key.id };
  const assertLive = async () => {
    try { await assertCurrent(); }
    catch(error) {
      // Preserve the two closed binding/lease signals instead of diagnosing a
      // revoked pass as an OS keyring failure. No raw message/cause survives.
      if(['ASSISTANT_PASS_REVIEW_REQUIRED','ASSISTANT_WORKSPACE_BINDING_CHANGED'].includes(error?.code)) fail(error.code);
      fail('ASSISTANT_PRIVATE_UNAVAILABLE');
    }
  };
  try {
    await assertLive();
    // Serialize first creation through the common private lock, not a second
    // journal. Publish/verify before any registration can expose a fingerprint:
    // a crash or lost response then resumes this SAME identity, never a new key.
    return await lock(path.join(lockDirectory, `company-encryption-${key.key}.json`), async () => {
      await assertLive();
      let entry = await store.get(input);
      if (entry === null) {
        // Enrollment may create its initial identity. A passive reader that
        // already sent an enrolled fingerprint must never replace a lost slot.
        if(!allowCreate)fail('ASSISTANT_PRIVATE_CORRUPT');
        const generated = await createAgentEncryptionDevice();
        const entropy = randomBytes(48);let phrase,wrapped;
        try {
          phrase = entropy.toString('base64url');
          wrapped = await wrapAndRememberAgentEncryptionDevice({ device: generated,
            companyId: binding.companyId, encryptionSecret: phrase });
        } finally { entropy.fill(0);phrase = ''; }
        // Strings cannot be zeroized reliably. This random wrapping input is
        // never returned or persisted; only the codec's derived key enters OS
        // storage, exactly as in the common remembered-device representation.
        entry = { ...binding, ...wrapped };
        await assertLive();
        await store.put(input, entry);
        const saved = await store.get(input);
        if (JSON.stringify(saved) !== JSON.stringify(entry)) fail('ASSISTANT_PRIVATE_UNAVAILABLE');
        entry = saved;
      }
      // Missing, foreign or corrupt state is NOT permission to generate a
      // replacement. It must retain the original key/envelope for repair.
      if (!entry || Object.entries(binding).some(([field, value]) => entry[field] !== value)
        || entry.record?.companyId !== binding.companyId || typeof entry.trustedUnlockKey !== 'string') fail('ASSISTANT_PRIVATE_CORRUPT');
      const device = await unlockRememberedAgentEncryptionDevice(entry);
      if (device.fingerprint !== entry.record.fingerprint) fail('ASSISTANT_PRIVATE_CORRUPT');
      await assertLive();
      return device;
    });
  } catch (error) {
    if (error instanceof AssistantPrivateError) throw error;
    // Crypto/OS errors can contain key-shaped input, native paths or helper
    // output. Preserve a closed cause only; never return raw provider errors.
    fail('ASSISTANT_PRIVATE_UNAVAILABLE');
  }
};

/** SQLite and its sidecars inherit an already private directory. Check every
 * existing entry before opening and again after SQLite creates files. Multiple
 * connections use the inbox's transactional leases, not a stale PID file that
 * would prevent safe crash recovery or guess process identity after PID reuse. */
export const openAssistantDatabase = async (directory, { readOnly = false } = {}) => {
  if (!path.isAbsolute(directory ?? '')) fail('ASSISTANT_PRIVATE_INVALID_INPUT');
  if (typeof readOnly !== 'boolean') fail('ASSISTANT_PRIVATE_INVALID_INPUT');
  let db;
  try {
    // Status uses the SAME private path/ACL checks, but must not create a
    // journal, migrate it, recover leases or alter SQLite pragmas. Absence is
    // reported explicitly rather than creating an empty queue that looks idle.
    if (readOnly) await assertPrivatePathKind(directory, 'directory');
    else await ensurePrivateDirectory(directory);
    const databasePath = path.join(directory, 'inbox.sqlite');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { await assertPrivatePathKind(databasePath + suffix, 'file'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Create before handing the filename to SQLite, so POSIX umask cannot
    // briefly expose a new DB. No path or arbitrary SQL is model-visible.
    const flags = constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW || 0);
    if (!readOnly) { const handle = await fs.open(databasePath, flags, 0o600); await handle.close(); }
    await assertPrivatePathKind(databasePath, 'file');
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, readOnly });
    // DELETE avoids persistent WAL/SHM handles outside this single coordinator.
    // The private parent protects a transient rollback journal as well.
    if (!readOnly) db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    await assertPrivatePathKind(directory, 'directory');
    await assertPrivatePathKind(databasePath, 'file');
    let closed = false;
    return { database: db, async close() {
      if (closed) return; db.close(); closed = true;
    } };
  } catch (error) {
    try { db?.close(); } catch { /* Keep the original typed setup failure. */ }
    if (readOnly && error?.code === 'ENOENT') fail('ASSISTANT_PRIVATE_STATE_NOT_INITIALIZED');
    if (error instanceof AssistantPrivateError) throw error;
    fail('ASSISTANT_PRIVATE_UNAVAILABLE');
  }
};
