import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDirectory, readPrivateJsonFile, writePrivateJsonFile, assertPrivatePathKind } from './trelio-workspace.mjs';
import { withBrowserAccountState, browserSnapshotRevision, browserExecutionDirectories } from './trelio-browser-session.mjs';

const FORMAT = 'trelio.protected-browser-state/v1';
const CREDENTIAL_FORMAT = 'trelio.protected-browser-credentials/v1';
const MAX_STATE = 16 * 1024 * 1024;
const invalid = code => Object.assign(new Error(code), { code });

/** Native Keychain calls can remain inside an OS dialog after a N-API abort.
 * Enforce the same original deadline at the JS boundary instead of assuming
 * the native promise will reject promptly. A late response is discarded and
 * zeroed; it never resumes key creation or turns a timed-out preflight ready.
 * No operation is retried here, including a set with an unknown late outcome.
 */
export function awaitVisualVault(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort);
      reject(invalid('VISUAL_STORAGE_UNAVAILABLE'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (settled) return undefined;
      return operation();
    }).then(value => {
      if (settled) { if (value instanceof Uint8Array) value.fill(0); return; }
      settled = true; signal.removeEventListener('abort', abort); resolve(value);
    }, () => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort);
      reject(invalid('VISUAL_STORAGE_UNAVAILABLE'));
    });
  });
}

/** Retain a private input copy until the native set actually settles, even if
 * its JS deadline expires first. The caller zeroes its own candidate on error;
 * that must not change the bytes of an OS write still in flight. No late set
 * is retried or treated as a verified key, and its input is cleared on settle.
 */
export function writeVisualVaultSecret(entry, bytes, signal) {
  return awaitVisualVault(() => {
    const nativeBytes = Buffer.from(bytes);
    try { return Promise.resolve(entry.setSecret(nativeBytes, signal)).finally(() => nativeBytes.fill(0)); }
    catch (error) { nativeBytes.fill(0); throw error; }
  }, signal);
}

export function visualStorageScope({ origin, skillId, accountId }) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(accountId)) throw invalid('VISUAL_IDENTITY_INVALID');
  return crypto.createHash('sha256').update(JSON.stringify([origin, skillId, accountId])).digest('hex');
}

/**
 * A device-local AEAD snapshot, with the random key held by the native OS
 * credential service. The binding is the verified host's personal account,
 * not a display name, company title, browser version or model-supplied path.
 * Linux explicitly requires Secret Service: keyutils' volatile fallback would
 * lose the decryption key after reboot and therefore is never selected here.
 */
export class ProtectedVisualStore {
  #key;
  #entry;
  #revisions = new Map();
  constructor({ directory, scope, executionOwner, AsyncEntry }) {
    if (!/^[0-9a-f]{64}$/u.test(scope) || !path.isAbsolute(directory)) throw invalid('VISUAL_IDENTITY_INVALID');
    this.scope = scope;
    this.directory = path.join(directory, 'visual-browser', scope);
    this.file = path.join(this.directory, 'state.enc');
    this.credentialsFile = path.join(this.directory, 'credentials.enc');
    if (executionOwner !== undefined && !/^[a-f0-9]{64}$/u.test(executionOwner)) throw invalid('VISUAL_IDENTITY_INVALID');
    this.executionOwner = executionOwner;
    this.#entry = new AsyncEntry('trelio.visual-browser.v1', scope, { linux: { store: 'secret-service' } });
  }

