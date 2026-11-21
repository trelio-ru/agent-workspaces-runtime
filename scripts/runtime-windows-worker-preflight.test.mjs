import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {findHostedWindowsWorker, prepareWindowsWorkerForLocalChecks} from './runtime-windows-worker-preflight.mjs';

const repository = {full_name: 'trelio-ru/agent-workspaces-runtime'};
const candidateBase = 'a'.repeat(40);
const key = 'candidate-inputs';
const digest = 'sha256:' + '1'.repeat(64);
const run = (id, overrides = {}) => ({
  id, head_sha: id.toString(16).repeat(40), path: '.github/workflows/runtime-tests.yml',
  run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
  repository, head_repository: repository, ...overrides,
});
const artifact = {id: 71, name: 'windows-private-worker', digest, expired: false, size_in_bytes: 100};
const workerJob = (source, overrides = {}) => ({id: 91, name: 'Build native Windows private worker',
  run_id: source.id, run_attempt: source.run_attempt, head_sha: source.head_sha,
  status: 'completed', conclusion: 'success', runner_group_name: 'GitHub Actions', ...overrides});
const inventory = runs => ({workflow_runs: runs});
const availableArtifacts = (...artifacts) => ({total_count: artifacts.length, artifacts});
const jobs = (...jobs) => ({total_count: jobs.length, jobs});

test('worker selection verifies the official workflow, main lineage, build inputs and hosted job', () => {
  const source = run(7);
  const before = [
    run(2, {head_repository: {full_name: 'fork/agent-workspaces-runtime'}}),
    run(3, {path: '.github/workflows/other.yml'}),
    run(4), // This release was not integrated.
    run(5), // This release compiled different inputs.
    run(6), // Matching build, but its artifact has expired.
  ];
  const seen = [];
  const selected = findHostedWindowsWorker({cwd: '/fixture', baseSha: candidateBase, key,
    isAncestor: (_cwd, sha, base) => base === candidateBase && sha !== run(4).head_sha,
    resolveInputs: (_cwd, sha) => sha === run(5).head_sha ? 'other' : key,
    getJson: (_cwd, endpoint) => {
      seen.push(endpoint);
      if (endpoint.startsWith('workflows/')) return inventory([...before, source]);
      if (endpoint.startsWith('runs/6/')) return availableArtifacts({...artifact, expired: true});
      if (endpoint === 'runs/7/artifacts?per_page=100') return availableArtifacts(artifact);
      if (endpoint === 'runs/7/attempts/1/jobs?per_page=100') return jobs(workerJob(source));
      assert.fail(endpoint);
    },
  });
  assert.deepEqual(selected, {id: artifact.id, digest: artifact.digest});
  assert.equal(seen.length, 4);
});

test('a digest is insufficient without one exact artifact and successful hosted worker job', () => {
  const source = run(7);
  const locate = (getArtifacts, getJobs = () => jobs(workerJob(source))) => findHostedWindowsWorker({
    cwd: '/fixture', baseSha: candidateBase, key, isAncestor: () => true, resolveInputs: () => key,
    getJson: (_cwd, endpoint) => endpoint.startsWith('workflows/') ? inventory([source])
      : endpoint.includes('/artifacts') ? getArtifacts() : getJobs(),
  });
  assert.throws(() => locate(() => availableArtifacts({...artifact, digest: null})), /Invalid or ambiguous/u);
  assert.throws(() => locate(() => availableArtifacts(artifact, {...artifact, id: 72})), /Invalid or ambiguous/u);
  assert.throws(() => locate(() => availableArtifacts(artifact), () =>
    jobs(workerJob(source, {runner_group_name: 'private'}))), /GitHub-hosted/u);
  assert.throws(() => locate(() => availableArtifacts()), /No verified hosted Windows worker/u);
});

async function workerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-worker-preflight-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const inputDirectory = path.join(root, 'host-runtime/scripts/native-private-process');
  const sourcePath = path.join(inputDirectory, 'PrivateProcess.cpp');
  const buildPath = path.join(root, 'scripts/build-windows-private-worker.ps1');
  await fs.mkdir(inputDirectory, {recursive: true});
  await fs.writeFile(sourcePath, 'fixture');
  await fs.mkdir(path.dirname(buildPath));
  await fs.writeFile(buildPath, 'fixture');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(root, 'no-hooks'),
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], {cwd: root, encoding: 'utf8'}).trim();
  git('init', '-q');
  const commit = () => {
    // The worker is ignored in the real repository. Commit only build inputs
    // here so the fixture has the same Git identity across staging and retries.
    git('add', '--', sourcePath, buildPath);
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return {root, inputDirectory, sourcePath, buildPath, head: commit(), commit, git,
    bin: path.join(inputDirectory, 'bin')};
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function workerArchive({root, sourcePath}, version) {
  const directory = await fs.mkdtemp(path.join(root, '.git', 'archive-'));
  const members = ['metadata.json'];
  const binaries = {};
  for (const [arch, machine] of Object.entries({x64: 0x8664, ia32: 0x14c, arm64: 0xaa64})) {
    // Sufficient PE header bytes for the real packaging validator. The
    // payload is synthetic and the test never starts it as a program.
    const bytes = Buffer.alloc(80, version);
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(64, 0x3c);
    bytes.writeUInt32LE(0x4550, 64);
    bytes.writeUInt16LE(machine, 68);
    binaries[arch] = {sizeBytes: bytes.length, sha256: sha256(bytes)};
    await fs.mkdir(path.join(directory, arch));
    const member = arch + '/trelio-private-process.exe';
    members.push(member);
    await fs.writeFile(path.join(directory, member), bytes);
  }
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({
    schemaVersion: 1, sourceSha256: sha256(await fs.readFile(sourcePath)), binaries,
  }));
  const archive = path.join(directory, 'worker.zip');
  const windows = process.platform === 'win32';
  const archiver = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
  execFileSync(archiver, [...(windows ? ['-a', '-cf'] : ['-q']), archive, ...members], {cwd: directory});
  const bytes = await fs.readFile(archive);
  return {locate: () => ({id: 71, digest: 'sha256:' + sha256(bytes)}), download: () => bytes};
}

