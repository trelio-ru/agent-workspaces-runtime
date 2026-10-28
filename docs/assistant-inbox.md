# Durable assistant inbox

## Scope

`host-runtime/scripts/trelio-assistant-inbox.mjs` implements deterministic inbox
mechanics, without a model, network calls, background service or new plugin hook.
It is not an installed coordinator. Provider discovery/routing, assistant MCP,
owner decisions and credentials remain
separate adapters. Runtime-owned cyclic scheduling and the Codex adapter are in
[`assistant-scheduler.md`](assistant-scheduler.md). No existing human bridge/session is repurposed for a managed
assistant and no live pilot data is migrated.

The host injects an already opened private SQLite handle, compatible with Node's
`DatabaseSync`. [`node:sqlite`](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)
is available unflagged from Node 22.13 and remains experimental in Node 22.
A future assistant entrypoint must check this capability
before opening storage. Merely importing this library does not require SQLite or
raise the generic host's minimum version. SQLite is not dynamically installed.

The production opener must use the existing private-path/Windows native ACL
mechanism for the database, its directory and SQLite sidecars. This library does
not open paths, weaken ACLs or fall back to public storage. File-backed tests use
synthetic temporary databases; they do not prove production Windows storage is
ready. Unknown schema is retained and rejected, never reset or silently migrated.

## Partition and data boundary

A source is identified by exact HTTPS origin, assistant UUID, company UUID,
provider (`trelio|telegram|email|max`), account UUID and current binding UUID.
A new provider authorization uses a new binding; revocation is terminal for the
old source. Labels and matching provider event IDs never combine partitions.
Local paused/revoked state is a scheduling fence, not server authorization.

The database stores only operational references: stable event ID/revision,
nullable task UUID, a wake boolean supplied by the trusted adapter, cursor,
revisions, opaque native receipts and leases. Strict event/scope schemas reject
additional fields. Message bodies, titles, agent rules, credentials, company keys
and arbitrary provider payloads are forbidden. A cursor must be a non-authorizing
provider checkpoint, never an access token or raw encoded message. The provider
owns this classification, live access and encryption routing.

The store bounds one page to 100 events, pending events to 10,000, retained events
and delivery records to 50,000 each, sources to 256 and task bindings to 10,000.
Overflow returns `ASSISTANT_INBOX_FULL` before cursor advancement. An upper host
must surface that blocked condition; this version does not silently prune dedup
history or promise unlimited retention. Domain error codes contain no input
values; the host must project SQLite/I/O failures through closed diagnostics.

## Poll, routing and read acknowledgements

Before commit, the coordinator admits every new email INBOX reference. Telegram
and MAX incoming messages require signed native `attention`:
`direct|mention|reply|none`. Private incoming messages, actual mentions of the
authenticated account and direct replies to its own message may enter intake;
ordinary group history does not. A missing/unknown signal retains the cursor
with `ASSISTANT_SOURCE_ATTENTION_REQUIRED`, rather than treating legacy output
as an authoritative absence. Providers must roll out this additive signal first.
Attention is transient provider metadata, never message content or owner proof.

Ordinary group originals are omitted from SQLite while the scanner checkpoint
advances atomically. They remain at the provider for scheduled task review; a
busy group cannot fill the pending queue with context-only rows. Unjournaled
cloud deletions are therefore ignored; ambiguous known account references still
refuse without guessing. Filtering never earns processing or ACK.

Schema v15 adds only `automatic_ack` to original rows. Addressed group originals
use zero: Telegram/MAX range receipts must not mark intentionally skipped
discussion read. Direct messages and email retain automatic ACK. This policy
does not claim ACK success or unhealthy delivery; source due/claim/health skip
these intentional non-attempts. Legacy rows default to one; unknown started
writes always retain verify-only reconciliation. Replay may tighten this policy,
never re-enable it. Cursors, processed bits, receipts and leases are unchanged.

The durable delivery's existing scheduled bit selects `scheduled:true` in task
stdin, including recovery. On that pass the worker reviews new history for the
exact account/chat/topic links already recorded in accepted WORK.md. Each task
owns its successful review position, committed with accepted task material;
the poll cursor, unread flag or another task's position cannot replace it.
Incomplete/gapped reads or failed acceptance retain the old bookmark and an
explicit unresolved next step. Initial review is bounded with honest coverage.
No linked conversation or no scheduled pass means no automatic history review.
Ordinary skill history reads never fabricate original source processing slots.
An actually read routed original or authorized conversation work records those
exact links even without a pending reply. A single original receipt cannot
advance the independent history bookmark over unreviewed neighbouring messages.

`register` is idempotent. `claimPoll` holds a two-minute lease for one exact source.
`commitPage` checks that lease and cursor revision, then atomically inserts events
and advances the cursor. A full inbox or conflicting duplicate rolls back the
whole page. After a final page the next source poll is due in five minutes; a
continued page is immediately eligible. An expired/read-only poll may retry;
network I/O never occurs inside a SQLite transaction.

Deduplication uses source + event ID + source revision. An unchanged replay adds
zero rows; a changed wake/initial mapping at the same revision fails closed.
A later edit with a new source revision is a distinct event. Unknown task mappings
stay in `unrouted`; a verified host may map an exact bounded ID set through
`routeEvents`. That cannot move an already routed event to another task and does
not change its immutable source snapshot, so provider replays remain deduplicated.

`applyTaskState` projects a current backend decision with local CAS. A caller must
not infer `accepted` from a message, sender display name or a pending approval.
Unknown, waiting-owner, paused, done and revoked tasks do not cause event dispatch
or a new read acknowledgement. An accepted task inbox is durable before an ack
becomes eligible. Trelio notification acceptance retains its existing semantics;
external Telegram/email/MAX references additionally require committed processing
before an ACK lease is offered. This is necessary, not sufficient: the provider
adapter still proves the content was actually read and checks the exact revision.
A merely queued or uncertain external delivery is never ACK-eligible. Merely
fetching a page never marks it read.

An already native-started retained task pass is distinct from new dispatch.
After `done`, only its existing canonical Run settlement may continue under the
SAME native pass/marker ledger. Host-only start/watchdog opt-ins retain the
original binding generation and exact external source snapshot; they never
activate done tasks, manufacture processing/read evidence or acknowledge events.

