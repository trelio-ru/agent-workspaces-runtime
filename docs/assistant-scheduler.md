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

### Native invocation

The official [CLI reference](https://learn.chatgpt.com/docs/developer-commands)
documents `codex queue` and `codex exec resume`; the
[App Server](https://learn.chatgpt.com/docs/app-server) documents exact thread
metadata and paginated turn reads. An isolated local macOS probe confirmed that
queue acceptance alone did not start the sleeping fixture. `exec resume` on that
same permanent ID did start and complete a native turn. The actual adapter then
passed a marker-based positive read-back on that host. This does not establish
Windows readiness, GUI availability, provider access or a running cyclic daemon.

`trelio-assistant-codex.mjs` resumes the exact UUID/cwd, using existing local Codex
authentication. The owner-selected company model/effort is passed explicitly
for both create and resume. It never copies human OAuth, overrides sandbox/
approval/rules, automates hook trust or selects another thread.
Only the structural delivery marker and platform instruction go through stdin;
no prompt/content/credential is placed in argv. Stderr and raw JSON diagnostics
are suppressed; native content is parsed in bounded memory, never cached/logged.

The host passes a one-use synchronous `startInvocation` callback that performs the
inbox's leased -> started CAS. Missing history cannot authorize a second attempt.
After CLI exit, the adapter must find exactly one matching native user-message
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

Both new READY provisioning and exact `exec resume` receive explicit `--model`
and TOML-quoted `model_reasoning_effort` flags. No sandbox, approval, trust,
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
journaled on `thread.started`, then verified by native completed-turn read-back.
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

The current signed request worker exposes `prepare_assistant_source_account`
through the existing dynamic catalogue, not a new stable-plugin setup method.
`companyId` plus `sourceId:null` discovers only scoped owner-configured structural
refs. An exact `sourceId` can prepare a new EMPTY local account only when the
server's persisted owner intent has `provisionLocalAccount=true`. Existing-account
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
`connectionVerified:false` cross the private result boundary. Provider errors,
mailbox address, paths, field values and diagnostics stay out of MCP/logs/SQLite.
A closed window is not successful configuration, and saved credentials are not
network readiness, sending authority, processed messages or a passed Windows
business pilot. Setup metadata does not clear hook/login health latches.

For IMAP configuration the saved result supplies a separate exact
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

The sole provider syntax is `login --account <native UUID> --qr`. It opens the
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

External references stay unrouted/non-waking/unacknowledged. Unknown conversations
are never assigned to a convenient task/company, and sender metadata is not a
direct-owner command. MAX selector onboarding, Telegram channel/deletion streams,
owner-visible source recovery, exact content reads/mapping, committed processing
and native ACK remain required before full product readiness. A failed/gapped
source retains its position and cannot manufacture a successful empty page.

## Protected background host composition

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
end-to-end gate remains mandatory. Until the complete backend is enabled, source
polling may work while native business execution refuses readiness.

`bridge assistant background` is an explicit host-only entry. Its stable
supervisor invokes current signed workers through the existing loader, never
scans plugin caches or restarts the Codex app. Between cycles it runs normal
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
onboarding remain separate release gates. No existing pilot machine or user
configuration is changed by these source changes. Automatic restart of Codex
remains backlog-only.

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

The deterministic task belongs to the current Windows SID with least privilege
and `InteractiveToken`. A single logon trigger waits 15 seconds; unlimited task
duration, IgnoreNew, battery continuation and three one-minute crash restarts
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
the read proxy below obtains live backend schemas. Input frames are bounded
at 128 KiB; unknown tools/fields and raw failures cannot expose the private journal.

An already completed pairing is read back privately and checked by live heartbeat;
retrying the setup tool never repeats the one-use exchange. An uncertain exchange
survives restart as recovery_required. Setup output distinguishes paired/contact
from business readiness. Task-pass admission and the installed background service
remain required; the local setup profile never claims business readiness from
registration/contact. The assistant hook composes the ordinary observer, proof serializer, state lock
and invocation-private deadline. Without a live exact pass it denies task calls
with a closed reason and JSON-deny/exit-0, including malformed input on Windows shells.

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

### Shared task-skill execution

`get_agent_skill` may return the existing `skill_run` action through
`continue_assistant_workspace_action`. Its parameters/release come from the
native reader and strict backend branch validator, not a host schema copy.
No second executor, package loader, HTTP endpoint or account vault is created.
The existing isolated action worker calls `runWorkspaceCommand` under the same
assistant Workspace HTTP profile. Only native `runtime/resolve` and
`runtime/package` gain this task profile: fixed origin/company, genuine device
grant, exact pass/project, observed model/effort and fresh operation proof.
Setup/consent/Remote MCP/secret endpoints never fall through to human OAuth.

The common engine verifies/materializes the signed artifact, selects the
account and starts the normal Node/Python provider. Human admission caching is
disabled for this profile; live resolve runs again immediately before launch
and must retain the artifact/hash. A cached package never preserves revoked
task/device/policy authority. Only public, verified, non-revoked, plain and
secret-free runtimes/configurations are currently admitted. Protected setup,
owner account onboarding, Remote MCP and encrypted execution remain independent
readiness gaps; this increment does not change `businessReady=false`.

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
Windows business pass/outcome; `businessReady=false` remains until those stages.

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

Backend account notifications deduplicate incidents, copy to linked messengers
with ordinary FIFO/retry rules, and send one recovery notice. The server detects
missing health reports after 15 minutes even if Codex/host is gone. Unknown
absence has no invented plugin/network diagnosis. Runtime update failures have
a five-minute recovery window; owner-action errors are immediate. First mode
requires the owner for plugin updates, restarting Codex, hook approval and login.
Automatic external-supervisor restart of Codex is backlog, not implemented.

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

Each action still uses observed task-pass proof, native task permissions, snapshot
CAS and a durable request UUID. The shared backend transaction commits effects
and receipt together, then releases deferred messenger copies. A lost response
is not retried by the facade, worker or transport. These actions do not enable
businessReady until Workspace/outcome/service and Windows acceptance are wired.

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
browser/Workspace downloads retain their independent limits. Encrypted assistant
execution stays closed until its independent device data plane is implemented.

## Shared Workspace HTTP profile

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
One Run has one finish writer; repeated exact requests/polls join that writer,
short-wait cancellation does not cancel saving, and another pass cannot receive
its receipt. Heartbeat workers create fresh protected invocations; they do not
retain the old AsyncLocalStorage auth profile. No automatic claim is attempted
from an old proof; expiry requires exact preparation/open recovery. Finish and
pause stop renewal. The poll route names the dedicated continuation tool.
A facade restart loses its in-memory operation handle, so native exact status,
accepted-head/clean-tree and shared recovery guards must establish the outcome
before a new finish. Files/accepted receipts are not replaced with process exit.

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

### Canonical task wake from a known source conversation

The live dedicated catalogue may expose `bind_assistant_source_conversation`.
The host forwards its native schema/proof/immutable intent once; the server owns
source owner selection, accepted task binding, ordinary native ACL and CAS. A
mapping is not a provider read, a new task command or a processing receipt. The
fixed model-free source routing endpoint accepts opaque account HMACs only.

The current coordinator projects those native routes into the SAME inbox and
canonical Trelio task source. It never calls scheduler rebind/provision for an
external source. Incoming mapped refs wake the existing permanent task chat;
unknown conversations remain non-waking. Fresh route/source generations are
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
unknown conversation intake and real Windows E2E remain required before
activation. These changes do not enable `businessReady` or prove Windows acceptance. See [schema v6](assistant-inbox.md#known-conversation-dispatch-schema-v6).
