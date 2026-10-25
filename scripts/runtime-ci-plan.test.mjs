import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRuntimeCiDiff, planRuntimeCi, readRuntimeCiPlan, selectRuntimeCiRun,
  verifyRuntimeCiGate, requiredRuntimeCiJobs, ASSISTANT_CI_TESTS } from './runtime-ci-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40);
const sourcePath = 'host-runtime/scripts/trelio-assistant-coordinator.mjs';
const entryPath = 'host-runtime/scripts/trelio-assistant-entry.mjs';
const modified = name => ({path: name, status: 'M', oldMode: '100644', newMode: '100644', oldOid: baseSha, newOid: headSha});
const plan = (changes = [modified(sourcePath)], readSource = () => 'import fs from "node:fs";\nconst value = 1;') =>
  planRuntimeCi({baseSha, headSha, changes, readSource});
const jobsFor = profile => requiredRuntimeCiJobs(profile).map((name, index) =>
  ({id: index + 1, run_id: 50, run_attempt: 2, head_sha: headSha, name, status: 'completed', conclusion: 'success'}));
const setup = (selected = plan()) => ({receipt: {...selected, runId: 50, runAttempt: 2, event: 'pull_request', pullRequestNumber: 7}, recomputedPlan: selected,
  selection: {runId: 50, runAttempt: 2, headSha, event: 'pull_request'},
  jobsPages: [{jobs: jobsFor(selected.profile), total_count: requiredRuntimeCiJobs(selected.profile).length}]});

test('closed assistant code/tests plus non-runtime maintainer docs select seven real native jobs', () => {
  const selected = plan([modified(sourcePath), modified('tests/trelio-assistant-coordinator.test.mjs'),
    modified('AGENTS.md'), modified('README.md'), modified('docs/assistant-scheduler.md')]);
  assert.equal(selected.profile, 'assistant-orchestration');
  assert.equal(selected.requiredJobs.length, 7);
  for (const name of ['Windows runtime and private ACL', 'Native Windows private worker (arm64)',
    'Build native Windows private worker', 'Runtime tests (macos-latest)', 'Runtime tests (ubuntu-latest)'])
    assert.ok(selected.requiredJobs.includes(name));
  assert.equal(selected.requiredJobs.some(name => name.startsWith('Native visual browser')), false);
  assert.ok(ASSISTANT_CI_TESTS.includes('tests/trelio-assistant-transport.test.mjs'));
  assert.ok(ASSISTANT_CI_TESTS.includes('tests/trelio-hook-signed-chain.test.mjs'));
  assert.ok(ASSISTANT_CI_TESTS.includes('tests/trelio-workspace-action-process.test.mjs'));
  assert.ok(!ASSISTANT_CI_TESTS.includes('tests/trelio-runtime-session-timeout.test.mjs'));
  for (const name of ASSISTANT_CI_TESTS) assert.ok(fs.statSync(path.join(root, name)).isFile(), name);
});

test('unknown/shared/native/crypto/hook/transport/CI/runtime instructions always retain full gate', () => {
  for (const name of ['host-runtime/scripts/trelio-assistant-transport.mjs', 'host-runtime/scripts/trelio-assistant-hook.mjs',
    'host-runtime/scripts/trelio-assistant-private.mjs', 'host-runtime/scripts/trelio-company-encryption.mjs',
    'host-runtime/scripts/trelio-workspace.mjs', 'host-runtime/scripts/native-private-process/PrivateProcess.cpp',
    'host-runtime/scripts/instructions.md', 'host-runtime/scripts/visual-browser-dependencies/package-lock.json',
    'scripts/runtime-ci-plan.mjs', '.github/workflows/runtime-tests.yml', '.github/scripts/fixture.ps1',
    'package-lock.json', 'tests/test-layout.mjs', 'unclassified-file']) {
    const selected = plan([modified(sourcePath), modified(name)]);
    assert.equal(selected.profile, 'full', name);
    assert.equal(selected.requiredJobs.length, 11, name);
  }
  for (const changes of [[], [modified('AGENTS.md')], [modified('docs/assistant-scheduler.md')],
    [modified('tests/trelio-assistant-coordinator.test.mjs')]]) assert.equal(plan(changes).profile, 'full');
});

