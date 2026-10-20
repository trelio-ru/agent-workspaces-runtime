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
no private credential belongs in them. These prompt/path tests do not prove that
the not-yet-connected business outcome/goal-stop backend is ready.

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
The production backend outcome adapter remains a readiness blocker until wired;
there is no permissive default or claim that native success proves business work.

A fixed internal readiness probe uses the same native path but asks only for
READY, with no tools/accounts/integrations. It is not a task execution or timer
proof. It is selected by trusted setup code, not exposed as an incoming-message
permission. Native Windows acceptance must be checked on a supported installed
host before activation; mocked child tests only verify the adapter boundary.

Tests: `trelio-assistant-scheduler.test.mjs` (real SQLite and timezone boundaries),
`trelio-assistant-codex.test.mjs` (exact transport/fencing/read-back), plus the inbox
suite. Native workflow runs them on Linux/macOS and Windows.

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

## Dedicated plugin entry and setup

The separate assistant plugin selects the existing signed-loader ABI as
`bridge assistant mcp` or `bridge assistant hook`. The generic entry selects
`trelio-assistant-entry.mjs` explicitly; unknown subcommands fail before any
human bridge, config migration, credential access or cache maintenance. Hook
startup retains the common non-sliding clock and never consumes a human Run cwd.

Before enrollment, the stdio surface exposes begin/finish/status with a non-authorizing
enrollment UUID. It composes the existing protected S256 journal, OS private store
and fixed HTTPS client, under one invocation-local Windows native worker. No
human OAuth/client configuration, owner browser login or credential-valued MCP
arguments exist. Unpaired discovery does not load private credentials. After pairing,
the read proxy below obtains live backend schemas. Input frames are bounded
at 128 KiB; unknown tools/fields and raw failures cannot expose the private journal.

An already completed pairing is read back privately and checked by live heartbeat;
retrying the setup tool never repeats the one-use exchange. An uncertain exchange
survives restart as recovery_required. Setup output distinguishes paired/contact
from business readiness. Task-pass admission and the installed background service
remain required; the current setup profile does not claim or start them. The assistant hook composes the ordinary observer, proof serializer, state lock
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
