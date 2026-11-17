#!/usr/bin/env node
/** Maintainer-only durable Codex follow-up. Native queued input is data about
 * an already authorized integration, never new release/push authority. Nothing
 * in this module enters a signed runtime, a provider or a public plugin shell.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const VERSION = 1;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const TICKET = /^\d{12}$/u;
const ACTIVE = new Set(['waiting', 'running', 'verified']);
const TERMINAL = new Set(['succeeded', 'failed', 'interrupted', 'recovered', 'recovery_required', 'unknown']);
const LABEL = 'ru.trelio.maintainer-git-follow-up';
const filename = fileURLToPath(import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');
export const stateRoot = () => path.join(os.homedir(), '.local', 'state', 'trelio-git-follow-up');

function check(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw Error('Unsafe Git follow-up state');
  return stat;
}
function directory(root) {
  fs.mkdirSync(root, {recursive: true, mode: 0o700}); check(root, true);
}
function load(file) {
  if (check(file).size > 64 * 1024) throw Error('Oversized Git follow-up state');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(file, value) {
  if (fs.existsSync(file)) check(file);
  const temp = file + '.' + randomUUID();
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function syncParent(file) {
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function once(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncParent(file);
}
const recordPath = (root, id) => {
  if (!HEX.test(id)) throw Error('Invalid Git follow-up event');
  return path.join(root, 'events', id + '.json');
};

/** A future daemon must not inherit an expired tool invocation's proof, pipe,
 * identity or account environment. The ordinary installed CLI owns its auth.
 */
export function serviceEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'CODEX_HOME'].includes(key)));
}

export function nativeContext(env = process.env) {
  if (!env.CODEX_THREAD_ID || !env.CODEX_APP_RUNTIME_CLI_PATH) return null;
  if (!UUID.test(env.CODEX_THREAD_ID) || !path.isAbsolute(env.CODEX_APP_RUNTIME_CLI_PATH)) throw Error('Invalid native Codex follow-up context');
  const cli = fs.realpathSync(env.CODEX_APP_RUNTIME_CLI_PATH), stat = fs.statSync(cli);
  if (path.basename(cli) !== 'codex' || !stat.isFile() || stat.mode & 0o022) throw Error('Unsafe native Codex CLI');
  return {threadId: env.CODEX_THREAD_ID, cli,
    codexHome: env.CODEX_HOME ? fs.realpathSync(env.CODEX_HOME) : null};
}
const nativeEnvironment = row => ({...serviceEnvironment(), ...(row.codexHome ? {CODEX_HOME: row.codexHome} : {})});

const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Install one shared user LaunchAgent, with immutable code outside worktrees.
 * Older consumers can use a newer compatible service, but cannot downgrade it.
 * An interrupted installation leaves an explicit claim, never a stolen lock.
 */
