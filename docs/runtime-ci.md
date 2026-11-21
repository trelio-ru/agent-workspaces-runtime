# Runtime checks

Ordinary `git:integrate` checks the complete diff against freshly fetched main
inside its local ticket. `scripts/runtime-main-checks.mjs` reads the base and
candidate Git trees through bounded `ls-tree`/`cat-file --batch` calls, without
executing candidate modules. The successful ticket binds the current base and
exact commit. The canonical hook reads that ticket without launching tests or
using GitHub Actions.

The main gate selects focused tested boundaries, not complete transitive runtime
coverage. Literal imports/exports, literal dynamic imports and `new URL(...,
import.meta.url)` connect source files and fixtures to their actual suites.
Query/hash suffixes do not change the source identity. Test helpers are followed
transitively. A changed module selects all its direct suites AND the nearest
tested boundary on each production-consumer branch, even if it has its own unit
test. At that boundary the proven same-name suite (or explicit reviewed owner)
stops traversal; every unrelated client of a large Workspace/assistant entrypoint
is not added. A text-only source assertion is direct coverage, never evidence
that the asserted file's imports were executed. Full cross-module/native coverage
remains a release responsibility.

Both pinned revisions contribute edges, so a deleted/renamed helper cannot erase
its surviving consumers. Changed tests execute once. A removed test needs a
surviving renamed test or coverage of all former inputs; deleting the sole test
is not a successful check. Computed imports, directory discovery and native
inputs have small reviewed owner mappings in the same planner. Unknown changed
executable/fixture paths stop with an exact path/reason requesting a focused test
or owner mapping; they never silently fall back to unrelated smokes or the full
release suite. The printed plan explains each selected suite's direct/consumer
input. A selected native-owner suite provides only its portable/source-boundary
assertions on the current OS, never proof that another OS's skipped native cases
passed. Windows/ARM64/macOS/browser release lanes stay mandatory.

The gate always checks the complete Git diff and the syntax of changed JavaScript.
It verifies the root dependency installation before selected tests. The
`lockedTestPackages` mapping connects each nested npm project to its suites.
Changes to either manifest select the linked suites. Selecting one of those
suites for any reason prepares that project's dependencies once, using the
candidate's committed lock and `npm ci` with lifecycle scripts disabled. The
gate requires both manifests and stops on installation failure before running
any suites. It reuses npm's download cache across worktrees and reconstructs
each selected package's local tree after a rebase. The current mapping covers
the DeepSeek Harness fixture and the visual browser packages. Add a new nested
npm test project together with the suites that consume it. Hosted native
browser and OS setup still belong to their CI jobs.

The signed-package hook suite needs the three Windows workers even when the
hook itself runs on macOS or Linux. Before running any selected suites,
the local gate validates the existing worker or prepares it from the official
`windows-private-worker` artifact. Only a successful hosted Windows build from
the canonical workflow and an ancestor of the verified main base qualifies.
Both `PrivateProcess.cpp` and its build script must match the candidate bytes.
The preflight checks GitHub's ZIP SHA-256 and the packaging validator checks the
source SHA-256, all three binary digests and PE machine codes before publication.

The verified archive is cached by those build inputs in the clone's common Git
directory. A fresh worktree materializes its own ignored `bin/` and validates
it again. The local receipt records the worktree, both build inputs and the
digest of the complete payload. After a rebase changes either input, the gate
verifies the replacement before moving its unchanged managed directory.
A failed refresh restores that directory when the destination is free and
preserves the backup when it cannot restore safely. Manual and older unmarked
directories keep the existing validation and are never replaced. An altered
managed directory also requires manual review.

A cold cache requires GitHub CLI read access and the system archive reader.
A warm cache works offline. Missing matching builds and invalid inputs fail
before the test suites. Ordinary integration only reads published artifacts.
The local receipt stays out of packages. Release CI still builds and tests
its own exact SHA and keeps the hosted native lanes.

Root package changes check the tokenizer consumer. Script-definition changes also
select the Git guard. Bootstrap, native and workflow inputs have their own
explicit owners. Only actual Git transport/queue/hooks/attributes changes select
`test:git-guard`; an unrelated `.github` fixture does not. The composite Git guard
runs its coordinator/finish suites once. Maintainer Markdown and `.gitignore`
need only the complete diff check; other unclassified metadata fails closed.
The full release workflow also executes the main-planner regression suite.

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

The real visual npm fixture waits for its copied Node worker to finish.
Owned test-tree cleanup uses a bounded filesystem retry after that process
settles. A transient Windows executable lock cannot hide runner results,
and a persistent cleanup error still fails CI.

Both macOS matrices use the hosted `macos-15-intel` pool. All native checks,
platform-specific security assertions and Windows artifacts are part of release
evidence. The release uses the exact tested commit.

Cross-repository checks read the plugin checkout separately. The shell
manifest assertions cover the current Code Mode registrations, the 3.3.0
local MCP exception and the older hook registrations. Runtime release precedes
shell rollout, so the bundled instruction checks also accept equivalent
wording from the installed shell and the new candidate.

