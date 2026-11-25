### One checkout key addresses one starter order

In the neutral starter's host, a repeat of `checkout.create` with the same
`Idempotency-Key` and the same details returns the first order. While it is
unpaid, the repeat also returns a further continuation `token`, so a guest can
pay after a lost response. Earlier tokens stay valid and a repeat sends no mail.
A refreshed quote acceptance for the same stored terms is the same purchase.
Under a version 4 UUID key, changed details answer `starter_checkout_changed`,
`starter_checkout_paid` or `starter_checkout_not_payable` instead of
`starter_command_conflict`, and are never applied. Other key formats keep
`starter_command_conflict`. Under a version 4 key, a create whose draft receipt
was invalidated now answers `starter_checkout_not_payable` instead of
`commerce_order_draft_expired`.

The new `checkout.continuation` operation resumes or abandons the order under
a version 4 UUID key without its details, adding one starter operation. An abandoned order carries the reason `checkout_started_over`. An
order whose creation has not completed can be abandoned only once it is a
minute old; before that the answer is `starter_checkout_in_progress`. A
creation that is still running after that minute can leave a stray provisional
activation on the cancelled order, with no stock hold and no settlement intent,
so nothing is payable. A
fresh create that obtains its key lock more than 15 seconds after the host
received it answers `starter_checkout_request_stale` and writes nothing.

Each repeat and each continuation of a known key adds one attempt-ledger row.
It counts in a separate requester bucket and against `maxPerEmail` for that one
key, never against the buyer's email. A replaced quota callback receives these
calls with the idempotency key `<derived key>:replay:<uuid>` and the contact
`replay:<derived key>`, which is not an address. A fresh create now passes the
derived key, never the `Idempotency-Key` header value, as its idempotency key;
an attempt recorded before the upgrade is therefore counted once more if its
create is retried across the upgrade. A callback that throws refuses the
repeat, and the order is returned without a token. The host now stores the
derived key, `checkout:<64 hex>`, in `clients.metadata.checkout.lastIntentIdempotencyKey`.
`composeNativeBindings` accepts an optional `requesterKey` function that
replaces the socket-peer digest for every quota consumer. It must return a
lowercase 64-hex SHA-256 digest, or `undefined` when the requester is unknown.
A value that is not a function is refused at composition with
`OPENLUP_E_STARTER_REQUESTER_KEY_INVALID`. A returned value that is not such a
digest makes every request answer 503 `starter_dependency_unavailable`, and the
host logs that code to stderr.

Apply the application file upgrade to replace pristine managed files:
`host/purchase-composition.ts`, `host/checkout-attempts.ts`, `host/server.ts`,
`host/bindings.ts`, `host/native-composition.ts`, `host/quote-composition.ts`
and `shared/api.ts`. If it reports a conflict, reconcile your customised files
with the target starter before retrying. Apply the platform forward
`20261128180001_checkout_abandonment_safety_execute_grant.sql` before starting
the updated host: without it, `abandon` of an unpaid order answers
`starter_purchase_unavailable` and nothing is cancelled.

If you own your checkout client, your idempotency keys are now credentials for
unpaid guest orders: make them random version 4 UUIDs, never log them and never
reuse one for another operation. Keep one key for the whole purchase and treat
"no order under this key" as final only after your request timeout plus 15
seconds. A guest key does not survive sign-in or sign-out.

Guest orders created before the upgrade keep the raw key value in
`lastIntentIdempotencyKey` until a later checkout of that contact overwrites
it. Until those orders are paid or expire, that value could address them
through `checkout.continuation`. To remove it sooner, clear
`clients.metadata.checkout.lastIntentIdempotencyKey` for clients with unpaid
guest orders created before the upgrade.
