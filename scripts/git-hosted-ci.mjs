/** Shared read-only hosted gate. Repository adapters declare the exact required
 * workflows/jobs; runtime additionally recomputes its native signed-source plan.
 * A pending/new failed attempt never falls back to an older successful run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {read, policy} from './git-coordinator.mjs';

export const api = (cwd, endpoint) => JSON.parse(read('gh', ['api', endpoint], cwd));
export function validateJobs(run, pages, names) {
  const jobs = pages.flatMap(page => page.jobs);
  if (!pages.length || pages.some(page => !Array.isArray(page.jobs) || page.total_count !== jobs.length)
    || new Set(jobs.map(job => job.id)).size !== jobs.length) throw Error('Incomplete hosted job inventory');
  for (const job of jobs) {
    if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha
      || job.status !== 'completed' || !['success', 'skipped'].includes(job.conclusion)) throw Error('Unsuccessful exact hosted job');
    if (job.conclusion === 'success' && (!job.labels?.includes('github-hosted')
      && !/^GitHub Actions /u.test(job.runner_group_name ?? ''))) {
      // GitHub's ordinary public runners expose runner_group_name="GitHub
      // Actions" and OS labels; private/self-hosted results are not equivalent.
      if (job.runner_group_name !== 'GitHub Actions') throw Error('Required gate must use GitHub-hosted runners');
    }
  }
  for (const name of names) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') throw Error(`Missing required hosted job: ${name}`);
  }
  return jobs;
}
async function pages(cwd, endpoint, key) {
  const result = [];
  for (let page = 1; page <= 20; page++) {
    const value = api(cwd, `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(value[key]) || !Number.isSafeInteger(value.total_count)) throw Error('Incomplete hosted pagination');
    result.push(value);
    if (result.flatMap(item => item[key]).length === value.total_count) return result;
    if (value[key].length < 100) throw Error('Truncated hosted pagination');
  }
  throw Error('Hosted pagination exceeded bound');
}
export async function verifyHosted(cwd, sha, requirements, {prepare = false, validate, timeoutMs = 3_600_000, pollMs = 15_000} = {}) {
  const config = policy(cwd), repo = config.repository;
  const origin = read('git', ['config', '--get', 'remote.origin.url'], cwd);
  const identity = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(origin)?.[1];
  if (identity !== repo) throw Error('CI policy does not match exact origin repository');
  if (!requirements.length || requirements.some(item => !/^[a-z0-9-]+\.yml$/u.test(item.file) || !item.jobs.length)) throw Error('No exact hosted gate configured');
  const branch = read('git', ['symbolic-ref', '--short', 'HEAD'], cwd);
  // A release may tag a commit that the queue has already integrated. GitHub
  // cannot open another PR with no commits against main. Skip only that PR
  // creation step for the exact freshly fetched main SHA; the mandatory run,
  // attempt, jobs and repository-specific proof below are still verified in
  // full. Equality is not CI evidence and never admits a missing/failed gate.
  if (prepare && sha !== read('git', ['rev-parse', 'refs/remotes/origin/main'], cwd)) {
    const pulls = api(cwd, `repos/${repo}/pulls?head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}&base=main&state=open&per_page=100`);
    if (!Array.isArray(pulls) || pulls.length > 1) throw Error('Ambiguous pull-request inventory');
    if (!pulls.length) {
      const result = spawnSync('gh', ['pr', 'create', '--repo', repo, '--base', 'main', '--head', branch,
        '--title', read('git', ['log', '-1', '--format=%s'], cwd), '--body', 'Изменение проходит общую очередь интеграции и проверки exact SHA.'], {cwd, stdio: 'inherit'});
      if (result.error || result.status !== 0) throw Error('Could not create exact source PR');
    }
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let pending = false;
    for (const requirement of requirements) {
      const all = await pages(cwd, `repos/${repo}/actions/workflows/${requirement.file}/runs?head_sha=${sha}&event=pull_request`, 'workflow_runs');
      const matching = all.flatMap(page => page.workflow_runs).filter(run => run.head_sha === sha && run.event === 'pull_request')
        .sort((a, b) => b.id - a.id);
      if (!matching.length || matching[0].status !== 'completed') { pending = true; continue; }
      const run = api(cwd, `repos/${repo}/actions/runs/${matching[0].id}`);
      if (run.repository?.full_name !== repo || run.head_sha !== sha || run.event !== 'pull_request'
        || run.path !== `.github/workflows/${requirement.file}` || run.conclusion !== 'success' || run.status !== 'completed') throw Error(`Exact PR gate failed: ${requirement.file}`);
      const jobsPages = await pages(cwd, `repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
      validateJobs(run, jobsPages, requirement.jobs);
      await validate?.({run, jobsPages, requirement});
      const current = api(cwd, `repos/${repo}/actions/runs/${run.id}`);
      if (current.run_attempt !== run.run_attempt || current.status !== 'completed' || current.conclusion !== 'success') throw Error('Hosted attempt changed while verifying');
    }
    if (!pending) return;
    if (!prepare || Date.now() >= deadline) throw Error('Exact hosted PR gate is incomplete; source retained');
    console.log(`Waiting for exact hosted PR gate: ${sha}`);
    await delay(pollMs);
  }
}

/** Runtime policy stays in its canonical repository, outside this package.
 * Download only the structural plan, then recompute its full pinned source diff.
 * Temporary receipts never contain credentials or company data.
 */
export async function verifyRuntimePlan(cwd, {run, jobsPages}, implementation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trelio-ci-plan-'));
  try {
    const result = spawnSync('gh', ['run', 'download', String(run.id), '--repo', policy(cwd).repository,
      '--name', 'runtime-ci-plan', '--dir', directory], {cwd, stdio: 'inherit'});
    if (result.error || result.status !== 0) throw Error('Missing exact runtime CI plan');
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'ci-plan.json'), 'utf8'));
    const recomputedPlan = implementation.readRuntimeCiPlan({repository: cwd, baseSha: receipt.baseSha, headSha: run.head_sha});
    return implementation.verifyRuntimeCiGate({receipt, recomputedPlan, jobsPages,
      selection: {runId: run.id, runAttempt: run.run_attempt, headSha: run.head_sha, event: run.event}});
  } finally { fs.rmSync(directory, {recursive: true}); }
}