test('any structural change or changed import is full, even with an allowlisted destination', () => {
  for (const status of ['A', 'D', 'R', 'C', 'T', 'U']) assert.equal(plan([{...modified(sourcePath), status}]).profile, 'full');
  assert.equal(plan([{...modified(sourcePath), newMode: '100755'}]).profile, 'full');
  assert.equal(plan([{...modified(sourcePath), oldMode: '120000'}]).profile, 'full');
  for (const after of ['import fs from "node:path";\nconst value=1;', 'import fs from "node:fs";\nawait import("new-security-module");']) {
    assert.equal(plan(undefined, revision => revision === baseSha ? 'import fs from "node:fs";\nconst value=1;' : after).profile, 'full');
  }
});

test('mixed entry permits only the uniquely anchored lifecycle forwarding block, not nearby authority', () => {
  const action = '    const action={...plan.localAction,parameters:{...plan.localAction.parameters,\n';
  const end = '    let nativeReason,nativeHealthCause,nativeCommandPolicyCause;';
  const before = `import fs from 'node:fs';\nassertSameIdentity();\n${action}      taskOutcome:'no_status_change',\n    }};\n${end}\nconsumeProof();`;
  const after = before.replace('no_status_change', 'validated_lifecycle_outcome');
  const choose = next => plan([modified(entryPath)], revision => revision === baseSha ? before : next);
  assert.equal(choose(after).profile, 'assistant-orchestration');
  for (const next of [after.replace('assertSameIdentity();', ''), after.replace('consumeProof();', ''),
    after + end, after + action, after.replace(action, ''), after.replace(end, ''),
    after.replace(end, '    anotherStatement();\n' + end)]) assert.equal(choose(next).profile, 'full');
});

test('current production entry accepts a lifecycle-only field fix while retaining its complete authority and imports', () => {
  const before = fs.readFileSync(path.join(root, entryPath), 'utf8');
  const after = before.replace("taskOutcome:'no_status_change'", "taskOutcome:'fixture_lifecycle_outcome'");
  assert.notEqual(before, after);
  const selected = plan([modified(entryPath)], revision => revision === baseSha ? before : after);
  assert.equal(selected.profile, 'assistant-orchestration');
  const outside = after.replace('const config=host.configurationDirectory', 'const config=otherConfigurationDirectory');
  assert.notEqual(outside, after);
  assert.equal(plan([modified(entryPath)], revision => revision === baseSha ? before : outside).profile, 'full');
});

test('raw diff requires complete bounded modes, IDs and NUL records, never a partial path inventory', () => {
  const raw = `:100644 100644 ${baseSha} ${headSha} M\0${sourcePath}\0`;
  assert.deepEqual(parseRuntimeCiDiff(raw), [modified(sourcePath)]);
  assert.deepEqual(parseRuntimeCiDiff(''), []);
  for (const bad of [raw.slice(0, -1), raw + 'partial', raw.replace('100644', 'bad'), raw.replace(sourcePath, '../escape'),
    raw.replace(sourcePath, 'tests/line\nname'), 'x'.repeat(4 * 1024 * 1024 + 1)]) assert.throws(() => parseRuntimeCiDiff(bad));
});

