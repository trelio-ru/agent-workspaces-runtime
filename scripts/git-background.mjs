/** Maintainer-only process transport, shared by both integration engines.
 * The repository still owns FIFO admission, CI evidence, results and recovery.
 * There is no scheduler, model invocation, shell text or Git policy here.
 */
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
