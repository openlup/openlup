# Payments

Use canonical payment facts to decide whether a purchase has been paid and what
the customer needs to do next. Keep the payment intent, an individual attempt
and a saved payment method distinct.

## Canonical status

A payment intent records the local payment obligation and its money; an attempt
records an execution against that intent. Their statuses come from
`PaymentIntentStatus` and `PaymentAttemptStatus` in `@openlup/core/payment`.
A provider's status belongs at the adapter boundary: verify its evidence,
translate it into a neutral outcome, then apply the payment domain's transition
rules. Never use a provider status directly to settle local state. A provider
string alone establishes neither the active local attempt nor matching money,
and it bypasses the rules that protect an already recorded success.

The verified ingress maps normalized money events as follows:

| Event | Local result |
| --- | --- |
| `payment.succeeded` | `succeeded` |
| `payment.failed` | `failed` |
| `payment.refunded` | `refunded` or `partially_refunded`, according to refund evidence |
| `payment.disputed` | `disputed` |

`payment.requires_action` is a request for customer action, not settlement.
Method registration and other `setup.*` events do not apply a money result.
A browser return or provider silence never proves payment. Readback must identify
the exact attempt and expected money; timeout, truncation or indeterminate
evidence remains `unknown`, which does not authorize another charge.

`applyProviderPaymentEvent` checks that the attempt belongs to the intent and is
its active attempt, refusing `wrong_attempt` otherwise. Asserted currency or
charge-amount mismatches return `currency_mismatch` or `amount_mismatch`.
An illegal transition returns `invalid_transition`. This core function computes
a decision; the application must persist it and the event identities used to
recognize repeats.

Ordering follows the payment rules, not arrival order. An event ID supplied in
`seenProviderEventIds` yields `noop` with `duplicate_provider_event`. A matching failure
after success, refund or dispute is ignored. Matching late success can recover
a failed or expired intent as `late_success_recovered`; success after a cancelled,
refunded, partially refunded or disputed intent refuses `terminal_intent`.
Failure and expiry therefore do not mean that a later positive payment fact can
be discarded.

Refunds require a prior successful intent (`refund_requires_success` otherwise).
The default verified ingress also requires refund kind, payment identity,
positive money and currency before applying a refund result. The normalized
refund observation carries the original money and a stable operation identity;
missing evidence must not be guessed into a full refund.

The payment transitions exported from `@openlup/core/payment`
(`transitionPaymentIntent`, `transitionPaymentAttempt`,
`applyProviderPaymentEvent`) and the
[verified evidence contracts](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/src/payments/contracts/evidence.ts)
define these separate boundaries. Other commerce domains have their own status
types; do not substitute payment statuses for them.

Retain bounded diagnostic evidence inside the adapter and map provider facts
once; diagnosis must not weaken transition refusals or allow late evidence to
regress a terminal canonical fact.

## Dispatch and settlement

`PaymentExecutionEnvelope` separates an attempt outcome from dispatch evidence.
An attempt can be `sent_to_provider`, `requires_action` or `processing`;
execution does not itself report terminal money success. A synchronous decline
carries a neutral refusal. It does not by itself prove that dispatch never
happened: only `notDispatched` with exact `before-dispatch` evidence makes that
claim. An uncertain dispatch stays `unknown`.

A redirect or client-confirmation handoff tells the host how to continue the
interaction, not whether money settled. Client-confirmation payloads and customer
authorization are transient secrets: do not persist, log or fingerprint them.
Keep only explicitly redacted diagnostics. See the
[execution contract](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/src/payments/contracts/adapter.ts)
and [idempotency](idempotency.md#idempotency-contract) before retrying an attempt.
