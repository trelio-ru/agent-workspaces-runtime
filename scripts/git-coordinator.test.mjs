import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {queue, assertPush, recover} from './git-coordinator.mjs';
import {validateJobs, verifyHosted} from './git-hosted-ci.mjs';

const source = fileURLToPath(new URL('.', import.meta.url));
const command = (cwd, ...args) => {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\n$/u, '');
};
const until = async predicate => {
  const deadline = Date.now() + 25_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture progress deadline'); await delay(50); }
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-coordination-'));
  const main = path.join(root, 'main'), remote = path.join(root, 'remote.git');
  fs.mkdirSync(main);
  command(root, 'init', '--bare', '--initial-branch=main', remote);
  command(main, 'init', '--initial-branch=main');
  command(main, 'config', 'user.name', 'Coordination fixture');
  command(main, 'config', 'user.email', 'fixture@example.invalid');
  fs.mkdirSync(path.join(main, 'scripts'));
  for (const name of ['git-coordinator.mjs', 'assert-coordination.mjs']) fs.copyFileSync(path.join(source, name), path.join(main, 'scripts', name));
  fs.writeFileSync(path.join(main, 'git-coordination.json'), JSON.stringify({schemaVersion: 1, repository: 'fixture/runtime',
    canonicalKey: 'trelio.canonicalMainWorktree', mainMutex: 'main.lock', verify: ['node', 'scripts/ci.mjs'], transport: ['node', 'scripts/push.mjs']}));
  fs.writeFileSync(path.join(main, 'scripts/ci.mjs'), `import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim();
fs.appendFileSync(${JSON.stringify(path.join(root, 'events'))},branch+'\\n');
if(branch==='codex/one') while(!fs.existsSync(${JSON.stringify(path.join(root, 'release'))})) await new Promise(r=>setTimeout(r,30));\n`);
  fs.writeFileSync(path.join(main, 'scripts/push.mjs'), `import {assertPush} from './git-coordinator.mjs'; import {execFileSync} from 'node:child_process';
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(); const tag=process.argv[3]??''; assertPush(process.cwd(),sha,tag);
execFileSync('git',['push',...(tag?['--atomic']:[]),'origin','HEAD:main',...(tag?['refs/tags/'+tag]:[])],{stdio:'inherit'});
execFileSync('git',['-C',${JSON.stringify(main)},'merge','--ff-only',sha],{stdio:'inherit'});\n`);
  command(main, 'add', '.'); command(main, 'commit', '-m', 'Основа');
  command(main, 'remote', 'add', 'origin', remote); command(main, 'push', '-u', 'origin', 'main');
  command(main, 'config', 'trelio.canonicalMainWorktree', main);
  const processes = [];
  t.after(async () => {
    // These are only process groups created by this synthetic fixture.
    for (const child of processes) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await delay(100); fs.rmSync(root, {recursive: true, force: true});
  });
  const branch = name => {
    const cwd = path.join(root, name);
    command(main, 'worktree', 'add', '-b', 'codex/' + name, cwd, 'origin/main');
    fs.writeFileSync(path.join(cwd, name + '.txt'), name);
    command(cwd, 'add', '.'); command(cwd, 'commit', '-m', name);
    return cwd;
  };
  const start = (cwd, ...args) => {
    const child = spawn(process.execPath, [path.join(source, 'git-coordinator.mjs'), '--worker', ...args], {cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    processes.push(child); let output = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    const done = new Promise(resolve => child.on('close', code => resolve({code, output})));
    return {child, done};
  };
  return {root, main, remote, branch, start, events: () => fs.existsSync(path.join(root, 'events')) ? fs.readFileSync(path.join(root, 'events'), 'utf8').trim().split('\n') : []};
}

test('real linked worktrees serialize preparation/CI/push and rebase only after predecessor', async t => {
  const f = fixture(t), one = f.branch('one'), two = f.branch('two');
  const first = f.start(one); await until(() => f.events().length === 1);
  const second = f.start(two); await until(() => queue(one).length === 2);
  assert.deepEqual(f.events(), ['codex/one']);
  assert.throws(() => assertPush(two, command(two, 'rev-parse', 'HEAD')), /FIFO owner/);
  fs.writeFileSync(path.join(f.root, 'release'), 'go');
  assert.equal((await first.done).code, 0);
  const result = await second.done; assert.equal(result.code, 0, result.output);
  assert.deepEqual(f.events(), ['codex/one', 'codex/two']);
  assert.equal(command(two, 'show', 'HEAD:one.txt'), 'one');
  assert.deepEqual(queue(two), []);
});

test('an already occupied version fails before CI, with no source/tag overwrite', async t => {
  const f = fixture(t), cwd = f.branch('version');
  command(cwd, 'tag', 'v9.9.9'); command(cwd, 'push', 'origin', 'refs/tags/v9.9.9');
  const result = await f.start(cwd, '--tag', 'v9.9.9').done;
  assert.notEqual(result.code, 0); assert.match(result.output, /before CI/); assert.deepEqual(f.events(), []);
  assert.deepEqual(queue(cwd), []);
});

test('changed waiting candidate is retained without running its final CI', async t => {
  const f = fixture(t), one = f.branch('one'), two = f.branch('two');
  const first = f.start(one); await until(() => f.events().length === 1);
  const second = f.start(two); await until(() => queue(one).length === 2);
  fs.writeFileSync(path.join(two, 'extra.txt'), 'new commit'); command(two, 'add', '.'); command(two, 'commit', '-m', 'Изменить ожидающий SHA');
  fs.writeFileSync(path.join(f.root, 'release'), 'go'); await first.done;
  const result = await second.done;
  assert.notEqual(result.code, 0); assert.match(result.output, /source changed/); assert.deepEqual(f.events(), ['codex/one']);
  assert.equal(command(two, 'show', 'HEAD:extra.txt'), 'new commit');
});

test('recovery refuses live descendants after owner SIGKILL, then permits exact dead group', async t => {
  const f = fixture(t), one = f.branch('one'), running = f.start(one);
  await until(() => f.events().length === 1);
  const entry = queue(one)[0];
  await assert.rejects(recover(one, entry.id), /live owner/);
  process.kill(running.child.pid, 'SIGKILL'); await delay(100);
  await assert.rejects(recover(one, entry.id), /live owner/);
  process.kill(-running.child.pid, 'SIGKILL'); await running.done; await delay(100);
  await recover(one, entry.id); assert.deepEqual(queue(one), []);
});

test('hosted gate rejects missing/skipped required jobs, stale attempts and self-hosted', () => {
  const run = {id: 1, run_attempt: 2, head_sha: 'a'.repeat(40)};
  const job = {id: 3, run_id: 1, run_attempt: 2, head_sha: run.head_sha, name: 'Native Windows', status: 'completed', conclusion: 'success', runner_group_name: 'GitHub Actions'};
  const check = value => validateJobs(run, [{total_count: 1, jobs: [value]}], ['Native Windows']);
  check(job);
  for (const patch of [{run_attempt: 1}, {conclusion: 'skipped'}, {name: 'Unrelated'}, {runner_group_name: 'Private'}]) assert.throws(() => check({...job, ...patch}));
  assert.throws(() => validateJobs(run, [{total_count: 2, jobs: [job]}], ['Native Windows']));
});

test('already integrated release skips empty PR creation but still requires latest exact hosted proof', async t => {
  const f = fixture(t), cwd = f.main, sha = command(cwd, 'rev-parse', 'HEAD');
  // Only GitHub is synthetic. Real Git metadata identifies the exact integrated
  // SHA; the actual verifier still performs its complete CLI/API state machine.
  command(cwd, 'remote', 'set-url', 'origin', 'https://github.com/fixture/runtime.git');
  const bin = path.join(f.root, 'bin'), state = path.join(f.root, 'api-state.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const [verb, endpoint] = process.argv.slice(2);
if (verb !== 'api' || endpoint.includes('/pulls?')) process.exit(90);
const run = {id: 5, run_attempt: 2, head_sha: ${JSON.stringify(sha)}, event: 'pull_request',
  repository: {full_name: 'fixture/runtime'}, path: '.github/workflows/check.yml',
  status: 'completed', conclusion: s.mode === 'failed' ? 'failure' : 'success'};
let result;
if (endpoint.includes('/workflows/')) result = {total_count: s.mode === 'missing' ? 0 : 1,
  workflow_runs: s.mode === 'missing' ? [] : [run]};
else if (endpoint.includes('/jobs?')) result = {total_count: 1, jobs: [{id: 9, run_id: 5,
  run_attempt: 2, head_sha: run.head_sha, name: 'Required', status: 'completed',
  conclusion: 'success', runner_group_name: 'GitHub Actions'}]};
else if (endpoint.endsWith('/actions/runs/5')) result = run;
else process.exit(91);
process.stdout.write(JSON.stringify(result));
`, {mode: 0o700});
  const originalPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + originalPath;
  try {
    let validated = 0;
    const verify = () => verifyHosted(cwd, sha, [{file: 'check.yml', jobs: ['Required']}],
      {prepare: true, timeoutMs: 0, validate: () => { validated++; }});
    fs.writeFileSync(state, JSON.stringify({mode: 'success'}));
    await verify();
    assert.equal(validated, 1, 'repository-specific receipt validation is still mandatory');
    for (const mode of ['missing', 'failed']) {
      fs.writeFileSync(state, JSON.stringify({mode}));
      await assert.rejects(verify(), mode === 'missing' ? /incomplete/ : /gate failed/);
    }
    assert.equal(validated, 1, 'main equality cannot substitute for successful evidence');
  } finally { process.env.PATH = originalPath; }
});
