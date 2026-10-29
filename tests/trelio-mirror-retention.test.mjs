import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  pruneCompanyMirrorCaches, pruneMirrorSchema, withMirrorRetentionLock,
  MIRROR_READER_GRACE_MS, MIRROR_HISTORY_MAX_BYTES,
} from '../host-runtime/scripts/trelio-mirror-retention.mjs';
import { ensurePrivateDirectory, writePrivateJsonFile, resolveWorkspaceBridgeConfigDirectory } from '../host-runtime/scripts/trelio-workspace.mjs';
import { ProcessDiagnosticError } from '../host-runtime/scripts/trelio-process-diagnostics.mjs';
import { resolveMirrorPaths, syncCompanyContextMirror } from '../host-runtime/scripts/trelio-local-context.mjs';
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
        t.diagnostic(JSON.stringify({ fixture: 'dead_mirror_writer',
          stage: stages?.at(-1)?.split(':')[1] ?? null,
          exitCode: Number.isInteger(error.code) ? error.code : null,
          failures: failures ?? [] }));
        throw error;
      }
      assert.match(child.stdout, /DEAD_MIRROR_WRITER_VERIFIED/u);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
    return;
  }
  const origin = 'https://mirror.example', companyId = '11111111-1111-4111-8111-111111111111';
  console.log('MIRROR_DEAD_WRITER_STAGE:root');
  const paths = resolveMirrorPaths({ origin, companyId });
  await ensurePrivateDirectory(paths.root);
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { exited.once('error', reject); exited.once('close', resolve); });
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  console.log('MIRROR_DEAD_WRITER_STAGE:pid');
  const seed = async (pid, extra = {}) => {
    await ensurePrivateDirectory(paths.lock);
    const owner = { schemaVersion: 1, lockId: randomUUID(), pid,
      createdAt: new Date().toISOString(), ...extra };
    await writePrivateJsonFile(path.join(paths.lock, 'owner.json'), owner);
    await writePrivateJsonFile(path.join(paths.lock, `${owner.lockId}.heartbeat.json`),
      { schemaVersion: 1, lockId: owner.lockId });
    return owner;
  };
  const encryption = { runtime: { company: { id: companyId, slug: 'synthetic' },
    scope: { id: randomUUID(), epoch: 1 }, device: { id: randomUUID() } } };
  const previousFetch = globalThis.fetch;
  let reads = 0, held, entered;
  const refusal = new Error('SYNTHETIC_MIRROR_STOP');
  globalThis.fetch = async url => {
    assert.equal(new URL(url).pathname, '/api/agent-workspaces/company-context/synthetic/manifest');
    reads++; if (reads === 2) entered?.(); if (held) await held;
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
  await seed(exited.pid);
  console.log('MIRROR_DEAD_WRITER_STAGE:first');
  await assert.rejects(sync(AbortSignal.timeout(5_000)), error => error.cause === refusal);
  assert.equal(reads, 1, 'a fresh dead-owner heartbeat does not consume another sync budget');
  assert.equal(await fs.stat(paths.lock).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e)), null);

  // A live or malformed owner is never declared dead by elapsed clocks, a
  // partial read or a failed PID probe. Cancelling the waiter changes nothing.
  for (const [stage, seedClaim] of [['live', () => seed(process.pid)], ['malformed', () => seed(exited.pid, { schemaVersion: 99 })], ['unexpected', async () => {
    await seed(exited.pid); await fs.writeFile(path.join(paths.lock, 'unexpected'), 'synthetic');
  }]]) {
    console.log(`MIRROR_DEAD_WRITER_STAGE:${stage}`);
    await seedClaim();
    const before = await fs.readFile(path.join(paths.lock, 'owner.json'));
    const signal = AbortSignal.timeout(250);
    await assert.rejects(sync(signal), error => error === signal.reason);
    assert.deepEqual(await fs.readFile(path.join(paths.lock, 'owner.json')), before);
    assert.equal(reads, 1, 'a blocked waiter never reaches the manifest');
    await fs.rm(paths.lock, { recursive: true });
  }

  // Two fresh contenders may recover the same dead owner, but only one may
  // reach network work at a time. The loser must preserve the successor's lock.
  await seed(exited.pid);
  console.log('MIRROR_DEAD_WRITER_STAGE:concurrent');
  let release; held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const entering = new Promise(resolve => { entered = resolve; });
  const first = assert.rejects(sync(AbortSignal.timeout(5_000)), error => error.cause === refusal);
  await Promise.race([entering, first.then(() => { throw new Error('WRITER_DID_NOT_REACH_READER'); })]);
  console.log('MIRROR_DEAD_WRITER_STAGE:entered');
  const successor = JSON.parse(await observed(fs.readFile(path.join(paths.lock, 'owner.json'))));
  console.log('MIRROR_DEAD_WRITER_STAGE:owner');
  assert.equal(successor.pid, process.pid);
  const second = assert.rejects(sync(AbortSignal.timeout(5_000)), error => error.cause === refusal);
  console.log('MIRROR_DEAD_WRITER_STAGE:waiting');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(reads, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(paths.lock, 'owner.json'))).lockId, successor.lockId);
  release(); console.log('MIRROR_DEAD_WRITER_STAGE:released');
  await Promise.all([first, second]);
  console.log('MIRROR_DEAD_WRITER_STAGE:settled');
  assert.equal(reads, 3);
  assert.equal(await fs.stat(paths.pointer).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e)), null);
  // Deterministically reproduce the native inspection/release interleaving,
  // independently of Windows scheduler luck. Only this fixture's synthetic
  // sync.lock is changed. The native refusal remains the original Error object;
  // metadata proves release/replacement, never a permission/retry exemption.
  const originalLstat = fs.lstat;
  for (const mode of ['absent', 'replaced', 'unchanged']) {
    console.log(`MIRROR_DEAD_WRITER_STAGE:race_${mode}`);
    await seed(process.pid);
    const cancellation = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(5_000)]);
    let abortTimer;
    const privateRefusal = new ProcessDiagnosticError('TRELIO_WINDOWS_PRIVATE_ACL_FAILED',
      'Synthetic late private inspection refusal.', { operation: 'windows_acl.owner_read' });
    let injected = false;
    fs.lstat = async (...args) => {
      if (!injected && args[0] === path.join(paths.lock, 'owner.json')) {
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
      assert.equal(reads, 4, 'only a positively released claim permits the next manifest read');
      if (mode !== 'absent') {
        const owner = JSON.parse(await fs.readFile(path.join(paths.lock, 'owner.json')));
        assert.equal(owner.pid, process.pid, 'live/unchanged owner is never removed');
      }
    } finally {
      clearTimeout(abortTimer);
      fs.lstat = originalLstat;
      await fs.rm(paths.lock, { recursive: true, force: true });
    }
  }
  console.log('MIRROR_DEAD_WRITER_STAGE:verified');
  console.log('DEAD_MIRROR_WRITER_VERIFIED');
});