test('a mismatched archive cannot leave a worktree payload or a cache entry', async t => {
  const {root, inputDirectory, head, bin} = await workerFixture(t);
  await assert.rejects(prepareWindowsWorkerForLocalChecks(root, head, head, {
    locate: () => ({id: 71, digest}), download: () => Buffer.from('other archive'),
  }), /archive digest mismatch/u);
  assert.deepEqual(await fs.readdir(inputDirectory), ['PrivateProcess.cpp']);
  await assert.rejects(fs.stat(path.join(root, '.git/trelio-windows-worker-cache')), {code: 'ENOENT'});

  await fs.mkdir(bin);
  const metadataPath = path.join(bin, 'metadata.json');
  await fs.writeFile(metadataPath, 'incomplete manual input');
  await assert.rejects(prepareWindowsWorkerForLocalChecks(root, head, head, {
    locate: () => assert.fail('Unknown existing input must not be replaced'),
  }), /Existing Windows worker in bin\/ failed validation/u);
  assert.equal(await fs.readFile(metadataPath, 'utf8'), 'incomplete manual input');
});

test('the local gate refreshes its own worker after either build input changes', async t => {
  const fixture = await workerFixture(t);
  const {root, bin, head, sourcePath, buildPath, commit, git} = fixture;
  const executable = path.join(bin, 'x64', 'trelio-private-process.exe');
  const receipt = path.join(bin, '.trelio-worker-preflight.json');
  const offline = {locate: () => assert.fail('Unexpected remote lookup')};
  assert.equal(await prepareWindowsWorkerForLocalChecks(root, head, head, await workerArchive(fixture, 1)), 'hosted');
  assert.equal(await prepareWindowsWorkerForLocalChecks(root, head, head, offline), 'existing');
  const initialReceipt = await fs.readFile(receipt, 'utf8');

  // In a script-only change the old binaries still pass source validation.
  // The commit's complete build inputs must still require a refresh.
  await fs.appendFile(buildPath, '\nbuild change');
  const scriptChanged = commit();
  await assert.rejects(prepareWindowsWorkerForLocalChecks(root, scriptChanged, scriptChanged, {
    locate: () => { throw Error('No matching official artifact'); },
  }), /No matching official artifact/u);
  assert.equal(await fs.readFile(receipt, 'utf8'), initialReceipt);
  assert.equal((await fs.readFile(executable))[79], 1);
  assert.equal(await prepareWindowsWorkerForLocalChecks(root, scriptChanged, scriptChanged,
    await workerArchive(fixture, 2)), 'hosted');
  assert.equal((await fs.readFile(executable))[79], 2);

  await fs.appendFile(sourcePath, '\nsource change');
  const sourceChanged = commit();
  assert.equal(await prepareWindowsWorkerForLocalChecks(root, sourceChanged, sourceChanged,
    await workerArchive(fixture, 3)), 'hosted');
  assert.equal((await fs.readFile(executable))[79], 3);
  git('checkout', '--quiet', '--detach', scriptChanged);
  assert.equal(await prepareWindowsWorkerForLocalChecks(root, scriptChanged, scriptChanged, offline), 'cache');
  assert.equal((await fs.readFile(executable))[79], 2);
});

test('refresh preserves files added to a previously managed worker', async t => {
  const fixture = await workerFixture(t);
  const {root, bin, head, buildPath, commit} = fixture;
  await prepareWindowsWorkerForLocalChecks(root, head, head, await workerArchive(fixture, 1));
  const localFile = path.join(bin, 'x64', 'local-notes.txt');
  await fs.writeFile(localFile, 'user copy');
  await fs.appendFile(buildPath, '\nnext version');
  const next = commit();
  await assert.rejects(prepareWindowsWorkerForLocalChecks(root, next, next, {
    locate: () => assert.fail('Modified worker is user-owned'),
  }), /changed outside preflight/u);
  assert.equal(await fs.readFile(localFile, 'utf8'), 'user copy');
});

test('failed publication restores the previous verified directory', async t => {
  const fixture = await workerFixture(t);
  const {root, bin, head, buildPath, commit, inputDirectory} = fixture;
  await prepareWindowsWorkerForLocalChecks(root, head, head, await workerArchive(fixture, 1));
  const receipt = path.join(bin, '.trelio-worker-preflight.json');
  const originalReceipt = await fs.readFile(receipt, 'utf8');
  await fs.appendFile(buildPath, '\nnext version');
  const next = commit();
  const replacement = await workerArchive(fixture, 2);
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', (from, to) => {
    if (to === bin && path.basename(from) === 'bin') throw Object.assign(Error('fixture publication failure'), {code: 'EIO'});
    return rename(from, to);
  });
  try {
    await assert.rejects(prepareWindowsWorkerForLocalChecks(root, next, next, replacement), /fixture publication failure/u);
  } finally { mock.mock.restore(); }
  assert.equal(await fs.readFile(receipt, 'utf8'), originalReceipt);
  assert.deepEqual((await fs.readdir(inputDirectory)).sort(), ['PrivateProcess.cpp', 'bin']);
  assert.equal(await prepareWindowsWorkerForLocalChecks(root, next, next, {
    locate: () => assert.fail('The verified replacement ZIP should be cached'),
  }), 'cache');
});
