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

`npm run git:integrate` always launches in the background; `--background` remains
a compatible explicit alias. Append `--tag EXACT_TAG` for an already authorised
release. Use `npm run git:integrate -- --wait [--tag EXACT_TAG]` in Codex.
It starts or reuses the same detached worker, prints the admitted ticket when
waiting, and keeps the current tool session open until the status is no longer
active. `--foreground` remains a diagnostic mode whose signals reach its worker.
To resume observation after interrupting the wait, run
`npm run git:integrate -- --wait TICKET` from canonical main. This reads the
exact ticket in the same clone without starting or signalling a worker.
The final JSON has the same schema as `--status TICKET`. Only `succeeded` exits
zero. Failure, interruption, recovery and unknown status require outcome review.
There is no wait timeout while a ticket is active.
The launcher exits only after the isolated worker acknowledges durable admission.
Its JSON contains ticket ID, original/current SHA, worktree, branch and private
log path. The worker inherits no terminal/stdin/output pipe, progresses FIFO
without a model turn, and retains the existing repository CI/transport guards.
It is not automatically restarted. The computer must stay on; local chat
follow-up also needs the Codex desktop app running. The launch JSON includes
`followUp.action=arrange_supported_chat_follow_up`, a 15-minute interval, the
canonical checkout, `blockingWaitArgs` for this ticket and
`schedulingState=not_confirmed`. These are next steps,
never evidence that a scheduler was saved. Reattachment returns the same guidance;
plain `--status` remains an observation without a new scheduling request. If the
worker has already settled, launch instead requests `review_integration_result`.

Repeating background launch for the same live candidate returns its existing
ticket. Concurrent admission is serialized by the same mutex. Another candidate,
tag or unknown/dead owner refuses instead of spawning a replacement. A startup
timeout/lost acknowledgement is ambiguous: inspect queue and the printed worker
PID/log before retrying. Do not infer failure from the launcher's exit alone.

The worker writes an owner-only atomic result under the common Git directory's
`trelio-git-coordination/results/` before removing its ticket; logs live beside
it in `logs/`. Results keep original/rebased SHAs and distinguish actual guarded
success from failure/interruption/recovery. A retained ticket takes precedence
over any pre-crash receipt. These observations never replace fresh Git read-back,
CI evidence or the canonical push guard. No state/log enters installed packages.

An instruction to finish the development task authorises its temporary follow-up
within the same scope; it does not authorise a new release or another task:

1. Immediately after confirmed active admission, arrange ONE follow-up in the SAME
   chat. Where the client's native tools and policy permit scheduled follow-up,
   create or update a heartbeat for every 15 minutes. Save exact ticket,
   canonical checkout, task worktree, branch, original SHA, authorised release tag
   (if any) and remaining post-integration steps in its readable prompt. A repeated
   wake/manual continuation reuses that automation and ticket.
2. Confirm the follow-up was actually saved before ending the active turn; an
   intent, launch JSON or `not_confirmed` field is insufficient. Without permitted
   scheduling, immediately attach `--wait TICKET` and keep the active tool session
   until it exits. A tool yield returns control to the agent while the waiter
   remains active. Continue waiting in that session. If the client cannot run
   the command, report that concrete blocker. Do not substitute model
   `sleep`/`--status` calls or promise an automatic return.
3. On each wake read exact ticket status from the same clone. While active, do no
   edits/rebase/new CI/enqueue and end the check quietly. Notify only on completion,
   failure, a meaningful change or required human action, never every 15 minutes.
4. For `succeeded`, verify identity and fresh remote state, finish the task worktree
   through its owner helper and complete already authorised publication/activation
   and read-back. Integration success alone never completes a release.
5. For failure/interruption/unknown state first establish the actual outcome;
   never blindly rerun a push or CI. Use normal exact recovery only after its
   guards pass. Diagnose the same task autonomously where authorised; pause the
   heartbeat if a human decision blocks progress. Stop it after all required work
   and cleanup are verified, so the monitor cannot wake forever.

Do not put a 15-minute model wake between FIFO tickets: the live worker starts
the next operation immediately. Do not remove another ticket/lock, add age-based
takeover, relax CI/ACL or enable broad retries to implement sleeping.

Tests use real bare remotes, linked worktrees and isolated worker groups. CI
evidence is synthetic only in fixtures; production hooks/rebase/transport are
exercised, including waiting behind another ticket, reattachment after stopping
the reader, failure/unknown exit status, concurrent CI, occupied version,
waiting-source mutation and dead-owner/live-descendant recovery.
