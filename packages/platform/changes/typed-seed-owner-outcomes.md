---
type: fix
---

The demo installer reports the affected stock SKU or count of blocking orders.

Migration: Apply both SQL forwards. Use `instanceof` with
`FulfillmentStockReplayConflictError` (`@openlup/platform/fulfillment`) and
`CheckoutRecoveryScheduleChangeBlockedError` (`@openlup/platform/commerce/server`).
Read `blockingOrders` as a decimal string. The non-enumerable `cause` holds the
driver error. Roll back explicit transactions after refusal. Update raw SQL
snapshots for the private `DETAIL`. Predecessor refusals stay raw. Checkout
treats raw stock `23505` as an operational failure. For the starter reports,
restore the original inputs for the reported SKU or wait for the blocking
orders to clear, then rerun `./lifecycle up`.
