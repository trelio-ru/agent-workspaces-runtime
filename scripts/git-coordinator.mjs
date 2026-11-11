#!/usr/bin/env node
/** Maintainer infrastructure, deliberately outside host-runtime and plugin payloads.
 * One implementation is consumed as an exact Git-pinned development dependency.
 * The lease covers preparation, version reservation, CI and publication, rather
 * than just the short Git transport. It coordinates linked worktrees of a clone;
 * remote fast-forward/tag checks still fence writers from other clones.
 */
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {acknowledgeAdmission, integrationLaunchResult, launchBackground, waitForIntegration} from './git-background.mjs';

const SHA = /^[a-f0-9]{40}$/u;
const ID = /^\d{12}$/u;
const startHost = os.hostname();
const localName = process.platform === 'darwin'
  ? spawnSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], {encoding: 'utf8', timeout: 1000}) : null;
const stableHost = localName?.status === 0 && !localName.stderr
  && /^[A-Za-z0-9-]+\n?$/u.test(localName.stdout) ? localName.stdout.replace(/\n$/u, '') + '.local' : null;
const local = entry => entry.host === startHost || stableHost && entry.stableHost === stableHost;

export function read(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000});
  if (result.error || result.status !== 0 || result.stderr) throw Error(`Incomplete ${command} metadata: ${args[0]}`);
  // Remove only Git/CLI's terminator: whitespace can belong to a legal path.
  return result.stdout.replace(/\n$/u, '');
}
const git = (cwd, ...args) => read('git', args, cwd);
const common = cwd => fs.realpathSync(path.resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir')));
const root = cwd => path.join(common(cwd), 'trelio-git-coordination');

function privatePath(filename, directory = false) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw Error('Unsafe coordination state');
}
function save(filename, value) {
  if (fs.existsSync(filename)) privatePath(filename);
  const temp = `${filename}.${randomUUID()}`;
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(temp, filename);
}
function inventory() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], {encoding: 'utf8'});
  if (result.error || result.status !== 0 || result.stderr) throw Error('Incomplete process inventory');
  return result.stdout.replace(/\n$/u, '').split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) throw Error('Incomplete process inventory');
    return {pid: +match[1], ppid: +match[2], pgid: +match[3], live: !match[4].startsWith('Z')};
  }).filter(row => row.pid !== result.pid);
}

function descendant(pid, owner, rows = inventory()) {
  const parents = new Map(rows.map(row => [row.pid, row.ppid])), seen = new Set();
  while (pid > 0 && !seen.has(pid)) {
    if (pid === owner) return true;
    seen.add(pid); pid = parents.get(pid) ?? 0;
  }
  return false;
}
export function policy(cwd) {
  const value = JSON.parse(fs.readFileSync(path.join(cwd, 'git-coordination.json'), 'utf8'));
  if (value.schemaVersion !== 1 || !/^[\w.-]+\/[\w.-]+$/u.test(value.repository ?? '')
    || !/^[\w.-]+$/u.test(value.mainMutex ?? '') || typeof value.canonicalKey !== 'string'
    || !Array.isArray(value.verify) || !value.verify.length || value.verify.some(item => typeof item !== 'string')
    || (value.verifyLocal !== undefined && (!Array.isArray(value.verifyLocal) || !value.verifyLocal.length
      || value.verifyLocal.some(item => typeof item !== 'string')))
    || !Array.isArray(value.transport) || !value.transport.length || value.transport.some(item => typeof item !== 'string')) {
    throw Error('Invalid repository coordination policy');
  }
  return value;
}
export function queue(cwd, attempt = 0) {
  if (!fs.existsSync(root(cwd))) return [];
  privatePath(root(cwd), true);
  try { return fs.readdirSync(root(cwd)).filter(name => ID.test(name.slice(0, -5)) && name.endsWith('.json')).sort().map(name => {
    const filename = path.join(root(cwd), name); privatePath(filename);
    const row = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (row.schemaVersion !== 1 || row.id + '.json' !== name || !Number.isSafeInteger(row.pid) || row.pid < 1
      || row.pgid !== row.pid || typeof row.host !== 'string' || typeof row.cwd !== 'string'
      || !/^codex\/[a-z0-9][a-z0-9._-]*$/u.test(row.branch ?? '') || !SHA.test(row.sha ?? '')
      || !['waiting', 'running', 'verified'].includes(row.state) || typeof row.tag !== 'string') throw Error('Invalid coordination ticket');
    return row;
  }); } catch (error) {
    // A predecessor may finish between readdir and read. Retry the inventory,
    // never interpret disappearing/malformed state as an empty queue.
    if (error.code === 'ENOENT' && attempt < 3) return queue(cwd, attempt + 1);
    throw error;
  }
}

