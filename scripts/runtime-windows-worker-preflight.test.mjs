import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
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

test('a mismatched archive cannot leave a worktree payload or a cache entry', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-worker-preflight-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const inputDirectory = path.join(root, 'host-runtime/scripts/native-private-process');
  await fs.mkdir(inputDirectory, {recursive: true});
  await fs.writeFile(path.join(inputDirectory, 'PrivateProcess.cpp'), 'fixture');
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'scripts/build-windows-private-worker.ps1'), 'fixture');
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(root, 'no-hooks'),
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], {cwd: root, encoding: 'utf8'}).trim();
  git('init', '-q');
  git('add', '--all');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  await assert.rejects(prepareWindowsWorkerForLocalChecks(root, head, head, {
    locate: () => ({id: 71, digest}), download: () => Buffer.from('other archive'),
  }), /archive digest mismatch/u);
  assert.deepEqual(await fs.readdir(inputDirectory), ['PrivateProcess.cpp']);
  await assert.rejects(fs.stat(path.join(root, '.git/trelio-windows-worker-cache')), {code: 'ENOENT'});

  const existing = path.join(inputDirectory, 'bin');
  await fs.mkdir(existing);
  const metadataPath = path.join(existing, 'metadata.json');
  await fs.writeFile(metadataPath, 'incomplete manual input');
  await assert.rejects(prepareWindowsWorkerForLocalChecks(root, head, head, {
    locate: () => assert.fail('Unknown existing input must not be replaced'),
  }), /Existing Windows worker in bin\/ failed validation/u);
  assert.equal(await fs.readFile(metadataPath, 'utf8'), 'incomplete manual input');
});