The native Linux browser lane probes the hosted Ubuntu suite over HTTPS before
selecting the main archive or the Linux Kernel Archives mirror. It replaces
official main/Azure/regional EC2 mirrorlist URLs and preserves their qualifiers,
other sources and the image keyring. The probe only checks reachability. Native
desktop and Chromium dependency installs each have their own bound and refresh
the signed indexes before the unchanged desktop and Secret Service tests run.
The same isolated Xvfb display owns Openbox for the entire native lane. Xvfb
alone has no window manager to honor Chromium minimize requests. Before tests,
the fixture verifies its live child and nonzero EWMH supporting-window property
within five seconds; failure stops the lane. EXIT cleanup targets only that
owned manager. All native minimized-window and focus assertions stay unchanged.
After its single minimize request the test waits at most five seconds for native
window metadata under the original test/lease clock, without repeating minimize
or proceeding to screenshot/input before the actual minimized state is observed.
The manual-completion fixture preserves the first failed setup response and
closed startup/lifecycle diagnostics, closes its HTTP listener on cancellation
and retains failed profile evidence. A successful isolated reproduction is not
proof that an earlier hosted refusal was fixed.

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
A disposable macOS Keychain never reads the operator's login Keychain. Its
fixture prepares the native Swift helper with one missing-slot lookup in the
isolated HOME before the composed child starts. Cold helper compilation is
still covered separately; no private-session deadline or native seed assertion
is relaxed. Linux explicitly skips this native private-store
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
This same native Codex gate runs after setup inputs and before slower Workspace
groups, with its complete existing assertions. Hosted Windows stages every
native Codex scenario beneath the pinned CLI carrier. That carrier removes its
own tree only after the complete Node fixture exits successfully, retaining the
same bounded filesystem removal. A failed or unknown fixture preserves its
tree. The isolation fixture releases its own pipe ends only after the retained
child's real exit and still requires close. The carrier independently verifies
directory removal under the original bound. Production termination is unchanged.
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

Both Linux/macOS release jobs retain exact dependency checks and two byte-identical
unsigned package builds. The same deterministic Windows x64/ia32/arm64 artifact
is built by the hosted release workflow and consumed by the signed-chain/package fixtures. Test
selection is not permission to reuse stale native source/binaries or skip the
ordinary release signature/policy/read-back chain.

Full Windows also executes the real Workspace recovery/cleanup fixtures from
`trelio-workspace.test.mjs`: isolated retention with live siblings, protected
local changes, retention-only source discovery, persistent checkout reuse and
repeat recovery opens. Path-parser tests alone do not cover native deletion.
Pre-metadata recovery composes the actual encrypted own-Run/related-history
opener with an empty original and a preserved partial sibling. Server work and
local edits refuse without overwriting their source. The real-Git negative
suite also covers staged-only, ignored, assume-unchanged/skip-worktree, divergent
history, metadata, special roots/junctions and cancellation; each case compares
every source byte and Git metadata before/after the refused read.

Last-window shutdown tests materialize the real extension worker and assert
auth -> windows_closed -> transport-close order for manual and ordinary exits.
Nonfinal windows retain transport; ordinary network reconnect stays available,
but an already queued timer cannot revive a deliberate stop. The existing native
manual close/ready/logout/crash fixture still requires actual browser exit and
exact snapshot counts on every OS, with no extra time, input replay or relaxed
logout assertion.

## Exact tag verification

Cross-repository shell checks accept the historical omission of a startup
timeout where earlier manifests inherited the Codex default. Both current Codex
MCP registrations use exactly `startup_timeout_sec: 60`. Routing and OAuth fields
stay strict. The isolated dead-mirror-writer fixture reports only a closed stage and
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
The exact Chromium BFCache receiver-close constant uses this same readonly
mapping. Materialized-worker plus real-controller tests cover acknowledged
transition, initial refusal, unknown input, the original thirty-second deadline
and restart without replay. Native input/success assertions remain unchanged.
The parallel native fixture retains the original post-sibling scroll response
and closed pending phase, distinguishing wheel ACK from capture without extra
input, observation or retries. Passing another lifecycle never erases a failure.
The headed extension suite also forces one fresh owned window into minimized
state. Its screenshot must succeed, one wheel must actually scroll the document,
the synthetic receiver must observe exactly one wheel, the spent frame must
refuse, and the native window must remain minimized. This deterministic case
covers the compositor visual-state wait independently of hosted focus timing;
it neither replaces the three two-owner lifecycles nor weakens their clocks.
Materialized-worker tests additionally cover fixed renderer activation before
navigation, manual detach/re-entry, native detach, fail-closed activation and
production refusal of the fixture-only window controls.
The Linux native minimized gate covers its own fresh-surface launch selection,
separately from Windows native occlusion. A portable switch assertion is not
native acceptance; the original screenshot, one wheel, actual scroll and
unchanged minimized state must all pass on the real Openbox/X11 display.

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
