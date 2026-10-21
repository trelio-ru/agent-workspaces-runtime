import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { accountScope, accountText, createAccountCatalogue, splitAccountArguments, SkillAccountImportError } from '../host-runtime/scripts/trelio-skill-accounts.mjs';
import { prepareSkillAccount, runMaterializedAgentSkill, assertPrivatePathKind, ensurePrivateDirectory, readPrivateJsonFile, writePrivateJsonFile, buildAgentSkillRuntimeEnvironment, formatBridgeCommandError } from '../host-runtime/scripts/trelio-workspace.mjs';
import { ProcessDiagnosticError } from '../host-runtime/scripts/trelio-process-diagnostics.mjs';

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

test('native empty-account intent is atomic with creation and survives a lost write response without duplication',async t=>{
  const {directory,make}=await fixture(t),accountId=crypto.randomUUID(),requestId=crypto.randomUUID();
  let writes=0;
  const catalogue=createAccountCatalogue({directory,scope:accountScope(identity),io:{...io,write:async(file,value)=>{
    await io.write(file,value);
    if(value.schemaVersion===1&&Array.isArray(value.accounts)){
      writes++;throw new Error('synthetic response lost after atomic publication');
    }
  }}});
  const intent={operation:'create',id:accountId,name:'Empty account',expectedRevision:0,creationRequestId:requestId};
  await assert.rejects(catalogue.change(intent),/synthetic response lost/);
  const recovered=make();
  assert.deepEqual(await recovered.change(intent),{id:accountId,replayed:true});
  assert.equal(writes,1);assert.equal((await recovered.list()).revision,1);
  assert.equal((await recovered.list()).accounts.length,1);
  assert.equal((await recovered.select(accountId)).providerRef,null);
  assert.equal((await recovered.select(accountId)).creation,undefined,'receipt is not provider environment');
  assert.ok(!JSON.stringify(await recovered.list()).includes(requestId),'receipt is not an ordinary account-list field');
});

test('native create replay cannot adopt old accounts, alter metadata, cross bindings or reuse one intent for another id',async t=>{
  const {make}=await fixture(t),catalogue=make(),accountId=crypto.randomUUID(),requestId=crypto.randomUUID();
  const intent={operation:'create',id:accountId,name:'Original',expectedRevision:0,creationRequestId:requestId};
  assert.deepEqual(await catalogue.change(intent),{id:accountId,replayed:false});
  await catalogue.change({operation:'update',id:accountId,name:'Owner renamed',expectedRevision:1});
  assert.deepEqual(await catalogue.change(intent),{id:accountId,replayed:true});
  assert.equal((await catalogue.list()).revision,2);assert.equal((await catalogue.select()).name,'Owner renamed');
  await assert.rejects(catalogue.change({...intent,name:'Changed intent'}),error=>error.code==='ACCOUNT_ID_CONFLICT');
  await assert.rejects(catalogue.change({...intent,id:crypto.randomUUID()}),error=>error.code==='ACCOUNT_ID_CONFLICT');
  const other=make({companyId:crypto.randomUUID()});
  await assert.rejects(other.change(intent),error=>error.code==='ACCOUNT_ID_CONFLICT');
  const ordinaryId=crypto.randomUUID();
  await catalogue.change({operation:'create',id:ordinaryId,name:'Existing human-style account',expectedRevision:2});
  await assert.rejects(catalogue.change({...intent,id:ordinaryId,creationRequestId:crypto.randomUUID(),expectedRevision:3}),error=>error.code==='ACCOUNT_ID_CONFLICT');
  await catalogue.change({operation:'unbind',id:accountId,expectedRevision:3});
  await assert.rejects(catalogue.change(intent),error=>error.code==='ACCOUNT_NOT_BOUND');
  assert.equal((await catalogue.list()).revision,4,'refusals never rename, rebind or reset the catalogue');
});

