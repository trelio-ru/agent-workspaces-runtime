import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssistantInbox } from '../host-runtime/scripts/trelio-assistant-inbox.mjs';

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
const event = (taskId, wake = true, id = randomUUID()) => ({ id, revision: '1', taskId, wake });
const authorized = async () => true;
// Historical-schema fixtures remove the actual v6 columns before lowering the
// marker. A current table with an old marker is deliberately not a migration.
const removeRoutingColumns = database => {
  database.exec('ALTER TABLE assistant_inbox_sources DROP COLUMN configuration_revision');
  for(const name of ['conversation_key','provider_wake','dispatch_source_key','route_id','route_source_revision','route_checked_at','dispatched','read_delivery_id'])
    database.exec(`ALTER TABLE assistant_inbox_events DROP COLUMN ${name}`);
  for(const name of ['conversation_key','route_id','route_source_revision','event_ordinal'])database.exec(`ALTER TABLE assistant_inbox_delivery_events DROP COLUMN ${name}`);
};
// ACK-outbox tests inject the independent trusted processing boundary directly.
// No provider/native read observer is composed in these low-level fixtures.
const fixtureProcessed = database => database.exec('UPDATE assistant_inbox_events SET processed=1');


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
  database.exec('ALTER TABLE assistant_inbox_events DROP COLUMN owner_question_id; ALTER TABLE assistant_inbox_events DROP COLUMN ack_started; ALTER TABLE assistant_inbox_events DROP COLUMN ack_attempt_token; ALTER TABLE assistant_inbox_events DROP COLUMN ack_retry_at; UPDATE assistant_inbox_meta SET version=2');
  const inbox = createAssistantInbox({ database, now: () => 1_000_000 });
  assert.equal(database.prepare('SELECT version FROM assistant_inbox_meta').get().version, 6);
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
  database.exec('ALTER TABLE assistant_inbox_events DROP COLUMN ack_started; ALTER TABLE assistant_inbox_events DROP COLUMN ack_attempt_token; ALTER TABLE assistant_inbox_events DROP COLUMN ack_retry_at; UPDATE assistant_inbox_meta SET version=4');
  const upgraded=createAssistantInbox({database,now:()=>3_000_000});
  assert.equal(database.prepare('SELECT version FROM assistant_inbox_meta').get().version,6);
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
  database.exec('DROP TABLE assistant_inbox_streams; ALTER TABLE assistant_inbox_events DROP COLUMN ack_started; ALTER TABLE assistant_inbox_events DROP COLUMN ack_attempt_token; ALTER TABLE assistant_inbox_events DROP COLUMN ack_retry_at; UPDATE assistant_inbox_meta SET version=3');
  const upgraded=createAssistantInbox({database});
  assert.equal(database.prepare('SELECT version FROM assistant_inbox_meta').get().version,6);
  assert.deepEqual(database.prepare('SELECT * FROM assistant_inbox_deliveries').get(),before);
  assert.equal(database.prepare('SELECT cursor FROM assistant_inbox_sources').get().cursor,'existing-cursor');
  assert.equal(await upgraded.claimDelivery({authorize:authorized}),null);
});

const routedFixture=t=>{
  const f=memory(t),canonical=scope(),external={...canonical,provider:'telegram',accountId:randomUUID(),bindingId:randomUUID()},taskId=randomUUID();
  const bindingId=randomUUID(),conversationKey=`telegram-conversation/v1.${'a'.repeat(64)}`;
  const route={id:randomUUID(),sourceId:external.bindingId,sourceRevision:2,conversationKey,bindingId,bindingRevision:4,taskId};
  f.inbox.register(canonical);f.inbox.register(external);f.inbox.observeExternalSourceRevision(external,2);
  f.inbox.applyTaskState(canonical,{taskId,state:'accepted',expectedRevision:0,authority:{bindingId,revision:4}});
  page(f.inbox,external,[{id:'message:123:4',revision:'b'.repeat(64),taskId:null,wake:false,conversationKey,providerWake:true}]);
  const pending=f.inbox.pendingExternalRoutes(external);
  const mapping={canonicalSource:canonical,sourceRevision:2,eventKeys:pending.map(row=>row.event_key),routes:[route]};
  return {...f,canonical,external,taskId,route,pending,mapping};
};

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
  removeRoutingColumns(f.database);f.database.exec('UPDATE assistant_inbox_meta SET version=5');
  const upgraded=createAssistantInbox({database:f.database,now:()=>1_000_000});
  assert.equal(f.database.prepare('SELECT version FROM assistant_inbox_meta').get().version,6);
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

test('actual body observer uses original SQLite refs and native source/route before and after, but never processes by itself',async t=>{
  const {createAssistantSourceReadObserver}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const f=routedFixture(t);f.inbox.routeExternalEvents(f.external,f.mapping);
  const work=await f.inbox.claimDelivery({authorize:authorized});f.inbox.startDelivery(work.deliveryId);
  const identity={origin:f.canonical.origin,assistantId:f.canonical.assistantId,deviceId:randomUUID()};
  const pass={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,companyId:f.canonical.companyId,
    taskId:f.taskId,passId:randomUUID(),deliveryId:work.deliveryId,threadId:randomUUID(),bindingId:f.route.bindingId,bindingRevision:f.route.bindingRevision};
  const source={id:f.external.bindingId,deviceId:identity.deviceId,localAccountId:f.external.accountId,projectId:null,
    revision:2,state:'active',skillId:'telegram-mtproto'};
  let live=true,available=true,routes=true,reads=0;
  const client={readTaskPass:async()=>({...pass,state:live?'leased':'closed',leaseExpiresAt:new Date(Date.now()+600000).toISOString()}),
    sourceAccounts:async()=>{reads++;return available?[source]:[];},sourceRoutes:async()=>routes?[f.route]:[]};
  const observer=createAssistantSourceReadObserver({identity,client,host:{readActivePass:async()=>pass},withInbox:async action=>action(f.inbox)});
  const input={artifact:{skillId:'telegram-mtproto'},executionContext:{companyId:pass.companyId,projectId:randomUUID(),account:{id:f.external.accountId}},
    runtimeArguments:['read-reference','--chat','123','--message-id','4','--expected-revision','b'.repeat(64),
      '--expected-conversation-key',f.route.conversationKey]};
  const result={stdout:JSON.stringify({schemaVersion:1,protocol:'telegram-message-read/v1',
    reference:{id:'message:123:4',revision:'b'.repeat(64),conversationKey:f.route.conversationKey},
    message:{text:'PRIVATE_BODY_CANARY',textTruncated:false},coverage:{textComplete:true,attachmentsContentRead:false,contextIncluded:false},
    readState:{mode:'history-only',marksRead:false,readReceiptsSent:false,viewsRegistered:false}})};
  const selected=[{sourceId:source.id,sourceRevision:2,routeId:f.route.id,eventOrdinal:0}];
  await assert.rejects(observer.confirmProcessing(pass,selected),/SOURCE_READ_REQUIRED/);
  for(const args of [[...input.runtimeArguments,'--context','1'],input.runtimeArguments.slice(0,-2),
    input.runtimeArguments.map(value=>value==='123'?'999':value)])await assert.rejects(observer.prepare({...input,runtimeArguments:args}),/SOURCE_READ_REQUIRED/);
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
