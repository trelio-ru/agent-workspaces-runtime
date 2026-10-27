import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssistantInbox,assistantDeliveryFailure,readAssistantInboxDispatchSummary } from '../host-runtime/scripts/trelio-assistant-inbox.mjs';
import { createAssistantScheduler } from '../host-runtime/scripts/trelio-assistant-scheduler.mjs';

const scope = overrides => ({ origin: 'https://example.test', assistantId: randomUUID(), companyId: randomUUID(),
  provider: 'trelio', accountId: randomUUID(), bindingId: randomUUID(), ...overrides });
function memory(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  let timestamp = 1_000_000;
  const inbox = createAssistantInbox({ database, now: () => timestamp });
  return { inbox, database, advance: ms => { timestamp += ms; } };
}
function accept(inbox, source, taskId) { inbox.applyTaskState(source, { taskId, state: 'accepted', expectedRevision: 0 }); }
function page(inbox, source, events, nextCursor = 'page-1', hasMore = false) {
  return inbox.commitPage(source, { ...inbox.claimPoll(source), nextCursor, hasMore, events });
}

test('schema11 adds nullable closed failure metadata without inventing legacy causes or changing the native fence',async t=>{
  const f=memory(t),source=scope(),taskId=randomUUID();f.inbox.register(source);accept(f.inbox,source,taskId);
  page(f.inbox,source,[{id:'mention',revision:'1',taskId,wake:true}]);
  const job=await f.inbox.claimDelivery({authorize:async()=>true});f.inbox.startDelivery(job.deliveryId);
  f.inbox.markDeliveryUncertain(job.deliveryId);
  createAssistantScheduler({database:f.database});
  f.database.exec('ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_recovery_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_continuation_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_code; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_stage; UPDATE assistant_inbox_meta SET version=10');
  const before={...f.database.prepare('SELECT delivery_id,state,native_started,expires_at FROM assistant_inbox_deliveries').get()};
  const identity={origin:source.origin,assistantId:source.assistantId,deviceId:source.bindingId},companies=[{companyId:source.companyId,memberId:source.accountId}];
  assert.equal(readAssistantInboxDispatchSummary({database:f.database,identity,companies}).failure,null,'v10 readonly status does not infer a cause');
  assert.equal(f.database.prepare('SELECT version FROM assistant_inbox_meta').get().version,10,'readonly status cannot migrate');
  const migrated=createAssistantInbox({database:f.database,now:()=>1000000});
  assert.equal(f.database.prepare('SELECT version FROM assistant_inbox_meta').get().version,16);
  assert.deepEqual({...f.database.prepare('SELECT delivery_id,state,native_started,expires_at FROM assistant_inbox_deliveries').get()},before);
  assert.equal(readAssistantInboxDispatchSummary({database:f.database,identity,companies}).failure,null);
  const failure=assistantDeliveryFailure('ASSISTANT_CODEX_MODEL_UNAVAILABLE','native_preflight');
  migrated.markDeliveryUncertain(job.deliveryId,failure);
  assert.deepEqual(readAssistantInboxDispatchSummary({database:f.database,identity,companies}).failure,failure);
  assert.throws(()=>migrated.markDeliveryUncertain(job.deliveryId,{code:'ASSISTANT_PRIVATE_CANARY',stage:'native_claim'}),/INVALID_INPUT/);
  assert.throws(()=>migrated.markDeliveryUncertain(job.deliveryId,{...failure,message:'PRIVATE'}),/INVALID_INPUT/);
  assert.equal(f.database.prepare('SELECT native_started FROM assistant_inbox_deliveries').get().native_started,1);
});
const event = (taskId, wake = true, id = randomUUID()) => ({ id, revision: '1', taskId, wake });
const authorized = async () => true;
// Historical-schema fixtures remove the actual v6/v7 columns before lowering the
// marker. A current table with an old marker is deliberately not a migration.
const removeRoutingColumns = database => {
  database.exec('ALTER TABLE assistant_inbox_sources DROP COLUMN ack_verified_revision');
  database.exec('ALTER TABLE assistant_inbox_events DROP COLUMN ack_verify_only');
  database.exec('ALTER TABLE assistant_inbox_events DROP COLUMN read_original_sha256');
  database.exec('ALTER TABLE assistant_inbox_sources DROP COLUMN configuration_revision');
  for(const name of ['conversation_key','provider_wake','dispatch_source_key','route_id','route_source_revision','route_checked_at','dispatched','read_delivery_id'])
    database.exec(`ALTER TABLE assistant_inbox_events DROP COLUMN ${name}`);
  for(const name of ['conversation_key','route_id','route_source_revision','event_ordinal'])database.exec(`ALTER TABLE assistant_inbox_delivery_events DROP COLUMN ${name}`);
};
// ACK-outbox tests inject the independent trusted processing boundary directly.
// No provider/native read observer is composed in these low-level fixtures.
const fixtureProcessed = database => database.exec('UPDATE assistant_inbox_events SET processed=1');

for(const provider of ['telegram','max'])test(`${provider} handled group requests never claim a broad automatic read receipt`,async t=>{
  const {inbox,database,advance}=memory(t),source=scope({provider}),task=randomUUID();
  inbox.register(source);accept(inbox,source,task);
  const original={...event(task),automaticAck:false};page(inbox,source,[original]);
  const work=await inbox.claimDelivery({authorize:authorized});
  inbox.startDelivery(work.deliveryId);inbox.completeDelivery(work.deliveryId,'native-completion');fixtureProcessed(database);
  assert.equal(inbox.claimAcknowledgements(source),null);assert.equal(inbox.externalAcknowledgementDue(source),null);
  assert.equal(inbox.externalAcknowledgementHealth(source),null,'intentional group policy is not broken source health');
  const row=database.prepare('SELECT processed,acked,ack_started,automatic_ack FROM assistant_inbox_events').get();
  assert.deepEqual({...row},{processed:1,acked:0,ack_started:0,automatic_ack:0});
  advance(300000);page(inbox,source,[{...original,automaticAck:true}],'replayed');
  assert.equal(database.prepare('SELECT automatic_ack FROM assistant_inbox_events').get().automatic_ack,0,'legacy replay cannot re-enable range ACK');
});

test('schema15 adds restrictive ACK policy without losing a v14 unknown-write fence or cursor',t=>{
  const {inbox,database}=memory(t),source=scope({provider:'telegram'}),task=randomUUID();
  inbox.register(source);accept(inbox,source,task);page(inbox,source,[event(task)],'retained-cursor');fixtureProcessed(database);
  const ack=inbox.claimAcknowledgements(source);inbox.startExternalAcknowledgements(source,ack.token);
  const before={...database.prepare('SELECT * FROM assistant_inbox_events').get()};delete before.automatic_ack;
  database.exec('ALTER TABLE assistant_inbox_events DROP COLUMN automatic_ack; UPDATE assistant_inbox_meta SET version=14');
  const upgraded=createAssistantInbox({database,now:()=>1_000_000});
  const after={...database.prepare('SELECT * FROM assistant_inbox_events').get()};assert.equal(after.automatic_ack,1);delete after.automatic_ack;
  assert.deepEqual(after,before);assert.equal(database.prepare('SELECT cursor FROM assistant_inbox_sources').get().cursor,'retained-cursor');
  assert.equal(upgraded.externalAcknowledgementHealth(source),'acknowledgement_uncertain');
  assert.equal(upgraded.claimAcknowledgements(source),null,'the original active write lease is retained');
});

test('tightening group ACK policy preserves read-only reconciliation of an already started legacy write',t=>{
  const {inbox,database,advance}=memory(t),source=scope({provider:'telegram'}),task=randomUUID();
  inbox.register(source);accept(inbox,source,task);const original=event(task);page(inbox,source,[original]);fixtureProcessed(database);
  const old=inbox.claimAcknowledgements(source);inbox.startExternalAcknowledgements(source,old.token);
  advance(300000);page(inbox,source,[{...original,automaticAck:false}],'restricted');
  assert.equal(inbox.externalAcknowledgementHealth(source),'acknowledgement_uncertain');
  const recovery=inbox.claimAcknowledgements(source);assert.equal(recovery.reconcileOnly,true);
  assert.throws(()=>inbox.startExternalAcknowledgements(source,recovery.token),/STALE_ACK/);
  inbox.completeAcknowledgements(source,recovery.token);
  assert.equal(database.prepare('SELECT acked FROM assistant_inbox_events').get().acked,1,'only positive native read-back may settle the old attempt');
});


test('real SQLite persists cursor and events atomically; replays never deliver twice', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-inbox-test-'));
  let db;
  // after hooks run in registration order. Unlike POSIX, Windows cannot
  // unlink an open SQLite file, so close and removal share one ordered hook.
  t.after(async () => { db?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, 'inbox.sqlite');
  let timestamp = 1_000_000;
  db = new DatabaseSync(file);
  let inbox = createAssistantInbox({ database: db, now: () => timestamp });
  const source = scope(), task = randomUUID(), incoming = event(task);
  inbox.register(source); accept(inbox, source, task);
  assert.equal(page(inbox, source, [incoming]).added, 1);
  const lease = await inbox.claimDelivery({ authorize: authorized });
  inbox.startDelivery(lease.deliveryId);
  inbox.completeDelivery(lease.deliveryId, 'native-turn-1');
  db.close();
  db = null;
  db = new DatabaseSync(file);
  inbox = createAssistantInbox({ database: db, now: () => timestamp });
  assert.equal(inbox.status(source).cursorRevision, 1);
  timestamp += 300_000;
  assert.equal(page(inbox, source, [incoming]).added, 0);
  assert.equal(await inbox.claimDelivery({ authorize: authorized }), null);
});

test('ordinary comments do not wake; a mention coalesces pending task context', async t => {
  const { inbox } = memory(t), source = scope(), task = randomUUID();
  inbox.register(source); accept(inbox, source, task);
  page(inbox, source, [event(task, false)], 'comment', true);
  assert.equal(await inbox.claimDelivery({ authorize: authorized }), null);
  page(inbox, source, [event(task, true)], 'mention');
  const work = await inbox.claimDelivery({ authorize: authorized });
  assert.equal(work.events.length, 2);
  assert.equal(work.taskId, task);
  assert.equal(await inbox.claimDelivery({ authorize: authorized }), null, 'one desktop worker globally');
});

test('a scheduled task pass consumes context without inventing an event wake or automation', async t => {
  const { inbox } = memory(t), source = scope(), task = randomUUID();
  inbox.register(source); accept(inbox, source, task);
  page(inbox, source, [event(task, false)]);
  assert.equal(await inbox.claimDelivery({ authorize: authorized }), null);
  const work = await inbox.claimDelivery({ authorize: authorized, scheduledTask: { scope: source, taskId: task } });
  assert.equal(work.events.length, 1);
  inbox.startDelivery(work.deliveryId); inbox.completeDelivery(work.deliveryId, 'scheduled-turn-1');
  const next = await inbox.claimDelivery({ authorize: authorized, scheduledTask: { scope: source, taskId: task } });
  assert.equal(next.events.length, 0, 'the real scheduler can trigger a task with no new events');
});

test('owner-pending and unknown tasks neither dispatch nor mark read', async t => {
  const { inbox } = memory(t), source = scope(), task = randomUUID();
  inbox.register(source);
  inbox.applyTaskState(source, { taskId: task, state: 'waiting_owner', expectedRevision: 0 });
  page(inbox, source, [event(task), event(null)]);
  assert.equal(await inbox.claimDelivery({ authorize: authorized }), null);
  assert.equal(inbox.claimAcknowledgements(source), null);
  inbox.applyTaskState(source, { taskId: task, state: 'accepted', expectedRevision: 1 });
  const ack = inbox.claimAcknowledgements(source);
  assert.equal(ack.events.length, 1);
  inbox.completeAcknowledgements(source, ack.token);
  assert.equal(inbox.claimAcknowledgements(source), null);
  assert.equal((await inbox.claimDelivery({ authorize: authorized })).taskId, task);
});

test('same provider IDs and task IDs remain isolated by company, account and binding', async t => {
  const { inbox } = memory(t), first = scope(), task = randomUUID();
  const second = { ...first, companyId: randomUUID() }, third = { ...first, accountId: randomUUID() };
  for (const source of [first, second, third]) { inbox.register(source); page(inbox, source, [event(task, true, 'same-id')]); }
  accept(inbox, second, task);
  const work = await inbox.claimDelivery({ authorize: async input => {
    assert.equal(input.scope.companyId, second.companyId);
    assert.equal(input.scope.accountId, second.accountId);
    return true;
  } });
  assert.equal(work.scope.companyId, second.companyId);
  assert.equal(inbox.claimAcknowledgements(first), null);
  assert.equal(inbox.claimAcknowledgements(second).events.length, 1);
});

test('two connections serialize poll leases and cursor CAS; an invalid page cannot advance', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-concurrent-test-'));
  const connections = [];
  t.after(async () => {
    for (const connection of connections) connection.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'queue.sqlite');
  const a = new DatabaseSync(file); connections.push(a);
  const b = new DatabaseSync(file); connections.push(b);
  const first = createAssistantInbox({ database: a }), second = createAssistantInbox({ database: b });
  const source = scope(), task = randomUUID(), incoming = event(task);
  first.register(source);
  const poll = first.claimPoll(source);
  assert.equal(second.claimPoll(source), null);
  assert.throws(() => second.commitPage(source, { ...poll, cursorRevision: 9, nextCursor: 'bad', hasMore: false, events: [incoming] }), { code: 'ASSISTANT_INBOX_CONFLICT' });
  assert.equal(first.status(source).pending, 0);
  first.commitPage(source, { ...poll, nextCursor: 'good', hasMore: false, events: [incoming] });
  assert.throws(() => second.commitPage(source, { ...poll, nextCursor: 'duplicate', hasMore: false, events: [] }), { code: 'ASSISTANT_INBOX_STALE_POLL' });
  assert.equal(second.status(source).cursorRevision, 1);
});

test('crash before external call retries; after external call requires exact native read-back', async t => {
  const { inbox, advance } = memory(t), source = scope(), task = randomUUID();
  inbox.register(source); accept(inbox, source, task); page(inbox, source, [event(task)]);
  const abandoned = await inbox.claimDelivery({ authorize: authorized });
  advance(120_001);
  const retried = await inbox.claimDelivery({ authorize: authorized });
  assert.notEqual(retried.deliveryId, abandoned.deliveryId);
  assert.throws(() => inbox.startDelivery(abandoned.deliveryId), { code: 'ASSISTANT_INBOX_DELIVERY_REQUIRED' });
  inbox.startDelivery(retried.deliveryId);
  advance(120_001);
  assert.equal(await inbox.claimDelivery({ authorize: authorized }), null);
  assert.deepEqual(inbox.status(source).uncertain, [retried.deliveryId]);
  inbox.completeDelivery(retried.deliveryId, 'confirmed-native-turn');
  inbox.completeDelivery(retried.deliveryId, 'confirmed-native-turn');
  assert.equal(await inbox.claimDelivery({ authorize: authorized }), null);
});

