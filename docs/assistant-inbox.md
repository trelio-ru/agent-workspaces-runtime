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


The current Trelio coordinator reconciles, polls and acknowledges only sources
whose provider is `trelio`. A successful Trelio company inventory does not revoke
an external source, and an external cursor/ID never reaches the Trelio notification
endpoint. External registration, polling, task mapping and ACK adapters retain
their independent authorization and lifecycle; these guards do not activate them.
