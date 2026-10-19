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
  try {
    assert.equal((await call('setup', { url: origin })).state, 'preparing');
    let status;
    for (let i = 0; i < 120; i++) {
      status = await call('status');
      if (status.state !== 'preparing') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(status.state, 'manual_input_required', status.reason);
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
  } finally {
    await call('close').catch(() => {}); await waitForClose(); await store.remove();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
