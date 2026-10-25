#!/usr/bin/env node
/** Maintainer-only CI policy. This file never enters the signed runtime.
 * A small, closed source set may omit unrelated browser/native GUI suites.
 * Every other change, including this policy/workflow/contract itself, retains
 * the complete gate. The tag verifier recomputes the same decision from Git;
 * a receipt, PR label, skipped job or successful workflow is not a waiver.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{40}$/u;
const ENTRY = 'host-runtime/scripts/trelio-assistant-entry.mjs';
const SOURCES = new Set(['codex', 'coordinator', 'inbox', 'scheduler'].map(name =>
  `host-runtime/scripts/trelio-assistant-${name}.mjs`));
const ASSISTANT_TESTS = ['inbox', 'scheduler', 'codex', 'private', 'transport',
  'source-reader', 'setup', 'windows-background', 'maintenance', 'hook', 'coordinator']
  .map(name => `tests/trelio-assistant-${name}.test.mjs`);
const TEST_CHANGES = new Set(ASSISTANT_TESTS);
// These are maintainer documentation only, never runtime-loaded instructions
// or packaged policy. They do not make an otherwise broad code diff narrow.
const maintainerDocument = name => name === 'AGENTS.md' || name === 'README.md'
  || name.startsWith('docs/') && name.endsWith('.md');

// The mixed entry module also contains encryption/Secret/admission code. Only
// its existing lifecycle parameter forwarding block is in the narrow policy.
// Compare complete old/new files with that ONE uniquely anchored block removed;
// line numbers, a matching hunk header or a path alone cannot admit other edits.
const ACTION_START = '    const action={...plan.localAction,parameters:{...plan.localAction.parameters,\n';
const ACTION_END = '    let nativeReason,nativeHealthCause,nativeCommandPolicyCause;';
const outsideLifecycleParameters = source => {
  if (typeof source !== 'string' || source.length > 2 * 1024 * 1024) return null;
  const first = source.indexOf(ACTION_START), end = source.indexOf(ACTION_END);
  if (first < 0 || end <= first || source.indexOf(ACTION_START, first + 1) >= 0
    || source.indexOf(ACTION_END, end + 1) >= 0) return null;
  const block = source.slice(first, end);
  // The allowed region remains one parameter declaration, not a place to add
  // another executable statement before the ending anchor. Extra semicolons
  // (even in a comment/string) conservatively require full rather than parsing
  // or executing candidate JavaScript in the planner.
  if (!block.endsWith('    }};\n') || block.slice(0, -6).includes(';')) return null;
  return source.slice(0, first) + source.slice(end);
};
const imports = source => source.match(/\bimport\s*(?:\([^)]*\)|[^;]*;)/gu) ?? [];

export const ASSISTANT_CI_TESTS = Object.freeze([
  'tests/context-budget.test.mjs', ...ASSISTANT_TESTS,
  ...['codex-conversation', 'host-runtime-entry', 'host-runtime-recovery',
    'hook-signed-chain', 'hook-tool-identity', 'hook-private-session',
    'runtime-policy', 'runtime-proof-preparation', 'local-context', 'local-path',
    'instruction-reuse', 'local-continuation', 'plugin-preservation',
    'workspace-action-process', 'workspace-finish-progress', 'workspace-directory',
    'workspace-files'].map(name => `tests/trelio-${name}.test.mjs`),
]);
export const BASE_CI_JOBS = Object.freeze(['Runtime CI plan', 'Canonical main Git guard',
  'Runtime tests (ubuntu-latest)', 'Runtime tests (macos-latest)',
  'Windows runtime and private ACL', 'Build native Windows private worker',
  'Native Windows private worker (arm64)']);
export const VISUAL_CI_JOBS = Object.freeze(['macos-latest', 'windows-latest', 'windows-11-arm', 'ubuntu-latest']
  .map(os => `Native visual browser (${os})`));
export const requiredRuntimeCiJobs = profile => {
  if (!['full', 'assistant-orchestration'].includes(profile)) throw Error('Unknown runtime CI profile');
  return [...BASE_CI_JOBS, ...(profile === 'full' ? VISUAL_CI_JOBS : [])];
};

/** Git raw -z includes both modes/object IDs and every pathname, without rename
 * heuristics or external diff/textconv. A bounded complete result is mandatory.
 * Deletions, additions, copies, renames and mode changes select full, even when
 * the destination happens to be an allowlisted assistant file.
 */