test('concurrent identical native empty-account intents have one atomic creation and one read-back',async t=>{
  const {make}=await fixture(t),first=make(),second=make();
  const intent={operation:'create',id:crypto.randomUUID(),name:'One',expectedRevision:0,creationRequestId:crypto.randomUUID()};
  const results=await Promise.all([first.change(intent),second.change(intent)]);
  assert.deepEqual(results.map(row=>row.replayed).sort(),[false,true]);
  assert.equal((await first.list()).accounts.length,1);assert.equal((await first.list()).revision,1);
});

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
  const refusal = outcomes.find(v => v.status === 'rejected').reason;
  // Keep hosted failures diagnosable without logging a private path, the
  // exception message or provider state: this class carries closed dimensions.
  assert.equal(refusal.code, 'ACCOUNT_CATALOGUE_CONFLICT', refusal instanceof ProcessDiagnosticError
    ? JSON.stringify(refusal.details) : undefined);
  assert.equal((await first.list()).accounts.length, 1);
});

for (const stage of ['checkDirectory', 'read']) {
  test(`a released lock during private ${stage} validation reaches the revision conflict`, async t => {
    const { directory } = await fixture(t), scope = accountScope(identity);
    const file = path.join(directory, 'skill-accounts', `${scope.catalogue}.json`);
    const ownerFile = path.join(directory, 'skill-accounts', `${scope.catalogue}.lock`, 'owner.json');
    const ownerPublished = Promise.withResolvers(), contenderEntered = Promise.withResolvers();
    t.after(() => contenderEntered.resolve());
    const first = createAccountCatalogue({ directory, scope, io: { ...io,
      write: async (target, value) => {
        // Keep the first writer's lock present until the contender reaches the
        // exact protected read being tested; no scheduling/sleep guess is used.
        if (target === file) await contenderEntered.promise;
        await io.write(target, value);
        if (target === ownerFile) ownerPublished.resolve();
      },
    } });
    let firstWrite, injected = false;
    const second = createAccountCatalogue({ directory, scope, io: { ...io,
      [stage]: async (target, ...args) => {
        const contended = stage === 'read' ? target === ownerFile : target.endsWith('.lock');
        if (!contended || injected) return io[stage](target, ...args);
        injected = true;
        contenderEntered.resolve();
        await firstWrite;
        // The native worker uses this public hook code when the path vanished
        // after lstat but before its handle/ACL check. Verify the same condition
        // deterministically on every OS, as well as with the real Windows job.
        throw new ProcessDiagnosticError('TRELIO_WINDOWS_PRIVATE_ACL_FAILED', 'synthetic private path failure',
          { operation: 'windows_acl.owner_read' });
      },
    } });
    firstWrite = first.change({ operation: 'create', id: crypto.randomUUID(), name: 'Первый', expectedRevision: 0 });
    await ownerPublished.promise;
    await assert.rejects(second.change({ operation: 'create', id: crypto.randomUUID(), name: 'Второй', expectedRevision: 0 }),
      { code: 'ACCOUNT_CATALOGUE_CONFLICT' });
    await firstWrite;
    assert.equal((await first.list()).accounts.length, 1);
  });

  test(`private ${stage} failure with an existing lock preserves the original refusal`, async t => {
    const { directory } = await fixture(t), scope = accountScope(identity);
    const lock = path.join(directory, 'skill-accounts', `${scope.catalogue}.lock`);
    const owner = { pid: process.pid, token: crypto.randomUUID() };
    await ensurePrivateDirectory(lock);
    await writePrivateJsonFile(path.join(lock, 'owner.json'), owner);
    const failure = new ProcessDiagnosticError('TRELIO_WINDOWS_PRIVATE_ACL_FAILED', 'synthetic private path failure',
      { operation: 'windows_acl.owner_read' });
    const catalogue = createAccountCatalogue({ directory, scope, io: { ...io,
      [stage]: async () => { throw failure; },
    } });
    await assert.rejects(catalogue.change({ operation: 'create', id: crypto.randomUUID(), name: 'Отказ', expectedRevision: 0 }),
      error => error === failure);
    assert.deepEqual(await readPrivateJsonFile(path.join(lock, 'owner.json')), owner);
    await assert.rejects(fs.lstat(path.join(directory, 'skill-accounts', `${scope.catalogue}.json`)), { code: 'ENOENT' });
  });
}

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

