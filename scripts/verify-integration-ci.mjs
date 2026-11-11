import {execFileSync} from 'node:child_process';
import {read, policy} from './git-coordinator.mjs';
import {verifyHosted, verifyRuntimePlan} from './git-hosted-ci.mjs';
import * as runtime from './runtime-ci-plan.mjs';

const [mode, sha] = process.argv.slice(2);
if (mode !== '--prepare' || !/^[a-f0-9]{40}$/u.test(sha ?? '')) throw Error('Use --prepare SHA');
const cwd = process.cwd();
const branch = read('git', ['symbolic-ref', '--short', 'HEAD'], cwd);
const base = read('git', ['rev-parse', 'refs/remotes/origin/main'], cwd);

// The queued release branch is published before dispatch. The verifier still
// reads the exact successful run and recomputes its plan before allowing a tag.
await verifyHosted(cwd, sha, [{file: 'runtime-tests.yml', jobs: runtime.requiredRuntimeCiJobs('full')}], {
  prepare: true,
  event: 'workflow_dispatch',
  dispatch: file => execFileSync('gh', ['workflow', 'run', file, '--repo', policy(cwd).repository,
    '--ref', branch, '-f', `base_sha=${base}`, '-f', `head_sha=${sha}`], {cwd, stdio: 'inherit'}),
  validate: evidence => verifyRuntimePlan(cwd, evidence, runtime),
});