test('fresh authorization refusal and revocation during I/O preserve pending events', async t => {
  const { inbox } = memory(t), source = scope(), task = randomUUID();
  inbox.register(source); accept(inbox, source, task); page(inbox, source, [event(task)]);
  await assert.rejects(inbox.claimDelivery({ authorize: async () => false }), { code: 'ASSISTANT_INBOX_ACCESS_DENIED' });
  await assert.rejects(inbox.claimDelivery({ authorize: async () => {
    inbox.setSourceState(source, { state: 'revoked', expectedRevision: 0 }); return true;
  } }), { code: 'ASSISTANT_INBOX_SOURCE_INACTIVE' });
  assert.equal(inbox.status(source).pending, 1);
  assert.throws(() => inbox.setSourceState(source, { state: 'active', expectedRevision: 1 }), { code: 'ASSISTANT_INBOX_CONFLICT' });
  assert.throws(() => inbox.claimAcknowledgements(source), { code: 'ASSISTANT_INBOX_SOURCE_INACTIVE' });
});

test('conflicting replay rolls back the entire page; content-bearing input is rejected', t => {
  const { inbox, advance } = memory(t), source = scope(), task = randomUUID(), incoming = event(task);
  inbox.register(source); page(inbox, source, [incoming]); advance(300_000);
  const poll = inbox.claimPoll(source);
  assert.throws(() => inbox.commitPage(source, { ...poll, nextCursor: 'bad', hasMore: false,
    events: [event(task), { ...incoming, wake: false }] }), { code: 'ASSISTANT_INBOX_EVENT_CHANGED' });
  assert.equal(inbox.status(source).pending, 1);
  assert.equal(inbox.status(source).cursorRevision, 1);
  assert.throws(() => inbox.commitPage(source, { ...poll, nextCursor: 'bad', hasMore: false,
    events: [{ ...incoming, text: 'PRIVATE MESSAGE MUST NOT ENTER SQLITE' }] }), { code: 'ASSISTANT_INBOX_INVALID_INPUT' });
  assert.throws(() => inbox.register({ ...source, credential: 'not-accepted' }), { code: 'ASSISTANT_INBOX_INVALID_INPUT' });
});

test('unknown schema is preserved rather than reset', t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec('CREATE TABLE assistant_inbox_meta(version INTEGER NOT NULL); INSERT INTO assistant_inbox_meta VALUES (999)');
  assert.throws(() => createAssistantInbox({ database }), { code: 'ASSISTANT_INBOX_UNSUPPORTED_SCHEMA' });
  assert.equal(database.prepare('SELECT version FROM assistant_inbox_meta').get().version, 999);
});

test('late routing preserves replay identity and cannot move events to another task', async t => {
  const { inbox, advance } = memory(t), source = scope(), task = randomUUID(), otherTask = randomUUID(), incoming = event(null);
  inbox.register(source); accept(inbox, source, task); accept(inbox, source, otherTask);
  page(inbox, source, [incoming]);
  const [{ event_key: key }] = inbox.unrouted(source);
  inbox.routeEvents(source, { eventKeys: [key], taskId: task });
  assert.equal(inbox.unrouted(source).length, 0);
  assert.throws(() => inbox.routeEvents(source, { eventKeys: [key], taskId: otherTask }), { code: 'ASSISTANT_INBOX_CONFLICT' });
  advance(300_000);
  assert.equal(page(inbox, source, [incoming]).added, 0);
  assert.equal((await inbox.claimDelivery({ authorize: authorized })).taskId, task);
});

test('a source pause/resume cannot revive poll, acknowledgement or delivery leases', async t => {
  const { inbox, advance } = memory(t), source = scope(), task = randomUUID();
  inbox.register(source); accept(inbox, source, task); page(inbox, source, [event(task)]);
  const ack = inbox.claimAcknowledgements(source);
  const work = await inbox.claimDelivery({ authorize: authorized });
  inbox.setSourceState(source, { state: 'paused', expectedRevision: 0 });
  inbox.setSourceState(source, { state: 'active', expectedRevision: 1 });
  assert.throws(() => inbox.completeAcknowledgements(source, ack.token), { code: 'ASSISTANT_INBOX_STALE_ACK' });
  assert.throws(() => inbox.startDelivery(work.deliveryId), { code: 'ASSISTANT_INBOX_DELIVERY_REQUIRED' });
  advance(300_000);
  const poll = inbox.claimPoll(source);
  inbox.setSourceState(source, { state: 'paused', expectedRevision: 2 });
  inbox.setSourceState(source, { state: 'active', expectedRevision: 3 });
  assert.throws(() => inbox.commitPage(source, { ...poll, nextCursor: 'stale', hasMore: false, events: [] }), { code: 'ASSISTANT_INBOX_STALE_POLL' });
  await assert.rejects(inbox.claimDelivery({ authorize: async () => {
    inbox.setSourceState(source, { state: 'paused', expectedRevision: 4 });
    inbox.setSourceState(source, { state: 'active', expectedRevision: 5 }); return true;
  } }), { code: 'ASSISTANT_INBOX_CONFLICT' });
});

