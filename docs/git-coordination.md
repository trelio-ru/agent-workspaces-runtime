# Maintainer Git coordination

`npm run git:integrate` coordinates all linked worktrees of one clone.
Ordinary tickets run in admission order. They take priority over releases
until a release claims the empty ordinary queue under the main mutex.
Release tickets claim in admission order with no extra collection delay.
After claim, later arrivals wait behind the release. The owner fetches and
rebases the final candidate, runs CI, pushes main and reads it back. Release
tickets publish their branch and run the repository's release CI.
Do not edit a queued branch, HEAD or files. Another clone remains an external
writer: remote advance stops transport and requires a deliberate new enqueue.

For an explicitly authorized release use
`npm run git:integrate -- --tag vX.Y.Z`. Prepare the intended source/manifest
version before enqueue. The ticket checks that exact version against remote tags
BEFORE CI. A collision stops before the expensive gate; it never overwrites or
silently renumbers a release. Tag creation follows verified CI and main+tag push
is atomic. Artifact signing/activation and their CAS/read-back remain separate
existing release steps. This command alone is not a product/runtime release.

A second request for the same tag and original SHA can join a waiting release
across worktrees. It acquires no ticket and leaves its worktree available for
normal cleanup. A different source for the same tag is refused before CI.
Different tags keep independent tickets. A caller marked `releaseRole=observer`
sees the same integration result, with exit 3 for a successful observation so
that shell chains cannot start a second publication. With a detached launch it
gets the ticket immediately. Only the original launch continues the release.
Reading `--wait TICKET` reports outcome without transferring ownership.

For an already integrated exact main SHA the release ticket publishes its branch
and uses the same full dispatch. It reuses successful evidence for the exact SHA
and verifies the latest run, attempt, required jobs and native receipt.

The short existing main mutex serializes ordinary admission and release claim.
A deferred release starts as `<ticket>.release.json`. The claim atomically
renames it to the numeric filename used by existing guards with the same ticket
ID. Older workers therefore see the release in their FIFO only after claim.
A durable ticket protects CI. Worktree creation remains available.
Waiting workers read the first ticket and its process inventory under that same
mutex, so normal predecessor removal/exit is an atomic handoff rather than a
false dead-owner failure. An unchanged dead ticket still requires exact recovery. An occupied mutex may also
be removed normally between its owner-file read and the process inventory.
Only fresh no-follow absence or a different directory identity permits a new
acquisition attempt; an unchanged dead/unknown claim is never removed or stolen.
The five-second allowance for an unpublished owner belongs only to that exact
directory's observed ownerless interval, not the whole preceding live-owner wait.
Fresh absence/replacement resets the observation, and a published owner ends it;
an unchanged empty claim still refuses without removal or CI.
Tests force disappearance/replacement and a late ownerless interval after a long
live-owner wait; unchanged dead and ownerless claims remain fenced.
The runtime shell transport also shares this mutex. It waits for natural release
of a confirmed live same-host `FIFO coordination` holder, or an unpublished-owner
interval, for at most 100 acquisition attempts with 50-ms waits. This budget is
not renewed by owner changes. It never removes a dead/unknown/foreign claim,
borrows ownership, repeats a push or renews CI/admission. The normal pre-transport
and pre-push owner/SHA/tag checks remain mandatory. Refused owner-file prose is
never dumped to the diagnostic stream. Real Git fixtures cover the live-FIFO
overlap and preserve unrelated/dead claims before ordinary guarded tag transport.
Canonical pre-push checks live process ancestry, exact worktree/branch/SHA/tag
and verified ticket state. A caller-authored boolean, direct main/tag push or
old transport wrapper cannot borrow the slot. Required CI remains repository
owned: ordinary runtime checks bind the live ticket to the published base and
source. For releases, the verifier recomputes the full plan and checks every
required OS job and attempt before permitting transport. A new failed attempt never reuses an
older green run. No test runner or VM is started as a fallback by this package.

`npm run git:integrate -- --status` reads retained tickets.
`npm run git:integrate -- --status TICKET` returns one JSON observation, including
a retained terminal result. `waiting`, `running` and `verified` are active states;
`succeeded` confirms completed integration, `failed`/`interrupted` require outcome
review, `recovery_required` preserves a dead/unknown owner's fence, and `recovered`
only records removal of that fence. `unknown` is never success.
`npm run git:integrate -- --recover TICKET` removes exactly one ticket only when
its same-host owner AND isolated process group are dead. SIGKILL does not make
live grandchildren safe to ignore. There is no timeout-based takeover or broad
process/lock cleanup. Failed CI/rebase retains the source; ordinary settled
failure frees the slot, while unknown/live children keep it fenced.

`scripts/git-coordinator.mjs`, `scripts/git-hosted-ci.mjs`,
`scripts/git-background.mjs` and `scripts/git-follow-up.mjs` form a maintainer-only
development package, consumed by related repositories at an exact immutable Git
commit. Its exports are `./coordinator`, `./hosted-ci`, `./background` and
`./follow-up`. Only these four
files enter the npm package. They never enter signed host-runtime, stable plugin,
provider packages or runtime/model instructions. Repository-specific policy,
CI adapters, hooks and transport stay with each owner; implementations are not
copied across repositories. Updating this infrastructure does not release a
runtime/plugin or change any minimum version. Trelio's existing product queue
keeps its hosted-pause and local-evidence policy for releases and uses the same release-before-CI
invariant without replacing its mature runner/evidence implementation.

