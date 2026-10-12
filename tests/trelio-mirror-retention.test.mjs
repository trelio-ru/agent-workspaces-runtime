import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  pruneCompanyMirrorCaches, pruneMirrorSchema, withMirrorRetentionLock,
  MIRROR_READER_GRACE_MS, MIRROR_HISTORY_MAX_BYTES,
} from '../host-runtime/scripts/trelio-mirror-retention.mjs';
import { ensurePrivateDirectory, writePrivateJsonFile, resolveWorkspaceBridgeConfigDirectory } from '../host-runtime/scripts/trelio-workspace.mjs';
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
  await writePrivateJsonFile(path.join(lock, `${id}.json`), { id, pid: Number(stdout) });
  assert.equal(await withMirrorRetentionLock(root, async () => 'recovered'), 'recovered');
  await ensurePrivateDirectory(lock);
  await writePrivateJsonFile(path.join(lock, `${id}.json`), { id, pid: process.pid });
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