test('complete Git tree diff sees hidden shared changes, rename/delete/mode and stale branch base', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-ci-diff-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const git = (...args) => {const result = spawnSync('git', ['-C', directory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();};
  const write = (name, text) => {fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive: true}); fs.writeFileSync(path.join(directory, name), text);};
  const commit = message => {git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message); return git('rev-parse', 'HEAD');};
  git('init', '-q'); write(sourcePath, 'import fs from "node:fs";\nconst value=1;');
  write('host-runtime/scripts/trelio-workspace.mjs', 'shared-old'); const base = commit('base');
  write(sourcePath, 'import fs from "node:fs";\nconst value=2;'); const narrow = commit('assistant');
  assert.equal(readRuntimeCiPlan({repository: directory, baseSha: base, headSha: narrow}).profile, 'assistant-orchestration');
  // Real Git trace exits successfully while emitting metadata on stderr. The
  // planner must refuse that incomplete channel, not silently certify a diff.
  const previousTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = '1';
  try {
    assert.throws(() => readRuntimeCiPlan({repository: directory, baseSha: base, headSha: narrow}), /complete CI Git evidence/u);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousTrace;
  }
  write('host-runtime/scripts/trelio-workspace.mjs', 'shared-new'); const broad = commit('shared');
  assert.equal(readRuntimeCiPlan({repository: directory, baseSha: base, headSha: broad}).profile, 'full');
  // Comparing base..head, rather than a merge-base/path-filter, also sees a
  // shared base change absent from the proposed old branch tree.
  assert.equal(readRuntimeCiPlan({repository: directory, baseSha: broad, headSha: narrow}).profile, 'full');
  fs.renameSync(path.join(directory, sourcePath), path.join(directory, 'renamed.mjs')); const renamed = commit('rename');
  assert.equal(readRuntimeCiPlan({repository: directory, baseSha: broad, headSha: renamed}).profile, 'full');
  assert.throws(() => readRuntimeCiPlan({repository: directory, baseSha: '0'.repeat(40), headSha: renamed}));
});

test('tag gate accepts exact narrow seven successes and full eleven, never workflow success alone', () => {
  for (const profile of [plan(), plan([modified('scripts/runtime-ci-plan.mjs')])]) {
    const state = setup(profile);
    assert.equal(verifyRuntimeCiGate(state).profile, profile.profile);
    for (let index = 0; index < state.jobsPages[0].jobs.length; index++) {
      for (const conclusion of ['skipped', 'failure', 'cancelled', null]) {
        const changed = structuredClone(state); changed.jobsPages[0].jobs[index].conclusion = conclusion;
        assert.throws(() => verifyRuntimeCiGate(changed), `${profile.profile}/${index}/${conclusion}`);
      }
    }
  }
  const narrow = setup(); narrow.jobsPages[0].jobs.push({id: 99, run_id: 50, run_attempt: 2, head_sha: headSha,
    name: 'Native visual browser', status: 'completed', conclusion: 'skipped'});
  narrow.jobsPages[0].total_count++;
  assert.equal(verifyRuntimeCiGate(narrow).profile, 'assistant-orchestration');
});

test('tag gate rejects forged diff/profile, stale run/attempt/base/head and incomplete/duplicate jobs', () => {
  const variants = [
    state => state.receipt.runId++, state => state.receipt.runAttempt++,
    state => {state.receipt.baseSha = headSha;}, state => {state.receipt.headSha = baseSha;},
    state => {state.receipt.changesSha256 = '0'.repeat(64);}, state => {state.receipt.profile = 'full';},
    state => {state.receipt.requiredJobs = [];}, state => {state.receipt.extra = true;},
    state => {state.selection.event = 'push';}, state => {state.receipt.event = 'push';},
    state => {state.receipt.pullRequestNumber = 0;},
    state => {state.jobsPages[0].total_count++;}, state => {state.jobsPages[0].jobs.pop();},
    state => {state.jobsPages[0].jobs[1].id = state.jobsPages[0].jobs[0].id;},
    state => {state.jobsPages[0].jobs[1].name = state.jobsPages[0].jobs[0].name;},
    state => {state.jobsPages[0].jobs[0].status = 'in_progress';},
    state => {state.jobsPages[0].jobs[0].run_id++;}, state => {state.jobsPages[0].jobs[0].run_attempt++;},
    state => {state.jobsPages[0].jobs[0].head_sha = baseSha;},
  ];
  for (const alter of variants) {const state = setup(); alter(state); assert.throws(() => verifyRuntimeCiGate(state));}
  const pages = setup(), jobs = pages.jobsPages[0].jobs;
  pages.jobsPages = [{total_count: jobs.length, jobs: jobs.slice(0, 3)}, {total_count: jobs.length, jobs: jobs.slice(3)}];
  assert.equal(verifyRuntimeCiGate(pages).runId, 50);
  pages.jobsPages[1].total_count++;
  assert.throws(() => verifyRuntimeCiGate(pages));
});

