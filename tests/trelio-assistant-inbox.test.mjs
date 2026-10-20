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
  database.exec('ALTER TABLE assistant_inbox_events DROP COLUMN owner_question_id; UPDATE assistant_inbox_meta SET version=2');
  const inbox = createAssistantInbox({ database, now: () => 1_000_000 });
  assert.equal(database.prepare('SELECT version FROM assistant_inbox_meta').get().version, 3);
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