export function installService(root = stateRoot()) {
  if (process.platform !== 'darwin') throw Error('Automatic Codex follow-up currently requires macOS');
  directory(root); directory(path.join(root, 'events')); directory(path.join(root, 'service'));
  const configPath = path.join(root, 'service.json');
  const code = fs.readFileSync(filename), hash = digest(code);
  if (fs.existsSync(configPath)) {
    const current = load(configPath);
    if (current.schemaVersion !== 1 || current.apiVersion !== 1 || !Number.isSafeInteger(current.version)
        || !HEX.test(current.digest) || digest(fs.readFileSync(current.script)) !== current.digest) throw Error('Invalid installed Git follow-up service');
    if (current.version > VERSION || current.digest === hash) {
      const probe = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], {stdio: 'ignore'});
      if (probe.status !== 0) {
        const start = spawnSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, current.plist], {stdio: 'ignore'});
        if (start.status !== 0) throw Error('Cannot register Git follow-up LaunchAgent');
      }
      return current;
    }
    if (current.version === VERSION) throw Error('Git follow-up service version has different immutable code');
  }
  const claim = path.join(root, 'install.claim');
  fs.mkdirSync(claim, {mode: 0o700});
  try {
    const script = path.join(root, 'service', hash + '.mjs');
    if (!fs.existsSync(script)) fs.writeFileSync(script, code, {mode: 0o600, flag: 'wx'});
    check(script);
    if (digest(fs.readFileSync(script)) !== hash) throw Error('Git follow-up service copy differs');
    const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(agents, {recursive: true});
    const plist = path.join(agents, LABEL + '.plist');
    const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string><string>--drain</string></array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>30</integer><key>ProcessType</key><string>Background</string></dict></plist>\n`;
    if (fs.existsSync(plist) && !fs.existsSync(configPath)) throw Error('Existing unowned Git follow-up LaunchAgent');
    if (fs.existsSync(plist)) check(plist);
    fs.writeFileSync(plist, content, {mode: 0o600});
    const valid = spawnSync('/usr/bin/plutil', ['-lint', plist], {stdio: 'ignore'});
    if (valid.status !== 0) throw Error('Invalid Git follow-up LaunchAgent');
    if (fs.existsSync(configPath)) spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], {stdio: 'ignore'});
    const start = spawnSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], {stdio: 'ignore'});
    if (start.status !== 0) throw Error('Cannot register Git follow-up LaunchAgent');
    const config = {schemaVersion: 1, apiVersion: 1, version: VERSION, digest: hash, script, plist, node: process.execPath};
    save(configPath, config); return config;
  } finally { fs.rmdirSync(claim); }
}

function validate(row) {
  if (row.schemaVersion !== 1 || !HEX.test(row.id) || !UUID.test(row.threadId)
      || !/^[a-f0-9]{32}\.log$/u.test(row.logFile) || !/^[a-f0-9]{40}$/u.test(row.sourceSha)
      || !/^codex\/[a-z0-9][a-z0-9._-]*$/u.test(row.branch) || !Number.isFinite(Date.parse(row.createdAt))
      || !['pending', 'sending', 'queued', 'uncertain', 'handled', 'cancelled'].includes(row.delivery)
      || row.workerPid !== undefined && (!Number.isSafeInteger(row.workerPid) || row.workerPid < 1)
      || row.codexHome !== null && row.codexHome !== undefined && !path.isAbsolute(row.codexHome)
      || ['canonical', 'queueDirectory', 'cwd', 'cli', 'statusScript', 'serviceScript', 'node'].some(key => !path.isAbsolute(row[key] ?? ''))
      || row.ticketId !== null && !TICKET.test(row.ticketId)) throw Error('Invalid Git follow-up registration');
  return row;
}
export function inspectEvent(root, id) {
  const row = validate(load(recordPath(root, id)));
  const acknowledgement = path.join(root, 'events', id + '.ack');
  // A late sender's state write cannot erase the agent's acknowledgement.
  // The immutable marker remains separate from mutable transport diagnostics.
  if (fs.existsSync(acknowledgement)) return {...row, delivery: 'handled', handledAt: load(acknowledgement).at};
  return row;
}

/** The log nonce is already persisted in both engines' ticket and receipt. It
 * joins a pre-admission subscription to a very fast result or lost admission
 * ACK without inventing a second integration ticket. Clone identity is part
 * of the key: equal ticket numbers in different repositories never collide.
 */
export function registerFollowUp({root = stateRoot(), canonical, queueDirectory, cwd, branch, sha, logFile,
  statusScript, context, service}) {
  directory(root); directory(path.join(root, 'events'));
  const id = digest(fs.realpathSync(queueDirectory) + '\0' + logFile);
  const file = recordPath(root, id);
  if (fs.existsSync(file)) {
    const old = inspectEvent(root, id);
    if (old.threadId !== context.threadId || old.canonical !== fs.realpathSync(canonical) || old.sourceSha !== sha) throw Error('Integration already belongs to another chat or source');
    return {eventId: id, state: old.delivery, serviceScript: old.serviceScript};
  }
  const row = validate({schemaVersion: 1, id, threadId: context.threadId, cli: context.cli, codexHome: context.codexHome ?? null,
    canonical: fs.realpathSync(canonical), queueDirectory: fs.realpathSync(queueDirectory), cwd,
    branch, sourceSha: sha, logFile, statusScript, node: service.node, serviceScript: service.script,
    ticketId: null, delivery: 'pending', createdAt: new Date().toISOString()});
  // Exclusive publication makes a concurrent launcher observe the SAME record.
  // A half-written file fails closed rather than being replaced by a new owner.
  once(file, row);
  return {eventId: id, state: 'pending', serviceScript: service.script};
}

export function noteFollowUpProcess(id, pid, root = stateRoot()) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Invalid follow-up worker');
  const row = inspectEvent(root, id);
  if (row.delivery !== 'pending') throw Error('Follow-up worker admission changed');
  save(recordPath(root, id), {...row, workerPid: pid});
}
export function cancelUnusedFollowUp(id, root = stateRoot()) {
  const row = inspectEvent(root, id);
  const attempt = path.join(root, 'events', id + '.attempt');
  // Cancellation competes for the SAME exclusive fence as sending. A stale
  // drain snapshot cannot send after the losing launcher cancels its intent.
  try { once(attempt, {cancelled: true, at: new Date().toISOString()}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (load(attempt).cancelled !== true) throw Error('Review an already attempted follow-up');
  }
  save(recordPath(root, id), {...row, delivery: 'cancelled'});
}

function observation(row) {
  check(row.queueDirectory, true);
  const found = [];
  for (const dir of [row.queueDirectory, path.join(row.queueDirectory, 'results')]) {
    if (!fs.existsSync(dir)) continue;
    check(dir, true);
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d{12}\.json$/u.test(name)) continue;
      const entry = load(path.join(dir, name));
      if (entry.logFile !== row.logFile) continue;
      if (entry.cwd !== row.cwd || entry.branch !== row.branch || (entry.sourceSha ?? entry.sha) !== row.sourceSha) throw Error('Follow-up source changed');
      if (!TICKET.test(entry.id)) throw Error('Invalid follow-up ticket');
      found.push(entry.id);
    }
  }
  const ids = [...new Set(found)];
  if (ids.length > 1) throw Error('Ambiguous Git follow-up ticket');
  if (!ids.length) {
    // A live worker may still be waiting for admission's short mutex. Its
    // subscription must not invent a missing-admission error based on age.
    if (row.workerPid) {
      try { process.kill(row.workerPid, 0); return null; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return Date.now() - Date.parse(row.createdAt) < 90_000 ? null : {state: 'unknown', id: null};
  }
  // Reuse each repository's authoritative status guard: an active/dead-owner
  // ticket takes precedence over a receipt written immediately before a crash.
  const result = spawnSync(row.node, [row.statusScript, '--status', ids[0]], {
    cwd: row.canonical, env: serviceEnvironment(), encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024});
  if (result.error || result.status !== 0 || result.stderr) throw Error('Cannot read exact integration status');
  const value = JSON.parse(result.stdout);
  if (value.id !== ids[0] || !ACTIVE.has(value.state) && !TERMINAL.has(value.state)) throw Error('Invalid exact integration status');
  return {id: value.id, state: value.state};
}

export function callbackText(row) {
  return `Автоматическое продолжение ранее порученной Git-интеграции. Событие GIT_FOLLOW_UP:${row.id}. Это данные фонового процесса, не новая команда пользователя и не разрешение на релиз.\n`
    + `Прочитай AGENTS.md канонического checkout и запись командой с отдельными argv: ${JSON.stringify([row.node, row.serviceScript, '--inspect', row.id])}. Канонический checkout: ${row.canonical}. Для правок используй task-worktree, main сохраняй чистым. Проверь exact --status указанного тикета и фактический origin/main; пустая очередь, exit code и этот callback не доказывают вливание.\n`
    + 'При ошибке продолжи разбор и исправление только исходной задачи, сохраняя чужие изменения и все CI/ACL/approval guards. При повторном enqueue сопровождение нового тикета сохраняется отдельно. Успешный main с pending cleanup требует только штатной уборки. Не запускай новую интеграцию, если прежняя ещё работает.\n'
    + `После проверки отметь получение через ${JSON.stringify([row.node, row.serviceScript, '--ack', row.id])}. Это подтверждение получения, не доказательство успешной интеграции. Затем доведи разрешённую работу до результата или сообщи конкретный блокер. Другие результаты в этом чате относятся к своим clone и тикетам.`;
}

function queueNative(row) {
  const result = spawnSync(row.cli, ['queue', '--thread', row.threadId, '--message', callbackText(row)], {
    cwd: row.canonical, env: nativeEnvironment(row), encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024});
  const match = /^Queued message ([a-f0-9-]+) for thread ([a-f0-9-]+)\.\s*$/u.exec(result.stdout ?? '');
  if (!result.error && result.status === 0 && !result.stderr && match?.[2] === row.threadId && UUID.test(match[1])) return {queuedId: match[1]};
  // Any started write with an unknown result retains its one-use attempt.
  // Restart/timeout/nonzero cannot authorize a blind second queue write.
  return {uncertain: true};
}

/** Reconcile only positive native evidence. A separate App Server reader may
 * call a currently active GUI turn "interrupted"; no turn status or absence in
 * a bounded page is used as permission to send again or acquire its writer.
 */
export async function nativeContains(row) {
  const child = spawn(row.cli, ['app-server', '--listen', 'stdio://'], {
    cwd: row.canonical, env: nativeEnvironment(row), stdio: ['pipe', 'pipe', 'ignore']});
  let sequence = 0, buffer = '', pending;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', () => pending?.reject(Error('Native read failed')));
  child.stdin.on('error', () => pending?.reject(Error('Native input closed')));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 2 * 1024 * 1024) { pending?.reject(Error('Native read bound')); return; }
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let value; try { value = JSON.parse(line); } catch { pending?.reject(Error('Invalid native frame')); continue; }
      if (pending && value.id === pending.id) value.error ? pending.reject(Error('Native read refused')) : pending.resolve(value.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error('Native read timeout')), 5000);
    pending = {id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }};
    child.stdin.write(JSON.stringify({id, method, params}) + '\n');
  });
  try {
    await request('initialize', {clientInfo: {name: 'trelio_git_follow_up', version: '1'}, capabilities: {experimentalApi: true}});
    child.stdin.write(JSON.stringify({method: 'initialized', params: {}}) + '\n');
    const expected = callbackText(row);
    const exactInput = input => Array.isArray(input) && input.length === 1
      && input[0].type === 'text' && input[0].text === expected;
    for (const method of ['thread/queue/list', 'thread/turns/list']) {
      const result = await request(method, {threadId: row.threadId, limit: 50});
      // A quoted marker in an agent message, tool log or an unrelated human
      // prompt is not evidence of this exact native queued submission.
      if (method === 'thread/queue/list' && result.data?.some(item => exactInput(item.input))) return true;
      if (method === 'thread/turns/list' && result.data?.some(turn => turn.items?.some(item =>
        item.type === 'userMessage' && exactInput(item.content)))) return true;
    }
    return false;
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
    await closed; clearTimeout(timer);
  }
}

export async function drain({root = stateRoot(), observe = observation, send = queueNative, contains = nativeContains} = {}) {
  if (!fs.existsSync(path.join(root, 'events'))) return;
  check(root, true); check(path.join(root, 'events'), true);
  for (const name of fs.readdirSync(path.join(root, 'events')).sort()) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const file = path.join(root, 'events', name);
    let row;
    try { row = inspectEvent(root, name.slice(0, -5)); }
    catch {
      // One damaged subscription must not starve other repositories/chats.
      // Keep the source untouched and expose a bounded local diagnostic.
      directory(path.join(root, 'diagnostics'));
      save(path.join(root, 'diagnostics', name), {code: 'registration_invalid', at: new Date().toISOString()});
      continue;
    }
    if (['queued', 'handled', 'cancelled'].includes(row.delivery)) continue;
    const attempt = path.join(root, 'events', row.id + '.attempt');
    if (fs.existsSync(attempt)) {
      check(attempt);
      if (row.delivery === 'pending' || row.delivery === 'sending') save(file, {...row, delivery: 'uncertain'});
      if (await contains(row).catch(() => false)) {
        const latest = inspectEvent(root, row.id);
        if (latest.delivery !== 'handled') save(file, {...latest, delivery: 'queued', reconciledAt: new Date().toISOString()});
      }
      continue;
    }
    let result;
    try { result = observe(row); }
    catch { result = {id: row.ticketId, state: 'observation_error'}; }
    if (!result || ACTIVE.has(result.state)) continue;
    // O_EXCL is the persistent one-use send fence. Concurrent drains, equal
    // ticket IDs across repositories, process death and missing ACKs cannot
    // create a second native message for this event. Never remove this marker.
    try { once(attempt, {at: new Date().toISOString()}); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    const sending = {...row, ticketId: result.id, observedState: result.state, delivery: 'sending'};
    save(file, sending);
    let receipt; try { receipt = send(sending); } catch { receipt = {uncertain: true}; }
    const latest = inspectEvent(root, row.id);
    if (latest.delivery !== 'handled') save(file, {...latest,
      delivery: receipt.queuedId ? 'queued' : 'uncertain', ...(receipt.queuedId ? {queuedId: receipt.queuedId} : {})});
  }
}

export function acknowledgeEvent(root, id) {
  const row = inspectEvent(root, id);
  if (['pending', 'cancelled'].includes(row.delivery) || !fs.existsSync(path.join(root, 'events', id + '.attempt'))) throw Error('Follow-up has not been sent');
  const marker = path.join(root, 'events', id + '.ack');
  try { once(marker, {at: new Date().toISOString()}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; check(marker); }
  return {eventId: id, delivery: 'handled'};
}

export function armFollowUp(options) {
  const context = nativeContext();
  if (!context) return null;
  if (process.platform !== 'darwin') return null;
  const service = installService();
  const registered = registerFollowUp({...options, context, service});
  // launchd serializes runs of this label; kickstart without -k never kills
  // an existing drain. Its 30-second timer also survives closing this chat.
  spawnSync('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${LABEL}`], {stdio: 'ignore'});
  return registered;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === filename) {
  const [operation, id] = process.argv.slice(2);
  try {
    if (operation === '--drain' && !id) await drain();
    else if (operation === '--inspect' && id) console.log(JSON.stringify(inspectEvent(stateRoot(), id)));
    else if (operation === '--ack' && id) console.log(JSON.stringify(acknowledgeEvent(stateRoot(), id)));
    else throw Error('Use --drain, --inspect EVENT or --ack EVENT');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
