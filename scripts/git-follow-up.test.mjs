import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {registerFollowUp, drain, inspectEvent, acknowledgeEvent, cancelUnusedFollowUp, noteFollowUpProcess, serviceEnvironment, nativeContext, callbackText, nativeContains, installStatusReader} from './git-follow-up.mjs';
import {attachChatFollowUp} from './git-background.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-follow-up-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const store = path.join(root, 'state');
  const context = {threadId: '11111111-2222-3333-4444-555555555555', cli: path.join(root, 'codex')};
  const service = {node: process.execPath, script: path.join(root, 'service.mjs')};
  const register = (repository = 'one', log = 'a'.repeat(32), changed = {}) => {
    const canonical = path.join(root, repository);
    fs.mkdirSync(canonical, {recursive: true, mode: 0o700});
    const queueDirectory = path.join(canonical, '.git', 'queue');
    fs.mkdirSync(queueDirectory, {recursive: true, mode: 0o700});
    return registerFollowUp({root: store, canonical, queueDirectory, cwd: path.join(root, repository + '-task'),
      branch: 'codex/task', sha: 'a'.repeat(40), logFile: log + '.log',
      statusScript: path.join(canonical, 'scripts', 'git-integrate.mjs'), context, service, ...changed});
  };
  const observe = () => ({id: '000000000001', state: 'succeeded'});
  return {root, store, context, service, register, observe};
}

test('launcher registers the queue root above logs, not the log directory', () => {
  let options;
  const result = attachChatFollowUp({cwd: '/task', branch: 'codex/task', sha: 'a'.repeat(40),
    logFile: 'b'.repeat(32) + '.log', logPath: '/canonical/.git/queue/logs/' + 'b'.repeat(32) + '.log'},
  {canonical: '/canonical', statusScript: '/canonical/scripts/git-integrate.mjs', statusEngine: 'shared', arm: value => {
    options = value; return {eventId: 'c'.repeat(64), state: 'pending'};
  }});
  assert.equal(options.queueDirectory, '/canonical/.git/queue');
  assert.equal(options.statusEngine, 'shared');
  assert.equal(result.chatFollowUp.eventId, 'c'.repeat(64));
});

test('pinned shared reader survives source cleanup and stale canonical dependencies, with complete byte validation', async t => {
  const f = fixture(t), canonical = path.join(f.root, 'canonical'), source = path.join(f.root, 'source');
  fs.mkdirSync(source);
  for (const name of ['git-coordinator.mjs', 'git-background.mjs', 'git-follow-up.mjs', 'git-hosted-ci.mjs']) {
    fs.copyFileSync(new URL(name, import.meta.url), path.join(source, name));
  }
  const readers = path.join(f.store, 'readers');
  const reader = installStatusReader(readers, source);
  assert.equal(installStatusReader(readers, source), reader);
  const original = fs.readFileSync(reader);
  fs.writeFileSync(reader, 'throw Error("corrupt copy");');
  assert.throws(() => installStatusReader(readers, source), /copy differs/);
  assert.match(fs.readFileSync(reader, 'utf8'), /corrupt copy/, 'damaged immutable code is never overwritten');
  fs.writeFileSync(reader, original);
  fs.rmSync(source, {recursive: true});

  const initialized = spawnSync('git', ['init', '-q', canonical]);
  assert.equal(initialized.status, 0);
  fs.mkdirSync(path.join(canonical, 'scripts'));
  const stale = path.join(canonical, 'scripts', 'git-integrate.mjs');
  fs.writeFileSync(stale, 'process.exit(23);');
  assert.equal(spawnSync(process.execPath, [stale, '--status', '000000000001']).status, 23);
  const queueDirectory = path.join(canonical, '.git', 'trelio-git-coordination');
  fs.mkdirSync(queueDirectory, {mode: 0o700});
  fs.mkdirSync(path.join(queueDirectory, 'results'), {mode: 0o700});
  const registration = f.register('one', 'a'.repeat(32), {canonical, queueDirectory, statusScript: reader});
  const row = inspectEvent(f.store, registration.eventId);
  fs.writeFileSync(path.join(queueDirectory, 'results', '000000000001.json'), JSON.stringify({
    schemaVersion: 1, id: '000000000001', cwd: row.cwd, branch: row.branch, sha: row.sourceSha,
    sourceSha: row.sourceSha, logFile: row.logFile, tag: '', state: 'succeeded', finishedAt: new Date().toISOString(),
  }), {mode: 0o600});
  let writes = 0;
  await drain({root: f.store, send: result => {
    assert.equal(result.observedState, 'succeeded');
    writes++; return {queuedId: '22222222-2222-3333-4444-555555555555'};
  }});
  assert.equal(writes, 1);
  assert.equal(inspectEvent(f.store, registration.eventId).ticketId, '000000000001');
});

