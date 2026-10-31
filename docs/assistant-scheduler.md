# Runtime-owned assistant cycles and native Codex

The product decision is to keep one permanent Codex chat for each accepted task,
but own cyclic wake-ups in the assistant runtime. No built-in Codex automation,
RRULE file or private desktop API is claimed. Backend/provider authority still
owns company/task ACL, owner approval and the classification of incoming events.

`trelio-assistant-scheduler.mjs` stores bounded structural task/thread references,
cadence, timezone, next-run timestamps and positive native receipts in the same
private SQLite handle as the inbox. It is a runtime service component, not an
installed/activated daemon or a substitute for a signed assistant plugin. Private
DB lifecycle, source polling and backend projection are wired by the host-only
`trelio-assistant-coordinator.mjs` component. Dedicated plugin installation,
business MCP admission and supported Windows readiness still gate unattended
activation. No existing pilot or human-plugin session is silently migrated.

### Pre-native reservation recovery

An expired reservation remains review-only unless the SAME trusted coordinator
holds its current private lease and the SAME delivery has durable
`native_started=0`, an exact protected active pass and full negative native
summary coverage. `uncertain` alone is never absence: missing pagination,
duplicate/invalid markers, running/failed/completed history or read errors refuse.
The SAME native account/model preflight runs once, then host-only
`beforeInvocation` performs existing `renew` with explicit `preNativeRecovery`.
A UUID/previous lease revision is committed first in the SAME v12 delivery row;
lost response/restart repeats that exact intent, without another delivery/chat.
Setup/identity and inbox leases, current native binding/model and the zero-start
bit are rechecked around HTTP and before the irreversible start CAS. Watchdog
renewal starts only after this receipt settles. Native registration history,
outcomes or operations deny recovery independently; no closed pass, source ACK,
event processing or health clear is manufactured. Real committed work remains
required to clear a dispatch incident. Old parent processes can use this through
the current signed tick worker without restarting the supervisor.

### Automatic terminal continuation

A positive native completed turn without a business receipt is retained, not a
bit-zero reservation. The SAME trusted coordinator uses `task-pass/renew` with
`continuation=review|read|resume, automatic:true` under the original task authority.
Native ledger v2 freezes the original terminal turn, protected pass, binding,
model pair and SQLite lease; it returns a NEW independent invocation marker,
without a human question or notification for this technical recovery.

The original pass/delivery/chat and all operation history survive. Resume renews
that pass once by CAS; an uncertain response permits read only. SQLite schema13
retains structural continuation history in the same delivery, preserving schema12
recovery JSON and the original native-start bit. Each marker has its own monotonic
start flag committed before spawn. No transcript, prompt, reply or claimed
business result is journaled. Before launch the host repeats positive terminal
read-back, protected identity/pass, fresh ACL/model/lease and full negative new
marker coverage. Unknown/running/generically failed/ambiguous history and unknown new starts
never authorize replay. Schema14 preserves the whole legacy JSON unchanged and
appends new structural intents to an indexed table in the SAME SQLite journal.
Latest-intent and per-prerequisite count reads are bounded, without deleting
old starts or adding another pass/chat. Twenty remains the attempt limit for
one actual prerequisite fingerprint: the native trusted hook definition hashes
and the exact immutable signed worker version selected by the existing loader.
Switching back to a spent fingerprint does not reset its count. A newly repaired
definition/runtime may therefore continue the retained pass automatically; a
new model-supplied epoch, history reset or cap increase is not accepted.

Before creating/renewing a terminal-continuation intent the production host reads
the original native authority. A task that became `done` permits only settlement
of this retained pass's existing own canonical task Workspace Run, created during
that pass. Native task reads, observed registration/renewal and ordinary Run
save/finish keep current device/model/ACL/recipient/lease/CAS checks. There is no
new pass, Run, named/foreign/older Run, related scope, domain action, skill or
Secret execution. The host retains the ORIGINAL protected binding generation,
never adopts the scheduling generation advanced by `done`. Start/watchdog SQLite
renewal accepts terminal state only for the already native-started task delivery;
source snapshot checks, monotonic marker and current native pass remain required.
Original source routes use the existing fixed lookup with exact `routeIds` and
`settlementPassId` from that protected pass. Native lookup rechecks the current
source/device and retained canonical Run, returning original structural receipts
only, including before renewal of an expired retained lease. This grants no new
body/read slot, processing or ACK. Invalid/reconfigured/revoked sources still stop.

Before creating/renewing a terminal-continuation intent the production host reads
native `hooks/list` for the exact task folder. It requires the three enabled,
trusted dedicated-plugin hooks, no inventory errors/warnings and valid native
definition hashes. Each real task/intake execution checks again before its
irreversible start bit. Missing/untrusted hooks report the existing closed
hook-review incident without launching another model turn; tool-free READY
provision is not this check. Inventory/fingerprint never replaces actual hook
dispatch, live native pass/ACL/lease or observed one-use proof. No config/trust
mutation, automatic Codex restart or human-plugin fallback is performed.

A retained v1 pending technical owner question is migrated through the same ledger,
keeping its UUID/history and closing only its answer surface. An explicit refusal
or Other remains stopped. No human answer is fabricated. Legacy readers cannot
inherit v2 without the explicit automatic flag. Already-resumed or unknown starts
are read only; the original command is never replayed.

The SAME executor continues the permanent chat, instructing the agent to inspect
existing receipts and accepted state, decide what remains and continue without
repeating uncertain external actions. Sensitive-action approval stays independent.
Only ordinary exact business outcome/native receipt completes original events,
advances schedule or clears health. No new model tool, shell ABI, executor, vault,
queue or pass-close shortcut exists. Old supervisors select the current signed
worker between ticks without a Codex restart.
A retained pass does not block its own repair update indefinitely. Health may
load the signed update only after the SAME private coordinator lease fences work
and the exact currently journaled native marker has positive completed/turn-ID
evidence. A pending renewed/unknown start, running/failed/ambiguous history or
changed identity/journal refuses. For a taskless intake, the exact ORIGINAL
completed/failed marker with a real turn UUID also permits only this code update,
under the SAME lease and unchanged protected pass/source/journal snapshot. A
running or ambiguous intake still refuses; this never settles its outcome.
Downloading preserves every pass/start/history
bit and never clears business health; the next worker independently selects the
verified package. No model invocation, Codex restart or owner question occurs.


### Native model-capacity recovery

Only an exact stored FAILED turn with native `codexErrorInfo=serverOverloaded`
(or the exact legacy Desktop capacity message with absent/`other` error info)
permits this recovery. Quota/auth/transport failures, generic HTTP 503, quoted
messages, interrupted/running/unknown history and missing/duplicate markers do
not. Native diagnostics stay in memory and project to `failure:model_capacity`.

The SAME delivery retains a schema19 content-free episode: first observation,
latest failed turn/marker, saturated delay step and due time. Pauses are 1, 5,
15 and then 30 minutes after each failure, indefinitely; polling/restart cannot
reset the clock. Each attempt is a NEW monotonic marker in the SAME permanent
chat. Task work renews its SAME native pass through the ordinary continuation
receipt, with fresh hook/model/ACL/lease and full negative child-marker coverage.
Its prompt requires inspecting saved state and operation receipts first; no
original command, send, mutation or provider ACK is replayed. Capacity entries
append to the existing indexed ledger under a separate budget key, without
spending or resetting the generic twenty-attempt hook-repair budget.

A failed initial tool-free PREPARE/READY also preserves its one provision and
persisted chat UUID. A new empty GUI-queued READY may follow exact failed native
read-back and a new durable local start fence; no second thread/create/bootstrap,
foreign writer resume, settings turn or business tools are permitted. A later
unknown attempt immediately restores the ordinary dispatch uncertainty fence.

Health protocol v3 adds only `codex_capacity_wait` and an independent server
first-observation latch. The normal account notification engine warns once after
15 minutes; attempts continue. Successful committed business/native recovery
clears only the appropriate obligations and emits one recovery if a warning was
sent. Short episodes remain silent. Metadata/READY, quotas or an unrelated
login/hook success cannot clear the latch. V2/legacy health readers hide the new
reason while retaining exact CAS; backend/migration must precede runtime rollout.
The signed tick returns an optional closed `nextPollMs` (1s–5min) so current
supervisors honour the first one-minute retry. An already-running old supervisor
keeps its existing five-minute granularity until its normal lifecycle ends; its
unknown-work reporter cannot turn the new paced wait into dispatch review.

An owner-private source question uses that same pacing clock (schema21 on the
original owner-intake table), not the thirty-minute lease as an error timer.
Only the exact native FAILED/model_capacity turn, still-unread native body,
no task or outcome receipt and absent local send/positive/abandon fences admit
early retirement through the existing device cancellation. The coordinator
first freezes the local row to UNCERTAIN, then durably consumes its one cancel
attempt before HTTP. Unknown cancellation permits exact GET only, including
after expiry; a still-LEASED result never permits another POST or model launch.

Positive CANCELLED read-back plus the original terminal marker permits one new
native intake for the SAME signed event, source, account and owner. It reuses
the SAME permanent chat, fresh owner/source/model/hook admission and a fresh
native lease/marker; the old receipt, deadline, start bit and history remain
immutable. No root resend, new task/Run, ACK, provider replay or model fallback
is involved. The inherited first observation/step/due time survives SQLite
restart and subsequent failures (1/5/15/30 minutes). The existing total owner
retry-chain bound of twenty remains; reaching it retains review rather than
starting another invocation. Generic changed-hook recovery remains independent.
Body-read, attempted/unknown send, created task, running/unknown turn or a
capacity-looking error does not admit this path. Native empty READY recovery
retains its separate provision contract above. Tests compose the worker tick,
production host factory, real device HTTP codec and SQLite reopen, including
lost committed/noncommitted cancellations and exactly one reply.

## Cycles

Cadences: 30 minutes; 1, 3, 6, 12 hours; daily, weekly, fortnightly, monthly.
Short cycles use elapsed time. Day/week/month retain the original local wall time;
month-end clamps per occurrence without drifting Jan31 -> Feb28 -> Mar28. DST
chooses the earlier overlap occurrence and moves a missing local time forward.
Missed periods coalesce to one pass and the next future slot, never a catch-up
burst. A task may adjust its cadence after substantive assessment; the host
validates the enum, current task scope/authority and CAS before recording it.
No content/reason/instructions are stored in SQLite.

Registration is idempotent for the same canonical origin/assistant/company/task,
source binding and native thread. A thread cannot be reused for a different task;
a repeated request cannot replace the permanent chat. `done`, pause and revocation
stop the schedule. Local active state never permits execution without fresh
backend authorization. Cross-company tasks retain separate keys and references.

The trusted `completeInsideInboxTransaction` callback advances next-run and
records completion in the inbox transaction. Callback failure leaves both event
processing and due time unchanged. `lastCycleAt` is recorded only for a genuine
scheduled pass, not a delayed mention or merely saving a schedule. These tests
use an injected clock; they are not proof of a live Windows timer run.

## Native adapter

### Durable human goal

Every business pass receives a strict structural task context over stdin:
assistant/company/task UUIDs and `assistants/<assistantUserId>/WORK.md`. The host
computes the path from the immutable assistant ID, never a name or message/path
supplied by a source. Missing or extra fields fail before native I/O. Separate
tasks/companies use their canonical Workspace roots; several assistants in one
Workspace keep different files. READY probes have no task-state instruction.

The installed task-worker skill owns the Markdown format and continuation flow:
read shared context and own state, preserve the human goal and completion criteria,
record confirmed progress, pending replies/owner decisions, uncertain sends and
the next justified action/wake. Save with the common Workspace Run/CAS; this is
ordinary company task data, not AGENTS, a local transcript or new authority. The
coordinator does not read/cache the Markdown or store goal text in SQLite.

Waiting finishes a pass, not the goal. The task worker keeps a recurring check,
returns to the same chat on permitted events, and verifies real send/read/schedule
outcomes before progressing. Fulfilment or authorized cancellation stops only
this assistant's cycle after server confirmation; it does not complete another
assistant's part or the entire task. Shared task files retain normal ACL and E2EE;
no private credential belongs in them. The backend-confirmed outcome below owns
goal-stop; native prompt/path tests alone do not prove activation readiness.

### Mention-derived discussion

Native assignment discovery also accepts current canonical mentions without
adding the assistant to the participant list. The assistant owner's mention
allows the existing start flow; another author's first connection still needs
the SAME owner decision. Mention access never grants project/admin/Workspace
rights. The native binding and immutable pass select `workMode:discussion` for
comment-only access; ordinary editable task access keeps `workMode:task` and
all existing material evidence. The host never infers mode from message text.

A discussion uses the SAME queue, observed proof, dedicated tools and permanent
task chat. Its stdin locators omit `workStatePath` and reject external source
references. The prompt asks for the permitted task/rules/discussion read and an
ordinary native task reply. Completion supplies exact `replyCommentId`,
`goalState:completed`, `noChange:false`, without Workspace/material or source
processing fields. The native handler independently requires this pass's own
published comment effect and exact unchanged revision/current access. A model
ID, successful turn or unrelated comment cannot replace that receipt. Encrypted
comments use the SAME content adapter; completion does not read company keys,
Workspace containers or create a WORK.md. Restricted skills/Secrets/task edits
and external ACK remain denied by the server, not merely the prompt.

Initial discussion chat registration immediately pauses its timer, before any
native schedule report. Its accepted inbox and original queued mention remain
runnable without a second mention. Confirmed reply completion stops the timer;
restart/elapsed time/ordinary comments cannot create work. A fresh real mention
or permitted owner answer can resume the SAME chat. A later native full task
assignment uses ordinary material/goal/cycle semantics. The mode is closed
structural presentation metadata, not another journal or an authorization flag.

### Native invocation

