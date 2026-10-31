import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { runVisualSession, withVisualOwnerFileLock, readVisualOwner,
  publishVisualWorkerOwner } from '../host-runtime/scripts/trelio-visual-session.mjs';
import { ProtectedVisualStore, visualStorageScope } from '../host-runtime/scripts/trelio-visual-store.mjs';
import { loadVisualDependencies } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { resolveVisualWorkerNode } from '../host-runtime/scripts/trelio-visual-node.mjs';
import { PROCESS_DIAGNOSTIC_CODES, ProcessDiagnosticError, parseProcessDiagnostic,
  processDiagnosticCauseCode } from '../host-runtime/scripts/trelio-process-diagnostics.mjs';
import { readPrivateJsonFile, writePrivateJsonFile } from '../host-runtime/scripts/trelio-workspace.mjs';

test('an unsafe owner mutex root refuses before its operation without replacing the existing entry', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-owner-unsafe-test-')));
  const file = path.join(directory, 'active', 'owner.json'), root = path.join(directory, 'owner-control');
  let entered = false;
  try {
    await fs.writeFile(root, 'synthetic existing entry', { mode: 0o600 });
    await assert.rejects(withVisualOwnerFileLock(file, () => { entered = true; }), /VISUAL_STORAGE_UNSAFE/);
    assert.equal(entered, false);
    assert.equal(await fs.readFile(root, 'utf8'), 'synthetic existing entry');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('owner publication waits for the original reader, rechecks the claim and never changes its lease', { timeout: 60000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-owner-mutex-test-')));
  const active = path.join(directory, 'active'), file = path.join(active, 'owner.json');
  await fs.mkdir(active, { mode: 0o700 });
  const owner = { schemaVersion: 1, token: 'a'.repeat(64), bindingHash: 'b'.repeat(64),
    scope: 'c'.repeat(64), pid: process.pid, deadlineAt: Date.now() + 120000 };
  let releaseReader, signalReader, rejectReader, reader;
  const held = new Promise(resolve => { releaseReader = resolve; });
  const opened = new Promise((resolve, reject) => { signalReader = resolve; rejectReader = reject; });
  let reading, publishing;
  try {
    await withVisualOwnerFileLock(file, () => writePrivateJsonFile(file, owner));
    await assert.rejects(publishVisualWorkerOwner(file, owner, { pid: process.pid, port: 12345,
      deadlineAt: Date.now() + 240000 }), /VISUAL_IDENTITY_INVALID/);
    assert.deepEqual(await readVisualOwner(file), owner, 'publication cannot accept a lease override');
    reading = withVisualOwnerFileLock(file, async () => {
      reader = await fs.open(file, 'r');
      signalReader();
      try {
        await held;
        assert.deepEqual(JSON.parse(await reader.readFile('utf8')), owner);
      } finally { await reader.close(); reader = null; }
    });
    // Fail the original test normally if native preparation fails before the
    // handoff; do not leave a never-resolved startup barrier/owned directory.
    reading.catch(rejectReader);
    await opened;
    // A suspended/slow LIVE reader must not be evicted by an age-based stale
    // lock timeout. Reuse the existing PID/nonce mutex's native guarantee.
    const old = new Date(0);
    await fs.utimes(path.join(directory, 'owner-control', 'retention.lock'), old, old);
    let settled = false;
    publishing = publishVisualWorkerOwner(file, owner, { pid: process.pid, port: 12345 })
      .finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(settled, false, 'publication cannot overlap an open participating read handle');
    releaseReader(); await reading; await publishing;
    const published = { ...owner, pid: process.pid, port: 12345 };
    assert.deepEqual(await readVisualOwner(file), published);
    await assert.rejects(publishVisualWorkerOwner(file, published, { pid: process.pid, port: 12346 }), /VISUAL_IDENTITY_INVALID/,
      'a published descriptor cannot become a fresh publication baseline');
    // A replacement identity is a conflict, never a new baseline for retry.
    await assert.rejects(publishVisualWorkerOwner(file, owner, { pid: process.pid, port: 12346 }), /VISUAL_IDENTITY_INVALID/);
    assert.deepEqual(await readVisualOwner(file), published);
    const expired = { ...owner, deadlineAt: Date.now() - 1 };
    await withVisualOwnerFileLock(file, () => writePrivateJsonFile(file, expired));
    await assert.rejects(publishVisualWorkerOwner(file, expired, { pid: process.pid, port: 12345 }), /VISUAL_IDENTITY_INVALID/);
    assert.deepEqual(await readVisualOwner(file), expired);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['active', 'owner-control']);
    assert.deepEqual(await fs.readdir(path.join(directory, 'owner-control')), [],
      'the shared mutex leaves no second journal or persistent ownership record');
  } finally {
    releaseReader(); await reading?.catch(() => {}); await publishing?.catch(() => {});
    await reader?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native Windows characterizes atomic descriptor publication while the original reader is open', {
  skip: process.platform !== 'win32' || process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 20000,
}, async t => {
  // The detached parent's startup poll reads this SAME private writer's file.
  // Keep one ordinary native read handle open deliberately, rather than infer
  // Windows sharing semantics from an intermittent startup failure. These are
  // disposable structural counters, never a real owner/bearer/credential.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-owner-publish-fixture-'));
  const file = path.join(directory, 'owner.json');
  let reader, blocked = null;
  try {
    await writePrivateJsonFile(file, { version: 1 });
    reader = await fs.open(file, 'r');
    try { await writePrivateJsonFile(file, { version: 2 }); }
    catch (error) {
      blocked = { code: error.code, syscall: error.syscall };
      // A native refusal is characterized, not swallowed as a successful write.
      // Every other failure remains a hard error without exposing raw paths.
      assert.deepEqual(blocked, { code: 'EPERM', syscall: 'rename' });
      assert.deepEqual(await readPrivateJsonFile(file), { version: 1 });
    }
    assert.deepEqual(JSON.parse(await reader.readFile('utf8')), { version: 1 });
    await reader.close(); reader = null;
    await writePrivateJsonFile(file, { version: 2 });
    assert.deepEqual(await readPrivateJsonFile(file), { version: 2 });
    t.diagnostic(JSON.stringify({ publicationWithReader: blocked ? 'rename_access_denied' : 'published' }));
  } finally {
    await reader?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('synthetic startup evidence retains closed native failure categories and drops arbitrary error/owner data',async()=>{
  const source=await fs.readFile(new URL('../host-runtime/scripts/trelio-visual-worker.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function fixtureDiagnostic(value) {'),end=source.indexOf('\nasync function stop()',start);
  assert.ok(start>=0&&end>start);
  const snapshots=[];
  const scope={fixtureOnly:true,fixtureEvidence:[],fixtureWrites:Promise.resolve(),
    PROCESS_DIAGNOSTIC_CODES,ProcessDiagnosticError,parseProcessDiagnostic,processDiagnosticCauseCode,path,owner:{directory:os.tmpdir()},
    writePrivateJsonFile:async(_file,value)=>snapshots.push(JSON.parse(JSON.stringify(value)))};
  vm.createContext(scope);vm.runInContext(source.slice(start,end),scope);
  scope.input={stage:'startup_failed',startupPhase:'owner_publish',failureCode:'TRELIO_WINDOWS_PRIVATE_ACL_FAILED',
    causeCode:'EACCES',message:'SYNTHETIC PRIVATE MESSAGE',stack:'PRIVATE STACK',token:'PRIVATE BEARER',owner:{token:'PRIVATE'}};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1),{evidence:[{stage:'startup_failed',startupPhase:'owner_publish',
    failureCode:'TRELIO_WINDOWS_PRIVATE_ACL_FAILED',causeCode:'EACCES'}]});
  scope.input={stage:'startup_failed',startupPhase:'PRIVATE',failureCode:'PRIVATE',causeCode:'PRIVATE'};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'startup_failed'});
  scope.input={stage:'startup_failed',error:new ProcessDiagnosticError('TRELIO_WINDOWS_PRIVATE_ACL_FAILED',
    'SYNTHETIC PRIVATE MESSAGE',{operation:'windows_acl.dacl_write',causeCode:'EACCES',path:'PRIVATE'})};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'startup_failed',process:{
    failureCode:'TRELIO_WINDOWS_PRIVATE_ACL_FAILED',operation:'windows_acl.dacl_write',causeCode:'EACCES'}});
  scope.input={stage:'startup_failed',startupPhase:'owner_publish',error:{
    syscall:'rename',path:'PRIVATE PATH',dest:'PRIVATE DESTINATION',message:'PRIVATE ERROR'}};
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.deepEqual(snapshots.at(-1).evidence.at(-1),{
    stage:'startup_failed',startupPhase:'owner_publish',ioOperation:'rename'});
  for(const [startupPhase,syscall] of [['owner_publish','PRIVATE SYSCALL'],['browser','rename']]) {
    scope.input={stage:'startup_failed',startupPhase,error:{syscall,message:'PRIVATE ERROR'}};
    vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
    assert.deepEqual(snapshots.at(-1).evidence.at(-1),{stage:'startup_failed',startupPhase});
  }
  scope.fixtureOnly=false;const count=snapshots.length;
  vm.runInContext('fixtureDiagnostic(input)',scope);await scope.fixtureWrites;
  assert.equal(snapshots.length,count,'ordinary production never writes fixture evidence');
});

