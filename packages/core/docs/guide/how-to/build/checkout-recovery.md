# Recover abandoned checkouts and payments

Let customers resume unpaid checkouts, request payment links, or replace
technically expired orders. Compose recovery on your server with your
authentication, routes, screens, localized messages, transport and schedules.

Commerce factories below use `@openlup/platform/commerce/server` in Node.
Install the complete native PostgreSQL catalogue. For maturity, consult the
[platform capability
reference](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/release-gates.json).
The native payment execution and recreation bindings described here use the
sandbox simulator. Their public query executors are structural and require no
database-driver types merely to import or compose these factories. Other payment
channels retain `native_prepared_attempt_store_unsupported`.

Recovery covers one-time purchases and eligible provisional initial subscription
checkouts, before a live subscription exists. Orders with a non-null
`subscriptionCycleId` belong to renewal recovery and refuse these checkout
flows.

## Issue a recovery token for an admitted checkout

Use `generateCheckoutRecoveryToken` and
`createPostgresCheckoutRecoveryTokenPort` only after your server has authorized
the purchase. Caller-supplied identifiers or email addresses are not authority.

Supply a dedicated `PostgresRoleFreeTransactionLane` through
`createPostgresRoleFreeTransactionLane` from `@openlup/platform/data`, with
effective service-role privileges. Methods own READ COMMITTED transactions. Keep
it separate from actor lanes and close it when finished. Missing privileges
produce `checkout_recovery_service_required`.

Call `issue({ orderId, rawToken, expiresAt })`. This adapter ignores `expiresAt`
and derives a bounded expiry from order creation, preserving database
sub-millisecond precision. It locks the order and contact, requiring
`pending_payment`, a contact and no renewal cycle. Ineligible orders or elapsed
deadlines produce `checkout_recovery_order_not_recoverable`. The contact need
not have a customer principal. Store the raw bearer securely and exclude it from
logs; the token table receives only its SHA-256 hash.

New service-issued links leave earlier checkout links live. Reusing the same
hash for the same eligible order returns the original token ID without
reactivating it. Actor-issued checkout links also preserve earlier links.
Renewal payment-case issuance uses its separate rotating issuer, serializing on
the pending order before revocation and insertion. Reusing a checkout hash for
another order produces `checkout_recovery_hash_conflict`.

Use `inspect(rawToken)` for presentation. It prioritizes revoked, expired,
consumed, then active state; consumption maps to `order_not_recoverable`,
unknown states to `unknown`. `validate(rawToken)` returns context only for an
active token on a pending order. PostgreSQL inspection adds `cadenceDays: number
| null`: initial subscription mode and cadence come from stored draft/quote
context and the provisional declaration; one-time cadence is null. Missing
required or contradictory subscription facts refuse, and browser fields supply
none of them. Paid confirmation may still be available through inspection.
Payment admission must recheck current facts. Inspection exposes no customer
email or arbitrary order reader and cannot execute or settle payment. Rehearsal
settlement cannot substitute for observations and verified ingress.

The adapter uses static errors: `checkout_recovery_service_required`,
`checkout_recovery_order_not_recoverable`, `checkout_recovery_hash_conflict`,
`checkout_recovery_response_invalid` and `checkout_recovery_storage_failed`.
Driver details, raw credentials and attached causes are excluded. Construction
installs no schema, grants, reminder producer, mail sender or automatic binding.

## Schedule reminders and expire abandoned checkouts

Create `createPostgresCheckoutRecoveryWaves(executor, policy)` with a restricted
service executor. Set `profile` to an identity unique to the selected mail
transport. Configure `firstOffsetSeconds`, `finalOffsetSeconds`,
`checkoutSeconds`, `recoverySeconds` and `activitySeconds` explicitly. The first
offset must precede the final offset, which must precede the checkout deadline;
durations must be positive integers. Invalid policies produce
`checkout_recovery_policy_invalid`.

Invoke `enqueue(limit, now)` with a UTC timestamp. It queues first and final
reminders for eligible pending checkouts, excluding recent payment activity and
known capture. The payload’s first/final content labels do not change when
you change the offsets; use the content contract in the
[API report](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/api/communications-contracts.api.md) rather than inferring labels from timing. Supply localized copy through
`createCheckoutRecoveryContentFactory` from
`@openlup/platform/communications/contracts`.

