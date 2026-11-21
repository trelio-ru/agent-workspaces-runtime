import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {read} from './git-coordinator.mjs';
import {validateJobs} from './git-hosted-ci.mjs';
import {validateWindowsPrivateWorker} from './validate-windows-private-worker.mjs';

const repository = 'trelio-ru/agent-workspaces-runtime';
const workflow = 'runtime-tests.yml';
const jobName = 'Build native Windows private worker';
const artifactName = 'windows-private-worker';
const workerRootPath = 'host-runtime/scripts/native-private-process';
const sourceName = 'PrivateProcess.cpp';
const inputs = [workerRootPath + '/' + sourceName, 'scripts/build-windows-private-worker.ps1'];
const architectures = ['arm64', 'ia32', 'x64'];
const files = ['metadata.json', ...architectures.map(arch => arch + '/trelio-private-process.exe')];
const receiptName = '.trelio-worker-preflight.json';
const maxArchive = 8 * 1024 * 1024;
const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const isDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const isFingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const isId = value => Number.isSafeInteger(value) && value > 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function checkedOutput(cmd, args, cwd, maxBuffer = maxArchive) {
  const child = spawnSync(cmd, args, {cwd, maxBuffer, timeout: 30_000, shell: false,
    windowsHide: true, env: {...process.env, GH_PROMPT_DISABLED: '1'}});
  // Never print CLI stderr or raw API metadata. It can contain local paths or
  // a signed artifact URL. A partial body or a nonzero exit cannot seed cache.
  if (child.error || child.status !== 0 || child.stderr.length) throw Error('Windows worker preflight: ' + cmd + ' failed.');
  return child.stdout;
}

const apiPath = 'repos/' + repository + '/actions/';
const githubOutput = (cwd, endpoint) => checkedOutput('gh', ['api', '--hostname', 'github.com', apiPath + endpoint], cwd);
const githubJson = (cwd, endpoint) => JSON.parse(githubOutput(cwd, endpoint).toString('utf8'));

function inputRevision(cwd, revision) {
  const objects = read('git', ['rev-parse', '--verify', revision + ':' + inputs[0]], cwd) + '\n'
    + read('git', ['rev-parse', '--verify', revision + ':' + inputs[1]], cwd);
  if (!objects.split('\n').every(isSha)) throw Error('Cannot identify exact Windows worker build inputs.');
  return sha256(objects);
}

function approvedAncestor(cwd, sha, base) {
  const child = spawnSync('git', ['merge-base', '--is-ancestor', sha, base], {cwd, shell: false,
    timeout: 5_000, windowsHide: true});
  return !child.error && child.status === 0 && !child.stderr.length;
}

/** Reuse a worker build only from the official release workflow, after that
 * exact build-input revision reached main. This artifact is a dependency of
 * the local test. It supplies no release evidence for the candidate commit.
 */
export function findHostedWindowsWorker({cwd, baseSha, key, getJson = githubJson,
  isAncestor = approvedAncestor, resolveInputs = inputRevision}) {
  const inventory = getJson(cwd, 'workflows/' + workflow + '/runs?event=workflow_dispatch&status=success&per_page=30');
  if (!Array.isArray(inventory?.workflow_runs) || inventory.workflow_runs.length > 30) {
    throw Error('Invalid Windows worker build inventory.');
  }
  for (const run of inventory.workflow_runs) {
    if (!isId(run?.id) || !isId(run.run_attempt) || !isSha(run.head_sha)
      || run.path !== '.github/workflows/' + workflow || run.event !== 'workflow_dispatch'
      || run.status !== 'completed' || run.conclusion !== 'success'
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
      || !isAncestor(cwd, run.head_sha, baseSha) || resolveInputs(cwd, run.head_sha) !== key) continue;

    const artifacts = getJson(cwd, 'runs/' + run.id + '/artifacts?per_page=100');
    if (!Array.isArray(artifacts?.artifacts) || artifacts.total_count !== artifacts.artifacts.length) {
      throw Error('Incomplete Windows worker artifact inventory.');
    }
    const matches = artifacts.artifacts.filter(item => item?.name === artifactName && item.expired === false);
    if (!matches.length) continue;
    const [artifact] = matches;
    if (matches.length !== 1 || !isId(artifact.id) || !isDigest(artifact.digest)
      || !isId(artifact.size_in_bytes) || artifact.size_in_bytes > maxArchive) {
      throw Error('Invalid or ambiguous Windows worker artifact.');
    }
    const jobs = getJson(cwd, 'runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs?per_page=100');
    validateJobs(run, [jobs], [jobName]);
    return {id: artifact.id, digest: artifact.digest};
  }
  throw Error('No verified hosted Windows worker for these build inputs. Prepare a matching official CI artifact before integrating.');
}

async function present(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function readRegularFile(file, limit) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || !stat.size || stat.size > limit) throw Error('Unexpected Windows worker file.');
  return fs.readFile(file);
}

