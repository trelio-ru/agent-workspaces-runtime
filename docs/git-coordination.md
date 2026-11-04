# Maintainer Git coordination

`npm run git:integrate` runs a FIFO shared by all linked worktrees of one clone.
The first ticket alone fetches/rebases the final candidate, publishes its task
branch, creates/reuses its PR, verifies exact hosted CI, pushes main and reads it
back. Targeted tests may precede enqueue; final CI belongs inside the ticket.
Do not edit a queued branch, HEAD or files. Another clone remains an external
writer: remote advance stops transport and requires a deliberate new enqueue.

For an explicitly authorized release use
`npm run git:integrate -- --tag vX.Y.Z`. Prepare the intended source/manifest
version before enqueue. The ticket checks that exact version against remote tags
BEFORE CI. A collision stops before the expensive gate; it never overwrites or
silently renumbers a release. Tag creation follows verified CI and main+tag push
is atomic. Artifact signing/activation and their CAS/read-back remain separate
existing release steps. This command alone is not a product/runtime release.

For an already integrated exact main SHA, the hosted verifier reuses its PR gate
without creating an empty PR. It still checks the latest exact run/attempt and
every required job and native receipt. Missing or failed evidence blocks release;
being on main is never a substitute for CI.

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
Canonical pre-push checks live process ancestry, exact worktree/branch/SHA/tag
and verified ticket state. A caller-authored boolean, direct main/tag push or
old transport wrapper cannot borrow the slot. Required CI remains repository
owned: runtime recomputes its full native PR plan and checks every required OS
job/attempt before permitting transport. A new failed attempt never reuses an
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
retains its hosted-pause/local-evidence policy and uses the same release-before-CI
invariant without replacing its mature runner/evidence implementation.

## Background integration and chat follow-up

Use `npm run git:integrate -- --background` (or append `--tag EXACT_TAG` for an
already authorised release) when integration will wait for FIFO or CI. The
launcher exits only after the isolated worker acknowledges durable admission.
Its JSON contains ticket ID, original/current SHA, worktree, branch and private
log path. The worker inherits no terminal/stdin/output pipe, progresses FIFO
without a model turn, and retains the existing repository CI/transport guards.
It is not automatically restarted. The computer must stay on; local chat
follow-up also needs the Codex desktop app running.

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

1. After confirmed active admission, create or update ONE heartbeat in the SAME
   chat for every 15 minutes, using the native automation tool. Save exact ticket,
   canonical checkout, task worktree, branch, original SHA, authorised release tag
   (if any) and remaining post-integration steps in its readable prompt. A repeated
   wake/manual continuation reuses that automation and ticket.
2. Confirm the automation was actually saved before ending the active turn.
   Without a working scheduler, continue foreground observation or report the
   concrete blocker; do not promise an automatic return. Other clients must use
   their supported scheduler explicitly, never pretend Codex tools are present.
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
exercised, including concurrent CI, occupied version, waiting-source mutation
and dead-owner/live-descendant recovery.