test('account help is static and never imports, creates a catalogue or reads an existing path', async t => {
  const { directory } = await fixture(t), outputs = [];
  const operations = ['list', 'create', 'update', 'bind', 'unbind', 'default'];
  const commands = [['account'], ['account', '--help'], ['account', '-h'], ['account', 'help'],
    ...operations.flatMap(operation => [['account', operation, '--help'], ['account', operation, '-h'], ['account', 'help', operation]])];
  const base = { origin: identity.origin, artifact: { skillId: identity.skillId }, runtimeDirectory: directory,
    executionContext: { companyId: company, localIdentity: { memberId: member, connectionId: connection } },
    discover: () => assert.fail('help must not spawn the importer'), output: value => outputs.push(value) };
  // A non-directory root would refuse protected catalogue access. Help must
  // still work without inspecting or repairing that path or its private data.
  const occupied = path.join(directory, 'occupied');
  await fs.writeFile(occupied, 'PRIVATE_CANARY');
  for (const catalogueDirectory of [path.join(directory, 'absent'), occupied]) {
    for (const runtimeArguments of commands) {
      assert.deepEqual(await prepareSkillAccount({ ...base, catalogueDirectory, runtimeArguments }), { handled: true });
      const result = outputs.at(-1);
      assert.equal(result.ok, true);
      const operation = runtimeArguments[1] === 'help' ? runtimeArguments[2]
        : operations.includes(runtimeArguments[1]) ? runtimeArguments[1] : null;
      assert.equal(result.help.usage.length, operation ? 1 : operations.length);
      assert.ok(result.help.usage.every(usage => usage.startsWith(`account ${operation || ''}`)));
      assert.ok(result.help.notes.some(note => note.includes('account list') && note.includes('--expected-revision')));
      assert.equal(JSON.stringify(result).includes('PRIVATE_CANARY'), false);
    }
  }
  assert.deepEqual(await fs.readdir(directory), ['occupied']);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'PRIVATE_CANARY');
});

