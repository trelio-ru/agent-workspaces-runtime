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
Current mappings put incoming refs into the SAME task delivery as Trelio mentions
and due cycles. Outgoing/deletion refs are context only; unknown conversations do
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

### Initial unread email in the same stream journal

For a NEW email source with no durable forward position, the SAME signed reader
requires reviewed provider >=2.6.6 and opts into `monitor --unread-backfill`.
Older packages refuse this initialization before account/provider launch with
`ASSISTANT_SOURCE_HISTORY_CAPABILITY_REQUIRED`; existing forward cursors retain
their old passive path and are never reset or silently seeded after an upgrade.

The initial native baseline returns its ordinary forward cursor and a separate
bounded v2 initial-unread cursor. The SAME SQLite `commitPage` transaction stores
the forward position plus one `email-initial-unread/v1` child stream with its
ORIGINAL seed. No schema migration, second queue, message snapshot or credential
store is introduced. Restart/conflict/full inbox retains both positions together.

Child polls use their durable cursor or, only before the first page, that stored
seed. They reuse the SAME signed account/process engine and the existing four
oldest-due source/stream slots per tick across companies. Backlog pages cannot
occupy the worker indefinitely or postpone the independent forward stream.
Terminal history sleeps. Every read keeps the live source generation checks,
original deadline, private path and native routing/processing/ACK boundaries.

Wire validation keeps exact v1/v2 scope/UIDVALIDITY/ceiling bindings and progress;
history refs lie inside the frozen original range. UNSEEN applies only to these
historical pages. New forward UIDs remain independent of read flags, including
messages read on another device. Historical flags are observed per page, not as
an atomic snapshot at enrollment. Already-read/deleted old mail is not claimed
as recovered. Body, address/subject, owner identity and guessed task mappings
still do not enter SQLite, and history capture alone never marks mail read.


## Native MAX through the same source journal

The native registration optionally selects one canonical numeric `maxChatUrl`
(`https://web.max.ru/<signed-64-bit-chat-id>`), including its generation/CAS.
A missing selector preserves the old refusal before provider launch. No title,
handle, default conversation, human catalogue or legacy-session import is used.
Each selected conversation is an ordinary source; no new queue/schema is needed.

Reviewed signed MAX provider >=2.11.0 runs through the SAME account catalogue,
package verifier/cache and subprocess engine. It observes only the same
browser's native history and correlates genuine sender/message IDs with the
selected DOM history. Initial polling requires a complete native unread interval;
subsequent v2 opaque cursor positions are independent of read flags elsewhere.
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
Explicit original processing slots plus accepted material still precede ACK.

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


## Verified owner intake (schema v9)

The SAME private inbox now retains structural `assistant_owner_intakes` records
beside original refs/cursors. Only incoming, original Telegram/MAX refs with a
fresh linked native owner binding become candidates. Poll compares identity
bindings before and after the signed reader; the queue persists the binding UUID,
not a sender ID/body/username. Email never enters this branch. An original native
account/event/revision is initially considered once across configured companies.

Intake provisions/reuses one restricted chat per source/owner binding through the
SAME native Codex adapter and observed session/proof engine. Its taskless pass is
an explicit discriminator, never fabricated task/binding metadata. Only native
context/resolve tools are visible. Private host reads the exact original through
the SAME signed account/process engine, repeats source/pass/owner checks and
confirms native read before returning original text in RAM. Quoted/forwarded,
outgoing, via-bot and mismatched native senders cannot create tasks.

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
from a failed read. Only that positive cancellation and a later explicit source
generation can clone an unfinished original candidate; old receipt remains
immutable, original-event UUID is retained and native global created-event
uniqueness prevents duplicate tasks. A paused waiting question is cancelled by
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
