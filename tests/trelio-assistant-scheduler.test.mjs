import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { nextAssistantRun, createAssistantScheduler } from '../host-runtime/scripts/trelio-assistant-scheduler.mjs';
import { createAssistantInbox } from '../host-runtime/scripts/trelio-assistant-inbox.mjs';
const at = text => Date.parse(text);
const next = (cadence, anchor, after, timeZone='Europe/Moscow') => new Date(nextAssistantRun({ cadence,
  anchorAt: at(anchor), after: at(after), timeZone })).toISOString();

test('a blocked company can be excluded without rolling forward its due cycle', t=>{
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  let clock=at('2026-10-20T09:00:00Z');
  const scheduler=createAssistantScheduler({database,now:()=>clock});
  const assistantId=randomUUID(),companyA=randomUUID(),companyB=randomUUID();
  const register=companyId=>{
    const scope={origin:'https://example.test',assistantId,companyId,taskId:randomUUID()};
    const source={origin:scope.origin,assistantId,companyId,provider:'trelio',accountId:randomUUID(),bindingId:randomUUID()};
    return scheduler.register({scope,source,threadId:randomUUID(),cadence:'every_30_minutes',timeZone:'Europe/Moscow'});
  };
  const first=register(companyA);clock+=60000;register(companyB);clock+=1800000;
  assert.equal(scheduler.nextDue().companyId,companyA);
  assert.equal(scheduler.nextDue([companyA]).companyId,companyB);
  assert.equal(scheduler.get({origin:first.origin,assistantId:first.assistantId,companyId:first.companyId,taskId:first.taskId}).nextRunAt,first.nextRunAt);
  assert.equal(scheduler.nextDue([companyA,companyB]),null);
  assert.throws(()=>scheduler.nextDue(['invalid']),/INVALID_INPUT/);
});

test('calendar monthly preserves original day and skips missed cycles without a catch-up burst', () => {
  assert.equal(next('monthly','2026-01-31T09:00:00Z','2026-01-31T09:00:00Z'), '2026-02-28T09:00:00.000Z');
  assert.equal(next('monthly','2026-01-31T09:00:00Z','2026-02-28T09:00:00Z'), '2026-03-31T09:00:00.000Z');
  assert.equal(next('monthly','2024-02-29T09:00:00Z','2027-02-28T09:00:00Z'), '2027-03-29T09:00:00.000Z');
  assert.equal(next('every_30_minutes','2026-01-01T00:00:00Z','2026-10-20T00:04:00Z'), '2026-10-20T00:30:00.000Z');
});

test('daily/weekly wall times follow DST; overlaps run once and gaps move forward', () => {
  assert.equal(next('daily','2026-03-07T14:00:00Z','2026-03-07T14:00:00Z','America/New_York'), '2026-03-08T13:00:00.000Z');
  assert.equal(next('daily','2026-03-07T07:30:00Z','2026-03-07T07:30:00Z','America/New_York'), '2026-03-08T07:30:00.000Z');
  assert.equal(next('daily','2026-10-31T05:30:00Z','2026-10-31T05:30:00Z','America/New_York'), '2026-11-01T05:30:00.000Z');
  assert.equal(next('daily','2026-10-31T05:30:00Z','2026-11-01T05:40:00Z','America/New_York'), '2026-11-02T06:30:00.000Z');
  assert.equal(next('weekly','2026-03-01T14:00:00Z','2026-03-01T14:00:00Z','America/New_York'), '2026-03-08T13:00:00.000Z');
  assert.throws(() => next('monthly','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','Unknown/Zone'), /INVALID_INPUT/);
});

test('one chat per task; actual cyclic completion and inbox event processing commit atomically', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let clock = at('2026-10-20T09:00:00Z');
  const scheduler = createAssistantScheduler({ database: db, now: () => clock });
  let failCompletion = false;
  const inbox = createAssistantInbox({ database: db, now: () => clock, onDeliveryCompleted: result => {
    scheduler.completeInsideInboxTransaction(result);
    if (failCompletion) throw new Error('synthetic completion failure');
  } });
  const scope = { origin: 'https://example.test', assistantId: randomUUID(), companyId: randomUUID(), taskId: randomUUID() };
  const source = { origin: scope.origin, assistantId: scope.assistantId, companyId: scope.companyId,
    provider: 'trelio', accountId: randomUUID(), bindingId: randomUUID() };
  const threadId = randomUUID();
  const registration = { scope, source, threadId, cadence: 'every_30_minutes', timeZone: 'Europe/Moscow' };
  const first = scheduler.register(registration);
  assert.equal(first.nextRunAt, clock+1_800_000);
  assert.equal(scheduler.register(registration).threadId, threadId);
  assert.throws(() => scheduler.register({ ...registration, threadId: randomUUID() }), /CONFLICT/);
  assert.throws(() => scheduler.register({ ...registration, scope: { ...scope, taskId: randomUUID() } }), /CONFLICT/);
  inbox.register(source); inbox.applyTaskState(source, { taskId: scope.taskId, state: 'accepted', expectedRevision: 0 });
  inbox.commitPage(source, { ...inbox.claimPoll(source), nextCursor: 'one', hasMore: false,
    events: [{ id: 'event', revision: '1', taskId: scope.taskId, wake: true }] });
  let work = await inbox.claimDelivery({ authorize: async () => true }); inbox.startDelivery(work.deliveryId);
  clock += 1_800_001;
  // A delayed event-triggered job is not claimed as the first automatic timer run.
  inbox.completeDelivery(work.deliveryId, 'native-event-turn');
  assert.equal(scheduler.get(scope).lastCycleAt, null);
  assert.equal(scheduler.get(scope).nextRunAt, at('2026-10-20T10:00:00Z'));
  clock = at('2026-10-20T10:00:00Z');
  assert.equal(scheduler.nextDue().threadId, threadId);
  work = await inbox.claimDelivery({ authorize: async () => true, scheduledTask: { scope: source, taskId: scope.taskId } });
  inbox.startDelivery(work.deliveryId);
  failCompletion = true;
  assert.throws(() => inbox.completeDelivery(work.deliveryId, 'native-cycle-turn'), /synthetic/);
  assert.equal(scheduler.get(scope).nextRunAt, clock, 'failed combined commit leaves the cycle due');
  assert.equal(scheduler.get(scope).lastCycleAt, null);
  failCompletion = false;
  inbox.completeDelivery(work.deliveryId, 'native-cycle-turn');
  inbox.completeDelivery(work.deliveryId, 'native-cycle-turn');
  assert.equal(scheduler.get(scope).lastCycleAt, clock);
  assert.equal(scheduler.get(scope).nextRunAt, clock+1_800_000);
  assert.equal(scheduler.nextDue(), null);
  const paused = scheduler.setState(scope, { state: 'done', expectedRevision: first.revision });
  clock += 86_400_000;
  assert.equal(scheduler.nextDue(), null);
  assert.equal(paused.nextRunAt, null);
  assert.throws(() => scheduler.setCadence(scope, { cadence: 'daily', timeZone: 'UTC', expectedRevision: paused.revision }), /CONFLICT/);
});

