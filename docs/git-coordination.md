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
Canonical pre-push checks live process ancestry, exact worktree/branch/SHA/tag
and verified ticket state. A caller-authored boolean, direct main/tag push or
old transport wrapper cannot borrow the slot. Required CI remains repository
owned: runtime recomputes its full native PR plan and checks every required OS
job/attempt before permitting transport. A new failed attempt never reuses an
older green run. No test runner or VM is started as a fallback by this package.

`npm run git:integrate -- --status` reads retained tickets.
`npm run git:integrate -- --recover TICKET` removes exactly one ticket only when
its same-host owner AND isolated process group are dead. SIGKILL does not make
live grandchildren safe to ignore. There is no timeout-based takeover or broad
process/lock cleanup. Failed CI/rebase retains the source; ordinary settled
failure frees the slot, while unknown/live children keep it fenced.

`scripts/git-coordinator.mjs` and `scripts/git-hosted-ci.mjs` form a maintainer-only
development package, consumed by related repositories at an exact immutable Git
commit. Its package exports are `./coordinator` and `./hosted-ci`. Only these two
files enter the npm package. They never enter signed host-runtime, stable plugin,
provider packages or runtime/model instructions. Repository-specific policy,
CI adapters, hooks and transport stay with each owner; implementations are not
copied across repositories. Updating this infrastructure does not release a
runtime/plugin or change any minimum version. Trelio's existing product queue
retains its hosted-pause/local-evidence policy and uses the same release-before-CI
invariant without replacing its mature runner/evidence implementation.

Tests use real bare remotes, linked worktrees and isolated worker groups. CI
evidence is synthetic only in fixtures; production hooks/rebase/transport are
exercised, including concurrent CI, occupied version, waiting-source mutation
and dead-owner/live-descendant recovery.