  init() { return withBrowserAccountState(this.directory, () => this.#init()); }

  async #init() {
    // Windows validation also hardens DACLs. It is a write, not a harmless
    // preflight: every internal caller holds the SAME account transaction so
    // a second worker cannot alter parent ACLs while the first publishes a
    // private file/claim. Public init uses that lock too; never nest it here.
    // Check every ancestor before following it. Credentials must not be
    // redirected into a checkout or a symlink-backed public directory.
    let cursor = this.directory;
    const missing = [];
    for (;;) {
      try {
        const stat = await fs.lstat(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid('VISUAL_STORAGE_UNSAFE');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing.push(cursor);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    for (const directory of missing.reverse()) await ensurePrivateDirectory(directory);
    await ensurePrivateDirectory(this.directory);
    await assertPrivatePathKind(this.directory, 'directory');
  }

  async #keyBytes(create) {
    if (this.#key) return this.#key;
    try {
      const signal = AbortSignal.timeout(15_000);
      let bytes = await awaitVisualVault(() => this.#entry.getSecret(signal), signal);
      if (bytes === null && create) {
        const candidate = crypto.randomBytes(32);
        try {
          await writeVisualVaultSecret(this.#entry, candidate, signal);
          bytes = await awaitVisualVault(() => this.#entry.getSecret(signal), signal);
          if (!bytes || bytes.length !== 32 || !crypto.timingSafeEqual(candidate, Buffer.from(bytes))) throw invalid('VISUAL_STORAGE_UNAVAILABLE');
        } finally { candidate.fill(0); }
      }
      if (!bytes || bytes.length !== 32) throw invalid('VISUAL_STORAGE_UNAVAILABLE');
      this.#key = Buffer.from(bytes);
      return this.#key;
    } catch { throw invalid('VISUAL_STORAGE_UNAVAILABLE'); }
  }

  async #readRecord(file, format) {
    await this.#init();
    const envelope = await readPrivateJsonFile(file, { maximumBytes: Math.ceil(MAX_STATE * 1.5) });
    this.#revisions.set(file, Object.keys(envelope).length ? browserSnapshotRevision(JSON.stringify(envelope)) : null);
    if (Object.keys(envelope).length === 0) return null;
    let plain;
    try {
      if (envelope.format !== format || envelope.scope !== this.scope || Object.keys(envelope).sort().join() !== 'data,format,iv,scope,tag') throw invalid('VISUAL_STORAGE_CORRUPT');
      const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw invalid('VISUAL_STORAGE_CORRUPT');
      const decipher = crypto.createDecipheriv('aes-256-gcm', await this.#keyBytes(false), iv);
      decipher.setAAD(Buffer.from(`${format}/${this.scope}`));
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      if (plain.length > MAX_STATE) throw invalid('VISUAL_STORAGE_CORRUPT');
      return JSON.parse(plain.toString('utf8'));
    } catch (error) {
      if (error.code === 'VISUAL_STORAGE_UNAVAILABLE') throw error;
      throw invalid('VISUAL_STORAGE_CORRUPT');
    } finally { plain?.fill(0); }
  }

  read() { return withBrowserAccountState(this.directory, async () => {
    if (this.executionOwner) {
      const retained = path.join(this.directory, 'sessions', this.executionOwner);
      const candidate = path.join(retained, 'state.enc');
      const exists = await fs.lstat(candidate).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) {
        const base = await readPrivateJsonFile(path.join(retained, 'state-base.json'), { maximumBytes: 1024 });
        if (Object.keys(base).join() !== 'revision' || base.revision !== null && !/^[a-f0-9]{64}$/u.test(base.revision)) throw invalid('VISUAL_STORAGE_CORRUPT');
        this.#revisions.set(this.file, base.revision);
        return this.#readRecord(candidate, FORMAT);
      }
    }
    return this.#readRecord(this.file, FORMAT);
  }); }
  readCredentials() { return withBrowserAccountState(this.directory, () => this.#readRecord(this.credentialsFile, CREDENTIAL_FORMAT)); }

  async #hasEncryptedRecord() {
    // A credentials-only account already owns a key. Losing that key must not
    // silently create a replacement merely because no browser snapshot exists.
    const candidates = (await browserExecutionDirectories(this.directory)).slice(1).map(directory => path.join(directory, 'state.enc'));
    const exists = await Promise.all([this.file, this.credentialsFile, ...candidates].map(file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })));
    return exists.some(Boolean);
  }

  async prepare() {
    // Verify the native vault before opening a human login window. A missing
    // desktop Secret Service must not be discovered only after somebody has
    // entered their password. Existing ciphertext never permits key replacement.
    await withBrowserAccountState(this.directory, async () => {
      await this.#init();
      const exists = await this.#hasEncryptedRecord();
      await this.#keyBytes(!exists);
    });
  }

  async #writeRecord(file, format, value) {
    return withBrowserAccountState(this.directory, async () => {
      await this.#init();
      // A damaged/missing OS key must never be replaced merely because a caller
      // wants to save new data over an existing encrypted session.
      const exists = await this.#hasEncryptedRecord();
      const plain = Buffer.from(JSON.stringify(value));
      try {
        if (plain.length > MAX_STATE) throw invalid('VISUAL_STORAGE_TOO_LARGE');
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', await this.#keyBytes(!exists), iv);
        cipher.setAAD(Buffer.from(`${format}/${this.scope}`));
        const data = Buffer.concat([cipher.update(plain), cipher.final()]);
        const envelope = { format, scope: this.scope, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
        const current = await readPrivateJsonFile(file, { maximumBytes: Math.ceil(MAX_STATE * 1.5) });
        const revision = Object.keys(current).length ? browserSnapshotRevision(JSON.stringify(current)) : null;
        if ((this.#revisions.get(file) ?? null) !== revision) {
          // Browser state is an opaque archive: merging it could resurrect an
          // explicit logout or corrupt IndexedDB. Retain this stopped session's
          // encrypted candidate without overwriting the newer account snapshot.
          // Credentials/fences cannot fork: a stale writer must refuse BEFORE
          // another secret-delivery step can be authorised.
          if (file !== this.file || !this.executionOwner) throw invalid('VISUAL_STORAGE_CONFLICT');
          const retained = path.join(this.directory, 'sessions', this.executionOwner);
          await ensurePrivateDirectory(retained);
          await writePrivateJsonFile(path.join(retained, 'state.enc'), envelope);
          await writePrivateJsonFile(path.join(retained, 'state-base.json'), { revision: this.#revisions.get(file) ?? null });
          return;
        }
        await writePrivateJsonFile(file, envelope);
        this.#revisions.set(file, browserSnapshotRevision(JSON.stringify(envelope)));
      } finally { plain.fill(0); }
    });
  }

  write(value) { return this.#writeRecord(this.file, FORMAT, value); }
  writeCredentials(value) { return this.#writeRecord(this.credentialsFile, CREDENTIAL_FORMAT, value); }
  async forgetCredentials() {
    return withBrowserAccountState(this.directory, async () => {
      await this.#init();
      // Deletion shares the same CAS boundary as pending credential delivery.
      // A stale setup/fence writer cannot resurrect a forgotten credential.
      const current = await readPrivateJsonFile(this.credentialsFile, { maximumBytes: Math.ceil(MAX_STATE * 1.5) });
      const revision = Object.keys(current).length ? browserSnapshotRevision(JSON.stringify(current)) : null;
      if (this.#revisions.has(this.credentialsFile) && this.#revisions.get(this.credentialsFile) !== revision) throw invalid('VISUAL_STORAGE_CONFLICT');
      try { await assertPrivatePathKind(this.credentialsFile, 'file'); await fs.unlink(this.credentialsFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.#revisions.set(this.credentialsFile, null);
    });
  }

  // Explicit disconnect erases the account, so it must first prove that no
  // chat (including a pre-upgrade worker) can later write with a cached key.
  // Startup reserves its active claim under this SAME account transaction.
  async remove() {
    return withBrowserAccountState(this.directory, async () => {
      await this.#init();
      for (const directory of await browserExecutionDirectories(this.directory)) {
        try {
          await assertPrivatePathKind(path.join(directory, 'active'), 'directory');
          throw invalid('VISUAL_STORAGE_CONFLICT');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await this.#entry.deleteCredential(AbortSignal.timeout(15_000));
      await fs.rm(this.file, { force: true });
      await fs.rm(this.credentialsFile, { force: true });
      for (const directory of (await browserExecutionDirectories(this.directory)).slice(1)) {
        for (const file of ['state.enc', 'state-base.json']) {
          const candidate = path.join(directory, file);
          try { await assertPrivatePathKind(candidate, 'file'); await fs.unlink(candidate); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      this.close();
    });
  }
  close() { this.#key?.fill(0); this.#key = undefined; }
}