Wrap automatic-wave mail with `withCheckoutRecoverySendEvidence(emailPort,
recovery)` from `@openlup/platform/communications`. The final wave requires a
confirmed first-wave acceptance receipt for the same delivery profile. A
processed outbox event alone is insufficient. A captured transport's receipt
proves acceptance by that transport only; never reuse its profile to claim
network delivery. The receipt fingerprint binds event, recipient reference,
template and delivery profile. The wrapper classifies the send outcome before
recording confirmed acceptance, leaving other mail methods and deduplication
unchanged. Receipt-write failure reaches the caller; preserve event idempotency
on retries.

Use `createCheckoutRecoveryWaveJob` from `@openlup/platform/composition` to bind
an enabled predicate, job name, lease duration, batch size and lazy `{ ledger,
enqueue }` binding. Its disabled path constructs no persistence; a refused lease
performs no enqueue. `createCheckoutRecoveryWaveHttpEntry` adds the
method/bearer guard using your secret reader. Register the endpoint and schedule
its invocation in your application.

Run the other operations separately:

- `expire(limit, now)` expires one-time pending orders only when native inventory
  reservation deadlines have elapsed, including retained inventory-sweeper
  evidence. It preserves known success, releases held reservations and captures
  a `commerce.checkout.expired` event atomically. Order age alone is insufficient.
- `sweepInitial(limit, olderThan, now)` compensates eligible provisional initial
  checkouts older than the supplied UTC cutoff. Prior payment attempts, external
  payment references or payment evidence block this sweep. The selection filters stable contact refusals before applying the limit,
  then locks and rechecks before compensation. It emits a recovery notice without
  ordinary cancellation mail. Compensation marks initial abandonment; it does
  not cancel a live subscription.
- `reconcile(limit, now)` adds missing expiry events for eligible expired orders
  and marked initial abandonment.

Expiry notices omit the token and token insertion when the order-based
`recoverySeconds` deadline has elapsed. Earlier links are retained. Expose
`subscriptionActivationAbandoned` in your expired-mail lifecycle reader only for
the durable sweep marker together with compensated activation.

## Give an operator a payment link

Bind `createAdminCheckoutPaymentLinkHandler` to `authorizeAdmin`, `respond`,
`orderPort`, `tokenStore`, `policy` and commercial `validateRecreate`. Use
`createPostgresOperatorCheckoutLinkStore` with a restricted service executor
whose calls commit separately, preserving admission and completed effects after
failure. Do not wrap the entire command in one transaction. Choose explicit
policy lifetimes; neutral examples are `operatorLifetimeMs: 3600000` and
`recoveryWindowMs: 86400000`. Bind the same recovery window at redemption.
Construction installs no feature flag, scheduler or operator UI.

Authorize an active human administrator through your operator session; machine
and control principals refuse. Send a POST body containing `orderId` and
optional `delivery: "copy"` or `delivery: "email"`.

Pending orders qualify without repricing. For expired orders, supply canonical
technical-expiry, frozen quote and destination facts and bind
`validateRecreate`; the callback is optional in the API, so omission skips
commercial validation. Manual cancellation and renewal cycles do not qualify.
Persisted initial-checkout mode selects subscription mail copy without a native
cycle. Refusals include `order_not_found`, `order_paid`, `order_cancelled`,
`order_not_recoverable` and `order_changed`.

Set positive `operatorLifetimeMs` and `recoveryWindowMs` in `policy`, and use
the same recovery window at redemption. Expiry is the earlier of issuance plus
operator lifetime and order creation plus recovery window. An elapsed deadline
returns `order_not_recoverable` without inserting a token.

The command records admission, revokes same-order links, mints, optionally
queues email, then records the outcome and last stage: `none`, `revoked`,
`minted` or `email_queued`. Failed admission changes no token. A failed mint
after revocation can leave no live predecessor. Concurrent operators can leave
multiple live links; a later operator command revokes them, while
service/customer issuance preserves them.

`copy` is the default and returns the raw token with `emailQueued: false`.
`email` queues `commerce.checkout_recovery` with `operatorIssued: true`, source
`admin_payment_link`, and key `checkout_recovery:operator:<token-id>`.
Re-enqueue adds no second event; queue failure reports `UPSTREAM_UNAVAILABLE`.

## Add customer recovery entry points

For signed-in account recovery, bind `createCheckoutRecoveryStartHandler` to
`recoveryEnabled`, `authenticateUser`, `createPort`, `respond` and `lifetimeMs`.
Use `createPostgresCustomerCheckoutRecoveryStartPort` on that customer's actor
executor. PostgreSQL derives ownership from `auth.uid()`.

The POST body accepts exactly `{ orderId }` or `{ subscriptionId }`. For an
initial subscription checkout, use the provisional `activationId` as
`subscriptionId`. Selection uses the exact owned pending order or newest
eligible declaration order. An initial declaration or persisted subscription
checkout context selects subscription presentation without admitting renewals.
Flag and session checks precede port construction.

