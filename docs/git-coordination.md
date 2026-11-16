# Maintainer Git coordination

`npm run git:integrate` runs a FIFO shared by all linked worktrees of one clone.
The first ticket fetches and rebases the final candidate, runs the affected
local checks, then pushes main and reads it back. Release tickets publish their
branch and dispatch full hosted checks. The final check runs inside the ticket.
Do not edit a queued branch, HEAD or files. Another clone remains an external
writer: remote advance stops transport and requires a deliberate new enqueue.

For an explicitly authorized release use
`npm run git:integrate -- --tag vX.Y.Z`. Prepare the intended source/manifest
version before enqueue. The ticket checks that exact version against remote tags
BEFORE CI. A collision stops before the expensive gate; it never overwrites or
silently renumbers a release. Tag creation follows verified CI and main+tag push
is atomic. Artifact signing/activation and their CAS/read-back remain separate
existing release steps. This command alone is not a product/runtime release.

For an already integrated exact main SHA the release ticket publishes its branch
and uses the same full dispatch. It reuses successful evidence for the exact SHA
and verifies the latest run, attempt, required jobs and native receipt.

The short existing main mutex serializes FIFO admission and state changes;
the durable ticket protects CI. Worktree creation therefore remains available.
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

`scripts/git-coordinator.mjs`, `scripts/git-hosted-ci.mjs` and
`scripts/git-background.mjs` form a maintainer-only
development package, consumed by related repositories at an exact immutable Git
commit. Its package exports are `./coordinator`, `./hosted-ci` and `./background`. Only these three
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

Use `npm run git:integrate -- --finish-worktree` for ordinary development
in Codex. The launcher returns after durable admission. A chat reports the
exact ticket as queued and ends its turn. The worker inherits no terminal
or chat output pipe and runs the repository's own FIFO, CI and guarded
transport while the computer is on. No scheduler or chat wake-up is
registered. On a later request, read `--status TICKET` once from canonical main.

With `--finish-worktree`, guarded success triggers local cleanup inside
the same worker. It checks fresh remote ancestry and the exact committed
candidate again, removes only its clean registered worktree without force,
and removes its branch by SHA compare-and-swap. A refusal is recorded as
`localCleanupState=pending` without changing integration success. Use
the repository's cleanup helper if a retry is safe. Failed integrations
retain their worktrees. `--finish-worktree` is only available for detached
ordinary tickets. Manual `git:integrate` and its `--background` alias leave
local cleanup to their caller.

An explicit terminal wait uses `--wait TICKET` from canonical main. For an
already authorized full release in Codex use `--wait --tag EXACT_TAG` so the same
turn can continue mandatory publication/activation after verified integration.
Wait in the same tool session without reading waiting logs or narrating CI.
Report terminal failure or a decision that requires the user. `--foreground`
remains diagnostic. Stopping a waiter does not stop the detached worker.
The final JSON has the same schema as `--status TICKET`; only
`succeeded` exits zero. Never infer release completion from that receipt.

The launch JSON identifies the ticket, original/current SHA, branch,
worktree and private log. `followUp.action=end_turn_after_admission`
reports the active worker and includes the exact `statusArgs`. An already
settled worker returns `review_integration_result`. Plain `--status`
returns an observation.

A repeat launch of the same live candidate returns its existing ticket,
under the same admission mutex. Incompatible cleanup mode, a different
candidate/tag or an unknown/dead owner require review. A lost acknowledgement
is ambiguous: inspect the printed worker identity and admission before a retry.

The worker records its terminal receipt under
`trelio-git-coordination/results/` before releasing its ticket. Private
logs live in `logs/`. A retained ticket takes precedence over a pre-crash
receipt. Results keep the immutable source and rebased SHAs and never replace
CI evidence or live push authorization.
