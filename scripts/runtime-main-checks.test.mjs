import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planMainChecks, readMainCheckSnapshot, sourceReferences} from './runtime-main-checks.mjs';
import {readRuntimeCiPlan} from './runtime-ci-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = files => new Map(Object.entries(files));
const plan = (paths, before, after = before) => planMainChecks(paths, {before, after});
const module = 'host-runtime/scripts/helper.mjs';
const unit = 'tests/helper.test.mjs';
const consumer = 'host-runtime/scripts/consumer.mjs';
const consumerTest = 'tests/consumer.test.mjs';
const source = {
  [module]: 'export const value = 1;',
  [unit]: "import {value} from '../host-runtime/scripts/helper.mjs';",
  [consumer]: "import {value} from './helper.mjs'; export const result = value;",
  [consumerTest]: "import {result} from '../host-runtime/scripts/consumer.mjs';",
  'tests/unrelated-client.test.mjs': "import {result} from '../host-runtime/scripts/consumer.mjs';",
};

// These synthetic modules model an actual export compatibility failure:
// helper's unit can stay green while the consumer still imports the old name.
// Main must exercise that nearest consumer without expanding through every
// unrelated client of the consumer. Full cross-module coverage stays release.
test('a helper with its own suite also selects the nearest proven consumer boundary', () => {
  const result = plan([module], snapshot(source));
  assert.deepEqual(result.tests, [consumerTest, unit]);
  assert.deepEqual(result.reasons[consumerTest], [`consumer:${module}->${consumer}`]);
  assert.equal(result.coordination, false);
});

test('nearest coverage follows untested intermediates and terminates cycles', () => {
  const files = snapshot({...source,
    [consumer]: "import {value} from './middle.mjs';",
    'host-runtime/scripts/middle.mjs': "import {value} from './helper.mjs'; import './consumer.mjs';",
  });
  assert.deepEqual(plan([module], files).tests, [consumerTest, unit]);
});

test('literal imports, exports, dynamic import and file URLs retain exact query-free inputs', () => {
  const refs = sourceReferences('tests/example.test.mjs', `
    import '../host-runtime/scripts/a.mjs?fixture=1';
    import {x} from '../host-runtime/scripts/b.mjs';
    export {x} from '../host-runtime/scripts/c.mjs';
    await import('../host-runtime/scripts/d.mjs#isolated');
    readFile(new URL('./fixtures/rows.json', import.meta.url,));
    await import(variable);
    await import('./fixtures/' + variable);
  `);
  assert.deepEqual([...refs.imports], ['host-runtime/scripts/a.mjs', 'host-runtime/scripts/b.mjs',
    'host-runtime/scripts/c.mjs', 'host-runtime/scripts/d.mjs']);
  assert.deepEqual([...refs.reads], ['tests/fixtures/rows.json']);
});

test('test helper imports and fixture URLs select the real consumer without runtime smokes', () => {
  const files = snapshot({
    'tests/rows.test.mjs': "import './fixtures/helper.mjs';",
    'tests/fixtures/helper.mjs': "readFile(new URL('./rows.json', import.meta.url));",
    'tests/fixtures/rows.json': '{}',
  });
  assert.deepEqual(plan(['tests/fixtures/rows.json'], files).tests, ['tests/rows.test.mjs']);
  assert.deepEqual(plan(['tests/fixtures/helper.mjs'], files).tests, ['tests/rows.test.mjs']);
});

test('text readers do not inherit imports of the source they inspect', () => {
  const files = snapshot({...source,
    'tests/text-only.test.mjs': "readFile(new URL('../host-runtime/scripts/consumer.mjs', import.meta.url));",
  });
  assert.ok(!plan([module], files).tests.includes('tests/text-only.test.mjs'));
  assert.ok(plan([consumer], files).tests.includes('tests/text-only.test.mjs'));
});

test('maintainer prose and ignore policy need only diff checks; changed tests run once', () => {
  assert.deepEqual(plan(['AGENTS.md', 'docs/runtime-ci.md', 'SECURITY.md', '.gitignore'], snapshot({})),
    {syntax: [], tests: [], dependencies: false, coordination: false, reasons: {}});
  assert.deepEqual(plan([unit, module], snapshot(source)).tests, [consumerTest, unit]);
});

