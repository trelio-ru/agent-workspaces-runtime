/**
 * Durable, content-free inbox mechanics for a digital assistant.
 *
 * This module is deliberately not a provider, daemon, credential store or MCP
 * authorization layer. A trusted host supplies an already private SQLite handle
 * and fresh provider/backend authorization at the boundaries described below.
 * No message text, instructions, secrets or guessed task mapping enter this DB.
 */
import { createHash, randomUUID } from 'node:crypto';

export class AssistantInboxError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AssistantInboxError(code); };
const inputError = () => fail('ASSISTANT_INBOX_INVALID_INPUT');
const object = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !keys.includes(key))) inputError();
};
const uuid = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) inputError();
  return value.toLowerCase();
};
const opaque = (value, limit = 256) => {
  if (typeof value !== 'string' || !value.length || value.length > limit || /[\x00-\x20\x7f]/u.test(value)) inputError();
  return value;
};
const integer = (value, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) inputError();
  return value;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeOf = value => {
  object(value, ['origin', 'assistantId', 'companyId', 'provider', 'accountId', 'bindingId']);
  let origin;
  try { origin = new URL(value.origin); } catch { inputError(); }
  if (origin.protocol !== 'https:' || origin.origin !== value.origin || origin.username || origin.password) inputError();
  if (!['trelio', 'telegram', 'email', 'max'].includes(value.provider)) inputError();
  const scope = { origin: origin.origin, assistantId: uuid(value.assistantId), companyId: uuid(value.companyId),
    provider: value.provider, accountId: uuid(value.accountId), bindingId: uuid(value.bindingId) };
  return { ...scope, key: digest(scope) };
};
const eventOf = value => {
  object(value, ['id', 'revision', 'taskId', 'wake']);
  if (typeof value.wake !== 'boolean') inputError();
  return { id: opaque(value.id), revision: opaque(value.revision, 128), taskId: value.taskId === null ? null : uuid(value.taskId), wake: value.wake };
};
const LEASE_MS = 120_000;
const MAX_PAGE = 100;
const MAX_PENDING = 10_000;
const MAX_EVENTS = 50_000;

/**
 * The caller owns SQLite file/sidecar protection and lifecycle. Keeping the DB
 * injection explicit prevents importing this module from creating private state
 * or silently falling back to unprotected storage on Windows/older Node hosts.
 * `DatabaseSync` from node:sqlite is exercised in tests, including two connections.
 */