The permanent task UUID is a **visible Desktop chat**. The runtime uses the
public [App Server](https://learn.chatgpt.com/docs/app-server) methods and the
registered `codex://threads/<UUID>` handler; it never executes business work
through `codex exec`, resumes/steals the GUI writer or creates a hidden fallback.
A tool-free native bootstrap first persists the new UUID and executes an empty
READY with explicit company model/effort. Zero-turn settings alone do not suffice:
Desktop restores the last executed pair. This initial turn has a distinct
`TRELIO_ASSISTANT_DESKTOP_PREPARE` marker and earns no provisioning receipt.

After closing ONLY that owned bootstrap child, the SAME common system URI opener
hands this exact UUID to Desktop. The public `thread/queue/add` (experimental
capability) submits the second READY to its existing GUI writer. Exact native
terminal read-back of the ordinary provision marker proves that the GUI queue
actually ran. Closed/missing Desktop, a successful opener or an accepted queue
alone cannot make a provision complete. The original one-use provision bit covers
this entire chain; a lost create/start/queue response never creates another chat.

Every subsequent business/continuation uses that same exact UUID/cwd and GUI
queue. Fresh native thread model/effort must match the server-selected pair;
unknown/mismatched settings refuse before the task's irreversible start bit.
A changed company choice never silently uses the old GUI model or a configuration
model turn on old private history. Native hook observation remains independent.
The queue API has no model-setting parameter: autonomous reconfiguration of an
already GUI-owned chat must use a separately verified native Desktop capability,
not an invented URI option, foreign resume, hidden helper chat or prompt command.

Only structural locators and the platform instruction cross private stdin; no
prompt/content/credential is placed in argv or an extra transcript cache. The
adapter never changes sandbox, approval, trust, saved rules or authentication.
An owned reader polls bounded native turn summaries with backoff under the same
absolute deadline. Timeout/cancellation closes only that reader, not the GUI
turn/queue. Queue UUIDs correlate requests; they are not an idempotency guarantee,
and an uncertain submission is never automatically requeued.

Owner-private first-chat handoff has a separate bounded readiness-verification
boundary. A completed PREPARE is not GUI readiness and does not prove why the
handoff failed. Only complete single-turn native history with the EXACT empty
bootstrap request, one exact `READY` answer and no tool/other items can expose a
host-only `prepared` witness. Missing, partial, duplicate, running/interrupted,
impure or ordinary business history remains uncertain.

Under the original coordinator lease, schema22 can journal ONE independent
tool-free verification UUID for that same owner intake/chat. It never reuses the
old queue marker, resets its native-start bit, creates a chat, reads an owner
body or grants task/provider authority. Fresh native source revision, company
model/effort, cwd, absent protected pass and an empty native queue must precede
the synchronous new start CAS. The original PREPARE witness and current native
source/model are rechecked immediately before that CAS. A newly arrived original
GUI receipt is adopted on a later tick instead of starting this verification.

Only the new marker's exact completed tool-free GUI `READY` earns readiness;
then ordinary native owner admission delivers the SAME original event once.
Restart/lost/unknown verification outcomes use that SAME marker's read-back,
never another submission, timeout extension, queue removal or local state reset.
This is a new technical verification, not a replay of an uncertain business or
provider operation. A completed verification alone clears no business/ACK health.

### Exact independent READY prompt reconciliation

A completed independent owner readiness review is compared with the SAME
`assistantNativePrompt` output used by the queue producer, including its final
newline. No trimming or prefix acceptance is permitted. The regression captures
the real submitted queue input and feeds it through native terminal polling,
strict receipt verification and later read-only reconciliation. A successful
existing review therefore resumes the original row without another READY or
owner-message submission. No native deadline, source/pass guard or business
completion/ACK authority changes.

The independent reader observes **stored** history, not the GUI writer's live
event stream ([native read semantics](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)).
With the actual Windows 0.164 client, that history projected the exact ongoing
GUI business turn as `interrupted` while the owning Desktop was still executing
its tools. Such a snapshot is uncertain: it earns no failure/completion receipt,
cannot release the protected pass or authorize another invocation, and does not
end the polling reader. The reader retains its original absolute deadline and
waits for actual `completed`/`failed` history. Cancellation/timeout still close
only that owned reader; real unresolved interruptions remain uncertain. The
initial empty bootstrap separately watches its OWN `turn/completed` event, where
an actual interrupted notification is terminal and never earns READY.

Windows live probes with the official 0.164 client confirmed both High and Ultra
bootstrap → exact URI → GUI queue → actual turn_context/read-back, independent
of the preceding GUI default. The SAME common signed URI opener also handed off
in the existing InteractiveToken Windows user session. These are tool-free
Desktop transport checks, not a business outcome, provider login or actual
cyclic-wake acceptance.

The SAME common Codex environment projector keeps only its public OS/profile
allowlist. On Windows that includes `ComSpec` and `PATHEXT`, with one canonical
case per name; conflicting aliases do not select an interpreter. Codex's own
MCP resolver needs them to select/launch the existing `.cmd` companion instead
of trying the extensionless POSIX file (Windows error 193). This changes neither
the plugin manifest nor native command, `shell:false`, authentication, trust,
configuration or process-start/uncertain-delivery fences. Arbitrary environment,
credentials and inherited chat IDs remain excluded; POSIX projection is unchanged.
The Windows gate uses hash-pinned public Codex 0.164.0 with an isolated fixture
profile and synthetic stdio MCP: legacy projection reproduces error 193, fixed
projection reaches `initialize`/`tools/list` through the native resolver. It
makes no model turn or tool call and is not a real assistant business outcome.

The host passes a one-use synchronous `startInvocation` callback that performs the
inbox's leased -> started CAS. Missing history cannot authorize a second attempt.
After queue dispatch, the adapter must find exactly one matching native user-message
marker with a completed/failed turn. Quoted/tool/assistant text is not acceptance.
Missing/oversized/unavailable history is uncertainty, not proof of rejection.
Provisioning consumes no business events and needs only the exact READY receipt.
Business delivery additionally requires the trusted host's `readBusinessOutcome`
adapter: a durable confirmed receipt with exact assistant/device/company/task,
assignment binding/revision, delivery and thread IDs. Missing, pending or
mismatched outcomes cannot mark events processed or advance the schedule. Both
receipts are stored as one content-free reference. Live authority is checked
again after outcome I/O; a stopped task cannot be acknowledged accidentally.
A timeout keeps the inbox blocked until read-back/review, without replay.
The fixed device client reads the exact committed backend outcome. Production
Workspace execution, owner decisions and OS service still gate activation; native
success alone never proves business work.

A fixed internal readiness probe uses the same native path but asks only for
READY, with no tools/accounts/integrations. It is not a task execution or timer
proof. It is selected by trusted setup code, not exposed as an incoming-message
permission. Native Windows acceptance must be checked on a supported installed
host before activation; mocked child tests only verify the adapter boundary.

Tests: `trelio-assistant-scheduler.test.mjs` (real SQLite and timezone boundaries),
`trelio-assistant-codex.test.mjs` (exact transport/fencing/read-back), plus the inbox
suite. Native workflow runs them on Linux/macOS and Windows.

## Durable pass completion and recovery

Before business resume, the coordinator persists a prepared delivery with
`native_started=0`, reserves the backend pass with that exact delivery/thread,
and activates its structural identity in the protected host journal. The hook
uses only that identity. The native launch receives the immutable model/effort
snapshot returned by admission. Lost pass-claim responses may repeat only the
same idempotent claim while the durable native bit proves no launch crossed its
boundary. A started native invocation is reconciled, never repeated.

`complete_assistant_pass` stays a backend-validated model action with a fresh
observed proof and accepted evidence. The host's fixed
`/runtime/task-pass/outcome` read validates a strict committed receipt and
`continuation={goalState,cadence,timeZone}`; pending or any wrong/extra field is
uncertainty. Receipt lookup does not retry the model/action and exposes no
arbitrary HTTP. A closed pass accepts SessionEnd cleanup only, no new signature.

Positive native read-back and the exact backend receipt must both exist.
Continuation, inbox processing, completion timestamps and next-run are committed
inside the same SQLite transaction. Changed cadence resets its anchor to this
completion; unchanged cadence preserves its calendar anchor. A completed goal
stops only this assistant's cycle, and ordinary accepted-task rediscovery cannot
restart it. A new permitted mention may resume the same chat and commit a new
active goal. Native task `done` permits reconciliation of the original pass,
never a new launch, even if its binding revision advanced during completion.

The protected host journal and local signing key are released only after SQLite
commit. If the host crashes between that commit and release, it verifies the
same completed local delivery, native turn and backend receipt and then releases
without another launch. If SQLite rolls back, the same receipt is applied again
atomically with no model replay. Missing/revoked/unverifiable evidence retains
the existing fence and requires review. Timeout does not free a server pass.

Long work renews the same live backend lease by CAS near expiry, independently
from the local delivery heartbeat. Closed receipts do not renew or acquire new
signing authority. These tests use real SQLite plus synthetic trusted adapters;
they do not substitute for a supported Windows end-to-end activation test.

## Company model selection

There is one owner-selected model/effort pair per assistant/company and no
per-task override. Fresh `/runtime/task` state is checked before each native
invocation; missing configuration and `policy_blocked` refuse launch. The host
projects only canonical model ID, closed effort and positive config revision,
then freezes that structural request before async I/O. It does not persist
model preferences in SQLite or mistake the selection for actual attestation.
Backend task-pass admission pins an immutable launch snapshot and the shared
hook still proves the observed model/effort against the company's live policy.

New empty bootstrap receives explicit native `model`, `effort` and the same
collaboration settings. The existing visible task chat must retain that exact
pair in fresh native metadata before each queue write. No sandbox, approval, trust,
account or rule override is added. Before crossing the durable native-start
fence, a bounded read-only App Server `model/list` checks the signed-in account's
actual model/effort availability. Pagination shares one deadline; missing,
malformed or looping results never select a fallback or launch model work.
The returned account catalogue/labels are not logged, cached or stored in SQLite.
See [official model/list](https://learn.chatgpt.com/docs/app-server#list-models-modellist).

The same bounded native preflight first calls documented `account/read` with
`refreshToken:false`. Only `account:null` together with
`requiresOpenaiAuth:true` establishes `ASSISTANT_CODEX_AUTH_REQUIRED`, before the
one-use native-start fence or a model request. Configured account metadata does
not validate a token or prove recovery. An explicitly authentication-free
provider remains supported; malformed/unsupported account data, RPC refusal and
transport loss stay unknown. No email, plan, credential or raw error leaves this
in-memory boundary. See [official auth state](https://learn.chatgpt.com/docs/app-server#1-check-auth-state).

A blocked company is skipped in provisioning, event and due-cycle selection;
other companies retain fresh independent authorization. Skipping does not pause
or rewrite source/task state, consume queued mentions, advance dates, erase goals
or replace permanent chats. Positive already-completed receipts may be reconciled
without launching new work even while model selection is blocked. An uncertain
native outcome still retains the existing global desktop fence until read-back;
a policy change is not permission to replay that operation elsewhere.

The backend publishes the authoritative owner notice through ordinary account
notifications and messenger copies. Model save clears only this company-policy
block; lifecycle/revocation/owner task approval and uncertain delivery remain
independent. These source tests and a read-only macOS native model/list probe do
not establish an activated service or Windows end-to-end business readiness.

### Background dispatch diagnostics

The existing `get_assistant_background_status` keeps its exact OS registration
`state` and adds a separate content-free `dispatch` observation. The schema is
version1 with `state:idle|queued|blocked|active|unknown`, closed `reasons`,
`checkedAt` and aggregate `pendingEvents`, `acceptedTasks`, `waitingOwnerTasks`,
`unprovisionedTasks`, `uncertainDeliveries` counts. No company/task/event IDs,
labels, text, cursors, credentials, pass handles or arbitrary selectors are
returned. This observation is diagnostic, never model/pass/owner authority.

The SAME private journal schema11 adds nullable `failure_code` and
`failure_stage` on the existing delivery row. Marking it uncertain commits the
first observed closed failure and phase atomically; later claim/review failures
cannot replace that cause. The generic outward uncertain
error and native-start/replay fence are unchanged. Phases are
`native_claim|native_preflight|native_started|readback`; only the actual
one-use `startInvocation` boundary selects `native_started`. The last unfinished
delivery's `failure:{code,stage}` is projected without any identifier or raw
message. Codes use an explicit implementation allowlist, never prefix/message
parsing. Old v10 rows remain readable with `failure:null`; only ordinary writable
coordinator startup performs the forward migration, with every event, lease,
receipt, cursor and native-start bit retained. Unknown historical causes are
never reconstructed from a later observation.

After protected pairing, the SAME native company inventory supplies fresh
execution state. Missing model/effort yields `model_selection_required` even
before the first queue event; incompatible policy yields `model_policy_blocked`.
A successfully empty company inventory yields `configuration_required`.
Denied, malformed or incomplete inventory returns `unknown/not_checked` with
null counts, never an empty/idle inference. A positively absent local inbox
also keeps counts null; a known native configuration block remains visible.

Queue counts use a fixed SELECT-only reader in the SAME inbox module and the
SAME private opener in SQLite read-only mode. No directory/database creation,
migration, lease recovery, poll, task sync/claim, cursor/schedule write or ACK is
performed. Only exact current native Trelio source scopes contribute task counts.
`queued` means accepted task-bound pending events or an unprovisioned accepted
task, never an unrouted external reference or future cycle. A retained native
started/uncertain marker, including an old company/intake, is a device-global
`delivery_uncertain` block and is never called an active process. `waiting_owner`
stays independent. Only an actually active coordinator invocation may report
`active`. Network diagnostics share the original OS-status deadline and cannot
erase the independently observed OS state or an authentication/hook incident.

For fresh native `ready` company choices, status also returns
`nativeExecution:{state,checkedConfigurations,unsupportedConfigurations,failureCode}`.
All selected pairs share ONE existing App Server `account/read` + bounded
`model/list` RPC process and the original status deadline. No default model,
model turn, login, provider input, credential/account label, trust, health write
or catalogue cache is added. `model_supported` means only catalogue support of
the exact model/effort; it does not prove usable login. Explicit native missing
authentication gives `auth_required`; a definite unsupported pair gives
`model_unavailable`; malformed/unavailable RPC stays `unknown` with an exact
closed implementation code. These current observations do not supply the
missing historical cause of a legacy delivery and cannot clear any health latch.

The shared Codex executable resolver keeps explicit PATH priority. On Windows,
the SAME signed native worker has a separate fixed public `--codex-package-path`
mode. AppModel selects one current-user main package from the exact
`OpenAI.Codex_2p2nqsd0c76g0` family; absence/ambiguity/development package/error
returns unavailable. No input, package/path/PID selector, private readiness/ACL/
DPAPI call, shell, process scan or OS mutation belongs to that mode.

The vendor desktop relocation contract selects one existing copy from the four
ordered packaged resources: `codex.exe`, `codex-code-mode-host.exe`,
`codex-windows-sandbox-setup.exe`, `codex-command-runner.exe`. Its destination is
`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash16>`, where hash16 is the first sixteen
hex digits of SHA256 over each filename, NUL, lowercase file SHA256 hex, NUL in
that exact order. The resolver hashes the current packaged sources and exact
selected copies, checking regular/non-reparse paths, sizes, stable file stats
and fresh native package read-back under the original caller deadline. It never
lists cache versions, chooses newest, copies a file or launches the protected
Store executable. This selector was inspected in the installed vendor public
app resource and independently matched the real Windows copy; that does not
establish a successful assistant task or resolve an older uncertain delivery.

The other fixed fallback is the documented per-user standalone command directory
`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`. It resolves the official
`CODEX_HOME`/`.codex` standalone `current` and visible `bin` junctions to one
direct release child, verifies regular runtime companion files, and rechecks the
selection before returning. Missing, incomplete, escaped or concurrently
retargeted layouts fail closed without scans, installation, PATH edits, shell
execution or ACL changes. Store application internals are not a fallback: an
installed Store package and readable binary do not prove permission to execute
that internal CLI. Discovery shares the original caller deadline. A resolved
path still requires the ordinary native RPC/turn checks; synthetic filesystem
fixtures establish no real account or Windows business readiness.

The ordinary `background_tick` returns the same diagnostic and reports
`blocked`/`unknown` instead of collapsing all absent launches to `idle`.
Polling and durable page/cursor commit remain model-free. If native model
admission refuses a launch, that original committed event remains unprocessed
through SQLite close/reopen. Saving a valid pair lets ordinary scheduling
process that same event in the permanent chat without a replacement mention.
Trelio notification read acknowledgement may already have occurred after its
durable task-inbox commit; it does not remove the queued event or prove business
processing. External provider body/material/selected-slot ACK guards are unchanged.
These file-backed SQLite/native-composition tests do not prove the presence or
processing of a specific production comment; live acceptance needs its actual
native read-back.

## Host coordinator and enrollment

`trelio-assistant-coordinator.mjs` connects the private database, scheduler,
fixed device HTTP client and native adapter. One short transactional host lease
serializes service instances; the separate durable desktop delivery lease also
blocks another worker after a crash or ambiguous native result. Discovery,
notification polling and read acknowledgement are model-free, every five
minutes. A notification's read flag is not its delivery position. Ordinary
comments enter accepted context/read acknowledgement without waking the chat.

Before business work, `native.ready` must confirm the dedicated assistant MCP
admission for this identity. Having Codex installed or an ordinary human OAuth
session is insufficient. This required host adapter is intentionally not given
a permissive default. The coordinator is not automatically registered as an OS
service by importing it. A trusted plugin installer supplies lifecycle, this
admission check, workspace resolver and notification transport.

The native provision uses the same global delivery fence but no task events.
Its only initial instruction is READY without tools. The exact thread ID is
journaled before the empty bootstrap turn, then verified by the GUI-queued READY read-back.
Only subsequent task passes may consume the event queue. A lost native ID blocks
another chat; an ambiguous *server host claim* is different: the durable
`native_started=0` bit permits retrying that same provision ID before the one-use
native boundary. The backend keeps one device/provision claim per task; another
valid device or new local DB cannot silently provision a replacement.

Long passes recheck live exact task/device authority and renew the same delivery
every 30s. Denial, transport loss or an expired/replaced lease aborts the child and
keeps uncertainty for native reconciliation; it does not promise cancellation of
an external action already accepted elsewhere. Every future business MCP call
must still apply its own fresh domain ACL, policy and owner-decision checks.

Actual timing projections use a monotonically increasing sequence in the same
SQLite state. They report cadence, timezone, next-run, last completion/cycle and
the permanent thread UUID through `/runtime/schedule`. Identical reports are
idempotent; restored stale state or another thread/device conflicts. Transport
failure does not undo a positive native completion or rerun its task. Reporting
does not claim that a native desktop automation exists or is running.

`trelio-assistant-private.mjs` reuses the common Windows native ACL/CurrentUser
DPAPI and macOS stdin-only Keychain helpers under a separate service namespace
and inner identity envelope. It does not pretend to be a company/skill, read
human OAuth or use a plaintext Linux fallback. The SQLite opener validates its
private parent, DB and existing sidecars, enables full synchronous writes and
keeps unknown schemas intact. It stores references only, not message bodies or
personal/enterprise secrets.

`trelio-assistant-transport.mjs` is a host-only fixed HTTPS client. It disables
cookies/redirects, bounds JSON/time, projects content away and hides raw errors.
The S256 verifier is protected before enrollment I/O; exchange crosses a durable
one-use fence before HTTP. Pending rejection may be polled, but a lost exchange
response requires owner recovery/new enrollment. Credential save is verified
before READY, and verifier removal follows the protected device save. Neither
the credential nor verifier is returned by model-facing setup operations.

Additional tests: `trelio-assistant-coordinator.test.mjs` exercises real SQLite
poll -> owner decision -> provision -> mention/timer -> native receipt,
concurrent hosts, crash recovery and unknown ID/host claims. Private/transport
tests cover binding isolation, no plaintext fallback, symlink/ACL refusal,
no cookie/redirect, response redaction and lost pairing exchange.

### Owner identity metadata for source routing

The private device client reads `/runtime/owner-identities` afresh through the
same fixed, bounded HTTPS transport. It projects only the current assistant,
human owner, binding revision and at most one native Telegram/MAX binding each.
Opaque provider IDs remain strings without trimming, numeric conversion or case
folding. A malformed/ambiguous response or access/network failure is an error;
only a successful empty list means that the owner has no verified binding.
Returned snapshots are immutable and do not enter the model MCP catalogue,
SQLite, the skill admission cache or a credential namespace.

This is preparatory routing metadata, not authority to create a task, reply or
disclose a company message. A future signed source adapter must prove the actual
sender and matching provider ID namespace; username/forwarded-author inference
is forbidden. Intake must re-read the native owner binding and independent
company/task ACL at its own boundary. The client does not enable provider
monitoring, synthesize a task pass or reuse a human OAuth session.

### Model-free source reader

`createAssistantDeviceClient.sourceAccounts(companyId)` reads desired source
references through fixed GET
`/api/digital-assistants/runtime/source-skills/accounts?companyId=UUID`. It uses
the existing protected device slot, not a task pass or human OAuth. A fresh
schema-v1 envelope must match assistant/device/company even when empty; at most
128 structural rows are projected into immutable refs. Unknown fields are
dropped, duplicate IDs/malformed scope/false readiness claims are refused, and
errors remain errors rather than an empty authoritative inventory. `active` is
owner intent; `executionVerified` must be false. This discovery does not create
local accounts, import sessions, register queue sources, poll providers, dispatch
chats or ACK messages. Owner device onboarding and production orchestration
remain separate gates; no model tool or timer is added by this client.

Local-first setup starts in the visible Desktop chat on the paired computer.
`get_assistant_status` includes fresh company UUID/slug references from the SAME
authenticated runtime inventory; it exports no names, content or execution policy.
The local connection tool accepts `companyId:null`: one native company is chosen
algorithmically; multiple/empty inventories return choices/unavailability without
reserving an account. A failed inventory is an error, never an empty list. The
model matches a supplied slug or asks only a real multi-company choice; it never
asks the human for an internal UUID or opens an owner browser to discover one.
The original request UUID remains bound by the native writer to its first scope,
including after an uncertain preparation and a changed company inventory.
`prepare_assistant_local_connection(companyId, skillId, clientRequestId)` reserves
one NEW account UUID through the SAME fixed device writer and prepares its empty
entry through the SAME signed loader/catalogue. It returns the exact existing
configure/login tool, never opens or replays a form itself. Reuse the request UUID
after lost preparation; an uncertain provider login still permits no replay.
An active task pass refuses this taskless settings action. No human OAuth,
account UUID override, import, credentials, second vault or executor is involved.

The native row starts `available`, with polling/intake disabled. It appears in
owner settings, not the private SQLite inbox. Only the direct owner's first CAS
activation selects polling and optionally verified-owner task intake. Existing
active/paused/revoked rows and their immutable flags are unchanged. Supported
connections may be explicitly reused in another independently readable company;
that decision binds the SAME account/session and never enables the origin.
The first baseline read performs the exact native bind through the existing
atomic catalogue intent under its original deadline. No second copied prompt,
login, provider retry, credential transfer or new binding store is needed.
Runtime >=3.20.0 projects this enum; old workers receive only their understood
rows. Native local preparation requires the compatible version. Availability is
structural setup metadata, not proof of provider login, incoming access or ACK.

The current signed request worker exposes `prepare_assistant_source_account`
through the existing dynamic catalogue, not a new stable-plugin setup method.
`companyId` plus `sourceId:null` discovers only scoped owner-configured structural
refs. An exact `sourceId` can prepare a new EMPTY local account only when the
server's persisted owner intent or inert local reservation has `provisionLocalAccount=true`. Existing-account
references do not authorize binding, adoption, import or login. Device identity,
current owner membership, project access, device write grant and exact source
revision are checked by native resolution/package endpoints. The model supplies
locators, never account UUID selection or a consent boolean.

Preparation uses the SAME signed package materializer and common account
catalogue as task skills. After materialization it exits the first HTTP profile
and obtains fresh native setup admission under the ORIGINAL deadline; nested
profile replacement stays prohibited. The reviewed artifact/release/hash must
remain unchanged. A private one-use closure admits precisely one fixed empty
create with the server-generated UUID; no provider process is launched. Metadata,
company/member binding and the native-intent receipt commit in the catalogue's
existing atomic transaction. A lost response can read back only that same intent,
without another account, rename, rebind or session reset. Receipt is provenance,
not authority: every preparation still obtains fresh native admission.

The tool is discovered and fingerprinted by the current signed worker, so the
existing facade can announce it without a plugin/Codex restart. Successful setup
or discovery cannot clear hook-review/login latches. `state:prepared` and
`loginVerified:false` prove only local empty-account creation; owner sign-in,
provider setup, actual polling/body processing/ACK and Windows business E2E
remain required. No second vault, journal, provider or executor is introduced.

The separate `configure_assistant_email_source` tool accepts only company/source
UUIDs. It requires a newly registered source with native
`interactiveSetupAllowed=true`, not an empty-create request, an existing local
UUID or a model consent flag. Both native resolution and download repeat the
same live owner/device/company/project/revision/write-scope checks, then return
`accountSetup.operation=configure`, `email-configure/v1` and a fixed ten-minute
budget. A fresh native resolve after materialization must keep the same artifact,
release and hash. Plain verified email only; Linux storage and non-email login
remain closed under this email admission. The passive reader's original limits do not change.

This is the SAME signed loader, managed account catalogue and Node/Python process
engine, with a closed `assistant_source_setup` capture profile. A private one-use
callback verifies the exact account/member/release/command and bounds the process
by the original monotonic deadline. The only provider arguments are
`configure --account <native UUID> --password-input browser`; no terminal values,
secret checkout, stdin, environment grants, SMTP-only flag or arbitrary overrides.
The human enters/submits credentials in the existing protected local provider
form. The operator may explicitly choose SMTP-only in that form: saving it is
reported with `incomingEnabled:false`, never as an enabled monitor.

The request worker, forwarding facade and private invocation allow a fixed
eleven-minute outer envelope ONLY for this exact setup tool. The native ten-minute
budget includes resolution, download, interpreter/bootstrap and input; it does
not slide at form launch. Other requests/polls keep their existing deadlines.
An already running old facade cannot magically gain a longer wait budget; source
onboarding compatibility must be checked on the installed assistant before
claiming hot-update readiness. No new stable-plugin method or automatic restart
is added. A lost/cancelled/failed invocation never replays the provider.

Only `configuration_saved`, `incomingEnabled`, exact structural IDs and
`connectionVerified:false` cross the successful private result boundary. Failed
source setup consumes the completed stderr pipe through the SAME executor and
projects only a reviewed provider error-code category. Unknown or non-JSON
failures retain the original process-exit category; malformed successful output
remains an invalid response. Both worker and facade preserve the closed process
codes, including numeric exit buckets. Raw provider errors, mailbox addresses,
paths, field values, details and next-action prose stay out of MCP/logs/SQLite.
No failure projection launches or repeats a form.

<a id="telegram-login-diagnostics"></a>

Protected Telegram login handles human-correctable phone/code/password refusals
inside its original local page and lease. The host does not resubmit factors,
open a replacement page or treat a finished handoff as authorization proof.
The SAME complete setup pipe admits fixed provider codes for password/code,
expired/invalid/used QR, phone/account restrictions, application/SRP errors,
rate limits, session, network, service, cancellation and expiry. Provider text,
factor values and arbitrary details remain private. Foreign codes, non-JSON,
partial/invalid UTF-8, signals, timeout and output-limit retain the original
process failure. Source setup returns its closed `ASSISTANT_SOURCE_SETUP_` code;
task human-input setup preserves the actual exit bucket plus fixed
`details.providerCode` and optional bounded numeric `retryAfterSeconds` through
the ordinary bridge frame. Telemetry keeps its existing content-free exit bucket.
`loginVerified:false` on account preparation/handoff means verification has not
been performed by that step, never a checked password rejection. None of these
fields proves polling/owner identity, clears latches or grants retry.

A closed window is not successful configuration, and saved credentials are not
network readiness, sending authority, processed messages or a passed Windows
business pilot. Setup metadata does not clear hook/login health latches.

For an already active IMAP source the saved result supplies a separate exact
`verify_assistant_email_source` continuation (company/source UUIDs only).
It uses the SAME source inventory, signed passive monitor, managed account and
native provider engine under the ordinary read budget; it never opens another
form, supplies fields, tests SMTP or modifies the saved configuration. Its fresh
INBOX metadata baseline is discarded, not committed to SQLite: verification
cannot reset/advance a running worker's checkpoint or claim historical messages
processed. Body/refs/cursor are absent from the result and no read-state changes.

Owner registration is read before and after the provider using the same equality
guard as coordinator polling. A late pause/revoke/revision/account change rejects
the result. A failed second inventory is not empty or successful verification.
Only the successful current read returns `incomingVerified:true`, with explicit
`outgoingVerified:false`. Saved SMTP-only configuration has no incoming follow-up.
Provider failure is a closed typed reason, never raw output; it cannot reopen
configure or clear hook/ChatGPT login latches. This dynamic signed-worker tool
uses the normal wait envelope and does not change the stable six-method setup
ABI. Actual background next-run/processing/ACK and Windows E2E remain independent.

`configure_assistant_telegram_source` uses this SAME interactive account/process
path for a separately native owner-enabled Telegram source. It accepts only
company/source UUIDs; native `accountSetup.operation=login`,
`telegram-login/v1`, fixed `login` command and exact current registration are
required at resolve and package boundaries. Empty-create, email configure,
an old account UUID or a model boolean cannot authorize the provider launch.
An older backend lacking this exact operation fails closed; host support alone
does not enable owner onboarding or business readiness.

The sole provider syntax is `login --qr`. The SAME host catalogue consumes
`--local-account <native UUID>` before launch and passes the bound account in
the host-owned environment; Telegram has no provider `--account` option. The
one-use admission independently rechecks that exact account. It opens the
existing protected local Telegram QR/2FA page; the human scans/enters factors
there. No terminal prompts, phone/code/password/QR values, application identity,
human-session import or configurable timeout cross the host API. It shares the
original ten-minute native budget and eleven-minute outer wait envelope with
email setup, without changing the six-method stable setup ABI or passive reads.
Failed/cancelled/uncertain login is never automatically repeated.

After the native provider reports `authorized:true`, the exact source registration
is reread before publishing the closed `session_authorized` result. Provider user
ID/username, paths and login factors are discarded. This is the assistant's local
Telegram account, not proof of its OWNER's identity or authority to create tasks.
It does not verify background polling, process/ACK messages or clear login/hooks
health latches. Native owner control-plane/UI opt-in and a real Windows business
pilot remain independent gates.

The paired setup result and source-list attach content-free `sourceLabel` and
`settingsUrl`, built from the current assistant identity and exact native
company/source IDs. The owner link selects that exact profile row; the model
does not reconstruct IDs or require a task to enable model-free auto-checks.
The URL grants no ACL and neither login nor an `active` setting proves a poll.

`configure_assistant_max_source` uses that SAME account/process engine and the
existing MAX protected browser, with explicit native owner opt-in and fixed
`accountSetup.operation=login`, `max-login/v1`. Its only provider command is
`login --headed --hold-ms 540000`; the common account catalogue selects the exact
native UUID without injecting a nonexistent MAX `--account` flag. No browser
path, selector, timeout, session import or credential reaches the model. It shares
the original ten-minute input lease, eleven-minute outer envelope, fresh resolve
and no-automatic-retry rule. Only Windows/macOS interactive storage is admitted.

Closing the window or reaching the hold limit yields `login_handoff_finished`,
`sessionVerified:false` and one `verify_assistant_max_source` continuation. The
provider's private profile/path/fingerprint is discarded. Handoff is never auth.
The independent native `verify_login` / `max-login-verify/v1` admission selects
only `probe`, keeps the original 120-second lease/60-second child bound and
repeats source/write/owner/device/registration checks at both resolve and package.
The existing MAX implementation verifies authenticated home and structural search
readiness; both true plus a final unchanged native registration are required for
`session_verified`. Failed verification cannot reopen or repeat login. Neither
result reads bodies, changes queues/read-state, registers a conversation, proves
owner identity, clears health latches or enables business readiness. MAX stream
selection and a real Windows pilot remain separate gates.

Production source polling also reads the native per-source diagnostic CAS before
its signed provider read, then reports exactly one closed result to the existing
account incident mechanism. Source revision and health CAS are independent of
SQLite cursor state and device-wide login/hooks. A late registration change
cannot report recovery. Monitor gap/scope/setup failures use closed codes only;
network/prose never guesses invalid credentials. A failed diagnostic read skips
the report; a lost/failed report never retries the provider, discards a committed
page, resets a position or marks messages read. Each call re-enters the same
protected device invocation, fixed HTTPS transport and original poll deadline.
Owner bell/messenger delivery is server-owned; local callback emission alone is
not notification evidence. Ready describes the checked source metadata read,
not routed/processed/acknowledged messages or whole product readiness.


Arbitrary task-skill arguments require `trelio-assistant-execution.json` in the
SAME verified signed package file inventory. Its v1 object has exactly
`schemaVersion:1` and `taskCommands`: 1–64 unique literal positional prefixes,
each 1–3 command tokens `[a-z][a-z0-9-]{0,63}`, at most 8192 UTF-8 bytes.
Provider authors classify their own real parser leaves; the generic host has no
provider command map, regex/glob, option-skipping or second executor. Unknown or
missing policy fails closed; unsigned resolve metadata/model flags cannot opt in.

Version 2 retains the same prefix list and requires one additional
`deniedOptions` field: 1–32 unique literal long options matching
`--[a-z][a-z0-9-]{0,63}`. The SAME shared guard rejects a token equal to one of
them or beginning with its `=` form, before account/bootstrap/interpreter I/O.
It does not skip option values or reinterpret the provider parser. Provider
review must account for aliases/abbreviations; an undeclared synonym is not
magically blocked. A forbidden-looking data value fails closed as well.
Version 1 stays exact and never silently ignores a v2 restriction field;
unknown versions fail. Human CLI and fixed native source profiles are unchanged.
This closes real provider-owned overrides such as MAX `read --chrome PATH`
without a generic host provider map or second command executor.

The shared `skillCommand` checks after package verification but BEFORE managed
account selection/import. It removes only the host's strict local-account
selector, then compares literal leading tokens. The shared materialized executor
checks again before interpreter/bootstrap/provider I/O. Native host account
commands retain their independent existing gates. Human calls retain the old
CLI; fixed source monitor/setup keep their separate exact native admissions.
The composition fixture executes real signed v1/v2 Node providers, verifies
approved task work, and proves forbidden setup/policy/ACK/import commands and
v2 executable/time overrides never launch them.

This is restriction, not business permission: send/reply still require the
existing task/operator/owner authority and provider guards. Exact source ACK
needs committed processing/read proof/lease, independently of this file. Email
is the first reviewed provider opt-in; other providers remain unavailable to
generic task execution until their actual CLI classification is signed/tested.
Owner onboarding and the Windows business E2E remain separate release gates.

`readAssistantSourceMonitor` composes the same package resolution validator,
Ed25519/digest/file-inventory verifier, executable cache, explicit bound local
account selector and materialized Node/Python executor as ordinary skills. It
accepts only the reviewed Telegram, IMAP email and MAX monitor protocols. The
provider retains its APIs, credential/session storage, selectors and passive
read guards. No provider implementation or credential is copied into the host.

Production Telegram read acknowledgement is a separate internal profile on that
SAME materialization/account/process path, not a monitor or task permission.
It derives native admission from explicitly committed source receipt slots,
persists the original private ACK attempt at final spawn and reconciles unknown
outcomes without another write. Provider-native contiguous-range proof remains
independent. See [the inbox contract](assistant-inbox.md#production-telegram-acknowledgement).
The same native source-health/account notice path reports independent closed
READ/ACK observations. Unknown writes remain visible across healthy polling;
diagnostic/report failure never retries the provider or drops its durable fence.
Recovery uses positive current-generation journal evidence, never an empty queue.

Source polling and task execution resolve the same assistant/device account
catalogue through the common account engine. Company/member bindings are still
checked by that catalogue. A source never imports/selects the interactive human's
legacy accounts, returns labels of unbound company accounts or changes account
setup during ordinary reads/task execution. Only the separately admitted empty
creation above can change the catalogue. The profile rechecks its protected identity and original read deadline
before resolving the namespace; a closed/expired profile cannot reuse it. Owner
onboarding must populate this namespace explicitly, not copy human sessions.

A separate internal async HTTP profile uses the existing protected device slot
and common version headers. Each poll resolves the current package through the
fixed `/api/digital-assistants/runtime/source-skills/resolve` endpoint, even on a
verified cache hit. The server repeats live device/MCP/scope/assignment/release
checks. Only its exact company/project/skill/release/artifact package query can
be downloaded, once, through the same profile. No human OAuth, browser cookie,
redirect, task pass/model observation, cached twelve-hour admission, secret
checkout, setup, login or implicit retry is used. Plain platform-verified
packages only; encrypted and company-unverified execution remain closed.

The original monotonic 120-second budget begins before resolve/private I/O.
Server issue/expiry dates bound that duration; local wall-clock skew cannot
renew it. Package download, account preparation and capture share that budget,
and the actual provider child receives at most 60 seconds. Cancellation and
identity changes prevent delivery of a page. A fresh source profile is required
for another poll. Cached envelopes are fd-read with exact size, no final symlink
and a bounded allocation, then signature and every materialized file are checked.
Neither a marker nor a prior successful invocation authorizes tampered bytes.

Complete private provider JSON is projected immediately to bounded structural
message/revision references, native sender metadata and opaque non-authorizing
cursors. Content/config/account labels/provider errors never become SQLite,
model output or diagnostic payloads. Telegram channel hints and unresolved
account deletion IDs stay separate: neither invents a chat or sender. MAX cannot
prove owner identity. An unknown response, gap, cursor/scope refusal, output
limit or process failure is not an empty page and provides no replacement
position. Baseline-only pages are explicitly marked, not historical backfill.

This is a one-page reader, not source registration or delivery authority. Source
onboarding/backfill, atomic SQLite positions/events, independent polling leases,
task mapping, fresh owner-command intake, ACK after actual content processing and
Windows end-to-end acceptance remain separate product gates. The helper does
not enable `businessReady`, register a timer or touch a live provider account.
Tests use real synthetic signed packages/native children plus strict wire DTO
fixtures. The same native-child fixture proves human/other-company selectors
cannot start a provider and verifies the shared task/source namespace. It does
not assert that production provider monitoring or owner onboarding is enabled.

### Background source reference intake

Production composition connects the existing protected source inventory and
signed passive reader to the coordinator's SAME private SQLite inbox. Source
registration, five-minute positions, bounded fair polling, before/after native
row checks, pause/revocation and restart deduplication are described in
[`assistant-inbox.md`](assistant-inbox.md). No provider implementation, executor,
credential store or model polling turn is added. Calls re-enter device identity
and propagate the common private invocation's narrower cancellation boundary.

New references enter unrouted/non-waking/unacknowledged. A known Telegram
conversation follows its exact fresh native route into the canonical task chat;
body-read evidence and explicit committed selection remain independent of wake.
Unknown conversations are never assigned to a convenient task/company, and
sender metadata is not a direct-owner command. Telegram child streams/deletions,
exact reads/processing/native ACK and source-health reports compose the SAME
queue and signed engines. They do not close unknown-conversation/verified-owner
intake, MAX selector onboarding, other-provider processing/ACK, old-generation
recovery or the live Windows business E2E gates. A failed/gapped source retains
its position and cannot manufacture a successful empty page.

## Protected background host composition

The dedicated MCP and background supervisor reuse the SAME immutable Codex
plugin-preservation engine. A closed assistant profile validates the exact
loaded cache path/native manifest and uses its own code-copy namespace; it
cannot restore/adopt the human shell or choose a newer installed version. MCP
snapshots after writing initialize; the supervisor verifies its exact native
registration, then awaits its snapshot before any worker. Watchers stop at
their original lifecycle boundary. Cache cleanup may restore only previously
verified bytes; it never changes trust/config, device identity, a pass or an
operation receipt. A registration already pointing to files lost before this
snapshot still needs ordinary idle registration recovery; no missing old code
is fabricated or copied from a different release.

`createAssistantRuntimeHost` composes the real private SQLite opener, fixed device
client, protected pass journal and existing native Codex adapter. Its database directory
is separated by assistant/device; task working folders use a domain-separated
SHA-256 of canonical origin/assistant/device/company/task IDs to bound Windows cwd length. They are chat roots, not accepted material or instruction
files. Every device/journal call re-enters the bounded private invocation and
compares the original identity. Re-pairing cannot reuse the old queue silently;
credentials/private worker handles are not retained by the coordinator.

`assistantCoordinatorReadiness` reads the actual dedicated backend status and
requires matching assistant/device, human authorizer, `businessReady=true` and
all declared business capabilities. Pairing/contact, an executable, partial
capabilities or a caller boolean cannot enable model work. This product gate
is not proof of a trusted loaded hook or usable Windows desktop: the actual
protected call still needs the normal observed pass proof and the Windows
end-to-end acceptance remains mandatory after the ordinary production release.
The released backend advertises all six implemented capabilities with
`stage:released`, `businessReady:true` and no missing capabilities. Its existing
feature switch and live device verifier remain authoritative; no QA flag, local
readiness override, owner allowlist or separate pilot rollout is required.

`bridge assistant background` is an explicit host-only entry. Its stable
supervisor invokes current signed workers through the existing loader, never
scans plugin caches. Between cycles it runs normal
model-free maintenance, then starts one `background_tick` worker. That worker
keeps 30-second coordinator checks alive during its single native pass; actual
source polls/discovery retain the five-minute cursor/clock policy. It settles
the native/receipt/SQLite boundary before returning. The next cycle selects the
current immutable runtime; an active pass never changes implementation midway.
The ordinary request timeout stays bounded to three minutes; only this internal
worker can use the bounded 35-minute lifetime needed by a native pass.

Shutdown and ambiguous worker outcomes preserve existing durable fences. A later
cycle reconciles native/backend receipts before any new launch, never retries a
business tool or replaces a chat. Temporary source polling failure does not
independently cancel/repeat native work, and an unresolved failure is preserved
when the pass settles. Raw errors/content are not supervisor output.

This entry is not installed by import or pairing. Explicit Windows registration
is described below; actual next-run read-back, desktop availability and owner
onboarding require independent live evidence after deployment. Pairing alone
never installs or starts the service, and no user configuration changes on import.
Automatic plugin maintenance/idle Desktop restart is a separate explicit setup
opt-in described below; it never updates the Desktop application itself.

<a id="owned-windows-console-icon"></a>

### Owned Windows console and taskbar identity

An explicitly running Windows supervisor may have a visible **classic console**.
After protected identity and the exact OS registration are checked, the SAME
packaged native worker uses the presentation-only `--assistant-console-icon`
mode. Its control pipe receives exactly the canonical assistant UUID from that
verified host. It accepts no executable, command, resource, PID or HWND. The
helper attaches only to its direct Node parent, verifies the current user and
parent lifetime, and requires exactly that parent and its helper in the console.

The worker sets `ICON_SMALL` and `ICON_BIG` with
[WM_SETICON](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-seticon)
and verifies both with WM_GETICON. It then uses the window's
[Shell property store](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shgetpropertystoreforwindow)
to set the assistant's taskbar identity, separately from Node:

- `System.AppUserModel.ID` is `Trelio.DigitalAssistant.<assistant UUID>`, stable
  across runtime versions and restarts, separate for each assistant
- `RelaunchIconResource` points to icon resource 102 of this signed native worker
- `RelaunchDisplayNameResource` uses the documented literal-name form,
  `Цифровой ассистент`: the product has no MUI name catalogue, and resolving
  text from a differently architected EXE is unnecessary
- `RelaunchCommand` uses the absolute inbox `schtasks.exe /Run /TN` with the
  SAME pre-verified `Trelio-DigitalAssistant-<assistant UUID>` task. Setting it
  does not execute anything; a later explicit Shell launch still uses the
  scheduler's existing registration/principal/IgnoreNew guards

The three relaunch properties are written **before** AppID so Explorer refreshes
only after the complete taskbar presentation exists. Every value is read back;
a window-only receipt without verified taskbar properties is not success.
GUI/COM DLLs load only in this mode; ordinary private-worker startup is unchanged.
No Node executable, registry, default terminal, existing pinned shortcut, task
definition or business authority is modified. Existing user-created Node pins
are separate shortcuts and are not silently rewritten.

The icon uses the exact three bars/cursor geometry from the dedicated plugin's
`assets/trelio-assistant-logo.svg` (SVG SHA-256
`fbf526b22fb2324623e64aaa89fa5474d8d4cd6b4bb64c3255d22cdd1263131e`).
The hosted builder wraps the SAME reviewed 64px PNG array in a disposable ICO
and compiles it into the SAME x64/ia32/arm64 PE.
Icon resource 102 avoids the legacy extractor's special `-1` icon-count index;
native verification requires actual large and small HICONs, not just that count.
There is no extra runtime package asset, local compilation or Node.exe edit;
two complete hosted builds must still be byte-identical.

No console is allocated, shown, activated or brought forward. Shared/hidden
consoles and Windows Terminal/ConPTY hosts stay unchanged; their host application
icons and Node's Task Manager executable icon are outside this window identity.
Only this helper detaches before parent attach, even if its previous headless
association has no HWND. No unavailable console becomes a successful receipt.
Closed diagnostics expose no PID, HWND, path or raw OS error.

HICONs and the window properties live until the supervisor closes its pipe.
Partial startup and normal EOF restore only values still owned by this attempt,
leaving later independent changes intact. Branding failure stays cosmetic and
never blocks or grants business readiness or changes work deadlines.
Native Windows/ARM fixtures independently inspect the exact owned window's
Shell properties and fixed display name, extract its PE icon, verify restoration at
EOF and unchanged foreground, and retain shared/hidden/ConPTY no-op checks.
The classic-console fixture first proves its own HWND/class/visibility, then
detaches before release; Shell inspection never adds a third console process.
It requires the keeper to survive the successful receipt and exit cleanly on
EOF. Fixture inspection and child exit share the original bounded wait budget.

### Optional source-tree QA launcher

This is isolated development tooling, not a prerequisite for the normal
production release or its Windows acceptance. The operational release uses the
existing production origin, enrolled device and signed loader; do not disconnect
the user's VPN or migrate that identity to QA.

`scripts/assistant-qa-pilot.mjs` is a maintainer-only launcher outside the signed
package. It supplies one immutable trusted JavaScript composition to the SAME
setup, native MCP, hook, managed content/Workspace, source/ACK, private account,
coordinator, bounded child and Task Scheduler implementations. Production factory
calls retain their fixed `https://trelio.ru` origin and ordinary private journal.
No model tool, request schema, provider argument or runtime environment variable
can select this QA context. There is no second executor, provider implementation,
crypto engine, state journal, scheduler or consent mechanism.

The private JSON configuration has exactly `schemaVersion:1`, `origin`,
`configurationDirectory`, `pluginRoot`, `runtimeVersion`, `packageSha256`.
It contains no credential, human OAuth/session, provider value or company text.
Origin must be a non-production HTTPS origin; production apex/www/encrypted
origins and non-loopback IP literals refuse. Its private directory must not be
the production directory, its ancestor or descendant. New enrollment is mandatory:
copying an existing production/human identity or credential is not supported.
All company/device/pass/recipient/Hook/owner/action authority remains native.

The launcher reads an exact private regular file with an explicit SHA-256.
Every fresh request/Workspace child repeats that hash and uses the installed
shell's **existing `selectHostRuntime` signature/tree verifier**. The selected
immutable signed package must match the exact configured runtime version/hash;
source-tree code or an unsigned package never substitutes for it. The normal
loader-supplied public component versions come from that shell/selection. The
launcher does not download, install, publish, sign, activate or edit a runtime
pointer. Candidate delivery through the normal signed publication/updater must
already have been separately reviewed and completed; no per-device candidate
channel is implied by this helper.

Example command shape, with operator-selected public paths and hash:

```text
node <source-checkout>/scripts/assistant-qa-pilot.mjs --configuration <absolute-private-instance.json> --sha256 <exact-file-sha256> mcp
```

The same prefix plus `hook`, `background`, `background-install|status|start|remove`
selects the existing entry. The Windows task receives that same fixed prefix;
there are still no saved passwords, SYSTEM/autologin, force overwrite or Codex
restart. Codex MCP/hook commands for the isolated QA profile must point to this
reviewed prefix; a human separately enables Hook trust and performs ChatGPT/
provider input in the normal UI. The launcher does not rewrite Codex configuration
or automate those decisions. Requests to fresh worker children carry only the
original native DTO on stdin; the configuration path/hash are trusted launcher
coordinates, never MCP fields or credentials.

QA admission is read from the genuine dedicated native `get_assistant_status`
for that assistant/device and must have `stage:non-production-pilot` with all
ordinary business capabilities. The shared `assistantCoordinatorReadiness`
predicate is unchanged. Missing/disabled QA status or changed identity refuses;
there is no local `readStatus` result override. Task-pass/runtime-registration/
source-intake structural receipts still correctly say `businessReady:false`:
neither a lease nor observed registration proves a business outcome. Protected
API calls still require the same one-use proof, native ACL and current recipient.

For QA E2EE, leave the alternate data-plane setting empty or equal to that
canonical QA origin. The common data-plane resolver deliberately does not allow
an arbitrary second QA origin; production's exact `trelio.ru` → `e2ee.trelio.ru`
exception stays unchanged. All private account/inspection/browser/key locks and
SQLite paths use the same isolated configuration root through the trusted host
context, including nested owner review and source bodies.

Constructor/closed-worker tests establish this composition boundary; the signed
provider/HPKE fixtures exercise plain and encrypted profiles at a QA HTTPS origin.
They do **not** establish real Windows, genuine external account login, actual
notification/owner decision, provider ACK, recovery or next-run acceptance.
When this optional launcher is used, its own live tests require an isolated QA
backend, fresh signed artifacts and a genuine QA enrollment/device. Normal
production acceptance instead runs after the ordinary release using the existing
production device and published signed artifacts. Neither constructor tests nor
the QA flag proves a successful Windows business pass or task outcome.

### Per-user Windows autostart

`install_assistant_background`, `get_assistant_background_status` and
`start_assistant_background` are local setup tools with empty strict input
objects. They derive identity from completed protected pairing, the exact
currently loaded plugin loader and Node executable. No model argument selects
a user, command, task name, assistant or credential. Install/start verify live
device contact and repeat local identity after it; status remains usable during
a network outage. Other platforms return an explicit unsupported code.

Registration uses the local Task Scheduler COM API through constant,
profile-free noninteractive Windows PowerShell. Bounded UTF-8 JSON stdin carries
only public registration metadata; code is constant and no shell interpolation,
credential, private-worker pipe or raw OS error is exposed. It does not perform
ACL/DPAPI work, change policy or run the supervisor as SYSTEM. Existing common
private runtime and every business authority check remain unchanged.
The helper disables automatic module discovery in its own process and explicitly
imports only the OS utility module from the fixed PSHOME manifest. UTF-8
encodings use .NET constructors before that import. In hosted ARM64 evidence,
script entry took under 0.3 seconds but the first unqualified New-Object spent
22–35 seconds in module initialization/discovery; bypassing that catalogue search
does not raise any time budget or change installed modules or Windows policy.

Task Scheduler may return an account name for a SID submitted at registration;
read-back resolves it with the Windows account API and compares the immutable
current SID, never a display name. Missing/foreign/unresolvable principals deny.
One non-sliding 45-second setup budget includes private/contact I/O and native
registration; its remaining native process budget is at most 40 seconds. A
slow ARM64 PowerShell start cannot renew that deadline or cause an OS retry.
The constant helper emits only closed script/encoding/module/input/identity/
scheduler/folder/lookup/result stage names on stderr. Production discards that pipe; the hosted fixture may
print only the explicit enum to locate startup/EOF/COM timeouts. No OS value,
task definition, account, path or exception is added to diagnostic output.
Large host-owned constants use a bounded in-memory gzip carrier before UTF-16
base64 encoding, keeping the actual command below the Windows CreateProcess
limit. The original JSON stdin, one native invocation and deadlines are unchanged;
no temporary script, model code or credential-bearing argument is introduced.

The deterministic task belongs to the current Windows SID with least privilege
and `InteractiveToken`. A single logon trigger waits 15 seconds.
Creation grants only that SID,
SYSTEM and Administrators control of this one task, so an elevated installer
cannot leave the non-elevated supervisor with read-only registration access.
Legacy administrator-owned registrations with only a read ACE require an
authorised machine-operator ACL repair; runtime never elevates or changes their
custom ACL on a retry. Unlimited task duration, IgnoreNew, battery continuation
and three one-minute crash restarts
are read back from the actual native definition. No saved password, automatic
sign-in, privilege escalation or Codex restart is configured. After reboot the
user must sign into Windows; a disconnected RDP session and a user logoff are
different lifecycle events. GUI availability still requires its own test.
See [Microsoft logon type](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element)
and [logon triggers](https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger).

Install registers without starting now; start is a separate exact operation.
Reinstall reads back the existing identity/principal/action/trigger/settings;
a different definition conflicts rather than being overwritten. Concurrent
creation uses TASK_CREATE, never TASK_CREATE_OR_UPDATE. Start reuses a running
or queued instance with native IgnoreNew as the race guard. The explicit
`bridge assistant background-install|background-status|background-start` CLI
uses the same implementation. Owner cleanup via `background-remove` requires
that exact matching task to be idle; a busy/queued pass is never killed or
unregistered, and an ambiguous OS operation is not retried automatically.

Explicit plugin maintenance adds one closed exception: the SAME native helper
may retarget only the current assistant/device/SID definition to its newly
verified loader, with exact previous arguments from the protected journal.
`TASK_UPDATE` preserves its running instance and logon trigger. One optional
`TrelioPluginUpdate` time trigger starts in one minute, expires five minutes
later and retains IgnoreNew. A positive new definition is not rewritten while
that trigger is still future; an old parent after a lost reply may rearm only
an observed expired activation. No process is killed, detached or elevated.
Normal setup tools/CLI expose no retarget operation. Status and owner cleanup
validate that exact optional trigger too, never an arbitrary extra schedule.
The new confirmed parent removes the temporary time trigger through the same
exact helper; steady state retains the original single-logon definition.

Explicit maintenance opt-in checks that principal's own task write ACE before
writing the policy; an administrator token alone is insufficient. After an
authorised operator repairs a legacy read-only registration, repeating the
same installer opt-in may resume only a failed initial host handoff: identical
previous/target version and tree, no GUI generation or restart, and no distinct
failed candidate. The SAME setup lock/active-pass fence and journal CAS apply.
Polling never clears that latch; plugin/rollback failures and hook review stay
independent. Recovery resumes `retargeting`, never installation or task replay.

Owner-approved host replacement uses an internal composition of this SAME native
helper. It first inspects the old assistant/device marker, current Windows SID,
least-privilege definition and a closed Node/signed-loader supervisor command.
The old loader path is neither opened nor executed, so an updated plugin cache
does not require adopting another installed plugin. Only the full definition's
SHA-256, SID and old identity are retained in the protected pairing record; no
Task Scheduler XML, command or path appears in setup output. A later removal
reopens and compares that exact snapshot immediately before deleting an idle
task. Changed, foreign, running or queued definitions refuse; no stop, force
overwrite, task execution, password or automatic Codex restart is introduced.
Ordinary install/start/remove retain their existing exact loaded-shell checks.

The pairing coordinator owns the independent owner decision, active-pass fence,
quiescing journal and identity CAS. A snapshot alone grants no replacement. An
older already-running supervisor may not understand graceful shutdown; it must
remain a concrete waiting condition rather than being terminated underneath
unknown work. Native deletion can be reconciled as absent after a lost response;
neither another definition nor a new running instance can be deleted as a retry.

Status distinguishes not_installed/registered/queued/running from business
readiness and always reports `businessReady:false`. OS running state is not
proof of backend admission, source delivery, a native task outcome, working
desktop or actual next cyclic run. The coordinator retains its independent
full-readiness gate. Hosted Windows tests register a disposable UUID-scoped
task, reread and deduplicate it, refuse a replacement device, execute a tiny
native Node fixture and remove it after completion. They never touch an
assistant machine or claim the full Windows business pilot has passed.

## Dedicated plugin entry and setup

The separate assistant plugin selects the existing signed-loader ABI as
`bridge assistant mcp` or `bridge assistant hook`. The generic entry selects
`trelio-assistant-entry.mjs` explicitly; unknown subcommands fail before any
human bridge, config migration, credential access or cache maintenance. Hook
startup retains the common non-sliding clock and never consumes a human Run cwd.

Before enrollment, the stdio surface exposes begin/finish/status with a non-authorizing
enrollment UUID and the local Windows setup tools above. Discovery does not
register or start an OS task. Pairing composes the existing protected S256 journal, OS private store
and fixed HTTPS client, under one invocation-local Windows native worker. No
human OAuth/client configuration, owner browser login or credential-valued MCP
arguments exist. Unpaired discovery does not load private credentials. After pairing,
the read proxy below obtains live backend schemas. A confirmed local missing or
mismatched device slot, native device authorization rejection, or the fixed
assistant MCP discovery's authentication/scope rejection keeps these SAME six
setup tools available with a closed recovery `_meta` diagnostic. It never returns
a false paired/ready result or grants a business schema; business calls retain
the original denial. Malformed/private-store I/O, unsafe paths, unrelated
provider/human MCP failures and network errors remain hard failures. Input frames are bounded
at 128 KiB; unknown tools/fields and raw failures cannot expose the private journal.

An already completed pairing is read back privately and checked by live heartbeat;
retrying the setup tool never repeats the one-use exchange. An uncertain exchange
survives restart as recovery_required. Setup output distinguishes paired/contact
from business readiness. Task-pass admission and the installed background service
remain required; the local setup profile never claims business readiness from
registration/contact. The assistant hook composes the ordinary observer, proof serializer, state lock
and invocation-private deadline. Without a live exact pass it denies task calls
with a closed reason and JSON-deny/exit-0, including malformed input on Windows shells.

Replacement uses a NEW explicit owner decision bound to the old assistant/device
and candidate. Ordinary add-device approval is insufficient. Before native pairing,
the SAME protected host mutex records a pending-owner denial and rejects any
retained pass, including a locally unresolved journal after native completion.
New work/maintenance cannot start while pending or quiescing; existing receipt
reconciliation remains independent. Definitive native denied/expired pairing may
release only the pending denial with the unchanged old identity and no pass,
even if the old credential is broken. Time alone, unknown exchange or an active
candidate never releases a fence.

The candidate is staged in the SAME OS-protected enrollment record, not the active
device slot. A legacy half-commit is located only at the native-selected exact
assistant slot, without a private cache scan or automatic account/session transfer.
Persist the candidate before attaching it natively. A NEW explicit persisted owner
replacement receipt can be read by candidate heartbeat beyond the short pairing
code TTL; the old one-use exchange is never replayed. Unknown exchange remains a
concrete recovery blocker. Known pass/intake/state conflicts retain their native
reason instead of becoming a misleading waiting-owner loop.

Activation requires the old background registration to be absent or exactly idle
under the native snapshot/CAS checks above. New supervisors exit gracefully and
fresh signed workers refuse new work before any action. An already running older
supervisor may not understand this journal; only a positive busy read returns the
exact `Trelio-DigitalAssistant-<old-assistant UUID>` task and asks its human owner
to stop that task, then finish the SAME enrollment. No kill/force, journal deletion
or active-pass cancellation is performed. Unknown OS removal is read-back only;
only an exact native pre-delete BUSY refusal permits a later explicit attempt.
The active credential and identity are published only after this protected
preflight. Persisted stage/read-back completes a crash after credential or identity
publication without repeating exchange, credential write or OS deletion.

A facade already loaded from an older runtime cannot gain its new discovery catch
from a child-worker hot update alone. After publication, a fresh native MCP spawn
(for example one new chat when the client needs it) may be required; no automatic
Codex restart or hook trust is performed. Healthy SAME-device reuse with a NEW
enrollment is a separate known follow-up; it is not claimed by this replacement
contract. Reusing the SAME completed enrollment remains idempotent.

`trelio-assistant-setup.test.mjs` checks projection, restart fences, real stdio
frames and denial; the actual generic-entry child test confirms that discovery
creates no human/private state. These tests do not establish real Windows pairing.


## Authorization renewal

The device credential's private envelope retains the pairing-time expiry only
as historical metadata. It is not a second offline authorization cache. The
owner may renew the same device from Trelio, setting now + one year without
accumulating years or touching the assistant computer. Every fixed runtime
endpoint remains authoritative for current absolute/idle expiry, lifecycle and
revocation. A server denial preserves the private credential and queue; it does
not trigger re-pairing or automatically repeat a mutation. A later model-free
pass can establish live recovery after the owner renews. Other local identity,
S256 one-use exchange and secret-storage guards remain unchanged.


## Task-pass hook and protected host journal

`trelio-assistant-hook.mjs` binds the actual hook `session_id` to the permanent
chat of the one active task pass. It never falls back to an inherited human
conversation or accepts a model/effort/pass declaration from tool arguments.
The ordinary observer reads native turn context; the ordinary v1 proof serializer
issues a fresh nonce/signature for each tool. The hook overwrites pass/proof input.
Backend registration/read/renew/end have fixed assistant-device HTTP routes and
reuse the common server session/model-policy/nonce engine through genuine device
provenance. This source addition does not expose business tools by itself.

A completed pairing stores a private structural `identity.json`; another device
or assistant cannot silently replace an existing host identity. Credentials,
active-pass journal and Ed25519 private keys use separate OS-backed slots with
origin/purpose/UUID binding. Keys are not in SQLite, Workspace, prompt or argv.
The active journal may only be released by an exact positive backend outcome;
SessionEnd, timeout and CLI exit are insufficient. The background coordinator's
actual pass lifecycle and outcome adapter must wire this explicitly before
activation. Missing configuration does not reuse human OAuth.

The initial signing key and one pending refresh key are saved before registration
I/O. A lost reply reuses the same key after restart; a model/effort change creates
an immutable successor without extending the predecessor's TTL. SessionEnd saves
a local end fence before HTTP; a lost end reply cannot authorize signing with a
remotely ended key. Compaction reuses the common full pinned-authority reminder.
All private I/O and network work use the original non-sliding hook deadline.

Tests cover real Ed25519 verification, current native transcript observation,
wrong chat/device/pass, concurrent registration, lost response/restart, model
refresh, expired deadline before first read, exact journal release and stdio
redaction. They are not a Windows end-to-end task or installed daemon proof.


## Assistant read MCP proxy

After protected pairing, the stdio profile obtains `get_assistant_status`,
`get_task`, `get_task_sections` and `get_task_instruction_page` definitions from
`/mcp/assistant`. The backend owns the schemas, company policy and native reads.
The same read proxy may expose search_agent_guidance, get_agent_skill and
get_agent_procedure when the dedicated backend advertises them. They retain
native membership/project ACL, published-only authority and the assistant's own
personal skill rules. Unsupported dedicated execution does not permit a human
bridge, OAuth or provider fallback.

### Genuine company-context read origins

The v2 genuine device profile can select the existing session-fixed
`company_context` presentation from an ordinary live task-work pass OR a full
native-confirmed verified private-owner intake. The latter remains taskless:
its original source/device/company/thread and one-use observed proof authorize
only the SAME native reads, never a task writer, Secret or Workspace Run. Group,
route_existing, unread/closed intake and discussion-only passes refuse. The
standard v1→v2 contact upgrade retains its native grant/receipt rules; fresh
presentation grants no scope, key or human identity.
The view contains the SAME native search/fetch/inventory/exact-read handlers and
deferred contracts, original task/KB attachment downloads and one exact published
registry-file selector; task writers/owner setup/source intake are not appended.
Raw and model catalogues each retain 65 536 bytes, transport retains 4 MiB.

Initial task/intake discovery also includes the native `search`, `fetch` and
`get_trelio_tool_contract` definitions from that SAME company session. They are
present before a pass/model turn, not dependent on `get_assistant_status` or a
late `tools/list_changed` refresh. Codex may finish a turn before refreshing its
model inventory. Writers remain advertised, but metadata never grants their
execution to an intake. Company discovery calls use the native company session;
ordinary task `get_task` retains its task schema/adapter. A routing-only intake
still refuses search before I/O. Search results are followed by exact fetch and
needed current discussion; snippets or stale initial descriptions are not facts.

Cold encrypted search preparation reuses the SAME complete company mirror and
the common short-wait operation registry. Each `search` first consumes a fresh
native schema/proof/read admission. The host-only descriptor pins that original
pass plus the exact managed scope/epoch/device/envelope; it contains no query,
source body or key. One existing signed request child prepares the complete
mirror under the existing ten-minute first-sync budget. Short MCP polls keep
their ordinary deadlines and return `state:preparing` plus a fresh `search`
nextCall; this is neither an empty result nor a terminal unavailable reply.
The model continues the same question without a task, Run or owner decision.
Only readiness is retained in RAM. The actual query executes in a fresh managed
invocation, without replaying the consumed MCP proof or a cached business answer.
Recipient/pass/ACL/manifest and late native fences remain independent. EOF aborts
only the host's preparation children and awaits cleanup; encrypted scratch may
resume normally, but an incomplete mirror is never published or searched.
The common mirror writer recovers an exact fresh dead-owner claim through its
existing metadata mutex, native ESRCH and protected identity rechecks. Live or
unknown owners are never declared dead from elapsed clocks. A cold mirror keeps
its original first-sync join bound; the short stale-generation refresh wait
does not turn a healthy first sync into `LOCAL_CONTEXT_SYNC_BUSY` after 30s.
If the exact owned preparation signal expires, preserve a dedicated closed timeout
code instead of reporting an assistant-setup failure. Native Git/ChildProcess
aborts wrap that exact signal reason in `AbortError.cause`; accept only the
reviewed `AbortError`/`ABORT_ERR` shape with identical cause, or the direct reason.
The common private session also retains exact deadline Error -> original Signal
identity in an internal WeakMap, never in a frame or model-selected field. Its
own closed budget error may follow this same recovery only for that exact
expired preparation signal with a TimeoutError reason. Foreign/forged budget
errors, ordinary cancellation and unrelated refusals after expiry stay hard.
An error name, elapsed clock, unrelated cause or ordinary cancellation is not
deadline evidence. An explicit closed set of common mirror/accepted-file read
errors crosses the same worker frame as `ASSISTANT_COMPANY_CONTEXT_*`, without
exception text, details, private paths or any retry grant. The SAME short-wait registry
may resume encrypted scratch in one new bounded readonly child, only after another
fresh native search admission. Concurrent waiters count one stopped child; a second
expired attempt is terminal and cannot launch a third child. Neither child's
original deadline is extended, no query/proof/writer is replayed, and transport,
provider timeout, cancellation, ACL/recipient or unknown failures never enter this
recovery. Host-lifetime retry metadata follows the SAME bounded retention; it is
not a second journal or a completed mirror/answer.
Failure accounting commits when the owned child settles, even BETWEEN short
polls. It must not depend on a waiter observing that rejection: the common
finish registry may discard its failed entry on the next start. The bounded
preparation cell retains ordinary refusals and the second owned timeout before
another start, preserving the one-resume cap and fresh native admission.
Company-context GET requests read/sign one fresh coherent native private-store
value without taking the exclusive registration/end mutex. Keychain item updates
and ACL-checked atomic DPAPI envelopes provide the snapshot boundary; there is
no retained key or observation cache. Pending/ended/expired or mismatched records
refuse. Registration/end writers and other routes retain the original lock;
native pre-read admission and final session/model/pass/recipient checks remain.
An end/rotation racing a signed read is checked by that same native endpoint,
as for any request already in flight after releasing a mutex. No lock deadline,
private-session budget, proof lifetime or replay policy is extended. The real
Windows cold composition must include concurrent file reads and MCP polls.
Cold company native-pass revalidation dispatch is paced at 80ms per admission
in the SAME managed invocation, shared by its four file readers. The server's
1200/minute IP ceiling stays unchanged; the nominal 750/minute reservation rate
leaves headroom for foreground polls/hooks. Timer delays may coalesce at most
the four pending file readers; idle time cannot accumulate more permits.
Only future dispatch times are retained,
never a native response, key or permission. Identity and the native lease/ACL
are read AFTER the abortable wait, and every content endpoint still validates
proof/pass/recipient independently. An idle interval cannot bank permits. The
original first-sync/private/HTTP deadlines and hard refusal on 429 stay intact;
this is pacing before first dispatch, not retrying a failed or unknown request.
Tests cover actual serial MCP/current-child pipes and a real aborted Git blob,
native admission, real managed
HPKE/mirror search/exact source/file reads, rotation refusal and cancellation.

The outer signed-request boundary preserves only fixed local transport codes:
`ASSISTANT_RUNTIME_REQUEST_TIMED_OUT`, `_CANCELLED`, `_PROCESS_FAILED`,
`_INPUT_FAILED`, `_OUTPUT_FAILED`, `_EXITED`, `_EMPTY_RESPONSE`, `_INVALID_UTF8`,
`_INVALID_JSON`, `_INVALID_FAILURE_FRAME`, `_INVALID_VALUE_FRAME` and
`_OUTPUT_TOO_LARGE` (each suffix uses the same `ASSISTANT_RUNTIME_REQUEST`
prefix). These identify the boundary, never the cause of a native crash or an
unknown business outcome. Native exception/stderr/stdout, paths and exit prose
are not projected. The same existing process/pipe deadlines and byte bounds
apply, and no category grants an automatic retry. A generic unavailable result
from an older loaded facade is insufficient to infer which boundary failed.
Older facades may report only `_INVALID_RESPONSE`; it does not identify which
validation failed. Fixed categories contain no output, paths or error prose.
The request producer and consumer share ONE closed refusal-code predicate,
including current source/account/process enums and Workspace/lease/provider
codes. A valid local refusal never becomes an invalid response at the pipe.
Bare auth codes remain hard refusals without device setup provenance; only
the independently validated exact native recovery fields grant that recovery.
Real-process fixtures cover success, native refusal, cancellation, timeout,
startup/exit and empty/malformed/oversized pipes without an account or model.
Native stdout-pipe errors settle this one request through the same closed frame
instead of becoming an unhandled event on the long-lived MCP process.
UTF-8 decoding is fatal for damaged or truncated sequences: native bytes cannot
silently become replacement characters inside an otherwise valid JSON answer.
Split multibyte chunks remain supported; BOM-prefixed JSON remains rejected.

Every trusted MCP materializer shares one closed local-error projection: source
read/reply, company/task/skill read, accepted company file, original attachment
and Workspace arguments. Preserve the reviewed local recovery-code grammar;
unknown failures expose only `ASSISTANT_MCP_LOCAL_<STAGE>_FAILED`, never exception
text, paths, causes, provider output or an automatic retry. A callback refusal
must not become an unavailable MCP endpoint. Stages are fixed host constants.
The arguments adapter may invoke the SAME native send; an invocation-local
WeakSet retains only its exact thrown object. That object keeps native endpoint
authentication/scope provenance. A copied error or a provider Remote MCP error
from a local materializer never borrows assistant-device setup recovery. Native
admission, one-use proof, unchanged deadlines and no-replay remain independent.
Tests exercise every callback through the real MCP wrapper, exact native send
versus copied auth errors, privacy and one native call per explicit invocation.

Native selected ciphertext has the lifetime of its exact decoded response. The
managed profile holds only weak root/projection associations, not a cumulative
company-wide entity map. Common mirror field-only metadata projections explicitly
inherit their native root; bounded record arrays combine those exact selections.
The SAME hydrator requests only 250 selected IDs at a time, refuses an unknown
clone/missing reference and conflicting versions within one batch, and repeats
live pass/scope admission. Every native response retains its 4096-payload/32-MiB
bounds and reference coverage. A complete mirror may legitimately exceed 4096
entities across responses; consumed snapshots do not retain their ciphertext.
No JSON capability, general resolver, eager/double decryption, new index, key
source or HTTP endpoint is introduced. Regression coverage decrypts a full
4096-entity cold snapshot, mirror metadata/search projections and another exact
source in both genuine task and private-owner profiles before publication.

The combined catalogue retains the existing byte bound without truncation:
identical scalar leaf schemas may share local definitions inside ONE tool.
Whole descriptions, formats, regexes, defaults and bounds remain unchanged;
references expand to the same schema. Existing refs/IDs, unknown vocabulary or
scope-changing dialects disable this optimization. Tiny contracts remain inline
when definitions cost more. Native wire validators/pre-send shape checks always
use the original fresh schema. Test the initial native Codex MCP inventory,
owner/task/triage transitions and encrypted search/exact calls independently.

Every source keeps its native company/project/object ACL and current effective
scopes. Admin membership expands only ordinary results. Before any source
content the native and local profiles bind the current company/pass/device;
a found task never changes assignment, permanent chat, writable task/Workspace
or pinned execution rules. Source authority/provenance is returned as data;
only known human `proposalProvider`/`codexThreadTitleReminder` instructions are
omitted. Destination disclosure remains independent of source read access.

The production pre-send boundary obtains the fresh native schema/mode first.
For encrypted content it replaces all original arguments with one closed
host-only `localContextRead:true` branch and the original managed admission.
The model sees only the native business schema and cannot select that branch.
Queries/paths/filters remain invocation RAM, then the SAME mirror matcher/exact
reader/hydrator uses only native ACL-selected ciphertext and the managed
assistant/device namespace. Exact pages, payload digests, current recipient,
envelope/epoch and pass/scopes are checked before and after I/O; no plaintext
HTTP/index/outbox, general resolver, human keys or mode-failure fallback exists.

Original Workspace files reuse the SAME accepted-head/path reader and private
file primitive without a Run/lease or source write grant. Task and KB originals
reuse the SAME immutable media descriptor/header/stream and HPKE/TRELIOE1
materializer; the KB AAD stays `file.company_page_attachments`. Native page and
attachment UUIDs select one fixed stream; encrypted names/MIME stay inside its
container until local opening. Late authority/digest/AAD/epoch changes prevent
private publication. All local originals retain the shared 24 MiB/one-hour
owner-private file contract, not a promise of remote deletion or durable saving.

Registry publication is narrower than Workspace access: exact registry/row UUID,
row revision, document column/index select ONE pinned published file through the
SAME native publication service. No Workspace snapshot/path/head/key or siblings
are delivered. Plain bytes use the common private-file primitive; encrypted
published-registry delivery currently returns a typed unavailable result before
source/Git read because the shared human service lacks an independent per-file
ciphertext descriptor/AAD contract. Ordinary encrypted Workspace access cannot
be substituted for that missing publication capability.

### Managed company runtime consent

A company-authored/unverified signed runtime in a stable plain or encrypted company uses the
SAME native consent, signed resolver/cache and process engine. A task never
opens the ordinary human loopback consent window or posts a human bridge grant.
The genuine managed profile returns `ASSISTANT_SKILL_OWNER_CONSENT_REQUIRED`
before package/cache/provider access. Native `get_agent_skill` supplies the exact
structural owner-review fields, publication and instruction/package hashes.

The owner explicitly approves the native `accept_skill_runtime` sealed action
in Trelio. The task applies `skill_consent` with the original request UUID and
question ID; this is a native-only metadata receipt, never a local command plan.
The presend boundary rejects unknown root/parameters, device selectors and model
fingerprints before HTTP. In encrypted mode only the managed private profile
may add its own fingerprint. A fresh common resolve and pre-spawn admission,
never the question or receipt alone, prove execution may continue. Lost effects
are read back through the existing native operation receipt without a second
consent. Encrypted private preview uses only native-selected manifest/publication
markers in the same bounded managed bundle, own recipient/current epoch and
injected exact resolver. Before staging an owner question the host uses the SAME
Ed25519/TRELIOE1 inspector; it seals the actual capabilities/size in the reason
without executing or caching the pending package. After approval, a fresh native
resolve plus final spawn recheck bind the immutable ciphertext artifact, not its
separate verified plaintext cache digest. A real signed-child fixture covers
inspection/no process, approval/execution and late ciphertext change refusal.
Generic account setup remains independent; missing support never selects human
UI/OAuth as fallback.

### Shared task-skill execution

`get_agent_skill` may return the existing `skill_run` action through
`continue_assistant_workspace_action`. Its parameters/release come from the
native reader and strict backend branch validator, not a host schema copy.
No second executor, package loader, HTTP endpoint or account vault is created.
The existing isolated action worker calls `runWorkspaceCommand` under the same
assistant Workspace HTTP profile. Only native `runtime/resolve` and
`runtime/package` gain this task profile: fixed origin/company, genuine device
grant, exact pass/project, observed model/effort and fresh operation proof.
Setup/consent/secret endpoints never fall through to human OAuth. The Remote MCP declaration endpoint uses its separate genuine task profile below.

The common engine verifies/materializes the signed artifact, selects the
account and starts the normal Node/Python provider. Human admission caching is
disabled for this profile; live resolve runs again immediately before launch
and must retain the artifact/hash. A cached package never preserves revoked
task/device/policy authority. Public verified execution, reviewable company
code, encrypted configuration and Secret-backed authentication retain their
separate native admissions described below. Protected account setup and
unverified code require their independent current owner decisions; shared
capability readiness cannot replace them.

The same account catalogue uses an assistant/device namespace with native
company bindings. Task calls do not migrate human legacy accounts, mutate
account setup or list unbound other-company labels. No provider credential is
copied into the catalogue. The verified permanent task chat supplies
`CODEX_THREAD_ID`; model-free monitor still strips it. Host origin is inserted
before the provider `--` boundary and never changes provider arguments.

The shared process engine's internal task capture returns bounded complete
UTF-8 pipes with closed stdin and an absolute deadline; no inherited fd1 bypass
of the action worker is allowed. The existing visual validator/MCP projector
handles visual results. Monitor-only capture and ordinary human stdio retain
their current boundaries. Failed/uncertain provider execution is never replayed.

`cancel_agent_workspace_run` is a server-only native cancellation, exposed only
when the dedicated backend advertises its live schema. The host forwards one
exact Run/reason intent with hook-owned admission, without a human flag, local
command, file deletion or automatic retry. The backend restricts it to this
assistant's own unaccepted Run in the current pass's canonical task. A matching
native receipt fences that Run; it does not finish the task goal or disable its
cycle. Accepted history and useful local work remain available for recovery.
Cancel/restore stay closed in the local Workspace continuation and HTTP profile.

`repair_assistant_workspace_result` is a separate server-only self-repair surface,
available only from the dedicated live catalogue. The host forwards its native
`operation=retract|restore` schema, exact accepted Run/head and hook-owned pass/proof
once. It neither copies native branch validators nor invents approval flags.
`retract` retires erroneous own evidence without changing accepted files. Native
`restore` is restricted to that retired Run's exact base while its candidate is
current; subsequent changes require a normal `no_status_change` Run that reverses
only the own erroneous delta and preserves later work. Conflicts remain blockers.

In encrypted companies, only the closed structural retract branch crosses this
native surface. Unknown fields, reasons and arbitrary operation names still fail
before HTTP. No key or ciphertext is needed to retire evidence. Correct files
through an ordinary encrypted no_status_change Run from the current head, using
the accepted own base/delta and preserving later work/current control files. Read
back accepted files before attaching correctionRunId; direct restore stays closed
in this profile, without a human auth or server-Git fallback.

The worker must inspect the resulting accepted files, then call `retract` with
the verified `correctionRunId` and exact current head. Neither the source nor the
correction is business completion. Continue the real human goal with a valid
material result or a concrete blocker; no timestamp-only Run or reuse of retired
evidence through `noChange`. Dirty local work is preserved by the common bridge
recovery. An uncertain restore requires native read-back of the original result,
never another restore attempt. No new local dispatcher/HTTP operation, human
OAuth path or encrypted data-plane fallback is introduced. Backend integration
tests exercise native Git restoration and completion exclusion; the proxy tests
verify live-schema projection, immutable intent and no mutation replay. These
are not proof of real Windows business readiness.

The host only applies a closed transport capability allowlist; it does not copy
schemas, widen authority or expose unknown/new server tools. Setup tools remain
available before pairing. A successful finish emits `tools/list_changed` so the
client can refresh the catalog without storing an OAuth token or rewriting config.

Before the protected-content callback can stage anything, each call reads the
CURRENT tools/list in that SAME MCP session and original deadline. A bounded
structural inventory traversal checks native closed object keys, required fields,
container/scalar types, published syntax patterns, enum/const alternatives and local schema refs. It uses
that exact schema, never a mirrored tool map/cache, external resolver, value
coercion or echoed input. Hook-owned root fields share the existing model-schema
projection. Freshly added native fields work without a host schema update;
removed fields cannot reuse earlier discovery as staging authority. Generic owner-action fields use the SAME live operation schema with wrapper-only metadata removed. Generic
skill_run parameters additionally use the SAME pure Workspace continuation
parser before encryption; no task pass is fabricated for local validation.

This privacy preflight is deliberately not domain authorization or a replacement
JSON-Schema/Zod validator: native format/refinement/proof/ACL/CAS checks remain
mandatory. Invalid shapes never reach payload preparation or tools/call. Catalogue
reads carry no caller arguments, and failure/lost mutation response never retries
a business call or refreshes its original budget.

The dedicated device bearer is read from the same protected slot on every
invocation. Shared Remote MCP protocol/session/HTTP primitives provide bounded
JSON/SSE, fixed HTTPS with pinned DNS validation, no redirects and cleanup. The
internal assistant-device header profile is rejected by the public provider
configuration validator. It is not a personal PAT or human OAuth connection.
No private credential/key enters tool data, schemas, logs, prompt, argv or env;
an accidental response echo of the exact device credential is refused.

Before enrollment, discovery checks only whether the structural host journal
exists. A present journal requires the normal private ACL/identity path. Denial,
corruption, failed network contact or lost response never becomes an empty paired
catalog, re-pairing, login, or an automatic repeated `tools/call`. One invocation
scope bounds journal/DPAPI, MCP handshake/request/body and cleanup. Private worker
and token are not cached in the long-lived stdio process. Results preserve the
native read/authority envelope, while App metadata/security schemes are not
proxied. Each task call still requires the actual hook's exact pass and proof.

Transport/stdio tests verify live schema forwarding, argument snapshots, fixed
audience, missing setup, post-pair catalog notification, unsupported tools,
credential echo refusal, preserved pairing after failure, redacted errors and
one deadline without a hidden retry. This does not install a daemon or prove a
Windows business pass/outcome; the released native status is independent of
those runtime receipts.

## Model-free maintenance

The dedicated stdio MCP is a stable facade: `bridge assistant request` selects
current signed code using the exact installed loader for each bounded invocation.
No runtime file is overwritten, no in-flight invocation switches executable,
no MCP business call is replayed, no Codex/plugin config or hook trust is changed.
Unpaired discovery remains structural lstat only, without worker/credential I/O.
The request ABI is closed list/call/health/health_check with bounded UTF-8 stdin/stdout and
suppressed stderr; a failed child is uncertainty, not retry permission.

Every five minutes, while the facade is idle, a maintenance child checks the
signed updater and live device health. An active protected task pass defers
updating. A fresh signed health_check child proves activation after a successful
download; the old process version cannot claim the new runtime is loaded. The updater and signature verifier remain in the common stable shell;
missing/inaccessible shell is not replaced by a cache scan or human OAuth.
A proven missing loaded shell reports `plugin_restart_required` directly over
the retained protected diagnostic client, even when no loader can be spawned.
Runtime/code updates do not need plugin installation or a Codex restart.

The health API remains independent of business minimum/model policy but retains
live device/owner/lifecycle/expiry. It returns shared plugin/runtime minimums;
a merely newer release does not block work. Actual incompatibility refuses new
business calls and reports a closed reason with CAS and request UUID. No raw
exception, credential, local path, company/task context or model-generated
instruction reaches the journal/outbox. Failed health delivery cannot replay
business work. Only the correct successful boundary may clear a login/trust
latch; unrelated metadata success is not recovery.

Retained coordinator uncertainty reports `dispatch_review_required` through that
SAME device-health CAS and owner inbox/outbox. A returned blocked reconciliation
is reported as well as a thrown delivery uncertainty. The CURRENT immutable
tick worker owns this report, so an older already-running supervisor needs no
restart/new enum to notify the owner. Duplicate worker/parent observations preserve
the existing latch rather than post again. A missing model or waiting
owner does not become this device incident. The independent dispatch latch survives
metadata-ready reports, a recovered login/hook and tool-free READY provisioning.
Only a confirmed native/business completion, committed local schedule/inbox and
released protected pass may clear it, and only when the SAME device-wide journal
has zero retained uncertain deliveries/intakes. It never grants work or adds a
new global business stop. A newer unrelated incident is retained; failed diagnostic
CAS/network I/O cannot undo a receipt, reopen a pass or replay a business action.

The fixed host header `x-trelio-assistant-health-protocol: 2` advertises only this
closed diagnostic projection on the existing GET/POST health routes. It is no
ACL/proof/version override. Older/missing/unknown protocol clients keep the prior
closed reason/latch DTO: the dispatch reason is `not_checked` and its latch is
hidden, with unchanged CAS revision/generation. Their ready reports cannot clear
the stored incident. Owner web/SSE/messenger projections always retain the real
closed cause. No endpoint, notification engine or global minimum is added.

Backend account notifications deduplicate incidents, copy to linked messengers
with ordinary FIFO/retry rules, and send one recovery notice. The server detects
missing health reports after 15 minutes even if Codex/host is gone. Unknown
absence has no invented plugin/network diagnosis. Runtime update failures have
a five-minute recovery window; owner-action errors are immediate. Legacy setup
continues to exclude plugin updates/Desktop restart unless this device explicitly
opts into the following maintenance policy. Hook review and login remain human.


### Automatic assistant plugin maintenance (Windows)

The human may opt this paired machine into plugin maintenance once through
`install_assistant_background({autoUpdatePlugin:true})`, or the host-only
`bridge assistant background-install --auto-update-plugin=on` command. The same
signed runtime entry forwards only this exact `on|off` installer option;
other commands/values/extra arguments refuse before the assistant spawn. The
installation path writes a bounded identity-bound private policy only after
native registration/read-back. Omitting the option preserves existing policy;
`false`/`--auto-update-plugin=off` disables it. No flag is a business/owner grant,
a hook approval, a password, autologin or permission to update ChatGPT Desktop.
A legacy setup with an explicit no-restart contract remains opted out.

Each existing supervisor tick selects the current signed implementation. An
opted-in legacy parent receives one registered graceful handoff to acquire this
implementation; no manual parent restart is needed. Later runtime changes use
the same idle handoff, without restarting Desktop for runtime-only updates.
Only that background path maintains plugins; ordinary MCP idle health never
closes a human's setup chat. Windows first uses the SAME SQLite coordinator
lease, refuses every retained pass/incomplete delivery (including uncertainty),
renews the ordinary short lease and checks it before effects. The SAME setup
mutex excludes re-pairing and interactive source login during maintenance.
The closed maintenance profile has one 150-second private-process budget and
preserves every enclosing cancellation/deadline. Positive coordinator/setup
lock contention quietly defers this tick, without an update-failure notice.
The current protected identity/policy/pass is rechecked, including immediately
before native process launch. No task/chat/receipt/queue is removed or migrated.

The shared human updater has closed assistant-main and assistant-hook profiles, reusing the
native executable resolver, official Git marketplace, bounded JSON CLI,
immutable-tree verifier and exact loaded-code retention. Commands are
`plugin marketplace upgrade trelio-digital-assistants` then, only for a newer
immutable `plugin-vX.Y.Z`, `plugin add trelio-digital-assistant@trelio-digital-assistants`.
An absent/disabled MAIN plugin is not installed/enabled. A required missing hook
companion may be installed from the SAME official marketplace; a human-disabled
companion is never enabled. Its exact independent version/inventory digest
come only from the verified main package, never model input. There is no experimental
`plugin/install` RPC, cache-version scan, copied executor, raw config edit or
alternate credential route. The release channel/source cannot come from a task.

An optional marketplace discovery outage before any install intent retains the
verified current plugin and does not block business work. A failed activation
stays blocked for that exact version; a newer release can replace it while
preserving the last verified rollback basis.

Native Codex may already materialize a genuinely newer official main while a
previous installed candidate is still awaiting activation. Fresh verified and
retained inventory can adopt that exact version only when it equals current
marketplace discovery and exceeds both the pending and failed versions. Preserve
the original known-good rollback receipt, journal a new activation before GUI
effects and perform the ordinary hook/MCP/registered-parent checks. Never run
another native add, reset trust or infer readiness from this observation. An
unresolved main/dependency installation, absent original tree receipt, changed
hook dependency, stale discovery, downgrade or the failed candidate itself
cannot use this transition.

A separate private structural journal records the previous verified tree,
exact intended version and install/close/start/verify phases before side
effects. Lost install replies reconcile the exact native inventory rather than
repeat installation. Loaded old bytes remain preserved by the SAME retention
watcher. Handoff checks the newly verified loader through the common filesystem/access
resolver, but derives old action arguments literally from the loader-selected
root and protected previous/failed versions. Those old paths are native CAS
comparators, never executables: native cache pruning must not block forward
activation or rollback. Principal/marker/definition checks remain unchanged.
Rollback/native inventory reconcile the original protected receipt through the
SAME retained-code verifier. Hook-free detached main re-clones may carry newer
inactive Git history, but not changed commit/config/hooks/payload; the complete
preservation contract defines that narrow comparison. Physical observed digest
stays separate; no failed-version latch or historical receipt is reset.
Windows AppModel selects this user's exact Codex package; the fixed
manifest GUI `App` is independent of its `CodexCoreCommandRunner` companion.
The bounded public helper selects only this session's exact executable/window
and process creation generation. Closing an Electron window may merely hide it
in the system tray. The SAME signed native worker instead requests a normal
Windows Restart Manager shutdown of ONE registered Codex process. It independently
checks current user/session, AppModel executable and exact creation time, keeps
its original process handle, rejects any expanded resource list, and never sets
the force flag or opens termination rights. Inspection selects the unique package
application root from its same-user/session process tree, including a hidden tray
window; renderer children cannot become an application and a hidden old process
cannot masquerade as a freshly activated plugin. Refusal/timeout retains the original
uncertain phase; there is no window-only fallback, local compilation or retry of
another generation. The existing enclosing deadline and idle fences remain.
Restart activates the registered package application; there
is no UI input, elevation, shell command from a model, login or trust mutation.
A known same generation permits at most one further graceful-close attempt;
a lost successful close/start is observed, never replayed on another process.
An asynchronously starting GUI is observed on the next tick; an immediate
stopped read never causes a second activation in the same tick.

After GUI verification, `retargeting` persists before the SAME native helper
updates the registered action. The old parent returns its already-supported
`quiescing` result and releases its lease/snapshot normally; the bounded native
trigger starts the new registered action later. Native IgnoreNew prevents a
second instance if the old process is slow. The next parent rechecks GUI/hooks/
MCP before business resumes. Rollback also restores the registered loader;
it cannot leave the bad version armed for the next Windows sign-in.

A content-free `supervisor.json` in the SAME identity-bound maintenance directory
records only the actual parent's signed runtime version and random generation.
That generation is passed to its own request children, never used as hook/task
proof or an owner grant. Missing/stale generations require the idle registered
handoff before the worker can migrate to a newer parent implementation.
The already-loaded signed parent retains technical maintenance if a newer shell
floor prevents a fresh worker from loading. That path uses only global live
device metadata, the SAME idle lease and verified native plugin code; it cannot
run old business code, a model, a company read or a task/provider mutation.

After a new process generation, a fresh native App Server probes the effective
trusted three-hook definition and the configured assistant MCP/setup tools.
Global native `runtimeStatus:null` is only catalogue/configuration evidence;
a fresh child from the exact newly installed verified loader must also return
the live matching assistant/device status. This is technical activation, not a business result or
proof that every old chat refreshed. The next real task still uses its SAME
permanent visible Desktop chat, normal native handoff, observed hook proof and
business receipt. No hidden CLI work or replacement task chat is created.

The hook-owning companion contains only its native manifest, hooks and exact
pinned shared shell. Codex fingerprints its entire bundle. The mutable main MCP/
skill plugin therefore owns NO hooks and includes only a closed dependency
descriptor. A main-only update must preserve all native hook hashes; changing
hook/loader bytes must still invalidate native trust. No mutable code/instructions
are hidden in fingerprint exclusions, symlinks or indirect unverified launchers.

Before either main or hook installation intent, a fixed public Git preflight
checks the generated installable ref. Marketplace metadata may precede it:
only a complete successful empty `ls-remote --refs` of the exact official
`plugin-vX.Y.Z` or `hooks-vX.Y.Z` means pending publication. It defers without
native add, failure counter changes or clearing an earlier failed-version
latch. Network errors, stderr and ambiguous/partial output never establish
absence or installation. The SAME verified Git engine uses no credentials or
interactive prompt and keeps the original maintenance signal/deadline. Native
installation, full byte verification and human hook review remain independent.
An already failed candidate requires a genuinely newer release; polling never
resets its latch.

The SAME updater journal has an optional closed `hookComponent` receipt and a
`hook_installing` phase. Persist it before ONE native add. On an interrupted or
lost reply, only matching native inventory/full byte verification releases that
phase; absence/unknown cannot repeat add. A dependency-changing failure cannot
roll back into a legacy combined bundle alongside a newly trusted companion.
Unchanged dependencies are never reinstalled. Native preflight rejects mixed
legacy+companion hooks and requires exact version/source path, full inventory/
executable byte integrity and three genuinely trusted native definitions.
The legacy hook 0.1.0 Git-URL source leaves an optional real root `.git` directory.
It remains readable during migration, never followed as a gitdir file/junction or
symlink. Codex 0.164 also fingerprints its index/reflog: ordinary main Git
operations can invalidate trust even when every hook payload byte is unchanged.
Current hook components therefore use the supported native `git-subdir` source,
exact official repository/ref and fixed `./plugin` path. Their generated transport
tree wraps the complete payload; native installation materializes only that
subdirectory into the SAME exact versioned cache root, with NO `.git`. Refuse
unexpected metadata; never prune cache, exclude fingerprint bytes, change hashes
or transfer trust. All inventory/executable bytes remain mandatory. Native Windows
regression uses main URL refs and a fixed hook subdirectory from the SAME Git
repository, tests hash preservation across main install/update, and still requires
changed-hook/loader hash invalidation without ever approving a hook.

Explicit INITIAL background install prepares this dependency through that SAME
journal/installer even when future automatic updates are opted out. It retains
the original 45-second setup deadline, live paired identity and setup lock,
never restarts Desktop or grants hook trust from setup. A rebind/active pass
fences native install/OS registration. Other setup/status/start operations do
not install dependencies. With automatic maintenance enabled, the ordinary
supervisor performs the subsequent activation; otherwise native user review/
client activation remains explicit, with no false business-readiness receipt.

A native changed/untrusted hook definition yields `hook_review` and the existing
owner notification/messenger route. The human reviews it in Codex; subsequent
ticks detect approval and continue without reinstalling/restarting again.
No approval/hash is written, copied or guessed. Mere native inventory does not
clear the protected hook latch; only the existing successful business boundary
may do that. Healthy current-version cycles perform no Desktop operations.

Persistent activation failure is bounded to three observations. Recovery uses
only the same previously verified tree and official immutable source tag via
native marketplace remove/add/install, with exact read-back, then restores the
main discovery source. Native Codex refuses a direct source-ref switch; the
explicit intermediate journal survives that gap. This does not remove the
plugin identity or edit trust/config by hand. An unavailable/unsafe/disabled
snapshot fails closed. The failed candidate stays latched, preventing infinite
reinstalls/restart loops; a newer release is independently eligible. Rollback
never overrides component minimums/native ACL. Its incident remains visible
through SAME device health until a new candidate is actually verified. Neither
an updater failure nor rollback retries a business/provider operation.

The implementation must pass native Windows manifest/process/CLI tests and a
real dedicated Desktop update before unattended activation is called verified.
Other operating systems leave this Windows policy inactive. Windows login is
still required after reboot; SYSTEM/autologin remain outside this feature. Desktop application updates use
the independent policy below.

### Automatic Codex Desktop updates (Windows)

Official signed Codex Desktop updates are enabled by default for every paired
assistant, including devices connected before Desktop servicing existed. No
separate opt-in, setup rerun or per-device migration is required: an absent
identity-bound private policy reads as enabled, without writing state or changing
an active pass. Only a genuinely absent file uses this default; unreadable,
malformed or foreign state still refuses. An explicit owner opt-out remains off.

The optional `autoUpdateCodex` setup override and host-only
`--auto-update-codex=on|off` remain compatible across both signed entry boundaries.
Omission preserves an explicit override and otherwise uses the default. Plugin
maintenance keeps its independent explicit opt-in; neither policy changes the
other. Setup overrides are recorded after native background registration and do
not update or restart the app during pairing. Status exposes
`pluginMaintenance.codexUpdates` with only enabled/stage/version metadata.

The current signed background tick first completes plugin maintenance, then
uses the SAME coordinator idle lease and setup mutex for Desktop. Active passes,
leased/started/uncertain deliveries, owner intakes and interactive setup defer
all effects. Recheck identity, lifecycle, pass, policy and lease immediately
before each native operation. Pending tasks, permanent chats, Workspace files,
SQLite inbox/schedules, credentials and hook approval have no mutation path here.
A retained unresolved pass is never dismissed to make an update possible.

Every six hours at an eligible boundary, read the installed current-user exact
`OpenAI.Codex_2p2nqsd0c76g0` package and the architecture-specific MSIX URL from
[OpenAI's deployment documentation](https://learn.chatgpt.com/docs/enterprise/windows-deployment).
Use only the fixed `persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix`
or `ChatGPT-arm64.msix`; reject redirects, unexpected encoding, changed ETag,
partial data and packages over 1 GiB. One owner-private complete code artifact
replaces the prior artifact atomically. A matching ETag skips download. The official blob version/identity/architecture
hint may also skip a package no newer than the native installation; it never
authorizes deployment. Desktop servicing alone has a 15-minute context budget
and a five-minute signature/deployment subprocess bound, preserving earlier
cancellation. All other setup, plugin and OS subprocess budgets stay unchanged.
If servicing consumes the original 150-second plugin allowance, the tick exits
before any source poll or task claim. The next ordinary signed worker has a fresh
35-minute request budget; a large update cannot shorten or interrupt a new task.
Network/discovery failure leaves the healthy existing Desktop usable.

The SAME bounded OS-module pipe checks full SHA-256, trusted Authenticode,
manifest name, the registered publisher, architecture and numeric package
version before closing Desktop. Harden XML against DTD/external entities and
hold a read-only/no-write/no-delete artifact handle across validation and
installation. Windows validates the package again through `Add-AppxPackage
-DeferRegistrationWhenPackagesAreInUse`: no force shutdown, unsigned package,
downgrade, elevation, system provisioning, trust/config edit or CLI installer.
This app-update policy never installs or updates a standalone CLI.

The identity-bound private CAS journal persists prepared/closing/installing/
starting/verifying before each effect. Close only ONE observed GUI generation
through the SAME signed Restart Manager helper. A refusal, lost close response
or different process generation never authorizes a second close or a kill.
An unknown installation permits native version observation only, never another
Add-AppxPackage. Resume Desktop through its registered application and observe
its new process; lost activation is observed without another start. After ten
minutes without activation, retain the journal and notify the owner through the
existing runtime-update health reason. A manual native recovery may still finish
that SAME pending verification; no timer resets the install intent.

Check the installed version and fresh hook/MCP/device readiness before marking
updated. Changed hooks/login still require their existing human decisions.
The update itself clears no login/trust/dispatch latch. Failed deployment may
resume the prior healthy Desktop after its fresh probe; its failed version stays
latched and is reported without repeated installation. Only a newer signed
candidate may be attempted. A later exact native version/fresh GUI/probe may
also verify an already deferred registration without another installation. Health metadata cannot clear that retained failure.
Disabling Desktop updates during an unresolved installation preserves its journal and
reports the existing closed incident, without making pending work falsely idle.

The tests cover orchestration, download bounds, policy/CAS and interrupted
installation/activation. Native Windows CI parses the actual helper and executes
its current-user read/refusal boundary. A real dedicated Desktop upgrade remains
a separate acceptance step before claiming unattended activation verified.
The app's own updater, Microsoft Store and device-management updates are
independent; this mechanism never claims control over their scheduling.

The production host reports a structurally confirmed native missing-login error
before the coordinator replaces a post-admission failure with its durable
delivery-uncertain fence. The native/pass/event fences are retained. A new
completed native turn with exact marker read-back may clear only a currently
dominant `codex_auth_required` latch through the existing diagnostic API. A saved
account, catalogue, old completed receipt, failed/uncertain turn or metadata poll
cannot clear it. When another incident currently covers that latch, its own
successful boundary must recover first; native success cannot clear an unrelated
plugin or MCP problem. Hook trust remains independent. Every report re-enters
protected device identity and uses fresh health revision/request UUID. Lost
responses/CAS refusals are never retried and cannot discard a positive business
receipt, advance a failed schedule or replay work. Source tests exercise real
SQLite/native stream fixtures; no Windows business E2E or activation is implied.

This model-free MCP lifecycle is not proof of a registered Windows background
service or businessReady. Source/CI tests do not replace the Windows update and
notification E2E acceptance gate before product activation.


## Task-local domain actions

The current signed worker forwards the dedicated backend's task-local comment,
content/status, checklist, own-control, subtask, direct task-relation and ordinary attachment-delete tools. Names are a closed
transport list; input schemas are live backend data, not host copies. Read-only
annotations remain true only for reads. Native destructive/idempotent hints remain
intact. A backend without these capabilities
continues to expose its old read catalog; this is not a minimum-version bump.
No owner-only/sensitive authority, human command flag or publication token is added.
Whole-checklist deletion still needs the exact persisted owner decision and
current native linked-subtask guards. Ordinary attachment deletion needs its exact persisted owner decision, native ordinary-file/ACL checks and the shared retention/rollback lifecycle; inline blobs remain unavailable. The host transports only the live schema and locators, never file bytes or a human deletion assertion. Direct relations require native access to both tasks; a target UUID does not
expand the current task pass or grant access. New live fields, including accepted
file references on comments and optional owner-question choices, pass through
unchanged. The backend retains source-file ACL, validation, action policy and
receipt authority. The host does not fetch file bytes, select an answer or create
its own domain schema; the owner UI always supplies the free-text Other option.

Encrypted accepted-file publication opens only the native-selected own accepted
Run's signed manifest, through the SAME managed preparation cell and common
TRELIOE1 codec. Original paths remain local; the common human manifest selector
rejects context/worklog files and the assistant additionally excludes its state
directory. Structural Run/ordinal/request IDs select native attachment IDs/URLs.
The SAME local human link composer appends these links BEFORE whole-body field
protection. Names/path/MIME enter only host-owned signed `encryptedContent.commentFiles`; the
native writer retains source/retirement/head/CAS/size/quota/atomic-reference and
receipt authority. A historical accepted Run never borrows a newer projection.
No general file endpoint, plaintext path/digest, human proposal/approval alias,
second blob copy, vault or replay is introduced. Legacy plain forwarding is unchanged.

Independent `create_task` and fresh `get_task_create_meta` use that SAME proxy
and the backend's current schemas. The metadata target is the protected pass's
project; creation needs an exact persisted owner decision, explicit status and
executor/participant sets, plus BOTH actors' native project-create ACL. Ordinary
task-only edit access does not grant project creation. The host neither creates
a second task service nor synthesizes human flags/owner commands or external
sender proof. The new task does not inherit a pass, chat, source route or cycle.
An older backend simply omits these names from its live catalogue.

Each action still uses observed task-pass proof, native task permissions, snapshot
CAS and a durable request UUID. The shared backend transaction commits effects
and receipt together, then releases deferred messenger copies. A lost response
is not retried by the facade, worker or transport. Released readiness advertises
the complete adapter but does not attest a successful Workspace/outcome/service
flow or Windows acceptance.

Company content is checked BEFORE the remote MCP `tools/call`, not only by a
native encrypted-company refusal after HTTP has received it. The SAME managed
profile brackets a fresh native company-mode inventory with exact live pass
checks. Missing/duplicate company, transition, failed inventory or changed pass
never means plain; the mode is neither cached nor inferred from local key state.
Legacy native `null` and explicit `plain` retain the ordinary native validators.
Task mutations, owner requests, cancellation/repair reasons, guidance queries,
Secret metadata/URLs and provider command arguments require this preflight.
Unsupported encrypted content fails locally with
`ASSISTANT_ENCRYPTED_CONTENT_REQUIRED`; it is never sent merely to obtain a
server capability refusal. Already protected Run/material operations retain
their SAME sealed adapters. Structural read/lifecycle calls keep their native
route and independent output hydration. This guard supplies neither mutation
authority nor a plaintext/key/human fallback, and never repeats a failed call.

A successful model-free worker probe also returns a fingerprint of its bounded
public tool catalogue. The long-lived stdio facade compares it with its last
positive tools/list and emits MCP `notifications/tools/list_changed` only on a
change. Codex can reload new runtime/backend capabilities without restarting the
facade. Unchanged or failed probes do not emit repeated notices or erase the
known catalogue; this control message does not wake a model.


<a id="shared-workspace-http-profile"></a>

## Original attachment local-file delivery

The live `download_attachment` definition is exposed only when the signed host
has its trusted local materializer. The remote tool returns a bounded descriptor;
the facade intercepts it before model delivery. Names/schemas remain backend-owned.
No new plugin hook, custom credential store, Run, public URL, base64 or caller path
is added. Old hosts omit the new capability instead of returning a remote plan.

Within the same MCP deadline, production composes the existing device Workspace
profile and rechecks the host identity. The fixed native path
`/scopes/task/:taskId/attachments/:attachmentId?revision=...` is rewritten by the
generated closed route policy. Each read has fresh pass/model proof and server
native attachment ACL/revision checks before bytes. Missing/ended profile refuses
before the human vault; redirects, encoded route tricks and stale source refuse.

The common original reader supports local media, native S3 and shared Workspace
references. The host validates full binary metadata, exact size and SHA-256 before
using `trelio-local-attachments.mjs`: existing 24 MiB bound, private OS permissions,
exclusive file, one-hour lease and cleanup outside Git. MCP receives only its
local-file metadata/path/expiry. Server TextContent/plans are never forwarded as a
second copy. Cancellation/refusal closes the body and partial file publication is
forbidden; there is no automatic replay or public/human fallback. Large native
browser/Workspace downloads retain their independent limits.

Stable encrypted downloads use a closed ciphertext-only native v2 descriptor:
company/task/attachment, selected production data origin, ciphertext size/hash,
revision and the exact native header AAD. No plaintext filename/MIME/hash or
general payload resolver crosses MCP. A download-only profile opens an ALREADY
enrolled managed recipient through the SAME registry/envelope/HPKE engine; it
cannot enroll, select another attachment, call arbitrary routes or use a human
key. Binary GET is proof/recipient bound on the selected data plane. Native
inventory plus the immutable selected range/header distinguish ordinary
`file.task_attachments` and accepted `agent_workspace_browser_file` source IDs;
comment metadata markers do not substitute for sourceFileId. The SAME common
byte decryptor validates digest and full native-selected AAD before decryption,
then repeats live pass/current recipient before the SAME private local-file
publication. Ciphertext overhead has its own finite bound; plaintext stays
24 MiB. Refusal, transition, scope/epoch change and uncertain response have no
plaintext/public/human fallback or automatic replay. This is not live Windows
or provider business E2E evidence.

## Shared Workspace HTTP profile

### Local unsaved-file and draft recovery

The assistant uses the SAME shared bridge preflight and typed
`TRELIO_WORKSPACE_LOCAL_RECOVERY_REQUIRED` / `TRELIO_WORKSPACE_DRAFT_RECOVERY_REQUIRED`
envelopes. A trusted process-only callback may reopen exactly once at the
common `suggestedDirectory`, retaining the original signal, Run and runtime
session. The default human bridge still returns the envelope. Unknown transport,
lease failures and a second recovery refusal never trigger another open.

The managed callback accepts only the exact current Workspace/target Run, the
original owned source directory and the common deterministic `r-<full-SHA256-base64url>`
sibling computed from source/Workspace/Run. Its basename stays 45 characters on
repeated recovery: Git for Windows still has MAX_PATH-limited internal probes
even with `core.longpaths=true`. Existing legacy roots remain discoverable.
After successful native open, the SAME registry replaces only the exact known
same-Run source locator when the new metadata has a greater native fence. All
source bytes remain intact. Unrelated duplicate roots remain ambiguous; neither
file age nor the largest fence chooses a directory.
No model path is admitted. Source files remain untouched; the new root is opened
through ordinary native pass/recipient/ACL/lease/Git checks. Its bounded common
reconciliation evidence is returned locally to the SAME task chat, never to
HTTP, SQLite or a second journal. The agent compares the old delta against the
accepted context, transfers only useful selected changes and saves through a
normal checkpoint/pause/finish. Opening alone is not material or goal completion.
Technical reopening needs no additional owner approval; an actual unresolved
business conflict retains the ordinary question/decision boundaries.

Later actions and automatic heartbeat discover the actual root through the SAME
Run registry codec and private metadata reader, restricted to this assistant,
device, company, task and Workspace namespace. The exact Run wins over a retained
older source; ambiguous copies remain blocked. Restart reuses that same registry,
not a model directory, newest-file heuristic or new recovery database. Discovery
never substitutes for fresh native authority in the isolated worker.

### Exact encrypted task reads

The authenticated native refusal `ASSISTANT_ENCRYPTED_TASK_READ_REQUIRED` carries
only a closed `localRead` descriptor for `get_task`, instruction pages or selected
sections. The SAME current signed MCP worker intercepts it under the original
deadline; no new model tool, continuation, stable shell or restart is needed.
Old workers retain an explicit refusal, never false loaded authority.

The descriptor is matched to the protected assistant/device/company/task/pass.
The common fixed origin allowlist admits the native-selected content origin
only for its exact task POST read path. Key runtime GET stays on the canonical
origin through the existing managed registry protocol; registration, grants,
company mirrors and the general human payload resolver remain closed. Backend
native MVCC/read ACL selects ciphertext refs, with a 4096-ref/32-MiB bound and
fresh recipient-envelope/pass authority before send. No caller payload IDs,
body, keys or proof appear in the descriptor.

The common `ensureCompanyEncryptionContext` opens the SAME managed OS identity
and existing company envelope. Its shared hydrator receives a trusted process-only
resolver callback over that exact bundle: company/scope/epoch/entity AAD must
match and missing/tampered bytes refuse. Core/page projection uses the SAME
schema-v3 reader/result budget; sections use the SAME deferred-section builder.
The live pass is checked again after local hydration. No content is saved in
SQLite, a company mirror or a second cache/vault. Encrypted Run/material outcomes
use the separate profile below; file/source/Secret adapters remain independently gated; this
read subset does not establish `businessReady` or Windows business E2E.

### Encrypted accepted Workspace inspection

Only native `prepare_assistant_workspace_read` / continuation `inspect` may
carry `encryptedInspection`: exact company/Workspace UUID, slug and selected
data-plane origin, checked against the original protected pass. No model
permission flag, write scope, Run/lease, human credential or key is added.
The parent-to-isolated-worker stdin boundary retains the validated
`encryptedInspection` / `encryptedLifecycle` descriptor unchanged; validation
in the parent never permits silently reverting the child to a plain read.
The facade coordinator and process launcher use the SAME closed projection;
automatic heartbeat keeps only that structural native lifecycle descriptor.
The regression traverses the actual facade, coordinator and child pipe together,
including renewal; testing a direct launcher alone does not prove delivery.
The SAME common inspector prepares its own managed company envelope, reads the
native authority snapshot and downloads the pinned immutable encrypted bundle.
Only its two exact GET/HEAD paths may use the alternate origin; managed key
control stays canonical. Traversal, duplicate/extra query, caller recipient,
unreviewed paths, history and writes are refused before private HTTP.

Task and Workspace snapshot readers share the 32-MiB streaming decoder and
4096-ref company/scope/epoch/entity-bound map. The SAME field hydrator, HPKE,
TRELIOE1/chain reader, Git validator and read-only accepted cache reconstruct
materials inside the existing assistant/device/task namespace. Every reuse
still reads fresh native authority and verifies exact head/files. The final
live pass and managed recipient-envelope identity are checked again after
local work, before publishing the directory. No general payload resolver,
second cache/vault or encrypted write/source/Secret/outcome permission follows from inspection alone.
Unsupported old workers refuse rather than report loaded authority; neither
key setup nor this read establishes `businessReady` or Windows business E2E.

The composition fixture runs real Git/container/HPKE/cache inside an isolated
child HOME and requires an explicit end-of-flow sentinel. It removes inherited
`NODE_TEST_CONTEXT`; a nested runner exit 0 alone cannot prove execution.

### Encrypted Run and accepted material completion

The common incremental writer must also read an existing v2 accepted base
manifest on the second and later saves. Only the authenticated native storage
capabilities select that manifest: the protected profile records its exact UUID
in memory, bound to own Run/Workspace/base and current scope/epoch. GET/HEAD uses
the existing file route and own Run header, with no query/body. Native resolves
that exact current accepted manifest independently and rechecks live Run, task,
pass and recipient before streaming. Content files, guessed IDs, stale bases,
other Runs and revoked envelopes never inherit this admission. General company
file reads retain their separate profile. The SAME manifest decryption and
file-ID reuse algorithm runs unchanged; no extra key, cache, endpoint or model
instruction replaces it.

The SAME native lifecycle, shared Git and v2 encrypted upload/chain engines run
under one exact `workspaceRun` profile. Only prepare/open/status/heartbeat,
checkpoint/finish/pause and their reviewed native storage paths are admitted.
Native JSON supplies referenced ciphertext only; current managed recipient and
live pass are checked again before streams and after local work. No human keys,
arbitrary payload resolver/history/Secret route or second executor is added.

The signed worker seals ordinary checkpoint/finish/pause arguments BEFORE the
single remote MCP call. It reuses common HPKE/AAD/P-256 codecs without publishing
a temporary field. Standard AAD binds `assistant.local_<operation>.<passUUID>`,
Run UUID and fencing token; full device/task/Workspace identity is inside the
ciphertext. Native validation uses the SAME writer/envelope/signature boundary.
Only an exact opaque echo in the original scope is opened, process-only, before
the SAME local command. Refusals/lost responses are not replayed.
Draft checkpoints and blocker pauses pass no task outcome to that shared writer:
continuity is not a task decision. A handoff checkpoint or finish reads the exact
native target Workspace under the same own-Run/recipient profile: task targets
supply `no_status_change`, named project/company targets omit `taskOutcome`, even
when their enclosing assistant pass belongs to a task. Model/local scope hints
cannot select this translation. The common handoff validator remains authoritative;
partial files stay durably saveable without changing the task status.
Echo equality uses the SAME crypto canonical JSON: native schema property
reordering is harmless, but extra fields, array order, types, AAD, signatures
and ciphertext bytes remain exact. No re-encryption or mutation replay follows.
Closed local Workspace/Run/lease/hook failure codes survive the MCP wrapper
even when the shared adapter throws ordinary Error+code. Raw messages, stacks,
payloads and unrelated errors remain redacted; projection grants no retry.

Encrypted `complete_assistant_pass` reads a fresh authenticated accepted snapshot
through the SAME inspector/cache and full/delta chain validator. Its own computed
WORK.md must be a regular nonempty UTF-8/no-NUL blob at that exact head, <=64 KiB.
For noChange, the existing optional pass/read material basis selects a structural
previous receipt/head; comparison happens in RAM within the verified ancestry.
An editable local folder, copied file, cached head or model assertion cannot
substitute. No body/path/plaintext digest is sent or persisted.

The host-only material witness binds exact pass, accepted result, continuation,
prior receipt and current recipient/scope/envelope with the SAME observed runtime
key/nonce engine. Its field is removed from model input by the hook and hidden
from discovery. The original runtime session/expiry is preserved. Native final
transaction rechecks envelope, head/accepted material/initiator, retraction and
correction exclusions, latest valid noChange basis and live grant/lease/native
ACL. Plain completion retains its existing accepted-file check. Neither this
composition nor key readiness establishes full encrypted/Windows business E2E.

### Managed encryption identity ownership

The common `ensureCompanyEncryptionContext` chooses a managed profile's internal
identity provider before any human remembered-device file or unlock form. A
profile without that provider, an ended async profile, a foreign origin/company
or a closed native task pass refuses; no human identity import/fallback occurs.
The selected identity uses the SAME P-256, device wrapping and unlock codecs.
Its wrapped record and derived unlock key are one entry of the existing assistant
Keychain/CurrentUser-DPAPI store, with an additional purpose bound to the exact
origin, enrolled device and company. Assistant UUID is checked inside that
protected entry. Existing device/pairing/pass/runtime slot keys stay unchanged.

The common private lock serializes first creation. OS write plus exact read-back
precedes exposing the public fingerprint to registration, so a restart/lost
response reuses the same identity. Corrupt, partial or unavailable state does
not regenerate keys. The random wrapping input never enters a form, model,
environment, argv, file or HTTP request; the company scope private key is not
persisted in this slot. No new vault, crypto implementation or content store
is introduced. This is an identity prerequisite only: exact task reads need the
separate native pass/recipient adapter above; other encrypted routes stay closed. It neither
grants a company envelope nor establishes encrypted/business readiness.

The current signed worker advertises `prepare_assistant_company_encryption` with
only `companyId` and `companySlug`. Like source setup it uses the existing dynamic
catalogue, facade and native invocation; no stable shell/hook definition or Codex
restart is added. Exact input is validated before private context, and metadata
success cannot clear hook-review or ChatGPT-login latches.

The managed setup async profile reuses `ensureCompanyEncryptionContext` and
its native public registration/signature/read-back. Missing company access
returns pending registration; a ready recipient envelope is opened by the SAME
scope-key codec and checked with the SAME local TRELIOE1 round-trip self-test.
The common workflow validates the selected company UUID and managed
subject before key creation. Fresh protected host identity and device company
inventory checks bracket private I/O and every request under one 25-second
budget. Only `/encryption/runtime` GET and `/encryption/devices` POST are rewritten
to the fixed dedicated enrollment routes; no payload/file/Secret/grant path,
alternate origin, arbitrary fingerprint or human credential is admitted.

A lost registration response preserves the OS record; the next explicit attempt
reads that SAME fingerprint before deciding whether native registration is
needed. The setup result projects only public device ID/fingerprint, canonical
settings link and `awaiting_company_key` or `key_verified` (`not_required`
for plain). `key_verified` requires actual key opening and successful container
round-trip, never envelope presence alone. It never contains JWK, ciphertext,
private/unlock material or a decrypted scope, and always returns
`businessReady:false`. The ordinary company owner separately
grants company-key access through the existing control plane; assistant ownership
does not supply that role. Full encrypted task/source execution remains gated
independently of this setup status and the read-only exact-task subset.

| Local setup data | Plain company | Encrypted company |
| --- | --- | --- |
| Device identity / recipient envelope | Existing public registration projection; no key needed | SAME protected OS identity and existing signed recipient envelope; no new vault or server route |
| Opened company scope / self-test | Not created | Process-only SAME key codec; random 64-byte canary in the common owner-private temporary directory, exact cleanup before success; no company text or durable scope-key copy |
| `key_verified` | Not emitted | Public current-check result only; no content, key bytes, task/source permission, health-latch recovery or business-readiness inference |

The internal `allowPendingRegistration` option is restricted to this managed
setup profile; no model/tool argument can select it. Ordinary human/task
callers still require a ready key. All setup phases and final identity/company
read-back share the original 25-second budget. Malformed/foreign envelopes,
wrong scope keys, self-test failure and lost current authority fail closed;
they neither reset the persisted device nor automatically repeat registration.

Assistant Workspace execution is an internal async profile of the common
`trelio-workspace.mjs` HTTP/auth primitives, not another Run/Git/storage engine.
The production wrapper resolves the actual protected host identity, active pass,
device credential and the ordinary observed-hook runtime signing slot under one
native private-process invocation. `requireToken` returns an opaque handle;
only the exact outgoing request resolves the credential. It never probes a human
OAuth/bridge slot, pairs on failure or returns an auth value to model/metadata.

Before each request the profile repeats host/pass binding and live backend lease
checks. It uses the common runtime proof serializer with a fresh nonce and the
operation-specific tool name; ended/expired/missing sessions and changed devices
fail before HTTP. The route/proof algorithm is generated from backend
`digital-assistants/workspace-transport-policy.ts` through
`build-assistant-workspace-policy.mjs --runtime-root`; maintainers never maintain a
second permission map. Its generated section stays in the existing transport
module to preserve the stable loader file budget. Only the canonical origin and reviewed native Workspace
paths are rewritten to the dedicated profile. Traversal/unknown routes, redirects
and caller auth/cookies are rejected or overwritten before sending.

Native Workspace ACL, encryption routing, lease/fencing/CAS, saved snapshots,
validation and commit receipts are unchanged. The backend still checks every
request and rechecks mutation authority on commit. This transport does not
advertise encrypted support or alter the dedicated business readiness gate.

An async profile cannot replace another nested profile. Parallel human calls do
not inherit it. Its lifetime ends when the action settles: surviving child async
resources retain a closed tombstone, never fall back to the human vault. The
production helper is not a model tool; dedicated preparation/continuation and
role-aware pinned workflow must be connected and tested before activation.
There is no automatic retry of a business action or restart of Codex here.


### Dedicated typed Workspace continuation

The live backend catalog supplies `prepare_assistant_workspace_read`,
`prepare_assistant_workspace_run` and
`continue_assistant_workspace_action`; the host adds only reviewed names, never
copies their domain schemas. Only root `taskPass`/`runtimeSessionProof` and their
required entries are omitted from model discovery, including root anyOf/oneOf/allOf
alternatives: the hook injects them into
the raw call and the unchanged backend validator/admission still requires them.

Root projection never walks nested properties, items or shared definitions.
Their similarly named fields remain native business data. Opaque root references
and bounded traversal overflow refuse discovery rather than rewriting a shared
schema; backend wire validation and hook injection remain unchanged.
Live idempotent annotations are preserved, including the non-idempotent local
continuation boundary. The stable MCP facade forwards the real hook proof once,
then executes only the resulting bounded local plan. Company/task/pass/device/
assistant and own Run are rechecked before local files, including status.
Open's runtime session is server-selected and must match the protected journal.
The canonical root is computed under the exact assistant/device/task directory;
model input cannot supply cwd, directory, shell, executable or native checkpoint.

A fresh signed `bridge assistant workspace` worker runs the common typed action
validator and common native Workspace command engine. stdin carries only the
bounded plan; credentials/proofs/keys remain in the existing protected slots.
`chdir` and stdout capture occur only in that isolated one-command child, never
in the long-lived MCP host. Every HTTP call repeats the shared profile proof,
live pass/model/grant/target checks. Shared local metadata validates the exact
Run before non-open actions. Unknown/aborted execution is an outcome-review
condition, never an automatic business retry or human OAuth fallback.

The facade reuses the common finish progress registry and heartbeat manager.
That coordinator is created lazily once for the stdio host, including across
fresh per-call native proxies. Native authorisation/proof is repeated before
every poll; no credential, OS worker or permission snapshot is cached there.
For the strictly validated own-Run lifecycle, the fresh worker reuses the SAME
human bridge private-process session lifetime. The unrelated 45-second setup
timer must not abort a multi-file checkpoint/finish before publication. This
does not introduce a larger hook/proof/Run lease: caller cancellation and any
enclosing hook deadline still win, Windows startup/each private IPC request
keep their existing 20s/10s bounds, HTTP calls keep their own deadlines, and
every request repeats the native pass/own-Run/lease/recipient checks. All setup,
secret, skill and other short contexts retain their previous deadlines. No
model timeout option, background restart, credential cache or save replay is
added. A native completed save remains required for pass completion.
EOF stops that host's heartbeat timers without cancelling a writer or erasing
its files. Tests must cross the actual serial stdio request boundary.
Native pre-handler `429/REQUEST_RATE_LIMITED` becomes the closed
`ASSISTANT_TRANSPORT_RATE_LIMITED` outcome, without an automatic HTTP retry,
new proof/pass, permission recovery or claim of completed work.
One Run has one finish writer; repeated exact requests/polls join that writer,
short-wait cancellation does not cancel saving, and another pass cannot receive
its receipt. Heartbeat workers create fresh protected invocations; they do not
retain the old AsyncLocalStorage auth profile. No automatic claim is attempted
from an old proof; expiry requires exact preparation/open recovery. Finish and
pause stop renewal. The poll route names the dedicated continuation tool.
A facade restart loses its in-memory operation handle, so native exact status,
accepted-head/clean-tree and shared recovery guards must establish the outcome
before a new finish. Files/accepted receipts are not replaced with process exit.
An authorised unknown-handle poll returns a bounded ordinary read-only status
nextCall without the old handle. It starts no reader/writer itself; executing
that nextCall repeats native admission. The closed error guidance requires the
exact server Run read and, for own expiry, exact prepare/open before writes.
It never requests a technical owner approval, infers a live writer/acceptance,
returns another pass's receipt or authorises replaying an uncertain effect.

Protected local AGENTS keeps common security/dirty-state/pinned-rule invariants
and specializes human-only proposal/bootstrap clauses for the trusted assistant
profile. It directs task actions and pass completion to the dedicated policy.
It does not create authority or rewrite the Run pin. The ordinary human template
is byte-identical. An assistant status action omits the human unfiled-queue lookup
before any human session-vault access. No public plugin or file-count limit is
changed; no capability/readiness claim is enabled by this transport alone.

Accepted inspection uses the common `inspect` reader without ensure/start/claim,
lease or writable Run metadata. A confirmed `workspace_not_initialized` response
is initial absence, not a failed/denied read. The dedicated continuation accepts
only workspace UUID, no Run, directory or runtime-session override. The worker
checks its protected identity/pass and fresh native task snapshot before local
materialization; the shared reader repeats actual accepted-head/ACL and bounded
read-conflict handling. Preparation's head is a hint; returned context/index.json
and both full authority/profile files describe the actual materialized revision.

The trusted execution profile computes a private inspection root per assistant,
device, company and task. It cannot overwrite another assistant's personal
profile or the human inspection cache. Missing resolver denies before filesystem
access. This read has no finish registry, Run heartbeat or fake timestamp-only
checkpoint; human default paths and the shared integrity/cache guards are unchanged.


## Private owner dialogue

The fresh company-content preflight compares the authenticated device client's
routing identity with the SAME versioned host-journal identity. The journal's
`schemaVersion:1` is storage metadata absent from `deviceClient.identity`; the
comparison must construct the exact journal shape, never compare the two raw
DTO serializations. Current origin/assistant/device, original pass, lease and
company inventory are still rechecked before staging or sending content. Tests
compose the real device client identity with the production encrypted comment
protector, plus taskless and late-identity/pass refusal paths.

The dedicated live catalog may expose `ask_assistant_owner` and
`get_assistant_owner_question`. The common proxy forwards their current backend
schemas with the same observed task pass/proof, without a human OAuth alias,
new shell hook or model-authored approval assertion. Ask uses a durable request
UUID; the backend owns idempotency, ACL and notification creation. The runtime
never retries an ambiguous question mutation automatically.

The fixed poll client projects an optional validated `ownerQuestionId`; SQLite
stores only that structural reference. A business delivery receives at most one
hundred unique question UUIDs over stdin in its exact task context, including
recovery before native launch. Nothing enters argv or the prompt from question
bodies. The task worker reads each answer live under its current pass and saves
pending IDs in its own accepted WORK.md. Replies resume the permanent chat; they
do not provision another chat or authorize sensitive actions. Missing/newer
backend capabilities remain closed and do not enable business readiness.


### Windows task-path bound

Chat, accepted inspection and writable Workspace folders share one compact task
root. Five concatenated UUID levels can exceed the Windows current-directory
limit before native materialization. The locator hashes the full structural
identity including origin; live pass/Run binding and ordinary private-path ACL
checks still authorize each access. No display name, user path or model input
chooses the directory. Existing device database/credentials remain in place.
A detected prototype writable task root is an explicit storage-review condition,
never silently migrated, ignored or reset. Read-only inspection caches may be
rebuilt under their current exact identity. The actual Windows preflight test
uses the same native chdir and asserts a bounded cwd; no OS registry, long-path
policy, ACL or shell setting is changed.

### Exact owner action client

`request_assistant_action` is a guarded write in the live backend catalog, never
a copied local validator or human-MCP alias. The host strips only managed
pass/proof root fields from discovery and forwards the chosen native business
fields unchanged. The backend remains responsible for sealing target state,
current ACL and one-use decisions. General answers do not grant actions.
The task prompt requires the worker to save the original request UUID/fields and
question in its own accepted WORK.md, finish independent work, then wait. A reply
wake reads that exact persisted question. Only an approved action can be sent to
the original native operation with ownerDecisionId, original UUID/fields and
fresh task context. Denied/expired/changed intent never permits replay or a
human-proposal fallback. No additional source text is put into queue events,
argv or the native chat start context. The permanent chat and cycle are reused.

The same closed live catalog selects update_task_due_date, update_task_assignee,
set_task_participants and update_task_custom_field. Their current backend schema
and action policy remain authoritative; the host never adds an absence
acknowledgement or human-command flag. Older servers that do not advertise them
do not gain a local alias or alternate transport. New provider/admin/destructive
operations stay closed until separately implemented and reviewed.

### Canonical task wake from classified original messages

The live dedicated catalogue may expose `bind_assistant_source_conversation`.
The host forwards its native schema/proof/immutable intent once; the server owns
source owner selection, accepted task binding, ordinary native ACL and CAS. A
mapping is not a provider read, a new task command or a processing receipt. The
fixed model-free source routing endpoint accepts opaque account HMACs only.

The current coordinator classifies each attention-eligible inbound conversation batch into exact
original-UUID task groups, then projects per-original native routes into the SAME
inbox and canonical Trelio task source. Conversation bindings are nonexclusive
correlation history, never a shortcut for assigning a new reply to a task. It never calls scheduler rebind/provision for an
external source. Incoming classified refs wake only their selected permanent task chats;
unclassified conversations remain non-waking. Fresh route/source generations are
checked again before launch and during its watch. Queue `dispatched` and actual
`processed` remain distinct: a successful native/business turn alone does not
mark an external message read, nor does it cause endless immediate wake retries.

Task stdin may carry a bounded `sourceReferences` array with exact source/account,
event/revision, original route/ordinal and expected conversation-key locators.
The worker loads the same published skill and resolves each exact body with that
expected key; incoming text remains data, never instructions or owner proof.
The SAME `skillCommand` observer validates an original queued reference and fresh
native source/route/pass before launch, then inspects complete successful bounded
EOF and repeats those checks before the SAME private SQLite read slot is saved.
No second provider/executor or body journal exists. The explicit source selection
in `complete_assistant_pass` requires actual read evidence and accepted material,
not `noChange`. Its managed manifest proof uses the SAME observed key/v1 nonces
and serializer generated from backend `workspace-transport-policy.ts`. Root
`sourceProcessingProof` is hidden from model discovery and replaced by the hook;
model input never supplies evidence. Selected source UUID/revision, route UUID
and original delivery ordinal (0–99) bind to exact device/task/pass/delivery/
assignment/thread/request/accepted head/Run. No provider ID/body/content digest
enters that server proof operation or outcome.

The completion hook can confirm an already recorded read while the exact active
pass closes a now-done task: it does not fetch a new body or reactivate routing;
the native closing transaction still validates every selected current route and
source under ordinary ACL. A stale/changed generation refuses evidence. The host
reopens only the EXISTING same device inbox with the shared private opener,
never a new authority file or human session. Only an exact native committed
manifest plus positive native turn read-back processes selected original slots;
omitted slots remain pending. Cycle continuation is projected separately into
the existing scheduler and commits in that SAME inbox transaction. Task command
policy still forbids provider ACK. Production original-fenced ACK/read-back,
unknown conversation intake and real Windows E2E retain their independent
proof. Released capability admission is not a Windows acceptance result. See [schema v6](assistant-inbox.md#known-conversation-dispatch-schema-v6).

### Private Secret browser use

An owner-configured private card uses the SAME card/version/keyring/grant/audit
and protected browser-fill engines as an ordinary Secret. Only authorization
and fallback-storage scope differ. No new MCP method, executor, vault, human
OAuth/session import or plugin restart is introduced.

The existing `continue_assistant_workspace_action` accepts native metadata
operations under the observed task pass:

- `secret_list`, `parameters={offset?,limit?}`: the assistant's own value-free
  pool, filtered before paging. This returns metadata directly, not a local plan.
- `secret_browser_prepare`, `parameters={secretId,runId,steps}`: the ordinary
  native browser-step validators and active own task Run. Read the empty form
  first. Copy the returned bridge action unchanged; preparation reads no value
  into MCP and never chooses a human flag or arbitrary executable.
- `secret_create`, `parameters={clientRequestId,expectedTaskUpdatedAt,ownerDecisionId,metadata}`:
  apply only the exact persisted `create_private_secret` owner classification
  requested through `request_assistant_action`. Metadata uses native shared
  name/description/template/field validators. The server shows resolved fields
  and the global private destination before consent, then atomically writes the
  SAME card/audit/decision/operation receipt. A replay returns that receipt;
  an existing card cannot be adopted. This is metadata, not a local command or
  permission to create a website account, generate/store values or import a
  company credential. Copy all original fields and request ID unchanged.
- Returned `secret_browser_fill`: fixed grantId/targetUrl and Run identity. The
  SAME isolated Workspace worker invokes the existing browser-fill command.
- Native `get_agent_skill` advertises private authentication templates only from
  the SAME signed `trelio-secret-setup.json` v2 with `purpose=authenticate`.
  `secret_skill_prepare` returns exact `secret_skill_run` with original native
  grant/Run/company slug/skill/field/env. Legacy v1 and task command prefixes
  cannot authorize this use. Only public/platform-verified packages without
  company Secret bindings are eligible. The SAME `secret exec` reserved
  `trelio-workspace skill run` path reuses signature/cache/account/interpreter
  and process preparation; native resolution is repeated before one late
  consume. The company encryption registry is readable only for the returned
  slug, with exact native assistant identity/company ID checks. Encrypted USE
  of an existing owner-configured card uses that SAME own-Run reader, managed
  OS key/HPKE/config hydrator and consumer. Encrypted prepare sends only public
  commandId/UUID/machine fields; host-owned fingerprint is injected after the
  fresh mode/pass check. Native expands signed public argv and pins immutable
  skill/release/artifact/package hash/command/project in the SAME grant. Resolve
  and consume recheck that recipe/current recipient/pass/Run; legacy NULL recipe
  is plain-only. Model-provided arbitrary argv/extra prose fail BEFORE HTTP.
  The native local plan executes directly and never round-trips its argv through
  another model MCP call. Private auth cannot inherit Workspace writes. Global
  personal values still use their SAME assistant AAD/keyring; encrypted metadata
  task-derived creation and company Secret export/adoption remain closed. One field lives in RAM and the
  child-only environment, never shell/stdin/file/argv. Provider stdout/stderr
  are discarded entirely, not substring-redacted. Its structural
  `command_completed, verificationRequired:true` receipt requires an independent
  native login probe; it does not process a message or finish a business goal.
- `secret_generate`, `parameters={clientRequestId,expectedTaskUpdatedAt,ownerDecisionId,runId}`,
  with the original Run identity: a DIFFERENT sealed `create_private_secret`
  intent includes native metadata, `runId` and password-only `generatedFields`.
  Every required field must be generated (16–128 characters). The owner reviews
  creation WITH generation; an empty-card decision cannot be upgraded.
  The SAME Workspace worker checks the native/current materialized Run, then
  uses host-only `generated-save-context` before accessing generation material.
  Only this exact plan admits `value-from-bridge` for the original NEW card ID.
  The SAME password/fingerprint primitive receives protected device material
  through an internal callback, never the opaque token handle/human OAuth.
  Its domain includes assistant/device/company/task/Run/decision/request/schema.
  No extra master key, vault, credential files or human literal flag exists.
  Card/version/audit/decision/receipt are one native commit; lost-result context
  returns its safe receipt BEFORE generation. Other fingerprints conflict;
  failed/uncertain write is never automatically retried. Receipt projection
  excludes values/fingerprints even if an upstream object adds unexpected keys.
  In an encrypted task the NEW intent must use `metadataMode:neutral`, native
  `cardType:password`, the original `runId` and one password policy. Empty neutral
  cards may instead select opaque/login/password. Native fixes the personal
  name/field labels/schema; arbitrary name, description, URL, task/company marker
  or existing card cannot be exported into the global private realm. The SAME
  managed owner preview/question/intent protects the complete task purpose and
  displays personal server-keyring semantics before exact owner consent. The
  host repeats only `neutralPlan:{cardType:password,generatedFields:[...]}` in
  generation context/write; native revalidates it against that original sealed
  digest and live recipient/pass/Run. Its JSON query is bounded and structural.
  SAME HPKE own-Run reader, protected password/HMAC writer and lost-result receipt
  remain authoritative; no separate policy store, vault, encryption realm or
  human-key fallback is added. Whole private root/parameter/transport envelopes
  and pagination reject ignored prose BEFORE HTTP.

The internal HTTP profile admits only that original grant/Run's existing
preflight, consume/outcome or sealed generation context/write paths. Native one-use proofs, current company
model/ACL/scopes and pass/device/Run locks apply through commit; no extra URL,
body field or other Secret route can forward the device credential. Values
remain in the protected browser/provider process. Its owned fallback profile is isolated
by assistant/device/task; it never opens the ordinary human fallback profile.

Only value-free preflight and exact idempotent outcome reporting retain their
existing bounded retries. In an encrypted task, preparation first normalizes
the full URL locally through that SAME browser target parser. Only canonical
origin/SHA-256 and operational selectors/field keys cross HTTP. The existing
managed publication signature binds that plan and genuine task pass/Run; native
checks current recipient and original grant target. A value-free native target
reader cannot substitute an installed browser ABI or consume proof. Original
path/query is restored only in the private local fill result and the common
browser matches its exact hash again. Unknown root/step fields fail before HTTP.
An uncertain consume/fill is not repeated or switched
to another browser. A successful fill is not task completion or a persisted
processing receipt. Input from a task or website never authorizes disclosure,
new account creation or ownership classification. Existing-card generation/rotation, arbitrary CLI/reveal,
arbitrary encrypted metadata creation, account registration and real Windows business E2E remain
independent authority and acceptance gates; released readiness cannot authorize
these actions or attest their business result.


### Native MAX selected-conversation source

The model-free source reader/known-task processing/ACK flow reuses the SAME
shared account, signed executor, SourceReadObserver and SQLite receipt engine;
see [MAX journal contract](assistant-inbox.md#native-max-through-the-same-source-journal).
Owner-selected `maxChatUrl` is canonical numeric native identity, not a title or
handle, and participates in every source generation/final spawn recheck.
Provider >=2.11.0 is required before account/provider launch. Initial unread
coverage and all subsequent v2 cursor positions remain private device data.

Task/passive/setup profiles never gain ACK permission. A separately native
`max-message-ack/v1` admission carries committed structural slots only. The host
privately derives the exact native refs and the provider selects the latest
verified time inside their covered set. No externally supplied timestamp,
message content, global receipt switch or model-authored owner consent exists.
Unknown attempts retain their original one-use fence and only permit read-back.
Actual owner login/current provider protocol and real Windows business E2E must
be demonstrated separately; codec/fixture success alone is not readiness.


### Taskless verified owner intake and additional account bindings

Taskless source intake reuses the SAME Codex native provision/resume/model/effort,
observed hook/session/proof, MCP transport and signed account/process engine. A
private `kind:source_intake` journal admits context/resolve and the existing
company_context READ catalogue for verified private-owner questions; normal
task/Workspace/Secret tools cannot run under it. Native original-body
confirmation is host-only and not a model tool. Genuine owner linked native IDs,
current incoming/original message flags and source/project/company ACL are
independent of natural command assessment. Clear owner commands need no second
approval; ambiguous context uses the SAME owner questions with Other+text.
See the schema-v9 inbox contract for cancellation, restart and per-event routing.

Simple verified-owner private Telegram questions use the SAME visible source
intake chat and `reply_owner`; they never become tasks/Workspace Runs. A question
about company facts first selects the company read view, searches independent
anchored formulations and reads the selected exact source. A failed, unavailable
or incomplete read is a limitation, never an absence claim. Encrypted snapshot
refusals distinguish fixed JSON, envelope format, payload binding, reference
coverage stages. These codes expose no field values,
identifiers, counts, paths or native exceptions, and never permit a read retry. Source rules remain
context and the answer cites the verified native source in the original chat.
Self-contained greetings/arithmetic need no company search. Clear direct
work commands alone select `create_task`. The native one-attempt receipt, exact
peer/revision/key and signed provider >=2.14.0 fence conversational sending.
No model-selected recipient/account/file/schedule or human transport is accepted.
Native positive settlement is a fixed device endpoint over the original receipt,
not a new business action/approval; current device/source/owner ACL remains live.
An expired intent whose send fence is independently absent may finish only as
native `reply_abandoned`: exact terminal turn UUID, original protected pass and
atomic SQLite no-send fence precede the fixed device request. Unknown/attempted
sends retain verify-only recovery; negative settlement never clears business
health or replays a question. See inbox schema20 for the durable boundary.
See [reply receipts](assistant-inbox.md#verified-owner-intake-schema-v9-reply-receipts-v16).

For signed Telegram >=2.14.0 the model-free poll explicitly opts into native
`account.updateStatus(offline=false)`. Older releases receive no unknown flag.
The provider never forces offline or alters privacy settings; Telegram controls
visibility/expiration. Presence failure does not discard a valid page or repeat
a send, and last-seen is not proof of the poll schedule/processing/ACK.

Owner-selected existing managed accounts can gain an additional company binding
through the SAME native source registration and `prepare_assistant_source_account`.
An immutable origin source/revision supplies SAME device/provider/account evidence;
BOTH owner/assistant memberships and project permissions are rechecked on each
native admission and after package materialization. The SAME account catalogue
atomically commits `bind` with a top-level native intent receipt and revision CAS.
It verifies the origin binding still exists, preserves all account/session bytes
and old bindings, never imports human legacy sessions and never launches a provider
or repeats login. An existing target binding without this exact receipt cannot be
adopted. A lost response may read back only that same intent/current binding.
Receipt metadata never enters account records/provider environment. Public CLI
cannot supply native receipt/origin overrides. These source operations remain
plain-only until their independent encrypted adapter is connected.

Intake uses a presentation-only `x-trelio-assistant-capability-profile:source_intake`
view on the SAME `/mcp/assistant`. It is fixed at session initialization and only
narrows discovery: task view omits intake tools; intake view exposes status and
two native intake tools. A view change fails rather than upgrading that session.
The protected pass discriminator chooses the execution session, never model
arguments. Header alone supplies no native authority; strict original
schema/proof/device/source checks remain in each handler.

Desktop caches a chat catalogue before the first intake. Model discovery
therefore unions its normal presentation profile with exactly the two intake
definitions read from that SAME native source view, even before pass activation.
Execution still selects only the active pass view: advertised task methods cannot
run in a taskless intake, and intake methods cannot run under a task pass. Both
metadata reads share one original deadline and never invoke a business tool.
The same two-name policy also crosses facade/current-worker dispatch; a metadata
listing alone is not a successful executable tool. A real serial stdio regression
exercises context and reply through that worker, managed argument seam and native
MCP transport, with no task call from the intake.
Legacy catalogues with neither intake definition stay legacy; a partial pair
fails. No schemas are copied or inferred.

Both raw native catalogues AND their combined model projection retain the
65,536-byte bound. Only if needed, the projection omits equivalent MCP annotation
defaults and a root draft-07 declaration proven to use the ref-free vocabulary
shared with MCP's default dialect. Unknown keywords, refs/IDs, tuple items and
non-equivalent dialects retain their declarations. Every description, property,
constraint and business value remains intact; actual native validators never
change. If the lossless projection still exceeds the bound, discovery fails.
Effectless terminal owner-intake recovery is described in the inbox schema17
contract: no body read, positive native cancellation and independent terminal
marker, bounded fresh fingerprint, preserved originals and a fresh visible
restricted chat. This never renews/replays an uncertain send.

The current signed request worker reports this catalogue fingerprint even when
maintenance is blocked, so the existing long-lived facade emits its ordinary
`tools/list_changed` notification without clearing a health latch, restarting
Codex or replaying a call. No new endpoint, plugin ABI or executor.

### Encrypted source and exact public task skill

Stable encrypted source discovery/health/known-route/committed ACK uses the SAME
native structural service and BOTH current memberships/project scopes. Monitor
resolve/package carries only the exact source UUID/revision. Encrypted taskless
intake read and owner reply validate the SAME native-selected package URL with
their own source UUID/revision; missing, extra or changed selectors refuse before
download/provider launch. Owner setup and
taskless intake retain their separate content adapters; no inherited permission.

The existing signed resolver/package returns a native-selected connection config
ciphertext bundle for the assistant's active managed recipient/current epoch.
Public platform_verified packages without Secret capabilities/bindings stay
public/plain. Source and task profiles use ONE common field hydrator with injected
exact payload resolution (max 8 payloads/256 KiB native bundle); neither can call
the human general payload resolver. Keys stay in the SAME managed OS slot. A lost
already-prepared slot is refused without creating a replacement identity.

Encrypted get_agent_skill is a closed native descriptor, materialized through the
SAME task pass/proof/runtime resolver/native detail builder and response projector.
Only the current assistant's personal skill rule is selected. Its ciphertext and
config are locally opened before projection. The usual skill_run continuation
and SAME signed loader/process engine require independent native task authority;
private/unverified/secret-backed/setup remain independently gated. Remote MCP declarations use the separate adapter below. The final resolve
rehydrates and compares current config/local identity before a single provider
launch. Config/recipient/release/assignment changes do not cause a retry.

The exported pure `parseAssistantSourceReadReference({skillId, arguments})`
shares the exact SourceReadObserver grammar with encrypted pre-send privacy
admission. It reuses `splitAccountArguments`, accepts only Telegram/email/MAX
`read-reference` with the four exact structural flag/value pairs and optional
one UUID local-account selector, and returns frozen provider/event/revision/
conversation/account coordinates. Unsupported skill/command returns null;
malformed recognized reads fail `ASSISTANT_SOURCE_READ_REQUIRED`. Numeric native
IDs, provider-bound opaque conversation keys and revisions cannot carry query
or message prose. It performs no I/O and grants no account/source/task authority:
the observer still matches the original inbox ref and repeats every native
scope/route/pass check. Other encrypted task argv require their own sealed
content adapter; a signed command prefix alone is not plaintext permission.

The SAME native Codex stdin validator accepts provider-bound Telegram/MAX
chat-message and email UIDVALIDITY/UID references. Mixed prefixes, extra content
or sender/owner claims fail before process launch; source refs never enter argv.
An actual adapter test checks stdin delivery and positive native read-back.

The connected synthetic MAX test uses real managed identity/HPKE/AES fields,
signed monitor and task read-reference subprocesses, SAME SourceReadObserver and
SQLite route/read/selected-processing journal, then native ACK and uncertain
verify-only read-back. Native backend tests independently enforce genuine
observed task proof, exact encrypted personal-rule selection, accepted material
and recipient/source/epoch/assignment denial. A fixture/native processing receipt
is not a live Windows/provider business E2E. Native released capability admission
and post-release live acceptance remain distinct evidence.

### Managed encrypted task/intake content

The current managed company OS identity and SAME P-256/HPKE, rich-text
normalization, payload protector/collision comparison and exact native bundle
hydrator implement owner dialogue, task text and taskless direct-command intake.
There is no second executor/vault, human remembered key, OAuth or human MCP server.

Before private signing the host rejects all incoming model markers and transport
metadata. It stages only its freshly protected native field inventory against the
exact genuine task/intake target using the existing payload routes. A current
managed signature binds tool, target, fields and phase; preparation consumes no
observed tool nonce and has no domain effect. Collisions use SAME selected native
read-back plus local expected plaintext equality. Final tools/call is sent once,
with independent native observed proof, ACL/CAS and owner policy.

Canonical native owner previews are locally hydrated and protected as a complete
question/opaque intent. Original native ciphertext markers stay in the final CAS
snapshot. No plaintext digest/body or new journal is introduced. Current cipher
revision/signature inventory belongs to the existing native version-2 intent
seal; rewriting question/intent invalidates approval. Plain v1 is unchanged.

Native-selected recipient bundles are process-only and never grant a general
resolver. Taskless source context rebuilds full company/project/assistant-profile
authority with the SAME local instruction projector after hydration. Its exact
owner body proof and current linked native identity remain mandatory. A positive
created/waiting-owner terminal response may be read back without pretending its
old lease is still executable. Local choice/Other and UTF-8 checks precede
encryption; an owner answer still grants no sensitive action permission.

Arbitrary private Secret metadata
retain separate encrypted guards. Unsupported arguments
fail before remote tools/call. Ciphertext uses the native-selected approved data
plane; a failure never falls back to canonical HTTP. Real HPKE/signed native and
SQLite fixtures are not a live Windows/provider business E2E or release claim.


### Encrypted typed custom-field values

`update_task_custom_field` reuses the SAME managed device/profile/protector and
native custom-field writer. Before encrypting a value, the existing signed
preparation cell reads only the exact active field's type, revision and structural
option IDs; raw values/names/labels never enter this discovery. The common protector
receives this trusted native type through an internal callback, never a model
hint. Text is protected; canonical date/number/boolean and exact option/member/group
references stay open. Invalid prose in structural slots is refused before HTTP.
The publication binding carries the field revision, and the native handler rechecks
current definition/module/project/task ACL and task CAS under row locks. There is
no second normalizer/executor/config resolver/vault or business retry. Plain
custom-field behavior and the common protector's existing mirror path remain
unchanged; native precision, eligibility and idempotency remain independent.


### Encrypted ordinary skill argument vectors

The public `continue_assistant_workspace_action` predicate selects only
`operation=skill_run`; Workspace lifecycle and private Secret operations retain
their independent adapters. Before remote MCP, the SAME managed protector encrypts
the complete original `parameters.arguments` vector as `skill_arguments_json`.
Native transport receives an empty structural vector plus its canonical opaque
`encryptedArguments` reference and the SAME private preparation/publication binding.
The existing preparation cell repeats genuine task/device/pass/current recipient
and strict native operation validation; it creates no command execution or owner
consent. The ordinary continuation repeats those checks, current public verified
secret-free release/project/runtimeSession admission and returns only the exact
native-selected ciphertext bundle. Old raw encrypted calls get the explicit
`ASSISTANT_ENCRYPTED_SKILL_ARGUMENTS_REQUIRED` refusal, never a fallback.

The SAME local hydrator opens the whole vector and compares it with the original
immutable input before removing its transport marker. Only then does the ordinary
continuation validator/executor run its unchanged signed command policy, account
namespace, source observer and bounded native process. A missing bundle, changed
vector, model marker/transport hint, mixed plaintext vector, revoked recipient or
changed admission fails closed without a child invocation or domain retry. No
second executor/provider grammar/key/vault/endpoint, plaintext digest, SQLite body
or human auth alias is introduced. The original input bounds and provider sending
approval rules remain independent; this content adapter grants no message authority.

### Encrypted interactive source setup

Explicit owner registration/create/bind/configure/login/verify_login is structural
metadata in stable encrypted mode; it grants none of the provider's human input.
The SAME source resolve/package profile binds the exact setup source/revision and
opens only native-selected config ciphertext with the existing managed recipient
and local hydrator. Account creation/bind uses the same immutable catalogue
receipt/CAS and existing sessions. Fixed provider forms/QR/2FA and separate
passive verification keep their original command, OS protection and deadlines;
no human session import, credential copy, unattended login or new executor exists.

Before final native delivery the origin of an additional-company binding is read
again independently of its target. Pause/revoke/membership or envelope loss stays
a refusal; it does not switch company/account or retry an uncertain setup. Empty
creation, saved configuration and window close still prove no provider login,
owner sender identity, polling, body processing or ACK. A separate passive native
verification remains required and cannot open a form or gain its longer budget.

### Encrypted comment mentions

Before sealing create_comment/update_comment body_json, the host reads only the
current exact task audience through the existing managed preparation cell. It
uses the SAME exported human rich-text canonicalizer, then selects only eligible
member/group IDs from the resulting document. Group membership stays native;
unknown nodes refuse before body staging. The complete encrypted body remains
in the SAME payload codec and signed argument target.

Hidden commentMentions is private host metadata signed with preparation/publication,
not a model-selected recipient override. Native current task ACL and common
comment/notification resolver repeat selection; SAME operation intent includes
the structural set. Edits compare canonical previous mention rows, avoiding
repeated notifications for retained mentions. Removal/re-addition behaves like
ordinary comments. New hosts always send the set (including empty arrays); legacy
missing metadata grants no selected-ID notification authority. No plaintext body,
new company directory, group membership cache or notification executor is added.

### Encrypted own-Run cancellation

The SAME generic managed protector builds the existing audit payload type
agent_workspace.cancellation with cancellation_reason. Human audit upload reuses
that same payload/signature builder; the assistant never calls human OAuth, the
human cancellation retry loop or local cleanup. Only nativeTool=cancel_agent_workspace_run
selects this fixed type. The existing opaque HMAC ID derivation binds the
immutable staging intent to its exact Run without a plaintext reason digest or
local journal. On a collision, SAME selected-cipher read-back and local expected
value comparison confirm only the original intent; another reason fails before
the business call. No domain mutation is automatically retried.

The native preparation and final MCP tool independently repeat the genuine
task/pass/device, own initiator, Run state, current recipient and signature.
Shared mutation authority repeats scope/model/target checks before native commit.
The common cancellation service owns fencing, status and exact same-marker
read-back; accepted history, files, goal and cycle remain intact. Successful
ciphertext staging alone is never a cancellation receipt.


### Signed human-input setup declaration

The SAME signed `trelio-secret-setup.json` v2 optionally declares
`humanInputCommands` with strict `{id, purpose:"authenticate_existing",
arguments, maximumDurationMs?}`. These existing-account authentication commands
contain no Secret/env/value/registration fields. They require `local-session`
and host >=3.18.0; Secret commands still require `secret-checkout`. Empty
`commands` is allowed only for a nonempty v2 human-input declaration. Both lists
share unique IDs and exact argv; no wildcard, prefix or model slot is accepted.
An optional integer duration is 60,000–600,000 ms and cannot extend the original
native deadline. The reader selects signed argv by commandId only. An ordinary
task prefix cannot execute any declared human-input argv. Native exact owner,
account, device, artifact, human-input grant and the common process/catalogue
remain separate requirements; parsing a declaration never authorizes a launch.
Native `shared_runtime_setup` describes an available setup/consent path, not
proof that the selected account requires login. The stdio facade selects the
SAME small setup presentation only for an explicit `connection` section read
with account setup, or independent pending native runtime consent. Ordinary
`instructions`/`execution` reads select task presentation even when the skill
declares login, retaining `skill_run`, task context and Workspace lifecycle.
The existing list-change notification restores a previous setup view without
a new chat or replaying a call. The fresh worker projects the same existing
execution state for plain and hydrated encrypted results before forwarding;
already loaded older facades therefore also retain task presentation without
a Desktop restart. Native descriptors, consent and all command guards remain
unchanged. Owner request/read-back and the returned
`skill_account_setup` effect then use the advertised small setup view;
`get_assistant_status` returns ordinary task tools. This changes presentation
only: device consent, exact account-login approval, pass/proof, single-attempt
receipt and actual login verification remain independent.

### Company Secret use

Existing `secret_list` with `parameters.holder="company"` reads the SAME exact
active task + parent scopes and native permissions. Plain metadata is unchanged;
encrypted metadata is a native-selected managed snapshot, hydrated in process
with the SAME recipient/field codec. The ordinary private list is unchanged.
No values, general payload resolver, new cache or extra grant are exposed.

Existing browser and signed v2 authenticate continuations can USE a company
card without changing its holder. Native current assistant membership, Secret
checkout ACL, current task Run, pass/device/model policy and one-use consumption
all remain independent. Company audit retains its original company/member actor;
private cards retain their original global assistant actor. Owner consent never
widens company Secret rights. `use_granted_secret` keeps its current ordinary
policy; create/reveal/export or unrelated sensitive work is not authorized.

A company signed recipe additionally pins the current connection, binding key,
original stored config/ciphertext-reference SHA and public artifact coordinates
in the SAME immutable grant. The native signed declaration selects its Secret,
field and child-only environment. Config redirects, rebinding, rotation, scope
loss and revocation stop the old grant before consume; no automatic retry or
new executor is added. The common Secret consumer selects keyring versus E2EE
ciphertext; the SAME local decoder opens only granted fields and discards all
provider output. The native encrypted secret-backed company connection setup
still has its own closed owner/config capability; this use adapter alone does
not enable or declassify that setup flow.
### Managed Remote MCP profile

The genuine assistant reuses `trelio-remote-mcp.mjs` declaration resolution,
credential form, S256/OAuth callback, refresh vault, doctor, policy/tool/schema
selection, HTTP/session and call implementation. There is no second provider,
HTTP executor, vault, human session import or automatic login. PAT/OAuth input
and provider consent remain an explicit human action in the existing protected
local UI. macOS/libsecret vault accounts as well as PAT/DPAPI paths include the
managed assistant/device namespace; identical company/member/skill identities
cannot read a human or another device's stored session.

The SAME `/api/agent-skills/remote-mcp/resolve` accepts only the current genuine
device/task pass, native skill/project/member/release access and fresh observed
proof. Human 12-hour admission caching is disabled. Encrypted declarations and
private titles are native-selected field markers (`remote_mcp_config_json`,
`title`) plus at most eight exact payloads/256 KiB for the current managed
recipient/envelope/epoch. The shared skill hydrator opens only these bytes and
native-selected guidance; no general company payload resolver is enabled.
Native send and local delivery recheck current assignment/recipient/release.
Public/unverified executable admission, company connections and Secret grants
remain independent; this adapter cannot bypass their gates.

A native `get_agent_skill` Remote MCP result changes only presentation to the
existing session-fixed `remote_mcp` capability view. It exposes the SAME live
connect/doctor/call schemas, task core and owner question/action tools. The
existing stdio `notifications/tools/list_changed` refreshes discovery; no plugin
restart or new authority/session is manufactured. `get_assistant_status` returns
the ordinary task view. Wrong/dropped/swapped headers and hidden methods fail;
both complete native inventories and model projections keep the 65,536-byte
bound. The `skill_setup` presentation seam follows the same narrowing for native
setup/consent; missing native operations are not advertised. Input/output/HTTP
bounds remain unchanged and schemas are never copied into the host.

Reads retain exact allowed tools and live provider read-only annotations.
A write uses `request_assistant_action` for `call_remote_agent_skill_tool` with
FULL arguments and native declaration snapshot. Owner free text is not approval.
After fresh declaration AND provider-tool checks the common call engine spends
the exact sealed native decision immediately before its sole external request.
The committed structural receipt means `attemptAdmitted`, `providerOutcome:
not_observed`, `replayAllowed:false`; it never claims delivery or business success.
Lost consume responses, provider errors or unknown results do not replay consume
or `tools/call`. `get_assistant_owner_question` can read the applied receipt;
provider read-back/reconciliation requires a separately allowed read. Full
arguments remain in company-protected intent/`remote_arguments_json`, never in
SQLite, generic metadata, logs, argv or environment. Planning/final admission use
the same immutable marker derived from the original clientRequestId.


### NEW company Secret host continuation

The same protected Secret profile admits `secret_company_create` only from an
original `create_company_secret` owner decision: neutral card type, exact active
task Run and `empty|generated|protected_input` source. Native context selects the
ordinary task-scoped corporate card and audience. Model values/paths/credentials
are absent; native derived card ID is selected from that exact response before
PUT. SAME managed device key/password engine, company Secret metadata/value
codec and atomic native writer serve both plain and E2EE companies. Human
permission flags emitted by legacy generic composers are discarded, never used
as assistant authority. Company card values are not moved into the personal pool.

Protected input uses the shared local form with a native one-shot `begin` in the
existing operation ledger before showing it. It reads the original pending
attempt again after human delay, then submits once. Unknown begin/save performs
one exact structural receipt read-back; it never retries HTTP writes, reopens a
form or collects replacement bytes. A committed receipt returns before key/input;
pending is an explicit unresolved attempt, not readiness or success. Only native
card/version/ACL/audit/decision/receipt atomic commit confirms storage. No extra
runtime module, vault, executor, clipboard/file import or source body journal.

### Owner-reviewed managed local-account authentication

`setup_skill_account` is the SAME sealed owner action for an existing-account
login/configuration, not website signup. The owner selects exact native
skill/release/device/account and signed `authenticate_existing` command ID.
The native admission receipt names the current artifact, original stored config
hash, member/company binding and a bounded human-input budget. It consumes
permission once; a lost result is reconcile-only and never reopens a form.

The host obtains the recipe through the SAME signature/manifest inspector.
Encrypted private recipe JSON stays inside the existing managed payload and
owner seal; the final host reselects it by the exact package hash and command ID.
No model argv, Secret/env overrides, provider profile paths or legacy imports
are accepted. Native/model discovery exposes command IDs only. Request
`get_agent_skill` sections `instructions`, `execution`, `connection` to enter the
existing setup presentation; an ordinary skill read keeps the task view.

The SAME managed catalogue either atomically creates the neutral empty account
for that intent or selects an already-bound account of this assistant/device
and company/member. It never adopts a human/unbound other-company entry,
rewrites labels, binds implicitly or creates a duplicate during relogin.
The SAME signed process then opens the protected existing-account handoff;
its original monotonic budget is capped by the first observed native lease,
including inspection/account/bootstrap time. No terminal stdin/value delivery
or unattended login is introduced. Complete provider stdout/stderr remains
private. Handoff exit/window close returns only `loginVerified:false`; a
separate fresh native provider probe is required before claiming a usable login.

### NEW private protected input

An explicit neutral `create_private_secret` source `protected_input` binds its
card enum and original own Run to the SAME persisted native owner action.
`secret_input` uses the existing company/private NEW producer implementation,
shared protected form/loopback and structural begin/save/GET receipt protocol.
The native private writer retains assistant AAD/keyring and NULL company columns;
task purpose/question stay company-sealed and require the current recipient.
Legacy empty/generation approvals never gain capture authority. Unknown/pending,
cancel or form opening cannot mean saved or reopen input under that old intent.
No model value, browser/file/session extraction, new vault or runtime module.

### Owner-reviewed NEW external signup

A signup is separate from existing-account human-input login and from Secret creation/use. Request `create_external_account` with exact HTTPS `siteOrigin`, `purpose`, `intendedHolder:assistant|company` and bounded full `signupPlan`. The SAME owner question/decision reviews the whole plan. After approval, native `external_account_admit` continuation consumes it once and commits a structural receipt BEFORE site effects; a lost/replayed response only returns `mayExecute:false` with the same receipt. It never starts a site or proves account success.

Use only an existing permitted browser/provider route on the approved origin. Missing registration capability is a concrete blocker, not permission to extend an `authenticate_existing` recipe, bypass service terms/human login/public publication controls or spend money. Separate Secret ownership/create/use/capture authority supplies protected values without model exposure. Verify fresh site/provider state and save useful accepted task evidence before reporting success. Unknown outcomes stay unresolved; no automatic signup replay.

In encrypted companies all origin/purpose/plan leaves use the SAME managed field protector, native preparation/current-recipient/signatures and process-only hydration. Planning and admission derive the SAME stable field coordinates from the original request UUID; no plaintext origin/plan/body or second vault/executor is introduced.


### First outgoing reply routing

Explicit provider `send --conversation-reference` retains the immutable argv and
ordinary sending authority. New TG/email/MAX provider versions return an opaque
`conversationReference` from the SAME native monitor account/thread scope. The
common `skillCommand` captures exactly one signed process, then invokes the task
profile's optional outgoing observer. No provider stdout/body/key is persisted
by this observer, copied to a log or sent to generic metadata endpoints.

The observer only returns `assistantSourceConversation` for a positive immediate
send: `state=ready`, original provider `conversationKey`, native candidates
`[{sourceId,sourceRevision}]`, `automaticRetryAllowed=false`. Native source reads
are restricted to the current company/device and the account already selected
by the common catalogue. Project source must match the resolver project; MAX
requires the registered canonical `--chat` for an exact-chat source, or native
account-root discovery admission for an account-wide source. Source state/revision,
account/project and original pass/thread/assignment are rechecked after capture.
No key is computed by the model or host, and no whole source inventory is shown.

The worker uses the existing `bind_assistant_source_conversation` with one exact
native candidate, the provider key, fresh task snapshot and stable request UUID.
This optional nonexclusive correlation still needs task/source/ACL/CAS/proof.
Each later inbound batch needs independent per-original classification before the
existing route/inbox/coordinator may wake its selected permanent task chat; a hint is no route receipt, owner identity, new-task
command, original-body read, processing proof or ACK authority.

Optional hint, source outage/revocation, malformed key, missing selected source
or changed pass produces only `state=unavailable`; an already positive send is
preserved without any send replay, login or alternate transport. Preview,
scheduled, partial or unknown sends do not claim ready routing. Existing output
bounds remain unchanged; absence of a hint is unavailable. Email uses incoming
INBOX UIDVALIDITY plus its generated Message-ID through the existing thread
parser, never Sent UID/folder; SMTP-only cannot establish this incoming route.
Missing reply thread headers or a changed namespace remain explicit limits.

Native bind/route guards are exercised by backend PostgreSQL tests; runtime
fixtures separately exercise actual signed child/account/capture and the
first-send → bind fixture → incoming reply → same-thread coordinator sequence.
They do not assert a live provider exchange or Windows business acceptance.

### Scoped encrypted creation metadata and published guidance

The SAME exact task POST snapshot also selects one closed context read: project
creation metadata, company/current-project guidance, or one published procedure.
Native task/device/pass/proof, stable mode, current recipient and ordinary
project CREATE/dependency ACL remain independent. It is not a company mirror or
general payload resolver. Original queries/hints never cross MCP/HTTP: the host
sends a fixed platform placeholder, keeps the original only in the invocation,
verifies the native scope descriptor and restores the leaves for the SAME local
ranking/hydration code. Native procedure IDs and scope cannot be substituted.
Creation metadata reuses the native human projection and SAME scoped authority
builder. No new journal, content field, cache, index, outbox or crypto engine.


### Company-private recipe and company Secret intersection

A current company-unverified runtime may use an existing configured company
Secret binding only with BOTH independent native executable device consent and
the ordinary card ACL/own active Run/one-use grant. It remains unverified code.
The public verified predicate and the shared human settings writer are unchanged.
New opaque private connection setup is unavailable in that common writer, so
this adapter covers valid configured/migrated connections without inventing an
editor or plaintext fallback.

For encrypted private artifacts, the SAME bounded signature/TRELIOE1/manifest
inspector selects one signed v2 authenticate command. The existing managed
protector seals the whole recipe into `skill_setup_command_json`; its P256
preparation/publication includes the exact structural descriptor. The native
grant retains only versioned ciphertext inventory/reference and current
fingerprint. Only after that exact native response may the host restore its
locally inspected argv. The SAME account/package/process/secret-exec engine
checks it again and consumes one native grant late; provider output is discarded.
Changed recipe, consent, recipient, connection/binding/config, ACL or Run refuses
before consume. Inspection is never login or business-processing evidence.

<a id="codex-usage-monitoring"></a>

## Codex usage monitoring

The existing signed background tick calls fixed native `account/read` and
`account/rateLimits/read` through the SAME bounded App Server adapter, before
model work. API-key/Bedrock report unsupported; unavailable data is not zero.
The pure projection prefers `rateLimitsByLimitId`, falls back to `rateLimits`,
and retains every returned primary/secondary duration/reset/percentage. Either
slot can be the 300-minute or 10080-minute window. Never export account/email,
plan/limit labels, balances, reset credits, upsells or native errors.

The SAME device client owns fixed GET/POST `/runtime/codex-usage`, strict snapshot
validation and independent revision/request UUID. No MCP/model tool, secret,
owner click, plugin/hook change or business pass is needed. Backend precedes
this runtime in rollout. A failed POST is not retried; later polling first reads
native state and the durable CAS. A native read failure preserves the previous
observation, especially its confirmed block. An unavailable device read cannot
guess that an old block disappeared. No local quota file or credential is added.

Backend owns default-on per-assistant below-10 preferences, once-per-window
receipts, mandatory block/recovery notices, owner ACL and messenger late guards.
An ordinary quota bucket alone can pause the whole device; another model bucket
must not block otherwise available models. Included usage denial plus explicit
absence of credits confirms a pause; available paid credits are considered.
Native spend-control/workspace-credit denials take priority. Percent/reset clocks
never prove a block or recovery. Unknown/unsupported readings do not clear a
confirmed pause, or any independent login/hook/dispatch latch.

During a confirmed pause the tick continues model-free source polling, preserves
all queue/pass/native-start/unknown-operation receipts and skips model work.
After a fresh positive observation the ordinary coordinator resumes; this is
never permission to replay an uncertain external action. Observation happens
on the existing five-minute supervisor cycle and never wakes a model for itself.

## Read state and visible chat names

The exact source-intake body materialization boundary enables native read ACK
independently of a reply, task or Workspace Run; see inbox schema v18. Reference
polling is not a read. Business processing still requires its selected original
slots and material outcome. The host keeps unknown provider attempts verify-only.

After the second GUI READY, the SAME public App Server `thread/name/set` assigns
a human-facing initial name to that exact new chat: «Работа по задаче Trelio»,
«Переписка с владельцем» or «Разбор входящих сообщений». The internal bootstrap
marker remains solely a delivery locator, not the user-facing title. This
cosmetic RPC adds no model turn, second chat or queue replay; a naming failure
cannot invalidate positive execution evidence. Existing human-renamed chats are
not overwritten on continuation.


<a id="readonly-owner-question-recovery"></a>
### One post-fix reply-only owner-question recovery

The owning native source engine may restore one private owner question only
from the SAME immutable `reply_abandoned` receipt, expired old lease, absent
local provider-attempt/message fences and a complete exact terminal native turn.
Its bounded full-history reader accepts only own context plus unchanged company
search preparation ending in the structured hard timeout, optionally followed
by a positively refused `reply_owner`. A native `read` label or prose is not
proof: the sole shell exception is the exact literal public assistant bootstrap
SKILL read through a system PowerShell executable or a freshly verified
Microsoft-signed PowerShell file. Portable/WinGet paths are never guessed: only
the fixed profile-free system reader inspects Authenticode and product identity,
with the candidate path on private stdin, a 5-second bound and closed output.
The candidate is never executed by recovery. Native waiting/reasoning is inert;
an arbitrary shell, extra command or non-public target still refuses before
inspection. Other tools/actions, unknown
items, an uncertified later or duplicate turn, missing full coverage, a result without the exact
structured code, or an attempted/unknown provider send remain closed. No history,
query/body/native command or content hash is persisted or sent to the backend.

Permanent owner chats may already contain later independent commands. The host
may skip at most eight of them only when the SAME journal records each as a
settled `created` original with matching account/owner/source/revision/conversation,
no send/abandon/recovery fence and a different original event. It fetches each
exact native intake afresh: `created`, confirmed private-owner read, a real task
UUID and the SAME immutable local receipt are mandatory. The historical local
`created` task cell may be null; it never substitutes for the native task UUID.
Inventory includes unknown/unsettled rows; a ninth row refuses, not truncates.

The full native history must then match every selected later delivery exactly
once before the original failure. Each completed error-free turn permits only
one context read, optionally one project-selected context read, then one
successful `resolve_assistant_intake(create_task)` whose structured receipt
matches that fresh native original/source/thread/task/receipt. Context prose is
not inspected or treated as authority; its native content-only result is valid.
An arbitrary shell/provider/tool, attempted reply, missing/failed call, extra
user/resolve, unmatched receipt, unknown intervening turn or duplicate marker/turn
still refuses. Every bounded full-history page remains mandatory, even when the
original is on a later page. These minimal structural proofs are ephemeral host
options, not model tools, journal authority, new backend protocol or Task/Run
permission for the recovered question. Later tasks are never repeated or changed.

Only a changed trusted native/runtime prerequisite and native protocol version1
permit a new child. Schema23 adds nullable structural witness/prerequisite cells
without rewriting an original. The old terminal receipt/start bits/model-read and
ACK basis stay intact. The existing total owner chain bound remains20; unique
parent binding permits just ONE post-fix reply-only child, not another recovery
chain or a reset of the old preparation's 600s+one600s budgets. This child is a
new ordinary native lease under the same original event/source/owner/account/
conversation/thread. Native SQL (deployed first) permits only a reply, no task,
route, dialogue, ignore, Workspace or Run. Runtime never changes model or effort.

SQLite saves the new begin-attempt fence BEFORE HTTP. An unknown response allows
only exact child read-back, never another POST or child ID. Native positive
admission is still unread; the normal signed exact-original reader, current
company ACL/authority, fresh hook proof and provider one-send/receipt engine
remain mandatory. A missing capability or uncertain witness cannot manufacture
progress, ACK, delivery or recovered business health.
The recovery invocation receives a narrow reply-only instruction while keeping
the original intake marker/JSON ABI; source text never supplies this authority.

Every NEW source invocation samples one observation budget from its original
native lease, bounded by30 minutes, with an independent nonrenewing timer. This
fixes a15-minute observer that expired before the unchanged600s+one600s search
preparation; polling does not renew a lease, restart old work or change the
preparation deadline. Old failed attempts keep their original deadlines.


The same pure terminal-history classifier can recognize a host-selected positive
technical reply after the exact structured company-read rate refusal. It requires
a completed error-free turn, unchanged preparing-only searches, no source reads
or other effects, and one completed reply_owner whose structured REPLIED receipt,
source/event/thread and private confirmed read match the fresh native witness.
Arbitrary prose, ready search, missing receipt, pending/unknown send and another
tool never qualify. This classification is distinct from absent-provider timeout
abandonment and conveys no permission to reopen an intake or send again. Only a
separate current native correction protocol may admit a bounded corrective child.