test('deletion and rename keep consumers from both pinned snapshots', () => {
  const before = snapshot(source), after = snapshot({...source,
    'host-runtime/scripts/replacement.mjs': 'export const value = 2;',
    [unit]: "import {value} from '../host-runtime/scripts/replacement.mjs';",
  });
  after.delete(module);
  // The surviving consumer still imports the deleted path; that failure must
  // be detected rather than disappearing with the candidate's dependency map.
  assert.deepEqual(plan([module, 'host-runtime/scripts/replacement.mjs', unit], before, after).tests,
    [consumerTest, unit]);
});

test('removed tests require surviving replacement coverage, not unrelated smoke', () => {
  const before = snapshot({[module]: source[module], [unit]: source[unit]});
  const removed = snapshot({[module]: source[module]});
  assert.throws(() => plan([unit], before, removed), /removed test has no surviving coverage/u);
  const renamed = new Map(removed).set('tests/renamed.test.mjs', source[unit]);
  assert.deepEqual(plan([unit, 'tests/renamed.test.mjs'], before, renamed).tests, ['tests/renamed.test.mjs']);
  const replacement = new Map(removed).set('tests/replacement.test.mjs', source[unit] + '\nassertChangedContract();');
  assert.deepEqual(plan([unit], before, replacement).tests, ['tests/replacement.test.mjs']);
});

test('unknown executable/fixture and computed-only loads require a reviewed owner', () => {
  const files = snapshot({
    'host-runtime/scripts/dynamic.mjs': 'export const value = 1;',
    'tests/dynamic.test.mjs': "const name='dynamic.mjs'; await import('../host-runtime/scripts/' + name);",
    'tests/fixtures/unknown.json': '{}',
  });
  for (const file of ['host-runtime/scripts/dynamic.mjs', 'tests/fixtures/unknown.json', '.github/scripts/new-fixture.ps1'])
    assert.throws(() => plan([file], files), error => error.message.includes(file) && error.message.includes('reviewed owner mapping'));
});

test('native mapping is portable boundary selection, never evidence of native OS execution', () => {
  const native = 'host-runtime/scripts/native-private-process/PrivateProcess.cpp';
  const suite = 'tests/trelio-windows-native-private.test.mjs';
  const result = plan([native], snapshot({[native]: null, [suite]: 'testNativeBoundary();'}));
  assert.deepEqual(result.tests, [suite]);
  assert.deepEqual(result.reasons[suite], [`direct:${native}`]);
  assert.equal(Object.hasOwn(result, 'nativeVerified'), false);
  assert.throws(() => plan([native], snapshot({[native]: null})), /no surviving test owner/u);
});

test('workflow edits select planner contracts, while Git transport runs its composite once', () => {
  const files = snapshot({
    'scripts/runtime-ci-plan.test.mjs': 'test();', 'scripts/runtime-main-checks.test.mjs': 'test();',
    'scripts/git-coordinator.test.mjs': 'test();', 'scripts/git-finish-worktree.test.mjs': 'test();',
  });
  const workflow = plan(['.github/workflows/runtime-tests.yml'], files);
  assert.equal(workflow.coordination, false);
  assert.deepEqual(workflow.tests, ['scripts/runtime-ci-plan.test.mjs', 'scripts/runtime-main-checks.test.mjs']);
  const git = plan(['scripts/git-coordinator.mjs', 'scripts/git-coordinator.test.mjs', 'scripts/git-finish-worktree.test.mjs'], files);
  assert.equal(git.coordination, true);
  assert.deepEqual(git.tests, []);
});

