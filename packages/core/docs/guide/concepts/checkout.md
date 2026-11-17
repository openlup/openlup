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

### Inventory reservation lifetime

In the next minor release (currently unreleased), `reservationPolicyFor(input, policy?)`
and `normalizedTtlMinutes(value, policy?)` from `@openlup/platform/inventory`
accept a `CheckoutReservationLifetimePolicy` with `minMinutes`, `maxMinutes` and
`defaultMinutes`. Omission preserves the 1440–2160-minute clamp and 1440-minute
fallback. Each call validates positive safe integers and
`minMinutes <= defaultMinutes <= maxMinutes`; invalid policy throws
`reservation_policy_invalid`, including for non-checkout kinds.

For `checkout_payment_window`, positive finite TTL input is floored and clamped;
missing, non-finite or non-positive input uses `defaultMinutes`. Other kinds
retain null expiry and TTL. For example, `{ minMinutes: 10, maxMinutes: 60,
defaultMinutes: 30 }` permits a shorter checkout window. Pass the calculated
`expiresAt` to the purchase reservation port when creating a fresh hold.

The native purchase port persists that expiry. Later reads and matching replay
retain it after configuration changes; replay must carry the original command's
expiry. Recomputing it with a changed policy conflicts with the original keyed
input. Native SQL requires a finite future expiry for a fresh hold and imposes
no 1440–2160-minute clamp. An explicit `expiresAt` bypasses this TS helper; null
at the native purchase port selects its existing 30-minute SQL fallback.

### Checkout recovery

Checkout expiry and recovery-link expiry are separate decisions. The native
one-time expiry sweep uses elapsed inventory reservations and checks recorded
capture evidence before expiring an unpaid order and releasing held stock.
Initial subscription abandonment uses a separate provisional-activation sweep
that excludes orders with prior payment attempts or external payment evidence.
Constructing the recovery-wave adapter starts no scheduler.

Recovery inspection is read-only presentation, not payment authority. Existing
order retry and expired-order recreation are separate paths: recreation checks
prior-payment safety and a fresh matching quote before preparing a replacement.
The starter's recovery actions select the sandbox rail; unconfigured real-provider
actions refuse with `native_prepared_attempt_store_unsupported`. The native
provider attempt ports require explicit host composition; see [payments](payments.md#dispatch-and-settlement).

Use [Recover abandoned checkouts and payments](../how-to/build/checkout-recovery.md)
for token authority, reminder scheduling, retry and recreation composition.
Consult [refusal codes](../reference/refusal-codes.md) and
[recovery limits](../reference/limits.md#expired-checkout-recovery-and-order-holds)
when deciding which continuation to offer.
