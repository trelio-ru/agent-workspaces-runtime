# Runtime checks

Ordinary `git:integrate` checks the complete diff against freshly fetched main
inside its local ticket. The planner selects changed tests, tests of the
affected runtime modules and syntax checks. Maintainer Markdown does not start
runtime suites. The successful ticket binds the current base and exact commit.
The canonical hook reads that ticket without launching tests or using GitHub
Actions.

An explicit release ticket publishes its exact branch and dispatches
`runtime-tests.yml`. The release workflow always selects the full matrix for
the expected SHA, including when the candidate is already integrated.

- `Runtime CI plan`
- `Canonical main Git guard`
- `Build native Windows private worker`
- `Native Windows private worker (arm64)`
- `Runtime tests (ubuntu-latest)`
- `Runtime tests (macos-15-intel)`
- `Windows runtime and private ACL`
- All four `Native visual browser (...)` jobs

Both macOS matrices use the hosted `macos-15-intel` pool. All native checks,
platform-specific security assertions and Windows artifacts are part of release
evidence. The release uses the exact tested commit.

The native Linux browser lane probes the hosted Ubuntu suite over HTTPS before
selecting the main archive or the Linux Kernel Archives mirror. The probe only checks reachability. APT
still refreshes and validates signed indexes and packages before the unchanged
desktop and Secret Service tests run.

The owner-company composition suite is mandatory on macOS and Windows. Its
serial stdio host launches actual request workers with the production factories,
native Keychain/DPAPI store, private sessions and managed HPKE/mirror. Only remote
server data is synthetic and loopback-owned. The cold case reads 3,000 genuine
encrypted containers (~150 MiB), then searches and reads an exact task/current
discussion and a warm second question without a Task/Run. Separate native child
cases retain one original-timeout resume, a hard second timeout, native access
refusal and unknown HTTP bucket privacy. Fault injection shortens only the first
N deliberately stalled preparation clocks; a healthy resumed attempt retains its
ordinary production budget. The two-timeout case still refuses a third attempt,
and the outer fixture bound and all native/no-replay assertions remain unchanged.
A disposable macOS Keychain never reads the operator's login Keychain; Linux
explicitly skips this native private-store
suite and retains the common crypto/mirror tests. It is not evidence of a model
answer or a live Telegram send: that remains a separate original-peer acceptance.
Its disposable Windows HOME uses the short runner-owned temp root, avoiding an
artificial MAX_PATH failure from nesting below the runner's full profile TEMP.
Synthetic filesystem failures retain only closed errno/syscall categories;
production path validation, private ACLs and request assertions are unchanged.
Owned-timeout fixtures expire only the planned stalled parent query timers,
after observing their real pending HTTP responses, independent of runner speed.
The resumable prefix must have eight atomically published encrypted cache files
before that fault; a completed network response is not a completed cache write.
Recovered children and subsequent warm reads use production private-session
budgets. An independent twelve-second warm-read delay verifies that planned
faults do not shorten later queries. The second deliberate timeout remains
terminal without a third attempt.

Windows keeps all eleven assistant suites, the shared Workspace process/finish/
directory/files boundaries, local context/policy/proof, signed hook chain,
hash-pinned real Codex CLI → synthetic CMD MCP startup, runtime entry and plugin
preservation. Native ACL/DPAPI/private session still execute on Node22/24 and
under the existing standard-user fixture; ARM64 retains its native tests. Human
diagnostics/onboarding/accounts/Python, unrelated browser/OAuth/Remote MCP and
slow shared cache/timeout groups run only in full. No production deadline,
assertion, security admission or native fixture is relaxed.