Set `lifetimeMs` explicitly to a positive safe integer at most `86400000`.
The deadline is order creation plus that lifetime, and the database rechecks it
after blocking writes, rolling them back if the deadline elapsed. A successful
start returns a fresh raw token for navigation and sends no mail. An elapsed
deadline or terminal checkout returns `recoverable: false` with `fresh_checkout`
or `customer_account` fallback. Earlier checkout tokens remain live until
expiry, payment or operator revocation.

For a buyer's “email me a payment link” action, bind
`createCheckoutPaymentLinkHandler` to your continuation codec and a lazy
`createPostgresBuyerCheckoutLinkPort` using a service executor. Only
`verifyCookieHeader` claims authorize the order and client. Missing, invalid or
expired cookies produce `continuation_missing` before persistence is
constructed; body identifiers and recipient addresses supply no authority.

The service issuer locks the order and admits pending non-renewal checkout only.
Configure the buyer port's `lifetimeMs` and positive `sendBucketMs`; neutral
examples are `86400000` and `600000`, respectively.
Bucket admission deduplicates the
`checkout_recovery:buyer:<order>:<bucket>` event and token atomically; a
duplicate inserts neither. Later buckets preserve earlier links. `{ sent: true
}` means queued or deduplicated; only the port's `queued` identifies a new
insertion. Neither response proves transport delivery. A terminal mint race
reports `order_not_recoverable`; other mint failures report `mint_failed`.

Route the reminder producers through
`createOutboxCheckoutRecoveryEmailHandler`, with the appropriate scoped
`authorize(eventId, claimToken)` gate: waves, operator store or buyer port. Each
gate checks its own event and authority. The operator gate requires its exact
token to remain live and bound to the claimed order and client; it cannot
replace the automatic-wave gate. Buyer events carry `buyerRequested: true` and
source `buyer_payment_link`. They bypass the fresh-payment-session courtesy
deferral, while missing or paid orders still suppress mail. Bind recipient
resolution, localization and transactional transport in your application.

## Inspect a link before showing recovery controls

Compose `createCheckoutRecoveryInspection` with the token port,
`createPostgresCheckoutRecoveryOrderPort` on a service executor,
`clientHasLiveOrPendingSubscription` and your commercial validation policy. Use
`createCheckoutRecoveryValidationPolicy({ supports, validation })` to reject
unsupported frozen content before commercial validation. Reuse `supports` for
recreation.

Call `inspect({ token, capabilities })` and render its decision:

| Result | What to show |
| --- | --- |
| `recoverable: true`, `recoveryKind: "retry_existing"` | Continue the current payable order |
| `recoverable: true`, `recoveryKind: "recreate_expired"` | Offer an independently authorized replacement command |
| `terminalStatus: "paid"` | Confirmation without payment controls, using `paidOrder` when available |
| `terminalStatus: "cancelled"` or `"order_changed"` | The returned account or fresh-checkout fallback |
| Other `recoverable: false` | The returned fallback |

Include `recreate_expired_order` in `capabilities` to opt into expired recovery.
Without it, clients retain fallback behavior and payable orders need not carry
`recoveryKind`. Expired tokens may expose validated expired context, but cannot
resume a pending replacement. Only `active` and `order_not_recoverable`
inspection states permit continuation; revoked, used or unknown authority
refuses before descendant reads. The order reader returns the bound original or
the root's latest-created descendant; both must match the token's client. An
initial subscription replacement requires a compensated declaration; inspection
reopens neither its predecessor nor a live subscription.

Include `resolve_active_payment` separately to invoke the injected payment
resolver. If no resolver is bound, that opt-in returns `awaiting_provider`.
Inspection performs no recovery writes and grants no payment authority.
Authorize and recheck later mutations independently.

## Recreate a technically expired checkout

Bind `createExpiredCheckoutRecoveryService` to an independently authorized
order/client. Supply `supports`, `quoteRequest`, quote and draft ports, recovery
writer, payment safety, runtime and compensation. Unsupported snapshots validate
as false and recreation returns `unavailable` before side effects.

Require a frozen quote, an owned destination and prior payment evidence.
`ExpiredCheckoutPaymentSafetyPort.verifyPriorPayment` must read the actual prior
payment object: success returns `paid`; confirmed terminal non-settlement with
matching money returns `safe`; missing, unknown, pending or failed reads return
`unavailable`. Absence of local success is insufficient. The sandbox binding is
`createPostgresSandboxExpiredCheckoutSafety` from `@openlup/platform/payments`.

