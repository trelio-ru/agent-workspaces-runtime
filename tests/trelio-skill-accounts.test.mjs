import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { accountScope, accountText, createAccountCatalogue, splitAccountArguments } from '../host-runtime/scripts/trelio-skill-accounts.mjs';
import { prepareSkillAccount, assertPrivatePathKind, ensurePrivateDirectory, readPrivateJsonFile, writePrivateJsonFile, buildAgentSkillRuntimeEnvironment } from '../host-runtime/scripts/trelio-workspace.mjs';

const company = crypto.randomUUID(), member = crypto.randomUUID(), connection = crypto.randomUUID();
const identity = { origin: 'https://example.test', skillId: 'example-skill', companyId: company,
  memberId: member, connectionId: connection };
const io = { checkDirectory: directory => assertPrivatePathKind(directory, "directory"), ensureDirectory: ensurePrivateDirectory, read: readPrivateJsonFile, write: writePrivateJsonFile };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-account-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, make: overrides => createAccountCatalogue({ directory,
    scope: accountScope({ ...identity, ...overrides }), io }) };
}

test('import is durable, does not move provider state or disclose its locator, and unbind survives retries', async t => {
  const { make } = await fixture(t), catalogue = make();
  let probes = 0;
  const discover = async () => { probes++; return [{ sourceKey: 'slot', scope: 'company', name: 'Работа',
    comment: 'Клиенты\r\nи поставщики', providerRef: 'opaque-existing-credential-locator' }]; };
  await catalogue.importOnce(discover);
  await catalogue.importOnce(discover);
  assert.equal(probes, 1);
  const list = await catalogue.list(), selected = await catalogue.select();
  assert.equal(selected.providerRef, 'opaque-existing-credential-locator');
  assert.equal(list.accounts[0].comment, 'Клиенты\nи поставщики');
  assert.equal(JSON.stringify(list).includes('opaque-existing'), false);
  await catalogue.change({ operation: 'unbind', id: selected.id, expectedRevision: list.revision });
  await catalogue.importOnce(discover);
  await assert.rejects(catalogue.select(), { code: 'ACCOUNT_SETUP_REQUIRED' });
  assert.equal(probes, 1);
});

test('shared personal catalogue requires an explicit company binding; defaults remain company-local', async t => {
  const { make } = await fixture(t), first = make(), second = make({ companyId: crypto.randomUUID(), memberId: crypto.randomUUID() });
  const id = crypto.randomUUID();
  await first.change({ operation: 'create', id, name: 'Личный', comment: 'По личным вопросам', expectedRevision: 0 });
  const list = await second.list();
  assert.equal(list.accounts[0].bound, false);
  await assert.rejects(second.select(id), { code: 'ACCOUNT_NOT_BOUND' });
  await second.change({ operation: 'bind', id, expectedRevision: list.revision });
  assert.equal((await second.select()).id, id);
  const next = crypto.randomUUID();
  await second.change({ operation: 'create', id: next, name: 'Другой', expectedRevision: (await second.list()).revision });
  await assert.rejects(second.select(), { code: 'ACCOUNT_SELECTION_REQUIRED' });
  assert.equal((await first.select()).id, id);
  await second.change({ operation: 'default', id: next, expectedRevision: (await second.list()).revision });
  assert.equal((await second.select()).id, next);
  assert.equal((await first.select()).id, id);
});

test('device imports reuse the same account; company imports never merge by label', async t => {
  const { make } = await fixture(t), first = make(), second = make({ companyId: crypto.randomUUID() });
  const entries = [{ sourceKey: 'mailbox-one', scope: 'device', name: 'Одинаково', comment: '', providerRef: 'mailbox-one' },
    { sourceKey: 'connection', scope: 'company', name: 'Одинаково', comment: '', providerRef: 'scoped-one' }];
  await first.importOnce(async () => entries);
  await second.importOnce(async () => entries);
  assert.equal((await second.list()).accounts.length, 3);
  assert.equal((await second.list()).accounts.filter(a => a.bound).length, 1);
});