export const parseRuntimeCiDiff = raw => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4 * 1024 * 1024) throw Error('Incomplete CI diff');
  if (!raw) return [];
  const parts = raw.split('\0');
  if (parts.pop() !== '' || parts.length % 2 || parts.length > 4000) throw Error('Incomplete CI diff');
  return Array.from({length: parts.length / 2}, (_, index) => {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])$/u.exec(parts[index * 2]);
    const name = parts[index * 2 + 1];
    if (!match || !name || name.startsWith('/') || name.split('/').some(piece => !piece || piece === '..' || piece === '.')
      || /[\x00-\x1f\x7f\\]/u.test(name)) throw Error('Invalid CI diff');
    return {path: name, oldMode: match[1], newMode: match[2], oldOid: match[3], newOid: match[4], status: match[5]};
  });
};
export const planRuntimeCi = ({baseSha, headSha, changes, readSource}) => {
  if (!SHA.test(baseSha ?? '') || !SHA.test(headSha ?? '') || !Array.isArray(changes)
    || new Set(changes.map(change => change.path)).size !== changes.length) throw Error('Invalid CI revisions');
  let profile = 'assistant-orchestration', reason = 'closed-assistant-diff', sourceChanged = false;
  if (!changes.length) { profile = 'full'; reason = 'empty-diff'; }
  for (const change of changes) {
    if (change.status !== 'M' || change.oldMode !== '100644' || change.newMode !== '100644') {
      profile = 'full'; reason = 'structural-change'; break;
    }
    if (TEST_CHANGES.has(change.path) || maintainerDocument(change.path)) continue;
    if (!SOURCES.has(change.path) && change.path !== ENTRY) { profile = 'full'; reason = 'outside-closed-source-set'; break; }
    sourceChanged = true;
    const oldSource = readSource(baseSha, change.path), newSource = readSource(headSha, change.path);
    if (typeof oldSource !== 'string' || typeof newSource !== 'string'
      || JSON.stringify(imports(oldSource)) !== JSON.stringify(imports(newSource))) {
      profile = 'full'; reason = 'changed-imports'; break;
    }
    if (change.path === ENTRY) {
      const before = outsideLifecycleParameters(oldSource), after = outsideLifecycleParameters(newSource);
      if (before === null || after === null || before !== after) { profile = 'full'; reason = 'mixed-entry-change'; break; }
    }
  }
  if (profile !== 'full' && !sourceChanged) { profile = 'full'; reason = 'no-source-change'; }
  const sorted = [...changes].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {schemaVersion: 1, policyVersion: 1, baseSha, headSha, profile, reason,
    changesSha256: createHash('sha256').update(JSON.stringify(sorted)).digest('hex'),
    changedPaths: sorted.map(change => change.path), requiredJobs: requiredRuntimeCiJobs(profile)};
};

const git = (repository, args, maximum = 4 * 1024 * 1024) => {
  const result = spawnSync('git', ['-C', repository, ...args], {encoding: 'utf8', maxBuffer: maximum, shell: false});
  // A successful exit does not make a warning-bearing metadata read complete.
  // Keep the same fail-closed boundary as the canonical Git transport, without
  // copying stderr (which can contain local paths) into the CI receipt.
  if (result.error || result.status !== 0 || result.stderr !== '') throw Error('Cannot read complete CI Git evidence');
  return result.stdout;
};
export const readRuntimeCiPlan = ({repository = ROOT, baseSha, headSha}) => {
  if (!SHA.test(baseSha ?? '') || !SHA.test(headSha ?? '')) throw Error('Invalid CI revisions');
  for (const revision of [baseSha, headSha]) {
    if (git(repository, ['rev-parse', '--verify', `${revision}^{commit}`]).trim() !== revision) throw Error('Unknown CI revision');
  }
  // Compare complete pinned trees, not a merge-base/limited path list. A stale
  // branch also includes the base's missing changes and conservatively goes full.
  const changes = parseRuntimeCiDiff(git(repository, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames',
    '--no-ext-diff', '--no-textconv', baseSha, headSha, '--']));
  return planRuntimeCi({baseSha, headSha, changes,
    readSource: (revision, name) => git(repository, ['show', `${revision}:${name}`], 2 * 1024 * 1024)});
};