function resultPath(cwd, id, create = false) {
  if (!ID.test(id)) throw Error('Status requires one exact ticket');
  if (!fs.existsSync(root(cwd))) return path.join(root(cwd), 'results', id + '.json');
  privatePath(root(cwd), true);
  const directory = path.join(root(cwd), 'results');
  if (create && !fs.existsSync(directory)) fs.mkdirSync(directory, {mode: 0o700});
  if (fs.existsSync(directory)) privatePath(directory, true);
  return path.join(directory, id + '.json');
}
function result(cwd, id) {
  const filename = resultPath(cwd, id);
  if (!fs.existsSync(filename)) return null;
  privatePath(filename);
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (value.schemaVersion !== 1 || value.id !== id || !SHA.test(value.sha ?? '') || !SHA.test(value.sourceSha ?? '')
    || !['succeeded', 'failed', 'interrupted', 'recovered'].includes(value.state)
    || typeof value.cwd !== 'string' || typeof value.branch !== 'string' || typeof value.tag !== 'string'
    || !Number.isFinite(Date.parse(value.finishedAt))) throw Error('Invalid coordination result');
  return value;
}
function settle(cwd, entry, observation) {
  const filename = resultPath(cwd, entry.id, true);
  if (fs.existsSync(filename)) throw Error('Coordination result already exists; inspect before recovery');
  // Persist the outcome before releasing FIFO. A missing ticket, launcher exit
  // or lost IPC message never stands in for successful guarded read-back.
  save(filename, {...entry, ...observation, sourceSha: entry.sourceSha ?? entry.sha, finishedAt: new Date().toISOString()});
}
export function status(cwd, id) {
  if (!ID.test(id)) throw Error('Status requires one exact ticket');
  const rows = queue(cwd), index = rows.findIndex(row => row.id === id);
  let value;
  if (index >= 0) {
    const entry = rows[index];
    const live = local(entry) && inventory().some(row => row.pid === entry.pid && row.live);
    value = {...entry, state: live ? entry.state : 'recovery_required', position: index + 1};
  } else value = result(cwd, id) ?? {id, state: 'unknown'};
  if (value.logFile !== undefined) {
    if (!/^[a-f0-9]{32}\.log$/u.test(value.logFile)) throw Error('Invalid coordination log');
    value.logPath = path.join(root(cwd), 'logs', value.logFile);
  }
  return value;
}

/** This is the SAME mutex used by existing worktree/transport shell helpers.
 * Keep it short, owner-compatible and never steal an unknown or dead lock.
 * CI is protected by the durable FIFO ticket, so worktree creation stays usable.
 */