test('pending capacity refuses a page without losing its source cursor or partial insert', t => {
  const { inbox, database } = memory(t), source = scope();
  inbox.register(source);
  const sourceKey = database.prepare('SELECT source_key FROM assistant_inbox_sources').get().source_key;
  database.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<10000)
    INSERT INTO assistant_inbox_events(event_key,source_key,event_id,event_revision,wake)
    SELECT 'synthetic-'||n,?,'synthetic-'||n,'1',0 FROM numbers`).run(sourceKey);
  const poll = inbox.claimPoll(source);
  assert.throws(() => inbox.commitPage(source, { ...poll, nextCursor: 'must-not-advance', hasMore: false, events: [event(null)] }), { code: 'ASSISTANT_INBOX_FULL' });
  assert.equal(inbox.status(source).cursorRevision, 0);
  assert.equal(inbox.status(source).pending, 10000);
});

test('task pause and reacceptance invalidate a previously leased delivery revision', async t => {
  const { inbox } = memory(t), source = scope(), task = randomUUID();
  inbox.register(source); accept(inbox, source, task); page(inbox, source, [event(task)]);
  const work = await inbox.claimDelivery({ authorize: authorized });
  inbox.applyTaskState(source, { taskId: task, state: 'paused', expectedRevision: 1 });
  inbox.applyTaskState(source, { taskId: task, state: 'accepted', expectedRevision: 2 });
  assert.throws(() => inbox.startDelivery(work.deliveryId), { code: 'ASSISTANT_INBOX_STALE_DELIVERY' });
});

test('verified terminal non-acceptance permits retry without accepting a late old receipt', async t => {
  const { inbox, advance } = memory(t), source = scope(), task = randomUUID();
  inbox.register(source); accept(inbox, source, task); page(inbox, source, [event(task)]);
  const work = await inbox.claimDelivery({ authorize: authorized }); inbox.startDelivery(work.deliveryId);
  assert.throws(() => inbox.resolveDeliveryNotAccepted(work.deliveryId, 'too-early'), { code: 'ASSISTANT_INBOX_STALE_DELIVERY' });
  advance(120_001);
  assert.equal(await inbox.claimDelivery({ authorize: authorized }), null);
  inbox.resolveDeliveryNotAccepted(work.deliveryId, 'native-terminal-rejection-1');
  inbox.resolveDeliveryNotAccepted(work.deliveryId, 'native-terminal-rejection-1');
  const next = await inbox.claimDelivery({ authorize: authorized });
  assert.notEqual(next.deliveryId, work.deliveryId);
  assert.throws(() => inbox.completeDelivery(work.deliveryId, 'late-old-result'), { code: 'ASSISTANT_INBOX_STALE_DELIVERY' });
  assert.equal(inbox.status(source).pending, 1);
});


test('v2 SQLite upgrade preserves question-free events, leases and cursors; question refs are immutable and durable', async t => {
  const { inbox: initial, database, advance } = memory(t), source = scope(), task = randomUUID();
  initial.register(source); accept(initial, source, task);
  page(initial, source, [event(task)]);
  const first = await initial.claimDelivery({ authorize: authorized });
  initial.prepareTaskPass(first.deliveryId);
  // Real previous schema on the same connection, not a mock version flag on a
  // new table: the upgrade must add the column without resetting pending work.
  removeRoutingColumns(database);
  database.exec('ALTER TABLE assistant_inbox_events DROP COLUMN owner_question_id; ALTER TABLE assistant_inbox_events DROP COLUMN ack_started; ALTER TABLE assistant_inbox_events DROP COLUMN ack_attempt_token; ALTER TABLE assistant_inbox_events DROP COLUMN ack_retry_at; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_recovery_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_continuation_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_code; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_stage; UPDATE assistant_inbox_meta SET version=2');
  const inbox = createAssistantInbox({ database, now: () => 1_000_000 });
  assert.equal(database.prepare('SELECT version FROM assistant_inbox_meta').get().version, 16);
  assert.equal(inbox.status(source).cursorRevision, 1);
  assert.equal(inbox.incompleteDeliveries()[0].deliveryId, first.deliveryId);
  assert.equal(inbox.incompleteDeliveries()[0].events[0].owner_question_id, null);
  inbox.startDelivery(first.deliveryId); inbox.completeDelivery(first.deliveryId, 'old-completed');
  // Use the original injected clock for the next polling lease.
  const active = createAssistantInbox({ database, now: () => 1_300_000 });
  const question = randomUUID(), incoming = { ...event(task), ownerQuestionId: question };
  assert.equal(page(active, source, [incoming], 'owner-reply').added, 1);
  const restarted = createAssistantInbox({ database, now: () => 1_600_000 });
  const lease = restarted.claimPoll(source);
  assert.equal(restarted.commitPage(source, { ...lease, nextCursor: 'same', hasMore: true, events: [incoming] }).added, 0);
  assert.throws(() => restarted.commitPage(source, { ...restarted.claimPoll(source), nextCursor: 'changed', hasMore: false,
    events: [{ ...incoming, ownerQuestionId: randomUUID() }] }), { code: 'ASSISTANT_INBOX_EVENT_CHANGED' });
  const work = await restarted.claimDelivery({ authorize: authorized });
  assert.equal(work.events[0].owner_question_id, question);
  restarted.prepareTaskPass(work.deliveryId);
  assert.equal(restarted.incompleteDeliveries()[0].events[0].owner_question_id, question);
  assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n, 2);
});

test('question refs cannot smuggle content or create a wake from an ordinary event', t => {
  const { inbox } = memory(t), source = scope(), task = randomUUID(); inbox.register(source);
  for (const incoming of [{ ...event(task), ownerQuestionId: 'PRIVATE ANSWER' },
    { ...event(task, false), ownerQuestionId: randomUUID() }, { ...event(null), ownerQuestionId: randomUUID() }]) {
    assert.throws(() => page(inbox, source, [incoming]), { code: 'ASSISTANT_INBOX_INVALID_INPUT' });
  }
  assert.equal(inbox.status(source).cursorRevision, 0);
});

for(const provider of ['telegram','email','max'])test(`${provider} ACK waits for committed processing and preserves an uncertain delivery`,async t=>{
  const {inbox,database}=memory(t),source=scope({provider}),task=randomUUID();
  inbox.register(source);accept(inbox,source,task);page(inbox,source,[event(task)]);
  assert.equal(inbox.claimAcknowledgements(source),null,'queued metadata is not read content');
  const delivery=await inbox.claimDelivery({authorize:authorized});inbox.startDelivery(delivery.deliveryId);
  inbox.markDeliveryUncertain(delivery.deliveryId);
  assert.equal(inbox.claimAcknowledgements(source),null,'an unknown native outcome is not processing evidence');
  inbox.completeDelivery(delivery.deliveryId,'verified-native-receipt');
  assert.equal(inbox.claimAcknowledgements(source),null,'native completion alone does not prove a body read');
  fixtureProcessed(database);
  const ack=inbox.claimAcknowledgements(source);assert.equal(ack.events.length,1);
  assert.equal(ack.reconcileOnly,false);
  assert.throws(()=>inbox.completeAcknowledgements(source,ack.token),/STALE_ACK/,'a claim is not a provider invocation/read receipt');
  inbox.startExternalAcknowledgements(source,ack.token);
  inbox.completeAcknowledgements(source,ack.token);assert.equal(inbox.claimAcknowledgements(source),null);
});

test('an external ACK token from an older worker cannot mark an unprocessed batch read',t=>{
  const {inbox,database}=memory(t),source=scope({provider:'telegram'}),task=randomUUID();
  inbox.register(source);accept(inbox,source,task);page(inbox,source,[event(task),event(task)]);
  const token=randomUUID();
  database.prepare('UPDATE assistant_inbox_events SET ack_token=?,ack_expires_at=?').run(token,2000000);
  database.prepare('UPDATE assistant_inbox_events SET processed=1 WHERE rowid=(SELECT min(rowid) FROM assistant_inbox_events)').run();
  assert.throws(()=>inbox.completeAcknowledgements(source,token),/STALE_ACK/);
  assert.equal(database.prepare('SELECT count(*) AS total FROM assistant_inbox_events WHERE acked=1').get().total,0);
});

test('external ACK attempts survive expiry and restart as read-only recovery, never another write',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-ack-fence-')),file=path.join(directory,'queue.sqlite');
  let db=new DatabaseSync(file),timestamp=1_000_000;
  t.after(async()=>{db.close();await fs.rm(directory,{recursive:true,force:true});});
  let inbox=createAssistantInbox({database:db,now:()=>timestamp});
  const source=scope({provider:'telegram'}),task=randomUUID();inbox.register(source);accept(inbox,source,task);
  page(inbox,source,[event(task)]);
  const work=await inbox.claimDelivery({authorize:authorized});inbox.startDelivery(work.deliveryId);inbox.completeDelivery(work.deliveryId,'committed');fixtureProcessed(db);
  let ack=inbox.claimAcknowledgements(source);assert.equal(ack.reconcileOnly,false);
  timestamp+=120_001;ack=inbox.claimAcknowledgements(source);assert.equal(ack.reconcileOnly,false,'a crash before native invocation permits a fresh attempt');
  inbox.startExternalAcknowledgements(source,ack.token);
  assert.throws(()=>inbox.startExternalAcknowledgements(source,ack.token),/STALE_ACK/,'one use before provider I/O');
  db.close();db=new DatabaseSync(file);inbox=createAssistantInbox({database:db,now:()=>timestamp});
  assert.equal(inbox.claimAcknowledgements(source),null,'restart retains the exact active ACK lease');
  timestamp+=120_001;const reconcile=inbox.claimAcknowledgements(source);assert.equal(reconcile.reconcileOnly,true);
  assert.throws(()=>inbox.startExternalAcknowledgements(source,reconcile.token),/STALE_ACK/);
  assert.throws(()=>inbox.completeAcknowledgements(source,ack.token),/STALE_ACK/,'late native reply cannot complete a replacement lease');
  assert.throws(()=>inbox.deferExternalAcknowledgements(source,{token:reconcile.token,retryAfterMs:300_000,notAttempted:true}),/STALE_ACK/,
    'verify-only performs no write but cannot prove that the ORIGINAL write did not happen');
  inbox.deferExternalAcknowledgements(source,{token:reconcile.token,retryAfterMs:300_000});
  assert.throws(()=>inbox.completeAcknowledgements(source,reconcile.token),/STALE_ACK/,
    'backoff invalidates the original lease instead of extending it for late replies');
  assert.equal(inbox.claimAcknowledgements(source),null);timestamp+=300_001;
  const final=inbox.claimAcknowledgements(source);assert.equal(final.reconcileOnly,true);
  // Only the adapter's fresh native positive read-back may reach this commit;
  // the queue does not infer it from its own processed/attempted bits.
  inbox.completeAcknowledgements(source,final.token);
  assert.equal(inbox.claimAcknowledgements(source),null);
  assert.equal(db.prepare('SELECT acked FROM assistant_inbox_events').get().acked,1);
});

test('proved no-write result is bound to its own attempt; fresh and uncertain batches never mix',async t=>{
  const {inbox,database,advance}=memory(t),source=scope({provider:'email'}),task=randomUUID();inbox.register(source);accept(inbox,source,task);
  const process=async(id,cursor)=>{
    page(inbox,source,[event(task,true,id)],cursor);
    const work=await inbox.claimDelivery({authorize:authorized});inbox.startDelivery(work.deliveryId);inbox.completeDelivery(work.deliveryId,`committed-${id}`);fixtureProcessed(database);
  };
  await process('first','one');const first=inbox.claimAcknowledgements(source);inbox.startExternalAcknowledgements(source,first.token);
  inbox.deferExternalAcknowledgements(source,{token:first.token,retryAfterMs:300_000,notAttempted:true});
  assert.equal(inbox.claimAcknowledgements(source),null);advance(300_001);
  const fresh=inbox.claimAcknowledgements(source);assert.equal(fresh.reconcileOnly,false);inbox.startExternalAcknowledgements(source,fresh.token);
  inbox.deferExternalAcknowledgements(source,{token:fresh.token,retryAfterMs:30_000});advance(300_000);
  await process('second','two');const second=inbox.claimAcknowledgements(source);
  assert.equal(second.reconcileOnly,false);assert.deepEqual(second.events.map(row=>row.event_id),['second']);
  inbox.startExternalAcknowledgements(source,second.token);inbox.completeAcknowledgements(source,second.token);
  const old=inbox.claimAcknowledgements(source);assert.equal(old.reconcileOnly,true);assert.deepEqual(old.events.map(row=>row.event_id),['first']);
  inbox.setSourceState(source,{state:'paused',expectedRevision:0});inbox.setSourceState(source,{state:'active',expectedRevision:1});
  assert.throws(()=>inbox.completeAcknowledgements(source,old.token),/STALE_ACK/);
  const resumed=inbox.claimAcknowledgements(source);assert.equal(resumed.reconcileOnly,true,'source resume never clears an unknown write');
  assert.equal(database.prepare("SELECT acked FROM assistant_inbox_events WHERE event_id='first'").get().acked,0);
});

test('v4 ACK upgrade preserves cursors, streams and legacy uncertainty without changing Trelio ACK ABI',async t=>{
  const {inbox,database}=memory(t),external=scope({provider:'max'}),trelio=scope(),task=randomUUID();
  for(const source of [external,trelio]){
    inbox.register(source);accept(inbox,source,task);page(inbox,source,[event(task)],`original-${source.provider}`);
    const work=await inbox.claimDelivery({authorize:authorized});inbox.startDelivery(work.deliveryId);inbox.completeDelivery(work.deliveryId,`committed-${source.provider}`);fixtureProcessed(database);
    assert.ok(inbox.claimAcknowledgements(source));
  }
  const positions=database.prepare('SELECT source_key,cursor,cursor_revision FROM assistant_inbox_sources ORDER BY source_key').all();
  const streamCount=database.prepare('SELECT count(*) AS n FROM assistant_inbox_streams').get().n;
  removeRoutingColumns(database);
  database.exec('ALTER TABLE assistant_inbox_events DROP COLUMN ack_started; ALTER TABLE assistant_inbox_events DROP COLUMN ack_attempt_token; ALTER TABLE assistant_inbox_events DROP COLUMN ack_retry_at; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_recovery_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_continuation_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_code; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_stage; UPDATE assistant_inbox_meta SET version=4');
  const upgraded=createAssistantInbox({database,now:()=>3_000_000});
  assert.equal(database.prepare('SELECT version FROM assistant_inbox_meta').get().version,16);
  assert.deepEqual(database.prepare('SELECT source_key,cursor,cursor_revision FROM assistant_inbox_sources ORDER BY source_key').all(),positions);
  assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_inbox_streams').get().n,streamCount);
  const recovered=upgraded.claimAcknowledgements(external);assert.equal(recovered.reconcileOnly,true);
  assert.throws(()=>upgraded.deferExternalAcknowledgements(external,{token:recovered.token,retryAfterMs:30_000,notAttempted:true}),/STALE_ACK/);
  const ordinary=upgraded.claimAcknowledgements(trelio);assert.equal(Object.hasOwn(ordinary,'reconcileOnly'),false);
  upgraded.completeAcknowledgements(trelio,ordinary.token);
  assert.throws(()=>upgraded.startExternalAcknowledgements(trelio,ordinary.token),/INVALID_INPUT/);
});

test('exact suffix metadata lookup is source-scoped, literal, bounded and never alters processing or cursors', t => {
  const {inbox,database}=memory(t),source=scope({provider:'telegram'}),other={...source,bindingId:randomUUID()};
  inbox.register(source);inbox.register(other);
  page(inbox,source,[event(null,false,'message:123:5'),event(null,false,'message:123:25'),event(null,false,'message:321:5')]);
  page(inbox,other,[event(null,false,'message:999:7')]);
  const before=database.prepare('SELECT * FROM assistant_inbox_sources ORDER BY source_key').all();
  assert.deepEqual(inbox.findEventRefsBySuffix(source,[':5']),[{id:'message:123:5'},{id:'message:321:5'}]);
  assert.deepEqual(inbox.findEventRefsBySuffix(source,[':7']),[],'another binding cannot identify a peer');
  assert.deepEqual(inbox.findEventRefsBySuffix(source,[':%']),[],'wildcards remain literal SQL parameters');
  assert.throws(()=>inbox.findEventRefsBySuffix(source,[':5',':5']),/INVALID_INPUT/);
  assert.throws(()=>inbox.findEventRefsBySuffix(source,Array.from({length:101},(_,n)=>`:${n}`)),/INVALID_INPUT/);
  assert.deepEqual(database.prepare('SELECT * FROM assistant_inbox_sources ORDER BY source_key').all(),before);
  assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_inbox_events WHERE processed=1 OR acked=1').get().n,0);
});

test('durable child streams preserve new hints across concurrent final reads, restart and source pause',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-streams-')),file=path.join(directory,'queue.sqlite');
  let db=new DatabaseSync(file),other=new DatabaseSync(file),timestamp=1_000_000;
  t.after(async()=>{db.close();other.close();await fs.rm(directory,{recursive:true,force:true});});
  let first=createAssistantInbox({database:db,now:()=>timestamp});
  const second=createAssistantInbox({database:other,now:()=>timestamp}),source=scope({provider:'telegram'}),streamId='-1000000000055';
  first.register(source);
  const signal=(revision,events=[],hasMore=false)=>second.commitPage(source,{...second.claimPoll(source),nextCursor:`account-${revision}`,
    hasMore,events,streams:[{id:streamId,revision,initialCursor:`origin-seed-${revision}`}]});
  signal('hint-1',[],true);assert.equal(first.hasPendingStreams(source),true);
  const start=first.claimStreamPoll(source,streamId);assert.equal(start.cursor,null);
  assert.equal(start.initialCursor,'origin-seed-hint-1');
  assert.equal(second.claimStreamPoll(source,streamId),null,'one lease per child, shared with the other SQLite connection');
  const incoming=event(null,false,'message:-1000000000055:9');
  first.commitStreamPage(source,{...start,streamId,nextCursor:'history-1',hasMore:true,events:[incoming]});
  const final=first.claimStreamPoll(source,streamId);assert.equal(final.cursor,'history-1');
  timestamp++;signal('hint-2');
  first.commitStreamPage(source,{...final,streamId,nextCursor:'final-1',hasMore:false,events:[]});
  assert.equal(first.dueStreamPolls(source).length,1,'a newer native hint cannot be consumed by an older final read');
  const pending=first.claimStreamPoll(source,streamId);assert.equal(pending.generation,2);
  assert.equal(pending.initialCursor,'origin-seed-hint-1','newer hints cannot replace the earliest initial account checkpoint');
  db.close();db=new DatabaseSync(file);first=createAssistantInbox({database:db,now:()=>timestamp});
  assert.equal(first.claimStreamPoll(source,streamId),null,'restart retains the existing lease');
  timestamp+=120_001;
  const resumed=first.claimStreamPoll(source,streamId);assert.equal(resumed.cursor,'final-1');
  assert.throws(()=>second.commitStreamPage(source,{...pending,streamId,nextCursor:'stale',hasMore:false,events:[]}),{code:'ASSISTANT_INBOX_STALE_POLL'});
  first.commitStreamPage(source,{...resumed,streamId,nextCursor:'final-2',hasMore:false,events:[incoming]});
  assert.deepEqual(first.dueStreamPolls(source),[]);assert.equal(first.hasPendingStreams(source),false);
  assert.equal(first.status(source).pending,1,'replayed refs deduplicate in the account journal');
  timestamp+=300_000;signal('hint-2');assert.deepEqual(first.dueStreamPolls(source),[],'same checkpoint hint is idempotent');
  timestamp+=300_000;signal('hint-3');const interrupted=first.claimStreamPoll(source,streamId);
  first.setSourceState(source,{state:'paused',expectedRevision:0});first.setSourceState(source,{state:'active',expectedRevision:1});
  assert.throws(()=>first.commitStreamPage(source,{...interrupted,streamId,nextCursor:'revived',hasMore:false,events:[]}),{code:'ASSISTANT_INBOX_STALE_POLL'});
  const recovered=first.claimStreamPoll(source,streamId);assert.equal(recovered.cursor,'final-2');
  first.abandonStreamPoll(source,{...recovered,streamId,retryAfterMs:300_000});assert.deepEqual(first.dueStreamPolls(source),[]);
  assert.equal(first.hasPendingStreams(source),true,'backoff is not completion');
  assert.equal(first.claimAcknowledgements(source),null);
  assert.deepEqual(db.prepare('SELECT task_id,wake,processed,acked FROM assistant_inbox_events').get(),
    Object.assign(Object.create(null),{task_id:null,wake:0,processed:0,acked:0}));
});

test('legacy email unread streams remain intact across reopen but never become automatic pending work',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-email-history-retention-')),file=path.join(directory,'queue.sqlite');
  let db=new DatabaseSync(file);t.after(async()=>{db.close();await fs.rm(directory,{recursive:true,force:true});});
  const source=scope({provider:'email'}),streamId='email-initial-unread/v1';
  let inbox=createAssistantInbox({database:db,now:()=>1_000_000});inbox.register(source);
  inbox.commitPage(source,{...inbox.claimPoll(source),nextCursor:'original-forward',hasMore:false,events:[],
    streams:[{id:streamId,revision:'original-signal',initialCursor:'original-seed'}]});
  const before={...db.prepare('SELECT * FROM assistant_inbox_streams').get()};
  assert.equal(inbox.hasPendingStreams(source),false);assert.deepEqual(inbox.dueStreamPolls(source),[]);
  assert.equal(inbox.claimStreamPoll(source,streamId),null);
  db.close();db=new DatabaseSync(file);inbox=createAssistantInbox({database:db,now:()=>2_000_000});
  assert.equal(inbox.hasPendingStreams(source),false);assert.deepEqual(inbox.dueStreamPolls(source),[]);
  assert.equal(inbox.claimStreamPoll(source,streamId),null);
  assert.deepEqual({...db.prepare('SELECT * FROM assistant_inbox_streams').get()},before);
  assert.equal(inbox.claimPoll(source).cursor,'original-forward','forward polling continues from its durable checkpoint');
  inbox.setSourceState(source,{state:'paused',expectedRevision:0});
  assert.throws(()=>inbox.claimStreamPoll(source,streamId),/SOURCE_INACTIVE/,'legacy filtering still checks native source state');
});

test('stream hints and cursor roll back with conflicting refs or capacity; child pages retain the same event bounds',t=>{
  const {inbox,database,advance}=memory(t),source=scope({provider:'telegram'}),streamId='-1000000000055';inbox.register(source);
  const incoming=event(null,false,'message:-1000000000055:9');
  inbox.commitPage(source,{...inbox.claimPoll(source),nextCursor:'one',hasMore:true,events:[incoming],streams:[{id:streamId,revision:'hint-1'}]});
  const poll=inbox.claimPoll(source);
  assert.throws(()=>inbox.commitPage(source,{...poll,nextCursor:'lost',hasMore:false,
    events:[{...incoming,taskId:randomUUID()}],streams:[{id:streamId,revision:'hint-2'}]}),{code:'ASSISTANT_INBOX_EVENT_CHANGED'});
  assert.equal(database.prepare('SELECT signal_generation FROM assistant_inbox_streams').get().signal_generation,1);
  assert.equal(database.prepare('SELECT cursor FROM assistant_inbox_sources').get().cursor,'one');
  inbox.abandonPoll(source,{token:poll.token,retryAfterMs:300_000});
  const child=inbox.claimStreamPoll(source,streamId);
  assert.throws(()=>inbox.commitStreamPage(source,{...child,streamId,nextCursor:'lost-child',hasMore:true,
    events:[{...incoming,wake:true}]}),{code:'ASSISTANT_INBOX_EVENT_CHANGED'});
  assert.equal(database.prepare('SELECT cursor_revision FROM assistant_inbox_streams').get().cursor_revision,0);
  inbox.commitStreamPage(source,{...child,streamId,nextCursor:'done',hasMore:false,events:[incoming]});
  const sourceKey=database.prepare('SELECT source_key FROM assistant_inbox_sources').get().source_key;
  database.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9999)
    INSERT INTO assistant_inbox_streams(source_key,stream_id,signal_revision) SELECT ?,'fixture-'||x,'fixture' FROM n`).run(sourceKey);
  advance(300_000);
  assert.throws(()=>inbox.commitPage(source,{...inbox.claimPoll(source),nextCursor:'overflow',hasMore:false,
    events:[],streams:[{id:'new-stream',revision:'new-hint'}]}),{code:'ASSISTANT_INBOX_FULL'});
  assert.equal(database.prepare('SELECT cursor FROM assistant_inbox_sources').get().cursor,'one');
});