test('real Git snapshots are bounded complete objects and preserve deleted/renamed fixture consumers', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-main-impact-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const write = (file, text) => {fs.mkdirSync(path.dirname(path.join(directory, file)), {recursive: true}); fs.writeFileSync(path.join(directory, file), text);};
  const commit = () => {git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD');};
  git('init', '-q');
  for (const [file, text] of Object.entries(source)) write(file, text);
  write('tests/fixture.test.mjs', "readFile(new URL('./fixtures/old.json', import.meta.url));");
  write('tests/fixtures/old.json', '{}');
  const base = commit();
  fs.renameSync(path.join(directory, module), path.join(directory, 'host-runtime/scripts/replacement.mjs'));
  fs.renameSync(path.join(directory, 'tests/fixtures/old.json'), path.join(directory, 'tests/fixtures/new.json'));
  write(unit, "import '../host-runtime/scripts/replacement.mjs';");
  write('tests/fixture.test.mjs', "readFile(new URL('./fixtures/new.json', import.meta.url));");
  const head = commit(), before = readMainCheckSnapshot(directory, base), after = readMainCheckSnapshot(directory, head);
  const {changedPaths} = readRuntimeCiPlan({repository: directory, baseSha: base, headSha: head});
  assert.ok(changedPaths.includes(module) && changedPaths.includes('host-runtime/scripts/replacement.mjs'));
  assert.deepEqual(plan(changedPaths, before, after).tests, [consumerTest, 'tests/fixture.test.mjs', unit]);
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = '1';
  try { assert.throws(() => readMainCheckSnapshot(directory, head), /complete main-check snapshot/u); }
  finally { if (previous === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = previous; }
  fs.symlinkSync('helper.mjs', path.join(directory, 'host-runtime/scripts/link.mjs'));
  assert.throws(() => readMainCheckSnapshot(directory, commit()), /Unsupported main-check symlink/u);
});

test('current repository selection fixes real diagnostics/fixture gaps without prefix families', () => {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).stdout.trim();
  const files = readMainCheckSnapshot(root, sha);
  assert.deepEqual(plan(['tests/fixtures/context-search-ranking-v2.json'], files).tests,
    ['tests/trelio-context-search-ranking.test.mjs']);
  assert.ok(plan(['host-runtime/scripts/trelio-process-diagnostics.mjs'], files).tests.includes('tests/trelio-agent-diagnostics.test.mjs'));
  const setup = plan(['host-runtime/scripts/trelio-assistant-setup.mjs'], files);
  for (const suite of ['setup', 'maintenance', 'windows-background']) assert.ok(setup.tests.includes(`tests/trelio-assistant-${suite}.test.mjs`));
  assert.ok(!setup.tests.includes('tests/trelio-assistant-coordinator.test.mjs'));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/runtime-tests.yml'), 'utf8');
  assert.match(workflow, /node scripts\/runtime-main-checks\.test\.mjs/u);
});

// Exercise the real planner -> dependency preflight -> sequential runner, not
// a copied executor or a fabricated receipt. This repository is wholly owned
// by the fixture; no runtime/client/private state or remote push is involved.
test('real main CLI stops at the first failing selected suite and refuses unknown/read failures before execution', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-main-cli-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const write = (file, text) => {fs.mkdirSync(path.dirname(path.join(directory, file)), {recursive: true}); fs.writeFileSync(path.join(directory, file), text);};
  const commit = () => {git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD');};
  const marker = name => fs.existsSync(path.join(directory, name));
  git('init', '-q');
  write('package.json', JSON.stringify({private: true, scripts: {'check:dependencies': 'node scripts/dependencies.mjs'}}));
  write('scripts/dependencies.mjs', "import fs from 'node:fs'; fs.writeFileSync('.dependencies-ran', 'yes');");
  write(module, 'export const value = 1;');
  write('tests/a-failure.test.mjs', `import '../${module}'; import fs from 'node:fs'; fs.writeFileSync('.first-ran', 'yes'); process.exit(9);`);
  write('tests/z-later.test.mjs', `import '../${module}'; import fs from 'node:fs'; fs.writeFileSync('.later-ran', 'yes');`);
  const base = commit();
  git('update-ref', 'refs/remotes/origin/main', base);
  write(module, 'export const value = 2;');
  let head = commit();
  const invoke = env => spawnSync(process.execPath, [path.join(root, 'scripts/runtime-main-checks.mjs'), base, head],
    {cwd: directory, encoding: 'utf8', env: env ?? process.env, timeout: 20_000});
  const failed = invoke();
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /Local check failed:.*tests\/a-failure\.test\.mjs/u);
  assert.ok(marker('.dependencies-ran') && marker('.first-ran'));
  assert.equal(marker('.later-ran'), false);
  assert.doesNotMatch(failed.stdout, /Local main checks passed/u);
  for (const name of ['.dependencies-ran', '.first-ran']) fs.unlinkSync(path.join(directory, name));
  write('host-runtime/scripts/uncovered.mjs', 'export const uncovered = true;');
  head = commit();
  const unknown = invoke();
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /host-runtime\/scripts\/uncovered\.mjs: no surviving test owner/u);
  assert.equal(marker('.dependencies-ran'), false);
  assert.equal(marker('.first-ran'), false);
  assert.doesNotMatch(unknown.stdout, /Local main checks passed/u);
  const incomplete = invoke({...process.env, GIT_TRACE: '1'});
  assert.equal(incomplete.status, 1);
  assert.equal(marker('.dependencies-ran'), false);
  assert.doesNotMatch(incomplete.stdout, /Local main checks passed/u);
});