Read acknowledgements have their own bounded lease/outbox. The provider must
recheck access and exact message revision before marking read; a lost external
ack response requires live read-back or a documented provider-idempotent method.
The queue does not authorize a range ack covering unseen messages. Source and
ack lease checks prevent a stale worker from committing a newer worker's result.

## Delivery and ambiguity

Only a wake event selects a task for unsolicited delivery. In Trelio, the native
server/provider adapter must classify a canonical assistant mention as wake and
an ordinary comment as context. The generic inbox does not parse message text or
invent a mention. A real cyclic scheduler may pass an explicit `scheduledTask`;
that permits a normal pass with context-only or no new events and is not evidence
that an automation exists.

Native mention-derived bindings need not add task participants. Current
comment-only access selects a restricted discussion pass: the SAME permanent
chat and original queued mention run while the timer stays paused. An exact
native published-reply outcome completes that delivery without Workspace/source
evidence; ordinary material passes retain their existing requirements. A restart
does not fabricate a cycle, and another actual mention reuses the same chat.
Owner-start decisions and native per-tool ACL remain independent; see the
scheduler's mention-derived discussion contract.

`claimDelivery` invokes a mandatory fresh authorization callback outside the DB
transaction, then rechecks source/task revisions. The callback must use the
current backend/provider ACL, managed lifecycle and task-start approval. Local
acceptance alone grants no rights. Before external dispatch, `startDelivery`
records the boundary. One leased, started or uncertain delivery blocks a second
desktop dispatch globally, across companies. The native adapter must maintain one
permanent chat per accepted task and reconcile its own exact chat/turn identity;
this table does not substitute for that adapter or native schedule read-back.

A lease that expired before `startDelivery` may be reclaimed. A started delivery
that expires becomes uncertain, retains its event set and cannot be automatically
sent again. The adapter must inspect the exact original native turn. Only positive
native acceptance/completion evidence permits `completeDelivery`; merely finding
a chat, a timeout or an RRULE does not. Identical completion receipts are
idempotent. Access revocation does not erase historical results of actions already
accepted externally.

Only a verified terminal native rejection may call `resolveDeliveryNotAccepted`
to release the event set for another delivery. A missing turn in a list while the
original request may still be in flight is insufficient. The old ID/receipt is
retained, and its late completion cannot commit the next delivery's result.

Tests: `node tests/trelio-assistant-inbox.test.mjs` uses real SQLite memory/file
stores and two connections. Native workflow invokes it on Linux/macOS and Windows.
It covers restart, duplicate pages, task routing, source separation, cursor CAS,
ordinary comments versus wake events, scheduled passes, owner-pending tasks,
read acknowledgement, revocation and uncertain external dispatch. It does not
claim a live Telegram/Trelio/Codex end-to-end run.

## External ACK attempts (schema v5)

The same private event journal adds an `ack_started` bit, original attempt
lease UUID and retry timestamp, never body/read proof/credentials or a second outbox. `claimAcknowledgements`
keeps the Trelio ABI and idempotent native notification handling. For external
sources it additionally returns `reconcileOnly`; fresh and uncertain rows never
share a batch. Committed processing remains mandatory before either kind is
claimable. A mere claim cannot complete an external ACK.

The trusted provider adapter must first verify live source/task authority, exact
content-read evidence and committed processing. Immediately before its ONE
native provider invocation it calls `startExternalAcknowledgements`. A crash
before that boundary may reclaim a fresh attempt; after it, lease expiry/restart
retains the bit and offers only read-only reconciliation. Source pause/revoke
invalidates the current lease without clearing the original attempt fence.
Neither processed=true, a lease nor this queue API authorizes a provider write.

`deferExternalAcknowledgements` preserves that fence under bounded backoff and
invalidates the old lease immediately; the retry timestamp never extends the
original deadline or admits a late completion. Only
a complete validated signed provider result proving `writeAttempted=false` may
set `notAttempted=true`, and ONLY for the exact original attempt token. A later
verify-only result also performs no write, but cannot clear uncertainty about an
earlier invocation: a replacement lease fails that token check. Timeout, missing
reply, arbitrary model output and `acknowledged=false` never release the fence.
Native positive read-back under the current lease is required before the adapter
calls `completeAcknowledgements`; the queue never infers it from its own bits.

The v4 → v5 upgrade retains source/channel cursors, task/delivery state and ACK
leases atomically. Pre-existing unacknowledged external leases are conservatively
marked uncertain without adopting their old token as new no-write evidence.
Their next claim is read-only. Trelio leases remain unchanged. Unknown schemas
remain closed. Tests cover actual SQLite restart, late completion, no-write
recovery, mixed batches, source pause and real prior-schema migration. This is
the durable lifecycle boundary reused by the production adapter below; its
bits alone never grant provider execution or business readiness.

## Production Telegram acknowledgement

The background coordinator composes `acknowledgeAssistantSource` through the
same protected device invocation, signed package verifier/cache, managed account
catalogue and native process engine. It does not copy a provider, vault or human
session. Model/task skill commands still cannot execute ACK. The internal
`assistant_source_ack` capture mode consumes an exact one-use native profile;
the mode string, a local processed flag and public package bytes grant nothing.

Before claiming write authority the adapter recovers only ORIGINAL processed
slots with independent `read_delivery_id`, immutable delivery snapshots and the
completed native `assistant:<receipt>:codex:<thread>:<turn>` receipt in this SAME
SQLite inbox. No second receipt database or body storage is added. The fixed
source resolve endpoint receives source UUID/revision plus committed receipt UUID
and original ordinals, never provider IDs, conversation keys, semantic hashes or
message bodies. Native current write/device/source/owner/project/task/assignment
checks and nonretired material remain mandatory, including for historical done
tasks. A done receipt does not authorize a new pass or new body read.

Materialization is followed by fresh native admission under the ORIGINAL bounded
monotonic clock; no cached package or renewed profile extends it. The same account
selector verifies company/member/device bindings. After interpreter/environment
preparation, immediately before ONE child spawn, the executor calls the private
profile's final identity/deadline/source reread and persists the original ACK
attempt. A failure after that boundary is uncertain even if no child response
arrives. No mutation retry is hidden in this executor.

Fresh tokens contain ONE conversation before a write starts. Legacy uncertain
tokens retain their original membership and may contain several conversations:
every group is verified read-only and ALL must be positive before completing the
token. A verify-only no-write result cannot erase uncertainty about an earlier
write. Current source configuration, original private refs and lease are checked
again after the provider result. Lost/expired/paused results retain their fence.
Only the exact original attempt with a complete validated native no-write result
may return to fresh eligibility; failures receive bounded five-minute backoff.