test('v3 to v4 stream upgrade preserves source cursors and started delivery ambiguity',async t=>{
  const {inbox,database}=memory(t),source=scope(),task=randomUUID();inbox.register(source);accept(inbox,source,task);
  page(inbox,source,[event(task)],'existing-cursor');const work=await inbox.claimDelivery({authorize:authorized});inbox.startDelivery(work.deliveryId);
  const before=database.prepare('SELECT * FROM assistant_inbox_deliveries').get();
  removeRoutingColumns(database);
  database.exec('DROP TABLE assistant_inbox_streams; ALTER TABLE assistant_inbox_events DROP COLUMN ack_started; ALTER TABLE assistant_inbox_events DROP COLUMN ack_attempt_token; ALTER TABLE assistant_inbox_events DROP COLUMN ack_retry_at; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_recovery_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_continuation_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_code; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_stage; UPDATE assistant_inbox_meta SET version=3');
  const upgraded=createAssistantInbox({database});
  assert.equal(database.prepare('SELECT version FROM assistant_inbox_meta').get().version,16);
  assert.deepEqual(database.prepare('SELECT * FROM assistant_inbox_deliveries').get(),before);
  assert.equal(database.prepare('SELECT cursor FROM assistant_inbox_sources').get().cursor,'existing-cursor');
  assert.equal(await upgraded.claimDelivery({authorize:authorized}),null);
});

const routedFixture=(t,provider='telegram')=>{
  const f=memory(t),canonical=scope(),external={...canonical,provider,accountId:randomUUID(),bindingId:randomUUID()},taskId=randomUUID();
  const bindingId=randomUUID(),conversationKey=`${provider}-conversation/v1.${'a'.repeat(64)}`;
  const route={id:randomUUID(),sourceId:external.bindingId,sourceRevision:2,conversationKey,bindingId,bindingRevision:4,taskId};
  f.inbox.register(canonical);f.inbox.register(external);f.inbox.observeExternalSourceRevision(external,2);
  f.inbox.applyTaskState(canonical,{taskId,state:'accepted',expectedRevision:0,authority:{bindingId,revision:4}});
  page(f.inbox,external,[{id:provider==='email'?'uid:17:11':'message:123:4',revision:'b'.repeat(64),taskId:null,wake:false,conversationKey,providerWake:true}]);
  const pending=f.inbox.pendingExternalRoutes(external);
  const mapping={canonicalSource:canonical,sourceRevision:2,eventKeys:pending.map(row=>row.event_key),routes:[route]};
  return {...f,canonical,external,taskId,route,pending,mapping};
};

test('email exact original bytes survive read/processing/restart; one UID ACK cannot cover another in its thread',async t=>{
  const {createAssistantSourceReadObserver}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const f=routedFixture(t,'email');f.inbox.routeExternalEvents(f.external,f.mapping);
  const work=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(work.deliveryId);
  const identity={origin:f.canonical.origin,assistantId:f.canonical.assistantId,deviceId:randomUUID()};
  const pass={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,companyId:f.canonical.companyId,
    taskId:f.taskId,passId:randomUUID(),deliveryId:work.deliveryId,threadId:randomUUID(),bindingId:f.route.bindingId,bindingRevision:f.route.bindingRevision};
  const source={id:f.external.bindingId,deviceId:identity.deviceId,localAccountId:f.external.accountId,projectId:null,
    revision:2,state:'active',skillId:'email-imap-smtp'};
  let sourceLive=true;
  const client={readTaskPass:async()=>({...pass,state:'leased',leaseExpiresAt:new Date(Date.now()+600000).toISOString()}),
    sourceAccounts:async()=>sourceLive?[source]:[],sourceRoutes:async()=>[f.route]};
  const observer=createAssistantSourceReadObserver({identity,client,host:{readActivePass:async()=>pass},withInbox:async action=>action(f.inbox)});
  const input={artifact:{skillId:'email-imap-smtp'},executionContext:{companyId:pass.companyId,projectId:null,account:{id:f.external.accountId}},
    runtimeArguments:['read-reference','--uid','11','--uid-validity','17','--expected-revision','b'.repeat(64),
      '--expected-conversation-key',f.route.conversationKey]};
  const raw={schemaVersion:1,protocol:'email-message-read/v1',reference:{id:'uid:17:11',uid:'11',uidValidity:'17',
    revision:'b'.repeat(64),conversationKey:f.route.conversationKey},originalSha256:'f'.repeat(64),
    message:{body:'PRIVATE_EMAIL_BODY'},coverage:{textComplete:true,attachmentsContentRead:false,otherMessagesIncluded:false},
    readState:{marksRead:false,readReceiptsSent:false}};
  const result={stdout:JSON.stringify(raw)},selected=[{sourceId:source.id,sourceRevision:2,routeId:f.route.id,eventOrdinal:0}];
  for(const extra of [{coverage:{...raw.coverage,textComplete:false}},{originalSha256:null},
    {reference:{...raw.reference,uidValidity:'18'}},{readState:{...raw.readState,marksRead:true}}]){
    const ticket=await observer.prepare(input);
    await assert.rejects(observer.commit(ticket,{stdout:JSON.stringify({...raw,...extra})}),/READ_INVALID/);
  }
  let ticket=await observer.prepare(input);sourceLive=false;
  await assert.rejects(observer.commit(ticket,result),/SCOPE_CHANGED/);sourceLive=true;
  ticket=await observer.prepare(input);await observer.commit(ticket,result);
  assert.deepEqual(await observer.confirmProcessing(pass,selected),selected);
  assert.equal(f.inbox.claimAcknowledgements(f.external),null,'even independently read bytes need committed material processing');
  ticket=await observer.prepare(input);
  await assert.rejects(observer.commit(ticket,{stdout:JSON.stringify({...raw,originalSha256:'e'.repeat(64)})}),/EVENT_CHANGED/,
    'same UID/UIDVALIDITY cannot silently switch independently observed original bytes');
  const receiptId=randomUUID(),nativeReceipt=`assistant:${receiptId}:codex:${pass.threadId}:${randomUUID()}`;
  f.inbox.completeDelivery(work.deliveryId,nativeReceipt,{processedSourceReferences:selected});
  const reopened=createAssistantInbox({database:f.database,now:()=>1_000_000}),ack=reopened.claimAcknowledgements(f.external);
  const refs=reopened.externalAcknowledgementReferences(f.external,{token:ack.token,sourceRevision:2});
  assert.equal(refs[0].originalSha256,raw.originalSha256);assert.equal(refs[0].receiptId,receiptId);
  assert.doesNotMatch(JSON.stringify(f.database.prepare('SELECT * FROM assistant_inbox_events').all()),/PRIVATE_EMAIL_BODY/);
  reopened.startExternalAcknowledgements(f.external,ack.token);reopened.deferExternalAcknowledgements(f.external,{token:ack.token,retryAfterMs:30000});
  f.advance(150000);
  const recovery=f.inbox.claimAcknowledgements(f.external);assert.equal(recovery.reconcileOnly,true);
  assert.equal(f.inbox.externalAcknowledgementReferences(f.external,{token:recovery.token,sourceRevision:2,verifyOnly:true})[0].originalSha256,raw.originalSha256);
});

test('actual v7 upgrade retains unknown ACK/source positions and never manufactures original-byte read evidence',t=>{
  const f=routedFixture(t);
  f.database.exec('ALTER TABLE assistant_inbox_events DROP COLUMN read_original_sha256; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_recovery_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_continuation_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_code; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_stage; UPDATE assistant_inbox_meta SET version=7');
  const before=f.database.prepare('SELECT * FROM assistant_inbox_events').get(),sources=f.database.prepare('SELECT * FROM assistant_inbox_sources').all();
  createAssistantInbox({database:f.database});
  const after=f.database.prepare('SELECT * FROM assistant_inbox_events').get();
  assert.equal(after.read_original_sha256,null);delete after.read_original_sha256;assert.deepEqual(after,before);
  assert.deepEqual(f.database.prepare('SELECT * FROM assistant_inbox_sources').all(),sources);
  assert.equal(f.database.prepare('SELECT version FROM assistant_inbox_meta').get().version,16);
});

test('two committed email UIDs in one conversation get separate fresh attempts and independent uncertain recovery',async t=>{
  const f=routedFixture(t,'email');f.advance(300000);
  page(f.inbox,f.external,[{id:'uid:17:12',revision:'c'.repeat(64),taskId:null,wake:false,
    conversationKey:f.route.conversationKey,providerWake:true}],'second');
  f.inbox.routeExternalEvents(f.external,{...f.mapping,eventKeys:f.inbox.pendingExternalRoutes(f.external).map(row=>row.event_key)});
  const work=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(work.deliveryId);
  for(const event of work.events)f.inbox.recordExternalRead(f.external,{deliveryId:work.deliveryId,eventKey:event.event_key,
    sourceRevision:2,routeId:f.route.id,originalSha256:'f'.repeat(64)});
  const selected=work.events.map(event=>({sourceId:f.external.bindingId,sourceRevision:2,routeId:f.route.id,eventOrdinal:event.event_ordinal}));
  f.inbox.completeDelivery(work.deliveryId,`assistant:${randomUUID()}:codex:${randomUUID()}:${randomUUID()}`,{processedSourceReferences:selected});
  const first=f.inbox.claimAcknowledgements(f.external);assert.equal(first.events.length,1);assert.equal(first.events[0].event_id,'uid:17:11');
  f.inbox.startExternalAcknowledgements(f.external,first.token);
  f.inbox.deferExternalAcknowledgements(f.external,{token:first.token,retryAfterMs:30000});
  const second=f.inbox.claimAcknowledgements(f.external);assert.equal(second.events.length,1);assert.equal(second.events[0].event_id,'uid:17:12');
  f.inbox.startExternalAcknowledgements(f.external,second.token);f.inbox.completeAcknowledgements(f.external,second.token);
  assert.equal(f.inbox.externalAcknowledgementHealth(f.external),'acknowledgement_uncertain','positive sibling Seen cannot erase the first unknown write');
  f.advance(30001);const recovery=f.inbox.claimAcknowledgements(f.external);
  assert.equal(recovery.reconcileOnly,true);assert.deepEqual(recovery.events.map(row=>row.event_id),['uid:17:11']);
});

test('known external refs wake the canonical task, never process/ACK from a native receipt alone',async t=>{
  const f=routedFixture(t);assert.equal(await f.inbox.claimDelivery({authorize:authorized}),null);
  f.inbox.routeExternalEvents(f.external,f.mapping);
  const work=await f.inbox.claimDelivery({authorize:async({scope,taskId})=>{
    assert.deepEqual(scope,f.canonical);assert.equal(taskId,f.taskId);return true;
  }});
  assert.deepEqual(work.scope,f.canonical);assert.equal(work.events.length,1);
  assert.equal(JSON.parse(work.events[0].event_scope_json).provider,'telegram');
  f.inbox.startDelivery(work.deliveryId);f.inbox.completeDelivery(work.deliveryId,'native-and-business');
  assert.equal(f.inbox.claimAcknowledgements(f.external),null);
  assert.equal(await f.inbox.claimDelivery({authorize:authorized}),null,'the same unread ref cannot cause a busy wake loop');
  const scheduled=await f.inbox.claimDelivery({authorize:authorized,scheduledTask:{scope:f.canonical,taskId:f.taskId}});
  assert.equal(scheduled.events[0].event_key,f.pending[0].event_key,'unprocessed work is retained for the next normal cycle');
  f.inbox.startDelivery(scheduled.deliveryId);
  const proof={deliveryId:scheduled.deliveryId,eventKey:f.pending[0].event_key,sourceRevision:2,routeId:f.route.id};
  for(const changed of [{routeId:randomUUID()},{sourceRevision:1},{eventKey:'c'.repeat(64)},{deliveryId:work.deliveryId}])
    assert.throws(()=>f.inbox.recordExternalRead(f.external,{...proof,...changed}),/CONFLICT|STALE_DELIVERY/);
  f.inbox.recordExternalRead(f.external,proof);
  assert.equal(f.inbox.claimAcknowledgements(f.external),null,'actual read without committed business outcome is still not processing');
  f.inbox.completeDelivery(scheduled.deliveryId,'native-and-business-with-read',{processedSourceReferences:[{sourceId:f.external.bindingId,sourceRevision:2,routeId:f.route.id,eventOrdinal:0}]});
  const ack=f.inbox.claimAcknowledgements(f.external);assert.equal(ack.events.length,1);assert.equal(ack.reconcileOnly,false);
  assert.equal(f.inbox.claimAcknowledgements(f.canonical),null,'native Trelio ACK never sees provider IDs');
  f.inbox.startExternalAcknowledgements(f.external,ack.token);f.inbox.completeAcknowledgements(f.external,ack.token);
});

test('routing rejects cross-company/current-task guesses and source changes retire old route/read evidence without cursor reset',async t=>{
  const f=routedFixture(t);
  assert.throws(()=>f.inbox.routeExternalEvents(f.external,{...f.mapping,canonicalSource:{...f.canonical,companyId:randomUUID()}}),/INVALID_INPUT/);
  assert.throws(()=>f.inbox.routeExternalEvents(f.external,{...f.mapping,routes:[{...f.route,bindingRevision:3}]}),/TASK_REQUIRED/);
  assert.throws(()=>f.inbox.routeExternalEvents(f.external,{...f.mapping,routes:[{...f.route,sourceId:randomUUID()}]}),/INVALID_INPUT/);
  f.inbox.routeExternalEvents(f.external,f.mapping);
  const before=f.inbox.status(f.external);f.inbox.observeExternalSourceRevision(f.external,3);
  assert.equal(f.inbox.status(f.external).cursorRevision,before.cursorRevision);
  assert.equal(await f.inbox.claimDelivery({authorize:authorized}),null);
  assert.throws(()=>f.inbox.routeExternalEvents(f.external,f.mapping),/CONFLICT/);
  const rows=f.database.prepare('SELECT task_id,dispatch_source_key,read_delivery_id,processed,acked FROM assistant_inbox_events').all();
  assert.deepEqual(rows.map(row=>({...row})),[{task_id:null,dispatch_source_key:null,read_delivery_id:null,processed:0,acked:0}]);
  f.inbox.routeExternalEvents(f.external,{...f.mapping,sourceRevision:3,routes:[]});
  assert.equal(await f.inbox.claimDelivery({authorize:authorized}),null,'successful absent lookup cannot preserve a stale target');
});

