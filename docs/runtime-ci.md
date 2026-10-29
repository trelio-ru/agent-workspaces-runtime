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

The owner-company composition suite is mandatory on macOS and Windows. Its
serial stdio host launches actual request workers with the production factories,
native Keychain/DPAPI store, private sessions and managed HPKE/mirror. Only remote
server data is synthetic and loopback-owned. The cold case reads 3,000 genuine
encrypted containers (~150 MiB), then searches and reads an exact task/current
discussion and a warm second question without a Task/Run. Separate native child
cases retain one original-timeout resume, a hard second timeout, native access
refusal and unknown HTTP bucket privacy. A disposable macOS Keychain never reads
the operator's login Keychain; Linux explicitly skips this native private-store
suite and retains the common crypto/mirror tests. It is not evidence of a model
answer or a live Telegram send: that remains a separate original-peer acceptance.
Its disposable Windows HOME uses the short runner-owned temp root, avoiding an
artificial MAX_PATH failure from nesting below the runner's full profile TEMP.
Synthetic filesystem failures retain only closed errno/syscall categories;
production path validation, private ACLs and request assertions are unchanged.

Windows keeps all eleven assistant suites, the shared Workspace process/finish/
directory/files boundaries, local context/policy/proof, signed hook chain,
hash-pinned real Codex CLI → synthetic CMD MCP startup, runtime entry and plugin
preservation. Native ACL/DPAPI/private session still execute on Node22/24 and
under the existing standard-user fixture; ARM64 retains its native tests. Human
diagnostics/onboarding/accounts/Python, unrelated browser/OAuth/Remote MCP and
slow shared cache/timeout groups run only in full. No production deadline,
assertion, security admission or native fixture is relaxed.

Windows multi-command assistant groups explicitly stop at each nonzero Node
exit; a later passing suite cannot hide an earlier failure. Native background
registration runs first in that group; transport/accepted inspection runs once
before the slower unrelated groups. Synthetic filesystem expectations use
canonical Windows paths and bounded short fixture homes, not production path
exceptions. Classic-console readiness shares its original startup deadline;
cleanup of an owned terminated helper preserves the original assertion.
The synthetic large PowerShell carrier uses the real scheduler's disabled module
auto-discovery and fixed Utility manifest import. Its original 40s pipe deadline
and one-launch/JSON assertions remain unchanged; failures expose fixed startup
stages only, never raw stderr or input.
The positive classic-console fixture explicitly launches inbox `conhost.exe`
for its synthetic client, independently verifies its HWND/class and waits for
that client's own exit code. This per-launch selection follows the
[Microsoft default-terminal specification](https://github.com/microsoft/terminal/blob/main/doc/specs/%23492%20-%20Default%20Terminal/spec.md);
it never changes the user's registry/default terminal or production launcher.
The isolated inspection fixture may capture disposable synthetic Git trace2
events locally and project only closed warning categories on failure. Its
ordinary Git diagnostics guard remains strict; raw trace/paths/argv are never
printed and the fixture removes that trace with its private temporary root.

Both Linux/macOS jobs retain exact dependency checks and two byte-identical
unsigned package builds. The same deterministic Windows x64/ia32/arm64 artifact
is built for every PR and consumed by the signed-chain/package fixtures. Test
selection is not permission to reuse stale native source/binaries or skip the
ordinary release signature/policy/read-back chain.

Full Windows also executes the real Workspace recovery/cleanup fixtures from
`trelio-workspace.test.mjs`: isolated retention with live siblings, protected
local changes, retention-only source discovery, persistent checkout reuse and
repeat recovery opens. Path-parser tests alone do not cover native deletion.

## Exact tag verification

Cross-repository shell checks accept either the historical remote startup-timeout
omission or the current exact `startup_timeout_sec: 60`; routing/OAuth fields stay
strict. The isolated dead-mirror-writer fixture reports only a closed stage and
numeric child exit on failure, preserving the original assertion and deadlines.

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


Full gate также выполняет `trelio-deepseek-native.test.mjs` с exact npm-ci
fixture core 0.2.1-rc.3 (Tools/Session) на Linux/macOS и Windows, без account/model
или network provider. `trelio-deepseek-install.test.mjs` проверяет immutable
bundle и реальный shared proof engine. Fixture lockfile не входит в artifact.
SemVer boundary tests используют те же includePrerelease options, что upstream:
разрешены все новые версии от 0.2.1-rc.2, включая prerelease и следующие minor/major;
старые версии закрыты.
API guards проверяются до private I/O. Fixture остаётся exact для воспроизводимости;
он не ограничивает установку одной версией и не доказывает live OAuth/save.

The outgoing-file browser fixture separates one chooser dispatch from the
synthetic site's asynchronous upload acknowledgement. It waits for that site's
explicit rendered-completion event under a bounded fixture wait and observes a
new read-only frame; original byte, single-click, stale-frame and no-replay
assertions remain mandatory. A chooser response is not a site-completion signal.
Before its sole chooser click it resolves the unique synthetic button from the
fresh native rendered-controls frame, rather than assuming fixed screen pixels.
Missing controls fail before input; no failed chooser is automatically retried.