The signed Telegram provider additionally proves actual private account/key,
exact current message revisions and the ENTIRE contiguous native unread range.
An omitted/unprocessed earlier message prevents the range ACK. Several committed
task receipts may cover one range; historical edits remain references and cannot
override the provider's current revision. Complete bounded success DTO or native
nonzero-exit error DTO is privately projected to closed counters/codes; stderr,
error prose and provider envelopes never enter logs, model output or SQLite.
Timeout/overflow/partial pipes never count as no-write evidence.

Pure inbox due discovery avoids source I/O for an empty ACK queue. At most four
oldest due source queues run per coordinator tick; failures retain their own
backoff and do not stop other companies. Tests exercise synthetic signed native
children and real SQLite read → explicit processing → unknown ACK → restart →
read-only reconciliation, including mixed legacy conversations. These are not a
live Windows/provider business E2E or evidence of installation; the remaining
full product gates keep `businessReady=false`.

The production coordinator reports ACK diagnostics through the SAME native
source-health CAS/account bell/SSE/linked messenger FIFO as passive reads. Optional
`phase=acknowledgement` carries only `ready`, `acknowledgement_uncertain` or
`acknowledgement_blocked`. The backend retains independent read/ACK components;
a successful poll cannot hide an unresolved write and a positive ACK cannot hide
a reading failure. No body, provider ID, raw error or new notification engine is
introduced. Unknown writes notify immediately; a known blockage gets five minutes.

The snapshot precedes provider work. Reporting failure/CAS conflict neither
replays the provider nor changes its original queue fence. Diagnostics aggregate
ALL conversations in the SAME durable journal: one positive token cannot clear
another uncertain attempt. A later normal poll can reconcile a lost health report
from current-generation durably completed rows without another provider call.
An empty/new source supplies no recovery evidence. Source-generation changes
never turn old positive rows into new success or erase an old unknown attempt.
These diagnostic facts grant no ACK/retry/owner consent. The SAME registration's
pause/resume recovery is read-only as described below; replacement accounts or
assignments still fail closed, without reset/adoption or forced replay.

## Read-only recovery across source generations (schema v7)

Pause/resume of the SAME immutable source/account registration does not revive
historical routes or permit a new write using old processed slots. Such slots,
including a never-started old attempt, receive a durable `ack_verify_only` lease;
uncertain original attempts retain their original write fence and membership.
The queue cannot upgrade that lease to a provider write. Original independent
reads, completed native receipts and exact slot/route/binding remain mandatory.

The dedicated native intent and response explicitly bind `verifyOnly:true`.
The common signed execution profile rejects missing/mismatched mode and a
`--confirm` substitution before account/provider work. Current active device,
owner/source/project/task/assignment ACL and nonretired material still apply;
pause, revoke or a replacement registration never adopts historical state.
Negative/unknown read-back keeps the original fence and bounded backoff. Only
positive native read-back of ALL groups may commit ACK completion.
Due selection rotates ordinary deferred conversations by persisted retry time
instead of restarting the first row at every five-minute check. Original
uncertain groups remain indivisible, even across the discovery page boundary;
oversized or not-yet-eligible legacy groups retain their fence.

That SAME SQLite transaction records the current source verification revision
in `ack_verified_revision`, so a lost owner-health response is recoverable after
restart without another provider invocation. Source revision change invalidates
this projection; old success cannot clear a new incident. The additive v6→v7
upgrade preserves all prior rows/cursors/leases and invents no read verification
or provider write attempt. No body, credentials or second journal is added.

## Coordinator projection and schema v2

Schema v2 upgrades existing private SQLite atomically, retaining cursors, task
states, acknowledgements and uncertain deliveries. Task state may include a
server `authority {bindingId, revision}`. An identical snapshot is idempotent;
older revisions, a changed binding ID or dropping recorded provenance fail.
A newer revision may resume a revoked assignment after a real backend decision.
This local revision check still requires fresh `authorize` before dispatch.
Legacy callers without authority retain their terminal revocation behavior.
`taskState`/`listSources` return bounded operational metadata only.

`abandonPoll` releases a failed read-only poll into durable bounded backoff,
retaining its cursor. The host never repeats an ambiguous external mutation by
using this read-recovery primitive. Acknowledgement refs now include task UUID.

A synchronous trusted `onDeliveryCompleted` callback runs in the same transaction
as processing the delivery events. The scheduler uses it to advance the next run
atomically. A thrown callback rolls back both sides; a Promise is rejected. No
model callback, I/O or native action belongs inside this transaction. A persisted
`scheduled` flag distinguishes a cyclic launch from an event wake: an event
finishing after the deadline is not proof of the first timer run.


## Owner dialogue references (schema v3)

The additive v2 → v3 upgrade retains events, cursors, read acknowledgements,
started/uncertain deliveries and their exact event sets. One nullable
`owner_question_id` stores only the UUID supplied by the canonical Trelio answer
notification. An ordinary event cannot gain a question reference without a wake
and a task. Same-revision replay with a different reference fails before cursor
advancement. Question or answer text, usernames and approval flags are rejected.
The original references survive pre-launch recovery; a new poll cannot replace
the event set of an already reserved delivery. This is routing metadata, never
owner consent or content authority.


The Trelio notification client reconciles/polls/acknowledges only `trelio` rows.
An optional trusted source reader enables the coordinator's separate external
reference intake. Production host composition supplies the existing device
`sourceAccounts` client and signed `readAssistantSourceMonitor`; neither a model
argument nor a SQLite row chooses another transport. A successful Trelio company
inventory alone still does not revoke external sources, and an external cursor/ID
never reaches the notification endpoint or its ACK method.

Every five minutes, a successful exact source inventory registers scoped native
account/binding refs and reconciles pause/revocation. Failed inventories are not
empty: positions remain, and the old discovery map cannot continue polling.
Each page rechecks the same native row before and after provider read. Changed
state/revision/account/project prevents page acceptance; the cursor and events
still commit together under the existing inbox lease/transaction. The provider
reader uses the common private invocation, signed package/cache/account engine
and child process, with its narrower private cancellation signal propagated.

At most four oldest-due registrations receive one page per coordinator tick.
Persisted `next_poll_at` provides fairness across worker restarts and continued
pages; a large account backlog cannot monopolize all companies. Final pages wait
five minutes, continued pages are immediately due, and read failures retain the
cursor with the same bounded five-minute backoff. Pause/revoke retains history.

