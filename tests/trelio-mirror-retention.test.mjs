import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { randomUUID, webcrypto } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  pruneCompanyMirrorCaches, pruneMirrorSchema, withMirrorRetentionLock, withCompanyMirrorRetentionLock,
  MIRROR_READER_GRACE_MS, MIRROR_HISTORY_MAX_BYTES, MIRROR_SCHEMA_VERSION,
} from '../host-runtime/scripts/trelio-mirror-retention.mjs';
import { ensurePrivateDirectory, writePrivateJsonFile, resolveWorkspaceBridgeConfigDirectory } from '../host-runtime/scripts/trelio-workspace.mjs';
import { ProcessDiagnosticError } from '../host-runtime/scripts/trelio-process-diagnostics.mjs';
import { resolveMirrorPaths, syncCompanyContextMirror } from '../host-runtime/scripts/trelio-local-context.mjs';
import { encryptCompanyPayload } from '../host-runtime/scripts/trelio-company-encryption.mjs';
const exec = promisify(execFile);
const origin = 'a'.repeat(32);
const company = '11111111-1111-4111-8111-111111111111';
const name = n => n.toString(16).padStart(64, '0');
const old = new Date(Date.now() - MIRROR_READER_GRACE_MS * 2);

const fixture = async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-mirror-retention-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'company-context-mirrors');
  const companyRoot = path.join(directory, origin, company);
  await ensurePrivateDirectory(companyRoot);
  const schema = async (version = 8, count = 8) => {
    const root = version === 1 ? companyRoot : path.join(companyRoot, `schema-${version}`);
    await ensurePrivateDirectory(path.join(root, 'generations'));
    for (let n = 1; n <= count; n++) {
      const file = path.join(root, 'generations', `${name(n)}.json`);
      // Synthetic payload only. Cleanup treats the generation as opaque bytes.
      await writePrivateJsonFile(file, { encryptedPayload: 'fixture' });
      await fs.utimes(file, new Date(+old + n * 1000), new Date(+old + n * 1000));
    }
    await writePrivateJsonFile(path.join(root, 'current.json'), { schemaVersion: version, generation: name(count) });
    return root;
  };
  return { base, directory, companyRoot, schema };
};
const generations = root => fs.readdir(path.join(root, 'generations'));

