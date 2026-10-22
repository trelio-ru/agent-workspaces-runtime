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
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uuid = value => {
  if (typeof value !== 'string' || !UUID.test(value)) inputError();
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
/** Provider-owned opaque routing hints, never sender or task authority. Email
 * uses a scoped hash of untrusted threading headers; Telegram uses its native
 * account HMAC. Keep prefixes bound to the source even though both are opaque. */
export const assistantConversationKeyMatches=(provider,value)=>typeof value==='string'
  && ['telegram','email'].includes(provider)
  && new RegExp(`^${provider}-conversation/v1\\.[0-9a-f]{64}$`,'u').test(value);
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
  object(value, ['id', 'revision', 'taskId', 'wake', 'ownerQuestionId', 'conversationKey', 'providerWake']);
  if (typeof value.wake !== 'boolean' || value.ownerQuestionId !== undefined && (!value.wake || value.taskId === null)) inputError();
  if(value.conversationKey!==undefined && (typeof value.conversationKey!=='string'
    || !['telegram','email'].some(provider=>assistantConversationKeyMatches(provider,value.conversationKey))
    || value.taskId!==null || value.wake || typeof value.providerWake!=='boolean')
    || value.providerWake!==undefined && value.conversationKey===undefined)inputError();
  return { ownerQuestionId: value.ownerQuestionId === undefined ? null : uuid(value.ownerQuestionId), id: opaque(value.id), revision: opaque(value.revision, 128),
    taskId: value.taskId === null ? null : uuid(value.taskId), wake: value.wake,
    conversationKey:value.conversationKey??null,providerWake:Boolean(value.providerWake) };
};
const LEASE_MS = 120_000;
const MAX_PAGE = 100;
const MAX_PENDING = 10_000;
const MAX_EVENTS = 50_000;
const MAX_STREAMS = 10_000;

/** Shared private/wire projection of a selected original delivery manifest.
 * No provider ID/body/revision digest can enter a native processing receipt.
 * This is transport validation only, never proof of reading or native ACL. */
export const assistantSourceProcessingReferences=value=>{
  if(!Array.isArray(value)||value.length>100)inputError();
  let previous=-1;
  return value.map(row=>{
    object(row,['sourceId','sourceRevision','routeId','eventOrdinal']);
    if(Object.keys(row).length!==4)inputError();
    const eventOrdinal=integer(row.eventOrdinal,0,99);
    if(eventOrdinal<=previous)inputError();previous=eventOrdinal;
    return Object.freeze({sourceId:uuid(row.sourceId),sourceRevision:integer(row.sourceRevision,0,2_147_483_647),
      routeId:uuid(row.routeId),eventOrdinal});
  });
};

/**
 * The caller owns SQLite file/sidecar protection and lifecycle. Keeping the DB
 * injection explicit prevents importing this module from creating private state
 * or silently falling back to unprotected storage on Windows/older Node hosts.
 * `DatabaseSync` from node:sqlite is exercised in tests, including two connections.
 */
