import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireBrowserMailLock } from '../host-runtime/scripts/trelio-browser-mail-lock.mjs';
import { prepareVisualPrivateDirectory } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { createVisualControlServer } from '../host-runtime/scripts/trelio-visual-session.mjs';
import { resolveWorkspaceBridgeConfigDirectory, writePrivateJsonFile } from '../host-runtime/scripts/trelio-workspace.mjs';
import { parseVisualSkillOutput, visualMcpResult } from '../host-runtime/scripts/trelio-visual-result.mjs';
import { ProtectedBrowserMailAttempt, normalizeBrowserMailSpec, parseBrowserMailHandle,
  browserMailActor } from '../host-runtime/scripts/trelio-browser-mail-auth.mjs';

// Public synthetic identifiers and OTP only; never a provider's real mail,
// sender, credentials, native state or private company content.
const identity = { origin: 'https://trelio.ru', companyId: '00000000-0000-4000-8000-000000000001', memberId: '00000000-0000-4000-8000-000000000002' };
const actor = { ...identity, accountId: '00000000-0000-4000-8000-000000000003', skillId: 'mail-fixture' };
const spec = { skillId: actor.skillId, sender: 'login@example.test', subjectIncludes: 'Sign in', bodyIncludes: 'Example account', digits: 6 };
const reference = { scope: 'a'.repeat(64), uidValidity: 10, uid: 21, revision: 'b'.repeat(64), originalSha256: 'c'.repeat(64) };
function fixture(overrides = {}) {
  let now = 100000, persisted, writes = 0, timer;
  const journal = {};
  const value = new ProtectedBrowserMailAttempt({ scope: 'd'.repeat(64), identity,
    mailAccountId: actor.accountId, spec, journal, requestedAt: now, expiresAt: now + 60000,
    now: () => now, active() {}, persist: async () => { persisted = structuredClone(journal); writes++; },
    setTimer: callback => { timer = callback; }, clearTimer() {}, ...overrides });
  return { value, journal, get persisted() { return persisted; }, get writes() { return writes; },
    async arm() { await value.begin(actor, value.handle, { scope: reference.scope, uidValidity: reference.uidValidity, lastUid: reference.uid - 1 }); },
    advance(ms) { now += ms; }, expire() { timer(); } };
}

test('literal signed matchers and opaque locators reject arbitrary code/paths/unknown fields', () => {
  assert.deepEqual(normalizeBrowserMailSpec(spec), spec);
  const f = fixture();
  assert.equal(parseBrowserMailHandle(f.value.handle).scope, 'd'.repeat(64));
  for (const value of ['../../owner.json', 'e'.repeat(100), `${'a'.repeat(64)}.not-a-uuid`]) assert.throws(() => parseBrowserMailHandle(value));
  for (const patch of [{ sender: 'someone@example.test\nBCC: secret' }, { regex: '.*' }, { digits: 4 }, { subjectIncludes: '' }, { skillId: '../mail' }]) {
    assert.throws(() => normalizeBrowserMailSpec({ ...spec, ...patch }));
  }
});

test('mail handles cross the closed MCP projection without matcher/code data or unsafe stdout fallback', () => {
  const f = fixture(), status = f.value.publicStatus();
  assert.deepEqual(parseVisualSkillOutput(JSON.stringify(status)), status);
  const mcp = visualMcpResult(status);
  assert.equal(JSON.parse(mcp.content[0].text).handle, status.handle);
  assert.equal(mcp.content.length, 1);
  assert.doesNotMatch(JSON.stringify(mcp), /login@example|123456|subjectIncludes|originalSha256/);
  for (const extra of [{ code: '123456' }, { sender: spec.sender }, { token: 'f'.repeat(64) }])
    assert.throws(() => parseVisualSkillOutput(JSON.stringify({ ...status, ...extra })), { code: 'VISUAL_RESULT_INVALID' });
});

test('host actor needs the same bound account/company/member; handle alone grants nothing', async () => {
  const f = fixture(); await f.value.start();
  const prepared = f.value.prepare(actor, f.value.handle);
  assert.equal(prepared.sender, spec.sender);
  for (const field of ['origin', 'companyId', 'memberId', 'accountId', 'skillId']) {
    assert.throws(() => f.value.prepare({ ...actor, [field]: 'foreign' }, f.value.handle), { code: 'authentication_mail_scope' });
  }
  assert.throws(() => f.value.prepare(actor, `${'e'.repeat(64)}.${f.journal.requestId}`));
  assert.throws(() => browserMailActor({}));
  assert.equal(browserMailActor({ TRELIO_SKILL_ID: actor.skillId, TRELIO_SKILL_COMPANY_ID: actor.companyId,
    TRELIO_SKILL_MEMBER_ID: actor.memberId, TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: actor.accountId, companyBinding: 'a'.repeat(64) }) }).accountId, actor.accountId);
});

