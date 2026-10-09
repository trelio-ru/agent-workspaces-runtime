/**
 * Device-local personal account catalogue. The host owns selection and company
 * bindings; a signed provider owns its opaque storage reference and credentials.
 * There is deliberately no mutable global “current account”, and no date-based
 * legacy switch. Import compatibility is removed by a future reviewed release.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ACCOUNT_CAPABILITY = 'local-accounts-v1';
export const ACCOUNT_LIMIT = 64;
export const ACCOUNT_MINIMUM_HOST_VERSION = '3.7.0';
const MAX_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireThat = (condition, code) => { if (!condition) throw new SkillAccountError(code); };

export class SkillAccountError extends Error {
  constructor(code) { super(code); this.name = 'SkillAccountError'; this.code = code; }
}

export function accountText(value, maximum, { empty = false } = {}) {
  requireThat(typeof value === 'string', 'ACCOUNT_TEXT_INVALID');
  const result = value.replace(/\r\n?/gu, '\n').trim();
  requireThat((empty || result.length > 0) && [...result].length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result), 'ACCOUNT_TEXT_INVALID');
  return result;
}

export function accountScope({ origin, skillId, companyId, memberId, connectionId = null }) {
  let parsedOrigin;
  try { parsedOrigin = new URL(origin).origin; } catch { /* Invalid input remains a typed scope refusal. */ }
  requireThat(typeof origin === 'string' && parsedOrigin === origin &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillId) && UUID.test(companyId) && UUID.test(memberId) &&
    (connectionId === null || UUID.test(connectionId)), 'ACCOUNT_SCOPE_INVALID');
  return { catalogue: hash([origin, skillId]), company: hash([origin, companyId, memberId]),
    importScope: hash([origin, companyId, memberId, connectionId]), skillId };
}

const emptyState = () => ({ schemaVersion: 1, revision: 0, accounts: [], bindings: {}, imports: {} });
const validRef = ref => ref === null || typeof ref === 'string' && ref.length > 0 &&
  Buffer.byteLength(ref, 'utf8') <= 4096 && !/[\u0000-\u001f\u007f]/u.test(ref);

function validateState(value) {
  requireThat(object(value) && value.schemaVersion === 1 && Number.isSafeInteger(value.revision) &&
    value.revision >= 0 && Array.isArray(value.accounts) && value.accounts.length <= ACCOUNT_LIMIT &&
    object(value.bindings) && object(value.imports) &&
    Object.keys(value.bindings).length <= 512 && Object.keys(value.imports).length <= 2048,
  'ACCOUNT_CATALOGUE_INVALID');
  const ids = new Set();
  for (const account of value.accounts) {
    requireThat(object(account) && UUID.test(account.id) && !ids.has(account.id) && validRef(account.providerRef),
      'ACCOUNT_CATALOGUE_INVALID');
    requireThat(accountText(account.name, 120) === account.name &&
      accountText(account.comment, 2000, { empty: true }) === account.comment, 'ACCOUNT_CATALOGUE_INVALID');
    ids.add(account.id);
  }
  for (const [scope, binding] of Object.entries(value.bindings)) {
    requireThat(HASH.test(scope) && object(binding) && Array.isArray(binding.accountIds) &&
      new Set(binding.accountIds).size === binding.accountIds.length &&
      binding.accountIds.every(id => ids.has(id)) && (binding.defaultAccountId === null ||
      binding.accountIds.includes(binding.defaultAccountId)), 'ACCOUNT_CATALOGUE_INVALID');
  }
  for (const [source, id] of Object.entries(value.imports)) {
    requireThat(HASH.test(source) && (id === null || ids.has(id)), 'ACCOUNT_CATALOGUE_INVALID');
  }
  requireThat(Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES, 'ACCOUNT_CATALOGUE_TOO_LARGE');
  return value;
}

/** Parse the host selector before spawning a provider. Duplicate selectors are
 * errors, even when equal: an appended flag must never silently override one
 * embedded in an earlier approved command. Provider arguments stay in order. */
export function splitAccountArguments(args) {
  requireThat(Array.isArray(args) && args.every(v => typeof v === 'string'), 'ACCOUNT_ARGUMENTS_INVALID');
  let accountId = null;
  const providerArguments = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--local-account') {
      requireThat(accountId === null && UUID.test(args[i + 1] || ''), 'ACCOUNT_SELECTOR_INVALID');
      accountId = args[++i];
    } else {
      requireThat(!args[i].startsWith('--local-account='), 'ACCOUNT_SELECTOR_INVALID');
      providerArguments.push(args[i]);
    }
  }
  return { accountId, providerArguments };
}

