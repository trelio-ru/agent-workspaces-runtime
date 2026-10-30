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

/** This is the SAME mutex used by existing worktree/transport shell helpers.
 * Keep it short, owner-compatible and never steal an unknown or dead lock.
 * CI is protected by the durable FIFO ticket, so worktree creation stays usable.
 */
async function mutex(cwd, config, action, cancelled = () => false) {
  const directory = path.join(common(cwd), config.mainMutex), owner = path.join(directory, 'owner');
  const started = Date.now();
  for (;;) {
    if (cancelled()) throw Error('Coordination interrupted');
    try { fs.mkdirSync(directory, {mode: 0o700}); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let value;
      try { value = fs.readFileSync(owner, 'utf8'); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      if (value) {
        const pid = +(/^pid=(\d+)$/mu.exec(value)?.[1] ?? 0), host = /^host=(.+)$/mu.exec(value)?.[1];
        if (host !== startHost || !inventory().some(row => row.pid === pid && row.live)) throw Error('Inspect existing main mutex; owner is not confirmed live');
      } else if (Date.now() - started > 5000) throw Error('Main mutex has no owner');
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
  if (tag && !/^(?:v|skill-[a-z0-9-]+-v|codex-hooks-source-v)\d+\.\d+\.\d+$/u.test(tag)) throw Error('Invalid immutable release tag');
  const canonical = fs.realpathSync(git(cwd, 'config', '--get', config.canonicalKey));
  if (common(canonical) !== common(cwd) || git(canonical, 'branch', '--show-current') !== 'main'
    || git(canonical, 'status', '--porcelain=v1', '-z', '--untracked-files=all')) throw Error('Canonical main must be configured and clean');
  const processRow = inventory().find(row => row.pid === process.pid);
  if (processRow?.pgid !== process.pid) throw Error('Coordinator must own its isolated process group');
  let cancelled = false, entry;
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
      const row = {schemaVersion: 1, id: String(next).padStart(12, '0'), pid: process.pid, pgid: process.pid,
        host: startHost, stableHost, cwd: fs.realpathSync(cwd), ...initial, tag, state: 'waiting'};
      save(counter, next + 1); save(path.join(root(cwd), row.id + '.json'), row); return row;
    }, () => cancelled);
    console.log(`FIFO ${entry.id}: ${entry.branch}${tag ? ' / ' + tag : ''}`);
    for (;;) {
      if (cancelled) throw Error('Coordination interrupted');
      const first = queue(cwd)[0];
      if (!first || !local(first) || !inventory().some(row => row.pid === first.pid && row.live)) {
        throw Error('First FIFO owner is not live; inspect --status and --recover TICKET');
      }
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
      await command('git', ['merge', '--ff-only', entry.sha], canonical); return;
    }
    await command('git', ['push', `--force-with-lease=${remoteRef}:${remoteSha}`, 'origin', `HEAD:${remoteRef}`], cwd);
    await command(config.verify[0], [...config.verify.slice(1), '--prepare', entry.sha], cwd);
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
        if (current) fs.unlinkSync(path.join(root(cwd), entry.id + '.json'));
      });
    }
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

export async function main(args = process.argv.slice(2)) {
  const cwd = fs.realpathSync(process.cwd());
  if (args[0] === '--assert-push' && args.length >= 2 && args.length <= 3) return assertPush(cwd, args[1], args[2]);
  if (args[0] === '--status' && args.length === 1) return console.log(JSON.stringify(queue(cwd), null, 2));
  if (args[0] === '--recover' && args.length === 2) return recover(cwd, args[1]);
  const worker = args[0] === '--worker';
  if (worker) args = args.slice(1);
  if (!(args.length === 0 || args.length === 2 && args[0] === '--tag')) throw Error('Use git:integrate -- [--tag TAG | --status | --recover TICKET]');
  if (!['darwin', 'linux'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 22) throw Error('Coordinator requires native Linux/macOS and Node >=22');
  if (worker) return coordinate(cwd, args[1] ?? '');
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