test('human search builds a fresh private snapshot alongside a live mirror writer', { timeout: 60_000 }, async t => {
  if (process.env.TRELIO_HUMAN_SEARCH_WRITER_FIXTURE !== '1') {
    // Exercise the real encrypted pointer/private-file/lock implementation in
    // a disposable home on every OS. Never inspect or alter the user's writer.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-search-writer-'));
    try {
      const environment = { ...process.env, HOME: home, USERPROFILE: home,
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        TRELIO_WORKSPACE_DISABLE_KEYCHAIN: '1', TRELIO_HUMAN_SEARCH_WRITER_FIXTURE: '1' };
      delete environment.NODE_TEST_CONTEXT;
      const child = await exec(process.execPath, ['--test', '--test-name-pattern',
        '^human search builds a fresh private snapshot', fileURLToPath(import.meta.url)], {
        env: environment,
        timeout: 55_000, maxBuffer: 1024 * 1024,
      });
      assert.match(child.stdout, /HUMAN_SEARCH_WRITER_VERIFIED/u);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
    return;
  }
  const origin = 'https://search-writer.example', companyId = randomUUID();
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const scope = { id: randomUUID(), epoch: 2,
    publicEncryptionJwk: await webcrypto.subtle.exportKey('jwk', keys.publicKey) };
  const encryption = { runtime: { company: { id: companyId, slug: 'synthetic' }, scope, device: { id: randomUUID() } },
    scopePrivateEncryptionKey: { privateKey: keys.privateKey,
      privateJwk: await webcrypto.subtle.exportKey('jwk', keys.privateKey) } };
  const paths = resolveMirrorPaths({ origin, companyId });
  const legacyLock = path.join(path.dirname(paths.root), 'schema-8', 'retention.lock');
  await ensurePrivateDirectory(legacyLock);
  await ensurePrivateDirectory(paths.generations);
  const workspace = { id: randomUUID(), acceptedHead: 'b'.repeat(40),
    documents: [{ path: 'synthetic.txt', text: 'Unchanged accepted source' }] };
  const unchanged = { cacheKey: 'task:unchanged', id: 'unchanged', type: 'task', title: 'Unchanged',
    revisionToken: 'same', fields: [{ source: 'task-title', values: ['Unchanged'] }] };
  const publish = async (n, { root = paths.root, version = MIRROR_SCHEMA_VERSION,
    workspaces = [workspace], epoch = scope.epoch } = {}) => {
    const generation = name(n), serverGeneration = name(n + 100);
    const payload = { schemaVersion: version, generation, serverGeneration,
      company: encryption.runtime.company, tasks: [], workspaces, searchDocuments: [unchanged,
        { ...unchanged, cacheKey: 'task:synthetic', revisionToken: 'old', title: 'Stale source' },
        { ...unchanged, cacheKey: 'task:revoked', id: 'revoked' }] };
    const encryptedPayload = await encryptCompanyPayload({ payload,
      scopePublicEncryptionJwk: scope.publicEncryptionJwk,
      aad: { companyId, scopeId: scope.id, scopeEpoch: epoch,
        entityType: 'agent_context.mirror', entityId: randomUUID(), entityRevision: 1, purpose: 'content' } });
    const generationsRoot = path.join(root, 'generations');
    await ensurePrivateDirectory(generationsRoot);
    await writePrivateJsonFile(path.join(generationsRoot, `${generation}.json`), {
      schemaVersion: version, companyId, generation, serverGeneration, encryptedPayload });
    await writePrivateJsonFile(path.join(root, 'current.json'), { schemaVersion: version, companyId, generation, serverGeneration });
    return payload;
  };
  const old = await publish(1);
  await ensurePrivateDirectory(paths.lock);
  const owner = { id: randomUUID(), pid: process.pid };
  const ownerPath = path.join(paths.lock, `${owner.pid}-${owner.id}.json`);
  await writePrivateJsonFile(ownerPath, owner);
  const ownerBytes = await fs.readFile(ownerPath);
  const pointerBytes = await fs.readFile(paths.pointer);
  const generationNames = await generations(paths.root);
  const rootNames = await fs.readdir(paths.root);
  const originalFetch = globalThis.fetch;
  let reads = 0;
  const freshDocument = { cacheKey: 'task:synthetic', id: 'synthetic', type: 'task', title: 'Current source',
    revisionToken: 'fresh', fields: [{ source: 'task-title', values: ['Current source'] }] };
  const manifest = { schemaVersion: 2, provider: 'local_company_context', generation: name(102),
    company: encryption.runtime.company, viewer: { memberId: randomUUID() }, projects: [], tasks: [],
    acceptedWorkspaces: [{ id: workspace.id, acceptedHead: workspace.acceptedHead }],
    contextDocuments: [], searchDocuments: [unchanged, freshDocument], instructions: {} };
  globalThis.fetch = async url => {
    assert.equal(new URL(url).pathname, '/api/agent-workspaces/company-context/synthetic/manifest');
    reads++;
    return new Response(JSON.stringify(manifest), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const sync = options => syncCompanyContextMirror({ origin, token: 'synthetic-token',
    companyEncryption: encryption, ...options });
  // Hold the real retention mutex until the reader reports cancellation.
  // A reader that keeps waiting for the lock cannot pass this handshake.
  let pendingRead;
  const controller = new AbortController();
  const cancellation = new Error('Synthetic mirror read cancelled while waiting for retention');
  const contended = Promise.withResolvers();
  const originalRename = fs.rename;
  const retentionLock = path.join(paths.root, 'retention.lock');
  const stages = [];
  try {
    await withCompanyMirrorRetentionLock(paths.root, async () => {
      fs.rename = async (source, target) => {
        try { return await originalRename(source, target); }
        catch (error) {
          if (target === retentionLock && ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) {
            contended.resolve();
          }
          throw error;
        }
      };
      pendingRead = sync({ signal: controller.signal, onProgress: stage => stages.push(stage) })
        .then(() => null, error => error);
      assert.equal(await Promise.race([contended.promise, delay(10_000, 'no contention', { ref: false })]), undefined);
      controller.abort(cancellation);
      const outcome = await Promise.race([pendingRead, delay(1_000, 'still waiting', { ref: false })]);
      assert.equal(outcome, cancellation, 'The reader must settle before the held retention lock is released');
      assert.deepEqual(stages, ['mirror_read']);
      assert.equal(reads, 0, 'Cancellation must not start a manifest read');
    });
  } finally {
    fs.rename = originalRename;
    await pendingRead;
  }

  // Ordinary detail reads retain their established immutable fallback. This
  // proves the old generation is actually readable before testing the search.
  const fallback = await sync({});
  assert.equal(fallback.syncInProgress, true);
  assert.equal(fallback.mirror.serverGeneration, old.serverGeneration);
  assert.equal(reads, 0);

  // The live owner never releases its claim. Human search still finishes from
  // the current native inventory with both ordinary assembly fences, rather
  // than waiting for that owner's downloads or serving its stale predecessor.
  const result = await sync({ readOnlyOnContention: true, signal: AbortSignal.timeout(10_000) });
  assert.equal(result.readOnlySnapshot, true);
  assert.equal(result.mirror.serverGeneration, manifest.generation);
  assert.match(result.mirror.generation, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.mirror.searchDocuments, [unchanged, freshDocument], 'Changed and revoked sources follow the fresh inventory');
  assert.deepEqual(result.mirror.workspaces, [workspace], 'Unchanged accepted heads reuse complete existing bytes without a second download');
  assert.equal(reads, 2, 'Starting and finishing native manifests still fence the complete snapshot');
  assert.deepEqual(await fs.readFile(ownerPath), ownerBytes);
  assert.deepEqual(await fs.readFile(paths.pointer), pointerBytes, 'The parallel reader never publishes a pointer');
  assert.deepEqual(await generations(paths.root), generationNames, 'No extra durable generation is written');
  assert.deepEqual(await fs.readdir(paths.root), rootNames, 'The sibling writer retains sole ownership of its resumable scratchpad');
  assert.deepEqual(await fs.readdir(legacyLock), [], 'Search works while the legacy orphan remains untouched');

  let conflictedReads = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ ...manifest,
    generation: name(200 + ++conflictedReads) }), { status: 200 });
  await assert.rejects(sync({ readOnlyOnContention: true }), { code: 'LOCAL_CONTEXT_GENERATION_CHANGED' });
  assert.equal(conflictedReads, 6, 'The parallel path keeps the same three bounded assembly attempts');
  assert.deepEqual(await fs.readFile(paths.pointer), pointerBytes, 'An inconsistent candidate is never published');

  const cancelled = new AbortController();
  let entered;
  const atRead = new Promise(resolve => { entered = resolve; });
  globalThis.fetch = async (_url, options) => {
    entered();
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const refusal = assert.rejects(sync({ readOnlyOnContention: true, signal: cancelled.signal }),
    error => error === cancelled.signal.reason);
  await atRead;
  cancelled.abort(new Error('Synthetic original search cancelled'));
  await refusal;
  assert.deepEqual(await fs.readFile(ownerPath), ownerBytes);
  assert.deepEqual(await fs.readFile(paths.pointer), pointerBytes);

  // A first sync after upgrading can publish a complete snapshot without
  // taking ownership of the abandoned lock in the old runtime's cache.
  await fs.rm(paths.lock, { recursive: true });
  await fs.unlink(paths.pointer);
  const coldManifest = { ...manifest, acceptedWorkspaces: [] };
  globalThis.fetch = async () => new Response(JSON.stringify(coldManifest), { status: 200 });
  const rebuilt = await sync({ requireFresh: true, signal: AbortSignal.timeout(10_000) });
  assert.equal(rebuilt.changed, true);
  assert.equal(rebuilt.mirror.serverGeneration, coldManifest.generation);
  assert.equal(JSON.parse(await fs.readFile(paths.pointer)).generation, rebuilt.mirror.generation);
  assert.deepEqual(await fs.readdir(legacyLock), []);

  // A rolling upgrade has a complete schema-8 snapshot but no current
  // pointer. Exercise real encrypted bytes and a live competing current
  // writer, including the case where the old and fresh generation are equal.
  const legacyRoot = path.dirname(legacyLock);
  const revoked = { ...workspace, id: randomUUID() };
  const legacyOptions = { root: legacyRoot, version: 8, workspaces: [
    { ...workspace, title: 'Stale Workspace metadata' }, revoked,
  ] };
  await fs.rmdir(legacyLock);
  await publish(2, legacyOptions);
  const schemaNine = path.join(path.dirname(paths.root), "schema-9");
  await publish(2, { ...legacyOptions, root: schemaNine, version: 9 });
  const oldWriter = path.join(schemaNine, "sync.lock");
  await ensurePrivateDirectory(oldWriter);
  const legacyPointer = path.join(legacyRoot, 'current.json');
  const legacyPointerBytes = await fs.readFile(legacyPointer);
  await fs.unlink(paths.pointer);
  await ensurePrivateDirectory(paths.lock);
  await writePrivateJsonFile(ownerPath, owner);
  const currentWorkspace = { id: workspace.id, acceptedHead: workspace.acceptedHead, title: 'Fresh Workspace metadata' };
  const current = { ...manifest, acceptedWorkspaces: [currentWorkspace] };
  let upgradeReads = 0;
  globalThis.fetch = async url => {
    assert.equal(new URL(url).pathname, '/api/agent-workspaces/company-context/synthetic/manifest',
      'An unchanged accepted head must not download its files again');
    upgradeReads++;
    return new Response(JSON.stringify(current));
  };
  const upgraded = await sync({ readOnlyOnContention: true, signal: AbortSignal.timeout(10_000) });
  assert.equal(upgradeReads, 2, 'A legacy pointer must never satisfy the fresh manifest check');
  assert.equal(upgraded.readOnlySnapshot, true);
  assert.deepEqual(upgraded.mirror.workspaces, [{ ...currentWorkspace, documents: workspace.documents }]);
  assert.deepEqual(upgraded.mirror.searchDocuments, current.searchDocuments);
  assert.deepEqual(await fs.readFile(ownerPath), ownerBytes);
  assert.deepEqual(await fs.readFile(legacyPointer), legacyPointerBytes);
  assert.deepEqual(await fs.readdir(oldWriter), [], 'The old schema writer namespace is left alone');
  await assert.rejects(fs.lstat(paths.pointer), { code: 'ENOENT' });

  await fs.rm(paths.lock, { recursive: true });
  const published = await sync({ readOnlyOnContention: true, signal: AbortSignal.timeout(10_000) });
  assert.equal(upgradeReads, 4);
  assert.equal(published.mirror.schemaVersion, MIRROR_SCHEMA_VERSION);
  assert.deepEqual(published.mirror.workspaces, upgraded.mirror.workspaces);
  assert.equal(JSON.parse(await fs.readFile(paths.pointer)).generation, published.mirror.generation);

  // Subsequent cases exercise schema 8 as the only compatible predecessor.
  await fs.unlink(path.join(schemaNine, "current.json"));
  // A rotated scope, changed head or unavailable legacy cache must read the
  // exact fresh Workspace and propagate the refusal without serving old text.
  await fs.unlink(paths.pointer);
  for (const changed of ['scope_epoch', 'accepted_head', 'legacy_lock']) {
    await publish(2, { ...legacyOptions, epoch: changed === 'scope_epoch' ? scope.epoch - 1 : scope.epoch });
    if (changed === 'legacy_lock') await ensurePrivateDirectory(legacyLock);
    let requestedWorkspace = false;
    globalThis.fetch = async url => {
      if (new URL(url).pathname === '/api/agent-workspaces/company-context/synthetic/manifest') {
        return new Response(JSON.stringify({ ...current, acceptedWorkspaces: [{
          ...currentWorkspace, acceptedHead: changed === 'accepted_head' ? 'c'.repeat(40) : workspace.acceptedHead,
        }] }));
      }
      requestedWorkspace = true;
      return new Response(JSON.stringify({ code: 'ACCESS_DENIED', message: 'Synthetic refusal' }), { status: 403 });
    };
    await assert.rejects(sync({ readOnlyOnContention: true, signal: AbortSignal.timeout(10_000) }),
      error => error.statusCode === 403);
    assert.equal(requestedWorkspace, true);
    await assert.rejects(fs.lstat(paths.pointer), { code: 'ENOENT' });
  }
  assert.deepEqual(await fs.readdir(legacyLock), [], 'The optional reader leaves an ownerless legacy claim intact');
  console.log('HUMAN_SEARCH_WRITER_VERIFIED');
});

test('mirror writer recovers a confirmed dead owner without waiting for heartbeat age', async t => {
  if (process.env.TRELIO_MIRROR_DEAD_WRITER_FIXTURE !== '1') {
    // All private metadata belongs to this disposable OS/config root. Execute
    // the real common writer and native Windows private-file checks; never
    // recover a developer's mirror or substitute a made-up dead process ID.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-dead-writer-'));
    try {
      const environment = { ...process.env, HOME: home, USERPROFILE: home,
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        TRELIO_WORKSPACE_DISABLE_KEYCHAIN: '1', TRELIO_MIRROR_DEAD_WRITER_FIXTURE: '1' };
      delete environment.NODE_TEST_CONTEXT;
      let child;
      try { child = await exec(process.execPath, ['--test', '--test-name-pattern',
        'mirror writer recovers a confirmed dead owner', fileURLToPath(import.meta.url)], {
        env: environment,
        timeout: 60_000, maxBuffer: 1024 * 1024,
      }); } catch (error) {
        // Keep the original failing assertion/exit. Project only fixed stages
        // from this isolated synthetic child, never its raw stdout or paths.
        const stages = String(error.stdout ?? '').match(/MIRROR_DEAD_WRITER_STAGE:(?:root|pid|first|live|malformed|unexpected|concurrent|entered|owner|waiting|released|settled|race_absent|race_replaced|race_unchanged|verified)\b/gu);
        const failures = String(error.stdout ?? '').match(/MIRROR_DEAD_WRITER_ERROR:(?:ENOENT|EACCES|EPERM|EEXIST|ERR_ASSERTION|TRELIO_WINDOWS_PRIVATE_ACL_FAILED|other):(?:lstat|stat|open|read|mkdir|rename|rmdir|unlink|other):(?:path_decode|identity|owner_read|owner_write|dacl_write|dacl_verify|other)\b/gu);
        const line=String(error.stdout??'').match(/MIRROR_DEAD_WRITER_DIAGNOSTIC (\{[^\r\n]*\})/u)?.[1];
        const diagnostic=line?JSON.parse(line):null;
        t.diagnostic(JSON.stringify({ fixture: 'dead_mirror_writer',
          stage: stages?.at(-1)?.split(':')[1] ?? null,
          exitCode: Number.isInteger(error.code) ? error.code : null,
          signal:/^SIG[A-Z]+$/u.test(error.signal??'')?error.signal:null,
          failures: failures ?? [],diagnostic }));
        throw error;
      }
      assert.match(child.stdout, /DEAD_MIRROR_WRITER_VERIFIED/u);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
    return;
  }
  let stage='paths';
  try {
  const origin = 'https://mirror.example', companyId = '11111111-1111-4111-8111-111111111111';
  console.log('MIRROR_DEAD_WRITER_STAGE:root');
  const paths = resolveMirrorPaths({ origin, companyId });
  await ensurePrivateDirectory(paths.root);
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { exited.once('error', reject); exited.once('close', resolve); });
  stage='exited_pid';
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  console.log('MIRROR_DEAD_WRITER_STAGE:pid');
  const seed = async (pid, extra = {}) => {
    await ensurePrivateDirectory(paths.lock);
    const owner = { id: randomUUID(), pid };
    const file = path.join(paths.lock, `${pid}-${owner.id}.json`);
    await writePrivateJsonFile(file, { ...owner, ...extra });
    return file;
  };
  const readOwner = async () => JSON.parse(await fs.readFile(path.join(paths.lock, (await fs.readdir(paths.lock))[0])));
  const encryption = { runtime: { company: { id: companyId, slug: 'synthetic' },
    scope: { id: randomUUID(), epoch: 1 }, device: { id: randomUUID() } } };
  const previousFetch = globalThis.fetch;
  let reads = 0, held, entered;
  const refusal = new Error('SYNTHETIC_MIRROR_STOP');
  globalThis.fetch = async url => {
    assert.equal(new URL(url).pathname, '/api/agent-workspaces/company-context/synthetic/manifest');
    reads++; if (reads === 3) entered?.(); if (held) await held;
    // Reaching the original native reader is enough to prove acquisition.
    // Its explicit refusal must survive; no partial mirror is published.
    throw refusal;
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  // Preserve the actual rejection for assertions, projecting only a closed
  // filesystem/native category through the isolated child. In particular an
  // ACL refusal must not disappear inside assert.rejects' predicate failure.
  const observed = async promise => {
    try { return await promise; } catch (error) {
      const originalCode = error.diagnosticCode ?? error.code;
      const code = ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ERR_ASSERTION',
        'TRELIO_WINDOWS_PRIVATE_ACL_FAILED'].includes(originalCode) ? originalCode : 'other';
      const syscall = ['lstat', 'stat', 'open', 'read', 'mkdir', 'rename', 'rmdir', 'unlink']
        .includes(error.syscall) ? error.syscall : 'other';
      const phase = String(error.operation ?? '').split('.').at(-1);
      const native = ['path_decode', 'identity', 'owner_read', 'owner_write', 'dacl_write', 'dacl_verify']
        .includes(phase) ? phase : 'other';
      console.log(`MIRROR_DEAD_WRITER_ERROR:${code}:${syscall}:${native}`);
      throw error;
    }
  };
  const sync = signal => observed(syncCompanyContextMirror({ origin, token: 'synthetic-token',
    companyEncryption: encryption, requireFresh: true, signal }));
  stage='dead_owner_seed';await seed(exited.pid);
  console.log('MIRROR_DEAD_WRITER_STAGE:first');
  stage='dead_owner_recover';
  await assert.rejects(sync(AbortSignal.timeout(5_000)), error => error.cause === refusal);
  assert.equal(reads, 1, 'a fresh dead-owner claim does not consume another sync budget');
  assert.equal(await fs.stat(paths.lock).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e)), null);

  // An empty directory can only be left by release in this atomic layout.
  // A stopped reader must not leave the next cold search blocked by it.
  await ensurePrivateDirectory(paths.lock);
  await assert.rejects(sync(AbortSignal.timeout(5_000)), error => error.cause === refusal);
  assert.equal(reads, 2);
  await assert.rejects(fs.lstat(paths.lock), { code: 'ENOENT' });

  // A live or malformed owner is never declared dead by elapsed clocks, a
  // partial read or a failed PID probe. Cancelling the waiter changes nothing.
  for (const [variant, seedClaim] of [['live', async () => {
    const file = await seed(process.pid);
    const old = new Date(Date.now() - 20 * 60_000);
    await fs.utimes(file, old, old);
    await fs.utimes(paths.lock, old, old);
    return file;
  }], ['malformed', () => seed(exited.pid, { id: randomUUID() })], ['unexpected', async () => {
    const file = await seed(exited.pid); await fs.writeFile(path.join(paths.lock, 'unexpected'), 'synthetic');
    return file;
  }]]) {
    stage=variant;
    console.log(`MIRROR_DEAD_WRITER_STAGE:${stage}`);
    const file = await seedClaim();
    const before = await fs.readFile(file);
    const signal = AbortSignal.timeout(250);
    await assert.rejects(sync(signal), error => error === signal.reason);
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal(reads, 2, 'a blocked waiter never reaches the manifest');
    await fs.rm(paths.lock, { recursive: true });
  }

  // Two fresh contenders may recover the same dead owner, but only one may
  // reach network work at a time. The loser must preserve the successor's lock.
  stage='concurrent_seed';await seed(exited.pid);
  console.log('MIRROR_DEAD_WRITER_STAGE:concurrent');
  let release; held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const entering = new Promise(resolve => { entered = resolve; });
  stage='concurrent_first';const first = assert.rejects(sync(AbortSignal.timeout(5_000)), error => error.cause === refusal);
  await Promise.race([entering, first.then(() => { throw new Error('WRITER_DID_NOT_REACH_READER'); })]);
  console.log('MIRROR_DEAD_WRITER_STAGE:entered');
  const successor = await observed(readOwner());
  console.log('MIRROR_DEAD_WRITER_STAGE:owner');
  assert.equal(successor.pid, process.pid);
  stage='concurrent_second';const second = assert.rejects(sync(AbortSignal.timeout(5_000)), error => error.cause === refusal);
  console.log('MIRROR_DEAD_WRITER_STAGE:waiting');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(reads, 3);
  assert.equal((await readOwner()).id, successor.id);
  stage='concurrent_release';release(); console.log('MIRROR_DEAD_WRITER_STAGE:released');
  await Promise.all([first, second]);
  console.log('MIRROR_DEAD_WRITER_STAGE:settled');
  assert.equal(reads, 4);
  assert.equal(await fs.stat(paths.pointer).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e)), null);
  // Deterministically reproduce the native inspection/release interleaving,
  // independently of Windows scheduler luck. Only this fixture's synthetic
  // sync.lock is changed. The native refusal remains the original Error object;
  // metadata proves release/replacement, never a permission/retry exemption.
  const originalLstat = fs.lstat;
  for (const mode of ['absent', 'replaced', 'unchanged']) {
    stage='race_'+mode;
    console.log(`MIRROR_DEAD_WRITER_STAGE:race_${mode}`);
    const observedOwner = await seed(exited.pid);
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(5_000)]);
    let abortTimer;
    const privateRefusal = new ProcessDiagnosticError('TRELIO_WINDOWS_PRIVATE_ACL_FAILED',
      'Synthetic late private inspection refusal.', { operation: 'windows_acl.owner_read' });
    let injected = false;
    fs.lstat = async (...args) => {
      if (!injected && args[0] === observedOwner) {
        injected = true;
        if (mode !== 'unchanged') {
          await fs.rm(paths.lock, { recursive: true });
          if (mode === 'replaced') {
            await seed(process.pid);
            // Begin the short cancellation wait only once this synthetic
            // successor exists; native setup does not consume that wait.
            abortTimer = setTimeout(() => cancellation.abort(new Error('synthetic waiter cancelled')), 250);
          }
        }
        throw privateRefusal;
      }
      return originalLstat(...args);
    };
    try {
      await assert.rejects(sync(signal), error => mode === 'absent' ? error.cause === refusal
        : mode === 'replaced' ? error === signal.reason : error === privateRefusal);
      assert.equal(injected, true);
      assert.equal(reads, 5, 'only a positively released claim permits the next manifest read');
      if (mode !== 'absent') {
        const owner = await readOwner();
        assert.equal(owner.pid, mode === 'replaced' ? process.pid : exited.pid, 'successor/unchanged owner is never removed');
      }
    } finally {
      clearTimeout(abortTimer);
      fs.lstat = originalLstat;
      await fs.rm(paths.lock, { recursive: true, force: true });
    }
  }
  console.log('MIRROR_DEAD_WRITER_STAGE:verified');
  console.log('DEAD_MIRROR_WRITER_VERIFIED');
  } catch(error) {
    const failures=[error,error.cause,error.actual,error.actual?.cause].filter(Boolean);
    const codes=[...new Set(failures.map(value=>value.diagnosticCode??value.code)
      .filter(value=>typeof value==='string'&&/^(?:ERR_|TRELIO_|LOCAL_CONTEXT_|E[A-Z]{2,}$)[A-Z0-9_]*$/u.test(value)))];
    const operation=failures.map(value=>value.operation).find(value=>
      /^windows_acl\.(?:path_decode|identity|owner_read|owner_write|dacl_write|dacl_verify)$/u.test(value??''))??null;
    console.log('MIRROR_DEAD_WRITER_DIAGNOSTIC '+JSON.stringify({stage,codes,operation}));
    throw error; // Original assertion and all recovery deadlines remain strict.
  }
});

