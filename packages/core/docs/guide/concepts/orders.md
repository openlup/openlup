# Orders

Read order state alongside settlement, shipment and hold records to decide what
can happen next. For store construction, authorization and command replay,
use [Compose order management stores](../how-to/build/oms-stores.md).

## Order state and money

An order status is not a payment status or a shipment status. The shared
`OrderStatus` vocabulary includes `draft` and `failed`, but the native database
order constraint does not accept those values; do not treat the shared union
as a transition sequence for every store. Find the contracts through
[Exports](../reference/exports.md), and check
[Maturity](../reference/maturity.md) and [Limits](../reference/limits.md)
before selecting a store.

Native settlement success requires a `pending_payment` order and changes it to
`paid`; a linked payable subscription cycle becomes `paid` in the same operation.
A failed settlement changes the intent to `failed` and leaves the order
unchanged, allowing another settlement while the order remains payable.
Replaying the recorded settlement key returns its receipt; a new key against
an already settled intent refuses with
`commerce_settlement_record_intent_already_settled`.
Payment evidence and application to local state are separate concerns; see
[Payments](payments.md) and [native payment truth and review](subscriptions.md#native-payment-truth-and-review).

Native shipment advancement does not change the order to `fulfillment_pending`
or `fulfilled`. Read parcel evidence for physical progress rather than waiting
for those order values. Reservation-backed checkout expiry can instead mark an
eligible unpaid order `expired`; see
[checkout recovery](../how-to/build/checkout-recovery.md).

## Cancellation and refund records

Unpaid cancellation applies to `pending_payment`, after checking current payment
evidence; it records `cancelled` and releases the order's held purchase
reservations. The [command boundary](../how-to/build/oms-stores.md#separate-commands-from-reads)
explains payment refusals and late capture review.

Manual mark-refunded changes a `paid` order to `refunded` as an external refund
record. It executes no payment-provider refund, refund notification or accounting
reversal. These order commands do not cancel an active subscription or alter
its schedule; subscription lifecycle remains a
[separate boundary](subscriptions.md#lifecycle-in-durable-storage).

## Holds and returns

A hold is a separate record, not an order status. Active holds block the
fulfillment eligibility evaluator with `active_hold`; releasing a hold does not
bypass its other payment, address, risk, inventory or subscription-cycle checks.
Closing an order as `cancelled` or `refunded` automatically releases
machine-created holds, while human-created holds remain.

A return request has its own `requested`, `approved` or `rejected` state.
Approval and rejection require `requested` for a fresh decision and emit return
intent events; they do not receive goods, restock inventory or execute refunds.
The [return request recipe](../how-to/build/oms-stores.md#record-return-intent)
covers ownership, quantities, reason codes and replay.
Use the [refusal reference](../reference/refusal-codes.md) for code vocabulary.