test('one chat keeps equal ticket IDs in different repositories independent and sends each once', async t => {
  const f = fixture(t), first = f.register('one'), second = f.register('two');
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(f.register('one').eventId, first.eventId, 'reattachment reuses its subscription');
  const writes = [];
  const send = row => { writes.push(row); return {queuedId: '22222222-2222-3333-4444-555555555555'}; };
  await Promise.all([drain({root: f.store, observe: f.observe, send, contains: async () => false}),
    drain({root: f.store, observe: f.observe, send, contains: async () => false})]);
  assert.equal(writes.length, 2);
  assert.deepEqual(new Set(writes.map(row => row.id)), new Set([first.eventId, second.eventId]));
  assert.equal(new Set(writes.map(row => row.threadId)).size, 1);
  assert.equal(new Set(writes.map(row => row.ticketId)).size, 1, 'ticket ID alone is not identity');
  await drain({root: f.store, observe: f.observe, send});
  assert.equal(writes.length, 2);
});

test('waiting never invokes a model and failed/recovery outcomes wake without modifying the integration', async t => {
  const f = fixture(t), first = f.register(), states = ['waiting', 'running', 'verified'];
  let writes = 0;
  const send = () => { writes++; return {queuedId: '22222222-2222-3333-4444-555555555555'}; };
  for (const state of states) await drain({root: f.store, observe: () => ({id: '000000000001', state}), send});
  assert.equal(writes, 0);
  await drain({root: f.store, observe: () => ({id: '000000000001', state: 'recovery_required'}), send});
  assert.equal(writes, 1);
  assert.equal(inspectEvent(f.store, first.eventId).observedState, 'recovery_required');
  const second = f.register('one', 'b'.repeat(32));
  await drain({root: f.store, observe: () => ({id: '000000000002', state: 'failed'}), send});
  assert.equal(writes, 2);
  assert.equal(inspectEvent(f.store, second.eventId).observedState, 'failed');
});

test('unknown write outcome survives a new process drain and reconciles only positive native evidence', async t => {
  const f = fixture(t), registration = f.register();
  let writes = 0;
  const send = () => { writes++; return {uncertain: true}; };
  await drain({root: f.store, observe: f.observe, send});
  assert.equal(inspectEvent(f.store, registration.eventId).delivery, 'uncertain');
  await drain({root: f.store, observe: f.observe, send, contains: async () => false});
  assert.equal(writes, 1, 'bounded absence never authorizes another native write');
  await drain({root: f.store, observe: f.observe, send, contains: async () => true});
  assert.equal(inspectEvent(f.store, registration.eventId).delivery, 'queued');
  assert.equal(writes, 1);
});

test('crash after exclusive send claim but before transport never replays the uncertain attempt', async t => {
  const f = fixture(t), registration = f.register();
  fs.writeFileSync(path.join(f.store, 'events', registration.eventId + '.attempt'), '{}', {mode: 0o600});
  let writes = 0;
  await drain({root: f.store, observe: f.observe, send: () => { writes++; }, contains: async () => false});
  assert.equal(writes, 0);
  assert.equal(inspectEvent(f.store, registration.eventId).delivery, 'uncertain');
});

test('agent acknowledgement wins a transport completion race and is idempotent', async t => {
  const f = fixture(t), registration = f.register();
  assert.throws(() => acknowledgeEvent(f.store, registration.eventId), /not been sent/);
  await drain({root: f.store, observe: f.observe, send: row => {
    acknowledgeEvent(f.store, row.id);
    return {queuedId: '22222222-2222-3333-4444-555555555555'};
  }});
  assert.equal(inspectEvent(f.store, registration.eventId).delivery, 'handled');
  acknowledgeEvent(f.store, registration.eventId);
  await drain({root: f.store, observe: f.observe, send: () => assert.fail('duplicate native write')});
});