test('startup sweep prunes historical schemas including v1 without changing current pointers', async t => {
  const f = await fixture(t);
  const versions = [1, 2, 4, 7, 8, 9, MIRROR_SCHEMA_VERSION];
  for (const version of versions) await f.schema(version);
  const report = await pruneCompanyMirrorCaches({ directory: f.directory });
  assert.equal(report.removedFiles, versions.length * 6);
  for (const version of versions) {
    const root = version === 1 ? f.companyRoot : path.join(f.companyRoot, `schema-${version}`);
    assert.deepEqual((await generations(root)).sort(), [name(7), name(8)].map(n => `${n}.json`));
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'current.json'))).generation, name(8));
  }
  assert.equal((await pruneCompanyMirrorCaches({ directory: f.directory })).skipped, 'interval');
});

test('active reader serializes cleanup until its immutable generation has been read', async t => {
  const f = await fixture(t); const root = await f.schema(MIRROR_SCHEMA_VERSION);
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const reading = withCompanyMirrorRetentionLock(root, async () => {
    entered(); await blocked;
    assert.match(await fs.readFile(path.join(root, 'generations', `${name(1)}.json`), 'utf8'), /fixture/);
  });
  await ready;
  const cleanup = pruneMirrorSchema(root);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await generations(root)).length, 8);
  release(); await reading; await cleanup;
  assert.equal((await generations(root)).length, 2);
});