test('startup sweep prunes historical schemas including v1 without changing current pointers', async t => {
  const f = await fixture(t);
  for (const version of [1, 2, 4, 7, 8]) await f.schema(version);
  const report = await pruneCompanyMirrorCaches({ directory: f.directory });
  assert.equal(report.removedFiles, 30);
  for (const version of [1, 2, 4, 7, 8]) {
    const root = version === 1 ? f.companyRoot : path.join(f.companyRoot, `schema-${version}`);
    assert.deepEqual((await generations(root)).sort(), [name(7), name(8)].map(n => `${n}.json`));
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'current.json'))).generation, name(8));
  }
  assert.equal((await pruneCompanyMirrorCaches({ directory: f.directory })).skipped, 'interval');
});

test('active reader serializes cleanup until its immutable generation has been read', async t => {
  const f = await fixture(t); const root = await f.schema();
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const reading = withMirrorRetentionLock(root, async () => {
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
  const f = await fixture(t); const busy = await f.schema(7); const current = await f.schema(8);
  await fs.mkdir(path.join(busy, 'sync.lock'), { mode: 0o700 });
  const future = await f.schema(9);
  const report = await pruneCompanyMirrorCaches({ directory: f.directory });
  assert.equal(report.skippedSchemas, 1);
  assert.equal((await generations(busy)).length, 8);
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
  const entrypoint = fileURLToPath(new URL('../host-runtime/scripts/trelio-host-runtime-entry.mjs', import.meta.url));
  // --help exits without admission/network. Cleanup is the genuine detached
  // startup subprocess, not a test replacement for the production launcher.
  await exec(process.execPath, [entrypoint, 'bridge', '--help'], { env: environment });
  const deadline = Date.now() + 30_000;
  let state;
  while (Date.now() < deadline) {
    try { state = JSON.parse(await fs.readFile(path.join(cacheRoot, 'retention-state.json'))); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state?.removedFiles, 6);
  // Wait for the detached process to release its root lock before teardown.
  while (Date.now() < deadline) {
    try { await fs.lstat(path.join(cacheRoot, 'retention.lock')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('background maintenance did not release its lock');
});


test('independent processes serialize updates while lock directories repeatedly disappear', async t => {
  const f = await fixture(t); const root = await f.schema();
  const counter = path.join(root, 'counter.json');
  await fs.writeFile(counter, '0', { mode: 0o600 });
  const moduleUrl = new URL('../host-runtime/scripts/trelio-mirror-retention.mjs', import.meta.url).href;
  const source = `import fs from 'node:fs/promises';
    import { withMirrorRetentionLock } from ${JSON.stringify(moduleUrl)};
    for (let n = 0; n < 12; n++) {
      const result = await withMirrorRetentionLock(process.argv[1], async () => {
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