test('routing checks have persistent bounded fairness and immutable provider key snapshots',t=>{
  const f=routedFixture(t);
  const event={id:'message:123:4',revision:'b'.repeat(64),taskId:null,wake:false,conversationKey:f.route.conversationKey,providerWake:true};
  f.advance(300_000);
  assert.throws(()=>page(f.inbox,f.external,[{...event,conversationKey:`telegram-conversation/v1.${'c'.repeat(64)}`}]),/EVENT_CHANGED/);
  f.inbox.routeExternalEvents(f.external,{...f.mapping,routes:[]});
  assert.deepEqual(f.inbox.pendingExternalRoutes(f.external),[]);
  f.advance(300_000);assert.equal(f.inbox.pendingExternalRoutes(f.external).length,1);
});

test('true v5 upgrade retains cursors and uncertain delivery/ACK fences without inventing routing or body proof',async t=>{
  const f=routedFixture(t);f.inbox.routeExternalEvents(f.external,f.mapping);
  const work=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(work.deliveryId);
  f.inbox.markDeliveryUncertain(work.deliveryId);
  const before=f.database.prepare('SELECT * FROM assistant_inbox_deliveries').get();
  const positions=f.database.prepare('SELECT source_key,cursor,cursor_revision FROM assistant_inbox_sources ORDER BY source_key').all();
  removeRoutingColumns(f.database);f.database.exec('ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_recovery_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_continuation_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_code; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_stage; UPDATE assistant_inbox_meta SET version=5');
  const upgraded=createAssistantInbox({database:f.database,now:()=>1_000_000});
  assert.equal(f.database.prepare('SELECT version FROM assistant_inbox_meta').get().version,16);
  assert.deepEqual(f.database.prepare('SELECT * FROM assistant_inbox_deliveries').get(),before);
  assert.deepEqual(f.database.prepare('SELECT source_key,cursor,cursor_revision FROM assistant_inbox_sources ORDER BY source_key').all(),positions);
  assert.deepEqual(upgraded.pendingExternalRoutes(f.external),[]);
  assert.equal(upgraded.claimAcknowledgements(f.external),null);
  assert.equal(await upgraded.claimDelivery({authorize:authorized}),null);
});

test('a local source pause after fresh authorization still fences the one-use native start synchronously',async t=>{
  const f=routedFixture(t);f.inbox.routeExternalEvents(f.external,f.mapping);
  const job=await f.inbox.claimDelivery({authorize:authorized});
  f.inbox.prepareTaskPass(job.deliveryId);
  f.inbox.setSourceState(f.external,{state:'paused',expectedRevision:0});
  assert.throws(()=>f.inbox.startDelivery(job.deliveryId),/STALE_DELIVERY/);
  assert.equal(f.inbox.readDelivery(job.deliveryId).nativeStarted,false);
  f.inbox.setSourceState(f.external,{state:'active',expectedRevision:1});
  assert.throws(()=>f.inbox.startDelivery(job.deliveryId),/STALE_DELIVERY/,'resume cannot revive the retired routing snapshot');
  f.inbox.observeExternalSourceRevision(f.external,3);
  f.inbox.routeExternalEvents(f.external,{...f.mapping,sourceRevision:3,routes:[{...f.route,id:randomUUID(),sourceRevision:3}]});
  assert.throws(()=>f.inbox.startDelivery(job.deliveryId),/STALE_DELIVERY/,'a newly valid route cannot replace the original delivery snapshot');
  const recovered=f.inbox.incompleteDeliveries()[0];
  assert.equal(recovered.events[0].route_id,f.route.id);assert.equal(recovered.events[0].route_source_revision,2);
});

test('read-only routing failure backs off durably without inventing absence or changing an original delivery',async t=>{
  const f=routedFixture(t);f.inbox.routeExternalEvents(f.external,f.mapping);
  const job=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(job.deliveryId);
  f.advance(300_000);
  const pending=f.inbox.pendingExternalRoutes(f.external);assert.equal(pending.length,1);
  f.inbox.deferExternalRouting(f.external,{sourceRevision:2,eventKeys:pending.map(row=>row.event_key)});
  assert.deepEqual(f.inbox.pendingExternalRoutes(f.external),[]);
  const state=f.database.prepare('SELECT task_id,route_id FROM assistant_inbox_events').get();
  assert.equal(state.task_id,f.taskId);assert.equal(state.route_id,f.route.id);
  const restarted=createAssistantInbox({database:f.database,now:()=>1_300_000});
  assert.deepEqual(restarted.pendingExternalRoutes(f.external),[]);
  assert.equal(restarted.incompleteDeliveries()[0].state,'uncertain');
  assert.equal(restarted.readDelivery(job.deliveryId).state,'uncertain');
  assert.equal(restarted.incompleteDeliveries()[0].events[0].route_id,f.route.id);
});

test('new native key capability enriches legacy absence once without a cursor reset, guessed task or proof',t=>{
  const {inbox,database,advance}=memory(t),source=scope({provider:'telegram'});inbox.register(source);
  const ref={id:'message:123:1',revision:'b'.repeat(64),taskId:null,wake:false};
  page(inbox,source,[ref]);advance(300_000);
  const upgraded={...ref,conversationKey:`telegram-conversation/v1.${'a'.repeat(64)}`,providerWake:true};
  assert.equal(page(inbox,source,[upgraded],'upgraded').added,0);advance(300_000);
  assert.equal(page(inbox,source,[ref],'legacy-again').added,0);
  const row=database.prepare('SELECT conversation_key,provider_wake,task_id,processed,acked,read_delivery_id FROM assistant_inbox_events').get();
  assert.equal(row.conversation_key,upgraded.conversationKey);assert.equal(row.provider_wake,1);
  assert.equal(row.task_id,null);assert.equal(row.processed,0);assert.equal(row.acked,0);assert.equal(row.read_delivery_id,null);
  advance(300_000);
  assert.throws(()=>page(inbox,source,[{...upgraded,conversationKey:`telegram-conversation/v1.${'c'.repeat(64)}`}]),/EVENT_CHANGED/);
});

test('a new wake beyond a full unread context page is delivered once, with exact batch order retained on recovery',async t=>{
  const f=routedFixture(t);f.database.exec('UPDATE assistant_inbox_events SET dispatched=1');f.advance(300_000);
  const ref=id=>({id:`message:123:${id}`,revision:'b'.repeat(64),taskId:null,wake:false,
    conversationKey:f.route.conversationKey,providerWake:false});
  page(f.inbox,f.external,Array.from({length:100},(_,i)=>ref(i+10)),'old-context',true);
  const incoming={...ref(1000),providerWake:true};page(f.inbox,f.external,[incoming],'new-wake');
  for(let i=0;i<2;i++){
    const pending=f.inbox.pendingExternalRoutes(f.external);assert.ok(pending.length);
    f.inbox.routeExternalEvents(f.external,{...f.mapping,eventKeys:pending.map(row=>row.event_key)});
  }
  const work=await f.inbox.claimDelivery({authorize:authorized});
  assert.equal(work.events.length,100);assert.equal(work.events[0].event_id,incoming.id);
  assert.deepEqual(f.inbox.incompleteDeliveries()[0].events.map(row=>row.event_key),work.events.map(row=>row.event_key));
  f.inbox.startDelivery(work.deliveryId);f.inbox.completeDelivery(work.deliveryId,'native-unread-context');
  assert.equal(await f.inbox.claimDelivery({authorize:authorized}),null,'old unread context must not repeatedly hide/re-wake the new incoming event');
  assert.equal(f.inbox.claimAcknowledgements(f.external),null);
});

for(const provider of ['telegram','max'])test(`${provider} actual body observer uses original SQLite refs and native source/route before and after, but never processes by itself`,async t=>{
  const {createAssistantSourceReadObserver}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const max=provider==='max',f=routedFixture(t,provider);f.inbox.routeExternalEvents(f.external,f.mapping);
  const work=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(work.deliveryId);
  const identity={origin:f.canonical.origin,assistantId:f.canonical.assistantId,deviceId:randomUUID()};
  const pass={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,companyId:f.canonical.companyId,
    taskId:f.taskId,passId:randomUUID(),deliveryId:work.deliveryId,threadId:randomUUID(),bindingId:f.route.bindingId,bindingRevision:f.route.bindingRevision};
  const source={id:f.external.bindingId,deviceId:identity.deviceId,localAccountId:f.external.accountId,projectId:null,
    revision:2,state:'active',skillId:max?'max-web':'telegram-mtproto',...(max?{maxChatUrl:'https://web.max.ru/123'}:{})};
  let live=true,available=true,routes=true,reads=0;
  const client={readTaskPass:async()=>({...pass,state:live?'leased':'closed',leaseExpiresAt:new Date(Date.now()+600000).toISOString()}),
    sourceAccounts:async()=>{reads++;return available?[source]:[];},sourceRoutes:async()=>routes?[f.route]:[]};
  const observer=createAssistantSourceReadObserver({identity,client,host:{readActivePass:async()=>pass},withInbox:async action=>action(f.inbox)});
  const input={artifact:{skillId:max?'max-web':'telegram-mtproto'},executionContext:{companyId:pass.companyId,projectId:randomUUID(),account:{id:f.external.accountId}},
    runtimeArguments:['read-reference','--chat',max?'https://web.max.ru/123':'123','--message-id','4','--expected-revision','b'.repeat(64),
      '--expected-conversation-key',f.route.conversationKey]};
  const result={stdout:JSON.stringify({schemaVersion:1,protocol:max?'max-message-read/v1':'telegram-message-read/v1',
    reference:{id:'message:123:4',revision:'b'.repeat(64),conversationKey:f.route.conversationKey},
    message:{text:'PRIVATE_BODY_CANARY',textTruncated:false},coverage:{textComplete:true,attachmentsContentRead:false,contextIncluded:false,...(max?{nativeMessageVerified:true,otherMessagesIncluded:false}:{})},
    readState:{mode:'history-only',marksRead:false,readReceiptsSent:false,viewsRegistered:false}})};
  const selected=[{sourceId:source.id,sourceRevision:2,routeId:f.route.id,eventOrdinal:0}];
  await assert.rejects(observer.confirmProcessing(pass,selected),/SOURCE_READ_REQUIRED/);
  for(const args of [[...input.runtimeArguments,'--context','1'],input.runtimeArguments.slice(0,-2),
    input.runtimeArguments.map(value=>value===(max?'https://web.max.ru/123':'123')?(max?'https://web.max.ru/999':'999'):value)])await assert.rejects(observer.prepare({...input,runtimeArguments:args}),/SOURCE_READ_REQUIRED/);
  await assert.rejects(observer.prepare({...input,executionContext:{...input.executionContext,account:{id:randomUUID()}}}),/SOURCE_READ_REQUIRED/);
  let ticket=await observer.prepare(input);
  const incomplete=JSON.parse(result.stdout);incomplete.coverage.textComplete=false;
  await assert.rejects(observer.commit(ticket,{stdout:JSON.stringify(incomplete)}),/READ_INVALID/);
  await assert.rejects(observer.commit(ticket,result),/READ_REQUIRED/,'one ticket cannot be replayed after invalid output');
  ticket=await observer.prepare(input);available=false;
  await assert.rejects(observer.commit(ticket,result),/SCOPE_CHANGED/,'late source removal never publishes read evidence');available=true;
  ticket=await observer.prepare(input);routes=false;
  await assert.rejects(observer.commit(ticket,result),/SCOPE_CHANGED/,'native route loss after body I/O refuses evidence');routes=true;
  ticket=await observer.prepare(input);await observer.commit(ticket,result);
  assert.ok(reads>=6);assert.deepEqual(await observer.confirmProcessing(pass,selected),selected);
  assert.equal(f.inbox.claimAcknowledgements(f.external),null,'actual complete body read is not committed processing');
  assert.doesNotMatch(JSON.stringify(f.database.prepare('SELECT * FROM assistant_inbox_events').all()),/PRIVATE_BODY_CANARY/);
  f.inbox.completeDelivery(work.deliveryId,'native-and-business-but-no-selection');
  assert.equal(f.inbox.claimAcknowledgements(f.external),null,'whole-pass success with an omitted read slot never enables ACK');
  await assert.rejects(observer.prepare(input),/STALE_DELIVERY/,'closed delivery cannot acquire new read evidence');
});

test('granular completion needs both independent read slots and exact selected receipt; invalid subsets roll back the whole local commit',async t=>{
  const f=routedFixture(t);f.advance(300000);
  page(f.inbox,f.external,[{id:'message:123:5',revision:'c'.repeat(64),taskId:null,wake:false,
    conversationKey:f.route.conversationKey,providerWake:true}],'next-page');
  const pending=f.inbox.pendingExternalRoutes(f.external);
  f.inbox.routeExternalEvents(f.external,{...f.mapping,eventKeys:pending.map(row=>row.event_key)});
  const work=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(work.deliveryId);
  assert.deepEqual(work.events.map(row=>row.event_ordinal),[0,1]);
  const selection=index=>({sourceId:f.external.bindingId,sourceRevision:2,routeId:f.route.id,eventOrdinal:index});
  const read=index=>f.inbox.recordExternalRead(f.external,{deliveryId:work.deliveryId,eventKey:work.events[index].event_key,sourceRevision:2,routeId:f.route.id});
  read(0);
  assert.throws(()=>f.inbox.completeDelivery(work.deliveryId,'native-business-receipt',{processedSourceReferences:[selection(1)]}),/READ_REQUIRED/);
  assert.equal(f.inbox.readDelivery(work.deliveryId).state,'started');assert.equal(f.inbox.claimAcknowledgements(f.external),null);
  read(1);
  for(const refs of [[selection(0),selection(0)],[selection(1),selection(0)],[selection(2)],
    [{...selection(1),routeId:randomUUID()}],[{...selection(1),sourceRevision:3}]]){
    assert.throws(()=>f.inbox.completeDelivery(work.deliveryId,'native-business-receipt',{processedSourceReferences:refs}),/INVALID_INPUT|READ_REQUIRED/);
    assert.equal(f.inbox.readDelivery(work.deliveryId).state,'started');
  }
  f.inbox.completeDelivery(work.deliveryId,'native-business-receipt',{processedSourceReferences:[selection(1)]});
  assert.deepEqual(f.inbox.claimAcknowledgements(f.external).events.map(row=>row.event_id),['message:123:5']);
  assert.deepEqual(f.database.prepare('SELECT event_id,processed FROM assistant_inbox_events ORDER BY event_id').all()
    .map(row=>[row.event_id,row.processed]),[['message:123:4',0],['message:123:5',1]],'an omitted but actually read message remains pending');
});