async function requireDirectoryContents(directory, expected) {
  if (!(await fs.lstat(directory)).isDirectory()) throw Error('Unexpected Windows worker directory.');
  const names = await fs.readdir(directory);
  if (names.length !== expected.length || !expected.every(name => names.includes(name))) {
    throw Error('Unexpected files in Windows worker directory.');
  }
}

async function workerFingerprint(directory, withReceipt) {
  // A receipt alone does not own files later added, edited or copied here.
  // Check the complete layout and bytes before moving or removing a directory.
  await requireDirectoryContents(directory, ['metadata.json', ...architectures, ...(withReceipt ? [receiptName] : [])]);
  for (const arch of architectures) {
    await requireDirectoryContents(path.join(directory, arch), ['trelio-private-process.exe']);
  }
  const fileDigests = await Promise.all(files.map(async file =>
    sha256(await readRegularFile(path.join(directory, file), 2_000_000))));
  return sha256(fileDigests.join('\n'));
}

async function readManagedWorker(directory, owner) {
  const stat = await present(directory);
  if (!stat?.isDirectory() || !await present(path.join(directory, receiptName))) return null;
  try {
    const receipt = JSON.parse(await readRegularFile(path.join(directory, receiptName), 512));
    if (receipt?.version !== 1 || receipt.owner !== owner || !isFingerprint(receipt.key)
      || receipt.fingerprint !== await workerFingerprint(directory, true)) {
      throw Error('Windows worker receipt does not match this worktree and payload.');
    }
    return {key: receipt.key, fingerprint: receipt.fingerprint, dev: stat.dev, ino: stat.ino};
  } catch (cause) {
    throw Error('Managed Windows worker in bin/ changed outside preflight. Preserve it separately before retrying.', {cause});
  }
}

const sameWorker = (actual, expected) => actual?.key === expected.key && actual.fingerprint === expected.fingerprint
  && actual.dev === expected.dev && actual.ino === expected.ino;

async function validateExistingWorker(sourceRoot) {
  try { await validateWindowsPrivateWorker(sourceRoot); }
  catch (cause) {
    throw Error('Existing Windows worker in bin/ failed validation. Move it out of this worktree to prepare a verified copy.', {cause});
  }
  return 'existing';
}

function verifyArchive(zip, digest) {
  if (!isDigest(digest) || !zip.length || zip.length > maxArchive || 'sha256:' + sha256(zip) !== digest) {
    throw Error('Windows worker archive digest mismatch.');
  }
}

async function extractWorker(zipPath, directory, cwd) {
  // Use exact member names and stdout extraction. Archive paths/symlinks
  // cannot choose a write destination, even after the ZIP hash is verified.
  const windows = process.platform === 'win32';
  const extractor = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip';
  const list = checkedOutput(extractor, [windows ? '-tf' : '-Z1', zipPath], cwd, 16 * 1024)
    .toString('utf8').trimEnd().split(/\r?\n/u).filter(name => !architectures.some(arch => name === arch + '/'));
  if (list.length !== files.length || new Set(list).size !== files.length || !files.every(file => list.includes(file))) {
    throw Error('Unexpected Windows worker archive members.');
  }
  for (const file of files) {
    const output = path.join(directory, file);
    const bytes = checkedOutput(extractor, [windows ? '-xOf' : '-p', zipPath, file], cwd, 2_000_000);
    await fs.mkdir(path.dirname(output), {recursive: true, mode: 0o700});
    await fs.writeFile(output, bytes, {flag: 'wx', mode: 0o600});
  }
}

async function publishDirectory(prepared, destination) {
  try { await fs.rename(prepared, destination); }
  catch (error) {
    // Another valid preparation may have won. Never remove its state.
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !(await present(destination))?.isDirectory()) throw error;
  }
}

async function readCache(directory) {
  const cached = await present(directory);
  if (!cached) return null;
  if (!cached.isDirectory() || cached.isSymbolicLink()) throw Error('Invalid local Windows worker cache.');
  const physicalDirectory = await fs.realpath(directory);
  const zipPath = path.join(directory, 'worker.zip');
  const digestPath = path.join(directory, 'digest');
  for (const [file, limit] of [[zipPath, maxArchive], [digestPath, 72]]) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > limit
      || await fs.realpath(file) !== path.join(physicalDirectory, path.basename(file))) {
      throw Error('Invalid local Windows worker cache.');
    }
  }
  const zip = await fs.readFile(zipPath);
  const digest = await fs.readFile(digestPath, 'utf8');
  verifyArchive(zip, digest);
  return {zip, digest};
}