The standard-user job also compiles a source-only disposable package-service
fixture with the production SCM/RM identity and exit primitives. A real new
non-administrator account must read, normally stop and restore an inert
LocalSystem service whose process DACL denies query/synchronization while its
SCM DACL grants ordinary control. The old query must actually be refused; stale
generations/names must refuse without control. Production identity uses the OS
RM_UNIQUE_PROCESS generation and exact-file/SCM proofs without opening the
LocalSystem process, including zero-access opens. A completion sentinel prevents
all-skipped success. Fixture binaries never enter the native release artifact.
Failures retain only closed observation stages/numeric results. Owned fixture
cleanup is independent of the failing reader and preserves its test failure.
The fixture's SCM DACL matches the packaged service's ordinary authenticated-user
grant (0x201fd), including ENUMERATE_DEPENDENTS, but no config/DACL/owner writes.
The independent process DACL still denies the original query/synchronization
request. A stricter synthetic SCM grant must not be confused with that separate
process boundary. The first ordinary generation must equal an administrator's
independent query-only GetProcessTimes result, not merely fit a string pattern.
The source-only parent retains its actual owned child handle through native exit
and pipe close. Null/nonzero status or an absent executed-flow sentinel fails.
An unknown/live child preserves its exact disposable fixture/account/files rather
than racing late control or inventing successful cleanup. Diagnostic comparisons
and unsupported API experiments are not installed production fallbacks.

Windows multi-command assistant groups explicitly stop at each nonzero Node
exit; a later passing suite cannot hide an earlier failure.
The pinned public Codex archive GET permits only two bounded transient retries;
hash/member verification still precedes extraction and the real Windows MCP test.
The positive instruction-retention fixture permits at most three separate real
hooks against its unchanged synthetic transcript: every hook must produce a
valid method-bound proof, and at least one must inject the exact verified hints.
No MCP operation is dispatched by those probes. The optional 250ms inspection
budget, full-read fallback and production no-replay boundaries remain unchanged.
Root test dependencies are installed from the committed lock on Windows as
well; ordinary-chat schema/token bounds use the same tokenizer on every OS.
Native background registration runs first in that group; transport/accepted inspection runs once
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
numeric child exit plus closed filesystem/native failure categories on failure.
Concurrent acquisition reports fixed subphases; raw errors, paths and child output
remain private. The original assertion and deadlines are preserved.

Authentication transition regressions cover the signed top-frame receiver
during document replacement. After a positively acknowledged form/follow,
only the closed native messaging error can retry the value-free observation
under the original attempt deadline. Initial probes, exact challenge
revalidation, credential input and generic transport/policy errors remain
fail-closed. Native fixtures still require positive success and exact submit
counts; neither user-facing pixels nor native error prose cross this boundary.

The dialog fixture uses the unique rendered text hit target on a shifted
layout, rather than a guessed offset. Both text and image still make one
native click, observe both dialogs, and check the original effect count.
Synthetic handler-entry evidence distinguishes missed input from an
unobserved dialog without retrying the click.

Planning uploads `runtime-ci-plan/ci-plan.json`, binding the complete diff,
base/head, full profile, required jobs and exact GitHub run/attempt. The tag job
selects the latest dispatched workflow for the same repository and tagged SHA,
recomputes the plan and verifies all paginated jobs from that attempt. Missing,
failed, pending, stale or ambiguous evidence blocks the package build.

Only after verification does the tag job download the Windows worker binaries
from that exact run and build the tagged host runtime package.

Targeted planner/verifier regressions:

```sh
node scripts/runtime-ci-plan.test.mjs
```


Full gate также выполняет `trelio-deepseek-native.test.mjs` с exact npm-ci
fixture core 0.2.1-rc.3 (Tools/Session) на Linux/macOS и Windows, без account/model
или network provider. Тот же exact fixture содержит native attachment-local:
MCP image проходит реальный registry и durable store, затем читается заново;
malformed/bounded input, text-only/unknown model и late route/cancellation
refusals не повторяют исходный вызов. `trelio-deepseek-install.test.mjs` проверяет immutable
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

Full Linux/macOS runs `trelio-search-provider-parity.test.mjs` directly alongside
matching/ranking suites; adapter parity is mandatory, not just generated-vector tests.

Search pacing parity executes the actual Yandex and Google controllers from the
same explicitly pinned public provider commit in Linux/macOS and visual lanes.
The provider checkout is read-only input, outside the signed package. Its declared
controller names/methods are tested with synthetic clocks; no browser request is
sent. A reviewed provider update changes the pin and selectors together, retaining
all interval, concurrent-call and unknown-send assertions. Floating provider main
must not change the test meaning of an otherwise unchanged runtime candidate.