test('run selection needs exact successful PR source and repository even when merged PR metadata is empty', () => {
  const run = {id: 50, run_attempt: 2, head_sha: headSha, event: 'pull_request', status: 'completed', conclusion: 'success',
    repository: {full_name: 'trelio-ru/agent-workspaces-runtime'}, pull_requests: [{number: 7, base: {sha: baseSha}, head: {sha: headSha}}]};
  const target = {headSha, repository: run.repository.full_name};
  assert.deepEqual(selectRuntimeCiRun([{workflow_runs: [run]}], target), setup().selection);
  assert.deepEqual(selectRuntimeCiRun([{workflow_runs: [{...run, pull_requests: []}]}], target), setup().selection);
  for (const changed of [{head_sha: baseSha}, {event: 'push'}, {status: 'in_progress'}, {conclusion: 'failure'},
    {repository: {full_name: 'other/repository'}}, {run_attempt: 0}, {id: 0}])
    assert.throws(() => selectRuntimeCiRun([{workflow_runs: [{...run, ...changed}]}], target));
});

test('actual CLI creates and verifies an exact Git/run receipt; tampered source evidence fails without a release call', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-ci-receipt-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim();
  const output = path.join(directory, 'ci-plan.json'), selectionPath = path.join(directory, 'selection.json');
  const jobsPath = path.join(directory, 'jobs.json'), outputs = path.join(directory, 'outputs');
  const invoke = args => spawnSync(process.execPath, [path.join(root, 'scripts/runtime-ci-plan.mjs'), ...args], {
    cwd: root, encoding: 'utf8', env: {...process.env, GITHUB_RUN_ID: '50', GITHUB_RUN_ATTEMPT: '2',
      GITHUB_EVENT_NAME: 'pull_request', PR_NUMBER: '7', GITHUB_OUTPUT: outputs},
  });
  let result = invoke(['create', '--base', head, '--head', head, '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(receipt.profile, 'full'); assert.match(fs.readFileSync(outputs, 'utf8'), /profile=full/u);
  fs.writeFileSync(selectionPath, JSON.stringify({runId: 50, runAttempt: 2, headSha: head, event: 'pull_request'}));
  const jobs = jobsFor('full').map(job => ({...job, head_sha: head}));
  fs.writeFileSync(jobsPath, JSON.stringify([{total_count: jobs.length, jobs}]));
  const args = ['verify', '--plan', output, '--selection', selectionPath, '--jobs', jobsPath, '--head', head];
  result = invoke(args); assert.equal(result.status, 0, result.stderr);
  receipt.changesSha256 = '0'.repeat(64); fs.writeFileSync(output, JSON.stringify(receipt));
  result = invoke(args); assert.equal(result.status, 1); assert.match(result.stderr, /complete exact Git diff/u);
});

test('workflow connects the planner, exact attempt artifact verification and selected Windows native boundaries', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/runtime-tests.yml'), 'utf8');
  assert.match(workflow, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(workflow, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /attempts\/\$PR_RUN_ATTEMPT\/jobs\?per_page=100/u);
  assert.match(workflow, /runtime-ci-plan\.mjs verify --plan/u);
  assert.match(workflow, /runtime-ci-plan\.mjs assistant-tests/u);
  assert.match(workflow, /Run Windows hook timeout regressions\n        if: needs\.ci-plan\.outputs\.profile == 'full'/u);
  for (const name of ['Run Windows assistant runtime and private storage regressions',
    'Verify signed runtime hook through the complete Windows shell chain',
    'Run Windows Codex conversation metadata tests', 'Run native Windows private process regressions',
    'Run Windows ACL regression as a standard user']) {
    const block = workflow.split(`      - name: ${name}\n`)[1]?.split('      - name: ')[0];
    assert.ok(block, name); assert.ok(!block.includes("profile == 'full'"), name);
  }
});