test('private code releases once after durable source identity; only positive login grants exact Seen', async () => {
  const f = fixture(); await f.value.start();
  await f.arm();
  let received;
  const consume = f.value.code.then(code => { assert.equal(f.persisted.state, 'code_received'); received = code; });
  const pending = f.value.deliver(actor, f.value.handle, { code: '123456', reference });
  await consume;
  assert.equal(received, '123456');
  assert.doesNotMatch(JSON.stringify([f.value.publicStatus(), f.journal, f.persisted]), /123456|login@example/);
  await assert.rejects(f.value.deliver(actor, f.value.handle, { code: '654321', reference }), { code: 'authentication_mail_consumed' });
  await assert.rejects(f.value.claimAcknowledgement(actor, f.value.handle, reference), { code: 'authentication_mail_not_verified' });
  await f.value.finish(true);
  assert.equal((await pending).authenticated, true);
  assert.equal((await f.value.claimAcknowledgement(actor, f.value.handle, reference)).action, 'mark_seen_once');
  assert.equal(f.persisted.acknowledgement, 'pending', 'fence is durable before any mailbox STORE');
  assert.equal((await f.value.claimAcknowledgement(actor, f.value.handle, reference)).action, 'verify_only');
  await f.value.recordAcknowledgement(actor, f.value.handle, { seenVerified: true, writeAttempted: true });
  assert.equal((await f.value.claimAcknowledgement(actor, f.value.handle, reference)).action, 'none');
});

test('wrong source identity, refused code and expired/cancelled input never authorize read-state changes', async () => {
  for (const outcome of ['refused', 'expired', 'cancelled']) {
    const f = fixture(); await f.value.start();
    await f.arm();
    const pending = f.value.deliver(actor, f.value.handle, { code: '123456', reference });
    await f.value.code;
    if (outcome === 'refused') await f.value.finish(false);
    else if (outcome === 'expired') { f.advance(60000); f.expire(); }
    else f.value.cancel();
    assert.equal((await pending).authenticated, false);
    await assert.rejects(f.value.claimAcknowledgement(actor, f.value.handle, reference));
    assert.equal(f.journal.acknowledgement, 'none');
  }
  const f = fixture(); await f.value.start();
  await f.arm();
  const pending = f.value.deliver(actor, f.value.handle, { code: '123456', reference });
  await f.value.code; await f.value.finish(true); await pending;
  for (const key of ['uid', 'uidValidity', 'scope', 'revision', 'originalSha256']) {
    await assert.rejects(f.value.claimAcknowledgement(actor, f.value.handle,
      { ...reference, [key]: typeof reference[key] === 'number' ? reference[key] + 1 : 'f'.repeat(64) }));
  }
  assert.equal(f.journal.acknowledgement, 'none');
});

test('lost acknowledgement and expired grant permit read-back, never another write', async () => {
  const f = fixture(); await f.value.start();
  await f.arm();
  const pending = f.value.deliver(actor, f.value.handle, { code: '123456', reference });
  await f.value.code; await f.value.finish(true); await pending;
  assert.equal((await f.value.claimAcknowledgement(actor, f.value.handle, reference)).action, 'mark_seen_once');
  await f.value.recordAcknowledgement(actor, f.value.handle, { seenVerified: false, writeAttempted: true });
  assert.equal((await f.value.claimAcknowledgement(actor, f.value.handle, reference)).action, 'verify_only');
  f.advance(60000);
  assert.equal((await f.value.claimAcknowledgement(actor, f.value.handle, reference)).action, 'verify_only');
  await f.value.recordAcknowledgement(actor, f.value.handle, { seenVerified: true, writeAttempted: false });
  assert.equal(f.persisted.acknowledgement, 'complete');
});

test('failed durable writes cannot release code or approve a successful-mail acknowledgement', async () => {
  let deny = false;
  const f = fixture({ persist: async () => { if (deny) throw Error('synthetic storage failure'); } });
  await f.value.start(); await f.arm(); deny = true;
  await assert.rejects(f.value.deliver(actor, f.value.handle, { code: '123456', reference }));
  await assert.rejects(f.value.code);
  await assert.rejects(f.value.claimAcknowledgement(actor, f.value.handle, reference));
  const g = fixture({ persist: async () => { if (deny) throw Error('synthetic storage failure'); } });
  deny = false; await g.value.start(); await g.arm();
  const pending = g.value.deliver(actor, g.value.handle, { code: '123456', reference });
  await g.value.code; deny = true;
  await assert.rejects(g.value.finish(true));
  assert.equal((await pending).authenticated, false);
  await assert.rejects(g.value.claimAcknowledgement(actor, g.value.handle, reference));
});

