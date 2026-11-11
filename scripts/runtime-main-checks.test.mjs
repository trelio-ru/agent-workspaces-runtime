import assert from 'node:assert/strict';
import test from 'node:test';
import {planMainChecks} from './runtime-main-checks.mjs';

test('a maintainer document selects no runtime suite, and a test-only edit selects that test', () => {
  assert.deepEqual(planMainChecks(['AGENTS.md'], () => true),
    {syntax: [], tests: [], dependencies: false, coordination: false});
  const file = 'tests/trelio-browser-tab-budget.test.mjs';
  assert.deepEqual(planMainChecks([file], () => true).tests, [file]);
});

test('shared workspace code and tooling changes keep their local checks', () => {
  const plan = planMainChecks(['host-runtime/scripts/trelio-workspace.mjs', '.github/workflows/runtime-tests.yml'], () => true);
  assert.ok(plan.tests.includes('tests/trelio-workspace-action-process.test.mjs'));
  assert.ok(plan.tests.includes('scripts/runtime-ci-plan.test.mjs'));
  assert.equal(plan.coordination, true);
});

test('the Git guard runs its constituent suites once, including when those tests also changed', () => {
  const coordinator = 'scripts/git-coordinator.test.mjs';
  const finish = 'scripts/git-finish-worktree.test.mjs';
  const plan = planMainChecks(['scripts/git-coordinator.mjs', coordinator, finish], () => true);
  assert.equal(plan.coordination, true);
  assert.ok(!plan.tests.includes(coordinator));
  assert.ok(!plan.tests.includes(finish));
  assert.deepEqual(planMainChecks([coordinator, finish], () => true).tests, [coordinator, finish]);
});