Only id/revision pairs enter the inbox, with `taskId:null,wake:false`. Provider
body/sender/claimed mapping cannot wake a model, create a task or authorize an
owner command. Such refs remain unprocessed/unacknowledged until separately
implemented native mapping, exact body read and committed processing. Duplicate
pages after restart add no rows. This is wired reference intake, not full external
message delivery or production business readiness.

MAX has no native conversation selector in the current registration, so intake
refuses it before provider launch. Telegram's typed channel hints enter the SAME
SQLite transaction as account events/cursor. Their marked native peer is derived
only from the known channel constructor, never an untyped message/username.
Each scoped child stream has its own signed checkpoint, lease, cursor revision,
pending signal generation and completed generation. The additive schema v4
retains all existing source/task state, leases, unknown deliveries and ACKs.
No new database, credential store, provider or account namespace is created.

One shared page-acceptance routine enforces the original dedup/snapshot/50,000
event and 10,000 pending bounds for both account and child pages. The global
10,000-stream bound fails before account advancement; stream IDs/revisions,
native cursors (including the ORIGINAL account checkpoint before a new hint),
counters and timestamps are the only new persisted fields.
Pause/revoke invalidates child leases as well as the account lease. New native
hint + account cursor commit atomically; repeated same-checkpoint hints do not
reopen a completed stream. A final read completes only its CLAIMED generation,
so a concurrent newer hint remains pending. Read failure retains both positions
and applies the same five-minute backoff. Final streams are not polled again
until a new account hint. Parent and child jobs share the four oldest-due pages
per tick; discovery failure cannot continue either from stale registrations.

The first child read uses the SAME signed passive reader with fixed
`monitor --chat MARKED_ID --initial-account-cursor ORIGINAL_ACCOUNT_CURSOR`, not
a silent empty baseline or current unread flag. The provider validates the seed's
native account/member/company/local binding and monitor HMAC. It returns visible
history at or after the ORIGINAL account date (inclusive), frozen top/offset/date
bounds and the pre-history channel pts checkpoint. Messages read on another
device therefore remain in that initial new-message interval. A newer account
hint must NEVER replace the earliest stored seed. Continuations retain the
signed checkpoint and then require its native difference catch-up. A legacy
baseline, unread-only coverage, missing seed, unknown provider option, foreign
chat or incomplete/invalid coverage fails closed without a new child cursor.
This does not reconstruct old edits/deleted bytes before the first channel pts:
`initialAccountInterval=true,snapshotAtomic=false,earlierEditsIncluded=false`
remains explicit. Full initial account inventory and ordinary cloud unread
bootstrap remain independent release gates. The provider's separately explicit
initial-unread mode is not sufficient to finish an already observed account hint.

All child refs stay in their existing account/source event partition, unrouted,
non-waking, unprocessed and unacknowledged. Neither the passive history hash nor
its cursor proves body read, owner authority, task routing or committed business
handling. An unrelated successful account/page cannot clear source recovery while
any child signal is pending; only all streams caught up permits native `ready`.

Cloud deletion IDs carry no peer. The coordinator consults only exact literal
suffix matches in this same source's existing event journal, discards channel
numbering (marked peers <= -10^12), and requires exactly one prior native message
reference per ID. No other company/account/binding, sender name, first match or
current uncommitted page can supply a peer. Missing/ambiguous references or a
combined page over the original 100-event bound retain the old cursor and report
`history_gap`. The closed host deletion revision binds exact source/ID/checkpoint;
it is metadata, never message-body read proof. New refs and cursor commit through
the SAME inbox transaction, remain unrouted/non-waking/unprocessed/unacked and
replay identically after restart. `findEventRefsBySuffix` is a bounded parameterized
metadata query, not a second index/database or model-facing search surface.