test('mailbox baseline is durable before browser input and excludes old/same-second UIDs', async () => {
  const f = fixture(); await f.value.start();
  let allowed = false;
  f.value.ready.then(() => { allowed = true; assert.equal(f.persisted.state, 'armed'); });
  await assert.rejects(f.value.deliver(actor, f.value.handle, { code: '123456', reference }));
  assert.equal(allowed, false);
  await f.arm(); await f.value.ready;
  assert.equal(allowed, true);
  for (const patch of [{ uid: reference.uid - 1 }, { uidValidity: 11 }, { scope: 'e'.repeat(64) }])
    await assert.rejects(f.value.deliver(actor, f.value.handle, { code: '123456', reference: { ...reference, ...patch } }));
  assert.equal(f.journal.state, 'armed');
  f.value.cancel();
});

test('one native mailbox cannot serve concurrent browser attempts; expiry never lets the old owner delete its successor', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mail-auth-lock-fixture-')));
  let now = 100000;
  const args = { directory, origin: 'https://example.test', mailSkillId: 'mail-fixture',
    mailAccountId: actor.accountId, browserScope: 'd'.repeat(64), expiresAt: now + 60000, now: () => now };
  let first, next;
  try {
    first = await acquireBrowserMailLock(args);
    await assert.rejects(acquireBrowserMailLock({ ...args, browserScope: 'e'.repeat(64) }), { code: 'authentication_mail_busy' });
    first.assertActive(); now += 60000;
    assert.throws(() => first.assertActive(), { code: 'authentication_mail_busy' });
    next = await acquireBrowserMailLock({ ...args, browserScope: 'e'.repeat(64), expiresAt: now + 60000 });
    await first.release();
    await assert.rejects(acquireBrowserMailLock({ ...args, expiresAt: now + 60000 }), { code: 'authentication_mail_busy' });
    next.assertActive(); await next.release();
    assert.deepEqual(await fs.readdir(path.join(directory, 'browser-mail-accounts')), []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('the actual Node private-stdin bridge preserves actor, does not start a browser and never returns the delivered code', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mail-auth-pipe-fixture-')));
  const f = fixture(), scope = 'd'.repeat(64);
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, LOCALAPPDATA: path.join(directory, 'AppData', 'Local'),
    TRELIO_ORIGIN: actor.origin, TRELIO_SKILL_ID: actor.skillId, TRELIO_SKILL_COMPANY_ID: actor.companyId, TRELIO_SKILL_MEMBER_ID: actor.memberId,
    TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({ id: actor.accountId, companyBinding: 'a'.repeat(64) }) };
  const calls = [];
  const server = createVisualControlServer({ token: 'f'.repeat(64), dispatch: () => { throw Error('public dispatch is forbidden'); },
    mailDispatch: async message => {
      calls.push(message.operation);
      if (message.operation === 'prepare') return { ok: true, ...f.value.prepare(message.actor, message.handle) };
      if (message.operation === 'begin') return { ok: true, ...await f.value.begin(message.actor, message.handle, message.payload) };
      if (message.operation === 'deliver') return { ok: true, ...await f.value.deliver(message.actor, message.handle, message.payload) };
      throw Error('unknown private operation');
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function invoke(message, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../host-runtime/scripts/trelio-browser-mail-bridge.mjs', import.meta.url))],
        { env: { ...env, ...extraEnv }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = [], stderr = [];
      child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(message));
    });
  }
  try {
    const active = path.join(resolveWorkspaceBridgeConfigDirectory({ environment: env, homeDirectory: directory }), 'visual-browser', scope, 'active');
    await prepareVisualPrivateDirectory(active);
    await writePrivateJsonFile(path.join(active, 'owner.json'), { scope, token: 'f'.repeat(64),
      deadlineAt: Date.now() + 60000, pid: process.pid, port: server.address().port });
    await f.value.start();
    const prepare = { operation: 'prepare', handle: f.value.handle };
    const foreign = await invoke(prepare, { TRELIO_SKILL_MEMBER_ID: '00000000-0000-4000-8000-000000000009' });
    assert.equal(foreign.code, 1); assert.equal(foreign.stderr, '');
    const accepted = await invoke(prepare);
    assert.equal(accepted.code, 0); assert.equal(accepted.stderr, '');
    assert.equal(JSON.parse(accepted.stdout).sender, spec.sender);
    const begun = await invoke({ operation: 'begin', handle: f.value.handle,
      payload: { scope: reference.scope, uidValidity: reference.uidValidity, lastUid: reference.uid - 1 } });
    assert.equal(JSON.parse(begun.stdout).armed, true);
    const outcome = f.value.code.then(() => f.value.finish(true));
    const delivered = await invoke({ operation: 'deliver', handle: f.value.handle, payload: { code: '123456', reference } });
    await outcome;
    assert.equal(delivered.code, 0); assert.equal(delivered.stderr, '');
    assert.equal(JSON.parse(delivered.stdout).authenticated, true);
    assert.doesNotMatch(delivered.stdout, /123456|SYNTHETIC|login@example/);
    assert.deepEqual(calls, ['prepare', 'prepare', 'begin', 'deliver']);
  } finally {
    f.value.cancel(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