test('invalid account commands fail before import with precise codes and static syntax recovery', async t => {
  const { directory } = await fixture(t), id = crypto.randomUUID();
  const revision = ['--expected-revision', '0'];
  const invalid = [
    [['account', 'PRIVATE_CANARY'], 'ACCOUNT_OPERATION_INVALID'],
    [['account', 'PRIVATE_CANARY', ...revision], 'ACCOUNT_OPERATION_INVALID'],
    [['account', '--unknown'], 'ACCOUNT_OPERATION_INVALID'],
    [['account', 'help', 'PRIVATE_CANARY'], 'ACCOUNT_OPERATION_INVALID'],
    [['account', 'help', 'list', 'PRIVATE_CANARY'], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['account', 'list', ...revision], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['account', 'list', '--help', 'PRIVATE_CANARY'], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['accounts', 'PRIVATE_CANARY'], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['account', 'create', '--unknown', 'PRIVATE_CANARY'], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['account', 'create', '--name'], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['account', 'create', '--name', 'A', '--name', 'PRIVATE_CANARY', ...revision], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['account', 'create', '--name', 'A'], 'ACCOUNT_REVISION_REQUIRED'],
    ...['-1', '1.5', 'PRIVATE_CANARY', '9007199254740992'].map(value =>
      [['account', 'create', '--name', 'A', '--expected-revision', value], 'ACCOUNT_REVISION_REQUIRED']),
    [['account', 'create', ...revision], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['account', 'create', '--name', ' ', ...revision], 'ACCOUNT_TEXT_INVALID'],
    [['account', 'create', '--name', 'A', '--id', 'PRIVATE_CANARY', ...revision], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['account', 'update', '--id', id, ...revision], 'ACCOUNT_ARGUMENTS_INVALID'],
    [['account', 'update', '--name', 'A', ...revision], 'ACCOUNT_ARGUMENTS_INVALID'],
    ...['bind', 'unbind', 'default'].flatMap(operation => [
      [['account', operation, ...revision], 'ACCOUNT_ARGUMENTS_INVALID'],
      [['account', operation, '--id', id, '--name', 'PRIVATE_CANARY', ...revision], 'ACCOUNT_ARGUMENTS_INVALID'],
    ]),
    [['doctor', '--local-account', id, '--local-account', id], 'ACCOUNT_SELECTOR_INVALID'],
  ];
  for (const [runtimeArguments, code] of invalid) {
    await assert.rejects(prepareSkillAccount({ origin: identity.origin, artifact: { skillId: identity.skillId },
      runtimeDirectory: directory, catalogueDirectory: directory,
      executionContext: { companyId: company, localIdentity: { memberId: member, connectionId: connection } },
      runtimeArguments, discover: () => assert.fail('invalid input must not spawn the importer'),
      output: () => assert.fail('invalid input must not return success'),
    }), error => {
      assert.equal(error.code, code);
      const formatted = formatBridgeCommandError(error);
      assert.equal(formatted.includes('PRIVATE_CANARY'), false);
      if (code !== 'ACCOUNT_SELECTOR_INVALID') {
        const payload = JSON.parse(formatted);
        assert.equal(payload.code, code);
        assert.equal(payload.details.operation, 'account_command');
        assert.ok(payload.details.help.includes('--help'));
        assert.ok(payload.details.usage.length > 0);
      }
      return true;
    });
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('valid account commands retain metadata values, catalogue revision guards and company bindings', async t => {
  const { directory, make } = await fixture(t), outputs = [];
  let imports = 0;
  const run = runtimeArguments => prepareSkillAccount({ origin: identity.origin, artifact: { skillId: identity.skillId },
    runtimeDirectory: directory, catalogueDirectory: directory,
    executionContext: { companyId: company, localIdentity: { memberId: member, connectionId: connection } },
    runtimeArguments, discover: async () => { imports++; return []; }, output: value => outputs.push(value) });
  await run(['accounts']);
  const initial = outputs.at(-1), id = crypto.randomUUID();
  await run(['account', 'create', '--id', id, '--name', '--help', '--expected-revision', String(initial.revision)]);
  assert.equal(outputs.at(-1).accounts[0].name, '--help');
  const revision = outputs.at(-1).revision;
  await assert.rejects(run(['account', 'update', '--id', id, '--name', 'Stale', '--expected-revision', String(initial.revision)]),
    { code: 'ACCOUNT_CATALOGUE_CONFLICT' });
  assert.equal((await make().list()).revision, revision);
  await run(['account', 'update', '--id', id, '--comment', '', '--expected-revision', String(revision)]);
  for (const operation of ['unbind', 'bind', 'default']) {
    await run(['account', operation, '--id', id, '--expected-revision', String(outputs.at(-1).revision)]);
    assert.equal(outputs.at(-1).accounts[0].bound, operation !== 'unbind');
  }
  assert.equal(outputs.at(-1).accounts[0].default, true);
  assert.equal(imports, 1);
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

for (const [reason, source, extra] of [
  ['process_exit', "process.stderr.write('PRIVATE_CANARY'); process.exit(0xc0000005);",
    { exitCode: process.platform === 'win32' ? 0xc0000005 : 5 }],
  ['invalid_json', "process.stdout.write('PRIVATE_CANARY');", {}],
  ['invalid_envelope', "console.log(JSON.stringify({ schemaVersion: 999, accounts: [], private: 'PRIVATE_CANARY' }));", {}],
  ['output_limit', "process.stdout.write('PRIVATE_CANARY'.repeat(100000));", {}],
  ['process_timeout', "setTimeout(() => {}, 30000);", {}],
  ...(process.platform === 'win32' ? [] : [['process_signal', "process.kill(process.pid, 'SIGTERM');", { signal: 'SIGTERM' }]]),
]) {
  test(`real account import ${reason} stays private and cannot mark migration complete`, async t => {
    const { directory } = await fixture(t), outputs = [];
    const entrypoint = path.join(directory, 'probe.mjs');
    await fs.writeFile(entrypoint, source);
    const options = { origin: identity.origin, catalogueDirectory: directory, runtimeDirectory: directory,
      artifact: { skillId: identity.skillId, runtimeVersion: '1.0.0', parsedPackage: {
        capabilities: ['local-session', 'local-accounts-v1'], entrypoint: { path: 'probe.mjs', interpreter: 'node' },
      } }, executionContext: { companyId: company, localIdentity: { memberId: member, connectionId: connection } },
      runtimeArguments: ['account', 'list'], output: value => outputs.push(value) };
    await assert.rejects(prepareSkillAccount(options), error => {
      const payload = JSON.parse(formatBridgeCommandError(error));
      assert.equal(payload.code, 'ACCOUNT_IMPORT_FAILED');
      assert.deepEqual(payload.details, { operation: 'account_import', reason, ...extra });
      assert.equal(JSON.stringify(payload).includes('PRIVATE_CANARY'), false);
      assert.equal(JSON.stringify(payload).includes(directory), false);
      return true;
    });
    assert.equal(outputs.length, 0);
    // A later successful probe must still run. Neither failure nor diagnostics
    // may turn an unreadable old profile into a durable successful empty import.
    await fs.writeFile(entrypoint, "console.log(JSON.stringify({ schemaVersion: 1, accounts: [] }));");
    await prepareSkillAccount(options);
    assert.deepEqual(outputs[0].accounts, []);
  });
}

test('account import diagnostics reject open categories and project only closed fields', () => {
  assert.throws(() => new SkillAccountImportError('PRIVATE_CANARY'), TypeError);
  const payload = JSON.parse(formatBridgeCommandError(new SkillAccountImportError('process_start', {
    causeCode: 'PRIVATE_CANARY', signal: 'PRIVATE_CANARY', exitCode: -1, stderr: 'PRIVATE_CANARY',
  })));
  assert.deepEqual(payload.details, { operation: 'account_import', reason: 'process_start' });
});

test('missing import executable preserves a safe startup cause and no catalogue output', async t => {
  const { directory } = await fixture(t);
  await assert.rejects(prepareSkillAccount({ origin: identity.origin,
    catalogueDirectory: directory, runtimeDirectory: directory,
    artifact: { skillId: identity.skillId, runtimeVersion: '1.0.0', parsedPackage: {
      capabilities: ['local-session', 'local-accounts-v1'], entrypoint: { path: 'missing-executable', interpreter: 'executable' },
    } }, executionContext: { companyId: company, localIdentity: { memberId: member, connectionId: connection } },
    runtimeArguments: ['account', 'list'], output: () => assert.fail('failed import cannot return a catalogue'),
  }), error => {
    assert.deepEqual(JSON.parse(formatBridgeCommandError(error)).details,
      { operation: 'account_import', reason: 'process_start', causeCode: 'ENOENT' });
    return true;
  });
});

// The model-free reader reuses the actual materialized-provider executor. These
// fixtures are real child processes in a temporary package, with no catalogue,
// session, OAuth, network or credential access. A fake spawn cannot verify EOF,
// multibyte pipes, cancellation, code-page handling or native process exits.
async function monitorFixture(t, source, interpreter = 'node') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-monitor-process-'));
  // On Windows the native abort callback may precede release of the child's
  // cwd handle. Retry only removal of this owned disposable fixture, under a
  // bounded 1.5s backoff. Keep the original execution deadline/assertions and
  // propagate a persistent cleanup failure; no provider invocation is retried.
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const entry = interpreter === 'python' ? 'main.py' : 'main.mjs';
  await fs.writeFile(path.join(directory, entry), source);
  const account = { id: crypto.randomUUID(), companyBinding: 'a'.repeat(64), providerRef: null };
  const input = { artifact: { skillId: 'synthetic-monitor', runtimeVersion: '1.0.0',
    parsedPackage: { entrypoint: { path: entry, interpreter }, capabilities: ['local-session','local-accounts-v1'] } },
    runtimeDirectory: directory, runtimeArguments: ['monitor'], captureOutput: true,
    executionContext: { companyId: company, projectId: null, releaseId: crypto.randomUUID(), account,
      localIdentity: { memberId: member, connectionId: connection },
      companyConnection: { id: connection, config: {} } } };
  return { input, run: overrides => runMaterializedAgentSkill({ ...input, ...overrides }) };
}

test('private monitor uses ordinary bound identity, literal argv and EOF without inheriting a Codex chat', async t => {
  const previous = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = 'synthetic-stale-thread';
  t.after(() => { if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous; });
  const f = await monitorFixture(t, `let input='';
    for await (const chunk of process.stdin) input+=chunk;
    const value={input,args:process.argv.slice(2),company:process.env.TRELIO_SKILL_COMPANY_ID,
      member:process.env.TRELIO_SKILL_MEMBER_ID,account:JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON),
      chat:process.env.CODEX_THREAD_ID??null};
    process.stderr.write('PRIVATE_DIAGNOSTIC');process.stdout.write(JSON.stringify(value));`);
  const literal = '$(echo SHOULD_NOT_EXECUTE) & literal';
  const value = JSON.parse((await f.run({ runtimeArguments: ['monitor','--cursor',literal] })).stdout);
  assert.equal(value.input, '');
  assert.deepEqual(value.args, ['monitor','--cursor',literal]);
  assert.equal(value.company, company); assert.equal(value.member, member);
  assert.deepEqual(value.account, f.input.executionContext.account);
  assert.equal(value.chat, null);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_DIAGNOSTIC/u);
});

test('private monitor preserves split UTF-8 and actual isolated Python execution', async t => {
  const f = await monitorFixture(t, `const bytes=Buffer.from('Ирина ✓');
    for (let i=0;i<bytes.length;i++) {process.stdout.write(bytes.subarray(i,i+1));await new Promise(r=>setTimeout(r,1));}`);
  assert.deepEqual(await f.run(), { stdout: 'Ирина ✓' });
  const python = await monitorFixture(t, 'import json, sys\nprint(json.dumps({"args":sys.argv[1:],"input":sys.stdin.read(),"isolated":sys.flags.isolated}))\n', 'python');
  const value = JSON.parse((await python.run()).stdout);
  assert.deepEqual(value, { args: ['monitor'], input: '', isolated: 1 });
  const encoding = await monitorFixture(t, 'import json, sys\nprint(json.dumps({"encoding":sys.stdout.encoding,"utf8":sys.flags.utf8_mode,"isolated":sys.flags.isolated}))\n', 'python');
  assert.deepEqual(JSON.parse((await encoding.run()).stdout), { encoding: 'utf-8', utf8: 1, isolated: 1 });
});

test('private monitor rejects invalid UTF-8 and bounded stdout or stderr without copying private bytes', async t => {
  for (const [source, code] of [
    ["process.stdout.write(Buffer.from([255]));", 'TRELIO_SKILL_RUNTIME_OUTPUT_INVALID'],
    ["process.stdout.write('PRIVATE'.repeat(200000));", 'TRELIO_SKILL_RUNTIME_OUTPUT_LIMIT'],
    ["process.stderr.write('PRIVATE'.repeat(200000));", 'TRELIO_SKILL_RUNTIME_OUTPUT_LIMIT'],
  ]) {
    const f = await monitorFixture(t, source);
    await assert.rejects(f.run(), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE|stdout|stderr|main\.mjs|trelio-monitor-process/u);
      return true;
    });
  }
});

test('private monitor preserves numeric provider exit and never retries a failed subprocess', async t => {
  const f = await monitorFixture(t, `import fs from 'node:fs';
    fs.appendFileSync('attempts','1');process.stdout.write('PRIVATE_STDOUT');
    process.stderr.write('PRIVATE_STDERR');process.exit(3);`);
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'TRELIO_SKILL_RUNTIME_EXIT_3');assert.equal(error.details.exitCode, 3);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|attempts|main\.mjs/u);return true;
  });
  assert.equal(await fs.readFile(path.join(f.input.runtimeDirectory, 'attempts'), 'utf8'), '1');
});