export function createAssistantInbox({ database: db, now = Date.now }) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function' || typeof now !== 'function') inputError();
  const time = () => integer(now(), 0, Number.MAX_SAFE_INTEGER - LEASE_MS);
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const get = (query, ...args) => db.prepare(query).get(...args);
  const all = (query, ...args) => db.prepare(query).all(...args);
  const run = (query, ...args) => db.prepare(query).run(...args);

  // Prefix-owned tables coexist with a future host schema. Unknown versions
  // are never "repaired" by truncation, deleting the file or resetting cursors.
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_inbox_meta (version INTEGER NOT NULL);`);
  transaction(() => {
    const versions = all('SELECT version FROM assistant_inbox_meta');
    if (versions.length && (versions.length !== 1 || versions[0].version !== 1)) fail('ASSISTANT_INBOX_UNSUPPORTED_SCHEMA');
    db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_inbox_sources (
        source_key TEXT PRIMARY KEY, scope_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active'
          CHECK(state IN ('active','paused','revoked')), revision INTEGER NOT NULL DEFAULT 0,
        cursor TEXT, cursor_revision INTEGER NOT NULL DEFAULT 0, next_poll_at INTEGER NOT NULL DEFAULT 0,
        poll_token TEXT, poll_expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS assistant_inbox_events (
        event_key TEXT PRIMARY KEY, source_key TEXT NOT NULL REFERENCES assistant_inbox_sources(source_key),
        event_id TEXT NOT NULL, event_revision TEXT NOT NULL, original_task_id TEXT, task_id TEXT,
        wake INTEGER NOT NULL CHECK(wake IN (0,1)), processed INTEGER NOT NULL DEFAULT 0,
        acked INTEGER NOT NULL DEFAULT 0, ack_token TEXT, ack_expires_at INTEGER,
        UNIQUE(source_key,event_id,event_revision)
      );
      CREATE INDEX IF NOT EXISTS assistant_inbox_pending ON assistant_inbox_events(source_key,processed);
      CREATE TABLE IF NOT EXISTS assistant_inbox_tasks (
        source_key TEXT NOT NULL REFERENCES assistant_inbox_sources(source_key), task_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','waiting_owner','paused','done','revoked')),
        revision INTEGER NOT NULL, PRIMARY KEY(source_key,task_id)
      );
      CREATE TABLE IF NOT EXISTS assistant_inbox_deliveries (
        delivery_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, task_id TEXT NOT NULL,
        task_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('leased','started','complete','uncertain','not_accepted')),
        expires_at INTEGER NOT NULL, external_receipt TEXT
      );
      CREATE TABLE IF NOT EXISTS assistant_inbox_delivery_events (
        delivery_id TEXT NOT NULL REFERENCES assistant_inbox_deliveries(delivery_id),
        event_key TEXT NOT NULL REFERENCES assistant_inbox_events(event_key),
        PRIMARY KEY(delivery_id,event_key)
      );
    `);
    if (!versions.length) run('INSERT INTO assistant_inbox_meta(version) VALUES (1)');
  });
  const source = scope => {
    const row = get('SELECT * FROM assistant_inbox_sources WHERE source_key=?', scope.key);
    if (!row || row.scope_json !== JSON.stringify(scope)) fail('ASSISTANT_INBOX_SOURCE_REQUIRED');
    return row;
  };
  const activeSource = scope => {
    const row = source(scope);
    if (row.state !== 'active') fail('ASSISTANT_INBOX_SOURCE_INACTIVE');
    return row;
  };
  const validPoll = (scope, token) => {
    const row = activeSource(scope);
    if (row.poll_token !== token || row.poll_expires_at <= time()) fail('ASSISTANT_INBOX_STALE_POLL');
    return row;
  };
  const delivery = id => {
    const row = get('SELECT * FROM assistant_inbox_deliveries WHERE delivery_id=?', uuid(id));
    if (!row) fail('ASSISTANT_INBOX_DELIVERY_REQUIRED');
    return row;
  };
  const recoverExpired = () => {
    // Only a lease that never crossed the external-call boundary may retry.
    // Once `started`, loss of the response is uncertain, even after a crash.
    run("DELETE FROM assistant_inbox_delivery_events WHERE delivery_id IN (SELECT delivery_id FROM assistant_inbox_deliveries WHERE state='leased' AND expires_at<=?)", time());
    run("DELETE FROM assistant_inbox_deliveries WHERE state='leased' AND expires_at<=?", time());
    run("UPDATE assistant_inbox_deliveries SET state='uncertain' WHERE state='started' AND expires_at<=?", time());
  };
  return {
    register(scopeInput) {
      const scope = scopeOf(scopeInput);
      return transaction(() => {
        if (!get('SELECT 1 FROM assistant_inbox_sources WHERE source_key=?', scope.key)
          && get('SELECT count(*) AS total FROM assistant_inbox_sources').total >= 256) fail('ASSISTANT_INBOX_FULL');
        run('INSERT OR IGNORE INTO assistant_inbox_sources(source_key,scope_json) VALUES (?,?)', scope.key, JSON.stringify(scope));
        const row = source(scope);
        return { revision: row.revision, state: row.state };
      });
    },
    setSourceState(scopeInput, { state, expectedRevision }) {
      const scope = scopeOf(scopeInput);
      if (!['active', 'paused', 'revoked'].includes(state)) inputError();
      integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER);
      return transaction(() => {
        const row = source(scope);
        if (row.revision !== expectedRevision || row.state === 'revoked') fail('ASSISTANT_INBOX_CONFLICT');
        if (row.state !== state) {
          run('UPDATE assistant_inbox_sources SET state=?,revision=revision+1,poll_token=NULL,poll_expires_at=NULL WHERE source_key=?', state, scope.key);
          // A source pause/restore cycle invalidates outstanding workers too;
          // merely seeing "active" again must not revive an earlier lease.
          run('UPDATE assistant_inbox_events SET ack_token=NULL,ack_expires_at=NULL WHERE source_key=? AND acked=0', scope.key);
          run("DELETE FROM assistant_inbox_delivery_events WHERE delivery_id IN (SELECT delivery_id FROM assistant_inbox_deliveries WHERE source_key=? AND state='leased')", scope.key);
          run("DELETE FROM assistant_inbox_deliveries WHERE source_key=? AND state='leased'", scope.key);
        }
        return { state, revision: row.revision + Number(row.state !== state) };
      });
    },
    /** One bounded poll per exact source binding; the host performs provider I/O. */
    claimPoll(scopeInput) {
      const scope = scopeOf(scopeInput);
      return transaction(() => {
        const row = activeSource(scope), timestamp = time();
        if (row.next_poll_at > timestamp || (row.poll_token && row.poll_expires_at > timestamp)) return null;
        const token = randomUUID();
        run('UPDATE assistant_inbox_sources SET poll_token=?,poll_expires_at=? WHERE source_key=?', token, timestamp + LEASE_MS, scope.key);
        return { token, cursor: row.cursor, cursorRevision: row.cursor_revision };
      });
    },
    commitPage(scopeInput, { token, cursorRevision, nextCursor, hasMore, events }) {
      const scope = scopeOf(scopeInput); uuid(token); integer(cursorRevision, 0, Number.MAX_SAFE_INTEGER);
      if (nextCursor !== null) opaque(nextCursor, 2048);
      if (typeof hasMore !== 'boolean' || (hasMore && nextCursor === null) || !Array.isArray(events) || events.length > MAX_PAGE) inputError();
      const page = events.map(eventOf);
      return transaction(() => {
        const row = validPoll(scope, token);
        if (row.cursor_revision !== cursorRevision || (hasMore && nextCursor === row.cursor)) fail('ASSISTANT_INBOX_CONFLICT');
        let added = 0;
        for (const event of page) {
          const key = digest([scope.key, event.id, event.revision]);
          const existing = get('SELECT original_task_id,wake FROM assistant_inbox_events WHERE event_key=?', key);
          if (existing) {
            if (existing.original_task_id !== event.taskId || existing.wake !== Number(event.wake)) fail('ASSISTANT_INBOX_EVENT_CHANGED');
            continue;
          }
          const pending = get('SELECT count(*) AS total FROM assistant_inbox_events WHERE processed=0').total;
          const total = get('SELECT count(*) AS total FROM assistant_inbox_events').total;
          if (pending >= MAX_PENDING || total >= MAX_EVENTS) fail('ASSISTANT_INBOX_FULL');
          run('INSERT INTO assistant_inbox_events(event_key,source_key,event_id,event_revision,original_task_id,task_id,wake) VALUES (?,?,?,?,?,?,?)',
            key, scope.key, event.id, event.revision, event.taskId, event.taskId, Number(event.wake));
          added++;
        }
        // Cursor and durable event acceptance share one transaction. A full
        // inbox or conflicting event rolls BOTH back, so no page gets lost.
        run('UPDATE assistant_inbox_sources SET cursor=?,cursor_revision=cursor_revision+1,next_poll_at=?,poll_token=NULL,poll_expires_at=NULL WHERE source_key=?',
          nextCursor, hasMore ? time() : time() + 300_000, scope.key);
        return { added, cursorRevision: cursorRevision + 1 };
      });
    },
    /** Current backend approval, not an inference from an incoming message. */
    applyTaskState(scopeInput, { taskId, state, expectedRevision }) {
      const scope = scopeOf(scopeInput); taskId = uuid(taskId); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER);
      if (!['accepted', 'waiting_owner', 'paused', 'done', 'revoked'].includes(state)) inputError();
      return transaction(() => {
        activeSource(scope);
        const old = get('SELECT * FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', scope.key, taskId);
        if (!old && get('SELECT count(*) AS total FROM assistant_inbox_tasks').total >= 10_000) fail('ASSISTANT_INBOX_FULL');
        if ((old?.revision ?? 0) !== expectedRevision || old?.state === 'revoked') fail('ASSISTANT_INBOX_CONFLICT');
        run(`INSERT INTO assistant_inbox_tasks(source_key,task_id,state,revision) VALUES (?,?,?,?)
          ON CONFLICT(source_key,task_id) DO UPDATE SET state=excluded.state,revision=excluded.revision`, scope.key, taskId, state, expectedRevision + 1);
        return { revision: expectedRevision + 1 };
      });
    },
    /** Route only previously unmapped IDs after the host verifies the target. */
    routeEvents(scopeInput, { eventKeys, taskId }) {
      const scope = scopeOf(scopeInput); taskId = uuid(taskId);
      if (!Array.isArray(eventKeys) || !eventKeys.length || eventKeys.length > MAX_PAGE
        || eventKeys.some(key => typeof key !== 'string' || !/^[0-9a-f]{64}$/u.test(key))) inputError();
      return transaction(() => {
        activeSource(scope);
        if (!get('SELECT 1 FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', scope.key, taskId)) fail('ASSISTANT_INBOX_TASK_REQUIRED');
        for (const key of eventKeys) {
          const row = get('SELECT task_id FROM assistant_inbox_events WHERE source_key=? AND event_key=?', scope.key, key);
          if (!row || (row.task_id !== null && row.task_id !== taskId)) fail('ASSISTANT_INBOX_CONFLICT');
          run('UPDATE assistant_inbox_events SET task_id=? WHERE source_key=? AND event_key=?', taskId, scope.key, key);
        }
      });
    },
    unrouted(scopeInput) {
      const scope = scopeOf(scopeInput); activeSource(scope);
      return all('SELECT event_key,event_id,event_revision FROM assistant_inbox_events WHERE source_key=? AND task_id IS NULL ORDER BY rowid LIMIT 100', scope.key);
    },
    /**
     * `authorize` MUST use fresh server/provider ACL, assistant lifecycle and
     * task-start approval. Local rows and this callback's return grant no rights.
     * No DB lock is held during I/O; revisions are rechecked after the callback.
     */
    async claimDelivery({ authorize, scheduledTask = null }) {
      if (typeof authorize !== 'function') inputError();
      // A real cyclic adapter may request the next pass for an exact task. It
      // does not turn context-only events into an unsolicited event wake-up.
      let scheduled = null;
      if (scheduledTask !== null) {
        object(scheduledTask, ['scope', 'taskId']);
        scheduled = { scope: scopeOf(scheduledTask.scope), taskId: uuid(scheduledTask.taskId) };
      }
      const candidate = transaction(() => {
        recoverExpired();
        // One desktop worker globally, including across companies/accounts. An
        // ambiguous turn blocks a second dispatch until native read-back resolves it.
        if (get("SELECT 1 FROM assistant_inbox_deliveries WHERE state IN ('leased','started','uncertain')")) return null;
        if (scheduled) return get(`SELECT t.source_key,t.task_id,t.revision,s.scope_json,s.revision AS source_revision FROM assistant_inbox_tasks t
          JOIN assistant_inbox_sources s ON s.source_key=t.source_key
          WHERE t.source_key=? AND t.task_id=? AND t.state='accepted' AND s.state='active'`, scheduled.scope.key, scheduled.taskId);
        return get(`SELECT e.source_key,e.task_id,t.revision,s.scope_json,s.revision AS source_revision FROM assistant_inbox_events e
          JOIN assistant_inbox_sources s ON s.source_key=e.source_key
          JOIN assistant_inbox_tasks t ON t.source_key=e.source_key AND t.task_id=e.task_id
          WHERE e.processed=0 AND e.wake=1 AND s.state='active' AND t.state='accepted' ORDER BY e.rowid LIMIT 1`);
      });
      if (!candidate) return null;
      const scope = JSON.parse(candidate.scope_json);
      if (await authorize({ scope: scopeInputWithoutKey(scope), taskId: candidate.task_id }) !== true) fail('ASSISTANT_INBOX_ACCESS_DENIED');
      return transaction(() => {
        if (activeSource(scope).revision !== candidate.source_revision) fail('ASSISTANT_INBOX_CONFLICT');
        const task = get('SELECT * FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', scope.key, candidate.task_id);
        if (task?.state !== 'accepted' || task.revision !== candidate.revision) fail('ASSISTANT_INBOX_CONFLICT');
        if (get("SELECT 1 FROM assistant_inbox_deliveries WHERE state IN ('leased','started','uncertain')")) return null;
        const events = all('SELECT event_key,event_id,event_revision,wake FROM assistant_inbox_events WHERE source_key=? AND task_id=? AND processed=0 ORDER BY rowid LIMIT 100', scope.key, task.task_id);
        if (!events.length && !scheduled) return null;
        if (get('SELECT count(*) AS total FROM assistant_inbox_deliveries').total >= MAX_EVENTS) fail('ASSISTANT_INBOX_FULL');
        const id = randomUUID();
        run("INSERT INTO assistant_inbox_deliveries(delivery_id,source_key,task_id,task_revision,state,expires_at) VALUES (?,?,?,?,'leased',?)", id, scope.key, task.task_id, task.revision, time() + LEASE_MS);
        for (const event of events) run('INSERT INTO assistant_inbox_delivery_events(delivery_id,event_key) VALUES (?,?)', id, event.event_key);
        return { deliveryId: id, taskId: task.task_id, scope: scopeInputWithoutKey(scope), events };
      });
    },
    startDelivery(id) {
      return transaction(() => {
        const row = delivery(id);
        const scope = JSON.parse(get('SELECT scope_json FROM assistant_inbox_sources WHERE source_key=?', row.source_key).scope_json);
        activeSource(scope);
        const task = get('SELECT state,revision FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', row.source_key, row.task_id);
        if (row.state !== 'leased' || row.expires_at <= time() || task?.state !== 'accepted' || task.revision !== row.task_revision) fail('ASSISTANT_INBOX_STALE_DELIVERY');
        run("UPDATE assistant_inbox_deliveries SET state='started' WHERE delivery_id=?", id);
      });
    },
    completeDelivery(id, receipt) {
      opaque(receipt);
      return transaction(() => {
        const row = delivery(id);
        if (row.state === 'complete' && row.external_receipt === receipt) return;
        if (row.state !== 'started' && row.state !== 'uncertain') fail('ASSISTANT_INBOX_STALE_DELIVERY');
        // Exact positive native read-back can complete an uncertain turn. A
        // timeout or "chat exists" is insufficient evidence for this receipt.
        run("UPDATE assistant_inbox_deliveries SET state='complete',external_receipt=? WHERE delivery_id=?", receipt, id);
        run('UPDATE assistant_inbox_events SET processed=1 WHERE event_key IN (SELECT event_key FROM assistant_inbox_delivery_events WHERE delivery_id=?)', id);
      });
    },
    /** Verified terminal non-acceptance, never a missing/slow lookup response. */
    resolveDeliveryNotAccepted(id, receipt) {
      opaque(receipt);
      return transaction(() => {
        const row = delivery(id);
        if (row.state === 'not_accepted' && row.external_receipt === receipt) return;
        if (row.state !== 'uncertain') fail('ASSISTANT_INBOX_STALE_DELIVERY');
        // The trusted native adapter must first prove that the original request
        // is terminal and cannot still be accepted. Keep that evidence and the
        // old delivery ID; a late completion cannot mutate a subsequent retry.
        run("UPDATE assistant_inbox_deliveries SET state='not_accepted',external_receipt=? WHERE delivery_id=?", receipt, id);
      });
    },
    /** Read acknowledgements are separate bounded outbox operations. */
    claimAcknowledgements(scopeInput) {
      const scope = scopeOf(scopeInput);
      return transaction(() => {
        activeSource(scope);
        // Unrouted events, owner-pending tasks and mere discovery are NOT read.
        // Durably accepted task inbox entries may be acknowledged even while
        // waiting for the next scheduled task pass; ordinary comments do not wake it.
        const events = all(`SELECT e.event_key,e.event_id,e.event_revision FROM assistant_inbox_events e
          JOIN assistant_inbox_tasks t ON t.source_key=e.source_key AND t.task_id=e.task_id
          WHERE e.source_key=? AND e.acked=0 AND t.state='accepted'
          AND (e.ack_token IS NULL OR e.ack_expires_at<=?) ORDER BY e.rowid LIMIT 100`, scope.key, time());
        if (!events.length) return null;
        const token = randomUUID();
        for (const event of events) run('UPDATE assistant_inbox_events SET ack_token=?,ack_expires_at=? WHERE event_key=?', token, time() + LEASE_MS, event.event_key);
        return { token, events };
      });
    },
    completeAcknowledgements(scopeInput, token) {
      const scope = scopeOf(scopeInput); uuid(token);
      return transaction(() => {
        activeSource(scope);
        const pending = get('SELECT count(*) AS total FROM assistant_inbox_events WHERE source_key=? AND ack_token=? AND ack_expires_at>? AND acked=0', scope.key, token, time());
        if (!pending.total) fail('ASSISTANT_INBOX_STALE_ACK');
        run('UPDATE assistant_inbox_events SET acked=1,ack_token=NULL,ack_expires_at=NULL WHERE source_key=? AND ack_token=?', scope.key, token);
      });
    },
    status(scopeInput) {
      const scope = scopeOf(scopeInput), row = source(scope);
      return { state: row.state, revision: row.revision, cursorRevision: row.cursor_revision, nextPollAt: row.next_poll_at,
        pending: get('SELECT count(*) AS total FROM assistant_inbox_events WHERE source_key=? AND processed=0', scope.key).total,
        uncertain: all("SELECT delivery_id FROM assistant_inbox_deliveries WHERE source_key=? AND state='uncertain'", scope.key).map(row => row.delivery_id) };
    },
  };
}
const scopeInputWithoutKey = ({ key: _key, ...scope }) => scope;