test('a new device account cannot be re-imported or auto-enabled in the next company', async t => {
  const { make } = await fixture(t), first = make(), second = make({ companyId: crypto.randomUUID() });
  const id = crypto.randomUUID();
  await first.change({ operation: 'create', id, name: 'Новая почта', expectedRevision: 0 });
  // New email mailboxes are keyed by the selected UUID in the same TOML that
  // the bounded legacy probe reads. The host recognizes that exact source ID.
  await second.importOnce(async () => [{ sourceKey: id, scope: 'device', name: id, comment: '', providerRef: id }]);
  const list = await second.list();
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].id, id);
  assert.equal(list.accounts[0].name, 'Новая почта');
  assert.equal(list.accounts[0].bound, false);
  await assert.rejects(second.select(id), { code: 'ACCOUNT_NOT_BOUND' });
});

test('failed import is retriable; parallel edits cannot silently overwrite each other', async t => {
  const { make } = await fixture(t), first = make(), second = make();
  await assert.rejects(first.importOnce(async () => { throw new Error('synthetic failure'); }));
  assert.equal((await first.list()).revision, 0);
  await first.importOnce(async () => []);
  const revision = (await first.list()).revision;
  const outcomes = await Promise.allSettled([first, second].map(c => c.change({ operation: 'create',
    id: crypto.randomUUID(), name: 'Аккаунт', expectedRevision: revision })));
  assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(v => v.status === 'rejected').reason.code, 'ACCOUNT_CATALOGUE_CONFLICT');
  assert.equal((await first.list()).accounts.length, 1);
});

test('unknown schema is preserved and rejected; comments and selector input are bounded', async t => {
  const { directory, make } = await fixture(t), catalogue = make();
  await catalogue.importOnce(async () => []);
  const file = path.join(directory, 'skill-accounts', `${accountScope(identity).catalogue}.json`);
  await writePrivateJsonFile(file, { schemaVersion: 999 });
  await assert.rejects(catalogue.list(), { code: 'ACCOUNT_CATALOGUE_INVALID' });
  assert.deepEqual(await readPrivateJsonFile(file), { schemaVersion: 999 });
  assert.equal(accountText('🙂'.repeat(2000), 2000).length, 4000);
  assert.throws(() => accountText('🙂'.repeat(2001), 2000));
  assert.throws(() => accountText('bad\0text', 2000));
  const id = crypto.randomUUID();
  assert.deepEqual(splitAccountArguments(['read', '--local-account', id, '--chat', 'Тест']),
    { accountId: id, providerArguments: ['read', '--chat', 'Тест'] });
  assert.throws(() => splitAccountArguments(['--local-account', id, '--local-account', id]));
});

test('inherited account state is stripped and signed opt-in is required', () => {
  const artifact = { skillId: 'example-skill', runtimeVersion: '1.0.0', parsedPackage: { capabilities: [] } };
  const executionContext = { companyId: company, releaseId: connection, localIdentity: { memberId: member },
    account: { id: crypto.randomUUID(), providerRef: null } };
  const options = { artifact, runtimeDirectory: '/test', executionContext,
    inheritedEnvironment: { TRELIO_SKILL_ACCOUNT_JSON: 'forged' } };
  assert.equal(buildAgentSkillRuntimeEnvironment(options).TRELIO_SKILL_ACCOUNT_JSON, undefined);
  artifact.parsedPackage.capabilities.push('local-accounts-v1');
  const env = buildAgentSkillRuntimeEnvironment(options);
  assert.deepEqual(JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON), executionContext.account);
  assert.equal(env.TRELIO_SKILL_COMPANY_ID, company);
});