test('new authority revisions permit a confirmed re-assignment without reviving old decisions', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const inbox = createAssistantInbox({ database: db });
  const source = { origin: 'https://example.test', assistantId: randomUUID(), companyId: randomUUID(), provider: 'trelio', accountId: randomUUID(), bindingId: randomUUID() };
  const taskId = randomUUID(), bindingId = randomUUID(); inbox.register(source);
  let revision = inbox.applyTaskState(source, { taskId, state: 'accepted', expectedRevision: 0, authority: { bindingId, revision: 0 } }).revision;
  assert.equal(inbox.applyTaskState(source, { taskId, state: 'accepted', expectedRevision: revision, authority: { bindingId, revision: 0 } }).revision, revision);
  revision = inbox.applyTaskState(source, { taskId, state: 'revoked', expectedRevision: revision, authority: { bindingId, revision: 1 } }).revision;
  assert.throws(() => inbox.applyTaskState(source, { taskId, state: 'accepted', expectedRevision: revision, authority: { bindingId, revision: 0 } }), /CONFLICT/);
  assert.throws(() => inbox.applyTaskState(source, { taskId, state: 'accepted', expectedRevision: revision }), /CONFLICT/);
  revision = inbox.applyTaskState(source, { taskId, state: 'accepted', expectedRevision: revision, authority: { bindingId, revision: 2 } }).revision;
  assert.equal(inbox.taskState(source,taskId).state, 'accepted');
  assert.throws(() => inbox.applyTaskState(source, { taskId, state: 'accepted', expectedRevision: revision, authority: { bindingId: randomUUID(), revision: 3 } }), /CONFLICT/);
  assert.equal(inbox.listSources().length, 1);
  const poll = inbox.claimPoll(source); inbox.abandonPoll(source, { token: poll.token, retryAfterMs: 300_000 });
  assert.equal(inbox.claimPoll(source), null);
});

test('forward SQLite migration preserves v1 cursors and task state', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let inbox = createAssistantInbox({ database: db });
  const source = { origin: 'https://example.test', assistantId: randomUUID(), companyId: randomUUID(), provider: 'trelio', accountId: randomUUID(), bindingId: randomUUID() };
  const taskId = randomUUID(); inbox.register(source); inbox.applyTaskState(source, { taskId, state: 'paused', expectedRevision: 0 });
  inbox.commitPage(source, { ...inbox.claimPoll(source), nextCursor: 'old-position', hasMore: false, events: [] });
  db.exec('ALTER TABLE assistant_inbox_events DROP COLUMN owner_question_id; ALTER TABLE assistant_inbox_events DROP COLUMN ack_started; ALTER TABLE assistant_inbox_events DROP COLUMN ack_attempt_token; ALTER TABLE assistant_inbox_events DROP COLUMN ack_retry_at; ALTER TABLE assistant_inbox_tasks DROP COLUMN authority_binding_id; ALTER TABLE assistant_inbox_tasks DROP COLUMN authority_revision; ALTER TABLE assistant_inbox_deliveries DROP COLUMN scheduled; ALTER TABLE assistant_inbox_deliveries DROP COLUMN kind; ALTER TABLE assistant_inbox_deliveries DROP COLUMN native_thread_id; ALTER TABLE assistant_inbox_deliveries DROP COLUMN native_started; UPDATE assistant_inbox_meta SET version=1');
  inbox = createAssistantInbox({ database: db });
  assert.equal(inbox.status(source).cursorRevision, 1);
  assert.equal(inbox.taskState(source, taskId).state, 'paused');
  assert.equal(db.prepare('SELECT version FROM assistant_inbox_meta').get().version, 5);
});