test('ACK references require original read plus committed receipt; done permits historical ACK, never a new delivery',async t=>{
  const f=routedFixture(t);f.inbox.routeExternalEvents(f.external,f.mapping);
  const work=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(work.deliveryId);
  f.inbox.recordExternalRead(f.external,{deliveryId:work.deliveryId,eventKey:f.pending[0].event_key,sourceRevision:2,routeId:f.route.id});
  assert.equal(f.inbox.externalAcknowledgementDue(f.external),null);
  const receiptId=randomUUID(),receipt=`assistant:${receiptId}:codex:${randomUUID()}:${randomUUID()}`;
  f.inbox.completeDelivery(work.deliveryId,receipt,{processedSourceReferences:[{sourceId:f.external.bindingId,sourceRevision:2,routeId:f.route.id,eventOrdinal:0}]});
  const state=f.inbox.taskState(f.external,f.taskId);
  f.inbox.applyTaskState(f.external,{taskId:f.taskId,state:'done',expectedRevision:state.revision,authority:{...state.authority,revision:state.authority.revision+1}});
  assert.ok(f.inbox.externalAcknowledgementDue(f.external)>0);
  const ack=f.inbox.claimAcknowledgements(f.external);
  const refs=f.inbox.externalAcknowledgementReferences(f.external,{token:ack.token,sourceRevision:2});
  assert.deepEqual(refs,[{eventKey:f.pending[0].event_key,id:'message:123:4',revision:'b'.repeat(64),
    conversationKey:f.route.conversationKey,routeId:f.route.id,eventOrdinal:0,receiptId,taskId:f.taskId}]);
  assert.throws(()=>f.inbox.externalAcknowledgementReferences(f.external,{token:ack.token,sourceRevision:3}),/CONFLICT/);
  f.database.prepare('UPDATE assistant_inbox_events SET read_delivery_id=NULL').run();
  assert.throws(()=>f.inbox.externalAcknowledgementReferences(f.external,{token:ack.token,sourceRevision:2}),/STALE_ACK/);
  f.database.prepare('UPDATE assistant_inbox_events SET read_delivery_id=?').run(work.deliveryId);
  f.database.prepare('UPDATE assistant_inbox_deliveries SET external_receipt=?').run('model-said-processed');
  assert.throws(()=>f.inbox.externalAcknowledgementReferences(f.external,{token:ack.token,sourceRevision:2}),/READ_REQUIRED/);
  f.database.prepare('UPDATE assistant_inbox_deliveries SET external_receipt=?').run(receipt);
  f.inbox.startExternalAcknowledgements(f.external,ack.token);f.inbox.completeAcknowledgements(f.external,ack.token);
  assert.equal(f.inbox.externalAcknowledgementDue(f.external),null);
});

for(const started of [false,true])test(`resumed source reconciles an original ${started?'uncertain':'unattempted'} ACK without reviving its route or replaying a write`, async t=>{
  const f=routedFixture(t);f.inbox.routeExternalEvents(f.external,f.mapping);
  const work=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(work.deliveryId);
  f.inbox.recordExternalRead(f.external,{deliveryId:work.deliveryId,eventKey:f.pending[0].event_key,sourceRevision:2,routeId:f.route.id});
  f.inbox.completeDelivery(work.deliveryId,`assistant:${randomUUID()}:codex:${randomUUID()}:${randomUUID()}`,
    {processedSourceReferences:[{sourceId:f.external.bindingId,sourceRevision:2,routeId:f.route.id,eventOrdinal:0}]});
  const first=f.inbox.claimAcknowledgements(f.external);
  assert.throws(()=>f.inbox.externalAcknowledgementReferences(f.external,{token:first.token,sourceRevision:2,verifyOnly:true}),/READ_REQUIRED/,
    'the historical branch is only an already-started attempt read-back');
  if(started)f.inbox.startExternalAcknowledgements(f.external,first.token);
  const original=f.inbox.externalAcknowledgementReferences(f.external,{token:first.token,sourceRevision:2});
  f.inbox.setSourceState(f.external,{state:'paused',expectedRevision:0});
  f.inbox.setSourceState(f.external,{state:'active',expectedRevision:1});
  f.inbox.observeExternalSourceRevision(f.external,4);
  assert.throws(()=>f.inbox.completeAcknowledgements(f.external,first.token),/STALE_ACK/);
  const recovered=f.inbox.claimAcknowledgements(f.external);assert.equal(recovered.reconcileOnly,true);
  assert.throws(()=>f.inbox.externalAcknowledgementReferences(f.external,{token:recovered.token,sourceRevision:4}),/READ_REQUIRED/);
  assert.deepEqual(f.inbox.externalAcknowledgementReferences(f.external,{token:recovered.token,sourceRevision:4,verifyOnly:true}),original);
  assert.throws(()=>f.inbox.startExternalAcknowledgements(f.external,recovered.token),/STALE_ACK/,'uncertain attempts never restart the write');
  // The production adapter reaches this commit ONLY after positive native
  // read-back for all groups; the queue itself is not a provider read proof.
  f.inbox.completeAcknowledgements(f.external,recovered.token);
  assert.equal(f.inbox.externalAcknowledgementHealth(f.external),'ready');
  assert.equal(f.database.prepare('SELECT ack_verified_revision FROM assistant_inbox_sources WHERE configuration_revision=4').get().ack_verified_revision,4);
  assert.equal(f.database.prepare('SELECT route_source_revision FROM assistant_inbox_events WHERE processed=1').get().route_source_revision,2);
  assert.equal(f.inbox.externalAcknowledgementDue(f.external),null);
  const reopened=createAssistantInbox({database:f.database,now:()=>1_000_000});
  assert.equal(reopened.externalAcknowledgementDue(f.external),null);
  assert.equal(reopened.externalAcknowledgementHealth(f.external),'ready','a lost owner-health report is recoverable without another provider invocation');
  reopened.observeExternalSourceRevision(f.external,6);
  assert.equal(reopened.externalAcknowledgementHealth(f.external),null,'an older successful read-back cannot clear a new generation');
  assert.equal(f.database.prepare('SELECT ack_verified_revision FROM assistant_inbox_sources WHERE configuration_revision=6').get().ack_verified_revision,null);
});

test('actual v6 upgrade preserves all source/event/cursor/delivery state without inventing verification', t=>{
  const f=routedFixture(t);
  const tables=['sources','events','tasks','deliveries','delivery_events','streams'];
  f.database.exec('ALTER TABLE assistant_inbox_sources DROP COLUMN ack_verified_revision; ALTER TABLE assistant_inbox_events DROP COLUMN ack_verify_only; ALTER TABLE assistant_inbox_events DROP COLUMN read_original_sha256; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_recovery_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_continuation_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_code; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_stage; UPDATE assistant_inbox_meta SET version=6');
  const snapshot=()=>Object.fromEntries(tables.map(name=>[name,f.database.prepare(`SELECT * FROM assistant_inbox_${name}`).all()
    .map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['ack_verified_revision','ack_verify_only','read_original_sha256'].includes(key))))]));
  const before=snapshot();createAssistantInbox({database:f.database,now:()=>1_000_000});
  assert.equal(f.database.prepare('SELECT version FROM assistant_inbox_meta').get().version,16);
  assert.deepEqual(snapshot(),before);
  assert.ok(f.database.prepare('SELECT ack_verified_revision FROM assistant_inbox_sources').all().every(row=>row.ack_verified_revision===null));
});

test('new external tokens cover one conversation; legacy mixed attempts retain membership and are verify-only',t=>{
  const {inbox,database,advance}=memory(t),source={...scope(),provider:'telegram'},task=randomUUID();inbox.register(source);accept(inbox,source,task);
  const key=n=>'telegram-conversation/v1.'+n.repeat(64);
  page(inbox,source,[{...event(null,false),id:'message:123:4',conversationKey:key('a'),providerWake:true},
    {...event(null,false),id:'message:124:5',conversationKey:key('b'),providerWake:true}]);
  const keys=database.prepare('SELECT event_key FROM assistant_inbox_events').all().map(row=>row.event_key);
  inbox.routeEvents(source,{eventKeys:keys,taskId:task});fixtureProcessed(database);
  const first=inbox.claimAcknowledgements(source);assert.equal(first.events.length,1);
  inbox.startExternalAcknowledgements(source,first.token);
  const second=inbox.claimAcknowledgements(source);assert.equal(second.events.length,1);
  assert.notEqual(first.events[0].event_id,second.events[0].event_id);
  // This is the original state an older host could persist. Recovery must not
  // split or write it, nor let one chat's positive read-back complete both.
  database.prepare('UPDATE assistant_inbox_events SET ack_token=?,ack_attempt_token=?,ack_started=1').run(first.token,first.token);
  advance(120001);
  const recovery=inbox.claimAcknowledgements(source);assert.equal(recovery.reconcileOnly,true);assert.equal(recovery.events.length,2);
  assert.throws(()=>inbox.startExternalAcknowledgements(source,recovery.token),/STALE_ACK/);
});

test('discovery bounds never split an interleaved original uncertain ACK attempt',t=>{
  const {inbox,database,advance}=memory(t),source=scope({provider:'telegram'}),taskId=randomUUID();
  inbox.register(source);accept(inbox,source,taskId);
  page(inbox,source,Array.from({length:100},(_,index)=>event(taskId,true,`message:123:${index+1}`)),'first',true);
  page(inbox,source,[event(taskId,true,'message:456:1')],'last');fixtureProcessed(database);
  const selected=randomUUID(),other=randomUUID();
  database.prepare('UPDATE assistant_inbox_events SET ack_started=1,ack_attempt_token=?').run(other);
  database.prepare('UPDATE assistant_inbox_events SET ack_attempt_token=? WHERE event_id IN (?,?)').run(selected,'message:123:1','message:456:1');
  const recovery=inbox.claimAcknowledgements(source);assert.equal(recovery.reconcileOnly,true);
  assert.deepEqual(recovery.events.map(row=>row.event_id),['message:123:1','message:456:1']);
  assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_inbox_events WHERE ack_attempt_token=? AND ack_token IS NULL').get(other).n,99);
  assert.throws(()=>inbox.startExternalAcknowledgements(source,recovery.token),/STALE_ACK/);
});

test('one expired member rejects completion of the WHOLE ACK token without erasing its attempt fence',t=>{
  const {inbox,database}=memory(t),source=scope({provider:'telegram'}),taskId=randomUUID();
  inbox.register(source);accept(inbox,source,taskId);
  page(inbox,source,[event(taskId,true,'message:123:1'),event(taskId,true,'message:123:2')]);fixtureProcessed(database);
  const ack=inbox.claimAcknowledgements(source);assert.equal(ack.events.length,2);
  inbox.startExternalAcknowledgements(source,ack.token);
  database.prepare('UPDATE assistant_inbox_events SET ack_expires_at=0 WHERE event_id=?').run('message:123:1');
  assert.throws(()=>inbox.completeAcknowledgements(source,ack.token),/STALE_ACK/);
  assert.ok(database.prepare('SELECT acked,ack_started,ack_token FROM assistant_inbox_events').all()
    .every(row=>row.acked===0&&row.ack_started===1&&row.ack_token===ack.token));
});

test('a repeatedly deferred first conversation does not starve later eligible ACK work',t=>{
  const {inbox,database,advance}=memory(t),source=scope({provider:'telegram'}),taskId=randomUUID();
  inbox.register(source);accept(inbox,source,taskId);
  page(inbox,source,[{...event(null,false,'message:123:1'),conversationKey:'telegram-conversation/v1.'+'a'.repeat(64),providerWake:true},
    {...event(null,false,'message:456:1'),conversationKey:'telegram-conversation/v1.'+'b'.repeat(64),providerWake:true}]);
  inbox.routeEvents(source,{eventKeys:database.prepare('SELECT event_key FROM assistant_inbox_events').all().map(row=>row.event_key),taskId});
  fixtureProcessed(database);
  const first=inbox.claimAcknowledgements(source);assert.equal(first.events[0].event_id,'message:123:1');
  inbox.deferExternalAcknowledgements(source,{token:first.token,retryAfterMs:300000});
  advance(300001);
  const second=inbox.claimAcknowledgements(source);assert.equal(second.events[0].event_id,'message:456:1');
  inbox.deferExternalAcknowledgements(source,{token:second.token,retryAfterMs:300000});
  assert.equal(inbox.claimAcknowledgements(source).events[0].event_id,'message:123:1');
});

test('ACK diagnostic uses durable attempts across conversations and restarts, never an empty queue as recovery',async t=>{
  const f=routedFixture(t);assert.equal(f.inbox.externalAcknowledgementHealth(f.external),null);
  assert.throws(()=>f.inbox.externalAcknowledgementHealth(f.canonical),/INVALID_INPUT/);
  f.inbox.routeExternalEvents(f.external,f.mapping);
  const work=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(work.deliveryId);
  f.inbox.recordExternalRead(f.external,{deliveryId:work.deliveryId,eventKey:f.pending[0].event_key,sourceRevision:2,routeId:f.route.id});
  f.inbox.completeDelivery(work.deliveryId,`assistant:${randomUUID()}:codex:${randomUUID()}:${randomUUID()}`,{
    processedSourceReferences:[{sourceId:f.external.bindingId,sourceRevision:2,routeId:f.route.id,eventOrdinal:0}]});
  let ack=f.inbox.claimAcknowledgements(f.external);assert.equal(f.inbox.externalAcknowledgementHealth(f.external),null,'a claim is not an attempt');
  f.inbox.startExternalAcknowledgements(f.external,ack.token);
  assert.equal(f.inbox.externalAcknowledgementHealth(f.external),'acknowledgement_uncertain');
  f.inbox.deferExternalAcknowledgements(f.external,{token:ack.token,retryAfterMs:300_000,notAttempted:true});
  assert.equal(f.inbox.externalAcknowledgementHealth(f.external),'acknowledgement_blocked');
  f.advance(300001);ack=f.inbox.claimAcknowledgements(f.external);f.inbox.startExternalAcknowledgements(f.external,ack.token);
  f.inbox.completeAcknowledgements(f.external,ack.token);assert.equal(f.inbox.externalAcknowledgementHealth(f.external),'ready');
  const recovered=createAssistantInbox({database:f.database});
  assert.equal(recovered.externalAcknowledgementHealth(f.external),'ready','durable positive result survives a lost native health report');
  f.inbox.observeExternalSourceRevision(f.external,3);
  assert.equal(f.inbox.externalAcknowledgementHealth(f.external),null,'old-generation success never claims fresh source recovery');
});