export function createAssistantInbox({ database: db, now = Date.now, onDeliveryCompleted = null }) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function' || typeof now !== 'function') inputError();
  if (onDeliveryCompleted !== null && typeof onDeliveryCompleted !== 'function') inputError();
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
    if (versions.length && (versions.length !== 1 || ![1, 2, 3, 4, 5, 6, 7, 8].includes(versions[0].version))) fail('ASSISTANT_INBOX_UNSUPPORTED_SCHEMA');
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
        revision INTEGER NOT NULL, authority_binding_id TEXT, authority_revision INTEGER, PRIMARY KEY(source_key,task_id)
      );
      CREATE TABLE IF NOT EXISTS assistant_inbox_deliveries (
        delivery_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, task_id TEXT NOT NULL,
        task_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('leased','started','complete','uncertain','not_accepted')),
        scheduled INTEGER NOT NULL DEFAULT 0 CHECK(scheduled IN (0,1)),
        kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','provision')),
        native_thread_id TEXT,
        native_started INTEGER NOT NULL DEFAULT 0 CHECK(native_started IN (0,1)),
        expires_at INTEGER NOT NULL, external_receipt TEXT
      );
      CREATE TABLE IF NOT EXISTS assistant_inbox_delivery_events (
        delivery_id TEXT NOT NULL REFERENCES assistant_inbox_deliveries(delivery_id),
        event_key TEXT NOT NULL REFERENCES assistant_inbox_events(event_key),
        PRIMARY KEY(delivery_id,event_key)
      );
      CREATE TABLE IF NOT EXISTS assistant_inbox_streams (
        source_key TEXT NOT NULL REFERENCES assistant_inbox_sources(source_key), stream_id TEXT NOT NULL,
        signal_revision TEXT NOT NULL, signal_generation INTEGER NOT NULL DEFAULT 1,
        completed_generation INTEGER NOT NULL DEFAULT 0, initial_cursor TEXT, cursor TEXT, cursor_revision INTEGER NOT NULL DEFAULT 0,
        next_poll_at INTEGER NOT NULL DEFAULT 0, poll_token TEXT, poll_expires_at INTEGER, poll_generation INTEGER,
        PRIMARY KEY(source_key,stream_id)
      );
    `);
    if (versions[0]?.version === 1) {
      // SQLite DDL and the schema marker commit together. Existing cursors,
      // leases, revocations and uncertain deliveries survive the forward upgrade.
      db.exec("ALTER TABLE assistant_inbox_tasks ADD COLUMN authority_binding_id TEXT; ALTER TABLE assistant_inbox_tasks ADD COLUMN authority_revision INTEGER; ALTER TABLE assistant_inbox_deliveries ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0; ALTER TABLE assistant_inbox_deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'; ALTER TABLE assistant_inbox_deliveries ADD COLUMN native_thread_id TEXT; ALTER TABLE assistant_inbox_deliveries ADD COLUMN native_started INTEGER NOT NULL DEFAULT 0;");
      run('UPDATE assistant_inbox_meta SET version=2');
    }
    // Forward-only additive upgrade keeps old leases/cursors and ambiguous
    // deliveries intact. The new column contains a UUID only, never an answer.
    if (!versions.length || versions[0].version < 3) {
      db.exec('ALTER TABLE assistant_inbox_events ADD COLUMN owner_question_id TEXT');
      run('UPDATE assistant_inbox_meta SET version=3');
    }
    // The additive stream journal is in the SAME private database. No cursor,
    // uncertain delivery, ACK or task generation is reset during this upgrade.
    if (versions.length && versions[0].version < 4) run('UPDATE assistant_inbox_meta SET version=4');
    if (!versions.length || versions[0].version < 5) {
      db.exec('ALTER TABLE assistant_inbox_events ADD COLUMN ack_started INTEGER NOT NULL DEFAULT 0 CHECK(ack_started IN (0,1)); ALTER TABLE assistant_inbox_events ADD COLUMN ack_attempt_token TEXT; ALTER TABLE assistant_inbox_events ADD COLUMN ack_retry_at INTEGER NOT NULL DEFAULT 0');
      // A previous external lease might already have reached its provider.
      // Upgrade never turns that ambiguity into a fresh write permission.
      run(`UPDATE assistant_inbox_events SET ack_started=1 WHERE acked=0 AND ack_token IS NOT NULL
        AND source_key IN (SELECT source_key FROM assistant_inbox_sources WHERE json_extract(scope_json,'$.provider')!='trelio')`);
      run('UPDATE assistant_inbox_meta SET version=5');
    }
    if(!versions.length || versions[0].version<6){
      // SAME private journal, forward-only structural routing. Legacy external
      // rows gain no guessed mapping/read proof and existing ambiguous native
      // deliveries/ACK fences/cursors are retained byte-for-byte.
      db.exec(`ALTER TABLE assistant_inbox_sources ADD COLUMN configuration_revision INTEGER;
        ALTER TABLE assistant_inbox_events ADD COLUMN conversation_key TEXT;
        ALTER TABLE assistant_inbox_events ADD COLUMN provider_wake INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE assistant_inbox_events ADD COLUMN dispatch_source_key TEXT;
        ALTER TABLE assistant_inbox_events ADD COLUMN route_id TEXT;
        ALTER TABLE assistant_inbox_events ADD COLUMN route_source_revision INTEGER;
        ALTER TABLE assistant_inbox_events ADD COLUMN route_checked_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE assistant_inbox_events ADD COLUMN dispatched INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE assistant_inbox_events ADD COLUMN read_delivery_id TEXT;
        ALTER TABLE assistant_inbox_delivery_events ADD COLUMN conversation_key TEXT;
        ALTER TABLE assistant_inbox_delivery_events ADD COLUMN route_id TEXT;
        ALTER TABLE assistant_inbox_delivery_events ADD COLUMN route_source_revision INTEGER;
        ALTER TABLE assistant_inbox_delivery_events ADD COLUMN event_ordinal INTEGER CHECK(event_ordinal>=0 AND event_ordinal<100);`);
      run('UPDATE assistant_inbox_meta SET version=6');
    }
    if(!versions.length||versions[0].version<7){
      // A new native read-back may confirm an OLD uncertain route under the
      // current source generation. Keep this closed verification revision in
      // the SAME source journal so a lost health response is recoverable after
      // restart. Migration never invents it from legacy processed/acked bits.
      db.exec('ALTER TABLE assistant_inbox_sources ADD COLUMN ack_verified_revision INTEGER CHECK(ack_verified_revision>=0 AND ack_verified_revision<=2147483647)');
      db.exec('ALTER TABLE assistant_inbox_events ADD COLUMN ack_verify_only INTEGER NOT NULL DEFAULT 0 CHECK(ack_verify_only IN (0,1))');
      run('UPDATE assistant_inbox_meta SET version=7');
    }
    if(!versions.length||versions[0].version<8){
      // The SAME private journal retains only the exact original RFC822 digest
      // earned by a trusted full-body read. It is not body text, a new vault or
      // native processing authority. Legacy processed/ACK bits invent no hash.
      db.exec('ALTER TABLE assistant_inbox_events ADD COLUMN read_original_sha256 TEXT CHECK(read_original_sha256 IS NULL OR (length(read_original_sha256)=64 AND read_original_sha256 NOT GLOB \'*[^0-9a-f]*\'))');
      run('UPDATE assistant_inbox_meta SET version=8');
    }
    if (!versions.length) run('INSERT INTO assistant_inbox_meta(version) VALUES (8)');
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
  const validStreamPoll = (scope, streamId, token, generation) => {
    activeSource(scope);
    const row=get('SELECT * FROM assistant_inbox_streams WHERE source_key=? AND stream_id=?',scope.key,streamId);
    if(!row || row.poll_token!==token || row.poll_expires_at<=time() || row.poll_generation!==generation)
      fail('ASSISTANT_INBOX_STALE_POLL');
    return row;
  };
  // Both account and child-stream pages enter the exact same event journal.
  // Keep dedup/snapshot/bounds in one implementation under the caller's tx.
  const commitEvents = (scope,page) => {
    let added=0;
    for(const event of page){
      const key=digest([scope.key,event.id,event.revision]);
      if(event.conversationKey && !assistantConversationKeyMatches(scope.provider,event.conversationKey))inputError();
      const existing=get('SELECT original_task_id,wake,owner_question_id,conversation_key,provider_wake FROM assistant_inbox_events WHERE event_key=?',key);
      if(existing){
        if(existing.original_task_id!==event.taskId || existing.wake!==Number(event.wake)
          || existing.owner_question_id!==event.ownerQuestionId)fail('ASSISTANT_INBOX_EVENT_CHANGED');
        if(event.conversationKey===null && ['telegram','email'].includes(scope.provider))continue; // Never erase a newer hint on legacy replay.
        if(existing.conversation_key===null && event.conversationKey && ['telegram','email'].includes(scope.provider)){
          // A verified newer provider may enrich legacy ABSENCE once. This
          // adds no route/read/processed/ACK authority and never revives an
          // already handled event. A known key can never be replaced later.
          run('UPDATE assistant_inbox_events SET conversation_key=?,provider_wake=? WHERE event_key=?',event.conversationKey,Number(event.providerWake),key);
        }else if(existing.conversation_key!==event.conversationKey||existing.provider_wake!==Number(event.providerWake))fail('ASSISTANT_INBOX_EVENT_CHANGED');
        continue;
      }
      const pending=get('SELECT count(*) AS total FROM assistant_inbox_events WHERE processed=0').total;
      const total=get('SELECT count(*) AS total FROM assistant_inbox_events').total;
      if(pending>=MAX_PENDING || total>=MAX_EVENTS)fail('ASSISTANT_INBOX_FULL');
      run('INSERT INTO assistant_inbox_events(event_key,source_key,event_id,event_revision,original_task_id,task_id,wake,owner_question_id,conversation_key,provider_wake) VALUES (?,?,?,?,?,?,?,?,?,?)',
        key,scope.key,event.id,event.revision,event.taskId,event.taskId,Number(event.wake),event.ownerQuestionId,event.conversationKey,Number(event.providerWake));
      added++;
    }
    return added;
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
  const deliveryEvents=id=>all(`SELECT e.event_key,e.event_id,e.event_revision,e.wake,e.owner_question_id,
    de.conversation_key,de.route_id,de.route_source_revision,de.event_ordinal,s.scope_json AS event_scope_json
    FROM assistant_inbox_events e JOIN assistant_inbox_sources s ON s.source_key=e.source_key
    JOIN assistant_inbox_delivery_events de ON de.event_key=e.event_key WHERE de.delivery_id=? ORDER BY coalesce(de.event_ordinal,e.rowid) LIMIT 100`,id);
  const assertExternalDeliverySnapshot=job=>{
    // Native source rechecks happen outside SQLite; close the remaining local
    // race synchronously at prepare/start/renew. A paused/reconfigured/rerouted
    // source cannot revive a delivery snapshot that was allocated earlier.
    const invalid=get(`SELECT 1 FROM assistant_inbox_events e JOIN assistant_inbox_sources s ON s.source_key=e.source_key
      JOIN assistant_inbox_delivery_events de ON de.event_key=e.event_key WHERE de.delivery_id=?
      AND json_extract(s.scope_json,'$.provider')!='trelio' AND (s.state!='active' OR e.conversation_key IS NOT NULL AND (
        e.dispatch_source_key IS NULL OR e.dispatch_source_key!=? OR e.task_id IS NULL OR e.task_id!=?
        OR de.conversation_key IS NULL OR de.conversation_key!=e.conversation_key OR de.route_id IS NULL OR e.route_id IS NULL OR de.route_id!=e.route_id
        OR de.route_source_revision IS NULL OR s.configuration_revision IS NULL OR de.route_source_revision!=s.configuration_revision
        OR e.route_source_revision IS NULL OR e.route_source_revision!=de.route_source_revision)) LIMIT 1`,
      job.delivery_id,job.source_key,job.task_id);
    if(invalid)fail('ASSISTANT_INBOX_STALE_DELIVERY');
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
          run('UPDATE assistant_inbox_streams SET poll_token=NULL,poll_expires_at=NULL,poll_generation=NULL WHERE source_key=?',scope.key);
          // A source pause/restore cycle invalidates outstanding workers too;
          // merely seeing "active" again must not revive an earlier lease.
          run('UPDATE assistant_inbox_events SET ack_token=NULL,ack_expires_at=NULL WHERE source_key=? AND acked=0', scope.key);
          if(scope.provider!=='trelio')run(`UPDATE assistant_inbox_events SET dispatch_source_key=NULL,route_id=NULL,
            route_source_revision=NULL,read_delivery_id=NULL,task_id=NULL WHERE source_key=? AND processed=0`,scope.key);
          run("DELETE FROM assistant_inbox_delivery_events WHERE delivery_id IN (SELECT delivery_id FROM assistant_inbox_deliveries WHERE source_key=? AND state='leased')", scope.key);
          run("DELETE FROM assistant_inbox_deliveries WHERE source_key=? AND state='leased'", scope.key);
        }
        return { state, revision: row.revision + Number(row.state !== state) };
      });
    },
    observeExternalSourceRevision(scopeInput,nativeRevision){
      const scope=scopeOf(scopeInput);if(scope.provider==='trelio')inputError();integer(nativeRevision,0,2_147_483_647);
      return transaction(()=>{
        const row=source(scope);
        if(row.configuration_revision!==null && nativeRevision<row.configuration_revision)fail('ASSISTANT_INBOX_CONFLICT');
        if(row.configuration_revision===nativeRevision)return;
        // Changed source configuration never resets a native stream cursor or
        // adopts an old route/read proof. Explicit current server routes must
        // select the target again; unprocessed refs remain durable throughout.
        run(`UPDATE assistant_inbox_events SET dispatch_source_key=NULL,route_id=NULL,route_source_revision=NULL,
          read_delivery_id=NULL,task_id=NULL WHERE source_key=? AND processed=0`,scope.key);
        run('UPDATE assistant_inbox_sources SET configuration_revision=?,ack_verified_revision=NULL WHERE source_key=?',nativeRevision,scope.key);
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
    commitPage(scopeInput, { token, cursorRevision, nextCursor, hasMore, events, streams=[] }) {
      const scope = scopeOf(scopeInput); uuid(token); integer(cursorRevision, 0, Number.MAX_SAFE_INTEGER);
      if (nextCursor !== null) opaque(nextCursor, 2048);
      if (typeof hasMore !== 'boolean' || (hasMore && nextCursor === null) || !Array.isArray(events) || events.length > MAX_PAGE) inputError();
      const page = events.map(eventOf);
      if(!Array.isArray(streams) || streams.length>MAX_PAGE || streams.length && scope.provider==='trelio')inputError();
      const hints=streams.map(value=>{
        object(value,['id','revision','initialCursor']);return {id:opaque(value.id,64),revision:opaque(value.revision,128),
          initialCursor:value.initialCursor==null?null:opaque(value.initialCursor,2048)};
      });
      if(new Set(hints.map(value=>value.id)).size!==hints.length)inputError();
      return transaction(() => {
        const row = validPoll(scope, token);
        if (row.cursor_revision !== cursorRevision || (hasMore && nextCursor === row.cursor)) fail('ASSISTANT_INBOX_CONFLICT');
        for(const hint of hints){
          const old=get('SELECT signal_revision,signal_generation FROM assistant_inbox_streams WHERE source_key=? AND stream_id=?',scope.key,hint.id);
          if(old?.signal_revision===hint.revision)continue;
          if(!old && get('SELECT count(*) AS total FROM assistant_inbox_streams').total>=MAX_STREAMS)fail('ASSISTANT_INBOX_FULL');
          if(old)integer(old.signal_generation+1,1,Number.MAX_SAFE_INTEGER);
          // A hint is durable BEFORE the account cursor can advance. Do not
          // overwrite child cursor/lease/ORIGINAL account seed or claim that
          // the new signal is done. A newer seed could skip earlier messages.
          run(`INSERT INTO assistant_inbox_streams(source_key,stream_id,signal_revision,initial_cursor,next_poll_at) VALUES (?,?,?,?,?)
            ON CONFLICT(source_key,stream_id) DO UPDATE SET signal_revision=excluded.signal_revision,
              signal_generation=signal_generation+1,next_poll_at=min(next_poll_at,excluded.next_poll_at)`,
            scope.key,hint.id,hint.revision,hint.initialCursor,time());
        }
        const added=commitEvents(scope,page);
        // Cursor and durable event acceptance share one transaction. A full
        // inbox or conflicting event rolls BOTH back, so no page gets lost.
        run('UPDATE assistant_inbox_sources SET cursor=?,cursor_revision=cursor_revision+1,next_poll_at=?,poll_token=NULL,poll_expires_at=NULL WHERE source_key=?',
          nextCursor, hasMore ? time() : time() + 300_000, scope.key);
        return { added, cursorRevision: cursorRevision + 1 };
      });
    },
    /** The host resolves native stream identity; this table grants no provider
     * access. Final streams sleep until a NEW durable native account hint. */
    dueStreamPolls(scopeInput,{limit=4}={}) {
      const scope=scopeOf(scopeInput);activeSource(scope);integer(limit,1,MAX_PAGE);
      return all(`SELECT stream_id,next_poll_at FROM assistant_inbox_streams WHERE source_key=?
        AND signal_generation>completed_generation AND next_poll_at<=?
        AND (poll_token IS NULL OR poll_expires_at<=?) ORDER BY next_poll_at,stream_id LIMIT ?`,scope.key,time(),time(),limit)
        .map(row=>({streamId:row.stream_id,nextPollAt:row.next_poll_at}));
    },
    hasPendingStreams(scopeInput) {
      const scope=scopeOf(scopeInput);activeSource(scope);
      return Boolean(get('SELECT 1 FROM assistant_inbox_streams WHERE source_key=? AND signal_generation>completed_generation LIMIT 1',scope.key));
    },
    claimStreamPoll(scopeInput,streamId) {
      const scope=scopeOf(scopeInput);streamId=opaque(streamId,64);
      return transaction(()=>{
        activeSource(scope);
        const row=get('SELECT * FROM assistant_inbox_streams WHERE source_key=? AND stream_id=?',scope.key,streamId),timestamp=time();
        if(!row || row.signal_generation<=row.completed_generation || row.next_poll_at>timestamp
          || row.poll_token && row.poll_expires_at>timestamp)return null;
        const token=randomUUID();
        run('UPDATE assistant_inbox_streams SET poll_token=?,poll_expires_at=?,poll_generation=? WHERE source_key=? AND stream_id=?',
          token,timestamp+LEASE_MS,row.signal_generation,scope.key,streamId);
        return {token,cursor:row.cursor,cursorRevision:row.cursor_revision,generation:row.signal_generation,initialCursor:row.initial_cursor};
      });
    },
    commitStreamPage(scopeInput,{streamId,token,cursorRevision,generation,nextCursor,hasMore,events}) {
      const scope=scopeOf(scopeInput);streamId=opaque(streamId,64);uuid(token);
      integer(cursorRevision,0,Number.MAX_SAFE_INTEGER);integer(generation,1,Number.MAX_SAFE_INTEGER);
      opaque(nextCursor,2048);
      if(typeof hasMore!=='boolean' || !Array.isArray(events) || events.length>MAX_PAGE)inputError();
      const page=events.map(eventOf);
      return transaction(()=>{
        const row=validStreamPoll(scope,streamId,token,generation);
        if(row.cursor_revision!==cursorRevision || hasMore && nextCursor===row.cursor)fail('ASSISTANT_INBOX_CONFLICT');
        const added=commitEvents(scope,page);
        // Only the generation CLAIMED before provider I/O can be completed.
        // A concurrent newer hint survives final read-back and remains due.
        run(`UPDATE assistant_inbox_streams SET cursor=?,cursor_revision=cursor_revision+1,
          completed_generation=?,next_poll_at=?,poll_token=NULL,poll_expires_at=NULL,poll_generation=NULL
          WHERE source_key=? AND stream_id=?`,nextCursor,hasMore?row.completed_generation:generation,time(),scope.key,streamId);
        return {added,cursorRevision:cursorRevision+1};
      });
    },
    abandonStreamPoll(scopeInput,{streamId,token,generation,retryAfterMs}) {
      const scope=scopeOf(scopeInput);streamId=opaque(streamId,64);uuid(token);
      integer(generation,1,Number.MAX_SAFE_INTEGER);integer(retryAfterMs,30_000,3_600_000);
      return transaction(()=>{
        validStreamPoll(scope,streamId,token,generation);
        run('UPDATE assistant_inbox_streams SET next_poll_at=?,poll_token=NULL,poll_expires_at=NULL,poll_generation=NULL WHERE source_key=? AND stream_id=?',
          time()+retryAfterMs,scope.key,streamId);
      });
    },
    /** Structural lookup in the SAME scoped event journal, never a content
     * index or permission to read/ACK. A trusted provider adapter may resolve
     * an unqualified native ID only from its own previously persisted refs.
     * SQL parameters preserve exact suffixes; no LIKE wildcard or full journal
     * is exposed. Ambiguous/oversized candidates remain an explicit blocker. */
    findEventRefsBySuffix(scopeInput, suffixes) {
      const scope = scopeOf(scopeInput); source(scope);
      if (!Array.isArray(suffixes) || !suffixes.length || suffixes.length > MAX_PAGE
        || new Set(suffixes).size !== suffixes.length) inputError();
      const values = suffixes.map(value => opaque(value, 64));
      const matches = all(`SELECT DISTINCT event_id FROM assistant_inbox_events WHERE source_key=? AND
        (${values.map(() => 'substr(event_id,-length(?))=? COLLATE BINARY').join(' OR ')}) ORDER BY event_id LIMIT 101`,
        scope.key, ...values.flatMap(value => [value, value]));
      if (matches.length > MAX_PAGE) fail('ASSISTANT_INBOX_REFERENCE_AMBIGUOUS');
      return matches.map(row => ({ id: row.event_id }));
    },
    /** Current backend approval, not an inference from an incoming message. */
    applyTaskState(scopeInput, { taskId, state, expectedRevision, authority = null }) {
      const scope = scopeOf(scopeInput); taskId = uuid(taskId); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER);
      if (!['accepted', 'waiting_owner', 'paused', 'done', 'revoked'].includes(state)) inputError();
      if (authority !== null) {
        object(authority, ['bindingId', 'revision']);
        authority = { bindingId: uuid(authority.bindingId), revision: integer(authority.revision, 0, Number.MAX_SAFE_INTEGER) };
      }
      return transaction(() => {
        activeSource(scope);
        const old = get('SELECT * FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', scope.key, taskId);
        if (!old && get('SELECT count(*) AS total FROM assistant_inbox_tasks').total >= 10_000) fail('ASSISTANT_INBOX_FULL');
        if ((old?.revision ?? 0) !== expectedRevision) fail('ASSISTANT_INBOX_CONFLICT');
        if (old?.authority_binding_id) {
          if (!authority || old.authority_binding_id !== authority.bindingId || authority.revision < old.authority_revision) fail('ASSISTANT_INBOX_CONFLICT');
          if (authority.revision === old.authority_revision) {
            if (old.state !== state) fail('ASSISTANT_INBOX_CONFLICT');
            return { revision: old.revision };
          }
        } else if (old?.state === 'revoked' && !authority) fail('ASSISTANT_INBOX_CONFLICT');
        // A newer live server decision can resume a removed/re-added assignment;
        // replaying its old revision or dropping provenance cannot. This is only
        // local scheduling state: fresh authorize is still mandatory on dispatch.
        run(`INSERT INTO assistant_inbox_tasks(source_key,task_id,state,revision,authority_binding_id,authority_revision) VALUES (?,?,?,?,?,?)
          ON CONFLICT(source_key,task_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,
            authority_binding_id=excluded.authority_binding_id,authority_revision=excluded.authority_revision`,
          scope.key, taskId, state, expectedRevision + 1, authority?.bindingId ?? null, authority?.revision ?? null);
        return { revision: expectedRevision + 1 };
      });
    },
    taskState(scopeInput, taskId) {
      const scope = scopeOf(scopeInput); taskId = uuid(taskId); source(scope);
      const row = get('SELECT state,revision,authority_binding_id,authority_revision FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', scope.key, taskId);
      return row ? { state: row.state, revision: row.revision, authority: row.authority_binding_id
        ? { bindingId: row.authority_binding_id, revision: row.authority_revision } : null } : null;
    },
    listTasks(scopeInput) {
      const scope = scopeOf(scopeInput); source(scope);
      return all('SELECT task_id FROM assistant_inbox_tasks WHERE source_key=? ORDER BY task_id LIMIT 10000', scope.key)
        .map(row => ({ taskId: row.task_id, ...this.taskState(scopeInput, row.task_id) }));
    },
    /** Bounded source enumeration contains no labels, credentials or content. */
    listSources() {
      return all('SELECT scope_json,state FROM assistant_inbox_sources ORDER BY source_key LIMIT 256')
        .map(row => ({ scope: scopeInputWithoutKey(JSON.parse(row.scope_json)), state: row.state }));
    },
    /** Failed read-only polls retain their cursor and durable bounded backoff. */
    abandonPoll(scopeInput, { token, retryAfterMs }) {
      const scope = scopeOf(scopeInput); uuid(token); integer(retryAfterMs, 30_000, 3_600_000);
      return transaction(() => {
        validPoll(scope, token);
        run('UPDATE assistant_inbox_sources SET next_poll_at=?,poll_token=NULL,poll_expires_at=NULL WHERE source_key=?', time() + retryAfterMs, scope.key);
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
    pendingExternalRoutes(scopeInput){
      const scope=scopeOf(scopeInput);if(!['telegram','email'].includes(scope.provider))inputError();activeSource(scope);
      return all(`SELECT event_key,event_id,event_revision,conversation_key,task_id,route_id,route_source_revision,route_checked_at
        FROM assistant_inbox_events WHERE source_key=? AND processed=0 AND conversation_key IS NOT NULL
        AND (route_checked_at=0 OR route_checked_at<=?) ORDER BY route_checked_at,rowid LIMIT 100`,scope.key,Math.max(0,time()-300_000));
    },
    deferExternalRouting(scopeInput,{sourceRevision,eventKeys}){
      const scope=scopeOf(scopeInput);if(!['telegram','email'].includes(scope.provider))inputError();integer(sourceRevision,0,2_147_483_647);
      if(!Array.isArray(eventKeys)||!eventKeys.length||eventKeys.length>100||new Set(eventKeys).size!==eventKeys.length
        ||eventKeys.some(key=>typeof key!=='string'||!/^[0-9a-f]{64}$/u.test(key)))inputError();
      return transaction(()=>{
        if(activeSource(scope).configuration_revision!==sourceRevision)fail('ASSISTANT_INBOX_CONFLICT');
        // Read-only lookup backoff, NOT an empty native mapping result. Keep
        // any previous route intact; dispatch still repeats live authority.
        // Persisting the attempt clock prevents a broken first account from
        // starving later accounts after every service restart.
        for(const key of eventKeys)run('UPDATE assistant_inbox_events SET route_checked_at=? WHERE source_key=? AND event_key=? AND processed=0',time(),scope.key,key);
      });
    },
    routeExternalEvents(scopeInput,{canonicalSource,sourceRevision,eventKeys,routes}){
      const scope=scopeOf(scopeInput),canonical=scopeOf(canonicalSource);
      if(!['telegram','email'].includes(scope.provider)||canonical.provider!=='trelio'
        ||['origin','assistantId','companyId'].some(key=>scope[key]!==canonical[key])
        ||!Array.isArray(routes)||routes.length>100||!Array.isArray(eventKeys)||!eventKeys.length||eventKeys.length>100
        ||eventKeys.some(key=>typeof key!=='string'||!/^[a-f0-9]{64}$/u.test(key))||new Set(eventKeys).size!==eventKeys.length)inputError();
      integer(sourceRevision,0,2_147_483_647);
      const projected=routes.map(row=>{
        object(row,['id','sourceId','sourceRevision','conversationKey','bindingId','bindingRevision','taskId']);
        if(row.sourceId!==scope.bindingId||row.sourceRevision!==sourceRevision
          ||!assistantConversationKeyMatches(scope.provider,row.conversationKey))inputError();
        return {...row,id:uuid(row.id),taskId:uuid(row.taskId),bindingId:uuid(row.bindingId),bindingRevision:integer(row.bindingRevision,0,2_147_483_647)};
      });
      if(new Set(projected.map(row=>row.conversationKey)).size!==projected.length)inputError();
      return transaction(()=>{
        if(activeSource(scope).configuration_revision!==sourceRevision)fail('ASSISTANT_INBOX_CONFLICT');
        activeSource(canonical);
        const selected=eventKeys.map(key=>get('SELECT * FROM assistant_inbox_events WHERE source_key=? AND event_key=? AND processed=0',scope.key,key));
        if(selected.some(row=>!row?.conversation_key))fail('ASSISTANT_INBOX_CONFLICT');
        if(projected.some(route=>!selected.some(row=>row.conversation_key===route.conversationKey)))inputError();
        for(const row of projected){
          const task=get('SELECT * FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?',canonical.key,row.taskId);
          // A mapping cannot provision a task or overwrite its permanent chat.
          // The native accepted task inventory remains the scheduling source.
          if(!task||task.state!=='accepted'||task.authority_binding_id!==row.bindingId||task.authority_revision!==row.bindingRevision)
            fail('ASSISTANT_INBOX_TASK_REQUIRED');
          const old=get('SELECT * FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?',scope.key,row.taskId);
          if(!old||old.state!=='accepted'||old.authority_binding_id!==row.bindingId||old.authority_revision!==row.bindingRevision){
            if(!old&&get('SELECT count(*) AS total FROM assistant_inbox_tasks').total>=10_000)fail('ASSISTANT_INBOX_FULL');
            run(`INSERT INTO assistant_inbox_tasks(source_key,task_id,state,revision,authority_binding_id,authority_revision) VALUES (?,?,'accepted',?,?,?)
              ON CONFLICT(source_key,task_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,
                authority_binding_id=excluded.authority_binding_id,authority_revision=excluded.authority_revision`,
              scope.key,row.taskId,(old?.revision??0)+1,row.bindingId,row.bindingRevision);
          }
          const conflict=get(`SELECT 1 FROM assistant_inbox_events WHERE source_key=? AND processed=0
            AND conversation_key=? AND task_id IS NOT NULL AND (task_id!=? OR route_id!=?)`,scope.key,row.conversationKey,row.taskId,row.id);
          if(conflict)fail('ASSISTANT_INBOX_CONFLICT');
        }
        // This successful lookup is authoritative only for the exact requested
        // bounded keys. Absent/revoked routes lose dispatch eligibility, while
        // a failed network lookup never reaches this transaction or becomes [].
        for(const event of selected){
          const route=projected.find(row=>row.conversationKey===event.conversation_key);
          run(`UPDATE assistant_inbox_events SET task_id=?,dispatch_source_key=?,route_id=?,route_source_revision=?,route_checked_at=?
            WHERE event_key=?`,route?.taskId??null,route?canonical.key:null,route?.id??null,route?sourceRevision:null,time(),event.event_key);
        }
      });
    },
    /** Internal trusted native-read observer, NOT a model tool or read grant.
     * Caller must validate a complete signed provider result for this exact
     * account/key/ref/revision before calling. This ledger only binds that
     * evidence to the current durable delivery; native business completion is
     * still required, and no message body is accepted or saved here. */
    recordExternalRead(scopeInput,{deliveryId,eventKey,sourceRevision,routeId,originalSha256=null}){
      const scope=scopeOf(scopeInput);if(!['telegram','email'].includes(scope.provider))inputError();
      if(scope.provider==='email'?!/^[0-9a-f]{64}$/u.test(originalSha256??''):originalSha256!==null)inputError();
      deliveryId=uuid(deliveryId);routeId=uuid(routeId);integer(sourceRevision,0,2_147_483_647);
      if(typeof eventKey!=='string'||!/^[0-9a-f]{64}$/u.test(eventKey))inputError();
      return transaction(()=>{
        if(activeSource(scope).configuration_revision!==sourceRevision)fail('ASSISTANT_INBOX_CONFLICT');
        const job=delivery(deliveryId),event=get(`SELECT e.*,de.route_id AS original_route_id,de.route_source_revision AS original_source_revision FROM assistant_inbox_events e
          JOIN assistant_inbox_delivery_events de ON de.event_key=e.event_key WHERE de.delivery_id=? AND e.event_key=? AND e.source_key=?`,deliveryId,eventKey,scope.key);
        const task=get('SELECT * FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?',job.source_key,job.task_id);
        if(job.state!=='started'||!job.native_started||job.expires_at<=time()||task?.state!=='accepted'||task.revision!==job.task_revision
          ||!event?.conversation_key||event.route_id!==routeId||event.route_source_revision!==sourceRevision
          ||event.original_route_id!==routeId||event.original_source_revision!==sourceRevision
          ||event.dispatch_source_key!==job.source_key||event.task_id!==job.task_id)fail('ASSISTANT_INBOX_STALE_DELIVERY');
        // IMAP identity revisions bind UID/UIDVALIDITY, not mutable RFC822
        // bytes. Never replace independently observed bytes at that same ref.
        if(originalSha256!==null&&event.read_original_sha256!==null&&event.read_original_sha256!==originalSha256)
          fail('ASSISTANT_INBOX_EVENT_CHANGED');
        run('UPDATE assistant_inbox_events SET read_delivery_id=?,read_original_sha256=? WHERE event_key=?',deliveryId,originalSha256,eventKey);
      });
    },
    /** Protected task/observer lookup, not a model tool. Original slots are
     * rechecked synchronously against current source/route/task generation.
     * Keep read evidence independent from explicit committed processing. */
    externalDeliveryReferences(pass,{selected=null,requireRead=false,allowTaskDone=false}={}){
      const job=delivery(uuid(pass.deliveryId));
      const canonical=JSON.parse(get('SELECT scope_json FROM assistant_inbox_sources WHERE source_key=?',job.source_key).scope_json);
      const task=get('SELECT * FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?',job.source_key,job.task_id);
      if(canonical.provider!=='trelio'||canonical.assistantId!==uuid(pass.assistantId)||canonical.companyId!==uuid(pass.companyId)
        ||job.task_id!==uuid(pass.taskId)||job.kind!=='task'
        ||job.state!=='started'||!job.native_started||job.expires_at<=time()
        ||!(task?.state==='accepted'&&task.revision===job.task_revision&&task.authority_revision===pass.bindingRevision
          ||allowTaskDone&&requireRead&&task?.state==='done'&&task.revision>=job.task_revision)
        ||task.authority_binding_id!==uuid(pass.bindingId))fail('ASSISTANT_INBOX_STALE_DELIVERY');
      assertExternalDeliverySnapshot(job);
      const refs=deliveryEvents(job.delivery_id).filter(row=>row.conversation_key).map(row=>{
        const scope=JSON.parse(row.event_scope_json);
        const live=get('SELECT read_delivery_id,read_original_sha256 FROM assistant_inbox_events WHERE event_key=?',row.event_key);
        return {...row,scope:scopeInputWithoutKey(scope),sourceId:scope.bindingId,sourceRevision:row.route_source_revision,
          routeId:row.route_id,eventOrdinal:row.event_ordinal,read:live?.read_delivery_id===job.delivery_id
            &&(scope.provider!=='email'||/^[0-9a-f]{64}$/u.test(live.read_original_sha256??''))};
      });
      const selection=selected===null?null:assistantSourceProcessingReferences(selected);
      const result=selection===null?refs:selection.map(ref=>{
        const row=refs.find(row=>row.eventOrdinal===ref.eventOrdinal&&row.sourceId===ref.sourceId
          &&row.sourceRevision===ref.sourceRevision&&row.routeId===ref.routeId);
        if(!row)fail('ASSISTANT_INBOX_STALE_DELIVERY');return row;
      });
      if(requireRead&&result.some(row=>!row.read))fail('ASSISTANT_INBOX_SOURCE_READ_REQUIRED');
      return result;
    },
    /**
     * `authorize` MUST use fresh server/provider ACL, assistant lifecycle and
     * task-start approval. Local rows and this callback's return grant no rights.
     * No DB lock is held during I/O; revisions are rechecked after the callback.
     */
    async claimDelivery({ authorize, scheduledTask = null, provisionTask = null, excludeCompanyIds = [] }) {
      if (typeof authorize !== 'function') inputError();
      if (!Array.isArray(excludeCompanyIds) || excludeCompanyIds.length > 256) inputError();
      const excluded = [...new Set(excludeCompanyIds.map(uuid))];
      // Skip a blocked company without changing source/task state or reading
      // events. Remaining candidates still require their own live authority.
      const exclusion = excluded.length ? ` AND json_extract(s.scope_json,'$.companyId') NOT IN (${excluded.map(()=>'?').join(',')})` : '';
      // A real cyclic adapter may request the next pass for an exact task. It
      // does not turn context-only events into an unsolicited event wake-up.
      let scheduled = null;
      if (scheduledTask !== null && provisionTask !== null) inputError();
      const exactTask = scheduledTask ?? provisionTask;
      if (exactTask !== null) {
        object(exactTask, ['scope', 'taskId']);
        scheduled = { scope: scopeOf(exactTask.scope), taskId: uuid(exactTask.taskId) };
      }
      const candidate = transaction(() => {
        recoverExpired();
        // One desktop worker globally, including across companies/accounts. An
        // ambiguous turn blocks a second dispatch until native read-back resolves it.
        if (get("SELECT 1 FROM assistant_inbox_deliveries WHERE state IN ('leased','started','uncertain')")) return null;
        if (scheduled) return get(`SELECT t.source_key,t.task_id,t.revision,s.scope_json,s.revision AS source_revision FROM assistant_inbox_tasks t
          JOIN assistant_inbox_sources s ON s.source_key=t.source_key
          WHERE t.source_key=? AND t.task_id=? AND t.state='accepted' AND s.state='active'${exclusion}`, scheduled.scope.key, scheduled.taskId,...excluded);
        return get(`SELECT t.source_key,e.task_id,t.revision,s.scope_json,s.revision AS source_revision FROM assistant_inbox_events e
          JOIN assistant_inbox_sources es ON es.source_key=e.source_key
          JOIN assistant_inbox_sources s ON s.source_key=coalesce(e.dispatch_source_key,e.source_key)
          JOIN assistant_inbox_tasks t ON t.source_key=s.source_key AND t.task_id=e.task_id
          WHERE e.processed=0 AND e.dispatched=0 AND (e.wake=1 OR e.dispatch_source_key IS NOT NULL AND e.provider_wake=1)
          AND es.state='active' AND s.state='active' AND t.state='accepted'${exclusion} ORDER BY e.rowid LIMIT 1`,...excluded);
      });
      if (!candidate) return null;
      const scope = JSON.parse(candidate.scope_json);
      if (await authorize({ scope: scopeInputWithoutKey(scope), taskId: candidate.task_id }) !== true) fail('ASSISTANT_INBOX_ACCESS_DENIED');
      return transaction(() => {
        if (activeSource(scope).revision !== candidate.source_revision) fail('ASSISTANT_INBOX_CONFLICT');
        const task = get('SELECT * FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', scope.key, candidate.task_id);
        if (task?.state !== 'accepted' || task.revision !== candidate.revision) fail('ASSISTANT_INBOX_CONFLICT');
        if (get("SELECT 1 FROM assistant_inbox_deliveries WHERE state IN ('leased','started','uncertain')")) return null;
        const events = provisionTask ? [] : all(`SELECT e.event_key,e.event_id,e.event_revision,e.wake,e.owner_question_id,
          e.conversation_key,e.route_id,e.route_source_revision,s.scope_json AS event_scope_json
          FROM assistant_inbox_events e JOIN assistant_inbox_sources s ON s.source_key=e.source_key
          WHERE coalesce(e.dispatch_source_key,e.source_key)=? AND e.task_id=? AND e.processed=0 AND s.state='active'
          ORDER BY CASE WHEN e.dispatched=0 AND (e.wake=1 OR e.dispatch_source_key IS NOT NULL AND e.provider_wake=1)
            THEN 0 ELSE 1 END,e.rowid LIMIT 100`,scope.key,task.task_id);
        if (!events.length && !scheduled) return null;
        if (get('SELECT count(*) AS total FROM assistant_inbox_deliveries').total >= MAX_EVENTS) fail('ASSISTANT_INBOX_FULL');
        const id = randomUUID();
        const kind = provisionTask ? 'provision' : 'task';
        run("INSERT INTO assistant_inbox_deliveries(delivery_id,source_key,task_id,task_revision,state,expires_at,scheduled,kind) VALUES (?,?,?,?,'leased',?,?,?)", id, scope.key, task.task_id, task.revision, time() + LEASE_MS, Number(Boolean(scheduledTask)), kind);
        // Put the actual undispatched wake into this bounded batch even when
        // old unread context fills a page. Persist the order/scope snapshot so
        // recovery cannot select a different set or loop on the same old page.
        for (const [ordinal,event] of events.entries()) run(`INSERT INTO assistant_inbox_delivery_events(delivery_id,event_key,conversation_key,route_id,route_source_revision,event_ordinal)
          VALUES (?,?,?,?,?,?)`,id,event.event_key,event.conversation_key,event.route_id,event.route_source_revision,ordinal);
        return { deliveryId: id, taskId: task.task_id, scope: scopeInputWithoutKey(scope),
          events:events.map((event,event_ordinal)=>({...event,event_ordinal})), kind };
      });
    },
    startDelivery(id) {
      return transaction(() => {
        const row = delivery(id);
        const scope = JSON.parse(get('SELECT scope_json FROM assistant_inbox_sources WHERE source_key=?', row.source_key).scope_json);
        activeSource(scope);
        const task = get('SELECT state,revision FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', row.source_key, row.task_id);
        const eligible = row.state === 'leased' || (row.state === 'started' && !row.native_started);
        if (!eligible || row.native_started || row.expires_at <= time() || task?.state !== 'accepted' || task.revision !== row.task_revision) fail('ASSISTANT_INBOX_STALE_DELIVERY');
        assertExternalDeliverySnapshot(row);
        run("UPDATE assistant_inbox_deliveries SET state='started',native_started=1 WHERE delivery_id=?", id);
      });
    },
    /** A server host claim can be retried by its exact durable ID before native
     * invocation. Persist this fence first; restart can distinguish that safe
     * phase from a lost native launch/ID, which must never be replayed. */
    prepareProvision(id) {
      return transaction(() => {
        const row = delivery(id);
        const scope = JSON.parse(get('SELECT scope_json FROM assistant_inbox_sources WHERE source_key=?', row.source_key).scope_json);
        activeSource(scope);
        const task = get('SELECT state,revision FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', row.source_key, row.task_id);
        if (row.kind !== 'provision' || row.native_started || !['leased','started','uncertain'].includes(row.state)
          || task?.state !== 'accepted' || task.revision !== row.task_revision) fail('ASSISTANT_INBOX_STALE_DELIVERY');
        run("UPDATE assistant_inbox_deliveries SET state='started',expires_at=? WHERE delivery_id=?", time()+LEASE_MS, id);
      });
    },
    /** Persist the exact delivery before the server pass claim. This journal
     * can safely repeat only that idempotent claim if its response was lost;
     * native_started remains the irreversible native launch boundary. */
    prepareTaskPass(id) {
      return transaction(() => {
        const row = delivery(id);
        const scope = JSON.parse(get('SELECT scope_json FROM assistant_inbox_sources WHERE source_key=?', row.source_key).scope_json);
        activeSource(scope);
        const task = get('SELECT state,revision FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', row.source_key, row.task_id);
        if (row.kind !== 'task' || row.native_started || !['leased','started','uncertain'].includes(row.state)
          || task?.state !== 'accepted' || task.revision !== row.task_revision) fail('ASSISTANT_INBOX_STALE_DELIVERY');
        assertExternalDeliverySnapshot(row);
        run("UPDATE assistant_inbox_deliveries SET state='started',expires_at=? WHERE delivery_id=?", time()+LEASE_MS, id);
      });
    },
    /** Renew only the exact still-authorized started attempt. An expired lease
     * is never revived: native read-back, rather than a second launch, resolves it. */
    renewDelivery(id) {
      return transaction(() => {
        const row = delivery(id);
        const scope = JSON.parse(get('SELECT scope_json FROM assistant_inbox_sources WHERE source_key=?', row.source_key).scope_json);
        activeSource(scope);
        const task = get('SELECT state,revision FROM assistant_inbox_tasks WHERE source_key=? AND task_id=?', row.source_key, row.task_id);
        if (row.state !== 'started' || row.expires_at <= time() || task?.state !== 'accepted' || task.revision !== row.task_revision) fail('ASSISTANT_INBOX_STALE_DELIVERY');
        assertExternalDeliverySnapshot(row);
        run('UPDATE assistant_inbox_deliveries SET expires_at=? WHERE delivery_id=?', time() + LEASE_MS, id);
      });
    },
    markDeliveryUncertain(id) {
      return transaction(() => {
        const row = delivery(id);
        if (!['started','uncertain'].includes(row.state)) fail('ASSISTANT_INBOX_STALE_DELIVERY');
        run("UPDATE assistant_inbox_deliveries SET state='uncertain' WHERE delivery_id=?", id);
      });
    },
    abandonUnstartedDelivery(id) {
      return transaction(() => {
        const row = delivery(id);
        if (row.state !== 'leased') fail('ASSISTANT_INBOX_STALE_DELIVERY');
        run("UPDATE assistant_inbox_deliveries SET state='not_accepted',external_receipt='host:never-started' WHERE delivery_id=?", id);
      });
    },
    /** Journal the native ID synchronously on thread.started, before reading
     * another frame. Losing that response leaves an uncertain provision and
     * blocks creating a second chat for the task. The ID can never be replaced. */
    bindProvisionedThread(id, threadId) {
      threadId = uuid(threadId);
      return transaction(() => {
        const row = delivery(id);
        if (row.kind !== 'provision' || row.state !== 'started' || !row.native_started || (row.native_thread_id && row.native_thread_id !== threadId)) fail('ASSISTANT_INBOX_STALE_DELIVERY');
        run('UPDATE assistant_inbox_deliveries SET native_thread_id=? WHERE delivery_id=?', threadId, id);
      });
    },
    incompleteDeliveries() {
      return transaction(() => {
        recoverExpired();
        return all("SELECT d.*,s.scope_json FROM assistant_inbox_deliveries d JOIN assistant_inbox_sources s ON s.source_key=d.source_key WHERE d.state IN ('leased','started','uncertain') LIMIT 1")
          .map(row => ({ deliveryId: row.delivery_id, taskId: row.task_id, scope: scopeInputWithoutKey(JSON.parse(row.scope_json)),
            state: row.state, kind: row.kind, threadId: row.native_thread_id, nativeStarted: Boolean(row.native_started),
            // Recovery before native start must carry the original event set,
            // including question refs. Never recreate it from the latest poll.
            events: deliveryEvents(row.delivery_id) }));
      });
    },
    readDelivery(id) {
      const row=delivery(uuid(id));
      const source=JSON.parse(get('SELECT scope_json FROM assistant_inbox_sources WHERE source_key=?',row.source_key).scope_json);
      return {deliveryId:row.delivery_id,taskId:row.task_id,scope:scopeInputWithoutKey(source),state:row.state,
        kind:row.kind,threadId:row.native_thread_id,nativeStarted:Boolean(row.native_started),receipt:row.external_receipt};
    },
    completeDelivery(id, receipt, completion = null) {
      opaque(receipt);
      return transaction(() => {
        const row = delivery(id);
        if (row.state === 'complete' && row.external_receipt === receipt) return;
        if (row.state !== 'started' && row.state !== 'uncertain') fail('ASSISTANT_INBOX_STALE_DELIVERY');
        // Whole-pass completion and even an actual body read are insufficient:
        // only explicit slots in the exact committed backend outcome count.
        // Validate the original immutable snapshot and independent read slot
        // before changing ANY event or calling the schedule callback.
        const selected=assistantSourceProcessingReferences(completion?.processedSourceReferences??[]);
        const selectedKeys=[];
        for(const ref of selected){
          const event=get(`SELECT e.*,de.route_id AS original_route_id,de.route_source_revision AS original_source_revision,
            s.scope_json,s.configuration_revision,s.state AS source_state FROM assistant_inbox_delivery_events de
            JOIN assistant_inbox_events e ON e.event_key=de.event_key JOIN assistant_inbox_sources s ON s.source_key=e.source_key
            WHERE de.delivery_id=? AND de.event_ordinal=?`,id,ref.eventOrdinal);
          if(!event||JSON.parse(event.scope_json).bindingId!==ref.sourceId||!['telegram','email'].includes(JSON.parse(event.scope_json).provider)
            ||JSON.parse(event.scope_json).provider==='email'&&!/^[0-9a-f]{64}$/u.test(event.read_original_sha256??'')
            ||event.source_state!=='active'||event.configuration_revision!==ref.sourceRevision
            ||event.original_route_id!==ref.routeId||event.original_source_revision!==ref.sourceRevision
            ||event.route_id!==ref.routeId||event.route_source_revision!==ref.sourceRevision
            ||event.task_id!==row.task_id||event.dispatch_source_key!==row.source_key||event.read_delivery_id!==id)
            fail('ASSISTANT_INBOX_SOURCE_READ_REQUIRED');
          selectedKeys.push(event.event_key);
        }
        // Exact positive native read-back can complete an uncertain turn. A
        // timeout or "chat exists" is insufficient evidence for this receipt.
        if (onDeliveryCompleted && row.kind !== 'provision') {
          const scope = scopeInputWithoutKey(JSON.parse(get('SELECT scope_json FROM assistant_inbox_sources WHERE source_key=?', row.source_key).scope_json));
          // Processing belongs to this inbox transaction, not the generic
          // schedule continuation schema. Preserve every other field so its
          // existing closed validator still rejects unexpected input.
          const scheduleCompletion=completion===null?null:Object.fromEntries(Object.entries(completion)
            .filter(([key])=>key!=='processedSourceReferences'));
          const result = onDeliveryCompleted({ scope, taskId: row.task_id, deliveryId: id, receipt, completedAt: time(), scheduled: Boolean(row.scheduled), completion:scheduleCompletion });
          if (result && typeof result.then === 'function') fail('ASSISTANT_INBOX_ASYNC_COMPLETION');
        }
        run("UPDATE assistant_inbox_deliveries SET state='complete',external_receipt=? WHERE delivery_id=?", receipt, id);
        run(`UPDATE assistant_inbox_events SET dispatched=1,processed=CASE WHEN
          source_key IN (SELECT source_key FROM assistant_inbox_sources WHERE json_extract(scope_json,'$.provider')='trelio')
          THEN 1 ELSE processed END
          WHERE event_key IN (SELECT event_key FROM assistant_inbox_delivery_events WHERE delivery_id=?)`,id);
        for(const key of selectedKeys)run('UPDATE assistant_inbox_events SET processed=1 WHERE event_key=?',key);
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
    /** Pure due discovery avoids native/source I/O for an empty ACK queue.
     * Global original row order lets a bounded coordinator choose old work
     * across companies; retries retain their original per-event backoff. */
    externalAcknowledgementDue(scopeInput){
      const scope=scopeOf(scopeInput);if(scope.provider==='trelio')inputError();
      if(source(scope).state!=='active')return null;
      const row=get(`SELECT e.rowid AS ordinal FROM assistant_inbox_events e
        JOIN assistant_inbox_tasks t ON t.source_key=e.source_key AND t.task_id=e.task_id
        WHERE e.source_key=? AND e.acked=0 AND e.processed=1 AND t.state IN ('accepted','done')
        AND e.ack_retry_at<=? AND (e.ack_token IS NULL OR e.ack_expires_at<=?) ORDER BY e.rowid LIMIT 1`,scope.key,time(),time());
      return row?.ordinal??null;
    },
    /** Diagnostic projection of the SAME durable ACK journal, not permission
     * to read/write a provider. Do not clear another conversation's unknown
     * attempt after one positive token. A successful complete survives report
     * failure/restart and can reconcile its native notice on a later poll.
     * An empty/new source supplies NO success evidence. Old generation fences
     * remain visible; only current-generation confirmed rows witness recovery. */
    externalAcknowledgementHealth(scopeInput){
      const scope=scopeOf(scopeInput);if(!['telegram','email'].includes(scope.provider))inputError();
      const current=activeSource(scope);
      const row=get(`SELECT
        sum(CASE WHEN acked=0 AND ack_started=1 THEN 1 ELSE 0 END) AS uncertain,
        sum(CASE WHEN acked=0 AND ack_retry_at>0 THEN 1 ELSE 0 END) AS blocked,
        sum(CASE WHEN acked=1 AND route_source_revision=? THEN 1 ELSE 0 END) AS confirmed
        FROM assistant_inbox_events WHERE source_key=?`,current.configuration_revision,scope.key);
      // A fresh native read-back of historical slots can confirm this current
      // registration even though its immutable route remains older. The SAME
      // completion transaction records that revision; prior-generation success
      // or a lost uncommitted report never manufactures this evidence.
      const currentReadBack=current.configuration_revision!==null&&current.ack_verified_revision===current.configuration_revision;
      return row.uncertain>0?'acknowledgement_uncertain':row.blocked>0?'acknowledgement_blocked':row.confirmed>0||currentReadBack?'ready':null;
    },
    /** Read acknowledgements are separate bounded outbox operations. */
    claimAcknowledgements(scopeInput) {
      const scope = scopeOf(scopeInput);
      return transaction(() => {
        const current = activeSource(scope);
        // Unrouted events, owner-pending tasks and mere discovery are NOT read.
        // Durably accepted task inbox entries may be acknowledged even while
        // waiting for the next scheduled task pass; ordinary comments do not wake it.
        // Messenger/email discovery contains references only. Require durable
        // processing before even offering an external ACK. The provider adapter
        // must still verify actual content-read evidence and exact revision;
        // neither this SQL flag nor a generic completion boolean grants that.
        let candidates = all(`SELECT e.event_key,e.event_id,e.event_revision,e.task_id,e.ack_started,e.ack_attempt_token,e.conversation_key,e.route_source_revision FROM assistant_inbox_events e
          JOIN assistant_inbox_tasks t ON t.source_key=e.source_key AND t.task_id=e.task_id
          WHERE e.source_key=? AND e.acked=0 AND (t.state='accepted' OR (?!='trelio' AND t.state='done'))
          AND (?='trelio' OR e.processed=1)
          AND e.ack_retry_at<=? AND (e.ack_token IS NULL OR e.ack_expires_at<=?) ORDER BY e.ack_retry_at,e.rowid LIMIT 100`, scope.key, scope.provider, scope.provider, time(), time());
        // Rotate previously deferred conversations behind never-attempted work
        // and earlier retries. At a five-minute tick, repeatedly picking the
        // first row alone could otherwise starve every later conversation.
        if (!candidates.length) return null;
        if(scope.provider!=='trelio'&&candidates[0].ack_started===1){
          // Discovery's 100-row window may interleave another old attempt. Do
          // not split the selected ORIGINAL attempt and positively complete a
          // subset of its conversations. Unknown legacy groups above the wire
          // bound remain fenced instead of silently truncating membership.
          candidates=all(`SELECT e.*,t.state AS task_state FROM assistant_inbox_events e
            LEFT JOIN assistant_inbox_tasks t ON t.source_key=e.source_key AND t.task_id=e.task_id
            WHERE e.source_key=? AND e.acked=0 AND e.ack_started=1 AND e.ack_attempt_token IS ? ORDER BY e.rowid LIMIT 101`,scope.key,candidates[0].ack_attempt_token);
          if(candidates.length>100)fail('ASSISTANT_INBOX_STALE_ACK');
          if(candidates.some(row=>row.processed!==1||!['accepted','done'].includes(row.task_state)
            ||row.ack_retry_at>time()||row.ack_token!==null&&row.ack_expires_at>time()))return null;
        }
        // Never mix a fresh provider attempt with recovery from an old one.
        // An expired ACK lease is NOT evidence that a mutation did not happen.
        // A never-started OLD generation is also read-back only: resume does
        // not adopt that historical route for a new provider write. Its claim
        // mode is persisted separately from ack_started, which must continue
        // to describe only an actual prior invocation boundary.
        const readBack=row=>row.ack_started===1||(current.configuration_revision!==null
          &&row.route_source_revision!==current.configuration_revision);
        const reconcileOnly=scope.provider!=='trelio'&&readBack(candidates[0]);
        // ONE new range write belongs to ONE exact conversation. Old uncertain
        // attempts retain their original membership, even if an older host
        // mixed conversations; that entire group is read-back only. Never let
        // one chat's positive result complete another chat's write token.
        const events=candidates.filter(row=>scope.provider==='trelio'||readBack(row)===reconcileOnly
          &&row.ack_started===candidates[0].ack_started
          && (candidates[0].ack_started===1?row.ack_attempt_token===candidates[0].ack_attempt_token
            :scope.provider==='email'?row.event_key===candidates[0].event_key:row.conversation_key===candidates[0].conversation_key))
          .map(({event_key,event_id,event_revision,task_id})=>({event_key,event_id,event_revision,task_id}));
        const token = randomUUID();
        for (const event of events) run('UPDATE assistant_inbox_events SET ack_token=?,ack_expires_at=?,ack_verify_only=? WHERE event_key=?', token, time() + LEASE_MS, Number(reconcileOnly), event.event_key);
        return { token, events, ...(scope.provider==='trelio'?{}:{reconcileOnly}) };
      });
    },
    /** Private adapter lookup, not a model/tool read or write grant. Reuse the
     * original native-read delivery and its committed backend receipt; a local
     * processed bit alone supplies neither provenance nor external authority.
     * No body or second receipt journal is introduced. Native admission checks
     * current task/assignment/route/material again before provider invocation. */
    externalAcknowledgementReferences(scopeInput,{token,sourceRevision,verifyOnly=false}) {
      const scope=scopeOf(scopeInput);uuid(token);integer(sourceRevision,0,2_147_483_647);
      if(!['telegram','email'].includes(scope.provider)||typeof verifyOnly!=='boolean')inputError();
      if(activeSource(scope).configuration_revision!==sourceRevision)fail('ASSISTANT_INBOX_CONFLICT');
      const rows=all(`SELECT e.*,de.event_ordinal,de.route_id AS original_route_id,
        de.route_source_revision AS original_source_revision,d.state AS delivery_state,d.external_receipt
        FROM assistant_inbox_events e JOIN assistant_inbox_delivery_events de
          ON de.event_key=e.event_key AND de.delivery_id=e.read_delivery_id
        JOIN assistant_inbox_deliveries d ON d.delivery_id=de.delivery_id
        WHERE e.source_key=? AND e.ack_token=? AND e.acked=0 ORDER BY e.rowid`,scope.key,token);
      const expected=get('SELECT count(*) AS total FROM assistant_inbox_events WHERE source_key=? AND ack_token=? AND acked=0',scope.key,token).total;
      if(!rows.length||rows.length!==expected||rows.length>100)fail('ASSISTANT_INBOX_STALE_ACK');
      return rows.map(row=>{
        const parts=typeof row.external_receipt==='string'?row.external_receipt.split(':'):[];
        if(row.processed!==1||row.ack_expires_at<=time()||row.delivery_state!=='complete'
          ||!assistantConversationKeyMatches(scope.provider,row.conversation_key)
          ||scope.provider==='email'&&!/^[0-9a-f]{64}$/u.test(row.read_original_sha256??'')
          ||row.route_source_revision!==row.original_source_revision
          // The durable lease mode, not a caller boolean, selects historical
          // read-back. Resume never adopts an old route for a new write or
          // changes the original committed receipt slots.
          ||row.ack_verify_only!==Number(verifyOnly)
          ||(!verifyOnly&&row.original_source_revision!==sourceRevision)
          ||(verifyOnly&&(!Number.isSafeInteger(row.original_source_revision)
            ||row.original_source_revision<0||row.original_source_revision>sourceRevision))
          ||row.route_id!==row.original_route_id||parts.length!==5||parts[0]!=='assistant'||parts[2]!=='codex'
          ||!UUID.test(parts[1])||!UUID.test(parts[3])||!UUID.test(parts[4]))fail('ASSISTANT_INBOX_SOURCE_READ_REQUIRED');
        return {eventKey:row.event_key,id:row.event_id,revision:row.event_revision,conversationKey:row.conversation_key,
          routeId:row.route_id,eventOrdinal:row.event_ordinal,receiptId:parts[1],taskId:row.task_id,
          ...(scope.provider==='email'?{originalSha256:row.read_original_sha256}:{})};
      });
    },
    /** Host-only fence immediately BEFORE the one native provider invocation.
     * Fresh domain ACL, exact read proof and committed processing are still
     * required by that adapter. This SQLite bit is never sending authority. */
    startExternalAcknowledgements(scopeInput,token) {
      const scope=scopeOf(scopeInput);uuid(token);
      if(scope.provider==='trelio')inputError();
      return transaction(()=>{
        activeSource(scope);
        const rows=all('SELECT ack_started,ack_verify_only,processed,ack_expires_at FROM assistant_inbox_events WHERE source_key=? AND ack_token=? AND acked=0',scope.key,token);
        if(!rows.length || rows.some(row=>row.ack_started!==0 || row.ack_verify_only!==0 || row.processed!==1 || row.ack_expires_at<=time()))fail('ASSISTANT_INBOX_STALE_ACK');
        run('UPDATE assistant_inbox_events SET ack_started=1,ack_attempt_token=? WHERE source_key=? AND ack_token=? AND acked=0',token,scope.key,token);
      });
    },
    /** Bounded recovery backoff without erasing an uncertain provider attempt.
     * notAttempted is accepted ONLY from a complete, validated signed native
     * provider result proving no write; never from model text, a timeout, an
     * absent response or verify-only acknowledged=false. It is not a replay. */
    deferExternalAcknowledgements(scopeInput,{token,retryAfterMs,notAttempted=false}) {
      const scope=scopeOf(scopeInput);uuid(token);integer(retryAfterMs,30_000,3_600_000);
      if(scope.provider==='trelio'||typeof notAttempted!=='boolean')inputError();
      return transaction(()=>{
        activeSource(scope);
        const rows=all('SELECT ack_expires_at,ack_started,ack_attempt_token FROM assistant_inbox_events WHERE source_key=? AND ack_token=? AND acked=0',scope.key,token);
        if(!rows.length||rows.some(row=>row.ack_expires_at<=time()
          || notAttempted && (row.ack_started!==1 || row.ack_attempt_token!==token)))fail('ASSISTANT_INBOX_STALE_ACK');
        // Recovery invalidates the old lease immediately. A separate structural
        // retry time must NOT extend its original expiry or admit a late reply.
        run('UPDATE assistant_inbox_events SET ack_token=NULL,ack_expires_at=NULL,ack_retry_at=?,ack_started=CASE WHEN ? THEN 0 ELSE ack_started END,ack_attempt_token=CASE WHEN ? THEN NULL ELSE ack_attempt_token END WHERE source_key=? AND ack_token=? AND acked=0',
          time()+retryAfterMs,Number(notAttempted),Number(notAttempted),scope.key,token);
      });
    },
    completeAcknowledgements(scopeInput, token) {
      const scope = scopeOf(scopeInput); uuid(token);
      return transaction(() => {
        const current = activeSource(scope);
        // A token issued by an older worker before this source guard is not
        // upgraded into read evidence. Reject the entire batch, including mixed
        // processed/unprocessed rows, without clearing its ambiguous outcome.
        // A current durable read-only lease may confirm a never-started old
        // slot without inventing a provider-write attempt in ack_started.
        if (scope.provider !== 'trelio' && get('SELECT count(*) AS total FROM assistant_inbox_events WHERE source_key=? AND ack_token=? AND acked=0 AND (processed=0 OR (ack_started=0 AND ack_verify_only=0))', scope.key, token).total) fail('ASSISTANT_INBOX_STALE_ACK');
        const pending = get('SELECT count(*) AS total,sum(CASE WHEN ack_expires_at>? THEN 0 ELSE 1 END) AS expired FROM assistant_inbox_events WHERE source_key=? AND ack_token=? AND acked=0', time(), scope.key, token);
        if (!pending.total||pending.expired>0) fail('ASSISTANT_INBOX_STALE_ACK');
        run('UPDATE assistant_inbox_events SET acked=1,ack_token=NULL,ack_expires_at=NULL WHERE source_key=? AND ack_token=?', scope.key, token);
        // The trusted adapter calls this only after positive native read-back
        // for EVERY conversation in this exact attempt. A source change has
        // already invalidated its lease; no old worker can stamp a new revision.
        if(scope.provider!=='trelio'&&current.configuration_revision!==null)
          run('UPDATE assistant_inbox_sources SET ack_verified_revision=? WHERE source_key=?',current.configuration_revision,scope.key);
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