test('writer lock and future schemas are left intact; an unrelated schema still cleans', async t => {
  const f = await fixture(t); const busy = await f.schema(7); const current = await f.schema(MIRROR_SCHEMA_VERSION);
  await fs.mkdir(path.join(busy, 'sync.lock'), { mode: 0o700 });
  const legacy = await f.schema(8);
  const legacyLock = path.join(legacy, 'retention.lock');
  await fs.mkdir(legacyLock, { mode: 0o700 });
  const future = await f.schema(MIRROR_SCHEMA_VERSION + 1);
  const report = await pruneCompanyMirrorCaches({ directory: f.directory });
  assert.equal(report.skippedSchemas, 2);
  assert.equal((await generations(busy)).length, 8);
  assert.equal((await generations(legacy)).length, 8);
  assert.deepEqual(await fs.readdir(legacyLock), []);
  assert.equal((await generations(future)).length, 8);
  assert.equal((await generations(current)).length, 2);
});

test('legacy reader grace retains newly written generations', async t => {
  const f = await fixture(t); const root = await f.schema();
  const previous = path.join(root, 'generations', `${name(7)}.json`);
  await fs.truncate(previous, MIRROR_HISTORY_MAX_BYTES + 1);
  await fs.utimes(previous, new Date(+old + 7000), new Date(+old + 7000));
  const recent = path.join(root, 'generations', `${name(1)}.json`);
  await fs.utimes(recent, new Date(), new Date());
  await pruneMirrorSchema(root);
  assert.deepEqual((await generations(root)).sort(), [name(1), name(8)].map(n => `${n}.json`));
  await fs.utimes(recent, old, old);
  await pruneMirrorSchema(root);
  assert.equal((await generations(root)).length, 2);
});