test('private registrations reject another chat, unsafe modes and symlink state before delivery', t => {
  const f = fixture(t), registration = f.register();
  assert.throws(() => f.register('one', 'a'.repeat(32), {context: {...f.context, threadId: '22222222-2222-3333-4444-555555555555'}}), /another chat/);
  const file = path.join(f.store, 'events', registration.eventId + '.json');
  fs.chmodSync(file, 0o644);
  assert.throws(() => inspectEvent(f.store, registration.eventId), /Unsafe/);
  fs.chmodSync(file, 0o600);
  const saved = fs.readFileSync(file); fs.unlinkSync(file);
  const target = path.join(f.root, 'other'); fs.writeFileSync(target, saved, {mode: 0o600});
  fs.symlinkSync(target, file);
  assert.throws(() => inspectEvent(f.store, registration.eventId), /Unsafe/);
});

test('callback carries exact clone/source and read-back instructions, never raw CI error or new authority', t => {
  const f = fixture(t), registration = f.register(), row = inspectEvent(f.store, registration.eventId);
  const text = callbackText({...row, ticketId: '000000000001', error: 'PRIVATE TEST LOG'});
  assert.match(text, new RegExp('GIT_FOLLOW_UP:' + registration.eventId));
  assert.ok(text.includes(row.canonical));
  assert.match(text, /не разрешение на релиз/);
  assert.match(text, /origin\/main/);
  assert.match(text, /--ack/);
  assert.ok(text.includes(JSON.stringify([row.node, row.statusScript, '--status', '000000000001'])));
  const legacy = callbackText({...row, callbackVersion: undefined, ticketId: '000000000001'});
  assert.doesNotMatch(legacy, /Exact status argv|Тикет ещё не установлен/);
  assert.equal(legacy, callbackText({...row, callbackVersion: 1, ticketId: '000000000001'}),
    'pre-upgrade attempts retain their exact native reconciliation text');
  assert.doesNotMatch(text, /PRIVATE TEST LOG/);
});

test('service does not inherit tool proof, app pipe or model/account environment', () => {
  assert.deepEqual(serviceEnvironment({HOME: '/home/fixture', PATH: '/bin', CODEX_HOME: '/fixture/codex',
    CODEX_THREAD_ID: 'secret-session', CODEX_APP_TOOLS_PIPE_PATH: '/private/pipe', OPENAI_API_KEY: 'not-forwarded'}),
  {HOME: '/home/fixture', PATH: '/bin', CODEX_HOME: '/fixture/codex'});
  assert.equal(nativeContext({}), null);
  assert.throws(() => nativeContext({CODEX_THREAD_ID: 'bad', CODEX_APP_RUNTIME_CLI_PATH: '/bin/codex'}), /Invalid/);
});

test('real native metadata child reconciles a marker without resume, turn start or model invocation', async t => {
  const f = fixture(t), registration = f.register(), row = inspectEvent(f.store, registration.eventId);
  const cli = f.context.cli, requests = path.join(f.root, 'requests');
  fs.writeFileSync(cli, `#!${process.execPath}\nimport readline from 'node:readline';import fs from 'node:fs';
const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requests)},m.method+'\\n');if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='thread/queue/list'?{data:[{input:[{type:'text',text:${JSON.stringify(callbackText(row))}}]}]}:{}}));});\n`, {mode: 0o700});
  // The temporary executable has an extensionless native CLI name; Node treats
  // it as CommonJS without a package scope, so this fixture declares that scope.
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"module"}');
  assert.equal(await nativeContains(row), true);
  assert.deepEqual(fs.readFileSync(requests, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'thread/queue/list']);
});

test('a quoted event marker in agent history is not native delivery evidence', async t => {
  const f = fixture(t), registration = f.register(), row = inspectEvent(f.store, registration.eventId);
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(f.context.cli, `#!${process.execPath}\nimport readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:{data:[{items:[{type:'agentMessage',text:${JSON.stringify(callbackText(row))}}]}]}}));});\n`, {mode: 0o700});
  assert.equal(await nativeContains(row), false);
});

