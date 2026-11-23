---
type: fix
---

Stock replay conflicts and blocked reminder schedule changes now reject with owner classes.

Migration: apply both SQL forwards. Branch with `instanceof FulfillmentStockReplayConflictError` or `CheckoutRecoveryScheduleChangeBlockedError` (`blockingOrders`); the driver error is `cause`. Checkout treats raw stock `23505` as operational.
