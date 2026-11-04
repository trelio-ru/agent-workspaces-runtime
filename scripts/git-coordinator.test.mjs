import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {queue, assertPush, recover, status} from './git-coordinator.mjs';
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
  for (const name of ['git-coordinator.mjs', 'git-background.mjs', 'assert-coordination.mjs']) fs.copyFileSync(path.join(source, name), path.join(main, 'scripts', name));
  fs.writeFileSync(path.join(main, 'git-coordination.json'), JSON.stringify({schemaVersion: 1, repository: 'fixture/runtime',
    canonicalKey: 'trelio.canonicalMainWorktree', mainMutex: 'main.lock', verify: ['node', 'scripts/ci.mjs'], transport: ['node', 'scripts/push.mjs']}));
  fs.writeFileSync(path.join(main, 'scripts/ci.mjs'), `import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim();
fs.appendFileSync(${JSON.stringify(path.join(root, 'events'))},branch+'\\n');
if(fs.existsSync(${JSON.stringify(path.join(root, 'fail'))}))throw Error('Synthetic executed CI failure');
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
    for (const entry of queue(main)) {
      try { process.kill(-entry.pgid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await delay(100); fs.rmSync(root, {recursive: true, force: true});
  });
  const branch = name => {
    const cwd = path.join(root, name);
    command(main, 'worktree', 'add', '-b', 'codex/' + name, cwd, 'origin/main');
    fs.writeFileSync(path.join(cwd, name + '.txt'), name);
    command(cwd, 'add', '.'); command(cwd, 'commit', '-m', name);
    return cwd;
  };
  const launch = (cwd, ...args) => {
    const child = spawn(process.execPath, [path.join(source, 'git-coordinator.mjs'), ...args], {cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    processes.push(child); let output = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    const done = new Promise(resolve => child.on('close', code => resolve({code, output})));
    return {child, done};
  };
  return {root, main, remote, branch, launch, start: (cwd, ...args) => launch(cwd, '--worker', ...args),
    events: () => fs.existsSync(path.join(root, 'events')) ? fs.readFileSync(path.join(root, 'events'), 'utf8').trim().split('\n') : []};
}

test('background admission detaches and concurrent callers reuse one owner through FIFO completion', async t => {
  const f = fixture(t), one = f.branch('one'), two = f.branch('two');
  const background = async cwd => {
    const result = await f.launch(cwd, '--background').done;
    assert.equal(result.code, 0, result.output); return JSON.parse(result.output);
  };
  const [first, duplicate] = await Promise.all([background(one), background(one)]);
  assert.equal(first.id, duplicate.id); assert.equal(queue(one).length, 1);
  await until(() => f.events().length === 1);
  assert.equal(fs.statSync(first.logPath).mode & 0o777, 0o600);
  const original = command(two, 'rev-parse', 'HEAD'), second = await background(two);
  assert.equal(status(f.main, second.id).state, 'waiting');
  fs.writeFileSync(path.join(f.root, 'release'), 'go');
  await until(() => status(f.main, second.id).state === 'succeeded');
  assert.deepEqual(f.events(), ['codex/one', 'codex/two']);
  assert.equal(status(f.main, second.id).sourceSha, original);
  assert.equal(status(f.main, second.id).sha, command(two, 'rev-parse', 'HEAD'));
  assert.equal(status(f.main, first.id).outcome, 'integrated');
  const observed = await f.launch(f.main, '--status', second.id).done;
  assert.equal(JSON.parse(observed.output).state, 'succeeded');
  assert.equal(status(f.main, '999999999999').state, 'unknown');
});

test('background failure retains a private terminal result without assuming ticket disappearance is success', async t => {
  const f = fixture(t), cwd = f.branch('failure'), before = command(f.main, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.root, 'fail'), 'fail CI');
  const launched = await f.launch(cwd, '--background').done;
  assert.equal(launched.code, 0, launched.output);
  const {id} = JSON.parse(launched.output);
  await until(() => status(f.main, id).state === 'failed');
  assert.deepEqual(queue(cwd), []); assert.equal(command(f.main, 'rev-parse', 'HEAD'), before);
  const file = path.join(f.main, '.git/trelio-git-coordination/results', id + '.json');
  fs.chmodSync(file, 0o644); assert.throws(() => status(f.main, id), /Unsafe coordination/);
  fs.chmodSync(file, 0o600);
  const saved = fs.readFileSync(file); fs.writeFileSync(file, '{}');
  assert.throws(() => status(f.main, id), /Invalid coordination result/); fs.writeFileSync(file, saved);
});

test('killed background owner stays fenced until exact dead-group recovery, without replacement', async t => {
  const f = fixture(t), cwd = f.branch('one');
  const launched = await f.launch(cwd, '--background').done;
  assert.equal(launched.code, 0, launched.output);
  const entry = JSON.parse(launched.output);
  await until(() => f.events().length === 1);
  process.kill(entry.pid, 'SIGKILL');
  await until(() => status(cwd, entry.id).state === 'recovery_required');
  await assert.rejects(recover(cwd, entry.id), /live owner/);
  const duplicate = await f.launch(cwd, '--background').done;
  assert.notEqual(duplicate.code, 0); assert.match(duplicate.output, /needs recovery/);
  process.kill(-entry.pgid, 'SIGKILL'); await delay(100);
  await recover(cwd, entry.id);
  assert.equal(status(f.main, entry.id).state, 'recovered');
});

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

test('ordinary predecessor exit between ticket read and process inventory is a handoff, not a dead owner', {timeout: 25_000}, async t => {
  const f = fixture(t), one = f.branch('one'), two = f.branch('two');
  const first = f.start(one); await until(() => f.events().length === 1);
  const bin = path.join(f.root, 'bin'), observed = path.join(f.root, 'handoff-observed.json');
  fs.mkdirSync(bin);
  // This fixture-only ps wrapper makes the real race deterministic. Only the
  // waiting synthetic worker releases its own predecessor's blocked CI. With
  // the production mutex held, predecessor settlement must wait for this short
  // observation; without it the ticket disappears before the process snapshot.
  // No process is killed and no production queue or repository is accessed.
  const helper = path.join(bin, 'handoff.mjs');
  fs.writeFileSync(helper, `import fs from 'node:fs'; import path from 'node:path';
const directory=${JSON.stringify(path.join(f.main, '.git', 'trelio-git-coordination'))};
const observed=${JSON.stringify(observed)};
const rows=fs.existsSync(directory)?fs.readdirSync(directory).filter(name=>/^\\d{12}\\.json$/u.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'))).sort((a,b)=>a.id.localeCompare(b.id)):[];
if(rows.length===2&&rows[1].pid===Number(process.argv[2])&&!fs.existsSync(observed)){
  fs.writeFileSync(observed,JSON.stringify({triggered:true}),{flag:'wx'});
  fs.writeFileSync(${JSON.stringify(path.join(f.root, 'release'))},'go');
  const predecessor=path.join(directory,rows[0].id+'.json'), deadline=Date.now()+1500;
  while(fs.existsSync(predecessor)&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  const removed=!fs.existsSync(predecessor);
  if(removed) await new Promise(resolve=>setTimeout(resolve,100));
  fs.writeFileSync(observed,JSON.stringify({triggered:true,removedBeforeInventory:removed}));
}
`, {mode: 0o600});
  // exec preserves the actual ps PID; a second resident wrapper process would
  // itself look like a live descendant to the coordinator's strict cleanup.
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh
"${process.execPath}" "${helper}" "$PPID" || exit $?
exec /bin/ps "$@"
`, {mode: 0o700});
  const originalPath = process.env.PATH;
  let second;
  try { process.env.PATH = bin + path.delimiter + originalPath; second = f.start(two); }
  finally { process.env.PATH = originalPath; }
  // A wrapper/setup failure must not leave our first synthetic CI blocked.
  second.done.finally(() => fs.writeFileSync(path.join(f.root, 'release'), 'go'));
  assert.equal((await first.done).code, 0);
  const result = await second.done; assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(fs.readFileSync(observed, 'utf8')),
    {triggered: true, removedBeforeInventory: false}, 'predecessor removal waits for the same inventory mutex');
  assert.deepEqual(f.events(), ['codex/one', 'codex/two']);
  assert.deepEqual(queue(two), []);
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

// A long wait for a LIVE owner must not spend the short allowance for a later
// unpublished owner file. A normal mkdir/write or unlink/rmdir handoff has a
// brief ownerless interval, independently of how long the queue already waited.
// Exercise that interval in a disposable real Git repository, not the live lock.
for (const mode of ['late_publication', 'unchanged_ownerless']) test(`main mutex ownerless allowance belongs to its current directory (${mode})`, {timeout: 25_000}, async t => {
  const f = fixture(t), cwd = f.branch('ownerless'), directory = path.join(f.main, '.git', 'main.lock');
  const ready = path.join(f.root, 'ready'), gap = path.join(f.root, 'gap'), release = path.join(f.root, 'release');
  if (mode === 'late_publication') {
    const script = path.join(f.root, 'owner.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs'; import os from 'node:os';
const directory=${JSON.stringify(directory)}, owner=directory+'/owner';
const value='operation=synthetic ownerless handoff\\npid='+process.pid+'\\nhost='+os.hostname()+'\\n';
fs.mkdirSync(directory,{mode:0o700});fs.writeFileSync(owner,value,{mode:0o600});
fs.writeFileSync(${JSON.stringify(ready)},'ready');
while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));
fs.unlinkSync(owner);fs.writeFileSync(${JSON.stringify(gap)},'gap');
await new Promise(r=>setTimeout(r,700));
fs.writeFileSync(owner,value,{mode:0o600});
await new Promise(r=>setTimeout(r,300));
fs.unlinkSync(owner);fs.rmdirSync(directory);
`, {mode: 0o600});
    const owner = spawn(process.execPath, [script], {stdio: 'ignore'});
    const done = new Promise(resolve => owner.once('close', resolve));
    t.after(async () => { owner.kill(); await done; });
    await until(() => fs.existsSync(ready));
  } else fs.mkdirSync(directory, {mode: 0o700});
  const identity = fs.lstatSync(directory, {bigint: true});
  const worker = f.start(cwd);
  if (mode === 'late_publication') {
    // The old implementation compared an ownerless observation against the
    // WHOLE mutex wait, so this later subsecond interval immediately failed.
    await delay(5500);fs.writeFileSync(release, 'go');
    await until(() => fs.existsSync(gap));
  }
  const result = await worker.done;
  if (mode === 'late_publication') {
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(f.events(), ['codex/ownerless']);
    assert.deepEqual(queue(cwd), []);
    assert.equal(fs.existsSync(directory), false);
  } else {
    assert.notEqual(result.code, 0);assert.match(result.output, /Main mutex has no owner/);
    const current = fs.lstatSync(directory, {bigint: true});
    assert.equal(current.ino, identity.ino);assert.equal(current.birthtimeNs, identity.birthtimeNs);
    assert.equal(fs.existsSync(path.join(directory, 'owner')), false);
    assert.deepEqual(f.events(), [], 'an unchanged ownerless claim never permits CI or lock removal');
  }
});

// The occupied short mutex may disappear normally AFTER its owner file is
// read but BEFORE the process snapshot. Make that exact observation ordering
// deterministic; no production process, queue or lock is involved.
for(const mode of ['normal_release','normal_replacement','unchanged_dead'])test(`main mutex owner observation keeps its path identity (${mode})`, {timeout:25000},async t=>{
 const f=fixture(t),cwd=f.branch('mutex'),directory=path.join(f.main,'.git','main.lock');
 const ready=path.join(f.root,'owner-ready'),release=path.join(f.root,'owner-release'),observed=path.join(f.root,'mutex-observed');
 const activateSecond=path.join(f.root,'second-activate'),readySecond=path.join(f.root,'second-ready'),releaseSecond=path.join(f.root,'second-release');
 const ownerScript=path.join(f.root,'owner.mjs');
 fs.writeFileSync(ownerScript,`import fs from 'node:fs';import os from 'node:os';
const directory=${JSON.stringify(directory)},second=process.argv[2]==='second';
const release=second?${JSON.stringify(releaseSecond)}:${JSON.stringify(release)};
if(second)while(!fs.existsSync(${JSON.stringify(activateSecond)}))await new Promise(r=>setTimeout(r,5));
fs.mkdirSync(directory,{mode:0o700});fs.writeFileSync(directory+'/owner','operation=synthetic mutex\\npid='+process.pid+'\\nhost='+os.hostname()+'\\n',{mode:0o600});
fs.writeFileSync(second?${JSON.stringify(readySecond)}:${JSON.stringify(ready)},'ready');
if(${JSON.stringify(mode)}==='unchanged_dead')process.exit(0);
while(!fs.existsSync(release))await new Promise(r=>setTimeout(r,5));
fs.unlinkSync(directory+'/owner');fs.rmdirSync(directory);
`,{mode:0o600});
 const owner=spawn(process.execPath,[ownerScript],{stdio:'ignore'}),ownerDone=new Promise(resolve=>owner.once('close',resolve));
 let successor,successorDone;
 if(mode==='normal_replacement'){
  successor=spawn(process.execPath,[ownerScript,'second'],{stdio:'ignore'});
  successorDone=new Promise(resolve=>successor.once('close',resolve));
 }
 t.after(async()=>{try{owner.kill();successor?.kill();}catch{}await ownerDone;if(successorDone)await successorDone;});
 await until(()=>fs.existsSync(ready));
 const contents=fs.readFileSync(path.join(directory,'owner'),'utf8');
 if(mode==='unchanged_dead')await ownerDone;
 const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
 const helper=path.join(bin,'observe.mjs');
 fs.writeFileSync(helper,`import fs from 'node:fs';
const observed=${JSON.stringify(observed)},release=${JSON.stringify(release)},directory=${JSON.stringify(directory)},counter=observed+'.count';
const activateSecond=${JSON.stringify(activateSecond)},readySecond=${JSON.stringify(readySecond)},releaseSecond=${JSON.stringify(releaseSecond)};
const count=(fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0)+1;fs.writeFileSync(counter,String(count));
// The first inventory verifies the worker's own isolated process group.
// The SECOND runs only after the occupied mutex owner has been read.
if(count===2&&!fs.existsSync(observed)){
 fs.writeFileSync(observed,'observed',{flag:'wx'});
 if(${JSON.stringify(mode)}!=='unchanged_dead'){
  fs.writeFileSync(release,'go');const deadline=Date.now()+2000;
  while(fs.existsSync(directory)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  if(fs.existsSync(directory))throw Error('synthetic owner did not release its own mutex');
  if(${JSON.stringify(mode)}==='normal_replacement'){
   fs.writeFileSync(activateSecond,'go');
   while(!fs.existsSync(readySecond)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
   if(!fs.existsSync(readySecond))throw Error('synthetic successor did not publish its own mutex');
  }
  await new Promise(r=>setTimeout(r,100));
 }
}else if(count===3&&${JSON.stringify(mode)}==='normal_replacement'){
 fs.writeFileSync(releaseSecond,'go');const deadline=Date.now()+2000;
 while(fs.existsSync(directory)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 if(fs.existsSync(directory))throw Error('synthetic successor did not release its own mutex');
 await new Promise(r=>setTimeout(r,100));
}

`,{mode:0o600});
 fs.writeFileSync(path.join(bin,'ps'),`#!/bin/sh\n"${process.execPath}" "${helper}" || exit $?\nexec /bin/ps "$@"\n`,{mode:0o700});
 const originalPath=process.env.PATH;let worker;
 try{process.env.PATH=bin+path.delimiter+originalPath;worker=f.start(cwd);}finally{process.env.PATH=originalPath;}
 const result=await worker.done;assert.equal(fs.readFileSync(observed,'utf8'),'observed');
 if(mode!=='unchanged_dead'){
  assert.equal(result.code,0,result.output);assert.equal(await ownerDone,0);if(successorDone)assert.equal(await successorDone,0);assert.deepEqual(f.events(),['codex/mutex']);
  assert.equal(fs.existsSync(directory),false);assert.deepEqual(queue(cwd),[]);
 }else{
  assert.notEqual(result.code,0);assert.match(result.output,/owner is not confirmed live/);
  assert.equal(fs.readFileSync(path.join(directory,'owner'),'utf8'),contents,'unchanged dead mutex is never stolen or cleared');
  assert.deepEqual(f.events(),[]);
 }
});