const signingPolicy = compatible => ({ status: 0, stdout: compatible
  ? '<key>com.apple.security.cs.disable-library-validation</key>\n<true/>' : '',
stderr: 'flags=0x10000(runtime)' });
const nodeFixture = overrides => ({ platform: 'darwin', executable: '/app/node',
  home: '/user', arch: 'arm64', uid: 501, now: () => 0,
  realpath: value => value, stat: () => ({ isFile: () => true, mode: 0o100755, uid: 501 }),
  ...overrides });

test('visual worker keeps the current binary outside macOS without probing executable candidates', () => {
  for (const platform of ['win32', 'linux']) assert.equal(resolveVisualWorkerNode(nodeFixture({ platform,
    run() { throw new Error('unexpected native probe'); } })), '/app/node');
});

test('compatible current macOS Node needs no replacement or signing mutation', () => {
  for (const response of [signingPolicy(true), { status: 0, stderr: 'flags=0x2(adhoc)' },
    { status: 1, stderr: 'code object is not signed at all' }]) {
    const calls = [];
    assert.equal(resolveVisualWorkerNode(nodeFixture({ run: (file, args, options) => {
      calls.push([file, args]); assert.equal(options.shell, false); return response;
    } })), '/app/node');
    assert.deepEqual(calls, [['/usr/bin/codesign', ['-dvv', '--entitlements', ':-', '/app/node']]]);
  }
});