Telegram's marked channel representation is documented by
[Telethon](https://docs.telethon.dev/en/stable/concepts/chats-vs-channels.html).
Unresolved deletion review, initial account/cloud backfill and business handling remain
gates; no baseline/reset, provider mutation or guessed routing is introduced. Cursors exceeding
the inbox's existing 2048-character bound are likewise refused, never truncated
or reset. These closed diagnostic conditions, owner-visible source recovery,
stream onboarding, routing/body/ACK and actual Windows E2E remain release gates.

## Known-conversation dispatch (schema v6)

The SAME private SQLite journal adds only structural conversation keys, native
source/route revisions, a canonical dispatch-source key, a dispatched bit and an
internal per-delivery read slot. No message body, sender identity, rule, credential
or second outbox/vault enters these fields. Source configuration changes and
pause/resume retire pending routes/read evidence without resetting any account or
child-stream cursor, uncertain native turn or original ACK-attempt fence.

A signed Telegram monitor may supply its opaque domain-separated account HMAC.
Reviewed email releases may supply their scoped untrusted-threading-header hash.
Email hints are not HMACs, sender/owner proof or independent task authority; a
native accepted route and current audience/task/source checks remain mandatory.
Older providers remain passive and non-routable. A newer verified replay may fill
legacy ABSENCE once, without changing initial mapping/wake or granting processing;
a known key cannot change. An older replay cannot erase the newer capability.
`pendingExternalRoutes` scans bounded oldest unchecked refs with a durable
five-minute cadence. Only a successful exact native lookup selects current
accepted task bindings on this device. Failure is an error, never authoritative
absence. Native lookup receives opaque hints only, not provider IDs or bodies.

`routeExternalEvents` validates the complete source/assistant/company partition,
current native configuration revision and exact already accepted canonical task
binding. It never provisions a task, changes a binding or rebinds the scheduler.
Only exact classified original routes put incoming refs into the SAME task
delivery as Trelio mentions and due cycles; conversation-only hints never do. Outgoing/deletion refs are context only; unknown conversations do
not wake, create tasks or disclose bodies. Delivery scope remains the canonical
Trelio source. Each event retains its own provider source for separate processing
and ACK. Trelio notification poll/ACK never receives external provider IDs.

The bounded batch prioritizes an undispatched wake over old unread context, so a
full context page cannot repeatedly hide the event that woke the task. Its exact
order, conversation key and route/source generation are frozen in the original
delivery-event rows. Recovery does not replace them with a newly valid route.
Read-only routing failures retain mappings under durable bounded backoff; they
do not starve later source scans or fabricate an authoritative empty result.

The coordinator repeats live native source/route/task checks before a turn and
while it runs. SQLite synchronously rechecks the allocated external snapshots at
prepare/start/renew, closing a local pause/reconfiguration race after network
validation. A source resume cannot revive that old delivery snapshot. Native
runtime context includes bounded structural source references over stdin only;
message text and owner-command authority are not supplied by this projection.

`completeDelivery` marks refs dispatched to suppress repeated unsolicited wakes.
For an external ref this does NOT mean processed/read. Unread work remains in
later normal task cycles. The internal trusted `recordExternalRead` boundary
accepts no content and binds independently validated native read evidence to the
exact currently started delivery/route/event/source generation. A native or
business receipt alone cannot populate that slot. The SAME signed task executor
now observes exact `read-reference` successful bounded EOF output, checks its
account/key/revision/coverage and repeats native pass/source/route plus original
SQLite checks before storing that slot. Failed, partial, changed, context-expanded
or read-state-mutating results never earn evidence. No body is saved.

The observed completion hook separately signs only explicitly selected actual-read
slots with the SAME runtime key/nonce engine and generated structural serializer.
The native immutable outcome binds original source/route UUIDs and delivery
ordinals to accepted material. No message ID/revision/content hash enters that
server manifest. Recovery reads its exact committed manifest; `completeDelivery`
processes ONLY those slots, after independently checking their original read and
routing snapshot. Schedule continuation and selected processing commit atomically
in the SAME SQLite transaction. An omitted slot stays pending even if its body
was read. A whole-pass receipt/read slot alone is never enough. Task-local provider
ACK remains forbidden. Production provider ACK admission/composition, unknown
conversation intake, Windows business E2E and encrypted-device execution remain
independent gates; `businessReady` is still false.

The true v5→v6 fixture keeps cursors, original leases, uncertain deliveries and
ACK fences. Additional real SQLite/coordinator tests cover one permanent chat,
unknown/outgoing refs, bounded immutable native locators, source/route revocation,
no repeat wake, unread retention and refusal before the one-use native start.
They do not claim a real Telegram/Windows business E2E or production ACK.

## Exact email processing and ACK (schema v8)

The SAME source reader requests `monitor --conversation-references` only from
reviewed signed email releases >=2.6.5. Older releases retain passive non-routable
polling; no message topic, address, body or guessed owner identity enters SQLite.
The bounded twenty-UID page charges header reads to the original source deadline.
A successful header projection is required before accepting a conversation key;
malformed/cross-provider keys fail before the page/cursor commit. No initial
unread backfill or cursor reset is implied by enabling this newer protocol.

Known incoming INBOX conversations use the SAME native route lookup, canonical
task/permanent chat, pre-start snapshot fences and explicit original processing
slots as Telegram. Unknown conversations stay unrouted, non-waking and unacked;
email never authorizes new task creation. A scoped hash of untrusted References
or Message-ID is only a routing hint, not verified sender/owner authority.

The SAME signed task executor observes exact `read-reference --uid UID
--uid-validity VALIDITY --expected-revision REV --expected-conversation-key KEY`.
Only full text coverage, no other messages/read-state changes, matching original
account/key/UID/namespace/revision and a full RFC822 SHA-256 earn a private read
slot after fresh native pass/source/route and original SQLite checks. Schema v8
adds only nullable `read_original_sha256` to that SAME private event journal;
no body, headers, credential or second vault/outbox. A changed digest at the
same UID/UIDVALIDITY is refused rather than silently replacing observed bytes.
The additive v7 upgrade preserves all positions, leases and unknown attempts
and never invents a hash/read proof from legacy processing or ACK bits.

Explicit selected reads plus native accepted material still precede processing.
The native manifest carries the SAME source/route/ordinal references, never the
provider UID, body or original hash. The background adapter derives its native
ACK admission from that committed receipt and passes the private original hash
only to the SAME signed account/process engine's existing IMAP ACK primitive.
The one fresh attempt covers exactly one UID, not its whole conversation. Lost
outcomes keep their original durable fence and permit only EXAMINE/PEEK/FLAGS
read-back of ALL original UIDs. Confirmed Seen on a sibling never completes
another UID. Source pause/resume remains historical verify-only, without revived
routes, new writes, human credentials or fresh inferred processing.

This host flow requires the matching dedicated native email route/receipt/ACK
admission and a newly published reviewed provider version. Neither is fabricated
from a local flag. Real Windows business E2E, unknown
conversation intake, encrypted execution and the other full product gates remain
required; `businessReady` stays false and no installation is performed here.

### New email messages only

Automatic checking starts with the native forward UID/UIDVALIDITY checkpoint.
It never opts into `monitor --unread-backfill`, creates an initial-unread seed or
classifies the pre-connection unread backlog. The checkpoint is confirmed by
the first successful provider baseline, not an untrusted Date header or the
local button-click clock. Subsequent native UIDs are read independently of Seen,
including new mail already read on another device.

The SAME SQLite journal atomically retains the forward position and accepted
refs. Restart, pause/resume and upgrades never reset an established position.
Legacy `email-initial-unread/v1` rows remain byte-for-byte available for inspection,
but are excluded from automatic due/pending/claim selection. No old stream cursor,
original event, committed processing receipt or uncertain ACK fence is erased or
converted into a read/processing outcome. Explicit provider history tools remain
separate from automatic checking and preserve their ordinary authorization.

A returned history seed is rejected, including on the first baseline. Failure,
late source changes and SQLite rollback preserve the prior position. No body,
subject/address, guessed mapping or read receipt is introduced by initialization.

## Native MAX through the same source journal

The native registration optionally selects one canonical numeric `maxChatUrl`
(`https://web.max.ru/<signed-64-bit-chat-id>`), including its generation/CAS.
A null selector is the native owner-selected account root and requires signed
provider >=2.13.0 plus native `maxAccountDiscovery:true`. Explicit old URL rows
retain their exact selector and >=2.11.0 contract. No title, handle, default
conversation, human catalogue or legacy-session import is used.

The account root observes the browser's own fresh full sync (`chatsSync:0`) and
correlated native dialog pages until `marker:0`. An unread DOM folder or partial
list cannot advance its v3 account cursor. At most 1,000 genuine signed-64-bit
dialog IDs are admitted; incomplete/oversized/stale chains preserve the original
position. The browser emits every request; the runtime never sends protocol
packets or reads its auth storage. `lastEventTime` changes signal histories even
when a different device already marked the message read. The first complete
scan is only a checkpoint with zero hints, regardless of old unread counters. Native server scan time scopes the
opaque original seed; no dialog titles, message bodies or auth packets persist.

Account cursor and conversation hints commit atomically in the SAME existing
SQLite stream table before any child read. New children preserve their ORIGINAL
account seed through later scans and restart; the first signed history must cover
that exclusive native-time interval, including already-read newer messages.
Old unread messages never enter the initial classification; they do not need to
fit this bounded window. The signed coverage must confirm `newMessagesOnly:true`.
Missing rendered/native coverage refuses advancement. Later child reads use the
existing exact v2 message cursor, independent of unread flags. Shared stream
fairness and one-page worker bounds stay in force. No new queue/schema is needed.
Coexisting account-root/exact-chat registrations use the complete native account
inventory and actual event chat coverage to select one local triage queue; this
never selects a company, owner identity or task on its own.

Both MAX modes run through the SAME account catalogue,
package verifier/cache and subprocess engine. It observes only the same
browser's native history and correlates genuine sender/message IDs with the
selected DOM history. Exact-chat initialization is a zero-event forward baseline;
account child initialization uses only native timestamps AFTER the original
server checkpoint. Subsequent v2 positions are independent of read flags elsewhere.
An independently authorized manual history read never becomes automatic backfill.
Malformed/changed scope, missing anchors, incomplete historical windows or
unknown native wire shapes preserve the old position instead of skipping.

`max-conversation/v1.<hash>` is a scoped routing hint, never linked owner proof.
Only a fresh existing native route may select the permanent task chat. Unknown
conversations remain unrouted, non-waking, unprocessed and unacked. MAX owner
intake requires its separately verified native binding; username/DOM/forwarded
author text cannot create one. Native outgoing messages are context, not wakes.

The SAME SourceReadObserver admits exact `read-reference --chat URL --message-id
ID --expected-revision REV --expected-conversation-key KEY`. Full native text,
original account/source generation/task route/revision, no unrelated messages or
read-state changes and a fresh live pass are required before recording a read
slot. Body text and sender identity never enter the private SQLite journal.
Explicit original processing slots plus accepted material still precede business processing; complete native-confirmed model delivery independently enables read ACK (schema v18).

The SAME native committed receipt admits `max-message-ack/v1` for those exact
slots. The signed provider privately rechecks every covered ID/revision, freezes
the complete native unread TIME prefix and permits only one matching native
`READ_MESSAGE` browser frame after a fresh history/identity. Opaque numeric IDs
do not define that time range; equal-time neighbours require coverage as well.
The general human send/reply receipt switch stays closed. No direct socket or
HTTP request, broad read-all, reaction receipt, fresh authority or extra message
is synthesized. A changed native attachment/body or incomplete range refuses.

The durable attempt fence is written before signed child launch. A lost/unknown
result never permits automatic repetition; restart uses the same original slots
and verify-only native history. Positive read-back on one sibling never implies
others were acknowledged. Pause/resume and lost health reports retain the same
shared generation/receipt/unknown-outcome rules as Telegram/email.

Synthetic signed-child, private SQLite and native wire fixtures verify this
composition. They do not establish live MAX login, current server compatibility,
production publication or Windows business E2E; those remain independent release
gates and `businessReady` stays false until the entire product passes them.


## Verified owner intake (schema v9, reply receipts v16, unread recovery v17)

The SAME private inbox now retains structural `assistant_owner_intakes` records
beside original refs/cursors. Only incoming, original Telegram/MAX refs with a
fresh linked native owner binding become candidates. Poll compares identity
bindings before and after the signed reader; the queue persists the binding UUID,
not a sender ID/body/username. Email never enters this branch. An original native
account/event/revision is initially considered once across configured companies.

Intake provisions/reuses one restricted chat per source/owner binding through the
SAME native Codex adapter and observed session/proof engine. Its taskless pass is
an explicit discriminator, never fabricated task/binding metadata. Only native
context/resolve tools are executable in that taskless pass. Their definitions
remain available in cached Desktop task catalogues before activation; metadata
does not authorize the other advertised tools. Private host reads the exact original through
the SAME signed account/process engine, repeats source/pass/owner checks and
confirms native read before returning original text in RAM. Quoted/forwarded,
outgoing, via-bot and mismatched native senders cannot create tasks.

For a simple private Telegram owner question, native `reply_owner` commits a
`reply_pending` receipt after the host has proved that the native private peer
equals the current linked owner. A group sender match is insufficient. The SAME
restricted visible chat answers without creating a task, Workspace, Run or route.
An older host never supplies this new private-peer fact, so it cannot accidentally
commit a reply it cannot execute. The new host requires provider >=2.14.0 before
confirming the owner-body read; passive/triage readers retain their prior ABI.

Schema16 adds only nullable `reply_receipt_id` and positive `reply_message_id`
to the SAME private SQLite journal; migration preserves old refs/cursors/fences.
Text is transient RAM/private child stdin, never SQLite/argv/env. The ordinary
process engine persists the attempt at its final spawn boundary. Exact signed
send/read-back is persisted before native `replied` confirmation. A lost HTTP
confirmation is a receipt-only technical retry, even after SessionEnd; it never
starts another model/provider invocation or invents fresh observed model proof.
The actual CLI success envelope includes `ok:true`; the strict positive reply
validator retains that field and all exact reference/message checks. A lost
provider result can be reconciled without sending: read one completed original
Codex tool call as the private comparison text, select at most four candidates
from signed monitor refs in the SAME source/conversation, then use the SAME
signed provider's exact `read --message-id`. Fresh native admission pins the
original pending receipt, linked owner and candidate ID; only verification may
outlive the old model lease. Native outgoing direction, original reply header,
peer and full expected text must all match before persisting the positive ID.
No body reaches the model or journal; no source/task creation, read ACK, changed
reference, missing/duplicate marker or absent message authorizes a resend.
Missing/ambiguous provider evidence stays fenced; the original is not resent.
Reply receipt alone does not borrow the task-material processing/ACK path.

Clear owner commands use the SAME native creator/BOTH ACL and commit task,
accepted new assignment, receipt and per-event route atomically. Ordinary task
provision subsequently creates its permanent chat. Multiple commands in one owner
conversation remain independent events/tasks; no whole-conversation route is
installed. Created refs are still unread/unprocessed: only ordinary independent
body read plus committed task material outcome can earn the existing native ACK.

Ambiguity uses the SAME owner question/notification/answer core with an exact
source/intake target, Other+text and no fake task. Waiting releases only a native
positive receipt; an answer reopens the same intake with a fresh native model
snapshot and original-body read. Company redirection closes the old receipt,
retains original-event UUID and starts an independently authorized pass using the
selected configured company/model. Unknown outcomes retain their original fence.

Native cancellation is serialized with create and returns either the already
committed receipt or a positive cancelled receipt. The host never guesses closure
from a failed read. The ordinary retry still requires that positive cancellation
and a later explicit source generation; original receipts/UUIDs and global native
created-event uniqueness stay effective.

Schema17 adds one narrow automatic technical recovery for owner-command intakes
that never reached the original body. Fresh native read-back must confirm the
same source/revision/device/thread/event, `cancelled`, the exact saved receipt,
`readConfirmed:false` and no task. The original native marker must independently
be completed/failed with a real turn UUID. Current source/owner/model admission
and trusted native hook preflight are checked again. The SAME fingerprint binds
runtime version and actual hook definitions; one retry per fingerprint and at
most20 appended attempts in a source generation prevent loops. A five-minute
backoff separates cancellation from recovery.

The new attempt preserves the original event UUID and native message reference,
gets new intake/provision/delivery IDs, and provisions a fresh visible restricted
Desktop chat with current metadata. This never creates a task or Workspace Run.
The old native-start bit, marker, cancellation receipt and attempt remain in the
SAME SQLite ledger. Only its ordinary next-check metadata changes. Source
revocation, policy denial, an unknown marker/receipt, any confirmed body read,
owner dialogue or a reply attempt cannot take this edge. A later explicit source
generation clones only the latest cancelled attempt once; a later positive reply
suppresses the whole original chain.

The v16-to-v17 UNIQUE-key migration follows SQLite's documented generalized
ALTER procedure on the migration connection: one transaction, exact old columns,
all rows/FK names, mandatory foreign_key_check before commit, and restoration of
foreign-key enforcement on success AND failure. Unexpected owned indexes/triggers
or malformed schema refuse before rebuild; no writable_schema, reset or dropped
unknown history. Tests reopen a real FK-enabled v16 file, inject a rejected
rebuild, verify rollback and preserve unknown send fences.

 A paused waiting question is cancelled by
that same native path. Inaccessible rows without a running pass defer without
blocking unrelated companies. The bounded existing page skips a policy-blocked
or unanswered row after recording its next check, so every five-minute worker
can reach later companies; no event is processed/ACKed or cycle moved for that
row. Each worker visits a pending receipt once, allowing ordinary task-chat
provision before routing that newly created task. Unknown provisioning is read
back before any source/model policy deferral and retains its global fence,
even without a returned thread ID. A positive native cancelled receipt stops
the owned running turn; created/waiting/ignored still await their normal final
marker. An abort/kill request or resolved/rejected CLI adapter is not a terminal
marker; started cancellation rereads that original native delivery independently.
Before the durable native-start CAS, cancellation closes only the never-started
preparation. After crash/restart, a source pause, expired lease or positive backend
cancellation cannot replace the exact original Codex completed/failed read-back.
The protected pass stays held until that native terminal marker. A closed created
receipt whose fresh task binding/ACL/transport read fails retains its receipt and
typed cause, backs off new company work and never recreates, routes or ACKs the
original event. An unknown active pass keeps its global fence.

Schema upgrade is additive, preserves all original cursors/deliveries/read/ACK
proofs and does not invent owner evidence for historical rows. Tests use genuine
SQLite transactions/restarts, signed native children and a separate native
PostgreSQL/HTTP/MCP composition. They do not prove live Windows business E2E or
an encrypted source content plane.

### Encrypted source metadata and body processing

Source UUID/revision and opaque known-route references remain structural in a
stable encrypted company. The production coordinator passes the exact current
source selection to the SAME signed monitor. Configuration ciphertext opens only
inside the managed profile using native-selected payloads and current recipient.
The SQLite schema and durable cursor/route/read/processing/uncertain-ACK engine
remain unchanged. Provider body and decrypted config/rules never enter its rows.

Task body read still uses a distinct genuine task pass/proof and shared signed
executor/SourceReadObserver. Only successful complete native read plus current
route can record a read slot. The independent native accepted encrypted material
outcome must explicitly select the original business-processing slots. Read ACK independently follows native-confirmed complete model delivery (schema v18). Restart preserves
the same slots and one-use unknown-write fence; no blind ACK retry or fallback
into human OAuth/session/key storage is introduced. Encrypted owner setup and
unknown-conversation intake remain separate capabilities.

## Schema v10: existing-task triage before body access

The SAME private inbox supports two closed intake kinds. `owner_command` keeps
its proven native owner identity and original single-event creation workflow.
`route_existing` has no owner identity, contains 1–100 immutable original UUIDs,
and can partition its originals between existing accessible accepted tasks. Bodies, senders,
candidate titles, rules and answers never enter SQLite. The additional bounded
batch-reference table contains only exact original/event/account IDs and ordering;
the parent retains closed kind/freeze/redirect and native receipt/route/task IDs.
The forward v9 migration preserves every cursor, original UUID, native invocation
fence, delivery and outcome. Unknown schema is not reset.

A successful native known-route lookup precedes new triage. A failed or partial
source inventory is never a singleton choice. A complete successful inventory
selects one local queue source per physical account/provider (and configured MAX
chat); this is a cost/dedup preference, never company authority. Same-account
originals deduplicate across company source rows before body access. A direct
owner-command claim takes precedence. Conversation correlations never bypass triage or remove an unfrozen claim.
The coordinator deliberately discards whole-conversation routing results,
including results returned by an older backend. Exact route-ID reads remain
mandatory for already classified originals and in-flight recovery. Already classified or
ignored originals are not reconsidered; ignored is not processed or ACKed.

Unfrozen originals coalesce by conversation/source generation. The first native
begin freezes the exact ordered batch. Later messages wait for a separate batch;
settled batches reuse the restricted chat of that same conversation/generation.
No per-message native chat is provisioned. A frozen/native-started attempt cannot
be promoted, rewritten, or released by a later mapping, owner proof or timeout.
Unknown native invocations retain the common global fence and exact marker
read-back, independently of source pause/revocation and domain cancellation.

The native `route_existing` begin first receives `threadId:null`. It selects the
company/source before any tool-free chat, body read, model turn or content
hydration. Ambiguity uses the existing neutral native owner question; waiting has
no executable model configuration. After a positive selection the SAME begin
attaches the actual provisioned thread UUID under CAS. No fabricated UUID or new
endpoint is involved. An original redirect/cancellation may retain a null thread
and null execution as a structural terminal receipt; neither admits a model.

Company/source redirects never copy an old provider key or revision into the
new scope. The host must first find exact same-account native originals in the
selected source's actual signed monitor journal. Email takes the selected
UIDVALIDITY/UID revision as well. The original UUID batch and native redirect
receipt remain provenance, while body reads use only selected-scope refs. Missing
historical target metadata yields bounded backoff and the specific
`ASSISTANT_INTAKE_SELECTED_REFERENCE_REQUIRED` incident; no guessed key, reset,
body read, model turn, cross-company route exception or ACK fills that gap.

The existing observed hook/proof and session-fixed `source_intake` MCP view serve
`source_triage/v1` through the SAME two tools. The local pass adds only closed
`intakeKind:'route_existing'` and frozen `eventIds`; role/batch swaps fail before
execution. Native context supplies accessible task candidates with bounded
cursor pagination. The SAME signed account/process/read-result guard supplies
complete exact original text and confirms the whole frozen batch without owner
proof, neighboring history, attachment reads or read-state mutation. Partial,
changed or oversized reads remain unresolved. Candidate/rules hydration uses
only the native-selected encrypted bundle and current managed recipient; fixed
project sources load that project's exact effective rules through the SAME
instruction builder. No plaintext server fallback or generic payload resolver
is added.

A native `routed` receipt partitions the frozen original UUIDs through
`routes:[{taskId,eventIds}]` and `ignoredEventIds`. Every original occurs exactly
once, and task groups are distinct. Whole-batch legacy `taskId/route` receipts
remain recoverable. Multi-target receipts have no singular task or route. The
same private journal validates the full partition before retaining the terminal
receipt and installs each subset only after ALL target task/source/route checks
and real permanent chat provisioning. Failed/partial settlement reads back the
same immutable receipt, never reruns classification or delivers the whole batch
to its first task. Ignored originals remain unprocessed; an exact body already delivered to the model may independently earn read ACK (schema v18).

After actual exact reads, each task worker commits its own material and explicit
original slots. Conversation binding is optional nonexclusive correlation, never
a prerequisite for material completion or authority for a future reply. Later
batches are classified together again. Processing and provider ACK retain their
independent native guards: read ACK uses complete model delivery, business processing uses selected original reads plus accepted material.

Synthetic SQLite, hook, signed-child and coordinator tests cover this composition;
they do not establish a live Windows/business messenger acceptance.

## Schema v11: closed delivery diagnostics

The SAME delivery row gains nullable `failure_code` and `failure_stage`. The
normal coordinator records an explicit allowlisted implementation code and
`native_claim|native_preflight|native_started|readback` atomically with its
existing uncertain-state transition. `native_started` is observed only at the
one-use invocation boundary; preparing a host/pass claim does not prove that a
Codex process or model turn started. Raw messages, stack traces and arbitrary
code prefixes are never retained. Historical rows gain null metadata without
changing IDs, receipts, leases, events, cursors or native-start fences.

`readAssistantInboxDispatchSummary` is a fixed SELECT-only reader, not the
writable factory. It accepts v10 and v11, performs no DDL/migration/recovery and
returns only aggregate current-task counts plus an optional closed failure.
Unsupported or failed reads are unknown, never empty. Fresh native companies
select exact current Trelio scopes; unresolved device-global delivery/intake
fences stay visible even after that company's removal. No identifier/content is
exported and no queued state is inferred from unknown/unrouted references or a
future cycle. See [background status](assistant-scheduler.md#background-dispatch-diagnostics).


Local-first connection reservations (`available`) are settings only. The native
owner selection precedes their first SQLite registration; discovery filters them
before `externalSourceFor` and `inbox.register`. Login/preparation/restart creates
no source cursor, stream, body read, task wake or ACK. First native `active`
generation follows the existing baseline/dedup/processing protocol unchanged.


## Schema v18: read state at model delivery

Read state is independent of answering, task creation and business completion.
The existing signed reader materializes the COMPLETE frozen message batch;
partial output, metadata-only polls and queued model turns never count. After
native `confirm_assistant_intake_read` succeeds, that same host boundary records
only the exact intake UUID on the original rows in the SAME private SQLite.
Full email RFC822 hashes remain required; no body, sender or reply is persisted.

Native source ACK v2 selects `{intakes:[{intakeId,eventIds}]}`. It rechecks the
current device/source/account/both memberships/project/grant and native confirmed
read, even while the intake is leased or waiting for an answer. No fabricated
task, Workspace Run, material receipt or `processed=1` is required or created.
Upgrade reconciliation reads those SAME native witnesses for retained replied,
created/routed/waiting intakes; local outcome labels never prove reading. Missing
email byte evidence cannot be reconstructed from a native boolean.

The SAME signed/account/provider ACK engine still verifies exact revisions and
contiguous coverage, and fences ONE invocation before launch. The journal latches
its selected intake basis with the ACK lease; a later read cannot replace an
unknown attempt. A started legacy material-based attempt retains its original
receipt/slots and remains verify-only after restart. Source generation changes
also narrow to read-back, never a blind write retry or new-source adoption.
Group originals keep the no-range-ACK policy where skipped discussion would be
marked read. Business processing and accepted goal completion retain their
independent original-slot/material/retirement guards.

## Schema v19: paced native model capacity

An additive `model_capacity_json` column on the SAME delivery stores only the
first observation, latest terminal/marker UUIDs, saturated backoff step/due time
and whether the exact failed marker is waiting. Re-observing that turn cannot
postpone its deadline; restart never resets it. The immutable first failure
remains untouched. SELECT-only diagnostics project the separate CURRENT wait
as a closed capacity code; a started/unknown next attempt loses that special
projection. Capacity continuations reuse the indexed start ledger with a separate
budget key and no attempt cap. Ordinary hook/completion-repair caps remain.
An empty provision uses null passId only in that closed capacity profile and
retains the original chat/claim. No native prose, new task, body, ACK, outcome,
process-liveness claim or reset of any original start bit is introduced.