test('trusted monitor result capture preserves a complete provider refusal without diagnosing or replaying it', async t => {
  for (const interpreter of ['node','python']) {
    const source = interpreter === 'node'
      ? `import fs from 'node:fs';fs.appendFileSync('attempts','1');
        process.stderr.write('PRIVATE_STDERR');process.stdout.write(JSON.stringify({code:'SYNTHETIC_GAP',message:'Чтение прервано'}));process.exitCode=1;`
      : `import sys\nwith open('attempts','a') as f: f.write('1')\nsys.stderr.write('PRIVATE_STDERR')\nprint('{"code":"SYNTHETIC_GAP","message":"Чтение прервано"}')\nsys.exit(1)\n`;
    const f = await monitorFixture(t, source, interpreter);
    const result = await f.run({ captureExitCode: true });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout), { code: 'SYNTHETIC_GAP', message: 'Чтение прервано' });
    assert.deepEqual(Object.keys(result).sort(), ['exitCode','stdout']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STDERR|command|cause|stack/u);
    assert.equal(await fs.readFile(path.join(f.input.runtimeDirectory,'attempts'),'utf8'), '1');
  }
  const f = await monitorFixture(t, "process.stdout.write('{}');");
  assert.deepEqual(await f.run({ captureExitCode: true }), { exitCode: 0, stdout: '{}' });
});

