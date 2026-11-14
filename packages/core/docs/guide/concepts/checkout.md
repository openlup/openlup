# Checkout

Turn a buyer's selected items and contact details into an
accepted quote, an order and payment interaction. Keep the checkout journey
distinct from an individual payment attempt.

## Journey and admission

The configurator intent carries selected variants, quantities, purchase mode,
cadence, promotion codes, contact, address and an `idempotencyKey`. The checkout
handler admits a request before persisting its identity or creating an order.
Admission validates the request, applies delivery and offer prerequisites,
checks rate limits and optionally consults a risk blocklist. Initial
subscription checkout requires explicit enablement and otherwise refuses with
`subscription_checkout_contract_disabled`. Unavailable rate-limit or risk
checks stop admission with `rate_limit_unavailable` or `risk_check_unavailable`.

The host supplies schemas, policies, ports and response handling; route mounting
remains application-owned. Consult
[configuration](../reference/configuration.md), [exports](../reference/exports.md)
and [maturity](../reference/maturity.md) for the selectable boundaries.

## Accepted money and persisted order

The quote guard recomputes the authoritative quote and checks supplied
expectations and required promotion acceptance. A changed total or invalid
required acceptance returns `price_changed` before order orchestration.
See [catalogue and prices](catalogue-and-prices.md) and
[Read prices for a quote](../how-to/build/quote-prices.md) for price selection.

The orchestrator passes the accepted quote snapshot to the order writer. The
runtime finalizes the order, reserves inventory and opens a payment intent
before execution. These separate port calls do not form an atomic transaction
around a payment provider.

## Attempts and payment hand-off

The journey key links the order, inventory and payment work, while the runtime
can derive a fresh execution identity from the payment-attempt sequence.
See [idempotency](idempotency.md) for replay boundaries.

A redirect or client confirmation continues payment interaction; it is not
evidence of settlement. An unresolved dispatch must remain unresolved until
payment evidence permits another action. [Payments](payments.md) owns intent
and attempt states, verified results, transient secrets and late success.

## Expiry and recovery

Checkout expiry and recovery-link expiry are separate decisions. The native
one-time expiry sweep uses elapsed inventory reservations and checks recorded
capture evidence before expiring an unpaid order and releasing held stock.
Initial subscription abandonment uses a separate provisional-activation sweep
that excludes orders with prior payment attempts or external payment evidence.
Constructing the recovery-wave adapter starts no scheduler.

Recovery inspection is read-only presentation, not payment authority. Existing
order retry and expired-order recreation are separate paths: recreation checks
prior-payment safety and a fresh matching quote before preparing a replacement.
The supplied native recovery attempt adapters use the sandbox rail; other rails
refuse with `native_prepared_attempt_store_unsupported`.

Use [Recover abandoned checkouts and payments](../how-to/build/checkout-recovery.md)
for token authority, reminder scheduling, retry and recreation composition.
Consult [refusal codes](../reference/refusal-codes.md) and
[recovery limits](../reference/limits.md#expired-checkout-recovery-and-order-holds)
when deciding which continuation to offer.
