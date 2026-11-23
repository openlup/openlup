---
type: fix
---

Migration: Apply `20261125130000_fulfillment_stock_seed_outcome.sql` then `20261125140000_checkout_recovery_reminder_install_outcome.sql`. Match `FulfillmentStockReplayConflictError` or `CheckoutRecoveryScheduleChangeBlockedError` (`blockingOrders`) via `instanceof`. Read driver `cause`. Raw stock `23505` is operational in checkout.