export async function prepareWindowsWorkerForLocalChecks(cwd, baseSha, headSha,
  {locate = findHostedWindowsWorker, download = (root, artifact) => githubOutput(root, 'artifacts/' + artifact.id + '/zip')} = {}) {
  const sourceRoot = path.join(cwd, workerRootPath);
  const target = path.join(sourceRoot, 'bin');
  const existing = await present(target);
  const marked = existing?.isDirectory() && await present(path.join(target, receiptName));
  // Validate user-owned and legacy drops directly, even when Git or GitHub
  // cannot resolve an artifact. Only the queue's own drop can be refreshed.
  if (existing && !marked) return validateExistingWorker(sourceRoot);

  if (!isSha(baseSha) || !isSha(headSha)) throw Error('Invalid revisions for Windows worker preflight.');
  const key = inputRevision(cwd, headSha);
  // The private Git directory is stable across rebases and distinct for linked
  // worktrees. Copying a bin directory elsewhere cannot grant replacement.
  const owner = sha256(await fs.realpath(read('git', ['rev-parse', '--absolute-git-dir'], cwd)));
  const previous = marked ? await readManagedWorker(target, owner) : null;
  if (marked && !previous) throw Error('Windows worker in bin/ changed while reading its receipt.');
  if (previous?.key === key) return validateExistingWorker(sourceRoot);
  const gitDirectory = await fs.realpath(path.resolve(cwd, read('git', ['rev-parse', '--git-common-dir'], cwd)));
  const cacheParent = path.join(gitDirectory, 'trelio-windows-worker-cache');
  const cacheParentStat = await present(cacheParent);
  if (cacheParentStat && (!cacheParentStat.isDirectory() || cacheParentStat.isSymbolicLink())) {
    throw Error('Invalid local Windows worker cache directory.');
  }
  const cache = path.join(cacheParent, key);
  const cached = await readCache(cache);
  let artifact = cached;
  if (!artifact) {
    const selected = locate({cwd, baseSha, key});
    artifact = {zip: download(cwd, selected), digest: selected.digest};
    verifyArchive(artifact.zip, artifact.digest);
  }

  // Stage on the worktree's filesystem so publishing bin is atomic. Keep
  // this disposable directory ignored even if a local integration is killed.
  const staging = await fs.mkdtemp(path.join(sourceRoot, '.worker-stage-'));
  const backup = path.join(staging, 'previous-bin');
  let backupPending = false;
  try {
    const archive = path.join(staging, 'worker.zip');
    await fs.writeFile(archive, artifact.zip, {flag: 'wx', mode: 0o600});
    await fs.copyFile(path.join(sourceRoot, sourceName), path.join(staging, sourceName));
    const binaryDirectory = path.join(staging, 'bin');
    await extractWorker(archive, binaryDirectory, cwd);
    await validateWindowsPrivateWorker(staging);
    const fingerprint = await workerFingerprint(binaryDirectory, false);
    await fs.writeFile(path.join(binaryDirectory, receiptName),
      JSON.stringify({version: 1, owner, key, fingerprint}), {flag: 'wx', mode: 0o600});

    if (!cached) {
      await fs.mkdir(cacheParent, {recursive: true, mode: 0o700});
      const cacheStage = await fs.mkdtemp(path.join(cacheParent, '.worker-'));
      try {
        await fs.copyFile(archive, path.join(cacheStage, 'worker.zip'));
        await fs.writeFile(path.join(cacheStage, 'digest'), artifact.digest, {flag: 'wx', mode: 0o600});
        await publishDirectory(cacheStage, cache);
      } finally { await fs.rm(cacheStage, {recursive: true, force: true}); }
    }
    if (previous) {
      // Finish candidate verification before moving the previous payload.
      // Check identity on both sides of rename so a concurrent replacement
      // is preserved even if it arrived between the check and the rename.
      if (!sameWorker(await readManagedWorker(target, owner), previous)) {
        throw Error('Windows worker in bin/ changed while its replacement was being prepared.');
      }
      await fs.rename(target, backup);
      backupPending = true;
      if (!sameWorker(await readManagedWorker(backup, owner), previous)) {
        throw Error('Windows worker in bin/ changed while it was being moved.');
      }
    }
    await publishDirectory(binaryDirectory, target);
    if ((await readManagedWorker(target, owner))?.key !== key) {
      throw Error('Windows worker in bin/ was replaced concurrently.');
    }
    await validateWindowsPrivateWorker(sourceRoot);
    backupPending = false;
    return cached ? 'cache' : 'hosted';
  } catch (cause) {
    if (backupPending) {
      // Never overwrite a newly arrived destination during rollback. Keep the
      // moved directory available if a safe rollback is impossible.
      try {
        if (!await present(target)) {
          await fs.rename(backup, target);
          backupPending = false;
        }
      } catch { /* The backup still lives in this ignored staging directory. */ }
      if (backupPending) throw Error('Windows worker refresh failed. The previous directory is preserved at ' + backup, {cause});
    }
    throw cause;
  } finally {
    if (!backupPending) await fs.rm(staging, {recursive: true, force: true});
  }
}
