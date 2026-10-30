import {verifyHosted, verifyRuntimePlan} from './git-hosted-ci.mjs';
import * as runtime from './runtime-ci-plan.mjs';
const [mode, sha] = process.argv.slice(2);
if (mode !== '--prepare' || !/^[a-f0-9]{40}$/u.test(sha ?? '')) throw Error('Use --prepare SHA');
// The native receipt decides full/narrow. Recompute it instead of requiring
// unrelated GUI jobs for an eligible orchestration-only patch.
await verifyHosted(process.cwd(), sha, [{file: 'runtime-tests.yml', jobs: runtime.BASE_CI_JOBS}], {
  prepare: true, validate: evidence => verifyRuntimePlan(process.cwd(), evidence, runtime),
});