Build opaque quote-request extensions from trusted persisted data. The service
passes persisted `pricingPolicy` and `offerVersion` to quoting and compares the
commercial fingerprint, excluding transient quote IDs and timestamps. Drift
returns `order_changed` before draft creation. Frozen offer evidence is
retained.

Wrap draft persistence with `createPostgresExpiredCheckoutDraftPort`; use
`createPostgresExpiredCheckoutRecoveryPort` for lineage. The stable key is
`checkout-recovery-recreate:<sourceOrderId>`. Replay preserves the accepted
draft when only quote identity changed. Preparation allows a unique immediate
replacement, including replay after compensation, and never reparents it.
Preparation locks source and replacement, checking payment evidence and the
recovery deadline after waiting for locks. Exact linked replay precedes fresh
admission checks.

Bind `createPostgresExpiredCheckoutRuntime` to a dedicated READ COMMITTED lane.
Bind `verifyPriorPayment`, reservation and payment callbacks to its executor,
using `createPostgresPurchaseReservationPort` from `@openlup/platform/inventory`
and the native simulator. Set `stockSourceKey`, `channelKey` and
`reservationLifetimeMs`. Use `checkoutRecoveryExecutionFingerprint` for
execution identity. Keep remote dispatch outside this transaction.

The runtime locks the source order before the replacement and source intent,
then rechecks prior payment before stock
or payment writes, even with an existing replacement intent. Racing source
success returns `paid` and triggers compensation. Recorded buyer snapshots are
preserved without inventing an absent `invoiceBuyerSnapshot` key. A nonempty
runtime snapshot takes precedence; recorded empty objects remain explicit. When
there is no snapshot, first-duty invoice capture can select the owned billing
profile/address and then the marked shipping fallback. Later profile edits do
not change captured buyer facts.

Initial recreation makes a new provisional declaration, leaving its predecessor
compensated and live subscriptions untouched. It creates no renewal cycle. Use
`createPostgresExpiredCheckoutCompensation` for guarded cancellation and
unstarted cleanup; dispatched or uncertain payments block cancellation. A
compensated replacement keeps its lineage and permits no sibling. Handle
`ExpiredCheckoutRecoveryError.reason`: `paid`, `order_changed` (including stock
refusal), `unavailable` or `execution_failed`. Other purchase profiles need
their own admitted runtime port. These factories supply no route, UI or token
issuer and establish no real-service qualification. A live subscription is
created only by a later successful captured-payment activation.

## Show payment recovery guidance from one snapshot

Compose `createPostgresPaymentRecoveryGuidancePort` with a service executor and
`normalizeSandboxPaymentRecoveryEvidence` from `@openlup/platform/payments`. Use
a fresh READ COMMITTED statement: one
`commerce_checkout_payment_guidance_snapshot` call reads status, provenance,
authority and evidence without materializing destinations, issuing tokens or
changing payment state. A draft receipt and frozen checkout context establish
one-time provenance; an initial subscription also needs its declaration.
Renewal-cycle orders are ineligible.

History probes a bounded number of attempts and evidence members, returning
attempts newest first. Overflow, contradictory proof or an oversized envelope
drops that attempt’s whole proof set and marks history incomplete. Observation
records and truth/readback source envelopes have bounded sizes; consult the
[API report](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/api/commerce-server-postgres.api.md) and its linked implementation
for the limits. Only correlated identity/outcome fields are projected; raw
source envelopes, request keys, token hashes and opaque authorization/method
references are excluded. Native states map to the Core attempt vocabulary and
Core derives the public actions. These observations establish neither
method-specific advice nor a reusable payment method.

Call `readAuthorizedPaymentRecovery` with a validated bearer or verified
continuation claims. Cookie claims bind journey/order/client/intent and must
match the snapshot's current attempt and rail. Token authority is rechecked in
the snapshot against the exact order/client, expiry, revocation and pending
state; earlier validation cannot bypass it. The token dependency needs only
`validate`. Fall back to the legacy reader for missing authority, read failure
or malformed data; a snapshot with dead authority carries null guidance.

Opt in with `X-Payment-Recovery-Guidance: 1` and preserve the legacy response
without it, as in the [status-handler
composition](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/server/domains/commerce/commercePaymentStatusHandler.ts).

Render returned actions without inferring method-specific advice: native
observations prove generic refusal, with method, operation and advice unknown.
Exactly linked capture suppresses refusal guidance and `projectGuidance` before
settlement converges, without declaring the order paid. Guidance authorizes no
new payment. Supply `projectGuidance` only to preserve your existing display
fallback; it cannot turn observed success into refusal advice. Exactly linked
capture suppresses advice even when its attempt falls outside returned history.