async function mutex(cwd, config, action, cancelled = () => false) {
  const directory = path.join(common(cwd), config.mainMutex), owner = path.join(directory, 'owner');
  const sameDirectory = (left, right) => left.dev === right.dev && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
  let unpublishedOwner;
  for (;;) {
    if (cancelled()) throw Error('Coordination interrupted');
    try { fs.mkdirSync(directory, {mode: 0o700}); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let observed;
      try { observed = fs.lstatSync(directory, {bigint: true}); }
      catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
      let value;
      try { value = fs.readFileSync(owner, 'utf8'); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      if (value) {
        unpublishedOwner = undefined;
        const pid = +(/^pid=(\d+)$/mu.exec(value)?.[1] ?? 0), host = /^host=(.+)$/mu.exec(value)?.[1];
        if (host !== startHost || !inventory().some(row => row.pid === pid && row.live)) {
          // A normal holder may remove its SAME mutex and exit between our
          // owner-file read and ps. Only a fresh no-follow absence/replacement
          // permits another acquisition attempt. Never remove/steal an
          // unchanged dead or unknown claim, infer age, or replay its action.
          // Birth identity also distinguishes promptly reused directory inodes.
          let current;
          try { current = fs.lstatSync(directory, {bigint: true}); }
          catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
          if (!sameDirectory(current, observed)) continue;
          throw Error('Inspect existing main mutex; owner is not confirmed live');
        }
      } else {
        // mkdir/write and unlink/rmdir have a normal short ownerless interval.
        // A preceding wait for a LIVE owner must not consume that allowance.
        // Bind it to this exact, freshly rechecked directory and reset it once
        // an owner is published; an unchanged empty claim still fails after
        // five seconds. Never remove a lock or borrow a dead/unknown owner's
        // authority merely because the queue has waited a long time.
        let current;
        try { current = fs.lstatSync(directory, {bigint: true}); }
        catch (failure) { if (failure.code === 'ENOENT') { unpublishedOwner = undefined; continue; } throw failure; }
        if (!sameDirectory(current, observed)) { unpublishedOwner = undefined; continue; }
        if (!unpublishedOwner || !sameDirectory(unpublishedOwner.directory, current)) {
          unpublishedOwner = {directory: current, since: Date.now()};
        } else if (Date.now() - unpublishedOwner.since > 5000) throw Error('Main mutex has no owner');
      }
      await delay(100);
    }
  }
  try {
    fs.writeFileSync(owner, `operation=FIFO coordination\npid=${process.pid}\nhost=${startHost}\n`, {mode: 0o600, flag: 'wx'});
    return await action();
  } finally { fs.unlinkSync(owner); fs.rmdirSync(directory); }
}
function candidate(cwd, entry) {
  const branch = git(cwd, 'symbolic-ref', '--short', 'HEAD'), sha = git(cwd, 'rev-parse', 'HEAD');
  if (!/^codex\/[a-z0-9][a-z0-9._-]*$/u.test(branch)
    || git(cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none')) throw Error('Use a clean committed codex/* worktree');
  for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']) {
    if (fs.existsSync(path.resolve(cwd, git(cwd, 'rev-parse', '--git-path', marker)))) throw Error('Unfinished Git operation');
  }
  if (entry && (entry.branch !== branch || entry.sha !== sha)) throw Error('Queued source changed; prepare and enqueue again');
  return {branch, sha};
}
function owned(cwd, entry) {
  const first = queue(cwd)[0];
  if (first?.id !== entry.id || first.pid !== process.pid || !local(first)) throw Error('FIFO ownership changed');
  return first;
}
export function assertPush(cwd, sha, tag = '') {
  const entry = queue(cwd)[0];
  if (!SHA.test(sha) || !entry || !local(entry) || entry.state !== 'verified' || entry.cwd !== fs.realpathSync(cwd)
    || entry.sha !== sha || entry.tag !== tag || !descendant(process.pid, entry.pid)) {
    throw Error('Protected push requires the verified live FIFO owner; use git:integrate');
  }
  candidate(cwd, entry);
  if (!tag && policy(cwd).verifyLocal && entry.localCheckBase !== git(cwd, 'rev-parse', 'refs/remotes/origin/main')) {
    throw Error('Local checks must match the published base');
  }
}
export async function recover(cwd, id) {
  if (!ID.test(id)) throw Error('Recovery requires one exact ticket');
  return mutex(cwd, policy(cwd), () => {
    const entry = queue(cwd).find(row => row.id === id);
    // A killed launcher does not make its Git/npm grandchildren safe to ignore.
    // No age expiry, broad process termination, or lock deletion is permitted.
    if (!entry || !local(entry) || inventory().some(row => row.live && (row.pid === entry.pid || row.pgid === entry.pgid))) {
      throw Error('Cannot recover an unknown or live owner/process group');
    }
    if (!result(cwd, id)) settle(cwd, entry, {state: 'recovered'});
    fs.unlinkSync(path.join(root(cwd), id + '.json'));
  });
}
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: 'inherit', shell: false,
      env: {...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`}});
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(Error(`${command} failed (${signal ?? code})`)));
  });
}

/** Enqueue before reading the final base or reserving a version. The verifier
 * belongs to the repository: runtime's exact native plan, plugin's OS matrix,
 * provider selection and product CI are never replaced by a generic green flag.
 */
export async function coordinate(cwd, tag = '', actions = {}) {
  const config = policy(cwd), initial = candidate(cwd);
  if (actions.expected) candidate(cwd, actions.expected);
  if (tag && !/^(?:v|skill-[a-z0-9-]+-v|codex-hooks-source-v)\d+\.\d+\.\d+$/u.test(tag)) throw Error('Invalid immutable release tag');
  const canonical = fs.realpathSync(git(cwd, 'config', '--get', config.canonicalKey));
  if (common(canonical) !== common(cwd) || git(canonical, 'branch', '--show-current') !== 'main'
    || git(canonical, 'status', '--porcelain=v1', '-z', '--untracked-files=all')) throw Error('Canonical main must be configured and clean');
  const processRow = inventory().find(row => row.pid === process.pid);
  if (processRow?.pgid !== process.pid) throw Error('Coordinator must own its isolated process group');
  let cancelled = false, entry, observation = {state: 'failed'};
  const stop = () => { if (!cancelled) { cancelled = true; process.kill(-process.pid, 'SIGTERM'); } };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const command = actions.run ?? run;
  try {
    entry = await mutex(cwd, config, () => {
      if (!fs.existsSync(root(cwd))) fs.mkdirSync(root(cwd), {mode: 0o700});
      privatePath(root(cwd), true);
      const counter = path.join(root(cwd), 'sequence');
      let next = 1;
      if (fs.existsSync(counter)) { privatePath(counter); next = JSON.parse(fs.readFileSync(counter, 'utf8')); }
      if (!Number.isSafeInteger(next) || next < 1 || next >= 1e12 || queue(cwd).some(row => +row.id >= next)) throw Error('Invalid FIFO sequence');
      const duplicate = queue(cwd).find(row => row.cwd === fs.realpathSync(cwd) || row.branch === initial.branch);
      if (duplicate) throw Object.assign(Error(`FIFO ${duplicate.id} already owns this task; inspect its status`), {code: 'INTEGRATION_ALREADY_QUEUED'});
      const row = {schemaVersion: 1, id: String(next).padStart(12, '0'), pid: process.pid, pgid: process.pid,
        host: startHost, stableHost, cwd: fs.realpathSync(cwd), ...initial, sourceSha: initial.sha, tag, state: 'waiting',
        createdAt: new Date().toISOString(), ...(actions.logFile ? {logFile: actions.logFile} : {})};
      save(counter, next + 1); save(path.join(root(cwd), row.id + '.json'), row); return row;
    }, () => cancelled);
    console.log(`FIFO ${entry.id}: ${entry.branch}${tag ? ' / ' + tag : ''}`);
    await acknowledgeAdmission({id: entry.id});
    for (;;) {
      if (cancelled) throw Error('Coordination interrupted');
      // Normal completion removes a ticket under this same short mutex before
      // its owner exits. Observe ticket and process together: a stale unlocked
      // ticket snapshot can otherwise outlive that successful predecessor and
      // falsely demand dead-owner recovery. A crashed owner retains its ticket
      // and is still refused; no age/takeover or unknown-child rule changes.
      const first = await mutex(cwd, config, () => {
        const first = queue(cwd)[0];
        if (!first || !local(first) || !inventory().some(row => row.pid === first.pid && row.live)) {
          throw Error('First FIFO owner is not live; inspect --status and --recover TICKET');
        }
        return first;
      }, () => cancelled);
      if (first.id === entry.id) break;
      await delay(250);
    }
    candidate(cwd, entry);
    entry.state = 'running'; save(path.join(root(cwd), entry.id + '.json'), entry);
    await command('git', ['fetch', '--prune', 'origin'], cwd);
    // Reserve the exact tag BEFORE CI. A stale proposed version fails here,
    // rather than spending another full gate and discovering the collision later.
    if (tag && git(cwd, 'ls-remote', '--refs', 'origin', `refs/tags/${tag}`)) throw Error('Release version already exists; choose a fresh version before CI');
    if (git(cwd, 'rev-list', '--merges', 'refs/remotes/origin/main..HEAD')) throw Error('Resolve merge history explicitly before integration');
    const remoteRef = `refs/heads/${entry.branch}`;
    const published = git(cwd, 'ls-remote', '--refs', 'origin', remoteRef);
    const remoteSha = published ? published.split('\t')[0] : '';
    if (published && (!SHA.test(remoteSha) || published !== `${remoteSha}\t${remoteRef}`)) throw Error('Incomplete task ref');
    if (remoteSha) git(cwd, 'merge-base', '--is-ancestor', remoteSha, initial.sha);
    await command('git', ['rebase', '--no-autostash', 'refs/remotes/origin/main'], cwd);
    entry.sha = git(cwd, 'rev-parse', 'HEAD'); save(path.join(root(cwd), entry.id + '.json'), entry);
    candidate(cwd, entry);
    if (!tag && entry.sha === git(cwd, 'rev-parse', 'refs/remotes/origin/main')) {
      await command('git', ['merge', '--ff-only', entry.sha], canonical);
      observation = {state: 'succeeded', outcome: 'already_integrated'}; return;
    }
    const base = git(cwd, 'rev-parse', 'refs/remotes/origin/main');
    if (!tag && config.verifyLocal) {
      // An ordinary runtime integration neither publishes a task branch nor
      // starts Actions. Only this live owner can advance its ticket to verified.
      await command(config.verifyLocal[0], [...config.verifyLocal.slice(1), base, entry.sha], cwd);
      if (git(cwd, 'rev-parse', 'refs/remotes/origin/main') !== base) throw Error('Local check base changed');
      entry.localCheckBase = base;
    } else {
      await command('git', ['push', `--force-with-lease=${remoteRef}:${remoteSha}`, 'origin', `HEAD:${remoteRef}`], cwd);
      await command(config.verify[0], [...config.verify.slice(1), '--prepare', entry.sha], cwd);
    }
    if (cancelled) throw Error('Coordination interrupted');
    candidate(cwd, entry); owned(cwd, entry);
    entry.state = 'verified'; save(path.join(root(cwd), entry.id + '.json'), entry);
    if (tag) {
      const localTag = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {cwd, encoding: 'utf8'});
      if (localTag.status === 0 && localTag.stdout.replace(/\n$/u, '') !== entry.sha) throw Error('Local release tag points to another commit; never move it automatically');
      if (localTag.status !== 0) await command('git', ['tag', '-a', tag, '-m', tag, entry.sha], cwd);
    }
    assertPush(cwd, entry.sha, tag);
    await command(config.transport[0], [...config.transport.slice(1), ...(tag ? ['--tag', tag] : [])], cwd);
    console.log(`FIFO ${entry.id} complete; finish this worktree from canonical main`);
    observation = {state: 'succeeded', outcome: 'integrated'};
  } catch (error) {
    observation = {state: cancelled ? 'interrupted' : 'failed', error: error.message.slice(0, 2000)};
    throw error;
  } finally {
    if (entry) {
      const deadline = Date.now() + 30_000;
      while (inventory().some(row => row.pgid === process.pid && row.pid !== process.pid && row.live)) {
        if (Date.now() > deadline) throw Error(`FIFO ${entry.id} retained: child process group is still active`);
        await delay(100);
      }
      await mutex(cwd, config, () => {
        const current = queue(cwd).find(row => row.id === entry.id);
        if (current && (current.pid !== process.pid || !local(current))) throw Error('Cannot remove another ticket');
        if (current) { settle(cwd, entry, observation); fs.unlinkSync(path.join(root(cwd), entry.id + '.json')); }
      });
    }
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

function reusable(cwd, tag, identity) {
  const entry = queue(cwd).find(row => row.cwd === cwd);
  if (!entry) return null;
  if (entry.branch !== identity.branch || entry.tag !== tag || entry.sha !== identity.sha && entry.sourceSha !== identity.sha) {
    throw Error(`FIFO ${entry.id} owns another candidate; inspect before retrying`);
  }
  const value = status(cwd, entry.id);
  if (value.state === 'recovery_required') throw Error(`FIFO ${entry.id} needs recovery; no replacement was started`);
  return value;
}
async function background(cwd, tag) {
  // Reattachment precedes clean-tree checks: the worker may be rebasing now.
  const identity = {branch: git(cwd, 'symbolic-ref', '--short', 'HEAD'), sha: git(cwd, 'rev-parse', 'HEAD')};
  const existing = reusable(cwd, tag, identity);
  if (existing) return existing;
  candidate(cwd); policy(cwd);
  if (!fs.existsSync(root(cwd))) {
    try { fs.mkdirSync(root(cwd), {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return launchBackground({cwd, script: fileURLToPath(import.meta.url), ...identity,
    tagArguments: tag ? ['--tag', tag] : [], logDirectory: path.join(root(cwd), 'logs'),
    observe: message => {
      const value = message?.duplicate ? reusable(cwd, tag, identity) : status(cwd, message?.id);
      if (!value || value.state === 'unknown') throw Error('No durable coordination admission was found');
      return value;
    }});
}

export async function main(args = process.argv.slice(2)) {
  const cwd = fs.realpathSync(process.cwd());
  if (args[0] === '--assert-push' && args.length >= 2 && args.length <= 3) return assertPush(cwd, args[1], args[2]);
  if (args[0] === '--status' && args.length === 1) return console.log(JSON.stringify(queue(cwd), null, 2));
  if (args[0] === '--status' && args.length === 2) return console.log(JSON.stringify(status(cwd, args[1])));
  if (args[0] === '--wait' && args.length === 2) return waitForIntegration(args[1], id => status(cwd, id));
  if (args[0] === '--recover' && args.length === 2) return recover(cwd, args[1]);
  const worker = args[0] === '--worker', backgroundWorker = args[0] === '--background-worker';
  const detached = args[0] === '--background', foreground = args[0] === '--foreground', wait = args[0] === '--wait';
  const expected = backgroundWorker ? {logFile: args[1], sha: args[2], branch: args[3]} : null;
  if (backgroundWorker && (!/^[a-f0-9]{32}\.log$/u.test(expected.logFile ?? '') || !SHA.test(expected.sha ?? '')
    || !/^codex\/[a-z0-9][a-z0-9._-]*$/u.test(expected.branch ?? ''))) throw Error('Invalid background worker identity');
  if (backgroundWorker) args = args.slice(4);
  else if (worker || detached || foreground || wait) args = args.slice(1);
  if (!(args.length === 0 || args.length === 2 && args[0] === '--tag')) throw Error('Use git:integrate -- [--background | --foreground | --wait] [--tag TAG] | --wait TICKET | --status [TICKET] | --recover TICKET');
  if (!['darwin', 'linux'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 22) throw Error('Coordinator requires native Linux/macOS and Node >=22');
  if (worker) return coordinate(cwd, args[1] ?? '');
  if (backgroundWorker) {
    try { return await coordinate(cwd, args[1] ?? '', {expected, logFile: expected.logFile}); }
    catch (error) {
      await acknowledgeAdmission(error.code === 'INTEGRATION_ALREADY_QUEUED' ? {duplicate: true} : {error: error.message});
      throw error;
    }
  }
  if (!foreground) {
    // Even with a waiting caller, the same detached worker owns the FIFO and
    // survives an interruption of the caller. Foreground remains diagnostic.
    const result = await background(cwd, args[1] ?? '');
    const canonical = git(cwd, 'config', '--get', policy(cwd).canonicalKey);
    if (wait) return waitForIntegration(result.id, id => status(canonical, id));
    return console.log(JSON.stringify(integrationLaunchResult(result, canonical)));
  }
  // Each worker owns an observable group, including all ordinary Git/gh children.
  // A SIGKILL keeps its ticket until exact dead-group recovery is established.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', ...args], {cwd, stdio: 'inherit', detached: true});
  const forward = () => { try { process.kill(child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  process.on('SIGINT', forward); process.on('SIGTERM', forward);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { process.exitCode = signal ? 1 : code; resolve(); }); });
  process.off('SIGINT', forward); process.off('SIGTERM', forward);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
