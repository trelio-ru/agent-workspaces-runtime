import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { runVisualSession } from '../host-runtime/scripts/trelio-visual-session.mjs';
import { ProtectedVisualStore, visualStorageScope } from '../host-runtime/scripts/trelio-visual-store.mjs';
import { loadVisualDependencies } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { resolveVisualWorkerNode } from '../host-runtime/scripts/trelio-visual-node.mjs';

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
