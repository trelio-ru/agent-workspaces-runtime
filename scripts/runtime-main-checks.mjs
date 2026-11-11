import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {read} from './git-coordinator.mjs';
import {readRuntimeCiPlan} from './runtime-ci-plan.mjs';

const smoke = ['tests/trelio-host-runtime-entry.test.mjs', 'tests/trelio-runtime-policy.test.mjs'];
const areas = [
  [/^trelio-assistant-/u, ['tests/trelio-assistant-coordinator.test.mjs', 'tests/trelio-assistant-transport.test.mjs']],
  [/^trelio-(?:visual-|browser-)/u, ['tests/trelio-visual-transport.test.mjs', 'tests/trelio-visual-browser.test.mjs']],
  [/^trelio-(?:hook-|runtime-|private-|remote-mcp)/u, ['tests/trelio-runtime-proof-preparation.test.mjs', 'tests/trelio-hook-tool-identity.test.mjs']],
  [/^trelio-(?:workspace|local-)/u, ['tests/trelio-workspace-action-process.test.mjs', 'tests/trelio-local-context.test.mjs']],
];

export function planMainChecks(paths, exists) {
  const syntax = new Set(), tests = new Set();
  let dependencies = false, coordination = false;
  for (const file of paths) {
    if (/^(?:(?:AGENTS|README)\.md|docs\/.+\.md)$/u.test(file)) continue;
    if (/\.(?:mjs|js|cjs)$/u.test(file) && exists(file)) syntax.add(file);
    if (/^(?:scripts|tests)\/[^/]+\.test\.mjs$/u.test(file)) {
      if (exists(file)) tests.add(file);
      else smoke.forEach(name => tests.add(name));
      continue;
    }
    if (file === 'git-coordination.json' || /^(?:\.githooks\/|\.github\/|scripts\/(?:git-|runtime-(?:ci|main)-|verify-integration-ci|assert-coordination|push-main|create-task-worktree))/u.test(file)) {
      coordination = true;
      continue;
    }
    if (/(?:^|\/)package(?:-lock)?\.json$/u.test(file)) dependencies = true;
    const name = path.basename(file);
    const peer = `tests/${name.replace(/\.[^.]+$/u, '')}.test.mjs`;
    if (exists(peer)) tests.add(peer);
    const area = areas.find(([pattern]) => pattern.test(name));
    // Shared entrypoints receive explicit common boundary checks. Files without
    // a directly named suite still exercise the closest known boundary.
    for (const suite of area?.[1] ?? (exists(peer) ? [] : smoke)) tests.add(suite);
  }
  if (coordination) {
    tests.add('scripts/runtime-ci-plan.test.mjs');
    tests.add('scripts/runtime-main-checks.test.mjs');
    // The Git guard script already executes these suites together with its
    // shell fixture. Keep direct execution for test-only changes outside it.
    tests.delete('scripts/git-coordinator.test.mjs');
    tests.delete('scripts/git-finish-worktree.test.mjs');
  }
  return {syntax: [...syntax], tests: [...tests], dependencies, coordination};
}

function run(executable, args, cwd) {
  console.log(`Local check: ${path.basename(executable)} ${args.join(' ')}`);
  const result = spawnSync(executable, args, {cwd, stdio: 'inherit', shell: false});
  if (result.error || result.status !== 0) throw Error(`Local check failed: ${executable} ${args.join(' ')}`);
}

function main([baseSha, headSha, ...extra]) {
  const cwd = process.cwd();
  if (extra.length || !/^[a-f0-9]{40}$/u.test(baseSha ?? '') || !/^[a-f0-9]{40}$/u.test(headSha ?? '')
    || read('git', ['rev-parse', 'refs/remotes/origin/main'], cwd) !== baseSha
    || read('git', ['rev-parse', 'HEAD'], cwd) !== headSha) throw Error('Local checks require the exact rebased candidate');
  // Use the same complete raw diff reader as release planning, including both
  // sides of a rename. Only the commands selected from those paths differ.
  const {changedPaths} = readRuntimeCiPlan({repository: cwd, baseSha, headSha});
  run('git', ['diff', '--check', baseSha, headSha], cwd);
  const plan = planMainChecks(changedPaths, file => fs.existsSync(path.join(cwd, file)));
  if (plan.dependencies) run('npm', ['run', 'check:dependencies'], cwd);
  for (const file of plan.syntax) run(process.execPath, ['--check', file], cwd);
  for (const file of plan.tests) run(process.execPath, [file], cwd);
  if (plan.coordination) run('npm', ['run', 'test:git-guard'], cwd);
  console.log(`Local main checks passed for ${headSha}: ${plan.tests.length} affected suites`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
