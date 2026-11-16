/** Maintainer-only process transport, shared by both integration engines.
 * The repository still owns FIFO admission, CI evidence, results and recovery.
 * There is no scheduler, model invocation, shell text or Git policy here.
 */
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const activeStates = new Set(['waiting', 'running', 'verified']);

export async function waitForIntegration(id, observe) {
  const readStatus = () => {
    const observation = observe(id);
    // A normal worker can release its ticket and exit between the queue and
    // process reads. Recheck the exact ticket before reporting a dead owner.
    return observation.state === 'recovery_required' ? observe(id) : observation;
  };
  let result = readStatus();
  if (activeStates.has(result.state)) {
    // Emit the locator before waiting so an interrupted client can reattach.
    // This process only reads status. Its lifetime never controls the worker.
    console.error(`Waiting for integration ${id}. Reattach with: npm run git:integrate -- --wait ${id}`);
    do {
      await delay(1000);
      result = readStatus();
    } while (activeStates.has(result.state));
  }
  console.log(JSON.stringify(result));
  if (result.state !== 'succeeded') process.exitCode = 1;
}

/** Admission is sufficient to release the chat. Keep client-facing guidance
 * out of receipts, which record the result independently of any chat.
 */
export function integrationLaunchResult(observation, canonicalDirectory) {
  const active = activeStates.has(observation.state);
  return {...observation, followUp: {
    action: active ? 'end_turn_after_admission' : 'review_integration_result',
    canonicalDirectory,
    statusArgs: ['--status', observation.id],
    instruction: active
      ? 'Report that this ticket was queued and end the turn. The worker continues independently. Read the exact result when the user returns. No automatic chat wake-up is registered.'
      : 'Review this exact terminal outcome before any retry. Complete any recorded pending cleanup and remaining authorised release steps.',
  }};
}

/** Caller owns the live FIFO ticket and the short main mutex. Pass the
 * repository's strict Git reader and candidate check so cleanup shares the
 * same metadata, cleanliness and in-progress-operation rules as transport.
 */
export function finishIntegratedWorktree(canonical, entry, git, checkCandidate) {
  if (entry.cwd === canonical || git(canonical, 'symbolic-ref', 'HEAD') !== 'refs/heads/main'
    || git(canonical, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none')) {
    throw Error('Local cleanup requires clean canonical main');
  }
  checkCandidate(entry.cwd, entry);
  git(canonical, 'merge-base', '--is-ancestor', entry.sha, 'refs/remotes/origin/main');
  // Removing without --force protects concurrent file edits and locked
  // worktrees. CAS protects the branch if its tip moves during removal.
  git(canonical, 'worktree', 'remove', entry.cwd);
  git(canonical, 'update-ref', '-d', `refs/heads/${entry.branch}`, entry.sha);
}

function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077
    || process.getuid && stat.uid !== process.getuid()) throw Error('Unsafe background log directory');
}

// A failed/lost IPC acknowledgement does not roll back admission or terminate
// the integration. The next observer must inspect durable state before retry.
export function acknowledgeAdmission(value) {
  return new Promise(resolve => {
    if (!process.connected) return resolve();
    process.send(value, () => { if (process.connected) process.disconnect(); resolve(); });
  });
}

export async function launchBackground({cwd, script, branch, sha, tagArguments = [], logDirectory, observe}) {
  privateDirectory(path.dirname(logDirectory));
  if (!fs.existsSync(logDirectory)) {
    try { fs.mkdirSync(logDirectory, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  privateDirectory(logDirectory);
  const logFile = `${randomBytes(16).toString('hex')}.log`, logPath = path.join(logDirectory, logFile);
  const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let child;
  try {
    child = spawn(process.execPath, [script, '--background-worker', logFile, sha, branch, ...tagArguments],
      {cwd, detached: true, stdio: ['ignore', fd, fd, 'ipc']});
  } finally { fs.closeSync(fd); }
  // Inherit neither the terminal nor a chat-owned output pipe. Grandchildren
  // stay in this observable group; there is no automatic restart after a crash.
  try {
    const message = await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer); child.off('message', received); child.off('exit', exited); child.off('error', failed);
        error ? reject(error) : resolve(value);
      };
      const received = value => finish(null, value);
      const exited = () => finish(Error('Background worker exited before queue admission'));
      const failed = error => finish(error);
      const timer = setTimeout(() => finish(Error('Queue admission was not acknowledged; inspect before retrying')), 30_000);
      child.once('message', received); child.once('exit', exited); child.once('error', failed);
    });
    if (message?.error) throw Error(message.error);
    return await observe(message);
  } catch (error) {
    throw Error(`${error.message}. Worker pid=${child.pid ?? 'unknown'}; log=${logPath}. Do not assume integration failed or enqueue blindly`);
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}