test('intake cancellation resumes only after positive native closure and explicit source generation; no unknown-create replay',t=>{
 const {inbox,database}=memory(t),source=scope({provider:'telegram'}),key=`telegram-conversation/v1.${'f'.repeat(64)}`;
 inbox.register(source);inbox.observeExternalSourceRevision(source,0);
 page(inbox,source,[{id:'message:123:4',revision:'a'.repeat(64),conversationKey:key,taskId:null,wake:false,providerWake:true,ownerIdentityId:randomUUID()}]);
 const row=inbox.ownerIntakes()[0];inbox.prepareOwnerIntake(row.id);inbox.startOwnerIntakeProvision(row.id);inbox.bindOwnerIntakeThread(row.id,randomUUID());
 inbox.readyOwnerIntake(row.id);inbox.startOwnerIntake(row.id);inbox.uncertainOwnerIntake(row.id);
 inbox.setSourceState(source,{state:'paused',expectedRevision:0});inbox.observeExternalSourceRevision(source,1);
 inbox.setSourceState(source,{state:'active',expectedRevision:1});inbox.observeExternalSourceRevision(source,2);
 assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_owner_intakes').get().n,1,'source resume alone cannot duplicate an unknown native create');
 const receiptId=randomUUID();inbox.finishOwnerIntake(row.id,{receiptId,state:'cancelled'});
 inbox.observeExternalSourceRevision(source,2);
 const next=inbox.ownerIntakes()[0];assert.notEqual(next.id,row.id);assert.equal(next.original_event_id,row.original_event_id);
 assert.equal(next.source_revision,2);assert.equal(next.state,'pending');
 assert.equal(inbox.ownerIntake(row.id).outcome_receipt,receiptId,'positive old receipt remains immutable');
 inbox.observeExternalSourceRevision(source,2);assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_owner_intakes').get().n,2);
 assert.equal(database.prepare('SELECT sum(processed) AS p,sum(acked) AS a FROM assistant_inbox_events').get().p,0);
});


test('a bounded intake page keeps future rows behind due work and unknown native fences first',t=>{
 const {inbox,database,advance}=memory(t),first=scope({provider:'telegram'}),second={...first,companyId:randomUUID(),bindingId:randomUUID()};
 const ownerIdentityId=randomUUID(),key=`telegram-conversation/v1.${'a'.repeat(64)}`;
 inbox.register(first);inbox.observeExternalSourceRevision(first,0);
 page(inbox,first,Array.from({length:100},(_,index)=>({id:`message:123:${index+1}`,revision:'a'.repeat(64),
  conversationKey:key,taskId:null,wake:false,providerWake:true,ownerIdentityId})));
 const old=inbox.ownerIntakes()[0];for(const row of inbox.ownerIntakes())inbox.deferOwnerIntake(row.id);
 advance(1);inbox.register(second);inbox.observeExternalSourceRevision(second,0);
 page(inbox,second,[{id:'message:123:101',revision:'a'.repeat(64),conversationKey:key,taskId:null,wake:false,providerWake:true,ownerIdentityId}]);
 assert.equal(inbox.ownerIntakes().length,100);assert.equal(inbox.ownerIntakes()[0].scope.companyId,second.companyId);
 assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_owner_intakes').get().n,101);
 inbox.prepareOwnerIntake(old.id);inbox.startOwnerIntakeProvision(old.id);
 assert.equal(inbox.ownerIntakes()[0].id,old.id,'an unknown native invocation retains priority even over a due row');
 assert.equal(database.prepare('SELECT sum(processed) AS p,sum(acked) AS a FROM assistant_inbox_events').get().p,0);
});

for(const provider of ['telegram','email','max'])test(`${provider} triage batches originals before freeze, dedups physical accounts and rebases only observed selected refs`,t=>{
  const {inbox,database,advance}=memory(t),origin=scope({provider}),target={...origin,companyId:randomUUID(),bindingId:randomUUID()};
  for(const selected of [origin,target]){inbox.register(selected);inbox.observeExternalSourceRevision(selected,1);}
  const key=`${provider}-conversation/v1.${'a'.repeat(64)}`,selectedKey=`${provider}-conversation/v1.${'b'.repeat(64)}`;
  const refs=[1,2].map(i=>({id:provider==='email'?`uid:17:${i}`:`message:123:${i}`,revision:String(i).repeat(64),taskId:null,wake:false,providerWake:true,conversationKey:key}));
  page(inbox,origin,refs);let pending=inbox.pendingExternalRoutes(origin);
  inbox.queueExistingTaskIntakes(origin,{sourceRevision:1,eventKeys:pending.map(row=>row.event_key)});
  assert.equal(inbox.ownerIntakes().length,1);let row=inbox.ownerIntake(inbox.ownerIntakes()[0].id);
  assert.equal(row.kind,'route_existing');assert.equal(row.owner_identity_id,null);assert.equal(row.eventIds.length,2);
  const frozen=inbox.freezeExistingTaskIntake(row.id),ids=[...frozen.eventIds];
  advance(300001);page(inbox,origin,[{...refs[0],id:provider==='email'?'uid:17:3':'message:123:3'}],'later');
  inbox.queueExistingTaskIntakes(origin,{sourceRevision:1,eventKeys:inbox.pendingExternalRoutes(origin).map(event=>event.event_key)});
  assert.deepEqual(inbox.ownerIntake(row.id).eventIds,ids,'an admitted batch cannot absorb later originals');
  const receiptId=randomUUID();inbox.finishOwnerIntake(row.id,{state:'redirected',receiptId});
  assert.throws(()=>inbox.redirectOwnerIntake(row.id,{scope:target,sourceRevision:1,receiptId}),{code:'ASSISTANT_INTAKE_SELECTED_REFERENCE_REQUIRED'});
  assert.equal(inbox.ownerIntakes().length,1,'absence never creates guessed target references/chat');
  page(inbox,target,refs.map(ref=>({...ref,conversationKey:selectedKey,...(provider==='email'?{revision:'c'.repeat(64)}:{})})));
  inbox.queueExistingTaskIntakes(target,{sourceRevision:1,eventKeys:inbox.pendingExternalRoutes(target).map(event=>event.event_key)});
  assert.equal(inbox.ownerIntakes().length,1,'same physical originals do not start a second company classification');
  const cloned=inbox.redirectOwnerIntake(row.id,{scope:target,sourceRevision:1,receiptId}),selected=inbox.ownerIntake(cloned.id);
  assert.deepEqual(selected.eventIds,ids);assert.equal(selected.conversation_key,selectedKey);assert.equal(selected.redirect_from_intake_id,row.id);
  assert.equal(selected.kind,'route_existing');assert.equal(selected.owner_identity_id,null);assert.equal(selected.thread_id,null);
  assert.ok(selected.originals.every(ref=>database.prepare('SELECT source_key,conversation_key FROM assistant_inbox_events WHERE event_key=?').get(ref.event_key).conversation_key===selectedKey));
  assert.deepEqual(inbox.redirectOwnerIntake(row.id,{scope:target,sourceRevision:1,receiptId}),cloned,'exact structural retry retains clone UUID');
  assert.equal(database.prepare('SELECT sum(processed)+sum(acked) AS n FROM assistant_inbox_events').get().n,0);
});

test('schema16 retains an exact reply attempt/positive across reopen without fabricating a task or ACK',t=>{
 const {inbox,database}=memory(t),source=scope({provider:'telegram'});
 inbox.register(source);inbox.observeExternalSourceRevision(source,0);
 page(inbox,source,[{id:'message:123:8',revision:'b'.repeat(64),taskId:null,wake:false,providerWake:true,
  conversationKey:`telegram-conversation/v1.${'a'.repeat(64)}`,ownerIdentityId:randomUUID()}]);
 const original=inbox.ownerIntakes()[0];inbox.prepareOwnerIntake(original.id);inbox.startOwnerIntakeProvision(original.id);
 inbox.bindOwnerIntakeThread(original.id,randomUUID());inbox.readyOwnerIntake(original.id);inbox.startOwnerIntake(original.id);
 database.exec('ALTER TABLE assistant_owner_intakes DROP COLUMN reply_receipt_id; ALTER TABLE assistant_owner_intakes DROP COLUMN reply_message_id; UPDATE assistant_inbox_meta SET version=15');
 let current=createAssistantInbox({database});const row=current.ownerIntake(original.id),receiptId=randomUUID();
 assert.equal(row.native_started,1);assert.equal(row.state,'started');assert.equal(row.reply_receipt_id,null);assert.equal(row.reply_message_id,null);
 assert.throws(()=>current.finishOwnerIntake(row.id,{state:'replied',receiptId}),/CONFLICT/);
 current.startOwnerReply(row.id,receiptId);current=createAssistantInbox({database});
 assert.throws(()=>current.startOwnerReply(row.id,receiptId),/CONFLICT/);
 assert.throws(()=>current.confirmOwnerReply(row.id,{receiptId:randomUUID(),messageId:91}),/CONFLICT/);
 current.uncertainOwnerIntake(row.id);current.confirmOwnerReply(row.id,{receiptId,messageId:91});
 current=createAssistantInbox({database});
 assert.equal(current.ownerIntake(row.id).reply_message_id,91);
 assert.throws(()=>current.confirmOwnerReply(row.id,{receiptId,messageId:92}),/CONFLICT/);
 current.finishOwnerIntake(row.id,{receiptId,state:'replied'});
 assert.equal(current.ownerIntakes().length,0);
 assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_inbox_deliveries').get().n,0);
 assert.equal(database.prepare('SELECT sum(processed)+sum(acked) AS n FROM assistant_inbox_events').get().n,0);
});

test('actual v9 owner-intake migration retains original identities, unknown native fences and receipts',t=>{
  const {database,inbox}=memory(t),source=scope({provider:'telegram'});inbox.register(source);inbox.observeExternalSourceRevision(source,4);
  page(inbox,source,[{id:'message:123:1',revision:'a'.repeat(64),taskId:null,wake:false,providerWake:true,
    conversationKey:`telegram-conversation/v1.${'b'.repeat(64)}`,ownerIdentityId:randomUUID()}]);
  const old=inbox.ownerIntake(inbox.ownerIntakes()[0].id);inbox.prepareOwnerIntake(old.id);inbox.startOwnerIntakeProvision(old.id);
  // Reconstruct the actual v9 table shape, rather than merely downgrading the
  // marker of the new schema. This catches SQLite FK retargeting on rename.
  database.exec(`DROP TABLE assistant_source_intake_events; DROP INDEX assistant_route_intake_active;
    ALTER TABLE assistant_owner_intakes DROP COLUMN outcome_route_id;
    ALTER TABLE assistant_owner_intakes DROP COLUMN outcome_task_id;
    ALTER TABLE assistant_owner_intakes DROP COLUMN conversation_key;
    ALTER TABLE assistant_owner_intakes DROP COLUMN redirect_from_intake_id;
    ALTER TABLE assistant_owner_intakes DROP COLUMN frozen;
    ALTER TABLE assistant_owner_intakes DROP COLUMN kind; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_recovery_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_continuation_json; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_code; ALTER TABLE assistant_inbox_deliveries DROP COLUMN failure_stage; UPDATE assistant_inbox_meta SET version=9;`);
  const restored=createAssistantInbox({database,now:()=>1_000_000}).ownerIntake(old.id);
  assert.equal(database.prepare('SELECT version FROM assistant_inbox_meta').get().version,16);
  for(const field of ['id','original_event_id','event_key','account_key','native_event_id','native_revision','owner_identity_id','source_key','source_revision','provision_id','delivery_id'])
    assert.equal(restored[field],old[field]);
  assert.equal(restored.state,'provisioning');assert.equal(restored.native_started,1);
  assert.equal(restored.kind,'owner_command');assert.deepEqual(restored.eventIds,[old.original_event_id]);
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length,0);
});

for(const provider of ['telegram','email','max'])test(`${provider} positive known route supersedes only unstarted local triage of the same physical original`,t=>{
 const {inbox,database}=memory(t),source=scope({provider}),target={...source,companyId:randomUUID(),bindingId:randomUUID()},taskId=randomUUID();
 const canonical={...target,provider:'trelio',accountId:randomUUID(),bindingId:randomUUID()};
 for(const selected of [source,target]){inbox.register(selected);inbox.observeExternalSourceRevision(selected,1);}inbox.register(canonical);
 const key=`${provider}-conversation/v1.${'a'.repeat(64)}`,targetKey=`${provider}-conversation/v1.${'b'.repeat(64)}`;
 const native={id:provider==='email'?'uid:17:1':'message:123:1',revision:'a'.repeat(64),taskId:null,wake:false,providerWake:true,conversationKey:key};
 page(inbox,source,[native]);const keys=inbox.pendingExternalRoutes(source).map(event=>event.event_key);inbox.queueExistingTaskIntakes(source,{sourceRevision:1,eventKeys:keys});
 const bindingId=randomUUID();inbox.applyTaskState(canonical,{taskId,state:'accepted',expectedRevision:0,authority:{bindingId,revision:0}});
 page(inbox,target,[{...native,conversationKey:targetKey,...(provider==='email'?{revision:'c'.repeat(64)}:{})}]);
 const targetKeys=inbox.pendingExternalRoutes(target).map(event=>event.event_key),routes=[{id:randomUUID(),sourceId:target.bindingId,sourceRevision:1,conversationKey:targetKey,taskId,bindingId,bindingRevision:0}];
 inbox.routeExternalEvents(target,{canonicalSource:canonical,sourceRevision:1,eventKeys:targetKeys,routes});
 assert.equal(inbox.ownerIntakes().length,0,'positive native mapping removes a still-local competing classification');
 inbox.queueExistingTaskIntakes(source,{sourceRevision:1,eventKeys:keys});assert.equal(inbox.ownerIntakes().length,0,'later ticks use the positive native route, no new model/question');
 assert.equal(database.prepare('SELECT sum(processed)+sum(acked) AS n FROM assistant_inbox_events').get().n,0);
});