const positive = value => Number.isSafeInteger(value) && value > 0;
export const selectRuntimeCiRun = (pages, {headSha, repository}) => {
  if (!SHA.test(headSha ?? '') || typeof repository !== 'string') throw Error('Invalid CI run target');
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page.workflow_runs))) throw Error('Incomplete CI runs');
  const candidates = pages.flatMap(page => page.workflow_runs).filter(run => run.head_sha === headSha
    && run.event === 'pull_request' && run.status === 'completed' && run.conclusion === 'success'
    && run.repository?.full_name === repository && positive(run.id) && positive(run.run_attempt));
  const run = candidates.sort((a, b) => b.id - a.id)[0];
  if (!run) throw Error('Exact successful PR gate is required');
  return {runId: run.id, runAttempt: run.run_attempt, headSha, event: run.event};
};
export const verifyRuntimeCiGate = ({receipt, selection, jobsPages, recomputedPlan}) => {
  if (!positive(selection?.runId) || !positive(selection?.runAttempt) || selection.headSha !== recomputedPlan.headSha
    || selection.event !== 'pull_request' || receipt?.event !== 'pull_request' || !positive(receipt.pullRequestNumber)
    || receipt?.runId !== selection.runId || receipt.runAttempt !== selection.runAttempt) throw Error('Stale CI run receipt');
  const {runId: _run, runAttempt: _attempt, event: _event, pullRequestNumber: _pr, ...recordedPlan} = receipt;
  assert.deepEqual(recordedPlan, recomputedPlan, 'CI plan must match complete exact Git diff');
  // GitHub can return an empty run.pull_requests after a successful merge (the
  // real release run does). The pinned base/head came from the native PR event
  // in the isolated planner job, not mutable PR metadata queried after merge.
  // Bind that report to GitHub's exact authenticated PR run/attempt/head, then
  // recompute its complete tree diff instead of weakening to workflow success.
  // gh --paginate --slurp retains all pages. Never infer success from the first
  // 100 jobs, a same-name old attempt, or a workflow-level success with skips.
  if (!Array.isArray(jobsPages) || !jobsPages.length || jobsPages.some(page => !Array.isArray(page.jobs)
    || !Number.isSafeInteger(page.total_count) || page.total_count < 0
    || page.total_count !== jobsPages[0].total_count)) throw Error('Incomplete CI jobs');
  const jobs = jobsPages.flatMap(page => page.jobs);
  if (jobs.length !== jobsPages[0].total_count || new Set(jobs.map(job => job.id)).size !== jobs.length) throw Error('Incomplete CI jobs');
  if (jobs.some(job => !positive(job.id) || job.run_id !== selection.runId
    || job.run_attempt !== selection.runAttempt || job.head_sha !== receipt.headSha)) throw Error('Wrong CI job source or attempt');
  for (const name of requiredRuntimeCiJobs(receipt.profile)) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success' || matches[0].status !== 'completed') throw Error(`Incomplete exact CI gate: ${name}`);
  }
  if (jobs.some(job => !['success', 'skipped'].includes(job.conclusion) || job.status !== 'completed')) throw Error('Unsuccessful CI job');
  return {runId: selection.runId, runAttempt: selection.runAttempt, profile: receipt.profile};
};

const json = name => JSON.parse(fs.readFileSync(name, 'utf8'));
const write = (name, value) => fs.writeFileSync(name, JSON.stringify(value, null, 2) + '\n');
const options = raw => {
  if (raw.length % 2) throw Error('Use named CI arguments');
  const values = {};
  for (let index = 0; index < raw.length; index += 2) {
    if (!/^--[a-z-]+$/u.test(raw[index]) || Object.hasOwn(values, raw[index].slice(2))) throw Error('Invalid CI arguments');
    values[raw[index].slice(2)] = raw[index + 1];
  }
  return values;
};
const main = () => {
  const [command, ...raw] = process.argv.slice(2), args = options(raw);
  if (command === 'create') {
    const plan = readRuntimeCiPlan({baseSha: args.base, headSha: args.head});
    const runId = Number(process.env.GITHUB_RUN_ID), runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
    const event = process.env.GITHUB_EVENT_NAME, pullRequestNumber = Number(process.env.PR_NUMBER);
    if (!positive(runId) || !positive(runAttempt) || event !== 'pull_request' || !positive(pullRequestNumber))
      throw Error('Native CI PR/run identity is required');
    write(args.output, {...plan, runId, runAttempt, event, pullRequestNumber});
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `profile=${plan.profile}\n`);
    console.log(`Runtime CI profile: ${plan.profile} (${plan.reason})`);
  } else if (command === 'select-run') {
    const selection = selectRuntimeCiRun(json(args.runs), {headSha: args.head, repository: process.env.GITHUB_REPOSITORY});
    write(args.output, selection);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${selection.runId}\nrun-attempt=${selection.runAttempt}\n`);
  } else if (command === 'verify') {
    const receipt = json(args.plan), selection = json(args.selection);
    if (selection.headSha !== args.head) throw Error('Wrong tagged source');
    const recomputedPlan = readRuntimeCiPlan({baseSha: receipt.baseSha, headSha: args.head});
    console.log(JSON.stringify(verifyRuntimeCiGate({receipt, selection, jobsPages: json(args.jobs), recomputedPlan})));
  } else if (command === 'assistant-tests') {
    for (const file of ASSISTANT_CI_TESTS) {
      console.log(`Running ${file}`);
      const result = spawnSync(process.execPath, [file], {cwd: ROOT, stdio: 'inherit', shell: false});
      if (result.error || result.status !== 0) throw Error(`Required assistant suite failed: ${file}`);
    }
    const proof = spawnSync(process.execPath, ['--test', '--test-name-pattern=first protected call',
      'tests/trelio-runtime-session.test.mjs'], {cwd: ROOT, stdio: 'inherit', shell: false});
    if (proof.error || proof.status !== 0) throw Error('Required observed-proof suite failed');
  } else throw Error('Unknown runtime CI operation');
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