/** All I/O uses the host's existing owner/ACL-checked primitives. A lock never
 * expires while its process is alive. Unknown ownership fails closed; callers
 * cannot turn an I/O or permission error into an empty catalogue. */
export function createAccountCatalogue({ directory, scope, io }) {
  requireThat(path.isAbsolute(directory) && HASH.test(scope.catalogue), 'ACCOUNT_SCOPE_INVALID');
  const root = path.join(directory, 'skill-accounts');
  const file = path.join(root, `${scope.catalogue}.json`);
  const lock = path.join(root, `${scope.catalogue}.lock`);
  const read = async () => {
    try { await fs.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
    const value = await io.read(file, { maximumBytes: MAX_BYTES });
    return validateState(value);
  };
  async function transaction(operation) {
    await io.ensureDirectory(root);
    const token = crypto.randomUUID(), deadline = Date.now() + 5000;
    let acquired = false;
    while (!acquired && Date.now() < deadline) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        acquired = true;
        await io.ensureDirectory(lock);
        await io.write(path.join(lock, 'owner.json'), { pid: process.pid, token });
      } catch (error) {
        if (acquired) {
          // We created this directory, but its protected owner publication may
          // have failed. Remove only a still-empty directory; rmdir cannot
          // erase a published owner or another writer's state. Keeping a
          // nonempty/unverifiable lock is safer than guessing after I/O failure.
          try { await fs.rmdir(lock); } catch { /* Preserve uncertain state. */ }
          throw error;
        }
        if (error.code !== 'EEXIST') throw error;
        // Do not remove an ownerless/unknown lock: it may be between mkdir and
        // protected owner publication. Crash recovery is an explicit safe error.
        // Validation must never recreate a lock another writer just released.
        try { await io.checkDirectory(lock); }
        catch (missing) { if (missing.code === 'ENOENT') continue; throw missing; }
        const owner = await io.read(path.join(lock, 'owner.json'), { maximumBytes: 1024 });
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (e) {
            if (e.code === 'ESRCH') {
              // Serialize reclaimers independently from ordinary writers. The
              // exact dead owner's directory is renamed before removal, so a
              // subsequent writer's new lock can never be deleted by recovery.
              const recovery = `${lock}.recovery`;
              try { await fs.mkdir(recovery, { mode: 0o700 }); }
              catch (busy) {
                if (busy.code !== 'EEXIST') throw busy;
                await new Promise(resolve => setTimeout(resolve, 25));
                continue;
              }
              try {
                // A competing normal release can remove the directory. Reading
                // owner.json then returns no owner and never manufactures a lock.
                const current = await io.read(path.join(lock, 'owner.json'), { maximumBytes: 1024 });
                if (current.token === owner.token && current.pid === owner.pid) {
                  const abandoned = `${lock}.${crypto.randomUUID()}.abandoned`;
                  await fs.rename(lock, abandoned);
                  await fs.unlink(path.join(abandoned, 'owner.json'));
                  await fs.rmdir(abandoned);
                }
              } finally { await fs.rmdir(recovery); }
              continue;
            }
            if (e.code !== 'EPERM') throw e;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    requireThat(acquired, 'ACCOUNT_CATALOGUE_BUSY');
    try {
      const state = await read();
      const before = JSON.stringify(state);
      const result = await operation(state);
      if (JSON.stringify(state) !== before) {
        state.revision++;
        validateState(state);
        await io.write(file, state);
        requireThat(JSON.stringify(await read()) === JSON.stringify(state), 'ACCOUNT_CATALOGUE_READBACK_FAILED');
      }
      return result;
    } finally {
      const owner = await io.read(path.join(lock, 'owner.json'), { maximumBytes: 1024 });
      if (owner.token === token) {
        await fs.unlink(path.join(lock, 'owner.json'));
        await fs.rmdir(lock);
      }
    }
  }
  const binding = state => state.bindings[scope.company] || { accountIds: [], defaultAccountId: null };
  const find = (state, id) => {
    const item = state.accounts.find(a => a.id === id);
    requireThat(item, 'ACCOUNT_NOT_FOUND'); return item;
  };
  return {
    async list() {
      await io.ensureDirectory(root);
      const state = await read(), current = binding(state);
      return { revision: state.revision, accounts: state.accounts.map(({ id, name, comment }) => ({
        id, name, comment, bound: current.accountIds.includes(id), default: current.defaultAccountId === id,
      })) };
    },
    async change({ operation, id, name, comment, expectedRevision }) {
      requireThat(['create', 'update', 'bind', 'unbind', 'default'].includes(operation), 'ACCOUNT_OPERATION_INVALID');
      requireThat(['create', 'update'].includes(operation) || name === undefined && comment === undefined, 'ACCOUNT_ARGUMENTS_INVALID');
      requireThat(operation !== 'update' || name !== undefined || comment !== undefined, 'ACCOUNT_ARGUMENTS_INVALID');
      return transaction(state => {
        requireThat(Number.isSafeInteger(expectedRevision) && expectedRevision === state.revision, 'ACCOUNT_CATALOGUE_CONFLICT');
        const current = binding(state);
        if (operation === 'create') {
          requireThat(UUID.test(id) && !state.accounts.some(a => a.id === id), 'ACCOUNT_ID_CONFLICT');
          // A provider may retain new accounts beside legacy device entries
          // (email's TOML is one such store). Their canonical import source is
          // the host UUID: reserve it now, so a later company's initial probe
          // cannot duplicate or silently activate this already-known account.
          const source = hash([scope.catalogue, id]);
          requireThat(!Object.hasOwn(state.imports, source), 'ACCOUNT_ID_CONFLICT');
          state.accounts.push({ id, name: accountText(name, 120), comment: accountText(comment ?? '', 2000, { empty: true }), providerRef: null });
          state.imports[source] = id;
          current.accountIds.push(id);
          if (current.accountIds.length === 1) current.defaultAccountId = id;
        } else {
          const item = find(state, id);
          if (operation === 'update') {
            if (name !== undefined) item.name = accountText(name, 120);
            if (comment !== undefined) item.comment = accountText(comment, 2000, { empty: true });
          } else if (operation === 'bind') {
            if (!current.accountIds.includes(id)) current.accountIds.push(id);
          } else if (operation === 'unbind') {
            current.accountIds = current.accountIds.filter(v => v !== id);
            if (current.defaultAccountId === id) current.defaultAccountId = null;
          } else if (operation === 'default') {
            requireThat(current.accountIds.includes(id), 'ACCOUNT_NOT_BOUND'); current.defaultAccountId = id;
          } else throw new SkillAccountError('ACCOUNT_OPERATION_INVALID');
        }
        state.bindings[scope.company] = current;
        return { id };
      });
    },
    async select(id = null) {
      await io.ensureDirectory(root);
      const state = await read(), current = binding(state);
      const selected = id || current.defaultAccountId || (current.accountIds.length === 1 ? current.accountIds[0] : null);
      requireThat(selected, current.accountIds.length ? 'ACCOUNT_SELECTION_REQUIRED' : 'ACCOUNT_SETUP_REQUIRED');
      requireThat(current.accountIds.includes(selected), 'ACCOUNT_NOT_BOUND');
      return { ...find(state, selected), companyBinding: scope.company };
    },
    async importOnce(discover) {
      return transaction(async state => {
        // LEGACY: skill-personal-accounts-v1 (Trelio docs/legacy-registry.json).
        // Store a durable empty result as well. Unbinding must not re-import an
        // old account on the next call, and a failed probe must not mark success.
        const marker = hash([scope.importScope, 'completed']);
        if (Object.hasOwn(state.imports, marker)) return;
        const entries = await discover();
        requireThat(Array.isArray(entries) && entries.length <= ACCOUNT_LIMIT, 'ACCOUNT_IMPORT_INVALID');
        const current = binding(state);
        for (const entry of entries) {
          requireThat(object(entry) && typeof entry.sourceKey === 'string' && entry.sourceKey.length > 0 &&
            entry.sourceKey.length <= 1024 && validRef(entry.providerRef) && entry.providerRef !== null &&
            ['device', 'company'].includes(entry.scope), 'ACCOUNT_IMPORT_INVALID');
          const source = hash([entry.scope === 'device' ? scope.catalogue : scope.importScope, entry.sourceKey]);
          let id = state.imports[source];
          const newlyImported = !id;
          if (!id) {
            id = crypto.randomUUID();
            state.accounts.push({ id, name: accountText(entry.name, 120),
              comment: accountText(entry.comment ?? '', 2000, { empty: true }), providerRef: entry.providerRef });
            state.imports[source] = id;
          }
          // Legacy mail was device-wide and has no historical company binding.
          // Its first import adopts the current company; discovery elsewhere
          // must only offer the same account, never silently activate it there.
          if ((newlyImported || entry.scope === 'company') && !current.accountIds.includes(id)) current.accountIds.push(id);
        }
        if (current.accountIds.length === 1) current.defaultAccountId = current.accountIds[0];
        state.bindings[scope.company] = current;
        state.imports[marker] = null;
      });
    },
  };
}