test('host dispatch lists before setup, binds explicitly and removes only its account selector', async t => {
  const { directory } = await fixture(t), outputs = [];
  const artifact = { skillId: identity.skillId };
  const base = { origin: identity.origin, artifact, runtimeDirectory: directory, catalogueDirectory: directory,
    executionContext: { companyId: company, localIdentity: { memberId: member, connectionId: connection } },
    discover: async () => [], output: value => outputs.push(value) };
  assert.deepEqual(await prepareSkillAccount({ ...base, runtimeArguments: ['account', 'list'] }), { handled: true });
  const initial = outputs.at(-1), id = crypto.randomUUID();
  assert.equal(initial.accounts.length, 0);
  await prepareSkillAccount({ ...base, runtimeArguments: ['account', 'create', '--id', id, '--name', 'Рабочий',
    '--comment', 'Документы и счета', '--expected-revision', String(initial.revision)] });
  const selected = await prepareSkillAccount({ ...base, runtimeArguments: ['doctor', '--local-account', id] });
  assert.equal(selected.account.id, id);
  assert.deepEqual(selected.runtimeArguments, ['doctor']);
  const other = { ...base, executionContext: { companyId: crypto.randomUUID(), localIdentity: { memberId: crypto.randomUUID(), connectionId: null } } };
  await prepareSkillAccount({ ...other, runtimeArguments: ['accounts'] });
  assert.equal(outputs.at(-1).accounts[0].bound, false);
  await assert.rejects(prepareSkillAccount({ ...other, runtimeArguments: ['doctor', '--local-account', id] }), { code: 'ACCOUNT_NOT_BOUND' });
});

test('a confirmed dead writer is recovered without resetting imported accounts', async t => {
  const { directory, make } = await fixture(t), catalogue = make();
  const id = crypto.randomUUID();
  await catalogue.change({ operation: 'create', id, name: 'Сохранён', expectedRevision: 0 });
  const lock = path.join(directory, 'skill-accounts', `${accountScope(identity).catalogue}.lock`);
  await ensurePrivateDirectory(lock);
  await writePrivateJsonFile(path.join(lock, 'owner.json'), { pid: 2147483647, token: crypto.randomUUID() });
  await catalogue.change({ operation: 'update', id, comment: 'После сбоя', expectedRevision: 1 });
  assert.equal((await catalogue.select()).comment, 'После сбоя');
  await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
});

test('failed owner publication leaves an empty lock recoverable without resetting the catalogue', async t => {
  const { directory, make } = await fixture(t);
  const catalogue = createAccountCatalogue({ directory, scope: accountScope(identity), io: { ...io,
    ensureDirectory: async target => {
      if (target.endsWith('.lock')) throw new Error('synthetic ACL initialization failure');
      return io.ensureDirectory(target);
    },
  } });
  await assert.rejects(catalogue.importOnce(async () => []), /ACL initialization failure/);
  await make().importOnce(async () => []);
  assert.equal((await make().list()).revision, 1);
});

test('the real migration subprocess supports bounded Unicode metadata without a selected account', async t => {
  const { directory } = await fixture(t), outputs = [];
  const entrypoint = path.join(directory, 'probe.mjs');
  await fs.writeFile(entrypoint, `
    if (process.argv[2] !== '__trelio_accounts_import' || process.env.TRELIO_SKILL_ACCOUNT_JSON) process.exit(2);
    console.log(JSON.stringify({ schemaVersion: 1, accounts: Array.from({ length: 64 }, (_, i) => ({
      sourceKey: String(i), scope: 'device', name: '🙂'.repeat(120), comment: '🙂'.repeat(2000), providerRef: String(i),
    })) }));
  `);
  await prepareSkillAccount({ origin: identity.origin, catalogueDirectory: directory, runtimeDirectory: directory,
    artifact: { skillId: identity.skillId, runtimeVersion: '1.0.0',
      parsedPackage: { capabilities: ['local-session', 'local-accounts-v1'], entrypoint: { path: 'probe.mjs', interpreter: 'node' } } },
    executionContext: { companyId: company, localIdentity: { memberId: member, connectionId: connection } },
    runtimeArguments: ['account', 'list'], output: value => outputs.push(value) });
  assert.equal(outputs[0].accounts.length, 64);
  assert.equal([...outputs[0].accounts[0].comment].length, 2000);
});