test('restricted embedded Node selects an owner-checked compatible standalone with matching architecture', () => {
  const selected = '/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node';
  const calls = [];
  assert.equal(resolveVisualWorkerNode(nodeFixture({ run: (file, args, options) => {
    calls.push([file, args]); assert.equal(options.shell, false);
    assert.deepEqual(options.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
    assert.ok(options.timeout > 0 && options.timeout <= 1500);
    if (file === '/usr/bin/codesign') return signingPolicy(args.at(-1) !== '/app/node');
    assert.equal(file, selected);
    return { status: 0, stdout: JSON.stringify({ major: 26, platform: 'darwin', arch: 'arm64' }) };
  } })), selected);
  assert.equal(calls.length, 3);
});

for (const refusal of ['writable', 'foreign-owner', 'not-file', 'old-node', 'wrong-arch', 'wrong-platform', 'unknown-signature', 'failed-probe']) {
  test(`unsafe/incompatible standalone Node is not selected: ${refusal}`, () => {
    assert.throws(() => resolveVisualWorkerNode(nodeFixture({
      stat: () => ({ isFile: () => refusal !== 'not-file', mode: refusal === 'writable' ? 0o100777 : 0o100755,
        uid: refusal === 'foreign-owner' ? 502 : 501 }),
      run: (file, args) => {
        if (file === '/usr/bin/codesign') return args.at(-1) === '/app/node' ? signingPolicy(false)
          : refusal === 'unknown-signature' ? { status: 1, stderr: 'unverified signing state' } : signingPolicy(true);
        return refusal === 'failed-probe' ? { status: 1 } : { status: 0, stdout: JSON.stringify({
          major: refusal === 'old-node' ? 21 : 26, platform: refusal === 'wrong-platform' ? 'linux' : 'darwin',
          arch: refusal === 'wrong-arch' ? 'x64' : 'arm64' }) };
      },
    })), { code: 'VISUAL_BOOTSTRAP_NODE_REQUIRED' });
  });
}

test('all signing and version discovery shares one non-sliding deadline', () => {
  let clock = 0, probes = 0;
  assert.throws(() => resolveVisualWorkerNode(nodeFixture({ now: () => clock,
    run: () => { probes++; clock = 5001; return signingPolicy(false); },
  })), { code: 'VISUAL_BOOTSTRAP_NODE_REQUIRED' });
  assert.equal(probes, 1);
});

test('detached worker keeps its original lease and encrypted storage across short calls', { skip: process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 180_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-worker-test-')));
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><body style="background:#45cc77;height:1800px">Synthetic visual fixture</body>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const start = Date.now();
  const env = { TRELIO_ORIGIN: 'https://example.test', TRELIO_SKILL_ID: 'synthetic-visual-fixture', TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: randomUUID() }), TRELIO_SKILL_COMPANY_ID: randomUUID(), TRELIO_SKILL_MEMBER_ID: randomUUID(), TRELIO_BROWSER_SESSION_POLICY_JSON: JSON.stringify({ apiVersion: 1, sessionClass: 'protected-snapshot', manualAssist: true, leaseMs: 150_000 }), TRELIO_BROWSER_SESSION_STARTED_AT: String(start), TRELIO_BROWSER_SESSION_DEADLINE_AT: String(start + 150_000) };
  const call = (operation, args = {}) => runVisualSession({ origins: [origin], operation, args, env, fixture: { directory, headless: process.env.TRELIO_VISUAL_FIXTURE_HEADLESS === '1' } });
  const scope = visualStorageScope({ origin: 'https://example.test', skillId: env.TRELIO_SKILL_ID, accountId: JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON).id });
  const { AsyncEntry } = await loadVisualDependencies();
  const store = new ProtectedVisualStore({ directory, scope, AsyncEntry });
  const waitForClose = async () => {
    for (let i = 0; i < 160; i++) {
      if (!await fs.stat(path.join(store.directory, 'active')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Synthetic worker did not close within cleanup deadline');
  };
  let failure;
  try {
    assert.equal((await call('setup', { url: origin })).state, 'preparing');
    let status;
    for (let i = 0; i < 120; i++) {
      status = await call('status');
      if (status.state !== 'preparing') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(status.state, 'manual_input_required', JSON.stringify({ reason: status.reason, diagnostic: await fs.readFile(path.join(directory, 'fixture-diagnostic.json'), 'utf8').catch(() => '') }));
    assert.equal((await call('screenshot')).reason, 'manual_control_active');
    assert.equal((await call('ready')).state, 'saved_unverified');
    const frame = await call('navigate', { url: origin });
    assert.equal(frame.state, 'ready', JSON.stringify({ reason: frame.reason, diagnostic: await fs.readFile(path.join(directory, 'fixture-diagnostic.json'), 'utf8').catch(() => '') })); assert.ok(frame.image);
    const next = await call('scroll', { frameId: frame.frameId, x: 300, y: 300, deltaY: 500 });
    assert.equal(next.state, 'ready', JSON.stringify({ next, diagnostic: await fs.readFile(path.join(directory, 'fixture-diagnostic.json'), 'utf8').catch(() => '') }));
    assert.equal(next.scroll.up, true);
    assert.equal((await call('scroll', { frameId: frame.frameId, x: 300, y: 300, deltaY: 500 })).reason, 'stale_frame');
    assert.equal((await call('close')).state, 'closed');
    // Close is acknowledged before its bounded cleanup, so wait for the exact
    // claim to disappear before removing this synthetic key and directory.
    await waitForClose();
    assert.ok(await store.read());
    // Exercise the REAL detached entrypoint and repeated public observations
    // after a deterministic pre-browser failure. Never corrupt a real account
    // or unlock the synthetic vault again: malformed envelope shape is refused
    // before key access, and the original bytes must remain untouched.
    await writePrivateJsonFile(store.file, { format: 'SYNTHETIC_INVALID_ENVELOPE' });
    const rejectedBytes = await fs.readFile(store.file);
    assert.equal((await call('navigate', { url: origin })).state, 'preparing');
    let failed;
    for (let i = 0; i < 120; i++) {
      failed = await call('status');
      if (failed.state !== 'preparing') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(failed.state, 'error');
    assert.deepEqual(failed.diagnostic, { stage: 'storage_read', code: 'storage_corrupt' });
    assert.deepEqual((await call('wait')).diagnostic, failed.diagnostic);
    assert.deepEqual((await call('status')).diagnostic, failed.diagnostic);
    assert.deepEqual(await fs.readFile(store.file), rejectedBytes, 'diagnosis never resets damaged auth state');
    await call('close'); await waitForClose();
  } catch (error) { failure = error; }
  finally {
    let stopped = false, diagnostic = '';
    try {
      await call('close'); await waitForClose(); stopped = true; await store.remove();
    } catch (error) {
      // A failed shutdown must neither mask the ORIGINAL browser assertion nor
      // leave this test's HTTP listener alive until the hosted job is killed.
      // Keep the private directory/key if a worker still owns its claim: test
      // cleanup is not permission to erase an active profile or kill a disk PID.
      failure ||= error;
    } finally {
      store.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (failure) diagnostic = await fs.readFile(path.join(directory, 'fixture-diagnostic.json'), 'utf8').catch(() => '');
      if (stopped) await fs.rm(directory, { recursive: true, force: true });
    }
    if (failure) {
      // This synthetic worker writes only closed, allowlisted stages. Never
      // dump owner.json: it includes the private control bearer token.
      failure.message += `; synthetic worker evidence: ${diagnostic || 'unavailable'}`;
      throw failure;
    }
  }
});
