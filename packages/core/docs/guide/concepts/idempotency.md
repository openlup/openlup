# Idempotency

Keep a retry from creating another business effect when a response is lost or
an event is delivered again. Choose the key and replay rules of the particular
operation before calling it.

## Idempotency contract

An idempotency key names a logical operation within a scope. A request fingerprint
binds that identity to the effect's contents where the operation implements that
check. Retain the same key and contents across a retry. Do not reuse a key for a
different request, and do not mint a new key merely because the previous result
is unknown: the first call may already have acted.

Scopes differ. A domain command, a provider attempt and an inbound event need
separate identities. For example, `buildProviderAttemptIdentity` in
`@openlup/core/payment` derives the provider key from namespace, provider, payment
intent and local execution key. Its separate fingerprint includes provider,
intent, amount, currency, mode and order reference. The adapter passes the host's
attempt identity, key, fingerprint and configured money through; that contract
does not replace a durable host ledger or prove provider-side deduplication.

Treat keys as opaque identities within their documented scope. A customer
journey can need its own identity alongside command, attempt and inbound-event
keys; do not collapse them into one user-controlled value. Commit the durable
ledger before reporting success, using the operation's concurrency protocol to
converge repeats on its canonical effect.

Replay guarantees are operation-specific:

| Boundary | Identity and behavior |
| --- | --- |
| Outbox enqueue | `(event_type, idempotency_key)` keeps the existing event; a repeated insert returns no new row |
| Catalog draft command | `(draftId, commandKey)` returns the original revision when fingerprint and actor match |
| Native bundle write | A non-null key is global across bundle write events; a recognized key short-circuits without comparing the new payload |
| Marketing sync | Binding, operation, subject and request ID identify a request; changed audience or payload refuses `invalid_request` |

For catalog drafts, changed contents under an existing key return
`conflict/command_key_reused`; a different actor returns
`unauthorized/operator_mismatch`. A new command against the wrong revision
returns `conflict/revision_conflict`. The outbox has no equivalent payload check:
changing its aggregate or payload under the same event type and key does not
replace the stored event or produce a fingerprint conflict.

Native bundle writes also do not provide a payload-bound replay receipt.
A later call can recognize a key used by another bundle or routine before
validating the changed request. Concurrent first uses on different bundles can
instead collide at the unique index with SQLSTATE `23505`, rolling back the
losing transaction. Do not interpret key recognition as proof that the new
payload was accepted. Unkeyed bundle writes have no such deduplication.

The practical guarantee is bounded by the operation's stored identity and
receipt. It is not a universal exactly-once guarantee. Where a result remains
uncertain, reconcile its recorded effect before starting a new logical operation.

### Handler effects across retries

`buildOutboxEnqueue` from `@openlup/outbox` builds the insert; it does not commit
it. Execute it in the same transaction as the domain write so that the write and
its event commit together. The worker store uses separate operations that commit
before returning; do not hold the producer transaction across handler I/O.

The worker invokes the handler before acknowledging the event. If the effect
finishes but acknowledgement fails, or a processing lease expires, a later run
can invoke the handler again. Design each handler effect to recognize a stable
event-derived operation key in its own durable store or provider contract.
The worker's claim token protects acknowledgement ownership; it does not undo
an external effect. A stale token cannot mark the event processed.

`composeHandlers` runs the second handler only after the first returns
`processed`. If the second asks for a retry, the next invocation starts with the
first again. Both effects need replay protection. Respect the handler's abort
signal: a timeout reports `outbox_handler_timeout`, but cannot roll back a
request already sent or forcibly stop code that ignores cancellation.

## Related reading

See the [enqueue implementation](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/outbox/src/enqueue.ts),
[worker](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/outbox/src/worker.ts)
and [catalog draft command protocol](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/sql/20260908100000_catalog_draft_foundation.sql).
[Marketing sync](marketing-sync.md#replay-and-uncertainty) explains its generation
fence and unresolved dispatch behavior.