## Retry payment with a recovery token

Bind `createCheckoutRecoveryPayService` to
`createPostgresSandboxCheckoutRecoveryAttemptPort` from
`@openlup/platform/payments`, using a READ COMMITTED service executor. Wrap the
service with `withCheckoutRecoveryPaymentHold`, then pass it with the token and
order ports to `createCheckoutRecoveryTokenPay`.

Call `pay({ token, idempotencyKey, method, followLatest })`. Order and client
identity come from the token. Set `followLatest: true` only when you intend to
follow the recovery root's latest order: inspection must establish continuation
authority and original ownership. Expired inspection alone cannot pay a
replacement; use the separate recreation command.

Payment retry uses the existing order, intent and stock reservation. The native
reader's `pending` projection means a created intent; the attempt owner fences
unresolved dispatch under locks. Under order/intent locks, native admission
rechecks token expiry/revocation, checkout provenance, money and captured
observations. A capture blocks another dispatch before settlement converges.
Repeating the same key and fingerprint returns its attempt; changed method facts
under the same key refuse. After a terminal failure, use a fresh per-click key
to select another synthetic method.

Handle `CheckoutRecoveryPayError.kind`: `conflict` includes dead authority and
unrecoverable orders; `upstream_unavailable` includes in-flight or uncertain
execution. Known payment refusal remains a recoverable `failed` result. Invalid
local method facts roll back before dispatch, allowing correction. Money results
come from observations and verified ingress, never from a browser result or
rehearsal shortcut. The sandbox owner records dispatch atomically with attempt
creation, without a separate external preparation/finalization phase.

Inject hold reads, method classification, offered methods and first-purchase
evidence. A one-time order without a subscription is treated as a first
purchase; subscription context needs evidence that it was never live from your
first-purchase lookup. A matching hold withholds only orders created strictly
after it (`payment_method_withheld`). Recreated orders, foreign-root chains and
renewal cycles bypass holds. Your application owns control keys, the
offered-method policy and the hold trigger. Failed reads, unknown first-purchase
evidence or holding every offered method permit payment. Reuse this policy for
fresh inline retries.

## Retry the exact failed attempt inline

Compose `createCheckoutInlineRecovery` with your continuation codec and exact
cookie name, the atomic guidance port, order reader and
`createPostgresSandboxInlineRecoveryAttemptPort` from
`@openlup/platform/payments`. Supply `methodKeyFor` to map synthetic method
facts to explicit method keys, and `executionAllowed` for offered methods and
purchase contexts. Unknown identities refuse; opaque method references imply no
method or refusal category. Pass the same `hold` dependencies used for token
payment.

Call `retry` with the cookie header, journey/order/client/intent,
`expectedPaymentAttemptId`, `retryRequestId`, `executionRail`, `methodKey` and
`method`. The signed cookie must match the exact predecessor before durable
reads. A bearer header cannot authorize this path. A missing or mismatched
cookie produces `continuation_required`.

Fresh retry requires the exact failed attempt and failed intent on a payable
one-time or provisional initial checkout. Previously live subscriptions refuse.
Staying with the same method requires `change_instrument` or `correct_data`
without a method-wide prohibition; switching methods requires `change_method`.
`authenticate` alone is insufficient. Disallowed actions produce
`recovery_action_not_allowed`; host execution policy can refuse with
`recovery_execution_not_allowed`.

`checkoutInlineRecoveryTransitionKey(expectedPaymentAttemptId)` yields
`checkout-inline-recovery:<expectedPaymentAttemptId>`. Keep the retry nonce
(`retryRequestId`) and selected rail unchanged when retrying a lost response.
The native prepare key appends `:payment-execution:prepare-attempt`; its request
key and server-computed fingerprint bind transition, nonce and rail without a
separate nonce ledger. The native owner compares the exact predecessor under
locks and fences
cancellation and capture. Retry creates no order, intent or reservation.

Replay binds the replacement to the transition, nonce and rail, without
redispatch or fresh execution/hold policy. Method input adds no comparison.
Failed replacements return failure; live replacements permit action readback or
safe polling when readback lags. Native intent status may still describe the
previous refusal while its replacement is dispatched; the durable replacement
attempt supplies the processing result. Transient codes add no replay
comparison.

On every successful response, write the returned `setCookie` as the response's
`Set-Cookie` header and expose only `result` as the response body. The new
cookie binds the replacement attempt and rail. Reusing the old predecessor with
it refuses; a later failed replacement can become the next exact transition.