test('malformed pointer, symlinks, hardlinks, unknown files and interrupted writes are never removed', async t => {
  const f = await fixture(t); const root = await f.schema();
  const outside = path.join(f.base, 'outside.json'); await writePrivateJsonFile(outside, { untouched: true });
  const dir = path.join(root, 'generations');
  if (process.platform !== 'win32') await fs.symlink(outside, path.join(dir, `${name(30)}.json`));
  await fs.link(outside, path.join(dir, `${name(31)}.json`));
  await fs.writeFile(path.join(dir, 'partial.tmp'), 'partial', { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'unknown.txt'), 'unknown', { mode: 0o600 });
  await pruneMirrorSchema(root);
  assert.equal(await fs.readFile(path.join(dir, 'partial.tmp'), 'utf8'), 'partial');
  assert.equal((await fs.stat(outside)).nlink, 2);
  await writePrivateJsonFile(path.join(root, 'current.json'), { schemaVersion: 8, generation: '../outside' });
  assert.equal((await pruneMirrorSchema(root)).skipped, 'invalid_pointer');
  assert.equal((await generations(root)).includes(`${name(8)}.json`), true);
});

test('dead maintenance owner is recovered; live owner is never expired by age', async t => {
  const f = await fixture(t); const root = await f.schema();
  const lock = path.join(root, 'retention.lock'); await ensurePrivateDirectory(lock);
  const id = '22222222-2222-4222-8222-222222222222';
  // A completed child provides an actually dead PID rather than a guessed one.
  const { stdout } = await exec(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  await writePrivateJsonFile(path.join(lock, `${Number(stdout)}-${id}.json`), { id, pid: Number(stdout) });
  assert.equal(await withMirrorRetentionLock(root, async () => 'recovered'), 'recovered');
  await ensurePrivateDirectory(lock);
  await writePrivateJsonFile(path.join(lock, `${process.pid}-${id}.json`), { id, pid: process.pid });
  await fs.utimes(lock, old, old);
  assert.equal((await withMirrorRetentionLock(root, async () => assert.fail(), { waitMs: 0 })).skipped, 'busy');
});

test('atomic mirror claims survive process exit before publication, after publication and during release', async t => {
  const f = await fixture(t);
  const root = await f.schema(MIRROR_SCHEMA_VERSION, 1);
  const lock = path.join(root, 'retention.lock');
  const moduleUrl = new URL('../host-runtime/scripts/trelio-mirror-retention.mjs', import.meta.url).href;
  const source = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { withCompanyMirrorRetentionLock } from ${JSON.stringify(moduleUrl)};
    const [root, phase] = process.argv.slice(1);
    const lock = path.join(root, 'retention.lock');
    const rename = fs.rename, rmdir = fs.rmdir;
    fs.rename = async (from, to) => {
      if (to === lock && phase === 'before') process.exit(71);
      await rename(from, to);
      if (to === lock && phase === 'published') process.exit(72);
    };
    fs.rmdir = async target => {
      if (target === lock && phase === 'released') process.exit(73);
      return rmdir(target);
    };
    await withCompanyMirrorRetentionLock(root, async () => {});
  `;
  for (const [phase, code] of [['before', 71], ['published', 72], ['released', 73]]) {
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', source, root, phase]), { code });
    if (phase === 'before') {
      await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
      assert.equal((await fs.readdir(root)).filter(name => name.startsWith('.retention-')).length, 1);
    } else {
      const entries = await fs.readdir(lock);
      if (phase === 'published') assert.match(entries[0] ?? '', /^\d+-[a-f0-9-]{36}\.json$/u);
      assert.equal(entries.length, phase === 'published' ? 1 : 0);
    }
    assert.equal(await withCompanyMirrorRetentionLock(root, async () => 'recovered', { waitMs: 5_000 }), 'recovered');
    await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
  }
});


test('an oversized previous copy is evicted while current has no size limit', async t => {
  const f = await fixture(t); const root = await f.schema();
  for (const n of [7, 8]) {
    const file = path.join(root, 'generations', `${name(n)}.json`);
    await fs.truncate(file, MIRROR_HISTORY_MAX_BYTES + 1);
    await fs.utimes(file, new Date(+old + n * 1000), new Date(+old + n * 1000));
  }
  await pruneMirrorSchema(root);
  assert.deepEqual(await generations(root), [`${name(8)}.json`]);
});

test('missing current after an interrupted publication preserves every fallback', async t => {
  const f = await fixture(t); const root = await f.schema();
  await fs.unlink(path.join(root, 'generations', `${name(8)}.json`));
  const report = await pruneCompanyMirrorCaches({ directory: f.directory });
  assert.equal(report.skippedSchemas, 1);
  assert.equal((await generations(root)).length, 7);
});

test('replacement writer fences cleanup before any historical file is removed', async t => {
  const f = await fixture(t); const root = await f.schema();
  assert.equal((await pruneMirrorSchema(root, { stillOwnsWriter: async () => false })).skipped, 'writer_replaced');
  assert.equal((await generations(root)).length, 8);
});

test('real entrypoint runs background maintenance using only its isolated local cache', async t => {
  const f = await fixture(t); await f.schema();
  // HOME alone is not sufficient on Windows; isolate every config root. No
  // source-tree test may sweep the developer's actual company caches.
  const environment = { ...process.env, HOME: f.base, USERPROFILE: f.base,
    LOCALAPPDATA: path.join(f.base, 'AppData', 'Local'),
    CODEX_HOME: path.join(f.base, '.codex'), TRELIO_WORKSPACE_DISABLE_KEYCHAIN: '1',
    TRELIO_PLUGIN_VERSION: '3.2.0', TRELIO_HOST_RUNTIME_VERSION: '3.7.3' };
  const bridgeRoot = resolveWorkspaceBridgeConfigDirectory({ environment, homeDirectory: f.base });
  await ensurePrivateDirectory(bridgeRoot);
  const cacheRoot = path.join(bridgeRoot, 'company-context-mirrors');
  await fs.rename(f.directory, cacheRoot);
  const legacyLock = path.join(cacheRoot, 'retention.lock');
  const legacyState = path.join(cacheRoot, 'retention-state.json');
  await ensurePrivateDirectory(legacyLock);
  await writePrivateJsonFile(legacyState, { completedAt: Date.now() });
  const priorState = await fs.readFile(legacyState, 'utf8');
  const entrypoint = fileURLToPath(new URL('../host-runtime/scripts/trelio-host-runtime-entry.mjs', import.meta.url));
  // --help exits without admission/network. Cleanup is the genuine detached
  // startup subprocess, not a test replacement for the production launcher.
  await exec(process.execPath, [entrypoint, 'bridge', '--help'], { env: environment });
  const deadline = Date.now() + 30_000;
  let state;
  while (Date.now() < deadline) {
    try { state = JSON.parse(await fs.readFile(path.join(cacheRoot, 'retention-v2-state.json'))); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state?.removedFiles, 6);
  // Wait for the detached process to release its root lock before teardown.
  while (Date.now() < deadline) {
    try { await fs.lstat(path.join(cacheRoot, 'retention-v2.lock')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assert.deepEqual(await fs.readdir(legacyLock), []);
      assert.equal(await fs.readFile(legacyState, 'utf8'), priorState);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('background maintenance did not release its lock');
});


test('independent processes serialize updates while atomic lock directories repeatedly disappear', async t => {
  const f = await fixture(t); const root = await f.schema(MIRROR_SCHEMA_VERSION);
  const counter = path.join(root, 'counter.json');
  await fs.writeFile(counter, '0', { mode: 0o600 });
  const moduleUrl = new URL('../host-runtime/scripts/trelio-mirror-retention.mjs', import.meta.url).href;
  const source = `import fs from 'node:fs/promises';
    import { withCompanyMirrorRetentionLock } from ${JSON.stringify(moduleUrl)};
    for (let n = 0; n < 12; n++) {
      const result = await withCompanyMirrorRetentionLock(process.argv[1], async () => {
        const count = Number(await fs.readFile(process.argv[2], 'utf8'));
        await fs.writeFile(process.argv[2], String(count + 1));
        return true;
      });
      if (result !== true) throw Error('lock acquisition did not complete');
    }`;
  const env = { ...process.env, HOME: f.base, USERPROFILE: f.base,
    LOCALAPPDATA: path.join(f.base, 'AppData', 'Local'), CODEX_HOME: path.join(f.base, '.codex'),
    TRELIO_WORKSPACE_DISABLE_KEYCHAIN: '1' };
  await Promise.all(Array.from({ length: 3 }, () => exec(process.execPath,
    ['--input-type=module', '-e', source, root, counter], { env })));
  assert.equal(Number(await fs.readFile(counter, 'utf8')), 36);
});

test('missing first lock inspection retries only acquisition even when a successor already exists', async t => {
  const f = await fixture(t); const root = await f.schema();
  const lock = path.join(root, 'retention.lock'); await fs.mkdir(lock, { mode: 0o700 });
  const originalLstat = fs.lstat;
  let replaced = false;
  let operations = 0;
  fs.lstat = async (target, ...args) => {
    if (target === lock && !replaced) {
      replaced = true;
      await fs.rmdir(lock);
      await fs.mkdir(lock, { mode: 0o700 });
      // Inject the actual kernel observation before the successor won mkdir.
      // A later lstat sees the replacement, so fresh absence cannot help.
      throw Object.assign(new Error('synthetic missing lock'), { code: 'ENOENT' });
    }
    return originalLstat(target, ...args);
  };
  try {
    const result = await withMirrorRetentionLock(root, async () => { operations++; }, { waitMs: 0 });
    assert.equal(result.skipped, 'busy');
    assert.equal(operations, 0);
    assert.equal((await originalLstat(lock)).isDirectory(), true, 'successor remains untouched');
  } finally { fs.lstat = originalLstat; }
});

test('first lock inspection retains permission refusal while the lock still exists', async t => {
  const f = await fixture(t); const root = await f.schema();
  const lock = path.join(root, 'retention.lock'); await fs.mkdir(lock, { mode: 0o700 });
  const originalLstat = fs.lstat;
  const denied = Object.assign(new Error('synthetic permission refusal'), { code: 'EACCES' });
  let refused = false;
  fs.lstat = async (target, ...args) => {
    if (target === lock && !refused) { refused = true; throw denied; }
    return originalLstat(target, ...args);
  };
  try {
    await assert.rejects(withMirrorRetentionLock(root, async () => assert.fail(), { waitMs: 0 }), error => error === denied);
    assert.equal((await originalLstat(lock)).isDirectory(), true);
  } finally { fs.lstat = originalLstat; }
});

test('Windows delete-pending mkdir retries only the unacquired claim and retains persistent refusal', async t => {
  const f = await fixture(t); const root = await f.schema();
  const lock = path.join(root, 'retention.lock');
  const mkdir = fs.mkdir, platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let claims = 0, operations = 0;
  const denied = Object.assign(new Error('synthetic delete-pending claim'), { code: 'EPERM' });
  fs.mkdir = async (target, ...args) => {
    if (target === lock) {
      claims++;
      if (claims === 1) {
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        throw denied;
      }
      // Restore the actual OS before successful private/DACL operations. Only
      // the injected kernel error is Windows-specific, not the fixture store.
      Object.defineProperty(process, 'platform', platform);
    }
    return mkdir(target, ...args);
  };
  try {
    assert.equal(await withMirrorRetentionLock(root, async () => { operations++; return true; }), true);
    assert.equal(claims, 2); assert.equal(operations, 1);
    claims = 0;
    fs.mkdir = async (target, ...args) => {
      if (target !== lock) return mkdir(target, ...args);
      claims++; Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }); throw denied;
    };
    await assert.rejects(withMirrorRetentionLock(root, async () => { operations++; }), error => error === denied);
    assert.equal(claims, 6); assert.equal(operations, 1, 'failed acquisition never invokes the protected operation');
  } finally {
    fs.mkdir = mkdir; Object.defineProperty(process, 'platform', platform);
  }
});

test('Windows rename denial counts as contention only with an observed destination', async t => {
  const f = await fixture(t);
  const root = await f.schema(MIRROR_SCHEMA_VERSION, 1);
  const lock = path.join(root, 'retention.lock');
  await ensurePrivateDirectory(lock);
  const id = randomUUID();
  await writePrivateJsonFile(path.join(lock, `${process.pid}-${id}.json`), { id, pid: process.pid });
  const rename = fs.rename;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const denied = Object.assign(new Error('synthetic rename refusal'), { code: 'EPERM' });
  fs.rename = async (from, to) => {
    if (to !== lock) return rename(from, to);
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    throw denied;
  };
  try {
    const compete = () => withCompanyMirrorRetentionLock(root, async () => assert.fail(), { waitMs: 0 });
    assert.deepEqual(await compete(), { skipped: 'busy' });
    assert.deepEqual(await fs.readdir(lock), [`${process.pid}-${id}.json`]);
    Object.defineProperty(process, 'platform', platform);
    await fs.rm(lock, { recursive: true });
    await assert.rejects(compete(), error => error === denied);
  } finally {
    fs.rename = rename;
    Object.defineProperty(process, 'platform', platform);
  }
});

test('Windows sharing refusal releases only the same empty atomic claim without replaying the operation', async t => {
  const f = await fixture(t);
  const root = await f.schema(MIRROR_SCHEMA_VERSION, 1);
  const lock = path.join(root, 'retention.lock');
  const rmdir = fs.rmdir, platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const denied = Object.assign(new Error('synthetic release sharing refusal'), { code: 'EPERM' });
  let operations = 0;
  const run = () => withCompanyMirrorRetentionLock(root, async () => { operations++; return 'done'; });
  for (const scenario of ['transient', 'successor', 'persistent']) {
    let removals = 0;
    const successor = `${process.pid}-${randomUUID()}.json`;
    fs.rmdir = async (target, ...args) => {
      if (target !== lock) return rmdir(target, ...args);
      removals++;
      assert.deepEqual(await fs.readdir(lock), [], 'the completed owner removed only its own nonce');
      if (scenario === 'transient' && removals === 2) return rmdir(target, ...args);
      if (scenario === 'successor') {
        // Keep the first inode allocated so the competing fixture has a
        // distinct identity even on filesystems with immediate inode reuse.
        await fs.rename(lock, path.join(root, 'released-claim'));
        await fs.mkdir(lock);
        await fs.writeFile(path.join(lock, successor), 'replacement');
      }
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      throw denied;
    };
    try {
      if (scenario === 'persistent') await assert.rejects(run(), error => error === denied);
      else assert.equal(await run(), 'done');
    } finally {
      fs.rmdir = rmdir;
      Object.defineProperty(process, 'platform', platform);
    }
    if (scenario === 'transient') {
      assert.equal(removals, 2);
      await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
    } else if (scenario === 'successor') {
      assert.equal(removals, 1);
      assert.deepEqual(await fs.readdir(lock), [successor]);
      await fs.unlink(path.join(lock, successor));
      await rmdir(lock);
    } else {
      assert.equal(removals, 6);
      assert.deepEqual(await fs.readdir(lock), []);
      await rmdir(lock);
    }
  }
  assert.equal(operations, 3);
});