test('trusted monitor result cannot convert partial, overflowing or invalid output into a provider response', async t => {
  for (const [source,code] of [
    ["process.stdout.write(Buffer.from([255]));process.exitCode=1;",'TRELIO_SKILL_RUNTIME_OUTPUT_INVALID'],
    ["process.stdout.write('PRIVATE'.repeat(200000));process.exitCode=1;",'TRELIO_SKILL_RUNTIME_OUTPUT_LIMIT'],
    ["process.stderr.write('PRIVATE'.repeat(200000));process.exitCode=1;",'TRELIO_SKILL_RUNTIME_OUTPUT_LIMIT'],
    ["process.stdout.write('PRIVATE_PARTIAL');setInterval(()=>{},1000);",'TRELIO_SKILL_RUNTIME_LEASE_EXPIRED'],
  ]) {
    const f = await monitorFixture(t,source);
    await assert.rejects(f.run({ captureExitCode: true, timeoutMs: 1000 }),error=>{
      assert.equal(error.code,code);
      assert.doesNotMatch(JSON.stringify(error),/PRIVATE|stdout|stderr|cause|main\.mjs/u);
      return true;
    });
  }
  const f = await monitorFixture(t,"process.stdout.write('PRIVATE_PARTIAL');setInterval(()=>{},1000);");
  const controller = new AbortController();
  const pending = f.run({ captureExitCode: true, signal: controller.signal });
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(pending,{code:'TRELIO_SKILL_RUNTIME_TERMINATED'});
});

