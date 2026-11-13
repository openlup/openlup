# Deliver events with the outbox

Deliver durable events through application-owned handlers while retaining work
across retries. Compose the store, handlers and host entrypoints explicitly.

## Install and enqueue

Follow the [tutorial](../../start/tutorial.md) for a runnable enqueue and dispatch
example. The outbox package's [PostgreSQL installation and transactions](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/outbox/README.md#postgresql-installation-and-transactions)
section owns baseline installation, transaction boundaries, ordering and storage
retention. Apply its SQL through your migration chain; importing the package
runs no migration.

Keep domain writes and `buildOutboxEnqueue` in the same producer transaction.
Give `createPostgresOutboxStore` an executor that commits each operation before
resolving, separately from that producer transaction. See
[idempotency](../../concepts/idempotency.md#handler-effects-across-retries) for
enqueue identity, acknowledgement loss and handler replay.

## Select and compose handlers

Supply an `OutboxHandler` for each event type your invocation processes.
`uniqueRegistry` combines handlers sharing an event type through
`composeHandlers`; the composed timeout is the sum of its component timeouts.
When both components return `processed`, their nested result details are retained;
selected delivery metadata also appears at the top level, with the first
component taking precedence.
Composed components receive the row and abort signal, without the transient
execution context. Each component must protect its own effect across replay.

Use `withPayloadSchema` when an application handler needs payload validation.
Validation issues return `retry` with reason `outbox_payload_invalid`; handlers
without this wrapper retain their existing behavior.

The worker derives its claim allowlist from registry keys. An empty registry
returns `outbox_registry_empty` without claiming work. Supply `knownEventTypes`
from the event vocabulary your application recognizes, independently of the
enabled handlers. Pass the vocabulary entries' `eventType` strings.
An unknown, non-dormant predecessor blocks its aggregate;
a known type outside the current allowlist can remain pending while later work
proceeds. This does not acknowledge or deliver the skipped type.

Core's `PLATFORM_EVENT_VOCABULARY` includes `commerce.settlement.settled`.
Selecting that vocabulary can retain an unhandled settlement event while a
later paid receipt proceeds for the same aggregate. Readiness still requires
an owned `ignored` or `dormant` exemption for a selected unhandled type.
The communications vocabulary also includes
`commerce.checkout.recovery_qualified.v1` and `communication.ecommerce.export.v1`.
Keep export and commerce handler invocations on disjoint allowlists. See
[checkout recovery](checkout-recovery.md) for reminder composition. Vocabulary
entries start no worker.

## Bind scheduled or immediate dispatch

Read settings with `readOutboxDispatchConfig`; the package's
[dispatch configuration and optional diagnostics](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/outbox/README.md#dispatch-configuration-and-optional-diagnostics)
section owns prefixes, parsing, defaults and queue observations.

For scheduled dispatch, call `createOutbox` with the store, `JobLeasePort`,
inert handler descriptors and `buildHandlers`, plus configuration, known event
types, host execution limit, lease duration, cadence and the selected adapter's
`requiredSchema`. Disable pruning explicitly when no compactor is bound.
The factory validates scheduled configuration before returning a contribution;
the lease must cover the full host execution window, including finish time.
It provides no lease-renewal loop.

Handlers are built after lease acquisition. Until the builder returns a
`HandlerScope`, it owns cleanup of partially acquired resources. The returned
scope closes after the finish attempt, including failure. The built registry
must match descriptor event types and effective timeouts before any claim;
a mismatch reports `outbox_registry_descriptor_mismatch`.

A `beforeDispatch` hook can return observation metadata. Reserved run identity
and worker counters override that metadata. A resolved negative business
observation does not itself prevent dispatch; a thrown hook prevents claims
and attempts a failed finish. Observe `finishApplied`: a refused finish returns
a failed schedule result, and a thrown finish error propagates. A scope-close
failure is logged without turning accepted effects into retries.

For an immediate invocation, call `runOutboxDispatchWorker` with a committed-operation
store, registry, configuration and explicit known vocabulary. It acquires no
job lease. Both entry styles need handlers that honor cancellation and enforce
[effect idempotency](../../concepts/idempotency.md#handler-effects-across-retries).
Storage errors propagate; PostgreSQL claims not started in an interrupted run expire
rather than being falsely settled.

## Observe the selected schema

Use `POSTGRES_OUTBOX_SCHEMA` for the default PostgreSQL adapter; a different
adapter supplies its own requirements. `createSchemaProbe` invokes the host's
identity callback and SQL executor. For a grouped catalog read, use
`buildGroupedPostgresSchemaProbe` and `decodeGroupedPostgresSchemaRows` from
`@openlup/core/readiness`. The builder returns bound SQL without executing it.
Tables must be ordinary or partitioned; column names split at the final dot and
exclude system or dropped attributes. Functions resolve by exact signature;
an omitted signature means no arguments. PostgreSQL owns name resolution and
invalid-name errors. Duplicate requests retain separate ordered ordinals, and
an empty request produces a valid empty read.

The decoder requires ordered integer ordinals, boolean `present` and `shape`.
Absence requires SQL `NULL`; presence requires JSON text decoding to a nonnull,
nonarray object. Parsed driver objects, missing or extra rows, reordered
ordinals and inconsistent shapes throw `Invalid grouped PostgreSQL schema rows`
without catalog bodies. Extra row columns are ignored. Parsed property and
nested array order remain intact; inputs are not mutated.

Shapes retain catalog nulls and PostgreSQL's parsed JSON ordering. Use the
[grouped-probe source contract](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/core/README.md#channel-and-stability)
for exact shape fields and aggregate ordering. The host owns its driver, connection role, snapshot,
independently observed database and migration identity, digest policy and
invalidation. Catalog shapes establish neither SQL behavior nor effective
authorization or recovery. Map driver and decoder failures to an unknown
observation; the grouped helpers add no retry, transaction or deadline.

## Admit and bind the candidate

Pass the contribution, actual installed package metadata, selected-adapter
schema observations and bindings to the exact returned schedule functions to
`checkReadiness`. Logical module dependencies must use the same or an earlier
layer: kernel, rail, capability, implementation. Follow
[check readiness](../../upgrade/README.md#check-readiness) for the host-owned
admission decision. Descriptors are inert; importing or constructing a
contribution activates no host trigger.

`assertOutboxStoreFences` from `@openlup/outbox/testing` checks stale-token
refusal against a real processing row supplied by your application. It does
not replace transaction and replay verification for the actual adapter.
Preserve producer payloads, pending obligations and recovery behavior when
[upgrading](../../upgrade/README.md).

## Retain terminal work safely

To schedule compaction, bind `createPostgresOutboxCompactor` or a compatible
`CompactionPort`, and enable `prune` with its cadence and retention settings.
Compaction clears eligible terminal payloads and errors while retaining rows
and unique enqueue keys. Its defaults and eligibility rules are in the
[installation and transaction contract](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/outbox/README.md#postgresql-installation-and-transactions).
Keep `metadata.retainPayload=true` while an unresolved downstream obligation
needs the original payload; clear it only after durable handoff or resolution.
The hint grants no recovery or erasure authority. Application delivery and
ledger retention remain application-owned.
