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
The starter's recovery actions select the sandbox rail; unconfigured real-provider
actions refuse with `native_prepared_attempt_store_unsupported`. The native
provider attempt ports require explicit host composition; see [payments](payments.md#dispatch-and-settlement).

Use [Recover abandoned checkouts and payments](../how-to/build/checkout-recovery.md)
for token authority, reminder scheduling, retry and recreation composition.
Consult [refusal codes](../reference/refusal-codes.md) and
[recovery limits](../reference/limits.md#expired-checkout-recovery-and-order-holds)
when deciding which continuation to offer.

## Native stock priority

Native available-to-promise (ATP) subtracts eligible held and committed reservations,
uncredited active subscription demand through the installed renewal horizon, and
channel exposure. The cutoff is inclusive. Only the fenced renewal allocator can
skip soft demand; a new purchase cannot select that exemption. This policy does
not change subscription dates, delivery alignment or frozen renewal terms.

In the next minor candidate, `@openlup/platform/inventory` exports
`RenewalStockProtectionPolicy`, `installRenewalStockProtectionPolicy(db, policy)`
and `readRenewalStockProtectionPolicy(db)`; its contracts subpath also exports the
type. Apply the ordered native migration
`20261123130000_inventory_renewal_protection_policy.sql` before using the helpers.
An explicit installation writes the `inventory_renewal_protection` commerce setting:
exactly `{ revision: 'store-1', renewalProtectionDays: 14 }`, with a nonblank revision
and an integer from 1 through 3660. Absence returns
`{ revision: 'default', renewalProtectionDays: 14 }` and keeps historical ATP results.
Malformed stored data refuses with `inventory_renewal_protection_policy_invalid`.
Use a host-owned installation connection to write; runtime reads require SELECT
on `commerce_settings` and EXECUTE on `inventory_renewal_protection_days()`.
Qualified installations supply these through their existing service-role binding.

`createPostgresStockAvailability().readPort.read` admits only `horizonDays` equal
to the installed value and no excluded order; otherwise it retains
`native_stock_read_options_unsupported`. Set the `horizonDays` option on
`createNewPurchaseStockAvailabilityPort` to that same value when composing it.
A request cannot override installed priority. The managed stock adapter retains
its existing 14-day contract; this native migration does not change managed SQL.