test('private monitor has a bounded deadline and cancellation without replay or inherited terminal prompts', async t => {
  const f = await monitorFixture(t, 'setInterval(()=>{},1000);');
  let started = performance.now();
  await assert.rejects(f.run({ timeoutMs: 1000 }), { code: 'TRELIO_SKILL_RUNTIME_LEASE_EXPIRED' });
  assert.ok(performance.now() - started < 10_000);
  const controller = new AbortController();
  const pending = f.run({ signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, error => error.code === 'TRELIO_SKILL_RUNTIME_TERMINATED' && error.details.causeCode === 'ABORT_ERR');
  controller.abort();
  await assert.rejects(f.run({ signal: controller.signal }), { code: 'TRELIO_SKILL_RUNTIME_TERMINATED' });
});

test('private monitor rejects setup, grants, arbitrary commands and invalid budgets before interpreter IO', async t => {
  const f = await monitorFixture(t, "throw Error('Should never run');");
  // Use a missing runtime root to make accidentally early interpreter/file IO
  // observable. Every invalid call must fail at the fixed profile boundary.
  for (const override of [{ runtimeArguments: ['send'] }, { runtimeArguments: ['account','create'] },
    { runtimeArguments: ['monitor',123] }, { grantedEnvironment: { SECRET: 'synthetic' } },
    { grantedStdin: 'synthetic' }, { prepareSetupEnvironment: async () => assert.fail('setup executed') },
    { timeoutMs: 999 }, { timeoutMs: 180001 }, { signal: {} }, { captureOutput: 'true' },
    { captureExitCode: 'true' }, { captureOutput: false, captureExitCode: true }]) {
    await assert.rejects(f.run({ runtimeDirectory: path.join(f.input.runtimeDirectory,'missing'), ...override }),
      { code: 'TRELIO_SKILL_MONITOR_INPUT_INVALID' });
  }
});

test('ordinary materialized execution retains its interactive input and exit contract', async t => {
  const f = await monitorFixture(t, `import fs from 'node:fs';let input='';
    for await(const chunk of process.stdin) input+=chunk;
    fs.writeFileSync('ordinary-result',JSON.stringify({args:process.argv.slice(2),input}));`);
  assert.equal(await f.run({ captureOutput: false, runtimeArguments: ['read'], grantedStdin: 'synthetic-input' }), undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.input.runtimeDirectory,'ordinary-result'),'utf8')),
    { args: ['read'], input: 'synthetic-input' });
});