test('installed service is absent from signed host runtime package inputs', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.files.includes('scripts/git-follow-up.mjs'));
  assert.ok(packageJson.files.every(file => file.startsWith('scripts/')));
  const syntax = spawnSync(process.execPath, ['--check', new URL('./git-follow-up.mjs', import.meta.url).pathname]);
  assert.equal(syntax.status, 0);
});

test('real receipt discovery reuses canonical status and respects an active ticket over its receipt', async t => {
  const f = fixture(t), registration = f.register();
  const row = inspectEvent(f.store, registration.eventId);
  const entry = {schemaVersion: 1, id: '000000000001', cwd: row.cwd, branch: row.branch,
    sourceSha: row.sourceSha, logFile: row.logFile};
  fs.mkdirSync(path.dirname(row.statusScript), {recursive: true});
  const statusFile = path.join(f.root, 'status.json');
  fs.writeFileSync(statusFile, JSON.stringify({id: entry.id, state: 'running'}));
  fs.writeFileSync(row.statusScript, `import fs from 'node:fs';console.log(fs.readFileSync(${JSON.stringify(statusFile)},'utf8'));`);
  fs.writeFileSync(path.join(row.queueDirectory, entry.id + '.json'), JSON.stringify(entry), {mode: 0o600});
  fs.mkdirSync(path.join(row.queueDirectory, 'results'), {mode: 0o700});
  fs.writeFileSync(path.join(row.queueDirectory, 'results', entry.id + '.json'), JSON.stringify({...entry, state: 'succeeded'}), {mode: 0o600});
  let writes = 0;
  const send = () => { writes++; return {queuedId: '22222222-2222-3333-4444-555555555555'}; };
  await drain({root: f.store, send});
  assert.equal(writes, 0, 'persisted success cannot override the repository reader');
  fs.writeFileSync(statusFile, JSON.stringify({id: entry.id, state: 'succeeded'}));
  fs.unlinkSync(path.join(row.queueDirectory, entry.id + '.json'));
  fs.rmSync(row.cwd, {force: true, recursive: true});
  await drain({root: f.store, send});
  assert.equal(writes, 1, 'source directory removal does not lose the receipt');
  assert.equal(inspectEvent(f.store, registration.eventId).ticketId, entry.id);
});

test('a damaged subscription cannot prevent another repository delivery', async t => {
  const f = fixture(t), bad = f.register('one'), good = f.register('two');
  fs.writeFileSync(path.join(f.store, 'events', bad.eventId + '.json'), '{}');
  const writes = [];
  await drain({root: f.store, observe: f.observe, send: row => {
    writes.push(row.id); return {queuedId: '22222222-2222-3333-4444-555555555555'};
  }});
  assert.deepEqual(writes, [good.eventId]);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(f.store, 'diagnostics', bad.eventId + '.json')));
  assert.equal(diagnostic.code, 'registration_invalid');
});

test('a duplicate admission cancels only its unsent intent and a live pre-admission worker never wakes by age', async t => {
  const f = fixture(t), winner = f.register('one'), duplicate = f.register('one', 'b'.repeat(32));
  cancelUnusedFollowUp(duplicate.eventId, f.store);
  await drain({root: f.store, observe: f.observe, send: row => {
    assert.equal(row.id, winner.eventId); return {queuedId: '22222222-2222-3333-4444-555555555555'};
  }});
  assert.equal(inspectEvent(f.store, duplicate.eventId).delivery, 'cancelled');
  assert.throws(() => cancelUnusedFollowUp(winner.eventId, f.store), /already attempted/);
  const admission = f.register('two');
  noteFollowUpProcess(admission.eventId, process.pid, f.store);
  const file = path.join(f.store, 'events', admission.eventId + '.json');
  const row = JSON.parse(fs.readFileSync(file)); row.createdAt = '2000-01-01T00:00:00Z';
  fs.writeFileSync(file, JSON.stringify(row));
  await drain({root: f.store, send: () => assert.fail('a live pre-admission worker is not a terminal result')});
  assert.equal(inspectEvent(f.store, admission.eventId).delivery, 'pending');
});