test('ordinary task hint uses only the exact settled routed receipt; read/ACK selectors and owner commands gain no hint',t=>{
 const {inbox,database}=memory(t),source=scope({provider:'telegram'}),canonical={...source,provider:'trelio',accountId:randomUUID(),bindingId:randomUUID()};
 inbox.register(source);inbox.observeExternalSourceRevision(source,1);inbox.register(canonical);
 const key=`telegram-conversation/v1.${'a'.repeat(64)}`;
 page(inbox,source,[{id:'message:123:1',revision:'a'.repeat(64),taskId:null,wake:false,providerWake:true,conversationKey:key}]);
 const keys=inbox.pendingExternalRoutes(source).map(event=>event.event_key);inbox.queueExistingTaskIntakes(source,{sourceRevision:1,eventKeys:keys});
 const intake=inbox.ownerIntakes()[0],taskId=randomUUID(),bindingId=randomUUID(),routeId=randomUUID();
 inbox.applyTaskState(canonical,{taskId,state:'accepted',expectedRevision:0,authority:{bindingId,revision:0}});
 const route={id:routeId,sourceId:source.bindingId,sourceRevision:1,conversationKey:key,taskId,bindingId,bindingRevision:0};
 inbox.finishOwnerIntake(intake.id,{state:'routed',receiptId:randomUUID(),route,taskId});
 inbox.routeExternalEvents(source,{canonicalSource:canonical,sourceRevision:1,eventKeys:keys,routes:[route],intakeId:intake.id});
 const selector={eventKey:keys[0],routeId,sourceRevision:1};assert.equal(inbox.sourceIntakeKind(selector),null,'route without settled permanent task dispatch is no hint');
 inbox.settleOwnerIntake(intake.id);assert.equal(inbox.sourceIntakeKind(selector),'route_existing');
 assert.equal(inbox.sourceIntakeKind({...selector,routeId:randomUUID()}),null);
 database.prepare('UPDATE assistant_inbox_events SET task_id=? WHERE event_key=?').run(randomUUID(),keys[0]);
 assert.equal(inbox.sourceIntakeKind(selector),null,'a later target must not inherit another receipt hint');
 assert.equal(database.prepare('SELECT sum(processed)+sum(acked) AS n FROM assistant_inbox_events').get().n,0);
});


test('MAX full native dialog hints use SAME atomic stream journal up to 1000, while failed inserts keep every original position',t=>{
  const {inbox,database}=memory(t),source=scope({provider:'max'});inbox.register(source);
  const hints=Array.from({length:1000},(_,n)=>({id:String(n+1),revision:'native-dialogs-1',initialCursor:'original-account-seed'}));
  const poll=inbox.claimPoll(source);
  database.exec("CREATE TRIGGER fail_max_dialog BEFORE INSERT ON assistant_inbox_streams WHEN NEW.stream_id='1000' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>inbox.commitPage(source,{...poll,nextCursor:'never-durable',hasMore:false,events:[],streams:hints}));
  assert.equal(database.prepare('SELECT count(*) n FROM assistant_inbox_streams').get().n,0);assert.equal(database.prepare('SELECT cursor FROM assistant_inbox_sources').get().cursor,null);
  database.exec('DROP TRIGGER fail_max_dialog');
  inbox.commitPage(source,{...poll,nextCursor:'account-complete',hasMore:false,events:[],streams:hints});
  assert.equal(database.prepare('SELECT count(*) n FROM assistant_inbox_streams').get().n,1000);
  assert.equal(database.prepare('SELECT count(*) n FROM assistant_inbox_events').get().n,0);assert.equal(inbox.claimAcknowledgements(source),null);
  const child=inbox.claimStreamPoll(source,'77');assert.equal(child.initialCursor,'original-account-seed');
  inbox.commitStreamPage(source,{...child,streamId:'77',nextCursor:'history-final',hasMore:false,events:[event(null,false,'message:77:11')]});
  assert.equal(database.prepare("SELECT cursor FROM assistant_inbox_streams WHERE stream_id='77'").get().cursor,'history-final');
  const ordinary=scope({provider:'telegram'});inbox.register(ordinary);
  assert.throws(()=>inbox.commitPage(ordinary,{...inbox.claimPoll(ordinary),nextCursor:'bad',hasMore:false,events:[],streams:hints}),/INVALID_INPUT/);
  assert.equal(database.prepare('SELECT cursor FROM assistant_inbox_sources WHERE scope_json LIKE ?').get('%'+ordinary.bindingId+'%').cursor,null,'MAX inventory bound never raises event or other-provider page bounds');
});


test('pre-native claim recovery preserves the first closed preflight cause through a later lease-review refusal',async t=>{
  const f=memory(t),source=scope(),taskId=randomUUID();f.inbox.register(source);accept(f.inbox,source,taskId);
  page(f.inbox,source,[{id:'original-mention',revision:'1',taskId,wake:true}]);
  const job=await f.inbox.claimDelivery({authorize:async()=>true});f.inbox.prepareTaskPass(job.deliveryId);
  const original=assistantDeliveryFailure('ASSISTANT_CODEX_UNAVAILABLE','native_preflight');
  f.inbox.markDeliveryUncertain(job.deliveryId,original);
  // SAME durable ID may retry only the native claim because its launch bit is
  // still zero. The ensuing expired server lease is a later symptom, not the
  // original reason the usable native turn never started.
  f.inbox.prepareTaskPass(job.deliveryId);
  f.inbox.markDeliveryUncertain(job.deliveryId,assistantDeliveryFailure('ASSISTANT_PASS_REVIEW_REQUIRED','native_claim'));
  const row=f.database.prepare('SELECT state,native_started,failure_code,failure_stage FROM assistant_inbox_deliveries').get();
  assert.deepEqual({...row},{state:'uncertain',native_started:0,failure_code:original.code,failure_stage:original.stage});
  assert.equal(f.database.prepare('SELECT count(*) n FROM assistant_inbox_deliveries').get().n,1);
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
});

test('schema13 preserves true v12 native-start/recovery history; reviewed start is a separate monotonic CAS',async t=>{
  const f=memory(t),source=scope(),taskId=randomUUID();f.inbox.register(source);accept(f.inbox,source,taskId);
  page(f.inbox,source,[{id:'original',revision:'1',taskId,wake:true}]);
  const job=await f.inbox.claimDelivery({authorize:async()=>true});f.inbox.prepareTaskPass(job.deliveryId);
  const recovery=f.inbox.preparePassRecovery(job.deliveryId,{passId:randomUUID(),expectedLeaseRevision:0});
  f.inbox.startDelivery(job.deliveryId);f.inbox.markDeliveryUncertain(job.deliveryId);
  f.database.exec('ALTER TABLE assistant_inbox_deliveries DROP COLUMN pass_continuation_json; UPDATE assistant_inbox_meta SET version=12');
  const before={...f.database.prepare('SELECT * FROM assistant_inbox_deliveries').get()};
  const inbox=createAssistantInbox({database:f.database,now:()=>1000000});
  const {pass_continuation_json,...after}=f.database.prepare('SELECT * FROM assistant_inbox_deliveries').get();
  assert.equal(pass_continuation_json,null);assert.deepEqual(after,before);assert.deepEqual(inbox.readPassRecovery(job.deliveryId),recovery);
  const intent=inbox.preparePassContinuation(job.deliveryId,{passId:recovery.passId,expectedLeaseRevision:1,terminalTurnId:randomUUID(),terminalMarkerId:job.deliveryId});
  assert.equal(intent.started,false);const reviewId=randomUUID();
  inbox.updatePassContinuation(job.deliveryId,intent.clientRequestId,{reviewId,resumeAttempted:true,resumed:true});
  inbox.updatePassContinuation(job.deliveryId,intent.clientRequestId,{started:true});
  assert.throws(()=>inbox.updatePassContinuation(job.deliveryId,intent.clientRequestId,{started:true}),/CONFLICT/);
  assert.throws(()=>inbox.updatePassContinuation(job.deliveryId,intent.clientRequestId,{started:false}),/CONFLICT/);
  assert.throws(()=>inbox.updatePassContinuation(job.deliveryId,intent.clientRequestId,{reviewId:randomUUID()}),/CONFLICT/);
  assert.equal(f.database.prepare('SELECT native_started FROM assistant_inbox_deliveries').get().native_started,1);
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
  assert.deepEqual(inbox.readPassRecovery(job.deliveryId),recovery);
});

test('same journal preserves twenty legacy starts and bounds each actual prerequisite definition across reopen',async t=>{
  const f=memory(t),source=scope(),taskId=randomUUID();let inbox=f.inbox;
  inbox.register(source);accept(inbox,source,taskId);page(inbox,source,[{id:'original',revision:'1',taskId,wake:true}]);
  const job=await inbox.claimDelivery({authorize:async()=>true}),passId=randomUUID();inbox.prepareTaskPass(job.deliveryId);
  inbox.startDelivery(job.deliveryId);inbox.markDeliveryUncertain(job.deliveryId);
  let marker=job.deliveryId,revision=0;
  const next=prerequisiteKey=>{
    const input={passId,expectedLeaseRevision:revision,terminalTurnId:randomUUID(),terminalMarkerId:marker,
      ...(prerequisiteKey?{prerequisiteKey}:{})};
    const intent=inbox.preparePassContinuation(job.deliveryId,input),reviewId=randomUUID();
    assert.deepEqual(inbox.preparePassContinuation(job.deliveryId,input),intent,'same terminal turn keeps its original intent');
    inbox.updatePassContinuation(job.deliveryId,intent.clientRequestId,{reviewId,resumeAttempted:true,resumed:true});
    inbox.updatePassContinuation(job.deliveryId,intent.clientRequestId,{started:true});marker=reviewId;revision++;return intent;
  };
  for(let i=0;i<20;i++)next();
  const legacy=f.database.prepare('SELECT pass_continuation_json FROM assistant_inbox_deliveries').get().pass_continuation_json;
  assert.equal(JSON.parse(legacy).length,20);assert.throws(()=>next(),/CONFLICT/);
  // Recreate a real v13 layout, then run the normal migration. No old receipt,
  // cursor, native start, failure, schedule or legacy JSON is overwritten.
  f.database.exec('DROP TABLE assistant_pass_continuations; UPDATE assistant_inbox_meta SET version=13');
  const before={...f.database.prepare('SELECT * FROM assistant_inbox_deliveries').get()};
  inbox=createAssistantInbox({database:f.database,now:()=>1000000});
  assert.equal(f.database.prepare('SELECT version FROM assistant_inbox_meta').get().version,16);
  assert.deepEqual({...f.database.prepare('SELECT * FROM assistant_inbox_deliveries').get()},before);
  const a='a'.repeat(64),b='b'.repeat(64);
  for(let i=0;i<20;i++)next(a);
  assert.throws(()=>next(a),/CONFLICT/);assert.throws(()=>next(),/CONFLICT/);
  const last=next(b);inbox=createAssistantInbox({database:f.database,now:()=>1000000});
  assert.equal(inbox.readPassContinuation(job.deliveryId).clientRequestId,last.clientRequestId);
  assert.throws(()=>next(a),/CONFLICT/,'switching back cannot reset a spent definition budget');
  const row=f.database.prepare('SELECT pass_continuation_json,native_started,state FROM assistant_inbox_deliveries').get();
  assert.equal(row.pass_continuation_json,legacy);assert.equal(row.native_started,1);assert.equal(row.state,'started');
  assert.equal(f.database.prepare('SELECT count(*) n FROM assistant_pass_continuations').get().n,21);
  assert.equal(f.database.prepare('SELECT count(*) n FROM assistant_inbox_deliveries').get().n,1);
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
  assert.throws(()=>inbox.updatePassContinuation(job.deliveryId,last.clientRequestId,{started:true}),/CONFLICT/);
  assert.throws(()=>inbox.updatePassContinuation(job.deliveryId,last.clientRequestId,{started:false}),/CONFLICT/);
});

test('same-conversation task partition rejects overlap and installs only exact originals atomically',async t=>{
  const f=routedFixture(t),secondTask=randomUUID(),secondBinding=randomUUID();
  f.advance(300000);page(f.inbox,f.external,[2,3].map(i=>({id:`message:123:${i+4}`,revision:String(i).repeat(64),taskId:null,wake:false,
    conversationKey:f.route.conversationKey,providerWake:true})),'new');
  f.inbox.applyTaskState(f.canonical,{taskId:secondTask,state:'accepted',expectedRevision:0,authority:{bindingId:secondBinding,revision:0}});
  const pending=f.inbox.pendingExternalRoutes(f.external);f.inbox.queueExistingTaskIntakes(f.external,{sourceRevision:2,eventKeys:pending.map(row=>row.event_key)});
  const intake=f.inbox.freezeExistingTaskIntake(f.inbox.ownerIntakes()[0].id);
  const routes=[{...f.route,eventIds:[intake.eventIds[0]]},{...f.route,id:randomUUID(),taskId:secondTask,bindingId:secondBinding,bindingRevision:0,eventIds:[intake.eventIds[1]]}];
  const receipt={state:'routed',receiptId:randomUUID(),routes,ignoredEventIds:[intake.eventIds[2]]};
  assert.throws(()=>f.inbox.finishOwnerIntake(intake.id,{...receipt,ignoredEventIds:[]}),/CONFLICT/);
  assert.throws(()=>f.inbox.finishOwnerIntake(intake.id,{...receipt,routes:[routes[0],{...routes[1],eventIds:routes[0].eventIds}]}),/CONFLICT/);
  assert.equal(f.inbox.ownerIntake(intake.id).state,'pending');
  f.inbox.finishOwnerIntake(intake.id,receipt);
  const mapping={canonicalSource:f.canonical,sourceRevision:2,eventKeys:intake.originals.map(ref=>ref.event_key),routes,intakeId:intake.id};
  assert.throws(()=>f.inbox.routeExternalEvents(f.external,{...mapping,routes:[routes[0],{...routes[1],eventIds:routes[0].eventIds}]}),/CONFLICT/);
  assert.equal(f.database.prepare('SELECT count(*) n FROM assistant_inbox_events WHERE task_id IS NOT NULL').get().n,0);
  f.inbox.routeExternalEvents(f.external,mapping);f.inbox.settleOwnerIntake(intake.id);
  assert.deepEqual(new Set(f.database.prepare('SELECT task_id FROM assistant_inbox_events').all().map(row=>row.task_id)),new Set([f.taskId,secondTask,null]));
  const first=await f.inbox.claimDelivery({authorize:authorized});assert.equal(first.events.length,1);
  assert.equal(f.inbox.claimAcknowledgements(f.external),null,'classification and dispatch are neither read nor processed evidence');
});