## Published task branch cleanup

Runtime enables `remoteBranchCleanup` in its repository policy. Before the main
transport, the worker retains the exact expected origin SHA of its task branch.
An ordinary ticket uses the observed pre-rebase remote SHA, after confirming it
belongs to the original source. A release ticket records the SHA it published
for hosted CI. Local-only tasks have no remote branch to clean.

After guarded main read-back, the worker checks the integrated commit on origin,
deletes only that task ref under an explicit SHA lease, and reads it back even
after an ambiguous transport response. A changed ref is preserved and recorded
as `remoteCleanupState=changed`. A transient refusal leaves successful
integration with `remoteCleanupState=pending`. Run
`npm run git:integrate -- --retry-cleanup TICKET` from the same clone to retry
only cleanup. The retry checks live ancestry and the recorded lease, without CI,
rebase, or push to main. Completed cleanup stays a no-op on repeat. The separate
`git:finish-worktree` removes the local worktree and branch.

Resolve pending remote cleanup before closing an authorized release. The
tagged artifact build, signing and activation keep their own existing gates.
Other repositories must opt in through their own policy. Older receipts and
unrecorded remote refs are not automatically pruned.

## Background integration and chat follow-up

Ordinary development in Codex uses `npm run git:integrate -- --finish-worktree`.
On macOS, the launcher captures the exact `CODEX_THREAD_ID` and installed
`CODEX_APP_RUNTIME_CLI_PATH`, registers durable follow-up BEFORE worker spawn,
then returns the admitted ticket with `chatFollowUp`. End the turn after that
confirmation. No model heartbeat or polling is required. Manual callers and
other platforms retain background integration without claiming a chat wake-up.
Explicit `--wait` and release tickets retain their synchronous completion flow.

One shared user LaunchAgent runs every thirty seconds and at login. Its immutable
maintainer code and owner-only event journal live outside task worktrees, under
`~/.local/state/trelio-git-follow-up/`; it never enters a signed runtime, plugin,
provider package or production service. Registration verifies the installed
service before starting a worker. Failed setup does not silently enqueue work
without its promised follow-up. A newer compatible service is not downgraded by
an older repository dependency.

Each registration binds the real clone queue directory, persisted unique log
nonce, original source SHA, branch, task/canonical paths and original chat UUID.
The nonce joins both retained tickets and terminal receipts, including fast
completion and a lost admission ACK. Equal numeric tickets in different clones
cannot collide. Reattachment keeps the original chat; it never selects `--last`
or redirects another chat's integration. One chat can own many simultaneous
integrations across repositories. Their records, attempts and acknowledgements
remain independent, and native Codex queues their input in that same chat.

The shared coordinator's exact reader and four-file import closure are pinned
outside the task source under the private service state. Canonical wrappers may
retain an older installed dependency; they are not used as the shared reader.
Trelio's separate product queue retains its canonical repository entry point.
Both use `--status TICKET`, so an active or dead-owner ticket outranks a receipt.
It never removes fences, kills integration children, rebases, retries CI or pushes.
Waiting/running/verified states do not invoke a model. Terminal outcomes and
observation failures produce bounded structural callbacks, without raw logs,
credentials, inherited app pipes, tool proofs or model/account environment.

Delivery uses the installed native `codex queue --thread UUID --message TEXT`.
This has been exercised with a busy and an idle original Desktop chat. A command
exit code is not agent completion; `--resume` is not required for the observed
running-Desktop queue consumer and can warn when no separate daemon exists.
Application restart delivery is a required durable/native-queue property, but
has not been established by the live Mac acceptance test. Do not claim offline
or unloaded-Desktop delivery from those two successful cases alone.

Before its single native write, the service durably creates an exclusive attempt
marker. Concurrent drains, process restart and lost replies never repeat it.
Ambiguous writes remain `uncertain`; only positive evidence from the public
App Server queue/history reader can reconcile them as accepted. Bounded absence
is never permission to send again. The reader never resumes the thread or starts
a turn: a separate reader can report an active GUI turn as interrupted, so that
status must not be used as ownership or completion evidence. A damaged individual
registration produces a local diagnostic without starving other repositories.

A callback is clearly labelled automatic data about previously authorized work,
not a new human request or release authority. Read canonical AGENTS.md, inspect
its exact event with the returned service script's `--inspect EVENT`, then review
the repository's status and live origin/main before reporting success or retrying.
Continue only the original authorized task. A successful integration with pending
cleanup requires cleanup only, not another CI/main push. A failed/recovery outcome
requires real diagnosis, preserving unrelated work and the existing guards.
Record receipt with `--ack EVENT`; this does not attest integration success.
An immutable acknowledgement wins a late sender update and is never a new wake.

The worker may clean its exact clean worktree after guarded read-back. Service
state and pinned/shared or product status readers survive source cleanup and use
the explicit canonical cwd, so source cleanup does not
lose the result. A continuation uses explicit existing task/canonical paths and
never edits canonical main. Each later enqueue receives its own subscription.
The FIFO slot is released independently of chat delivery. Release publication,
activation, human approvals and production verification retain their own gates.
