/** Runtime-owned cyclic task scheduling. Contains no provider text or secrets. */
import { createHash } from 'node:crypto';

export class AssistantScheduleError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AssistantScheduleError(code); };
const invalid = () => fail('ASSISTANT_SCHEDULE_INVALID_INPUT');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); };
const timestamp = value => { if (!Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000_000) invalid(); return value; };
const cadenceValues = ['every_30_minutes','hourly','every_3_hours','every_6_hours','every_12_hours','daily','weekly','fortnightly','monthly'];
export const ASSISTANT_CADENCES = Object.freeze(cadenceValues);
export const ASSISTANT_GOAL_STATES = Object.freeze(['active','waiting_external','waiting_owner','blocked','completed','cancelled']);
const cadenceOf = value => { if (!cadenceValues.includes(value)) invalid(); return value; };
const closed = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) invalid();
};
const formatter = zone => {
  if (typeof zone !== 'string' || zone.length > 100) invalid();
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); } catch { invalid(); }
};
/** Only the trusted exact backend receipt supplies continuation. Event text,
 * native completed turns and local files cannot author schedule changes. */
export const assistantPassContinuation = value => {
  closed(value, ['goalState','cadence','timeZone']);
  if (Object.keys(value).length !== 3 || !ASSISTANT_GOAL_STATES.includes(value.goalState)) invalid();
  cadenceOf(value.cadence); formatter(value.timeZone);
  return Object.freeze({ goalState:value.goalState,cadence:value.cadence,timeZone:value.timeZone });
};
const parts = (format, at) => Object.fromEntries(format.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
const localEpoch = p => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
const localFromEpoch = at => { const d = new Date(at); return { year: d.getUTCFullYear(), month: d.getUTCMonth()+1,
  day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() }; };

/** Resolve wall time without a fixed timezone offset. DST overlap picks the
 * earlier occurrence; a spring gap moves forward by the gap instead of skipping
 * a day or firing twice. Work is bounded independently of missed cycle count. */
const fromLocal = (format, target, milliseconds) => {
  const wanted = localEpoch(target);
  let guess = wanted;
  const guesses = [];
  for (let i = 0; i < 4; i++) {
    guess -= localEpoch(parts(format, guess)) - wanted;
    guesses.push(guess);
  }
  const matches = [];
  for (let minute = -120; minute <= 120; minute++) {
    const candidate = guess + minute * 60_000;
    if (localEpoch(parts(format, candidate)) === wanted) matches.push(candidate);
  }
  if (matches.length) return Math.min(...matches) + milliseconds;
  // Gaps produce two offset candidates on opposite sides of the missing wall
  // time. Pick the nearest forward candidate, including rare skipped-day zones.
  const forward = guesses.map(at => ({ at, delta: localEpoch(parts(format, at)) - wanted }))
    .filter(value => value.delta >= 0).sort((a,b) => a.delta - b.delta || a.at - b.at);
  if (!forward.length) fail('ASSISTANT_SCHEDULE_TIMEZONE_UNAVAILABLE');
  return forward[0].at + milliseconds;
};

export const nextAssistantRun = ({ cadence, anchorAt, after, timeZone }) => {
  cadenceOf(cadence); timestamp(anchorAt); timestamp(after);
  const format = formatter(timeZone);
  const elapsed = { every_30_minutes: 1_800_000, hourly: 3_600_000, every_3_hours: 10_800_000,
    every_6_hours: 21_600_000, every_12_hours: 43_200_000 }[cadence];
  if (elapsed) return timestamp(anchorAt + Math.max(1, Math.floor((after-anchorAt)/elapsed)+1) * elapsed);
  const anchor = parts(format, anchorAt), current = parts(format, after), ms = anchorAt % 1000;
  let step = cadence === 'monthly' ? Math.max(1, (current.year-anchor.year)*12 + current.month-anchor.month)
    : Math.max(1, Math.floor((Date.UTC(current.year,current.month-1,current.day)-Date.UTC(anchor.year,anchor.month-1,anchor.day))
      / (86_400_000 * ({ daily: 1, weekly: 7, fortnightly: 14 }[cadence]))));
  // At most three candidates are needed around the calendar estimate, even
  // after years offline. Jan 31 -> Feb 28 -> Mar 31 preserves the original day.
  for (let attempt = 0; attempt < 3; attempt++, step++) {
    let target;
    if (cadence === 'monthly') {
      const month = new Date(Date.UTC(anchor.year, anchor.month-1+step, 1));
      const year = month.getUTCFullYear(), m = month.getUTCMonth();
      target = { ...anchor, year, month: m+1, day: Math.min(anchor.day, new Date(Date.UTC(year,m+1,0)).getUTCDate()) };
    } else {
      target = localFromEpoch(localEpoch(anchor) + step * ({ daily: 1, weekly: 7, fortnightly: 14 }[cadence]) * 86_400_000);
    }
    const result = fromLocal(format, target, ms);
    if (result > after) return timestamp(result);
  }
  fail('ASSISTANT_SCHEDULE_TIMEZONE_UNAVAILABLE');
};

const keyOf = input => {
  closed(input, ['origin','assistantId','companyId','taskId']);
  let origin;
  try { origin = new URL(input.origin); } catch { invalid(); }
  if (origin.protocol !== 'https:' || origin.origin !== input.origin || origin.username || origin.password) invalid();
  const scope = { origin: origin.origin, assistantId: id(input.assistantId), companyId: id(input.companyId), taskId: id(input.taskId) };
  return { key: createHash('sha256').update(JSON.stringify(scope)).digest('hex'), scope };
};

/** Private DB lifecycle is owned by the host. No model-visible arbitrary SQL,
 * filenames, provider payloads or claimed RRULE/native automation is accepted.
 * Completion is a synchronous callback inside the inbox's existing transaction:
 * event processing and next-run advancement therefore cannot split on a crash. */
export const createAssistantScheduler = ({ database: db, now = Date.now }) => {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function' || typeof now !== 'function') invalid();
  const get = (query, ...values) => db.prepare(query).get(...values);
  const run = (query, ...values) => db.prepare(query).run(...values);
  const all = (query, ...values) => db.prepare(query).all(...values);
  const transact = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  db.exec('CREATE TABLE IF NOT EXISTS assistant_schedule_meta(version INTEGER NOT NULL)');
  transact(() => {
    const versions = all('SELECT version FROM assistant_schedule_meta');
    if (versions.length && (versions.length !== 1 || versions[0].version !== 1)) fail('ASSISTANT_SCHEDULE_UNSUPPORTED_SCHEMA');
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_schedule_tasks (
      task_key TEXT PRIMARY KEY, scope_json TEXT NOT NULL, source_json TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE, cadence TEXT NOT NULL, time_zone TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','paused','done','revoked')),
      revision INTEGER NOT NULL DEFAULT 0, anchor_at INTEGER NOT NULL, next_run_at INTEGER NOT NULL,
      report_sequence INTEGER NOT NULL DEFAULT 0,
      last_completed_at INTEGER, last_cycle_at INTEGER, last_delivery_id TEXT, last_receipt TEXT
    )`);
    if (!versions.length) run('INSERT INTO assistant_schedule_meta VALUES(1)');
  });
  const rowOf = input => {
    const { key } = keyOf(input), row = get('SELECT * FROM assistant_schedule_tasks WHERE task_key=?', key);
    if (!row) fail('ASSISTANT_SCHEDULE_TASK_REQUIRED');
    return row;
  };
  const output = row => row ? { ...JSON.parse(row.scope_json), source: JSON.parse(row.source_json), threadId: row.thread_id,
    cadence: row.cadence, timeZone: row.time_zone, state: row.state, revision: row.revision, reportSequence: row.report_sequence,
    nextRunAt: row.state === 'active' ? row.next_run_at : null, lastCompletedAt: row.last_completed_at,
    lastCycleAt: row.last_cycle_at } : null;
  return {
    register({ scope, source, threadId, cadence, timeZone }) {
      const { key, scope: exact } = keyOf(scope); threadId = id(threadId); cadenceOf(cadence); formatter(timeZone);
      closed(source, ['origin','assistantId','companyId','provider','accountId','bindingId']);
      const sourceScope = keyOf({ origin: source.origin, assistantId: source.assistantId, companyId: source.companyId, taskId: exact.taskId }).scope;
      if (JSON.stringify(sourceScope) !== JSON.stringify(exact) || !['trelio','telegram','email','max'].includes(source.provider)) invalid();
      source = { origin: sourceScope.origin, assistantId: sourceScope.assistantId, companyId: sourceScope.companyId,
        provider: source.provider, accountId: id(source.accountId), bindingId: id(source.bindingId) };
      return transact(() => {
        const previous = get('SELECT * FROM assistant_schedule_tasks WHERE task_key=?', key);
        if (previous) {
          if (previous.thread_id !== threadId || previous.source_json !== JSON.stringify(source)) fail('ASSISTANT_SCHEDULE_CONFLICT');
          return output(previous);
        }
        if (get('SELECT count(*) AS total FROM assistant_schedule_tasks').total >= 10_000) fail('ASSISTANT_SCHEDULE_FULL');
        if (get('SELECT 1 FROM assistant_schedule_tasks WHERE thread_id=?', threadId)) fail('ASSISTANT_SCHEDULE_CONFLICT');
        const at = timestamp(now());
        run('INSERT INTO assistant_schedule_tasks(task_key,scope_json,source_json,thread_id,cadence,time_zone,state,anchor_at,next_run_at) VALUES(?,?,?,?,?,?,\'active\',?,?)',
          key, JSON.stringify(exact), JSON.stringify(source), threadId, cadence, timeZone, at,
          nextAssistantRun({ cadence, anchorAt: at, after: at, timeZone }));
        return output(rowOf(exact));
      });
    },
    get(scope) { return output(rowOf(scope)); },
    list() { return all('SELECT * FROM assistant_schedule_tasks ORDER BY task_key LIMIT 10000').map(output); },
    /** Device/member rebinding preserves the permanent chat. Only the trusted
     * coordinator calls this after fresh server approval for the new exact
     * source; an incoming message cannot move a task across company/account. */
    rebindSource(scope, { source, expectedRevision }) {
      const exact = keyOf(scope).scope;
      closed(source, ['origin','assistantId','companyId','provider','accountId','bindingId']);
      if (source.origin !== exact.origin || id(source.assistantId) !== exact.assistantId || id(source.companyId) !== exact.companyId
        || source.provider !== 'trelio' || !Number.isSafeInteger(expectedRevision)) invalid();
      const value = { origin: exact.origin, assistantId: exact.assistantId, companyId: exact.companyId,
        provider: source.provider, accountId: id(source.accountId), bindingId: id(source.bindingId) };
      return transact(() => {
        const row = rowOf(exact);
        if (row.revision !== expectedRevision) fail('ASSISTANT_SCHEDULE_CONFLICT');
          if (row.source_json !== JSON.stringify(value)) run('UPDATE assistant_schedule_tasks SET source_json=?,revision=revision+1,report_sequence=report_sequence+1 WHERE task_key=?',
          JSON.stringify(value), row.task_key);
        return output(rowOf(exact));
      });
    },
    nextDue(excludeCompanyIds = []) {
      if (!Array.isArray(excludeCompanyIds) || excludeCompanyIds.length > 256) invalid();
      const excluded = [...new Set(excludeCompanyIds.map(id))];
      // Keep due timestamps/cycles intact while other companies continue.
      const exclusion = excluded.length ? ` AND json_extract(scope_json,'$.companyId') NOT IN (${excluded.map(()=>'?').join(',')})` : '';
      return output(get(`SELECT * FROM assistant_schedule_tasks WHERE state='active' AND next_run_at<=?${exclusion} ORDER BY next_run_at,task_key LIMIT 1`, timestamp(now()),...excluded));
    },
    setState(scope, { state, expectedRevision }) {
      if (!['active','paused','done','revoked'].includes(state) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid();
      return transact(() => {
        const row = rowOf(scope);
        if (row.revision !== expectedRevision) fail('ASSISTANT_SCHEDULE_CONFLICT');
        if (row.state !== state) run('UPDATE assistant_schedule_tasks SET state=?,revision=revision+1,report_sequence=report_sequence+1 WHERE task_key=?', state, row.task_key);
        return output(rowOf(scope));
      });
    },
    setCadence(scope, { cadence, timeZone, expectedRevision }) {
      cadenceOf(cadence); formatter(timeZone);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid();
      return transact(() => {
        const row = rowOf(scope);
        if (row.revision !== expectedRevision || row.state !== 'active') fail('ASSISTANT_SCHEDULE_CONFLICT');
        if (row.cadence === cadence && row.time_zone === timeZone) return output(row);
        const at = timestamp(now());
        run('UPDATE assistant_schedule_tasks SET cadence=?,time_zone=?,anchor_at=?,next_run_at=?,revision=revision+1,report_sequence=report_sequence+1 WHERE task_key=?',
          cadence, timeZone, at, nextAssistantRun({ cadence, anchorAt: at, after: at, timeZone }), row.task_key);
        return output(rowOf(scope));
      });
    },
    touchAuthority(scope, expectedRevision) {
      return transact(() => {
        const row=rowOf(scope);
        if(row.revision!==expectedRevision) fail('ASSISTANT_SCHEDULE_CONFLICT');
        run('UPDATE assistant_schedule_tasks SET revision=revision+1,report_sequence=report_sequence+1 WHERE task_key=?',row.task_key);
        return output(rowOf(scope));
      });
    },
    /** Used only by createAssistantInbox.onDeliveryCompleted, not directly by a
     * model or after the inbox COMMIT. No network/native work happens here. */
    completeInsideInboxTransaction({ scope: source, taskId, deliveryId, receipt, completedAt, scheduled, completion = null }) {
      const row = rowOf({ origin: source.origin, assistantId: source.assistantId, companyId: source.companyId, taskId });
      id(deliveryId); timestamp(completedAt);
      if (typeof scheduled !== 'boolean') invalid();
      if (typeof receipt !== 'string' || !receipt.length || receipt.length > 256 || /[\x00-\x20\x7f]/u.test(receipt)) invalid();
      if (row.last_delivery_id === deliveryId) {
        if (row.last_receipt !== receipt) fail('ASSISTANT_SCHEDULE_CONFLICT');
        return;
      }
      let cadence=row.cadence,timeZone=row.time_zone,state=row.state,anchor=row.anchor_at;
      if(completion!==null) {
        closed(completion,['continuation','bindingState']);
        if(Object.keys(completion).length!==2 || !['accepted','done'].includes(completion.bindingState)) invalid();
        const continuation=assistantPassContinuation(completion.continuation);
        cadence=continuation.cadence;timeZone=continuation.timeZone;
        state=completion.bindingState==='done' || ['completed','cancelled'].includes(continuation.goalState)?'done':'active';
        if(cadence!==row.cadence || timeZone!==row.time_zone) anchor=completedAt;
      }
      const next = state === 'active' ? nextAssistantRun({ cadence, anchorAt: anchor, after: completedAt, timeZone }) : row.next_run_at;
      const configurationChanged=Number(cadence!==row.cadence || timeZone!==row.time_zone || state!==row.state);
      run('UPDATE assistant_schedule_tasks SET cadence=?,time_zone=?,state=?,anchor_at=?,next_run_at=?,last_completed_at=?,last_cycle_at=?,last_delivery_id=?,last_receipt=?,revision=revision+?,report_sequence=report_sequence+1 WHERE task_key=?',
        cadence,timeZone,state,anchor,next,completedAt,scheduled && completedAt >= row.next_run_at ? completedAt : row.last_cycle_at,deliveryId,receipt,configurationChanged,row.task_key);
    },
  };
};
