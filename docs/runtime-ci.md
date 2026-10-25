# Runtime CI profiles

Policy v1 lives in `scripts/runtime-ci-plan.mjs`; it is maintainer code, outside
the signed payload. `.github/workflows/runtime-tests.yml` still owns the same
native build, Linux/macOS, Windows, ARM64, browser and tag jobs. There are no
PR labels, workflow path filters, model-selected test commands or manual waivers.

## Complete source decision

The `Runtime CI plan` job reads the pinned PR **base and head** commits with full
history and a complete `git diff --raw -z --no-renames --no-ext-diff --no-textconv`
between their trees. It does not restrict the path inventory or hide missing base
changes with a merge-base. Every source checkout tests the exact PR head instead
of an implicit merge tree. Failed/incomplete Git reads fail planning and block
publication; unknown, empty, docs-only or test-only diffs require `full`.

The only narrow source files are assistant `codex`, `coordinator`, `inbox` and
`scheduler`. Their existing imports must be unchanged. The mixed assistant
`entry` module admits only its existing lifecycle `const action` parameter block
before `let nativeReason,...`: both anchors must occur once, complete old/new
files are read, and every byte outside that block must match. Changes to its
identity, encryption, Secret, admission, browser or other regions require full.

Matching existing assistant tests may accompany these files. Modified maintainer
`AGENTS.md`, `README.md` and `docs/*.md` are non-payload companions; they never
make an otherwise broad code diff narrow. New/deleted/renamed/copied files,
mode/type changes, imports and every unclassified path require full. In
particular hook/private storage/transport, common Workspace, crypto, native
sources, runtime-loaded instructions/policies, package/dependency files and any
CI/planner changes always require full. The planner's own initial change is full.

## Mandatory coverage

Both profiles require these seven successful jobs:

- `Runtime CI plan`
- `Canonical main Git guard`
- `Build native Windows private worker`
- `Native Windows private worker (arm64)`
- `Runtime tests (ubuntu-latest)`
- `Runtime tests (macos-latest)`
- `Windows runtime and private ACL`

Full adds the four existing `Native visual browser (...)` jobs and keeps every
existing direct Node invocation and Windows group. The narrow profile skips
those unchanged browser GUI jobs and selects existing suites inside the same
Linux/macOS and Windows jobs, rather than reporting skipped suites as success.

Linux/macOS run all eleven assistant suites plus context budget, real native
Codex adapter, runtime entry/recovery, signed hook/package chain, hook/private
session/proof, common local context and Workspace action/process/finish/directory/
files, instruction delivery and plugin preservation. The exact list is exported
as `ASSISTANT_CI_TESTS`; each file runs in its own Node process. The existing
first-protected-call regression runs separately with its ordinary name filter.

Windows keeps all eleven assistant suites, the shared Workspace process/finish/
directory/files boundaries, local context/policy/proof, signed hook chain,
hash-pinned real Codex CLI → synthetic CMD MCP startup, runtime entry and plugin
preservation. Native ACL/DPAPI/private session still execute on Node22/24 and
under the existing standard-user fixture; ARM64 retains its native tests. Human
diagnostics/onboarding/accounts/Python, unrelated browser/OAuth/Remote MCP and
slow shared cache/timeout groups run only in full. No production deadline,
assertion, security admission or native fixture is relaxed.

Both Linux/macOS jobs retain exact dependency checks and two byte-identical
unsigned package builds. The same deterministic Windows x64/ia32/arm64 artifact
is built for every PR and consumed by the signed-chain/package fixtures. Test
selection is not permission to reuse stale native source/binaries or skip the
ordinary release signature/policy/read-back chain.

## Exact tag verification

Planning uploads `runtime-ci-plan/ci-plan.json`, binding schema/policy version,
base/head, complete diff digest, changed paths, selected profile/required jobs
and native PR event/number plus run ID/attempt. A rerun replaces that report with its current attempt.

The tag job selects a successful PR run for the same repository/exact tagged
SHA, reads that run's plan and recomputes it from Git using the tagged policy.
The isolated planner pins base/head from the native PR event. The authenticated
run must itself be a successful PR run of the same exact SHA; GitHub's later
`pull_requests` list is not authority because it may be empty after merge.
Missing/stale/changed plans fail; a run status or another PR's green jobs never
replace source evidence. All paginated jobs from the exact run attempt must be
complete, unique and bound to that run/head/attempt; every required named job
must be completed/successful, and failures/cancellations are rejected.

Only then does the unchanged tag build download `windows-private-worker` from
that exact verified run and build `host-runtime-package`. Main/tag do not replay
the already successful tests. Expired/missing evidence or changed source needs
a new valid PR gate, not a reduced-profile fallback.

Targeted planner/verifier regressions:

```sh
node scripts/runtime-ci-plan.test.mjs
```
